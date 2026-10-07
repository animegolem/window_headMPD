// @ts-check
// Fixture resolution for tests that need art we do not own (ENGINE D9). Node only (it reads files and
// wraps vitest's `describe`); the writers next to it are the browser-safe part.
//
//   describeHeadspace('keying', (headspace) => { it('...', () => { headspace.bytes() ... }) })
//   describeCorpus('zip', (corpus) => { it.each(corpus.archives('wmp')) ... })
//
// A missing or wrong fixture makes the whole suite skip with the reason in its title (WAVES global
// rule 4: art-dependent tests skip, never fail, when the art is absent). Read the fixture inside the
// tests, not while the describe body runs: on a skip the body still runs to register the skipped
// tests, and `bytes()` then throws.
//
// The Headspace path is `SKINLAB_HEADSPACE`, default `~/Downloads/Headspace.wmz`, the same variable
// `tools/skinlab/paths.mjs` reads. The corpus is `skins/` at the repo root (a symlink in a worktree).

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe } from 'vitest';
import { DEFAULT_SKINS_DIR, KINDS, MANIFEST_PATH, REPO_ROOT, listArchives, readManifest } from '../../tools/make-corpus-manifest.mjs';
import { minimalSkin } from './wms-builder.js';

export { REPO_ROOT, MANIFEST_PATH };

/** SHA-1 of the owner's `Headspace.wmz` (parity: "wmz sha1 f9671f06…"). */
export const HEADSPACE_SHA1 = 'f9671f0601052547f5bddf6b5026c4a83d14d0a5';

/** @param {string} p `~` and `~/…` expand to the home directory */
const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/**
 * @typedef {Object} HeadspaceFixture
 * @property {string} path
 * @property {'ok'|'absent'|'not-a-file'|'wrong-sha1'} status
 * @property {boolean} ok
 * @property {string} [sha1]      actual SHA-1, when the file was readable
 * @property {string} reason      empty when ok
 * @property {() => Uint8Array} bytes   the archive; throws unless ok
 */

/**
 * @param {{ env?: Record<string, string|undefined>, path?: string, expectedSha1?: string }} [opts]
 * @returns {HeadspaceFixture}
 */
export function resolveHeadspace(opts = {}) {
  const env = opts.env ?? process.env;
  const path = resolve(expandHome(opts.path ?? env.SKINLAB_HEADSPACE ?? '~/Downloads/Headspace.wmz'));
  const expected = opts.expectedSha1 ?? HEADSPACE_SHA1;
  /** @type {(status: HeadspaceFixture['status'], reason: string, sha1?: string) => HeadspaceFixture} */
  const result = (status, reason, sha1) => ({
    path, status, ok: status === 'ok', sha1, reason,
    bytes() {
      if (status !== 'ok') throw new Error(`Headspace fixture unavailable: ${reason}`);
      return new Uint8Array(readFileSync(path));
    },
  });
  if (!existsSync(path)) return result('absent', `no Headspace.wmz at ${path} (set SKINLAB_HEADSPACE)`);
  if (!statSync(path).isFile()) return result('not-a-file', `${path} is not a regular file`);
  const sha1 = createHash('sha1').update(readFileSync(path)).digest('hex');
  if (sha1 !== expected) return result('wrong-sha1', `${path} has sha1 ${sha1}, expected ${expected.slice(0, 8)}…`, sha1);
  return result('ok', '', sha1);
}

/** @type {HeadspaceFixture|undefined} */
let headspaceCache;
/** The fixture the environment points at, resolved once per process. */
export const headspaceFixture = () => (headspaceCache ??= resolveHeadspace());

/**
 * @typedef {Object} CorpusFixture
 * @property {string} root
 * @property {boolean} ok
 * @property {string} reason   empty when ok
 * @property {(kind: 'wmp'|'wsz') => Array<{ kind: 'wmp'|'wsz', name: string, path: string }>} archives
 *   every archive of one corpus, sorted by name; `it.each` friendly
 * @property {(entry: { path: string }) => Uint8Array} read
 * @property {() => ReturnType<typeof loadCorpusManifest>} manifest
 */

/** @param {{ root?: string }} [opts] @returns {CorpusFixture} */
export function resolveCorpus(opts = {}) {
  const root = opts.root ?? DEFAULT_SKINS_DIR;
  const present = KINDS.filter((k) => existsSync(join(root, k)));
  const reason = present.length === KINDS.length ? '' : `no corpus at ${root} (needs skins/wmp and skins/wsz)`;
  return {
    root,
    ok: !reason,
    reason,
    archives(kind) {
      if (reason) return [];
      return listArchives(join(root, kind)).map((name) => ({ kind, name, path: join(root, kind, name) }));
    },
    read: (entry) => new Uint8Array(readFileSync(entry.path)),
    manifest: () => loadCorpusManifest(),
  };
}

/** @type {CorpusFixture|undefined} */
let corpusCache;
export const corpusFixture = () => (corpusCache ??= resolveCorpus());

/**
 * The committed manifest as Maps keyed by archive name (names come from outside, so no plain
 * objects). Null if the file is missing.
 * @param {string} [path]
 */
export function loadCorpusManifest(path = MANIFEST_PATH) {
  return readManifest(path);
}

/**
 * `describe` that skips with the reason in the suite title when the fixture is unusable.
 * `d` is injectable so the wrapper itself can be tested.
 * @template {{ ok: boolean, reason: string }} F
 * @param {F} fixture @param {string} name @param {(fixture: F) => void} fn
 * @param {Pick<typeof describe, 'skip'> & ((name: string, fn: () => void) => unknown)} [d]
 */
export function describeWithFixture(fixture, name, fn, d = describe) {
  if (fixture.ok) return d(name, () => fn(fixture));
  return d.skip(`${name} [skipped: ${fixture.reason}]`, () => fn(fixture));
}

/** @param {string} name @param {(headspace: HeadspaceFixture) => void} fn */
export const describeHeadspace = (name, fn) => describeWithFixture(headspaceFixture(), name, fn);

/** @param {string} name @param {(corpus: CorpusFixture) => void} fn */
export const describeCorpus = (name, fn) => describeWithFixture(corpusFixture(), name, fn);

/**
 * Write a synthetic skin to a fresh directory outside the repo and return the path, for
 * `WINDOW_HEADMPD_SKIN=<path>` (WAVES in-app smoke E6) and for tests that need a file.
 * `node -e "import('./tests/support/fixtures.js').then(m => console.log(m.writeTempSkin({ onclick: 'while(1){}' })))"`
 * @param {import('./wms-builder.js').SkinOptions} [opts]
 * @param {{ dir?: string }} [where]
 * @returns {string} path of the `.wmz`
 */
export function writeTempSkin(opts = {}, where = {}) {
  const skin = minimalSkin(opts);
  const dir = where.dir ?? mkdtempSync(join(tmpdir(), 'headmpd-skin-'));
  const path = join(dir, `${skin.name}.wmz`);
  writeFileSync(path, skin.bytes);
  return path;
}
