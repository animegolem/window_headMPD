// @ts-check
// Safe-mode boot (ENGINE.md D10.8). A skin can take the WebContent process down (a runaway decode, a wasm
// out-of-memory) or fail the same way at every launch, and the shell must not lock the owner out of it.
// So the shell writes a `boot.pending` marker to the `app` namespace before it loads a skin and clears
// it 10 s after the skin's first frame. A launch that finds the marker still set, or finds Shift held,
// skips the skin and shows the fault panel instead.
//
// What clears the marker, and what deliberately does not:
//   - 10 s after the first frame following `markRunning()`: the skin ran, whatever it did later;
//   - the page going away (`clear()`, boot.js calls it on `pagehide`): quitting inside the 10 s is not a
//     crash. Best effort: the IPC is posted as the page unloads, and a force quit leaves the marker;
//   - NOT a load that threw. That skin never reached a first frame, so the marker stays and the next
//     launch starts in safe mode; the panel's "Reload skin" is the owner's explicit retry.
//
// The marker write must land before the skin gets a chance to crash, so `arm()` awaits the store's
// `flush()` when it has one. The PrefStore contract only promises a debounced write-through (250 ms);
// boot.js hands this module a store whose writes are immediate, and `flush` is the hook for a store
// that is not.
//
// "Shift held at launch" cannot be asked of a webview, only observed: `watchShift` records `shiftKey` on
// the first key and pointer events it sees, from the moment the page starts. A native probe (a Tauri
// command reading the modifier flags) can replace it through `check({ shift })`.

/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'> & { flush?(): Promise<void> | void }} SafePrefs */
/** @typedef {Pick<import('../engine/contracts').EngineClock, 'onFrame' | 'setTimer' | 'clearTimer'>} SafeClock */
/** @typedef {{ safe: false, reason: null, message: '' } | { safe: true, reason: 'pending' | 'shift', message: string }} SafeVerdict */
/** @typedef {{ held(): boolean, dispose(): void }} ShiftWatch */

export const PENDING_NS = 'app';
export const PENDING_KEY = 'boot.pending';
/** The marker outlives the first frame by this long (D10.8). */
export const CLEAR_AFTER_MS = 10_000;

export const MESSAGES = Object.freeze({
  pending: 'The last launch did not finish loading this skin, so it was not loaded this time.',
  shift: 'Safe mode: Shift was held at launch, so the skin was not loaded.',
});

const SHIFT_EVENTS = ['keydown', 'keyup', 'pointerdown', 'pointermove', 'mousemove', 'focus'];

/**
 * Watches `shiftKey` on the events that carry it. Install it before anything is awaited, so the first
 * event of the launch is not missed. A `keyup` of Shift ends the hold.
 * @param {EventTarget} [target] the window
 * @returns {ShiftWatch}
 */
export function watchShift(target = globalThis) {
  let held = false;
  /** @param {Event} e */
  const onEvent = (e) => {
    const shift = /** @type {{ shiftKey?: unknown }} */ (e).shiftKey;
    if (typeof shift === 'boolean') held = shift;
  };
  for (const type of SHIFT_EVENTS) target.addEventListener(type, onEvent, true);
  return {
    held: () => held,
    dispose() {
      for (const type of SHIFT_EVENTS) target.removeEventListener(type, onEvent, true);
    },
  };
}

/**
 * @param {{ prefs: SafePrefs, clock: SafeClock, shift?: () => boolean }} deps
 *   `shift` answers "is Shift held now" (default: never)
 */
export function createSafeMode({ prefs, clock, shift }) {
  /** @type {number | null} */
  let timer = null;
  /** @type {(() => void) | null} */
  let offFrame = null;
  let armed = false;

  const stopTimers = () => {
    offFrame?.();
    offFrame = null;
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
  };

  /** Removes the marker. The store's own failures must not become a boot failure. */
  const remove = () => {
    try {
      prefs.write(PENDING_NS, PENDING_KEY, null);
    } catch { /* the marker is only a safeguard */ }
  };

  return {
    /**
     * Whether this launch must skip the skin. A pref store that cannot be read is not a reason to lock
     * the skin out, so a failed load reads as "no marker".
     * @param {{ shift?: () => boolean }} [over]
     * @returns {Promise<SafeVerdict>}
     */
    async check(over = {}) {
      /** @type {ReadonlyMap<string, string>} */
      let app = new Map();
      try {
        app = await prefs.load(PENDING_NS);
      } catch { /* treated as no marker */ }
      if (app.has(PENDING_KEY)) return { safe: true, reason: 'pending', message: MESSAGES.pending };
      let held = false;
      try {
        held = !!(over.shift ?? shift)?.();
      } catch { /* a broken probe is not Shift */ }
      if (held) return { safe: true, reason: 'shift', message: MESSAGES.shift };
      return { safe: false, reason: null, message: '' };
    },

    /**
     * Writes the marker, and waits for it to land when the store can say so. Call before loading a skin.
     * A store that refuses the write leaves the skin unguarded rather than unloadable: a broken pref
     * store must not itself lock the owner out, so this resolves false and the load goes on.
     * @returns {Promise<boolean>} whether the marker was written
     */
    async arm() {
      stopTimers();
      armed = false;
      try {
        prefs.write(PENDING_NS, PENDING_KEY, '1');
      } catch {
        return false;
      }
      armed = true;
      try {
        await prefs.flush?.();
      } catch { /* the write was accepted; the flush is best effort */ }
      return true;
    },

    /**
     * The skin is attached: start the clock on the first frame after this call, and clear the marker
     * once the skin has run for `CLEAR_AFTER_MS` from it.
     */
    markRunning() {
      if (!armed) return;
      stopTimers();
      offFrame = clock.onFrame(() => {
        offFrame?.();
        offFrame = null;
        timer = clock.setTimer(CLEAR_AFTER_MS, () => {
          timer = null;
          armed = false;
          remove();
        });
      });
    },

    /**
     * Clean exit: removes the marker now and cancels the timers. Only a marker this launch wrote: a
     * launch that came up in safe mode did not arm, and quitting from its panel must not wave the
     * skin that caused it through at the next launch.
     */
    clear() {
      stopTimers();
      if (!armed) return;
      armed = false;
      remove();
    },

    /** Stops the timers and leaves the marker as it is (a reload re-arms it). */
    dispose() {
      stopTimers();
    },
  };
}
