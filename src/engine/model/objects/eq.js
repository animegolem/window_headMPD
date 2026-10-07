// @ts-check
// The two non-visual settings elements a skin can declare: EQUALIZERSETTINGS (`eq`) over the host's
// DSP port, and VIDEOSETTINGS (`vidset`) held locally (E D6 mapping table; spec 6.16, 6.17).
//
// The equalizer is host state, shared with the app's own EQ UI and persisted by the DSP port, so a
// skin's `eq.gainLevel3 = 5` and a drag in the app's own EQ panel are the same value. `bypass` reads the
// DSP's flag, which defaults to false: the EQ is live. WMP documents `true` for its own full-mode
// toggle, but every Headspace user today has the EQ on. The element's markup default for `bypass` is
// therefore not applied.

import { EQ_BANDS } from '../schema.js';
import { bool, clamp, int, makeObject, num } from './core.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('./core.js').GraphObject} GraphObject */
/** @typedef {import('./core.js').Handler} Handler */

/** The one EQ preset WMP's API can name. */
export const EQ_PRESET_TITLE = 'Custom';
/** Spec 6.17: each video colour control runs -127..127. */
const VIDEO_LIMIT = 127;

/**
 * @param {import('./index.js').Env} env
 * @param {ElementModel} [el] the element it is the object of; absent for a bare instance in tests
 * @returns {GraphObject}
 */
export function createEqObject(env, el) {
  const eq = env.host.dsp.eq;
  let splineTension = true;
  /** @type {Record<string, Handler>} */
  const handlers = {
    gainLevels: { call: ([band]) => { const i = int(band, 0); return i >= 1 && i <= EQ_BANDS ? (eq.gains()[i - 1] ?? 0) : 0; } },
    reset: { call: () => eq.reset() },
    bands: { get: () => EQ_BANDS },
    bypass: { get: () => eq.bypass(), set: (v) => eq.setBypass(bool(v, eq.bypass())) },
    enableSplineTension: { get: () => splineTension, set: (v) => { splineTension = bool(v, splineTension); } },
    currentPreset: { get: () => 0, set: () => {} },           // one preset: accepted, nothing to select
    currentPresetTitle: { get: () => EQ_PRESET_TITLE },
    presetCount: { get: () => 1 },
    presetTitle: { call: () => EQ_PRESET_TITLE },
  };
  for (let band = 1; band <= EQ_BANDS; band++) {
    handlers[`gainLevel${band}`] = {
      get: () => eq.gains()[band - 1] ?? 0,
      set: (v) => {
        const db = num(v, NaN);
        if (!Number.isNaN(db)) eq.setGain(band - 1, db);      // the port clamps to its range and persists
      },
    };
  }
  return makeObject(env, 'eq', handlers, el ? { element: el, handle: el.handle } : {});
}

/**
 * @param {import('./index.js').Env} env
 * @param {ElementModel} [el]
 * @returns {GraphObject}
 */
export function createVidsetObject(env, el) {
  /** @type {Record<string, number>} */
  const values = Object.assign(Object.create(null), { brightness: 0, contrast: 0, hue: 0, saturation: 0 });
  /** @type {Record<string, Handler>} */
  const handlers = { reset: { call: () => { for (const k of Object.keys(values)) values[k] = 0; env.hub.emit('local:vidset'); } } };
  for (const name of Object.keys(values)) {
    handlers[name] = {
      get: () => values[name],
      set: (v) => {
        const n = int(v, NaN);
        if (Number.isNaN(n)) return;
        const next = clamp(n, -VIDEO_LIMIT, VIDEO_LIMIT);
        if (next === values[name]) return;
        values[name] = next;
        env.hub.emit('local:vidset');
      },
    };
  }
  return makeObject(env, 'vidset', handlers, el ? { element: el, handle: el.handle } : {});
}
