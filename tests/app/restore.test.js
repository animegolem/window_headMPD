// Drawer restore (ENGINE.md D10.6 `restore`, parity D23): the shell saves a sidecar-named pref when a
// state global changes (`eqIsOpen` -> `eqOpen`), and after `onload` replays the toggles whose pref is
// true. The skin side is a fake `{ readGlobal, callGlobal }` over a plain state table that behaves the
// way Headspace's script does (the toggle flips the global at once); prefs are the in-memory store and
// time is the test host's manual clock.
//
// Rule 6: the sidecar names the globals and prefs, but they are looked up through Maps, and one test
// uses `__proto__` and `constructor` as pref names.
import { describe, expect, it, vi } from 'vitest';
import { POLL_MS, createRestore } from '../../src/app/restore.js';
import { createManualClock } from '../../src/hosts/test/clock.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';

const ENTRIES = [
  { global: 'eqIsOpen', toggle: 'ToggleEqView', pref: 'eqOpen' },
  { global: 'plIsOpen', toggle: 'TogglePlView', pref: 'plOpen' },
];

/**
 * @param {{ seed?: Record<string, string>, globals?: Record<string, unknown>, entries?: typeof ENTRIES }} [o]
 */
function rig(o = {}) {
  const prefs = createMemoryPrefs();
  prefs.seed('app', o.seed ?? {});
  const clock = createManualClock();
  const state = new Map(Object.entries({ eqIsOpen: false, plIsOpen: false, ...o.globals }));
  /** @type {string[]} */
  const called = [];
  const toggles = new Map([['ToggleEqView', 'eqIsOpen'], ['TogglePlView', 'plIsOpen']]);
  const skin = {
    readGlobal: vi.fn((/** @type {string} */ name) => {
      if (!state.has(name)) throw new Error(`${name} is not defined`);
      return /** @type {any} */ (state.get(name));
    }),
    callGlobal: vi.fn((/** @type {string} */ name, /** @type {any[]} */ _args) => {
      called.push(name);
      const g = toggles.get(name);
      if (!g) throw new Error(`${name} is not defined`);
      state.set(g, !state.get(g));
      return undefined;
    }),
  };
  const warn = vi.fn();
  const restore = createRestore({ entries: o.entries ?? ENTRIES, prefs, clock, log: { warn } });
  return { prefs, clock, state, called, skin, restore, warn };
}
const app = (/** @type {ReturnType<typeof rig>} */ r) => r.prefs.peek('app');

describe('saving', () => {
  it('writes the pref after a dispatch that changes the global', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.state.set('eqIsOpen', true);                              // the click's handler ran ToggleEqView
    r.restore.check();
    expect(app(r).get('eqOpen')).toBe('true');
    r.state.set('eqIsOpen', false);
    r.restore.check();
    expect(app(r).get('eqOpen')).toBe('false');
  });

  it('writes only on a change: an unchanged global, however often it is read, saves nothing', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.restore.check();
    r.restore.check();
    expect(r.prefs.writes).toEqual([]);
    r.state.set('plIsOpen', true);
    r.restore.check();
    r.restore.check();
    expect(r.prefs.writes).toEqual([{ ns: 'app', key: 'plOpen', value: 'true' }]);
  });

  it('keeps each drawer on its own pref', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.state.set('eqIsOpen', true);
    r.state.set('plIsOpen', true);
    r.restore.check();
    expect([app(r).get('eqOpen'), app(r).get('plOpen')]).toEqual(['true', 'true']);
  });

  it('the frame clock backs up the dispatch check, at a low rate', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.skin.readGlobal.mockClear();
    r.state.set('eqIsOpen', true);                              // a script timer opened it
    r.clock.advance(POLL_MS * 4);
    expect(app(r).get('eqOpen')).toBe('true');
    const reads = r.skin.readGlobal.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(2 * 5 + 2);               // two globals, about every 250 ms, not every 16 ms frame
    expect(reads).toBeGreaterThanOrEqual(2 * 4);
  });

  it('counts a number as a boolean and anything else as closed', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.state.set('eqIsOpen', 1);
    r.state.set('plIsOpen', 'yes');
    r.restore.check();
    expect(app(r).get('eqOpen')).toBe('true');
    expect(app(r).has('plOpen')).toBe(false);
  });

  it('a global that cannot be read (an unloaded realm) is no change and no error', () => {
    const r = rig();
    r.restore.bind(r.skin);
    r.skin.readGlobal.mockImplementation(() => { throw new Error('realm unloaded'); });
    expect(() => r.restore.check()).not.toThrow();
    expect(r.prefs.writes).toEqual([]);
  });

  it('a store that refuses the write is logged and retried at the next change', () => {
    const r = rig();
    const write = vi.fn(() => { throw new Error('full'); });
    const restore = createRestore({ entries: ENTRIES, prefs: { load: async () => new Map(), write }, log: { warn: r.warn } });
    restore.bind(r.skin);
    r.state.set('eqIsOpen', true);
    restore.check();
    expect(r.warn).toHaveBeenCalledWith('restore: could not save the drawer state', { pref: 'eqOpen', error: 'Error: full' });
  });

  it('does nothing before bind() or after dispose()', () => {
    const r = rig();
    r.state.set('eqIsOpen', true);
    r.restore.check();
    r.restore.bind(r.skin);
    r.restore.dispose();
    r.state.set('plIsOpen', true);
    r.restore.check();
    r.clock.advance(5_000);
    expect(r.prefs.writes).toEqual([]);
    expect(r.clock.frameListeners()).toBe(0);
  });
});

describe('replaying', () => {
  it('calls ToggleEqView after onload when eqOpen is true, and not the other toggle', async () => {
    const r = rig({ seed: { eqOpen: 'true', plOpen: 'false' } });
    r.restore.bind(r.skin);
    expect(await r.restore.apply()).toEqual(['ToggleEqView']);
    expect(r.called).toEqual(['ToggleEqView']);
    expect(r.state.get('eqIsOpen')).toBe(true);
    expect(r.state.get('plIsOpen')).toBe(false);
  });

  it('reopens both when both were open', async () => {
    const r = rig({ seed: { eqOpen: 'true', plOpen: 'true' } });
    r.restore.bind(r.skin);
    await r.restore.apply();
    expect(r.called).toEqual(['ToggleEqView', 'TogglePlView']);
  });

  it('does not toggle a drawer the skin already opened itself', async () => {
    const r = rig({ seed: { eqOpen: 'true' }, globals: { eqIsOpen: true } });
    r.restore.bind(r.skin);
    expect(await r.restore.apply()).toEqual([]);
  });

  it('does not save what it replays: the pref is already true', async () => {
    const r = rig({ seed: { eqOpen: 'true' } });
    r.restore.bind(r.skin);
    await r.restore.apply();
    r.restore.check();
    r.clock.advance(POLL_MS * 2);
    expect(r.prefs.writes).toEqual([]);
  });

  it('a poll that fires before apply() has read the prefs does not overwrite them', async () => {
    const r = rig({ seed: { eqOpen: 'true' } });
    r.restore.bind(r.skin);
    r.clock.advance(POLL_MS * 2);                               // frames pass while the prefs "load"
    r.restore.check();
    expect(app(r).get('eqOpen')).toBe('true');
    await r.restore.apply();
    expect(r.called).toEqual(['ToggleEqView']);
  });

  it('saves a later close of a replayed drawer', async () => {
    const r = rig({ seed: { eqOpen: 'true' } });
    r.restore.bind(r.skin);
    await r.restore.apply();
    r.state.set('eqIsOpen', false);                             // the owner closes it
    r.restore.check();
    expect(app(r).get('eqOpen')).toBe('false');
  });

  it('treats a stored value that is not the JSON true as closed', async () => {
    const r = rig({ seed: { eqOpen: '1', plOpen: 'TRUE' } });
    r.restore.bind(r.skin);
    expect(await r.restore.apply()).toEqual([]);
  });

  it('a toggle that fails is logged and does not stop the next drawer', async () => {
    const r = rig({ seed: { eqOpen: 'true', plOpen: 'true' } });
    r.restore.bind(r.skin);
    r.skin.callGlobal.mockImplementationOnce(() => { throw new Error('no such function'); });
    expect(await r.restore.apply()).toEqual(['TogglePlView']);
    expect(r.warn).toHaveBeenCalledWith('restore: the toggle failed', { toggle: 'ToggleEqView', error: 'Error: no such function' });
  });

  it('a pref store that cannot be read replays nothing', async () => {
    const r = rig();
    const restore = createRestore({ entries: ENTRIES, prefs: { load: () => Promise.reject(new Error('io')), write() {} }, log: { warn: r.warn } });
    restore.bind(r.skin);
    expect(await restore.apply()).toEqual([]);
    expect(r.warn).toHaveBeenCalled();
  });

  it('replays nothing once disposed while the prefs were loading', async () => {
    const r = rig({ seed: { eqOpen: 'true' } });
    r.restore.bind(r.skin);
    const pending = r.restore.apply();
    r.restore.dispose();
    expect(await pending).toEqual([]);
    expect(r.called).toEqual([]);
  });
});

describe('a skin with no sidecar', () => {
  it('has nothing to restore or save', async () => {
    const r = rig({ entries: [] });
    const none = createRestore({ entries: undefined, prefs: r.prefs, clock: r.clock });
    none.bind(r.skin);
    expect(await none.apply()).toEqual([]);
    none.check();
    r.clock.advance(5_000);
    expect(r.prefs.writes).toEqual([]);
    expect(r.skin.readGlobal).not.toHaveBeenCalled();
    expect(r.clock.frameListeners()).toBe(0);
  });
});

describe('names that are also Object.prototype members', () => {
  it('works with a pref named __proto__ and a global named constructor', async () => {
    const r = rig({
      entries: [{ global: 'constructor', toggle: 'ToggleEqView', pref: '__proto__' }],
      seed: { ['__proto__']: 'true' },
      globals: { constructor: false },
    });
    r.restore.bind(r.skin);
    expect(await r.restore.apply()).toEqual(['ToggleEqView']);
    r.state.set('constructor', true);                           // the (fake) skin opens it, then closes it
    r.restore.check();
    r.state.set('constructor', false);
    r.restore.check();
    expect(r.prefs.writes.map((w) => w.value)).toEqual(['true', 'false']);
    expect(app(r).get('__proto__')).toBe('false');
    expect(Object.getPrototypeOf(app(r))).toBe(Map.prototype);
  });
});
