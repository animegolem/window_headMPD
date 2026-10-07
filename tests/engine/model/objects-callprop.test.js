// @ts-check
// G3.F4: a host property called as a method. JScript reaches host members through IDispatch, where
// `obj.prop()` is a property get, and the corpus relies on it (28 `mediacenter.effectType()` and
// `effectPreset()` calls in `jscript:` attributes). The object model answers `call(prop, [])` with the
// property's value; with arguments it is still an error. Whether script can reach `call` for a
// property at all is the realm's business (its proxy hands script the value on `get`).
import { describe, expect, it } from 'vitest';
import { makeGraph } from './objects-fakes.js';

/** @type {import('../../../src/engine/contracts').SongInfo} */
const SONG = {
  id: 7, pos: 2, file: 'albums/one/03 Harbor Lights.flac', title: 'Harbor Lights', artist: 'The Ones', album: 'Harbor', genre: 'Rock',
  track: '3', date: '2020', durationSec: 258,
};

/** @param {ReturnType<typeof makeGraph>} t @param {Partial<import('../../../src/engine/contracts').MediaState>} [patch] */
const playing = (t, patch = {}) => t.media.set({ playState: 'play', song: SONG, duration: 258, elapsed: 10, bitrateKbps: 192, ...patch });

describe('a property called with no arguments returns its value', () => {
  it('mediacenter.effectType() and effectPreset() read the stored keys', () => {
    const t = makeGraph();
    expect(t.call('mediacenter.effectType', [])).toBe('');
    expect(t.call('mediacenter.effectPreset', [])).toBe(0);
    t.write('mediacenter.effectType', 'bars');
    t.write('mediacenter.effectPreset', 3);
    expect(t.call('mediacenter.effectType', [])).toBe('bars');
    expect(t.call('mediacenter.effectPreset', [])).toBe(3);
    expect(t.call('mediacenter.effectType', [])).toBe(t.read('mediacenter.effectType'));
    expect(t.ledger.entries()).toEqual([]);                           // a live property: nothing to ledger
  });

  it('the member name is case-insensitive, as a read is', () => {
    const t = makeGraph();
    t.write('mediacenter.effectPreset', 2);
    expect(t.obj('mediacenter').call('EFFECTPRESET', [], { gesture: false })).toBe(2);
    expect(t.obj('mediacenter').call('effectPreset', [], { gesture: false })).toBe(2);
  });

  it('player.controls.currentPosition() is the extrapolated position', () => {
    const t = makeGraph();
    playing(t, { elapsed: 10, duration: 258 });
    expect(t.call('player.controls.currentPosition', [])).toBe(10);
    t.clock.advance(2000);
    expect(t.call('player.controls.currentPosition', [])).toBe(12);
    expect(t.call('player.controls.currentPosition', [])).toBe(t.read('player.controls.currentPosition'));
    expect(t.media.calls.filter((c) => c.method === 'seek')).toEqual([]);   // reading never seeks
  });

  it('an emulated string property: currentPositionString() is the clock text', () => {
    const t = makeGraph();
    playing(t, { elapsed: 187, duration: 5000 });
    expect(t.call('player.controls.currentPositionString', [])).toBe('03:07');
  });

  it('an object property returns the handle a read does', () => {
    const t = makeGraph();
    const controls = t.read('player.controls');
    expect(controls).toEqual({ __h: expect.any(Number) });
    expect(t.call('player.controls', [])).toEqual(controls);
  });

  it('an element property returns the attribute', () => {
    const t = makeGraph();
    expect(t.call('volume.value', [])).toBe(50);
    t.write('volume.value', 20);
    expect(t.call('volume.value', [])).toBe(20);
    expect(t.call('bEqHandle.left', [])).toBe(8);
  });

  it('a stub property returns its inert value and is ledgered, as a read is', () => {
    const t = makeGraph();
    expect(t.call('player.settings.rate', [])).toBe(1);
    expect(t.counts()['player.settings.rate stub']).toBe(1);
    t.write('player.settings.rate', 2);
    expect(t.call('player.settings.rate', [])).toBe(2);               // reads back what a script wrote
  });

  it('a quiet call (a binding\'s read) does not count a stub', () => {
    const t = makeGraph();
    const settings = /** @type {import('../../../src/engine/model/objects/core.js').GraphObject} */ (t.obj('player.settings'));
    expect(settings.peekCall('rate', [])).toBe(1);
    expect(t.counts()['player.settings.rate stub']).toBeUndefined();
  });

  it('a call after dispose is undefined', () => {
    const t = makeGraph();
    const mc = t.obj('mediacenter');
    t.graph.dispose();
    expect(mc.call('effecttype', [], { gesture: false })).toBeUndefined();
  });
});

describe('a property called with arguments is still an error', () => {
  it('returns undefined and ledgers one unknown-member per call, without running anything', () => {
    const t = makeGraph();
    playing(t);
    t.media.clearCalls();
    expect(t.call('player.controls.currentPosition', [1])).toBeUndefined();
    expect(t.counts()['player.controls.currentposition unknown-member']).toBe(1);
    expect(t.call('mediacenter.effectType', ['x'])).toBeUndefined();
    expect(t.counts()['mediacenter.effecttype unknown-member']).toBe(1);
    expect(t.read('mediacenter.effectType')).toBe('');                // the argument was not an assignment
    expect(t.media.calls).toHaveLength(0);
    expect(t.store.writes).toEqual([]);
  });

  it('an explicit undefined argument counts as an argument', () => {
    const t = makeGraph();
    expect(t.call('mediacenter.effectPreset', [undefined])).toBeUndefined();
    expect(t.counts()['mediacenter.effectpreset unknown-member']).toBe(1);
  });
});

describe('what a call does not change', () => {
  it('a method still reads as a method marker and runs on call', () => {
    const t = makeGraph();
    playing(t, { playState: 'pause' });
    t.media.clearCalls();
    expect(t.read('player.controls.play')).toEqual({ method: true });
    t.call('player.controls.play', []);
    expect(t.media.calls.length).toBeGreaterThan(0);
  });

  it('an unknown member called is undefined and ledgered, including __proto__ and constructor', () => {
    const t = makeGraph();
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) {
      expect(t.call(`player.${name}`, [])).toBeUndefined();
      expect(t.call(`volume.${name}`, [])).toBeUndefined();
    }
    const c = t.counts();
    expect(c['player.__proto__ unknown-member']).toBe(1);
    expect(c['player.constructor unknown-member']).toBe(1);
    expect(c['player.tostring unknown-member']).toBe(1);
    expect(c['player.nope unknown-member']).toBe(1);
  });

  it('mediacenter.constructor() and __proto__() reach no stored key', () => {
    const t = makeGraph();
    expect(t.call('mediacenter.constructor', [])).toBeUndefined();
    expect(t.call('mediacenter.__proto__', [])).toBeUndefined();
    expect(t.store.writes).toEqual([]);
  });
});
