// Loading, validating and selecting the deviations allow-list (E §9, tools/skinlab/allowlist.json).
// The data is committed and reviewed by Opus; this module only refuses a malformed file and answers
// "which entries apply to this configuration and state". Lookups are Maps: a state id comes from the
// command line, and `__proto__` or `constructor` must be an unknown state, not an inherited member.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SKINLAB_DIR } from './paths.mjs';

export const ALLOWLIST_SCHEMA = 'window_headmpd-skinlab-allowlist/1';
export const ALLOWLIST_PATH = path.join(SKINLAB_DIR, 'allowlist.json');

export const CONFIGS = Object.freeze(['compat', 'faithful']);
export const KINDS = Object.freeze(['pixel-exclusion', 'pixel', 'mask']);

/** Region generators regions.mjs and cmd-check know how to produce, and the kind each may be. */
export const GENERATORS = new Map([
  ['effects-hole', ['pixel-exclusion']],
  ['screen-corners', ['mask']],
  ['unowned-buttongroup', ['pixel']],
  ['sliders', ['pixel']],
  ['faithful-xor-compat', ['mask']],
]);

export class AllowlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AllowlistError';
  }
}

const isInt = (n) => Number.isInteger(n) && n >= 0;

/**
 * @typedef {{ kind: 'rect', rect: [number, number, number, number] } | { kind: 'computed', generator: string }} Region
 * @typedef {{ id: string, kind: 'pixel-exclusion' | 'pixel' | 'mask', configs: string[], states: 'all' | string[],
 *             region: Region, bound: number | null, exact: boolean, ref: string, why: string }} AllowEntry
 */

function checkEntry(raw, index) {
  const where = `entries[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AllowlistError(`${where}: not an object`);
  const id = raw.id;
  if (typeof id !== 'string' || !id) throw new AllowlistError(`${where}: id must be a non-empty string`);
  const at = `entry "${id}"`;
  if (!KINDS.includes(raw.kind)) throw new AllowlistError(`${at}: kind must be one of ${KINDS.join(', ')}`);
  if (!Array.isArray(raw.configs) || !raw.configs.length || !raw.configs.every((c) => CONFIGS.includes(c))) {
    throw new AllowlistError(`${at}: configs must be a non-empty list of ${CONFIGS.join(', ')}`);
  }
  if (new Set(raw.configs).size !== raw.configs.length) throw new AllowlistError(`${at}: configs repeats a name`);
  if (raw.states !== 'all' && !(Array.isArray(raw.states) && raw.states.length && raw.states.every((s) => typeof s === 'string' && s))) {
    throw new AllowlistError(`${at}: states must be "all" or a non-empty list of state ids`);
  }
  const region = raw.region;
  if (!region || typeof region !== 'object') throw new AllowlistError(`${at}: region is missing`);
  if (region.kind === 'rect') {
    const r = region.rect;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(isInt) || r[2] <= r[0] || r[3] <= r[1]) {
      throw new AllowlistError(`${at}: rect must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0 (half-open, skin px)`);
    }
  } else if (region.kind === 'computed') {
    const kinds = GENERATORS.get(region.generator);
    if (!kinds) throw new AllowlistError(`${at}: unknown region generator "${region.generator}"`);
    if (!kinds.includes(raw.kind)) throw new AllowlistError(`${at}: generator ${region.generator} produces ${kinds.join('/')} regions, not ${raw.kind}`);
  } else {
    throw new AllowlistError(`${at}: region.kind must be "rect" or "computed"`);
  }
  let bound = raw.bound;
  if (bound === 'rect-area') {
    if (region.kind !== 'rect') throw new AllowlistError(`${at}: "rect-area" needs a rect region`);
    const [x0, y0, x1, y1] = region.rect;
    bound = (x1 - x0) * (y1 - y0);
  } else if (bound !== null && !isInt(bound)) {
    throw new AllowlistError(`${at}: bound must be a non-negative integer, null or "rect-area"`);
  }
  if (typeof raw.exact !== 'boolean') throw new AllowlistError(`${at}: exact must be true or false`);
  if (raw.exact && bound === null) throw new AllowlistError(`${at}: an exact entry needs a bound`);
  if (raw.kind === 'pixel-exclusion' && raw.states !== 'all') {
    throw new AllowlistError(`${at}: an exclusion applies to every state (a per-state exclusion would hide differences)`);
  }
  if (typeof raw.ref !== 'string' || !raw.ref) throw new AllowlistError(`${at}: ref (the deviation reference) is required`);
  if (typeof raw.why !== 'string' || !raw.why) throw new AllowlistError(`${at}: why is required`);
  return Object.freeze({
    id, kind: raw.kind, configs: Object.freeze([...raw.configs]),
    states: raw.states === 'all' ? 'all' : Object.freeze([...raw.states]),
    region: Object.freeze({ ...region }), bound, exact: raw.exact, ref: raw.ref, why: raw.why,
  });
}

/**
 * Parse and validate allowlist.json. `bound` comes back resolved ("rect-area" becomes the number).
 * @param {string} text
 * @returns {{ schema: string, entries: Map<string, AllowEntry> }} in file order
 */
export function parseAllowlist(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AllowlistError(`allowlist is not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AllowlistError('allowlist is not an object');
  if (raw.schema !== ALLOWLIST_SCHEMA) throw new AllowlistError(`allowlist schema is ${JSON.stringify(raw.schema)}, expected ${ALLOWLIST_SCHEMA}`);
  if (!Array.isArray(raw.entries)) throw new AllowlistError('allowlist entries must be an array');
  const entries = new Map();
  raw.entries.forEach((e, i) => {
    const entry = checkEntry(e, i);
    if (entries.has(entry.id)) throw new AllowlistError(`duplicate entry id "${entry.id}"`);
    entries.set(entry.id, entry);
  });
  return { schema: raw.schema, entries };
}

export async function readAllowlist(file = ALLOWLIST_PATH) {
  return parseAllowlist(await readFile(file, 'utf8'));
}

/**
 * The entries that apply to one configuration and state, in file order.
 * @param {{ entries: Map<string, AllowEntry> }} list
 * @param {{ config: string, state: string }} at
 * @returns {AllowEntry[]}
 */
export function activeEntries(list, { config, state }) {
  if (!CONFIGS.includes(config)) throw new AllowlistError(`unknown config "${config}" (known: ${CONFIGS.join(', ')})`);
  return [...list.entries.values()].filter((e) => e.configs.includes(config) && (e.states === 'all' || e.states.includes(state)));
}

/** What `check --strict` refuses: entries still in measure mode. @param {AllowEntry[]} entries @returns {string[]} */
export function strictViolations(entries) {
  return entries.filter((e) => e.bound === null).map((e) => `${e.id}: bound is null (measure mode); Opus records the measured bound`);
}

/**
 * Turn active entries into the `DiffEntry` list the compare functions take, generating each region.
 * @param {AllowEntry[]} entries
 * @param {{ width: number, height: number, rect: (r: readonly number[]) => Uint8Array,
 *           computed: (generator: string, entry: AllowEntry) => Uint8Array }} gen mask generators in skin px
 */
export function materialize(entries, gen) {
  return entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    bound: e.bound,
    exact: e.exact,
    mask: e.region.kind === 'rect' ? gen.rect(e.region.rect) : gen.computed(e.region.generator, e),
  }));
}
