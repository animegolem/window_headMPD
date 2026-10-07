// @ts-check
// Central-directory zip reader (ENGINE D4, §5.1). Skins are untrusted: nothing is extracted, no
// path is ever derived from an entry name, and every cap is checked before the allocation it
// guards. `readZip` throws only `ArchiveError` (not a zip, ZIP64, multi-disk, an archive-level cap);
// everything wrong with a single entry is a diagnostic plus a skip at index time, or a `null` from
// `read` at use time.

import { Inflate } from 'fflate';

/** @typedef {import('../contracts').ZipCaps} ZipCaps */
/** @typedef {import('../contracts').ZipEntry} ZipEntry */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */

/** @type {ZipCaps} */
export const DEFAULT_ZIP_CAPS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalInflated: 256 * 1024 * 1024,
  maxRatio: 1024,
  maxNameBytes: 255,
});

/** @typedef {import('../contracts').ArchiveError} ArchiveErrorContract */
/** @typedef {ArchiveErrorContract['code']} ArchiveErrorCode */

/** @implements {ArchiveErrorContract} */
export class ArchiveError extends Error {
  /** @param {ArchiveErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    /** @type {'ArchiveError'} */
    this.name = 'ArchiveError';
    /** @type {ArchiveErrorCode} */
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_LOCATOR64 = 0x07064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const SENTINEL32 = 0xffffffff;
const RATIO_APPLIES_OVER = 1024 * 1024; // D4: the ratio cap is for entries over 1 MiB
const INFLATE_CHUNK = 16 * 1024; // one push inflates at most ~1032x this, so an overflow is caught early
const NAME_CLIP = 256;

// IBM code page 437, 0x80..0xFF (0xFF is a no-break space). The corpus has no BOM-less UTF-8 names
// (survey 2.1), so a name without the UTF-8 flag is read as CP437, as Info-ZIP does.
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP437 = [...CP437_HIGH];
if (CP437.length !== 128) throw new Error('CP437 table is not 128 characters');

// keep the BOM: a name that starts with EF BB BF is a name, not a marked file
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** @param {Uint8Array} b @returns {number} unsigned CRC-32 */
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** @param {Uint8Array} b @param {boolean} isUtf8 */
const decodeName = (b, isUtf8) => {
  if (isUtf8) return utf8.decode(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i] < 0x80 ? String.fromCharCode(b[i]) : CP437[b[i] - 0x80];
  return s;
};

/**
 * The VFS key of a name or a reference (D4): `\` is a separator, only the basename counts, then
 * NFC and lower case. Entry names and skin references reduce the same way, so they meet.
 * @param {string} ref
 */
export const foldKey = (ref) => {
  const s = ref.replaceAll('\\', '/');
  return s.slice(s.lastIndexOf('/') + 1).normalize('NFC').toLowerCase();
};

/** @param {string} s */
const clip = (s) => (s.length > NAME_CLIP ? `${s.slice(0, NAME_CLIP)}…` : s);

/** @param {Partial<ZipCaps>|undefined} caps @returns {ZipCaps} */
const resolveCaps = (caps) => {
  const out = { ...DEFAULT_ZIP_CAPS };
  // an explicit `undefined` or NaN must not erase a cap
  if (caps) for (const k of /** @type {Array<keyof ZipCaps>} */ (Object.keys(DEFAULT_ZIP_CAPS))) if (Number.isFinite(caps[k])) out[k] = /** @type {number} */ (caps[k]);
  return out;
};

/**
 * Where the EOCD is: scanning back from the end, within the longest possible comment. The first
 * candidate whose comment runs exactly to the end of the file wins; failing that, the last one
 * whose comment at least fits.
 * @param {DataView} dv @returns {number} -1 when there is none
 */
const findEocd = (dv) => {
  const len = dv.byteLength;
  let fallback = -1;
  for (let i = len - EOCD_SIZE; i >= Math.max(0, len - EOCD_SIZE - MAX_COMMENT); i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    const end = i + EOCD_SIZE + dv.getUint16(i + 20, true);
    if (end === len) return i;
    if (end < len && fallback < 0) fallback = i;
  }
  return fallback;
};

/**
 * @typedef {Object} EntryRecord
 * @property {ZipEntry} entry
 * @property {number} dataStart  first byte of the entry's data, from the *local* header's lengths
 * @property {Set<string>} reported  diagnostic codes already raised by `read`
 */

/** @type {import('../contracts').ReadZipFn} */
export const readZip = (bytes, capsIn) => {
  const caps = resolveCaps(capsIn);
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('not-a-zip', 'input is not a byte array');
  const len = bytes.length;
  if (len > caps.maxArchiveBytes) throw new ArchiveError('archive-cap', `archive is ${len} bytes, cap ${caps.maxArchiveBytes}`);
  if (len < EOCD_SIZE) throw new ArchiveError('not-a-zip', 'too short to hold an end-of-central-directory record');

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @param {Diagnostic['severity']} severity @param {string} code @param {string} detail @param {string} [file] */
  const diag = (severity, code, detail, file) => { diagnostics.push(file === undefined ? { code, detail, severity } : { code, detail, severity, file }); };

  const dv = new DataView(bytes.buffer, bytes.byteOffset, len);
  /** @type {ZipEntry[]} */
  const entries = [];
  /** @type {WeakMap<ZipEntry, EntryRecord>} */
  const records = new WeakMap();

  try {
    const eocd = findEocd(dv);
    if (eocd < 0) throw new ArchiveError('not-a-zip', 'no end-of-central-directory record');
    const disk = dv.getUint16(eocd + 4, true);
    const cdDisk = dv.getUint16(eocd + 6, true);
    const onThisDisk = dv.getUint16(eocd + 8, true);
    const total = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if ((eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_LOCATOR64) || total === 0xffff || cdSize === SENTINEL32 || cdOffset === SENTINEL32) {
      throw new ArchiveError('zip64', 'ZIP64 archives are not supported');
    }
    if (disk !== 0 || cdDisk !== 0 || onThisDisk !== total) throw new ArchiveError('multidisk', 'multi-disk archives are not supported');
    if (total > caps.maxEntries) throw new ArchiveError('archive-cap', `archive has ${total} entries, cap ${caps.maxEntries}`);
    const cdEnd = cdOffset + cdSize;
    if (cdEnd > eocd) throw new ArchiveError('not-a-zip', 'central directory lies beyond the end-of-central-directory record');

    let p = cdOffset;
    for (let i = 0; i < total; i++) {
      if (p + CENTRAL_SIZE > cdEnd || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ArchiveError('not-a-zip', `bad central directory header ${i}`);
      const madeBy = dv.getUint16(p + 4, true);
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const external = dv.getUint32(p + 38, true);
      const offset = dv.getUint32(p + 42, true);
      const nameAt = p + CENTRAL_SIZE;
      p = nameAt + nameLen + extraLen + commentLen;
      if (p > cdEnd) throw new ArchiveError('not-a-zip', `central directory header ${i} runs past the directory`);
      // sizes and offset at their sentinel mean the real values sit in a ZIP64 extra field
      if (csize === SENTINEL32 || usize === SENTINEL32 || offset === SENTINEL32) throw new ArchiveError('zip64', 'ZIP64 entry');

      const nameBytes = bytes.subarray(nameAt, nameAt + nameLen);
      const last = nameLen ? nameBytes[nameLen - 1] : 0;
      if (last === 0x2f || last === 0x5c) continue; // a directory: nothing to read, nothing to report

      const rawClip = () => decodeName(nameBytes.subarray(0, NAME_CLIP), (flags & 0x800) !== 0) + (nameLen > NAME_CLIP ? '…' : '');
      if (nameLen > caps.maxNameBytes) { diag('warn', 'zip-name-too-long', `entry name is ${nameLen} bytes, cap ${caps.maxNameBytes}`, rawClip()); continue; }
      const raw = decodeName(nameBytes, (flags & 0x800) !== 0);
      if (raw.includes('\0')) { diag('warn', 'zip-name-unsafe', 'entry name contains NUL', raw); continue; }
      const name = raw.replaceAll('\\', '/');
      const segments = name.split('/');
      if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || segments.includes('..')) {
        diag('warn', 'zip-name-unsafe', 'absolute, drive-letter or parent-directory entry name', raw);
        continue;
      }
      // An empty or `.` basename (a nameless entry, `a/.`) would fold to a key that a reference such
      // as `dir/` or `.` then resolves to. Directory entries ('x/') were dropped above.
      const fold = foldKey(name);
      if (fold === '' || fold === '.') { diag('warn', 'zip-name-unsafe', 'entry name has an empty or `.` basename', raw); continue; }
      const base = segments[segments.length - 1];
      const lowerSegments = segments.map((s) => s.toLowerCase());
      if (lowerSegments.includes('__macosx') || lowerSegments.includes('resource.frk') || base.startsWith('._') || base.toLowerCase() === '.ds_store') {
        diag('info', 'zip-junk', 'macOS metadata entry', raw);
        continue;
      }
      // S_IFLNK in the Unix mode, which only Unix (3) and macOS (19) hosts put in the high word
      if ((madeBy >> 8 === 3 || madeBy >> 8 === 19) && ((external >>> 16) & 0xf000) === 0xa000) { diag('warn', 'zip-symlink', 'symbolic link entry', raw); continue; }
      if (flags & (1 | 0x40 | 0x2000)) { diag('warn', 'zip-encrypted', 'encrypted entry', raw); continue; }
      if (method !== 0 && method !== 8) { diag('warn', 'zip-method', `compression method ${method} is not supported`, raw); continue; }

      // The data starts after the *local* header, whose extra field may differ from the central one.
      if (offset + LOCAL_SIZE > len) { diag('warn', 'zip-local-header-bad', 'local header lies beyond the end of the archive', raw); continue; }
      const localNameLen = dv.getUint16(offset + 26, true);
      const localExtraLen = dv.getUint16(offset + 28, true);
      const dataStart = offset + LOCAL_SIZE + localNameLen + localExtraLen;
      if (dv.getUint32(offset, true) !== SIG_LOCAL) {
        // Three corpus archives have 01 00 01 00 here (survey 1.2). The rest of the header is
        // intact, so trust it only when its name is the central directory's name.
        const same = localNameLen === nameLen && offset + LOCAL_SIZE + localNameLen <= len
          && bytes.subarray(offset + LOCAL_SIZE, offset + LOCAL_SIZE + localNameLen).every((b, k) => b === nameBytes[k]);
        if (!same) { diag('warn', 'zip-local-header-bad', 'bad local header signature and the local name differs from the central directory', raw); continue; }
        diag('info', 'zip-local-header-salvaged', 'bad local header signature; read the data from the central directory\'s offset', raw);
      }

      const entry = Object.freeze({ name, key: foldKey(name), method: /** @type {0|8} */ (method), csize, usize, crc, offset });
      entries.push(entry);
      records.set(entry, { entry, dataStart, reported: new Set() });
    }
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    // a DataView read past the end: a truncated or garbage archive, not a bug to surface raw
    throw new ArchiveError('not-a-zip', `malformed archive: ${e instanceof Error ? e.message : String(e)}`);
  }

  /** @type {Set<EntryRecord>} */
  const charged = new Set();
  let inflatedTotal = 0;

  /** @param {EntryRecord} rec @param {Diagnostic['severity']} severity @param {string} code @param {string} detail */
  const note = (rec, severity, code, detail) => {
    if (rec.reported.has(code)) return;
    rec.reported.add(code);
    diag(severity, code, detail, clip(rec.entry.name));
  };

  /** @param {ZipEntry} e @returns {Uint8Array|null} */
  const readEntry = (e) => {
    const rec = records.get(e);
    if (!rec) return null;
    const { method, csize, usize } = rec.entry;
    // Every refusal below happens before an allocation, from the headers alone.
    if (usize > caps.maxEntryBytes) { note(rec, 'warn', 'zip-entry-too-large', `declares ${usize} bytes, cap ${caps.maxEntryBytes}`); return null; }
    if (usize > RATIO_APPLIES_OVER && (csize === 0 || usize / csize > caps.maxRatio)) {
      note(rec, 'warn', 'zip-ratio', `declares ${usize} bytes from ${csize}, over ${caps.maxRatio}:1`);
      return null;
    }
    if (method === 0 && csize !== usize) { note(rec, 'warn', 'zip-entry-corrupt', `stored entry has ${csize} bytes and declares ${usize}`); return null; }
    const end = rec.dataStart + csize;
    if (end > len) { note(rec, 'warn', 'zip-entry-truncated', 'data runs past the end of the archive'); return null; }
    if (!charged.has(rec)) {
      if (inflatedTotal + usize > caps.maxTotalInflated) { note(rec, 'warn', 'zip-total-cap', `would pass the ${caps.maxTotalInflated}-byte inflated total`); return null; }
      inflatedTotal += usize;
      charged.add(rec);
    }

    const data = bytes.subarray(rec.dataStart, end);
    /** @type {Uint8Array} */
    let out;
    if (method === 0) {
      out = new Uint8Array(usize); // a copy: a view would let a caller reach, or transfer, the whole archive
      out.set(data);
    } else if (csize === 0 && usize === 0) {
      out = new Uint8Array(0);
    } else {
      out = new Uint8Array(usize);
      let pos = 0;
      let over = false;
      const inflate = new Inflate((chunk) => {
        if (over) return;
        if (pos + chunk.length > usize) over = true;
        else { out.set(chunk, pos); pos += chunk.length; }
      });
      try {
        for (let i = 0; i < csize && !over; i += INFLATE_CHUNK) {
          const to = Math.min(i + INFLATE_CHUNK, csize);
          inflate.push(data.subarray(i, to), to === csize);
        }
      } catch (err) {
        note(rec, 'warn', 'zip-entry-corrupt', `deflate stream is invalid: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (over) { note(rec, 'warn', 'zip-entry-corrupt', `inflates to more than the declared ${usize} bytes`); return null; }
      if (pos !== usize) { note(rec, 'warn', 'zip-entry-corrupt', `inflates to ${pos} bytes, declared ${usize}`); return null; }
    }
    if (crc32(out) !== rec.entry.crc) note(rec, 'warn', 'zip-crc-mismatch', 'CRC-32 does not match the central directory');
    return out;
  };

  return {
    entries: Object.freeze(entries),
    diagnostics,
    read(e) {
      try {
        return readEntry(e);
      } catch (err) {
        // readEntry is written not to throw; this is the contract's backstop, not a code path
        const rec = records.get(e);
        if (rec) note(rec, 'error', 'zip-entry-corrupt', `unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  };
};
