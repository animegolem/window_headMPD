// @ts-check
import { describe, expect, it } from 'vitest';
import { createLedger } from '../../../src/engine/model/ledger.js';
import {
  COALESCE_MS, HOLD_MS, PREF_CAPS, RATE_LIMIT, RATE_WINDOW_MS, TIMER_INTERVAL_MIN_MS, createPolicies, utf8Length,
} from '../../../src/engine/model/policy.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';

/** @param {{ gesture?: boolean }} [opts] */
function make(opts = {}) {
  const clock = createManualClock();
  const ledger = createLedger('s');
  /** @type {Array<[string, string]>} */
  const denied = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const infos = [];
  const state = { gesture: opts.gesture ?? false };
  const policy = createPolicies({
    clock,
    ledger,
    actions: { run() {}, denied: (api, detail) => { denied.push([api, detail]); }, fault() {} },
    inGesture: () => state.gesture,
    log: { info: (m) => { infos.push(m); }, warn: (m) => { warnings.push(m); }, diag() {} },
  });
  return { clock, ledger, policy, denied, warnings, infos, state };
}

describe('the numbers are the contract’s', () => {
  it('D6.5, D6.4 and spec 6.2', () => {
    expect([RATE_LIMIT, RATE_WINDOW_MS, COALESCE_MS, TIMER_INTERVAL_MIN_MS]).toEqual([10, 1000, 40, 50]);
    expect(PREF_CAPS).toEqual({ maxKeys: 256, maxKeyBytes: 256, maxValueBytes: 4096, maxNamespaceBytes: 65536 });
    expect(HOLD_MS).toBeGreaterThan(COALESCE_MS);
  });
});

describe('deny-log', () => {
  it('ledgers every attempt and raises one host notice per api', () => {
    const { policy, ledger, denied } = make();
    policy.denied('player.launchURL', 'https://a');
    policy.denied('player.launchURL', 'https://b');
    policy.denied('player.URL', 'x');
    policy.denied('player.launchURL', 'https://c');
    expect(denied).toEqual([['player.launchURL', 'https://a'], ['player.URL', 'x']]);
    expect(ledger.entries()).toEqual([
      { api: 'player.launchURL', kind: 'denied', count: 3, detail: 'https://a' },
      { api: 'player.URL', kind: 'denied', count: 1, detail: 'x' },
    ]);
  });

  it('announces by the policy’s own record, not by what a ledger returns', () => {
    const clock = createManualClock();
    /** @type {string[]} */
    const notices = [];
    const voidLedger = { record() {}, entries: () => [] };      // a Ledger whose record returns nothing
    const policy = createPolicies({ clock, ledger: voidLedger, actions: { run() {}, denied: (a) => { notices.push(a); }, fault() {} }, inGesture: () => false });
    policy.denied('a', '');
    policy.denied('a', '');
    expect(notices).toEqual(['a']);
  });
});

describe('gesture-only', () => {
  it('inGesture() is the authority', () => {
    const { policy, state, ledger } = make();
    expect(policy.gesture()).toBe(false);
    expect(policy.requireGesture('view.close', 'outside a gesture')).toBe(false);
    expect(ledger.entries()[0]).toMatchObject({ api: 'view.close', kind: 'denied' });
    state.gesture = true;
    expect(policy.gesture()).toBe(true);
    expect(policy.requireGesture('view.close', 'x')).toBe(true);
  });

  it('the call context’s own flag counts too, and a missing context is no gesture', () => {
    const { policy } = make();
    expect(policy.gesture({ gesture: true })).toBe(true);
    expect(policy.gesture({ gesture: false })).toBe(false);
    expect(policy.gesture({})).toBe(false);
    expect(policy.gesture(undefined)).toBe(false);
    expect(policy.requireGesture('a', 'b', { gesture: true })).toBe(true);
  });

  it('a truthy but non-true flag is not a gesture (a skin cannot pass one)', () => {
    const { policy } = make();
    expect(policy.gesture(/** @type {any} */ ({ gesture: 1 }))).toBe(false);
    expect(policy.gesture(/** @type {any} */ ({ gesture: 'yes' }))).toBe(false);
  });
});

describe('rate-mpd (acceptance 5)', () => {
  it('admits ten per second per verb and drops the eleventh with a cap entry', () => {
    const { policy, ledger } = make();
    const admitted = Array.from({ length: 11 }, () => policy.admit('next', 'player.controls.next'));
    expect(admitted.filter(Boolean)).toHaveLength(10);
    expect(admitted[10]).toBe(false);
    expect(ledger.entries()).toEqual([expect.objectContaining({ api: 'player.controls.next', kind: 'cap', count: 1 })]);
  });

  it('the allowance returns exactly one second after the first command', () => {
    const { policy, clock } = make();
    for (let i = 0; i < 10; i++) { policy.admit('v', 'a'); clock.advance(10); }          // sends at 0, 10, ... 90
    expect(policy.admit('v', 'a')).toBe(false);                                           // t = 100
    clock.advance(899);                                                                    // t = 999
    expect(policy.admit('v', 'a')).toBe(false);
    clock.advance(1);                                                                      // t = 1000: the first expired
    expect(policy.admit('v', 'a')).toBe(true);
    expect(policy.admit('v', 'a')).toBe(false);                                           // the 10 ms one is still inside
    clock.advance(10);
    expect(policy.admit('v', 'a')).toBe(true);
  });

  it('verbs do not share an allowance', () => {
    const { policy } = make();
    for (let i = 0; i < 10; i++) policy.admit('play', 'a');
    expect(policy.admit('play', 'a')).toBe(false);
    expect(policy.admit('pause', 'a')).toBe(true);
  });

  it('verbs named __proto__ and constructor are ordinary verbs', () => {
    const { policy } = make();
    for (let i = 0; i < 10; i++) expect(policy.admit('__proto__', 'a')).toBe(true);
    expect(policy.admit('__proto__', 'a')).toBe(false);
    expect(policy.admit('constructor', 'a')).toBe(true);
  });
});

describe('coalescing: seek and volume (acceptance 5)', () => {
  it('sends the latest value once, 40 ms after the last write', () => {
    const { policy, clock } = make();
    /** @type {number[]} */
    const sent = [];
    policy.coalesce('seek', 'a', 1, (v) => sent.push(v));
    clock.advance(10);
    policy.coalesce('seek', 'a', 2, (v) => sent.push(v));
    clock.advance(10);
    policy.coalesce('seek', 'a', 3, (v) => sent.push(v));
    clock.advance(39);
    expect(sent).toEqual([]);                                                              // 40 ms from the first write has passed
    clock.advance(1);
    expect(sent).toEqual([3]);
    clock.advance(1000);
    expect(sent).toEqual([3]);                                                             // once
  });

  it('is a trailing debounce: a stream of writes under 40 ms apart sends nothing until it stops', () => {
    const { policy, clock } = make();
    /** @type {Array<[number, number]>} time and value of each send */
    const sent = [];
    for (let i = 1; i <= 10; i++) {
      policy.coalesce('seek', 'a', i, (v) => sent.push([clock.now(), v]));
      clock.advance(30);
    }
    expect(sent).toEqual([]);                                                              // 300 ms of writing, nothing sent
    const lastWrite = clock.now() - 30;
    clock.advance(9);
    expect(sent).toEqual([]);
    clock.advance(1);
    expect(sent).toEqual([[lastWrite + 40, 10]]);                                          // 40 ms after the last write, the last value
    expect(clock.pendingTimers()).toBe(0);
  });

  it('each write re-arms one timer, it does not stack them', () => {
    const { policy, clock } = make();
    for (let i = 0; i < 20; i++) {
      policy.coalesce('v', 'a', i, () => {});
      expect(clock.pendingTimers()).toBe(1);
      clock.advance(5);
    }
    policy.dispose();
    expect(clock.pendingTimers()).toBe(0);
  });

  it('verbs debounce independently', () => {
    const { policy, clock } = make();
    /** @type {string[]} */
    const sent = [];
    policy.coalesce('seek', 'a', 1, (v) => sent.push(`seek ${v}`));
    clock.advance(30);
    policy.coalesce('volume', 'b', 2, (v) => sent.push(`volume ${v}`));
    clock.advance(10);
    expect(sent).toEqual(['seek 1']);                                                      // a write to volume did not restart seek
    clock.advance(30);
    expect(sent).toEqual(['seek 1', 'volume 2']);
  });

  it('a later batch is a new batch', () => {
    const { policy, clock } = make();
    /** @type {number[]} */
    const sent = [];
    policy.coalesce('v', 'a', 1, (x) => sent.push(x));
    clock.advance(40);
    policy.coalesce('v', 'a', 2, (x) => sent.push(x));
    clock.advance(40);
    expect(sent).toEqual([1, 2]);
  });

  it('pending() answers with the written value until MPD echoes it, then lets go', () => {
    const { policy, clock } = make();
    expect(policy.pending('v')).toBeUndefined();
    policy.coalesce('v', 'a', 42, () => {});
    expect(policy.pending('v')).toBe(42);
    clock.advance(40);
    expect(policy.pending('v')).toBe(42);                                                  // sent, not yet echoed
    policy.settle('v');
    expect(policy.pending('v')).toBeUndefined();
  });

  it('an echo that never comes stops being waited for after the hold', () => {
    const { policy, clock } = make();
    policy.coalesce('v', 'a', 42, () => {});
    clock.advance(40);
    clock.advance(HOLD_MS - 1);
    expect(policy.pending('v')).toBe(42);
    clock.advance(1);
    expect(policy.pending('v')).toBeUndefined();
  });

  it('settle() before the batch is sent does not drop the pending value', () => {
    const { policy, clock } = make();
    /** @type {number[]} */
    const sent = [];
    policy.coalesce('v', 'a', 7, (x) => sent.push(x));
    policy.settle('v');
    expect(policy.pending('v')).toBe(7);
    clock.advance(40);
    expect(sent).toEqual([7]);
  });

  it('a send that echoes synchronously ends the hold at once', () => {
    const { policy, clock } = make();
    policy.coalesce('v', 'a', 5, () => { policy.settle('v'); });
    clock.advance(40);
    expect(policy.pending('v')).toBeUndefined();
  });

  it('batches count against the rate cap, and the last value is deferred, never dropped', () => {
    const { policy, clock, ledger } = make();
    /** @type {Array<[number, number]>} time and value of each send */
    const sent = [];
    for (let i = 0; i < 14; i++) {
      policy.coalesce('seek', 'player.controls.currentPosition', i, (v) => sent.push([clock.now(), v]));
      clock.advance(41);
    }
    policy.coalesce('seek', 'player.controls.currentPosition', 99, (v) => sent.push([clock.now(), v]));
    clock.advance(5000);
    expect(sent.at(-1)?.[1]).toBe(99);
    for (const [start] of sent) expect(sent.filter(([t]) => t >= start && t < start + RATE_WINDOW_MS).length).toBeLessThanOrEqual(RATE_LIMIT);
    expect(ledger.entries().some((e) => e.kind === 'cap' && e.api === 'player.controls.currentPosition')).toBe(true);
  });

  it('writes during a rate wait restart the debounce, and only the last value is sent once the allowance opens', () => {
    const { policy, clock } = make();
    /** @type {Array<[number, number]>} */
    const sent = [];
    const send = (/** @type {number} */ v) => sent.push([clock.now(), v]);
    for (let i = 0; i < RATE_LIMIT; i++) {                                                 // spend the allowance: ten batches in ~410 ms
      policy.coalesce('seek', 'a', i, send);
      clock.advance(41);
    }
    expect(sent).toHaveLength(RATE_LIMIT);
    policy.coalesce('seek', 'a', 100, send);
    clock.advance(40);                                                                     // fires, finds the window full, defers
    expect(sent).toHaveLength(RATE_LIMIT);
    clock.advance(100);
    policy.coalesce('seek', 'a', 101, send);                                               // a write while deferred: restarts the wait
    clock.advance(20);
    policy.coalesce('seek', 'a', 102, send);
    clock.advance(RATE_WINDOW_MS);
    expect(sent.slice(RATE_LIMIT)).toHaveLength(1);                                        // 100 and 101 were superseded, not sent
    expect(sent.at(-1)?.[1]).toBe(102);
    for (const [start] of sent) expect(sent.filter(([t]) => t >= start && t < start + RATE_WINDOW_MS).length).toBeLessThanOrEqual(RATE_LIMIT);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('a send that throws, or rejects, is logged and does not stop later batches', async () => {
    const { policy, clock, warnings } = make();
    policy.coalesce('a', 'api.a', 1, () => { throw new Error('sync'); });
    policy.coalesce('b', 'api.b', 1, () => Promise.reject(new Error('async')));
    clock.advance(40);
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings).toEqual(['api.a: sync', 'api.b: async']);
    /** @type {number[]} */
    const sent = [];
    policy.coalesce('a', 'api.a', 2, (v) => sent.push(v));
    clock.advance(40);
    expect(sent).toEqual([2]);
  });

  it('dispose cancels a pending batch and leaves no timer behind', () => {
    const { policy, clock } = make();
    /** @type {number[]} */
    const sent = [];
    policy.coalesce('v', 'a', 1, (x) => sent.push(x));
    expect(clock.pendingTimers()).toBe(1);
    policy.dispose();
    clock.advance(1000);
    expect(sent).toEqual([]);
    expect(clock.pendingTimers()).toBe(0);
    expect(policy.pending('v')).toBeUndefined();
  });
});

describe('pref-caps', () => {
  /** @param {Array<[string, string]>} [rows] */
  const store = (rows = []) => new Map(rows);

  it('accepts a normal write', () => {
    const { policy, ledger } = make();
    expect(policy.prefWrite(store(), 'k', 'v')).toBeNull();
    expect(ledger.entries()).toEqual([]);
  });

  it('key over 256 bytes', () => {
    const { policy } = make();
    expect(policy.prefWrite(store(), 'k'.repeat(256), 'v')).toBeNull();
    expect(policy.prefWrite(store(), 'k'.repeat(257), 'v')).toBe('key-bytes');
  });

  it('value over 4 KiB', () => {
    const { policy } = make();
    expect(policy.prefWrite(store(), 'k', 'v'.repeat(4096))).toBeNull();
    expect(policy.prefWrite(store(), 'k', 'v'.repeat(4097))).toBe('value-bytes');
  });

  it('bytes are UTF-8: a three-byte character costs three, an astral one four', () => {
    const { policy } = make();
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('\u{1F600}')).toBe(4);
    expect(utf8Length('\ud800')).toBe(3);                                 // a lone surrogate: three, as TextEncoder's replacement
    expect(utf8Length('')).toBe(0);
    expect(policy.prefWrite(store(), '€'.repeat(86), 'v')).toBe('key-bytes');     // 258
    expect(policy.prefWrite(store(), '€'.repeat(85), 'v')).toBeNull();            // 255
  });

  it('a 257th key is refused; an existing key is still updatable at 256', () => {
    const { policy } = make();
    const full = store(Array.from({ length: 256 }, (_, i) => [`k${i}`, '1']));
    expect(policy.prefWrite(full, 'new', '1')).toBe('key-count');
    expect(policy.prefWrite(full, 'k5', '2')).toBeNull();
  });

  it('64 KiB per namespace, counting keys and values, to the byte', () => {
    const { policy } = make();
    // fifteen pairs of exactly 4,096 bytes (a 5-byte key and a 4,091-byte value) fill 61,440
    const rows = /** @type {Array<[string, string]>} */ (Array.from({ length: 15 }, (_, i) => [`key${String(i).padStart(2, '0')}`, 'x'.repeat(4096 - 5)]));
    const base = store(rows);
    expect(policy.prefWrite(base, 'last', 'y'.repeat(4096 - 4))).toBeNull();           // 61,440 + 4,096 = 65,536
    expect(policy.prefWrite(base, 'last', 'y'.repeat(4096 - 3))).toBe('namespace-bytes');   // one byte over
  });

  it('an overwrite counts by what it adds, not on top of the old value', () => {
    const { policy } = make();
    const rows = /** @type {Array<[string, string]>} */ (Array.from({ length: 16 }, (_, i) => [`key${String(i).padStart(2, '0')}`, 'x'.repeat(4096 - 5)]));
    const full = store(rows);                                                          // exactly 65,536
    expect(policy.prefWrite(full, 'key00', 'y'.repeat(4096 - 5))).toBeNull();          // same size
    expect(policy.prefWrite(full, 'key00', 'y'.repeat(4096 - 4))).toBe('namespace-bytes');
    expect(policy.prefWrite(full, 'key00', 'y')).toBeNull();                           // shrinking is always fine
  });

  it('every refusal is ledgered under theme.savePreference as a cap', () => {
    const { policy, ledger } = make();
    policy.prefWrite(store(), 'k'.repeat(300), 'v');
    policy.prefWrite(store(), 'k', 'v'.repeat(5000));
    expect(ledger.entries()).toEqual([expect.objectContaining({ api: 'theme.savePreference', kind: 'cap', count: 2 })]);
  });

  it('the store is a Map: __proto__ and constructor are ordinary keys', () => {
    const { policy } = make();
    const s = store([['__proto__', '1']]);
    expect(policy.prefWrite(s, '__proto__', '2')).toBeNull();
    expect(policy.prefWrite(s, 'constructor', '2')).toBeNull();
  });
});

describe('timer-caps', () => {
  it('0 is off, 50 and up is accepted, anything between is rejected with a cap entry', () => {
    const { policy, ledger } = make();
    expect(policy.timerInterval('view.timerInterval', 0)).toBe(0);
    expect(policy.timerInterval('view.timerInterval', 50)).toBe(50);
    expect(policy.timerInterval('view.timerInterval', 1000)).toBe(1000);
    expect(policy.timerInterval('view.timerInterval', 1)).toBeNull();
    expect(policy.timerInterval('view.timerInterval', 49)).toBeNull();
    expect(ledger.entries()).toEqual([expect.objectContaining({ api: 'view.timerInterval', kind: 'cap', count: 2 })]);
  });

  it('negative and non-finite values are rejected', () => {
    const { policy } = make();
    expect(policy.timerInterval('a', -1)).toBeNull();
    expect(policy.timerInterval('a', NaN)).toBeNull();
    expect(policy.timerInterval('a', Infinity)).toBeNull();
  });
});

describe('view-current-only', () => {
  it('ledgers each attempt and logs once per api', () => {
    const { policy, ledger, infos } = make();
    policy.foreignView('theme.openView', 'a');
    policy.foreignView('theme.openView', 'b');
    policy.foreignView('theme.closeView', 'a');
    expect(ledger.entries().map((e) => [e.api, e.kind, e.count])).toEqual([['theme.openView', 'stub', 2], ['theme.closeView', 'stub', 1]]);
    expect(infos).toHaveLength(2);
  });

  it('clips a long view id before it reaches the ledger', () => {
    const { policy, ledger } = make();
    policy.foreignView('theme.openView', 'v'.repeat(500));
    expect(ledger.entries()[0].detail?.length).toBeLessThan(200);
  });
});
