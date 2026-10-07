// @ts-check
// The Tauri host's EngineClock (ENGINE.md §5.8, D8): the page's real time. One requestAnimationFrame
// loop serves every `onFrame` subscriber and runs only while there is one, so a page whose engine is
// disposed (or not yet attached) costs no frames. Timers are the page's setTimeout; the ids handed out
// are this clock's own small integers, so the contract's `number` holds in Node as well as the browser.
//
// The realm's limits on skin timers (64 live, 10 ms floor, `timerInterval`) are the engine's job on
// top of this clock (W2.2); here a timer fires when it was asked to.
//
// Every global is read when it is used, and each can be injected, so the test drives the clock with
// a hand-cranked frame source and fake timers and never touches a browser.

/** @typedef {import('../../engine/contracts').EngineClock} EngineClock */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/**
 * @typedef {{
 *   requestFrame?: (cb: (ts: number) => void) => unknown,
 *   cancelFrame?: (id: any) => void,
 *   now?: () => number,
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (id: any) => void,
 *   onError?: (e: unknown) => void,
 * }} RafClockOptions
 *   `requestFrame`/`cancelFrame` default to requestAnimationFrame/cancelAnimationFrame (a 16 ms timer
 *   where the page has none); `now` to `performance.now`, the time base rAF timestamps use;
 *   `onError` hears a callback that threw (default: `reportError`, else `console.error`).
 * @typedef {EngineClock & { dispose(): void, frameListeners(): number, pendingTimers(): number }} RafClock
 */

/** setTimeout stores its delay in a signed 32-bit int and fires at once past it. */
const MAX_DELAY_MS = 2 ** 31 - 1;
const FRAME_FALLBACK_MS = 16;

/** @param {unknown} e */
function reportDefault(e) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(e);
  else console.error(e);
}

/**
 * @param {RafClockOptions} [opts]
 * @returns {RafClock}
 */
export function createRafClock(opts = {}) {
  const requestFrame = opts.requestFrame ?? ((/** @type {(ts: number) => void} */ cb) => (typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(cb)
    : globalThis.setTimeout(() => cb(performance.now()), FRAME_FALLBACK_MS)));
  const cancelFrame = opts.cancelFrame ?? ((/** @type {any} */ id) => (typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame(id)
    : globalThis.clearTimeout(id)));
  const nowFn = opts.now ?? (() => performance.now());
  const setT = opts.setTimeout ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((/** @type {any} */ id) => globalThis.clearTimeout(id));
  const onError = opts.onError ?? reportDefault;

  /** One entry per subscription, so subscribing the same function twice gives two independent handles.
   *  @type {Set<{ cb: (now: number) => void }>} */
  const listeners = new Set();
  /** The pending frame request, or null while the loop is idle. @type {{ id: unknown } | null} */
  let frame = null;
  let disposed = false;

  /** @param {() => void} fn */
  const guarded = (fn) => {
    // One callback's bug must not stop the others, the loop, or the timers behind it.
    try { fn(); } catch (e) { try { onError(e); } catch { /* the reporter is not allowed to throw either */ } }
  };

  /** @param {number} ts */
  function tick(ts) {
    frame = null;
    if (disposed || listeners.size === 0) return;
    // Ask for the next frame first: a callback that unsubscribes the last listener then cancels it.
    const mine = { id: undefined };
    frame = mine;
    mine.id = requestFrame(tick);
    const now = Number.isFinite(ts) ? ts : nowFn();
    for (const sub of [...listeners]) {
      if (listeners.has(sub)) guarded(() => sub.cb(now));
    }
  }

  function ensureLoop() {
    if (frame || disposed || listeners.size === 0) return;
    const mine = { id: undefined };
    frame = mine;
    mine.id = requestFrame(tick);
  }

  function stopLoop() {
    const f = frame;
    frame = null;
    if (f) cancelFrame(f.id);
  }

  let nextTimer = 1;
  /** @type {Map<number, unknown>} */
  const timers = new Map();

  /** @type {RafClock} */
  const clock = {
    now: () => nowFn(),

    onFrame(cb) {
      const sub = { cb };
      listeners.add(sub);
      ensureLoop();
      return () => {
        listeners.delete(sub);
        if (listeners.size === 0) stopLoop();
      };
    },

    setTimer(ms, cb) {
      const id = nextTimer++;
      const delay = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_DELAY_MS) : 0;
      const handle = setT(() => {
        timers.delete(id);
        guarded(cb);
      }, delay);
      timers.set(id, handle);
      return id;
    },

    clearTimer(id) {
      if (!timers.has(id)) return;
      clearT(timers.get(id));
      timers.delete(id);
    },

    /** Stops the frame loop and every pending timer; the clock does nothing afterwards. */
    dispose() {
      disposed = true;
      listeners.clear();
      stopLoop();
      for (const handle of timers.values()) clearT(handle);
      timers.clear();
    },

    frameListeners: () => listeners.size,
    pendingTimers: () => timers.size,
  };
  return clock;
}
