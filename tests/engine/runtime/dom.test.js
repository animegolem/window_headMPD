// @vitest-environment happy-dom
// @ts-check
// The view runtime with a window root (E §3.1 steps 7-9, §3.2, D7): the window sized at attach, the
// layer tree mounted, the first shape sent, then pointer gestures through the input plane into the
// realm, script `view.width` writes forwarded to `requestSize` (G2) without the frame or its mask
// changing size (D7.3), a click on an EFFECTS element with no `onclick` going to the host, keys the
// skin handles marked `defaultPrevented` (G3), and shapes sent only when their bits change.
// happy-dom has no 2D context, so the renderer tests' recording stand-in is used.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stubCanvas } from '../render/helpers.js';
import { bmp, createTestHost, open, skinZip, trace, wmsOf } from './helpers.js';

/** @type {() => void} */
let restoreCanvas;
/** Every runtime a test mounted: its key listeners sit on the document, so each is disposed after its test. @type {Array<{ dispose(): void }>} */
const mounted = [];
beforeEach(() => {
  restoreCanvas = stubCanvas();
  document.body.replaceChildren();
});
afterEach(() => {
  for (const r of mounted.splice(0)) r.dispose();
  restoreCanvas();
});

/** @param {import('../../../src/engine/contracts').MaskShape} shape @param {number} x @param {number} y */
const bitAt = (shape, x, y) => {
  if (shape.kind !== 'bits') throw new Error('expected a bits shape');
  const i = y * shape.width + x;
  return (shape.bits[i >> 3] >> (i & 7)) & 1;
};

/** A skin with a button, a text, a slot and a script; the root is a div in the document. */
async function mount() {
  const root = document.createElement('div');
  document.body.append(root);
  const host = createTestHost({ window: { root } });
  const wms = wmsOf(`
    <button id="b" left="10" top="10" image="red.bmp" onclick="theme.logString('click'); t.value = 'clicked';"/>
    <text id="t" left="0" top="80" width="60" height="12" value="-" value_onchange="theme.logString('changed ' + value);"/>
    <subview id="screen" left="100" top="10" width="40" height="30">
      <effects id="fx" left="0" top="0" width="40" height="30"/>
    </subview>`,
  `id="v" width="200" height="100" backgroundColor="none" titleBar="false" onkeydown="theme.logString('key ' + event.keyCode);"`);
  const js = 'function grow() { view.width = 300; } function shrink() { view.width = 150; }';
  const files = { 'red.bmp': bmp(20, 10, [200, 30, 30]) };
  const { runtime, skin } = await open(skinZip({ wms, js, files }), { host });
  mounted.push(skin);
  const plane = /** @type {HTMLElement} */ (root.querySelector('div.input'));
  /** @param {string} type @param {number} x @param {number} y @param {Record<string, unknown>} [init] */
  const ptr = (type, x, y, init = {}) => {
    const e = new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, ...init });
    plane.dispatchEvent(e);
    return e;
  };
  return { root, host, runtime, skin, plane, ptr };
}

describe('the runtime with a window', () => {
  it('sizes the window to the VIEW, mounts the layer tree and sends the first shape', async () => {
    const { root, host, runtime, plane } = await mount();
    expect(host.window.recorded.initialSizes).toEqual([{ w: 200, h: 100 }]);
    expect(plane).not.toBeNull();
    expect(runtime.inspector.root()).toBe(root.firstElementChild);
    const shapes = host.window.recorded.shapes;
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    const shape = runtime.maskShape();
    expect(shape).toEqual(shapes.at(-1));
    expect(shape.width).toBe(200);
    expect(shape.height).toBe(100);
    expect(bitAt(shape, 12, 12)).toBe(1);                         // the button
    expect(bitAt(shape, 110, 20)).toBe(1);                        // the effects slot's reported rect
    expect(bitAt(shape, 195, 5)).toBe(0);                         // nothing there
    expect(host.window.recorded.calls.map((c) => c.method)).toContain('show');
  });

  it('runs a click through the picker into the realm and drains what it queued', async () => {
    const { host, ptr, runtime } = await mount();
    const before = host.window.recorded.captures.length;
    ptr('pointerdown', 15, 15, { button: 0, buttons: 1 });
    ptr('pointerup', 15, 15, { button: 0 });
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: click', 'skin: changed clicked']);
    expect(host.window.recorded.captures.slice(before)).toEqual([true, false]);
    expect(runtime.inspector.attr('t', 'value')).toBe('clicked');
  });

  it('hands a click on an EFFECTS element without onclick to the host (next preset)', async () => {
    const { host, ptr } = await mount();
    const fx = host.slots.mounted.find((m) => m.kind === 'effects');
    const effects = fx?.handle.effects;
    expect(effects).toBeDefined();
    const was = /** @type {any} */ (effects).index;
    ptr('pointerdown', 110, 20, { button: 0, buttons: 1 });
    ptr('pointerup', 110, 20, { button: 0 });
    expect(/** @type {any} */ (effects).index).toBe((was + 1) % /** @type {any} */ (effects).count);
  });

  it('forwards a script write of view.width to requestSize and keeps the frame and its mask', async () => {
    const { host, runtime } = await mount();
    runtime.inspector.callGlobal('grow');
    expect(host.window.recorded.sizeRequests).toEqual([{ w: 300, h: 100 }]);
    expect(runtime.inspector.attr('v', 'width')).toBe(300);      // the model reads back what was written (D13)
    host.clock.advance(32);
    await runtime.settled();
    expect(runtime.maskShape().width).toBe(200);
    runtime.inspector.callGlobal('shrink');
    host.clock.advance(32);
    expect(host.window.recorded.sizeRequests.at(-1)).toEqual({ w: 150, h: 100 });
    expect(runtime.maskShape().width).toBe(200);
    // A write from the host (the inspector) is not a script's request.
    runtime.inspector.setAttr('v', 'width', 250);
    expect(host.window.recorded.sizeRequests).toHaveLength(2);
  });

  it('sends a new shape only when its bits change', async () => {
    const { host, runtime } = await mount();
    const n = host.window.recorded.shapes.length;
    runtime.inspector.setAttr('t', 'value', 'other');             // shape-relevant attribute, same bits
    host.clock.advance(32);
    expect(host.window.recorded.shapes.length).toBe(n);
    runtime.inspector.setAttr('b', 'left', 30);
    host.clock.advance(16);
    expect(host.window.recorded.shapes.length).toBe(n + 1);
    expect(bitAt(runtime.maskShape(), 12, 12)).toBe(0);
    expect(bitAt(runtime.maskShape(), 32, 12)).toBe(1);
  });

  it("marks a key the skin handled as defaultPrevented and runs the VIEW's onkeydown", async () => {
    const { host } = await mount();
    const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(trace(host)).toContain('skin: key 32');
  });

  it('stops listening on dispose: no shape, no handler, onclose ran', async () => {
    const { host, runtime, ptr } = await mount();
    const n = host.window.recorded.shapes.length;
    runtime.dispose();
    ptr('pointerdown', 15, 15, { button: 0, buttons: 1 });
    ptr('pointerup', 15, 15, { button: 0 });
    host.clock.advance(50);
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual([]);
    expect(host.window.recorded.shapes.length).toBe(n);
  });
});
