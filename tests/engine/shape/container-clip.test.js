// @ts-check
// WAVES 5F.9: the shape and the picker read a container's clip mask the way `render/dom/container.js`
// draws it (5F.5). A `backgroundTiled` container repeats its tile-sized mask over its box, and a VIEW
// whose clip keeps no pixel is not masked at all (Gorillaz: a 50x28 tile that is entirely the clipping
// colour, under a head its children draw), while a SUBVIEW with the same background stays masked
// (parity D26). Models come from synthetic raw trees and the expected sets from the fixture data, never
// from art; the same rules are checked in Chromium by `tools/skinlab/fixtures/view-frame.case.js`.
import { describe, expect, it } from 'vitest';
import { pick } from '../../../src/engine/input/picker.js';
import { rasterizeShapeWithDiagnostics } from '../../../src/engine/shape/mask.js';
import { containerInfo, createScene } from '../../../src/engine/shape/scene.js';
import { FAITHFUL, N, ORACLE_COMPAT, RED, el, image, setBits, setOf, slotsOf, solidImage, syncImages, viewOf } from './support.js';

const BLUE = 0x336699;

/** A 4x4 tile whose last column is the clipping colour. */
const striped = () => image(4, 4, (x) => (x === 3 ? RED : BLUE));
/** A 4x4 tile that keeps nothing. */
const allClip = () => solidImage(4, 4, RED);
/** A 4x4 tile that keeps the single pixel (1,1). */
const oneKept = () => image(4, 4, (x, y) => (x === 1 && y === 1 ? BLUE : RED));

/**
 * The shape of a view as a plain object with bits. The 64-bit floor is off unless `minBits` says so, so
 * a test can look at a small shape as it is.
 * @param {import('../../../src/engine/contracts').ViewModel} view @param {import('./support.js').SyncImages} images
 * @param {{ opts?: import('../../../src/engine/contracts').EngineOptions, minBits?: number }} [o]
 */
function shapeOf(view, images, o = {}) {
  const out = rasterizeShapeWithDiagnostics(view, images, slotsOf(), o.opts ?? FAITHFUL, { minBits: o.minBits ?? 0 });
  if (out.shape.kind !== 'bits') throw new Error('phase 1 shapes are bits');
  return { shape: out.shape, diagnostics: out.diagnostics };
}

/**
 * The set of "x,y" in a rectangle that `keep(x - x0, y - y0)` accepts.
 * @param {number} x0 @param {number} y0 @param {number} w @param {number} h @param {(lx: number, ly: number) => boolean} [keep]
 */
function rectWhere(x0, y0, w, h, keep = () => true) {
  /** @type {Set<string>} */
  const out = new Set();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) out.add(`${x0 + x},${y0 + y}`);
  return out;
}

/** @param {import('../../../src/engine/contracts').ViewModel} view @param {import('./support.js').SyncImages} images */
const containerOf = (view, images, id = view.view.id) => {
  const scene = createScene(view, images, slotsOf(), FAITHFUL);
  const e = el(view, id);
  return { scene, e };
};

const TILED = { backgroundImage: 'tile.bmp', backgroundTiled: 'true', clippingColor: '#FF0000' };
const UNTILED = { backgroundImage: 'tile.bmp', clippingColor: '#FF0000' };

describe('a tiled container repeats its clip mask over its box (5F.9)', () => {
  const images = syncImages({ 'tile.bmp': striped(), 'cover.bmp': solidImage(40, 40, 0x888888) });

  it('a tiled SUBVIEW hides the clipping column of every tile, measured from its own corner', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 5, top: 3, width: 10, height: 9, ...TILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    expect(setOf(shapeOf(v, images).shape)).toEqual(rectWhere(5, 3, 10, 9, (lx) => lx % 4 !== 3));
  });

  it('an untiled SUBVIEW keeps the one-tile mask: past the first tile the subtree is hidden', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 5, top: 3, width: 10, height: 9, ...UNTILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    expect(setOf(shapeOf(v, images).shape)).toEqual(rectWhere(5, 3, 4, 4, (lx) => lx !== 3));
  });

  it('a tiled VIEW wraps the same way over the whole frame', () => {
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp' })], { images, width: 18, height: 10, view: TILED });
    expect(setOf(shapeOf(v, images).shape)).toEqual(rectWhere(0, 0, 18, 10, (lx) => lx % 4 !== 3));
  });

  it('wraps rows as well as columns, and a lone kept pixel repeats on the tile grid', () => {
    const lone = syncImages({ 'tile.bmp': oneKept(), 'cover.bmp': solidImage(40, 40, 0x888888) });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp' })], { images: lone, width: 18, height: 10, view: TILED });
    expect(setOf(shapeOf(v, lone).shape)).toEqual(rectWhere(0, 0, 18, 10, (lx, ly) => lx % 4 === 1 && ly % 4 === 1));
    // untiled, the same single pixel is the whole shape: a VIEW that keeps something is still masked
    const one = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp' })], { images: lone, width: 18, height: 10, view: UNTILED });
    expect(setOf(shapeOf(one, lone).shape)).toEqual(new Set(['1,1']));
  });

  it('a tiled container with no area cannot tile, so it keeps the one-tile mask (as the renderer does)', () => {
    const v = viewOf([
      // an explicit 0x0: a SUBVIEW that writes no size takes its background image's (4x4), which can tile
      N('subview', { id: 'sv', left: 0, top: 0, width: 0, height: 0, ...TILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    expect(el(v, 'sv').get('width')).toBe(0);
    expect(setOf(shapeOf(v, images).shape)).toEqual(rectWhere(0, 0, 4, 4, (lx) => lx !== 3));
  });

  it('the repeated mask covers the box and nothing past it, even where the box itself does not clip', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 5, top: 3, width: 10, height: 9, ...TILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    const open = { ...FAITHFUL, subviewClip: false };
    expect(setOf(shapeOf(v, images, { opts: open }).shape)).toEqual(rectWhere(5, 3, 10, 9, (lx) => lx % 4 !== 3));
  });

  it('follows a script that turns tiling off and on again', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 0, top: 0, width: 10, height: 8, ...TILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    const tiled = rectWhere(0, 0, 10, 8, (lx) => lx % 4 !== 3);
    expect(setOf(shapeOf(v, images).shape)).toEqual(tiled);
    el(v, 'sv').set('backgroundtiled', false, 'script');
    expect(setOf(shapeOf(v, images).shape)).toEqual(rectWhere(0, 0, 4, 4, (lx) => lx !== 3));
    el(v, 'sv').set('backgroundtiled', true, 'script');
    expect(setOf(shapeOf(v, images).shape)).toEqual(tiled);
  });

  it.each([['faithful', FAITHFUL], ['oracle-compat', ORACLE_COMPAT]])('the picker finds the same pixels as the %s shape, on the tile grid', (_name, opts) => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 5, top: 3, width: 14, height: 9, ...TILED }, [N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 30, height: 20 });
    const shape = shapeOf(v, images, { opts }).shape;
    const want = rectWhere(5, 3, 14, 9, (lx) => lx % 4 !== 3);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 30; x++) {
        const p = pick(v, images, slotsOf(), x, y, opts);
        expect(p !== null, `(${x},${y})`).toBe(want.has(`${x},${y}`));
        if (p) expect(setOf(shape).has(`${x},${y}`), `(${x},${y}) is picked but not in the shape`).toBe(true);
      }
    }
  });

  it('asks the mask about the container\'s own corner: nothing before it, and a repeat after it', () => {
    const v = viewOf([N('subview', { id: 'sv', left: 5, top: 3, width: 10, height: 9, ...TILED })], { images, width: 30, height: 20 });
    const { scene, e } = containerOf(v, images, 'sv');
    const clipAt = containerInfo(scene, e, 5, 3).clipAt;
    expect(clipAt).not.toBeNull();
    const at = /** @param {number} x @param {number} y */ (x, y) => /** @type {(x: number, y: number) => boolean} */ (clipAt)(x, y);
    expect([at(5, 3), at(7, 3), at(8, 3), at(9, 3), at(12, 3), at(5, 7), at(8, 10)]).toEqual([false, false, true, false, true, false, true]);
    expect([at(4, 3), at(5, 2), at(-9, -9)]).toEqual([true, true, true]);
  });
});

describe('a VIEW whose clip keeps no pixel is not masked; a SUBVIEW is (5F.9)', () => {
  const images = syncImages({ 'tile.bmp': allClip(), 'cover.bmp': solidImage(10, 8, 0x888888) });
  const COVER = { id: 'btn', left: 2, top: 2, image: 'cover.bmp' };
  const cover = rectWhere(2, 2, 10, 8);

  it.each([['tiled', TILED], ['untiled', UNTILED]])('a %s all-clip VIEW leaves its children on the frame, with no clipAt at all', (_name, bg) => {
    const v = viewOf([N('button', COVER)], { images, width: 40, height: 30, view: bg });
    const out = shapeOf(v, images, { minBits: 64 });
    expect(setOf(out.shape)).toEqual(cover);
    expect(out.diagnostics).toEqual([]); // not the full-rect fallback of a shape that came out empty
    const { scene, e } = containerOf(v, images);
    expect(containerInfo(scene, e, 0, 0).clipAt).toBeNull();
  });

  it('the picker reaches the children of an all-clip VIEW instead of finding nothing anywhere', () => {
    const v = viewOf([N('button', COVER)], { images, width: 40, height: 30, view: TILED });
    expect(pick(v, images, slotsOf(), 5, 5, FAITHFUL)?.el.id).toBe('btn');
    expect(pick(v, images, slotsOf(), 30, 20, FAITHFUL)).toBeNull();
  });

  it('an all-clip VIEW still paints its backgroundColor over the whole frame, in both configurations', () => {
    const v = viewOf([N('button', COVER)], { images, width: 40, height: 30, view: { ...TILED, backgroundColor: '#112233' } });
    for (const opts of [FAITHFUL, ORACLE_COMPAT]) expect(setBits(shapeOf(v, images, { opts }).shape)).toBe(40 * 30);
  });

  it.each([['tiled', TILED], ['untiled', UNTILED]])('a %s all-clip SUBVIEW hides itself and its children, whatever its size', (_name, bg) => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 20, top: 2, width: 15, height: 12, ...bg }, [N('button', { id: 'inner', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
      N('button', COVER),
    ], { images, width: 40, height: 30 });
    expect(setOf(shapeOf(v, images).shape)).toEqual(cover);
    expect(pick(v, images, slotsOf(), 22, 4, FAITHFUL)).toBeNull();
    expect(pick(v, images, slotsOf(), 5, 5, FAITHFUL)?.el.id).toBe('btn');
    const { scene, e } = containerOf(v, images, 'sv');
    expect(containerInfo(scene, e, 20, 2).clipAt).not.toBeNull();
  });

  it('a VIEW with one kept pixel in its tile is still masked', () => {
    const lone = syncImages({ 'tile.bmp': oneKept(), 'cover.bmp': solidImage(10, 8, 0x888888) });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp' })], { images: lone, width: 10, height: 8, view: UNTILED });
    const { scene, e } = containerOf(v, lone);
    expect(containerInfo(scene, e, 0, 0).clipAt).not.toBeNull();
  });

  it('follows a script that gives the VIEW a different background', () => {
    const swap = syncImages({ 'tile.bmp': allClip(), 'two.bmp': striped(), 'cover.bmp': solidImage(10, 8, 0x888888) });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'cover.bmp' })], { images: swap, width: 10, height: 8, view: UNTILED });
    expect(setOf(shapeOf(v, swap).shape)).toEqual(rectWhere(0, 0, 10, 8));
    v.view.set('backgroundimage', 'two.bmp', 'script');
    expect(setOf(shapeOf(v, swap).shape)).toEqual(rectWhere(0, 0, 4, 4, (lx) => lx !== 3));
  });
});

describe('skin strings are never keys of a plain object (E §1 rule 6)', () => {
  it('a tiled background named __proto__ or constructor is an ordinary image', () => {
    const art = striped();
    const images = syncImages(new Map([['__proto__', art], ['constructor', art], ['cover.bmp', solidImage(20, 8, 0x888888)]]));
    const v = viewOf([
      N('subview', { id: '__proto__', left: 0, top: 0, width: 8, height: 8, backgroundImage: '__proto__', backgroundTiled: 'true', clippingColor: '#FF0000' }, [N('button', { id: 'a', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
      N('subview', { id: 'constructor', left: 10, top: 0, width: 8, height: 8, backgroundImage: 'constructor', backgroundTiled: 'true', clippingColor: '#FF0000' }, [N('button', { id: 'b', left: 0, top: 0, image: 'cover.bmp', zIndex: 1 })]),
    ], { images, width: 20, height: 8 });
    const keep = (/** @type {number} */ lx) => lx % 4 !== 3;
    expect(setOf(shapeOf(v, images).shape)).toEqual(new Set([...rectWhere(0, 0, 8, 8, keep), ...rectWhere(10, 0, 8, 8, keep)]));
  });
});
