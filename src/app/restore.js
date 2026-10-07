// @ts-check
// Drawer restore (ENGINE.md D10.6 `restore`, parity D23). The hand port reopened the equalizer and
// playlist drawers at launch, animated, if they were open when the owner quit. The engine keeps that
// without any special case: a sidecar lists, for each drawer, the skin script's state global
// (`eqIsOpen`), the function that toggles it (`ToggleEqView`) and the pref that remembers it (`eqOpen`).
//
//   save    `check()` reads each global, a cheap primitive read, and writes the pref when it changed.
//           The shell calls it after every dispatch (a pointer release, a key) and the frame clock
//           backs it up at a low rate, so a change a script timer makes is caught too.
//   replay  `apply()` runs once after the skin's `onload`: for each entry whose pref is true and whose
//           global is not, it calls the toggle, and the skin animates it open as it does for a click.
//
// Prefs are the `app` namespace in the legacy format (`true` / `false`, JSON), which is also what the
// migration carries over from the hand port's `eqOpen` and `plOpen`. A global that is not a boolean (or
// a number) counts as closed, and a realm that has already unloaded just reads as "no change".
//
// `bind()` takes the baseline (what each global reads as when the view is attached), so neither the
// poll nor a dispatch can save a pref before `apply()` has had its say: only a change from the baseline
// is written, and `apply()` moves the baseline to where its own toggle left the global.

/** @typedef {import('../engine/contracts').SkinInspector} SkinInspector */
/** @typedef {import('../engine/contracts').Sidecar} Sidecar */
/** @typedef {NonNullable<Sidecar['restore']>} RestoreEntries */
/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'>} PrefsLike */
/** @typedef {Pick<import('../engine/contracts').EngineClock, 'onFrame'>} FrameClock */
/** @typedef {Pick<SkinInspector, 'readGlobal' | 'callGlobal'>} GlobalsAccess */

export const PREFS_NS = 'app';
/** The frame clock re-checks at most this often. A change by a user gesture is caught at once by `check()`. */
export const POLL_MS = 250;

/** @param {unknown} v the Wire value of a state global */
const truthy = (v) => v === true || (typeof v === 'number' && v !== 0);

/** @param {string | undefined} raw a stored pref @returns {boolean} */
function storedOpen(raw) {
  if (typeof raw !== 'string') return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   entries: RestoreEntries | undefined,
 *   prefs: PrefsLike,
 *   clock?: FrameClock,
 *   log?: Pick<import('../engine/contracts').Log, 'warn'>,
 * }} deps `entries` is the sidecar's `restore` (none for a skin with no sidecar: everything is a no-op)
 */
export function createRestore({ entries, prefs, clock, log }) {
  const list = entries ?? [];
  /** @type {GlobalsAccess | null} */
  let globals = null;
  /** The last open/closed state seen or written, by pref. @type {Map<string, boolean>} */
  const last = new Map();
  /** @type {(() => void) | null} */
  let offFrame = null;
  let lastPoll = -Infinity;

  /** @param {string} name @returns {boolean | null} null when the read failed */
  function read(name) {
    try {
      return truthy(globals?.readGlobal(name));
    } catch {
      return null;                                          // unloaded realm, or no such global
    }
  }

  /** Reads each global and saves the prefs that changed. Cheap; safe to call after every dispatch. */
  function check() {
    if (!globals) return;
    for (const { global, pref } of list) {
      const open = read(global);
      if (open === null || last.get(pref) === open) continue;
      last.set(pref, open);
      try {
        prefs.write(PREFS_NS, pref, JSON.stringify(open));
      } catch (e) {
        log?.warn('restore: could not save the drawer state', { pref, error: String(e) });
      }
    }
  }

  /**
   * Starts watching a view and takes the baseline. `apply()` and `check()` need it.
   * @param {GlobalsAccess} access
   */
  function bind(access) {
    globals = access;
    offFrame?.();
    offFrame = null;
    last.clear();
    for (const { global, pref } of list) last.set(pref, read(global) ?? false);
    if (clock && list.length) {
      offFrame = clock.onFrame((now) => {
        if (now - lastPoll < POLL_MS) return;
        lastPoll = now;
        check();
      });
    }
  }

  /**
   * Reopens the drawers that were open. Call once, after `onload`.
   * @returns {Promise<string[]>} the toggles called
   */
  async function apply() {
    /** @type {string[]} */
    const called = [];
    if (!globals || !list.length) return called;
    /** @type {ReadonlyMap<string, string>} */
    let saved = new Map();
    try {
      saved = await prefs.load(PREFS_NS);
    } catch (e) {
      log?.warn('restore: could not read the saved drawer state', { error: String(e) });
    }
    for (const { global, toggle, pref } of list) {
      if (!globals) break;                                 // disposed while the prefs loaded
      if (storedOpen(saved.get(pref)) && read(global) === false) {
        try {
          globals.callGlobal(toggle, []);
          called.push(toggle);
        } catch (e) {
          log?.warn('restore: the toggle failed', { toggle, error: String(e) });
        }
      }
      last.set(pref, read(global) ?? false);               // the baseline is where the global now is
    }
    return called;
  }

  function dispose() {
    offFrame?.();
    offFrame = null;
    globals = null;
  }

  return { bind, apply, check, dispose };
}
