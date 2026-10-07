// @ts-check
// The small DOM toolkit every drawable shares: diffed style writes (parity D34: an unchanged value is
// never written again), canvas sizing and blitting, the image watcher that repaints a drawable when a
// decode lands, and the shared per-renderer context. The drawables never touch `style` directly.
//
// Skin text reaches the DOM only as `textContent` (text.js) and `title` (dispatch); every other write
// here is a number, a colour from `rgbCss`, a keyword this code chose, or a data URL it generated.

import { specToken } from './keyspec.js';
import { cursorCss } from './strings.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').ImageService} ImageService */
/** @typedef {import('../../contracts').KeySpec} KeySpec */
/** @typedef {import('../../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../../contracts').EngineOptions} EngineOptions */
/** @typedef {import('../../contracts').SlotProvider} SlotProvider */
/** @typedef {import('../../contracts').SkinWindow} SkinWindow */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').EngineClock} EngineClock */
/** @typedef {import('./states.js').PointerView} PointerView */
/** @typedef {import('./compose.js').Surface} Surface */

/**
 * Everything a drawable needs from the renderer that made it.
 * @typedef {Object} RenderContext
 * @property {Document} doc
 * @property {ImageService} images
 * @property {EngineOptions} opts
 * @property {SlotProvider} slots
 * @property {SkinWindow} win
 * @property {() => number} now           engine time in ms (the host clock, or the real one when none was given)
 * @property {(d: Diagnostic) => void} report
 * @property {HTMLElement} measurer       a hidden span for `textWidth`
 * @property {(el: ElementModel) => Drawable | undefined} drawableOf
 * @property {() => boolean} isDisposed
 */

/**
 * @typedef {Object} Drawable
 * @property {HTMLElement} node                          the element's own node
 * @property {HTMLElement} [content]                     where a container's children go (default `node`)
 * @property {(changed: ReadonlySet<string> | null) => void} apply   null: everything
 * @property {(p: PointerView, part?: number | null) => void} [pointer]
 * @property {(child: ElementModel, changed: ReadonlySet<string> | null) => void} [applyChild]   a BUTTONELEMENT's change
 * @property {() => void} [repaint]                      an image landed
 * @property {(now: number) => void} [tick]              per frame (marquee)
 * @property {() => void} dispose
 */

/** @type {WeakMap<HTMLElement, Map<string, string>>} */
const written = new WeakMap();

/**
 * Set a CSS property if its value differs from the last one written through here. An empty value
 * removes the property. Returns whether the DOM was touched.
 * @param {HTMLElement} node @param {string} prop kebab-case @param {string} value
 * @returns {boolean}
 */
export function setStyle(node, prop, value) {
  let m = written.get(node);
  if (!m) written.set(node, (m = new Map()));
  if ((m.get(prop) ?? '') === value) return false;
  m.set(prop, value);
  if (value === '') node.style.removeProperty(prop);
  else node.style.setProperty(prop, value);
  return true;
}

/** @param {number} n @returns {string} */
export const px = (n) => `${Math.round(n)}px`;

/**
 * Position and size a node in its parent's pixel space. A size of 0 or less is "not given" and
 * leaves the dimension to the content (`auto`) when `autoSize` is set, else 0.
 * @param {HTMLElement} node @param {{ left: number, top: number, width: number, height: number }} r @param {boolean} [autoSize]
 */
export function placeBox(node, r, autoSize = false) {
  setStyle(node, 'left', px(r.left));
  setStyle(node, 'top', px(r.top));
  setStyle(node, 'width', r.width > 0 || !autoSize ? px(Math.max(0, r.width)) : 'auto');
  setStyle(node, 'height', r.height > 0 || !autoSize ? px(Math.max(0, r.height)) : 'auto');
}

/**
 * A numeric attribute, or `fallback` for anything else.
 * @param {ElementModel} el @param {string} attr @param {number} [fallback]
 * @returns {number}
 */
export function num(el, attr, fallback = 0) {
  const v = el.get(attr);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * A string attribute, or ''.
 * @param {ElementModel} el @param {string} attr
 * @returns {string}
 */
export function str(el, attr) {
  const v = el.get(attr);
  return typeof v === 'string' ? v : '';
}

/**
 * A new `position: absolute` node of a tag. Every engine node is absolutely placed in its parent.
 * @param {Document} doc @param {string} tag @param {string} cls
 * @returns {HTMLElement}
 */
export function makeNode(doc, tag, cls) {
  const n = doc.createElement(tag);
  n.className = cls;
  setStyle(n, 'position', 'absolute');
  return n;
}

/**
 * A canvas that shows its pixels one to one, scaled by the view transform and never smoothed
 * (css:39-46).
 * @param {Document} doc @param {string} cls
 * @returns {HTMLCanvasElement}
 */
export function makeCanvas(doc, cls) {
  const c = /** @type {HTMLCanvasElement} */ (makeNode(doc, 'canvas', cls));
  setStyle(c, 'left', '0px');
  setStyle(c, 'top', '0px');
  setStyle(c, 'display', 'block');
  setStyle(c, 'image-rendering', 'pixelated');
  return c;
}

/**
 * Put a surface into a canvas, sizing the canvas to it. No 2D context (a headless DOM) is not an
 * error: there is simply nothing to draw into. A zero-size surface empties the canvas.
 * @param {HTMLCanvasElement} canvas @param {Surface | null} surface
 * @returns {boolean} whether pixels were written
 */
export function blit(canvas, surface) {
  const w = surface ? surface.width : 0;
  const h = surface ? surface.height : 0;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  setStyle(canvas, 'width', px(w));
  setStyle(canvas, 'height', px(h));
  if (!surface || w < 1 || h < 1) return false;
  const g = canvas.getContext('2d');
  if (!g || typeof ImageData === 'undefined') return false;
  g.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (surface.data), w, h), 0, 0);
  return true;
}

/**
 * The node's `cursor` from the element's, for a control that has one. A name with no CSS keyword
 * (a `.cur` file, an unknown word) leaves the previous cursor in place (U-21). The layers take no
 * pointer events, so this is for readers of the node; the input plane shows the cursor.
 * @param {HTMLElement} node @param {ElementModel} el
 */
export function applyCursor(node, el) {
  const css = cursorCss(el.get('cursor'));
  if (css !== null) setStyle(node, 'cursor', css);
}

/** Hide or show a node without removing it. @param {HTMLElement} node @param {boolean} visible */
export function setVisible(node, visible) {
  setStyle(node, 'display', visible ? '' : 'none');
}

/** `opacity` from alphaBlend (0..255). 255 is no opacity at all. @param {HTMLElement} node @param {number} alpha */
export function setAlpha(node, alpha) {
  const a = Math.min(255, Math.max(0, alpha));
  setStyle(node, 'opacity', a >= 255 ? '' : String(Math.round((a / 255) * 1000) / 1000));
}

/**
 * Tracks which (image, key) pairs a drawable has asked the service for, so that a decode landing
 * repaints it exactly once and a missing image is not asked for again. `want` returns the planes the
 * service can show now (the file's previous pixels while a replacement decodes) and whether this exact
 * pair has landed.
 */
export class ImageWatch {
  /**
   * @param {RenderContext} ctx
   * @param {() => void} onLand called after any watched pair lands
   */
  constructor(ctx, onLand) {
    this.ctx = ctx;
    this.onLand = onLand;
    /** @type {Set<string>} pairs that have landed (found or missing) */
    this.landed = new Set();
    /** @type {Set<string>} pairs asked for */
    this.asked = new Set();
    this.dead = false;
  }

  /**
   * @param {string} ref @param {KeySpec} spec
   * @returns {{ planes: KeyedPlanes | null, fresh: boolean }}
   */
  want(ref, spec) {
    const token = `${ref}\n${specToken(spec)}`;
    const planes = this.ctx.images.get(ref, spec);
    if (!this.asked.has(token)) {
      this.asked.add(token);
      this.ctx.images.load(ref, spec).then(
        () => {
          this.landed.add(token);
          if (!this.dead && !this.ctx.isDisposed()) this.onLand();
        },
        () => { this.landed.add(token); },
      );
    }
    return { planes, fresh: this.landed.has(token) };
  }

  /**
   * Ask for images ahead of the state that shows them (E D3: a drawable's state images are decoded
   * with the one it shows, like widgets:50), so a hover or press never waits on a decode.
   * @param {Iterable<string>} refs @param {KeySpec} spec
   */
  warm(refs, spec) {
    for (const ref of refs) if (ref) this.want(ref, spec);
  }

  /** The raw (unkeyed) map image of a ref, for a BUTTONGROUP's mapping. @param {string} ref */
  raw(ref) {
    return ref ? this.ctx.images.raw(ref) : null;
  }

  dispose() {
    this.dead = true;
  }
}
