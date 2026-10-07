// check --config compat|faithful [--state S1,S2,S2b,S4] [--dpr 1,2] [--strict]
//
// The engine side of E D9: render the skin through the test host in pinned Chromium, in each engine
// configuration, state and DPR, and diff it against the legacy golden: pixels (exact, premultiplied,
// outside the exclusions and the allow-list) and the hit mask (XOR against the mask entries).
//
//   compat    zero differing pixels outside the effects hole; mask XOR exactly the 106 screen corners
//   faithful  every difference inside an allow-list entry, none over its bound
//   S2 == S2b in both configurations when both states are checked (the skin's own code path)
//
// `--config faithful` also renders compat, because button-transparency is defined as the XOR of the
// two engine masks. A null bound is measure mode (report and pass); `--strict` fails on any.
//
// W5.1 adds S3, S3b, S5, S6 and S7 to the engine state table below. Exit 0 pass, 1 fail (a gate, or
// the engine itself: "engine not implemented" until W4.1), 2 usage or wrong fixture, 77 skip.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureState, stateById, watchPage, withLegacySession, chromiumInfo } from './capture.mjs';
import { keyInputs, legacyKey, parseOptions, runId } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { ALLOWLIST_PATH, CONFIGS, activeEntries, materialize, readAllowlist, strictViolations } from './allowlist.mjs';
import { decodePng, diffImages, diffMasks, judge, rectMask, renderDiff, reportOf, writeOutputs, xorMask } from './diff.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { MANIFEST_PATH, REPO_ROOT, checkFixture, runOutDir, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';
import { computeRegions, regionMask } from './regions.mjs';
import { CLIP, PARK, POINTS, SETTLE, SKIN_SIZE, STATES, VIEWPORT, parseDprs } from './states.mjs';
import { compareToManifest, loadGolden, readManifest, saveGolden } from './store.mjs';

/**
 * The engine-side states. S1, S2 and S4 reach their state by the same real clicks as the legacy
 * (`STATES` is the source of the steps); S2b is engine-only: the skin's own `ToggleEqView`, compared
 * against S2's golden. `legacy` names the golden each is compared with. A Map: ids come from the
 * command line.
 * @type {Map<string, { id: string, legacy: string, media: string, steps: ({ click: string } | { call: string })[] }>}
 */
export const ENGINE_STATES = new Map([
  ['S1', { id: 'S1', legacy: 'S1', media: STATES.get('S1').media, steps: STATES.get('S1').steps }],
  ['S2', { id: 'S2', legacy: 'S2', media: STATES.get('S2').media, steps: STATES.get('S2').steps }],
  ['S2b', { id: 'S2b', legacy: 'S2', media: STATES.get('S2').media, steps: [{ call: 'ToggleEqView' }] }],
  ['S4', { id: 'S4', legacy: 'S4', media: STATES.get('S4').media, steps: STATES.get('S4').steps }],
]);

/** `--state S1,S2b`. Unknown ids are a usage error, never a lookup into Object.prototype. */
export function parseEngineStateIds(list) {
  const all = [...ENGINE_STATES.keys()];
  if (list === undefined || list === null || list === '') return all;
  const wanted = String(list).split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) throw new Error('--state is empty');
  for (const id of wanted) {
    if (!ENGINE_STATES.has(id)) throw new Error(`unknown engine state "${id}" (known: ${all.join(', ')}; S3, S3b, S5, S6 and S7 arrive with W5.1)`);
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
    for (const step of state.steps) {
      if ('click' in step) {
        const at = POINTS[step.click];
        await page.mouse.click(at.x, at.y);
        await page.mouse.move(PARK.x, PARK.y); // the ear slides under the pointer otherwise
      } else {
        await page.evaluate((name) => window.__skinlabEngine.call(name), step.call);
      }
      await page.evaluate(() => window.__skinlabEngine.settle()); // advance(500) in 16 ms frames, then settled()
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

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    config: { type: 'string' },
    state: { type: 'string' },
    dpr: { type: 'string' },
    strict: { type: 'boolean', default: false },
  });
  let configs;
  let ids;
  let dprs;
  try {
    configs = parseConfigList(values.config);
    ids = parseEngineStateIds(values.state);
    dprs = parseDprs(values.dpr);
  } catch (e) {
    throw usageError(e.message);
  }

  const fixture = await checkFixture();
  if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
  if (fixture.status === 'badsha') throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}`);

  const list = await readAllowlist(ALLOWLIST_PATH);
  if (values.strict) {
    const nulls = new Set();
    for (const config of configs) for (const id of ids) for (const v of strictViolations(activeEntries(list, { config, state: id }))) nulls.add(v);
    if (nulls.size) throw fail(`--strict: ${[...nulls].join('; ')}`);
  }

  const archive = new Uint8Array(await readFile(fixture.path));
  const regions = await computeRegions(archive, { name: path.basename(fixture.path) });
  if (regions.view.width !== SKIN_SIZE.width || regions.view.height !== SKIN_SIZE.height) {
    throw fail(`the skin's view is ${regions.view.width}x${regions.view.height}; skinlab's states are ${SKIN_SIZE.width}x${SKIN_SIZE.height}`);
  }
  const sidecar = await readSidecar(fixture.sha256);

  const manifest = await readManifest(MANIFEST_PATH);
  if (!manifest.entries.size) throw fail('no legacy goldens: the manifest is empty (run: npm run skinlab -- bless --target legacy --reason "...")');
  const pin = await oraclePin();
  if (manifest.oraclePin !== pin) {
    throw fail(
      `oracle drift: a pinned file changed since the goldens were blessed (manifest pin ${manifest.oraclePin?.slice(0, 12)}, now ${pin.slice(0, 12)}). ` +
        'If that was intended (the re-pin batch), Opus re-blesses with --repin.',
    );
  }
  const info = chromiumInfo();
  const inputs = await keyInputs({ fixture, chromium: info });
  const store = storeRoot();

  // Rendering faithful needs compat's mask for button-transparency, so compat is always rendered then.
  const rendered = configs.includes('faithful') ? CONFIGS.filter((c) => configs.includes(c) || c === 'compat') : configs;
  const archiveB64 = Buffer.from(archive).toString('base64');
  const outDir = runOutDir(runId('check'));
  const { width: sw, height: sh } = SKIN_SIZE;
  const results = [];
  const gates = [];

  /** @type {Map<string, { png: Buffer, mask: Buffer }>} */
  const legacyCache = new Map();

  await withLegacySession(async ({ baseUrl, browser }) => {
    const legacyGolden = async (legacyId, dpr) => {
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
        for (const config of rendered) {
          const cap = await captureEngine(browser, baseUrl, { archive: archiveB64, name: path.basename(fixture.path), sidecar, config, media: state.media }, state, dpr);
          if (cap.error !== undefined) {
            if (/engine not implemented/.test(cap.error)) {
              throw fail('engine not implemented: createEngine(...).load rejected (src/engine/index.js is still the W0.1 stub; W4.1 replaces it)');
            }
            throw fail(`${config} ${id} @${dpr}x: the engine could not load the skin: ${cap.error}`);
          }
          caps.set(`${config}/${id}`, cap);
        }

        const legacy = await legacyGolden(state.legacy, dpr);
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
          const pv = judge(pix, { strict: values.strict });
          const mv = judge(msk, { strict: values.strict });
          const pass = pv.pass && mv.pass;
          const tag = `${config}-${id}@${dpr}x`;
          await writeOutputs(outDir, { pngs: { [`${tag}-legacy`]: legacy.png, [`${tag}-engine`]: cap.png, [`${tag}-diff`]: renderDiff(epng, pix) } });
          results.push({ config, state: id, dpr, pass, failures: [...pv.failures.map((f) => `pixels: ${f}`), ...mv.failures.map((f) => `mask: ${f}`)], pixels: reportOf(pix), mask: reportOf(msk) });
          console.log(
            `  ${config.padEnd(9)}${id.padEnd(4)} @${dpr}x  pixels: ${n(pix.unabsorbedSkinPx)} unabsorbed of ${n(pix.differingSkinPx)} differing (${n(pix.excludedSkinPx)} excluded)  ` +
              `mask: xor ${n(msk.xorCount)}, ${n(msk.unabsorbedCount)} unabsorbed  ${pass ? 'PASS' : 'FAIL'}`,
          );
          for (const note of [...entryNotes(pix), ...entryNotes(msk)]) console.log(`      ${note}`);
          for (const f of [...pv.failures, ...mv.failures]) console.log(`      FAIL ${f}`);
          for (const c of pix.components.slice(0, 5)) console.log(`      pixels differ in (${c.x0},${c.y0})-(${c.x1},${c.y1}), ${n(c.count)} px`);
        }
      }

      // Gate 3: S2 and S2b are the same state reached two ways, so they must be identical, exclusion or not.
      if (ids.includes('S2') && ids.includes('S2b')) {
        for (const config of configs) {
          const a = caps.get(`${config}/S2`);
          const b = caps.get(`${config}/S2b`);
          const pa = decodePng(a.png);
          const pb = decodePng(b.png);
          const px = diffImages(pa, pb, { dpr });
          const mk = diffMasks(a.mask, b.mask, { width: sw, height: sh });
          const pass = px.differingSkinPx === 0 && mk.xorCount === 0;
          gates.push({ gate: 'S2==S2b', config, dpr, pass, pixels: px.differingSkinPx, maskBits: mk.xorCount });
          console.log(`  ${config.padEnd(9)}S2==S2b @${dpr}x  ${n(px.differingSkinPx)} px, ${n(mk.xorCount)} mask bits differ  ${pass ? 'PASS' : 'FAIL'}`);
        }
      }
    }
  });

  await writeOutputs(outDir, {
    report: { strict: values.strict, configs, states: ids, dprs, skinSha256: fixture.sha256, oraclePin: pin, chromiumRevision: info.revision, sidecar: sidecar !== null, results, gates },
  });
  console.log(`output: ${outDir}`);
  const bad = [...results.filter((r) => !r.pass).map((r) => `${r.config} ${r.state} @${r.dpr}x`), ...gates.filter((g) => !g.pass).map((g) => `${g.gate} ${g.config} @${g.dpr}x`)];
  if (bad.length) {
    console.error(`FAIL: ${bad.join(', ')}`);
    return EXIT.FAIL;
  }
  console.log(`PASS: ${results.length} comparison(s) and ${gates.length} gate(s)${values.strict ? ' (strict)' : ''}`);
  return EXIT.PASS;
}
