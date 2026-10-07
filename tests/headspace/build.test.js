// @ts-check
// Headspace through the literal pass (WAVES W2.1 acceptance 2; ENGINE D5, D2; `parity 0.5`, `0.6`,
// `survey R0`). Needs the owner's `~/Downloads/Headspace.wmz`; skips with the reason in its title
// without it. Nothing derived from the art is written anywhere: the test reads sizes from the image
// headers and compares them with numbers the research notes recorded.
//
// What "69 elements" counts: `survey R0` counts every tag of the definition file, THEME and VIEW
// included. The model holds the VIEW and everything under it (68 elements, the VIEW first) and keeps
// the THEME in `meta`, so the test states both numbers and the sum.

import { beforeAll, describe, expect, it } from 'vitest';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { probeImage } from '../../src/engine/image/probe.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { pickDefinition } from '../../src/engine/wms/select.js';
import { describeHeadspace } from '../support/fixtures.js';

/** @typedef {import('../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../src/engine/contracts').RawNode} RawNode */

/** @type {Awaited<ReturnType<typeof openVfs>>} */
let vfs;
/** @type {ReturnType<typeof buildTheme>} */
let theme;
/** @type {ViewModel} */
let view;
/** @type {RawNode} */
let raw;
/** @type {ReturnType<typeof pickDefinition>} */
let picked;

/** The element at an index path below the VIEW: `at(0, 7)` is the head's eighth child. @param {...number} path @returns {ElementModel} */
const at = (...path) => path.reduce((el, i) => /** @type {ElementModel} */ (el.children[i]), view.view);

/** An element's index path from the VIEW, `''` for the VIEW itself. @param {ElementModel} el */
const pathOf = (el) => {
  /** @type {number[]} */
  const out = [];
  for (let e = el; e.parent; e = e.parent) out.unshift(e.parent.children.indexOf(e));
  return out.join('.');
};

/** @param {ReadonlyArray<ElementModel | 'background'>} order */
const paths = (order) => order.map((x) => (x === 'background' ? 'bg' : pathOf(x)));

/** The sum of left and top up the parents, for elements whose own left and top are literal. @param {ElementModel} el */
const absolute = (el) => {
  let x = 0;
  let y = 0;
  for (let e = /** @type {ElementModel | null} */ (el); e; e = e.parent) { x += Number(e.get('left')); y += Number(e.get('top')); }
  return [x, y];
};

describeHeadspace('Headspace build (W2.1)', (headspace) => {
  beforeAll(async () => {
    vfs = await openVfs(headspace.bytes(), 'Headspace.wmz');
    picked = pickDefinition(vfs);
    const scanned = scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read(/** @type {NonNullable<typeof picked>} */ (picked).wms))).text);
    raw = /** @type {RawNode} */ (scanned.root);
    theme = buildTheme(raw, vfs, {
      probe: (ref) => { const b = vfs.read(ref); return b ? probeImage(b) : null; },
    });
    view = theme.views[0];
  });

  it('picks headspace.wms, the only definition', () => {
    expect(picked).toEqual({ wms: 'headspace.wms', reason: 'only', unresolved: 0 });
  });

  it('is one 760 x 394 VIEW with 23 SUBVIEWs and 69 elements counting the THEME', () => {
    expect(theme.views).toHaveLength(1);
    expect([view.view.get('width'), view.view.get('height')]).toEqual([760, 394]);
    expect(view.view.get('backgroundColor')).toBe('none');
    expect(view.view.get('titleBar')).toBe(false);
    expect(view.view.get('resizable')).toBe(false); // follows titleBar
    const kinds = new Map();
    for (const e of view.elements) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    expect(kinds.get('subview')).toBe(23);
    expect(kinds.get('view')).toBe(1);
    expect(view.elements).toHaveLength(68);
    expect(1 + view.elements.length).toBe(69); // plus the THEME, which survey R0 counts
    let rawTags = 0;
    (function walk(/** @type {RawNode} */ n) { rawTags++; n.children.forEach(walk); })(raw);
    expect(rawTags).toBe(69);
    expect(Object.fromEntries([...kinds].sort())).toEqual({
      button: 11, buttonelement: 7, buttongroup: 2, effects: 1, equalizersettings: 1, playlist: 1, slider: 13, subview: 23, text: 7, video: 1, view: 1,
    });
  });

  it('builds with nothing worse than the one note about the playlist\'s zIndex', () => {
    expect(theme.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(theme.diagnostics.map((d) => `${d.code} ${d.elementId}`)).toEqual(['unknown-attribute pl']); // a PLAYLIST has no zIndex (G1.F2)
    expect(theme.meta.currentViewID).toBe(null);
    expect(theme.meta.author).toBe('Microsoft Corporation'); // res://-/RT_STRING/#1998
    expect(theme.scriptsFor(view.view.id)).toEqual(['headspace.js', 'res://wmploc/RT_TEXT/#132']);
  });

  // Parent-relative left, top, width, height of every element with a literal geometry, from
  // `parity 0.5`. Indices count the children of the element above, in file order.
  /** @type {Array<[string, number[], number[]]>} */
  const GEOMETRY = [
    // the head and what is on it
    ['head', [0], [261, 0, 234, 394]],
    ['minimize/close group', [0, 0], [101, 4, 29, 16]],
    ['transport group', [0, 1], [48, 31, 144, 25]],
    ['pause button', [0, 2], [74, 32, 23, 23]],
    ['EQ button', [0, 3], [15, 214, 20, 19]],
    ['PL button', [0, 4], [204, 214, 19, 20]],
    ['seek slider (sized by its background image)', [0, 5], [39, 223, 163, 9]],
    ['theme button', [0, 6], [101, 232, 35, 31]],
    ['screen subview', [0, 7], [9, 59, 216, 158]],
    ['effects', [0, 7, 0], [0, 0, 216, 158]],
    ['video', [0, 7, 1], [12, 11, 193, 135]],
    ['visual drop (closed)', [0, 8], [30, 33, 174, 26]],
    ['drop button L', [0, 8, 0], [9, 3, 22, 21]],
    ['drop button R', [0, 8, 1], [135, 3, 22, 21]],
    ['drop button X', [0, 8, 2], [157, 8, 13, 13]],
    ['preset title (no height of its own)', [0, 8, 3], [30, 6, 105, 0]],
    // the EQ ear
    ['EQ ear', [1], [207, 86, 269, 170]],
    ['left_ear', [1, 0], [0, 0, 84, 170]],
    ['EQ handle', [1, 0, 0], [8, 66, 18, 66]],
    ['EQ close', [1, 0, 1], [72, 7, 11, 11]],
    ['left_drawer_top', [1, 1], [84, 0, 167, 10]],
    ['left_drawer_bottom', [1, 2], [84, 150, 168, 10]],
    ['left_drawer_right', [1, 3], [251, 0, 16, 160]],
    ['EQ panel', [1, 4], [84, 10, 171, 140]],
    ['EQ frame left', [1, 4, 0], [0, 0, 10, 140]],
    ['EQ frame top', [1, 4, 1], [10, 0, 157, 11]],
    ['EQ frame bottom', [1, 4, 2], [10, 137, 157, 3]],
    ['EQ frame right', [1, 4, 3], [166, 0, 5, 140]],
    ['balance slider', [1, 4, 4], [8, 11, 71, 11]],
    ['"Balance" label (left 25, top 22)', [1, 4, 5], [25, 22, 0, 0]],
    // the PL ear
    ['PL ear', [2], [277, 86, 272, 170]],
    ['right_drawer_left', [2, 0], [0, 0, 13, 160]],
    ['right_drawer_top', [2, 1], [13, 0, 172, 10]],
    ['right_drawer_bottom', [2, 2], [13, 150, 172, 10]],
    ['right_ear', [2, 3], [185, 0, 87, 170]],
    ['PL handle', [2, 3, 0], [61, 65, 18, 67]],
    ['PL close', [2, 3, 1], [4, 7, 11, 11]],
    ['PL panel', [2, 4], [13, 10, 172, 140]],
    ['PL frame left', [2, 4, 0], [0, 0, 10, 140]],
    ['PL frame top', [2, 4, 1], [10, 0, 157, 11]],
    ['PL frame bottom', [2, 4, 2], [10, 137, 157, 3]],
    ['PL frame right', [2, 4, 3], [167, 0, 5, 140]],
    ['playlist', [2, 4, 4], [0, 0, 172, 140]],
  ];

  it.each(GEOMETRY)('literal geometry (parity 0.5): %s', (_label, path, [left, top, width, height]) => {
    const el = at(...path);
    expect([el.get('left'), el.get('top'), el.get('width'), el.get('height')]).toEqual([left, top, width, height]);
  });

  it('puts the elements where parity 0.5 puts them in view space (the closed state)', () => {
    expect(absolute(at(0, 7))).toEqual([270, 59]); // screen
    expect(absolute(at(0, 8))).toEqual([291, 33]); // visual drop, hidden
    expect(absolute(at(0, 0))).toEqual([362, 4]);
    expect(absolute(at(0, 1))).toEqual([309, 31]);
    expect(absolute(at(0, 2))).toEqual([335, 32]);
    expect(absolute(at(0, 3))).toEqual([276, 214]);
    expect(absolute(at(0, 4))).toEqual([465, 214]);
    expect(absolute(at(0, 5))).toEqual([300, 223]);
    expect(absolute(at(0, 6))).toEqual([362, 232]);
    expect(absolute(at(1))).toEqual([207, 86]); // EQ ear closed
    expect(absolute(at(1, 0, 0))).toEqual([215, 152]); // EQ handle closed
    expect(absolute(at(1, 4))).toEqual([291, 96]); // the panel's own box; ear x + 84
    expect(absolute(at(2))).toEqual([277, 86]); // PL ear closed
    expect(absolute(at(2, 3, 0))).toEqual([523, 151]); // PL handle closed
  });

  it('leaves the jscript: lengths at their defaults, and the band sliders at their literal height and probed width', () => {
    const panel = at(1, 4);
    const volume = panel.children[6];
    expect(volume.id).toBe('volume');
    expect([volume.get('left'), volume.get('top')]).toEqual([0, 0]);
    expect(volume.source('left')).toEqual({ kind: 'jscript', source: 'balance.left+balance.width+10;' });
    expect(volume.source('top')).toEqual({ kind: 'jscript', source: 'balance.top;' });
    expect([volume.get('width'), volume.get('height')]).toEqual([71, 11]);
    for (let i = 1; i <= 10; i++) {
      const band = /** @type {ElementModel} */ (view.byId(`eq${i}`));
      expect([band.get('left'), band.get('top'), band.get('width'), band.get('height')], band.id).toEqual([0, 0, 11, 76]);
      expect(band.source('left')?.kind).toBe('jscript');
    }
    expect(/** @type {ElementModel} */ (view.byId('eq1')).source('left')).toEqual({ kind: 'jscript', source: 'balance.left+3;' });
    expect(/** @type {ElementModel} */ (view.byId('eq10')).source('left')).toMatchObject({ kind: 'jscript', source: expect.stringMatching(/^eq9\.left\+15;?$/) });
  });

  it('classifies the value languages the way survey R0 counts them: 25 jscript:, 18 wmpprop:, 2 wmpenabled:', () => {
    // The raw tree and the model are in the same source order, the THEME excepted.
    /** @type {RawNode[]} */
    const flat = [];
    (function walk(/** @type {RawNode} */ n) { flat.push(n); n.children.forEach(walk); })(raw);
    flat.shift(); // the THEME
    expect(flat).toHaveLength(view.elements.length);
    const count = { jscript: 0, wmpprop: 0, wmpenabled: 0 };
    flat.forEach((node, i) => {
      for (const a of node.attrs) {
        if (/^on|_onchange$/.test(a.name)) continue;
        const m = /^\s*(jscript|wmpprop|wmpenabled|wmpdisabled):/i.exec(a.value);
        if (!m) continue;
        const kind = m[1].toLowerCase();
        expect(view.elements[i].source(a.name)?.kind, `${node.tag} ${a.name}`).toBe(kind);
        if (kind === 'jscript' || kind === 'wmpprop' || kind === 'wmpenabled') count[kind]++;
      }
    });
    expect(count).toEqual({ jscript: 25, wmpprop: 18, wmpenabled: 2 });
    // and the PAUSEBUTTON's visible binding, spelled `wmpenabled:`
    expect(at(0, 2).source('visible')).toEqual({ kind: 'wmpenabled', method: 'pause' });
    expect(at(0, 2).get('visible')).toBe(true); // until the binding settles
  });

  it('registers the VIEW\'s and the ears\' handlers', () => {
    expect(view.view.handlers.get('onload')?.source).toMatch(/^Init\(\);?$/);
    expect(view.view.handlers.get('onclose')?.source).toMatch(/OnClose/);
    expect(view.view.handlers.get('onload')?.line).toBeGreaterThan(0);
    expect(at(1).handlers.get('onendmove')?.source).toMatch(/EqOnEndMove/);
    expect(at(2).handlers.get('onendmove')?.source).toMatch(/PlOnEndMove/);
    expect(/** @type {ElementModel} */ (view.byId('visDrop')).handlers.get('onendmove')?.source).toMatch(/VisDropOnEndMove/);
    expect(/** @type {ElementModel} */ (view.byId('eq1')).handlers.get('value_onchange')?.source).toMatch(/eq\.gainlevel1/i);
  });

  it('numbers the id-less elements per base kind, and the EQ labels and drop controls are addressable', () => {
    /** @type {Map<string, string[]>} */
    const unnamed = new Map();
    for (const e of view.elements) {
      if (!/^Unnamed_/.test(e.id)) continue;
      unnamed.set(e.kind, [...(unnamed.get(e.kind) ?? []), e.id]);
    }
    // every kind counts 1, 2, 3 ... in file order, whatever the tag (a PAUSEBUTTON is a button)
    for (const [kind, ids] of unnamed) expect(ids, kind).toEqual(ids.map((_, i) => `Unnamed_${kind}_${i + 1}`));
    expect(unnamed.get('button')).toHaveLength(5);
    expect(unnamed.get('subview')).toHaveLength(19);
    expect(unnamed.get('text')).toHaveLength(4);
    expect(view.byId('unnamed_subview_1')).toBe(at(0));
    expect(view.byId('visDrop')).toBe(at(0, 8));
    expect(view.byId('sEqEar')).toBe(at(1));
    expect(view.byId('SPLEAR')).toBe(at(2)); // case-insensitive, as script reaches ids
  });

  it('prints the Unnamed_* ids the sidecar needs (E D10.6; O copies them in at G2)', () => {
    const visDrop = /** @type {ElementModel} */ (view.byId('visDrop'));
    const visNext = visDrop.children.find((c) => c.kind === 'button' && /next\(\)/i.test(c.handlers.get('onclick')?.source ?? ''));
    const visPrev = visDrop.children.find((c) => c.kind === 'button' && /previous\(\)/i.test(c.handlers.get('onclick')?.source ?? ''));
    const reset = view.elements.find((e) => e.kind === 'text' && /eq\.reset/i.test(e.handlers.get('onclick')?.source ?? ''));
    const presetTitle = visDrop.children.find((c) => c.kind === 'text');
    expect(visNext).toBeDefined();
    expect(visPrev).toBeDefined();
    expect(reset).toBeDefined();
    expect(presetTitle?.source('value')).toMatchObject({ kind: 'wmpprop', path: { root: 'visEffects' } });
    // eslint-disable-next-line no-console
    console.log(`W2.1 Unnamed ids for the sidecar: visNext=${visNext?.id} visPrev=${visPrev?.id} reset=${reset?.id} presetTitle=${presetTitle?.id}`);
    // Pinned: a change in numbering would silently move every sidecar and demo address.
    expect([visNext?.id, reset?.id, presetTitle?.id]).toEqual(['Unnamed_button_4', 'Unnamed_text_4', 'Unnamed_text_1']);
  });

  describe('paintOrder reproduces parity 0.6 exactly', () => {
    it('inside the view: both ears under the head layer, the head over the (absent) view background, the three tooltip texts last', () => {
      // sEqEar, sPlEar (z -1), the view's own background, the head (z 0), then xEqTt, xPlTt, xVisTt (z 0)
      expect(paths(view.paintOrder(view.view))).toEqual(['1', '2', 'bg', '0', '3', '4', '5']);
    });

    it('inside the head: screen (-2), visual drop (-1), the head background (0), the z 2 group in file order, then the pause button (3)', () => {
      // 7 screen, 8 visDrop | bg | minimize/close, transport, EQ button, PL button, seek, theme button (z 2) | pause (z 3)
      expect(paths(view.paintOrder(at(0)))).toEqual(['0.7', '0.8', 'bg', '0.0', '0.1', '0.3', '0.4', '0.5', '0.6', '0.2']);
    });

    it('in the EQ ear: the panel (-1) under the ear pieces, which keep file order', () => {
      expect(paths(view.paintOrder(at(1)))).toEqual(['1.4', 'bg', '1.0', '1.1', '1.2', '1.3']);
      // left_ear holds the handle and the close button at z 1 over its own background
      expect(paths(view.paintOrder(at(1, 0)))).toEqual(['bg', '1.0.0', '1.0.1']);
    });

    it('in the PL ear: the panel (-1) under the drawer pieces and the ear art', () => {
      expect(paths(view.paintOrder(at(2)))).toEqual(['2.4', 'bg', '2.0', '2.1', '2.2', '2.3']);
      expect(paths(view.paintOrder(at(2, 4)))).toEqual(['bg', '2.4.0', '2.4.1', '2.4.2', '2.4.3', '2.4.4']);
    });

    it('in the screen and the drop: the background first, then the children by z', () => {
      expect(paths(view.paintOrder(at(0, 7)))).toEqual(['bg', '0.7.0', '0.7.1']); // vid_bkgd, effects, video
      expect(paths(view.paintOrder(at(0, 8)))).toEqual(['bg', '0.8.0', '0.8.1', '0.8.2', '0.8.3']); // buttons z 1, then the title z 2
    });

    it('in the EQ panel: the four frames and the ten bands (z 0) under the z 1 controls, in file order', () => {
      const order = paths(view.paintOrder(at(1, 4)));
      expect(order.slice(0, 15)).toEqual(['bg', '1.4.0', '1.4.1', '1.4.2', '1.4.3', '1.4.9', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '1.4.14', '1.4.15', '1.4.16', '1.4.17', '1.4.18']);
      expect(order.slice(15)).toEqual(['1.4.4', '1.4.5', '1.4.6', '1.4.7', '1.4.19']); // balance, label, volume, label, reset
      expect(order).not.toContain('1.4.8'); // the EQUALIZERSETTINGS draws nothing
    });

    it('is not what reading B would give: the PL panel would paint over the screen', () => {
      const flat = buildTheme(raw, vfs, { probe: () => null, stacking: 'flat' }).views[0];
      const order = paths(flat.paintOrder(flat.view));
      expect(order.indexOf('2.4')).toBeGreaterThan(order.indexOf('0.7')); // the failure parity 0.1 rule 4 works out
      expect(paths(view.paintOrder(view.view))).toEqual(['1', '2', 'bg', '0', '3', '4', '5']);
    });
  });

  it('keeps the literal values of the hidden and shown states as the file says', () => {
    expect(at(0, 7, 0).get('visible')).toBe(false); // effects, shown by EndVideo()
    expect(at(0, 7, 1).get('visible')).toBe(false); // video
    expect(at(0, 8).get('visible')).toBe(false); // visDrop
    expect(at(1, 4).get('visible')).toBe(false); // sEqView
    expect(at(1, 0, 1).get('visible')).toBe(false); // EQ close
    expect(at(2, 4, 4).get('visible')).toBe(false); // playlist
    expect(at(2, 4).get('visible')).toBe(true);
    expect(at(0, 8).get('transparencyColor')).toBe(null); // viz_drop uses clippingColor, not transparency
    expect(at(0, 8).get('clippingColor')).toBe(0xff00ff);
    expect(at(0).get('transparencyColor')).toBe(0xff00ff);
    expect(at(0).get('clippingColor')).toBe(0xff0000);
  });
});
