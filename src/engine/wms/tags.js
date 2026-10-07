// @ts-check
// Tag table (E §5.2 `resolveTag`). A tag is a base kind plus, for the predefined tags of G23, a
// table of default attributes: PLAYBUTTON is a BUTTON that carries four defaults, not a class
// (spec 6.4, 6.6, 6.7, 6.10, 6.13-6.15).
//
// `defaults` holds raw markup strings under lowercase keys, exactly as a skin would write them.
// The builder lays them under the skin's own attributes, and they then go through `classifyValue`
// and `coerce` like any markup, so a default `enabled="wmpenabled:player.controls.play"` becomes a
// live availability binding with no special case. A skin overrides any default by writing the
// attribute.
//
// Tags the engine has no kind for resolve to 'unknown', which the builder keeps as an inert node
// (E D5 scanner rule 6): COLUMN (no ElementKind exists for it), the undocumented `network`,
// `currentmedia`, `currentplaylist`, `bars` and `playerapplication`.

/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {import('../contracts').TagSchema} TagSchema */

/**
 * Read-only in fact, not only in type: a shared Map that one caller mutates would change every
 * later skin's defaults.
 * @param {Array<[string, string]>} entries
 * @returns {ReadonlyMap<string, string>}
 */
function frozenMap(entries) {
  const map = new Map(entries);
  const refuse = () => { throw new TypeError('tag defaults are read-only'); };
  for (const method of ['set', 'delete', 'clear']) Object.defineProperty(map, method, { value: refuse });
  return map;
}

const NO_DEFAULTS = frozenMap([]);

/** @type {Map<string, TagSchema>} */
const TAGS = new Map();

/** @param {string} tag @param {ElementKind} kind @param {Array<[string, string]>} [defaults] */
function add(tag, kind, defaults = []) {
  TAGS.set(tag, Object.freeze({ tag, kind, defaults: defaults.length ? frozenMap(defaults) : NO_DEFAULTS }));
}

// Base tags, one per ElementKind except 'unknown'.
for (const kind of /** @type {ElementKind[]} */ ([
  'theme', 'view', 'subview', 'button', 'buttongroup', 'buttonelement', 'slider', 'customslider', 'progressbar',
  'text', 'effects', 'video', 'playlist', 'equalizersettings', 'videosettings', 'player', 'controls', 'settings',
  'mediacenter', 'automenu', 'listbox', 'popup', 'item', 'editbox',
])) add(kind, kind);

// ---- buttons and button elements (spec 6.4, 6.6) -----------------------------------------------

add('closebutton', 'button', [['onclick', 'jscript:view.close();'], ['uptooltip', 'Close']]);
add('minimizebutton', 'button', [['onclick', 'jscript:view.minimize();'], ['uptooltip', 'Minimize']]);
add('returnbutton', 'button', [['onclick', 'jscript:view.returnToMediaCenter();'], ['uptooltip', 'Return to Full Mode']]);
add('imagebutton', 'button', [['cursor', 'Hand']]);

/**
 * The transport family: a click calls `player.controls.<method>()` and the control is enabled only
 * while `controls.isAvailable(<method>)` says so (spec 6.4 engine note 2).
 * @param {string} method @param {string} tip @returns {Array<[string, string]>}
 */
const transport = (method, tip) => [
  ['onclick', `jscript:player.controls.${method}()`],
  ['uptooltip', tip],
  ['cursor', 'system'],
  ['enabled', `wmpenabled:player.controls.${method}`],
];

/** @type {Array<[string, string, string]>} tag stem, controls method, tooltip */
const TRANSPORT = [
  ['play', 'play', 'Play'], ['pause', 'pause', 'Pause'], ['stop', 'stop', 'Stop'], ['next', 'next', 'Next'],
  ['prev', 'previous', 'Previous'], ['ffwd', 'fastForward', 'Fast Forward'], ['rew', 'fastReverse', 'Fast Reverse'],
];
for (const [stem, method, tip] of TRANSPORT) {
  add(`${stem}button`, 'button', transport(method, tip));
  add(`${stem}element`, 'buttonelement', transport(method, tip));
}
// The SDK page for PLAYELEMENT is filed under the slug `playerelement` (spec 6.6).
add('playerelement', 'buttonelement', transport('play', 'Play'));

/**
 * A sticky toggle bound to a player mode (spec 6.4).
 * @param {string} mode @param {string} noun @returns {Array<[string, string]>}
 */
const modeButton = (mode, noun) => [
  ['onclick', `jscript:player.settings.setMode('${mode}',down);`],
  ['uptooltip', `Turn ${noun} On`],
  ['downtooltip', `Turn ${noun} Off`],
  ['down', `wmpprop:player.settings.getMode('${mode}')`],
  ['sticky', 'true'],
];
add('repeatbutton', 'button', modeButton('loop', 'Repeat'));
add('shufflebutton', 'button', modeButton('shuffle', 'Shuffle'));
add('mutebutton', 'button', [
  ['onclick', 'jscript:player.settings.mute=down;'],
  ['uptooltip', 'Mute'],
  ['downtooltip', 'Sound'],
  ['down', 'wmpprop:player.settings.mute'],
  ['sticky', 'true'],
]);

// ---- sliders (spec 6.7) ------------------------------------------------------------------------

add('balanceslider', 'slider', [
  ['tooltip', 'Balance'], ['max', '100'], ['min', '-100'],
  ['value', 'wmpprop:player.settings.balance'],
  ['value_onchange', 'jscript:player.settings.balance=value;'],
]);
add('seekslider', 'slider', [
  ['tooltip', 'Seek'], ['min', '0'],
  ['max', 'wmpprop:player.currentMedia.duration'],
  ['value', 'wmpprop:player.controls.currentPosition'],
  ['foregroundprogress', 'wmpprop:player.network.downloadProgress'],
  ['useforegroundprogress', 'true'],
  ['ondragend', 'jscript:player.controls.currentPosition=value;'],
]);
add('volumeslider', 'slider', [
  ['tooltip', 'Volume'], ['min', '0'], ['max', '100'],
  ['value', 'wmpprop:player.settings.volume'],
  ['value_onchange', 'jscript:player.settings.volume=value; player.settings.mute=false;'],
]);

// ---- text (spec 6.10) --------------------------------------------------------------------------

add('currentpositiontext', 'text', [
  ['value', 'wmpprop:player.controls.currentPositionString'], ['tabstop', 'true'], ['justification', 'right'],
]);
add('durationtext', 'text', [
  ['value', 'wmpprop:player.currentMedia.DurationString'], ['tabstop', 'true'], ['justification', 'right'],
]);
add('statustext', 'text', [['value', 'wmpprop:player.status'], ['tabstop', 'true']]);
add('tracknametext', 'text', [['value', 'wmpprop:player.currentMedia.name'], ['tabstop', 'true']]);

// ---- playlist, effects, video (spec 6.13-6.15) -------------------------------------------------

add('dropdownplaylist', 'playlist', [['playlistitemsvisible', 'false']]);
add('itemsplaylist', 'playlist', [
  ['backgroundcolor', 'black'], ['columns', 'name=Name;Duration=Time'], ['columnsvisible', 'false'],
  ['dropdownvisible', 'false'], ['foregroundcolor', 'white'],
]);
add('wmpeffects', 'effects', [
  ['horizontalalignment', 'stretch'], ['verticalalignment', 'stretch'], ['height', '200'], ['width', '250'],
  ['tabstop', 'false'], ['onclick', 'next();'],
]);
add('wmpvideo', 'video', [
  ['backgroundcolor', 'black'], ['horizontalalignment', 'stretch'], ['verticalalignment', 'stretch'],
]);

/** Every tag with an entry, for tests and tooling. @returns {string[]} */
export const knownTags = () => [...TAGS.keys()];

/** @type {import('../contracts').ResolveTagFn} */
export const resolveTag = (tag) => {
  const name = String(tag).toLowerCase();
  return TAGS.get(name) ?? Object.freeze({ tag: name, kind: 'unknown', defaults: NO_DEFAULTS });
};
