// @ts-check
// The marquee schedule (spec 6.10): scrollingAmount px every scrollingDelay ms, two spaces of gap.
import { describe, expect, it } from 'vitest';
import { DEFAULT_AMOUNT, DEFAULT_DELAY, GAP, MIN_DELAY, marqueeIndent, marqueeParams } from '../../../src/engine/render/dom/marquee.js';

describe('marqueeParams', () => {
  it('uses what the skin wrote when it is sane', () => {
    expect(marqueeParams(4, 50)).toEqual({ amount: 4, delay: 50 });
    expect(marqueeParams(6, 30)).toEqual({ amount: 6, delay: 30 });
  });

  it('a delay under 30 ms means the default (spec 6.10); a non-positive amount too', () => {
    expect(MIN_DELAY).toBe(30);
    expect(marqueeParams(6, 29)).toEqual({ amount: 6, delay: DEFAULT_DELAY });
    expect(marqueeParams(0, 85)).toEqual({ amount: DEFAULT_AMOUNT, delay: 85 });
    expect(marqueeParams(-3, 85).amount).toBe(DEFAULT_AMOUNT);
    expect(marqueeParams(undefined, null)).toEqual({ amount: 6, delay: 85 });
    expect(marqueeParams(Number.NaN, Number.NaN)).toEqual({ amount: 6, delay: 85 });
  });
});

describe('marqueeIndent', () => {
  const o = { amount: 6, delay: 85, cycle: 100, direction: /** @type {const} */ ('Left') };

  it('is 0 before the first step, then one amount per delay', () => {
    expect(marqueeIndent({ ...o, elapsed: 0 })).toBe(0);
    expect(marqueeIndent({ ...o, elapsed: 84 })).toBe(0);
    expect(marqueeIndent({ ...o, elapsed: 85 })).toBe(-6);
    expect(marqueeIndent({ ...o, elapsed: 170 })).toBe(-12);
    expect(marqueeIndent({ ...o, elapsed: 85 * 5 })).toBe(-30);
  });

  it('wraps at the cycle, so the picture repeats', () => {
    // 17 steps of 6 px = 102 px = one cycle (100) and 2 px
    expect(marqueeIndent({ ...o, elapsed: 85 * 17 })).toBe(-2);
    expect(marqueeIndent({ ...o, elapsed: 85 * 50, cycle: 30 })).toBe(0); // 300 px is ten whole cycles
  });

  it('Right moves the other way: the indent is the distance from a cycle back', () => {
    expect(marqueeIndent({ ...o, direction: 'Right', elapsed: 85 })).toBe(6 - 100);
    expect(marqueeIndent({ ...o, direction: 'Right', elapsed: 0 })).toBe(0);
  });

  it('a missing cycle or time is no motion', () => {
    expect(marqueeIndent({ ...o, cycle: 0, elapsed: 1000 })).toBe(0);
    expect(marqueeIndent({ ...o, elapsed: -5 })).toBe(0);
  });

  it('the gap is two non-breaking spaces', () => {
    expect(GAP).toBe('  ');
  });
});
