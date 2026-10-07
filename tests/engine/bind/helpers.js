// @ts-check
// A real skin under a real object graph, for the binding tests (W3.2): `.wms` text goes through the
// scanner and the builder (so tag defaults, sources and handlers are the ones a loaded skin has),
// the graph is W2.3's over the test host's media, DSP and manual clock, and the binding engine is
// driven by that clock's frames the way the view runtime will drive it.
//
// What stands in for the runtime and the realm: `drain` runs a table of JavaScript functions in
// place of the skin handlers the model queued (`volume.value_onchange` and so on), and `frames`
// counts what the model queued, so a test can say what "reaches the realm" means.

import { scanWms } from '../../../src/engine/wms/scan.js';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { createObjectGraph } from '../../../src/engine/model/objects/index.js';
import { createLedger } from '../../../src/engine/model/ledger.js';
import { createBindings } from '../../../src/engine/bind/bindings.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createTestHost } from '../../../src/hosts/test/index.js';

/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').Wire} Wire */

const vfs = { sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null };

/**
 * The model of a one-VIEW skin, as the builder makes it.
 * @param {string} body markup inside the VIEW
 * @param {string} [viewAttrs]
 */
export function buildView(body, viewAttrs = '') {
  const text = `<THEME title="t"><VIEW id="v" width="300" height="200" ${viewAttrs}>${body}</VIEW></THEME>`;
  const { root } = scanWms(text);
  const theme = buildTheme(/** @type {any} */ (root), /** @type {any} */ (vfs), { probe: () => null });
  return { theme, view: theme.views[0] };
}

/**
 * @param {string} body markup inside the VIEW
 * @param {{ media?: string, install?: boolean, realmTickHz?: number, ledger?: boolean, viewAttrs?: string }} [opts]
 */
export function makeSkin(body, opts = {}) {
  const { theme, view } = buildView(body, opts.viewAttrs);
  const host = createTestHost({ media: opts.media ?? 'stoppedQueue5' });
  const ledger = createLedger(vfs.sha);
  /** @type {Array<[string, ...unknown[]]>} */
  const animCalls = [];
  const graph = createObjectGraph(/** @type {any} */ ({
    host,
    view,
    theme,
    skinSha: vfs.sha,
    prefs: new Map(),
    ledger,
    opts: FAITHFUL,
    animate: {
      moveTo: (/** @type {any[]} */ ...a) => { animCalls.push(['moveTo', ...a]); },
      alphaBlendTo: (/** @type {any[]} */ ...a) => { animCalls.push(['alphaBlendTo', ...a]); },
      cancel: (/** @type {any[]} */ ...a) => { animCalls.push(['cancel', ...a]); },
    },
    effectsOf: () => null,
    inGesture: () => false,
  }));
  const bindings = createBindings(view, graph, host.clock, { realmTickHz: opts.realmTickHz ?? FAITHFUL.realmTickHz, ...(opts.ledger === false ? {} : { ledger }) });
  host.clock.onFrame((now) => bindings.frame(now));
  if (opts.install !== false) bindings.install();

  /** @param {string} id @returns {ElementModel} */
  const el = (id) => {
    const found = view.byId(id);
    if (!found) throw new Error(`no element ${id}`);
    return found;
  };

  /** Every setVolume the media model was asked for, in order. */
  const volumeCalls = () => host.media.calls.filter((c) => c.method === 'setVolume');

  /**
   * Run the queued handlers through `table` ("id.event" -> function) until the queue is empty, FIFO,
   * as the runtime does after an entry returns. Returns the "id.event" names it ran.
   * @param {Record<string, (el: ElementModel) => void>} [table]
   */
  function drain(table = {}) {
    /** @type {string[]} */
    const ran = [];
    for (let guard = 0; guard < 1000; guard++) {
      const queued = view.takeQueuedEvents();
      if (queued.length === 0) break;
      for (const { el: target, event } of queued) {
        const name = `${target.id}.${event}`;
        ran.push(name);
        table[name]?.(target);
      }
    }
    return ran;
  }

  /**
   * Write `player.<path>` the way a script does.
   * @param {string} member `settings.volume`, `controls.currentPosition`
   * @param {Wire} value
   */
  function scriptWrite(member, value) {
    const parts = member.split('.');
    let obj = graph.globals.player;
    for (const part of parts.slice(0, -1)) {
      const h = /** @type {{ __h: number }} */ (obj.get(part));
      obj = /** @type {any} */ (graph.objectOf(h.__h));
    }
    obj.set(parts[parts.length - 1], value, 'script');
  }

  return { host, clock: host.clock, media: host.media, theme, view, graph, ledger, bindings, el, drain, volumeCalls, scriptWrite, animCalls };
}

/**
 * Count the model's queued events by "id.event", for as long as `run` takes. Events not drained here
 * stay drained (the queue is the test's own).
 * @param {ReturnType<typeof makeSkin>} skin
 * @param {() => void} run
 * @returns {Map<string, number>}
 */
export function countEvents(skin, run) {
  skin.view.takeQueuedEvents();
  run();
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const { el, event } of skin.view.takeQueuedEvents()) {
    const name = `${el.id}.${event}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
