// @ts-check
import { describe, expect, it } from 'vitest';
import { createRafClock } from '../../../src/hosts/tauri/clock.js';

/** A hand-cranked requestAnimationFrame and a fake setTimeout, with an explicit `time`. */
function setup() {
  let time = 1000;
  /** @type {Map<number, (ts: number) => void>} */
  const frames = new Map();
  let nextFrame = 1;
  /** @type {Map<number, { due: number, fn: () => void }>} */
  const timeouts = new Map();
  let nextTimeout = 1;
  /** @type {unknown[]} */
  const errors = [];
  const log = { requested: 0, cancelled: 0, delays: /** @type {number[]} */ ([]) };
  const clock = createRafClock({
    requestFrame: (cb) => { log.requested++; frames.set(nextFrame, cb); return nextFrame++; },
    cancelFrame: (id) => { log.cancelled++; frames.delete(id); },
    now: () => time,
    setTimeout: (fn, ms) => { log.delays.push(ms); timeouts.set(nextTimeout, { due: time + ms, fn }); return nextTimeout++; },
    clearTimeout: (id) => { timeouts.delete(id); },
    onError: (e) => { errors.push(e); },
  });
  return {
    clock, errors, log,
    /** One animation frame at `ts`. */
    frame(/** @type {number} */ ts = time + 16) {
      time = ts;
      const due = [...frames];
      frames.clear();
      for (const [, cb] of due) cb(ts);
    },
    advanceTimers(/** @type {number} */ to) {
      time = to;
      for (const [id, t] of [...timeouts]) if (t.due <= to) { timeouts.delete(id); t.fn(); }
    },
    pendingFrames: () => frames.size,
    pendingTimeouts: () => timeouts.size,
  };
}

describe('now', () => {
  it('is the page clock', () => {
    const t = setup();
    expect(t.clock.now()).toBe(1000);
    t.frame(1500);
    expect(t.clock.now()).toBe(1500);
  });
});

describe('onFrame', () => {
  it('runs no loop until somebody subscribes, delivers the frame timestamp, and keeps going', () => {
    const t = setup();
    expect(t.pendingFrames()).toBe(0);
    /** @type {number[]} */
    const seen = [];
    t.clock.onFrame((now) => seen.push(now));
    expect(t.pendingFrames()).toBe(1);
    t.frame(1016);
    t.frame(1032);
    expect(seen).toEqual([1016, 1032]);
    expect(t.pendingFrames()).toBe(1);
  });

  it('shares one request among all subscribers', () => {
    const t = setup();
    let a = 0;
    let b = 0;
    t.clock.onFrame(() => { a++; });
    t.clock.onFrame(() => { b++; });
    expect(t.log.requested).toBe(1);
    t.frame();
    expect([a, b]).toEqual([1, 1]);
    expect(t.log.requested).toBe(2);                                  // one more for the next frame, not two
    expect(t.clock.frameListeners()).toBe(2);
  });

  it('stops the loop when the last subscriber leaves, and restarts for the next one', () => {
    const t = setup();
    const off1 = t.clock.onFrame(() => {});
    const off2 = t.clock.onFrame(() => {});
    off1();
    expect(t.pendingFrames()).toBe(1);
    off2();
    expect(t.pendingFrames()).toBe(0);
    expect(t.log.cancelled).toBe(1);
    let n = 0;
    t.clock.onFrame(() => { n++; });
    t.frame();
    expect(n).toBe(1);
  });

  it('a callback that unsubscribes the last listener ends the loop', () => {
    const t = setup();
    /** @type {() => void} */
    let off = () => {};
    let n = 0;
    off = t.clock.onFrame(() => { n++; off(); });
    t.frame();
    expect(n).toBe(1);
    expect(t.pendingFrames()).toBe(0);
    t.frame();
    expect(n).toBe(1);
  });

  it('delivers to a snapshot: a later subscriber starts next frame, an unsubscribed one stops at once', () => {
    const t = setup();
    /** @type {string[]} */
    const order = [];
    /** @type {() => void} */
    let offB = () => {};
    t.clock.onFrame(() => {
      order.push('a');
      offB();
      t.clock.onFrame(() => order.push('late'));
    });
    offB = t.clock.onFrame(() => order.push('b'));
    t.frame();
    expect(order).toEqual(['a']);
    t.frame();
    expect(order).toEqual(['a', 'a', 'late']);
  });

  it('the same function subscribed twice is two subscriptions', () => {
    const t = setup();
    let n = 0;
    const cb = () => { n++; };
    const off1 = t.clock.onFrame(cb);
    t.clock.onFrame(cb);
    t.frame();
    expect(n).toBe(2);
    off1();
    t.frame();
    expect(n).toBe(3);
  });

  it('a throwing callback is reported and does not stop the others or the loop', () => {
    const t = setup();
    let ok = 0;
    t.clock.onFrame(() => { throw new Error('first'); });
    t.clock.onFrame(() => { ok++; });
    t.frame();
    t.frame();
    expect(ok).toBe(2);
    expect(t.errors.map((e) => /** @type {Error} */ (e).message)).toEqual(['first', 'first']);
  });

  it('falls back to the page time when the frame source gives no timestamp', () => {
    const t = setup();
    /** @type {number[]} */
    const seen = [];
    t.clock.onFrame((now) => seen.push(now));
    t.frame(/** @type {any} */ (undefined));
    expect(seen).toHaveLength(1);
    expect(Number.isFinite(seen[0])).toBe(true);
  });
});

describe('timers', () => {
  it('fires a timer once, after its delay, with integer ids', () => {
    const t = setup();
    let n = 0;
    const id = t.clock.setTimer(50, () => { n++; });
    expect(Number.isInteger(id)).toBe(true);
    expect(t.clock.pendingTimers()).toBe(1);
    t.advanceTimers(1049);
    expect(n).toBe(0);
    t.advanceTimers(1050);
    t.advanceTimers(2000);
    expect(n).toBe(1);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('gives each timer its own id and clears by id; clearing a spent or unknown id is harmless', () => {
    const t = setup();
    let a = 0;
    let b = 0;
    const ia = t.clock.setTimer(10, () => { a++; });
    const ib = t.clock.setTimer(10, () => { b++; });
    expect(ia).not.toBe(ib);
    t.clock.clearTimer(ia);
    t.clock.clearTimer(ia);
    t.clock.clearTimer(9999);
    t.advanceTimers(2000);
    expect([a, b]).toEqual([0, 1]);
    t.clock.clearTimer(ib);
  });

  it('treats a delay that is not a positive finite number as 0 and clamps a huge one', () => {
    const t = setup();
    for (const ms of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY, /** @type {any} */ ('x')]) t.clock.setTimer(ms, () => {});
    t.clock.setTimer(1e12, () => {});
    t.clock.setTimer(Number.POSITIVE_INFINITY, () => {});
    expect(t.log.delays).toEqual([0, 0, 0, 0, 0, 2 ** 31 - 1, 0]);
  });

  it('a throwing timer is reported and does not break the clock', () => {
    const t = setup();
    t.clock.setTimer(1, () => { throw new Error('tick'); });
    t.advanceTimers(2000);
    expect(t.errors).toHaveLength(1);
    expect(t.clock.pendingTimers()).toBe(0);
  });
});

describe('dispose', () => {
  it('cancels the loop and every timer, and stays quiet afterwards', () => {
    const t = setup();
    let n = 0;
    t.clock.onFrame(() => { n++; });
    t.clock.setTimer(10, () => { n++; });
    t.clock.dispose();
    expect(t.pendingFrames()).toBe(0);
    expect(t.pendingTimeouts()).toBe(0);
    t.clock.onFrame(() => { n++; });
    expect(t.pendingFrames()).toBe(0);
    t.frame();
    t.advanceTimers(5000);
    expect(n).toBe(0);
  });
});
