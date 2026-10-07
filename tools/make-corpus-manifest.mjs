#!/usr/bin/env node
// @ts-check
// Writes tests/corpus.manifest.json: every archive under skins/wmp and skins/wsz, as file name ->
// SHA-256. Names and hashes only; no art leaves the corpus (WAVES global rule 2). The corpus suites
// (`npm run corpus -- <suite>`, ENGINE D9) read it to pin exactly which archives they ran over.
//
//   node tools/make-corpus-manifest.mjs [--skins <dir>] [--out <file>]
//
// With the corpus absent it prints a skip and exits 0, leaving the committed manifest alone.
// Exit codes: 0 written or skipped, 2 bad usage, 1 an archive could not be read.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_SKINS_DIR = join(REPO_ROOT, 'skins');
export const MANIFEST_PATH = join(REPO_ROOT, 'tests', 'corpus.manifest.json');
export const MANIFEST_VERSION = 1;
/** The two corpora under skins/. */
export const KINDS = /** @type {const} */ (['wmp', 'wsz']);
const ARCHIVE_EXTENSIONS = ['.wmz', '.wsz', '.zip'];

/** @param {string} name case-insensitive: three corpus archives are `.WMZ` */
export const isArchiveName = (name) => ARCHIVE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/**
 * Regular files under `dir` (symlinks followed, since a worktree's skins/ is one), as names relative
 * to `dir` with `/` separators, in code-unit order so diffs are stable.
 * @param {string} dir
 * @param {(name: string) => boolean} [accept]
 * @returns {string[]}
 */
export function listArchives(dir, accept = isArchiveName) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      const st = statSync(join(dir, relPath));
      if (st.isDirectory()) walk(relPath);
      else if (st.isFile() && accept(entry)) found.push(relPath);
    }
  };
  walk('');
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** @param {string} path */
export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * @typedef {{ version: number, wmp: Map<string, string>, wsz: Map<string, string> }} CorpusManifest
 */

/**
 * Hash every archive. Lookups keyed by file name are Maps (ENGINE §1 rule 6): a file named
 * `__proto__` or `constructor` is just a name.
 * @param {string} skinsDir
 * @param {{ accept?: (name: string) => boolean }} [opts]
 * @returns {CorpusManifest}
 */
export function buildManifest(skinsDir, opts = {}) {
  /** @type {CorpusManifest} */
  const manifest = { version: MANIFEST_VERSION, wmp: new Map(), wsz: new Map() };
  for (const kind of KINDS) {
    const dir = join(skinsDir, kind);
    if (!existsSync(dir)) continue;
    for (const name of listArchives(dir, opts.accept)) manifest[kind].set(name, sha256File(join(dir, name)));
  }
  return manifest;
}

/** One entry per line, so a changed archive is a one-line diff. @param {CorpusManifest} m */
export function serialiseManifest(m) {
  const section = (/** @type {Map<string, string>} */ map) =>
    map.size ? `{\n${[...map].map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }` : '{}';
  return `{\n  "version": ${m.version},\n  "wmp": ${section(m.wmp)},\n  "wsz": ${section(m.wsz)}\n}\n`;
}

/**
 * Read a manifest file into Maps. Returns null when the file is absent.
 * @param {string} [path]
 * @returns {CorpusManifest|null}
 */
export function readManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    version: raw.version,
    wmp: new Map(Object.entries(raw.wmp ?? {})),
    wsz: new Map(Object.entries(raw.wsz ?? {})),
  };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { skins: DEFAULT_SKINS_DIR, out: MANIFEST_PATH };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--skins' || a === '--out') && argv[i + 1]) opts[a === '--skins' ? 'skins' : 'out'] = resolve(argv[++i]);
    else return null;
  }
  return opts;
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    console.error('usage: node tools/make-corpus-manifest.mjs [--skins <dir>] [--out <file>]');
    return 2;
  }
  const present = KINDS.filter((k) => existsSync(join(opts.skins, k)));
  if (!present.length) {
    console.log(`skip: no corpus at ${opts.skins} (expected skins/wmp and skins/wsz); manifest left as it is`);
    return 0;
  }
  let manifest;
  try {
    manifest = buildManifest(opts.skins);
  } catch (e) {
    console.error(`cannot read the corpus: ${/** @type {Error} */ (e).message}`);
    return 1;
  }
  for (const kind of KINDS) {
    const hashes = [...manifest[kind].values()];
    console.log(`${kind}: ${hashes.length} archives (${new Set(hashes).size} distinct SHA-256)`);
  }
  writeFileSync(opts.out, serialiseManifest(manifest));
  console.log(`wrote ${opts.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
