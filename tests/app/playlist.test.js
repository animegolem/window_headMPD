// @vitest-environment happy-dom
// The playlist slot widget (ENGINE.md D10.4): rows from a MediaModel, the combo box and its list, the
// outside press that closes it, the open list's rect, the honoured attributes, and playlist.css as a
// verbatim copy of the hand port's rules. Media is the test host's scripted fake (stoppedQueue5 /
// stoppedQueue12: `queuePos` 1, `song` null, the G1 ruling); the window is its TestSkinWindow over a real
// happy-dom element. happy-dom has no layout, so the open list's rect is asserted from the exported
// geometry, and the stylesheet is pinned against those numbers.
//
// Rule 6: nothing here is keyed by a skin string (attrs is folded into a Map, playlist names are MPD
// data that is only compared and shown), but the cases for the keys `__proto__` and `constructor` run
// anyway: as attribute names, as playlist names and as song titles.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeMedia, presetQueue } from '../../src/hosts/test/media.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';
import { comboMenuRect, fmtTime, GEOMETRY, mountPlaylist } from '../../src/app/widgets/playlist.js';

const RECT = { x: 503, y: 98, w: 172, h: 140 };
const flush = () => new Promise((r) => setTimeout(r, 0));
// Paths, not URLs: happy-dom replaces the global URL class, and fs wants Node's.
const here = dirname(fileURLToPath(import.meta.url));
const PLAYLIST_CSS = readFileSync(resolve(here, '../../src/app/widgets/playlist.css'), 'utf8');

afterEach(() => { document.body.innerHTML = ''; });

/**
 * A mounted widget over a fake media. `attrs` is a plain object turned into the spec's Map.
 * @param {{ preset?: string, attrs?: Record<string, any>, lists?: Record<string, any[]>, rect?: any }} [o]
 */
function setup(o = {}) {
  const host = document.createElement('div');
  const slot = document.createElement('div');
  host.appendChild(slot);
  document.body.appendChild(host);
  const win = createTestSkinWindow({ root: host });
  const media = createFakeMedia(o.preset ?? 'stoppedQueue5');
  if (o.lists) media.setStoredPlaylists(o.lists);
  const spec = { kind: /** @type {const} */ ('playlist'), attrs: new Map(Object.entries(o.attrs ?? {})), rect: o.rect ?? { ...RECT } };
  const handle = mountPlaylist(slot, media, spec, win);
  const q = (sel) => slot.querySelector(sel);
  const qa = (sel) => [...slot.querySelectorAll(sel)];
  const press = (n) => n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  const dbl = (n) => n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const rows = () => qa('.wh-pl-row');
  const menuItems = () => qa('.wh-pl-menu > div').map((n) => n.textContent);
  return { host, slot, win, media, spec, handle, q, qa, press, dbl, rows, menuItems };
}

const LISTS = () => ({
  Chill: presetQueue('stoppedQueue12').slice(5, 9),
  Work: presetQueue('stoppedQueue12').slice(0, 3),
});

describe('rows', () => {
  it('renders the queue as rows, the current one from queuePos', () => {
    const t = setup();
    expect(t.q('.wh-pl-value').textContent).toBe('Now Playing');
    expect(t.rows()).toHaveLength(5);
    const queue = presetQueue('stoppedQueue5');
    expect(t.rows().map((r) => r.querySelector('.wh-pl-name').textContent)).toEqual(queue.map((s) => s.title));
    expect(t.rows()[0].querySelector('.wh-pl-time').textContent).toBe('2:07');
    expect(t.rows()[0].title).toBe('Skinlab Fixture — Parity Queue — Opening Titles');
    // `song` is null in every preset: the playing row travels in queuePos (G1)
    expect(t.media.snapshot().song).toBeNull();
    expect(t.rows().map((r) => r.classList.contains('is-now'))).toEqual([false, true, false, false, false]);
  });

  it('shows an empty queue and an empty stored playlist in the hand port\'s words', async () => {
    const t = setup({ preset: 'stoppedEmpty', lists: { Nothing: [] } });
    expect(t.q('.wh-pl-empty').textContent).toBe('The queue is empty.');
    expect(t.rows()).toHaveLength(0);
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    expect(t.q('.wh-pl-empty').textContent).toBe('Empty playlist.');
  });

  it('formats long songs as h:mm:ss and a song with no length as blank', () => {
    const t = setup({ preset: 'stoppedQueue12' });
    expect(t.rows()[10].querySelector('.wh-pl-time').textContent).toBe('1:02:05');
    expect([127, 3725, 59.6, 0, -1, NaN, Infinity].map(fmtTime)).toEqual(['2:07', '1:02:05', '1:00', '', '', '', '']);
  });

  it('selects on press and moves the selection', () => {
    const t = setup();
    t.press(t.rows()[2]);
    expect(t.rows().map((r) => r.classList.contains('is-sel'))).toEqual([false, false, true, false, false]);
    t.press(t.rows()[4]);
    expect(t.rows().map((r) => r.classList.contains('is-sel'))).toEqual([false, false, false, false, true]);
  });

  it('plays the queue position on a double-click', () => {
    const t = setup();
    t.dbl(t.rows()[3]);
    expect(t.media.calls.map((c) => [c.method, ...c.args])).toEqual([['playQueuePos', 3]]);
  });

  it('follows the model: queue changes re-render, queuePos moves the playing row', () => {
    const t = setup();
    t.media.emit({ queuePos: 3 });
    expect(t.rows().map((r) => r.classList.contains('is-now'))).toEqual([false, false, false, true, false]);
    t.media.emit({ queuePos: null });
    expect(t.qa('.is-now')).toHaveLength(0);
    t.media.setQueue(presetQueue('stoppedQueue12').slice(0, 7));
    expect(t.rows()).toHaveLength(7);
    t.media.emit({ queuePos: 6 });
    expect(t.rows()[6].classList.contains('is-now')).toBe(true);
    expect(t.qa('.is-now')).toHaveLength(1);
  });

  it('puts every title through textContent', async () => {
    const evil = '<b>bold</b><img src=x onerror=alert(1)>';
    const t = setup({ preset: 'stoppedEmpty', lists: { [evil]: [{ ...presetQueue('stoppedQueue5')[0], title: evil, artist: evil }] } });
    t.press(t.q('.wh-pl-combo'));
    expect(t.menuItems()).toEqual(['Now Playing', evil]);
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    expect(t.q('.wh-pl-value').textContent).toBe(evil);
    expect(t.rows()[0].querySelector('.wh-pl-name').textContent).toBe(evil);
    expect(t.qa('b')).toHaveLength(0);
    expect(t.qa('img')).toHaveLength(1);                // the combo's own icon, nothing else
  });
});

describe('the combo box', () => {
  it('lists Now Playing then the stored playlists, and shows the chosen one', async () => {
    const t = setup({ lists: LISTS() });
    expect(t.q('.wh-pl-menu')).toBeNull();
    t.press(t.q('.wh-pl-combo'));
    expect(t.menuItems()).toEqual(['Now Playing', 'Chill', 'Work']);
    t.press(t.qa('.wh-pl-menu > div')[2]);
    expect(t.q('.wh-pl-menu')).toBeNull();
    expect(t.q('.wh-pl-value').textContent).toBe('Work');
    await flush();
    expect(t.rows()).toHaveLength(3);
    expect(t.qa('.is-now')).toHaveLength(0);            // the playing row is a queue-view thing
  });

  it('plays a stored playlist by position, then returns to the queue', async () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    t.dbl(t.rows()[2]);
    await flush();
    expect(t.media.calls.map((c) => [c.method, ...c.args])).toEqual([['playPlaylist', 'Chill', 2]]);
    expect(t.q('.wh-pl-value').textContent).toBe('Now Playing');
    expect(t.rows()).toHaveLength(4);                   // the queue now holds the playlist
  });

  it('drops a stored playlist reply that is no longer the one shown', async () => {
    const t = setup({ lists: LISTS() });
    const pending = new Map();
    t.media.playlistSongs = (name) => new Promise((resolve) => pending.set(name, resolve));
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[1]);               // Chill, reply held
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[2]);               // Work, reply held
    pending.get('Work')(LISTS().Work);
    await flush();
    expect(t.rows()).toHaveLength(3);
    pending.get('Chill')(LISTS().Chill);                 // the late one
    await flush();
    expect(t.rows()).toHaveLength(3);
    expect(t.q('.wh-pl-value').textContent).toBe('Work');
  });

  it('treats a failed playlist read as an empty playlist', async () => {
    const t = setup({ lists: LISTS() });
    t.media.playlistSongs = async () => { throw new Error('No such playlist'); };
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    expect(t.q('.wh-pl-empty').textContent).toBe('Empty playlist.');
  });

  it('goes back to the queue when the shown playlist is gone', async () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    t.media.setStoredPlaylists({ Work: LISTS().Work });
    t.media.emit(['playState']);
    expect(t.q('.wh-pl-value').textContent).toBe('Now Playing');
    expect(t.rows()).toHaveLength(5);
  });

  it('is a toggle: the second press on the combo closes the list', () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    expect(t.q('.wh-pl-menu')).not.toBeNull();
    t.press(t.q('.wh-pl-combo'));
    expect(t.q('.wh-pl-menu')).toBeNull();
    t.press(t.q('.wh-pl-combo'));
    expect(t.q('.wh-pl-menu')).not.toBeNull();
  });

  it('closes on a press anywhere else in the window, even one that stops propagation', () => {
    const t = setup({ lists: LISTS() });
    const plane = document.createElement('div');           // stands in for the engine's input plane
    plane.addEventListener('pointerdown', (e) => e.stopPropagation());
    t.host.appendChild(plane);
    t.press(t.q('.wh-pl-combo'));
    t.press(plane);
    expect(t.q('.wh-pl-menu')).toBeNull();
    t.press(t.q('.wh-pl-combo'));
    t.press(t.host);                                        // the window root itself
    expect(t.q('.wh-pl-menu')).toBeNull();
  });

  it("does not close on a press inside the list's own box", () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.press(t.q('.wh-pl-menu'));                            // the list's own box, not an item
    expect(t.q('.wh-pl-menu')).not.toBeNull();
  });

  it('keeps the plain-object keys out of it: playlists named __proto__ and constructor', async () => {
    const lists = new Map([['__proto__', LISTS().Work], ['constructor', LISTS().Chill]]);
    const t = setup({ lists: Object.fromEntries([]) });
    t.media.setStoredPlaylists(lists);
    t.press(t.q('.wh-pl-combo'));
    expect(t.menuItems()).toEqual(['Now Playing', '__proto__', 'constructor']);
    t.press(t.qa('.wh-pl-menu > div')[1]);
    await flush();
    expect(t.q('.wh-pl-value').textContent).toBe('__proto__');
    expect(t.rows()).toHaveLength(3);
    t.dbl(t.rows()[0]);
    await flush();
    expect(t.media.calls.map((c) => [c.method, ...c.args])).toEqual([['playPlaylist', '__proto__', 0]]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect({}.hasOwnProperty.call({}, 'title')).toBe(false);
  });
});

describe('hit rects', () => {
  it('reports the slot rect, plus the open list while it is open', () => {
    const t = setup({ lists: LISTS() });
    let fired = 0;
    t.handle.onHitRectsChange(() => { fired++; });
    expect(t.handle.hitRects()).toEqual([RECT]);
    t.press(t.q('.wh-pl-combo'));
    expect(fired).toBe(1);
    // three entries: Now Playing, Chill, Work -> 3 * 14 px of rows inside a 1 px border
    expect(t.handle.hitRects()).toEqual([RECT, { x: 505, y: 118, w: 168, h: 44 }]);
    t.press(t.host);
    expect(fired).toBe(2);
    expect(t.handle.hitRects()).toEqual([RECT]);
    t.press(t.q('.wh-pl-combo'));
    t.press(t.qa('.wh-pl-menu > div')[0]);                  // choosing closes it too
    expect(fired).toBe(4);
    expect(t.handle.hitRects()).toEqual([RECT]);
  });

  it('caps the list at its max height and tracks the slot rect', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`List ${i}`, LISTS().Work]));
    const t = setup({ lists: many });
    t.press(t.q('.wh-pl-combo'));
    expect(t.handle.hitRects()[1]).toEqual({ x: 505, y: 118, w: 168, h: 112 + 2 });
    let fired = 0;
    t.handle.onHitRectsChange(() => { fired++; });
    t.handle.update({ ...t.spec, rect: { x: 10, y: 20, w: 100, h: 90 } });
    expect(fired).toBe(1);
    expect(t.handle.hitRects()).toEqual([{ x: 10, y: 20, w: 100, h: 90 }, { x: 12, y: 40, w: 96, h: 114 }]);
    expect(t.slot.querySelector('.wh-pl').style.width).toBe('100px');
    expect(t.slot.querySelector('.wh-pl').style.height).toBe('90px');
  });

  it('reports nothing while hidden or disposed, and closes the list when hidden', () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.handle.setVisible(false);
    expect(t.q('.wh-pl-menu')).toBeNull();
    expect(t.handle.hitRects()).toEqual([]);
    expect(t.q('.wh-pl').hidden).toBe(true);
    t.handle.setVisible(true);
    expect(t.handle.hitRects()).toEqual([RECT]);
    t.handle.dispose();
    expect(t.handle.hitRects()).toEqual([]);
  });

  it('has no box to report until it is given a rect', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const media = createFakeMedia('stoppedQueue5');
    const attrs = new Map([['backgroundColor', 0x285f03]]);
    // the test host's PlaylistFactory shape: attrs only, win last
    const h = mountPlaylist(slot, media, attrs, createTestSkinWindow({ root: document.body }));
    expect(h.hitRects()).toEqual([]);
    h.update({ kind: 'playlist', attrs, rect: RECT });
    expect(h.hitRects()).toEqual([RECT]);
    // or with the rect as a fifth argument
    const h2 = mountPlaylist(document.createElement('div'), media, attrs, undefined, RECT);
    expect(h2.hitRects()).toEqual([RECT]);
  });

  it('computes the list rect from the stylesheet\'s own numbers', () => {
    const block = (sel) => new RegExp(`${sel.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(PLAYLIST_CSS)[1];
    const px = (body, prop) => Number(new RegExp(`(?:^|[\\s;])${prop}:\\s*(\\d+)px`).exec(body)[1]);
    const menu = block('.wh-pl-menu');
    expect(px(menu, 'top')).toBe(GEOMETRY.menuTop);
    expect(px(menu, 'left')).toBe(GEOMETRY.menuInset);
    expect(px(menu, 'right')).toBe(GEOMETRY.menuInset);
    expect(px(menu, 'max-height')).toBe(GEOMETRY.menuMaxHeight);
    expect(/border:\s*1px solid/.test(menu)).toBe(GEOMETRY.menuBorder === 1);
    expect(/box-sizing/.test(menu)).toBe(false);          // content-box: max-height excludes the border
    expect(px(block('.wh-pl-menu div'), 'line-height')).toBe(GEOMETRY.rowHeight);
    expect(comboMenuRect({ x: 0, y: 0, w: 172, h: 140 }, 1)).toEqual({ x: 2, y: 20, w: 168, h: 16 });
  });
});

describe('attributes', () => {
  const vars = (t) => {
    const s = t.q('.wh-pl').style;
    return Object.fromEntries(['--wh-pl-bg', '--wh-pl-fg', '--wh-pl-now', '--wh-pl-sel', '--wh-pl-sel-bg']
      .map((p) => [p, s.getPropertyValue(p)]));
  };

  it('turns the colours into custom properties, whatever the key\'s case', () => {
    const t = setup({ attrs: {
      backgroundColor: 0x285f03, FOREGROUNDCOLOR: 0xffffff, itemplayingcolor: 0x00ff00,
      itemSelectedColor: 0x000001, ItemSelectedBackgroundColor: 0x0a246a,
    } });
    expect(vars(t)).toEqual({
      '--wh-pl-bg': '#285f03', '--wh-pl-fg': '#ffffff', '--wh-pl-now': '#00ff00',
      '--wh-pl-sel': '#000001', '--wh-pl-sel-bg': '#0a246a',
    });
  });

  it('leaves a colour to the hand port when the attribute is absent or unusable', () => {
    const t = setup({ attrs: { backgroundColor: 'auto', foregroundColor: -1, itemPlayingColor: 1.5, itemSelectedColor: 0x1000000, itemSelectedBackgroundColor: 'red' } });
    expect(vars(t)).toEqual({ '--wh-pl-bg': '', '--wh-pl-fg': '', '--wh-pl-now': '', '--wh-pl-sel': '', '--wh-pl-sel-bg': '' });
    expect(vars(setup()).hasOwnProperty).toBeTypeOf('function');
    expect(Object.values(vars(setup())).every((v) => v === '')).toBe(true);
  });

  it('reads `none` on the background as no fill', () => {
    expect(vars(setup({ attrs: { backgroundColor: 'none' } }))['--wh-pl-bg']).toBe('transparent');
  });

  it('honours columnsVisible, dropDownVisible and playlistItemsVisible, and defaults like the hand port', () => {
    const flags = (t) => ['has-header', 'no-combo', 'no-items'].map((c) => t.q('.wh-pl').classList.contains(c));
    expect(flags(setup())).toEqual([false, false, false]);                       // absent: no header, combo, items
    expect(flags(setup({ attrs: { columnsVisible: false, dropDownVisible: true, playlistItemsVisible: true } }))).toEqual([false, false, false]);
    expect(flags(setup({ attrs: { columnsVisible: true, dropDownVisible: false, playlistItemsVisible: false } }))).toEqual([true, true, true]);
  });

  it('applies new attributes on update', () => {
    const t = setup({ attrs: { backgroundColor: 0x285f03 } });
    t.handle.update({ ...t.spec, attrs: new Map([['backgroundColor', 0x102030], ['dropDownVisible', false]]) });
    expect(vars(t)['--wh-pl-bg']).toBe('#102030');
    expect(t.q('.wh-pl').classList.contains('no-combo')).toBe(true);
  });

  it('closes an open list when the combo is switched off', () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.handle.update({ ...t.spec, attrs: new Map([['dropDownVisible', false]]) });
    expect(t.q('.wh-pl-menu')).toBeNull();
  });

  it('shrugs off attribute names that are Object.prototype members', () => {
    const t = setup({ attrs: { __proto__: 1, constructor: 2, toString: 3 } });
    expect(Object.values(vars(t)).every((v) => v === '')).toBe(true);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    t.handle.update({ ...t.spec, attrs: new Map([['__proto__', 5], ['constructor', 0x102030], ['valueOf', true]]) });
    expect(Object.values(vars(t)).every((v) => v === '')).toBe(true);
    expect(t.q('.wh-pl').classList.contains('no-combo')).toBe(false);
  });
});

describe('lifetime', () => {
  it('removes its DOM, its model subscription and its window listener on dispose', () => {
    const t = setup({ lists: LISTS() });
    t.press(t.q('.wh-pl-combo'));
    t.handle.dispose();
    expect(t.slot.children).toHaveLength(0);
    // nothing throws or draws once gone
    t.media.setQueue(presetQueue('stoppedQueue12'));
    t.media.emit({ queuePos: 4 });
    t.press(t.host);
    expect(t.slot.children).toHaveLength(0);
    t.handle.dispose();                                     // twice is fine
    t.handle.update(t.spec);
    t.handle.setVisible(false);
  });

  it('falls back to the document when the window has no root (headless host)', () => {
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const media = createFakeMedia('stoppedQueue5');
    media.setStoredPlaylists(LISTS());
    const h = mountPlaylist(slot, media, { kind: 'playlist', attrs: new Map(), rect: RECT }, createTestSkinWindow());
    slot.querySelector('.wh-pl-combo').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(slot.querySelector('.wh-pl-menu')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(slot.querySelector('.wh-pl-menu')).toBeNull();
    h.dispose();
  });
});

// ---- the stylesheet is the hand port's -----------------------------------------------------------------

/** @param {string} text @returns {Array<{ selectors: string[], decls: Map<string, string> }>} */
function parseRules(text) {
  const out = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    let depth = 0;
    let start = 0;
    const flush = (end) => {
      const d = m[2].slice(start, end).trim();
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
    };
    for (let k = 0; k < m[2].length; k++) {
      const c = m[2][k];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ';' && depth === 0) { flush(k); start = k + 1; }
    }
    flush(m[2].length);
    out.push({ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
  }
  return out;
}

const ORACLE_CSS = resolve(here, '../../src/style.css');
const oracleExists = existsSync(ORACLE_CSS);   // deleted with the hand port at cutover (W6.2)

describe('playlist.css', () => {
  const mine = parseRules(PLAYLIST_CSS);

  it('scopes every rule under the wrapper: no ids, no :root, body or html, no global classes', () => {
    for (const rule of mine) {
      for (const sel of rule.selectors) {
        expect(sel, sel).toMatch(/^\.wh-pl\b/);
        expect(sel, sel).not.toMatch(/[#]|:root|\bbody\b|\bhtml\b/);
      }
    }
    expect(PLAYLIST_CSS).not.toMatch(/@import|url\(\s*['"]?https?:|url\(\s*\//);
  });

  // oracle selector -> [my selector, { set: changed values }, { add: new properties }]
  const WIN = (v) => v.replaceAll('var(--win-', 'var(--wh-win-');
  /** @type {Array<[string, string, Record<string, string>?, Record<string, string>?]>} */
  const PAIRS = [
    ['#plList', '.wh-pl-list', { color: 'var(--wh-pl-fg, #fff)' }],
    ['.row', '.wh-pl-row'],
    ['.row .name', '.wh-pl-row .wh-pl-name'],
    ['.row .time', '.wh-pl-row .wh-pl-time'],
    ['.row.sel', '.wh-pl-row.is-sel', { background: 'var(--wh-pl-sel-bg, #1c4702)' }, { color: 'var(--wh-pl-sel)' }],
    ['.row.now', '.wh-pl-row.is-now', { color: 'var(--wh-pl-now, #a9ff2b)' }],
    ['.empty', '.wh-pl-empty', { color: 'var(--wh-pl-empty, #77ce07)' }],
    ['#plList::-webkit-scrollbar', '.wh-pl-list::-webkit-scrollbar'],
    ['#plList::-webkit-scrollbar-track', '.wh-pl-list::-webkit-scrollbar-track'],
    ['#plList::-webkit-scrollbar-thumb', '.wh-pl-list::-webkit-scrollbar-thumb'],
    ['#plList::-webkit-scrollbar-button:single-button', '.wh-pl-list::-webkit-scrollbar-button:single-button'],
    ['#plList::-webkit-scrollbar-button:single-button:vertical:decrement', '.wh-pl-list::-webkit-scrollbar-button:single-button:vertical:decrement'],
    ['#plList::-webkit-scrollbar-button:single-button:vertical:increment', '.wh-pl-list::-webkit-scrollbar-button:single-button:vertical:increment'],
    ['#combo', '.wh-pl-combo'],
    // the oracle's `#skin img` (absolute, block, undraggable, pixelated) then `#skin #combo .icon`
    ['#skin #combo .icon', '.wh-pl-combo .wh-pl-icon', {}, { display: 'block', '-webkit-user-drag': 'none', 'image-rendering': 'pixelated' }],
    ['#combo .value', '.wh-pl-combo .wh-pl-value'],
    ['#combo .arrow', '.wh-pl-combo .wh-pl-arrow'],
    ['#comboList', '.wh-pl-menu'],
    ['#comboList div', '.wh-pl-menu div'],
    ['#comboList div:hover', '.wh-pl-menu div:hover'],
  ];

  /** The rule whose selector list includes `sel`. */
  const find = (rules, sel) => rules.find((r) => r.selectors.includes(sel));

  describe.skipIf(!oracleExists)('against the pinned src/style.css', () => {
    const oracle = oracleExists ? parseRules(readFileSync(ORACLE_CSS, 'utf8')) : [];
    for (const [theirs, ours, set = {}, add = {}] of PAIRS) {
      it(`${theirs} is ${ours}`, () => {
        const a = find(oracle, theirs);
        const b = find(mine, ours);
        expect(a, `oracle has ${theirs}`).toBeDefined();
        expect(b, `playlist.css has ${ours}`).toBeDefined();
        const expected = new Map([...a.decls].map(([k, v]) => [k, WIN(v)]));
        for (const [k, v] of Object.entries(set)) {
          expect(expected.has(k), `${theirs} has ${k}`).toBe(true);
          expected.set(k, v);
        }
        for (const [k, v] of Object.entries(add)) expected.set(k, v);
        // `#skin #combo .icon` sets position static, and `#skin img` made it absolute: ours is static
        expect(Object.fromEntries(b.decls)).toEqual(Object.fromEntries(expected));
      });
    }

    it('copies the list geometry the hand port had: combo at (2,2) 18 px tall, list at (2,22)', () => {
      expect(find(mine, '.wh-pl-combo').decls.get('top')).toBe('2px');
      expect(find(mine, '.wh-pl-combo').decls.get('height')).toBe('18px');
      expect(find(mine, '.wh-pl-list').decls.get('top')).toBe('22px');
    });
  });

  it('has the Windows 2000 greys the oracle took from :root', () => {
    const root = find(mine, '.wh-pl').decls;
    expect([...root].filter(([k]) => k.startsWith('--wh-win-')).map(([k, v]) => `${k}:${v}`).sort()).toEqual([
      '--wh-win-dark:#404040', '--wh-win-face:#d4d0c8', '--wh-win-light:#ffffff', '--wh-win-select:#0a246a', '--wh-win-shadow:#808080',
    ]);
  });
});
