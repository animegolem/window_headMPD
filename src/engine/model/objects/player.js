// @ts-check
// `player` and everything under it: `controls`, `settings`, `currentMedia`, `network`,
// `currentPlaylist`, and the `playerApplication` global (E D6 mapping table, D6.2 enums, D6.5
// policies; spec 7.1, 7.2; parity 3.7). MPD is reached only through the host's `MediaModel` and
// `DspPort`: this file never sees a raw MPD string.
//
// State is read from `MediaModel.snapshot()` at the moment of the read, so a change source only has
// to say *that* something changed. Commands are typed and idempotent in the media model; what is
// added here is D6.5: a rate cap of ten per second per verb for everything a skin can send, and a
// trailing 40 ms debounce for `seek` and `setVolume` (the latest value goes out 40 ms after the last
// write) with the written value readable meanwhile.

import { bool, clamp, int, keyOf, makeObject, num, text } from './core.js';

/** @typedef {import('../../contracts').MediaState} MediaState */
/** @typedef {import('../../contracts').SongInfo} SongInfo */
/** @typedef {import('./core.js').GraphObject} GraphObject */

/** Parity D17: balance values within this of the centre are the centre. */
export const BALANCE_DETENT = 5;
/** `player.versionInfo`: the WMP 11 build the corpus was written against. */
export const VERSION_INFO = '11.0.5721.5145';

// ---- pure derivations (tested on their own) -------------------------------------------------------

/**
 * `MM:SS`, or `HH:MM:SS` from one hour (spec 7.2): `00:00`, `03:07`, `01:00:00`. Whole seconds,
 * truncated, as a clock shows them. Not `player.js`'s `fmtTime`, which drops the zero padding.
 * @param {number} sec
 */
export function clockString(sec) {
  const s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** A song or a queue to come back to: what makes a stopped player "ready with media". @param {Readonly<MediaState>} s */
const hasMedia = (s) => s.song !== null || s.queueLength > 0;

/**
 * `player.playState` (D6.2, wmploc 7.5): play 3, pause 2, stop with media 1, an empty stopped
 * player 0, and an unreachable MPD 0.
 * @param {Readonly<MediaState>} s
 */
export function playStateOf(s) {
  if (!s.connected) return 0;
  if (s.playState === 'play') return 3;
  if (s.playState === 'pause') return 2;
  return hasMedia(s) ? 1 : 0;
}

/** `player.openState`: media open (13) whenever there is something to play, else undefined (0). @param {Readonly<MediaState>} s */
export function openStateOf(s) {
  if (!s.connected) return 0;
  if (s.playState === 'play' || s.playState === 'pause') return 13;
  return hasMedia(s) ? 13 : 0;
}

/** `player.status`: our own English strings (U-32 leaves the real ones undocumented). @param {Readonly<MediaState>} s */
export function statusOf(s) {
  if (!s.connected) return 'Connecting…';
  if (s.playState === 'play') return 'Playing';
  if (s.playState === 'pause') return 'Paused';
  return hasMedia(s) ? 'Stopped' : 'Ready';
}

/** The item's name: title, else the file's stem (`player.js:28-31`). @param {SongInfo | null | undefined} song */
export function songName(song) {
  if (!song) return '';
  if (song.title) return song.title;
  const base = (song.file ?? '').split('/').pop() ?? '';
  return base.replace(/\.[^.]+$/, '');
}

/**
 * The oracle's `isAvailable` table (parity D16), by lowercased name: stop iff not stopped, pause iff
 * playing, play, next and previous always, the position iff there is a duration, scanning never. A
 * Map, so a skin asking about `constructor` is simply unavailable.
 * @type {ReadonlyMap<string, (s: Readonly<MediaState>) => boolean>}
 */
const ORACLE_AVAILABLE = new Map(/** @type {Array<[string, (s: Readonly<MediaState>) => boolean]>} */ ([
  ['play', () => true], ['next', () => true], ['previous', () => true],
  ['stop', (s) => s.playState !== 'stop'],
  ['pause', (s) => s.playState === 'play'],
  ['currentposition', (s) => s.duration > 0],
  ['fastforward', () => false], ['fastreverse', () => false],
]));

/**
 * The attributes `getItemInfo` answers, by lowercased key, and the order `getAttributeName` lists
 * them. The corpus asks for Author (301), Bitrate, Artist, Album, Title, Type and a few others (spec
 * 7.1); everything else is the empty string.
 * @type {ReadonlyMap<string, { name: string, of(song: SongInfo, s: Readonly<MediaState>): string }>}
 */
const ITEM_INFO = new Map([
  ['author', { name: 'Author', of: (/** @type {SongInfo} */ song) => song.artist }],
  ['artist', { name: 'Artist', of: (song) => song.artist }],
  ['title', { name: 'Title', of: (song) => songName(song) }],
  ['album', { name: 'Album', of: (song) => song.album }],
  ['wm/albumtitle', { name: 'WM/AlbumTitle', of: (song) => song.album }],
  ['wm/tracknumber', { name: 'WM/TrackNumber', of: (song) => song.track }],
  ['genre', { name: 'Genre', of: (song) => song.genre }],
  ['sourceurl', { name: 'SourceURL', of: (song) => song.file }],
  ['bitrate', { name: 'Bitrate', of: (_song, s) => (s.bitrateKbps ? String(s.bitrateKbps * 1000) : '') }],
  ['type', { name: 'Type', of: () => 'audio' }],
]);

/** Cap on live `currentPlaylist.item(i)` objects: a skin that walks a large queue gets null past it. */
export const MAX_PLAYLIST_ITEMS = 256;

// ---- the objects ----------------------------------------------------------------------------------

/**
 * @param {import('./index.js').Env} env
 * @returns {{ player: GraphObject, controls: GraphObject, settings: GraphObject, media: GraphObject,
 *   network: GraphObject, playlist: GraphObject, playerApplication: GraphObject }}
 */
export function createPlayerObjects(env) {
  const { host, opts, policy, hub, ledger, ref } = env;
  const media = host.media;
  const dsp = host.dsp;
  /** @type {() => Readonly<MediaState>} */
  const snap = () => media.snapshot();

  /** @param {unknown} e @param {string} api */
  const failed = (e, api) => host.log.warn(`${api}: ${e instanceof Error ? e.message : String(e)}`);

  /**
   * One MPD command from script origin: rate capped per verb, a rejection logged, never thrown (a
   * handler cannot do anything about an MPD error, and the next command may well work).
   * @param {string} verb @param {string} api @param {() => Promise<void> | void} run
   */
  function command(verb, api, run) {
    if (!policy.admit(verb, api)) return;
    try {
      Promise.resolve(run()).catch((e) => failed(e, api));
    } catch (e) {
      failed(e, api);
    }
  }

  // ---- currentMedia and the queue items -----------------------------------------------------------

  /**
   * A Media object over one song. `currentMedia` follows the current song; a playlist item follows its
   * queue position. The same class either way, so `player.currentMedia` and `currentPlaylist.item(i)`
   * answer alike.
   * @param {() => SongInfo | null} songOf @param {() => number} durationOf
   * @param {boolean} isCurrent only the current song has a status bitrate
   */
  function mediaObject(songOf, durationOf, isCurrent) {
    /** @param {SongInfo} song */
    const infoOf = (song) => (/** @type {{ of(song: SongInfo, s: Readonly<MediaState>): string }} */ info) => info.of(song, isCurrent ? snap() : { ...snap(), bitrateKbps: null });
    /** The attributes that have a value, in table order (WMP's attributeCount counts the set ones). */
    const present = () => {
      const song = songOf();
      return song ? [...ITEM_INFO.values()].filter((a) => infoOf(song)(a) !== '') : [];
    };
    return makeObject(env, 'media', {
      name: { get: () => songName(songOf()) },
      duration: { get: () => durationOf() },
      durationString: { get: () => clockString(durationOf()) },
      sourceURL: { get: () => songOf()?.file ?? '' },
      imageSourceWidth: { get: () => 0 },
      imageSourceHeight: { get: () => 0 },
      attributeCount: { get: () => present().length },
      getAttributeName: { call: ([i]) => present()[int(i, -1)]?.name ?? '' },
      getItemInfo: {
        call: ([key]) => {
          const song = songOf();
          const info = ITEM_INFO.get(keyOf(text(key ?? '')).trim());
          return song && info ? infoOf(song)(info) : '';
        },
      },
    });
  }

  const currentMedia = mediaObject(() => snap().song, () => snap().duration, true);

  // ---- controls -----------------------------------------------------------------------------------

  /** The position a read sees: a seek the script just wrote, until MPD echoes it. */
  const positionNow = () => policy.pending('seek') ?? media.elapsed();

  /** @param {unknown} name @returns {boolean} */
  function isAvailable(name) {
    const key = keyOf(text(name ?? '')).trim();
    if (opts.availability === 'mpd') return media.isAvailable(key);
    return ORACLE_AVAILABLE.get(key)?.(snap()) ?? false;
  }

  const controls = makeObject(env, 'controls', {
    play: { call: () => command('play', 'player.controls.play', () => media.play()) },
    pause: { call: () => command('pause', 'player.controls.pause', () => media.pause()) },
    stop: { call: () => command('stop', 'player.controls.stop', () => media.stop()) },
    next: { call: () => command('next', 'player.controls.next', () => media.next()) },
    previous: { call: () => command('previous', 'player.controls.previous', () => media.previous()) },
    currentPosition: {
      get: () => positionNow(),
      set: (v) => {
        const sec = num(v, NaN);
        if (Number.isNaN(sec)) return;
        policy.coalesce('seek', 'player.controls.currentPosition', Math.max(0, sec), (x) => media.seek(x));
        hub.emit('media.position');
      },
    },
    currentPositionString: { get: () => clockString(positionNow()) },
    isAvailable: { call: ([name]) => isAvailable(name) },
    currentItem: { get: () => ref(currentMedia) },
  });

  // ---- settings: volume, the mute emulation, balance, modes ---------------------------------------

  let muted = false;
  /** The volume to come back to; while muted, also what `volume` reads (WMP keeps the two apart). */
  let savedVolume = 0;

  const volumeNow = () => {
    if (snap().volume < 0) return 0;                          // no mixer: reads give 0 (parity D9)
    if (muted) return savedVolume;
    return policy.pending('volume') ?? snap().volume;
  };

  /** @param {number} v */
  const sendVolume = (v) => policy.coalesce('volume', 'player.settings.volume', v, (x) => media.setVolume(x));

  /** MPD echoed a volume: leave the debounce's hold, and notice someone else un-muting us. */
  env.mediaHooks.push((changed) => {
    if (changed.has('volume')) {
      const ours = policy.pending('volume') !== undefined;
      if (muted && !ours && snap().volume > 0) {
        muted = false;
        hub.emit('settings.mute');
      }
      policy.settle('volume');
    }
    if (changed.has('elapsed') || changed.has('playState') || changed.has('song')) policy.settle('seek');
  });

  /** @param {string} api @param {string} why */
  const noMixer = (api, why) => { ledger.record(api, 'stub', `MPD reports no mixer; ${why}`); };

  /** @param {unknown} name @returns {'loop' | 'shuffle' | null} */
  const modeOf = (name) => {
    const m = keyOf(text(name ?? '')).trim();
    return m === 'loop' ? 'loop' : m === 'shuffle' ? 'shuffle' : null;
  };

  const settings = makeObject(env, 'settings', {
    volume: {
      get: () => volumeNow(),
      set: (v) => {
        const n = int(v, NaN);
        if (Number.isNaN(n)) return;
        if (snap().volume < 0) { noMixer('player.settings.volume', 'writes are dropped'); return; }
        const level = clamp(n, 0, 100);
        if (level === volumeNow()) return;
        if (muted) savedVolume = level;                       // the logical volume moves; MPD stays silent
        else sendVolume(level);
        hub.emit('media.volume');
      },
    },
    mute: {
      get: () => muted,
      set: (v) => {
        const on = bool(v, muted);
        if (on === muted) return;                             // writing the current value is a no-op
        if (snap().volume < 0) { noMixer('player.settings.mute', 'mute is dropped'); return; }
        if (on) {
          savedVolume = volumeNow();
          muted = true;
          sendVolume(0);
        } else {
          muted = false;
          sendVolume(savedVolume);
        }
        hub.emit('settings.mute');
        hub.emit('media.volume');
      },
    },
    balance: {
      get: () => dsp.balance.get(),
      set: (v) => {
        const n = int(v, NaN);
        if (Number.isNaN(n)) return;
        const level = clamp(n, -100, 100);
        // The DSP port applies the detent too; doing it here keeps this object right against a port
        // that does not. The stored value snaps to the centre, so the bound slider must hear about
        // it even when the stored value did not change (parity D17).
        dsp.balance.set(Math.abs(level) <= BALANCE_DETENT ? 0 : level);
        if (dsp.balance.get() !== level) hub.emit('dsp.balance');
      },
    },
    getMode: {
      call: ([name]) => {
        const mode = modeOf(name);
        return mode === 'loop' ? snap().repeat : mode === 'shuffle' ? snap().random : false;
      },
    },
    setMode: {
      call: ([name, on]) => {
        const mode = modeOf(name);
        if (!mode) { ledger.record('player.settings.setMode', 'stub', `mode "${keyOf(text(name ?? ''))}" is not loop or shuffle`); return; }
        const current = mode === 'loop' ? snap().repeat : snap().random;
        const want = bool(on, current);
        if (want === current) return;
        command(`mode.${mode}`, 'player.settings.setMode', () => media.setMode(mode, want));
      },
    },
  });

  // ---- network, currentPlaylist, playerApplication ------------------------------------------------

  const network = makeObject(env, 'network', {
    downloadProgress: { get: () => 100 },                     // local MPD files are fully "downloaded" (parity D2)
    bufferingProgress: { get: () => 100 },
    bitRate: { get: () => { const k = snap().bitrateKbps; return k ? k * 1000 : 0; } },
  });

  /** @type {Map<number, GraphObject>} */
  const items = new Map();
  const playlist = makeObject(env, 'playlistObj', {
    count: { get: () => snap().queueLength },
    name: { get: () => 'Now Playing' },
    item: {
      call: ([i]) => {
        const index = int(i, -1);
        if (index < 0 || index >= snap().queueLength) return null;
        let obj = items.get(index);
        if (!obj) {
          if (items.size >= MAX_PLAYLIST_ITEMS) {
            ledger.record('player.currentPlaylist.item', 'cap', `more than ${MAX_PLAYLIST_ITEMS} distinct items asked for; null returned`);
            return null;
          }
          obj = mediaObject(() => media.queue()[index] ?? null, () => media.queue()[index]?.durationSec ?? 0, false);
          items.set(index, obj);
        }
        return ref(obj);
      },
    },
  });

  const player = makeObject(env, 'player', {
    playState: { get: () => playStateOf(snap()) },
    openState: { get: () => openStateOf(snap()) },
    status: { get: () => statusOf(snap()) },
    URL: { get: () => snap().song?.file ?? '' },
    controls: { get: () => ref(controls) },
    settings: { get: () => ref(settings) },
    currentMedia: { get: () => ref(currentMedia) },
    network: { get: () => ref(network) },
    currentPlaylist: { get: () => ref(playlist) },
    versionInfo: { get: () => VERSION_INFO },
  });

  const playerApplication = makeObject(env, 'playerApplication');

  env.cleanup.push(() => { items.clear(); });
  return { player, controls, settings, media: currentMedia, network, playlist, playerApplication };
}

