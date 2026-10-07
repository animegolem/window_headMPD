// @ts-check
// `recordAnchors` and `relayout` (WAVES W3.1 acceptance 1; ENGINE D5 "After the pass, `layout/align`
// records each element's margins. A parent resize re-places by alignment"). The unit cases need no
// realm: the literal pass gives every element the geometry they read. The last block runs the real
// `jscript:` pass first, as the view runtime will.

import { describe, expect, it } from 'vitest';
import { evaluateLayout } from '../../../src/engine/layout/expr.js';
import { marginsOf, recordAnchors, relayout } from '../../../src/engine/layout/align.js';
import { buildSkin, openSession, skinBytes, wmsOf } from './harness.js';

/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */

/**
 * The model of a VIEW (760 x 394 unless told otherwise) with the given children, anchors recorded.
 * @param {string} body @param {{ viewAttrs?: string, record?: boolean }} [opts]
 */
async function build(body, opts = {}) {
  const { view } = await buildSkin(skinBytes(wmsOf(body, opts.viewAttrs)));
  if (opts.record !== false) recordAnchors(view);
  const el = (/** @type {string} */ id) => /** @type {ElementModel} */ (view.byId(id));
  /** left, top, width, height @param {string} id */
  const box = (id) => ['left', 'top', 'width', 'height'].map((a) => el(id).get(a));
  return { view, el, box };
}

describe('relayout by alignment', () => {
  it('keeps left- and top-aligned elements where they are (the defaults)', async () => {
    const { view, box } = await build('<TEXT id="t" left="100" top="50" width="40" height="20"/>');
    view.takeDirty();
    relayout(view, 900, 500);
    expect(box('t')).toEqual([100, 50, 40, 20]);
    expect([view.view.get('width'), view.view.get('height')]).toEqual([900, 500]);
  });

  it('right keeps the right margin; bottom keeps the bottom margin; and the way back restores both', async () => {
    const { view, box } = await build('<TEXT id="t" left="700" top="360" width="50" height="20" horizontalAlignment="right" verticalAlignment="bottom"/>');
    relayout(view, 800, 500);
    expect(box('t')).toEqual([740, 466, 50, 20]);   // 760-750 = 10 and 394-380 = 14 kept: 800-10-50, 500-14-20
    relayout(view, 600, 300);
    expect(box('t')).toEqual([540, 266, 50, 20]);
    relayout(view, 760, 394);
    expect(box('t')).toEqual([700, 360, 50, 20]);
  });

  it('center keeps the offset from the parent\'s centre', async () => {
    const { view, box } = await build('<TEXT id="t" left="330" top="150" width="100" height="40" horizontalAlignment="center" verticalAlignment="center"/>');
    // centre at (380, 170) in 760 x 394: offset 0 horizontally, -27 vertically
    relayout(view, 860, 494);
    const [left, top, width, height] = box('t');
    expect(left + width / 2 - 860 / 2).toBe(0);
    expect(top + height / 2 - 494 / 2).toBe(170 - 394 / 2);
    expect([left, top]).toEqual([380, 200]);     // +50 horizontally and +50 vertically: half of 100
  });

  it('stretch keeps both margins: left stays, width follows', async () => {
    const { view, box } = await build('<TEXT id="t" left="20" top="30" width="700" height="300" horizontalAlignment="stretch" verticalAlignment="stretch"/>');
    // margins: left 20, right 760-720 = 40; top 30, bottom 394-330 = 64
    relayout(view, 900, 500);
    expect(box('t')).toEqual([20, 30, 840, 406]);
    relayout(view, 760, 394);
    expect(box('t')).toEqual([20, 30, 700, 300]);
  });

  it('takes any combination of the two axes', async () => {
    const { view, box } = await build(`
      <TEXT id="a" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>
      <TEXT id="b" left="10" top="360" width="50" height="20" verticalAlignment="bottom"/>
      <TEXT id="c" left="10" top="10" width="740" height="20" horizontalAlignment="stretch" verticalAlignment="center"/>`);
    relayout(view, 800, 400);
    expect(box('a')).toEqual([740, 10, 50, 20]);
    expect(box('b')).toEqual([10, 366, 50, 20]);
    expect(box('c')).toEqual([10, 13, 780, 20]);
  });

  it('settles containers top-down: a right-aligned child of a stretched SUBVIEW follows the SUBVIEW\'s new edge', async () => {
    const { view, box } = await build(`
      <SUBVIEW id="panel" left="10" top="10" width="300" height="200" horizontalAlignment="stretch" verticalAlignment="stretch">
        <TEXT id="inner" left="250" top="170" width="40" height="20" horizontalAlignment="right" verticalAlignment="bottom"/>
        <TEXT id="bar" left="10" top="10" width="280" height="20" horizontalAlignment="stretch"/>
        <TEXT id="fixed" left="5" top="5" width="10" height="10"/>
      </SUBVIEW>`);
    relayout(view, 860, 444);
    expect(box('panel')).toEqual([10, 10, 400, 250]);
    expect(box('inner')).toEqual([350, 220, 40, 20]);
    expect(box('bar')).toEqual([10, 10, 380, 20]);
    expect(box('fixed')).toEqual([5, 5, 10, 10]);
    relayout(view, 760, 394);
    expect([box('panel'), box('inner'), box('bar')]).toEqual([[10, 10, 300, 200], [250, 170, 40, 20], [10, 10, 280, 20]]);
  });

  it('does not move the children of a SUBVIEW whose own size did not change', async () => {
    const { view, box } = await build(`
      <SUBVIEW id="panel" left="10" top="10" width="300" height="200">
        <TEXT id="inner" left="250" top="170" width="40" height="20" horizontalAlignment="right" verticalAlignment="bottom"/>
      </SUBVIEW>`);
    relayout(view, 900, 600);
    expect(box('panel')).toEqual([10, 10, 300, 200]);
    expect(box('inner')).toEqual([250, 170, 40, 20]);
  });

  it('is a no-op for the size the children were placed for: nothing dirty, nothing queued', async () => {
    const { view, box } = await build('<TEXT id="t" left="700" top="360" width="50" height="20" horizontalAlignment="right" verticalAlignment="bottom" left_onchange="x=1"/>');
    view.takeDirty();
    view.takeQueuedEvents();
    relayout(view, 760, 394);
    expect(box('t')).toEqual([700, 360, 50, 20]);
    expect(view.takeDirty().size).toBe(0);
    expect(view.takeQueuedEvents()).toEqual([]);
  });

  it('writes with origin layout: dirty, with the _onchange handler queued', async () => {
    const { view } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right" left_onchange="x=1"/>');
    view.takeDirty();
    /** @type {string[]} */
    const origins = [];
    view.onChange((el, attr, _v, origin) => { origins.push(`${el.id}.${attr}:${origin}`); });
    relayout(view, 800, 394);
    expect(origins).toEqual(['main.width:layout', 't.left:layout']);
    expect(view.takeQueuedEvents().map((q) => `${q.el.id}.${q.event}`)).toEqual(['t.left_onchange']);
  });

  it('records on the first relayout when recordAnchors was never called', async () => {
    const { view, box } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>', { record: false });
    relayout(view, 800, 394);
    expect(box('t')[0]).toBe(740);
    relayout(view, 760, 394);
    expect(box('t')[0]).toBe(700);
  });
});

describe('what the margins are measured from', () => {
  it('marginsOf reports the margins to the size the parent\'s children were placed for, and relayout keeps them', async () => {
    const { view, el } = await build(`
      <TEXT id="t" left="700" top="360" width="50" height="20" horizontalAlignment="right" verticalAlignment="bottom"/>
      <TEXT id="u" left="20" top="30" width="700" height="300" horizontalAlignment="stretch"/>`);
    expect(marginsOf(el('t'))).toEqual({ left: 700, top: 360, right: 10, bottom: 14 });
    expect(marginsOf(el('u'))).toEqual({ left: 20, top: 30, right: 40, bottom: 64 });
    expect(marginsOf(view.view)).toBe(null);          // the VIEW has no parent
    relayout(view, 900, 500);
    // measured against the new size now that the children were placed for it
    expect(marginsOf(el('t'))).toEqual({ left: 840, top: 466, right: 10, bottom: 14 });
    // `u` stretches across, so its right margin held; it is top-aligned, so its bottom margin grew
    expect(marginsOf(el('u'))).toEqual({ left: 20, top: 30, right: 40, bottom: 170 });
  });

  it('marginsOf is null for an element with no geometry or no record', async () => {
    const { el } = await build('<AUTOMENU id="menu" left="3" top="4"/><TEXT id="t" left="1" top="2"/>');
    expect(marginsOf(el('menu'))).toBe(null);          // no width or height
    const fresh = await build('<TEXT id="t" left="1" top="2"/>', { record: false });
    expect(marginsOf(fresh.el('t'))).toBe(null);       // never recorded
  });

  it('keeps the margin an element has now: a script that moved a right-aligned element is not undone', async () => {
    const { view, el, box } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>');
    el('t').set('left', 600, 'script');           // a drawer slid left; its right margin is 110 now
    relayout(view, 800, 394);
    expect(box('t')[0]).toBe(640);
  });

  it('does not move anything for a size a script wrote without a relayout (Headspace\'s 549, parity D13)', async () => {
    const { view, el, box } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>');
    view.view.set('width', 549, 'script');          // the model says 549; the window, and the children, stay at 760
    expect(box('t')[0]).toBe(700);
    relayout(view, 760, 394);                       // the children were placed for 760
    expect(box('t')[0]).toBe(700);
    expect(view.view.get('width')).toBe(760);
    relayout(view, 800, 394);
    expect(box('t')[0]).toBe(740);
    expect(el('t').get('width')).toBe(50);
  });

  it('re-places by the container\'s size now, when a script resized the container and a relayout comes', async () => {
    const { view, el, box } = await build(`
      <SUBVIEW id="panel" left="0" top="0" width="300" height="100">
        <TEXT id="inner" left="250" top="10" width="40" height="20" horizontalAlignment="right"/>
      </SUBVIEW>`);
    el('panel').set('width', 340, 'script');
    expect(box('inner')[0]).toBe(250);              // nothing re-placed on a script write
    relayout(view, 900, 394);                       // the panel is not stretched, but it is 340 wide now
    expect(box('inner')[0]).toBe(290);
  });

  it('recordAnchors again re-bases on the geometry as it stands', async () => {
    const { view, el, box } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>');
    view.view.set('width', 549, 'script');
    recordAnchors(view);
    relayout(view, 600, 394);
    expect(box('t')[0]).toBe(751);                  // +51 from 549
    expect(el('t').get('width')).toBe(50);
  });
});

describe('relayout: limits and odd inputs', () => {
  it('does not drift on a centred element when the change is odd', async () => {
    const { view, box } = await build('<TEXT id="t" left="331" top="10" width="100" height="20" horizontalAlignment="center"/>');
    for (let i = 0; i < 10; i++) {
      relayout(view, 761, 394);
      relayout(view, 760, 394);
    }
    expect(box('t')[0]).toBe(331);
    relayout(view, 761, 394);
    expect(box('t')[0]).toBe(332);                  // 331.5, half to even
  });

  it('follows the size the model actually took: the view cap clamps, and the children use the clamped size', async () => {
    const { view, box } = await build(`
      <TEXT id="r" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>
      <TEXT id="s" left="10" top="10" width="700" height="20" horizontalAlignment="stretch"/>`);
    relayout(view, 99999, 99999);
    expect([view.view.get('width'), view.view.get('height')]).toEqual([4096, 4096]);
    expect(box('r')[0]).toBe(700 + (4096 - 760));
    expect(box('s')[2]).toBe(700 + (4096 - 760));
  });

  it('never gives a stretched element a negative size', async () => {
    const { view, box } = await build('<TEXT id="s" left="10" top="10" width="700" height="300" horizontalAlignment="stretch" verticalAlignment="stretch"/>');
    relayout(view, 100, 50);
    expect(box('s')).toEqual([10, 10, 40, 0]);      // width 700 - 660 = 40; height 300 - 344 -> 0
    relayout(view, 10, 10);
    expect(box('s')[2]).toBe(0);
  });

  it('ignores a size that is not a number', async () => {
    const { view, box } = await build('<TEXT id="t" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>');
    relayout(view, NaN, /** @type {any} */ (undefined));
    expect(view.view.get('width')).toBe(760);
    expect(box('t')[0]).toBe(700);
    relayout(view, -50, 394);                         // a negative width is a width of 0
    expect(view.view.get('width')).toBe(0);
    expect(box('t')[0]).toBe(700 - 760);
  });

  it('leaves elements without alignment attributes alone (PLAYER, AUTOMENU, BUTTONELEMENT) and does not throw', async () => {
    const { view, el, box } = await build(`
      <PLAYER><currentMedia id="cm"/></PLAYER>
      <AUTOMENU id="menu" left="700" top="10"/>
      <BUTTONGROUP id="g" left="700" top="10" width="60" height="20" horizontalAlignment="right">
        <BUTTONELEMENT id="e1" mappingColor="#ff0000"/>
      </BUTTONGROUP>
      <EQUALIZERSETTINGS id="eq"/>`);
    expect(() => relayout(view, 800, 394)).not.toThrow();
    expect(el('menu').get('left')).toBe(700);
    expect(box('g')[0]).toBe(740);
  });

  it('treats the ids __proto__ and constructor as ordinary elements', async () => {
    const { view, el } = await build(`
      <TEXT id="__proto__" left="700" top="10" width="50" height="20" horizontalAlignment="right"/>
      <SUBVIEW id="constructor" left="10" top="10" width="300" height="100" horizontalAlignment="stretch">
        <TEXT id="toString" left="250" top="10" width="40" height="20" horizontalAlignment="right"/>
      </SUBVIEW>`);
    relayout(view, 800, 394);
    expect(el('__proto__').get('left')).toBe(740);
    expect(el('constructor').get('width')).toBe(340);
    expect(el('toString').get('left')).toBe(290);
  });
});

describe('after the jscript: pass (the order the runtime uses)', () => {
  it('places by expression once, then keeps the anchor through a resize', async () => {
    const s = await openSession(skinBytes(wmsOf(`
      <BUTTON id="close" left="jscript:view.width-30" top="4" width="22" height="16" horizontalAlignment="right"/>
      <TEXT id="status" left="8" top="jscript:view.height-20" width="jscript:view.width-16" height="14" horizontalAlignment="stretch" verticalAlignment="bottom"/>
      <SUBVIEW id="side" left="jscript:view.width-120" top="0" width="120" height="jscript:view.height" horizontalAlignment="right" verticalAlignment="stretch"/>`)), { scripts: false });
    expect(evaluateLayout(s.view, s.realm, { passBudgetMs: 1000 })).toEqual([]);
    recordAnchors(s.view);
    const box = (/** @type {string} */ id) => ['left', 'top', 'width', 'height'].map((a) => s.view.byId(id)?.get(a));
    expect(box('close')).toEqual([730, 4, 22, 16]);
    expect(box('status')).toEqual([8, 374, 744, 14]);
    expect(box('side')).toEqual([640, 0, 120, 394]);

    relayout(s.view, 1000, 500);
    expect(box('close')).toEqual([970, 4, 22, 16]);
    expect(box('status')).toEqual([8, 480, 984, 14]);
    expect(box('side')).toEqual([880, 0, 120, 500]);

    relayout(s.view, 760, 394);
    expect(box('close')).toEqual([730, 4, 22, 16]);
    expect(box('status')).toEqual([8, 374, 744, 14]);
    expect(box('side')).toEqual([640, 0, 120, 394]);
  });
});
