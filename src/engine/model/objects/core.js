// @ts-check
// The machinery every host object shares: the handle registry, the change hub, argument coercion,
// and `makeObject`, which turns a class of the schema plus a table of handlers into a `HostObject`.
//
// `makeObject` is where the schema is enforced, so no handler has to repeat it:
//   - the member must exist in the class (case-insensitively): an unknown get returns undefined, a set
//     is dropped, a call returns undefined, and the ledger records `unknown-member` (E D1, membrane);
//   - a method reads as `{ method: true }` and only `call` runs it; a property is never callable;
//   - a `stub` member returns its type-correct inert value and is ledgered, whatever a handler says;
//   - a `denied` member is refused by the `deny-log` policy and ledgered once;
//   - a read-only member drops writes.
// Handlers therefore only implement the `live` and `emulated` members, and only the behaviour.
//
// The membrane is copy-only: what leaves an object is a Wire value (undefined, null, boolean, finite
// number, string, or a `{ __h }` handle). `toWire` is the last line of defence for that.

import { coerce } from '../../wms/values.js';
import { SCHEMA, apiName, lookupMember } from '../schema.js';

/** @typedef {import('../../contracts').Wire} Wire */
/** @typedef {import('../../contracts').HostObject} HostObject */
/** @typedef {import('../../contracts').MemberSpec} MemberSpec */
/** @typedef {import('../../contracts').Origin} Origin */
/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').Unsubscribe} Unsubscribe */

/** E D1 membrane: at most 16 arguments cross. */
export const MAX_ARGS = 16;

/** What a handler implements for one member. Only the parts the member's kind uses. */
/**
 * @typedef {{
 *   get?: () => unknown,
 *   set?: (v: Wire, origin: Origin) => void,
 *   call?: (args: Wire[], ctx: { gesture: boolean }) => unknown,
 * }} Handler
 */

/**
 * A HostObject plus the parts the graph needs and the contract does not name: its handle, and quiet
 * reads that never touch the ledger (a binding reads every frame; it must not count a stub per frame).
 * @typedef {HostObject & {
 *   handle: number,
 *   readonly element: ElementModel | null,
 *   peek(member: string): Wire | { method: true },
 *   peekCall(member: string, args: Wire[]): Wire,
 * }} GraphObject
 */

/** @typedef {{ get(name: string): Wire, set(name: string, v: Wire, origin: Origin): void }} Fallback */
/** @typedef {{ get(spec: MemberSpec): unknown, set(spec: MemberSpec, v: Wire, origin: Origin): void }} AttrAccess */

// ---- wire values and arguments --------------------------------------------------------------------

/** @param {unknown} v @returns {Wire | { method: true }} */
export function toWire(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'string') return /** @type {Wire} */ (v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'object') {
    const o = /** @type {{ __h?: unknown, method?: unknown }} */ (v);
    if (typeof o.__h === 'number') return /** @type {{ __h: number }} */ (v);
    if (o.method === true) return { method: true };
  }
  return undefined;
}

/** @param {unknown} v @returns {v is { __h: number }} */
export const isHandle = (v) => typeof v === 'object' && v !== null && typeof (/** @type {any} */ (v)).__h === 'number';

/** A finite number from a number or numeric text, else `fallback`. @param {unknown} v @param {number} fallback */
export function num(v, fallback) {
  const n = /** @type {number} */ (coerce('float', v, NaN));
  return Number.isNaN(n) ? fallback : n;
}

/** An integer (round half even, as the coercion does), else `fallback`. @param {unknown} v @param {number} fallback */
export function int(v, fallback) {
  const n = /** @type {number} */ (coerce('int', v, NaN));
  return Number.isNaN(n) ? fallback : n;
}

/** `true`, `false`, 1, 0 in any case; anything else is `fallback`. @param {unknown} v @param {boolean} fallback */
export const bool = (v, fallback) => /** @type {boolean} */ (coerce('bool', v, fallback));

/** JScript's `String(v)` for a primitive; an object handle has no useful text. @param {unknown} v */
export const text = (v) => (typeof v === 'object' && v !== null ? '' : String(v));

/** @param {unknown} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, /** @type {number} */ (v)));

/** A lowercased, bounded name for ledger keys; skins choose these. @param {unknown} s */
export const keyOf = (s) => String(s).toLowerCase().slice(0, 64);

// ---- change hub -----------------------------------------------------------------------------------

/**
 * Named channels with listeners. A listener that throws must not stop the others (they are the
 * binding engine, and a media notification would otherwise die at the first bad one).
 * @param {(message: string) => void} warn
 */
export function createHub(warn) {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  return {
    /** @param {string} channel @param {() => void} cb @returns {Unsubscribe} */
    on(channel, cb) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(cb);
      return () => { set.delete(cb); };
    },
    /** @param {string} channel */
    emit(channel) {
      const set = listeners.get(channel);
      if (!set || set.size === 0) return;
      for (const cb of [...set]) {
        if (!set.has(cb)) continue;
        try { cb(); } catch (e) { warn(`change listener on ${channel}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    },
    /** @param {string} channel */
    has: (channel) => (listeners.get(channel)?.size ?? 0) > 0,
    clear() { listeners.clear(); },
  };
}

// ---- the object factory ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   readonly ledger: import('../../contracts').Ledger,
 *   readonly policy: import('../policy.js').Policies,
 *   readonly inert: () => { __h: number },
 *   disposed: boolean,
 *   register(obj: GraphObject, handle?: number): void,
 * }} ObjectContext
 */

/**
 * The inert value of a stub member: its `stubValue`, else the zero of its type.
 * @param {ObjectContext} ctx @param {MemberSpec} spec @returns {Wire}
 */
function stubReturn(ctx, spec) {
  if (spec.stubValue !== undefined) return spec.stubValue;
  switch (spec.type) {
    case 'number': return 0;
    case 'string': return '';
    case 'bool': return false;
    case 'object': return ctx.inert();
    default: return undefined;
  }
}

/**
 * @param {ObjectContext} ctx
 * @param {string} className a key of SCHEMA
 * @param {Record<string, Handler>} [handlers] keyed by member name, any case
 * @param {{ element?: ElementModel, fallback?: Fallback, attrs?: AttrAccess, handle?: number }} [opts]
 *   `attrs` serves every live property the table does not name (element attributes); `fallback`
 *   serves names that are not in the class at all (mediacenter's session-only keys)
 * @returns {GraphObject}
 */
export function makeObject(ctx, className, handlers = {}, opts = {}) {
  const schema = SCHEMA.get(className);
  if (!schema) throw new Error(`unknown class ${className}`);
  /** @type {Map<string, Handler>} */
  const table = new Map(Object.entries(handlers).map(([name, h]) => [name.toLowerCase(), h]));
  // A handler for a name the class does not have would never run: a typo that fails silently.
  for (const key of table.keys()) if (!schema.has(key)) throw new Error(`class ${className} has no member ${key}`);
  /** @type {Map<string, Wire>} values a script wrote to a stub, so it reads back what it wrote */
  const held = new Map();
  const { ledger, policy } = ctx;

  /** @param {string} member @param {string} why */
  const unknown = (member, why) => { ledger.record(apiName(className, keyOf(member)), 'unknown-member', why); };

  /** @param {MemberSpec} spec @param {string} key @param {boolean} quiet @returns {Wire} */
  function value(spec, key, quiet) {
    if (spec.impl === 'stub') {
      if (!quiet) ledger.record(apiName(className, spec.name), 'stub');
      return held.has(key) ? held.get(key) : stubReturn(ctx, spec);
    }
    const h = table.get(key);
    if (h?.get) return /** @type {Wire} */ (toWire(h.get()));
    if (opts.attrs) return /** @type {Wire} */ (toWire(opts.attrs.get(spec)));
    return undefined;
  }

  /** @param {string} member @param {boolean} quiet @returns {Wire | { method: true }} */
  function read(member, quiet) {
    if (ctx.disposed) return undefined;
    const key = String(member).toLowerCase();
    const spec = lookupMember(className, key);
    if (!spec) {
      if (opts.fallback) return opts.fallback.get(String(member));
      unknown(member, 'read');
      return undefined;
    }
    if (spec.kind === 'method') return { method: true };
    return value(spec, key, quiet);
  }

  /** @param {string} member @param {Wire[]} args @param {{ gesture: boolean }} cctx @param {boolean} quiet @returns {Wire} */
  function invoke(member, args, cctx, quiet) {
    if (ctx.disposed) return undefined;
    const key = String(member).toLowerCase();
    const spec = lookupMember(className, key);
    if (!spec) { unknown(member, 'call'); return undefined; }
    if (spec.kind !== 'method') { unknown(member, 'not a method'); return undefined; }
    const a = Array.isArray(args) ? args.slice(0, MAX_ARGS) : [];
    if (spec.impl === 'denied') {
      policy.denied(apiName(className, spec.name), a.length ? text(a[0]).slice(0, 120) : '');
      return stubReturn(ctx, spec);
    }
    if (spec.impl === 'stub') {
      if (!quiet) ledger.record(apiName(className, spec.name), 'stub');
      return stubReturn(ctx, spec);
    }
    const h = table.get(key);
    return h?.call ? /** @type {Wire} */ (toWire(h.call(a, cctx ?? { gesture: false }))) : undefined;
  }

  /** @type {GraphObject} */
  const obj = {
    className,
    handle: 0,
    element: opts.element ?? null,

    get: (member) => read(member, false),
    peek: (member) => read(member, true),

    set(member, v, origin) {
      if (ctx.disposed) return;
      const key = String(member).toLowerCase();
      const spec = lookupMember(className, key);
      if (!spec) {
        if (opts.fallback) opts.fallback.set(String(member), v, origin);
        else unknown(member, 'write');
        return;
      }
      if (spec.kind === 'method') { unknown(member, 'assignment to a method'); return; }
      if (spec.access === 'r') return;                       // a read-only member drops the write
      if (spec.impl === 'denied') { policy.denied(apiName(className, spec.name), text(v).slice(0, 120)); return; }
      if (spec.impl === 'stub') {
        ledger.record(apiName(className, spec.name), 'stub');
        const prev = held.has(key) ? held.get(key) : stubReturn(ctx, spec);
        if (spec.type === 'number') held.set(key, /** @type {number} */ (coerce('float', v, prev)));
        else if (spec.type === 'bool') held.set(key, /** @type {boolean} */ (coerce('bool', v, prev)));
        else if (spec.type === 'string') held.set(key, /** @type {string} */ (coerce('string', v, prev)));
        return;
      }
      const h = table.get(key);
      if (h?.set) h.set(v, origin);
      else if (opts.attrs) opts.attrs.set(spec, v, origin);
    },

    call: (member, args, cctx) => invoke(member, args, cctx, false),
    peekCall: (member, args) => invoke(member, args, { gesture: false }, true),
  };
  ctx.register(obj, opts.handle);
  return obj;
}
