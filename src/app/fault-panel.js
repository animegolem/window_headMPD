// @ts-check
// The fault panel (ENGINE.md D10.8). When a skin stops (its realm hit a hard fault and unloaded, it
// failed to load, or safe mode skipped it) the shell draws this host panel in the window root: what
// happened, and the ways out. "Reload skin" always; "Choose another skin" when the shell has a chooser
// (phase 2); "Use legacy Headspace" while the hand port still exists (until cutover). The window menu
// keeps working over it, and it is host DOM, so nothing the skin does can reach it.
//
// The window is transparent and click-through wherever the shape says so, so the panel must be IN the
// shape: `show()` sends one that holds the panel's rectangle and, when the caller has the dead skin's
// last shape, that shape too (the skin's pixels stay draggable and clickable under it).
//
// The text is host-written or comes from a fault reason, which can quote the skin; it is only ever set
// as `textContent`, with control characters stripped and the length capped.

/** @typedef {import('../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../engine/contracts').MaskShape} MaskShape */
/** @typedef {import('../engine/contracts').Rect} Rect */
/**
 * @typedef {{
 *   reload(): unknown,
 *   useLegacy?(): unknown,
 *   chooseSkin?(): unknown,
 * }} FaultActions what the buttons do; an action that is absent leaves its button out
 */

/** The window of tauri.conf.json: 760 x 394, the only one phase 1 opens. Used when no skin is attached. */
export const DEFAULT_SIZE = Object.freeze({ w: 760, h: 394 });
/** The panel's own size in skin px. */
export const PANEL_SIZE = Object.freeze({ w: 340, h: 128 });
export const MAX_MESSAGE_CHARS = 240;

/**
 * The panel's rectangle: centred in the window, or pinned to the window's corner when the window is
 * smaller than the panel.
 * @param {{ w: number, h: number }} size the window in skin px
 * @returns {Rect}
 */
export function panelRect(size) {
  const w = Math.min(PANEL_SIZE.w, Math.max(1, Math.floor(size.w)));
  const h = Math.min(PANEL_SIZE.h, Math.max(1, Math.floor(size.h)));
  return { x: Math.floor((size.w - w) / 2), y: Math.floor((size.h - h) / 2), w, h };
}

/** Message text as it may be shown: no control characters, one line of whitespace, a bounded length. @param {unknown} text */
export function sanitizeMessage(text) {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS - 1)}…` : s;
}

/**
 * The window shape that includes the panel: `base` (the skin's last shape) with the panel's rectangle
 * added, or the panel alone when there is no usable base.
 * @param {MaskShape | null | undefined} base
 * @param {{ w: number, h: number }} size the window in skin px
 * @param {Rect} rect the panel
 * @returns {MaskShape}
 */
export function shapeWithPanel(base, size, rect) {
  if (base && base.kind === 'regions') {
    return { kind: 'regions', width: base.width, height: base.height, regions: [...base.regions, { x: rect.x, y: rect.y, w: rect.w, h: rect.h }] };
  }
  const width = Math.max(1, Math.floor(size.w));
  const height = Math.max(1, Math.floor(size.h));
  const bits = base && base.kind === 'bits' && base.width === width && base.height === height
    ? new Uint8Array(base.bits)
    : new Uint8Array(Math.ceil((width * height) / 8));
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  for (let y = Math.max(0, rect.y); y < y1; y++) {
    for (let x = Math.max(0, rect.x); x < x1; x++) {
      const i = y * width + x;
      bits[i >> 3] |= 1 << (i & 7);
    }
  }
  return { kind: 'bits', width, height, bits };
}

/**
 * @param {{
 *   win: SkinWindow,
 *   actions: FaultActions,
 *   root?: HTMLElement | null,
 *   size?: () => { w: number, h: number },
 *   baseShape?: () => MaskShape | null | undefined,
 *   log?: Pick<import('../engine/contracts').Log, 'warn'>,
 * }} deps `root` is where the panel is drawn (default: the window's root, then the page body); `size`
 *   is the window in skin px (default: 760 x 394); `baseShape` is the dead skin's last shape
 */
export function createFaultPanel({ win, actions, root, size, baseShape, log }) {
  /** @type {HTMLElement | null} */
  let node = null;
  /** @type {HTMLElement | null} */
  let messageEl = null;

  /** @param {() => unknown} fn @param {string} what */
  const run = (fn, what) => {
    try {
      Promise.resolve(fn()).catch((e) => log?.warn(`fault panel: ${what} failed`, { error: String(e) }));
    } catch (e) {
      log?.warn(`fault panel: ${what} failed`, { error: String(e) });
    }
  };

  /**
   * @param {Document} doc @param {string} label @param {string} cls @param {() => unknown} fn
   */
  function button(doc, label, cls, fn) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `wh-fault-button ${cls}`;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); run(fn, label); });
    return b;
  }

  /** @param {HTMLElement} parent */
  function build(parent) {
    const doc = parent.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'wh-fault';
    el.setAttribute('role', 'alertdialog');
    const msg = doc.createElement('p');
    msg.className = 'wh-fault-message';
    const row = doc.createElement('div');
    row.className = 'wh-fault-actions';
    row.append(button(doc, 'Reload skin', 'wh-fault-reload', () => actions.reload()));
    if (actions.chooseSkin) row.append(button(doc, 'Choose another skin', 'wh-fault-choose', () => /** @type {() => unknown} */ (actions.chooseSkin)()));
    if (actions.useLegacy) row.append(button(doc, 'Use legacy Headspace', 'wh-fault-legacy', () => /** @type {() => unknown} */ (actions.useLegacy)()));
    el.append(msg, row);
    // The skin that drew the window's chrome is gone, so the panel's own background drags the window.
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && !e.ctrlKey && !e.altKey && e.target === el) win.startDrag();
    });
    parent.append(el);
    messageEl = msg;
    return el;
  }

  /** @returns {HTMLElement} */
  function mountPoint() {
    const doc = globalThis.document;
    const found = root ?? win.root ?? doc?.getElementById('skin') ?? doc?.body;
    if (!found) throw new Error('the fault panel needs a document to draw in');
    return found;
  }

  return {
    /**
     * Shows the panel with `message` and puts it in the window shape. Calling it again replaces the text.
     * @param {string} message the whole sentence ("This skin stopped: ..."); sanitized here
     */
    show(message) {
      const parent = mountPoint();
      if (!node || node.parentElement !== parent) {
        node?.remove();
        node = build(parent);
      }
      const dims = size?.() ?? DEFAULT_SIZE;
      const rect = panelRect(dims);
      Object.assign(node.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
      if (messageEl) messageEl.textContent = sanitizeMessage(message);
      win.setShape(shapeWithPanel(baseShape?.(), dims, rect));
    },

    hide() {
      node?.remove();
      node = null;
      messageEl = null;
    },

    /** @returns {boolean} */
    visible: () => node !== null && node.isConnected,
    /** @returns {HTMLElement | null} */
    element: () => node,
  };
}
