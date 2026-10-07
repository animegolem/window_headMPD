// @ts-check
// W2.2 acceptance items 4 and 9 (ENGINE D1 "Budgets and faults", "Fault domain"; E §10): wall-clock
// budgets, OOM, the stack cap, unload after repeated hard faults, discard-never-dispose, and a fresh
// realm afterwards.

import { QuickJSContext, QuickJSRuntime } from 'quickjs-emscripten-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAITHFUL } from '../../../src/engine/options.js';
import { realmDebug } from '../../../src/engine/realm/realm.js';
import { makeRealm, outOf, wallClock } from './fake-host.js';

const BUDGET = FAITHFUL.budgets.handler;
// The card: within 100 ms + 50 ms (10 ms when the file runs alone; parallel test files add scheduler noise).
const SLACK = process.env.RG0_STRICT ? 10 : 50;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** @param {() => any} f */
const timed = (f) => {
  const t = wallClock();
  const r = f();
  return { r, ms: wallClock() - t };
};

describe('item 4: budgets', () => {
  it('while(1){} in a handler is a hard fault within the handler budget plus slack', async () => {
    const hn = await makeRealm();
    const { r, ms } = timed(() => hn.handler('while (1) {}'));
    expect(r).toEqual({ ok: false, kind: 'hard', reason: 'budget', site: 'handler 2.onclick' });
    expect(ms).toBeGreaterThanOrEqual(BUDGET);
    expect(ms).toBeLessThanOrEqual(BUDGET + SLACK);
    expect(hn.realm.health).toMatchObject({ hard: 1, unloaded: false });
    // One budget fault does not unload: the next handler runs.
    expect(outOf(hn, 'return 1 + 1')).toBe(2);
  });

  it('a catch or finally cannot swallow the interrupt', async () => {
    const hn = await makeRealm();
    for (const body of ['for (;;) { try { for (;;) {} } catch (e) {} }', 'try { for (;;) {} } finally { for (;;) {} }']) {
      const { r, ms } = timed(() => hn.handler(body));
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      expect(ms).toBeLessThanOrEqual(BUDGET + SLACK);
    }
  });

  it('onload gets the 1,000 ms budget, a jscript: value 20 ms', async () => {
    const hn = await makeRealm();
    const load = timed(() => hn.realm.runHandler(2, { event: 'onLoad', source: 'var t = Date.now(); while (Date.now() - t < 300) {}', params: [], line: 1 }));
    expect(load.r.ok).toBe(true);
    const expr = timed(() => hn.realm.evalExpression(2, 'left', 'while (1) {}'));
    expect(expr.r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget', site: 'expr 2.left' });
    expect(expr.ms).toBeLessThanOrEqual(FAITHFUL.budgets.expr + SLACK);
  });

  it('a job queued by a handler runs in the same entry, under the same budget', async () => {
    const hn = await makeRealm();
    expect(hn.handler('Promise.resolve().then(function () { Ice.value = "from a job"; });').ok).toBe(true);
    expect(hn.objects.prop(3, 'value')).toBe('from a job');
    const { r, ms } = timed(() => hn.handler('Promise.resolve().then(function () { while (1) {} });'));
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeLessThanOrEqual(BUDGET + SLACK);
  });

  // G2 DOS-8: the jobs left past the cap never run under the next entry. The entry that queued them gets a
  // soft fault; before the next entry they run as their own entry ('jobs'), and a flood that outlives that
  // drain as well is a hard fault there, so a self-sustaining chain unloads after three.
  it('a self-rescheduling job flood is cut at 1,000 jobs per drain; the rest run as their own entry, never under the next one', async () => {
    const hn = await makeRealm();
    expect(hn.handler('n = 0; (function f() { n++; Promise.resolve().then(f); })();')).toMatchObject({ ok: false, kind: 'soft', reason: 'more than 1000 pending jobs', site: 'handler 2.onclick' });
    expect(hn.realm.readGlobal('n')).toBe(1001);                  // a read runs no jobs
    expect(hn.realm.health.hard).toBe(0);
    // The next entry: the leftovers ran first, as 'jobs' (1,000 more, still not done: hard), and the
    // expression itself is untouched by them.
    expect(hn.realm.evalExpression(2, 'left', '1 + 1')).toEqual({ ok: true, value: 2 });
    expect(hn.realm.readGlobal('n')).toBe(2001);
    expect(hn.log.diags.filter((d) => d.code === 'realm-hard-fault').map((d) => d.detail)).toEqual(['test/view jobs: more than 1000 pending jobs']);
    hn.realm.evalExpression(2, 'left', '1');
    hn.realm.evalExpression(2, 'left', '1');
    expect(hn.realm.health).toMatchObject({ hard: 3, unloaded: true });
  });

  it("the review's case: leftover jobs no longer use up a jscript: value's 20 ms or fault at its site", async () => {
    const hn = await makeRealm();
    const r = hn.realm.runHandler(2, { event: 'onload', source: '(function f(){ Promise.resolve().then(function(){ for(var i=0;i<3000;i++){}; f(); }); })();', params: [], line: 1 });
    expect(r).toMatchObject({ ok: false, kind: 'soft', reason: 'more than 1000 pending jobs' });
    const expr = hn.realm.evalExpression(2, 'left', '1');
    expect(expr).toEqual({ ok: true, value: 1 });
    expect(hn.log.diags.filter((d) => d.code === 'realm-hard-fault').every((d) => !/expr/.test(d.detail))).toBe(true);
  });

  it('a 200 MB allocation is an OOM: a hard fault that unloads at once and discards the instance', async () => {
    const hn = await makeRealm();
    const r = hn.handler("var s = 'x'.repeat(200 * 1000 * 1000);");
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'memory' });
    expect(hn.realm.health).toMatchObject({ hard: 1, unloaded: true });
    expect(realmDebug(hn.realm)?.state()).toBe('discarded');
    expect(hn.log.infos.map(([m]) => m)).toContain('realm: unload: discarded (never disposed)');
    expect(hn.handler('1')).toMatchObject({ ok: false, kind: 'hard', reason: 'unloaded' });
  });

  it('three hard faults within 30 s unload the view; timers are cleared and every handle revoked', async () => {
    const hn = await makeRealm();
    expect(hn.handler('setInterval(function () {}, 50); setTimeout("1", 500);').ok).toBe(true);
    hn.timerOps.length = 0;
    expect(hn.handler('while (1) {}')).toMatchObject({ kind: 'hard' });
    expect(hn.handler('while (1) {}')).toMatchObject({ kind: 'hard' });
    expect(hn.realm.health.unloaded).toBe(false);
    expect(hn.handler('while (1) {}')).toMatchObject({ kind: 'hard', reason: 'budget' });
    expect(hn.realm.health).toMatchObject({ hard: 3, unloaded: true });
    expect(hn.timerOps.filter(([op]) => op === 'clear')).toHaveLength(2);
    expect(realmDebug(hn.realm)?.state()).toBe('discarded');
    expect(hn.realm.readGlobal('osMediaOpen')).toBeUndefined();
    expect(hn.realm.evalExpression(1, 'left', '1')).toMatchObject({ ok: false, reason: 'unloaded' });
    // Unload does not count as a fault of its own.
    expect(hn.realm.health.hard).toBe(3);
  });

  it('after an unload, a new realm in the same process works', async () => {
    const first = await makeRealm();
    first.handler("var s = 'x'.repeat(200 * 1000 * 1000);");
    expect(first.realm.health.unloaded).toBe(true);
    const second = await makeRealm();
    expect(outOf(second, 'return [1 + 1, volume.value]')).toEqual([2, 50]);
  });

  it('the budget still fires when the engine clock is frozen, and when Date and performance are fakes', async () => {
    const hn = await makeRealm();
    vi.useFakeTimers({ toFake: ['Date', 'performance'], now: 1_000_000 });
    const a = performance.now();
    const spin = wallClock() + 3;
    while (wallClock() < spin) { /* real time passes */ }
    expect(performance.now()).toBe(a);                         // the fakes are frozen
    const before = hn.clock.now();
    const { r, ms } = timed(() => hn.handler('while (1) {}'));
    vi.useRealTimers();
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeLessThanOrEqual(BUDGET + SLACK);
    expect(hn.clock.now()).toBe(before);                       // the engine clock never moved
  });

  it('a clean realm disposes on unload; one with only soft faults too', async () => {
    const hn = await makeRealm();
    expect(hn.handler('undefinedFn()').ok).toBe(false);
    hn.realm.unload('skin switch');
    expect(realmDebug(hn.realm)?.state()).toBe('disposed');
    expect(hn.realm.health.unloaded).toBe(true);
    expect(hn.log.infos).toContainEqual(['realm: unload: disposed', { viewKey: 'test/view', reason: 'skin switch' }]);
  });

  it('a realm with one budget fault is discarded on unload, never disposed', async () => {
    const hn = await makeRealm();
    hn.handler('while (1) {}');
    const ctxDispose = vi.spyOn(QuickJSContext.prototype, 'dispose');
    const rtDispose = vi.spyOn(QuickJSRuntime.prototype, 'dispose');
    hn.realm.unload('view close');
    expect(realmDebug(hn.realm)?.state()).toBe('discarded');
    expect(ctxDispose).not.toHaveBeenCalled();
    expect(rtDispose).not.toHaveBeenCalled();
  });

  it('an unload requested by a host op mid-dispatch waits for the entry to return', async () => {
    const hn = await makeRealm();
    hn.objects.objects.get(110)?.methods.set('stop', () => {
      hn.realm.unload('closed from a host op');
      return 'stopped';
    });
    expect(hn.handler('out = player.controls.stop(); Ice.value = out;').ok).toBe(true);
    expect(hn.objects.prop(3, 'value')).toBe('stopped');        // the handler finished
    expect(hn.realm.health.unloaded).toBe(true);
    expect(realmDebug(hn.realm)?.state()).toBe('disposed');
  });
});

describe('G2 DOS-5: an entry that overruns without an interrupt poll', () => {
  // A long native call as the entry's last work (here the parse of a 40,000-declaration eval) used to
  // end before any poll could see the deadline, and the dispatch reported ok: past deadline + 300 ms it
  // is a hard budget fault now, so three of them unload the view.
  // The eval takes ~630 ms here; a 20 ms handler budget keeps the case clear of the 300 ms slack on a faster host.
  it('(0,eval)(src) over 40,000 declarations is a hard budget fault, and three of them unload', async () => {
    const handler = 20;
    const hn = await makeRealm({ options: { budgets: { ...FAITHFUL.budgets, handler } } });
    expect(hn.realm.runHandler(2, { event: 'onload', source: "(function () { var p = []; for (var i = 0; i < 40000; i++) p[i] = 'var v' + i + ';'; src = p.join('\\n'); })();", params: [], line: 1 }).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const { r, ms } = timed(() => hn.handler('(0, eval)(src);'));
      expect(ms).toBeGreaterThan(handler + 300);
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    }
    expect(hn.realm.health).toMatchObject({ hard: 3, unloaded: true });
  });

  it('work under the budget plus the slack stays ok', async () => {
    const hn = await makeRealm();
    expect(hn.handler('var t = Date.now(); while (Date.now() - t < 90) {}').ok).toBe(true);
    expect(hn.realm.runHandler(2, { event: 'onload', source: 'var t = Date.now(); while (Date.now() - t < 300) {}', params: [], line: 1 }).ok).toBe(true);
    expect(hn.realm.health.hard).toBe(0);
  });
});

describe('fault classification and a broken host log', () => {
  it('a skin that throws a look-alike of the interrupt error gets a soft fault, not a budget fault', async () => {
    const hn = await makeRealm();
    const r = hn.handler("throw { name: 'InternalError', message: 'interrupted' };");
    expect(r).toMatchObject({ ok: false, kind: 'soft', reason: 'InternalError: interrupted' });
    expect(hn.realm.health.hard).toBe(0);
  });

  // G2 F2: quickjs-emscripten's dump disposes a Promise handle itself, so the realm's own dispose used
  // to throw a host-side use-after-free, a 'host-exception' that unloaded the view. The realm stays
  // live, and still disposes cleanly at the end (fake-host's afterEach).
  it('throwing a Promise is a soft fault through every entry point', async () => {
    const hn = await makeRealm();
    for (const body of ['throw Promise.resolve(1);', 'throw Promise.reject(2);', 'throw new Promise(function () {});', 'throw Promise.reject(Promise.resolve(1));']) {
      expect(hn.handler(body)).toMatchObject({ ok: false, kind: 'soft', reason: 'uncaught a Promise' });
    }
    expect(hn.realm.evalExpression(2, 'left', '(function () { throw Promise.resolve(3); })()')).toMatchObject({ ok: false, kind: 'soft', reason: 'uncaught a Promise' });
    expect(hn.realm.loadScript('p.js', 'function thrower() { throw Promise.reject(Promise.resolve(1)); } throw Promise.resolve(4);')).toMatchObject({ ok: false, kind: 'soft', reason: 'uncaught a Promise' });
    expect(hn.realm.callGlobal('thrower', [])).toMatchObject({ ok: false, kind: 'soft', reason: 'uncaught a Promise' });
    expect(hn.handler('setTimeout(function () { throw Promise.resolve(5); }, 10);').ok).toBe(true);
    hn.clock.advance(10);
    expect(hn.realm.health).toMatchObject({ soft: 8, hard: 0, unloaded: false });
  });

  it('a log that throws never breaks a dispatch or leaks into the realm', async () => {
    const hn = await makeRealm();
    const boom = () => { throw new Error('log exploded'); };
    Object.assign(hn.log, { info: boom, warn: boom, diag: boom });
    hn.objects.objects.get(110)?.methods.set('stop', () => { throw new Error('host'); });
    expect(hn.handler('undefinedFn()')).toMatchObject({ ok: false, kind: 'soft' });
    expect(outOf(hn, 'try { player.controls.stop(); } catch (e) { return e.message; }')).toBe('host error');
    expect(hn.handler('while (1) {}')).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(outOf(hn, 'return 3')).toBe(3);
  });
});

describe('item 9: the stack cap and exceptions out of WASM', () => {
  it('unbounded recursion at the contracted 256 KiB is a realm stack fault (hard), not an escape', async () => {
    const hn = await makeRealm();
    const r = hn.handler('function r() { return r() + 1; } r();');
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'stack' });
    expect(hn.realm.health).toMatchObject({ hard: 1, unloaded: false });
    expect(outOf(hn, 'var d = 0; function q() { d++; return q() + 1; } try { q(); } catch (e) { return [e.name, d > 100]; }')).toEqual(['InternalError', true]);
  });

  it('at 1 MiB recursion escapes WASM as a host RangeError: a hard fault, and the instance is discarded, never disposed', async () => {
    const ctxDispose = vi.spyOn(QuickJSContext.prototype, 'dispose');
    const rtDispose = vi.spyOn(QuickJSRuntime.prototype, 'dispose');
    const hn = await makeRealm({ options: { maxStackBytes: 1024 * 1024 } });
    const r = hn.handler('function r() { return r() + 1; } try { r(); } catch (e) { }');
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'host-exception' });
    expect(hn.log.warns).toContainEqual(['realm: exception escaped the WASM call', expect.objectContaining({ name: 'RangeError', message: 'Maximum call stack size exceeded' })]);
    expect(hn.realm.health).toMatchObject({ hard: 1, unloaded: true });
    expect(realmDebug(hn.realm)?.state()).toBe('discarded');
    expect(ctxDispose).not.toHaveBeenCalled();
    expect(rtDispose).not.toHaveBeenCalled();
    expect(hn.realm.readGlobal('osMediaOpen')).toBeUndefined();
    // And the next realm in the same process is fine.
    vi.restoreAllMocks();
    const next = await makeRealm();
    expect(outOf(next, 'return 2 + 2')).toBe(4);
  });

  it('a host exception thrown by the dispatcher is a soft fault with a fixed message, not an escape', async () => {
    const hn = await makeRealm();
    hn.objects.objects.get(110)?.methods.set('stop', () => {
      throw new Error('secret host detail');
    });
    const r = hn.handler('player.controls.stop()');
    expect(r).toMatchObject({ ok: false, kind: 'soft', reason: 'Error: host error' });
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(outOf(hn, "try { player.controls.stop(); } catch (e) { return [e.name, e.message, e instanceof Error]; }")).toEqual(['Error', 'host error', true]);
    expect(hn.log.warns.some(([m, d]) => m === 'realm: host error in a dispatcher op' && JSON.stringify(d).includes('secret'))).toBe(true);
    expect(hn.realm.health.hard).toBe(0);
  });
});
