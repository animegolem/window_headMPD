// @vitest-environment happy-dom
// @ts-check
// App integration (WAVES W5.2, ENGINE.md D10, §3.1): `boot()` composed with the REAL engine, the real skin
// store over a fake `invoke`, the real sidecar loader and the test host, in happy-dom. tests/app/boot.test.js
// covers the shell against a stub engine; this file is about the seams between the real pieces:
//
//   first run      the store's default path, import and read; the skin remembered for the next launch
//   load order     sidecar, engine.load, the notice colour, attach, the saved drawer replayed after onload
//   the notice     the first coloured TEXT of the archive, known before the effects slot mounts
//   demo trigger   `mpd-message` "demo <wav>" -> the live view's DemoTarget and the Headspace choreography
//   the tour       Headspace only (skips without the fixture): the real tour end to end on the manual clock
//
// Everything is synthetic except the Headspace block, which reads the owner's archive and writes nothing.
// Rule 6: the trigger compares the command with `demo` and keeps no table; `__proto__` and `constructor`
// messages are fed to it below, and the skin store's records are looked up by position, never by name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { createSkinStore } from '../../src/hosts/tauri/skins.js';
import { createTestHost } from '../../src/hosts/test/index.js';
import { clockFromEngine } from '../../src/app/demo/driver.js';
import { loadSidecar } from '../../src/app/sidecar.js';
import { stubCanvas } from '../engine/render/helpers.js';
import { WIDE, bmp, skinZip, wmsOf } from '../engine/runtime/helpers.js';
import { describeHeadspace } from '../support/fixtures.js';

// boot.js starts the app on import unless an embedder says otherwise; this file is the embedder.
/** @type {any} */ (globalThis).__WINDOW_HEADMPD_BOOT__ = 'manual';
const { ACTIVE_SKIN_PREF, boot, firstTextColour } = await import('../../src/app/boot.js');
const { DEFAULT_WAV, MESSAGE_EVENT, attachDemoTrigger, parseDemoMessage, planTour } = await import('../../src/app/demo-trigger.js');
const { PENDING_KEY } = await import('../../src/app/safe-mode.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

/** @type {() => void} */
let restoreCanvas;
/** @type {Array<{ dispose(): void }>} */
const handles = [];
beforeEach(() => {
  restoreCanvas = stubCanvas();
  document.body.replaceChildren();
});
afterEach(() => {
  while (handles.length) handles.pop()?.dispose();
  restoreCanvas();
  document.body.replaceChildren();
});

// ---- the synthetic skin -----------------------------------------------------------------------------------

/** The names the sidecar's `tour` block gives; the synthetic skin need not have them (planTour only parses). */
const TOUR = Object.freeze({
  transport: 'btn', playColor: '#FFFF00', visColor: '#0000FF', eqHandle: 'eqToggle', plHandle: 'plToggle', visNext: 'btn',
  reset: 'label', bands: Array.from({ length: 10 }, (_, i) => `eq${i + 1}`), rest: { x: 150, y: 90 },
  toggle: { eq: 'ToggleEqView', pl: 'TogglePlView', vis: 'ToggleVisView' },
  isOpen: { eq: 'eqIsOpen', pl: 'plIsOpen', vis: 'visIsOpen' },
});

/** The first TEXT with a declared colour is `label`; `plain` declares none; `late` declares another, after it. */
const WMS = wmsOf(`
  <text id="plain" left="0" top="0" width="40" height="10" value="x"/>
  <subview id="deep" left="0" top="0" width="10" height="10"><text id="inner" foregroundColor="jscript:1+1" width="10" height="10"/></subview>
  <text id="label" left="4" top="84" width="80" height="12" value="hello" foregroundColor="#12ab34"/>
  <text id="late" left="4" top="70" width="80" height="12" value="later" foregroundColor="#ff0000"/>
  <button id="eqToggle" left="8" top="8" width="16" height="16" image="btn.bmp" onclick="ToggleEqView();"/>
  <subview id="screen" left="100" top="10" width="40" height="30">
    <effects id="fx" left="0" top="0" width="40" height="30"/>
  </subview>`,
'id="v" width="200" height="100" backgroundColor="none" titleBar="false"');
const SCRIPT = 'var eqIsOpen = false; var plIsOpen = false; var visIsOpen = false;\r\n'
  + 'function ToggleEqView() { eqIsOpen = !eqIsOpen; }\r\n'
  + 'function TogglePlView() { plIsOpen = !plIsOpen; }\r\n'
  + 'function ToggleVisView() { visIsOpen = !visIsOpen; }\r\n';
const SKIN = skinZip({ wms: WMS, js: SCRIPT, files: { 'btn.bmp': bmp(16, 16, [200, 30, 30]) } });

/** What the committed sidecar of a skin holds, for an archive with this hash. @param {string} sha @param {Record<string, unknown>} [over] */
const sidecarFor = (sha, over = {}) => ({
  schema: 'window_headmpd-sidecar/1',
  skin: sha,
  restore: [{ global: 'eqIsOpen', toggle: 'ToggleEqView', pref: 'eqOpen' }, { global: 'plIsOpen', toggle: 'TogglePlView', pref: 'plOpen' }],
  tour: TOUR,
  ...over,
});

/** @param {Record<string, string>} [data] */
const legacyStorage = (data = {}) => ({ getItem: (/** @type {string} */ k) => (Object.hasOwn(data, k) ? data[k] : null) });

/**
 * The Rust `skin_*` commands, over a Map: what `createSkinStore` talks to. Records are kept in a list and
 * found by position or by sha text compared with `===`, never as keys of a plain object.
 * @param {{ archive: Uint8Array, name?: string, defaultPath?: string | null, recorded?: Array<{ sha: string, name: string, family: string, bytes: number, imported_at: number }> }} o
 */
async function fakeStore(o) {
  const name = o.name ?? 'Integration.wmz';
  const { sha } = await openVfs(o.archive, name);
  const records = o.recorded ?? [];
  /** @type {string[]} */
  const calls = [];
  const invoke = vi.fn(async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push(cmd);
    switch (cmd) {
      case 'skin_default_path': return o.defaultPath === undefined ? '/tmp/Integration.wmz' : o.defaultPath;
      case 'skin_list': return records;
      case 'skin_import': {
        const rec = { sha, name, family: 'wms', bytes: o.archive.length, imported_at: 0 };
        if (!records.some((r) => r.sha === sha)) records.push(rec);
        return rec;
      }
      case 'skin_read': {
        if (args.sha !== sha) throw new Error('no such skin');
        return o.archive.buffer.slice(o.archive.byteOffset, o.archive.byteOffset + o.archive.byteLength);   // an ArrayBuffer, as Tauri answers
      }
      default: throw new Error(`unexpected command ${cmd}`);
    }
  });
  return { sha, store: createSkinStore({ invoke }), invoke, calls, records };
}

/** A Tauri `listen` that remembers its handlers: `emit` is Rust emitting `mpd-message`. */
function fakeListen() {
  /** @type {Map<string, Set<(e: { payload?: unknown }) => void>>} */
  const handlers = new Map();
  const unlisten = vi.fn();
  const listen = vi.fn(async (/** @type {string} */ event, /** @type {(e: { payload?: unknown }) => void} */ cb) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)?.add(cb);
    return () => { unlisten(); handlers.get(event)?.delete(cb); };
  });
  return {
    listen,
    unlisten,
    count: (event = MESSAGE_EVENT) => handlers.get(event)?.size ?? 0,
    emit: (/** @type {unknown} */ payload, event = MESSAGE_EVENT) => { for (const cb of [...(handlers.get(event) ?? [])]) cb({ payload }); },
  };
}

/**
 * One launch of the real shell on the real engine.
 * @param {{
 *   archive?: Uint8Array, name?: string, seed?: Record<string, Record<string, string>>, defaultPath?: string | null,
 *   recorded?: Parameters<typeof fakeStore>[0]['recorded'], sidecar?: ((sha: string) => any) | null | 'real',
 *   tour?: any, listen?: boolean, media?: string, hostOver?: (host: any) => void, deps?: Record<string, unknown>,
 * }} [o]
 */
async function launch(o = {}) {
  const root = document.createElement('div');
  root.id = 'skin';
  document.body.append(root);
  const host = createTestHost({ seed: o.seed, media: o.media ?? 'stoppedEmpty', window: { root, key: 'native/main' } });
  o.hostOver?.(host);
  const archive = o.archive ?? SKIN;
  const store = await fakeStore({ archive, name: o.name, defaultPath: o.defaultPath, recorded: o.recorded });
  const ear = fakeListen();
  /** The cell `runBoot` keeps for the Tauri host, and what it held each time an effects slot mounted. */
  const notice = { value: /** @type {number | null} */ (null), atMount: /** @type {Array<number | null>} */ ([]), loads: /** @type {any[]} */ ([]) };
  const slots = /** @type {any} */ (host.slots);
  const mount = slots.mount.bind(slots);
  slots.mount = (/** @type {any} */ el, /** @type {any} */ spec, /** @type {any} */ win) => {
    if (spec.kind === 'effects') notice.atMount.push(notice.value);
    return mount(el, spec, win);
  };
  const order = /** @type {string[]} */ ([]);
  const shell = await boot({
    createHost: async () => host,
    prefs: host.prefs,
    engineOptions: { budgets: WIDE },
    skins: store.store,
    sidecarFor: o.sidecar === 'real' ? loadSidecar : async (sha) => (o.sidecar === null ? null : (o.sidecar ?? sidecarFor)(sha)),
    storage: legacyStorage(),
    shift: () => false,
    menuPresenter: async () => {},
    flip: vi.fn(),
    onSkinLoaded: (loaded) => {
      order.push('onSkinLoaded');
      notice.value = loaded.noticeColor;
      notice.loads.push(loaded);
    },
    ...(o.listen === false ? {} : { listen: ear.listen }),
    tour: o.tour,
    ...o.deps,
  });
  handles.push(shell);
  await shell.demo?.ready;
  return { shell, host, root, store, ear, notice, order };
}

const marker = (/** @type {any} */ host) => host.prefs.peek('app').get(PENDING_KEY);

/** A tour runner that records what it was called with and holds until released. */
function heldRun() {
  /** @type {Array<{ target: any, choreography: any, wav: string, env: any, release(): void, fail(e: Error): void }>} */
  const calls = [];
  const run = vi.fn((/** @type {any} */ target, /** @type {any} */ choreography, /** @type {string} */ wav, /** @type {any} */ env) => new Promise((resolve, reject) => {
    calls.push({ target, choreography, wav, env, release: () => resolve(undefined), fail: reject });
  }));
  return { run, calls };
}

// ---- first run ---------------------------------------------------------------------------------------------

describe('a first launch on the real engine', () => {
  it('imports the default skin through the store, loads it, attaches the main view and remembers it', async () => {
    const t = await launch();
    expect(t.store.calls).toEqual(['skin_default_path', 'skin_import', 'skin_read']);
    expect(t.shell.panel.visible()).toBe(false);
    expect(t.shell.skin()?.sha).toBe(t.store.sha);
    const view = /** @type {any} */ (t.shell.view());
    expect(view.viewId).toBe('v');
    expect(view.inspector.find('label')).toEqual({ id: 'label', kind: 'text' });
    expect(view.health).toEqual({ soft: 0, hard: 0, unloaded: false });
    expect(t.host.prefs.peek('app').get(ACTIVE_SKIN_PREF)).toBe(t.store.sha);
    expect(marker(t.host)).toBe('1');                                  // armed for the 10 s clock
    expect(t.host.recorded.faults).toEqual([]);
  });

  it('keys the window by archive hash and view, and sizes it to the VIEW at attach', async () => {
    const t = await launch({ hostOver: (h) => { h.window.setKey = (/** @type {string} */ k) => { h.window.key = k; }; } });
    expect(t.host.window.key).toBe(`${t.store.sha}/v`);
    expect(t.host.window.recorded.initialSizes).toEqual([{ w: 200, h: 100 }]);
    expect(t.shell.view()?.maskShape()).toMatchObject({ kind: 'bits', width: 200, height: 100 });
  });

  it('a skin that starts on a splash: the window key names the splash, the fault panel the view shown (5F.8)', async () => {
    const wms = `<THEME>
<VIEW id="splash" width="120" height="80" backgroundColor="none" titleBar="false" onload="theme.currentViewID = 'main';"/>
<VIEW id="main" width="300" height="200" backgroundColor="none" titleBar="false"/>
</THEME>`;
    const t = await launch({ archive: skinZip({ wms }), sidecar: null, hostOver: (h) => { h.window.setKey = (/** @type {string} */ k) => { h.window.key = k; }; } });
    const view = /** @type {any} */ (t.shell.view());
    expect(view.viewId).toBe('main');
    expect(t.host.window.key).toBe(`${t.store.sha}/splash`);          // stable across launches, whatever the splash hands over to
    expect(t.host.window.recorded.initialSizes).toEqual([{ w: 120, h: 80 }, { w: 300, h: 200 }]);
    expect(t.shell.skin()?.views().find((v) => v.main)?.id).toBe('splash');
    t.shell.fault('This skin stopped: x');
    expect(t.host.window.lastShape()).toMatchObject({ width: 300, height: 200 });
    expect(/** @type {HTMLElement} */ (t.root.querySelector('.wh-fault')).style.top).toBe('36px');   // 128 px of panel centred in 200; the splash's 80 would be 0
  });

  it('the first-run fallback imports only while no skin is recorded; a later launch takes the remembered one', async () => {
    const fallback = '/Users/someone/Downloads/Headspace.wmz';
    const recorded = /** @type {any[]} */ ([]);
    const first = await launch({ defaultPath: fallback, recorded });
    expect(first.store.calls).toEqual(['skin_default_path', 'skin_list', 'skin_import', 'skin_read']);
    expect(recorded).toHaveLength(1);
    handles.pop()?.dispose();
    document.body.replaceChildren();

    const second = await launch({ defaultPath: fallback, recorded, seed: { app: { [ACTIVE_SKIN_PREF]: first.store.sha } } });
    expect(second.store.calls).toEqual(['skin_default_path', 'skin_list', 'skin_list', 'skin_read']);   // no import: one skin is recorded
    expect(second.shell.skin()?.sha).toBe(first.store.sha);
    expect(second.shell.panel.visible()).toBe(false);
  });

  it('no default path and nothing recorded: the panel says no skin is installed, and nothing is armed', async () => {
    const t = await launch({ defaultPath: null });
    expect(t.shell.skin()).toBeNull();
    expect(t.root.querySelector('.wh-fault-message')?.textContent).toMatch(/No skin is installed/);
    expect(marker(t.host)).toBeUndefined();
    expect(t.notice.loads).toHaveLength(0);
  });

  it('a leftover boot marker is safe mode: no import, no load, the panel, and the real engine never ran', async () => {
    const t = await launch({ seed: { app: { [PENDING_KEY]: '1' } } });
    expect(t.store.calls).toEqual([]);
    expect(t.shell.skin()).toBeNull();
    expect(t.shell.panel.visible()).toBe(true);
    expect(t.notice.loads).toHaveLength(0);
  });

  it('clears the marker 10 s after the first frame of the real view', async () => {
    const t = await launch();
    t.host.clock.advance(10_000);
    expect(marker(t.host)).toBe('1');
    t.host.clock.advance(100);
    expect(marker(t.host)).toBeUndefined();
  });
});

// ---- sidecar, restore --------------------------------------------------------------------------------------

describe('the sidecar and the saved drawers', () => {
  it('hands the sidecar for the archive hash to the engine, and the shell keeps it', async () => {
    const seen = /** @type {string[]} */ ([]);
    const t = await launch({ sidecar: (sha) => { seen.push(sha); return sidecarFor(sha); } });
    expect(seen).toEqual([t.store.sha]);
    expect(t.shell.sidecar()?.tour).toBeDefined();
    expect(t.notice.loads[0].sidecar).toBe(t.shell.sidecar());
  });

  it('a sidecar made for another archive is ignored by the engine with a diagnostic, and the skin still loads', async () => {
    // Cannot happen through `loadSidecar(sha)`, which answers for the hash it was asked about; the engine
    // checks anyway, and the shell must not depend on it.
    const t = await launch({ sidecar: () => sidecarFor('f'.repeat(64)) });
    expect(t.host.recorded.diagnostics.some((d) => d.code === 'sidecar-wrong-skin')).toBe(true);
    expect(t.shell.view()).not.toBeNull();
    expect(t.shell.panel.visible()).toBe(false);
  });

  it('replays a drawer that was open when the owner quit, after onload', async () => {
    const t = await launch({ seed: { app: { eqOpen: 'true', plOpen: 'false' } } });
    const ins = /** @type {any} */ (t.shell.view()).inspector;
    expect(ins.readGlobal('eqIsOpen')).toBe(true);
    expect(ins.readGlobal('plIsOpen')).toBe(false);
  });

  it('saves a drawer the skin opened on a click, in the legacy format, under the app namespace', async () => {
    const t = await launch();
    const view = /** @type {any} */ (t.shell.view());
    expect(t.host.prefs.peek('app').has('eqOpen')).toBe(false);
    const plane = /** @type {HTMLElement} */ (t.root.querySelector('div.input'));
    /** @param {string} type */
    const ptr = (type) => plane.dispatchEvent(new PointerEvent(type, { clientX: 15, clientY: 15, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' ? 1 : 0 }));
    ptr('pointerdown');
    ptr('pointerup');
    await view.settled();
    expect(view.inspector.readGlobal('eqIsOpen')).toBe(true);
    expect(t.host.prefs.peek('app').get('eqOpen')).toBe('true');
  });

  it('a reload runs the whole sequence again against the same store', async () => {
    const t = await launch();
    const before = /** @type {any} */ (t.shell.view());
    await t.shell.reload();
    const after = /** @type {any} */ (t.shell.view());
    expect(after).not.toBe(before);
    expect(after.inspector.root()).not.toBe(before.inspector.root());
    expect(t.store.calls.filter((c) => c === 'skin_read')).toHaveLength(2);
    expect(t.notice.loads).toHaveLength(2);
    expect(t.shell.panel.visible()).toBe(false);
  });
});

// ---- the notice colour -------------------------------------------------------------------------------------

describe('the notice colour', () => {
  it('is known when the effects slot mounts: the first TEXT that declares a colour', async () => {
    const t = await launch();
    expect(t.notice.loads[0].noticeColor).toBe(0x12ab34);
    expect(t.notice.atMount).toEqual([0x12ab34]);                      // read inside attach, after the load told the host
    expect(t.order).toEqual(['onSkinLoaded']);
  });

  it('is told to the host again by a reload, and a skin with no coloured TEXT says null', async () => {
    const plain = skinZip({ wms: wmsOf('<text id="t" left="0" top="0" width="9" height="9"/>'), js: '' });
    const t = await launch({ archive: plain, sidecar: null });
    expect(t.notice.loads[0].noticeColor).toBeNull();
    expect(t.notice.loads[0].sidecar).toBeNull();
  });

  it('a hook that throws does not take the launch down', async () => {
    const t = await launch({ deps: { onSkinLoaded: () => { throw new Error('boom'); } } });
    expect(t.shell.view()).not.toBeNull();
    expect(t.shell.panel.visible()).toBe(false);
  });
});

describe('firstTextColour', () => {
  /** @param {string} body */
  const colourOf = async (body) => firstTextColour((await openVfs(skinZip({ wms: wmsOf(body), js: '' }), 'x.wmz')));

  it('takes TEXT elements in document order, depth first, and ignores every other tag', async () => {
    expect(await colourOf('<button id="b" foregroundColor="#010203"/><subview id="s"><text id="a" foregroundColor="#0a0b0c"/></subview><text id="z" foregroundColor="#ffffff"/>')).toBe(0x0a0b0c);
    expect(await colourOf('<subview id="s"><subview id="s2"><text foregroundColor="#aabbcc"/></subview></subview><text foregroundColor="#112233"/>')).toBe(0xaabbcc);
  });

  it('passes over a value that is not a colour yet (jscript:, wmpprop:, none, auto, junk) and over a TEXT with none', async () => {
    expect(await colourOf('<text id="a"/><text id="b" foregroundColor="jscript:1"/><text id="c" foregroundColor="wmpprop:player.x"/><text id="d" foregroundColor="none"/><text id="e" foregroundColor="auto"/><text id="f" foregroundColor="grape"/><text id="g" foregroundColor="#0f0f0f"/>')).toBe(0x0f0f0f);
    expect(await colourOf('<text id="a"/><text id="b" foregroundColor="none"/>')).toBeNull();
  });

  it('reads attribute names and tags in any case, as the scanner folds them', async () => {
    expect(await colourOf('<TEXT ID="a" ForegroundColor="#102030"/>')).toBe(0x102030);
  });

  it('is null for an archive with no definition', async () => {
    const vfs = await openVfs(skinZip({ wms: wmsOf(''), js: '' }), 'x.wmz');
    expect(firstTextColour({ ...vfs, list: () => [], read: () => null })).toBeNull();
  });

  it('a skin whose elements are named __proto__ and constructor is an ordinary skin', async () => {
    expect(await colourOf('<text id="__proto__" foregroundColor="#00ff00"/><text id="constructor" foregroundColor="#ff0000"/>')).toBe(0x00ff00);
  });
});

// ---- the demo trigger --------------------------------------------------------------------------------------

describe('parseDemoMessage', () => {
  it('is the default soundtrack for a bare `demo`, and the rest of the line for a path', () => {
    expect(parseDemoMessage('demo')).toBe(DEFAULT_WAV);
    expect(parseDemoMessage('demo ')).toBe(DEFAULT_WAV);
    expect(parseDemoMessage('demo   ')).toBe(DEFAULT_WAV);
    expect(parseDemoMessage('demo /tmp/x.wav')).toBe('/tmp/x.wav');
    expect(parseDemoMessage('demo /tmp/my tour/x.wav')).toBe('/tmp/my tour/x.wav');
    expect(parseDemoMessage('demo   /tmp/x.wav ')).toBe('/tmp/x.wav');
    expect(DEFAULT_WAV).toBe('/tmp/window_headmpd-demo.wav');
  });

  it('is null for any other message, including the names a plain object would answer to', () => {
    for (const m of ['', 'demos', 'Demo', 'demo/tmp/x.wav', ' demo', 'stop', '__proto__', 'constructor', 'constructor x', '__proto__ /tmp/x.wav', 'toString', 'hasOwnProperty demo']) {
      expect(parseDemoMessage(m), m).toBeNull();
    }
    for (const m of [undefined, null, 5, {}, ['demo'], { toString: () => 'demo' }]) expect(parseDemoMessage(m)).toBeNull();
  });
});

describe('the demo trigger on a launched app', () => {
  it('listens for mpd-message once, and a `demo <wav>` runs the Headspace choreography on the live view', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    expect(t.ear.listen).toHaveBeenCalledTimes(1);
    expect(t.ear.listen.mock.calls[0][0]).toBe('mpd-message');
    t.ear.emit('demo /tmp/window_headmpd-x.wav');
    await flush();
    expect(hold.run).toHaveBeenCalledTimes(1);
    const call = hold.calls[0];
    expect(call.wav).toBe('/tmp/window_headmpd-x.wav');
    expect(call.choreography.name).toBe('headspace');
    expect(typeof call.choreography.stage).toBe('function');
    expect(call.env).toBeUndefined();                                   // the app's own: real time, the Tauri recorder
    expect(t.shell.demo?.running()).toBe(true);
    call.release();
    await flush();
    expect(t.shell.demo?.running()).toBe(false);
  });

  it('builds the DemoTarget from the live inspector, host media, the slot\'s effects control and the window zoom', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    t.ear.emit('demo');
    await flush();
    const target = hold.calls[0].target;
    expect(hold.calls[0].wav).toBe(DEFAULT_WAV);
    const view = /** @type {any} */ (t.shell.view());
    expect(target.root()).toBe(view.inspector.root());
    expect(target.root().isConnected).toBe(true);
    expect(target.zoom()).toBe(1);
    expect(target.media).toBe(t.host.media);
    const slot = /** @type {any} */ (t.host.slots).mounted.find((/** @type {any} */ m) => m.spec.kind === 'effects');
    expect(target.effects).toBe(slot.handle.effects);
    expect(target.effects.count).toBeGreaterThan(1);
    // calls go through the skin's own realm
    expect(target.get('eqIsOpen')).toBe(false);
    target.call('ToggleEqView');
    expect(target.get('eqIsOpen')).toBe(true);
    expect(target.attr('label', 'value')).toBe('hello');
    target.setAttr('label', 'value', 'changed');
    expect(target.attr('label', 'value')).toBe('changed');
    expect(target.clientPoint('nope')).toBeNull();
    hold.calls[0].release();
    await flush();
  });

  it('ignores every message that is not `demo`, and passes the soundtrack path through unmodified', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    for (const m of ['stop', 'demos', '__proto__', 'constructor', '__proto__ /tmp/a.wav', '', undefined, null, 7]) t.ear.emit(m);
    await flush();
    expect(hold.run).not.toHaveBeenCalled();
    t.ear.emit('demo /tmp/with space/a b.wav');
    await flush();
    expect(hold.calls[0].wav).toBe('/tmp/with space/a b.wav');
    hold.calls[0].release();
    await flush();
  });

  it('runs one tour at a time: a second message while one runs is ignored, and one after it starts again', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    t.ear.emit('demo /tmp/1.wav');
    t.ear.emit('demo /tmp/2.wav');
    await flush();
    expect(hold.run).toHaveBeenCalledTimes(1);
    expect(t.host.recorded.logs.some((l) => /already running/.test(l.message))).toBe(true);
    hold.calls[0].release();
    await flush();
    t.ear.emit('demo /tmp/3.wav');
    await flush();
    expect(hold.calls.map((c) => c.wav)).toEqual(['/tmp/1.wav', '/tmp/3.wav']);
    hold.calls[1].release();
    await flush();
  });

  it('reports a tour that failed in the log, and a later one still runs', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    t.ear.emit('demo /tmp/1.wav');
    await flush();
    hold.calls[0].fail(new Error('the play control is not on screen'));
    await flush();
    expect(t.shell.demo?.running()).toBe(false);
    expect(t.host.recorded.logs.some((l) => l.level === 'warn' && /demo failed: .*the play control is not on screen/.test(l.message))).toBe(true);
    t.ear.emit('demo /tmp/2.wav');
    await flush();
    expect(hold.run).toHaveBeenCalledTimes(2);
    hold.calls[1].release();
    await flush();
  });

  it('a skin with no tour in its sidecar (or no sidecar) is not touring: nothing runs, the log says why', async () => {
    for (const sidecar of [(/** @type {string} */ sha) => sidecarFor(sha, { tour: undefined }), null]) {
      const hold = heldRun();
      const t = await launch({ tour: { run: hold.run }, sidecar });
      t.ear.emit('demo /tmp/1.wav');
      await flush();
      expect(hold.run).not.toHaveBeenCalled();
      expect(t.host.recorded.logs.some((l) => /demo: not started: this skin has no tour/.test(l.message))).toBe(true);
      expect(t.shell.demo?.running()).toBe(false);
      handles.pop()?.dispose();
      document.body.replaceChildren();
    }
  });

  it('a tour block that does not parse refuses with its own message and does not throw', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run }, sidecar: (sha) => sidecarFor(sha, { tour: { ...TOUR, bands: ['eq1'] } }) });
    t.ear.emit('demo');
    await flush();
    expect(hold.run).not.toHaveBeenCalled();
    expect(t.host.recorded.logs.some((l) => /demo: not started: demo: tour\.bands must hold 10/.test(l.message))).toBe(true);
  });

  it('a skin with no EFFECTS element is refused (the stage sets the preset first)', async () => {
    const noFx = skinZip({ wms: wmsOf('<text id="t" left="0" top="0" width="9" height="9"/>'), js: '' });
    const hold = heldRun();
    const t = await launch({ archive: noFx, tour: { run: hold.run } });
    t.ear.emit('demo');
    await flush();
    expect(hold.run).not.toHaveBeenCalled();
    expect(t.host.recorded.logs.some((l) => /demo: not started: this skin has no visualization/.test(l.message))).toBe(true);
  });

  it('in safe mode there is no view, so the message starts nothing', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run }, seed: { app: { [PENDING_KEY]: '1' } } });
    t.ear.emit('demo');
    await flush();
    expect(hold.run).not.toHaveBeenCalled();
    expect(t.host.recorded.logs.some((l) => /demo: not started: no skin view is attached/.test(l.message))).toBe(true);
  });

  it('a skin that has stopped (the realm unloaded) is not toured', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    const view = /** @type {any} */ (t.shell.view());
    Object.defineProperty(view, 'health', { value: { soft: 0, hard: 3, unloaded: true } });
    t.ear.emit('demo');
    await flush();
    expect(hold.run).not.toHaveBeenCalled();
    expect(t.host.recorded.logs.some((l) => /demo: not started: the skin has stopped/.test(l.message))).toBe(true);
  });

  it('aims at the view that is live when the message arrives, not the one that was live at boot', async () => {
    const hold = heldRun();
    const t = await launch({ tour: { run: hold.run } });
    const firstRoot = /** @type {any} */ (t.shell.view()).inspector.root();
    await t.shell.reload();
    t.ear.emit('demo');
    await flush();
    const target = hold.calls[0].target;
    expect(target.root()).toBe(/** @type {any} */ (t.shell.view()).inspector.root());
    expect(target.root()).not.toBe(firstRoot);
    hold.calls[0].release();
    await flush();
  });

  it('boots without a listener when none is handed in (the tests of the shell), and disposing unlistens', async () => {
    const quiet = await launch({ listen: false });
    expect(quiet.shell.demo).toBeNull();
    handles.pop()?.dispose();
    document.body.replaceChildren();

    const t = await launch({ tour: { run: heldRun().run } });
    expect(t.ear.count()).toBe(1);
    t.shell.dispose();
    expect(t.ear.unlisten).toHaveBeenCalledOnce();
    expect(t.ear.count()).toBe(0);
    t.shell.dispose();
    expect(t.ear.unlisten).toHaveBeenCalledOnce();
  });
});

describe('attachDemoTrigger on its own', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn() });
  const plan = () => ({ target: /** @type {any} */ ({ id: 'target' }), choreography: /** @type {any} */ ({ name: 'headspace' }) });

  it('unlistens at once when disposed before the registration resolved', async () => {
    /** @type {(off: () => void) => void} */
    let resolveListen = () => {};
    const off = vi.fn();
    const trigger = attachDemoTrigger({ listen: () => new Promise((r) => { resolveListen = r; }), plan, log: log(), run: async () => {} });
    trigger.dispose();
    resolveListen(off);
    await trigger.ready;
    expect(off).toHaveBeenCalledOnce();
  });

  it('survives a listen that throws or rejects: it says so and never rejects', async () => {
    const l = log();
    const a = attachDemoTrigger({ listen: () => { throw new Error('no event system'); }, plan, log: l, run: async () => {} });
    await expect(a.ready).resolves.toBeUndefined();
    const b = attachDemoTrigger({ listen: async () => { throw new Error('denied'); }, plan, log: l, run: async () => {} });
    await expect(b.ready).resolves.toBeUndefined();
    expect(l.warn.mock.calls.map((c) => c[0])).toEqual([
      'demo: could not listen for mpd-message: no event system',
      'demo: could not listen for mpd-message: denied',
    ]);
  });

  it('a plan that throws is a failed tour, not an unhandled rejection, and frees the trigger', async () => {
    const l = log();
    let boom = true;
    const run = vi.fn(async () => {});
    const trigger = attachDemoTrigger({
      listen: async () => () => {},
      plan: () => { if (boom) throw new Error('inspector gone'); return plan(); },
      log: l,
      run,
    });
    await trigger.handle('demo /tmp/a.wav');
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/^demo failed: .*inspector gone/));
    expect(trigger.running()).toBe(false);
    boom = false;
    await trigger.handle('demo /tmp/a.wav');
    expect(run).toHaveBeenCalledOnce();
  });

  it('passes the plan, the soundtrack and its environment to run, and handles nothing after dispose', async () => {
    const run = vi.fn(async () => {});
    const env = { log: () => {} };
    const trigger = attachDemoTrigger({ listen: async () => () => {}, plan, log: log(), run, env });
    await trigger.handle('demo /tmp/a.wav');
    expect(run).toHaveBeenCalledWith({ id: 'target' }, { name: 'headspace' }, '/tmp/a.wav', env);
    trigger.dispose();
    await trigger.handle('demo /tmp/b.wav');
    expect(run).toHaveBeenCalledOnce();
  });

  it('a listener for another event name hears that one', async () => {
    const ear = fakeListen();
    const run = vi.fn(async () => {});
    const trigger = attachDemoTrigger({ listen: ear.listen, plan, log: log(), run, event: 'other-event' });
    await trigger.ready;
    ear.emit('demo', MESSAGE_EVENT);
    ear.emit('demo /tmp/x.wav', 'other-event');
    await flush();
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('planTour', () => {
  const media = /** @type {any} */ ({});
  const effects = /** @type {any} */ ({ title: 'x' });
  const inspector = /** @type {any} */ ({ root: () => document.body });
  const live = (/** @type {Record<string, unknown>} */ over = {}) => ({ view: { inspector, health: { unloaded: false } }, sidecar: { tour: TOUR }, media, effects, zoom: () => 1, ...over });

  it('makes a target and the Headspace choreography from a live view, a tour block and an effects control', () => {
    const made = /** @type {any} */ (planTour(/** @type {any} */ (live())));
    expect(made.choreography.name).toBe('headspace');
    expect(made.target.media).toBe(media);
    expect(made.target.effects).toBe(effects);
  });

  it('says why not, in order of what is missing', () => {
    expect(planTour(/** @type {any} */ (live({ view: null })))).toEqual({ refuse: 'no skin view is attached' });
    expect(planTour(/** @type {any} */ (live({ view: { health: { unloaded: false } } })))).toEqual({ refuse: 'no skin view is attached' });
    expect(planTour(/** @type {any} */ (live({ view: { inspector, health: { unloaded: true } } })))).toEqual({ refuse: 'the skin has stopped' });
    expect(planTour(/** @type {any} */ (live({ sidecar: null })))).toEqual({ refuse: 'this skin has no tour in its sidecar' });
    expect(planTour(/** @type {any} */ (live({ effects: null })))).toEqual({ refuse: 'this skin has no visualization (EFFECTS) element to tour' });
    expect(/** @type {any} */ (planTour(/** @type {any} */ (live({ sidecar: { tour: { transport: 'x' } } })))).refuse).toMatch(/tour\./);
  });
});

// ---- Headspace ---------------------------------------------------------------------------------------------

describeHeadspace('Headspace through the real shell', (headspace) => {
  const headspaceLaunch = (/** @type {Parameters<typeof launch>[0]} */ o = {}) => launch({
    archive: new Uint8Array(headspace.bytes()),
    name: 'Headspace.wmz',
    sidecar: 'real',
    seed: { mediacenter: { effectPreset: '1' }, app: { eq: JSON.stringify(Array(10).fill(0)), balance: '0' } },
    ...o,
  });

  it('loads with its committed sidecar, and the notice colour is the oracle\'s --label', async () => {
    const t = await headspaceLaunch();
    expect(t.shell.panel.visible()).toBe(false);
    expect(t.shell.sidecar()?.skin).toBe(t.store.sha);
    expect(t.notice.loads[0].noticeColor).toBe(0x77ce07);
    expect(t.notice.atMount).toEqual([0x77ce07]);
    const view = /** @type {any} */ (t.shell.view());
    expect(view.health).toEqual({ soft: 0, hard: 0, unloaded: false });
    expect(t.host.recorded.faults).toEqual([]);
  });

  it('plans the tour from the real sidecar: the tour block parses and every ref is on the skin', async () => {
    const t = await headspaceLaunch();
    const view = /** @type {any} */ (t.shell.view());
    const tour = /** @type {any} */ (t.shell.sidecar()?.tour);
    const refs = [tour.transport, tour.eqHandle, tour.plHandle, tour.visNext, tour.reset, ...tour.bands];
    for (const ref of refs) expect(view.inspector.find(ref), ref).not.toBeNull();
    for (const drawer of ['eq', 'pl', 'vis']) expect(view.inspector.readGlobal(tour.isOpen[drawer]), drawer).toBe(false);
    const made = /** @type {any} */ (planTour({ view, sidecar: t.shell.sidecar(), media: t.host.media, effects: /** @type {any} */ (t.host.slots).mounted.find((/** @type {any} */ m) => m.spec.kind === 'effects').handle.effects, zoom: () => 1 }));
    expect(made.refuse).toBeUndefined();
    expect(made.target.groupPoint(tour.transport, tour.playColor)).not.toBeNull();
    expect(made.target.groupPoint(tour.transport, tour.visColor)).not.toBeNull();
  });

  it('runs the real tour end to end on the manual clock, started by an mpd-message', async () => {
    // The whole chain of D10.7 in one run: Rust's event, the trigger, the plan from the live inspector and
    // the committed sidecar, the generic driver, synthetic pointer events through the input plane and the
    // picker, the skin's own scripts, and the host's media and DSP. Only the recorder and the clock are
    // stand-ins. The reference is the legacy run (tools/skinlab/cmd-demo.mjs); the exact comparison with
    // its call log is W5.3's, in Chromium. happy-dom has no layout, so every rect is at the origin and
    // client px equal view px, which the driver and the input plane both handle.
    const recorder = { start: vi.fn(async () => {}), stop: vi.fn(async (/** @type {string} */ _path) => {}) };
    /** @type {string[]} */
    const lines = [];
    /** @type {any} */
    let host = null;
    const env = {
      clock: { now: () => host.clock.now(), sleep: (/** @type {number} */ ms) => clockFromEngine(host.clock).sleep(ms) },
      record: recorder,
      elementFromPoint: () => document.querySelector('div.input'),
      log: (/** @type {string} */ m) => { lines.push(m); },
    };
    const t = await headspaceLaunch({ tour: { env }, hostOver: (h) => { host = h; } });
    const view = /** @type {any} */ (t.shell.view());
    host.clock.advance(1500);
    await view.settled();
    host.media.clearCalls();
    host.dsp.sent.eq.length = 0;
    const effects = /** @type {any} */ (host.slots).mounted.find((/** @type {any} */ m) => m.spec.kind === 'effects').handle.effects;
    let presetSteps = 0;
    effects.onChange(() => { presetSteps++; });

    t.ear.emit('demo /tmp/window_headmpd-integration.wav');
    expect(t.shell.demo?.running()).toBe(true);
    let frames = 0;
    while (t.shell.demo?.running()) {
      host.clock.advance(16);
      await new Promise((r) => setTimeout(r, 0));                       // let the tour's awaits run before the next frame
      if (++frames > 6000) throw new Error('the tour did not finish in 96 s of manual time');
    }

    // The recorder brackets the tour, and the driver's own log says it ran to the end.
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(recorder.stop).toHaveBeenCalledExactlyOnceWith('/tmp/window_headmpd-integration.wav');
    expect(lines.filter((l) => /^demo: (started|wrote|done|aborted)/.test(l))).toEqual([
      'demo: started', 'demo: wrote /tmp/window_headmpd-integration.wav', 'demo: done',
    ]);
    expect(lines.some((l) => /^demo: play at 1\.\d+s$/.test(l))).toBe(true);
    expect(t.host.recorded.logs.filter((l) => l.level === 'warn' && /demo/.test(l.message))).toEqual([]);
    expect(t.host.recorded.faults).toEqual([]);
    expect(view.health).toEqual({ soft: 0, hard: 0, unloaded: false });

    // The transport: the legacy run's mpd verbs, play, pause, seekcur 0 (the stage), then the Play click.
    expect(host.media.calls.map((/** @type {any} */ c) => [c.method, ...c.args])).toEqual([['play'], ['pause'], ['seek', 0], ['play']]);

    // The five band drags end where the legacy run's did, and the reset link puts the bands back.
    const smile = [10, 8, 0, 0, -5, 0, 0, 0, 6, 9];
    const sent = /** @type {number[][]} */ (host.dsp.sent.eq);
    const full = sent.find((v) => Math.abs(v[9] - 9) < 1e-9);
    expect(full, 'a set_eq vector with the ninth drag done').toBeDefined();
    smile.forEach((db, i) => expect(/** @type {number[]} */ (full)[i]).toBeCloseTo(db, 6));
    expect(sent.at(-1)).toEqual(Array(10).fill(0));
    expect(host.dsp.eq.gains()).toEqual(Array(10).fill(0));

    // Five clicks on the chooser's next arrow, one per preset; the seed starts on the stage's own preset
    // ('Chorus'), so the stage steps nothing and five steps wrap the five-title test list back to it.
    expect(presetSteps).toBe(5);
    expect(effects.title).toBe('Chorus');

    // Drawers: the tour opens the playlist and the equalizer, the way the legacy one did, and the shell saved them.
    expect(view.inspector.readGlobal('plIsOpen')).toBe(true);
    expect(view.inspector.readGlobal('eqIsOpen')).toBe(true);
    expect(t.host.prefs.peek('app').get('plOpen')).toBe('true');
    expect(t.host.prefs.peek('app').get('eqOpen')).toBe('true');

    // The driver cleaned up after itself.
    expect(document.body.classList.contains('demo')).toBe(false);
    expect(view.inspector.root().querySelector('img')).toBeNull();
    expect(t.shell.demo?.running()).toBe(false);
  }, 120_000);

  it('the saved drawers come back after onload, and a close on the way out is saved again', async () => {
    const t = await headspaceLaunch({ seed: { app: { eqOpen: 'true', plOpen: 'true' }, mediacenter: { effectPreset: '1' } } });
    const view = /** @type {any} */ (t.shell.view());
    t.host.clock.advance(1500);
    await view.settled();
    expect(view.inspector.readGlobal('eqIsOpen')).toBe(true);
    expect(view.inspector.readGlobal('plIsOpen')).toBe(true);
    view.inspector.callGlobal('ToggleEqView');
    t.host.clock.advance(600);                                          // the frame clock's check catches a close no pointer made
    await view.settled();
    expect(t.host.prefs.peek('app').get('eqOpen')).toBe('false');
    expect(t.host.prefs.peek('app').get('plOpen')).toBe('true');
  });
});
