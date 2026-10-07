// @ts-check
// The membrane of ENGINE D1: the one place where values cross between the QuickJS realm and the host.
// It is copy-only. `undefined`, `null`, booleans, finite numbers, strings of at most 64 KiB and handles
// `{__h: n}` cross, in either direction; no host object, function, array or exception ever does.
//
// Two halves. The realm half lives in `prelude.js` (it turns handles into cached proxies and refuses to
// send anything else). This file is the host half, and it is the security boundary: it assumes the
// realm half may have been tampered with by skin code and validates every operation again.
//   - The single native function the realm gets (`createMembrane().native`) takes an op code and plain
//     values. Element and object ops (`get`, `set`, `call`) are forwarded to the `HostDispatcher` only
//     for a handle this realm was given and that is not revoked, with a string key, at most 16
//     arguments, and only wire values. Timer, clock, budget-guard and diagnostic ops are answered by
//     hooks the realm supplies; the dispatcher never sees them.
//   - A host exception becomes a realm `Error` with a fixed message. Its text is logged host-side.
//   - Handles: the table holds every handle issued to this realm (host globals, ids, event handles,
//     every handle a dispatcher result carried). An event handle is revoked when its dispatch ends;
//     `revokeAll` runs when the realm goes away.
//
// Non-finite numbers cross as `null` in both directions, so an attribute write of `NaN` reaches
// `ElementModel.set` as an invalid value and keeps the previous one (U-20).
//
// Nothing here copies a realm string before measuring it, and nothing reads a realm object except the
// one data property of a handle box, so no host op ever runs skin code (G2 F1, F6).
//
// No QuickJS import: the context arrives as a parameter, so the validation half is testable without
// WASM.

/** @typedef {import('../contracts').Wire} Wire */
/** @typedef {import('../contracts').HostDispatcher} HostDispatcher */
/** @typedef {import('../contracts').Log} Log */

export const MEMBRANE_CAPS = Object.freeze({ maxStringLength: 65536, maxArgs: 16 });

/** Op codes of the one native function. The realm half reads the same table (prelude.js). */
export const OP = Object.freeze({ GET: 0, SET: 1, CALL: 2, TIMER_SET: 3, TIMER_CLEAR: 4, NOW: 5, GUARD: 6, DIAG: 7 });

/** The fixed messages a rejected op throws in the realm. Host error text never crosses. */
export const MEMBRANE_MESSAGES = Object.freeze({
  handle: 'membrane: unknown or revoked handle',
  string: 'membrane: string longer than 65536 characters',
  args: 'membrane: more than 16 arguments',
  value: 'membrane: value cannot cross',
  op: 'membrane: bad operation',
  host: 'host error',
});

/** @typedef {keyof typeof MEMBRANE_MESSAGES} MembraneReason */
/** @typedef {{ ok: true, value: Wire } | { ok: false, reason: MembraneReason }} WireCheck */

/** @param {unknown} h @returns {h is number} */
export const isHandleNumber = (h) => typeof h === 'number' && Number.isSafeInteger(h) && h > 0;

/** @param {unknown} v @returns {v is { __h: number }} */
const isBox = (v) => typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, '__h') && isHandleNumber(/** @type {any} */ (v).__h);

/**
 * Check one host-side value against the wire types. Non-finite numbers become `null`; a handle comes
 * back as a fresh `{__h}` (any other own property of the input is dropped).
 * @param {unknown} v
 * @returns {WireCheck}
 */
export function checkWire(v) {
  switch (typeof v) {
    case 'undefined':
    case 'boolean':
      return { ok: true, value: v };
    case 'number':
      return { ok: true, value: Number.isFinite(v) ? v : null };
    case 'string':
      return v.length > MEMBRANE_CAPS.maxStringLength ? { ok: false, reason: 'string' } : { ok: true, value: v };
    case 'object':
      if (v === null) return { ok: true, value: null };
      if (isBox(v)) return { ok: true, value: { __h: v.__h } };
      return { ok: false, reason: 'value' };
    default:
      return { ok: false, reason: 'value' };
  }
}

/**
 * The handles one realm may use. A Set of numbers, so nothing here is keyed by a skin string.
 * @returns {{ issue(h: number): void, has(h: number): boolean, revoke(h: number): void, revokeAll(): void, readonly size: number }}
 */
export function createHandleTable() {
  /** @type {Set<number>} */
  const live = new Set();
  let closed = false;
  return {
    issue(h) {
      if (!closed && isHandleNumber(h)) live.add(h);
    },
    has: (h) => live.has(h),
    revoke(h) {
      live.delete(h);
    },
    revokeAll() {
      live.clear();
      closed = true;              // after unload nothing is ever valid again
    },
    get size() {
      return live.size;
    },
  };
}

/**
 * @typedef {Object} MembraneHooks
 * @property {(id: number, ms: number, repeat: boolean) => boolean} timerSet   false = refused
 * @property {(id: number) => void} timerClear
 * @property {() => boolean} guard          true = the current dispatch is over budget
 * @property {(code: string, detail: string) => void} diag
 * @property {() => boolean} [heapOver]     true = the realm's heap ran out: no op runs, nothing is copied in
 */

/**
 * @typedef {Object} Membrane
 * @property {(...args: any[]) => any} native   the VmFunctionImplementation of the realm's one native function
 * @property {(v: Wire) => any} toRealm         a QuickJS handle for a host value (throws a MembraneError when it cannot cross)
 * @property {(h: any) => WireCheck} fromRealm  a realm value read back as a Wire
 * @property {(sentinel: any) => void} setMethodSentinel   the realm object a `{method: true}` result is turned into
 * @property {ReturnType<typeof createHandleTable>} table
 */

/** Thrown host-side when a host value cannot be sent into the realm. */
export class MembraneError extends Error {
  /** @param {MembraneReason} reason */
  constructor(reason) {
    super(MEMBRANE_MESSAGES[reason]);
    this.name = 'MembraneError';
    /** @type {MembraneReason} */
    this.reason = reason;
  }
}

/**
 * Build the host half for one QuickJS context.
 * @param {{ ctx: any, dispatcher: HostDispatcher, hooks: MembraneHooks, log: Log, table?: ReturnType<typeof createHandleTable> }} deps
 * @returns {Membrane}
 */
export function createMembrane(deps) {
  const { ctx, dispatcher, hooks, log } = deps;
  const table = deps.table ?? createHandleTable();
  /** @type {any} */
  let methodSentinel = null;

  // Log each distinct problem once: a skin that hammers a bad op must not flood the host log. A
  // throwing log must not throw here either: the exception would surface in the realm with its text.
  /** @type {Set<string>} */
  const logged = new Set();
  /** @param {string} message @param {object} detail */
  const warnOnce = (message, detail) => {
    const key = `${message}\u0000${JSON.stringify(detail)}`;
    if (logged.has(key) || logged.size >= 1024) return;
    logged.add(key);
    try {
      log.warn(message, detail);
    } catch {
      // nothing to do: the op still answers
    }
  };

  /** @param {MembraneReason} reason */
  const fail = (reason) => ({ error: ctx.newError({ name: 'Error', message: MEMBRANE_MESSAGES[reason] }) });

  /**
   * A realm string's length, read without copying it (G2 F1): a 16 MiB key used to be decoded whole
   * into a host string before the 64 KiB test rejected it. `ctx.getLength` answers undefined for strings
   * in quickjs-emscripten 0.32, so the `length` property is read; on a string it runs no skin code.
   * @param {any} h a handle whose typeof is 'string'
   */
  const strLength = (h) => {
    const l = ctx.getProp(h, 'length');
    try {
      return ctx.typeof(l) === 'number' ? ctx.getNumber(l) : Infinity;
    } finally {
      l.dispose();
    }
  };

  /** @param {any} h @returns {WireCheck} */
  const fromRealm = (h) => {
    switch (ctx.typeof(h)) {
      case 'undefined':
        return { ok: true, value: undefined };
      case 'boolean':
        return { ok: true, value: ctx.dump(h) === true };
      case 'number': {
        const n = ctx.getNumber(h);
        return { ok: true, value: Number.isFinite(n) ? n : null };
      }
      case 'string': {
        if (strLength(h) > MEMBRANE_CAPS.maxStringLength) return { ok: false, reason: 'string' };
        const s = ctx.getString(h);
        return s.length > MEMBRANE_CAPS.maxStringLength ? { ok: false, reason: 'string' } : { ok: true, value: s };
      }
      case 'object': {
        // Only the realm half's boxes reach here (every op argument and entry result passes its toWire),
        // and a box is a null-prototype object with a plain data property `__h`. Reading that one property
        // runs no getter, trap or toJSON whatever value it holds; dumping the object did, once a skin had
        // tampered with the realm half's WeakMap, running skin code inside a host op (G2 F6).
        if (ctx.eq(h, ctx.null)) return { ok: true, value: null };
        const p = ctx.getProp(h, '__h');
        try {
          const n = ctx.typeof(p) === 'number' ? ctx.getNumber(p) : NaN;
          if (!isHandleNumber(n)) return { ok: false, reason: 'value' };
          if (!table.has(n)) return { ok: false, reason: 'handle' };
          return { ok: true, value: { __h: n } };
        } finally {
          p.dispose();
        }
      }
      default:
        return { ok: false, reason: 'value' };
    }
  };

  /** @param {Wire} v */
  const toRealm = (v) => {
    const c = checkWire(v);
    if (c.ok === false) throw new MembraneError(c.reason);
    const w = c.value;
    if (w === undefined) return ctx.undefined;
    if (w === null) return ctx.null;
    if (w === true) return ctx.true;
    if (w === false) return ctx.false;
    if (typeof w === 'number') return ctx.newNumber(w);
    if (typeof w === 'string') return ctx.newString(w);
    table.issue(w.__h);
    // A null-prototype box: setting `__h` on it cannot reach a setter a skin put on Object.prototype.
    const box = ctx.newObject(ctx.null);
    const n = ctx.newNumber(w.__h);
    ctx.setProp(box, '__h', n);
    n.dispose();
    return box;
  };

  /**
   * A dispatcher result into the realm. A value that cannot cross is a host bug: it is logged and
   * becomes `undefined`, except an over-long string, which is the skin-visible cap (a soft fault).
   * @param {unknown} v @param {boolean} allowMethod @param {string} where
   */
  const result = (v, allowMethod, where) => {
    if (allowMethod && typeof v === 'object' && v !== null && /** @type {any} */ (v).method === true && !('__h' in v)) {
      return methodSentinel ? methodSentinel.dup() : ctx.undefined;
    }
    const c = checkWire(v);
    if (c.ok === false) {
      if (c.reason === 'string') return fail('string');
      warnOnce('realm: host returned a value that cannot cross the membrane', { where });
      return ctx.undefined;
    }
    return toRealm(c.value);
  };

  /** @param {() => unknown} call @param {boolean} allowMethod @param {string} where */
  const forward = (call, allowMethod, where) => {
    let v;
    try {
      v = call();
    } catch (e) {
      warnOnce('realm: host error in a dispatcher op', { where, message: String(/** @type {any} */ (e)?.message ?? e) });
      return fail('host');
    }
    return result(v, allowMethod, where);
  };

  /** @param {any} h @returns {number} NaN unless the value is a number */
  const num = (h) => (h !== undefined && ctx.typeof(h) === 'number' ? ctx.getNumber(h) : NaN);

  /** @param {any} h @param {number} max @returns {string|null} a string of at most `max` characters, measured before it is copied */
  const str = (h, max) => {
    if (h === undefined || ctx.typeof(h) !== 'string' || strLength(h) > max) return null;
    const s = ctx.getString(h);
    return s.length > max ? null : s;
  };

  /** @param {any[]} args */
  const native = (...args) => {
    // Once the realm's heap ran out, a value copied in would be written through a NULL malloc (G2
    // DOS-1); the entry is ending as a memory fault anyway.
    if (hooks.heapOver?.()) return ctx.undefined;
    try {
      return dispatch(args);
    } catch (e) {
      // A bug on this side must not hand its message to the realm.
      warnOnce('realm: membrane op failed', { message: String(/** @type {any} */ (e)?.message ?? e) });
      return fail('host');
    }
  };

  /** @param {any[]} args */
  const dispatch = (args) => {
    const op = num(args[0]);
    switch (op) {
      case OP.GET:
      case OP.SET:
      case OP.CALL: {
        const h = num(args[1]);
        if (!isHandleNumber(h) || !table.has(h)) return fail('handle');
        const raw = str(args[2], MEMBRANE_CAPS.maxStringLength);
        if (raw === null) return fail('value');
        const key = raw.toLowerCase();     // the proxy lowercased it; a tampered prelude may not have
        const where = `${op === OP.GET ? 'get' : op === OP.SET ? 'set' : 'call'} ${key}`;
        if (op === OP.GET) {
          if (args.length !== 3) return fail('op');
          return forward(() => dispatcher.get(h, key), true, where);
        }
        if (op === OP.SET) {
          if (args.length !== 4) return fail('op');
          const v = fromRealm(args[3]);
          if (v.ok === false) return fail(v.reason);
          return forward(() => { dispatcher.set(h, key, v.value); return undefined; }, false, where);
        }
        const argc = args.length - 3;
        if (argc > MEMBRANE_CAPS.maxArgs) return fail('args');
        /** @type {Wire[]} */
        const values = [];
        for (let i = 0; i < argc; i++) {
          const v = fromRealm(args[3 + i]);
          if (v.ok === false) return fail(v.reason);
          values.push(v.value);
        }
        return forward(() => dispatcher.call(h, key, values), false, where);
      }
      case OP.TIMER_SET: {
        const id = num(args[1]);
        const ms = num(args[2]);
        if (!isHandleNumber(id)) return fail('value');
        const repeat = args[3] !== undefined && ctx.typeof(args[3]) === 'boolean' && ctx.dump(args[3]) === true;
        return hooks.timerSet(id, Number.isFinite(ms) && ms > 0 ? ms : 0, repeat) ? ctx.true : ctx.false;
      }
      case OP.TIMER_CLEAR: {
        const id = num(args[1]);
        if (isHandleNumber(id)) hooks.timerClear(id);
        return ctx.undefined;
      }
      case OP.NOW:
        return forward(() => {
          const t = dispatcher.now();
          return typeof t === 'number' && Number.isFinite(t) ? t : 0;
        }, false, 'now');
      case OP.GUARD:
        return hooks.guard() ? ctx.true : ctx.false;
      case OP.DIAG: {
        const code = str(args[1], 64);
        const detail = str(args[2], 512);
        if (code !== null && detail !== null) hooks.diag(code, detail);
        return ctx.undefined;
      }
      default:
        return fail('op');
    }
  };

  return {
    native,
    toRealm,
    fromRealm,
    setMethodSentinel(s) {
      methodSentinel = s;
    },
    table,
  };
}
