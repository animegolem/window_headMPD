// @ts-check
// The pixel work behind the canvases: copy, tile, slider caps, and the BUTTONGROUP owner index and
// per-pixel composite (E D2; spec 6.5). Every function is compared with a naive version written here.
import { describe, expect, it } from 'vitest';
import { buildOwners, copyPixels, copyRect, createSurface, drawTrack, tileRect, unownedPixels } from '../../../src/engine/render/dom/compose.js';

/** A surface whose pixel (x, y) is [x, y, tag, 255]. */
function pattern(w, h, tag = 0) {
  const s = createSurface(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s.data.set([x, y, tag, 255], (y * w + x) * 4);
  return s;
}
const px = (s, x, y) => [...s.data.subarray((y * s.width + x) * 4, (y * s.width + x) * 4 + 4)];
const CLEAR = [0, 0, 0, 0];

describe('createSurface', () => {
  it('is transparent and the size asked', () => {
    const s = createSurface(3, 2);
    expect([s.width, s.height, s.data.length]).toEqual([3, 2, 24]);
    expect(s.data.every((b) => b === 0)).toBe(true);
  });

  it('clamps nonsense to a size that can be allocated', () => {
    expect(createSurface(-5, 4).width).toBe(0);
    expect(createSurface(Number.NaN, 4).width).toBe(0);
    expect(createSurface(1.9, 1.9).width).toBe(1);
    const big = createSurface(1e9, 1e9);
    expect(big.width * big.height).toBeLessThanOrEqual(16_777_216);
  });
});

describe('copyRect', () => {
  it('copies a rectangle verbatim, alpha included, replacing what was there', () => {
    const dst = createSurface(6, 4);
    dst.data.fill(9);
    const src = pattern(4, 4, 7);
    src.data.set([1, 2, 3, 0], 0); // a transparent source pixel replaces
    copyRect(dst, 1, 1, src, 0, 0, 3, 2);
    expect(px(dst, 1, 1)).toEqual([1, 2, 3, 0]);
    expect(px(dst, 3, 2)).toEqual([2, 1, 7, 255]);
    expect(px(dst, 0, 0)).toEqual([9, 9, 9, 9]);
    expect(px(dst, 4, 1)).toEqual([9, 9, 9, 9]);
  });

  it('clips to both surfaces, including negative offsets', () => {
    const dst = createSurface(4, 4);
    copyRect(dst, -2, -1, pattern(8, 8), 0, 0, 8, 8);
    expect(px(dst, 0, 0)).toEqual([2, 1, 0, 255]);
    expect(px(dst, 3, 3)).toEqual([5, 4, 0, 255]);
    const small = createSurface(2, 2);
    copyRect(small, 0, 0, pattern(8, 8), 6, 6, 4, 4);
    expect(px(small, 1, 1)).toEqual([7, 7, 0, 255]);
    expect(px(small, 0, 0)).toEqual([6, 6, 0, 255]);
  });

  it('copies nothing for an empty or outside rectangle and accepts KeyedPlanes (rgba)', () => {
    const dst = createSurface(2, 2);
    copyRect(dst, 5, 5, pattern(2, 2), 0, 0, 2, 2);
    copyRect(dst, 0, 0, pattern(2, 2), 0, 0, 0, 2);
    expect(dst.data.every((b) => b === 0)).toBe(true);
    copyRect(dst, 0, 0, { width: 1, height: 1, rgba: new Uint8ClampedArray([5, 6, 7, 8]) }, 0, 0, 1, 1);
    expect(px(dst, 0, 0)).toEqual([5, 6, 7, 8]);
  });
});

describe('tileRect', () => {
  it('repeats the source from the rectangle\'s top-left and cuts the last tile', () => {
    const dst = createSurface(10, 7);
    const src = pattern(4, 3);
    tileRect(dst, 1, 1, 8, 5, src, 0, 0, 4, 3);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 10; x++) {
        const inside = x >= 1 && x < 9 && y >= 1 && y < 6;
        const want = inside ? [(x - 1) % 4, (y - 1) % 3, 0, 255] : CLEAR;
        expect(px(dst, x, y)).toEqual(want);
      }
    }
  });

  it('tiles a part of the source and ignores a degenerate one', () => {
    const dst = createSurface(6, 2);
    tileRect(dst, 0, 0, 6, 2, pattern(8, 2), 2, 0, 2, 2);
    expect(px(dst, 0, 0)).toEqual([2, 0, 0, 255]);
    expect(px(dst, 1, 1)).toEqual([3, 1, 0, 255]);
    expect(px(dst, 2, 0)).toEqual([2, 0, 0, 255]);
    const none = createSurface(4, 4);
    tileRect(none, 0, 0, 4, 4, pattern(4, 4), 0, 0, 0, 4);
    tileRect(none, 0, 0, 0, 4, pattern(4, 4), 0, 0, 4, 4);
    expect(none.data.every((b) => b === 0)).toBe(true);
  });

  it('crops when the source is larger than the rectangle', () => {
    const dst = createSurface(3, 3);
    tileRect(dst, 0, 0, 3, 3, pattern(8, 8), 0, 0, 8, 8);
    expect(px(dst, 2, 2)).toEqual([2, 2, 0, 255]);
  });
});

describe('drawTrack', () => {
  const src = pattern(9, 3); // columns 0..8 carry their own x

  it('tiled with caps: the first and last b columns are caps, the middle repeats from b and is cut at length - b', () => {
    const dst = createSurface(30, 3);
    drawTrack(dst, src, { vertical: false, length: 30, tiled: true, border: 2 });
    for (let x = 0; x < 30; x++) {
      const col = x < 2 ? x : x >= 28 ? 7 + (x - 28) : 2 + ((x - 2) % 5);
      expect(px(dst, x, 1)).toEqual([col, 1, 0, 255]);
    }
  });

  it('tiled without caps repeats the whole image from the start edge', () => {
    const dst = createSurface(20, 3);
    drawTrack(dst, src, { vertical: false, length: 20, tiled: true, border: 0 });
    for (let x = 0; x < 20; x++) expect(px(dst, x, 0)[0]).toBe(x % 9);
  });

  it('untiled draws the image once at the origin', () => {
    const dst = createSurface(20, 3);
    drawTrack(dst, src, { vertical: false, length: 20, tiled: false, border: 2 });
    expect(px(dst, 8, 0)).toEqual([8, 0, 0, 255]);
    expect(px(dst, 9, 0)).toEqual(CLEAR);
  });

  it('a border over half the image is clamped to half', () => {
    const dst = createSurface(20, 3);
    drawTrack(dst, src, { vertical: false, length: 20, tiled: true, border: 99 });
    expect(px(dst, 0, 0)[0]).toBe(0);
    expect(px(dst, 3, 0)[0]).toBe(3);
    expect(px(dst, 19, 0)[0]).toBe(8); // the right cap is the last 4 columns [5..8]
    expect(px(dst, 16, 0)[0]).toBe(5);
  });

  it('vertical: caps are the top and bottom rows, the middle repeats downwards', () => {
    const tall = pattern(2, 9);
    const dst = createSurface(2, 30);
    drawTrack(dst, tall, { vertical: true, length: 30, tiled: true, border: 2 });
    for (let y = 0; y < 30; y++) {
      const row = y < 2 ? y : y >= 28 ? 7 + (y - 28) : 2 + ((y - 2) % 5);
      expect(px(dst, 1, y)).toEqual([1, row, 0, 255]);
    }
  });
});

describe('buildOwners', () => {
  const map = (w, h, f) => {
    const s = createSurface(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s.data.set([...f(x, y), 255], (y * w + x) * 4);
    return s;
  };

  it('owns pixels by exact RGB match, with no tolerance (spec 6.5)', () => {
    const m = map(4, 1, (x) => [[255, 0, 51], [255, 0, 52], [0, 255, 0], [9, 9, 9]][x]);
    const { owner, lists } = buildOwners(m, [0xff0033, 0x00ff00], 4, 1);
    expect([...owner]).toEqual([0, -1, 1, -1]);
    expect(lists.map((l) => [...l])).toEqual([[0], [2]]);
  });

  it('the first declared element owns a shared colour; an element with no colour owns nothing', () => {
    const m = map(2, 1, () => [1, 2, 3]);
    const { owner, lists } = buildOwners(m, [null, 0x010203, 0x010203], 2, 1);
    expect([...owner]).toEqual([1, 1]);
    expect(lists.map((l) => l.length)).toEqual([0, 2, 0]);
  });

  it('crops a map larger than the box and leaves the rest of a smaller one unowned', () => {
    const big = map(6, 2, () => [1, 1, 1]);
    expect([...buildOwners(big, [0x010101], 3, 1).owner]).toEqual([0, 0, 0]);
    const small = map(2, 1, () => [1, 1, 1]);
    expect([...buildOwners(small, [0x010101], 4, 2).owner]).toEqual([0, 0, -1, -1, -1, -1, -1, -1]);
  });

  it('matches a naive per-pixel scan on a random map', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % 4;
    const palette = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [1, 1, 1]];
    const m = map(37, 29, () => palette[rnd()]);
    const colors = [0x0a141e, 0x28323c, 0x46505a];
    const { owner, lists } = buildOwners(m, colors, 37, 29);
    const naive = Array.from({ length: 37 * 29 }, (_, i) => {
      const rgb = (m.data[i * 4] << 16) | (m.data[i * 4 + 1] << 8) | m.data[i * 4 + 2];
      return colors.indexOf(rgb);
    });
    expect([...owner]).toEqual(naive);
    lists.forEach((l, k) => expect([...l]).toEqual(naive.flatMap((o, i) => (o === k ? [i] : []))));
  });
});

describe('copyPixels and unownedPixels', () => {
  it('copies only the listed pixels from a layer; the rest is untouched', () => {
    const out = new Uint8ClampedArray(4 * 4).fill(1);
    const layer = pattern(2, 2, 5);
    copyPixels(out, 2, 2, layer, Uint32Array.of(1, 2));
    expect([...out.subarray(0, 4)]).toEqual([1, 1, 1, 1]);
    expect([...out.subarray(4, 8)]).toEqual([1, 0, 5, 255]);
    expect([...out.subarray(8, 12)]).toEqual([0, 1, 5, 255]);
    expect([...out.subarray(12, 16)]).toEqual([1, 1, 1, 1]);
  });

  it('a missing layer, or pixels the layer does not reach, become transparent', () => {
    const out = new Uint8ClampedArray(2 * 2 * 4).fill(7);
    copyPixels(out, 2, 2, null, Uint32Array.of(0));
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    copyPixels(out, 2, 2, pattern(1, 1, 3), Uint32Array.of(0, 1, 2));
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 3, 255]);
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // x = 1 is outside a 1-wide layer
    expect([...out.subarray(8, 12)]).toEqual([0, 0, 0, 0]); // y = 1 too
  });

  it('with no index list it covers the whole box', () => {
    const out = new Uint8ClampedArray(2 * 2 * 4);
    copyPixels(out, 2, 2, pattern(2, 2, 9), null);
    expect([...out.subarray(12, 16)]).toEqual([1, 1, 9, 255]);
  });

  it('unownedPixels is the box minus the owned pixels', () => {
    expect([...unownedPixels(Int16Array.of(0, -1, 1, -1, -1))]).toEqual([1, 3, 4]);
    expect(unownedPixels(new Int16Array(0)).length).toBe(0);
  });

  it('a state change recomposites to the same bytes as a full composite', () => {
    // Two elements over a 6x1 box; layer A for state 0, layer B for state 1.
    const owner = Int16Array.of(0, 0, 1, 1, -1, -1);
    const lists = [Uint32Array.of(0, 1), Uint32Array.of(2, 3)];
    const layerA = pattern(6, 1, 1);
    const layerB = pattern(6, 1, 2);
    const full = (states) => {
      const o = new Uint8ClampedArray(24);
      copyPixels(o, 6, 1, layerA, unownedPixels(owner)); // showBackground
      states.forEach((s, i) => copyPixels(o, 6, 1, s ? layerB : layerA, lists[i]));
      return o;
    };
    const inc = full([0, 0]);
    copyPixels(inc, 6, 1, layerB, lists[1]);
    expect([...inc]).toEqual([...full([0, 1])]);
  });
});
