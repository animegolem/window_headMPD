// @ts-check
// W2.2 acceptance item 7 (ENGINE D1 "Timers", E §10): the string and function forms on the manual
// engine clock, the 64-timer cap, the 10 ms floor, clearing, and `inGesture`.

import { describe, expect, it } from 'vitest';
import { REALM_CAPS } from '../../../src/engine/realm/realm.js';
import { makeRealm, outOf, standardObjects } from './fake-host.js';

describe('item 7: timers on the manual clock', () => {
  it('the string form compiles with the id chain and runs when the engine clock reaches it', async () => {
    const hn = await makeRealm();
    expect(hn.handler("tid = setTimeout(\"Ice.value = 'later'; fired = (typeof fired === 'number' ? fired : 0) + 1;\", 50);").ok).toBe(true);
    expect(hn.realm.readGlobal('tid')).toBe(1);
    hn.clock.advance(49);
    expect(hn.objects.prop(3, 'value')).toBe('ice');
    hn.clock.advance(1);
    expect(hn.objects.prop(3, 'value')).toBe('later');
    hn.clock.advance(500);
    expect(hn.realm.readGlobal('fired')).toBe(1);            // a timeout fires once
  });

  it('the function form passes extra arguments; setInterval repeats until cleared', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('t.js', 'var ticks = []; function tick(tag) { ticks.push(tag); if (ticks.length === 3) clearInterval(iv); }').ok).toBe(true);
    expect(hn.handler("iv = setInterval(tick, 20, 'a');").ok).toBe(true);
    hn.clock.advance(200);
    expect(outOf(hn, 'return ticks')).toEqual(['a', 'a', 'a']);
    expect(hn.timerOps.map(([op, , ms, repeat]) => [op, ms, repeat])).toEqual([['set', 20, true], ['clear', 0, false]]);
  });

  it('clearTimeout before the due time cancels; an unknown id is a no-op', async () => {
    const hn = await makeRealm();
    expect(hn.handler("var id = setTimeout(function () { Ice.value = 'no'; }, 30); clearTimeout(id); clearTimeout(999); clearInterval('x');").ok).toBe(true);
    hn.clock.advance(100);
    expect(hn.objects.prop(3, 'value')).toBe('ice');
    expect(hn.realm.fireTimer(1)).toEqual({ ok: true, value: undefined });   // a stale fire is ignored
  });

  it('delays below the 10 ms floor are raised to it', async () => {
    const hn = await makeRealm();
    expect(hn.handler('setTimeout(function () {}, 0); setTimeout(function () {}); setInterval(function () {}, 3); setTimeout(function () {}, NaN); setTimeout(function () {}, 25);').ok).toBe(true);
    expect(hn.timerOps.map(([, , ms]) => ms)).toEqual([10, 10, 10, 10, 25]);
  });

  it('the 65th live timer is refused (setTimeout returns 0) with one diagnostic, not a fault', async () => {
    const hn = await makeRealm();
    expect(hn.handler(`ids = []; for (var i = 0; i < ${REALM_CAPS.maxLiveTimers + 1}; i++) ids.push(setTimeout(function () {}, 1000)); last = ids[ids.length - 1]; secondLast = ids[ids.length - 2];`).ok).toBe(true);
    expect(hn.realm.readGlobal('last')).toBe(0);
    expect(hn.realm.readGlobal('secondLast')).toBe(64);
    expect(realmTimerSets(hn)).toBe(64);
    expect(hn.log.diags.filter((d) => d.code === 'realm-timer-cap')).toHaveLength(1);
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
    // Once one fires, there is room again.
    hn.clock.advance(1000);
    expect(hn.handler('again = setTimeout(function () {}, 10);').ok).toBe(true);
    expect(hn.realm.readGlobal('again')).toBeGreaterThan(0);
  });

  it('a timer callback that throws is a soft fault of that timer only', async () => {
    const hn = await makeRealm();
    expect(hn.handler("setTimeout(function () { undefinedFn(); }, 10); setTimeout(function () { Ice.value = 'second'; }, 20);").ok).toBe(true);
    hn.clock.advance(20);
    expect(hn.objects.prop(3, 'value')).toBe('second');
    expect(hn.realm.health.soft).toBe(1);
    expect(hn.log.diags.find((d) => d.code === 'realm-soft-fault')?.detail).toMatch(/timer 1: ReferenceError/);
  });

  it('a skin may replace setTimeout with its own function', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('t.js', 'function setTimeout(f, ms) { return -1; }').ok).toBe(true);
    expect(outOf(hn, 'return setTimeout(function () {}, 10)')).toBe(-1);
    expect(hn.timerOps).toEqual([]);
  });

  it('unload clears every live timer at the host', async () => {
    const hn = await makeRealm();
    expect(hn.handler('setInterval(function () {}, 50); setTimeout(function () {}, 70); var gone = setTimeout(function () {}, 90); clearTimeout(gone);').ok).toBe(true);
    hn.timerOps.length = 0;
    hn.realm.unload('test');
    expect(hn.timerOps.map(([op, id]) => [op, id]).sort()).toEqual([['clear', 1], ['clear', 2]]);
  });
});

describe('item 7: inGesture', () => {
  it('is true only inside runHandler(..., { gesture: true })', async () => {
    const objects = standardObjects();
    /** @type {boolean[]} */
    const seen = [];
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(102)?.methods.set('close', () => { seen.push(Boolean(realm?.inGesture)); return 'closed'; });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    const site = { event: 'onclick', source: 'view.close();', params: [], line: 1 };
    expect(hn.realm.runHandler(2, site, { gesture: true }).ok).toBe(true);
    expect(hn.realm.runHandler(2, site, {}).ok).toBe(true);
    expect(hn.realm.runHandler(2, { ...site, event: 'onload' }).ok).toBe(true);
    expect(hn.handler('setTimeout(function () { view.close(); }, 10);', { ctx: { gesture: true } }).ok).toBe(true);
    hn.clock.advance(10);
    expect(hn.realm.callGlobal('Math', []).ok).toBe(false);
    expect(seen).toEqual([true, false, false, false]);
    expect(hn.realm.inGesture).toBe(false);
  });

  it('is false for an _onchange a gesture handler queued, and false again after a gesture handler faults', async () => {
    const objects = standardObjects();
    /** @type {boolean[]} */
    const seen = [];
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(102)?.methods.set('close', () => { seen.push(Boolean(realm?.inGesture)); return 'closed'; });
    objects.objects.get(1).onSet = () => { realm?.runHandler(1, { event: 'value_onchange', source: 'view.close();', params: [], line: 1 }, {}); };
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    expect(hn.realm.runHandler(2, { event: 'onclick', source: 'view.close(); volume.value = 3;', params: [], line: 1 }, { gesture: true }).ok).toBe(true);
    expect(seen).toEqual([true, false]);
    expect(hn.realm.runHandler(2, { event: 'onclick', source: 'while (1) {}', params: [], line: 1 }, { gesture: true }).ok).toBe(false);
    expect(hn.realm.inGesture).toBe(false);
  });
});

// G2 S2: jobs a non-gesture entry left past the 1,000-job drain cap used to run inside the next entry,
// a user click included, and so with its gesture: view.close() from a timer's Promise chain went through.
describe('item 7: leftover Promise jobs never inherit a gesture', () => {
  it('a 2,500-job chain a timer started ends in view.close() outside the gesture, across three clicks', async () => {
    const objects = standardObjects();
    /** @type {boolean[]} */
    const seen = [];
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(102)?.methods.set('close', () => { seen.push(Boolean(realm?.inGesture)); return 'closed'; });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    expect(hn.handler('setTimeout(function () { n = 0; (function step() { if (++n < 2500) Promise.resolve().then(step); else view.close(); })(); }, 10);').ok).toBe(true);
    hn.clock.advance(10);
    const click = { event: 'onclick', source: '1', params: [], line: 1 };
    for (let i = 0; i < 3; i++) expect(hn.realm.runHandler(2, click, { gesture: true }).ok).toBe(true);
    expect(seen).toEqual([false]);
    expect(hn.realm.inGesture).toBe(false);
  });

  it("a gesture handler's own Promise jobs still run inside its gesture", async () => {
    const objects = standardObjects();
    /** @type {boolean[]} */
    const seen = [];
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(102)?.methods.set('close', () => { seen.push(Boolean(realm?.inGesture)); return 'closed'; });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    expect(hn.realm.runHandler(2, { event: 'onclick', source: 'Promise.resolve().then(function () { view.close(); });', params: [], line: 1 }, { gesture: true }).ok).toBe(true);
    expect(seen).toEqual([true]);
  });
});

/** @param {Awaited<ReturnType<typeof makeRealm>>} hn */
function realmTimerSets(hn) {
  return hn.timerOps.filter(([op]) => op === 'set').length;
}
