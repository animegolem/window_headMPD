#!/usr/bin/env node
// @ts-check
// The corpus runner of ENGINE D6.7 and D10.9 criterion 6 (WAVES W5.4). It loads every distinct WMP skin
// through the real engine on the test host, headless, on the manual clock, and renders what it sees:
//
//   node tools/corpus.mjs [--skins <dir>] [--out-dir <dir>] [--limit <n>] [--no-write]
//     (`npm run coverage`)  runs the Node stage, writes docs/coverage/ledger.md and the Node section of
//                           docs/coverage/corpus-load.txt, exits 0 clean, 1 on a failed gate, 2 on bad
//                           usage. With the corpus absent it prints a skip and exits 0.
//   npm run corpus -- load  (tests/corpus/load.test.js) runs the same stage under vitest, asserts the gates
//   npm run skinlab -- corpus (tools/skinlab/cmd-corpus.mjs) is the Chromium stage: mount, first frame,
//                           mask. It writes its own section of corpus-load.txt through `updateSection`.
//
// One skin, one scripted run (`runSkin`): archive, select, scan, build, realm, layout, bindings and
// `onload` happen inside `engine.load` and `attach`; then, on a manual clock and with the real
// (FAITHFUL) budgets, a minute of play in one-second steps, pause, seek, resume, a mode toggle, a volume
// change, next and stop through the scripted media model (so bindings and PLAYER events reach the
// skin's handlers), and last a `moveTo` probe: the tween engine driven to a target on the same clock.
// The skin's own tweens run to their end on the clock, because every step advances it in 16 ms frames.
//
// What the gates mean (D10.9 criterion 6). A host exception is anything thrown out of `load`, `attach`,
// the scripted run or `dispose`, any `runtime-error` diagnostic (the runtime's own catch for a bug in
// host code, view-runtime.js), and any process-level `uncaughtException` or `unhandledRejection` while
// the stage runs. Realm faults are the skin's: hard ones are listed, not gated, except for the ladder
// rungs R0 (the owner's Headspace.wmz, not in skins/), R1 Miniplayer and R2 aoe, which must have none.
// A view that never goes quiet within the cap ("perpetual animation": a tween that restarts itself)
// is a flag, not a failure; where the script has been read, `PERPETUAL_NOTES` says what restarts it.
//
// Art rule (WAVES global rule 2): the reports hold names and counts only. A skin is named by its archive
// file name, which tests/corpus.manifest.json already commits, and a fault by the engine's own reason
// category, never by handler text. Ledger entries print the API name and no detail line.
//
// Lookups keyed by skin strings (ledger API names, diagnostic codes) are Maps: a skin that names a
// member `__proto__` or `constructor` is just a name (ENGINE section 1, rule 6).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createEngine } from '../src/engine/index.js';
import { apiName, SCHEMA } from '../src/engine/model/schema.js';
import { FAITHFUL } from '../src/engine/options.js';
import { MAX_SURFACE_PIXELS } from '../src/engine/render/dom/compose.js';
import { createTestHost } from '../src/hosts/test/index.js';
import { DEFAULT_SKINS_DIR, listArchives, sha256File } from './make-corpus-manifest.mjs';
import { checkFixture } from './skinlab/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const COVERAGE_DIR = join(REPO_ROOT, 'docs', 'coverage');
export const LEDGER_FILE = 'ledger.md';
export const LOAD_FILE = 'corpus-load.txt';

/** The number of distinct archives the survey counts, and the gate pins (corpus-survey section 1). */
export const SURVEY_DISTINCT = 195;

/** The scripted run, in one place so the report can say what it did. */
export const SCENARIO = Object.freeze({
  media: 'stoppedQueue12',
  playSteps: 60,                 // x 1,000 ms: a minute of play
  stepMs: 1000,
  pauseMs: 3000,
  seekToSec: 30,
  seekMs: 3000,
  resumeMs: 5000,
  nextMs: 3000,
  stopMs: 3000,
  quietFrames: 120,              // the most frames a "wait for quiet" advances the clock by (about 1.9 s)
  moveTargets: 3,
  moveDeltaX: 13,
  moveDeltaY: 7,
  moveMs: 120,
});

/** Where the ladder rungs of survey section 6 live in the corpus (aliases share one SHA-256). */
export const LADDER = Object.freeze({
  R1: Object.freeze(['Miniplayer.wmz', 'microsoft__Miniplayer.wmz']),
  R2: Object.freeze(['aoe.wmz', 'microsoft__aoe.wmz']),
});

/** E section 10: the per-axis canvas cap; the area cap is the renderer's own constant. */
export const MAX_CANVAS_AXIS = 4096;

/**
 * Why a view never goes quiet, for the skins whose scripts were read (SHA-256 prefix of 12 -> mechanism; the
 * reports print that prefix beside the name). Mechanism only, no handler or function text (art rule). A
 * skin that is busy and not in this table is reported without a reason: the cause has not been looked at.
 * Both are the skin's own loop, so WMP shows the same endless motion and the engine is not at fault.
 * A Map: the key is data.
 * @type {ReadonlyMap<string, string>}
 */
export const PERPETUAL_NOTES = new Map([
  ['3fd10ce48a4d', 'two subviews pulse back and forth for ever: the end of each move starts the next one (checked 2026-10-07)'],
  ['a30ab1a76515', 'the main view\'s 500 ms timer starts the next 8 s fade of a four-layer background colour cycle, the end of each fade advances the cycle, and it wraps without end (checked 2026-10-07: the layers fade in turn, one about every 8 s). The skin starts on a splash view that hands over to this main view; before 5F.6 the window never switched, so the main view never ran and the cycle was not seen.'],
]);

/** The known reason a skin never goes quiet, or undefined. @param {string} sha */
export const perpetualNote = (sha) => PERPETUAL_NOTES.get(String(sha).slice(0, 12));

const FRAME_MS = 16;

// ---- the corpus ----------------------------------------------------------------------------------------

/**
 * @typedef {Object} CorpusEntry
 * @property {string} name     the first archive name, in name order, with this content
 * @property {string[]} names  every archive name with this SHA-256 (aliases and variants)
 * @property {string} path
 * @property {string} sha
 */

/**
 * One archive per SHA-256, the first in name order, as the survey counts (195 of 342).
 * @param {string} [dir]
 * @returns {{ archives: number, distinct: CorpusEntry[] }}
 */
export function distinctArchives(dir = join(DEFAULT_SKINS_DIR, 'wmp')) {
  const names = listArchives(dir);
  /** @type {Map<string, CorpusEntry>} */
  const bySha = new Map();
  for (const name of names) {
    const path = join(dir, name);
    const sha = sha256File(path);
    const known = bySha.get(sha);
    if (known) known.names.push(name);
    else bySha.set(sha, { name, names: [name], path, sha });
  }
  return { archives: names.length, distinct: [...bySha.values()] };
}

/** The ladder rung an entry stands for, if any. @param {CorpusEntry} entry @returns {'R1' | 'R2' | null} */
export function rungOf(entry) {
  if (entry.names.some((n) => LADDER.R1.includes(n))) return 'R1';
  if (entry.names.some((n) => LADDER.R2.includes(n))) return 'R2';
  return null;
}

/**
 * The owner's Headspace.wmz (R0): `SKINLAB_HEADSPACE`, else `~/Downloads/Headspace.wmz`, and only when its
 * SHA-1 is the fixture's (the 2000 revision under skins/wmp is a different skin). Null when absent or wrong.
 * @returns {Promise<string | null>}
 */
export async function headspaceFile() {
  const fixture = await checkFixture();
  return fixture.status === 'ok' ? fixture.path : null;
}

/** The app's sidecar for a skin, when one ships (src/app/sidecars/<sha256>.json). @param {string} sha */
export function sidecarFor(sha) {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const file = join(REPO_ROOT, 'src', 'app', 'sidecars', `${sha}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---- one skin ------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Row
 * @property {string} name
 * @property {string} sha
 * @property {'R0' | 'R1' | 'R2' | null} rung
 * @property {boolean} loaded               `engine.load` and `attach` both returned
 * @property {{ phase: string, error: string, message: string } | null} threw   a host exception out of the API
 * @property {number} loadMs                `engine.load`: archive, select, scan, literal pass
 * @property {number} attachMs              `attach`: realm, scripts, layout, bindings, decode, onload, first frame
 * @property {number} runMs                 the scripted run, wall time
 * @property {number} views
 * @property {number} elements              the main view's elements in paint order, plus the view
 * @property {{ w: number, h: number }} viewSize   the size of the view the window shows after the scripted run (a skin may collapse it)
 * @property {number} switches              `view-switch` diagnostics: times the main window was handed to another view (5F.6)
 * @property {number} switchFaults          `view-switch-failed` and `view-switch-cap` diagnostics: a hand-over that did not happen
 * @property {{ soft: number, hard: number, unloaded: boolean }} health   before dispose
 * @property {string[]} hardFaults          one `<site kind> <reason category>` per distinct hard fault
 * @property {number} faultUnloads          `host.actions.fault` calls: the shell would show the fault panel
 * @property {number} runtimeErrors         `runtime-error` diagnostics
 * @property {string[]} runtimeErrorSites   the site part of each, sanitised
 * @property {Map<string, number>} diagnostics   diagnostic code -> count
 * @property {number} denied                `host.actions.denied` calls
 * @property {boolean} quiet                the view went quiet at the end of the scripted run
 * @property {number} subviews
 * @property {number} sizeless              SUBVIEWs with a zero width or height after layout (risk R10)
 * @property {number} clampHits             element boxes over the canvas cap
 * @property {{ driven: number, landed: number }} moveTo
 * @property {import('../src/engine/contracts').LedgerEntry[]} ledger
 */

/** @param {unknown} s @param {number} n */
const clip = (s, n) => {
  const t = String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Let async work land and give tweens their frames, bounded. `settled()` waits for the next frame, which
 * a manual clock only produces when someone advances it, so the clock is advanced one frame per turn
 * until the view reports quiet or the cap is spent. Returns whether it went quiet.
 * @param {ReturnType<typeof createTestHost>} host
 * @param {{ settled(): Promise<void> }} runtime
 * @param {number} [frames]
 */
async function quiesce(host, runtime, frames = SCENARIO.quietFrames) {
  let quiet = false;
  runtime.settled().then(() => { quiet = true; }, () => { quiet = true; });
  for (let i = 0; i < frames && !quiet; i++) {
    await tick();
    if (quiet) break;
    host.clock.advance(FRAME_MS);
  }
  await tick();
  return quiet;
}

/**
 * The paint-order dump as `{ kind, id, hidden }`. The first line is the view and `(background of ...)`
 * lines are not elements; both fail the pattern.
 * @param {string[]} dump
 */
function dumpEntries(dump) {
  const out = [];
  for (const line of dump) {
    const m = /^\s*([a-z]+) (.+) z=-?\d+( hidden)?$/.exec(line);
    if (m) out.push({ kind: m[1], id: m[2], hidden: m[3] !== undefined });
  }
  return out;
}

/**
 * Element boxes from the contract only (`stackingDump` for the ids, `rectOf` for the boxes), after layout:
 * how many SUBVIEWs have no size (risk R10, they do not clip) and how many boxes are over the canvas cap
 * (E section 10: 4,096 per axis, 16.7 M px; the renderer clamps silently, so the clamp hit is counted here).
 * @param {ReturnType<typeof dumpEntries>} entries
 * @param {import('../src/engine/contracts').SkinInspector} inspector
 */
function boxStats(entries, inspector) {
  let subviews = 0;
  let sizeless = 0;
  let clampHits = 0;
  for (const { kind, id } of entries) {
    if (kind === 'buttonelement') continue;               // answers with its group's box
    const r = inspector.rectOf(id);
    if (!r) continue;
    if (kind === 'subview') {
      subviews++;
      if (!(r.w > 0) || !(r.h > 0)) sizeless++;
    }
    if (r.w > MAX_CANVAS_AXIS || r.h > MAX_CANVAS_AXIS || r.w * r.h > MAX_SURFACE_PIXELS) clampHits++;
  }
  return { subviews, sizeless, clampHits };
}

/**
 * Drive the tween engine from outside: a few elements move by a fixed offset on the manual clock, and
 * each is read back. The move goes through the skin's own realm as a timer string, which is how a
 * WMS handler would issue it; ids that are not plain identifiers are left alone. Landing short is not a
 * failure (a skin's `onendmove` may move the element again); the counts are reported.
 * @param {ReturnType<typeof createTestHost>} host
 * @param {import('../src/engine/contracts').SkinInspector} inspector
 * @param {ReturnType<typeof dumpEntries>} entries
 */
async function moveProbe(host, inspector, entries) {
  const movable = new Set(['subview', 'button', 'buttongroup', 'text', 'slider', 'customslider', 'progressbar']);
  const seen = new Set();
  const picked = [];
  for (const e of entries) {
    if (picked.length >= SCENARIO.moveTargets) break;
    if (e.hidden || !movable.has(e.kind) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(e.id) || seen.has(e.id.toLowerCase())) continue;
    seen.add(e.id.toLowerCase());
    const left = inspector.attr(e.id, 'left');
    const top = inspector.attr(e.id, 'top');
    if (typeof left === 'number' && typeof top === 'number') picked.push({ id: e.id, x: left + SCENARIO.moveDeltaX, y: top + SCENARIO.moveDeltaY });
  }
  for (const p of picked) inspector.callGlobal('setTimeout', [`${p.id}.moveTo(${p.x}, ${p.y}, ${SCENARIO.moveMs});`, 10]);
  host.clock.advance(FRAME_MS);                           // the timers fire, the tweens start
  host.clock.advance(SCENARIO.moveMs + 4 * FRAME_MS);     // and end, with a frame or two to spare
  await tick();
  let landed = 0;
  for (const p of picked) if (inspector.attr(p.id, 'left') === p.x && inspector.attr(p.id, 'top') === p.y) landed++;
  return { driven: picked.length, landed };
}

/** The category of a realm hard-fault diagnostic: `<site kind> <reason>`, from engine vocabulary only. @param {string} detail */
function faultCategory(detail) {
  const at = detail.lastIndexOf(': ');
  const reason = at < 0 ? '' : detail.slice(at + 2).trim();
  const rest = at < 0 ? detail : detail.slice(0, at);
  const site = /^\S+ ([a-z]+)\b/.exec(rest)?.[1] ?? 'site';
  return `${site} ${/^[a-z][a-z-]{0,23}$/.test(reason) ? reason : 'other'}`;
}

/**
 * The skin's session diagnostics and the runtime's, each diagnostic once. The runtime hands every diagnostic
 * it keeps on to the session (and the window wrapper does the same for its own), so the lists overlap, and
 * they are capped differently (4,096 for the session, 1,024 for a runtime and for the retired views), so
 * neither one is the whole story. The object itself is the key: the same report is the same object in both.
 * @param {...import('../src/engine/contracts').Diagnostic[]} lists
 * @returns {import('../src/engine/contracts').Diagnostic[]}
 */
export function collectDiagnostics(...lists) {
  /** @type {Set<import('../src/engine/contracts').Diagnostic>} */
  const seen = new Set();
  for (const list of lists) for (const d of list) seen.add(d);
  return [...seen];
}

/** @param {import('../src/engine/contracts').Diagnostic[]} diags */
function countCodes(diags) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const d of diags) out.set(d.code, (out.get(d.code) ?? 0) + 1);
  return out;
}

/**
 * Run one skin through the whole headless runtime and the scripted minute. Never throws: a host
 * exception becomes `row.threw` with the phase it came out of.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {{ sha?: string, rung?: Row['rung'], sidecar?: object | null, engine?: Partial<import('../src/engine/contracts').EngineOptions> }} [opts]
 * @returns {Promise<Row>}
 */
export async function runSkin(bytes, name, opts = {}) {
  /** @type {Row} */
  const row = {
    name, sha: opts.sha ?? '', rung: opts.rung ?? null, loaded: false, threw: null, loadMs: 0, attachMs: 0, runMs: 0,
    views: 0, elements: 0, viewSize: { w: 0, h: 0 }, switches: 0, switchFaults: 0, health: { soft: 0, hard: 0, unloaded: false }, hardFaults: [], faultUnloads: 0,
    runtimeErrors: 0, runtimeErrorSites: [], diagnostics: new Map(), denied: 0, quiet: true,
    subviews: 0, sizeless: 0, clampHits: 0, moveTo: { driven: 0, landed: 0 }, ledger: [],
  };
  const host = createTestHost({ media: SCENARIO.media });
  const engine = createEngine(host, { ...(opts.engine ?? {}) });
  const wall = performance.now.bind(performance);
  let phase = 'load';
  /** @type {import('../src/engine/contracts').LoadedSkin | null} */
  let skin = null;
  /** @type {import('../src/engine/contracts').ViewRuntime | null} */
  let runtime = null;
  /** @param {unknown} e */
  const thrown = (e) => {
    row.threw ??= { phase, error: e instanceof Error ? e.name : typeof e, message: clip(e instanceof Error ? e.message : String(e), 160) };
  };
  try {
    const t0 = wall();
    skin = await engine.load(bytes, { name, ...(opts.sidecar ? { sidecar: /** @type {any} */ (opts.sidecar) } : {}) });
    row.loadMs = wall() - t0;
    row.views = skin.views().length;
    phase = 'attach';
    const t1 = wall();
    runtime = await skin.attach();
    row.attachMs = wall() - t1;
    row.loaded = true;

    phase = 'run';
    const t2 = wall();
    await quiesce(host, runtime);
    await host.media.play();
    for (let i = 0; i < SCENARIO.playSteps; i++) {
      host.clock.advance(SCENARIO.stepMs);
      await tick();
    }
    await host.media.pause();
    host.clock.advance(SCENARIO.pauseMs);
    await tick();
    await host.media.seek(SCENARIO.seekToSec);
    host.clock.advance(SCENARIO.seekMs);
    await tick();
    await host.media.play();
    await host.media.setMode('shuffle', true);
    await host.media.setVolume(30);
    host.clock.advance(SCENARIO.resumeMs);
    await host.media.setMode('shuffle', false);
    await host.media.next();
    host.clock.advance(SCENARIO.nextMs);
    await host.media.stop();
    host.clock.advance(SCENARIO.stopMs);
    row.quiet = await quiesce(host, runtime);

    // The numbers a run is judged by are read before the probe and before dispose.
    const h = runtime.health;
    row.health = { soft: h.soft, hard: h.hard, unloaded: h.unloaded };
    const entries = dumpEntries(runtime.inspector.stackingDump());
    row.elements = entries.length + 1;
    const vr = runtime.inspector.rectOf(runtime.viewId);
    if (vr) row.viewSize = { w: vr.w, h: vr.h };
    ({ subviews: row.subviews, sizeless: row.sizeless, clampHits: row.clampHits } = boxStats(entries, runtime.inspector));
    if (!h.unloaded) row.moveTo = await moveProbe(host, runtime.inspector, entries);
    row.runMs = wall() - t2;
  } catch (e) {
    thrown(e);
  }
  phase = 'dispose';
  try {
    runtime?.dispose();
    skin?.dispose();
  } catch (e) {
    thrown(e);
  }
  // After dispose: the runtime's diagnostics include whatever `onclose` caused. The realm-hard-fault object the skin
  // and the runtime both hold is deduped by identity in collectDiagnostics.
  try {
    const diags = collectDiagnostics(skin?.diagnostics() ?? [], runtime?.diagnostics() ?? []);
    row.diagnostics = countCodes(diags);
    row.switches = row.diagnostics.get('view-switch') ?? 0;
    row.switchFaults = (row.diagnostics.get('view-switch-failed') ?? 0) + (row.diagnostics.get('view-switch-cap') ?? 0);
    const hard = new Set();
    for (const d of diags) {
      if (d.code === 'realm-hard-fault') hard.add(faultCategory(String(d.detail ?? '')));
      if (d.code === 'runtime-error') {
        row.runtimeErrors++;
        if (row.runtimeErrorSites.length < 8) row.runtimeErrorSites.push(clip(String(d.detail ?? '').split(':')[0], 40));
      }
    }
    row.hardFaults = [...hard].sort();
    row.ledger = skin?.ledger() ?? [];
  } catch (e) {
    thrown(e);
  }
  row.faultUnloads = host.recorded.faults.length;
  row.denied = host.recorded.denied.length;
  return row;
}

// ---- the stage ---------------------------------------------------------------------------------------

/**
 * @typedef {Object} StageResult
 * @property {number} archives             archives in the corpus directory
 * @property {Row[]} rows                  one per distinct skin, in name order
 * @property {Row | null} r0               the owner's Headspace.wmz, when present
 * @property {Array<{ skin: string, kind: string, message: string }>} uncaught   process-level, while the stage ran
 * @property {number} wallMs
 */

/**
 * Every distinct skin of a corpus directory, one at a time.
 * @param {{ dir?: string, limit?: number, headspace?: string | null, onRow?: (row: Row, i: number, n: number) => void }} [opts]
 * @returns {Promise<StageResult>}
 */
export async function runNodeStage(opts = {}) {
  const started = performance.now();
  const { archives, distinct } = distinctArchives(opts.dir);
  const todo = opts.limit ? distinct.slice(0, opts.limit) : distinct;
  /** @type {StageResult['uncaught']} */
  const uncaught = [];
  let current = '(between skins)';
  /** @param {string} kind */
  const note = (kind) => (/** @type {unknown} */ e) => {
    uncaught.push({ skin: current, kind, message: clip(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 160) });
  };
  const onException = note('uncaughtException');
  const onRejection = note('unhandledRejection');
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  /** @type {Row[]} */
  const rows = [];
  /** @type {Row | null} */
  let r0 = null;
  try {
    for (const [i, entry] of todo.entries()) {
      current = entry.name;
      const bytes = new Uint8Array(readFileSync(entry.path));
      const row = await runSkin(bytes, entry.name, { sha: entry.sha, rung: rungOf(entry), sidecar: sidecarFor(entry.sha) });
      rows.push(row);
      opts.onRow?.(row, i + 1, todo.length);
    }
    const hs = opts.headspace === undefined ? await headspaceFile() : opts.headspace;
    if (hs) {
      current = 'Headspace.wmz (R0)';
      const bytes = new Uint8Array(readFileSync(hs));
      const sha = createHash('sha256').update(bytes).digest('hex');
      r0 = await runSkin(bytes, 'Headspace.wmz', { sha, rung: 'R0', sidecar: sidecarFor(sha) });
    }
    current = '(between skins)';
    await tick();                                 // a rejection one turn late still lands in the list
  } finally {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  }
  return { archives, rows, r0, uncaught, wallMs: performance.now() - started };
}

// ---- aggregation ---------------------------------------------------------------------------------------

/**
 * @typedef {Object} LedgerRow
 * @property {string} api
 * @property {string} kind
 * @property {number} skins   skins whose ledger holds the pair
 * @property {number} hits    its counts, summed
 */

/**
 * The corpus ledger: one row per (api, kind), over every skin. A Map, because api names are skin text.
 * @param {Array<Pick<Row, 'ledger'>>} rows
 * @returns {Map<string, LedgerRow>}
 */
export function aggregateLedger(rows) {
  /** @type {Map<string, LedgerRow>} */
  const out = new Map();
  for (const row of rows) {
    for (const e of row.ledger) {
      const key = `${e.kind}\u0000${e.api}`;
      const known = out.get(key);
      if (known) {
        known.skins++;
        known.hits += e.count;
      } else {
        out.set(key, { api: e.api, kind: e.kind, skins: 1, hits: e.count });
      }
    }
  }
  return out;
}

/** The deterministic order of every table: most skins first, then hits, then name. @param {LedgerRow[]} a */
const byDemand = (a) => a.sort((x, y) => y.skins - x.skins || y.hits - x.hits || (x.api < y.api ? -1 : x.api > y.api ? 1 : 0) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0));

/**
 * The schema's impls by ledger API name, lowercased (the ledger spells a stub by the schema's name and an
 * unknown member by the skin's lowercased one). Two classes can share a name (the `theme` host object and
 * the THEME element), so a name maps to every impl it has.
 * @returns {Map<string, string[]>}
 */
export function implIndex() {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [className, members] of SCHEMA) {
    for (const [key, spec] of members) {
      const api = apiName(className, key).toLowerCase();
      const known = out.get(api) ?? [];
      if (!known.includes(spec.impl)) known.push(spec.impl);
      out.set(api, known);
    }
  }
  return out;
}

/**
 * The impl a ledger row is shown with: the one that matches its kind when the name is shared
 * (`theme.currentViewID` is a stub on the host object and a live attribute of the element), else all of them.
 * @param {Map<string, string[]>} index @param {{ api: string, kind: string }} e
 */
export function implOfEntry(index, e) {
  if (e.kind === 'unknown-member' || e.kind === 'unknown-tag' || e.kind === 'unresolved-res' || e.kind === 'unresolved-binding') return '-';
  const impls = index.get(e.api.toLowerCase());
  if (!impls) return '-';
  return impls.includes(e.kind) ? e.kind : impls.join('/');
}

/**
 * Members that do less than they say: `stub`, `denied` and `emulated`. For an emulated member the ledger
 * has nothing (it is a documented no-op or a synthesised value), so its demand is the static column.
 * @returns {Array<{ api: string, impl: string, kind: string }>}
 */
function reducedMembers() {
  /** @type {Array<{ api: string, impl: string, kind: string }>} */
  const out = [];
  for (const [className, members] of SCHEMA) {
    for (const [, spec] of members) if (spec.impl !== 'live') out.push({ api: apiName(className, spec.name), impl: spec.impl, kind: spec.kind });
  }
  return out.sort((a, b) => (a.api < b.api ? -1 : a.api > b.api ? 1 : a.impl < b.impl ? -1 : 1));
}

/**
 * Static demand from docs/coverage/api-frequency.csv (names and counts, W2.8): skins that reference an
 * object-model path, and skins that call an element method by name. Absent file, empty map.
 * @param {string} [file]
 * @returns {Map<string, number>} `o:<path>` and `m:<method>`, lowercased
 */
export function staticDemand(file = join(COVERAGE_DIR, 'api-frequency.csv')) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const [kind, name, , skins] = line.split(',');
    if (!name || !(Number(skins) >= 0)) continue;
    if (kind === 'object-model') out.set(`o:${name}`, Number(skins));
    else if (kind === 'element-method' || kind === 'implicit-method') out.set(`m:${name}`, Math.max(out.get(`m:${name}`) ?? 0, Number(skins)));
  }
  return out;
}

/** @param {number[]} xs sorted ascending @param {number} p 0..1 */
const quantile = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);
const ms = (/** @type {number} */ n) => `${n.toFixed(1)} ms`;

/**
 * @param {StageResult} r
 * @returns {Record<string, any>}
 */
export function summarize(r) {
  const rows = r.rows;
  const sum = (/** @type {(x: Row) => number} */ f) => rows.reduce((n, x) => n + f(x), 0);
  const ladder = [...rows.filter((x) => x.rung), ...(r.r0 ? [r.r0] : [])].sort((a, b) => (a.rung ?? '') < (b.rung ?? '') ? -1 : 1);
  const loads = rows.map((x) => x.loadMs).sort((a, b) => a - b);
  const attaches = rows.map((x) => x.attachMs).sort((a, b) => a - b);
  /** @type {Map<string, number>} */
  const codes = new Map();
  for (const x of rows) for (const code of x.diagnostics.keys()) codes.set(code, (codes.get(code) ?? 0) + 1);
  return {
    distinct: rows.length,
    loaded: rows.filter((x) => x.loaded).length,
    thrown: rows.filter((x) => x.threw),
    runtimeErrorSkins: rows.filter((x) => x.runtimeErrors > 0),
    runtimeErrors: sum((x) => x.runtimeErrors),
    hardSkins: rows.filter((x) => x.health.hard > 0 || x.hardFaults.length > 0),
    softSkins: rows.filter((x) => x.health.soft > 0).length,
    soft: sum((x) => x.health.soft),
    hard: sum((x) => x.health.hard),
    unloaded: rows.filter((x) => x.health.unloaded),
    faultUnloads: sum((x) => x.faultUnloads),
    faultUnloadSkins: rows.filter((x) => x.faultUnloads > 0),
    perpetual: rows.filter((x) => !x.quiet),
    collapsed: rows.filter((x) => x.loaded && !(x.viewSize.w > 0 && x.viewSize.h > 0)),
    switchSkins: rows.filter((x) => x.switches > 0).length,
    switches: sum((x) => x.switches),
    switchFaultSkins: rows.filter((x) => x.switchFaults > 0),
    switchFaults: sum((x) => x.switchFaults),
    subviews: sum((x) => x.subviews),
    sizelessSkins: rows.filter((x) => x.sizeless > 0).length,
    sizeless: sum((x) => x.sizeless),
    maxSizeless: Math.max(0, ...rows.map((x) => x.sizeless)),
    clampSkins: rows.filter((x) => x.clampHits > 0),
    clampHits: sum((x) => x.clampHits),
    moveDriven: sum((x) => x.moveTo.driven),
    moveLanded: sum((x) => x.moveTo.landed),
    elements: sum((x) => x.elements),
    ladder,
    loadMs: { median: quantile(loads, 0.5), p95: quantile(loads, 0.95), max: quantile(loads, 1) },
    attachMs: { median: quantile(attaches, 0.5), p95: quantile(attaches, 0.95), max: quantile(attaches, 1) },
    slowest: [...rows].sort((a, b) => b.loadMs + b.attachMs - (a.loadMs + a.attachMs)).slice(0, 5),
    codes,
    denied: sum((x) => x.denied),
  };
}

/**
 * What fails the stage (D10.9 criterion 6, WAVES W5.4). Empty means it passes.
 * @param {StageResult} r
 * @param {{ distinct?: number }} [expect]
 * @returns {string[]}
 */
export function gateFailures(r, expect = {}) {
  const s = summarize(r);
  /** @type {string[]} */
  const out = [];
  if (expect.distinct !== undefined && s.distinct !== expect.distinct) out.push(`${s.distinct} distinct skins ran, expected ${expect.distinct}`);
  for (const x of [...r.rows, ...(r.r0 ? [r.r0] : [])].filter((y) => !y.loaded)) out.push(`${x.name}: did not load (${x.threw?.phase ?? '?'}: ${x.threw?.error ?? '?'}: ${x.threw?.message ?? ''})`);
  for (const x of [...r.rows, ...(r.r0 ? [r.r0] : [])].filter((y) => y.threw && y.loaded)) out.push(`${x.name}: host exception in ${x.threw?.phase}: ${x.threw?.error}: ${x.threw?.message}`);
  for (const x of [...r.rows, ...(r.r0 ? [r.r0] : [])].filter((y) => y.runtimeErrors > 0)) out.push(`${x.name}: ${x.runtimeErrors} runtime-error diagnostic(s) at ${x.runtimeErrorSites.join(', ')}`);
  for (const u of r.uncaught) out.push(`${u.skin}: process-level ${u.kind}: ${u.message}`);
  for (const x of s.ladder.filter((y) => y.health.hard > 0 || y.hardFaults.length > 0)) out.push(`${x.rung} ${x.name}: realm hard faults: ${x.hardFaults.join(', ') || x.health.hard}`);
  for (const x of s.ladder.filter((y) => y.health.unloaded)) out.push(`${x.rung} ${x.name}: the realm unloaded`);
  return out;
}

// ---- rendering ----------------------------------------------------------------------------------------

/** Markdown table cell text: one line, no pipes, bounded. @param {string} s */
const cell = (s) => clip(s, 100).replace(/\|/g, '\\|').replace(/`/g, "'");

/** @param {number} a @param {number} b */
const pct = (a, b) => (b ? `${a}/${b}` : `${a}`);

/**
 * The Node section of corpus-load.txt.
 * @param {StageResult} r
 * @returns {string[]}
 */
export function renderNodeReport(r) {
  const s = summarize(r);
  /** @type {string[]} */
  const L = [];
  L.push(`archives: ${r.archives}; distinct SHA-256: ${s.distinct} (the survey counts ${SURVEY_DISTINCT})`);
  L.push(`scenario: engine.load and attach on the test host (media preset ${SCENARIO.media}, FAITHFUL budgets), then on the manual clock`);
  L.push(`  ${SCENARIO.playSteps} x ${SCENARIO.stepMs} ms of play, pause ${SCENARIO.pauseMs} ms, seek to ${SCENARIO.seekToSec} s, resume with a shuffle toggle and volume 30, next, stop, then a moveTo probe`);
  L.push('');
  L.push(`loaded and attached: ${pct(s.loaded, s.distinct)}`);
  L.push(`host exceptions thrown out of load, attach, the run or dispose: ${s.thrown.length}`);
  L.push(`runtime-error diagnostics (the runtime's catch for a host bug): ${s.runtimeErrors} in ${s.runtimeErrorSkins.length} skins`);
  L.push(`process-level uncaughtException or unhandledRejection: ${r.uncaught.length}`);
  // Two different counts: a fault call is the shell's fault panel (what the owner sees); health.unloaded is the realm
  // having given up. A skin can have either without the other, so each gets its own line and its own denominator.
  L.push(`fault unloads (host.actions.fault, the shell's fault panel): ${s.faultUnloads} in ${s.faultUnloadSkins.length} skins`);
  for (const x of s.faultUnloadSkins) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${x.faultUnloads}`);
  L.push(`realms that unloaded (health.unloaded, read before dispose): ${s.unloaded.length} skins`);
  for (const x of s.unloaded) L.push(`  ${x.name} (${x.sha.slice(0, 12)})`);
  L.push('');
  L.push(`realm soft faults: ${s.soft} in ${s.softSkins} skins (occurrences, the realm's own count; the ledger counts each reason once per site, so its soft-fault rows add up to far fewer)`);
  L.push(`realm hard faults: ${s.hard} in ${s.hardSkins.length} skins (reported, not blocking, except for R0 to R2)`);
  for (const x of s.hardSkins) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${x.hardFaults.join('; ') || `${x.health.hard} hard`}${x.health.unloaded ? '; the realm unloaded' : ''}`);
  L.push('ladder rungs (R0 is the owner\'s Headspace.wmz, outside skins/):');
  for (const rung of ['R0', 'R1', 'R2']) {
    const x = s.ladder.find((y) => y.rung === rung);
    if (!x) L.push(`  ${rung}: not run (${rung === 'R0' ? 'no Headspace.wmz on this machine' : 'not in the corpus'})`);
    else L.push(`  ${rung} ${x.name} (${x.sha.slice(0, 12)}): hard ${x.health.hard}, soft ${x.health.soft}, unloaded ${x.health.unloaded}, ledger entries ${x.ledger.length}, load ${ms(x.loadMs)}, attach ${ms(x.attachMs)}`);
  }
  L.push('');
  L.push(`views never quiet within ${SCENARIO.quietFrames} frames after the scripted run (a tween that restarts itself): ${s.perpetual.length}`);
  for (const x of s.perpetual) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${perpetualNote(x.sha) ?? 'cause not looked at'}`);
  L.push(`view switches (5F.6: a script's currentViewID write, or openView from a view with no area, hands the one window to another view): ${s.switches} in ${s.switchSkins} skins`);
  L.push(`  hand-overs that did not happen (the 4-a-second cap, or the next view failed to start): ${s.switchFaults} in ${s.switchFaultSkins.length} skins`);
  for (const x of s.switchFaultSkins) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${x.switchFaults}`);
  L.push(`views shown with no area after the scripted run (nothing ever sized the view the window shows, or a splash collapsed and handed over to nothing): ${s.collapsed.length}`);
  for (const x of s.collapsed) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${x.viewSize.w}x${x.viewSize.h}, ${x.switches} view switches`);
  L.push(`canvas-clamp hits (an element box over ${MAX_CANVAS_AXIS} per axis or ${MAX_SURFACE_PIXELS} px; expected 0): ${s.clampHits} in ${s.clampSkins.length} skins`);
  for (const x of s.clampSkins) L.push(`  ${x.name} (${x.sha.slice(0, 12)}): ${x.clampHits}`);
  L.push(`size-less subviews after layout (they do not clip, risk R10): ${s.sizeless} of ${s.subviews} subviews, in ${s.sizelessSkins} skins, at most ${s.maxSizeless} in one`);
  L.push(`moveTo probe: ${s.moveLanded} of ${s.moveDriven} driven elements landed on the target`);
  L.push(`policy denials seen by the host (launchURL, view.close outside a gesture, ...): ${s.denied}`);
  L.push('');
  L.push(`load times (engine.load, ms): median ${s.loadMs.median.toFixed(1)}, p95 ${s.loadMs.p95.toFixed(1)}, max ${s.loadMs.max.toFixed(1)}`);
  L.push(`attach times (ms): median ${s.attachMs.median.toFixed(1)}, p95 ${s.attachMs.p95.toFixed(1)}, max ${s.attachMs.max.toFixed(1)}`);
  L.push(`slowest five by load + attach: ${s.slowest.map((x) => `${x.name} ${(x.loadMs + x.attachMs).toFixed(0)} ms`).join('; ')}`);
  L.push(`stage wall time: ${(r.wallMs / 1000).toFixed(1)} s`);
  L.push('');
  L.push('diagnostic codes (skins that raised each):');
  for (const [code, n] of [...s.codes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) L.push(`  ${code}: ${n}`);
  return L;
}

/**
 * docs/coverage/ledger.md
 * @param {StageResult} r
 * @returns {string}
 */
export function renderLedger(r) {
  const agg = [...aggregateLedger(r.rows).values()];
  const impl = implIndex();
  const demand = staticDemand();
  /** @param {{ api: string, kind: string }} e */
  const implOf = (e) => implOfEntry(impl, e);
  /** @type {Map<string, { entries: number, skins: number }>} */
  const kinds = new Map();
  for (const e of agg) {
    const k = kinds.get(e.kind) ?? { entries: 0, skins: 0 };
    k.entries++;
    k.skins = Math.max(k.skins, e.skins);
    kinds.set(e.kind, k);
  }
  /** @type {Map<string, LedgerRow>} */
  const touched = new Map();
  for (const e of agg) if (e.kind === 'stub' || e.kind === 'denied') touched.set(e.api.toLowerCase(), e);
  const reduced = reducedMembers();
  const n = r.rows.length;

  /** @type {string[]} */
  const L = [];
  L.push('# Coverage ledger');
  L.push('');
  L.push(`Generated by \`npm run coverage\` (\`tools/corpus.mjs\`, ENGINE D6.7) over ${n} distinct WMP skins (${r.archives} archives).`);
  L.push('Every skin runs headless through the real engine on the test host: load, attach, then a scripted minute');
  L.push('of play, pause, seek, resume, next and stop on the manual clock. Names and counts only, no skin art, no handler text.');
  L.push('');
  L.push('A row is one (member, kind) pair. **skins** is how many of the distinct skins reached it, **hits** the');
  L.push('sum of their counts, **impl** the member\'s implementation in `src/engine/model/schema.js` (`-` for names');
  L.push('the schema does not have: an unknown member, an unknown tag, an unresolved resource or binding, a soft-fault site).');
  L.push('A `stub` row whose impl is `emulated` or `live` is a write or call the emulation accepts and drops: the window shows one');
  L.push('view, so `openView` and `closeView` of any other view are ledgered and not carried out (phase 3 opens more windows).');
  L.push('A hand-over of the one window to another view (a `currentViewID` write, or `openView` from a view with no area) is a view');
  L.push('switch (5F.6), reported in `corpus-load.txt`, not a ledger row. A name shared by a host object and a THEME attribute lists both impls.');
  L.push('Ledgered kinds: `stub`, `denied`, `unknown-member`, `unknown-tag`, `unresolved-binding`, `unresolved-res`, `soft-fault` and `cap`.');
  L.push('`live` and `emulated` members are not ledgered, so their demand is `api-frequency.csv` (static references), not this file.');
  L.push('Stubs are implemented in rank order (notan Q3).');
  L.push('');
  L.push('A `soft-fault` row is a site where the realm or the runtime kept going after a fault: `handler <id>.<event>`,');
  L.push('`expr <id>.<attr>`, `script <file>`, `timer`, `call <name>`, `queue`, `jobs`, or a binding path. Its **hits** are **distinct reasons');
  L.push('per site, not occurrences**: the realm reports each (site, reason) pair once, so a handler that fails on every frame');
  L.push('adds 1 to its row. The occurrence count is the "realm soft faults" line of `corpus-load.txt`.');
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| kind | distinct entries | most skins on one entry |');
  L.push('|---|---:|---:|');
  for (const [kind, k] of [...kinds].sort((a, b) => (a[0] < b[0] ? -1 : 1))) L.push(`| ${cell(kind)} | ${k.entries} | ${k.skins} |`);
  L.push('');
  L.push('## Members the corpus reached');
  L.push('');
  L.push('| member | kind | impl | skins | hits |');
  L.push('|---|---|---|---:|---:|');
  for (const e of byDemand(agg)) L.push(`| ${cell(e.api)} | ${cell(e.kind)} | ${implOf(e)} | ${e.skins} | ${e.hits} |`);
  if (!agg.length) L.push('| (none) | | | 0 | 0 |');
  L.push('');
  L.push('## Stub, denied and emulated members: runtime and static demand');
  L.push('');
  L.push(`${reduced.length} members of the schema are not \`live\`. **skins (run)** is the ledger above (only \`stub\` and \`denied\``);
  L.push('are ledgered, so an emulated member shows `-`); **skins (static)** is how many corpus skins reference the member in script or');
  L.push('attribute text (`api-frequency.csv`: an object-model path, or an element method by name; `-` when the file has no row).');
  L.push('');
  L.push('| member | impl | skins (run) | hits | skins (static) |');
  L.push('|---|---|---:|---:|---:|');
  const reducedRows = reduced.map((m) => {
    const low = m.api.toLowerCase();
    const ledgered = m.impl === 'stub' || m.impl === 'denied';
    const ran = ledgered ? touched.get(low) : undefined;
    const staticSkins = demand.get(`o:${low}`) ?? (m.kind === 'method' ? demand.get(`m:${low.slice(low.lastIndexOf('.') + 1)}`) : undefined);
    return { ...m, ran: ledgered ? (ran?.skins ?? 0) : -1, hits: ran?.hits ?? 0, staticSkins: staticSkins ?? -1 };
  });
  reducedRows.sort((a, b) => b.ran - a.ran || b.staticSkins - a.staticSkins || (a.api < b.api ? -1 : a.api > b.api ? 1 : a.impl < b.impl ? -1 : 1));
  for (const m of reducedRows) L.push(`| ${cell(m.api)} | ${m.impl} | ${m.ran < 0 ? '-' : m.ran} | ${m.ran < 0 ? '-' : m.hits} | ${m.staticSkins < 0 ? '-' : m.staticSkins} |`);

  if (r.r0) {
    L.push('');
    L.push('## Headspace (R0)');
    L.push('');
    L.push(`The owner's \`Headspace.wmz\` (${r.r0.sha.slice(0, 12)}), loaded with its sidecar through the same scripted run, outside the ${n}.`);
    L.push('G5 expects only the stubs `pl.setColumnResizeMode` and `video`.');
    L.push('');
    L.push('| member | kind | impl | hits |');
    L.push('|---|---|---|---:|');
    const own = [...aggregateLedger([r.r0]).values()];
    for (const e of byDemand(own)) L.push(`| ${cell(e.api)} | ${cell(e.kind)} | ${implOf(e)} | ${e.hits} |`);
    if (!own.length) L.push('| (none) | | | 0 |');
  }
  L.push('');
  return L.join('\n');
}

// ---- writing --------------------------------------------------------------------------------------------

const REPORT_HEAD = [
  '# corpus-load: numbers from the corpus load run (WAVES W5.4, ENGINE D6.7 and D10.9 criterion 6).',
  '# Names of archives and counts only: no pixels, no handler text. Each stage rewrites its own section.',
  '#   node stage      npm run corpus -- load   (or npm run coverage)',
  '#   chromium stage  npm run skinlab -- corpus',
].join('\n');

/** @type {Record<string, string>} */
const SECTION_TITLES = Object.freeze({ node: 'node stage', chromium: 'chromium stage' });
const SECTION_ORDER = ['node', 'chromium'];

/**
 * Replace one stage's section of corpus-load.txt and keep the other. A section that was never written
 * says so. Returns the new text.
 * @param {string} file
 * @param {'node' | 'chromium'} id
 * @param {string[]} lines
 */
export function updateSection(file, id, lines) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const key of SECTION_ORDER) {
      const m = new RegExp(`^== ${SECTION_TITLES[key]} ==\\n([\\s\\S]*?)^== end ${SECTION_TITLES[key]} ==\\n`, 'm').exec(text);
      if (m) sections.set(key, m[1]);
    }
  }
  sections.set(id, `${lines.join('\n')}\n`);
  const body = SECTION_ORDER.map((key) => `== ${SECTION_TITLES[key]} ==\n${sections.get(key) ?? '(not run yet)\n'}== end ${SECTION_TITLES[key]} ==\n`).join('\n');
  const text = `${REPORT_HEAD}\n\n${body}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return text;
}

/**
 * Write the two Node-stage files.
 * @param {StageResult} r
 * @param {string} [dir]
 */
export function writeNodeReports(r, dir = COVERAGE_DIR) {
  mkdirSync(dir, { recursive: true });
  updateSection(join(dir, LOAD_FILE), 'node', renderNodeReport(r));
  writeFileSync(join(dir, LEDGER_FILE), renderLedger(r));
}

// ---- the command line -------------------------------------------------------------------------------------

/** @param {string[]} argv @returns {Promise<number>} exit code */
export async function main(argv) {
  /** @type {any} */
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { skins: { type: 'string' }, 'out-dir': { type: 'string' }, limit: { type: 'string' }, 'no-write': { type: 'boolean', default: false } },
      allowPositionals: false,
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\nusage: node tools/corpus.mjs [--skins <dir>] [--out-dir <dir>] [--limit <n>] [--no-write]`);
    return 2;
  }
  const dir = values.skins ? resolve(values.skins) : join(DEFAULT_SKINS_DIR, 'wmp');
  const limit = values.limit === undefined ? 0 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    console.error('--limit needs a whole number');
    return 2;
  }
  if (!existsSync(dir)) {
    console.log(`skip: no corpus at ${dir}; the reports are left as they are`);
    return 0;
  }
  const result = await runNodeStage({
    dir,
    limit,
    onRow: (row, i, n) => { if (i % 25 === 0 || i === n) console.log(`  ${i}/${n} skins`); },
  });
  const s = summarize(result);
  console.log(`${s.loaded}/${s.distinct} loaded; hard faults in ${s.hardSkins.length} skins; ${s.thrown.length} thrown, ${s.runtimeErrors} runtime-error, ${result.uncaught.length} process-level`);
  const failures = gateFailures(result, limit ? {} : { distinct: SURVEY_DISTINCT });
  for (const f of failures) console.error(`FAIL ${f}`);
  if (limit || values['no-write']) {
    console.log(limit ? `--limit ${limit}: a partial run, the reports are not written` : 'the reports are not written (--no-write)');
  } else {
    const out = values['out-dir'] ? resolve(values['out-dir']) : COVERAGE_DIR;
    writeNodeReports(result, out);
    console.log(`wrote ${join(out, LEDGER_FILE)} and the node section of ${join(out, LOAD_FILE)}`);
  }
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
