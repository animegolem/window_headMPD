// @ts-check
import { describe, expect, it } from 'vitest';
import { BALANCE_DETENT, EQ_BANDS, EQ_LIMIT_DB, createFakeDsp } from '../../../src/hosts/test/dsp.js';

describe('fake DSP: balance detent', () => {
  it('constants are the D11 / parity D17 numbers', () => {
    expect([EQ_BANDS, EQ_LIMIT_DB, BALANCE_DETENT]).toEqual([10, 14, 5]);
  });

  it.each([
    [4, 0], [5, 0], [-5, 0], [-4, 0], [0, 0],
    [6, 6], [-6, -6], [40, 40], [100, 100], [-100, -100],
    [250, 100], [-250, -100],
  ])('set(%d) stores %d', (input, stored) => {
    const dsp = createFakeDsp();
    dsp.balance.set(input);
    expect(dsp.balance.get()).toBe(stored);
  });

  it('a value inside the detent reaches the DSP as 0 and snaps the stored value back', () => {
    const dsp = createFakeDsp();
    let changes = 0;
    dsp.balance.onChange(() => changes++);
    dsp.balance.set(40);
    expect(dsp.balance.get()).toBe(40);
    dsp.balance.set(4);                                   // dragged back through the centre
    expect(dsp.balance.get()).toBe(0);
    expect(dsp.sent.balance).toEqual([40, 0]);
    expect(changes).toBe(2);
  });

  it('a detent value while already centred sends nothing and notifies nobody', () => {
    const dsp = createFakeDsp();
    let changes = 0;
    dsp.balance.onChange(() => changes++);
    dsp.balance.set(3);
    dsp.balance.set(-5);
    dsp.balance.set(0);
    expect(dsp.sent.balance).toEqual([]);
    expect(changes).toBe(0);
  });

  it('ignores non-finite and non-number input', () => {
    const dsp = createFakeDsp();
    dsp.balance.set(30);
    dsp.balance.set(NaN);
    dsp.balance.set(Infinity);
    // @ts-expect-error
    dsp.balance.set('50');
    expect(dsp.balance.get()).toBe(30);
    expect(dsp.sent.balance).toEqual([30]);
  });

  it('a seeded starting balance goes through the same detent', () => {
    expect(createFakeDsp({ balance: 3 }).balance.get()).toBe(0);
    expect(createFakeDsp({ balance: -42 }).balance.get()).toBe(-42);
  });

  it('unsubscribe stops notifications; a throwing listener does not starve the rest', () => {
    const dsp = createFakeDsp();
    let a = 0;
    let b = 0;
    const off = dsp.balance.onChange(() => a++);
    dsp.balance.onChange(() => { throw new Error('listener'); });
    dsp.balance.onChange(() => b++);
    expect(() => dsp.balance.set(10)).toThrow('listener');
    expect([a, b]).toEqual([1, 1]);
    off();
    expect(() => dsp.balance.set(20)).toThrow('listener');
    expect([a, b]).toEqual([1, 2]);
  });
});

describe('fake DSP: equalizer', () => {
  it('starts flat with ten bands and the EQ live (bypass false, D6)', () => {
    const dsp = createFakeDsp();
    expect(dsp.eq.gains()).toEqual(Array(10).fill(0));
    expect(dsp.eq.bypass()).toBe(false);
    expect(dsp.sent.eq).toEqual([]);
  });

  it('setGain sets one band, clamps to ±14 dB, and sends all ten gains', () => {
    const dsp = createFakeDsp();
    dsp.eq.setGain(3, 6);
    dsp.eq.setGain(9, 99);
    dsp.eq.setGain(0, -99);
    expect(dsp.eq.gains()).toEqual([-14, 0, 0, 6, 0, 0, 0, 0, 0, 14]);
    expect(dsp.sent.eq).toHaveLength(3);
    expect(dsp.sent.eq.every((g) => g.length === 10)).toBe(true);
    expect(dsp.sent.eq[0]).toEqual([0, 0, 0, 6, 0, 0, 0, 0, 0, 0]);
    expect(dsp.sent.eq[2]).toEqual([-14, 0, 0, 6, 0, 0, 0, 0, 0, 14]);
  });

  it('gains() is a snapshot: changing it later does not alter an earlier read', () => {
    const dsp = createFakeDsp();
    const before = dsp.eq.gains();
    dsp.eq.setGain(1, 5);
    expect(before[1]).toBe(0);
    expect(dsp.eq.gains()[1]).toBe(5);
    expect(() => /** @type {number[]} */ (before).push(1)).toThrow();   // frozen
  });

  it('an unchanged gain sends nothing and notifies nobody', () => {
    const dsp = createFakeDsp();
    let changes = 0;
    dsp.eq.onChange(() => changes++);
    dsp.eq.setGain(2, 0);
    dsp.eq.setGain(2, 3);
    dsp.eq.setGain(2, 3);
    dsp.eq.setGain(2, 20);                                // clamps to 14: a change
    dsp.eq.setGain(2, 14);                                // already 14
    expect(changes).toBe(2);
    expect(dsp.sent.eq).toHaveLength(2);
  });

  it('rejects a band outside 0..9 and ignores a non-finite gain', () => {
    const dsp = createFakeDsp();
    for (const band of [-1, 10, 1.5, NaN]) expect(() => dsp.eq.setGain(band, 1)).toThrow(RangeError);
    dsp.eq.setGain(0, NaN);
    dsp.eq.setGain(0, Infinity);
    expect(dsp.eq.gains()).toEqual(Array(10).fill(0));
    expect(dsp.sent.eq).toEqual([]);
  });

  it('reset zeroes every band once, leaves bypass alone, and is quiet when already flat', () => {
    const dsp = createFakeDsp();
    dsp.eq.setBypass(true);
    dsp.eq.setGain(4, 7);
    dsp.eq.setGain(5, -7);
    let changes = 0;
    dsp.eq.onChange(() => changes++);
    dsp.eq.reset();
    expect(dsp.eq.gains()).toEqual(Array(10).fill(0));
    expect(dsp.eq.bypass()).toBe(true);
    expect(changes).toBe(1);
    expect(dsp.sent.eq.at(-1)).toEqual(Array(10).fill(0));
    dsp.eq.reset();
    expect(changes).toBe(1);
  });

  it('bypass notifies on change only', () => {
    const dsp = createFakeDsp();
    let changes = 0;
    dsp.eq.onChange(() => changes++);
    dsp.eq.setBypass(false);
    dsp.eq.setBypass(true);
    dsp.eq.setBypass(true);
    dsp.eq.setBypass(false);
    expect(changes).toBe(2);
    expect(dsp.sent.eq).toEqual([]);                      // phase 1 has no bypass on the audio path
  });

  it('starting gains are clamped and padded to ten', () => {
    const dsp = createFakeDsp({ gains: [1, 2, 99, NaN], bypass: true });
    expect(dsp.eq.gains()).toEqual([1, 2, 14, 0, 0, 0, 0, 0, 0, 0]);
    expect(dsp.eq.bypass()).toBe(true);
    expect(dsp.sent.eq).toEqual([]);
  });

  it('unsubscribe stops notifications; a throwing listener does not starve the rest', () => {
    const dsp = createFakeDsp();
    let a = 0;
    let b = 0;
    const off = dsp.eq.onChange(() => a++);
    dsp.eq.onChange(() => { throw new Error('listener'); });
    dsp.eq.onChange(() => b++);
    expect(() => dsp.eq.setGain(0, 1)).toThrow('listener');
    expect([a, b]).toEqual([1, 1]);
    off();
    expect(() => dsp.eq.setGain(0, 2)).toThrow('listener');
    expect([a, b]).toEqual([1, 2]);
  });

  it('eq and balance listeners are separate', () => {
    const dsp = createFakeDsp();
    let eq = 0;
    let bal = 0;
    dsp.eq.onChange(() => eq++);
    dsp.balance.onChange(() => bal++);
    dsp.eq.setGain(0, 1);
    expect([eq, bal]).toEqual([1, 0]);
    dsp.balance.set(50);
    expect([eq, bal]).toEqual([1, 1]);
  });
});
