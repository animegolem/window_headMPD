// @ts-check
// Which image or colour an element shows for its interaction state (E D2 drawables table; spec 6.4,
// 6.5, 6.7, 6.10; parity E7 and F). Pure: the DOM modules ask here, then draw.
//
// The interaction state is the pointer's, which the model does not hold, plus a few attributes the
// model does (`enabled`, `sticky`, `down`). `PointerView` is what the renderer works out for one
// element from the pointer it was last told about (`setPointer`).

/** @typedef {import('../../contracts').ElementModel} ElementModel */

/**
 * @typedef {Object} PointerView
 * @property {boolean} over     the pointer is over this element (for a BUTTONGROUP element: over that element)
 * @property {boolean} pressed  the left button went down on it and has not come up
 */

/** @type {Readonly<PointerView>} */
export const NO_POINTER = Object.freeze({ over: false, pressed: false });

/**
 * A BUTTON's, or one BUTTONELEMENT's, visual state. Disabled beats everything; a latched sticky
 * button (`sticky` and `down`) is down; a press counts as down only while the pointer is still
 * over the button (the oracle's `isDown && isOver`, widgets:48-52). Down and over together is the
 * hover-down state.
 * @typedef {'up' | 'hover' | 'down' | 'hoverDown' | 'disabled'} ButtonState
 * @param {{ enabled: boolean, sticky: boolean, down: boolean }} a
 * @param {PointerView} p
 * @returns {ButtonState}
 */
export function buttonState(a, p) {
  if (!a.enabled) return 'disabled';
  const down = (a.sticky && a.down) || (p.pressed && p.over);
  if (down) return p.over ? 'hoverDown' : 'down';
  return p.over ? 'hover' : 'up';
}

/**
 * The refs of the five images with their fallbacks applied: `hover ?? up`, `down ?? hover ?? up`,
 * `hoverDown ?? down`, `disabled ?? up` (D2, widgets:46, spec 6.4). A blank ref is "not given".
 * @typedef {{ up: string, hover: string, down: string, hoverDown: string, disabled: string }} StateRefs
 * @param {{ image?: unknown, hoverImage?: unknown, downImage?: unknown, hoverDownImage?: unknown, disabledImage?: unknown }} i
 * @returns {StateRefs}
 */
export function stateRefs(i) {
  const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : '');
  const up = s(i.image);
  const hover = s(i.hoverImage) || up;
  const down = s(i.downImage) || hover;
  const hoverDown = s(i.hoverDownImage) || down;
  const disabled = s(i.disabledImage) || up;
  return { up, hover, down, hoverDown, disabled };
}

/**
 * @param {StateRefs} refs @param {ButtonState} state
 * @returns {string}
 */
export const refForState = (refs, state) => refs[state];

/** The group's states, in the order of its five layers. @type {readonly ButtonState[]} */
export const BUTTON_STATES = Object.freeze(['up', 'hover', 'down', 'hoverDown', 'disabled']);

/**
 * A slider thumb's state. Disabled first; a drag (the pointer went down on the slider) is down
 * wherever the pointer now is, since the oracle's thumb stays pressed while it is dragged
 * (widgets:268); over is the whole slider box (parity D28).
 * @typedef {'up' | 'hover' | 'down' | 'disabled'} ThumbState
 * @param {boolean} enabled @param {PointerView} p
 * @returns {ThumbState}
 */
export function thumbState(enabled, p) {
  if (!enabled) return 'disabled';
  if (p.pressed) return 'down';
  return p.over ? 'hover' : 'up';
}

/**
 * The thumb image ref for a state. The oracle's order while dragging is `down`, then `hover` when the
 * pointer is over, then `up` (widgets:268); the other states fall back to `thumbImage`.
 * @param {{ thumbImage?: unknown, thumbHoverImage?: unknown, thumbDownImage?: unknown, thumbDisabledImage?: unknown }} i
 * @param {ThumbState} state @param {boolean} over
 * @returns {string}
 */
export function thumbRef(i, state, over) {
  const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : '');
  const up = s(i.thumbImage);
  switch (state) {
    case 'disabled': return s(i.thumbDisabledImage) || up;
    case 'down': return s(i.thumbDownImage) || (over ? s(i.thumbHoverImage) : '') || up;
    case 'hover': return s(i.thumbHoverImage) || up;
    default: return up;
  }
}

/**
 * A TEXT's colour variant: disabled, then hover, else normal; each variant falls back to the normal
 * attribute when it is not set (spec 6.10).
 * @typedef {'normal' | 'hover' | 'disabled'} TextVariant
 * @param {boolean} enabled @param {PointerView} p
 * @returns {TextVariant}
 */
export function textVariant(enabled, p) {
  if (!enabled) return 'disabled';
  return p.over ? 'hover' : 'normal';
}

/**
 * One TEXT presentation attribute for a variant, falling back to the normal one.
 * @param {ElementModel} el @param {'ForegroundColor' | 'BackgroundColor' | 'FontStyle'} what @param {TextVariant} variant
 * @returns {import('../../contracts').AttrValue}
 */
export function textAttr(el, what, variant) {
  const normal = el.get(`${what}`.toLowerCase());
  if (variant === 'normal') return normal;
  const v = el.get(`${variant}${what}`.toLowerCase());
  return v === null || v === undefined || v === '' ? normal : v;
}
