// Serves the legacy hand port for skinlab, from the repo root so /src, /skin (public/) and
// node_modules resolve exactly as in `npm run dev`. Nothing here edits a pinned file: the real
// src/viz/index.js is swapped for viz-stub.js at resolve time.

import path from 'node:path';
import { defineConfig } from 'vite';
import { REPO_ROOT, SKINLAB_DIR, storeRoot } from './paths.mjs';

const VIZ_REAL = path.join(REPO_ROOT, 'src', 'viz', 'index.js');
const VIZ_STUB = path.join(SKINLAB_DIR, 'viz-stub.js');

function vizStub() {
  return {
    name: 'skinlab-viz-stub',
    enforce: 'pre',
    resolveId(id, importer) {
      const source = id.split('?')[0];
      if (!importer || !(source.startsWith('.') || source.startsWith('/'))) return null;
      const from = importer.split('?')[0];
      const candidates = [
        path.resolve(path.dirname(from), source), // relative to the importer
        path.join(REPO_ROOT, source), // root-relative, as vite serves /src/...
        source, // already an absolute file path
      ];
      return candidates.some((c) => path.normalize(c) === VIZ_REAL) ? VIZ_STUB : null;
    },
  };
}

export default defineConfig({
  root: REPO_ROOT,
  appType: 'mpa', // a wrong path is a 404, never a quiet fallback to index.html
  clearScreen: false,
  logLevel: 'warn',
  cacheDir: path.join(storeRoot(), 'vite'),
  plugins: [vizStub()],
  // No dependency discovery: a "new dependencies optimized, reloading" in the middle of a capture
  // would make the first run differ from the second. @tauri-apps/api is plain ESM and serves as is;
  // three is never reached because of the viz swap.
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
});
