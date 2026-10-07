// @ts-check
// The frame shape (E §5.11 `rasterizeShape`; E D2 "Window shape"): a 1-bit mask of the view, set where
// the skin has something and clear where a click should pass to the desktop. Pure; the caller sends it
// to the host only when its hash changes, and calls this again whenever something shape-relevant
// moved, animations included.
//
// A pixel is in the shape when some visible element paints it, or when an interactive element takes a
// hit on it (a keyed BUTTON pixel is not drawn but still takes its clicks, so the OS must deliver them,
// spec 2.7). That is `paint ∪ (hit if interactive)` over the claims of `shape/scene.js`, clipped by
// every ancestor's box and clip mask. A `passThrough` element adds what it paints and no hits. Hidden
// subtrees add nothing. Host slots and native child windows add the rects their slots report, and the
// latter ignore ancestor clipping (spec 2.8).
//
// Bit layout: row-major, least significant bit first, no padding between rows, the layout of the keyed
// planes and of the oracle's mask (`headcore::hit` reads the same). The mask is `width x height` of the
// VIEW, or of `size` when the caller says the frame is a different size than the model's (E D7.3: a
// script write of `view.width` updates the model but not the host's frame).
//
// A shape with fewer than 64 bits set is replaced by the full view rect plus a diagnostic, so a skin
// whose pixels are all transparent cannot make itself unreachable (E §10). The full rect is sent as
// `bits` like any other shape, not as a region: the host's last-shape hash and the oracle comparison
// then see one kind of shape.
//
// `rasterizeShape` is the contract's function and returns the shape alone. The diagnostic it cannot
// return comes out of `rasterizeShapeWithDiagnostics`, which the view runtime should call.

import { HIT, PAINT, WINDOWED_KINDS, claimsOf, containerInfo, createScene, isInteractive, isPassThrough, isVisible, num, windowedLayer } from './scene.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../contracts').MaskShape} MaskShape */
/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./scene.js').Claim} Claim */
/** @typedef {import('./scene.js').ContainerInfo} ContainerInfo */

/** Fewer set bits than this and the skin is taken to have made itself unreachable (E §10). */
export const MIN_SHAPE_BITS = 64;

/**
 * Most pixels one rasterisation will look at. A hostile skin can stack thousands of full-size elements;
 * the shape is recomputed every frame, so the work is bounded and the rest is left out with a
 * diagnostic. Real skins use well under one percent of it.
 */
export const SHAPE_PIXEL_BUDGET = 32 * 1024 * 1024;

/**
 * @typedef {Object} Raster
 * @property {Uint8Array} bits
 * @property {number} w
 * @property {number} h
 * @property {number} visits
 * @property {number} budget
 * @property {boolean} stopped
 */

/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Bounds */

/** @param {Array<(x: number, y: number) => boolean>} clips @param {number} x @param {number} y */
const clippedBy = (clips, x, y) => {
  for (const clip of clips) if (clip(x, y)) return true;
  return false;
};

/**
 * OR one claim into the raster: the pixels inside `bounds` and the claim's own rect whose `at` has a
 * `want` bit, and no clip mask hides.
 * @param {Raster} r @param {Claim} claim @param {number} want @param {Bounds} bounds
 * @param {Array<(x: number, y: number) => boolean>} clips
 */
function add(r, claim, want, bounds, clips) {
  const x0 = Math.max(claim.x, bounds.x0);
  const y0 = Math.max(claim.y, bounds.y0);
  const x1 = Math.min(claim.x + claim.w, bounds.x1);
  const y1 = Math.min(claim.y + claim.h, bounds.y1);
  if (x1 <= x0 || y1 <= y0 || r.stopped) return;
  const area = (x1 - x0) * (y1 - y0);
  if (r.visits + area > r.budget) {
    r.stopped = true;
    return;
  }
  r.visits += area;
  for (let y = y0; y < y1; y++) {
    const row = y * r.w;
    for (let x = x0; x < x1; x++) {
      if ((claim.at(x, y) & want) === 0) continue;
      const i = row + x;
      if ((r.bits[i >> 3] >> (i & 7)) & 1) continue;
      if (clips.length && clippedBy(clips, x, y)) continue;
      r.bits[i >> 3] |= 1 << (i & 7);
    }
  }
}

/**
 * @param {Scene} scene @param {Raster} r @param {ElementModel} container @param {number} ox @param {number} oy
 * @param {ContainerInfo} info @param {Bounds} bounds the frame and every ancestor's active box
 * @param {Array<(x: number, y: number) => boolean>} clips every ancestor's clip mask, this one included
 */
function visit(scene, r, container, ox, oy, info, bounds, clips) {
  for (const entry of scene.view.paintOrder(container)) {
    if (r.stopped) return;
    if (entry === 'background') {
      const hits = isInteractive(container) && !isPassThrough(container);
      for (const c of info.claims) add(r, c, PAINT | (hits ? HIT : 0), bounds, clips);
      continue;
    }

    const el = entry;
    if (!isVisible(el) || WINDOWED_KINDS.has(el.kind)) continue;
    const ex = ox + num(el.get('left'));
    const ey = oy + num(el.get('top'));

    if (el.kind === 'subview') {
      const sub = containerInfo(scene, el, ex, ey);
      const b = sub.box;
      /** @type {Bounds} */
      const inner = b
        ? { x0: Math.max(bounds.x0, b.x), y0: Math.max(bounds.y0, b.y), x1: Math.min(bounds.x1, b.x + b.w), y1: Math.min(bounds.y1, b.y + b.h) }
        : bounds;
      if (inner.x1 <= inner.x0 || inner.y1 <= inner.y0) continue;
      visit(scene, r, el, ex, ey, sub, inner, sub.clipAt ? [...clips, sub.clipAt] : clips);
      continue;
    }

    const want = PAINT | (isInteractive(el) && !isPassThrough(el) ? HIT : 0);
    for (const c of claimsOf(scene, el, ex, ey)) add(r, c, want, bounds, clips);
  }
}

/** Set bits per byte value. */
const ONES = Uint8Array.from({ length: 256 }, (_, v) => {
  let n = 0;
  for (let b = v; b; b >>= 1) n += b & 1;
  return n;
});

/** @param {Uint8Array} bits @param {number} n pixels */
function popcount(bits, n) {
  let total = 0;
  const whole = n >> 3;
  for (let i = 0; i < whole; i++) total += ONES[bits[i]];
  for (let i = whole << 3; i < n; i++) total += (bits[i >> 3] >> (i & 7)) & 1;
  return total;
}

/** Every one of `n` pixels set, and no stray bits past the last. @param {number} n */
function fullBits(n) {
  const bits = new Uint8Array((n + 7) >> 3);
  bits.fill(0xff);
  if (n & 7) bits[bits.length - 1] = (1 << (n & 7)) - 1;
  return bits;
}

/**
 * The shape and what it has to say. `size` overrides the VIEW's own width and height; `budget` and
 * `minBits` replace the pixel budget and the unreachable-skin threshold (for tests).
 * @param {import('../contracts').ViewModel} view
 * @param {import('../contracts').ImageService} images
 * @param {(el: ElementModel) => import('../contracts').Rect[]} slotRects
 * @param {import('../contracts').EngineOptions} opts
 * @param {{ size?: { width: number, height: number }, budget?: number, minBits?: number }} [extra]
 * @returns {{ shape: MaskShape, diagnostics: Diagnostic[] }}
 */
export function rasterizeShapeWithDiagnostics(view, images, slotRects, opts, extra = {}) {
  const scene = createScene(view, images, slotRects, opts, extra.size);
  const { width: w, height: h } = scene;
  const n = w * h;
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {Raster} */
  const r = { bits: new Uint8Array((n + 7) >> 3), w, h, visits: 0, budget: extra.budget ?? SHAPE_PIXEL_BUDGET, stopped: false };

  if (n > 0) {
    // Native child windows first: they take no clipping and need no order, since the shape is a union.
    /** @type {Bounds} */
    const frame = { x0: 0, y0: 0, x1: w, y1: h };
    for (const { claims } of windowedLayer(scene)) for (const c of claims) add(r, c, PAINT | HIT, frame, []);

    const root = view.view;
    const info = containerInfo(scene, root, 0, 0);
    visit(scene, r, root, 0, 0, info, frame, info.clipAt ? [info.clipAt] : []);
  }
  if (r.stopped) {
    diagnostics.push({
      code: 'shape-budget', severity: 'warn', elementId: view.view.id,
      detail: `the shape looked at more than ${r.budget} pixels; the elements after that point are left out of it`,
    });
  }

  let bits = r.bits;
  const floor = extra.minBits ?? MIN_SHAPE_BITS;
  if (popcount(bits, n) < floor) {
    bits = fullBits(n);
    diagnostics.push({
      code: 'shape-empty', severity: 'warn', elementId: view.view.id,
      detail: `the view paints fewer than ${floor} pixels; the shape is the full ${w}x${h} view so the skin stays reachable`,
    });
  }
  return { shape: { kind: 'bits', width: w, height: h, bits }, diagnostics };
}

/** @type {import('../contracts').RasterizeShapeFn} */
export const rasterizeShape = (view, images, slotRects, opts) =>
  rasterizeShapeWithDiagnostics(view, images, slotRects, opts).shape;
