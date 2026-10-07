// @vitest-environment happy-dom
// The window menu (ENGINE.md D10.1, parity D8): its contents as data, the skin-first rule against the
// engine's real input dispatch (a right press the skin handled opens no menu; an unhandled one does),
// Control-click and Option-click always opening it, the once-only Control-click, the pins that persist,
// the native presenter over a fake Tauri menu API, and the engine/legacy flip.
//
// Rule 6: nothing here is keyed by a skin string. A skin's element ids reach the menu code only as
// events the engine already resolved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachMenu, buildMenu, createNativePresenter, createPins, flipMode,
} from '../../src/app/menu.js';
import { attachInput } from '../../src/engine/input/dispatch.js';
import { FAITHFUL } from '../../src/engine/options.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** @param {Partial<import('../../src/app/menu.js').MenuActions>} [over] */
const actions = (over = {}) => ({
  toggleOnTop: vi.fn(),
  toggleAllDesktops: vi.fn(),
  toggleZoom: vi.fn(),
  reloadSkin: vi.fn(),
  flipMode: vi.fn(),
  ...over,
});
const state = (over = {}) => ({ onTop: false, allDesktops: false, zoom: 1, ...over });
/** The texts of a menu, separators as '-'. @param {import('../../src/app/menu.js').MenuSpec[]} specs */
const texts = (specs) => specs.map((s) => (s.kind === 'separator' ? '-' : s.text));

describe('buildMenu', () => {
  it('is Keep on Top, Show on All Desktops, a separator, the size, a separator, Reload Skin', () => {
    expect(texts(buildMenu(state(), actions()))).toEqual([
      'Keep on Top', 'Show on All Desktops', '-', 'Larger Size', '-', 'Reload Skin',
    ]);
  });

  it('says Normal Size when the window is larger than 1', () => {
    expect(texts(buildMenu(state({ zoom: 1.5 }), actions()))).toContain('Normal Size');
    expect(texts(buildMenu(state({ zoom: 1.5 }), actions()))).not.toContain('Larger Size');
  });

  it('shows the pins as checks and wires every item to its action', () => {
    const a = actions();
    const specs = buildMenu(state({ onTop: true, allDesktops: false }), a);
    const [top, desk, , size, , reload] = /** @type {any[]} */ (specs);
    expect([top.kind, top.checked, desk.kind, desk.checked]).toEqual(['check', true, 'check', false]);
    top.action(); desk.action(); size.action(); reload.action();
    expect(a.toggleOnTop).toHaveBeenCalledOnce();
    expect(a.toggleAllDesktops).toHaveBeenCalledOnce();
    expect(a.toggleZoom).toHaveBeenCalledOnce();
    expect(a.reloadSkin).toHaveBeenCalledOnce();
  });

  it('adds the engine/legacy flip only with Option held, and only when the shell can flip', () => {
    expect(texts(buildMenu(state(), actions()))).not.toContain('Use Legacy Headspace');
    const a = actions();
    const withAlt = buildMenu(state({ altKey: true }), a);
    expect(texts(withAlt).at(-1)).toBe('Use Legacy Headspace');
    /** @type {any} */ (withAlt.at(-1)).action();
    expect(a.flipMode).toHaveBeenCalledWith('legacy');
    expect(texts(buildMenu(state({ altKey: true, mode: 'legacy' }), a)).at(-1)).toBe('Use Skin Engine');
    expect(texts(buildMenu(state({ altKey: true }), actions({ flipMode: undefined })))).not.toContain('Use Legacy Headspace');
  });

  it('puts the notice first, disabled, when there is one (a skin with no EFFECTS element, D10.3)', () => {
    const specs = buildMenu(state({ notice: 'Waiting for MPD…' }), actions());
    expect(specs[0]).toMatchObject({ kind: 'item', text: 'Waiting for MPD…', enabled: false });
    expect(specs[1]).toEqual({ kind: 'separator' });
    expect(texts(buildMenu(state({ notice: '   ' }), actions()))[0]).toBe('Keep on Top');
    expect(texts(buildMenu(state({ notice: null }), actions()))[0]).toBe('Keep on Top');
  });
});

// ---- the shell's window listeners ------------------------------------------------------------------------

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

/** A menu attached to the window with a recording presenter; `inner` stands in for the engine's plane. */
function shell(over = {}) {
  const shown = /** @type {import('../../src/app/menu.js').MenuSpec[][]} */ ([]);
  const present = vi.fn(async (/** @type {any} */ specs) => { shown.push(specs); });
  const a = actions();
  const menu = attachMenu({ target: window, state: () => state(), actions: a, present, ...over });
  cleanups.push(() => menu.dispose());
  const inner = document.createElement('div');
  document.body.append(inner);
  return { menu, present, shown, a, inner };
}
const ctx = (/** @type {EventTarget} */ t, init = {}) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  t.dispatchEvent(e);
  return e;
};
const ptr = (/** @type {EventTarget} */ t, type, init = {}) => {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, ...init });
  t.dispatchEvent(e);
  return e;
};

describe('attachMenu: skin first, host second', () => {
  it('opens on a right press nothing took, and takes the event so no system menu shows', async () => {
    const t = shell();
    const e = ctx(t.inner, { button: 2 });
    await flush();
    expect(t.present).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
    expect(texts(t.shown[0])).toContain('Keep on Top');
  });

  it('opens nothing when the skin handled the press (the plane preventDefaults its contextmenu)', async () => {
    const t = shell();
    t.inner.addEventListener('contextmenu', (e) => e.preventDefault());
    ctx(t.inner, { button: 2 });
    await flush();
    expect(t.present).not.toHaveBeenCalled();
  });

  it('reads the state each time it opens', async () => {
    let zoom = 1;
    const t = shell({ state: () => state({ zoom }) });
    ctx(t.inner);
    await flush();
    zoom = 1.5;
    ctx(t.inner);
    await flush();
    expect(texts(t.shown[0])).toContain('Larger Size');
    expect(texts(t.shown[1])).toContain('Normal Size');
  });

  it('ignores a plain left press and a plain pointer release', async () => {
    const t = shell();
    ptr(t.inner, 'pointerdown', { button: 0 });
    ptr(t.inner, 'pointerup', { button: 0 });
    await flush();
    expect(t.present).not.toHaveBeenCalled();
  });

  it('Control-click opens the menu before anything below sees the press, once, though macOS adds a contextmenu', async () => {
    const t = shell();
    const below = vi.fn();
    t.inner.addEventListener('pointerdown', below);
    const down = ptr(t.inner, 'pointerdown', { button: 0, ctrlKey: true });
    const followUp = ctx(t.inner, { ctrlKey: true });          // the event macOS sends for the same press
    ptr(t.inner, 'pointerup', { button: 0, ctrlKey: true });
    await flush();
    expect(t.present).toHaveBeenCalledOnce();
    expect(down.defaultPrevented).toBe(true);
    expect(followUp.defaultPrevented).toBe(true);
    expect(below).not.toHaveBeenCalled();
    ctx(t.inner);                                             // a later, separate right press opens it again
    await flush();
    expect(t.present).toHaveBeenCalledTimes(2);
  });

  it('Control-click opens the menu even where the skin handles right presses', async () => {
    const t = shell();
    t.inner.addEventListener('contextmenu', (e) => e.preventDefault());
    ptr(t.inner, 'pointerdown', { button: 0, ctrlKey: true });
    ctx(t.inner, { ctrlKey: true });
    await flush();
    expect(t.present).toHaveBeenCalledOnce();
  });

  it('Option-click opens the menu with the flip item', async () => {
    const t = shell();
    ptr(t.inner, 'pointerdown', { button: 0, altKey: true });
    await flush();
    expect(t.present).toHaveBeenCalledOnce();
    expect(texts(t.shown[0]).at(-1)).toBe('Use Legacy Headspace');
  });

  it('does not open a second menu while one is opening, and recovers when presenting fails', async () => {
    /** @type {() => void} */ let release = () => {};
    const gate = new Promise((r) => { release = () => r(undefined); });
    const warn = vi.fn();
    const present = vi.fn()
      .mockImplementationOnce(() => gate)
      .mockRejectedValueOnce(new Error('no menu api'))
      .mockResolvedValue(undefined);
    const t = shell({ present, log: { warn } });
    ctx(t.inner);
    ctx(t.inner);
    await flush();
    expect(present).toHaveBeenCalledOnce();
    release();
    await flush();
    ctx(t.inner);
    await flush();
    expect(present).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('window menu failed', expect.objectContaining({ error: expect.stringContaining('no menu api') }));
    ctx(t.inner);
    await flush();
    expect(present).toHaveBeenCalledTimes(3);
  });

  it('dispose removes its listeners', async () => {
    const t = shell();
    t.menu.dispose();
    ctx(t.inner);
    ptr(t.inner, 'pointerdown', { button: 0, altKey: true });
    await flush();
    expect(t.present).not.toHaveBeenCalled();
  });
});

// ---- against the engine's real input dispatch ---------------------------------------------------------------

describe('attachMenu with the real input dispatch', () => {
  /** @param {string} tag @param {Record<string, string | number>} attrs @param {any[]} [children] */
  const N = (tag, attrs, children = []) => ({
    tag, attrs: Object.entries(attrs).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 })), children, line: 1,
  });
  const vfs = { sha: '0'.repeat(64), name: 't.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null };

  /** Two buttons: one with an onmousedown handler, one with none. The plane is the engine's input plane. */
  function plane() {
    const theme = buildTheme(N('theme', {}, [N('view', { id: 'v', width: 200, height: 100 }, [
      N('button', { id: 'handled', left: 10, top: 10, width: 40, height: 20, onmousedown: 'a()' }),
      N('button', { id: 'plain', left: 100, top: 10, width: 40, height: 20 }),
    ])]), vfs, { probe: () => null });
    const view = theme.views[0];
    const el = document.createElement('div');
    document.body.append(el);
    const rects = [{ id: 'handled', x: 10, y: 10 }, { id: 'plain', x: 100, y: 10 }];
    const pickAt = (/** @type {number} */ x, /** @type {number} */ y) => {
      const r = rects.find((q) => x >= q.x && x < q.x + 40 && y >= q.y && y < q.y + 20);
      return r ? { el: /** @type {any} */ (view.byId(r.id)), part: null, role: /** @type {const} */ ('control'), local: { x: x - r.x, y: y - r.y } } : null;
    };
    const win = createTestSkinWindow();
    gestures.length = 0;
    const off = attachInput(el, view, pickAt, win, { gesture: (_el, event) => { gestures.push(`${_el.id}:${event}`); }, dragSlider() {}, key: () => false }, FAITHFUL);
    cleanups.push(off);
    return el;
  }
  /** What the skin was told, for the tests that must show it was told nothing. @type {string[]} */
  const gestures = [];
  /** A right press at (x, y): the pointerdown, then the contextmenu that follows it. */
  const rightPress = (/** @type {HTMLElement} */ el, x, y) => {
    ptr(el, 'pointerdown', { button: 2, buttons: 2, clientX: x, clientY: y });
    return ctx(el, { button: 2, clientX: x, clientY: y });
  };

  it('a right press on a control with a mouse handler goes to the skin: no menu', async () => {
    const t = shell();
    const el = plane();
    rightPress(el, 20, 15);
    await flush();
    expect(t.present).not.toHaveBeenCalled();
  });

  it('a right press on a control with no handler, or on nothing, opens the menu', async () => {
    const t = shell();
    const el = plane();
    rightPress(el, 110, 15);
    await flush();
    rightPress(el, 180, 90);
    await flush();
    expect(t.present).toHaveBeenCalledTimes(2);
  });

  it('a Control press that WebKit reports as the secondary button is still the host\'s, and the skin hears nothing', async () => {
    const t = shell();
    const el = plane();
    const down = ptr(el, 'pointerdown', { button: 2, buttons: 2, ctrlKey: true, clientX: 20, clientY: 15 });
    ctx(el, { button: 2, ctrlKey: true, clientX: 20, clientY: 15 });
    ptr(el, 'pointerup', { button: 2, ctrlKey: true });
    await flush();
    expect(t.present).toHaveBeenCalledOnce();
    expect(down.defaultPrevented).toBe(true);
    expect(gestures).toEqual([]);
  });

  it('a plain right press on the handled control is the skin\'s: it hears onmousedown', async () => {
    const t = shell();
    const el = plane();
    rightPress(el, 20, 15);
    await flush();
    expect(gestures).toEqual(['handled:onmouseover', 'handled:onmousedown']);
    expect(t.present).not.toHaveBeenCalled();
  });

  it('Control-click and Option-click on the handled control still open it (the dispatch leaves them to the shell)', async () => {
    const t = shell();
    const el = plane();
    ptr(el, 'pointerdown', { button: 0, ctrlKey: true, clientX: 20, clientY: 15 });
    ctx(el, { ctrlKey: true, clientX: 20, clientY: 15 });
    ptr(el, 'pointerup', { button: 0, ctrlKey: true });
    await flush();
    ptr(el, 'pointerdown', { button: 0, altKey: true, clientX: 20, clientY: 15 });
    await flush();
    expect(t.present).toHaveBeenCalledTimes(2);
  });
});

// ---- pins -------------------------------------------------------------------------------------------------------------

describe('createPins', () => {
  const setup = (seed = {}) => {
    const prefs = createMemoryPrefs();
    prefs.seed('app', /** @type {Record<string, string>} */ (seed));
    const win = createTestSkinWindow({ key: 'sha/main' });
    const warn = vi.fn();
    return { prefs, win, warn, pins: createPins({ win, prefs, log: { warn } }) };
  };

  it('toggles each pin, applies both to the window and saves JSON booleans under the window key', async () => {
    const { pins, win, prefs } = setup();
    pins.toggleOnTop();
    await flush();
    expect(pins.get()).toEqual({ onTop: true, allDesktops: false });
    expect(win.state.alwaysOnTop).toBe(true);
    expect(prefs.peek('app').get('onTop@sha/main')).toBe('true');
    pins.toggleAllDesktops();
    await flush();
    expect(win.state.onAllWorkspaces).toBe(true);
    expect(prefs.peek('app').get('allDesktops@sha/main')).toBe('true');
    pins.toggleOnTop();
    expect(prefs.peek('app').get('onTop@sha/main')).toBe('false');
  });

  it('restores the window-scoped value, else the legacy bare one (what the migration carries over)', async () => {
    const a = setup({ onTop: 'true', allDesktops: 'true', 'allDesktops@sha/main': 'false' });
    await a.pins.restore();
    expect(a.pins.get()).toEqual({ onTop: true, allDesktops: false });
    expect(a.win.state.alwaysOnTop).toBe(true);
    expect(a.win.state.onAllWorkspaces).toBe(false);
  });

  it('treats a stored value that is not a JSON boolean as unset', async () => {
    const a = setup({ onTop: 'yes', 'allDesktops@sha/main': '1' });
    await a.pins.restore();
    expect(a.pins.get()).toEqual({ onTop: false, allDesktops: false });
  });

  it('a window that refuses a pin is logged, not thrown', async () => {
    const { pins, win, warn } = setup();
    win.setAlwaysOnTop = () => Promise.reject(new Error('no'));
    pins.toggleOnTop();
    await flush();
    expect(warn).toHaveBeenCalledWith('window menu: always on top failed', { error: 'Error: no' });
  });

  it('a pref store that cannot be read leaves both pins off', async () => {
    const { win, warn } = setup();
    const pins = createPins({ win, prefs: { load: () => Promise.reject(new Error('io')), write() {} }, log: { warn } });
    expect(await pins.restore()).toEqual({ onTop: false, allDesktops: false });
    expect(warn).toHaveBeenCalled();
  });
});

// ---- the native presenter -----------------------------------------------------------------------------------------

describe('createNativePresenter', () => {
  function fakeApi() {
    const made = /** @type {any[]} */ ([]);
    const item = (/** @type {string} */ type) => ({ new: vi.fn(async (/** @type {any} */ o) => { const x = { type, ...o }; made.push(x); return x; }) });
    const popup = vi.fn(async () => {});
    return {
      made, popup,
      api: /** @type {any} */ ({
        Menu: { new: vi.fn(async (/** @type {any} */ o) => ({ items: o.items, popup })) },
        MenuItem: item('item'),
        CheckMenuItem: item('check'),
        PredefinedMenuItem: item('separator'),
      }),
    };
  }

  it('builds one native item per spec, in order, and pops the menu up', async () => {
    const f = fakeApi();
    const present = createNativePresenter({ load: async () => f.api });
    await present(buildMenu(state({ onTop: true }), actions()));
    expect(f.made.map((m) => m.type)).toEqual(['check', 'check', 'separator', 'item', 'separator', 'item']);
    expect(f.made[0]).toMatchObject({ text: 'Keep on Top', checked: true, enabled: true });
    expect(f.made[2]).toMatchObject({ item: 'Separator' });
    expect(f.popup).toHaveBeenCalledOnce();
  });

  it('an item action runs, and its failure is logged instead of escaping', async () => {
    const f = fakeApi();
    const warn = vi.fn();
    const present = createNativePresenter({ load: async () => f.api, log: { warn } });
    const ok = vi.fn();
    await present([
      { kind: 'item', text: 'ok', enabled: true, action: ok },
      { kind: 'item', text: 'bad', enabled: true, action: () => { throw new Error('x'); } },
      { kind: 'item', text: 'async bad', enabled: true, action: () => Promise.reject(new Error('y')) },
      { kind: 'item', text: 'disabled', enabled: false },
    ]);
    f.made[0].action();
    f.made[1].action();
    f.made[2].action();
    await flush();
    expect(ok).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(f.made[3].action).toBeUndefined();
  });
});

// ---- the flip ----------------------------------------------------------------------------------------------------

describe('flipMode', () => {
  const env = (href = 'http://localhost:1420/') => {
    const setItem = vi.fn();
    const assign = vi.fn();
    return { setItem, assign, env: { storage: { setItem }, location: { href, assign } } };
  };

  it('"legacy" stores the opt-out and reloads with ?engine=legacy, which beats a stored wmp', () => {
    const e = env('http://localhost:1420/?engine=wmp&x=1');
    flipMode('legacy', e.env);
    expect(e.setItem).toHaveBeenCalledWith('engine', 'legacy');
    expect(e.assign).toHaveBeenCalledWith('http://localhost:1420/?engine=legacy&x=1');
  });

  it('"engine" stores wmp, the token mode.js reads', () => {
    const e = env('tauri://localhost/index.html');
    flipMode('engine', e.env);
    expect(e.setItem).toHaveBeenCalledWith('engine', 'wmp');
    expect(e.assign).toHaveBeenCalledWith('tauri://localhost/index.html?engine=wmp');
  });

  it('still reloads when storage is blocked', () => {
    const assign = vi.fn();
    flipMode('legacy', {
      storage: { setItem() { throw new DOMException('blocked', 'SecurityError'); } },
      location: { href: 'http://localhost:1420/', assign },
    });
    expect(assign).toHaveBeenCalledWith('http://localhost:1420/?engine=legacy');
  });
});
