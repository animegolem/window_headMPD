// @ts-check
// W2.2 acceptance item 8: after 1,000 dispatches the runtime's object count returns to its baseline.
// The dispatches exercise every path that creates realm objects: a per-dispatch event handle (its proxy
// is dropped at revocation), host reads, writes and method calls, a returned handle, parameters, a
// timer, a `jscript:` value and a global call. Handler, method and proxy caches are steady state after
// the warm-up round, and the realm's own lookups never form cycles, so reference counting alone frees
// each dispatch's garbage. The afterEach of fake-host.js then proves no host-side handle leaked: the
// clean dispose would abort if one had.

import { describe, expect, it } from 'vitest';
import { realmDebug } from '../../../src/engine/realm/realm.js';
import { makeRealm } from './fake-host.js';

describe('item 8: leak check', () => {
  it('1,000 dispatches leave the object count at its baseline', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('a.js', 'var total = 0; function onTick(n) { total += n; return volume; }').ok).toBe(true);
    const site = {
      event: 'playStateChange',
      source: 'var e = event; total += e.x + NewState; sEqEar.moveTo(e.y, total % 7, 0); Ice.value = player.controls.play(); setTimeout(function () { onTick(1); }, 10);',
      params: ['NewState'],
      line: 1,
    };
    let nextEvent = 1000;
    const round = () => {
      const ev = nextEvent++;
      hn.objects.add(ev, 'event', { props: { x: 1, y: 2 } });
      const r = hn.realm.runHandler(2, site, { event: ev, params: { NewState: 3 }, gesture: true });
      hn.objects.objects.delete(ev);
      expect(r.ok).toBe(true);
      hn.clock.advance(10);
      expect(hn.realm.evalExpression(1, 'left', 'sEqEar.left + 1;').ok).toBe(true);
      expect(hn.realm.callGlobal('onTick', [2])).toEqual({ ok: true, value: { __h: 1 } });
    };
    for (let i = 0; i < 20; i++) round();          // warm-up: caches fill, atoms intern
    const dbg = realmDebug(hn.realm);
    const baseline = dbg?.objectCount();
    expect(baseline).toBeGreaterThan(0);
    for (let i = 0; i < 1000; i++) round();
    const after = dbg?.objectCount();
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
    expect(hn.realm.readGlobal('total')).toBeGreaterThan(5000);
    expect(after).toBe(baseline);
  });
});
