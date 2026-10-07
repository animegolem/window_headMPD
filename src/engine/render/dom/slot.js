// @ts-check
// Host slots (E D2 "Windowed controls", D10.2, D10.4): EFFECTS and VIDEO are windowless surfaces that
// stack and clip like any control, so their `div.slot` lives in its context at its paint-order place;
// a PLAYLIST is a windowed control and lives in the top `div.windowed` layer at its rect in view px,
// ignoring z, alpha and clipping (spec 2.8). The host's `SlotProvider` mounts whatever goes inside
// (VizHost's canvas, the playlist widget) and reports the rects it claims for the window shape.
//
// `SlotSpec.rect` is in view px: the sum of left and top up to the VIEW, so a slot inside a drawer
// that slides keeps being told where it is. `SlotSpec.attrs` carries every non-handler attribute of
// the element under its table name, readable in any letter case.
//
// VIDEO is an inert stub (parity D19): its `backgroundColor` and nothing else.

import { attrSpecsOf } from '../../wms/attrs.js';
import { makeNode, num, placeBox, setAlpha, setStyle, setVisible } from './dom.js';
import { rgbCss } from './strings.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').SlotSpec} SlotSpec */
/** @typedef {import('../../contracts').SlotHandle} SlotHandle */
/** @typedef {import('../../contracts').AttrValue} AttrValue */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */
/** @typedef {Drawable & { readonly handle: SlotHandle | null, start(): void, refresh(): void, windowed: boolean }} SlotDrawable */

/**
 * A Map whose keys are folded to lower case on the way in and on lookup, so a widget may ask for
 * `backgroundColor` or `backgroundcolor`.
 * @extends {Map<string, AttrValue>}
 */
class FoldedAttrs extends Map {
  /** @param {string} k @param {AttrValue} v */
  set(k, v) {
    return super.set(String(k).toLowerCase(), v);
  }

  /** @param {string} k */
  get(k) {
    return super.get(String(k).toLowerCase());
  }

  /** @param {string} k */
  has(k) {
    return super.has(String(k).toLowerCase());
  }
}

/**
 * @param {ElementModel} el
 * @returns {{ x: number, y: number }} the element's top-left in view px
 */
export function absolutePosition(el) {
  let x = 0;
  let y = 0;
  for (/** @type {ElementModel | null} */ let n = el; n && n.kind !== 'view'; n = n.parent) {
    x += num(n, 'left');
    y += num(n, 'top');
  }
  return { x, y };
}

/** Visible only if every ancestor is. @param {ElementModel} el */
export function effectivelyVisible(el) {
  for (/** @type {ElementModel | null} */ let n = el; n; n = n.parent) if (n.get('visible') === false) return false;
  return true;
}

/**
 * @param {ElementModel} el
 * @returns {SlotSpec}
 */
function specOf(el) {
  const attrs = new FoldedAttrs();
  for (const a of attrSpecsOf(el.kind)) if (a.type !== 'handler') attrs.set(a.name, el.get(a.name));
  const { x, y } = absolutePosition(el);
  const kind = el.kind === 'effects' ? 'effects' : el.kind === 'video' ? 'video' : 'playlist';
  return { kind, attrs, rect: { x, y, w: num(el, 'width'), h: num(el, 'height') } };
}

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {SlotDrawable}
 */
export function createSlot(ctx, el) {
  const windowed = el.kind === 'playlist';
  const node = makeNode(ctx.doc, 'div', windowed ? 'slot windowed-slot' : 'slot');
  // Slots in `div.windowed` take native events inside their rect (the layer itself takes none).
  if (windowed) setStyle(node, 'pointer-events', 'auto');
  // A windowless slot clips like any control; a windowed one is a native window and does not.
  else setStyle(node, 'overflow', 'hidden');
  /** @type {SlotHandle | null} mounted by `start`, once the node is in the document */
  let handle = null;
  let lastRect = '';
  let lastVisible = true;
  let started = false;

  function placeNode() {
    if (windowed) {
      const { x, y } = absolutePosition(el);
      placeBox(node, { left: x, top: y, width: num(el, 'width'), height: num(el, 'height') });
    } else {
      placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: num(el, 'width'), height: num(el, 'height') });
    }
  }

  /** Tell the host where the slot is and whether it shows, when either changed. */
  function refresh() {
    if (!handle) return;
    if (windowed) placeNode();
    const spec = specOf(el);
    const key = `${spec.rect.x},${spec.rect.y},${spec.rect.w},${spec.rect.h}`;
    if (!started || key !== lastRect) {
      lastRect = key;
      handle.update(spec);
    }
    const v = effectivelyVisible(el);
    if (!started || v !== lastVisible) {
      lastVisible = v;
      handle.setVisible(v);
    }
    if (windowed) setVisible(node, v);
    started = true;
  }

  return {
    node,
    get handle() { return handle; },
    windowed,
    start() {
      if (handle) return;
      handle = ctx.slots.mount(node, specOf(el), ctx.win);
      refresh();
    },
    apply(changed) {
      placeNode();
      if (el.kind === 'video') setStyle(node, 'background-color', rgbCss(el.get('backgroundcolor')) ?? '');
      if (!windowed) {
        setVisible(node, el.get('visible') !== false);
        setAlpha(node, num(el, 'alphablend', 255));
      } else {
        setVisible(node, effectivelyVisible(el));
      }
      // Any attribute may matter to a widget (colours, columns), so the spec is rebuilt on a change.
      if (changed !== null) lastRect = '';
      refresh();
    },
    refresh,
    dispose() {
      handle?.dispose();
      handle = null;
    },
  };
}
