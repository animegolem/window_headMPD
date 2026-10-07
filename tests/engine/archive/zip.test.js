// @ts-check
// readZip against the W0.4 catalogue (ENGINE D4). Every case in `zipCases()` states what a D4 reader
// must expose, skip and return from read(); this file holds the reader to it, then adds the
// behaviours the catalogue cannot express (caps, lies in the headers, damaged streams, copies,
// a foreign entry, truncation and byte-flip fuzzing).
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchiveError, DEFAULT_ZIP_CAPS, readZip } from '../../../src/engine/archive/zip.js';
import { crc32, noiseBytes, rng } from '../../support/bytes.js';
import { buildZip, cp437Decode, cp437Encode, zipCase, zipCaseIds } from '../../support/zip-writer.js';

const SKIP_CODES = ['zip-name-too-long', 'zip-name-unsafe', 'zip-junk', 'zip-symlink', 'zip-encrypted', 'zip-method', 'zip-local-header-bad'];
const T = (/** @type {string} */ s) => new TextEncoder().encode(s);
const same = (/** @type {Uint8Array|null} */ a, /** @type {Uint8Array|null} */ b) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);
const MiB = 1024 * 1024;

/** @param {Uint8Array} bytes @param {(i: ReturnType<typeof readZip>) => void} [then] */
const open = (bytes, then) => { const i = readZip(bytes); then?.(i); return i; };

describe('DEFAULT_ZIP_CAPS', () => {
  it('is the D4 / section 10 table, frozen', () => {
    expect(DEFAULT_ZIP_CAPS).toEqual({ maxArchiveBytes: 32 * MiB, maxEntries: 4096, maxEntryBytes: 32 * MiB, maxTotalInflated: 256 * MiB, maxRatio: 1024, maxNameBytes: 255 });
    expect(Object.isFrozen(DEFAULT_ZIP_CAPS)).toBe(true);
  });
});

describe('the W0.4 catalogue', () => {
  it.each(zipCaseIds().map((id) => [id]))('%s', (id) => {
    const c = zipCase(id);
    if (c.expect.throws) {
      expect(() => readZip(c.bytes)).toThrow(ArchiveError);
      try { readZip(c.bytes); } catch (e) { expect(/** @type {ArchiveError} */ (e).code).toBe(c.expect.throws); }
      return;
    }
    const index = readZip(c.bytes);
    // exposed entries, in central-directory order, with `\` read as `/`
    expect(index.entries.map((e) => e.name)).toEqual(c.expect.entries.map((e) => e.name));
    c.expect.entries.forEach((want, i) => {
      const got = index.read(index.entries[i]);
      expect(same(got, want.data), `${id}: read(${want.name})`).toBe(true);
    });
    // skipped names, each with a diagnostic carrying the raw name, and no diagnostic for anything else
    const skipped = index.diagnostics.filter((d) => SKIP_CODES.includes(d.code)).map((d) => d.file);
    expect(skipped.slice().sort()).toEqual(c.expect.skipped.slice().sort());
    // a clean read has no CRC complaint; a null read says why, once
    const nulls = c.expect.entries.filter((e) => e.data === null).length;
    expect(index.diagnostics.filter((d) => d.code === 'zip-crc-mismatch')).toEqual([]);
    expect(index.diagnostics.filter((d) => /^zip-(entry|ratio|total)/.test(d.code)).length).toBe(nulls);
  });

  it('salvages the corrupt-first-signature archive with one info diagnostic and no skip', () => {
    const i = readZip(zipCase('corrupt-first-local-signature').bytes);
    const salvaged = i.diagnostics.filter((d) => d.code === 'zip-local-header-salvaged');
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]).toMatchObject({ severity: 'info', file: 'first.txt' });
    expect(i.diagnostics.filter((d) => SKIP_CODES.includes(d.code))).toEqual([]);
  });

  it('skips the mismatched-name archive with a warning', () => {
    const i = readZip(zipCase('corrupt-first-local-signature-name-mismatch').bytes);
    expect(i.diagnostics).toEqual([expect.objectContaining({ code: 'zip-local-header-bad', severity: 'warn', file: 'first.txt' })]);
  });
});

describe('archive-level failures throw ArchiveError and nothing else', () => {
  /** @param {() => unknown} fn @param {string} code */
  const code = (fn, code) => { expect(fn).toThrow(ArchiveError); try { fn(); } catch (e) { expect(/** @type {ArchiveError} */ (e).code).toBe(code); expect(/** @type {Error} */ (e).name).toBe('ArchiveError'); } };

  it('not a zip: empty, short, text, and not bytes at all', () => {
    code(() => readZip(new Uint8Array(0)), 'not-a-zip');
    code(() => readZip(new Uint8Array(21)), 'not-a-zip');
    code(() => readZip(T('PK\x03\x04 and then nothing like a directory'.repeat(3))), 'not-a-zip');
    code(() => readZip(/** @type {any} */ ('a string')), 'not-a-zip');
    code(() => readZip(/** @type {any} */ (undefined)), 'not-a-zip');
  });

  it('archive-level caps: size, entry count, with explicit overrides', () => {
    const ok = zipCase('stored-and-deflate').bytes;
    code(() => readZip(ok, { maxArchiveBytes: ok.length - 1 }), 'archive-cap');
    expect(readZip(ok, { maxArchiveBytes: ok.length }).entries).toHaveLength(3);
    code(() => readZip(ok, { maxEntries: 3 }), 'archive-cap'); // 4 central entries: the directory counts
    expect(readZip(ok, { maxEntries: 4 }).entries).toHaveLength(3);
    // an explicit undefined (or NaN) does not erase a cap
    code(() => readZip(zipCase('entries-4097').bytes, { maxEntries: undefined }), 'archive-cap');
    code(() => readZip(zipCase('entries-4097').bytes, { maxEntries: NaN }), 'archive-cap');
    expect(readZip(zipCase('entries-4096').bytes).entries).toHaveLength(4096);
  });

  it('a central directory that lies about where it is', () => {
    const b = zipCase('stored-and-deflate').bytes.slice();
    const dv = new DataView(b.buffer);
    const eocd = b.length - 22;
    dv.setUint32(eocd + 16, b.length, true); // directory offset past the EOCD
    code(() => readZip(b), 'not-a-zip');
    const c = zipCase('stored-and-deflate').bytes.slice();
    new DataView(c.buffer).setUint32(new DataView(c.buffer).getUint32(c.length - 22 + 16, true), 0xdeadbeef, true); // first central signature
    code(() => readZip(c), 'not-a-zip');
  });

  it('finds the real EOCD when the archive comment holds an EOCD signature', () => {
    const fake = new Uint8Array(40);
    fake.set([0x50, 0x4b, 0x05, 0x06]);
    const i = readZip(buildZip([{ name: 'a.txt', data: 'hello' }], { comment: fake }));
    expect(i.entries.map((e) => e.name)).toEqual(['a.txt']);
  });

  it('a sentinel size in one central entry is ZIP64 even when the EOCD looks normal', () => {
    const b = buildZip([{ name: 'a.txt', data: 'hello', method: 'store' }]).slice();
    const dv = new DataView(b.buffer);
    const cd = dv.getUint32(b.length - 22 + 16, true);
    dv.setUint32(cd + 24, 0xffffffff, true);
    code(() => readZip(b), 'zip64');
  });
});

describe('read() refuses from the headers, before allocating', () => {
  /** Bytes of ArrayBuffer memory the process holds, around one call. @template T @param {() => T} fn */
  const grew = (fn) => { const before = process.memoryUsage().arrayBuffers; const r = fn(); return { delta: process.memoryUsage().arrayBuffers - before, r }; };

  it('the 4 GB-declared entry and the over-ratio entry return null and allocate under 2 MiB', () => {
    const bomb = open(zipCase('declared-4gb-bomb').bytes);
    const ratio = open(zipCase('ratio-over-cap').bytes);
    const a = grew(() => bomb.read(bomb.entries[0]));
    const b = grew(() => ratio.read(ratio.entries[0]));
    expect(a.r).toBeNull();
    expect(b.r).toBeNull();
    expect(a.delta).toBeLessThan(2 * MiB);
    expect(b.delta).toBeLessThan(2 * MiB);
    expect(bomb.diagnostics.map((d) => d.code)).toEqual(['zip-entry-too-large']);
    expect(ratio.diagnostics.map((d) => d.code)).toEqual(['zip-ratio']);
  });

  it('control: the measurement does see a 2 MiB allocation, so the bound above means something', () => {
    const ok = open(zipCase('ratio-under-cap').bytes);
    const { delta, r } = grew(() => ok.read(ok.entries[0]));
    expect(r?.length).toBe(2 * MiB);
    expect(delta).toBeGreaterThanOrEqual(2 * MiB);
  });

  it('the ratio cap binds entries over 1 MiB only', () => {
    const zeros = new Uint8Array(1024 * 1024 + 1024);
    const pack = open(buildZip([{ name: 'z.bin', data: zeros }]));
    const e = pack.entries[0];
    expect(e.usize / e.csize).toBeGreaterThan(100);
    expect(same(pack.read(e), zeros)).toBe(true);
    // the same entry under a tighter ratio cap is refused...
    const tight = readZip(buildZip([{ name: 'z.bin', data: zeros }]), { maxRatio: 10 });
    expect(tight.read(tight.entries[0])).toBeNull();
    // ...while a small, highly compressible entry has no ratio cap at all
    const small = readZip(buildZip([{ name: 's.bin', data: new Uint8Array(64 * 1024) }]), { maxRatio: 2 });
    expect(small.read(small.entries[0])?.length).toBe(64 * 1024);
  });

  it('per-entry and total caps', () => {
    const three = buildZip(['a', 'b', 'c'].map((n) => ({ name: `${n}.bin`, data: noiseBytes(1000, n.charCodeAt(0)), method: /** @type {'store'} */ ('store') })));
    const capped = readZip(three, { maxEntryBytes: 999 });
    expect(capped.entries.map((e) => capped.read(e))).toEqual([null, null, null]);
    const total = readZip(three, { maxTotalInflated: 2500 });
    const [a, b, c] = total.entries;
    expect(total.read(a)?.length).toBe(1000);
    expect(total.read(b)?.length).toBe(1000);
    expect(total.read(c)).toBeNull(); // 3000 > 2500
    expect(total.read(a)?.length).toBe(1000); // an entry already paid for stays readable
    expect(total.diagnostics.filter((d) => d.code === 'zip-total-cap')).toHaveLength(1);
    expect(total.read(c)).toBeNull();
    expect(total.diagnostics.filter((d) => d.code === 'zip-total-cap')).toHaveLength(1); // reported once
  });
});

describe('read() when the headers lie or the stream is damaged', () => {
  it('declared smaller than the real size: null, stopped at the first overflowing push', () => {
    const i = open(buildZip([{ name: 'a.bin', data: new Uint8Array(100_000), declaredSize: 1000 }]));
    expect(i.read(i.entries[0])).toBeNull();
    expect(i.diagnostics).toEqual([expect.objectContaining({ code: 'zip-entry-corrupt', file: 'a.bin', detail: expect.stringMatching(/more than the declared 1000/) })]);
  });

  it('declared larger than the real size: null (underflow)', () => {
    const i = open(buildZip([{ name: 'a.bin', data: 'x'.repeat(100), declaredSize: 5000 }]));
    expect(i.read(i.entries[0])).toBeNull();
    expect(i.diagnostics[0].detail).toMatch(/inflates to 100 bytes, declared 5000/);
  });

  it('a truncated deflate stream is null, not a throw', () => {
    const data = noiseBytes(2000, 5);
    const full = deflateSync(data, { level: 6 });
    const i = open(buildZip([{ name: 't.bin', precompressed: { deflated: full.subarray(0, 1000), size: data.length, crc: crc32(data) } }]));
    expect(i.read(i.entries[0])).toBeNull();
    expect(i.diagnostics[0]).toMatchObject({ code: 'zip-entry-corrupt', detail: expect.stringMatching(/deflate stream is invalid/) });
  });

  it('garbage in place of a deflate stream is null', () => {
    const i = open(buildZip([{ name: 'g.bin', data: noiseBytes(300, 9), method: 8, declaredSize: 600 }]));
    // method 8 with a raw payload: `data` is the "compressed" bytes
    expect(i.read(i.entries[0])).toBeNull();
  });

  it('a stored entry whose two sizes disagree is null', () => {
    const b = buildZip([{ name: 'a.bin', data: 'x'.repeat(100), method: 'store', declaredSize: 50 }]);
    const i = open(b);
    expect(i.read(i.entries[0])).toBeNull();
  });

  it('data that runs past the end of the archive is null', () => {
    const b = buildZip([{ name: 'a.bin', data: noiseBytes(100, 1), method: 'store' }, { name: 'b.bin', data: 'x', method: 'store' }]).slice();
    const dv = new DataView(b.buffer);
    const cd = dv.getUint32(b.length - 22 + 16, true);
    dv.setUint32(cd + 20, 16_000_000, true); // csize
    dv.setUint32(cd + 24, 16_000_000, true); // usize
    const i = open(b);
    expect(i.read(i.entries[0])).toBeNull();
    expect(i.diagnostics[0].code).toBe('zip-entry-truncated');
    expect(same(i.read(i.entries[1]), T('x'))).toBe(true);
  });

  it('a bad CRC is a warning, once, and the data is still returned', () => {
    const b = zipCase('stored-and-deflate').bytes.slice();
    const at = Buffer.from(b).indexOf('stored entry');
    b[at] ^= 0xff;
    const i = open(b);
    const e = i.entries[0];
    const got = i.read(e);
    expect(got?.length).toBe('stored entry\n'.length);
    expect(got?.[0]).toBe(b[at]);
    i.read(e);
    expect(i.diagnostics).toEqual([expect.objectContaining({ code: 'zip-crc-mismatch', severity: 'warn', file: 'a.txt' })]);
  });

  it('empty files read as empty arrays, stored or deflated, and an empty deflate payload with a size is null', () => {
    const i = open(buildZip([{ name: 'e1', data: '', method: 'store' }, { name: 'e2', data: '', method: 'deflate' }]));
    expect(i.entries.map((e) => i.read(e)?.length)).toEqual([0, 0]);
    const lie = open(buildZip([{ name: 'e', data: '', method: 'store', declaredSize: 10 }, { name: 'f', data: new Uint8Array(0), method: 8, declaredSize: 10 }]));
    expect(lie.entries.map((e) => lie.read(e))).toEqual([null, null]);
  });

  it('large entries survive chunked inflation: stored blocks, long matches, mixed content', () => {
    const noise = noiseBytes(300_000, 11); // deflate emits stored blocks
    const mixed = Uint8Array.from({ length: 700_000 }, (_, i) => (i % 5000 < 2500 ? (i * 7) & 255 : 65));
    const i = open(buildZip([{ name: 'n.bin', data: noise }, { name: 'm.bin', data: mixed }, { name: 's.bin', data: noise, method: 'store' }]));
    expect(i.entries.map((e) => same(i.read(e), [noise, mixed, noise][i.entries.indexOf(e)]))).toEqual([true, true, true]);
    expect(i.diagnostics).toEqual([]);
  });

  it('read() hands out copies', () => {
    const i = open(buildZip([{ name: 'a.bin', data: 'abcdef', method: 'store' }, { name: 'b.bin', data: 'ghijkl' }]));
    for (const e of i.entries) {
      const a = /** @type {Uint8Array} */ (i.read(e));
      const b = /** @type {Uint8Array} */ (i.read(e));
      a[0] ^= 0xff;
      expect(b[0]).not.toBe(a[0]);
      expect(a.buffer.byteLength).toBe(a.length); // not a window onto the archive
      expect(a.byteOffset).toBe(0);
    }
  });

  it('read() of anything that is not one of this index\'s entries is null and never throws', () => {
    const i = open(zipCase('stored-and-deflate').bytes);
    const other = open(zipCase('stored-and-deflate').bytes);
    const copy = { ...i.entries[0] };
    for (const e of [undefined, null, 0, 'a.txt', {}, copy, other.entries[0]]) expect(i.read(/** @type {any} */ (e))).toBeNull();
  });

  it('entries are frozen and carry the contract fields', () => {
    const i = open(zipCase('stored-and-deflate').bytes);
    expect(Object.isFrozen(i.entries[0])).toBe(true);
    expect(Object.keys(i.entries[0]).sort()).toEqual(['crc', 'csize', 'key', 'method', 'name', 'offset', 'usize']);
    expect(i.entries.map((e) => [e.name, e.key, e.method])).toEqual([['a.txt', 'a.txt', 0], ['b.bmp', 'b.bmp', 8], ['sub/c.txt', 'c.txt', 8]]);
  });
});

describe('names', () => {
  it('the engine CP437 table is the writer\'s, over all 128 high bytes', () => {
    const high = Uint8Array.from({ length: 128 }, (_, k) => 0x80 + k);
    const names = [...cp437Decode(high)].map((ch) => ({ name: `${ch}.x`, nameEncoding: /** @type {'cp437'} */ ('cp437'), data: 'd', method: /** @type {'store'} */ ('store') }));
    const i = open(buildZip(names));
    expect(i.entries.map((e) => e.name)).toEqual(names.map((n) => n.name));
    expect(Array.from(cp437Encode(i.entries[0].name))).toEqual([0x80, 0x2e, 0x78]);
  });

  it('keeps a leading BOM in a UTF-8 name, and reads flagged UTF-8 as UTF-8', () => {
    const i = open(buildZip([
      { name: Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x2e, 0x62, 0x6d, 0x70), nameEncoding: 'utf8', data: 'x' },
      { name: '日本.bmp', nameEncoding: 'utf8', data: 'y' },
    ]));
    expect(i.entries.map((e) => e.name)).toEqual(['﻿a.bmp', '日本.bmp']);
  });

  it('keys are the NFC lower-cased basename', () => {
    const i = open(buildZip([
      { name: 'Skin\\Art/Bass_SliderBG.BMP', data: 'a' },
      { name: 'É.png', nameEncoding: 'utf8', data: 'b' },
      { name: 'İ.png', nameEncoding: 'utf8', data: 'c' },
    ]));
    expect(i.entries.map((e) => e.key)).toEqual(['bass_sliderbg.bmp', 'é.png', 'i̇.png']);
  });

  it('long names are clipped in diagnostics but still skipped', () => {
    const long = 'a'.repeat(5000);
    const i = open(buildZip([{ name: long, data: 'x' }, { name: 'ok', data: 'y' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['ok']);
    expect(i.diagnostics).toHaveLength(1);
    expect(i.diagnostics[0].file?.length).toBe(257);
    expect(i.diagnostics[0].file?.endsWith('…')).toBe(true);
  });

  it('a name that is only a dot-dot component, with any separator, is skipped; dots inside names are fine', () => {
    const i = open(buildZip([{ name: '..', data: 'x' }, { name: 'a/..', data: 'x' }, { name: '..\\', data: 'x' }, { name: 'a..b/c..d.bmp', data: 'ok' }, { name: '.hidden', data: 'ok' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['a..b/c..d.bmp', '.hidden']);
  });
});

describe('names that fold to no usable key (G1.F5)', () => {
  const unsafeFiles = (/** @type {ReturnType<typeof readZip>} */ i) => i.diagnostics.filter((d) => d.code === 'zip-name-unsafe').map((d) => d.file);

  it('an empty name and a `.` basename are skipped with a diagnostic carrying the raw name', () => {
    const i = open(buildZip([
      { name: '', data: 'nameless' },
      { name: '.', data: 'dot' },
      { name: 'a/.', data: 'dot in a folder' },
      { name: 'a\\.', data: 'backslash dot' },
      { name: 'ok.bmp', data: 'ok' },
    ]));
    expect(i.entries.map((e) => e.name)).toEqual(['ok.bmp']);
    expect(unsafeFiles(i)).toEqual(['', '.', 'a/.', 'a\\.']);
    expect(i.diagnostics.every((d) => d.severity === 'warn' && /empty or `\.` basename/.test(d.detail))).toBe(true);
  });

  it('only an exactly empty or `.` basename is refused: dots, spaces and ordinary names stay', () => {
    const i = open(buildZip([{ name: '..a', data: '1' }, { name: 'a.', data: '2' }, { name: '. ', data: '3' }, { name: 'x/.b', data: '4' }, { name: '...', data: '5' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['..a', 'a.', '. ', 'x/.b', '...']);
    expect(i.diagnostics).toEqual([]);
  });

  it('a directory entry is still dropped silently, not reported as an empty name', () => {
    const i = open(buildZip([{ name: 'sub/', dir: true }, { name: '/', dir: true }, { name: 'a.txt', data: 'x' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['a.txt']);
    expect(i.diagnostics).toEqual([]);
  });

  it('a name held to the other rules still reports under those rules first', () => {
    const i = open(buildZip([{ name: '../.', data: 'x' }, { name: '/.', data: 'x' }]));
    expect(i.entries).toEqual([]);
    expect(i.diagnostics.map((d) => d.detail)).toEqual(['absolute, drive-letter or parent-directory entry name', 'absolute, drive-letter or parent-directory entry name']);
  });
});

describe('macOS junk is matched case-insensitively (G1.F5)', () => {
  it.each(['.DS_Store', '.ds_store', '.DS_STORE', '.Ds_Store', 'sub/.dS_sToRe', 'sub\\.DS_STORE'])('%s', (name) => {
    const i = open(buildZip([{ name, data: 'ds' }, { name: 'real.bmp', data: 'r' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['real.bmp']);
    expect(i.diagnostics).toEqual([expect.objectContaining({ code: 'zip-junk', severity: 'info', file: name })]);
  });

  it('only the whole basename is junk: names that merely contain it stay', () => {
    const i = open(buildZip([{ name: 'x.DS_Store', data: '1' }, { name: '.DS_Store.bmp', data: '2' }, { name: '.DS_Stor', data: '3' }]));
    expect(i.entries.map((e) => e.name)).toEqual(['x.DS_Store', '.DS_Store.bmp', '.DS_Stor']);
    expect(i.diagnostics).toEqual([]);
  });
});

describe('ArchiveError (G1.F5)', () => {
  it('has the contract\'s shape: an Error named ArchiveError with a code, for every code', () => {
    for (const code of /** @type {const} */ (['not-a-zip', 'zip64', 'multidisk', 'archive-cap'])) {
      /** @type {import('../../../src/engine/contracts').ArchiveError} */
      const e = new ArchiveError(code, `why ${code}`);
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ArchiveError);
      expect(e.name).toBe('ArchiveError');
      expect(e.code).toBe(code);
      expect(e.message).toBe(`why ${code}`);
      expect(String(e)).toBe(`ArchiveError: why ${code}`);
    }
  });

  it('is what readZip throws, with the contracted name and one of the contracted codes', () => {
    const seen = new Set();
    for (const bytes of [zipCase('not-a-zip').bytes, zipCase('zip64').bytes, zipCase('multi-disk').bytes, zipCase('entries-4097').bytes]) {
      try { readZip(bytes); } catch (e) { expect(e).toBeInstanceOf(ArchiveError); expect(/** @type {Error} */ (e).name).toBe('ArchiveError'); seen.add(/** @type {ArchiveError} */ (e).code); }
    }
    expect([...seen].sort()).toEqual(['archive-cap', 'multidisk', 'not-a-zip', 'zip64']);
  });
});

describe('damaged archives never escape as another error type', () => {
  const sources = ['stored-and-deflate', 'macos-junk', 'encrypted', 'corrupt-first-local-signature', 'case-collisions'].map((id) => zipCase(id).bytes);

  const seen = { threw: 0, opened: 0, nulls: 0 };
  /** @param {Uint8Array} b */
  const attempt = (b) => {
    /** @type {ReturnType<typeof readZip>} */
    let index;
    try { index = readZip(b); } catch (e) { expect(e).toBeInstanceOf(ArchiveError); seen.threw++; return; }
    seen.opened++;
    for (const e of index.entries) {
      const got = index.read(e);
      expect(got === null || got instanceof Uint8Array).toBe(true);
      if (got === null) seen.nulls++;
    }
  };

  it('every truncation length of several small archives', () => {
    for (const b of sources) for (let n = 0; n <= b.length; n++) attempt(b.subarray(0, n));
  });

  it('byte flips (seeded), one to four at a time, in the headers and the data', () => {
    const rand = rng(20261006);
    for (let round = 0; round < 3000; round++) {
      const b = sources[round % sources.length].slice();
      for (let k = 1 + (round % 4); k > 0; k--) b[(rand() * b.length) | 0] = (rand() * 256) | 0;
      attempt(b);
    }
    // the fuzz reaches all three outcomes, so it is not passing by always failing early
    expect(seen.threw).toBeGreaterThan(100);
    expect(seen.opened).toBeGreaterThan(100);
    expect(seen.nulls).toBeGreaterThan(10);
  });

  it('the same bytes behind a non-zero byteOffset', () => {
    const base = zipCase('stored-and-deflate').bytes;
    const padded = new Uint8Array(base.length + 7);
    padded.set(base, 5);
    const i = readZip(padded.subarray(5, 5 + base.length));
    expect(i.entries.map((e) => i.read(e)?.length)).toEqual([13, 63, 7]);
  });
});
