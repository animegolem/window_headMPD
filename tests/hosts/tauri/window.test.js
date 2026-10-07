// @ts-check
import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, createNativeSkinWindow, decodeBitsBody, encodeBitsBody } from '../../../src/hosts/tauri/window.js';

/** @typedef {import('../../../src/engine/contracts').MaskShape} MaskShape */

/** A 1 bpp mask, LSB first, row-major, with exactly the given pixels set. */
function bitsOf(/** @type {number} */ w, /** @type {number} */ h, /** @type {Array<[number, number]>} */ set) {
  const bits = new Uint8Array(Math.ceil((w * h) / 8));
  for (const [x, y] of set) {
    const i = y * w + x;
    bits[i >> 3] |= 1 << (i & 7);
  }
  return bits;
}
/** @returns {MaskShape} */
const shape = (/** @type {number} */ w, /** @type {number} */ h, /** @type {Array<[number, number]>} */ set) => ({ kind: 'bits', width: w, height: h, bits: bitsOf(w, h, set) });

/**
 * A hand-cranked frame source: `run()` fires what was requested, once, like one rAF turn.
 */
function frameSource() {
  /** @type {Array<(() => void) | null>} */
  const queue = [];
  return {
    requestFrame: (/** @type {() => void} */ cb) => { queue.push(cb); return queue.length - 1; },
    cancelFrame: (/** @type {number} */ id) => { queue[id] = null; },
    run() {
      const now = queue.splice(0);
      for (const cb of now) cb?.();
      return now.filter(Boolean).length;
    },
    pending: () => queue.filter(Boolean).length,
  };
}

/** A fake Tauri window handle that records what it is asked, in order, into `events`. */
function fakeHandle(/** @type {string[]} */ events, /** @type {{ failSize?: boolean, failDrag?: boolean }} */ fail = {}) {
  /** @type {any[]} */
  const sizes = [];
  /** @type {null | ((e: unknown) => unknown)} */
  let closeHandler = null;
  const state = { listeners: 0, unlistened: 0, always: /** @type {boolean[]} */ ([]), workspaces: /** @type {boolean[]} */ ([]) };
  const handle = {
    label: 'main',
    sizes,
    state,
    async setSize(/** @type {any} */ size) {
      events.push('setSize');
      sizes.push(size);
      if (fail.failSize) throw new Error('no permission');
    },
    async startDragging() { events.push('startDragging'); if (fail.failDrag) throw new Error('denied'); },
    async show() { events.push('show'); },
    async hide() { events.push('hide'); },
    async minimize() { events.push('minimize'); },
    async close() { events.push('close'); await closeHandler?.({}); },
    async setAlwaysOnTop(/** @type {boolean} */ on) { state.always.push(on); },
    async setVisibleOnAllWorkspaces(/** @type {boolean} */ on) { state.workspaces.push(on); },
    async outerPosition() { return { x: 200, y: 100 }; },
    async outerSize() { return { width: 1520, height: 788 }; },
    async scaleFactor() { return 2; },
    async onCloseRequested(/** @type {(e: unknown) => unknown} */ h) {
      state.listeners++;
      closeHandler = h;
      return () => { state.unlistened++; closeHandler = null; };
    },
  };
  return handle;
}

function setup(/** @type {Partial<import('../../../src/hosts/tauri/window.js').NativeWindowOptions> & { failSize?: boolean, failDrag?: boolean, failInvoke?: string }} [o] */ o = {}) {
  /** @type {string[]} */
  const events = [];
  /** @type {Array<[string, any]>} */
  const calls = [];
  /** @type {Array<[string, object | undefined]>} */
  const warnings = [];
  const frames = frameSource();
  const win = fakeHandle(events, o);
  const invoke = async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    events.push(`invoke:${cmd}`);
    calls.push([cmd, args]);
    if (o.failInvoke === cmd) throw new Error(`${cmd} refused`);
    return undefined;
  };
  const w = createNativeSkinWindow({
    win,
    invoke,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    log: { warn: (m, d) => { warnings.push([m, d]); } },
    ...o,
  });
  return { w, win, calls, events, warnings, frames, bitCalls: () => calls.filter(([c]) => c === 'hit_set_bits') };
}

describe('the body of hit_set_bits (headcore::hit::decode_bits_body)', () => {
  it('is u32 width, u32 height, f64 zoom, all little-endian, then the bits', () => {
    const body = encodeBitsBody(3, 2, 1.5, new Uint8Array([0b101011]));
    expect([...body.slice(0, 8)]).toEqual([3, 0, 0, 0, 2, 0, 0, 0]);
    expect([...body.slice(8, 16)]).toEqual([0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);       // 1.5 as an f64
    expect([...body.slice(16)]).toEqual([0b101011]);
    expect(decodeBitsBody(body)).toEqual({ w: 3, h: 2, zoom: 1.5, bits: new Uint8Array([0b101011]) });
    expect(() => decodeBitsBody(new Uint8Array(15))).toThrow(RangeError);
  });
});

describe('setShape', () => {
  it('sends the last of three shapes in one frame as one raw hit_set_bits body', () => {
    const { w, calls, frames } = setup();
    w.setShape(shape(8, 8, [[0, 0]]));
    w.setShape(shape(8, 8, [[1, 1]]));
    const last = shape(8, 8, [[2, 2], [7, 7]]);
    w.setShape(last);
    expect(calls).toEqual([]);                                   // nothing until the frame
    expect(frames.pending()).toBe(1);                            // one request, not three
    frames.run();
    expect(calls).toHaveLength(1);
    const [cmd, body] = calls[0];
    expect(cmd).toBe('hit_set_bits');
    expect(body).toBeInstanceOf(Uint8Array);                     // a raw body, not an args object
    expect(decodeBitsBody(body)).toEqual({ w: 8, h: 8, zoom: 1, bits: /** @type {any} */ (last).bits });
  });

  it('does not resend an identical shape, including one in a new buffer', () => {
    const { w, frames, bitCalls } = setup();
    w.setShape(shape(8, 8, [[3, 3]]));
    frames.run();
    w.setShape(shape(8, 8, [[3, 3]]));                           // a fresh object with the same bits
    frames.run();
    w.setShape(shape(8, 8, [[3, 3]]));
    frames.run();
    expect(bitCalls()).toHaveLength(1);
    w.setShape(shape(8, 8, [[3, 3], [4, 4]]));
    frames.run();
    expect(bitCalls()).toHaveLength(2);
    w.setShape(shape(8, 8, [[3, 3]]));                           // back to the first one is a change
    frames.run();
    expect(bitCalls()).toHaveLength(3);
  });

  it('copies the shape when it is handed over: a reused buffer changes nothing already sent or queued', () => {
    const { w, frames, bitCalls } = setup();
    const reused = shape(8, 8, [[0, 0]]);
    w.setShape(reused);
    /** @type {any} */ (reused).bits[0] = 0xff;                   // the engine paints the next frame into the same buffer
    frames.run();
    expect(decodeBitsBody(bitCalls()[0][1]).bits[0]).toBe(0x01); // the shape as it was when handed over
    /** @type {any} */ (reused).bits[0] = 0x01;
    w.setShape(reused);                                          // same bits again: nothing to send
    frames.run();
    expect(bitCalls()).toHaveLength(1);
  });

  it('sends a different size as a different shape', () => {
    const { w, frames, bitCalls } = setup();
    w.setShape(shape(8, 8, [[0, 0]]));
    frames.run();
    w.setShape(shape(16, 4, [[0, 0]]));                          // same 8 bytes, different geometry
    frames.run();
    expect(bitCalls()).toHaveLength(2);
    expect(decodeBitsBody(bitCalls()[1][1])).toMatchObject({ w: 16, h: 4 });
  });

  it('drops a shape whose bits do not match its size, with a warning and no IPC', () => {
    const { w, frames, calls, warnings } = setup();
    w.setShape({ kind: 'bits', width: 8, height: 8, bits: new Uint8Array(7) });
    w.setShape({ kind: 'bits', width: 0, height: 8, bits: new Uint8Array(0) });
    frames.run();
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);                            // only the last of the frame was looked at
    w.setShape({ kind: 'bits', width: 8, height: 8, bits: new Uint8Array(9) });
    frames.run();
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('sends regions through hit_set_regions with the zoom, once', () => {
    const { w, frames, calls } = setup({ zoom: 2 });
    /** @type {MaskShape} */
    const regions = { kind: 'regions', width: 100, height: 50, regions: [{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 4, h: 4, poly: [5, 5, 9, 5, 5, 9] }] };
    w.setShape(regions);
    frames.run();
    w.setShape(structuredClone(regions));
    frames.run();
    expect(calls).toEqual([['hit_set_regions', { regions: /** @type {any} */ (regions).regions, zoom: 2 }]]);
  });

  it('drops an empty regions list instead of asking Rust to refuse it every frame', () => {
    const { w, frames, calls, warnings } = setup();
    w.setShape({ kind: 'regions', width: 10, height: 10, regions: [] });
    frames.run();
    expect(calls).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('logs a failed send, does not retry the same shape, and does send a changed one', async () => {
    const { w, frames, bitCalls, warnings } = setup({ failInvoke: 'hit_set_bits' });
    w.setShape(shape(8, 8, [[0, 0]]));
    frames.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.map(([m]) => m)).toEqual(['window: hit_set_bits failed: hit_set_bits refused']);
    w.setShape(shape(8, 8, [[0, 0]]));
    frames.run();
    expect(bitCalls()).toHaveLength(1);
    w.setShape(shape(8, 8, [[1, 0]]));
    frames.run();
    expect(bitCalls()).toHaveLength(2);
  });

  it('flushShape sends now and the scheduled frame finds nothing left to do', () => {
    const { w, frames, bitCalls } = setup();
    w.setShape(shape(8, 8, [[0, 0]]));
    w.flushShape();
    expect(bitCalls()).toHaveLength(1);
    expect(frames.pending()).toBe(0);                            // the request was cancelled
  });
});

describe('zoom', () => {
  it('setZoom(1.5): scales through onZoom, sizes the window to 1140x591 and resends the shape at 1.5', async () => {
    const { w, win, events, frames, bitCalls } = setup();
    await w.setInitialSize(760, 394);
    w.setShape(shape(8, 8, [[0, 0], [7, 7]]));
    frames.run();
    expect(decodeBitsBody(bitCalls()[0][1]).zoom).toBe(1);
    events.length = 0;
    /** @type {number[]} */
    const heard = [];
    w.onZoom((z) => { heard.push(z); events.push('onZoom'); });

    await w.setZoom(1.5);
    expect(w.zoom).toBe(1.5);
    expect(heard).toEqual([1.5]);
    expect(win.sizes.at(-1)).toEqual({ type: 'Logical', width: 1140, height: 591 });
    expect(bitCalls()).toHaveLength(2);
    expect(decodeBitsBody(bitCalls()[1][1])).toMatchObject({ w: 8, h: 8, zoom: 1.5 });
    // The transform first, then the resize and the shape, started together (no waiting for a frame).
    expect(events).toEqual(['onZoom', 'setSize', 'invoke:hit_set_bits']);
    expect(frames.pending()).toBe(0);
  });

  it('is a no-op for the zoom it already has, and tells an unsubscribed listener nothing', async () => {
    const { w, win, calls } = setup();
    await w.setInitialSize(760, 394);
    let heard = 0;
    const off = w.onZoom(() => { heard++; });
    await w.setZoom(1);
    expect(heard).toBe(0);
    off();
    await w.setZoom(2);
    expect(heard).toBe(0);
    expect(win.sizes).toHaveLength(2);                           // initial size + the 2x one
    expect(calls).toEqual([]);                                   // no shape was ever set
  });

  it('starts at the zoom it is given: setInitialSize sizes the window to the view times that zoom', async () => {
    const { w, win } = setup({ zoom: 1.5 });
    expect(w.zoom).toBe(1.5);
    await w.setInitialSize(760, 394);
    expect(win.sizes).toEqual([{ type: 'Logical', width: 1140, height: 591 }]);
    const odd = setup({ zoom: 1.25 });
    await odd.w.setInitialSize(101, 99);
    expect(odd.win.sizes).toEqual([{ type: 'Logical', width: 126, height: 124 }]);    // 126.25, 123.75: rounded
  });

  it('sizes from the size it was constructed with when the host already knows the view', async () => {
    const { w, win } = setup({ size: { w: 760, h: 394 } });
    await w.setZoom(2);
    expect(win.sizes).toEqual([{ type: 'Logical', width: 1520, height: 788 }]);
  });

  it('does not resize before it knows the view size, but still announces and resends', async () => {
    const { w, win, frames, bitCalls } = setup();
    w.setShape(shape(8, 8, [[0, 0]]));
    frames.run();
    let heard = 0;
    w.onZoom(() => { heard++; });
    await w.setZoom(2);
    expect(win.sizes).toEqual([]);
    expect(heard).toBe(1);
    expect(bitCalls()).toHaveLength(2);
  });

  it('clamps a runaway zoom and refuses one that is not a positive number', async () => {
    const { w, win } = setup({ size: { w: 760, h: 394 } });
    await w.setZoom(1e9);
    expect(w.zoom).toBe(MAX_ZOOM);
    expect(win.sizes.at(-1)).toEqual({ type: 'Logical', width: 760 * MAX_ZOOM, height: 394 * MAX_ZOOM });
    await w.setZoom(1e-9);
    expect(w.zoom).toBe(MIN_ZOOM);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, /** @type {any} */ ('2')]) {
      await expect(w.setZoom(bad)).rejects.toBeInstanceOf(RangeError);
    }
    expect(w.zoom).toBe(MIN_ZOOM);
    expect(() => setup({ zoom: 0 })).toThrow(RangeError);
  });

  it('keeps going when the OS refuses the resize: the zoom and the shape still apply', async () => {
    const { w, frames, bitCalls, warnings } = setup({ failSize: true, size: { w: 760, h: 394 } });
    w.setShape(shape(8, 8, [[0, 0]]));
    frames.run();
    await w.setZoom(1.5);
    expect(w.zoom).toBe(1.5);
    expect(bitCalls()).toHaveLength(2);
    expect(warnings.map(([m]) => m)).toEqual(['window: setSize 1140x591 failed: no permission']);
  });

  it('a throwing onZoom listener does not stop the others or the resize', async () => {
    const { w, win, warnings } = setup({ size: { w: 760, h: 394 } });
    /** @type {number[]} */
    const heard = [];
    w.onZoom(() => { throw new Error('boom'); });
    w.onZoom((z) => { heard.push(z); });
    await w.setZoom(1.5);
    expect(heard).toEqual([1.5]);
    expect(win.sizes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('builds the size with makeSize when one is given', async () => {
    const { w, win } = setup({ size: { w: 10, h: 20 }, makeSize: (a, b) => ({ custom: [a, b] }) });
    await w.setZoom(2);
    expect(win.sizes).toEqual([{ custom: [20, 40] }]);
  });
});

describe('everything else a SkinWindow does', () => {
  it('is the native binding with a placeholder key the shell replaces', () => {
    const { w } = setup();
    expect(w.binding).toBe('native');
    expect(w.key).toBe('native/main');
    w.setKey('76a8662f/main');
    expect(w.key).toBe('76a8662f/main');
    expect(() => w.setKey('')).toThrow(TypeError);
    expect(setup({ key: 'abc/main' }).w.key).toBe('abc/main');
  });

  it('requestSize returns false and moves nothing (D7.3, parity D13)', async () => {
    const { w, win, calls } = setup({ size: { w: 760, h: 394 } });
    expect(await w.requestSize(549, 760)).toBe(false);
    expect(win.sizes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('setInitialSize does move the window (D7.4), and refuses a size that is not positive', async () => {
    const { w, win } = setup();
    await w.setInitialSize(300, 200);
    expect(win.sizes).toEqual([{ type: 'Logical', width: 300, height: 200 }]);
    await expect(w.setInitialSize(0, 200)).rejects.toBeInstanceOf(RangeError);
    await expect(w.setInitialSize(300, Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });

  it('setCapture goes to hit_capture, every time', () => {
    const { w, calls } = setup();
    w.setCapture(true);
    w.setCapture(true);
    w.setCapture(false);
    expect(calls).toEqual([['hit_capture', { on: true }], ['hit_capture', { on: true }], ['hit_capture', { on: false }]]);
  });

  it('startDrag starts the native drag, and logs a refusal', async () => {
    const ok = setup();
    ok.w.startDrag();
    expect(ok.events).toEqual(['startDragging']);
    const refused = setup({ failDrag: true });
    refused.w.startDrag();
    await new Promise((r) => setTimeout(r, 0));
    expect(refused.warnings.map(([m]) => m)).toEqual(['window: startDragging failed: denied']);
  });

  it('passes the lifecycle calls and the two pins straight through', async () => {
    const { w, win, events } = setup();
    await w.show();
    await w.hide();
    await w.minimize();
    await w.setAlwaysOnTop(true);
    await w.setAlwaysOnTop(false);
    await w.setVisibleOnAllWorkspaces(true);
    expect(events).toEqual(['show', 'hide', 'minimize']);
    expect(win.state.always).toEqual([true, false]);
    expect(win.state.workspaces).toEqual([true]);
  });

  it('bounds are logical px: the outer frame divided by the scale factor', async () => {
    const { w } = setup();
    expect(await w.bounds()).toEqual({ x: 100, y: 50, w: 760, h: 394 });
  });

  it('onClose registers with Tauri only when somebody subscribes, and fires on a close', async () => {
    const { w, win } = setup();
    expect(win.state.listeners).toBe(0);
    let a = 0;
    let b = 0;
    const offA = w.onClose(() => { a++; });
    w.onClose(() => { b++; });
    w.onClose(() => { throw new Error('a bad listener'); });
    expect(win.state.listeners).toBe(1);                         // one Tauri listener for all of them
    await w.close();
    expect([a, b]).toEqual([1, 1]);
    offA();
    await w.close();
    expect([a, b]).toEqual([1, 2]);
  });

  it('drops the Tauri close listener when the last subscriber leaves', async () => {
    const { w, win } = setup();
    const off1 = w.onClose(() => {});
    const off2 = w.onClose(() => {});
    off1();
    await Promise.resolve();
    expect(win.state.unlistened).toBe(0);
    off2();
    await new Promise((r) => setTimeout(r, 0));
    expect(win.state.unlistened).toBe(1);
  });

  it('dispose cancels the pending frame and ignores later shapes', () => {
    const { w, frames, calls } = setup();
    w.setShape(shape(8, 8, [[0, 0]]));
    w.dispose();
    expect(frames.pending()).toBe(0);
    w.setShape(shape(8, 8, [[1, 1]]));
    frames.run();
    expect(calls).toEqual([]);
  });
});
