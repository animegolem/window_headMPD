// @ts-check
// WAVES 5F.7 (spec 2.3, 2.4, 5.6): an event-handler attribute is not a readable property in WMP's object
// model, so the firing element's scope never answers for one. Inside `with(__IDS){with(this){...}}` a
// bare `OnClose()` reaches the script's function, not the VIEW's own `onclose` text (which made every
// such call a `TypeError: not a function`, and lost Headspace's effect-preset save on close). Property
// reads (`left`, `value`) and methods (`close()`, `click()`) still resolve on the element, and an
// explicit `this.onclose` still crosses to the host.

import { describe, expect, it } from 'vitest';
import { SCHEMA, classMembers } from '../../../src/engine/model/schema.js';
import { CLASS_MEMBERS, STANDARD_IDS, makeRealm, outOf, standardObjects } from './fake-host.js';
import { open, skinZip, trace, wmsOf } from '../runtime/helpers.js';

/** The fake host's class lists plus the given members, lowercased as the schema sends them. @param {Record<string, string[]>} extra */
const withMembers = (extra) => {
  const m = new Map(CLASS_MEMBERS);
  for (const [cls, list] of Object.entries(extra)) m.set(cls, [...(m.get(cls) ?? []), ...list]);
  return m;
};

const GLOBALS = `
function OnClose() { return 'global OnClose'; }
function OnLoad() { return 'global OnLoad'; }
function onMouseDown() { return 'global onMouseDown'; }
function playStateChange(s) { return 'global playStateChange ' + s; }
function OnPlayStateChange(s) { return 'global OnPlayStateChange ' + s; }`;

describe('the element scope leaves out event-handler attributes', () => {
  it('a bare OnClose() or OnLoad() reaches the script function, not the onclose/onload attribute', async () => {
    const objects = standardObjects();
    const button = objects.objects.get(2);
    button?.props.set('onclose', 'OnClose();');
    button?.props.set('onload', 'OnLoad();');
    const hn = await makeRealm({ objects, classMembers: withMembers({ 'element.button': ['onclose', 'onload', 'onmousedown', 'onclick'] }) });
    expect(hn.realm.loadScript('a.js', GLOBALS).ok).toBe(true);
    hn.objects.log.length = 0;
    expect(outOf(hn, 'return [OnClose(), OnLoad(), onMouseDown(), typeof ONCLOSE, typeof onload]', { event: 'onclose' }))
      .toEqual(['global OnClose', 'global OnLoad', 'global onMouseDown', 'undefined', 'undefined']);
    // Nothing was read from the element to resolve those names.
    expect(hn.objects.log.filter(([, h]) => h === 2)).toEqual([]);
  });

  it('keeps property reads and element methods resolving on the element', async () => {
    const hn = await makeRealm({ classMembers: withMembers({ 'element.button': ['onclose', 'onclick'], 'element.slider': ['onpositionchange', 'value_onchange'] }) });
    expect(outOf(hn, 'return [top, Left, down, ToolTip, MoveTo(1, 2, 3)]', { el: 2 })).toEqual([129, 0, false, 'tip', 'moved:1,2,3']);
    expect(outOf(hn, 'return [value, Max, typeof onPositionChange, typeof value_onchange]', { el: 1 })).toEqual([50, 100, 'undefined', 'undefined']);
  });

  it('an explicit this.onclose still crosses to the host, read and write', async () => {
    const objects = standardObjects();
    objects.objects.get(2)?.props.set('onclick', 'go();');
    const hn = await makeRealm({ objects, classMembers: withMembers({ 'element.button': ['onclick'] }) });
    hn.objects.log.length = 0;
    expect(outOf(hn, "var was = this.onClick; sEqEar.OnClick = 'other();'; return [was, this.onclick]", { el: 2 })).toEqual(['go();', 'other();']);
    expect(hn.objects.log.map(([op, h, key]) => [op, h, key])).toEqual([['get', 2, 'onclick'], ['set', 2, 'onclick'], ['get', 2, 'onclick']]);
  });

  it('a bare event name that is neither a global nor an id is a ReferenceError, as in WMP', async () => {
    const hn = await makeRealm({ classMembers: withMembers({ 'element.button': ['onclose'] }) });
    const r = hn.handler('OnClose();', { el: 2 });
    expect(r).toMatchObject({ ok: false, kind: 'soft' });
    expect(r.ok === false && r.reason).toMatch(/ReferenceError/);
  });

  it('on the PLAYER element the bare event name is a handler too (spec 2.3); elsewhere a bare twin is a method', async () => {
    const objects = standardObjects()
      .add(20, 'element.player', { props: { playstate: 3, status: 'Playing', error: 'element error' } })
      .add(21, 'view', { props: { width: 10 }, methods: { close: () => 'view closed' } })
      .add(22, 'element.buttongroup', { methods: { click: () => 'group clicked' } });
    const classes = withMembers({
      'element.player': ['onplaystatechange', 'playstatechange', 'onerror', 'error'],
      view: ['onclose'],
      'element.buttongroup': ['click', 'onclick'],
    });
    const ids = [...STANDARD_IDS, { id: 'p', handle: 20, className: 'element.player' }, { id: 'v', handle: 21, className: 'view' },
      { id: 'g', handle: 22, className: 'element.buttongroup' }];
    const hn = await makeRealm({ objects, ids, classMembers: classes });
    expect(hn.realm.loadScript('a.js', GLOBALS).ok).toBe(true);
    expect(outOf(hn, 'return [playStateChange(PlayState), OnPlayStateChange(playState), typeof error, Status]', { el: 20 }))
      .toEqual(['global playStateChange 3', 'global OnPlayStateChange 3', 'undefined', 'Playing']);
    expect(outOf(hn, 'return [Close(), OnClose()]', { el: 21 })).toEqual(['view closed', 'global OnClose']);
    expect(outOf(hn, 'return [click(), Click()]', { el: 22 })).toEqual(['group clicked', 'group clicked']);
  });

  it('answers __proto__ and constructor from the member set alone, never from a prototype', async () => {
    const classes = withMembers({
      'element.text': ['__proto__', 'constructor', 'on__proto__', 'onconstructor'],
      'element.player': ['constructor', 'onconstructor', 'hasownproperty'],
    });
    const objects = standardObjects().add(20, 'element.player', {});
    const ids = [...STANDARD_IDS, { id: 'p', handle: 20, className: 'element.player' }];
    const hn = await makeRealm({ objects, ids, classMembers: classes });
    const probe = "return ['__proto__', 'constructor', 'on__proto__', 'onconstructor', 'hasOwnProperty', 'toString', 'valueOf']" +
      '.map(function (k) { return k in this; }, this)';
    expect(outOf(hn, probe, { el: 3 })).toEqual([true, true, false, false, false, false, false]);
    expect(outOf(hn, probe, { el: 20 })).toEqual([false, false, false, false, true, false, false]);
    expect(outOf(hn, probe, { el: 2 })).toEqual([false, false, false, false, false, false, false]);
  });
});

describe('with the real schema', () => {
  // The prelude decides by name ('on' + event everywhere, and the bare name on the PLAYER element) what
  // the schema records as `kind: 'event'`. This pins the two together for every class.
  it('a class scope answers exactly for its members that are not events, in any case', async () => {
    const classes = [...SCHEMA.keys()];
    const objects = standardObjects();
    const ids = classes.map((cls, i) => ({ id: `c${i}`, handle: 300 + i, className: cls }));
    for (const r of ids) objects.add(r.handle, r.className);
    const hn = await makeRealm({ objects, ids, classMembers: classMembers() });
    let events = 0;
    for (const [i, cls] of classes.entries()) {
      const members = /** @type {import('../../../src/engine/contracts').ClassSchema} */ (SCHEMA.get(cls));
      const names = [...members.keys()];
      const expected = names.filter((k) => members.get(k)?.kind !== 'event');
      events += names.length - expected.length;
      const body = `var names = ${JSON.stringify(names)}, r = [];
        for (var i = 0; i < names.length; i++) {
          var k = names[i], K = k.charAt(0).toUpperCase() + k.slice(1);
          if (k in this) r.push(k);
          if ((k in this) !== (K in this)) r.push('case:' + k);
        }
        return r;`;
      expect([cls, outOf(hn, body, { el: 300 + i })]).toEqual([cls, expected]);
    }
    // The table has events (the VIEW's onclose, the PLAYER's bare playstatechange) for this to bite on.
    expect(events).toBeGreaterThan(100);
    expect(SCHEMA.get('view')?.get('onclose')?.kind).toBe('event');
    expect(SCHEMA.get('view')?.get('close')?.kind).toBe('method');
    expect(SCHEMA.get('element.player')?.get('playstatechange')?.kind).toBe('event');
  });
});

describe('in a mounted view', () => {
  it('a VIEW onload="OnLoad();" and onclose="OnClose();" call the script functions, with no soft fault', async () => {
    const wms = wmsOf('<text id="t" left="0" top="0" width="5" height="5" value="x"/>',
      'id="v" width="200" height="100" backgroundColor="none" titleBar="false" onclose="OnClose();" onload="OnLoad();"');
    const js = 'function OnClose() { theme.logString("closed " + t.value); }\nfunction OnLoad() { theme.logString("loaded " + view.width); }';
    const { host, skin, runtime } = await open(skinZip({ wms, js }));
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: loaded 200']);
    runtime.dispose();
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: loaded 200', 'skin: closed x']);
    expect(runtime.diagnostics().filter((d) => /fault/.test(d.code))).toEqual([]);
    expect(skin.ledger().filter((e) => e.kind === 'soft-fault')).toEqual([]);
  });

  it('a PLAYER PlayStateChange that calls playStateChange() or OnPlayStateChange() reaches the script', async () => {
    const wms = wmsOf('<player id="p" PlayStateChange="playStateChange(NewState); OnPlayStateChange(NewState);"/>');
    const js = 'function playStateChange(s) { theme.logString("bare " + s); }\nfunction OnPlayStateChange(s) { theme.logString("on " + s); }';
    const { host, skin, runtime } = await open(skinZip({ wms, js }), { hostOptions: { media: 'stoppedQueue5' } });
    host.media.emit({ playState: 'play', elapsed: 0, duration: 100, song: host.media.queue()[0] });
    await runtime.settled();
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: bare 3', 'skin: on 3']);
    expect(skin.ledger().filter((e) => e.kind === 'soft-fault')).toEqual([]);
  });
});
