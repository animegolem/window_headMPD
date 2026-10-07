// @vitest-environment happy-dom
// Input dispatch (E §5.11 `attachInput`, E D2 gestures, D10.1 right press, D10.5 keys). The view is
// built from a synthetic raw tree through `buildTheme`, so handlers, attributes and ids reach the
// dispatcher the way a skin's do. The picker is a fake over a rect table that answers in the real
// picker's `Pick` shape (a BUTTONGROUP part is its BUTTONELEMENT with `part` its index, `local` from
// the group's origin; `dispatch-picker.test.js` runs the real one), the sink records every call, and
// the window is the test host's `TestSkinWindow`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DBLCLICK_MS, attachInput, cssCursor, sliderValueAt, virtualKeyCode,
} from '../../../src/engine/input/dispatch.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createTestSkinWindow } from '../../../src/hosts/test/window.js';
import { buildTheme } from '../../../src/engine/wms/build.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */

/** @param {Record<string, string | number | boolean>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** @param {string} tag @param {Record<string, string | number | boolean>} [attrs] @param {RawNode[]} [children] @returns {RawNode} */
const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

const vfs = () => ({
  sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null,
});

/** A BUTTON at a place, with the handlers a test gives it. */
const button = (id, left, top, extra = {}) => N('button', { id, left, top, width: 40, height: 20, ...extra });

const created = [];
afterEach(() => {
  while (created.length) created.pop()();
  document.body.replaceChildren();
});

/**
 * @param {{
 *   kids?: RawNode[],
 *   zoom?: number,
 *   deps?: import('../../../src/engine/input/dispatch.js').InputDeps,
 *   opts?: Partial<import('../../../src/engine/contracts').EngineOptions>,
 *   rects?: Array<{ id: string, x: number, y: number, w: number, h: number, role?: string, part?: number | null, origin?: { x: number, y: number } }>,
 *   rect?: { left: number, top: number },
 * }} [cfg]
 */
function rig(cfg = {}) {
  const kids = cfg.kids ?? [button('A', 10, 10, { onclick: 'a()' }), button('B', 100, 10, { onclick: 'b()' })];
  const theme = buildTheme(N('theme', {}, [N('view', { id: 'v', width: 400, height: 300 }, kids)]), vfs(), { probe: () => null });
  const view = theme.views[0];
  const plane = document.createElement('div');
  document.body.append(plane);
  const zoom = cfg.zoom ?? 1;
  const origin = cfg.rect ?? { left: 0, top: 0 };
  if (cfg.rect) plane.getBoundingClientRect = () => /** @type {DOMRect} */ ({ ...origin, x: origin.left, y: origin.top, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
  const win = createTestSkinWindow({ zoom });

  /** The rect table, first match wins: tests move things by editing it. */
  const rects = cfg.rects ?? [
    { id: 'A', x: 10, y: 10, w: 40, h: 20 }, { id: 'B', x: 100, y: 10, w: 40, h: 20 },
    { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' },
  ];
  const pickAt = (x, y) => {
    const r = rects.find((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h);
    if (!r) return null;
    const o = r.origin ?? r;                         // `local` is from the element's origin, a group part's from the GROUP's
    return { el: /** @type {any} */ (view.byId(r.id)), part: r.part ?? null, role: /** @type {any} */ (r.role ?? 'control'), local: { x: x - o.x, y: y - o.y } };
  };

  /** @type {Array<{ id: string, event: string, part: number | null, init: any }>} */
  const gestures = [];
  /** @type {Array<{ id: string, phase: string, value: number }>} */
  const drags = [];
  /** @type {Array<{ event: string, id: string, init: any }>} */
  const keys = [];
  const handle = { key: /** @type {(event: string, id: string) => boolean} */ (() => false) };
  const sink = {
    gesture: (el, event, init, part) => { gestures.push({ id: el.id, event, part, init }); },
    dragSlider: (el, phase, value) => { drags.push({ id: el.id, phase, value }); },
    key: (event, init) => { keys.push({ event, id: init.srcElement.id, init }); return handle.key(event, init.srcElement.id); },
  };
  const off = attachInput(plane, view, pickAt, win, sink, { ...FAITHFUL, ...cfg.opts }, cfg.deps);
  created.push(off);

  /** @param {string} type @param {number} x view px @param {number} y @param {Record<string, any>} [init] @param {{ trusted?: boolean, timeStamp?: number }} [flags] */
  const ptr = (type, x, y, init = {}, flags = {}) => {
    const e = new PointerEvent(type, {
      clientX: x * zoom + origin.left, clientY: y * zoom + origin.top, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      bubbles: type !== 'pointerleave', cancelable: true, ...init,
    });
    if (flags.trusted) Object.defineProperty(e, 'isTrusted', { value: true });
    if (flags.timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: flags.timeStamp });
    plane.dispatchEvent(e);
    return e;
  };
  const press = (x, y, init = {}, flags = {}) => ptr('pointerdown', x, y, { buttons: 1, ...init }, flags);
  const release = (x, y, init = {}, flags = {}) => ptr('pointerup', x, y, init, flags);
  const move = (x, y, init = {}) => ptr('pointermove', x, y, init);
  const click = (x, y, flags = {}) => { press(x, y, {}, flags); release(x, y, {}, flags); };
  const names = (...only) => gestures.filter((g) => only.includes(g.event)).map((g) => `${g.id}:${g.event}`);
  const clear = () => { gestures.length = 0; drags.length = 0; keys.length = 0; };
  const key = (type, init) => {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    (init?.target ?? document.body).dispatchEvent(e);
    return e;
  };
  return { view, plane, win, rects, gestures, drags, keys, handle, ptr, press, release, move, click, names, clear, key, off, el: (id) => /** @type {any} */ (view.byId(id)) };
}

describe('gestures', () => {
  it('press on A and release on B fires down on A, up on B, and no click', () => {
    const r = rig();
    r.press(20, 15);
    r.release(110, 15);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['A:onmousedown', 'B:onmouseup']);
  });

  it('press and release on A fire exactly one click, after the up', () => {
    const r = rig();
    r.press(20, 15);
    r.release(25, 18);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['A:onmousedown', 'A:onmouseup', 'A:onclick']);
    expect(r.gestures.find((g) => g.event === 'onclick')?.init).toMatchObject({ button: 1, x: 25, y: 18, offsetX: 15, offsetY: 8, srcElement: r.el('A') });
  });

  it('a trailing DOM click, as the demo adds, produces nothing', () => {
    const r = rig();
    r.click(20, 15);
    r.clear();
    r.plane.dispatchEvent(new MouseEvent('click', { clientX: 20, clientY: 15, bubbles: true }));
    expect(r.gestures).toEqual([]);
  });

  it('a press that moves off the element and back still clicks it, and the pressed element alone sees the leave and re-entry', () => {
    const r = rig();
    r.press(20, 15);
    r.clear();
    r.move(110, 15);                       // over B while A is held: B hears nothing
    r.move(200, 100);
    r.move(30, 20);
    r.release(30, 20);
    expect(r.names('onmouseover', 'onmouseout', 'onmouseup', 'onclick')).toEqual(['A:onmouseout', 'A:onmouseover', 'A:onmouseup', 'A:onclick']);
  });

  it('a release over nothing still ends the press: the up goes to the pressed element, with no click', () => {
    const r = rig();
    r.press(20, 15);
    r.release(300, 200);
    expect(r.names('onmouseup', 'onclick')).toEqual(['A:onmouseup']);
  });

  it('hover has no bubbling: only the picked element hears over and out, in the order out then over', () => {
    const r = rig();
    r.move(20, 15);
    r.move(110, 15);
    r.move(300, 200);
    expect(r.names('onmouseover', 'onmouseout')).toEqual(['A:onmouseover', 'A:onmouseout', 'B:onmouseover', 'B:onmouseout']);
    const [overA, outA, overB] = r.gestures;
    expect(overA.init).toMatchObject({ fromElement: null, srcElement: r.el('A') });
    expect(outA.init.toElement).toBe(r.el('B'));
    expect(overB.init.fromElement).toBe(r.el('A'));
  });

  it('onmousemove reaches only an element that has such a handler', () => {
    const r = rig({ kids: [button('A', 10, 10, { onmousemove: 'm()' }), button('B', 100, 10, { onclick: 'b()' })] });
    r.move(20, 15);
    r.move(22, 16);
    r.move(110, 15);
    r.move(112, 16);
    expect(r.names('onmousemove')).toEqual(['A:onmousemove', 'A:onmousemove']);
  });

  it('two clicks on the same element within the window make one ondblclick, and a third does not make another', () => {
    const r = rig();
    r.click(20, 15);
    expect(r.names('ondblclick')).toEqual([]);
    r.click(20, 15);
    expect(r.names('onclick', 'ondblclick')).toEqual(['A:onclick', 'A:onclick', 'A:ondblclick']);
    r.click(20, 15);
    expect(r.names('ondblclick')).toEqual(['A:ondblclick']);
  });

  it('no ondblclick when the second click is late, far, or on another element', () => {
    const r = rig();
    r.press(20, 15, {}, { timeStamp: 1000 }); r.release(20, 15, {}, { timeStamp: 1010 });
    r.press(20, 15, {}, { timeStamp: 1000 + DBLCLICK_MS + 50 }); r.release(20, 15, {}, { timeStamp: 1000 + DBLCLICK_MS + 60 });
    expect(r.names('ondblclick')).toEqual([]);
    r.clear();
    r.click(15, 15);
    r.click(45, 15);                       // still on A, but 30 px away
    expect(r.names('ondblclick')).toEqual([]);
    r.click(20, 15);
    r.click(110, 15);                      // B
    expect(r.names('ondblclick')).toEqual([]);
  });

  describe('a BUTTONGROUP, in the real picker\'s Pick shape: el the BUTTONELEMENT, part its index, local from the group', () => {
    // The group is at (20, 10), 60 x 20; its parts split it at x 50.
    const E0 = { id: 'e0', mappingColor: '#FF0000', onclick: 'x()', upToolTip: 'Rewind', cursor: 'hand' };
    const E1 = { id: 'e1', mappingColor: '#00FF00', onclick: 'y()', onmousedown: 'z()', upToolTip: 'Play', downToolTip: 'Pause' };
    const group = (groupAttrs = {}, e0 = E0, e1 = E1) => rig({
      kids: [N('buttongroup', { id: 'g', left: 20, top: 10, width: 60, height: 20, ...groupAttrs }, [N('buttonelement', e0), N('buttonelement', e1)])],
      rects: [
        { id: 'e0', x: 20, y: 10, w: 30, h: 20, part: 0, origin: { x: 20, y: 10 } },
        { id: 'e1', x: 50, y: 10, w: 30, h: 20, part: 1, origin: { x: 20, y: 10 } },
        { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' },
      ],
    });

    it('1. gestures name the BUTTONELEMENT as target and srcElement, with its index as the part', () => {
      const r = group();
      r.press(60, 15);
      r.release(60, 15);
      expect(r.gestures.filter((g) => ['onmousedown', 'onmouseup', 'onclick'].includes(g.event)).map((g) => [g.id, g.event, g.part]))
        .toEqual([['e1', 'onmousedown', 1], ['e1', 'onmouseup', 1], ['e1', 'onclick', 1]]);
      expect(r.gestures.every((g) => g.init.srcElement === r.el('e1'))).toBe(true);
      r.clear();
      r.move(30, 15);
      expect(r.gestures.map((g) => [g.id, g.event, g.part])).toEqual([['e1', 'onmouseout', 1], ['e0', 'onmouseover', 0]]);
    });

    it('2. the parts are different targets: down on one and up on another is no click, and each tooltip is its own element\'s', () => {
      const r = group();
      r.move(30, 15);
      expect(r.plane.title).toBe('Rewind');
      expect(r.plane.style.cursor).toBe('pointer');
      r.move(60, 15);
      expect(r.plane.title).toBe('Play');
      r.clear();
      r.press(60, 15);
      r.release(30, 15);
      expect(r.gestures.filter((g) => ['onmousedown', 'onmouseup', 'onclick'].includes(g.event)).map((g) => [g.id, g.event, g.part]))
        .toEqual([['e1', 'onmousedown', 1], ['e0', 'onmouseup', 0]]);
      r.clear();
      r.press(30, 15);
      r.release(30, 15);
      expect(r.names('onclick')).toEqual(['e0:onclick']);
    });

    it('3. offsetX and offsetY are measured from the group\'s top-left, not the part\'s', () => {
      const r = group();
      r.press(62, 17);
      expect(r.gestures.find((g) => g.event === 'onmousedown')?.init).toMatchObject({ x: 62, y: 17, offsetX: 42, offsetY: 7 });
      r.release(62, 17);
      expect(r.gestures.find((g) => g.event === 'onclick')?.init).toMatchObject({ offsetX: 42, offsetY: 7 });
    });

    it('4. a blocked pick (a disabled BUTTONELEMENT or group) is swallowed: no events, capture or window drag', () => {
      const r = group();
      for (const rect of r.rects) if (rect.id === 'e1') rect.role = 'blocked';
      r.press(60, 15, {}, { trusted: true });
      r.release(60, 15);
      expect(r.gestures).toEqual([]);
      expect(r.win.recorded.captures).toEqual([]);
      expect(r.win.recorded.drags).toBe(0);
      r.click(30, 15);                     // the enabled part beside it still works
      expect(r.names('onclick')).toEqual(['e0:onclick']);
    });

    it('5. keys and the right press go to the BUTTONELEMENT: it takes the focus, and only its own mouse handlers count', () => {
      const r = group({ onmousedown: 'g()' }, { id: 'e0', mappingColor: '#FF0000', upToolTip: 'Rewind' });   // the group has a handler, e0 has none
      r.click(60, 15);                     // e1 takes the focus
      expect(r.view.view.get('focusObjectID')).toBe('e1');
      r.clear();
      r.key('keydown', { key: 'a', code: 'KeyA' });
      expect(r.keys.filter((k) => k.event === 'onkeydown').map((k) => k.id)).toEqual(['e1', 'v']);
      r.clear();
      expect(r.press(60, 15, { button: 2, buttons: 2 }).defaultPrevented).toBe(true);    // e1 has a handler: the skin takes it
      r.release(60, 15, { button: 2 });
      expect(r.names('onmousedown')).toEqual(['e1:onmousedown']);
      r.clear();
      expect(r.press(30, 15, { button: 2, buttons: 2 }).defaultPrevented).toBe(false);   // e0 has none, and the group's does not stand in
      expect(r.gestures).toEqual([]);
    });

    it('a latched-down BUTTONELEMENT shows its downToolTip and the tooltip follows the change under a resting pointer', () => {
      const r = group();
      r.move(60, 15);
      expect(r.plane.title).toBe('Play');
      r.el('e1').set('down', true, 'script');
      expect(r.plane.title).toBe('Pause');
    });
  });
});

describe('capture', () => {
  it('setCapture(true) on a control press and false on the up', () => {
    const r = rig();
    r.press(20, 15);
    expect(r.win.recorded.captures).toEqual([true]);
    r.release(20, 15);
    expect(r.win.recorded.captures).toEqual([true, false]);
  });

  it('pointercancel ends the press: capture off, no up, no click, the pressed element is left', () => {
    const r = rig();
    r.press(20, 15);
    r.clear();
    r.ptr('pointercancel', 20, 15);
    expect(r.win.recorded.captures).toEqual([true, false]);
    expect(r.names('onmouseup', 'onclick', 'onmouseout')).toEqual(['A:onmouseout']);
    r.release(20, 15);                     // a stray up after the cancel does nothing
    expect(r.names('onmouseup', 'onclick')).toEqual([]);
  });

  it('a window blur mid-press also releases capture, so a lost pointerup cannot leave the window grabbed', () => {
    const r = rig();
    r.press(20, 15);
    window.dispatchEvent(new Event('blur'));
    expect(r.win.recorded.captures).toEqual([true, false]);
  });

  it('a second pointerdown after a lost pointerup ends the old press first', () => {
    const r = rig();
    r.press(20, 15);
    r.press(110, 15);
    expect(r.win.recorded.captures).toEqual([true, false, true]);
    r.release(110, 15);
    expect(r.names('onmousedown', 'onclick')).toEqual(['A:onmousedown', 'B:onmousedown', 'B:onclick']);
  });

  it('setPointerCapture and releasePointerCapture throwing (a synthetic pointer id) change nothing', () => {
    const r = rig();
    r.plane.setPointerCapture = () => { throw new DOMException('NotFoundError'); };
    r.plane.releasePointerCapture = () => { throw new DOMException('NotFoundError'); };
    expect(() => { r.press(20, 15); r.release(20, 15); }).not.toThrow();
    expect(r.names('onclick')).toEqual(['A:onclick']);
    expect(r.win.recorded.captures).toEqual([true, false]);
  });

  it('asks the plane to capture the real pointer, and lets it go', () => {
    const r = rig();
    const set = vi.fn(), unset = vi.fn();
    r.plane.setPointerCapture = set;
    r.plane.releasePointerCapture = unset;
    r.press(20, 15, { pointerId: 7 });
    r.release(20, 15, { pointerId: 7 });
    expect(set).toHaveBeenCalledWith(7);
    expect(unset).toHaveBeenCalledWith(7);
  });

  it('a press on chrome or a blocked element takes no capture', () => {
    const r = rig({ rects: [{ id: 'A', x: 10, y: 10, w: 40, h: 20, role: 'blocked' }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }] });
    r.press(20, 15);
    r.release(20, 15);
    r.press(200, 200);
    r.release(200, 200);
    expect(r.win.recorded.captures).toEqual([]);
  });

  it('detaching mid-press lets go of capture and removes every listener', () => {
    const r = rig();
    r.press(20, 15);
    r.off();
    expect(r.win.recorded.captures).toEqual([true, false]);
    r.clear();
    r.press(20, 15);
    r.release(20, 15);
    r.move(110, 15);
    expect(r.gestures).toEqual([]);
    expect(r.win.recorded.captures).toEqual([true, false]);
    expect(r.plane.title).toBe('');
  });
});

describe('the window drag (chrome)', () => {
  it('a press on chrome with isTrusted false never calls startDrag; a real one does', () => {
    const r = rig();
    r.press(200, 200);
    r.release(200, 200);
    expect(r.win.recorded.drags).toBe(0);
    r.press(200, 200, {}, { trusted: true });
    expect(r.win.recorded.drags).toBe(1);
  });

  it('only a left press drags: not a right press, not Control-click or Option-click', () => {
    const r = rig();
    r.press(200, 200, { button: 2, buttons: 2 }, { trusted: true });
    r.press(200, 200, { ctrlKey: true }, { trusted: true });
    r.press(200, 200, { altKey: true }, { trusted: true });
    expect(r.win.recorded.drags).toBe(0);
  });

  it('a real press on a control starts no window drag, and a blocked or widget pick does nothing at all', () => {
    const r = rig({ rects: [
      { id: 'A', x: 10, y: 10, w: 40, h: 20 }, { id: 'B', x: 100, y: 10, w: 40, h: 20, role: 'blocked' },
      { id: 'v', x: 150, y: 10, w: 40, h: 20, role: 'widget' }] });
    r.press(20, 15, {}, { trusted: true });
    r.release(20, 15);
    r.clear();
    r.press(110, 15, {}, { trusted: true });
    r.release(110, 15);
    r.press(160, 15, {}, { trusted: true });
    r.release(160, 15);
    expect(r.win.recorded.drags).toBe(0);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual([]);
    expect(r.win.recorded.captures).toEqual([true, false]);
  });

  it('a pick of nothing is a no-op', () => {
    const r = rig({ rects: [] });
    r.press(20, 15, {}, { trusted: true });
    r.release(20, 15);
    r.move(30, 30);
    expect(r.gestures).toEqual([]);
    expect(r.win.recorded.drags).toBe(0);
  });
});

describe('right press (D10.1: skin first, host second)', () => {
  it('goes to the sink with button 2 and reports handled when the element has onmousedown', () => {
    const r = rig({ kids: [button('A', 10, 10, { onmousedown: 'd()' }), button('B', 100, 10)] });
    const e = r.press(20, 15, { button: 2, buttons: 2 });
    expect(r.names('onmousedown')).toEqual(['A:onmousedown']);
    expect(r.gestures.find((g) => g.event === 'onmousedown')?.init.button).toBe(2);
    expect(e.defaultPrevented).toBe(true);
    const menu = new MouseEvent('contextmenu', { clientX: 20, clientY: 15, bubbles: true, cancelable: true });
    r.plane.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    r.release(20, 15, { button: 2 });
    expect(r.names('onmouseup')).toEqual(['A:onmouseup']);
    expect(r.win.recorded.captures).toEqual([true, false]);
  });

  it('an onclick-only or onmouseup-only handler counts too, and the click is delivered as button 2', () => {
    const r = rig();                       // A and B have onclick
    const e = r.press(20, 15, { button: 2, buttons: 2 });
    r.release(20, 15, { button: 2 });
    expect(e.defaultPrevented).toBe(true);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['A:onmousedown', 'A:onmouseup', 'A:onclick']);
    expect(r.gestures.filter((g) => g.event === 'onclick').map((g) => g.init.button)).toEqual([2]);
    const up = rig({ kids: [button('A', 10, 10, { onmouseup: 'u()' })] });
    expect(up.press(20, 15, { button: 2, buttons: 2 }).defaultPrevented).toBe(true);
  });

  it('with no mouse handler it is not handled: nothing reaches the sink and the menu is left to open', () => {
    const r = rig({ kids: [button('A', 10, 10, { onmouseover: 'o()' }), button('B', 100, 10)] });
    r.move(20, 15);
    r.clear();
    const e = r.press(20, 15, { button: 2, buttons: 2 });
    r.release(20, 15, { button: 2 });
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    r.plane.dispatchEvent(menu);
    expect(e.defaultPrevented).toBe(false);
    expect(menu.defaultPrevented).toBe(false);
    expect(r.gestures).toEqual([]);
    expect(r.win.recorded.captures).toEqual([]);
  });

  it('on chrome, or over nothing, it is not handled', () => {
    const r = rig();
    expect(r.press(200, 200, { button: 2, buttons: 2 }).defaultPrevented).toBe(false);
    const none = rig({ rects: [] });
    expect(none.press(20, 15, { button: 2, buttons: 2 }).defaultPrevented).toBe(false);
  });

  it('a later contextmenu that no skin-handled press preceded is not suppressed (keyboard menu key, long press)', () => {
    const r = rig();
    r.press(20, 15, { button: 2, buttons: 2 });
    r.release(20, 15, { button: 2 });
    r.press(200, 200, { button: 2, buttons: 2 });      // the next right press is on chrome: it resets the report
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    r.plane.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });

  it('Control-click and Option-click are ignored here, so the shell menu keeps them', () => {
    const r = rig();
    const ctrl = r.press(20, 15, { ctrlKey: true });
    r.release(20, 15, { ctrlKey: true });
    const alt = r.press(20, 15, { altKey: true });
    r.release(20, 15, { altKey: true });
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true });
    r.plane.dispatchEvent(menu);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual([]);
    expect([ctrl.defaultPrevented, alt.defaultPrevented, menu.defaultPrevented]).toEqual([false, false, false]);
    expect(r.win.recorded.captures).toEqual([]);
  });

  it('the middle button is not ours', () => {
    const r = rig();
    r.press(20, 15, { button: 1, buttons: 4 });
    r.release(20, 15, { button: 1 });
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual([]);
  });
});

describe('slider drag', () => {
  /** Horizontal seek bar 163 px long with an 18 px thumb: travel 145 (parity D32), at x 10, value 0..1000. */
  const seek = () => rig({
    kids: [N('slider', { id: 'seek', left: 10, top: 0, width: 163, height: 11, min: 0, max: 1000, thumbImage: 'thumb.bmp' })],
    rects: [{ id: 'seek', x: 10, y: 0, w: 163, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
    deps: { thumbExtent: () => 18 },
  });

  it('emits begin, move and end with values from the oracle geometry', () => {
    const r = seek();
    r.press(10 + 9 + 72.5, 5);             // the middle of the travel: 9 px of half thumb plus 72.5 of the 145
    r.release(10 + 9 + 72.5, 5);
    expect(r.drags.map((d) => d.phase)).toEqual(['begin', 'end']);
    expect(r.drags[0].value).toBeCloseTo(500, 9);
    r.clear();
    r.press(10 + 9, 5);                    // thumb centre at the first travel end: value min
    r.move(10 + 9 + 145 * 0.25, 5);
    r.move(10 + 9 + 145 * 0.25, 6);        // same x: no new value
    r.move(10 + 9 + 145 * 0.75, 5);
    r.move(500, 5);                        // far past the end, still captured: clamps to max
    r.move(-50, 5);                        // and the other way
    r.release(10 + 9 + 145 * 0.5, 5);
    expect(r.drags.map((d) => d.phase)).toEqual(['begin', 'move', 'move', 'move', 'move', 'end']);
    expect(r.drags.map((d) => d.id)).toEqual(Array(6).fill('seek'));
    const v = r.drags.map((d) => d.value);
    expect(v[0]).toBeCloseTo(0, 9);
    expect(v[1]).toBeCloseTo(250, 9);
    expect(v[2]).toBeCloseTo(750, 9);
    expect(v[3]).toBe(1000);
    expect(v[4]).toBe(0);
    expect(v[5]).toBeCloseTo(500, 9);
  });

  it('keeps the value continuous (D31): no rounding to whole units', () => {
    const r = seek();
    r.press(10 + 9 + 1, 5);
    expect(r.drags[0].value).toBeCloseTo(1000 / 145, 9);
  });

  it('puts max at the top of a vertical slider, over height - thumb (parity D32: 76 - 11 = 65)', () => {
    const r = rig({
      kids: [N('slider', { id: 'eq', left: 0, top: 20, width: 11, height: 76, min: -14, max: 14, direction: 'vertical', thumbImage: 't.bmp' })],
      rects: [{ id: 'eq', x: 0, y: 20, w: 11, h: 76 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
      deps: { thumbExtent: () => 11 },
    });
    r.press(5, 20 + 5.5 + 65);             // thumb centre at the bottom of the travel: min
    r.move(5, 20 + 5.5);                   // at the top: max
    r.move(5, 20 + 5.5 + 32.5);            // half way: 0
    r.release(5, 20 + 5.5 + 32.5);
    expect(r.drags.map((d) => d.phase)).toEqual(['begin', 'move', 'move', 'end']);
    expect(r.drags[0].value).toBeCloseTo(-14, 9);
    expect(r.drags[1].value).toBeCloseTo(14, 9);
    expect(r.drags[2].value).toBeCloseTo(0, 9);
    expect(r.drags[3].value).toBeCloseTo(0, 9);
  });

  it("the 'docs' geometry centres the thumb over [borderSize, length - borderSize]", () => {
    const r = rig({
      kids: [N('slider', { id: 's', left: 0, top: 0, width: 71, height: 11, min: 0, max: 100, borderSize: 7, thumbImage: 't.bmp' })],
      rects: [{ id: 's', x: 0, y: 0, w: 71, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
      deps: { thumbExtent: () => 9 },
      opts: { sliderGeometry: 'docs' },
    });
    r.press(7, 5);                         // docs travel is 71 - 14 = 57, starting at 7
    r.move(7 + 57 / 2, 5);
    r.release(7 + 57, 5);
    expect(r.drags.map((d) => d.value)).toEqual([0, 50, 100]);
  });

  it("the same slider under 'oracle' travels length - thumb (71 - 9 = 62), centred from half a thumb in", () => {
    const r = rig({
      kids: [N('slider', { id: 's', left: 0, top: 0, width: 71, height: 11, min: 0, max: 100, borderSize: 7, thumbImage: 't.bmp' })],
      rects: [{ id: 's', x: 0, y: 0, w: 71, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
      deps: { thumbExtent: () => 9 },
    });
    r.press(4.5, 5);
    r.move(4.5 + 31, 5);
    r.release(4.5 + 62, 5);
    expect(r.drags.map((d) => d.value)).toEqual([0, 50, 100]);
  });

  it('works at zoom 2 inside an offset window: position comes from client px over the zoom', () => {
    const r = rig({
      zoom: 2,
      rect: { left: 100, top: 40 },
      kids: [N('slider', { id: 'seek', left: 10, top: 0, width: 163, height: 11, min: 0, max: 1000, thumbImage: 't.bmp' })],
      rects: [{ id: 'seek', x: 10, y: 0, w: 163, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
      deps: { thumbExtent: () => 18 },
    });
    r.press(10 + 9 + 72.5, 5);
    r.release(10 + 9 + 145, 5);
    expect(r.drags[0].value).toBeCloseTo(500, 9);
    expect(r.drags[1].value).toBe(1000);
    expect(r.gestures.find((g) => g.event === 'onmousedown')?.init).toMatchObject({ x: 91, y: 5, offsetX: 81, offsetY: 5 });
  });

  it('also passes the plain gestures, and a thumb-less slider is not a drag at all', () => {
    const r = seek();
    r.press(60, 5);
    r.release(60, 5);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['seek:onmousedown', 'seek:onmouseup', 'seek:onclick']);
    const bare = rig({
      kids: [N('slider', { id: 'seek', left: 10, top: 0, width: 163, height: 11, min: 0, max: 100 })],
      rects: [{ id: 'seek', x: 10, y: 0, w: 163, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
    });
    bare.press(60, 5);
    bare.release(60, 5);
    expect(bare.drags).toEqual([]);
  });

  it('a right press does not drag, and a cancel ends the drag at its last value', () => {
    const r = seek();
    r.press(60, 5, { button: 2, buttons: 2 });
    r.release(60, 5, { button: 2 });
    expect(r.drags).toEqual([]);
    r.press(10 + 9 + 145 * 0.5, 5);
    r.move(10 + 9 + 145 * 0.9, 5);
    r.ptr('pointercancel', 100, 5);
    expect(r.drags.map((d) => d.phase)).toEqual(['begin', 'move', 'end']);
    expect(r.drags[2].value).toBeCloseTo(900, 9);
  });

  it('without a thumbExtent the thumb counts as zero length: the travel is the whole track', () => {
    const r = rig({
      kids: [N('slider', { id: 's', left: 0, top: 0, width: 100, height: 11, min: 0, max: 100, thumbImage: 't.bmp' })],
      rects: [{ id: 's', x: 0, y: 0, w: 100, h: 11 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
    });
    r.press(40, 5);
    expect(r.drags[0].value).toBe(40);
  });

  it('sliderValueAt: both geometries, both axes, degenerate travel', () => {
    const base = { min: 0, max: 100, length: 100, thumb: 20, border: 10, vertical: false, mode: /** @type {'oracle' | 'docs'} */ ('oracle') };
    expect(sliderValueAt(base, 10)).toBe(0);
    expect(sliderValueAt(base, 50)).toBe(50);
    expect(sliderValueAt({ ...base, mode: 'docs' }, 10)).toBe(0);
    expect(sliderValueAt({ ...base, mode: 'docs' }, 50)).toBe(50);
    expect(sliderValueAt({ ...base, vertical: true }, 10)).toBe(100);
    expect(sliderValueAt({ ...base, min: 100, max: 0 }, 10)).toBe(100);          // a reversed range reverses the value
    expect(sliderValueAt({ ...base, thumb: 100 }, 40)).toBe(0);                   // thumb as long as the track: nowhere to go
    expect(sliderValueAt({ ...base, thumb: 100, vertical: true }, 40)).toBe(0);
  });
});

describe('tooltip and cursor on the input plane', () => {
  it('hover changes title and cursor, and leaving clears them', () => {
    const r = rig({ kids: [button('A', 10, 10, { upToolTip: 'Play', cursor: 'hand', onclick: 'a()' }), button('B', 100, 10, { upToolTip: 'Stop', onclick: 'b()' })] });
    r.move(20, 15);
    expect([r.plane.title, r.plane.style.cursor]).toEqual(['Play', 'pointer']);
    r.move(110, 15);
    expect([r.plane.title, r.plane.style.cursor]).toEqual(['Stop', 'default']);
    r.move(200, 200);                      // chrome
    expect([r.plane.title, r.plane.style.cursor]).toEqual(['', '']);
    r.move(20, 15);
    r.ptr('pointerleave', 500, 500);
    expect([r.plane.title, r.plane.style.cursor]).toEqual(['', '']);
    expect(r.names('onmouseout')).toContain('A:onmouseout');
  });

  it('a slider shows its toolTip, with the hand cursor by default', () => {
    const r = rig({
      kids: [N('slider', { id: 's', left: 0, top: 0, width: 100, height: 11, toolTip: 'Seek', thumbImage: 't.bmp' })],
      rects: [{ id: 's', x: 0, y: 0, w: 100, h: 11 }],
    });
    r.move(5, 5);
    expect([r.plane.title, r.plane.style.cursor]).toEqual(['Seek', 'pointer']);
  });

  it('a latched-down button shows its downToolTip, falling back to the up text', () => {
    const r = rig({ kids: [button('A', 10, 10, { upToolTip: 'Mute', downToolTip: 'Sound', sticky: true, onclick: 'a()' }), button('B', 100, 10, { upToolTip: 'Repeat', sticky: true, onclick: 'b()' })] });
    r.el('A').set('down', true, 'script');
    r.el('B').set('down', true, 'script');
    r.move(20, 15);
    expect(r.plane.title).toBe('Sound');
    r.move(110, 15);
    expect(r.plane.title).toBe('Repeat');
  });

  it('follows the tooltip and cursor of the element under a resting pointer when a script changes them', () => {
    const r = rig({ kids: [button('A', 10, 10, { upToolTip: 'Open', cursor: 'hand', onclick: 'a()' })] });
    r.move(20, 15);
    r.el('A').set('upToolTip', 'Close', 'script');
    expect(r.plane.title).toBe('Close');
    r.el('A').set('cursor', 'help', 'script');
    expect(r.plane.style.cursor).toBe('help');
  });

  it('a disabled (blocked) element still shows its tooltip but takes no gestures', () => {
    const r = rig({ kids: [button('A', 10, 10, { upToolTip: 'Stop', enabled: false })], rects: [{ id: 'A', x: 10, y: 10, w: 40, h: 20, role: 'blocked' }] });
    r.move(20, 15);
    expect(r.plane.title).toBe('Stop');
    expect(r.gestures).toEqual([]);
  });

  it('an unknown or file cursor name keeps the cursor as it was (U-21)', () => {
    const r = rig({ kids: [
      button('A', 10, 10, { cursor: 'hand', onclick: 'a()' }),
      button('B', 100, 10, { cursor: 'sizetopright', onclick: 'b()' }),
      button('C', 200, 10, { cursor: 'my.cur', onclick: 'c()' }),
    ], rects: [
      { id: 'A', x: 10, y: 10, w: 40, h: 20 }, { id: 'B', x: 100, y: 10, w: 40, h: 20 }, { id: 'C', x: 200, y: 10, w: 40, h: 20 },
      { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }] });
    r.move(110, 15);
    expect(r.plane.style.cursor).toBe('');            // nothing before it: stays unset
    r.move(20, 15);
    expect(r.plane.style.cursor).toBe('pointer');
    r.move(110, 15);
    expect(r.plane.style.cursor).toBe('pointer');
    r.move(210, 15);
    expect(r.plane.style.cursor).toBe('pointer');
    r.move(200, 100);
    expect(r.plane.style.cursor).toBe('');
  });

  it('cursor names that are Object.prototype members are unknown names, not lookups (rule 6)', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(cssCursor(name), name).toBeNull();
    }
    const r = rig({ kids: [
      button('A', 10, 10, { cursor: 'hand', onclick: 'a()' }),
      button('B', 100, 10, { cursor: '__proto__', onclick: 'b()' }),
      button('C', 200, 10, { cursor: 'constructor', onclick: 'c()' }),
    ], rects: [
      { id: 'A', x: 10, y: 10, w: 40, h: 20 }, { id: 'B', x: 100, y: 10, w: 40, h: 20 }, { id: 'C', x: 200, y: 10, w: 40, h: 20 },
      { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }] });
    r.move(20, 15);
    r.move(110, 15);
    expect(r.plane.style.cursor).toBe('pointer');
    r.move(210, 15);
    expect(r.plane.style.cursor).toBe('pointer');
    expect(r.plane.style.cursor).not.toMatch(/object|native/i);
  });

  it('cssCursor maps every documented keyword', () => {
    const want = { system: 'default', hand: 'pointer', help: 'help', sizeall: 'move', sizens: 'ns-resize', sizewe: 'ew-resize', sizenesw: 'nesw-resize', sizenwse: 'nwse-resize', uparrow: 'default' };
    for (const [k, v] of Object.entries(want)) expect(cssCursor(k), k).toBe(v);
    expect(cssCursor('HAND')).toBe('pointer');
    expect(cssCursor('')).toBeNull();
    expect(cssCursor(null)).toBeNull();
    expect(cssCursor(5)).toBeNull();
  });
});

describe('keyboard', () => {
  it('routes the focused element first and the VIEW second, and says whether a skin handler ran', () => {
    const r = rig();
    r.click(20, 15);                       // A takes the focus
    r.clear();
    r.handle.key = (event, id) => id === 'v';
    const e = r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(r.keys.filter((k) => k.event === 'onkeydown').map((k) => k.id)).toEqual(['A', 'v']);
    expect(e.defaultPrevented).toBe(true);
  });

  it('a key no skin handler ran for is left alone, for the shell defaults', () => {
    const r = rig();
    r.handle.key = () => false;
    const e = r.key('keydown', { key: ' ', code: 'Space' });
    expect(e.defaultPrevented).toBe(false);
    expect(r.keys.length).toBeGreaterThan(0);
  });

  it('the VIEW alone gets a key when nothing is focused', () => {
    const r = rig();
    r.key('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true });
    expect(r.keys.map((k) => [k.event, k.id])).toEqual([['onkeydown', 'v']]);
    expect(r.keys[0].init).toMatchObject({ keyCode: 37, shiftKey: true, ctrlKey: false, altKey: false, srcElement: r.view.view, button: 0 });
  });

  it('fires onkeypress after onkeydown for a printable key or Enter, never for arrows or Ctrl-chords, and onkeyup on release', () => {
    const r = rig();
    r.key('keydown', { key: 'v', code: 'KeyV' });
    r.key('keyup', { key: 'v', code: 'KeyV' });
    r.key('keydown', { key: 'Enter', code: 'Enter' });
    r.key('keydown', { key: 'ArrowUp', code: 'ArrowUp' });
    r.key('keydown', { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(r.keys.map((k) => k.event)).toEqual(['onkeydown', 'onkeypress', 'onkeyup', 'onkeydown', 'onkeypress', 'onkeydown', 'onkeydown']);
    expect(r.keys.map((k) => k.init.keyCode)).toEqual([86, 118, 86, 13, 13, 38, 67]);    // `v`: virtual key 86, character 118
  });

  it('keypress carries the character code, keydown and keyup the virtual key (spec 5.7)', () => {
    const cases = [
      // [KeyboardEvent init, VK on keydown and keyup, character code on keypress]
      [{ key: 'v', code: 'KeyV' }, 86, 118],
      [{ key: 'V', code: 'KeyV', shiftKey: true }, 86, 86],
      [{ key: ' ', code: 'Space' }, 32, 32],
      [{ key: 'Enter', code: 'Enter' }, 13, 13],
      [{ key: '5', code: 'Numpad5' }, 101, 53],
      [{ key: '1', code: 'Digit1' }, 49, 49],
      [{ key: ',', code: 'Comma' }, 188, 44],
      [{ key: '+', code: 'Equal', shiftKey: true }, 187, 43],
    ];
    for (const [init, vk, ch] of cases) {
      const r = rig();
      r.key('keydown', init);
      r.key('keyup', init);
      expect(r.keys.map((k) => [k.event, k.init.keyCode]), JSON.stringify(init)).toEqual([['onkeydown', vk], ['onkeypress', ch], ['onkeyup', vk]]);
    }
  });

  it('the focused element and the VIEW both get the same codes: the focused one first, per event', () => {
    const r = rig();
    r.click(20, 15);
    r.clear();
    r.key('keydown', { key: 'v', code: 'KeyV' });
    expect(r.keys.map((k) => [k.event, k.id, k.init.keyCode])).toEqual([
      ['onkeydown', 'A', 86], ['onkeydown', 'v', 86], ['onkeypress', 'A', 118], ['onkeypress', 'v', 118],
    ]);
  });

  it('a skin that handles only onkeypress still stops the shell default for that key', () => {
    const r = rig();
    r.handle.key = (event) => event === 'onkeypress';
    expect(r.key('keydown', { key: ' ', code: 'Space' }).defaultPrevented).toBe(true);
    expect(r.keys.find((k) => k.event === 'onkeypress')?.init.keyCode).toBe(32);           // Space is 32 as a virtual key and as a character
  });

  it('typing into a text field, or an event someone already handled, is not the skin', () => {
    const r = rig();
    const field = document.createElement('input');
    document.body.append(field);
    r.handle.key = () => true;
    r.key('keydown', { key: 'a', code: 'KeyA', target: field });
    expect(r.keys).toEqual([]);
    const pre = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true });
    pre.preventDefault();
    document.body.dispatchEvent(pre);
    expect(r.keys).toEqual([]);
  });

  it('a script-set focusObjectID moves the focus, and a press writes it back for the script to read', () => {
    const r = rig();
    const downs = () => r.keys.filter((k) => k.event === 'onkeydown').map((k) => k.id);
    r.view.view.set('focusObjectID', 'B', 'script');
    r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(downs()).toEqual(['B', 'v']);
    r.clear();
    r.click(20, 15);
    expect(r.view.view.get('focusObjectID')).toBe('A');
    r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(downs()).toEqual(['A', 'v']);
  });

  it('ids that are Object.prototype members take the focus like any other (rule 6)', () => {
    const r = rig({
      kids: [button('__proto__', 10, 10, { onclick: 'a()' }), button('constructor', 100, 10, { onclick: 'b()' })],
      rects: [{ id: '__proto__', x: 10, y: 10, w: 40, h: 20 }, { id: 'constructor', x: 100, y: 10, w: 40, h: 20 }, { id: 'v', x: 0, y: 0, w: 400, h: 300, role: 'chrome' }],
    });
    r.click(20, 15);
    r.key('keydown', { key: 'a', code: 'KeyA' });
    r.click(110, 15);
    r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(r.keys.filter((k) => k.event === 'onkeydown').map((k) => k.id)).toEqual(['__proto__', 'v', 'constructor', 'v']);
    r.clear();
    r.view.view.set('focusObjectID', 'toString', 'script');          // not an element: only the VIEW is asked
    r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(r.keys.filter((k) => k.event === 'onkeydown').map((k) => k.id)).toEqual(['v']);
  });

  it('detaching stops key routing', () => {
    const r = rig();
    r.off();
    r.key('keydown', { key: 'a', code: 'KeyA' });
    expect(r.keys).toEqual([]);
  });

  it('virtualKeyCode: by code, by key for a synthetic event, then the legacy keyCode', () => {
    const cases = [
      [{ code: 'KeyA' }, 65], [{ code: 'KeyZ' }, 90], [{ code: 'Digit0' }, 48], [{ code: 'Digit9' }, 57], [{ code: 'Numpad5' }, 101],
      [{ code: 'F1' }, 112], [{ code: 'F12' }, 123], [{ code: 'Space' }, 32], [{ code: 'Enter' }, 13], [{ code: 'Escape' }, 27],
      [{ code: 'ArrowLeft' }, 37], [{ code: 'ArrowUp' }, 38], [{ code: 'ArrowRight' }, 39], [{ code: 'ArrowDown' }, 40],
      [{ code: 'Comma' }, 188], [{ code: 'BracketLeft' }, 219], [{ code: 'Semicolon' }, 186],
      [{ key: 'v' }, 86], [{ key: 'V' }, 86], [{ key: '7' }, 55], [{ key: ' ' }, 32], [{ key: 'ArrowDown' }, 40], [{ key: 'Enter' }, 13],
      [{ keyCode: 33 }, 33], [{}, 0], [{ code: 'Unknown', key: 'Dead', keyCode: 0 }, 0],
    ];
    for (const [ev, vk] of cases) expect(virtualKeyCode(ev), JSON.stringify(ev)).toBe(vk);
    expect(virtualKeyCode({ code: '__proto__' })).toBe(0);
    expect(virtualKeyCode({ code: 'constructor', key: 'constructor' })).toBe(0);
  });
});

describe('event data', () => {
  it('fills screen position and size from the DOM event and screen, and the pointer in view px', () => {
    const r = rig({ zoom: 2, rect: { left: 30, top: 20 } });
    r.press(20, 15, { screenX: 800, screenY: 600 });
    const down = r.gestures.find((g) => g.event === 'onmousedown')?.init;
    expect(down).toMatchObject({ x: 20, y: 15, clientX: 20, clientY: 15, offsetX: 10, offsetY: 5, screenX: 800, screenY: 600, button: 1, keyCode: 0, srcElement: r.el('A') });
    expect(down.screenWidth).toBeGreaterThan(0);
    expect(down.screenHeight).toBeGreaterThan(0);
  });

  it('carries the modifier keys of the press', () => {
    const r = rig();
    r.press(20, 15, { shiftKey: true });
    expect(r.gestures.find((g) => g.event === 'onmousedown')?.init).toMatchObject({ shiftKey: true, ctrlKey: false, altKey: false });
  });
});
