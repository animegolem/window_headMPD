// @ts-check
// Alignment anchors and relayout (E §5.11 `recordAnchors`, `relayout`; E D5 "After the pass,
// `layout/align` records each element's margins"; spec 5.1 `horizontalAlignment`,
// `verticalAlignment`).
//
// The `jscript:` pass places an element once (`left="jscript:view.width-121"`), and the alignment
// attribute is what keeps it there when the parent grows or shrinks: `right` keeps the right
// margin, `center` the offset from the parent's centre, `stretch` both margins, `left` (and `top`)
// the origin. Phase 1 never resizes a view (E D7.3); the phase-3 host calls `relayout`.
//
// What is recorded. Not a list of margins that a later move would make stale, but the size each
// container's children were placed for: `recordAnchors` notes every element's width and height as
// they stand after the pass, and `relayout` applies the change from that size to the new one to each
// child, according to the child's alignment. So the margins are always the child's current ones
// (`marginsOf`): a drawer a script slid with `moveTo` keeps its distance from the right edge from
// where it is, not from where the pass put it, and a view whose script wrote `view.width` without
// the host following (Headspace's 549, `parity` D13) moves nothing until a relayout is asked for
// a size that really differs from the one the children were placed for.
//
// Containers settle top-down. A stretched SUBVIEW has its new size before its own children are
// placed, so a right-aligned child of a stretched SUBVIEW follows the SUBVIEW's edge.
//
// Fractions. A centred element moves by half the change, which is a half pixel for an odd change,
// and the model stores whole pixels. The exact value `relayout` last wrote is remembered beside the
// stored one and used for the next relayout as long as the stored value is still what was written,
// so a view that grows by one pixel and shrinks by one comes back to where it started instead of
// drifting.
//
// `right` and `bottom` (WMP 11: distance to the parent's edge, "undefined when width is not
// specified") are not read; no corpus skin has them among its commonest attributes.
//
// Writes go through `ElementModel.set` with origin 'layout', so each changed value marks the
// element dirty and queues its `<attr>_onchange` handler like any other change. This module has no
// state beyond two weak maps keyed by element, so a view that is dropped takes its records with it.

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */

/**
 * The size an element's children were last placed for.
 * @type {WeakMap<ElementModel, { w: number, h: number }>}
 */
const placedFor = new WeakMap();

/**
 * The exact value `relayout` wrote for a geometry attribute, with the whole-pixel value the model
 * stored for it. Valid while the model still holds `stored`.
 * @type {WeakMap<ElementModel, Map<string, { stored: number, exact: number }>>}
 */
const exactOf = new WeakMap();

/** @param {ElementModel} el @returns {{ w: number, h: number } | null} */
function sizeOf(el) {
  const w = el.get('width');
  const h = el.get('height');
  return typeof w === 'number' && typeof h === 'number' ? { w, h } : null;
}

/** @param {ElementModel} el */
function capture(el) {
  const size = sizeOf(el);
  if (size) placedFor.set(el, size);
}

/** @param {ElementModel} el @param {string} attr @returns {number} */
function read(el, attr) {
  const v = /** @type {number} */ (el.get(attr));
  const kept = exactOf.get(el)?.get(attr);
  return kept !== undefined && kept.stored === v ? kept.exact : v;
}

/** @param {ElementModel} el @param {string} attr @param {number} value */
function write(el, attr, value) {
  el.set(attr, value, 'layout');
  let kept = exactOf.get(el);
  if (Number.isInteger(value)) {
    kept?.delete(attr);
    return;
  }
  if (!kept) exactOf.set(el, (kept = new Map()));
  kept.set(attr, { stored: /** @type {number} */ (el.get(attr)), exact: value });
}

/** @param {ElementModel} el @param {'left' | 'top'} attr @param {number} by */
function shift(el, attr, by) {
  if (by !== 0) write(el, attr, read(el, attr) + by);
}

/** @param {ElementModel} el @param {'width' | 'height'} attr @param {number} by */
function grow(el, attr, by) {
  if (by !== 0) write(el, attr, Math.max(0, read(el, attr) + by));
}

/** @param {ElementModel} el @param {string} attr @returns {string} lower case; '' when the kind has no such attribute */
function alignOf(el, attr) {
  const v = el.get(attr);
  return typeof v === 'string' ? v.toLowerCase() : '';
}

/**
 * Re-place one element for the change in its parent's size.
 * @param {ElementModel} el @param {{ dw: number, dh: number }} d
 */
function place(el, d) {
  if (typeof el.get('left') !== 'number' || typeof el.get('width') !== 'number') return;
  switch (alignOf(el, 'horizontalalignment')) {
    case 'right': shift(el, 'left', d.dw); break;
    case 'center': shift(el, 'left', d.dw / 2); break;
    case 'stretch': grow(el, 'width', d.dw); break;
    default: break;
  }
  switch (alignOf(el, 'verticalalignment')) {
    case 'bottom': shift(el, 'top', d.dh); break;
    case 'center': shift(el, 'top', d.dh / 2); break;
    case 'stretch': grow(el, 'height', d.dh); break;
    default: break;
  }
}

/**
 * Note the size every element's children are placed for, after the `jscript:` pass. Calling it
 * again re-bases on the geometry as it stands.
 * @type {import('../contracts').RecordAnchorsFn}
 */
export const recordAnchors = (view) => {
  for (const el of view.elements) capture(el);
};

/**
 * Resize the VIEW to `w` x `h` and re-place every descendant by its alignment, parents first. The
 * VIEW takes the size through the model, which applies its size cap, and the descendants follow the
 * size it actually took. A size equal to the one the children were placed for changes nothing.
 * @type {import('../contracts').RelayoutFn}
 */
export const relayout = (view, w, h) => {
  const root = view.view;
  // Whatever recordAnchors did not see is recorded now, before the VIEW moves.
  for (const el of view.elements) if (!placedFor.has(el)) capture(el);

  if (Number.isFinite(w)) root.set('width', Math.max(0, w), 'layout');
  if (Number.isFinite(h)) root.set('height', Math.max(0, h), 'layout');

  /** @type {Map<ElementModel, { dw: number, dh: number }>} change in each container's size since its children were placed */
  const deltas = new Map();
  for (const el of view.elements) {
    if (el !== root) {
      const d = el.parent ? deltas.get(el.parent) : undefined;
      if (d) place(el, d);
    }
    if (el.children.length === 0) continue;
    const was = placedFor.get(el);
    const size = sizeOf(el);
    if (!size) continue;
    placedFor.set(el, size);
    if (was && (size.w !== was.w || size.h !== was.h)) deltas.set(el, { dw: size.w - was.w, dh: size.h - was.h });
  }
};

/**
 * An element's margins to its parent's edges, measured against the size the parent's children were
 * placed for: `right` is the parent's width minus the element's right edge. Null for an element
 * with no geometry, or one that has not been recorded. For inspection and tests.
 * @param {ElementModel} el
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
export function marginsOf(el) {
  const parent = el.parent ? placedFor.get(el.parent) : undefined;
  const size = sizeOf(el);
  const left = el.get('left');
  const top = el.get('top');
  if (!parent || !size || typeof left !== 'number' || typeof top !== 'number') return null;
  return { left, top, right: parent.w - left - size.w, bottom: parent.h - top - size.h };
}
