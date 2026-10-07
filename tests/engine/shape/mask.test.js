// @ts-check
// The frame shape (WAVES W3.5 acceptance 1; E §5.11 `rasterizeShape`; E D2 "Window shape"). Models are
// built from synthetic raw trees, pixels are RgbaImage literals keyed by `keyImage`; expected shapes
// are computed from the fixture data, never from art.
import { describe, expect, it } from 'vitest';
import { pick } from '../../../src/engine/input/picker.js';
import { MIN_SHAPE_BITS, SHAPE_PIXEL_BUDGET, rasterizeShape, rasterizeShapeWithDiagnostics } from '../../../src/engine/shape/mask.js';
import {
  FAITHFUL, MAGENTA, N, ORACLE_COMPAT, RED, bitOf, dotted, el, image, setBits, setOf, slotsOf, solidImage, syncImages, viewOf,
} from './support.js';

/** @typedef {import('../../../src/engine/contracts').EngineOptions} EngineOptions */

/**
 * The shape of a view as a plain object with bits. The 64-bit floor is off, so a test can look at a
 * small shape as it is; the floor has its own tests, which call `rasterizeShape` itself.
 * @param {import('../../../src/engine/contracts').ViewModel} view @param {import('./support.js').SyncImages} images
 * @param {{ opts?: EngineOptions, slots?: ReturnType<typeof slotsOf> }} [o]
 */
function shapeOf(view, images, o = {}) {
  const s = rasterizeShapeWithDiagnostics(view, images, o.slots ?? slotsOf(), o.opts ?? FAITHFUL, { minBits: 0 }).shape;
  if (s.kind !== 'bits') throw new Error('phase 1 shapes are bits');
  return s;
}

/** The set of "x,y" a rectangle covers. @param {number} x @param {number} y @param {number} w @param {number} h */
const rect = (x, y, w, h) => new Set(Array.from({ length: w * h }, (_, i) => `${x + (i % w)},${y + Math.floor(i / w)}`));

/** @param {Set<string>} a @param {Set<string>} b */
const union = (a, b) => new Set([...a, ...b]);
/** @param {Set<string>} a @param {Set<string>} b */
const minus = (a, b) => new Set([...a].filter((k) => !b.has(k)));

describe('bit layout and the full-rect fallback', () => {
  const images = syncImages({ 'b8.bmp': solidImage(8, 8, 0x336699), 'b7.bmp': solidImage(7, 9, 0x336699) });

  it('sets bits row-major, least significant bit first, as wide and high as the VIEW', () => {
    const v = viewOf([N('button', { id: 'b', left: 4, top: 4, image: 'b8.bmp' })], { images, width: 16, height: 16 });
    const s = shapeOf(v, images);
    expect([s.width, s.height, s.bits.length]).toEqual([16, 16, 32]);
    expect(setOf(s)).toEqual(rect(4, 4, 8, 8));
    // pixel (4,4) is index 68: bit 4 of byte 8; the row below starts at index 84: bit 4 of byte 10
    expect(s.bits[8]).toBe(0b11110000);
    expect(s.bits[9]).toBe(0b00001111);
    expect(s.bits[0]).toBe(0);
  });

  it('keeps a shape of exactly 64 bits', () => {
    const v = viewOf([N('button', { id: 'b', left: 4, top: 4, image: 'b8.bmp' })], { images, width: 16, height: 16 });
    const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL);
    expect(MIN_SHAPE_BITS).toBe(64);
    expect(setBits(/** @type {any} */ (out.shape))).toBe(64);
    expect(out.diagnostics).toEqual([]);
    expect(out.shape).toEqual(rasterizeShape(v, images, slotsOf(), FAITHFUL));
  });

  it('replaces a shape of 63 bits with the full view rect and a diagnostic, and sets no stray bits', () => {
    const v = viewOf([N('button', { id: 'b', left: 4, top: 4, image: 'b7.bmp' })], { images, width: 15, height: 15 });
    const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL);
    const s = /** @type {{ kind: 'bits', width: number, height: number, bits: Uint8Array }} */ (out.shape);
    expect(setBits(s)).toBe(225);
    expect(s.bits.length).toBe(29);
    expect(s.bits[28]).toBe(0b00000001); // 225 = 28 bytes and one bit
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]).toMatchObject({ code: 'shape-empty', severity: 'warn' });
    expect(rasterizeShape(v, images, slotsOf(), FAITHFUL)).toEqual(out.shape);
  });

  it('an all-transparent view is the full view rect with a diagnostic (E §10)', () => {
    const clear = syncImages({ 'c.png': image(20, 20, () => [1, 2, 3, 0]) });
    const v = viewOf([N('button', { id: 'b', left: 0, top: 0, image: 'c.png' }), N('subview', { id: 'sv', left: 0, top: 0, width: 10, height: 10 })], { images: clear });
    const out = rasterizeShapeWithDiagnostics(v, clear, slotsOf(), FAITHFUL);
    expect(setBits(/** @type {any} */ (out.shape))).toBe(40 * 40);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['shape-empty']);
    expect(out.diagnostics[0].detail).toMatch(/40x40/);
  });

  it('a view with no area has an empty shape and the same diagnostic, not an exception', () => {
    const v = viewOf([], { images, width: 0, height: 0 });
    const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL);
    expect(out.shape).toMatchObject({ kind: 'bits', width: 0, height: 0 });
    expect(out.diagnostics.map((d) => d.code)).toEqual(['shape-empty']);
  });

  it('`size` replaces the VIEW\'s own size: the model may say 549 while the frame stays 760', () => {
    const v = viewOf([N('button', { id: 'b', left: 4, top: 4, image: 'b8.bmp' })], { images, width: 16, height: 16 });
    const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL, { size: { width: 20, height: 10 }, minBits: 0 });
    const s = /** @type {{ width: number, height: number, bits: Uint8Array }} */ (out.shape);
    expect([s.width, s.height]).toEqual([20, 10]);
    expect(setOf(s)).toEqual(rect(4, 4, 8, 6)); // cropped to the 10 rows that exist
  });
});

describe('paint, and hit if interactive', () => {
  const half = (left, right) => image(10, 10, (x) => (x < 5 ? left : right));

  it('a keyed BUTTON pixel is in the shape in faithful (it takes clicks) and not in oracle-compat', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('button', { id: 'btn', left: 10, top: 10, image: 'k.bmp', transparencyColor: '#FF00FF' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images, { opts: FAITHFUL }))).toEqual(rect(10, 10, 10, 10));
    expect(setOf(shapeOf(v, images, { opts: ORACLE_COMPAT }))).toEqual(rect(15, 10, 5, 10));
  });

  it('a keyed pixel of a non-interactive element is never in the shape, in either configuration', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('subview', { id: 'sv', left: 10, top: 10, backgroundImage: 'k.bmp', transparencyColor: '#FF00FF' })], { images, width: 30, height: 30 });
    for (const opts of [FAITHFUL, ORACLE_COMPAT]) expect(setOf(shapeOf(v, images, { opts }))).toEqual(rect(15, 10, 5, 10));
  });

  it('a SUBVIEW with a mouse handler is interactive, yet its keyed background still passes clicks through', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('subview', { id: 'sv', left: 10, top: 10, backgroundImage: 'k.bmp', transparencyColor: '#FF00FF', onClick: 'x();' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(15, 10, 5, 10)); // hitKeyed is false for backgrounds (D2 table)
  });

  it('passThrough keeps what the element paints and drops the hit-only part', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('button', { id: 'btn', left: 10, top: 10, image: 'k.bmp', transparencyColor: '#FF00FF', passThrough: 'true' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(15, 10, 5, 10));
  });

  it('a disabled interactive element still holds its pixels, so a click on it is swallowed, not passed on', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('button', { id: 'btn', left: 10, top: 10, image: 'k.bmp', transparencyColor: '#FF00FF', enabled: 'false' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(10, 10, 10, 10));
  });

  it('a BUTTON with no image takes its box, an unsized one nothing', () => {
    const images = syncImages({ 'f.bmp': solidImage(30, 30, 0x111111) });
    const v = viewOf([N('button', { id: 'hot', left: 10, top: 10, width: 10, height: 10 }), N('button', { id: 'none', left: 0, top: 0 })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(10, 10, 10, 10));
  });

  it('a BUTTON follows the state the model holds: disabled art, latched art', () => {
    const images = syncImages({
      'up.bmp': solidImage(10, 10, 0x111111), 'dis.bmp': dotted(10, 10, 0x222222, []), 'narrow.bmp': solidImage(4, 10, 0x333333),
    });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'up.bmp', disabledImage: 'narrow.bmp', downImage: 'narrow.bmp', sticky: 'true' })], { images, width: 20, height: 20 });
    expect(setOf(shapeOf(v, images)).size).toBe(100);
    el(v, 'btn').set('enabled', false, 'script');
    expect(setOf(shapeOf(v, images))).toEqual(rect(0, 0, 4, 10));
    el(v, 'btn').set('enabled', true, 'script');
    el(v, 'btn').set('down', true, 'script');
    expect(setOf(shapeOf(v, images))).toEqual(rect(0, 0, 4, 10));
  });
});

describe('BUTTONGROUP', () => {
  const images = syncImages({
    'map.bmp': image(10, 10, (x) => (x < 5 ? 0xff0033 : x < 8 ? 0x123456 : 0x00ff00)),
    'g.bmp': image(10, 10, (x, y) => (x === 0 && y === 0 ? MAGENTA : 0x336699)),
  });
  /** @param {Record<string, string | number>} [attrs] */
  const skin = (attrs = {}) => viewOf([
    N('buttongroup', { id: 'g', left: 10, top: 10, mappingImage: 'map.bmp', image: 'g.bmp', transparencyColor: '#FF00FF', ...attrs }, [
      N('buttonelement', { mappingColor: '#FF0033' }), N('buttonelement', { mappingColor: '#00FF00' }),
    ]),
  ], { images, width: 30, height: 30 });
  const owned = union(rect(10, 10, 5, 10), rect(18, 10, 2, 10));
  const unowned = rect(15, 10, 3, 10);

  it('owned pixels are in the shape, and the keyed owned corner takes its hit only in faithful', () => {
    const faithful = setOf(shapeOf(skin({ showBackground: 'false' }), images, { opts: FAITHFUL }));
    expect(faithful).toEqual(owned); // (10,10) is keyed but owned and interactive
    const compat = setOf(shapeOf(skin({ showBackground: 'false' }), images, { opts: ORACLE_COMPAT }));
    expect(compat).toEqual(minus(owned, new Set(['10,10'])));
  });

  it('showBackground paints the unowned pixels; the skin\'s value wins over the engine switch', () => {
    expect(setOf(shapeOf(skin({ showBackground: 'true' }), images, { opts: FAITHFUL }))).toEqual(union(owned, unowned));
    expect(setOf(shapeOf(skin({ showBackground: 'false' }), images, { opts: ORACLE_COMPAT }))).not.toEqual(union(owned, unowned));
  });

  it('with nothing declared, the unowned pixels follow showBackgroundDefault: not painted faithful, painted oracle-compat (U-23)', () => {
    expect(setOf(shapeOf(skin(), images, { opts: FAITHFUL }))).toEqual(owned);
    expect(setOf(shapeOf(skin(), images, { opts: ORACLE_COMPAT }))).toEqual(minus(union(owned, unowned), new Set(['10,10'])));
  });

  it('a group with no art is a set of hot-spots on the pixels it owns', () => {
    const bare = syncImages({ 'map.bmp': image(10, 10, (x) => (x < 5 ? 0xff0033 : 0x123456)) });
    const v = viewOf([N('buttongroup', { id: 'g', left: 10, top: 10, mappingImage: 'map.bmp', image: 'gone.bmp' }, [N('buttonelement', { mappingColor: '#FF0033' })])], { images: bare, width: 30, height: 30 });
    expect(setOf(shapeOf(v, bare))).toEqual(rect(10, 10, 5, 10));
  });

  it('the owner map follows a changed mappingColor', () => {
    const v = skin({ showBackground: 'false' });
    const [first] = el(v, 'g').children;
    first.set('mappingColor', '#123456', 'script');
    expect(setOf(shapeOf(v, images, { opts: FAITHFUL }))).toEqual(union(rect(15, 10, 3, 10), rect(18, 10, 2, 10)));
  });
});

describe('what hides a pixel', () => {
  const images = syncImages({ 'b.bmp': solidImage(10, 10, 0x336699), 'sv.bmp': solidImage(10, 10, 0x224466) });

  it('a hidden element, and a hidden element\'s subtree, add nothing; showing it recomputes', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 10, top: 10, width: 20, height: 20, visible: 'false' }, [N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })]),
      N('button', { id: 'seen', left: 0, top: 0, image: 'b.bmp' }),
    ], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(0, 0, 10, 10));
    el(v, 'sv').set('visible', true, 'script');
    expect(setOf(shapeOf(v, images))).toEqual(union(rect(0, 0, 10, 10), rect(10, 10, 10, 10)));
  });

  it('a sized SUBVIEW crops its subtree to its box; a size-less one does not; the switch turns it off', () => {
    const kid = N('button', { id: 'btn', left: 8, top: 0, image: 'b.bmp' });
    const sized = viewOf([N('subview', { id: 'sv', left: 5, top: 5, width: 10, height: 10 }, [kid])], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(sized, images))).toEqual(rect(13, 5, 2, 10));
    expect(setOf(shapeOf(sized, images, { opts: { ...FAITHFUL, subviewClip: false } }))).toEqual(rect(13, 5, 10, 10));
    const sizeless = viewOf([N('subview', { id: 'sv', left: 5, top: 5 }, [kid])], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(sizeless, images))).toEqual(rect(13, 5, 10, 10));
  });

  it('crops every level of nesting, and the VIEW\'s own edge', () => {
    const v = viewOf([
      N('subview', { id: 'outer', left: 10, top: 10, width: 15, height: 15 }, [
        N('subview', { id: 'inner', left: 5, top: 5, width: 20, height: 20 }, [N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })]),
      ]),
      N('button', { id: 'edge', left: 25, top: 25, image: 'b.bmp' }),
    ], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(union(rect(15, 15, 10, 10), rect(25, 25, 5, 5)));
  });

  it('a clip mask removes the SUBVIEW\'s own clipped pixels and everything its children draw there', () => {
    const masked = syncImages({ 'sv.bmp': image(10, 10, (x) => (x < 5 ? 0x336699 : RED)), 'b.bmp': solidImage(10, 4, 0x888888) });
    const v = viewOf([
      N('subview', { id: 'sv', left: 10, top: 10, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [N('button', { id: 'btn', left: 0, top: 3, image: 'b.bmp', zIndex: 1 })]),
    ], { images: masked, width: 30, height: 30 });
    expect(setOf(shapeOf(v, masked))).toEqual(rect(10, 10, 5, 10));
  });

  it('a clip mask is not tiled: where the image ends, the subtree ends', () => {
    const masked = syncImages({ 'sv.bmp': solidImage(10, 10, 0x336699), 'b.bmp': solidImage(10, 10, 0x888888) });
    const v = viewOf([
      N('subview', { id: 'sv', left: 0, top: 0, width: 30, height: 10, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [N('button', { id: 'btn', left: 5, top: 0, image: 'b.bmp', zIndex: 1 })]),
    ], { images: masked, width: 30, height: 10 });
    expect(setOf(shapeOf(v, masked))).toEqual(rect(0, 0, 10, 10));
  });

  it('a VIEW\'s own clippingColor outlines the whole frame', () => {
    const masked = syncImages({ 'v.bmp': image(30, 30, (x) => (x < 20 ? 0x336699 : RED)), 'b.bmp': solidImage(30, 30, 0x888888) });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })], { images: masked, width: 30, height: 30, view: { backgroundImage: 'v.bmp', clippingColor: '#FF0000' } });
    expect(setOf(shapeOf(v, masked))).toEqual(rect(0, 0, 20, 30));
  });

  it('a clippingColor the skin did not declare clips nothing', () => {
    const red = syncImages({ 'sv.bmp': solidImage(10, 10, RED) });
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp' })], { images: red, width: 30, height: 30 });
    expect(setOf(shapeOf(v, red))).toEqual(rect(0, 0, 10, 10));
  });

  it('follows the model, so a moving element drags its pixels with it', () => {
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(0, 0, 10, 10));
    el(v, 'btn').set('left', 7, 'anim');
    el(v, 'btn').set('top', 20, 'anim');
    expect(setOf(shapeOf(v, images))).toEqual(rect(7, 20, 10, 10));
  });
});

describe('backgrounds', () => {
  it('a backgroundColor fills the box, under an image; the VIEW\'s default white fills the frame', () => {
    const images = syncImages({ 'k.bmp': image(10, 10, (x) => (x < 5 ? MAGENTA : 0x336699)) });
    const v = viewOf([N('subview', { id: 'sv', left: 5, top: 5, width: 10, height: 10, backgroundColor: '#112233', backgroundImage: 'k.bmp', transparencyColor: '#FF00FF' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(rect(5, 5, 10, 10)); // the colour shows through the keyed half
    const white = viewOf([], { images, width: 12, height: 12, view: { backgroundColor: '#FFFFFF' } });
    expect(setBits(shapeOf(white, images))).toBe(144);
  });

  it('a tiled background repeats to the box; an untiled one stops with the image; an image bigger than a sized box is cropped', () => {
    const images = syncImages({ 'tile.bmp': solidImage(3, 3, 0x336699) });
    const tiled = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 10, height: 10, backgroundImage: 'tile.bmp', backgroundTiled: 'true' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(tiled, images))).toEqual(rect(0, 0, 10, 10));
    const once = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 10, height: 10, backgroundImage: 'tile.bmp' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(once, images)).size).toBe(9);
    const cropped = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 2, height: 2, backgroundImage: 'tile.bmp' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(cropped, images))).toEqual(rect(0, 0, 2, 2));
    expect(setOf(shapeOf(cropped, images, { opts: { ...FAITHFUL, subviewClip: false } })).size).toBe(9);
  });
});

describe('sliders', () => {
  it('the thumb follows value; a tiled track keeps its end caps and repeats its middle; the foreground only adds paint', () => {
    const images = syncImages({
      // a 7-wide track image: columns 0 and 1 (caps, 2 px), column 2..4 middle, 5 and 6 caps; the middle column 3 is transparent
      'track.png': image(7, 4, (x) => (x === 3 ? [0, 0, 0, 0] : 0x445566)),
      'thumb.bmp': solidImage(2, 4, 0x778899),
      'fg.bmp': solidImage(30, 2, 0x99aabb),
    });
    const v = viewOf([
      N('slider', { id: 's', left: 0, top: 0, width: 20, height: 4, backgroundImage: 'track.png', thumbImage: 'thumb.bmp', tiled: 'true', borderSize: 2, min: 0, max: 100, value: 100 }),
    ], { images, width: 30, height: 10 });
    const s = setOf(shapeOf(v, images));
    // caps at x 0,1 and 18,19; the middle (x 2..17) repeats source columns 2,3,4: column 3 is clear, so x = 3, 6, 9, 12, 15 are
    for (const x of [0, 1, 18, 19, 2, 4, 5]) expect(s.has(`${x},0`), `x=${x}`).toBe(true);
    for (const x of [3, 6, 9, 12]) expect(s.has(`${x},0`), `x=${x}`).toBe(false);
    // value 100: the thumb (2 wide) is at x 18..19 and covers the rest of the cap
    expect(s.has('19,3')).toBe(true);
    el(v, 's').set('value', 17, 'script'); // round(0.17 * 18) = 3: the thumb moves onto the clear column
    expect(setOf(shapeOf(v, images)).has('3,0')).toBe(true);
    expect(setOf(shapeOf(v, images)).has('19,3')).toBe(true); // the cap it left is still the track's
    const withFg = viewOf([
      N('slider', { id: 's', left: 0, top: 0, width: 20, height: 4, backgroundImage: 'track.png', thumbImage: 'thumb.bmp', foregroundImage: 'fg.bmp', tiled: 'true', borderSize: 2 }),
    ], { images, width: 30, height: 10 });
    const f = setOf(shapeOf(withFg, images));
    expect(f.has('3,0')).toBe(true); // painted by the foreground (full reveal)
    expect(f.has('3,2')).toBe(false); // the foreground is only 2 rows tall
    expect(f.has('25,0')).toBe(false); // and only as wide as the slider's box
  });

  it('a slider with no track image but a backgroundColor fills its box; a thumb larger than the box is cut at its ends', () => {
    const images = syncImages({ 'thumb.bmp': solidImage(30, 30, 0x778899) });
    const colour = viewOf([N('slider', { id: 's', left: 5, top: 5, width: 10, height: 4, backgroundColor: '#336699' })], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(colour, images))).toEqual(rect(5, 5, 10, 4));
    const big = viewOf([N('slider', { id: 's', left: 5, top: 5, width: 10, height: 4, thumbImage: 'thumb.bmp' })], { images, width: 40, height: 40 });
    expect(setOf(shapeOf(big, images))).toEqual(rect(5, 5, 10, 4));
  });
});

describe('CUSTOMSLIDER', () => {
  it('paints the strip frame the value picks and takes hits on the map\'s grey pixels', () => {
    const images = syncImages({
      'pos.bmp': image(8, 8, (x) => (x < 4 ? 0x808080 : MAGENTA)),
      // three 8x8 frames side by side: frame 0 fills the left column, frame 1 the middle, frame 2 the right
      'strip.bmp': image(24, 8, (x) => (x % 8 === Math.floor(x / 8) * 3 ? 0x335577 : [0, 0, 0, 0])),
    });
    const v = viewOf([N('customslider', { id: 'dial', left: 10, top: 10, positionImage: 'pos.bmp', image: 'strip.bmp', min: 0, max: 100, value: 100 })], { images, width: 30, height: 30 });
    const s = setOf(shapeOf(v, images));
    // value 100 is the last frame (index 2): its painted column is 2*3 = 6 within the frame, which is a dead (magenta) pixel of the map
    expect(s.has('16,10')).toBe(true);
    // the grey half takes hits whether or not the frame painted there
    for (let x = 10; x < 14; x++) expect(s.has(`${x},12`), `x=${x}`).toBe(true);
    expect(s.has('15,12')).toBe(false);
    el(v, 'dial').set('value', 0, 'script');
    const first = setOf(shapeOf(v, images));
    expect(first.has('10,10')).toBe(true); // frame 0 paints its column 0
    expect(first.has('16,10')).toBe(false);
  });
});

describe('TEXT and slots', () => {
  const images = syncImages({ 'b.bmp': solidImage(10, 10, 0x336699) });

  it('a TEXT with something to show claims its box; an empty one only if it can be clicked', () => {
    const v = viewOf([
      N('text', { id: 'shown', left: 0, top: 0, width: 10, height: 5, value: 'x' }),
      N('text', { id: 'empty', left: 0, top: 10, width: 10, height: 5 }),
      N('text', { id: 'link', left: 0, top: 20, width: 10, height: 5, onClick: 'x();' }),
      N('text', { id: 'filled', left: 20, top: 0, width: 4, height: 4, backgroundColor: '#112233' }),
    ], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(union(union(rect(0, 0, 10, 5), rect(0, 20, 10, 5)), rect(20, 0, 4, 4)));
  });

  it('an EFFECTS slot adds its box, or the rects its host reports, and a VIDEO slot the same', () => {
    const v = viewOf([
      N('effects', { id: 'fx', left: 5, top: 5, width: 10, height: 10 }), N('video', { id: 'vid', left: 20, top: 20, width: 8, height: 8 }),
    ], { images, width: 30, height: 30 });
    expect(setOf(shapeOf(v, images))).toEqual(union(rect(5, 5, 10, 10), rect(20, 20, 8, 8)));
    const slots = slotsOf({ fx: [{ x: 6, y: 6, w: 4, h: 4 }, { x: 12, y: 12, w: 2, h: 2 }] });
    expect(setOf(shapeOf(v, images, { slots }))).toEqual(union(union(rect(6, 6, 4, 4), rect(12, 12, 2, 2)), rect(20, 20, 8, 8)));
    el(v, 'fx').set('visible', false, 'script');
    expect(setOf(shapeOf(v, images, { slots }))).toEqual(rect(20, 20, 8, 8));
  });

  it('a slot inside a clipping SUBVIEW is cropped by it, and by a clip mask', () => {
    const masked = syncImages({ 'sv.bmp': image(10, 10, (x) => (x < 5 ? 0x336699 : RED)) });
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [N('effects', { id: 'fx', left: 0, top: 0, width: 20, height: 20, zIndex: 1 })])], { images: masked, width: 30, height: 30 });
    expect(setOf(shapeOf(v, masked))).toEqual(rect(0, 0, 5, 10));
  });

  it('a windowed PLAYLIST adds exactly its reported rects, ignoring the clipping above it, and is gone when hidden', () => {
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 5, height: 5 }, [N('playlist', { id: 'pl', left: 0, top: 0, width: 12, height: 12 })])], { images, width: 30, height: 30 });
    const slots = slotsOf({ pl: [{ x: 2, y: 2, w: 12, h: 12 }, { x: 2, y: 14, w: 12, h: 4 }] });
    expect(setOf(shapeOf(v, images, { slots }))).toEqual(union(rect(2, 2, 12, 12), rect(2, 14, 12, 4)));
    expect(setBits(shapeOf(v, images))).toBe(0); // no slot reported: nothing to add (and the floor, off here, would make it the full rect)
    el(v, 'sv').set('visible', false, 'script');
    expect(setBits(shapeOf(v, images, { slots }))).toBe(0);
  });
});

describe('the budget', () => {
  it('stops after the pixel budget with one diagnostic and keeps what it had', () => {
    const images = syncImages({ 'big.bmp': solidImage(100, 100, 0x336699) });
    const v = viewOf(Array.from({ length: 5 }, (_, i) => N('button', { id: `b${i}`, left: i * 10, top: 0, image: 'big.bmp' })), { images, width: 200, height: 100 });
    const out = rasterizeShapeWithDiagnostics(v, images, slotsOf(), FAITHFUL, { budget: 25_000 });
    expect(out.diagnostics.map((d) => d.code)).toEqual(['shape-budget']);
    const s = /** @type {any} */ (out.shape);
    // each button looks at 100 x 100 = 10,000 pixels; two fit in 25,000, the third would cross it. Two buttons 10 px apart cover 110 x 100.
    expect(setBits(s)).toBe(11_000);
    expect(bitOf(s, 5, 5)).toBe(1);
    expect(SHAPE_PIXEL_BUDGET).toBeGreaterThan(10_000_000);
  });
});

describe('the shape and the picker agree', () => {
  it.each([['faithful', FAITHFUL], ['oracle-compat', ORACLE_COMPAT]])('every pixel the picker finds an element on is in the %s shape', (_name, opts) => {
    const half = (left, right) => image(12, 12, (x) => (x < 6 ? left : right));
    const images = syncImages({
      'bg.bmp': image(60, 40, (x, y) => (x > 50 && y > 30 ? RED : 0x202020)),
      'k.bmp': half(MAGENTA, 0x336699), 'map.bmp': half(0xff0033, 0x123456), 'g.bmp': half(0x445566, MAGENTA),
      'sv.bmp': image(16, 16, (x) => (x < 8 ? 0x224466 : RED)), 'thumb.bmp': half(MAGENTA, 0x667788), 'track.bmp': solidImage(20, 4, 0x556677),
    });
    const v = viewOf([
      N('button', { id: 'btn', left: 2, top: 2, image: 'k.bmp', transparencyColor: '#FF00FF' }),
      N('buttongroup', { id: 'g', left: 20, top: 2, mappingImage: 'map.bmp', image: 'g.bmp', transparencyColor: '#FF00FF' }, [N('buttonelement', { id: 'e1', mappingColor: '#FF0033' })]),
      N('subview', { id: 'sv', left: 40, top: 2, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [N('button', { id: 'inner', left: 4, top: 4, width: 12, height: 8, zIndex: 1 })]),
      N('slider', { id: 's', left: 2, top: 20, backgroundImage: 'track.bmp', thumbImage: 'thumb.bmp', transparencyColor: '#FF00FF', value: 50 }),
      N('effects', { id: 'fx', left: 30, top: 20, width: 10, height: 10 }),
      N('text', { id: 't', left: 2, top: 30, width: 10, height: 6, value: 'hi' }),
    ], { images, width: 60, height: 40, view: { backgroundImage: 'bg.bmp', clippingColor: '#FF0000' } });
    const s = shapeOf(v, images, { opts });
    let picked = 0;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 60; x++) {
        const p = pick(v, images, slotsOf(), x, y, opts);
        if (!p) continue;
        picked++;
        expect(bitOf(s, x, y), `(${x},${y}) picks ${p.el.id} ${p.role}`).toBe(1);
      }
    }
    expect(picked).toBeGreaterThan(500);
    // and the other way round, a pixel the shape has that nothing takes is only ever paint without a hit
    expect(setBits(s)).toBeGreaterThanOrEqual(picked);
  });
});

describe('skin strings are never keys of a plain object (E §1 rule 6)', () => {
  it('ids and refs named __proto__ or constructor are ordinary in the shape too', () => {
    const art = solidImage(10, 10, 0x336699);
    const images = syncImages(new Map([['__proto__', art], ['constructor', art]]));
    const v = viewOf([N('button', { id: '__proto__', left: 0, top: 0, image: '__proto__' }), N('button', { id: 'constructor', left: 10, top: 0, image: 'constructor' })], { images, width: 20, height: 10 });
    expect(setBits(shapeOf(v, images))).toBe(200);
  });
});
