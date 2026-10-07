// @ts-check
// `mediacenter`: the undocumented settings object WMP's full mode shares with skins (U-14, E D6).
// Eight documented keys persist in the host-global `mediacenter` namespace and fire change events;
// any other key a script sets lives for the session only and is ledgered, because a store shared
// across skins would be a channel between them.
//
// The namespace is a `PrefStore` namespace, which loads asynchronously, but a skin reads
// `mediacenter.effectPreset` from its first handler. So the object starts from the attribute
// defaults, applies the stored values when they arrive (never over a key a script has already
// written), and reports that moment as `Env.ready`. A caller that already holds the loaded map passes
// it in `deps.mediacenterPrefs` and the object is correct from the start.

import { attrSpec } from '../../wms/attrs.js';
import { coerce } from '../../wms/values.js';
import { MEDIACENTER_KEYS, apiName } from '../schema.js';
import { isHandle, keyOf, makeObject } from './core.js';

/** @typedef {import('./core.js').GraphObject} GraphObject */
/** @typedef {import('./core.js').Handler} Handler */

/** The namespace of E D6.4. */
export const MEDIACENTER_NS = 'mediacenter';
/** Session-only keys: how many, and how long a string value may be. */
const MAX_SESSION_KEYS = 64;
const MAX_SESSION_VALUE_CHARS = 4096;

/** The documented key by its lowercased name. A Map: a skin chooses the names. @type {ReadonlyMap<string, string>} */
const CANON = new Map(MEDIACENTER_KEYS.map((k) => [k.toLowerCase(), k]));

/**
 * @param {import('./index.js').Env} env
 * @returns {{ object: GraphObject, ready: Promise<void> }}
 */
export function createMediacenterObject(env) {
  const { host, hub, ledger } = env;
  /** @type {Map<string, string>} canonical key -> the stored text */
  const stored = new Map();
  /** @type {Set<string>} keys this session has written, which a late load must not overwrite */
  const written = new Set();
  /** @type {Map<string, import('../../contracts').Wire>} */
  const session = new Map();

  /** @param {string} key */
  const channel = (key) => `mediacenter.${key.toLowerCase()}`;

  /** @param {string} key @returns {import('../../contracts').Wire} the value as the attribute's own type */
  function read(key) {
    const spec = /** @type {import('../../contracts').AttrSpec} */ (attrSpec('mediacenter', key));
    const raw = stored.get(key);
    return /** @type {import('../../contracts').Wire} */ (raw === undefined ? spec.default : coerce(spec.type, raw, spec.default));
  }

  /** @param {string} key @param {unknown} v */
  function write(key, v) {
    const spec = /** @type {import('../../contracts').AttrSpec} */ (attrSpec('mediacenter', key));
    const prev = read(key);
    const next = coerce(spec.type, v, prev);               // invalid input keeps the previous value (U-20)
    const raw = String(next);
    if (written.has(key) && stored.get(key) === raw) return;       // already persisted exactly this
    written.add(key);
    stored.set(key, raw);
    host.prefs.write(MEDIACENTER_NS, key, raw);
    if (!Object.is(next, prev)) hub.emit(channel(key));
  }

  /** Apply values from the store; a key the script has written is left alone. @param {ReadonlyMap<string, string>} map */
  function apply(map) {
    for (const [name, raw] of map) {
      const key = CANON.get(name.toLowerCase());
      if (key === undefined || written.has(key) || stored.get(key) === raw) continue;
      const prev = read(key);
      stored.set(key, raw);
      if (!Object.is(read(key), prev)) hub.emit(channel(key));
    }
  }

  /** @type {Record<string, Handler>} */
  const handlers = {};
  for (const key of MEDIACENTER_KEYS) handlers[key] = { get: () => read(key), set: (v) => write(key, v) };

  const object = makeObject(env, 'mediacenter', handlers, {
    fallback: {
      get(name) {
        const key = keyOf(name);
        if (!session.has(key)) ledger.record(apiName('mediacenter', key), 'unknown-member', 'session-only key; read before it was set');
        return session.get(key);
      },
      set(name, v) {
        const key = keyOf(name);
        ledger.record(apiName('mediacenter', key), 'unknown-member', 'session-only key; not persisted');
        if (isHandle(v) || (!session.has(key) && session.size >= MAX_SESSION_KEYS)) return;
        session.set(key, typeof v === 'string' ? v.slice(0, MAX_SESSION_VALUE_CHARS) : v);
      },
    },
  });

  env.cleanup.push(host.prefs.onExternalChange(MEDIACENTER_NS, (name, value) => {
    const key = CANON.get(name.toLowerCase());
    if (key === undefined) return;
    const prev = read(key);
    if (value === null) stored.delete(key); else stored.set(key, value);
    written.delete(key);
    if (!Object.is(read(key), prev)) hub.emit(channel(key));
  }));

  /** @type {Promise<void>} */
  let ready;
  if (env.mediacenterPrefs) {
    apply(env.mediacenterPrefs);
    ready = Promise.resolve();
  } else {
    ready = host.prefs.load(MEDIACENTER_NS).then(apply, (e) => { host.log.warn(`mediacenter prefs: ${e instanceof Error ? e.message : String(e)}`); });
  }
  return { object, ready };
}
