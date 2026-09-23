// Headspace, rebuilt: the layout from headspace.wms, wired to MPD.
// Coordinates below are the .wms's own, so they can be checked line by line
// against the original skin.

import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { el, image, button, buttonGroup, slider } from './widgets.js';
import { player, songTitle } from './player.js';
import { buildPlaylist } from './playlist.js';
import { Viz } from './viz/index.js';

const win = getCurrentWindow();

const report = (m) => invoke('js_log', { msg: String(m) }).catch(() => {});
window.addEventListener('error', (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason?.stack ?? e.reason}`));
const root = document.getElementById('skin');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/** Skin chrome that isn't a control drags the window, as in WMP. */
function draggable(...nodes) {
  for (const n of nodes) {
    n.addEventListener('pointerdown', (e) => {
      if (e.button === 0) win.startDragging();
    });
  }
}

// ---- left ear: the equalizer drawer (sEqEar) ---------------------------------

const EQ_CLOSED = 207;
const EQ_OPEN = 0;
const eqEar = el('div', root, { cls: 'ear', x: EQ_CLOSED, y: 86, w: 269, h: 170 });
const eqPanel = el('div', eqEar, { cls: 'panel hidden', x: 84, y: 10, w: 171, h: 140 });
image(eqPanel, 'drawer_bkgrnd_left', 0, 0);
image(eqPanel, 'drawer_bkgrnd_top', 10, 0);
image(eqPanel, 'drawer_bkgrnd_bottom', 10, 137);
image(eqPanel, 'drawer_bkgrnd_right', 166, 0);
draggable(
  image(eqEar, 'left_ear', 0, 0),
  image(eqEar, 'left_drawer_top', 84, 0),
  image(eqEar, 'left_drawer_bottom', 84, 150),
  image(eqEar, 'left_drawer_right', 251, 0),
);

const EQ_OPEN_IMGS = { up: 'l_drwr_open_01_default', hover: 'l_drwr_open_02_rollover', down: 'l_drwr_open_03_down' };
const EQ_CLOSE_IMGS = { up: 'l_drwr_close_01_default', hover: 'l_drwr_close_02_rollover', down: 'l_drwr_close_03_down' };
const eqHandle = button(eqEar, { x: 8, y: 66, ...EQ_OPEN_IMGS, title: 'Open graphic equalizer controls', onClick: () => toggleEq() });
const eqClose = button(eqEar, {
  x: 72, y: 7, up: 'left_x_01_default', hover: 'left_x_02_rollover', disabled: 'left_x_04_disabled',
  title: 'Close graphic equalizer controls', onClick: () => toggleEq(),
});
eqClose.visible = false;

// Balance, volume and the ten bands.
let eqGains = store.get('eq', Array(10).fill(0));
let balanceVal = store.get('balance', 0);
const sendEq = () => invoke('set_eq', { gains: eqGains }).catch(() => {});
const sendBalance = () => invoke('set_balance', { balance: balanceVal }).catch(() => {});

const balance = slider(eqPanel, {
  x: 8, y: 11, length: 71, min: -100, max: 100, title: 'Balance',
  thumb: { up: 'horizontal_thumb' },
  onInput: (v) => {
    balanceVal = Math.abs(v) < 6 ? 0 : v; // detent at centre
    sendBalance();
  },
  onChange: () => {
    balance.value = balanceVal;
    store.set('balance', balanceVal);
  },
});
balance.value = balanceVal;
el('div', eqPanel, { cls: 'label', x: 25, y: 22, text: 'Balance' });

let volTimer = 0;
const volume = slider(eqPanel, {
  x: 8 + 71 + 10, y: 11, length: 71, min: 0, max: 100, title: 'Volume',
  thumb: { up: 'horizontal_thumb' },
  onInput: (v) => {
    clearTimeout(volTimer);
    volTimer = setTimeout(() => player.setVolume(v).catch(() => {}), 40);
  },
});
el('div', eqPanel, { cls: 'label', x: 8 + 71 + 10 + 19, y: 22, text: 'Volume' });

const FREQS = ['32', '63', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
const bands = FREQS.map((f, i) => {
  const x = 11 + 15 * i;
  el('div', eqPanel, { cls: 'freq', x: x - 2, y: 121, text: f });
  const s = slider(eqPanel, {
    x, y: 44, length: 76, vertical: true, min: -14, max: 14,
    title: `Graphic equalizer control (${f}Hz)`,
    thumb: { up: 'vertical_thumb' },
    onInput: (v) => {
      eqGains[i] = v;
      sendEq();
    },
    onChange: () => store.set('eq', eqGains),
  });
  s.value = eqGains[i];
  return s;
});
const reset = el('div', eqPanel, { cls: 'link', x: 11 + 135 - 6, y: 129, text: 'reset', title: 'Reset graphic equalizer controls' });
reset.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  eqGains = Array(10).fill(0);
  bands.forEach((b) => (b.value = 0));
  sendEq();
  store.set('eq', eqGains);
});
sendEq();
sendBalance();

// ---- right ear: the playlist drawer (sPlEar) ---------------------------------

const PL_CLOSED = 277;
const PL_OPEN = 488;
const plEar = el('div', root, { cls: 'ear', x: PL_CLOSED, y: 86, w: 272, h: 170 });
const plPanel = el('div', plEar, { cls: 'panel hidden', x: 13, y: 10, w: 172, h: 140 });
image(plPanel, 'drawer_bkgrnd_left', 0, 0);
image(plPanel, 'drawer_bkgrnd_top', 10, 0);
image(plPanel, 'drawer_bkgrnd_bottom', 10, 137);
image(plPanel, 'drawer_bkgrnd_right', 167, 0);
buildPlaylist(plPanel);
draggable(
  image(plEar, 'right_drawer_left', 0, 0),
  image(plEar, 'right_drawer_top', 13, 0),
  image(plEar, 'right_drawer_bottom', 13, 150),
  image(plEar, 'right_ear', 185, 0),
);
const PL_OPEN_IMGS = { up: 'r_drwr_open_01_default', hover: 'r_drwr_open_02_rollover', down: 'r_drwr_open_03_down' };
const PL_CLOSE_IMGS = { up: 'r_drwr_close_01_default', hover: 'r_drwr_close_02_rollover', down: 'r_drwr_close_03_down' };
const plHandle = button(plEar, { x: 185 + 61, y: 65, ...PL_OPEN_IMGS, title: 'Open playlist', onClick: () => togglePl() });
const plClose = button(plEar, {
  x: 185 + 4, y: 7, up: 'right_x_01_default', hover: 'right_x_02_rollover', disabled: 'right_x_04_disabled',
  title: 'Close playlist', onClick: () => togglePl(),
});
plClose.visible = false;

// ---- the head ----------------------------------------------------------------

const head = el('div', root, { cls: 'abs', x: 261, y: 0, w: 234, h: 394 });

// Screen (zIndex -2 in the .wms: under the head art, showing through its hole).
const screen = el('div', head, { x: 9, y: 59, w: 216, h: 158 });
screen.id = 'screen';
image(screen, 'vid_bkgd', 0, 0);
const canvas = el('canvas', screen, { x: 0, y: 0, w: 216, h: 158, title: 'Click for the next visualization' });
canvas.id = 'viz';
canvas.dataset.rect = '1';
const nowPlaying = el('div', screen);
nowPlaying.id = 'nowPlaying';
const notice = el('div', screen);
notice.id = 'notice';
const caption = el('div', screen, { cls: 'hidden' });
caption.id = 'caption';

// Visualization chooser, sliding down from behind the brow (zIndex -1).
const VIS_CLOSED = 33;
const VIS_OPEN = 59;
const visDrop = el('div', head, { cls: 'abs hidden', x: 30, y: VIS_CLOSED });
visDrop.id = 'visDrop';
image(visDrop, 'viz_drop', 0, 0);
const presetTitle = el('div', visDrop);
presetTitle.id = 'presetTitle';

// The head art is on top but must not eat clicks through its screen hole, so
// it ignores the pointer; dragging by the head is handled on #skin below.
const headArt = image(head, 'head', 0, 0);
headArt.style.pointerEvents = 'none';
const headAlpha = (() => {
  const c = document.createElement('canvas');
  c.width = 234;
  c.height = 394;
  const g = c.getContext('2d', { willReadFrequently: true });
  let data = null;
  headArt.decode().then(() => {
    g.drawImage(headArt, 0, 0);
    data = g.getImageData(0, 0, 234, 394).data;
  });
  return (x, y) => {
    x = Math.floor(x - 261);
    y = Math.floor(y);
    if (!data || x < 0 || y < 0 || x >= 234 || y >= 394) return false;
    return data[(y * 234 + x) * 4 + 3] > 16;
  };
})();
// Anything under the head (ears, screen, chooser) is hidden where the head is
// opaque: a press there is a press on the head, which drags.
root.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0) return;
    const under = [eqEar, plEar, screen, visDrop].some((n) => n.contains(e.target));
    const r = root.getBoundingClientRect();
    const sx = (e.clientX - r.left) / zoom;
    const sy = (e.clientY - r.top) / zoom;
    if (under && headAlpha(sx, sy)) {
      e.stopPropagation();
      e.preventDefault();
      win.startDragging();
    }
  },
  true,
);
root.addEventListener('pointerdown', (e) => {
  // With the art itself click-transparent, a press on bare head lands on its
  // container.
  if (e.button === 0 && (e.target === root || e.target === head)) win.startDragging();
});

const viz = new Viz(canvas, (title) => {
  presetTitle.textContent = title;
  presetTitle.title = title;
}, caption);
canvas.addEventListener('click', () => viz.step(1));

button(visDrop, {
  x: 9, y: 3, up: 'viz_drop_l_01_default', hover: 'viz_drop_l_02_rollover', down: 'viz_drop_l_03_down',
  disabled: 'viz_drop_l_04_disabled', title: 'Previous visualization', onClick: () => viz.step(-1),
});
button(visDrop, {
  x: 135, y: 3, up: 'viz_drop_r_01_default', hover: 'viz_drop_r_02_rollover', down: 'viz_drop_r_03_down',
  disabled: 'viz_drop_r_04_disabled', title: 'Next visualization', onClick: () => viz.step(1),
});
button(visDrop, {
  x: 157, y: 8, up: 'viz_drop_x_01_default', hover: 'viz_drop_x_02_rollover', down: 'viz_drop_x_03_down',
  disabled: 'viz_drop_x_04_disabled', title: 'Close visualization chooser', onClick: () => toggleVis(),
});

await buttonGroup(head, {
  x: 101, y: 4, map: 'minimize_close_map', up: 'minimize_close_01_default', hover: 'minimize_close_02_rollover',
  down: 'minimize_close_03_down', disabled: 'minimize_close_04_disabled',
  elements: {
    '#FF00CC': { title: 'Minimize', onClick: () => win.minimize() },
    '#CC0066': { title: 'Close', onClick: () => win.close() },
  },
});

const transport = await buttonGroup(head, {
  x: 48, y: 31, map: 'play_controls_map', up: 'play_controls_01_default', hover: 'play_controls_02_rollover',
  down: 'play_controls_03_down', disabled: 'play_controls_04_disabled',
  elements: {
    '#FF0033': { title: 'Previous', onClick: () => player.prev() },
    '#FFFF00': { title: 'Play', onClick: () => player.play() },
    '#00FF00': { title: 'Stop', onClick: () => player.stop() },
    '#00FFFF': { title: 'Next', onClick: () => player.next() },
    '#0000FF': { title: 'Open visualization chooser', onClick: () => toggleVis() },
  },
});

const pauseBtn = button(head, {
  x: 74, y: 32, up: 'pause_01_default', hover: 'pause_02_rollover', down: 'pause_03_down',
  title: 'Pause', onClick: () => player.pause(),
});
pauseBtn.visible = false;

const eqBtn = button(head, {
  x: 15, y: 214, up: 'eq_01_df', hover: 'eq_02_rv', down: 'eq_03_dwn', disabled: 'eq_04_dis',
  title: 'Open graphic equalizer controls', onClick: () => toggleEq(),
});
const plBtn = button(head, {
  x: 204, y: 214, up: 'pl_01_df', hover: 'pl_02_rv', down: 'pl_03_dwn', disabled: 'pl_04_dis',
  title: 'Open playlist', onClick: () => togglePl(),
});

const seek = slider(head, {
  x: 39, y: 223, min: 0, max: 1000, title: 'Seek',
  background: 'progressbar', foreground: 'progressbar_foreground',
  thumb: { up: 'thumb_01_default', hover: 'thumb_02_rollover', down: 'thumb_03_down' },
  onChange: (v) => {
    if (player.duration > 0) player.seek((v / 1000) * player.duration).catch(() => {});
  },
});

// "Return to Full Mode" has no full mode to return to here, so it zooms.
button(head, {
  x: 101, y: 232, up: 'themebutton_01_default', hover: 'themebutton_02_rollover', down: 'themebutton_03_down',
  title: 'Toggle size', onClick: () => setZoom(zoom === 1 ? 1.5 : 1),
});

// ---- drawers -------------------------------------------------------------------

let eqOpen = false;
let plOpen = false;
let visOpen = false;

function toggleEq() {
  eqOpen = !eqOpen;
  if (eqOpen) {
    eqPanel.classList.remove('hidden');
    eqClose.visible = true;
  }
  eqEar.style.left = `${eqOpen ? EQ_OPEN : EQ_CLOSED}px`;
  eqHandle.images = eqOpen ? EQ_CLOSE_IMGS : EQ_OPEN_IMGS;
  const tip = eqOpen ? 'Close graphic equalizer controls' : 'Open graphic equalizer controls';
  eqHandle.title = tip;
  eqBtn.title = tip;
  store.set('eqOpen', eqOpen);
}
eqEar.addEventListener('transitionend', () => {
  eqPanel.classList.toggle('hidden', !eqOpen);
  eqClose.visible = eqOpen;
  updateMask();
});

function togglePl() {
  plOpen = !plOpen;
  if (plOpen) {
    plPanel.classList.remove('hidden');
    plClose.visible = true;
  }
  plEar.style.left = `${plOpen ? PL_OPEN : PL_CLOSED}px`;
  plHandle.images = plOpen ? PL_CLOSE_IMGS : PL_OPEN_IMGS;
  const tip = plOpen ? 'Close playlist' : 'Open playlist';
  plHandle.title = tip;
  plBtn.title = tip;
  store.set('plOpen', plOpen);
}
plEar.addEventListener('transitionend', () => {
  plPanel.classList.toggle('hidden', !plOpen);
  plClose.visible = plOpen;
  updateMask();
});

function toggleVis() {
  visOpen = !visOpen;
  if (visOpen) {
    visDrop.classList.remove('hidden');
    // Let the un-hide land before animating down.
    requestAnimationFrame(() => requestAnimationFrame(() => (visDrop.style.top = `${VIS_OPEN}px`)));
  } else {
    visDrop.style.top = `${VIS_CLOSED}px`;
  }
}
visDrop.addEventListener('transitionend', () => {
  visDrop.classList.toggle('hidden', !visOpen);
});

// ---- zoom + click-through mask ---------------------------------------------------

let zoom = store.get('zoom', 1);

function setZoom(z) {
  zoom = z;
  store.set('zoom', z);
  root.style.transform = `scale(${z})`;
  viz.renderer.setPixelRatio(window.devicePixelRatio * z);
  viz.renderer.setSize(216, 158, false);
  win.setSize(new LogicalSize(Math.round(760 * z), Math.round(394 * z))).catch(() => {});
  updateMask();
}

/**
 * Rasterise everything visible into a 1-bit "is there skin here" mask for
 * clickthrough.rs. Images contribute their alpha; panels and the GL canvas
 * are solid rectangles.
 */
function updateMask() {
  const c = document.createElement('canvas');
  c.width = 760;
  c.height = 394;
  const g = c.getContext('2d', { willReadFrequently: true });
  const walk = (node, ox, oy) => {
    for (const ch of node.children) {
      if (ch.classList.contains('hidden')) continue;
      const x = ox + ch.offsetLeft;
      const y = oy + ch.offsetTop;
      if (ch.classList.contains('panel') || ch.dataset.rect) {
        g.fillRect(x, y, ch.offsetWidth, ch.offsetHeight);
        continue;
      }
      if (ch.tagName === 'IMG' || ch.tagName === 'CANVAS') {
        try {
          g.drawImage(ch, x, y);
        } catch {}
      } else if (ch.tagName === 'DIV') {
        walk(ch, x, y);
      }
    }
  };
  walk(root, 0, 0);
  const a = g.getImageData(0, 0, 760, 394).data;
  const bits = new Uint8Array(Math.ceil((760 * 394) / 8));
  for (let i = 0; i < 760 * 394; i++) if (a[i * 4 + 3] > 16) bits[i >> 3] |= 1 << (i & 7);
  invoke('set_hit_mask', { width: 760, height: 394, bits: Array.from(bits), zoom }).catch(() => {});
}

// ---- MPD wiring ------------------------------------------------------------------

let paletteFor = null;
let nowTimer = 0;

player.addEventListener('status', () => {
  const playing = player.state === 'play';
  pauseBtn.visible = playing;
  transport.setDisabled('#00FF00', player.state === 'stop');
  const v = player.volume;
  if (v >= 0 && !volume.dragging) volume.value = v;
});

player.addEventListener('song', async () => {
  const song = player.song;
  nowPlaying.textContent = '';
  clearTimeout(nowTimer);
  nowPlaying.classList.remove('show');
  if (!song) {
    viz.setPalette(null);
    return;
  }
  // WMP flashed the track over the visualization at each change; so do we.
  el('div', nowPlaying, { text: songTitle(song) });
  if (song.Artist) el('div', nowPlaying, { cls: 'artist', text: song.Artist });
  nowPlaying.classList.add('show');
  nowTimer = setTimeout(() => nowPlaying.classList.remove('show'), 4500);

  const file = song.file;
  paletteFor = file;
  try {
    const swatches = await invoke('palette', { file });
    if (paletteFor === file) viz.setPalette(swatches);
  } catch {
    if (paletteFor === file) viz.setPalette(null);
  }
});

player.addEventListener('connection', () => refreshNotice());

async function refreshNotice() {
  let text = '';
  if (!player.connected) {
    text = 'Waiting for MPD…';
  } else {
    const info = await invoke('engine_info').catch(() => null);
    if (info?.error) text = info.error;
  }
  notice.textContent = text;
}

// Seek bar follows the playhead.
(function followPlayhead() {
  if (!seek.dragging) {
    const d = player.duration;
    seek.value = d > 0 ? (player.elapsed / d) * 1000 : 0;
  }
  requestAnimationFrame(followPlayhead);
})();

// Keyboard, WMP-ish.
window.addEventListener('keydown', (e) => {
  const step = (d) => player.seek(Math.max(0, player.elapsed + d)).catch(() => {});
  switch (e.key) {
    case ' ': player.toggle(); break;
    case 'ArrowLeft': step(-5); break;
    case 'ArrowRight': step(5); break;
    case 'ArrowUp': player.setVolume(Math.min(100, player.volume + 5)); break;
    case 'ArrowDown': player.setVolume(Math.max(0, player.volume - 5)); break;
    case 'v': viz.step(1); break;
    default: return;
  }
  e.preventDefault();
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- boot ------------------------------------------------------------------------

if (store.get('eqOpen', false)) toggleEq();
if (store.get('plOpen', false)) togglePl();
setZoom(zoom);
window.addEventListener('load', updateMask);
setTimeout(updateMask, 300);
await player.start();
refreshNotice();
setTimeout(refreshNotice, 1500);
