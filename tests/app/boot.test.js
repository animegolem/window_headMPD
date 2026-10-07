// @vitest-environment happy-dom
// The app shell composed (ENGINE.md D10, D12): `boot()` against the test host and a stub engine, in
// happy-dom, the way it runs in the app. Three blocks: the skin registry (every archive through
// `openVfs`, `canLoad`, one host), the fan-out tracker (the visualizer's leaked subscriber), and the
// launch itself (migration order, safe mode, load, attach, restore, the shell's actions, reload, close).
//
// Rule 6: the registry and the tracker keep nothing keyed by a skin string (a WeakMap on the opened
// vfs, a Set of numbers). The one string-keyed table in boot.js is the Set of denied API names, and it
// is fed `__proto__` and `constructor` below, as is a skin archive named `__proto__.wmz`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../src/hosts/test/index.js';
import { createEngineSkinHost, createSkinRegistry, SkinLoadError } from '../../src/app/skin-registry.js';
import { buildZip } from '../support/zip-writer.js';
import { minimalSkin } from '../support/wms-builder.js';

// boot.js starts the app on import unless an embedder says otherwise; this file is the embedder.
/** @type {any} */ (globalThis).__WINDOW_HEADMPD_BOOT__ = 'manual';
const { ACTIVE_SKIN_PREF, boot, createFanoutTracker } = await import('../../src/app/boot.js');
const { MESSAGES, PENDING_KEY } = await import('../../src/app/safe-mode.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const SHA = 'a'.repeat(64);
const SKIN_BYTES = minimalSkin().bytes;

// ---- the registry -------------------------------------------------------------------------------------------

describe('createSkinRegistry', () => {
  /** @param {string} family @param {number | (() => number)} score */
  const fakeHost = (family, score) => ({
    family: /** @type {any} */ (family),
    canLoad: vi.fn(() => (typeof score === 'function' ? score() : score)),
    load: vi.fn(async () => /** @type {any} */ ({ family })),
  });

  it('opens the archive through openVfs, then loads with the host that can', async () => {
    const reg = createSkinRegistry();
    const host = fakeHost('wms', 1);
    reg.register(host);
    const out = await reg.load(SKIN_BYTES, 'skin.wmz', { host: /** @type {any} */ ({ kind: 'test' }) });
    expect(host.canLoad).toHaveBeenCalledOnce();
    expect(host.canLoad.mock.calls[0][0].list('.wms')).toEqual(['skin.wms']);
    expect(host.load.mock.calls[0][0].sha).toMatch(/^[0-9a-f]{64}$/);
    expect(out.family).toBe('wms');
    expect(out.vfs.sha).toBe(host.load.mock.calls[0][0].sha);
  });

  it('every family passes the same zip caps: a zip over the caps never reaches a host', async () => {
    const reg = createSkinRegistry();
    const host = fakeHost('wms', 1);
    reg.register(host);
    const tooMany = buildZip(Array.from({ length: 4100 }, (_, i) => ({ name: `f${i}.txt`, data: 'x', method: /** @type {const} */ ('store') })));
    await expect(reg.open(tooMany, 'huge.wmz')).rejects.toMatchObject({ name: 'SkinLoadError', code: 'bad-archive' });
    await expect(reg.open(new Uint8Array([1, 2, 3]), 'junk.wmz')).rejects.toMatchObject({ code: 'bad-archive' });
    expect(host.canLoad).not.toHaveBeenCalled();
  });

  it('picks the highest canLoad, the earlier registration winning a tie', async () => {
    const reg = createSkinRegistry();
    const a = fakeHost('wms', 0.4);
    const b = fakeHost('wsz', 0.9);
    const c = fakeHost('native', 0.9);
    [a, b, c].forEach((h) => reg.register(h));
    const out = await reg.load(SKIN_BYTES, 's.wmz', { host: /** @type {any} */ ({}) });
    expect(out.family).toBe('wsz');
    expect(a.load).not.toHaveBeenCalled();
    expect(c.load).not.toHaveBeenCalled();
  });

  it('a host whose canLoad throws or answers nonsense scores zero; no host able is "no-host"', async () => {
    const warn = vi.fn();
    const reg = createSkinRegistry({ log: { warn } });
    reg.register(fakeHost('wms', () => { throw new Error('boom'); }));
    reg.register(fakeHost('wsz', NaN));
    reg.register(fakeHost('native', 0));
    await expect(reg.open(SKIN_BYTES, 'x.wmz')).rejects.toMatchObject({ code: 'no-host' });
    expect(warn).toHaveBeenCalledOnce();
    expect(createSkinRegistry().hosts()).toEqual([]);
  });

  it('a host that fails to load is "load-failed" with the cause attached', async () => {
    const reg = createSkinRegistry();
    const host = fakeHost('wms', 1);
    const cause = new Error('realm exploded');
    host.load.mockRejectedValue(cause);
    reg.register(host);
    const err = await reg.load(SKIN_BYTES, 'x.wmz', { host: /** @type {any} */ ({}) }).catch((e) => e);
    expect(err).toBeInstanceOf(SkinLoadError);
    expect(err).toMatchObject({ code: 'load-failed', cause });
    expect(err.message).toContain('realm exploded');
  });

  it('hands the sidecar for the archive\'s own hash to the host', async () => {
    const reg = createSkinRegistry();
    const host = fakeHost('wms', 1);
    reg.register(host);
    const sidecar = /** @type {any} */ ({ schema: 'window_headmpd-sidecar/1' });
    const sidecarFor = vi.fn(async () => sidecar);
    const out = await reg.load(SKIN_BYTES, 'x.wmz', { host: /** @type {any} */ ({}), sidecarFor });
    expect(sidecarFor).toHaveBeenCalledWith(out.vfs.sha);
    expect(host.load.mock.calls[0][1].sidecar).toBe(sidecar);
    expect(out.sidecar).toBe(sidecar);
    host.load.mockClear();
    await reg.load(SKIN_BYTES, 'x.wmz', { host: /** @type {any} */ ({}), sidecarFor: async () => null });
    expect('sidecar' in host.load.mock.calls[0][1]).toBe(false);
  });

  it('register() returns its own unregister', async () => {
    const reg = createSkinRegistry();
    const off = reg.register(fakeHost('wms', 1));
    expect(reg.hosts()).toHaveLength(1);
    off();
    off();
    expect(reg.hosts()).toHaveLength(0);
  });

  it('an archive named __proto__.wmz is a plain archive', async () => {
    const reg = createSkinRegistry();
    reg.register(fakeHost('wms', 1));
    expect((await reg.open(SKIN_BYTES, '__proto__.wmz')).vfs.name).toBe('__proto__.wmz');
  });
});

describe('createEngineSkinHost', () => {
  it('takes any archive with a .wms and passes the bytes, name and sidecar to Engine.load', async () => {
    const loaded = { sha: 'x' };
    const engine = { load: vi.fn(async () => /** @type {any} */ (loaded)) };
    const reg = createSkinRegistry();
    reg.register(createEngineSkinHost(engine));
    const sidecar = /** @type {any} */ ({ schema: 'window_headmpd-sidecar/1' });
    const out = await reg.load(SKIN_BYTES, 'Headspace.wmz', { host: /** @type {any} */ ({}), sidecarFor: async () => sidecar });
    expect(out.skin).toBe(loaded);
    expect(engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: 'Headspace.wmz', sidecar });
  });

  it('refuses an archive with no .wms (canLoad is 0, so the registry says no-host)', async () => {
    const reg = createSkinRegistry();
    reg.register(createEngineSkinHost({ load: vi.fn() }));
    const noWms = buildZip([{ name: 'readme.txt', data: 'hi' }]);
    await expect(reg.open(noWms, 'x.wmz')).rejects.toMatchObject({ code: 'no-host' });
  });

  it('will not load an archive some other reader opened (it has no bytes for it)', async () => {
    const host = createEngineSkinHost({ load: vi.fn() });
    await expect(host.load(/** @type {any} */ ({ name: 'x', list: () => [] }), { host: /** @type {any} */ ({}) })).rejects.toThrow(/registry opened/);
  });
});

// ---- the fan-out tracker ------------------------------------------------------------------------------------

describe('createFanoutTracker', () => {
  /** A stand-in for Tauri's internals and for a Viz that subscribes the way viz/index.js does. */
  function rig(ids = [11, 12, 13]) {
    let next = 0;
    const internals = { invoke: vi.fn(async (/** @type {string} */ cmd) => (cmd === 'audio_subscribe' ? ids[next++] : undefined)) };
    const original = internals.invoke;
    const unsubscribe = vi.fn(async () => {});
    const tracker = createFanoutTracker({ unsubscribe, internals: () => internals });
    class Viz {
      /** @param {HTMLCanvasElement} canvas */
      constructor(canvas) {
        this.canvas = canvas;
        // viz/index.js: `invoke('audio_subscribe', { onFrame })`, whose result nobody keeps
        void internals.invoke('audio_subscribe', { onFrame: {} });
      }
    }
    return { internals, original, unsubscribe, tracker, Viz: /** @type {any} */ (Viz) };
  }

  it('remembers the id each Viz\'s audio_subscribe returned, and unsubscribes them all on release', async () => {
    const r = rig();
    const Tracked = r.tracker.track(r.Viz);
    const a = new Tracked(/** @type {any} */ ('canvas-a'));
    new Tracked(/** @type {any} */ ('canvas-b'));
    await flush();
    expect(a.canvas).toBe('canvas-a');                          // the subclass is a Viz
    expect(r.tracker.size()).toBe(2);
    r.tracker.releaseAll();
    expect(r.unsubscribe.mock.calls.map((c) => c[0])).toEqual([11, 12]);
    expect(r.tracker.size()).toBe(0);
    r.tracker.releaseAll();
    expect(r.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('puts Tauri\'s invoke back as it found it, even when the constructor throws', () => {
    const r = rig();
    const Tracked = r.tracker.track(/** @type {any} */ (class { constructor() { throw new Error('no webgl'); } }));
    expect(() => new Tracked()).toThrow('no webgl');
    expect(r.internals.invoke).toBe(r.original);
    new (r.tracker.track(r.Viz))('c');
    expect(r.internals.invoke).toBe(r.original);
  });

  it('only watches audio_subscribe, and passes everything else through untouched', async () => {
    const r = rig();
    const Tracked = r.tracker.track(/** @type {any} */ (class {
      constructor() { void r.internals.invoke('palette', { file: 'x' }); }
    }));
    new Tracked();
    await flush();
    expect(r.tracker.size()).toBe(0);
    expect(r.original).toHaveBeenCalledWith('palette', { file: 'x' });
  });

  it('an id that arrives after its view was released is unsubscribed at once', async () => {
    let resolveId = (/** @type {number} */ _id) => {};
    const internals = { invoke: vi.fn(() => new Promise((r) => { resolveId = r; })) };
    const unsubscribe = vi.fn(async () => {});
    const tracker = createFanoutTracker({ unsubscribe, internals: () => internals });
    const Tracked = tracker.track(/** @type {any} */ (class { constructor() { void internals.invoke('audio_subscribe'); } }));
    new Tracked();
    tracker.releaseAll();                                       // the view is torn down before the IPC answers
    resolveId(99);
    await flush();
    expect(unsubscribe).toHaveBeenCalledWith(99);
    expect(tracker.size()).toBe(0);
  });

  it('outside Tauri (no internals) it tracks nothing and still builds the Viz', () => {
    const tracker = createFanoutTracker({ unsubscribe: vi.fn(), internals: () => undefined });
    const Tracked = tracker.track(/** @type {any} */ (class { constructor(/** @type {string} */ c) { this.c = c; } }));
    expect(new Tracked('canvas').c).toBe('canvas');
    expect(() => tracker.releaseAll()).not.toThrow();
  });

  it('an unsubscribe that fails is swallowed (the subscriber ends with the window anyway)', async () => {
    const r = rig();
    r.unsubscribe.mockRejectedValue(new Error('gone'));
    new (r.tracker.track(r.Viz))('c');
    await flush();
    expect(() => r.tracker.releaseAll()).not.toThrow();
    await flush();
  });
});

// ---- the launch -----------------------------------------------------------------------------------------------

/** @type {Array<{ dispose(): void }>} */
const handles = [];
beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => {
  while (handles.length) handles.pop()?.dispose();
  document.body.replaceChildren();
});

/** A stub of the engine side: what `createEngine(host)` gives the shell. */
function stubEngine(over = {}) {
  /** @type {{ host: any, order: string[], globals: Map<string, unknown>, called: string[], handles: any[] }} */
  const seen = { host: null, order: [], globals: new Map([['eqIsOpen', false], ['plIsOpen', false]]), called: [], handles: [] };
  const view = {
    inspector: {
      readGlobal: vi.fn((/** @type {string} */ name) => seen.globals.get(name)),
      callGlobal: vi.fn((/** @type {string} */ name) => {
        seen.called.push(name);
        if (name === 'ToggleEqView') seen.globals.set('eqIsOpen', !seen.globals.get('eqIsOpen'));
        if (name === 'TogglePlView') seen.globals.set('plIsOpen', !seen.globals.get('plIsOpen'));
        return undefined;
      }),
    },
    maskShape: vi.fn(() => null),
    settled: async () => {},
    health: { soft: 0, hard: 0, unloaded: false },
    /** Like the engine's: the slots it mounted (the shell's wrappers) go with the view. */
    dispose: vi.fn(() => { for (const h of seen.handles.splice(0)) h.dispose(); }),
  };
  const skin = {
    sha: SHA,
    family: 'wms',
    capabilities: { eq: null, wantsPcm: false, windowModel: 'native-per-view', scripted: true },
    views: () => [{ id: 'sMain', width: 760, height: 394, main: true }],
    attach: vi.fn(async () => {
      seen.order.push('attach');
      seen.handles.push(seen.host.slots.mount(document.createElement('div'), { kind: 'effects', attrs: new Map(), rect: { x: 0, y: 0, w: 216, h: 158 } }, seen.host.window));
      return view;
    }),
    diagnostics: () => [],
    ledger: () => [],
    dispose: vi.fn(),
    ...over,
  };
  const engine = { load: vi.fn(async () => { seen.order.push('load'); return skin; }) };
  return { engine, skin, view, seen, createEngine: vi.fn((/** @type {any} */ host) => { seen.host = host; return engine; }) };
}

/** @param {Record<string, string>} [data] */
const legacyStorage = (data = {}) => ({ getItem: (/** @type {string} */ k) => (Object.hasOwn(data, k) ? data[k] : null) });

/**
 * One launch. `host` is the test host; `stub` the engine side; `deps` overrides anything of boot's.
 * @param {{ seed?: Record<string, Record<string, string>>, storage?: any, sidecar?: any, stub?: ReturnType<typeof stubEngine>,
 *   skins?: any, shift?: () => boolean, deps?: any, hostOver?: (host: any) => void, media?: string }} [o]
 */
async function launch(o = {}) {
  const root = document.createElement('div');
  root.id = 'skin';
  document.body.append(root);
  const host = createTestHost({ seed: o.seed, media: o.media, window: { root, key: 'native/main' } });
  o.hostOver?.(host);
  const stub = o.stub ?? stubEngine();
  /** @type {import('../../src/app/menu.js').MenuSpec[][]} */
  const menus = [];
  const order = /** @type {string[]} */ ([]);
  const createHost = vi.fn(async () => {
    order.push('createHost');
    order.push(`migrated:${host.prefs.peek('app').has('migrated.legacy-prefs')}`);
    return host;
  });
  const deps = {
    createHost,
    prefs: host.prefs,
    createEngine: stub.createEngine,
    skins: o.skins ?? { importDefault: vi.fn(async () => ({ sha: SHA, name: 'Headspace.wmz' })), read: vi.fn(async () => SKIN_BYTES) },
    sidecarFor: async () => o.sidecar ?? null,
    storage: o.storage ?? legacyStorage(),
    shift: o.shift ?? (() => false),
    menuPresenter: async (/** @type {any} */ specs) => { menus.push(specs); },
    flip: vi.fn(),
    onTeardown: vi.fn(),
    ...o.deps,
  };
  const shell = await boot(deps);
  handles.push(shell);
  return { shell, host, stub, deps, menus, order, root, createHost };
}
const marker = (/** @type {any} */ host) => host.prefs.peek('app').get(PENDING_KEY);
const panelText = (/** @type {HTMLElement} */ root) => root.querySelector('.wh-fault-message')?.textContent ?? null;

describe('a normal launch', () => {
  it('boots against the test host and a stub engine: registry, load, attach, marker, remembered skin', async () => {
    const t = await launch();
    expect(t.stub.engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: 'Headspace.wmz' });
    expect(t.stub.skin.attach).toHaveBeenCalledWith('sMain');
    expect(t.shell.skin()).toBe(t.stub.skin);
    expect(t.shell.view()).toBe(t.stub.view);
    expect(t.shell.panel.visible()).toBe(false);
    expect(marker(t.host)).toBe('1');                           // armed before the load, cleared 10 s after the first frame
    expect(t.host.prefs.peek('app').get(ACTIVE_SKIN_PREF)).toBe(SHA);
    expect(t.stub.seen.order).toEqual(['load', 'attach']);
  });

  it('the engine sees the host with the shell\'s actions, and the base host is left as built', async () => {
    const t = await launch();
    expect(t.stub.seen.host.actions).not.toBe(t.host.actions);
    expect(t.stub.seen.host.window).toBe(t.host.window);
    expect(t.stub.seen.host.media).toBe(t.host.media);
    expect(t.deps.createHost).toHaveBeenCalledWith({ actions: t.stub.seen.host.actions });
  });

  it('clears the marker 10 s after the first frame', async () => {
    const t = await launch();
    t.host.clock.advance(10_000);
    expect(marker(t.host)).toBe('1');
    t.host.clock.advance(32);
    expect(marker(t.host)).toBeUndefined();
  });

  it('hands the sidecar to the engine', async () => {
    const sidecar = { schema: 'window_headmpd-sidecar/1', skin: SHA, restore: [] };
    const t = await launch({ sidecar });
    expect(t.stub.engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: 'Headspace.wmz', sidecar });
    expect(t.shell.sidecar()).toBe(sidecar);
  });

  it('keys the window by archive sha and view id, then restores the zoom saved under that key before attach', async () => {
    const { openVfs } = await import('../../src/engine/archive/vfs.js');
    const { sha } = await openVfs(SKIN_BYTES, 'skin.wmz');
    const s = stubEngine();
    s.skin.attach.mockImplementation(async () => {
      s.seen.order.push(`attach@zoom=${s.seen.host.window.recorded.zoomRequests.join(',')}`);
      return s.view;
    });
    const t = await launch({
      seed: { app: { [`zoom@${sha}/sMain`]: '1.5', zoom: '1' } },
      stub: s,
      hostOver: (h) => { h.window.setKey = (/** @type {string} */ k) => { h.window.key = k; }; },
    });
    expect(t.host.window.key).toBe(`${sha}/sMain`);
    expect(s.seen.order.at(-1)).toBe('attach@zoom=1.5');
  });

  it('applies the zoom saved for the window (the migrated bare key) before the skin attaches', async () => {
    const s = stubEngine();
    s.skin.attach.mockImplementation(async () => {
      s.seen.order.push(`attach@zoom=${s.seen.host.window.recorded.zoomRequests.join(',')}`);
      return s.view;
    });
    await launch({ seed: { app: { zoom: '1.5' } }, stub: s });
    expect(s.seen.order.at(-1)).toBe('attach@zoom=1.5');
  });

  it('applies the saved Keep on Top and Show on All Desktops', async () => {
    const t = await launch({ seed: { app: { onTop: 'true', allDesktops: 'true' } } });
    expect(t.host.window.state).toMatchObject({ alwaysOnTop: true, onAllWorkspaces: true });
  });

  it('a skin named __proto__.wmz loads like any other', async () => {
    const t = await launch({ skins: { importDefault: async () => ({ sha: SHA, name: '__proto__.wmz' }), read: async () => SKIN_BYTES } });
    expect(t.stub.engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: '__proto__.wmz' });
  });

  it('with no recorded default it takes the skin of the app pref, else the first listed', async () => {
    const other = { sha: 'c'.repeat(64), name: 'other.wmz' };
    const list = vi.fn(async () => [other, { sha: SHA, name: 'Headspace.wmz' }]);
    const read = vi.fn(async () => SKIN_BYTES);
    const a = await launch({ seed: { app: { [ACTIVE_SKIN_PREF]: SHA } }, skins: { importDefault: async () => null, list, read } });
    expect(read).toHaveBeenCalledWith(SHA);
    handles.pop()?.dispose();
    const b = await launch({ skins: { importDefault: async () => null, list, read } });
    expect(read).toHaveBeenLastCalledWith(other.sha);
    expect(a.stub.engine.load).toHaveBeenCalledOnce();
    expect(b.stub.engine.load).toHaveBeenCalledOnce();
  });

  it('accepts the store handing back an ArrayBuffer (what skin_read resolves with)', async () => {
    const buf = SKIN_BYTES.buffer.slice(SKIN_BYTES.byteOffset, SKIN_BYTES.byteOffset + SKIN_BYTES.byteLength);
    const t = await launch({ skins: { importDefault: async () => ({ sha: SHA, name: 'a.wmz' }), read: async () => buf } });
    expect(t.stub.engine.load).toHaveBeenCalledOnce();
    expect(t.shell.panel.visible()).toBe(false);
  });
});

describe('the legacy prefs migration comes first', () => {
  it('runs before the host is built, so the host\'s stores load migrated values', async () => {
    const t = await launch({ storage: legacyStorage({ zoom: '1.5', eq: '[1,0,0,0,0,0,0,0,0,0]', preset: '2' }) });
    expect(t.order).toEqual(['createHost', 'migrated:true']);
    expect(t.shell.migration).toMatchObject({ ran: true, copied: ['zoom', 'eq', 'preset'] });
    expect(t.host.prefs.peek('mediacenter').get('effectPreset')).toBe('2');
  });

  it('flushes the store it migrated through before building the host', async () => {
    const calls = /** @type {string[]} */ ([]);
    const host = createTestHost();
    const prefs = {
      load: (/** @type {string} */ ns) => host.prefs.load(ns),
      write: (/** @type {string} */ ns, /** @type {string} */ k, /** @type {string | null} */ v) => { calls.push(`write:${k}`); host.prefs.write(ns, k, v); },
      flush: async () => { calls.push('flush'); },
    };
    await launch({ storage: legacyStorage({ zoom: '1.5' }), deps: { prefs, createHost: async () => { calls.push('createHost'); return host; } } });
    expect(calls.slice(0, 4)).toEqual(['write:zoom', 'write:migrated.legacy-prefs', 'flush', 'createHost']);
  });

  it('copies once: a second launch leaves what the engine saved since', async () => {
    const storage = legacyStorage({ zoom: '1.5' });
    const t = await launch({ storage });
    t.host.prefs.write('app', 'zoom', '1');
    handles.pop()?.dispose();
    const again = await launch({ storage, deps: { prefs: t.host.prefs, createHost: async () => t.host } });
    expect(again.shell.migration.ran).toBe(false);
    expect(t.host.prefs.peek('app').get('zoom')).toBe('1');
  });
});

describe('safe mode', () => {
  it('a boot.pending marker left from the last launch shows the fault panel and loads no skin', async () => {
    const t = await launch({ seed: { app: { [PENDING_KEY]: '1' } } });
    expect(t.stub.engine.load).not.toHaveBeenCalled();
    expect(t.deps.skins.importDefault).not.toHaveBeenCalled();
    expect(t.shell.panel.visible()).toBe(true);
    expect(panelText(t.root)).toBe(MESSAGES.pending);
    expect(marker(t.host)).toBe('1');                           // still the old one; this launch armed nothing
  });

  it('Shift held at launch does the same', async () => {
    const t = await launch({ shift: () => true });
    expect(t.stub.engine.load).not.toHaveBeenCalled();
    expect(panelText(t.root)).toBe(MESSAGES.shift);
    expect(marker(t.host)).toBeUndefined();
  });

  it('Shift seen on a real event before the check is Shift held (the default watcher)', async () => {
    const host = createTestHost();
    const root = document.createElement('div');
    document.body.append(root);
    const stub = stubEngine();
    const pending = boot({
      createHost: async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })); return host; },
      prefs: host.prefs,
      createEngine: stub.createEngine,
      skins: { importDefault: async () => ({ sha: SHA, name: 'a.wmz' }), read: async () => SKIN_BYTES },
      storage: legacyStorage(),
      menuPresenter: async () => {},
      root,
    });
    const shell = await pending;
    handles.push(shell);
    expect(stub.engine.load).not.toHaveBeenCalled();
    expect(root.querySelector('.wh-fault-message')?.textContent).toBe(MESSAGES.shift);
  });

  it('the panel\'s Reload skin is the explicit retry: it arms, loads and runs the 10 s clock', async () => {
    const t = await launch({ seed: { app: { [PENDING_KEY]: '1' } } });
    /** @type {HTMLButtonElement} */ (t.root.querySelector('.wh-fault-reload')).click();
    await flush();
    await flush();
    expect(t.stub.engine.load).toHaveBeenCalledOnce();
    expect(t.shell.panel.visible()).toBe(false);
    t.host.clock.advance(10_100);
    expect(marker(t.host)).toBeUndefined();
  });

  it('quitting from a safe-mode launch does not clear the marker that caused it', async () => {
    const t = await launch({ seed: { app: { [PENDING_KEY]: '1' } } });
    window.dispatchEvent(new Event('pagehide'));
    expect(marker(t.host)).toBe('1');
  });

  it('the menu and the keys work in safe mode', async () => {
    const t = await launch({ shift: () => true });
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus).toHaveLength(1);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await flush();
    expect(t.host.media.calls.map((c) => c.method)).toEqual(['play']);
  });
});

describe('a skin that does not come up', () => {
  it('no skin installed: the panel says so, and nothing is armed', async () => {
    const t = await launch({ skins: { importDefault: async () => null, read: async () => SKIN_BYTES } });
    expect(panelText(t.root)).toMatch(/No skin is installed/);
    expect(t.stub.engine.load).not.toHaveBeenCalled();
    expect(marker(t.host)).toBeUndefined();
  });

  it('an unreadable skin store is reported, not thrown', async () => {
    const t = await launch({ skins: { importDefault: async () => { throw new Error('ipc down'); }, read: async () => SKIN_BYTES } });
    expect(panelText(t.root)).toBe('No skin could be read: ipc down');
  });

  it('a corrupt archive is "not a usable skin archive", and the marker stays for the next launch', async () => {
    const t = await launch({ skins: { importDefault: async () => ({ sha: SHA, name: 'junk.wmz' }), read: async () => new Uint8Array([9, 9, 9]) } });
    expect(panelText(t.root)).toMatch(/junk\.wmz is not a usable skin archive/);
    expect(t.stub.engine.load).not.toHaveBeenCalled();
    expect(marker(t.host)).toBe('1');
    t.host.clock.advance(60_000);
    expect(marker(t.host)).toBe('1');
  });

  it('an engine that throws at load shows the panel, tears down, and does not retry by itself', async () => {
    const stub = stubEngine();
    stub.engine.load.mockRejectedValue(new Error('realm hard fault: budget'));
    const t = await launch({ stub });
    expect(panelText(t.root)).toMatch(/failed to load: realm hard fault: budget/);
    expect(t.shell.view()).toBeNull();
    expect(t.deps.onTeardown).not.toHaveBeenCalled();           // no skin was built, so no visualizer to release
    expect(marker(t.host)).toBe('1');
    expect(stub.engine.load).toHaveBeenCalledOnce();
  });

  it('an attach that throws disposes the skin it loaded and shows the panel', async () => {
    const stub = stubEngine();
    stub.skin.attach.mockRejectedValue(new Error('onload loops'));
    const t = await launch({ stub });
    expect(panelText(t.root)).toBe('The skin failed to start: onload loops');
    expect(stub.skin.dispose).toHaveBeenCalledOnce();
    expect(t.deps.onTeardown).toHaveBeenCalledOnce();           // whatever it mounted before failing is released
  });

  it('a sidecar that does not validate (or cannot be read) loads the skin without it, and says why', async () => {
    const { SidecarError } = await import('../../src/app/sidecar.js');
    const bad = await launch({ deps: { sidecarFor: async (/** @type {string} */ sha) => { throw new SidecarError(sha, [{ path: '/overlays/0', message: 'wrong' }]); } } });
    expect(bad.stub.engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: 'Headspace.wmz' });
    expect(bad.shell.panel.visible()).toBe(false);
    expect(bad.host.recorded.logs.some((l) => l.level === 'warn' && /is invalid: \/overlays\/0 wrong/.test(l.message))).toBe(true);
    handles.pop()?.dispose();
    const unreadable = await launch({ deps: { sidecarFor: async () => { throw new Error('disk'); } } });
    expect(unreadable.stub.engine.load).toHaveBeenCalledOnce();
    expect(unreadable.host.recorded.logs.some((l) => l.message === 'sidecar: disk')).toBe(true);
  });

  it('with no committed sidecar for the archive (every skin but Headspace) it loads with none', async () => {
    const t = await launch({ deps: { sidecarFor: undefined } });
    expect(t.stub.engine.load).toHaveBeenCalledWith(SKIN_BYTES, { name: 'Headspace.wmz' });
    expect(t.shell.sidecar()).toBeNull();
  });

  it('the fault action (the realm unloaded) puts "This skin stopped: <reason>" in the panel and in the window shape', async () => {
    const t = await launch();
    t.stub.seen.host.actions.fault('a script ran out of time');
    expect(t.shell.panel.visible()).toBe(true);
    expect(panelText(t.root)).toBe('This skin stopped: a script ran out of time');
    const shape = /** @type {any} */ (t.host.window.lastShape());
    expect(shape.kind).toBe('bits');
    expect(shape.bits.some((b) => b !== 0)).toBe(true);
  });

  it('the window menu still works over the fault panel', async () => {
    const t = await launch();
    t.stub.seen.host.actions.fault('x');
    t.root.querySelector('.wh-fault')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus).toHaveLength(1);
  });

  it('Use legacy Headspace flips the front end', async () => {
    const t = await launch();
    t.stub.seen.host.actions.fault('x');
    /** @type {HTMLButtonElement} */ (t.root.querySelector('.wh-fault-legacy')).click();
    expect(t.deps.flip).toHaveBeenCalledWith('legacy');
  });
});

describe('reload', () => {
  it('tears the skin down and loads it again: the panel goes, the marker re-arms, the fan-out is released', async () => {
    const t = await launch();
    t.stub.seen.host.actions.fault('x');
    t.host.clock.advance(11_000);
    expect(marker(t.host)).toBeUndefined();
    /** @type {HTMLButtonElement} */ (t.root.querySelector('.wh-fault-reload')).click();
    await flush();
    await flush();
    expect(t.stub.view.dispose).toHaveBeenCalledOnce();
    expect(t.stub.skin.dispose).toHaveBeenCalledOnce();
    expect(t.deps.onTeardown).toHaveBeenCalledOnce();
    expect(t.stub.engine.load).toHaveBeenCalledTimes(2);
    expect(t.shell.panel.visible()).toBe(false);
    expect(marker(t.host)).toBe('1');
  });

  it('Reload Skin in the window menu does the same, and calls made while loading share one load', async () => {
    const t = await launch();
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    const reload = /** @type {any} */ (t.menus[0].find((s) => s.kind === 'item' && s.text === 'Reload Skin'));
    const a = reload.action();
    const b = t.shell.reload();
    await Promise.all([a, b]);
    expect(t.stub.engine.load).toHaveBeenCalledTimes(2);
  });
});

describe('drawer restore, from the sidecar', () => {
  const sidecar = {
    schema: 'window_headmpd-sidecar/1',
    skin: SHA,
    restore: [
      { global: 'eqIsOpen', toggle: 'ToggleEqView', pref: 'eqOpen' },
      { global: 'plIsOpen', toggle: 'TogglePlView', pref: 'plOpen' },
    ],
  };

  it('calls ToggleEqView after the skin attached when eqOpen is true', async () => {
    const t = await launch({ sidecar, seed: { app: { eqOpen: 'true' } } });
    expect(t.stub.seen.called).toEqual(['ToggleEqView']);
    expect(t.stub.seen.order).toEqual(['load', 'attach']);
  });

  it('persists eqOpen after a dispatch that changes eqIsOpen', async () => {
    const t = await launch({ sidecar });
    expect(t.host.prefs.peek('app').has('eqOpen')).toBe(false);
    t.stub.seen.globals.set('eqIsOpen', true);                  // the click's handler ran ToggleEqView
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(t.host.prefs.peek('app').get('eqOpen')).toBe('true');
    t.stub.seen.globals.set('eqIsOpen', false);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', bubbles: true }));
    expect(t.host.prefs.peek('app').get('eqOpen')).toBe('false');
  });

  it('catches a change no gesture made, from the frame clock', async () => {
    const t = await launch({ sidecar });
    t.stub.seen.globals.set('plIsOpen', true);
    t.host.clock.advance(400);
    expect(t.host.prefs.peek('app').get('plOpen')).toBe('true');
  });

  it('a skin with no sidecar restores nothing and reads no globals', async () => {
    const t = await launch({ seed: { app: { eqOpen: 'true' } } });
    expect(t.stub.seen.called).toEqual([]);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(t.stub.view.inspector.readGlobal).not.toHaveBeenCalled();
  });
});

describe('the shell\'s host actions', () => {
  it('returnToMediaCenter toggles the zoom by default, and honours the sidecar\'s "none"', async () => {
    const a = await launch();
    a.stub.seen.host.actions.run('returnToMediaCenter', { viewId: 'sMain' });
    await flush();
    expect(a.host.window.recorded.zoomRequests).toEqual([1.5]);
    handles.pop()?.dispose();
    const b = await launch({ sidecar: { schema: 'window_headmpd-sidecar/1', skin: SHA, actions: { returnToMediaCenter: 'none' } } });
    b.stub.seen.host.actions.run('returnToMediaCenter', { viewId: 'sMain' });
    await flush();
    expect(b.host.window.recorded.zoomRequests).toEqual([]);
  });

  it('minimize and close go to the window', async () => {
    const t = await launch();
    t.stub.seen.host.actions.run('minimize', { viewId: 'sMain' });
    expect(t.host.window.state.minimized).toBe(true);
    t.stub.seen.host.actions.run('close', { viewId: 'sMain' });
    await flush();
    expect(t.host.window.state.closed).toBe(true);
  });

  it('denied() is logged once per api', async () => {
    const t = await launch();
    const { actions } = t.stub.seen.host;
    actions.denied('player.launchURL', 'http://x');
    actions.denied('player.launchURL', 'http://y');
    actions.denied('player.URL', 'z');
    actions.denied('__proto__', 'a');
    actions.denied('constructor', 'b');
    actions.denied('__proto__', 'c');
    expect(t.host.recorded.logs.filter((l) => l.message.startsWith('denied:')).map((l) => l.message))
      .toEqual(['denied: player.launchURL', 'denied: player.URL', 'denied: __proto__', 'denied: constructor']);
  });
});

describe('the window menu and the keys, wired', () => {
  it('Control-click opens the menu with the live state: Keep on Top toggles the pin and saves it', async () => {
    const t = await launch();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    await flush();
    const keepOnTop = /** @type {any} */ (t.menus[0].find((s) => s.kind === 'check' && s.text === 'Keep on Top'));
    keepOnTop.action();
    await flush();
    expect(t.host.window.state.alwaysOnTop).toBe(true);
    expect(t.host.prefs.peek('app').get('onTop@native/main')).toBe('true');
  });

  it('the size item toggles the zoom, and the menu then says Normal Size', async () => {
    const t = await launch();
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    await /** @type {any} */ (t.menus[0].find((s) => s.kind === 'item' && s.text === 'Larger Size')).action();
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus[1].some((s) => s.kind === 'item' && s.text === 'Normal Size')).toBe(true);
  });

  it('the notice is the menu\'s first item for a skin with no EFFECTS element', async () => {
    const stub = stubEngine();
    stub.skin.attach.mockImplementation(async () => stub.view);       // mounts no effects slot
    const t = await launch({ stub, hostOver: (h) => { h.slots.notice = { text: () => 'Waiting for MPD…' }; } });
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus[0][0]).toMatchObject({ text: 'Waiting for MPD…', enabled: false });
  });

  it('with an EFFECTS element the notice stays in the slot, not the menu', async () => {
    const t = await launch({ hostOver: (h) => { h.slots.notice = { text: () => 'Waiting for MPD…' }; } });
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus[0][0]).toMatchObject({ text: 'Keep on Top' });
  });

  it('V steps the visualization of the mounted effects slot, and stops when the skin is torn down', async () => {
    const t = await launch();
    const effects = t.host.slots.mounted.find((m) => m.kind === 'effects').handle.effects;
    const before = effects.index;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }));
    expect(effects.index).toBe((before + 1) % effects.count);
    await t.shell.reload();
    const stepped = effects.index;
    // The reload mounted a fresh slot: V steps that one, never the disposed control.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true, cancelable: true }));
    expect(effects.index).toBe(stepped);
  });

  it('a skin handler that took the key keeps it from the defaults', async () => {
    const t = await launch();
    const skin = (/** @type {Event} */ e) => e.preventDefault();
    document.addEventListener('keydown', skin, true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', skin, true);
    await flush();
    expect(t.host.media.calls).toEqual([]);
  });
});

describe('closing and disposing', () => {
  it('the page going away clears the marker, even inside the 10 s, and asks the store to flush', async () => {
    const flush = vi.fn(async () => {});
    const t = await launch();
    t.deps.prefs.flush = flush;
    expect(marker(t.host)).toBe('1');
    window.dispatchEvent(new Event('pagehide'));
    expect(marker(t.host)).toBeUndefined();
    expect(flush).toHaveBeenCalled();
  });

  it('does not subscribe to the window\'s close request (the host would then owe the page a destroy())', async () => {
    const onClose = vi.fn(() => () => {});
    await launch({ hostOver: (h) => { h.window.onClose = onClose; } });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dispose() tears the skin down and removes every window listener', async () => {
    const t = await launch();
    t.shell.dispose();
    expect(t.stub.view.dispose).toHaveBeenCalledOnce();
    expect(t.stub.skin.dispose).toHaveBeenCalledOnce();
    expect(t.deps.onTeardown).toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    await flush();
    expect(t.menus).toEqual([]);
    expect(t.host.media.calls).toEqual([]);
    t.shell.dispose();                                          // twice is fine
  });

  it('forwards page errors and unhandled rejections to the host log', async () => {
    const t = await launch();
    window.dispatchEvent(Object.assign(new Event('error'), { message: 'boom', filename: 'x.js', lineno: 7 }));
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('late') }));
    const warns = t.host.recorded.logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warns).toContain('boom @ x.js:7');
    expect(warns).toContain('unhandled: late');
  });
});
