// @ts-check
// Sidecars (ENGINE.md D10.6): our own per-skin data, committed as `src/app/sidecars/<sha256>.json` and
// keyed by the SHA-256 of the archive it belongs to. This module validates one against
// `sidecar.schema.json` and hands the engine a frozen, normalised copy, or says what is wrong.
// Nothing here trusts a file just because it is ours: a typo in a committed sidecar is a bug that
// must stop at this door, not surface as a missing label in the engine.
//
// Two things the sidecar leaves to the host, said here because no key of the schema carries them:
//  - `attrs` are writes the host makes after layout, in the faithful and the oracle-compat
//    configuration alike (`compat.attrs` follow them, in compat only). An entry is an x- host-only
//    switch or an ordinary attribute of the element's kind. Headspace uses the second form for its
//    PLAYLIST: the slot widget (W3.7) is fed the element's attributes, the skin sets only
//    backgroundColor and foregroundColor, and WMP's defaults for the item colours (playing `#00FF00`,
//    selected background `#0A246A`) are not the colours the oracle's playlist.css paints. Four
//    entries on `pl` give the widget those colours: background `#285F03`, text `#FFFFFF`, playing
//    row `#A9FF2B`, selected background `#1C4702`. The selected row's text needs no entry: the
//    default (highlighttext) is white, which is what the oracle's `.row.sel` shows.
//  - The notice colour (the "Waiting for MPD..." line, E D10.3) has no sidecar key. The shell uses
//    the first TEXT, in document order, whose foregroundColor the skin declared (`el.source()` is
//    defined), then the hand port's green. The sidecar's own overlays are appended after the literal
//    pass, so they never come first. For Headspace that is `#77CE07`, the oracle's `--label`.
//
// The validator is a small interpreter for the subset of JSON Schema the schema file uses
// (`package.json` is pinned, so there is no Ajv). It reads the schema file itself, so the file and the
// validator cannot drift; a keyword it does not implement makes every validation fail closed, and a
// test walks the file for the same thing. Only the keys the schema names are copied into the result,
// so what the engine receives has no member that was not reviewed, and every free-form map (the
// overlay attribute table) is a null-prototype object.
//
// Refs (element ids) are skin-controlled strings (E §1 rule 6). Every table this module builds from
// them is a `Map`, so a skin that names an element `__proto__` or `constructor` gets a plain entry.
// The schema's own `$ref` pointers and type names come from our file, not from the data, and still
// go through Maps and `Object.hasOwn`, so a hostile sidecar cannot steer the interpreter either.

import schema from './sidecar.schema.json' with { type: 'json' };

/** @typedef {import('../engine/contracts').Sidecar} Sidecar */
/** @typedef {import('../engine/contracts').AttrValue} AttrValue */
/** @typedef {{ path: string, message: string }} SidecarProblem  `path` is a JSON pointer into the sidecar ('' is the root) */
/** @typedef {{ ok: true, sidecar: Sidecar, problems: [] } | { ok: false, sidecar: null, problems: SidecarProblem[] }} SidecarResult */
/** @typedef {Record<string, any>} SchemaNode */

export const SIDECAR_SCHEMA_ID = 'window_headmpd-sidecar/1';
/** A sidecar is a few KiB. The cap keeps a wrong file from being parsed at all. */
export const MAX_SIDECAR_CHARS = 64 * 1024;
const MAX_PROBLEMS = 50;
const SHA256 = /^[0-9a-f]{64}$/;

/** The schema, for tests and tooling. */
export const SIDECAR_SCHEMA = schema;

// ---- the schema subset ---------------------------------------------------------------------------------

/** Keywords that describe and never constrain. */
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', '$comment', 'default', 'examples']);
/** Keywords the interpreter implements. */
const KEYWORDS = new Set([
  '$ref', 'type', 'const', 'enum', 'properties', 'additionalProperties', 'required', 'propertyNames', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

/** @param {unknown} v */
const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** @type {ReadonlyMap<string, (v: unknown) => boolean>} */
const TYPE_TESTS = new Map([
  ['object', isPlainObject],
  ['array', (v) => Array.isArray(v)],
  ['string', (v) => typeof v === 'string'],
  ['number', (v) => typeof v === 'number' && Number.isFinite(v)],
  ['integer', (v) => typeof v === 'number' && Number.isInteger(v)],
  ['boolean', (v) => typeof v === 'boolean'],
  ['null', (v) => v === null],
]);

/**
 * Every keyword in the schema file that the interpreter does not implement, with where it is.
 * `$defs` is a container of named schemas, not a constraint, so it is walked and not listed.
 * @param {SchemaNode} root
 * @returns {string[]}
 */
export function unsupportedKeywords(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {SchemaNode} node @param {string} where */
  const walk = (node, where) => {
    if (!isPlainObject(node)) { found.push(`${where}: a schema must be an object`); return; }
    for (const key of Object.keys(node)) {
      if (key === '$defs') {
        for (const name of Object.keys(node.$defs)) walk(node.$defs[name], `${where}/$defs/${name}`);
      } else if (key === 'properties') {
        for (const name of Object.keys(node.properties)) walk(node.properties[name], `${where}/properties/${name}`);
      } else if (key === 'items' || key === 'propertyNames') {
        walk(node[key], `${where}/${key}`);
      } else if (key === 'additionalProperties') {
        if (node.additionalProperties !== false) walk(node.additionalProperties, `${where}/additionalProperties`);
      } else if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
        found.push(`${where}: unsupported keyword "${key}"`);
      } else if (key === '$ref') {
        const siblings = Object.keys(node).filter((k) => k !== '$ref' && !ANNOTATIONS.has(k));
        if (siblings.length) found.push(`${where}: $ref with sibling keywords (${siblings.join(', ')})`);
      }
    }
  };
  walk(root, '#');
  return found;
}

const SCHEMA_PROBLEMS = unsupportedKeywords(schema);

/** @type {Map<string, RegExp>} */
const REGEXPS = new Map();
/** @param {string} source */
const regexp = (source) => {
  let re = REGEXPS.get(source);
  if (!re) REGEXPS.set(source, (re = new RegExp(source, 'u')));
  return re;
};

/** A JSON pointer for a `$ref` of the form `#/$defs/name`; anything else is a schema bug. @param {string} ref */
function resolveRef(ref) {
  if (!ref.startsWith('#/')) throw new Error(`$ref "${ref}" is not a local pointer`);
  /** @type {any} */
  let node = schema;
  for (const part of ref.slice(2).split('/')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) throw new Error(`$ref "${ref}" does not resolve`);
    node = node[part];
  }
  return node;
}

/** A value, quoted and shortened for a message. @param {unknown} v */
function show(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 48 ? `${v.slice(0, 45)}...` : v);
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return 'an object';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'a non-finite number';
  return String(v);
}

/** @param {string} path @param {string} key */
const child = (path, key) => `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/**
 * Check `value` against `node` and return its normalised copy. Problems are pushed, never thrown;
 * when any were pushed the copy is meaningless and the caller drops it.
 * @param {SchemaNode} node @param {unknown} value @param {string} path @param {SidecarProblem[]} problems
 * @returns {any}
 */
function visit(node, value, path, problems) {
  /** @param {string} message */
  const bad = (message) => { if (problems.length < MAX_PROBLEMS) problems.push({ path, message }); };

  if (Object.hasOwn(node, '$ref')) return visit(resolveRef(node.$ref), value, path, problems);

  if (Object.hasOwn(node, 'const') && value !== node.const) { bad(`must be ${show(node.const)}, not ${show(value)}`); return undefined; }
  if (Object.hasOwn(node, 'enum') && !node.enum.includes(value)) {
    bad(`must be one of ${node.enum.map(show).join(', ')}, not ${show(value)}`);
    return undefined;
  }
  if (Object.hasOwn(node, 'type')) {
    /** @type {string[]} */
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => TYPE_TESTS.get(t)?.(value))) {
      bad(`must be ${types.join(' or ')}, not ${show(value)}`);
      return undefined;
    }
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) bad(`must be at least ${node.minLength} characters`);
    if (node.maxLength !== undefined && value.length > node.maxLength) bad(`must be at most ${node.maxLength} characters (is ${value.length})`);
    if (node.pattern !== undefined && !regexp(node.pattern).test(value)) bad(`${show(value)} does not match ${node.pattern}`);
    return value;
  }
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) bad(`must be at least ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) bad(`must be at most ${node.maximum}`);
    return value;
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) bad(`needs at least ${node.minItems} items`);
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      bad(`has ${value.length} items, at most ${node.maxItems} are allowed`);
      return undefined;                                       // do not walk an oversized array
    }
    return value.map((item, i) => (node.items ? visit(node.items, item, child(path, String(i)), problems) : item));
  }
  if (isPlainObject(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    const props = node.properties ?? {};
    const extra = node.additionalProperties;
    // A map of data-chosen keys is a null-prototype object; a record with the schema's own keys is plain.
    /** @type {Record<string, unknown>} */
    const out = isPlainObject(extra) ? Object.create(null) : {};
    for (const key of Object.keys(record)) {
      const at = child(path, key);
      if (Object.hasOwn(props, key)) {
        out[key] = visit(props[key], record[key], at, problems);
      } else if (extra === false || extra === undefined) {
        if (problems.length < MAX_PROBLEMS) problems.push({ path: at, message: 'unknown key' });
      } else {
        if (node.propertyNames?.pattern !== undefined && !regexp(node.propertyNames.pattern).test(key)) {
          if (problems.length < MAX_PROBLEMS) problems.push({ path: at, message: `the key ${show(key)} does not match ${node.propertyNames.pattern}` });
          continue;
        }
        out[key] = visit(extra, record[key], at, problems);
      }
    }
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(record, key)) bad(`is missing "${key}"`);
    }
    return out;
  }
  return value;                                               // boolean, null
}

/** @template T @param {T} v @returns {T} */
function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const key of Object.keys(v)) deepFreeze(/** @type {any} */ (v)[key]);
  }
  return v;
}

/** @param {SidecarProblem[]} problems @returns {SidecarResult} */
const failure = (problems) => ({ ok: false, sidecar: null, problems });

/**
 * Validate a parsed sidecar. Never throws. On success the sidecar is a deep, frozen copy holding only
 * the keys the schema names.
 * @param {unknown} raw
 * @param {{ sha?: string }} [opts] `sha`: the hash it is being loaded under; `skin` must equal it
 * @returns {SidecarResult}
 */
export function validateSidecar(raw, opts = {}) {
  try {
    if (SCHEMA_PROBLEMS.length) return failure(SCHEMA_PROBLEMS.map((message) => ({ path: '', message: `sidecar.schema.json: ${message}` })));
    /** @type {SidecarProblem[]} */
    const problems = [];
    const copy = visit(schema, raw, '', problems);
    if (!problems.length && opts.sha !== undefined && copy.skin !== opts.sha) {
      problems.push({ path: '/skin', message: `names ${show(copy.skin)}, but this sidecar is for ${show(opts.sha)}` });
    }
    if (problems.length) return failure(problems);
    return { ok: true, sidecar: /** @type {Sidecar} */ (deepFreeze(copy)), problems: [] };
  } catch (e) {
    return failure([{ path: '', message: `validator failure: ${e instanceof Error ? e.message : String(e)}` }]);
  }
}

/**
 * JSON text to a validated sidecar. Never throws.
 * @param {string} text @param {{ sha?: string }} [opts]
 * @returns {SidecarResult}
 */
export function parseSidecar(text, opts = {}) {
  if (typeof text !== 'string') return failure([{ path: '', message: 'a sidecar is JSON text' }]);
  if (text.length > MAX_SIDECAR_CHARS) return failure([{ path: '', message: `is ${text.length} characters; the cap is ${MAX_SIDECAR_CHARS}` }]);
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return failure([{ path: '', message: `is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }]);
  }
  return validateSidecar(raw, opts);
}

/** A sidecar that exists but does not validate. `problems` has every violation (at most 50). */
export class SidecarError extends Error {
  /** @param {string} sha @param {SidecarProblem[]} problems */
  constructor(sha, problems) {
    super(`sidecar ${sha.slice(0, 12)} is invalid: ${problems.map((p) => `${p.path || '/'} ${p.message}`).join('; ')}`);
    this.name = 'SidecarError';
    this.sha = sha;
    this.problems = problems;
  }
}

// ---- loading ---------------------------------------------------------------------------------------------

/**
 * Sidecar files by archive hash. Vite turns the glob into lazy imports, so a sidecar costs nothing
 * until its skin loads. Outside Vite (a plain Node script) `import.meta.glob` is not there and the
 * table stays empty.
 * @type {Map<string, () => Promise<unknown>>}
 */
const FILES = new Map();
try {
  for (const [file, load] of Object.entries(import.meta.glob('./sidecars/*.json', { import: 'default' }))) {
    const m = /([0-9a-f]{64})\.json$/.exec(file);
    if (m) FILES.set(m[1], load);
  }
} catch {
  // not running under Vite
}

/** @param {string} sha @returns {Promise<unknown>} undefined when there is no file */
const readCommitted = (sha) => FILES.get(sha)?.() ?? Promise.resolve(undefined);

/**
 * The sidecar for the archive with this SHA-256, or null when there is none (the common case: every
 * skin but Headspace). The hash is checked before any lookup. A file that exists but is invalid
 * throws a `SidecarError`: the shell should load the skin without it and say why.
 * @param {string} sha
 * @param {(sha: string) => Promise<unknown>} [source] where the JSON comes from; tests inject one
 * @returns {Promise<Sidecar | null>}
 */
export async function loadSidecar(sha, source = readCommitted) {
  if (typeof sha !== 'string' || !SHA256.test(sha)) return null;
  const raw = await source(sha);
  if (raw === undefined || raw === null) return null;
  const result = validateSidecar(raw, { sha });
  if (!result.ok) throw new SidecarError(sha, result.problems);
  return result.sidecar;
}

// ---- views of a sidecar --------------------------------------------------------------------------------

/**
 * The attribute overrides by element ref, in the order the engine applies them: `attrs` first, then,
 * only when `compat` is set (the oracle-compat configuration), the `compat` entries. A later entry
 * for the same name overrides an earlier one.
 * @param {Sidecar} sidecar @param {{ compat: boolean }} opts
 * @returns {Map<string, Array<{ name: string, value: AttrValue }>>}
 */
export function sidecarAttrs(sidecar, opts) {
  /** @type {Map<string, Array<{ name: string, value: AttrValue }>>} */
  const byRef = new Map();
  const entries = [...(sidecar.attrs ?? []), ...(opts.compat ? sidecar.compat?.attrs ?? [] : [])];
  for (const { ref, name, value } of entries) {
    const list = byRef.get(ref);
    if (list) list.push({ name, value });
    else byRef.set(ref, [{ name, value }]);
  }
  return byRef;
}

/**
 * Every element ref the sidecar names, with the places it names it (JSON pointers). The refs that
 * must resolve on the built model: overlay parents, attribute and compat refs, tour elements. Script
 * names (`restore`, `tour.toggle`, `tour.isOpen`) are not element refs and are not listed.
 * @param {Sidecar} sidecar
 * @returns {Map<string, string[]>}
 */
export function sidecarRefs(sidecar) {
  /** @type {Map<string, string[]>} */
  const refs = new Map();
  /** @param {string} ref @param {string} at */
  const add = (ref, at) => {
    const places = refs.get(ref);
    if (places) places.push(at);
    else refs.set(ref, [at]);
  };
  (sidecar.overlays ?? []).forEach((o, i) => add(o.parent, `/overlays/${i}/parent`));
  (sidecar.attrs ?? []).forEach((a, i) => add(a.ref, `/attrs/${i}/ref`));
  (sidecar.compat?.attrs ?? []).forEach((a, i) => add(a.ref, `/compat/attrs/${i}/ref`));
  const tour = /** @type {Record<string, any> | undefined} */ (sidecar.tour);
  if (tour) {
    for (const key of ['transport', 'eqHandle', 'plHandle', 'visNext', 'reset']) {
      if (typeof tour[key] === 'string') add(tour[key], `/tour/${key}`);
    }
    if (Array.isArray(tour.bands)) tour.bands.forEach((b, i) => { if (typeof b === 'string') add(b, `/tour/bands/${i}`); });
  }
  return refs;
}
