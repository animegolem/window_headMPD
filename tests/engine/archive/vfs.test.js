// @ts-check
// openVfs: the flat, case-folded, basename-keyed Map (ENGINE D4). Skin-controlled names key every
// lookup, so the `__proto__` and `constructor` cases are the point of several tests here.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { ArchiveError } from '../../../src/engine/archive/zip.js';
import { buildZip, zipCase, zipCaseIds } from '../../support/zip-writer.js';
import { minimalSkin } from '../../support/wms-builder.js';

const T = (/** @type {string} */ s) => new TextEncoder().encode(s);
const same = (/** @type {Uint8Array|null} */ a, /** @type {Uint8Array|null} */ b) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);
/** the test's own model of the key: basename, NFC, lower case @param {string} name */
const keyOf = (name) => name.replaceAll('\\', '/').split('/').pop()?.normalize('NFC').toLowerCase() ?? '';

describe('the W0.4 catalogue through the VFS', () => {
  it.each(zipCaseIds().map((id) => [id]))('%s', async (id) => {
    const c = zipCase(id);
    if (c.expect.throws) {
      await expect(openVfs(c.bytes, `${id}.zip`)).rejects.toBeInstanceOf(ArchiveError);
      await expect(openVfs(c.bytes, `${id}.zip`)).rejects.toMatchObject({ code: c.expect.throws });
      return;
    }
    const vfs = await openVfs(c.bytes, `${id}.zip`);
    // model: the last entry per key wins
    /** @type {Map<string, Uint8Array|null>} */
    const model = new Map();
    for (const e of c.expect.entries) model.set(keyOf(e.name), e.data);
    expect(vfs.list().slice().sort()).toEqual([...model.keys()].sort());
    for (const [key, data] of model) {
      expect(vfs.has(key), `has(${key})`).toBe(true);
      expect(vfs.resolve(key)).toBe(key);
      expect(same(vfs.read(key), data), `read(${key})`).toBe(true);
    }
    // and the catalogue's own statement of which bytes win
    for (const [key, data] of c.expect.vfs ?? []) expect(same(vfs.read(key), data), `expect.vfs ${key}`).toBe(true);
  });
});

describe('lookups keyed by skin strings are maps', () => {
  it('`__proto__` and `constructor` are absent from an archive without such entries', async () => {
    const vfs = await openVfs(zipCase('stored-and-deflate').bytes, 'plain.zip');
    for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
      expect(vfs.has(k), `has(${k})`).toBe(false);
      expect(vfs.read(k), `read(${k})`).toBeNull();
      expect(vfs.resolve(k), `resolve(${k})`).toBeNull();
      expect(vfs.list()).not.toContain(k);
    }
    expect(vfs.list()).toEqual(['a.txt', 'b.bmp', 'c.txt']);
  });

  it('are ordinary names when the archive has entries called that', async () => {
    const vfs = await openVfs(zipCase('proto-names').bytes, 'proto.zip');
    expect(vfs.has('__proto__')).toBe(true);
    expect(vfs.has('constructor')).toBe(true);
    expect(vfs.has('CONSTRUCTOR')).toBe(true);
    expect(vfs.read('__proto__')).toEqual(T('p\n'));
    expect(vfs.read('constructor')).toEqual(T('c\n'));
    expect(vfs.resolve('dir\\__proto__')).toBe('__proto__');
    expect(vfs.has('toString')).toBe(false);
    expect(vfs.list()).toEqual(['__proto__', 'constructor', 'ok.txt']);
    // the entry did not become the VFS's prototype or a property of it
    expect(Object.getPrototypeOf(vfs)).toBe(Object.prototype);
    expect(Object.keys(vfs).sort()).toEqual(['diagnostics', 'has', 'list', 'name', 'read', 'resolve', 'sha']);
  });
});

describe('references fold like entry names', () => {
  it('ignores case, directories and both separators', async () => {
    const vfs = await openVfs(buildZip([
      { name: 'Skin/Art/Bass_SliderBG.bmp', data: 'bass' },
      { name: 'pl_dropdown_wood.png', data: 'wood' },
      { name: 'sub\\deep\\Thing.GIF', data: 'gif' },
    ]), 'fold.wmz');
    for (const ref of ['bass_sliderbg.bmp', 'Bass_SliderBG.bmp', 'BASS_SLIDERBG.BMP', 'x/y/Bass_SliderBG.bmp', 'x\\y\\bass_sliderbg.BMP', './bass_sliderbg.bmp']) {
      expect(vfs.resolve(ref), ref).toBe('bass_sliderbg.bmp');
      expect(vfs.read(ref)).toEqual(T('bass'));
    }
    expect(vfs.resolve('pl\\pl_dropdown_wood.png')).toBe('pl_dropdown_wood.png');
    expect(vfs.has('THING.gif')).toBe(true);
    expect(vfs.has('thing.gif.bak')).toBe(false);
    expect(vfs.has('')).toBe(false);
    expect(vfs.has('Skin/Art/')).toBe(false);
  });

  it('meets across Unicode normalisation forms', async () => {
    const vfs = await openVfs(buildZip([{ name: 'Été.bmp', nameEncoding: 'utf8', data: 'x' }]), 'nfc.wmz');
    expect(vfs.has('été.bmp')).toBe(true); // decomposed
    expect(vfs.has('été.BMP')).toBe(true);
    expect(vfs.resolve('ÉTÉ.bmp')).toBe('été.bmp');
  });

  it('answers wrong-typed and odd references with false or null, never a throw', async () => {
    const vfs = await openVfs(zipCase('stored-and-deflate').bytes, 'odd.zip');
    for (const ref of [undefined, null, 0, 12, {}, [], ['a.txt'], Symbol.iterator, () => 'a.txt']) {
      expect(vfs.has(/** @type {any} */ (ref))).toBe(false);
      expect(vfs.read(/** @type {any} */ (ref))).toBeNull();
      expect(vfs.resolve(/** @type {any} */ (ref))).toBeNull();
    }
    for (const ref of ['a'.repeat(100_000), '\0', 'a\0.txt', '\ud800', '../../etc/passwd', 'res://wmploc.dll/RT_BITMAP/#132']) {
      expect(vfs.has(ref)).toBe(false);
      expect(vfs.read(ref)).toBeNull();
    }
  });
});

describe('list, collisions, diagnostics', () => {
  it('list(ext) filters on the key suffix without regard to case; list() is everything', async () => {
    const vfs = await openVfs(buildZip([{ name: 'A.WMS', data: '1' }, { name: 'b.wms', data: '2' }, { name: 'c.js', data: '3' }, { name: 'wms', data: '4' }]), 'l.wmz');
    expect(vfs.list('.wms')).toEqual(['a.wms', 'b.wms']);
    expect(vfs.list('.WMS')).toEqual(['a.wms', 'b.wms']);
    expect(vfs.list('.js')).toEqual(['c.js']);
    expect(vfs.list('.bmp')).toEqual([]);
    expect(vfs.list()).toEqual(['a.wms', 'b.wms', 'c.js', 'wms']);
    vfs.list().length = 0; // a copy: emptying it changes nothing
    expect(vfs.list()).toHaveLength(4);
  });

  it('a case collision is last-wins, with one diagnostic per replaced entry', async () => {
    const vfs = await openVfs(zipCase('case-collisions').bytes, 'c.zip');
    expect(vfs.read('FOO.bmp')).toEqual(T('third\n'));
    const hits = vfs.diagnostics.filter((d) => d.code === 'vfs-case-collision');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ severity: 'warn', file: 'foo.bmp' });
    expect(hits[0].detail).toContain('Foo.bmp');
    expect(hits[0].detail).toContain('FOO.BMP');
    expect(hits[1].detail).toContain('foo.bmp');
    // no collision, no diagnostic
    expect((await openVfs(zipCase('stored-and-deflate').bytes, 's.zip')).diagnostics).toEqual([]);
  });

  it('the diagnostics array is live: a CRC mismatch found by a later read() appears in it', async () => {
    const b = zipCase('stored-and-deflate').bytes.slice();
    b[Buffer.from(b).indexOf('stored entry')] ^= 1;
    const vfs = await openVfs(b, 'crc.zip');
    expect(vfs.diagnostics).toEqual([]);
    expect(vfs.read('a.txt')?.length).toBe(13); // still returned
    expect(vfs.diagnostics.map((d) => d.code)).toEqual(['zip-crc-mismatch']);
  });

  it('reader diagnostics (skips, salvage) are on the VFS from the start', async () => {
    const vfs = await openVfs(zipCase('traversal-names').bytes, 't.zip');
    expect(vfs.diagnostics.filter((d) => d.code === 'zip-name-unsafe')).toHaveLength(3);
    expect(vfs.list()).toEqual(['ok.txt']);
  });

  it('an empty-named or `.` entry never becomes a key, so `\'\'`, `.` and `dir/` find nothing (G1.F5)', async () => {
    const vfs = await openVfs(buildZip([{ name: '', data: 'n' }, { name: '.', data: 'd' }, { name: 'a/.', data: 'd' }, { name: 'a.bmp', data: 'a' }]), 'dots.zip');
    expect(vfs.list()).toEqual(['a.bmp']);
    for (const ref of ['', '.', 'dir/', 'a/.', 'a\\']) {
      expect(vfs.has(ref), `has(${JSON.stringify(ref)})`).toBe(false);
      expect(vfs.read(ref)).toBeNull();
      expect(vfs.resolve(ref)).toBeNull();
    }
    expect(vfs.diagnostics.filter((d) => d.code === 'zip-name-unsafe')).toHaveLength(3);
  });

  it('a lower-case `.ds_store` is junk and never a key (G1.F5)', async () => {
    const vfs = await openVfs(buildZip([{ name: '.ds_store', data: 'x' }, { name: 'sub/.DS_STORE', data: 'x' }, { name: 'a.bmp', data: 'a' }]), 'ds.zip');
    expect(vfs.list()).toEqual(['a.bmp']);
    expect(vfs.has('.ds_store')).toBe(false);
    expect(vfs.diagnostics.filter((d) => d.code === 'zip-junk')).toHaveLength(2);
  });

  it('a corrupt entry is present but reads as null', async () => {
    const vfs = await openVfs(zipCase('declared-4gb-bomb').bytes, 'bomb.zip');
    expect(vfs.has('bomb.bin')).toBe(true);
    expect(vfs.read('bomb.bin')).toBeNull();
    expect(vfs.read('ok.txt')).toEqual(T('ok.txt contents\n'));
  });

  it('read() returns a fresh copy each time', async () => {
    const vfs = await openVfs(buildZip([{ name: 'a.bin', data: 'abcdef' }]), 'copy.zip');
    const a = /** @type {Uint8Array} */ (vfs.read('a.bin'));
    a[0] = 0;
    expect(vfs.read('a.bin')).toEqual(T('abcdef'));
  });
});

describe('identity and shape', () => {
  it('sha is the SHA-256 of the archive bytes and name is kept for display', async () => {
    const skin = minimalSkin({ name: 'Synthetic' });
    const vfs = await openVfs(skin.bytes, 'Synthetic.wmz');
    expect(vfs.sha).toBe(createHash('sha256').update(skin.bytes).digest('hex'));
    expect(vfs.name).toBe('Synthetic.wmz');
    expect(vfs.list('.wms')).toEqual(['synthetic.wms']);
    expect(vfs.read('Synthetic.WMS')).toEqual(skin.files.get('Synthetic.wms'));
    expect([...skin.files.keys()].every((k) => vfs.has(k))).toBe(true);
  });

  it('is frozen, and hashes the view rather than a larger buffer', async () => {
    const base = zipCase('stored-and-deflate').bytes;
    const padded = new Uint8Array(base.length + 20).fill(7);
    padded.set(base, 10);
    const vfs = await openVfs(padded.subarray(10, 10 + base.length), 'view.zip');
    expect(Object.isFrozen(vfs)).toBe(true);
    expect(vfs.sha).toBe(createHash('sha256').update(base).digest('hex'));
  });

  it('rejects, with ArchiveError, for bytes that are not a zip and for archive caps', async () => {
    await expect(openVfs(T('not a zip'.repeat(20)), 'x.zip')).rejects.toMatchObject({ name: 'ArchiveError', code: 'not-a-zip' });
    await expect(openVfs(zipCase('stored-and-deflate').bytes, 'x.zip', { maxEntries: 1 })).rejects.toMatchObject({ code: 'archive-cap' });
  });
});
