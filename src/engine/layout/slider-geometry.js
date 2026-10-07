// @ts-check
// Slider thumb geometry (E D2 SLIDER row; parity D32; spec 6.7, U-10). Pure, and exported on purpose:
// the renderer draws with it, and everything that must agree with the drawing asks the same functions:
// the picker's and the shape rasteriser's thumb claim (`shape/scene.js`), a drag turning a pointer
// position into a value (`input/dispatch.js`) and the inspector's `sliderThumbPoint`. It lives under
// `layout/` rather than the renderer so none of them has to import the DOM renderer's directory;
// `render/dom/slider-geometry.js` re-exports it.
//
// Two geometries, selected by `EngineOptions.sliderGeometry`:
//   'oracle' (the default in every configuration): the thumb's leading edge travels 0 .. L - t, so its
//            centre runs over [t/2, L - t/2]; borderSize does not move it. value = (p - t/2) / travel.
//            This is the hand port's formula (widgets:245-262) and the demo's (demo:108-113).
//   'docs'   the thumb centre runs over [b, L - b] (spec 6.7's reading of borderSize); value follows.
// In both, a vertical slider puts the maximum at the top.
//
// L is the track length along the axis, t the thumb's extent along it, b the borderSize. All results
// are in track pixels from the track's top-left, which is where the canvases are placed.

/**
 * @typedef {Object} SliderAxis
 * @property {boolean} vertical
 * @property {number} length       the track's extent along the axis (L)
 * @property {number} thumb        the thumb's extent along the axis (t)
 * @property {number} border       borderSize (b)
 * @property {'oracle' | 'docs'} geometry
 */

/** A value as a 0..1 fraction of its range; an empty or reversed-to-zero range is 0. @param {number} v @param {number} min @param {number} max */
export function fractionOf(v, min, max) {
  if (!(Number.isFinite(v) && Number.isFinite(min) && Number.isFinite(max)) || max === min) return 0;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

/**
 * The thumb centre's range along the axis: [lo, hi] in track px.
 * @param {SliderAxis} a
 * @returns {{ lo: number, hi: number }}
 */
export function centreRange(a) {
  if (a.geometry === 'docs') {
    const b = Math.min(Math.max(0, a.border), a.length / 2);
    return { lo: b, hi: a.length - b };
  }
  return { lo: a.thumb / 2, hi: a.length - a.thumb / 2 };
}

/**
 * Where the thumb's centre is for a fraction of the range, unrounded (the demo's `5.5 + (1-f)*65`).
 * A vertical slider's fraction is measured from the bottom, so it is mirrored.
 * @param {number} f 0..1 @param {SliderAxis} a
 * @returns {number}
 */
export function thumbCentre(f, a) {
  const { lo, hi } = centreRange(a);
  const g = a.vertical ? 1 - f : f;
  return lo + g * (hi - lo);
}

/**
 * The thumb's leading edge (left, or top), a whole pixel: the oracle rounds the travel, `round(f *
 * travel)` (widgets:257-262); the docs geometry rounds the edge of the centred thumb.
 * @param {number} f 0..1 @param {SliderAxis} a
 * @returns {number}
 */
export function thumbEdge(f, a) {
  if (a.geometry === 'docs') return Math.round(thumbCentre(f, a) - a.thumb / 2);
  const travel = a.length - a.thumb;
  if (travel <= 0) return 0;
  return Math.round((a.vertical ? 1 - f : f) * travel);
}

/**
 * The fraction a pointer position along the axis stands for, clamped to 0..1 (the inverse of
 * `thumbCentre`: the pointer is the thumb's centre).
 * @param {number} p position along the axis in track px @param {SliderAxis} a
 * @returns {number}
 */
export function fractionAt(p, a) {
  const { lo, hi } = centreRange(a);
  const span = hi - lo;
  if (!(span > 0)) return 0;
  const g = Math.min(1, Math.max(0, (p - lo) / span));
  return a.vertical ? 1 - g : g;
}

/**
 * A slider value for a pointer position: continuous, `min + f * (max - min)`. Values stay continuous
 * inside the control (parity D31); the host rounds where it must.
 * @param {number} p @param {SliderAxis} a @param {number} min @param {number} max
 * @returns {number}
 */
export const valueAt = (p, a, min, max) => min + fractionAt(p, a) * (max - min);

/**
 * How far the foreground is revealed along the axis, in px from the start edge (for a vertical
 * slider, from the bottom).
 *  - 'playhead': to the thumb centre, `round(f * travel + t / 2)` for the oracle (widgets:263).
 *  - 'progress': to `foregroundProgress` percent of the track, when `useForegroundProgress` is on;
 *    with it off the foreground follows the playhead (spec 6.7, parity D2).
 * @param {number} f @param {SliderAxis} a
 * @param {{ mode: 'progress' | 'playhead', useProgress: boolean, progress: number }} o
 * @returns {number}
 */
export function revealEdge(f, a, o) {
  if (o.mode === 'progress' && o.useProgress) {
    const p = Number.isFinite(o.progress) ? Math.min(100, Math.max(0, o.progress)) : 0;
    return Math.round((a.length * p) / 100);
  }
  // From the start edge of the track, so a vertical slider counts up from the bottom like `f` does.
  const { lo, hi } = centreRange(a);
  const centre = lo + f * Math.max(0, hi - lo);
  return Math.min(a.length, Math.max(0, Math.round(centre)));
}

/**
 * Which CUSTOMSLIDER strip frame a value shows: `round(f * (N - 1))` (spec 6.8, U-9; rounding is
 * unconfirmed), where N is how many frames the strip holds along its long axis.
 * @param {number} f 0..1 @param {number} frames
 * @returns {number}
 */
export function stripFrame(f, frames) {
  return frames > 1 ? Math.round(Math.min(1, Math.max(0, f)) * (frames - 1)) : 0;
}
