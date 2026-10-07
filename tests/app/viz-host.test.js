// @vitest-environment happy-dom
// VizHost, the effects slot (ENGINE.md D10.2), and the app's SlotProvider that composes it with the
// playlist widget and the overlays (src/app/slots.js). `Viz` is a fake class with the pinned class's
// public surface (presets, index, current, step, setPalette, renderer, the constructor's synchronous
// onPresetChange call); the real one needs WebGL and three.js. Media, prefs and the window are the test
// host's primitives, the palette is either a hand-made service or the real PaletteService over a fake
// `invoke`, so the stale-reply guard is exercised where it lives.
//
// Rule 6: nothing here is keyed by a skin string. Preset titles are looked up by index; the cases with
// `__proto__` and `constructor` check that no index or key from outside can reach an inherited member.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../src/hosts/test/clock.js';
import { createFakeMedia, presetQueue } from '../../src/hosts/test/media.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';
import { createEffectsControl, EFFECTS_TITLES } from '../../src/hosts/test/slots.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';
import { createPaletteService, DEFAULT_SNAPSHOT } from '../../src/app/palette/service.js';
import { createOverlays } from '../../src/app/overlays.js';
import { createSlotProvider } from '../../src/app/slots.js';
import { createVizHost, EFFECT_PREF } from '../../src/app/viz-host.js';

const TITLES = Object.freeze(['Headspace: Point Cloud', 'Chorus', 'Bars and Waves: Ring', 'Ambience: Warp', 'Scope: Ribbon']);
const RECT = { x: 270, y: 59, w: 216, h: 158 };
const SPEC = { kind: /** @type {const} */ ('effects'), attrs: new Map(), rect: RECT };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A stand-in for src/viz/index.js's `Viz`: same public surface, records what the host does to it. */
function fakeVizClass(opts = {}) {
  /** @type {any[]} */ const made = [];
  class FakeViz {
    presets = TITLES.map((title) => ({ title }));
    index = opts.startIndex ?? 0;                           // what the legacy localStorage.preset gave it
    steps = [];
    palettes = [];
    feed = () => 'real feed';
    renderer = {
      ratios: [], sizes: [], loop: undefined, disposed: 0, lost: 0,
      setPixelRatio(r) { this.ratios.push(r); },
      setSize(w, h, updateStyle) { this.sizes.push([w, h, updateStyle]); },
      setAnimationLoop(cb) { this.loop = cb; },
      dispose() { this.disposed++; },
      forceContextLoss() { this.lost++; },
    };
    constructor(canvas, onPresetChange, captionEl) {
      if (opts.throws) throw new Error('WebGL is not available');
      this.canvas = canvas;
      this.onPresetChange = onPresetChange;
      this.captionEl = captionEl;
      made.push(this);
      onPresetChange(this.current.title);                   // synchronously, like the real constructor
    }
    get current() { return this.presets[this.index]; }
    step(dir) {
      this.steps.push(dir);
      this.index = (this.index + dir + this.presets.length) % this.presets.length;
      this.onPresetChange(this.current.title);
    }
    setPalette(swatches) { this.palettes.push(swatches); }
  }
  return { FakeViz, made };
}

/** A hand-made PaletteService whose snapshot the test sets. */
function fakePalette(initial = DEFAULT_SNAPSHOT) {
  let snap = initial;
  const subs = new Set();
  return {
    snapshot: () => snap,
    subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    lerp: (a) => a,
    set(next) { snap = next; for (const cb of [...subs]) cb(next); },
    subscribers: () => subs.size,
  };
}

/** A window whose zoom the test can change. */
function zoomableWindow(root, zoom = 1) {
  const win = createTestSkinWindow({ root, zoom });
  const listeners = new Set();
  return Object.assign(win, {
    zoom,
    onZoom(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    setTo(z) { win.zoom = z; for (const cb of [...listeners]) cb(z); },
    listeners: () => listeners.size,
  });
}

/** An effects slot, mounted. */
function setup(o = {}) {
  const host = document.createElement('div');
  const slot = document.createElement('div');
  host.appendChild(slot);
  document.body.appendChild(host);
  const clock = createManualClock();
  const media = createFakeMedia(o.preset ?? 'stoppedQueue5', { clock });
  const prefs = createMemoryPrefs();
  if (o.seed) prefs.seed('mediacenter', o.seed);
  const palette = o.palette ?? fakePalette();
  const { FakeViz, made } = fakeVizClass(o);
  const overlays = createOverlays({ media, timers: { setTimer: (ms, cb) => clock.setTimer(ms, cb), clearTimer: (id) => clock.clearTimer(id) } });
  const win = zoomableWindow(host, o.zoom ?? 1);
  const vizHost = createVizHost({ prefs, palette, overlays, mediacenterPrefs: o.mediacenterPrefs, Viz: FakeViz });
  const handle = vizHost.mount(slot, SPEC, win);
  return { host, slot, clock, media, prefs, palette, overlays, win, handle, viz: made[0], made };
}

const writes = (t) => t.prefs.writes.filter((w) => w.ns === EFFECT_PREF.ns && w.key === EFFECT_PREF.key).map((w) => w.value);

describe('mounting', () => {
  it('puts a canvas of the slot\'s size in a wrapper, and the caption into the Viz', () => {
    const t = setup();
    const root = t.slot.querySelector('.wh-fx');
    expect(root).not.toBeNull();
    expect(t.viz.canvas).toBe(root.querySelector('canvas.wh-fx-viz'));
    expect([root.style.width, root.style.height]).toEqual(['216px', '158px']);
    expect([t.viz.canvas.style.width, t.viz.canvas.style.height]).toEqual(['216px', '158px']);
    expect(t.viz.captionEl).toBe(root.querySelector('.wh-caption'));
    expect([...root.children].map((c) => c.className)).toEqual(['wh-fx-viz', 'wh-toast', 'wh-notice', 'wh-caption hidden']);
    expect(t.handle.element).toBe(t.slot);
    expect(t.handle.hitRects()).toEqual([RECT]);
  });

  it('does not treat the constructor\'s own preset report as a change', () => {
    const t = setup({ startIndex: 2 });
    expect(t.prefs.writes).toEqual([]);
    expect(t.handle.effects.index).toBe(2);
  });

  it('survives a Viz that cannot start: no effects control, overlays still there', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({ throws: true });
    expect(err).toHaveBeenCalled();
    expect(t.handle.effects).toBeUndefined();
    expect(t.slot.querySelector('.wh-notice')).not.toBeNull();
    expect(t.handle.hitRects()).toEqual([RECT]);
    t.handle.update({ ...SPEC, rect: { ...RECT, w: 100 } });
    t.handle.dispose();
  });

  it('needs the Viz class', () => {
    const media = createFakeMedia('stoppedEmpty');
    const overlays = createOverlays({ media });
    expect(() => createVizHost({ prefs: createMemoryPrefs(), palette: fakePalette(), overlays })).toThrow(TypeError);
    overlays.dispose();
  });
});

describe('EffectsControl', () => {
  it('reports the presets of the Viz', () => {
    const t = setup();
    const fx = t.handle.effects;
    expect([fx.count, fx.index, fx.title]).toEqual([5, 0, TITLES[0]]);
    expect(TITLES.map((_, i) => fx.titleOf(i))).toEqual(TITLES);
  });

  it('answers no title for an index that is not a preset, whatever it is', () => {
    const fx = setup().handle.effects;
    for (const bad of [-1, 5, 1.5, NaN, Infinity, '1', '__proto__', 'constructor', null, undefined, {}, [], 'length']) {
      expect(fx.titleOf(bad), String(bad)).toBe('');
    }
  });

  it('steps over five presets, wraps, and persists each to mediacenter.effectPreset', () => {
    const t = setup();
    const fx = t.handle.effects;
    for (let i = 0; i < 5; i++) fx.step(1);
    expect(fx.index).toBe(0);
    expect(writes(t)).toEqual(['1', '2', '3', '4', '0']);
    expect(t.prefs.writes.every((w) => w.ns === 'mediacenter' && w.key === 'effectPreset')).toBe(true);
    fx.step(-1);
    expect([fx.index, fx.title]).toEqual([4, TITLES[4]]);
    expect(writes(t).at(-1)).toBe('4');
    expect(t.viz.steps).toEqual([1, 1, 1, 1, 1, -1]);
  });

  it('click() is a step to the next preset (D10.2)', () => {
    const t = setup();
    t.handle.effects.click();
    expect(t.handle.effects.index).toBe(1);
    expect(writes(t)).toEqual(['1']);
  });

  it('tells its listeners once per change, and stops after unsubscribe', () => {
    const t = setup();
    const fx = t.handle.effects;
    let n = 0;
    const off = fx.onChange(() => { n++; });
    fx.step(1);
    fx.setIndex(4);
    expect(n).toBe(2);
    off();
    fx.step(1);
    expect(n).toBe(2);
  });

  it('setIndex moves by the shorter way, once, and wraps', () => {
    const t = setup();
    const fx = t.handle.effects;
    let n = 0;
    fx.onChange(() => { n++; });
    fx.setIndex(3);                                         // 3 forward or 2 back
    expect([fx.index, t.viz.steps, n, writes(t)]).toEqual([3, [-1, -1], 1, ['3']]);
    fx.setIndex(3);
    expect([n, writes(t)]).toEqual([1, ['3']]);             // already there: nothing
    fx.setIndex(7);                                         // wraps to 2
    expect(fx.index).toBe(2);
    fx.setIndex(NaN);
    fx.setIndex(/** @type {any} */ ('1'));
    expect(fx.index).toBe(2);
    expect(writes(t)).toEqual(['3', '2']);
  });

  it('persists and announces a step made on the Viz directly (the shell\'s V key)', () => {
    const t = setup();
    let n = 0;
    t.handle.effects.onChange(() => { n++; });
    t.viz.step(1);
    expect(writes(t)).toEqual(['1']);
    expect(n).toBe(1);
  });

  it('behaves like the test host\'s stub control, which skinlab shows in its place', () => {
    const t = setup();
    const stub = createEffectsControl({ titles: EFFECTS_TITLES });
    const ops = [['step', 1], ['step', 1], ['step', -1], ['setIndex', 4], ['click'], ['setIndex', -1], ['step', -1], ['setIndex', 12]];
    for (const [op, arg] of ops) {
      t.handle.effects[op](arg);
      stub[op](arg);
      expect([t.handle.effects.index, t.handle.effects.title]).toEqual([stub.index, stub.title]);
    }
    expect([t.handle.effects.count, TITLES]).toEqual([stub.count, [...EFFECTS_TITLES]]);
  });
});

describe('the stored preset', () => {
  it('starts on the preset from the loaded mediacenter namespace, without writing it back', () => {
    const t = setup({ mediacenterPrefs: new Map([['effectPreset', '3']]), startIndex: 1 });
    expect(t.viz.index).toBe(3);
    expect(t.prefs.writes).toEqual([]);
    expect(t.handle.effects.title).toBe(TITLES[3]);
  });

  it('keeps the Viz\'s own index when nothing usable is stored', () => {
    for (const stored of [undefined, 'abc', '', '1.5', '99999999999', '-']) {
      const m = new Map(stored === undefined ? [] : [['effectPreset', stored]]);
      expect(setup({ mediacenterPrefs: m, startIndex: 2 }).viz.index, String(stored)).toBe(2);
    }
  });

  it('wraps a stored index that is out of range', () => {
    expect(setup({ mediacenterPrefs: new Map([['effectPreset', '7']]) }).viz.index).toBe(2);
    expect(setup({ mediacenterPrefs: new Map([['effectPreset', '-1']]) }).viz.index).toBe(4);
  });

  it('loads the namespace itself when it was not handed over, and applies it when it arrives', async () => {
    const t = setup({ seed: { effectPreset: '4' } });
    expect(t.viz.index).toBe(0);
    await flush();
    expect(t.viz.index).toBe(4);
    expect(t.prefs.writes).toEqual([]);
  });

  it('does not override a preset the user moved while the namespace was loading', async () => {
    const t = setup({ seed: { effectPreset: '4' } });
    t.handle.effects.step(1);
    await flush();
    expect(t.viz.index).toBe(1);
  });

  it('follows another window\'s change without writing it back, and ignores other keys', () => {
    const t = setup();
    let n = 0;
    t.handle.effects.onChange(() => { n++; });
    t.prefs.external('mediacenter', 'effectPreset', '2');
    expect([t.viz.index, n, t.prefs.writes]).toEqual([2, 1, []]);
    t.prefs.external('mediacenter', 'videoZoom', '3');
    t.prefs.external('mediacenter', 'effectPreset', null);
    t.prefs.external('mediacenter', 'effectPreset', 'junk');
    t.prefs.external('mediacenter', 'effectPreset', '2');
    expect([t.viz.index, n]).toEqual([2, 1]);
    t.prefs.external('other-ns', 'effectPreset', '4');
    expect(t.viz.index).toBe(2);
  });
});

describe('zoom and size', () => {
  it('sets the pixel ratio from devicePixelRatio and the zoom, now and on every zoom change', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true, writable: true });
    try {
      const t = setup({ zoom: 1 });
      expect(t.viz.renderer.ratios).toEqual([2]);
      expect(t.viz.renderer.sizes).toEqual([[216, 158, false]]);
      t.win.setTo(1.5);
      expect(t.viz.renderer.ratios).toEqual([2, 3]);
      expect(t.viz.renderer.sizes).toEqual([[216, 158, false], [216, 158, false]]);
    } finally {
      if (real) Object.defineProperty(window, 'devicePixelRatio', real);
      else delete window.devicePixelRatio;
    }
  });

  it('follows the slot\'s rect, not fixed numbers', () => {
    const t = setup();
    let fired = 0;
    t.handle.onHitRectsChange(() => { fired++; });
    t.handle.update({ ...SPEC, rect: { x: 5, y: 6, w: 100, h: 80 } });
    expect(fired).toBe(1);
    expect(t.handle.hitRects()).toEqual([{ x: 5, y: 6, w: 100, h: 80 }]);
    expect(t.viz.canvas.style.width).toBe('100px');
    expect(t.viz.renderer.sizes.at(-1)).toEqual([100, 80, false]);
  });

  it('reports nothing while hidden, and says so when it changes', () => {
    const t = setup();
    let fired = 0;
    t.handle.onHitRectsChange(() => { fired++; });
    t.handle.setVisible(false);
    expect([t.handle.hitRects(), fired, t.slot.querySelector('.wh-fx').hidden]).toEqual([[], 1, true]);
    t.handle.setVisible(false);
    expect(fired).toBe(1);
    t.handle.setVisible(true);
    expect([t.handle.hitRects(), fired]).toEqual([[RECT], 2]);
  });
});

describe('palette', () => {
  const LOCAL = Object.freeze({
    source: 'local', association: 'current-uri', track: { uri: 'a.flac', generatedAt: 'x' }, roles: null, guarantees: [],
    clusters: [{ hex: '#102030', oklch: [0.2, 0.05, 250], share: 0.6 }, { hex: '#c04030', oklch: [0.5, 0.15, 30], share: 0.4 }],
  });

  it('applies the current palette, then each one as it lands: default is null, a cover is its clusters', () => {
    const palette = fakePalette();
    const t = setup({ palette });
    expect(t.viz.palettes).toEqual([null]);
    palette.set(LOCAL);
    expect(t.viz.palettes.at(-1)).toBe(LOCAL.clusters);
    palette.set({ ...LOCAL, clusters: [] });
    expect(t.viz.palettes.at(-1)).toBeNull();
    palette.set(LOCAL);
    palette.set(DEFAULT_SNAPSHOT);
    expect(t.viz.palettes.at(-1)).toBeNull();
    expect(t.viz.palettes).toHaveLength(5);
  });

  it('starts on a palette that is already there', () => {
    const t = setup({ palette: fakePalette(LOCAL) });
    expect(t.viz.palettes).toEqual([LOCAL.clusters]);
  });

  it('shows the palette of the song that is current: a late reply for an older song is never applied', async () => {
    const clock = createManualClock();
    const media = createFakeMedia('stoppedQueue5', { clock });
    const pending = new Map();
    const invoke = (cmd, args) => new Promise((resolve, reject) => pending.set(args.file, { resolve, reject }));
    const palette = createPaletteService(media, invoke);
    const [a, b] = presetQueue('stoppedQueue5');
    const t = setup({ palette });
    media.emit({ song: a });
    media.emit({ song: b });
    const reply = (hex) => [{ hex, share: 1, oklch: [0.5, 0.1, 100] }];
    pending.get(b.file).resolve(reply('#00ff00'));
    await flush();
    pending.get(a.file).resolve(reply('#ff0000'));         // slow, and for a song that is gone
    await flush();
    const applied = t.viz.palettes.filter(Boolean).map((p) => p[0].hex);
    expect(applied).toEqual(['#00ff00']);
    expect(palette.snapshot().clusters[0].hex).toBe('#00ff00');
    media.emit({ song: null });
    expect(t.viz.palettes.at(-1)).toBeNull();               // no song: the preset's own colours
    palette.dispose();
  });
});

describe('dispose', () => {
  it('stops the Viz, drops every subscription and removes its DOM', () => {
    const palette = fakePalette();
    const t = setup({ palette });
    const fx = t.handle.effects;
    let n = 0;
    fx.onChange(() => { n++; });
    expect(palette.subscribers()).toBe(1);
    expect(t.win.listeners()).toBe(1);
    t.handle.dispose();
    expect(t.viz.renderer.loop).toBeNull();
    expect([t.viz.renderer.disposed, t.viz.renderer.lost]).toEqual([1, 1]);
    expect(t.viz.feed()).toBeUndefined();                   // the frame channel now feeds nothing
    expect([palette.subscribers(), t.win.listeners()]).toEqual([0, 0]);
    expect(t.slot.children).toHaveLength(0);
    expect(t.handle.hitRects()).toEqual([]);
    // late events change nothing
    t.prefs.external('mediacenter', 'effectPreset', '3');
    palette.set({ ...DEFAULT_SNAPSHOT, source: 'local', clusters: [{ hex: '#111111', oklch: [0, 0, 0], share: 1 }] });
    t.win.setTo(2);
    t.viz.step(1);
    expect([t.viz.index, n, t.prefs.writes]).toEqual([1, 0, []]);
    expect(t.viz.palettes).toHaveLength(1);
    t.handle.dispose();
    t.handle.update(SPEC);
    t.handle.setVisible(false);
  });
});

// ---- the SlotProvider ------------------------------------------------------------------------------------

describe('createSlotProvider', () => {
  function provider(o = {}) {
    const clock = createManualClock();
    const media = createFakeMedia(o.preset ?? 'stoppedQueue5', { clock });
    const prefs = createMemoryPrefs();
    const { FakeViz, made } = fakeVizClass();
    const invokeCalls = [];
    const invoke = async (cmd) => { invokeCalls.push(cmd); return { error: o.engineError ?? null }; };
    const slots = createSlotProvider({
      media, prefs, palette: fakePalette(), invoke, Viz: FakeViz,
      timers: { setTimer: (ms, cb) => clock.setTimer(ms, cb), clearTimer: (id) => clock.clearTimer(id) },
      noticeColor: o.noticeColor,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const win = zoomableWindow(host);
    const mount = (kind, rect = RECT, attrs = new Map()) => {
      const el = document.createElement('div');
      host.appendChild(el);
      return { el, handle: slots.mount(el, { kind, attrs, rect }, win) };
    };
    return { slots, media, prefs, made, invokeCalls, host, win, mount, clock };
  }

  it('mounts the visualizer for an effects slot, with its control', () => {
    const p = provider();
    const { el, handle } = p.mount('effects');
    expect(el.querySelector('.wh-fx canvas')).not.toBeNull();
    expect(handle.effects.count).toBe(5);
    expect(p.made).toHaveLength(1);
    handle.dispose();
    p.slots.dispose();
  });

  it('mounts the playlist widget for a playlist slot, with its rect from the spec', () => {
    const p = provider();
    const rect = { x: 503, y: 98, w: 172, h: 140 };
    const { el, handle } = p.mount('playlist', rect, new Map([['backgroundColor', 0x285f03]]));
    expect(el.querySelectorAll('.wh-pl-row')).toHaveLength(5);
    expect(el.querySelector('.wh-pl').style.getPropertyValue('--wh-pl-bg')).toBe('#285f03');
    expect(handle.hitRects()).toEqual([rect]);
    expect(handle.effects).toBeUndefined();
    handle.dispose();
  });

  it('keeps a video slot inert but in the window shape', () => {
    const p = provider();
    const { el, handle } = p.mount('video', { x: 1, y: 2, w: 30, h: 40 });
    expect(el.children).toHaveLength(0);
    expect(handle.hitRects()).toEqual([{ x: 1, y: 2, w: 30, h: 40 }]);
    let fired = 0;
    handle.onHitRectsChange(() => { fired++; });
    handle.update({ kind: 'video', attrs: new Map(), rect: { x: 0, y: 0, w: 5, h: 5 } });
    handle.setVisible(false);
    expect([fired, handle.hitRects()]).toEqual([2, []]);
    handle.dispose();
    expect(() => handle.update({ kind: 'video', attrs: new Map(), rect: RECT })).not.toThrow();
  });

  it('owns the notice the window menu shows when there is no effects slot', async () => {
    const p = provider({ engineError: 'no audio route' });
    await flush();
    expect(p.invokeCalls).toEqual(['engine_info']);
    expect(p.slots.notice.text()).toBe('no audio route');
    p.media.set({ connected: false });
    expect(p.slots.notice.text()).toBe('Waiting for MPD…');
    p.slots.dispose();
    p.media.set({ connected: true });
    await flush();
    expect(p.slots.notice.text()).toBe('Waiting for MPD…');   // disposed: no longer updated
  });

  it('reads the notice colour when the effects slot mounts', () => {
    let colour = null;
    const p = provider({ noticeColor: () => colour });
    colour = 0x336699;
    const { el } = p.mount('effects');
    expect(el.querySelector('.wh-notice').style.getPropertyValue('--wh-notice')).toBe('#336699');
  });
});
