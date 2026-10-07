// @ts-check
// `createObjectGraph` (E §5.5, D6): the host side of everything a skin script can reach. It builds
// the six global objects (`player`, `theme`, `view`, `event`, `mediacenter`, `playerApplication`), the
// objects under `player`, one object per element on demand, and the change sources the binding engine
// listens to. All of it reads the one schema (../schema.js) and the one set of policies
// (../policy.js), and records what it denies, stubs or does not know in the ledger.
//
// Handles. A `HostObject.get` that returns an object returns a `{ __h }` handle, and the graph
// numbers them: an element object has its element's handle, every other object (the globals,
// `player.controls`, a playlist item, ...) gets a number above every element handle, and
// `objectOf(handle)` maps any of them back. The runtime builds the realm's `HostDispatcher` on that,
// and `hostGlobals` is ready for `RealmOptions.hostGlobals`.
//
// No synchronous re-entry: nothing here runs skin code. A write that changes an attribute goes
// through `ElementModel.set`, whose model queues the `<attr>_onchange` handler; the graph only
// forwards model and media changes to the listeners of `changeSource`.

import { createPolicies } from '../policy.js';
import { createElementObject } from './element.js';
import { createHub, makeObject } from './core.js';
import { createMediacenterObject } from './mediacenter.js';
import { createPlayerObjects } from './player.js';
import { createSources } from './sources.js';
import { createEventObject, createThemeObject, createViewObject } from './theme.js';

/** @typedef {import('../../contracts').ObjectGraph} ObjectGraph */
/** @typedef {import('../../contracts').CreateObjectGraphFn} CreateObjectGraphFn */
/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').EventInit} EventInit */
/** @typedef {import('../../contracts').MediaState} MediaState */
/** @typedef {import('./core.js').GraphObject} GraphObject */
/** @typedef {keyof ObjectGraph['globals']} GlobalName */

/**
 * The shared environment of the object files: the contract's dependencies (including `queueEvent`
 * and `mediacenterPrefs`), the policies, the change hub, and the bookkeeping `makeObject` needs. Not
 * exported beyond `src/engine/model`.
 * @typedef {Parameters<CreateObjectGraphFn>[0] & import('./core.js').ObjectContext & {
 *   readonly policy: import('../policy.js').Policies,
 *   readonly hub: ReturnType<typeof createHub>,
 *   currentEvent: EventInit | null,
 *   cleanup: Array<() => void>,
 *   mediaHooks: Array<(changed: ReadonlySet<keyof MediaState>) => void>,
 *   ref(obj: GraphObject): { __h: number },
 *   elementRef(el: ElementModel): { __h: number },
 *   objectOf(handle: number): GraphObject | null,
 *   watchEffects(el: ElementModel): void,
 * }} Env
 */

/**
 * Which keys of `MediaState` each `media.*` change source follows (the vocabulary in ../schema.js).
 * @type {ReadonlyArray<readonly [string, readonly (keyof MediaState)[]]>}
 */
const MEDIA_CHANNELS = [
  ['media.state', ['connected', 'playState', 'song', 'queueLength', 'error']],
  ['media.position', ['elapsed', 'playState', 'song', 'duration']],
  ['media.duration', ['duration', 'song']],
  ['media.song', ['song']],
  ['media.volume', ['volume']],
  ['media.mode', ['repeat', 'random']],
  ['media.queue', ['queueLength', 'queueVersion']],
  ['media.bitrate', ['bitrateKbps']],
  ['media.avail', ['connected', 'playState', 'song', 'duration', 'queueLength']],
];

/** @type {CreateObjectGraphFn} */
export function createObjectGraph(deps) {
  const { host, view, theme } = deps;

  const policy = createPolicies({ clock: host.clock, ledger: deps.ledger, actions: host.actions, inGesture: deps.inGesture, log: host.log });
  const hub = createHub((m) => host.log.warn(m));

  // ---- handles ------------------------------------------------------------------------------------

  /** Above every element handle of the session, so a graph handle never names an element. */
  let nextHandle = 1;
  for (const v of [view, ...theme.views]) {
    nextHandle = Math.max(nextHandle, v.view.handle + 1, ...v.elements.map((e) => e.handle + 1));
  }
  /** @type {Map<number, GraphObject>} */
  const objects = new Map();
  /** @type {Map<ElementModel, GraphObject>} */
  const elementObjects = new Map();

  /** @type {Env} */
  const env = /** @type {any} */ ({
    ...deps,
    policy,
    hub,
    disposed: false,
    currentEvent: null,
    cleanup: [],
    mediaHooks: [],
    register(/** @type {GraphObject} */ obj, /** @type {number | undefined} */ handle) {
      obj.handle = handle ?? nextHandle++;
      objects.set(obj.handle, obj);
    },
    ref: (/** @type {GraphObject} */ obj) => ({ __h: obj.handle }),
    elementRef: (/** @type {ElementModel} */ el) => env.ref(elementObject(el)),
    objectOf: (/** @type {number} */ handle) => objectOf(handle),
    inert: () => env.ref(inert),
    watchEffects,
  });

  // ---- one inert object, then the globals ----------------------------------------------------------

  const inert = makeObject(env, 'inert');
  const { player, playerApplication } = createPlayerObjects(env);
  const themeObject = createThemeObject(env);
  const viewObject = createViewObject(env);
  const eventObject = createEventObject(env);
  const mediacenter = createMediacenterObject(env);

  /** @type {Readonly<Record<GlobalName, GraphObject>>} the contract's `HostObject`s, with the handle this graph numbered */
  const globals = {
    player, theme: themeObject, view: viewObject, event: eventObject, mediacenter: mediacenter.object, playerApplication,
  };
  /** @type {ReadonlyMap<string, GraphObject>} the six globals by lowercased name; roots resolve here first (D5) */
  const globalsByName = new Map(Object.entries(globals).map(([name, obj]) => [name.toLowerCase(), obj]));

  // ---- elements ------------------------------------------------------------------------------------

  /** @param {ElementModel} el @returns {GraphObject} */
  function elementObject(el) {
    if (el === view.view) return globals.view;
    let obj = elementObjects.get(el);
    if (!obj) {
      obj = createElementObject(env, el);
      elementObjects.set(el, obj);
    }
    return obj;
  }

  /** @param {number} handle @returns {GraphObject | null} */
  function objectOf(handle) {
    const known = objects.get(handle);
    if (known) return known;
    const el = view.byHandle(handle) ?? theme.views.map((v) => v.byHandle(handle)).find((e) => e !== undefined);
    return el ? elementObject(el) : null;
  }

  // ---- change sources ------------------------------------------------------------------------------

  env.cleanup.push(host.media.subscribe((changed) => {
    for (const hook of env.mediaHooks) hook(changed);
    for (const [channel, keys] of MEDIA_CHANNELS) if (keys.some((k) => changed.has(k))) hub.emit(channel);
  }));
  env.cleanup.push(host.dsp.eq.onChange(() => hub.emit('dsp.eq')));
  env.cleanup.push(host.dsp.balance.onChange(() => hub.emit('dsp.balance')));
  env.cleanup.push(view.onChange((el, attr) => hub.emit(`el:${el.handle}:${attr.toLowerCase()}`)));
  for (const v of theme.views) if (v !== view) env.cleanup.push(v.onChange((el, attr) => hub.emit(`el:${el.handle}:${attr.toLowerCase()}`)));

  /** @type {Map<number, () => void>} EFFECTS elements already linked to their control */
  const linked = new Map();
  /** @type {Set<ElementModel>} elements waiting for their slot to mount */
  const waiting = new Set();
  /** @type {(() => void) | null} */
  let stopFrames = null;

  /** @param {ElementModel} el @returns {boolean} */
  function linkEffects(el) {
    if (linked.has(el.handle)) return true;
    const control = deps.effectsOf(el);
    if (!control) return false;
    linked.set(el.handle, control.onChange(() => hub.emit(`effects:${el.handle}`)));
    return true;
  }

  /**
   * Listen to an EFFECTS element's control. The renderer mounts the slot after the bindings install,
   * so a control that is not there yet is retried once per frame until it is.
   * @param {ElementModel} el
   */
  function watchEffects(el) {
    if (linkEffects(el)) return;
    waiting.add(el);
    stopFrames ??= host.clock.onFrame(() => {
      for (const e of [...waiting]) if (linkEffects(e)) waiting.delete(e);
      if (waiting.size === 0) { stopFrames?.(); stopFrames = null; }
    });
  }

  env.cleanup.push(() => {
    stopFrames?.();
    stopFrames = null;
    for (const stop of linked.values()) stop();
    linked.clear();
    waiting.clear();
  });

  const changeSource = createSources(env, {
    rootOf: (name) => globalsByName.get(name.toLowerCase()) ?? (view.byId(name) ? elementObject(/** @type {ElementModel} */ (view.byId(name))) : null),
    objectOf,
  });

  // ---- the graph -----------------------------------------------------------------------------------

  /** @type {ObjectGraph} */
  const graph = {
    globals,
    hostGlobals: Object.freeze({
      player: player.handle, theme: themeObject.handle, view: viewObject.handle, event: eventObject.handle,
      mediacenter: mediacenter.object.handle, playerApplication: playerApplication.handle,
    }),
    elementObject,
    changeSource,
    objectOf,
    ready: mediacenter.ready,

    setEvent(ev) { env.currentEvent = ev; },

    dispose() {
      if (env.disposed) return;
      env.disposed = true;
      for (const stop of env.cleanup.splice(0)) {
        try { stop(); } catch (e) { host.log.warn(`object graph dispose: ${e instanceof Error ? e.message : String(e)}`); }
      }
      policy.dispose();
      hub.clear();
      objects.clear();
      elementObjects.clear();
      env.currentEvent = null;
    },
  };
  return graph;
}
