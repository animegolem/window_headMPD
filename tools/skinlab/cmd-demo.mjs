// demo --target legacy [--media stoppedEmpty] [--out <dir>]
// demo --target engine [--media stoppedEmpty] [--config faithful|compat] [--compare [--reference <file>]] [--out <dir>]
//
// legacy: runs the pinned legacy tour (src/demo.js, `runDemo`) headless under the skinlab Tauri stub, the
// way Rust starts it: a `mpd-message` event carrying "demo <wav>". Records what the tour does to the
// outside world, as the reference the engine's tour is compared against:
//
//   - the `mpd`, `set_eq`, `set_balance`, `set_capture`, `set_hit_mask` (shape only), `record_start`,
//     `record_stop` and `js_log` calls, each with a timestamp in seconds from `record_start`, which is
//     the tour's own t = 0 (the sync flash; negative times are the stage setup before it);
//   - the `localStorage` writes that carry what no call does: `eqOpen`, `plOpen`, `preset`, `eq`;
//   - a summary derived from those: when the EQ drawer opened, the band values after each drag, the
//     number of preset steps, the ordered `mpd` verbs.
//
// engine (W5.3, E D10.7): runs the app's own tour (src/app/demo: driver, Headspace choreography,
// DemoTarget) on the engine in the same pinned Chromium, over the test host's manual clock, and writes a
// log in the same format (`target: "engine"`). demo-engine-mount.js records; this file translates the
// recorded MediaModel calls into the `mpd` verbs player.js sends for them, builds the log and, with
// --compare, diffs it against the legacy reference (compareLogs says exactly what is and is not compared).
// Virtual time: the 42 s tour takes a few seconds of wall clock.
//
// The legacy runs in real time, like the legacy capture: the tour is about 41 s of setTimeout and
// performance.now, and this command never installs a fake page clock (E D9). Exit 0 pass, 1 the tour or
// the log failed a check (the log is still written), 2 usage or wrong fixture, 77 fixture or Chromium absent.
//
// The log is plain data about calls, no art: it goes to the run's output directory
// (~/Library/Caches/window_headmpd/skinlab/out/<run>/demo-legacy.json or demo-engine.json) and, for the
// legacy on a pass, is copied to ~/Library/Caches/window_headmpd/skinlab/demo/legacy-<media>.json so a
// later --compare finds it.
//
// The stub's `mpd status` is canned and never changes, so `player.state` stays what the media preset
// says and the verbs the tour sends depend on it. The preset is part of the reference; it is written
// into the log header, and stoppedEmpty is the default because it is the S1 baseline.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FRAME_MS } from '../../src/hosts/test/clock.js';
import { CONFIGS } from './allowlist.mjs';
import { watchPage, withLegacySession } from './capture.mjs';
import { BOOT_QUIET_MS, VIEWPORT } from './states.mjs';
import { parseOptions, runId } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { hasMediaPreset, MEDIA_PRESET_NAMES } from './media-presets.js';
import { REPO_ROOT, checkFixture, runOutDir, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';

export const LOG_FORMAT = 'skinlab-demo-log/1';
export const LOG_FILE = 'demo-legacy.json';
export const ENGINE_LOG_FILE = 'demo-engine.json';
export const DEFAULT_MEDIA = 'stoppedEmpty';

/** Where a passing run leaves its log for W5.3's --compare: one per media preset, since the verbs differ. */
export const referenceCopy = (media, root = storeRoot()) => path.join(root, 'demo', `legacy-${media}.json`);

/** The default of main.js:551, so a run is what `mpc sendmessage window_head demo` would start. */
export const DEMO_WAV = '/tmp/window_headmpd-demo.wav';

/** Served by the skinlab vite server from the repo root; see demo-legacy-mount.js. */
export const MOUNT_URL = '/tools/skinlab/demo-legacy-mount.js';
/** The engine's tour recorder, loaded into a booted engine.html; see demo-engine-mount.js. */
export const ENGINE_MOUNT_URL = '/tools/skinlab/demo-engine-mount.js';

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
export function buildLog(raw, { media, wav = DEMO_WAV, target = 'legacy', dragsOnly = target !== 'legacy', ...header } = {}) {
  const events = raw.events; // appended in order by the page's one clock: performance.now() (legacy) or the test host's manual clock (engine)
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
    summary: summarize(calls, prefs, { dragsOnly }),
  };
}

/**
 * Facts about the tour, derived from the log's calls and prefs.
 * A drag is bracketed by `set_capture` on and off, which only the sliders call; its band is the one
 * value that changed between the two, and its values are the last `set_eq` inside the bracket (the
 * reset click and the teardown send zeros later, so the last `set_eq` overall is not "after the drags").
 *
 * `dragsOnly` is for the engine, which takes the capture on every control press (the legacy only does for a
 * slider): a bracket then counts as a drag only when exactly one band moved inside it, so the play click and
 * the reset (which moves five bands) are not drags.
 * @param {{dragsOnly?: boolean}} [opts]
 */
export function summarize(calls, prefs, { dragsOnly = false } = {}) {
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
        if (!dragsOnly || band !== null) {
          drags.push({ startT: open.startT, endT: c.t, band, to: band === null ? null : eq[band], inputs, eq: [...eq] });
        }
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

/**
 * The acceptance checks of W4.4 as a list of problems; empty means the log is the reference. The same
 * numbers are asked of the engine's tour (W5.3); `persisted` is a legacy-only cross-check, because the
 * test host's fake DSP persists nothing (the real adapter's job, src/hosts/tauri/dsp.js).
 * @param {object} summary
 * @param {{wav?: string, target?: 'legacy' | 'engine'}} [opts]
 */
export function checkSummary(summary, { wav = DEMO_WAV, target = 'legacy' } = {}) {
  const problems = [];
  const who = `the ${target}`;
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
  if (target === 'legacy') {
    summary.drags.forEach((d, i) => {
      if (!sameVector(d.persisted, d.eq)) problems.push(`drag ${i + 1}: the legacy persisted ${JSON.stringify(d.persisted)} but its last set_eq was ${JSON.stringify(d.eq)}`);
    });
  }
  if (summary.presetSteps !== EXPECT.presetSteps) problems.push(`${summary.presetSteps} preset steps, expected ${EXPECT.presetSteps}`);
  for (const msg of summary.jsLogErrors) problems.push(`${who} reported: ${msg}`);
  return problems;
}

/**
 * `checkSummary` for an engine log, plus the one thing only its calls can say. The legacy's sliders hand
 * out whole dB (widgets.js:272); parity D31 keeps slider values continuous inside the control and
 * quantises in the host binding. A fractional gain reaching the DSP port means that binding is missing,
 * and every drag value and `set_eq` step below it differs because of that, so it is named on its own.
 * @param {{summary: object, calls: {t: number, cmd: string, args?: any}[]}} log
 * @returns {string[]}
 */
export function checkEngineLog(log) {
  const problems = checkSummary(log.summary, { target: 'engine' });
  const sent = log.calls.filter((c) => c.cmd === 'set_eq' && Array.isArray(c.args?.gains));
  const fractional = sent.filter((c) => c.args.gains.some((g) => !Number.isInteger(g)));
  if (fractional.length) {
    const first = fractional[0];
    problems.push(
      `the engine sent ${fractional.length} of ${sent.length} set_eq calls with fractional gains (first at t = ${first.t} s: ${JSON.stringify(first.args.gains.filter((v) => !Number.isInteger(v)).slice(0, 3))}), ` +
        'where the legacy sends whole dB: parity D31 quantises gains in the host binding and nothing here does',
    );
  }
  return problems;
}

export function formatReport(log) {
  const s = log.summary;
  const at = (t) => (t === null ? 'never' : `${t.toFixed(3)} s`);
  const lines = [
    `${log.target} demo tour, media ${log.media}, t = 0 at ${log.timeBase}`,
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

/**
 * The legacy capture's options, validated before anything is prepared or launched, so a typo costs
 * nothing. The engine's tour has its own set (`parseEngineDemoOptions`): `main` picks by `--target`.
 */
export function parseDemoOptions(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    media: { type: 'string' },
    out: { type: 'string' },
  });
  if (values.target === undefined) throw usageError('--target legacy or --target engine is required');
  if (values.target === 'engine') throw usageError('--target engine has its own options (parseEngineDemoOptions)');
  if (values.target !== 'legacy') throw usageError(`unknown --target "${values.target}" (known: legacy, engine)`);
  const media = values.media ?? DEFAULT_MEDIA;
  if (!hasMediaPreset(media)) throw usageError(`unknown media preset "${media}" (known: ${MEDIA_PRESET_NAMES.join(', ')})`);
  return { target: 'legacy', media, out: values.out ? path.resolve(values.out) : null };
}

/**
 * `--target engine`: the media preset (the reference is per preset), the engine configuration (the shipped
 * `faithful` unless asked), and `--compare` with an optional `--reference` log instead of the stored one.
 * @param {string[]} argv
 */
export function parseEngineDemoOptions(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    media: { type: 'string' },
    out: { type: 'string' },
    config: { type: 'string' },
    compare: { type: 'boolean', default: false },
    reference: { type: 'string' },
  });
  if (values.target !== 'engine') throw usageError('the engine options need --target engine');
  const media = values.media ?? DEFAULT_MEDIA;
  if (!hasMediaPreset(media)) throw usageError(`unknown media preset "${media}" (known: ${MEDIA_PRESET_NAMES.join(', ')})`);
  const config = values.config ?? 'faithful';
  if (!CONFIGS.includes(config)) throw usageError(`unknown --config "${config}" (known: ${CONFIGS.join(', ')})`);
  if (values.reference !== undefined && !values.compare) throw usageError('--reference needs --compare');
  return {
    target: 'engine',
    media,
    config,
    compare: values.compare === true,
    reference: values.reference ? path.resolve(values.reference) : null,
    out: values.out ? path.resolve(values.out) : null,
  };
}

/** The `--target` value, or undefined: only enough parsing to choose a parser. Never throws. */
export function peekTarget(argv) {
  try {
    return parseArgs({ args: argv, options: { target: { type: 'string' } }, strict: false, allowPositionals: true }).values.target;
  } catch {
    return undefined;
  }
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

// ---- the engine's tour: translating what the test host saw ------------------------------------------------

/**
 * The `mpd` verbs player.js sends for a MediaModel command (the legacy tour's own traffic is the same
 * verbs, sent raw). The test host has no MPD, so demo-engine-mount.js records the command and the player
 * state it found, and this says what it would have been on the wire. `null`: a command with no
 * translation, which the caller reports instead of dropping. A switch, not a table: `method` comes from
 * the page.
 * @param {string} method @param {unknown[]} args @param {string} [before] the play state when it was called
 * @returns {string[][] | null} zero or more verbs, each an argv
 */
export function mpdArgvOf(method, args, before) {
  const a = args[0];
  const b = args[1];
  switch (method) {
    case 'play': return [before === 'pause' ? ['pause', '0'] : ['play']]; // player.js:108
    case 'pause': return [['pause', '1']]; // player.js:110
    case 'stop': return [['stop']];
    case 'next': return [['next']];
    case 'previous': return [['previous']];
    case 'seek': return typeof a === 'number' && Number.isFinite(a) ? [['seekcur', a.toFixed(2)]] : []; // player.js:115
    case 'setVolume': return typeof a === 'number' && Number.isFinite(a) ? [['setvol', String(Math.round(a))]] : [];
    case 'setMode': return a === 'loop' || a === 'shuffle' ? [[a === 'loop' ? 'repeat' : 'random', b ? '1' : '0']] : [];
    case 'playQueuePos': return [['play', String(a)]];
    case 'playPlaylist': return [['clear'], ['load', String(a)], ['play', String(b)]]; // player.js:121-123
    default: return null;
  }
}

/**
 * What demo-engine-mount.js recorded, with each `media` event turned into the `mpd` calls of the legacy
 * log's shape, in place and in order. Everything else passes through.
 * @param {{events: {at:number, kind:string, [k:string]: any}[], others?: [string, number][], startedAt?: number}} raw
 * @returns {{raw: typeof raw, problems: string[]}}
 */
export function engineRaw(raw) {
  const problems = [];
  const events = [];
  for (const e of raw.events) {
    if (e.kind !== 'media') {
      events.push(e);
      continue;
    }
    const verbs = mpdArgvOf(String(e.method), Array.isArray(e.args) ? e.args : [], e.before);
    if (verbs === null) problems.push(`the test host's media command ${JSON.stringify(e.method)} has no mpd translation`);
    else for (const args of verbs) events.push({ at: e.at, kind: 'call', cmd: 'mpd', args: { args } });
  }
  return { raw: { ...raw, events }, problems };
}

// ---- the comparison -----------------------------------------------------------------------------------

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
/** Equal strings, or two plain numbers of equal value: the engine's `seekcur 0.00` is the legacy tour's raw `seekcur 0`. */
const sameArg = (a, b) => a === b || (NUMERIC.test(a) && NUMERIC.test(b) && Number(a) === Number(b));
const sameArgv = (a, b) => a.length === b.length && a.every((x, i) => sameArg(x, b[i]));
const ZEROS = Object.freeze(Array(10).fill(0));

/**
 * The `set_eq` vectors a log sent, reduced to the distinct steps the audio path went through:
 *   - calls at the same instant are one step, the last vector winning. The engine's reset has no "set all":
 *     the skin writes the ten sliders one by one inside one handler (so the fake DSP, like the real adapter,
 *     sends one vector per band that moved), where the legacy sent one `[0,...]` for it;
 *   - a vector equal to the one before it is no step. The legacy re-sends the current vector when a drag
 *     starts and at teardown, and the engine's DSP port stays silent for a write that changes nothing.
 * `baseline` is what the DSP held before the tour: the seeded zeros on both sides.
 * @param {{t: number, cmd: string, args?: any}[]} calls
 * @returns {{t: number, gains: number[]}[]}
 */
export function eqSteps(calls, baseline = ZEROS) {
  const bursts = [];
  for (const c of calls) {
    if (c.cmd !== 'set_eq' || !Array.isArray(c.args?.gains)) continue;
    const last = bursts.at(-1);
    if (last && last.t === c.t) last.gains = c.args.gains;
    else bursts.push({ t: c.t, gains: c.args.gains });
  }
  const steps = [];
  let prev = baseline;
  for (const b of bursts) {
    if (sameVector(b.gains, prev)) continue;
    steps.push({ t: b.t, gains: [...b.gains] });
    prev = b.gains;
  }
  return steps;
}

/** `index N: legacy X, engine Y` for the first place two sequences differ, or null when they do not. */
function firstDifference(legacy, engine, same, show) {
  const n = Math.max(legacy.length, engine.length);
  for (let i = 0; i < n; i++) {
    if (i >= legacy.length) return `at index ${i} the engine has an extra ${show(engine[i])} (the legacy ended after ${legacy.length})`;
    if (i >= engine.length) return `at index ${i} the engine stopped (${engine.length}); the legacy went on with ${show(legacy[i])}`;
    if (!same(legacy[i], engine[i])) return `at index ${i} the legacy has ${show(legacy[i])}, the engine ${show(engine[i])}`;
  }
  return null;
}

const justT = (t) => (t === null || t === undefined ? 'never' : `${t.toFixed(3)} s`);
const signed = (x) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(3)} s`;

/**
 * Compare the engine's tour log with the legacy reference (W5.3). Compared, and a difference is a
 * problem: the ordered `mpd` verbs and arguments; the distinct `set_eq` steps (`eqSteps`); the five drags
 * (band and value); the band values after them; the preset steps; the recorder's start and stop path;
 * that the EQ drawer opened before the first drag. NOT compared: timestamps. The two runs keep the same
 * schedule (`until(...)`), the legacy on real time with its own jitter and the engine on a manual clock
 * that moves in 16 ms frames, so each time is within a frame or two of the other's; the differences are
 * returned in `info` for a reader and never fail. Both summaries are recomputed from the calls, not read
 * from the files.
 * @param {object} legacy a log written by `--target legacy`
 * @param {object} engine a log written by `--target engine`
 * @returns {{problems: string[], info: string[]}}
 */
export function compareLogs(legacy, engine) {
  const problems = [];
  const info = [];
  if (legacy?.format !== LOG_FORMAT || legacy.target !== 'legacy' || !Array.isArray(legacy.calls) || !Array.isArray(legacy.prefs)) {
    return { problems: [`the reference is not a ${LOG_FORMAT} log written by --target legacy`], info };
  }
  const ls = summarize(legacy.calls, legacy.prefs);
  const es = summarize(engine.calls, engine.prefs, { dragsOnly: true });

  if (legacy.media !== engine.media) problems.push(`the reference was captured on media ${legacy.media} and the engine ran on ${engine.media}`);
  if (legacy.skinSha256 && engine.skinSha256 && legacy.skinSha256 !== engine.skinSha256) problems.push('the reference and the engine run used different skin archives');

  // the transport: ordered verbs and arguments
  const lv = ls.mpd.map((m) => m.argv);
  const ev = es.mpd.map((m) => m.argv);
  const verbDiff = firstDifference(lv, ev, sameArgv, (argv) => JSON.stringify(argv.join(' ')));
  if (verbDiff) problems.push(`mpd verbs differ: ${verbDiff}; legacy [${lv.map((a) => a.join(' ')).join(', ')}], engine [${ev.map((a) => a.join(' ')).join(', ')}]`);

  // the equalizer: distinct steps
  const lsteps = eqSteps(legacy.calls);
  const esteps = eqSteps(engine.calls);
  const stepDiff = firstDifference(lsteps, esteps, (a, b) => sameVector(a.gains, b.gains), (x) => JSON.stringify(x.gains));
  if (stepDiff) problems.push(`set_eq steps differ: ${stepDiff} (legacy ${lsteps.length} steps, engine ${esteps.length})`);
  const sends = (log) => log.calls.filter((c) => c.cmd === 'set_eq').length;
  info.push(`set_eq: legacy sent ${sends(legacy)} (${lsteps.length} distinct steps), engine sent ${sends(engine)} (${esteps.length} distinct steps)`);

  const drag = (d) => [d.band, d.to];
  const dragDiff = firstDifference(ls.drags.map(drag), es.drags.map(drag), sameVector, (d) => `band ${d[0]} -> ${d[1]}`);
  if (dragDiff) problems.push(`the slider drags differ: ${dragDiff}`);
  if (!sameVector(ls.bandsAfterDrags, es.bandsAfterDrags)) {
    problems.push(`band values after the drags: legacy ${JSON.stringify(ls.bandsAfterDrags)}, engine ${JSON.stringify(es.bandsAfterDrags)}`);
  }

  if (ls.presetSteps !== es.presetSteps || !sameVector(ls.presetValues.map(String), es.presetValues.map(String))) {
    problems.push(`preset steps: legacy ${ls.presetSteps} (${ls.presetValues.join(' -> ')}), engine ${es.presetSteps} (${es.presetValues.join(' -> ')})`);
  }

  // the drawers and the recorder
  const firstDrag = es.drags[0]?.startT ?? null;
  if (es.eqOpenAt === null) problems.push('the engine never opened the EQ drawer');
  else if (firstDrag !== null && es.eqOpenAt >= firstDrag) problems.push(`the engine opened the EQ drawer at ${justT(es.eqOpenAt)}, not before its first drag at ${justT(firstDrag)}`);
  else if (es.eqOpenAt > EXPECT.eqOpenBeforeS) problems.push(`the engine opened the EQ drawer at ${justT(es.eqOpenAt)}, after ${EXPECT.eqOpenBeforeS} s`);
  if ((ls.plOpenAt === null) !== (es.plOpenAt === null)) problems.push(`the playlist drawer opened in one run only: legacy ${justT(ls.plOpenAt)}, engine ${justT(es.plOpenAt)}`);
  if (es.recordStartT === null || es.recordStopT === null) problems.push('the engine tour did not both start and stop the recorder');
  else if (ls.recordStopPath !== es.recordStopPath) problems.push(`record_stop wrote to ${JSON.stringify(es.recordStopPath)} on the engine and ${JSON.stringify(ls.recordStopPath)} on the legacy`);

  // information only: where in time each thing happened (the engine's time minus the legacy's)
  const deltas = [];
  const note = (what, l, e) => {
    if (typeof l === 'number' && typeof e === 'number') deltas.push({ what, d: e - l });
  };
  ls.mpd.forEach((m, i) => note(`mpd ${m.argv.join(' ')}`, m.t, es.mpd[i]?.t));
  note('EQ drawer open', ls.eqOpenAt, es.eqOpenAt);
  note('PL drawer open', ls.plOpenAt, es.plOpenAt);
  ls.drags.forEach((d, i) => note(`drag ${i + 1} start`, d.startT, es.drags[i]?.startT));
  ls.presetValues.forEach((_, i) => {
    const l = legacy.prefs.filter((p) => p.key === 'preset' && p.t >= 0)[i];
    const e = engine.prefs.filter((p) => p.key === 'preset' && p.t >= 0)[i];
    note(`preset step ${i + 1}`, l?.t, e?.t);
  });
  note('record_stop', ls.recordStopT, es.recordStopT);
  if (deltas.length) {
    const worst = deltas.reduce((m, x) => (Math.abs(x.d) > Math.abs(m.d) ? x : m));
    const inFrame = deltas.filter((x) => Math.abs(x.d) * 1000 <= FRAME_MS).length;
    info.push(`timing, not compared (engine minus legacy): ${deltas.length} events, ${inFrame} within one frame (${FRAME_MS} ms), largest ${signed(worst.d)} at ${worst.what}`);
  }
  return { problems, info };
}

// ---- the engine's tour: driving the page -------------------------------------------------------------------

/** The sidecar is our own data keyed by the archive's SHA-256; the tour block is where the choreography's refs come from. */
async function readTourSidecar(sha256) {
  const file = path.join(REPO_ROOT, 'src', 'app', 'sidecars', `${sha256}.json`);
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') throw fail(`no sidecar for this skin (${file}): the tour takes its element refs from the sidecar's "tour" block`);
    throw fail(`sidecar ${file} could not be read: ${firstLine(e)}`);
  }
  if (!sidecar?.tour) throw fail(`the sidecar ${file} has no "tour" block`);
  return sidecar;
}

/** The legacy reference this run is compared against: the stored one for the media preset, or `--reference`. */
async function readReference(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw fail(`no legacy reference at ${file}: capture it first (npm run skinlab -- demo --target legacy), or name one with --reference`);
    }
    throw fail(`the legacy reference ${file} could not be read: ${firstLine(e)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw fail(`the legacy reference ${file} is not valid JSON: ${firstLine(e)}`);
  }
}

/**
 * One engine tour in a fresh context. Like the legacy's, tour failures come back as `problems`; only a
 * browser that cannot start or a page that never boots throws. `deviceScaleFactor` 1: the tour acts on
 * client points, so the call log does not depend on the DPR.
 */
async function runEngineTour(browser, baseUrl, job) {
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
    await page.goto(`${baseUrl}/tools/skinlab/engine.html`, { waitUntil: 'load' });
    await waitFor('the engine page did not boot', watch, page.waitForFunction(() => window.__skinlabEngine?.booted === true, null, { timeout: 30_000, polling: 50 }));
    // A string, for the reason runTour gives.
    await waitFor('the engine tour recorder did not load', watch, page.evaluate(`import(${JSON.stringify(ENGINE_MOUNT_URL)}).then(() => true)`));

    const problems = [];
    let result = null;
    try {
      result = await page.evaluate((j) => window.__skinlabDemoEngine.run(j), job);
    } catch (e) {
      problems.push(`the engine tour could not run: ${firstLine(e)}`);
    }
    for (const p of watch.problems) problems.push(p);
    return { result, problems: [...new Set(problems)] };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---- the command ------------------------------------------------------------------------------------

async function legacyMain({ media, out }) {
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

/** The flags that only mean something for `--target engine`; the legacy capture refuses them by name. */
const ENGINE_ONLY_FLAGS = /^--(compare|config|reference)(=|$)/;

async function engineMain({ media, config, compare, reference, out }) {
  const fixture = await checkFixture();
  if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
  if (fixture.status === 'badsha') throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}`);
  const sidecar = await readTourSidecar(fixture.sha256);
  // Before a browser starts: a missing reference should cost nothing.
  const referenceFile = reference ?? referenceCopy(media);
  const legacy = compare ? await readReference(referenceFile) : null;

  const outDir = out ?? runOutDir(runId('demo'));
  await mkdir(outDir, { recursive: true });
  const archive = Buffer.from(await readFile(fixture.path)).toString('base64');
  const job = { archive, name: path.basename(fixture.path), sidecar, config, media, wav: DEMO_WAV, deadlineMs: 120_000 };

  console.log(`running the engine tour on the test host's clock (virtual time), media ${media}, config ${config}`);
  const { run, chromium } = await withLegacySession(async ({ baseUrl, browser, chromium }) => ({ run: await runEngineTour(browser, baseUrl, job), chromium }));

  const problems = [...run.problems];
  let log = null;
  if (run.result) {
    problems.push(...run.result.problems);
    const converted = engineRaw(run.result.raw);
    problems.push(...converted.problems);
    log = buildLog(converted.raw, {
      media,
      target: 'engine',
      skinSha256: fixture.sha256,
      chromiumRevision: chromium.revision,
      engine: { config, steps: run.result.steps, wallMs: run.result.wallMs, host: run.result.host },
    });
    problems.push(...checkEngineLog(log));
  }

  let comparison = null;
  if (log && legacy) {
    comparison = compareLogs(legacy, log);
    problems.push(...comparison.problems);
  }

  if (log) {
    log.problems = problems;
    if (comparison) log.comparison = { reference: referenceFile, problems: comparison.problems, info: comparison.info };
    const file = path.join(outDir, ENGINE_LOG_FILE);
    await writeFile(file, `${JSON.stringify(log, null, 2)}\n`);
    console.log(formatReport(log));
    const host = log.engine.host;
    console.log(`  clock steps ${log.engine.steps}, wall time ${(log.engine.wallMs / 1000).toFixed(1)} s; host: ${host.faults} faults, realm soft ${host.health.soft} / hard ${host.health.hard}, ${host.denied.length} denied, ${host.diagnosticCount} diagnostics, ${host.captures} capture calls, ${host.shapes} shapes`);
    for (const d of host.diagnostics) console.log(`  host diagnostic: ${JSON.stringify(d)}`);
    for (const w of host.warnings) console.log(`  host warning: ${w}`);
    for (const d of host.denied) console.log(`  host denied: ${d}`);
    console.log(`call log: ${file}`);
  }
  if (comparison) {
    console.log(`compared with ${referenceFile}:`);
    for (const line of comparison.info) console.log(`  ${line}`);
    console.log(comparison.problems.length ? `  ${comparison.problems.length} difference(s)` : '  same mpd verbs and arguments, same set_eq steps, same drags and band values, same preset steps');
  }
  if (problems.length) {
    throw fail(`the engine tour did not meet its checks:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return EXIT.PASS;
}

export default async function main(argv) {
  if (peekTarget(argv) === 'engine') return engineMain(parseEngineDemoOptions(argv));
  const flag = argv.find((a) => ENGINE_ONLY_FLAGS.test(a));
  if (flag) throw usageError(`${flag.split('=')[0]} applies to --target engine only`);
  return legacyMain(parseDemoOptions(argv));
}
