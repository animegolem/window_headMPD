// MPD state for the page: the Rust side forwards `idle` notices and runs raw
// commands; this turns them into status / song / queue / playlist events.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const mpd = (...args) => invoke('mpd', { args: args.map(String) });

const obj = (pairs) => Object.fromEntries(pairs);

/** Split a flat key/value list into records, each starting at `key`. */
function records(pairs, key) {
  const out = [];
  for (const [k, v] of pairs) {
    if (k === key) out.push({});
    if (out.length) out[out.length - 1][k] = v;
  }
  return out;
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function songTitle(song) {
  if (!song) return '';
  return song.Title || song.Name || (song.file ?? '').split('/').pop().replace(/\.[^.]+$/, '');
}

class Player extends EventTarget {
  connected = false;
  status = {};
  song = null;
  queue = [];
  playlists = [];
  #statusAt = performance.now();

  async start() {
    await listen('mpd-connection', ({ payload }) => {
      this.connected = payload;
      this.#emit('connection');
      if (payload) this.refresh(['player', 'mixer', 'options', 'playlist', 'stored_playlist']);
    });
    await listen('mpd-idle', ({ payload }) => this.refresh(payload));
    // The idle thread may have connected before we were listening.
    try {
      await this.refresh(['player', 'mixer', 'options', 'playlist', 'stored_playlist']);
      this.connected = true;
      this.#emit('connection');
    } catch (e) {
      // The connection event will arrive when MPD does.
      console.warn('initial refresh', e);
      invoke('js_log', { msg: `initial refresh: ${e}` }).catch(() => {});
    }
  }

  async refresh(changed) {
    const c = new Set(changed);
    if (c.has('player') || c.has('mixer') || c.has('options') || c.has('playlist')) {
      const prevFile = this.song?.file;
      this.status = obj(await mpd('status'));
      this.#statusAt = performance.now();
      this.song = obj(await mpd('currentsong'));
      if (!this.song.file) this.song = null;
      this.#emit('status');
      if (this.song?.file !== prevFile) this.#emit('song');
    }
    if (c.has('playlist')) {
      this.queue = records(await mpd('playlistinfo'), 'file');
      this.#emit('queue');
    }
    if (c.has('stored_playlist')) {
      this.playlists = records(await mpd('listplaylists'), 'playlist').map((p) => p.playlist);
      this.playlists.sort((a, b) => a.localeCompare(b));
      this.#emit('playlists');
    }
  }

  get state() {
    return this.status.state ?? 'stop';
  }

  get duration() {
    return parseFloat(this.status.duration ?? this.song?.Time ?? 0) || 0;
  }

  /** Elapsed seconds, extrapolated between status fetches while playing. */
  get elapsed() {
    const base = parseFloat(this.status.elapsed ?? 0) || 0;
    if (this.state !== 'play') return base;
    return Math.min(this.duration || Infinity, base + (performance.now() - this.#statusAt) / 1000);
  }

  get volume() {
    return parseInt(this.status.volume ?? '-1', 10);
  }

  async playlistSongs(name) {
    return records(await mpd('listplaylistinfo', name), 'file');
  }

  play() {
    return this.state === 'pause' ? mpd('pause', 0) : mpd('play');
  }
  pause = () => mpd('pause', 1);
  toggle = () => (this.state === 'play' ? this.pause() : this.play());
  stop = () => mpd('stop');
  next = () => mpd('next');
  prev = () => mpd('previous');
  seek = (sec) => mpd('seekcur', sec.toFixed(2));
  setVolume = (v) => mpd('setvol', Math.round(v));
  playPos = (pos) => mpd('play', pos);

  /** Replace the queue with a stored playlist and start at `pos`. */
  async playPlaylist(name, pos) {
    await mpd('clear');
    await mpd('load', name);
    await mpd('play', pos);
  }

  #emit(type) {
    this.dispatchEvent(new Event(type));
  }
}

export const player = new Player();
