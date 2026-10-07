// @ts-check
// The TestHostAdapter (ENGINE.md D8, §5.8, §6.2): `createTestHost(opts)` assembles W1.10's primitives
// (manual clock, scripted media, in-memory prefs, fake DSP) with the TestSkinWindow and the stub slot
// provider, and adds the small fakes the rest of the HostAdapter asks for (windows, audio, palette,
// an inline decode executor, recording actions and log). It is the host skinlab renders the engine
// through and the one every engine test builds, so it has no Tauri and no `document` in it: it runs
// headless in Node when no `window.root` is given, and the same code runs in Chromium under skinlab.
//
// Everything a test might want to observe is in `host.recorded`; everything it might want to drive is
// on the primitive itself (`host.clock.advance`, `host.media.emit`, `host.prefs.seed`, `host.audio.emit`).

import { createManualClock } from './clock.js';
import { createFakeDsp } from './dsp.js';
import { createFakeMedia } from './media.js';
import { createMemoryPrefs } from './prefs.js';
import { createTestSlotProvider } from './slots.js';
import { createTestSkinWindow } from './window.js';

export { EFFECTS_TITLES } from './slots.js';

/** @typedef {import('../../engine/contracts').HostAdapter} HostAdapter */
/** @typedef {import('../../engine/contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../engine/contracts').DecodeExecutor} DecodeExecutor */
/** @typedef {import('../../engine/contracts').AudioFrame} AudioFrame */
/** @typedef {import('../../engine/contracts').AudioFrameBus} AudioFrameBus */
/** @typedef {import('../../engine/contracts').PaletteService} PaletteService */
/** @typedef {import('../../engine/contracts').PaletteSnapshot} PaletteSnapshot */
/** @typedef {import('../../engine/contracts').WindowManager} WindowManager */
/** @typedef {import('../../engine/contracts').HostActions} HostActions */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/** @typedef {import('./clock.js').ManualClock} ManualClock */
/** @typedef {import('./media.js').FakeMedia} FakeMedia */
/** @typedef {import('./prefs.js').MemoryPrefs} MemoryPrefs */
/** @typedef {import('./dsp.js').FakeDsp} FakeDsp */
/** @typedef {import('./window.js').TestSkinWindow} TestSkinWindow */
/** @typedef {import('./slots.js').TestSlotProvider} TestSlotProvider */
/** @typedef {import('./slots.js').PlaylistFactory} PlaylistFactory */
/** @typedef {Record<string, Iterable<readonly [string, string]> | Record<string, string>>} PrefSeed namespace -> entries */
/**
 * @typedef {{
 *   media?: string,
 *   clock?: { start?: number },
 *   prefs?: { caps?: Partial<import('./prefs.js').PrefCaps> },
 *   seed?: PrefSeed,
 *   dsp?: { gains?: readonly number[], balance?: number, bypass?: boolean },
 *   window?: import('./window.js').TestWindowOptions,
 *   slots?: { playlist?: PlaylistFactory, titles?: readonly string[] },
 *   palette?: PaletteSnapshot,
 * }} TestHostOptions
 *   `media` is a preset name (default `stoppedEmpty`); `seed` fills prefs namespaces before anything
 *   loads them; `window.root` is the element the engine mounts into (omit it to run headless);
 *   `slots.playlist` is the injected playlist widget factory (omit it for the blank placeholder).
 *
 * @typedef {{ method: string, viewId: string, at?: { left: number, top: number, relative: boolean } }} WindowManagerCall
 * @typedef {{
 *   actions: Array<{ action: string, ctx: { viewId: string } }>,
 *   denied: Array<{ api: string, detail: string }>,
 *   faults: string[],
 *   logs: Array<{ level: 'info' | 'warn', message: string, data?: object }>,
 *   diagnostics: Diagnostic[],
 *   windows: WindowManagerCall[],
 *   window: import('./window.js').WindowRecord,
 * }} HostRecord
 * @typedef {AudioFrameBus & {
 *   emit(frame: AudioFrame): void,
 *   replay(frames: Iterable<AudioFrame>): void,
 *   subscribers(): number,
 *   wantsPcm(): boolean,
 * }} FakeAudio
 * @typedef {PaletteService & { set(snapshot: PaletteSnapshot): void }} FakePalette
 * @typedef {Omit<HostAdapter, 'window' | 'clock' | 'prefs' | 'media' | 'dsp' | 'audio' | 'palette' | 'slots'> & {
 *   readonly window: TestSkinWindow,
 *   readonly clock: ManualClock,
 *   readonly prefs: MemoryPrefs,
 *   readonly media: FakeMedia,
 *   readonly dsp: FakeDsp,
 *   readonly audio: FakeAudio,
 *   readonly palette: FakePalette,
 *   readonly slots: TestSlotProvider,
 *   readonly recorded: HostRecord,
 * }} TestHost
 */

// ---- audio --------------------------------------------------------------------------------------------

/**
 * Silent by default: no frame arrives until a test emits one. A subscriber that did not ask for `pcm`
 * never sees it, like the real bus.
 * @returns {FakeAudio}
 */
function createFakeAudio() {
  /** @type {Set<{ pcm: boolean, cb: (f: AudioFrame) => void }>} */
  const subs = new Set();
  /** @type {FakeAudio} */
  const bus = {
    subscribe(opts, cb) {
      const sub = { pcm: !!opts?.pcm, cb };
      subs.add(sub);
      return () => { subs.delete(sub); };
    },
    emit(frame) {
      for (const sub of [...subs]) {
        if (!subs.has(sub)) continue;
        if (sub.pcm || frame.pcm === undefined) sub.cb(frame);
        else sub.cb({ bands: frame.bands, wave: frame.wave, level: frame.level });
      }
    },
    replay(frames) { for (const f of frames) bus.emit(f); },
    subscribers: () => subs.size,
    wantsPcm: () => [...subs].some((s) => s.pcm),
  };
  return bus;
}

// ---- palette ------------------------------------------------------------------------------------------

/** The `default` tier of E D12 as the test double reports it: no roles, no clusters. */
const DEFAULT_PALETTE = Object.freeze(/** @type {PaletteSnapshot} */ ({
  source: 'default', association: 'default', track: null, roles: null, guarantees: [], clusters: [],
}));

/** @param {string} h @returns {[number, number, number] | null} */
function hexRgb(h) {
  const m = /^#([0-9a-f]{6})$/i.exec(h);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A stand-in for the app's PaletteService (src/app/palette, W2.6), which the test host must not import.
 * The snapshot is the default tier; `lerp` is a plain sRGB mix with exact endpoints, not the blessed
 * polar-OKLCH one, which is fine for a double: no parity state depends on it.
 * @param {PaletteSnapshot} [initial]
 * @returns {FakePalette}
 */
function createFakePalette(initial = DEFAULT_PALETTE) {
  let snap = initial;
  /** @type {Set<(s: PaletteSnapshot) => void>} */
  const subs = new Set();
  return {
    snapshot: () => snap,
    subscribe(cb) {
      subs.add(cb);
      return () => { subs.delete(cb); };
    },
    lerp(a, b, t) {
      const A = hexRgb(a);
      const B = hexRgb(b);
      if (!A || !B) return a;
      if (t <= 0) return a;
      if (t >= 1) return b;
      return `#${A.map((c, i) => Math.round(c + (B[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
    },
    set(next) {
      snap = next;
      for (const cb of [...subs]) if (subs.has(cb)) cb(next);
    },
  };
}

// ---- decode -------------------------------------------------------------------------------------------

/**
 * The decoders, loaded the first time a job needs them rather than when the host is built. Most host
 * users never decode an image, and the JPEG decoder is a CommonJS package: a page whose dev server
 * does not pre-bundle dependencies (skinlab's) must still be able to build a host and report an
 * engine failure before anything asks for a JPEG.
 * @type {Promise<{ decode: typeof import('../../engine/image/decode/index.js'), key: typeof import('../../engine/image/keying.js') }> | null}
 */
let decoders = null;
function loadDecoders() {
  decoders ??= Promise.all([import('../../engine/image/decode/index.js'), import('../../engine/image/keying.js')])
    .then(([decode, key]) => ({ decode, key }))
    .catch((e) => { decoders = null; throw e; });       // a failed load is not remembered
  return decoders;
}

/**
 * The inline DecodeExecutor: decode and key on the calling thread, with W1.3's own functions. The
 * decode warnings go on the planes ahead of the keying warnings, which is what the Worker pool does.
 * @type {DecodeExecutor}
 */
const inlineDecode = {
  async run(job) {
    const { decode, key } = await loadDecoders();
    const { image, diagnostics } = decode.decodeImageWithDiagnostics(job.bytes);
    if (!image) return null;
    const clipImg = job.clipBytes ? decode.decodeImage(job.clipBytes) : null;
    const planes = key.keyImage(image, job.key, clipImg);
    const all = [...diagnostics, ...(planes.diagnostics ?? [])];
    if (all.length) planes.diagnostics = all;
    return planes;
  },
};

// ---- the host -----------------------------------------------------------------------------------------

/**
 * @param {TestHostOptions} [opts]
 * @returns {TestHost}
 */
export function createTestHost(opts = {}) {
  const clock = createManualClock(opts.clock);
  const prefs = createMemoryPrefs({ caps: opts.prefs?.caps });
  for (const [ns, entries] of Object.entries(opts.seed ?? {})) prefs.seed(ns, entries);
  const media = createFakeMedia(opts.media ?? 'stoppedEmpty', { clock });
  const dsp = createFakeDsp(opts.dsp);
  const window = createTestSkinWindow(opts.window);
  const slots = createTestSlotProvider({ prefs, media, playlist: opts.slots?.playlist, titles: opts.slots?.titles });

  /** @type {HostRecord} */
  const recorded = { actions: [], denied: [], faults: [], logs: [], diagnostics: [], windows: [], window: window.recorded };

  /** @type {Set<string>} */
  const open = new Set();
  /** @type {WindowManager} */
  const windows = {
    async open(viewId, at) {
      recorded.windows.push({ method: 'open', viewId, ...(at ? { at } : {}) });
      open.add(viewId);
      return true;
    },
    async close(viewId) {
      recorded.windows.push({ method: 'close', viewId });
      open.delete(viewId);
    },
    isOpen: (viewId) => open.has(viewId),
  };

  /** @type {HostActions} */
  const actions = {
    run: (action, ctx) => { recorded.actions.push({ action, ctx }); },
    denied: (api, detail) => { recorded.denied.push({ api, detail }); },
    fault: (reason) => { recorded.faults.push(reason); },
  };

  /** @type {Log} */
  const log = {
    info: (message, data) => { recorded.logs.push({ level: 'info', message, ...(data ? { data } : {}) }); },
    warn: (message, data) => { recorded.logs.push({ level: 'warn', message, ...(data ? { data } : {}) }); },
    diag: (d) => { recorded.diagnostics.push(d); },
  };

  return {
    kind: 'test',
    window,
    windows,
    clock,
    prefs,
    media,
    dsp,
    audio: createFakeAudio(),
    palette: createFakePalette(opts.palette),
    decode: inlineDecode,
    slots,
    actions,
    log,
    recorded,
  };
}
