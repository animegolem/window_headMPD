// @ts-check
// Shared pieces of the renderer tests: a skin built from strings and BMPs through the real chain
// (zip, VFS, scanner, builder, image service), a 2D-context stand-in for happy-dom (which has none),
// and a recording slot provider. Everything is synthetic: no skin art.

import { openVfs } from '../../../src/engine/archive/vfs.js';
import { decodeText } from '../../../src/engine/text/decode.js';
import { scanWms } from '../../../src/engine/wms/scan.js';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { createImageService, createInlineExecutor } from '../../../src/engine/image/service.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../../src/engine/options.js';
import { createRenderer } from '../../../src/engine/render/dom/index.js';
import { buildBmp } from '../../support/bmp-writer.js';
import { buildZip } from '../../support/zip-writer.js';

export const RED = [200, 30, 30];
export const GREEN = [30, 200, 30];
export const BLUE = [30, 30, 200];
export const GRAY = [128, 128, 128];
export const YELLOW = [220, 220, 30];
export const MAGENTA = [255, 0, 255];

/** A 24-bit BMP and its pixels. @param {number} w @param {number} h @param {(x: number, y: number) => number[]} pixel */
export function bmp(w, h, pixel) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...pixel(x, y).slice(0, 3), 255], (y * w + x) * 4);
  return { bytes: buildBmp({ width: w, height: h, bpp: 24, rgba }).bytes, rgba, width: w, height: h };
}

/** @param {number} w @param {number} h @param {string} body @param {string} [extra] */
export const view = (w, h, body, extra = '') =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false"${extra}>${body}</VIEW></THEME>`;

/**
 * What the canvases hold, as the fake context saw it: the last `putImageData` per canvas.
 * @type {WeakMap<object, { width: number, height: number, data: Uint8ClampedArray, puts: number }>}
 */
const painted = new WeakMap();

/** Give happy-dom's canvases a context that records `putImageData`. Returns a function that restores the original. */
export function stubCanvas() {
  const proto = /** @type {any} */ (HTMLCanvasElement.prototype);
  const original = proto.getContext;
  proto.getContext = function getContext() {
    const canvas = this;
    return {
      putImageData(/** @type {ImageData} */ img) {
        const prev = painted.get(canvas);
        painted.set(canvas, { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data), puts: (prev?.puts ?? 0) + 1 });
      },
    };
  };
  return () => { proto.getContext = original; };
}

/** @param {HTMLElement | undefined} canvas */
export const pixelsOf = (canvas) => (canvas ? painted.get(canvas) : undefined);

/** The RGBA at (x, y) of a painted canvas. @param {HTMLElement | undefined} canvas @param {number} x @param {number} y */
export function at(canvas, x, y) {
  const p = pixelsOf(canvas);
  if (!p) return null;
  const o = (y * p.width + x) * 4;
  return [...p.data.subarray(o, o + 4)];
}

/** A slot provider that records what it is asked, for the slot tests. */
export function recordingSlots() {
  /** @type {Array<{ kind: string, el: HTMLElement, spec: any, updates: any[], visible: boolean[], disposed: boolean }>} */
  const mounted = [];
  const provider = {
    mounted,
    mount(/** @type {HTMLElement} */ el, /** @type {any} */ spec) {
      const rec = { kind: spec.kind, el, spec, updates: [], visible: [], disposed: false };
      mounted.push(rec);
      let current = spec;
      /** @type {any} */
      const handle = {
        element: el,
        update(/** @type {any} */ s) { current = s; rec.spec = s; rec.updates.push(s); },
        setVisible(/** @type {boolean} */ v) { rec.visible.push(v); },
        hitRects: () => [{ ...current.rect }],
        onHitRectsChange: () => () => {},
        dispose() { rec.disposed = true; },
      };
      return handle;
    },
  };
  return provider;
}

/** A host window: just what the renderer reads. @param {{ zoom?: number }} [o] */
export function fakeWindow(o = {}) {
  /** @type {Set<(z: number) => void>} */
  const zoomCbs = new Set();
  return {
    zoom: o.zoom ?? 1,
    onZoom(/** @type {(z: number) => void} */ cb) { zoomCbs.add(cb); return () => zoomCbs.delete(cb); },
    setZoomTo(/** @type {number} */ z) { this.zoom = z; for (const cb of zoomCbs) cb(z); },
  };
}

/**
 * Build a skin and mount a renderer on a fresh element of the document.
 * @param {{ wms: string, files?: Record<string, { bytes: Uint8Array } | Uint8Array>, config?: 'faithful' | 'compat', opts?: object,
 *   executor?: import('../../../src/engine/contracts').DecodeExecutor, slots?: any, win?: any, clock?: any }} o
 */
export async function mountSkin(o) {
  const entries = [{ name: 'skin.wms', data: o.wms }];
  for (const [name, f] of Object.entries(o.files ?? {})) entries.push({ name, data: /** @type {any} */ (f).bytes ?? f });
  const vfs = await openVfs(buildZip(entries), 'test.wmz');
  const scanned = scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read('skin.wms'))).text);
  /** @type {import('../../../src/engine/contracts').Diagnostic[]} */
  const diags = [];
  const log = { info() {}, warn() {}, diag: (/** @type {any} */ d) => { diags.push(d); } };
  const images = createImageService(vfs, o.executor ?? createInlineExecutor(), log);
  const theme = buildTheme(/** @type {any} */ (scanned.root), vfs, { probe: (ref) => images.probe(ref) });
  const view = theme.views[0];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const slots = o.slots ?? recordingSlots();
  const win = o.win ?? fakeWindow();
  const opts = { ...(o.config === 'compat' ? ORACLE_COMPAT : FAITHFUL), ...(o.opts ?? {}) };
  const renderer = createRenderer(root, images, slots, win, opts, { clock: o.clock, log });
  renderer.mount(view);
  return { root, renderer, view, images, slots, win, diags, theme, opts };
}

/** Let decodes land (microtasks and the executor's own awaits). @param {{ images: { pending(): number } }} s */
export async function settle(s) {
  for (let i = 0; i < 50 && s.images.pending() > 0; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 0));
}

/** Apply what changed since the last frame. @param {{ renderer: any, view: any }} s */
export const frame = (s) => s.renderer.frame(s.view.takeDirty());
