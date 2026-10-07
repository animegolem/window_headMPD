// @ts-check
// createImageService (W2.4): keyed decodes through an executor, the (sha256, KeySpec) cache, the LRU,
// pending(), "old pixels until new ones land", raw() map images, the res:// fallback, and the
// `__proto__` / `constructor` cases for the lookups keyed by skin strings.
//
// The inline executor runs here; the Worker pool has its own file (tests/hosts/tauri/decode.test.js).
// Every image is synthetic (tests/support writers): no skin art.

import { describe, expect, it } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { DEFAULT_ZIP_CAPS } from '../../../src/engine/archive/zip.js';
import { decodeImage } from '../../../src/engine/image/decode/index.js';
import { keyImage } from '../../../src/engine/image/keying.js';
import { MAX_LIVE_BYTES, createImageService, createImageServiceWithOptions, createInlineExecutor } from '../../../src/engine/image/service.js';
import { decodeFailures } from '../../../src/engine/image/worker.js';
import { buildBmp } from '../../support/bmp-writer.js';
import { buildPng } from '../../support/png-writer.js';
import { buildZip } from '../../support/zip-writer.js';
import { bit, popcount } from './helpers.js';

const MAGENTA = 0xff00ff;
const GREEN = 0x00ff00;
const NO_KEY = { hitKeyed: false };

/** RGBA from rows of pixels given as [r, g, b, a?]. @param {number[][]} px @returns {Uint8Array} */
const rgbaOf = (px) => Uint8Array.from(px.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

/** A 24-bit BMP, w x h, every pixel grey except the listed ones. @param {number} w @param {number} h @param {Record<number, number[]>} [special] */
function bmp(w, h, special = {}, grey = 90) {
  const px = Array.from({ length: w * h }, (_, i) => special[i] ?? [grey, grey, grey]);
  return buildBmp({ width: w, height: h, bpp: 24, rgba: rgbaOf(px) }).bytes;
}

/** @param {Array<[string, Uint8Array]>} files an array, not an object: `__proto__` must stay a name */
const vfsOf = (files) => openVfs(buildZip(files.map(([name, data]) => ({ name, data }))), 'test.zip');

function recorder() {
  /** @type {import('../../../src/engine/contracts').Diagnostic[]} */
  const diags = [];
  /** @type {string[]} */
  const warns = [];
  return { diags, warns, log: { info() {}, warn: (/** @type {string} */ m) => { warns.push(m); }, diag: (/** @type {any} */ d) => { diags.push(d); } } };
}

/** The inline executor, counting the jobs it is given. */
function countingExecutor() {
  const inline = createInlineExecutor();
  /** @type {import('../../../src/engine/contracts').DecodeJob[]} */
  const runs = [];
  return { runs, run: (/** @type {any} */ job) => { runs.push(job); return inline.run(job); } };
}

/** An executor that holds every job until `release()`, and can fail the next one. */
function manualExecutor() {
  const inline = createInlineExecutor();
  /** @type {import('../../../src/engine/contracts').DecodeJob[]} */
  const runs = [];
  /** @type {Array<() => void>} */
  const waiting = [];
  const self = {
    runs,
    failNext: false,
    release() { for (const go of waiting.splice(0)) go(); },
    run(/** @type {any} */ job) {
      runs.push(job);
      const fail = self.failNext;
      self.failNext = false;
      return new Promise((resolve) => {
        waiting.push(() => {
          if (fail) {
            decodeFailures.set(job, [{ code: 'image-test-failure', detail: 'the executor gave up', severity: 'error' }]);
            resolve(null);
          } else resolve(inline.run(job));
        });
      });
    },
  };
  return self;
}

/** Wait for a condition that depends on the hash (a macrotask) and the executor. @param {() => boolean} cond */
async function until(cond) {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

/** Field by field, byte for byte. @param {any} a @param {any} b */
function expectSamePlanes(a, b) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  for (const f of ['rgba', 'paint', 'hit']) expect(Buffer.compare(Buffer.from(a[f]), Buffer.from(b[f])), f).toBe(0);
  if (b.clip === null) expect(a.clip).toBeNull();
  else expect(Buffer.compare(Buffer.from(a.clip), Buffer.from(b.clip)), 'clip').toBe(0);
}

describe('load and get through the inline executor', () => {
  it('a BMP is decoded and keyed per declaration, exactly as keyImage would', async () => {
    const bytes = bmp(4, 2, { 0: [255, 0, 255], 5: [255, 0, 255] });
    const vfs = await vfsOf([['key.bmp', bytes]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);

    for (const spec of [{ transparency: MAGENTA, hitKeyed: false }, { transparency: MAGENTA, hitKeyed: true }, { transparency: 'auto', hitKeyed: false }, NO_KEY]) {
      const got = await svc.load('key.bmp', /** @type {any} */ (spec));
      expect(got, JSON.stringify(spec)).not.toBeNull();
      expectSamePlanes(got, keyImage(/** @type {any} */ (decodeImage(bytes)), /** @type {any} */ (spec)));
    }
    // the semantics the planes carry: keyed pixels are not painted, and hit only for a keyed-hit element
    const off = /** @type {any} */ (await svc.load('key.bmp', { transparency: MAGENTA, hitKeyed: false }));
    const on = /** @type {any} */ (await svc.load('key.bmp', { transparency: MAGENTA, hitKeyed: true }));
    expect([bit(off.paint, 0), bit(off.hit, 0), bit(off.paint, 1)]).toEqual([0, 0, 1]);
    expect([bit(on.paint, 0), bit(on.hit, 0)]).toEqual([0, 1]);
    expect(off.rgba[3]).toBe(0);
    expect(diags).toEqual([]);
  });

  it('a PNG keeps its own alpha and the key applies on top of it', async () => {
    const png = buildPng({ width: 3, height: 1, colorType: 6, bitDepth: 8, samples: [255, 0, 255, 255, 10, 20, 30, 128, 1, 2, 3, 0] }).bytes;
    const vfs = await vfsOf([['alpha.png', png]]);
    const svc = createImageService(vfs, createInlineExecutor(), recorder().log);
    const planes = /** @type {any} */ (await svc.load('alpha.png', { transparency: MAGENTA, hitKeyed: false }));
    expect([...planes.rgba.slice(0, 12)]).toEqual([255, 0, 255, 0, 10, 20, 30, 128, 1, 2, 3, 0]);
    expect([bit(planes.paint, 0), bit(planes.paint, 1), bit(planes.paint, 2)]).toEqual([0, 1, 0]);
  });

  it('a clipping image is read from the archive and clips by its own pixels', async () => {
    const main = bmp(3, 1);
    const clip = bmp(3, 1, { 1: [0, 255, 0] });
    const vfs = await vfsOf([['face.bmp', main], ['mask.bmp', clip]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);

    const planes = /** @type {any} */ (await svc.load('face.bmp', { clipping: GREEN, clipImage: 'MASK.bmp', hitKeyed: false }));
    expect([bit(planes.clip, 0), bit(planes.clip, 1), bit(planes.clip, 2)]).toEqual([1, 0, 1]);
    expect(planes.rgba[7]).toBe(0);
    expect(diags).toEqual([]);

    // a clipping image the archive does not have clips nothing and says so once, however many specs hit it
    const a = /** @type {any} */ (await svc.load('face.bmp', { clipping: GREEN, clipImage: 'gone.bmp', hitKeyed: false }));
    await svc.load('face.bmp', { clipping: GREEN, clipImage: 'gone.bmp', hitKeyed: true });
    expect(a.clip).toBeNull();
    expect(diags.map((d) => d.code)).toEqual(['image-key-clip-image-missing']);
    expect(diags[0].file).toBe('face.bmp');
  });

  it('get() is the same planes load() delivered, and a miss starts the load', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const svc = createImageService(vfs, createInlineExecutor(), recorder().log);
    expect(svc.pending()).toBe(0);
    expect(svc.get('a.bmp', NO_KEY)).toBeNull(); // not decoded yet, and this is what starts it
    expect(svc.pending()).toBe(1);
    await until(() => svc.pending() === 0);
    const planes = svc.get('a.bmp', NO_KEY);
    expect(planes).not.toBeNull();
    expect(svc.get('A.BMP', NO_KEY)).toBe(planes); // case-folded like the VFS
    expect(await svc.load('a.bmp', NO_KEY)).toBe(planes); // a cache hit: the very object
  });

  it('pending() counts distinct loads in flight and is zero once they land', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)], ['b.bmp', bmp(2, 2, {}, 120)]]);
    const svc = createImageService(vfs, createInlineExecutor(), recorder().log);
    const p1 = svc.load('a.bmp', NO_KEY);
    const p2 = svc.load('a.bmp', NO_KEY); // joins the first
    expect(svc.pending()).toBe(1);
    const p3 = svc.load('b.bmp', NO_KEY);
    expect(svc.pending()).toBe(2);
    expect(await p1).toBe(await p2);
    await p3;
    expect(svc.pending()).toBe(0);
  });
});

describe('the cache is keyed by (sha256 of the bytes, KeySpec)', () => {
  it('two names for one file share a decode, even when asked for at the same time', async () => {
    const same = bmp(3, 3, { 4: [255, 0, 255] });
    const vfs = await vfsOf([['a.bmp', same], ['b.bmp', same.slice()], ['c.bmp', bmp(3, 3)]]);
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, recorder().log);
    const spec = { transparency: MAGENTA, hitKeyed: false };
    const [a, b] = await Promise.all([svc.load('a.bmp', spec), svc.load('b.bmp', spec)]);
    expect(exec.runs).toHaveLength(1);
    expect(a).toBe(b);
    expect(await svc.load('b.bmp', spec)).toBe(a);
    expect(exec.runs).toHaveLength(1);
    await svc.load('c.bmp', spec); // different bytes
    expect(exec.runs).toHaveLength(2);
  });

  it('a different KeySpec is a different entry; equivalent specs are one', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2, { 0: [255, 0, 255] })], ['mask.bmp', bmp(2, 2)]]);
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, recorder().log);

    const plain = await svc.load('a.bmp', NO_KEY);
    expect(await svc.load('a.bmp', /** @type {any} */ ({ transparency: undefined, clipping: null, hitKeyed: false }))).toBe(plain);
    // clipImage means nothing without a clipping key, so it does not split the entry
    expect(await svc.load('a.bmp', /** @type {any} */ ({ clipImage: 'mask.bmp', hitKeyed: false }))).toBe(plain);
    // spelling of a clipping image does not split it either
    const clipped = await svc.load('a.bmp', { clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false });
    expect(await svc.load('a.bmp', { clipping: GREEN, clipImage: 'MASK.BMP', hitKeyed: false })).toBe(clipped);
    expect(exec.runs).toHaveLength(2);

    const keyed = await svc.load('a.bmp', { transparency: MAGENTA, hitKeyed: false });
    const keyedHit = await svc.load('a.bmp', { transparency: MAGENTA, hitKeyed: true });
    expect(new Set([plain, clipped, keyed, keyedHit]).size).toBe(4);
    expect(exec.runs).toHaveLength(4);
    // numbers compare by value, whatever the caller set in the high byte
    expect(await svc.load('a.bmp', { transparency: 0xffff00ff, hitKeyed: false })).toBe(keyed);
    expect(exec.runs).toHaveLength(4);
  });

  it('the job is handed a clean KeySpec and the clipping image bytes', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)], ['mask.bmp', bmp(2, 2, { 0: [0, 255, 0] })]]);
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, recorder().log);
    await svc.load('a.bmp', /** @type {any} */ ({ transparency: MAGENTA, clipping: 'auto', clipImage: 'mask.bmp', hitKeyed: true, junk: () => 1 }));
    expect(exec.runs[0].key).toEqual({ transparency: MAGENTA, clipping: 'auto', hitKeyed: true, clipImage: 'mask.bmp' });
    expect(exec.runs[0].clipBytes).toBeInstanceOf(Uint8Array);
    expect(exec.runs[0].bytes).toBeInstanceOf(Uint8Array);
  });

  it('decoder warnings ride on the planes and are reported once per file, not once per spec', async () => {
    // a 32-bit BMP with a real alpha channel: the decoder keeps it opaque and says so
    const alpha = buildBmp({ width: 2, height: 1, bpp: 32, alpha: 'source', rgba: rgbaOf([[10, 20, 30, 128], [40, 50, 60, 200]]) }).bytes;
    const vfs = await vfsOf([['alpha.bmp', alpha]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    const first = /** @type {any} */ (await svc.load('alpha.bmp', NO_KEY));
    await svc.load('alpha.bmp', { transparency: MAGENTA, hitKeyed: false });
    expect(first.diagnostics.map((/** @type {any} */ d) => d.code)).toEqual(['image-bmp-alpha-ignored']);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'image-bmp-alpha-ignored', file: 'alpha.bmp' });
  });
});

describe('missing and undecodable images', () => {
  it('a ref the archive does not have is null with one diagnostic, from load, get and repeats', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, log);
    expect(await svc.load('nope.bmp', NO_KEY)).toBeNull();
    expect(await svc.load('nope.bmp', NO_KEY)).toBeNull();
    expect(svc.get('nope.bmp', NO_KEY)).toBeNull();
    expect(svc.raw('nope.bmp')).toBeNull();
    expect(svc.probe('nope.bmp')).toBeNull();
    expect(svc.pending()).toBe(0);
    expect(exec.runs).toHaveLength(0);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'image-missing', file: 'nope.bmp', severity: 'warn' });
  });

  it('an element with no image (an empty ref) is not a missing image', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    for (const ref of ['', '   ']) {
      expect(await svc.load(ref, NO_KEY)).toBeNull();
      expect(svc.get(ref, NO_KEY)).toBeNull();
      expect(svc.raw(ref)).toBeNull();
      expect(svc.probe(ref)).toBeNull();
    }
    expect(diags).toEqual([]);
  });

  it('a corrupt file is null with one diagnostic that carries the decoder reason, and is not retried', async () => {
    const noPixels = buildBmp({ width: 4, height: 4, bpp: 24, headerOnly: true }).bytes;
    const junk = Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6]);
    const vfs = await vfsOf([['cut.bmp', noPixels], ['junk.bmp', junk], ['text.bmp', new TextEncoder().encode('not an image at all')]]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, log);
    for (const name of ['cut.bmp', 'junk.bmp', 'text.bmp']) {
      expect(await svc.load(name, NO_KEY), name).toBeNull();
      expect(await svc.load(name, NO_KEY), name).toBeNull();
      expect(svc.get(name, NO_KEY), name).toBeNull();
    }
    expect(svc.pending()).toBe(0);
    expect(exec.runs).toHaveLength(3); // once each, never again
    expect(diags.map((d) => d.file).sort()).toEqual(['cut.bmp', 'junk.bmp', 'text.bmp']);
    const byFile = (/** @type {string} */ f) => /** @type {any} */ (diags.find((d) => d.file === f));
    expect(byFile('text.bmp').code).toBe('image-unknown-format'); // the decoder's own code, not a generic one
    expect(byFile('cut.bmp')).toMatchObject({ code: 'image-corrupt', severity: 'warn' });
    expect(byFile('cut.bmp').detail).toContain('BMP has no pixel data');
    expect(byFile('cut.bmp').detail).toContain('renders as nothing');
  });

  it('a remembered failure costs nothing on later calls: the file is not read from the archive again', async () => {
    const vfs = await vfsOf([['junk.bmp', Uint8Array.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6])]]);
    let reads = 0;
    const spied = { ...vfs, read: (/** @type {string} */ ref) => { reads++; return vfs.read(ref); } };
    const svc = createImageService(spied, createInlineExecutor(), recorder().log);
    expect(await svc.load('junk.bmp', NO_KEY)).toBeNull();
    const after = reads;
    for (let i = 0; i < 5; i++) {
      expect(await svc.load('junk.bmp', NO_KEY)).toBeNull();
      expect(svc.get('junk.bmp', NO_KEY)).toBeNull();
    }
    expect(reads).toBe(after);
    expect(svc.pending()).toBe(0);
  });

  it('an entry the archive cannot read is remembered by key: one read, one diagnostic, no load started', async () => {
    const vfs = await vfsOf([['bad.bmp', bmp(2, 2)]]);
    let reads = 0;
    // vfs.read is not memoised and inflates on the calling thread, so a null (corrupt deflate, over a cap) must not be asked again
    const spied = { ...vfs, read: (/** @type {string} */ _ref) => { reads++; return null; } };
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(spied, exec, log);

    expect(await svc.load('bad.bmp', NO_KEY)).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(svc.get('bad.bmp', NO_KEY), `get ${i}`).toBeNull();
      expect(svc.pending(), `pending after get ${i}`).toBe(0);
      await new Promise((r) => setTimeout(r, 0)); // a load started by get() would have read by now
    }
    expect(await svc.load('BAD.bmp', NO_KEY)).toBeNull();
    expect(await svc.load('bad.bmp', { transparency: MAGENTA, hitKeyed: true })).toBeNull(); // another spec, same file
    expect(svc.get('bad.bmp', { transparency: GREEN, hitKeyed: false })).toBeNull();
    expect(svc.raw('bad.bmp')).toBeNull();
    expect(reads).toBe(1);
    expect(svc.pending()).toBe(0);
    expect(exec.runs).toHaveLength(0);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'image-unreadable', file: 'bad.bmp', severity: 'warn' });
  });

  it('a clipping image the archive cannot read is not read again for the next spec', async () => {
    const vfs = await vfsOf([['face.bmp', bmp(3, 1)], ['mask.bmp', bmp(3, 1)]]);
    let maskReads = 0;
    const spied = { ...vfs, read: (/** @type {string} */ ref) => { if (ref === 'mask.bmp') { maskReads++; return null; } return vfs.read(ref); } };
    const { log, diags } = recorder();
    const svc = createImageService(spied, createInlineExecutor(), log);
    for (const transparency of [null, MAGENTA, GREEN]) {
      const planes = /** @type {any} */ (await svc.load('face.bmp', { transparency, clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false }));
      expect(planes, String(transparency)).not.toBeNull();
      expect(planes.clip).toBeNull(); // the clipping image counts as not supplied
    }
    expect(maskReads).toBe(1);
    expect(diags.filter((d) => d.code === 'image-unreadable').map((d) => d.file)).toEqual(['mask.bmp']);
    expect(diags.some((d) => d.code === 'image-key-clip-image-missing')).toBe(true);
  });

  it('the unreadable memory is bounded: past 4096 names the oldest is forgotten and read again', async () => {
    const CAP = 4096; // MAX_MISSING in service.js
    const names = Array.from({ length: CAP + 1 }, (_, i) => `u${i}.bmp`);
    // the default archive cap is 4096 entries, so the bound only bites with a raised cap; it is the set's own limit
    const zip = buildZip(names.map((name) => ({ name, data: Uint8Array.of(1) })));
    const vfs = await openVfs(zip, 'test.zip', { ...DEFAULT_ZIP_CAPS, maxEntries: CAP * 2 });
    /** @type {Map<string, number>} */
    const reads = new Map();
    const spied = { ...vfs, read: (/** @type {string} */ ref) => { reads.set(ref, (reads.get(ref) ?? 0) + 1); return null; } };
    const svc = createImageService(spied, createInlineExecutor(), recorder().log);
    for (const n of names) await svc.load(n, NO_KEY);
    expect(reads.get('u0.bmp')).toBe(1);
    await svc.load(`u${CAP}.bmp`, NO_KEY); // the newest is still remembered
    expect(reads.get(`u${CAP}.bmp`)).toBe(1);
    await svc.load('u0.bmp', NO_KEY); // the oldest was evicted by the 4097th
    expect(reads.get('u0.bmp')).toBe(2);
  });

  it('a decode that succeeds with a warning keeps its image and reports the warning once', async () => {
    const cut = buildBmp({ width: 8, height: 8, bpp: 8, compression: 'rle8', truncateRle: 10 }).bytes;
    const vfs = await vfsOf([['rle.bmp', cut]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    expect(await svc.load('rle.bmp', NO_KEY)).not.toBeNull();
    expect(await svc.load('rle.bmp', { transparency: MAGENTA, hitKeyed: false })).not.toBeNull();
    expect(diags.map((d) => [d.code, d.file])).toEqual([['image-bmp-rle-truncated', 'rle.bmp']]);
  });

  it('an image over the axis cap is a missing image; probe agrees', async () => {
    const huge = buildBmp({ width: 2, height: 2, bpp: 24, declare: { width: 20000, height: 2 } }).bytes;
    const vfs = await vfsOf([['huge.bmp', huge]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    expect(svc.probe('huge.bmp')).toBeNull();
    expect(await svc.load('huge.bmp', NO_KEY)).toBeNull();
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe('huge.bmp');
  });

  it('an executor that rejects is a missing image, not a rejected load', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, { run: () => Promise.reject(new Error('boom')) }, log);
    expect(await svc.load('a.bmp', NO_KEY)).toBeNull();
    expect(svc.pending()).toBe(0);
    expect(diags).toHaveLength(1);
    expect(diags[0].detail).toContain('boom');
  });

  it('an executor that resolves null without a reason still gives one generic diagnostic', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, { run: async () => null }, log);
    expect(await svc.load('a.bmp', NO_KEY)).toBeNull();
    expect(await svc.load('a.bmp', { transparency: MAGENTA, hitKeyed: false })).toBeNull();
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'image-decode-failed', file: 'a.bmp' });
  });
});

describe('old pixels until new ones land', () => {
  it('get() keeps returning the last planes of a file while a replacement KeySpec is pending', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 1, { 0: [255, 0, 255] })]]);
    const exec = manualExecutor();
    const svc = createImageService(vfs, exec, recorder().log);
    const specA = { hitKeyed: false };
    const specB = { transparency: MAGENTA, hitKeyed: false };

    const first = svc.load('a.bmp', specA);
    await until(() => exec.runs.length === 1);
    expect(svc.get('a.bmp', specA)).toBeNull(); // nothing delivered yet
    exec.release();
    const A = /** @type {any} */ (await first);
    expect(A.rgba[3]).toBe(255);
    expect(svc.get('a.bmp', specA)).toBe(A);

    // a script changes transparencyColor: the replacement is pending, and the old planes stay up
    expect(svc.get('a.bmp', specB)).toBe(A);
    expect(svc.pending()).toBe(1);
    await until(() => exec.runs.length === 2);
    expect(svc.get('a.bmp', specB)).toBe(A); // still pending, still the old planes
    expect(svc.pending()).toBe(1);
    exec.release();
    await until(() => svc.pending() === 0);
    const B = /** @type {any} */ (svc.get('a.bmp', specB));
    expect(B).not.toBe(A);
    expect(B.rgba[3]).toBe(0); // the new key landed
    expect(svc.get('a.bmp', specA)).toBe(A); // and the old spec is still cached
    expect(exec.runs).toHaveLength(2); // none of those gets started a third job
  });

  it('a replacement that fails leaves a missing image, not the old pixels forever', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const exec = manualExecutor();
    const { log, diags } = recorder();
    const svc = createImageService(vfs, exec, log);
    const p = svc.load('a.bmp', NO_KEY);
    await until(() => exec.runs.length === 1);
    exec.release();
    const A = await p;
    const spec = { transparency: 0x123456, hitKeyed: false };
    exec.failNext = true;
    expect(svc.get('a.bmp', spec)).toBe(A);
    await until(() => exec.runs.length === 2);
    exec.release();
    await until(() => svc.pending() === 0);
    expect(svc.get('a.bmp', spec)).toBeNull();
    expect(diags.map((d) => d.code)).toEqual(['image-test-failure']);
    expect(svc.get('a.bmp', NO_KEY)).toBe(A); // the file itself is fine
  });
});

describe('raw() map images', () => {
  it('returns the unkeyed RGBA, synchronously, and caches it', async () => {
    const vfs = await vfsOf([['map.bmp', bmp(2, 2, { 0: [255, 0, 255], 3: [0, 255, 0] })]]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, log);
    const img = /** @type {any} */ (svc.raw('map.bmp')); // no load first
    expect(img).not.toBeNull();
    expect([img.width, img.height]).toEqual([2, 2]);
    expect([...img.data.slice(0, 4)]).toEqual([255, 0, 255, 255]); // magenta survives, alpha 255
    expect([...img.data.slice(12, 16)]).toEqual([0, 255, 0, 255]);
    expect(svc.raw('MAP.bmp')).toBe(img);
    expect(svc.pending()).toBe(0);
    expect(exec.runs).toHaveLength(0); // inline: map images are small and `raw` is sync
    // the same file keyed is a different thing
    const keyed = /** @type {any} */ (await svc.load('map.bmp', { transparency: MAGENTA, hitKeyed: false }));
    expect(keyed.rgba[3]).toBe(0);
    expect(svc.raw('map.bmp')).toBe(img);
    expect(img.data[3]).toBe(255);
    expect(diags).toEqual([]);
  });

  it('is null with one diagnostic for a missing or undecodable file', async () => {
    const vfs = await vfsOf([['text.bmp', new TextEncoder().encode('nope')]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    expect(svc.raw('gone.bmp')).toBeNull();
    expect(svc.raw('gone.bmp')).toBeNull();
    expect(svc.raw('text.bmp')).toBeNull();
    expect(svc.raw('text.bmp')).toBeNull();
    expect(diags.map((d) => [d.code, d.file])).toEqual([['image-missing', 'gone.bmp'], ['image-unknown-format', 'text.bmp']]);
  });

  it('keeps only pixels of an animated or indexed image', async () => {
    const vfs = await vfsOf([['p.bmp', buildBmp({ width: 2, height: 2, bpp: 8 }).bytes]]);
    const svc = createImageService(vfs, createInlineExecutor(), recorder().log);
    expect(Object.keys(/** @type {any} */ (svc.raw('p.bmp'))).sort()).toEqual(['data', 'height', 'width']);
  });
});

describe('probe()', () => {
  it('gives the header size, reads each file once, and is silent about problems', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(5, 3)], ['t.bmp', new TextEncoder().encode('text')]]);
    let reads = 0;
    const spied = { ...vfs, read: (/** @type {string} */ ref) => { reads++; return vfs.read(ref); } };
    const { log, diags } = recorder();
    const svc = createImageService(spied, createInlineExecutor(), log);
    expect(svc.probe('a.bmp')).toEqual({ format: 'bmp', width: 5, height: 3 });
    expect(svc.probe('A.BMP')).toEqual({ format: 'bmp', width: 5, height: 3 });
    expect(reads).toBe(1);
    expect(svc.probe('t.bmp')).toBeNull();
    expect(svc.probe('t.bmp')).toBeNull();
    expect(reads).toBe(2);
    expect(svc.probe('missing.bmp')).toBeNull();
    expect(diags).toEqual([]);
  });
});

describe('the LRU (256 MiB per skin session)', () => {
  it('has the contracted cap', async () => {
    expect(MAX_LIVE_BYTES).toBe(256 * 1024 * 1024);
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const svc = /** @type {any} */ (createImageService(vfs, createInlineExecutor(), recorder().log));
    expect(svc.stats()).toEqual({ liveBytes: 0, entries: 0, maxBytes: 256 * 1024 * 1024 });
  });

  // 8 x 8: rgba 256 + paint 8 + hit 8, no clip plane
  const BYTES = 272;
  const files = /** @type {Array<[string, Uint8Array]>} */ ([['a.bmp', bmp(8, 8, {}, 10)], ['b.bmp', bmp(8, 8, {}, 20)], ['c.bmp', bmp(8, 8, {}, 30)]]);

  it('evicts the least recently used past the cap', async () => {
    const vfs = await vfsOf(files);
    const svc = createImageServiceWithOptions(vfs, createInlineExecutor(), recorder().log, { maxBytes: BYTES * 2 + 100 });
    const a = await svc.load('a.bmp', NO_KEY);
    const b = await svc.load('b.bmp', NO_KEY);
    expect(svc.stats()).toMatchObject({ liveBytes: BYTES * 2, entries: 2 });
    expect(svc.get('a.bmp', NO_KEY)).toBe(a); // touching a makes b the oldest
    const c = await svc.load('c.bmp', NO_KEY);
    expect(svc.stats()).toMatchObject({ liveBytes: BYTES * 2, entries: 2 });
    expect(svc.get('a.bmp', NO_KEY)).toBe(a);
    expect(svc.get('c.bmp', NO_KEY)).toBe(c);
    expect(svc.pending()).toBe(0);
    // b was the victim: it is gone, and asking for it starts a decode and shows nothing in the meantime
    expect(svc.get('b.bmp', NO_KEY)).toBeNull();
    expect(svc.pending()).toBe(1);
    await until(() => svc.pending() === 0);
    const b2 = svc.get('b.bmp', NO_KEY);
    expect(b2).not.toBeNull();
    expect(b2).not.toBe(b);
    expectSamePlanes(b2, b); // a re-decode is the same pixels
    expect(svc.stats()).toMatchObject({ liveBytes: BYTES * 2, entries: 2 });
  });

  it('counts the clip plane and raw map images, and keeps one image that is over the cap by itself', async () => {
    const vfs = await vfsOf([...files, ['mask.bmp', bmp(8, 8, { 0: [0, 255, 0] })]]);
    const svc = createImageServiceWithOptions(vfs, createInlineExecutor(), recorder().log, { maxBytes: 10 });
    const planes = /** @type {any} */ (await svc.load('a.bmp', { clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false }));
    expect(planes.clip).not.toBeNull();
    expect(svc.stats()).toMatchObject({ liveBytes: BYTES + 8, entries: 1 }); // rgba + paint + hit + clip
    expect(svc.get('a.bmp', { clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false })).toBe(planes);
    const raw = /** @type {any} */ (svc.raw('b.bmp'));
    expect(raw.data.byteLength).toBe(256);
    // the raw image displaced the planes: the newest entry is never the victim
    expect(svc.stats()).toMatchObject({ liveBytes: 256, entries: 1 });
    expect(svc.raw('b.bmp')).toBe(raw);
  });

  it('never evicts the failures it remembers, which hold no pixels', async () => {
    const vfs = await vfsOf([['junk.bmp', Uint8Array.from([0x42, 0x4d, 1, 2])], ...files]);
    const exec = countingExecutor();
    const svc = createImageServiceWithOptions(vfs, exec, recorder().log, { maxBytes: BYTES });
    expect(await svc.load('junk.bmp', NO_KEY)).toBeNull();
    await svc.load('a.bmp', NO_KEY);
    await svc.load('b.bmp', NO_KEY);
    await svc.load('c.bmp', NO_KEY);
    expect(await svc.load('junk.bmp', NO_KEY)).toBeNull();
    expect(exec.runs.filter((j) => j.bytes.length === 4)).toHaveLength(1);
  });
});

describe('res:// images (wmploc 5.5)', () => {
  /** @param {string[]} extra */
  const setup = async (...extra) => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)], ...extra.map((n) => /** @type {[string, Uint8Array]} */ ([n, bmp(1, 1)]))]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    return { svc: createImageService(vfs, exec, log), diags, exec };
  };

  it.each([
    ['res://wmploc/RT_IMAGE/#1770', 32, 15, 'gif'],
    ['res://wmploc/RT_IMAGE/#2030', 30, 13, 'gif'],
    ['res://wmploc/RT_IMAGE/#2024', 32, 15, 'gif'],
    ['res://wmploc.dll/RT_BITMAP/#373', 29, 29, 'bmp'],
    ['res://wmploc.dll/RT_BITMAP/#427', 29, 29, 'bmp'],
    ['res://wmploc.dll/RT_BITMAP/#521', 200, 200, 'bmp'],
    ['res://wmploc.dll/RT_IMAGE/#521', 200, 200, 'bmp'], // a PNG in WMP 11
    ['res://-/#1792', 58, 15, 'bmp'],
    ['res://-/#520', 75, 75, 'bmp'],
    ['RES://WMPLOC/#1771', 32, 15, 'gif'],
  ])('%s is a transparent %ix%i image with one diagnostic', async (url, w, h, format) => {
    const { svc, diags, exec } = await setup();
    const spec = { transparency: MAGENTA, hitKeyed: false };
    expect(svc.probe(url)).toEqual({ format, width: w, height: h });
    const planes = /** @type {any} */ (await svc.load(url, spec));
    expect([planes.width, planes.height]).toEqual([w, h]);
    expect(planes.rgba).toHaveLength(w * h * 4);
    expect(planes.rgba.every((/** @type {number} */ v) => v === 0)).toBe(true);
    expect(popcount(planes.paint, planes.paint.length * 8)).toBe(0);
    expect(popcount(planes.hit, planes.hit.length * 8)).toBe(0);
    expect(planes.clip).toBeNull();
    expect(svc.get(url, spec)).toBe(planes);
    const raw = /** @type {any} */ (svc.raw(url));
    expect([raw.width, raw.height, raw.data.length]).toEqual([w, h, w * h * 4]);
    expect(svc.pending()).toBe(0);
    expect(exec.runs).toHaveLength(0); // never decoded, never read from the archive
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'unresolved-res', severity: 'info', file: url });
  });

  it('a keyed-hit element takes clicks across the placeholder, with no stray bits past the last pixel', async () => {
    const { svc } = await setup();
    const planes = /** @type {any} */ (await svc.load('res://wmploc/RT_IMAGE/#2030', { hitKeyed: true })); // 30 x 13 = 390 px
    expect(popcount(planes.hit, 390)).toBe(390);
    expect(popcount(planes.hit, planes.hit.length * 8)).toBe(390);
    expect(popcount(planes.paint, planes.paint.length * 8)).toBe(0);
  });

  it.each([
    ['res://wmploc/RT_STRING/#2063'],
    ['res://wmploc/RT_TEXT/#132'],
    ['res://wmploc/RT_IMAGE/#373'], // a bitmap id under the image type
    ['res://wmploc/RT_BITMAP/#1770'],
    ['res://wmploc/RT_BITMAP/#290'], // not in either DLL
    ['res://wmploc/#1685'],
    ['res://other.dll/RT_IMAGE/#1770'],
    ['res://wmploc/RT_IMAGE/1770'],
    ['res://'],
  ])('%s is a missing image with one diagnostic and never reaches the archive', async (url) => {
    const { svc, diags, exec } = await setup();
    expect(svc.probe(url)).toBeNull();
    expect(await svc.load(url, NO_KEY)).toBeNull();
    expect(svc.get(url, NO_KEY)).toBeNull();
    expect(svc.raw(url)).toBeNull();
    expect(exec.runs).toHaveLength(0);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'unresolved-res', severity: 'warn' });
  });

  it('a res:// clipping image never reaches the archive, even when an entry is named like its basename', async () => {
    // the VFS folds a ref to its basename, so a skin entry `#1770` is what resolve() would hand back
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)], ['#1770', bmp(2, 2, { 0: [0, 255, 0] })]]);
    expect(vfs.resolve('res://wmploc/RT_IMAGE/#1770')).toBe('#1770'); // the trap is armed
    /** @type {string[]} */
    const asked = [];
    const spied = { ...vfs, resolve: (/** @type {string} */ ref) => { asked.push(ref); return vfs.resolve(ref); } };
    const { log, diags } = recorder();
    const svc = createImageService(spied, createInlineExecutor(), log);
    const spec = { clipping: GREEN, clipImage: 'res://wmploc/RT_IMAGE/#1770', hitKeyed: false };

    const planes = /** @type {any} */ (await svc.load('a.bmp', spec));
    expect(planes).not.toBeNull();
    expect(planes.clip).toBeNull(); // the clipping image is treated as missing, so nothing is clipped
    expect(svc.get('a.bmp', spec)).toBe(planes);
    expect(asked.filter((r) => /^\s*res:\/\//i.test(r))).toEqual([]);
    expect(asked).toContain('a.bmp'); // the spy does see the lookups that are allowed
    expect(diags.map((d) => d.code)).toEqual(['image-key-clip-image-missing']);
  });

  it('one diagnostic per distinct url', async () => {
    const { svc, diags } = await setup();
    for (const url of ['res://wmploc/RT_IMAGE/#1770', 'res://wmploc/RT_IMAGE/#1771', 'res://wmploc/RT_IMAGE/#1770']) await svc.load(url, NO_KEY);
    expect(diags).toHaveLength(2);
  });
});

describe('lookups keyed by skin strings are maps', () => {
  const bmpBytes = bmp(2, 1, { 0: [255, 0, 255] });
  const pngBytes = buildPng({ width: 1, height: 2, colorType: 6, bitDepth: 8, samples: [1, 2, 3, 255, 4, 5, 6, 255] }).bytes;

  it('entries named `__proto__` and `constructor` load, get, probe and raw like any other', async () => {
    const vfs = await vfsOf([['__proto__', bmpBytes], ['constructor', pngBytes]]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, log);
    const spec = { transparency: MAGENTA, hitKeyed: false };

    expect(svc.probe('__proto__')).toEqual({ format: 'bmp', width: 2, height: 1 });
    expect(svc.probe('constructor')).toEqual({ format: 'png', width: 1, height: 2 });
    const p = /** @type {any} */ (await svc.load('__proto__', spec));
    const c = /** @type {any} */ (await svc.load('constructor', spec));
    expect([p.width, p.height]).toEqual([2, 1]);
    expect([c.width, c.height]).toEqual([1, 2]);
    expect(p.rgba[3]).toBe(0); // magenta keyed
    expect(svc.get('__PROTO__', spec)).toBe(p);
    expect(svc.get('dir\\constructor', spec)).toBe(c);
    expect(/** @type {any} */ (svc.raw('__proto__')).width).toBe(2);
    expect(/** @type {any} */ (svc.raw('constructor')).height).toBe(2);
    expect(exec.runs).toHaveLength(2);
    expect(diags).toEqual([]);
  });

  it('names no entry has are plain missing images, never an inherited member', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const exec = countingExecutor();
    const svc = createImageService(vfs, exec, log);
    const names = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__'];
    for (const n of names) {
      expect(svc.probe(n), n).toBeNull();
      expect(await svc.load(n, NO_KEY), n).toBeNull();
      expect(svc.get(n, NO_KEY), n).toBeNull();
      expect(svc.raw(n), n).toBeNull();
    }
    expect(exec.runs).toHaveLength(0);
    expect(svc.pending()).toBe(0);
    expect(diags.map((d) => d.file).sort()).toEqual([...names].sort());
    // and a real file still works afterwards
    expect(await svc.load('a.bmp', NO_KEY)).not.toBeNull();
  });

  it('a clipping image named `__proto__` is found by name', async () => {
    const vfs = await vfsOf([['face.bmp', bmp(2, 1)], ['__proto__', bmp(2, 1, { 1: [0, 255, 0] })]]);
    const svc = createImageService(vfs, createInlineExecutor(), recorder().log);
    const planes = /** @type {any} */ (await svc.load('face.bmp', { clipping: GREEN, clipImage: '__proto__', hitKeyed: false }));
    expect([bit(planes.clip, 0), bit(planes.clip, 1)]).toEqual([1, 0]);
  });
});

describe('diagnostics are bounded', () => {
  it('a script cycling through missing names cannot grow the log without limit', async () => {
    const vfs = await vfsOf([['a.bmp', bmp(2, 2)]]);
    const { log, diags } = recorder();
    const svc = createImageService(vfs, createInlineExecutor(), log);
    for (let i = 0; i < 3000; i++) svc.get(`x${i}.bmp`, NO_KEY);
    expect(diags.length).toBeLessThanOrEqual(1025);
    expect(diags.at(-1)?.code).toBe('image-diagnostics-capped');
    // a hostile ref is echoed shortened
    svc.get('y'.repeat(100_000), NO_KEY);
    expect(diags.every((d) => d.detail.length < 1000)).toBe(true);
  });
});

describe('the inline executor', () => {
  it('resolves asynchronously with the planes, and records why a job came back empty', async () => {
    const exec = createInlineExecutor();
    const bytes = bmp(2, 2, { 0: [255, 0, 255] });
    const job = { bytes, key: { transparency: MAGENTA, hitKeyed: false } };
    const pending = exec.run(job);
    expect(pending).toBeInstanceOf(Promise);
    const planes = /** @type {any} */ (await pending);
    expect(planes.rgba[3]).toBe(0);
    expect(decodeFailures.has(job)).toBe(false);

    const bad = { bytes: new TextEncoder().encode('nope'), key: { hitKeyed: false } };
    expect(await exec.run(bad)).toBeNull();
    expect(decodeFailures.get(bad)?.[0].code).toBe('image-unknown-format');
  });
});
