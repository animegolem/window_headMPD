// @ts-check
import { describe, expect, it } from 'vitest';
import { PREF_CAPS, PREF_DEBOUNCE_MS, PREFS_CHANGED_EVENT, createTauriPrefs } from '../../../src/hosts/tauri/prefs.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import { PREF_CAPS as TEST_HOST_CAPS } from '../../../src/hosts/test/prefs.js';

const SKIN = 'a'.repeat(64);
const OTHER_SKIN = 'b'.repeat(64);
/** Let queued promise callbacks (the IPC chain) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {{ files?: Record<string, Record<string, string>>, caps?: Partial<import('../../../src/hosts/tauri/prefs.js').PrefCaps>, holdWrites?: boolean, holdLoads?: boolean }} [o]
 *   `files` is what Rust holds per namespace and starts the in-memory file; `prefs_write` applies to it.
 *   `holdWrites` makes `prefs_write` wait until released (it lands when released). `holdLoads` makes
 *   `prefs_load` take its snapshot of the file when the call starts and then wait until released, like
 *   a slow read.
 */
function setup(o = {}) {
  const clock = createManualClock();
  /** @type {Array<[string, any]>} */
  const calls = [];
  /** @type {Array<() => void>} */
  const held = [];
  /** @type {Array<() => void>} */
  const heldLoads = [];
  /** What Rust holds, per namespace. Maps, so a key named __proto__ is a key. @type {Map<string, Map<string, any>>} */
  const file = new Map(Object.entries(o.files ?? {}).map(([ns, kv]) => [ns, new Map(Object.entries(kv))]));
  /** @type {Array<[string, object | undefined]>} */
  const warnings = [];
  /** @type {Array<(e: { payload: unknown }) => void>} */
  const handlers = [];
  const listened = { events: /** @type {string[]} */ ([]), unlistened: 0 };
  /** @type {Set<string>} */
  const failing = new Set();
  const invoke = async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push([cmd, args]);
    if (failing.has(cmd)) throw new Error(`${cmd} refused`);
    if (cmd === 'prefs_load') {
      const snapshot = Object.fromEntries(file.get(args.ns) ?? []);   // taken now, before any wait
      if (o.holdLoads) await new Promise((r) => heldLoads.push(() => r(undefined)));
      return snapshot;
    }
    if (cmd === 'prefs_write') {
      if (o.holdWrites) await new Promise((r) => held.push(() => r(undefined)));
      let m = file.get(args.ns);
      if (!m) file.set(args.ns, (m = new Map()));
      if (args.value === null) m.delete(args.key);
      else m.set(args.key, args.value);
    }
    return undefined;
  };
  const listen = async (/** @type {string} */ event, /** @type {(e: { payload: unknown }) => void} */ handler) => {
    listened.events.push(event);
    handlers.push(handler);
    return () => { listened.unlistened++; };
  };
  const prefs = createTauriPrefs({
    invoke,
    listen,
    label: 'main',
    setTimer: (ms, cb) => clock.setTimer(ms, cb),
    clearTimer: (id) => clock.clearTimer(id),
    caps: o.caps,
    log: { warn: (m, d) => { warnings.push([m, d]); } },
  });
  /** Deliver a prefs-changed event as Tauri would. @param {unknown} payload */
  const emit = (payload) => { for (const h of handlers) h({ payload }); };
  return {
    prefs, clock, calls, held, heldLoads, warnings, listened, failing,
    writes: () => calls.filter(([c]) => c === 'prefs_write').map(([, a]) => a),
    /** What the file holds right now. */
    fileOf: (/** @type {string} */ ns) => Object.fromEntries(file.get(ns) ?? []),
    emit,
    /**
     * Another window's write, in Rust's order: the file changes first (`null` deletes), then the
     * `prefs-changed` event goes out. Use `emit` for what is not such a write (own echoes, malformed events).
     * @param {string} ns @param {string} key @param {string | null} value @param {string} [window]
     */
    external: (ns, key, value, window = 'skin-1') => {
      let m = file.get(ns);
      if (!m) file.set(ns, (m = new Map()));
      if (value === null) m.delete(key);
      else m.set(key, value);
      emit({ ns, key, value, window });
    },
  };
}

describe('constants', () => {
  it('are the D6.4 numbers, and the test host\'s', () => {
    expect(PREF_CAPS).toEqual({ maxKeys: 256, maxKeyBytes: 256, maxValueBytes: 4096, maxNamespaceBytes: 65536 });
    expect(PREF_CAPS).toEqual(TEST_HOST_CAPS);
    expect(PREF_DEBOUNCE_MS).toBe(250);
    expect(PREFS_CHANGED_EVENT).toBe('prefs-changed');
  });
});

describe('load', () => {
  it('asks Rust for the namespace and returns a Map', async () => {
    const t = setup({ files: { app: { zoom: '1.5', eq: '[0,0]' } } });
    const m = await t.prefs.load('app');
    expect(m).toBeInstanceOf(Map);
    expect([...m]).toEqual([['zoom', '1.5'], ['eq', '[0,0]']]);
    expect(t.calls).toEqual([['prefs_load', { ns: 'app' }]]);
  });

  it('returns a copy, so the engine\'s Map and the store\'s cache are separate', async () => {
    const t = setup({ files: { app: { zoom: '1' } } });
    const m = await t.prefs.load('app');
    m.set('zoom', 'changed');
    expect((await t.prefs.load('app')).get('zoom')).toBe('1');
  });

  it('accepts a skin sha, app and mediacenter, and refuses anything else before the IPC', async () => {
    const t = setup();
    for (const ok of [SKIN, 'app', 'mediacenter']) await t.prefs.load(ok);
    expect(t.calls).toHaveLength(3);
    for (const bad of ['', 'App', 'a'.repeat(63), 'A'.repeat(64), '__proto__', 'constructor', '../app', 'app\n']) {
      await expect(t.prefs.load(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(t.calls).toHaveLength(3);
  });

  it('keeps keys named __proto__ and constructor as plain keys, and Object.prototype clean', async () => {
    const reply = JSON.parse('{"__proto__": "p", "constructor": "c", "toString": "t"}');
    const t = setup({ files: { [SKIN]: reply } });
    const m = await t.prefs.load(SKIN);
    expect(m.get('__proto__')).toBe('p');
    expect(m.get('constructor')).toBe('c');
    expect(m.get('toString')).toBe('t');
    expect(m.size).toBe(3);
    expect(/** @type {any} */ ({}).p).toBeUndefined();
    expect(Object.getPrototypeOf(m)).toBe(Map.prototype);
  });

  it('ignores non-string values in a reply instead of passing them on', async () => {
    const t = setup({ files: { app: { a: '1', b: /** @type {any} */ (2), c: /** @type {any} */ (null) } } });
    expect([...(await t.prefs.load('app'))]).toEqual([['a', '1']]);
  });

  it('includes this window\'s writes that have not been sent yet', async () => {
    const t = setup({ files: { app: { a: 'old', gone: 'x' } } });
    await t.prefs.load('app');
    t.prefs.write('app', 'a', 'new');
    t.prefs.write('app', 'gone', null);
    t.prefs.write('app', 'fresh', '1');
    const m = await t.prefs.load('app');
    expect([...m].sort()).toEqual([['a', 'new'], ['fresh', '1']]);
  });

  it('rejects to its caller when prefs_load fails, logs it, and later calls still go', async () => {
    const t = setup({ files: { app: { a: '1' } } });
    t.failing.add('prefs_load');
    await expect(t.prefs.load('app')).rejects.toThrow('prefs_load refused');
    expect(t.warnings.map(([m]) => m)).toEqual(['prefs: prefs_load failed: prefs_load refused']);
    t.failing.clear();
    expect([...(await t.prefs.load('app'))]).toEqual([['a', '1']]);
  });

  describe('while a write\'s debounce fires during the read (read-your-writes)', () => {
    it('still returns the value: the write was neither in the file snapshot nor pending any more', async () => {
      const t = setup({ holdLoads: true });
      t.prefs.write('app', 'zoom', '1.5');
      const p = t.prefs.load('app');                               // the file snapshot lacks zoom
      await settle();
      expect(t.heldLoads).toHaveLength(1);
      t.clock.advance(250);                                        // the debounce fires mid-load
      await settle();
      expect(t.writes()).toEqual([]);                              // queued behind the read, not racing it
      t.heldLoads.shift()?.();
      expect((await p).get('zoom')).toBe('1.5');                   // (a)
      await settle();
      expect(t.writes()).toEqual([{ ns: 'app', key: 'zoom', value: '1.5' }]);   // (b) exactly once
      expect(t.calls.map(([c]) => c)).toEqual(['prefs_load', 'prefs_write']);
      expect(t.fileOf('app')).toEqual({ zoom: '1.5' });
    });

    it('leaves the cache holding the raced value, so the caps see it', async () => {
      const t = setup({ holdLoads: true, caps: { maxKeys: 1 } });
      t.prefs.write('app', 'zoom', '1.5');
      const p = t.prefs.load('app');
      await settle();
      t.clock.advance(250);
      await settle();
      t.heldLoads.shift()?.();
      await p;
      await settle();
      t.prefs.write('app', 'another', '1');                        // a second key in a namespace capped at one
      expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
      t.prefs.write('app', 'zoom', '2');                           // the key it holds can still change
      expect(t.prefs.rejected).toHaveLength(1);
    });

    it('applies a delete the same way: the key is gone although the file snapshot had it', async () => {
      const t = setup({ holdLoads: true, files: { app: { zoom: '1', keep: 'x' } } });
      const p = t.prefs.load('app');                               // the snapshot has zoom
      await settle();
      t.prefs.write('app', 'zoom', null);
      t.clock.advance(250);
      await settle();
      t.heldLoads.shift()?.();
      expect([...(await p)]).toEqual([['keep', 'x']]);
      await settle();
      expect(t.writes()).toEqual([{ ns: 'app', key: 'zoom', value: null }]);
      expect(t.fileOf('app')).toEqual({ keep: 'x' });
    });

    it('also applies a write or delete whose debounce has not fired yet when the read ends', async () => {
      const t = setup({ holdLoads: true, files: { app: { zoom: '1', keep: 'x' } } });
      const p = t.prefs.load('app');
      await settle();
      t.prefs.write('app', 'zoom', null);
      t.prefs.write('app', 'fresh', '2');
      t.heldLoads.shift()?.();
      expect([...(await p)].sort()).toEqual([['fresh', '2'], ['keep', 'x']]);
      expect(t.prefs.pending()).toBe(2);
    });

    it('prefers the newer of a sent and a pending write to one key', async () => {
      const t = setup({ holdLoads: true });
      const p = t.prefs.load('app');
      await settle();
      t.prefs.write('app', 'k', 'sent');
      t.clock.advance(250);                                        // in flight (queued behind the read)
      await settle();
      t.prefs.write('app', 'k', 'pending');                        // newer, still waiting out its debounce
      t.heldLoads.shift()?.();
      expect((await p).get('k')).toBe('pending');
      await settle();
      t.clock.advance(250);
      await settle();
      expect(t.writes().map((w) => w.value)).toEqual(['sent', 'pending']);
    });

    it('does not let an older write landing wipe a newer one still in flight', async () => {
      const t = setup({ holdWrites: true });
      t.prefs.write('app', 'k', '1');
      t.clock.advance(250);                                        // write 1 is in flight, held
      await settle();
      const p = t.prefs.load('app');                               // queued behind write 1
      t.prefs.write('app', 'k', '2');
      t.clock.advance(250);                                        // write 2 queued behind the load
      await settle();
      t.held.shift()?.();                                          // write 1 lands: it must not clear write 2's entry
      expect((await p).get('k')).toBe('2');                        // the file only has '1' at this point
      await settle();
      t.held.shift()?.();
      await t.prefs.flush();
      expect(t.calls.map(([c]) => c)).toEqual(['prefs_write', 'prefs_load', 'prefs_write']);
      expect(t.fileOf('app')).toEqual({ k: '2' });
    });

    it('carries keys named __proto__ and constructor through the in-flight overlay as plain keys', async () => {
      const t = setup({ holdLoads: true });
      t.prefs.write(SKIN, '__proto__', 'p');
      t.prefs.write(SKIN, 'constructor', 'c');
      const p = t.prefs.load(SKIN);
      await settle();
      t.clock.advance(250);                                        // both are in flight when the read ends
      await settle();
      t.heldLoads.shift()?.();
      const m = await p;
      expect([...m]).toEqual([['__proto__', 'p'], ['constructor', 'c']]);
      expect(Object.getPrototypeOf(m)).toBe(Map.prototype);
      expect(/** @type {any} */ ({}).p).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
    });

    it('forgets a write that failed, so a later load shows the file', async () => {
      const t = setup({ files: { app: { k: 'file' } } });
      t.failing.add('prefs_write');
      t.prefs.write('app', 'k', 'lost');
      t.clock.advance(250);
      await settle();
      t.failing.clear();
      expect((await t.prefs.load('app')).get('k')).toBe('file');
    });
  });
});

describe('load with prefs-changed events from other windows arriving during the read', () => {
  /** Start a load and let it reach the held prefs_load call. Boxed, so awaiting the helper does not await the load. @param {ReturnType<typeof setup>} t @param {string} [ns] */
  const startHeld = async (t, ns = 'app') => {
    const p = t.prefs.load(ns);
    await settle();
    return { p };
  };

  it('first load: applies the event to the loaded Map, the subscriber and the cache', async () => {
    const t = setup({ holdLoads: true, caps: { maxKeys: 1 } });
    /** @type {Array<[string, string | null]>} */
    const heard = [];
    t.prefs.onExternalChange('app', (k, v) => heard.push([k, v]));
    const { p: p } = await startHeld(t);                                   // Rust read the file: no zoom yet
    expect(t.heldLoads).toHaveLength(1);
    t.external('app', 'zoom', '2');                                 // another window wrote it; the event beats the reply
    t.heldLoads.shift()?.();
    const m = await p;
    expect(m.get('zoom')).toBe('2');
    expect(heard).toEqual([['zoom', '2']]);
    t.prefs.write('app', 'another', '1');                           // the cache holds zoom, so a second key is over maxKeys 1
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
    t.prefs.write('app', 'zoom', '3');                              // the key it holds can still change
    expect(t.prefs.rejected).toHaveLength(1);
  });

  it('second load: the event is in the Map and in the cache the caps read', async () => {
    const t = setup({ holdLoads: true, files: { app: { a: '1' } }, caps: { maxKeys: 2 } });
    const { p: first } = await startHeld(t);
    t.heldLoads.shift()?.();
    await first;                                                    // cache = { a }
    const { p: p } = await startHeld(t);                                   // second read: Rust sees { a }
    t.external('app', 'b', '2');
    t.heldLoads.shift()?.();
    const m = await p;
    expect([...m].sort()).toEqual([['a', '1'], ['b', '2']]);
    t.prefs.write('app', 'c', '3');                                 // { a, b } is at maxKeys 2
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
  });

  it('does not make a cache entry of its own: before any load finishes, the key-count cap stays unchecked', async () => {
    const t = setup({ holdLoads: true, caps: { maxKeys: 1 } });
    t.prefs.onExternalChange('app', () => {});
    t.external('app', 'zoom', '2');                                 // no load yet, nothing to update
    t.prefs.write('app', 'a', '1');
    t.prefs.write('app', 'b', '1');                                 // an incomplete cache would refuse this one
    expect(t.prefs.rejected).toEqual([]);
    const { p: p } = await startHeld(t);
    t.external('app', 'k', '1');
    t.prefs.write('app', 'c', '1');                                 // still mid-read: no cache entry yet
    expect(t.prefs.rejected).toEqual([]);
    t.heldLoads.shift()?.();
    await p;
  });

  it('an external delete during the read removes a key the snapshot had', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1', keep: 'x' } }, caps: { maxKeys: 2 } });
    const { p: p } = await startHeld(t);                                   // the snapshot has zoom
    t.external('app', 'zoom', null);
    t.heldLoads.shift()?.();
    expect([...(await p)]).toEqual([['keep', 'x']]);
    t.prefs.write('app', 'new', '1');                               // { keep } plus one more fits in maxKeys 2
    expect(t.prefs.rejected).toEqual([]);
  });

  it('ignores this window\'s own echo during the read: the snapshot value stands', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1' } } });
    /** @type {unknown[]} */
    const heard = [];
    t.prefs.onExternalChange('app', (k, v) => heard.push([k, v]));
    const { p: p } = await startHeld(t);
    t.emit({ ns: 'app', key: 'zoom', value: '2', window: 'main' });
    t.emit({ ns: 'app', key: 'other', value: 'y', window: 'main' });
    t.heldLoads.shift()?.();
    expect([...(await p)]).toEqual([['zoom', '1']]);
    expect(heard).toEqual([]);
  });

  it('this window\'s own unsent write to the same key wins over the event, whichever came first', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1' } } });
    const { p: p } = await startHeld(t);
    t.external('app', 'zoom', '2');
    t.prefs.write('app', 'zoom', '3');                              // still waiting out its debounce
    t.prefs.write('app', 'other', 'mine');
    t.external('app', 'other', 'theirs');
    t.heldLoads.shift()?.();
    const m = await p;
    expect(m.get('zoom')).toBe('3');
    expect(m.get('other')).toBe('mine');
  });

  it('this window\'s own sent write to the same key wins over the event too', async () => {
    const t = setup({ holdLoads: true });
    const { p: p } = await startHeld(t);
    t.prefs.write('app', 'zoom', '3');
    t.clock.advance(250);                                           // sent, queued behind the read
    await settle();
    t.external('app', 'zoom', '2');
    t.heldLoads.shift()?.();
    expect((await p).get('zoom')).toBe('3');
    await settle();
    expect(t.fileOf('app')).toEqual({ zoom: '3' });
  });

  it('an own pending delete wins over an event that sets the key', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1' } } });
    const { p: p } = await startHeld(t);
    t.external('app', 'zoom', '2');
    t.prefs.write('app', 'zoom', null);
    t.heldLoads.shift()?.();
    expect([...(await p)]).toEqual([]);
  });

  it('the last of several events on one key wins', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1' } } });
    const { p: p } = await startHeld(t);
    t.external('app', 'zoom', '2');
    t.external('app', 'zoom', null);
    t.external('app', 'zoom', '4', 'skin-2');
    t.heldLoads.shift()?.();
    expect((await p).get('zoom')).toBe('4');
  });

  it('only events for the namespace being read reach it', async () => {
    const t = setup({ holdLoads: true });
    const { p: p } = await startHeld(t, 'app');
    t.external(SKIN, 'zoom', '2');
    t.external('mediacenter', 'zoom', '3');
    t.emit({ ns: 'nope', key: 'zoom', value: '4', window: 'skin-1' });   // not a namespace: no file behind it
    t.heldLoads.shift()?.();
    expect([...(await p)]).toEqual([]);
  });

  it('once the load has settled, a later event does not reach it, and a later load shows the file', async () => {
    const t = setup({ holdLoads: true, files: { app: { zoom: '1' } } });
    const { p: p } = await startHeld(t);
    t.heldLoads.shift()?.();
    const first = await p;
    t.external('app', 'zoom', '2');                                 // after the read: not part of any load in flight
    expect(first.get('zoom')).toBe('1');                            // the Map already returned is not touched
    const { p: q } = await startHeld(t);                            // the file says 2 now: this read takes its snapshot
    t.heldLoads.shift()?.();
    expect((await q).get('zoom')).toBe('2');
  });

  it('loads of one namespace in flight together each get the events of their own read', async () => {
    const t = setup({ holdLoads: true });
    const p1 = t.prefs.load('app');
    const p2 = t.prefs.load('app');                                 // queued behind the first read
    await settle();
    expect(t.heldLoads).toHaveLength(1);                            // only the first read has started
    t.external('app', 'zoom', '2');                                 // during the first read; the second one has not started
    t.heldLoads.shift()?.();
    expect((await p1).get('zoom')).toBe('2');                       // the first load collected the event
    await settle();
    expect(t.heldLoads).toHaveLength(1);                            // the second read has started now, and its snapshot has zoom
    t.external('app', 'late', '1');                                 // the first load is done: only the second one is open
    t.heldLoads.shift()?.();
    const second = await p2;
    expect(second.get('zoom')).toBe('2');                           // from its snapshot: the event came before its read
    expect(second.get('late')).toBe('1');                           // from its collector
    expect((await p1).has('late')).toBe(false);                     // finishing one load must not have taken the other's collector, nor given its own events to the first
  });

  it('an event that arrives while the load is still queued is already in the snapshot: our later write wins', async () => {
    // Mirrors /tmp/w42rev3/stale.mjs. Rust's order: skin-1's a=2 lands and is announced, then our a=3 lands
    // (our echo is skipped), then our read runs. The load must not let the older event override a=3.
    const t = setup({ holdWrites: true });
    t.prefs.write('app', 'a', '3');
    t.clock.advance(250);
    await settle();                                                 // our write is in flight and held
    expect(t.writes()).toHaveLength(1);
    const p = t.prefs.load('app');
    await settle();                                                 // the load is queued behind the write
    expect(t.calls.map(([c]) => c)).toEqual(['prefs_write']);
    t.external('app', 'a', '2');                                    // skin-1's write landed first; its event reaches us while we queue
    t.held.shift()?.();                                             // release ours: the file ends at a=3
    expect((await p).get('a')).toBe('3');
    expect(t.calls.map(([c]) => c)).toEqual(['prefs_write', 'prefs_load']);
    expect(t.fileOf('app')).toEqual({ a: '3' });
  });

  it('a load whose read has not started when the store is disposed collects nothing afterwards', async () => {
    const t = setup({ holdWrites: true, holdLoads: true });
    t.prefs.write('app', 'a', '1');
    t.clock.advance(250);
    await settle();                                                 // the write is held, so the read cannot start
    const p = t.prefs.load('app');
    await settle();
    t.prefs.dispose();                                              // before the read starts
    t.held.shift()?.();
    await settle();
    expect(t.heldLoads).toHaveLength(1);                            // the read starts anyway, after dispose
    t.external('app', 'b', '2');                                    // an event after dispose is dropped, not collected
    t.heldLoads.shift()?.();
    expect([...(await p)]).toEqual([['a', '1']]);                   // the file (with our write, landed first), no b
  });

  it('a failed read leaves nothing behind: the next load shows the file only', async () => {
    const t = setup({ files: { app: { zoom: '1' } } });
    t.failing.add('prefs_load');
    const bad = t.prefs.load('app');
    t.external('app', 'zoom', '2');                                 // the file changes while the failing load is pending
    await expect(bad).rejects.toThrow('prefs_load refused');
    t.failing.clear();
    expect((await t.prefs.load('app')).get('zoom')).toBe('2');      // the file, not a leftover of the failed read
  });

  it('carries keys named __proto__ and constructor from events into the load as plain keys', async () => {
    const t = setup({ holdLoads: true });
    const { p: p } = await startHeld(t, SKIN);
    t.external(SKIN, '__proto__', 'p');
    t.external(SKIN, 'constructor', 'c');
    t.heldLoads.shift()?.();
    const m = await p;
    expect([...m]).toEqual([['__proto__', 'p'], ['constructor', 'c']]);
    expect(Object.getPrototypeOf(m)).toBe(Map.prototype);
    expect(/** @type {any} */ ({}).p).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('dispose with a load in flight is harmless: events after it are dropped', async () => {
    const t = setup({ holdLoads: true });
    const { p: p } = await startHeld(t);
    t.prefs.dispose();
    t.external('app', 'zoom', '2');
    t.heldLoads.shift()?.();
    await expect(p).resolves.toBeInstanceOf(Map);
  });
});

describe('write', () => {
  it('is debounced 250 ms: nothing at 249, one call at 250', async () => {
    const t = setup();
    t.prefs.write('app', 'zoom', '1.5');
    t.clock.advance(249);
    await settle();
    expect(t.writes()).toEqual([]);
    expect(t.prefs.pending()).toBe(1);
    t.clock.advance(1);
    await settle();
    expect(t.writes()).toEqual([{ ns: 'app', key: 'zoom', value: '1.5' }]);
    expect(t.prefs.pending()).toBe(0);
  });

  it('coalesces a burst on one key to the latest value, and restarts the wait on each write', async () => {
    const t = setup();
    t.prefs.write('app', 'eq', '[1]');
    t.clock.advance(200);
    t.prefs.write('app', 'eq', '[2]');
    t.clock.advance(200);
    t.prefs.write('app', 'eq', '[3]');
    t.clock.advance(249);
    await settle();
    expect(t.writes()).toEqual([]);
    t.clock.advance(1);
    await settle();
    expect(t.writes()).toEqual([{ ns: 'app', key: 'eq', value: '[3]' }]);
  });

  it('keeps keys and namespaces apart', async () => {
    const t = setup();
    t.prefs.write('app', 'a', '1');
    t.prefs.write('app', 'b', '2');
    t.prefs.write(SKIN, 'a', '3');
    t.clock.advance(250);
    await settle();
    expect(t.writes()).toEqual([
      { ns: 'app', key: 'a', value: '1' },
      { ns: 'app', key: 'b', value: '2' },
      { ns: SKIN, key: 'a', value: '3' },
    ]);
  });

  it('sends null as a delete', async () => {
    const t = setup();
    t.prefs.write('app', 'onTop', null);
    t.clock.advance(250);
    await settle();
    expect(t.writes()).toEqual([{ ns: 'app', key: 'onTop', value: null }]);
  });

  it('writes keys named __proto__ and constructor verbatim, without touching Object.prototype', async () => {
    const t = setup();
    t.prefs.write(SKIN, '__proto__', 'p');
    t.prefs.write(SKIN, 'constructor', 'c');
    t.prefs.write(SKIN, 'hasOwnProperty', 'h');
    // Still waiting out the debounce, they read back as ordinary keys of a Map.
    const m = await t.prefs.load(SKIN);
    expect([...m]).toEqual([['__proto__', 'p'], ['constructor', 'c'], ['hasOwnProperty', 'h']]);
    t.clock.advance(250);
    await settle();
    expect(t.writes()).toEqual([
      { ns: SKIN, key: '__proto__', value: 'p' },
      { ns: SKIN, key: 'constructor', value: 'c' },
      { ns: SKIN, key: 'hasOwnProperty', value: 'h' },
    ]);
    expect(/** @type {any} */ ({}).p).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('throws on arguments of the wrong type, and drops a bad namespace with a note', () => {
    const t = setup();
    expect(() => t.prefs.write(/** @type {any} */ (1), 'k', 'v')).toThrow(TypeError);
    expect(() => t.prefs.write('app', /** @type {any} */ (null), 'v')).toThrow(TypeError);
    expect(() => t.prefs.write('app', 'k', /** @type {any} */ (5))).toThrow(TypeError);
    t.prefs.write('__proto__', 'k', 'v');
    t.prefs.write('some-other-skin', 'k', 'v');
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['namespace', 'namespace']);
    expect(t.prefs.pending()).toBe(0);
  });

  it('sends the IPC calls one after another, in order, even when one is slow', async () => {
    const t = setup({ holdWrites: true });
    t.prefs.write('app', 'a', '1');
    t.clock.advance(100);
    t.prefs.write('app', 'b', '2');
    t.clock.advance(150);                                          // a is due
    await settle();
    expect(t.writes()).toHaveLength(1);
    t.clock.advance(100);                                          // b is due while a is still in flight
    await settle();
    expect(t.writes()).toHaveLength(1);                            // b waits behind a
    t.held.shift()?.();
    await settle();
    expect(t.writes().map((w) => w.key)).toEqual(['a', 'b']);
    t.held.shift()?.();
  });

  it('a load waits for the writes already on their way', async () => {
    const t = setup({ holdWrites: true });
    t.prefs.write('app', 'a', '1');
    t.clock.advance(250);
    await settle();
    let loaded = false;
    const p = t.prefs.load('app').then(() => { loaded = true; });
    await settle();
    expect(loaded).toBe(false);
    t.held.shift()?.();
    await p;
    expect(t.calls.map(([c]) => c)).toEqual(['prefs_write', 'prefs_load']);
  });

  it('flush() sends everything pending now', async () => {
    const t = setup();
    t.prefs.write('app', 'a', '1');
    t.prefs.write(SKIN, 'b', '2');
    await t.prefs.flush();
    expect(t.writes()).toHaveLength(2);
    expect(t.prefs.pending()).toBe(0);
    t.clock.advance(1000);
    await settle();
    expect(t.writes()).toHaveLength(2);                            // the timers were cancelled
  });

  it('survives a failed write: it is logged and the next one still goes', async () => {
    const t = setup();
    t.failing.add('prefs_write');
    t.prefs.write('app', 'a', '1');
    t.clock.advance(250);
    await settle();
    expect(t.warnings.map(([m]) => m)).toEqual(['prefs: prefs_write failed: prefs_write refused']);
    t.failing.clear();
    t.prefs.write('app', 'b', '2');
    t.clock.advance(250);
    await settle();
    expect(t.writes().map((w) => w.key)).toEqual(['a', 'b']);
  });

  it('dispose cancels what is pending', async () => {
    const t = setup();
    t.prefs.write('app', 'a', '1');
    t.prefs.dispose();
    t.clock.advance(1000);
    await settle();
    expect(t.writes()).toEqual([]);
    t.prefs.write('app', 'b', '2');                                // ignored after dispose
    expect(t.prefs.pending()).toBe(0);
  });
});

describe('caps (D6.4)', () => {
  const big = (/** @type {number} */ n) => 'x'.repeat(n);

  it('drops a key over 256 bytes and a value over 4 KiB, counted in UTF-8 bytes', async () => {
    const t = setup();
    t.prefs.write('app', big(256), 'ok');
    t.prefs.write('app', big(257), 'no');
    t.prefs.write('app', 'é'.repeat(129), 'no');               // 258 bytes
    t.prefs.write('app', 'v', big(4096));
    t.prefs.write('app', 'w', big(4097));
    t.prefs.write('app', 'u', 'é'.repeat(2049));              // 4098 bytes
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-bytes', 'key-bytes', 'value-bytes', 'value-bytes']);
    t.clock.advance(250);
    await settle();
    expect(t.writes().map((w) => w.key.length)).toEqual([256, 1]);
  });

  it('drops the 257th key of a loaded namespace but still allows changing and deleting existing ones', async () => {
    const files = { app: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, '1'])) };
    const t = setup({ files });
    await t.prefs.load('app');
    t.prefs.write('app', 'one-too-many', '1');
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
    t.prefs.write('app', 'k0', '2');
    t.prefs.write('app', 'k1', null);
    t.prefs.write('app', 'fits-now', '1');                          // k1's slot is free again
    expect(t.prefs.rejected).toHaveLength(1);
    expect(t.prefs.pending()).toBe(3);
  });

  it('drops a write that would take the namespace over 64 KiB', async () => {
    const entries = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${String(i).padStart(2, '0')}`, big(4096)]));
    const t = setup({ files: { app: entries } });
    await t.prefs.load('app');                                      // 15 * (3 + 4096) = 61,485 bytes
    t.prefs.write('app', 'k15', big(4096));                         // 65,584 > 65,536
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['namespace-bytes']);
    t.prefs.write('app', 'k15', big(3000));                         // 64,488: fits
    t.prefs.write('app', 'k00', big(4096));                         // a rewrite counts its old size out
    expect(t.prefs.rejected).toHaveLength(1);
  });

  it('can only check the per-item caps before a namespace is loaded (Rust enforces the rest)', () => {
    const t = setup({ caps: { maxKeys: 1 } });
    t.prefs.write('app', 'a', '1');
    t.prefs.write('app', 'b', '1');
    expect(t.prefs.rejected).toEqual([]);
    expect(t.prefs.pending()).toBe(2);
  });

  it('honours lowered caps from the options', async () => {
    const t = setup({ caps: { maxValueBytes: 4 } });
    t.prefs.write('app', 'a', '12345');
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['value-bytes']);
  });

  it('remembers only the last 64 rejections', () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.prefs.write('app', 'k', big(5000 + i));
    expect(t.prefs.rejected).toHaveLength(64);
  });
});

describe('prefs-changed from other windows', () => {
  it('reaches onExternalChange subscribers of that namespace only', async () => {
    const t = setup();
    /** @type {Array<[string, string | null]>} */
    const app = [];
    /** @type {Array<[string, string | null]>} */
    const skin = [];
    t.prefs.onExternalChange('app', (k, v) => app.push([k, v]));
    t.prefs.onExternalChange(SKIN, (k, v) => skin.push([k, v]));
    t.external('app', 'zoom', '2');
    t.external(SKIN, 'score', '9');
    t.external('app', 'zoom', null);
    t.external(OTHER_SKIN, 'x', '1');
    expect(app).toEqual([['zoom', '2'], ['zoom', null]]);
    expect(skin).toEqual([['score', '9']]);
  });

  it('ignores this window\'s own writes echoed back', () => {
    const t = setup();
    /** @type {unknown[]} */
    const heard = [];
    t.prefs.onExternalChange('app', (k, v) => heard.push([k, v]));
    t.emit({ ns: 'app', key: 'zoom', value: '2', window: 'main' });
    expect(heard).toEqual([]);
  });

  it('listens to the prefs-changed event once, however many subscribers there are', () => {
    const t = setup();
    t.prefs.onExternalChange('app', () => {});
    t.prefs.onExternalChange('app', () => {});
    t.prefs.onExternalChange(SKIN, () => {});
    expect(t.listened.events).toEqual(['prefs-changed']);
  });

  it('delivers keys named __proto__ and constructor as ordinary keys', () => {
    const t = setup();
    /** @type {Array<[string, string | null]>} */
    const heard = [];
    t.prefs.onExternalChange(SKIN, (k, v) => heard.push([k, v]));
    t.external(SKIN, '__proto__', 'p');
    t.external(SKIN, 'constructor', 'c');
    expect(heard).toEqual([['__proto__', 'p'], ['constructor', 'c']]);
    expect(/** @type {any} */ ({}).p).toBeUndefined();
  });

  it('stops after the unsubscribe, and one throwing subscriber does not stop the rest', () => {
    const t = setup();
    let a = 0;
    let b = 0;
    t.prefs.onExternalChange('app', () => { throw new Error('boom'); });
    const offA = t.prefs.onExternalChange('app', () => { a++; });
    t.prefs.onExternalChange('app', () => { b++; });
    t.external('app', 'k', '1');
    offA();
    t.external('app', 'k', '2');
    expect([a, b]).toEqual([1, 2]);
    expect(t.warnings).toHaveLength(2);
  });

  it('updates the cache, so a later load-free write is checked against the new contents', async () => {
    const t = setup({ files: { app: { a: '1' } }, caps: { maxKeys: 2 } });
    await t.prefs.load('app');
    t.external('app', 'b', '1');                                    // another window added a key
    t.prefs.write('app', 'c', '1');                                 // a third key: over the cap of 2
    expect(t.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
    t.external('app', 'b', null);
    t.prefs.write('app', 'c', '1');
    expect(t.prefs.rejected).toHaveLength(1);
  });

  it('ignores a malformed event', () => {
    const t = setup();
    let heard = 0;
    t.prefs.onExternalChange('app', () => { heard++; });
    for (const bad of [null, undefined, 'x', 5, {}, { ns: 'app' }, { ns: 'app', key: 1, value: 'v', window: 'w' },
      { ns: 'app', key: 'k', value: 5, window: 'w' }, { ns: 'nope', key: 'k', value: 'v', window: 'w' }]) {
      t.emit(bad);
    }
    expect(heard).toBe(0);
  });

  it('dispose unlistens', async () => {
    const t = setup();
    t.prefs.onExternalChange('app', () => {});
    await settle();
    t.prefs.dispose();
    await settle();
    expect(t.listened.unlistened).toBe(1);
  });
});
