// @ts-check
// W2.2 acceptance items 1 to 3 (ENGINE D1 "Scope chain"): precedence element > id > script global >
// host global, ReferenceError for undeclared names, `this`, PLAYER parameters, `jscript:` values,
// handler labels, `eval` through ids, chained assignment.

import { describe, expect, it } from 'vitest';
import { REALM_CAPS } from '../../../src/engine/realm/realm.js';
import { FakeObjects, HOST_GLOBALS, STANDARD_IDS, makeRealm, outOf, standardObjects } from './fake-host.js';

describe('item 1: precedence', () => {
  it('puts the element first: a member beats an id of the same name', async () => {
    const objects = standardObjects().add(6, 'element.text', { props: { value: 'id-named-value' } });
    const hn = await makeRealm({ objects, ids: [...STANDARD_IDS, { id: 'value', handle: 6, className: 'element.text' }] });
    // On the slider `value` is its own member; on the button (no `value` member) it is the id.
    expect(outOf(hn, 'return value', { el: 1 })).toBe(50);
    expect(outOf(hn, 'return [typeof value, value.value]', { el: 2 })).toEqual(['object', 'id-named-value']);
  });

  it('resolves members case-insensitively and lowercases the key before it crosses', async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    expect(outOf(hn, 'return [top, Top, TOP, Down, VISIBLE, MoveTo(1, 2, 3)]', { el: 2 })).toEqual([129, 129, 129, false, true, 'moved:1,2,3']);
    expect(hn.objects.log.every(([, , key]) => key === key.toLowerCase())).toBe(true);
  });

  it('reaches ids exactly and by case variant (Volume reaches id volume), one cached proxy per id', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [Volume.value, VOLUME === volume, sEqEar === SEQEAR, ice === Ice, volume === sEqEar]')).toEqual([50, true, true, true, false]);
  });

  it('lets a skin function with the exact case-variant name beat the case-variant route to an id', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return typeof Volume')).toBe('object');
    expect(hn.realm.loadScript('a.js', "function Volume() { return 'script'; }").ok).toBe(true);
    expect(outOf(hn, 'return [typeof Volume, Volume(), typeof volume]')).toEqual(['function', 'script', 'object']);
  });

  it('a skin function volume() beats an id declared as Volume', async () => {
    const objects = standardObjects();
    const ids = STANDARD_IDS.map((r) => (r.id === 'volume' ? { ...r, id: 'Volume' } : r));
    const hn = await makeRealm({ objects, ids });
    expect(outOf(hn, 'return [typeof volume, volume.value]')).toEqual(['object', 50]);
    expect(hn.realm.loadScript('a.js', "function volume() { return 'fn'; }").ok).toBe(true);
    expect(outOf(hn, 'return [typeof volume, volume(), Volume.value]')).toEqual(['function', 'fn', 50]);
  });

  it('id="player" loses to the host global player, with a diagnostic; a case variant such as View stays an id', async () => {
    const objects = standardObjects().add(9, 'element.text', { props: { value: 'shadow' } });
    const hn = await makeRealm({
      objects,
      ids: [...STANDARD_IDS, { id: 'player', handle: 9, className: 'element.text' }, { id: 'View', handle: 9, className: 'element.text' }],
    });
    expect(outOf(hn, 'return [player.status, View.value, view.width]')).toEqual(['Playing', 'shadow', 760]);
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-shadowed').map((d) => d.elementId)).toEqual(['player']);
  });

  it('a skin var view = 1 replaces the host global (script globals before host globals)', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [typeof view, view.width]')).toEqual(['object', 760]);
    expect(hn.realm.loadScript('a.js', "var view = 1; function theme() { return 'skin theme'; } function event() { return 'skin event'; }").ok).toBe(true);
    expect(outOf(hn, 'return [view, theme(), event()]')).toEqual([1, 'skin theme', 'skin event']);
  });

  it('a top-level var named exactly like an id writes through to the id (where it goes nowhere) and is diagnosed', async () => {
    const hn = await makeRealm();
    hn.objects.log.length = 0;
    expect(hn.realm.loadScript('a.js', 'var volume = 5; var plain = 6; function sEqEar() { return 1; }').ok).toBe(true);
    expect(outOf(hn, 'return [typeof volume, volume.value, plain, typeof sEqEar]')).toEqual(['object', 50, 6, 'object']);
    const collisions = hn.log.diags.filter((d) => d.code === 'script-id-collision');
    expect(collisions.map((d) => d.elementId).sort()).toEqual(['sEqEar', 'volume']);
    expect(collisions.every((d) => d.file === 'a.js')).toBe(true);
    // The write reached the id table, not the element.
    expect(hn.objects.log.filter(([op]) => op === 'set')).toEqual([]);
  });

  it('an assignment to a bare id inside a handler is diagnosed once and goes nowhere', async () => {
    const hn = await makeRealm();
    expect(hn.handler('Ice = 3; Ice = 4;').ok).toBe(true);
    expect(outOf(hn, 'return Ice.value')).toBe('ice');
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-write').map((d) => d.elementId)).toEqual(['Ice']);
  });

  // G2 DOS-7 / F7: __IDS is readable, and its set trap used to report every new key, ids or not, so a
  // loop could push millions of diagnostics into the host log.
  it('only real ids are reported, once per id whatever its case, and the host caps the stream at 64', async () => {
    const hn = await makeRealm();
    expect(hn.handler("for (var i = 0; i < 1000; i++) __IDS['not_an_id_' + i] = 1; ICE = 1; ice = 2; iCe = 3; __IDS.VOLUME = 4;").ok).toBe(true);
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-write').map((d) => d.elementId)).toEqual(['ICE', 'VOLUME']);

    const objects = new FakeObjects();
    for (const h of Object.values(HOST_GLOBALS)) objects.add(h, 'player');
    const ids = Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, handle: 1000 + i, className: 'element.text' }));
    for (const r of ids) objects.add(r.handle, 'element.text', { props: { value: r.id } });
    const many = await makeRealm({ objects, ids });
    expect(many.handler("for (var i = 0; i < 100; i++) eval('id' + i + ' = 1');", { el: 1000 }).ok).toBe(true);
    expect(many.log.diags.filter((d) => d.code === 'realm-id-write')).toHaveLength(REALM_CAPS.maxIdWriteDiags);
    expect(many.log.diags.filter((d) => d.code === 'realm-id-write-capped')).toHaveLength(1);
  });

  it('every other realm diagnostic stream is capped at 64 per view too', async () => {
    const hn = await makeRealm();
    for (let i = 0; i < 100; i++) expect(hn.handler(`throw new Error('distinct ${i}');`).ok).toBe(false);
    expect(hn.realm.health.soft).toBe(100);
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault')).toHaveLength(REALM_CAPS.maxDiagsPerStream);
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault-capped')).toHaveLength(1);
  });

  // G2 S3: a write to an id while a script loads used to vanish with no diagnostic at all, and silenced
  // that id for the rest of the realm.
  it('an id written while a script file loads is reported as script-id-write; a declared one only as a collision', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('a.js', 'function f() { sEqEar = 3; } f(); volume = 5; Volume = 6;').ok).toBe(true);
    expect(hn.log.diags.filter((d) => d.code === 'script-id-write').map((d) => [d.elementId, d.file])).toEqual([['sEqEar', 'a.js'], ['volume', 'a.js']]);
    expect(hn.realm.loadScript('b.js', 'var Ice = 1;').ok).toBe(true);
    expect(hn.log.diags.filter((d) => d.code === 'script-id-collision').map((d) => d.elementId)).toEqual(['Ice']);
    expect(hn.log.diags.filter((d) => d.code === 'script-id-write')).toHaveLength(2);
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-write')).toEqual([]);
  });

  it('leftover Promise jobs run before a script file loads, not as part of it', async () => {
    const hn = await makeRealm();
    expect(hn.handler('n = 0; (function f() { n++; if (n === 1500) Ice = 9; Promise.resolve().then(f); })();')).toMatchObject({ ok: false, reason: 'more than 1000 pending jobs' });
    expect(hn.realm.loadScript('a.js', 'var z = 1;').ok).toBe(true);
    expect(hn.realm.readGlobal('z')).toBe(1);
    expect(hn.log.diags.filter((d) => d.code === 'realm-id-write').map((d) => d.elementId)).toEqual(['Ice']);
    expect(hn.log.diags.filter((d) => d.code === 'script-id-write')).toEqual([]);
    expect(hn.log.diags.filter((d) => d.code === 'realm-hard-fault').map((d) => d.detail)).toEqual(['test/view jobs: more than 1000 pending jobs']);
  });

  it('falls through to script globals and built-ins for every other name', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('a.js', 'var counter = 3;').ok).toBe(true);
    expect(outOf(hn, 'return [counter, Math.abs(-2), typeof JSON, typeof Date, osMediaOpen, psPlaying]')).toEqual([3, 2, 'object', 'function', 13, 3]);
  });

  it('treats ids named __proto__ and constructor as ordinary ids, and absent ones resolve to nothing', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [__proto__.value, constructor.value]')).toEqual(['proto-id', 'ctor-id']);
    const bare = await makeRealm({ ids: [{ id: 'volume', handle: 1, className: 'element.slider' }] });
    // Without such ids, the names are not answered by the id table: `constructor` is the global's own.
    expect(outOf(bare, "return [typeof constructor, constructor === Object, typeof __proto__, 'toString' in volume, 'constructor' in volume]")).toEqual(['function', true, 'object', false, false]);
  });

  it('answers has() only for members of the element class, so non-members fall through', async () => {
    const hn = await makeRealm();
    // `min` is a slider member, not a button member: on the button it is not in scope.
    expect(outOf(hn, "return ['min' in sEqEar, 'min' in volume, 'MIN' in volume, 'top' in sEqEar]")).toEqual([false, true, true, true]);
    const r = hn.handler('min', { el: 2 });
    expect(r).toMatchObject({ ok: false, kind: 'soft' });
    expect(!r.ok && r.reason).toMatch(/ReferenceError/);
  });

  it('a class-member table keyed __proto__ or constructor is just a key', async () => {
    const classMembers = new Map([['element.text', ['value', '__proto__', 'constructor']], ['player', []]]);
    // JSON.parse, because an object literal's `__proto__:` would set the prototype instead of a key.
    const objects = new FakeObjects().add(3, 'element.text', { props: JSON.parse('{"value": "v", "__proto__": "own-proto", "constructor": "own-ctor"}') });
    for (const h of Object.values(HOST_GLOBALS)) objects.add(h, 'player');
    const hn = await makeRealm({ objects, classMembers, ids: [{ id: 'Ice', handle: 3, className: 'element.text' }] });
    expect(outOf(hn, 'return [Ice.value, Ice.__proto__, Ice.constructor]', { el: 3 })).toEqual(['v', 'own-proto', 'own-ctor']);
  });
});

describe('item 2: undeclared names throw ReferenceError, as a soft fault', () => {
  it('an undeclared call and an undeclared bare read each abort only their handler', async () => {
    const hn = await makeRealm();
    const call = hn.handler('undefinedFn()');
    expect(call).toMatchObject({ ok: false, kind: 'soft', site: 'handler 2.onclick' });
    expect(!call.ok && call.reason).toMatch(/^ReferenceError: .*undefinedFn/);
    const read = hn.handler('var typo = nope + 1; Ice.value = typo;');
    expect(read).toMatchObject({ ok: false, kind: 'soft' });
    expect(!read.ok && read.reason).toMatch(/^ReferenceError: .*nope/);
    expect(hn.objects.prop(3, 'value')).toBe('ice');                 // nothing after the throw ran
    expect(hn.handler('Ice.value = "next";').ok).toBe(true);        // the next handler runs
    expect(hn.objects.prop(3, 'value')).toBe('next');
    expect(hn.realm.health).toMatchObject({ soft: 2, hard: 0, unloaded: false });
  });

  it("typeof an undeclared name is 'undefined'", async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [typeof nope, typeof Nope]')).toEqual(['undefined', 'undefined']);
  });

  it('logs a soft fault once per (site, reason) but counts every one', async () => {
    const hn = await makeRealm();
    for (let i = 0; i < 3; i++) expect(hn.handler('undefinedFn()').ok).toBe(false);
    expect(hn.realm.health.soft).toBe(3);
    expect(hn.log.diags.filter((d) => d.code === 'realm-soft-fault')).toHaveLength(1);
  });

  it('keeps case-variant calls of skin functions throwing, as WMP does', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('a.js', 'function ToggleEq() { return 1; }').ok).toBe(true);
    const r = hn.handler('toggleeq()');
    expect(!r.ok && r.reason).toMatch(/^ReferenceError/);
  });
});

describe('item 3: this, PLAYER parameters, jscript:, labels, eval, chained assignment', () => {
  it('this is the element proxy', async () => {
    const hn = await makeRealm();
    expect(outOf(hn, 'return [this === sEqEar, this.top, this.moveTo(4, 5, 6)]')).toEqual([true, 129, 'moved:4,5,6']);
    expect(outOf(hn, 'return this === volume', { el: 1 })).toBe(true);
  });

  it('PLAYER event parameters are visible in exact case only', async () => {
    const hn = await makeRealm();
    const site = { event: 'playStateChange', source: 'out = NewState * 10;', params: ['NewState'], line: 3 };
    expect(hn.realm.runHandler(HOST_GLOBALS.player, site, { params: { NewState: 3 } }).ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe(30);
    const lower = hn.realm.runHandler(HOST_GLOBALS.player, { ...site, source: 'out = newstate;' }, { params: { NewState: 3 } });
    expect(!lower.ok && lower.reason).toMatch(/^ReferenceError: .*newstate/);
    // `this` of a handler on the player is the player object, so its members are in scope.
    expect(hn.realm.runHandler(HOST_GLOBALS.player, { ...site, source: 'out = status + ":" + ModeName + ":" + NewValue;', params: ['ModeName', 'NewValue'] },
      { params: { ModeName: 'shuffle', NewValue: true } }).ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe('Playing:shuffle:true');
  });

  it('reads parameter values from own properties only', async () => {
    const hn = await makeRealm({ ids: [{ id: 'volume', handle: 1, className: 'element.slider' }] });
    const site = { event: 'scriptCommand', source: 'out = typeof constructor + ":" + typeof toString;', params: ['constructor', 'toString'], line: 1 };
    expect(hn.realm.runHandler(HOST_GLOBALS.player, site, { params: {} }).ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe('undefined:undefined');
  });

  it('a jscript: value with a trailing ; returns its value, and statement forms work', async () => {
    const hn = await makeRealm();
    expect(hn.realm.evalExpression(2, 'top', 'sEqEar.top + 1;')).toEqual({ ok: true, value: 130 });
    expect(hn.realm.evalExpression(2, 'left', 'top - 29')).toEqual({ ok: true, value: 100 });       // `top` is the element's own
    expect(hn.realm.evalExpression(1, 'left', 'if (value > 10) 7; else 8;')).toEqual({ ok: true, value: 7 });
    expect(hn.realm.evalExpression(1, 'left', 'view.width - this.width;')).toEqual({ ok: true, value: 670 });
    expect(hn.realm.evalExpression(1, 'tooltip', 'volume')).toEqual({ ok: true, value: { __h: 1 } });
    const bad = hn.realm.evalExpression(1, 'left', 'nope + 1');
    expect(bad).toMatchObject({ ok: false, kind: 'soft', site: 'expr 1.left' });
  });

  it('a handler starting jscript: compiles as a label; a label that breaks compilation is stripped once', async () => {
    const hn = await makeRealm();
    expect(hn.handler('jscript:out = 1;').ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe(1);
    expect(hn.handler('wmpprop:out = 2;\n// trailing comment').ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe(2);
    // A labelled lexical declaration is a syntax error as written; without the label it compiles.
    expect(hn.handler('JScript: let q = 3; out = q;').ok).toBe(true);
    expect(hn.realm.readGlobal('out')).toBe(3);
  });

  it('a handler that does not compile is a soft fault every time, compiled once and diagnosed once', async () => {
    const hn = await makeRealm();
    const src = 'tracktitle.value=jscript:player.currentmedia.name';
    const a = hn.handler(src);
    const b = hn.handler(src);
    expect(a).toMatchObject({ ok: false, kind: 'soft' });
    expect(!a.ok && a.reason).toMatch(/^SyntaxError/);
    expect(b).toEqual(a);
    expect(hn.log.diags.filter((d) => d.code === 'handler-syntax')).toHaveLength(1);
    expect(hn.realm.health.soft).toBe(2);
  });

  it('eval("eq"+i+".left=5") writes through to the ids', async () => {
    const hn = await makeRealm();
    expect(hn.handler('for (var i = 0; i < 3; i++) eval("eq" + i + ".left=5");').ok).toBe(true);
    expect([10, 11, 12].map((h) => hn.objects.prop(h, 'left'))).toEqual([5, 5, 5]);
  });

  it('a = b.visible = false works', async () => {
    const hn = await makeRealm();
    expect(hn.handler('a = sEqEar.visible = false; Ice.visible = volume.visible = a;').ok).toBe(true);
    expect(hn.realm.readGlobal('a')).toBe(false);
    expect([1, 2, 3].map((h) => hn.objects.prop(h, 'visible'))).toEqual([false, false, false]);
  });

  it('member writes coerce nothing realm-side: values cross as written, NaN as null', async () => {
    const hn = await makeRealm();
    expect(hn.handler("value = 'false'; Ice.value = 0 / 0; sEqEar.tooltip = [1, 2];", { el: 1 }).ok).toBe(true);
    expect(hn.objects.log.filter(([op]) => op === 'set').map(([, h, k, a]) => [h, k, a?.[0]])).toEqual([[1, 'value', 'false'], [3, 'value', null], [2, 'tooltip', undefined]]);
  });
});
