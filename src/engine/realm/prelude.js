// @ts-check
// The realm-side bootstrap of ENGINE D1, shipped as source text (`PRELUDE_SOURCE`) and evaluated once in
// every new QuickJS context before any skin code. This file is the boundary checker's one sink exemption
// (D8 rule 3): what it holds is realm source, so it names the realm's own code-loading intrinsics.
//
// The source is a function expression. realm.js evaluates `({ boot: <PRELUDE_SOURCE> })` and calls
// `boot(host, cfgText)`: `host` is the single native function of the membrane, which is therefore
// never a property of the realm global at all; it lives only in this closure. `boot` returns the
// entry object, whose methods the host calls through `callMethod`; skin code cannot reach it.
//
// What boot builds, in order:
//   1. captures the intrinsics it relies on, before any skin code can replace them. Its own Map and Set
//      are private subclasses holding the original methods, so neither a skin nor the guards of step 9
//      sit on the prelude's lookups;
//   2. `__IDS`, the id Proxy (D1 "Scope chain"): `has(k)` is true when k is an id exactly, or equals an
//      id case-insensitively and the global has no own property named exactly k, and never for the six
//      host-global names or a reserved name (`eval`, `__wmp*`). Answered from realm-side tables. An
//      assignment through it goes nowhere (U-31) and is reported once per id, case-insensitively, and
//      only for a real id (G2 DOS-7);
//   3. one cached Proxy per handle. `has` answers from the class member set the host sent at boot (or
//      `setIds`), case-insensitively, and never crosses; `get`/`set`/method calls cross through `host`
//      with the key lowercased. A handle whose class the realm was never told (a `{__h}` a dispatcher result
//      carried, such as `player.controls`) gets a proxy whose `has` is false: it is never in a `with`
//      chain, and its `get`/`set` still forward every string key for the host to validate. A key longer
//      than the membrane's 64 KiB is refused before it is lowercased or sent (G2 F1). Every proxy
//      handler here is a frozen null-prototype object over a frozen empty target, so no trap is ever
//      looked up on Object.prototype (where a skin could plant one and capture the handler as `this`)
//      and no skin can define a property on a target to break the proxy's invariants (G2 F4);
//   4. the host globals as configurable, writable data properties (`event` as a configurable
//      accessor), so a skin `var`/`function` with the same name replaces them;
//   5. the `#132` constants (D1 "Constants"; wmploc 7.3 item 4);
//   6. the locked internals: `__IDS`, `__wmp_badAssign` (E R20), `__wmp_src` (the loader's slot, an
//      accessor that hands its text out once) and `eval` itself, so the loader's and the `jscript:`
//      evaluator's direct eval cannot be redirected;
//   7. timers (D1 "Timers"): callbacks live here, the host schedules numeric ids;
//   8. determinism hooks when a test seed is set: `Date.now`, argument-less `new Date()` and `Date()`
//      read the engine clock, also through `Date.prototype.constructor` (G2 S6), `Math.random` is seeded;
//   9. last, the slow-builtin guards (E R19): the size-proportional builtins are replaced by
//      non-writable, non-configurable wrappers that ask the host whether the current dispatch is over
//      budget and throw before running if it is. The loop then spins in cheap interpreter ticks and
//      QuickJS's own interrupt fires. Prelude code never calls a wrapped builtin on a hot path; it uses
//      the originals captured in step 1. The global `Proxy` (and `Proxy.revocable`) is replaced, just as
//      locked, by one that records every proxy a skin makes, so a guard never reads a size through a
//      skin's traps. The global functions in the list (`parseFloat`, `escape`, ...) keep their usual
//      writable, configurable slots, so a skin may still declare its own; the guards narrow accidental
//      paths only, and operators on large strings stay the residual of E R19.
//
// Every table keyed by a skin-controlled string is a Map or a Set (ENGINE §1 rule 6).
//
// Integrity against a skin that tampers with intrinsics the prelude does not capture (say
// `WeakMap.prototype.get`) is not a security property: the worst such a skin can do is break its own
// lookups. The boundary is the host half (membrane.js), which validates every op again.

import { MEMBRANE_CAPS, MEMBRANE_MESSAGES, OP } from './membrane.js';

/** The six host globals of D1, in their declared case. */
export const HOST_GLOBAL_NAMES = Object.freeze(['player', 'theme', 'view', 'event', 'mediacenter', 'playerApplication']);

/**
 * Global code that loads one staged script file (D1 "Script files"): a direct eval inside
 * `with(__IDS)`, so `function`/`var` declarations land on the realm global while the functions close
 * over `__IDS`. RG0 item 2 proved the mechanism in QuickJS.
 */
export const LOADER_SOURCE = 'with(__IDS){ eval(__wmp_src) }';

/**
 * The builtins E R19 guards, each with how its cost is sized before the call. Sizing never reads
 * through an operand (no ToString, no property read), so no skin code runs inside a guard; an operand
 * it cannot size makes the call unsizable, and an unsizable call asks the host every time.
 *
 * Two sizes, by what the builtin consumes. An operand the builtin turns into a string has its string
 * size: a string's length; at most 32 for a number, boolean, undefined, null or symbol; unsizable for
 * any object, function or bigint, arrays, typed arrays and proxies included, because its toString or
 * Symbol.toPrimitive can return a string of any length. (Sized by length before this rule, a one-element
 * array whose own toString returned 16 MiB let `for(;;){String.prototype.indexOf.call(a,'b')}` run
 * 2,926 ms against a 100 ms budget, and toUpperCase 7,575 ms.) A receiver the array builtins walk has its
 * element count: a real array's or a typed array's length; any other receiver, a skin's Proxy
 * included, is unsizable.
 *
 * Kinds: `str` is the String.prototype receiver's string size; `repeat` and `pad` the result's (the
 * receiver's string size times the count, or plus the target length); `arg` the first argument's string
 * size (JSON.parse's text, every RegExp entry's subject); `this` the array or typed-array receiver's
 * element count; `always` is unsizable.
 *
 * `concat` (Array.prototype.concat) is the receiver's element count plus each argument's: a primitive
 * counts 1, a real array its length, and any other object or function is unsizable, because
 * Symbol.isConcatSpreadable lets an array-like, a typed array or a function spread.
 *
 * `replace`, `replaceAll` (String.prototype) and `replaceArg` (RegExp.prototype[Symbol.replace], whose
 * subject is its first argument) are the subject's string size n, plus the pattern's string size for
 * the first two (a RegExp pattern is unsizable there; String.prototype.replace hands it to its own,
 * guarded, Symbol.replace), plus what the replacement writes: once for `replace`, up to n + 1 times for
 * the other two. A string replacement writes its length, times n + 1 when it holds a `$` (`$&`, `` $` ``
 * and `$'` each insert up to the subject); a function writes 1 (it runs JS, which the interrupt
 * reaches); a non-string primitive writes at most 32; any other object (stringified through its
 * toString) or bigint makes the call unsizable. Measured before these rules (100 ms budget):
 * `s.replaceAll('a', r)` with a 200-char s and a 2,000-char `$'` replacement ended at 574 ms, and
 * `re[Symbol.replace]('y', big)` at 431 ms.
 *
 * String "search" covers every scan of the receiver; RegExp `exec` is listed because a plain
 * `re.exec(s)` loop has the same shape as `s.indexOf`; `@name` is the well-known symbol `Symbol.name`.
 * Array `join`, `toLocaleString` and `flat`, typed-array `join` and JSON `stringify` are `always`
 * because the receiver's length says nothing about the size of what they copy (the elements, or the
 * separator). `typedarray` is %TypedArray%.prototype, which every typed array inherits from.
 *
 * G2 (DOS-4) added the trim family, `normalize`, the copying string methods, the global number and URI
 * functions and the keyed Map and Set operations (the review measured loops of trim, parseFloat,
 * encodeURIComponent, escape and Set.has over large strings at 2.5-15 s against a 100 ms budget): `compare` is the receiver's string size plus the first argument's
 * (`localeCompare`), `strconcat` the receiver's plus every argument's, and `key` a Map or Set key's cost
 * to hash, its length for a string (any other key hashes by identity or value: 0; a bigint is unsizable).
 * `global` is the global object and `number` the `Number` statics that are the same functions. An alias
 * (`trimLeft` and `trimStart`, `Number.parseFloat` and `parseFloat`) gets the same wrapper, so the two
 * stay identical.
 */
export const GUARDED_BUILTINS = Object.freeze({
  string: [['indexOf', 'str'], ['lastIndexOf', 'str'], ['includes', 'str'], ['startsWith', 'str'], ['endsWith', 'str'],
    ['search', 'str'], ['match', 'str'], ['matchAll', 'str'], ['replace', 'replace'], ['replaceAll', 'replaceAll'], ['split', 'str'],
    ['repeat', 'repeat'], ['padStart', 'pad'], ['padEnd', 'pad'], ['toLowerCase', 'str'], ['toUpperCase', 'str'],
    ['toLocaleLowerCase', 'str'], ['toLocaleUpperCase', 'str'],
    ['trim', 'str'], ['trimStart', 'str'], ['trimEnd', 'str'], ['trimLeft', 'str'], ['trimRight', 'str'], ['normalize', 'str'],
    ['localeCompare', 'compare'], ['slice', 'str'], ['substring', 'str'], ['substr', 'str'], ['at', 'str'], ['concat', 'strconcat']],
  array: [['join', 'always'], ['sort', 'this'], ['indexOf', 'this'], ['lastIndexOf', 'this'], ['includes', 'this'],
    ['slice', 'this'], ['splice', 'this'], ['concat', 'concat'], ['fill', 'this'], ['reverse', 'this'], ['flat', 'always'],
    ['toSorted', 'this'], ['toReversed', 'this'], ['toSpliced', 'this'], ['copyWithin', 'this'], ['with', 'this'],
    ['toLocaleString', 'always']],
  typedarray: [['join', 'always'], ['sort', 'this'], ['toSorted', 'this'], ['indexOf', 'this'], ['lastIndexOf', 'this'],
    ['includes', 'this'], ['reverse', 'this'], ['toReversed', 'this'], ['slice', 'this'], ['fill', 'this'],
    ['copyWithin', 'this'], ['set', 'this'], ['toLocaleString', 'this'], ['with', 'this']],
  json: [['parse', 'arg'], ['stringify', 'always']],
  regexp: [['exec', 'arg'], ['test', 'arg'], ['@match', 'arg'], ['@matchAll', 'arg'], ['@replace', 'replaceArg'], ['@search', 'arg'],
    ['@split', 'arg']],
  global: [['parseFloat', 'arg'], ['parseInt', 'arg'], ['encodeURI', 'arg'], ['encodeURIComponent', 'arg'], ['decodeURI', 'arg'],
    ['decodeURIComponent', 'arg'], ['escape', 'arg'], ['unescape', 'arg']],
  number: [['parseFloat', 'arg'], ['parseInt', 'arg']],
  map: [['get', 'key'], ['set', 'key'], ['has', 'key'], ['delete', 'key']],
  set: [['add', 'key'], ['has', 'key'], ['delete', 'key']],
});

/** Below this many characters or elements a guarded builtin runs without asking the host. */
export const GUARD_MIN_SIZE = 4096;

/** The message a guarded builtin throws once the dispatch is over budget. */
export const GUARD_MESSAGE = 'script over its time budget';

export const PRELUDE_SOURCE = String.raw`function (host, cfgText) {
'use strict';
const g = globalThis;
const OP_GET = ${OP.GET}, OP_SET = ${OP.SET}, OP_CALL = ${OP.CALL}, OP_TIMER_SET = ${OP.TIMER_SET},
  OP_TIMER_CLEAR = ${OP.TIMER_CLEAR}, OP_NOW = ${OP.NOW}, OP_GUARD = ${OP.GUARD}, OP_DIAG = ${OP.DIAG};
const MAX_STRING = ${MEMBRANE_CAPS.maxStringLength}, MAX_ARGS = ${MEMBRANE_CAPS.maxArgs};

// 1. Intrinsics, captured before any skin code runs.
const R = Reflect, O = Object;
const apply = R.apply, construct = R.construct;
const defineProperty = O.defineProperty, getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
const getOwnPropertyNames = O.getOwnPropertyNames, create = O.create, freeze = O.freeze;
const hasOwnFn = O.prototype.hasOwnProperty;
const toLowerFn = String.prototype.toLowerCase;
const replaceFn = String.prototype.replace, charCodeAtFn = String.prototype.charCodeAt;
const indexOfFn = String.prototype.indexOf, sliceFn = String.prototype.slice;
// The prelude's own Map and Set: subclasses that hold the original methods as their own, so the guards
// later put on Map.prototype and Set.prototype (step 9), or anything a skin does there, never touch the
// prelude's lookups. The explicit constructor passes one argument on, with no spread a skin could hook.
const privateCollection = (Base, names) => {
  const C = class extends Base { constructor(items) { super(items); } };
  for (let i = 0; i < names.length; i++) {
    defineProperty(C.prototype, names[i], { value: Base.prototype[names[i]], writable: false, enumerable: false, configurable: false });
  }
  return C;
};
const SafeMap = privateCollection(Map, ['get', 'set', 'has', 'delete']), SafeSet = privateCollection(Set, ['add', 'has', 'delete']);
const SafeWeakMap = WeakMap, SafeProxy = Proxy;
// A proxy's target: frozen, empty and without a prototype, so a default trap reaches nothing a skin can change.
const sealedTarget = () => freeze(create(null));
const proxyRevocable = Proxy.revocable, bindFn = Function.prototype.bind;
// The guards' proxy record is called through these, so a skin that replaces WeakSet.prototype.has
// cannot make a proxy look like a plain array again.
const SafeWeakSet = WeakSet, weakSetAdd = WeakSet.prototype.add, weakSetHas = WeakSet.prototype.has;
const RealFunction = Function, RealError = Error, RealTypeError = TypeError;
const RealRangeError = RangeError, RealSyntaxError = SyntaxError;
const RealDate = Date, dateToString = Date.prototype.toString;
const jsonParse = JSON.parse;
const isFiniteNumber = Number.isFinite;
const imul = Math.imul;
const isArray = Array.isArray;
const TypedArrayProto = O.getPrototypeOf(Uint8Array.prototype);
// The %TypedArray% brand check and length, as getters: the tag getter answers undefined for anything
// that is not a typed array (a DataView included) instead of throwing.
const typedTagFn = getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag).get;
const typedLengthFn = getOwnPropertyDescriptor(TypedArrayProto, 'length').get;
const NO_ARGS = [];
const hasOwn = (o, k) => apply(hasOwnFn, o, [k]);
// Every identifier a handler names passes through the has traps below, so lowercasing is cached
// (capped: a skin computing millions of distinct keys only loses the cache).
const lowerCache = new SafeMap();
const lower = (s) => {
  let l = lowerCache.get(s);
  if (l === undefined) {
    l = apply(toLowerFn, s, NO_ARGS);
    if (lowerCache.size < 8192) lowerCache.set(s, l);
  }
  return l;
};
const isReserved = (k) => k === 'eval' || (k[0] === '_' && k[1] === '_' && k[2] === 'w' && k[3] === 'm' && k[4] === 'p');
const cfg = jsonParse(cfgText);

const membraneError = (key) => new RealError(key);
const REVOKED = ${JSON.stringify(MEMBRANE_MESSAGES.handle)};
const TOO_LONG = ${JSON.stringify(MEMBRANE_MESSAGES.string)};
const TOO_MANY = ${JSON.stringify(MEMBRANE_MESSAGES.args)};

// 3. Handles and their proxies.
const METHOD = create(null);                 // what the host returns for a {method: true} member
const memberSets = new SafeMap();            // class -> Set of lowercased members
for (const pair of cfg.classMembers) memberSets.set(pair[0], new SafeSet(pair[1]));
const classOfHandle = new SafeMap();         // handle -> member Set, or null when the class is unknown
const records = new SafeMap();               // handle -> { proxy, state }
const handleOf = new SafeWeakMap();          // proxy -> handle, so only real proxies are sent as handles

// A handle goes to the host as a null-prototype box, so reading it host-side runs no skin code.
function box(h) {
  const b = create(null);
  b.__h = h;
  return b;
}
// Realm -> host. Only primitives and real proxies cross; any other object or function goes as undefined.
function toWire(v) {
  switch (typeof v) {
    case 'undefined':
    case 'boolean':
      return v;
    case 'number':
      return isFiniteNumber(v) ? v : null;
    case 'string':
      if (v.length > MAX_STRING) throw new RealRangeError(TOO_LONG);
      return v;
    case 'object': {
      if (v === null) return null;
      const h = handleOf.get(v);
      return h === undefined ? undefined : box(h);
    }
    default:
      return undefined;
  }
}
// Host -> realm. A box becomes the cached proxy of its handle.
function fromWire(v) {
  if (typeof v !== 'object' || v === null || v === METHOD) return v === METHOD ? undefined : v;
  const h = v.__h;
  return typeof h === 'number' ? proxyFor(h) : undefined;
}
function callHost(h, key, args) {
  const n = args.length;
  if (n > MAX_ARGS) throw new RealRangeError(TOO_MANY);
  const list = [OP_CALL, h, key];
  for (let i = 0; i < n; i++) list[3 + i] = toWire(args[i]);
  return fromWire(apply(host, undefined, list));
}
// One function per (handle, member), cached so bEq.moveTo === bEq.moveTo. It closes over the
// handle number only, never the proxy, so a dropped proxy is freed by reference counting.
function methodFor(state, key) {
  let f = state.methods.get(key);
  if (f === undefined) {
    const h = state.h;
    f = { method() { return callHost(h, key, arguments); } }.method;
    state.methods.set(key, f);
  }
  return f;
}
// Null-prototype and frozen (G2 F4): a trap the handler lacks is never looked up on Object.prototype,
// where a skin could plant a function that receives the handler as 'this' and rewires it.
function traps(state) {
  return freeze({
    __proto__: null,
    has(_t, k) {
      const m = state.members;
      return typeof k === 'string' && m !== null && k.length <= MAX_STRING && !isReserved(k) && m.has(lower(k));
    },
    get(_t, k) {
      if (typeof k !== 'string') return undefined;         // Symbol.unscopables and friends
      if (state.revoked) throw membraneError(REVOKED);
      if (k.length > MAX_STRING) throw new RealRangeError(TOO_LONG);
      const key = lower(k);
      const v = host(OP_GET, state.h, key);
      return v === METHOD ? methodFor(state, key) : fromWire(v);
    },
    set(_t, k, v) {
      if (typeof k !== 'string') return true;
      if (state.revoked) throw membraneError(REVOKED);
      if (k.length > MAX_STRING) throw new RealRangeError(TOO_LONG);
      host(OP_SET, state.h, lower(k), toWire(v));
      return true;
    },
  });
}
function proxyFor(h) {
  const rec = records.get(h);
  if (rec !== undefined) return rec.proxy;
  const m = classOfHandle.get(h);
  const state = { h, members: m === undefined ? null : m, revoked: false, methods: new SafeMap() };
  const proxy = new SafeProxy(sealedTarget(), traps(state));
  records.set(h, { proxy, state });
  handleOf.set(proxy, h);
  return proxy;
}
function revoke(h) {
  const rec = records.get(h);
  if (rec !== undefined) {
    rec.state.revoked = true;
    records.delete(h);
  }
  classOfHandle.delete(h);
}

// 2. Ids.
const hostNames = new SafeSet(cfg.hostNames);
let byExact = new SafeMap();                 // id -> handle
let byLower = new SafeMap();                 // lowercased id -> handle
const idWritesNoted = new SafeSet();          // lowercased ids already reported as written
const ids = new SafeProxy(sealedTarget(), freeze({
  __proto__: null,
  has(_t, k) {
    if (typeof k !== 'string' || k.length > MAX_STRING || isReserved(k) || hostNames.has(k)) return false;
    if (byExact.has(k)) return true;
    return byLower.has(lower(k)) && !hasOwn(g, k);
  },
  get(_t, k) {
    if (typeof k !== 'string' || k.length > MAX_STRING) return undefined;
    let h = byExact.get(k);
    if (h === undefined) h = byLower.get(lower(k));
    return h === undefined ? undefined : proxyFor(h);
  },
  // U-31: ids beat script globals, so an assignment to a bare id name lands here and goes nowhere. It is
  // reported once per id whatever the case it was written in, and only for an id: __IDS is readable,
  // and a loop over made-up keys used to send the host a diagnostic for each (G2 DOS-7).
  set(_t, k) {
    if (typeof k !== 'string' || k.length > MAX_STRING) return true;
    const lk = lower(k);
    if (byLower.has(lk) && !idWritesNoted.has(lk)) {
      idWritesNoted.add(lk);
      host(OP_DIAG, 'id-write', k);
    }
    return true;
  },
}));
function setIds(text) {
  const list = jsonParse(text);
  const exact = new SafeMap(), low = new SafeMap();
  for (let i = 0; i < list.length; i++) {
    const id = list[i][0], h = list[i][1], cls = list[i][2];
    exact.set(id, h);
    low.set(lower(id), h);                   // last declaration wins, as the builder scopes ids (D5)
    const m = memberSets.get(cls);
    const members = m === undefined ? null : m;
    classOfHandle.set(h, members);
    const rec = records.get(h);
    if (rec !== undefined) rec.state.members = members;
  }
  byExact = exact;
  byLower = low;
}

// 4. Host globals.
let currentEvent = 0;
let eventMembers = null;
for (const triple of cfg.hostGlobals) {
  const name = triple[0], h = triple[1], cls = triple[2];
  const m = cls === null ? undefined : memberSets.get(cls);
  classOfHandle.set(h, m === undefined ? null : m);
  if (name === 'event') {
    eventMembers = m === undefined ? null : m;
    defineProperty(g, 'event', {
      configurable: true,
      enumerable: false,
      get() { return proxyFor(currentEvent !== 0 ? currentEvent : h); },
      set(v) { defineProperty(g, 'event', { value: v, writable: true, enumerable: true, configurable: true }); },
    });
  } else {
    defineProperty(g, name, { value: proxyFor(h), writable: true, enumerable: false, configurable: true });
  }
}

// 5. The #132 constants, before any skin script, whether or not the skin lists #132.
for (const pair of cfg.constants) {
  defineProperty(g, pair[0], { value: pair[1], writable: true, enumerable: true, configurable: true });
}

// 6. Locked internals.
const lock = (name, value) => defineProperty(g, name, { value, writable: false, enumerable: false, configurable: false });
lock('__IDS', ids);
lock('__wmp_badAssign', { __wmp_badAssign() { throw new RealTypeError('Cannot assign to a function result'); } }.__wmp_badAssign);
let pendingSource;
defineProperty(g, '__wmp_src', {
  get() { const s = pendingSource; pendingSource = undefined; return s; },
  enumerable: false,
  configurable: false,
});
lock('eval', g.eval);

// The evaluators. The Function constructor makes sloppy functions in global scope, which is what
// both need: 'with' is a syntax error in this strict closure.
const exprFn = new RealFunction('__wmp_src', 'with(__IDS){with(this){return eval(__wmp_src);}}');
const handlers = new SafeMap();              // compiled handler id -> function
const LABEL = /^\s*[A-Za-z_$][\w$]*\s*:/;
function compileBody(params, body) {
  const list = [];
  for (let i = 0; i < params.length; i++) list[i] = params[i];
  list[params.length] = 'with(__IDS){with(this){' + body + '\n}}';
  return construct(RealFunction, list);
}
// D1 "Handler text": compile as-is; only on a syntax error strip one leading 'identifier:' and retry.
function compileHandler(id, paramsText, body) {
  const params = jsonParse(paramsText);
  let fn;
  try {
    fn = compileBody(params, body);
  } catch (e) {
    if (!(e instanceof RealSyntaxError)) throw e;
    const stripped = apply(replaceFn, body, [LABEL, '']);
    if (stripped === body) throw e;
    try {
      fn = compileBody(params, stripped);
    } catch (_e2) {
      throw e;
    }
  }
  handlers.set(id, fn);
}
function runHandler(id, el, ev, revokeEv, ...params) {
  const fn = handlers.get(id);
  const self = proxyFor(el);
  const args = [];
  for (let i = 0; i < params.length; i++) args[i] = fromWire(params[i]);
  const prev = currentEvent;
  if (ev !== 0) {
    if (!classOfHandle.has(ev)) classOfHandle.set(ev, eventMembers);
    currentEvent = ev;
  }
  try {
    apply(fn, self, args);
  } finally {
    currentEvent = prev;
    if (revokeEv) revoke(ev);
  }
}
function evalExpr(el, src) {
  return toWire(apply(exprFn, proxyFor(el), [src]));
}

// 7. Timers.
const timers = new SafeMap();                // id -> { fn, code, args, repeat }
let nextTimer = 1;
function addTimer(cb, ms, rest, repeat) {
  const fn = typeof cb === 'function' ? cb : null;
  const code = fn === null ? '' + cb : '';
  let delay = +ms;
  if (!isFiniteNumber(delay) || delay < 0) delay = 0;
  const id = nextTimer++;
  if (host(OP_TIMER_SET, id, delay, repeat) !== true) return 0;
  timers.set(id, { fn, code, args: rest, repeat });
  return id;
}
function clearTimer(id) {
  const n = +id;
  if (timers.has(n)) {
    timers.delete(n);
    host(OP_TIMER_CLEAR, n);
  }
}
const timerApi = {
  setTimeout(cb, ms, ...rest) { return addTimer(cb, ms, rest, false); },
  setInterval(cb, ms, ...rest) { return addTimer(cb, ms, rest, true); },
  clearTimeout(id) { clearTimer(id); },
  clearInterval(id) { clearTimer(id); },
};
for (const name of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']) {
  defineProperty(g, name, { value: timerApi[name], writable: true, enumerable: false, configurable: true });
}
function fireTimer(id) {
  const t = timers.get(id);
  if (t === undefined) return;
  if (!t.repeat) timers.delete(id);
  let fn = t.fn;
  if (fn === null) {
    fn = new RealFunction('with(__IDS){' + t.code + '\n}');
    if (t.repeat) t.fn = fn;
  }
  apply(fn, undefined, t.args);
}

// Globals for the host: calls, primitive reads, and the loader's collision check.
function callGlobal(name, ...args) {
  const d = isReserved(name) ? undefined : getOwnPropertyDescriptor(g, name);
  const f = d !== undefined && hasOwn(d, 'value') ? d.value : undefined;
  if (typeof f !== 'function') throw new RealTypeError(name + ' is not a global function');
  const list = [];
  for (let i = 0; i < args.length; i++) list[i] = fromWire(args[i]);
  return toWire(apply(f, undefined, list));
}
function readGlobal(name) {
  if (isReserved(name)) return undefined;
  const d = getOwnPropertyDescriptor(g, name);
  if (d === undefined || !hasOwn(d, 'value')) return undefined;
  const v = d.value;
  if (typeof v === 'string') return v.length > MAX_STRING ? undefined : v;
  return typeof v === 'object' || typeof v === 'function' ? undefined : toWire(v);
}
let globalsBefore = null;
function snapshotGlobals() {
  const names = getOwnPropertyNames(g);
  globalsBefore = new SafeSet();
  for (let i = 0; i < names.length; i++) globalsBefore.add(names[i]);
}
// Names a script declared at top level that exactly equal an id: unreachable by bare name, since
// ids beat script globals (U-31). The host logs each one.
function collisions() {
  const names = getOwnPropertyNames(g);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (globalsBefore !== null && !globalsBefore.has(n) && byExact.has(n)) out[out.length] = n;
  }
  globalsBefore = null;
  return out;
}

// 8. Determinism hooks.
if (cfg.seed !== null) {
  const engineNow = () => {
    const t = host(OP_NOW);
    return typeof t === 'number' ? t : 0;
  };
  const FakeDate = new SafeProxy(RealDate, freeze({
    __proto__: null,
    construct(t, a, nt) { return construct(t, a.length === 0 ? [engineNow()] : a, nt === FakeDate ? t : nt); },
    apply() { return apply(dateToString, construct(RealDate, [engineNow()]), []); },
  }));
  defineProperty(RealDate, 'now', { value: { now() { return engineNow(); } }.now, writable: true, enumerable: false, configurable: true });
  defineProperty(g, 'Date', { value: FakeDate, writable: true, enumerable: false, configurable: true });
  // The Date a date instance leads back to is the engine clock too, so test mode is not observable (G2 S6).
  defineProperty(RealDate.prototype, 'constructor', { value: FakeDate, writable: true, enumerable: false, configurable: true });
  // FNV-1a of the seed into mulberry32: tiny, and the same sequence on every host.
  const seed = '' + cfg.seed;
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) s = imul(s ^ apply(charCodeAtFn, seed, [i]), 16777619);
  let state = s >>> 0;
  const random = { random() {
    state = (state + 0x6D2B79F5) | 0;
    let t = state;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  } }.random;
  defineProperty(Math, 'random', { value: random, writable: true, enumerable: false, configurable: true });
}

// 9. Slow-builtin guards (E R19), installed last. A call whose input is smaller than GUARD_MIN
// units costs microseconds, and QuickJS's own interrupt poll bounds a loop of those; only a larger
// (or unsizable) call pays for the host crossing.
const GUARD_MIN = ${GUARD_MIN_SIZE};
// Skin proxies. A proxy's traps run skin code, so a length read through one could answer the guard
// small and the builtin large. The skin's Proxy makes real proxies and records each one, and the
// sizing below treats a recorded proxy as unsizable without touching it. The prelude's own proxies
// are not recorded: none of them wraps an array.
const skinProxies = new SafeWeakSet();
const isSkinProxy = (v) => apply(weakSetHas, skinProxies, [v]);
const recordProxy = (p) => {
  apply(weakSetAdd, skinProxies, [p]);
  return p;
};
function makeProxy(target, handler) {
  if (new.target === undefined) throw new RealTypeError("Constructor Proxy requires 'new'");
  return recordProxy(new SafeProxy(target, handler));
}
// Bound, so that like the native constructor it has no 'prototype' property.
const SkinProxy = apply(bindFn, makeProxy, [undefined]);
defineProperty(SkinProxy, 'name', { value: 'Proxy', configurable: true });
defineProperty(SkinProxy, 'revocable', {
  value: { revocable(target, handler) {
    const r = apply(proxyRevocable, SafeProxy, [target, handler]);
    recordProxy(r.proxy);
    return r;
  } }.revocable,
  writable: false,
  enumerable: false,
  configurable: false,
});
lock('Proxy', SkinProxy);

// An operand the builtin turns into a string: a string's length, at most 32 for the other primitives
// (a bigint's digits are unbounded), and any object or function is unsizable, since its toString or
// Symbol.toPrimitive may return anything. Decided on typeof alone: nothing is read through v.
const stringSizeOf = (v) => {
  const t = typeof v;
  if (t === 'string') return v.length;
  return v === null || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'symbol' ? 32 : Infinity;
};
// The array tables' receiver: a string's, a real array's or a typed array's length; anything else is
// unsizable. The proxy test comes before isArray, which reads through a proxy to its target (and
// throws on a revoked one).
const sizeOf = (v) => {
  if (typeof v === 'string') return v.length;
  if (typeof v !== 'object' || v === null || isSkinProxy(v)) return Infinity;
  if (isArray(v)) return v.length;
  return apply(typedTagFn, v, NO_ARGS) !== undefined ? apply(typedLengthFn, v, NO_ARGS) : Infinity;
};
// One Array.prototype.concat argument: a primitive is one element, a real array its length, and any
// other object or function may spread through Symbol.isConcatSpreadable with a length of its choosing.
const spreadSize = (a) => {
  if (typeof a === 'function') return Infinity;
  if (typeof a !== 'object' || a === null) return 1;
  return isSkinProxy(a) || !isArray(a) ? Infinity : a.length;
};
// A Map or Set key: hashing a string reads all of it; any other key hashes by identity or value, except
// a bigint, whose digits are unbounded.
const keySizeOf = (k) => (typeof k === 'string' ? k.length : typeof k === 'bigint' ? Infinity : 0);
// What one match of a replacement writes, n being the subject's length. The '$' scan only runs on a
// replacement already under GUARD_MIN, so the guard itself never scans a long string.
const replacementSize = (r, n) => {
  if (typeof r === 'string') return r.length < GUARD_MIN && apply(indexOfFn, r, ['$']) >= 0 ? r.length * (n + 1) : r.length;
  if (typeof r === 'function' || typeof r === 'symbol') return 1;
  if ((typeof r === 'object' && r !== null) || typeof r === 'bigint') return Infinity;
  return 32;
};
function guarded(orig, kind) {
  const w = { guarded() {
    let size;
    if (kind === 'str') size = stringSizeOf(this);
    else if (kind === 'this') size = sizeOf(this);
    else if (kind === 'repeat') size = typeof arguments[0] === 'number' ? stringSizeOf(this) * arguments[0] : Infinity;
    else if (kind === 'pad') size = typeof arguments[0] === 'number' ? arguments[0] + stringSizeOf(this) : Infinity;
    else if (kind === 'concat') {
      size = sizeOf(this);
      for (let i = 0; i < arguments.length && size < GUARD_MIN; i++) size += spreadSize(arguments[i]);
    } else if (kind === 'replace' || kind === 'replaceAll') {
      const n = stringSizeOf(this), m = replacementSize(arguments[1], n);
      size = n + stringSizeOf(arguments[0]) + (kind === 'replace' ? m : (n + 1) * m);
    } else if (kind === 'replaceArg') {
      const n = stringSizeOf(arguments[0]);
      size = n + (n + 1) * replacementSize(arguments[1], n);
    } else if (kind === 'arg') size = stringSizeOf(arguments[0]);
    else if (kind === 'key') size = keySizeOf(arguments[0]);
    else if (kind === 'compare') size = stringSizeOf(this) + stringSizeOf(arguments[0]);
    else if (kind === 'strconcat') {
      size = stringSizeOf(this);
      for (let i = 0; i < arguments.length && size < GUARD_MIN; i++) size += stringSizeOf(arguments[i]);
    } else size = Infinity;
    if (!(size < GUARD_MIN) && host(OP_GUARD) === true) throw new RealRangeError(${JSON.stringify(GUARD_MESSAGE)});
    return apply(orig, this, arguments);
  } }.guarded;
  defineProperty(w, 'name', { value: orig.name, configurable: true });
  defineProperty(w, 'length', { value: orig.length, configurable: true });
  return w;
}
// One wrapper per original function, so aliases (trimLeft and trimStart, Number.parseFloat and the
// global parseFloat) stay the same function.
const wrappers = new SafeMap();
// 'locked' slots are made non-writable and non-configurable; the others keep their attributes.
function guard(target, table, locked) {
  for (let i = 0; i < table.length; i++) {
    const key = table[i][0], kind = table[i][1];
    const k = typeof key === 'string' && key[0] === '@' ? Symbol[apply(sliceFn, key, [1])] : key;
    const d = getOwnPropertyDescriptor(target, k);
    if (d === undefined || typeof d.value !== 'function') continue;
    let w = wrappers.get(d.value);
    if (w === undefined) {
      w = guarded(d.value, kind);
      wrappers.set(d.value, w);
    }
    defineProperty(target, k, locked
      ? { value: w, writable: false, enumerable: false, configurable: false }
      : { value: w, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
  }
}
const G = ${JSON.stringify(GUARDED_BUILTINS)};
guard(String.prototype, G.string, true);
guard(Array.prototype, G.array, true);
guard(TypedArrayProto, G.typedarray, true);
guard(JSON, G.json, true);
guard(RegExp.prototype, G.regexp, true);
guard(Map.prototype, G.map, true);
guard(Set.prototype, G.set, true);
guard(g, G.global, false);
guard(Number, G.number, false);

return {
  m: METHOD,
  setIds,
  compileHandler,
  runHandler,
  evalExpr,
  fireTimer,
  callGlobal,
  readGlobal,
  revoke,
  snapshotGlobals,
  collisions,
  stage(src) { pendingSource = src; },
};
}`;
