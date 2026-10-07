// @ts-check
import { describe, expect, it } from 'vitest';
import { MAX_PLAYLIST_ITEMS, clockString, openStateOf, playStateOf, songName, statusOf } from '../../../src/engine/model/objects/player.js';
import { createFakeDsp } from '../../../src/hosts/test/dsp.js';
import { makeGraph } from './objects-fakes.js';

/** @type {import('../../../src/engine/contracts').SongInfo} */
const SONG = {
  id: 7, pos: 2, file: 'albums/one/03 Harbor Lights.flac', title: 'Harbor Lights', artist: 'The Ones', album: 'Harbor', genre: 'Rock',
  track: '3', date: '2020', durationSec: 258,
};

/** Put a song on the fake player and set it playing. @param {ReturnType<typeof makeGraph>} t @param {Partial<import('../../../src/engine/contracts').MediaState>} [patch] */
const playing = (t, patch = {}) => t.media.set({ playState: 'play', song: SONG, duration: 258, elapsed: 10, bitrateKbps: 192, ...patch });

describe('player enums and strings (acceptance 2)', () => {
  it('play is 3/13 with status Playing', () => {
    const t = makeGraph();
    playing(t);
    expect(t.read('player.playState')).toBe(3);
    expect(t.read('player.openState')).toBe(13);
    expect(t.read('player.status')).toBe('Playing');
  });

  it('pause is 2/13 with status Paused', () => {
    const t = makeGraph();
    playing(t, { playState: 'pause' });
    expect([t.read('player.playState'), t.read('player.openState'), t.read('player.status')]).toEqual([2, 13, 'Paused']);
  });

  it('stop with a current song is 1/13', () => {
    const t = makeGraph({ preset: 'stoppedEmpty' });
    t.media.set({ song: SONG });
    expect([t.read('player.playState'), t.read('player.openState'), t.read('player.status')]).toEqual([1, 13, 'Stopped']);
  });

  it('stop with a non-empty queue and no song is 1/13 (the stoppedQueue5 preset)', () => {
    const t = makeGraph({ preset: 'stoppedQueue5' });
    expect(t.media.snapshot().song).toBeNull();
    expect(t.media.snapshot().queueLength).toBe(5);
    expect([t.read('player.playState'), t.read('player.openState')]).toEqual([1, 13]);
  });

  it('stop with an empty queue and no song is 0/0, status Ready', () => {
    const t = makeGraph({ preset: 'stoppedEmpty' });
    expect([t.read('player.playState'), t.read('player.openState'), t.read('player.status')]).toEqual([0, 0, 'Ready']);
  });

  it('a disconnected MPD is 0/0 with the status Connecting… (U+2026), whatever the play state', () => {
    const t = makeGraph();
    playing(t, { connected: false });
    expect([t.read('player.playState'), t.read('player.openState'), t.read('player.status')]).toEqual([0, 0, 'Connecting…']);
    expect(t.read('player.status')).toBe('Connecting…');
  });

  it('the pure derivations match the object', () => {
    const s = /** @type {any} */ ({ connected: true, playState: 'stop', song: null, queueLength: 0 });
    expect([playStateOf(s), openStateOf(s), statusOf(s)]).toEqual([0, 0, 'Ready']);
    expect(playStateOf({ ...s, queueLength: 1 })).toBe(1);
  });

  it('versionInfo, fullScreen and the inert members', () => {
    const t = makeGraph();
    expect(t.read('player.versionInfo')).toBe('11.0.5721.5145');
    expect(t.read('player.fullScreen')).toBe(false);
    expect(t.counts()['player.fullScreen stub']).toBe(1);
  });

  it('URL reads the current file, empty when there is none', () => {
    const t = makeGraph();
    expect(t.read('player.URL')).toBe('');
    playing(t);
    expect(t.read('player.url')).toBe(SONG.file);
  });
});

describe('time strings (acceptance 3)', () => {
  it.each([
    [0, '00:00'], [0.9, '00:00'], [59, '00:59'], [60, '01:00'], [187, '03:07'], [187.9, '03:07'], [3599, '59:59'],
    [3600, '01:00:00'], [3661, '01:01:01'], [36000, '10:00:00'], [-5, '00:00'], [NaN, '00:00'], [Infinity, '00:00'],
  ])('clockString(%s) is %s', (sec, text) => {
    expect(clockString(sec)).toBe(text);
  });

  it('currentPositionString follows the elapsed time, zero padded', () => {
    const t = makeGraph();
    playing(t, { elapsed: 187, duration: 5000 });
    expect(t.read('player.controls.currentPositionString')).toBe('03:07');
    t.clock.advance(1000);                                   // the model extrapolates while playing
    expect(t.read('player.controls.currentPositionString')).toBe('03:08');
    t.media.set({ elapsed: 3600 });
    expect(t.read('player.controls.currentPositionString')).toBe('01:00:00');
    t.media.set({ elapsed: 0 });
    expect(t.read('player.controls.currentPositionString')).toBe('00:00');
  });

  it('durationString has the same format', () => {
    const t = makeGraph();
    playing(t, { duration: 187 });
    expect(t.read('player.currentMedia.durationString')).toBe('03:07');
    t.media.set({ duration: 3600 });
    expect(t.read('player.currentMedia.DurationString')).toBe('01:00:00');
    t.media.set({ duration: 0 });
    expect(t.read('player.currentMedia.durationString')).toBe('00:00');
  });
});

describe('controls', () => {
  it('each verb reaches the media model', () => {
    const t = makeGraph();
    t.call('player.controls.play');
    t.call('player.controls.pause');
    t.call('player.controls.stop');
    t.call('player.controls.next');
    t.call('player.controls.previous');
    expect(t.media.calls.map((c) => c.method)).toEqual(['play', 'pause', 'stop', 'next', 'previous']);
  });

  it('11 next() calls in one second reach the media 10 times, the 11th is ledgered as a cap', () => {
    const t = makeGraph();
    playing(t);
    t.media.clearCalls();
    for (let i = 0; i < 11; i++) t.call('player.controls.next');
    expect(t.media.calls.filter((c) => c.method === 'next')).toHaveLength(10);
    expect(t.counts()['player.controls.next cap']).toBe(1);
    t.clock.advance(1000);                                   // a second later the allowance is back
    t.call('player.controls.next');
    expect(t.media.calls.filter((c) => c.method === 'next')).toHaveLength(11);
  });

  it('verbs are capped independently', () => {
    const t = makeGraph();
    for (let i = 0; i < 12; i++) t.call('player.controls.next');
    t.call('player.controls.previous');
    expect(t.media.calls.filter((c) => c.method === 'previous')).toHaveLength(1);
  });

  it('an MPD rejection is logged, never thrown into the script', async () => {
    const t = makeGraph({ preset: 'stoppedQueue5' });
    t.media.playQueuePos = () => Promise.reject(new Error('boom'));
    t.media.play = () => Promise.reject(new Error('mpd said no'));
    expect(() => t.call('player.controls.play')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.logs.warn.some((m) => m.includes('mpd said no'))).toBe(true);
  });

  it('a media model that throws synchronously is contained too', () => {
    const t = makeGraph();
    t.media.stop = () => { throw new Error('sync boom'); };
    expect(() => t.call('player.controls.stop')).not.toThrow();
    expect(t.logs.warn.some((m) => m.includes('sync boom'))).toBe(true);
  });

  it('seek sends the latest value 40 ms after the last write, and a read sees the pending value', () => {
    const t = makeGraph();
    playing(t, { elapsed: 10, duration: 258 });
    t.media.clearCalls();
    t.write('player.controls.currentPosition', 30);
    t.clock.advance(10);
    t.write('player.controls.currentPosition', 60);
    t.clock.advance(10);
    t.write('player.controls.currentPosition', 90);
    expect(t.media.calls).toHaveLength(0);
    expect(t.read('player.controls.currentPosition')).toBe(90);       // read-back before MPD has it
    t.clock.advance(39);
    expect(t.media.calls).toHaveLength(0);                            // 40 ms from the first write has passed: still waiting
    t.clock.advance(1);
    expect(t.media.calls).toEqual([{ method: 'seek', args: [90], changed: true }]);
    expect(t.read('player.controls.currentPosition')).toBe(90);       // the echo
  });

  it('a drag that writes every 30 ms seeks once, after it stops (trailing debounce)', () => {
    const t = makeGraph();
    playing(t, { elapsed: 0, duration: 3000 });
    t.media.clearCalls();
    for (let i = 1; i <= 10; i++) {
      t.write('player.controls.currentPosition', i * 10);
      t.clock.advance(30);
    }
    expect(t.media.calls).toHaveLength(0);                            // 300 ms of dragging, nothing sent
    expect(t.read('player.controls.currentPosition')).toBe(100);      // but a read already sees the latest
    t.clock.advance(10);
    expect(t.media.calls).toEqual([{ method: 'seek', args: [100], changed: true }]);
    t.clock.advance(1000);
    expect(t.media.calls).toHaveLength(1);
  });

  it('a seek write that is not a number is ignored', () => {
    const t = makeGraph();
    playing(t);
    t.media.clearCalls();
    t.write('player.controls.currentPosition', 'soon');
    t.clock.advance(100);
    expect(t.media.calls).toHaveLength(0);
  });

  it('currentPosition reads the live extrapolation', () => {
    const t = makeGraph();
    playing(t, { elapsed: 5, duration: 300 });
    expect(t.read('player.controls.currentPosition')).toBe(5);
    t.clock.advance(2500);
    expect(t.read('player.controls.currentPosition')).toBeCloseTo(7.5, 5);
  });

  it('seek batches defer, never drop, when the rate allowance is spent (the last value lands)', () => {
    const t = makeGraph();
    playing(t, { elapsed: 0, duration: 3000 });
    t.media.clearCalls();
    for (let i = 0; i < 14; i++) {
      t.write('player.controls.currentPosition', 100 + i);
      t.clock.advance(41);                                            // one batch per call
    }
    t.write('player.controls.currentPosition', 999);
    t.clock.advance(3000);
    const seeks = t.media.calls.filter((c) => c.method === 'seek');
    expect(seeks.at(-1)?.args).toEqual([999]);
    expect(seeks.length).toBeLessThanOrEqual(15);
    // never more than 10 inside any one second
    expect(t.counts()['player.controls.currentPosition cap']).toBeGreaterThan(0);
  });
});

describe('isAvailable follows the oracle table (acceptance 7)', () => {
  /** @param {ReturnType<typeof makeGraph>} t @param {string} name */
  const avail = (t, name) => t.call('player.controls.isAvailable', [name]);

  it('stopped: play, next, previous yes; stop, pause no; currentPosition needs a duration', () => {
    const t = makeGraph({ preset: 'stoppedQueue5' });
    expect(['play', 'next', 'previous'].map((n) => avail(t, n))).toEqual([true, true, true]);
    expect(['stop', 'pause', 'currentPosition', 'fastForward', 'fastReverse'].map((n) => avail(t, n))).toEqual([false, false, false, false, false]);
  });

  it('playing: stop and pause yes, currentPosition with a duration', () => {
    const t = makeGraph();
    playing(t);
    expect(['Stop', 'PAUSE', 'currentposition', 'Play'].map((n) => avail(t, n))).toEqual([true, true, true, true]);
    expect(avail(t, 'fastForward')).toBe(false);
  });

  it('paused: stop yes, pause no', () => {
    const t = makeGraph();
    playing(t, { playState: 'pause' });
    expect([avail(t, 'stop'), avail(t, 'pause')]).toEqual([true, false]);
  });

  it('unknown names, including constructor and __proto__, are unavailable', () => {
    const t = makeGraph();
    expect([avail(t, 'constructor'), avail(t, '__proto__'), avail(t, 'nope'), avail(t, undefined)]).toEqual([false, false, false, false]);
  });

  it('availability: mpd defers to the media model', () => {
    const t = makeGraph({ options: { availability: 'mpd' } });
    t.media.isAvailable = (c) => c === 'weird';
    expect([avail(t, 'weird'), avail(t, 'play')]).toEqual([true, false]);
  });
});

describe('settings.volume and the mute emulation (acceptance 5, 7)', () => {
  it('reads the media volume; no mixer reads 0 and writes are dropped, ledgered once', () => {
    const t = makeGraph();
    expect(t.read('player.settings.volume')).toBe(50);
    t.media.set({ volume: -1 });
    expect(t.read('player.settings.volume')).toBe(0);
    t.media.clearCalls();
    t.write('player.settings.volume', 70);
    t.write('player.settings.volume', 80);
    t.clock.advance(200);
    expect(t.media.calls).toHaveLength(0);
    expect(t.counts()['player.settings.volume stub']).toBe(2);
    expect(t.read('player.settings.volume')).toBe(0);
  });

  it('volume writes send the latest value 40 ms after the last write and read back meanwhile', () => {
    const t = makeGraph();
    t.media.clearCalls();
    t.write('player.settings.volume', 10);
    t.clock.advance(15);
    t.write('player.settings.volume', 20);
    t.clock.advance(15);
    t.write('player.settings.volume', 30);
    expect(t.read('player.settings.volume')).toBe(30);
    expect(t.media.calls).toHaveLength(0);
    t.clock.advance(39);
    expect(t.media.calls).toHaveLength(0);
    t.clock.advance(1);
    expect(t.media.calls).toEqual([{ method: 'setVolume', args: [30], changed: true }]);
    expect(t.read('player.settings.volume')).toBe(30);
  });

  it('a volume stream under 40 ms apart sends once, after it stops', () => {
    const t = makeGraph();
    t.media.clearCalls();
    for (let i = 1; i <= 8; i++) {
      t.write('player.settings.volume', 10 * i);
      t.clock.advance(35);
    }
    expect(t.media.calls).toHaveLength(0);
    t.clock.advance(5);
    expect(t.media.calls).toEqual([{ method: 'setVolume', args: [80], changed: true }]);
  });

  it('volume writes round to an integer, clamp to 0..100, and writing the current value sends nothing', () => {
    const t = makeGraph();
    t.media.clearCalls();
    t.write('player.settings.volume', 50);
    t.clock.advance(100);
    expect(t.media.calls).toHaveLength(0);
    t.write('player.settings.volume', 250);
    t.clock.advance(100);
    t.write('player.settings.volume', '-4');
    t.clock.advance(100);
    expect(t.media.calls.map((c) => c.args[0])).toEqual([100, 0]);
  });

  it('the volume read follows MPD after the batch settles', () => {
    const t = makeGraph();
    t.write('player.settings.volume', 20);
    t.clock.advance(40);
    t.media.set({ volume: 65 });                              // MPD says otherwise: that wins at once
    expect(t.read('player.settings.volume')).toBe(65);
  });

  it('mute: remembers the volume, silences MPD, restores it, and writing the current value is a no-op', () => {
    const t = makeGraph();
    t.media.set({ volume: 40 });
    t.media.clearCalls();
    t.write('player.settings.mute', false);                   // already unmuted
    t.clock.advance(100);
    expect(t.media.calls).toHaveLength(0);

    t.write('player.settings.mute', true);
    t.clock.advance(40);
    expect(t.media.calls).toEqual([{ method: 'setVolume', args: [0], changed: true }]);
    expect(t.read('player.settings.mute')).toBe(true);
    expect(t.read('player.settings.volume')).toBe(40);        // WMP keeps volume and mute apart

    t.media.clearCalls();
    t.write('player.settings.mute', true);                    // again: nothing
    t.clock.advance(100);
    expect(t.media.calls).toHaveLength(0);

    t.write('player.settings.mute', false);
    t.clock.advance(40);
    expect(t.media.calls).toEqual([{ method: 'setVolume', args: [40], changed: true }]);
    expect(t.read('player.settings.mute')).toBe(false);
    expect(t.read('player.settings.volume')).toBe(40);
  });

  it("mute = 'false' (text) coerces; 'ture' keeps the previous value", () => {
    const t = makeGraph();
    t.media.set({ volume: 30 });
    t.write('player.settings.mute', 'true');
    t.clock.advance(100);
    expect(t.read('player.settings.mute')).toBe(true);
    t.write('player.settings.mute', 'ture');
    expect(t.read('player.settings.mute')).toBe(true);
    t.write('player.settings.mute', 'false');
    t.clock.advance(100);
    expect(t.read('player.settings.mute')).toBe(false);
    expect(t.media.snapshot().volume).toBe(30);
  });

  it('a volume write while muted moves the logical volume and leaves MPD silent; unmute restores the new one', () => {
    const t = makeGraph();
    t.media.set({ volume: 40 });
    t.write('player.settings.mute', true);
    t.clock.advance(100);
    t.media.clearCalls();
    t.write('player.settings.volume', 75);
    t.clock.advance(100);
    expect(t.media.calls).toHaveLength(0);
    expect(t.read('player.settings.volume')).toBe(75);
    t.write('player.settings.mute', false);                   // the VOLUMESLIDER default does exactly this
    t.clock.advance(100);
    expect(t.media.snapshot().volume).toBe(75);
  });

  it('someone else raising the volume while muted un-mutes', () => {
    const t = makeGraph();
    t.media.set({ volume: 40 });
    t.write('player.settings.mute', true);
    t.clock.advance(1000);
    expect(t.media.snapshot().volume).toBe(0);
    t.media.set({ volume: 55 });                              // another MPD client
    expect(t.read('player.settings.mute')).toBe(false);
    expect(t.read('player.settings.volume')).toBe(55);
  });

  it('mute with no mixer is dropped and ledgered', () => {
    const t = makeGraph();
    t.media.set({ volume: -1 });
    t.write('player.settings.mute', true);
    expect(t.read('player.settings.mute')).toBe(false);
    expect(t.counts()['player.settings.mute stub']).toBe(1);
  });
});

describe('settings.balance (acceptance 7)', () => {
  it('values within +-5 go to the DSP as 0 and read back 0; the slider is told to snap back', () => {
    const t = makeGraph();
    let heard = 0;
    t.graph.changeSource('player.settings.balance')?.subscribe(() => { heard++; });
    t.write('player.settings.balance', 4);
    expect(t.dsp.balance.get()).toBe(0);
    expect(t.read('player.settings.balance')).toBe(0);
    expect(heard).toBeGreaterThan(0);                         // no DSP change, still notified: the snap
    t.write('player.settings.balance', -5);
    expect(t.dsp.balance.get()).toBe(0);
    t.write('player.settings.balance', 6);
    expect(t.dsp.balance.get()).toBe(6);
    expect(t.read('player.settings.balance')).toBe(6);
    t.write('player.settings.balance', 250);
    expect(t.read('player.settings.balance')).toBe(100);
    t.write('player.settings.balance', 'left');
    expect(t.read('player.settings.balance')).toBe(100);
  });

  it('a port that does not snap is snapped here as well', () => {
    /** @type {number[]} */
    const sent = [];
    let stored = 0;
    const plain = {
      eq: createFakeDsp().eq,
      balance: { get: () => stored, set: (/** @type {number} */ v) => { sent.push(v); stored = v; }, onChange: () => () => {} },
    };
    const t = makeGraph({ dsp: plain });
    t.write('player.settings.balance', 3);
    t.write('player.settings.balance', -80);
    expect(sent).toEqual([0, -80]);
  });
});

describe('settings modes (acceptance 7)', () => {
  it("getMode('loop') follows repeat and 'shuffle' follows random, any case", () => {
    const t = makeGraph();
    expect(t.call('player.settings.getMode', ['loop'])).toBe(false);
    t.media.set({ repeat: true });
    expect(t.call('player.settings.getMode', ['loop'])).toBe(true);
    expect(t.call('player.settings.getMode', ['LOOP'])).toBe(true);
    expect(t.call('player.settings.getMode', ['shuffle'])).toBe(false);
    t.media.set({ random: true });
    expect(t.call('player.settings.getMode', ['Shuffle'])).toBe(true);
    expect(t.call('player.settings.getMode', ['autoRewind'])).toBe(false);
    expect(t.call('player.settings.getMode', ['constructor'])).toBe(false);
  });

  it('setMode reaches the media model, and is a no-op when it would change nothing', () => {
    const t = makeGraph();
    t.media.clearCalls();
    t.call('player.settings.setMode', ['loop', true]);
    t.call('player.settings.setMode', ['loop', true]);
    t.call('player.settings.setMode', ['shuffle', 'true']);
    t.call('player.settings.setMode', ['shuffle', false]);
    expect(t.media.calls.map((c) => [c.method, ...c.args])).toEqual([['setMode', 'loop', true], ['setMode', 'shuffle', true], ['setMode', 'shuffle', false]]);
    expect(t.media.snapshot().repeat).toBe(true);
  });

  it('an unknown mode is ledgered and sends nothing', () => {
    const t = makeGraph();
    t.media.clearCalls();
    t.call('player.settings.setMode', ['showFrame', true]);
    expect(t.media.calls).toHaveLength(0);
    expect(t.counts()['player.settings.setMode stub']).toBe(1);
  });
});

describe('currentMedia, currentPlaylist, network', () => {
  it('name is the title, else the file stem', () => {
    const t = makeGraph();
    expect(t.read('player.currentMedia.name')).toBe('');
    playing(t);
    expect(t.read('player.currentMedia.name')).toBe('Harbor Lights');
    t.media.set({ song: { ...SONG, title: '' } });
    expect(t.read('player.currentMedia.name')).toBe('03 Harbor Lights');
    expect(songName(null)).toBe('');
    expect(songName({ ...SONG, title: '', file: 'x' })).toBe('x');
  });

  it('duration, sourceURL and the video size', () => {
    const t = makeGraph();
    playing(t, { duration: 258 });
    expect(t.read('player.currentMedia.duration')).toBe(258);
    expect(t.read('player.currentMedia.sourceURL')).toBe(SONG.file);
    expect(t.read('player.currentMedia.ImageSourceWidth')).toBe(0);
    expect(t.read('player.currentMedia.imageSourceHeight')).toBe(0);
  });

  it('getItemInfo maps the corpus keys', () => {
    const t = makeGraph();
    playing(t, { bitrateKbps: 192 });
    /** @param {string} k */
    const info = (k) => t.call('player.currentMedia.getItemInfo', [k]);
    expect(info('Author')).toBe('The Ones');
    expect(info('Artist')).toBe('The Ones');
    expect(info('Title')).toBe('Harbor Lights');
    expect(info('Album')).toBe('Harbor');
    expect(info('WM/AlbumTitle')).toBe('Harbor');
    expect(info('WM/TrackNumber')).toBe('3');
    expect(info('Genre')).toBe('Rock');
    expect(info('Bitrate')).toBe('192000');
    expect(info('Type')).toBe('audio');
    expect(info('Copyright')).toBe('');
    expect(info('constructor')).toBe('');
    expect(info('__proto__')).toBe('');
    expect(info(undefined)).toBe('');
  });

  it('getItemInfo is empty when nothing is loaded; attributeCount lists what is set', () => {
    const t = makeGraph({ preset: 'stoppedEmpty' });
    expect(t.call('player.currentMedia.getItemInfo', ['Title'])).toBe('');
    expect(t.read('player.currentMedia.attributeCount')).toBe(0);
    playing(t);
    expect(t.read('player.currentMedia.attributeCount')).toBeGreaterThan(5);
    expect(t.call('player.currentMedia.getAttributeName', [0])).toBe('Author');
    expect(t.call('player.currentMedia.getAttributeName', [99])).toBe('');
  });

  it('setItemInfo is denied and ledgered once, with one host notice', () => {
    const t = makeGraph();
    t.call('player.currentMedia.setItemInfo', ['Title', 'x']);
    t.call('player.currentMedia.setItemInfo', ['Title', 'y']);
    expect(t.counts()['player.currentMedia.setItemInfo denied']).toBe(2);
    expect(t.ledger.entries().filter((e) => e.kind === 'denied')).toHaveLength(1);
    expect(t.actionLog.denied).toHaveLength(1);
    expect(t.actionLog.denied[0][0]).toBe('player.currentMedia.setItemInfo');
  });

  it('currentPlaylist: count, name, item(i) and the item cap', () => {
    const t = makeGraph({ preset: 'stoppedQueue12' });
    expect(t.read('player.currentPlaylist.count')).toBe(12);
    expect(t.read('player.currentPlaylist.name')).toBe('Now Playing');
    const item = /** @type {any} */ (t.call('player.currentPlaylist.item', [1]));
    const again = /** @type {any} */ (t.call('player.currentPlaylist.item', [1]));
    expect(item.__h).toBe(again.__h);
    expect(t.graph.objectOf(item.__h)?.get('name')).toBe('Weightless');
    expect(t.graph.objectOf(item.__h)?.get('duration')).toBe(222);
    expect(t.call('player.currentPlaylist.item', [12])).toBeNull();
    expect(t.call('player.currentPlaylist.item', [-1])).toBeNull();
    expect(MAX_PLAYLIST_ITEMS).toBe(256);
  });

  it('a playlist item does not borrow the current song’s bitrate', () => {
    const t = makeGraph({ preset: 'stoppedQueue5' });
    playing(t, { bitrateKbps: 192 });
    const item = /** @type {any} */ (t.call('player.currentPlaylist.item', [0]));
    expect(t.graph.objectOf(item.__h)?.call('getiteminfo', ['Bitrate'], { gesture: false })).toBe('');
  });

  it('network: fully downloaded, bit rate from the status, the rest inert', () => {
    const t = makeGraph();
    expect(t.read('player.network.downloadProgress')).toBe(100);
    expect(t.read('player.network.bufferingProgress')).toBe(100);
    expect(t.read('player.network.bitRate')).toBe(0);
    playing(t, { bitrateKbps: 320 });
    expect(t.read('player.network.bitRate')).toBe(320000);
    expect(t.read('player.network.bandwidth')).toBe(0);
  });

  it('player.currentMedia and controls.currentItem are the same object', () => {
    const t = makeGraph();
    expect(t.read('player.controls.currentItem')).toEqual(t.read('player.currentMedia'));
  });
});

describe('denied and inert APIs (acceptance 5)', () => {
  it('launchURL is denied and ledgered once with one host notice carrying the URL', () => {
    const t = makeGraph();
    t.call('player.launchURL', ['https://example.com/a']);
    t.call('player.launchURL', ['https://example.com/b']);
    t.call('player.launchURL', ['https://example.com/c']);
    expect(t.ledger.entries().filter((e) => e.kind === 'denied' && e.api === 'player.launchURL')).toHaveLength(1);
    expect(t.counts()['player.launchURL denied']).toBe(3);
    expect(t.actionLog.denied).toEqual([['player.launchURL', 'https://example.com/a']]);
  });

  it('URL = ... is denied and ledgered once; the read still works', () => {
    const t = makeGraph();
    playing(t);
    t.write('player.URL', 'http://evil.example/stream');
    t.write('player.url', 'http://evil.example/other');
    expect(t.ledger.entries().filter((e) => e.api === 'player.URL' && e.kind === 'denied')).toHaveLength(1);
    expect(t.actionLog.denied).toHaveLength(1);
    expect(t.read('player.URL')).toBe(SONG.file);
    expect(t.media.calls).toHaveLength(0);                    // nothing reached MPD
  });

  it('the collections are inert objects: the same handle, no members', () => {
    const t = makeGraph();
    const a = /** @type {any} */ (t.read('player.mediaCollection'));
    const b = /** @type {any} */ (t.read('player.cdromCollection'));
    expect(a.__h).toBe(b.__h);
    expect(t.graph.objectOf(a.__h)?.className).toBe('inert');
    expect(t.graph.objectOf(a.__h)?.get('getAll')).toBeUndefined();
    expect(t.counts()['player.collection.getall unknown-member']).toBe(1);
  });

  it('player.constructor and __proto__ are unknown members, ledgered (acceptance 4)', () => {
    const t = makeGraph();
    expect(t.read('player.constructor')).toBeUndefined();
    expect(t.read('player.__proto__')).toBeUndefined();
    expect(t.read('player.toString')).toBeUndefined();
    expect(t.read('player.hasOwnProperty')).toBeUndefined();
    const c = t.counts();
    expect(c['player.constructor unknown-member']).toBe(1);
    expect(c['player.__proto__ unknown-member']).toBe(1);
    expect(c['player.tostring unknown-member']).toBe(1);
    t.read('player.Constructor');
    expect(t.counts()['player.constructor unknown-member']).toBe(2);   // case variants share an entry
  });

  it('a property is not callable and a method is not assignable', () => {
    const t = makeGraph();
    expect(t.call('player.controls.currentPosition', [1])).toBeUndefined();
    t.write('player.controls.play', 5);
    expect(t.counts()['player.controls.currentposition unknown-member']).toBe(1);
    expect(t.counts()['player.controls.play unknown-member']).toBe(1);
    expect(t.media.calls).toHaveLength(0);
  });

  it('a read-only member drops the write', () => {
    const t = makeGraph();
    t.write('player.playState', 3);
    t.write('player.status', 'Hacked');
    expect(t.read('player.playState')).toBe(1);
    expect(t.read('player.status')).toBe('Stopped');
  });

  it('a stub that is written reads back what was written, coerced to its type', () => {
    const t = makeGraph();
    t.write('player.settings.rate', '2');
    expect(t.read('player.settings.rate')).toBe(2);
    t.write('player.settings.rate', 'fast');
    expect(t.read('player.settings.rate')).toBe(2);
    t.write('player.settings.autoStart', 'false');
    expect(t.read('player.settings.autoStart')).toBe(false);
  });
});
