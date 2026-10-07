// @ts-check
// Element host objects (E D6, the "every element" row): what a script sees when it writes
// `sEqEar.moveto(...)`, `bEqHandle.image = ...` or `visEffects.next()`. An element object is the
// element's attribute table plus the verbs of its kind, built against the `ElementModel` contract, so
// it works with any model that honours it (the tests use an in-test fake).
//
//   attributes   every live property of the class is an element attribute. A read returns the model's
//                value as a script sees it (a colour as `#rrggbb`, `none` or `auto`; a missing text as
//                ''); a write goes through `ElementModel.set`, which coerces and keeps the previous
//                value on invalid input (U-20). A write of a `res://` string resolves it first
//                (wmploc 7.7), a slider `value` outside `min..max` is ignored (spec 6.7), and a write
//                of a geometry attribute stops the element's running tween, so the script's value is
//                not overwritten on the next frame.
//   animation    moveTo, slideTo, moveSizeTo and alphaBlendTo hand the target to the animator.
//   per kind     BUTTONGROUP `getButton`; the EFFECTS element on the host `EffectsControl`;
//                PLAYLIST's accepted-and-ignored column calls. BUTTONGROUP `click(i)` and
//                BUTTONELEMENT `click()` queue the button's `onclick` through `deps.queueEvent`; the
//                runtime runs it after the calling entry returns, like an `_onchange` handler (no
//                re-entry), and without a queue the call is a ledgered stub.

import { attrSpec } from '../../wms/attrs.js';
import { resolveStringAttribute } from '../../realm/wmploc.js';
import { SCHEMA, apiName, elementClassName } from '../schema.js';
import { bool, clamp, int, makeObject, num } from './core.js';
import { createEqObject, createVidsetObject } from './eq.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').Wire} Wire */
/** @typedef {import('./core.js').GraphObject} GraphObject */
/** @typedef {import('./core.js').AttrAccess} AttrAccess */
/** @typedef {import('./core.js').Handler} Handler */

/** What `visEffects.currentEffectType` reads: one effect, so a constant (E D6). */
export const EFFECT_TYPE = 'headmpd.viz';
/** What `currentEffectTitle` and `effectTitle(0)` read. */
export const EFFECT_TITLE = 'Visualizer';

/** Geometry and blend attributes: a script write cancels the element's running tween. */
const TWEENED = new Set(['left', 'top', 'right', 'bottom', 'width', 'height', 'alphablend']);
const SLIDERS = new Set(['slider', 'progressbar', 'customslider']);

/** An Rgb number as the text a script reads; `none` and `auto` stay as they are. @param {number} n */
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * The model's value as a script reads it.
 * @param {import('../../contracts').AttrType | undefined} type @param {unknown} v @returns {Wire}
 */
function toScript(type, v) {
  const numeric = type === 'int' || type === 'float';
  if (v === null || v === undefined) return type === 'bool' ? false : numeric ? 0 : '';
  if (type === 'color' && typeof v === 'number') return hex(v);
  return /** @type {Wire} */ (v);
}

/**
 * Attribute access for one element: the `attrs` option of `makeObject`. Also what the `view` global
 * uses, since the VIEW is an element too.
 * @param {import('./index.js').Env} env
 * @param {ElementModel} el
 * @returns {AttrAccess}
 */
export function elementAttrs(env, el) {
  return {
    get: (spec) => toScript(attrSpec(el.kind, spec.name)?.type, el.get(spec.name)),

    set(spec, v, origin) {
      if (typeof v === 'object' && v !== null) return;                 // a handle is not an attribute value
      const name = spec.name;
      const key = name.toLowerCase();
      const type = attrSpec(el.kind, name)?.type;
      let value = v;
      if (origin === 'script' && key === 'value' && SLIDERS.has(el.kind)) {
        const n = num(v, NaN);
        const min = num(el.get('min'), 0);
        const max = num(el.get('max'), 100);
        if (!Number.isNaN(n) && min < max && (n < min || n > max)) return;      // out of range: ignored
      }
      if (type === 'string' && typeof v === 'string') {
        const resolved = resolveStringAttribute(name, v);
        if (resolved.problem) env.ledger.record(v.trim().slice(0, 96) || '(empty)', 'unresolved-res', `${name}: ${resolved.problem}`);
        value = resolved.value;
      }
      if (origin === 'script' && TWEENED.has(key)) env.animate.cancel(el);
      el.set(name, value, origin);
    },
  };
}

/** @param {import('./index.js').Env} env @param {ElementModel} el @returns {Record<string, Handler>} */
function animationHandlers(env, el) {
  /** @param {Wire[]} a @param {number} from the argument index the numbers start at @param {number} count @returns {number[] | null} */
  const numbers = (a, from, count) => {
    const out = [];
    for (let i = from; i < from + count; i++) {
      const n = num(a[i], NaN);
      if (Number.isNaN(n)) return null;
      out.push(n);
    }
    return out;
  };
  return {
    // `moveTo(left, top, time)`: linear (spec 5.2). A bad number drops the call, as WMP would error.
    moveTo: { call: (a) => { const n = numbers(a, 0, 3); if (n) env.animate.moveTo(el, n[0], n[1], Math.max(0, n[2]), 'linear'); } },
    slideTo: { call: (a) => { const n = numbers(a, 0, 3); if (n) env.animate.moveTo(el, n[0], n[1], Math.max(0, n[2]), 'inout'); } },
    moveSizeTo: {
      call: (a) => {
        const n = numbers(a, 0, 5);
        if (n) env.animate.moveTo(el, n[0], n[1], Math.max(0, n[4]), bool(a[5], false) ? 'inout' : 'linear', n[2], n[3]);
      },
    },
    alphaBlendTo: { call: (a) => { const n = numbers(a, 0, 2); if (n) env.animate.alphaBlendTo(el, clamp(n[0], 0, 255), Math.max(0, n[1])); } },
  };
}

/** The EFFECTS element, on the host's `EffectsControl` (the visualizer slot). @param {import('./index.js').Env} env @param {ElementModel} el @returns {Record<string, Handler>} */
function effectsHandlers(env, el) {
  const control = () => env.effectsOf(el);
  return {
    currentEffectType: { get: () => EFFECT_TYPE, set: () => {} },       // one effect: accepted, no effect
    currentEffectTitle: { get: () => EFFECT_TITLE },
    currentPreset: {
      get: () => control()?.index ?? int(el.get('currentPreset'), 0),
      set: (v) => {
        const wanted = int(v, NaN);
        if (Number.isNaN(wanted)) return;
        const c = control();
        const index = c && c.count > 0 ? clamp(wanted, 0, c.count - 1) : wanted;
        c?.setIndex(index);
        el.set('currentPreset', index, 'script');
      },
    },
    currentPresetTitle: { get: () => control()?.title ?? '' },
    currentEffectPresetCount: { get: () => control()?.count ?? 0 },
    effectCount: { get: () => 1 },
    next: { call: () => control()?.step(1) },
    nextPreset: { call: () => control()?.step(1) },
    previous: { call: () => control()?.step(-1) },
    previousPreset: { call: () => control()?.step(-1) },
    nextEffect: { call: () => {} },                                     // a single effect: nothing to skip to
    previousEffect: { call: () => {} },
    settings: { call: () => {} },
    effectTitle: { call: ([i]) => (int(i, -1) === 0 ? EFFECT_TITLE : '') },
    effectType: { call: ([i]) => (int(i, -1) === 0 ? EFFECT_TYPE : '') },
  };
}

/**
 * Script `click()`: queue the element's `onclick` for the runtime to run once the entry returns.
 * Without a queue there is nothing to run it with, so the call is a stub in the ledger, as it was
 * before the runtime offered one.
 * @param {import('./index.js').Env} env
 * @param {string} className the schema class, for the ledger's api name
 * @param {() => ElementModel | undefined} target the element whose `onclick` runs
 */
function click(env, className, target) {
  if (!env.queueEvent) {
    env.ledger.record(apiName(className, 'click'), 'stub', 'no event queue to run onclick');
    return;
  }
  const el = target();
  if (el) env.queueEvent(el, 'onclick');
}

/** @param {import('./index.js').Env} env @param {ElementModel} el @returns {Record<string, Handler>} */
function kindHandlers(env, el) {
  switch (el.kind) {
    case 'effects': return effectsHandlers(env, el);
    case 'buttongroup': {
      /** @param {Wire} i @returns {ElementModel | undefined} the i-th BUTTONELEMENT, in markup order (`getButton`'s and `click`'s index) */
      const buttonAt = (i) => el.children.filter((c) => c.kind === 'buttonelement')[int(i, -1)];
      return {
        getButton: { call: ([i]) => { const button = buttonAt(i); return button ? env.elementRef(button) : null; } },
        // WMP: `click(index)` runs that BUTTONELEMENT's `onclick` (spec 6.5). A bad index runs nothing.
        click: { call: ([i]) => click(env, 'element.buttongroup', () => buttonAt(i)) },
      };
    }
    case 'buttonelement':
      return { click: { call: () => click(env, 'element.buttonelement', () => el) } };       // spec 6.6
    case 'playlist':
      // The host's playlist widget has its own columns: WMP's resize calls are accepted and ignored.
      return { setColumnResizeMode: { call: () => {} }, setColumnWidth: { call: () => {} } };
    default: return {};
  }
}

/**
 * The host object of one element.
 * @param {import('./index.js').Env} env
 * @param {ElementModel} el
 * @returns {GraphObject}
 */
export function createElementObject(env, el) {
  if (el.kind === 'equalizersettings') return createEqObject(env, el);
  if (el.kind === 'videosettings') return createVidsetObject(env, el);
  const className = elementClassName(el.kind);
  const members = /** @type {ReadonlyMap<string, unknown>} */ (SCHEMA.get(className));
  // The animation verbs are written once for every kind; each class takes the ones its schema lists.
  const handlers = Object.fromEntries(Object.entries({ ...animationHandlers(env, el), ...kindHandlers(env, el) }).filter(([name]) => members.has(name.toLowerCase())));
  return makeObject(env, className, handlers, {
    element: el,
    attrs: elementAttrs(env, el),
    handle: el.handle,
  });
}

