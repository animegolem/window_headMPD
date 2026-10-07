// @ts-check
// The pixel work behind the canvases (E D2 drawables): copying, tiling, caps and the BUTTONGROUP
// per-pixel composite. Everything is a pure function over RGBA arrays, so the same bytes go into a
// canvas by one `putImageData` and into a Node test by `toEqual`. Nothing blends: a copied pixel
// replaces what was there, alpha included, which is what `putImageData` does and what keyed art needs.
//
// A `Surface` is a width, a height and `data`, row-major RGBA, 4 bytes a pixel. A source may be any
// `KeyedPlanes` or `RgbaImage`: only those three members are read.

/**
 * @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Surface
 * @typedef {{ width: number, height: number, rgba: Uint8ClampedArray }} PlanesLike
 */

/** The most canvas area the renderer will allocate for one drawable (the image area cap, D3). */
export const MAX_SURFACE_PIXELS = 16_777_216;

/**
 * A transparent surface. Dimensions are clamped to whole, non-negative sizes inside the area cap, so
 * a skin's `width="1e9"` becomes a smaller canvas, never an allocation failure.
 * @param {number} width @param {number} height
 * @returns {Surface}
 */
export function createSurface(width, height) {
  let w = Math.max(0, Math.trunc(Number.isFinite(width) ? width : 0));
  let h = Math.max(0, Math.trunc(Number.isFinite(height) ? height : 0));
  if (w * h > MAX_SURFACE_PIXELS) {
    h = Math.min(h, Math.floor(MAX_SURFACE_PIXELS / Math.max(1, w)));
    if (w * h > MAX_SURFACE_PIXELS) w = Math.floor(MAX_SURFACE_PIXELS / Math.max(1, h));
  }
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

/** @param {PlanesLike | Surface} src @returns {Surface} */
const asSurface = (src) => ({ width: src.width, height: src.height, data: 'data' in src ? src.data : src.rgba });

/**
 * Copy a rectangle of `src` to `(dx, dy)` of `dst`, clipped to both. Copies RGBA verbatim.
 * @param {Surface} dst @param {number} dx @param {number} dy
 * @param {PlanesLike | Surface} src @param {number} sx @param {number} sy @param {number} w @param {number} h
 */
export function copyRect(dst, dx, dy, src, sx, sy, w, h) {
  const s = asSurface(src);
  // Clip the source rectangle to the source, then the destination rectangle to the destination.
  if (sx < 0) { dx -= sx; w += sx; sx = 0; }
  if (sy < 0) { dy -= sy; h += sy; sy = 0; }
  if (dx < 0) { sx -= dx; w += dx; dx = 0; }
  if (dy < 0) { sy -= dy; h += dy; dy = 0; }
  w = Math.min(w, s.width - sx, dst.width - dx);
  h = Math.min(h, s.height - sy, dst.height - dy);
  if (w <= 0 || h <= 0) return;
  for (let y = 0; y < h; y++) {
    const from = ((sy + y) * s.width + sx) * 4;
    const to = ((dy + y) * dst.width + dx) * 4;
    dst.data.set(s.data.subarray(from, from + w * 4), to);
  }
}

/**
 * Repeat the `(sx, sy, sw, sh)` part of `src` across the `(x, y, w, h)` rectangle of `dst`. The first
 * tile starts at the rectangle's top-left, and the last is cut off at its far edges, so a source
 * larger than the rectangle is simply cropped. A degenerate source or rectangle draws nothing.
 * @param {Surface} dst @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {PlanesLike | Surface} src @param {number} sx @param {number} sy @param {number} sw @param {number} sh
 */
export function tileRect(dst, x, y, w, h, src, sx, sy, sw, sh) {
  const s = asSurface(src);
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(sw, s.width - sx); sh = Math.min(sh, s.height - sy);
  if (sw <= 0 || sh <= 0 || w <= 0 || h <= 0) return;
  const x1 = Math.min(x + w, dst.width);
  const y1 = Math.min(y + h, dst.height);
  for (let ty = y; ty < y1; ty += sh) {
    for (let tx = x; tx < x1; tx += sw) {
      copyRect(dst, tx, ty, s, sx, sy, Math.min(sw, x1 - tx), Math.min(sh, y1 - ty));
    }
  }
}

/**
 * A slider track drawn into `dst` along one axis (E D2 SLIDER, spec 6.7): with `tiled` the first and
 * last `border` pixels of the source are end caps and the middle repeats from the start edge, else
 * the image is drawn once at the origin. The cross axis is never tiled. `length` is the track's
 * extent along the axis.
 * @param {Surface} dst @param {PlanesLike | Surface} src
 * @param {{ vertical: boolean, length: number, tiled: boolean, border: number }} o
 */
export function drawTrack(dst, src, o) {
  const s = asSurface(src);
  const { vertical, length, tiled } = o;
  const along = vertical ? s.height : s.width;
  const across = vertical ? s.width : s.height;
  const b = Math.max(0, Math.min(Math.trunc(o.border) || 0, along >> 1));
  if (!tiled) {
    copyRect(dst, 0, 0, s, 0, 0, s.width, s.height);
    return;
  }
  if (vertical) {
    if (b > 0) {
      copyRect(dst, 0, 0, s, 0, 0, across, Math.min(b, length));
      copyRect(dst, 0, Math.max(0, length - b), s, 0, along - b, across, Math.min(b, length));
    }
    tileRect(dst, 0, b, across, length - 2 * b, s, 0, b, across, along - 2 * b);
  } else {
    if (b > 0) {
      copyRect(dst, 0, 0, s, 0, 0, Math.min(b, length), across);
      copyRect(dst, Math.max(0, length - b), 0, s, along - b, 0, Math.min(b, length), across);
    }
    tileRect(dst, b, 0, length - 2 * b, across, s, b, 0, along - 2 * b, across);
  }
}

// ---- BUTTONGROUP -------------------------------------------------------------------------------

/**
 * Who owns each pixel of a BUTTONGROUP's mapping image (spec 6.5: an exact RGB match, no tolerance),
 * as an owner index per pixel of the group's box (-1 for nobody) and the pixel list of each element.
 * Pixels are indices into the box (`y * width + x`); a map larger than the box is cropped to it. When
 * two elements name the same colour the first declared owns it (WMP gives no rule). An element with no
 * colour (`null`) owns nothing.
 * @param {PlanesLike | Surface} map the mapping image, never keyed
 * @param {ReadonlyArray<number | null>} colors one entry per element, in index order
 * @param {number} width the group's box @param {number} height
 * @returns {{ owner: Int16Array, lists: Uint32Array[] }}
 */
export function buildOwners(map, colors, width, height) {
  const m = asSurface(map);
  const owner = new Int16Array(width * height).fill(-1);
  /** @type {Map<number, number>} */
  const byColor = new Map();
  colors.forEach((c, i) => {
    if (typeof c === 'number' && !byColor.has(c & 0xffffff)) byColor.set(c & 0xffffff, i);
  });
  const counts = new Uint32Array(colors.length);
  const w = Math.min(width, m.width);
  const h = Math.min(height, m.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * m.width + x) * 4;
      const i = byColor.get((m.data[p] << 16) | (m.data[p + 1] << 8) | m.data[p + 2]);
      if (i !== undefined) {
        owner[y * width + x] = i;
        counts[i]++;
      }
    }
  }
  const lists = Array.from(counts, (n) => new Uint32Array(n));
  const fill = new Uint32Array(colors.length);
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i];
    if (o >= 0) lists[o][fill[o]++] = i;
  }
  return { owner, lists };
}

/**
 * Write the pixels at `indices` (indices into the box, or every pixel when null) of `out` from
 * `layer`, which is any size: a pixel the layer does not reach, or no layer at all, becomes
 * transparent.
 * @param {Uint8ClampedArray} out the box's RGBA @param {number} width @param {number} height
 * @param {PlanesLike | Surface | null} layer @param {Uint32Array | null} indices
 */
export function copyPixels(out, width, height, layer, indices) {
  const s = layer ? asSurface(layer) : null;
  const count = indices ? indices.length : width * height;
  for (let n = 0; n < count; n++) {
    const i = indices ? indices[n] : n;
    const o = i * 4;
    if (s) {
      const x = i % width;
      const y = (i - x) / width;
      if (x < s.width && y < s.height) {
        const p = (y * s.width + x) * 4;
        out[o] = s.data[p]; out[o + 1] = s.data[p + 1]; out[o + 2] = s.data[p + 2]; out[o + 3] = s.data[p + 3];
        continue;
      }
    }
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
  }
}

/**
 * Indices of every pixel nobody owns: the box minus the union of the lists.
 * @param {Int16Array} owner
 * @returns {Uint32Array}
 */
export function unownedPixels(owner) {
  let n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] < 0) n++;
  const out = new Uint32Array(n);
  for (let i = 0, k = 0; i < owner.length; i++) if (owner[i] < 0) out[k++] = i;
  return out;
}
