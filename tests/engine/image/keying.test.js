// @ts-check
// keyImage: exact-match keying, `auto`, `none`, alpha plus a key, clipping from the image or from a
// clipping image, and the paint / hit / clip planes of the ENGINE D2 table.
//
// W1.3 builds no lookup keyed by a skin-controlled string (a KeySpec is a record of numbers and one
// ref the caller resolves), so there is no `__proto__` / `constructor` test here.

import { describe, expect, it } from 'vitest';
import { bitAt, keyImage } from '../../../src/engine/image/keying.js';
import { diffRgba, packBits, unpackBits } from './helpers.js';

const MAGENTA = 0xff00ff;
const RED = 0xff0000;

/**
 * Build a tiny RGBA image from rows of tokens: `.` opaque grey, `M` magenta, `R` red, `W` white,
 * `m` magenta at alpha 128, `0` magenta at alpha 0, `-` grey at alpha 0, `h` grey at alpha 128.
 * @param {string[]} rows
 */
function pic(rows) {
  const w = rows[0].length;
  const h = rows.length;
  const data = new Uint8ClampedArray(w * h * 4);
  const px = /** @type {Record<string, number[]>} */ ({
    '.': [90, 90, 90, 255], M: [255, 0, 255, 255], R: [255, 0, 0, 255], W: [255, 255, 255, 255],
    m: [255, 0, 255, 128], 0: [255, 0, 255, 0], '-': [90, 90, 90, 0], h: [90, 90, 90, 128],
  });
  rows.forEach((row, y) => [...row].forEach((ch, x) => data.set(px[ch], (y * w + x) * 4)));
  return { width: w, height: h, data };
}

/** The planes as rows of '1'/'0' text. @param {Uint8Array | null} plane @param {number} w @param {number} h */
const grid = (plane, w, h) => (plane ? Array.from({ length: h }, (_, y) => unpackBits(plane, w * h).slice(y * w, y * w + w).join('')) : null);

describe('keyImage: none, explicit and auto keys', () => {
  it('no key leaves the image untouched, opaque pixels paint and hit, clip is null', () => {
    const img = pic(['.M.', 'R.W']);
    const out = keyImage(img, { hitKeyed: true });
    expect(diffRgba(out.rgba, img.data, 3)).toBeNull();
    expect(out.rgba).not.toBe(img.data);
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(grid(out.paint, 3, 2)).toEqual(['111', '111']);
    expect(grid(out.hit, 3, 2)).toEqual(['111', '111']);
    expect(out.clip).toBeNull();
    // null and undefined both mean "no key"
    expect(diffRgba(keyImage(img, { transparency: null, clipping: null, hitKeyed: false }).rgba, img.data, 3)).toBeNull();
  });

  it('an explicit key matches exactly: one bit off is not keyed', () => {
    const img = pic(['M.M']);
    img.data.set([255, 0, 254, 255], 8); // the last pixel is #FF00FE
    const out = keyImage(img, { transparency: MAGENTA, hitKeyed: false });
    expect(Array.from(out.rgba.filter((_, i) => i % 4 === 3))).toEqual([0, 255, 255]);
    expect(grid(out.paint, 3, 1)).toEqual(['011']);
  });

  it('auto keys the colour of pixel (0,0), whatever it is', () => {
    const img = pic(['M..', '.M.']);
    const out = keyImage(img, { transparency: 'auto', hitKeyed: false });
    expect(grid(out.paint, 3, 2)).toEqual(['011', '101']);
    const dark = pic(['..M', 'M..']);
    // here (0,0) is grey, so the greys are keyed and the magenta is not
    expect(grid(keyImage(dark, { transparency: 'auto', hitKeyed: false }).paint, 3, 2)).toEqual(['001', '100']);
  });

  it('keyed pixels keep their RGB and only lose alpha', () => {
    const img = pic(['M.']);
    const out = keyImage(img, { transparency: MAGENTA, hitKeyed: true });
    expect(Array.from(out.rgba.subarray(0, 4))).toEqual([255, 0, 255, 0]);
  });

  it('the input is never changed and every call returns fresh arrays', () => {
    const img = pic(['M.R']);
    const before = Array.from(img.data);
    const a = keyImage(img, { transparency: MAGENTA, clipping: RED, hitKeyed: true });
    const b = keyImage(img, { transparency: MAGENTA, clipping: RED, hitKeyed: true });
    expect(Array.from(img.data)).toEqual(before);
    expect(a.rgba).not.toBe(b.rgba);
    a.rgba[0] = 1;
    a.paint[0] = 255;
    expect(b.rgba[0]).toBe(255);
    expect(b.paint[0]).not.toBe(255);
  });
});

describe('keyImage: planes for transparency, hitKeyed and alpha (ENGINE D2 table)', () => {
  const img = pic(['.hM-', 'm0..']);
  // pixel:       opaque, half alpha, key (opaque), transparent grey / half-alpha key, transparent key RGB, opaque, opaque
  it('hitKeyed true: a keyed visible pixel still takes hits, an absent one never does', () => {
    const out = keyImage(img, { transparency: MAGENTA, hitKeyed: true });
    expect(Array.from(out.rgba.filter((_, i) => i % 4 === 3))).toEqual([255, 128, 0, 0, 0, 0, 255, 255]);
    expect(grid(out.paint, 4, 2)).toEqual(['1100', '0011']);
    expect(grid(out.hit, 4, 2)).toEqual(['1110', '1011']); // M and m keyed and hit; '-' and '0' have no alpha, so no hit
  });

  it('hitKeyed false: keyed pixels pass clicks through (a VIEW or SUBVIEW background)', () => {
    const out = keyImage(img, { transparency: MAGENTA, hitKeyed: false });
    expect(grid(out.paint, 4, 2)).toEqual(['1100', '0011']);
    expect(grid(out.hit, 4, 2)).toEqual(['1100', '0011']);
  });

  it('PNG alpha and a key both apply: half alpha stays half alpha, a key at half alpha goes to 0', () => {
    const out = keyImage(img, { transparency: MAGENTA, hitKeyed: false });
    expect(out.rgba[1 * 4 + 3]).toBe(128); // 'h' is untouched
    expect(out.rgba[(4 + 0) * 4 + 3]).toBe(0); // 'm' was keyed
  });

  it('a pixel with source alpha 0 is never keyed, never clipped, never hit (the plain reading of the table)', () => {
    const out = keyImage(img, { transparency: MAGENTA, clipping: MAGENTA, hitKeyed: true });
    expect(bitAt(out.hit, 3)).toBe(false); // '-'
    expect(bitAt(out.hit, 5)).toBe(false); // '0' (magenta RGB, alpha 0)
    // only the visible magenta pixels ('M' and 'm') are clipped
    expect(grid(out.clip, 4, 2)).toEqual(['1101', '0111']);
  });

  it('auto read from a transparent corner means no key', () => {
    const t = pic(['0M', 'M.']);
    const out = keyImage(t, { transparency: 'auto', hitKeyed: false });
    expect(grid(out.paint, 2, 2)).toEqual(['01', '11']);
    expect(Array.from(out.rgba.filter((_, i) => i % 4 === 3))).toEqual([0, 255, 255, 255]);
    expect(keyImage(t, { clipping: 'auto', hitKeyed: false }).clip).toBeNull();
  });
});

describe('keyImage: clipping from the image itself', () => {
  it('the region is every pixel that is not the clipping colour; clipped pixels vanish', () => {
    const img = pic(['R...', '.M..', 'RR.R']);
    const out = keyImage(img, { clipping: RED, hitKeyed: true });
    expect(grid(out.clip, 4, 3)).toEqual(['0111', '1111', '0010']);
    expect(grid(out.paint, 4, 3)).toEqual(['0111', '1111', '0010']); // the magenta is not a key here
    expect(grid(out.hit, 4, 3)).toEqual(['0111', '1111', '0010']);
    expect(out.rgba[3]).toBe(0);
  });

  it('auto clips the colour of pixel (0,0)', () => {
    const img = pic(['RR.', 'R.R']);
    const out = keyImage(img, { clipping: 'auto', hitKeyed: false });
    expect(grid(out.clip, 3, 2)).toEqual(['001', '010']);
  });

  it('a head-like image: magenta keyed and hit-through, red clipped, both off the paint plane', () => {
    const img = pic(['RRRRR', 'R.M.R', 'R.M.R', 'RRRRR']);
    const compat = keyImage(img, { transparency: MAGENTA, clipping: RED, hitKeyed: false });
    expect(grid(compat.paint, 5, 4)).toEqual(['00000', '01010', '01010', '00000']);
    expect(grid(compat.hit, 5, 4)).toEqual(['00000', '01010', '01010', '00000']);
    expect(grid(compat.clip, 5, 4)).toEqual(['00000', '01110', '01110', '00000']);
    const faithful = keyImage(img, { transparency: MAGENTA, clipping: RED, hitKeyed: true });
    expect(grid(faithful.paint, 5, 4)).toEqual(['00000', '01010', '01010', '00000']);
    expect(grid(faithful.hit, 5, 4)).toEqual(['00000', '01110', '01110', '00000']); // the magenta pixels take hits, red never
  });

  it('where both keys are the same colour, clipping wins', () => {
    const img = pic(['M.M']);
    const out = keyImage(img, { transparency: MAGENTA, clipping: MAGENTA, hitKeyed: true });
    expect(grid(out.hit, 3, 1)).toEqual(['010']);
    expect(grid(out.clip, 3, 1)).toEqual(['010']);
  });

  it('hitKeyed never makes a clipped pixel hittable', () => {
    const img = pic(['R.']);
    expect(grid(keyImage(img, { clipping: RED, hitKeyed: true }).hit, 2, 1)).toEqual(['01']);
  });
});

describe('keyImage: clipping from a clipping image', () => {
  const body = pic(['....', '....', '....']);

  it('the clipping image decides the region; the clip colour is read from it', () => {
    const mask = pic(['.MM.', '....', 'MMMM']);
    const out = keyImage(body, { clipping: MAGENTA, clipImage: 'mask.gif', hitKeyed: false }, mask);
    expect(grid(out.clip, 4, 3)).toEqual(['1001', '1111', '0000']);
    expect(grid(out.paint, 4, 3)).toEqual(['1001', '1111', '0000']);
    expect(grid(out.hit, 4, 3)).toEqual(['1001', '1111', '0000']);
  });

  it('auto is pixel (0,0) of the clipping image, not of the image', () => {
    const mask = pic(['WW..', '.W..', '....']);
    const out = keyImage(pic(['M...', '....', '....']), { clipping: 'auto', clipImage: 'mask.gif', hitKeyed: false }, mask);
    expect(grid(out.clip, 4, 3)).toEqual(['0011', '1011', '1111']);
  });

  it('anywhere outside the clipping image is outside the region', () => {
    const small = pic(['..', '..']);
    const out = keyImage(body, { clipping: RED, clipImage: 'mask.gif', hitKeyed: false }, small);
    expect(grid(out.clip, 4, 3)).toEqual(['1100', '1100', '0000']);
  });

  it('a clipImage whose file is missing clips nothing and says so with a null plane', () => {
    const named = keyImage(body, { clipping: RED, clipImage: 'gone.gif', hitKeyed: false });
    expect(named.clip).toBeNull();
    expect(grid(named.paint, 4, 3)).toEqual(['1111', '1111', '1111']);
    expect(keyImage(body, { clipping: RED, clipImage: 'gone.gif', hitKeyed: false }, null).clip).toBeNull();
    expect(named.diagnostics?.map((d) => d.code)).toEqual(['image-key-clip-image-missing']);
  });

  it('a clipImage with no clipping colour clips nothing, and a supplied image is used only when the spec names one', () => {
    const mask = pic(['MMMM', 'MMMM', 'MMMM']); // would clip everything if it were used
    expect(keyImage(body, { clipImage: 'mask.gif', hitKeyed: false }, mask).clip).toBeNull();
    const unnamed = keyImage(body, { clipping: MAGENTA, hitKeyed: false }, mask); // clips by the image itself: no magenta there
    expect(grid(unnamed.clip, 4, 3)).toEqual(['1111', '1111', '1111']);
  });
});

describe('keyImage: diagnostics (KeyedPlanes.diagnostics)', () => {
  const body = pic(['....', '....', '....']);
  const codesOf = (/** @type {import('../../../src/engine/contracts').KeyedPlanes} */ out) => (out.diagnostics ?? []).map((d) => d.code);

  it('a keying with nothing to say has no diagnostics property at all', () => {
    const mask = pic(['.MM.', '....', 'MMMM']);
    const outs = [
      keyImage(body, { hitKeyed: false }),
      keyImage(pic(['M.M']), { transparency: MAGENTA, hitKeyed: true }),
      keyImage(pic(['M.M']), { transparency: 'auto', clipping: 'auto', hitKeyed: false }),
      keyImage(body, { transparency: null, clipping: null, hitKeyed: false }),
      keyImage(body, { clipping: MAGENTA, clipImage: 'mask.gif', hitKeyed: false }, mask),
      keyImage(body, { clipImage: 'mask.gif', hitKeyed: false }), // no clipping colour: the clipImage is not used, nothing is lost
    ];
    for (const out of outs) expect('diagnostics' in out).toBe(false);
  });

  it('a clipImage that was not supplied warns, once, naming the ref; the plane is still null', () => {
    for (const clipImg of [undefined, null]) {
      const out = keyImage(body, { clipping: RED, clipImage: 'gone.gif', hitKeyed: false }, clipImg);
      expect(out.clip).toBeNull();
      expect(out.diagnostics).toHaveLength(1);
      expect(out.diagnostics?.[0]).toMatchObject({ code: 'image-key-clip-image-missing', severity: 'warn' });
      expect(out.diagnostics?.[0].detail).toContain('gone.gif');
    }
    // an auto clipping colour does not add a second diagnostic on top: there is no image to read it from
    expect(codesOf(keyImage(body, { clipping: 'auto', clipImage: 'gone.gif', hitKeyed: false }))).toEqual(['image-key-clip-image-missing']);
  });

  it('an auto transparency key read from a fully transparent (0,0) says it keyed nothing', () => {
    const img = pic(['0M.', '-M.']); // (0,0) is magenta at alpha 0: never a key
    const out = keyImage(img, { transparency: 'auto', hitKeyed: false });
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics?.[0]).toMatchObject({ code: 'image-key-auto-unresolved', severity: 'info' });
    expect(out.diagnostics?.[0].detail).toContain('transparency');
    expect(grid(out.paint, 3, 2)).toEqual(['011', '011']); // the visible magenta stays
  });

  it('an auto clipping colour read from a fully transparent (0,0) says it clipped no colour', () => {
    const own = keyImage(pic(['-M.', '...']), { clipping: 'auto', hitKeyed: false });
    expect(own.clip).toBeNull();
    expect(own.diagnostics).toHaveLength(1);
    expect(own.diagnostics?.[0]).toMatchObject({ code: 'image-key-auto-unresolved', severity: 'info' });
    expect(own.diagnostics?.[0].detail).toContain('clipping');
    // from a clipping image the bounds still clip, and the diagnostic still says no colour did
    const viaMask = keyImage(body, { clipping: 'auto', clipImage: 'mask.gif', hitKeyed: false }, pic(['-.', '..']));
    expect(grid(viaMask.clip, 4, 3)).toEqual(['1100', '1100', '0000']);
    expect(codesOf(viaMask)).toEqual(['image-key-auto-unresolved']);
  });

  it('both keys unresolved: one diagnostic each, transparency first; arrays are fresh per call', () => {
    const img = pic(['-M.']);
    const a = keyImage(img, { transparency: 'auto', clipping: 'auto', hitKeyed: false });
    const b = keyImage(img, { transparency: 'auto', clipping: 'auto', hitKeyed: false });
    expect(a.diagnostics?.map((d) => d.detail.split(' ')[0])).toEqual(['transparency', 'clipping']);
    expect(a.diagnostics).not.toBe(b.diagnostics);
    expect(a.diagnostics).toEqual(b.diagnostics);
  });
});

describe('keyImage: plane layout', () => {
  it('is row-major, least significant bit first, rows not padded: pixel i is bit (i & 7) of byte (i >> 3)', () => {
    // 3 x 3 = 9 pixels = 2 bytes; make only pixel 8 (x=2,y=2) and pixel 0 visible
    const flags = [1, 0, 0, 0, 0, 0, 0, 0, 1];
    const data = new Uint8ClampedArray(9 * 4);
    flags.forEach((f, i) => data.set([5, 5, 5, f ? 255 : 0], i * 4));
    const out = keyImage({ width: 3, height: 3, data }, { hitKeyed: false });
    expect(Array.from(out.paint)).toEqual([0b00000001, 0b00000001]);
    expect(Array.from(out.paint)).toEqual(Array.from(packBits(flags)));
    expect(out.paint.length).toBe(2);
    expect(out.hit.length).toBe(2);
  });

  it('a 1 x 1 image has one byte per plane', () => {
    const out = keyImage({ width: 1, height: 1, data: Uint8ClampedArray.of(1, 2, 3, 255) }, { clipping: 'auto', hitKeyed: false });
    expect([out.paint.length, out.hit.length, out.clip?.length]).toEqual([1, 1, 1]);
    expect(out.paint[0]).toBe(0); // the only pixel is its own clip colour
  });
});
