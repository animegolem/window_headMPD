// @ts-check
// Fake DspPort for the test host (ENGINE.md §5.6, D6, D11). It holds the host-side EQ and balance
// state the object model reads and writes, applies the same rules as the Tauri adapter (±14 dB
// clamp, ±5 balance detent) and records what would reach the audio path, so a test can compare it
// with the legacy run's `set_eq` / `set_balance` calls (D9).
//
// Persistence is the real adapter's job (it writes the `app` prefs namespace); a test seeds the
// starting values through `createFakeDsp({ gains, balance, bypass })` instead.

/** @typedef {import('../../engine/contracts').DspPort} DspPort */
/**
 * @typedef {DspPort & {
 *   readonly sent: { eq: number[][], balance: number[] },
 * }} FakeDsp
 */

export const EQ_BANDS = 10;
/** `eq.rs` clamps to ±14 dB and Headspace's sliders run -14..14 (D11). */
export const EQ_LIMIT_DB = 14;
/** Balance values within ±5 are 0 for the DSP, and the stored value snaps to 0 (parity D17). */
export const BALANCE_DETENT = 5;

/**
 * Runs every listener even if one throws, then rethrows the first error.
 * @param {Set<() => void>} listeners
 */
function notify(listeners) {
  /** @type {unknown} */
  let failure = null;
  let failed = false;
  for (const cb of [...listeners]) {
    if (!listeners.has(cb)) continue;
    try { cb(); } catch (e) { if (!failed) { failed = true; failure = e; } }
  }
  if (failed) throw failure;
}

/**
 * @param {{ gains?: readonly number[], balance?: number, bypass?: boolean }} [initial] starting state
 * @returns {FakeDsp}
 */
export function createFakeDsp(initial = {}) {
  const clampGain = (/** @type {number} */ db) => Math.min(EQ_LIMIT_DB, Math.max(-EQ_LIMIT_DB, db));
  let gains = Array.from({ length: EQ_BANDS }, (_, i) => {
    const v = initial.gains?.[i];
    return typeof v === 'number' && Number.isFinite(v) ? clampGain(v) : 0;
  });
  let bypass = initial.bypass ?? false;                   // D6: the EQ is live unless a skin says otherwise
  let balance = 0;
  /** @type {Set<() => void>} */
  const eqListeners = new Set();
  /** @type {Set<() => void>} */
  const balanceListeners = new Set();
  /** @type {{ eq: number[][], balance: number[] }} */
  const sent = { eq: [], balance: [] };

  /** @param {number} v */
  const detent = (v) => {
    const c = Math.min(100, Math.max(-100, v));
    return Math.abs(c) <= BALANCE_DETENT ? 0 : c;
  };
  if (typeof initial.balance === 'number' && Number.isFinite(initial.balance)) balance = detent(initial.balance);

  /** @param {number[]} next */
  const commitGains = (next) => {
    if (next.every((v, i) => v === gains[i])) return;
    gains = next;
    sent.eq.push([...gains]);                            // `set_eq` always carries all ten
    notify(eqListeners);
  };

  /** @type {FakeDsp} */
  const dsp = {
    sent,
    eq: {
      gains: () => Object.freeze([...gains]),

      setGain(band, db) {
        if (!Number.isInteger(band) || band < 0 || band >= EQ_BANDS) throw new RangeError(`eq band ${band}: expected an integer 0..${EQ_BANDS - 1}`);
        if (typeof db !== 'number' || !Number.isFinite(db)) return;
        const next = [...gains];
        next[band] = clampGain(db);
        commitGains(next);
      },

      reset() {
        commitGains(gains.map(() => 0));
      },

      bypass: () => bypass,

      setBypass(on) {
        const v = !!on;
        if (v === bypass) return;
        bypass = v;
        notify(eqListeners);
      },

      onChange(cb) {
        eqListeners.add(cb);
        return () => { eqListeners.delete(cb); };
      },
    },

    balance: {
      get: () => balance,

      set(v) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        const next = detent(v);
        if (next === balance) return;
        balance = next;
        sent.balance.push(balance);
        notify(balanceListeners);
      },

      onChange(cb) {
        balanceListeners.add(cb);
        return () => { balanceListeners.delete(cb); };
      },
    },
  };
  return dsp;
}
