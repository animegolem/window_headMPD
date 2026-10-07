// @ts-check
// The app shell's entry (ENGINE.md D10, D12, §6.2): `src/entry.js` imports this module when the engine
// mode is selected, and `runBoot()` below composes the real thing: the Tauri host, the engine, and the
// shell features around any skin (window menu, keys, zoom, drawer restore, fault panel, safe mode,
// legacy prefs migration, the skin registry).
//
// `boot(deps)` is that composition with every outside piece handed in, so it runs against the test host
// and a stub engine in happy-dom (tests/app/boot.test.js) exactly as it runs in the app. It never
// reaches for Tauri itself; `runBoot()` is the only place that does, and it imports those modules when
// it runs, so importing this file costs nothing and loads nothing native.
//
// Order of a launch, and why:
//   1. Watch for Shift (it cannot be asked of a webview, only observed from the first event).
//   2. Migrate the legacy `localStorage` prefs (D10.8) through a store whose writes land at once.
//      This is BEFORE the host exists because the host's DSP loads the `app` namespace (EQ and balance)
//      while it is being built, and must find the migrated values.
//   3. Build the host, handing it the shell's `actions` (`fault` shows the panel, `returnToMediaCenter`
//      toggles zoom). The shell's actions are installed on the host the engine sees whatever the host
//      did with them.
//   4. Restore the saved zoom and window pins, attach the menu and the keys. These work whatever
//      happens to the skin, which is why they come before it.
//   5. Safe mode (D10.8): a leftover `boot.pending` marker, or Shift, shows the fault panel and stops.
//   6. Resolve the skin (the env-var or first-run import, else the recorded one), arm the marker, load
//      it through the registry (zip caps, sidecar, host choice), attach its main view, replay the
//      drawers, start the marker's 10 s clock.
//
// There is no top-level `await` in this file, on purpose: Rollup places the namespace object of
// quickjs-emscripten-core's inlined dynamic import at the end of the chunk, and a suspended module
// evaluation lets that import run first and fail with "Cannot access ... before initialization".
//
// Integration (W5.2) adds the demo trigger and the notice colour; both are noted where they belong.

import './app.css';
import { createEngine as defaultCreateEngine } from '../engine/index.js';
import { createFaultPanel } from './fault-panel.js';
import { attachKeys } from './keys.js';
import { attachMenu, createNativePresenter, createPins, flipMode } from './menu.js';
import { migrateLegacyPrefs } from './migrate.js';
import { createRestore } from './restore.js';
import { createSafeMode, watchShift } from './safe-mode.js';
import { createEngineSkinHost, createSkinRegistry, SkinLoadError } from './skin-registry.js';
import { SidecarError, loadSidecar } from './sidecar.js';
import { createZoom } from './zoom.js';

/** @typedef {import('../engine/contracts').HostAdapter} HostAdapter */
/** @typedef {import('../engine/contracts').HostActions} HostActions */
/** @typedef {import('../engine/contracts').Engine} Engine */
/** @typedef {import('../engine/contracts').EngineOptions} EngineOptions */
/** @typedef {import('../engine/contracts').HostedSkin} HostedSkin */
/** @typedef {import('../engine/contracts').HostedView} HostedView */
/** @typedef {import('../engine/contracts').Sidecar} Sidecar */
/** @typedef {import('../engine/contracts').SlotProvider} SlotProvider */
/** @typedef {import('../engine/contracts').SlotHandle} SlotHandle */
/** @typedef {import('../engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../engine/contracts').MaskShape} MaskShape */
/** @typedef {import('../engine/contracts').Log} Log */
/** @typedef {import('./viz-host.js').VizConstructor} VizConstructor */
/** @typedef {import('./menu.js').MenuSpec} MenuSpec */
/** @typedef {import('./migrate.js').StorageLike} StorageLike */
/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'> & { flush?(): Promise<void> | void }} BootPrefs */
/** @typedef {{ sha: string, name: string }} SkinRecordLike */
/**
 * @typedef {{
 *   importDefault(): Promise<SkinRecordLike | null>,
 *   list?(): Promise<SkinRecordLike[]>,
 *   read(sha: string): Promise<Uint8Array | ArrayBuffer>,
 * }} SkinSource `host.skins` of the Tauri host (src/hosts/tauri/skins.js)
 * @typedef {{
 *   createHost(shell: { actions: HostActions }): Promise<HostAdapter>,
 *   prefs: BootPrefs,
 *   createEngine?: (host: HostAdapter, opts?: Partial<EngineOptions>) => Engine,
 *   engineOptions?: Partial<EngineOptions>,
 *   skins?: SkinSource,
 *   sidecarFor?: (sha: string) => Promise<Sidecar | null | undefined>,
 *   storage?: StorageLike | null,
 *   target?: EventTarget,
 *   root?: HTMLElement | null,
 *   shift?: () => boolean,
 *   menuPresenter?: (specs: MenuSpec[]) => Promise<void>,
 *   flip?: (to: 'engine' | 'legacy') => void,
 *   openVfs?: import('../engine/contracts').OpenVfsFn,
 *   onTeardown?: () => void,
 * }} BootDeps
 *   `createHost` builds the host (called after the migration, with the shell's actions); `prefs` is the
 *   store the migration and the boot marker use (its writes must land at once, or `flush` must exist);
 *   `skins` defaults to the host's own `skins`; `sidecarFor` to the committed sidecars; `storage` to
 *   `localStorage`; `target` to the window; `flip` to the engine/legacy reload; `onTeardown` runs
 *   whenever a loaded skin is torn down (reload, dispose).
 */

/** The `app` pref that remembers which skin was loaded last. */
export const ACTIVE_SKIN_PREF = 'skin';

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/** @template T @param {() => T} fn @returns {T | undefined} */
function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** The page's `localStorage`, or null when even touching it throws. @returns {StorageLike | null} */
function legacyStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @param {unknown} buf */
function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new TypeError('the skin store returned something that is not bytes');
}

/**
 * Wraps a slot provider so the shell knows which effects controls are live (the V key steps the
 * visualization, and a skin with no EFFECTS element gets the notice in its menu, D10.3). Everything else
 * passes straight through.
 * @param {SlotProvider & { notice?: { text(): string }, dispose?(): void }} inner
 */
function trackEffects(inner) {
  /** @type {Set<SlotHandle>} */
  const live = new Set();
  /** @type {SlotProvider} */
  const provider = {
    mount(el, spec, win) {
      const handle = inner.mount(el, spec, win);
      if (spec.kind !== 'effects') return handle;
      /** @type {SlotHandle} */
      const wrapped = {
        get element() { return handle.element; },
        get effects() { return handle.effects; },
        update: (s) => handle.update(s),
        setVisible: (v) => handle.setVisible(v),
        hitRects: () => handle.hitRects(),
        onHitRectsChange: (cb) => handle.onHitRectsChange(cb),
        dispose() {
          live.delete(wrapped);
          handle.dispose();
        },
      };
      live.add(wrapped);
      return wrapped;
    },
  };
  return {
    provider: Object.assign(provider, {
      notice: inner.notice,
      dispose: () => inner.dispose?.(),
    }),
    /** @returns {EffectsControl | null} the control of the effects slot that is mounted now, if any */
    effects() {
      for (const handle of live) if (handle.effects) return handle.effects;
      return null;
    },
    hasEffects: () => live.size > 0,
  };
}

/**
 * The visualizer subscribes to the audio fan-out by itself (`viz/index.js` calls `audio_subscribe` in
 * its constructor and keeps no id), and VizHost's dispose can only make the frames feed nothing. So a
 * skin reload leaks one fan-out subscriber, until something unsubscribes it (G3). This wraps the Viz
 * class: while its constructor runs, the one `audio_subscribe` call it makes is observed through
 * Tauri's internals, and the id that comes back is remembered. `releaseAll()` (a reload, a dispose)
 * unsubscribes them. Outside Tauri there are no internals and nothing is tracked.
 * @param {{
 *   unsubscribe(id: number): unknown,
 *   internals?: () => { invoke?: Function } | undefined,
 * }} deps
 */
export function createFanoutTracker({ unsubscribe, internals = () => /** @type {any} */ (globalThis).__TAURI_INTERNALS__ }) {
  /** @type {Set<number>} */
  const ids = new Set();
  let generation = 0;

  /** @param {unknown} id @param {number} born */
  function remember(id, born) {
    if (typeof id !== 'number') return;
    if (born !== generation) release(id);                   // its view is already gone
    else ids.add(id);
  }
  /** @param {number} id */
  function release(id) {
    try {
      Promise.resolve(unsubscribe(id)).catch(() => {});
    } catch { /* the subscriber ends with the window anyway (D11) */ }
  }

  return {
    /**
     * @param {VizConstructor} Base
     * @returns {VizConstructor}
     */
    track(Base) {
      return class TrackedViz extends Base {
        /** @param {ConstructorParameters<VizConstructor>} args */
        constructor(...args) {
          const api = internals();
          const original = api?.invoke;
          const born = generation;
          if (api && typeof original === 'function') {
            api.invoke = function patched(/** @type {string} */ cmd, /** @type {unknown[]} */ ...rest) {
              const result = original.call(this, cmd, ...rest);
              if (cmd === 'audio_subscribe') Promise.resolve(result).then((id) => remember(id, born), () => {});
              return result;
            };
          }
          try {
            super(...args);
          } finally {
            if (api && original) api.invoke = original;
          }
        }
      };
    },
    /** Unsubscribes every tracked subscriber; ones that arrive late from an older view are dropped as they come. */
    releaseAll() {
      generation++;
      for (const id of ids) release(id);
      ids.clear();
    },
    size: () => ids.size,
  };
}

/**
 * The shell, composed. See the header for the order.
 * @param {BootDeps} deps
 */
export async function boot(deps) {
  const target = deps.target ?? globalThis;
  const shiftWatch = deps.shift ? null : watchShift(target);
  const shift = deps.shift ?? (() => !!shiftWatch?.held());

  const migration = await migrateLegacyPrefs({
    storage: deps.storage !== undefined ? deps.storage : legacyStorage(),
    prefs: deps.prefs,
  });
  try {
    await deps.prefs.flush?.();                              // the host's stores load these files next
  } catch { /* an unflushed store still writes within its debounce */ }

  /** The pieces the host's actions need, which exist only once the host does. @type {{ fault(message: string): void, zoom: ReturnType<typeof createZoom>, sidecar: Sidecar | null } | null} */
  let shell = null;
  /** @type {Set<string>} */
  const deniedOnce = new Set();

  /** @type {HostAdapter | null} */
  let hostRef = null;
  /** @type {HostActions} */
  const actions = {
    run(action, ctx) {
      const win = hostRef?.window;
      if (action === 'returnToMediaCenter') {
        if (shell?.sidecar?.actions?.returnToMediaCenter === 'none') return;
        shell?.zoom.toggle().catch((e) => hostRef?.log.warn('zoom: toggle failed', { error: messageOf(e) }));
      } else if (action === 'minimize') {
        win?.minimize().catch((e) => hostRef?.log.warn('window: minimize failed', { error: messageOf(e) }));
      } else if (action === 'close') {
        win?.close().catch((e) => hostRef?.log.warn('window: close failed', { error: messageOf(e) }));
      } else {
        hostRef?.log.info(`actions: ${String(action)} has no handler`, ctx);
      }
    },
    denied(api, detail) {
      if (deniedOnce.has(api)) return;                       // one notice per api
      deniedOnce.add(api);
      hostRef?.log.info(`denied: ${api}`, { detail });
    },
    fault(reason) {
      shell?.fault(`This skin stopped: ${reason}`);
    },
  };

  const base = await deps.createHost({ actions });
  const effectsTracker = trackEffects(/** @type {any} */ (base.slots));
  /** The host the engine sees: the base host with the shell's actions and slot tracking. @type {HostAdapter} */
  const host = { ...base, actions, slots: effectsTracker.provider };
  hostRef = host;
  const { window: win, log } = host;

  // ---- shell features that need no skin ------------------------------------------------------------

  const zoom = createZoom({ win, prefs: host.prefs, log });
  const pins = createPins({ win, prefs: host.prefs, log });
  const safe = createSafeMode({ prefs: deps.prefs, clock: host.clock, shift });
  const registry = createSkinRegistry({ openVfs: deps.openVfs, log });
  registry.register(createEngineSkinHost((deps.createEngine ?? defaultCreateEngine)(host, deps.engineOptions)));
  const flip = deps.flip ?? ((/** @type {'engine' | 'legacy'} */ to) => flipMode(to));

  /** @type {HostedSkin | null} */
  let skin = null;
  /** @type {(HostedView & { inspector?: import('../engine/contracts').SkinInspector }) | null} */
  let view = null;
  /** @type {Sidecar | null} */
  let sidecar = null;
  /** @type {{ w: number, h: number } | null} */
  let viewSize = null;
  /** @type {ReturnType<typeof createRestore> | null} */
  let restore = null;
  /** @type {Promise<void> | null} */
  let loading = null;
  let disposed = false;

  const panel = createFaultPanel({
    win,
    root: deps.root,
    actions: { reload: () => reload(), useLegacy: () => flip('legacy') },
    size: () => viewSize ?? { w: 760, h: 394 },
    baseShape: () => attempt(() => view?.maskShape()) ?? null,
    log,
  });

  /** @param {string} message */
  function showFault(message) {
    if (disposed) return;
    try {
      panel.show(message);
    } catch (e) {
      log.warn('fault panel: could not show', { error: messageOf(e), message });
    }
  }

  const menu = attachMenu({
    target,
    mode: 'engine',
    present: deps.menuPresenter ?? createNativePresenter({ log }),
    state: () => ({
      onTop: pins.get().onTop,
      allDesktops: pins.get().allDesktops,
      zoom: zoom.get(),
      notice: effectsTracker.hasEffects() ? null : attempt(() => /** @type {any} */ (base.slots).notice?.text?.()) ?? null,
    }),
    actions: {
      toggleOnTop: () => pins.toggleOnTop(),
      toggleAllDesktops: () => pins.toggleAllDesktops(),
      toggleZoom: () => zoom.toggle(),
      reloadSkin: () => reload(),
      flipMode: flip,
    },
    log,
  });
  const keys = attachKeys({ target, media: host.media, effects: () => effectsTracker.effects() });

  // A drawer a click opens changes `eqIsOpen` inside that click's dispatch; the engine's handlers sit on
  // the plane, below the window, so by the time these bubble the global has its new value.
  const afterDispatch = () => restore?.check();
  for (const type of ['pointerup', 'keyup', 'keydown']) target.addEventListener(type, afterDispatch);

  /** @param {Event} e */
  const onError = (e) => {
    const ev = /** @type {ErrorEvent} */ (e);
    log.warn(`${ev.message} @ ${ev.filename}:${ev.lineno}`);
  };
  /** @param {Event} e */
  const onRejection = (e) => log.warn(`unhandled: ${messageOf(/** @type {PromiseRejectionEvent} */ (e).reason)}`);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);

  // Quitting inside the 10 s is not a crash. The page-hide event is the signal, not `SkinWindow.onClose`:
  // in the Tauri host that subscribes to the close request, which makes the page responsible for
  // finishing the close with `destroy()`, a permission the window's capability file does not grant.
  // The IPC is posted as the page goes; whether it lands is best effort.
  const onPageHide = () => {
    safe.clear();
    try {
      void Promise.resolve(deps.prefs.flush?.()).catch(() => {});
    } catch { /* the marker then clears at the next clean launch's 10 s mark */ }
  };
  target.addEventListener('pagehide', onPageHide);

  // ---- loading a skin ------------------------------------------------------------------------------

  async function resolveSkin() {
    const store = deps.skins ?? /** @type {SkinSource | undefined} */ (/** @type {any} */ (base).skins);
    if (!store) throw new Error('there is no skin store');
    let record = await store.importDefault();
    if (!record && store.list) {
      const all = await store.list();
      const wanted = (await host.prefs.load('app')).get(ACTIVE_SKIN_PREF);
      record = all.find((r) => r.sha === wanted) ?? all[0] ?? null;
    }
    if (!record) return null;
    return { sha: record.sha, name: record.name, bytes: toBytes(await store.read(record.sha)) };
  }

  /** The sidecar for an archive, or none: one that does not validate (or cannot be read) loads the skin without it. @param {string} sha */
  async function sidecarFor(sha) {
    try {
      return await (deps.sidecarFor ?? loadSidecar)(sha);
    } catch (e) {
      log.warn(e instanceof SidecarError ? e.message : `sidecar: ${messageOf(e)}`);
      return null;
    }
  }

  function teardown() {
    restore?.dispose();
    restore = null;
    safe.dispose();
    const hadSkin = !!(view || skin);
    attempt(() => view?.dispose());
    attempt(() => skin?.dispose());
    view = null;
    skin = null;
    sidecar = null;
    viewSize = null;
    if (hadSkin) attempt(() => deps.onTeardown?.());          // nothing was mounted, so nothing to release
  }

  async function loadSkin() {
    panel.hide();
    let source;
    try {
      source = await resolveSkin();
    } catch (e) {
      showFault(`No skin could be read: ${messageOf(e)}`);
      return;
    }
    if (!source) {
      showFault('No skin is installed. Set WINDOW_HEADMPD_SKIN to a .wmz file, or put Headspace.wmz in Downloads.');
      return;
    }
    try {
      await safe.arm();                                      // the marker lands before the skin can crash anything
      const loaded = await registry.load(source.bytes, source.name, { host, sidecarFor });
      skin = loaded.skin;
      sidecar = loaded.sidecar;
      if (shell) shell.sidecar = sidecar;
      const views = skin.views();
      const main = views.find((v) => v.main) ?? views[0];
      if (main) viewSize = { w: main.width, h: main.height };
      // The window is keyed `<sha>/<viewId>` (D7.6) from here on, and its zoom and pins are saved under
      // that key. The native window starts with a placeholder key (it exists before any skin is hashed)
      // and takes this one; the test window's key is fixed. Restore them now, before the first frame.
      attempt(() => /** @type {any} */ (win).setKey?.(`${loaded.vfs.sha}/${main?.id ?? 'main'}`));
      await Promise.all([zoom.restore(), pins.restore()]);
      view = await skin.attach(main?.id);
      restore = createRestore({ entries: sidecar?.restore, prefs: host.prefs, clock: host.clock, log });
      const inspector = view.inspector;
      if (inspector) {
        restore.bind(inspector);
        await restore.apply();                               // after onload: the drawers reopen, animated
      }
      attempt(() => host.prefs.write('app', ACTIVE_SKIN_PREF, source.sha));   // a full pref store is not a failed skin
      safe.markRunning();
    } catch (e) {
      // The marker stays set: this skin never reached a first frame (D10.8), and the next launch
      // starts in safe mode. The panel's Reload skin is the explicit retry.
      teardown();
      const detail = e instanceof SkinLoadError ? e.message : `The skin failed to start: ${messageOf(e)}`;
      log.warn('skin load failed', { error: detail });
      showFault(detail);
    }
  }

  /** Tears the current skin down and loads it again from the store. Calls made while a load runs share it. */
  function reload() {
    if (loading) return loading;
    teardown();
    loading = loadSkin().finally(() => { loading = null; });
    return loading;
  }

  shell = { fault: showFault, zoom, sidecar: null };

  // ---- go ------------------------------------------------------------------------------------------

  await Promise.all([zoom.restore(), pins.restore()]);
  const verdict = await safe.check();
  if (verdict.safe) showFault(verdict.message);
  else await reload();

  function dispose() {
    if (disposed) return;
    disposed = true;
    menu.dispose();
    keys.dispose();
    for (const type of ['pointerup', 'keyup', 'keydown']) target.removeEventListener(type, afterDispatch);
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
    target.removeEventListener('pagehide', onPageHide);
    teardown();
    panel.hide();
    shiftWatch?.dispose();
    attempt(() => Promise.resolve(/** @type {any} */ (base).dispose?.()).catch(() => {}));   // the Tauri host flushes its prefs
  }

  return {
    host,
    registry,
    zoom,
    pins,
    menu,
    keys,
    panel,
    safe,
    migration,
    reload,
    dispose,
    /** Shows the fault panel with this text. */
    fault: showFault,
    skin: () => skin,
    view: () => view,
    sidecar: () => sidecar,
  };
}

/** What the page shows when the shell itself could not start (no host, so no panel). @param {unknown} e */
function showBootFailure(e) {
  const doc = globalThis.document;
  if (!doc?.body) return;
  const box = doc.createElement('div');
  box.className = 'wh-boot-failure';
  const text = doc.createElement('p');
  text.textContent = `window_headMPD could not start: ${messageOf(e)}`;
  const legacy = doc.createElement('button');
  legacy.type = 'button';
  legacy.textContent = 'Use legacy Headspace';
  legacy.addEventListener('click', () => flipMode('legacy'));
  box.append(text, legacy);
  doc.body.append(box);
}

/**
 * The pinned visualizer, found by glob. A literal `import('../viz/index.js')` makes `tsc --checkJs` follow
 * into src/viz/*, where the pinned files carry type errors no task may fix; the glob gives Vite the same
 * file to bundle and leaves tsc out of it. (`sidecar.js` finds its JSON the same way.)
 * @type {Record<string, () => Promise<unknown>>}
 */
let vizModules = {};
try {
  vizModules = import.meta.glob('../viz/index.js');
} catch {
  // not running under Vite: runBoot cannot start the visualizer, and says so
}

/** The real composition: Tauri, the pinned Viz, the engine. Imports what it needs when it runs. */
export async function runBoot() {
  const loadViz = vizModules['../viz/index.js'];
  if (!loadViz) throw new Error('the visualizer module was not bundled');
  const [{ invoke }, { listen }, { getCurrentWindow }, { createTauriPrefs }, { createTauriHost }, { Viz }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/window'),
    import('../hosts/tauri/prefs.js'),
    import('../hosts/tauri/index.js'),
    /** @type {Promise<{ Viz: unknown }>} */ (loadViz()),
  ]);
  const early = createTauriPrefs({ invoke, listen, label: getCurrentWindow().label });
  const fanout = createFanoutTracker({ unsubscribe: (id) => invoke('audio_unsubscribe', { id }) });
  const TrackedViz = fanout.track(/** @type {VizConstructor} */ (/** @type {unknown} */ (Viz)));
  return boot({
    prefs: early,
    createHost: ({ actions }) => createTauriHost({ Viz: TrackedViz, actions }),
    onTeardown: () => fanout.releaseAll(),
  });
}

// Start on import, as entry.js expects of its engine branch. A test (or any embedder) that wants to call
// `boot()` itself sets this global to 'manual' before importing the module.
if (/** @type {any} */ (globalThis).__WINDOW_HEADMPD_BOOT__ !== 'manual') {
  runBoot().catch((e) => {
    console.error('window_headMPD: boot failed', e);
    showBootFailure(e);
  });
}
