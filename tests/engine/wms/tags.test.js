// @ts-check
import { describe, expect, it } from 'vitest';
import { knownTags, resolveTag } from '../../../src/engine/wms/tags.js';
import { attrSpec } from '../../../src/engine/wms/attrs.js';
import { classifyValue, coerce } from '../../../src/engine/wms/values.js';

/** @typedef {import('../../../src/engine/contracts').ElementKind} ElementKind */

// The base tags: the tag is its own kind and carries no defaults.
const BASE_KINDS = [
  'theme', 'view', 'subview', 'button', 'buttongroup', 'buttonelement', 'slider', 'customslider', 'progressbar',
  'text', 'effects', 'video', 'playlist', 'equalizersettings', 'videosettings', 'player', 'controls', 'settings',
  'mediacenter', 'automenu', 'listbox', 'popup', 'item', 'editbox',
];

// The transport family, written out per stem: tag stem, Controls method, tooltip (spec 6.4, 6.6).
const TRANSPORT = [
  ['play', 'play', 'Play'], ['pause', 'pause', 'Pause'], ['stop', 'stop', 'Stop'], ['next', 'next', 'Next'],
  ['prev', 'previous', 'Previous'], ['ffwd', 'fastForward', 'Fast Forward'], ['rew', 'fastReverse', 'Fast Reverse'],
];

/** @param {string} method @param {string} tip */
const transportDefaults = (method, tip) => ({
  onclick: `jscript:player.controls.${method}()`,
  uptooltip: tip,
  cursor: 'system',
  enabled: `wmpenabled:player.controls.${method}`,
});

/** @type {Record<string, [ElementKind, Record<string, string>]>} one entry per predefined tag (G23, spec 6.4-6.15) */
const PREDEFINED = {
  closebutton: ['button', { onclick: 'jscript:view.close();', uptooltip: 'Close' }],
  minimizebutton: ['button', { onclick: 'jscript:view.minimize();', uptooltip: 'Minimize' }],
  returnbutton: ['button', { onclick: 'jscript:view.returnToMediaCenter();', uptooltip: 'Return to Full Mode' }],
  imagebutton: ['button', { cursor: 'Hand' }],
  mutebutton: ['button', {
    onclick: 'jscript:player.settings.mute=down;', uptooltip: 'Mute', downtooltip: 'Sound',
    down: 'wmpprop:player.settings.mute', sticky: 'true',
  }],
  repeatbutton: ['button', {
    onclick: "jscript:player.settings.setMode('loop',down);", uptooltip: 'Turn Repeat On', downtooltip: 'Turn Repeat Off',
    down: "wmpprop:player.settings.getMode('loop')", sticky: 'true',
  }],
  shufflebutton: ['button', {
    onclick: "jscript:player.settings.setMode('shuffle',down);", uptooltip: 'Turn Shuffle On', downtooltip: 'Turn Shuffle Off',
    down: "wmpprop:player.settings.getMode('shuffle')", sticky: 'true',
  }],
  playerelement: ['buttonelement', transportDefaults('play', 'Play')],
  balanceslider: ['slider', {
    tooltip: 'Balance', max: '100', min: '-100', value: 'wmpprop:player.settings.balance',
    value_onchange: 'jscript:player.settings.balance=value;',
  }],
  seekslider: ['slider', {
    tooltip: 'Seek', min: '0', max: 'wmpprop:player.currentMedia.duration',
    value: 'wmpprop:player.controls.currentPosition', foregroundprogress: 'wmpprop:player.network.downloadProgress',
    useforegroundprogress: 'true', ondragend: 'jscript:player.controls.currentPosition=value;',
  }],
  volumeslider: ['slider', {
    tooltip: 'Volume', min: '0', max: '100', value: 'wmpprop:player.settings.volume',
    value_onchange: 'jscript:player.settings.volume=value; player.settings.mute=false;',
  }],
  currentpositiontext: ['text', { value: 'wmpprop:player.controls.currentPositionString', tabstop: 'true', justification: 'right' }],
  durationtext: ['text', { value: 'wmpprop:player.currentMedia.DurationString', tabstop: 'true', justification: 'right' }],
  statustext: ['text', { value: 'wmpprop:player.status', tabstop: 'true' }],
  tracknametext: ['text', { value: 'wmpprop:player.currentMedia.name', tabstop: 'true' }],
  dropdownplaylist: ['playlist', { playlistitemsvisible: 'false' }],
  itemsplaylist: ['playlist', {
    backgroundcolor: 'black', columns: 'name=Name;Duration=Time', columnsvisible: 'false',
    dropdownvisible: 'false', foregroundcolor: 'white',
  }],
  wmpeffects: ['effects', {
    horizontalalignment: 'stretch', verticalalignment: 'stretch', height: '200', width: '250',
    tabstop: 'false', onclick: 'next();',
  }],
  wmpvideo: ['video', { backgroundcolor: 'black', horizontalalignment: 'stretch', verticalalignment: 'stretch' }],
};
for (const [stem, method, tip] of TRANSPORT) {
  PREDEFINED[`${stem}button`] = ['button', transportDefaults(method, tip)];
  PREDEFINED[`${stem}element`] = ['buttonelement', transportDefaults(method, tip)];
}

// The tags survey G23 names (the card's "one case per tag in G23"). Each must be in PREDEFINED, or
// be progressbar (a base kind with no defaults).
const G23 = [
  'itemsplaylist', 'volumeslider', 'returnbutton', 'playbutton', 'pausebutton', 'stopbutton', 'prevbutton',
  'nextbutton', 'rewbutton', 'ffwdbutton', 'mutebutton', 'playelement', 'stopelement', 'prevelement',
  'nextelement', 'seekslider', 'balanceslider', 'progressbar', 'currentpositiontext', 'durationtext',
  'statustext', 'tracknametext', 'wmpvideo', 'wmpeffects',
];

const entries = (/** @type {ReadonlyMap<string, string>} */ map) => Object.fromEntries(map);

describe('resolveTag: predefined tags (G23)', () => {
  it.each(Object.entries(PREDEFINED))('%s has its base kind and defaults', (tag, [kind, defaults]) => {
    const schema = resolveTag(tag);
    expect(schema.tag).toBe(tag);
    expect(schema.kind).toBe(kind);
    expect(entries(schema.defaults)).toEqual(defaults);
  });

  it.each(G23)('G23 tag %s is covered', (tag) => {
    expect(tag in PREDEFINED || tag === 'progressbar', tag).toBe(true);
  });

  it('progressbar is its own kind with no defaults (spec 6.9)', () => {
    const schema = resolveTag('progressbar');
    expect(schema.kind).toBe('progressbar');
    expect(schema.defaults.size).toBe(0);
  });

  it('the table has exactly the base tags and the predefined tags above', () => {
    expect(new Set(knownTags())).toEqual(new Set([...BASE_KINDS, ...Object.keys(PREDEFINED)]));
  });
});

describe('resolveTag: base tags', () => {
  it.each(BASE_KINDS)('%s is its own kind with no defaults', (tag) => {
    const schema = resolveTag(tag);
    expect(schema.kind).toBe(tag);
    expect(schema.tag).toBe(tag);
    expect(schema.defaults.size).toBe(0);
  });

  it('is case-insensitive and reports the lowercase tag', () => {
    const upper = resolveTag('PlayButton');
    expect(upper.tag).toBe('playbutton');
    expect(upper.kind).toBe('button');
    expect(entries(upper.defaults)).toEqual(PREDEFINED.playbutton[1]);
    expect(resolveTag('SUBVIEW').kind).toBe('subview');
  });

  it.each(['network', 'currentmedia', 'currentplaylist', 'bars', 'column', 'playerapplication', 'mediaCenterX', ''])(
    'tag %j is unknown, inert, with no defaults',
    (tag) => {
      const schema = resolveTag(tag);
      expect(schema.kind).toBe('unknown');
      expect(schema.defaults.size).toBe(0);
    },
  );

  it('does not find inherited members for the keys __proto__ and constructor', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
      const schema = resolveTag(key);
      expect(schema.kind, key).toBe('unknown');
      expect(schema.tag, key).toBe(key.toLowerCase());
      expect(schema.defaults.size, key).toBe(0);
      expect(Object.getPrototypeOf(schema.defaults)).toBe(Map.prototype);
    }
  });
});

describe('resolveTag: defaults are shared, so they are read-only', () => {
  it('refuses writes to a defaults map and freezes the schema', () => {
    const schema = resolveTag('playbutton');
    expect(Object.isFrozen(schema)).toBe(true);
    expect(() => /** @type {Map<string, string>} */ (schema.defaults).set('onclick', 'x')).toThrow(TypeError);
    expect(() => /** @type {Map<string, string>} */ (schema.defaults).delete('onclick')).toThrow(TypeError);
    expect(() => /** @type {Map<string, string>} */ (schema.defaults).clear()).toThrow(TypeError);
    expect(resolveTag('playbutton').defaults.get('onclick')).toBe('jscript:player.controls.play()');
    expect(() => /** @type {Map<string, string>} */ (resolveTag('nothing').defaults).set('a', 'b')).toThrow(TypeError);
  });
});

describe('predefined defaults are consistent with the attribute and value tables', () => {
  const rows = Object.entries(PREDEFINED).flatMap(([tag, [kind, defaults]]) => Object.entries(defaults).map(([key, value]) => [tag, kind, key, value]));

  it.each(rows)('%s: default %s.%s is a known attribute of its kind', (_tag, kind, key) => {
    expect(attrSpec(kind, key), `${kind}.${key}`).toBeDefined();
  });

  it.each(rows)('%s (%s): default %s classifies as written', (_tag, kind, key, value) => {
    const source = classifyValue(kind, key, value);
    if (attrSpec(kind, key)?.type === 'handler') {
      expect(source).toMatchObject({ kind: 'handler', source: value });
    } else if (/^wmpprop:/.test(value)) {
      expect(source.kind).toBe('wmpprop');
    } else if (/^wmpenabled:/.test(value)) {
      expect(source.kind).toBe('wmpenabled');
    } else {
      expect(source).toEqual({ kind: 'literal', text: value });
    }
  });

  it.each(rows)('%s (%s): literal default %s coerces to its attribute type', (_tag, kind, key, value) => {
    const spec = attrSpec(kind, key);
    if (!spec || spec.type === 'handler' || /^(wmpprop|wmpenabled):/.test(value)) return;
    const sentinel = Symbol('kept');
    expect(coerce(spec.type, value, sentinel), `${kind}.${key}=${value}`).not.toBe(sentinel);
  });

  it('every wmpenabled default names the method its onclick calls', () => {
    for (const [tag, [, defaults]] of Object.entries(PREDEFINED)) {
      if (!defaults.enabled) continue;
      const call = /player\.controls\.(\w+)\(\)/.exec(defaults.onclick)?.[1];
      const source = classifyValue('button', 'enabled', defaults.enabled);
      expect(source, tag).toMatchObject({ kind: 'wmpenabled', method: String(call).toLowerCase() });
    }
  });
});
