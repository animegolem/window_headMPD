// @ts-check
// The Tauri-side DspPort (ENGINE.md §5.6, D6, D11): the host-side EQ and balance state the object model
// reads and writes, sent to the audio path with `invoke('set_eq')` and `invoke('set_balance')` and
// persisted through a PrefStore. Same rules as the test host's fake (src/hosts/test/dsp.js), which the
// engine's tests run against: ten bands clamped to ±14 dB (`eq.rs` clamps there too), balance clamped
// to ±100 with the ±5 detent, an unchanged value is a no-op and `onChange` fires only when a stored
// value actually changes (a clamped or detented write that leaves the value where it was is silent).
//
// Persistence is the `app` namespace under the legacy key names, with the legacy value format: `eq` is
// the JSON array `main.js` kept in localStorage (`[0,0,...]`), `balance` the JSON number. That is what
// `src/app/migrate.js` copies verbatim on the first engine boot (D10.8), so a migrated value reads
// back here without a conversion step. Writes go to `PrefStore.write`, which debounces them (250 ms),
// so a drag may write on every input.
//
// Bypass is session state, default false (the EQ is live, D6). `eq.rs` has no bypass until D11's phase
// 2 profile work, so in phase 1 it is held and announced but does not reach the audio path, exactly
// like the fake; and it is not persisted, so a skin that sets it cannot leave the owner's EQ off at
// the next launch.
//
// Following another window's EQ writes (`PrefStore.onExternalChange`) is left out on purpose: the
// store may echo a window's own debounced write back to it, and adopting the echo would snap a slider
// that is still being dragged back to an older value. One window exists in phase 1.

/** @typedef {import('../../engine/contracts').DspPort} DspPort */
/** @typedef {import('../../engine/contracts').PrefStore} PrefStore */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {(cmd: string, args?: Record<string, unknown>) => Promise<unknown> | unknown} InvokeFn Tauri's `invoke` */
/** @typedef {{ log?: Pick<Log, 'warn'> }} TauriDspOptions */

export const EQ_BANDS = 10;
/** `eq.rs` clamps to ±14 dB and Headspace's sliders run -14..14 (D11). */
export const EQ_LIMIT_DB = 14;
/** Balance values within ±5 are 0 for the DSP, and the stored value snaps to 0 (parity D17). */
export const BALANCE_DETENT = 5;
/** The prefs namespace and legacy key names of D6.4 / D10.8. */
export const PREFS_NS = 'app';
export const PREF_KEY_EQ = 'eq';
export const PREF_KEY_BALANCE = 'balance';

/** @param {number} db */
const clampGain = (db) => Math.min(EQ_LIMIT_DB, Math.max(-EQ_LIMIT_DB, db));
/** @param {number} v */
const detent = (v) => {
  const c = Math.min(100, Math.max(-100, v));
  return Math.abs(c) <= BALANCE_DETENT ? 0 : c;
};

/**
 * A persisted `eq` value as ten gains: anything unreadable is flat, a short or long array is padded
 * with zeros or cut, each gain is clamped. @param {string | undefined} raw
 */
function parseGains(raw) {
  /** @type {unknown} */
  let parsed = null;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { /* flat */ }
  }
  const src = Array.isArray(parsed) ? parsed : [];
  return Array.from({ length: EQ_BANDS }, (_, i) => {
    const v = src[i];
    return typeof v === 'number' && Number.isFinite(v) ? clampGain(v) : 0;
  });
}

/** A persisted `balance` value, through the same clamp and detent as a live write. @param {string | undefined} raw */
function parseBalance(raw) {
  if (typeof raw !== 'string') return 0;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'number' && Number.isFinite(v) ? detent(v) : 0;
  } catch {
    return 0;
  }
}

/**
 * Loads the saved EQ and balance, sends both to the audio path once (the legacy boot does
 * `sendEq(); sendBalance()`), and returns the port. A failed prefs load starts flat and centred.
 * @param {InvokeFn} invoke `invoke` of @tauri-apps/api/core, or a recorder in tests
 * @param {PrefStore} prefs
 * @param {TauriDspOptions} [opts]
 * @returns {Promise<DspPort>}
 */
export async function createTauriDsp(invoke, prefs, opts = {}) {
  const warn = (/** @type {string} */ m, /** @type {object} */ d) => {
    if (opts.log) opts.log.warn(m, d);
    else console.warn(m, d);
  };

  /** @type {ReadonlyMap<string, string>} */
  let saved = new Map();
  try {
    saved = await prefs.load(PREFS_NS);
  } catch (e) {
    warn('dsp: could not load saved EQ and balance, starting flat', { error: String(e) });
  }

  let gains = parseGains(saved.get(PREF_KEY_EQ));
  let balance = parseBalance(saved.get(PREF_KEY_BALANCE));
  let bypass = false;
  /** @type {Set<() => void>} */
  const eqListeners = new Set();
  /** @type {Set<() => void>} */
  const balanceListeners = new Set();

  /** Fire and forget, as the legacy `.catch(() => {})`: the audio path may be down, the UI goes on. @param {string} cmd @param {Record<string, unknown>} args */
  const send = (cmd, args) => {
    try {
      Promise.resolve(invoke(cmd, args)).catch((e) => warn(`dsp: ${cmd} failed`, { error: String(e) }));
    } catch (e) {
      warn(`dsp: ${cmd} failed`, { error: String(e) });
    }
  };
  /** @param {string} key @param {string} value */
  const persist = (key, value) => {
    try {
      prefs.write(PREFS_NS, key, value);
    } catch (e) {
      warn(`dsp: could not save ${key}`, { error: String(e) });
    }
  };
  /** One bad listener must not starve the rest or fail the write that triggered it. @param {Set<() => void>} listeners */
  const notify = (listeners) => {
    for (const cb of [...listeners]) {
      if (!listeners.has(cb)) continue;
      try { cb(); } catch (e) { warn('dsp: a listener threw', { error: String(e) }); }
    }
  };

  /**
   * Store ten gains. A change goes to the audio path (all ten, as `set_eq` takes), to the prefs and to
   * the listeners. A write that leaves every stored value where it was, because the clamp pulled it back
   * to the value already held, is silent, as in the test host: listeners hear about stored values, not
   * about requests.
   * @param {number[]} next the stored values
   */
  const commitGains = (next) => {
    if (next.every((v, i) => v === gains[i])) return;
    gains = next;
    send('set_eq', { gains: [...gains] });
    persist(PREF_KEY_EQ, JSON.stringify(gains));
    notify(eqListeners);
  };

  /** @type {DspPort} */
  const dsp = {
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

      /**
       * The DSP gets the detented value (4 goes to it as 0) and so does the store: a thumb dragged
       * through the centre is told 0 when the stored value moves (parity D17). A write that lands on the
       * value already held (3 while centred) changes nothing and is silent, as in the test host.
       */
      set(v) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        const next = detent(v);
        if (next === balance) return;
        balance = next;
        send('set_balance', { balance });
        persist(PREF_KEY_BALANCE, JSON.stringify(balance));
        notify(balanceListeners);
      },

      onChange(cb) {
        balanceListeners.add(cb);
        return () => { balanceListeners.delete(cb); };
      },
    },
  };

  send('set_eq', { gains: [...gains] });
  send('set_balance', { balance });
  return dsp;
}
