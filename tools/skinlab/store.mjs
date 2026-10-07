// Content-addressed golden keys, the committed manifest, and the local golden store (E D9).
//
// The key is the SHA-256 of canonical JSON {target, state, dpr, skinSha256, oraclePin,
// chromiumRevision, harnessVersion}. The manifest (tools/skinlab/goldens.manifest.json, committed)
// maps each key to hashes, popcount and bbox: facts about the art, never the art. The PNGs and masks
// themselves live under ~/Library/Caches/window_headmpd/skinlab/ and are verified against the
// manifest before use; a mismatch is "oracle drift", not something to repair silently.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { goldensDir } from './paths.mjs';

/** Bump when the capture procedure changes in a way that can change pixels or masks (stub replies,
 *  settle rules, launch flags, viewport). verify-legacy would catch a missed bump as drift. */
export const HARNESS_VERSION = 1;

export const MANIFEST_VERSION = 1;

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;
export const isSha256Hex = (s) => typeof s === 'string' && HEX64.test(s);

// ---- canonical JSON -------------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted by code unit at every depth, no whitespace, arrays in
 * order. Refuses what JSON would silently change (undefined, functions, NaN, Infinity, bigint).
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot encode ${typeof value}`);
  }
}

const KEY_FIELDS = ['target', 'state', 'dpr', 'skinSha256', 'oraclePin', 'chromiumRevision', 'harnessVersion'];

/** The golden key. Exactly the seven fields of E D9: a missing one is a bug, extras are ignored. */
export function goldenKey(parts) {
  const picked = {};
  for (const f of KEY_FIELDS) {
    if (parts[f] === undefined || parts[f] === null) throw new TypeError(`goldenKey: missing ${f}`);
    picked[f] = parts[f];
  }
  return sha256Hex(canonicalJson(picked));
}

// ---- masks ----------------------------------------------------------------------------------------

/**
 * Popcount and inclusive bounding box of a 1-bit mask in the legacy's layout (bit i = y*width + x,
 * least significant bit first, as main.js updateMask packs it). bbox is null for an empty mask.
 */
export function maskStats(bits, width, height) {
  const need = Math.ceil((width * height) / 8);
  if (bits.length !== need) throw new RangeError(`mask is ${bits.length} bytes, ${width}x${height} needs ${need}`);
  let popcount = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (bits[i >> 3] & (1 << (i & 7))) {
        popcount++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return { popcount, bbox: popcount ? { x0, y0, x1, y1 } : null };
}

// ---- manifest -------------------------------------------------------------------------------------

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** @returns {{version:number, oraclePin:string|null, entries:Map<string, object>}} */
export const emptyManifest = () => ({ version: MANIFEST_VERSION, oraclePin: null, entries: new Map() });

const isInt = (n) => Number.isInteger(n) && n >= 0;

function checkBbox(b, where) {
  if (b === null) return null;
  if (!b || typeof b !== 'object' || !['x0', 'y0', 'x1', 'y1'].every((k) => isInt(b[k]))) {
    throw new ManifestError(`${where}: bbox must be null or {x0,y0,x1,y1} integers`);
  }
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}

function checkEntry(key, e) {
  const where = `entry ${key}`;
  if (!isSha256Hex(key)) throw new ManifestError(`${where}: key is not 64 hex characters`);
  if (!e || typeof e !== 'object') throw new ManifestError(`${where}: not an object`);
  if (!isSha256Hex(e.pngSha256)) throw new ManifestError(`${where}: pngSha256 is not 64 hex characters`);
  if (!isSha256Hex(e.maskSha256)) throw new ManifestError(`${where}: maskSha256 is not 64 hex characters`);
  if (!isInt(e.popcount)) throw new ManifestError(`${where}: popcount must be a non-negative integer`);
  if (!e.provenance || typeof e.provenance !== 'object' || Array.isArray(e.provenance)) {
    throw new ManifestError(`${where}: provenance must be an object`);
  }
  return {
    pngSha256: e.pngSha256,
    maskSha256: e.maskSha256,
    popcount: e.popcount,
    bbox: checkBbox(e.bbox, where),
    provenance: sortDeep(e.provenance),
  };
}

export function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(`manifest is not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManifestError('manifest is not an object');
  if (raw.version !== MANIFEST_VERSION) throw new ManifestError(`manifest version ${raw.version}, expected ${MANIFEST_VERSION}`);
  if (raw.oraclePin !== null && !isSha256Hex(raw.oraclePin)) throw new ManifestError('oraclePin must be null or 64 hex characters');
  if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new ManifestError('entries must be an object');
  const entries = new Map();
  // JSON.parse makes "__proto__" an ordinary own key; checkEntry rejects it as a non-hex key.
  for (const [k, v] of Object.entries(raw.entries)) entries.set(k, checkEntry(k, v));
  return { version: raw.version, oraclePin: raw.oraclePin, entries };
}

const entryOrder = (a, b) => {
  const pa = a[1].provenance;
  const pb = b[1].provenance;
  return (
    String(pa.target).localeCompare(String(pb.target)) ||
    String(pa.state).localeCompare(String(pb.state)) ||
    (pa.dpr ?? 0) - (pb.dpr ?? 0) ||
    a[0].localeCompare(b[0])
  );
};

/** Stable text: entries ordered by target, state, dpr; fixed field order; two-space indent. */
export function serializeManifest(m) {
  const entries = {};
  for (const [k, e] of [...m.entries].sort(entryOrder)) {
    checkEntry(k, e);
    entries[k] = {
      pngSha256: e.pngSha256,
      maskSha256: e.maskSha256,
      popcount: e.popcount,
      bbox: e.bbox === null ? null : { x0: e.bbox.x0, y0: e.bbox.y0, x1: e.bbox.x1, y1: e.bbox.y1 },
      provenance: sortDeep(e.provenance),
    };
  }
  return `${JSON.stringify({ version: m.version, oraclePin: m.oraclePin, entries }, null, 2)}\n`;
}

export async function readManifest(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyManifest();
    throw e;
  }
  return parseManifest(text);
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export const writeManifest = (file, m) => writeAtomic(file, serializeManifest(m));

// ---- bless and verify, as pure functions over the manifest ----------------------------------------

export class BlessRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlessRefusal';
  }
}

/**
 * One capture, as the commands pass it around.
 * @typedef {{key:string, target:string, state:string, dpr:number, pngSha256:string, maskSha256:string,
 *            popcount:number, bbox:object|null}} Capture
 */

/**
 * Fold fresh captures into the manifest, per E D9: refuse when the oracle pin differs from the
 * manifest's unless `repin`; record the reason and the old hashes. Entries are replaced per
 * (target, state, dpr); entries recorded under another pin and not recaptured are dropped (their
 * keys can never be looked up again). Never mutates its input.
 * @returns {{manifest:object, changes:{state:string, dpr:number, action:'added'|'unchanged'|'replaced', previous:object|null}[], dropped:number}}
 */
export function applyBless(manifest, captures, { reason, oraclePin, repin = false, at = new Date().toISOString(), extra = {} }) {
  if (!reason || !String(reason).trim()) throw new BlessRefusal('bless needs a --reason');
  if (!isSha256Hex(oraclePin)) throw new TypeError('applyBless: oraclePin must be 64 hex characters');
  if (manifest.oraclePin !== null && manifest.oraclePin !== oraclePin && !repin) {
    throw new BlessRefusal(
      `the oracle pin changed (manifest ${manifest.oraclePin.slice(0, 12)}, now ${oraclePin.slice(0, 12)}): ` +
        'a pinned file differs from the one the goldens were blessed against. Re-run with --repin if that was intended.',
    );
  }
  const next = { version: manifest.version, oraclePin, entries: new Map() };
  const stale = new Set(); // blessed under another pin, so their keys can never be looked up again
  for (const [k, e] of manifest.entries) {
    if (e.provenance.oraclePin === oraclePin) next.entries.set(k, e);
    else stale.add(k);
  }
  // Old entries for the same (target, state, dpr), whichever key they sit under.
  const slot = (p) => `${p.target}\0${p.state}\0${p.dpr}`;
  const bySlot = new Map();
  for (const [k, e] of manifest.entries) bySlot.set(slot(e.provenance), [k, e]);

  const changes = [];
  for (const c of captures) {
    const old = bySlot.get(slot(c));
    const previous = old ? { key: old[0], pngSha256: old[1].pngSha256, maskSha256: old[1].maskSha256 } : null;
    if (old) stale.delete(old[0]); // replaced, not dropped: its hashes live on in `previous`
    if (old && old[0] === c.key && old[1].pngSha256 === c.pngSha256 && old[1].maskSha256 === c.maskSha256) {
      next.entries.set(c.key, old[1]);
      changes.push({ state: c.state, dpr: c.dpr, action: 'unchanged', previous });
      continue;
    }
    if (old) next.entries.delete(old[0]);
    next.entries.set(
      c.key,
      checkEntry(c.key, {
        pngSha256: c.pngSha256,
        maskSha256: c.maskSha256,
        popcount: c.popcount,
        bbox: c.bbox,
        provenance: { ...extra, target: c.target, state: c.state, dpr: c.dpr, oraclePin, reason: String(reason), blessedAt: at, previous },
      }),
    );
    changes.push({ state: c.state, dpr: c.dpr, action: old ? 'replaced' : 'added', previous });
  }
  return { manifest: next, changes, dropped: stale.size };
}

/**
 * Compare a fresh capture with the manifest.
 * `missing`: no entry under this key (never blessed, or the inputs of the key changed).
 * `drift`: the entry exists and a hash differs: the oracle moved under identical inputs.
 * @returns {{status:'ok'|'missing'|'drift', entry:object|null, diffs:string[]}}
 */
export function compareToManifest(manifest, capture) {
  const entry = manifest.entries.get(capture.key) ?? null;
  if (!entry) return { status: 'missing', entry: null, diffs: [] };
  const diffs = [];
  if (entry.pngSha256 !== capture.pngSha256) diffs.push('png');
  if (entry.maskSha256 !== capture.maskSha256) diffs.push('mask');
  return { status: diffs.length ? 'drift' : 'ok', entry, diffs };
}

// ---- local golden store ---------------------------------------------------------------------------

export function goldenPaths(key, root) {
  if (!isSha256Hex(key)) throw new TypeError('goldenPaths: key is not 64 hex characters');
  const dir = goldensDir(root);
  return { png: path.join(dir, `${key}.png`), mask: path.join(dir, `${key}.mask`) };
}

export async function saveGolden(key, { png, mask }, root) {
  const p = goldenPaths(key, root);
  await writeAtomic(p.png, png);
  await writeAtomic(p.mask, mask);
  return p;
}

/**
 * The stored golden, but only if both files exist and hash to the manifest entry. Anything else
 * returns null and the caller re-captures from the legacy and verifies against the manifest.
 */
export async function loadGolden(key, entry, root) {
  const p = goldenPaths(key, root);
  try {
    const [png, mask] = await Promise.all([readFile(p.png), readFile(p.mask)]);
    if (sha256Hex(png) !== entry.pngSha256 || sha256Hex(mask) !== entry.maskSha256) return null;
    return { png, mask, paths: p };
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}
