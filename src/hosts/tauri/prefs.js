// @ts-check
// The Tauri PrefStore (ENGINE.md §5.8, D6.4): preferences live in Rust files, one per namespace
// (`prefs_load`, `prefs_write`), not in localStorage. A namespace loads into a Map before scripts run,
// so the engine reads synchronously; writes go through here, debounced.
//
//  - Writes are a trailing 250 ms debounce per (namespace, key): the latest value wins, `null` deletes,
//    and an intermediate value never reaches Rust. `flush()` sends everything pending at once (page
//    hide, tests). The IPC calls, `prefs_load` reads included, go out one after another in the order
//    they were made, so a slow write cannot be overtaken by the next one for the same key, and a read
//    never races a write.
//  - Caps (D6.4, §10) are checked here and again in Rust, because the webview is not a trust boundary:
//    256 keys, key <= 256 B, value <= 4 KiB, 64 KiB per namespace. The key-count and size caps need
//    the namespace's current contents, so they apply once it has been loaded; before that only the
//    per-item caps can. An over-cap write is dropped and logged (the engine's policy layer ledgers it
//    first, so this is the second wall, not the first).
//  - `load` returns what Rust has plus what the file may not show yet: `prefs-changed` events from other
//    windows that arrive once Rust has been asked to read (not while the load is still queued: Rust writes
//    the file before it sends the event and serves our read after that, so the snapshot already has such an
//    event, and keeping it could put an older value over our own write that landed in between), then this
//    window's own writes, the sent ones that have not settled (a write queued behind the read lands after
//    Rust has read the file) and the unsent ones waiting out the debounce. This window's own writes are
//    the newest and win.
//  - `prefs-changed` (`{ ns, key, value, window }`) goes to every window, the writer included, so an
//    event from this window's own label is skipped; the rest update the cache and reach
//    `onExternalChange` subscribers of that namespace.
//
// Namespaces are 64 lowercase hex (a skin), `app` or `mediacenter`; anything else is refused before
// the IPC. Keys come from skins, so every lookup is a Map and `__proto__` / `constructor` are just keys.
//
// `invoke` and `listen` are arguments (Tauri's `invoke` and `listen`), so this file loads in Node.

/** @typedef {import('../../engine/contracts').PrefStore} PrefStore */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {(cmd: string, args?: any) => Promise<unknown> | unknown} InvokeFn */
/** @typedef {(event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>} ListenFn Tauri's `listen` */
/** @typedef {{ maxKeys: number, maxKeyBytes: number, maxValueBytes: number, maxNamespaceBytes: number }} PrefCaps */
/** @typedef {'namespace' | 'key-bytes' | 'value-bytes' | 'key-count' | 'namespace-bytes'} RejectReason */
/** @typedef {{ ns: string, key: string, value: string | null, reason: RejectReason }} PrefRejection */
/**
 * @typedef {{
 *   invoke: InvokeFn,
 *   listen: ListenFn,
 *   label: string,
 *   setTimer?: (ms: number, cb: () => void) => unknown,
 *   clearTimer?: (id: any) => void,
 *   debounceMs?: number,
 *   caps?: Partial<PrefCaps>,
 *   log?: Pick<Log, 'warn'>,
 * }} TauriPrefsOptions
 *   `label` is this window's Tauri label (its own `prefs-changed` echoes are skipped). The timer pair
 *   is the engine clock's shape (default: the page's setTimeout).
 * @typedef {PrefStore & {
 *   readonly caps: Readonly<PrefCaps>,
 *   readonly rejected: readonly PrefRejection[],
 *   flush(): Promise<void>,
 *   pending(): number,
 *   dispose(): void,
 * }} TauriPrefs
 */

/** D6.4: 256 keys, key <= 256 B, value <= 4 KiB, 64 KiB per namespace (keys plus values, UTF-8). */
export const PREF_CAPS = Object.freeze({
  maxKeys: 256,
  maxKeyBytes: 256,
  maxValueBytes: 4096,
  maxNamespaceBytes: 65536,
});
export const PREF_DEBOUNCE_MS = 250;
export const PREFS_CHANGED_EVENT = 'prefs-changed';
/** Rejections kept for inspection; older ones fall off. */
const MAX_REMEMBERED_REJECTIONS = 64;

const NS_PATTERN = /^(?:[0-9a-f]{64}|app|mediacenter)$/;
const encoder = new TextEncoder();
/** @param {string} s */
const bytes = (s) => encoder.encode(s).length;
/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/** @param {Map<string, string>} m */
function sizeOf(m) {
  let n = 0;
  for (const [k, v] of m) n += bytes(k) + bytes(v);
  return n;
}

/**
 * @param {TauriPrefsOptions} opts
 * @returns {TauriPrefs}
 */
export function createTauriPrefs(opts) {
  const { invoke, listen, label } = opts;
  const caps = Object.freeze({ ...PREF_CAPS, ...opts.caps });
  const debounceMs = opts.debounceMs ?? PREF_DEBOUNCE_MS;
  const setTimer = opts.setTimer ?? ((/** @type {number} */ ms, /** @type {() => void} */ cb) => globalThis.setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((/** @type {any} */ id) => globalThis.clearTimeout(id));
  /** @param {string} m @param {object} [d] */
  const warn = (m, d) => {
    if (opts.log) opts.log.warn(m, d);
    else console.warn(m, d);
  };

  /** What this window believes each loaded namespace holds: Rust's contents plus its own writes. @type {Map<string, Map<string, string>>} */
  const cache = new Map();
  /** Writes waiting out the debounce: ns -> key -> { value, timer }. @type {Map<string, Map<string, { value: string | null, timer: unknown }>>} */
  const pending = new Map();
  /** Writes handed to the IPC queue that have not settled yet: ns -> key -> { value }. A load that is being
   * read right now may have taken its snapshot before such a write landed. @type {Map<string, Map<string, { value: string | null }>>} */
  const inflight = new Map();
  /** One collector per `load` whose read has started, ns -> collectors: the `prefs-changed` events that arrive
   * from then until the reply (key -> value, null = deleted). A Set, because one namespace can be loading more
   * than once at a time.
   * @type {Map<string, Set<Map<string, string | null>>>} */
  const loading = new Map();
  /** @type {PrefRejection[]} */
  const rejected = [];
  /** @type {Map<string, Set<{ cb: (key: string, value: string | null) => void }>>} */
  const subs = new Map();
  /** The IPC calls made so far, strung together so they run in order. @type {Promise<void>} */
  let tail = Promise.resolve();
  /** @type {Promise<() => void> | null} */
  let listening = null;
  let disposed = false;

  /** @param {string} ns @param {string} key @param {string | null} value @param {RejectReason} reason */
  function reject(ns, key, value, reason) {
    rejected.push({ ns, key, value, reason });
    if (rejected.length > MAX_REMEMBERED_REJECTIONS) rejected.shift();
    warn(`prefs: write dropped (${reason})`, { ns: ns.slice(0, 12), keyBytes: bytes(key) });
  }

  /** Queue one IPC call behind the earlier ones. `onStart` runs in the queued step, just before the call goes
   * out. @param {string} cmd @param {any} args @param {() => void} [onStart] */
  function enqueue(cmd, args, onStart) {
    const run = tail.then(() => { onStart?.(); return invoke(cmd, args); });
    tail = run.then(() => undefined, (e) => { warn(`prefs: ${cmd} failed: ${messageOf(e)}`); });
    return run;
  }

  /** @param {string} ns @param {string} key */
  function flushKey(ns, key) {
    const entries = pending.get(ns);
    const entry = entries?.get(key);
    if (!entries || !entry) return;
    clearTimer(entry.timer);
    entries.delete(key);
    if (entries.size === 0) pending.delete(ns);
    // Pending -> in flight in the same step, so a load always sees the write in one place or the other.
    const sent = { value: entry.value };
    let sentKeys = inflight.get(ns);
    if (!sentKeys) inflight.set(ns, (sentKeys = new Map()));
    sentKeys.set(key, sent);
    const settled = () => {
      const keys = inflight.get(ns);
      if (keys?.get(key) !== sent) return;                   // a newer write to this key is on its way: leave it
      keys.delete(key);
      if (keys.size === 0) inflight.delete(ns);
    };
    enqueue('prefs_write', { ns, key, value: entry.value }).then(settled, settled);   // failures are logged by `enqueue`'s tail
  }

  /** @param {string} ns @param {string} key @param {string | null} value */
  function schedule(ns, key, value) {
    let entries = pending.get(ns);
    if (!entries) pending.set(ns, (entries = new Map()));
    const old = entries.get(key);
    if (old) clearTimer(old.timer);
    const timer = setTimer(debounceMs, () => flushKey(ns, key));
    entries.set(key, { value, timer });
  }

  /** @param {{ payload: unknown }} event */
  function onChanged(event) {
    const p = /** @type {Record<string, unknown> | null} */ (event?.payload ?? null);
    if (!p || typeof p !== 'object') return;
    if (p.window === label) return;                          // our own write, echoed back
    const { ns, key } = p;
    if (typeof ns !== 'string' || typeof key !== 'string') return;
    if (p.value !== null && typeof p.value !== 'string') return;
    const value = /** @type {string | null} */ (p.value);
    if (!NS_PATTERN.test(ns)) return;
    const cached = cache.get(ns);
    if (cached) {
      if (value === null) cached.delete(key);
      else cached.set(key, value);
    }
    // No cache entry is made here when there is none: write() would take the namespace for loaded and
    // check its caps against an incomplete Map. A load still reading takes the event instead.
    for (const col of loading.get(ns) ?? []) col.set(key, value);
    for (const sub of [...(subs.get(ns) ?? [])]) {
      if (!subs.get(ns)?.has(sub)) continue;
      try { sub.cb(key, value); } catch (e) { warn(`prefs: an onExternalChange callback threw: ${messageOf(e)}`); }
    }
  }

  function ensureListening() {
    if (listening || disposed) return;
    listening = Promise.resolve(listen(PREFS_CHANGED_EVENT, onChanged));
    listening.catch((e) => {
      listening = null;
      warn(`prefs: could not listen for ${PREFS_CHANGED_EVENT}: ${messageOf(e)}`);
    });
  }

  /** @type {TauriPrefs} */
  const prefs = {
    caps,
    rejected,

    async load(ns) {
      if (typeof ns !== 'string' || !NS_PATTERN.test(ns)) throw new TypeError(`prefs: "${String(ns).slice(0, 80)}" is not a namespace (64 hex, app or mediacenter)`);
      ensureListening();
      // The read goes through the same queue as the writes: those sent before it land first, those sent
      // after it wait behind it. (`run` rejects to the caller; `enqueue`'s tail logs the failure.)
      // Another window can write, and Rust's `prefs-changed` reach us, between Rust reading the file and the
      // reply arriving; `seen` collects those events so the snapshot does not hide them. It starts collecting
      // when the read is about to go out, not when `load` is called: an event that arrives while the load is
      // still queued is already in the snapshot (Rust writes the file, then sends the event, and serves our
      // read after that), and it may be older than a write of ours that lands before the read.
      /** @type {Map<string, string | null>} */
      const seen = new Map();
      /** @type {Map<string, string>} */
      const map = new Map();
      try {
        const raw = await enqueue('prefs_load', { ns }, () => {
          if (disposed) return;                              // dispose() cleared `loading`: do not refill it
          let collectors = loading.get(ns);
          if (!collectors) loading.set(ns, (collectors = new Set()));
          collectors.add(seen);
        });
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') map.set(k, v);
        }
      } finally {
        // The Set may not exist (the read never started, or dispose() ran); deleting a non-member is a no-op.
        const collectors = loading.get(ns);
        if (collectors) {
          collectors.delete(seen);
          if (collectors.size === 0) loading.delete(ns);
        }
      }
      // What the snapshot may not show, oldest first: other windows' events from during the read, then this
      // window's sent writes (queued behind this read, or settled while it was in flight), then its unsent
      // ones, which are the newest.
      for (const [k, v] of seen) {
        if (v === null) map.delete(k);
        else map.set(k, v);
      }
      for (const writes of [inflight.get(ns), pending.get(ns)]) {
        for (const [k, entry] of writes ?? []) {
          if (entry.value === null) map.delete(k);
          else map.set(k, entry.value);
        }
      }
      cache.set(ns, map);
      return new Map(map);                                   // the engine keeps its own copy
    },

    write(ns, key, value) {
      if (typeof ns !== 'string' || typeof key !== 'string' || (value !== null && typeof value !== 'string')) {
        throw new TypeError('PrefStore.write(ns, key, value): ns and key are strings, value is a string or null');
      }
      if (disposed) return;
      if (!NS_PATTERN.test(ns)) return reject(ns, key, value, 'namespace');
      const known = cache.get(ns);
      if (value === null) {
        known?.delete(key);
      } else {
        /** @type {RejectReason | null} */
        let reason = null;
        if (bytes(key) > caps.maxKeyBytes) reason = 'key-bytes';
        else if (bytes(value) > caps.maxValueBytes) reason = 'value-bytes';
        else if (known) {
          if (!known.has(key) && known.size >= caps.maxKeys) reason = 'key-count';
          else {
            const before = known.has(key) ? bytes(key) + bytes(/** @type {string} */ (known.get(key))) : 0;
            if (sizeOf(known) - before + bytes(key) + bytes(value) > caps.maxNamespaceBytes) reason = 'namespace-bytes';
          }
        }
        if (reason) return reject(ns, key, value, reason);
        known?.set(key, value);
      }
      schedule(ns, key, value);
    },

    onExternalChange(ns, cb) {
      ensureListening();
      let set = subs.get(ns);
      if (!set) subs.set(ns, (set = new Set()));
      const sub = { cb };
      set.add(sub);
      return () => { set.delete(sub); };
    },

    async flush() {
      for (const [ns, entries] of [...pending]) for (const key of [...entries.keys()]) flushKey(ns, key);
      await tail;
    },

    pending() {
      let n = 0;
      for (const entries of pending.values()) n += entries.size;
      return n;
    },

    dispose() {
      disposed = true;
      for (const entries of pending.values()) for (const e of entries.values()) clearTimer(e.timer);
      pending.clear();
      inflight.clear();
      loading.clear();
      subs.clear();
      const l = listening;
      listening = null;
      l?.then((unlisten) => unlisten(), () => {});
    },
  };
  return prefs;
}
