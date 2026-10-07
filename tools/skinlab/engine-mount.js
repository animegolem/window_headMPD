// Mounts the engine in Chromium for skinlab (E D9, engine side). It builds the test host, seeds it
// the way the legacy capture seeds localStorage, loads the archive and the sidecar the runner hands
// over, and exposes what the runner needs under window.__skinlabEngine:
//
//   mount(job)   {archive: base64, name, sidecar?, config: 'compat'|'faithful', media: preset}
//                -> {ok: true} | {ok: false, error}. A rejected load is REPORTED, never thrown: an
//                uncaught rejection would be a page error, and the runner treats those as a crashed
//                page. Until W4.1 replaces the W0.1 stub, `load` rejects and this says
//                "engine not implemented".
//   settle()     advance(500) on the manual clock (16 ms frames), then runtime.settled()
//   call(name)   runtime.inspector.callGlobal(name): the skin's own code path (S2b)
//   mask()       the last window shape as {width, height, b64}: 1 bpp, row-major, LSB first, skin px
//   recorded()   what the test host's SkinWindow was asked to do
//
// The clock is the host's manual one: nothing here calls page.clock.install, so performance.now (the
// realm budget's clock) stays real.

import { createEngine } from '../../src/engine/index.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../src/engine/options.js';
import { createTestHost } from '../../src/hosts/test/index.js';

/** E D9: both configurations run on `sliderGeometry: 'oracle'`; only the allow-list switches differ. */
const CONFIGS = new Map([
  ['compat', ORACLE_COMPAT],
  ['faithful', FAITHFUL],
]);

/**
 * What the legacy capture seeds (tauri-stub.js): `eq` zeros, `balance` 0, `preset` 1. `mediacenter.effectPreset`
 * is the engine's name for the preset, so the title reads "Chorus"; the `app` namespace carries the
 * legacy host keys (D6.4), and the fake DSP starts flat and centred.
 */
export const SEED = Object.freeze({
  mediacenter: Object.freeze({ effectPreset: '1' }),
  app: Object.freeze({ eq: JSON.stringify(Array(10).fill(0)), balance: '0' }),
});

/**
 * W5.1 injects the real playlist widget here (`mountPlaylist` of src/app/widgets/playlist.js, built
 * against a MediaModel and the slot element). Until then the host's blank placeholder stands in.
 * @type {import('../../src/hosts/test/slots.js').PlaylistFactory | undefined}
 */
const PLAYLIST_FACTORY = undefined;

/** 760x394 is 37,430 bytes: a spread of String.fromCharCode would overflow the stack, so go in slices. */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A MaskShape as 1 bpp bits in skin px; rectangles are rasterised, polygons are not supported here. */
function shapeBits(shape) {
  if (shape.kind === 'bits') return { width: shape.width, height: shape.height, bits: shape.bits };
  const { width, height } = shape;
  const bits = new Uint8Array((width * height + 7) >> 3);
  for (const r of shape.regions) {
    if (r.poly) throw new Error('skinlab cannot compare a regions shape with a polygon');
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) bits[(y * width + x) >> 3] |= 1 << ((y * width + x) & 7);
    }
  }
  return { width, height, bits };
}

const state = { host: null, skin: null, runtime: null };

async function settle() {
  state.host.clock.advance(500);
  await state.runtime.settled();
}

/** @param {{ archive: string, name?: string, sidecar?: object, config: string, media: string }} job */
async function mount(job) {
  const config = CONFIGS.get(job.config);
  if (!config) return { ok: false, error: `unknown config "${job.config}"` };
  const root = document.getElementById('skin');
  try {
    root.replaceChildren();
    state.host = createTestHost({
      media: job.media,
      seed: SEED,
      dsp: { gains: Array(10).fill(0), balance: 0 },
      window: { root },
      slots: { playlist: PLAYLIST_FACTORY },
    });
    const engine = createEngine(state.host, config);
    state.skin = await engine.load(fromBase64(job.archive), { name: job.name, ...(job.sidecar ? { sidecar: job.sidecar } : {}) });
    state.runtime = await state.skin.attach();
    await settle();
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  return { ok: true };
}

window.__skinlabEngine = {
  booted: true,
  mount,
  settle,
  async call(name, args) {
    return state.runtime.inspector.callGlobal(name, args);
  },
  mask() {
    const { width, height, bits } = shapeBits(state.runtime.maskShape());
    return { width, height, b64: toBase64(bits) };
  },
  recorded() {
    const w = state.host.recorded.window;
    return { shapes: w.shapes.length, captures: w.captures.length, drags: w.drags, diagnostics: state.host.recorded.diagnostics.length };
  },
};
