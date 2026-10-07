// @ts-check
import { describe, expect, it } from 'vitest';
import { PREF_CAPS, createMemoryPrefs } from '../../../src/hosts/test/prefs.js';

const SHA = 'a'.repeat(64);

describe('memory prefs: load and seed', () => {
  it("load('x') of a seeded namespace returns a Map of the seeded entries", async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('x', { a: '1', b: '2' });
    const m = await prefs.load('x');
    expect(m).toBeInstanceOf(Map);
    expect([...m]).toEqual([['a', '1'], ['b', '2']]);
  });

  it('load of an unknown namespace is an empty Map, not an error', async () => {
    const m = await createMemoryPrefs().load(SHA);
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it('seed takes a Map, pairs or a plain object, and replaces the namespace', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('app', new Map([['zoom', '2']]));
    expect([...(await prefs.load('app'))]).toEqual([['zoom', '2']]);
    prefs.seed('app', [['eq', '[0,0]'], ['balance', '0']]);
    expect([...(await prefs.load('app'))]).toEqual([['eq', '[0,0]'], ['balance', '0']]);
    prefs.seed('app', {});
    expect((await prefs.load('app')).size).toBe(0);
  });

  it('seed rejects non-string values and leaves the namespace as it was', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('app', { keep: 'me' });
    // @ts-expect-error a number is not a pref value
    expect(() => prefs.seed('app', { n: 1 })).toThrow(TypeError);
    expect([...(await prefs.load('app'))]).toEqual([['keep', 'me']]);
  });

  it('load hands out a copy: mutating it does not change the store', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('x', { a: '1' });
    const m = await prefs.load('x');
    m.set('a', 'changed');
    m.set('b', 'new');
    expect([...(await prefs.load('x'))]).toEqual([['a', '1']]);
  });

  it('namespaces are independent and any name is accepted (validation is the Rust store job)', async () => {
    const prefs = createMemoryPrefs();
    prefs.write('x', 'k', 'one');
    prefs.write(SHA, 'k', 'two');
    expect((await prefs.load('x')).get('k')).toBe('one');
    expect((await prefs.load(SHA)).get('k')).toBe('two');
    expect((await prefs.load('mediacenter')).size).toBe(0);
  });
});

describe('memory prefs: write', () => {
  it('writes through, overwrites, and deletes with null; every accepted write is logged', async () => {
    const prefs = createMemoryPrefs();
    prefs.write('app', 'zoom', '1');
    prefs.write('app', 'zoom', '2');
    prefs.write('app', 'gone', 'x');
    prefs.write('app', 'gone', null);
    expect([...(await prefs.load('app'))]).toEqual([['zoom', '2']]);
    expect(prefs.writes).toEqual([
      { ns: 'app', key: 'zoom', value: '1' },
      { ns: 'app', key: 'zoom', value: '2' },
      { ns: 'app', key: 'gone', value: 'x' },
      { ns: 'app', key: 'gone', value: null },
    ]);
    expect(prefs.rejected).toEqual([]);
  });

  it('rejects non-string arguments', () => {
    const prefs = createMemoryPrefs();
    // @ts-expect-error
    expect(() => prefs.write('app', 'k', 5)).toThrow(TypeError);
    // @ts-expect-error
    expect(() => prefs.write('app', 1, 'v')).toThrow(TypeError);
    expect(() => prefs.write('app', 'k', /** @type {any} */ (undefined))).toThrow(TypeError);
  });

  it('the caps are the D6.4 numbers', () => {
    expect(PREF_CAPS).toEqual({ maxKeys: 256, maxKeyBytes: 256, maxValueBytes: 4096, maxNamespaceBytes: 65536 });
    expect(createMemoryPrefs().caps).toEqual(PREF_CAPS);
  });
});

describe('memory prefs: caps reject over-cap writes and keep the previous state', () => {
  it('a 257th key is dropped, but the 256th and an overwrite of an existing key are fine', async () => {
    const prefs = createMemoryPrefs();
    for (let i = 0; i < 256; i++) prefs.write(SHA, `k${i}`, 'v');
    expect(prefs.rejected).toEqual([]);
    prefs.write(SHA, 'k256', 'v');
    expect(prefs.rejected).toEqual([{ ns: SHA, key: 'k256', value: 'v', reason: 'key-count' }]);
    const m = await prefs.load(SHA);
    expect(m.size).toBe(256);
    expect(m.has('k256')).toBe(false);
    prefs.write(SHA, 'k0', 'changed');                 // existing key: allowed at the cap
    expect((await prefs.load(SHA)).get('k0')).toBe('changed');
    prefs.write(SHA, 'k1', null);                      // delete frees a slot
    prefs.write(SHA, 'k256', 'v');
    expect((await prefs.load(SHA)).get('k256')).toBe('v');
  });

  it('a 4,097-byte value is dropped and 4,096 is kept; bytes are UTF-8, not characters', async () => {
    const prefs = createMemoryPrefs();
    prefs.write('app', 'ok', 'x'.repeat(4096));
    prefs.write('app', 'big', 'x'.repeat(4097));
    prefs.write('app', 'wide', 'é'.repeat(2049));  // 2 bytes each: 4,098 bytes in 2,049 chars
    expect(prefs.rejected.map((r) => [r.key, r.reason])).toEqual([['big', 'value-bytes'], ['wide', 'value-bytes']]);
    const m = await prefs.load('app');
    expect([...m.keys()]).toEqual(['ok']);
    prefs.write('app', 'ok', 'x'.repeat(4097));        // an over-cap overwrite leaves the old value
    expect((await prefs.load('app')).get('ok')).toHaveLength(4096);
  });

  it('a key over 256 bytes is dropped', async () => {
    const prefs = createMemoryPrefs();
    prefs.write('app', 'k'.repeat(256), 'v');
    prefs.write('app', 'k'.repeat(257), 'v');
    expect(prefs.rejected.map((r) => r.reason)).toEqual(['key-bytes']);
    expect((await prefs.load('app')).size).toBe(1);
  });

  it('a namespace past 64 KiB is dropped; the write that fits exactly is accepted', async () => {
    const prefs = createMemoryPrefs();
    // 15 entries of key (2 B) + value (4,094 B) = 4,096 B each: 61,440 B in all.
    for (let i = 0; i < 15; i++) prefs.write(SHA, `k${String.fromCharCode(97 + i)}`, 'v'.repeat(4094));
    expect(prefs.rejected).toEqual([]);
    prefs.write(SHA, 'xx', 'v'.repeat(4096));          // 2 + 4,096 = 4,098: total 65,538 > 65,536
    expect(prefs.rejected.map((r) => r.reason)).toEqual(['namespace-bytes']);
    prefs.write(SHA, 'xx', 'v'.repeat(4094));          // 4,096 B: total exactly 65,536
    expect(prefs.rejected).toHaveLength(1);
    expect((await prefs.load(SHA)).size).toBe(16);
    prefs.write(SHA, 'y', 'v');                        // anything more is over
    expect(prefs.rejected.map((r) => r.reason)).toEqual(['namespace-bytes', 'namespace-bytes']);
    expect((await prefs.load(SHA)).has('y')).toBe(false);
  });

  it('overwriting a key counts the replaced value, not both', async () => {
    const prefs = createMemoryPrefs({ caps: { maxNamespaceBytes: 20 } });
    prefs.write('x', 'k', 'a'.repeat(19));             // 20 B exactly
    prefs.write('x', 'k', 'b'.repeat(19));             // replaces: still 20 B
    expect(prefs.rejected).toEqual([]);
    expect((await prefs.load('x')).get('k')).toBe('b'.repeat(19));
  });

  it('caps are per namespace', async () => {
    const prefs = createMemoryPrefs({ caps: { maxKeys: 2 } });
    prefs.write('a', '1', 'v');
    prefs.write('a', '2', 'v');
    prefs.write('b', '1', 'v');
    expect(prefs.rejected).toEqual([]);
    prefs.write('a', '3', 'v');
    expect(prefs.rejected).toHaveLength(1);
  });
});

describe('memory prefs: skin-controlled keys', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype'])('key %s is an ordinary entry', async (key) => {
    const prefs = createMemoryPrefs();
    prefs.write(SHA, key, 'value');
    const m = await prefs.load(SHA);
    expect(m.get(key)).toBe('value');
    expect([...m.keys()]).toEqual([key]);
    expect(Object.getPrototypeOf(m)).toBe(Map.prototype);
    prefs.write(SHA, key, null);
    expect((await prefs.load(SHA)).size).toBe(0);
  });

  it('a namespace called __proto__ or constructor is just a namespace', async () => {
    const prefs = createMemoryPrefs();
    prefs.write('__proto__', 'k', 'one');
    prefs.write('constructor', 'k', 'two');
    expect((await prefs.load('__proto__')).get('k')).toBe('one');
    expect((await prefs.load('constructor')).get('k')).toBe('two');
    expect((await prefs.load('toString')).size).toBe(0);
  });

  it('seeding from JSON that carries a __proto__ key keeps it as an entry', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed(SHA, JSON.parse('{"__proto__": "p", "constructor": "c"}'));
    const m = await prefs.load(SHA);
    expect(m.get('__proto__')).toBe('p');
    expect(m.get('constructor')).toBe('c');
  });
});

describe('memory prefs: external changes', () => {
  it('notifies that namespace only, applies the change, and does not log it as a write', async () => {
    const prefs = createMemoryPrefs();
    /** @type {Array<[string, string | null]>} */
    const heard = [];
    /** @type {Array<[string, string | null]>} */
    const other = [];
    prefs.onExternalChange('mediacenter', (k, v) => heard.push([k, v]));
    prefs.onExternalChange('app', (k, v) => other.push([k, v]));
    prefs.external('mediacenter', 'effectPreset', '3');
    prefs.external('mediacenter', 'effectPreset', null);
    expect(heard).toEqual([['effectPreset', '3'], ['effectPreset', null]]);
    expect(other).toEqual([]);
    expect(prefs.writes).toEqual([]);
    expect((await prefs.load('mediacenter')).size).toBe(0);
    prefs.external('mediacenter', 'effectPreset', '4');
    expect((await prefs.load('mediacenter')).get('effectPreset')).toBe('4');
  });

  it('the caller\'s own writes and seeds are not echoed back', () => {
    const prefs = createMemoryPrefs();
    let heard = 0;
    prefs.onExternalChange('app', () => heard++);
    prefs.write('app', 'k', 'v');
    prefs.seed('app', { k: 'w' });
    expect(heard).toBe(0);
  });

  it('unsubscribe stops delivery, and a throwing listener does not starve the others', () => {
    const prefs = createMemoryPrefs();
    let a = 0;
    let b = 0;
    const off = prefs.onExternalChange('app', () => a++);
    prefs.onExternalChange('app', () => { throw new Error('listener'); });
    prefs.onExternalChange('app', () => b++);
    expect(() => prefs.external('app', 'k', '1')).toThrow('listener');
    expect([a, b]).toEqual([1, 1]);
    off();
    expect(() => prefs.external('app', 'k', '2')).toThrow('listener');
    expect([a, b]).toEqual([1, 2]);
  });
});
