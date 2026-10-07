// corpus [--config faithful|compat] [--skins <dir>] [--limit <n>] [--only <text>] [--no-write]
//
// The Chromium stage of the corpus run (E D6.7, D10.9 criterion 6; WAVES W5.4). Every distinct WMP skin
// is mounted through the engine page (tools/skinlab/engine.html, the page `check` renders), in pinned
// Chromium at DPR 1, one fresh page per skin: its first frame is screenshotted and its window shape read.
//
//   mount        `window.__skinlabEngine.mount` resolved ok (the engine loaded and attached the main view)
//   first frame  the screenshot of the skin's box has a pixel with alpha > 0
//   mask         the window shape has a set bit (reported, not a gate: an empty mask is a window nothing
//                can click, which the owner wants to know)
//
// The gates (exit 1): a renderer crash, a page hang, an uncaught exception in the page, a failed request,
// a skin that does not mount, a first frame with nothing in it. A page hang is a page that does not answer:
// no mount in HARD_MS, or any probe of the page (is the view attached, read the mask, wait a frame,
// screenshot, read the DOM) unanswered for PROBE_MS, which is what a stuck main thread looks like from here
// (`probe`). Without that every probe would wait for ever on such a page and the stage would never end.
//
// `mount` ends by waiting for the view to go quiet, and the manual clock only makes frames when it is
// advanced, so a view with a tween longer than mount's own 500 ms step would wait for ever. The stage asks
// whether the view is attached and, if so, advances the clock in 500 ms nudges (`settle()`) until mount
// returns. A skin that is still busy after MAX_NUDGES, which is one whose tween restarts itself, counts as
// "unsettled" (reported, not failed) and is screenshotted as it stands. `PERPETUAL_NOTES` in tools/corpus.mjs
// says what restarts the ones whose scripts were read.
//
// R0, the owner's Headspace.wmz (outside skins/), is mounted as one more row when the file is present.
//
// Nothing derived from skin art is written to the repository: screenshots live in memory only, and the
// report holds names and counts (WAVES global rule 2). Exit 0 pass, 1 fail, 2 usage, 77 skip (no corpus,
// or no Chromium). The Chromium section of docs/coverage/corpus-load.txt is rewritten on a full run.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromiumInfo, watchPage, withLegacySession } from './capture.mjs';
import { parseOptions } from './common.mjs';
import { decodePng, popcount } from './diff.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { LOAD_FILE, COVERAGE_DIR, SURVEY_DISTINCT, distinctArchives, headspaceFile, perpetualNote, rungOf, sidecarFor, updateSection } from '../corpus.mjs';
import { DEFAULT_SKINS_DIR } from '../make-corpus-manifest.mjs';

const MEDIA = 'stoppedQueue12';
const SOFT_MS = 400;            // mount still pending: ask whether the view is attached
const HARD_MS = 90_000;         // still not attached: a hang
const PROBE_MS = 20_000;        // a probe of the page unanswered this long: the main thread is stuck, a hang
const CLOSE_MS = 10_000;        // closing a page: a stuck renderer must not stop the stage
const LOOK_AGAIN_MS = 1000;     // an empty first frame is looked at once more after this long
const MAX_NUDGES = 24;          // x 500 ms of manual clock: the longest a tween may run before the view counts as unsettled
const MAX_VIEWPORT = 4096;
const CANVAS_AREA_CAP = 16_777_216;
const CONFIGS = ['faithful', 'compat'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => {
  const t = String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};
const quantile = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);

/**
 * @typedef {Object} ChromiumRow
 * @property {string} name
 * @property {string} sha
 * @property {string | null} rung
 * @property {boolean} mounted          the engine loaded and attached the main view
 * @property {string | null} mountError  the engine's own rejection, bounded
 * @property {boolean} unsettled        the view never went quiet on the manual clock
 * @property {boolean} hang
 * @property {string} hangWhy           what did not answer, when `hang` (bounded, no skin text)
 * @property {boolean} crashed
 * @property {string[]} problems        page errors, failed requests, HTTP errors
 * @property {number} consoleErrors
 * @property {{ width: number, height: number, pixels: number, painted: number } | null} frame
 * @property {number | null} maskSet    set bits of the window shape
 * @property {string | null} maskError
 * @property {{ count: number, maxArea: number, overCap: number, nodes: number, viewState: 'collapsed' | 'hidden' | 'masked' | 'open' }} dom
 *   `viewState`, from the view's own node: no area (the skin collapsed it or never sized it), `display: none`, clipped by a
 *   mask image, or none of those
 * @property {number} mountMs
 */

/** @param {string} b64 */
const bytesOf = (b64) => new Uint8Array(Buffer.from(b64, 'base64'));

/** A page that did not answer in time. The message is the reason the report prints. */
export class PageHang extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PageHang';
  }
}

/**
 * Wait for one probe of the page, at most `ms`. `page.evaluate` on a page whose main thread is stuck never
 * returns, and Playwright's own timeouts (screenshot, 30 s) arrive as a `TimeoutError`; both become a
 * `PageHang` naming the probe. Any other rejection passes through as it is. The work keeps a handler, so
 * a promise that rejects after the timer won is not an unhandled rejection.
 * @template T
 * @param {string} label what was asked
 * @param {Promise<T>} work
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export function probe(label, work, ms = PROBE_MS) {
  const why = `${label}: no answer in ${ms / 1000} s (the page's main thread is stuck)`;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new PageHang(why)), ms); });
  const asked = Promise.resolve(work).catch((e) => { throw e?.name === 'TimeoutError' ? new PageHang(why) : e; });
  return Promise.race([asked, stuck]).finally(() => clearTimeout(timer));
}

/** Rethrow a hang, drop any other error: for a probe whose failure otherwise means "not yet". @param {unknown} e */
const onlyHang = (e) => { if (e instanceof PageHang) throw e; };

/** Painted pixels of a PNG screenshot: alpha above zero. */
function paintedPixels(png) {
  const img = decodePng(png);
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 0) n++;
  return { width: img.width, height: img.height, pixels: img.width * img.height, painted: n };
}

/**
 * @typedef {Object} Limits
 * @property {number} softMs     mount still pending: ask whether the view is attached
 * @property {number} hardMs     still not attached: a hang
 * @property {number} probeMs    a probe of the page unanswered this long: a hang
 * @property {number} closeMs    closing the page
 * @property {number} lookAgainMs
 * @property {number} maxNudges
 */

/** The limits above, in one object so a test can shrink them. @type {Limits} */
export const LIMITS = Object.freeze({ softMs: SOFT_MS, hardMs: HARD_MS, probeMs: PROBE_MS, closeMs: CLOSE_MS, lookAgainMs: LOOK_AGAIN_MS, maxNudges: MAX_NUDGES });

/**
 * One skin in a fresh page. Every question put to the page goes through `probe`, so a stuck main thread
 * ends the row as a hang instead of ending the stage.
 * @param {any} context  a Playwright browser context (a test passes a stand-in)
 * @param {string} baseUrl
 * @param {{ name: string, sha: string, rung?: string | null, sidecar?: object | null }} entry
 * @param {Uint8Array} bytes
 * @param {string} config
 * @param {Partial<Limits>} [over]
 * @returns {Promise<ChromiumRow>}
 */
export async function mountOne(context, baseUrl, entry, bytes, config, over = {}) {
  const limits = { ...LIMITS, ...over };
  /** @type {ChromiumRow} */
  const row = {
    name: entry.name, sha: entry.sha, rung: entry.rung ?? null, mounted: false, mountError: null, unsettled: false, hang: false, hangWhy: '',
    crashed: false, problems: [], consoleErrors: 0, frame: null, maskSet: null, maskError: null,
    dom: { count: 0, maxArea: 0, overCap: 0, nodes: 0, viewState: 'open' }, mountMs: 0,
  };
  const page = await context.newPage();
  const watch = watchPage(page);
  page.on('crash', () => { row.crashed = true; });
  // A failed load is counted by `watchPage` (the favicon's 404 is not a problem), so it is not counted twice here.
  page.on('console', (/** @type {any} */ m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) row.consoleErrors++; });
  let started = Date.now();
  try {
    await page.goto(`${baseUrl}/tools/skinlab/engine.html`, { waitUntil: 'load' });
    await Promise.race([
      page.waitForFunction(() => window.__skinlabEngine?.booted === true, null, { timeout: 30_000, polling: 50 }),
      watch.failed,
    ]);

    const job = { archive: Buffer.from(bytes).toString('base64'), name: entry.name, config, media: MEDIA, ...(entry.sidecar ? { sidecar: entry.sidecar } : {}) };
    started = Date.now();
    let pending = true;
    /** @type {any} */
    let result = null;
    /** @type {any} */
    let evalError = null;
    page.evaluate((/** @type {any} */ j) => window.__skinlabEngine.mount(j), job).then(
      (/** @type {any} */ r) => { result = r; pending = false; },
      (/** @type {any} */ e) => { evalError = e; pending = false; },
    );
    let nudges = 0;
    while (pending && !row.crashed) {
      await sleep(40);
      const waited = Date.now() - started;
      if (!pending || waited < limits.softMs) continue;
      // `state.runtime` is set once attach returned; only the wait for quiet is left. That wait needs frames,
      // which the manual clock makes only when it is advanced, so a view with a tween longer than mount's own
      // 500 ms step is nudged: each `settle()` advances the clock 500 ms and wakes the pending wait.
      const attached = await probe('is the view attached', page.evaluate(() => { try { window.__skinlabEngine.mask(); return true; } catch { return false; } }).catch(() => false), limits.probeMs);
      if (attached) {
        if (nudges >= limits.maxNudges) { row.unsettled = true; break; }
        nudges++;
        await probe('settle', page.evaluate(() => { window.__skinlabEngine.settle().catch(() => {}); }).catch(onlyHang), limits.probeMs);
        await sleep(60);
      } else if (waited >= limits.hardMs) {
        throw new PageHang(`no mount in ${limits.hardMs / 1000} s`);
      }
    }
    row.mountMs = Date.now() - started;
    if (row.crashed) return row;
    if (evalError) {
      row.mountError = `evaluate failed: ${clip(evalError?.message ?? evalError, 160)}`;
      return row;
    }
    if (result && result.ok === false) {
      row.mountError = clip(result.error, 160);
      return row;
    }
    row.mounted = true;

    const mask = await probe('read the window mask', page.evaluate(() => window.__skinlabEngine.mask()), limits.probeMs).catch((e) => {
      if (e instanceof PageHang) throw e;
      row.maskError = clip(e?.message ?? e, 160);
      return null;
    });
    if (mask) row.maskSet = popcount(bytesOf(mask.b64));
    const width = Math.max(1, Math.min(MAX_VIEWPORT, mask?.width || 1));
    const height = Math.max(1, Math.min(MAX_VIEWPORT, mask?.height || 1));
    await probe('resize the viewport', page.setViewportSize({ width, height }), limits.probeMs);
    const frames = () => probe('wait for a frame', page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))), limits.probeMs);
    await frames();
    const shoot = async () => paintedPixels(await probe('screenshot', page.screenshot({ clip: { x: 0, y: 0, width, height }, omitBackground: true, type: 'png', timeout: limits.probeMs }), limits.probeMs));
    let frame = await shoot();
    if (frame.painted === 0) {
      // Not a verdict yet: a decode that is still landing paints late. Look once more.
      await sleep(limits.lookAgainMs);
      await frames();
      frame = await shoot();
    }
    row.frame = { width: mask?.width ?? 0, height: mask?.height ?? 0, pixels: frame.pixels, painted: frame.painted };

    row.dom = await probe('read the DOM', page.evaluate((/** @type {number} */ cap) => {
      const root = /** @type {HTMLElement} */ (document.getElementById('skin'));
      const canvases = [...root.querySelectorAll('canvas')];
      let maxArea = 0;
      let overCap = 0;
      for (const c of canvases) {
        const a = c.width * c.height;
        if (a > maxArea) maxArea = a;
        if (a > cap) overCap++;
      }
      const view = /** @type {HTMLElement | null} */ (root.querySelector('.view'));
      const w = parseFloat(view?.style.width ?? '');
      const h = parseFloat(view?.style.height ?? '');
      const layers = /** @type {HTMLElement | null} */ (root.querySelector('.layers'));
      const viewState = !(w > 0 && h > 0) ? 'collapsed' : view?.style.display === 'none' ? 'hidden' : layers && layers.style.maskImage ? 'masked' : 'open';
      return { count: canvases.length, maxArea, overCap, nodes: root.querySelectorAll('*').length, viewState };
    }, CANVAS_AREA_CAP), limits.probeMs);
  } catch (e) {
    if (e instanceof PageHang) {
      row.hang = true;
      row.hangWhy = e.message;
      row.mountMs ||= Date.now() - started;
    } else {
      row.problems.push(`stage error: ${clip(/** @type {any} */ (e)?.message ?? e, 200)}`);
    }
  } finally {
    for (const p of watch.problems) row.problems.push(clip(p, 200));
    // A renderer that is stuck may not close either; the stage goes on without waiting for it.
    await probe('close the page', page.close({ runBeforeUnload: false }), limits.closeMs).catch(() => {});
  }
  return row;
}

/** What fails a row. @param {ChromiumRow} r @returns {string[]} */
export function rowFailures(r) {
  const out = [];
  if (r.crashed) out.push('renderer crash');
  if (r.hang) out.push(`page hang (${r.hangWhy || 'the page did not answer'})`);
  if (r.mountError) out.push(`did not mount: ${r.mountError}`);
  for (const p of r.problems) out.push(p);
  if (r.mounted && !r.crashed && !r.hang && r.maskError) out.push(`mask: ${r.maskError}`);
  if (r.mounted && !r.crashed && !r.hang && r.frame && r.frame.painted === 0) out.push('first frame is empty');
  return out;
}

/** The Chromium section of corpus-load.txt. @param {ChromiumRow[]} rows @param {{ archives: number, info: any, config: string, wallMs: number, browserVersion: string }} meta */
export function renderChromiumReport(rows, meta) {
  const corpus = rows.filter((r) => r.rung !== 'R0');
  const r0 = rows.find((r) => r.rung === 'R0');
  const mounted = corpus.filter((r) => r.mounted);
  const crashes = rows.filter((r) => r.crashed);
  const hangs = rows.filter((r) => r.hang);
  const pageErrors = rows.filter((r) => r.problems.some((p) => p.startsWith('page error')));
  const failedRequests = rows.filter((r) => r.problems.some((p) => !p.startsWith('page error') && !p.startsWith('stage error')));
  const empty = mounted.filter((r) => r.frame && r.frame.painted === 0);
  const emptyMask = mounted.filter((r) => r.maskSet === 0);
  const unsettled = rows.filter((r) => r.unsettled);
  const times = corpus.map((r) => r.mountMs).sort((a, b) => a - b);
  const canvases = mounted.map((r) => r.dom.count).sort((a, b) => a - b);
  const maxArea = Math.max(0, ...mounted.map((r) => r.dom.maxArea));
  const L = [];
  L.push(`browser: Chromium ${meta.browserVersion} (Playwright ${meta.info.playwrightVersion}, revision ${meta.info.revision}), config ${meta.config}, DPR 1, media preset ${MEDIA}`);
  L.push(`archives: ${meta.archives}; distinct SHA-256: ${corpus.length} (the survey counts ${SURVEY_DISTINCT})`);
  L.push('');
  L.push(`mounted: ${mounted.length}/${corpus.length}`);
  L.push(`renderer crashes: ${crashes.length}; page hangs: ${hangs.length}; uncaught page exceptions: ${pageErrors.length} skins; failed requests: ${failedRequests.length} skins`);
  for (const r of hangs) L.push(`  hang: ${r.name} (${r.sha.slice(0, 12)}): ${r.hangWhy || 'the page did not answer'}`);
  L.push(`console errors logged by the page: ${rows.reduce((n, r) => n + r.consoleErrors, 0)}`);
  L.push(`first frame non-empty (a pixel with alpha > 0): ${mounted.length - empty.length}/${mounted.length}`);
  /** @type {Record<string, string>} */
  const WHY = {
    collapsed: 'the view shown has no area (nothing ever sized it, or a splash collapsed and the window never got another view)',
    hidden: 'the view is display:none (its own visible="false")',
    masked: 'the view is clipped by a mask image',
    open: 'the view has area, is shown and is not masked',
  };
  if (empty.length) {
    L.push(`  by the state of the view's own node: ${Object.keys(WHY).map((k) => `${k} ${empty.filter((r) => r.dom.viewState === k).length}`).join(', ')}`);
    for (const k of Object.keys(WHY)) if (empty.some((r) => r.dom.viewState === k)) L.push(`  ${k}: ${WHY[k]}`);
  }
  for (const r of empty) L.push(`  empty: ${r.name} (${r.sha.slice(0, 12)}) window ${r.frame?.width}x${r.frame?.height}, ${r.dom.viewState}`);
  L.push(`window mask non-empty: ${mounted.length - emptyMask.length}/${mounted.length}`);
  for (const r of emptyMask) L.push(`  empty mask: ${r.name} (${r.sha.slice(0, 12)}) ${r.frame?.width}x${r.frame?.height}`);
  L.push(`views still busy after ${MAX_NUDGES} x 500 ms of extra manual clock past mount (a tween that restarts itself): ${unsettled.length}`);
  for (const r of unsettled) L.push(`  ${r.name} (${r.sha.slice(0, 12)}): ${perpetualNote(r.sha) ?? 'cause not looked at'}`);
  L.push(`canvases per skin: median ${quantile(canvases, 0.5)}, max ${quantile(canvases, 1)}; largest canvas ${maxArea} px; canvases over ${CANVAS_AREA_CAP} px (expected 0): ${mounted.reduce((n, r) => n + r.dom.overCap, 0)}`);
  L.push(`mount times (ms, page load excluded): median ${quantile(times, 0.5)}, p95 ${quantile(times, 0.95)}, max ${quantile(times, 1)}`);
  if (r0) {
    L.push(`R0 Headspace.wmz (${r0.sha.slice(0, 12)}): ${r0.mounted ? 'mounted' : 'NOT mounted'}, first frame ${r0.frame?.painted ?? 0} painted px of ${r0.frame?.pixels ?? 0}, mask ${r0.maskSet ?? '?'} bits, ${r0.mountMs} ms`);
  } else {
    L.push('R0 Headspace.wmz: not run (no file on this machine)');
  }
  L.push(`stage wall time: ${(meta.wallMs / 1000).toFixed(1)} s`);
  const failing = rows.filter((r) => rowFailures(r).length);
  L.push(`failing skins: ${failing.length}`);
  for (const r of failing) L.push(`  ${r.name} (${r.sha.slice(0, 12)}): ${rowFailures(r).join('; ')}`);
  return L;
}

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    config: { type: 'string', default: 'faithful' },
    skins: { type: 'string' },
    limit: { type: 'string' },
    only: { type: 'string' },
    'no-write': { type: 'boolean', default: false },
  });
  if (!CONFIGS.includes(values.config)) throw usageError(`unknown --config "${values.config}" (known: ${CONFIGS.join(', ')})`);
  const limit = values.limit === undefined ? 0 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) throw usageError('--limit needs a whole number');
  const dir = values.skins ? resolve(values.skins) : join(DEFAULT_SKINS_DIR, 'wmp');
  if (!existsSync(dir)) throw skip(`no corpus at ${dir}`);
  const info = chromiumInfo();
  if (!info.installed) throw skip(`Chromium ${info.revision} is not installed (run: npx playwright-core install chromium)`);

  const { archives, distinct } = distinctArchives(dir);
  let todo = distinct.map((e) => ({ ...e, rung: rungOf(e), sidecar: sidecarFor(e.sha) }));
  if (values.only) todo = todo.filter((e) => e.name.toLowerCase().includes(String(values.only).toLowerCase()));
  if (limit) todo = todo.slice(0, limit);
  const partial = Boolean(limit || values.only);
  const hs = partial ? null : await headspaceFile();
  if (hs) {
    const bytes = readFileSync(hs);
    const sha = createHash('sha256').update(bytes).digest('hex');
    todo.push({ name: 'Headspace.wmz', names: ['Headspace.wmz'], path: hs, sha, rung: 'R0', sidecar: sidecarFor(sha) });
  }

  const started = Date.now();
  return withLegacySession(async ({ baseUrl, browser, chromium }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
    });
    /** @type {ChromiumRow[]} */
    const rows = [];
    try {
      for (const [i, entry] of todo.entries()) {
        const bytes = new Uint8Array(readFileSync(entry.path));
        const row = await mountOne(context, baseUrl, entry, bytes, values.config);
        rows.push(row);
        const bad = rowFailures(row);
        if (bad.length) console.log(`  FAIL ${entry.name}: ${bad.join('; ')}`);
        if ((i + 1) % 25 === 0 || i + 1 === todo.length) console.log(`  ${i + 1}/${todo.length} skins`);
      }
    } finally {
      await probe('close the context', context.close(), LIMITS.closeMs).catch(() => {});
    }

    const meta = { archives, info, config: values.config, wallMs: Date.now() - started, browserVersion: chromium.browserVersion };
    const lines = renderChromiumReport(rows, meta);
    console.log(lines.join('\n'));
    if (partial) console.log('a partial run (--limit or --only): the report is not written');
    else if (values['no-write']) console.log('the report is not written (--no-write)');
    else {
      updateSection(join(COVERAGE_DIR, LOAD_FILE), 'chromium', lines);
      console.log(`wrote the chromium section of ${join(COVERAGE_DIR, LOAD_FILE)}`);
    }
    const failing = rows.filter((r) => rowFailures(r).length);
    if (!partial && rows.filter((r) => r.rung !== 'R0').length !== SURVEY_DISTINCT) {
      throw fail(`${rows.filter((r) => r.rung !== 'R0').length} distinct skins ran, expected ${SURVEY_DISTINCT}`);
    }
    if (failing.length) throw fail(`${failing.length} skin(s) failed the Chromium stage`);
    return EXIT.PASS;
  });
}
