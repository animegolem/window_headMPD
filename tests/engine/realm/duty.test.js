// @ts-check
// W2.2 acceptance item 5 (ENGINE D1 "Duty cycle", E §10): 64 timers at the 10 ms floor, each burning
// 9 ms, throttle the realm within 5 s of simulated wall time, and end in a hard fault after 10 s above
// 80%. The wall clock is simulated: it advances only when a timer callback "burns" through a host
// call, so the test is exact and fast. The per-dispatch budget never trips (9 ms < 100 ms).

import { describe, expect, it } from 'vitest';
import { REALM_CAPS } from '../../../src/engine/realm/realm.js';
import { makeRealm, standardObjects } from './fake-host.js';

/** A realm whose wall clock is simulated, and a host method `burn(ms)` on the view object. */
async function dutyRealm() {
  let wall = 0;
  const objects = standardObjects();
  objects.objects.get(102)?.methods.set('burn', (ms) => {
    wall += ms;
    return undefined;
  });
  const hn = await makeRealm({ objects, wall: () => wall });
  return { hn, wall: () => wall, idle: (ms) => { wall += ms; } };
}

describe('item 5: duty cycle', () => {
  it('64 timers at the 10 ms floor burning 9 ms each throttle within 5 s, then hard-fault after 10 s over 80%', async () => {
    const { hn, wall } = await dutyRealm();
    expect(hn.handler('for (var i = 0; i < 64; i++) setInterval(function () { view.burn(9); }, 10);').ok).toBe(true);
    const sets = hn.timerOps.filter(([op]) => op === 'set');
    expect(sets).toHaveLength(64);
    expect(sets.every(([, , ms, repeat]) => ms === 10 && repeat)).toBe(true);
    hn.timerOps.length = 0;

    /** @type {number | null} */ let throttledAt = null;
    /** @type {number | null} */ let faultedAt = null;
    /** @type {any[]} */ const faults = [];
    for (let round = 0; round < 400 && faultedAt === null; round++) {
      const softBefore = hn.realm.health.soft;
      const hardBefore = hn.realm.health.hard;
      hn.clock.advance(hn.realm.health.dutyThrottled ? REALM_CAPS.throttledTimerFloorMs : REALM_CAPS.timerFloorMs);
      if (throttledAt === null && hn.realm.health.dutyThrottled) throttledAt = wall();
      if (hn.realm.health.hard > hardBefore) {
        faultedAt = wall();
        faults.push(...hn.log.diags.filter((d) => d.code === 'realm-hard-fault'));
      }
      expect(hn.realm.health.soft).toBe(softBefore);
    }
    expect(throttledAt).not.toBeNull();
    expect(/** @type {number} */ (throttledAt)).toBeLessThanOrEqual(5 * 1000 + 64 * 9);     // within 5 s (plus the round that crossed it)
    expect(faultedAt).not.toBeNull();
    expect(/** @type {number} */ (faultedAt)).toBeGreaterThanOrEqual(10 * 1000);
    expect(/** @type {number} */ (faultedAt)).toBeLessThanOrEqual(11 * 1000);
    expect(faults[0]?.detail).toMatch(/duty-cycle/);
    expect(hn.log.diags.filter((d) => d.code === 'realm-throttled')).toHaveLength(1);
  });

  it('throttling re-arms live repeating timers at the 40 ms floor, and new timers start there', async () => {
    const { hn } = await dutyRealm();
    expect(hn.handler('for (var i = 0; i < 64; i++) setInterval(function () { view.burn(9); }, 10);').ok).toBe(true);
    while (!hn.realm.health.dutyThrottled) hn.clock.advance(10);
    const rearmed = hn.timerOps.filter(([op, , ms]) => op === 'set' && ms === REALM_CAPS.throttledTimerFloorMs);
    expect(rearmed).toHaveLength(64);
    hn.timerOps.length = 0;
    expect(hn.handler('clearInterval(1); setTimeout(function () {}, 1);').ok).toBe(true);
    expect(hn.timerOps.filter(([op]) => op === 'set').map(([, , ms]) => ms)).toEqual([REALM_CAPS.throttledTimerFloorMs]);
  });

  it('busy but under 50% never throttles; an idle gap resets the counters', async () => {
    const { hn, idle } = await dutyRealm();
    // 40% duty for 20 s: eight 50 ms dispatches per second.
    for (let s = 0; s < 20; s++) {
      for (let k = 0; k < 8; k++) expect(hn.handler('view.burn(50)').ok).toBe(true);
      idle(600);
    }
    expect(hn.realm.health.dutyThrottled).toBe(false);
    // 4 s at 100%, an idle minute, 4 s at 100% again: never 5 consecutive slices.
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < 80; k++) expect(hn.handler('view.burn(50)').ok).toBe(true);
      idle(60_000);
    }
    expect(hn.realm.health.dutyThrottled).toBe(false);
    expect(hn.realm.health.hard).toBe(0);
  });
});
