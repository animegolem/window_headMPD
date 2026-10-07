// @ts-check
// The composition root (E §5.10 `createEngine`, `Engine`, `LoadedSkin`; E D12 `WmsSkinHost`; E §3.1
// steps 2-3). Everything here is the skin as a whole; one VIEW at a time is view-runtime.js.
//
// `Engine.load(bytes, {name, sidecar})`:
//   archive        the zip read under caps into the flat, case-folded VFS; its SHA-256 is the skin's
//                  identity (prefs namespace, sidecar key, ledger)
//   definition     the `.wms` chosen (fewest unresolved references, then the stem, then the size), its
//                  text decoded (BOM, ASCII, cp1252) and scanned
//   literal pass   the element model with literal values, default sizes from the image headers, and
//                  the sidecar's overlays appended
// and returns a `LoadedSkin`, from which `attach(viewId?)` runs the rest of the sequence for one view.
// `WmsSkinHost` is the same engine behind the phase-2 `SkinHost` seam: the skin registry opens every
// archive with `openVfs` (so every family passes the same caps) and hands this host the VFS.
//
// The main window (5F.6). `attach` returns the window, not the view: one `SkinWindow` that shows one
// view of the skin at a time. When a script hands the window to another view (theme.js
// `handOverTarget`: a write of `theme.currentViewID`, or `openView` from a view with no area, the
// splash views 34 corpus skins start on), the old view's `onclose` runs, its runtime is disposed, the
// named view is attached in the same window, sized to it (D7.4), and a `view-switch` diagnostic is
// logged. The switch runs after the dispatch that asked for it, never inside it, and at most
// `MAX_SWITCHES_PER_SECOND` times a second on the engine clock: a skin that flips views in a loop gets
// a soft fault (ledgered, counted in `health.soft`) and stays where it is. `attach` resolves once the
// hand-overs its first view asked for are done, so the shell's first frame is the view the skin
// settled on. Every member of the returned runtime reads the view shown now; `health` counts the faults
// of every view the window has shown. Opening a second window stays phase 3: while the main window is up
// (until its runtime is disposed) `attach` refuses whatever view is asked for, because a second view
// would mount a second renderer into the same root.
//
// The sidecar is our own data, but it arrives as JSON, so nothing here trusts its shape: one whose
// `skin` is not this archive's SHA-256 is ignored with a diagnostic, and every member is checked where
// it is used (overlays in wms/build.js, attributes in view-runtime.js).
//
// Options: `createEngine(host, opts)` starts from `FAITHFUL` (or `ORACLE_COMPAT` when
// `opts.config` is 'oracle-compat') and takes every key the caller gave a value; `budgets` merge per key.

import { openVfs } from './archive/vfs.js';
import { createImageService } from './image/service.js';
import { createLedger } from './model/ledger.js';
import { FAITHFUL, ORACLE_COMPAT } from './options.js';
import { decodeText } from './text/decode.js';
import { buildTheme } from './wms/build.js';
import { scanWms } from './wms/scan.js';
import { pickDefinition } from './wms/select.js';
import { attachView } from './view-runtime.js';

export { openVfs } from './archive/vfs.js';
export { FAITHFUL, ORACLE_COMPAT } from './options.js';

/** @typedef {import('./contracts').HostAdapter} HostAdapter */
/** @typedef {import('./contracts').EngineOptions} EngineOptions */
/** @typedef {import('./contracts').Engine} Engine */
/** @typedef {import('./contracts').LoadedSkin} LoadedSkin */
/** @typedef {import('./contracts').HostedSkin} HostedSkin */
/** @typedef {import('./contracts').SkinHost} SkinHost */
/** @typedef {import('./contracts').SkinVfs} SkinVfs */
/** @typedef {import('./contracts').Sidecar} Sidecar */
/** @typedef {import('./contracts').Diagnostic} Diagnostic */
/** @typedef {import('./contracts').ViewModel} ViewModel */
/** @typedef {import('./contracts').Log} Log */
/** @typedef {import('./view-runtime.js').AttachedView} AttachedView */

/** What a WMS skin is, up front (E D12): no EQ profile of its own, no PCM, one native window per view, scripted. */
export const WMS_CAPABILITIES = Object.freeze({ eq: null, wantsPcm: false, windowModel: /** @type {const} */ ('native-per-view'), scripted: true });

/** Session diagnostics kept for `diagnostics()`; the host log sees every one. */
const MAX_SESSION_DIAGNOSTICS = 4096;

/** View switches one main window makes in a second of engine time (E §10, the phase-1 `openView` cap). */
export const MAX_SWITCHES_PER_SECOND = 4;

/** Diagnostics a main window keeps from the views it no longer shows. */
const MAX_RETIRED_DIAGNOSTICS = 1024;

/** @param {unknown} v @param {number} [d] */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** @param {string} s @param {number} [n] */
const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * The options a skin runs with: a preset, then every key the caller set. A key given as `undefined`
 * keeps the preset's value; `budgets` merge per budget.
 * @param {Partial<EngineOptions> | undefined} opts
 * @returns {EngineOptions}
 */
export function resolveOptions(opts) {
  const given = opts && typeof opts === 'object' ? opts : {};
  const base = given.config === 'oracle-compat' ? ORACLE_COMPAT : FAITHFUL;
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [k, v] of Object.entries(given)) if (v !== undefined && k !== 'budgets') out[k] = v;
  out.budgets = Object.freeze({ ...base.budgets, ...(given.budgets && typeof given.budgets === 'object' ? given.budgets : {}) });
  return /** @type {EngineOptions} */ (/** @type {unknown} */ (Object.freeze(out)));
}

/**
 * Read the definition file and build the theme, then hand back the skin. Rejects only when there is no
 * skin to show (no `.wms`, no root, no view); everything else is a diagnostic.
 * @param {SkinVfs} vfs
 * @param {HostAdapter} host
 * @param {EngineOptions} opts
 * @param {Sidecar | null | undefined} sidecarIn
 * @returns {Promise<LoadedSkin>}
 */
async function loadSkin(vfs, host, opts, sidecarIn) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @param {Diagnostic} d */
  const report = (d) => {
    if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) diagnostics.push(d);
    try { host.log.diag(d); } catch { /* a broken log must not stop the skin */ }
  };
  /** @param {string} step */
  const say = (step) => { try { host.log.info(`engine: ${step}`, { skin: vfs.sha.slice(0, 12) }); } catch { /* dropped */ } };

  for (const d of vfs.diagnostics) report(d);

  let sidecar = sidecarIn && typeof sidecarIn === 'object' ? sidecarIn : null;
  if (sidecar && sidecar.skin !== vfs.sha) {
    report({ code: 'sidecar-wrong-skin', severity: 'warn', detail: `the sidecar is for skin ${clip(String(sidecar.skin), 16)}, not ${vfs.sha.slice(0, 12)}; it is ignored` });
    sidecar = null;
  }

  say('definition');
  const picked = pickDefinition(vfs);
  if (!picked) throw new Error('the archive has no .wms definition file');
  const bytes = vfs.read(picked.wms);
  if (!bytes) throw new Error(`the definition file "${clip(picked.wms)}" could not be read`);
  const scanned = scanWms(decodeText(bytes).text);
  for (const d of scanned.diagnostics) report({ ...d, file: d.file ?? picked.wms });
  if (!scanned.root) throw new Error('the definition file has no root element');

  const images = createImageService(vfs, host.decode, { info: (m, d) => host.log.info(m, d), warn: (m, d) => host.log.warn(m, d), diag: report });

  say('literal pass');
  const theme = buildTheme(scanned.root, vfs, {
    probe: (ref) => images.probe(ref),
    ...(sidecar && Array.isArray(sidecar.overlays) ? { overlays: sidecar.overlays } : {}),
    stacking: opts.stacking,
  });
  for (const d of theme.diagnostics) report(d);
  if (!theme.views.length) throw new Error('the definition file has no view');

  const ledger = createLedger(vfs.sha);
  // E D5: unknown tags are inert nodes the ledger counts (by tag, never by skin-chosen id).
  for (const v of theme.views) for (const el of v.elements) if (el.kind === 'unknown') ledger.record(`<${clip(el.tag, 64)}>`, 'unknown-tag');

  const current = theme.meta.currentViewID;
  const main = (current !== null && findView(theme.views, current)) || theme.views[0];

  /** @type {import('./view-runtime.js').Session} */
  const session = { host, opts, vfs, theme, images, ledger, sidecar, report };
  /**
   * The main window, from the moment `attach` starts opening it until its runtime is disposed. The window
   * shows one view at a time and the runtime it returns follows the hand-overs, so which view was asked
   * for first says nothing about which one is up: while this is set, no `attach` may mount another view.
   * @type {AttachedView | { opening: string } | null}
   */
  let mainWindow = null;
  let disposed = false;

  return {
    sha: vfs.sha,
    family: 'wms',
    capabilities: WMS_CAPABILITIES,
    views: () => theme.views.map((v) => ({ id: v.view.id, width: num(v.view.get('width')), height: num(v.view.get('height')), main: v === main })),
    async attach(viewId) {
      if (disposed) throw new Error('the skin has been disposed');
      const view = viewId === undefined || viewId === null ? main : findView(theme.views, String(viewId));
      if (!view) throw new Error(`the skin has no view "${clip(String(viewId))}"`);
      if (mainWindow) {
        const state = 'opening' in mainWindow ? `view "${clip(mainWindow.opening)}" is still opening` : `it shows view "${clip(mainWindow.viewId)}"`;
        throw new Error(`the main window is already attached (${state}); dispose it first`);
      }
      mainWindow = { opening: view.view.id };
      /** @type {AttachedView} */
      let runtime;
      try {
        runtime = await openMainWindow(session, view);
      } catch (e) {
        mainWindow = null;
        throw e;
      }
      if (disposed) {
        mainWindow = null;
        runtime.dispose();
        throw new Error('the skin was disposed while the view attached');
      }
      mainWindow = runtime;
      const dispose = runtime.dispose;
      runtime.dispose = () => {
        if (mainWindow === runtime) mainWindow = null;
        dispose();
      };
      return runtime;
    },
    diagnostics: () => [...diagnostics],
    ledger: () => ledger.entries(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (mainWindow && !('opening' in mainWindow)) mainWindow.dispose();
      mainWindow = null;
    },
  };
}

/**
 * The main window: attach `first`, follow the hand-overs it asks for, and return a runtime whose members
 * always read the view shown now (see the header).
 * @param {import('./view-runtime.js').Session} session
 * @param {ViewModel} first
 * @returns {Promise<AttachedView>}
 */
async function openMainWindow(session, first) {
  const { host, ledger } = session;

  /** @type {{ to: ViewModel, api: string } | null} the latest request not yet acted on */
  let requested = null;
  /** Bumped at every attach: a request from a view the window no longer shows is stale. */
  let generation = 0;
  /** An attach or a switch is running; requests wait for it to end. */
  let busy = false;
  /** @type {Promise<void> | null} */
  let pumping = null;
  /** @type {Array<() => void>} woken after each switch and when the pump goes idle */
  const waiters = [];
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  /** The next switch, or the pump going idle: a skin that keeps switching never keeps a caller waiting for good. */
  const nextStep = () => new Promise((resolve) => { if (pumping) waiters.push(() => resolve(undefined)); else resolve(undefined); });
  let disposed = false;
  /** @type {number[]} engine times of the switches made in the last second */
  const switchTimes = [];
  /** Faults of the views the window no longer shows, and the window's own (switches dropped by the cap). */
  const retired = { soft: 0, hard: 0 };
  let ownSoft = 0;
  /** @type {Diagnostic[]} */
  const kept = [];
  /** @type {Set<string>} */
  const reportedOnce = new Set();
  /** @type {Set<() => void>} */
  const dispatchListeners = new Set();

  /** @param {Diagnostic} d */
  const keep = (d) => { if (kept.length < MAX_RETIRED_DIAGNOSTICS) kept.push(d); };
  /** @param {Diagnostic} d */
  const report = (d) => {
    keep(d);
    session.report(d);
  };

  /** @param {number} gen @returns {(to: ViewModel, api: string) => void} */
  const handOverFor = (gen) => (to, api) => {
    if (disposed || gen !== generation) return;
    requested = { to, api };
    kick();
  };

  /** @param {ViewModel} view */
  const attachOne = async (view) => {
    const gen = ++generation;
    const rt = await attachView(session, view, { handOver: handOverFor(gen) });
    rt.onDispatch(() => {
      for (const cb of [...dispatchListeners]) {
        try { cb(); } catch (e) { report({ code: 'runtime-error', severity: 'error', elementId: rt.viewId, detail: `onDispatch: ${clip(messageOf(e), 300)}` }); }
      }
    });
    return rt;
  };

  busy = true;
  /** @type {AttachedView} */
  let current;
  try {
    current = await attachOne(first);
  } finally {
    busy = false;
  }
  /** @type {ViewModel} */
  let shown = first;

  /** Start acting on the request, after the dispatch that made it (it is still on the stack). */
  function kick() {
    if (busy || disposed || !requested) return;
    busy = true;
    pumping = pump().finally(() => {
      busy = false;
      pumping = null;
      kick();                      // a request that came in while the last switch was settling
      wake();
    });
  }

  async function pump() {
    await Promise.resolve();
    while (requested && !disposed) {
      const { to, api } = requested;
      requested = null;
      if (to === shown) continue;
      if (!admit(to, api)) continue;
      await switchTo(to, api);
    }
  }

  /** The cap: at most MAX_SWITCHES_PER_SECOND switches in a second; past it the request is a soft fault. @param {ViewModel} to @param {string} api */
  function admit(to, api) {
    const now = num(host.clock.now());
    while (switchTimes.length && !(now - switchTimes[0] < 1000)) switchTimes.shift();
    if (switchTimes.length < MAX_SWITCHES_PER_SECOND) {
      switchTimes.push(now);
      return true;
    }
    ownSoft++;
    ledger.record(api, 'soft-fault', `more than ${MAX_SWITCHES_PER_SECOND} view switches in a second; the switch to "${clip(to.view.id, 48)}" was dropped`);
    if (!reportedOnce.has('cap')) {
      reportedOnce.add('cap');
      report({ code: 'view-switch-cap', severity: 'warn', elementId: to.view.id,
        detail: `${api}: more than ${MAX_SWITCHES_PER_SECOND} view switches in a second; the window stays on view "${clip(shown.view.id)}"` });
    }
    return false;
  }

  /** Close the view shown, then attach `to` in the same window. @param {ViewModel} to @param {string} api */
  async function switchTo(to, api) {
    const from = current;
    const fromId = from.viewId;
    generation++;                  // the old view's requests are stale from here on, `onclose` included
    try { from.dispose(); } catch (e) { report({ code: 'runtime-error', severity: 'error', elementId: fromId, detail: `dispose: ${clip(messageOf(e), 300)}` }); }
    const h = from.health;
    retired.soft += h.soft;
    retired.hard += h.hard;
    for (const d of from.diagnostics()) keep(d);
    /** @type {AttachedView} */
    let next;
    try {
      next = await attachOne(to);
    } catch (e) {
      // The old view is gone and the new one did not start: the window shows what it last painted,
      // and the shell shows its fault panel.
      const why = `view "${clip(to.view.id)}" could not start: ${clip(messageOf(e), 200)}`;
      report({ code: 'view-switch-failed', severity: 'error', elementId: to.view.id, detail: `${api}: ${why}` });
      try { host.actions.fault(`the skin switched views and the ${why}`); } catch { /* the panel is the shell's */ }
      requested = null;
      wake();
      return;
    }
    if (disposed) {
      next.dispose();
      return;
    }
    current = next;
    shown = to;
    report({ code: 'view-switch', severity: 'info', elementId: to.view.id,
      detail: `${api}: the main window shows view "${clip(to.view.id)}" instead of "${clip(fromId)}"` });
    wake();
  }

  /** @type {import('./contracts').SkinInspector} the inspector of the view shown now */
  const inspector = {
    find: (ref) => current.inspector.find(ref),
    rectOf: (ref) => current.inspector.rectOf(ref),
    groupPoint: (ref, color) => current.inspector.groupPoint(ref, color),
    sliderThumbPoint: (ref, value) => current.inspector.sliderThumbPoint(ref, value),
    attr: (ref, name) => current.inspector.attr(ref, name),
    setAttr: (ref, name, v) => current.inspector.setAttr(ref, name, v),
    callGlobal: (name, args) => current.inspector.callGlobal(name, args),
    readGlobal: (name) => current.inspector.readGlobal(name),
    stackingDump: () => current.inspector.stackingDump(),
    root: () => current.inspector.root(),
  };

  /** @type {AttachedView} */
  const main = {
    get viewId() { return current.viewId; },
    inspector,
    get realmHealth() { return current.realmHealth; },
    get health() {
      const h = current.health;
      return { soft: retired.soft + ownSoft + h.soft, hard: retired.hard + h.hard, unloaded: h.unloaded };
    },
    maskShape: () => current.maskShape(),
    async settled() {
      // A switch in flight first, then the view it leaves shown; settling can ask for another switch.
      for (let round = 0; round < 64 && !disposed; round++) {
        if (pumping) { await nextStep(); continue; }
        await current.settled();
        if (!pumping && !requested) return;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requested = null;
      current.dispose();
      dispatchListeners.clear();
    },
    onDispatch(cb) {
      dispatchListeners.add(cb);
      return () => { dispatchListeners.delete(cb); };
    },
    diagnostics: () => [...kept, ...current.diagnostics()],
  };

  // The hand-overs the first view asked for, so the shell's first frame is the view the skin settled
  // on; a chain that never ends (each switch slower than the cap) is left running after these.
  kick();
  for (let n = 0; pumping && n <= MAX_SWITCHES_PER_SECOND; n++) await nextStep();
  return main;
}

/** A view by id: exact, then case-insensitive. @param {readonly ViewModel[]} views @param {string} id */
function findView(views, id) {
  return views.find((v) => v.view.id === id) ?? views.find((v) => v.view.id.toLowerCase() === id.toLowerCase()) ?? null;
}

/** @type {import('./contracts').CreateEngineFn} */
export const createEngine = (host, opts) => {
  const options = resolveOptions(opts);
  return {
    async load(archive, lopts) {
      const name = lopts && typeof lopts.name === 'string' && lopts.name ? lopts.name : 'skin.wmz';
      const vfs = await openVfs(archive, name);
      return loadSkin(vfs, host, options, lopts?.sidecar ?? null);
    },
  };
};

/**
 * The engine behind the `SkinHost` seam (E D12), for a registry that already opened the archive.
 * `canLoad` is 1 for an archive with a `.wms` in it and 0 otherwise.
 * @param {Partial<EngineOptions>} [opts]
 * @returns {SkinHost}
 */
export function createWmsSkinHost(opts) {
  const options = resolveOptions(opts);
  return {
    family: 'wms',
    canLoad(vfs) {
      try {
        return vfs.list('.wms').length > 0 ? 1 : 0;
      } catch {
        return 0;
      }
    },
    load: (vfs, ctx) => loadSkin(vfs, ctx.host, options, ctx.sidecar ?? null),
  };
}

/** The phase-1 host, in the shipping configuration. */
export const WmsSkinHost = createWmsSkinHost();
