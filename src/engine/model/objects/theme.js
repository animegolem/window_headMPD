// @ts-check
// `theme`, `view` and `event`: the three globals that talk about the skin itself and the gesture that
// is running (E D6 mapping table; spec 4.1, 5.7, 6.1, 6.2, 7.3).
//
//   theme   preferences (`"--"` when unset, D6.4, 83 of 94 corpus skins test for it), `loadString`
//           (wmploc 7.7), `logString`, the skin's author, title and copyright, and the view verbs of
//           phase 1: other views are neither opened nor closed, only logged (D6.5).
//   view    the VIEW element's attributes plus the verbs that act on the skin's frame. `close` and `minimize` are honoured
//           only inside a user gesture, so a skin cannot close itself at every launch (D6.5).
//           `returnToMediaCenter` is a host action (default zoom toggle, parity D3).
//           A write to `width` or `height` updates the model, so a script reads back what it wrote
//           (parity D13: the shell does not resize); forwarding the request to the host's resize
//           call belongs to the runtime layer that listens to the model's changes.
//   event   the current dispatch's `EventInit`, or zeros between dispatches.

import { lookupString, resolveStringAttribute } from '../../realm/wmploc.js';
import { bool, int, makeObject, text } from './core.js';
import { elementAttrs } from './element.js';

/** @typedef {import('./core.js').GraphObject} GraphObject */

/** `theme.logString` is for debugging; a flood of it is a flood of host log lines. */
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 512;

/** @param {import('./index.js').Env} env @returns {GraphObject} */
export function createThemeObject(env) {
  const { host, view, theme, skinSha, prefs, ledger, policy } = env;
  /** @type {Map<string, string>} author, title and copyright a script wrote over the markup's */
  const written = new Map();
  let logged = 0;

  /** @param {'author' | 'title' | 'copyright'} name */
  const meta = (name) => written.get(name) ?? resolveStringAttribute(name, String(theme.meta[name] ?? '')).value;

  /** @param {'author' | 'title' | 'copyright'} name @returns {import('./core.js').Handler} */
  const metaField = (name) => ({ get: () => meta(name), set: (v) => { written.set(name, text(v)); } });

  // Another webview of the same skin saved a preference: its value is already inside the caps.
  env.cleanup.push(host.prefs.onExternalChange(skinSha, (key, value) => {
    if (value === null) prefs.delete(key);
    else prefs.set(key, value);
  }));

  /** @param {unknown} id @returns {boolean} whether it names the view that is open */
  const isCurrent = (id) => text(id ?? '').toLowerCase() === view.view.id.toLowerCase();

  return makeObject(env, 'theme', {
    savePreference: {
      call: ([key, value]) => {
        const k = text(key ?? '');
        const v = text(value);
        if (prefs.get(k) === v) return;                       // nothing to save: no cap check, no write
        if (policy.prefWrite(prefs, k, v)) return;            // over a cap: dropped and ledgered
        prefs.set(k, v);
        host.prefs.write(skinSha, k, v);                      // the store debounces the write-through
      },
    },
    loadPreference: { call: ([key]) => prefs.get(text(key ?? '')) ?? '--' },
    loadString: {
      call: ([url]) => {
        const wanted = text(url ?? '');
        const { text: resolved, problem } = lookupString(wanted);
        if (problem) ledger.record(wanted.trim().slice(0, 96) || '(empty)', 'unresolved-res', `theme.loadString: ${problem}`);
        return resolved;
      },
    },
    logString: {
      call: ([message]) => {
        if (logged === MAX_LOG_LINES) ledger.record('theme.logString', 'cap', `more than ${MAX_LOG_LINES} lines; the rest are dropped`);
        if (logged++ >= MAX_LOG_LINES) return;
        host.log.info(`skin: ${text(message ?? '').slice(0, MAX_LOG_CHARS)}`);
      },
    },
    author: metaField('author'),
    title: metaField('title'),
    copyright: metaField('copyright'),
    authorVersion: { get: () => '' },
    version: { get: () => 1 },                                // "the value is always 1.0" (spec 6.1)
    currentViewID: {
      get: () => view.view.id,
      set: (v) => { if (!isCurrent(v)) policy.foreignView('theme.currentViewID', text(v ?? '')); },
    },
    openView: { call: ([id]) => { if (!isCurrent(id)) policy.foreignView('theme.openView', text(id ?? '')); } },
    openViewRelative: { call: ([id]) => { if (!isCurrent(id)) policy.foreignView('theme.openViewRelative', text(id ?? '')); } },
    closeView: {
      call: ([id], ctx) => {
        if (!isCurrent(id)) { policy.foreignView('theme.closeView', text(id ?? '')); return; }
        // Closing the open view is `view.close()` by another name, with the same gesture rule.
        if (policy.requireGesture('theme.closeView', 'theme.closeView() outside a user gesture', ctx)) {
          host.actions.run('close', { viewId: view.view.id });
        }
      },
    },
  });
}

/** @param {import('./index.js').Env} env @returns {GraphObject} */
export function createViewObject(env) {
  const { host, view, policy } = env;
  const el = view.view;
  const viewId = () => el.id;
  return makeObject(env, 'view', {
    timerInterval: {
      get: () => el.get('timerInterval'),
      set: (v, origin) => {
        const n = int(v, NaN);
        if (Number.isNaN(n)) return;
        const accepted = policy.timerInterval('view.timerInterval', n);   // under 50 ms (and not 0) keeps the old value
        if (accepted !== null) el.set('timerInterval', accepted, origin);
      },
    },
    close: {
      call: (_args, ctx) => {
        if (policy.requireGesture('view.close', 'view.close() outside a user gesture', ctx)) host.actions.run('close', { viewId: viewId() });
      },
    },
    minimize: {
      call: (_args, ctx) => {
        if (policy.requireGesture('view.minimize', 'view.minimize() outside a user gesture', ctx)) host.actions.run('minimize', { viewId: viewId() });
      },
    },
    returnToMediaCenter: { call: () => host.actions.run('returnToMediaCenter', { viewId: viewId() }) },
  }, { element: el, attrs: elementAttrs(env, el), handle: el.handle });   // one handle: `view === <the VIEW's id>` holds in script
}

/** @param {import('./index.js').Env} env @returns {GraphObject} */
export function createEventObject(env) {
  /** @param {keyof import('../../contracts').EventInit} field @param {number} zero @returns {import('./core.js').Handler} */
  const number = (field, zero) => ({ get: () => (env.currentEvent ? /** @type {number} */ (env.currentEvent[field]) : zero) });
  /** @param {keyof import('../../contracts').EventInit} field @returns {import('./core.js').Handler} */
  const flag = (field) => ({ get: () => (env.currentEvent ? bool(env.currentEvent[field], false) : false) });
  /** @param {'srcElement' | 'fromElement' | 'toElement'} field @returns {import('./core.js').Handler} */
  const element = (field) => ({ get: () => { const target = env.currentEvent?.[field]; return target ? env.elementRef(target) : null; } });
  return makeObject(env, 'event', {
    x: number('x', 0), y: number('y', 0),
    clientX: number('clientX', 0), clientY: number('clientY', 0),
    offsetX: number('offsetX', 0), offsetY: number('offsetY', 0),
    screenX: number('screenX', 0), screenY: number('screenY', 0),
    screenWidth: number('screenWidth', 0), screenHeight: number('screenHeight', 0),
    button: number('button', 0), keyCode: number('keyCode', 0),
    altKey: flag('altKey'), ctrlKey: flag('ctrlKey'), shiftKey: flag('shiftKey'),
    srcElement: element('srcElement'), fromElement: element('fromElement'), toElement: element('toElement'),
  });
}
