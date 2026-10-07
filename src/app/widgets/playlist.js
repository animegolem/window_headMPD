// @ts-check
// The PLAYLIST slot widget (ENGINE.md D10.4): a new port of src/playlist.js, which stays pinned and
// untouched. A Windows 2000 combo box that picks what to show (the queue, or any stored playlist) over
// a two-column list, written against a `MediaModel` and one slot element instead of the pinned
// `player` singleton and the page.
//
// What differs from the hand port, and why:
//  - Styling is playlist.css, the hand port's own rules moved from ids to classes under `.wh-pl`.
//    Colours come from the PLAYLIST element's attributes (below) as custom properties on the wrapper;
//    a missing key keeps the hand port's colour.
//  - The press that closes the open combo list is heard on the window root, in the capture phase, not
//    on the document in the bubble phase (playlist.js:95). The engine's input plane may stop a press
//    from bubbling; capture sees it regardless. A press inside the combo or its list is not an
//    "outside" press, so the combo's own handler still toggles.
//  - The open list reports its rect (`hitRects` / `onHitRectsChange`, view px) so the window shape
//    includes it even if it hangs outside the slot's box.
//  - The playing row comes from `MediaState.queuePos`, MPD's status.song (G1): the oracle's fixture
//    has no current song, only a queue position, and still highlights that row.
//  - Stored playlists have no change event in the MediaModel, so the list of them is read when the
//    combo opens, and a shown playlist that has vanished sends the view back to the queue the next
//    time the model notifies (the hand port did that on a `playlists` event).
//  - A reply for a stored playlist that is no longer the one shown is dropped.
//
// Attributes honoured (D10.4), read case-insensitively from `SlotSpec.attrs`: backgroundColor,
// foregroundColor, itemPlayingColor, itemSelectedColor, itemSelectedBackgroundColor (colours; a
// number is 0xRRGGBB), columnsVisible (a "Name / Duration" strip; the hand port has none, so absent
// means off), dropDownVisible (the combo; absent means on), playlistItemsVisible (the list; absent
// means on). Nothing a skin supplies reaches the DOM except as textContent or a validated colour.
//
// No lookup here is keyed by a skin-controlled string: `attrs` is folded into a Map, the colour table
// is a fixed Map, and playlist names (MPD data, possibly "__proto__") are only compared and shown.

import './playlist.css';

/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../../engine/contracts').SongInfo} SongInfo */
/** @typedef {import('../../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../../engine/contracts').SlotHandle} SlotHandle */
/** @typedef {import('../../engine/contracts').SlotSpec} SlotSpec */
/** @typedef {import('../../engine/contracts').AttrValue} AttrValue */
/** @typedef {import('../../engine/contracts').Rect} Rect */

/**
 * Pixel constants of playlist.css that the open combo list's rect is computed from (happy-dom and
 * the engine's own tests have no layout, and the shape needs the number before paint). A test pins
 * them against the stylesheet.
 */
export const GEOMETRY = Object.freeze({
  menuTop: 20,          // .wh-pl-menu top
  menuInset: 2,         // .wh-pl-menu left and right
  menuBorder: 1,        // 1px solid, content-box
  menuMaxHeight: 112,   // .wh-pl-menu max-height (content box)
  rowHeight: 14,        // a menu item's line-height
});

/**
 * Where the open combo list is, in view px: the slot's rect inset by the list's own offsets.
 * @param {Rect} rect the slot's rect in view px
 * @param {number} itemCount menu entries, "Now Playing" included
 * @returns {Rect}
 */
export function comboMenuRect(rect, itemCount) {
  const g = GEOMETRY;
  const content = Math.min(g.menuMaxHeight, g.rowHeight * Math.max(0, itemCount));
  return {
    x: rect.x + g.menuInset,
    y: rect.y + g.menuTop,
    w: Math.max(0, rect.w - 2 * g.menuInset),
    h: content + 2 * g.menuBorder,
  };
}

const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="5.5" fill="#6a8"/>` +
    `<circle cx="6" cy="6" r="4" fill="#bdf"/><circle cx="6" cy="6" r="1.5" fill="#fff" stroke="#246" stroke-width=".5"/></svg>`,
)}`;

/** The attribute -> custom property table. A Map: attribute names are skin text. */
const COLOR_VARS = new Map([
  ['backgroundcolor', '--wh-pl-bg'],
  ['foregroundcolor', '--wh-pl-fg'],
  ['itemplayingcolor', '--wh-pl-now'],
  ['itemselectedcolor', '--wh-pl-sel'],
  ['itemselectedbackgroundcolor', '--wh-pl-sel-bg'],
]);

/** player.js:songTitle's order (Title, Name, file stem). `SongInfo.title` already folds Name in. @param {SongInfo | null | undefined} song */
const songTitle = (song) => (song ? song.title || String(song.file ?? '').split('/').pop().replace(/\.[^.]+$/, '') : '');

/** player.js:fmtTime. A song MPD gave no length reaches here as 0, which the oracle showed as blank. @param {number} sec */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** @param {unknown} v @returns {string | null} `#rrggbb` for an Rgb number, else null */
const hexOf = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? `#${v.toString(16).padStart(6, '0')}` : null);

/** @param {ReadonlyMap<string, AttrValue> | null | undefined} attrs @returns {Map<string, AttrValue>} names lower-cased */
function foldAttrs(attrs) {
  /** @type {Map<string, AttrValue>} */
  const out = new Map();
  if (attrs) for (const [k, v] of attrs) out.set(String(k).toLowerCase(), v);
  return out;
}

/** @param {unknown} v @returns {v is SlotSpec} */
const isSpec = (v) => v !== null && typeof v === 'object' && !(v instanceof Map) && 'attrs' in v;

/**
 * Mount the widget in a slot element.
 *
 * The third argument is the spec's attrs (the shape the test host's `PlaylistFactory` passes, ENGINE
 * §6.2) or the whole `SlotSpec`; only the spec carries the rect, so a caller that has one passes it
 * (or the rect as the fifth argument). Without a rect the widget reports no hit rect until `update`.
 * @param {HTMLElement} el the slot element; the widget adds one child and removes it on dispose
 * @param {MediaModel} media
 * @param {ReadonlyMap<string, AttrValue> | SlotSpec} attrsOrSpec
 * @param {SkinWindow | null | undefined} [win] `win.root` hears the outside press that closes the list
 * @param {Rect} [rectArg]
 * @returns {SlotHandle}
 */
export function mountPlaylist(el, media, attrsOrSpec, win, rectArg) {
  const doc = el.ownerDocument;
  /** @type {Rect | null} */
  let rect = rectArg ? { ...rectArg } : isSpec(attrsOrSpec) ? { ...attrsOrSpec.rect } : null;
  let attrs = foldAttrs(isSpec(attrsOrSpec) ? attrsOrSpec.attrs : attrsOrSpec);
  let visible = true;
  let disposed = false;

  /** What the list shows: null is the queue, a string is a stored playlist's name. @type {string | null} */
  let showing = null;
  /** @type {readonly SongInfo[]} */
  let rows = [];
  let selected = -1;
  let nowIndex = -1;
  /** Bumped by every show; a stored playlist's reply only lands if it still matches. */
  let showToken = 0;
  /** The open combo list and how many entries it has. @type {HTMLElement | null} */
  let menu = null;
  let menuCount = 0;
  /** @type {Set<() => void>} */
  const rectListeners = new Set();

  /** @param {string} cls @param {HTMLElement} parent @param {string} [text] */
  const add = (cls, parent, text) => {
    const n = doc.createElement('div');
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    parent.appendChild(n);
    return n;
  };

  const root = doc.createElement('div');
  root.className = 'wh-pl';
  const combo = add('wh-pl-combo', root);
  const icon = doc.createElement('img');
  icon.className = 'wh-pl-icon';
  icon.src = ICON;
  icon.alt = '';
  icon.draggable = false;
  combo.appendChild(icon);
  const value = add('wh-pl-value', combo);
  add('wh-pl-arrow', combo);
  const header = add('wh-pl-header', root);
  add('wh-pl-name', header, 'Name');
  add('wh-pl-time', header, 'Duration');
  const list = add('wh-pl-list', root);
  el.appendChild(root);

  // ---- attributes and rect -------------------------------------------------------------------

  /** @param {string} name @param {boolean} fallback */
  const flag = (name, fallback) => {
    const v = attrs.get(name);
    return typeof v === 'boolean' ? v : fallback;
  };

  function applyAttrs() {
    for (const [attr, prop] of COLOR_VARS) {
      const v = attrs.get(attr);
      // `none` on the background means no fill; anywhere else an unusable value keeps the hand
      // port's colour, as a skin that never set the attribute would.
      const css = attr === 'backgroundcolor' && v === 'none' ? 'transparent' : hexOf(v);
      if (css) root.style.setProperty(prop, css);
      else root.style.removeProperty(prop);
    }
    root.classList.toggle('no-combo', !flag('dropdownvisible', true));
    root.classList.toggle('has-header', flag('columnsvisible', false));
    root.classList.toggle('no-items', !flag('playlistitemsvisible', true));
    if (menu && root.classList.contains('no-combo')) closeMenu();
  }

  function applyRect() {
    if (!rect) return;
    root.style.width = `${rect.w}px`;
    root.style.height = `${rect.h}px`;
  }

  const fireRects = () => {
    for (const cb of [...rectListeners]) if (rectListeners.has(cb)) cb();
  };

  // ---- rows ----------------------------------------------------------------------------------

  /** @param {number} i */
  function select(i) {
    list.children[selected]?.classList.remove('is-sel');
    selected = i;
    list.children[selected]?.classList.add('is-sel');
  }

  /** @param {number} i */
  function activate(i) {
    const song = rows[i];
    if (!song) return;
    const done = showing === null
      ? media.playQueuePos(i)
      : media.playPlaylist(showing, i).then(() => { if (!disposed) setShowing(null); });
    Promise.resolve(done).catch((e) => console.warn('playlist: play failed', e));
  }

  /** The playing row: the queue view only, from MPD's status.song. Touches at most two rows. @param {boolean} [scroll] */
  function markNow(scroll = false) {
    const q = media.snapshot().queuePos;
    const pos = showing === null && typeof q === 'number' && q >= 0 && q < rows.length ? q : -1;
    if (pos !== nowIndex) {
      list.children[nowIndex]?.classList.remove('is-now');
      nowIndex = pos;
      list.children[nowIndex]?.classList.add('is-now');
    }
    if (scroll && nowIndex >= 0) /** @type {any} */ (list.children[nowIndex])?.scrollIntoView?.({ block: 'nearest' });
  }

  /** @param {readonly SongInfo[]} songs */
  function renderRows(songs) {
    rows = songs;
    selected = -1;
    nowIndex = -1;
    list.textContent = '';
    if (!rows.length) {
      add('wh-pl-empty', list, showing === null ? 'The queue is empty.' : 'Empty playlist.');
      return;
    }
    const frag = doc.createDocumentFragment();
    rows.forEach((song, i) => {
      const r = doc.createElement('div');
      r.className = 'wh-pl-row';
      r.title = [song.artist, song.album, songTitle(song)].filter(Boolean).join(' — ');
      const name = doc.createElement('span');
      name.className = 'wh-pl-name';
      name.textContent = songTitle(song);
      const time = doc.createElement('span');
      time.className = 'wh-pl-time';
      time.textContent = fmtTime(song.durationSec);
      r.append(name, time);
      r.addEventListener('pointerdown', () => select(i));
      r.addEventListener('dblclick', () => activate(i));
      frag.appendChild(r);
    });
    list.appendChild(frag);
    markNow(true);
  }

  function showQueue() {
    value.textContent = 'Now Playing';
    renderRows(media.queue());
  }

  /** @param {string | null} name */
  function setShowing(name) {
    showing = name;
    const token = ++showToken;
    if (name === null) return showQueue();
    value.textContent = name;
    // Rows from the previous view stay until the reply lands, as the hand port's did.
    /** @type {Promise<readonly SongInfo[]>} */
    let read;
    try {
      read = Promise.resolve(media.playlistSongs(name));
    } catch (e) {
      read = Promise.reject(e);
    }
    read
      .catch(() => /** @type {readonly SongInfo[]} */ ([]))
      .then((songs) => { if (!disposed && token === showToken) renderRows(songs); });
  }

  // ---- the combo list ------------------------------------------------------------------------

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    menuCount = 0;
    fireRects();
  }

  function openMenu() {
    const names = media.storedPlaylists();
    const m = add('wh-pl-menu', root);
    for (const name of [null, ...names]) {
      const item = doc.createElement('div');
      item.textContent = name === null ? 'Now Playing' : name;
      m.appendChild(item);
      item.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        closeMenu();
        setShowing(name);
      });
    }
    menu = m;
    menuCount = names.length + 1;
    fireRects();
  }

  combo.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (menu) closeMenu();
    else openMenu();
  });

  /** @param {Event} e */
  const onOutsidePress = (e) => {
    if (!menu) return;
    const t = /** @type {Node | null} */ (e.target);
    if (t && (menu.contains(t) || combo.contains(t))) return;
    closeMenu();
  };
  /** @type {EventTarget} */
  const pressTarget = win?.root ?? doc;
  pressTarget.addEventListener('pointerdown', onOutsidePress, true);

  // ---- the model -----------------------------------------------------------------------------

  const unsubscribe = media.subscribe((changed) => {
    if (disposed) return;
    if (showing !== null && !media.storedPlaylists().includes(showing)) {
      setShowing(null);
      return;
    }
    if (showing !== null) return;
    if (changed.has('queueVersion') || changed.has('queueLength')) showQueue();
    else markNow(changed.has('song'));
  });

  applyAttrs();
  applyRect();
  showQueue();

  /** @type {SlotHandle} */
  const handle = {
    element: el,
    update(spec) {
      if (disposed) return;
      attrs = foldAttrs(spec.attrs);
      rect = { ...spec.rect };
      applyAttrs();
      applyRect();
      fireRects();
    },
    setVisible(v) {
      if (disposed || visible === !!v) return;
      visible = !!v;
      root.hidden = !visible;
      if (!visible) closeMenu();
      fireRects();
    },
    hitRects() {
      if (disposed || !visible || !rect) return [];
      return menu ? [{ ...rect }, comboMenuRect(rect, menuCount)] : [{ ...rect }];
    },
    onHitRectsChange(cb) {
      rectListeners.add(cb);
      return () => { rectListeners.delete(cb); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      pressTarget.removeEventListener('pointerdown', onOutsidePress, true);
      rectListeners.clear();
      root.remove();
    },
  };
  return handle;
}
