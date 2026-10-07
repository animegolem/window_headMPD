// fixtures --area <area> [--case id[,id]] [--list]
//
// Synthetic-skin rendering tests in pinned Chromium (E D9 "Skinlab fixtures"; WAVES W3.4). Each case in
// tools/skinlab/fixtures/*.case.js builds a skin from the tests/support writers, mounts it through the
// real engine chain on the test host in tools/skinlab/fixture.html, and computes the pixels it expects
// from the data it wrote. This command only drives: it opens a fresh page per case, takes the
// screenshot every time the case stops at one, compares it with the case's expectation (exact, or
// within the case's stated tolerance; two alpha-0 pixels are equal) and reports.
//
// No skin art is read or written: the fixtures are generated, and a failure's picture goes to the
// skinlab output directory under ~/Library/Caches, never into the repo.
//
// Exit codes (E D9): 0 every case passed, 1 a case failed, 2 usage, 77 Chromium is not installed.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromiumInfo, launchBrowser, watchPage } from './capture.mjs';
import { parseOptions, runId } from './common.mjs';
import { decodePng, encodePng, writeOutputs } from './diff.mjs';
import { EXIT, skip, usageError } from './exit.mjs';
import { SKINLAB_DIR, runOutDir } from './paths.mjs';

const FIXTURE_DIR = path.join(SKINLAB_DIR, 'fixtures');
const PAGE = '/tools/skinlab/fixture.html';

/** Everything a case may be asked for before it is run. */
async function discover() {
  const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith('.case.js')).sort();
  /** @type {Array<{ id: string, area: string, title: string, file: string }>} */
  const cases = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(FIXTURE_DIR, file)).href);
    if (typeof mod.area !== 'string' || !Array.isArray(mod.cases)) throw new Error(`${file} must export \`area\` and \`cases\``);
    for (const c of mod.cases) cases.push({ id: c.id, area: mod.area, title: c.title ?? c.id, file });
  }
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`fixture case id "${c.id}" is used twice`);
    seen.add(c.id);
  }
  return cases;
}

/**
 * The page is served by vite from the repo root, as the legacy page is. jpeg-js is CommonJS and the
 * shared config deliberately pre-bundles nothing (a mid-run optimise would make two runs differ), but
 * the image service imports the JPEG decoder statically, so this page names it. The config file is
 * not edited: the override is passed inline.
 */
async function startFixtureServer() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(SKINLAB_DIR, 'vite.config.js'),
    configLoader: 'native',
    optimizeDeps: { include: ['jpeg-js'] },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('vite did not report a port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/**
 * Compare a screenshot with the expected RGBA. Alpha-0 pixels are equal whatever their colour;
 * otherwise every channel must be within `tolerance`.
 * @param {{ width: number, height: number, data: Uint8Array }} actual @param {Uint8Array} expected @param {number} tolerance
 */
export function comparePixels(actual, expected, tolerance) {
  let bad = 0;
  let first = null;
  const minX = [Infinity, Infinity];
  const maxX = [-Infinity, -Infinity];
  for (let i = 0; i < actual.width * actual.height; i++) {
    const o = i * 4;
    const a = actual.data;
    const aAlpha = a[o + 3];
    const eAlpha = expected[o + 3];
    let same;
    if (aAlpha === 0 && eAlpha === 0) same = true;
    else same = [0, 1, 2, 3].every((k) => Math.abs(a[o + k] - expected[o + k]) <= tolerance);
    if (!same) {
      bad++;
      const x = i % actual.width;
      const y = (i - x) / actual.width;
      first ??= { x, y, got: [...a.subarray(o, o + 4)], want: [...expected.subarray(o, o + 4)] };
      minX[0] = Math.min(minX[0], x); minX[1] = Math.min(minX[1], y);
      maxX[0] = Math.max(maxX[0], x); maxX[1] = Math.max(maxX[1], y);
    }
  }
  return { bad, first, bbox: bad ? { x0: minX[0], y0: minX[1], x1: maxX[0], y1: maxX[1] } : null };
}

/** A picture where each differing pixel is red on the dimmed expectation. */
function diffPicture(actual, expected, tolerance) {
  const out = new Uint8Array(actual.data.length);
  for (let i = 0; i < actual.width * actual.height; i++) {
    const o = i * 4;
    const same = (actual.data[o + 3] === 0 && expected[o + 3] === 0) || [0, 1, 2, 3].every((k) => Math.abs(actual.data[o + k] - expected[o + k]) <= tolerance);
    if (same) out.set([expected[o], expected[o + 1], expected[o + 2], Math.min(120, expected[o + 3])], o);
    else out.set([255, 0, 0, 255], o);
  }
  return { width: actual.width, height: actual.height, data: out };
}

async function runCase(browser, baseUrl, def, outDir) {
  const context = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' });
  const failures = [];
  const files = {};
  let shots = 0;
  try {
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'load' });
    await Promise.race([page.waitForFunction(() => window.__skinlabFixture?.booted === true, null, { timeout: 30_000, polling: 25 }), watch.failed]);

    let stop = await page.evaluate((id) => window.__skinlabFixture.start(id), def.id);
    while (stop.shot) {
      const { name, rect, expected, tolerance } = stop.shot;
      shots++;
      const png = await page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h }, omitBackground: true, type: 'png' });
      const actual = decodePng(png);
      const want = new Uint8Array(Buffer.from(expected, 'base64'));
      let verdict = { ok: true, detail: '' };
      if (actual.width !== rect.w || actual.height !== rect.h) {
        verdict = { ok: false, detail: `the screenshot is ${actual.width}x${actual.height}, not ${rect.w}x${rect.h}` };
      } else {
        const cmp = comparePixels(actual, want, tolerance);
        if (cmp.bad) {
          const f = cmp.first;
          verdict = {
            ok: false,
            detail: `${cmp.bad} px differ in (${cmp.bbox.x0},${cmp.bbox.y0})-(${cmp.bbox.x1},${cmp.bbox.y1}); first at (${f.x},${f.y}): got rgba(${f.got}) want rgba(${f.want})`,
          };
          files[`${def.id}-${name}-actual`] = png;
          files[`${def.id}-${name}-expected`] = encodePng({ width: rect.w, height: rect.h, data: want });
          files[`${def.id}-${name}-diff`] = encodePng(diffPicture(actual, want, tolerance));
        }
      }
      stop = await page.evaluate((v) => window.__skinlabFixture.next(v), verdict);
    }
    failures.push(...stop.report.failures);
    failures.push(...watch.problems.map((p) => `page: ${p}`));
    return { id: def.id, title: def.title, pass: failures.length === 0, failures, notes: stop.report.notes, shots, files };
  } catch (e) {
    failures.push(`driver: ${e?.message ?? e}`);
    return { id: def.id, title: def.title, pass: false, failures, notes: [], shots, files };
  } finally {
    await context.close().catch(() => {});
  }
}

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    area: { type: 'string' },
    case: { type: 'string' },
    list: { type: 'boolean', default: false },
  });
  const all = await discover();
  const areas = [...new Set(all.map((c) => c.area))];
  if (values.list) {
    for (const c of all) console.log(`${c.area}\t${c.id}\t${c.title}`);
    return EXIT.PASS;
  }
  if (!values.area) throw usageError(`--area is required (known: ${areas.join(', ') || 'none'})`);
  if (!areas.includes(values.area)) throw usageError(`unknown area "${values.area}" (known: ${areas.join(', ') || 'none'})`);
  let chosen = all.filter((c) => c.area === values.area);
  if (values.case) {
    const want = values.case.split(',').map((s) => s.trim()).filter(Boolean);
    for (const w of want) if (!chosen.some((c) => c.id === w)) throw usageError(`no case "${w}" in area ${values.area}`);
    chosen = chosen.filter((c) => want.includes(c.id));
  }

  const info = chromiumInfo();
  if (!info.installed) throw skip(`Chromium ${info.revision} is not installed (run: npx playwright-core install chromium)`);
  const outDir = runOutDir(runId('fixtures'));
  const server = await startFixtureServer();
  let browser;
  const results = [];
  try {
    browser = await launchBrowser();
    for (const def of chosen) {
      const r = await runCase(browser, server.url, def, outDir);
      results.push(r);
      console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${def.id}${r.shots ? `  (${r.shots} shot${r.shots === 1 ? '' : 's'})` : ''}`);
      for (const f of r.failures) console.log(`        ${f}`);
      for (const n of r.notes) console.log(`        note: ${n}`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  await writeOutputs(outDir, {
    pngs: Object.assign({}, ...results.map((r) => r.files)),
    report: { area: values.area, chromiumRevision: info.revision, cases: results.map(({ files, ...rest }) => rest) },
  });
  console.log(`output: ${outDir}`);
  if (failed.length) {
    console.error(`FAIL: ${failed.map((r) => r.id).join(', ')}`);
    return EXIT.FAIL;
  }
  console.log(`PASS: ${results.length} case(s) in area ${values.area}`);
  return EXIT.PASS;
}

