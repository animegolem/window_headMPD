// @ts-check
// Scripted fake MediaModel for the test host (ENGINE.md §5.6, D6.3, D8). It stands in for MPD: it
// starts from one of the `parity 4.1` presets, answers the MediaModel reads, applies just enough MPD
// semantics to the commands that bindings and handlers can drive them, and records every command in
// `calls`. A test steers it from outside with `emit` / `set` / `setQueue`.
//
// The preset rows (titles, durations, status fields) are NOT written here. They come from
// tools/skinlab/media-presets.js, the single source the legacy goldens were captured with (G0
// ruling); retyping them would let S3/S3b drift from the goldens without any test noticing.
//
// `song` is null in every preset, because the fixture's `currentsong` is empty ("no now-playing toast
// and no palette call", parity 4.1) even where `status.song` is '1'. S3/S3b highlight row 1 from that
// queue position (parity 4.4, playlist.js:65), so it travels in `MediaState.queuePos` (G1 ruling): the
// preset's wire `status.song`, or null when the status has none. Nothing here invents a `song` to
// carry it. Only the preset seeds `queuePos`; commands leave it alone (a test moves it with `emit`).
//
// Notifications are delivered synchronously, before the command's promise settles. The Tauri adapter
// delivers them after an MPD round trip; engine code must not depend on either order.

import { MEDIA_PRESET_NAMES, mediaPreset, queueRecords } from '../../../tools/skinlab/media-presets.js';

/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../../engine/contracts').MediaState} MediaState */
/** @typedef {import('../../engine/contracts').SongInfo} SongInfo */
/** @typedef {keyof MediaState} MediaKey */
/** @typedef {{ method: string, args: unknown[], changed: boolean }} MediaCall `changed`: the command altered the published state */
/** @typedef {{ now(): number }} NowSource */
/**
 * @typedef {MediaModel & {
 *   readonly preset: string,
 *   readonly presetStatus: Readonly<Record<string, string>>,
 *   readonly calls: MediaCall[],
 *   clearCalls(): void,
 *   emit(changes: Partial<MediaState> | Iterable<MediaKey>): ReadonlySet<MediaKey>,
 *   set(patch: Partial<MediaState>): ReadonlySet<MediaKey>,
 *   setQueue(rows: readonly SongInfo[]): void,
 *   setStoredPlaylists(lists: Map<string, readonly SongInfo[]> | Record<string, readonly SongInfo[]>): void,
 * }} FakeMedia
 */

export { MEDIA_PRESET_NAMES };

/** @param {string | number | undefined} v @param {number} fallback */
const int = (v, fallback) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};
/** @param {string | number | undefined} v @returns {number | null} null when absent or not an integer */
const intOrNull = (v) => {
  if (v === undefined) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};
/** @param {string | number | undefined} v */
const num = (v) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
/** @param {string | number | undefined} v */
const str = (v) => (v === undefined ? '' : String(v));

/**
 * One `playlistinfo` record, as media-presets.js writes it, to a SongInfo.
 * @param {Readonly<Record<string, string | number | undefined>>} r
 * @returns {SongInfo}
 */
const songOf = (r) => Object.freeze({
  id: int(r.Id, 0), pos: int(r.Pos, 0), file: str(r.file), title: str(r.Title), artist: str(r.Artist),
  album: str(r.Album), genre: str(r.Genre), track: str(r.Track), date: str(r.Date),
  durationSec: num(r.Time),
});

/** The preset's queue rows as SongInfo. Throws for an unknown preset name. @param {string} name @returns {readonly SongInfo[]} */
export const presetQueue = (name) => Object.freeze(queueRecords(name).map(songOf));

/**
 * An MPD `status` record (the wire strings of media-presets.js) as MediaState, the mapping
 * `player.js` applies: duration falls back to the song's Time, volume to -1 (no mixer).
 * @param {Readonly<Record<string, string>>} status
 * @returns {MediaState}
 */
export function stateFromStatus(status) {
  const playState = status.state === 'play' || status.state === 'pause' ? status.state : 'stop';
  return {
    connected: true,
    playState,
    elapsed: num(status.elapsed),
    duration: num(status.duration),
    volume: int(status.volume, -1),
    random: status.random === '1',
    repeat: status.repeat === '1',
    single: status.single === '1',
    consume: status.consume === '1',
    song: null,
    queueLength: int(status.playlistlength, 0),
    queueVersion: int(status.playlist, 0),
    queuePos: intOrNull(status.song),
    bitrateKbps: status.bitrate === undefined ? null : int(status.bitrate, 0),
    error: status.error ?? null,
  };
}

/** The initial MediaState of a preset. @param {string} name @returns {MediaState} */
export const presetState = (name) => stateFromStatus(/** @type {Record<string, string>} */ (mediaPreset(name).status));

/**
 * The oracle's isAvailable table (E D6, parity D16), keyed by lowercased name: skins spell these
 * `Stop`, `currentPosition`, ... (U-4). A Map, so `__proto__` and `constructor` are not entries.
 * @type {ReadonlyMap<string, (s: Readonly<MediaState>) => boolean>}
 */
const AVAILABILITY = new Map(/** @type {Array<[string, (s: Readonly<MediaState>) => boolean]>} */ ([
  ['play', () => true],
  ['next', () => true],
  ['previous', () => true],
  ['stop', (s) => s.playState !== 'stop'],
  ['pause', (s) => s.playState === 'play'],
  ['currentposition', (s) => s.duration > 0],
  ['fastforward', () => false],
  ['fastreverse', () => false],
]));

/** @type {ReadonlySet<string>} */
const STATE_KEYS = new Set(Object.keys(presetState('stoppedEmpty')));

/**
 * @param {string | null | undefined} [presetName] one of MEDIA_PRESET_NAMES (default `stoppedEmpty`)
 * @param {{ clock?: NowSource }} [opts] `clock` drives elapsed extrapolation; without it time stands still at 0
 * @returns {FakeMedia}
 */
export function createFakeMedia(presetName, opts = {}) {
  const preset = presetName ?? 'stoppedEmpty';
  const clock = opts.clock ?? { now: () => 0 };
  const presetStatus = Object.freeze({ .../** @type {Record<string, string>} */ (mediaPreset(preset).status) });

  /** @type {Readonly<MediaState>} */
  let state = Object.freeze(stateFromStatus(presetStatus));
  /** @type {readonly SongInfo[]} */
  let queue = presetQueue(preset);
  /** @type {Map<string, readonly SongInfo[]>} */
  let stored = new Map();
  let nextSongId = queue.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  /** Queue position `play()` starts from when nothing is current: MPD's `status.song`.
   *  @type {number | null} */
  let selected = presetStatus.song === undefined ? null : int(presetStatus.song, 0);
  /** Where `elapsed` was last published and when: the base of the live extrapolation. */
  let anchor = { elapsed: state.elapsed, at: clock.now() };
  /** @type {Set<(changed: ReadonlySet<MediaKey>) => void>} */
  const listeners = new Set();
  /** @type {MediaCall[]} */
  const calls = [];

  /** player.js:92-97: base + time since the status, capped by the duration when there is one. */
  const liveElapsed = () => {
    if (state.playState !== 'play') return state.elapsed;
    return Math.min(state.duration || Infinity, anchor.elapsed + (clock.now() - anchor.at) / 1000);
  };

  /** @param {ReadonlySet<MediaKey>} changed */
  const notify = (changed) => {
    /** @type {unknown} */
    let failure = null;
    let failed = false;
    for (const cb of [...listeners]) {
      if (!listeners.has(cb)) continue;
      try { cb(new Set(changed)); } catch (e) { if (!failed) { failed = true; failure = e; } }
    }
    if (failed) throw failure;
  };

  /** @param {Iterable<string>} keys @returns {Set<MediaKey>} */
  const checkedKeys = (keys) => {
    const out = new Set();
    for (const k of keys) {
      if (!STATE_KEYS.has(k)) throw new TypeError(`unknown MediaState key "${String(k)}"`);
      out.add(/** @type {MediaKey} */ (k));
    }
    return out;
  };

  /**
   * Apply a patch to the state and tell subscribers which keys really changed.
   * Leaving `play` freezes `elapsed` at its live value; an explicit `elapsed` re-bases the extrapolation.
   * @param {Partial<MediaState>} patch
   * @returns {Set<MediaKey>}
   */
  const commit = (patch) => {
    checkedKeys(Object.keys(patch));
    const prev = state;
    const next = { ...prev, ...patch };
    let rebase = 'elapsed' in patch;
    if (!rebase && next.playState !== prev.playState) {
      next.elapsed = prev.playState === 'play' ? liveElapsed() : prev.elapsed;
      rebase = true;
    }
    /** @type {Set<MediaKey>} */
    const changed = new Set(/** @type {MediaKey[]} */ (Object.keys(next)).filter((k) => !Object.is(prev[k], next[k])));
    if (rebase) anchor = { elapsed: next.elapsed, at: clock.now() };
    if (changed.size === 0) return changed;
    state = Object.freeze(next);
    notify(changed);
    return changed;
  };

  /**
   * Log a command, apply its effect, and report whether the state moved. `effect` returns the patch to
   * commit, or null for "nothing to do" (MPD would not be asked); it may throw to reject the command.
   * @param {string} method
   * @param {unknown[]} args
   * @param {() => Partial<MediaState> | null} effect
   */
  const command = async (method, args, effect) => {
    /** @type {MediaCall} */
    const entry = { method, args, changed: false };
    calls.push(entry);
    const patch = effect();
    if (patch) entry.changed = commit(patch).size > 0;
  };

  /** @param {number} pos @returns {Partial<MediaState>} playing the queue entry at `pos` from its start */
  const startAt = (pos) => {
    const song = queue[pos];
    selected = pos;
    return { playState: 'play', song, duration: song.durationSec, elapsed: 0 };
  };

  /** @param {number} pos */
  const checkPos = (pos) => {
    if (!Number.isInteger(pos) || pos < 0 || pos >= queue.length) throw new Error(`Bad song index: ${pos}`);
  };

  /** @param {readonly SongInfo[]} rows @returns {Partial<MediaState>} */
  const replaceQueue = (rows) => {
    queue = Object.freeze(rows.map((s) => Object.freeze({ ...s })));
    selected = null;
    return { queueLength: queue.length, queueVersion: state.queueVersion + 1 };
  };

  /** One step through the queue. At the head `previous` restarts it; off the tail playback stops. @param {1 | -1} d */
  const step = (d) => {
    const current = state.song;
    if (!current || queue.length === 0) return null;
    let pos = current.pos + d;
    if (pos < 0) pos = state.repeat ? queue.length - 1 : 0;
    else if (pos >= queue.length) {
      if (!state.repeat) return { playState: /** @type {const} */ ('stop'), elapsed: 0, song: null, duration: 0 };
      pos = 0;
    }
    return startAt(pos);
  };

  /** @type {FakeMedia} */
  const media = {
    preset,
    presetStatus,
    calls,
    clearCalls: () => { calls.length = 0; },

    snapshot: () => state,
    elapsed: liveElapsed,
    queue: () => queue,
    storedPlaylists: () => Object.freeze([...stored.keys()].sort((a, b) => a.localeCompare(b))),

    async playlistSongs(name) {
      const rows = stored.get(name);
      if (!rows) throw new Error(`No such playlist: ${name}`);
      return rows;
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    play: () => command('play', [], () => {
      if (state.playState === 'play') return null;
      if (state.playState === 'pause') return { playState: 'play' };
      if (queue.length === 0) return null;                       // MPD cannot start an empty queue
      const pos = state.song?.pos ?? selected ?? 0;
      return startAt(pos < queue.length ? pos : 0);
    }),
    pause: () => command('pause', [], () => (state.playState === 'play' ? { playState: 'pause' } : null)),
    stop: () => command('stop', [], () => (state.playState === 'stop'
      ? null
      : { playState: 'stop', elapsed: 0, duration: state.song?.durationSec ?? 0 })),
    next: () => command('next', [], () => step(1)),
    previous: () => command('previous', [], () => step(-1)),

    seek: (sec) => command('seek', [sec], () => {
      if (state.playState === 'stop' || !Number.isFinite(sec)) return null;
      return { elapsed: Math.min(state.duration > 0 ? state.duration : Infinity, Math.max(0, sec)) };
    }),
    setVolume: (v) => command('setVolume', [v], () => {
      if (state.volume < 0 || !Number.isFinite(v)) return null;  // no mixer: MPD refuses setvol
      return { volume: Math.min(100, Math.max(0, Math.round(v))) };
    }),
    setMode: (mode, on) => command('setMode', [mode, on], () => {
      if (mode !== 'loop' && mode !== 'shuffle') throw new TypeError(`unknown mode "${String(mode)}"`);
      return mode === 'loop' ? { repeat: !!on } : { random: !!on };
    }),

    playQueuePos: (pos) => command('playQueuePos', [pos], () => {
      checkPos(pos);
      return startAt(pos);
    }),
    // player.js: clear, load, play. A bad position leaves the loaded queue in place, as MPD would.
    playPlaylist: (name, pos) => command('playPlaylist', [name, pos], () => {
      const rows = stored.get(name);
      if (!rows) throw new Error(`No such playlist: ${name}`);
      const loaded = replaceQueue(rows.map((s, i) => ({ ...s, pos: i, id: nextSongId++ })));
      const cleared = { ...loaded, playState: /** @type {const} */ ('stop'), elapsed: 0, song: null, duration: 0 };
      if (!Number.isInteger(pos) || pos < 0 || pos >= queue.length) {
        commit(cleared);
        throw new Error(`Bad song index: ${pos}`);
      }
      return { ...cleared, ...startAt(pos) };
    }),

    isAvailable: (control) => AVAILABILITY.get(String(control).toLowerCase())?.(state) ?? false,

    /**
     * `emit(patch)` applies the patch and notifies the keys that really changed (same as `set`).
     * `emit(keys)` notifies exactly those keys without touching the state. Returns the notified keys.
     */
    emit(changes) {
      if (changes === null || typeof changes !== 'object') throw new TypeError('emit(changes): a patch object or an iterable of keys');
      if (Symbol.iterator in changes) {
        const keys = checkedKeys(/** @type {Iterable<string>} */ (changes));
        if (keys.size) notify(keys);
        return keys;
      }
      return commit(/** @type {Partial<MediaState>} */ (changes));
    },
    set: (patch) => commit(patch),

    setQueue(rows) {
      commit(replaceQueue(rows));
      nextSongId = Math.max(nextSongId, ...queue.map((s) => s.id + 1));
    },
    setStoredPlaylists(lists) {
      stored = new Map(lists instanceof Map ? lists : Object.entries(lists));
    },
  };
  return media;
}
