// @ts-check
// The Headspace demo choreography (ENGINE.md D10.7): the promo tour of `src/demo.js`, rewritten to ask
// the screen where things are instead of knowing. It uses a `DemoTarget` and nothing else: element refs
// and script names come from the sidecar's `tour` block, points from `groupPoint`, `sliderThumbPoint`
// and `clientPoint`, drawers from the skin's own toggle functions, the transport from the `MediaModel`.
// No pixel of the old layout appears here: the fractions of the play-controls group are the centroid of
// the pixels a mapping colour owns, and the thumb arithmetic lives behind `sliderThumbPoint`.
//
// The timeline is the legacy one, to the tenth of a second, so the soundtrack still lines up:
//
//    0.4  glide to Play            15.0  glide to the visualization button, click
//    1.6  click (play)             16.4  glide to the chooser's next arrow
//    4.5  playlist drawer          17.0 .. 32.6  five clicks, one per preset
//    7.0  equalizer drawer         35.8  reset the equalizer
//    8.6  five band drags          37.6  back to the resting spot
//                                  39.5  stop recording

/** @typedef {import('./driver.js').Choreography} Choreography */
/** @typedef {import('./driver.js').Director} Director */
/** @typedef {import('./target.js').DemoTarget} DemoTarget */
/** @typedef {import('./target.js').Point} Point */

/**
 * @typedef {object} HeadspaceTour  the sidecar's `tour` block, validated
 * @property {string} transport    the play-controls BUTTONGROUP
 * @property {string} playColor    the mapping colour of its Play element
 * @property {string} visColor     the mapping colour of its visualization-chooser element
 * @property {string} eqHandle
 * @property {string} plHandle
 * @property {string} visNext      the chooser's next arrow
 * @property {string} reset        the equalizer's reset link
 * @property {string[]} bands      the ten equalizer sliders, lowest band first
 * @property {{ x: number, y: number }} rest   where the cursor waits, in view px
 * @property {{ eq: string, pl: string, vis: string }} toggle   script functions that open or close a drawer
 * @property {{ eq: string, pl: string, vis: string }} isOpen   script globals that say whether it is open
 */

/** The keys `parseTour` requires; the sidecar schema's `tour` requires the same ones (a test compares). */
export const TOUR_KEYS = Object.freeze([
  'transport', 'playColor', 'visColor', 'eqHandle', 'plHandle', 'visNext', 'reset', 'bands', 'rest', 'toggle', 'isOpen',
]);

const BAND_COUNT = 10;
const DRAWERS = /** @type {const} */ (['eq', 'pl', 'vis']);
/** The preset the tour starts on. */
const PRESET = 'Chorus';
/** [band index, dB]: a bass-and-treble smile you can hear (the app is the speaker). */
const BAND_DRAGS = Object.freeze([[0, 10], [1, 8], [4, -5], [8, 6], [9, 9]]);
/** When each of the five visualization clicks lands, in seconds after the flash. */
const PRESET_CLICKS = Object.freeze([17.0, 20.9, 24.8, 28.7, 32.6]);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v @returns {v is string} */
const isRef = (v) => typeof v === 'string' && v.length > 0;

/**
 * Check a sidecar's `tour` block. The sidecar schema has already vetted a sidecar that came through
 * `loadSidecar`; this is for a caller that hands one in directly, and it makes the type honest.
 * @param {unknown} tour
 * @returns {HeadspaceTour}
 */
export function parseTour(tour) {
  if (!isRecord(tour)) throw new TypeError('demo: the skin has no tour block in its sidecar');
  for (const key of ['transport', 'playColor', 'visColor', 'eqHandle', 'plHandle', 'visNext', 'reset']) {
    if (!isRef(tour[key])) throw new TypeError(`demo: tour.${key} must be a non-empty string`);
  }
  if (!Array.isArray(tour.bands) || tour.bands.length !== BAND_COUNT || !tour.bands.every(isRef)) {
    throw new TypeError(`demo: tour.bands must hold ${BAND_COUNT} element refs`);
  }
  const rest = tour.rest;
  if (!isRecord(rest) || !Number.isFinite(rest.x) || !Number.isFinite(rest.y)) {
    throw new TypeError('demo: tour.rest must be { x, y } in view px');
  }
  for (const group of ['toggle', 'isOpen']) {
    const names = tour[group];
    if (!isRecord(names) || !DRAWERS.every((d) => isRef(names[d]))) {
      throw new TypeError(`demo: tour.${group} must name a script entry for eq, pl and vis`);
    }
  }
  return /** @type {HeadspaceTour} */ (tour);
}

/**
 * @param {unknown} sidecarTour the `tour` of the Headspace sidecar
 * @returns {Choreography}
 */
export function createHeadspaceChoreography(sidecarTour) {
  const tour = parseTour(sidecarTour);
  /** The owner's equalizer, put back when the tour is over. @type {number[]} */
  let savedEq = [];

  /** @param {Point | null} p @param {string} what @returns {Point} */
  const found = (p, what) => {
    if (!p) throw new Error(`demo: ${what} is not on screen`);
    return p;
  };

  // Equalizer gains travel through the band sliders' own `value`, which is what a drag changes: the
  // skin's `value_onchange` hands it to the DSP, so the tour exercises the same path as a hand.
  /** @param {DemoTarget} target @param {string} ref */
  const bandValue = (target, ref) => Number(target.attr(ref, 'value')) || 0;

  return {
    name: 'headspace',

    async stage(target, d) {
      savedEq = tour.bands.map((ref) => bandValue(target, ref));
      for (const drawer of DRAWERS) {
        if (target.get(tour.isOpen[drawer])) target.call(tour.toggle[drawer]);
      }
      for (const ref of tour.bands) target.setAttr(ref, 'value', 0);
      for (let guard = 0; target.effects.title !== PRESET && guard < 20; guard++) target.effects.step(1);
      if (target.media.snapshot().playState === 'stop') {
        await target.media.play();
        await d.sleep(300);
      }
      await target.media.pause();
      await target.media.seek(0);
      d.moveTo(d.viewPoint(tour.rest.x, tour.rest.y));
      await d.sleep(1500);
    },

    async run(target, d) {
      /** @param {string} ref */
      const on = (ref) => found(target.clientPoint(ref), ref);
      /** @param {number} index @param {number} db */
      const dragBand = async (index, db) => {
        const ref = tour.bands[index];
        await d.glide(found(target.sliderThumbPoint(ref, bandValue(target, ref)), `the thumb of ${ref}`), 350);
        d.press();
        await d.glide(found(target.sliderThumbPoint(ref, db), `the thumb of ${ref}`), 450);
        d.release();
      };

      // Hit play on the current song.
      await d.until(0.4);
      await d.glide(found(target.groupPoint(tour.transport, tour.playColor), 'the play control'), 1000);
      await d.until(1.6);
      await d.click();
      d.log(`play at ${d.elapsed().toFixed(3)}s`);

      // The drawers.
      await d.until(4.5);
      await d.glide(on(tour.plHandle), 900);
      await d.click();
      await d.until(7.0);
      await d.glide(on(tour.eqHandle), 1100);
      await d.click();

      // A bass-and-treble smile you can hear.
      await d.until(8.6);
      for (const [index, db] of BAND_DRAGS) await dragBand(index, db);

      // Second half: the visualization chooser, flipping through the presets.
      await d.until(15.0);
      await d.glide(found(target.groupPoint(tour.transport, tour.visColor), 'the visualization control'), 900);
      await d.click();
      await d.until(16.4);
      await d.glide(on(tour.visNext), 700);
      for (const at of PRESET_CLICKS) {
        await d.until(at);
        await d.click();
      }

      // Put the equalizer back and step aside.
      await d.until(35.8);
      await d.glide(on(tour.reset), 1000);
      await d.click();
      await d.until(37.6);
      await d.glide(d.viewPoint(tour.rest.x, tour.rest.y), 900);
      await d.until(39.5);
    },

    async restore(target) {
      if (savedEq.length === 0) return;
      tour.bands.forEach((ref, i) => target.setAttr(ref, 'value', savedEq[i] ?? 0));
      savedEq = [];
    },
  };
}
