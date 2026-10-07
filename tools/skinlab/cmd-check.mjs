// check --config compat|faithful [--state S1,S2,S2b,S3,S3b,S4,S5,S6,S7] [--dpr 1,2] [--browser chromium|webkit]
//       [--measure]
//
// The engine side of E D9: render the skin through the test host in pinned Chromium, in each engine
// configuration, state and DPR, and diff it against the legacy golden: pixels (exact, premultiplied,
// outside the exclusions and the allow-list) and the hit mask (XOR against the mask entries).
//
//   compat    zero differing pixels outside the effects hole; mask XOR exactly the 106 screen corners
//   faithful  every difference inside an allow-list entry, none over its bound
//   S2 == S2b in both configurations when both states are checked (the skin's own code path)
//
// States: S1, S2, S2b (engine only), S3, S3b (the real playlist widget, W3.7), S4, S5 (the fourteen
// hover and press states, `--state S5` or one by id), S6, and S7 (the EQ ear 60 ms into its slide,
// report-only: it is printed and written to report.json but never decides the exit code).
//
// `--config faithful` also renders compat, because button-transparency is defined as the XOR of the
// two engine masks. The run is strict by default (E D9, G4: "from now on skinlab runs with --strict"):
// an allow-list bound still null (measure mode) fails. `--strict` says so explicitly; `--measure` is
// the opt-out O uses when it adds an entry and needs the count.
//
// `--browser webkit` is the report-only WebKit pass (E D9, "What Chromium cannot see"). The legacy
// goldens are Chromium captures, so a WebKit engine against them would only show two rasterisers
// disagreeing about text. Instead the legacy hand port is captured live in the same WebKit, the engine
// is rendered in it, and the two go through the same allow-list; whatever lies beyond the Chromium
// pass is a finding, not a failure. The manifest and the oracle pin are not consulted, a state that
// cannot be rendered is recorded as an error in the report, and the exit code is 0 once the report is
// written (77 when WebKit is not installed: npx playwright-core install webkit).
//
// A failing Chromium comparison writes triage.txt next to report.json: per comparison its unabsorbed
// pixel and mask counts, the bounding box of every connected component, the allow-list entries that
// absorbed part of it and the diff PNGs. That report is the deliverable of a failing state; a fix task
// reads it and may not add an allow-list entry (only O can).
//
// Exit 0 pass, 1 fail (a gate, or the engine itself), 2 usage or wrong fixture, 77 skip.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { webkit } from 'playwright-core';
import { captureState, chromiumInfo, startLegacyServer, stateById, watchPage, withLegacySession } from './capture.mjs';
import { keyInputs, legacyKey, parseOptions, runId } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { ALLOWLIST_PATH, CONFIGS, activeEntries, materialize, readAllowlist, strictViolations } from './allowlist.mjs';
import { decodePng, diffImages, diffMasks, judge, rectMask, renderDiff, reportOf, writeOutputs, xorMask } from './diff.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { MANIFEST_PATH, REPO_ROOT, checkFixture, runOutDir, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';
import { computeRegions, regionMask } from './regions.mjs';
import { CLIP, PARK, SETTLE, SKIN_SIZE, STATES, VIEWPORT, expandStateGroups, parseDprs, resolveStep } from './states.mjs';
import { compareToManifest, loadGolden, readManifest, saveGolden } from './store.mjs';

export const BROWSERS = Object.freeze(['chromium', 'webkit']);

/**
 * How the engine reaches a state's last frame. `settled` is advance(500) in 16 ms frames and then
 * `runtime.settled()` (everything has stopped moving). `advance` is the clock alone, for S7: the legacy
 * pauses its transition at `atMs`, and `settled()` would wait for a tween that a stopped clock never
 * finishes.
 * @typedef {{ kind: 'settled' } | { kind: 'advance', ms: number }} EngineSettle
 */

/**
 * The engine-side states, in E D9 order. Every legacy state is reached by the same real input as the
 * legacy (`STATES` is the source of the steps and the media preset); S2b is engine-only: the skin's own
 * `ToggleEqView`, compared against S2's golden. `legacy` names the golden each is compared with.
 * `reportOnly` states are never part of the verdict. A Map: ids come from the command line.
 * @type {Map<string, { id: string, legacy: string, media: string, steps: ({ click: string } | { move: string } | { down: string } | { call: string })[],
 *                      settle: EngineSettle, reportOnly: boolean }>}
 */
export const ENGINE_STATES = new Map(
  [...STATES.values()]
    .flatMap((s) => {
      const settle = s.settle.kind === 'freeze' ? { kind: 'advance', ms: s.settle.atMs } : { kind: 'settled' };
      const own = { id: s.id, legacy: s.id, media: s.media, steps: s.steps, settle, reportOnly: s.id === 'S7' };
      const viaScript = { id: 'S2b', legacy: 'S2', media: s.media, steps: [{ call: 'ToggleEqView' }], settle, reportOnly: false };
      return s.id === 'S2' ? [own, viaScript] : [own];
    })
    .map((s) => [s.id, Object.freeze(s)]),
);

/**
 * `--state S1,S2b,S5`. A group name (S5) stands for its members; an unknown id is a usage error, never
 * a lookup into Object.prototype.
 * @param {string | null | undefined} list
 * @returns {string[]} ids in table order, once each
 */
export function parseEngineStateIds(list) {
  const all = [...ENGINE_STATES.keys()];
  if (list === undefined || list === null || list === '') return all;
  const named = String(list).split(',').map((s) => s.trim()).filter(Boolean);
  if (!named.length) throw new Error('--state is empty');
  const wanted = expandStateGroups(named);
  for (const id of wanted) {
    if (!ENGINE_STATES.has(id)) throw new Error(`unknown engine state "${id}" (known: S1, S2, S2b, S3, S3b, S4, S5 or one of its ${all.filter((i) => i.startsWith('S5.')).length} S5.<point>.<hover|down> ids, S6, S7)`);
  }
  return all.filter((id) => wanted.includes(id));
}

/** `--config compat,faithful` (or `all`, or either one). */
export function parseConfigList(list) {
  if (list === undefined || list === null || list === '' || list === 'all') return [...CONFIGS];
  const wanted = String(list).split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) throw new Error('--config is empty');
  for (const c of wanted) if (!CONFIGS.includes(c)) throw new Error(`unknown config "${c}" (known: ${CONFIGS.join(', ')})`);
  return CONFIGS.filter((c) => wanted.includes(c));
}

/** `--browser webkit`. Chromium is the gate; WebKit is report-only. */
export function parseBrowser(value) {
  if (value === undefined || value === null || value === '') return 'chromium';
  if (!BROWSERS.includes(value)) throw new Error(`unknown browser "${value}" (known: ${BROWSERS.join(', ')})`);
  return value;
}

async function readSidecar(sha) {
  const file = path.join(REPO_ROOT, 'src', 'app', 'sidecars', `${sha}.json`);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // none yet: W3.8 adds it
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw fail(`sidecar ${file} is not valid JSON: ${e.message}`);
  }
}

// ---- the engine page --------------------------------------------------------------------------------------

/**
 * Boot the engine page for one state and take the screenshot and the mask. A fresh context per
 * capture, as for the legacy. Returns `{error}` (not a throw) when the engine would not load the skin,
 * so the caller can name it.
 */
async function captureEngine(browser, baseUrl, job, state, dpr) {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: dpr,
    serviceWorkers: 'block',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto(`${baseUrl}/tools/skinlab/engine.html`, { waitUntil: 'load' });
    await Promise.race([
      page.waitForFunction(() => window.__skinlabEngine?.booted === true, null, { timeout: 30_000, polling: 50 }),
      watch.failed,
    ]);
    const mounted = await page.evaluate((j) => window.__skinlabEngine.mount(j), job);
    if (!mounted.ok) return { error: mounted.error, problems: [...watch.problems] };

    await page.mouse.move(PARK.x, PARK.y);
    for (const [i, step] of state.steps.entries()) {
      if ('call' in step) {
        await page.evaluate((name) => window.__skinlabEngine.call(name), step.call);
      } else {
        // The same real input as the legacy capture (capture.mjs): click parks the pointer straight
        // away (the ear slides under it otherwise); move and down leave it where it is, because the
        // hover or pressed art is the state, and down is never released.
        const { kind, at } = resolveStep(step);
        if (kind === 'click') {
          await page.mouse.click(at.x, at.y);
          await page.mouse.move(PARK.x, PARK.y);
        } else {
          await page.mouse.move(at.x, at.y);
          if (kind === 'down') await page.mouse.down();
        }
      }
      if (state.settle.kind === 'advance' && i === state.steps.length - 1) {
        await page.evaluate((ms) => window.__skinlabEngine.advance(ms), state.settle.ms);
      } else {
        await page.evaluate(() => window.__skinlabEngine.settle()); // advance(500) in 16 ms frames, then settled()
      }
    }
    await page.evaluate(async ({ rafs }) => {
      for (let i = 0; i < rafs; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    }, SETTLE);

    const png = await page.screenshot({ clip: { ...CLIP }, omitBackground: true, type: 'png' });
    const mask = await page.evaluate(() => window.__skinlabEngine.mask());
    const problems = [...watch.problems];
    if (mask.width !== SKIN_SIZE.width || mask.height !== SKIN_SIZE.height) problems.push(`the engine's mask is ${mask.width}x${mask.height}, expected ${SKIN_SIZE.width}x${SKIN_SIZE.height}`);
    if (problems.length) throw fail(`${state.id} @${dpr}x: ${problems.join('; ')}`);
    return { png, mask: Buffer.from(mask.b64, 'base64'), problems };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---- WebKit -----------------------------------------------------------------------------------------------

/** Run `fn({baseUrl, browser})` with the legacy/engine page server and Playwright WebKit; exits 77 when WebKit is absent. */
async function withWebKitSession(fn) {
  let executablePath = null;
  try {
    executablePath = webkit.executablePath();
  } catch {
    // no registry entry for this platform
  }
  if (!executablePath || !existsSync(executablePath)) throw skip('WebKit is not installed (run: npx playwright-core install webkit)');
  const server = await startLegacyServer();
  let browser;
  try {
    browser = await webkit.launch({ executablePath });
    return await fn({ baseUrl: server.url, browser, webkit: { executablePath, version: browser.version() } });
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// ---- the command ------------------------------------------------------------------------------------------

const n = (x) => x.toLocaleString('en-US');

function entryNotes(result) {
  const notes = [];
  for (const e of result.entries) {
    if (e.status === 'measure') notes.push(`${e.id}: ${n(e.count)} absorbed (null bound, measure mode)`);
    else if (e.status !== 'ok') notes.push(`${e.id}: ${n(e.count)} absorbed against ${n(e.bound)} [${e.status}]`);
    else if (e.unused) notes.push(`${e.id}: absorbed nothing (stale?)`);
  }
  return notes;
}

/** What a failing comparison needs from its reader, as plain text. */
function triageLines(r, files) {
  const lines = [`${r.config} ${r.state} @${r.dpr}x: ${r.failures.join('; ')}`];
  const side = (what, rep) => {
    lines.push(`  ${what}: ${n(rep.unabsorbed)} unabsorbed of ${n(rep.differing)} differing`);
    for (const c of rep.components.slice(0, 8)) lines.push(`    (${c.x0},${c.y0})-(${c.x1},${c.y1})  ${n(c.count)}`);
    // The exclusion is not a finding: it hides the effects hole in every state.
    for (const e of rep.entries) if (e.kind !== 'pixel-exclusion' && (e.count > 0 || e.status !== 'ok')) lines.push(`    absorbed by ${e.id}: ${n(e.count)} (${e.status}${e.bound === null ? '' : `, bound ${n(e.bound)}`})`);
  };
  side('pixels', { unabsorbed: r.pixels.unabsorbedSkinPx, differing: r.pixels.differingSkinPx, components: r.pixels.components ?? [], entries: r.pixels.entries ?? [] });
  side('mask', { unabsorbed: r.mask.unabsorbedCount, differing: r.mask.xorCount, components: r.mask.components ?? [], entries: r.mask.entries ?? [] });
  lines.push(`  images: ${files.join(', ')}`);
  return lines;
}

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    config: { type: 'string' },
    state: { type: 'string' },
    dpr: { type: 'string' },
    browser: { type: 'string' },
    strict: { type: 'boolean', default: false },
    measure: { type: 'boolean', default: false },
  });
  let configs;
  let ids;
  let dprs;
  let browserName;
  try {
    configs = parseConfigList(values.config);
    ids = parseEngineStateIds(values.state);
    dprs = parseDprs(values.dpr);
    browserName = parseBrowser(values.browser);
  } catch (e) {
    throw usageError(e.message);
  }
  if (values.strict && values.measure) throw usageError('--strict and --measure contradict each other');
  const strict = !values.measure;
  const reportOnlyRun = browserName !== 'chromium';

  const fixture = await checkFixture();
  if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
  if (fixture.status === 'badsha') throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}`);

  const list = await readAllowlist(ALLOWLIST_PATH);
  if (strict) {
    const nulls = new Set();
    for (const config of configs) for (const id of ids) for (const v of strictViolations(activeEntries(list, { config, state: id }))) nulls.add(v);
    // A report-only pass reports a null bound as it does any other finding; only the gate refuses.
    if (nulls.size && !reportOnlyRun) throw fail(`--strict: ${[...nulls].join('; ')}`);
  }

  const archive = new Uint8Array(await readFile(fixture.path));
  const regions = await computeRegions(archive, { name: path.basename(fixture.path) });
  if (regions.view.width !== SKIN_SIZE.width || regions.view.height !== SKIN_SIZE.height) {
    throw fail(`the skin's view is ${regions.view.width}x${regions.view.height}; skinlab's states are ${SKIN_SIZE.width}x${SKIN_SIZE.height}`);
  }
  const sidecar = await readSidecar(fixture.sha256);

  // The Chromium gate holds the legacy to its blessed goldens; the WebKit report has none (they are
  // Chromium captures), so it captures the legacy live in the same browser.
  let manifest = null;
  let pin = null;
  let inputs = null;
  const info = chromiumInfo();
  if (!reportOnlyRun) {
    manifest = await readManifest(MANIFEST_PATH);
    if (!manifest.entries.size) throw fail('no legacy goldens: the manifest is empty (run: npm run skinlab -- bless --target legacy --reason "...")');
    pin = await oraclePin();
    if (manifest.oraclePin !== pin) {
      throw fail(
        `oracle drift: a pinned file changed since the goldens were blessed (manifest pin ${manifest.oraclePin?.slice(0, 12)}, now ${pin.slice(0, 12)}). ` +
          'If that was intended (the re-pin batch), Opus re-blesses with --repin.',
      );
    }
    inputs = await keyInputs({ fixture, chromium: info });
  } else {
    await prepare({ log: () => {} }); // the live legacy needs public/skin/
  }
  const store = storeRoot();

  // Rendering faithful needs compat's mask for button-transparency, so compat is always rendered then.
  const rendered = configs.includes('faithful') ? CONFIGS.filter((c) => configs.includes(c) || c === 'compat') : configs;
  const archiveB64 = Buffer.from(archive).toString('base64');
  const outDir = runOutDir(runId(reportOnlyRun ? `check-${browserName}` : 'check'));
  const { width: sw, height: sh } = SKIN_SIZE;
  const results = [];
  const gates = [];
  const errors = [];
  const triage = [];

  /** @type {Map<string, { png: Buffer, mask: Buffer }>} */
  const legacyCache = new Map();

  const session = reportOnlyRun ? withWebKitSession : withLegacySession;
  await session(async ({ baseUrl, browser }) => {
    const legacyGolden = async (legacyId, dpr) => {
      if (reportOnlyRun) {
        const key = `live/${legacyId}/${dpr}`;
        const cached = legacyCache.get(key);
        if (cached) return cached;
        const cap = await captureState(browser, baseUrl, stateById(legacyId), dpr);
        const out = { png: cap.png, mask: cap.maskBits };
        legacyCache.set(key, out);
        return out;
      }
      const key = legacyKey(inputs, legacyId, dpr);
      const cached = legacyCache.get(key);
      if (cached) return cached;
      const entry = manifest.entries.get(key);
      if (!entry) {
        throw fail(`no legacy golden for ${legacyId} @${dpr}x under the current inputs (key ${key.slice(0, 12)}): bless it first (npm run skinlab -- bless --target legacy --states ${legacyId} --reason "...")`);
      }
      let golden = await loadGolden(key, entry, store);
      if (!golden) {
        // Missing or corrupt locally: re-capture from the legacy and hold the capture to the manifest.
        await prepare({ log: () => {} });
        const cap = await captureState(browser, baseUrl, stateById(legacyId), dpr);
        const cmp = compareToManifest(manifest, { ...cap, key });
        if (cmp.status !== 'ok') throw fail(`oracle drift: the legacy ${legacyId} @${dpr}x no longer matches the manifest (${cmp.diffs.join(', ') || cmp.status})`);
        await saveGolden(key, { png: cap.png, mask: cap.maskBits }, store);
        golden = { png: cap.png, mask: cap.maskBits };
      }
      const out = { png: golden.png, mask: golden.mask };
      legacyCache.set(key, out);
      return out;
    };

    for (const dpr of dprs) {
      /** @type {Map<string, { png: Buffer, mask: Buffer }>} `${config}/${state}` */
      const caps = new Map();
      for (const id of ids) {
        const state = ENGINE_STATES.get(id);
        /** @type {string | null} why this state could not be compared in a report-only run */
        let broken = null;
        for (const config of rendered) {
          try {
            const cap = await captureEngine(browser, baseUrl, { archive: archiveB64, name: path.basename(fixture.path), sidecar, config, media: state.media }, state, dpr);
            if (cap.error !== undefined) {
              if (/engine not implemented/.test(cap.error)) {
                throw fail('engine not implemented: createEngine(...).load rejected (src/engine/index.js is still the W0.1 stub; W4.1 replaces it)');
              }
              throw fail(`${config} ${id} @${dpr}x: the engine could not load the skin: ${cap.error}`);
            }
            caps.set(`${config}/${id}`, cap);
          } catch (e) {
            if (!reportOnlyRun) throw e;
            broken = String(e?.message ?? e);
            errors.push({ browser: browserName, config, state: id, dpr, error: broken });
            console.log(`  ${config.padEnd(9)}${id} @${dpr}x  ERROR (recorded, report-only): ${broken}`);
          }
        }
        if (broken) continue;

        let legacy;
        try {
          legacy = await legacyGolden(state.legacy, dpr);
        } catch (e) {
          if (!reportOnlyRun) throw e;
          errors.push({ browser: browserName, config: 'legacy', state: id, dpr, error: String(e?.message ?? e) });
          console.log(`  legacy ${state.legacy} @${dpr}x  ERROR (recorded, report-only): ${String(e?.message ?? e)}`);
          continue;
        }
        const lpng = decodePng(legacy.png);
        for (const config of configs) {
          const cap = caps.get(`${config}/${id}`);
          const epng = decodePng(cap.png);
          if (epng.width !== lpng.width || epng.height !== lpng.height) {
            throw fail(`${config} ${id} @${dpr}x: the engine screenshot is ${epng.width}x${epng.height}, the golden ${lpng.width}x${lpng.height}`);
          }
          const entries = materialize(activeEntries(list, { config, state: id }), {
            width: sw,
            height: sh,
            rect: (r) => rectMask(sw, sh, r),
            computed: (generator) =>
              generator === 'faithful-xor-compat'
                ? xorMask(caps.get(`faithful/${id}`).mask, caps.get(`compat/${id}`).mask)
                : regionMask(regions, generator),
          });
          const pix = diffImages(lpng, epng, { dpr, entries });
          const msk = diffMasks(legacy.mask, cap.mask, { width: sw, height: sh, entries });
          const pv = judge(pix, { strict });
          const mv = judge(msk, { strict });
          const pass = pv.pass && mv.pass;
          const reportOnly = reportOnlyRun || state.reportOnly;
          const tag = `${config}-${id}@${dpr}x`;
          const files = [`${tag}-legacy.png`, `${tag}-engine.png`, `${tag}-diff.png`];
          await writeOutputs(outDir, { pngs: { [`${tag}-legacy`]: legacy.png, [`${tag}-engine`]: cap.png, [`${tag}-diff`]: renderDiff(epng, pix) } });
          const result = {
            browser: browserName,
            config,
            state: id,
            dpr,
            pass,
            reportOnly,
            failures: [...pv.failures.map((f) => `pixels: ${f}`), ...mv.failures.map((f) => `mask: ${f}`)],
            pixels: reportOf(pix),
            mask: reportOf(msk),
          };
          results.push(result);
          if (!pass && !reportOnly) triage.push(...triageLines(result, files), '');
          const verdict = pass ? 'PASS' : reportOnly ? 'DIFFERS (report-only)' : 'FAIL';
          console.log(
            `  ${config.padEnd(9)}${id.padEnd(4)} @${dpr}x  pixels: ${n(pix.unabsorbedSkinPx)} unabsorbed of ${n(pix.differingSkinPx)} differing (${n(pix.excludedSkinPx)} excluded)  ` +
              `mask: xor ${n(msk.xorCount)}, ${n(msk.unabsorbedCount)} unabsorbed  ${verdict}`,
          );
          for (const note of [...entryNotes(pix), ...entryNotes(msk)]) console.log(`      ${note}`);
          for (const f of [...pv.failures, ...mv.failures]) console.log(`      ${reportOnly ? 'finding' : 'FAIL'} ${f}`);
          for (const c of pix.components.slice(0, 5)) console.log(`      pixels differ in (${c.x0},${c.y0})-(${c.x1},${c.y1}), ${n(c.count)} px`);
        }
      }

      // Gate 3: S2 and S2b are the same state reached two ways, so they must be identical, exclusion or not.
      if (ids.includes('S2') && ids.includes('S2b')) {
        for (const config of configs) {
          const a = caps.get(`${config}/S2`);
          const b = caps.get(`${config}/S2b`);
          if (!a || !b) continue; // a report-only state that would not render is already in `errors`
          const pa = decodePng(a.png);
          const pb = decodePng(b.png);
          const px = diffImages(pa, pb, { dpr });
          const mk = diffMasks(a.mask, b.mask, { width: sw, height: sh });
          const pass = px.differingSkinPx === 0 && mk.xorCount === 0;
          gates.push({ browser: browserName, gate: 'S2==S2b', config, dpr, pass, reportOnly: reportOnlyRun, pixels: px.differingSkinPx, maskBits: mk.xorCount });
          console.log(`  ${config.padEnd(9)}S2==S2b @${dpr}x  ${n(px.differingSkinPx)} px, ${n(mk.xorCount)} mask bits differ  ${pass ? 'PASS' : reportOnlyRun ? 'DIFFERS (report-only)' : 'FAIL'}`);
          if (!pass && !reportOnlyRun) triage.push(`S2==S2b ${config} @${dpr}x: ${n(px.differingSkinPx)} px and ${n(mk.xorCount)} mask bits differ between the two ways to the same state`, '');
        }
      }
    }
  });

  const bad = [
    ...results.filter((r) => !r.pass && !r.reportOnly).map((r) => `${r.config} ${r.state} @${r.dpr}x`),
    ...gates.filter((g) => !g.pass && !g.reportOnly).map((g) => `${g.gate} ${g.config} @${g.dpr}x`),
  ];
  const sets = { browser: browserName, reportOnly: reportOnlyRun, strict, configs, states: ids, dprs, skinSha256: fixture.sha256, oraclePin: pin, chromiumRevision: info.revision, sidecar: sidecar !== null, results, gates, errors };
  await writeOutputs(outDir, { report: sets });
  if (triage.length) {
    await writeFile(path.join(outDir, 'triage.txt'), `${triage.join('\n')}\n`);
    console.log(`triage: ${path.join(outDir, 'triage.txt')}`);
  }
  console.log(`output: ${outDir}`);

  if (reportOnlyRun) {
    const differing = results.filter((r) => !r.pass).length + gates.filter((g) => !g.pass).length;
    console.log(`REPORT (${browserName}, report-only): ${results.length} comparison(s), ${differing} with findings, ${errors.length} error(s); the exit code does not depend on them`);
    return EXIT.PASS;
  }
  if (bad.length) {
    console.error(`FAIL: ${bad.join(', ')}`);
    return EXIT.FAIL;
  }
  const reportOnlyCount = results.filter((r) => r.reportOnly).length;
  console.log(`PASS: ${results.length - reportOnlyCount} comparison(s) and ${gates.length} gate(s)${strict ? ' (strict)' : ''}${reportOnlyCount ? `, ${reportOnlyCount} report-only` : ''}`);
  return EXIT.PASS;
}
