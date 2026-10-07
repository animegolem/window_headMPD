// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync, crc32 as nodeCrc32 } from 'node:zlib';
import { inflateSync } from 'fflate';
import { crc32 } from './bytes.js';
import { ZIP_PASSWORD, buildZip, cp437Decode, cp437Encode, deflateZeros, zipCase, zipCaseIds, zipCases } from './zip-writer.js';
import { HAS_UNZIP, makeTempDir, unzip, unzipEntry, zipinfo } from './ref-decoders.js';

const OK_LENGTH = 'ok.txt contents\n'.length;
const le16 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => b[o] | (b[o + 1] << 8);
const le32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * Independent central-directory reader (nothing shared with the writer), tolerant of nothing.
 * @param {Uint8Array} b
 */
function readCentral(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (le32(b, i) === 0x06054b50) { eocd = i; break; }
  expect(eocd, 'EOCD found').toBeGreaterThanOrEqual(0);
  const total = le16(b, eocd + 10);
  const cdSize = le32(b, eocd + 12);
  const cdOffset = le32(b, eocd + 16);
  /** @type {Array<{name:Uint8Array, flags:number, method:number, crc:number, csize:number, usize:number, offset:number, madeBy:number, ext:number, extra:Uint8Array}>} */
  const entries = [];
  let p = cdOffset;
  if (cdSize !== 0xffffffff && total !== 0xffff) {
    for (let i = 0; i < total; i++) {
      expect(le32(b, p), `central header ${i}`).toBe(0x02014b50);
      const nameLen = le16(b, p + 28), extraLen = le16(b, p + 30), commentLen = le16(b, p + 32);
      entries.push({
        madeBy: le16(b, p + 4), flags: le16(b, p + 8), method: le16(b, p + 10), crc: le32(b, p + 16), csize: le32(b, p + 20), usize: le32(b, p + 24),
        ext: le32(b, p + 38), offset: le32(b, p + 42), name: b.subarray(p + 46, p + 46 + nameLen), extra: b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
  return { eocd, total, disk: le16(b, eocd + 4), cdOffset, cdSize, commentLen: le16(b, eocd + 20), entries };
}

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-zip-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const all = zipCases();
const byId = new Map(all.map((c) => [c.id, c]));
/** @param {string} id */
const get = (id) => /** @type {NonNullable<ReturnType<typeof byId.get>>} */ (byId.get(id));
const fileFor = (/** @type {string} */ id) => {
  const p = join(dir, `${id}.zip`);
  writeFileSync(p, get(id).bytes);
  return p;
};

describe('zip catalogue', () => {
  it('has unique ids and every variant the card lists', () => {
    const ids = zipCaseIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'stored-and-deflate', 'traversal-names', 'absolute-names', 'drive-letter-names', 'nul-in-name', 'symlink-entries', 'declared-4gb-bomb', 'ratio-over-cap',
      'zip64', 'encrypted', 'corrupt-first-local-signature', 'macos-junk', 'case-collisions', 'cp437-names', 'utf8-flagged-names',
    ]) expect(ids, id).toContain(id);
  });

  it('every case builds, and a lookup keyed by entry names is a Map (cases include `__proto__` and `constructor`)', () => {
    expect(all.length).toBe(zipCaseIds().length);
    const proto = get('proto-names');
    const names = readCentral(proto.bytes).entries.map((e) => new TextDecoder().decode(e.name));
    expect(names).toEqual(['__proto__', 'constructor', 'ok.txt']);
    expect(proto.expect.vfs instanceof Map).toBe(true);
    expect(proto.expect.vfs?.has('__proto__')).toBe(true);
    expect(new Map().has('__proto__')).toBe(false);
  });

  it('is deterministic', () => {
    for (const id of ['stored-and-deflate', 'encrypted', 'zip64', 'ratio-under-cap']) {
      expect(Buffer.compare(zipCase(id).bytes, zipCase(id).bytes)).toBe(0);
    }
  });

  it('crc32 agrees with Node', () => {
    for (const s of ['', 'a', '123456789', 'The quick brown fox']) {
      const b = new TextEncoder().encode(s);
      expect(crc32(b)).toBe(nodeCrc32(b));
    }
    const noise = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255);
    expect(crc32(noise)).toBe(nodeCrc32(noise));
    expect(crc32(noise.subarray(2500), crc32(noise.subarray(0, 2500)))).toBe(nodeCrc32(noise));
  });
});

describe('zip structure, read by an independent parser', () => {
  it('entries match what was asked for, and local headers sit at the offsets the central directory gives', () => {
    for (const c of all.filter((x) => !['zip64', 'not-a-zip', 'multi-disk', 'entries-4097'].includes(x.id))) {
      const z = readCentral(c.bytes);
      expect(z.total, c.id).toBe(c.specs.length);
      z.entries.forEach((e, i) => {
        const spec = c.specs[i];
        expect(le32(c.bytes, e.offset) === 0x04034b50 || spec.localSignature !== undefined, `${c.id} entry ${i} local signature`).toBe(true);
        if (typeof spec.name === 'string' && !spec.nameEncoding && !/[^\x00-\x7f]/.test(spec.name)) expect(new TextDecoder().decode(e.name)).toBe(spec.name);
        // the local header carries the same CRC unless the entry says otherwise
        expect(le32(c.bytes, e.offset + 14), `${c.id} entry ${i} crc`).toBe(e.crc);
      });
    }
  });

  it('stored entries carry a correct CRC-32 of the bytes that follow their local header', () => {
    const c = get('stored-and-deflate');
    const z = readCentral(c.bytes);
    for (const e of z.entries.filter((x) => x.method === 0 && x.usize > 0)) {
      const start = e.offset + 30 + le16(c.bytes, e.offset + 26) + le16(c.bytes, e.offset + 28);
      expect(nodeCrc32(c.bytes.subarray(start, start + e.usize))).toBe(e.crc);
    }
  });

  it('flag bit 11 marks UTF-8 names only; CP437 names are single bytes >= 0x80', () => {
    const utf = readCentral(get('utf8-flagged-names').bytes).entries;
    expect(utf.every((e) => e.flags & 0x800)).toBe(true);
    expect(Array.from(utf[0].name)).toEqual(Array.from(new TextEncoder().encode('café.bmp')));
    const cp = readCentral(get('cp437-names').bytes).entries;
    expect(cp.every((e) => !(e.flags & 0x800))).toBe(true);
    expect(Array.from(cp[0].name)).toEqual([0x63, 0x61, 0x66, 0x82, 0x2e, 0x62, 0x6d, 0x70]); // café.bmp
    expect(cp[1].name[0]).toBe(0x80);
    expect(cp[2].name[0]).toBe(0xb0);
    const noflag = readCentral(get('utf8-bytes-without-flag').bytes).entries[0];
    expect(noflag.flags & 0x800).toBe(0);
    expect(Array.from(noflag.name.subarray(3, 5))).toEqual([0xc3, 0xa9]);
  });

  it('CP437 encodes and decodes every high character', () => {
    const high = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);
    expect(Array.from(cp437Encode(cp437Decode(high)))).toEqual(Array.from(high));
    expect(cp437Decode(Uint8Array.of(0x82, 0x81, 0xb0))).toBe('éü░');
    expect(() => cp437Encode('日')).toThrow();
  });

  it('symlink entries carry S_IFLNK in the Unix attributes and the target as data', () => {
    const c = get('symlink-entries');
    const e = readCentral(c.bytes).entries[0];
    expect(e.madeBy >> 8).toBe(3); // made on Unix
    expect(((e.ext >>> 16) & 0xf000)).toBe(0xa000);
    const start = e.offset + 30 + le16(c.bytes, e.offset + 26) + le16(c.bytes, e.offset + 28);
    expect(new TextDecoder().decode(c.bytes.subarray(start, start + e.usize))).toBe('/etc/passwd');
  });

  it('the bomb declares 4,000,000,000 bytes in both headers over a 10 KB entry, and the ratio control is a real entry under 1024:1', () => {
    const bomb = get('declared-4gb-bomb');
    expect(bomb.bytes.length).toBeLessThan(16 * 1024);
    const e = readCentral(bomb.bytes).entries[0];
    expect(e.usize).toBe(4_000_000_000);
    expect(le32(bomb.bytes, e.offset + 22)).toBe(4_000_000_000);
    expect(e.csize).toBeGreaterThan(10_000);
    expect(e.csize).toBeLessThan(11_000);
    const ok = readCentral(get('ratio-under-cap').bytes).entries[0];
    expect(ok.usize).toBeGreaterThan(1024 * 1024);
    expect(ok.usize / ok.csize).toBeLessThan(1024);
    expect(ok.usize / ok.csize).toBeGreaterThan(10); // a real, strongly compressing entry
  });

  it('ratio-over-cap is a genuine entry: the headers tell the truth about 4 MiB of zeros that deflate past 1024:1', () => {
    const c = get('ratio-over-cap');
    const z = readCentral(c.bytes);
    const e = z.entries[0];
    expect(new TextDecoder().decode(e.name)).toBe('ratio.bin');
    expect(e.method).toBe(8);
    // both headers carry the same sizes and CRC
    expect(le32(c.bytes, e.offset + 14)).toBe(e.crc);
    expect(le32(c.bytes, e.offset + 18)).toBe(e.csize);
    expect(le32(c.bytes, e.offset + 22)).toBe(e.usize);
    const start = e.offset + 30 + le16(c.bytes, e.offset + 26) + le16(c.bytes, e.offset + 28);
    const inflated = inflateSync(c.bytes.subarray(start, start + e.csize));
    // declared size == real size, so a reader without the ratio cap really would allocate and fill it
    expect(inflated.length).toBe(e.usize);
    expect(inflated.every((b) => b === 0)).toBe(true);
    expect(crc32(inflated)).toBe(e.crc);
    expect(e.usize).toBeGreaterThan(1024 * 1024);
    expect(e.usize).toBeGreaterThanOrEqual(2 * 1024 * 1024); // W1.1 asserts arrayBuffers grows < 2 MiB; an uncapped reader must break that
    expect(e.usize / e.csize).toBeGreaterThan(1024);
    // the entry after it is a normal one
    expect(z.entries[1].usize).toBe(OK_LENGTH);
  });

  it('the ratio ceiling is the deflate format\'s, not an encoder\'s: the hand-built stream beats zlib level 9 and agrees with it', () => {
    const { deflated, size, crc } = deflateZeros(16256);
    expect(size).toBe(1 + 258 * 16256);
    expect(deflated.length).toBeLessThan(4200);
    const zeros = new Uint8Array(size);
    expect(crc).toBe(nodeCrc32(zeros));
    // fflate and zlib both decode the hand-built stream to the same zeros
    expect(Buffer.compare(inflateSync(deflated), zeros)).toBe(0);
    expect(Buffer.compare(inflateRawSync(deflated), zeros)).toBe(0);
    // zlib level 9 on zeros reaches 1028 to 1030:1 from 4 MiB up (1015 at 1 MiB, 1023.5 at 2 MiB); the format limit is about 1032:1
    const z9 = deflateRawSync(zeros, { level: 9 }).length;
    expect(size / z9).toBeGreaterThan(1024);
    expect(size / z9).toBeLessThan(1032);
    expect(size / deflated.length).toBeGreaterThan(1024);
    expect(size / deflated.length).toBeLessThan(1032);
    // a short run is the same code path and still inflates exactly
    expect(inflateSync(deflateZeros(0).deflated).length).toBe(1);
    expect(inflateSync(deflateZeros(3).deflated).every((b) => b === 0)).toBe(true);
    expect(inflateSync(deflateZeros(3).deflated).length).toBe(1 + 258 * 3);
  });

  it('corrupt-signature fixtures: the central directory is intact, the first local signature is 01 00 01 00, and names match or not', () => {
    for (const id of ['corrupt-first-local-signature', 'corrupt-first-local-signature-name-mismatch']) {
      const c = get(id);
      expect(Array.from(c.bytes.subarray(0, 4))).toEqual([1, 0, 1, 0]);
      const z = readCentral(c.bytes);
      expect(z.entries.length).toBe(2);
      expect(new TextDecoder().decode(z.entries[0].name)).toBe('first.txt');
      const localName = c.bytes.subarray(30, 30 + le16(c.bytes, 26));
      expect(new TextDecoder().decode(localName)).toBe(id.endsWith('mismatch') ? 'other.txt' : 'first.txt');
    }
    // the local extra field is longer than the central one, so data does not start at 30 + nameLen
    const c = get('corrupt-first-local-signature');
    expect(le16(c.bytes, 28)).toBeGreaterThan(0);
    expect(readCentral(c.bytes).entries[0].extra.length).toBe(0);
  });

  it('local-extra-differs: the local extra field is not the central one', () => {
    const c = get('local-extra-differs');
    const e = readCentral(c.bytes).entries[0];
    expect(le16(c.bytes, e.offset + 28)).toBe(8);
    expect(e.extra.length).toBe(4);
  });

  it('ZIP64: end records, sentinel EOCD fields and a 0x0001 extra field with the real values', () => {
    const c = get('zip64');
    const b = c.bytes;
    const eocd = b.length - 22;
    expect(le32(b, eocd)).toBe(0x06054b50);
    expect([le16(b, eocd + 8), le16(b, eocd + 10), le32(b, eocd + 12), le32(b, eocd + 16)]).toEqual([0xffff, 0xffff, 0xffffffff, 0xffffffff]);
    expect(le32(b, eocd - 20)).toBe(0x07064b50); // locator
    const rec = le32(b, eocd - 20 + 8);
    expect(le32(b, rec)).toBe(0x06064b50);
    expect(le32(b, rec + 24)).toBe(1); // entries
    const cd = le32(b, rec + 48);
    expect(le32(b, cd + 20)).toBe(0xffffffff); // central csize sentinel
    expect(le16(b, cd + 46 + 5)).toBe(1); // extra field id after the 5-byte name
  });

  it('multi-disk: the EOCD names a non-zero disk', () => {
    expect(readCentral(get('multi-disk').bytes).disk).toBe(1);
  });

  it('encrypted entries set flag bit 0, add a 12-byte header, and leave the other entry plain', () => {
    const z = readCentral(get('encrypted').bytes);
    expect(z.entries[0].flags & 1).toBe(1);
    expect(z.entries[0].csize).toBeGreaterThan(12);
    expect(z.entries[1].flags & 1).toBe(0);
  });

  it('name-length, entry-count and comment boundaries', () => {
    expect(readCentral(get('name-255-bytes').bytes).entries[0].name.length).toBe(255);
    expect(readCentral(get('name-256-bytes').bytes).entries[0].name.length).toBe(256);
    expect(readCentral(get('entries-4096').bytes).total).toBe(4096);
    expect(readCentral(get('entries-4097').bytes).total).toBe(4097);
    const m = get('max-comment').bytes;
    expect(readCentral(m).commentLen).toBe(65535);
    expect(le32(m, m.length - 65557)).toBe(0x06054b50); // exactly the farthest an EOCD can be found
  });

  it('empty and not-a-zip fixtures', () => {
    expect(get('empty-archive').bytes.length).toBe(22);
    expect(readCentral(get('empty-archive').bytes).total).toBe(0);
    const n = get('not-a-zip').bytes;
    for (let i = 0; i + 4 <= n.length; i++) expect(le32(n, i)).not.toBe(0x06054b50);
  });

  it('buildZip rejects nothing it should accept: empty names, directories and nested paths', () => {
    const z = buildZip([{ name: 'd/', dir: true }, { name: 'd/x', data: '' }]);
    expect(readCentral(z).total).toBe(2);
  });
});

describe.skipIf(!HAS_UNZIP)('zip via Info-ZIP unzip (list and test, plus one extraction into a nested temp directory)', () => {
  it.each(all.map((c) => [c.id, c]))('%s: `unzip -l` behaves as recorded', (id, c) => {
    const r = unzip(['-l', fileFor(id)]);
    expect(r.status, r.output.slice(0, 300)).toBe(c.unzip.list.exit);
    if (c.unzip.list.match) expect(r.output).toMatch(c.unzip.list.match);
  });

  it.each(all.filter((c) => c.unzip.test).map((c) => [c.id, c]))('%s: `unzip -t` behaves as recorded', (id, c) => {
    const args = c.password ? ['-t', '-P', c.password, fileFor(id)] : ['-t', fileFor(id)];
    const r = unzip(args);
    expect(r.status, r.output.slice(0, 300)).toBe(c.unzip.test?.exit);
    if (c.unzip.test?.match) expect(r.output).toMatch(c.unzip.test.match);
  });

  it('the encrypted entry needs its password: the right one tests clean, a wrong one fails', () => {
    const p = fileFor('encrypted');
    expect(unzip(['-t', '-P', ZIP_PASSWORD, p]).status).toBe(0);
    const wrong = unzip(['-t', '-P', 'nope', p]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.output).toMatch(/incorrect password/);
    expect(unzipEntry(p, 'enc.txt', ZIP_PASSWORD)).toEqual(new TextEncoder().encode('top secret\n'));
  });

  it('Info-ZIP flags traversal and absolute names on extraction, and nothing lands outside the target', () => {
    const root = makeTempDir('w04-extract-');
    try {
      const target = join(root, 'outer', 'inner');
      mkdirSync(target, { recursive: true });
      for (const c of all.filter((x) => x.unzip.extract)) {
        const r = unzip(['-o', '-d', target, fileFor(c.id)]);
        expect(r.output, c.id).toMatch(/** @type {RegExp} */ (c.unzip.extract));
      }
      expect(readdirSync(root)).toEqual(['outer']);
      expect(readdirSync(join(root, 'outer'))).toEqual(['inner']);
      expect(existsSync('/etc/evil')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ratio-over-cap is a valid archive to Info-ZIP: `unzip -t` is clean and the entry is its declared size of zeros', () => {
    const p = fileFor('ratio-over-cap');
    const { usize, crc } = readCentral(get('ratio-over-cap').bytes).entries[0];
    const t = unzip(['-t', p]);
    expect(t.status, t.output.slice(0, 300)).toBe(0);
    expect(t.output).toMatch(/OK/);
    const got = unzipEntry(p, 'ratio.bin');
    expect(got, 'unzip -p').not.toBeNull();
    expect(got?.length).toBe(usize);
    expect(nodeCrc32(/** @type {Uint8Array} */ (got))).toBe(crc);
    expect(got?.every((b) => b === 0)).toBe(true);
  });

  it('the symlink entry is a symlink to Info-ZIP too', () => {
    expect(zipinfo(fileFor('symlink-entries'))).toMatch(/^l[rwx-]{9}\s.*\slink$/m);
  });

  it('ZIP64 is read by Info-ZIP and the entry data survives', () => {
    expect(unzipEntry(fileFor('zip64'), 'z.txt')).toEqual(new TextEncoder().encode('zip64\n'));
  });

  it('entry data written by the stored and deflate paths reads back byte for byte', () => {
    for (const id of ['stored-and-deflate', 'macos-junk', 'backslash-names', 'proto-names', 'ratio-under-cap']) {
      const c = get(id);
      const p = fileFor(id);
      for (const e of c.expect.entries) {
        if (e.data === null || /[*?[\\:]/.test(e.name) || e.name.includes('/')) continue; // unzip treats these as patterns or paths
        const got = unzipEntry(p, e.name);
        expect(got && Buffer.compare(got, e.data) === 0, `${id}/${e.name}`).toBe(true);
      }
    }
  });
});
