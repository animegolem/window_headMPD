// @ts-check
// Which front end boots: the hand-ported legacy app or the skin engine (ENGINE.md §2, D10.9).
// `src/entry.js` calls this once at load. W6.1 flips DEFAULT_MODE at cutover time.

/** @typedef {'legacy' | 'engine'} Mode */

/** @type {Mode} What an unconfigured launch boots. */
export const DEFAULT_MODE = 'legacy';

/**
 * One reader per place the flag can live, strongest first. Each returns the raw string (or
 * null/undefined when the place has nothing), and may throw: `localStorage` can throw on access in
 * a private window or with site data blocked, and Node 25+ throws without a storage file.
 * @typedef {object} ModeSources
 * @property {() => string | null | undefined} query    `?engine=` in the page URL
 * @property {() => string | null | undefined} storage  `localStorage.engine`
 * @property {() => string | null | undefined} env      `VITE_ENGINE` at build or dev-server start
 */

/** @type {ModeSources} */
const defaultSources = {
  query: () => new URLSearchParams(globalThis.location.search).get('engine'),
  storage: () => globalThis.localStorage.getItem('engine'),
  env: () => import.meta.env.VITE_ENGINE,
};

/**
 * Parse one flag value. `'wmp'` is the engine token in all three places, `'legacy'` is the explicit
 * opt-out (so `?engine=legacy` can override a stored `wmp`, and stays reachable after W6.1 flips
 * the default). Anything else counts as "not set" and the next source decides. This is a chain of
 * comparisons, not an object lookup, so `__proto__` and `constructor` are just unknown values.
 * @param {unknown} value
 * @returns {Mode | undefined}
 */
function parseFlag(value) {
  if (value === 'wmp') return 'engine';
  if (value === 'legacy') return 'legacy';
  return undefined;
}

/**
 * The first source that holds a recognised value decides: query, then storage, then env, then
 * DEFAULT_MODE. A source that throws is skipped, never fatal.
 * @param {ModeSources} [sources] injectable for tests; the page's own sources by default
 * @returns {Mode}
 */
export function resolveMode(sources = defaultSources) {
  for (const read of [sources.query, sources.storage, sources.env]) {
    try {
      const mode = parseFlag(read());
      if (mode) return mode;
    } catch {
      // unreadable source: fall through to the next one
    }
  }
  return DEFAULT_MODE;
}
