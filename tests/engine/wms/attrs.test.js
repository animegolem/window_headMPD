// @ts-check
import { describe, expect, it } from 'vitest';
import { PLAYER_EVENTS, SYSTEM_COLORS, attrSpec, attrSpecFor, attrSpecsOf, isHostOnlyAttr } from '../../../src/engine/wms/attrs.js';
import { resolveTag } from '../../../src/engine/wms/tags.js';
import { coerce } from '../../../src/engine/wms/values.js';

/** @typedef {import('../../../src/engine/contracts').ElementKind} ElementKind */

/** @type {ElementKind[]} */
const KINDS = [
  'theme', 'view', 'subview', 'button', 'buttongroup', 'buttonelement', 'slider', 'customslider', 'progressbar', 'text',
  'effects', 'video', 'playlist', 'equalizersettings', 'videosettings', 'player', 'controls', 'settings', 'mediacenter',
  'automenu', 'listbox', 'popup', 'item', 'editbox', 'unknown',
];

/** @param {ElementKind} kind @param {string} attr */
const spec = (kind, attr) => {
  const s = attrSpec(kind, attr);
  expect(s, `${kind}.${attr}`).toBeDefined();
  return /** @type {import('../../../src/engine/contracts').AttrSpec} */ (s);
};

describe('attrSpec: types, defaults and canonical names', () => {
  it('ambient attributes (spec 5.1)', () => {
    expect(spec('button', 'left')).toEqual({ name: 'left', type: 'int', default: 0, access: 'rw' });
    expect(spec('button', 'zIndex')).toEqual({ name: 'zIndex', type: 'int', default: 0, access: 'rw' });
    expect(spec('button', 'visible').default).toBe(true);
    expect(spec('button', 'enabled').default).toBe(true);
    expect(spec('button', 'alphaBlend').default).toBe(255);
    expect(spec('button', 'clippingColor')).toMatchObject({ type: 'color', default: 'auto' });
    expect(spec('button', 'passThrough').default).toBe(false);
    expect(spec('button', 'id')).toMatchObject({ type: 'string', access: 'r' });
    expect(spec('button', 'elementType').access).toBe('r');
    expect(spec('button', 'horizontalAlignment')).toEqual({
      name: 'horizontalAlignment', type: { enum: ['left', 'right', 'center', 'stretch'] }, default: 'left', access: 'rw',
    });
    expect(spec('button', 'verticalAlignment').type).toEqual({ enum: ['top', 'bottom', 'center', 'stretch'] });
  });

  it('is case-insensitive in the attribute and returns the canonical spelling', () => {
    expect(spec('text', 'TOOLTIP').name).toBe('toolTip');
    expect(spec('text', 'tooltip')).toBe(spec('text', 'toolTip'));
    expect(spec('button', 'UPTOOLTIP').name).toBe('upToolTip');
    expect(spec('subview', 'HorizontalAlignment').name).toBe('horizontalAlignment');
  });

  it('per-kind defaults that differ from the ambient ones', () => {
    expect(spec('view', 'backgroundColor').default).toBe(0xffffff);
    expect(spec('subview', 'backgroundColor').default).toBe('none');
    expect(spec('text', 'tabStop').default).toBe(false);
    expect(spec('automenu', 'visible').default).toBe(false);
    expect(spec('button', 'tabStop').default).toBe(true);
    expect(spec('listbox', 'popUp').default).toBe(false);
    expect(spec('popup', 'popUp').default).toBe(true);
    expect(spec('slider', 'cursor').default).toBe('hand');
    expect(spec('customslider', 'cursor').default).toBe('hand');
    expect(spec('button', 'cursor').default).toBe('system');
  });

  it('VIEW attributes (spec 6.2)', () => {
    expect(spec('view', 'titleBar')).toMatchObject({ type: 'bool', default: true, access: 'r' });
    expect(spec('view', 'timerInterval')).toMatchObject({ type: 'int', default: 1000 });
    expect(spec('view', 'scriptFile').type).toBe('string');
    expect(spec('view', 'category').type).toEqual({ enum: ['All', 'Radio', 'CD', 'DVD', 'Music', 'Video'] });
    expect(spec('view', 'backgroundImageSaturation').default).toBe(1);
    expect(spec('view', 'onload').type).toBe('handler');
    expect(attrSpec('view', 'stickyBorderWidth')).toBeUndefined(); // U-30: ignored
    expect(attrSpec('view', 'resizeable')).toBeUndefined(); // a corpus typo (G12)
  });

  it('a VIEW ignores enabled, passThrough and clippingImage, a SUBVIEW honours them (U-7)', () => {
    for (const a of ['enabled', 'passThrough', 'clippingImage']) {
      expect(attrSpec('view', a), `view.${a}`).toBeUndefined();
      expect(attrSpec('subview', a), `subview.${a}`).toBeDefined();
    }
    expect(spec('view', 'clippingColor')).toBeDefined();
  });

  it('THEME has neither ambient attributes nor an id nor handlers (spec 6.1)', () => {
    expect(attrSpec('theme', 'id')).toBeUndefined();
    expect(attrSpec('theme', 'left')).toBeUndefined();
    expect(attrSpec('theme', 'onclick')).toBeUndefined();
    expect(attrSpec('theme', 'title_onchange')).toBeUndefined();
    expect(spec('theme', 'currentViewID').type).toBe('string');
    expect(spec('theme', 'version')).toMatchObject({ type: 'float', default: 1, access: 'r' });
  });

  it('BUTTONELEMENT keeps only the ambient attributes spec 6.6 allows', () => {
    for (const a of ['id', 'enabled', 'tabStop', 'accName']) expect(attrSpec('buttonelement', a), a).toBeDefined();
    for (const a of ['left', 'width', 'visible', 'zIndex', 'alphaBlend', 'passThrough']) {
      expect(attrSpec('buttonelement', a), a).toBeUndefined();
    }
    expect(spec('buttonelement', 'mappingColor')).toMatchObject({ type: 'color', default: null });
    expect(spec('buttonelement', 'onclick').type).toBe('handler');
  });

  it('colour attributes without a documented default are null; documented ones are typed', () => {
    expect(spec('button', 'transparencyColor').default).toBeNull();
    expect(spec('buttongroup', 'transparencyColor').default).toBe('none');
    expect(spec('slider', 'foregroundColor').default).toBe(0xffffff);
    expect(spec('text', 'foregroundColor').default).toBe(0x000000);
    expect(spec('text', 'backgroundColor').default).toBe('none');
    expect(spec('text', 'hoverForegroundColor').default).toBeNull();
    expect(spec('playlist', 'itemPlayingColor').default).toBe(0x00ff00);
    expect(spec('playlist', 'itemPlayingBackgroundColor').default).toBe(0x222222);
    expect(spec('playlist', 'itemErrorColor').default).toBe(0xff0000);
    expect(spec('playlist', 'disabledItemColor').default).toBe(SYSTEM_COLORS.get('graytext'));
  });

  it('SLIDER, CUSTOMSLIDER and TEXT (spec 6.7, 6.8, 6.10)', () => {
    expect(spec('slider', 'min').default).toBe(0);
    expect(spec('slider', 'max').default).toBe(100);
    expect(spec('slider', 'slide').default).toBe(true);
    expect(spec('slider', 'tiled').default).toBe(false);
    expect(spec('slider', 'direction').type).toEqual({ enum: ['horizontal', 'vertical'] });
    expect(spec('slider', 'thumbImage').type).toBe('image');
    expect(spec('slider', 'onDragEnd').type).toBe('handler');
    expect(spec('slider', 'ondragend')).toBe(spec('slider', 'onDragEnd'));
    expect(spec('customslider', 'positionImage').type).toBe('image');
    expect(attrSpec('customslider', 'direction')).toBeUndefined(); // ignored cargo (spec 6.8)
    expect(spec('text', 'fontSize').default).toBe(10);
    expect(spec('text', 'scrollingAmount').default).toBe(6);
    expect(spec('text', 'scrollingDelay').default).toBe(85);
    expect(spec('text', 'justification').type).toEqual({ enum: ['Left', 'Right', 'Center'] });
    expect(spec('text', 'textWidth').access).toBe('r');
    expect(spec('text', 'value').type).toBe('string');
  });

  it('PROGRESSBAR has the SLIDER table (spec 6.9)', () => {
    const sort = (/** @type {any[]} */ l) => [...l].sort((a, b) => a.name.localeCompare(b.name));
    expect(sort(attrSpecsOf('progressbar'))).toEqual(sort(attrSpecsOf('slider')));
  });

  it('the remaining per-kind tables carry the attributes the spec names', () => {
    expect(spec('buttongroup', 'mappingImage').type).toBe('image');
    expect(spec('buttongroup', 'showBackground').default).toBe(false);
    expect(spec('button', 'sticky').default).toBe(false);
    expect(spec('effects', 'currentEffectType').type).toBe('string');
    expect(spec('effects', 'currentPreset').type).toBe('int');
    expect(spec('effects', 'windowed')).toMatchObject({ type: 'bool', default: false, access: 'r' });
    expect(spec('video', 'windowless').default).toBe(false);
    expect(spec('video', 'zoom').default).toBe(100);
    expect(spec('video', 'onVideoStart').type).toBe('handler');
    expect(spec('playlist', 'columns').type).toBe('string');
    expect(spec('playlist', 'columnsVisible').default).toBe(true);
    expect(spec('playlist', 'dropDownList').type).toMatchObject({ enum: expect.arrayContaining(['showAll', 'showQueries']) });
    expect(spec('editbox', 'editStyle').default).toBe('normal');
    expect(spec('listbox', 'selectedItem').type).toBe('int');
    expect(spec('item', 'value').type).toBe('string');
    for (let i = 1; i <= 10; i++) expect(spec('equalizersettings', `gainLevel${i}`)).toMatchObject({ type: 'float', default: 0 });
    expect(spec('equalizersettings', 'enableSplineTension').default).toBe(true);
    expect(spec('equalizersettings', 'splineTension').default).toBe(3);
    expect(spec('videosettings', 'contrast').type).toBe('int');
    expect(spec('mediacenter', 'effectPreset').type).toBe('int');
    expect(spec('controls', 'currentPosition').type).toBe('float');
    expect(spec('settings', 'volume').type).toBe('int');
    expect(spec('player', 'url').type).toBe('string');
    expect(spec('unknown', 'id').type).toBe('string');
    expect(attrSpec('unknown', 'left')).toBeUndefined();
  });
});

describe('attrSpec: handlers', () => {
  it('ambient events exist on visual kinds, with the kind-specific ones where they belong', () => {
    for (const e of ['onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmousemove', 'onmouseover', 'onmouseout',
      'onkeydown', 'onkeypress', 'onkeyup', 'onfocus', 'onblur', 'onresize', 'onendmove', 'onendalphablend']) {
      expect(spec('subview', e).type, e).toBe('handler');
      expect(spec('button', e).type, e).toBe('handler');
    }
    expect(attrSpec('button', 'onDragEnd')).toBeUndefined();
    expect(attrSpec('button', 'onload')).toBeUndefined();
    expect(attrSpec('subview', 'onload')).toBeUndefined();
    for (const e of ['onload', 'onclose', 'ontimer', 'onerror']) expect(spec('view', e).type, e).toBe('handler');
    expect(attrSpec('button', 'onclik')).toBeUndefined(); // a typo is an unknown attribute
  });

  it('<attr>_onchange is a handler on every kind but THEME and AUTOMENU', () => {
    expect(spec('slider', 'value_onchange')).toMatchObject({ name: 'value_onchange', type: 'handler' });
    expect(spec('slider', 'VALUE_ONCHANGE').name).toBe('value_onchange');
    expect(spec('text', 'toolTip_onchange').name).toBe('toolTip_onchange');
    expect(spec('text', 'tooltip_onchange').name).toBe('toolTip_onchange');
    expect(spec('player', 'OpenState_onchange').type).toBe('handler');
    expect(spec('controls', 'currentPosition_onchange').type).toBe('handler');
    expect(spec('mediacenter', 'videoZoom_onchange').type).toBe('handler');
    expect(spec('equalizersettings', 'gainLevel1_onchange').type).toBe('handler');
    expect(attrSpec('slider', '_onchange')).toBeUndefined();
    expect(attrSpec('slider', 'a b_onchange')).toBeUndefined();
    expect(attrSpec('theme', 'title_onchange')).toBeUndefined();
    expect(attrSpec('automenu', 'visible_onchange')).toBeUndefined();
  });

  it('a PLAYER takes its events bare or with an on prefix', () => {
    for (const e of PLAYER_EVENTS.values()) {
      expect(spec('player', e.name).type, e.name).toBe('handler');
      expect(spec('player', e.name.toUpperCase()).type, e.name).toBe('handler');
      expect(spec('player', `on${e.name}`).type, e.name).toBe('handler');
    }
    expect(attrSpec('button', 'playstatechange')).toBeUndefined();
  });
});

const MOUSE_KEY_CLICK = [
  'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmousemove', 'onmouseover', 'onmouseout',
  'onkeydown', 'onkeypress', 'onkeyup',
];

describe('PLAYLIST is a native control: what the docs say it does not support is not in its table (spec 5.6, 6.13)', () => {
  it.each(['zIndex', 'clippingImage', 'clippingColor', 'passThrough', 'alphaBlend'])('has no %s', (attr) => {
    expect(attrSpec('playlist', attr), attr).toBeUndefined();
    expect(attrSpec('playlist', attr.toUpperCase()), attr).toBeUndefined();
    expect(attrSpecFor('playlist', attr, 'script'), attr).toBeUndefined();
    // The same attribute stays on a kind that does support it.
    expect(attrSpec('button', attr), `button.${attr}`).toBeDefined();
  });

  it.each(MOUSE_KEY_CLICK)('has no %s handler', (event) => {
    expect(attrSpec('playlist', event), event).toBeUndefined();
    expect(attrSpec('playlist', event.toUpperCase()), event).toBeUndefined();
  });

  it.each(['onfocus', 'onblur', 'onresize', 'onendmove', 'onendalphablend'])('keeps the %s handler', (event) => {
    expect(spec('playlist', event)).toEqual({ name: event, type: 'handler', default: '', access: 'rw' });
    expect(spec('playlist', event.toUpperCase())).toBe(spec('playlist', event));
  });

  it('keeps <attr>_onchange', () => {
    expect(spec('playlist', 'columns_onchange')).toMatchObject({ name: 'columns_onchange', type: 'handler' });
    expect(spec('playlist', 'ITEMCOUNT_ONCHANGE').name).toBe('itemCount_onchange');
  });

  it('keeps the other ambient attributes and its own', () => {
    for (const a of [
      'id', 'left', 'top', 'right', 'bottom', 'width', 'height', 'visible', 'enabled', 'tabStop', 'horizontalAlignment',
      'verticalAlignment', 'resizeImages', 'nineGridMargins', 'elementType', 'accName', 'accDescription', 'accKeyboardShortcut',
      'playlist', 'columns', 'columnsVisible', 'itemPlayingColor', 'backgroundColor', 'foregroundColor', 'itemCount',
    ]) expect(attrSpec('playlist', a), a).toBeDefined();
    expect(spec('playlist', 'visible').default).toBe(true);
    expect(spec('playlist', 'id')).toMatchObject({ type: 'string', access: 'r' });
  });

  it('the predefined playlist tags only default attributes that survive', () => {
    for (const tag of ['dropdownplaylist', 'itemsplaylist']) {
      for (const key of resolveTag(tag).defaults.keys()) expect(attrSpec('playlist', key), `${tag}.${key}`).toBeDefined();
    }
  });
});

describe('AUTOMENU keeps only id, left, top, visible and elementType (spec 6.18)', () => {
  it('has exactly those five attributes', () => {
    expect(attrSpecsOf('automenu').map((s) => s.name).sort()).toEqual(['elementType', 'id', 'left', 'top', 'visible']);
  });

  it('types and defaults', () => {
    expect(spec('automenu', 'id')).toEqual({ name: 'id', type: 'string', default: '', access: 'r' });
    expect(spec('automenu', 'left')).toEqual({ name: 'left', type: 'int', default: 0, access: 'rw' });
    expect(spec('automenu', 'top')).toEqual({ name: 'top', type: 'int', default: 0, access: 'rw' });
    expect(spec('automenu', 'visible')).toEqual({ name: 'visible', type: 'bool', default: false, access: 'rw' });
    expect(spec('automenu', 'elementType')).toEqual({ name: 'elementType', type: 'string', default: '', access: 'r' });
  });

  it.each([
    'right', 'bottom', 'width', 'height', 'zIndex', 'enabled', 'tabStop', 'horizontalAlignment', 'verticalAlignment',
    'alphaBlend', 'clippingImage', 'clippingColor', 'passThrough', 'resizeImages', 'nineGridMargins',
    'accName', 'accDescription', 'accKeyboardShortcut',
  ])('has no %s', (attr) => {
    expect(attrSpec('automenu', attr), attr).toBeUndefined();
  });

  it('has no ambient event', () => {
    for (const e of [...MOUSE_KEY_CLICK, 'onfocus', 'onblur', 'onresize', 'onendmove', 'onendalphablend']) {
      expect(attrSpec('automenu', e), e).toBeUndefined();
    }
    expect(attrSpecsOf('automenu').filter((s) => s.type === 'handler')).toEqual([]);
    expect(attrSpec('automenu', 'visible_onchange')).toBeUndefined();
    expect(attrSpec('automenu', 'LEFT_ONCHANGE')).toBeUndefined();
    expect(attrSpec('automenu', 'top_onchange')).toBeUndefined();
  });
});

describe('PLAYER_EVENTS: parameter names in exact case (spec 2.2, 6.19)', () => {
  it('has the documented parameters', () => {
    const params = (/** @type {string} */ k) => PLAYER_EVENTS.get(k)?.params;
    expect(params('playstatechange')).toEqual(['NewState']);
    expect(params('openstatechange')).toEqual(['NewState']);
    expect(params('modechange')).toEqual(['ModeName', 'NewValue']);
    expect(params('scriptcommand')).toEqual(['scType', 'Param']);
    expect(params('positionchange')).toEqual(['oldPosition', 'newPosition']);
    expect(params('playlistchange')).toEqual(['Playlist', 'change']);
    expect(params('currentplaylistchange')).toEqual(['change']);
    expect(params('mediachange')).toEqual(['Item']);
    expect(params('cdrommediachange')).toEqual(['CdromNum']);
    expect(params('markerhit')).toEqual(['MarkerNum']);
    expect(params('buffering')).toEqual(['Start']);
    expect(params('currentmediaitemavailable')).toEqual(['bstrItemName']);
    expect(params('statuschange')).toEqual([]);
    expect(PLAYER_EVENTS.get('playstatechange')?.name).toBe('PlayStateChange');
  });

  it('is keyed in lowercase and never answers for inherited names', () => {
    for (const k of PLAYER_EVENTS.keys()) expect(k).toBe(k.toLowerCase());
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(PLAYER_EVENTS.get(k), k).toBeUndefined();
  });
});

describe('attrSpec: lookups keyed by skin strings', () => {
  it('does not find inherited members for __proto__, constructor and friends', () => {
    const keys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'prototype'];
    for (const kind of KINDS) {
      for (const key of keys) {
        expect(attrSpec(kind, key), `${kind}.${key}`).toBeUndefined();
        expect(attrSpecFor(kind, key, 'sidecar'), `${kind}.${key}`).toBeUndefined();
      }
    }
  });

  it('an unknown kind has no attributes', () => {
    expect(attrSpec(/** @type {any} */ ('__proto__'), 'left')).toBeUndefined();
    expect(attrSpec(/** @type {any} */ ('constructor'), 'left')).toBeUndefined();
    expect(attrSpec(/** @type {any} */ ('nope'), 'left')).toBeUndefined();
  });

  it('every kind in the contract has a table', () => {
    for (const kind of KINDS) expect(attrSpecsOf(kind).length, kind).toBeGreaterThan(0);
  });
});

describe('the tables agree with coerce', () => {
  it.each(KINDS)('%s: every default is a value of its own type, and coerce leaves it alone', (kind) => {
    const sentinel = Symbol('kept');
    for (const s of attrSpecsOf(kind)) {
      const where = `${kind}.${s.name}`;
      const d = s.default;
      if (d !== null) expect(coerce(s.type, d, sentinel), where).toEqual(d);
      if (typeof s.type === 'object') {
        if (d !== null) expect(s.type.enum, where).toContain(d);
        continue;
      }
      switch (s.type) {
        case 'int': expect(Number.isInteger(d), where).toBe(true); break;
        case 'float': expect(typeof d === 'number' && Number.isFinite(d), where).toBe(true); break;
        case 'bool': expect(typeof d, where).toBe('boolean'); break;
        case 'color':
          expect(d === null || d === 'none' || d === 'auto' || (Number.isInteger(d) && /** @type {number} */ (d) >= 0 && /** @type {number} */ (d) <= 0xffffff), where).toBe(true);
          break;
        case 'string': case 'image': case 'handler': case 'cursor':
          expect(d === null || typeof d === 'string', where).toBe(true);
          break;
        default: throw new Error(`${where}: unexpected type`);
      }
    }
  });

  it('names are unique per kind and every one resolves back to itself', () => {
    for (const kind of KINDS) {
      const specs = attrSpecsOf(kind);
      const lower = specs.map((s) => s.name.toLowerCase());
      expect(new Set(lower).size, kind).toBe(lower.length);
      for (const s of specs) expect(attrSpec(kind, s.name), `${kind}.${s.name}`).toBe(s);
    }
  });
});

describe('host-only x- attributes (E D10.6)', () => {
  const ORIGINS = /** @type {const} */ (['init', 'layout', 'script', 'binding', 'user', 'anim', 'host']);

  it('are never returned by attrSpec, so markup cannot set them', () => {
    expect(attrSpec('slider', 'x-foregroundMode')).toBeUndefined();
    expect(attrSpec('slider', 'X-FOREGROUNDMODE')).toBeUndefined();
    expect(attrSpec('progressbar', 'x-foregroundMode')).toBeUndefined();
  });

  it('resolve only for origin sidecar', () => {
    const s = attrSpecFor('slider', 'x-foregroundMode', 'sidecar');
    expect(s).toEqual({ name: 'x-foregroundMode', type: { enum: ['progress', 'playhead'] }, default: 'progress', access: 'rw' });
    expect(attrSpecFor('slider', 'X-FOREGROUNDMODE', 'sidecar')).toBe(s);
    expect(attrSpecFor('progressbar', 'x-foregroundMode', 'sidecar')).toMatchObject({ name: 'x-foregroundMode' });
    for (const origin of ORIGINS) {
      expect(attrSpecFor('slider', 'x-foregroundMode', origin), origin).toBeUndefined();
    }
  });

  it('exist only where defined', () => {
    expect(attrSpecFor('button', 'x-foregroundMode', 'sidecar')).toBeUndefined();
    expect(attrSpecFor('slider', 'x-nothing', 'sidecar')).toBeUndefined();
    expect(attrSpecFor('slider', 'x-', 'sidecar')).toBeUndefined();
  });

  it('x-foregroundMode values coerce like an enum', () => {
    const s = /** @type {import('../../../src/engine/contracts').AttrSpec} */ (attrSpecFor('slider', 'x-foregroundMode', 'sidecar'));
    expect(coerce(s.type, 'PLAYHEAD', 'progress')).toBe('playhead');
    expect(coerce(s.type, 'sideways', 'progress')).toBe('progress');
  });

  it('isHostOnlyAttr recognises the x- prefix only', () => {
    expect(isHostOnlyAttr('x-foregroundMode')).toBe(true);
    expect(isHostOnlyAttr('X-a')).toBe(true);
    for (const name of ['xforeground', 'foreground-x', 'x', '', 'ax-b']) expect(isHostOnlyAttr(name), name).toBe(false);
  });

  it('attrSpecFor delegates to attrSpec for everything else, whatever the origin', () => {
    for (const origin of ORIGINS) expect(attrSpecFor('button', 'upToolTip', origin)).toBe(attrSpec('button', 'upToolTip'));
    expect(attrSpecFor('button', 'upToolTip', 'sidecar')).toBe(attrSpec('button', 'upToolTip'));
    expect(attrSpecFor('button', 'nothing', 'sidecar')).toBeUndefined();
  });
});

describe('SYSTEM_COLORS', () => {
  it('holds the classic Windows names the docs use for defaults', () => {
    for (const k of ['graytext', 'highlight', 'highlighttext', 'buttonface', 'buttontext', 'windowtext']) expect(SYSTEM_COLORS.has(k), k).toBe(true);
    expect(SYSTEM_COLORS.get('graytext')).toBe(0x808080);
    for (const k of ['__proto__', 'constructor']) expect(SYSTEM_COLORS.get(k)).toBeUndefined();
  });
});
