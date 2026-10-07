// The skinlab diff machinery (E D9 "What is compared", E §9): an exact premultiplied RGBA compare
// with exclusion and allow-list masks, a bit-mask XOR, connected-component bounding boxes, per-entry
// absorbed counts against bounds, diff PNGs and a JSON report. Everything here is a pure function over
// buffers except the PNG and report writers at the bottom, so the gate logic is unit-tested without a
// browser.
//
// Conventions, because both are easy to get wrong:
//   - Masks are 1 bit per pixel, row-major, least significant bit first (pixel i = y*width + x is bit
//     i & 7 of byte i >> 3): the layout of the legacy's set_hit_mask, of headcore::hit and of the
//     engine's MaskShape 'bits'. Allow-list regions are masks in SKIN px.
//   - Counts are in SKIN px at every DPR. A skin pixel counts as differing when any of its dpr x dpr
//     device pixels differs, so a bound of 31,487 means the same thing at DPR 1 and 2. The device-pixel
//     count is reported next to it.
//   - Component and mask bounding boxes are INCLUSIVE (x0..x1, y0..y1), like the goldens manifest;
//     allow-list rects are half-open [x0,x1) x [y0,y1) and say so in allowlist.json.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

// ---- bit masks ----------------------------------------------------------------------------------------

export const maskBytes = (width, height) => (width * height + 7) >> 3;
export const newMask = (width, height) => new Uint8Array(maskBytes(width, height));
export const getBit = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;
export const setBit = (bits, i) => {
  bits[i >> 3] |= 1 << (i & 7);
};

const POP8 = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP8[i] = POP8[i >> 1] + (i & 1);

export function popcount(bits) {
  let n = 0;
  for (let i = 0; i < bits.length; i++) n += POP8[bits[i]];
  return n;
}

function sameLength(a, b, what) {
  if (a.length !== b.length) throw new RangeError(`${what}: masks differ in size (${a.length} vs ${b.length} bytes)`);
}

export function xorMask(a, b) {
  sameLength(a, b, 'xorMask');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

export function andMask(a, b) {
  sameLength(a, b, 'andMask');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

export function orMask(a, b) {
  sameLength(a, b, 'orMask');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

/** `a` without the bits of `b`. */
export function andNotMask(a, b) {
  sameLength(a, b, 'andNotMask');
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & ~b[i];
  return out;
}

export function maskEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A mask holding the half-open rect [x0,x1) x [y0,y1), clipped to the mask's size.
 * @param {number} width @param {number} height @param {readonly [number, number, number, number]} rect
 */
export function rectMask(width, height, rect) {
  const [rx0, ry0, rx1, ry1] = rect;
  const out = newMask(width, height);
  const x0 = Math.max(0, rx0);
  const x1 = Math.min(width, rx1);
  const y1 = Math.min(height, ry1);
  for (let y = Math.max(0, ry0); y < y1; y++) for (let x = x0; x < x1; x++) setBit(out, y * width + x);
  return out;
}

/** The inclusive bounding box of the set bits, or null for an empty mask. */
export function maskBBox(bits, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!getBit(bits, y * width + x)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Connected components of the set bits, 8-connected (a diagonal touch joins), as inclusive bounding
 * boxes with their pixel counts, in scan order of their first pixel. An explicit stack, never
 * recursion: a hostile checkerboard must not blow the call stack. `limit` caps the list (the count and
 * `truncated` still say how many there really were).
 * @returns {{ components: {x0:number,y0:number,x1:number,y1:number,count:number}[], total: number, truncated: boolean }}
 */
export function components(bits, width, height, limit = 200) {
  const seen = new Uint8Array((width * height + 7) >> 3);
  const stack = new Int32Array(width * height || 1);
  const out = [];
  let total = 0;
  for (let start = 0; start < width * height; start++) {
    if (!getBit(bits, start) || getBit(seen, start)) continue;
    total++;
    let sp = 0;
    stack[sp++] = start;
    setBit(seen, start);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    while (sp) {
      const i = stack[--sp];
      const x = i % width;
      const y = (i - x) / width;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (getBit(bits, j) && !getBit(seen, j)) {
            setBit(seen, j);
            stack[sp++] = j;
          }
        }
      }
    }
    if (out.length < limit) out.push({ x0, y0, x1, y1, count });
  }
  return { components: out, total, truncated: total > out.length };
}

// ---- allow-list entries as the compare functions see them ----------------------------------------------

/**
 * One active allow-list entry with its region already generated.
 * `mask` is in skin px (width/dpr x height/dpr). `bound` is a number or null (measure mode). `exact`
 * means the count must equal the bound, and also the region's own size: the entry names a set, and the
 * gate is that set, no more and no less.
 * @typedef {{ id: string, kind: 'pixel-exclusion' | 'pixel' | 'mask', mask: Uint8Array,
 *             bound: number | null, exact?: boolean }} DiffEntry
 *
 * @typedef {{ id: string, kind: string, count: number, regionSize: number, bound: number | null, exact: boolean,
 *             status: 'ok' | 'over-bound' | 'not-exact' | 'measure', unused: boolean }} EntryResult
 */

/**
 * Judge one entry. `unused` flags an entry that absorbed nothing, so stale entries surface in the
 * report; for a bound of 0 that is the goal, not staleness, so it is not flagged there.
 * @returns {EntryResult}
 */
function judgeEntry(entry, count, regionSize) {
  const exact = entry.exact === true;
  let status;
  if (entry.bound === null) status = 'measure';
  else if (exact) status = count === entry.bound && count === regionSize ? 'ok' : 'not-exact';
  else status = count > entry.bound ? 'over-bound' : 'ok';
  return { id: entry.id, kind: entry.kind, count, regionSize, bound: entry.bound, exact, status, unused: count === 0 && entry.bound !== 0 };
}

// ---- pixels -------------------------------------------------------------------------------------------

/**
 * @typedef {{ width: number, height: number, data: Uint8Array | Uint8ClampedArray }} Rgba straight (non-premultiplied) RGBA
 */

/**
 * Exact premultiplied equality of pixel `i` (an RGBA offset is `i * 4`). Two premultiplied pixels
 * (r*a, g*a, b*a, a) are equal exactly when their alphas match and, for a > 0, their colours match; at
 * a = 0 everything collapses to zero, so every alpha-0 pixel equals every other whatever colour a PNG
 * decoder left under it (E D9). No rounding, so nothing near-transparent is hidden.
 */
export function pixelsEqual(a, b, i) {
  const o = i * 4;
  const alpha = a[o + 3];
  if (alpha !== b[o + 3]) return false;
  if (alpha === 0) return true;
  return a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2];
}

/**
 * Compare two same-size RGBA images.
 * @param {Rgba} a @param {Rgba} b
 * @param {{ dpr?: number, entries?: DiffEntry[], componentLimit?: number }} [opts]
 *   entries of kind 'mask' are ignored here (they belong to `diffMasks`).
 */
export function diffImages(a, b, opts = {}) {
  const dpr = opts.dpr ?? 1;
  if (!Number.isInteger(dpr) || dpr < 1) throw new RangeError(`dpr must be a positive integer, got ${dpr}`);
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`images differ in size: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const { width, height } = a;
  if (width % dpr || height % dpr) throw new RangeError(`${width}x${height} is not a whole number of skin px at dpr ${dpr}`);
  const sw = width / dpr;
  const sh = height / dpr;
  const entries = (opts.entries ?? []).filter((e) => e.kind !== 'mask');
  for (const e of entries) {
    if (e.mask.length !== maskBytes(sw, sh)) throw new RangeError(`entry ${e.id}: mask is ${e.mask.length} bytes, ${sw}x${sh} needs ${maskBytes(sw, sh)}`);
  }

  let excluded = newMask(sw, sh);
  for (const e of entries) if (e.kind === 'pixel-exclusion') excluded = orMask(excluded, e.mask);

  // Pass 1: which device pixels differ, and which skin pixels they land in. Excluded skin pixels are
  // never compared.
  const diffSkin = newMask(sw, sh);
  const diffDev = new Uint8Array(width * height);
  let differingDevicePx = 0;
  for (let py = 0; py < height; py++) {
    const row = Math.floor(py / dpr) * sw;
    for (let px = 0; px < width; px++) {
      const s = row + Math.floor(px / dpr);
      if (getBit(excluded, s)) continue;
      const i = py * width + px;
      if (pixelsEqual(a.data, b.data, i)) continue;
      diffDev[i] = 1;
      differingDevicePx++;
      setBit(diffSkin, s);
    }
  }
  const differingSkinPx = popcount(diffSkin);

  // Pass 2: entries absorb differing skin pixels. A pixel in two entries counts for both (the bound
  // of each is about that entry, whatever else covers the pixel) and is absorbed once.
  let absorbedMask = newMask(sw, sh);
  /** @type {EntryResult[]} */
  const results = [];
  for (const e of entries) {
    const regionSize = popcount(e.mask);
    if (e.kind === 'pixel-exclusion') {
      results.push(judgeEntry(e, regionSize, regionSize));
      continue;
    }
    const hit = andMask(diffSkin, e.mask);
    absorbedMask = orMask(absorbedMask, hit);
    results.push(judgeEntry(e, popcount(hit), regionSize));
  }
  const unabsorbed = andNotMask(diffSkin, absorbedMask);
  const unabsorbedSkinPx = popcount(unabsorbed);
  const comps = components(unabsorbed, sw, sh, opts.componentLimit);

  return {
    width, height, dpr, skinWidth: sw, skinHeight: sh,
    excludedSkinPx: popcount(excluded),
    comparedSkinPx: sw * sh - popcount(excluded),
    differingDevicePx,
    differingSkinPx,
    absorbedSkinPx: differingSkinPx - unabsorbedSkinPx,
    unabsorbedSkinPx,
    bbox: maskBBox(unabsorbed, sw, sh),
    components: comps.components,
    componentCount: comps.total,
    componentsTruncated: comps.truncated,
    entries: results,
    unusedEntries: results.filter((r) => r.unused).map((r) => r.id),
    planes: { excluded, diffSkin, unabsorbed, diffDev },
  };
}

// ---- masks --------------------------------------------------------------------------------------------

/**
 * XOR two hit masks of the same size and judge it against the 'mask' entries.
 * @param {Uint8Array} a @param {Uint8Array} b
 * @param {{ width: number, height: number, entries?: DiffEntry[], componentLimit?: number }} opts
 */
export function diffMasks(a, b, opts) {
  const { width, height } = opts;
  const need = maskBytes(width, height);
  if (a.length !== need || b.length !== need) throw new RangeError(`masks must be ${need} bytes for ${width}x${height} (got ${a.length} and ${b.length})`);
  const entries = (opts.entries ?? []).filter((e) => e.kind === 'mask');
  for (const e of entries) {
    if (e.mask.length !== need) throw new RangeError(`entry ${e.id}: mask is ${e.mask.length} bytes, ${width}x${height} needs ${need}`);
  }
  const xor = xorMask(a, b);
  let absorbedMask = newMask(width, height);
  /** @type {EntryResult[]} */
  const results = [];
  for (const e of entries) {
    const hit = andMask(xor, e.mask);
    absorbedMask = orMask(absorbedMask, hit);
    results.push(judgeEntry(e, popcount(hit), popcount(e.mask)));
  }
  const unabsorbed = andNotMask(xor, absorbedMask);
  const comps = components(unabsorbed, width, height, opts.componentLimit);
  return {
    width, height,
    popcountA: popcount(a),
    popcountB: popcount(b),
    xorCount: popcount(xor),
    unabsorbedCount: popcount(unabsorbed),
    bbox: maskBBox(unabsorbed, width, height),
    components: comps.components,
    componentCount: comps.total,
    componentsTruncated: comps.truncated,
    entries: results,
    unusedEntries: results.filter((r) => r.unused).map((r) => r.id),
    planes: { xor, unabsorbed },
  };
}

// ---- the verdict --------------------------------------------------------------------------------------

/**
 * Turn a `diffImages` or `diffMasks` result into pass or fail with reasons. A null bound is measure
 * mode: it passes, and `strict` turns it into a failure.
 * @param {{ entries: EntryResult[] }} result
 * @param {{ strict?: boolean, label?: string }} [opts]
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function judge(result, opts = {}) {
  const failures = [];
  const unabsorbed = result.unabsorbedSkinPx ?? result.unabsorbedCount ?? 0;
  const what = 'unabsorbedSkinPx' in result ? 'pixel' : 'mask bit';
  if (unabsorbed > 0) failures.push(`${unabsorbed} ${what}${unabsorbed === 1 ? '' : 's'} differ outside every allowed region`);
  for (const e of result.entries) {
    if (e.status === 'over-bound') failures.push(`${e.id} absorbed ${e.count}, over its bound of ${e.bound}`);
    else if (e.status === 'not-exact') {
      failures.push(`${e.id} must be exactly ${e.bound} (region ${e.regionSize}), got ${e.count}`);
    } else if (e.status === 'measure' && opts.strict) failures.push(`${e.id} has a null bound (measure mode): ${e.count} measured`);
  }
  return { pass: failures.length === 0, failures };
}

/** The report without the bit planes, which are big and not JSON. */
export function reportOf(result) {
  const { planes: _planes, ...rest } = result;
  return rest;
}

// ---- PNG and files ------------------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {Rgba} 8-bit straight RGBA whatever the file's colour type */
export function decodePng(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

/** @param {Rgba} img @returns {Buffer} */
export function encodePng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

/**
 * A picture of a `diffImages` result: the second image dimmed to grey, excluded skin px dark blue,
 * allowed differences amber, differences nobody allowed red.
 * @param {Rgba} base @param {ReturnType<typeof diffImages>} result @returns {Rgba}
 */
export function renderDiff(base, result) {
  const { width, height, dpr, skinWidth, planes } = result;
  const out = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    const row = Math.floor(py / dpr) * skinWidth;
    for (let px = 0; px < width; px++) {
      const i = py * width + px;
      const o = i * 4;
      const s = row + Math.floor(px / dpr);
      let r;
      let g;
      let b;
      if (getBit(planes.excluded, s)) [r, g, b] = [24, 24, 80];
      else if (planes.diffDev[i]) [r, g, b] = getBit(planes.unabsorbed, s) ? [255, 0, 0] : [255, 190, 0];
      else {
        const a = base.data[o + 3] / 255;
        const lum = Math.round((0.3 * base.data[o] + 0.59 * base.data[o + 1] + 0.11 * base.data[o + 2]) * a * 0.35);
        [r, g, b] = [lum, lum, lum];
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * Write `<dir>/<name>.png` files and `report.json`. Everything written here can be derived from skin
 * art, so `dir` must be outside the repository (skinlab's run output directory is).
 * @param {string} dir
 * @param {{ pngs?: Record<string, Rgba | Uint8Array>, report?: unknown, reportName?: string }} what
 */
export async function writeOutputs(dir, what) {
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const [name, img] of Object.entries(what.pngs ?? {})) {
    const file = path.join(dir, `${name}.png`);
    await writeFile(file, img instanceof Uint8Array ? img : encodePng(img));
    written.push(file);
  }
  if (what.report !== undefined) {
    const file = path.join(dir, what.reportName ?? 'report.json');
    await writeFile(file, `${JSON.stringify(what.report, null, 2)}\n`);
    written.push(file);
  }
  return written;
}
