// @ts-check
// What the renderer lets a skin say in a style (E D2 "Strings, fonts, cursors"): font families, sizes
// and flags, colours, cursor keywords and the one sidecar style. Pure; every value that reaches a CSS
// property from skin text goes through one of these, and none of them can produce markup, a URL or a
// second declaration.

/** The tail every font stack ends with (parity D22): the oracle's body font. */
export const FALLBACK_FAMILY = 'Tahoma, Verdana, sans-serif';

/** One family name as skins write it: letters, digits, spaces and a few separators. */
const FAMILY = /^[A-Za-z0-9 ._-]{1,64}$/;

/** More families than this in one `fontFace` are ignored; a skin string is not a place for a long list. */
const MAX_FAMILIES = 8;

/**
 * The CSS `font-family` value for a skin's `fontFace`: the comma-separated names that pass `FAMILY`,
 * each quoted, followed by the fallback stack (G27, parity D22). A name that does not pass is dropped,
 * never repaired, so no quote, backslash, brace or `url(` can reach the stylesheet.
 * @param {unknown} face
 * @returns {string}
 */
export function fontFamilyCss(face) {
  const names = [];
  if (typeof face === 'string') {
    for (const part of face.split(',', MAX_FAMILIES * 4)) {
      const name = part.trim();
      if (FAMILY.test(name) && names.length < MAX_FAMILIES) names.push(`"${name}"`);
    }
  }
  names.push(FALLBACK_FAMILY);
  return names.join(', ');
}

/** The largest and smallest text a skin can ask for, in CSS px. */
const MIN_FONT_PX = 1;
const MAX_FONT_PX = 512;

/**
 * Points to CSS px: `round(pt * 4 / 3)` (7 pt is 9 px, parity G8), clamped so a hostile size cannot
 * make a node larger than the canvas caps allow.
 * @param {unknown} pt
 * @returns {number}
 */
export function fontPx(pt) {
  const n = typeof pt === 'number' && Number.isFinite(pt) ? pt : 10;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round((n * 4) / 3)));
}

/**
 * `fontStyle` is a space-separated subset of Bold Italic Underline Strikeout, or Normal, and Normal
 * wins over everything (spec 6.10).
 * @typedef {{ bold: boolean, italic: boolean, underline: boolean, strikeout: boolean }} FontFlags
 * @param {unknown} style
 * @returns {FontFlags}
 */
export function fontFlags(style) {
  const flags = { bold: false, italic: false, underline: false, strikeout: false };
  if (typeof style !== 'string') return flags;
  const words = style.toLowerCase().split(/[\s,]+/, 16);
  if (words.includes('normal')) return flags;
  flags.bold = words.includes('bold');
  flags.italic = words.includes('italic');
  flags.underline = words.includes('underline');
  flags.strikeout = words.includes('strikeout');
  return flags;
}

/**
 * The `text-decoration-line` for a flag set.
 * @param {FontFlags} f
 * @returns {string}
 */
export function decorationCss(f) {
  const parts = [];
  if (f.underline) parts.push('underline');
  if (f.strikeout) parts.push('line-through');
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * `#rrggbb` for an Rgb number; null for anything else (`none`, `auto`, unset). Only the low 24 bits
 * are used, and the digits are the only thing that reaches CSS.
 * @param {unknown} c
 * @returns {string | null}
 */
export function rgbCss(c) {
  return typeof c === 'number' && Number.isFinite(c) ? `#${(Math.trunc(c) & 0xffffff).toString(16).padStart(6, '0')}` : null;
}

/**
 * The documented cursor names, then the `size*` family IE skins use (the corpus has `sizetopright`
 * 24 times, U-21), as CSS keywords. A Map: a cursor name is skin text.
 * @type {ReadonlyMap<string, string>}
 */
const CURSORS = new Map([
  ['system', 'default'],
  ['hand', 'pointer'],
  ['help', 'help'],
  ['sizeall', 'move'],
  ['sizenesw', 'nesw-resize'],
  ['sizens', 'ns-resize'],
  ['sizenwse', 'nwse-resize'],
  ['sizewe', 'ew-resize'],
  ['uparrow', 'n-resize'],
  ['sizetopright', 'nesw-resize'],
  ['sizebottomleft', 'nesw-resize'],
  ['sizetopleft', 'nwse-resize'],
  ['sizebottomright', 'nwse-resize'],
  ['sizetop', 'ns-resize'],
  ['sizebottom', 'ns-resize'],
  ['sizeleft', 'ew-resize'],
  ['sizeright', 'ew-resize'],
]);

/**
 * A skin's `cursor` as a CSS keyword. null for a name with no keyword (including `.cur` and `.ani`
 * files, which are phase 3): the caller keeps the cursor it already shows (U-21).
 * @param {unknown} name
 * @returns {string | null}
 */
export function cursorCss(name) {
  if (typeof name !== 'string') return null;
  return CURSORS.get(name.trim().toLowerCase()) ?? null;
}

/**
 * The one sidecar style, `letterSpacing` (E D10.6): a short signed decimal in px. The sidecar loader
 * validates it too; the renderer does not rely on that.
 * @param {unknown} v
 * @returns {string | null}
 */
export function letterSpacingCss(v) {
  return typeof v === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?px$/.test(v) ? v : null;
}
