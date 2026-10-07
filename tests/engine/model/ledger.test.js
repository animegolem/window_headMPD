// @ts-check
import { describe, expect, it } from 'vitest';
import { MAX_LEDGER_ENTRIES, OVERFLOW_API, createLedger } from '../../../src/engine/model/ledger.js';

describe('createLedger', () => {
  it('starts empty', () => {
    expect(createLedger('a'.repeat(64)).entries()).toEqual([]);
  });

  it('records one entry per (api, kind) and counts the repeats', () => {
    const ledger = createLedger('s');
    ledger.record('player.settings.rate', 'stub');
    ledger.record('player.settings.rate', 'stub');
    ledger.record('player.settings.rate', 'stub');
    ledger.record('player.launchURL', 'denied', 'https://example.com');
    expect(ledger.entries()).toEqual([
      { api: 'player.settings.rate', kind: 'stub', count: 3 },
      { api: 'player.launchURL', kind: 'denied', count: 1, detail: 'https://example.com' },
    ]);
  });

  it('the same api under two kinds is two entries', () => {
    const ledger = createLedger('s');
    ledger.record('x', 'stub');
    ledger.record('x', 'denied');
    ledger.record('x', 'cap');
    expect(ledger.entries().map((e) => e.kind)).toEqual(['stub', 'denied', 'cap']);
  });

  it('keeps the first detail and does not overwrite it', () => {
    const ledger = createLedger('s');
    ledger.record('api', 'denied', 'first');
    ledger.record('api', 'denied', 'second');
    expect(ledger.entries()[0].detail).toBe('first');
  });

  it('record says whether the pair is new (callers must not rely on it)', () => {
    const ledger = /** @type {any} */ (createLedger('s'));
    expect(ledger.record('a', 'stub')).toBe(true);
    expect(ledger.record('a', 'stub')).toBe(false);
    expect(ledger.record('a', 'denied')).toBe(true);
  });

  it('hands out copies: changing one cannot change the counts', () => {
    const ledger = createLedger('s');
    ledger.record('a', 'stub');
    const [entry] = ledger.entries();
    entry.count = 999;
    entry.api = 'hacked';
    expect(ledger.entries()).toEqual([{ api: 'a', kind: 'stub', count: 1 }]);
  });

  it('is independent per skin: two ledgers share nothing', () => {
    const one = createLedger('one');
    const two = createLedger('two');
    one.record('a', 'stub');
    expect(two.entries()).toEqual([]);
  });

  it('api names that are skin strings are plain keys: __proto__ and constructor are entries, not members', () => {
    const ledger = createLedger('s');
    ledger.record('__proto__', 'unknown-member');
    ledger.record('constructor', 'unknown-member');
    ledger.record('toString', 'unknown-member');
    ledger.record('__proto__', 'unknown-member');
    expect(ledger.entries()).toEqual([
      { api: '__proto__', kind: 'unknown-member', count: 2 },
      { api: 'constructor', kind: 'unknown-member', count: 1 },
      { api: 'toString', kind: 'unknown-member', count: 1 },
    ]);
    expect(Object.getPrototypeOf(ledger.entries())).toBe(Array.prototype);
  });

  it('an api with a NUL in it is its own entry (the key joins kind and api with one)', () => {
    const ledger = createLedger('s');
    ledger.record('a\u0000b', 'stub');
    ledger.record('b', 'stub');
    ledger.record('a', 'stub');
    ledger.record('a\u0000b', 'denied');
    expect(ledger.entries().map((e) => `${e.api}|${e.kind}`)).toEqual(['a\u0000b|stub', 'b|stub', 'a|stub', 'a\u0000b|denied']);
  });

  it('clips long api names and details', () => {
    const ledger = createLedger('s');
    ledger.record('x'.repeat(1000), 'unknown-member', 'd'.repeat(1000));
    const [entry] = ledger.entries();
    expect(entry.api).toHaveLength(128);
    expect(entry.api.endsWith('...')).toBe(true);
    expect(entry.detail).toHaveLength(256);
    ledger.record('x'.repeat(1000), 'unknown-member');            // the clipped name is the key
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0].count).toBe(2);
  });

  it('every entry kind of the contract is accepted', () => {
    const ledger = createLedger('s');
    for (const kind of /** @type {const} */ (['stub', 'denied', 'unknown-member', 'unknown-tag', 'unresolved-binding', 'unresolved-res', 'soft-fault', 'cap'])) {
      ledger.record(`api-${kind}`, kind);
    }
    expect(ledger.entries()).toHaveLength(8);
  });

  it('is bounded: past the cap new pairs are only counted, in one overflow entry; known pairs still count', () => {
    const ledger = createLedger('s');
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 500; i++) ledger.record(`made.up.${i}`, 'unknown-member');
    const entries = ledger.entries();
    expect(entries).toHaveLength(MAX_LEDGER_ENTRIES + 1);
    const overflow = entries[entries.length - 1];
    expect(overflow).toMatchObject({ api: OVERFLOW_API, kind: 'cap', count: 500 });
    ledger.record('made.up.0', 'unknown-member');
    expect(ledger.entries()[0].count).toBe(2);
    ledger.record('one.more', 'unknown-member');
    expect(ledger.entries().at(-1)?.count).toBe(501);
    expect(ledger.entries()).toHaveLength(MAX_LEDGER_ENTRIES + 1);
  });
});
