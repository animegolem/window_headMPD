// @ts-check
// 5F.6 (c), E D7.3: a script's VIEW width/height write leaves the window and its frame as they are, and
// the shape follows what the renderer and the input plane show, the VIEW's own box: the rest of the frame
// is click-through. A view that shrinks to nothing keeps the full-frame fallback (fewer than 64 bits).
// Headless, Node: `maskShape()` rasterises on demand.
import { describe, expect, it } from 'vitest';
import { open, skinZip, wmsOf } from './helpers.js';

/** @param {import('../../../src/engine/contracts').MaskShape} shape @param {number} x @param {number} y */
const bitAt = (shape, x, y) => {
  if (shape.kind !== 'bits') throw new Error('expected a bits shape');
  const i = y * shape.width + x;
  return (shape.bits[i >> 3] >> (i & 7)) & 1;
};

/** @param {import('../../../src/engine/contracts').MaskShape} shape */
const count = (shape) => {
  if (shape.kind !== 'bits') throw new Error('expected a bits shape');
  let n = 0;
  for (let i = 0; i < shape.width * shape.height; i++) n += (shape.bits[i >> 3] >> (i & 7)) & 1;
  return n;
};

const js = 'function size(w, h) { view.width = w; view.height = h; }';
const wms = wmsOf('', 'id="v" width="200" height="100" backgroundColor="#102030" titleBar="false"');

describe('the shape after a script resizes its VIEW', () => {
  it('covers the VIEW box inside the unchanged frame', async () => {
    const { host, runtime } = await open(skinZip({ wms, js }));
    expect(count(runtime.maskShape())).toBe(200 * 100);

    runtime.inspector.callGlobal('size', [120, 60]);
    await runtime.settled();
    expect(host.window.recorded.sizeRequests.at(-1)).toEqual({ w: 120, h: 60 });
    const shape = runtime.maskShape();
    expect([shape.width, shape.height]).toEqual([200, 100]);
    expect(count(shape)).toBe(120 * 60);
    expect(bitAt(shape, 119, 59)).toBe(1);
    expect(bitAt(shape, 120, 10)).toBe(0);
    expect(bitAt(shape, 10, 60)).toBe(0);
  });

  it('is the frame again when the VIEW grows past it', async () => {
    const { runtime } = await open(skinZip({ wms, js }));
    runtime.inspector.callGlobal('size', [120, 60]);
    runtime.inspector.callGlobal('size', [500, 300]);
    await runtime.settled();
    const shape = runtime.maskShape();
    expect([shape.width, shape.height]).toEqual([200, 100]);
    expect(count(shape)).toBe(200 * 100);
  });

  it('falls back to the full frame when the VIEW shrinks to nothing', async () => {
    const { runtime } = await open(skinZip({ wms, js }));
    runtime.inspector.callGlobal('size', [0, 0]);
    await runtime.settled();
    const shape = runtime.maskShape();
    expect([shape.width, shape.height]).toEqual([200, 100]);
    expect(count(shape)).toBe(200 * 100);
    expect(runtime.diagnostics().map((d) => d.code)).toContain('shape-empty');
  });

  it('applies the fallback to a box that paints fewer than 64 pixels', async () => {
    const { runtime } = await open(skinZip({ wms, js }));
    runtime.inspector.callGlobal('size', [7, 9]);              // 63 pixels
    await runtime.settled();
    expect(count(runtime.maskShape())).toBe(200 * 100);
    runtime.inspector.callGlobal('size', [8, 8]);              // 64 pixels: a shape of its own
    await runtime.settled();
    expect(count(runtime.maskShape())).toBe(64);
  });
});
