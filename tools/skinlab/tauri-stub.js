// window.__TAURI_INTERNALS__ for the legacy app outside Tauri (`parity 4.1`). legacy-mount.js imports
// this FIRST: main.js calls getCurrentWindow() at module top level.
//
// What it answers: `mpd` with the media preset's canned replies (`?media=<preset>`), `engine_info`
// ok, `palette` rejecting, the event plugin's listen/unlisten, and every window or menu plugin call
// with a no-op. What it records, for capture.mjs: set_hit_mask, set_capture, set_eq, set_balance,
// js_log and anything it does not know, all under window.__skinlab.

import { mediaPreset, queuePairs, statusPairs } from './media-presets.js';

const media = new URLSearchParams(location.search).get('media') ?? 'stoppedEmpty';
mediaPreset(media); // throws on an unknown preset before anything else runs

const calls = [];
const masks = [];
const callbacks = new Map();
const listeners = new Map(); // event name -> callback ids registered through plugin:event|listen
let nextCallback = 1;
let nextEventId = 1;

// player.js and main.js read these with JSON.parse; wipe whatever an earlier load left behind.
// eqOpen, plOpen and zoom stay unset: the states are reached by clicking.
try {
  localStorage.clear();
  localStorage.setItem('eq', JSON.stringify(Array(10).fill(0)));
  localStorage.setItem('balance', '0');
  localStorage.setItem('preset', '1'); // Chorus, the shortest title
} catch {
  // Capture still works; it just won't match the goldens, and verify-legacy will say so.
}

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function mpd(args) {
  const [cmd] = args ?? [];
  switch (cmd) {
    case 'status':
      return statusPairs(media);
    case 'playlistinfo':
      return queuePairs(media);
    case 'currentsong': // empty in every state: no toast, no palette call
    case 'listplaylists':
      return [];
    default:
      return []; // play, pause, seekcur, setvol...: accepted, logged by the caller
  }
}

function invoke(cmd, args = {}) {
  if (cmd === 'set_hit_mask') {
    const bits = Uint8Array.from(args.bits ?? []);
    masks.push({ width: args.width, height: args.height, zoom: args.zoom, b64: toBase64(bits), at: performance.now() });
    calls.push({ cmd, args: { width: args.width, height: args.height, zoom: args.zoom, bytes: bits.length } });
    return Promise.resolve(null);
  }
  calls.push({ cmd, args: clone(args) });
  switch (cmd) {
    case 'mpd':
      return Promise.resolve(mpd(args.args));
    case 'engine_info':
      return Promise.resolve({ mode: 'output', routed: true, error: null });
    case 'palette':
      return Promise.reject(new Error('skinlab: no palette'));
    case 'set_capture':
    case 'set_eq':
    case 'set_balance':
    case 'js_log':
      return Promise.resolve(null);
    case 'plugin:event|listen': {
      const set = listeners.get(args.event) ?? new Set();
      set.add(args.handler);
      listeners.set(args.event, set);
      return Promise.resolve(nextEventId++);
    }
    case 'plugin:event|unlisten':
      return Promise.resolve(null);
    case 'plugin:menu|new':
      return Promise.resolve([1, 'skinlab-menu']);
    default:
      if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:menu|')) return Promise.resolve(null);
      calls[calls.length - 1].unhandled = true;
      return Promise.reject(new Error(`skinlab: unhandled command ${cmd}`));
  }
}

window.__TAURI_INTERNALS__ = {
  invoke,
  transformCallback(callback, once = false) {
    const id = nextCallback++;
    callbacks.set(id, (payload) => {
      if (once) callbacks.delete(id);
      return callback?.(payload);
    });
    return id;
  },
  unregisterCallback: (id) => callbacks.delete(id),
  convertFileSrc: (file, protocol = 'asset') => `${protocol}://localhost/${encodeURIComponent(file)}`,
  metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };

window.__skinlab = {
  media,
  calls,
  masks,
  booted: false,
  /** Deliver a Tauri event to whoever listened for it (mpd-idle, mpd-connection, ...). */
  emit(event, payload) {
    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id: 0, payload });
  },
  /** The last set_hit_mask, as the legacy sent it; what the goldens call "the mask". */
  lastMask: () => masks.at(-1) ?? null,
};
