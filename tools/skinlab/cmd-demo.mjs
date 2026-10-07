// demo --target legacy [--media stoppedEmpty] [--out <dir>]
//
// Runs the pinned legacy tour (src/demo.js, `runDemo`) headless under the skinlab Tauri stub, the way
// Rust starts it: a `mpd-message` event carrying "demo <wav>". Records what the tour does to the
// outside world, as the reference W5.3 compares the engine's tour against:
//
//   - the `mpd`, `set_eq`, `set_balance`, `set_capture`, `set_hit_mask` (shape only), `record_start`,
//     `record_stop` and `js_log` calls, each with a timestamp in seconds from `record_start`, which is
//     the tour's own t = 0 (the sync flash; negative times are the stage setup before it);
//   - the `localStorage` writes that carry what no call does: `eqOpen`, `plOpen`, `preset`, `eq`;
//   - a summary derived from those: when the EQ drawer opened, the band values after each drag, the
//     number of preset steps, the ordered `mpd` verbs.
//
// Real time, like the legacy capture: the tour is about 41 s of setTimeout and performance.now, and
// this command never installs a fake page clock (E D9). Exit 0 pass, 1 the tour or the log failed a
// check (the log is still written), 2 usage or wrong fixture, 77 fixture or Chromium absent.
//
// The log is plain data about calls, no art: it goes to the run's output directory
// (~/Library/Caches/window_headmpd/skinlab/out/<run>/demo-legacy.json) and, on a pass, is copied to
// ~/Library/Caches/window_headmpd/skinlab/demo/legacy-<media>.json so a later --compare finds it.
//
// The stub's `mpd status` is canned and never changes, so `player.state` stays what the media preset
// says and the verbs the tour sends depend on it. The preset is part of the reference; it is written
// into the log header, and stoppedEmpty is the default because it is the S1 baseline.

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { watchPage, withLegacySession } from './capture.mjs';
import { BOOT_QUIET_MS, VIEWPORT } from './states.mjs';
import { parseOptions, runId } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { EXIT, fail, usageError } from './exit.mjs';
import { hasMediaPreset, MEDIA_PRESET_NAMES } from './media-presets.js';
import { runOutDir, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';

export const LOG_FORMAT = 'skinlab-demo-log/1';
export const LOG_FILE = 'demo-legacy.json';
export const DEFAULT_MEDIA = 'stoppedEmpty';

/** Where a passing run leaves its log for W5.3's --compare: one per media preset, since the verbs differ. */
export const referenceCopy = (media, root = storeRoot()) => path.join(root, 'demo', `legacy-${media}.json`);

/** The default of main.js:551, so a run is what `mpc sendmessage window_head demo` would start. */
export const DEMO_WAV = '/tmp/window_headmpd-demo.wav';

/** Served by the skinlab vite server from the repo root; see demo-legacy-mount.js. */
export const MOUNT_URL = '/tools/skinlab/demo-legacy-mount.js';

/** What the pinned tour does, as numbers (WAVES W4.4/W5.3, checked against demo.js:150-186). */
export const EXPECT = Object.freeze({
  bandsAfterDrags: Object.freeze([10, 8, 0, 0, -5, 0, 0, 0, 6, 9]),
  dragBands: Object.freeze([0, 1, 4, 8, 9]),
  presetSteps: 5,
  // The check is the schedule the tour keeps, "open before the first drag starts": until(7.0), a 1100 ms
  // glide, then the click (demo.js:158-162) puts the EQ toggle at about 8.2 s, and the first drag is
  // scheduled at 8.6 s (demo.js:165).
  eqOpenBeforeS: 8.6,
});

const TOUR_START_TIMEOUT_MS = 10_000;
const TOUR_TIMEOUT_MS = 90_000; // 2 s of stage setup plus the 39.5 s schedule, with slack for a loaded machine

const round3 = (n) => Math.round(n * 1000) / 1000;
const parseVector = (text) => {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const sameVector = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// ---- the log: pure functions, unit-tested ------------------------------------------------------------

/**
 * Turn what the page recorded into the log's `calls` and `prefs`, in seconds from `record_start`.
 * @param {{events: {at:number, kind:'call'|'pref', [k:string]: any}[], others?: [string, number][], startedAt?: number}} raw
 */
export function buildLog(raw, { media, wav = DEMO_WAV, target = 'legacy', ...header } = {}) {
  const events = raw.events; // appended in order by the page's one performance.now() clock
  const first = events.find((e) => e.kind === 'call' && e.cmd === 'record_start');
  // Without record_start the tour never reached its sync flash; time from the trigger so the log is
  // still readable, and let checkSummary say what is missing.
  const base = first?.at ?? raw.startedAt ?? events[0]?.at ?? 0;
  const t = (at) => round3((at - base) / 1000);
  const calls = events.filter((e) => e.kind === 'call').map((e) => ({ t: t(e.at), cmd: e.cmd, args: e.args ?? null }));
  const prefs = events.filter((e) => e.kind === 'pref').map((e) => ({ t: t(e.at), key: e.key, value: e.value }));
  // Command names come from the page: a null-prototype object, so "__proto__" is just a name.
  const otherCalls = Object.create(null);
  for (const [name, count] of raw.others ?? []) otherCalls[name] = count;
  return {
    format: LOG_FORMAT,
    target,
    media,
    wav,
    timeBase: first ? 'record_start' : 'trigger (no record_start was seen)',
    ...header,
    calls,
    prefs,
    otherCalls,
    summary: summarize(calls, prefs),
  };
}

/**
 * Facts about the tour, derived from the log's calls and prefs.
 * A drag is bracketed by `set_capture` on and off, which only the sliders call; its band is the one
 * value that changed between the two, and its values are the last `set_eq` inside the bracket (the
 * reset click and the teardown send zeros later, so the last `set_eq` overall is not "after the drags").
 */
export function summarize(calls, prefs) {
  const mpd = calls.filter((c) => c.cmd === 'mpd').map((c) => ({ t: c.t, argv: (c.args?.args ?? []).map(String) }));
  const start = calls.find((c) => c.cmd === 'record_start');
  const stop = calls.find((c) => c.cmd === 'record_stop');

  const drags = [];
  let eq = Array(10).fill(0);
  let open = null;
  let inputs = 0;
  for (const c of calls) {
    if (c.cmd === 'set_eq' && Array.isArray(c.args?.gains)) {
      eq = [...c.args.gains];
      inputs++;
    } else if (c.cmd === 'set_capture') {
      if (c.args?.on && !open) {
        open = { startT: c.t, before: [...eq] };
        inputs = 0;
      } else if (!c.args?.on && open) {
        const changed = eq.flatMap((v, i) => (v !== open.before[i] ? [i] : []));
        const band = changed.length === 1 ? changed[0] : null;
        drags.push({ startT: open.startT, endT: c.t, band, to: band === null ? null : eq[band], inputs, eq: [...eq] });
        open = null;
      }
    }
  }

  // What the legacy itself persisted when each drag ended (onChange -> store.set('eq')): a second read
  // of the same values, from a different code path than the set_eq calls.
  const persisted = prefs.filter((p) => p.key === 'eq').map((p) => ({ t: p.t, eq: parseVector(p.value) }));
  for (const d of drags) d.persisted = persisted.find((p) => p.t >= d.endT && p.t <= d.endT + 0.05)?.eq ?? null;

  const prefAt = (key, value) => prefs.find((p) => p.key === key && p.value === value)?.t ?? null;
  const logs = calls.filter((c) => c.cmd === 'js_log').map((c) => ({ t: c.t, msg: String(c.args?.msg ?? '') }));
  const presets = prefs.filter((p) => p.key === 'preset' && p.t >= 0);
  return {
    recordStartT: start?.t ?? null,
    recordStopT: stop?.t ?? null,
    recordStopPath: stop?.args?.path ?? null,
    durationS: calls.length ? Math.max(...calls.map((c) => c.t)) : 0,
    mpdVerbs: mpd.map((m) => m.argv.join(' ')),
    mpd,
    eqOpenAt: prefAt('eqOpen', 'true'),
    plOpenAt: prefAt('plOpen', 'true'),
    drags,
    bandsAfterDrags: drags.length ? drags[drags.length - 1].eq : null,
    presetSteps: presets.length,
    presetValues: presets.map((p) => p.value),
    jsLog: logs,
    jsLogErrors: logs.filter((l) => !l.msg.startsWith('demo: ')).map((l) => l.msg),
  };
}

/** The acceptance checks of W4.4 as a list of problems; empty means the log is the reference. */
export function checkSummary(summary, { wav = DEMO_WAV } = {}) {
  const problems = [];
  if (summary.recordStartT === null) problems.push('the tour never called record_start');
  if (summary.recordStopT === null) problems.push('the tour never called record_stop');
  else if (summary.recordStopPath !== wav) problems.push(`record_stop wrote to ${JSON.stringify(summary.recordStopPath)}, expected ${JSON.stringify(wav)}`);
  if (summary.eqOpenAt === null) problems.push('the EQ drawer never opened');
  else if (summary.eqOpenAt > EXPECT.eqOpenBeforeS) problems.push(`the EQ drawer opened at t = ${summary.eqOpenAt} s, after the first drag was due (${EXPECT.eqOpenBeforeS} s)`);
  const bands = summary.drags.map((d) => d.band);
  if (!sameVector(bands, [...EXPECT.dragBands])) problems.push(`drags moved bands ${JSON.stringify(bands)}, expected ${JSON.stringify(EXPECT.dragBands)}`);
  if (!sameVector(summary.bandsAfterDrags, [...EXPECT.bandsAfterDrags])) {
    problems.push(`band values after the drags are ${JSON.stringify(summary.bandsAfterDrags)}, expected ${JSON.stringify(EXPECT.bandsAfterDrags)}`);
  }
  summary.drags.forEach((d, i) => {
    if (!sameVector(d.persisted, d.eq)) problems.push(`drag ${i + 1}: the legacy persisted ${JSON.stringify(d.persisted)} but its last set_eq was ${JSON.stringify(d.eq)}`);
  });
  if (summary.presetSteps !== EXPECT.presetSteps) problems.push(`${summary.presetSteps} preset steps, expected ${EXPECT.presetSteps}`);
  for (const msg of summary.jsLogErrors) problems.push(`the legacy reported: ${msg}`);
  return problems;
}

export function formatReport(log) {
  const s = log.summary;
  const at = (t) => (t === null ? 'never' : `${t.toFixed(3)} s`);
  const lines = [
    `legacy demo tour, media ${log.media}, t = 0 at ${log.timeBase}`,
    `  calls: ${log.calls.length}, prefs: ${log.prefs.length}, tour ends at t = ${at(s.durationS)}`,
    `  mpd (${s.mpd.length}): ${s.mpd.map((m) => `${m.argv.join(' ')} @${m.t.toFixed(2)}`).join(', ') || 'none'}`,
    `  record_start at ${at(s.recordStartT)}, record_stop at ${at(s.recordStopT)} -> ${s.recordStopPath}`,
    `  EQ drawer opened at t = ${at(s.eqOpenAt)} (demo.js clicks the handle at about 8.2 s; first drag due ${EXPECT.eqOpenBeforeS} s)`,
    `  PL drawer opened at t = ${at(s.plOpenAt)}`,
    `  drags (${s.drags.length}): ${s.drags.map((d) => `band ${d.band} -> ${d.to} @${d.startT.toFixed(2)}-${d.endT.toFixed(2)}`).join(', ')}`,
    `  band values after the drags: ${JSON.stringify(s.bandsAfterDrags)}`,
    `  preset steps: ${s.presetSteps} (preset index ${s.presetValues.join(' -> ')})`,
  ];
  return lines.join('\n');
}

// ---- options ----------------------------------------------------------------------------------------

/** Validated before anything is prepared or launched, so a typo costs nothing. */
export function parseDemoOptions(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    media: { type: 'string' },
    out: { type: 'string' },
  });
  if (values.target === undefined) throw usageError('--target legacy is required');
  if (values.target === 'engine') throw usageError('--target engine arrives with the demo on the engine (W5.3)');
  if (values.target !== 'legacy') throw usageError(`unknown --target "${values.target}" (only "legacy" exists here)`);
  const media = values.media ?? DEFAULT_MEDIA;
  if (!hasMediaPreset(media)) throw usageError(`unknown media preset "${media}" (known: ${MEDIA_PRESET_NAMES.join(', ')})`);
  return { target: 'legacy', media, out: values.out ? path.resolve(values.out) : null };
}

// ---- driving the page -------------------------------------------------------------------------------

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

/**
 * Wait for `wait` (a page.waitForFunction) or for the first page problem, whichever comes first, and say
 * what was being waited for. The loser must not become an unhandled rejection when the context closes.
 */
async function waitFor(what, watch, wait) {
  wait.catch(() => {});
  try {
    await Promise.race([wait, watch.failed]);
  } catch (e) {
    throw new Error(`${what}: ${firstLine(e)}`);
  }
}

/**
 * Load legacy.html in `media` and wait until it is as still as it is for a capture. capture.mjs keeps
 * its own boot private, so the same waits are repeated: booted, every image decoded (an undecoded
 * handle has a 0x0 box and the tour's glide would aim at the corner), fonts, then the boot timers.
 */
async function bootLegacy(page, watch, url) {
  await page.goto(url, { waitUntil: 'load' });
  await waitFor('the legacy page did not boot', watch, page.waitForFunction(() => window.__skinlab?.booted === true, null, { timeout: 30_000, polling: 50 }));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.complete && img.naturalWidth > 0
          ? true
          : new Promise((resolve, reject) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', () => reject(new Error(`image failed: ${img.src}`)), { once: true });
            }),
      ),
    );
  });
  await page.waitForTimeout(BOOT_QUIET_MS);
}

/**
 * One tour in a fresh context. Tour failures are returned as `problems` (the log is still worth
 * writing); only a browser that cannot start, or a page that never boots, throws.
 */
async function runTour(browser, baseUrl, media) {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    const watch = watchPage(page);
    await bootLegacy(page, watch, `${baseUrl}/tools/skinlab/legacy.html?media=${encodeURIComponent(media)}`);
    // A string, not a function: under vitest a function body is rewritten (`import()` becomes a vite-node
    // helper that does not exist in the page) before Playwright serialises it.
    await page.evaluate(`import(${JSON.stringify(MOUNT_URL)}).then(() => true)`);

    const problems = [];
    let startedAt = 0;
    const t0 = Date.now();
    try {
      startedAt = await page.evaluate((wav) => window.__skinlabDemo.start(wav), DEMO_WAV);
      await waitFor(
        'the legacy never reported "demo: started" (the mpd-message listener did not receive the trigger)',
        watch,
        page.waitForFunction(() => window.__skinlabDemo.sawStart(), null, { timeout: TOUR_START_TIMEOUT_MS, polling: 50 }),
      );
      await waitFor(
        'the tour did not finish',
        watch,
        page.waitForFunction(() => window.__skinlabDemo.status().outcome !== null, null, { timeout: TOUR_TIMEOUT_MS, polling: 250 }),
      );
    } catch (e) {
      problems.push(String(e?.message ?? e));
    }

    const status = await page.evaluate(() => window.__skinlabDemo.status()).catch(() => null);
    if (status?.outcome === 'failed') problems.push(`the tour failed: ${status.failure}`);
    else if (status && status.outcome !== 'done' && !problems.length) problems.push('the tour did not report "demo: done"');
    const raw = await page.evaluate(() => window.__skinlabDemo.snapshot());
    const unhandled = await page.evaluate(() => window.__skinlab.calls.filter((c) => c.unhandled).map((c) => c.cmd)).catch(() => []);
    for (const cmd of new Set(unhandled)) problems.push(`the legacy invoked an unhandled command: ${cmd}`);
    for (const p of watch.problems) problems.push(p);
    return { raw: { ...raw, startedAt }, problems: [...new Set(problems)], wallMs: Date.now() - t0 };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---- the command ------------------------------------------------------------------------------------

export default async function main(argv) {
  const { media, out } = parseDemoOptions(argv);
  const { fixture } = await prepare();
  const outDir = out ?? runOutDir(runId('demo'));
  await mkdir(outDir, { recursive: true });

  console.log(`running the legacy tour in real time (about 45 s), media ${media}`);
  const { result, chromium } = await withLegacySession(async ({ baseUrl, browser, chromium }) => ({ result: await runTour(browser, baseUrl, media), chromium }));

  const log = buildLog(result.raw, {
    media,
    skinSha256: fixture.sha256,
    oraclePin: await oraclePin(),
    chromiumRevision: chromium.revision,
  });
  const problems = [...result.problems, ...checkSummary(log.summary)];
  log.problems = problems;
  const file = path.join(outDir, LOG_FILE);
  await writeFile(file, `${JSON.stringify(log, null, 2)}\n`);

  console.log(formatReport(log));
  console.log(`  wall time ${(result.wallMs / 1000).toFixed(1)} s`);
  console.log(`call log: ${file}`);
  if (problems.length) {
    throw fail(`the legacy tour did not meet its checks:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  const latest = referenceCopy(media);
  await mkdir(path.dirname(latest), { recursive: true });
  await copyFile(file, latest);
  console.log(`reference copy: ${latest}`);
  return EXIT.PASS;
}
