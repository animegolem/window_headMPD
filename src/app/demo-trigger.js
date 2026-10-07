// @ts-check
// The demo tour's trigger (ENGINE.md D10.7): `mpc sendmessage window_head "demo /path/to/soundtrack.wav"`
// reaches the page as the `mpd-message` event (Rust emits it for every message on the `window_head`
// channel, lib.rs), and this module turns the one message that says `demo` into a tour. It is the
// engine-mode twin of `main.js:547-578`, which stays pinned and untouched until cutover.
//
//   attachDemoTrigger   listens, parses, keeps one tour at a time, reports a failed one
//   planTour            the live view, sidecar and media model, made into what `runTour` takes, or a
//                       reason the tour cannot run on this skin
//
// Everything outside the page comes in as an argument (`listen`, the plan, `run`, the log), so the
// integration test drives the same code the app does, and Tauri is never imported here (the driver
// loads it itself, on demand, when no recorder is handed in).
//
// What the trigger deliberately does not do:
//  - It reads the plan when a message arrives, not when it starts listening. A skin reload replaces the
//    view, the inspector and the sidecar, and a tour must aim at the ones that are live now.
//  - It does not cancel a tour that is running when the listener is disposed or the skin reloads. The
//    driver has no abort; a tour that loses its view fails at its next call and reports it. What
//    `runTour` guarantees on any exit (the recorder stopped, the cursor gone, the equalizer put back)
//    still holds.
//  - It does not look the command up in a table. The word is compared with `demo`, so a message that
//    says `__proto__` or `constructor` is an unknown command and nothing else (E §1 rule 6).

import { runTour } from './demo/driver.js';
import { createHeadspaceChoreography } from './demo/headspace.js';
import { createDemoTarget } from './demo/target.js';

/** @typedef {import('./demo/driver.js').Choreography} Choreography */
/** @typedef {import('./demo/driver.js').TourEnv} TourEnv */
/** @typedef {import('./demo/target.js').DemoTarget} DemoTarget */
/** @typedef {import('../engine/contracts').Sidecar} Sidecar */
/** @typedef {import('../engine/contracts').SkinInspector} SkinInspector */
/** @typedef {import('../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../engine/contracts').Log} Log */
/** @typedef {{ target: DemoTarget, choreography: Choreography }} TourPlan */
/** @typedef {{ refuse: string }} TourRefusal why this skin cannot be toured right now */
/** @typedef {(event: string, cb: (e: { payload?: unknown }) => void) => Promise<() => void> | (() => void)} ListenFn Tauri's `listen` */
/** @typedef {(target: DemoTarget, choreography: Choreography, wavPath: string, env?: TourEnv) => Promise<void>} RunTourFn */

/** The Tauri event Rust emits for each message on the `window_head` MPD channel. */
export const MESSAGE_EVENT = 'mpd-message';
/** Where the soundtrack goes when the message names no path (main.js:551); Rust's `record_stop` allows /tmp. */
export const DEFAULT_WAV = '/tmp/window_headmpd-demo.wav';

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));
/** A failed tour is logged with its stack, as main.js did: it is the only trace of where a choreography stopped. @param {unknown} e */
const stackOf = (e) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * The soundtrack path of a `demo` message, or null when the message is anything else. The command is
 * the text up to the first space, exactly `demo`; the rest of the line is the path, so a path may hold
 * spaces. A message with no path (or only blanks) names the default one. Rust sends text, so anything
 * that is not a string is not a message.
 * @param {unknown} payload what `mpd-message` carried
 * @returns {string | null}
 */
export function parseDemoMessage(payload) {
  if (typeof payload !== 'string') return null;
  const line = payload;
  const space = line.indexOf(' ');
  const cmd = space < 0 ? line : line.slice(0, space);
  if (cmd !== 'demo') return null;
  const rest = space < 0 ? '' : line.slice(space + 1).trim();
  return rest || DEFAULT_WAV;
}

/**
 * Make the live app into a tour, or say why it cannot be. The tour needs a view with a runtime that has
 * not unloaded, a sidecar with a `tour` block that parses, and an effects control (the Headspace stage
 * sets the visualization preset first). Nothing is thrown: the caller logs the reason.
 * @param {{
 *   view: { inspector?: SkinInspector, health?: { unloaded: boolean } } | null,
 *   sidecar: Pick<Sidecar, 'tour'> | null,
 *   media: MediaModel,
 *   effects: EffectsControl | null,
 *   zoom: () => number,
 * }} live
 * @returns {TourPlan | TourRefusal}
 */
export function planTour({ view, sidecar, media, effects, zoom }) {
  if (!view?.inspector) return { refuse: 'no skin view is attached' };
  if (view.health?.unloaded) return { refuse: 'the skin has stopped' };
  if (!sidecar?.tour) return { refuse: 'this skin has no tour in its sidecar' };
  if (!effects) return { refuse: 'this skin has no visualization (EFFECTS) element to tour' };
  try {
    const choreography = createHeadspaceChoreography(sidecar.tour);
    const target = createDemoTarget({ inspector: view.inspector, media, effects, zoom });
    return { target, choreography };
  } catch (e) {
    return { refuse: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Start listening for `demo` messages.
 * @param {{
 *   listen: ListenFn,
 *   plan: () => TourPlan | TourRefusal,
 *   log: Pick<Log, 'info' | 'warn'>,
 *   run?: RunTourFn,
 *   env?: TourEnv,
 *   event?: string,
 * }} deps `plan` is asked when a message arrives; `run` is the driver's `runTour` unless a test brings
 *   its own; `env` is what `runTour` takes (its clock, recorder, document: omitted in the app, so the
 *   driver uses real time and the Tauri recorder).
 * @returns {{
 *   ready: Promise<void>,
 *   handle(payload: unknown): Promise<void>,
 *   running(): boolean,
 *   dispose(): void,
 * }} `ready` settles when the listener is registered (it never rejects); `handle` is what the event
 *   calls, resolving when a tour it started has finished
 */
export function attachDemoTrigger({ listen, plan, log, run = runTour, env, event = MESSAGE_EVENT }) {
  let busy = false;
  let disposed = false;
  /** @type {(() => void) | null} */
  let unlisten = null;

  /** @param {unknown} payload */
  async function handle(payload) {
    if (disposed) return;
    const wav = parseDemoMessage(payload);
    if (wav === null) return;
    if (busy) {
      log.info('demo: a tour is already running; the message is ignored');
      return;
    }
    busy = true;                                              // before anything can yield: a second message waits out the first
    try {
      const made = plan();
      if ('refuse' in made) {
        log.warn(`demo: not started: ${made.refuse}`);
        return;
      }
      await run(made.target, made.choreography, wav, env);
    } catch (e) {
      log.warn(`demo failed: ${stackOf(e)}`);
    } finally {
      busy = false;
    }
  }

  // The executor runs at once, so `listen` is called before this function returns; a throw rejects.
  const ready = new Promise((resolve) => { resolve(listen(event, (e) => { void handle(e?.payload); })); })
    .then(
      (off) => {
        if (typeof off !== 'function') return;
        if (disposed) off();                                  // disposed while the registration was still in flight
        else unlisten = off;
      },
      (e) => { log.warn(`demo: could not listen for ${event}: ${messageOf(e)}`); },
    );

  return {
    ready,
    handle,
    running: () => busy,
    dispose() {
      if (disposed) return;
      disposed = true;
      const off = unlisten;
      unlisten = null;
      try {
        off?.();
      } catch { /* the listener ends with the page anyway */ }
    },
  };
}
