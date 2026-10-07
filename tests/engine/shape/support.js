// @ts-check
// Shared by the picker and shape tests (WAVES W3.5): a synchronous in-test image service over
// RgbaImage literals, image builders, and a view builder over raw trees. Nothing here reads art.
//
// The image service is the contract's `ImageService` with the one change that matters to a pure
// module: `get` is synchronous and keys on demand (`keyImage`, W1.3's function), so a test never waits
// for a decode. It resolves `spec.clipImage` and hands the image to `keyImage` as `clipImg`, memoises
// by (ref, spec) like the real service, and folds ref case. Refs are skin strings, so the table is a
// Map (E §1 rule 6).

import { keyImage } from '../../../src/engine/image/keying.js';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../../src/engine/options.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */
/** @typedef {import('../../../src/engine/contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../../src/engine/contracts').KeySpec} KeySpec */
/** @typedef {import('../../../src/engine/contracts').ImageService} ImageService */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../../src/engine/contracts').EngineOptions} EngineOptions */
/** @typedef {import('../../../src/engine/contracts').Rect} Rect */

export const MAGENTA = 0xff00ff;
export const RED = 0xff0000;
export const WHITE = 0xffffff;
export const BLACK = 0x000000;
export { FAITHFUL, ORACLE_COMPAT };

/** @param {number} rgb @returns {[number, number, number, number]} */
const px = (rgb) => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255];

/**
 * An image from a per-pixel function: a 0xRRGGBB number is opaque, `[r, g, b, a]` is explicit.
 * @param {number} w @param {number} h @param {(x: number, y: number) => number | number[]} f @returns {RgbaImage}
 */
export function image(w, h, f) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      data.set(typeof v === 'number' ? px(v) : v, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** @param {number} w @param {number} h @param {number} rgb @returns {RgbaImage} */
export const solidImage = (w, h, rgb) => image(w, h, () => rgb);

/**
 * `base` everywhere except the listed pixels, which take their own colours.
 * @param {number} w @param {number} h @param {number} base @param {Array<[number, number, number]>} dots [x, y, rgb]
 */
export const dotted = (w, h, base, dots) => image(w, h, (x, y) => dots.find(([dx, dy]) => dx === x && dy === y)?.[2] ?? base);

/**
 * @typedef {ImageService & { requests: Array<{ ref: string, spec: KeySpec }>, calls: number, record: boolean }} SyncImages
 */

/**
 * @param {Map<string, RgbaImage> | Record<string, RgbaImage>} sources ref (any case) to image
 * @param {(ref: string) => RgbaImage | null} [lazy]   consulted for a ref the table lacks (the Headspace test decodes from the archive)
 * @returns {SyncImages}
 */
export function syncImages(sources, lazy) {
  /** @type {Map<string, RgbaImage>} */
  const table = new Map();
  for (const [k, v] of sources instanceof Map ? sources : Object.entries(sources)) table.set(k.toLowerCase(), v);
  /** @type {Map<string, import('../../../src/engine/contracts').KeyedPlanes>} */
  const memo = new Map();
  /** @param {unknown} ref @returns {RgbaImage | null} */
  const find = (ref) => {
    if (typeof ref !== 'string' || ref.trim() === '') return null;
    return table.get(ref.trim().toLowerCase()) ?? lazy?.(ref.trim()) ?? null;
  };
  /** @param {KeySpec} s */
  const specKey = (s) => JSON.stringify([s.transparency ?? null, s.clipping ?? null, !!s.hitKeyed, s.clipImage ?? null]);
  /** @type {SyncImages} */
  const service = {
    requests: [],
    calls: 0,
    record: true,
    probe: (ref) => {
      const img = find(ref);
      return img ? { format: 'bmp', width: img.width, height: img.height } : null;
    },
    get(ref, spec) {
      service.calls++;
      if (service.record) service.requests.push({ ref, spec });
      const img = find(ref);
      if (!img) return null;
      const key = `${String(ref).trim().toLowerCase()}|${specKey(spec)}`;
      let planes = memo.get(key);
      if (!planes) {
        planes = keyImage(img, spec, spec.clipImage ? find(spec.clipImage) : null);
        memo.set(key, planes);
      }
      return planes;
    },
    load: (ref, spec) => Promise.resolve(service.get(ref, spec)),
    raw: (ref) => find(ref),
    pending: () => 0,
  };
  return service;
}

/** @param {Record<string, string | number | boolean>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));

/**
 * A raw tree node. Attribute names are lower-cased by the real scanner, so they are here.
 * @param {string} tag @param {Record<string, string | number | boolean>} [attrs] @param {RawNode[]} [children] @returns {RawNode}
 */
export const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

const vfs = () => ({
  sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null,
});

/**
 * A built view over `kids`. The VIEW is `width` x `height` with `backgroundColor="none"` unless the
 * caller says otherwise, so only what a test puts there claims pixels.
 * @param {RawNode[]} kids
 * @param {{ width?: number, height?: number, view?: Record<string, string | number | boolean>, images?: SyncImages }} [o]
 * @returns {ViewModel}
 */
export function viewOf(kids, o = {}) {
  const images = o.images ?? null;
  const theme = buildTheme(
    N('theme', {}, [N('view', { id: 'v', width: o.width ?? 40, height: o.height ?? 40, backgroundColor: 'none', ...o.view }, kids)]),
    vfs(),
    { probe: (ref) => images?.probe(ref) ?? null },
  );
  return theme.views[0];
}

/** @param {ViewModel} view @param {string} id @returns {ElementModel} */
export function el(view, id) {
  const e = view.byId(id);
  if (!e) throw new Error(`no element ${id}`);
  return e;
}

/** A slot provider with fixed rects per element id. @param {Record<string, Rect[]>} [rects] @returns {(e: ElementModel) => Rect[]} */
export function slotsOf(rects = {}) {
  const table = new Map(Object.entries(rects));
  return (e) => table.get(e.id) ?? [];
}

/** @param {{ width: number, height: number, bits: Uint8Array }} shape @param {number} x @param {number} y */
export const bitOf = (shape, x, y) => (shape.bits[(y * shape.width + x) >> 3] >> ((y * shape.width + x) & 7)) & 1;

/** @param {{ width: number, height: number, bits: Uint8Array }} shape */
export function setBits(shape) {
  let n = 0;
  for (let i = 0; i < shape.width * shape.height; i++) n += (shape.bits[i >> 3] >> (i & 7)) & 1;
  return n;
}

/** @param {{ width: number, height: number, bits: Uint8Array }} shape @returns {Set<string>} "x,y" of every set bit */
export function setOf(shape) {
  /** @type {Set<string>} */
  const out = new Set();
  for (let y = 0; y < shape.height; y++) for (let x = 0; x < shape.width; x++) if (bitOf(shape, x, y)) out.add(`${x},${y}`);
  return out;
}
