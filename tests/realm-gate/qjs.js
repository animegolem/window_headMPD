// @ts-check
// Test harness for the realm gate RG0 (ENGINE D1, WAVES W1.4). It is NOT engine code: it is the
// smallest QuickJS wrapper that follows D1's fault-domain rules, so the gate measures the same thing
// the realm (W2.2) will rely on, and W2.2 can lift its behaviour from here with the evidence next to it.
//
//   - One WASM module instance per "session": every `newInstance()` calls
//     `newQuickJSWASMModuleFromVariant`, so a fault in one cannot touch the next.
//   - Budgets read `wallClock`, the real `performance.now` captured when this file loads. They never
//     read the engine clock or a patched global, so a frozen fake clock cannot disable the interrupt
//     (the cand-F frozen-clock hang, ENGINE §13 finding 17).
//   - A hard fault (interrupt, out of memory, stack exhaustion, a host exception escaping WASM, an
//     abort) marks the instance faulted. A faulted instance is DISCARDED: every reference dropped,
//     `dispose` never called (cand-F probe-1: a leaked handle makes JS_FreeRuntime abort the module).
//     A clean instance disposes in a try/catch.

import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';

// The gate runs on bellard QuickJS, the variant ENGINE D1 pins. `RG0_VARIANT=ng npm test -- tests/realm-gate`
// runs the same cases on quickjs-ng, D1's named swap if bellard fails the gate, so O can compare the two
// without editing anything. Only the variant that is asked for is loaded.
export const VARIANT_NAME = process.env.RG0_VARIANT === 'ng' ? 'quickjs-ng' : 'quickjs';
const variant = (VARIANT_NAME === 'quickjs-ng'
  ? await import('@jitl/quickjs-ng-wasmfile-release-sync')
  : await import('@jitl/quickjs-wasmfile-release-sync')
).default;

/** The real clock. Captured at module load, before any test installs fake timers. */
export const wallClock = performance.now.bind(performance);

export const MiB = 1024 * 1024;

/**
 * Limits the gate runs under: both are ENGINE §10's and `RealmOptions` in contracts.d.ts (G1 ruling:
 * 256 KiB, down from the 1 MiB the first draft of §10 had). At 1 MiB (and 512 KiB) unbounded
 * recursion overflows V8's native stack before QuickJS's own check fires, and a host `RangeError`
 * escapes out of WASM instead of a realm `InternalError`. At 256 KiB the realm raises
 * `InternalError: stack overflow` cleanly (about 1,500 frames). See `rg0.test.js`, "item 5: stack".
 */
export const GATE_LIMITS = Object.freeze({ memoryLimitBytes: 64 * MiB, maxStackBytes: 256 * 1024 });

/**
 * @typedef {{ name: string, message: string, stack?: string }} RealmError
 * @typedef {Object} RunResult
 * @property {boolean} ok
 * @property {any} [value]                set when ok
 * @property {RealmError} [error]         set when not ok
 * @property {boolean} [host]             set when not ok: the exception came out of WASM into the host (a native
 *   RangeError or an abort) instead of being a realm error
 * @property {number} elapsedMs
 * @property {boolean} interrupted
 */

/** @param {unknown} v @returns {RealmError} */
function toRealmError(v) {
  if (v && typeof v === 'object' && 'name' in v && 'message' in v) {
    const e = /** @type {any} */ (v);
    return { name: String(e.name), message: String(e.message), stack: typeof e.stack === 'string' ? e.stack : undefined };
  }
  return { name: 'Thrown', message: String(v) };
}

/**
 * The hard-fault reasons D1 names that can be recognised from a realm error alone.
 * @param {RealmError} err
 * @returns {string|null}
 */
export function hardFaultReason(err) {
  if (err.name === 'RangeError' && /call stack/.test(err.message)) return 'stack';    // quickjs-ng's wording
  if (err.name !== 'InternalError') return null;
  if (/interrupted/.test(err.message)) return 'budget';
  if (/out of memory/.test(err.message)) return 'memory';
  if (/stack overflow/.test(err.message)) return 'stack';
  return null;
}

export class Instance {
  /** @param {{ mod: any, rt: any, ctx: any }} parts */
  constructor(parts) {
    /** @type {any} */ this.mod = parts.mod;
    /** @type {any} */ this.rt = parts.rt;
    /** @type {any} */ this.ctx = parts.ctx;
    /** @type {'live'|'disposed'|'discarded'} */
    this.state = 'live';
    /** First hard fault seen, if any. A faulted instance is discarded, never disposed. @type {string|null} */
    this.hardFault = null;
    /** @type {number} */ this.deadline = Infinity;
    /** Interrupt-handler hits that returned true. @type {number} */ this.interrupts = 0;
    /** Calls to `ctx.dispose` plus `rt.dispose`. */ this.disposeCalls = 0;
    /** Handles the gate holds on purpose. @type {any[]} */ this.leaked = [];
    const { ctx, rt } = parts;
    for (const target of [ctx, rt]) {
      const original = target.dispose.bind(target);
      target.dispose = () => {
        this.disposeCalls++;
        return original();
      };
    }
    rt.setInterruptHandler(() => {
      if (wallClock() > this.deadline) {
        this.interrupts++;
        return true;
      }
      return false;
    });
  }

  #assertLive() {
    if (this.state !== 'live') throw new Error(`instance is ${this.state}: a faulted instance is never touched again`);
  }

  /** @param {string} reason */
  #fault(reason) {
    this.hardFault ??= reason;
  }

  /**
   * Evaluate global code under a wall-clock budget. Host exceptions (a native RangeError, an abort)
   * are caught and reported with `host: true`, and fault the instance.
   * @param {string} code
   * @param {{ budgetMs?: number, filename?: string }} [opts]
   * @returns {RunResult}
   */
  run(code, opts = {}) {
    this.#assertLive();
    const before = this.interrupts;
    const start = wallClock();
    this.deadline = start + (opts.budgetMs ?? Infinity);
    /** @type {any} */
    let result;
    try {
      result = this.ctx.evalCode(code, opts.filename ?? 'gate.js');
    } catch (e) {
      this.deadline = Infinity;
      this.#fault('host-exception');
      return { ok: false, error: toRealmError(e), elapsedMs: wallClock() - start, interrupted: this.interrupts > before, host: true };
    }
    this.deadline = Infinity;
    const elapsedMs = wallClock() - start;
    const interrupted = this.interrupts > before;
    if (result.error) {
      const error = toRealmError(this.ctx.dump(result.error));
      result.error.dispose();
      const reason = hardFaultReason(error);
      if (reason) this.#fault(reason);
      return { ok: false, error, elapsedMs, interrupted, host: false };
    }
    const value = this.ctx.dump(result.value);
    result.value.dispose();
    if (interrupted) this.#fault('budget');
    return { ok: true, value, elapsedMs, interrupted };
  }

  /**
   * Evaluate and unwrap: the value, or throw the realm error as a host Error. For setup code.
   * @param {string} code
   * @param {{ budgetMs?: number, filename?: string }} [opts]
   */
  eval(code, opts) {
    const r = this.run(code, opts);
    if (!r.ok) throw new Error(`realm error ${r.error.name}: ${r.error.message}`);
    return r.value;
  }

  /**
   * Compile as global code without running it.
   * @param {string} code
   * @param {string} [filename]
   * @returns {{ ok: boolean, error?: RealmError }}
   */
  compile(code, filename = 'compile.js') {
    this.#assertLive();
    const result = this.ctx.evalCode(code, filename, { compileOnly: true });
    if (result.error) {
      const error = toRealmError(this.ctx.dump(result.error));
      result.error.dispose();
      return { ok: false, error };
    }
    result.value.dispose();
    return { ok: true };
  }

  /**
   * Run the pending-job queue once, at most `maxJobs` jobs (ENGINE §10: 1,000 per drain), inside the
   * same wall-clock budget. A job the interrupt kills surfaces as a rejected promise, not as an
   * error result (measured), so `interrupted` is the signal.
   * @param {{ budgetMs?: number, maxJobs?: number }} [opts]
   * @returns {{ jobs: number, pending: boolean, interrupted: boolean, elapsedMs: number, error?: RealmError }}
   */
  drain(opts = {}) {
    this.#assertLive();
    const before = this.interrupts;
    const start = wallClock();
    this.deadline = start + (opts.budgetMs ?? Infinity);
    /** @type {any} */
    let result;
    try {
      result = this.rt.executePendingJobs(opts.maxJobs ?? 1000);
    } catch (e) {
      this.deadline = Infinity;
      this.#fault('host-exception');
      return { jobs: 0, pending: true, interrupted: this.interrupts > before, elapsedMs: wallClock() - start, error: toRealmError(e) };
    }
    this.deadline = Infinity;
    const elapsedMs = wallClock() - start;
    const interrupted = this.interrupts > before;
    if (interrupted) this.#fault('budget');
    if (result.error) {
      const error = toRealmError(this.ctx.dump(result.error));
      result.error.dispose();
      return { jobs: 0, pending: this.rt.hasPendingJob(), interrupted, elapsedMs, error };
    }
    return { jobs: result.value, pending: this.rt.hasPendingJob(), interrupted, elapsedMs };
  }

  /**
   * Install one native function as a global: the `-sync` host function of RG0 item 3. Arguments
   * arrive as primitives (copied out with `dump`), and the result is copied back in, so nothing but
   * data crosses (E D1 membrane). A thrown host Error becomes a realm exception with its name and
   * message.
   * @param {string} name
   * @param {(...args: any[]) => any} impl
   */
  defineHost(name, impl) {
    this.#assertLive();
    const ctx = this.ctx;
    const fn = ctx.newFunction(name, (/** @type {any[]} */ ...args) => toHandle(ctx, impl(...args.map((h) => ctx.dump(h)))));
    ctx.setProp(ctx.global, name, fn);
    fn.dispose();
  }

  /**
   * Evaluate a skin script the way D1 specifies: global code `with(__IDS){ eval(__src) }`, a direct
   * eval. `__src` is a global the loader sets, evaluates, and clears.
   * @param {string} source
   * @param {{ budgetMs?: number, filename?: string }} [opts]
   * @returns {RunResult}
   */
  loadScript(source, opts) {
    this.#assertLive();
    const ctx = this.ctx;
    const text = ctx.newString(source);
    ctx.setProp(ctx.global, '__src', text);
    text.dispose();
    const r = this.run('with(__IDS){ eval(__src) }', { filename: 'loader.js', ...opts });
    if (this.state === 'live') this.run('__src = undefined');
    return r;
  }

  /** Hold a handle on purpose and never free it: the simulated leak of RG0 item 6. */
  leakHandle() {
    this.#assertLive();
    this.leaked.push(this.ctx.evalCode('({ leaked: true })'));
  }

  /** Drop every reference without calling `dispose`. The only exit for a faulted instance. */
  discard() {
    this.mod = this.rt = this.ctx = null;
    this.leaked = [];
    this.state = 'discarded';
  }

  /**
   * End the session the way D1 says. Faulted: discard. Clean: dispose inside try/catch, and discard
   * if even that aborts.
   * @returns {{ disposed: boolean, discarded: boolean, threw?: unknown }}
   */
  unload() {
    if (this.state !== 'live') return { disposed: this.state === 'disposed', discarded: this.state === 'discarded' };
    if (this.hardFault) {
      this.discard();
      return { disposed: false, discarded: true };
    }
    try {
      this.ctx.dispose();
      this.rt.dispose();
      this.state = 'disposed';
      this.mod = this.rt = this.ctx = null;
      return { disposed: true, discarded: false };
    } catch (threw) {
      this.discard();
      return { disposed: false, discarded: true, threw };
    }
  }
}

/**
 * Copy a host value into the realm. Only the wire types cross: undefined, null, boolean, number,
 * string, and the two small shapes `{ __h: n }` (a handle) and `{ method: true }`.
 * @param {any} ctx
 * @param {any} v
 */
function toHandle(ctx, v) {
  if (v === undefined) return ctx.undefined;
  if (v === null) return ctx.null;
  if (v === true) return ctx.true;
  if (v === false) return ctx.false;
  if (typeof v === 'number') return ctx.newNumber(v);
  if (typeof v === 'string') return ctx.newString(v);
  if (v && typeof v === 'object' && (typeof v.__h === 'number' || v.method === true)) {
    const o = ctx.newObject();
    const key = 'method' in v ? 'method' : '__h';
    const val = key === 'method' ? ctx.true : ctx.newNumber(v.__h);
    ctx.setProp(o, key, val);
    if (key === '__h') val.dispose();
    return o;
  }
  throw new TypeError(`value of type ${typeof v} does not cross the membrane`);
}

/**
 * A fresh WASM module instance with one runtime and one context, limits applied.
 * @param {{ memoryLimitBytes?: number, maxStackBytes?: number }} [opts]
 * @returns {Promise<Instance>}
 */
export async function newInstance(opts = {}) {
  const mod = await newQuickJSWASMModuleFromVariant(variant);
  const rt = mod.newRuntime();
  rt.setMemoryLimit(opts.memoryLimitBytes ?? GATE_LIMITS.memoryLimitBytes);
  rt.setMaxStackSize(opts.maxStackBytes ?? GATE_LIMITS.maxStackBytes);
  const ctx = rt.newContext();
  return new Instance({ mod, rt, ctx });
}

/**
 * "After each hard fault a fresh instance in the same process evaluates `1+1`" (RG0 item 5). Always a
 * new module instance, then a clean dispose.
 * @returns {Promise<{ value: any, disposed: boolean }>}
 */
export async function freshInstanceEvaluates() {
  const fresh = await newInstance();
  const value = fresh.eval('1+1');
  return { value, disposed: fresh.unload().disposed };
}
