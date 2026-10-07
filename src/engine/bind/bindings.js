// @ts-check
// `createBindings` (E §5.11, E D5 bindings): the live, one-way attributes of a VIEW. Host-side only:
// nothing here runs skin code, and nothing here ever writes the player.
//
//   wmpprop:PATH          the attribute follows the value at PATH (an object-model member, another
//                         element's attribute, `eq.gainLevel3`, `player.settings.getMode('loop')`)
//   wmpenabled:NAME       the attribute follows `player.controls.isAvailable(NAME)`, on ANY boolean
//   wmpdisabled:NAME      attribute (U-4), negated for wmpdisabled
//
// How a binding lives:
//   - The object graph resolves the path (`ObjectGraph.changeSource`) and subscribes to the change
//     source of every object on it. Whenever one of them fires the path is resolved again, so an
//     intermediate object that was replaced (`currentMedia` on a song change) is followed.
//   - The value is assigned through `ElementModel.set(attr, v, 'binding')`, which coerces to the
//     attribute's type, reports a change only when the coerced value differs, and queues the
//     `<attr>_onchange` handler. An equal value therefore does nothing at all.
//   - A script or user write overrides the binding until the source changes again.
//   - `suspend`/`resume` hold a binding while the user drags a slider (parity D18): changes to the
//     source are not applied, and `resume` reads the source once and applies it once.
//     Suspending a SLIDER's or CUSTOMSLIDER's `value` also holds its `max` (E D5). Callers resume
//     after the drag-end handler has written the player, so the read sees what the user chose.
//
// Position. `player.controls.currentPosition` (and its string) is read live and extrapolated, but it
// changes continuously without a change notification, so `frame(now)` re-reads every such binding on
// every frame: the host-side value, and so the seek thumb, moves smoothly (parity F4). The realm sees
// less. An element that has the `<attr>_onchange` handler gets that event at most `realmTickHz` times
// a second (E D5, U-19): between ticks the attribute is written with origin 'quiet' (updates the
// element and its followers, queues no handler), and on a tick with origin 'binding'. A change that
// the model already holds by then (written between ticks, equal at the tick) is still reported, by
// putting the last reported value back quietly first. An element with no such handler is written
// with origin 'binding' every frame. A notification (a seek, a state change) is published at once
// and restarts the tick.
//
// Followers. A binding whose path is another element's attribute (`value="wmpprop:seek.value"`) is
// notified inside the write that moved that attribute, so it applies with that write's quietness: a
// quiet write between ticks is followed quietly, and the follower's own followers inherit it in turn.
// The follower therefore tracks every frame on the host side and reaches the realm only when its
// leader does, on a tick.
//
// `<controls currentPosition_onchange>` is the position listener of 176 corpus skins, and a CONTROLS
// element has no binding of its own to write the event from. Such an element gets an implicit one
// (`mirror`): `currentPosition` follows `player.controls.currentPosition`, written on ticks only,
// and quietly at load.
//
// Not handled here: the PLAYER events (`<player OpenState_onchange>`, `PlayStateChange`). A PLAYER
// element has no `playState` attribute to write, so there is nothing for `set` to queue them with.

import { attrSpecsOf } from '../wms/attrs.js';
import { SCHEMA } from '../model/schema.js';
import { availabilityPath, formatPath } from './paths.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').ObjectGraph} ObjectGraph */
/** @typedef {import('../contracts').EngineClock} EngineClock */
/** @typedef {import('../contracts').BindingEngine} BindingEngine */
/** @typedef {import('../contracts').AttrValue} AttrValue */
/** @typedef {import('../contracts').Origin} Origin */
/** @typedef {import('../contracts').Ledger} Ledger */
/** @typedef {import('../contracts').AttrSpec} AttrSpec */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {NonNullable<ReturnType<ObjectGraph['changeSource']>>} Source */

/**
 * @typedef {Object} Binding
 * @property {ElementModel} el
 * @property {string} attr          lower case
 * @property {string} text          the path as the object graph reads it
 * @property {boolean} negate       wmpdisabled
 * @property {boolean} position     the path ends in a member that follows playback time
 * @property {boolean} mirror       implicit: only ever written on a realm tick
 * @property {Source | null} source
 * @property {(() => void) | null} unsub
 * @property {boolean} held         a drag holds it (suspend)
 * @property {AttrValue} reported   the last value the realm was told about (position bindings)
 * @property {boolean} unresolvedSeen
 * @property {boolean} faultSeen
 * @property {Set<string>} stubs    the stub members this binding has put in the ledger (once each)
 */

/** E D5: the `_onchange` chain is capped at 32; a binding chain through other bindings gets the same cap. */
export const MAX_CHAIN = 32;
/** The tick rate to use when `realmTickHz` is unusable. */
const DEFAULT_TICK_HZ = 10;

/**
 * Members whose value follows playback time without announcing it, read off the schema's change
 * source `media.position`. A Set of lower-case names, so `constructor` is not one.
 * @type {ReadonlySet<string>}
 */
const POSITION_MEMBERS = new Set(
  [...SCHEMA.values()].flatMap((cls) => [...cls].filter(([, spec]) => spec.changeSource === 'media.position').map(([key]) => key)),
);

/** The SLIDER kinds whose `max` is held together with `value` during a drag. */
const DRAGGABLE = new Set(['slider', 'customslider']);

/** @param {unknown} s */
const lower = (s) => String(s).toLowerCase();

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/** @type {import('../contracts').CreateBindingsFn} */
export function createBindings(view, graph, clock, opts) {
  const { ledger } = opts;     // optional: a caller that passes none gets a silent engine
  const periodMs = Number.isFinite(opts.realmTickHz) && opts.realmTickHz > 0 ? 1000 / opts.realmTickHz : 1000 / DEFAULT_TICK_HZ;

  /** @type {Binding[]} */
  const all = [];
  /** The bindings that are read on every frame. @type {Binding[]} */
  const live = [];
  /** @type {Map<ElementModel, Map<string, Binding>>} */
  const byTarget = new Map();
  /** @type {Map<ElementKind, readonly AttrSpec[]>} */
  const specsByKind = new Map();

  let installed = false;
  let disposed = false;
  let depth = 0;
  let capReported = false;
  /**
   * The origin of the model write the engine is making right now. A follower is notified inside the
   * write that moved its source, and reads this to learn whether that write was quiet.
   * @type {Origin | null}
   */
  let writing = null;
  /** The earliest engine time the realm may be told about the next position change. */
  let nextRealmAt = -Infinity;
  /** @type {(() => void) | null} */
  let stopChanges = null;

  // ---- discovery ---------------------------------------------------------------------------------

  /** @param {ElementKind} kind */
  function specsOf(kind) {
    let specs = specsByKind.get(kind);
    if (!specs) specsByKind.set(kind, (specs = attrSpecsOf(kind).filter((s) => s.type !== 'handler')));
    return specs;
  }

  /**
   * @param {ElementModel} el @param {string} attr @param {string | null} text
   * @param {{ negate?: boolean, mirror?: boolean, last?: string }} [flags] `last`: the final member name, for the position test
   */
  function add(el, attr, text, flags = {}) {
    /** @type {Binding} */
    const b = {
      el, attr: lower(attr), text: text ?? '', negate: flags.negate === true, mirror: flags.mirror === true,
      position: flags.mirror === true || (flags.last !== undefined && POSITION_MEMBERS.has(lower(flags.last))),
      source: null, unsub: null, held: false, reported: null, unresolvedSeen: false, faultSeen: false, stubs: new Set(),
    };
    all.push(b);
    let row = byTarget.get(el);
    if (!row) byTarget.set(el, (row = new Map()));
    row.set(b.attr, b);
    if (b.position) live.push(b);
    return b;
  }

  function discover() {
    for (const el of view.elements) {
      for (const spec of specsOf(el.kind)) {
        // A read-only attribute is the host's to write: the model refuses it every origin but 'init'
        // and 'host', so a binding to one could only ever do nothing.
        if (spec.access === 'r') continue;
        const src = el.source(spec.name);
        if (!src) continue;
        if (src.kind === 'wmpprop') {
          add(el, spec.name, formatPath(src.path), { last: src.path.segments[src.path.segments.length - 1]?.name });
        } else if (src.kind === 'wmpenabled' || src.kind === 'wmpdisabled') {
          add(el, spec.name, formatPath(availabilityPath(src.method)), { negate: src.kind === 'wmpdisabled' });
        }
      }
      // `<controls currentPosition_onchange>`: the position listener has no attribute binding to ride on.
      if (el.kind === 'controls' && el.handlers.has('currentposition_onchange') && !byTarget.get(el)?.has('currentposition')) {
        add(el, 'currentPosition', 'player.controls.currentPosition', { mirror: true, last: 'currentPosition' });
      }
    }
  }

  // ---- resolving and reading ---------------------------------------------------------------------

  /** @param {Binding} b */
  function detach(b) {
    const stop = b.unsub;
    b.unsub = null;
    stop?.();
  }

  /**
   * `graph.changeSource` for one binding. The graph records a `stub` ledger entry each time it builds
   * a path that goes through a stub member, and a binding builds its path again on every
   * notification, so a stub bound through `player.currentMedia` would be counted once per song. The
   * ledger counts a binding's stub once: the first build of each stub member passes through, the
   * rebuilds do not. This relies on the graph recording into the ledger this engine was given (one
   * ledger per skin session); with any other ledger it filters nothing, and a ledger that cannot be
   * wrapped is left alone.
   * @param {Binding} b
   */
  function resolve(b) {
    const target = ledger;
    if (!target) return graph.changeSource(b.text);
    const real = target.record;
    try {
      target.record = (api, kind, detail) => {
        if (kind === 'stub') {
          if (b.stubs.has(api)) return;
          b.stubs.add(api);
        }
        real.call(target, api, kind, detail);
      };
    } catch {
      return graph.changeSource(b.text);
    }
    try {
      return graph.changeSource(b.text);
    } finally {
      target.record = real;
    }
  }

  /**
   * Resolve the path again and listen to what is on it now. The previous listeners go first: the
   * graph holds callbacks in sets, so the old generation must not outlive the new one.
   * @param {Binding} b
   * @returns {boolean} whether the path resolves
   */
  function attach(b) {
    detach(b);
    b.source = b.text === '' ? null : resolve(b);
    if (!b.source) {
      if (!b.unresolvedSeen) {
        b.unresolvedSeen = true;
        ledger?.record(b.text || '(unprintable path)', 'unresolved-binding', `${b.el.id}.${b.attr} keeps its default`);
      }
      return false;
    }
    b.unsub = b.source.subscribe(() => onSource(b));
    return true;
  }

  /**
   * The current value, or undefined when there is none to assign: an unresolved path, an object
   * (a path that ends on one has no value to copy), or a failed read.
   * @param {Binding} b
   * @returns {unknown}
   */
  function pull(b) {
    if (!b.source) return undefined;
    /** @type {unknown} */
    let v;
    try {
      v = b.source.read();
    } catch (e) {
      fault(b, e);
      return undefined;
    }
    if (v === undefined || v === null || typeof v === 'object') return undefined;
    if (b.negate) return typeof v === 'boolean' ? !v : undefined;
    return v;
  }

  /** @param {Binding} b @param {unknown} e */
  function fault(b, e) {
    if (b.faultSeen) return;
    b.faultSeen = true;
    ledger?.record(b.text, 'soft-fault', `binding read threw: ${messageOf(e)}`);
  }

  /**
   * The one place the engine assigns an attribute, so that `writing` says what is being written
   * while the followers of the attribute are notified.
   * @param {Binding} b @param {unknown} v @param {Origin} origin
   * @returns {boolean} whether the attribute changed
   */
  function setAs(b, v, origin) {
    const outer = writing;
    writing = origin;
    try {
      return b.el.set(b.attr, v, origin);
    } finally {
      writing = outer;
    }
  }

  /**
   * @param {Binding} b @param {Origin} origin
   * @returns {boolean} whether the attribute changed
   */
  function write(b, origin) {
    const v = pull(b);
    if (v === undefined) return false;
    try {
      return setAs(b, v, origin);
    } catch (e) {
      fault(b, e);
      return false;
    }
  }

  /** A change the realm was told about: the baseline of the position bindings. @param {Binding} b */
  const markReported = (b) => { b.reported = b.el.get(b.attr); };

  // ---- applying ----------------------------------------------------------------------------------

  /**
   * Re-read a binding and assign it, now. Bindings can feed bindings (`top="wmpprop:other.top"`), and
   * every assignment notifies the others synchronously, so the nesting is counted.
   * @param {Binding} b
   * @param {'binding' | 'quiet'} [origin] 'quiet' for a follower of a quiet write
   */
  function apply(b, origin = 'binding') {
    if (depth >= MAX_CHAIN) {
      if (!capReported) {
        capReported = true;
        ledger?.record('wmpprop chain', 'cap', `bindings fed each other more than ${MAX_CHAIN} deep; the chain stopped at ${b.el.id}.${b.attr}`);
      }
      return;
    }
    depth++;
    try {
      // A position change that reached a listener restarts the tick: seeks are not followed by a second event.
      if (write(b, origin) && origin === 'binding' && b.position && b.el.handlers.has(`${b.attr}_onchange`)) nextRealmAt = clock.now() + periodMs;
    } finally {
      depth--;
    }
  }

  /** A change source on the path fired. @param {Binding} b */
  function onSource(b) {
    if (disposed) return;
    attach(b);                                   // an object on the path may have been replaced
    if (!b.held) apply(b, writing === 'quiet' ? 'quiet' : 'binding');
  }

  /** The realm hears about position changes when the model writes them with an origin that queues. @type {(el: ElementModel, attr: string, v: AttrValue, origin: Origin) => void} */
  function onModelChange(el, attr, v, origin) {
    if (origin === 'init' || origin === 'quiet') return;
    const b = byTarget.get(el)?.get(attr);
    if (b?.position) b.reported = v;
  }

  // ---- the frame ---------------------------------------------------------------------------------

  /**
   * One position binding on one frame.
   * @param {Binding} b @param {boolean} tick the realm may hear about a change this frame
   * @returns {boolean} whether the realm was told
   */
  function publish(b, tick) {
    const listening = b.el.handlers.has(`${b.attr}_onchange`);
    if (b.mirror && !tick) return false;
    if (!listening) { write(b, 'binding'); return false; }
    const v = pull(b);
    if (v === undefined) return false;
    if (!tick) { setAs(b, v, 'quiet'); return false; }
    if (setAs(b, v, 'binding')) return true;
    // The model already holds v. If the realm was never told how it got there, tell it now.
    if (Object.is(b.el.get(b.attr), b.reported)) return false;
    setAs(b, b.reported, 'quiet');
    return setAs(b, v, 'binding');
  }

  // ---- the engine --------------------------------------------------------------------------------

  /** @param {ElementModel} el @param {string} attr @returns {Binding[]} */
  function targetsOf(el, attr) {
    const row = byTarget.get(el);
    if (!row) return [];
    const key = lower(attr);
    const names = key === 'value' && DRAGGABLE.has(el.kind) ? ['value', 'max'] : [key];
    return names.flatMap((n) => row.get(n) ?? []);
  }

  /** @type {BindingEngine} */
  const engine = {
    install() {
      if (installed || disposed) return;
      installed = true;
      discover();
      stopChanges = view.onChange(onModelChange);
      // Subscribe to everything before the first read, so that a binding that follows another
      // element's attribute hears that element settle, whatever the source order.
      for (const b of all) attach(b);
      for (const b of all) {
        if (!b.source) continue;
        if (b.mirror) write(b, 'init');
        else apply(b);
        markReported(b);
      }
    },

    suspend(el, attr) {
      for (const b of targetsOf(el, attr)) b.held = true;
    },

    resume(el, attr) {
      for (const b of targetsOf(el, attr)) {
        if (!b.held) continue;
        b.held = false;
        apply(b);
      }
    },

    frame(now) {
      if (disposed || live.length === 0) return;
      if (nextRealmAt > now + periodMs) nextRealmAt = now;       // the clock went backwards
      const tick = now >= nextRealmAt;
      let told = false;
      for (const b of live) {
        if (b.held || !b.source) continue;
        if (publish(b, tick)) told = true;
      }
      if (told) nextRealmAt = now + periodMs;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopChanges?.();
      stopChanges = null;
      for (const b of all) { detach(b); b.source = null; }
      all.length = 0;
      live.length = 0;
      byTarget.clear();
    },
  };
  return engine;
}
