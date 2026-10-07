// Where things live: the repo, the fixture, and the golden store (outside git, E D9).

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKINLAB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SKINLAB_DIR, '..', '..');
export const MANIFEST_PATH = path.join(SKINLAB_DIR, 'goldens.manifest.json');

/** The owner's Headspace.wmz (the 2000 revision under skins/wmp is a different skin, E §1 rule 7). */
export const HEADSPACE_SHA1 = 'f9671f0601052547f5bddf6b5026c4a83d14d0a5';

/** Same variable as tests/support/fixtures.js. */
export const FIXTURE_ENV = 'SKINLAB_HEADSPACE';

const expandHome = (p, home) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

export function fixturePath(env = process.env, home = os.homedir()) {
  const given = env[FIXTURE_ENV];
  return path.resolve(expandHome(given && given.length ? given : '~/Downloads/Headspace.wmz', home));
}

/**
 * Resolve and verify the fixture. Returns a tagged result so the caller picks the exit code:
 * `absent` is a skip (77), `badsha` is a wrong fixture (2).
 * @returns {Promise<{status:'ok', path:string, sha1:string, sha256:string} | {status:'absent', path:string} | {status:'badsha', path:string, sha1:string}>}
 */
export async function checkFixture(file = fixturePath()) {
  let st;
  try {
    st = await stat(file);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { status: 'absent', path: file };
    throw e;
  }
  if (!st.isFile()) return { status: 'absent', path: file };
  const bytes = await readFile(file);
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  if (sha1 !== HEADSPACE_SHA1) return { status: 'badsha', path: file, sha1 };
  return { status: 'ok', path: file, sha1, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** `~/Library/Caches/window_headmpd/skinlab/`: goldens, run output, prepare stamps. Never inside the repo. */
export const storeRoot = (home = os.homedir()) => path.join(home, 'Library', 'Caches', 'window_headmpd', 'skinlab');

export const goldensDir = (root = storeRoot()) => path.join(root, 'goldens');

export const runOutDir = (runId, root = storeRoot()) => path.join(root, 'out', runId);
