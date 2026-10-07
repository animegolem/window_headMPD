// @ts-check
// The prelude's other duties (ENGINE D1 "Constants", "Determinism", "Prelude internals"): the #132
// constants before any script, the locked internals, determinism hooks under a test seed, and the
// wmploc libraries a loader installs with `librarySource`.

import { describe, expect, it } from 'vitest';
import { librarySource } from '../../../src/engine/realm/realm.js';
import { scriptLibrary } from '../../../src/engine/realm/wmploc.js';
import { makeRealm, outOf } from './fake-host.js';

describe('#132 constants', () => {
  it('are installed before any script, and a skin may redeclare them', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [osUndefined, osMediaOpen, osMediaWaiting, osOpeningUnknownURL, psUndefined, psPlaying, psReconnecting, WMPPlaylistChangeEventTypes[1], WMPPlaylistChangeEventTypes.length]'))
      .toEqual([0, 13, 20, 21, 0, 3, 11, 'Clear', 10]);
    expect(hn.realm.loadScript('a.js', 'var osMediaOpen = 99; function psPlaying() { return 1; }').ok).toBe(true);
    expect(outOf(hn, 'return [osMediaOpen, typeof psPlaying]')).toEqual([99, 'function']);
  });
});

describe('locked internals', () => {
  it('__IDS, __wmp_badAssign and eval cannot be replaced', async () => {
    const hn = await makeRealm();
    expect(hn.handler('__IDS = 1; __wmp_badAssign = 2; eval = 3; delete globalThis.__IDS;').ok).toBe(true);
    expect(outOf(hn, "return [typeof __IDS, typeof __wmp_badAssign, eval('1 + 1'), Object.getOwnPropertyDescriptor(globalThis, '__IDS').configurable]")).toEqual(['object', 'function', 2, false]);
    // A script that declares a function named eval cannot load: the binding is locked.
    expect(hn.realm.loadScript('e.js', 'function eval() {}')).toMatchObject({ ok: false, kind: 'soft' });
    expect(outOf(hn, "return eval('volume.value')")).toBe(50);
  });

  // G2 F4: the handlers inherited from Object.prototype, so a skin that planted trap functions there
  // received each handler as `this`, swapped its has/get, and made `eval` (the loader's and the jscript:
  // evaluator's) resolve to its own function.
  it('a skin cannot capture or rewire a prelude proxy handler, nor plant a property on a proxy target', async () => {
    const hn = await makeRealm();
    const TRAPS = ['getPrototypeOf', 'setPrototypeOf', 'isExtensible', 'preventExtensions', 'getOwnPropertyDescriptor', 'defineProperty',
      'has', 'get', 'set', 'deleteProperty', 'ownKeys', 'apply', 'construct'];
    expect(outOf(hn, `
      var got = [], names = ${JSON.stringify(TRAPS)};
      try {
        names.forEach(function (n) { Object.prototype[n] = function () { got.push(this); return undefined; }; });
        [__IDS, sEqEar, player, volume].forEach(function (o) {
          try { Object.getPrototypeOf(o); Object.isExtensible(o); Object.keys(o); Object.getOwnPropertyDescriptor(o, 'q'); delete o.q; 'q' in o; } catch (e) {}
        });
      } finally {
        names.forEach(function (n) { delete Object.prototype[n]; });
      }
      var planted; try { Object.defineProperty(__IDS, 'eval', { value: 1, configurable: false }); planted = true; } catch (e) { planted = e.name; }
      var proto; try { Object.setPrototypeOf(sEqEar, {}); proto = true; } catch (e) { proto = e.name; }
      return [got.length, planted, proto];`)).toEqual([0, 'TypeError', 'TypeError']);
    expect(hn.realm.loadScript('later.js', 'var laterLoaded = 1;').ok).toBe(true);
    expect(hn.realm.readGlobal('laterLoaded')).toBe(1);
    expect(hn.realm.evalExpression(2, 'left', '1 + 1')).toEqual({ ok: true, value: 2 });
  });

  it('ids named eval or __wmp* are reserved, with a diagnostic', async () => {
    const hn = await makeRealm({ ids: [{ id: 'eval', handle: 1, className: 'element.slider' }, { id: '__wmp_src', handle: 2, className: 'element.button' }, { id: 'Ice', handle: 3, className: 'element.text' }] });
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-reserved').map((d) => d.elementId)).toEqual(['eval', '__wmp_src']);
    expect(hn.realm.evalExpression(3, 'left', 'Ice.value + 1;')).toEqual({ ok: true, value: 'ice1' });
    expect(outOf(hn, "return typeof eval", { el: 3 })).toBe('function');
  });
});

describe('determinism hooks', () => {
  it('under a test seed, Date and Math.random follow the engine clock and the seed', async () => {
    const a = await makeRealm({ options: { testSeed: 'f9671f06' } });
    a.clock.advance(1234);
    expect(outOf(a, 'return [Date.now(), new Date().getTime(), new Date(0).getTime(), new Date(2001, 0, 1).getFullYear(), Date() === new Date(1234).toString(), new Date() instanceof Date]'))
      .toEqual([1234, 1234, 0, 2001, true, true]);
    const seq = (/** @type {Awaited<ReturnType<typeof makeRealm>>} */ hn) => outOf(hn, 'var r = []; for (var i = 0; i < 5; i++) r.push(Math.random()); return r');
    const first = seq(a);
    const b = await makeRealm({ options: { testSeed: 'f9671f06' } });
    const c = await makeRealm({ options: { testSeed: 'another-sha' } });
    expect(seq(b)).toEqual(first);
    expect(seq(c)).not.toEqual(first);
    expect(first.every((/** @type {number} */ x) => x >= 0 && x < 1)).toBe(true);
  });

  // G2 S6: Date.prototype.constructor was still the real Date, so the wall clock reached a golden run.
  it('under a test seed, the Date reached through a date instance is the engine clock too', async () => {
    const a = await makeRealm({ options: { testSeed: 'f9671f06' } });
    a.clock.advance(4321);
    expect(outOf(a, 'return [new (new Date(0).constructor)().getTime(), Date.prototype.constructor === Date, new Date(0).constructor === Date, Date.prototype.constructor() === Date()]'))
      .toEqual([4321, true, true, true]);
  });

  it('without a seed, Date is the real clock', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return Date.now()')).toBeGreaterThan(1.7e12);
  });
});

describe('wmploc libraries through librarySource', () => {
  it('#169 sprintf and #134 constants load as scripts', async () => {
    const hn = await makeRealm();
    const sprintf = scriptLibrary('res://wmploc.dll/RT_TEXT/#169');
    const fonts = scriptLibrary('res://wmploc/RT_TEXT/#134');
    expect(sprintf && fonts).toBeTruthy();
    if (!sprintf || !fonts) return;
    expect(hn.realm.loadScript('res://wmploc.dll/RT_TEXT/#169', librarySource(sprintf)).ok).toBe(true);
    expect(hn.realm.loadScript('res://wmploc/RT_TEXT/#134', librarySource(fonts)).ok).toBe(true);
    expect(outOf(hn, "return [sprintf('%1 / %2', ['a', 'b']), ''.sprintf('%s!', 'hi'), g_kSMALL_FONTSIZE, g_kMEDIUM_FONTSIZE]")).toEqual(['a / b', 'hi!', 8, 9]);
  });
});
