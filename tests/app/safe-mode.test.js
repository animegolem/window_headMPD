// @vitest-environment happy-dom
// Safe-mode boot (ENGINE.md D10.8): the `boot.pending` marker written before a skin loads and cleared
// 10 s after its first frame, the launch check (a leftover marker, or Shift held), and the Shift watcher.
// Time is the test host's manual clock, so the 10 s boundary is exact (frames fall on a 16 ms grid).
//
// Rule 6: nothing here is keyed by a skin string.
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEAR_AFTER_MS, MESSAGES, PENDING_KEY, PENDING_NS, createSafeMode, watchShift,
} from '../../src/app/safe-mode.js';
import { createManualClock } from '../../src/hosts/test/clock.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';

const marker = (/** @type {{ peek(ns: string): Map<string, string> }} */ prefs) => prefs.peek(PENDING_NS).get(PENDING_KEY);

function rig(over = {}) {
  const clock = createManualClock();
  const prefs = createMemoryPrefs();
  const safe = createSafeMode({ prefs, clock, ...over });
  return { clock, prefs, safe };
}

describe('check', () => {
  it('a clean launch is not safe mode', async () => {
    const { safe } = rig();
    expect(await safe.check()).toEqual({ safe: false, reason: null, message: '' });
  });

  it('a leftover marker skips the skin', async () => {
    const { safe, prefs } = rig();
    prefs.seed(PENDING_NS, { [PENDING_KEY]: '1' });
    expect(await safe.check()).toEqual({ safe: true, reason: 'pending', message: MESSAGES.pending });
  });

  it('Shift held at launch skips the skin', async () => {
    const { safe } = rig({ shift: () => true });
    expect(await safe.check()).toEqual({ safe: true, reason: 'shift', message: MESSAGES.shift });
  });

  it('a probe given to check() overrides the default one', async () => {
    const { safe } = rig({ shift: () => false });
    expect((await safe.check({ shift: () => true })).reason).toBe('shift');
  });

  it('the marker is reported ahead of Shift', async () => {
    const { safe, prefs } = rig({ shift: () => true });
    prefs.seed(PENDING_NS, { [PENDING_KEY]: '1' });
    expect((await safe.check()).reason).toBe('pending');
  });

  it('a pref store that cannot be read, or a broken Shift probe, does not lock the skin out', async () => {
    const clock = createManualClock();
    const safe = createSafeMode({
      prefs: { load: () => Promise.reject(new Error('io')), write() {} },
      clock,
      shift: () => { throw new Error('no probe'); },
    });
    expect(await safe.check()).toMatchObject({ safe: false });
  });
});

describe('the marker', () => {
  it('arm() writes it, and waits for the store to flush when it can', async () => {
    const order = /** @type {string[]} */ ([]);
    const clock = createManualClock();
    const prefs = createMemoryPrefs();
    const write = prefs.write.bind(prefs);
    const safe = createSafeMode({
      clock,
      prefs: {
        load: (ns) => prefs.load(ns),
        write(ns, k, v) { order.push('write'); write(ns, k, v); },
        async flush() { order.push('flush'); },
      },
    });
    await safe.arm();
    expect(order).toEqual(['write', 'flush']);
    expect(marker(prefs)).toBe('1');
  });

  it('is cleared 10 s after the first frame following markRunning(), not before', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    safe.markRunning();
    expect(CLEAR_AFTER_MS).toBe(10_000);
    clock.advance(CLEAR_AFTER_MS);                             // the first frame was at 16 ms: the timer is due at 10016
    expect(marker(prefs)).toBe('1');
    clock.advance(15);
    expect(marker(prefs)).toBe('1');
    clock.advance(1);
    expect(marker(prefs)).toBeUndefined();
  });

  it('counts from a frame after markRunning(), not from the time it was called', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    clock.advance(5_000);
    safe.markRunning();
    clock.advance(CLEAR_AFTER_MS);
    expect(marker(prefs)).toBe('1');
    clock.advance(32);
    expect(marker(prefs)).toBeUndefined();
  });

  it('markRunning() before arm() does nothing', () => {
    const { safe, clock } = rig();
    safe.markRunning();
    expect(clock.frameListeners()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a load that never reaches markRunning() leaves the marker for the next launch', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    clock.advance(60_000);
    expect(marker(prefs)).toBe('1');
    const next = createSafeMode({ prefs, clock: createManualClock() });
    expect((await next.check()).reason).toBe('pending');
  });

  it('a clean close clears a marker this launch wrote, even inside the 10 s', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    safe.markRunning();
    clock.advance(100);
    safe.clear();
    expect(marker(prefs)).toBeUndefined();
    expect(clock.pendingTimers()).toBe(0);
    expect(clock.frameListeners()).toBe(0);
  });

  it('a close from a safe-mode launch leaves the marker that caused it', async () => {
    const { safe, prefs } = rig();
    prefs.seed(PENDING_NS, { [PENDING_KEY]: '1' });
    expect((await safe.check()).safe).toBe(true);
    safe.clear();
    expect(marker(prefs)).toBe('1');
  });

  it('arming again (a reload) restarts the clock', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    safe.markRunning();
    clock.advance(5_000);
    await safe.arm();
    safe.markRunning();
    clock.advance(CLEAR_AFTER_MS);
    expect(marker(prefs)).toBe('1');
    clock.advance(32);
    expect(marker(prefs)).toBeUndefined();
  });

  it('dispose stops the clock and leaves the marker set', async () => {
    const { safe, prefs, clock } = rig();
    await safe.arm();
    safe.markRunning();
    clock.advance(100);
    safe.dispose();
    clock.advance(60_000);
    expect(marker(prefs)).toBe('1');
  });

  it('a store that refuses the write leaves the skin unguarded, not unloadable', async () => {
    const clock = createManualClock();
    const safe = createSafeMode({ clock, prefs: { load: async () => new Map(), write() { throw new Error('io'); } } });
    expect(await safe.arm()).toBe(false);
    safe.markRunning();
    expect(clock.frameListeners()).toBe(0);
    expect(() => safe.clear()).not.toThrow();
  });

  it('a flush that fails does not undo an accepted write', async () => {
    const clock = createManualClock();
    const prefs = createMemoryPrefs();
    const safe = createSafeMode({ clock, prefs: { load: (ns) => prefs.load(ns), write: (ns, k, v) => prefs.write(ns, k, v), flush: () => Promise.reject(new Error('io')) } });
    expect(await safe.arm()).toBe(true);
    expect(marker(prefs)).toBe('1');
  });
});

describe('watchShift', () => {
  const watches = /** @type {Array<{ dispose(): void }>} */ ([]);
  afterEach(() => { while (watches.length) watches.pop()?.dispose(); });
  const watch = () => { const w = watchShift(window); watches.push(w); return w; };

  it('is false until an event says Shift is down, and follows it up and down', () => {
    const w = watch();
    expect(w.held()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    expect(w.held()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: false }));
    expect(w.held()).toBe(false);
  });

  it('reads Shift off a pointer event too (a click at launch)', () => {
    const w = watch();
    window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true }));
    expect(w.held()).toBe(true);
    window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: false }));
    expect(w.held()).toBe(false);
  });

  it('sees events that start in the page, not only on the window (capture)', () => {
    const w = watch();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: false }));
    expect(w.held()).toBe(true);
  });

  it('stops listening on dispose', () => {
    const w = watchShift(window);
    w.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    expect(w.held()).toBe(false);
  });

  it('drives a launch check: Shift pressed before the check means safe mode', async () => {
    const w = watch();
    const { safe } = rig({ shift: w.held });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    expect((await safe.check()).reason).toBe('shift');
  });
});
