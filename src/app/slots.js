// @ts-check
// The app's SlotProvider (ENGINE.md §5.8, D10.2-D10.4): what the engine hands a host surface it does
// not draw itself. `effects` is the VizHost (viz-host.js) with its overlays (overlays.js), `playlist`
// is the playlist widget (widgets/playlist.js), and `video` is inert (parity D19: no video, and
// `onvideostart` never fires), a handle that only reports its rect so the window shape has the box.
//
// The provider is built once per app, before any skin loads. It owns the overlays, so it also owns the
// notice: `provider.notice` is what the window menu shows as its first, disabled item for a skin with
// no EFFECTS element (D10.3). `noticeColor` may be a function, read when an effects slot mounts, because
// the sidecar and the skin's first TEXT colour are known only once the skin has been built.

import { mountPlaylist } from './widgets/playlist.js';
import { createOverlays } from './overlays.js';
import { createVizHost } from './viz-host.js';

/** @typedef {import('../engine/contracts').SlotProvider} SlotProvider */
/** @typedef {import('../engine/contracts').SlotHandle} SlotHandle */
/** @typedef {import('../engine/contracts').SlotSpec} SlotSpec */
/** @typedef {import('../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../engine/contracts').PrefStore} PrefStore */
/** @typedef {import('../engine/contracts').PaletteService} PaletteService */
/** @typedef {import('./overlays.js').Invoke} Invoke */
/** @typedef {import('./overlays.js').Timers} Timers */
/** @typedef {import('./overlays.js').NoticeSource} NoticeSource */
/** @typedef {import('./overlays.js').NoticeColor} NoticeColor */
/**
 * @typedef {{
 *   media: MediaModel,
 *   prefs: Pick<PrefStore, 'load' | 'write'> & Partial<Pick<PrefStore, 'onExternalChange'>>,
 *   palette: PaletteService,
 *   invoke?: Invoke,
 *   timers?: Timers,
 *   mediacenterPrefs?: ReadonlyMap<string, string>,
 *   noticeColor?: NoticeColor | (() => NoticeColor),
 *   Viz: import('./viz-host.js').VizConstructor,
 * }} SlotDeps
 *   `invoke` is Tauri's (for `engine_info`); `timers` the engine clock's timer half (default: the
 *   page's); `mediacenterPrefs` the loaded `mediacenter` namespace; `Viz` replaces the pinned class.
 * @typedef {SlotProvider & { readonly notice: NoticeSource, dispose(): void }} AppSlotProvider
 */

/**
 * A slot that draws nothing: it keeps its box in the window shape while visible.
 * @param {HTMLElement} el @param {SlotSpec} spec @returns {SlotHandle}
 */
function inertSlot(el, spec) {
  let rect = { ...spec.rect };
  let visible = true;
  let disposed = false;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const fire = () => { for (const cb of [...listeners]) if (listeners.has(cb)) cb(); };
  return {
    element: el,
    update(next) {
      if (disposed) return;
      rect = { ...next.rect };
      fire();
    },
    setVisible(v) {
      if (disposed || visible === !!v) return;
      visible = !!v;
      fire();
    },
    hitRects: () => (visible && !disposed ? [{ ...rect }] : []),
    onHitRectsChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/**
 * @param {SlotDeps} deps
 * @returns {AppSlotProvider}
 */
export function createSlotProvider(deps) {
  const overlays = createOverlays({
    media: deps.media,
    invoke: deps.invoke,
    timers: deps.timers,
    noticeColor: deps.noticeColor,
  });
  const vizHost = createVizHost({
    prefs: deps.prefs,
    palette: deps.palette,
    overlays,
    mediacenterPrefs: deps.mediacenterPrefs,
    Viz: deps.Viz,
  });

  return {
    notice: overlays.notice,
    mount(el, spec, win) {
      switch (spec.kind) {
        case 'effects':
          return vizHost.mount(el, spec, win);
        case 'playlist':
          return mountPlaylist(el, deps.media, spec, win);
        default:
          return inertSlot(el, spec);
      }
    },
    dispose() {
      overlays.dispose();
    },
  };
}
