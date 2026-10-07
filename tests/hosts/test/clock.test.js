// @ts-check
import { describe, expect, it } from 'vitest';
import { FRAME_MS, createManualClock } from '../../../src/hosts/test/clock.js';

describe('manual clock: frames', () => {
  it('starts at 0 (or `start`) and stays there until advanced', () => {
    expect(createManualClock().now()).toBe(0);
    expect(createManualClock({ start: 1234 }).now()).toBe(1234);
  });

  it('advance(100) fires frames at 16 ms steps and ends at 100', () => {
    const clock = createManualClock();
    /** @type {number[]} */
    const seen = [];
    clock.onFrame((now) => seen.push(now));
    clock.advance(100);
    expect(FRAME_MS).toBe(16);
    expect(seen).toEqual([16, 32, 48, 64, 80, 96]);
    expect(clock.now()).toBe(100);
  });

  it('keeps the grid across advances instead of restarting it', () => {
    const clock = createManualClock();
    /** @type {number[]} */
    const seen = [];
    clock.onFrame((now) => seen.push(now));
    clock.advance(100);
    clock.advance(12);                         // 112 is on the grid; 100 + 16 is not
    expect(seen.at(-1)).toBe(112);
    expect(clock.now()).toBe(112);
    clock.advance(15);
    expect(seen.at(-1)).toBe(112);             // 127 < 128: no new frame yet
    clock.advance(1);
    expect(seen.at(-1)).toBe(128);
  });

  it('many small advances deliver the same frames as one large one', () => {
    const a = createManualClock();
    const b = createManualClock();
    /** @type {number[]} */ const fa = [];
    /** @type {number[]} */ const fb = [];
    a.onFrame((n) => fa.push(n));
    b.onFrame((n) => fb.push(n));
    a.advance(1000);
    for (let i = 0; i < 100; i++) b.advance(10);
    expect(fb).toEqual(fa);
    expect(fa).toHaveLength(62);
  });

  it('a start offset moves the grid with it', () => {
    const clock = createManualClock({ start: 1000 });
    /** @type {number[]} */
    const seen = [];
    clock.onFrame((now) => seen.push(now));
    clock.advance(40);
    expect(seen).toEqual([1016, 1032]);
  });

  it('now() is frozen between advances and equals the frame time inside a frame callback', () => {
    const clock = createManualClock();
    /** @type {Array<[number, number]>} */
    const inside = [];
    clock.onFrame((now) => inside.push([now, clock.now()]));
    clock.advance(40);
    expect(inside).toEqual([[16, 16], [32, 32]]);
    expect(clock.now()).toBe(40);
    expect(clock.now()).toBe(40);
  });

  it('an unsubscribed frame callback stops receiving, even from inside another callback', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    const offB = clock.onFrame(() => log.push('b'));
    clock.onFrame(() => { log.push('a'); offB(); });
    // Order of registration: b first. b runs once, then a removes it.
    clock.advance(48);
    expect(log).toEqual(['b', 'a', 'a', 'a']);
    expect(clock.frameListeners()).toBe(1);
  });

  it('a callback added during a frame first runs on the next frame', () => {
    const clock = createManualClock();
    /** @type {number[]} */
    const late = [];
    let added = false;
    clock.onFrame(() => {
      if (added) return;
      added = true;
      clock.onFrame((now) => late.push(now));
    });
    clock.advance(48);
    expect(late).toEqual([32, 48]);
  });

  it('advance(0) is a no-op for frames and rejects bad input', () => {
    const clock = createManualClock();
    let frames = 0;
    clock.onFrame(() => frames++);
    clock.advance(0);
    expect(frames).toBe(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(NaN)).toThrow(RangeError);
    expect(() => clock.advance(Infinity)).toThrow(RangeError);
    expect(clock.now()).toBe(0);
  });
});

describe('manual clock: timers', () => {
  it('fires timers in time order, interleaved with frames, with now() at the due time', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    clock.onFrame((now) => log.push(`f${now}`));
    clock.setTimer(50, () => log.push(`t50@${clock.now()}`));
    clock.setTimer(20, () => log.push(`t20@${clock.now()}`));
    clock.advance(100);
    expect(log).toEqual(['f16', 't20@20', 'f32', 'f48', 't50@50', 'f64', 'f80', 'f96']);
    expect(clock.now()).toBe(100);
  });

  it('equal due times fire in creation order', () => {
    const clock = createManualClock();
    /** @type {number[]} */
    const log = [];
    clock.setTimer(30, () => log.push(1));
    clock.setTimer(30, () => log.push(2));
    clock.setTimer(10, () => log.push(0));
    clock.advance(30);
    expect(log).toEqual([0, 1, 2]);
  });

  it('a timer due on a frame instant fires before that frame', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    clock.onFrame((now) => log.push(`f${now}`));
    clock.setTimer(32, () => log.push('t32'));
    clock.advance(32);
    expect(log).toEqual(['f16', 't32', 'f32']);
  });

  it('does not fire a timer before its time, and carries it across advances', () => {
    const clock = createManualClock();
    let fired = 0;
    clock.setTimer(100, () => fired++);
    clock.advance(99);
    expect(fired).toBe(0);
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(1000);
    expect(fired).toBe(1);                     // one-shot
  });

  it('a timer set between advances is relative to the frozen now()', () => {
    const clock = createManualClock();
    clock.advance(70);
    /** @type {number[]} */
    const at = [];
    clock.setTimer(10, () => at.push(clock.now()));
    clock.advance(9);
    expect(at).toEqual([]);
    clock.advance(1);
    expect(at).toEqual([80]);
  });

  it('a timer set from inside a callback fires in the same advance when due in time', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    clock.setTimer(10, () => {
      log.push(`a@${clock.now()}`);
      clock.setTimer(15, () => log.push(`b@${clock.now()}`));    // due 25
      clock.setTimer(500, () => log.push('late'));               // beyond the target
      clock.setTimer(0, () => log.push(`c@${clock.now()}`));     // due now, after the current callback
    });
    clock.advance(100);
    expect(log).toEqual(['a@10', 'c@10', 'b@25']);
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(409);                        // the late timer is due at 10 + 500 = 510; now 509
    expect(log).toEqual(['a@10', 'c@10', 'b@25']);
    clock.advance(1);
    expect(log.at(-1)).toBe('late');
  });

  it('clearTimer stops a pending timer, including from inside an earlier callback', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    const id = clock.setTimer(50, () => log.push('never'));
    clock.setTimer(20, () => clock.clearTimer(id));
    const keep = clock.setTimer(60, () => log.push('kept'));
    clock.advance(100);
    expect(log).toEqual(['kept']);
    clock.clearTimer(keep);                    // already fired: harmless
    clock.clearTimer(999);                     // unknown: harmless
  });

  it('timer ids are distinct positive integers', () => {
    const clock = createManualClock();
    const ids = [clock.setTimer(1, () => {}), clock.setTimer(1, () => {}), clock.setTimer(1, () => {})];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });

  it('negative and NaN delays count as 0', () => {
    const clock = createManualClock();
    let n = 0;
    clock.setTimer(-5, () => n++);
    clock.setTimer(NaN, () => n++);
    clock.advance(0);
    expect(n).toBe(2);
  });
});

describe('manual clock: failure handling', () => {
  it('a throwing callback does not strand the clock: the rest runs and the first error is rethrown', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const log = [];
    clock.setTimer(10, () => { throw new Error('boom'); });
    clock.setTimer(20, () => log.push('after'));
    clock.onFrame((now) => log.push(`f${now}`));
    expect(() => clock.advance(40)).toThrow('boom');
    expect(log).toEqual(['f16', 'after', 'f32']);
    expect(clock.now()).toBe(40);
    clock.advance(10);                         // usable afterwards
    expect(clock.now()).toBe(50);
  });

  it('advance from inside a callback is refused', () => {
    const clock = createManualClock();
    clock.setTimer(1, () => clock.advance(1));
    expect(() => clock.advance(5)).toThrow(/re-entrant/);
    clock.advance(1);
  });

  it('a timer that re-arms itself at 0 ms ends in an error instead of hanging', () => {
    const clock = createManualClock();
    const spin = () => { clock.setTimer(0, spin); };
    clock.setTimer(0, spin);
    expect(() => clock.advance(10)).toThrow(/re-arming/);
  });
});
