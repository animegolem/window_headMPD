// The oracle pin: SHA-256 over the bytes of the pinned files, in a fixed order (E D9).
// If any of these change, the legacy goldens may no longer describe the legacy app.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

/** Order is the order of `parity` line 18; do not sort it. */
export const PINNED_FILES = Object.freeze([
  'src/main.js',
  'src/widgets.js',
  'src/player.js',
  'src/playlist.js',
  'src/style.css',
  'src/viz/index.js',
  'src/demo.js',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/lib.rs',
  'tools/convert_skin.py',
]);

async function readPinned(root, file) {
  try {
    return await readFile(path.join(root, file));
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`pinned file is missing: ${file}`);
    throw e;
  }
}

/**
 * Per-file digests, for diagnostics ("which pinned file moved?").
 * @returns {Promise<{file:string, bytes:number, sha256:string}[]>}
 */
export async function pinDigests(root = REPO_ROOT, files = PINNED_FILES) {
  const out = [];
  for (const file of files) {
    const data = await readPinned(root, file);
    out.push({ file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return out;
}

/**
 * One digest for the whole set. Each file is framed as `<path> NUL <byte length> NUL <bytes>`, so
 * neither a reordering nor moving bytes from one file to its neighbour can leave the pin unchanged.
 * @returns {Promise<string>} 64 hex characters
 */
export async function oraclePin(root = REPO_ROOT, files = PINNED_FILES) {
  const h = createHash('sha256');
  for (const file of files) {
    const data = await readPinned(root, file);
    h.update(`${file}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest('hex');
}
