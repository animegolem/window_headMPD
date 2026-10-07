// @ts-check
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { PENDING_TTL_MS, VOLUME_COALESCE_MS, createMpdMediaModel } from '../../../src/hosts/tauri/media.js';
import { MEDIA_PRESET_NAMES, presetQueue, stateFromStatus } from '../../../src/hosts/test/media.js';
import { mediaPreset, queueRecords } from '../../../tools/skinlab/media-presets.js';

/** @typedef {import('../../../src/engine/contracts').MediaState} MediaState */
/** @typedef {import('../../../src/engine/contracts').SongInfo} SongInfo */

/**
 * A stand-in for player.js's `Player`: the same fields and the same getters (player.js:84-101, copied
 * so the extrapolation under test is the oracle's), with an injectable clock. The last describe block
 * runs the real `player` under a mocked IPC, which is what keeps this copy honest.
 */
class FakePlayer extends EventTarget {
  connected = true;
  /** @type {Record<string, string>} */
  status = {};
  /** @type {Record<string, string> | null} */
  song = null;
  /** @type {Record<string, string>[]} */
  queue = [];
  /** @type {string[]} */
  playlists = [];
  /** @type {Map<string, Record<string, string>[]>} */
  stored = new Map();
  /** @type {Record<string, number>} */
  listenerCounts = {};
  /** @param {() => number} now */
  constructor(now) {
    super();
    this.now = now;
    this.statusAt = now();
  }

  get state() { return this.status.state ?? 'stop'; }
  get duration() { return parseFloat(this.status.duration ?? this.song?.Time ?? 0) || 0; }
  get elapsed() {
    const base = parseFloat(this.status.elapsed ?? 0) || 0;
    if (this.state !== 'play') return base;
    return Math.min(this.duration || Infinity, base + (this.now() - this.statusAt) / 1000);
  }
  get volume() { return parseInt(this.status.volume ?? '-1', 10); }

  /** @param {string} name */
  async playlistSongs(name) {
    const rows = this.stored.get(name);
    if (!rows) throw new Error(`No such playlist: ${name}`);
    return rows;
  }

  /** @param {string} type @param {any} cb */
  addEventListener(type, cb) {
    this.listenerCounts[type] = (this.listenerCounts[type] ?? 0) + 1;
    super.addEventListener(type, cb);
  }
  /** @param {string} type @param {any} cb */
  removeEventListener(type, cb) {
    this.listenerCounts[type] = (this.listenerCounts[type] ?? 0) - 1;
    super.removeEventListener(type, cb);
  }
  totalListeners() { return Object.values(this.listenerCounts).reduce((a, b) => a + b, 0); }

  /** What `refresh(['player', ...])` does: a new status object, the clock reset, a `status` event. @param {Record<string, string>} status */
  setStatus(status, song = this.song) {
    this.status = { ...status };
    this.song = song;
    this.statusAt = this.now();
    this.dispatchEvent(new Event('status'));
  }
}

/** A recorded `mpd`: logs the wire form of every call (player.js's `mpd` stringifies its arguments). */
function recordedMpd() {
  /** @type {string[][]} */
  const calls = [];
  /** @type {unknown} */
  let failure = null;
  /** @param {...(string | number)} args */
  const mpd = async (...args) => {
    calls.push(args.map(String));
    if (failure) {
      const e = failure;
      failure = null;
      throw e;
    }
    return [];
  };
  return { mpd, calls, failNext: (/** @type {unknown} */ e) => { failure = e; } };
}

/**
 * @param {Record<string, string>} [status]
 * @param {{ song?: Record<string, string> | null }} [extra]
 */
function rig(status = { state: 'stop', volume: '50' }, extra = {}) {
  let t = 0;
  const clock = { now: () => t, advance: (/** @type {number} */ ms) => { t += ms; } };
  const player = new FakePlayer(clock.now);
  player.status = { ...status };
  player.song = extra.song ?? null;
  const rec = recordedMpd();
  const warnings = /** @type {Array<[string, object | undefined]>} */ ([]);
  const media = createMpdMediaModel(player, rec.mpd, {
    now: clock.now,
    log: { warn: (m, d) => { warnings.push([m, d]); } },
  });
  return { player, media, clock, warnings, ...rec };
}

const SONG = {
  Id: '9', Pos: '1', file: 'a/b/Song One.flac', Title: 'Song One', Artist: 'Ann', Album: 'Alb', Genre: 'Pop',
  Track: '3', Date: '1999', Time: '187', duration: '187.250',
};

describe('state mapping', () => {
  it.each(MEDIA_PRESET_NAMES)('%s: snapshot and queue equal the test host\'s for the same wire rows', (name) => {
    const rig1 = rig(/** @type {Record<string, string>} */ (mediaPreset(name).status));
    rig1.player.queue = /** @type {Record<string, string>[]} */ (queueRecords(name));
    expect(rig1.media.snapshot()).toEqual(stateFromStatus(rig1.player.status));
    expect(rig1.media.queue()).toEqual(presetQueue(name));
  });

  it('maps every status field', () => {
    const { media } = rig({
      state: 'play', elapsed: '12.5', duration: '200.5', volume: '33', random: '1', repeat: '0', single: '1', consume: '0',
      playlist: '7', playlistlength: '4', song: '2', bitrate: '320', error: 'Failed to open "x"',
    }, { song: SONG });
    expect(media.snapshot()).toEqual({
      connected: true, playState: 'play', elapsed: 12.5, duration: 200.5, volume: 33,
      random: true, repeat: false, single: true, consume: false,
      song: {
        id: 9, pos: 1, file: 'a/b/Song One.flac', title: 'Song One', artist: 'Ann', album: 'Alb', genre: 'Pop',
        track: '3', date: '1999', durationSec: 187.25,
      },
      queueLength: 4, queueVersion: 7, queuePos: 2, bitrateKbps: 320, error: 'Failed to open "x"',
    });
  });

  it('defaults an empty status: stopped, no mixer, nothing queued', () => {
    const { media, player } = rig({});
    player.connected = false;
    expect(media.snapshot()).toEqual({
      connected: false, playState: 'stop', elapsed: 0, duration: 0, volume: -1,
      random: false, repeat: false, single: false, consume: false,
      song: null, queueLength: 0, queueVersion: 0, queuePos: null, bitrateKbps: null, error: null,
    });
  });

  it('takes duration from the song when status has none, and reads junk numbers as absent', () => {
    const a = rig({ state: 'play' }, { song: SONG });
    expect(a.media.snapshot().duration).toBe(187);                    // player.js:89, Time
    const b = rig({ state: 'pause', volume: 'loud', playlistlength: 'x', song: 'y', bitrate: 'z', elapsed: '-3' });
    expect(b.media.snapshot()).toMatchObject({ volume: -1, queueLength: 0, queuePos: null, bitrateKbps: null, elapsed: 0 });
    expect(rig({ state: 'weird' }).media.snapshot().playState).toBe('stop');
  });

  it('a song without a Title shows its Name (radio streams); a record without Id or Pos gets -1 and the index', () => {
    const { media, player } = rig();
    player.queue = [{ file: 'http://radio/x', Name: 'Radio X' }, { file: 'b.flac', Title: 'B', Name: 'ignored', Id: '4', Pos: '9' }];
    expect(media.queue().map((s) => [s.id, s.pos, s.title])).toEqual([[-1, 0, 'Radio X'], [4, 9, 'B']]);
  });

  it('snapshot() is frozen and keeps its identity until a field changes; so does the song', () => {
    const { media, player } = rig({ state: 'play', elapsed: '1', volume: '50' }, { song: SONG });
    const a = media.snapshot();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.song)).toBe(true);
    expect(media.snapshot()).toBe(a);
    player.setStatus({ state: 'play', elapsed: '1', volume: '50' }, { ...SONG });          // new objects, same content
    expect(media.snapshot()).toBe(a);
    player.setStatus({ state: 'play', elapsed: '1', volume: '51' }, { ...SONG });
    const b = media.snapshot();
    expect(b).not.toBe(a);
    expect(b.song).toBe(a.song);
    player.setStatus({ state: 'play', elapsed: '1', volume: '51' }, { ...SONG, Title: 'Renamed' });
    expect(media.snapshot().song).not.toBe(a.song);
    expect(media.snapshot().song?.title).toBe('Renamed');
  });
});

describe('elapsed()', () => {
  it('extrapolates while playing as player.js:92-97 does, capped by the duration', () => {
    const { media, clock, player } = rig({ state: 'play', elapsed: '10', duration: '100' });
    expect(media.elapsed()).toBe(10);
    clock.advance(2500);
    expect(media.elapsed()).toBe(12.5);
    expect(media.snapshot().elapsed).toBe(10);                         // the state is MPD's value at the last status
    clock.advance(500_000);
    expect(media.elapsed()).toBe(100);
    player.setStatus({ state: 'play', elapsed: '5' });                 // no duration: no cap
    clock.advance(1_000_000);
    expect(media.elapsed()).toBe(1005);
  });

  it('does not move while paused or stopped', () => {
    const { media, clock } = rig({ state: 'pause', elapsed: '42', duration: '100' });
    clock.advance(10_000);
    expect(media.elapsed()).toBe(42);
  });
});

describe('transport commands', () => {
  /** @type {Array<[string, string, (m: import('../../../src/hosts/tauri/media.js').MpdMediaModel) => Promise<void>, string[][]]>} */
  const cases = [
    ['stop', 'play', (m) => m.play(), [['play']]],
    ['pause', 'play', (m) => m.play(), [['pause', '0']]],
    ['play', 'play', (m) => m.play(), []],
    ['play', 'pause', (m) => m.pause(), [['pause', '1']]],
    ['pause', 'pause', (m) => m.pause(), []],
    ['stop', 'pause', (m) => m.pause(), []],
    ['play', 'stop', (m) => m.stop(), [['stop']]],
    ['pause', 'stop', (m) => m.stop(), [['stop']]],
    ['stop', 'stop', (m) => m.stop(), []],
  ];
  it.each(cases)('%s: %s -> %j', async (state, _name, call, expected) => {
    const r = rig({ state, volume: '50' });
    await call(r.media);
    expect(r.calls).toEqual(expected);
  });

  it('play() while paused sends `pause 0`, while stopped sends `play`, and stop() while stopped sends nothing', async () => {
    const paused = rig({ state: 'pause' });
    await paused.media.play();
    expect(paused.calls).toEqual([['pause', '0']]);
    const stopped = rig({ state: 'stop' });
    await stopped.media.play();
    await stopped.media.stop();                                         // pending 'play' now, so this one goes out
    expect(stopped.calls).toEqual([['play'], ['stop']]);
    const idle = rig({ state: 'stop' });
    await idle.media.stop();
    expect(idle.calls).toEqual([]);
  });

  it('next and previous always go out', async () => {
    const r = rig({ state: 'stop' });
    await r.media.next();
    await r.media.previous();
    await r.media.next();
    expect(r.calls).toEqual([['next'], ['previous'], ['next']]);
  });

  it('seek(12.345) sends `seekcur 12.35`', async () => {
    const r = rig({ state: 'play', duration: '200' });
    await r.media.seek(12.345);
    expect(r.calls).toEqual([['seekcur', '12.35']]);
  });

  it('seek clamps to 0..duration, sends nothing while stopped or for a non-number', async () => {
    const r = rig({ state: 'pause', duration: '60' });
    await r.media.seek(-5);
    await r.media.seek(999);
    await r.media.seek(NaN);
    // @ts-expect-error a skin could pass anything
    await r.media.seek('7');
    expect(r.calls).toEqual([['seekcur', '0.00'], ['seekcur', '60.00']]);
    const stopped = rig({ state: 'stop', duration: '60' });
    await stopped.media.seek(10);
    expect(stopped.calls).toEqual([]);
    const unknownLength = rig({ state: 'play' });
    await unknownLength.media.seek(321.5);
    expect(unknownLength.calls).toEqual([['seekcur', '321.50']]);
  });

  it('setMode maps loop to repeat and shuffle to random, and is idempotent', async () => {
    const r = rig({ state: 'stop', repeat: '1', random: '0' });
    await r.media.setMode('loop', true);                                // already on
    await r.media.setMode('loop', false);
    await r.media.setMode('loop', false);                               // pending off
    await r.media.setMode('shuffle', true);
    await r.media.setMode('shuffle', true);
    expect(r.calls).toEqual([['repeat', '0'], ['random', '1']]);
    // @ts-expect-error
    await expect(r.media.setMode('constructor', true)).rejects.toThrow(TypeError);
    // @ts-expect-error
    await expect(r.media.setMode('__proto__', true)).rejects.toThrow(TypeError);
  });

  it('playQueuePos sends `play <pos>`; a bad position rejects without a command', async () => {
    const r = rig();
    await r.media.playQueuePos(3);
    for (const bad of [-1, 1.5, NaN]) await expect(r.media.playQueuePos(bad)).rejects.toThrow(RangeError);
    expect(r.calls).toEqual([['play', '3']]);
  });

  it('playPlaylist replaces the queue: clear, load, play', async () => {
    const r = rig();
    await r.media.playPlaylist('Road Mix', 2);
    expect(r.calls).toEqual([['clear'], ['load', 'Road Mix'], ['play', '2']]);
    await expect(r.media.playPlaylist('', 0)).rejects.toThrow(TypeError);
    await expect(r.media.playPlaylist('x', -1)).rejects.toThrow(RangeError);
    expect(r.calls).toHaveLength(3);
  });

  it('a playlist name travels as one argument, never spliced into a command', async () => {
    const r = rig();
    await r.media.playPlaylist('a" ; clear ; "b', 0);
    expect(r.calls[1]).toEqual(['load', 'a" ; clear ; "b']);
  });

  it('a failing MPD command rejects the caller', async () => {
    const r = rig({ state: 'stop' });
    r.failNext(new Error('ACK [50@0] {play} Bad song index'));
    await expect(r.media.playQueuePos(99)).rejects.toThrow('Bad song index');
    const p = rig({ state: 'stop' });
    p.failNext(new Error('mpd down'));
    await expect(p.media.playPlaylist('x', 0)).rejects.toThrow('mpd down');
    expect(p.calls).toEqual([['clear']]);                              // stops at the failure
  });
});

describe('pending state', () => {
  it('two quick play() calls send one play; the second sees the pending state', async () => {
    const r = rig({ state: 'stop' });
    const a = r.media.play();
    const b = r.media.play();
    await Promise.all([a, b]);
    expect(r.calls).toEqual([['play']]);
  });

  it('play() then pause() before MPD answers: pause goes out, against the pending play', async () => {
    const r = rig({ state: 'stop' });
    await r.media.play();
    await r.media.pause();
    await r.media.pause();
    expect(r.calls).toEqual([['play'], ['pause', '1']]);
  });

  it('the next status retires the pending state and the confirmed one decides again', async () => {
    const r = rig({ state: 'stop' });
    await r.media.play();
    r.player.setStatus({ state: 'stop' });                              // MPD did not start (empty queue)
    await r.media.play();
    expect(r.calls).toEqual([['play'], ['play']]);
  });

  it('a rejected command does not leave a pending state behind', async () => {
    const r = rig({ state: 'stop' });
    r.failNext(new Error('nope'));
    await expect(r.media.play()).rejects.toThrow('nope');
    await r.media.play();
    expect(r.calls).toEqual([['play'], ['play']]);
  });

  it('a pending state expires after the TTL even when no status ever arrives', async () => {
    const r = rig({ state: 'stop' });
    await r.media.play();
    r.clock.advance(PENDING_TTL_MS - 1);
    await r.media.play();
    expect(r.calls).toHaveLength(1);
    r.clock.advance(1);
    await r.media.play();
    expect(r.calls).toEqual([['play'], ['play']]);
  });

  it('seek is judged against the pending state: right after play() from stop it goes out', async () => {
    const r = rig({ state: 'stop', duration: '90' });
    await r.media.play();
    await r.media.seek(30);
    expect(r.calls).toEqual([['play'], ['seekcur', '30.00']]);
  });
});

describe('volume', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('five setVolume calls within 40 ms send one setvol, the last value', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    const done = [10, 20, 30, 40, 70].map((v) => r.media.setVolume(v));
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(VOLUME_COALESCE_MS);
    await Promise.all(done);                                            // every caller resolves
    expect(r.calls).toEqual([['setvol', '70']]);
  });

  it('is a trailing debounce: each call restarts the 40 ms window (main.js:102-103)', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    r.media.setVolume(60);
    await vi.advanceTimersByTimeAsync(30);
    r.media.setVolume(61);
    await vi.advanceTimersByTimeAsync(30);
    expect(r.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.calls).toEqual([['setvol', '61']]);
    r.media.setVolume(80);                                              // a later window sends again
    await vi.advanceTimersByTimeAsync(40);
    expect(r.calls).toEqual([['setvol', '61'], ['setvol', '80']]);
  });

  it('rounds and clamps to 0..100, and ignores non-numbers', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    r.media.setVolume(33.6);
    await vi.advanceTimersByTimeAsync(40);
    r.media.setVolume(250);
    await vi.advanceTimersByTimeAsync(40);
    r.media.setVolume(-9);
    await vi.advanceTimersByTimeAsync(40);
    await r.media.setVolume(NaN);
    // @ts-expect-error
    await r.media.setVolume('40');
    await vi.advanceTimersByTimeAsync(40);
    expect(r.calls).toEqual([['setvol', '34'], ['setvol', '100'], ['setvol', '0']]);
  });

  it('sends nothing when the target is the current or the pending volume', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    r.media.setVolume(50);
    await vi.advanceTimersByTimeAsync(40);
    expect(r.calls).toEqual([]);
    r.media.setVolume(70);
    await vi.advanceTimersByTimeAsync(40);
    r.media.setVolume(70);                                              // setvol 70 is still in flight
    await vi.advanceTimersByTimeAsync(40);
    expect(r.calls).toEqual([['setvol', '70']]);
    r.media.setVolume(50);                                              // dragged back before MPD's status: not a no-op
    await vi.advanceTimersByTimeAsync(40);
    expect(r.calls).toEqual([['setvol', '70'], ['setvol', '50']]);
  });

  it('with no mixer (volume -1) the write is dropped, logged once, and its caller resolves', async () => {
    const r = rig({ state: 'stop' });
    const a = r.media.setVolume(30);
    await vi.advanceTimersByTimeAsync(40);
    await a;
    const b = r.media.setVolume(31);
    await vi.advanceTimersByTimeAsync(40);
    await b;
    expect(r.calls).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0][1]).toEqual({ requested: 30 });
  });

  it('a failing setvol rejects every caller in the window', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    r.failNext(new Error('ACK setvol'));
    const a = r.media.setVolume(60).catch((e) => e.message);
    const b = r.media.setVolume(61).catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(40);
    expect(await Promise.all([a, b])).toEqual(['ACK setvol', 'ACK setvol']);
  });

  it('dispose cancels a waiting write and resolves its callers', async () => {
    const r = rig({ state: 'stop', volume: '50' });
    const a = r.media.setVolume(10);
    r.media.dispose();
    await a;
    await vi.advanceTimersByTimeAsync(100);
    expect(r.calls).toEqual([]);
  });

  it('works with injected timers too', async () => {
    /** @type {Array<() => void>} */
    const queued = [];
    const player = new FakePlayer(() => 0);
    player.status = { state: 'stop', volume: '50' };
    const rec = recordedMpd();
    const media = createMpdMediaModel(player, rec.mpd, {
      timers: { setTimeout: (fn, ms) => { expect(ms).toBe(40); queued.push(fn); return queued.length; }, clearTimeout: () => { queued.length = 0; } },
    });
    media.setVolume(20);
    media.setVolume(25);
    expect(queued).toHaveLength(1);                                     // the first timer was cleared
    queued[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(rec.calls).toEqual([['setvol', '25']]);
  });
});

describe('subscribe', () => {
  /** @param {ReturnType<typeof rig>} r */
  const listen = (r) => {
    /** @type {string[][]} */
    const heard = [];
    const off = r.media.subscribe((changed) => heard.push([...changed].sort()));
    return { heard, off };
  };

  it('reports the keys that changed on a status event', () => {
    const r = rig({ state: 'stop', volume: '50' });
    const { heard } = listen(r);
    r.player.setStatus({ state: 'play', volume: '45', elapsed: '3', duration: '200', playlist: '2', playlistlength: '3', song: '0' });
    expect(heard).toEqual([['duration', 'elapsed', 'playState', 'queueLength', 'queuePos', 'queueVersion', 'volume']]);
    r.player.setStatus({ state: 'play', volume: '45', elapsed: '3', duration: '200', playlist: '2', playlistlength: '3', song: '0', repeat: '1' });
    expect(heard[1]).toEqual(['repeat']);
  });

  it('reports `song` on a song event, and says nothing when nothing changed', () => {
    const r = rig({ state: 'play', volume: '50' });
    const { heard } = listen(r);
    r.player.song = { ...SONG };
    r.player.dispatchEvent(new Event('song'));
    expect(heard).toEqual([['duration', 'song']]);                      // duration falls back to the song's Time (player.js:89)
    r.player.song = { ...SONG };                                        // same content, new object
    r.player.dispatchEvent(new Event('song'));
    r.player.dispatchEvent(new Event('status'));
    expect(heard).toHaveLength(1);
  });

  it('player.js order: the status event announces the song, the song event adds nothing', () => {
    const r = rig({ state: 'stop', volume: '50' });
    const { heard } = listen(r);
    r.player.setStatus({ state: 'play', volume: '50', elapsed: '0' }, { ...SONG });
    r.player.dispatchEvent(new Event('song'));
    expect(heard).toEqual([['duration', 'playState', 'song']]);
  });

  it('a queue event always reports queueVersion: it is the signal that the rows landed', () => {
    const r = rig({ state: 'stop', volume: '50' });
    const { heard } = listen(r);
    r.player.setStatus({ state: 'stop', volume: '50', playlist: '4', playlistlength: '2' });
    expect(heard[0]).toEqual(['queueLength', 'queueVersion']);          // announced before the rows are read
    r.player.queue = /** @type {Record<string, string>[]} */ (queueRecords('stoppedQueue5').slice(0, 2));
    r.player.dispatchEvent(new Event('queue'));
    expect(heard[1]).toEqual(['queueVersion']);
    expect(r.media.queue()).toHaveLength(2);                            // and the rows are readable by then
  });

  it('a connection event reports `connected`; a playlists event is not forwarded', () => {
    const r = rig({ state: 'stop', volume: '50' });
    const { heard } = listen(r);
    r.player.connected = false;
    r.player.dispatchEvent(new Event('connection'));
    expect(heard).toEqual([['connected']]);
    r.player.playlists = ['a', 'b'];
    r.player.dispatchEvent(new Event('playlists'));
    expect(heard).toHaveLength(1);
    expect(r.media.storedPlaylists()).toEqual(['a', 'b']);              // reading is still current
  });

  it('every subscriber hears it; unsubscribing stops one; the last one detaches from the player', () => {
    const r = rig({ state: 'stop', volume: '50' });
    expect(r.player.totalListeners()).toBe(0);                          // nothing attached until someone listens
    const a = listen(r);
    const b = listen(r);
    expect(r.player.totalListeners()).toBe(4);                          // one set of listeners, shared
    r.player.setStatus({ state: 'pause', volume: '50' });
    expect([a.heard.length, b.heard.length]).toEqual([1, 1]);
    a.off();
    r.player.setStatus({ state: 'play', volume: '50' });
    expect([a.heard.length, b.heard.length]).toEqual([1, 2]);
    b.off();
    expect(r.player.totalListeners()).toBe(0);
    r.player.setStatus({ state: 'stop', volume: '50' });
    expect(b.heard).toHaveLength(2);
    // Re-attaching starts from the state of that moment: the stop above is not replayed.
    const c = listen(r);
    r.player.setStatus({ state: 'stop', volume: '50' });
    expect(c.heard).toEqual([]);
  });

  it('a throwing subscriber does not starve the others and is logged', () => {
    const r = rig({ state: 'stop', volume: '50' });
    let heard = 0;
    r.media.subscribe(() => { throw new Error('boom'); });
    r.media.subscribe(() => { heard++; });
    r.player.setStatus({ state: 'play', volume: '50' });
    expect(heard).toBe(1);
    expect(r.warnings).toEqual([['media: a subscriber threw', { error: 'Error: boom' }]]);
  });

  it('hands each subscriber its own set', () => {
    const r = rig({ state: 'stop', volume: '50' });
    /** @type {Set<string>[]} */
    const seen = [];
    r.media.subscribe((c) => { seen.push(/** @type {Set<string>} */ (c)); /** @type {Set<string>} */ (c).clear(); });
    r.media.subscribe((c) => { seen.push(/** @type {Set<string>} */ (c)); });
    r.player.setStatus({ state: 'play', volume: '50' });
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1].size).toBeGreaterThan(0);
  });
});

describe('queue, stored playlists, playlist rows', () => {
  it('queue() maps rows once per refresh and returns the same frozen array until the player replaces it', () => {
    const { media, player } = rig();
    player.queue = /** @type {Record<string, string>[]} */ (queueRecords('stoppedQueue5'));
    const a = media.queue();
    expect(a).toHaveLength(5);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(media.queue()).toBe(a);
    player.queue = player.queue.slice(0, 3);
    expect(media.queue()).toHaveLength(3);
  });

  it('storedPlaylists() is the player\'s sorted list, frozen', () => {
    const { media, player } = rig();
    expect(media.storedPlaylists()).toEqual([]);
    player.playlists = ['Alpha', 'Road Mix'];
    const a = media.storedPlaylists();
    expect(a).toEqual(['Alpha', 'Road Mix']);
    expect(Object.isFrozen(a)).toBe(true);
    expect(media.storedPlaylists()).toBe(a);
  });

  it('playlistSongs(name) maps the rows (no Id or Pos on the wire), and rejects for an unknown or empty name', async () => {
    const { media, player } = rig();
    player.stored.set('Road Mix', [{ file: 'x.flac', Title: 'X', Time: '60' }, { file: 'y.flac', Title: 'Y', duration: '61.5' }]);
    const rows = await media.playlistSongs('Road Mix');
    expect(rows.map((s) => [s.id, s.pos, s.title, s.durationSec])).toEqual([[-1, 0, 'X', 60], [-1, 1, 'Y', 61.5]]);
    expect(Object.isFrozen(rows)).toBe(true);
    await expect(media.playlistSongs('Nope')).rejects.toThrow('No such playlist');
    await expect(media.playlistSongs('')).rejects.toThrow(TypeError);
  });

  it('tag text with odd keys or markup is only ever a string value', () => {
    const { media, player } = rig();
    player.queue = [{ file: 'f', Title: '<img src=x onerror=1>', Artist: '__proto__', Album: 'constructor' }];
    const [row] = media.queue();
    expect([row.title, row.artist, row.album]).toEqual(['<img src=x onerror=1>', '__proto__', 'constructor']);
  });
});

describe('isAvailable: the oracle table', () => {
  /** @type {Array<[string, Record<string, string>, Record<string, boolean>]>} */
  const rows = [
    ['stopped, no duration', { state: 'stop' }, { play: true, next: true, previous: true, stop: false, pause: false, currentPosition: false, fastForward: false, fastReverse: false }],
    ['playing', { state: 'play', duration: '200' }, { play: true, next: true, previous: true, stop: true, pause: true, currentPosition: true, fastForward: false, fastReverse: false }],
    ['paused', { state: 'pause', duration: '200' }, { play: true, next: true, previous: true, stop: true, pause: false, currentPosition: true, fastForward: false, fastReverse: false }],
  ];
  it.each(rows)('%s', (_name, status, expected) => {
    const { media } = rig(status);
    for (const [control, want] of Object.entries(expected)) expect(media.isAvailable(control), control).toBe(want);
  });

  it('is case-insensitive and false for everything else, including prototype names', () => {
    const { media } = rig({ state: 'play', duration: '9' });
    expect(media.isAvailable('STOP')).toBe(true);
    expect(media.isAvailable('CurrentPosition')).toBe(true);
    for (const name of ['', 'volume', 'step', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(media.isAvailable(name), name).toBe(false);
    }
    // @ts-expect-error a skin could pass anything
    expect(media.isAvailable({ toString: () => 'stop' })).toBe(false);
  });

  it('follows the confirmed state, not a pending command', async () => {
    const r = rig({ state: 'stop', duration: '9' });
    await r.media.play();
    expect(r.media.isAvailable('stop')).toBe(false);
    r.player.setStatus({ state: 'play', duration: '9' });
    expect(r.media.isAvailable('stop')).toBe(true);
  });

  it('only the oracle table exists in phase 1', () => {
    const player = new FakePlayer(() => 0);
    // @ts-expect-error
    expect(() => createMpdMediaModel(player, recordedMpd().mpd, { availability: 'mpd' })).toThrow(RangeError);
    expect(() => createMpdMediaModel(player, recordedMpd().mpd, { availability: 'oracle' })).not.toThrow();
  });
});

describe('against the real src/player.js under a mocked IPC', () => {
  /** @type {any} */
  let realPlayer;
  /** @type {any} */
  let realMpd;
  /** Every `mpd` call that reached the (mock) Rust side, in the wire form. @type {string[][]} */
  const wire = [];
  const READS = new Set(['status', 'currentsong', 'playlistinfo', 'listplaylists', 'listplaylistinfo']);
  const world = {
    /** @type {Array<[string, string]>} */
    status: [['state', 'stop'], ['volume', '50']],
    /** @type {Array<[string, string]>} */
    currentsong: [],
    /** @type {Array<[string, string]>} */
    playlistinfo: [],
    /** @type {Array<[string, string]>} */
    listplaylists: [['playlist', 'Zed'], ['playlist', 'Alpha']],
  };
  const commands = () => wire.filter((a) => !READS.has(a[0]));

  /** @param {Array<[string, string]>} status */
  async function setWorld(status, currentsong = /** @type {Array<[string, string]>} */ ([])) {
    world.status = status;
    world.currentsong = currentsong;
    await realPlayer.refresh(['player']);
    wire.length = 0;
  }

  beforeAll(async () => {
    /** @type {any} */ (globalThis).window ??= globalThis;
    mockIPC((cmd, payload) => {
      if (cmd !== 'mpd') return undefined;
      const args = /** @type {{ args: string[] }} */ (payload).args;
      wire.push(args);
      switch (args[0]) {
        case 'status': return world.status;
        case 'currentsong': return world.currentsong;
        case 'playlistinfo': return world.playlistinfo;
        case 'listplaylists': return world.listplaylists;
        default: return [];
      }
    }, { shouldMockEvents: true });
    ({ player: realPlayer, mpd: realMpd } = await import('../../../src/player.js'));
    await realPlayer.start();
  });
  afterAll(() => {
    clearMocks();
    delete (/** @type {any} */ (globalThis)).window;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('the pinned player has every member the model reads', () => {
    for (const k of ['connected', 'status', 'song', 'queue', 'playlists', 'state', 'duration', 'elapsed', 'volume']) {
      expect(k in realPlayer, k).toBe(true);
    }
    for (const m of ['playlistSongs', 'addEventListener', 'removeEventListener']) expect(typeof realPlayer[m], m).toBe('function');
    expect(typeof realMpd).toBe('function');
  });

  it('reads the state, queue and stored playlists the way the player parsed them', async () => {
    world.playlistinfo = [['file', 'x.flac'], ['Id', '11'], ['Pos', '0'], ['Title', 'X'], ['Time', '60'], ['file', 'y.flac'], ['Id', '12'], ['Pos', '1']];
    await setWorld(
      [['state', 'pause'], ['volume', '40'], ['elapsed', '12.5'], ['duration', '200'], ['playlist', '3'], ['playlistlength', '2'], ['song', '1'], ['repeat', '1']],
      [['file', 'y.flac'], ['Id', '12'], ['Pos', '1'], ['Title', 'Y'], ['Time', '200']],
    );
    await realPlayer.refresh(['playlist', 'stored_playlist']);
    const media = createMpdMediaModel(realPlayer, realMpd);
    expect(media.snapshot()).toMatchObject({
      connected: true, playState: 'pause', elapsed: 12.5, duration: 200, volume: 40, repeat: true, random: false,
      queueLength: 2, queueVersion: 3, queuePos: 1,
    });
    expect(media.snapshot().song).toMatchObject({ id: 12, pos: 1, file: 'y.flac', title: 'Y', durationSec: 200 });
    expect(media.queue().map((s) => [s.id, s.pos, s.file])).toEqual([[11, 0, 'x.flac'], [12, 1, 'y.flac']]);
    expect(media.storedPlaylists()).toEqual(['Alpha', 'Zed']);
    media.dispose();
  });

  it('elapsed() is the player\'s extrapolation (player.js:92-97)', async () => {
    vi.useFakeTimers();
    await setWorld([['state', 'play'], ['elapsed', '10'], ['duration', '100'], ['volume', '50']]);
    const media = createMpdMediaModel(realPlayer, realMpd);
    expect(media.elapsed()).toBeCloseTo(10, 5);
    vi.advanceTimersByTime(2500);
    expect(media.elapsed()).toBeCloseTo(12.5, 5);
    vi.advanceTimersByTime(1_000_000);
    expect(media.elapsed()).toBe(100);
    media.dispose();
  });

  /** @type {Array<[string, Array<[string, string]>, (p: any) => unknown, (m: import('../../../src/hosts/tauri/media.js').MpdMediaModel) => Promise<unknown>]>} */
  const parity = [
    ['play, stopped', [['state', 'stop'], ['volume', '50']], (p) => p.play(), (m) => m.play()],
    ['play, paused', [['state', 'pause'], ['volume', '50']], (p) => p.play(), (m) => m.play()],
    ['pause, playing', [['state', 'play'], ['volume', '50']], (p) => p.pause(), (m) => m.pause()],
    ['stop, playing', [['state', 'play'], ['volume', '50']], (p) => p.stop(), (m) => m.stop()],
    ['next', [['state', 'play'], ['volume', '50']], (p) => p.next(), (m) => m.next()],
    ['previous', [['state', 'play'], ['volume', '50']], (p) => p.prev(), (m) => m.previous()],
    ['seek 12.345', [['state', 'play'], ['duration', '200'], ['volume', '50']], (p) => p.seek(12.345), (m) => m.seek(12.345)],
    ['play queue position 2', [['state', 'stop'], ['volume', '50']], (p) => p.playPos(2), (m) => m.playQueuePos(2)],
    ['play a stored playlist at 1', [['state', 'stop'], ['volume', '50']], (p) => p.playPlaylist('Road Mix', 1), (m) => m.playPlaylist('Road Mix', 1)],
  ];
  it.each(parity)('wire traffic equals the legacy helper: %s', async (_name, status, legacy, viaModel) => {
    await setWorld(status);
    await legacy(realPlayer);
    const expected = commands();
    expect(expected.length).toBeGreaterThan(0);
    wire.length = 0;
    const media = createMpdMediaModel(realPlayer, realMpd);
    await viaModel(media);
    expect(commands()).toEqual(expected);
    media.dispose();
  });

  it('volume: the debounced setvol equals the legacy `setvol` (rounded)', async () => {
    vi.useFakeTimers();
    await setWorld([['state', 'stop'], ['volume', '50']]);
    await realPlayer.setVolume(33.4);
    const expected = commands();
    wire.length = 0;
    const media = createMpdMediaModel(realPlayer, realMpd);
    media.setVolume(10);
    media.setVolume(33.4);
    await vi.advanceTimersByTimeAsync(VOLUME_COALESCE_MS);
    expect(commands()).toEqual(expected);
    expect(expected).toEqual([['setvol', '33']]);
    media.dispose();
  });

  it('subscribe: a refresh from MPD\'s idle notice reports the changed keys', async () => {
    await setWorld([['state', 'stop'], ['volume', '50']]);
    const media = createMpdMediaModel(realPlayer, realMpd);
    /** @type {string[][]} */
    const heard = [];
    media.subscribe((c) => heard.push([...c].sort()));
    world.status = [['state', 'play'], ['volume', '50'], ['elapsed', '1.5'], ['duration', '90']];
    await emit('mpd-idle', ['player']);
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    expect(heard[0]).toEqual(['duration', 'elapsed', 'playState']);
    media.dispose();
  });
});
