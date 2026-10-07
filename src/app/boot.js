// @ts-check
// PLACEHOLDER (W0.2). W4.3 replaces this with the AppShell entry. Until then the engine path shows
// that it was reached and runs a QuickJS smoke test: instantiate the `-sync` variant and evaluate
// `1+1`. W3.R reads this page to prove the new CSP lets the WASM in, so a failure prints its message
// on screen instead of being swallowed.
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import baseVariant from '@jitl/quickjs-wasmfile-release-sync';
// The variant finds its .wasm with `new URL('.', import.meta.url)`. Vite's dev server pre-bundles the
// package into `.vite/deps/`, where that lookup falls through to index.html ("expected magic word").
// Importing the file by URL gives Vite a real asset in dev and in the build, and `wasmLocation`
// hands that URL to the loader.
import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url';

/** @returns {Promise<unknown>} the value of `1+1`, evaluated inside QuickJS */
async function quickJsSmoke() {
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(baseVariant, { wasmLocation: wasmUrl }));
  const runtime = quickjs.newRuntime();
  const ctx = runtime.newContext();
  try {
    const handle = ctx.unwrapResult(ctx.evalCode('1+1'));
    try {
      return ctx.dump(handle);
    } finally {
      handle.dispose();
    }
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

/** @param {HTMLElement} parent @param {string} id @param {string} text */
function line(parent, id, text) {
  const p = document.createElement('p');
  p.id = id;
  p.textContent = text;
  p.style.margin = '0 0 8px';
  parent.append(p);
  return p;
}

// The window is transparent and undecorated, so the placeholder paints its own opaque panel.
const root = document.getElementById('skin') ?? document.body;
Object.assign(root.style, {
  position: 'fixed',
  inset: '0',
  padding: '24px',
  background: '#1b1b1f',
  color: '#e8e8ea',
  font: '14px/1.4 -apple-system, system-ui, sans-serif',
});
line(root, 'engine-status', 'Skin engine not ready');
const smoke = line(root, 'engine-smoke', 'QuickJS: running');

// No top-level await here: Rollup puts the namespace object of quickjs-emscripten-core's inlined
// dynamic import() at the end of this chunk, so a suspended module evaluation lets that import run
// first and fails with "Cannot access ... before initialization" (seen in `vite build` output).
quickJsSmoke().then(
  (value) => {
    smoke.textContent = `QuickJS OK: ${value}`;
  },
  (err) => {
    console.error('QuickJS smoke test failed', err);
    smoke.textContent = `QuickJS FAILED: ${err instanceof Error ? err.message : String(err)}`;
  },
);
