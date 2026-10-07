// @ts-check
// What each element claims on the frame, in one place, for the picker (`input/picker.js`) and the
// shape rasteriser (`shape/mask.js`). Both walk the same tree in the same paint order and must agree
// on which pixel belongs to which element, so the geometry lives here and the two modules only differ
// in what they do with it: the picker stops at the first pixel that takes a hit, the rasteriser ORs
// every pixel that paints, or takes a hit on an interactive element (E D2 "Window shape").
//
// A claim is a rectangle in view px plus `at(x, y)`, which says what the element does at one pixel
// inside that rectangle: PAINT (a pixel the frame shows), HIT (a pixel that takes a press), both, or
// neither. Paint and hit come from the separate bit planes of the keying step (E D2 "Hit planes"),
// so a keyed BUTTON pixel can take a hit it does not paint and an unowned BUTTONGROUP pixel can paint
// without ever taking one. Everything is read from the model each call: there is no state here to go
// stale when a script moves an element, swaps an image or flips `visible`. The one cache is the
// BUTTONGROUP owner map (it indexes a whole image), and it checks its own inputs.
//
// Stacking: the walk assumes `stacking: 'context'` (E D5 Reading C), which is what `ViewModel.paintOrder`
// builds and what the renderer draws. 'flat' is a diagnostic switch that nothing renders.
//
// Pure: no DOM. The image service is the contract's; planes the service has not decoded yet read as
// "no image", exactly as the renderer's canvas stays empty until they land.
//
// KeySpecs and slider geometry. The renderer and this module must ask the image service for the same
// (file, spec) pair or every image decodes twice, and the thumb the picker tests must be where the
// renderer drew it, so both rule sets are imported, not copied: `image/keyspec.js` and
// `layout/slider-geometry.js` (the DOM renderer re-exports the same two modules).

import { clippingOf, keySpecFor } from '../image/keyspec.js';
import { fractionOf, stripFrame, thumbEdge } from '../layout/slider-geometry.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').ImageService} ImageService */
/** @typedef {import('../contracts').EngineOptions} EngineOptions */
/** @typedef {import('../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../contracts').Rect} Rect */

/** The element paints this pixel. */
export const PAINT = 1;
/** The element takes a press on this pixel. */
export const HIT = 2;

/**
 * What one element does on a rectangle of the frame. `at` is only asked about pixels inside the
 * rectangle. `partAt` (BUTTONGROUP only) names the BUTTONELEMENT that owns the pixel, or -1.
 * @typedef {Object} Claim
 * @property {number} x @property {number} y @property {number} w @property {number} h   view px
 * @property {(x: number, y: number) => number} at   PAINT, HIT, both or 0
 * @property {(x: number, y: number) => number} [partAt]
 */

/**
 * @typedef {Object} Scene
 * @property {ViewModel} view
 * @property {ImageService} images
 * @property {(el: ElementModel) => Rect[]} slotRects   view px, from the host's slots
 * @property {EngineOptions} opts
 * @property {number} width    the frame: the VIEW's size, or the caller's override
 * @property {number} height
 */

/**
 * What a VIEW or SUBVIEW does to itself and its subtree.
 * @typedef {Object} ContainerInfo
 * @property {{ x: number, y: number, w: number, h: number } | null} box   clips the subtree when set
 * @property {((x: number, y: number) => boolean) | null} clipAt   true where the clip mask hides a pixel
 * @property {Claim[]} claims   the background: colour fill, then image
 */

/** The §10 cap on one view axis; a frame never grows past it whatever a caller passes. */
export const MAX_AXIS = 4096;

/** Kinds the host draws as native child windows: always on top, never clipped (spec 2.8). */
export const WINDOWED_KINDS = new Set(['playlist', 'editbox', 'listbox', 'popup']);

/** Kinds that are windowless host surfaces: they stack and clip like any control (E D2). */
const SLOT_KINDS = new Set(['effects', 'video']);

const MOUSE_EVENTS = ['onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmousemove', 'onmouseover', 'onmouseout'];

/** @param {unknown} v @param {number} [d] */
export const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : '');
/** @param {Uint8Array} plane @param {number} i */
const bit = (plane, i) => (plane[i >> 3] >> (i & 7)) & 1;
/** @param {number} n */
const clampAxis = (n) => Math.max(0, Math.min(MAX_AXIS, Math.trunc(Number.isFinite(n) ? n : 0)));

/**
 * @param {ViewModel} view
 * @param {ImageService} images
 * @param {(el: ElementModel) => Rect[]} slotRects
 * @param {EngineOptions} opts
 * @param {{ width: number, height: number }} [size]   overrides the VIEW's own size
 * @returns {Scene}
 */
export function createScene(view, images, slotRects, opts, size) {
  const w = size ? size.width : num(view.view.get('width'));
  const h = size ? size.height : num(view.view.get('height'));
  return { view, images, slotRects, opts, width: clampAxis(w), height: clampAxis(h) };
}

// ---- small element questions ------------------------------------------------------------------

/** @param {ElementModel} el */
export const isVisible = (el) => el.get('visible') !== false;
/** @param {ElementModel} el */
export const isPassThrough = (el) => el.get('passthrough') === true;

/** True when the element and every ancestor is visible. @param {ElementModel} el */
export function visibleChain(el) {
  for (let e = /** @type {ElementModel | null} */ (el); e; e = e.parent) if (!isVisible(e)) return false;
  return true;
}

/** @param {ElementModel} el */
export function hasMouseHandler(el) {
  for (const ev of MOUSE_EVENTS) if (el.handlers.has(ev)) return true;
  return false;
}

/**
 * Whether a press on the element is a gesture the skin can see. Buttons, button groups and custom
 * sliders always are; a slider is interactive only with a thumb ("if no thumb image is specified,
 * the slider is non-interactive", spec 6.7); anything else with a mouse handler is.
 * @param {ElementModel} el
 */
export function isInteractive(el) {
  switch (el.kind) {
    case 'button': case 'buttongroup': case 'customslider': case 'effects':
      return true;
    case 'slider': case 'progressbar':
      return str(el.get('thumbimage')).trim() !== '' || hasMouseHandler(el);
    default:
      return hasMouseHandler(el);
  }
}

/**
 * The view-px position of an element's top-left. The VIEW's own `left`/`top` place the frame itself,
 * not its content, so the root adds nothing.
 * @param {ElementModel} el
 */
export function originOf(el) {
  let x = 0;
  let y = 0;
  for (let e = /** @type {ElementModel | null} */ (el); e && e.parent; e = e.parent) {
    x += num(e.get('left'));
    y += num(e.get('top'));
  }
  return { x, y };
}

/** The BUTTONELEMENT children of a group, in markup order: the owner map's indices. @param {ElementModel} group */
export const groupElements = (group) => group.children.filter((c) => c.kind === 'buttonelement');

// ---- claim builders ---------------------------------------------------------------------------

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} mask @returns {Claim} */
const solid = (x, y, w, h, mask) => ({ x, y, w, h, at: () => mask });

/**
 * A keyed image placed at (x, y). Cropped to (w, h), or repeated to fill it when `tiled`.
 * @param {KeyedPlanes} p @param {number} x @param {number} y @param {number} w @param {number} h @param {boolean} tiled
 * @returns {Claim | null}
 */
function planesClaim(p, x, y, w, h, tiled) {
  const pw = p.width;
  const ph = p.height;
  if (pw <= 0 || ph <= 0) return null;
  return {
    x, y, w: tiled ? w : Math.min(w, pw), h: tiled ? h : Math.min(h, ph),
    at(vx, vy) {
      let lx = vx - x;
      let ly = vy - y;
      if (tiled) { lx %= pw; ly %= ph; }
      const i = ly * pw + lx;
      return (bit(p.paint, i) ? PAINT : 0) | (bit(p.hit, i) ? HIT : 0);
    },
  };
}

/** Shrink a claim's rectangle to a box, leaving `at` as it was. @param {Claim} c @param {number} x @param {number} y @param {number} w @param {number} h @returns {Claim | null} */
function cropClaim(c, x, y, w, h) {
  const x0 = Math.max(c.x, x);
  const y0 = Math.max(c.y, y);
  const x1 = Math.min(c.x + c.w, x + w);
  const y1 = Math.min(c.y + c.h, y + h);
  return x1 > x0 && y1 > y0 ? { ...c, x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** @param {ElementModel} el @returns {{ w: number, h: number }} */
const boxSize = (el) => ({ w: Math.max(0, num(el.get('width'))), h: Math.max(0, num(el.get('height'))) });

/**
 * A VIEW or SUBVIEW: its clip box, its clip mask and its background claims. (x, y) is the container's
 * own top-left in view px. The VIEW's box is the frame and always clips; a SUBVIEW clips to its box
 * only with a non-zero size (a size-less grouping SUBVIEW must not clip, risk R10) and `subviewClip`.
 * The clip mask is the keyed background's `clip` plane at native size, drawn once from the top-left
 * (the renderer's `mask-image` is `no-repeat`), so anything the mask image does not reach is hidden.
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y
 * @returns {ContainerInfo}
 */
export function containerInfo(scene, el, x, y) {
  const isView = el.parent === null;
  const { w, h } = isView ? { w: scene.width, h: scene.height } : boxSize(el);
  const sized = w > 0 && h > 0;
  /** @type {Claim[]} */
  const claims = [];
  if (sized && typeof el.get('backgroundcolor') === 'number') claims.push(solid(x, y, w, h, PAINT | HIT));

  const ref = str(el.get('backgroundimage')).trim();
  /** @type {KeyedPlanes | null} */
  let source = null;
  if (ref) {
    const planes = scene.images.get(ref, keySpecFor(el, 'background', scene.opts));
    if (planes) {
      const tiled = el.get('backgroundtiled') === true && sized;
      const c = planesClaim(planes, x, y, tiled ? w : planes.width, tiled ? h : planes.height, tiled);
      if (c) claims.push(c);
      source = planes;
    }
  } else {
    // No background, but a clippingImage still names the region (U-7: 37 corpus SUBVIEWs use one).
    const clip = clippingOf(el);
    if (clip.clipImage !== undefined && clip.clipping !== null) {
      source = scene.images.get(clip.clipImage, { clipping: clip.clipping, hitKeyed: false });
    }
  }

  /** @type {ContainerInfo['clipAt']} */
  let clipAt = null;
  const mask = source?.clip;
  if (source && mask) {
    const mw = source.width;
    const mh = source.height;
    clipAt = (vx, vy) => {
      const lx = vx - x;
      const ly = vy - y;
      if (lx < 0 || ly < 0 || lx >= mw || ly >= mh) return true;
      return bit(mask, ly * mw + lx) === 0;
    };
  }
  const active = isView || (scene.opts.subviewClip && sized);
  return { box: active ? { x, y, w, h } : null, clipAt, claims };
}

/**
 * The image a BUTTON shows for the state the model holds. The pointer is not in the model, so hover
 * and a press in progress read as up: the same silhouette in every sane skin, and a shape that did not
 * flicker with the mouse. Fallbacks are the renderer's (`disabled ?? up`, `down ?? hover ?? up`).
 * @param {ElementModel} el
 */
function buttonRef(el) {
  const s = (/** @type {string} */ n) => str(el.get(n)).trim();
  const up = s('image');
  if (el.get('enabled') === false) return s('disabledimage') || up;
  if (el.get('sticky') === true && el.get('down') === true) return s('downimage') || s('hoverimage') || up;
  return up;
}

/** @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]} */
function buttonClaims(scene, el, x, y) {
  const { w, h } = boxSize(el);
  if (w <= 0 || h <= 0) return [];
  const ref = buttonRef(el);
  const planes = ref ? scene.images.get(ref, keySpecFor(el, 'button', scene.opts)) : null;
  // No image, or none that decoded: an invisible hot-spot over its box (spec 2.7).
  if (!planes) return [solid(x, y, w, h, HIT)];
  const c = planesClaim(planes, x, y, w, h, el.get('tiled') === true);
  return c ? [c] : [];
}

/**
 * The skin's `showBackground` when it wrote one, else the engine switch (U-23: false faithful, true
 * oracle-compat).
 * @param {Scene} scene @param {ElementModel} el
 */
function showsBackground(scene, el) {
  const explicit = el.source('showbackground') !== undefined || el.get('showbackground') === true;
  return explicit ? el.get('showbackground') === true : scene.opts.showBackgroundDefault;
}

/**
 * @typedef {{ key: string, image: object | null, owner: Int16Array }} OwnerEntry
 * @type {WeakMap<ElementModel, OwnerEntry>}
 */
const OWNER_CACHE = new WeakMap();

/**
 * Which BUTTONELEMENT owns each pixel of a group's box: an exact RGB match of the mapping image against
 * each element's `mappingColor`, the first element winning a shared colour. Alpha is ignored, as the
 * renderer's owner map and the oracle's do. Rebuilt when the map image, the box or any colour changes.
 * @param {Scene} scene @param {ElementModel} group @param {ElementModel[]} elements @param {number} w @param {number} h
 * @returns {Int16Array}
 */
function ownersOf(scene, group, elements, w, h) {
  const colors = elements.map((c) => {
    const mc = c.get('mappingcolor');
    return typeof mc === 'number' ? mc & 0xffffff : -1;
  });
  const mapRef = str(group.get('mappingimage')).trim();
  const map = mapRef ? scene.images.raw(mapRef) : null;
  const key = `${mapRef}|${w}x${h}|${colors.join(',')}`;
  const cached = OWNER_CACHE.get(group);
  if (cached && cached.key === key && cached.image === map) return cached.owner;

  const owner = new Int16Array(w * h).fill(-1);
  if (map) {
    /** @type {Map<number, number>} */
    const byColor = new Map();
    colors.forEach((c, i) => { if (c >= 0 && !byColor.has(c)) byColor.set(c, i); });
    if (byColor.size) {
      const mw = Math.min(w, map.width);
      const mh = Math.min(h, map.height);
      const d = map.data;
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          const p = (y * map.width + x) * 4;
          const i = byColor.get((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
          if (i !== undefined) owner[y * w + x] = i;
        }
      }
    }
  }
  OWNER_CACHE.set(group, { key, image: map, owner });
  return owner;
}

/**
 * BUTTONGROUP: owned pixels take the hit, never the unowned ones, whatever `showBackground` says (spec
 * 2.7). Paint is the `image` layer's, on owned pixels and, with `showBackground`, on the rest. The
 * element states are not in the model's reach, so the `image` layer stands for all five.
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]}
 */
function groupClaims(scene, el, x, y) {
  const { w, h } = boxSize(el);
  if (w <= 0 || h <= 0) return [];
  const owners = ownersOf(scene, el, groupElements(el), w, h);
  const ref = str(el.get('image')).trim();
  const planes = ref ? scene.images.get(ref, keySpecFor(el, 'button', scene.opts)) : null;
  const showBg = showsBackground(scene, el);
  return [{
    x, y, w, h,
    at(vx, vy) {
      const lx = vx - x;
      const ly = vy - y;
      const owned = owners[ly * w + lx] >= 0;
      if (!planes) return owned ? HIT : 0; // no art to read: an owned pixel is a hot-spot
      if (lx >= planes.width || ly >= planes.height) return 0;
      const i = ly * planes.width + lx;
      return (bit(planes.paint, i) && (owned || showBg) ? PAINT : 0) | (owned && bit(planes.hit, i) ? HIT : 0);
    },
    partAt: (vx, vy) => owners[(vy - y) * w + (vx - x)],
  }];
}

// ---- sliders ----------------------------------------------------------------------------------

/**
 * A slider's track (or foreground) image mapped over its box along one axis. Untiled it is drawn once
 * from the top-left. Tiled, the first and last `borderSize` px are end caps and the middle repeats from
 * the start edge (E D2 SLIDER row). The cross axis is never tiled.
 * @param {KeyedPlanes} p @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{ vertical: boolean, tiled: boolean, border: number }} o
 * @returns {Claim | null}
 */
function trackClaim(p, x, y, w, h, o) {
  const { vertical, tiled } = o;
  const pw = p.width;
  const ph = p.height;
  if (pw <= 0 || ph <= 0) return null;
  const along = vertical ? ph : pw;
  const across = vertical ? pw : ph;
  const length = vertical ? h : w;
  const b = Math.max(0, Math.min(Math.trunc(o.border) || 0, along >> 1));
  /** @param {number} a @returns {number} the source position along the axis, or -1 */
  const source = (a) => {
    if (!tiled) return a < along ? a : -1;
    if (b > 0) {
      if (a >= length - b) return along - b + (a - Math.max(0, length - b)); // the last cap wins an overlap
      if (a < b) return a;
    }
    const mid = along - 2 * b;
    return mid > 0 ? b + ((a - b) % mid) : -1;
  };
  return {
    x, y,
    w: vertical ? Math.min(w, across) : w, h: vertical ? h : Math.min(h, across),
    at(vx, vy) {
      const lx = vx - x;
      const ly = vy - y;
      const s = source(vertical ? ly : lx);
      const c = vertical ? lx : ly;
      if (s < 0 || s >= along || c >= across) return 0;
      const i = vertical ? s * pw + c : c * pw + s;
      return (bit(p.paint, i) ? PAINT : 0) | (bit(p.hit, i) ? HIT : 0);
    },
  };
}

/**
 * SLIDER and PROGRESSBAR. The thumb sits at its value; the track fills the box; the foreground is
 * paint only and is taken at full reveal (it can only add pixels the track's own art usually has).
 * A slider with no track image but a `backgroundColor` fills its box with it.
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]}
 */
function sliderClaims(scene, el, x, y) {
  const { w, h } = boxSize(el);
  if (w <= 0 || h <= 0) return [];
  const vertical = el.get('direction') === 'vertical';
  const border = num(el.get('bordersize'));
  /** @type {Claim[]} */
  const claims = [];

  const s = (/** @type {string} */ n) => str(el.get(n)).trim();
  const thumbRef = el.get('enabled') === false ? s('thumbdisabledimage') || s('thumbimage') : s('thumbimage');
  const thumb = thumbRef ? scene.images.get(thumbRef, keySpecFor(el, 'thumb', scene.opts)) : null;
  if (thumb && thumb.width > 0 && thumb.height > 0) {
    const f = fractionOf(num(el.get('value')), num(el.get('min')), num(el.get('max'), 100));
    const edge = thumbEdge(f, {
      vertical, length: vertical ? h : w, thumb: vertical ? thumb.height : thumb.width, border,
      geometry: scene.opts.sliderGeometry,
    });
    const across = Math.round(((vertical ? w : h) - (vertical ? thumb.width : thumb.height)) / 2);
    const c = planesClaim(thumb, x + (vertical ? across : edge), y + (vertical ? edge : across), thumb.width, thumb.height, false);
    const cropped = c && cropClaim(c, x, y, w, h);
    if (cropped) claims.push(cropped);
  }

  const trackOpts = { vertical, tiled: el.get('tiled') === true, border };
  const trackRef = s('backgroundimage');
  if (trackRef) {
    const planes = scene.images.get(trackRef, keySpecFor(el, 'track', scene.opts));
    const c = planes && trackClaim(planes, x, y, w, h, trackOpts);
    if (c) claims.push(c);
  } else if (typeof el.get('backgroundcolor') === 'number') {
    claims.push(solid(x, y, w, h, PAINT | HIT));
  }

  const fgRef = s('foregroundimage');
  if (fgRef) {
    const planes = scene.images.get(fgRef, keySpecFor(el, 'track', scene.opts));
    const c = planes && trackClaim(planes, x, y, w, h, trackOpts);
    if (c) claims.push({ ...c, at: (vx, vy) => c.at(vx, vy) & PAINT });
  }
  return claims;
}

/**
 * CUSTOMSLIDER: a press lands on the grey pixels of `positionImage` (R = G = B), and only there; the
 * paint is the frame of the strip the value picks (spec 6.8, U-9). The strip's longer axis holds the
 * frames, each the size of the map.
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]}
 */
function customSliderClaims(scene, el, x, y) {
  const mapRef = str(el.get('positionimage')).trim();
  const map = mapRef ? scene.images.raw(mapRef) : null;
  if (!map) return [];
  const box = boxSize(el);
  const w = Math.min(box.w > 0 ? box.w : map.width, map.width);
  const h = Math.min(box.h > 0 ? box.h : map.height, map.height);
  if (w <= 0 || h <= 0) return [];

  const stripRef = str(el.get('image')).trim();
  const strip = stripRef ? scene.images.get(stripRef, keySpecFor(el, 'strip', scene.opts)) : null;
  let fx = 0;
  let fy = 0;
  if (strip) {
    const horizontal = strip.width > map.width;
    const n = Math.max(1, Math.floor(horizontal ? strip.width / map.width : strip.height / map.height));
    const k = stripFrame(fractionOf(num(el.get('value')), num(el.get('min')), num(el.get('max'), 100)), n);
    if (horizontal) fx = k * map.width;
    else if (strip.height > map.height) fy = k * map.height;
  }
  const d = map.data;
  return [{
    x, y, w, h,
    at(vx, vy) {
      const lx = vx - x;
      const ly = vy - y;
      const p = (ly * map.width + lx) * 4;
      let m = d[p + 3] > 0 && d[p] === d[p + 1] && d[p + 1] === d[p + 2] ? HIT : 0;
      if (strip) {
        const sx = fx + lx;
        const sy = fy + ly;
        if (sx < strip.width && sy < strip.height && bit(strip.paint, sy * strip.width + sx)) m |= PAINT;
      }
      return m;
    },
  }];
}

// ---- text and slots ---------------------------------------------------------------------------

/**
 * A TEXT's box. An unset width is the measured `textWidth` (the renderer writes it); an unset height
 * is one line, which this pure module cannot measure, so it is estimated from the point size at the
 * browser's normal line height. Only an unsized TEXT takes the estimate.
 * @param {ElementModel} el
 */
function textBox(el) {
  const { w, h } = boxSize(el);
  const width = w > 0 ? w : Math.max(0, num(el.get('textwidth')));
  const px = Math.round(num(el.get('fontsize'), 10) * 4 / 3);
  const height = h > 0 ? h : Math.round(px * 1.2);
  return { w: width, h: height };
}

/** @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]} */
function textClaims(scene, el, x, y) {
  const { w, h } = textBox(el);
  if (w <= 0 || h <= 0) return [];
  // The glyphs are not known without drawing them; a TEXT with something to show claims its box.
  const paints = str(el.get('value')) !== '' || typeof el.get('backgroundcolor') === 'number';
  return [solid(x, y, w, h, HIT | (paints ? PAINT : 0))];
}

/**
 * EFFECTS and VIDEO: the host slot's reported rects, else the element's box.
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y @returns {Claim[]}
 */
function slotClaims(scene, el, x, y) {
  const reported = scene.slotRects(el);
  if (reported.length) return reported.map((r) => solid(r.x, r.y, r.w, r.h, PAINT | HIT));
  const { w, h } = boxSize(el);
  return w > 0 && h > 0 ? [solid(x, y, w, h, PAINT | HIT)] : [];
}

/**
 * The claims of one painted, non-container element, top-most first. (x, y) is the element's own
 * top-left in view px. WINDOWED kinds are not here: they sit in the top layer (`windowedLayer`).
 * @param {Scene} scene @param {ElementModel} el @param {number} x @param {number} y
 * @returns {Claim[]}
 */
export function claimsOf(scene, el, x, y) {
  switch (el.kind) {
    case 'button': return buttonClaims(scene, el, x, y);
    case 'buttongroup': return groupClaims(scene, el, x, y);
    case 'slider': case 'progressbar': return sliderClaims(scene, el, x, y);
    case 'customslider': return customSliderClaims(scene, el, x, y);
    case 'text': return textClaims(scene, el, x, y);
    default: return SLOT_KINDS.has(el.kind) ? slotClaims(scene, el, x, y) : [];
  }
}

/**
 * The native child windows' layer: every visible WINDOWED element with the rects its slot reports,
 * in source order (later on top). They ignore z, alpha and clipping (spec 2.8), so only their own
 * visibility chain decides whether they are there.
 * @param {Scene} scene
 * @returns {Array<{ el: ElementModel, claims: Claim[] }>}
 */
export function windowedLayer(scene) {
  /** @type {Array<{ el: ElementModel, claims: Claim[] }>} */
  const out = [];
  for (const el of scene.view.elements) {
    if (!WINDOWED_KINDS.has(el.kind) || !visibleChain(el)) continue;
    const claims = scene.slotRects(el).map((r) => solid(r.x, r.y, r.w, r.h, PAINT | HIT));
    if (claims.length) out.push({ el, claims });
  }
  return out;
}
