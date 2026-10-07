// @ts-check
import { describe, expect, it } from 'vitest';
import { attrSpecsOf } from '../../../src/engine/wms/attrs.js';
import {
  ELEMENT_KINDS, EQ_BANDS, INERT_PLAYER_OBJECTS, MEDIACENTER_KEYS, SCHEMA, apiName, apiPrefix, classMembers, elementClassName, lookupMember,
} from '../../../src/engine/model/schema.js';

const IMPLS = new Set(['live', 'emulated', 'stub', 'denied']);
const POLICIES = new Set(['deny-log', 'gesture-only', 'rate-mpd', 'pref-caps', 'timer-caps', 'view-current-only']);
const TYPES = new Set(['number', 'string', 'bool', 'object', 'void']);
const SOURCES = new Set(['media.state', 'media.position', 'media.duration', 'media.song', 'media.volume', 'media.mode', 'media.queue',
  'media.bitrate', 'media.avail', 'settings.mute', 'dsp.eq', 'dsp.balance', 'mediacenter', 'effects', 'local']);

describe('the schema is well formed', () => {
  it('has every class the contract names', () => {
    for (const name of ['player', 'controls', 'settings', 'media', 'network', 'playlistObj', 'theme', 'view', 'event', 'mediacenter', 'eq', 'vidset']) {
      expect(SCHEMA.has(name), name).toBe(true);
    }
    for (const kind of ELEMENT_KINDS) expect(SCHEMA.has(elementClassName(kind)), kind).toBe(true);
    expect(SCHEMA.has('playerApplication')).toBe(true);
    expect(SCHEMA.has('inert')).toBe(true);
  });

  it('keys are the lowercased member names, every spec is complete, and nothing is mutable', () => {
    for (const [className, table] of SCHEMA) {
      for (const [key, spec] of table) {
        const where = `${className}.${spec.name}`;
        expect(key, where).toBe(spec.name.toLowerCase());
        expect(['prop', 'method', 'event'], where).toContain(spec.kind);
        expect(TYPES.has(spec.type), where).toBe(true);
        expect(IMPLS.has(spec.impl), where).toBe(true);
        if (spec.kind !== 'method') expect(['r', 'rw'], where).toContain(spec.access);
        if (spec.policy) expect(POLICIES.has(spec.policy), where).toBe(true);
        if (spec.changeSource) expect(SOURCES.has(spec.changeSource), `${where}: ${spec.changeSource}`).toBe(true);
        expect(Object.isFrozen(spec), where).toBe(true);
        if (spec.stubValue !== undefined) {
          expect(spec.impl, where).toBe('stub');
          expect(typeof spec.stubValue, where).toBe(spec.type === 'bool' ? 'boolean' : spec.type);
        }
      }
      expect(() => /** @type {Map<string, unknown>} */ (/** @type {unknown} */ (table)).set('x', 1), className).toThrow(/read-only/);
      expect(() => /** @type {Map<string, unknown>} */ (/** @type {unknown} */ (table)).delete('player'), className).toThrow(/read-only/);
    }
    expect(() => /** @type {Map<string, unknown>} */ (/** @type {unknown} */ (SCHEMA)).set('evil', new Map())).toThrow(/read-only/);
  });

  it('the policies sit on the members D6.5 names', () => {
    /** @param {string} cls @param {string} name */
    const policy = (cls, name) => lookupMember(cls, name)?.policy;
    expect(['play', 'pause', 'stop', 'next', 'previous', 'currentPosition'].map((n) => policy('controls', n))).toEqual(Array(6).fill('rate-mpd'));
    expect([policy('settings', 'volume'), policy('settings', 'setMode')]).toEqual(['rate-mpd', 'rate-mpd']);
    expect([policy('view', 'close'), policy('view', 'minimize')]).toEqual(['gesture-only', 'gesture-only']);
    expect(policy('view', 'timerInterval')).toBe('timer-caps');
    expect(policy('theme', 'savePreference')).toBe('pref-caps');
    expect(['openView', 'openViewRelative', 'closeView', 'currentViewID'].map((n) => policy('theme', n))).toEqual(Array(4).fill('view-current-only'));
    expect([policy('player', 'launchURL'), policy('player', 'URL'), policy('media', 'setItemInfo')]).toEqual(Array(3).fill('deny-log'));
  });
});

describe('parity 3.7: every member the Headspace skin touches resolves, in any case, and is live or emulated (acceptance 1)', () => {
  /** [class, member as the skin spells it] */
  const MEMBERS = /** @type {Array<[string, string]>} */ ([
    ['player', 'OpenState'], ['player', 'openstate'], ['player', 'OPENSTATE'], ['player', 'currentMedia'], ['player', 'controls'],
    ['player', 'settings'], ['player', 'network'], ['player', 'playState'], ['player', 'status'],
    ['media', 'ImageSourceWidth'], ['media', 'imageSourceWidth'], ['media', 'imagesourcewidth'], ['media', 'duration'],
    ['controls', 'currentposition'], ['controls', 'currentPosition'], ['controls', 'play'], ['controls', 'pause'], ['controls', 'stop'],
    ['controls', 'next'], ['controls', 'previous'], ['controls', 'isAvailable'], ['controls', 'currentPositionString'],
    ['network', 'downloadProgress'],
    ['settings', 'balance'], ['settings', 'volume'], ['settings', 'mute'], ['settings', 'getMode'], ['settings', 'setMode'],
    ['mediacenter', 'effectType'], ['mediacenter', 'effectPreset'],
    ['element.effects', 'currentEffectType'], ['element.effects', 'currentPreset'], ['element.effects', 'currentPresetTitle'],
    ['element.effects', 'previous'], ['element.effects', 'next'], ['element.effects', 'visible'],
    ['element.video', 'visible'], ['element.video', 'OnVideoStart'], ['element.video', 'OnVideoEnd'],
    ['eq', 'reset'], ...Array.from({ length: 10 }, (_, i) => /** @type {[string, string]} */ (['eq', `gainLevel${i + 1}`])),
    ['element.playlist', 'setColumnResizeMode'], ['element.playlist', 'visible'],
    ['view', 'minimize'], ['view', 'close'], ['view', 'returnToMediaCenter'], ['view', 'width'], ['view', 'height'],
    ['view', 'onload'], ['view', 'onClose'],
    ['element.subview', 'moveto'], ['element.subview', 'moveTo'], ['element.subview', 'left'], ['element.subview', 'top'],
    ['element.subview', 'width'], ['element.subview', 'visible'], ['element.subview', 'onEndMove'],
    ['element.button', 'image'], ['element.button', 'hoverImage'], ['element.button', 'downImage'], ['element.button', 'upToolTip'],
    ['element.button', 'visible'], ['element.button', 'onClick'], ['element.button', 'moveto'],
    ['element.text', 'toolTip'], ['element.text', 'value'], ['element.text', 'tooltip'],
    ['element.slider', 'value'], ['element.slider', 'toolTip'], ['element.slider', 'onDragEnd'], ['element.slider', 'value_onchange'],
    ['element.slider', 'VALUE_ONCHANGE'],
    ['element.buttongroup', 'click'], ['element.buttongroup', 'getButton'], ['element.buttongroup', 'buttonCount'],
  ]);

  it.each(MEMBERS)('%s.%s', (className, name) => {
    const spec = lookupMember(className, name);
    expect(spec, `${className}.${name}`).toBeDefined();
    expect(['live', 'emulated'], `${className}.${name} is ${spec?.impl}`).toContain(spec?.impl);
  });

  it('the schema resolves these names whatever their case', () => {
    expect(lookupMember('player', 'OpenState')).toBe(lookupMember('player', 'openstate'));
    expect(lookupMember('media', 'ImageSourceWidth')).toBe(lookupMember('media', 'IMAGESOURCEWIDTH'));
    expect(lookupMember('element.button', 'UpToolTip')?.name).toBe('upToolTip');
    expect(lookupMember('element.text', 'tooltip')?.name).toBe('toolTip');
  });
});

describe('lookups keyed by skin strings are Maps (E section 1 rule 6)', () => {
  it('constructor, __proto__ and the Object.prototype names are not members of any class', () => {
    for (const className of [...SCHEMA.keys(), 'nope', '__proto__', 'constructor']) {
      for (const name of ['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '']) {
        expect(lookupMember(className, name), `${className}.${name}`).toBeUndefined();
      }
    }
    expect(SCHEMA.get('__proto__')).toBeUndefined();
    expect(SCHEMA.get('constructor')).toBeUndefined();
    expect(classMembers().get('constructor')).toBeUndefined();
  });

  it('classMembers gives lowercased, frozen member lists per class, and a fresh Map each call', () => {
    const a = classMembers();
    const b = classMembers();
    expect(a).not.toBe(b);
    expect(a.get('controls')).toContain('currentposition');
    expect(a.get('player')).toContain('openstate');
    expect([...a.get('controls') ?? []].every((n) => n === n.toLowerCase())).toBe(true);
    expect(Object.isFrozen(a.get('controls'))).toBe(true);
    expect([...a.keys()].sort()).toEqual([...SCHEMA.keys()].sort());
    expect(a.get('inert')).toEqual([]);
  });
});

describe('element classes derive from the attribute tables', () => {
  it('every attribute of a kind is a member of its class, with a script-visible type', () => {
    for (const kind of ELEMENT_KINDS) {
      if (kind === 'equalizersettings' || kind === 'videosettings') continue;
      const className = elementClassName(kind);
      for (const attr of attrSpecsOf(kind)) {
        const spec = lookupMember(className, attr.name);
        expect(spec, `${className}.${attr.name}`).toBeDefined();
        expect(spec?.name).toBe(attr.name);
        if (attr.type === 'handler') {
          expect(spec?.kind).toBe('event');
        } else {
          const expected = attr.type === 'int' || attr.type === 'float' ? 'number' : attr.type === 'bool' ? 'bool' : 'string';
          expect(spec?.type, `${className}.${attr.name}`).toBe(expected);
          expect(spec?.access, `${className}.${attr.name}`).toBe(attr.access);
        }
      }
    }
  });

  it('class names: the view and the two settings elements have their own, the rest are element.<kind>', () => {
    expect(elementClassName('view')).toBe('view');
    expect(elementClassName('equalizersettings')).toBe('eq');
    expect(elementClassName('videosettings')).toBe('vidset');
    expect(elementClassName('button')).toBe('element.button');
    expect(elementClassName('unknown')).toBe('element.unknown');
  });

  it('ambient animation methods exist on the kinds that have geometry, and not on the others', () => {
    for (const kind of ['subview', 'button', 'buttongroup', 'slider', 'text', 'effects', 'video']) {
      for (const verb of ['moveTo', 'slideTo', 'moveSizeTo', 'alphaBlendTo']) expect(lookupMember(elementClassName(/** @type {any} */ (kind)), verb)?.kind, `${kind}.${verb}`).toBe('method');
    }
    expect(lookupMember('element.playlist', 'moveTo')?.kind).toBe('method');
    expect(lookupMember('element.playlist', 'alphaBlendTo')).toBeUndefined();         // windowed controls ignore alpha (spec 5.4)
    expect(lookupMember('element.buttonelement', 'moveTo')).toBeUndefined();          // no geometry of its own
    expect(lookupMember('element.item', 'moveTo')).toBeUndefined();
  });

  it('the VIEW class carries the frame verbs, and its animation is phase 3', () => {
    expect(lookupMember('view', 'close')?.impl).toBe('live');
    expect(lookupMember('view', 'maximize')?.impl).toBe('stub');
    expect(lookupMember('view', 'moveTo')?.impl).toBe('stub');
    expect(lookupMember('view', 'timerInterval')?.policy).toBe('timer-caps');
  });

  it('<attr>_onchange resolves on element classes where the attribute tables accept it, and nowhere else', () => {
    expect(lookupMember('element.slider', 'value_onchange')).toMatchObject({ kind: 'event', type: 'string', impl: 'live' });
    expect(lookupMember('view', 'width_onchange')?.kind).toBe('event');
    expect(lookupMember('element.player', 'OpenState_onchange')?.kind).toBe('event');
    expect(lookupMember('element.theme', 'title_onchange')).toBeUndefined();                    // THEME has no handlers
    expect(lookupMember('element.automenu', 'left_onchange')).toBeUndefined();
    expect(lookupMember('player', 'openstate_onchange')).toBeUndefined();                       // the object, not the element
    expect(lookupMember('element.slider', '_onchange')).toBeUndefined();
    expect(lookupMember('element.slider', 'a b_onchange')).toBeUndefined();
  });
});

describe('the D6 mapping table, class by class', () => {
  it('player: the enums, URL, the inert objects and the denied launch', () => {
    expect(lookupMember('player', 'playState')?.impl).toBe('emulated');
    expect(lookupMember('player', 'URL')).toMatchObject({ impl: 'denied', access: 'rw', policy: 'deny-log' });
    expect(lookupMember('player', 'launchURL')).toMatchObject({ kind: 'method', impl: 'denied' });
    for (const name of INERT_PLAYER_OBJECTS) expect(lookupMember('player', name), name).toMatchObject({ type: 'object', impl: 'stub' });
    expect(lookupMember('player', 'newPlaylist')).toMatchObject({ kind: 'method', type: 'object', impl: 'stub' });
    expect(lookupMember('player', 'versionInfo')?.impl).toBe('live');
  });

  it('controls: scanning is a stub, position is rate-limited', () => {
    expect(['fastForward', 'fastReverse', 'step'].map((n) => lookupMember('controls', n)?.impl)).toEqual(['stub', 'stub', 'stub']);
    expect(lookupMember('controls', 'currentPosition')).toMatchObject({ access: 'rw', policy: 'rate-mpd', changeSource: 'media.position' });
    expect(lookupMember('controls', 'currentPositionString')).toMatchObject({ access: 'r', type: 'string' });
  });

  it('settings: volume and balance are live, mute is emulated, the rest is inert', () => {
    expect(lookupMember('settings', 'volume')?.impl).toBe('live');
    expect(lookupMember('settings', 'balance')?.impl).toBe('live');
    expect(lookupMember('settings', 'mute')?.impl).toBe('emulated');
    for (const name of ['rate', 'autoStart', 'playCount']) expect(lookupMember('settings', name)?.impl, name).toBe('stub');
  });

  it('currentMedia: setItemInfo is denied; image size is constant', () => {
    expect(lookupMember('media', 'setItemInfo')?.impl).toBe('denied');
    expect(lookupMember('media', 'imageSourceHeight')).toMatchObject({ impl: 'emulated', access: 'r' });
  });

  it('theme: preferences, strings and the phase-1 view verbs', () => {
    expect(['savePreference', 'loadPreference', 'loadString', 'logString'].map((n) => lookupMember('theme', n)?.impl)).toEqual(['live', 'live', 'live', 'live']);
    expect(['openDialog', 'playSound', 'showErrorDialog'].map((n) => lookupMember('theme', n)?.impl)).toEqual(['stub', 'stub', 'stub']);
  });

  it('event: the documented properties, read-only', () => {
    for (const name of ['x', 'y', 'clientX', 'clientY', 'offsetX', 'offsetY', 'screenX', 'screenY', 'screenWidth', 'screenHeight', 'button', 'keyCode', 'altKey', 'ctrlKey', 'shiftKey',
      'srcElement', 'fromElement', 'toElement']) {
      expect(lookupMember('event', name), name).toMatchObject({ access: 'r', impl: 'live' });
    }
    expect(lookupMember('event', 'srcElement')?.type).toBe('object');
    expect(lookupMember('event', 'screenWidth')?.type).toBe('number');
    expect(lookupMember('event', 'screenHeight')?.type).toBe('number');
  });

  it('click is live on BUTTONGROUP and BUTTONELEMENT (a queued onclick)', () => {
    expect(lookupMember('element.buttongroup', 'click')).toMatchObject({ kind: 'method', type: 'void', impl: 'live' });
    expect(lookupMember('element.buttonelement', 'click')).toMatchObject({ kind: 'method', type: 'void', impl: 'live' });
  });

  it('mediacenter: the eight documented keys, each with a change source', () => {
    expect([...SCHEMA.get('mediacenter')?.values() ?? []].map((s) => s.name).sort()).toEqual([...MEDIACENTER_KEYS].sort());
    for (const key of MEDIACENTER_KEYS) expect(lookupMember('mediacenter', key)).toMatchObject({ access: 'rw', changeSource: 'mediacenter' });
    expect(MEDIACENTER_KEYS).toHaveLength(8);
  });

  it('eq: ten bands, bypass, and the stubbed rest', () => {
    expect(EQ_BANDS).toBe(10);
    for (let i = 1; i <= 10; i++) expect(lookupMember('eq', `gainLevel${i}`), `gainLevel${i}`).toMatchObject({ type: 'number', access: 'rw', impl: 'live', changeSource: 'dsp.eq' });
    expect(lookupMember('eq', 'gainLevel11')).toBeUndefined();
    expect(lookupMember('eq', 'bypass')).toMatchObject({ type: 'bool', changeSource: 'dsp.eq' });
    expect(lookupMember('eq', 'enableSplineTension')?.impl).toBe('emulated');
    expect(lookupMember('eq', 'truBassLevel')?.impl).toBe('stub');
  });

  it('effects: backed by the host control, one effect', () => {
    for (const name of ['currentEffectType', 'currentEffectTitle', 'currentPreset', 'currentPresetTitle', 'currentEffectPresetCount', 'effectCount']) {
      expect(lookupMember('element.effects', name)?.impl, name).toBe('emulated');
    }
    for (const verb of ['next', 'previous', 'nextPreset', 'previousPreset', 'settings']) expect(lookupMember('element.effects', verb)?.kind, verb).toBe('method');
    expect(lookupMember('element.effects', 'fullScreen')).toMatchObject({ impl: 'stub', stubValue: false });
  });
});

describe('ledger names', () => {
  it('apiPrefix and apiName name members the way the tools rank them', () => {
    expect(apiName('controls', 'next')).toBe('player.controls.next');
    expect(apiName('media', 'setItemInfo')).toBe('player.currentMedia.setItemInfo');
    expect(apiName('settings', 'rate')).toBe('player.settings.rate');
    expect(apiName('player', 'launchURL')).toBe('player.launchURL');
    expect(apiName('element.buttongroup', 'click')).toBe('buttongroup.click');
    expect(apiName('eq', 'gainLevel1')).toBe('equalizerSettings.gainLevel1');
    expect(apiPrefix('view')).toBe('view');
    expect(apiPrefix('something-else')).toBe('something-else');
    expect(apiPrefix('constructor')).toBe('constructor');
  });
});
