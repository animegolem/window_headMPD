// @ts-check
// The clip mask PNG (E D2 "SUBVIEW clippingColor"): generated from the clip bits, read back through the
// engine's own PNG decoder.
import { describe, expect, it } from 'vitest';
import { decodeImage } from '../../../src/engine/image/decode/index.js';
import { clipMaskPng, clipMaskUrl } from '../../../src/engine/render/dom/clipmask.js';

/** Clip bits (1 = kept) from a predicate, LSB first, row-major. */
function bits(w, h, keep) {
  const out = new Uint8Array((w * h + 7) >> 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) out[(y * w + x) >> 3] |= 1 << ((y * w + x) & 7);
  return out;
}

describe('clipMaskPng', () => {
  it('round-trips the clip bits as alpha, for widths that are and are not a multiple of 8', () => {
    for (const [w, h] of [[8, 3], [13, 5], [1, 1], [17, 2], [16, 16]]) {
      const keep = (x, y) => (x * 7 + y * 3) % 5 !== 0;
      const png = clipMaskPng({ width: w, height: h, clip: bits(w, h, keep) });
      expect(png).not.toBe(null);
      const img = decodeImage(/** @type {Uint8Array} */ (png));
      expect(img && [img.width, img.height]).toEqual([w, h]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(img?.data[(y * w + x) * 4 + 3]).toBe(keep(x, y) ? 255 : 0);
    }
  });

  it('is null when nothing is clipped or the image has no area', () => {
    expect(clipMaskPng({ width: 4, height: 4, clip: null })).toBe(null);
    expect(clipMaskPng({ width: 0, height: 4, clip: new Uint8Array(1) })).toBe(null);
  });

  it('writes a valid PNG: signature, IHDR, 1-bit palette, tRNS, IEND', () => {
    const png = /** @type {Uint8Array} */ (clipMaskPng({ width: 9, height: 2, clip: bits(9, 2, () => true) }));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const text = String.fromCharCode(...png);
    for (const chunk of ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']) expect(text).toContain(chunk);
    expect(png[24]).toBe(1); // bit depth
    expect(png[25]).toBe(3); // indexed
  });
});

describe('clipMaskUrl', () => {
  it('is a base64 PNG data URL, or null', () => {
    const url = clipMaskUrl({ width: 4, height: 4, clip: bits(4, 4, (x) => x < 2) });
    expect(url?.startsWith('data:image/png;base64,')).toBe(true);
    expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    expect(clipMaskUrl({ width: 4, height: 4, clip: null })).toBe(null);
  });

  it('copes with a large mask without overflowing the stack', () => {
    const url = /** @type {string} */ (clipMaskUrl({ width: 760, height: 394, clip: bits(760, 394, (x, y) => (x * 31 + y * 17) % 7 !== 0) }));
    const img = decodeImage(Uint8Array.from(atob(url.slice('data:image/png;base64,'.length)), (c) => c.charCodeAt(0)));
    expect(img && [img.width, img.height]).toEqual([760, 394]);
    expect(img?.data[(5 * 760 + 9) * 4 + 3]).toBe((9 * 31 + 5 * 17) % 7 !== 0 ? 255 : 0);
  });
});
