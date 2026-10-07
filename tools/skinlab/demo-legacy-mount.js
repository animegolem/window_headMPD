// Recorder for the pinned legacy tour (src/demo.js), loaded INTO the booted legacy page by cmd-demo.mjs
// (`import('/tools/skinlab/demo-legacy-mount.js')` after legacy.html has booted). It adds nothing the
// tour can see: no pinned file is edited, the page is the one the goldens are captured from, and the
// tour is started the way Rust starts it, by a `mpd-message` event carrying "demo <wav>" (main.js:547).
//
// Three things are wrapped, because the stub (tauri-stub.js, not ours) neither timestamps nor knows them:
//   - window.__TAURI_INTERNALS__.invoke: tauri's `invoke` reads that property on every call, so
//     patching it after boot works. Every command the tour can cause is stamped with performance.now().
//     `record_start` and `record_stop` are answered here with null: the stub rejects commands it does
//     not know, and demo.js awaits `record_start` with no catch, so the tour would die at t = 0.
//   - Storage.prototype.setItem (never `localStorage.setItem = ...`, which would store a string under the
//     key "setItem"): toggleEq/togglePl and the visualization chooser invoke nothing, they only persist
//     `eqOpen`, `plOpen` and `preset`; `eq` is written at the end of each slider drag.
//   - js_log: the tour reports `demo: started`, `demo: done`; main.js reports `demo failed: ...`.
//
// Everything lands in one list under window.__skinlabDemo; cmd-demo.mjs turns it into the call log.

/** Commands worth keeping. Everything else is only counted, by name, in `others`. */
const LOGGED = new Set(['mpd', 'set_eq', 'set_balance', 'set_capture', 'set_hit_mask', 'record_start', 'record_stop', 'js_log']);

const internals = window.__TAURI_INTERNALS__;
const stub = window.__skinlab;
if (!internals || !stub) throw new Error('demo-legacy-mount.js must load into a booted legacy.html (tauri-stub.js missing)');
if (window.__skinlabDemo) throw new Error('demo-legacy-mount.js loaded twice');

/** @type {{at: number, kind: 'call'|'pref', [k: string]: any}[]} */
const events = [];
const others = new Map(); // command name -> count; a Map because the names are not ours
let started = false;
let outcome = null; // null while running, then 'done' or 'failed'
let failure = null;

const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function noteJsLog(msg) {
  if (outcome) return;
  if (msg === 'demo: done') outcome = 'done';
  else if (/^demo failed:/.test(msg) || /^demo: record failed/.test(msg)) {
    outcome = 'failed';
    failure = msg;
  }
}

const original = internals.invoke;
internals.invoke = function invokeRecorded(cmd, args, options) {
  const at = performance.now();
  if (!started) return original.call(this, cmd, args, options); // boot traffic is not the tour's
  if (LOGGED.has(cmd)) {
    // set_hit_mask carries the whole bit array; its shape is all anyone needs here.
    const kept = cmd === 'set_hit_mask' ? { width: args?.width, height: args?.height, zoom: args?.zoom } : plain(args);
    events.push({ at, kind: 'call', cmd, args: kept });
    if (cmd === 'js_log') noteJsLog(String(args?.msg));
  } else {
    others.set(cmd, (others.get(cmd) ?? 0) + 1);
  }
  if (cmd === 'record_start' || cmd === 'record_stop') return Promise.resolve(null);
  return original.call(this, cmd, args, options);
};

const setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function setItemRecorded(key, value) {
  if (started && this === window.localStorage) events.push({ at: performance.now(), kind: 'pref', key: String(key), value: String(value) });
  return setItem.call(this, key, value);
};

window.addEventListener('error', (e) => {
  if (!outcome) {
    outcome = 'failed';
    failure = `page error: ${e.message}`;
  }
});

window.__skinlabDemo = {
  /** Fire the trigger. The listener main.js registered with `listen('mpd-message')` does the rest. */
  start(wavPath) {
    if (started) throw new Error('the tour was already started');
    started = true;
    stub.emit('mpd-message', `demo ${wavPath}`);
    return performance.now();
  },
  /** The tour's own js_log lines are in `events`; this is only the verdict. */
  status() {
    return { started, outcome, failure, now: performance.now() };
  },
  /** True once main.js's `demo: started` line has been seen (the listener round-trip worked). */
  sawStart() {
    return events.some((e) => e.kind === 'call' && e.cmd === 'js_log' && e.args?.msg === 'demo: started');
  },
  snapshot() {
    return { events: events.slice(), others: [...others] };
  },
};
