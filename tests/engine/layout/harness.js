// @ts-check
// A private helper for the W3.1 layout tests (not a test file; vitest does not collect it).
//
// It builds what the view runtime will build for one VIEW, in the order of E §3.1: the archive, the
// definition file, the literal pass, the object graph over the model, a script realm whose
// dispatcher is wired to that graph, the id list, and the skin's scripts. A test then runs the
// layout pass on it. Everything real except the host (W1.10's test host) and the pieces of the
// runtime that do not exist yet (the `_onchange` drain, bindings, the frame loop).
//
// Synthetic skins are zip archives built with the test kit's writers, so the same code path serves
// them and the owner's art.

import { afterEach } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { probeImage } from '../../../src/engine/image/probe.js';
import { decodeText } from '../../../src/engine/text/decode.js';
import { scanWms } from '../../../src/engine/wms/scan.js';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { pickDefinition } from '../../../src/engine/wms/select.js';
import { createLedger } from '../../../src/engine/model/ledger.js';
import { createObjectGraph } from '../../../src/engine/model/objects/index.js';
import { classMembers, elementClassName } from '../../../src/engine/model/schema.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createRealm, librarySource } from '../../../src/engine/realm/realm.js';
import { scriptLibrary } from '../../../src/engine/realm/wmploc.js';
import { createTestHost } from '../../../src/hosts/test/index.js';
import { buildZip } from '../../support/zip-writer.js';

/** @typedef {import('../../../src/engine/contracts').ThemeModel} ThemeModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').Realm} Realm */
/** @typedef {import('../../../src/engine/contracts').ObjectGraph} ObjectGraph */
/** @typedef {import('../../../src/engine/contracts').SkinVfs} SkinVfs */
/** @typedef {import('../../../src/engine/contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../../src/engine/contracts').Fault} Fault */

/** The real clock, captured at module load, before a test can install fake timers. */
export const wallClock = performance.now.bind(performance);

const MiB = 1024 * 1024;

/**
 * The layout tests are not testing the realm's budgets, and they run in the parallel `unit` project,
 * where a scheduler stall during a trivial expression would become a hard budget fault (the reason
 * the realm tests have their own sequential project, G2). So a session's default budgets are wide;
 * a test that wants the real ones passes `realmOptions: { budgets: FAITHFUL.budgets }`.
 * @type {import('../../../src/engine/contracts').RealmBudgets}
 */
export const WIDE_BUDGETS = Object.freeze({ ...FAITHFUL.budgets, expr: 1000, handler: 1000, load: 5000, scripts: 10_000 });

/**
 * Zip a synthetic skin: `skin.wms`, and `skin.js` when a script is given.
 * @param {string} wms
 * @param {{ script?: string, name?: string }} [opts]
 * @returns {Uint8Array}
 */
export function skinBytes(wms, opts = {}) {
  const name = opts.name ?? 'skin';
  /** @type {Array<{ name: string, data: string }>} */
  const entries = [{ name: `${name}.wms`, data: wms }];
  if (opts.script !== undefined) entries.push({ name: `${name}.js`, data: opts.script });
  return buildZip(entries);
}

/**
 * A VIEW with the given children, as `.wms` text. `attrs` is the VIEW's attribute text.
 * @param {string} body the markup between `<VIEW>` and `</VIEW>`
 * @param {string} [viewAttrs]
 */
export function wmsOf(body, viewAttrs = 'id="main" width="760" height="394"') {
  return `<THEME>\r\n<VIEW ${viewAttrs}>\r\n${body}\r\n</VIEW>\r\n</THEME>\r\n`;
}

/**
 * Build the literal-pass model of a skin archive, with no realm. The first VIEW is `view`.
 * @param {Uint8Array} bytes @param {string} [name]
 * @param {{ stacking?: 'context' | 'flat' }} [opts]
 */
export async function buildSkin(bytes, name = 'skin.wmz', opts = {}) {
  const vfs = await openVfs(bytes, name);
  const picked = pickDefinition(vfs);
  if (!picked) throw new Error('the archive has no definition file');
  const { root } = scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read(picked.wms))).text);
  if (!root) throw new Error('the definition file has no root');
  /** @type {Map<string, import('../../../src/engine/contracts').ImageProbe | null>} */
  const probed = new Map();
  const theme = buildTheme(root, vfs, {
    ...opts,
    probe: (ref) => {
      const key = vfs.resolve(ref) ?? ref;
      if (!probed.has(key)) { const b = vfs.read(ref); probed.set(key, b ? probeImage(b) : null); }
      return probed.get(key) ?? null;
    },
  });
  return { vfs, theme, view: theme.views[0], picked, root };
}

/**
 * @typedef {Object} Session
 * @property {SkinVfs} vfs
 * @property {ThemeModel} theme
 * @property {ViewModel} view
 * @property {import('../../../src/engine/contracts').RawNode} root   the scanned definition file
 * @property {Realm} realm
 * @property {ObjectGraph} graph
 * @property {ReturnType<typeof createTestHost>} host
 * @property {Diagnostic[]} realmDiagnostics   what the realm logged
 * @property {Array<{ name: string, result: import('../../../src/engine/contracts').Ok<void> | Fault }>} scripts   the script loads, in order
 * @property {() => void} close
 */

/** @type {Session[]} */
const opened = [];

// Every session a test opens is closed afterwards, so a realm that a test left running does not
// outlive it. Corpus runs close their own, one skin at a time.
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/**
 * Open one skin's first VIEW the way the runtime will: build, graph, realm, ids, scripts.
 * @param {Uint8Array} bytes
 * @param {{ name?: string, scripts?: boolean, track?: boolean, realmOptions?: Partial<import('../../../src/engine/contracts').RealmOptions> }} [opts]
 *   `scripts: false` skips the skin's own script files (the unit tests load what they need by hand)
 * @returns {Promise<Session>}
 */
export async function openSession(bytes, opts = {}) {
  const { vfs, theme, view, root } = await buildSkin(bytes, opts.name);
  const host = createTestHost();
  const graph = createObjectGraph(/** @type {any} */ ({
    host,
    view,
    theme,
    skinSha: vfs.sha,
    prefs: new Map(),
    ledger: createLedger(vfs.sha),
    opts: FAITHFUL,
    animate: { moveTo() {}, alphaBlendTo() {}, cancel() {} },
    effectsOf: () => null,
    inGesture: () => false,
    queueEvent: () => {},
    mediacenterPrefs: new Map(),
  }));

  /** @type {Diagnostic[]} */
  const realmDiagnostics = [];
  const dispatcher = {
    /** @param {number} h @param {string} key */
    get: (h, key) => graph.objectOf(h)?.get(key),
    /** @param {number} h @param {string} key @param {any} v */
    set: (h, key, v) => { graph.objectOf(h)?.set(key, v, 'script'); },
    /** @param {number} h @param {string} key @param {any[]} args */
    call: (h, key, args) => graph.objectOf(h)?.call(key, args, { gesture: false }),
    timer: () => {},
    now: () => host.clock.now(),
  };
  const realm = await createRealm({
    viewKey: `test/${vfs.sha.slice(0, 8)}`,
    memoryLimitBytes: 64 * MiB,
    maxStackBytes: 256 * 1024,
    budgets: WIDE_BUDGETS,
    wallClock,
    dispatcher,
    classMembers: classMembers(),
    hostGlobals: graph.hostGlobals,
    log: { info() {}, warn() {}, diag: (d) => { realmDiagnostics.push(d); } },
    ...opts.realmOptions,
  });

  // Every element is a script global under its id. A repeated id is the last declaration's.
  realm.setIds(view.elements
    .filter((el) => view.byId(el.id) === el)
    .map((el) => ({ id: el.id, handle: el.handle, className: elementClassName(el.kind) })));

  /** @type {Session['scripts']} */
  const scripts = [];
  if (opts.scripts !== false) {
    for (const name of theme.scriptsFor(view.view.id)) {
      const source = scriptSource(vfs, name);
      if (source !== null) scripts.push({ name, result: realm.loadScript(name, source) });
    }
  }

  let closed = false;
  /** @type {Session} */
  const session = {
    vfs, theme, view, root, realm, graph, host, realmDiagnostics, scripts,
    close() {
      if (closed) return;
      closed = true;
      realm.unload('test end');
      graph.dispose();
    },
  };
  if (opts.track !== false) opened.push(session);
  return session;
}

/**
 * The text a `scriptsFor` entry loads: a library's source for the ones that install when listed (the
 * prelude installs #132 itself), an archive file's decoded text otherwise. Null for an entry that
 * has nothing to load.
 * @param {SkinVfs} vfs @param {string} name
 * @returns {string | null}
 */
function scriptSource(vfs, name) {
  if (/^res:\/\//i.test(name)) {
    const library = scriptLibrary(name);
    return library && library.install === 'when-listed' ? librarySource(library) : null;
  }
  const bytes = vfs.read(name);
  return bytes ? decodeText(bytes).text : null;
}
