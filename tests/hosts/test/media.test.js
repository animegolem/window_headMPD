// @ts-check
import { describe, expect, it } from 'vitest';
import { MEDIA_PRESET_NAMES as SOURCE_NAMES, mediaPreset, queueRecords } from '../../../tools/skinlab/media-presets.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import {
  MEDIA_PRESET_NAMES, createFakeMedia, presetQueue, presetState, stateFromStatus,
} from '../../../src/hosts/test/media.js';

/** @typedef {import('../../../src/engine/contracts').SongInfo} SongInfo */

/** @param {import('../../../src/hosts/test/media.js').FakeMedia} media */
function listen(media) {
  /** @type {string[][]} */
  const heard = [];
  media.subscribe((changed) => heard.push([...changed].sort()));
  return heard;
}

/** @param {number} n @returns {SongInfo[]} */
const rows = (n) => Array.from({ length: n }, (_, i) => ({
  id: 100 + i, pos: i, file: `t${i}.flac`, title: `T${i}`, artist: 'A', album: 'B', genre: '', track: '', date: '',
  durationSec: 60 * (i + 1),
}));

describe('presets come from tools/skinlab/media-presets.js', () => {
  it('the host offers exactly the source\'s preset names', () => {
    expect([...MEDIA_PRESET_NAMES]).toEqual([...SOURCE_NAMES]);
    expect([...MEDIA_PRESET_NAMES]).toEqual(['stoppedEmpty', 'stoppedQueue5', 'stoppedQueue12', 'playing']);
  });

  it.each(SOURCE_NAMES)('%s: state and queue reproduce the source rows', (name) => {
    const media = createFakeMedia(name);
    const { status, queue } = mediaPreset(name);
    const records = queueRecords(name);
    expect(media.preset).toBe(name);
    expect(media.presetStatus).toEqual(status);
    expect(media.queue()).toHaveLength(queue);
    expect(media.queue().map((s) => s.title)).toEqual(records.map((r) => r.Title));
    expect(media.queue().map((s) => s.file)).toEqual(records.map((r) => r.file));
    expect(media.queue().map((s) => s.artist)).toEqual(records.map((r) => r.Artist));
    expect(media.queue().map((s) => s.album)).toEqual(records.map((r) => r.Album));
    expect(media.queue().map((s) => s.durationSec)).toEqual(records.map((r) => Number(r.Time)));
    expect(media.queue().map((s) => s.pos)).toEqual(records.map((r) => Number(r.Pos)));
    expect(media.queue().map((s) => s.id)).toEqual(records.map((r) => Number(r.Id)));
    expect(media.snapshot().queueLength).toBe(queue);
    expect(media.snapshot().playState).toBe(status.state);
    expect(media.snapshot().volume).toBe(Number(status.volume));
    expect(presetQueue(name)).toEqual(media.queue());
    expect(presetState(name)).toEqual(media.snapshot());
  });

  it('matches the parity 4.1 status records', () => {
    expect(createFakeMedia('stoppedEmpty').presetStatus).toEqual({ state: 'stop', volume: '50' });
    expect(createFakeMedia('stoppedQueue5').presetStatus).toEqual({
      state: 'stop', volume: '50', playlist: '1', playlistlength: '5', song: '1',
    });
    expect(createFakeMedia('stoppedQueue12').presetStatus).toMatchObject({ playlistlength: '12', song: '1' });
    expect(createFakeMedia('playing').presetStatus).toEqual({ state: 'play', volume: '50', elapsed: '0' });
  });

  it('maps each status field the way player.js reads it', () => {
    expect(createFakeMedia('stoppedEmpty').snapshot()).toEqual({
      connected: true, playState: 'stop', elapsed: 0, duration: 0, volume: 50,
      random: false, repeat: false, single: false, consume: false,
      song: null, queueLength: 0, queueVersion: 0, queuePos: null, bitrateKbps: null, error: null,
    });
    expect(createFakeMedia('stoppedQueue5').snapshot()).toMatchObject({ queueLength: 5, queueVersion: 1, song: null, queuePos: 1 });
    expect(createFakeMedia('stoppedQueue12').snapshot()).toMatchObject({ queueLength: 12, queueVersion: 1, queuePos: 1 });
    // `playing` carries no duration and no song, so the seek thumb stays at 0 (media-presets.js).
    expect(createFakeMedia('playing').snapshot()).toMatchObject({ playState: 'play', elapsed: 0, duration: 0, song: null, volume: 50, queuePos: null });
  });

  it('queuePos is the wire status.song (number, or null when absent) while song stays null for an empty currentsong', () => {
    const q5 = createFakeMedia('stoppedQueue5');
    expect(q5.presetStatus.song).toBe('1');
    expect(q5.snapshot().queuePos).toBe(1);
    expect(q5.snapshot().song).toBeNull();                      // currentsong is empty in every preset
    for (const name of SOURCE_NAMES) {
      const wire = /** @type {Record<string, string>} */ (mediaPreset(name).status).song;
      const media = createFakeMedia(name);
      expect(media.snapshot().queuePos).toBe(wire === undefined ? null : Number(wire));
      expect(media.snapshot().song).toBeNull();
      expect(presetState(name).queuePos).toBe(media.snapshot().queuePos);
    }
    expect(createFakeMedia('stoppedEmpty').snapshot().queuePos).toBeNull();
    expect(stateFromStatus({ state: 'stop', song: '0' }).queuePos).toBe(0);
    expect(stateFromStatus({ state: 'stop', song: '7', songid: '9' })).toMatchObject({ queuePos: 7, song: null });
    expect(stateFromStatus({ state: 'stop', song: 'abc' }).queuePos).toBeNull();
    expect(stateFromStatus({ state: 'stop' }).queuePos).toBeNull();
  });

  it('the status mapper defaults a missing mixer to -1 and reads flags, bitrate and error', () => {
    expect(stateFromStatus({ state: 'pause', elapsed: '12.5', duration: '200.250', random: '1', repeat: '1', single: '0',
      consume: '1', bitrate: '320', error: 'boom' })).toMatchObject({
      playState: 'pause', elapsed: 12.5, duration: 200.25, volume: -1, random: true, repeat: true, single: false,
      consume: true, bitrateKbps: 320, error: 'boom',
    });
    expect(stateFromStatus({ state: 'nonsense' }).playState).toBe('stop');
  });

  it('the queue has the length the status record announces, and the long titles the drawer needs', () => {
    for (const name of SOURCE_NAMES) {
      expect(presetQueue(name)).toHaveLength(Number(/** @type {Record<string, string>} */ (mediaPreset(name).status).playlistlength ?? 0));
    }
    const q12 = presetQueue('stoppedQueue12');
    expect(Math.max(...q12.map((s) => s.title.length))).toBeGreaterThan(40);
    expect(Math.max(...q12.map((s) => s.durationSec))).toBeGreaterThan(3600);
  });

  it('defaults to stoppedEmpty and rejects unknown names, including prototype-ish ones', () => {
    expect(createFakeMedia().preset).toBe('stoppedEmpty');
    expect(createFakeMedia(null).preset).toBe('stoppedEmpty');
    for (const name of ['nope', '__proto__', 'constructor', 'toString', '']) {
      expect(() => createFakeMedia(name)).toThrow(/unknown media preset/);
    }
  });

  it('empty by default: no stored playlists, no calls', async () => {
    const media = createFakeMedia('stoppedQueue5');
    expect(media.storedPlaylists()).toEqual([]);
    await expect(media.playlistSongs('x')).rejects.toThrow(/No such playlist/);
    expect(media.calls).toEqual([]);
  });
});

describe('snapshot', () => {
  it('is a frozen object that stays the same object until something changes', () => {
    const media = createFakeMedia('stoppedEmpty');
    const a = media.snapshot();
    expect(Object.isFrozen(a)).toBe(true);
    expect(media.snapshot()).toBe(a);
    media.set({ volume: 10 });
    const b = media.snapshot();
    expect(b).not.toBe(a);
    expect(a.volume).toBe(50);
    expect(b.volume).toBe(10);
  });
});

describe('elapsed extrapolation (player.js:92-97)', () => {
  it('without a clock time stands still', async () => {
    const media = createFakeMedia('playing');
    expect(media.elapsed()).toBe(0);
    await media.pause();
    await media.play();
    expect(media.elapsed()).toBe(0);
  });

  it('while playing, elapsed() follows the injected clock; the published snapshot does not move', () => {
    const clock = createManualClock();
    const media = createFakeMedia('playing', { clock });
    clock.advance(2500);
    expect(media.elapsed()).toBe(2.5);
    expect(media.snapshot().elapsed).toBe(0);
    clock.advance(500);
    expect(media.elapsed()).toBe(3);
  });

  it('pause freezes the live value into the state, play resumes from it, stop zeroes it', async () => {
    const clock = createManualClock();
    const media = createFakeMedia('playing', { clock });
    const heard = listen(media);
    clock.advance(4000);
    await media.pause();
    expect(media.snapshot()).toMatchObject({ playState: 'pause', elapsed: 4 });
    clock.advance(10_000);
    expect(media.elapsed()).toBe(4);
    await media.play();
    clock.advance(1000);
    expect(media.elapsed()).toBe(5);
    await media.stop();
    expect(media.elapsed()).toBe(0);
    expect(heard).toEqual([['elapsed', 'playState'], ['playState'], ['elapsed', 'playState']]);
  });

  it('is capped by the duration, and seek re-bases the extrapolation', async () => {
    const clock = createManualClock();
    const media = createFakeMedia('playing', { clock });
    media.set({ duration: 10 });
    clock.advance(30_000);
    expect(media.elapsed()).toBe(10);
    await media.seek(2);
    expect(media.elapsed()).toBe(2);
    clock.advance(1500);
    expect(media.elapsed()).toBe(3.5);
    await media.seek(99);
    expect(media.snapshot().elapsed).toBe(10);
  });

  it('emit({ elapsed }) re-bases even when the published value did not change', () => {
    const clock = createManualClock();
    const media = createFakeMedia('playing', { clock });
    clock.advance(5000);
    media.emit({ elapsed: 0 });
    expect(media.elapsed()).toBe(0);
    clock.advance(1000);
    expect(media.elapsed()).toBe(1);
  });
});

describe('isAvailable follows the oracle table (E D6)', () => {
  /** @param {import('../../../src/hosts/test/media.js').FakeMedia} m */
  const table = (m) => Object.fromEntries(
    ['play', 'pause', 'stop', 'next', 'previous', 'currentPosition', 'fastForward', 'fastReverse', 'step', 'currentItem', 'currentMarker']
      .map((n) => [n, m.isAvailable(n)]),
  );

  it('stopped: stop is off, pause is off, play/next/previous are always on, no seeking without a duration', () => {
    expect(table(createFakeMedia('stoppedEmpty'))).toEqual({
      play: true, pause: false, stop: false, next: true, previous: true, currentPosition: false,
      fastForward: false, fastReverse: false, step: false, currentItem: false, currentMarker: false,
    });
  });

  it('playing: stop and pause are on', () => {
    const t = table(createFakeMedia('playing'));
    expect(t).toMatchObject({ play: true, pause: true, stop: true, next: true, previous: true, fastForward: false, fastReverse: false });
  });

  it('paused: stop is on, pause is off', () => {
    const media = createFakeMedia('playing');
    media.set({ playState: 'pause' });
    expect(table(media)).toMatchObject({ pause: false, stop: true, play: true });
  });

  it('currentPosition follows duration > 0', () => {
    const media = createFakeMedia('stoppedEmpty');
    expect(media.isAvailable('currentPosition')).toBe(false);
    media.set({ duration: 180 });
    expect(media.isAvailable('currentPosition')).toBe(true);
    media.set({ duration: 0 });
    expect(media.isAvailable('currentPosition')).toBe(false);
  });

  it('is case-insensitive, as skins spell these names', () => {
    const media = createFakeMedia('playing');
    expect(media.isAvailable('Stop')).toBe(true);
    expect(media.isAvailable('PAUSE')).toBe(true);
    expect(media.isAvailable('FastForward')).toBe(false);
    media.set({ duration: 5 });
    expect(media.isAvailable('CurrentPosition')).toBe(true);
  });

  it('unknown and prototype-ish names are unavailable', () => {
    const media = createFakeMedia('playing');
    for (const name of ['', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(media.isAvailable(name)).toBe(false);
    }
  });

  it('tracks the state as commands change it', async () => {
    const media = createFakeMedia('stoppedQueue5');
    expect(media.isAvailable('stop')).toBe(false);
    await media.play();
    expect(media.isAvailable('stop')).toBe(true);
    expect(media.isAvailable('pause')).toBe(true);
    expect(media.isAvailable('currentPosition')).toBe(true);     // the started song has a duration
    await media.stop();
    expect(media.isAvailable('stop')).toBe(false);
  });
});

describe('commands: the call log and idempotence', () => {
  it('stop() while stopped is recorded, changes nothing and notifies nobody', async () => {
    const media = createFakeMedia('stoppedQueue5');
    media.set({ elapsed: 7 });                                  // anything stop would visibly reset
    const heard = listen(media);
    const before = media.snapshot();
    await media.stop();
    expect(media.calls).toEqual([{ method: 'stop', args: [], changed: false }]);
    expect(media.snapshot()).toBe(before);
    expect(media.snapshot().elapsed).toBe(7);
    expect(heard).toEqual([]);
  });

  it('pause() while stopped and play() on an empty queue are recorded no-ops', async () => {
    const media = createFakeMedia('stoppedEmpty');
    const heard = listen(media);
    await media.pause();
    await media.play();
    expect(media.calls.map((c) => [c.method, c.changed])).toEqual([['pause', false], ['play', false]]);
    expect(media.snapshot().playState).toBe('stop');
    expect(heard).toEqual([]);
  });

  it('play() while playing and pause() while paused change nothing', async () => {
    const media = createFakeMedia('playing');
    await media.play();
    await media.pause();
    await media.pause();
    await media.play();
    expect(media.calls.map((c) => [c.method, c.changed])).toEqual([
      ['play', false], ['pause', true], ['pause', false], ['play', true],
    ]);
  });

  it('records arguments, and clearCalls empties the log in place', async () => {
    const media = createFakeMedia('stoppedQueue5');
    const log = media.calls;
    await media.setVolume(30);
    await media.seek(5);
    await media.setMode('loop', true);
    await media.playQueuePos(2);
    expect(log.map((c) => [c.method, ...c.args])).toEqual([
      ['setVolume', 30], ['seek', 5], ['setMode', 'loop', true], ['playQueuePos', 2],
    ]);
    media.clearCalls();
    expect(log).toHaveLength(0);
    expect(media.calls).toBe(log);
  });

  it('play() from stopped starts the queue at MPD\'s status.song, else the head', async () => {
    const media = createFakeMedia('stoppedQueue5');           // status.song = '1'
    await media.play();
    expect(media.snapshot()).toMatchObject({ playState: 'play', elapsed: 0 });
    expect(media.snapshot().song?.pos).toBe(1);
    expect(media.snapshot().duration).toBe(media.queue()[1].durationSec);
    const fresh = createFakeMedia('stoppedEmpty');
    fresh.setQueue(rows(3));
    await fresh.play();
    expect(fresh.snapshot().song?.pos).toBe(0);
  });

  it('stop() keeps the current song, zeroes elapsed and falls back to the song duration', async () => {
    const media = createFakeMedia('stoppedQueue5');
    await media.playQueuePos(3);
    media.set({ elapsed: 40 });
    await media.stop();
    expect(media.snapshot()).toMatchObject({ playState: 'stop', elapsed: 0, duration: media.queue()[3].durationSec });
    expect(media.snapshot().song?.pos).toBe(3);
    await media.play();                                         // restarts that song
    expect(media.snapshot().song?.pos).toBe(3);
  });

  it('setVolume rounds and clamps, and is refused without a mixer', async () => {
    const media = createFakeMedia('stoppedEmpty');
    await media.setVolume(33.6);
    expect(media.snapshot().volume).toBe(34);
    await media.setVolume(250);
    expect(media.snapshot().volume).toBe(100);
    await media.setVolume(-5);
    expect(media.snapshot().volume).toBe(0);
    media.set({ volume: -1 });
    await media.setVolume(40);
    expect(media.snapshot().volume).toBe(-1);
    expect(media.calls.at(-1)).toEqual({ method: 'setVolume', args: [40], changed: false });
  });

  it('setMode maps loop to repeat and shuffle to random, and rejects other modes', async () => {
    const media = createFakeMedia('stoppedEmpty');
    const heard = listen(media);
    await media.setMode('loop', true);
    await media.setMode('shuffle', true);
    await media.setMode('loop', true);
    expect(media.snapshot()).toMatchObject({ repeat: true, random: true });
    expect(heard).toEqual([['repeat'], ['random']]);
    // @ts-expect-error not a mode
    await expect(media.setMode('single', true)).rejects.toThrow(TypeError);
    // @ts-expect-error
    await expect(media.setMode('__proto__', true)).rejects.toThrow(TypeError);
  });

  it('seek is ignored while stopped, and clamps to 0..duration', async () => {
    const media = createFakeMedia('stoppedEmpty');
    await media.seek(10);
    expect(media.snapshot().elapsed).toBe(0);
    media.set({ playState: 'play', duration: 100 });
    await media.seek(-3);
    expect(media.snapshot().elapsed).toBe(0);
    await media.seek(42.5);
    expect(media.snapshot().elapsed).toBe(42.5);
    await media.seek(Infinity);
    expect(media.snapshot().elapsed).toBe(42.5);
    expect(media.calls.map((c) => c.changed)).toEqual([false, false, true, false]);
  });

  it('playQueuePos plays that entry, and a bad position rejects after being logged', async () => {
    const media = createFakeMedia('stoppedQueue12');
    const heard = listen(media);
    await media.playQueuePos(4);
    expect(media.snapshot().song?.title).toBe(media.queue()[4].title);
    expect(heard).toEqual([['duration', 'playState', 'song']]);
    for (const bad of [-1, 12, 1.5, NaN]) await expect(media.playQueuePos(bad)).rejects.toThrow(/Bad song index/);
    expect(media.calls).toHaveLength(5);
    expect(media.calls.slice(1).every((c) => !c.changed)).toBe(true);
    expect(media.snapshot().song?.pos).toBe(4);
  });

  it('next and previous walk the queue, wrap with repeat, and stop off the end', async () => {
    const media = createFakeMedia('stoppedQueue5');
    await media.next();                                         // nothing current: no-op
    expect(media.calls[0].changed).toBe(false);
    await media.playQueuePos(3);
    await media.next();
    expect(media.snapshot().song?.pos).toBe(4);
    await media.next();                                         // off the end, no repeat
    expect(media.snapshot()).toMatchObject({ playState: 'stop', song: null, duration: 0 });
    await media.playQueuePos(0);
    await media.previous();                                     // at the head: restart it
    expect(media.snapshot()).toMatchObject({ playState: 'play', elapsed: 0 });
    expect(media.snapshot().song?.pos).toBe(0);
    await media.setMode('loop', true);
    await media.previous();
    expect(media.snapshot().song?.pos).toBe(4);
    await media.next();
    expect(media.snapshot().song?.pos).toBe(0);
  });

  it('playPlaylist replaces the queue with the stored playlist and plays from pos', async () => {
    const media = createFakeMedia('stoppedQueue5');
    media.setStoredPlaylists({ zeta: rows(2), alpha: rows(4) });
    const heard = listen(media);
    await media.playPlaylist('alpha', 2);
    expect(media.queue().map((s) => s.title)).toEqual(['T0', 'T1', 'T2', 'T3']);
    expect(media.queue().map((s) => s.pos)).toEqual([0, 1, 2, 3]);
    expect(new Set(media.queue().map((s) => s.id)).size).toBe(4);
    expect(media.snapshot()).toMatchObject({ queueLength: 4, queueVersion: 2, playState: 'play' });
    expect(media.snapshot().song?.title).toBe('T2');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toEqual(expect.arrayContaining(['queueLength', 'queueVersion', 'song', 'playState']));
    await expect(media.playPlaylist('missing', 0)).rejects.toThrow(/No such playlist/);
    await expect(media.playPlaylist('zeta', 9)).rejects.toThrow(/Bad song index/);
    expect(media.queue()).toHaveLength(2);                      // loaded before the play failed, as MPD does
    expect(media.snapshot()).toMatchObject({ playState: 'stop', song: null, queueLength: 2 });
    expect(media.calls.map((c) => c.method)).toEqual(['playPlaylist', 'playPlaylist', 'playPlaylist']);
  });
});

describe('subscribe, emit, set, setQueue', () => {
  it('emit(patch) reports only the keys that really changed, and nothing when none did', () => {
    const media = createFakeMedia('stoppedEmpty');
    const heard = listen(media);
    expect([...media.emit({ volume: 50 })]).toEqual([]);         // unchanged
    expect([...media.emit({ volume: 20, random: true, repeat: false })].sort()).toEqual(['random', 'volume']);
    expect(heard).toEqual([['random', 'volume']]);
    expect(media.snapshot()).toMatchObject({ volume: 20, random: true });
  });

  it('emit(keys) announces exactly those keys and leaves the state alone', () => {
    const media = createFakeMedia('stoppedQueue5');
    const heard = listen(media);
    const before = media.snapshot();
    media.emit(new Set(['queueLength', 'queueVersion']));
    media.emit(['song']);
    media.emit([]);
    expect(heard).toEqual([['queueLength', 'queueVersion'], ['song']]);
    expect(media.snapshot()).toBe(before);
  });

  it('emit can change queuePos, and announces it like any other key', () => {
    const media = createFakeMedia('stoppedQueue5');
    const heard = listen(media);
    expect([...media.emit({ queuePos: 3 })]).toEqual(['queuePos']);
    expect(media.snapshot()).toMatchObject({ queuePos: 3, song: null });
    expect([...media.emit({ queuePos: 3 })]).toEqual([]);        // unchanged: nobody hears it
    media.emit({ queuePos: null });
    media.emit(['queuePos']);                                    // key form: announced, state untouched
    expect(media.snapshot().queuePos).toBeNull();
    expect(heard).toEqual([['queuePos'], ['queuePos'], ['queuePos']]);
  });

  it('set(patch) is emit(patch)', () => {
    const media = createFakeMedia('stoppedEmpty');
    const heard = listen(media);
    media.set({ connected: false, error: 'down' });
    expect(heard).toEqual([['connected', 'error']]);
  });

  it('unknown keys are a test bug and throw before anything changes', () => {
    const media = createFakeMedia('stoppedEmpty');
    const heard = listen(media);
    // @ts-expect-error
    expect(() => media.emit({ volume: 1, vol: 2 })).toThrow(/unknown MediaState key "vol"/);
    // @ts-expect-error
    expect(() => media.emit(['nope'])).toThrow(TypeError);
    expect(() => media.emit(/** @type {any} */ ('volume'))).toThrow(TypeError);
    expect(() => media.emit(/** @type {any} */ (null))).toThrow(TypeError);
    expect(media.snapshot().volume).toBe(50);
    expect(heard).toEqual([]);
  });

  it('each listener gets its own Set, unsubscribe works, and a throwing listener does not starve the rest', () => {
    const media = createFakeMedia('stoppedEmpty');
    /** @type {ReadonlySet<string>[]} */
    const sets = [];
    const off = media.subscribe((c) => sets.push(c));
    media.subscribe((c) => { /** @type {Set<string>} */ (c).clear(); });
    let last = 0;
    media.subscribe(() => last++);
    media.set({ volume: 1 });
    expect(sets).toHaveLength(1);
    expect([...sets[0]]).toEqual(['volume']);                   // the second listener cleared its own copy only
    off();
    media.set({ volume: 2 });
    expect(sets).toHaveLength(1);
    media.subscribe(() => { throw new Error('listener'); });
    media.subscribe(() => last++);
    expect(() => media.set({ volume: 3 })).toThrow('listener');
    expect(last).toBe(4);
  });

  it('commands notify before their promise settles', async () => {
    const media = createFakeMedia('stoppedEmpty');
    let heard = 0;
    media.subscribe(() => heard++);
    const p = media.setVolume(10);
    expect(heard).toBe(1);
    await p;
  });

  it('setQueue swaps the rows, bumps queueVersion and announces the queue keys only', () => {
    const media = createFakeMedia('stoppedQueue5');
    const heard = listen(media);
    media.setQueue(rows(3));
    expect(media.queue().map((s) => s.title)).toEqual(['T0', 'T1', 'T2']);
    expect(media.snapshot()).toMatchObject({ queueLength: 3, queueVersion: 2 });
    expect(heard).toEqual([['queueLength', 'queueVersion']]);
    media.setQueue([]);
    expect(media.snapshot()).toMatchObject({ queueLength: 0, queueVersion: 3 });
    expect(Object.isFrozen(media.queue())).toBe(true);
  });

  it('stored playlists are listed sorted, and their songs resolve to the scripted rows', async () => {
    const media = createFakeMedia('stoppedEmpty');
    media.setStoredPlaylists(new Map([['b', rows(1)], ['a', rows(2)]]));
    expect(media.storedPlaylists()).toEqual(['a', 'b']);
    expect((await media.playlistSongs('a')).map((s) => s.title)).toEqual(['T0', 'T1']);
    await expect(media.playlistSongs('__proto__')).rejects.toThrow(/No such playlist/);
    await expect(media.playlistSongs('constructor')).rejects.toThrow(/No such playlist/);
  });
});
