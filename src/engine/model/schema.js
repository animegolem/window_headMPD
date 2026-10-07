// @ts-check
// The object-model schema (E D6, §5.5 `SCHEMA`, `MemberSpec`). One table per class says which members
// a skin can reach, what they are worth (live, emulated, stub, denied), and which policy and change
// source applies. The membrane's `has` sets (via `classMembers`), the binding resolver, the stub
// generator, the per-API policies and the coverage ledger all read this table and nothing else, so a
// member that is not here does not exist for a skin: a get returns undefined, a set is dropped, and
// the ledger records an `unknown-member`.
//
// Case-insensitivity is structural. Keys are lowercased once, here, and callers lowercase a name
// before the lookup. Every table is a Map, so a skin that reads `constructor` or `__proto__` finds
// nothing (E §1 rule 6). Element classes derive from the attribute tables of wms/attrs.js, so
// `xPlTt.tooltip` reaches `toolTip` through the same mechanism as `player.OpenState`.
//
// impl:
//   live       the member reads or writes real state (the media model, the DSP, the element model)
//   emulated   a value we synthesise from live state (status strings, the mute emulation, time text),
//              or a documented no-op that WMP skins rely on (setColumnResizeMode)
//   stub       a type-correct inert value (`stubValue`, else the zero of the type); the ledger counts it
//   denied     writes and calls are refused by a policy and ledgered once; a read, if any, still works
//
// changeSource vocabulary (what `ObjectGraph.changeSource(path)` subscribes to; W3.2 reads this):
//   media.state     connected, playState, song, queueLength, error     playState, openState, status
//   media.position  elapsed, playState, song, duration                 currentPosition and its string;
//                                                                      `read()` is live (extrapolated)
//   media.duration  duration, song                                     currentMedia.duration
//   media.song      song                                               currentMedia, name, sourceURL
//   media.volume    volume                                             settings.volume
//   media.mode      repeat, random                                     settings.getMode
//   media.queue     queueLength, queueVersion                          currentPlaylist.count
//   media.bitrate   bitrateKbps                                        network.bitRate
//   media.avail     connected, playState, song, duration, queueLength  controls.isAvailable
//   settings.mute   the emulated mute flag
//   dsp.eq          equalizer gains and bypass
//   dsp.balance     the balance (also fires when a detent snapped the written value)
//   mediacenter     one source per key, `mediacenter.<key>`
//   effects         the EFFECTS element's EffectsControl
//   (none)          a constant, or an element attribute: an element attribute changes with the model
//                   (`ViewModel.onChange`), and needs no entry here

/** @typedef {import('../contracts').MemberSpec} MemberSpec */
/** @typedef {import('../contracts').ClassSchema} ClassSchema */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {import('../contracts').AttrSpec} AttrSpec */
/** @typedef {import('../contracts').MemberImpl} MemberImpl */

import { attrSpec, attrSpecsOf } from '../wms/attrs.js';

// ---- constructors ---------------------------------------------------------------------------------

/**
 * @param {string} name @param {MemberSpec['type']} type @param {'r' | 'rw'} access @param {MemberImpl} impl
 * @param {Partial<MemberSpec>} [extra]
 * @returns {MemberSpec}
 */
const prop = (name, type, access, impl, extra = {}) => ({ name, kind: 'prop', type, access, impl, ...extra });

/** @param {string} name @param {MemberSpec['type']} type @param {MemberImpl} impl @param {Partial<MemberSpec>} [extra] @returns {MemberSpec} */
const method = (name, type, impl, extra = {}) => ({ name, kind: 'method', type, impl, ...extra });

/** A Map no caller can change: a shared table that one skin's code could edit would reach every later skin. @param {Array<[string, any]>} entries */
function frozenMap(entries) {
  const map = new Map(entries);
  const refuse = () => { throw new TypeError('the schema is read-only'); };
  for (const m of ['set', 'delete', 'clear']) Object.defineProperty(map, m, { value: refuse });
  return map;
}

/** @param {MemberSpec[]} members @returns {ClassSchema} keyed by the lowercased name; a repeated name is a bug */
function classOf(members) {
  /** @type {Array<[string, MemberSpec]>} */
  const rows = [];
  const seen = new Set();
  for (const m of members) {
    const key = m.name.toLowerCase();
    if (seen.has(key)) throw new Error(`schema: duplicate member ${m.name}`);
    seen.add(key);
    rows.push([key, Object.freeze(m)]);
  }
  return frozenMap(rows);
}

/** Later members replace earlier ones of the same name (an overlay on a derived table). @param {MemberSpec[]} base @param {MemberSpec[]} extra */
function overlay(base, extra) {
  const names = new Set(extra.map((m) => m.name.toLowerCase()));
  return [...base.filter((m) => !names.has(m.name.toLowerCase())), ...extra];
}

// ---- player ---------------------------------------------------------------------------------------

/** The five collection-like members of `player` that are inert objects (E D6 mapping table). */
export const INERT_PLAYER_OBJECTS = Object.freeze(['mediaCollection', 'playlistCollection', 'cdromCollection', 'dvd']);

/** @type {MemberSpec[]} */
const PLAYER = [
  prop('playState', 'number', 'r', 'emulated', { changeSource: 'media.state' }),
  prop('openState', 'number', 'r', 'emulated', { changeSource: 'media.state' }),
  prop('status', 'string', 'r', 'emulated', { changeSource: 'media.state' }),
  // Reads the current file; a write is refused: the user owns the MPD queue (D6.5).
  prop('URL', 'string', 'rw', 'denied', { changeSource: 'media.song', policy: 'deny-log' }),
  prop('controls', 'object', 'r', 'live'),
  prop('settings', 'object', 'r', 'live'),
  prop('currentMedia', 'object', 'r', 'live', { changeSource: 'media.song' }),
  prop('network', 'object', 'r', 'live'),
  prop('currentPlaylist', 'object', 'r', 'live', { changeSource: 'media.queue' }),
  prop('versionInfo', 'string', 'r', 'live'),
  prop('fullScreen', 'bool', 'rw', 'stub', { stubValue: false }),
  method('launchURL', 'void', 'denied', { policy: 'deny-log' }),
  ...INERT_PLAYER_OBJECTS.map((n) => prop(n, 'object', 'r', 'stub')),
  method('newPlaylist', 'object', 'stub'),
  prop('uiMode', 'string', 'rw', 'stub', { stubValue: 'none' }),
  prop('enableContextMenu', 'bool', 'rw', 'stub', { stubValue: true }),
  prop('isOnline', 'bool', 'r', 'stub', { stubValue: true }),
  prop('isRemote', 'bool', 'r', 'stub', { stubValue: false }),
  method('close', 'void', 'stub'),
];

/** @type {MemberSpec[]} */
const CONTROLS = [
  method('play', 'void', 'live', { policy: 'rate-mpd' }),
  method('pause', 'void', 'live', { policy: 'rate-mpd' }),
  method('stop', 'void', 'live', { policy: 'rate-mpd' }),
  method('next', 'void', 'live', { policy: 'rate-mpd' }),
  method('previous', 'void', 'live', { policy: 'rate-mpd' }),
  prop('currentPosition', 'number', 'rw', 'live', { changeSource: 'media.position', policy: 'rate-mpd' }),
  prop('currentPositionString', 'string', 'r', 'emulated', { changeSource: 'media.position' }),
  method('isAvailable', 'bool', 'emulated', { changeSource: 'media.avail' }),
  prop('currentItem', 'object', 'r', 'live', { changeSource: 'media.song' }),
  // MPD has no scan, no markers, no audio languages: inert (E D6 mapping table).
  method('fastForward', 'void', 'stub'),
  method('fastReverse', 'void', 'stub'),
  method('step', 'void', 'stub'),
  method('playItem', 'void', 'stub'),
  prop('currentMarker', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('currentPositionTimecode', 'string', 'r', 'stub', { stubValue: '' }),
  prop('currentAudioLanguage', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('currentAudioLanguageIndex', 'number', 'rw', 'stub', { stubValue: 0 }),
  method('getAudioLanguageCount', 'number', 'stub'),
  method('getMarkerName', 'string', 'stub'),
  method('getMarkerTime', 'number', 'stub'),
];

/** @type {MemberSpec[]} */
const SETTINGS = [
  prop('volume', 'number', 'rw', 'live', { changeSource: 'media.volume', policy: 'rate-mpd' }),
  prop('mute', 'bool', 'rw', 'emulated', { changeSource: 'settings.mute' }),
  prop('balance', 'number', 'rw', 'live', { changeSource: 'dsp.balance' }),
  method('getMode', 'bool', 'live', { changeSource: 'media.mode' }),
  method('setMode', 'void', 'live', { policy: 'rate-mpd' }),
  prop('rate', 'number', 'rw', 'stub', { stubValue: 1 }),
  prop('autoStart', 'bool', 'rw', 'stub', { stubValue: true }),
  prop('playCount', 'number', 'rw', 'stub', { stubValue: 1 }),
  prop('baseURL', 'string', 'rw', 'stub', { stubValue: '' }),
  prop('defaultFrame', 'string', 'rw', 'stub', { stubValue: '' }),
  prop('enableErrorDialogs', 'bool', 'rw', 'stub', { stubValue: false }),
  prop('invokeURLs', 'bool', 'rw', 'stub', { stubValue: true }),
  prop('bass', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('treble', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('hue', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('saturation', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('contrast', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('brightness', 'number', 'rw', 'stub', { stubValue: 0 }),
  method('isAvailable', 'bool', 'stub', { stubValue: false }),
];

/** @type {MemberSpec[]} */
const MEDIA = [
  prop('name', 'string', 'r', 'emulated', { changeSource: 'media.song' }),
  prop('duration', 'number', 'r', 'live', { changeSource: 'media.duration' }),
  prop('durationString', 'string', 'r', 'emulated', { changeSource: 'media.duration' }),
  prop('sourceURL', 'string', 'r', 'live', { changeSource: 'media.song' }),
  method('getItemInfo', 'string', 'emulated', { changeSource: 'media.song' }),
  method('setItemInfo', 'void', 'denied', { policy: 'deny-log' }),
  prop('imageSourceWidth', 'number', 'r', 'emulated'),
  prop('imageSourceHeight', 'number', 'r', 'emulated'),
  prop('attributeCount', 'number', 'r', 'emulated', { changeSource: 'media.song' }),
  method('getAttributeName', 'string', 'emulated', { changeSource: 'media.song' }),
  prop('markerCount', 'number', 'r', 'stub', { stubValue: 0 }),
  method('isIdentical', 'bool', 'stub', { stubValue: false }),
  method('isReadOnlyItem', 'bool', 'stub', { stubValue: true }),
];

/** @type {MemberSpec[]} */
const NETWORK = [
  prop('downloadProgress', 'number', 'r', 'emulated'),      // always 100: MPD files are local (parity D2)
  prop('bufferingProgress', 'number', 'r', 'emulated'),
  prop('bitRate', 'number', 'r', 'emulated', { changeSource: 'media.bitrate' }),
  prop('bandwidth', 'number', 'r', 'stub', { stubValue: 0 }),
  prop('sourceProtocol', 'string', 'r', 'stub', { stubValue: '' }),
  prop('receptionQuality', 'number', 'r', 'stub', { stubValue: 0 }),
  prop('maxBitRate', 'number', 'rw', 'stub', { stubValue: 0 }),
  prop('maxBandwidth', 'number', 'rw', 'stub', { stubValue: 0 }),
];

/** @type {MemberSpec[]} */
const PLAYLIST_OBJ = [
  prop('count', 'number', 'r', 'live', { changeSource: 'media.queue' }),
  prop('name', 'string', 'r', 'emulated'),
  method('item', 'object', 'live', { changeSource: 'media.queue' }),
  method('getItemInfo', 'string', 'stub', { stubValue: '' }),
  method('setItemInfo', 'void', 'denied', { policy: 'deny-log' }),
  prop('attributeCount', 'number', 'r', 'stub', { stubValue: 0 }),
  method('isIdentical', 'bool', 'stub', { stubValue: false }),
];

/** @type {MemberSpec[]} */
const PLAYER_APPLICATION = [
  method('switchToPlayerApplication', 'void', 'stub'),
  prop('hasDisplay', 'bool', 'r', 'stub', { stubValue: false }),
  prop('playerDocked', 'bool', 'r', 'stub', { stubValue: false }),
];

// ---- theme, view, event, mediacenter ---------------------------------------------------------------

/** @type {MemberSpec[]} */
const THEME = [
  method('savePreference', 'void', 'live', { policy: 'pref-caps' }),
  method('loadPreference', 'string', 'live'),
  method('loadString', 'string', 'live'),
  method('logString', 'void', 'live'),
  prop('author', 'string', 'rw', 'live'),
  prop('title', 'string', 'rw', 'live'),
  prop('copyright', 'string', 'rw', 'live'),
  prop('currentViewID', 'string', 'rw', 'emulated', { policy: 'view-current-only' }),
  prop('authorVersion', 'string', 'r', 'live'),
  prop('version', 'number', 'r', 'live'),
  method('openView', 'void', 'emulated', { policy: 'view-current-only' }),
  method('openViewRelative', 'void', 'emulated', { policy: 'view-current-only' }),
  method('closeView', 'void', 'emulated', { policy: 'view-current-only' }),
  method('openDialog', 'string', 'stub', { stubValue: '' }),
  method('playSound', 'void', 'stub'),
  method('showErrorDialog', 'void', 'stub'),
];

/** The documented `event` properties (spec 5.7); all read-only. */
const EVENT_NUMBERS = ['x', 'y', 'clientX', 'clientY', 'offsetX', 'offsetY', 'screenX', 'screenY', 'screenWidth', 'screenHeight', 'button', 'keyCode'];
const EVENT_BOOLS = ['altKey', 'ctrlKey', 'shiftKey'];
const EVENT_ELEMENTS = ['srcElement', 'fromElement', 'toElement'];

/** @type {MemberSpec[]} */
const EVENT = [
  ...EVENT_NUMBERS.map((n) => prop(n, 'number', 'r', 'live')),
  ...EVENT_BOOLS.map((n) => prop(n, 'bool', 'r', 'live')),
  ...EVENT_ELEMENTS.map((n) => prop(n, 'object', 'r', 'live')),
];

/** The eight documented `mediacenter` keys (U-14), the only ones that persist (D6). */
export const MEDIACENTER_KEYS = Object.freeze([
  'effectType', 'effectPreset', 'videoZoom', 'videoStretchToFit', 'videoShrinkToFit', 'showTitles', 'showEffects', 'contrastMode',
]);

/** @type {MemberSpec[]} */
const MEDIACENTER = [
  prop('effectType', 'string', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('effectPreset', 'number', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('videoZoom', 'number', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('videoStretchToFit', 'bool', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('videoShrinkToFit', 'bool', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('showTitles', 'bool', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('showEffects', 'bool', 'rw', 'live', { changeSource: 'mediacenter' }),
  prop('contrastMode', 'bool', 'rw', 'live', { changeSource: 'mediacenter' }),
];

// ---- eq, vidset -----------------------------------------------------------------------------------

export const EQ_BANDS = 10;

/** @type {MemberSpec[]} */
const EQ = [
  ...Array.from({ length: EQ_BANDS }, (_, i) => prop(`gainLevel${i + 1}`, 'number', 'rw', 'live', { changeSource: 'dsp.eq' })),
  method('gainLevels', 'number', 'live', { changeSource: 'dsp.eq' }),
  method('reset', 'void', 'live'),
  prop('bands', 'number', 'r', 'live'),
  // Host state, default false: the EQ is live (D6). WMP's documented `true` reflects its own mode.
  prop('bypass', 'bool', 'rw', 'live', { changeSource: 'dsp.eq' }),
  prop('enableSplineTension', 'bool', 'rw', 'emulated'),    // accepted, no DSP effect (parity G10)
  prop('currentPreset', 'number', 'rw', 'emulated'),
  prop('currentPresetTitle', 'string', 'r', 'emulated'),
  prop('presetCount', 'number', 'r', 'emulated'),
  method('presetTitle', 'string', 'emulated'),
  method('nextPreset', 'void', 'stub'),
  method('previousPreset', 'void', 'stub'),
  prop('splineTension', 'number', 'rw', 'stub', { stubValue: 3 }),
  prop('crossFade', 'bool', 'rw', 'stub', { stubValue: false }),
  prop('crossFadeWindow', 'number', 'rw', 'stub', { stubValue: 250 }),
  prop('normalization', 'bool', 'rw', 'stub', { stubValue: false }),
  prop('normalizationAverage', 'number', 'r', 'stub', { stubValue: 0 }),
  prop('normalizationPeak', 'number', 'r', 'stub', { stubValue: 0 }),
  prop('enhancedAudio', 'bool', 'rw', 'stub', { stubValue: false }),
  prop('speakerSize', 'number', 'rw', 'stub', { stubValue: 1 }),
  prop('currentSpeakerName', 'string', 'r', 'stub', { stubValue: 'Normal Speakers' }),
  prop('truBassLevel', 'number', 'rw', 'stub', { stubValue: 50 }),
  prop('wowLevel', 'number', 'rw', 'stub', { stubValue: 50 }),
];

/** @type {MemberSpec[]} */
const VIDSET = [
  prop('brightness', 'number', 'rw', 'emulated', { changeSource: 'local' }),
  prop('contrast', 'number', 'rw', 'emulated', { changeSource: 'local' }),
  prop('hue', 'number', 'rw', 'emulated', { changeSource: 'local' }),
  prop('saturation', 'number', 'rw', 'emulated', { changeSource: 'local' }),
  method('reset', 'void', 'emulated'),
];

// ---- elements -------------------------------------------------------------------------------------

/** Every element kind there is a class for. @type {readonly ElementKind[]} */
export const ELEMENT_KINDS = Object.freeze(/** @type {ElementKind[]} */ ([
  'theme', 'view', 'subview', 'button', 'buttongroup', 'buttonelement', 'slider', 'customslider', 'progressbar', 'text',
  'effects', 'video', 'playlist', 'equalizersettings', 'videosettings', 'player', 'controls', 'settings', 'mediacenter',
  'automenu', 'listbox', 'popup', 'item', 'editbox', 'unknown',
]));

/**
 * The class a script sees for an element of this kind. The two non-visual settings elements have the
 * D6 classes `eq` and `vidset`; the VIEW is the `view` global's class.
 * @param {ElementKind} kind
 * @returns {string}
 */
export const elementClassName = (kind) => (kind === 'equalizersettings' ? 'eq' : kind === 'videosettings' ? 'vidset' : kind === 'view' ? 'view' : `element.${kind}`);

/** @type {Readonly<Record<string, MemberSpec['type']>>} */
const ATTR_TYPE_TO_MEMBER = Object.assign(Object.create(null), {
  int: 'number', float: 'number', bool: 'bool', color: 'string', string: 'string', image: 'string', handler: 'string', cursor: 'string',
});

/**
 * The member a script sees for an attribute: a number, boolean or string. A colour reads as the text
 * `#rrggbb`, `none` or `auto` (the object file converts); enums and handlers read as text.
 * @param {AttrSpec} spec
 * @returns {MemberSpec}
 */
function memberOfAttr(spec) {
  const type = typeof spec.type === 'object' ? 'string' : (ATTR_TYPE_TO_MEMBER[spec.type] ?? 'string');
  return spec.type === 'handler'
    ? { name: spec.name, kind: 'event', type, access: 'rw', impl: 'live' }
    : prop(spec.name, type, spec.access, 'live');
}

/** @param {ElementKind} kind @returns {MemberSpec[]} */
const attributeMembers = (kind) => attrSpecsOf(kind).map(memberOfAttr);

/** Kinds that have geometry and so the ambient animation methods (spec 5.2). */
const ANIMATED = new Set(['subview', 'button', 'buttongroup', 'slider', 'customslider', 'progressbar', 'text', 'effects', 'video', 'playlist', 'editbox', 'listbox', 'popup']);
/** Windowed controls that do not support alphaBlend (spec 5.4). */
const NO_ALPHA = new Set(['playlist', 'editbox', 'listbox', 'popup']);

/** @param {string} kind @returns {MemberSpec[]} */
function animationMethods(kind) {
  if (!ANIMATED.has(kind)) return [];
  return [
    method('moveTo', 'void', 'live'),
    method('slideTo', 'void', 'live'),
    method('moveSizeTo', 'void', 'live'),
    ...(NO_ALPHA.has(kind) ? [] : [method('alphaBlendTo', 'void', 'live')]),
  ];
}

/** The EFFECTS element's members that are backed by the host EffectsControl (E D6). @type {MemberSpec[]} */
const EFFECTS_OVERLAY = [
  prop('currentEffectType', 'string', 'rw', 'emulated', { changeSource: 'effects' }),
  prop('currentEffectTitle', 'string', 'r', 'emulated', { changeSource: 'effects' }),
  prop('currentPreset', 'number', 'rw', 'emulated', { changeSource: 'effects' }),
  prop('currentPresetTitle', 'string', 'r', 'emulated', { changeSource: 'effects' }),
  prop('currentEffectPresetCount', 'number', 'r', 'emulated', { changeSource: 'effects' }),
  prop('effectCount', 'number', 'r', 'emulated'),
  prop('fullScreen', 'bool', 'rw', 'stub', { stubValue: false }),
  method('next', 'void', 'emulated'),
  method('previous', 'void', 'emulated'),
  method('nextPreset', 'void', 'emulated'),
  method('previousPreset', 'void', 'emulated'),
  method('nextEffect', 'void', 'emulated'),
  method('previousEffect', 'void', 'emulated'),
  method('settings', 'void', 'emulated'),
  method('effectTitle', 'string', 'emulated'),
  method('effectType', 'string', 'emulated'),
];

/** @param {ElementKind} kind @returns {MemberSpec[]} the members of one element class before the schema freezes them */
function elementMembers(kind) {
  const base = [...attributeMembers(kind), ...animationMethods(kind)];
  switch (kind) {
    case 'effects': return overlay(base, EFFECTS_OVERLAY);
    case 'buttongroup': return [...base, method('click', 'void', 'live'), method('getButton', 'object', 'live')];
    case 'buttonelement': return [...base, method('click', 'void', 'live')];
    case 'playlist': return [...base, method('setColumnResizeMode', 'void', 'emulated'), method('setColumnWidth', 'void', 'emulated')];
    case 'automenu': return [...base, method('show', 'void', 'stub')];
    default: return base;
  }
}

/** The `view` global is the VIEW element plus the verbs of E D6 that act on the skin's own frame; its animation methods are phase 3. @type {MemberSpec[]} */
const VIEW_OVERLAY = [
  prop('timerInterval', 'number', 'rw', 'live', { policy: 'timer-caps' }),
  method('close', 'void', 'live', { policy: 'gesture-only' }),
  method('minimize', 'void', 'live', { policy: 'gesture-only' }),
  method('returnToMediaCenter', 'void', 'live'),
  method('maximize', 'void', 'stub'),
  method('restore', 'void', 'stub'),
  method('size', 'void', 'stub'),
  method('moveTo', 'void', 'stub'),
  method('slideTo', 'void', 'stub'),
  method('moveSizeTo', 'void', 'stub'),
  method('alphaBlendTo', 'void', 'stub'),
];

// ---- the table ------------------------------------------------------------------------------------

/** @type {Array<[string, MemberSpec[]]>} */
const CLASSES = [
  ['player', PLAYER], ['controls', CONTROLS], ['settings', SETTINGS], ['media', MEDIA], ['network', NETWORK],
  ['playlistObj', PLAYLIST_OBJ], ['theme', THEME], ['event', EVENT], ['mediacenter', MEDIACENTER], ['eq', EQ],
  ['vidset', VIDSET], ['playerApplication', PLAYER_APPLICATION],
  // An inert object (mediaCollection and its kin): a class with no members, so nothing in it resolves.
  ['inert', []],
  ['view', overlay(attributeMembers('view'), VIEW_OVERLAY)],
  ...ELEMENT_KINDS.filter((k) => k !== 'view' && k !== 'equalizersettings' && k !== 'videosettings')
    .map((k) => /** @type {[string, MemberSpec[]]} */ ([elementClassName(k), elementMembers(k)])),
];

/** @type {ReadonlyMap<string, ClassSchema>} */
export const SCHEMA = frozenMap(CLASSES.map(([name, members]) => [name, classOf(members)]));

// ---- helpers --------------------------------------------------------------------------------------

/** The name a class goes by in the ledger and in tools (`player.controls.next`). */
const API_PREFIX = new Map([
  ['player', 'player'], ['controls', 'player.controls'], ['settings', 'player.settings'], ['media', 'player.currentMedia'],
  ['network', 'player.network'], ['playlistObj', 'player.currentPlaylist'], ['theme', 'theme'], ['view', 'view'],
  ['event', 'event'], ['mediacenter', 'mediacenter'], ['eq', 'equalizerSettings'], ['vidset', 'videoSettings'],
  ['playerApplication', 'playerApplication'], ['inert', 'player.collection'],
]);

/** @param {string} className `element.button` is filed as `button` @returns {string} */
export const apiPrefix = (className) => API_PREFIX.get(className) ?? (className.startsWith('element.') ? className.slice('element.'.length) : className);

/** @param {string} className @param {string} member canonical or lowercased @returns {string} */
export const apiName = (className, member) => `${apiPrefix(className)}.${member}`;

/** The element kind a class stands for, for the names the table derives rather than lists. @param {string} className @returns {ElementKind | null} */
function kindOfClass(className) {
  if (className === 'view') return 'view';
  if (className === 'eq') return 'equalizersettings';
  if (className === 'vidset') return 'videosettings';
  return className.startsWith('element.') ? /** @type {ElementKind} */ (className.slice('element.'.length)) : null;
}

/**
 * The member a name is in a class, or undefined. The table lists every member except one family:
 * `<attr>_onchange`, which the attribute tables accept for any attribute of an element (spec 2.3),
 * is derived here, so `slider.value_onchange` resolves without a row for every attribute.
 * @param {string} className @param {string} name any case
 * @returns {MemberSpec | undefined}
 */
export function lookupMember(className, name) {
  const key = String(name).toLowerCase();
  const listed = SCHEMA.get(className)?.get(key);
  if (listed || !key.endsWith('_onchange')) return listed;
  const kind = kindOfClass(className);
  const attr = kind ? attrSpec(kind, key) : undefined;
  return attr ? memberOfAttr(attr) : undefined;
}

/**
 * The class -> lowercased member list that `RealmOptions.classMembers` wants (the realm answers `has`
 * for element-implicit scope from it). A fresh Map each call.
 * @returns {Map<string, readonly string[]>}
 */
export function classMembers() {
  return new Map([...SCHEMA].map(([name, members]) => [name, Object.freeze([...members.keys()])]));
}
