// @ts-check
// The literal pass (E §5.3 `buildTheme`; E D5 "Build"; E §10 structural caps). Trees are built by
// hand as raw nodes where a cap or a corner needs exact control, and through the scanner where the
// text itself is the point.
import { describe, expect, it } from 'vitest';
import { buildTheme, DEFAULT_BUILD_CAPS } from '../../../src/engine/wms/build.js';
import { scanWms } from '../../../src/engine/wms/scan.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../../src/engine/contracts').ImageProbe} ImageProbe */
/** @typedef {import('../../../src/engine/contracts').SidecarOverlay} SidecarOverlay */

/** @param {Record<string, string | number>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {RawNode[]} [children] @returns {RawNode} */
const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

/** A VFS over named text or byte files; names are case-folded like the real one. @param {string[]} [names] */
const vfsOf = (names = []) => {
  const files = new Map(names.map((n) => [n.toLowerCase(), new Uint8Array([1])]));
  return {
    sha: '0'.repeat(64), name: 'skin.wmz', diagnostics: [],
    has: (/** @type {string} */ r) => files.has(String(r).toLowerCase()),
    read: (/** @type {string} */ r) => files.get(String(r).toLowerCase()) ?? null,
    list: (/** @type {string | undefined} */ ext) => [...files.keys()].filter((k) => !ext || k.endsWith(ext)),
    resolve: (/** @type {string} */ r) => (files.has(String(r).toLowerCase()) ? String(r).toLowerCase() : null),
  };
};

/** @param {Record<string, [number, number]>} sizes @returns {(ref: string) => ImageProbe | null} */
const probeOf = (sizes) => (ref) => {
  const s = sizes[ref.toLowerCase()];
  return s ? { format: 'bmp', width: s[0], height: s[1] } : null;
};

/**
 * @param {RawNode[]} kids
 * @param {{ view?: Record<string, string | number>, theme?: Record<string, string | number>, names?: string[], probe?: (ref: string) => ImageProbe | null,
 *   overlays?: SidecarOverlay[], caps?: Partial<import('../../../src/engine/contracts').BuildCaps>, stacking?: 'context' | 'flat' }} [o]
 */
const build = (kids, o = {}) => buildTheme(
  N('theme', o.theme ?? {}, [N('view', { id: 'v', width: 100, height: 100, ...o.view }, kids)]),
  vfsOf(o.names),
  { probe: o.probe ?? (() => null), overlays: o.overlays, caps: o.caps, ...(o.stacking ? { stacking: o.stacking } : {}) },
);
/** @param {import('../../../src/engine/contracts').ThemeModel} t @param {string} id @param {number} [view] @returns {ElementModel} */
const el = (t, id, view = 0) => /** @type {ElementModel} */ (t.views[view].byId(id));
/** @param {import('../../../src/engine/contracts').ThemeModel} t @param {string} code */
const diag = (t, code) => t.diagnostics.filter((d) => d.code === code);

describe('the theme', () => {
  it('reads the THEME attributes into meta and builds one model per VIEW in file order', () => {
    const t = buildTheme(N('theme', { author: 'Me', title: 'T', copyright: '(c)', currentViewID: ' second ', id: 'ignored' }, [N('view', { id: 'first' }), N('view', { id: 'second' })]), vfsOf(), { probe: () => null });
    expect(t.meta).toEqual({ author: 'Me', title: 'T', copyright: '(c)', currentViewID: 'second' });
    expect(t.views.map((v) => v.view.id)).toEqual(['first', 'second']);
    expect(t.views.map((v) => v.view.kind)).toEqual(['view', 'view']);
  });

  it('resolves a res:// author and copyright from the string table', () => {
    const t = buildTheme(N('theme', { author: 'res://-/RT_STRING/#1998', copyright: 'res://wmploc/RT_STRING/#1999' }, [N('view')]), vfsOf(), { probe: () => null });
    expect(t.meta.author).toBe('Microsoft Corporation');
    expect(t.meta.copyright).toMatch(/Microsoft/);
    expect(t.meta.currentViewID).toBe(null);
  });

  it('never throws on a missing, empty or wrong root', () => {
    for (const root of [null, N('theme'), N('button'), N('view', { id: 'lone' }), N('theme', {}, [N('button'), N('subview')])]) {
      const t = buildTheme(/** @type {any} */ (root), vfsOf(), { probe: () => null });
      expect(Array.isArray(t.views)).toBe(true);
      expect(t.scriptsFor('anything')).toEqual([]);
    }
    expect(buildTheme(null, vfsOf(), { probe: () => null }).diagnostics.map((d) => d.code)).toEqual(['no-root']);
    const lone = buildTheme(N('view', { id: 'lone' }), vfsOf(), { probe: () => null });
    expect(lone.views.map((v) => v.view.id)).toEqual(['lone']);
    expect(diag(lone, 'root-not-theme')).toHaveLength(1);
    const noView = buildTheme(N('theme', {}, [N('button', { id: 'x' }), N('button', { id: 'y' })]), vfsOf(), { probe: () => null });
    expect(noView.views).toEqual([]);
    expect(diag(noView, 'unexpected-theme-child')).toHaveLength(1); // once per tag
    expect(diag(noView, 'no-view')).toHaveLength(1);
  });

  it('drops a stray element under the theme and keeps the views', () => {
    const t = buildTheme(N('theme', {}, [N('player', { id: 'p' }), N('view', { id: 'v' }, [N('button', { id: 'b' })])]), vfsOf(), { probe: () => null });
    expect(t.views).toHaveLength(1);
    expect(t.views[0].byId('p')).toBeUndefined();
    expect(diag(t, 'unexpected-theme-child')).toHaveLength(1);
  });

  it('treats a VIEW or THEME inside a VIEW as an inert element', () => {
    const t = build([N('view', { id: 'inner' }, [N('button', { id: 'b' })]), N('theme', { id: 't2' })]);
    expect(el(t, 'inner').kind).toBe('unknown');
    expect(el(t, 'inner').tag).toBe('view');
    expect(el(t, 'b').parent).toBe(el(t, 'inner'));
    expect(el(t, 't2').kind).toBe('unknown');
    expect(diag(t, 'nested-view')).toHaveLength(2);
    expect(t.views).toHaveLength(1);
  });
});

describe('tag defaults and value classes', () => {
  it('lays a predefined tag\'s defaults under the skin\'s own attributes', () => {
    const t = build([
      N('playbutton', { id: 'play' }),
      N('playbutton', { id: 'custom', uptooltip: 'Go', cursor: 'hand', onclick: 'mine();' }),
      N('mutebutton', { id: 'mute' }),
    ]);
    const play = el(t, 'play');
    expect(play.kind).toBe('button');
    expect(play.tag).toBe('playbutton');
    expect(play.get('upToolTip')).toBe('Play');
    expect(play.get('cursor')).toBe('system');
    expect(play.source('enabled')).toEqual({ kind: 'wmpenabled', method: 'play' });
    expect(play.get('enabled')).toBe(true); // the binding settles later
    expect(play.handlers.get('onclick')).toMatchObject({ source: 'jscript:player.controls.play()', params: [] });

    const custom = el(t, 'custom');
    expect(custom.get('upToolTip')).toBe('Go');
    expect(custom.get('cursor')).toBe('hand');
    expect(custom.handlers.get('onclick')?.source).toBe('mine();');

    const mute = el(t, 'mute');
    expect(mute.get('sticky')).toBe(true);
    expect(mute.source('down')).toMatchObject({ kind: 'wmpprop', path: { root: 'player', segments: [{ name: 'settings' }, { name: 'mute' }] } });
  });

  it('keeps a jscript: value at its default until the layout pass, and a wmpprop: value too', () => {
    const t = build([N('slider', { id: 's', left: 'jscript:balance.left+3;', top: ' JScript: 4', max: 'wmpprop:player.currentMedia.duration', value: 'wmpprop:player.controls.currentPosition' })]);
    const s = el(t, 's');
    expect(s.get('left')).toBe(0);
    expect(s.source('left')).toEqual({ kind: 'jscript', source: 'balance.left+3;' });
    expect(s.source('top')).toEqual({ kind: 'jscript', source: '4' });
    expect(s.get('max')).toBe(100); // the default
    expect(s.source('max')?.kind).toBe('wmpprop');
    expect(s.source('value')).toMatchObject({ kind: 'wmpprop', path: { root: 'player' } });
    // and it is writable afterwards, as the layout pass and the binding engine do
    expect(s.set('left', 14, 'layout')).toBe(true);
    expect(s.source('left')?.kind).toBe('jscript');
  });

  it('coerces literals (U-20, U-22) and keeps the default for an invalid one, with a diagnostic', () => {
    const t = build([N('button', { id: 'b', width: '600 ', left: '-1', visible: 'ture', tabStop: '1', zIndex: 'x', transparencyColor: 'nonsense', cursor: 'HAND' })]);
    const b = el(t, 'b');
    expect(b.get('width')).toBe(600);
    expect(b.get('left')).toBe(-1);
    expect(b.get('visible')).toBe(true);
    expect(b.get('tabStop')).toBe(true);
    expect(b.get('zIndex')).toBe(0);
    expect(b.get('transparencyColor')).toBe(null);
    expect(b.get('cursor')).toBe('hand');
    const invalid = diag(t, 'invalid-value').map((d) => d.detail);
    expect(invalid).toHaveLength(3);
    expect(invalid.join('\n')).toMatch(/visible="ture"/);
    expect(diag(t, 'invalid-value')[0].elementId).toBe('b');
  });

  it('reports a misspelled binding prefix and keeps the text as a literal (G14)', () => {
    const t = build([N('text', { id: 'x', value: 'wmppprop:player.status' }), N('button', { id: 'y', enabled: 'wmpenable:player.controls.play' }), N('text', { id: 'z', value: 'wmpprop:1+' })]);
    expect(el(t, 'x').get('value')).toBe('wmppprop:player.status');
    expect(el(t, 'x').source('value')).toEqual({ kind: 'literal', text: 'wmppprop:player.status' });
    expect(diag(t, 'misspelled-prefix').map((d) => d.elementId)).toEqual(['x', 'y']);
    expect(diag(t, 'invalid-binding-path')).toHaveLength(1);
  });

  it('resolves a res:// string attribute through the string table and leaves an image URL alone', () => {
    const t = build([
      N('button', { id: 'a', upToolTip: 'res://-/RT_STRING/#1812', image: 'res://wmploc/RT_BITMAP/#521' }),
      N('text', { id: 'b', value: 'res://wmploc.dll/RT_STRING/#9999', fontFace: 'res://-/RT_STRING/#9999' }),
    ]);
    expect(el(t, 'a').get('upToolTip')).toBe('Close');
    expect(el(t, 'a').source('upToolTip')).toEqual({ kind: 'res', url: 'res://-/RT_STRING/#1812' });
    expect(el(t, 'a').get('image')).toBe('res://wmploc/RT_BITMAP/#521');
    expect(el(t, 'b').get('value')).toBe('');
    expect(el(t, 'b').get('fontFace')).toBe('Arial');
    expect(diag(t, 'unresolved-res').length).toBe(3);
  });

  it('registers handlers by lower-case attribute name, with PLAYER parameter names', () => {
    const t = build([
      N('player', { id: 'p', OpenStateChange: 'a(NewState)', onPlayStateChange: 'b(NewState)', PlayState_onchange: 'c()', URL: 'x' }),
      N('button', { id: 'b', onClick: 'x();', value_onchange: 'bogus', onMouseDown: '' }),
      N('slider', { id: 's', value_onchange: 'jscript:y();', onDragEnd: 'z();' }),
    ]);
    const p = el(t, 'p');
    expect([...p.handlers.keys()].sort()).toEqual(['onplaystatechange', 'openstatechange', 'playstate_onchange']);
    expect(p.handlers.get('openstatechange')).toMatchObject({ event: 'openstatechange', source: 'a(NewState)', params: ['NewState'] });
    expect(p.handlers.get('playstate_onchange')?.params).toEqual([]);
    expect(p.get('url')).toBe('x');
    expect([...el(t, 'b').handlers.keys()].sort()).toEqual(['onclick', 'value_onchange']);
    expect(el(t, 's').handlers.get('value_onchange')?.source).toBe('jscript:y();'); // the label is the realm's to strip
    expect(el(t, 's').handlers.get('ondragend')?.source).toBe('z();');
  });

  it('keeps an unknown attribute as inert text, reported once per kind and name', () => {
    const t = build([N('button', { id: 'a', widht: '9', onFoo: 'foo()' }), N('button', { id: 'b', widht: '8' }), N('text', { id: 'c', widht: '7' })]);
    expect(el(t, 'a').handlers.size).toBe(0); // onfoo is not an event a BUTTON has
    expect(el(t, 'a').get('onfoo')).toBe('foo()');
    expect(diag(t, 'unknown-attribute')).toHaveLength(3); // button widht, button onfoo, text widht
    expect(el(t, 'b').get('widht')).toBe('8');
  });

  it('keeps unknown tags as inert nodes that can carry ids and handlers (D5 rule 6)', () => {
    const t = build([N('player', { id: 'pl' }, [N('currentMedia', { id: 'cm', x: '1', onclick: 'q();' })]), N('network', { id: 'net' })]);
    const cm = el(t, 'cm');
    expect(cm.kind).toBe('unknown');
    expect(cm.tag).toBe('currentmedia');
    expect(cm.parent).toBe(el(t, 'pl'));
    expect(cm.handlers.get('onclick')?.source).toBe('q();');
    expect(el(t, 'net').kind).toBe('unknown');
    expect(diag(t, 'unknown-tag').map((d) => d.detail.slice(0, 15))).toEqual(['<currentmedia> ', '<network> is no']);
  });

  it('a nameless VIEW gets a name; resizable follows titleBar unless the skin says otherwise', () => {
    const t = buildTheme(N('theme', {}, [
      N('view', { titleBar: 'false', width: 5, height: 5 }), N('view', { width: 5, height: 5 }),
      N('view', { titleBar: 'false', resizable: 'true', width: 5, height: 5 }),
    ]), vfsOf(), { probe: () => null });
    expect(t.views.map((v) => [v.view.id, v.view.get('titleBar'), v.view.get('resizable')])).toEqual([
      ['Unnamed_view_1', false, false], ['Unnamed_view_2', true, true], ['Unnamed_view_3', false, true],
    ]);
  });

  it('counts the BUTTONELEMENTs of a group and numbers them', () => {
    const t = build([N('buttongroup', { id: 'g' }, [N('buttonelement', { id: 'e0' }), N('playelement', { id: 'e1' }), N('network'), N('buttonelement', { id: 'e2' })])]);
    expect(el(t, 'g').get('buttonCount')).toBe(3);
    expect([el(t, 'e0'), el(t, 'e1'), el(t, 'e2')].map((e) => e.get('index'))).toEqual([0, 1, 2]);
  });

  it('reads `_onchange` from the tag defaults as a handler, not a value', () => {
    const t = build([N('volumeslider', { id: 'vol' })]);
    expect(el(t, 'vol').handlers.get('value_onchange')?.source).toMatch(/player\.settings\.volume=value/);
    expect(el(t, 'vol').source('value')?.kind).toBe('wmpprop');
  });
});

describe('probe-derived sizes (spec 5.1, G21a)', () => {
  const probe = probeOf({ 'bg.bmp': [200, 80], 'btn.bmp': [16, 12], 'track.bmp': [163, 9], 'map.bmp': [30, 20], 'pos.bmp': [55, 40], 'strip.bmp': [715, 40] });

  it('sizes an element from its image when the markup gives no size', () => {
    const t = build([
      N('button', { id: 'b', image: 'BTN.bmp' }), N('slider', { id: 's', backgroundImage: 'track.bmp' }),
      N('subview', { id: 'sv', backgroundImage: 'bg.bmp' }),
      N('buttongroup', { id: 'g', mappingImage: 'map.bmp' }), N('buttongroup', { id: 'g2', image: 'btn.bmp', mappingImage: 'map.bmp' }),
      N('customslider', { id: 'c', image: 'strip.bmp', positionImage: 'pos.bmp' }), N('progressbar', { id: 'p', backgroundImage: 'track.bmp' }),
    ], { probe });
    expect([el(t, 'b').get('width'), el(t, 'b').get('height')]).toEqual([16, 12]);
    expect([el(t, 's').get('width'), el(t, 's').get('height')]).toEqual([163, 9]);
    expect([el(t, 'sv').get('width'), el(t, 'sv').get('height')]).toEqual([200, 80]);
    expect([el(t, 'g').get('width'), el(t, 'g').get('height')]).toEqual([30, 20]); // falls back to the map
    expect([el(t, 'g2').get('width'), el(t, 'g2').get('height')]).toEqual([16, 12]);
    expect([el(t, 'c').get('width'), el(t, 'c').get('height')]).toEqual([55, 40]); // the position map, not the strip
    expect([el(t, 'p').get('width'), el(t, 'p').get('height')]).toEqual([163, 9]);
  });

  it('takes the size of a VIEW without one from its background image', () => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'v', backgroundImage: 'bg.bmp' })]), vfsOf(), { probe });
    expect([t.views[0].view.get('width'), t.views[0].view.get('height')]).toEqual([200, 80]);
    expect(diag(t, 'view-no-size')).toHaveLength(0);
  });

  it('lets a literal size win, one axis at a time, and leaves a scripted size to the layout pass', () => {
    const t = build([
      N('button', { id: 'w', image: 'btn.bmp', width: 30 }), N('button', { id: 'h', image: 'btn.bmp', height: 5 }),
      N('button', { id: 'j', image: 'btn.bmp', width: 'jscript:view.width-10', height: 'wmpprop:foo.bar' }),
      N('button', { id: 'z', image: 'btn.bmp', width: 0 }),
    ], { probe });
    expect([el(t, 'w').get('width'), el(t, 'w').get('height')]).toEqual([30, 12]);
    expect([el(t, 'h').get('width'), el(t, 'h').get('height')]).toEqual([16, 5]);
    expect([el(t, 'j').get('width'), el(t, 'j').get('height')]).toEqual([0, 0]);
    expect(el(t, 'j').source('width')?.kind).toBe('jscript');
    expect([el(t, 'z').get('width'), el(t, 'z').get('height')]).toEqual([0, 12]); // an explicit 0 is a value
  });

  it('does not size from an image it cannot read, a scripted image, a library image or a kind with no image', () => {
    const t = build([
      N('button', { id: 'gone', image: 'missing.bmp' }), N('button', { id: 'scripted', image: 'jscript:"btn.bmp"' }),
      N('button', { id: 'lib', image: 'res://wmploc/RT_BITMAP/#5' }), N('text', { id: 'txt', backgroundImage: 'btn.bmp' }),
      N('button', { id: 'boom', image: 'btn.bmp' }),
    ], { probe: (ref) => { if (ref === 'btn.bmp') throw new Error('probe failed'); return null; } });
    for (const id of ['gone', 'scripted', 'lib', 'txt', 'boom']) expect([el(t, id).get('width'), el(t, id).get('height')], id).toEqual([0, 0]);
  });

  it('calls the probe with the reference as written', () => {
    /** @type {string[]} */
    const asked = [];
    build([N('button', { image: 'Dir\\BTN.BMP' })], { probe: (ref) => { asked.push(ref); return null; } });
    expect(asked).toEqual(['Dir\\BTN.BMP']);
  });

  it('warns about a VIEW with no size at all', () => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'v' }), N('view', { id: 'w', width: 'jscript:1+1', height: 'jscript:1+1' })]), vfsOf(), { probe });
    expect(diag(t, 'view-no-size').map((d) => d.elementId)).toEqual(['v']);
  });
});

describe('ids', () => {
  it('numbers id-less elements per base kind across the whole THEME, in source order', () => {
    const t = buildTheme(N('theme', {}, [
      N('view', { id: 'one' }, [N('button'), N('pausebutton'), N('text'), N('subview', {}, [N('button'), N('text')])]),
      N('view', {}, [N('button'), N('text', { id: 'named' }), N('text')]),
    ]), vfsOf(), { probe: () => null });
    const [a, b] = t.views;
    expect(a.elements.map((e) => e.id)).toEqual([
      'one', 'Unnamed_button_1', 'Unnamed_button_2', 'Unnamed_text_1', 'Unnamed_subview_1', 'Unnamed_button_3', 'Unnamed_text_2',
    ]);
    expect(b.elements.map((e) => e.id)).toEqual(['Unnamed_view_1', 'Unnamed_button_4', 'named', 'Unnamed_text_3']);
    expect(b.byId('unnamed_text_3')).toBeDefined(); // found case-insensitively like any id
  });

  it('trims a declared id and treats a blank one as none', () => {
    const t = build([N('button', { id: '  b  ' }), N('button', { id: '   ' }), N('button', { id: '' })]);
    expect(t.views[0].elements.map((e) => e.id)).toEqual(['v', 'b', 'Unnamed_button_1', 'Unnamed_button_2']);
  });

  it('scopes ids per VIEW: the same id in two views is not a repeat', () => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'a' }, [N('button', { id: 'x', left: 1 })]), N('view', { id: 'b' }, [N('button', { id: 'x', left: 2 })])]), vfsOf(), { probe: () => null });
    expect(t.views[0].byId('x')?.get('left')).toBe(1);
    expect(t.views[1].byId('x')?.get('left')).toBe(2);
    expect(diag(t, 'duplicate-id')).toHaveLength(0);
  });

  it('last declaration wins within a view, and __proto__ and constructor are ordinary ids', () => {
    const t = build([
      N('button', { id: '__proto__', left: 1 }), N('button', { id: '__proto__', left: 2 }),
      N('text', { id: 'constructor' }), N('slider', { id: 'Constructor' }),
    ]);
    expect(el(t, '__proto__').get('left')).toBe(2);
    expect(diag(t, 'duplicate-id').map((d) => d.elementId)).toEqual(['__proto__']);
    expect(diag(t, 'duplicate-id-case').map((d) => d.elementId)).toEqual(['Constructor']);
    expect(el(t, 'constructor').kind).toBe('text');
    expect(el(t, 'Constructor').kind).toBe('slider');
    expect(el(t, 'CONSTRUCTOR').kind).toBe('slider');
  });

  it('a skin id that looks generated is only an id: no crash, and nothing is renumbered', () => {
    const t = build([N('button', { id: 'Unnamed_button_1' }), N('button')]);
    expect(t.views[0].elements.map((e) => e.id)).toEqual(['v', 'Unnamed_button_1', 'Unnamed_button_1']);
  });
});

describe('scriptFile and scriptsFor', () => {
  /** @param {string} scriptFile @param {string[]} names @param {string} [id] */
  const scripts = (scriptFile, names, id = 'v') => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'v', scriptFile }), N('view', { id: 'other' })]), vfsOf(names), { probe: () => null });
    return { t, list: t.scriptsFor(id) };
  };

  it('lists scriptFile entries in order, with library URLs verbatim, tolerating blanks and a trailing ;', () => {
    const { list } = scripts(' a.js ;; b.js;res://wmploc.dll/RT_TEXT/#132;', ['skin.wms', 'a.js', 'b.js']);
    expect(list).toEqual(['a.js', 'b.js', 'res://wmploc.dll/RT_TEXT/#132']);
  });

  it('appends the implicit <stem>.js last when the archive has it and no entry names it', () => {
    expect(scripts('a.js', ['skin.wms', 'a.js', 'skin.js']).list).toEqual(['a.js', 'skin.js']);
    expect(scripts('', ['skin.wms', 'skin.js']).list).toEqual(['skin.js']);
    expect(scripts('', ['skin.wms']).list).toEqual([]); // no such file: nothing to load, nothing to report
    expect(scripts('SKIN.JS;a.js', ['skin.wms', 'skin.js', 'a.js']).list).toEqual(['SKIN.JS', 'a.js']); // already listed, in any case
    expect(scripts('', ['skin.wms', 'skin.js']).t.scriptsFor('other')).toEqual(['skin.js']); // every view
  });

  it('uses the stem of the .wms that pickDefinition chose', () => {
    const { list } = scripts('', ['zed.wms', 'zed.js', 'skin.js']);
    expect(list).toEqual(['zed.js']);
  });

  it('keeps a listed script the archive lacks (the loader skips it) and says so; skips an unknown library', () => {
    const { t, list } = scripts('gone.js;res://wmploc/RT_TEXT/#9999;res://nope.dll/RT_TEXT/#132', ['skin.wms']);
    expect(list).toEqual(['gone.js']);
    expect(diag(t, 'missing-script')).toHaveLength(1);
    expect(diag(t, 'unknown-res-script')).toHaveLength(2);
  });

  it('finds the view by id, then case-insensitively, and answers a fresh array', () => {
    const { t } = scripts('a.js', ['a.js']);
    expect(t.scriptsFor('V')).toEqual(['a.js']);
    expect(t.scriptsFor('nope')).toEqual([]);
    t.scriptsFor('v').push('mutated');
    expect(t.scriptsFor('v')).toEqual(['a.js']);
  });
});

describe('structural caps (E §10): clamp and report, never throw', () => {
  it('exposes the caps of the table', () => {
    expect(DEFAULT_BUILD_CAPS).toEqual({ maxElements: 20000, maxDepth: 64, maxAttrs: 256, maxAttrValue: 65536, maxViews: 64, maxViewAxis: 4096 });
  });

  it('builds 20,000 elements and drops the 20,001st', () => {
    const kids = Array.from({ length: 20000 }, (_, i) => N('subview', { id: `s${i}` })); // the view makes it 20,001
    const t = build(kids);
    expect(t.views[0].elements).toHaveLength(20000);
    expect(t.views[0].byId('s19998')).toBeDefined();
    expect(t.views[0].byId('s19999')).toBeUndefined();
    expect(diag(t, 'cap-elements')).toHaveLength(1);
    expect(build(kids.slice(0, 19999)).diagnostics.filter((d) => d.code === 'cap-elements')).toHaveLength(0);
  });

  it('counts the elements of every view against one budget', () => {
    const t = buildTheme(N('theme', {}, [N('view', {}, [N('button'), N('button')]), N('view', {}, [N('button'), N('button')])]), vfsOf(), { probe: () => null, caps: { maxElements: 5 } });
    expect(t.views.map((v) => v.elements.length)).toEqual([3, 2]);
    expect(diag(t, 'cap-elements')).toHaveLength(1);
  });

  it('allows depth 64 and clamps a chain at depth 65 with a diagnostic', () => {
    /** @param {number} depth the deepest subview's depth below the view */
    const chain = (depth) => {
      /** @type {RawNode | null} */
      let node = null;
      for (let d = depth; d >= 1; d--) node = N('subview', { id: `d${d}` }, node ? [node] : []);
      return node ? [node] : [];
    };
    const ok = build(chain(64));
    expect(ok.views[0].elements).toHaveLength(65);
    expect(diag(ok, 'cap-depth')).toHaveLength(0);
    const over = build(chain(65));
    expect(over.views[0].elements).toHaveLength(65); // d65 is gone
    expect(over.views[0].byId('d64')).toBeDefined();
    expect(over.views[0].byId('d65')).toBeUndefined();
    expect(diag(over, 'cap-depth')).toHaveLength(1);
  });

  it('survives a 100,000-deep tree without a stack overflow', () => {
    /** @type {RawNode} */
    let node = N('subview');
    for (let i = 0; i < 100000; i++) node = N('subview', {}, [node]);
    const t = build([node]);
    expect(t.views[0].elements).toHaveLength(65);
    expect(diag(t, 'cap-depth')).toHaveLength(1);
  });

  it('drops attributes past 256 and values over 64 KiB, instead of truncating a handler', () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`a${i}`, i]));
    const t = build([N('button', { id: 'b', ...many }), N('button', { id: 'big', onclick: 'x'.repeat(65537), upToolTip: 'y'.repeat(65536) })]);
    expect(diag(t, 'cap-attrs')).toHaveLength(1);
    // the id is the first of the 256 attributes kept, so a0..a254 stay and a255 on are dropped
    expect(el(t, 'b').get('a254')).toBe('254');
    expect(el(t, 'b').get('a255')).toBe(null);
    expect(el(t, 'b').get('a299')).toBe(null);
    expect(diag(t, 'cap-attr-value')).toHaveLength(1);
    expect(el(t, 'big').handlers.has('onclick')).toBe(false);
    expect(el(t, 'big').get('upToolTip')).toHaveLength(65536); // exactly the limit is allowed
  });

  it('keeps 64 views and drops the 65th', () => {
    const t = buildTheme(N('theme', {}, Array.from({ length: 65 }, (_, i) => N('view', { id: `v${i}` }))), vfsOf(), { probe: () => null });
    expect(t.views).toHaveLength(64);
    expect(diag(t, 'cap-views')).toHaveLength(1);
  });

  it('clamps a VIEW at 4,096 px per axis and not a SUBVIEW', () => {
    const t = build([N('subview', { id: 'sv', width: 4097 })], { view: { width: 4097, height: 4096 } });
    expect(el(t, 'v').get('width')).toBe(4096);
    expect(el(t, 'v').get('height')).toBe(4096);
    expect(el(t, 'sv').get('width')).toBe(4097);
    expect(diag(t, 'cap-view-size')).toHaveLength(1);
  });

  it('takes caps as a partial, ignoring undefined and NaN', () => {
    const t = build([N('subview'), N('subview'), N('subview')], { caps: { maxElements: 3, maxDepth: undefined, maxViews: NaN } });
    expect(t.views[0].elements).toHaveLength(3);
  });

  it('truncates a flood of one diagnostic code', () => {
    const t = build(Array.from({ length: 700 }, () => N('button', { left: 'x' })));
    expect(diag(t, 'invalid-value')).toHaveLength(500);
    expect(diag(t, 'diagnostics-truncated')).toHaveLength(1);
  });
});

describe('sidecar overlays (D10.6)', () => {
  /** @type {SidecarOverlay} */
  const label = { parent: 'panel', tag: 'text', attrs: { left: 9, top: 121, width: 15, value: '32', fontSize: 5, foregroundColor: '#77CE07', justification: 'center' }, hostStyle: { letterSpacing: '-0.5px' } };
  const kids = () => [N('subview', { id: 'panel' }, [N('text', { id: 'first', zIndex: 1 }), N('button', { id: 'btn', zIndex: 1 })]), N('subview', { id: 'other' })];

  it('appends the overlay as a TEXT element under its parent, last in source order, in typed form', () => {
    const t = build(kids(), { overlays: [label] });
    const v = t.views[0];
    const o = v.elements[v.elements.length - 1];
    expect(o.kind).toBe('text');
    expect(o.parent).toBe(el(t, 'panel'));
    expect(el(t, 'panel').children.map((c) => c.id)).toEqual(['first', 'btn', o.id]);
    expect([o.get('left'), o.get('top'), o.get('width'), o.get('value'), o.get('fontSize'), o.get('foregroundColor'), o.get('justification')])
      .toEqual([9, 121, 15, '32', 5, 0x77ce07, 'Center']);
    expect(/** @type {any} */ (o).hostStyle).toEqual({ letterSpacing: '-0.5px' });
    expect(o.docIndex).toBe(v.elements.length - 1);
    expect(v.byHandle(o.handle)).toBe(o);
    expect(t.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(v.takeDirty().size).toBe(0);
  });

  it('paints over its siblings at equal z, and its generated id continues the count after the literal pass', () => {
    const flat = [N('subview', { id: 'panel' }, [N('text', { id: 'first' }), N('button', { id: 'btn' })]), N('subview', { id: 'other' }), N('text')];
    const t = build(flat, { overlays: [label, { ...label, parent: 'other', hostStyle: undefined }] });
    const v = t.views[0];
    expect(v.paintOrder(el(t, 'panel')).map((x) => (x === 'background' ? '<bg>' : x.id))).toEqual(['<bg>', 'first', 'btn', 'Unnamed_text_2']);
    expect(v.elements.filter((e) => e.kind === 'text').map((e) => e.id)).toEqual(['first', 'Unnamed_text_1', 'Unnamed_text_2', 'Unnamed_text_3']);
    expect(el(t, 'other').children).toHaveLength(1);
    expect(/** @type {any} */ (el(t, 'other').children[0]).hostStyle).toBeUndefined();
  });

  it('does not change the Unnamed ids of the literal elements', () => {
    const without = build([...kids(), N('text'), N('text')]);
    const withOverlay = build([...kids(), N('text'), N('text')], { overlays: [label] });
    const ids = (/** @type {typeof without} */ t) => t.views[0].elements.slice(0, without.views[0].elements.length).map((e) => e.id);
    expect(ids(withOverlay)).toEqual(ids(without));
  });

  it('honours an overlay id and finds the parent case-insensitively, in any view', () => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'a' }), N('view', { id: 'b' }, [N('subview', { id: 'Panel' })])]), vfsOf(), {
      probe: () => null, overlays: [{ parent: 'PANEL', tag: 'text', attrs: { id: 'mine', value: 'x' } }],
    });
    expect(t.views[1].byId('mine')?.parent).toBe(t.views[1].byId('panel'));
    expect(t.views[0].byId('mine')).toBeUndefined();
  });

  it('reports and skips an overlay it cannot place, and never throws', () => {
    const t = build(kids(), { overlays: [
      { parent: 'nowhere', tag: 'text', attrs: {} }, { parent: 'btn', tag: 'text', attrs: {} },
      /** @type {any} */ ({ parent: 'panel', tag: 'button', attrs: {} }), /** @type {any} */ (null), /** @type {any} */ ({ tag: 'text' }),
    ] });
    expect(diag(t, 'overlay-parent-missing')).toHaveLength(1);
    expect(diag(t, 'overlay-invalid')).toHaveLength(4);
    expect(t.views[0].elements.map((e) => e.id)).toEqual(['v', 'panel', 'first', 'btn', 'other']);
  });

  it('takes overlay values as literals: nothing a sidecar says is script', () => {
    const attrs = JSON.parse('{"value":"jscript:evil()","left":"wmpprop:a.b","__proto__":1,"constructor":2}');
    const t = build(kids(), { overlays: [{ parent: 'panel', tag: 'text', attrs }] });
    const o = t.views[0].elements.slice(-1)[0];
    expect(o.get('value')).toBe('jscript:evil()');
    expect(o.source('value')).toEqual({ kind: 'literal', text: 'jscript:evil()' });
    expect(o.get('left')).toBe(0);
    expect(o.get('constructor')).toBe('2'); // an own, inert attribute, not anything inherited
    expect(o.get('toString')).toBe(null);
    expect(o.get('__proto__')).toBe('1');
  });

  it('counts against the element cap and keeps only an allowed hostStyle key', () => {
    const t = build([N('subview', { id: 'panel' })], { caps: { maxElements: 2 }, overlays: [label] });
    expect(t.views[0].elements).toHaveLength(2);
    expect(diag(t, 'cap-elements')).toHaveLength(1);
    const odd = build(kids(), { overlays: [{ ...label, hostStyle: /** @type {any} */ ({ letterSpacing: 5, color: 'red' }) }] });
    expect(/** @type {any} */ (odd.views[0].elements.slice(-1)[0]).hostStyle).toBeUndefined();
  });
});

describe('through the scanner', () => {
  it('builds a skin written as text, with the last duplicate attribute winning', () => {
    const { root } = scanWms('<THEME title="T"><VIEW id="v" width="40" height="30"><BUTTON id="b" left="1" left="9" toolTip="a" tooltip="b" Image="x.bmp"/></VIEW></THEME>');
    const t = buildTheme(/** @type {RawNode} */ (root), vfsOf(['x.bmp']), { probe: probeOf({ 'x.bmp': [7, 5] }) });
    const b = t.views[0].byId('b');
    expect([b?.get('left'), b?.get('width'), b?.get('height')]).toEqual([9, 7, 5]);
    expect(b?.get('toolTip')).toBe('b');
  });
});

describe('stacking option', () => {
  it('hands the stacking mode to the view\'s paintOrder', () => {
    const kids = () => [N('subview', { id: 'head' }, [N('subview', { id: 'screen', zIndex: -2 })]), N('subview', { id: 'ear', zIndex: -1 }, [N('subview', { id: 'panel', zIndex: -1 })])];
    const ids = (/** @type {ReturnType<typeof build>} */ t) => t.views[0].paintOrder(t.views[0].view).map((x) => (x === 'background' ? '<bg>' : x.id));
    expect(ids(build(kids()))).toEqual(['ear', '<bg>', 'head']);
    expect(ids(build(kids(), { stacking: 'flat' }))).toEqual(['screen', 'panel', 'ear', '<bg>', 'head']);
  });
});
