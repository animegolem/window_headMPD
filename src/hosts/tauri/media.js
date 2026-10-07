// @ts-check
// The Tauri-side MediaModel (ENGINE.md §5.6, D6.3): the engine's typed view of MPD, written over the
// pinned, unchanged src/player.js. `player` supplies the state (it already turns `idle` notices into
// status / song / queue events and owns the elapsed extrapolation of player.js:92-97), `mpd` is the raw
// command channel. Both arrive as arguments: this file never imports player.js, so it loads in Node
// under vitest and the engine never sees a Tauri import. The host adapter (W4.2) passes the pinned
// exports in and calls `player.start()` once; the model does not start the player.
//
// Commands are typed and idempotent. They are checked against the confirmed state or, when a command
// is already on its way, against the state it will produce (the "pending" overlay), so two quick
// `play()` calls send one `play`. Each command sends the verb and arguments the matching player.js
// helper sends (`pause 0`, `seekcur 12.35`, `setvol 40`, ...), so the wire traffic equals the legacy
// run's, and the Rust verb allow-list (E §7) already covers every verb used here. No raw MPD string
// is ever built from a caller's value: `mpd` takes an argument array.
//
// Deliberately not here (W2.3's policy layer owns them, because they depend on who is calling):
// the 10-per-second-per-verb cap for script origin and the "dropped and logged" accounting. What this
// layer adds on every origin is the oracle's 40 ms volume debounce (parity D18).

/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../../engine/contracts').MediaState} MediaState */
/** @typedef {import('../../engine/contracts').SongInfo} SongInfo */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {keyof MediaState} MediaKey */
/** @typedef {Readonly<Record<string, string | number | undefined>>} MpdRecord one `status` / `currentsong` / `playlistinfo` record, as player.js builds it */
/**
 * What this model reads of player.js's `Player` (a structural type on purpose: importing the pinned
 * file's own type would pull it into the `tsc` program). The test file drives the real `player`
 * under a mocked IPC, so a rename in player.js fails a test, not the app.
 * @typedef {EventTarget & {
 *   readonly connected: boolean,
 *   readonly status: MpdRecord,
 *   readonly song: MpdRecord | null,
 *   readonly queue: readonly MpdRecord[],
 *   readonly playlists: readonly string[],
 *   readonly state: string,
 *   readonly duration: number,
 *   readonly elapsed: number,
 *   readonly volume: number,
 *   playlistSongs(name: string): Promise<readonly MpdRecord[]>,
 * }} PlayerLike
 */
/** @typedef {(...args: Array<string | number>) => Promise<unknown>} MpdFn the pinned `mpd` export */
/**
 * @typedef {{
 *   availability?: 'oracle',
 *   now?: () => number,
 *   timers?: { setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void },
 *   log?: Pick<Log, 'warn'>,
 * }} MpdMediaOptions
 *   `availability`: which `isAvailable` table (only the oracle's exists in phase 1; 'mpd' is a phase-3
 *   decision, parity open question 5). `now` and `timers` default to `performance.now` and the global
 *   timers, looked up at call time so fake timers work.
 * @typedef {MediaModel & { dispose(): void }} MpdMediaModel
 */

/** parity D18: the oracle debounces volume input at 40 ms (main.js:102-103). */
export const VOLUME_COALESCE_MS = 40;
/** A pending command stops counting after this long even if no new status arrived (a `play` on an empty
 *  queue changes nothing, so MPD sends no idle notice to retire it). */
export const PENDING_TTL_MS = 1500;

/** The player.js events that carry state. `playlists` has no MediaState key (see `subscribe`). */
const STATE_EVENTS = ['connection', 'status', 'song', 'queue'];

/** @type {readonly MediaKey[]} */
const STATE_KEYS = Object.freeze(/** @type {MediaKey[]} */ ([
  'connected', 'playState', 'elapsed', 'duration', 'volume', 'random', 'repeat', 'single', 'consume',
  'song', 'queueLength', 'queueVersion', 'queuePos', 'bitrateKbps', 'error',
]));
/** @type {readonly (keyof SongInfo)[]} */
const SONG_KEYS = Object.freeze(/** @type {(keyof SongInfo)[]} */ ([
  'id', 'pos', 'file', 'title', 'artist', 'album', 'genre', 'track', 'date', 'durationSec',
]));

/** @param {unknown} v @param {number} fallback */
const int = (v, fallback) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};
/** @param {unknown} v @returns {number | null} null when absent or not an integer */
const intOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};
/** MPD booleans are the strings '0' and '1'. @param {unknown} v */
const flag = (v) => String(v) === '1';
/** @param {unknown} v */
const num = (v) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
/** @param {unknown} v */
const str = (v) => (v === undefined || v === null ? '' : String(v));

/** @param {unknown} s @returns {'play' | 'pause' | 'stop'} */
const playStateOf = (s) => (s === 'play' || s === 'pause' ? s : 'stop');

/**
 * One MPD record as a SongInfo. `title` is Title, else Name (radio streams carry only a Name): the
 * contract has no `name` field, and folding it here gives `currentMedia.name` its player.js:30-31
 * order (Title, Name, file stem) from `title` and `file` alone. A record without an `Id` (stored
 * playlist rows have none) gets -1, which can never equal a real MPD id; without a `Pos`, `index`.
 * @param {MpdRecord} r
 * @param {number} index
 * @returns {SongInfo}
 */
const songOf = (r, index) => Object.freeze({
  id: int(r.Id, -1),
  pos: int(r.Pos, index),
  file: str(r.file),
  title: str(r.Title) || str(r.Name),
  artist: str(r.Artist),
  album: str(r.Album),
  genre: str(r.Genre),
  track: str(r.Track),
  date: str(r.Date),
  durationSec: num(r.duration ?? r.Time),          // playlist.js:44 reads them in this order
});

/** @param {SongInfo | null} a @param {SongInfo | null} b */
const sameSong = (a, b) => a === b || (a !== null && b !== null && SONG_KEYS.every((k) => a[k] === b[k]));

/**
 * The oracle's isAvailable table (E D6, parity D16), keyed by lowercased name: skins spell these
 * `Stop`, `currentPosition`, ... (U-4). Maps all the way down: the name comes from a skin, so
 * `__proto__` and `constructor` must not find anything.
 * @type {ReadonlyMap<string, ReadonlyMap<string, (s: Readonly<MediaState>) => boolean>>}
 */
const AVAILABILITY_TABLES = new Map([
  ['oracle', new Map(/** @type {Array<[string, (s: Readonly<MediaState>) => boolean]>} */ ([
    ['play', () => true],
    ['next', () => true],
    ['previous', () => true],
    ['stop', (s) => s.playState !== 'stop'],
    ['pause', (s) => s.playState === 'play'],
    ['currentposition', (s) => s.duration > 0],
    ['fastforward', () => false],
    ['fastreverse', () => false],
  ]))],
]);

/**
 * @param {PlayerLike} player the pinned `player` export of src/player.js
 * @param {MpdFn} mpd the pinned `mpd` export of src/player.js
 * @param {MpdMediaOptions} [opts]
 * @returns {MpdMediaModel}
 */
export function createMpdMediaModel(player, mpd, opts = {}) {
  const availability = opts.availability ?? 'oracle';
  const table = AVAILABILITY_TABLES.get(availability);
  if (!table) throw new RangeError(`availability "${String(availability)}" is not implemented (phase 3, parity open question 5)`);
  const now = opts.now ?? (() => performance.now());
  const timers = opts.timers ?? {
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (/** @type {unknown} */ id) => globalThis.clearTimeout(/** @type {any} */ (id)),
  };
  const warn = (/** @type {string} */ m, /** @type {object} */ d) => {
    if (opts.log) opts.log.warn(m, d);
    else console.warn(m, d);
  };

  // ---- state ------------------------------------------------------------------------------------

  /** @type {SongInfo | null} */
  let lastSong = null;
  /** The current song as a SongInfo, the same object while its fields are unchanged. @param {MpdRecord | null} rec */
  const currentSong = (rec) => {
    if (!rec) return (lastSong = null);
    const next = songOf(rec, -1);
    return sameSong(lastSong, next) ? lastSong : (lastSong = next);
  };

  /** @type {Readonly<MediaState> | null} */
  let last = null;
  /**
   * The state as of now. Built from player.js's own getters where it has them (`state`, `duration`,
   * `volume`), so the derivations (duration falls back to the song's Time, volume to -1) are the
   * oracle's. The same frozen object comes back while no field changed. `elapsed` is MPD's value at
   * the last status; `elapsed()` is the live one.
   * @returns {Readonly<MediaState>}
   */
  const snapshot = () => {
    const status = player.status ?? {};
    const volume = player.volume;
    const duration = player.duration;
    /** @type {MediaState} */
    const next = {
      connected: !!player.connected,
      playState: playStateOf(player.state),
      elapsed: Math.max(0, num(status.elapsed)),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      volume: Number.isFinite(volume) ? volume : -1,
      random: flag(status.random),
      repeat: flag(status.repeat),
      single: flag(status.single),
      consume: flag(status.consume),
      song: currentSong(player.song),
      queueLength: Math.max(0, int(status.playlistlength, 0)),
      queueVersion: int(status.playlist, 0),
      queuePos: intOrNull(status.song),
      bitrateKbps: intOrNull(status.bitrate),
      error: status.error === undefined ? null : String(status.error),
    };
    if (last && STATE_KEYS.every((k) => Object.is(/** @type {Readonly<MediaState>} */ (last)[k], next[k]))) return last;
    return (last = Object.freeze(next));
  };

  /** @type {readonly MpdRecord[] | null} */
  let queueSrc = null;
  let queueLen = -1;
  /** @type {readonly SongInfo[]} */
  let queueRows = Object.freeze([]);
  /** player.js replaces `queue` on every refresh, so identity (plus length, as a cheap guard) is the cache key. */
  const queue = () => {
    const src = player.queue ?? [];
    if (src !== queueSrc || src.length !== queueLen) {
      queueSrc = src;
      queueLen = src.length;
      queueRows = Object.freeze(src.map((r, i) => songOf(r, i)));
    }
    return queueRows;
  };

  /** @type {readonly string[] | null} */
  let listsSrc = null;
  let listsLen = -1;
  /** @type {readonly string[]} */
  let listsOut = Object.freeze([]);
  const storedPlaylists = () => {
    const src = player.playlists ?? [];
    if (src !== listsSrc || src.length !== listsLen) {
      listsSrc = src;
      listsLen = src.length;
      listsOut = Object.freeze(src.map(String));
    }
    return listsOut;
  };

  // ---- pending commands -------------------------------------------------------------------------

  /** @typedef {{ value: unknown, status: unknown, until: number }} Pending */
  /** key -> what a sent command will make true. Retired by the next status object, a rejection or the TTL. @type {Map<string, Pending>} */
  const pending = new Map();

  /** @param {string} key @param {unknown} value @returns {Pending} */
  const setPending = (key, value) => {
    /** @type {Pending} */
    const entry = { value, status: player.status, until: now() + PENDING_TTL_MS };
    pending.set(key, entry);
    return entry;
  };
  /** @param {string} key @param {Pending} entry */
  const retire = (key, entry) => { if (pending.get(key) === entry) pending.delete(key); };
  /**
   * The value a new command should be judged against: the pending one while it is still the freshest
   * information, else the confirmed one.
   * @template T
   * @param {string} key @param {T} confirmed @returns {T}
   */
  const effective = (key, confirmed) => {
    const p = pending.get(key);
    if (!p) return confirmed;
    if (p.status !== player.status || now() >= p.until) {
      pending.delete(key);
      return confirmed;
    }
    return /** @type {T} */ (p.value);
  };

  /**
   * Send one command and hold its expected effect as pending until MPD's next status.
   * @param {string} key @param {unknown} value @param {Array<string | number>} args
   */
  const run = async (key, value, args) => {
    const entry = setPending(key, value);
    try {
      await mpd(...args);
    } catch (e) {
      retire(key, entry);
      throw e;
    }
  };

  // ---- volume: trailing 40 ms debounce (parity D18) ----------------------------------------------

  /** @type {unknown} */
  let volumeTimer = null;
  let volumeTarget = 0;
  /** @type {Array<{ resolve: () => void, reject: (e: unknown) => void }>} */
  let volumeWaiters = [];
  let warnedNoMixer = false;

  const flushVolume = () => {
    volumeTimer = null;
    const waiters = volumeWaiters;
    volumeWaiters = [];
    const target = volumeTarget;
    /** @type {Promise<void>} */
    let done;
    const current = effective('volume', snapshot().volume);
    if (current < 0) {
      // No mixer: MPD would refuse `setvol`, and the object model reads 0 here (parity D9).
      if (!warnedNoMixer) {
        warnedNoMixer = true;
        warn('media: setVolume dropped, MPD has no mixer', { requested: target });
      }
      done = Promise.resolve();
    } else if (target === current) {
      done = Promise.resolve();
    } else {
      done = run('volume', target, ['setvol', target]);
    }
    done.then(
      () => waiters.forEach((w) => w.resolve()),
      (e) => waiters.forEach((w) => w.reject(e)),
    );
  };

  // ---- subscription ----------------------------------------------------------------------------

  /** @type {Set<(changed: ReadonlySet<MediaKey>) => void>} */
  const listeners = new Set();
  /** @type {Readonly<MediaState> | null} */
  let published = null;
  let attached = false;

  /** @param {ReadonlySet<MediaKey>} changed */
  const emit = (changed) => {
    for (const cb of [...listeners]) {
      if (!listeners.has(cb)) continue;
      try {
        cb(new Set(changed));
      } catch (e) {
        // One bad subscriber must not starve the rest, and a throw out of a player event listener
        // would only surface as an uncaught error anyway.
        warn('media: a subscriber threw', { error: String(e) });
      }
    }
  };

  /** @param {Event} ev */
  const onPlayerEvent = (ev) => {
    const next = snapshot();
    const prev = published ?? next;
    published = next;
    /** @type {Set<MediaKey>} */
    const changed = new Set(STATE_KEYS.filter((k) => !Object.is(prev[k], next[k])));
    // player.js reads `status` before it re-reads the queue, so `queueVersion` has usually been
    // announced by the time the rows land. `queueVersion` names the rows behind `queue()`, so the
    // `queue` event repeats it: that is the signal to re-read them.
    if (ev.type === 'queue') changed.add('queueVersion');
    if (changed.size) emit(changed);
  };

  const attach = () => {
    if (attached) return;
    attached = true;
    published = snapshot();
    for (const t of STATE_EVENTS) player.addEventListener(t, onPlayerEvent);
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    for (const t of STATE_EVENTS) player.removeEventListener(t, onPlayerEvent);
  };

  // ---- the model -------------------------------------------------------------------------------

  /** @type {MpdMediaModel} */
  const media = {
    snapshot,
    /** player.js:92-97 by delegation: MPD's elapsed plus the time since the status, capped by the duration. */
    elapsed: () => player.elapsed,
    queue,
    storedPlaylists,

    async playlistSongs(name) {
      if (typeof name !== 'string' || name === '') throw new TypeError('playlistSongs(name): a non-empty playlist name');
      const rows = await player.playlistSongs(name);
      return Object.freeze(rows.map((r, i) => songOf(r, i)));
    },

    /**
     * Fires for every key whose value changed between two player events. `playlists` events are not
     * forwarded: no MediaState key stands for the stored-playlist list (recorded for O).
     */
    subscribe(cb) {
      listeners.add(cb);
      attach();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) detach();
      };
    },

    // player.js:107-108. Playing: nothing to do. Paused: resume. Anything else: start.
    async play() {
      const state = effective('playState', snapshot().playState);
      if (state === 'play') return;
      await (state === 'pause' ? run('playState', 'play', ['pause', 0]) : run('playState', 'play', ['play']));
    },
    async pause() {
      if (effective('playState', snapshot().playState) !== 'play') return;
      await run('playState', 'pause', ['pause', 1]);
    },
    async stop() {
      if (effective('playState', snapshot().playState) === 'stop') return;
      await run('playState', 'stop', ['stop']);
    },
    async next() { await mpd('next'); },
    async previous() { await mpd('previous'); },

    /** `seekcur` needs a playing or paused song, so a stopped player sends nothing. Clamped to 0..duration. */
    async seek(sec) {
      if (typeof sec !== 'number' || !Number.isFinite(sec)) return;
      if (effective('playState', snapshot().playState) === 'stop') return;
      const duration = snapshot().duration;
      const to = Math.max(0, duration > 0 ? Math.min(duration, sec) : sec);
      await mpd('seekcur', to.toFixed(2));              // player.js:115
    },

    setVolume(v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return Promise.resolve();
      volumeTarget = Math.min(100, Math.max(0, Math.round(v)));
      return new Promise((resolve, reject) => {
        volumeWaiters.push({ resolve, reject });
        if (volumeTimer !== null) timers.clearTimeout(volumeTimer);
        volumeTimer = timers.setTimeout(flushVolume, VOLUME_COALESCE_MS);
      });
    },

    async setMode(mode, on) {
      /** @type {'repeat' | 'random'} */
      let key;
      switch (mode) {
        case 'loop': key = 'repeat'; break;
        case 'shuffle': key = 'random'; break;
        default: throw new TypeError(`setMode: unknown mode "${String(mode)}"`);
      }
      const want = !!on;
      if (effective(key, snapshot()[key]) === want) return;
      await run(key, want, [key, want ? 1 : 0]);
    },

    async playQueuePos(pos) {
      if (!Number.isInteger(pos) || pos < 0) throw new RangeError(`playQueuePos: bad queue position ${String(pos)}`);
      await run('playState', 'play', ['play', pos]);
    },

    /** Replace the queue with a stored playlist and start at `pos` (player.js:120-124). */
    async playPlaylist(name, pos) {
      if (typeof name !== 'string' || name === '') throw new TypeError('playPlaylist(name, pos): a non-empty playlist name');
      if (!Number.isInteger(pos) || pos < 0) throw new RangeError(`playPlaylist: bad queue position ${String(pos)}`);
      const entry = setPending('playState', 'play');
      try {
        await mpd('clear');
        await mpd('load', name);
        await mpd('play', pos);
      } catch (e) {
        retire('playState', entry);
        throw e;
      }
    },

    isAvailable: (control) => (typeof control === 'string' ? table.get(control.toLowerCase())?.(snapshot()) ?? false : false),

    /** Cancels a waiting volume write (its callers resolve) and detaches from the player. */
    dispose() {
      if (volumeTimer !== null) {
        timers.clearTimeout(volumeTimer);
        volumeTimer = null;
        const waiters = volumeWaiters;
        volumeWaiters = [];
        waiters.forEach((w) => w.resolve());
      }
      listeners.clear();
      detach();
    },
  };
  return media;
}
