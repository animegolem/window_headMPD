// @ts-check
// The Tauri HostAdapter (ENGINE.md §5.8, §6.2): `createTauriHost(opts)` assembles the adapter's parts
// into the one object `createEngine` takes. It is the only file of the host that imports Tauri's
// JavaScript API, the pinned `player.js` and the app's slot and palette modules; everything it hands
// to the parts is injectable, so the composition runs under a mocked `invoke` and window in Node.
//
//  window   native SkinWindow over the current Tauri window         window.js
//  clock    requestAnimationFrame loop plus page timers              clock.js
//  prefs    Rust-file PrefStore with the `prefs-changed` event       prefs.js
//  media    the MPD MediaModel over the pinned player.js             media.js (W2.5)
//  dsp      EQ and balance over `set_eq` / `set_balance`             dsp.js (W2.5)
//  audio    AudioFrameBus over `audio_subscribe` and a Channel       audio.js
//  decode   one module Worker running the image decoder              decode.js (W2.4)
//  palette  local and default tiers                                  app/palette (W2.6)
//  slots    effects (VizHost + overlays), playlist, inert video      app/slots.js (W3.7)
//  skins    the Rust skin store, for the shell (not a HostAdapter member)   skins.js
//
// What the shell owns and this does not: the persisted zoom and pins (it passes `zoom` in and applies
// the pins), the fault panel and window menu behind `actions`, the skin sha for the window `key`, and
// the `Viz` class (the shell imports the pinned src/viz/index.js; `tsc --checkJs` follows a static
// import into it and finds errors in files this task may not fix, the W3.7 note).
//
// `windows` is the phase-1 stub: the one window is the main window, and a script's `openView` for any
// other view is logged and declined (D6.5, D7).

import { Channel as TauriChannel, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createPaletteService } from '../../app/palette/service.js';
import { createSlotProvider } from '../../app/slots.js';
import { mpd as pinnedMpd, player as pinnedPlayer } from '../../player.js';
import { createTauriAudio } from './audio.js';
import { createRafClock } from './clock.js';
import { createWorkerDecodeExecutor } from './decode.js';
import { createTauriDsp } from './dsp.js';
import { createMpdMediaModel } from './media.js';
import { createTauriPrefs } from './prefs.js';
import { createSkinStore } from './skins.js';
import { createNativeSkinWindow } from './window.js';

/** @typedef {import('../../engine/contracts').HostAdapter} HostAdapter */
/** @typedef {import('../../engine/contracts').HostActions} HostActions */
/** @typedef {import('../../engine/contracts').WindowManager} WindowManager */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {import('../../engine/contracts').DecodeExecutor} DecodeExecutor */
/** @typedef {import('./window.js').NativeSkinWindow} NativeSkinWindow */
/** @typedef {import('./window.js').TauriWindowHandle} TauriWindowHandle */
/** @typedef {import('./prefs.js').TauriPrefs} TauriPrefs */
/** @typedef {import('./prefs.js').ListenFn} ListenFn */
/** @typedef {import('./audio.js').ChannelCtor} ChannelCtor */
/** @typedef {import('./skins.js').SkinStore} SkinStore */
/** @typedef {import('./media.js').MpdMediaModel} MpdMediaModel */
/** @typedef {import('./media.js').MpdFn} MpdFn */
/** @typedef {(cmd: string, args?: any) => Promise<unknown>} InvokeFn Tauri's `invoke` */
/** @typedef {import('../../app/slots.js').AppSlotProvider} AppSlotProvider */
/** @typedef {import('../../app/viz-host.js').VizConstructor} VizConstructor */
/** @typedef {import('../../app/overlays.js').NoticeColor} NoticeColor */
/**
 * @typedef {{
 *   Viz: VizConstructor,
 *   root?: HTMLElement,
 *   key?: string,
 *   zoom?: number,
 *   size?: { w: number, h: number },
 *   noticeColor?: NoticeColor | (() => NoticeColor),
 *   actions?: Partial<HostActions>,
 *   log?: Log,
 *   startWaitMs?: number,
 *   flushPrefsOnHide?: boolean,
 *   invoke?: InvokeFn,
 *   listen?: ListenFn,
 *   Channel?: ChannelCtor,
 *   window?: TauriWindowHandle & { label: string },
 *   player?: import('./media.js').PlayerLike & { start(): Promise<unknown> },
 *   mpd?: MpdFn,
 *   decode?: DecodeExecutor & { dispose?(): void },
 * }} TauriHostOptions
 *   `Viz` is the class of the pinned src/viz/index.js, which the effects slot needs. `root` is where
 *   the engine mounts (default `#skin`, else the body); `key` is the window key and `zoom` the zoom
 *   the window starts at (the shell reads both from its prefs: default `native/main` and 1); `size`
 *   the view size the window already shows (default 760x394, tauri.conf.json). `actions` replace the
 *   host's defaults member by member. `startWaitMs` bounds how long the load waits for the player's
 *   first look at MPD (default 1500). The last seven are the seams of the test: Tauri's `invoke`,
 *   `listen`, `Channel`, the current window, the pinned `player` and `mpd`, and a decode executor.
 * @typedef {Omit<HostAdapter, 'window' | 'prefs' | 'media' | 'slots' | 'clock'> & {
 *   readonly window: NativeSkinWindow,
 *   readonly prefs: TauriPrefs,
 *   readonly media: MpdMediaModel,
 *   readonly slots: AppSlotProvider,
 *   readonly clock: import('./clock.js').RafClock,
 *   readonly skins: SkinStore,
 *   dispose(): Promise<void>,
 * }} TauriHost
 */

export const DEFAULT_VIEW_SIZE = Object.freeze({ w: 760, h: 394 });
/** How long the load waits for the player's first refresh before it goes on without it. */
export const PLAYER_START_WAIT_MS = 1500;

/** @param {unknown} d */
function show(d) {
  try { return JSON.stringify(d); } catch { return String(d); }
}

/**
 * Console logging, with warnings also sent to the terminal running the app (`js_log`, as main.js did).
 * @param {InvokeFn} invoke @returns {Log}
 */
function createConsoleLog(invoke) {
  return {
    info: (m, d) => { if (d) console.info(m, d); else console.info(m); },
    warn(m, d) {
      if (d) console.warn(m, d); else console.warn(m);
      try {
        Promise.resolve(invoke('js_log', { msg: `${m}${d ? ` ${show(d)}` : ''}` })).catch(() => {});
      } catch { /* no terminal to tell */ }
    },
    diag: (d) => { console.debug('diag', d); },
  };
}

/**
 * Wait for `player.start()` for at most `ms`. A MPD that is not running must not hold the skin back:
 * the player keeps trying in the background and the media model announces whatever it finds later.
 * @param {{ start(): Promise<unknown> }} player @param {number} ms @param {Log} log
 */
async function startPlayer(player, ms, log) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const started = Promise.resolve().then(() => player.start()).then(
    () => undefined,
    (e) => { log.warn(`player: start failed: ${e instanceof Error ? e.message : String(e)}`); },
  );
  const waited = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([started, waited]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {TauriHostOptions} opts
 * @returns {Promise<TauriHost>}
 */
export async function createTauriHost(opts) {
  if (typeof opts?.Viz !== 'function') throw new TypeError('createTauriHost: opts.Viz is the Viz class of src/viz/index.js');
  const invoke = opts.invoke ?? /** @type {InvokeFn} */ (tauriInvoke);
  const listen = opts.listen ?? /** @type {ListenFn} */ (tauriListen);
  const Channel = opts.Channel ?? /** @type {ChannelCtor} */ (/** @type {unknown} */ (TauriChannel));
  const win = opts.window ?? /** @type {TauriWindowHandle & { label: string }} */ (/** @type {unknown} */ (getCurrentWindow()));
  const log = opts.log ?? createConsoleLog(invoke);

  const clock = createRafClock({
    onError: (e) => log.warn(`clock: a callback threw: ${e instanceof Error ? e.message : String(e)}`),
  });
  const prefs = createTauriPrefs({
    invoke, listen, label: win.label, log,
    setTimer: (ms, cb) => clock.setTimer(ms, cb),
    clearTimer: (id) => clock.clearTimer(id),
  });

  const root = opts.root ?? document.getElementById('skin') ?? document.body;
  const skinWindow = createNativeSkinWindow({
    win,
    invoke,
    root,
    key: opts.key,
    zoom: opts.zoom,
    size: opts.size ?? DEFAULT_VIEW_SIZE,
    makeSize: (w, h) => new LogicalSize(w, h),
    log,
  });

  const player = opts.player ?? /** @type {any} */ (pinnedPlayer);
  const mpd = opts.mpd ?? /** @type {MpdFn} */ (pinnedMpd);
  await startPlayer(player, opts.startWaitMs ?? PLAYER_START_WAIT_MS, log);
  const media = createMpdMediaModel(player, mpd, { log });

  const dsp = await createTauriDsp(invoke, prefs, { log });
  const palette = createPaletteService(media, invoke);

  /** @type {ReadonlyMap<string, string>} */
  let mediacenterPrefs = new Map();
  try {
    mediacenterPrefs = await prefs.load('mediacenter');
  } catch (e) {
    log.warn(`prefs: the mediacenter namespace did not load: ${e instanceof Error ? e.message : String(e)}`);
  }

  const slots = createSlotProvider({
    media,
    prefs,
    palette,
    invoke,
    timers: clock,
    mediacenterPrefs,
    noticeColor: opts.noticeColor,
    Viz: opts.Viz,
  });

  const decode = opts.decode ?? createWorkerDecodeExecutor({ log });
  const audio = createTauriAudio({ invoke, Channel, log });
  const skins = createSkinStore({ invoke, log });

  /** @type {WindowManager} */
  const windows = {
    async open(viewId) {
      log.info('windows: only the main view opens in this version; openView declined', { viewId });
      return false;
    },
    async close() { /* the main window closes through `actions` */ },
    isOpen: () => false,
  };

  const denied = new Set();
  /** @type {HostActions} */
  const actions = {
    run: opts.actions?.run ?? ((action, ctx) => {
      if (action === 'minimize') skinWindow.minimize().catch((e) => log.warn(`window: minimize failed: ${e instanceof Error ? e.message : String(e)}`));
      else if (action === 'close') skinWindow.close().catch((e) => log.warn(`window: close failed: ${e instanceof Error ? e.message : String(e)}`));
      else log.info(`actions: ${action} has no handler`, ctx);
    }),
    denied: opts.actions?.denied ?? ((api, detail) => {
      if (denied.has(api)) return;                           // one notice per api (the engine also dedupes per skin)
      denied.add(api);
      log.info(`denied: ${api}`, { detail });
    }),
    fault: opts.actions?.fault ?? ((reason) => { log.warn(`skin fault: ${reason}`); }),
  };

  const flushOnHide = () => { prefs.flush().catch(() => {}); };
  const hookHide = opts.flushPrefsOnHide ?? true;
  if (hookHide) globalThis.addEventListener?.('pagehide', flushOnHide);

  return {
    kind: 'tauri',
    window: skinWindow,
    windows,
    clock,
    prefs,
    media,
    dsp,
    audio,
    palette,
    decode,
    slots,
    actions,
    log,
    skins,

    async dispose() {
      if (hookHide) globalThis.removeEventListener?.('pagehide', flushOnHide);
      await prefs.flush().catch(() => {});
      slots.dispose();
      palette.dispose();
      media.dispose();
      decode.dispose?.();
      skinWindow.dispose();
      prefs.dispose();
      clock.dispose();
    },
  };
}
