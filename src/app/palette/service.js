// @ts-check
// PaletteService, phase-1 tiers (ENGINE.md §5.9, D12): `local` (the Rust `palette` command, see
// local.js) and `default` (the hand port's red-to-violet). The `artifact` tier arrives in phase 2
// behind the same interface. This is the port of main.js:426-445: a song change fetches the cover's
// palette, a reply for a song that is no longer current is dropped, and a failure means the default.
//
// Deliberate differences from main.js:
//  - No song at all: the default is published at once and any reply still in flight is dropped
//    (main.js clears the palette but leaves the old guard set, so a slow reply for the song that
//    just went away would repaint it).
//  - A service created while a song is already playing looks at it straight away instead of
//    waiting for the next song event.
//  - A song with an empty `file` goes straight to the default (the Rust call would fail anyway).
//
// A consumer that wants the visualizer's own default-palette path (viz `setPalette(null)`, which keeps
// the preset's exact colour order and skips the dark-colour lift) should branch on
// `snapshot.source === 'default'`; the default snapshot's clusters mirror the same four colours but
// `setPalette` would re-rank them.

import { fetchLocalPalette } from './local.js';
import { hexToOklch, lerp } from './lerp.js';

/** @typedef {import('../../engine/contracts').PaletteService} PaletteService */
/** @typedef {import('../../engine/contracts').PaletteSnapshot} PaletteSnapshot */
/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('./local.js').Invoke} Invoke */

/** viz/index.js DEFAULT_PALETTE: "the red-to-violet of the classic screenshot". */
export const DEFAULT_HEXES = Object.freeze(['#ff2020', '#e0307a', '#8a3cff', '#3a6bff']);

/**
 * The `default` tier. It has no shares of its own, so the four colours count equally.
 * @type {PaletteSnapshot}
 */
export const DEFAULT_SNAPSHOT = Object.freeze({
  source: /** @type {const} */ ('default'),
  association: /** @type {const} */ ('default'),
  track: null,
  roles: null,
  guarantees: Object.freeze([]),
  clusters: Object.freeze(DEFAULT_HEXES.map((hex) => Object.freeze({
    hex,
    oklch: /** @type {[number, number, number]} */ (Object.freeze(hexToOklch(hex))),
    share: 1 / DEFAULT_HEXES.length,
  }))),
});

/**
 * @typedef {PaletteService & { dispose(): void }} DisposablePaletteService
 * `dispose` stops listening to the media model and drops every subscriber and in-flight reply.
 */

/**
 * @param {MediaModel} media the song source: only `song` changes are read
 * @param {Invoke} invoke Tauri's `invoke`; `palette` is called as `invoke('palette', { file })`
 * @param {{ now?: () => number }} [opts] `now` stamps `track.generatedAt` (tests pin it)
 * @returns {DisposablePaletteService}
 *   `snapshot()` is the current palette (the default until a local one lands) and never changes
 *   identity without a notification. `subscribe` does not call back on subscription.
 */
export function createPaletteService(media, invoke, opts = {}) {
  /** @type {PaletteSnapshot} */
  let current = DEFAULT_SNAPSHOT;
  /** Generation of the latest song change: the stale-result guard (main.js:439-445, but a counter, so
   *  a song that comes back round while its first reply is still out cannot be applied twice). */
  let generation = 0;
  /** One entry per `subscribe` call, so subscribing the same function twice gives two independent handles.
   *  @type {Set<{ cb: (s: PaletteSnapshot) => void }>} */
  const subscribers = new Set();

  /** @param {PaletteSnapshot} next */
  const publish = (next) => {
    if (next === current) return;
    current = next;
    for (const sub of [...subscribers]) {
      if (!subscribers.has(sub)) continue;                  // unsubscribed by an earlier callback
      try {
        sub.cb(next);
      } catch (e) {
        // One consumer's bug must not stop the others or fail the media notification that led here.
        console.error('palette subscriber threw', e);
      }
    }
  };

  const onSong = () => {
    const mine = ++generation;
    const file = media.snapshot().song?.file;
    if (typeof file !== 'string' || file === '') {
      publish(DEFAULT_SNAPSHOT);
      return;
    }
    // The previous palette stays until the reply lands (main.js keeps painting it meanwhile).
    fetchLocalPalette(invoke, file, opts.now).then(
      (snapshot) => { if (mine === generation) publish(snapshot); },
      () => { if (mine === generation) publish(DEFAULT_SNAPSHOT); },
    );
  };

  const unwatch = media.subscribe((changed) => {
    if (changed.has('song')) onSong();
  });
  onSong();

  return {
    snapshot: () => current,
    subscribe(cb) {
      if (typeof cb !== 'function') throw new TypeError('PaletteService.subscribe(cb): cb is a function');
      const sub = { cb };
      subscribers.add(sub);
      return () => { subscribers.delete(sub); };
    },
    lerp,
    dispose() {
      unwatch();
      generation++;
      subscribers.clear();
    },
  };
}
