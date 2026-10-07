// @ts-check
// The DOM renderer (E §5.11 `createRenderer`; E D2 layer tree). It turns one `ViewModel` into the
// retained layer tree
//
//   div.view                 VIEW size, `transform: scale(zoom)`, origin 0 0
//   ├─ div.layers            the painted scene, DOM order = paint order, pointer-events none
//   │  └─ div.sv, canvas, span, div.slot ...   one node per drawable; each SUBVIEW is a stacking context
//   ├─ div.input             the input plane (`plane`): `attachInput` listens here, nothing paints here
//   └─ div.windowed          host widgets WMP draws as native child windows (the playlist)
//
// and keeps it in step with the model: `frame(dirty)` applies the attributes that changed since the
// last frame and nothing else (writes are diffed, parity D34). Paint order is the order of the nodes:
// no engine node sets `z-index`, no image element is made, no markup string is parsed, and a skin's
// text goes in as `textContent` only.
//
// What the contract leaves out, added here as members of the returned object (the contract's own
// members behave as written):
//   plane               the `div.input` element, for `attachInput`
//   windowed            the `div.windowed` layer
//   setPointer(over, pressed)   the pointer's visual state, which is not in the model: hover and press
//                       images, the slider thumb, TEXT hover colours. `over` is the picked element
//                       (and BUTTONGROUP part) under the pointer, `pressed` the one a press began on.
//   createRenderer's sixth argument `{ clock, log }`, and `frame(dirty, now)`: engine time for the
//                       marquee, from the host clock (the real clock when none is given), and a sink
//                       for diagnostics.
// A decode that lands repaints its own drawable at once; the runtime, which owns the window shape, is
// told by `images.pending()` falling to zero (the same signal `settled()` uses).

import { createButton } from './button.js';
import { createButtonGroup } from './buttongroup.js';
import { createContainer } from './container.js';
import { createCustomSlider } from './customslider.js';
import { makeNode, num, placeBox, px, setAlpha, setStyle, setVisible } from './dom.js';
import { createSlider } from './slider.js';
import { createSlot } from './slot.js';
import { createText } from './text.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').ViewModel} ViewModel */
/** @typedef {import('../../contracts').Renderer} Renderer */
/** @typedef {import('../../contracts').SlotHandle} SlotHandle */
/** @typedef {import('../../contracts').EngineClock} EngineClock */
/** @typedef {import('../../contracts').Log} Log */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */
/** @typedef {import('./slot.js').SlotDrawable} SlotDrawable */
/**
 * Where the pointer is, as the picker names it: an element and, for a BUTTONGROUP, the index of the
 * BUTTONELEMENT. A BUTTONELEMENT itself is accepted and mapped to its group and index.
 * @typedef {{ el: ElementModel, part?: number | null }} PointerTarget
 */
/**
 * @typedef {Renderer & {
 *   frame(dirty: Map<ElementModel, Set<string>>, now?: number): void,
 *   readonly plane: HTMLElement | null,
 *   readonly windowed: HTMLElement | null,
 *   setPointer(over: PointerTarget | null, pressed: PointerTarget | null): void,
 * }} DomRenderer
 */
/**
 * @typedef {(root: HTMLElement, images: import('../../contracts').ImageService, slots: import('../../contracts').SlotProvider,
 *   win: import('../../contracts').SkinWindow, opts: import('../../contracts').EngineOptions,
 *   extras?: { clock?: EngineClock, log?: Log }) => DomRenderer} CreateDomRendererFn
 */

/** Attributes whose change can move or hide a slot, so its rect and visibility are re-sent. */
const SLOT_ATTRS = ['left', 'top', 'width', 'height', 'visible'];

/**
 * An element with no pixels of its own that still has a box (EDITBOX, LISTBOX, POPUP before their
 * phase): an empty div, so `nodeOf` and the stacking order treat it like any control.
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable}
 */
function createBox(ctx, el) {
  const node = makeNode(ctx.doc, 'div', 'box');
  return {
    node,
    apply() {
      placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: num(el, 'width'), height: num(el, 'height') });
      setVisible(node, el.get('visible') !== false);
      setAlpha(node, num(el, 'alphablend', 255));
    },
    dispose() {},
  };
}

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable | null}
 */
function create(ctx, el) {
  switch (el.kind) {
    case 'subview': return createContainer(ctx, el);
    case 'button': return createButton(ctx, el);
    case 'buttongroup': return createButtonGroup(ctx, el);
    case 'slider':
    case 'progressbar': return createSlider(ctx, el);
    case 'customslider': return createCustomSlider(ctx, el);
    case 'text': return createText(ctx, el);
    case 'effects':
    case 'video':
    case 'playlist': return createSlot(ctx, el);
    case 'editbox':
    case 'listbox':
    case 'popup': return createBox(ctx, el);
    default: return null;
  }
}

/** @type {CreateDomRendererFn} */
export const createRenderer = (root, images, slots, win, opts, extras = {}) => {
  const doc = root.ownerDocument;
  /** @type {ViewModel | null} */
  let view = null;
  /** @type {Map<ElementModel, Drawable>} */
  const drawables = new Map();
  /** @type {SlotDrawable[]} */
  let slotList = [];
  /** @type {Drawable[]} */
  let tickers = [];
  /** @type {Drawable | null} */
  let viewDrawable = null;
  /** @type {HTMLElement | null} */
  let plane = null;
  /** @type {HTMLElement | null} */
  let windowedLayer = null;
  /** @type {(() => void) | null} */
  let unsubZoom = null;
  let disposed = false;
  /** @type {{ over: { el: ElementModel, part: number | null } | null, pressed: { el: ElementModel, part: number | null } | null }} */
  let pointer = { over: null, pressed: null };

  const measurer = makeNode(doc, 'span', 'measure');
  setStyle(measurer, 'visibility', 'hidden');
  setStyle(measurer, 'white-space', 'pre');
  setStyle(measurer, 'left', '0px');
  setStyle(measurer, 'top', '0px');
  setStyle(measurer, 'pointer-events', 'none');

  /** @type {RenderContext} */
  const ctx = {
    doc,
    images,
    opts,
    slots,
    win,
    now: () => (extras.clock ? extras.clock.now() : performance.now()),
    report: (d) => extras.log?.diag(d),
    measurer,
    drawableOf: (el) => drawables.get(el),
    isDisposed: () => disposed,
  };

  function syncViewBox() {
    if (!view || !plane || !windowedLayer) return;
    const w = num(view.view, 'width');
    const h = num(view.view, 'height');
    for (const n of [plane, windowedLayer]) {
      setStyle(n, 'left', '0px');
      setStyle(n, 'top', '0px');
      setStyle(n, 'width', px(w));
      setStyle(n, 'height', px(h));
    }
  }

  /** @param {number} z */
  function applyZoom(z) {
    if (!viewDrawable) return;
    const zoom = Number.isFinite(z) && z > 0 ? z : 1;
    setStyle(viewDrawable.node, 'transform', zoom === 1 ? '' : `scale(${zoom})`);
  }

  /**
   * Build the nodes of one container's children in paint order, depth first. A PLAYLIST goes to the
   * windowed layer instead of its context.
   * @param {ViewModel} v @param {ElementModel} container @param {Drawable & { bgNode?: HTMLElement }} owner
   */
  function build(v, container, owner) {
    const content = owner.content ?? owner.node;
    for (const entry of v.paintOrder(container)) {
      if (entry === 'background') {
        if (owner.bgNode) content.appendChild(owner.bgNode);
        continue;
      }
      const d = create(ctx, entry);
      if (!d) continue;
      drawables.set(entry, d);
      const slot = /** @type {SlotDrawable} */ (d);
      if (entry.kind === 'playlist') windowedLayer?.appendChild(d.node);
      else content.appendChild(d.node);
      if (typeof slot.start === 'function') slotList.push(slot);
      if (d.tick) tickers.push(d);
      if (entry.kind === 'subview') build(v, entry, /** @type {Drawable & { bgNode?: HTMLElement }} */ (d));
    }
  }

  /** The nodes of `container`'s children, in the paint order the model now says. @param {ElementModel} container */
  function reorder(container) {
    if (!view) return;
    const owner = /** @type {(Drawable & { bgNode?: HTMLElement }) | undefined} */ (container.kind === 'view' ? viewDrawable ?? undefined : drawables.get(container));
    if (!owner) return;
    const content = owner.content ?? owner.node;
    /** @type {HTMLElement[]} */
    const want = [];
    for (const entry of view.paintOrder(container)) {
      if (entry === 'background') {
        if (owner.bgNode) want.push(owner.bgNode);
        continue;
      }
      const d = drawables.get(entry);
      if (d && entry.kind !== 'playlist') want.push(d.node);
    }
    for (let i = 0; i < want.length; i++) {
      const at = content.children[i];
      if (at !== want[i]) content.insertBefore(want[i], at ?? null);
    }
  }

  /** @param {PointerTarget | null} t @returns {{ el: ElementModel, part: number | null } | null} */
  function normalise(t) {
    if (!t || !t.el) return null;
    if (t.el.kind === 'buttonelement' && t.el.parent) {
      const idx = num(t.el, 'index', -1);
      return { el: t.el.parent, part: idx >= 0 ? idx : null };
    }
    return { el: t.el, part: t.part ?? null };
  }

  function disposeTree() {
    unsubZoom?.();
    unsubZoom = null;
    for (const d of drawables.values()) d.dispose();
    viewDrawable?.dispose();
    viewDrawable?.node.remove();
    drawables.clear();
    slotList = [];
    tickers = [];
    viewDrawable = null;
    plane = null;
    windowedLayer = null;
    view = null;
    pointer = { over: null, pressed: null };
  }

  /** @type {DomRenderer} */
  const renderer = {
    mount(v) {
      if (disposed) return;
      disposeTree();
      view = v;
      const vd = createContainer(ctx, v.view);
      viewDrawable = vd;
      plane = makeNode(doc, 'div', 'input');
      setStyle(plane, 'pointer-events', 'auto');
      windowedLayer = makeNode(doc, 'div', 'windowed');
      setStyle(windowedLayer, 'pointer-events', 'none');
      vd.node.append(plane, windowedLayer, measurer); // after div.layers, which the container made
      root.appendChild(vd.node);
      build(v, v.view, /** @type {Drawable & { bgNode?: HTMLElement }} */ (vd));
      // Everything is in the document: now give each node its style, then start the slots (a host
      // widget may measure the node it mounts into).
      vd.apply(null);
      for (const [, d] of drawables) d.apply(null);
      syncViewBox();
      applyZoom(win.zoom);
      unsubZoom = win.onZoom(applyZoom);
      for (const s of slotList) s.start();
      v.takeDirty(); // the literal state is what was just applied
    },

    frame(dirty, now) {
      if (disposed || !view || !viewDrawable) return;
      let slotsMoved = false;
      for (const [el, changed] of dirty) {
        if (el.kind === 'buttonelement') {
          const group = el.parent ? drawables.get(el.parent) : undefined;
          group?.applyChild?.(el, changed);
          continue;
        }
        const d = el.kind === 'view' ? viewDrawable : drawables.get(el);
        if (!d) continue;
        d.apply(changed);
        if (el.kind === 'view') {
          if (changed.has('width') || changed.has('height')) syncViewBox();
        } else if (changed.has('zindex') && el.parent) {
          reorder(el.parent);
        }
        if (!slotsMoved && SLOT_ATTRS.some((a) => changed.has(a))) slotsMoved = true;
      }
      if (slotsMoved) for (const s of slotList) s.refresh();
      const t = typeof now === 'number' ? now : tickers.length ? ctx.now() : 0;
      for (const d of tickers) d.tick?.(t);
    },

    nodeOf(el) {
      if (view && el === view.view) return viewDrawable?.node;
      return drawables.get(el)?.node;
    },

    slotOf(el) {
      const d = /** @type {SlotDrawable | undefined} */ (drawables.get(el));
      return d && typeof d.start === 'function' ? d.handle ?? undefined : undefined;
    },

    get plane() { return plane; },
    get windowed() { return windowedLayer; },

    setPointer(over, pressed) {
      if (disposed || !view) return;
      const next = { over: normalise(over), pressed: normalise(pressed) };
      const prev = pointer;
      pointer = next;
      /** @type {Set<ElementModel>} */
      const touched = new Set();
      for (const t of [prev.over, prev.pressed, next.over, next.pressed]) if (t) touched.add(t.el);
      for (const el of touched) {
        const d = drawables.get(el);
        if (!d) continue;
        const o = next.over && next.over.el === el ? next.over : null;
        const p = next.pressed && next.pressed.el === el ? next.pressed : null;
        const parts = /** @type {{ pointerParts?: (o: number | null, p: number | null) => void }} */ (d);
        if (parts.pointerParts) parts.pointerParts(o ? o.part : null, p ? p.part : null);
        else d.pointer?.({ over: !!o, pressed: !!p });
      }
    },

    dispose() {
      if (disposed) return;
      disposeTree();
      disposed = true;
    },
  };
  return renderer;
};

// Type-level proof that the extended factory still satisfies the contract's `CreateRendererFn`.
/** @type {import('../../contracts').CreateRendererFn} */
const _contract = createRenderer;
