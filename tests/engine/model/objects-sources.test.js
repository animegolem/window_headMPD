// @ts-check
import { describe, expect, it } from 'vitest';
import { fakeEffects, headspaceLike, makeGraph } from './objects-fakes.js';

const SONG_A = { id: 1, pos: 0, file: 'a.flac', title: 'A', artist: 'X', album: 'Y', genre: '', track: '', date: '', durationSec: 100 };
const SONG_B = { ...SONG_A, id: 2, pos: 1, file: 'b.flac', title: 'B', durationSec: 200 };

/** @param {ReturnType<typeof makeGraph>} t @param {string} path */
function source(t, path) {
  const s = t.graph.changeSource(path);
  if (!s) throw new Error(`no source for ${path}`);
  return s;
}

describe('changeSource paths', () => {
  it('a path resolves from a host global, case-insensitively, through objects to a member', () => {
    const t = makeGraph();
    t.media.set({ playState: 'play', song: SONG_A, duration: 100, elapsed: 5, volume: 33 });
    expect(source(t, 'player.settings.volume').read()).toBe(33);
    expect(source(t, 'PLAYER.Settings.VOLUME').read()).toBe(33);
    expect(source(t, 'player.currentMedia.duration').read()).toBe(100);
    expect(source(t, 'player.currentMedia.name').read()).toBe('A');
    expect(source(t, 'player.playState').read()).toBe(3);
    expect(source(t, 'theme.currentViewID').read()).toBe('view1');
  });

  it('a call segment is called with its literal arguments; a trailing ; is accepted', () => {
    const t = makeGraph();
    t.media.set({ repeat: true });
    expect(source(t, "player.settings.getMode('loop');").read()).toBe(true);
    expect(source(t, 'player.settings.getMode("shuffle")').read()).toBe(false);
    expect(source(t, "player.controls.isAvailable('stop')").read()).toBe(false);
    expect(source(t, 'player.currentPlaylist.item(0).name').read()).toBe('Opening Titles');
  });

  it('a path may be given parsed', () => {
    const t = makeGraph();
    const read = t.graph.changeSource(/** @type {any} */ ({ root: 'player', segments: [{ name: 'settings' }, { name: 'volume' }] }))?.read();
    expect(read).toBe(50);
  });

  it('the root is a host global first (G17), then a VIEW element id', () => {
    const t = makeGraph({ elements: [...headspaceLike(), { kind: 'button', id: 'player', attrs: { left: 77 } }] });
    expect(source(t, 'player.settings.volume').read()).toBe(50);                 // the id "player" loses
    expect(source(t, 'sEqEar.left').read()).toBe(207);
    expect(source(t, 'SEQEAR.left').read()).toBe(207);                           // byId falls back to a case-insensitive match
    expect(source(t, 'eq.gainLevel2').read()).toBe(0);
    expect(source(t, 'visEffects.currentEffectType').read()).toBe('headmpd.viz');
  });

  it('an unresolvable path is null: unknown root, unknown member, a non-object in the middle, garbage', () => {
    const t = makeGraph();
    expect(t.graph.changeSource('nobody.left')).toBeNull();
    expect(t.graph.changeSource('player.nothing')).toBeNull();
    expect(t.graph.changeSource('player.settings.nothing')).toBeNull();
    expect(t.graph.changeSource('player.status.length')).toBeNull();             // a string is not an object
    expect(t.graph.changeSource('player.currentPlaylist.item(99).name')).toBeNull();   // item returns null
    expect(t.graph.changeSource('not a path at all')).toBeNull();
    expect(t.graph.changeSource('')).toBeNull();
    expect(t.graph.changeSource('player.constructor')).toBeNull();
    expect(t.graph.changeSource('__proto__.x')).toBeNull();
    expect(t.graph.changeSource(/** @type {any} */ (null))).toBeNull();
    expect(t.graph.changeSource(/** @type {any} */ ({ root: 3 }))).toBeNull();
  });

  it('a root alone is the object', () => {
    const t = makeGraph();
    const v = /** @type {any} */ (source(t, 'player').read());
    expect(t.graph.objectOf(v.__h)).toBe(t.graph.globals.player);
  });

  it('a constant resolves to a source that never fires', () => {
    const t = makeGraph();
    const s = source(t, 'player.network.downloadProgress');
    let heard = 0;
    const off = s.subscribe(() => { heard++; });
    t.media.set({ volume: 10, playState: 'play', elapsed: 4 });
    expect(heard).toBe(0);
    expect(s.read()).toBe(100);
    off();
    expect(source(t, 'player.versionInfo').read()).toBe('11.0.5721.5145');
  });

  it('binding to a stub counts it once at bind time, and reads are quiet', () => {
    const t = makeGraph();
    const s = source(t, 'player.settings.rate');
    for (let i = 0; i < 100; i++) expect(s.read()).toBe(1);
    expect(t.counts()['player.settings.rate stub']).toBe(1);
  });
});

describe('change sources fire', () => {
  it('position: on a seek and on a play-state change, not on a volume change', () => {
    const t = makeGraph();
    t.media.set({ playState: 'play', song: SONG_A, duration: 100, elapsed: 0 });
    let n = 0;
    source(t, 'player.controls.currentPosition').subscribe(() => { n++; });
    t.media.set({ elapsed: 50 });
    expect(n).toBe(1);
    t.media.set({ playState: 'pause' });
    expect(n).toBe(2);
    t.media.set({ volume: 12 });
    expect(n).toBe(2);
  });

  it('currentPosition read() is live: it extrapolates each frame without any event', () => {
    const t = makeGraph();
    t.media.set({ playState: 'play', song: SONG_A, duration: 100, elapsed: 10 });
    const s = source(t, 'player.controls.currentPosition');
    expect(s.read()).toBe(10);
    t.clock.advance(3000);
    expect(s.read()).toBeCloseTo(13, 5);
  });

  it('replacing currentMedia re-fires a bound duration (an intermediate object on the path)', () => {
    const t = makeGraph();
    t.media.set({ playState: 'play', song: SONG_A, duration: 100 });
    const s = source(t, 'player.currentMedia.duration');
    /** @type {unknown[]} */
    const values = [];
    s.subscribe(() => values.push(s.read()));
    t.media.set({ song: SONG_B, duration: 200 });
    expect(values.at(-1)).toBe(200);
    expect(values.length).toBeGreaterThan(0);
    const before = values.length;
    t.media.set({ song: null, duration: 0 });
    expect(values.length).toBeGreaterThan(before);
    expect(values.at(-1)).toBe(0);
  });

  it('a name bound through currentMedia follows the song', () => {
    const t = makeGraph();
    const s = source(t, 'player.currentMedia.name');
    /** @type {unknown[]} */
    const names = [];
    s.subscribe(() => names.push(s.read()));
    t.media.set({ song: SONG_A });
    t.media.set({ song: SONG_B });
    expect(names).toEqual(['A', 'B']);
  });

  it('playState, openState and status fire on connection, state, song and queue changes', () => {
    const t = makeGraph({ preset: 'stoppedEmpty' });
    let n = 0;
    source(t, 'player.openState').subscribe(() => { n++; });
    t.media.set({ queueLength: 3 });
    t.media.set({ connected: false });
    t.media.set({ connected: true, playState: 'play' });
    expect(n).toBe(3);
    t.media.set({ volume: 1 });
    expect(n).toBe(3);
  });

  it('getMode fires on repeat and random, not elsewhere', () => {
    const t = makeGraph();
    let n = 0;
    source(t, "player.settings.getMode('loop')").subscribe(() => { n++; });
    t.media.set({ repeat: true });
    t.media.set({ random: true });
    t.media.set({ volume: 4 });
    expect(n).toBe(2);
  });

  it('isAvailable fires when availability can have changed (the wmpenabled: source)', () => {
    const t = makeGraph();
    const s = source(t, "player.controls.isAvailable('stop')");
    /** @type {unknown[]} */
    const seen = [];
    s.subscribe(() => seen.push(s.read()));
    t.media.set({ playState: 'play' });
    t.media.set({ playState: 'stop' });
    expect(seen).toEqual([true, false]);
  });

  it('volume: media events, and a script write (before MPD has answered)', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'player.settings.volume').subscribe(() => { n++; });
    t.write('player.settings.volume', 20);
    expect(n).toBe(1);                                      // at once: the pending value is readable
    t.clock.advance(100);
    expect(n).toBe(2);                                      // the batch went out and MPD echoed it
    t.media.set({ volume: 77 });
    expect(n).toBe(3);
  });

  it('mute fires when it is toggled and when someone else ends it', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'player.settings.mute').subscribe(() => { n++; });
    t.write('player.settings.mute', true);
    expect(n).toBe(1);
    t.clock.advance(1000);
    t.media.set({ volume: 60 });
    expect(n).toBe(2);
  });

  it('queue count fires on queue changes', () => {
    const t = makeGraph({ preset: 'stoppedQueue5' });
    let n = 0;
    source(t, 'player.currentPlaylist.count').subscribe(() => { n++; });
    t.media.setQueue([]);
    expect(n).toBe(1);
    expect(source(t, 'player.currentPlaylist.count').read()).toBe(0);
  });

  it('bit rate fires on bitrate changes', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'player.network.bitRate').subscribe(() => { n++; });
    t.media.set({ bitrateKbps: 128 });
    expect(n).toBe(1);
    expect(source(t, 'player.network.bitRate').read()).toBe(128000);
  });

  it('the eq gains fire on the DSP, and balance on the DSP', () => {
    const t = makeGraph();
    let gains = 0;
    let balance = 0;
    source(t, 'eq.gainLevel3').subscribe(() => { gains++; });
    source(t, 'player.settings.balance').subscribe(() => { balance++; });
    t.dsp.eq.setGain(2, 4);
    t.dsp.balance.set(40);
    expect(gains).toBe(1);
    expect(balance).toBe(1);
    expect(source(t, 'eq.gainLevel3').read()).toBe(4);
    expect(source(t, 'eq.bypass').read()).toBe(false);
  });

  it('an element attribute fires with the model, whoever changed it', () => {
    const t = makeGraph();
    const s = source(t, 'sEqEar.left');
    /** @type {unknown[]} */
    const seen = [];
    s.subscribe(() => seen.push(s.read()));
    t.el('sEqEar').set('left', 100, 'anim');
    t.write('sEqEar.left', 50);
    t.el('sEqEar').set('top', 3, 'anim');                   // another attribute: no
    expect(seen).toEqual([100, 50]);
  });

  it('the VIEW attributes fire as well (view.width)', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'view.width').subscribe(() => { n++; });
    t.write('view.width', 760);
    expect(n).toBe(1);
  });

  it('unsubscribing stops the events; every channel on the path is released', () => {
    const t = makeGraph();
    let n = 0;
    const off = source(t, 'player.currentMedia.duration').subscribe(() => { n++; });
    t.media.set({ song: SONG_A });
    const after = n;
    off();
    off();
    t.media.set({ song: SONG_B, duration: 9 });
    expect(n).toBe(after);
  });

  it('a listener that throws does not stop the others, and is logged', () => {
    const t = makeGraph();
    let ok = 0;
    const s = source(t, 'player.settings.volume');
    s.subscribe(() => { throw new Error('bad listener'); });
    s.subscribe(() => { ok++; });
    t.media.set({ volume: 9 });
    expect(ok).toBe(1);
    expect(t.logs.warn.some((m) => m.includes('bad listener'))).toBe(true);
  });

  it('nothing fires after dispose', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'player.settings.volume').subscribe(() => { n++; });
    t.graph.dispose();
    t.media.set({ volume: 5 });
    t.dsp.balance.set(30);
    expect(n).toBe(0);
  });
});

describe('the EFFECTS control is linked when it appears', () => {
  it('a control present at subscribe time is linked at once', () => {
    const t = makeGraph();
    const control = fakeEffects();
    t.controls.set(t.el('visEffects'), control);
    let n = 0;
    source(t, 'visEffects.currentPresetTitle').subscribe(() => { n++; });
    control.setIndex(2);
    expect(n).toBe(1);
    expect(source(t, 'visEffects.currentPresetTitle').read()).toBe('Ring');
  });

  it('a control mounted after the subscription is linked on a later frame, and listeners then hear it', () => {
    const t = makeGraph();
    let n = 0;
    source(t, 'visEffects.currentPresetTitle').subscribe(() => { n++; });
    expect(t.clock.frameListeners()).toBe(1);                // waiting for the slot
    t.clock.advance(100);
    expect(t.clock.frameListeners()).toBe(1);                // still no slot
    const control = fakeEffects();
    t.controls.set(t.el('visEffects'), control);
    t.clock.advance(16);
    expect(t.clock.frameListeners()).toBe(0);                // linked: the retry stops
    control.step(1);
    expect(n).toBe(1);
  });

  it('a script write of currentPreset fires the source', () => {
    const t = makeGraph();
    t.controls.set(t.el('visEffects'), fakeEffects());
    let n = 0;
    source(t, 'visEffects.currentPreset').subscribe(() => { n++; });
    t.write('visEffects.currentPreset', 3);
    expect(n).toBeGreaterThan(0);
  });

  it('dispose releases the frame retry and the control', () => {
    const t = makeGraph();
    source(t, 'visEffects.currentPresetTitle').subscribe(() => {});
    expect(t.clock.frameListeners()).toBe(1);
    t.graph.dispose();
    expect(t.clock.frameListeners()).toBe(0);
    const control = fakeEffects();
    t.controls.set(t.el('visEffects'), control);
    t.clock.advance(100);
    expect(t.clock.frameListeners()).toBe(0);
  });
});
