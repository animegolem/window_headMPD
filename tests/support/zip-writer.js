// @ts-check
// Synthetic zip writer with malicious variants (ENGINE D9, D4). `buildZip(entries, options)` writes
// exactly what the specs say, including lies: wrong declared sizes, a bad first local signature,
// local names that differ from the central directory, ZIP64 and multi-disk markers, ZipCrypto
// encryption, symlink attributes, CP437 and UTF-8 names. Nothing here extracts anything.
//
// The catalogue (`zipCases`) is the card's list. Each case carries
//   `expect`: what a reader that follows D4 must do (entries exposed, `read()` result, names it must
//             skip, or which fatal error it throws), derived from the D4 text; and
//   `unzip`:  what Info-ZIP `unzip` does with it on macOS (measured), which the tests check so the
//             fixture is known to be the shape it claims to be.
//
// Browser-safe: no `node:` imports.

import { deflateSync } from 'fflate';
import { ByteWriter, catalog, concat, crc32, crcStep, noiseBytes } from './bytes.js';

/**
 * @typedef {Object} ZipEntrySpec
 * @property {string|Uint8Array} name  a string is encoded per `nameEncoding`; bytes go in verbatim
 * @property {'ascii'|'utf8'|'cp437'} [nameEncoding]  default: 'utf8' (flag bit 11 set) if the name has non-ASCII characters, else 'ascii'
 * @property {Uint8Array|string} [data]
 * @property {'store'|'deflate'|number} [method]  default 'deflate'; a number is a raw method id and `data` is written as the compressed bytes
 * @property {boolean} [dir]
 * @property {string} [symlink]       target; written as a stored entry with S_IFLNK attributes
 * @property {number} [mode]          Unix permission bits
 * @property {string} [password]      ZipCrypto (traditional) encryption
 * @property {number} [declaredSize]            uncompressed size written to both headers instead of the real one
 * @property {number} [declaredCompressedSize]  compressed size likewise
 * @property {Uint8Array} [localName]           name bytes for the local header when they should differ from the central directory
 * @property {Uint8Array} [localSignature]      replaces the local header's first four bytes
 * @property {Uint8Array} [extra]               central-directory extra field
 * @property {Uint8Array} [localExtra]          local-header extra field
 * @property {boolean} [zip64]                  sentinel sizes and offset plus a 0x0001 extra field
 * @property {{ deflated: Uint8Array, size: number, crc: number }} [precompressed]  raw deflate bytes written as-is (method 8) with the true
 *   inflated size and CRC-32 of the inflated bytes; for streams `deflateSync` cannot make, such as `deflateZeros`
 */
/**
 * @typedef {Object} ZipOptions
 * @property {boolean} [zip64]         ZIP64 end records, EOCD fields at their sentinels
 * @property {number} [disk]           EOCD "this disk" number (non-zero: multi-disk)
 * @property {Uint8Array} [comment]    archive comment
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const DOS_DATE_1980_01_01 = 0x0021;

// IBM code page 437, 0x80..0xFF (0xFF is a no-break space).
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';
if ([...CP437_HIGH].length !== 128) throw new Error('CP437 table is not 128 characters');

/** @param {string} s @returns {Uint8Array} */
export function cp437Encode(s) {
  const high = [...CP437_HIGH];
  return Uint8Array.from([...s], (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) return c;
    const i = high.indexOf(ch);
    if (i < 0) throw new Error(`U+${c.toString(16)} is not in CP437`);
    return 0x80 + i;
  });
}

/** @param {Uint8Array} bytes @returns {string} */
export function cp437Decode(bytes) {
  const high = [...CP437_HIGH];
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : high[b - 0x80])).join('');
}

/**
 * Traditional PKWARE encryption of `plain`, with the 12-byte header whose last byte is the CRC's high byte.
 * @param {Uint8Array} plain @param {string} password @param {number} crc
 */
function zipCrypt(plain, password, crc) {
  const keys = [0x12345678, 0x23456789, 0x34567890];
  const update = (/** @type {number} */ c) => {
    keys[0] = crcStep(keys[0], c);
    keys[1] = (keys[1] + (keys[0] & 0xff)) >>> 0;
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0;
    keys[2] = crcStep(keys[2], keys[1] >>> 24);
  };
  const stream = () => { const t = (keys[2] | 2) & 0xffff; return ((t * (t ^ 1)) >>> 8) & 0xff; };
  for (const ch of password) update(ch.charCodeAt(0));
  const header = noiseBytes(12, 99);
  header[11] = crc >>> 24;
  const out = new Uint8Array(12 + plain.length);
  const src = concat(header, plain);
  for (let i = 0; i < src.length; i++) {
    const c = src[i] ^ stream();
    update(src[i]);
    out[i] = c;
  }
  return out;
}

const textBytes = (/** @type {Uint8Array|string|undefined} */ d) => (d === undefined ? new Uint8Array(0) : typeof d === 'string' ? new TextEncoder().encode(d) : d);

/**
 * @param {ZipEntrySpec[]} entries
 * @param {ZipOptions} [options]
 * @returns {Uint8Array}
 */
export function buildZip(entries, options = {}) {
  const out = new ByteWriter(4096);
  /** @type {Array<{name:Uint8Array, flags:number, method:number, crc:number, csize:number, usize:number, offset:number, madeBy:number, ext:number, extra:Uint8Array, zip64:boolean, real:{c:number,u:number}}>} */
  const central = [];

  for (const e of entries) {
    const utf8 = e.nameEncoding ? e.nameEncoding === 'utf8' : typeof e.name === 'string' && /[^\x00-\x7f]/.test(e.name);
    const nameBytes =
      typeof e.name !== 'string' ? e.name
      : e.nameEncoding === 'cp437' ? cp437Encode(e.name)
      : new TextEncoder().encode(e.name);
    const isLink = e.symlink !== undefined;
    const pre = e.dir || isLink ? undefined : e.precompressed;
    const raw = e.dir || pre ? new Uint8Array(0) : textBytes(isLink ? e.symlink : e.data);
    const crc = pre ? pre.crc : crc32(raw);
    const method = e.dir || isLink ? 0 : pre ? 8 : typeof e.method === 'number' ? e.method : e.method === 'store' ? 0 : 8;
    let body = pre ? pre.deflated : typeof e.method === 'number' ? textBytes(e.data) : method === 0 ? raw : deflateSync(raw, { level: 6 });
    let flags = utf8 ? 0x0800 : 0;
    if (e.password !== undefined) {
      body = zipCrypt(body, e.password, crc);
      flags |= 1;
    }
    const realC = body.length;
    const realU = pre ? pre.size : typeof e.method === 'number' ? textBytes(e.data).length : raw.length;
    const c = e.declaredCompressedSize ?? realC;
    const u = e.declaredSize ?? realU;
    const offset = out.length;
    const lname = e.localName ?? nameBytes;
    const z64 = e.zip64 === true;
    const lextra = z64 ? concat(Uint8Array.of(1, 0, 16, 0), new ByteWriter(16).u64(u).u64(c).toBytes(), e.localExtra ?? new Uint8Array(0)) : (e.localExtra ?? new Uint8Array(0));

    if (e.localSignature) out.bytes(e.localSignature); else out.u32(SIG_LOCAL);
    out.u16(z64 ? 45 : 20).u16(flags).u16(method).u16(0).u16(DOS_DATE_1980_01_01);
    out.u32(crc).u32(z64 ? 0xffffffff : c).u32(z64 ? 0xffffffff : u);
    out.u16(lname.length).u16(lextra.length).bytes(lname).bytes(lextra).bytes(body);

    const mode = e.mode ?? (e.dir ? 0o755 : 0o644);
    const type = e.dir ? 0o040000 : isLink ? 0o120000 : 0o100000;
    const unixAttr = (((type | (isLink ? 0o777 : mode)) << 16) | (e.dir ? 0x10 : 0)) >>> 0;
    central.push({
      name: nameBytes, flags, method, crc, csize: z64 ? 0xffffffff : c, usize: z64 ? 0xffffffff : u, offset,
      madeBy: (3 << 8) | (z64 ? 45 : 20), ext: unixAttr,
      extra: z64 ? concat(Uint8Array.of(1, 0, 24, 0), new ByteWriter(24).u64(u).u64(c).u64(offset).toBytes(), e.extra ?? new Uint8Array(0)) : (e.extra ?? new Uint8Array(0)),
      zip64: z64, real: { c, u },
    });
  }

  const cdOffset = out.length;
  for (const c of central) {
    out.u32(SIG_CENTRAL).u16(c.madeBy).u16(c.zip64 ? 45 : 20).u16(c.flags).u16(c.method).u16(0).u16(DOS_DATE_1980_01_01);
    out.u32(c.crc).u32(c.csize).u32(c.usize).u16(c.name.length).u16(c.extra.length).u16(0).u16(0).u16(0).u32(c.ext);
    out.u32(c.zip64 ? 0xffffffff : c.offset).bytes(c.name).bytes(c.extra);
  }
  const cdSize = out.length - cdOffset;
  const n = central.length;
  const comment = options.comment ?? new Uint8Array(0);
  if (options.zip64) {
    const rec = out.length;
    out.u32(SIG_EOCD64).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdOffset);
    out.u32(SIG_LOC64).u32(0).u64(rec).u32(1);
  }
  out.u32(SIG_EOCD).u16(options.disk ?? 0).u16(options.disk ?? 0);
  out.u16(options.zip64 ? 0xffff : Math.min(n, 0xffff)).u16(options.zip64 ? 0xffff : Math.min(n, 0xffff));
  out.u32(options.zip64 ? 0xffffffff : cdSize).u32(options.zip64 ? 0xffffffff : cdOffset);
  out.u16(comment.length).bytes(comment);
  return out.toBytes();
}

/**
 * A raw deflate stream (one final dynamic-Huffman block) that inflates to `1 + 258 * matches` zero bytes: the
 * literal 0, then `matches` copies of (length 258, distance 1), then end-of-block. Each copy costs two bits, so the
 * ratio approaches the format's ceiling of 258 * 8 / 2 = 1032:1. zlib level 9 reaches only 1028 to 1030:1 on zeros
 * (from 4 MiB up), so the format's ratio, not an encoder's, is what this builds. Hand-emitted so it stays
 * browser-safe and needs no `node:zlib`.
 *
 * Lit/len code lengths: symbol 0 = 2, 256 = 2, 285 = 1 (a complete code). One distance code of length 1. The
 * code-length alphabet gives the four symbols used (lengths 1 and 2, repeats 17 and 18) two bits each.
 * @param {number} matches
 * @returns {{ deflated: Uint8Array, size: number, crc: number }}
 */
export function deflateZeros(matches) {
  /** @type {number[]} */
  const out = [];
  let acc = 0;
  let nbits = 0;
  const bit = (/** @type {number} */ b) => { acc |= b << nbits; if (++nbits === 8) { out.push(acc); acc = 0; nbits = 0; } };
  const bits = (/** @type {number} */ v, /** @type {number} */ n) => { for (let i = 0; i < n; i++) bit((v >> i) & 1); }; // LSB first
  const code = (/** @type {number} */ c, /** @type {number} */ n) => { for (let i = n - 1; i >= 0; i--) bit((c >> i) & 1); }; // Huffman codes go MSB first

  bits(1, 1); bits(2, 2); // BFINAL = 1, BTYPE = 10 (dynamic)
  bits(29, 5); bits(0, 5); // HLIT = 29: 286 lit/len codes; HDIST = 0: 1 distance code
  bits(15, 4); // HCLEN = 19: all code-length-alphabet lengths follow
  const LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const clLen = new Map([[1, 2], [2, 2], [17, 2], [18, 2]]);
  for (const sym of LENGTH_ORDER) bits(clLen.get(sym) ?? 0, 3);
  // canonical codes in symbol order within one length: 1 = 00, 2 = 01, 17 = 10, 18 = 11
  const cl = new Map([[1, 0], [2, 1], [17, 2], [18, 3]]);
  const clSym = (/** @type {number} */ sym) => code(/** @type {number} */ (cl.get(sym)), 2);
  clSym(2); // symbol 0 has length 2
  clSym(18); bits(138 - 11, 7); clSym(18); bits(117 - 11, 7); // symbols 1..255: 255 zeros
  clSym(2); // symbol 256
  clSym(18); bits(28 - 11, 7); // symbols 257..284: 28 zeros
  clSym(1); // symbol 285 has length 1
  clSym(1); // the one distance code has length 1
  // lit/len canonical codes: 285 (length 1) = 0, then 0 (length 2) = 10, 256 (length 2) = 11
  code(2, 2); // literal 0
  for (let i = 0; i < matches; i++) { code(0, 1); code(0, 1); } // length 258 (symbol 285), distance 1 (code 0)
  code(3, 2); // end of block
  if (nbits) out.push(acc);

  const size = 1 + 258 * matches;
  // CRC-32 of `size` zero bytes, in 64 KiB steps
  const chunk = new Uint8Array(65536);
  let crc = 0;
  for (let left = size; left > 0; left -= chunk.length) crc = crc32(left >= chunk.length ? chunk : chunk.subarray(0, left), crc);
  return { deflated: Uint8Array.from(out), size, crc };
}

// ---- the catalogue ----------------------------------------------------------------------------

/**
 * @typedef {Object} ZipExpect
 * @property {'zip64'|'multidisk'|'not-a-zip'|'archive-cap'} [throws]  readZip must throw ArchiveError
 * @property {Array<{name:string, data:Uint8Array|null}>} entries  entries a D4 reader exposes, in central-directory order,
 *   names with `\` read as `/`; `data` is what `read()` returns (null: corrupt or over a cap)
 * @property {string[]} skipped      raw names the reader must skip with a diagnostic
 * @property {Map<string, Uint8Array>} [vfs]  VFS key (NFC-folded basename) to the bytes that must win
 */
/**
 * What Info-ZIP `unzip` (macOS, UnZip 6.00) does. `list` is `unzip -l`; `test` is `unzip -t`
 * (with `-P password` where `password` is set), which reads the data but extracts nothing.
 * `extract` is the warning `unzip -o -d <scratch>` prints for the one kind of malicious name only
 * extraction notices; the tests run it into a nested scratch directory and check nothing escapes.
 * @typedef {{ exit: number, match?: RegExp }} UnzipOutcome
 * @typedef {{ list: UnzipOutcome, test?: UnzipOutcome, password?: string, extract?: RegExp }} UnzipExpect
 */

const T = (/** @type {string} */ s) => new TextEncoder().encode(s);
const OK = T('ok.txt contents\n');
const okEntry = { name: 'ok.txt', data: OK };

/**
 * @param {ZipEntrySpec[]|(() => ZipEntrySpec[])} entries
 * @param {ZipExpect|(() => ZipExpect)} expect
 * @param {UnzipExpect} unzip
 * @param {ZipOptions} [options]
 * @param {{ malicious?: boolean }} [meta]
 */
const make = (entries, expect, unzip, options, meta = {}) => () => {
  const specs = typeof entries === 'function' ? entries() : entries;
  return { bytes: buildZip(specs, options), specs, expect: typeof expect === 'function' ? expect() : expect, unzip, malicious: meta.malicious ?? false, password: unzip.password };
};

const normal = (/** @type {number} */ i) => ({ name: `f${String(i).padStart(4, '0')}.txt`, data: `file ${i}\n`, method: /** @type {'store'} */ ('store') });

const SECRET = 'secret';

/** 2 MiB with a 4 KiB period: matches are long, but nowhere near the 1032:1 deflate ceiling. */
const ratioControlData = () => Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => ((i >> 4) & 0xff) ^ (i & 3));

/** 16,256 copies of the 258-byte match after one literal: 4,194,049 bytes, 255 bytes under 4 MiB. */
const RATIO_OVER_CAP_MATCHES = 16256;
/** @type {ReturnType<typeof deflateZeros>|undefined} */
let ratioOverCapCache;
const ratioOverCap = () => (ratioOverCapCache ??= deflateZeros(RATIO_OVER_CAP_MATCHES));

/** @type {Array<{id:string, doc:string, build:() => any}>} */
const defs = [
  {
    id: 'stored-and-deflate',
    doc: 'a stored entry, a deflated entry, a directory entry and a nested file',
    build: make(() => [
      { name: 'a.txt', data: 'stored entry\n', method: 'store' },
      { name: 'b.bmp', data: T('deflated entry, deflated entry, deflated entry, deflated entry\n'), method: 'deflate' },
      { name: 'sub/', dir: true },
      { name: 'sub/c.txt', data: 'nested\n' },
    ], {
      entries: [
        { name: 'a.txt', data: T('stored entry\n') },
        { name: 'b.bmp', data: T('deflated entry, deflated entry, deflated entry, deflated entry\n') },
        { name: 'sub/c.txt', data: T('nested\n') },
      ],
      skipped: [],
    }, { list: { exit: 0, match: /a\.txt[\s\S]*b\.bmp[\s\S]*sub\/c\.txt/ }, test: { exit: 0 } }),
  },
  {
    id: 'traversal-names',
    doc: 'names with `..` segments: `../x`, `a/../../y`, `..\\z`; plus a normal entry',
    build: make([
      { name: '../x', data: 'evil\n' }, { name: 'a/../../y', data: 'evil\n' }, { name: '..\\z', data: 'evil\n' }, { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['../x', 'a/../../y', '..\\z'] }, { list: { exit: 0, match: /\.\.\/x/ }, test: { exit: 0 }, extract: /skipped "\.\.\/" path component\(s\)/ }, undefined, { malicious: true }),
  },
  {
    id: 'absolute-names',
    doc: 'names with a leading `/` (and `\\`); plus a normal entry',
    build: make([
      { name: '/etc/evil', data: 'evil\n' }, { name: '\\windows\\evil', data: 'evil\n' }, { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['/etc/evil', '\\windows\\evil'] }, { list: { exit: 0, match: /\/etc\/evil/ }, test: { exit: 0 }, extract: /stripped absolute path spec/ }, undefined, { malicious: true }),
  },
  {
    id: 'drive-letter-names',
    doc: 'names starting `C:/`, `C:\\` and `c:x`; plus a normal entry',
    build: make([
      { name: 'C:/evil', data: 'evil\n' }, { name: 'C:\\evil2', data: 'evil\n' }, { name: 'c:evil3', data: 'evil\n' }, { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['C:/evil', 'C:\\evil2', 'c:evil3'] }, { list: { exit: 0, match: /C:\/evil/ }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'nul-in-name',
    doc: 'an entry whose name bytes contain a NUL (`a\\0.png`); plus a normal entry',
    build: make([
      { name: Uint8Array.of(0x61, 0x00, 0x2e, 0x70, 0x6e, 0x67), data: 'evil\n' }, { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['a\u0000.png'] }, { list: { exit: 0 }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'symlink-entries',
    doc: 'a symlink entry (S_IFLNK in the Unix attributes, target in the data); plus a normal entry',
    build: make([
      { name: 'link', symlink: '/etc/passwd' }, { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['link'] }, { list: { exit: 0, match: /link/ }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'declared-4gb-bomb',
    doc: 'a 10 KB entry whose headers declare 4,000,000,000 bytes: read() is null from the headers, without allocating',
    build: make(() => [
      { name: 'bomb.bin', data: noiseBytes(10240, 3), method: 'deflate', declaredSize: 4_000_000_000 }, { name: 'ok.txt', data: OK },
    ], { entries: [{ name: 'bomb.bin', data: null }, okEntry], skipped: [] }, { list: { exit: 0, match: /4000000000/ }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'ratio-over-cap',
    doc: 'a genuine entry: 4,194,049 zero bytes (just under 4 MiB; both headers declare the true size and the CRC-32 of the real bytes) in about 4 KB of hand-built dynamic-Huffman deflate, about 1028:1, over the D4 cap of 1,024:1 for entries over 1 MiB. read() is null from the headers, before inflating. Not a header lie: a reader without the ratio cap inflates all 4 MiB and returns the zeros. The ratio is real: zlib level 9 reaches 1028 to 1030:1 on zeros from 4 MiB up, and the format limit is about 1032:1',
    build: make(() => [
      { name: 'ratio.bin', precompressed: ratioOverCap(), method: 'deflate' }, { name: 'ok.txt', data: OK },
    ], { entries: [{ name: 'ratio.bin', data: null }, okEntry], skipped: [] }, { list: { exit: 0, match: /4194049/ }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'ratio-under-cap',
    doc: 'a real 2 MiB entry that deflates to well under 1024:1 (the control for the ratio cap)',
    build: make(() => [{ name: 'big.bin', data: ratioControlData(), method: 'deflate' }, { name: 'ok.txt', data: OK }],
      () => ({ entries: [{ name: 'big.bin', data: ratioControlData() }, okEntry], skipped: [] }), { list: { exit: 0, match: /2097152/ }, test: { exit: 0 } }),
  },
  {
    id: 'zip64',
    doc: 'a valid ZIP64 archive (end records, sentinel sizes, 0x0001 extra field): D4 rejects ZIP64',
    build: make([{ name: 'z.txt', data: 'zip64\n', zip64: true }], { throws: 'zip64', entries: [], skipped: [] }, { list: { exit: 0, match: /z\.txt/ }, test: { exit: 0 } }, { zip64: true }),
  },
  {
    id: 'multi-disk',
    doc: 'an EOCD claiming disk 1 of a split archive: rejected',
    build: make([{ name: 'ok.txt', data: OK }], { throws: 'multidisk', entries: [], skipped: [] }, { list: { exit: 1, match: /multi-part archive/ } }, { disk: 1 }),
  },
  {
    id: 'encrypted',
    doc: 'a ZipCrypto entry (password `secret`) beside a plain one: the encrypted entry is skipped',
    build: make([{ name: 'enc.txt', data: 'top secret\n', password: SECRET }, { name: 'ok.txt', data: OK }],
      { entries: [okEntry], skipped: ['enc.txt'] }, { list: { exit: 0, match: /enc\.txt/ }, test: { exit: 0 }, password: SECRET }),
  },
  {
    id: 'unsupported-method',
    doc: 'an entry with compression method 14 (LZMA) and junk data: skipped with a diagnostic',
    build: make([{ name: 'lzma.bin', data: noiseBytes(64, 4), method: 14 }, { name: 'ok.txt', data: OK }],
      { entries: [okEntry], skipped: ['lzma.bin'] }, { list: { exit: 0, match: /lzma\.bin/ }, test: { exit: 81, match: /method not supported/ } }, undefined, { malicious: true }),
  },
  {
    id: 'corrupt-first-local-signature',
    doc: 'the first local header starts `01 00 01 00` (3 corpus archives); its name matches the central directory, so the entry is salvaged',
    build: make([
      { name: 'first.txt', data: 'salvaged\n', localSignature: Uint8Array.of(1, 0, 1, 0), localExtra: Uint8Array.of(0xaa, 0xbb, 0x03, 0x00, 1, 2, 3) },
      { name: 'ok.txt', data: OK },
    ], { entries: [{ name: 'first.txt', data: T('salvaged\n') }, okEntry], skipped: [] }, { list: { exit: 0, match: /first\.txt/ }, test: { exit: 2, match: /bad zipfile offset \(local header sig\)/ } }),
  },
  {
    id: 'corrupt-first-local-signature-name-mismatch',
    doc: 'the first local header has a bad signature and a different name than the central directory: not salvaged, skipped',
    build: make([
      { name: 'first.txt', data: 'not salvaged\n', localSignature: Uint8Array.of(1, 0, 1, 0), localName: T('other.txt') },
      { name: 'ok.txt', data: OK },
    ], { entries: [okEntry], skipped: ['first.txt'] }, { list: { exit: 0, match: /first\.txt/ }, test: { exit: 2, match: /bad zipfile offset \(local header sig\)/ } }, undefined, { malicious: true }),
  },
  {
    id: 'local-extra-differs',
    doc: 'a normal archive whose local extra field differs from the central one: data starts at offset + 30 + nameLen + local extraLen',
    build: make([
      { name: 'a.txt', data: 'x'.repeat(50) + '\n', method: 'store', localExtra: Uint8Array.of(0xcd, 0xab, 0x04, 0x00, 9, 9, 9, 9), extra: Uint8Array.of(0xcd, 0xab, 0x00, 0x00) },
      { name: 'ok.txt', data: OK },
    ], { entries: [{ name: 'a.txt', data: T('x'.repeat(50) + '\n') }, okEntry], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'macos-junk',
    doc: '__MACOSX/, RESOURCE.FRK/, AppleDouble `._*` and .DS_Store entries beside real art-named files',
    build: make([
      { name: '__MACOSX/', dir: true }, { name: '__MACOSX/._hover.bmp', data: 'fork\n' },
      { name: 'RESOURCE.FRK/', dir: true }, { name: 'RESOURCE.FRK/HOVER.BMP', data: 'fork\n' },
      { name: '._x', data: 'ad\n' }, { name: 'sub/._y.bmp', data: 'ad\n' },
      { name: '.DS_Store', data: 'ds\n' }, { name: 'sub/.DS_Store', data: 'ds\n' },
      { name: 'hover.bmp', data: 'real\n' }, { name: 'ok.txt', data: OK },
    ], { entries: [{ name: 'hover.bmp', data: T('real\n') }, okEntry], skipped: ['__MACOSX/._hover.bmp', 'RESOURCE.FRK/HOVER.BMP', '._x', 'sub/._y.bmp', '.DS_Store', 'sub/.DS_Store'] }, { list: { exit: 0, match: /__MACOSX/ }, test: { exit: 0 } }),
  },
  {
    id: 'case-collisions',
    doc: '`Foo.bmp`, `FOO.BMP` and `foo.bmp` with different data: the last in the central directory wins in the VFS',
    build: make([
      { name: 'Foo.bmp', data: 'first\n' }, { name: 'ok.txt', data: OK }, { name: 'FOO.BMP', data: 'second\n' }, { name: 'foo.bmp', data: 'third\n' },
    ], {
      entries: [{ name: 'Foo.bmp', data: T('first\n') }, okEntry, { name: 'FOO.BMP', data: T('second\n') }, { name: 'foo.bmp', data: T('third\n') }],
      skipped: [], vfs: new Map([['foo.bmp', T('third\n')], ['ok.txt', OK]]),
    }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'backslash-names',
    doc: '`pl\\a.png` and `Sub\\Deep\\b.bmp`: `\\` is a separator, so the VFS keys are `a.png` and `b.bmp` (survey 1.2)',
    build: make([{ name: 'pl\\a.png', data: 'png\n' }, { name: 'Sub\\Deep\\b.bmp', data: 'bmp\n' }, { name: 'ok.txt', data: OK }],
      { entries: [{ name: 'pl/a.png', data: T('png\n') }, { name: 'Sub/Deep/b.bmp', data: T('bmp\n') }, okEntry], skipped: [], vfs: new Map([['a.png', T('png\n')], ['b.bmp', T('bmp\n')]]) },
      { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'proto-names',
    doc: 'entries literally named `__proto__` and `constructor` (a lookup keyed by entry names must be a Map)',
    build: make([{ name: '__proto__', data: 'p\n' }, { name: 'constructor', data: 'c\n' }, { name: 'ok.txt', data: OK }],
      { entries: [{ name: '__proto__', data: T('p\n') }, { name: 'constructor', data: T('c\n') }, okEntry], skipped: [], vfs: new Map([['__proto__', T('p\n')], ['constructor', T('c\n')]]) },
      { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'cp437-names',
    doc: 'names with bytes >= 0x80 and no UTF-8 flag: decoded as CP437 (`café.bmp` is 63 61 66 82 …)',
    build: make([
      { name: 'caf\u00e9.bmp', nameEncoding: 'cp437', data: 'one\n' }, { name: '\u00c7a.bmp', nameEncoding: 'cp437', data: 'two\n' }, { name: '\u2591bar.bmp', nameEncoding: 'cp437', data: 'three\n' },
    ], { entries: [{ name: 'caf\u00e9.bmp', data: T('one\n') }, { name: '\u00c7a.bmp', data: T('two\n') }, { name: '\u2591bar.bmp', data: T('three\n') }], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'utf8-flagged-names',
    doc: 'UTF-8 names with flag bit 11 set (`café.bmp`, `日本.bmp`)',
    build: make([
      { name: 'caf\u00e9.bmp', nameEncoding: 'utf8', data: 'one\n' }, { name: '\u65e5\u672c.bmp', nameEncoding: 'utf8', data: 'two\n' },
    ], { entries: [{ name: 'caf\u00e9.bmp', data: T('one\n') }, { name: '\u65e5\u672c.bmp', data: T('two\n') }], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'utf8-bytes-without-flag',
    doc: 'UTF-8 bytes for `café.bmp` but no flag: D4 reads them as CP437 (mojibake), because the corpus has no BOM-less UTF-8',
    build: make([{ name: new TextEncoder().encode('caf\u00e9.bmp'), data: 'one\n' }, { name: 'ok.txt', data: OK }],
      { entries: [{ name: cp437Decode(new TextEncoder().encode('caf\u00e9.bmp')), data: T('one\n') }, okEntry], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'name-255-bytes',
    doc: 'an entry name of exactly 255 bytes (kept) beside a normal one',
    build: make(() => [{ name: `${'a'.repeat(251)}.bmp`, data: 'long\n' }, { name: 'ok.txt', data: OK }],
      { entries: [{ name: `${'a'.repeat(251)}.bmp`, data: T('long\n') }, okEntry], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }),
  },
  {
    id: 'name-256-bytes',
    doc: 'an entry name of 256 bytes (over the cap): skipped',
    build: make(() => [{ name: `${'a'.repeat(252)}.bmp`, data: 'long\n' }, { name: 'ok.txt', data: OK }],
      { entries: [okEntry], skipped: [`${'a'.repeat(252)}.bmp`] }, { list: { exit: 0 }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'entries-4096',
    doc: '4,096 stored entries: exactly the entry cap',
    build: make(() => Array.from({ length: 4096 }, (_, i) => normal(i)),
      () => ({ entries: Array.from({ length: 4096 }, (_, i) => ({ name: normal(i).name, data: T(`file ${i}\n`) })), skipped: [] }), { list: { exit: 0, match: /4096 files/ }, test: { exit: 0 } }),
  },
  {
    id: 'entries-4097',
    doc: '4,097 stored entries: one over the entry cap (an archive cap: readZip throws)',
    build: make(() => Array.from({ length: 4097 }, (_, i) => normal(i)), { throws: 'archive-cap', entries: [], skipped: [] }, { list: { exit: 0, match: /4097 files/ }, test: { exit: 0 } }, undefined, { malicious: true }),
  },
  {
    id: 'max-comment',
    doc: 'an archive comment of 65,535 bytes: the EOCD sits exactly 65,557 bytes from the end and must still be found',
    build: make([{ name: 'ok.txt', data: OK }], { entries: [okEntry], skipped: [] }, { list: { exit: 0 }, test: { exit: 0 } }, { comment: new Uint8Array(65535).fill(0x20) }),
  },
  {
    id: 'empty-archive',
    doc: 'a zip with no entries (only an EOCD)',
    build: make([], { entries: [], skipped: [] }, { list: { exit: 1, match: /zipfile is empty/ }, test: { exit: 1, match: /zipfile is empty/ } }),
  },
  {
    id: 'not-a-zip',
    doc: 'bytes with no end-of-central-directory record',
    build: () => ({ bytes: T('this is not a zip file at all'.repeat(10)), specs: [], expect: { throws: 'not-a-zip', entries: [], skipped: [] }, unzip: { list: { exit: 9, match: /End-of-central-directory signature not found/ }, test: { exit: 9 } }, malicious: true, password: undefined }),
  },
];
export { SECRET as ZIP_PASSWORD };

const cat = catalog(defs);
export const zipCaseIds = () => cat.ids();
/** @param {string} id @returns {{id:string, doc:string, bytes:Uint8Array, specs:ZipEntrySpec[], expect:ZipExpect, unzip:UnzipExpect, malicious:boolean, password?:string}} */
export const zipCase = (id) => cat.get(id);
/** @param {(id: string) => boolean} [filter] */
export const zipCases = (filter) => cat.all(filter);
