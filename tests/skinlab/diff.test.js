import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  andMask,
  andNotMask,
  components,
  decodePng,
  diffImages,
  diffMasks,
  encodePng,
  getBit,
  judge,
  maskBBox,
  maskBytes,
  maskEquals,
  newMask,
  orMask,
  pixelsEqual,
  popcount,
  rectMask,
  renderDiff,
  reportOf,
  setBit,
  writeOutputs,
  xorMask,
} from '../../tools/skinlab/diff.mjs';
import { buildPng } from '../support/png-writer.js';

// ---- helpers: synthetic images only, nothing derived from skin art ------------------------------------------

/** A w x h image whose pixel (x, y) is fn(x, y) = [r, g, b, a]. */
function image(w, h, fn = (x, y) => [(x * 7) & 255, (y * 13) & 255, ((x + y) * 3) & 255, 255]) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const clone = (img) => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });
function poke(img, x, y, rgba) {
  img.data.set(rgba, (y * img.width + x) * 4);
  return img;
}
const entry = (id, mask, extra = {}) => ({ id, kind: 'pixel', mask, bound: 1000, ...extra });
const maskOf = (w, h, points) => {
  const m = newMask(w, h);
  for (const [x, y] of points) setBit(m, y * w + x);
  return m;
};

describe('bit masks', () => {
  it('count, combine and compare bits in the oracle layout (LSB first, row-major)', () => {
    const a = maskOf(10, 3, [[0, 0], [9, 2]]);
    expect(a.length).toBe(maskBytes(10, 3));
    expect(a[0]).toBe(0b1);
    expect(getBit(a, 29)).toBe(1);
    expect(popcount(a)).toBe(2);
    const b = maskOf(10, 3, [[9, 2], [4, 1]]);
    expect(popcount(xorMask(a, b))).toBe(2);
    expect(popcount(andMask(a, b))).toBe(1);
    expect(popcount(orMask(a, b))).toBe(3);
    expect(popcount(andNotMask(a, b))).toBe(1);
    expect(maskEquals(a, a.slice())).toBe(true);
    expect(maskEquals(a, b)).toBe(false);
    expect(() => xorMask(a, new Uint8Array(1))).toThrow(/differ in size/);
  });

  it('rectMask is half-open, clipped to the mask, and maskBBox is inclusive', () => {
    const m = rectMask(20, 10, [2, 3, 6, 5]);
    expect(popcount(m)).toBe(4 * 2);
    expect(maskBBox(m, 20, 10)).toEqual({ x0: 2, y0: 3, x1: 5, y1: 4 });
    expect(popcount(rectMask(20, 10, [-5, -5, 3, 2]))).toBe(3 * 2);
    expect(popcount(rectMask(20, 10, [18, 8, 99, 99]))).toBe(2 * 2);
    expect(popcount(rectMask(20, 10, [30, 0, 40, 5]))).toBe(0);
    expect(maskBBox(newMask(20, 10), 20, 10)).toBeNull();
  });

  it('components are 8-connected bounding boxes in scan order, with a cap that says it truncated', () => {
    const m = maskOf(12, 8, [[1, 1], [2, 2], [3, 1], [8, 5], [9, 5], [11, 0]]);
    const { components: c, total, truncated } = components(m, 12, 8);
    expect(total).toBe(3); // the diagonal chain is one component, the pair another, the corner a third
    expect(truncated).toBe(false);
    expect(c[0]).toEqual({ x0: 11, y0: 0, x1: 11, y1: 0, count: 1 }); // first pixel in scan order: row 0
    expect(c[1]).toEqual({ x0: 1, y0: 1, x1: 3, y1: 2, count: 3 });
    expect(c[2]).toEqual({ x0: 8, y0: 5, x1: 9, y1: 5, count: 2 });
    const capped = components(m, 12, 8, 2);
    expect(capped.components).toHaveLength(2);
    expect(capped).toMatchObject({ total: 3, truncated: true });
  });

  it('survives a checkerboard and a full plane without recursion', () => {
    const w = 400;
    const h = 300;
    const full = rectMask(w, h, [0, 0, w, h]);
    expect(components(full, w, h).components).toEqual([{ x0: 0, y0: 0, x1: w - 1, y1: h - 1, count: w * h }]);
    const board = newMask(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + y) % 2 === 0) setBit(board, y * w + x);
    expect(components(board, w, h, 1).total).toBe(1); // diagonals join: one big component
    const dots = newMask(w, h);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) setBit(dots, y * w + x);
    expect(components(dots, w, h, 5)).toMatchObject({ total: (w / 2) * (h / 2), truncated: true });
  });
});

describe('pixel equality', () => {
  it('is premultiplied: every alpha-0 pixel equals every other, whatever colour lies under it', () => {
    const a = image(2, 1, () => [255, 0, 0, 0]);
    const b = image(2, 1, () => [0, 255, 17, 0]);
    expect(pixelsEqual(a.data, b.data, 0)).toBe(true);
    expect(diffImages(a, b).differingSkinPx).toBe(0);
  });

  it('is exact otherwise: one level of one channel, or one level of alpha, differs', () => {
    const a = image(3, 1, () => [10, 20, 30, 255]);
    const b = clone(a);
    poke(b, 1, 0, [10, 20, 31, 255]);
    poke(b, 2, 0, [10, 20, 30, 254]);
    expect(pixelsEqual(a.data, b.data, 0)).toBe(true);
    expect(pixelsEqual(a.data, b.data, 1)).toBe(false);
    expect(pixelsEqual(a.data, b.data, 2)).toBe(false);
    // transparent against opaque is a difference even when the RGB matches
    expect(pixelsEqual(new Uint8Array([1, 2, 3, 0]), new Uint8Array([1, 2, 3, 255]), 0)).toBe(false);
  });
});

describe('diffImages', () => {
  const W = 40;
  const H = 30;

  it('an image against itself differs nowhere and passes', () => {
    const a = image(W, H);
    const r = diffImages(a, clone(a));
    expect(r).toMatchObject({ differingSkinPx: 0, differingDevicePx: 0, unabsorbedSkinPx: 0, absorbedSkinPx: 0, componentCount: 0, bbox: null });
    expect(judge(r)).toEqual({ pass: true, failures: [] });
  });

  it('absorbs a one-pixel change inside an allow-listed rect and counts it; outside it fails', () => {
    const a = image(W, H);
    const inside = clone(a);
    poke(inside, 12, 11, [1, 2, 3, 255]);
    const rect = entry('rect', rectMask(W, H, [10, 10, 20, 15]), { bound: 50 });
    const r = diffImages(a, inside, { entries: [rect] });
    expect(r).toMatchObject({ differingSkinPx: 1, absorbedSkinPx: 1, unabsorbedSkinPx: 0 });
    expect(r.entries[0]).toMatchObject({ id: 'rect', count: 1, bound: 50, status: 'ok', unused: false });
    expect(judge(r).pass).toBe(true);

    const outside = clone(a);
    poke(outside, 30, 25, [1, 2, 3, 255]);
    const bad = diffImages(a, outside, { entries: [rect] });
    expect(bad).toMatchObject({ differingSkinPx: 1, absorbedSkinPx: 0, unabsorbedSkinPx: 1, bbox: { x0: 30, y0: 25, x1: 30, y1: 25 } });
    expect(bad.components).toEqual([{ x0: 30, y0: 25, x1: 30, y1: 25, count: 1 }]);
    const verdict = judge(bad);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures[0]).toMatch(/1 pixel differ outside every allowed region/);
    // the edge of a half-open rect: x1 and y1 are outside
    const edge = clone(a);
    poke(edge, 20, 14, [1, 2, 3, 255]);
    expect(diffImages(a, edge, { entries: [rect] }).unabsorbedSkinPx).toBe(1);
    poke(edge, 20, 14, [...a.data.subarray((14 * W + 20) * 4, (14 * W + 20) * 4 + 4)]);
    poke(edge, 19, 14, [1, 2, 3, 255]);
    expect(diffImages(a, edge, { entries: [rect] }).unabsorbedSkinPx).toBe(0);
  });

  it('a bound of 0 with one absorbed pixel fails (the drift guard)', () => {
    const a = image(W, H);
    const b = poke(clone(a), 5, 5, [9, 9, 9, 255]);
    const sliders = entry('U-10-slider-travel', rectMask(W, H, [0, 0, 10, 10]), { bound: 0 });
    const r = diffImages(a, b, { entries: [sliders] });
    expect(r.unabsorbedSkinPx).toBe(0); // the pixel is inside the region ...
    expect(r.entries[0]).toMatchObject({ count: 1, bound: 0, status: 'over-bound' });
    const v = judge(r);
    expect(v.pass).toBe(false); // ... and the bound still fails it
    expect(v.failures).toEqual(['U-10-slider-travel absorbed 1, over its bound of 0']);
  });

  it('reports an entry that absorbed nothing, except a bound of 0 where nothing is the goal', () => {
    const a = image(W, H);
    const b = poke(clone(a), 5, 5, [9, 9, 9, 255]);
    const stale = entry('stale', rectMask(W, H, [30, 20, 35, 25]), { bound: 10 });
    const zero = entry('zero', rectMask(W, H, [30, 20, 35, 25]), { bound: 0 });
    const live = entry('live', rectMask(W, H, [0, 0, 10, 10]), { bound: 10 });
    const r = diffImages(a, b, { entries: [stale, zero, live] });
    expect(r.unusedEntries).toEqual(['stale']);
    expect(r.entries.find((e) => e.id === 'zero')).toMatchObject({ count: 0, status: 'ok', unused: false });
    expect(judge(r).pass).toBe(true); // reported, never a failure on its own
  });

  it('a null bound is measure mode: it passes and reports the count, and strict refuses it', () => {
    const a = image(W, H);
    const b = poke(poke(clone(a), 1, 1, [9, 9, 9, 255]), 2, 1, [9, 9, 9, 255]);
    const r = diffImages(a, b, { entries: [entry('U-23', rectMask(W, H, [0, 0, 5, 5]), { bound: null })] });
    expect(r.entries[0]).toMatchObject({ count: 2, bound: null, status: 'measure' });
    expect(judge(r).pass).toBe(true);
    const strict = judge(r, { strict: true });
    expect(strict.pass).toBe(false);
    expect(strict.failures[0]).toMatch(/U-23 has a null bound \(measure mode\): 2 measured/);
  });

  it('an exclusion is not compared, and an exact one must be exactly its bound and its region', () => {
    const a = image(W, H);
    const b = poke(poke(clone(a), 5, 5, [9, 9, 9, 255]), 30, 20, [9, 9, 9, 255]);
    const hole = rectMask(W, H, [0, 0, 10, 10]);
    const r = diffImages(a, b, { entries: [{ id: 'hole', kind: 'pixel-exclusion', mask: hole, bound: 100, exact: true }] });
    expect(r).toMatchObject({ excludedSkinPx: 100, comparedSkinPx: W * H - 100, differingSkinPx: 1, unabsorbedSkinPx: 1 });
    expect(r.entries[0]).toMatchObject({ id: 'hole', count: 100, regionSize: 100, status: 'ok' });
    const wrong = diffImages(a, b, { entries: [{ id: 'hole', kind: 'pixel-exclusion', mask: hole, bound: 99, exact: true }] });
    expect(wrong.entries[0].status).toBe('not-exact');
    expect(judge(wrong).failures).toContain('hole must be exactly 99 (region 100), got 100');
  });

  it('a pixel in two entries counts for both and is absorbed once', () => {
    const a = image(W, H);
    const b = poke(clone(a), 5, 5, [9, 9, 9, 255]);
    const r = diffImages(a, b, { entries: [entry('one', rectMask(W, H, [0, 0, 10, 10])), entry('two', rectMask(W, H, [4, 4, 8, 8]))] });
    expect(r.entries.map((e) => e.count)).toEqual([1, 1]);
    expect(r).toMatchObject({ differingSkinPx: 1, absorbedSkinPx: 1, unabsorbedSkinPx: 0 });
  });

  it('ignores mask-kind entries (they belong to diffMasks)', () => {
    const a = image(W, H);
    const r = diffImages(a, clone(a), { entries: [{ id: 'm', kind: 'mask', mask: newMask(3, 3), bound: 0 }] });
    expect(r.entries).toEqual([]);
  });

  it('counts in skin px at DPR 2: a skin pixel differs once however many of its four device pixels do', () => {
    const w = 20;
    const h = 10;
    const a = image(w * 2, h * 2);
    const b = clone(a);
    // all four device pixels of skin pixel (3, 2), and one device pixel of skin pixel (7, 6)
    for (const [x, y] of [[6, 4], [7, 4], [6, 5], [7, 5], [15, 12]]) poke(b, x, y, [1, 2, 3, 255]);
    const r = diffImages(a, b, { dpr: 2, entries: [entry('e', rectMask(w, h, [0, 0, 5, 5]), { bound: 1 })] });
    expect(r).toMatchObject({ differingDevicePx: 5, differingSkinPx: 2, absorbedSkinPx: 1, unabsorbedSkinPx: 1, skinWidth: w, skinHeight: h });
    expect(r.entries[0]).toMatchObject({ count: 1, status: 'ok' });
    expect(r.bbox).toEqual({ x0: 7, y0: 6, x1: 7, y1: 6 });
  });

  it('upscales an exclusion at DPR 2: the whole block of device pixels is skipped', () => {
    const w = 8;
    const h = 8;
    const a = image(w * 2, h * 2);
    const b = clone(a);
    poke(b, 5, 5, [1, 2, 3, 255]); // device (5,5) is skin (2,2)
    const r = diffImages(a, b, { dpr: 2, entries: [{ id: 'hole', kind: 'pixel-exclusion', mask: rectMask(w, h, [2, 2, 3, 3]), bound: 1 }] });
    expect(r).toMatchObject({ differingDevicePx: 0, differingSkinPx: 0, excludedSkinPx: 1 });
  });

  it('refuses images of different sizes, a bad dpr, or masks of the wrong size', () => {
    expect(() => diffImages(image(4, 4), image(4, 5))).toThrow(/differ in size/);
    expect(() => diffImages(image(5, 4), image(5, 4), { dpr: 2 })).toThrow(/whole number of skin px/);
    expect(() => diffImages(image(4, 4), image(4, 4), { dpr: 0 })).toThrow(/positive integer/);
    expect(() => diffImages(image(4, 4), image(4, 4), { entries: [entry('x', newMask(9, 9))] })).toThrow(/entry x: mask is/);
  });

  it('reportOf drops the bit planes and stays JSON', () => {
    const a = image(W, H);
    const r = diffImages(a, poke(clone(a), 1, 1, [0, 0, 0, 255]));
    const report = reportOf(r);
    expect(report.planes).toBeUndefined();
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe('diffMasks', () => {
  const W = 30;
  const H = 12;

  it('XORs two masks and shows the bounding box and components of what no entry covers', () => {
    const a = maskOf(W, H, [[1, 1], [2, 2], [20, 8]]);
    const b = maskOf(W, H, [[1, 1], [25, 3]]);
    const r = diffMasks(a, b, { width: W, height: H });
    expect(r).toMatchObject({ popcountA: 3, popcountB: 2, xorCount: 3, unabsorbedCount: 3 });
    expect(r.bbox).toEqual({ x0: 2, y0: 2, x1: 25, y1: 8 });
    expect(r.componentCount).toBe(3);
    expect(judge(r).failures[0]).toMatch(/3 mask bits differ outside every allowed region/);
  });

  it('judges mask entries: inside passes, over the bound fails, exact must equal bound and region', () => {
    const corners = maskOf(W, H, [[0, 0], [1, 0], [2, 0]]);
    const a = maskOf(W, H, [[0, 0], [1, 0], [2, 0], [10, 10]]);
    const b = maskOf(W, H, [[10, 10]]);
    const exact = { id: 'D11', kind: 'mask', mask: corners, bound: 3, exact: true };
    const ok = diffMasks(a, b, { width: W, height: H, entries: [exact] });
    expect(ok.entries[0]).toMatchObject({ id: 'D11', count: 3, regionSize: 3, status: 'ok' });
    expect(judge(ok).pass).toBe(true);

    // the engine matches the oracle on a corner bit: only 2 of the 3 differ, so "exactly the set" fails
    const partial = diffMasks(a, maskOf(W, H, [[10, 10], [0, 0]]), { width: W, height: H, entries: [exact] });
    expect(partial.entries[0].status).toBe('not-exact');
    expect(judge(partial).pass).toBe(false);

    const tight = diffMasks(a, b, { width: W, height: H, entries: [{ ...exact, exact: false, bound: 2 }] });
    expect(tight.entries[0].status).toBe('over-bound');
    expect(judge(tight).failures).toEqual(['D11 absorbed 3, over its bound of 2']);

    // a pixel-kind entry is not a mask entry
    const px = diffMasks(a, b, { width: W, height: H, entries: [{ ...exact, kind: 'pixel' }] });
    expect(px.entries).toEqual([]);
  });

  it('refuses masks of the wrong size', () => {
    expect(() => diffMasks(new Uint8Array(3), new Uint8Array(3), { width: W, height: H })).toThrow(/masks must be 45 bytes/);
    expect(() => diffMasks(newMask(W, H), newMask(W, H), { width: W, height: H, entries: [{ id: 'x', kind: 'mask', mask: new Uint8Array(1), bound: 0 }] })).toThrow(/entry x/);
  });
});

describe('PNG and output files', () => {
  it('encodes and decodes 8-bit RGBA exactly, alpha-0 colour included', () => {
    const img = image(7, 5, (x, y) => [x * 30, y * 40, 200, x === 3 ? 0 : 255 - y * 10]);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(7);
    expect(back.height).toBe(5);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('reads a PNG without an alpha channel as opaque', () => {
    const { bytes, width, height } = buildPng({ width: 4, height: 3, colorType: 2, bitDepth: 8 });
    const img = decodePng(bytes);
    expect([img.width, img.height]).toEqual([width, height]);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
  });

  it('renders excluded, allowed and unallowed differences in different colours', () => {
    const w = 6;
    const h = 2;
    const a = image(w, h, () => [200, 200, 200, 255]);
    const b = clone(a);
    poke(b, 1, 0, [1, 1, 1, 255]); // absorbed
    poke(b, 3, 0, [1, 1, 1, 255]); // unabsorbed
    poke(b, 5, 0, [1, 1, 1, 255]); // excluded
    const r = diffImages(a, b, {
      entries: [entry('allowed', rectMask(w, h, [1, 0, 2, 1])), { id: 'x', kind: 'pixel-exclusion', mask: rectMask(w, h, [5, 0, 6, 1]), bound: 1 }],
    });
    const out = renderDiff(b, r);
    const px = (x, y) => Array.from(out.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
    expect(px(1, 0)).toEqual([255, 190, 0, 255]);
    expect(px(3, 0)).toEqual([255, 0, 0, 255]);
    expect(px(5, 0)).toEqual([24, 24, 80, 255]);
    expect(px(0, 1)[0]).toBe(px(0, 1)[1]); // unchanged pixels go grey
  });

  it('writes PNGs and report.json under the directory it is given', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skinlab-diff-test-'));
    try {
      const img = image(3, 3);
      const written = await writeOutputs(path.join(dir, 'nested'), { pngs: { one: img, raw: encodePng(img) }, report: { ok: true } });
      expect(written.map((f) => path.basename(f)).sort()).toEqual(['one.png', 'raw.png', 'report.json']);
      expect(JSON.parse(await readFile(path.join(dir, 'nested', 'report.json'), 'utf8'))).toEqual({ ok: true });
      expect(await readdir(path.join(dir, 'nested'))).toHaveLength(3);
      expect(decodePng(await readFile(path.join(dir, 'nested', 'one.png'))).data).toEqual(img.data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
