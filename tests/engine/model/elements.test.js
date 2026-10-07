// @ts-check
// The element model (E §5.3): typed `get`/`set`, the dirty set, the `_onchange` queue, the id
// indexes and the change listeners. Models are built from synthetic raw trees through `buildTheme`.
import { describe, expect, it } from 'vitest';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { createViewModel } from '../../../src/engine/model/elements.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../../src/engine/contracts').Diagnostic} Diagnostic */

/** @param {Record<string, string | number>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {RawNode[]} [children] @returns {RawNode} */
const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

const vfs = () => ({
  sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null,
});

/** @param {RawNode[]} kids @param {Record<string, string | number>} [viewAttrs] */
const build = (kids, viewAttrs = {}) => buildTheme(N('theme', {}, [N('view', { id: 'v', width: 100, height: 100, ...viewAttrs }, kids)]), vfs(), { probe: () => null });
/** @param {RawNode[]} kids @param {Record<string, string | number>} [viewAttrs] */
const viewOf = (kids, viewAttrs) => build(kids, viewAttrs).views[0];
/** @param {ViewModel} v @param {string} id @returns {ElementModel} */
const el = (v, id) => /** @type {ElementModel} */ (v.byId(id));

describe('get', () => {
  it('reads defaults for what the markup left out, and is case-insensitive', () => {
    const v = viewOf([N('button', { id: 'b' }), N('text', { id: 't' }), N('slider', { id: 's' })]);
    expect(el(v, 'b').get('visible')).toBe(true);
    expect(el(v, 'b').get('VISIBLE')).toBe(true);
    expect(el(v, 'b').get('zIndex')).toBe(0);
    expect(el(v, 'b').get('transparencyColor')).toBe(null); // no default
    expect(el(v, 't').get('fontSize')).toBe(10);
    expect(el(v, 't').get('backgroundColor')).toBe('none');
    expect(el(v, 's').get('max')).toBe(100);
    expect(el(v, 's').get('Cursor')).toBe('hand');
  });

  it('reads the markup\'s values in their typed form', () => {
    const v = viewOf([N('button', { id: 'b', left: ' 12 ', top: '-3', visible: 'FALSE', zIndex: '2.5', cursor: 'Hand' }), N('text', { id: 't', foregroundColor: '#f0f', justification: 'center' })]);
    expect(el(v, 'b').get('left')).toBe(12);
    expect(el(v, 'b').get('top')).toBe(-3);
    expect(el(v, 'b').get('visible')).toBe(false);
    expect(el(v, 'b').get('zindex')).toBe(2); // int, rounded half to even
    expect(el(v, 'b').get('cursor')).toBe('hand');
    expect(el(v, 't').get('foregroundColor')).toBe(0xff00ff);
    expect(el(v, 't').get('justification')).toBe('Center'); // the table's own spelling
  });

  it('answers id and elementType from the element itself', () => {
    const v = viewOf([N('pausebutton', { id: 'p' }), N('button')]);
    expect(el(v, 'p').get('id')).toBe('p');
    expect(el(v, 'p').get('elementType')).toBe('PAUSEBUTTON');
    expect(v.elements[2].get('ID')).toBe('Unnamed_button_1'); // the pausebutton has an id and takes no number
  });

  it('returns null for an attribute the kind does not have', () => {
    const v = viewOf([N('button', { id: 'b' })]);
    expect(el(v, 'b').get('noSuchThing')).toBe(null);
    expect(el(v, 'b').get('__proto__')).toBe(null);
    expect(el(v, 'b').get('constructor')).toBe(null);
  });

  it('keeps the text of an attribute the kind has no behaviour for (G12), readable but inert', () => {
    const v = viewOf([N('button', { id: 'b', widht: '99', zindez: '5' })]);
    expect(el(v, 'b').get('widht')).toBe('99');
    expect(el(v, 'b').get('width')).toBe(0);
    expect(el(v, 'b').source('widht')).toEqual({ kind: 'literal', text: '99' });
  });
});

describe('set', () => {
  it('coerces to the attribute\'s type and says whether anything changed', () => {
    const v = viewOf([N('button', { id: 'b', left: 5 })]);
    const b = el(v, 'b');
    expect(b.set('left', '7', 'script')).toBe(true);
    expect(b.get('left')).toBe(7);
    expect(b.set('left', 7, 'script')).toBe(false); // same value
    expect(b.set('Left', 7.4, 'script')).toBe(false); // rounds to the same 7
    expect(b.set('visible', 'false', 'script')).toBe(true);
    expect(b.get('visible')).toBe(false);
    expect(b.set('visible', 0, 'script')).toBe(false);
    expect(b.set('upToolTip', 42, 'script')).toBe(true);
    expect(b.get('upToolTip')).toBe('42');
  });

  it('keeps the previous value on invalid input (U-20)', () => {
    const v = viewOf([N('button', { id: 'b', left: 5, visible: 'false' }), N('text', { id: 't', foregroundColor: 'red' })]);
    const b = el(v, 'b');
    expect(b.set('left', 'abc', 'script')).toBe(false);
    expect(b.get('left')).toBe(5);
    expect(b.set('visible', 'ture', 'script')).toBe(false);
    expect(b.get('visible')).toBe(false);
    expect(b.set('left', NaN, 'script')).toBe(false);
    expect(b.set('left', {}, 'script')).toBe(false);
    expect(b.set('left', undefined, 'script')).toBe(false);
    expect(el(v, 't').set('foregroundColor', 'notacolour', 'script')).toBe(false);
    expect(el(v, 't').get('foregroundColor')).toBe(0xff0000);
    expect(el(v, 't').set('justification', 'diagonal', 'script')).toBe(false);
  });

  it('refuses an attribute the kind does not have, for every origin', () => {
    const v = viewOf([N('button', { id: 'b' })]);
    for (const origin of /** @type {const} */ (['init', 'layout', 'script', 'binding', 'user', 'anim', 'host', 'sidecar'])) {
      expect(el(v, 'b').set('noSuchThing', 1, origin), origin).toBe(false);
    }
    expect(el(v, 'b').set('__proto__', 1, 'script')).toBe(false);
    expect(el(v, 'b').set('constructor', 1, 'script')).toBe(false);
  });

  it('lets only markup and the host write a read-only attribute, and nobody rewrite an id', () => {
    const v = viewOf([N('text', { id: 't', value: 'x' }), N('buttongroup', { id: 'g' })]);
    const t = el(v, 't');
    expect(t.set('textWidth', 40, 'script')).toBe(false);
    expect(t.set('textWidth', 40, 'binding')).toBe(false);
    expect(t.set('textWidth', 40, 'user')).toBe(false);
    expect(t.set('textWidth', 40, 'host')).toBe(true); // the renderer measures it
    expect(t.get('textWidth')).toBe(40);
    expect(t.set('elementType', 'x', 'script')).toBe(false);
    for (const origin of /** @type {const} */ (['init', 'script', 'host', 'sidecar'])) expect(t.set('id', 'other', origin), origin).toBe(false);
    expect(t.get('id')).toBe('t');
  });

  it('accepts a host-only x- attribute from a sidecar and from nobody else', () => {
    const v = viewOf([N('slider', { id: 's' })]);
    const s = el(v, 's');
    expect(s.get('x-foregroundMode')).toBe('progress');
    for (const origin of /** @type {const} */ (['init', 'layout', 'script', 'binding', 'user', 'anim', 'host'])) {
      expect(s.set('x-foregroundMode', 'playhead', origin), origin).toBe(false);
    }
    expect(s.set('x-foregroundMode', 'sideways', 'sidecar')).toBe(false); // not in the enum
    expect(s.set('X-FOREGROUNDMODE', 'Playhead', 'sidecar')).toBe(true);
    expect(s.get('x-foregroundmode')).toBe('playhead');
  });

  it('a skin cannot reach a host-only switch by writing it in its own markup', () => {
    const v = viewOf([N('slider', { id: 's', 'x-foregroundMode': 'playhead' })]);
    expect(el(v, 's').get('x-foregroundMode')).toBe('progress');
    expect(el(v, 'v').get('x-foregroundMode')).toBe(null);
  });

  it('resolves a res:// string assigned to a string attribute through the string table', () => {
    const t = build([N('button', { id: 'b' })]);
    const b = el(t.views[0], 'b');
    expect(b.set('upToolTip', 'res://-/RT_STRING/#1810', 'script')).toBe(true);
    expect(b.get('upToolTip')).toBe('Volume');
    expect(b.set('upToolTip', 'res://-/RT_STRING/#7', 'script')).toBe(true); // unknown id: blank, and a note
    expect(b.get('upToolTip')).toBe('');
    expect(t.diagnostics.some((d) => d.code === 'unresolved-res' && d.elementId === 'b')).toBe(true);
  });

  it('clamps a VIEW\'s size to 4,096 px with a diagnostic, and no other element\'s', () => {
    const t = build([N('subview', { id: 'sv' })]);
    const v = t.views[0];
    expect(v.view.set('width', 5000, 'script')).toBe(true);
    expect(v.view.get('width')).toBe(4096);
    expect(v.view.set('width', 9000, 'script')).toBe(false); // already at the cap
    expect(t.diagnostics.filter((d) => d.code === 'cap-view-size')).toHaveLength(2);
    expect(el(v, 'sv').set('width', 5000, 'script')).toBe(true);
    expect(el(v, 'sv').get('width')).toBe(5000);
  });

  it('assigning a handler replaces the handler site', () => {
    const v = viewOf([N('button', { id: 'b', onclick: 'a();' }), N('player', { id: 'p' })]);
    const b = el(v, 'b');
    expect(b.handlers.get('onclick')?.source).toBe('a();');
    expect(b.set('onClick', 'b();', 'script')).toBe(true);
    expect(b.handlers.get('onclick')).toMatchObject({ event: 'onclick', source: 'b();', params: [] });
    expect(b.set('onclick', '', 'script')).toBe(true);
    expect(b.handlers.has('onclick')).toBe(false);
    // a PLAYER event keeps its parameter names
    expect(el(v, 'p').set('onOpenStateChange', 'f(NewState)', 'script')).toBe(true);
    expect(el(v, 'p').handlers.get('onopenstatechange')?.params).toEqual(['NewState']);
  });
});

describe('the dirty set', () => {
  it('starts empty: the literal pass is not a change', () => {
    const v = viewOf([N('button', { id: 'b', left: 5 })]);
    expect(v.takeDirty().size).toBe(0);
  });

  it('collects lower-case attribute names per element and empties when taken', () => {
    const v = viewOf([N('button', { id: 'a' }), N('button', { id: 'b' })]);
    el(v, 'a').set('Left', 5, 'script');
    el(v, 'a').set('TOP', 6, 'anim');
    el(v, 'b').set('visible', false, 'user');
    el(v, 'b').set('visible', false, 'user'); // no change, no mark
    const dirty = v.takeDirty();
    expect(dirty.size).toBe(2);
    expect([...(dirty.get(el(v, 'a')) ?? [])].sort()).toEqual(['left', 'top']);
    expect([...(dirty.get(el(v, 'b')) ?? [])]).toEqual(['visible']);
    expect(v.takeDirty().size).toBe(0);
  });

  it('a change origin \'init\' still marks, because the renderer may already be mounted', () => {
    const v = viewOf([N('button', { id: 'a' })]);
    el(v, 'a').set('left', 3, 'init');
    expect(v.takeDirty().size).toBe(1);
    expect(v.takeQueuedEvents()).toEqual([]);
  });
});

describe('the _onchange queue', () => {
  const kids = () => [
    N('slider', { id: 's1', value_onchange: 'a();' }), N('slider', { id: 's2', value_onchange: 'b();', left_onchange: 'c();' }),
    N('slider', { id: 'quiet' }),
  ];

  it('queues <attr>_onchange for a changed attribute whose element has the handler, FIFO', () => {
    const v = viewOf(kids());
    el(v, 's2').set('value', 5, 'binding');
    el(v, 's1').set('value', 6, 'script');
    el(v, 's2').set('left', 7, 'layout');
    expect(v.takeQueuedEvents().map((e) => [e.el.id, e.event])).toEqual([['s2', 'value_onchange'], ['s1', 'value_onchange'], ['s2', 'left_onchange']]);
    expect(v.takeQueuedEvents()).toEqual([]);
  });

  it('queues nothing for origin init, for an unchanged value, or for an element without the handler', () => {
    const v = viewOf(kids());
    el(v, 's1').set('value', 6, 'init');
    el(v, 's1').set('value', 6, 'script'); // unchanged
    el(v, 'quiet').set('value', 9, 'script'); // no handler
    el(v, 's1').set('top', 9, 'script'); // no top_onchange
    expect(v.takeQueuedEvents()).toEqual([]);
  });

  it('queues every origin but init', () => {
    const v = viewOf(kids());
    let n = 0;
    for (const origin of /** @type {const} */ (['layout', 'script', 'binding', 'user', 'anim', 'host', 'sidecar'])) {
      el(v, 's1').set('value', ++n, origin);
    }
    expect(v.takeQueuedEvents()).toHaveLength(7);
  });

  it('is bounded, with one diagnostic, so a script loop cannot grow it without limit', () => {
    const t = build(kids());
    const v = t.views[0];
    for (let i = 1; i <= 5000; i++) el(v, 's1').set('value', i, 'script');
    expect(v.takeQueuedEvents()).toHaveLength(4096);
    expect(t.diagnostics.filter((d) => d.code === 'cap-onchange-queue')).toHaveLength(1);
    // draining makes room again
    el(v, 's1').set('value', 9999, 'script');
    expect(v.takeQueuedEvents()).toHaveLength(1);
  });
});

describe('change listeners', () => {
  it('receive (element, lower-case attribute, typed value, origin) for every change', () => {
    const v = viewOf([N('button', { id: 'b' })]);
    /** @type {unknown[][]} */
    const seen = [];
    const off = v.onChange((e, attr, value, origin) => seen.push([e.id, attr, value, origin]));
    el(v, 'b').set('Left', '5', 'anim');
    el(v, 'b').set('left', 5, 'anim'); // unchanged
    el(v, 'b').set('left', 6, 'host');
    expect(seen).toEqual([['b', 'left', 5, 'anim'], ['b', 'left', 6, 'host']]);
    off();
    el(v, 'b').set('left', 7, 'host');
    expect(seen).toHaveLength(2);
  });

  it('a throwing listener neither undoes the write nor stops the others, and is reported', () => {
    const t = build([N('button', { id: 'b' })]);
    const v = t.views[0];
    let reached = false;
    v.onChange(() => { throw new Error('boom'); });
    v.onChange(() => { reached = true; });
    expect(el(v, 'b').set('left', 5, 'script')).toBe(true);
    expect(el(v, 'b').get('left')).toBe(5);
    expect(reached).toBe(true);
    expect(t.diagnostics.some((d) => d.code === 'listener-error' && /boom/.test(d.detail))).toBe(true);
  });

  it('a listener may write back without breaking the iteration', () => {
    const v = viewOf([N('button', { id: 'b' })]);
    let once = true;
    v.onChange((e, attr) => { if (once && attr === 'left') { once = false; e.set('top', 1, 'host'); } });
    el(v, 'b').set('left', 5, 'script');
    expect(el(v, 'b').get('top')).toBe(1);
  });
});

describe('ids and handles', () => {
  it('finds an id exactly first, then case-insensitively', () => {
    const v = viewOf([N('button', { id: 'Volume' }), N('slider', { id: 'volume' })]);
    expect(v.byId('Volume')?.kind).toBe('button');
    expect(v.byId('volume')?.kind).toBe('slider');
    expect(v.byId('VOLUME')?.kind).toBe('slider'); // the last declaration wins a folded lookup
    expect(v.byId('nope')).toBeUndefined();
    expect(v.byId(/** @type {any} */ (42))).toBeUndefined();
  });

  it('lets the last declaration win an exact repeat, with a diagnostic, and keeps both elements', () => {
    const t = build([N('button', { id: 'dup', left: 1 }), N('button', { id: 'dup', left: 2 })]);
    const v = t.views[0];
    expect(v.byId('dup')?.get('left')).toBe(2);
    expect(v.elements.filter((e) => e.id === 'dup')).toHaveLength(2);
    expect(t.diagnostics.filter((d) => d.code === 'duplicate-id' && d.elementId === 'dup')).toHaveLength(1);
  });

  it('treats __proto__ and constructor as ordinary ids', () => {
    const t = build([N('button', { id: '__proto__', left: 1 }), N('text', { id: 'constructor', left: 2 }), N('button', { id: 'toString' })]);
    const v = t.views[0];
    expect(v.byId('__proto__')?.get('left')).toBe(1);
    expect(v.byId('constructor')?.kind).toBe('text');
    expect(v.byId('CONSTRUCTOR')?.kind).toBe('text');
    expect(v.byId('toString')?.kind).toBe('button');
    expect(v.byId('hasOwnProperty')).toBeUndefined();
    expect(v.byId('valueOf')).toBeUndefined();
    // and a repeat of one is an ordinary repeat
    const again = build([N('button', { id: '__proto__' }), N('button', { id: '__proto__' })]);
    expect(again.diagnostics.filter((d) => d.code === 'duplicate-id')).toHaveLength(1);
    // the attribute table's own lookups survive the same names
    expect(v.byId('__proto__')?.get('__proto__')).toBe(null);
  });

  it('gives every element a distinct positive handle that finds it again', () => {
    const t = buildTheme(N('theme', {}, [N('view', { id: 'a' }, [N('button'), N('button')]), N('view', { id: 'b' }, [N('button')])]), vfs(), { probe: () => null });
    const handles = t.views.flatMap((v) => v.elements.map((e) => e.handle));
    expect(handles).toHaveLength(5);
    expect(new Set(handles).size).toBe(5);
    expect(handles.every((h) => Number.isInteger(h) && h > 0)).toBe(true);
    for (const v of t.views) for (const e of v.elements) expect(v.byHandle(e.handle)).toBe(e);
    expect(t.views[0].byHandle(t.views[1].view.handle)).toBeUndefined();
    expect(t.views[0].byHandle(0)).toBeUndefined();
  });

  it('numbers docIndex in source order, the view first, and links parents and children', () => {
    const v = viewOf([N('subview', { id: 'a' }, [N('button', { id: 'a1' })]), N('subview', { id: 'b' })]);
    expect(v.elements.map((e) => [e.id, e.docIndex])).toEqual([['v', 0], ['a', 1], ['a1', 2], ['b', 3]]);
    expect(v.view.parent).toBe(null);
    expect(el(v, 'a1').parent).toBe(el(v, 'a'));
    expect(v.view.children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(v.view).toBe(v.elements[0]);
  });
});

describe('createViewModel', () => {
  it('rejects a second root and requires nothing of the caller beyond its options', () => {
    const { add } = createViewModel({ maxViewAxis: 4096, report: () => {}, nextHandle: (() => { let n = 0; return () => ++n; })() });
    const root = add({ tag: 'view', kind: 'view', id: 'v', declared: true, parent: null, values: new Map(), unknown: new Map(), sources: new Map(), handlers: new Map() });
    expect(root.docIndex).toBe(0);
    expect(() => add({ tag: 'view', kind: 'view', id: 'w', declared: true, parent: null, values: new Map(), unknown: new Map(), sources: new Map(), handlers: new Map() })).toThrow(/one root/);
  });
});
