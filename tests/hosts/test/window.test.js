// @vitest-environment happy-dom
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EFFECTS_TITLES, createTestHost } from '../../../src/hosts/test/index.js';
import { createTestSkinWindow } from '../../../src/hosts/test/window.js';
import { buildBmp } from '../../support/bmp-writer.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

const bitsShape = (width, height, fill = 0) => ({ kind: 'bits', width, height, bits: new Uint8Array((width * height + 7) >> 3).fill(fill) });

describe('TestSkinWindow', () => {
  it('records every setShape, as a copy the engine cannot change afterwards', () => {
    const win = createTestSkinWindow();
    expect(win.lastShape()).toBeNull();
    const shape = bitsShape(8, 4, 0b1010);
    win.setShape(shape);
    shape.bits.fill(0xff); // the engine reuses its buffer between frames
    win.setShape({ kind: 'regions', width: 8, height: 4, regions: [{ x: 1, y: 1, w: 2, h: 2, poly: [1, 1, 3, 1, 3, 3] }] });
    expect(win.recorded.shapes).toHaveLength(2);
    expect(win.recorded.shapes[0]).toMatchObject({ kind: 'bits', width: 8, height: 4 });
    expect(Array.from(win.recorded.shapes[0].bits)).toEqual(Array(4).fill(0b1010).slice(0, 4));
    expect(win.lastShape()).toEqual({ kind: 'regions', width: 8, height: 4, regions: [{ x: 1, y: 1, w: 2, h: 2, poly: [1, 1, 3, 1, 3, 3] }] });
    expect(win.recorded.calls.map((c) => c.method)).toEqual(['setShape', 'setShape']);
  });

  it('records setCapture and startDrag', () => {
    const win = createTestSkinWindow();
    win.setCapture(true);
    win.startDrag();
    win.startDrag();
    win.setCapture(false);
    expect(win.recorded.captures).toEqual([true, false]);
    expect(win.recorded.drags).toBe(2);
    expect(win.state.capturing).toBe(false);
    expect(win.recorded.calls.map((c) => c.method)).toEqual(['setCapture', 'startDrag', 'startDrag', 'setCapture']);
  });

  it('has a fixed zoom: setZoom is recorded and answered, but nothing changes and onZoom never fires', async () => {
    const win = createTestSkinWindow({ zoom: 1 });
    const seen = [];
    const off = win.onZoom((z) => seen.push(z));
    await win.setZoom(2);
    expect(win.zoom).toBe(1);
    expect(win.recorded.zoomRequests).toEqual([2]);
    expect(seen).toEqual([]);
    off();
    expect(createTestSkinWindow({ zoom: 2 }).zoom).toBe(2);
    for (const bad of [0, -1, NaN, Infinity, '2']) expect(() => createTestSkinWindow({ zoom: bad }), String(bad)).toThrow(/zoom must be a positive number/);
  });

  it('sizes the root element to the skin at the fixed zoom, unless asked not to', async () => {
    const root = document.createElement('div');
    const win = createTestSkinWindow({ root });
    expect(win.root).toBe(root);
    await win.setInitialSize(760, 394);
    expect([root.style.width, root.style.height]).toEqual(['760px', '394px']);
    expect(await win.bounds()).toEqual({ x: 0, y: 0, w: 760, h: 394 });

    const zoomed = document.createElement('div');
    const w2 = createTestSkinWindow({ root: zoomed, zoom: 2, position: { x: 30, y: 40 } });
    await w2.setInitialSize(100, 50);
    expect([zoomed.style.width, zoomed.style.height]).toEqual(['200px', '100px']);
    expect(await w2.bounds()).toEqual({ x: 30, y: 40, w: 200, h: 100 });

    const loose = document.createElement('div');
    await createTestSkinWindow({ root: loose, fitRoot: false }).setInitialSize(10, 10);
    expect(loose.style.width).toBe('');
  });

  it('refuses script resizes (phase 1) but records them', async () => {
    const win = createTestSkinWindow();
    expect(await win.requestSize(800, 600)).toBe(false);
    expect(win.recorded.sizeRequests).toEqual([{ w: 800, h: 600 }]);
    expect(await win.bounds()).toEqual({ x: 0, y: 0, w: 0, h: 0 }); // nothing was sized
  });

  it('answers the lifecycle calls at once and keeps their state; close fires onClose once', async () => {
    const win = createTestSkinWindow();
    let closed = 0;
    const off = win.onClose(() => closed++);
    await win.hide();
    expect(win.state.visible).toBe(false);
    await win.show();
    await win.minimize();
    await win.setAlwaysOnTop(true);
    await win.setVisibleOnAllWorkspaces(true);
    expect(win.state).toMatchObject({ visible: true, minimized: true, alwaysOnTop: true, onAllWorkspaces: true, closed: false });
    await win.close();
    await win.close();
    expect(closed).toBe(1);
    expect(win.state).toMatchObject({ closed: true, visible: false });
    off();
    const again = createTestSkinWindow();
    let n = 0;
    again.onClose(() => n++)();
    await again.close();
    expect(n).toBe(0);
  });

  it('has a key and a binding, and no root unless given one (headless)', () => {
    expect(createTestSkinWindow()).toMatchObject({ key: 'test/main', binding: 'native', root: null });
    expect(createTestSkinWindow({ key: 'abc/main', binding: 'cluster' })).toMatchObject({ key: 'abc/main', binding: 'cluster' });
  });
});

describe('createTestHost', () => {
  it('assembles a complete HostAdapter of kind test', () => {
    const host = createTestHost();
    expect(host.kind).toBe('test');
    for (const member of ['window', 'windows', 'clock', 'prefs', 'media', 'dsp', 'audio', 'palette', 'decode', 'slots', 'actions', 'log', 'recorded']) {
      expect(host[member], member).toBeTruthy();
    }
    expect(host.window.root).toBeNull();
    expect(host.media.preset).toBe('stoppedEmpty');
    expect(host.recorded.window).toBe(host.window.recorded);
  });

  it('runs headless under plain Node: no document, no window, nothing read from them', () => {
    const script = `
      if (typeof document !== 'undefined' || typeof window !== 'undefined') throw new Error('not headless');
      const { createTestHost } = await import(${JSON.stringify(path.join(REPO, 'src/hosts/test/index.js'))});
      const host = createTestHost({ media: 'stoppedQueue5' });
      const handle = host.slots.mount({}, { kind: 'effects', attrs: new Map(), rect: { x: 0, y: 0, w: 216, h: 158 } }, host.window);
      host.window.setShape({ kind: 'bits', width: 8, height: 1, bits: new Uint8Array(1) });
      host.clock.advance(100);
      console.log(JSON.stringify({ title: handle.effects.title, queue: host.media.queue().length, shapes: host.window.recorded.shapes.length, now: host.clock.now() }));
    `;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ title: EFFECTS_TITLES[0], queue: 5, shapes: 1, now: 100 });
  });

  it('shares one manual clock between the host and its media: elapsed moves only when the clock does', () => {
    const host = createTestHost({ media: 'playing' });
    expect(host.media.elapsed()).toBe(0);
    host.clock.advance(2000);
    expect(host.media.elapsed()).toBeCloseTo(2, 5);
    expect(host.clock.now()).toBe(2000);
    expect(createTestHost({ clock: { start: 500 } }).clock.now()).toBe(500);
  });

  it('seeds prefs namespaces before anything loads them, from records or entries, and applies caps', async () => {
    const host = createTestHost({
      seed: { mediacenter: { effectPreset: '1' }, app: new Map([['balance', '0']]), [`${'a'.repeat(64)}`]: [['k', 'v']] },
      prefs: { caps: { maxKeys: 2 } },
    });
    const media = await host.prefs.load('mediacenter');
    expect(media).toBeInstanceOf(Map);
    expect(media.get('effectPreset')).toBe('1');
    expect((await host.prefs.load('app')).get('balance')).toBe('0');
    expect((await host.prefs.load('a'.repeat(64))).get('k')).toBe('v');
    host.prefs.write('x', 'one', '1');
    host.prefs.write('x', 'two', '2');
    host.prefs.write('x', 'three', '3');
    expect(host.prefs.rejected.map((r) => r.reason)).toEqual(['key-count']);
  });

  it('starts the DSP where it is told', () => {
    const host = createTestHost({ dsp: { gains: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0], balance: 40 } });
    expect(host.dsp.eq.gains().slice(0, 3)).toEqual([1, 2, 3]);
    expect(host.dsp.balance.get()).toBe(40);
    expect(createTestHost().dsp.balance.get()).toBe(0);
  });

  it('records what the engine asks the host to do: actions, denials, faults, logs, diagnostics, windows', async () => {
    const host = createTestHost();
    host.actions.run('minimize', { viewId: 'main' });
    host.actions.denied('player.launchURL', 'http://example.invalid');
    host.actions.fault('boom');
    host.log.info('hello', { a: 1 });
    host.log.warn('careful');
    host.log.diag({ code: 'x', detail: 'y', severity: 'info' });
    expect(await host.windows.open('eq', { left: 1, top: 2, relative: true })).toBe(true);
    expect(host.windows.isOpen('eq')).toBe(true);
    await host.windows.close('eq');
    expect(host.windows.isOpen('eq')).toBe(false);
    expect(host.recorded).toMatchObject({
      actions: [{ action: 'minimize', ctx: { viewId: 'main' } }],
      denied: [{ api: 'player.launchURL', detail: 'http://example.invalid' }],
      faults: ['boom'],
      logs: [{ level: 'info', message: 'hello', data: { a: 1 } }, { level: 'warn', message: 'careful' }],
      diagnostics: [{ code: 'x' }],
      windows: [{ method: 'open', viewId: 'eq', at: { left: 1, top: 2, relative: true } }, { method: 'close', viewId: 'eq' }],
    });
  });

  it('delivers audio only when a test emits it, and strips pcm from subscribers that did not ask', () => {
    const host = createTestHost();
    const plain = [];
    const withPcm = [];
    expect(host.audio.subscribers()).toBe(0);
    const offPlain = host.audio.subscribe({}, (f) => plain.push(f));
    host.audio.subscribe({ pcm: true }, (f) => withPcm.push(f));
    expect(host.audio.wantsPcm()).toBe(true);
    expect(plain).toEqual([]); // silent by default
    const frame = { bands: new Float32Array(4), wave: new Float32Array(2), level: 0.5, pcm: new Uint8Array(3) };
    host.audio.emit(frame);
    expect(plain[0].pcm).toBeUndefined();
    expect(plain[0].level).toBe(0.5);
    expect(withPcm[0].pcm).toBe(frame.pcm);
    offPlain();
    host.audio.replay([frame, frame]);
    expect(plain).toHaveLength(1);
    expect(withPcm).toHaveLength(3);
  });

  it('answers palette reads with the default tier, and lets a test replace it', () => {
    const host = createTestHost();
    expect(host.palette.snapshot()).toMatchObject({ source: 'default', association: 'default', roles: null, guarantees: [], clusters: [] });
    const seen = [];
    host.palette.subscribe((s) => seen.push(s.source));
    host.palette.set({ ...host.palette.snapshot(), source: 'local' });
    expect(seen).toEqual(['local']);
    expect(host.palette.lerp('#000000', '#ffffff', 0)).toBe('#000000');
    expect(host.palette.lerp('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(host.palette.lerp('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(host.palette.lerp('red', '#ffffff', 0.5)).toBe('red'); // not a hex colour: the first one back
  });

  describe('the inline decode executor', () => {
    const MAGENTA = [255, 0, 255, 255];
    const px = (w, h, fn) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set(fn(i), i * 4);
      return buildBmp({ width: w, height: h, bpp: 24, rgba });
    };

    it('decodes and keys a BMP with W1.3\'s functions', async () => {
      const host = createTestHost();
      const bmp = px(4, 2, (i) => (i === 5 ? MAGENTA : [10, 20, 30, 255]));
      const planes = await host.decode.run({ bytes: bmp.bytes, key: { transparency: 0xff00ff, hitKeyed: true } });
      expect(planes).toMatchObject({ width: 4, height: 2 });
      expect(Array.from(planes.rgba.subarray(5 * 4, 5 * 4 + 4))).toEqual([255, 0, 255, 0]); // keyed: alpha 0
      expect(planes.paint[0]).toBe(0b11011111); // seven of eight pixels paint
      expect(planes.hit[0]).toBe(0b11111111); // and a keyed pixel still takes a click when hitKeyed
      const strict = await host.decode.run({ bytes: bmp.bytes, key: { transparency: 0xff00ff, hitKeyed: false } });
      expect(strict.hit[0]).toBe(0b11011111);
    });

    it('answers null for bytes that are not an image, and applies a clipping image', async () => {
      const host = createTestHost();
      expect(await host.decode.run({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), key: { hitKeyed: false } })).toBeNull();
      const body = px(2, 2, () => [10, 20, 30, 255]);
      const clip = px(2, 2, (i) => (i === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
      const planes = await host.decode.run({ bytes: body.bytes, clipBytes: clip.bytes, key: { clipping: 0xffffff, clipImage: 'c.bmp', hitKeyed: false } });
      expect(planes.clip[0] & 0b1111).toBe(0b1110); // pixel 0 is outside the region
      expect(planes.rgba[3]).toBe(0);
    });

    it('puts decode warnings on the planes, ahead of keying warnings', async () => {
      const host = createTestHost();
      const cut = buildBmp({ width: 8, height: 8, bpp: 8, compression: 'rle8', truncateRle: 6 });
      const planes = await host.decode.run({ bytes: cut.bytes, key: { transparency: 'auto', hitKeyed: false } });
      expect(planes).not.toBeNull();
      expect(planes.diagnostics.map((d) => d.code)[0]).toBe('image-bmp-rle-truncated');
    });
  });
});
