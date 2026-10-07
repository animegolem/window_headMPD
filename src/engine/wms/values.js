// @ts-check
// Value classes, colours and coercion (E §5.2 `classifyValue`, `parseColor`, `coerce`; E D5 value
// classes and coercion; spec 2.4, 3.1-3.4).
//
// A skin attribute is one of: a literal, `jscript:` (evaluated once, in source order), `wmpprop:`
// (a live one-way binding), `wmpenabled:` / `wmpdisabled:` (availability of a Controls method),
// `res://` (a localisation-library resource) or a handler. `classifyValue` decides which, once per
// attribute. It never evaluates anything: the builder, the layout pass and the binding engine act
// on the result.
//
// `classifyValue` does not look at whether an attribute is known. A caller consults `attrSpec`
// first, because an unknown attribute has no behaviour (G12) and its `jscript:` text must not run.

import { PLAYER_EVENTS, SYSTEM_COLORS, attrSpec } from './attrs.js';

/** @typedef {import('../contracts').AttrSource} AttrSource */
/** @typedef {import('../contracts').AttrType} AttrType */
/** @typedef {import('../contracts').BindPath} BindPath */
/** @typedef {import('../contracts').BindSegment} BindSegment */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {import('../contracts').Rgb} Rgb */

// ---- colours (spec 3.1) -----------------------------------------------------------------------

// The 140 names of the WMP colour reference, as `name rrggbb` pairs. The reference spells
// `lightgrey` with an e and every other grey with an a; IE takes both spellings, so the other
// seven are added below. (The reference prints darkseagreen as 8FBC8B, one digit off the standard
// and off every browser; the table has the standard 8FBC8F.)
const NAMED_COLORS = `
  aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff
  beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff
  blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00
  chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c
  cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9
  darkgreen 006400 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00
  darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b
  darkslategray 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff
  dimgray 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22
  fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520
  gray 808080 green 008000 greenyellow adff2f honeydew f0fff0 hotpink ff69b4
  indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa
  lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080
  lightcyan e0ffff lightgoldenrodyellow fafad2 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1
  lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightsteelblue b0c4de
  lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff
  maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db
  mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585
  midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead
  navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500
  orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee
  palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb
  plum dda0dd powderblue b0e0e6 purple 800080 red ff0000 rosybrown bc8f8f
  royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57
  seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd
  slategray 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c
  teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee
  wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32
`;

/** @type {Map<string, number>} */
const NAMED = new Map();
{
  const words = NAMED_COLORS.trim().split(/\s+/);
  for (let i = 0; i < words.length; i += 2) NAMED.set(words[i], parseInt(words[i + 1], 16));
  for (const [grey, gray] of [
    ['lightgray', 'lightgrey'], ['darkgrey', 'darkgray'], ['dimgrey', 'dimgray'], ['grey', 'gray'],
    ['slategrey', 'slategray'], ['darkslategrey', 'darkslategray'], ['lightslategrey', 'lightslategray'],
  ]) NAMED.set(grey, /** @type {number} */ (NAMED.get(gray)));
}

const HEX = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/;

/**
 * `#RRGGBB`, `#RGB` (U-29; IE accepts it), the 140 IE names (plus the other grey spellings and a
 * few system names), `none`, `auto`. Case-insensitive, surrounding blanks ignored. Anything else is
 * null, and the caller keeps the previous value (U-20).
 * @type {import('../contracts').ParseColorFn}
 */
export const parseColor = (s) => {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (t === 'none') return 'none';
  if (t === 'auto') return 'auto';
  if (t.charCodeAt(0) === 0x23) {
    const m = HEX.exec(t);
    if (!m) return null;
    if (m[2]) return parseInt(m[2], 16);
    const [r, g, b] = m[1];
    return parseInt(r + r + g + g + b + b, 16);
  }
  // Maps, not objects: `constructor` and `__proto__` must not find an inherited member.
  return NAMED.get(t) ?? SYSTEM_COLORS.get(t) ?? null;
};

// ---- coercion (spec 2.4, 3.1; U-20, U-22) -----------------------------------------------------

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/**
 * A finite number from a number or from numeric text (`'600 '` is 600, `'-1'` is -1: U-22). Blank
 * text, booleans and null are not numbers here, although `Number()` would accept them.
 * @param {unknown} v @returns {number | null}
 */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return NUMBER.test(t) ? Number(t) : null;
}

/**
 * Round half to even, which is what OLE's double-to-long conversion does and so, presumably, what
 * WMP's script host does for a `long` property (unconfirmed).
 * @param {number} n
 */
function roundHalfEven(n) {
  const floor = Math.floor(n);
  const diff = n - floor;
  if (diff !== 0.5) return diff < 0.5 ? floor : floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Coerce an assigned or literal value to an attribute's type. An invalid value returns `prev`
 * (U-20; the docs say so on many pages). Typed values pass through, so coercing twice is harmless.
 * Ranges are not checked here: `value` out of `min..max` is the object model's rule.
 *  - int, float: a finite number, or numeric text; int is rounded.
 *  - bool: true/false/1/0 in any case, as boolean, number or text. `'ture'` keeps `prev`.
 *  - string, image, handler: text; numbers and booleans become their text.
 *  - color: an Rgb number from 0 to 0xFFFFFF, or text that `parseColor` accepts.
 *  - cursor: a `.cur`/`.ani` file name as written, otherwise the name lowercased. The nine
 *    documented names (system, hand, help, sizeall, sizenesw, sizens, sizenwse, sizewe, uparrow)
 *    and unknown ones alike: the renderer maps `sizetopright` to the nearest cursor (U-21).
 *  - enum: a member, matched case-insensitively and returned in its own spelling.
 * @type {import('../contracts').CoerceFn}
 */
export const coerce = (type, v, prev) => {
  if (typeof type === 'object' && type !== null) {
    if (typeof v !== 'string') return prev;
    const t = v.trim().toLowerCase();
    return type.enum.find((m) => m.toLowerCase() === t) ?? prev;
  }
  switch (type) {
    case 'int': {
      const n = toNumber(v);
      return n === null ? prev : roundHalfEven(n) + 0; // + 0 turns -0 into 0
    }
    case 'float': {
      const n = toNumber(v);
      return n === null ? prev : n;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : prev;
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase();
        if (t === 'true' || t === '1') return true;
        if (t === 'false' || t === '0') return false;
      }
      return prev;
    case 'string':
    case 'image':
    case 'handler':
      if (typeof v === 'string') return v;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
      return prev;
    case 'color': {
      if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : prev;
      const c = parseColor(/** @type {string} */ (v));
      return c === null ? prev : c;
    }
    case 'cursor': {
      if (typeof v !== 'string') return prev;
      const t = v.trim();
      if (/\.(?:cur|ani)$/i.test(t)) return t;
      return t.toLowerCase();
    }
    default:
      return prev;
  }
};

// ---- `wmpprop:` paths (E D5 bindings) ---------------------------------------------------------

const MAX_PATH_CHARS = 512;
const MAX_SEGMENTS = 16;
const MAX_ARGS = 8;
const IDENT_AT = /[A-Za-z_$][\w$]*/y;
const NUMBER_AT = /[+-]?\d+(?:\.\d+)?/y;

/**
 * The `wmpprop:` grammar: `segment ('.' segment)* ';'?` with
 * `segment = ident | ident '(' literal (',' literal)* ')'`, a literal being a quoted string, a
 * number or true/false. Blanks between tokens are ignored. The root takes no call, because a
 * BindPath root is a name. Null when the text is not a path.
 *
 * This is the one `wmpprop:` grammar: bind/paths.js `parsePath` (W3.2) delegates here and adds
 * its own caps, so `classifyValue` and the binding engine can never disagree on what a path is.
 * @type {import('../contracts').ParseBindPathFn}
 */
export function parseBindPath(src) {
  if (src.length > MAX_PATH_CHARS) return null;
  let i = 0;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  /** @returns {string | null} */
  const ident = () => {
    IDENT_AT.lastIndex = i;
    const m = IDENT_AT.exec(src);
    if (!m) return null;
    i = IDENT_AT.lastIndex;
    return m[0];
  };
  /** @returns {{ ok: true, value: string | number | boolean } | { ok: false }} */
  const literal = () => {
    const c = src[i];
    if (c === "'" || c === '"') {
      let out = '';
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\' && j + 1 < src.length) out += src[++j];
        else if (src[j] === c) { i = j + 1; return { ok: true, value: out }; }
        else out += src[j];
      }
      return { ok: false };
    }
    NUMBER_AT.lastIndex = i;
    const n = NUMBER_AT.exec(src);
    if (n) { i = NUMBER_AT.lastIndex; return { ok: true, value: Number(n[0]) }; }
    const word = ident();
    if (word === null) return { ok: false };
    const lower = word.toLowerCase();
    if (lower === 'true' || lower === 'false') return { ok: true, value: lower === 'true' };
    return { ok: false };
  };
  /** @returns {BindSegment | null} */
  const segment = () => {
    const name = ident();
    if (name === null) return null;
    skip();
    if (src[i] !== '(') return { name };
    i++;
    /** @type {Array<string | number | boolean>} */
    const args = [];
    skip();
    if (src[i] === ')') { i++; return { name, args }; }
    for (;;) {
      skip();
      const lit = literal();
      if (!lit.ok || args.length >= MAX_ARGS) return null;
      args.push(lit.value);
      skip();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ')') { i++; return { name, args }; }
      return null;
    }
  };

  skip();
  const root = segment();
  if (root === null || root.args) return null;
  /** @type {BindSegment[]} */
  const segments = [];
  skip();
  while (src[i] === '.') {
    i++;
    skip();
    const seg = segment();
    if (seg === null || segments.length >= MAX_SEGMENTS) return null;
    segments.push(seg);
    skip();
  }
  if (src[i] === ';') { i++; skip(); }
  return i === src.length ? { root: root.name, segments } : null;
}

// ---- classification ---------------------------------------------------------------------------

const JSCRIPT = /^\s*jscript:/i;
const WMPPROP = /^\s*wmpprop:/i;
const WMPAVAIL = /^\s*(wmpenabled|wmpdisabled):/i;
const RES = /^\s*res:\/\//i;
const WMP_WORD = /^\s*(wmp[a-z]*)\s*:/i;
const METHOD = /^[a-z_$][\w$]*$/i;
const KNOWN_PREFIXES = ['wmpprop', 'wmpenabled', 'wmpdisabled'];

/** @param {string} a @param {string} b */
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Clip skin text before it goes into a diagnostic. @param {string} s */
const clip = (s) => (s.length > 60 ? s.slice(0, 57) + '...' : s);

/**
 * The parameter names a handler attribute exposes, or null when the attribute is not a handler.
 * Handlers are `on*`, `<attr>_onchange`, and on a PLAYER its bare event names (with or without
 * `on`). Only PLAYER events have parameters, in exact case (spec 2.2).
 * @param {ElementKind} kind @param {string} name lowercase
 * @returns {string[] | null}
 */
function handlerParams(kind, name) {
  if (kind === 'player') {
    const event = PLAYER_EVENTS.get(name) ?? (name.startsWith('on') ? PLAYER_EVENTS.get(name.slice(2)) : undefined);
    if (event) return [...event.params];
  }
  if (/^on[a-z]/.test(name)) return [];
  if (name.length > 9 && name.endsWith('_onchange')) return [];
  return null;
}

/**
 * `classifyValue` plus the diagnostic the contract's signature has no room for: a near-miss of a
 * binding prefix (`wmppprop:`, `wmpenable:`, 18 skins, G14) or a `wmpprop:` that is not a path
 * comes back as a literal and carries a diagnostic the builder files against the element.
 * @type {import('../contracts').ClassifyValueDiagFn}
 */
export function classifyValueDiag(kind, attr, raw) {
  const name = String(attr).toLowerCase();
  const text = String(raw);

  // Handlers are never classified: they compile as script. A leading `jscript:` or `wmpprop:` is
  // a statement label there, valid and inert (spec 2.3, U-6), so the text is kept as written.
  const params = handlerParams(kind, name);
  if (params) return { source: { kind: 'handler', source: text, params }, diagnostic: null };

  /** @param {Diagnostic | null} diagnostic @returns {{ source: AttrSource, diagnostic: Diagnostic | null }} */
  const literal = (diagnostic) => ({ source: { kind: 'literal', text }, diagnostic });

  if (JSCRIPT.test(text)) return { source: { kind: 'jscript', source: text.replace(JSCRIPT, '').trim() }, diagnostic: null };

  if (WMPPROP.test(text)) {
    const path = parseBindPath(text.replace(WMPPROP, ''));
    if (path) return { source: { kind: 'wmpprop', path }, diagnostic: null };
    return literal({ code: 'invalid-binding-path', severity: 'warn', detail: `${name}="${clip(text)}" is not a wmpprop: path` });
  }

  const avail = WMPAVAIL.exec(text);
  if (avail) {
    // U-4: the last dotted segment, without `()` or `;`, case-folded.
    const rest = text.slice(avail[0].length).replace(/[;\s]+$/, '').replace(/\(\s*\)$/, '');
    const method = rest.slice(rest.lastIndexOf('.') + 1).trim().toLowerCase();
    if (METHOD.test(method)) {
      return { source: { kind: /** @type {'wmpenabled' | 'wmpdisabled'} */ (avail[1].toLowerCase()), method }, diagnostic: null };
    }
    return literal({ code: 'invalid-availability-name', severity: 'warn', detail: `${name}="${clip(text)}" names no Controls method` });
  }

  if (RES.test(text)) {
    // D5: `res://` is resolved in string attributes. scriptFile is a `;` list whose entries may be
    // `res://` URLs, so the loader splits it and the value stays text. Images are included because
    // 9SeriesDefault names RT_IMAGE and RT_BITMAP resources there; they resolve to nothing.
    const type = attrSpec(kind, name)?.type;
    if ((type === 'string' || type === 'image') && name !== 'scriptfile') {
      return { source: { kind: 'res', url: text.trim() }, diagnostic: null };
    }
    return literal(null);
  }

  const word = WMP_WORD.exec(text)?.[1].toLowerCase();
  if (word && !KNOWN_PREFIXES.includes(word)) {
    const nearest = KNOWN_PREFIXES.find((p) => editDistance(word, p) <= 2);
    if (nearest) {
      return literal({ code: 'misspelled-prefix', severity: 'warn', detail: `${name}="${clip(text)}" starts with ${word}:, probably ${nearest}:; kept as text` });
    }
  }
  return literal(null);
}

/** @type {import('../contracts').ClassifyValueFn} */
export const classifyValue = (kind, attr, raw) => classifyValueDiag(kind, attr, raw).source;
