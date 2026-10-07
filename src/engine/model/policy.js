// @ts-check
// Per-API policies for the dangerous or meaningless parts of the WMP object model (E D6.5). A skin is
// untrusted: it can call `launchURL` a thousand times, close itself from `onload`, save
// preferences in a loop or hammer the MPD queue. Each policy here is one decision, written once, that
// the object files call; nothing in this file knows a member name.
//
//   deny-log          refuse, ledger it, and raise one notice per api and skin (`HostActions.denied`)
//   gesture-only      honour only inside a pointer or key dispatch (`inGesture`, or the call's own flag)
//   rate-mpd          at most 10 commands per second per verb; `seek` and `setVolume` instead debounce:
//                     the latest value is sent 40 ms after the last write (the legacy's trailing
//                     debounce, `main.js:102-103`; parity D18), still under the 10/s cap
//   pref-caps         the preference store's caps, enforced here and again in Rust (D6.4, §10)
//   timer-caps        VIEW `timerInterval`: 0 is off, a non-zero value under 50 ms is rejected (spec 6.2)
//   view-current-only phase 1 opens and closes no other view; the attempt is logged and ledgered
//
// Time is the host's engine clock, never `Date`, so the manual clock of the test host drives every
// rate interval and every batch deterministically.

/** @typedef {import('../contracts').EngineClock} EngineClock */
/** @typedef {import('../contracts').Ledger} Ledger */
/** @typedef {import('../contracts').HostActions} HostActions */
/** @typedef {import('../contracts').Log} Log */

/** E D6.5: MPD commands from script origin, per verb. */
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 1000;
/** E D6.5: `seek` and `setVolume` send the latest value this long after the last write (trailing debounce). */
export const COALESCE_MS = 40;
/** How long a coalesced value stays the answer to a read after it was sent, unless MPD echoes sooner. */
export const HOLD_MS = 500;
/** E D6.4 / §10: 256 keys, key <= 256 B, value <= 4 KiB, 64 KiB per namespace (keys plus values, UTF-8). */
export const PREF_CAPS = Object.freeze({ maxKeys: 256, maxKeyBytes: 256, maxValueBytes: 4096, maxNamespaceBytes: 65536 });
/** Spec 6.2: a non-zero `timerInterval` below this is rejected and the previous value kept. */
export const TIMER_INTERVAL_MIN_MS = 50;

/** @param {string} s @returns {number} the UTF-8 length, without allocating a buffer */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** @typedef {'key-bytes' | 'value-bytes' | 'key-count' | 'namespace-bytes'} PrefRejection */

/**
 * @typedef {{
 *   denied(api: string, detail: string): void,
 *   gesture(ctx?: { gesture?: boolean }): boolean,
 *   requireGesture(api: string, detail: string, ctx?: { gesture?: boolean }): boolean,
 *   admit(verb: string, api: string): boolean,
 *   coalesce(verb: string, api: string, value: number, send: (value: number) => unknown): void,
 *   pending(verb: string): number | undefined,
 *   settle(verb: string): void,
 *   prefWrite(store: ReadonlyMap<string, string>, key: string, value: string): PrefRejection | null,
 *   timerInterval(api: string, value: number): number | null,
 *   foreignView(api: string, viewId: string): void,
 *   dispose(): void,
 * }} Policies
 */

/**
 * @param {{ clock: EngineClock, ledger: Ledger, actions: HostActions, inGesture: () => boolean, log?: Log }} deps
 * @returns {Policies}
 */
export function createPolicies(deps) {
  const { clock, ledger, actions } = deps;

  // ---- deny-log -----------------------------------------------------------------------------------

  /** @type {Set<string>} apis already announced to the host; the ledger counts every attempt */
  const announced = new Set();

  /** @param {string} api @param {string} detail */
  function denied(api, detail) {
    ledger.record(api, 'denied', detail);
    if (announced.has(api)) return;
    announced.add(api);
    actions.denied(api, detail);
  }

  // ---- gesture-only -------------------------------------------------------------------------------

  /** @param {{ gesture?: boolean }} [ctx] */
  const gesture = (ctx) => ctx?.gesture === true || deps.inGesture() === true;

  /** @param {string} api @param {string} detail @param {{ gesture?: boolean }} [ctx] */
  function requireGesture(api, detail, ctx) {
    if (gesture(ctx)) return true;
    denied(api, detail);
    return false;
  }

  // ---- rate-mpd -----------------------------------------------------------------------------------

  /** @type {Map<string, number[]>} verb -> send times inside the last second, oldest first */
  const stamps = new Map();

  /** @param {string} verb @returns {number} ms until one more command fits, 0 when one fits now */
  function rateWait(verb) {
    const now = clock.now();
    const ts = stamps.get(verb);
    if (!ts) return 0;
    while (ts.length && now - ts[0] >= RATE_WINDOW_MS) ts.shift();
    return ts.length < RATE_LIMIT ? 0 : ts[0] + RATE_WINDOW_MS - now;
  }

  /** @param {string} verb */
  function rateTake(verb) {
    let ts = stamps.get(verb);
    if (!ts) stamps.set(verb, (ts = []));
    ts.push(clock.now());
  }

  /** @param {string} verb @param {string} api */
  function admit(verb, api) {
    if (rateWait(verb) > 0) {
      ledger.record(api, 'cap', `rate-mpd: more than ${RATE_LIMIT} ${verb} commands in a second; dropped`);
      return false;
    }
    rateTake(verb);
    return true;
  }

  /** @typedef {{ value: number, api: string, send: (value: number) => unknown, timer: number | null, heldUntil: number }} Slot */
  /** @type {Map<string, Slot>} */
  const slots = new Map();

  /** @param {string} verb */
  function fire(verb) {
    const slot = slots.get(verb);
    if (!slot) return;
    slot.timer = null;
    const wait = rateWait(verb);
    if (wait > 0) {
      // The rate allowance is spent. A batch is never dropped, because the last value must land: it waits.
      ledger.record(slot.api, 'cap', `rate-mpd: ${verb} batches deferred to stay under ${RATE_LIMIT} per second`);
      slot.timer = clock.setTimer(wait, () => fire(verb));
      return;
    }
    rateTake(verb);
    slot.heldUntil = clock.now() + HOLD_MS;
    try {
      const result = slot.send(slot.value);
      if (result && typeof (/** @type {any} */ (result)).catch === 'function') /** @type {Promise<unknown>} */ (result).catch((e) => deps.log?.warn(`${slot.api}: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      deps.log?.warn(`${slot.api}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** @type {Policies['coalesce']} */
  function coalesce(verb, api, value, send) {
    let slot = slots.get(verb);
    if (!slot) slots.set(verb, (slot = { value, api, send, timer: null, heldUntil: 0 }));
    slot.value = value;
    slot.api = api;
    slot.send = send;
    // Trailing: every write restarts the wait. A timer that `fire` armed to wait out the rate limit
    // is replaced too, which is safe: `fire` re-checks the allowance and defers again.
    if (slot.timer !== null) clock.clearTimer(slot.timer);
    slot.timer = clock.setTimer(COALESCE_MS, () => fire(verb));
  }

  /** The value a script wrote and MPD has not echoed yet, or undefined. @param {string} verb */
  function pending(verb) {
    const slot = slots.get(verb);
    if (!slot) return undefined;
    return slot.timer !== null || clock.now() < slot.heldUntil ? slot.value : undefined;
  }

  /** MPD echoed the state: stop answering reads with the written value. @param {string} verb */
  function settle(verb) {
    const slot = slots.get(verb);
    if (slot && slot.timer === null) slot.heldUntil = 0;
  }

  // ---- pref-caps ----------------------------------------------------------------------------------

  /** @type {Policies['prefWrite']} */
  function prefWrite(store, key, value) {
    /** @type {PrefRejection | null} */
    let reason = null;
    const keyBytes = utf8Length(key);
    const valueBytes = utf8Length(value);
    if (keyBytes > PREF_CAPS.maxKeyBytes) reason = 'key-bytes';
    else if (valueBytes > PREF_CAPS.maxValueBytes) reason = 'value-bytes';
    else if (!store.has(key) && store.size >= PREF_CAPS.maxKeys) reason = 'key-count';
    else {
      let total = 0;
      for (const [k, v] of store) if (k !== key) total += utf8Length(k) + utf8Length(v);
      if (total + keyBytes + valueBytes > PREF_CAPS.maxNamespaceBytes) reason = 'namespace-bytes';
    }
    if (reason) ledger.record('theme.savePreference', 'cap', `pref-caps: ${reason}; the write was dropped`);
    return reason;
  }

  // ---- timer-caps ---------------------------------------------------------------------------------

  /** @type {Policies['timerInterval']} */
  function timerInterval(api, value) {
    if (!Number.isFinite(value) || value < 0 || (value > 0 && value < TIMER_INTERVAL_MIN_MS)) {
      ledger.record(api, 'cap', `timer-caps: ${value} is not 0 or at least ${TIMER_INTERVAL_MIN_MS} ms; the previous value stays`);
      return null;
    }
    return value;
  }

  // ---- view-current-only --------------------------------------------------------------------------

  /** @type {Set<string>} */
  const foreign = new Set();

  /** @param {string} api @param {string} viewId */
  function foreignView(api, viewId) {
    ledger.record(api, 'stub', `phase 1 opens and closes only the current view (asked for "${String(viewId).slice(0, 48)}")`);
    if (foreign.has(api)) return;
    foreign.add(api);
    deps.log?.info(`${api}: other views are not opened in phase 1`);
  }

  // ---- teardown -----------------------------------------------------------------------------------

  function dispose() {
    for (const slot of slots.values()) {
      if (slot.timer !== null) clock.clearTimer(slot.timer);
      slot.timer = null;
    }
    slots.clear();
    stamps.clear();
  }

  return { denied, gesture, requireGesture, admit, coalesce, pending, settle, prefWrite, timerInterval, foreignView, dispose };
}
