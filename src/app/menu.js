// @ts-check
// The window menu (ENGINE.md D10.1, parity D8). Right-click, Control-click or Option-click opens a
// native menu built per window:
//
//   [notice, disabled]      only for a skin with no EFFECTS element (D10.3), when MPD has something to say
//   Keep on Top             check
//   Show on All Desktops    check
//   ----
//   Larger Size / Normal Size
//   ----
//   Reload Skin
//   Use Legacy Headspace    only with Option held, until cutover (the flip back to the hand port)
//
// Skin first, host second. A right press whose picked element has a mouse handler goes to the skin as
// `event.button = 2`; the engine's input dispatch then calls `preventDefault()` on that press's
// `contextmenu`, and this module, listening on the window in the bubble phase, sees `defaultPrevented`
// and opens nothing. Control-click and Option-click are the host's before the picker looks at them (the
// dispatch ignores a left press with either held, `main.js:526-535`): they are caught in the capture
// phase and always open the menu. On macOS a Control-click is also followed by a `contextmenu` event
// for the same press, which is swallowed so the menu opens once.
//
// The menu itself is data first (`buildMenu`) and native second (`createNativePresenter`, Tauri's menu
// API, loaded on first use), so the shape and the behaviour are tested without a window.

/** @typedef {import('../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {Pick<import('../engine/contracts').PrefStore, 'load' | 'write'>} PrefsLike */
/** @typedef {'engine' | 'legacy'} Mode the front end this menu belongs to */
/**
 * @typedef {{ kind: 'separator' }
 *   | { kind: 'item', text: string, enabled: boolean, action?: () => unknown }
 *   | { kind: 'check', text: string, checked: boolean, enabled: boolean, action?: () => unknown }} MenuSpec
 * @typedef {{
 *   onTop: boolean,
 *   allDesktops: boolean,
 *   zoom: number,
 *   altKey?: boolean,
 *   notice?: string | null,
 *   mode?: Mode,
 * }} MenuState
 * @typedef {{
 *   toggleOnTop(): unknown,
 *   toggleAllDesktops(): unknown,
 *   toggleZoom(): unknown,
 *   reloadSkin(): unknown,
 *   flipMode?(to: Mode): unknown,
 * }} MenuActions
 */

const SEPARATOR = Object.freeze({ kind: /** @type {const} */ ('separator') });

/**
 * The menu for this state, as data.
 * @param {MenuState} state @param {MenuActions} actions
 * @returns {MenuSpec[]}
 */
export function buildMenu(state, actions) {
  /** @type {MenuSpec[]} */
  const items = [];
  const notice = typeof state.notice === 'string' ? state.notice.trim() : '';
  if (notice) items.push({ kind: 'item', text: notice, enabled: false }, SEPARATOR);
  items.push(
    { kind: 'check', text: 'Keep on Top', checked: !!state.onTop, enabled: true, action: () => actions.toggleOnTop() },
    { kind: 'check', text: 'Show on All Desktops', checked: !!state.allDesktops, enabled: true, action: () => actions.toggleAllDesktops() },
    SEPARATOR,
    { kind: 'item', text: state.zoom === 1 ? 'Larger Size' : 'Normal Size', enabled: true, action: () => actions.toggleZoom() },
    SEPARATOR,
    { kind: 'item', text: 'Reload Skin', enabled: true, action: () => actions.reloadSkin() },
  );
  if (state.altKey && actions.flipMode) {
    const flip = actions.flipMode;
    const to = state.mode === 'legacy' ? 'engine' : 'legacy';
    items.push({ kind: 'item', text: to === 'legacy' ? 'Use Legacy Headspace' : 'Use Skin Engine', enabled: true, action: () => flip(to) });
  }
  return items;
}

/**
 * Flips between the hand port and the engine (`src/app/mode.js`): remembers the choice in
 * `localStorage.engine` and reloads the page with `?engine=` set, because the query beats storage.
 * @param {Mode} to
 * @param {{ storage?: { setItem(k: string, v: string): void } | null, location?: { href: string, assign(url: string): void } }} [env]
 */
export function flipMode(to, env = {}) {
  const token = to === 'engine' ? 'wmp' : 'legacy';
  try {
    (env.storage === undefined ? globalThis.localStorage : env.storage)?.setItem('engine', token);
  } catch { /* blocked storage: the query alone decides this load */ }
  const location = env.location ?? globalThis.location;
  const url = new URL(location.href);
  url.searchParams.set('engine', token);
  location.assign(url.toString());
}

/**
 * Keep on Top and Show on All Desktops: the two native window pins, remembered in the `app` namespace
 * (`onTop@<window key>`, the legacy bare `onTop` as the fallback; values are JSON booleans like the
 * hand port's).
 * @param {{ win: SkinWindow, prefs: PrefsLike, log?: Pick<import('../engine/contracts').Log, 'warn'> }} deps
 */
export function createPins({ win, prefs, log }) {
  const ns = 'app';
  const scope = (/** @type {string} */ name) => `${name}@${String(win.key).slice(0, 160)}`;
  const state = { onTop: false, allDesktops: false };

  /** @param {string | undefined} raw @returns {boolean | null} */
  const parse = (raw) => {
    if (typeof raw !== 'string') return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === 'boolean' ? v : null;
    } catch {
      return null;
    }
  };
  /** @param {string} what @returns {(e: unknown) => void} */
  const warn = (what) => (e) => log?.warn(`window menu: ${what} failed`, { error: String(e) });

  function apply() {
    win.setAlwaysOnTop(state.onTop).catch(warn('always on top'));
    win.setVisibleOnAllWorkspaces(state.allDesktops).catch(warn('all desktops'));
  }
  /** @param {'onTop' | 'allDesktops'} name */
  function toggle(name) {
    state[name] = !state[name];
    try {
      prefs.write(ns, scope(name), JSON.stringify(state[name]));
    } catch (e) {
      warn('saving')(e);
    }
    apply();
  }

  return {
    get: () => ({ ...state }),
    /** Loads the saved pins and applies them to the window. Never throws. */
    async restore() {
      try {
        const saved = await prefs.load(ns);
        for (const name of /** @type {const} */ (['onTop', 'allDesktops'])) {
          state[name] = parse(saved.get(scope(name))) ?? parse(saved.get(name)) ?? false;
        }
      } catch (e) {
        warn('restoring')(e);
      }
      apply();
      return { ...state };
    },
    toggleOnTop: () => toggle('onTop'),
    toggleAllDesktops: () => toggle('allDesktops'),
  };
}

/**
 * Presents a menu with Tauri's native menu API. The API loads on first use, so a page that never opens
 * a menu (and every test) never imports it.
 * @param {{ load?: () => Promise<typeof import('@tauri-apps/api/menu')>, log?: Pick<import('../engine/contracts').Log, 'warn'> }} [opts]
 * @returns {(specs: MenuSpec[]) => Promise<void>}
 */
export function createNativePresenter(opts = {}) {
  const load = opts.load ?? (() => import('@tauri-apps/api/menu'));
  return async (specs) => {
    const { Menu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await load();
    /** @param {MenuSpec} spec */
    const handler = (spec) => {
      const action = 'action' in spec ? spec.action : undefined;
      return action
        ? () => {
          try {
            Promise.resolve(action()).catch((e) => opts.log?.warn('window menu: an action failed', { error: String(e) }));
          } catch (e) {
            opts.log?.warn('window menu: an action failed', { error: String(e) });
          }
        }
        : undefined;
    };
    const items = [];
    for (const spec of specs) {
      if (spec.kind === 'separator') items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
      else if (spec.kind === 'check') items.push(await CheckMenuItem.new({ text: spec.text, checked: spec.checked, enabled: spec.enabled, action: handler(spec) }));
      else items.push(await MenuItem.new({ text: spec.text, enabled: spec.enabled, action: handler(spec) }));
    }
    const menu = await Menu.new({ items });
    await menu.popup();
  };
}

/**
 * @param {{
 *   target?: EventTarget,
 *   state: () => Omit<MenuState, 'altKey'>,
 *   actions: MenuActions,
 *   present?: (specs: MenuSpec[]) => Promise<void>,
 *   mode?: Mode,
 *   log?: Pick<import('../engine/contracts').Log, 'warn'>,
 * }} deps `target` is the window; `state` is read each time the menu opens; `present` shows it (default:
 *   the native menu)
 * @returns {{ open(opts?: { altKey?: boolean }): Promise<void>, dispose(): void }}
 */
export function attachMenu({ target = globalThis, state, actions, present, mode = 'engine', log }) {
  const show = present ?? createNativePresenter({ log });
  let opening = false;
  let swallowContext = false;

  /** @param {{ altKey?: boolean }} [opts] */
  async function open(opts = {}) {
    if (opening) return;
    opening = true;
    try {
      await show(buildMenu({ ...state(), altKey: !!opts.altKey, mode }, actions));
    } catch (e) {
      log?.warn('window menu failed', { error: String(e) });
    } finally {
      opening = false;
    }
  }

  /**
   * Control-click and Option-click, before anything else looks at the press. WebKit reports a macOS
   * Control-click as a left press with `ctrlKey` (the case the engine's dispatch leaves alone) but some
   * builds report it as the secondary button, so Control with either button is the menu gesture; that
   * way a skin that handles right presses still never sees a Control-press.
   * @param {Event} ev
   */
  function onPointerDownCapture(ev) {
    const e = /** @type {PointerEvent} */ (ev);
    swallowContext = false;
    const gesture = (e.button === 0 && (e.ctrlKey || e.altKey)) || (e.button === 2 && e.ctrlKey);
    if (!gesture) return;
    e.preventDefault();
    e.stopPropagation();
    swallowContext = !!e.ctrlKey;
    void open({ altKey: !!e.altKey });
  }

  /** @param {Event} _e */
  function onPointerUpCapture(_e) {
    swallowContext = false;
  }

  /** @param {Event} e */
  function onContextMenu(e) {
    if (swallowContext) {
      e.preventDefault();                                      // the Control-click above already opened the menu
      return;
    }
    if (e.defaultPrevented) return;                            // the skin took this press (skin first)
    e.preventDefault();
    void open({ altKey: !!(/** @type {MouseEvent} */ (e)).altKey });
  }

  target.addEventListener('pointerdown', onPointerDownCapture, true);
  target.addEventListener('pointerup', onPointerUpCapture, true);
  target.addEventListener('contextmenu', onContextMenu);
  return {
    open,
    dispose() {
      target.removeEventListener('pointerdown', onPointerDownCapture, true);
      target.removeEventListener('pointerup', onPointerUpCapture, true);
      target.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
