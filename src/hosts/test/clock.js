// @ts-check
// The manual EngineClock of ENGINE.md D8/§5.8. Time moves only inside `advance(ms)`: frames fire on a
// fixed 16 ms grid, timers fire at their due time, both in time order, and `now()` is frozen between
// advances. The realm's own limits (64 live timers, 10 ms floor, `timerInterval` rejection) are the
// engine's job (W2.2) on top of this clock; here a timer fires exactly when it was asked to.

/** @typedef {import('../../engine/contracts').EngineClock} EngineClock */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/**
 * @typedef {EngineClock & {
 *   advance(ms: number): void,
 *   pendingTimers(): number,
 *   frameListeners(): number,
 * }} ManualClock
 */

/** Frame period. The grid starts at the clock's start time and never drifts across advances. */
export const FRAME_MS = 16;

/** Timer callbacks that keep re-arming themselves at zero delay never reach the target time. */
const MAX_TIMER_FIRES_PER_ADVANCE = 100_000;

/**
 * @param {{ start?: number }} [opts] `start` is the initial `now()` in ms (default 0)
 * @returns {ManualClock}
 */
export function createManualClock(opts = {}) {
  const start = opts.start ?? 0;
  let time = start;
  let frameIndex = 0;                       // frames delivered so far; the next is at start + (frameIndex + 1) * 16
  let nextId = 1;
  let seq = 0;                              // insertion order, the tie-break for equal due times
  let advancing = false;

  /** @type {Map<number, { id: number, due: number, seq: number, cb: () => void }>} */
  const timers = new Map();
  /** @type {Set<(now: number) => void>} */
  const frameCbs = new Set();

  /** Earliest pending timer by (due, seq), or null. A scan: a test clock holds a handful. */
  const earliestTimer = () => {
    let best = null;
    for (const t of timers.values()) {
      if (best === null || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    }
    return best;
  };

  /** @type {ManualClock} */
  const clock = {
    now: () => time,

    onFrame(cb) {
      frameCbs.add(cb);
      return () => { frameCbs.delete(cb); };
    },

    setTimer(ms, cb) {
      const id = nextId++;
      const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
      timers.set(id, { id, due: time + delay, seq: seq++, cb });
      return id;
    },

    clearTimer(id) {
      timers.delete(id);
    },

    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance(${ms}): need a finite, non-negative number of ms`);
      if (advancing) throw new Error('advance() is not re-entrant: a callback cannot move the clock');
      advancing = true;
      const target = time + ms;
      let fires = 0;
      /** @type {{ error: unknown } | null} */
      let failure = null;
      /** @param {() => void} call */
      const guarded = (call) => {
        // A throwing callback must not strand the clock mid-advance: the remaining events still run
        // and the first error is rethrown at the end, so `now()` is `target` either way.
        try { call(); } catch (error) { failure ??= { error }; }
      };
      try {
        for (;;) {
          const timer = earliestTimer();
          const frameAt = start + (frameIndex + 1) * FRAME_MS;
          // Timers go before the frame that falls on the same instant: a timer due at t is part of the
          // work a browser finishes before it paints the frame at t.
          if (timer && timer.due <= target && timer.due <= frameAt) {
            if (++fires > MAX_TIMER_FIRES_PER_ADVANCE) {
              throw new Error(`clock: more than ${MAX_TIMER_FIRES_PER_ADVANCE} timer firings in one advance (a timer re-arming itself at 0 ms?)`);
            }
            timers.delete(timer.id);
            time = timer.due;
            guarded(timer.cb);
          } else if (frameAt <= target) {
            frameIndex++;
            time = frameAt;
            // Snapshot: a frame callback that unsubscribes a later one stops it at once, and one that
            // subscribes a new callback starts it with the next frame.
            for (const cb of [...frameCbs]) if (frameCbs.has(cb)) guarded(() => cb(frameAt));
          } else {
            break;
          }
        }
        time = target;
      } finally {
        advancing = false;
      }
      if (failure) throw failure.error;
    },

    pendingTimers: () => timers.size,
    frameListeners: () => frameCbs.size,
  };
  return clock;
}
