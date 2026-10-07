// @ts-check
// G3.F3: the picker and the shape rasteriser use the renderer's rules instead of copies of them.
//  - the thumb they hit-test is where `layout/slider-geometry.js` puts it, for both geometries and
//    both axes (so a drag and a click and a drawn thumb agree);
//  - every image they ask the service for carries the KeySpec `image/keyspec.js` derives, so the
//    service decodes each image once for the renderer, the picker and the shape together.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keySpecFor } from '../../../src/engine/image/keyspec.js';
import { pick } from '../../../src/engine/input/picker.js';
import { fractionOf, stripFrame, thumbEdge } from '../../../src/engine/layout/slider-geometry.js';
import { rasterizeShape, rasterizeShapeWithDiagnostics } from '../../../src/engine/shape/mask.js';
import { FAITHFUL, MAGENTA, N, ORACLE_COMPAT, bitOf, el, image, slotsOf, solidImage, syncImages, viewOf } from './support.js';

const scene = readFileSync(new URL('../../../src/engine/shape/scene.js', import.meta.url), 'utf8');

describe('shape/scene.js has no private copies of the shared rules', () => {
  it('imports both rule modules and defines neither rule set itself', () => {
    expect(scene).toMatch(/from '\.\.\/image\/keyspec\.js'/);
    expect(scene).toMatch(/from '\.\.\/layout\/slider-geometry\.js'/);
    expect(scene).not.toMatch(/function (?:keySpecOf|transparencyOf|clippingOf|thumbEdge|fractionOf)\b/);
    expect(scene).not.toMatch(/\bkeySpecOf\b/);
  });
});

describe('the thumb the picker finds is the renderer\'s thumb', () => {
  const values = [0, 1, 13, 25, 50, 62, 87, 99, 100];
  const geometries = /** @type {const} */ (['oracle', 'docs']);

  /**
   * The thumb's extent along its axis as the picker sees it: the first and last positions that pick
   * the slider. The slider has a thumb and nothing else, so only the thumb takes a hit.
   * @param {boolean} vertical @param {number} value @param {number} border @param {'oracle' | 'docs'} geometry
   */
  function found(vertical, value, border, geometry) {
    const images = syncImages({ 'thumb.bmp': solidImage(vertical ? 4 : 5, vertical ? 6 : 3, 0x778899) });
    const [w, h] = vertical ? [8, 30] : [30, 8];
    const v = viewOf([
      N('slider', { id: 's', left: 0, top: 0, width: w, height: h, direction: vertical ? 'vertical' : 'horizontal', thumbImage: 'thumb.bmp', borderSize: border, min: 0, max: 100, value }),
    ], { images, width: 30, height: 30 });
    const opts = { ...FAITHFUL, sliderGeometry: geometry };
    const hits = [];
    for (let p = 0; p < 30; p++) {
      const hit = vertical ? pick(v, images, slotsOf(), 4, p, opts) : pick(v, images, slotsOf(), p, 4, opts);
      if (hit?.el.id === 's') hits.push(p);
    }
    return hits;
  }

  for (const geometry of geometries) {
    for (const vertical of [false, true]) {
      it(`${geometry}, ${vertical ? 'vertical' : 'horizontal'}: the hit span is the thumb at thumbEdge, cropped to the box`, () => {
        for (const border of [0, 4]) {
          for (const value of values) {
            const thumb = vertical ? 6 : 5;
            const hits = found(vertical, value, border, geometry);
            const edge = thumbEdge(fractionOf(value, 0, 100), { vertical, length: 30, thumb, border, geometry });
            // the claim is cropped to the slider's box (the docs geometry can push a thumb past an end)
            const span = Array.from({ length: thumb }, (_, i) => edge + i).filter((p) => p >= 0 && p < 30);
            expect(hits, `value ${value} border ${border}`).toEqual(span);
          }
        }
      });
    }
  }
});

describe('the images the picker and the shape ask for carry the renderer\'s KeySpecs', () => {
  const images = syncImages({
    'bg.bmp': solidImage(40, 40, 0x336699),
    'btn.bmp': image(6, 6, (x) => (x < 3 ? MAGENTA : 0x445566)),
    'thumb.bmp': solidImage(4, 4, 0x778899),
    'track.bmp': solidImage(20, 4, 0x556677),
    'fg.bmp': solidImage(20, 4, 0x667788),
    'pos.bmp': solidImage(8, 8, 0x808080),
    'strip.bmp': solidImage(24, 8, 0x998877),
    'grp.bmp': solidImage(12, 6, 0x887766),
    'map.bmp': image(12, 6, (x) => (x < 6 ? 0xff0000 : 0x000000)),
  });
  const v = viewOf([
    N('subview', { id: 'sv', left: 0, top: 0, width: 40, height: 10, backgroundImage: 'bg.bmp', transparencyColor: '#FF00FF', clippingColor: '#336699' }),
    N('button', { id: 'btn', left: 0, top: 10, width: 6, height: 6, image: 'btn.bmp', transparencyColor: '#FF00FF' }),
    N('slider', { id: 'sl', left: 0, top: 16, width: 20, height: 4, backgroundImage: 'track.bmp', thumbImage: 'thumb.bmp', foregroundImage: 'fg.bmp', transparencyColor: '#FF00FF' }),
    N('customslider', { id: 'dial', left: 20, top: 16, positionImage: 'pos.bmp', image: 'strip.bmp', min: 0, max: 100, value: 50 }),
    N('buttongroup', { id: 'grp', left: 0, top: 24, width: 12, height: 6, image: 'grp.bmp', mappingImage: 'map.bmp', transparencyColor: '#FF00FF' }, [
      N('buttonelement', { id: 'e0', mappingColor: '#FF0000' }),
    ]),
  ], { images, width: 40, height: 40 });

  /** @param {typeof FAITHFUL} opts */
  function requestsFor(opts) {
    images.requests.length = 0;
    rasterizeShape(v, images, slotsOf(), opts);
    pick(v, images, slotsOf(), 1, 12, opts);
    return [...images.requests];
  }

  for (const opts of [FAITHFUL, ORACLE_COMPAT]) {
    it(`${opts.config}: each (file, spec) is the one keySpecFor derives for that element and role`, () => {
      const requests = requestsFor(opts);
      /** @type {Array<[string, string, 'background' | 'button' | 'thumb' | 'track' | 'strip']>} */
      const expected = [
        ['bg.bmp', 'sv', 'background'], ['btn.bmp', 'btn', 'button'], ['thumb.bmp', 'sl', 'thumb'], ['track.bmp', 'sl', 'track'],
        ['fg.bmp', 'sl', 'track'], ['strip.bmp', 'dial', 'strip'], ['grp.bmp', 'grp', 'button'],
      ];
      for (const [ref, id, part] of expected) {
        const spec = keySpecFor(el(v, id), part, opts);
        expect(requests.filter((r) => r.ref === ref).map((r) => r.spec), `${ref} (${part})`).toContainEqual(spec);
        // and nothing else: one spelling per (file, role), so the service decodes it once
        const spellings = new Set(requests.filter((r) => r.ref === ref).map((r) => JSON.stringify(r.spec)));
        expect(spellings.size, `${ref} spellings`).toBe(1);
      }
    });
  }

  it('the roles are not interchangeable: a thumb and a button key hits, a track does not', () => {
    const requests = requestsFor(FAITHFUL);
    const hitKeyed = (/** @type {string} */ ref) => requests.find((r) => r.ref === ref)?.spec.hitKeyed;
    expect([hitKeyed('btn.bmp'), hitKeyed('thumb.bmp'), hitKeyed('track.bmp'), hitKeyed('bg.bmp')]).toEqual([true, true, false, false]);
    expect(requestsFor(ORACLE_COMPAT).find((r) => r.ref === 'btn.bmp')?.spec.hitKeyed).toBe(false);
  });
});

describe('the CUSTOMSLIDER strip frame is the renderer\'s', () => {
  it('shows frame stripFrame(f, n) of the strip for every value', () => {
    // A 3-frame horizontal strip, each frame 4 wide; frame k paints only its pixel (2, k). The position
    // map is grey in its first column only, so the shape is that column plus the one painted pixel.
    const strip = image(12, 4, (x, y) => (x % 4 === 2 && y === Math.floor(x / 4) ? 0x303030 : [0, 0, 0, 0]));
    const pos = image(4, 4, (x) => (x === 0 ? 0x808080 : 0xff0000));
    for (const value of [0, 10, 24, 25, 26, 49, 50, 51, 74, 75, 100]) {
      const images = syncImages({ 'pos.bmp': pos, 'strip.bmp': strip });
      const v = viewOf([N('customslider', { id: 'd', left: 0, top: 0, positionImage: 'pos.bmp', image: 'strip.bmp', min: 0, max: 100, value })], { images, width: 8, height: 8 });
      const frame = stripFrame(fractionOf(value, 0, 100), 3);
      const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL, { minBits: 0 }).shape;
      if (out.kind !== 'bits') throw new Error('phase 1 shapes are bits');
      for (let k = 0; k < 3; k++) expect(bitOf(out, 2, k), `value ${value} frame ${frame} row ${k}`).toBe(k === frame ? 1 : 0);
    }
  });
});
