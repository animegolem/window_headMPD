// @ts-check
import { describe, expect, it } from 'vitest';
import {
  BALANCE_DETENT, EQ_BANDS, EQ_LIMIT_DB, PREFS_NS, PREF_KEY_BALANCE, PREF_KEY_EQ, createTauriDsp,
} from '../../../src/hosts/tauri/dsp.js';
import * as fakeDsp from '../../../src/hosts/test/dsp.js';
import { createMemoryPrefs } from '../../../src/hosts/test/prefs.js';

/** @typedef {import('../../../src/engine/contracts').PrefStore} PrefStore */

const ZEROS = Array(10).fill(0);

/** A recorded `invoke`: every call in order, replies with undefined. */
function recordedInvoke() {
  /** @type {Array<[string, Record<string, unknown> | undefined]>} */
  const calls = [];
  /** @type {unknown} */
  let failure = null;
  /** @param {string} cmd @param {Record<string, unknown>} [args] */
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (failure) throw failure;
    return undefined;
  };
  return {
    invoke,
    calls,
    /** Calls after the boot-time pair. */
    since: (/** @type {number} */ n) => calls.slice(n),
    failWith: (/** @type {unknown} */ e) => { failure = e; },
  };
}

/**
 * @param {Record<string, string>} [saved] the `app` namespace as it was on disk
 */
async function boot(saved = {}) {
  const prefs = createMemoryPrefs();
  prefs.seed(PREFS_NS, saved);
  const warnings = /** @type {Array<[string, object | undefined]>} */ ([]);
  const rec = recordedInvoke();
  const dsp = await createTauriDsp(rec.invoke, prefs, { log: { warn: (m, d) => { warnings.push([m, d]); } } });
  return { dsp, prefs, warnings, ...rec, booted: rec.calls.length };
}

describe('constants', () => {
  it('are the D11 / parity D17 numbers, and the test host\'s', () => {
    expect([EQ_BANDS, EQ_LIMIT_DB, BALANCE_DETENT]).toEqual([10, 14, 5]);
    expect([EQ_BANDS, EQ_LIMIT_DB, BALANCE_DETENT]).toEqual([fakeDsp.EQ_BANDS, fakeDsp.EQ_LIMIT_DB, fakeDsp.BALANCE_DETENT]);
  });
});

describe('boot', () => {
  it('starts flat and centred, with the EQ live, and sends both to the audio path once (main.js:134-135)', async () => {
    const r = await boot();
    expect(r.dsp.eq.gains()).toEqual(ZEROS);
    expect(r.dsp.balance.get()).toBe(0);
    expect(r.dsp.eq.bypass()).toBe(false);
    expect(r.calls).toEqual([['set_eq', { gains: ZEROS }], ['set_balance', { balance: 0 }]]);
    expect(r.prefs.writes).toEqual([]);                                 // nothing to save yet
  });

  it('reads the values migrate.js copies verbatim from the legacy localStorage (JSON text)', async () => {
    const gains = [1, -2, 3, -4, 5, -6, 7, -8, 9, -14];
    const r = await boot({ [PREF_KEY_EQ]: JSON.stringify(gains), [PREF_KEY_BALANCE]: '-40' });
    expect(r.dsp.eq.gains()).toEqual(gains);
    expect(r.dsp.balance.get()).toBe(-40);
    expect(r.calls).toEqual([['set_eq', { gains }], ['set_balance', { balance: -40 }]]);
  });

  it('loads the `app` namespace and nothing else', async () => {
    const prefs = createMemoryPrefs();
    /** @type {string[]} */
    const loaded = [];
    /** @type {PrefStore} */
    const spy = { ...prefs, load: async (ns) => { loaded.push(ns); return prefs.load(ns); } };
    await createTauriDsp(recordedInvoke().invoke, spy);
    expect(loaded).toEqual(['app']);
  });

  it('survives unreadable saved values: flat EQ, centred balance', async () => {
    for (const eq of ['not json', '{"a":1}', 'null', '"[0]"', '']) {
      const r = await boot({ [PREF_KEY_EQ]: eq, [PREF_KEY_BALANCE]: eq });
      expect(r.dsp.eq.gains(), eq).toEqual(ZEROS);
      expect(r.dsp.balance.get(), eq).toBe(0);
    }
  });

  it('pads a short array, cuts a long one, zeroes non-numbers and clamps to ±14', async () => {
    const r = await boot({ [PREF_KEY_EQ]: JSON.stringify([20, -20, 'x', null, 5]) });
    expect(r.dsp.eq.gains()).toEqual([14, -14, 0, 0, 5, 0, 0, 0, 0, 0]);
    const long = await boot({ [PREF_KEY_EQ]: JSON.stringify(Array(25).fill(1)) });
    expect(long.dsp.eq.gains()).toEqual(Array(10).fill(1));
  });

  it('a saved balance goes through the same clamp and detent as a live write', async () => {
    expect((await boot({ [PREF_KEY_BALANCE]: '3' })).dsp.balance.get()).toBe(0);
    expect((await boot({ [PREF_KEY_BALANCE]: '250' })).dsp.balance.get()).toBe(100);
    expect((await boot({ [PREF_KEY_BALANCE]: '"40"' })).dsp.balance.get()).toBe(0);
  });

  it('a failing prefs load starts flat and says so', async () => {
    const prefs = createMemoryPrefs();
    /** @type {PrefStore} */
    const broken = { ...prefs, load: async () => { throw new Error('disk gone'); } };
    const warnings = /** @type {Array<[string, object | undefined]>} */ ([]);
    const rec = recordedInvoke();
    const dsp = await createTauriDsp(rec.invoke, broken, { log: { warn: (m, d) => { warnings.push([m, d]); } } });
    expect(dsp.eq.gains()).toEqual(ZEROS);
    expect(warnings).toHaveLength(1);
    expect(rec.calls).toHaveLength(2);
  });
});

describe('equalizer', () => {
  it('set_eq receives all ten gains on each band change', async () => {
    const r = await boot();
    r.dsp.eq.setGain(3, 6);
    r.dsp.eq.setGain(9, -2.5);
    expect(r.since(r.booted)).toEqual([
      ['set_eq', { gains: [0, 0, 0, 6, 0, 0, 0, 0, 0, 0] }],
      ['set_eq', { gains: [0, 0, 0, 6, 0, 0, 0, 0, 0, -2.5] }],
    ]);
    expect(r.since(r.booted).every(([, a]) => /** @type {number[]} */ (a?.gains).length === 10)).toBe(true);
  });

  it('clamps to ±14 dB', async () => {
    const r = await boot();
    r.dsp.eq.setGain(0, 99);
    r.dsp.eq.setGain(1, -99);
    expect(r.dsp.eq.gains().slice(0, 2)).toEqual([14, -14]);
    expect(r.since(r.booted).at(-1)?.[1]).toEqual({ gains: [14, -14, 0, 0, 0, 0, 0, 0, 0, 0] });
  });

  it('persists the legacy format (a JSON array) in the app namespace, once per change', async () => {
    const r = await boot();
    r.dsp.eq.setGain(2, 4);
    r.dsp.eq.setGain(2, 4);
    expect(r.prefs.writes).toEqual([{ ns: 'app', key: 'eq', value: '[0,0,4,0,0,0,0,0,0,0]' }]);
    expect(JSON.parse(/** @type {string} */ (r.prefs.peek('app').get('eq')))).toEqual(r.dsp.eq.gains());
  });

  it('what was saved is what the next boot reads back', async () => {
    const first = await boot();
    first.dsp.eq.setGain(0, 7);
    first.dsp.eq.setGain(9, -3);
    const second = await boot(Object.fromEntries(first.prefs.peek('app')));
    expect(second.dsp.eq.gains()).toEqual(first.dsp.eq.gains());
  });

  it('an unchanged gain sends nothing, saves nothing and notifies nobody', async () => {
    const r = await boot();
    let changes = 0;
    r.dsp.eq.onChange(() => changes++);
    r.dsp.eq.setGain(2, 0);
    r.dsp.eq.setGain(2, 3);
    r.dsp.eq.setGain(2, 3);
    r.dsp.eq.reset();
    r.dsp.eq.reset();
    expect(changes).toBe(2);
    expect(r.since(r.booted)).toHaveLength(2);
    expect(r.prefs.writes).toHaveLength(2);
  });

  it('a gain dragged past the limit while already at it changes nothing: no IPC, no save, no announcement', async () => {
    const r = await boot();
    r.dsp.eq.setGain(4, 14);
    r.dsp.eq.setGain(5, -14);
    let changes = 0;
    r.dsp.eq.onChange(() => changes++);
    const sent = r.calls.length;
    const saved = r.prefs.writes.length;
    r.dsp.eq.setGain(4, 18);
    r.dsp.eq.setGain(4, 99);
    r.dsp.eq.setGain(5, -18);
    expect(r.dsp.eq.gains().slice(4, 6)).toEqual([14, -14]);
    expect(changes).toBe(0);
    expect(r.calls).toHaveLength(sent);                                 // the DSP already has the limit
    expect(r.prefs.writes).toHaveLength(saved);
  });

  it('a gain clamped on the way in that moves the stored value is announced once, with the clamped value', async () => {
    const r = await boot();
    r.dsp.eq.setGain(4, 3);
    /** @type {number[]} */
    const seen = [];
    r.dsp.eq.onChange(() => seen.push(r.dsp.eq.gains()[4]));
    r.dsp.eq.setGain(4, 20);                                            // 3 -> 14
    r.dsp.eq.setGain(4, 20);                                            // 14 -> 14: silent
    r.dsp.eq.setGain(4, -20);                                           // 14 -> -14
    expect(seen).toEqual([14, -14]);
    expect(r.since(r.booted).map(([, a]) => /** @type {number[]} */ (a?.gains)[4])).toEqual([3, 14, -14]);
  });

  it('reset zeroes all ten, sends them and saves them', async () => {
    const r = await boot({ [PREF_KEY_EQ]: JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) });
    r.dsp.eq.reset();
    expect(r.dsp.eq.gains()).toEqual(ZEROS);
    expect(r.since(r.booted)).toEqual([['set_eq', { gains: ZEROS }]]);
    expect(r.prefs.peek('app').get('eq')).toBe(JSON.stringify(ZEROS));
  });

  it('rejects a band outside 0..9 and ignores a non-finite or non-number gain', async () => {
    const r = await boot();
    for (const band of [-1, 10, 1.5, NaN]) expect(() => r.dsp.eq.setGain(band, 1)).toThrow(RangeError);
    r.dsp.eq.setGain(0, NaN);
    r.dsp.eq.setGain(0, Infinity);
    // @ts-expect-error a skin could pass anything
    r.dsp.eq.setGain(0, '5');
    expect(r.dsp.eq.gains()).toEqual(ZEROS);
    expect(r.since(r.booted)).toEqual([]);
  });

  it('gains() is a frozen snapshot', async () => {
    const r = await boot();
    const before = r.dsp.eq.gains();
    r.dsp.eq.setGain(1, 5);
    expect(before[1]).toBe(0);
    expect(() => /** @type {number[]} */ (before).push(1)).toThrow();
  });

  it('bypass defaults to false, is announced, reaches no audio call and is not persisted (phase 1)', async () => {
    const r = await boot();
    let changes = 0;
    r.dsp.eq.onChange(() => changes++);
    r.dsp.eq.setBypass(false);
    r.dsp.eq.setBypass(true);
    r.dsp.eq.setBypass(true);
    expect(r.dsp.eq.bypass()).toBe(true);
    expect(changes).toBe(1);
    expect(r.since(r.booted)).toEqual([]);
    expect(r.prefs.writes).toEqual([]);
    expect((await boot(Object.fromEntries(r.prefs.peek('app')))).dsp.eq.bypass()).toBe(false);
  });

  it('unsubscribe stops notifications; a throwing listener does not starve the rest or fail the write', async () => {
    const r = await boot();
    let a = 0;
    let b = 0;
    const off = r.dsp.eq.onChange(() => a++);
    r.dsp.eq.onChange(() => { throw new Error('listener'); });
    r.dsp.eq.onChange(() => b++);
    r.dsp.eq.setGain(0, 1);
    expect([a, b]).toEqual([1, 1]);
    expect(r.warnings.map((w) => w[0])).toEqual(['dsp: a listener threw']);
    off();
    r.dsp.eq.setGain(0, 2);
    expect([a, b]).toEqual([1, 2]);
    expect(r.dsp.eq.gains()[0]).toBe(2);
  });
});

describe('balance', () => {
  it('balance 4 goes to the DSP as 0, and the stored value snaps to 0', async () => {
    const r = await boot();
    r.dsp.balance.set(40);
    r.dsp.balance.set(4);                                               // dragged back through the centre
    expect(r.since(r.booted)).toEqual([['set_balance', { balance: 40 }], ['set_balance', { balance: 0 }]]);
    expect(r.dsp.balance.get()).toBe(0);
    expect(r.prefs.peek('app').get('balance')).toBe('0');
  });

  it.each([
    [4, 0], [5, 0], [-5, 0], [-4, 0], [0, 0],
    [6, 6], [-6, -6], [40, 40], [100, 100], [-100, -100],
    [250, 100], [-250, -100],
  ])('set(%d) stores %d, as the test host does', async (input, stored) => {
    const r = await boot();
    r.dsp.balance.set(input);
    expect(r.dsp.balance.get()).toBe(stored);
    const fake = fakeDsp.createFakeDsp();
    fake.balance.set(input);
    expect(r.dsp.balance.get()).toBe(fake.balance.get());
  });

  it('persists the legacy format (a JSON number) in the app namespace', async () => {
    const r = await boot();
    r.dsp.balance.set(-37);
    expect(r.prefs.writes).toEqual([{ ns: 'app', key: 'balance', value: '-37' }]);
    expect((await boot(Object.fromEntries(r.prefs.peek('app')))).dsp.balance.get()).toBe(-37);
  });

  it('a value inside the detent while centred changes nothing: no IPC, no save, no announcement', async () => {
    const r = await boot();
    let changes = 0;
    r.dsp.balance.onChange(() => changes++);
    r.dsp.balance.set(3);
    r.dsp.balance.set(-5);
    r.dsp.balance.set(0);
    expect(r.since(r.booted)).toEqual([]);
    expect(r.prefs.writes).toEqual([]);
    expect(changes).toBe(0);
  });

  it('a detented write that moves the stored value is announced once, with the value the DSP got', async () => {
    const r = await boot();
    r.dsp.balance.set(40);
    /** @type {number[]} */
    const seen = [];
    r.dsp.balance.onChange(() => seen.push(r.dsp.balance.get()));
    r.dsp.balance.set(4);                                               // 40 -> 0: dragged back through the centre
    r.dsp.balance.set(-3);                                              // 0 -> 0: silent
    expect(seen).toEqual([0]);
    expect(r.since(r.booted)).toEqual([['set_balance', { balance: 40 }], ['set_balance', { balance: 0 }]]);
  });

  it('a value past the end while already there changes nothing', async () => {
    const r = await boot();
    r.dsp.balance.set(100);
    let changes = 0;
    r.dsp.balance.onChange(() => changes++);
    const sent = r.calls.length;
    r.dsp.balance.set(250);
    expect(r.dsp.balance.get()).toBe(100);
    expect(changes).toBe(0);
    expect(r.calls).toHaveLength(sent);
  });

  it('an unchanged value is a no-op', async () => {
    const r = await boot();
    r.dsp.balance.set(30);
    let changes = 0;
    r.dsp.balance.onChange(() => changes++);
    r.dsp.balance.set(30);
    expect(changes).toBe(0);
    expect(r.since(r.booted)).toEqual([['set_balance', { balance: 30 }]]);
  });

  it('ignores non-finite and non-number input', async () => {
    const r = await boot();
    r.dsp.balance.set(30);
    r.dsp.balance.set(NaN);
    r.dsp.balance.set(Infinity);
    // @ts-expect-error a skin could pass anything
    r.dsp.balance.set('50');
    expect(r.dsp.balance.get()).toBe(30);
    expect(r.since(r.booted)).toEqual([['set_balance', { balance: 30 }]]);
  });

  it('unsubscribe stops notifications', async () => {
    const r = await boot();
    let a = 0;
    const off = r.dsp.balance.onChange(() => a++);
    r.dsp.balance.set(10);
    off();
    r.dsp.balance.set(20);
    expect(a).toBe(1);
  });
});

describe('onChange parity with the test host', () => {
  /** One write: an EQ gain (band, dB) or a balance. @typedef {['eq', number, number] | ['balance', number] | ['reset']} Write */
  /** @type {Write[]} */
  const writes = [
    ['eq', 0, 0], ['eq', 0, 5], ['eq', 0, 5], ['eq', 0, 20], ['eq', 0, 14], ['eq', 0, 99], ['eq', 0, -99], ['eq', 0, -14],
    ['eq', 3, 2.5], ['reset'], ['reset'],
    ['balance', 0], ['balance', 3], ['balance', 40], ['balance', 4], ['balance', -5], ['balance', 100], ['balance', 250],
    ['balance', -250], ['balance', -100], ['balance', 6],
  ];

  it('fires exactly when the test host does, write for write, and ends in the same state', async () => {
    const real = (await boot()).dsp;
    const fake = fakeDsp.createFakeDsp();
    /** @type {Array<[string, number]>} */
    const realLog = [];
    /** @type {Array<[string, number]>} */
    const fakeLog = [];
    let n = 0;
    real.eq.onChange(() => realLog.push(['eq', n]));
    real.balance.onChange(() => realLog.push(['balance', n]));
    fake.eq.onChange(() => fakeLog.push(['eq', n]));
    fake.balance.onChange(() => fakeLog.push(['balance', n]));
    for (const w of writes) {
      if (w[0] === 'eq') { real.eq.setGain(w[1], w[2]); fake.eq.setGain(w[1], w[2]); }
      else if (w[0] === 'balance') { real.balance.set(w[1]); fake.balance.set(w[1]); }
      else { real.eq.reset(); fake.eq.reset(); }
      n++;
    }
    expect(realLog).toEqual(fakeLog);
    expect(realLog.length).toBeGreaterThan(0);
    expect(real.eq.gains()).toEqual(fake.eq.gains());
    expect(real.balance.get()).toBe(fake.balance.get());
  });
});

describe('failures', () => {
  it('a rejected invoke is logged, never thrown, and the state still moves', async () => {
    const r = await boot();
    r.failWith(new Error('audio engine busy'));
    r.dsp.eq.setGain(0, 5);
    r.dsp.balance.set(20);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.dsp.eq.gains()[0]).toBe(5);
    expect(r.dsp.balance.get()).toBe(20);
    expect(r.warnings.map((w) => w[0])).toEqual(['dsp: set_eq failed', 'dsp: set_balance failed']);
  });

  it('a synchronous throw from invoke is contained too', async () => {
    const prefs = createMemoryPrefs();
    const warnings = /** @type {string[]} */ ([]);
    let armed = false;
    const dsp = await createTauriDsp(() => { if (armed) throw new Error('no ipc'); }, prefs, { log: { warn: (m) => { warnings.push(m); } } });
    armed = true;
    dsp.eq.setGain(1, 3);
    expect(dsp.eq.gains()[1]).toBe(3);
    expect(warnings).toEqual(['dsp: set_eq failed']);
  });

  it('a prefs write that throws is logged and does not undo the change', async () => {
    const prefs = createMemoryPrefs();
    /** @type {PrefStore} */
    const bad = { ...prefs, write: () => { throw new TypeError('bad write'); } };
    const warnings = /** @type {string[]} */ ([]);
    const dsp = await createTauriDsp(recordedInvoke().invoke, bad, { log: { warn: (m) => { warnings.push(m); } } });
    dsp.balance.set(25);
    expect(dsp.balance.get()).toBe(25);
    expect(warnings).toEqual(['dsp: could not save balance']);
  });

  it('prefs caps are the store\'s business: an over-cap write is dropped there and the DSP is unaffected', async () => {
    const prefs = createMemoryPrefs({ caps: { maxValueBytes: 4 } });
    const rec = recordedInvoke();
    const dsp = await createTauriDsp(rec.invoke, prefs);
    dsp.eq.setGain(0, 5);                                               // "[5,0,...]" is over 4 bytes
    expect(dsp.eq.gains()[0]).toBe(5);
    expect(prefs.rejected).toHaveLength(1);
    expect(rec.calls.at(-1)).toEqual(['set_eq', { gains: [5, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
  });
});
