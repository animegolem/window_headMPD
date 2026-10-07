// @ts-check
// Legacy prefs migration (ENGINE.md D10.8). The hand port kept eight values in `localStorage` (zoom, eq,
// balance, eqOpen, plOpen, onTop, allDesktops, preset). The engine keeps its host state in the Rust pref
// files instead (D6.4), so the first engine boot copies what the owner already set: the seven window and
// DSP values into the `app` namespace under the same names, and the visualizer preset into `mediacenter`
// as `effectPreset` (the key VizHost reads, D6.1). Host code may use `localStorage`; the engine may not.
//
// Value formats are the legacy's own, copied verbatim after a check, so the readers need no conversion
// step: `main.js`'s `store` JSON-stringified its values (`1.5`, `[0,0,...]`, `true`), and `viz/index.js`
// wrote `preset` as a bare integer. `src/hosts/tauri/dsp.js` parses `eq` and `balance` as that JSON.
//
// "Once": a marker key in `app` is written last. With it present nothing is read or written again, so a
// later change to the legacy keys (the owner flips back to the hand port and moves a slider) never
// overwrites what the engine has since saved. A key already present in the target namespace is kept for
// the same reason. The legacy keys themselves stay: until cutover the hand port still reads them.
//
// Never throws. A `localStorage` that throws (blocked site data, a private window) or a PrefStore that
// fails to load means "try again at the next launch": no marker is written.

/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'>} PrefsLike */
/** @typedef {{ getItem(key: string): string | null }} StorageLike */
/**
 * @typedef {{
 *   ran: boolean,
 *   copied: string[],
 *   skipped: Array<{ key: string, reason: string }>,
 *   error?: string,
 * }} MigrationResult
 *   `ran` is false when the marker was already there or the work could not start; `copied` lists the
 *   legacy key names written (not the target names).
 */

/** The legacy keys, in the order D10.8 lists them. */
export const LEGACY_KEYS = Object.freeze(['zoom', 'eq', 'balance', 'eqOpen', 'plOpen', 'onTop', 'allDesktops', 'preset']);

/** The `app` key whose presence means the migration has run. */
export const MIGRATED_MARKER = 'migrated.legacy-prefs';

/** Where each legacy key goes. `preset` is the one that changes name and namespace. */
const TARGETS = new Map([
  ['zoom', { ns: 'app', key: 'zoom' }],
  ['eq', { ns: 'app', key: 'eq' }],
  ['balance', { ns: 'app', key: 'balance' }],
  ['eqOpen', { ns: 'app', key: 'eqOpen' }],
  ['plOpen', { ns: 'app', key: 'plOpen' }],
  ['onTop', { ns: 'app', key: 'onTop' }],
  ['allDesktops', { ns: 'app', key: 'allDesktops' }],
  ['preset', { ns: 'mediacenter', key: 'effectPreset' }],
]);

/** A pref value is at most 4 KiB (D6.4); the legacy values are tiny, so anything near that is not ours. */
const MAX_VALUE_CHARS = 1024;

/** @param {unknown} v @returns {v is number} */
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Whether a legacy value is one the shell would have written. A stranger's `localStorage.zoom` of
 * `"banana"` must not become the window size.
 * @type {ReadonlyMap<string, (raw: string) => boolean>}
 */
const VALID = new Map([
  ['zoom', (raw) => { const v = parseJson(raw); return isFiniteNumber(v) && v >= 0.25 && v <= 4; }],
  ['eq', (raw) => { const v = parseJson(raw); return Array.isArray(v) && v.length <= 10 && v.every(isFiniteNumber); }],
  ['balance', (raw) => { const v = parseJson(raw); return isFiniteNumber(v) && v >= -100 && v <= 100; }],
  ['eqOpen', (raw) => typeof parseJson(raw) === 'boolean'],
  ['plOpen', (raw) => typeof parseJson(raw) === 'boolean'],
  ['onTop', (raw) => typeof parseJson(raw) === 'boolean'],
  ['allDesktops', (raw) => typeof parseJson(raw) === 'boolean'],
  ['preset', (raw) => /^\d{1,9}$/.test(raw)],
]);

/** @param {string} raw @returns {unknown} undefined when it is not JSON */
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {{ storage: StorageLike | null | undefined, prefs: PrefsLike }} deps
 *   `storage` is `localStorage` (null when the page has none); `prefs` is any PrefStore. In the app it
 *   must be a store whose writes land at once and that exists before the host does, because
 *   `createTauriDsp` loads the `app` namespace while the host is being built (see boot.js).
 * @returns {Promise<MigrationResult>}
 */
export async function migrateLegacyPrefs({ storage, prefs }) {
  /** @type {MigrationResult} */
  const result = { ran: false, copied: [], skipped: [] };
  try {
    if (!storage) return { ...result, error: 'no localStorage' };
    const [app, mediacenter] = await Promise.all([prefs.load('app'), prefs.load('mediacenter')]);
    if (app.has(MIGRATED_MARKER)) return result;

    /** @type {ReadonlyMap<string, ReadonlyMap<string, string>>} */
    const existing = new Map([['app', app], ['mediacenter', mediacenter]]);
    for (const legacy of LEGACY_KEYS) {
      const target = TARGETS.get(legacy);
      if (!target) continue;
      /** @type {string | null} */
      let raw = null;
      try {
        raw = storage.getItem(legacy);
      } catch {
        result.skipped.push({ key: legacy, reason: 'unreadable' });
        continue;
      }
      if (raw === null) continue;                                    // never set: nothing to carry over
      if (raw.length > MAX_VALUE_CHARS || !VALID.get(legacy)?.(raw)) {
        result.skipped.push({ key: legacy, reason: 'invalid' });
        continue;
      }
      if (existing.get(target.ns)?.has(target.key)) {
        result.skipped.push({ key: legacy, reason: 'already set' });
        continue;
      }
      prefs.write(target.ns, target.key, raw);
      result.copied.push(legacy);
    }
    prefs.write('app', MIGRATED_MARKER, '1');
    result.ran = true;
    return result;
  } catch (e) {
    return { ...result, ran: false, error: e instanceof Error ? e.message : String(e) };
  }
}
