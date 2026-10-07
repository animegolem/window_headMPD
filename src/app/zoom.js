// @ts-check
// Zoom (ENGINE.md D10.1, D7.6, parity D3). The window has two sizes, Normal (1) and Larger (1.5). The
// shell flips between them from the window menu and from a skin's "Return to Full Mode" button
// (`view.returnToMediaCenter()`, whose host action is the zoom toggle by default). `SkinWindow.setZoom`
// does the work: the CSS scale, the native window size and the re-sent shape. This module owns the
// decision and the memory.
//
// Persistence is the `app` namespace in the legacy value format (`1.5`, JSON), under a key scoped to the
// window (`zoom@<SkinWindow.key>`, D7.6) with the legacy bare `zoom` as the fallback. That bare key is
// what the migration (migrate.js) carries over from the hand port, so the first engine launch opens at
// the size the owner left; the first change after that is saved under the scoped key and the bare one
// stays as the default for a skin that has none of its own.

/** @typedef {import('../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'>} PrefsLike */

export const ZOOM_NORMAL = 1;
export const ZOOM_LARGER = 1.5;
export const PREFS_NS = 'app';

/** Pref keys are at most 256 bytes (D6.4); a VIEW id is skin text, so the scoped part is cut. */
const MAX_SCOPE_CHARS = 160;

/**
 * `name@<window key>`: the per-window form of a host pref (D7.6).
 * @param {string} name @param {string} windowKey
 */
export function windowPrefKey(name, windowKey) {
  return `${name}@${String(windowKey).slice(0, MAX_SCOPE_CHARS)}`;
}

/**
 * A stored pref value that must be one number in [0.25, 4]; anything else is "not stored".
 * @param {string | undefined} raw @returns {number | null}
 */
export function parseZoom(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0.25 && v <= 4 ? v : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ win: SkinWindow, prefs: PrefsLike, log?: Pick<import('../engine/contracts').Log, 'warn'> }} deps
 */
export function createZoom({ win, prefs, log }) {
  let current = win.zoom;
  /** @type {Set<(z: number) => void>} */
  const listeners = new Set();
  /** Calls are applied one at a time, in order: a double toggle must land on where it started. */
  let chain = Promise.resolve();

  /** @param {number} z */
  async function apply(z) {
    if (!(z >= 0.25 && z <= 4)) throw new RangeError(`zoom must be between 0.25 and 4, got ${String(z)}`);
    if (z === current) return;
    await win.setZoom(z);
    current = z;
    try {
      prefs.write(PREFS_NS, windowPrefKey('zoom', win.key), JSON.stringify(z));
    } catch (e) {
      log?.warn('zoom: could not save the zoom', { error: String(e) });
    }
    for (const cb of [...listeners]) if (listeners.has(cb)) cb(z);
  }

  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const enqueue = (job) => {
    const run = chain.then(job);
    chain = run.then(() => {}, () => {});
    return run;
  };

  return {
    /** The zoom now, as the shell last set it. */
    get: () => current,
    /** @param {number} z */
    set: (z) => enqueue(() => apply(z)),
    /** Normal to Larger and back (the window menu, `returnToMediaCenter`). */
    toggle: () => enqueue(() => apply(current === ZOOM_NORMAL ? ZOOM_LARGER : ZOOM_NORMAL)),
    /**
     * Applies the saved zoom. Call once at boot, before the skin attaches, so the first frame is
     * already at the owner's size. A store that cannot be read leaves the window as it is.
     * @returns {Promise<number>} the zoom in force
     */
    async restore() {
      try {
        const saved = await prefs.load(PREFS_NS);
        const z = parseZoom(saved.get(windowPrefKey('zoom', win.key))) ?? parseZoom(saved.get('zoom'));
        if (z !== null) await enqueue(async () => {
          if (z === current) return;
          await win.setZoom(z);                       // a restore is not a change to save
          current = z;
          for (const cb of [...listeners]) if (listeners.has(cb)) cb(z);
        });
      } catch (e) {
        log?.warn('zoom: could not restore the saved zoom', { error: String(e) });
      }
      return current;
    },
    /** @param {(z: number) => void} cb @returns {() => void} */
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}
