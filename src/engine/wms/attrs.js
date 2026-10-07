// @ts-check
// Attribute tables: which attributes each element kind knows, their types and defaults (E §5.2
// `attrSpec`; spec 5.1 ambient attributes, spec 6.x per-kind attributes).
//
// What "known" means: an attribute that is in this table has behaviour; one that is not is kept as
// inert text (G12). So every attribute a skin can usefully set must be here, and nothing the
// engine must ignore (a VIEW's passThrough, a THEME id) may be.
//
// Representation (the model stores values in this typed form; `coerce` in values.js produces it):
//   int, float   a JS number (int is rounded by `coerce`)
//   bool         a boolean
//   string/image/handler/cursor   a string
//   color        the output of `parseColor`: an Rgb number, 'none' or 'auto'
//   enum         the member's own spelling from the table
// A `default` of null means "no default": the attribute is unset and the consumer falls back
// (a TEXT's hoverForegroundColor falls back to foregroundColor, an unset transparencyColor keys
// nothing). width and height default to 0 here; the builder substitutes the probed image size
// (spec 5.1), and an id-less element gets its `Unnamed_<type>_<n>` there too.
//
// `access: 'r'` binds script, user and binding writes. The literal pass (origin 'init') still
// sets such an attribute: `id`, `titleBar` and `windowed` are only ever written by markup.
//
// This file imports nothing, so values.js can import it without a cycle.

/** @typedef {import('../contracts').AttrSpec} AttrSpec */
/** @typedef {import('../contracts').AttrType} AttrType */
/** @typedef {import('../contracts').ElementKind} ElementKind */
/** @typedef {[string, AttrType, unknown, ('r' | 'rw')?]} Row */

const I = 'int', F = 'float', B = 'bool', S = 'string', C = 'color', M = 'image', K = 'cursor', H = 'handler';
const WHITE = 0xffffff, BLACK = 0x000000, GREEN = 0x00ff00, RED = 0xff0000;

/** @param {...string} members @returns {AttrType} */
const enumOf = (...members) => Object.freeze({ enum: Object.freeze(members) });

const ALIGN_H = enumOf('left', 'right', 'center', 'stretch');
const ALIGN_V = enumOf('top', 'bottom', 'center', 'stretch');
const JUSTIFY = enumOf('Left', 'Right', 'Center');

// ---- colours ----------------------------------------------------------------------------------

// Windows system colour names. The WMP colour reference lists none of them, but the docs give
// `graytext` as a PLAYLIST default and IE accepts the rest. The values are the classic Windows
// palette; they are a host choice, not skin art.
/** @type {ReadonlyMap<string, number>} */
export const SYSTEM_COLORS = new Map([
  ['windowtext', 0x000000], ['highlight', 0x0a246a], ['highlighttext', 0xffffff],
  ['buttonface', 0xd4d0c8], ['buttontext', 0x000000], ['graytext', 0x808080],
]);

// ---- PLAYER events ----------------------------------------------------------------------------

// Handler parameter names are visible to the handler by exact name, the one place WMP is
// case-sensitive (spec 2.2, 6.19). Events the docs list without parameters get none. Keys are
// lowercase; a PLAYER attribute is an event under its bare name or with an `on` prefix.
/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const PLAYER_EVENT_ROWS = [
  ['AudioLanguageChange', []], ['Buffering', ['Start']], ['CdromMediaChange', ['CdromNum']],
  ['CurrentItemChange', []], ['CurrentMediaItemAvailable', ['bstrItemName']],
  ['CurrentPlaylistChange', ['change']], ['CurrentPlaylistItemAvailable', []], ['Disconnect', []],
  ['DomainChange', []], ['Error', []], ['MarkerHit', ['MarkerNum']], ['MediaChange', ['Item']],
  ['MediaCollectionAttributeStringAdded', []], ['MediaCollectionAttributeStringChanged', []],
  ['MediaCollectionAttributeStringRemoved', []], ['MediaCollectionChange', []], ['MediaError', []],
  ['ModeChange', ['ModeName', 'NewValue']], ['NewStream', []], ['OpenPlaylistSwitch', []],
  ['OpenStateChange', ['NewState']], ['PlaylistChange', ['Playlist', 'change']],
  ['PlaylistCollectionChange', []], ['PlaylistCollectionPlaylistAdded', []],
  ['PlaylistCollectionPlaylistRemoved', []], ['PlaylistCollectionPlaylistRenamed', []],
  ['PlayStateChange', ['NewState']], ['PositionChange', ['oldPosition', 'newPosition']],
  ['ScriptCommand', ['scType', 'Param']], ['StatusChange', []],
];

/** @type {ReadonlyMap<string, { name: string, params: readonly string[] }>} */
export const PLAYER_EVENTS = new Map(
  PLAYER_EVENT_ROWS.map(([name, params]) => [name.toLowerCase(), Object.freeze({ name, params: Object.freeze([...params]) })]),
);

// ---- row groups -------------------------------------------------------------------------------

/** @type {Row[]} */
const AMBIENT = [
  ['id', S, '', 'r'], ['left', I, 0], ['top', I, 0], ['right', I, 0], ['bottom', I, 0],
  ['width', I, 0], ['height', I, 0], ['zIndex', I, 0], ['visible', B, true], ['enabled', B, true],
  ['tabStop', B, true], ['horizontalAlignment', ALIGN_H, 'left'], ['verticalAlignment', ALIGN_V, 'top'],
  ['alphaBlend', I, 255], ['clippingImage', M, ''], ['clippingColor', C, 'auto'], ['passThrough', B, false],
  ['resizeImages', B, false], ['nineGridMargins', S, ''], ['elementType', S, '', 'r'],
  ['accName', S, ''], ['accDescription', S, ''], ['accKeyboardShortcut', S, ''],
];

const AMBIENT_EVENTS = [
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmousemove', 'onmouseover', 'onmouseout',
  'onkeydown', 'onkeypress', 'onkeyup', 'onfocus', 'onblur', 'onresize', 'onendmove', 'onendalphablend',
];
const DRAG_EVENTS = ['onDragBegin', 'onDragEnd', 'onPositionChange'];

/** @param {string[]} names @returns {Row[]} */
const handlers = (names) => names.map((n) => /** @type {Row} */ ([n, H, '']));

/** @param {string[]} names @returns {Row[]} the ambient attributes named, in table order */
const ambientOnly = (names) => AMBIENT.filter((r) => names.includes(r[0]));
/** @param {string[]} names @returns {Row[]} the ambient attributes except the ones named */
const ambientExcept = (names) => AMBIENT.filter((r) => !names.includes(r[0]));

/** @param {number | 'none'} backgroundColor default differs: white for a VIEW, none for a SUBVIEW @returns {Row[]} */
const background = (backgroundColor) => [
  ['backgroundImage', M, ''], ['backgroundColor', C, backgroundColor], ['backgroundTiled', B, false],
  ['backgroundImageHueShift', F, 0], ['backgroundImageSaturation', F, 1], ['resizeBackgroundImage', B, false],
  ['transparencyColor', C, null],
];

/** @type {Row[]} */
const THEME = [
  ['author', S, ''], ['authorVersion', S, '', 'r'], ['copyright', S, ''], ['title', S, ''],
  ['version', F, 1, 'r'], ['currentViewID', S, ''],
];

// `resizable` defaults to the value of titleBar, which is true; the builder applies that link.
/** @type {Row[]} */
const VIEW_ONLY = [
  ['title', S, '', 'r'], ['titleBar', B, true, 'r'], ['resizable', B, true, 'r'], ['minWidth', I, 0],
  ['minHeight', I, 0], ['maxWidth', I, 0], ['maxHeight', I, 0],
  ['category', enumOf('All', 'Radio', 'CD', 'DVD', 'Music', 'Video'), 'All'], ['scriptFile', S, ''],
  ['timerInterval', I, 1000], ['focusObjectID', S, ''],
];

/** @type {Row[]} */
const BUTTON = [
  ['image', M, ''], ['hoverImage', M, ''], ['downImage', M, ''], ['hoverDownImage', M, ''], ['disabledImage', M, ''],
  ['sticky', B, false], ['down', B, false], ['tiled', B, false], ['transparencyColor', C, null],
  ['cursor', K, 'system'], ['upToolTip', S, ''], ['downToolTip', S, ''],
];

/** @type {Row[]} */
const BUTTONGROUP = [
  ['mappingImage', M, ''], ['image', M, ''], ['hoverImage', M, ''], ['downImage', M, ''], ['hoverDownImage', M, ''],
  ['disabledImage', M, ''], ['showBackground', B, false], ['radio', B, false], ['transparencyColor', C, 'none'],
  ['cursor', K, 'system'], ['hueShift', F, 0], ['saturation', F, 1], ['buttonCount', I, 0, 'r'],
];

/** @type {Row[]} */
const BUTTONELEMENT = [
  ['mappingColor', C, null], ['sticky', B, false], ['down', B, false], ['upToolTip', S, ''],
  ['downToolTip', S, ''], ['cursor', K, 'system'], ['index', I, 0, 'r'],
];

// Also the PROGRESSBAR table (spec 6.9: identical to SLIDER).
/** @type {Row[]} */
const SLIDER = [
  ['min', F, 0], ['max', F, 100], ['value', F, 0], ['direction', enumOf('horizontal', 'vertical'), 'horizontal'],
  ['backgroundColor', C, null], ['backgroundEndColor', C, null], ['foregroundColor', C, WHITE],
  ['foregroundEndColor', C, null], ['disabledColor', C, null],
  ['backgroundImage', M, ''], ['backgroundHoverImage', M, ''], ['foregroundImage', M, ''],
  ['foregroundHoverImage', M, ''], ['disabledImage', M, ''], ['thumbImage', M, ''], ['thumbHoverImage', M, ''],
  ['thumbDownImage', M, ''], ['thumbDisabledImage', M, ''],
  ['slide', B, true], ['tiled', B, false], ['borderSize', I, 0], ['transparencyColor', C, null],
  ['useForegroundProgress', B, false], ['foregroundProgress', F, 0], ['toolTip', S, ''], ['cursor', K, 'hand'],
];

/** @type {Row[]} */
const CUSTOMSLIDER = [
  ['image', M, ''], ['positionImage', M, ''], ['hoverImage', M, ''], ['downImage', M, ''], ['disabledImage', M, ''],
  ['min', F, 0], ['max', F, 100], ['value', F, 0], ['transparencyColor', C, null], ['toolTip', S, ''],
  ['cursor', K, 'hand'],
];

// fontStyle is a space-separated flag set (`Bold Italic`), so it stays a string for the renderer.
/** @type {Row[]} */
const TEXT = [
  ['value', S, ''], ['fontFace', S, ''], ['fontSize', I, 10], ['fontStyle', S, 'Normal'],
  ['foregroundColor', C, BLACK], ['backgroundColor', C, 'none'], ['justification', JUSTIFY, 'Left'],
  ['hoverForegroundColor', C, null], ['hoverBackgroundColor', C, null], ['hoverFontStyle', S, null],
  ['disabledForegroundColor', C, null], ['disabledBackgroundColor', C, null], ['disabledFontStyle', S, null],
  ['fontSmoothing', B, false], ['wordWrap', B, false], ['scrolling', B, false], ['scrollingAmount', I, 6],
  ['scrollingDelay', I, 85], ['scrollingDirection', enumOf('Left', 'Right'), 'Left'], ['textWidth', I, 0, 'r'],
  ['toolTip', S, ''], ['cursor', K, 'system'],
  ['tabStop', B, false],
];

/** @type {Row[]} */
const EDITBOX = [
  ['value', S, ''], ['editStyle', enumOf('normal', 'password', 'uppercase', 'lowercase', 'number', 'multiline'), 'normal'],
  ['readOnly', B, false], ['textLimit', I, 0], ['wordWrap', B, true], ['border', B, true],
  ['backgroundColor', C, WHITE], ['foregroundColor', C, BLACK], ['fontFace', S, 'Tahoma'], ['fontSize', I, 10],
  ['fontStyle', S, ''], ['justification', JUSTIFY, 'Left'], ['lineCount', I, 0, 'r'],
];

/** @param {boolean} popUp @returns {Row[]} LISTBOX and POPUP differ only in the default of popUp (spec 6.12) */
const listbox = (popUp) => [
  ['selectedItem', I, -1], ['focusItem', I, -1], ['firstVisibleItem', I, 0], ['itemCount', I, 0, 'r'],
  ['multiSelect', B, false], ['sorted', B, false], ['readOnly', B, false], ['popUp', B, popUp], ['border', B, true],
  ['backgroundColor', C, WHITE], ['foregroundColor', C, BLACK], ['fontFace', S, 'Tahoma'], ['fontSize', I, 10],
  ['fontStyle', S, ''],
];

const SYS = Object.fromEntries(SYSTEM_COLORS);

/** @type {Row[]} */
const PLAYLIST = [
  ['playlist', S, ''], ['columns', S, ''], ['columnOrder', S, '0;1;2;3'], ['columnCount', I, 0, 'r'],
  ['columnsVisible', B, true], ['playlistItemsVisible', B, true], ['dropDownVisible', B, true],
  ['dropDownList', enumOf('showAll', 'showAlbums', 'showCD', 'showClips', 'showCurrent', 'showLibrary', 'showRadio', 'showQueries'), 'showAll'],
  ['dropDownToolTip', S, 'Display playlists, audio, video, or radio stations'],
  ['dropDownImage', M, ''], ['dropDownBackgroundImage', M, ''], ['hueShift', F, 0], ['saturation', F, 1],
  ['backgroundColor', C, WHITE], ['backgroundImage', M, ''], ['foregroundColor', C, SYS.windowtext],
  ['itemPlayingColor', C, GREEN], ['itemPlayingBackgroundColor', C, 0x222222], ['itemErrorColor', C, RED],
  ['disabledItemColor', C, SYS.graytext], ['itemSelectedColor', C, SYS.highlighttext],
  ['itemSelectedBackgroundColor', C, SYS.highlight], ['itemSelectedFocusLostColor', C, SYS.buttontext],
  ['itemSelectedBackgroundFocusLostColor', C, SYS.buttonface], ['statusColor', C, null], ['statusTextColor', C, 'none'],
  ['leftStatus', S, ''], ['rightStatus', S, ''], ['checkboxesVisible', B, false], ['editButtonVisible', B, false],
  ['toolbarVisible', B, false], ['allowColumnSorting', B, true], ['allowItemEditing', B, true],
  ['itemCount', I, 0, 'r'], ['copying', B, false, 'r'],
];

/** @type {Row[]} */
const EFFECTS = [
  ['windowed', B, false, 'r'], ['allowAll', B, true], ['currentEffectType', S, ''], ['currentEffectTitle', S, '', 'r'],
  ['currentPreset', I, 0], ['currentPresetTitle', S, '', 'r'], ['currentEffectPresetCount', I, 0, 'r'],
  ['effectCount', I, 0, 'r'], ['effectCanGoFullScreen', B, false, 'r'], ['effectHasPropertyPage', B, false, 'r'],
  ['fullScreen', B, false],
];

/** @type {Row[]} */
const VIDEO = [
  ['windowless', B, false, 'r'], ['backgroundColor', C, 'none'], ['stretchToFit', B, false], ['shrinkToFit', B, true],
  ['maintainAspectRatio', B, true], ['zoom', I, 100], ['fullScreen', B, false], ['cursor', K, ''], ['toolTip', S, ''],
];

/** @type {Row[]} */
const EQUALIZERSETTINGS = [
  ...Array.from({ length: 10 }, (_, i) => /** @type {Row} */ ([`gainLevel${i + 1}`, F, 0])),
  ['bands', I, 10, 'r'], ['bypass', B, true], ['currentPreset', I, 0], ['currentPresetTitle', S, '', 'r'],
  ['presetCount', I, 0, 'r'], ['enableSplineTension', B, true], ['splineTension', F, 3], ['crossFade', B, false],
  ['crossFadeWindow', I, 250], ['normalization', B, false], ['normalizationAverage', F, 0, 'r'],
  ['normalizationPeak', F, 0, 'r'], ['enhancedAudio', B, false], ['speakerSize', I, 1],
  ['currentSpeakerName', S, 'Normal Speakers', 'r'], ['truBassLevel', I, 50], ['wowLevel', I, 50],
];

/** @type {Row[]} */
const VIDEOSETTINGS = [['brightness', I, 0], ['contrast', I, 0], ['hue', I, 0], ['saturation', I, 0]];

/** @type {Row[]} */
const SETTINGS = [
  ['autoStart', B, true], ['balance', I, 0], ['baseURL', S, ''], ['defaultFrame', S, ''],
  ['enableErrorDialogs', B, false], ['invokeURLs', B, true], ['mute', B, false], ['playCount', I, 1],
  ['rate', F, 1], ['volume', I, 50],
];

/** @type {Row[]} */
const CONTROLS = [
  ['currentAudioLanguage', I, 0], ['currentAudioLanguageIndex', I, 0], ['currentItem', S, ''],
  ['currentMarker', I, 0], ['currentPosition', F, 0], ['currentPositionTimecode', S, ''],
];

// Undocumented (U-14); the defaults are inferred from usage.
/** @type {Row[]} */
const MEDIACENTER = [
  ['videoZoom', I, 100], ['videoStretchToFit', B, false], ['videoShrinkToFit', B, true], ['effectType', S, ''],
  ['effectPreset', I, 0], ['showTitles', B, true], ['showEffects', B, true], ['contrastMode', B, false],
];

/** @type {Row[]} */
const PLAYER = [
  ['url', S, ''],
  ...PLAYER_EVENT_ROWS.flatMap(([name]) => [/** @type {Row} */ ([name, H, '']), /** @type {Row} */ (['on' + name, H, ''])]),
];

const ID_ONLY = ambientOnly(['id']);
const ELEMENT_AMBIENT = ambientOnly(['id', 'enabled', 'tabStop', 'elementType', 'accName', 'accDescription', 'accKeyboardShortcut']);

// ---- tables -----------------------------------------------------------------------------------

/**
 * Later groups override earlier ones, so a kind's own rows can restate an ambient default
 * (TEXT's tabStop). Keys are lowercase: script assignments and markup arrive in any case.
 * @param {...Row[]} groups
 * @returns {Map<string, AttrSpec>}
 */
function build(...groups) {
  /** @type {Map<string, AttrSpec>} */
  const table = new Map();
  for (const group of groups) {
    for (const [name, type, def, access] of group) {
      table.set(name.toLowerCase(), Object.freeze({ name, type, default: def, access: access ?? 'rw' }));
    }
  }
  return table;
}

const events = handlers(AMBIENT_EVENTS);

// PLAYLIST is a native, owner-drawn control (spec 6.13): the docs list zIndex, clippingImage,
// clippingColor, passThrough and alphaBlend as unsupported on it, and the mouse, key and click
// handlers with them (spec 5.6). The focus, resize and end-of-animation events stay.
const PLAYLIST_AMBIENT = ambientExcept(['zIndex', 'clippingImage', 'clippingColor', 'passThrough', 'alphaBlend']);
const PLAYLIST_EVENTS = handlers(['onfocus', 'onblur', 'onresize', 'onendmove', 'onendalphablend']);

// AUTOMENU: only left and top apply (the position the menu appears at), and visible defaults to
// false (spec 6.18). It takes no ambient event, `<attr>_onchange` included (spec 5.6; see
// onchangeSpec).
const AUTOMENU = [...ambientOnly(['id', 'left', 'top', 'elementType']), /** @type {Row} */ (['visible', B, false])];

/** @type {ReadonlyMap<ElementKind, ReadonlyMap<string, AttrSpec>>} */
const KINDS = new Map(/** @type {Array<[ElementKind, Map<string, AttrSpec>]>} */ ([
  ['theme', build(THEME)],
  // spec 6.2: a VIEW ignores enabled, passThrough and clippingImage. Honouring passThrough would
  // make a whole skin click-through.
  ['view', build(ambientExcept(['enabled', 'passThrough', 'clippingImage']), background(WHITE), VIEW_ONLY, events, handlers(['onload', 'onclose', 'ontimer', 'onerror']))],
  // U-7: a SUBVIEW honours enabled, passThrough and clippingImage although the docs say it does not.
  ['subview', build(AMBIENT, background('none'), events)],
  ['button', build(AMBIENT, BUTTON, events)],
  ['buttongroup', build(AMBIENT, BUTTONGROUP, events)],
  ['buttonelement', build(ELEMENT_AMBIENT, BUTTONELEMENT, events)],
  ['slider', build(AMBIENT, SLIDER, events, handlers(DRAG_EVENTS))],
  ['progressbar', build(AMBIENT, SLIDER, events, handlers(DRAG_EVENTS))],
  ['customslider', build(AMBIENT, CUSTOMSLIDER, events, handlers(DRAG_EVENTS))],
  ['text', build(AMBIENT, TEXT, events)],
  ['editbox', build(AMBIENT, EDITBOX, events)],
  ['listbox', build(AMBIENT, listbox(false), events)],
  ['popup', build(AMBIENT, listbox(true), events)],
  ['item', build(ID_ONLY, [['value', S, '']])],
  ['playlist', build(PLAYLIST_AMBIENT, PLAYLIST, PLAYLIST_EVENTS)],
  ['effects', build(AMBIENT, EFFECTS, events)],
  ['video', build(AMBIENT, VIDEO, events, handlers(['onVideoStart', 'onVideoEnd']))],
  ['automenu', build(AUTOMENU)],
  ['equalizersettings', build(ID_ONLY, EQUALIZERSETTINGS)],
  ['videosettings', build(ID_ONLY, VIDEOSETTINGS)],
  ['player', build(PLAYER)],
  ['controls', build(CONTROLS)],
  ['settings', build(SETTINGS)],
  ['mediacenter', build(MEDIACENTER)],
  // An inert node (an undocumented tag) can still carry an id and handlers (E D5 scanner rule 6).
  ['unknown', build(ID_ONLY, events)],
]));

// Host-only attributes (E D10.6): `x-` names that only a sidecar may set. They are kept out of
// KINDS so the two-argument `attrSpec` can never return one; a skin that writes
// `x-foregroundMode` in its own markup gets an unknown attribute, which is inert.
/** @type {ReadonlyMap<ElementKind, ReadonlyMap<string, AttrSpec>>} */
const HOST_ONLY = new Map(/** @type {Array<[ElementKind, Map<string, AttrSpec>]>} */ ([
  ['slider', build([['x-foregroundMode', enumOf('progress', 'playhead'), 'progress']])],
  ['progressbar', build([['x-foregroundMode', enumOf('progress', 'playhead'), 'progress']])],
]));

const ONCHANGE = '_onchange';
const IDENT = /^[a-z_$][\w$]*$/;

/**
 * `<attr>_onchange` is a handler on every kind except THEME and AUTOMENU (spec 2.3), including a
 * PLAYER property that is not in the table (`OpenState_onchange`). AUTOMENU takes no ambient
 * event, `_onchange` included (spec 5.6, 6.18).
 * @param {ElementKind} kind @param {ReadonlyMap<string, AttrSpec>} table @param {string} key
 * @returns {AttrSpec | undefined}
 */
function onchangeSpec(kind, table, key) {
  if (kind === 'theme' || kind === 'automenu' || !key.endsWith(ONCHANGE)) return undefined;
  const base = key.slice(0, -ONCHANGE.length);
  if (!IDENT.test(base)) return undefined;
  return Object.freeze({ name: (table.get(base)?.name ?? base) + ONCHANGE, type: H, default: '', access: 'rw' });
}

/** @param {unknown} attr */
const keyOf = (attr) => String(attr).toLowerCase();

/** True for an `x-` attribute: host-only, settable by a sidecar and by nothing else. @param {string} name */
export const isHostOnlyAttr = (name) => /^x-/i.test(String(name));

/** @type {import('../contracts').AttrSpecFn} */
export const attrSpec = (kind, attr) => {
  const table = KINDS.get(kind);
  if (!table) return undefined;
  const key = keyOf(attr);
  return table.get(key) ?? onchangeSpec(kind, table, key);
};

/**
 * Origin-aware lookup for the element model's `set` and the builder: like `attrSpec`, and an
 * `x-` attribute resolves only for origin 'sidecar'.
 * @type {import('../contracts').AttrSpecForFn}
 */
export const attrSpecFor = (kind, attr, origin) => {
  if (isHostOnlyAttr(attr)) return origin === 'sidecar' ? HOST_ONLY.get(kind)?.get(keyOf(attr)) : undefined;
  return attrSpec(kind, attr);
};

/** Every attribute a kind declares (handlers included), for tests and tooling. @param {ElementKind} kind @returns {AttrSpec[]} */
export const attrSpecsOf = (kind) => [...(KINDS.get(kind)?.values() ?? [])];
