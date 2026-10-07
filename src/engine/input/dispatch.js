// @ts-check
// Input dispatch (E §5.11 `attachInput`; E D2 "Gestures", "Hit planes", D10.1 right press, D10.5
// keyboard). It turns the DOM events of the one input plane into the skin's event model: it asks the
// picker what is under the pointer, tracks hover and the press in progress, and reports every
// gesture to an `InputSink`, which runs the handlers. It never runs skin code itself.
//
// What the sink receives (`gesture(el, event, init, part)`, `event` a lower-case handler name):
//   onmouseover / onmouseout   the picked element changes (no bubbling: only the picked element).
//                              While a press is held only the pressed element gets them, as it is
//                              left and re-entered, so a hover-down image can show.
//   onmousedown                a press on a control; `button` is WMP's mask (left 1, right 2).
//   onmouseup                  goes to the element under the pointer at release (press on A, release
//                              on B: down on A, up on B). Released over nothing, it goes to the
//                              pressed element, so every down meets one up. A cancelled press
//                              (pointercancel, window blur) sends no up and no click.
//   onclick                    only when the up lands on the element the press began on. The DOM
//                              `click` is never listened to, so the demo's extra synthetic click
//                              cannot double-fire.
//   ondblclick                 a second click on the same element within DBLCLICK_MS and a few px,
//                              derived from our own clicks (the demo produces no DOM `dblclick`).
//   onmousemove                only when the element has such a handler.
// Slider drags go to `dragSlider(el, 'begin' | 'move' | 'end', value)` as well as the plain
// gestures. `value` is in the slider's own units (min..max), continuous (D31).
//
// The pick shape (contracts.d.ts `Pick`, what `input/picker.js` returns). For a BUTTONGROUP, `el` is
// the BUTTONELEMENT whose colour owns the pixel and `part` its index among the group's BUTTONELEMENTs,
// so its handlers, tooltips, `enabled` and focus are the ones this file reads, and "down and up on the
// same element" compares `el` and `part` directly; `local` is measured from the GROUP's top-left, which
// is what `offsetX`/`offsetY` are relative to. A disabled element or group is `blocked`: the press is
// swallowed. A SLIDER or PROGRESSBAR with no `thumbImage` and no mouse handler is `chrome` (a real
// left press drags the window); with a mouse handler but no thumb it is a `control` that gets the plain
// gestures and no slider drag.
//
// Channels back to the shell, since `attachInput` returns only an `Unsubscribe`:
//   - a right press the skin handled gets `preventDefault()` on the pointerdown and on the
//     `contextmenu` that follows it, so the shell opens its menu only when `defaultPrevented` is
//     false (D10.1: skin first, host second). A left press with Ctrl or Alt is the shell's menu
//     gesture and is ignored here entirely.
//   - a key the skin handled (`sink.key` returned true) gets `preventDefault()`, so the shell's key
//     defaults skip it (D10.5). Key listeners sit on the document in the capture phase.
//
// Real versus synthetic: only a press whose `isTrusted` is true calls `SkinWindow.startDrag()`. The
// demo's synthetic pointer events never start a native window drag.
//
// Keyboard routing is done here: the sink runs the handler of `init.srcElement` and nothing else.
// The focused element (the last control pressed, or the VIEW's `focusObjectID` as a script set it)
// gets the key first and the VIEW second, like an event bubbling to its VIEW. `onkeydown` and
// `onkeyup` carry the Windows virtual-key code from `KeyboardEvent.code` (D6) as `keyCode`.
// `onkeypress` is synthesised after `onkeydown` for a printable key or Enter, since the corpus's 518
// VIEW hotkeys are `onKeyPress`, and carries the typed character's code (`v` is 118, Shift+`V` is 86,
// `,` is 44, where the virtual keys are 86 and 188; spec 5.7). Space (32) and Enter (13), the only
// codes the corpus tests, are the same in both.
//
// Not here: CUSTOMSLIDER drags (their value comes from the grey `positionImage` plane, phase 3),
// `onfocus`/`onblur`, a TEXT's truncation tooltip, and re-picking under a stationary pointer when
// a tween moves an element (the next pointer move does it).
//
// The slider thumb's length is not in the model (only the `thumbImage` file name is), so `attachInput`
// takes the contract's seventh argument, `deps.thumbExtent(el)` (W4.1 supplies it from the image
// probe). Without it a thumb counts as 0 px long and the travel is the whole track. The value
// formulas are `layout/slider-geometry.js`'s, the ones the renderer and the picker draw and claim with.

import { valueAt } from '../layout/slider-geometry.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').Pick} Pick */
/** @typedef {import('../contracts').InputSink} InputSink */
/** @typedef {import('../contracts').SkinWindow} SkinWindow */
/** @typedef {import('../contracts').EngineOptions} EngineOptions */
/** @typedef {import('../contracts').EventInit} EventInit */
/** @typedef {import('../contracts').Unsubscribe} Unsubscribe */

/** The contract's seventh argument: `thumbExtent(el)` is the slider thumb's length along its axis, skin px. @typedef {NonNullable<Parameters<import('../contracts').AttachInputFn>[6]>} InputDeps */

/** A second click on the same element within this long, and within DBLCLICK_PX, is a double click. */
export const DBLCLICK_MS = 500;
const DBLCLICK_PX = 4;

/**
 * Skin `cursor` names to CSS (E D2). A Map: the key is skin text and `__proto__` or `constructor`
 * must come out as unknown. `uparrow` has no CSS twin and takes the arrow.
 * @type {ReadonlyMap<string, string>}
 */
const CURSORS = new Map([
  ['system', 'default'], ['hand', 'pointer'], ['help', 'help'], ['sizeall', 'move'],
  ['sizens', 'ns-resize'], ['sizewe', 'ew-resize'], ['sizenesw', 'nesw-resize'], ['sizenwse', 'nwse-resize'],
  ['uparrow', 'default'],
]);

/**
 * The CSS cursor for a skin cursor name, or null when the name is unknown (a `.cur`/`.ani` file in
 * phase 3, or a made-up name like `sizetopright`): the caller keeps the cursor it had (U-21).
 * @param {unknown} name
 * @returns {string | null}
 */
export function cssCursor(name) {
  if (typeof name !== 'string') return null;
  return CURSORS.get(name.toLowerCase()) ?? null;
}

// ---- keyboard ------------------------------------------------------------------------------------

/** KeyboardEvent.code to Windows virtual-key code. @type {Map<string, number>} */
const VK_BY_CODE = new Map();
for (let i = 0; i < 26; i++) VK_BY_CODE.set(`Key${String.fromCharCode(65 + i)}`, 65 + i);
for (let i = 0; i < 10; i++) { VK_BY_CODE.set(`Digit${i}`, 48 + i); VK_BY_CODE.set(`Numpad${i}`, 96 + i); }
for (let i = 1; i <= 12; i++) VK_BY_CODE.set(`F${i}`, 111 + i);
for (const [code, vk] of /** @type {Array<[string, number]>} */ ([
  ['Backspace', 8], ['Tab', 9], ['Enter', 13], ['NumpadEnter', 13], ['ShiftLeft', 16], ['ShiftRight', 16],
  ['ControlLeft', 17], ['ControlRight', 17], ['AltLeft', 18], ['AltRight', 18], ['Pause', 19], ['CapsLock', 20],
  ['Escape', 27], ['Space', 32], ['PageUp', 33], ['PageDown', 34], ['End', 35], ['Home', 36],
  ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['ArrowDown', 40], ['Insert', 45], ['Delete', 46],
  ['MetaLeft', 91], ['MetaRight', 92], ['ContextMenu', 93], ['NumpadMultiply', 106], ['NumpadAdd', 107],
  ['NumpadSubtract', 109], ['NumpadDecimal', 110], ['NumpadDivide', 111], ['NumLock', 144], ['ScrollLock', 145],
  ['Semicolon', 186], ['Equal', 187], ['Comma', 188], ['Minus', 189], ['Period', 190], ['Slash', 191],
  ['Backquote', 192], ['BracketLeft', 219], ['Backslash', 220], ['BracketRight', 221], ['Quote', 222],
])) VK_BY_CODE.set(code, vk);

/**
 * The Windows virtual-key code of a keyboard event: from `code`, else from `key` (a synthetic event
 * may carry only that), else the legacy `keyCode`, else 0.
 * @param {{ code?: string, key?: string, keyCode?: number }} e
 */
export function virtualKeyCode(e) {
  const byCode = e.code ? VK_BY_CODE.get(e.code) : undefined;
  if (byCode !== undefined) return byCode;
  const key = e.key;
  if (typeof key === 'string' && key) {
    if (key.length === 1) {
      const c = key.toUpperCase().charCodeAt(0);
      if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return c;
      if (key === ' ') return 32;
    } else if (VK_BY_CODE.has(key)) {
      return /** @type {number} */ (VK_BY_CODE.get(key));      // Enter, Escape, ArrowLeft, F5 spell alike
    }
  }
  return Number.isFinite(e.keyCode) ? /** @type {number} */ (e.keyCode) : 0;
}

/** A key that produces a character: the events `onkeypress` fires for ("alphanumeric only", spec 5.6). @param {KeyboardEvent} e */
const isCharacterKey = (e) => typeof e.key === 'string' && (e.key.length === 1 || e.key === 'Enter') && !e.ctrlKey && !e.metaKey && !e.altKey;

/**
 * What `event.keyCode` is in `onkeypress`: the code of the character typed, not the key's virtual-key
 * code (spec 5.7). `isCharacterKey` has already admitted the event: one character, or Enter (13).
 * @param {KeyboardEvent} e
 */
const characterCode = (e) => (e.key.length === 1 ? e.key.charCodeAt(0) : 13);

/** Typing into a real text field is the field's, not the skin's. @param {EventTarget | null} t */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

// ---- slider geometry -------------------------------------------------------------------------------

/**
 * @typedef {Object} SliderGeometry
 * @property {number} min
 * @property {number} max
 * @property {number} length     track length along the axis, skin px
 * @property {number} thumb      thumb length along the axis
 * @property {number} border     `borderSize`
 * @property {boolean} vertical  max at the top
 * @property {'oracle' | 'docs'} mode
 */

/**
 * A slider's value for a pointer `pos` px from its start edge along the axis (E D2), by the shared
 * geometry in `layout/slider-geometry.js`: `'oracle'` travels length - thumb with the pointer as the
 * thumb centre (parity D32, demo:108-113), `'docs'` centres the thumb over [border, length - border].
 * A vertical slider puts max at the top. The value is continuous.
 * @param {SliderGeometry} g
 * @param {number} pos
 */
export function sliderValueAt(g, pos) {
  const axis = { vertical: g.vertical, length: g.length, thumb: g.thumb, border: g.border, geometry: g.mode };
  return valueAt(pos, axis, g.min, g.max);
}

// ---- helpers over the model --------------------------------------------------------------------------

const MOUSE_HANDLERS = ['onmousedown', 'onmouseup', 'onclick'];

/** @param {ElementModel} el @param {string} name */
const textAttr = (el, name) => { const v = el.get(name); return typeof v === 'string' ? v : ''; };
/** @param {ElementModel} el @param {string} name */
const numAttr = (el, name) => { const v = el.get(name); return typeof v === 'number' && Number.isFinite(v) ? v : 0; };

/** Does the skin have a mouse handler on the picked element (D10.1)? A group part's is its BUTTONELEMENT's. @param {ElementModel} el */
const hasMouseHandler = (el) => MOUSE_HANDLERS.some((h) => el.handlers.has(h));

/** The tooltip in force: a button shows `downToolTip` while latched down (falling back to the up text). @param {ElementModel} el */
function tooltipOf(el) {
  if (el.kind === 'button' || el.kind === 'buttonelement') {
    const up = textAttr(el, 'uptooltip');
    return el.get('down') === true ? textAttr(el, 'downtooltip') || up : up;
  }
  return textAttr(el, 'tooltip');
}

/** Attributes whose change while the pointer rests on an element changes the tooltip or cursor. */
const FEEDBACK_ATTRS = new Set(['uptooltip', 'downtooltip', 'tooltip', 'cursor', 'down']);

/** WMP's `event.button`: a bitmask, left 1, right 2, middle 4. @param {number} domButton */
const maskOf = (domButton) => (domButton === 0 ? 1 : domButton === 2 ? 2 : domButton === 1 ? 4 : 0);

/** @param {{ el: ElementModel, part: number | null } | null} a @param {{ el: ElementModel, part: number | null } | null} b */
const sameTarget = (a, b) => a !== null && b !== null && a.el === b.el && a.part === b.part;

/** A picked element that takes gestures. @param {Pick | null} p @returns {Pick | null} */
const gestural = (p) => (p && (p.role === 'control' || p.role === 'effects') ? p : null);

/**
 * @typedef {Object} Held             a picked element the pointer is tracked against
 * @property {ElementModel} el
 * @property {number | null} part
 * @property {{ x: number, y: number }} origin   the element's top-left in view px, from the pick's local point
 */

/**
 * @typedef {Object} Press
 * @property {number} id             pointerId
 * @property {number} button         DOM button
 * @property {Held} held
 * @property {boolean} over          the pointer is on the pressed element
 * @property {SliderGeometry | null} slider
 * @property {number} lastValue
 */

/** What the init builders read off a pointer event, kept so a cancel with no event can still build one. @typedef {{ screenX: number, screenY: number, altKey: boolean, ctrlKey: boolean, shiftKey: boolean, buttons: number }} PointerFacts */

/**
 * Attach the input plane: pointer gestures, hover, capture, slider drags, right-press forwarding,
 * keyboard, tooltip and cursor.
 * @param {HTMLElement} plane            the engine's `div.input`
 * @param {ViewModel} view
 * @param {(x: number, y: number) => Pick | null} pickAt   view px, whole numbers
 * @param {SkinWindow} win
 * @param {InputSink} sink
 * @param {EngineOptions} opts
 * @param {InputDeps} [deps]
 * @returns {Unsubscribe}
 */
export function attachInput(plane, view, pickAt, win, sink, opts, deps) {
  const doc = plane.ownerDocument;
  const frame = doc?.defaultView ?? null;
  const thumbExtentOf = (/** @type {ElementModel} */ el) => deps?.thumbExtent?.(el) ?? 0;   // called on `deps`, which keeps its `this`

  /** @type {Held | null} */ let hover = null;
  /** @type {Press | null} */ let press = null;
  /** @type {ElementModel | null} */ let focused = null;
  let rightHandled = false;
  /** @type {{ el: ElementModel, part: number | null, t: number, x: number, y: number } | null} */ let lastClick = null;
  /** @type {PointerFacts} */ let facts = { screenX: 0, screenY: 0, altKey: false, ctrlKey: false, shiftKey: false, buttons: 0 };
  let lastPt = { x: 0, y: 0 };
  let lastTitle = plane.title ?? '';

  // ---- coordinates and event data

  /** The pointer in view px: client px relative to the plane, divided by the zoom the view is scaled by. @param {MouseEvent} e */
  function toView(e) {
    const r = plane.getBoundingClientRect();
    const z = Number.isFinite(win.zoom) && win.zoom > 0 ? win.zoom : 1;
    lastPt = { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
    return lastPt;
  }

  /** @param {{ x: number, y: number }} pt @returns {Pick | null} */
  const pickPoint = (pt) => pickAt(Math.floor(pt.x), Math.floor(pt.y));

  /** @param {Pick} p @param {{ x: number, y: number }} pt @returns {Held} */
  const heldOf = (p, pt) => ({ el: p.el, part: p.part, origin: { x: Math.floor(pt.x) - p.local.x, y: Math.floor(pt.y) - p.local.y } });

  const screenSize = () => {
    const s = frame?.screen;
    return { w: s?.availWidth || s?.width || 0, h: s?.availHeight || s?.height || 0 };
  };

  /** @param {MouseEvent | PointerFacts} e @returns {PointerFacts} */
  const factsOf = (e) => ({
    screenX: Number.isFinite(e.screenX) ? e.screenX : 0, screenY: Number.isFinite(e.screenY) ? e.screenY : 0,
    altKey: !!e.altKey, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, buttons: e.buttons ?? 0,
  });

  /**
   * The `event` object for a pointer gesture on `held`.
   * @param {PointerFacts} f @param {{ x: number, y: number }} pt @param {Held} held @param {number} button WMP mask
   * @param {{ from?: ElementModel | null, to?: ElementModel | null }} [rel]
   * @returns {EventInit}
   */
  function pointerInit(f, pt, held, button, rel = {}) {
    const x = Math.floor(pt.x), y = Math.floor(pt.y), size = screenSize();
    return {
      x, y, clientX: x, clientY: y, offsetX: x - held.origin.x, offsetY: y - held.origin.y,
      screenX: f.screenX, screenY: f.screenY, screenWidth: size.w, screenHeight: size.h,
      button, keyCode: 0, altKey: f.altKey, ctrlKey: f.ctrlKey, shiftKey: f.shiftKey,
      srcElement: held.el, fromElement: rel.from ?? null, toElement: rel.to ?? null,
    };
  }

  // ---- tooltip and cursor

  /** Title and cursor follow the element under the pointer (E D2). @param {Pick | null} p */
  function applyFeedback(p) {
    let title = '';
    let cursor = '';
    if (p && (p.role === 'control' || p.role === 'effects' || p.role === 'blocked')) {
      title = tooltipOf(p.el);
      const css = cssCursor(p.el.get('cursor'));
      cursor = css ?? plane.style.cursor;                   // an unknown name keeps the cursor as it was
    }
    if (title !== lastTitle) { plane.title = title; lastTitle = title; }
    if (plane.style.cursor !== cursor) plane.style.cursor = cursor;
  }

  // ---- hover

  /**
   * Move the hover to `next` (a gestural pick or null): out on the old element, then over on the new
   * one, no bubbling.
   * @param {Pick | null} next @param {PointerFacts} f @param {{ x: number, y: number }} pt
   */
  function setHover(next, f, pt) {
    if (sameTarget(hover, next)) return;
    const prev = hover;
    hover = next ? heldOf(next, pt) : null;
    if (prev) sink.gesture(prev.el, 'onmouseout', pointerInit(f, pt, prev, f.buttons & 7, { to: next?.el ?? null }), prev.part);
    if (next && hover) sink.gesture(next.el, 'onmouseover', pointerInit(f, pt, hover, f.buttons & 7, { from: prev?.el ?? null }), next.part);
  }

  // ---- capture

  /** @param {number} id */
  function takeCapture(id) {
    win.setCapture(true);
    try { plane.setPointerCapture(id); } catch { /* a synthetic pointer id has nothing to capture (parity 3.1) */ }
  }

  /** @param {number} id */
  function dropCapture(id) {
    win.setCapture(false);
    try { plane.releasePointerCapture(id); } catch { /* no capture was taken */ }
  }

  // ---- press

  /** @param {Press} p @param {{ x: number, y: number }} pt */
  const sliderValue = (p, pt) => sliderValueAt(/** @type {SliderGeometry} */ (p.slider), p.slider?.vertical ? pt.y - p.held.origin.y : pt.x - p.held.origin.x);

  /** A SLIDER with a thumb image is interactive (spec 6.7); its geometry comes from the model. @param {ElementModel} el @returns {SliderGeometry | null} */
  function sliderOf(el) {
    if ((el.kind !== 'slider' && el.kind !== 'progressbar') || !textAttr(el, 'thumbimage')) return null;
    const vertical = el.get('direction') === 'vertical';
    const length = numAttr(el, vertical ? 'height' : 'width');
    if (length <= 0) return null;
    return { min: numAttr(el, 'min'), max: numAttr(el, 'max'), length, thumb: Math.max(0, thumbExtentOf(el)),
      border: Math.max(0, numAttr(el, 'bordersize')), vertical, mode: opts.sliderGeometry };
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (press) cancelPress(facts);                           // a pointerup was lost: end the old press first
    rightHandled = false;
    const f = factsOf(e);
    facts = f;
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0 && (e.ctrlKey || e.altKey)) return;   // Control-click and Option-click are the shell's menu (D10.1)
    const pt = toView(e);
    const p = pickPoint(pt);
    if (!p) return;
    if (p.role === 'chrome') {
      if (e.button === 0 && e.isTrusted === true) win.startDrag();
      return;
    }
    if (p.role !== 'control' && p.role !== 'effects') return; // blocked: swallowed, drawn, no events, no drag; widget: its own DOM
    if (e.button === 2 && !hasMouseHandler(p.el)) return;       // no skin handler: the host menu opens
    setHover(p, f, pt);
    const held = /** @type {Held} */ (hover);
    const id = Number.isFinite(e.pointerId) ? e.pointerId : 0;
    const slider = e.button === 0 ? sliderOf(p.el) : null;
    /** @type {Press} */
    const pr = { id, button: e.button, held, over: true, slider, lastValue: 0 };
    press = pr;
    takeCapture(id);
    if (e.button === 0) focusOn(p.el);
    else rightHandled = true;
    e.preventDefault();
    applyFeedback(p);
    sink.gesture(p.el, 'onmousedown', pointerInit(f, pt, held, maskOf(e.button)), p.part);
    if (slider) {
      pr.lastValue = sliderValue(pr, pt);
      sink.dragSlider(p.el, 'begin', pr.lastValue);
    }
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    const f = factsOf(e);
    facts = f;
    const pt = toView(e);
    const p = pickPoint(pt);
    if (press) {
      if (Number.isFinite(e.pointerId) && e.pointerId !== press.id) return;
      const pr = press;
      const over = sameTarget(gestural(p), pr.held);
      if (over !== pr.over) {
        pr.over = over;
        hover = over ? pr.held : null;
        sink.gesture(pr.held.el, over ? 'onmouseover' : 'onmouseout', pointerInit(f, pt, pr.held, maskOf(pr.button)), pr.held.part);
      }
      if (pr.slider) {
        const v = sliderValue(pr, pt);
        if (v !== pr.lastValue) { pr.lastValue = v; sink.dragSlider(pr.held.el, 'move', v); }
      } else if (pr.held.el.handlers.has('onmousemove')) {
        sink.gesture(pr.held.el, 'onmousemove', pointerInit(f, pt, pr.held, maskOf(pr.button)), pr.held.part);
      }
      return;
    }
    const g = gestural(p);
    setHover(g, f, pt);
    applyFeedback(p);
    if (hover && hover.el.handlers.has('onmousemove')) {
      sink.gesture(hover.el, 'onmousemove', pointerInit(f, pt, hover, f.buttons & 7), hover.part);
    }
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    const pr = press;
    if (!pr) return;
    if (Number.isFinite(e.pointerId) && e.pointerId !== pr.id) return;
    const f = factsOf(e);
    facts = f;
    const pt = toView(e);
    const p = pickPoint(pt);
    press = null;
    dropCapture(pr.id);
    const hit = gestural(p);
    setHover(hit, f, pt);
    applyFeedback(p);
    if (pr.slider) sink.dragSlider(pr.held.el, 'end', sliderValue(pr, pt));
    const dest = hit ? heldOf(hit, pt) : pr.held;            // over nothing, the release ends where the press began
    const mask = maskOf(pr.button);
    sink.gesture(dest.el, 'onmouseup', pointerInit(f, pt, dest, mask), dest.part);
    if (!hit || !sameTarget(hit, pr.held)) { lastClick = null; return; }
    sink.gesture(dest.el, 'onclick', pointerInit(f, pt, dest, mask), dest.part);
    if (pr.button !== 0) return;
    const now = Number.isFinite(e.timeStamp) ? e.timeStamp : 0;
    const prev = lastClick;
    if (prev && sameTarget(prev, dest) && now - prev.t <= DBLCLICK_MS && Math.abs(pt.x - prev.x) <= DBLCLICK_PX && Math.abs(pt.y - prev.y) <= DBLCLICK_PX) {
      lastClick = null;
      sink.gesture(dest.el, 'ondblclick', pointerInit(f, pt, dest, mask), dest.part);
    } else {
      lastClick = { el: dest.el, part: dest.part, t: now, x: pt.x, y: pt.y };
    }
  }

  /**
   * End the press without an up or a click: pointercancel, window blur, or a press whose pointerup
   * never came. A slider drag still ends, and the pressed element is left.
   * @param {PointerFacts} f
   */
  function cancelPress(f) {
    const pr = press;
    if (!pr) return;
    press = null;
    lastClick = null;
    dropCapture(pr.id);
    if (pr.slider) sink.dragSlider(pr.held.el, 'end', pr.lastValue);
    if (hover && sameTarget(hover, pr.held)) {
      const was = hover;
      hover = null;
      sink.gesture(was.el, 'onmouseout', pointerInit(f, lastPt, was, 0), was.part);
    }
    applyFeedback(null);
  }

  /** @param {PointerEvent} e */
  function onPointerCancel(e) {
    if (press && Number.isFinite(e.pointerId) && e.pointerId !== press.id) return;
    cancelPress(factsOf(e));
  }

  /** @param {PointerEvent} e */
  function onPointerLeave(e) {
    if (press) return;                                       // captured: the pointer is still the pressed element's
    const f = factsOf(e);
    setHover(null, f, toView(e));
    applyFeedback(null);
  }

  /** A right press the skin took must not also open the host menu (D10.1). @param {Event} e */
  function onContextMenu(e) {
    if (rightHandled) e.preventDefault();
  }

  // ---- focus and keys

  /** The pressed control takes the keyboard; `focusObjectID` is how a script sees and sets it. @param {ElementModel} el */
  function focusOn(el) {
    try {
      if (view.view.get('focusobjectid') !== el.id) view.view.set('focusObjectID', el.id, 'user');
    } catch { /* the VIEW has no such attribute: the focus still routes keys */ }
    focused = el;                                            // after the write: two elements may share an id, and byId would pick the first
  }

  const offChange = view.onChange((el, attr) => {
    if (attr === 'focusobjectid' && el === view.view) {
      const id = el.get('focusobjectid');
      focused = typeof id === 'string' && id ? view.byId(id) ?? null : null;
    } else if (hover && FEEDBACK_ATTRS.has(attr) && el === hover.el) {
      applyFeedback({ el: hover.el, part: hover.part, role: 'control', local: { x: 0, y: 0 } });
    }
  });
  {
    const id = view.view.get('focusobjectid');
    if (typeof id === 'string' && id) focused = view.byId(id) ?? null;
  }

  /** @param {'onkeydown' | 'onkeypress' | 'onkeyup'} name @param {KeyboardEvent} e @param {ElementModel} src @returns {EventInit} */
  function keyInit(name, e, src) {
    const size = screenSize();
    return {
      x: 0, y: 0, clientX: 0, clientY: 0, offsetX: 0, offsetY: 0, screenX: 0, screenY: 0, screenWidth: size.w, screenHeight: size.h,
      button: 0, keyCode: name === 'onkeypress' ? characterCode(e) : virtualKeyCode(e), altKey: !!e.altKey, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey,
      srcElement: src, fromElement: null, toElement: null,
    };
  }

  /**
   * The focused element's handler, then the VIEW's.
   * @param {'onkeydown' | 'onkeypress' | 'onkeyup'} name @param {KeyboardEvent} e
   */
  function routeKey(name, e) {
    let ran = false;
    if (focused && focused !== view.view) ran = sink.key(name, keyInit(name, e, focused));
    return sink.key(name, keyInit(name, e, view.view)) || ran;
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || isEditable(e.target)) return;
    let ran = routeKey('onkeydown', e);
    if (isCharacterKey(e)) ran = routeKey('onkeypress', e) || ran;
    if (ran) e.preventDefault();
  }

  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (e.defaultPrevented || e.isComposing || isEditable(e.target)) return;
    if (routeKey('onkeyup', e)) e.preventDefault();
  }

  const onBlur = () => cancelPress(facts);

  plane.addEventListener('pointerdown', onPointerDown);
  plane.addEventListener('pointermove', onPointerMove);
  plane.addEventListener('pointerup', onPointerUp);
  plane.addEventListener('pointercancel', onPointerCancel);
  plane.addEventListener('pointerleave', onPointerLeave);
  plane.addEventListener('contextmenu', onContextMenu);
  doc?.addEventListener('keydown', onKeyDown, true);
  doc?.addEventListener('keyup', onKeyUp, true);
  frame?.addEventListener('blur', onBlur);

  return () => {
    plane.removeEventListener('pointerdown', onPointerDown);
    plane.removeEventListener('pointermove', onPointerMove);
    plane.removeEventListener('pointerup', onPointerUp);
    plane.removeEventListener('pointercancel', onPointerCancel);
    plane.removeEventListener('pointerleave', onPointerLeave);
    plane.removeEventListener('contextmenu', onContextMenu);
    doc?.removeEventListener('keydown', onKeyDown, true);
    doc?.removeEventListener('keyup', onKeyUp, true);
    frame?.removeEventListener('blur', onBlur);
    offChange();
    if (press) { const id = press.id; press = null; dropCapture(id); }
    hover = null;
    plane.title = '';
    plane.style.cursor = '';
  };
}

// tsc checks `attachInput` against the contract's signature, `deps` included, on this line.
/** @type {import('../contracts').AttachInputFn} */
const asContract = attachInput;
void asContract;
