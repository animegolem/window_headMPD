// @ts-check
// The one blessed colour interpolation (ENGINE.md §5.9, D12): polar OKLCH, shortest way round the
// hue wheel. Every consumer that needs "a colour between these two" (a skin adapter fading a slot,
// the visualizer easing between songs) calls PaletteService.lerp, so they cannot disagree.
//
// The conversions are a port of color-core's `color.rs` (the crate behind the Rust `palette`
// command): the same OKLab matrices, hue in degrees in [0, 360), chroma compression by a 24-step
// bisection when a result leaves sRGB, and the same 1e-6 "no hue" threshold. That keeps `oklch`
// triples from the local tier and `lerp` in one space. Arithmetic is f64 here and f32 there, so
// agreement is to rounding, not bit for bit.

/** @typedef {readonly [number, number, number]} Triple */

const NO_HUE = 1e-6;          // chroma below this: the hue is powerless (color.rs EPSILON)
const GAMUT_EPS = 1e-6;       // linear channels may overshoot [0, 1] by this much and still count as in gamut
const GAMUT_STEPS = 24;

/** @param {number} c 0..1 sRGB channel */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** @param {number} c linear channel */
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** @param {number} v */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** @param {number} deg */
const wrapDegrees = (deg) => {
  const v = deg % 360;
  return v < 0 ? v + 360 : v;
};

/**
 * @param {Triple} lin linear sRGB
 * @returns {[number, number, number]} OKLab
 */
function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * @param {number} L @param {number} a @param {number} b
 * @returns {[number, number, number]} linear sRGB, unclamped
 */
function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** @param {Triple} lin */
const inGamut = (lin) => lin.every((c) => c >= -GAMUT_EPS && c <= 1 + GAMUT_EPS);

/** @param {number} L @param {number} C @param {number} h degrees @returns {[number, number, number]} */
function oklchToLinear(L, C, h) {
  const rad = (wrapDegrees(h) * Math.PI) / 180;
  return oklabToLinear(L, C * Math.cos(rad), C * Math.sin(rad));
}

/**
 * OKLCH to 8-bit sRGB. A colour outside sRGB keeps its lightness and hue and loses chroma
 * (bisection, as color.rs does); a lightness outside [0, 1] is clamped per channel.
 * @param {number} L @param {number} C @param {number} h
 * @returns {[number, number, number]}
 */
function oklchToRgb8(L, C, h) {
  C = Math.max(0, C);
  let lin = oklchToLinear(L, C, h);
  if (!inGamut(lin) && C > 0) {
    let low = 0;
    let high = C;
    let best = oklchToLinear(L, 0, 0);
    for (let i = 0; i < GAMUT_STEPS; i++) {
      const mid = (low + high) / 2;
      const candidate = oklchToLinear(L, mid, h);
      if (inGamut(candidate)) {
        best = candidate;
        low = mid;
      } else {
        high = mid;
      }
    }
    lin = best;
  }
  return /** @type {[number, number, number]} */ (lin.map((c) => Math.floor(clamp01(linearToSrgb(clamp01(c))) * 255 + 0.5)));
}

/**
 * `#rgb` or `#rrggbb`, any case, to channel bytes; null for anything else.
 * @param {unknown} s
 * @returns {[number, number, number] | null}
 */
export function parseHex(s) {
  if (typeof s !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** @param {Triple} rgb @returns {string} lower-case `#rrggbb` */
const toHex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

/**
 * @param {Triple} rgb bytes
 * @returns {[number, number, number]} [L, C, h]; h is 0 when the colour has no hue
 */
function rgb8ToOklch(rgb) {
  const [L, a, b] = linearToOklab(/** @type {[number, number, number]} */ (rgb.map((c) => srgbToLinear(c / 255))));
  const C = Math.hypot(a, b);
  return [L, C, C < NO_HUE ? 0 : wrapDegrees((Math.atan2(b, a) * 180) / Math.PI)];
}

/**
 * @param {string} color `#rgb` or `#rrggbb`
 * @returns {[number, number, number]} OKLCH: L 0..1, C in OKLab units, h in degrees [0, 360)
 * @throws {TypeError} when `color` is not a hex colour
 */
export function hexToOklch(color) {
  return rgb8ToOklch(mustParse(color));
}

/**
 * @param {number} L @param {number} C @param {number} h degrees
 * @returns {string} lower-case `#rrggbb`, chroma-compressed into sRGB when needed
 */
export function oklchToHex(L, C, h) {
  return toHex(oklchToRgb8(L, C, h));
}

/** @param {unknown} color @returns {[number, number, number]} */
function mustParse(color) {
  const rgb = parseHex(color);
  if (!rgb) throw new TypeError(`palette: not a #rgb or #rrggbb colour: ${String(color)}`);
  return rgb;
}

/**
 * The colour a fraction `t` of the way from `a` to `b`, interpolated in OKLCH: lightness and chroma
 * linearly, hue along the shorter arc (a tie at exactly 180 degrees goes the increasing way). A
 * colour with no hue (greys) borrows the other end's hue, so grey to red fades chroma in without
 * swinging through other hues.
 *
 * `t` is clamped to [0, 1] and a NaN counts as 0. The result is lower-case `#rrggbb`. The ends are
 * exact: `lerp(a, b, 0)` and `lerp(a, a, t)` are `a`, and `lerp(a, b, 1)` is `b`, as canonical
 * lower-case `#rrggbb` (so `#FA0` in comes out `#ffaa00`). A caller passing a hex string in that
 * canonical form gets the same string back.
 * @param {string} a `#rgb` or `#rrggbb`
 * @param {string} b `#rgb` or `#rrggbb`
 * @param {number} t
 * @returns {string}
 * @throws {TypeError} when `a` or `b` is not a hex colour
 */
export function lerp(a, b, t) {
  const ra = mustParse(a);
  const rb = mustParse(b);
  const ha = toHex(ra);
  const hb = toHex(rb);
  const u = t > 1 ? 1 : t > 0 ? t : 0;
  if (u === 0 || ha === hb) return ha;
  if (u === 1) return hb;

  const [l1, c1, h1] = rgb8ToOklch(ra);
  const [l2, c2, h2] = rgb8ToOklch(rb);
  const from = c1 < NO_HUE ? h2 : h1;
  const to = c2 < NO_HUE ? h1 : h2;
  let d = wrapDegrees(to - from);
  if (d > 180) d -= 360;
  return oklchToHex(l1 + (l2 - l1) * u, c1 + (c2 - c1) * u, from + d * u);
}
