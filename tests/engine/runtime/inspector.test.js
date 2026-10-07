// @ts-check
// The skin inspector (E §5.10 `SkinInspector`, D10.7): boxes in view px from the model, the point a
// BUTTONGROUP colour owns, the slider thumb for a value by the shared geometry, attributes through the
// element's host object, the skin's globals, the paint order. Refs are skin text, so `__proto__` and
// `constructor` are ordinary ids (E §1 rule 6). Headless, Node.
import { describe, expect, it } from 'vitest';
import { valueAt } from '../../../src/engine/layout/slider-geometry.js';
import { bmp, open, skinZip, trace, wmsOf } from './helpers.js';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const GREY = [128, 128, 128];

/** A 30x20 mapping image: red on the left third, green in the middle, a blue ring on the right third. */
const MAP = bmp(30, 20, (x, y) => {
  if (x < 10) return RED;
  if (x < 20) return GREEN;
  const dx = x - 24.5;
  const dy = y - 9.5;
  const r = Math.sqrt(dx * dx + dy * dy);
  return r >= 3 && r <= 4.5 ? BLUE : GREY;
});

const WMS = wmsOf(`
  <subview id="outer" left="5" top="6" width="150" height="90">
    <subview id="inner" left="10" top="20" width="100" height="60">
      <buttongroup id="g" left="20" top="30" mappingImage="map.bmp" image="map.bmp">
        <buttonelement id="red" mappingColor="#FF0000" onclick="theme.logString('red');"/>
        <buttonelement id="green" mappingColor="#00FF00"/>
        <buttonelement id="blue" mappingColor="#0000FF"/>
      </buttongroup>
    </subview>
  </subview>
  <slider id="h" left="10" top="50" width="100" height="10" min="0" max="100" value="25" thumbImage="thumb.bmp"/>
  <slider id="vt" left="160" top="10" width="10" height="76" min="-14" max="14" direction="vertical" thumbImage="thumbv.bmp"/>
  <text id="t" left="0" top="0" width="10" height="10" value="a" value_onchange="theme.logString('changed ' + value);"/>
  <text id="__proto__" left="1" top="2" width="3" height="4" value="p"/>
  <text id="constructor" left="5" top="6" width="7" height="8" value="c"/>
  <equalizersettings id="eq"/>`);
const JS = 'var answer = 42; function add(a, b) { return a + b; } function bump() { t.value = t.value + "!"; }';
const FILES = { 'map.bmp': MAP, 'thumb.bmp': bmp(10, 6, GREY), 'thumbv.bmp': bmp(8, 6, GREY) };

const openSkin = () => open(skinZip({ wms: WMS, js: JS, files: FILES }));

describe('SkinInspector', () => {
  it('finds elements and gives their boxes in view px', async () => {
    const { runtime } = await openSkin();
    const ins = runtime.inspector;
    expect(ins.find('g')).toEqual({ id: 'g', kind: 'buttongroup' });
    expect(ins.find('nope')).toBeNull();
    expect(ins.rectOf('inner')).toEqual({ x: 15, y: 26, w: 100, h: 60 });
    expect(ins.rectOf('g')).toEqual({ x: 35, y: 56, w: 30, h: 20 });       // default size from the image
    expect(ins.rectOf('green')).toEqual(ins.rectOf('g'));                    // a BUTTONELEMENT answers with its group
    expect(ins.rectOf('v')).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it('treats __proto__ and constructor as ordinary ids', async () => {
    const { runtime } = await openSkin();
    const ins = runtime.inspector;
    expect(ins.find('__proto__')).toEqual({ id: '__proto__', kind: 'text' });
    expect(ins.find('constructor')).toEqual({ id: 'constructor', kind: 'text' });
    expect(ins.rectOf('__proto__')).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(ins.attr('constructor', 'value')).toBe('c');
    expect(ins.find('toString')).toBeNull();
    expect(ins.find('hasOwnProperty')).toBeNull();
    expect(ins.groupPoint('__proto__', '#FF0000')).toBeNull();
    expect(ins.sliderThumbPoint('constructor', 1)).toBeNull();
  });

  it('points into the pixels a mapping colour owns', async () => {
    const { runtime } = await openSkin();
    const ins = runtime.inspector;
    expect(ins.groupPoint('g', '#FF0000')).toEqual({ x: 35 + 5, y: 56 + 10 });
    expect(ins.groupPoint('g', '#00ff00')).toEqual({ x: 35 + 15, y: 56 + 10 });
    // The ring's centroid is in its hole: the nearest blue pixel stands for it.
    const p = /** @type {{ x: number, y: number }} */ (ins.groupPoint('g', 'blue'));
    const lx = Math.floor(p.x - 35);
    const ly = Math.floor(p.y - 56);
    const r = Math.hypot(lx - 24.5, ly - 9.5);
    expect(r).toBeGreaterThanOrEqual(3);
    expect(r).toBeLessThanOrEqual(4.5);
    expect(ins.groupPoint('g', '#123456')).toBeNull();                       // a colour no element claims
    expect(ins.groupPoint('g', 'not a colour')).toBeNull();
    expect(ins.groupPoint('t', '#FF0000')).toBeNull();                       // not a group
  });

  it('puts the slider thumb where a drag to it would give the value back', async () => {
    const { runtime } = await openSkin();
    const ins = runtime.inspector;
    // 'oracle' geometry: the thumb centre runs over [t/2, L - t/2] (parity D32).
    expect(ins.sliderThumbPoint('h', 0)).toEqual({ x: 10 + 5, y: 55 });
    expect(ins.sliderThumbPoint('h', 100)).toEqual({ x: 10 + 95, y: 55 });
    expect(ins.sliderThumbPoint('h', 50)).toEqual({ x: 10 + 50, y: 55 });
    // A vertical slider puts its maximum at the top.
    const top = /** @type {{ x: number, y: number }} */ (ins.sliderThumbPoint('vt', 14));
    expect(top).toEqual({ x: 165, y: 10 + 3 });
    for (const db of [-14, -5, 0, 6, 14]) {
      const p = /** @type {{ x: number, y: number }} */ (ins.sliderThumbPoint('vt', db));
      const axis = { vertical: true, length: 76, thumb: 6, border: 0, geometry: /** @type {const} */ ('oracle') };
      expect(valueAt(p.y - 10, axis, -14, 14)).toBeCloseTo(db, 9);
    }
    expect(ins.sliderThumbPoint('t', 1)).toBeNull();
    expect(ins.sliderThumbPoint('h', NaN)).toBeNull();
  });

  it('reads and writes attributes as a script sees them, draining what a write queues', async () => {
    const { host, runtime } = await openSkin();
    const ins = runtime.inspector;
    expect(ins.attr('t', 'value')).toBe('a');
    ins.setAttr('t', 'value', 'b');
    expect(ins.attr('t', 'value')).toBe('b');
    expect(trace(host)).toContain('skin: changed b');
    // eq.gainLevelN is the DSP's band, not a model attribute.
    ins.setAttr('eq', 'gainLevel3', 6);
    expect(host.dsp.eq.gains()[2]).toBe(6);
    expect(ins.attr('eq', 'gainLevel3')).toBe(6);
    expect(ins.attr('nope', 'value')).toBeUndefined();
  });

  it("calls the skin's functions and reads its globals", async () => {
    const { host, runtime } = await openSkin();
    const ins = runtime.inspector;
    expect(ins.readGlobal('answer')).toBe(42);
    expect(ins.callGlobal('add', [2, 3])).toBe(5);
    expect(ins.callGlobal('nosuch')).toBeUndefined();
    ins.callGlobal('bump');
    expect(trace(host)).toContain('skin: changed a!');
  });

  it('dumps the paint order, one line per entry', async () => {
    const { runtime } = await openSkin();
    const dump = runtime.inspector.stackingDump();
    expect(dump[0]).toBe('view v');
    expect(dump).toContain('  subview outer z=0');
    expect(dump).toContain('    subview inner z=0');
    expect(dump).toContain('      buttongroup g z=0');
    expect(dump.indexOf('  slider h z=0')).toBeLessThan(dump.indexOf('  slider vt z=0'));
  });
});
