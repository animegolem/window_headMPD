// @ts-check
// G2 review DOS-1, F5 and DOS-6 (ENGINE D1 "Budgets and faults", E §10 "WASM heap"): QuickJS's own memory
// limit counts per-allocation overhead, not size, so a skin could grow the WASM heap to 2 GiB with no
// fault. The realm runs on a capped WebAssembly.Memory and reads memory exhaustion from the heap alone:
// a refused allocation or a heap past the cap is a hard 'memory' fault that discards the instance, even
// when skin code caught the error, and a thrown look-alike of an OOM is an ordinary soft exception.

import { describe, expect, it } from 'vitest';
import { realmDebug } from '../../../src/engine/realm/realm.js';
import { MiB, makeRealm, outOf } from './fake-host.js';

/** @param {Awaited<ReturnType<typeof makeRealm>>} hn */
const heapOf = (hn) => /** @type {NonNullable<ReturnType<typeof realmDebug>>} */ (realmDebug(hn.realm)).heap();

/** @param {Awaited<ReturnType<typeof makeRealm>>} hn */
const expectMemoryFault = (hn) => {
  expect(hn.realm.health).toMatchObject({ unloaded: true });
  expect(realmDebug(hn.realm)?.state()).toBe('discarded');
  expect(hn.log.infos.map(([m]) => m)).toContain('realm: unload: discarded (never disposed)');
};

describe('DOS-1: the heap is capped, whatever QuickJS counts', () => {
  // First in the file, so the RSS it measures is this realm's.
  it("the review's hoard loop across dispatches ends as a hard memory fault, with host RSS growth under 2x the cap", async () => {
    const rss0 = process.memoryUsage().rss;
    const hn = await makeRealm();
    const { cap, max } = heapOf(hn);
    expect(cap).toBe(16 * MiB + 64 * MiB);
    expect(max).toBeGreaterThan(cap);
    expect(max).toBeLessThanOrEqual(Math.ceil(cap * 17 / 16 / 65536) * 65536);
    expect(hn.handler('hoard = [];', { event: 'onload' }).ok).toBe(true);
    /** @type {any} */
    let r = { ok: true };
    let dispatches = 0;
    for (; dispatches < 400 && r.ok; dispatches++) {
      r = hn.handler('for (var i = 0; i < 40; i++) hoard.push("x".repeat((1 << 20) + hoard.length));');
    }
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'memory' });
    expect(dispatches).toBeLessThanOrEqual(3);                    // 40 MiB a dispatch against an 80 MiB cap
    expect(heapOf(hn).bytes).toBeLessThanOrEqual(max);
    expectMemoryFault(hn);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(2 * cap);
  });

  /** @type {Array<[string, string]>} */
  const SHAPES = [
    ['a burst of 16 MiB typed arrays in one onload', 'var a = []; for (;;) a.push(new Uint8Array(1 << 24));'],
    // Function locals: names at a handler's top level resolve through the with() traps, which is slower
    // than the budget allows for millions of objects.
    ['a flood of small objects', '(function () { var a = []; for (var i = 0; ; i++) a.push({ x: i }); })();'],
    ['an array that keeps growing', '(function () { var a = []; for (var i = 0; ; i++) a.push(i, i, i, i, i, i, i, i); })();'],
    ['one allocation over the cap', "var s = 'x'.repeat(200 * 1000 * 1000);"],
  ];
  for (const [title, body] of SHAPES) {
    it(`${title} is a hard memory fault, and the instance is discarded`, async () => {
      const hn = await makeRealm();
      const r = hn.realm.runHandler(2, { event: 'onload', source: body, params: [], line: 1 });
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'memory' });
      expect(heapOf(hn).bytes).toBeLessThanOrEqual(heapOf(hn).max);
      expectMemoryFault(hn);
    });
  }

  it('a heap left on the plateau just under the maximum (63 MiB, then 8 MiB arrays) is still a memory fault', async () => {
    const hn = await makeRealm();
    const r = hn.realm.runHandler(2, { event: 'onload', source: "var keep = 'x'.repeat(63 * 1024 * 1024), a = []; try { for (;;) a.push(new Uint8Array(8 * 1024 * 1024)); } catch (e) {}", params: [], line: 1 });
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'memory' });
    expectMemoryFault(hn);
  });

  it('a skin that cycles 20 MiB of live data for many dispatches stays live', async () => {
    const hn = await makeRealm();
    for (let i = 0; i < 100; i++) {
      expect(hn.handler("live = []; for (var i = 0; i < 20; i++) live.push('y'.repeat(1 << 20));").ok).toBe(true);
    }
    expect(hn.realm.health).toMatchObject({ hard: 0, unloaded: false });
    expect(heapOf(hn).bytes).toBeLessThanOrEqual(heapOf(hn).cap);
  });
});

describe('DOS-6: an OOM caught by skin code still ends the entry as a hard memory fault', () => {
  /** @type {Array<[string, string]>} */
  const CAUGHT = [
    ['try/catch around one allocation over the cap', "try { s = 'x'.repeat(200e6); } catch (e) { out = String(e); }"],
    ['try/catch around a growing hoard', 'var a = []; try { for (;;) a.push(new Uint8Array(1 << 20)); } catch (e) { out = String(e); }'],
    ['a Promise reaction, which turns the OOM into a rejection', "Promise.resolve().then(function () { s = 'x'.repeat(200e6); });"],
  ];
  for (const [title, body] of CAUGHT) {
    it(title, async () => {
      const hn = await makeRealm();
      expect(hn.handler(body)).toMatchObject({ ok: false, kind: 'hard', reason: 'memory' });
      expectMemoryFault(hn);
    });
  }
});

describe('F5: a thrown look-alike of an OOM is a soft fault', () => {
  it("throw {name:'InternalError', message:'out of memory'}, new InternalError('out of memory') and a renamed Error stay soft and live", async () => {
    const hn = await makeRealm();
    for (const body of ["throw { name: 'InternalError', message: 'out of memory' };", "throw new InternalError('out of memory');",
      "var e = new Error('out of memory'); e.name = 'InternalError'; throw e;"]) {
      expect(hn.handler(body)).toMatchObject({ ok: false, kind: 'soft', reason: 'InternalError: out of memory' });
    }
    expect(hn.realm.health).toMatchObject({ soft: 3, hard: 0, unloaded: false });
    expect(outOf(hn, 'return 1 + 1')).toBe(2);
  });

  it('a stack-overflow look-alike stays a hard stack fault: no host signal tells it apart, and it only costs the skin its own view', async () => {
    const hn = await makeRealm();
    expect(hn.handler("throw { name: 'InternalError', message: 'stack overflow' };")).toMatchObject({ ok: false, kind: 'hard', reason: 'stack' });
    expect(hn.realm.health).toMatchObject({ hard: 1, unloaded: false });
  });
});
