// @ts-check
// Paint order inside one stacking context (E §5.11 `paintOrder`; E D2 "Paint order is DOM order";
// E D5 "Stacking", Reading C; spec 5.3). The renderer builds one DOM node per entry in the order
// returned here, so the first entry paints first (bottom) and the last paints on top.
//
// Reading C: every SUBVIEW is a stacking context. Inside one context the children are sorted by
// `(zIndex, kind, docIndex)`, the context's own background has the fixed slot `(0, 0)` and every
// child has kind 1. So a child at `zIndex=0` paints over the background, a negative one under it
// (Headspace's screen at -2 and drop at -1 show through the head's magenta hole), and equal z is
// source order with the later tag on top (U-1). A nested SUBVIEW is one entry in its parent's
// list: its own children are sorted in its own call, which is what keeps contexts from
// interleaving.
//
// Only elements that draw something are listed. PLAYER, CONTROLS, EQUALIZERSETTINGS, inert unknown
// tags and the like have no pixels; a BUTTONELEMENT is painted by its BUTTONGROUP at the group's
// z (spec 5.3), so it never appears on its own. A PLAYLIST has no `zIndex` in the attribute table
// (it is a windowed control, spec 2.8) and so reads as 0.
//
// `stacking: 'flat'` is Reading B, kept as the diagnostic switch of D5: a child's absolute z is
// its ancestors' z plus its own, and everything below the container sorts together. In that list a
// SUBVIEW entry stands for that subview's own background only, and its children are listed beside
// it. The renderer does not build that shape; the mode exists so a test can show why B fails
// Headspace.

/** @typedef {import('../contracts').ElementModel} ElementModel */

/** @type {ReadonlySet<string>} */
const PAINTED_KINDS = new Set([
  'subview', 'button', 'buttongroup', 'slider', 'customslider', 'progressbar', 'text', 'effects', 'video',
  'playlist', 'editbox', 'listbox', 'popup',
]);

/** Kinds that open a stacking context and own a background. */
const CONTEXT_KINDS = new Set(['view', 'subview']);

/** True for the kinds that appear in a paint-order list. @param {string} kind */
export const isPaintedKind = (kind) => PAINTED_KINDS.has(kind);

/**
 * The element's zIndex as a number. An attribute the kind does not declare reads back as text or
 * null, and that is "no z".
 * @param {ElementModel} el
 */
function zOf(el) {
  const z = el.get('zindex');
  return typeof z === 'number' && Number.isFinite(z) ? z : 0;
}

/**
 * Put the container's own background in its slot: before the first entry at z >= 0.
 * @param {Array<{ el: ElementModel, z: number }>} sorted
 * @returns {Array<ElementModel | 'background'>}
 */
function withBackground(sorted) {
  /** @type {Array<ElementModel | 'background'>} */
  const out = [];
  let placed = false;
  for (const { el, z } of sorted) {
    if (!placed && z >= 0) { out.push('background'); placed = true; }
    out.push(el);
  }
  if (!placed) out.push('background');
  return out;
}

/** @param {{ el: ElementModel, z: number }} a @param {{ el: ElementModel, z: number }} b */
const byZThenSourceOrder = (a, b) => a.z - b.z || a.el.docIndex - b.el.docIndex;

/** @param {ElementModel} container @returns {Array<ElementModel | 'background'>} */
function contextOrder(container) {
  const kids = [];
  for (const el of container.children) if (PAINTED_KINDS.has(el.kind)) kids.push({ el, z: zOf(el) });
  kids.sort(byZThenSourceOrder);
  return withBackground(kids);
}

/** @param {ElementModel} container @returns {Array<ElementModel | 'background'>} */
function flatOrder(container) {
  const all = [];
  // An explicit stack: a hostile skin can nest 64 levels, but this stays correct at any depth.
  const pending = [{ node: container, base: 0 }];
  while (pending.length) {
    const { node, base } = /** @type {{ node: ElementModel, base: number }} */ (pending.pop());
    for (const el of node.children) {
      if (!PAINTED_KINDS.has(el.kind)) continue;
      const z = base + zOf(el);
      all.push({ el, z });
      if (CONTEXT_KINDS.has(el.kind)) pending.push({ node: el, base: z });
    }
  }
  all.sort(byZThenSourceOrder);
  return withBackground(all);
}

/**
 * The paint order of one container: its drawable children and its own `'background'` marker, bottom
 * to top. A container that is not a VIEW or SUBVIEW has no background and no ordered children, so
 * the list is empty. Pure: it reads the model and returns a fresh array each call (the view model
 * caches it and drops the cache when a child's z changes).
 * @type {import('../contracts').PaintOrderFn}
 */
export const paintOrder = (container, opts) => {
  if (!CONTEXT_KINDS.has(container.kind)) return [];
  return opts?.stacking === 'flat' ? flatOrder(container) : contextOrder(container);
};
