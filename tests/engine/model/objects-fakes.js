// @ts-check
// Fakes for the object-model tests (W2.3). The object graph is built against the contracts, so these
// stand in for what is not built yet: an `ElementModel` and `ViewModel` (W2.1) and the pieces of a
// `HostAdapter` the graph touches. The media, DSP, preference and clock fakes are W1.10's, unchanged.
//
// The fake element is deliberately faithful where the graph depends on it: it types and coerces
// through the real attribute tables (`attrSpecFor`, `coerce`), refuses writes to read-only
// attributes unless the origin is 'init', reports a change only when the value changed, and queues
// `<attr>_onchange` for every origin but 'init'. Nothing else about the model is simulated.

import { attrSpec, attrSpecFor } from '../../../src/engine/wms/attrs.js';
import { coerce } from '../../../src/engine/wms/values.js';
import { createObjectGraph } from '../../../src/engine/model/objects/index.js';
import { createLedger } from '../../../src/engine/model/ledger.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import { createFakeDsp } from '../../../src/hosts/test/dsp.js';
import { createFakeMedia } from '../../../src/hosts/test/media.js';
import { createMemoryPrefs } from '../../../src/hosts/test/prefs.js';

/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../../src/engine/contracts').ElementKind} ElementKind */
/** @typedef {import('../../../src/engine/contracts').Wire} Wire */
/** @typedef {import('../../../src/engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../../../src/engine/contracts').ObjectGraph} Graph */

// ---- elements and the view ------------------------------------------------------------------------

/**
 * @typedef {{ kind: ElementKind, id: string, attrs?: Record<string, unknown>, parent?: string, handle?: number }} ElementDef
 */

/**
 * A view of fake elements. The first definition is the VIEW. `changes` records every model change.
 * @param {ElementDef[]} defs
 * @param {{ firstHandle?: number }} [opts]
 */
export function buildView(defs, opts = {}) {
  /** @type {Array<{ el: ElementModel, attr: string, value: unknown, origin: string }>} */
  const changes = [];
  /** @type {Array<{ el: ElementModel, event: string }>} */
  const queued = [];
  /** @type {Set<(el: ElementModel, attr: string, v: any, origin: any) => void>} */
  const listeners = new Set();
  /** @type {ElementModel[]} */
  const elements = [];
  /** @type {Map<string, ElementModel>} */
  const byId = new Map();
  let nextHandle = opts.firstHandle ?? 1;

  for (const def of defs) {
    /** @type {Map<string, unknown>} */
    const values = new Map();
    /** @type {ElementModel[]} */
    const children = [];
    const parent = def.parent ? byId.get(def.parent) ?? null : elements[0] ?? null;
    /** @type {ElementModel} */
    const el = {
      handle: def.handle ?? nextHandle++,
      kind: def.kind,
      tag: def.kind,
      id: def.id,
      parent: elements.length === 0 ? null : parent,
      children,
      docIndex: elements.length,
      handlers: new Map(),
      get(attr) {
        const key = String(attr).toLowerCase();
        if (key === 'id') return def.id;
        if (values.has(key)) return /** @type {any} */ (values.get(key));
        const spec = attrSpec(def.kind, key);
        return /** @type {any} */ (spec ? spec.default : null);
      },
      set(attr, v, origin) {
        const spec = attrSpecFor(def.kind, attr, origin);
        if (!spec) return false;
        if (spec.access === 'r' && origin !== 'init') return false;
        const prev = el.get(attr);
        const next = /** @type {any} */ (coerce(spec.type, v, prev));
        if (Object.is(next, prev)) return false;
        values.set(String(attr).toLowerCase(), next);
        changes.push({ el, attr: spec.name, value: next, origin });
        if (origin !== 'init') queued.push({ el, event: `${spec.name}_onchange` });
        for (const cb of [...listeners]) cb(el, spec.name, next, origin);
        return true;
      },
      source: () => undefined,
    };
    for (const [attr, v] of Object.entries(def.attrs ?? {})) el.set(attr, v, 'init');
    changes.length = 0;
    queued.length = 0;
    if (elements.length > 0 && parent) /** @type {ElementModel[]} */ (/** @type {any} */ (parent.children)).push(el);
    elements.push(el);
    byId.set(def.id, el);
  }

  /** @type {ViewModel} */
  const view = {
    view: elements[0],
    elements,
    byHandle: (h) => elements.find((e) => e.handle === h),
    byId: (id) => byId.get(id) ?? [...byId].find(([k]) => k.toLowerCase() === String(id).toLowerCase())?.[1],
    paintOrder: () => [],
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    takeDirty: () => new Map(),
    takeQueuedEvents: () => queued.splice(0),
  };
  return { view, elements, byId, changes, queued };
}

/** The ids of the Headspace skin that the parity contract names (parity 3.7), as fake elements. @returns {ElementDef[]} */
export function headspaceLike() {
  return [
    { kind: 'view', id: 'view1', attrs: { width: 549, height: 394 } },
    { kind: 'subview', id: 'sEqEar', attrs: { left: 207, top: 0, width: 260, height: 394 } },
    { kind: 'button', id: 'bEqHandle', attrs: { left: 8, top: 66, upToolTip: 'Open', image: 'a.bmp' }, parent: 'sEqEar' },
    { kind: 'text', id: 'xEqTt', attrs: { value: 'Open graphic equalizer controls' }, parent: 'sEqEar' },
    { kind: 'effects', id: 'visEffects', attrs: { left: 0, top: 0, width: 216, height: 158 } },
    { kind: 'video', id: 'vid', attrs: { visible: false } },
    { kind: 'playlist', id: 'pl', attrs: { visible: false, backgroundColor: '#285F03' } },
    { kind: 'equalizersettings', id: 'eq' },
    { kind: 'videosettings', id: 'vidset' },
    { kind: 'slider', id: 'volume', attrs: { min: 0, max: 100, value: 50, tooltip: 'Volume' } },
    { kind: 'slider', id: 'balance', attrs: { min: -100, max: 100, value: 0 } },
    { kind: 'slider', id: 'eq1', attrs: { min: -14, max: 14, value: 0 } },
    { kind: 'buttongroup', id: 'playGroup', attrs: { left: 0, top: 0, width: 80, height: 20 } },
    { kind: 'buttonelement', id: 'bPlay', attrs: { mappingColor: '#FFFF00' }, parent: 'playGroup' },
    { kind: 'buttonelement', id: 'bStop', attrs: { mappingColor: '#00FF00' }, parent: 'playGroup' },
  ];
}

// ---- the host -------------------------------------------------------------------------------------

/**
 * A control for an EFFECTS element, as the VizHost slot provides it.
 * @param {{ count?: number, index?: number, titles?: string[] }} [opts]
 * @returns {EffectsControl & { readonly steps: number[], readonly sets: number[], fire(): void }}
 */
export function fakeEffects(opts = {}) {
  const titles = opts.titles ?? ['Chorus', 'Opus', 'Ring', 'Cloud', 'Warp'];
  const count = opts.count ?? titles.length;
  let index = opts.index ?? 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {number[]} */
  const steps = [];
  /** @type {number[]} */
  const sets = [];
  const fire = () => { for (const cb of [...listeners]) cb(); };
  return {
    count,
    get index() { return index; },
    get title() { return titles[index] ?? ''; },
    titleOf: (i) => titles[i] ?? '',
    setIndex(i) { sets.push(i); index = i; fire(); },
    step(d) { steps.push(d); index = (index + d + count) % count; fire(); },
    click() {},
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    steps,
    sets,
    fire,
  };
}

/**
 * The graph of a fake skin over W1.10's fakes.
 * @param {{
 *   preset?: string,
 *   elements?: ElementDef[],
 *   skinSha?: string,
 *   dsp?: import('../../../src/engine/contracts').DspPort,
 *   prefs?: Record<string, string>,
 *   mediacenter?: Record<string, string>,
 *   mediacenterMap?: Map<string, string>,
 *   failLoad?: boolean,
 *   gesture?: boolean,
 *   queue?: boolean,
 *   options?: Partial<import('../../../src/engine/contracts').EngineOptions>,
 *   theme?: Partial<import('../../../src/engine/contracts').ThemeModel['meta']>,
 * }} [opts] `mediacenter` seeds the host's `mediacenter` namespace (loaded asynchronously);
 *   `mediacenterMap` passes the loaded map in directly; `queue` supplies the runtime's `queueEvent`
 *   (script `click()` then lands in `queuedEvents`; without it the graph has no queue)
 */
export function makeGraph(opts = {}) {
  const sha = opts.skinSha ?? 'a'.repeat(64);
  const clock = createManualClock();
  const media = createFakeMedia(opts.preset ?? 'stoppedQueue5', { clock });
  const dsp = /** @type {ReturnType<typeof createFakeDsp>} */ (opts.dsp ?? createFakeDsp());
  const store = createMemoryPrefs();
  if (opts.mediacenter) store.seed('mediacenter', opts.mediacenter);
  if (opts.failLoad) store.load = () => Promise.reject(new Error('disk gone'));
  const model = buildView(opts.elements ?? headspaceLike());
  const ledger = createLedger(sha);
  const skinPrefs = new Map(Object.entries(opts.prefs ?? {}));

  /** @type {{ run: Array<[string, { viewId: string }]>, denied: Array<[string, string]>, fault: string[] }} */
  const actionLog = { run: [], denied: [], fault: [] };
  const logs = { info: /** @type {string[]} */ ([]), warn: /** @type {string[]} */ ([]) };
  const state = { gesture: opts.gesture ?? false };
  /** @type {Array<[string, ...unknown[]]>} */
  const animCalls = [];
  /** @type {Map<ElementModel, EffectsControl>} */
  const controls = new Map();
  /** What the runtime's event queue received from script, in order: `[element id, event]`. @type {Array<[string, string]>} */
  const queuedEvents = [];

  const host = /** @type {any} */ ({
    kind: 'test',
    clock,
    prefs: store,
    media,
    dsp,
    actions: {
      run: (/** @type {string} */ a, /** @type {{ viewId: string }} */ ctx) => { actionLog.run.push([a, ctx]); },
      denied: (/** @type {string} */ api, /** @type {string} */ detail) => { actionLog.denied.push([api, detail]); },
      fault: (/** @type {string} */ r) => { actionLog.fault.push(r); },
    },
    log: {
      info: (/** @type {string} */ m) => { logs.info.push(m); },
      warn: (/** @type {string} */ m) => { logs.warn.push(m); },
      diag: () => {},
    },
  });

  const theme = {
    views: [model.view],
    meta: { author: 'An Author', title: 'A Title', copyright: '(c) Someone', currentViewID: null, ...opts.theme },
    scriptsFor: () => [],
    diagnostics: [],
  };

  const graph = /** @type {Graph} */ (createObjectGraph(/** @type {any} */ ({
    host,
    view: model.view,
    theme,
    skinSha: sha,
    prefs: skinPrefs,
    ledger,
    opts: { ...FAITHFUL, ...opts.options },
    animate: {
      moveTo: (/** @type {any[]} */ ...a) => { animCalls.push(['moveTo', ...a]); },
      alphaBlendTo: (/** @type {any[]} */ ...a) => { animCalls.push(['alphaBlendTo', ...a]); },
      cancel: (/** @type {any[]} */ ...a) => { animCalls.push(['cancel', ...a]); },
    },
    effectsOf: (/** @type {ElementModel} */ el) => controls.get(el) ?? null,
    inGesture: () => state.gesture,
    queueEvent: opts.queue ? (/** @type {ElementModel} */ target, /** @type {string} */ event) => { queuedEvents.push([target.id, event]); } : undefined,
    mediacenterPrefs: opts.mediacenterMap,
  })));

  /** @param {string} id @returns {ElementModel} */
  const el = (id) => /** @type {ElementModel} */ (model.byId.get(id));

  // ---- a script's view of the graph: the same steps the realm's dispatcher takes -----------------

  /**
   * Follow a dotted path of property reads to an object (or a value at the end).
   * @param {string} path `player.controls.currentPosition`, any case; a root is a global or an element id
   * @returns {Wire | { method: true }}
   */
  function read(path) {
    const parts = path.split('.');
    const rootName = parts[0];
    const g = /** @type {any} */ (graph.globals)[Object.keys(graph.globals).find((k) => k.toLowerCase() === rootName.toLowerCase()) ?? ''];
    let obj = g ?? (model.view.byId(rootName) ? graph.elementObject(/** @type {ElementModel} */ (model.view.byId(rootName))) : null);
    /** @type {any} */
    let v = obj ? { __h: obj.handle } : undefined;
    for (const part of parts.slice(1)) {
      obj = v && typeof v === 'object' && '__h' in v ? graph.objectOf(v.__h) : null;
      if (!obj) return undefined;
      v = obj.get(part.toLowerCase());
    }
    return v;
  }

  /** The object a path names. @param {string} path @returns {import('../../../src/engine/contracts').HostObject} */
  function obj(path) {
    const v = /** @type {any} */ (read(path));
    const o = v && typeof v === 'object' && '__h' in v ? graph.objectOf(v.__h) : null;
    if (!o) throw new Error(`${path} is not an object`);
    return o;
  }

  /** Call `a.b.method(args)`. @param {string} path @param {Wire[]} [args] @param {{ gesture?: boolean }} [ctx] */
  function call(path, args = [], ctx = {}) {
    const i = path.lastIndexOf('.');
    return obj(path.slice(0, i)).call(path.slice(i + 1).toLowerCase(), args, { gesture: ctx.gesture ?? state.gesture });
  }

  /** Assign `a.b.member = v` as script. @param {string} path @param {Wire} v */
  function write(path, v) {
    const i = path.lastIndexOf('.');
    obj(path.slice(0, i)).set(path.slice(i + 1).toLowerCase(), v, 'script');
  }

  return {
    graph, host, clock, media, dsp, store, ledger, model, theme, el, skinPrefs, actionLog, logs, state, animCalls, controls, queuedEvents,
    read, obj, call, write,
    /** The ledger as `api kind` -> count, for compact assertions. @returns {Record<string, number>} */
    counts() { return Object.fromEntries(ledger.entries().map((e) => [`${e.api} ${e.kind}`, e.count])); },
    /** Let the media settle past the debounce and the hold. @param {number} [ms] */
    settle(ms = 1000) { clock.advance(ms); },
  };
}
