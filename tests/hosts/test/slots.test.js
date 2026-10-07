// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../src/hosts/test/index.js';
import { createMemoryPrefs } from '../../../src/hosts/test/prefs.js';
import { EFFECTS_PREF, EFFECTS_TITLES, createEffectsControl, createTestSlotProvider } from '../../../src/hosts/test/slots.js';
import { createTestSkinWindow } from '../../../src/hosts/test/window.js';
import { createFakeMedia } from '../../../src/hosts/test/media.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

const rect = { x: 270, y: 59, w: 216, h: 158 };
const effectsSpec = (r = rect) => ({ kind: 'effects', attrs: new Map(), rect: r });
const win = () => createTestSkinWindow();

describe('the effects preset titles', () => {
  it('are the five of the pinned viz, in its order (a drift test against src/viz and the skinlab stub)', () => {
    const index = readFileSync(path.join(REPO, 'src/viz/index.js'), 'utf8');
    const order = /presets = \[([^\]]+)\]\.map/.exec(index)[1].split(',').map((s) => s.trim());
    const files = new Map([...index.matchAll(/import \{ (\w+) \} from '\.\/([\w-]+\.js)'/g)].map((m) => [m[1], m[2]]));
    const titles = order.map((cls) => /title = '([^']+)'/.exec(readFileSync(path.join(REPO, 'src/viz', files.get(cls)), 'utf8'))[1]);
    expect(titles).toEqual([...EFFECTS_TITLES]);
    const stub = readFileSync(path.join(REPO, 'tools/skinlab/viz-stub.js'), 'utf8');
    const stubTitles = [...(/const TITLES = \[([^\]]+)\]/.exec(stub)[1].matchAll(/'([^']+)'/g))].map((m) => m[1]);
    expect(stubTitles).toEqual([...EFFECTS_TITLES]);
  });
});

describe('createEffectsControl', () => {
  it('starts at an index, exposes the title and count, and wraps both ways', () => {
    const c = createEffectsControl({ index: 1 });
    expect([c.count, c.index, c.title]).toEqual([5, 1, 'Chorus']);
    c.step(-1);
    c.step(-1);
    expect(c.index).toBe(4);
    c.step(1);
    expect(c.index).toBe(0);
    c.setIndex(7);
    expect(c.index).toBe(2);
    c.setIndex(-1);
    expect(c.index).toBe(4);
  });

  it('ignores a setIndex that is not a number, and notifies only on a real change', () => {
    const c = createEffectsControl({ index: 2 });
    let n = 0;
    const off = c.onChange(() => n++);
    c.setIndex(NaN);
    c.setIndex(/** @type {any} */ ('3'));
    c.setIndex(2);
    c.setIndex(7); // wraps to 2: no change
    expect(n).toBe(0);
    c.setIndex(3);
    c.click();
    expect([c.index, n]).toEqual([4, 2]);
    off();
    c.step(1);
    expect(n).toBe(2);
  });

  it('titleOf is the title of a valid preset and an empty string otherwise', () => {
    const c = createEffectsControl();
    expect(c.titleOf(2)).toBe('Bars and Waves: Ring');
    for (const bad of [-1, 5, 1.5, NaN]) expect(c.titleOf(bad), String(bad)).toBe('');
  });

  it('persists user changes through the callback, and external ones without it', () => {
    const saved = [];
    const c = createEffectsControl({ persist: (i) => saved.push(i) });
    c.step(1);
    c.click();
    c.setIndex(0);
    c.applyExternal(3);
    expect(saved).toEqual([1, 2, 0]);
    expect(c.index).toBe(3);
  });

  it('takes its own titles, and needs at least one', () => {
    const c = createEffectsControl({ titles: ['a', 'b'], index: 5 });
    expect([c.count, c.index, c.title]).toEqual([2, 1, 'b']);
    expect(() => createEffectsControl({ titles: [] })).toThrow(/at least one preset/);
  });
});

describe('the effects slot', () => {
  const mount = (opts, el = document.createElement('div'), spec = effectsSpec()) => {
    const provider = createTestSlotProvider(opts);
    return { provider, el, handle: provider.mount(el, spec, win()) };
  };

  it('reads its starting preset from mediacenter.effectPreset, so a seeded 1 reads "Chorus"', () => {
    const prefs = createMemoryPrefs();
    prefs.seed(EFFECTS_PREF.ns, { effectPreset: '1' });
    expect(mount({ prefs }).handle.effects.title).toBe('Chorus');
    expect(mount({ prefs: createMemoryPrefs() }).handle.effects.index).toBe(0);
    for (const [stored, expected] of [['7', 2], ['-1', 4], ['junk', 0], ['', 0]]) {
      prefs.seed(EFFECTS_PREF.ns, { effectPreset: stored });
      expect(mount({ prefs }).handle.effects.index, JSON.stringify(stored)).toBe(expected);
    }
    expect(mount({}).handle.effects.index).toBe(0); // no prefs at all
  });

  it('writes a user change back to mediacenter.effectPreset', () => {
    const prefs = createMemoryPrefs();
    const { handle } = mount({ prefs });
    handle.effects.step(1);
    expect(prefs.peek(EFFECTS_PREF.ns).get(EFFECTS_PREF.key)).toBe('1');
    handle.effects.click();
    expect(prefs.peek(EFFECTS_PREF.ns).get(EFFECTS_PREF.key)).toBe('2');
    expect(prefs.writes.map((w) => w.value)).toEqual(['1', '2']);
  });

  it('follows the pref when another window changes it, without writing it back, and stops on dispose', () => {
    const prefs = createMemoryPrefs();
    const { handle } = mount({ prefs });
    let n = 0;
    handle.effects.onChange(() => n++);
    prefs.external(EFFECTS_PREF.ns, EFFECTS_PREF.key, '3');
    expect(handle.effects.index).toBe(3);
    expect(prefs.writes).toEqual([]);
    prefs.external(EFFECTS_PREF.ns, 'somethingElse', '1');
    prefs.external(EFFECTS_PREF.ns, EFFECTS_PREF.key, null); // removed: back to the first preset
    expect(handle.effects.index).toBe(0);
    expect(n).toBe(2);
    handle.dispose();
    prefs.external(EFFECTS_PREF.ns, EFFECTS_PREF.key, '2');
    expect(handle.effects.index).toBe(0);
  });

  it('is a black canvas of the slot size inside the element, resized with the spec', () => {
    const { el, handle } = mount({});
    const canvas = el.querySelector('canvas');
    expect([canvas.width, canvas.height]).toEqual([216, 158]);
    expect(handle.element).toBe(el);
    handle.update(effectsSpec({ x: 0, y: 0, w: 100, h: 50 }));
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
    handle.setVisible(false);
    expect(canvas.style.visibility).toBe('hidden');
    handle.setVisible(true);
    expect(canvas.style.visibility).toBe('visible');
  });

  it('claims its rect for the window shape while it is visible (the oracle counts the effects canvas as solid)', () => {
    const { handle } = mount({});
    expect(handle.hitRects()).toEqual([rect]);
    expect(handle.hitRects()[0]).not.toBe(rect); // a copy
    let changes = 0;
    const off = handle.onHitRectsChange(() => changes++);
    handle.update(effectsSpec({ x: 1, y: 2, w: 3, h: 4 }));
    expect(handle.hitRects()).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
    handle.setVisible(false);
    expect(handle.hitRects()).toEqual([]);
    handle.setVisible(false); // no change, no notice
    expect(changes).toBe(2);
    off();
    handle.setVisible(true);
    expect(changes).toBe(2);
  });

  it('removes its canvas on dispose and goes quiet', () => {
    const { el, handle, provider } = mount({});
    expect(el.querySelector('canvas')).not.toBeNull();
    handle.dispose();
    handle.dispose();
    expect(el.querySelector('canvas')).toBeNull();
    expect(handle.hitRects()).toEqual([]);
    handle.update(effectsSpec({ x: 0, y: 0, w: 9, h: 9 }));
    expect(handle.hitRects()).toEqual([]);
    expect(provider.mounted[0]).toMatchObject({ kind: 'effects', disposed: true });
  });

  it('works headless: a plain object for an element, no document, no canvas', () => {
    const el = /** @type {any} */ ({});
    const { handle } = mount({}, el);
    expect(handle.element).toBe(el);
    expect(handle.effects.title).toBe(EFFECTS_TITLES[0]);
    expect(handle.hitRects()).toEqual([rect]);
  });

  it('takes its own titles', () => {
    expect(mount({ titles: ['only'] }).handle.effects).toMatchObject({ count: 1, title: 'only' });
  });
});

describe('the playlist slot', () => {
  const playlistSpec = { kind: 'playlist', attrs: new Map([['columnsvisible', true]]), rect: { x: 503, y: 98, w: 168, h: 136 } };

  it('is a blank placeholder that claims its rect until a widget is injected', () => {
    const provider = createTestSlotProvider({ media: createFakeMedia('stoppedQueue5') });
    const el = document.createElement('div');
    const handle = provider.mount(el, playlistSpec, win());
    expect(handle.element).toBe(el);
    expect(el.childNodes).toHaveLength(0);
    expect(handle.effects).toBeUndefined();
    expect(handle.hitRects()).toEqual([playlistSpec.rect]);
  });

  it('calls the injected factory with the element, the media model, the attributes and the window, and hands back its handle', () => {
    const media = createFakeMedia('stoppedQueue5');
    const calls = [];
    const made = {
      element: null,
      update() {},
      setVisible() {},
      hitRects: () => [{ x: 1, y: 1, w: 1, h: 1 }],
      onHitRectsChange: () => () => {},
      dispose() { calls.push('disposed'); },
    };
    const provider = createTestSlotProvider({ media, playlist: (...args) => { calls.push(args); return made; } });
    const el = document.createElement('div');
    const w = win();
    const handle = provider.mount(el, playlistSpec, w);
    const [gotEl, gotMedia, gotAttrs, gotWin] = calls[0];
    expect([gotEl, gotMedia, gotAttrs, gotWin]).toEqual([el, media, playlistSpec.attrs, w]);
    expect(gotMedia).toBe(media);
    expect(handle.hitRects()).toEqual([{ x: 1, y: 1, w: 1, h: 1 }]);
    handle.dispose();
    expect(calls[1]).toBe('disposed');
    expect(provider.mounted[0]).toMatchObject({ kind: 'playlist', disposed: true });
  });

  it('needs a media model to mount a playlist', () => {
    expect(() => createTestSlotProvider().mount(document.createElement('div'), playlistSpec, win())).toThrow(/needs `media`/);
  });

  it('is wired through createTestHost: the injected factory arrives with the host\'s own media', () => {
    let got;
    const host = createTestHost({ media: 'stoppedQueue5', slots: { playlist: (el, media, attrs, w) => { got = { media, w }; return createTestSlotProvider().mount(el, { ...playlistSpec, kind: 'video' }, w); } } });
    host.slots.mount(document.createElement('div'), playlistSpec, host.window);
    expect(got.media).toBe(host.media);
    expect(got.w).toBe(host.window);
    expect(host.media.queue()).toHaveLength(5);
  });
});

describe('the video slot', () => {
  it('is inert: no canvas, no effects control, and its rect while visible', () => {
    const provider = createTestSlotProvider();
    const el = document.createElement('div');
    const spec = { kind: 'video', attrs: new Map(), rect: { x: 12, y: 11, w: 193, h: 135 } };
    const handle = provider.mount(el, spec, win());
    expect(el.childNodes).toHaveLength(0);
    expect(handle.effects).toBeUndefined();
    expect(handle.hitRects()).toEqual([spec.rect]);
  });
});

describe('createTestHost slots', () => {
  it('mounts the effects stub with the prefs the host was seeded with', () => {
    const host = createTestHost({ seed: { mediacenter: { effectPreset: '1' } } });
    const handle = host.slots.mount(document.createElement('div'), effectsSpec(), host.window);
    expect(handle.effects.title).toBe('Chorus');
    handle.effects.step(1);
    expect(host.prefs.peek('mediacenter').get('effectPreset')).toBe('2');
    expect(host.slots.mounted).toHaveLength(1);
  });
});
