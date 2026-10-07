// @ts-check
// TestSkinWindow for the test host (ENGINE.md D8 TestHostAdapter, §5.7 SkinWindow). It is a SkinWindow
// that does nothing but remember: every `setShape`, `setCapture` and `startDrag` the engine makes is
// recorded for assertions and for skinlab (which reads the last shape as "the mask"), and the zoom is
// fixed at construction. There is no native window behind it, so the lifecycle calls (show, hide,
// minimize, close, always-on-top) resolve at once and only update a small state record.
//
// `root` is the element the engine mounts its layer tree into: the harness div skinlab's engine page
// passes, or any element in a DOM test. It is null when none is given, which is the headless Node
// mode. This module never reads the global `document`, so a headless host cannot reach for one by
// accident; code that needs a root must be handed one.

/** @typedef {import('../../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../../engine/contracts').MaskShape} MaskShape */
/** @typedef {import('../../engine/contracts').Rect} Rect */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/**
 * @typedef {{ method: string, args: unknown[] }} WindowCall every call in order, for tests that care about sequence
 * @typedef {{
 *   shapes: MaskShape[],
 *   captures: boolean[],
 *   drags: number,
 *   initialSizes: Array<{ w: number, h: number }>,
 *   sizeRequests: Array<{ w: number, h: number }>,
 *   zoomRequests: number[],
 *   calls: WindowCall[],
 * }} WindowRecord
 * @typedef {{ visible: boolean, minimized: boolean, closed: boolean, alwaysOnTop: boolean, onAllWorkspaces: boolean, capturing: boolean }} WindowState
 * @typedef {{
 *   key?: string,
 *   root?: HTMLElement | null,
 *   zoom?: number,
 *   binding?: 'native' | 'cluster',
 *   position?: { x: number, y: number },
 *   fitRoot?: boolean,
 * }} TestWindowOptions
 *   `key` is `${skinSha}/${viewId}` in the real window (default `test/main`); `zoom` is fixed (default 1);
 *   `position` is where `bounds()` puts the window (default 0,0); `fitRoot` (default true) makes
 *   `setInitialSize` set the root element's CSS width and height to the size times the zoom.
 * @typedef {SkinWindow & {
 *   readonly recorded: WindowRecord,
 *   readonly state: Readonly<WindowState>,
 *   lastShape(): MaskShape | null,
 * }} TestSkinWindow
 */

/**
 * A copy that cannot change under the recorder: the engine may reuse its bit buffer between frames.
 * @param {MaskShape} shape @returns {MaskShape}
 */
function snapshotShape(shape) {
  if (shape.kind === 'bits') return { kind: 'bits', width: shape.width, height: shape.height, bits: new Uint8Array(shape.bits) };
  return { kind: 'regions', width: shape.width, height: shape.height, regions: shape.regions.map((r) => ({ ...r, ...(r.poly ? { poly: [...r.poly] } : {}) })) };
}

/**
 * @param {TestWindowOptions} [opts]
 * @returns {TestSkinWindow}
 */
export function createTestSkinWindow(opts = {}) {
  const zoom = opts.zoom ?? 1;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0) throw new RangeError(`zoom must be a positive number, got ${String(zoom)}`);
  const position = opts.position ?? { x: 0, y: 0 };
  const fitRoot = opts.fitRoot ?? true;
  /** @type {WindowRecord} */
  const recorded = { shapes: [], captures: [], drags: 0, initialSizes: [], sizeRequests: [], zoomRequests: [], calls: [] };
  /** @type {WindowState} */
  const state = { visible: true, minimized: false, closed: false, alwaysOnTop: false, onAllWorkspaces: false, capturing: false };
  let size = { w: 0, h: 0 };
  /** @type {Set<(z: number) => void>} */
  const zoomListeners = new Set();
  /** @type {Set<() => void>} */
  const closeListeners = new Set();

  /** @param {string} method @param {unknown[]} args */
  const log = (method, args) => { recorded.calls.push({ method, args }); };

  /** @type {TestSkinWindow} */
  const win = {
    key: opts.key ?? 'test/main',
    binding: opts.binding ?? 'native',
    root: /** @type {HTMLElement} */ (opts.root ?? null),
    zoom,
    recorded,
    state,

    onZoom(cb) {
      // The zoom never changes, so nothing ever fires; the subscription exists so engine code that
      // subscribes behaves the same here as against a real window.
      zoomListeners.add(cb);
      return () => { zoomListeners.delete(cb); };
    },

    async setZoom(z) {
      log('setZoom', [z]);
      recorded.zoomRequests.push(z);                       // asked for, not applied: the zoom is fixed
    },

    async setInitialSize(w, h) {
      log('setInitialSize', [w, h]);
      recorded.initialSizes.push({ w, h });
      size = { w, h };
      // A real window resizes its webview to the skin; the test root follows so a page that hosts it
      // needs no size of its own (skinlab's engine page has none).
      if (fitRoot && win.root?.style) {
        win.root.style.width = `${w * zoom}px`;
        win.root.style.height = `${h * zoom}px`;
      }
    },

    async requestSize(w, h) {
      log('requestSize', [w, h]);
      recorded.sizeRequests.push({ w, h });
      return false;                                        // phase 1: view.width/height writes are not honoured (D7.3)
    },

    setShape(shape) {
      log('setShape', [shape.kind]);
      recorded.shapes.push(snapshotShape(shape));
    },

    setCapture(on) {
      log('setCapture', [on]);
      recorded.captures.push(!!on);
      state.capturing = !!on;
    },

    startDrag() {
      log('startDrag', []);
      recorded.drags++;
    },

    async show() { log('show', []); state.visible = true; },
    async hide() { log('hide', []); state.visible = false; },
    async minimize() { log('minimize', []); state.minimized = true; },

    async close() {
      log('close', []);
      if (state.closed) return;
      state.closed = true;
      state.visible = false;
      for (const cb of [...closeListeners]) cb();
    },

    async setAlwaysOnTop(on) { log('setAlwaysOnTop', [on]); state.alwaysOnTop = !!on; },
    async setVisibleOnAllWorkspaces(on) { log('setVisibleOnAllWorkspaces', [on]); state.onAllWorkspaces = !!on; },

    async bounds() {
      return { x: position.x, y: position.y, w: size.w * zoom, h: size.h * zoom };
    },

    onClose(cb) {
      closeListeners.add(cb);
      return () => { closeListeners.delete(cb); };
    },

    lastShape: () => recorded.shapes.at(-1) ?? null,
  };
  return win;
}
