// @ts-check
// The native SkinWindow (ENGINE.md §5.7, D7): the one Tauri window the engine draws in. Phase 1 has a
// single `native` window, adopted from tauri.conf.json, and one engine instance in its webview.
//
// What it does, and what it deliberately does not:
//  - Zoom is the engine's CSS scale (the DOM renderer reads `zoom` and `onZoom` and scales `div.view`)
//    plus the window's own size: `setZoom` records the zoom, tells the subscribers (that is the
//    transform), starts the native resize and re-sends the click-through shape with the new zoom, all
//    without waiting for each other, as main.js:365-373 did. This file never writes a `transform`: the
//    view would scale twice.
//  - `setShape` is coalesced to one IPC per frame. The shape is copied when it is handed over (the
//    engine may reuse its bit buffer), only the last one of a frame is sent, and a shape equal to the
//    one already sent, at the same zoom, is not sent again. Bits go as one raw `hit_set_bits` body, all
//    little-endian: u32 width, u32 height, f64 zoom, then the bits (`headcore::hit::decode_bits_body`);
//    regions go through `hit_set_regions`. Rust acts on the calling window's label, so there is no
//    label to send.
//  - `requestSize` returns false and sends nothing: phase 1 keeps the recorded decision that a script's
//    `view.width` write does not move the window (D7.3, parity D13). `setInitialSize` is the host's own
//    sizing at attach (D7.4) and does move it.
//  - Pins (`setAlwaysOnTop`, `setVisibleOnAllWorkspaces`) are passed straight through. Persisting them,
//    and the zoom, is the shell's (D7.6, the `app` prefs namespace); this window keeps no prefs.
//  - `key` is `${skinSha}/${viewId}` in the contract, but the window outlives skin reloads and exists
//    before any skin is hashed, so it starts as a placeholder and the shell calls `setKey` once it knows.
//
// Everything platform-specific arrives as an argument (the Tauri window handle, `invoke`, the frame
// scheduler), so this file loads in Node and has no Tauri import. `index.js` supplies the real ones.
//
// `onClose` registers Tauri's `onCloseRequested`, and that handler makes the page responsible for
// finishing the close with `destroy()`. It is registered only when somebody subscribes, and the
// capability file needs `core:window:allow-destroy` before anybody does.

/** @typedef {import('../../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../../engine/contracts').MaskShape} MaskShape */
/** @typedef {import('../../engine/contracts').Rect} Rect */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {(cmd: string, args?: any) => Promise<unknown> | unknown} InvokeFn Tauri's `invoke` */
/**
 * The part of `@tauri-apps/api/window`'s `Window` this file uses.
 * @typedef {{
 *   setSize(size: any): Promise<void>,
 *   startDragging(): Promise<void>,
 *   show(): Promise<void>,
 *   hide(): Promise<void>,
 *   minimize(): Promise<void>,
 *   close(): Promise<void>,
 *   setAlwaysOnTop(on: boolean): Promise<void>,
 *   setVisibleOnAllWorkspaces(on: boolean): Promise<void>,
 *   outerPosition(): Promise<{ x: number, y: number }>,
 *   outerSize(): Promise<{ width: number, height: number }>,
 *   scaleFactor(): Promise<number>,
 *   onCloseRequested(handler: (event: unknown) => unknown): Promise<() => void>,
 * }} TauriWindowHandle
 * @typedef {{
 *   win: TauriWindowHandle,
 *   invoke: InvokeFn,
 *   root?: HTMLElement | null,
 *   key?: string,
 *   zoom?: number,
 *   size?: { w: number, h: number },
 *   requestFrame?: (cb: () => void) => unknown,
 *   cancelFrame?: (id: any) => void,
 *   makeSize?: (w: number, h: number) => unknown,
 *   log?: Pick<Log, 'warn'>,
 * }} NativeWindowOptions
 *   `size` is the view size (skin px) the window already shows, when the host knows it (760x394 from
 *   tauri.conf.json); `setInitialSize` replaces it. `makeSize` builds the argument of `setSize`
 *   (default: Tauri's plain `{type: 'Logical', width, height}` form). `requestFrame` defaults to
 *   requestAnimationFrame.
 * @typedef {SkinWindow & {
 *   setKey(key: string): void,
 *   flushShape(): void,
 *   dispose(): void,
 * }} NativeSkinWindow
 *   `flushShape` sends the pending shape now instead of at the next frame (tests, and a shell that
 *   is about to show the window).
 */

/** The zoom the window will take: anything outside is clamped, so a corrupt pref cannot ask for a
 *  window the size of a building. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

const BITS_HEADER_BYTES = 16;

/** @param {number} n */
const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * The `hit_set_bits` body. @param {number} w @param {number} h @param {number} zoom @param {Uint8Array} bits
 */
export function encodeBitsBody(w, h, zoom, bits) {
  const body = new Uint8Array(BITS_HEADER_BYTES + bits.length);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, w, true);
  dv.setUint32(4, h, true);
  dv.setFloat64(8, zoom, true);
  body.set(bits, BITS_HEADER_BYTES);
  return body;
}

/**
 * The inverse of `encodeBitsBody`, as `decode_bits_body` reads it. For tests and tools.
 * @param {Uint8Array} body
 * @returns {{ w: number, h: number, zoom: number, bits: Uint8Array }}
 */
export function decodeBitsBody(body) {
  if (body.length < BITS_HEADER_BYTES) throw new RangeError(`hit bits body is truncated: ${body.length} bytes`);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return {
    w: dv.getUint32(0, true),
    h: dv.getUint32(4, true),
    zoom: dv.getFloat64(8, true),
    bits: body.slice(BITS_HEADER_BYTES),
  };
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A copy the engine cannot change under us.
 * @param {MaskShape} shape
 * @returns {{ kind: 'bits', w: number, h: number, bits: Uint8Array } | { kind: 'regions', w: number, h: number, regions: { x: number, y: number, w: number, h: number, poly?: number[] }[] }}
 */
function snapshot(shape) {
  if (shape.kind === 'bits') return { kind: 'bits', w: shape.width, h: shape.height, bits: new Uint8Array(shape.bits) };
  return {
    kind: 'regions',
    w: shape.width,
    h: shape.height,
    regions: shape.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, ...(r.poly ? { poly: [...r.poly] } : {}) })),
  };
}

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * @param {NativeWindowOptions} opts
 * @returns {NativeSkinWindow}
 */
export function createNativeSkinWindow(opts) {
  const { win, invoke } = opts;
  /** @param {string} m @param {object} [d] */
  const warn = (m, d) => {
    if (opts.log) opts.log.warn(m, d);
    else console.warn(m, d);
  };
  const requestFrame = opts.requestFrame ?? ((/** @type {() => void} */ cb) => (typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(() => cb())
    : globalThis.setTimeout(cb, 16)));
  const cancelFrame = opts.cancelFrame ?? ((/** @type {any} */ id) => (typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame(id)
    : globalThis.clearTimeout(id)));
  const makeSize = opts.makeSize ?? ((/** @type {number} */ width, /** @type {number} */ height) => ({ type: 'Logical', width, height }));

  const clampZoom = (/** @type {number} */ z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  if (opts.zoom !== undefined && !finitePositive(opts.zoom)) throw new RangeError(`zoom must be a positive number, got ${String(opts.zoom)}`);
  let zoom = opts.zoom === undefined ? 1 : clampZoom(opts.zoom);
  let key = opts.key ?? 'native/main';
  /** The view's size in skin px, once known: what a zoom change resizes the window to. @type {{ w: number, h: number } | null} */
  let viewSize = opts.size ? { w: opts.size.w, h: opts.size.h } : null;
  let disposed = false;

  // ---- shape --------------------------------------------------------------------------------------

  /** The newest shape the engine asked for, kept so a zoom change can re-send it. @type {ReturnType<typeof snapshot> | null} */
  let latest = null;
  /** What the host last sent, to skip a repeat. `regionsKey` stands in for the bits of a regions shape.
   *  @type {{ kind: 'bits', w: number, h: number, zoom: number, bits: Uint8Array } | { kind: 'regions', zoom: number, regionsKey: string } | null} */
  let sent = null;
  /** @type {{ id: unknown } | null} */
  let frame = null;

  function cancelScheduled() {
    const f = frame;
    frame = null;
    if (f) cancelFrame(f.id);
  }

  /** Send the latest shape at the current zoom unless it is what the host already sent. */
  function flush() {
    cancelScheduled();
    const shape = latest;
    if (!shape || disposed) return;
    if (shape.kind === 'bits') {
      const { w, h, bits } = shape;
      const wholeDims = Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 0xffffffff && h <= 0xffffffff;
      if (!wholeDims || bits.length !== Math.ceil((w * h) / 8)) {
        warn('window: a mask shape was dropped (its bits do not match its size)', { width: w, height: h, bytes: bits.length });
        latest = null;
        return;
      }
      if (sent?.kind === 'bits' && sent.zoom === zoom && sent.w === w && sent.h === h && sameBytes(sent.bits, bits)) return;
      sent = { kind: 'bits', w, h, zoom, bits };
      send('hit_set_bits', encodeBitsBody(w, h, zoom, bits));
      return;
    }
    if (shape.regions.length === 0) {
      // Rust refuses an empty list (it would strand the window); do not make it say so every frame.
      warn('window: an empty regions shape was dropped');
      latest = null;
      return;
    }
    const regionsKey = JSON.stringify(shape.regions);
    if (sent?.kind === 'regions' && sent.zoom === zoom && sent.regionsKey === regionsKey) return;
    sent = { kind: 'regions', zoom, regionsKey };
    send('hit_set_regions', { regions: shape.regions, zoom });
  }

  /**
   * A failed send is logged and not retried until the shape or the zoom changes: the same shape would
   * fail the same way, once a frame.
   * @param {string} cmd @param {unknown} [args]
   */
  function send(cmd, args) {
    try {
      Promise.resolve(invoke(cmd, args)).catch((e) => warn(`window: ${cmd} failed: ${messageOf(e)}`));
    } catch (e) {
      warn(`window: ${cmd} failed: ${messageOf(e)}`);
    }
  }

  // ---- size ---------------------------------------------------------------------------------------

  /** Resize the native window to the view at the current zoom. Resolves when the OS has done it. */
  function applySize() {
    if (!viewSize || disposed) return Promise.resolve();
    const w = Math.max(1, Math.round(viewSize.w * zoom));
    const h = Math.max(1, Math.round(viewSize.h * zoom));
    return Promise.resolve(win.setSize(makeSize(w, h))).then(
      () => undefined,
      (e) => { warn(`window: setSize ${w}x${h} failed: ${messageOf(e)}`); },
    );
  }

  // ---- subscriptions ------------------------------------------------------------------------------

  /** @type {Set<{ cb: (z: number) => void }>} */
  const zoomSubs = new Set();
  /** @type {Set<{ cb: () => void }>} */
  const closeSubs = new Set();
  /** @type {Promise<() => void> | null} */
  let closeListener = null;

  function fireClose() {
    for (const sub of [...closeSubs]) {
      if (!closeSubs.has(sub)) continue;
      try { sub.cb(); } catch (e) { warn(`window: an onClose callback threw: ${messageOf(e)}`); }
    }
  }

  function dropCloseListener() {
    const pending = closeListener;
    closeListener = null;
    pending?.then((unlisten) => unlisten(), () => {});
  }

  /** @type {NativeSkinWindow} */
  const self = {
    get key() { return key; },
    binding: 'native',
    root: /** @type {HTMLElement} */ (opts.root ?? null),
    get zoom() { return zoom; },

    setKey(next) {
      if (typeof next !== 'string' || next === '') throw new TypeError('window key must be a non-empty string');
      key = next;
    },

    onZoom(cb) {
      const sub = { cb };
      zoomSubs.add(sub);
      return () => { zoomSubs.delete(sub); };
    },

    async setZoom(z) {
      if (!finitePositive(z)) throw new RangeError(`zoom must be a positive number, got ${String(z)}`);
      const next = clampZoom(z);
      if (next === zoom) return;
      zoom = next;
      // The transform first (the renderer applies it from here), then the OS resize and the shape,
      // started together: the old shape at the new zoom would be wrong for a frame, so do not wait
      // for the frame to fix it.
      for (const sub of [...zoomSubs]) {
        if (!zoomSubs.has(sub)) continue;
        try { sub.cb(zoom); } catch (e) { warn(`window: an onZoom callback threw: ${messageOf(e)}`); }
      }
      const resized = applySize();
      flush();
      await resized;
    },

    async setInitialSize(w, h) {
      if (!finitePositive(w) || !finitePositive(h)) throw new RangeError(`view size must be positive, got ${String(w)}x${String(h)}`);
      viewSize = { w, h };
      await applySize();
    },

    async requestSize() {
      return false;                                          // D7.3: phase 1 does not honour view.width/height
    },

    setShape(shape) {
      if (disposed) return;
      latest = snapshot(shape);
      if (!frame) {
        const mine = { id: /** @type {unknown} */ (undefined) };
        frame = mine;
        mine.id = requestFrame(() => {
          if (frame !== mine) return;
          frame = null;
          flush();
        });
      }
    },

    flushShape: flush,

    setCapture(on) {
      send('hit_capture', { on: !!on });
    },

    startDrag() {
      Promise.resolve(win.startDragging()).catch((e) => warn(`window: startDragging failed: ${messageOf(e)}`));
    },

    async show() { await win.show(); },
    async hide() { await win.hide(); },
    async minimize() { await win.minimize(); },
    async close() { await win.close(); },
    async setAlwaysOnTop(on) { await win.setAlwaysOnTop(!!on); },
    async setVisibleOnAllWorkspaces(on) { await win.setVisibleOnAllWorkspaces(!!on); },

    async bounds() {
      const [pos, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
      const s = finitePositive(scale) ? scale : 1;          // outer* are physical px; Rect is logical
      return { x: pos.x / s, y: pos.y / s, w: size.width / s, h: size.height / s };
    },

    onClose(cb) {
      const sub = { cb };
      closeSubs.add(sub);
      if (!closeListener) {
        closeListener = Promise.resolve(win.onCloseRequested(() => { fireClose(); }));
        closeListener.catch((e) => { closeListener = null; warn(`window: onCloseRequested failed: ${messageOf(e)}`); });
      }
      return () => {
        closeSubs.delete(sub);
        if (closeSubs.size === 0) dropCloseListener();
      };
    },

    dispose() {
      disposed = true;
      cancelScheduled();
      zoomSubs.clear();
      closeSubs.clear();
      dropCloseListener();
    },
  };
  return self;
}
