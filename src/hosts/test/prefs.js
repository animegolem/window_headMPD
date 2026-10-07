// @ts-check
// In-memory PrefStore for the test host (ENGINE.md §5.8, D6.4). It enforces the same caps as the
// Rust store (D6.4, §10) so over-cap behaviour is testable without Rust: a rejected write is dropped
// and logged in `rejected`, which is what a test observes (the ledger entry itself is engine-side).
//
// Deliberately absent: namespace-name validation (the Rust store owns `^[0-9a-f]{64}$|app|mediacenter`,
// and the harness uses short names), and the 250 ms write-through debounce (a write is applied at
// once; the test host records it in `writes`).
//
// Keys come from skins (`theme.savePreference`), so every lookup here is a Map: `__proto__` and
// `constructor` are ordinary keys.

/** @typedef {import('../../engine/contracts').PrefStore} PrefStore */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/** @typedef {{ maxKeys: number, maxKeyBytes: number, maxValueBytes: number, maxNamespaceBytes: number }} PrefCaps */
/** @typedef {'key-bytes' | 'value-bytes' | 'key-count' | 'namespace-bytes'} RejectReason */
/** @typedef {{ ns: string, key: string, value: string | null }} PrefWrite */
/** @typedef {PrefWrite & { reason: RejectReason }} PrefRejection */
/** @typedef {Iterable<readonly [string, string]> | Record<string, string>} PrefEntries */
/**
 * @typedef {PrefStore & {
 *   readonly caps: Readonly<PrefCaps>,
 *   readonly writes: PrefWrite[],
 *   readonly rejected: PrefRejection[],
 *   seed(ns: string, entries: PrefEntries): void,
 *   external(ns: string, key: string, value: string | null): void,
 *   peek(ns: string): Map<string, string>,
 * }} MemoryPrefs
 */

/** D6.4: 256 keys, key <= 256 B, value <= 4 KiB, 64 KiB per namespace (keys plus values, UTF-8). */
export const PREF_CAPS = Object.freeze({
  maxKeys: 256,
  maxKeyBytes: 256,
  maxValueBytes: 4096,
  maxNamespaceBytes: 65536,
});

const encoder = new TextEncoder();
/** @param {string} s */
const bytes = (s) => encoder.encode(s).length;

/** @param {PrefEntries} entries @returns {Array<readonly [string, string]>} */
function entryPairs(entries) {
  if (entries instanceof Map) return [...entries];
  if (typeof entries[Symbol.iterator] === 'function') return [.../** @type {Iterable<readonly [string, string]>} */ (entries)];
  return Object.entries(/** @type {Record<string, string>} */ (entries));
}

/**
 * @param {{ caps?: Partial<PrefCaps> }} [opts] caps default to PREF_CAPS; tests lower them to stay small
 * @returns {MemoryPrefs}
 */
export function createMemoryPrefs(opts = {}) {
  const caps = Object.freeze({ ...PREF_CAPS, ...opts.caps });
  /** @type {Map<string, Map<string, string>>} */
  const store = new Map();
  /** @type {Map<string, Set<(key: string, value: string | null) => void>>} */
  const listeners = new Map();
  /** @type {PrefWrite[]} */
  const writes = [];
  /** @type {PrefRejection[]} */
  const rejected = [];

  /** @param {string} ns */
  const space = (ns) => {
    let m = store.get(ns);
    if (!m) store.set(ns, (m = new Map()));
    return m;
  };
  /** @param {Map<string, string>} m */
  const sizeOf = (m) => {
    let n = 0;
    for (const [k, v] of m) n += bytes(k) + bytes(v);
    return n;
  };

  /** @type {MemoryPrefs} */
  const prefs = {
    caps,
    writes,
    rejected,

    async load(ns) {
      return new Map(store.get(ns) ?? []);              // a copy: the engine keeps its own Map
    },

    write(ns, key, value) {
      if (typeof ns !== 'string' || typeof key !== 'string' || (value !== null && typeof value !== 'string')) {
        throw new TypeError('PrefStore.write(ns, key, value): ns and key are strings, value is a string or null');
      }
      const m = space(ns);
      if (value === null) {
        m.delete(key);
        writes.push({ ns, key, value });
        return;
      }
      /** @type {RejectReason | null} */
      let reason = null;
      if (bytes(key) > caps.maxKeyBytes) reason = 'key-bytes';
      else if (bytes(value) > caps.maxValueBytes) reason = 'value-bytes';
      else if (!m.has(key) && m.size >= caps.maxKeys) reason = 'key-count';
      else {
        const before = m.has(key) ? bytes(key) + bytes(/** @type {string} */ (m.get(key))) : 0;
        if (sizeOf(m) - before + bytes(key) + bytes(value) > caps.maxNamespaceBytes) reason = 'namespace-bytes';
      }
      if (reason) {
        rejected.push({ ns, key, value, reason });
        return;
      }
      m.set(key, value);
      writes.push({ ns, key, value });
    },

    onExternalChange(ns, cb) {
      let set = listeners.get(ns);
      if (!set) listeners.set(ns, (set = new Set()));
      set.add(cb);
      return () => { set.delete(cb); };
    },

    /** Replace a namespace's contents, as if the file already existed on disk. Bypasses caps, does not notify. */
    seed(ns, entries) {
      const next = new Map();
      for (const [k, v] of entryPairs(entries)) {
        if (typeof k !== 'string' || typeof v !== 'string') throw new TypeError('seed: keys and values are strings');
        next.set(k, v);
      }
      store.set(ns, next);
    },

    /** Another window wrote this key: apply it (it already passed that window's caps) and notify. */
    external(ns, key, value) {
      const m = space(ns);
      if (value === null) m.delete(key);
      else m.set(key, value);
      /** @type {unknown} */
      let failure = null;
      let failed = false;
      for (const cb of [...(listeners.get(ns) ?? [])]) {
        if (!listeners.get(ns)?.has(cb)) continue;
        try { cb(key, value); } catch (e) { if (!failed) { failed = true; failure = e; } }
      }
      if (failed) throw failure;
    },

    /** Synchronous copy of a namespace, for assertions. */
    peek: (ns) => new Map(store.get(ns) ?? []),
  };
  return prefs;
}
