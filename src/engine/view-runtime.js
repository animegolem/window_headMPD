// @ts-check
// The view runtime (E §5.10 `ViewRuntime`, E §3.1, §3.2, D1 faults, D7.3/D7.4): one attached VIEW of a
// loaded skin. `attachView` runs the load sequence of E §3.1 in its order and then owns the view's
// steady state: the realm and its dispatcher, the object graph, the bindings, the animator, the
// renderer, the input plane, the window shape and the queues that sit between them.
//
// The load sequence (each step is logged as `engine: <step>` through `host.log.info`):
//   prelude        the realm: QuickJS instance, prelude, #132 constants, host globals, class members
//   ids            every element id as a script global (the last declaration of a repeated id)
//   scripts        `scriptFile` entries in order, the implicit `<stem>.js` last; listed libraries
//   jscript:       the one `jscript:` pass, in document order
//   anchors        the size each container's children were placed for
//   sidecar        `attrs` in both configurations, `compat.attrs` under `oracle-compat` only
//   bindings       install and settle `wmpprop:`/`wmpenabled:`/`wmpdisabled:`
//   decode         the images the visible elements show, plus their state images
//   render         the window sized to the VIEW (D7.4), the layer tree mounted
//   shape          the first window shape
//   onload         the VIEW's `onload`
//   queue drain    everything queued since the literal pass, FIFO: `_onchange` from the layout pass,
//                  the bindings and onload, and script `click()`s
//   first frame    paint, shape
//   show           `SkinWindow.show()`
// The literal pass itself runs at `Engine.load` (index.js), before any view is attached. Overlays from
// the sidecar are appended there too.
//
// Queues. Nothing a host op does runs skin code before the op returns (D1), so whatever a script entry
// causes waits for it: the model's `_onchange` queue (`takeQueuedEvents`) and the object graph's
// `queueEvent` (script `click()` on a BUTTONGROUP or BUTTONELEMENT, G2) feed one FIFO here, drained
// after every entry this file makes. A click queued after a value change runs after it: `queueEvent`
// moves the model's queue across first. Each drained dispatch is a fresh realm entry, so the realm's
// own depth cap does not see the chain; the cap (32, D1) is kept here instead, together with a
// wall-clock bound for one drain (`budgets.load`, as the realm bounds its own). During the load
// sequence the queue is held until `onload` has run (E §3.1 step 9).
//
// The frame (host.clock.onFrame, E §3.2): the animator steps every tween; the bindings publish the
// position (host-side every frame, realm-visible at `realmTickHz`); the queue drains (end-of-move
// events are queued after the frame's writes, so a handler's writes paint in the same frame); the
// dirty attributes go to the renderer; and when anything shape-relevant moved, a decode landed or a
// slot's hit rects changed, the shape is rasterised and sent only if its bits differ from the last
// shape sent. The shape is always the size of the frame the window was given at attach (D7.3: a
// script write of `view.width` updates the model and goes to `requestSize`, which phase 1 refuses;
// the frame and its mask keep their size).
//
// Faults (D1). The realm counts them and unloads itself (one OOM or abort, or three hard faults in
// 30 s). After every entry the runtime looks at `realm.health`; the first time it reads `unloaded`, it
// stops the frame loop, the input, the timers and the bindings, leaves the last frame painted, and
// tells the shell through `host.actions.fault(reason)` once. The reason is the realm's own (it logs it
// as it unloads), with the last hard fault it reported.
//
// Headless. With no `host.window.root` there is nothing to mount into: no renderer, no input plane
// and no shape is sent (the corpus runner, Node tests). Images are still decoded, the frame loop
// still steps tweens and bindings, and `maskShape()` rasterises on demand.
//
// Not contract, but returned on the runtime for the shell and the tests: `onDispatch(cb)` (after every
// realm entry and its drain; the shell's sidecar `restore` reads globals then) and `diagnostics()`.

import { attachInput } from './input/dispatch.js';
import { pick } from './input/picker.js';
import { recordAnchors } from './layout/align.js';
import { evaluateLayout } from './layout/expr.js';
import { createAnimator } from './anim/animator.js';
import { createBindings } from './bind/bindings.js';
import { keySpecFor } from './image/keyspec.js';
import { createObjectGraph } from './model/objects/index.js';
import { classMembers, elementClassName } from './model/schema.js';
import { createRealm, librarySource, REALM_CAPS } from './realm/realm.js';
import { scriptLibrary } from './realm/wmploc.js';
import { createRenderer } from './render/dom/index.js';
import { rasterizeShapeWithDiagnostics } from './shape/mask.js';
import { decodeText } from './text/decode.js';
import { PLAYER_EVENTS, attrSpecFor, attrSpecsOf } from './wms/attrs.js';
import { createInspector } from './inspect.js';

/** @typedef {import('./contracts').HostAdapter} HostAdapter */
/** @typedef {import('./contracts').EngineOptions} EngineOptions */
/** @typedef {import('./contracts').SkinVfs} SkinVfs */
/** @typedef {import('./contracts').ThemeModel} ThemeModel */
/** @typedef {import('./contracts').ViewModel} ViewModel */
/** @typedef {import('./contracts').ElementModel} ElementModel */
/** @typedef {import('./contracts').ImageService} ImageService */
/** @typedef {import('./contracts').KeySpec} KeySpec */
/** @typedef {import('./contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('./contracts').Ledger} Ledger */
/** @typedef {import('./contracts').Sidecar} Sidecar */
/** @typedef {import('./contracts').Diagnostic} Diagnostic */
/** @typedef {import('./contracts').Log} Log */
/** @typedef {import('./contracts').Realm} Realm */
/** @typedef {import('./contracts').HostDispatcher} HostDispatcher */
/** @typedef {import('./contracts').ObjectGraph} ObjectGraph */
/** @typedef {import('./contracts').HostObject} HostObject */
/** @typedef {import('./contracts').HandlerSite} HandlerSite */
/** @typedef {import('./contracts').EventInit} EventInit */
/** @typedef {import('./contracts').Wire} Wire */
/** @typedef {import('./contracts').MaskShape} MaskShape */
/** @typedef {import('./contracts').Rect} Rect */
/** @typedef {import('./contracts').SkinWindow} SkinWindow */
/** @typedef {import('./contracts').InputSink} InputSink */
/** @typedef {import('./contracts').PointerTarget} PointerTarget */
/** @typedef {import('./contracts').Renderer} Renderer */
/** @typedef {import('./contracts').BindingEngine} BindingEngine */
/** @typedef {import('./contracts').Unsubscribe} Unsubscribe */
/** @typedef {import('./contracts').ViewRuntime} ViewRuntime */
/** @typedef {import('./image/keyspec.js').KeyPart} KeyPart */

/**
 * What a loaded skin shares with each of its views (built by index.js).
 * @typedef {Object} Session
 * @property {HostAdapter} host
 * @property {EngineOptions} opts
 * @property {SkinVfs} vfs
 * @property {ThemeModel} theme
 * @property {ImageService} images
 * @property {Ledger} ledger
 * @property {Sidecar | null} sidecar
 * @property {(d: Diagnostic) => void} report   session diagnostics, forwarded to `host.log.diag`
 */

/**
 * The runtime as returned: the contract's `ViewRuntime` plus two members for the shell and the tests.
 * @typedef {ViewRuntime & {
 *   onDispatch(cb: () => void): Unsubscribe,
 *   diagnostics(): Diagnostic[],
 * }} AttachedView
 */

/**
 * One queued dispatch. `depth` is how many dispatches deep its chain is (an event a user gesture or a
 * frame causes is 1); `gesture` is whether the entry that caused it was a pointer or key handler, so a
 * `value_onchange` after a drag and a script `click()` inside `onclick` stay user gestures (D6.5).
 * @typedef {{ el: ElementModel, event: string, depth: number, gesture: boolean, params?: Record<string, Wire> }} Queued
 */

/** The budget clock: the real `performance.now`, captured at module load like the realm's (D1). */
const wallClock = performance.now.bind(performance);

/** Caps the runtime keeps itself (E §10). */
export const RUNTIME_CAPS = Object.freeze({
  /** The `_onchange` chain cap of D1, counted across the runtime's own drain. */
  maxChain: REALM_CAPS.maxChainDepth,
  /** Dispatches one drain may run, besides its wall-clock bound. */
  maxDrain: 4096,
  /** Queued dispatches waiting at once. */
  maxQueued: 4096,
  /** Runtime diagnostics kept per view. */
  maxDiagnostics: 1024,
  /** Rounds `settled()` waits through before it gives up on a view that keeps itself busy. */
  maxSettleRounds: 1000,
});

/** Realm caps of E §10. */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 256 * 1024;

/** The class member lists every realm is booted with (one schema, E D6). */
const CLASS_MEMBERS = classMembers();

/**
 * The images each kind shows, by attribute, with the KeySpec role the renderer asks the image service
 * for them under (image/keyspec.js). Asking for the same (file, spec) pair matters: the service caches
 * by it, so these decodes are the renderer's, done before it mounts. Map images (`mappingImage`,
 * `positionImage`) are never keyed and are read synchronously by whoever needs them.
 * @type {ReadonlyMap<string, ReadonlyArray<readonly [string, KeyPart]>>}
 */
const IMAGE_ROLES = (() => {
  /** @type {ReadonlyArray<readonly [string, KeyPart]>} */
  const button = [['image', 'button'], ['hoverimage', 'button'], ['downimage', 'button'], ['hoverdownimage', 'button'], ['disabledimage', 'button']];
  /** @type {ReadonlyArray<readonly [string, KeyPart]>} */
  const slider = [['backgroundimage', 'track'], ['backgroundhoverimage', 'track'], ['disabledimage', 'track'], ['foregroundimage', 'track'],
    ['foregroundhoverimage', 'track'], ['thumbimage', 'thumb'], ['thumbhoverimage', 'thumb'], ['thumbdownimage', 'thumb'], ['thumbdisabledimage', 'thumb']];
  /** @type {ReadonlyArray<readonly [string, KeyPart]>} */
  const strip = [['image', 'strip'], ['hoverimage', 'strip'], ['downimage', 'strip'], ['disabledimage', 'strip']];
  /** @type {ReadonlyArray<readonly [string, KeyPart]>} */
  const background = [['backgroundimage', 'background']];
  return new Map([
    ['view', background], ['subview', background], ['button', button], ['buttongroup', button],
    ['slider', slider], ['progressbar', slider], ['customslider', strip],
  ]);
})();

/**
 * Attributes whose change cannot move a pixel of the shape: text that is not drawn, the cursor, focus,
 * the timer. Everything else that changes marks the shape for a fresh rasterisation (the send is
 * still gated on the bits).
 */
const SHAPE_NEUTRAL = new Set(['tooltip', 'uptooltip', 'downtooltip', 'cursor', 'focusobjectid', 'timerinterval', 'title', 'textwidth']);

/** Slot kinds whose host surfaces report hit rects. */
const SLOT_KINDS = new Set(['effects', 'video', 'playlist']);

/** PLAYER events the runtime raises from media changes (the rest have no source in phase 1). */
const PLAYER_RAISED = ['OpenStateChange', 'PlayStateChange', 'StatusChange', 'CurrentItemChange', 'MediaChange', 'ModeChange'];

/** @param {unknown} s */
const lower = (s) => String(s).toLowerCase();

/** @param {unknown} v @param {number} [d] */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/** @param {string} s @param {number} [n] */
const clip = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * The text a `scriptsFor` entry loads: a library's source for the ones installed when listed (the
 * prelude installs #132 itself), an archive file's decoded text otherwise; null for nothing to load
 * (a missing file was already reported by the builder).
 * @param {SkinVfs} vfs @param {string} name
 * @returns {string | null}
 */
function scriptSource(vfs, name) {
  if (/^\s*res:\/\//i.test(name)) {
    const library = scriptLibrary(name);
    return library && library.install === 'when-listed' ? librarySource(library) : null;
  }
  const bytes = vfs.read(name);
  return bytes ? decodeText(bytes).text : null;
}

/** Visible, and every ancestor too. @param {ElementModel} el */
function shown(el) {
  for (let n = /** @type {ElementModel | null} */ (el); n; n = n.parent) if (n.get('visible') === false) return false;
  return true;
}

/** Two bit shapes with the same size and bits. @param {MaskShape | null} a @param {MaskShape} b */
function sameShape(a, b) {
  if (!a || a.kind !== 'bits' || b.kind !== 'bits') return false;
  if (a.width !== b.width || a.height !== b.height || a.bits.length !== b.bits.length) return false;
  const x = a.bits;
  const y = b.bits;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Attach one VIEW: run the load sequence of E §3.1 and return its runtime. A failure before `onload`
 * (the realm cannot start, a host call throws) tears down what was built and rejects.
 * @param {Session} s
 * @param {ViewModel} view
 * @returns {Promise<AttachedView>}
 */
export async function attachView(s, view) {
  const { host, opts, vfs, theme, ledger, sidecar } = s;
  const win = host.window;
  const viewEl = view.view;
  const viewId = viewEl.id;
  const headless = !win || !win.root;

  // ---- diagnostics and logs -------------------------------------------------------------------------

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @type {Set<string>} */
  const reportedOnce = new Set();
  /** @param {Diagnostic} d */
  const report = (d) => {
    if (diagnostics.length < RUNTIME_CAPS.maxDiagnostics) diagnostics.push(d);
    s.report(d);
  };
  /** @param {Diagnostic} d @param {string} key */
  const reportOnce = (d, key) => {
    if (reportedOnce.has(key) || reportedOnce.size > 4096) return;
    reportedOnce.add(key);
    report(d);
  };
  /** @param {string} m @param {object} [d] */
  const info = (m, d) => { try { host.log.info(m, d); } catch { /* a broken log must not stop the view */ } };
  /** @param {string} m @param {object} [d] */
  const warn = (m, d) => { try { host.log.warn(m, d); } catch { /* dropped */ } };
  /** @param {string} name */
  const step = (name) => info(`engine: ${name}`, { view: viewId });
  /** A bug in host-side code, not skin text: reported once per site, never thrown into the frame. @param {string} site @param {unknown} e */
  const runtimeError = (site, e) => {
    reportOnce({ code: 'runtime-error', severity: 'error', elementId: viewId, detail: `${site}: ${clip(messageOf(e), 300)}` }, `runtime-error|${site}`);
  };

  // ---- state ----------------------------------------------------------------------------------------

  /** @type {Realm | null} */ let realm = null;
  /** @type {ObjectGraph | null} */ let graph = null;
  /** @type {BindingEngine | null} */ let bindings = null;
  /** @type {(Renderer & { setPointer(o: PointerTarget | null, p: PointerTarget | null): void, plane: HTMLElement | null }) | null} */ let renderer = null;
  /** @type {Unsubscribe | null} */ let detachInput = null;
  /** @type {Unsubscribe | null} */ let stopFrames = null;
  /** @type {Unsubscribe[]} */ const cleanup = [];
  let loading = true;
  let unloaded = false;
  let disposed = false;
  let faultReported = false;
  /** @type {string | null} */ let unloadReason = null;
  /** @type {string | null} */ let lastHardFault = null;

  /** @type {Queued[]} */ const pending = [];
  let draining = false;
  let entryDepth = 0;
  /** Depth given to what the running dispatch queues. */
  let queueDepth = 1;
  /** Whether the running dispatch is a user gesture. */
  let currentGesture = false;
  let queueCapReported = false;

  /** @type {Set<Promise<unknown>>} decodes in flight that this view asked for */
  const tracked = new Set();
  let shapeDirty = true;
  /** @type {MaskShape | null} */ let lastShape = null;
  let frameSize = { width: 0, height: 0 };
  /** @type {Array<() => void>} */ const frameWaiters = [];
  /** @type {Set<() => void>} */ const dispatchListeners = new Set();
  /** @type {{ over: PointerTarget | null, pressed: PointerTarget | null }} */
  const pointer = { over: null, pressed: null };

  // ---- images: the session's service, with this view's decodes tracked --------------------------------

  /** @template T @param {Promise<T>} p @returns {Promise<T>} */
  const track = (p) => {
    if (tracked.has(p)) return p;
    tracked.add(p);
    const done = () => {
      tracked.delete(p);
      shapeDirty = true;           // new pixels can change what the shape claims
    };
    p.then(done, done);
    return p;
  };

  /** @type {ImageService} */
  const images = {
    probe: (ref) => s.images.probe(ref),
    get(ref, spec) {
      const before = s.images.pending();
      const planes = s.images.get(ref, spec);
      // A miss starts a load inside the service; joining it gives this view a promise to wait on.
      if (s.images.pending() > before) track(s.images.load(ref, spec));
      return planes;
    },
    load: (ref, spec) => track(s.images.load(ref, spec)),
    raw: (ref) => s.images.raw(ref),
    pending: () => s.images.pending(),
  };

  /** Wait until every decode this view asked for has landed (or failed). */
  const decodesSettled = async () => {
    while (tracked.size) await Promise.allSettled([...tracked]);
  };

  /** Ask for the images a visible element shows, plus its state images. @param {ElementModel} el */
  function preloadElement(el) {
    const roles = IMAGE_ROLES.get(el.kind);
    if (!roles || !shown(el)) return;
    for (const [attr, part] of roles) {
      const ref = el.get(attr);
      if (typeof ref !== 'string' || ref.trim() === '') continue;
      try {
        images.load(ref, keySpecFor(el, part, opts));
      } catch (e) {
        runtimeError('decode', e);
      }
    }
  }

  /** E §3.1 step 7: every visible element's images, before the first shape and the first paint. */
  function preload() {
    for (const el of view.elements) preloadElement(el);
  }

  /**
   * Without a renderer nobody else asks for a new image, so a headless view asks for what a change
   * made visible or swapped in (a script's `el.image = ...`, a subview shown).
   * @param {Map<ElementModel, Set<string>>} dirty
   */
  function preloadChanged(dirty) {
    for (const [el, attrs] of dirty) {
      if (attrs.has('visible')) {
        /** @type {ElementModel[]} */
        const stack = [el];
        while (stack.length) {
          const e = /** @type {ElementModel} */ (stack.pop());
          preloadElement(e);
          stack.push(...e.children);
        }
        continue;
      }
      const roles = IMAGE_ROLES.get(el.kind);
      if (roles && roles.some(([attr]) => attrs.has(attr))) preloadElement(el);
    }
  }

  // ---- the queue ------------------------------------------------------------------------------------

  /** @param {Queued} item */
  const push = (item) => {
    if (pending.length < RUNTIME_CAPS.maxQueued) { pending.push(item); return; }
    if (!queueCapReported) {
      queueCapReported = true;
      report({ code: 'runtime-queue-cap', severity: 'warn', elementId: viewId, detail: `more than ${RUNTIME_CAPS.maxQueued} dispatches waited at once; later ones are dropped` });
    }
  };

  /** Move the model's `_onchange` queue into ours, in its order. */
  const collect = () => {
    for (const { el, event } of view.takeQueuedEvents()) push({ el, event, depth: queueDepth, gesture: currentGesture });
  };

  /** Run one handler site of an element in the realm. @param {ElementModel} el @param {HandlerSite} site @param {{ init?: EventInit | null, gesture?: boolean, params?: Record<string, Wire> }} [o] */
  function runSite(el, site, o = {}) {
    const r = realm;
    const g = graph;
    if (!r || !g || unloaded || disposed) return;
    const init = o.init ?? null;
    g.setEvent(init);
    try {
      r.runHandler(el.handle, site, {
        ...(init ? { event: g.hostGlobals.event } : {}),
        gesture: o.gesture === true,
        ...(o.params ? { params: o.params } : {}),
      });
    } catch (e) {
      runtimeError(`handler ${el.id}.${site.event}`, e);
    } finally {
      g.setEvent(null);
    }
    checkHealth();
  }

  /**
   * Run everything queued, FIFO, each as its own realm entry. What a dispatch queues goes behind it,
   * one level deeper; past the chain cap it is dropped with one diagnostic (D1: it stops two sliders
   * writing each other's value back and forth).
   */
  function drain() {
    if (draining || loading || unloaded || disposed) return;
    draining = true;
    const start = wallClock();
    const budget = num(opts.budgets?.load, 1000);
    let ran = 0;
    try {
      collect();
      while (pending.length && !unloaded && !disposed) {
        if (ran >= RUNTIME_CAPS.maxDrain || !(wallClock() - start <= budget)) {
          reportOnce({ code: 'runtime-drain-cap', severity: 'warn', elementId: viewId,
            detail: `queued dispatches ran over ${budget} ms or ${RUNTIME_CAPS.maxDrain} dispatches; the rest were dropped` }, 'drain-cap');
          pending.length = 0;
          view.takeQueuedEvents();
          break;
        }
        const item = /** @type {Queued} */ (pending.shift());
        if (item.depth > RUNTIME_CAPS.maxChain) {
          reportOnce({ code: 'runtime-chain-cap', severity: 'warn', elementId: item.el.id,
            detail: `${item.event} is ${item.depth} dispatches deep; chains stop at ${RUNTIME_CAPS.maxChain}` }, `chain|${item.el.handle}|${item.event}`);
          continue;
        }
        const site = item.el.handlers.get(item.event);
        if (!site) continue;
        const savedDepth = queueDepth;
        const savedGesture = currentGesture;
        queueDepth = item.depth + 1;
        currentGesture = item.gesture;
        try {
          runSite(item.el, site, { gesture: item.gesture, ...(item.params ? { params: item.params } : {}) });
          collect();
        } finally {
          queueDepth = savedDepth;
          currentGesture = savedGesture;
        }
        ran++;
      }
    } finally {
      draining = false;
    }
  }

  /**
   * One entry from outside the realm (a gesture, a timer, the inspector, a media event). What it
   * queues drains when the outermost entry returns, unless the view is still loading.
   * @template T @param {() => T} fn @param {boolean} [gesture]
   * @returns {T | undefined}
   */
  function enter(fn, gesture = false) {
    const savedDepth = queueDepth;
    const savedGesture = currentGesture;
    entryDepth++;
    queueDepth = 1;
    currentGesture = gesture;
    try {
      return fn();
    } catch (e) {
      runtimeError('entry', e);
      return undefined;
    } finally {
      collect();                   // at this entry's depth and gesture, before they are restored
      queueDepth = savedDepth;
      currentGesture = savedGesture;
      entryDepth--;
      if (entryDepth === 0) afterEntry();
    }
  }

  function afterEntry() {
    checkHealth();
    if (!loading) drain();
    if (loading || unloaded || disposed) return;
    for (const cb of [...dispatchListeners]) {
      try { cb(); } catch (e) { runtimeError('onDispatch', e); }
    }
  }

  // ---- faults ---------------------------------------------------------------------------------------

  function checkHealth() {
    if (unloaded || disposed || !realm) return;
    if (realm.health.unloaded) onUnloaded();
  }

  /** The realm has unloaded the view: freeze it as it is painted and tell the shell, once. */
  function onUnloaded() {
    if (unloaded) return;
    unloaded = true;
    pending.length = 0;
    stopActivity();
    try { graph?.dispose(); } catch (e) { runtimeError('graph dispose', e); }
    if (!faultReported) {
      faultReported = true;
      const why = unloadReason ?? 'the skin stopped';
      const last = lastHardFault ? ` (last: ${lastHardFault})` : '';
      try { host.actions.fault(`${why}${last}`); } catch (e) { runtimeError('fault', e); }
    }
    wakeWaiters();
  }

  /** Stop everything that makes the view move or run skin code. The DOM stays as painted. */
  function stopActivity() {
    stopFrames?.();
    stopFrames = null;
    detachInput?.();
    detachInput = null;
    clearViewTimer();
    for (const t of realmTimers.values()) host.clock.clearTimer(t.clockId);
    realmTimers.clear();
    for (const stop of cleanup.splice(0)) {
      try { stop(); } catch (e) { runtimeError('cleanup', e); }
    }
    try { bindings?.dispose(); } catch (e) { runtimeError('bindings dispose', e); }
    bindings = null;
  }

  function wakeWaiters() {
    for (const w of frameWaiters.splice(0)) w();
  }

  // ---- timers -------------------------------------------------------------------------------------

  /** @type {Map<number, { clockId: number, ms: number, repeat: boolean }>} realm timer id -> host timer */
  const realmTimers = new Map();

  /** @param {number} id @param {number} ms @param {boolean} repeat */
  function armRealmTimer(id, ms, repeat) {
    const old = realmTimers.get(id);
    if (old) host.clock.clearTimer(old.clockId);
    const clockId = host.clock.setTimer(ms, () => {
      const t = realmTimers.get(id);
      if (!t || t.clockId !== clockId || unloaded || disposed) return;
      // An interval re-arms before it runs: the realm never asks again, and a `clearInterval` inside the
      // callback clears the next one.
      if (t.repeat) armRealmTimer(id, t.ms, true);
      else realmTimers.delete(id);
      enter(() => realm?.fireTimer(id));
    });
    realmTimers.set(id, { clockId, ms, repeat });
  }

  /** @type {number | null} */
  let viewTimer = null;
  function clearViewTimer() {
    if (viewTimer !== null) host.clock.clearTimer(viewTimer);
    viewTimer = null;
  }

  /** The VIEW's `ontimer` every `timerInterval` ms (spec 6.2): only when the handler exists, 0 is off. */
  function scheduleViewTimer() {
    clearViewTimer();
    if (loading || unloaded || disposed) return;
    const site = viewEl.handlers.get('ontimer');
    const ms = num(viewEl.get('timerinterval'));
    if (!site || !(ms > 0)) return;
    viewTimer = host.clock.setTimer(ms, () => {
      viewTimer = null;
      if (unloaded || disposed) return;
      const now = viewEl.handlers.get('ontimer');
      if (now) enter(() => runSite(viewEl, now));
      scheduleViewTimer();
    });
  }

  // ---- the realm's host side ------------------------------------------------------------------------

  /** @type {HostDispatcher} */
  const dispatcher = {
    get: (h, key) => graph?.objectOf(h)?.get(key),
    set: (h, key, v) => { graph?.objectOf(h)?.set(key, v, 'script'); },
    call: (h, key, args) => graph?.objectOf(h)?.call(key, args, { gesture: realm?.inGesture ?? false }),
    timer(op, id, ms, repeat) {
      if (op === 'clear') {
        const t = realmTimers.get(id);
        if (t) host.clock.clearTimer(t.clockId);
        realmTimers.delete(id);
        return;
      }
      if (unloaded || disposed) return;
      armRealmTimer(id, ms, repeat);
    },
    now: () => host.clock.now(),
  };

  /** @type {Log} the realm's log: forwarded, with the unload reason and the last hard fault kept for the fault panel */
  const realmLog = {
    info(m, d) {
      const reason = /** @type {{ reason?: unknown } | undefined} */ (d)?.reason;
      if (typeof m === 'string' && m.startsWith('realm: unload') && typeof reason === 'string') unloadReason ??= reason;
      info(m, d);
    },
    warn: (m, d) => warn(m, d),
    diag(d) {
      if (d && d.code === 'realm-hard-fault' && typeof d.detail === 'string') lastHardFault = clip(d.detail, 200);
      report(d);
    },
  };

  // ---- the input sink -------------------------------------------------------------------------------

  const syncPointer = () => {
    try { renderer?.setPointer(pointer.over, pointer.pressed); } catch (e) { runtimeError('setPointer', e); }
  };

  /** @param {PointerTarget | null} t @param {ElementModel} el @param {number | null} part */
  const isTarget = (t, el, part) => t !== null && t.el === el && (t.part ?? null) === part;

  /** The pointer's visual state, which only the gestures know (hover and press images, D28). @param {ElementModel} el @param {string} event @param {EventInit} init @param {number | null} part */
  function trackPointer(el, event, init, part) {
    if (event === 'onmouseover') pointer.over = { el, part };
    else if (event === 'onmouseout') { if (isTarget(pointer.over, el, part)) pointer.over = null; }
    else if (event === 'onmousedown') { if (init.button === 1) pointer.pressed = { el, part }; }
    else if (event === 'onmouseup') pointer.pressed = null;
    else return;
    syncPointer();
  }

  /** D10.2: a click on an EFFECTS element with no `onclick` is the host's (next preset). @param {ElementModel} el */
  function effectsClick(el) {
    try { renderer?.slotOf(el)?.effects?.click(); } catch (e) { runtimeError('effects click', e); }
  }

  /** @type {InputSink} */
  const sink = {
    gesture(el, event, init, part) {
      if (unloaded || disposed) return;
      trackPointer(el, event, init, part);
      const site = el.handlers.get(event);
      if (!site) {
        if (event === 'onclick' && el.kind === 'effects') effectsClick(el);
        return;
      }
      enter(() => runSite(el, site, { init, gesture: true }), true);
    },
    key(event, init) {
      const el = init.srcElement;
      if (!el || unloaded || disposed || !realm) return false;
      const site = el.handlers.get(event);
      if (!site) return false;
      enter(() => runSite(el, site, { init, gesture: true }), true);
      return true;
    },
    dragSlider(el, phase, value) {
      if (unloaded || disposed) return;
      if (phase === 'begin') bindings?.suspend(el, 'value');
      enter(() => {
        el.set('value', value, 'user');
        const site = phase === 'begin' ? el.handlers.get('ondragbegin') : phase === 'end' ? el.handlers.get('ondragend') : undefined;
        if (site) runSite(el, site, { gesture: true });
      }, true);
      // The drag-end handler has written the player by now, so the binding reads what the user chose.
      if (phase === 'end') bindings?.resume(el, 'value');
    },
  };

  /**
   * The window as attachInput sees it: the host's own, except that dropping the capture also ends the
   * press visually. A cancelled press (pointercancel, blur) sends no `onmouseup`, but it always drops
   * the capture it took.
   * @type {SkinWindow}
   */
  const inputWindow = {
    get key() { return win.key; },
    get binding() { return win.binding; },
    get root() { return win.root; },
    get zoom() { return win.zoom; },
    onZoom: (cb) => win.onZoom(cb),
    setZoom: (z) => win.setZoom(z),
    setInitialSize: (w, h) => win.setInitialSize(w, h),
    requestSize: (w, h) => win.requestSize(w, h),
    setShape: (shape) => win.setShape(shape),
    setCapture(on) {
      if (!on && pointer.pressed) {
        pointer.pressed = null;
        syncPointer();
      }
      win.setCapture(on);
    },
    startDrag: () => win.startDrag(),
    show: () => win.show(),
    hide: () => win.hide(),
    minimize: () => win.minimize(),
    close: () => win.close(),
    setAlwaysOnTop: (on) => win.setAlwaysOnTop(on),
    setVisibleOnAllWorkspaces: (on) => win.setVisibleOnAllWorkspaces(on),
    bounds: () => win.bounds(),
    onClose: (cb) => win.onClose(cb),
  };

  /** A slider thumb's length along its axis, from the image probe (G3: attachInput's `deps.thumbExtent`). @param {ElementModel} el */
  function thumbExtent(el) {
    const ref = el.get('enabled') === false ? el.get('thumbdisabledimage') || el.get('thumbimage') : el.get('thumbimage');
    if (typeof ref !== 'string' || ref.trim() === '') return 0;
    const p = images.probe(ref);
    if (!p) return 0;
    return el.get('direction') === 'vertical' ? p.height : p.width;
  }

  // ---- shape ----------------------------------------------------------------------------------------

  /** @param {ElementModel} el @returns {Rect[]} view px, what the element's host slot claims */
  const slotRects = (el) => {
    const handle = renderer?.slotOf(el);
    if (!handle) return [];
    try {
      return handle.hitRects();
    } catch (e) {
      runtimeError('slot hitRects', e);
      return [];
    }
  };

  /** @returns {MaskShape} */
  function computeShape() {
    const { shape, diagnostics: found } = rasterizeShapeWithDiagnostics(view, images, slotRects, opts, { size: frameSize });
    for (const d of found) reportOnce(d, `shape|${d.code}`);
    return shape;
  }

  /** Rasterise if something shape-relevant changed, and send only when the bits differ. */
  function updateShape() {
    if (headless || !shapeDirty || disposed) return;
    shapeDirty = false;
    let shape;
    try {
      shape = computeShape();
    } catch (e) {
      runtimeError('shape', e);
      return;
    }
    if (sameShape(lastShape, shape)) return;
    lastShape = shape;
    try { win.setShape(shape); } catch (e) { runtimeError('setShape', e); }
  }

  /** Paint what changed since the last frame and refresh the shape. @param {number} now */
  function paint(now) {
    const dirty = view.takeDirty();
    if (renderer) {
      try { renderer.frame(dirty, now); } catch (e) { runtimeError('renderer', e); }
    } else if (dirty.size) {
      preloadChanged(dirty);
    }
    if (!shapeDirty) {
      outer: for (const attrs of dirty.values()) {
        for (const a of attrs) {
          if (!SHAPE_NEUTRAL.has(a)) { shapeDirty = true; break outer; }
        }
      }
    }
    updateShape();
  }

  // ---- the frame ------------------------------------------------------------------------------------

  /** @param {number} now */
  function frame(now) {
    if (unloaded || disposed) return;
    try { animator.frame(now); } catch (e) { runtimeError('animator', e); }
    try { bindings?.frame(now); } catch (e) { runtimeError('bindings', e); }
    drain();
    if (!unloaded && !disposed) paint(now);
    wakeWaiters();
  }

  /** @returns {Promise<void>} */
  const nextFrame = () => new Promise((resolve) => { frameWaiters.push(resolve); });

  // ---- PLAYER events --------------------------------------------------------------------------------

  /**
   * A PLAYER element's handler for a media event, under its bare name or with `on` (elements.js keeps
   * the markup's spelling). @param {ElementModel} el @param {string} name
   */
  const playerSite = (el, name) => {
    const key = lower(name);
    return el.handlers.has(key) ? key : el.handlers.has(`on${key}`) ? `on${key}` : null;
  };

  /** Raise PLAYER events from media changes (spec 6.19; parameter names from the attribute table). */
  function watchPlayer() {
    const players = view.elements.filter((el) => el.kind === 'player' && PLAYER_RAISED.some((n) => playerSite(el, n) !== null));
    const g = graph;
    if (!players.length || !g) return;
    const p = g.globals.player;
    /** @param {string} member */
    const read = (member) => { const v = p.get(member); return /** @type {Wire} */ (v !== null && typeof v === 'object' ? undefined : v); };
    const snapshot = () => {
      const m = host.media.snapshot();
      return {
        open: read('openstate'), play: read('playstate'), status: read('status'),
        song: m.song ? `${m.song.id}\u0000${m.song.file}` : '', loop: !!m.repeat, shuffle: !!m.random,
      };
    };
    let last = snapshot();
    cleanup.push(host.media.subscribe(() => {
      if (unloaded || disposed) return;
      const next = snapshot();
      /** @type {Array<[string, Record<string, Wire>]>} */
      const raise = [];
      if (next.open !== last.open) raise.push(['OpenStateChange', { NewState: next.open }]);
      if (next.play !== last.play) raise.push(['PlayStateChange', { NewState: next.play }]);
      if (next.song !== last.song) raise.push(['CurrentItemChange', {}], ['MediaChange', {}]);
      if (next.loop !== last.loop) raise.push(['ModeChange', { ModeName: 'loop', NewValue: next.loop }]);
      if (next.shuffle !== last.shuffle) raise.push(['ModeChange', { ModeName: 'shuffle', NewValue: next.shuffle }]);
      if (next.status !== last.status) raise.push(['StatusChange', {}]);
      last = next;
      if (!raise.length) return;
      for (const el of players) {
        for (const [name, values] of raise) {
          const event = playerSite(el, name);
          if (!event) continue;
          const names = PLAYER_EVENTS.get(lower(name))?.params ?? [];
          /** @type {Record<string, Wire>} */
          const params = {};
          for (const n of names) params[n] = values[n];
          push({ el, event, depth: 1, gesture: false, params });
        }
      }
      // From inside a script entry (a fake player that answers synchronously) the entry drains it.
      if (entryDepth === 0) drain();
    }));
  }

  // ---- the load sequence ------------------------------------------------------------------------------

  /**
   * The EFFECTS control exists only once the renderer has mounted its slot, after the bindings
   * installed (E §3.1 steps 6 and 8), and the object graph links to it without announcing the link. A
   * binding that reads through an EFFECTS element (`wmpprop:visEffects.currentPresetTitle`) is read
   * once more here, through the bindings' own hold-and-release, so it shows the control's value from
   * the first frame instead of after the first preset change.
   */
  function refreshSlotBindings() {
    const b = bindings;
    if (!b) return;
    for (const el of view.elements) {
      for (const spec of attrSpecsOf(el.kind)) {
        const src = el.source(spec.name);
        if (!src || src.kind !== 'wmpprop') continue;
        if (view.byId(src.path.root)?.kind !== 'effects') continue;
        try {
          b.suspend(el, spec.name);
          b.resume(el, spec.name);
        } catch (e) {
          runtimeError('bindings refresh', e);
        }
      }
    }
  }

  /** Write the sidecar's attributes (D10.6): `attrs` always, `compat.attrs` under `oracle-compat` only. */
  function applySidecar() {
    if (!sidecar) return;
    /** @type {unknown[]} */
    const entries = [];
    if (Array.isArray(sidecar.attrs)) entries.push(...sidecar.attrs);
    if (opts.config === 'oracle-compat' && sidecar.compat && Array.isArray(sidecar.compat.attrs)) entries.push(...sidecar.compat.attrs);
    for (const raw of entries.slice(0, 1024)) {
      const entry = /** @type {{ ref?: unknown, name?: unknown, value?: unknown } | null} */ (raw);
      if (!entry || typeof entry !== 'object' || typeof entry.ref !== 'string' || typeof entry.name !== 'string') {
        reportOnce({ code: 'sidecar-invalid', severity: 'warn', detail: 'a sidecar attribute entry has no ref or name; it is skipped' }, 'sidecar-invalid');
        continue;
      }
      const { ref, name, value } = entry;
      const el = view.byId(ref);
      if (!el) {
        report({ code: 'sidecar-ref-missing', severity: 'warn', detail: `sidecar attribute "${clip(name, 60)}": no element "${clip(ref, 60)}" in view "${clip(viewId, 60)}"` });
        continue;
      }
      if (!attrSpecFor(el.kind, name, 'sidecar')) {
        report({ code: 'sidecar-attr-unknown', severity: 'warn', elementId: el.id, detail: `sidecar attribute "${clip(name, 60)}" is not an attribute of a ${el.kind}` });
        continue;
      }
      if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        report({ code: 'sidecar-invalid', severity: 'warn', elementId: el.id, detail: `sidecar attribute "${clip(name, 60)}" has a value that is not a string, number, boolean or null` });
        continue;
      }
      el.set(name, value, 'sidecar');
    }
  }

  const animator = createAnimator(host.clock, (el, event) => {
    // After every write of the frame (animator.js); the frame drains it before painting.
    if (el.handlers.has(event)) push({ el, event, depth: 1, gesture: false });
  });

  /** Undo whatever the sequence built, for a load that failed part-way. */
  function abandon() {
    disposed = true;
    stopActivity();
    try { renderer?.dispose(); } catch { /* best effort */ }
    try { graph?.dispose(); } catch { /* best effort */ }
    try { realm?.unload('attach failed'); } catch { /* best effort */ }
    wakeWaiters();
  }

  try {
    const [prefs, mediacenterPrefs] = await Promise.all([host.prefs.load(vfs.sha), host.prefs.load('mediacenter')]);

    graph = createObjectGraph({
      host, view, theme, skinSha: vfs.sha, prefs, ledger, opts,
      animate: { moveTo: animator.moveTo, alphaBlendTo: animator.alphaBlendTo, cancel: animator.cancel },
      effectsOf: (el) => renderer?.slotOf(el)?.effects ?? null,
      inGesture: () => realm?.inGesture ?? false,
      queueEvent(el, event) {
        // The model's own queue first: a value change queued before the click runs before it.
        collect();
        push({ el, event: lower(event), depth: queueDepth, gesture: currentGesture });
      },
      mediacenterPrefs,
    });
    await graph.ready;

    // G2: a script's `view.width`/`view.height` goes to the window, which phase 1 refuses (D7.3).
    cleanup.push(view.onChange((el, attr, _v, origin) => {
      if (el === viewEl && origin === 'script' && (attr === 'width' || attr === 'height')) requestFrameSize();
    }));

    step('prelude');
    realm = await createRealm({
      viewKey: `${vfs.sha.slice(0, 12)}/${viewId}`,
      memoryLimitBytes: MEMORY_LIMIT_BYTES,
      maxStackBytes: MAX_STACK_BYTES,
      budgets: opts.budgets,
      wallClock,
      dispatcher,
      classMembers: CLASS_MEMBERS,
      hostGlobals: graph.hostGlobals,
      log: realmLog,
      ...(typeof opts.testSeed === 'string' ? { testSeed: opts.testSeed } : {}),
    });

    step('ids');
    realm.setIds(view.elements
      .filter((el) => view.byId(el.id) === el)
      .map((el) => ({ id: el.id, handle: el.handle, className: elementClassName(el.kind) })));

    step('scripts');
    for (const name of theme.scriptsFor(viewId)) {
      if (unloaded) break;
      const source = scriptSource(vfs, name);
      if (source !== null) enter(() => realm?.loadScript(name, source));
    }

    step('jscript:');
    if (!unloaded) {
      for (const d of enter(() => evaluateLayout(view, /** @type {Realm} */ (realm), { passBudgetMs: num(opts.budgets?.exprPass, 1000) })) ?? []) report(d);
    }
    step('anchors');
    recordAnchors(view);
    step('sidecar');
    applySidecar();

    step('bindings');
    if (!unloaded) {
      bindings = createBindings(view, graph, host.clock, { realmTickHz: opts.realmTickHz, ledger });
      bindings.install();
    }

    step('decode');
    preload();
    await decodesSettled();

    step('render');
    frameSize = { width: Math.max(0, Math.round(num(viewEl.get('width')))), height: Math.max(0, Math.round(num(viewEl.get('height')))) };
    if (win) await win.setInitialSize(frameSize.width, frameSize.height);
    if (!headless) {
      const r = /** @type {any} */ (createRenderer(win.root, images, host.slots, win, opts, { clock: host.clock, log: { info, warn, diag: report } }));
      renderer = r;
      r.mount(view);
      for (const el of view.elements) {
        if (!SLOT_KINDS.has(el.kind)) continue;
        const slot = r.slotOf(el);
        if (slot) cleanup.push(slot.onHitRectsChange(() => { shapeDirty = true; }));
      }
      refreshSlotBindings();
      await decodesSettled();
    }

    step('shape');
    shapeDirty = true;
    updateShape();

    step('onload');
    const onload = viewEl.handlers.get('onload');
    if (onload && !unloaded) enter(() => runSite(viewEl, onload));
    loading = false;

    step('queue drain');
    enter(() => {});

    step('first frame');
    if (!unloaded) {
      await decodesSettled();
      paint(host.clock.now());
    }

    step('show');
    if (win && !unloaded) await win.show();

    if (!unloaded && !disposed) {
      if (renderer?.plane) {
        detachInput = attachInput(renderer.plane, view, (x, y) => pick(view, images, slotRects, x, y, opts), inputWindow, sink, opts, { thumbExtent });
      }
      cleanup.push(view.onChange((el, attr) => {
        if (el === viewEl && (attr === 'timerinterval' || attr === 'ontimer')) scheduleViewTimer();
      }));
      scheduleViewTimer();
      watchPlayer();
      stopFrames = host.clock.onFrame(frame);
    }
  } catch (e) {
    abandon();
    throw e;
  }

  /** Forward the model's VIEW size to the window (G2); a size the window accepts becomes the frame. */
  function requestFrameSize() {
    const w = Math.max(0, Math.round(num(viewEl.get('width'))));
    const h = Math.max(0, Math.round(num(viewEl.get('height'))));
    let asked;
    try {
      asked = win?.requestSize(w, h);
    } catch (e) {
      runtimeError('requestSize', e);
      return;
    }
    Promise.resolve(asked).then((ok) => {
      if (ok === true && !disposed && !unloaded) {
        frameSize = { width: w, height: h };
        shapeDirty = true;
      }
    }, (e) => runtimeError('requestSize', e));
  }

  // ---- the runtime ----------------------------------------------------------------------------------

  const inspector = createInspector({
    view,
    images,
    opts,
    root: () => /** @type {HTMLElement} */ (renderer?.nodeOf(viewEl) ?? win?.root ?? null),
    objectOf: (el) => {
      try { return graph && !unloaded ? graph.elementObject(el) : null; } catch { return null; }
    },
    callGlobal(name, args) {
      if (!realm || unloaded || disposed) return undefined;
      const r = /** @type {Realm} */ (realm);
      const out = enter(() => r.callGlobal(name, args));
      return out && out.ok === true ? out.value : undefined;
    },
    readGlobal(name) {
      if (!realm || unloaded || disposed) return undefined;
      try { return realm.readGlobal(name); } catch (e) { runtimeError('readGlobal', e); return undefined; }
    },
    write(fn) {
      if (unloaded || disposed) return;
      enter(fn);
    },
  });

  /** @type {AttachedView} */
  const runtime = {
    viewId,
    inspector,
    get realmHealth() {
      return realm ? realm.health : { soft: 0, hard: 0, unloaded: true, dutyThrottled: false };
    },
    get health() {
      const h = realm?.health;
      return { soft: h?.soft ?? 0, hard: h?.hard ?? 0, unloaded: (h?.unloaded ?? true) || unloaded };
    },
    maskShape() {
      if (lastShape) return lastShape;
      return computeShape();
    },
    async settled() {
      for (let round = 0; round < RUNTIME_CAPS.maxSettleRounds; round++) {
        if (unloaded || disposed) return;
        if (tracked.size) { await decodesSettled(); continue; }
        collect();
        if (pending.length) { drain(); continue; }
        if (animator.running() > 0) { await nextFrame(); continue; }
        // Quiet: paint what the decodes and drains changed, since no frame may come (a manual clock).
        paint(host.clock.now());
        collect();
        if (!tracked.size && !pending.length) return;
      }
      warn('engine: settled() gave up on a view that kept itself busy', { view: viewId });
    },
    dispose() {
      if (disposed) return;
      // `onclose` runs while the view is still whole (Headspace saves its preset there).
      const onclose = viewEl.handlers.get('onclose');
      if (onclose && realm && !unloaded) {
        loading = true;            // nothing it queues runs: the view is going away
        enter(() => runSite(viewEl, onclose));
      }
      disposed = true;
      pending.length = 0;
      stopActivity();
      try { renderer?.dispose(); } catch (e) { runtimeError('renderer dispose', e); }
      renderer = null;
      try { graph?.dispose(); } catch (e) { runtimeError('graph dispose', e); }
      try { realm?.unload('view disposed'); } catch (e) { runtimeError('realm unload', e); }
      dispatchListeners.clear();
      wakeWaiters();
    },
    onDispatch(cb) {
      dispatchListeners.add(cb);
      return () => { dispatchListeners.delete(cb); };
    },
    diagnostics: () => [...diagnostics],
  };
  return runtime;
}
