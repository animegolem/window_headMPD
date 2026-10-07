// Runs the Headspace demo tour on the engine, in pinned Chromium, for skinlab (E D10.7, W5.3). It is
// loaded INTO a booted engine.html by cmd-demo.mjs (`import('/tools/skinlab/demo-engine-mount.js')`), the
// way demo-legacy-mount.js is loaded into legacy.html, and exposes one call under window.__skinlabDemoEngine:
//
//   run(job)   {archive: base64, name, sidecar, config: 'compat'|'faithful', media: preset, wav, deadlineMs}
//              -> {raw: {events, others, startedAt}, problems, host, steps, wallMs}
//
// What runs is the app's own tour code: `runTour` of src/app/demo/driver.js over a `DemoTarget` built from
// the engine's inspector, with the Headspace choreography fed the sidecar's `tour` block. Only what is
// outside the app is stood in for, by the test host:
//
//   clock     the host's manual clock. The driver sleeps on it (`clockFromEngine`), so nothing moves until
//             this file advances it: `pump()` below does, 16 ms at a time with a real macrotask between
//             steps, which is what lets every promise the tour is waiting on settle. skinlab never installs
//             a fake page clock (E D9); performance.now (the realm budget's clock) stays real.
//   recorder  `record_start` / `record_stop` are events, not Tauri commands (so the driver never imports
//             @tauri-apps/api).
//   MPD       the host's FakeMedia. A command is recorded as the MediaModel call it is, with the player
//             state it found; cmd-demo.mjs turns that into the `mpd` verb player.js would send.
//   DSP       the fake port. Each stored change is a `set_eq` / `set_balance`.
//   shell     there is none, so the drawer state the shell persists (`eqOpen`, `plOpen`) comes from the
//             real `createRestore` of src/app/restore.js, checked after every step: the same module, the
//             same globals (the sidecar's `restore`), a 16 ms poll instead of a dispatch hook.
//
// Everything lands in one list with a manual-clock stamp; the log format and every judgement are
// cmd-demo.mjs's. This file records, and reports what went wrong while it ran (a thrown clock callback, a
// tour that never ended, a media call that bypassed the recorder, a host fault).

import { createEngine } from '../../src/engine/index.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../src/engine/options.js';
import { FRAME_MS } from '../../src/hosts/test/clock.js';
import { createTestHost } from '../../src/hosts/test/index.js';
import { mountPlaylist } from '../../src/app/widgets/playlist.js';
import { clockFromEngine, runTour } from '../../src/app/demo/driver.js';
import { createHeadspaceChoreography } from '../../src/app/demo/headspace.js';
import { createDemoTarget } from '../../src/app/demo/target.js';
import { createRestore } from '../../src/app/restore.js';

if (window.__skinlabDemoEngine) throw new Error('demo-engine-mount.js loaded twice');

/** E D9: both configurations run on `sliderGeometry: 'oracle'`; only the allow-list switches differ. */
const CONFIGS = new Map([
  ['compat', ORACLE_COMPAT],
  ['faithful', FAITHFUL],
]);

/**
 * What the legacy capture seeds (tauri-stub.js): `eq` zeros, `balance` 0, `preset` 1 (Chorus, which is what
 * the tour's stage wants, so it steps nothing). The same facts engine-mount.js seeds for the parity states.
 */
const SEED = Object.freeze({
  mediacenter: Object.freeze({ effectPreset: '1' }),
  app: Object.freeze({ eq: JSON.stringify(Array(10).fill(0)), balance: '0' }),
});

/** The playlist widget the app ships, as in the parity states, so the tour opens the real drawer. */
const PLAYLIST_FACTORY = (el, media, attrs, win) => mountPlaylist(el, media, attrs, win);

/** The MediaModel commands. These are exactly the methods FakeMedia records in its own `calls`. */
const MEDIA_COMMANDS = Object.freeze(['play', 'pause', 'stop', 'next', 'previous', 'seek', 'setVolume', 'setMode', 'playQueuePos', 'playPlaylist']);

/** One frame per step: a smaller one would be finer and cost thousands more macrotasks. */
const STEP_MS = FRAME_MS;
/** A tour that is still going after this much virtual time never ends: the tour is about 42 s long. */
const MAX_VIRTUAL_MS = 120_000;
const MAX_CLOCK_ERRORS = 5;

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// One MessageChannel, reused: a macrotask that is not a timer, so Chromium's 4 ms nesting clamp on
// setTimeout never slows a 2,600-step pump, and every microtask the last step released has run before it.
const channel = new MessageChannel();
let wake = null;
channel.port1.onmessage = () => {
  const resolve = wake;
  wake = null;
  resolve?.();
};
const macrotask = () => new Promise((resolve) => {
  wake = resolve;
  channel.port2.postMessage(0);
});

/** @param {{ archive: string, name?: string, sidecar?: any, config: string, media: string, wav: string, deadlineMs?: number }} job */
async function run(job) {
  const wall0 = performance.now();
  const config = CONFIGS.get(job.config);
  if (!config) throw new Error(`unknown config "${job.config}"`);
  if (!job.sidecar?.tour) throw new Error('the skin has no sidecar tour block');

  /** @type {{at: number, kind: string, [k: string]: any}[]} */
  const events = [];
  const others = new Map(); // name -> count; a Map because some names come from the engine
  const count = (name) => others.set(name, (others.get(name) ?? 0) + 1);
  const problems = [];

  const root = document.getElementById('skin');
  root.replaceChildren();
  const host = createTestHost({
    media: job.media,
    seed: SEED,
    dsp: { gains: Array(10).fill(0), balance: 0 },
    window: { root },
    slots: { playlist: PLAYLIST_FACTORY },
  });
  const now = () => host.clock.now();
  const call = (cmd, args) => events.push({ at: now(), kind: 'call', cmd, args: plain(args) });

  // ---- recorders, in place before the engine is built: it keeps the host's objects, not copies of them

  const win = host.window;
  const setCapture = win.setCapture;
  win.setCapture = (on) => {
    call('set_capture', { on: !!on });
    return setCapture(on);
  };
  const setShape = win.setShape;
  win.setShape = (shape) => {
    count('set_shape'); // the engine sends one per change; the legacy's two are not comparable and not compared
    return setShape(shape);
  };

  const media = host.media;
  for (const method of MEDIA_COMMANDS) {
    const original = media[method];
    if (typeof original !== 'function') throw new Error(`the test host's media has no ${method}()`);
    media[method] = (...args) => {
      events.push({ at: now(), kind: 'media', method, args: plain(args), before: media.snapshot().playState });
      return original(...args);
    };
  }

  const prefsWrite = host.prefs.write;
  host.prefs.write = (ns, key, value) => {
    // The effects slot persists the preset under the engine's own name for it (D6.1); the legacy called it `preset`.
    if (ns === 'mediacenter' && key === 'effectPreset') events.push({ at: now(), kind: 'pref', key: 'preset', value: String(value) });
    else count('pref_write');
    return prefsWrite(ns, key, value);
  };

  // `sent` holds every vector that reached the audio path, which is exactly what `set_eq` would carry.
  const sent = host.dsp.sent;
  let seenEq = sent.eq.length;
  host.dsp.eq.onChange(() => {
    while (seenEq < sent.eq.length) call('set_eq', { gains: sent.eq[seenEq++] });
  });
  let seenBalance = sent.balance.length;
  host.dsp.balance.onChange(() => {
    while (seenBalance < sent.balance.length) call('set_balance', { balance: sent.balance[seenBalance++] });
  });

  // ---- load, attach, settle: the same sequence as engine-mount.js and the app

  const engine = createEngine(host, config);
  const loaded = await engine.load(fromBase64(job.archive), { name: job.name, sidecar: job.sidecar });
  const runtime = await loaded.attach();
  host.clock.advance(500);
  await runtime.settled();

  const effects = host.slots.mounted.find((m) => m.kind === 'effects' && !m.disposed)?.handle.effects;
  if (!effects) throw new Error('the skin mounted no effects slot: the tour has no visualization to step');

  const restore = createRestore({
    entries: job.sidecar.restore,
    prefs: {
      load: async () => new Map(),
      write: (_ns, key, value) => { events.push({ at: now(), kind: 'pref', key, value: String(value) }); },
    },
    log: host.log,
  });
  restore.bind(runtime.inspector);

  const target = createDemoTarget({ inspector: runtime.inspector, media, effects, zoom: () => host.window.zoom });
  const choreography = createHeadspaceChoreography(job.sidecar.tour);

  // ---- the tour, and the pump that gives it time

  let outcome = null; // null while running, then 'done' or 'failed'
  let failure = null;
  const tour = runTour(target, choreography, job.wav, {
    clock: clockFromEngine(host.clock),
    document,
    record: {
      start: async () => { call('record_start', {}); },
      stop: async (path) => { call('record_stop', { path }); },
    },
    log: (message) => call('js_log', { msg: message }),
  }).then(
    () => { outcome = 'done'; },
    (e) => {
      outcome = 'failed';
      failure = String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ');
    },
  );

  const startedAt = now();
  const budgetMs = job.deadlineMs ?? 120_000;
  const clockErrors = new Set();
  let steps = 0;
  while (outcome === null) {
    if (now() - startedAt > MAX_VIRTUAL_MS) {
      problems.push(`the tour did not end within ${MAX_VIRTUAL_MS / 1000} s of clock time`);
      break;
    }
    if (performance.now() - wall0 > budgetMs) {
      problems.push(`the tour did not end within ${budgetMs / 1000} s of wall time`);
      break;
    }
    try {
      host.clock.advance(STEP_MS); // never from inside a callback: it is not re-entrant
    } catch (e) {
      // The clock finishes the advance and rethrows the first error; the tour goes on, the engine fault is reported.
      clockErrors.add(String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
      if (clockErrors.size >= MAX_CLOCK_ERRORS) {
        problems.push('five different clock callbacks threw; stopping');
        break;
      }
    }
    steps++;
    await macrotask(); // the continuation of whatever the step woke runs here
    restore.check();
  }
  for (const e of clockErrors) problems.push(`a clock callback threw: ${e}`);
  if (outcome === null) {
    // Give the aborted tour a last chance to wind down so its `restore` and the cursor removal run.
    for (let i = 0; i < 4 && outcome === null; i++) {
      host.clock.advance(STEP_MS);
      await macrotask();
    }
  }
  await Promise.race([tour, macrotask()]);
  restore.check();
  if (outcome === 'failed') problems.push(`the tour failed: ${failure}`);
  else if (outcome === null) problems.push('the tour did not report "demo: done"');

  // ---- what the host saw

  if (media.calls.length !== events.filter((e) => e.kind === 'media').length) {
    problems.push(`${media.calls.length} media commands reached the host but ${events.filter((e) => e.kind === 'media').length} passed the recorder: a command bypassed it`);
  }
  for (const fault of host.recorded.faults) problems.push(`the engine reported a fault: ${fault}`);
  if (runtime.health?.unloaded) problems.push('the skin unloaded (hard faults) during the tour');

  return {
    raw: { events, others: [...others], startedAt },
    problems: [...new Set(problems)],
    host: {
      faults: host.recorded.faults.length,
      health: plain(runtime.health), // HostedView.health: realm faults, soft and hard, and whether the skin unloaded
      denied: host.recorded.denied.map((d) => `${d.api}: ${d.detail}`),
      diagnostics: host.recorded.diagnostics.slice(0, 20).map((d) => plain(d)),
      diagnosticCount: host.recorded.diagnostics.length,
      warnings: host.recorded.logs.filter((l) => l.level === 'warn').map((l) => l.message),
      shapes: host.recorded.window.shapes.length,
      captures: host.recorded.window.captures.length,
    },
    steps,
    wallMs: Math.round(performance.now() - wall0),
  };
}

window.__skinlabDemoEngine = { run };
