// @ts-check
// The wmploc shim: what a skin gets from WMP's own resource library, `wmploc.dll`. ENGINE D6.6,
// §5.5; evidence `wmploc 2`, `5`, `7`. Pure: no host objects, no I/O, no ledger. A caller that wants
// a diagnostic reads the `problem` fields below and records `unresolved-res` itself.
//
// Four pieces, in file order:
//   1. the #132 constants themselves (`wmplocConstants`);
//   2. the `res://` resolver (`resolveRes`);
//   3. the `RT_STRING` table (`loadString`, `lookupString`, `resolveStringAttribute`);
//   4. the `RT_TEXT` script libraries a `scriptFile` entry can name (`scriptLibrary`, `parseScriptFile`):
//      #132 constants, #134 font sizes, #136 visualizer requests, #169 `sprintf`.
//
// Names, numbers and the shape of each library are facts read from the DLL and MSDN. The code and the
// string wording are ours: Microsoft's labels cannot ship, so the table below is re-authored and
// only the format syntax of the templates (`%s`, `%1`, `%d%%`) is kept.
//
// Everything keyed by a skin-controlled string is a Map, a Set or a null-prototype record, so a
// skin that names `__proto__` or `constructor` finds nothing (ENGINE §1 rule 6).

/** @typedef {import('../contracts').WmplocConstantsFn} WmplocConstantsFn */
/** @typedef {import('../contracts').ResolveResFn} ResolveResFn */
/** @typedef {import('../contracts').LoadStringFn} LoadStringFn */
/** @typedef {import('../contracts').LookupStringFn} LookupStringFn */
/** @typedef {import('../contracts').ResolveStringAttributeFn} ResolveStringAttributeFn */
/** @typedef {import('../contracts').ParseScriptFileFn} ParseScriptFileFn */
/** @typedef {import('../contracts').ScriptLibraryFn} ScriptLibraryFn */
// The three data types below are the contract's (E §5.5); they stay re-exported from here under the
// same names because the tests and the realm loader read them off this module.
/** @typedef {import('../contracts').WmplocLibrary} WmplocLibrary */
/** @typedef {import('../contracts').ScriptEntry} ScriptEntry */
/** @typedef {import('../contracts').StringProblem} StringProblem */

/** @typedef {Record<string, number | string[]>} GlobalsRecord a null-prototype record of realm globals */

/** @param {GlobalsRecord} fields @returns {GlobalsRecord} */
const record = (fields) => Object.assign(Object.create(null), fields);

// ---------------------------------------------------------------------------------------------
// 1. The #132 constants

// The value of each name is its position. Order is the DLL's (and MSDN's `WMPOpenState` and
// `WMPPlayState`), so do not sort.
const OPEN_STATES = ['Undefined', 'PlaylistChanging', 'PlaylistLocating', 'PlaylistConnecting',
  'PlaylistLoading', 'PlaylistOpening', 'PlaylistOpenNoMedia', 'PlaylistChanged',
  'MediaChanging', 'MediaLocating', 'MediaConnecting', 'MediaLoading', 'MediaOpening',
  'MediaOpen', 'BeginCodecAcquisition', 'EndCodecAcquisition', 'BeginLicenseAcquisition',
  'EndLicenseAcquisition', 'BeginIndividualization', 'EndIndividualization', 'MediaWaiting'];
const PLAY_STATES = ['Undefined', 'Stopped', 'Paused', 'Playing', 'ScanForward', 'ScanReverse',
  'Buffering', 'Waiting', 'MediaEnded', 'Transitioning', 'Ready', 'Reconnecting'];
const PLAYLIST_CHANGE_EVENT_TYPES = ['Unknown', 'Clear', 'InfoChange', 'Move', 'Delete',
  'Insert', 'Append', 'Private', 'NameChange', 'Morph'];

/**
 * The globals of RT_TEXT #132: 21 `os*`, 12 `ps*` and `WMPPlaylistChangeEventTypes`. `extras` (default
 * on) adds `osOpeningUnknownURL` = 21, which MSDN lists and the DLL's table does not; a conformance run
 * turns it off. A fresh null-prototype record each call, so a caller may keep or change it freely.
 * @type {WmplocConstantsFn}
 */
export function wmplocConstants(opts) {
  const extras = opts?.extras ?? true;
  /** @type {GlobalsRecord} */
  const globals = record({});
  OPEN_STATES.forEach((name, value) => { globals['os' + name] = value; });
  PLAY_STATES.forEach((name, value) => { globals['ps' + name] = value; });
  if (extras) globals.osOpeningUnknownURL = 21;
  globals.WMPPlaylistChangeEventTypes = [...PLAYLIST_CHANGE_EVENT_TYPES];
  return globals;
}

// ---------------------------------------------------------------------------------------------
// 2. The `res://` resolver

// `res://<module>/[<type>/]#<id>`. The id is decimal; a runtime-built string such as
// `"res://wmploc/RT_STRING/#" + id` arrives here already joined, so this also runs on those.
const RES_URL = /^res:\/\/([^/]*)\/(?:([A-Za-z_]+)\/)?#(\d+)$/i;
const RES_TYPES = new Set(['RT_TEXT', 'RT_STRING', 'RT_IMAGE', 'RT_BITMAP']);

/**
 * Resolve a `res://` URL to a wmploc resource. The module is matched case-insensitively with a
 * trailing `.dll` dropped, and `wmploc` and `-` name the same library (`wmploc 5.1`); any other
 * module is unresolved. `type` is the upper-cased type name, or `''` when the URL has none (a
 * type-less `#N` names an image or bitmap). Null for anything that is not a wmploc resource.
 * Surrounding whitespace is ignored, since the URL usually comes from an attribute value.
 * @type {ResolveResFn}
 */
export function resolveRes(url) {
  if (typeof url !== 'string') return null;
  const match = RES_URL.exec(url.trim());
  if (!match) return null;
  const moduleName = match[1].toLowerCase().replace(/\.dll$/, '');
  if (moduleName !== 'wmploc' && moduleName !== '-') return null;
  const type = (match[2] ?? '').toUpperCase();
  if (type !== '' && !RES_TYPES.has(type)) return null;
  const id = Number(match[3]);
  // Resource ids are 16-bit in a PE file; a digit string that overflows a double is not an id.
  if (!Number.isSafeInteger(id)) return null;
  return { module: 'wmploc', type, id };
}

// ---------------------------------------------------------------------------------------------
// 3. The RT_STRING table

// The 47 ids the corpus references (`wmploc 5.3`) plus #2091 (`wmploc 7.6`), in our own words. The
// label for each id keeps the job the original does (the same tooltip, title or accessibility hint),
// and a one-word label such as "Close" or "Volume" can only be that word. Three entries are not
// prose at all and must stay what they are: 1888 is a font family, 1910 a scroll direction, 1998 an
// author name.
// Format templates keep their syntax (`%s`, `%1`, `%d%%`) and are returned raw, never formatted.
// 2091 is the one id here that no skin names: #169's position text loads it, and `theme.loadString`
// must answer it as the DLL does.
// 2063 is the buffering line, not the "disconnected" one a skin author evidently wanted (the
// ids are the DLL's, `wmploc 5.4`), and its `%d%%` is left for the skin to show as it stands.
/** @type {Map<number, string>} */
const STRINGS = new Map([
  [217, 'Playlist'],
  [1273, 'Quick access'],
  [1807, 'Mute sound'],                    // up state of the mute toggle
  [1808, 'Sound on'],                      // down state of the mute toggle
  [1809, 'Seek'],
  [1810, 'Volume'],
  [1811, 'Minimize'],
  [1812, 'Close'],
  [1813, 'Go to full mode'],
  [1814, 'Enable shuffle'],
  [1815, 'Disable shuffle'],
  [1816, 'Enable repeat'],
  [1817, 'Disable repeat'],
  [1827, 'SRS WOW'],
  [1845, 'Balance'],
  [1846, 'On'],
  [1848, 'Graphic EQ'],
  [1849, 'Video options'],
  [1851, 'Off'],
  [1888, 'Arial'],                         // a font family: always a usable face
  [1910, 'left'],                          // a scroll direction word
  [1998, 'Microsoft Corporation'],         // theme author
  [1999, 'Copyright Microsoft Corporation. All rights reserved.'],
  [2063, 'Buffering %d%%'],                // raw template, see above
  [2066, '%sKbps'],
  [2077, 'Content is protected'],
  [2078, 'Verified content from %s'],
  [2079, 'Excellent reception'],
  [2080, 'Network congested'],
  [2081, 'Weak reception'],
  [2086, '%1, %2'],                        // positional: chapter, title
  [2091, '%1 / %2'],                       // positional: position, duration (`g_kPositionFormatString`)
  [2092, 'Network too busy, playing at reduced quality'],
  [2097, 'Playing an HDCD audio CD'],
  [2098, 'HDCD disc detected'],
  [2099, '%s% done'],                      // a `%s`, then a literal percent sign
  [2108, 'Use the Right or Up arrow to raise, the Left or Down arrow to lower'],
  [2109, 'Seek'],
  [2110, 'Volume'],
  [2114, 'Press Space or Enter'],
  [2130, 'Mute'],
  [2150, 'Currently playing menu'],
  [3904, 'Full view'],
  [3905, 'Open volume slider'],
  [3906, 'Enable graphic EQ'],
  [3907, 'Disable graphic EQ'],
  [3908, 'Graphic EQ on or off'],
  [3909, 'Presets'],
]);

/** Every id the string table holds, ascending. */
export const STRING_IDS = Object.freeze([...STRINGS.keys()]);

/**
 * Look a `res://` string up and say why it came back empty, for the caller's ledger. Only an
 * `RT_STRING` URL names a string: a type-less `#N` is an image or bitmap.
 * @type {LookupStringFn}
 */
export function lookupString(url) {
  const res = resolveRes(url);
  if (!res) return { text: '', problem: 'unresolved' };
  if (res.type !== 'RT_STRING') return { text: '', problem: 'wrong-type' };
  const text = STRINGS.get(res.id);
  return text === undefined ? { text: '', problem: 'unknown-id' } : { text, problem: null };
}

/**
 * `theme.loadString(url)`: the text, or `''` for anything unresolved (`wmploc 7.7`).
 * @type {LoadStringFn}
 */
export function loadString(url) {
  return lookupString(url).text;
}

// The attributes whose value a `res://` string replaces (`wmploc 7.7`(b)), lower-cased because
// attribute names are matched case-insensitively. The accessibility pair need not render but the
// resolved text is kept for a later ARIA label.
const STRING_ATTRIBUTES = new Set(['tooltip', 'uptooltip', 'downtooltip', 'value', 'accname',
  'acckeyboardshortcut', 'fontface', 'scrollingdirection', 'author', 'copyright']);
// What an unresolved string becomes. Blank is right for text; a blank face or direction is not
// the same as the default (`wmploc 5.4`).
const ATTRIBUTE_FALLBACKS = new Map([['fontface', 'Arial'], ['scrollingdirection', 'left']]);

/**
 * The value an element attribute should hold. Resolves a bare `res://` URL assigned to one of the
 * string attributes (at parse time, or when script assigns it); any other name or value comes back
 * untouched. An unresolved URL becomes `''`, or the default face or direction for those two.
 * `attribute` is the attribute name in any case.
 * @type {ResolveStringAttributeFn}
 */
export function resolveStringAttribute(attribute, value) {
  const name = String(attribute).toLowerCase();
  if (typeof value !== 'string' || !STRING_ATTRIBUTES.has(name) || !/^\s*res:\/\//i.test(value)) {
    return { value, problem: null };
  }
  const { text, problem } = lookupString(value);
  return { value: problem ? ATTRIBUTE_FALLBACKS.get(name) ?? '' : text, problem };
}

// ---------------------------------------------------------------------------------------------
// 4. The RT_TEXT script libraries

/**
 * The reference `sprintf` of RT_TEXT #169 (`wmploc 7.6`). A string `s` replaces every `%s`; anything
 * else is walked in order with a counter from 1, and each member replaces the first
 * case-insensitive `%<counter>` left in the text, so a member that contains `%2` is seen by the
 * next round. A number or `undefined` leaves `str` alone. The replacement is taken literally (a
 * `$&` in a track title stays a `$&`).
 * The realm cannot import this file, so `SPRINTF_LIBRARY_SOURCE` ships the same function as text; the test
 * runs both on the same cases.
 * @param {string} str
 * @param {*} s
 * @returns {string}
 */
export function sprintf(str, s) {
  if (typeof s === 'string') return str.replace(/%s/g, () => s);
  let index = 1;
  for (const key in s) {
    const value = String(s[key]);
    str = str.replace(new RegExp('%' + index, 'i'), () => value);
    index++;
  }
  return str;
}

// Realm-side text of RT_TEXT #169: global code, run like a skin script. `String.prototype.sprintf`
// ignores its receiver (`sz.sprintf(fmt, arg)` formats `fmt`), as the DLL's does. The position text
// reads `player` and `osMediaOpen`, which the realm has by then. `g_kPositionFormatString` is the
// literal the DLL loads from RT_STRING #2091.
/** The realm-side text of the #169 library. */
export const SPRINTF_LIBRARY_SOURCE = `var g_kPositionFormatString = "%1 / %2";
function sprintf(str, s) {
  if (typeof s === "string") return str.replace(/%s/g, function () { return s; });
  var index = 1;
  for (var key in s) {
    var value = String(s[key]);
    str = str.replace(new RegExp("%" + index, "i"), function () { return value; });
    index++;
  }
  return str;
}
String.prototype.sprintf = function (fmt, s) { return sprintf(fmt, s); };
function WMPStringsFunction_GetPositionText() {
  var position = player.controls.currentPositionString;
  if (!position) return "";
  var media = player.currentMedia;
  if (player.openState == osMediaOpen && media && media.duration > 0) {
    return sprintf(g_kPositionFormatString, [position, media.durationString]);
  }
  return position;
}
`;

/**
 * Builders for the libraries a `scriptFile` entry can name, keyed by RT_TEXT id (a number, from
 * digits only). Every other RT_TEXT id is a built-in skin script that drives elements we do not
 * have (`wmploc 2.3`): not shipped.
 * @type {Array<[number, (opts?: { extras?: boolean }) => WmplocLibrary]>}
 */
const LIBRARY_BUILDERS = [
  [132, (opts) => ({ id: 132, install: 'before-scripts', constants: wmplocConstants(opts), source: '' })],
  [134, () => ({
    id: 134, install: 'when-listed', source: '',
    constants: record({ g_kSMALL_FONTSIZE: 8, g_kMEDIUM_FONTSIZE: 9 }),
  })],
  [136, () => ({
    id: 136, install: 'when-listed', source: '',
    constants: record({ VR_PRESET_PREV: 1, VR_PRESET_NEXT: 2, VR_VIZ_PREV: 3, VR_VIZ_NEXT: 4, VR_EXIT_PLAYER: 999 }),
  })],
  [169, () => ({ id: 169, install: 'when-listed', constants: record({}), source: SPRINTF_LIBRARY_SOURCE })],
];
const LIBRARIES = new Map(LIBRARY_BUILDERS);

/**
 * The library an `RT_TEXT` URL names (e.g. `res://wmploc.dll/RT_TEXT/#132`), or null. A fresh object
 * each call. `opts` goes to `wmplocConstants` for #132.
 * @type {ScriptLibraryFn}
 */
export function scriptLibrary(url, opts) {
  const res = resolveRes(url);
  if (!res || res.type !== 'RT_TEXT') return null;
  return LIBRARIES.get(res.id)?.(opts) ?? null;
}

/**
 * Split a VIEW's `scriptFile` value into load steps, in list order (`wmploc 7.3`). Entries are
 * split on `;`, trimmed, and empty ones dropped (391 of 433 #132 values end in a stray `;`). A
 * `res://` entry is a library or an `unknown-res` the loader skips with a warning; its siblings still
 * load. A plain entry is a script path: whether the archive holds it is the loader's question, and a
 * missing one must not fail the load. With `stem` (the `.wms` file's base name), `<stem>.js` is
 * appended as an implicit entry unless an entry already names it, case-insensitively.
 * @type {ParseScriptFileFn}
 */
export function parseScriptFile(value, opts) {
  /** @type {ScriptEntry[]} */
  const entries = [];
  for (const piece of (typeof value === 'string' ? value : '').split(';')) {
    const entry = piece.trim();
    if (!entry) continue;
    if (/^res:\/\//i.test(entry)) {
      const library = scriptLibrary(entry);
      entries.push(library ? { kind: 'library', url: entry, library } : { kind: 'unknown-res', url: entry });
    } else {
      entries.push({ kind: 'script', path: entry });
    }
  }
  const stem = opts?.stem;
  if (stem) {
    const implicit = `${stem}.js`;
    const listed = entries.some((e) => e.kind === 'script' && e.path.toLowerCase() === implicit.toLowerCase());
    if (!listed) entries.push({ kind: 'script', path: implicit, implicit: true });
  }
  return entries;
}
