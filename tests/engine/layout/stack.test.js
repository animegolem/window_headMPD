// @ts-check
// Paint order (E §5.11 `paintOrder`, E D2, E D5 Reading C). The models are built from synthetic raw
// trees through `buildTheme`, so a z value reaches the sort the way a skin's does: as text, through
// the attribute table and `coerce`.
import { describe, expect, it } from 'vitest';
import { paintOrder, isPaintedKind } from '../../../src/engine/layout/stack.js';
import { buildTheme } from '../../../src/engine/wms/build.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../../src/engine/contracts').ViewModel} ViewModel */

/** @param {Record<string, string | number>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {RawNode[]} [children] @returns {RawNode} */
const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

const vfs = () => ({
  sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null,
});

/** @param {RawNode[]} kids @param {{ stacking?: 'context' | 'flat' }} [opts] @returns {ViewModel} */
const viewOf = (kids, opts) => {
  const theme = buildTheme(N('theme', {}, [N('view', { id: 'v', width: 100, height: 100 }, kids)]), vfs(), { probe: () => null, ...opts });
  return theme.views[0];
};

/** @param {ReadonlyArray<ElementModel | 'background'>} order */
const names = (order) => order.map((x) => (x === 'background' ? '<bg>' : x.id));

describe('one stacking context', () => {
  it('puts the background at z 0: negative children under it, zero and positive over it', () => {
    const v = viewOf([
      N('subview', { id: 'p2', zIndex: 2 }), N('subview', { id: 'n2', zIndex: -2 }), N('subview', { id: 'z0' }),
      N('subview', { id: 'n1', zIndex: -1 }), N('subview', { id: 'p1', zIndex: 1 }),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['n2', 'n1', '<bg>', 'z0', 'p1', 'p2']);
  });

  it('a child at zIndex 0 paints over the background even when it comes first in the file', () => {
    const v = viewOf([N('button', { id: 'first', zIndex: 0 })]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'first']);
  });

  it('puts the background last when every child is negative, and alone when there are none', () => {
    const all = viewOf([N('subview', { id: 'a', zIndex: -1 }), N('subview', { id: 'b', zIndex: -5 })]);
    expect(names(all.paintOrder(all.view))).toEqual(['b', 'a', '<bg>']);
    expect(names(viewOf([]).paintOrder(viewOf([]).view))).toEqual(['<bg>']);
  });

  it('orders equal z by source order, the later tag on top (U-1)', () => {
    const v = viewOf([
      N('button', { id: 'a', zIndex: 3 }), N('text', { id: 'b', zIndex: 3 }), N('slider', { id: 'c', zIndex: 3 }),
      N('button', { id: 'd', zIndex: 3 }),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'a', 'b', 'c', 'd']);
  });

  it('is decided by the z value, not by the order the attributes are written in', () => {
    const v = viewOf([N('button', { zIndex: 5, id: 'hi', left: 1 }), N('button', { id: 'lo', left: 2, zIndex: 1 })]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'lo', 'hi']);
  });

  it('lists hidden children: visibility is the renderer\'s question, not the order\'s', () => {
    const v = viewOf([N('subview', { id: 'gone', visible: 'false' })]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'gone']);
  });

  it('keeps only the elements that draw something', () => {
    const v = viewOf([
      N('button', { id: 'btn' }), N('player', { id: 'pl' }), N('equalizersettings', { id: 'eq' }), N('network', { id: 'net' }),
      N('controls', { id: 'ctl' }), N('automenu', { id: 'am' }), N('wmpeffects', { id: 'fx' }), N('playlist', { id: 'plist' }),
      N('buttonelement', { id: 'stray' }),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'btn', 'fx', 'plist']);
    for (const kind of ['player', 'controls', 'equalizersettings', 'unknown', 'automenu', 'buttonelement', 'item', 'settings']) {
      expect(isPaintedKind(kind), kind).toBe(false);
    }
    for (const kind of ['subview', 'button', 'buttongroup', 'slider', 'customslider', 'progressbar', 'text', 'effects', 'video', 'playlist']) {
      expect(isPaintedKind(kind), kind).toBe(true);
    }
  });

  it('paints a button group once, at the group\'s own z, and not its elements', () => {
    const v = viewOf([
      N('buttongroup', { id: 'g', zIndex: 2 }, [N('buttonelement', { id: 'e1' }), N('buttonelement', { id: 'e2' })]),
      N('button', { id: 'under', zIndex: 1 }),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'under', 'g']);
    const group = /** @type {ElementModel} */ (v.byId('g'));
    expect(v.paintOrder(group)).toEqual([]);
  });

  it('reads a PLAYLIST\'s z as 0: it has no zIndex (a windowed control, spec 2.8)', () => {
    const v = viewOf([N('playlist', { id: 'pl', zIndex: -5 }), N('button', { id: 'b', zIndex: -1 })]);
    expect(names(v.paintOrder(v.view))).toEqual(['b', '<bg>', 'pl']);
  });

  it('gives a container that is not a view or subview no order at all', () => {
    const v = viewOf([N('button', { id: 'b' }, [N('subview', { id: 'child' })])]);
    expect(v.paintOrder(/** @type {ElementModel} */ (v.byId('b')))).toEqual([]);
  });
});

describe('nested contexts', () => {
  it('lists a nested subview as one entry and never interleaves its children with the siblings', () => {
    const v = viewOf([
      N('subview', { id: 'A', zIndex: -1 }, [N('button', { id: 'a-hi', zIndex: 50 }), N('button', { id: 'a-lo', zIndex: -50 })]),
      N('subview', { id: 'B', zIndex: 0 }, [N('button', { id: 'b-1', zIndex: 1 })]),
      N('button', { id: 'C', zIndex: 2 }),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['A', '<bg>', 'B', 'C']);
    expect(names(v.paintOrder(/** @type {ElementModel} */ (v.byId('A'))))).toEqual(['a-lo', '<bg>', 'a-hi']);
    expect(names(v.paintOrder(/** @type {ElementModel} */ (v.byId('B'))))).toEqual(['<bg>', 'b-1']);
  });

  it('a child with a huge z stays inside its own context (the Headspace screen under the head)', () => {
    // Reading C: the head's children never leave the head, so the PL panel (z -1 in a z -1 ear) is
    // below the whole head layer whatever the head's own children say.
    const v = viewOf([
      N('subview', { id: 'head', zIndex: 0 }, [N('subview', { id: 'screen', zIndex: -2 }), N('button', { id: 'btn', zIndex: 3 })]),
      N('subview', { id: 'plEar', zIndex: -1 }, [N('subview', { id: 'panel', zIndex: -1 })]),
    ]);
    expect(names(v.paintOrder(v.view))).toEqual(['plEar', '<bg>', 'head']);
    expect(names(v.paintOrder(/** @type {ElementModel} */ (v.byId('head'))))).toEqual(['screen', '<bg>', 'btn']);
  });
});

describe('stacking: flat (Reading B), the diagnostic switch', () => {
  // The same shape as Headspace: the head is first in the file, the PL ear after it.
  const tree = () => [
    N('subview', { id: 'head', zIndex: 0 }, [N('subview', { id: 'screen', zIndex: -2 })]),
    N('subview', { id: 'plEar', zIndex: -1 }, [N('subview', { id: 'panel', zIndex: -1 })]),
  ];

  it('adds z along the way, so the PL panel (-2) ties with the screen (-2) and wins on file order: the failure parity 0.1 rule 4 describes', () => {
    const v = viewOf(tree(), { stacking: 'flat' });
    const order = names(v.paintOrder(v.view));
    expect(order.indexOf('panel')).toBeGreaterThan(order.indexOf('screen'));
    // and the context reading, same tree, keeps the panel's whole ear under the head
    const c = viewOf(tree());
    expect(names(c.paintOrder(c.view))).toEqual(['plEar', '<bg>', 'head']);
  });

  it('pure function: the same answer called directly', () => {
    const v = viewOf(tree());
    const direct = paintOrder(v.view, { stacking: 'flat' });
    // absolute z: screen -2, panel -1 + -1 = -2, plEar -1, head 0; ties by source order
    expect(names(direct)).toEqual(['screen', 'panel', 'plEar', '<bg>', 'head']);
    // a context call gives a fresh array each time; the model's own method caches it
    expect(paintOrder(v.view, { stacking: 'context' })).not.toBe(paintOrder(v.view, { stacking: 'context' }));
  });
});

describe('a runtime zIndex write re-sorts one parent', () => {
  it('changes the order of the writer\'s parent only, and caches until the next write', () => {
    const v = viewOf([
      N('subview', { id: 'P1' }, [N('button', { id: 'a', zIndex: 1 }), N('button', { id: 'b', zIndex: 2 })]),
      N('subview', { id: 'P2' }, [N('button', { id: 'c', zIndex: 1 }), N('button', { id: 'd', zIndex: 2 })]),
    ]);
    const p1 = /** @type {ElementModel} */ (v.byId('P1'));
    const p2 = /** @type {ElementModel} */ (v.byId('P2'));
    const before1 = v.paintOrder(p1);
    const before2 = v.paintOrder(p2);
    expect(v.paintOrder(p1)).toBe(before1); // cached
    expect(names(before1)).toEqual(['<bg>', 'a', 'b']);

    expect(/** @type {ElementModel} */ (v.byId('a')).set('zIndex', 9, 'script')).toBe(true);
    const after1 = v.paintOrder(p1);
    expect(names(after1)).toEqual(['<bg>', 'b', 'a']);
    expect(after1).not.toBe(before1);
    expect(v.paintOrder(p2)).toBe(before2); // the other parent was not touched
    expect(v.paintOrder(p1)).toBe(after1);
  });

  it('in flat stacking a write under a grandparent re-sorts the ancestors that list it too', () => {
    // In flat mode the view's list holds every descendant, so a z write on `a` (a grandchild of the
    // view) makes the view's cached order stale, not only its parent A's.
    const v = viewOf([
      N('subview', { id: 'A' }, [N('button', { id: 'a', zIndex: 1 })]),
      N('subview', { id: 'B', zIndex: 2 }),
    ], { stacking: 'flat' });
    const subA = /** @type {ElementModel} */ (v.byId('A'));
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'A', 'a', 'B']);
    expect(names(v.paintOrder(subA))).toEqual(['<bg>', 'a']);

    expect(/** @type {ElementModel} */ (v.byId('a')).set('zIndex', 9, 'script')).toBe(true);
    const after = v.paintOrder(v.view);
    expect(names(after)).toEqual(['<bg>', 'A', 'B', 'a']);
    expect(after).toEqual(paintOrder(v.view, { stacking: 'flat' }));
    expect(v.paintOrder(v.view)).toBe(after); // cached again
  });

  it('in flat stacking a sibling subtree\'s cached order is left alone', () => {
    const v = viewOf([
      N('subview', { id: 'A' }, [N('button', { id: 'a', zIndex: 1 }), N('button', { id: 'a2', zIndex: 2 })]),
      N('subview', { id: 'B' }, [N('button', { id: 'b', zIndex: 1 })]),
    ], { stacking: 'flat' });
    const b = /** @type {ElementModel} */ (v.byId('B'));
    const beforeB = v.paintOrder(b);
    /** @type {ElementModel} */ (v.byId('a')).set('zIndex', 9, 'script');
    expect(v.paintOrder(b)).toBe(beforeB);
  });

  it('a negative write moves the child under the background', () => {
    const v = viewOf([N('button', { id: 'x', zIndex: 1 }), N('button', { id: 'y', zIndex: 2 })]);
    /** @type {ElementModel} */ (v.byId('y')).set('zindex', -1, 'script');
    expect(names(v.paintOrder(v.view))).toEqual(['y', '<bg>', 'x']);
  });

  it('an invalid z keeps the order', () => {
    const v = viewOf([N('button', { id: 'x', zIndex: 1 }), N('button', { id: 'y', zIndex: 2 })]);
    expect(/** @type {ElementModel} */ (v.byId('x')).set('zindex', 'high', 'script')).toBe(false);
    expect(names(v.paintOrder(v.view))).toEqual(['<bg>', 'x', 'y']);
  });
});
