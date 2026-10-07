// @ts-check
// The composition of the Tauri host: everything is mocked (Tauri's invoke, listen, Channel and window,
// the pinned player and the Viz class), so this proves the wiring, not the parts; the parts have
// their own tests beside this one.
import { describe, expect, it } from 'vitest';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { createTauriHost } from '../../../src/hosts/tauri/index.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

class FakeChannel {
  /** @type {(frame: any) => void} */
  onmessage = () => {};
}
class FakeViz {}

/** The slice of the pinned Player that the media model reads, plus `start`. */
function fakePlayer(/** @type {{ start?: () => Promise<unknown> }} */ o = {}) {
  const p = Object.assign(new EventTarget(), {
    connected: false, status: {}, song: null, queue: [], playlists: [], state: 'stop', duration: 0, elapsed: 0, volume: -1,
    starts: 0,
    async playlistSongs() { return []; },
    start() { p.starts++; return o.start ? o.start() : Promise.resolve(); },
  });
  return p;
}

/** @param {{ files?: Record<string, Record<string, string>>, player?: ReturnType<typeof fakePlayer>, [k: string]: any }} [o] */
async function build(o = {}) {
  /** @type {Array<[string, any]>} */
  const calls = [];
  /** @type {string[]} */
  const events = [];
  /** @type {any[]} */
  const sizes = [];
  const invoke = async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push([cmd, args]);
    if (cmd === 'prefs_load') return o.files?.[args.ns] ?? {};
    return undefined;
  };
  const win = {
    label: 'main',
    async setSize(/** @type {any} */ s) { sizes.push(s); },
    async startDragging() {}, async show() {}, async hide() {},
    async minimize() { events.push('minimize'); },
    async close() { events.push('close'); },
    async setAlwaysOnTop() {}, async setVisibleOnAllWorkspaces() {},
    async outerPosition() { return { x: 0, y: 0 }; }, async outerSize() { return { width: 760, height: 394 }; }, async scaleFactor() { return 1; },
    async onCloseRequested() { return () => {}; },
  };
  const warnings = /** @type {string[]} */ ([]);
  const infos = /** @type {string[]} */ ([]);
  const player = o.player ?? fakePlayer();
  const decode = { async run() { return null; }, disposed: 0, dispose() { this.disposed++; } };
  const host = await createTauriHost({
    Viz: /** @type {any} */ (FakeViz),
    root: /** @type {any} */ ({}),
    invoke,
    listen: async () => () => {},
    Channel: /** @type {any} */ (FakeChannel),
    window: /** @type {any} */ (win),
    player: /** @type {any} */ (player),
    mpd: async () => undefined,
    decode,
    log: { info: (m) => { infos.push(m); }, warn: (m) => { warnings.push(m); }, diag: () => {} },
    flushPrefsOnHide: false,
    ...o,
  });
  return { host, calls, events, sizes, warnings, infos, player, decode, win };
}

describe('createTauriHost', () => {
  it('needs the Viz class, which the shell imports from the pinned viz module', async () => {
    await expect(createTauriHost(/** @type {any} */ ({}))).rejects.toBeInstanceOf(TypeError);
    await expect(createTauriHost(/** @type {any} */ ({ Viz: 'no' }))).rejects.toBeInstanceOf(TypeError);
  });

  it('assembles every member of the HostAdapter, plus the skin store', async () => {
    const { host } = await build();
    expect(host.kind).toBe('tauri');
    for (const member of ['window', 'windows', 'clock', 'prefs', 'media', 'dsp', 'audio', 'palette', 'decode', 'slots', 'actions', 'log', 'skins']) {
      expect(/** @type {any} */ (host)[member], member).toBeTruthy();
    }
    expect(host.window.binding).toBe('native');
    expect(typeof host.media.snapshot).toBe('function');
    expect(host.palette.snapshot().source).toBe('default');
    expect(typeof host.slots.mount).toBe('function');
    await host.dispose();
  });

  it('starts the player once, loads the app and mediacenter namespaces, and sends the EQ state at boot', async () => {
    const { host, calls, player } = await build();
    expect(player.starts).toBe(1);
    const loads = calls.filter(([c]) => c === 'prefs_load').map(([, a]) => a.ns).sort();
    expect(loads).toEqual(['app', 'mediacenter']);
    expect(calls.filter(([c]) => c === 'set_eq' || c === 'set_balance').map(([c]) => c)).toEqual(['set_eq', 'set_balance']);
    await host.dispose();
  });

  it('does not wait for a player that never answers, and builds anyway', async () => {
    const t0 = Date.now();
    const { host, player } = await build({ player: fakePlayer({ start: () => new Promise(() => {}) }), startWaitMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(player.starts).toBe(1);
    await host.dispose();
  });

  it('logs a player that fails to start and still builds', async () => {
    const { host, warnings } = await build({ player: fakePlayer({ start: () => Promise.reject(new Error('no mpd')) }) });
    expect(warnings).toEqual(['player: start failed: no mpd']);
    await host.dispose();
  });

  it('gives the window its key, zoom and size, and builds the native size with Tauri\'s LogicalSize', async () => {
    const { host, sizes } = await build({ key: 'abc/main', zoom: 1.5 });
    expect(host.window.key).toBe('abc/main');
    expect(host.window.zoom).toBe(1.5);
    await host.window.setInitialSize(760, 394);                      // the default view size is what a zoom change resizes to
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeInstanceOf(LogicalSize);
    expect(sizes[0]).toMatchObject({ width: 1140, height: 591 });
    await host.dispose();
  });

  it('knows the 760x394 view the config opens with: a zoom change resizes without a setInitialSize', async () => {
    const { host, sizes } = await build();
    await host.window.setZoom(1.5);
    expect(sizes[0]).toMatchObject({ width: 1140, height: 591 });
    await host.dispose();
  });

  it('declines any view but the main one', async () => {
    const { host, infos } = await build();
    expect(await host.windows.open('sEqView')).toBe(false);
    expect(host.windows.isOpen('sEqView')).toBe(false);
    await host.windows.close('sEqView');
    expect(infos).toHaveLength(1);
    await host.dispose();
  });

  it('defaults minimize and close to the window, and a custom action replaces its default', async () => {
    const { host, events, infos } = await build();
    host.actions.run('minimize', { viewId: 'v' });
    host.actions.run('close', { viewId: 'v' });
    host.actions.run('returnToMediaCenter', { viewId: 'v' });
    await settle();
    expect(events).toEqual(['minimize', 'close']);
    expect(infos.filter((m) => m.startsWith('actions:'))).toEqual(['actions: returnToMediaCenter has no handler']);
    await host.dispose();

    /** @type {string[]} */
    const heard = [];
    const custom = await build({ actions: { run: (/** @type {string} */ a) => heard.push(a), fault: (/** @type {string} */ r) => heard.push(`fault:${r}`) } });
    custom.host.actions.run('close', { viewId: 'v' });
    custom.host.actions.fault('script loop');
    expect(heard).toEqual(['close', 'fault:script loop']);
    expect(custom.events).toEqual([]);
    await custom.host.dispose();
  });

  it('logs a denied api once', async () => {
    const { host, infos } = await build();
    host.actions.denied('player.URL', 'a');
    host.actions.denied('player.URL', 'b');
    host.actions.denied('player.launchURL', 'c');
    expect(infos).toEqual(['denied: player.URL', 'denied: player.launchURL']);
    await host.dispose();
  });

  it('writes through the prefs it composed: pending prefs go out on dispose', async () => {
    const { host, calls } = await build();
    host.prefs.write('app', 'zoom', '1.5');
    expect(calls.some(([c]) => c === 'prefs_write')).toBe(false);
    await host.dispose();
    expect(calls.filter(([c]) => c === 'prefs_write').map(([, a]) => a)).toEqual([{ ns: 'app', key: 'zoom', value: '1.5' }]);
  });

  it('disposes the decode pool, and subscribes audio through the Channel it was given', async () => {
    const { host, decode, calls } = await build();
    host.audio.subscribe({}, () => {});
    await settle();
    expect(calls.filter(([c]) => c === 'audio_subscribe')).toHaveLength(1);
    await host.dispose();
    expect(decode.disposed).toBe(1);
  });

  it('flushes prefs when the page hides, and stops listening on dispose', async () => {
    /** @type {Array<[string, () => void]>} */
    const added = [];
    /** @type {string[]} */
    const removed = [];
    const g = /** @type {any} */ (globalThis);
    const had = { add: g.addEventListener, remove: g.removeEventListener };
    g.addEventListener = (/** @type {string} */ type, /** @type {() => void} */ fn) => { added.push([type, fn]); };
    g.removeEventListener = (/** @type {string} */ type) => { removed.push(type); };
    try {
      const { host, calls } = await build({ flushPrefsOnHide: true });
      expect(added.map(([t]) => t)).toEqual(['pagehide']);
      host.prefs.write('app', 'zoom', '2');
      added[0][1]();
      await settle();
      expect(calls.filter(([c]) => c === 'prefs_write')).toHaveLength(1);
      await host.dispose();
      expect(removed).toEqual(['pagehide']);
    } finally {
      g.addEventListener = had.add;
      g.removeEventListener = had.remove;
    }
  });
});
