// ENGINE.md D10.1 / D7.6 / parity D3: zoom is Normal (1) or Larger (1.5), changed from the window menu or
// a skin's "Return to Full Mode" button, remembered per window in the `app` namespace in the legacy value
// format, with the migrated bare `zoom` as the fallback. The window is the test host's `TestSkinWindow`
// (it records `setZoom` and keeps its own zoom fixed); prefs are the in-memory store.
//
// Rule 6: no lookup here is keyed by a skin string; `windowPrefKey` only builds a string.
import { describe, expect, it, vi } from 'vitest';
import { ZOOM_LARGER, ZOOM_NORMAL, createZoom, parseZoom, windowPrefKey } from '../../src/app/zoom.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';

function rig(seed = {}) {
  const prefs = createMemoryPrefs();
  prefs.seed('app', /** @type {Record<string, string>} */ (seed));
  const win = createTestSkinWindow({ key: 'sha/main' });
  const warn = vi.fn();
  const zoom = createZoom({ win, prefs, log: { warn } });
  return { prefs, win, warn, zoom };
}

describe('windowPrefKey', () => {
  it('scopes a name to the window key', () => {
    expect(windowPrefKey('zoom', 'abc/main')).toBe('zoom@abc/main');
  });

  it('cuts a skin-controlled key so the pref key stays under the 256-byte cap', () => {
    const k = windowPrefKey('allDesktops', `${'a'.repeat(64)}/${'v'.repeat(5000)}`);
    expect(new TextEncoder().encode(k).length).toBeLessThanOrEqual(256);
    expect(k.startsWith(`allDesktops@${'a'.repeat(64)}/`)).toBe(true);
  });
});

describe('parseZoom', () => {
  it.each([['1', 1], ['1.5', 1.5], ['0.25', 0.25], ['4', 4]])('reads %s as %s', (raw, v) => {
    expect(parseZoom(raw)).toBe(v);
  });

  it.each([undefined, '', 'banana', '0', '-1', '9', 'null', '"1.5"', '[1]', 'NaN', '1e999'])('reads %j as not stored', (raw) => {
    expect(parseZoom(raw)).toBeNull();
  });
});

describe('toggle and set', () => {
  it('flips Normal to Larger and back, asking the window each time and saving the legacy format', async () => {
    const { zoom, win, prefs } = rig();
    expect(zoom.get()).toBe(ZOOM_NORMAL);
    await zoom.toggle();
    expect(zoom.get()).toBe(ZOOM_LARGER);
    expect(win.recorded.zoomRequests).toEqual([1.5]);
    expect(prefs.peek('app').get('zoom@sha/main')).toBe('1.5');
    await zoom.toggle();
    expect(zoom.get()).toBe(1);
    expect(win.recorded.zoomRequests).toEqual([1.5, 1]);
    expect(prefs.peek('app').get('zoom@sha/main')).toBe('1');
  });

  it('tells listeners the new zoom, and stops when they unsubscribe', async () => {
    const { zoom } = rig();
    const seen = /** @type {number[]} */ ([]);
    const off = zoom.onChange((z) => seen.push(z));
    await zoom.toggle();
    off();
    await zoom.toggle();
    expect(seen).toEqual([1.5]);
  });

  it('two toggles in a row apply in order and end where they started', async () => {
    const { zoom, win } = rig();
    await Promise.all([zoom.toggle(), zoom.toggle()]);
    expect(win.recorded.zoomRequests).toEqual([1.5, 1]);
    expect(zoom.get()).toBe(1);
  });

  it('set() to the current zoom is a no-op', async () => {
    const { zoom, win, prefs } = rig();
    await zoom.set(1);
    expect(win.recorded.zoomRequests).toEqual([]);
    expect(prefs.writes).toEqual([]);
  });

  it('set() refuses a zoom outside 0.25 to 4 without touching the window', async () => {
    const { zoom, win } = rig();
    for (const bad of [0, -1, 5, NaN, Infinity]) await expect(zoom.set(bad)).rejects.toThrow(RangeError);
    expect(win.recorded.zoomRequests).toEqual([]);
    await zoom.set(2);                                         // the chain is still alive
    expect(zoom.get()).toBe(2);
  });

  it('a window that fails to resize changes nothing: not the zoom, not the pref, not the listeners', async () => {
    const { zoom, win, prefs } = rig();
    const seen = vi.fn();
    zoom.onChange(seen);
    win.setZoom = () => Promise.reject(new Error('no window'));
    await expect(zoom.toggle()).rejects.toThrow('no window');
    expect(zoom.get()).toBe(1);
    expect(prefs.writes).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    win.setZoom = async () => {};
    await zoom.toggle();                                       // and the next call still works
    expect(zoom.get()).toBe(1.5);
  });

  it('a pref store that refuses the save is logged, and the zoom still changes', async () => {
    const win = createTestSkinWindow({ key: 'sha/main' });
    const warn = vi.fn();
    const zoom = createZoom({ win, prefs: { load: async () => new Map(), write() { throw new Error('full'); } }, log: { warn } });
    await zoom.toggle();
    expect(zoom.get()).toBe(1.5);
    expect(warn).toHaveBeenCalledWith('zoom: could not save the zoom', { error: 'Error: full' });
  });
});

describe('restore', () => {
  it('applies the window\'s own saved zoom without saving it again', async () => {
    const { zoom, win, prefs } = rig({ 'zoom@sha/main': '1.5' });
    expect(await zoom.restore()).toBe(1.5);
    expect(win.recorded.zoomRequests).toEqual([1.5]);
    expect(prefs.writes).toEqual([]);
  });

  it('falls back to the bare zoom the migration carried over', async () => {
    const { zoom, win } = rig({ zoom: '1.5' });
    expect(await zoom.restore()).toBe(1.5);
    expect(win.recorded.zoomRequests).toEqual([1.5]);
  });

  it('prefers the window\'s own zoom over the bare one', async () => {
    const { zoom } = rig({ zoom: '1.5', 'zoom@sha/main': '1' });
    expect(await zoom.restore()).toBe(1);
  });

  it('ignores a stored value that is not a usable zoom, and then reads the bare one', async () => {
    const { zoom, win } = rig({ 'zoom@sha/main': 'banana', zoom: '1.5' });
    expect(await zoom.restore()).toBe(1.5);
    expect(win.recorded.zoomRequests).toEqual([1.5]);
  });

  it('does nothing when nothing is saved, or the saved value is the current zoom', async () => {
    const a = rig();
    expect(await a.zoom.restore()).toBe(1);
    const b = rig({ zoom: '1' });
    expect(await b.zoom.restore()).toBe(1);
    expect(a.win.recorded.zoomRequests).toEqual([]);
    expect(b.win.recorded.zoomRequests).toEqual([]);
  });

  it('a second restore, after the key changed to the skin\'s own, picks up that key (the window key is set at load)', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('app', { zoom: '1.5', 'zoom@other/main': '1' });
    const win = createTestSkinWindow({ key: 'native/main' });
    const zoom = createZoom({ win, prefs });
    expect(await zoom.restore()).toBe(1.5);
    /** @type {any} */ (win).key = 'other/main';
    expect(await zoom.restore()).toBe(1);
  });

  it('a pref store that cannot be read leaves the window as it is', async () => {
    const win = createTestSkinWindow();
    const warn = vi.fn();
    const zoom = createZoom({ win, prefs: { load: () => Promise.reject(new Error('io')), write() {} }, log: { warn } });
    expect(await zoom.restore()).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(win.recorded.zoomRequests).toEqual([]);
  });
});
