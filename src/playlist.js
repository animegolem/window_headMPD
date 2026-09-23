// The right drawer: a Windows 2000 combo box to pick what to show (the
// queue, or any stored playlist) and a two-column list under it.

import { el } from './widgets.js';
import { player, fmtTime, songTitle } from './player.js';

const QUEUE = '\u0000queue';

const ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="5.5" fill="#6a8"/>` +
    `<circle cx="6" cy="6" r="4" fill="#bdf"/><circle cx="6" cy="6" r="1.5" fill="#fff" stroke="#246" stroke-width=".5"/></svg>`,
)}`;

export function buildPlaylist(panel) {
  const combo = el('div', panel);
  combo.id = 'combo';
  const icon = el('img', combo, { cls: 'icon' });
  icon.src = ICON;
  const value = el('div', combo, { cls: 'value' });
  el('div', combo, { cls: 'arrow' });
  const list = el('div', panel);
  list.id = 'plList';
  let menu = null;

  let showing = QUEUE;
  let rows = [];
  let selected = -1;

  const label = () => (showing === QUEUE ? 'Now Playing' : showing);

  async function render() {
    value.textContent = label();
    rows = showing === QUEUE ? player.queue : await player.playlistSongs(showing).catch(() => []);
    list.textContent = '';
    if (!rows.length) {
      el('div', list, { cls: 'empty', text: showing === QUEUE ? 'The queue is empty.' : 'Empty playlist.' });
      return;
    }
    const frag = document.createDocumentFragment();
    rows.forEach((song, i) => {
      const r = el('div', frag, { cls: 'row' });
      r.title = [song.Artist, song.Album, songTitle(song)].filter(Boolean).join(' — ');
      el('span', r, { cls: 'name', text: songTitle(song) });
      el('span', r, { cls: 'time', text: fmtTime(parseFloat(song.duration ?? song.Time)) });
      r.addEventListener('pointerdown', () => select(i));
      r.addEventListener('dblclick', () => activate(i));
    });
    list.appendChild(frag);
    markNow(true);
  }

  function select(i) {
    list.children[selected]?.classList.remove('sel');
    selected = i;
    list.children[selected]?.classList.add('sel');
  }

  function activate(i) {
    if (showing === QUEUE) player.playPos(i);
    else player.playPlaylist(showing, i).then(() => setShowing(QUEUE));
  }

  /** Highlight the playing song (queue view only) and keep it in sight. */
  function markNow(scroll = false) {
    const pos = showing === QUEUE ? parseInt(player.status.song ?? '-1', 10) : -1;
    [...list.children].forEach((r, i) => r.classList.toggle('now', i === pos));
    if (scroll && pos >= 0) list.children[pos]?.scrollIntoView({ block: 'nearest' });
  }

  function setShowing(name) {
    showing = name;
    selected = -1;
    render();
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  combo.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (menu) return closeMenu();
    menu = el('div', panel);
    menu.id = 'comboList';
    for (const name of [QUEUE, ...player.playlists]) {
      const item = el('div', menu, { text: name === QUEUE ? 'Now Playing' : name });
      item.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        closeMenu();
        setShowing(name);
      });
    }
  });
  document.addEventListener('pointerdown', closeMenu);

  player.addEventListener('queue', () => showing === QUEUE && render());
  player.addEventListener('status', () => markNow());
  player.addEventListener('song', () => markNow(true));
  player.addEventListener('playlists', () => {
    if (showing !== QUEUE && !player.playlists.includes(showing)) setShowing(QUEUE);
  });
  render();
}
