// @ts-check
// A test prelude: ENGINE D1's script realm, built in test code so RG0 can measure the mechanism
// before any realm module exists. W2.2 writes the real one; this file is the executable version of
// the D1 text that W2.2 can compare against.
//
// What it builds (D1 "Scope chain", "Host globals", "Prelude internals", "membrane"):
//   - `__IDS`, a realm-side Proxy. `has(k)`: (a) k is a VIEW id exactly, or (b) k equals an id
//     case-insensitively and no own property named exactly k exists on the realm global, and in both
//     cases (c) k is not one of the six host-global names. Answered from realm-side tables, so `has`
//     never crosses to the host. `get` returns the cached element proxy, so `bEq === bEq`.
//   - An element proxy per id. `has` is true only for members of the element's class, compared
//     case-insensitively. `get`/`set` cross through the one native function `__hostDispatch`, with the
//     key lowercased by the proxy.
//   - Host globals as configurable, writable data properties of the realm global (`event` as a
//     configurable accessor), so a skin `var player` replaces one.
//   - Prelude internals (`__IDS`, `__handler`, `__idWrites`) non-writable and non-configurable; the
//     native dispatcher captured in a closure and deleted from the global before any skin code runs.
//
// Every table keyed by a skin-controlled string is a Map or a Set (ENGINE §1 rule 6); the tests give
// it the ids `__proto__` and `constructor`.

export const HOST_GLOBAL_NAMES = Object.freeze(['player', 'theme', 'view', 'event', 'mediacenter', 'playerApplication']);

/**
 * @typedef {Object} PreludeConfig
 * @property {Array<{ id: string, handle: number, cls: string }>} ids
 * @property {Record<string, string[]>} classMembers  class -> lowercased members
 * @property {string[]} [hostNames]
 */

/**
 * Source of the prelude, to evaluate once as global code on a fresh instance that already has
 * `__hostDispatch` defined.
 * @param {PreludeConfig} config
 * @returns {string}
 */
export function preludeSource(config) {
  const cfg = { hostNames: HOST_GLOBAL_NAMES, ...config };
  return `(function (g, cfg) {
  'use strict';
  const dispatch = g.__hostDispatch;
  delete g.__hostDispatch;
  const hasOwn = Object.prototype.hasOwnProperty;
  const hostNames = new Set(cfg.hostNames);
  const byExact = new Map();              // id -> { handle, cls }
  const byLower = new Map();              // lowercase id -> declared id (first declaration wins)
  const members = new Map(Object.entries(cfg.classMembers).map(([cls, list]) => [cls, new Set(list)]));
  const byHandle = new Map();             // handle -> id
  for (const { id, handle, cls } of cfg.ids) {
    if (!byExact.has(id)) byExact.set(id, { handle, cls });
    const l = id.toLowerCase();
    if (!byLower.has(l)) byLower.set(l, id);
    byHandle.set(handle, id);
  }
  const proxies = new Map();              // id -> cached element proxy
  const methods = new Map();              // handle + ':' + key -> cached bound method

  function method(handle, key) {
    const k = handle + ':' + key;
    let fn = methods.get(k);
    if (!fn) {
      fn = function (a, b, c) { return dispatch('call', handle, key, a, b, c); };
      methods.set(k, fn);
    }
    return fn;
  }
  function elementProxy(id) {
    let p = proxies.get(id);
    if (p) return p;
    const { handle, cls } = byExact.get(id);
    const set = members.get(cls) ?? new Set();
    p = new Proxy(Object.create(null), {
      has(_t, k) { return typeof k === 'string' && set.has(k.toLowerCase()); },
      get(_t, k) {
        if (typeof k !== 'string') return undefined;        // Symbol.unscopables and friends
        const lk = k.toLowerCase();
        if (!set.has(lk)) return undefined;
        const v = dispatch('get', handle, lk);
        if (v !== null && typeof v === 'object') {
          if (v.method === true) return method(handle, lk);
          if (typeof v.__h === 'number' && byHandle.has(v.__h)) return elementProxy(byHandle.get(v.__h));
          return undefined;
        }
        return v;
      },
      set(_t, k, v) {
        if (typeof k === 'string' && set.has(k.toLowerCase())) dispatch('set', handle, k.toLowerCase(), v);
        return true;
      },
    });
    proxies.set(id, p);
    return p;
  }

  const idWrites = [];
  const ids = new Proxy(Object.create(null), {
    has(_t, k) {
      if (typeof k !== 'string') return false;
      if (hostNames.has(k)) return false;                    // (c) the six host globals beat ids (G17)
      if (byExact.has(k)) return true;                       // (a) exact id
      return byLower.has(k.toLowerCase()) && !hasOwn.call(g, k);   // (b) case variant, unless the script owns k
    },
    get(_t, k) {
      if (typeof k !== 'string') return undefined;
      const id = byExact.has(k) ? k : byLower.get(k.toLowerCase());
      return id === undefined ? undefined : elementProxy(id);
    },
    set(_t, k) { if (typeof k === 'string') idWrites.push(k); return true; },   // U-31: a write through an id goes nowhere
  });

  const handlers = new Map();
  function handler(id, body) {
    const key = id + '\\u0000' + body;
    let f = handlers.get(key);
    if (!f) { f = new Function('with(__IDS){with(this){' + body + '\\n}}'); handlers.set(key, f); }
    return f.call(elementProxy(id));
  }

  const lock = (name, value) => Object.defineProperty(g, name, { value, writable: false, configurable: false, enumerable: false });
  lock('__IDS', ids);
  lock('__handler', handler);
  lock('__idWrites', () => idWrites.slice());

  for (const n of cfg.hostNames) {
    if (n === 'event') {
      Object.defineProperty(g, n, { get() { return { current: 'event' }; }, set(v) { Object.defineProperty(g, n, { value: v, writable: true, configurable: true }); }, configurable: true });
    } else {
      Object.defineProperty(g, n, { value: { hostGlobal: n }, writable: true, configurable: true });
    }
  }
})(globalThis, ${JSON.stringify(cfg)});`;
}

/**
 * The host side of the dispatcher for tests: a tiny object model keyed by handle. Maps throughout.
 * `log` records every crossing as `[op, handle, key]`, in order, so a test can show that a host op
 * ran inside the statement that caused it.
 */
export class FakeModel {
  constructor() {
    /** @type {Map<number, { props: Map<string, any>, methods: Map<string, (...a: any[]) => any> }>} */
    this.objects = new Map();
    /** @type {Array<[string, number, string]>} */
    this.log = [];
  }

  /**
   * @param {number} handle
   * @param {{ props?: Record<string, any>, methods?: Record<string, (...a: any[]) => any> }} spec
   */
  add(handle, spec = {}) {
    this.objects.set(handle, { props: new Map(Object.entries(spec.props ?? {})), methods: new Map(Object.entries(spec.methods ?? {})) });
    return this;
  }

  /** @param {string} op @param {number} handle @param {string} key @param {any[]} args */
  dispatch(op, handle, key, ...args) {
    this.log.push([op, handle, key]);
    const o = this.objects.get(handle);
    if (!o) throw new Error(`no such handle ${handle}`);
    if (op === 'get') return o.methods.has(key) ? { method: true } : o.props.get(key);
    if (op === 'set') { o.props.set(key, args[0]); return undefined; }
    if (op === 'call') return o.methods.get(key)?.(...args);
    throw new Error(`unknown op ${op}`);
  }
}

/**
 * Define `__hostDispatch` on a fresh instance, then evaluate the prelude. Returns the model.
 * @param {import('./qjs.js').Instance} inst
 * @param {PreludeConfig} config
 * @param {FakeModel} [model]
 */
export function installPrelude(inst, config, model = new FakeModel()) {
  inst.defineHost('__hostDispatch', (op, handle, key, ...args) => model.dispatch(op, handle, key, ...args));
  inst.eval(preludeSource(config), { filename: 'prelude.js' });
  return model;
}
