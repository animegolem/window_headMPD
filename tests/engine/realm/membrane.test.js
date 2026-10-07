// @ts-check
// W2.2 acceptance item 6 (ENGINE D1 "The membrane"): nothing usable leaks into the realm, string and
// argument caps, event-handle revocation, no synchronous re-entry (writes queue and drain FIFO after the
// entry returns), and the `_onchange` chain cap of 32. Plus the host half's checks without WASM.

import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { describe, expect, it, vi } from 'vitest';
import { FAITHFUL } from '../../../src/engine/options.js';
import { MEMBRANE_CAPS, MEMBRANE_MESSAGES, OP, checkWire, createHandleTable, createMembrane } from '../../../src/engine/realm/membrane.js';
import { realmDebug } from '../../../src/engine/realm/realm.js';
import { HOST_GLOBALS, STANDARD_IDS, makeRealm, outOf, standardObjects, wallClock } from './fake-host.js';

const BUDGET = FAITHFUL.budgets.handler;
// As in faults.test.js: 10 ms when the file runs alone; parallel test files add scheduler noise.
const SLACK = process.env.RG0_STRICT ? 10 : 50;

describe('the host half, without WASM', () => {
  it('checkWire passes the wire types and nothing else', () => {
    expect(checkWire(undefined)).toEqual({ ok: true, value: undefined });
    expect(checkWire(null)).toEqual({ ok: true, value: null });
    expect(checkWire(false)).toEqual({ ok: true, value: false });
    expect(checkWire(-0.5)).toEqual({ ok: true, value: -0.5 });
    expect(checkWire(NaN)).toEqual({ ok: true, value: null });
    expect(checkWire(Infinity)).toEqual({ ok: true, value: null });
    expect(checkWire('x'.repeat(MEMBRANE_CAPS.maxStringLength))).toMatchObject({ ok: true });
    expect(checkWire('x'.repeat(MEMBRANE_CAPS.maxStringLength + 1))).toEqual({ ok: false, reason: 'string' });
    expect(checkWire({ __h: 7, extra: 'dropped' })).toEqual({ ok: true, value: { __h: 7 } });
    for (const bad of [{ __h: 0 }, { __h: -1 }, { __h: 1.5 }, { __h: '7' }, {}, [], () => 1, Symbol('s'), 10n, Object.create({ __h: 3 })]) {
      expect(checkWire(bad)).toMatchObject({ ok: false });
    }
  });

  it('the handle table issues positive integers only and forgets everything at revokeAll', () => {
    const t = createHandleTable();
    t.issue(5);
    t.issue(0);
    t.issue(-2);
    t.issue(1.5);
    expect([t.has(5), t.has(0), t.has(-2), t.has(1.5), t.size]).toEqual([true, false, false, false, 1]);
    t.revoke(5);
    expect(t.has(5)).toBe(false);
    t.issue(6);
    t.revokeAll();
    t.issue(7);
    expect([t.has(6), t.has(7), t.size]).toEqual([false, false, 0]);
  });
});

describe('item 6: the probe finds nothing usable', () => {
  it('the dispatcher was never a global, and Function("return this")() is only the realm global', async () => {
    // Without an id named `constructor`, the bare name falls through to the global's own (Object).
    const hn = await makeRealm({ ids: [{ id: 'volume', handle: 1, className: 'element.slider' }, { id: 'sEqEar', handle: 2, className: 'element.button' }] });
    const probe = outOf(hn, `
      var g = constructor.constructor('return this')();
      var names = Object.getOwnPropertyNames(g);
      return {
        same: g === (function () { return this; })(),
        candidates: ['host', '__host', '__hostDispatch', '__wmp_dispatch', '__wmp_host', '__h', '__TAURI__', '__TAURI_INTERNALS__']
          .map(function (n) { return typeof g[n]; }),
        internals: names.filter(function (n) { return n.indexOf('__') === 0; }).sort(),
        hostGlobal: typeof globalThis.__host,
      };`);
    expect(probe).toEqual({
      same: true,
      candidates: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
      internals: ['__IDS', '__wmp_badAssign', '__wmp_src'],
      hostGlobal: 'undefined',
    });
  });

  it('a proxy exposes no handle: __h is just an unknown member the host answers', async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    expect(outOf(hn, "return [typeof sEqEar.__h, Object.keys(sEqEar).length, Object.getPrototypeOf(sEqEar), typeof sEqEar.constructor]")).toEqual(['undefined', 0, null, 'undefined']);
    expect(hn.objects.log.filter(([op]) => op === 'get').map(([, h, key]) => [h, key])).toEqual([[2, '__h'], [2, 'constructor']]);
  });

  it('a forged {__h} crosses as undefined; a real proxy crosses as its handle', async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    expect(hn.handler('sEqEar.moveTo({ __h: 1 }, volume, [1], function () {}, null, 0 / 0, "s", true);').ok).toBe(true);
    const call = hn.objects.log.find(([op]) => op === 'call');
    expect(call?.[3]).toEqual([undefined, { __h: 1 }, undefined, undefined, null, null, 's', true]);
  });

  it('a skin cannot reach a prelude closure through caller or callee', async () => {
    const hn = await makeRealm();
    expect(hn.handler('function cb() { try { seen = typeof cb.caller + ":" + typeof arguments.callee.caller; } catch (e) { seen = "threw " + e.name; } } setTimeout(cb, 10);').ok).toBe(true);
    hn.clock.advance(10);
    expect(String(hn.realm.readGlobal('seen'))).not.toMatch(/function/);
  });

  it('a setter a skin puts on Object.prototype.__h never runs while a handle crosses in', async () => {
    const hn = await makeRealm();
    expect(hn.handler("Object.defineProperty(Object.prototype, '__h', { set: function (v) { hacked = v; }, get: function () { return 3; }, configurable: true });").ok).toBe(true);
    expect(outOf(hn, "return [typeof hacked, player.controls.play(), player.controls === player.controls]")).toEqual(['undefined', 'played', true]);
  });

  it('a 65 KiB string is rejected in either direction, as a soft fault', async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    const out = hn.handler("sEqEar.tooltip = 'x'.repeat(65 * 1024);");
    expect(out).toMatchObject({ ok: false, kind: 'soft', reason: `RangeError: ${MEMBRANE_MESSAGES.string}` });
    expect(hn.objects.log.filter(([op]) => op === 'set')).toEqual([]);
    expect(hn.handler("sEqEar.tooltip = 'x'.repeat(64 * 1024);").ok).toBe(true);
    hn.objects.objects.get(2)?.props.set('tooltip', 'y'.repeat(65 * 1024));
    expect(hn.handler('var t = sEqEar.tooltip;')).toMatchObject({ ok: false, kind: 'soft', reason: `Error: ${MEMBRANE_MESSAGES.string}` });
    expect(hn.realm.health.hard).toBe(0);
  });

  it('more than 16 arguments is a soft fault', async () => {
    const hn = await makeRealm();
    expect(hn.handler('sEqEar.moveTo(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16);').ok).toBe(true);
    expect(hn.handler('sEqEar.moveTo(1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17);')).toMatchObject({ ok: false, kind: 'soft', reason: `RangeError: ${MEMBRANE_MESSAGES.args}` });
    expect(hn.realm.callGlobal('Math', new Array(17).fill(1))).toMatchObject({ ok: false, kind: 'soft' });
  });

  it('event handles are revoked when their dispatch ends', async () => {
    const hn = await makeRealm();
    hn.objects.add(500, 'event', { props: { x: 41, y: 2 } });
    const site = { event: 'onclick', source: 'saved = event; out = event.x + 1;', params: [], line: 1 };
    expect(hn.realm.runHandler(2, site, { event: 500, gesture: true }).ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe(42);
    hn.objects.log.length = 0;
    const later = hn.handler('out = saved.x;');
    expect(later).toMatchObject({ ok: false, kind: 'soft', reason: `Error: ${MEMBRANE_MESSAGES.handle}` });
    expect(hn.objects.log.filter(([, h]) => h === 500)).toEqual([]);      // the host was never asked
    // Outside a dispatch with its own event, `event` is the stable host global.
    expect(outOf(hn, 'return event.x')).toBe(1);
    expect(hn.realm.health.hard).toBe(0);
  });

  it('host globals and ids are never revoked by a dispatch that names one as its event', async () => {
    const hn = await makeRealm();
    expect(hn.realm.runHandler(2, { event: 'onclick', source: 'out = event.x;', params: [], line: 1 }, { event: HOST_GLOBALS.event }).ok).toBe(true);
    expect(outOf(hn, 'return event.x')).toBe(1);
  });
});

describe('G2 F1: oversize keys are refused before they are copied', () => {
  it('a 16 MiB key in a get, set or call loop is a RangeError realm-side, and the loop a hard fault within budget + 300 ms', async () => {
    for (const op of ['sEqEar[k];', 'sEqEar[k] = 1;', 'player[k]();']) {
      const hn = await makeRealm();
      expect(hn.realm.loadScript('k.js', "var k = 'A'.repeat(16 * 1024 * 1024);").ok).toBe(true);
      hn.objects.log.length = 0;
      expect(outOf(hn, `try { ${op} } catch (e) { return [e.name, e.message]; }`)).toEqual(['RangeError', MEMBRANE_MESSAGES.string]);
      const t = wallClock();
      const r = hn.handler(`for (;;) { try { ${op} } catch (e) {} }`);
      const ms = wallClock() - t;
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      expect(ms).toBeLessThanOrEqual(BUDGET + 300);
      expect(hn.objects.log).toEqual([]);                          // nothing reached the host
    }
  });

  it('has, and the id table, answer an oversize name without lowercasing it or reporting it', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('k.js', "var k = 'A'.repeat(16 * 1024 * 1024);").ok).toBe(true);
    expect(outOf(hn, 'var w = (__IDS[k] = 1); return [k in sEqEar, typeof __IDS[k], k in __IDS]')).toEqual([false, 'undefined', false]);
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-write')).toEqual([]);
  });

  it('the host half measures a realm string before copying it: an oversize key never reaches getString', async () => {
    const mod = await newQuickJSWASMModuleFromVariant(variant);
    const ctx = mod.newContext();
    try {
      /** @type {Array<[string, number, string]>} */
      const seen = [];
      const noop = () => undefined;
      const membrane = createMembrane({
        ctx,
        dispatcher: { get: (h, key) => { seen.push(['get', h, key]); return 1; }, set: noop, call: noop, timer: noop, now: () => 0 },
        hooks: { timerSet: () => true, timerClear: noop, guard: () => false, diag: noop },
        log: { info: noop, warn: noop, diag: noop },
      });
      membrane.table.issue(7);
      const getString = vi.spyOn(ctx, 'getString');
      const op = ctx.newNumber(OP.GET), h = ctx.newNumber(7), big = ctx.newString('A'.repeat(MEMBRANE_CAPS.maxStringLength + 1)), ok = ctx.newString('Top');
      const refused = membrane.native(op, h, big);
      expect(refused.error).toBeDefined();
      expect(ctx.dump(refused.error).message).toBe(MEMBRANE_MESSAGES.value);
      refused.error.dispose();
      expect(getString).not.toHaveBeenCalled();
      const answered = membrane.native(op, h, ok);
      expect(ctx.dump(answered)).toBe(1);
      answered.dispose();
      expect(seen).toEqual([['get', 7, 'top']]);
      expect(membrane.fromRealm(big)).toEqual({ ok: false, reason: 'string' });
      for (const x of [op, h, big, ok]) x.dispose();
    } finally {
      ctx.dispose();
    }
  });
});

describe('G2 F6: a host op never runs skin code, even with the realm half tampered with', () => {
  it("a box the tampered WeakMap fills with a skin object (whose toJSON writes another element) is refused, with no nested op", async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    const r = hn.handler("var evil = { toJSON: function () { volume.top = 'nested'; return { __h: 1 }; } }; WeakMap.prototype.get = function () { return evil; }; sEqEar.left = { tag: 'evil' };");
    expect(r).toMatchObject({ ok: false, kind: 'soft', reason: `Error: ${MEMBRANE_MESSAGES.value}` });
    expect(hn.objects.log.filter(([op]) => op === 'set')).toEqual([]);
  });
});

describe('G2 DOS-2: the drain of queued dispatches is bounded in wall time', () => {
  it('a slider whose _onchange writes itself twice (fan-out 2) returns in about budgets.load, with one soft fault, and the realm lives', async () => {
    const objects = standardObjects();
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    const site = { event: 'value_onchange', source: 'var t = Date.now(); while (Date.now() - t < 5) {} volume.value = 1; volume.value = 2;', params: [], line: 1 };
    objects.objects.get(1).onSet = () => { realm?.runHandler(1, site, {}); };
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    const t = wallClock();
    const r = hn.handler('volume.value = 5;');
    const ms = wallClock() - t;
    expect(r.ok).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(FAITHFUL.budgets.load);
    expect(ms).toBeLessThanOrEqual(FAITHFUL.budgets.load + BUDGET + 300);
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault').map((d) => d.detail)).toEqual([`test/view queue: queued dispatches ran over ${FAITHFUL.budgets.load} ms; the rest were dropped`]);
    expect(hn.realm.health).toMatchObject({ hard: 0, unloaded: false });
    expect(realmDebug(hn.realm)?.queued()).toBe(0);
    expect(outOf(hn, 'return 5')).toBe(5);
  });
});

describe('item 6: no synchronous re-entry', () => {
  it('writes queue and drain FIFO after the entry returns', async () => {
    const objects = standardObjects();
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    const onchange = (/** @type {number} */ el, /** @type {string} */ tag) => ({ event: 'value_onchange', source: `sEqEar.moveTo('${tag}', ${el}, 0);`, params: [], line: 1 });
    objects.objects.get(1).onSet = () => { realm?.runHandler(1, onchange(1, 'A'), {}); };
    objects.objects.get(3).onSet = () => { realm?.runHandler(3, onchange(3, 'B'), {}); };
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    hn.objects.log.length = 0;
    const r = hn.handler("sEqEar.moveTo('start', 0, 0); volume.value = 70; Ice.value = 'x'; sEqEar.moveTo('end', 0, 0);");
    expect(r.ok).toBe(true);
    const order = hn.objects.log.filter(([op, h, key]) => op === 'call' && h === 2 && key === 'moveto').map(([, , , a]) => a?.[0]);
    expect(order).toEqual(['start', 'end', 'A', 'B']);
    expect(hn.realm.health.soft).toBe(0);
  });

  it('a two-slider ping-pong stops at depth 32 with a soft fault', async () => {
    const objects = standardObjects();
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    let runs = 0;
    objects.objects.get(2)?.methods.set('count', () => { runs++; });
    const site = (/** @type {string} */ other) => ({ event: 'value_onchange', source: `sEqEar.count(); ${other}.value = value + 1;`, params: [], line: 1 });
    objects.objects.get(1).onSet = () => { realm?.runHandler(1, site('Ice'), {}); };
    objects.objects.get(3).onSet = () => { realm?.runHandler(3, site('volume'), {}); };
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    const r = hn.handler('volume.value = 1;');
    expect(r.ok).toBe(true);
    expect(runs).toBe(32);
    expect(hn.realm.health).toMatchObject({ soft: 1, hard: 0, unloaded: false });
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault').map((d) => d.detail)).toEqual([expect.stringMatching(/change chain deeper than 32/)]);
    // The realm carries on.
    expect(outOf(hn, 'return 5')).toBe(5);
  });

  it('a timer fired from inside a host op waits for the entry too', async () => {
    const objects = standardObjects();
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(110)?.methods.set('pause', () => { realm?.fireTimer(1); return 'paused'; });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    expect(hn.handler("setTimeout(function () { Ice.value = 'timer'; }, 1000);").ok).toBe(true);
    expect(hn.handler("player.controls.pause(); Ice.value = 'handler';").ok).toBe(true);
    expect(hn.objects.prop(3, 'value')).toBe('timer');         // ran after the handler's own write
  });

  it('evalExpression and callGlobal from inside a host op are refused; readGlobal is allowed', async () => {
    const objects = standardObjects();
    /** @type {any[]} */
    const seen = [];
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    objects.objects.get(110)?.methods.set('pause', () => {
      seen.push(realm?.evalExpression(1, 'left', '1'), realm?.callGlobal('f', []), realm?.readGlobal('flag'), realm?.loadScript('x.js', 'var y;'));
      return 'paused';
    });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    expect(hn.realm.loadScript('a.js', "var flag = 'up'; function f() { return 1; }").ok).toBe(true);
    expect(hn.handler('player.controls.pause();').ok).toBe(true);
    expect(seen).toEqual([
      expect.objectContaining({ ok: false, kind: 'soft', reason: 're-entrant call from a host op' }),
      expect.objectContaining({ ok: false, kind: 'soft', reason: 're-entrant call from a host op' }),
      'up',
      expect.objectContaining({ ok: false, kind: 'soft', reason: 're-entrant call from a host op' }),
    ]);
  });

  it('setIds from inside a host op is refused and cannot lift the running dispatch\'s budget', async () => {
    const objects = standardObjects();
    /** @type {import('../../../src/engine/contracts').Realm | null} */
    let realm = null;
    let called = 0;
    objects.objects.get(110)?.methods.set('pause', () => {
      called++;
      realm?.setIds(STANDARD_IDS);
      return 'paused';
    });
    const hn = await makeRealm({ objects });
    realm = hn.realm;
    const t = wallClock();
    const r = hn.handler('player.controls.pause(); while (1) {}');
    const ms = wallClock() - t;
    expect(called).toBe(1);
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeLessThanOrEqual(BUDGET + SLACK);
    expect(hn.log.diags.filter((d) => d.code === 'realm-setids-reentry')).toHaveLength(1);
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault').map((d) => d.detail)).toEqual([expect.stringMatching(/setIds: re-entrant call from a host op/)]);
    expect(hn.realm.health).toMatchObject({ soft: 1, hard: 1, unloaded: false });
  });

  it('callGlobal and readGlobal pass only wire values', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('a.js', 'var n = 3, s = "str", o = { a: 1 }; function add(a, b) { return a + b; } function el() { return volume; } function arr() { return [1]; } function who(x) { return x === Ice; }').ok).toBe(true);
    expect(hn.realm.callGlobal('add', [2, 3])).toEqual({ ok: true, value: 5 });
    expect(hn.realm.callGlobal('el', [])).toEqual({ ok: true, value: { __h: 1 } });
    expect(hn.realm.callGlobal('arr', [])).toEqual({ ok: true, value: undefined });
    expect(hn.realm.callGlobal('who', [{ __h: 3 }])).toEqual({ ok: true, value: true });
    expect(hn.realm.callGlobal('nope', [])).toMatchObject({ ok: false, kind: 'soft', reason: expect.stringMatching(/TypeError/) });
    expect(hn.realm.callGlobal('__wmp_badAssign', [])).toMatchObject({ ok: false, kind: 'soft' });
    expect([hn.realm.readGlobal('n'), hn.realm.readGlobal('s'), hn.realm.readGlobal('o'), hn.realm.readGlobal('player'), hn.realm.readGlobal('nope')]).toEqual([3, 'str', undefined, undefined, undefined]);
  });
});
