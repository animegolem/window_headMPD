// @ts-check
// W2.2 acceptance item 11 (E R19): QuickJS polls its interrupt about every 10,000 interpreter ticks and
// a builtin call is one tick however long it runs, so a loop of one slow builtin used to outrun the
// budget by seconds (RG0: 0.8-2.2 s for repeat, minutes for indexOf over 16 MiB). The prelude wraps the
// size-proportional builtins; once the dispatch is over budget a wrapped call throws before running,
// the loop spins in cheap ticks, and the real interrupt fires.

import { describe, expect, it } from 'vitest';
import { FAITHFUL } from '../../../src/engine/options.js';
import { GUARDED_BUILTINS, GUARD_MESSAGE, GUARD_MIN_SIZE } from '../../../src/engine/realm/prelude.js';
import { makeRealm, outOf, wallClock } from './fake-host.js';

const BUDGET = FAITHFUL.budgets.handler;
const BOUND = 300;              // the card: within budget + 300 ms

describe('item 11: slow-builtin guards', () => {
  it("for(;;){try{'y'.repeat(1e5)}catch(e){}} is a hard fault within budget + 300 ms", async () => {
    const hn = await makeRealm();
    const t = wallClock();
    const r = hn.handler("for (;;) { try { 'y'.repeat(1e5); } catch (e) {} }");
    const ms = wallClock() - t;
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeGreaterThanOrEqual(BUDGET);
    expect(ms).toBeLessThanOrEqual(BUDGET + BOUND);
  });

  it("for(;;){s.indexOf('b')} over a 16 MiB string is a hard fault within budget + 300 ms", async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('big.js', "var s = 'a'.repeat(16 * 1024 * 1024);").ok).toBe(true);
    const t = wallClock();
    const r = hn.handler("for (;;) { s.indexOf('b'); }");
    const ms = wallClock() - t;
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeLessThanOrEqual(BUDGET + BOUND);
  });

  // Fix round 1: the same operations on other prototypes, and replace sized by its arguments too.
  // Each loop is bounded by the one call in flight when the deadline passes (single calls measured at
  // ~145 ms for u.join(',') over 4 MiB and u.sort() over 16 MiB). toSorted runs 500 K elements, not
  // the reviewer's 2 M: one call over 2 M takes ~415 ms on its own, past the bound before any guard.
  // Fix round 2: arguments the old sizing trusted. An object replacement stringifies through its
  // toString; Symbol.isConcatSpreadable spreads an array-like or a typed array; a Proxy's get trap
  // answered the guard's length read small and fill's large. The proxy runs 500 K elements, not the
  // reviewer's 2 M: one honest fill over 2 M through a proxy takes ~150 ms alone, and in a loaded full
  // suite the 2 M loop ended at 563 and 574 ms; 500 K takes ~40 ms, and 200 K ran 1,525 ms before the fix.
  // The last three are what a short replacement writes many times over: '$' patterns and replaceAll
  // multiply it, and RegExp's Symbol.replace was sized by its subject alone.
  // G2.F1: an operand a builtin turns into a string was sized like an array, so a one-element array
  // whose own toString (or Symbol.toPrimitive) returns a long string counted 1. Measured before the fix,
  // alone: 2,632 ms for indexOf, 1,903 ms for toUpperCase over 4 MiB, 1,042 ms for JSON.parse, 2,629 ms
  // for the Symbol.toPrimitive indexOf. toUpperCase runs 4 MiB, not the reviewer's 16 MiB: one call over
  // 16 MiB takes ~137 ms on its own, too close to the bound under load.
  const LYING = 'a = [0]; a.toString = function () { return big; };';
  const LOOPS = [
    ['for(;;){ a.toSorted(); } over 500 K elements', 'var a = new Array(500000).fill(1);', 'for (;;) { a.toSorted(); }'],
    ["for(;;){ try { u.join(','); } catch (e) {} } over a 4 MiB Uint8Array", 'var u = new Uint8Array(4 * 1024 * 1024);', "for (;;) { try { u.join(','); } catch (e) {} }"],
    ['for(;;){ u.sort(); } over a 16 MiB Uint8Array', 'var u = new Uint8Array(16 * 1024 * 1024);', 'for (;;) { u.sort(); }'],
    ["for(;;){ 'y'.replace('y', big); } with a 16 MiB replacement", "var big = 'x'.repeat(16 * 1024 * 1024);", "for (;;) { 'y'.replace('y', big); }"],
    ["for(;;){ 'y'.replace('y', o); } with o.toString() giving 16 MiB", "var big = 'x'.repeat(16 * 1024 * 1024), o = { toString: function () { return big; } };", "for (;;) { 'y'.replace('y', o); }"],
    ['for(;;){ [].concat(o); } with a spreadable {length: 3e6}', 'var o = { length: 3e6 }; o[Symbol.isConcatSpreadable] = true;', 'for (;;) { [].concat(o); }'],
    ['for(;;){ [].concat(u); } with a spreadable 4 MiB Uint8Array', 'var u = new Uint8Array(4 * 1024 * 1024); u[Symbol.isConcatSpreadable] = true;', 'for (;;) { [].concat(u); }'],
    ['for(;;){ Array.prototype.fill.call(p, 1); } through a Proxy whose length lies',
      "var c = 0, p = new Proxy(new Array(5e5).fill(0), { get: function (t, k) { if (k === 'length') return (c++ & 1) ? t.length : 0; return t[k]; } });",
      'for (;;) { Array.prototype.fill.call(p, 1); }'],
    ["for(;;){ s.replaceAll('a', r); } with a 200-char s and a 2,000-char $' replacement", "var s = 'a'.repeat(200), r = \"$'\".repeat(1000);", "for (;;) { s.replaceAll('a', r); }"],
    ["for(;;){ s.replaceAll('a', r); } with 2,040 chars each", "var s = 'a'.repeat(2040), r = 'x'.repeat(2040);", "for (;;) { s.replaceAll('a', r); }"],
    ["for(;;){ re[Symbol.replace]('y', big); } with a 16 MiB replacement", "var big = 'x'.repeat(16 * 1024 * 1024), re = /y/;", 'for (;;) { re[Symbol.replace](\'y\', big); }'],
    ["for(;;){ String.prototype.indexOf.call(a, 'b'); } with a.toString() giving 16 MiB", `var big = 'a'.repeat(16 * 1024 * 1024), ${LYING}`, "for (;;) { String.prototype.indexOf.call(a, 'b'); }"],
    ['for(;;){ String.prototype.toUpperCase.call(a); } with a.toString() giving 4 MiB', `var big = 'a'.repeat(4 * 1024 * 1024), ${LYING}`, 'for (;;) { String.prototype.toUpperCase.call(a); }'],
    ['for(;;){ JSON.parse(a); } with a.toString() giving a 4 MiB JSON string', `var big = '"' + 'a'.repeat(4 * 1024 * 1024) + '"', ${LYING}`, 'for (;;) { JSON.parse(a); }'],
    ["for(;;){ String.prototype.indexOf.call(a, 'b'); } with a[Symbol.toPrimitive]() giving 16 MiB",
      "var big = 'a'.repeat(16 * 1024 * 1024), a = [0]; a[Symbol.toPrimitive] = function () { return big; };",
      "for (;;) { String.prototype.indexOf.call(a, 'b'); }"],
  ];
  for (const [title, setup, body] of LOOPS) {
    it(`${title} is a hard fault within budget + 300 ms`, async () => {
      const hn = await makeRealm();
      expect(hn.realm.loadScript('big.js', setup).ok).toBe(true);
      const t = wallClock();
      const r = hn.handler(body);
      const ms = wallClock() - t;
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      expect(ms).toBeLessThanOrEqual(BUDGET + BOUND);
    });
  }

  // G2 DOS-4: the review measured these loops over large strings at 2.5-15 s against the 100 ms budget
  // (trim 4.9 s, parseFloat 4.1 s, encodeURIComponent 6.7 s, escape 6.9 s, Set.has 2.7 s, Map.get 2.5 s).
  // The guards cover accidental paths; operators on large strings stay E R19's residual.
  const G2_LOOPS = [
    ['for(;;){ s.trim(); } over 16 MiB of spaces', "var s = ' '.repeat(16 * 1024 * 1024) + '1';", 'for (;;) { s.trim(); }'],
    ['for(;;){ s.trimEnd(); } over 16 MiB of spaces', "var s = '1' + ' '.repeat(16 * 1024 * 1024);", 'for (;;) { s.trimEnd(); }'],
    ['for(;;){ parseFloat(s); } over 16 MiB of spaces', "var s = ' '.repeat(16 * 1024 * 1024) + '1';", 'for (;;) { parseFloat(s); }'],
    ['for(;;){ parseInt(s); } over 16 MiB of spaces', "var s = ' '.repeat(16 * 1024 * 1024) + '1';", 'for (;;) { parseInt(s); }'],
    ['for(;;){ encodeURIComponent(s); } over 8 MiB', "var s = '0'.repeat(8 * 1024 * 1024);", 'for (;;) { encodeURIComponent(s); }'],
    ['for(;;){ escape(s); } over 4 MiB', "var s = '0'.repeat(4 * 1024 * 1024);", 'for (;;) { escape(s); }'],
    ['for(;;){ st.has(s); } with a 16 MiB key', "var s = '0'.repeat(16 * 1024 * 1024), st = new Set();", 'for (;;) { st.has(s); }'],
    ['for(;;){ m.get(s); } with a 16 MiB key', "var s = '0'.repeat(16 * 1024 * 1024), m = new Map();", 'for (;;) { m.get(s); }'],
    // These two decode their operands into UTF-32 buffers (4 bytes a character), so 1 MiB: over 8 MiB one
    // call alone runs the heap out, a memory fault.
    ['for(;;){ s.localeCompare(t); } over two 1 MiB strings', "var s = '0'.repeat(1024 * 1024), t = s.slice(0, -1) + '1';", 'for (;;) { s.localeCompare(t); }'],
    ['for(;;){ s.normalize(); } over 1 MiB', "var s = 'e\\u0301'.repeat(512 * 1024);", 'for (;;) { s.normalize(); }'],
    ["for(;;){ ''.concat(s, s); } with an 8 MiB argument", "var s = '0'.repeat(8 * 1024 * 1024);", "for (;;) { ''.concat(s, s); }"],
    ['for(;;){ s.substring(1); } over 16 MiB', "var s = '0'.repeat(16 * 1024 * 1024);", 'for (;;) { s.substring(1); }'],
  ];
  for (const [title, setup, body] of G2_LOOPS) {
    it(`${title} is a hard fault within budget + 300 ms`, async () => {
      const hn = await makeRealm();
      expect(hn.realm.loadScript('big.js', setup).ok).toBe(true);
      const t = wallClock();
      const r = hn.handler(body);
      const ms = wallClock() - t;
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      expect(ms).toBeLessThanOrEqual(BUDGET + BOUND);
    });
  }

  it('the new guards trip themselves (the guard error, not only the interrupt), and small calls run natively', async () => {
    let seen;
    for (let attempt = 0; attempt < 3 && seen !== GUARD_MESSAGE; attempt++) {
      const hn = await makeRealm();
      expect(hn.realm.loadScript('big.js', "var s = '0'.repeat(1024 * 1024), st = new Set([s]);").ok).toBe(true);
      const r = hn.handler("seen = ''; for (;;) { try { st.has(s); } catch (e) { seen = e.message; } }");
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      seen = hn.realm.readGlobal('seen');
    }
    expect(seen).toBe(GUARD_MESSAGE);
    const hn = await makeRealm();
    expect(outOf(hn, `
      var m = new Map([['a', 1]]), st = new Set([1n, 'b']), o = {};
      m.set(o, 2); st.add(o);
      return [' x '.trim(), ' x'.trimStart(), 'x '.trimEnd(), 'e\\u0301'.normalize().length, 'a'.localeCompare('b'), 'abc'.slice(1), 'abc'.substring(1, 2),
        'abc'.substr(1, 1), 'abc'.at(-1), 'a'.concat('b', 1, null), parseFloat('1.5'), parseInt('ff', 16), encodeURIComponent('a b'), decodeURIComponent('a%20b'),
        encodeURI('a b'), decodeURI('a%20b'), escape('a b'), unescape('a%20b'), m.get('a'), m.get(o), m.has(o), m.delete('a'), st.has(1n), st.has(o), st.delete('b'),
        Number.parseFloat('2.5'), Number.parseInt('7')];`))
      .toEqual(['x', 'x', 'x', 1, -1, 'bc', 'b', 'b', 'c', 'ab1null', 1.5, 255, 'a%20b', 'a b', 'a%20b', 'a b', 'a%20b', 'a b', 1, 2, true, true, true, true, true, 2.5, 7]);
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
  });

  // A RegExp loop over a lying 16 MiB subject ended at ~100 ms before the fix as well (exec, test,
  // Symbol.search/split, anchored and sticky patterns all measured), so its timing cannot show the new
  // sizing. What does: with a short lying subject the guard now asks the host and throws its own error,
  // where before nothing asked and only the interrupt ended the loop (`seen` stayed ''). The replace
  // pattern is the same operand class (before the fix a lying pattern counted 1). Retries as in the
  // catch test below: the interrupt poll can land between the deadline and the next guard call.
  const CAUGHT = [
    ['for(;;){ /b/.test(a); } with a.toString() giving a RegExp subject', "var big = 'abc', " + LYING, '/b/.test(a);'],
    ["for(;;){ 'abc'.replace(a, 'x'); } with a.toString() giving the pattern", "var big = 'b', " + LYING, "'abc'.replace(a, 'x');"],
  ];
  for (const [title, setup, call] of CAUGHT) {
    it(`${title} is a hard fault within budget + 300 ms, tripped by the guard`, async () => {
      let seen;
      for (let attempt = 0; attempt < 3 && seen !== GUARD_MESSAGE; attempt++) {
        const hn = await makeRealm();
        expect(hn.realm.loadScript('lying.js', setup).ok).toBe(true);
        const t = wallClock();
        const r = hn.handler(`seen = ''; for (;;) { try { ${call} } catch (e) { seen = e.message; } }`);
        const ms = wallClock() - t;
        expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
        expect(ms).toBeLessThanOrEqual(BUDGET + BOUND);
        seen = hn.realm.readGlobal('seen');
      }
      expect(seen).toBe(GUARD_MESSAGE);
    });
  }

  it('typed arrays are sized by their length, and a DataView receiver is unsizable rather than an error', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, `
      var u = new Uint8Array([3, 1, 2]), dv = new DataView(new ArrayBuffer(4)), f = new Float64Array(5000);
      var viaCall; try { viaCall = Array.prototype.indexOf.call(dv, 1); } catch (e) { viaCall = e.name; }
      u.set([9], 2);
      return [u.join('-'), Array.prototype.join.call(u.slice().sort(), ''), u.indexOf(9), u.includes(1), u.toSorted().join(''),
        u.with(0, 7)[0], u.toReversed()[0], f.fill(0.5).lastIndexOf(0.5), viaCall, 'abc'.replace('b', 'XY'), 'aXa'.replaceAll('a', '-')];`))
      .toEqual(['3-1-9', '139', 2, true, '139', 7, 9, 4999, -1, 'aXYc', '-X-']);
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
  });

  // The guard and QuickJS's own interrupt poll read the same deadline. When a poll (measured at one per
  // ~40 ms, ~270 iterations of this loop) lands between the deadline and the next guard call, the
  // interrupt wins and the catch never runs. Measured 0 in 240 runs alone and about 1 in 20 after the
  // heavy loops above, so up to three fresh realms are tried, and every one must end in the hard fault.
  it('a skin that catches the guard error still ends in the hard fault', async () => {
    let seen;
    for (let attempt = 0; attempt < 3 && seen !== GUARD_MESSAGE; attempt++) {
      const hn = await makeRealm();
      const r = hn.handler("seen = ''; for (;;) { try { 'y'.repeat(1e5); } catch (e) { seen = e.message; } }");
      expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
      seen = hn.realm.readGlobal('seen');
    }
    expect(seen).toBe(GUARD_MESSAGE);
  });

  it('the wrappers are non-writable and non-configurable, and keep name, length and behaviour', async () => {
    const hn = await makeRealm();
    expect(hn.handler("String.prototype.indexOf = function () { return 'hijacked'; }; delete Array.prototype.join; JSON.parse = null;").ok).toBe(true);
    expect(outOf(hn, `
      var d = Object.getOwnPropertyDescriptor(String.prototype, 'indexOf');
      var r = Object.getOwnPropertyDescriptor(RegExp.prototype, Symbol.replace);
      var notCtor; try { new String.prototype.indexOf(); notCtor = false; } catch (e) { notCtor = e instanceof TypeError; }
      return [d.writable, d.configurable, r.writable, r.configurable,
        String.prototype.indexOf.name, String.prototype.indexOf.length, notCtor,
        'abc'.indexOf('c'), [3, 1, 2].sort().join(','), JSON.parse('{"a":1}').a, /b/.test('abc'), 'a-b'.split('-').length,
        'x'.repeat(3), 'ab'.replace(/b/g, 'c'), 'A'.toLowerCase(), [1, [2]].concat([3]).length, '5'.padStart(3, '0'), ['x', 'y'].join('+')];`))
      .toEqual([false, false, false, false, 'indexOf', 1, true, 2, '1,2,3', 1, true, 2, 'xxx', 'ac', 'a', 3, '005', 'x+y']);
    // The round-2 sizing rules on small calls, the unsizable ones (a spreadable non-array, an object
    // replacement) included: under budget each gives the native result.
    expect(outOf(hn, `
      var ta = new Uint8Array([1, 2]), al = { length: 2, 0: 'p', 1: 'q' };
      ta[Symbol.isConcatSpreadable] = true; al[Symbol.isConcatSpreadable] = true;
      return ['abc'.replace(/b/, 'c'), 'abc'.replace('b', function () { return 'X'; }), [1].concat([2], 3),
        'abc'.replace(/(b)/, '[$1]'), 'aXa'.replaceAll('a', '$&$&'), /b/[Symbol.replace]('abc', 'Z'), 'a1'.replace('1', 2),
        'ab'.replace('b', null), 'ab'.replace('b', { toString: function () { return 'T'; } }), [0].concat(ta, al).join(''),
        'a.b.c'.replaceAll('.', function (m, i) { return i; })];`))
      .toEqual(['acc', 'aXc', [1, 2, 3], 'a[b]c', 'aaXaa', 'aZc', 'a2', 'anull', 'aT', '012pq', 'a1b3c']);
    // G2.F1: an object operand a builtin stringifies is unsizable now; small, it still runs natively.
    expect(outOf(hn, `
      var lying = [0]; lying.toString = function () { return 'xyz'; };
      return [String.prototype.indexOf.call([1, 2], '2'), JSON.parse(['1']), /1/.test([1]), 'ab'.replace('b', [1]),
        'a1b'.replace([1], 'x'), 'a1a1'.replaceAll([1], '-'), String.prototype.toUpperCase.call(lying), 'b'.padStart.call(lying, 5, '.'),
        String.prototype.repeat.call(lying, 2), /y/.exec(lying)[0], /z/[Symbol.replace](lying, 'Z'), String.prototype.split.call(7.5, '.')];`))
      .toEqual([2, 1, true, 'a1', 'axb', 'a-a-', 'XYZ', '..xyz', 'xyzxyz', 'y', 'xyZ', ['7', '5']]);
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
  });

  it('the skin Proxy keeps the native semantics and is locked like the guards', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, `
      var p = new Proxy({ a: 1 }, { get: function (t, k) { return k === 'b' ? 2 : t[k]; } });
      var noNew; try { Proxy({}, {}); noNew = false; } catch (e) { noNew = e instanceof TypeError; }
      var r = Proxy.revocable([7], {}), before = r.proxy[0], isArr = Array.isArray(r.proxy);
      r.revoke();
      var revoked; try { r.proxy[0]; revoked = false; } catch (e) { revoked = e instanceof TypeError; }
      var fillRevoked; try { Array.prototype.fill.call(r.proxy, 1); fillRevoked = false; } catch (e) { fillRevoked = e instanceof TypeError; }
      var dp = Object.getOwnPropertyDescriptor(globalThis, 'Proxy'), dr = Object.getOwnPropertyDescriptor(Proxy, 'revocable');
      var small = new Proxy([3, 1, 2], {});
      return [p.a, p.b, noNew, before, isArr, revoked, fillRevoked, Array.isArray(new Proxy([], {})),
        Proxy.name, Proxy.length, 'prototype' in Proxy, typeof Proxy.revocable, Proxy.revocable.length,
        dp.writable, dp.configurable, dr.writable, dr.configurable,
        Array.prototype.fill.call(small, 0).length, [].concat(small).length, Array.prototype.slice.call(small, 1).length];`))
      .toEqual([1, 2, true, 7, true, true, true, true, 'Proxy', 2, false, 'function', 2, false, false, false, false, 3, 3, 2]);
    expect(hn.handler('Proxy = null; Proxy.revocable = null;').ok).toBe(true);
    expect(outOf(hn, 'return [typeof Proxy, typeof Proxy.revocable, Array.isArray(new Proxy([], {}))];')).toEqual(['function', 'function', true]);
    expect(hn.realm.health).toMatchObject({ soft: 0, hard: 0 });
  });

  it('every listed builtin is wrapped in the realm', async () => {
    const hn = await makeRealm();
    const targets = { string: 'String.prototype', array: 'Array.prototype', typedarray: 'Object.getPrototypeOf(Uint8Array.prototype)', json: 'JSON', regexp: 'RegExp.prototype',
      map: 'Map.prototype', set: 'Set.prototype', global: 'globalThis', number: 'Number' };
    // The global functions (and the Number statics that are the same functions) keep their writable,
    // configurable slots; every other wrapper is locked. A wrapper is never native code.
    const unlocked = new Set(['global', 'number']);
    /** @type {string[]} */
    const checks = [];
    for (const [group, list] of Object.entries(GUARDED_BUILTINS)) {
      expect(Object.keys(targets)).toContain(group);
      for (const [key] of list) {
        const target = targets[/** @type {keyof typeof targets} */ (group)];
        const prop = key.startsWith('@') ? `Symbol.${key.slice(1)}` : JSON.stringify(key);
        const slot = unlocked.has(group) ? 'd.writable && d.configurable' : '!d.writable && !d.configurable';
        checks.push(`(function () { var d = Object.getOwnPropertyDescriptor(${target}, ${prop}); return d && ${slot} && !/\\[native code\\]/.test(Function.prototype.toString.call(d.value)) ? 1 : ${JSON.stringify(`${group}.${key}`)}; })()`);
      }
    }
    const result = outOf(hn, `return [${checks.join(', ')}].filter(function (x) { return x !== 1; });`);
    expect(result).toEqual([]);
    expect(GUARD_MIN_SIZE).toBe(4096);
  });

  it('aliases keep one wrapper, and the unlocked globals can still be declared by a skin', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [String.prototype.trimLeft === String.prototype.trimStart, String.prototype.trimRight === String.prototype.trimEnd, Number.parseFloat === parseFloat, Number.parseInt === parseInt]'))
      .toEqual([true, true, true, true]);
    expect(hn.realm.loadScript('own.js', 'function escape(s) { return "own:" + s; } var parseFloat = function () { return 7; };').ok).toBe(true);
    expect(outOf(hn, "return [escape('x'), parseFloat('1.5'), Number.parseFloat('1.5')]")).toEqual(['own:x', 7, 1.5]);
  });

  it('large calls within budget run normally', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, "var big = 'z'.repeat(1e6); return [big.length, big.indexOf('q'), big.toUpperCase().charAt(5)]")).toEqual([1e6, -1, 'Z']);
    expect(outOf(hn, "var u = new Uint8Array(1e6).fill(7), big = 'z'.repeat(1e6); return [u.indexOf(7), u.toSorted()[999999], 'y'.replace('y', big).length]")).toEqual([0, 7, 1e6]);
    expect(hn.realm.health.hard).toBe(0);
  });
});
