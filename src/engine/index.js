// @ts-check
// The composition root (E §5.10 `createEngine`, `Engine`, `LoadedSkin`; E D12 `WmsSkinHost`; E §3.1
// steps 2-3). Everything here is the skin as a whole; one VIEW at a time is view-runtime.js.
//
// `Engine.load(bytes, {name, sidecar})`:
//   archive        the zip read under caps into the flat, case-folded VFS; its SHA-256 is the skin's
//                  identity (prefs namespace, sidecar key, ledger)
//   definition     the `.wms` chosen (fewest unresolved references, then the stem, then the size), its
//                  text decoded (BOM, ASCII, cp1252) and scanned
//   literal pass   the element model with literal values, default sizes from the image headers, and
//                  the sidecar's overlays appended
// and returns a `LoadedSkin`, from which `attach(viewId?)` runs the rest of the sequence for one view.
// `WmsSkinHost` is the same engine behind the phase-2 `SkinHost` seam: the skin registry opens every
// archive with `openVfs` (so every family passes the same caps) and hands this host the VFS.
//
// The sidecar is our own data, but it arrives as JSON, so nothing here trusts its shape: one whose
// `skin` is not this archive's SHA-256 is ignored with a diagnostic, and every member is checked where
// it is used (overlays in wms/build.js, attributes in view-runtime.js).
//
// Options: `createEngine(host, opts)` starts from `FAITHFUL` (or `ORACLE_COMPAT` when
// `opts.config` is 'oracle-compat') and takes every key the caller gave a value; `budgets` merge per key.

import { openVfs } from './archive/vfs.js';
import { createImageService } from './image/service.js';
import { createLedger } from './model/ledger.js';
import { FAITHFUL, ORACLE_COMPAT } from './options.js';
import { decodeText } from './text/decode.js';
import { buildTheme } from './wms/build.js';
import { scanWms } from './wms/scan.js';
import { pickDefinition } from './wms/select.js';
import { attachView } from './view-runtime.js';

export { openVfs } from './archive/vfs.js';
export { FAITHFUL, ORACLE_COMPAT } from './options.js';

/** @typedef {import('./contracts').HostAdapter} HostAdapter */
/** @typedef {import('./contracts').EngineOptions} EngineOptions */
/** @typedef {import('./contracts').Engine} Engine */
/** @typedef {import('./contracts').LoadedSkin} LoadedSkin */
/** @typedef {import('./contracts').HostedSkin} HostedSkin */
/** @typedef {import('./contracts').SkinHost} SkinHost */
/** @typedef {import('./contracts').SkinVfs} SkinVfs */
/** @typedef {import('./contracts').Sidecar} Sidecar */
/** @typedef {import('./contracts').Diagnostic} Diagnostic */
/** @typedef {import('./contracts').ViewModel} ViewModel */
/** @typedef {import('./contracts').Log} Log */
/** @typedef {import('./view-runtime.js').AttachedView} AttachedView */

/** What a WMS skin is, up front (E D12): no EQ profile of its own, no PCM, one native window per view, scripted. */
export const WMS_CAPABILITIES = Object.freeze({ eq: null, wantsPcm: false, windowModel: /** @type {const} */ ('native-per-view'), scripted: true });

/** Session diagnostics kept for `diagnostics()`; the host log sees every one. */
const MAX_SESSION_DIAGNOSTICS = 4096;

/** @param {unknown} v @param {number} [d] */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** @param {string} s @param {number} [n] */
const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * The options a skin runs with: a preset, then every key the caller set. A key given as `undefined`
 * keeps the preset's value; `budgets` merge per budget.
 * @param {Partial<EngineOptions> | undefined} opts
 * @returns {EngineOptions}
 */
export function resolveOptions(opts) {
  const given = opts && typeof opts === 'object' ? opts : {};
  const base = given.config === 'oracle-compat' ? ORACLE_COMPAT : FAITHFUL;
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [k, v] of Object.entries(given)) if (v !== undefined && k !== 'budgets') out[k] = v;
  out.budgets = Object.freeze({ ...base.budgets, ...(given.budgets && typeof given.budgets === 'object' ? given.budgets : {}) });
  return /** @type {EngineOptions} */ (/** @type {unknown} */ (Object.freeze(out)));
}

/**
 * Read the definition file and build the theme, then hand back the skin. Rejects only when there is no
 * skin to show (no `.wms`, no root, no view); everything else is a diagnostic.
 * @param {SkinVfs} vfs
 * @param {HostAdapter} host
 * @param {EngineOptions} opts
 * @param {Sidecar | null | undefined} sidecarIn
 * @returns {Promise<LoadedSkin>}
 */
async function loadSkin(vfs, host, opts, sidecarIn) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  /** @param {Diagnostic} d */
  const report = (d) => {
    if (diagnostics.length < MAX_SESSION_DIAGNOSTICS) diagnostics.push(d);
    try { host.log.diag(d); } catch { /* a broken log must not stop the skin */ }
  };
  /** @param {string} step */
  const say = (step) => { try { host.log.info(`engine: ${step}`, { skin: vfs.sha.slice(0, 12) }); } catch { /* dropped */ } };

  for (const d of vfs.diagnostics) report(d);

  let sidecar = sidecarIn && typeof sidecarIn === 'object' ? sidecarIn : null;
  if (sidecar && sidecar.skin !== vfs.sha) {
    report({ code: 'sidecar-wrong-skin', severity: 'warn', detail: `the sidecar is for skin ${clip(String(sidecar.skin), 16)}, not ${vfs.sha.slice(0, 12)}; it is ignored` });
    sidecar = null;
  }

  say('definition');
  const picked = pickDefinition(vfs);
  if (!picked) throw new Error('the archive has no .wms definition file');
  const bytes = vfs.read(picked.wms);
  if (!bytes) throw new Error(`the definition file "${clip(picked.wms)}" could not be read`);
  const scanned = scanWms(decodeText(bytes).text);
  for (const d of scanned.diagnostics) report({ ...d, file: d.file ?? picked.wms });
  if (!scanned.root) throw new Error('the definition file has no root element');

  const images = createImageService(vfs, host.decode, { info: (m, d) => host.log.info(m, d), warn: (m, d) => host.log.warn(m, d), diag: report });

  say('literal pass');
  const theme = buildTheme(scanned.root, vfs, {
    probe: (ref) => images.probe(ref),
    ...(sidecar && Array.isArray(sidecar.overlays) ? { overlays: sidecar.overlays } : {}),
    stacking: opts.stacking,
  });
  for (const d of theme.diagnostics) report(d);
  if (!theme.views.length) throw new Error('the definition file has no view');

  const ledger = createLedger(vfs.sha);
  // E D5: unknown tags are inert nodes the ledger counts (by tag, never by skin-chosen id).
  for (const v of theme.views) for (const el of v.elements) if (el.kind === 'unknown') ledger.record(`<${clip(el.tag, 64)}>`, 'unknown-tag');

  const current = theme.meta.currentViewID;
  const main = (current !== null && findView(theme.views, current)) || theme.views[0];

  /** @type {import('./view-runtime.js').Session} */
  const session = { host, opts, vfs, theme, images, ledger, sidecar, report };
  /** @type {Map<ViewModel, AttachedView>} */
  const attached = new Map();
  let disposed = false;

  return {
    sha: vfs.sha,
    family: 'wms',
    capabilities: WMS_CAPABILITIES,
    views: () => theme.views.map((v) => ({ id: v.view.id, width: num(v.view.get('width')), height: num(v.view.get('height')), main: v === main })),
    async attach(viewId) {
      if (disposed) throw new Error('the skin has been disposed');
      const view = viewId === undefined || viewId === null ? main : findView(theme.views, String(viewId));
      if (!view) throw new Error(`the skin has no view "${clip(String(viewId))}"`);
      if (attached.has(view)) throw new Error(`view "${clip(view.view.id)}" is already attached; dispose it first`);
      const runtime = await attachView(session, view);
      if (disposed) {
        runtime.dispose();
        throw new Error('the skin was disposed while the view attached');
      }
      attached.set(view, runtime);
      const dispose = runtime.dispose;
      runtime.dispose = () => {
        attached.delete(view);
        dispose();
      };
      return runtime;
    },
    diagnostics: () => [...diagnostics],
    ledger: () => ledger.entries(),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const rt of [...attached.values()]) rt.dispose();
      attached.clear();
    },
  };
}

/** A view by id: exact, then case-insensitive. @param {readonly ViewModel[]} views @param {string} id */
function findView(views, id) {
  return views.find((v) => v.view.id === id) ?? views.find((v) => v.view.id.toLowerCase() === id.toLowerCase()) ?? null;
}

/** @type {import('./contracts').CreateEngineFn} */
export const createEngine = (host, opts) => {
  const options = resolveOptions(opts);
  return {
    async load(archive, lopts) {
      const name = lopts && typeof lopts.name === 'string' && lopts.name ? lopts.name : 'skin.wmz';
      const vfs = await openVfs(archive, name);
      return loadSkin(vfs, host, options, lopts?.sidecar ?? null);
    },
  };
};

/**
 * The engine behind the `SkinHost` seam (E D12), for a registry that already opened the archive.
 * `canLoad` is 1 for an archive with a `.wms` in it and 0 otherwise.
 * @param {Partial<EngineOptions>} [opts]
 * @returns {SkinHost}
 */
export function createWmsSkinHost(opts) {
  const options = resolveOptions(opts);
  return {
    family: 'wms',
    canLoad(vfs) {
      try {
        return vfs.list('.wms').length > 0 ? 1 : 0;
      } catch {
        return 0;
      }
    },
    load: (vfs, ctx) => loadSkin(vfs, ctx.host, options, ctx.sidecar ?? null),
  };
}

/** The phase-1 host, in the shipping configuration. */
export const WmsSkinHost = createWmsSkinHost();
