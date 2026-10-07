// @ts-check
// Acceptance 8, and the properties that hold for every class of the schema at once: each stub is
// type-correct and ledgered once per api, each denied member is refused once, each live or emulated
// member has an implementation, and no class answers to a name a skin invents.
import { describe, expect, it } from 'vitest';
import { ELEMENT_KINDS, SCHEMA, apiName } from '../../../src/engine/model/schema.js';
import { makeGraph } from './objects-fakes.js';

/** One element of every kind under the view, so every `element.<kind>` class has an object. */
const EVERY_KIND = [
  { kind: /** @type {const} */ ('view'), id: 'v' },
  ...ELEMENT_KINDS.filter((k) => k !== 'view').map((kind) => ({ kind, id: `e_${kind}` })),
];

/** The object of every class in the schema, found the way a script finds them. @param {ReturnType<typeof makeGraph>} t */
function objectsByClass(t) {
  /** @type {Map<string, import('../../../src/engine/contracts').HostObject>} */
  const found = new Map();
  for (const o of Object.values(t.graph.globals)) found.set(o.className, o);
  const player = /** @type {any} */ (t.graph.globals.player);
  for (const member of ['controls', 'settings', 'currentMedia', 'network', 'currentPlaylist', 'mediaCollection']) {
    // `peek` is the quiet read: finding the objects must not put a stub in the ledger the tests inspect
    const o = t.graph.objectOf(player.peek(member).__h);
    if (!o) throw new Error(`player.${member} is not an object`);
    found.set(o.className, o);
  }
  for (const el of t.model.elements) {
    const o = t.graph.elementObject(el);
    found.set(o.className, o);
  }
  return found;
}

/** @param {import('../../../src/engine/contracts').MemberSpec} spec @param {import('../../../src/engine/contracts').HostObject} o @param {Parameters<typeof makeGraph>[0]} [_] */
const touch = (spec, o) => (spec.kind === 'method' ? o.call(spec.name, [], { gesture: false }) : o.get(spec.name));

describe('every class of the schema has an object', () => {
  it('the test graph reaches all of them', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const found = objectsByClass(t);
    expect([...SCHEMA.keys()].filter((k) => !found.has(k))).toEqual([]);
    for (const [name, o] of found) expect(o.className).toBe(name);
  });

  it('their handles are positive integers, one per object', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const handles = [...objectsByClass(t).values()].map((o) => /** @type {any} */ (o).handle);
    expect(handles.every((h) => Number.isInteger(h) && h > 0)).toBe(true);
    expect(new Set(handles).size).toBe(handles.length);
  });
});

describe('stubs (acceptance 8)', () => {
  const t0 = makeGraph({ elements: EVERY_KIND });
  const stubs = [...objectsByClass(t0)].flatMap(([className, o]) => [...SCHEMA.get(className)?.values() ?? []].filter((s) => s.impl === 'stub').map((spec) => ({ className, spec, o })));

  it('there are stubs to test', () => {
    expect(stubs.length).toBeGreaterThan(40);
  });

  it('each stub returns a type-correct value', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    for (const { className, spec } of stubs) {
      const o = /** @type {import('../../../src/engine/contracts').HostObject} */ (objects.get(className));
      const v = /** @type {any} */ (touch(spec, o));
      const where = `${className}.${spec.name}`;
      switch (spec.type) {
        case 'number': expect(typeof v, where).toBe('number'); expect(Number.isFinite(v), where).toBe(true); break;
        case 'string': expect(typeof v, where).toBe('string'); break;
        case 'bool': expect(typeof v, where).toBe('boolean'); break;
        case 'void': expect(v, where).toBeUndefined(); break;
        case 'object': expect(typeof v?.__h, where).toBe('number'); expect(t.graph.objectOf(v.__h)?.className, where).toBe('inert'); break;
        default: throw new Error(`unknown type ${spec.type}`);
      }
      if (spec.stubValue !== undefined) expect(v, where).toEqual(spec.stubValue);
    }
  });

  it('the ledger records each (skin, api) once, and counts the repeats', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    for (const { className, spec } of stubs) touch(spec, /** @type {any} */ (objects.get(className)));
    for (const { className, spec } of stubs) touch(spec, /** @type {any} */ (objects.get(className)));
    const entries = t.ledger.entries().filter((e) => e.kind === 'stub');
    const apis = entries.map((e) => e.api);
    expect(new Set(apis).size).toBe(apis.length);                                   // one entry per api
    for (const { className, spec } of stubs) {
      const entry = entries.find((e) => e.api === apiName(className, spec.name));
      expect(entry, `${className}.${spec.name}`).toBeDefined();
    }
    // a stub reached twice through the same api counts 2; the shared inert-collection members may add more
    expect(entries.every((e) => e.count >= 2)).toBe(true);
    expect(entries.find((e) => e.api === 'player.settings.rate')?.count).toBe(2);
  });

  it('a stub of a class shared by several elements shares one ledger entry per api', () => {
    const t = makeGraph({ elements: [{ kind: 'view', id: 'v' }, { kind: 'automenu', id: 'm1' }, { kind: 'automenu', id: 'm2' }] });
    t.call('m1.show', []);
    t.call('m2.show', []);
    expect(t.counts()['automenu.show stub']).toBe(2);
    expect(t.ledger.entries().filter((e) => e.api === 'automenu.show')).toHaveLength(1);
  });
});

describe('denied members', () => {
  it('each is refused, ledgered per attempt, and announced to the host once per api', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    const denied = [...objects].flatMap(([className, o]) => [...SCHEMA.get(className)?.values() ?? []].filter((s) => s.impl === 'denied').map((spec) => ({ className, spec, o })));
    expect(denied.map((d) => apiName(d.className, d.spec.name)).sort()).toEqual([
      'player.URL', 'player.currentMedia.setItemInfo', 'player.currentPlaylist.setItemInfo', 'player.launchURL',
    ]);
    for (let round = 0; round < 3; round++) {
      for (const { spec, o } of denied) {
        if (spec.kind === 'method') o.call(spec.name, ['payload'], { gesture: true });
        else o.set(spec.name, 'payload', 'script');
      }
    }
    for (const { className, spec } of denied) {
      const api = apiName(className, spec.name);
      expect(t.ledger.entries().filter((e) => e.api === api && e.kind === 'denied')).toEqual([{ api, kind: 'denied', count: 3, detail: 'payload' }]);
      expect(t.actionLog.denied.filter(([a]) => a === api)).toEqual([[api, 'payload']]);
    }
    expect(t.media.calls).toEqual([]);
  });

  it('a denied write never reaches the media model, and the policy name is deny-log', () => {
    for (const [, schema] of SCHEMA) for (const spec of schema.values()) if (spec.impl === 'denied') expect(spec.policy).toBe('deny-log');
  });
});

describe('live and emulated members have an implementation', () => {
  it('every readable one returns a value, never undefined', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    for (const [className, o] of objects) {
      for (const spec of SCHEMA.get(className)?.values() ?? []) {
        if (spec.impl !== 'live' && spec.impl !== 'emulated') continue;
        if (spec.kind === 'method') {
          expect(() => o.call(spec.name, [], { gesture: false }), `${className}.${spec.name}()`).not.toThrow();
        } else {
          expect(o.get(spec.name), `${className}.${spec.name}`).not.toBeUndefined();
        }
      }
    }
    expect(t.ledger.entries().filter((e) => e.kind === 'unknown-member')).toEqual([]);
  });

  it('every method survives arguments a skin could send', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    const junk = [undefined, null, NaN, Infinity, -Infinity, -1, 1e308, '', ' ', 'x'.repeat(70000), '__proto__', 'constructor', { __h: 999999 }, true, false];
    for (const [className, o] of objects) {
      for (const spec of SCHEMA.get(className)?.values() ?? []) {
        if (spec.kind !== 'method') continue;
        for (let i = 0; i < junk.length; i++) {
          const args = [junk[i], junk[(i + 3) % junk.length], junk[(i + 7) % junk.length], junk[(i + 11) % junk.length]];
          expect(() => o.call(spec.name, /** @type {any} */ (args), { gesture: true }), `${className}.${spec.name}`).not.toThrow();
        }
        expect(() => o.call(spec.name, /** @type {any} */ (new Array(40).fill(1)), { gesture: false }), `${className}.${spec.name} x40`).not.toThrow();
      }
    }
  });

  it('every writable property survives values a skin could write', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    const junk = [undefined, null, NaN, Infinity, -1, 1e308, '', 'x'.repeat(70000), '__proto__', { __h: 999999 }, true, false, 0, 'true'];
    for (const [className, o] of objects) {
      for (const spec of SCHEMA.get(className)?.values() ?? []) {
        if (spec.kind === 'method' || spec.access !== 'rw' || spec.impl === 'denied') continue;
        for (const v of junk) expect(() => o.set(spec.name, /** @type {any} */ (v), 'script'), `${className}.${spec.name}`).not.toThrow();
        const after = o.get(spec.name);
        expect(after === undefined || typeof after === 'object' || ['number', 'string', 'boolean'].includes(typeof after), `${className}.${spec.name}`).toBe(true);
        if (typeof after === 'number') expect(Number.isFinite(after), `${className}.${spec.name}`).toBe(true);
      }
    }
  });
});

describe('names a skin invents', () => {
  const NAMES = ['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__lookupGetter__',
    'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '', ' ', 'x'.repeat(500)];

  it('are unknown members on every class: undefined, dropped, ledgered, never inherited', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    for (const [className, o] of objects) {
      if (className === 'mediacenter') continue;                       // session-only keys: tested with mediacenter
      for (const name of NAMES) {
        expect(o.get(name), `${className}.get(${name.slice(0, 20)})`).toBeUndefined();
        expect(() => o.set(name, 1, 'script')).not.toThrow();
        expect(o.call(name, [1], { gesture: true })).toBeUndefined();
      }
    }
    const unknown = t.ledger.entries().filter((e) => e.kind === 'unknown-member');
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((e) => e.api.length <= 128)).toBe(true);
    expect(t.ledger.entries().filter((e) => e.kind !== 'unknown-member')).toEqual([]);
  });

  it('no schema table inherits from Object.prototype', () => {
    for (const [name, schema] of SCHEMA) {
      expect(schema instanceof Map, name).toBe(true);
      expect(schema.get('constructor'), name).toBeUndefined();
      expect(schema.get('__proto__'), name).toBeUndefined();
      expect(schema.has('tostring'), name).toBe(false);
    }
    expect(SCHEMA.get('constructor')).toBeUndefined();
    expect(SCHEMA.get('__proto__')).toBeUndefined();
  });
});

describe('dispose', () => {
  it('leaves every object inert', () => {
    const t = makeGraph({ elements: EVERY_KIND });
    const objects = objectsByClass(t);
    t.graph.dispose();
    for (const [className, o] of objects) {
      for (const spec of SCHEMA.get(className)?.values() ?? []) {
        expect(touch(spec, o), `${className}.${spec.name}`).toBeUndefined();
        o.set(spec.name, 1, 'script');
      }
    }
    expect(t.media.calls).toEqual([]);
    expect(t.actionLog.run).toEqual([]);
    expect(t.ledger.entries()).toEqual([]);
  });

  it('cancels a pending coalesced command instead of sending it afterwards', () => {
    const t = makeGraph();
    t.write('player.settings.volume', 12);
    t.write('player.controls.currentPosition', 20);
    t.graph.dispose();
    t.clock.advance(1000);
    expect(t.media.calls).toEqual([]);
    expect(t.clock.pendingTimers()).toBe(0);
  });
});
