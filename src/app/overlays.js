// @ts-check
// The host overlays of the EFFECTS slot (ENGINE.md D10.3): the track toast (parity D4), the notice
// ("Waiting for MPD…" or the routing error, parity D5) and the caption strip Viz drives (parity D6).
// They mount inside the slot, above its canvas, so the containing subview's clip mask clips them too
// (parity D26). Their CSS is overlays.css, the hand port's rules scoped under `.wh-fx`.
//
// This file is the port of main.js:173-177 (the three elements), 426-437 (the toast), and 448-459 +
// 586-590 (the notice). Differences, each deliberate:
//  - The toast restarts only when the song's *file* changes, as the oracle's `song` event did (player.js
//    emits it on a file change), not on every tag update of the same file. Mounting while a song is
//    already playing shows no toast, like the oracle's boot.
//  - The notice is a source of its own (`createOverlays().notice`), separate from any DOM: a skin
//    without EFFECTS has no toast, and the notice becomes the window menu's first, disabled item
//    (D10.3), which the shell reads from here. A reply for an older refresh is dropped.
//  - Timers go through an injected `{ setTimer, clearTimer }` (the engine clock's shape) so tests run on
//    the manual clock; the default is the page's own timers.
//  - Everything a song or MPD says is set with textContent.

/** @typedef {import('../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../engine/contracts').SongInfo} SongInfo */
/** @typedef {import('../engine/contracts').Unsubscribe} Unsubscribe */
/** @typedef {(cmd: string, args?: Record<string, unknown>) => Promise<unknown>} Invoke Tauri's `invoke`, or a stand-in */
/** @typedef {number | string | null | undefined} NoticeColor an Rgb number or `#rrggbb` */
/** @typedef {{ setTimer(ms: number, cb: () => void): unknown, clearTimer(id: any): void }} Timers the engine clock's timer half */
/**
 * @typedef {{
 *   text(): string,
 *   subscribe(cb: (text: string) => void): Unsubscribe,
 *   refresh(): Promise<void>,
 * }} NoticeSource what the notice says now; `subscribe` does not call back on subscription
 * @typedef {{ readonly toast: HTMLElement, readonly notice: HTMLElement, readonly caption: HTMLElement, dispose(): void }} OverlayMount
 * @typedef {{
 *   readonly notice: NoticeSource,
 *   mount(host: HTMLElement): OverlayMount,
 *   dispose(): void,
 * }} Overlays
 */

/** parity D4: the toast stays 4.5 s, then fades over 600 ms (the CSS transition). */
export const TOAST_MS = 4500;
/** main.js:590: one more look at engine_info shortly after boot. */
export const NOTICE_RETRY_MS = 1500;
/** The notice while MPD is not connected (main.js:451). */
export const WAITING_TEXT = 'Waiting for MPD…';
/** The Rust command that carries the routing error. */
export const ENGINE_INFO = 'engine_info';

/** @type {Timers} Looked up at call time, so fake timers installed later still count. */
const PAGE_TIMERS = {
  setTimer: (ms, cb) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id),
};

/** player.js:songTitle's order (Title, Name, file stem); `SongInfo.title` already folds Name in. @param {SongInfo} song */
const songTitle = (song) => song.title || String(song.file ?? '').split('/').pop().replace(/\.[^.]+$/, '');

/** `#rrggbb` for an Rgb number or a hex string, else null. @param {unknown} v @returns {string | null} */
function cssColor(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff) return `#${v.toString(16).padStart(6, '0')}`;
  if (typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
  return null;
}

/**
 * @param {{
 *   media: MediaModel,
 *   invoke?: Invoke,
 *   timers?: Timers,
 *   noticeColor?: NoticeColor | (() => NoticeColor),
 * }} deps `invoke` reads `engine_info` (absent: no routing errors); `noticeColor` is the sidecar's
 *   colour, else the skin's first TEXT foregroundColor, else the hand port's green; a function is
 *   called at each mount
 * @returns {Overlays}
 */
export function createOverlays(deps) {
  const { media, invoke } = deps;
  const timers = deps.timers ?? PAGE_TIMERS;
  let disposed = false;

  // ---- the notice: connection and engine_info ------------------------------------------------

  let noticeText = '';
  let refreshes = 0;
  /** @type {Set<(text: string) => void>} */
  const noticeListeners = new Set();

  /** @param {string} next */
  const setNotice = (next) => {
    if (next === noticeText) return;
    noticeText = next;
    for (const cb of [...noticeListeners]) if (noticeListeners.has(cb)) cb(next);
  };

  async function refresh() {
    const mine = ++refreshes;
    let text = '';
    if (!media.snapshot().connected) {
      text = WAITING_TEXT;
    } else if (invoke) {
      /** @type {unknown} */
      let info = null;
      try {
        info = await invoke(ENGINE_INFO);
      } catch {
        // the oracle's `.catch(() => null)`: no info is no error to show
      }
      const err = info !== null && typeof info === 'object' ? /** @type {{ error?: unknown }} */ (info).error : null;
      if (typeof err === 'string') text = err;
    }
    if (disposed || mine !== refreshes) return;       // a newer refresh, or gone: this answer is stale
    setNotice(text);
  }

  /** @type {NoticeSource} */
  const notice = {
    text: () => noticeText,
    subscribe(cb) {
      noticeListeners.add(cb);
      return () => { noticeListeners.delete(cb); };
    },
    refresh,
  };

  const unwatch = media.subscribe((changed) => {
    if (!disposed && changed.has('connected')) refresh();
  });
  refresh();
  const retry = timers.setTimer(NOTICE_RETRY_MS, () => { if (!disposed) refresh(); });

  // ---- the DOM: toast, notice, caption -------------------------------------------------------

  /** @type {Set<OverlayMount>} */
  const mounts = new Set();

  /** @param {HTMLElement} host */
  function mount(host) {
    const doc = host.ownerDocument;
    const toast = doc.createElement('div');
    toast.className = 'wh-toast';
    const noticeEl = doc.createElement('div');
    noticeEl.className = 'wh-notice';
    // Read now, not at creation: the skin's own colours exist only once the skin has been built.
    const colour = cssColor(typeof deps.noticeColor === 'function' ? deps.noticeColor() : deps.noticeColor);
    if (colour) noticeEl.style.setProperty('--wh-notice', colour);
    noticeEl.textContent = noticeText;
    const caption = doc.createElement('div');
    caption.className = 'wh-caption hidden';
    host.append(toast, noticeEl, caption);

    /** @type {unknown} */
    let hideTimer = null;
    let lastFile = media.snapshot().song?.file ?? null;

    /** @param {SongInfo | null} song */
    function showToast(song) {
      if (hideTimer !== null) timers.clearTimer(hideTimer);
      hideTimer = null;
      toast.textContent = '';
      toast.classList.remove('show');
      if (!song) return;
      // WMP flashed the track over the visualization at each change; so do we.
      const title = doc.createElement('div');
      title.textContent = songTitle(song);
      toast.appendChild(title);
      if (song.artist) {
        const artist = doc.createElement('div');
        artist.className = 'artist';
        artist.textContent = song.artist;
        toast.appendChild(artist);
      }
      toast.classList.add('show');
      hideTimer = timers.setTimer(TOAST_MS, () => {
        hideTimer = null;
        toast.classList.remove('show');
      });
    }

    const unsubMedia = media.subscribe((changed) => {
      if (!changed.has('song')) return;
      const song = media.snapshot().song;
      const file = song?.file ?? null;
      if (file === lastFile) return;
      lastFile = file;
      showToast(song);
    });
    const unsubNotice = notice.subscribe((text) => { noticeEl.textContent = text; });

    /** @type {OverlayMount} */
    const handle = {
      toast,
      notice: noticeEl,
      caption,
      dispose() {
        if (!mounts.delete(handle)) return;
        unsubMedia();
        unsubNotice();
        if (hideTimer !== null) timers.clearTimer(hideTimer);
        hideTimer = null;
        toast.remove();
        noticeEl.remove();
        caption.remove();
      },
    };
    mounts.add(handle);
    return handle;
  }

  return {
    notice,
    mount,
    dispose() {
      if (disposed) return;
      for (const m of [...mounts]) m.dispose();
      disposed = true;
      unwatch();
      timers.clearTimer(retry);
      noticeListeners.clear();
    },
  };
}
