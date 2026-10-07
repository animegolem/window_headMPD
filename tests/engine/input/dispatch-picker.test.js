// @vitest-environment happy-dom
// Input dispatch over the real picker (G3.F2; E §5.11). `dispatch.test.js` answers with a fake picker
// in the real `Pick` shape; this file wires `pick` itself to `attachInput` over a synthetic view, so
// the shape the dispatcher is written against is the one the picker returns: for a BUTTONGROUP `el`
// is the BUTTONELEMENT that owns the pixel, `part` its index, `local` from the GROUP's top-left;
// `enabled=false` on the element or the group makes it `blocked`; a SLIDER with no thumbImage and no
// mouse handler is `chrome`. Pixels are in-test literals (nothing reads art).
import { afterEach, describe, expect, it } from 'vitest';
import { attachInput } from '../../../src/engine/input/dispatch.js';
import { pick } from '../../../src/engine/input/picker.js';
import { createTestSkinWindow } from '../../../src/hosts/test/window.js';
import { FAITHFUL, N, image, slotsOf, solidImage, syncImages, viewOf } from '../shape/support.js';

const created = [];
afterEach(() => {
  while (created.length) created.pop()();
  document.body.replaceChildren();
});

// The group is 90 x 20 with its parts side by side: red 0..29, green 30..59, blue 60..89.
const MAPPING = image(90, 20, (x) => (x < 30 ? 0xff0000 : x < 60 ? 0x00ff00 : 0x0000ff));

/**
 * One view with: group `g` at (20, 10) (parts e0 e1 e2, e2 disabled), group `gd` at (20, 40) that is
 * disabled as a whole (part d0), a thumbless slider `bar` with no handler at (150, 10), a thumbless
 * slider `tap` with an onclick at (150, 25) and a slider `seek` with a thumb at (150, 40).
 */
function rig() {
  const images = syncImages({
    'map.bmp': MAPPING,
    'g.bmp': solidImage(90, 20, 0x336699),
    'bar.bmp': solidImage(100, 11, 0x445566),
    'track.bmp': solidImage(100, 11, 0x445566),
    'thumb.bmp': solidImage(10, 11, 0x778899),
  });
  const view = viewOf([
    N('buttongroup', { id: 'g', left: 20, top: 10, mappingImage: 'map.bmp', image: 'g.bmp' }, [
      N('buttonelement', { id: 'e0', mappingColor: '#FF0000', onclick: 'x()', upToolTip: 'Rewind' }),
      N('buttonelement', { id: 'e1', mappingColor: '#00FF00', onclick: 'y()', upToolTip: 'Play' }),
      N('buttonelement', { id: 'e2', mappingColor: '#0000FF', onclick: 'z()', enabled: false }),
    ]),
    N('buttongroup', { id: 'gd', left: 20, top: 40, mappingImage: 'map.bmp', image: 'g.bmp', enabled: false }, [
      N('buttonelement', { id: 'd0', mappingColor: '#FF0000', onclick: 'd()' }),
    ]),
    N('slider', { id: 'bar', left: 150, top: 10, backgroundImage: 'bar.bmp', min: 0, max: 100 }),
    N('slider', { id: 'tap', left: 150, top: 25, backgroundImage: 'bar.bmp', min: 0, max: 100, onclick: 't()' }),
    N('slider', { id: 'seek', left: 150, top: 40, backgroundImage: 'track.bmp', thumbImage: 'thumb.bmp', min: 0, max: 100 }),
  ], { images, width: 300, height: 100 });

  const plane = document.createElement('div');
  document.body.append(plane);
  const win = createTestSkinWindow({ zoom: 1 });
  const slots = slotsOf();
  /** @type {Array<{ id: string, event: string, part: number | null, init: any }>} */
  const gestures = [];
  /** @type {Array<{ id: string, phase: string, value: number }>} */
  const drags = [];
  const sink = {
    gesture: (el, event, init, part) => { gestures.push({ id: el.id, event, part, init }); },
    dragSlider: (el, phase, value) => { drags.push({ id: el.id, phase, value }); },
    key: () => false,
  };
  const off = attachInput(plane, view, (x, y) => pick(view, images, slots, x, y, FAITHFUL), win, sink, FAITHFUL,
    { thumbExtent: (el) => images.probe(String(el.get('thumbimage')))?.width ?? 0 });
  created.push(off);

  /** @param {string} type @param {number} x @param {number} y @param {Record<string, any>} [init] @param {boolean} [trusted] */
  const ptr = (type, x, y, init = {}, trusted = false) => {
    const e = new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, ...init });
    if (trusted) Object.defineProperty(e, 'isTrusted', { value: true });
    plane.dispatchEvent(e);
    return e;
  };
  const press = (x, y, init = {}, trusted = false) => ptr('pointerdown', x, y, { buttons: 1, ...init }, trusted);
  const release = (x, y, init = {}) => ptr('pointerup', x, y, init);
  const names = (...only) => gestures.filter((g) => only.includes(g.event)).map((g) => `${g.id}:${g.event}:${g.part}`);
  return { view, plane, win, gestures, drags, press, release, move: (x, y) => ptr('pointermove', x, y), names };
}

describe('a BUTTONGROUP through the real picker', () => {
  it('1 and 2. the BUTTONELEMENT is the target and srcElement, and its index the part', () => {
    const r = rig();
    r.press(20 + 35, 15, {}, true);
    r.release(20 + 35, 15);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['e1:onmousedown:1', 'e1:onmouseup:1', 'e1:onclick:1']);
    expect(r.gestures.every((g) => g.init.srcElement === r.view.byId('e1'))).toBe(true);
    expect(r.win.recorded.drags).toBe(0);                  // a control press never drags the window
    r.press(20 + 5, 15);
    r.release(20 + 5, 15);
    expect(r.names('onclick')).toEqual(['e1:onclick:1', 'e0:onclick:0']);
  });

  it('2. down on one part and up on another is no click, and the tooltip is the part\'s own', () => {
    const r = rig();
    r.move(20 + 5, 15);
    expect(r.plane.title).toBe('Rewind');
    r.move(20 + 35, 15);
    expect(r.plane.title).toBe('Play');
    r.gestures.length = 0;
    r.press(20 + 35, 15);
    r.release(20 + 5, 15);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['e1:onmousedown:1', 'e0:onmouseup:0']);
  });

  it('3. offsetX and offsetY are from the group\'s top-left (local is the group\'s, not the part\'s)', () => {
    const r = rig();
    r.press(20 + 42, 10 + 7);
    expect(r.gestures.find((g) => g.event === 'onmousedown')?.init).toMatchObject({ x: 62, y: 17, offsetX: 42, offsetY: 7 });
  });

  it('4. a disabled BUTTONELEMENT, and a disabled group, swallow the press', () => {
    const r = rig();
    r.press(20 + 70, 15, {}, true);                        // e2, disabled itself
    r.release(20 + 70, 15);
    r.press(20 + 5, 40 + 5, {}, true);                     // d0, in a disabled group
    r.release(20 + 5, 40 + 5);
    expect(r.gestures).toEqual([]);
    expect(r.win.recorded.captures).toEqual([]);
    expect(r.win.recorded.drags).toBe(0);
    r.press(20 + 5, 15);
    r.release(20 + 5, 15);
    expect(r.names('onclick')).toEqual(['e0:onclick:0']);
  });
});

describe('sliders through the real picker', () => {
  it('5. a thumbless slider with no handler is chrome: a real left press drags the window, a slider drag never starts', () => {
    const r = rig();
    r.press(150 + 50, 10 + 5, {}, true);
    r.release(150 + 50, 10 + 5);
    expect(r.win.recorded.drags).toBe(1);
    expect(r.gestures).toEqual([]);
    expect(r.drags).toEqual([]);
  });

  it('a thumbless slider with a mouse handler is a control with the plain gestures and no slider drag', () => {
    const r = rig();
    r.press(150 + 50, 25 + 5, {}, true);
    r.release(150 + 50, 25 + 5);
    expect(r.win.recorded.drags).toBe(0);
    expect(r.names('onmousedown', 'onmouseup', 'onclick')).toEqual(['tap:onmousedown:null', 'tap:onmouseup:null', 'tap:onclick:null']);
    expect(r.drags).toEqual([]);
  });

  it('a slider with a thumbImage drags over length - thumb, the thumb length from deps', () => {
    const r = rig();
    r.press(150 + 5 + 45, 40 + 5);                         // 100 long, 10 thumb: travel 90, the middle is 5 + 45 in
    r.move(150 + 5 + 90, 40 + 5);
    r.release(150 + 5 + 90, 40 + 5);
    expect(r.drags.map((d) => [d.id, d.phase, d.value])).toEqual([['seek', 'begin', 50], ['seek', 'move', 100], ['seek', 'end', 100]]);
  });
});
