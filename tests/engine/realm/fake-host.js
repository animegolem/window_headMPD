// @ts-check
// A fake host for the realm tests (WAVES W2.2 "Consumes: a fake dispatcher and fake class member
// lists"). Host objects are Maps keyed by handle, every crossing is logged, timers run on the test
// host's manual EngineClock (src/hosts/test/clock.js), and the log keeps every diagnostic so a test can
// assert on it. Not engine code.

import { afterEach, expect } from 'vitest';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createRealm, realmDebug } from '../../../src/engine/realm/realm.js';

/** The real clock, captured at module load, before any test installs fake timers. */
export const wallClock = performance.now.bind(performance);

export const MiB = 1024 * 1024;

/** Lowercased member lists per class, as the schema would send them. */
export const CLASS_MEMBERS = new Map([
  ['element.slider', ['value', 'min', 'max', 'top', 'left', 'width', 'height', 'visible', 'moveto', 'id']],
  ['element.button', ['top', 'left', 'down', 'visible', 'moveto', 'tooltip', 'uptooltip', 'id', 'enabled']],
  ['element.text', ['value', 'textwidth', 'visible', 'left', 'top', 'tooltip', 'id']],
  ['element.player', ['controls', 'settings', 'playstate', 'openstate', 'status']],
  ['player', ['controls', 'settings', 'playstate', 'openstate', 'status', 'currentmedia', 'url']],
  ['controls', ['play', 'pause', 'stop', 'next', 'previous', 'currentposition']],
  ['theme', ['savepreference', 'loadpreference', 'loadstring', 'logstring', 'currentviewid']],
  ['view', ['width', 'height', 'close', 'minimize', 'timerinterval', 'title']],
  ['event', ['x', 'y', 'button', 'keycode', 'srcelement', 'offsetx', 'offsety']],
  ['mediacenter', ['effectpreset', 'effecttype']],
  ['playerApplication', []],
]);

export const HOST_GLOBALS = Object.freeze({ player: 100, theme: 101, view: 102, event: 103, mediacenter: 104, playerApplication: 105 });

/**
 * @typedef {{ cls: string, props: Map<string, any>, methods: Map<string, (...a: any[]) => any>,
 *   onSet?: (key: string, v: any) => void }} FakeObject
 */

export class FakeObjects {
  constructor() {
    /** @type {Map<number, FakeObject>} */
    this.objects = new Map();
    /** Every crossing, in order: [op, handle, key, args]. @type {Array<[string, number, string, any[]?]>} */
    this.log = [];
  }

  /**
   * @param {number} handle @param {string} cls
   * @param {{ props?: Record<string, any>, methods?: Record<string, (...a: any[]) => any>, onSet?: (key: string, v: any) => void }} [spec]
   */
  add(handle, cls, spec = {}) {
    this.objects.set(handle, { cls, props: new Map(Object.entries(spec.props ?? {})), methods: new Map(Object.entries(spec.methods ?? {})), onSet: spec.onSet });
    return this;
  }

  /** @param {number} h @param {string} key */
  prop(h, key) {
    return this.objects.get(h)?.props.get(key);
  }
}

/** The standard small view: three elements with ids, plus the six host globals. */
export function standardObjects() {
  const objects = new FakeObjects()
    .add(1, 'element.slider', { props: { value: 50, min: 0, max: 100, top: 7, left: 8, width: 90, visible: true, id: 'volume' }, methods: { moveto: (x, y, s) => `slider:${x},${y},${s}` } })
    .add(2, 'element.button', { props: { top: 129, left: 0, down: false, visible: true, tooltip: 'tip', id: 'sEqEar' }, methods: { moveto: (x, y, s) => `moved:${x},${y},${s}` } })
    .add(3, 'element.text', { props: { value: 'ice', textwidth: 12, visible: true, id: 'Ice' } })
    .add(4, 'element.text', { props: { value: 'proto-id', id: '__proto__' } })
    .add(5, 'element.text', { props: { value: 'ctor-id', id: 'constructor' } })
    .add(10, 'element.text', { props: { value: 'eq0', left: 0 } })
    .add(11, 'element.text', { props: { value: 'eq1', left: 0 } })
    .add(12, 'element.text', { props: { value: 'eq2', left: 0 } })
    .add(100, 'player', { props: { playstate: 3, openstate: 13, status: 'Playing', controls: { __h: 110 } } })
    .add(110, 'controls', { props: { currentposition: 0 }, methods: { play: () => 'played', next: () => 'next' } })
    .add(101, 'theme', { methods: { loadpreference: (k) => `pref:${k}`, savepreference: () => undefined } })
    .add(102, 'view', { props: { width: 760, height: 394 }, methods: { close: () => 'closed' } })
    .add(103, 'event', { props: { x: 1, y: 2 } })
    .add(104, 'mediacenter', { props: { effectpreset: 2 } })
    .add(105, 'playerApplication', {});
  return objects;
}

/** The ids of the standard view. */
export const STANDARD_IDS = [
  { id: 'volume', handle: 1, className: 'element.slider' },
  { id: 'sEqEar', handle: 2, className: 'element.button' },
  { id: 'Ice', handle: 3, className: 'element.text' },
  { id: '__proto__', handle: 4, className: 'element.text' },
  { id: 'constructor', handle: 5, className: 'element.text' },
  { id: 'eq0', handle: 10, className: 'element.text' },
  { id: 'eq1', handle: 11, className: 'element.text' },
  { id: 'eq2', handle: 12, className: 'element.text' },
];

/**
 * @typedef {Object} RecordingLog
 * @property {import('../../../src/engine/contracts').Diagnostic[]} diags
 * @property {Array<[string, object | undefined]>} infos
 * @property {Array<[string, object | undefined]>} warns
 */

/** @returns {import('../../../src/engine/contracts').Log & RecordingLog} */
export function recordingLog() {
  /** @type {RecordingLog} */
  const rec = { diags: [], infos: [], warns: [] };
  return {
    ...rec,
    info(m, d) { rec.infos.push([m, d]); },
    warn(m, d) { rec.warns.push([m, d]); },
    diag(d) { rec.diags.push(d); },
  };
}

/** @type {Array<{ realm: import('../../../src/engine/contracts').Realm, log: RecordingLog }>} */
const opened = [];

// Every realm a test opens is unloaded afterwards. One that never hard-faulted must dispose cleanly:
// a quickjs-emscripten handle leaked anywhere in realm.js would make that dispose abort.
afterEach(() => {
  /** @type {string[]} */
  const problems = [];
  for (const { realm, log } of opened.splice(0)) {
    const dbg = realmDebug(realm);
    const wasLive = dbg?.state() === 'live';
    const hard = realm.health.hard;
    realm.unload('test end');
    if (wasLive && hard === 0) {
      if (dbg?.state() !== 'disposed') problems.push(`a clean realm did not dispose (${dbg?.state()}): ${JSON.stringify(log.warns)}`);
      if (!log.infos.some(([m]) => m === 'realm: unload: disposed')) problems.push('no "disposed" log line');
    }
    if (hard > 0 && dbg?.state() === 'disposed') problems.push('a realm with a hard fault was disposed');
  }
  expect(problems).toEqual([]);
});

/**
 * @typedef {Object} Harness
 * @property {import('../../../src/engine/contracts').Realm} realm
 * @property {FakeObjects} objects
 * @property {ReturnType<typeof createManualClock>} clock
 * @property {ReturnType<typeof recordingLog>} log
 * @property {Array<[string, number, number, boolean]>} timerOps
 * @property {(body: string, opts?: { el?: number, event?: string, params?: string[], ctx?: any }) => import('../../../src/engine/contracts').Fault | { ok: true, value: any }} handler
 */

/**
 * A realm over the fake host. `objects` and `ids` default to the standard view.
 * @param {{ objects?: FakeObjects, ids?: typeof STANDARD_IDS | null, options?: Partial<import('../../../src/engine/contracts').RealmOptions>,
 *   classMembers?: Map<string, string[]>, wall?: () => number }} [opts]
 * @returns {Promise<Harness>}
 */
export async function makeRealm(opts = {}) {
  const objects = opts.objects ?? standardObjects();
  const clock = createManualClock();
  const log = recordingLog();
  /** @type {Array<[string, number, number, boolean]>} */
  const timerOps = [];
  /** @type {Map<number, number>} realm timer id -> clock timer id */
  const scheduled = new Map();
  /** @type {import('../../../src/engine/contracts').Realm | null} */
  let realmRef = null;

  /** @param {number} id @param {number} ms @param {boolean} repeat */
  const schedule = (id, ms, repeat) => {
    const cid = clock.setTimer(ms, () => {
      scheduled.delete(id);
      if (repeat) schedule(id, ms, true);
      realmRef?.fireTimer(id);
    });
    scheduled.set(id, cid);
  };

  /** @type {import('../../../src/engine/contracts').HostDispatcher} */
  const dispatcher = {
    get(h, key) {
      objects.log.push(['get', h, key]);
      const o = objects.objects.get(h);
      if (!o) return undefined;
      if (o.methods.has(key)) return { method: true };
      return o.props.get(key);
    },
    set(h, key, v) {
      objects.log.push(['set', h, key, [v]]);
      const o = objects.objects.get(h);
      if (!o) return;
      o.props.set(key, v);
      o.onSet?.(key, v);
    },
    call(h, key, args) {
      objects.log.push(['call', h, key, args]);
      return objects.objects.get(h)?.methods.get(key)?.(...args);
    },
    timer(op, id, ms, repeat) {
      timerOps.push([op, id, ms, repeat]);
      const cid = scheduled.get(id);
      if (cid !== undefined) {
        clock.clearTimer(cid);
        scheduled.delete(id);
      }
      if (op === 'set') schedule(id, ms, repeat);
    },
    now: () => clock.now(),
  };

  const realm = await createRealm({
    viewKey: 'test/view',
    memoryLimitBytes: 64 * MiB,
    maxStackBytes: 256 * 1024,
    budgets: FAITHFUL.budgets,
    wallClock: opts.wall ?? wallClock,
    dispatcher,
    classMembers: opts.classMembers ?? CLASS_MEMBERS,
    hostGlobals: HOST_GLOBALS,
    log,
    ...opts.options,
  });
  realmRef = realm;
  opened.push({ realm, log });
  if (opts.ids !== null) realm.setIds(opts.ids ?? STANDARD_IDS);

  /** @type {Harness['handler']} */
  const handler = (body, h = {}) => realm.runHandler(h.el ?? 2, { event: h.event ?? 'onclick', source: body, params: h.params ?? [], line: 1 }, h.ctx);

  return { realm, objects, clock, log, timerOps, handler };
}

/**
 * Run a handler body that stores its result in the global `out`, and read it back.
 * @param {Harness} hn @param {string} body @param {Parameters<Harness['handler']>[1]} [opts]
 */
export function outOf(hn, body, opts) {
  const r = hn.handler(`out = JSON.stringify((function () { ${body} }).call(this));`, opts);
  if (!r.ok) throw new Error(`handler failed: ${r.kind} ${r.reason}`);
  const text = hn.realm.readGlobal('out');
  return text === undefined ? undefined : JSON.parse(String(text));
}
