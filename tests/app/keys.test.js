// @vitest-environment happy-dom
// Keyboard defaults (ENGINE.md D10.5, parity D9): Space, the arrows and V; the skin's handlers first
// (against the engine's real input dispatch); and the two fixes, modifiers ignored and no volume change
// when MPD has no mixer. Media is the test host's scripted fake, so every command is in `calls`.
//
// Rule 6: nothing here is keyed by a skin string.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachKeys, SEEK_STEP_SEC, VOLUME_STEP } from '../../src/app/keys.js';
import { attachInput } from '../../src/engine/input/dispatch.js';
import { FAITHFUL } from '../../src/engine/options.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { createManualClock } from '../../src/hosts/test/clock.js';
import { createFakeMedia } from '../../src/hosts/test/media.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

/** @param {{ preset?: string, effects?: any }} [o] */
function rig(o = {}) {
  const clock = createManualClock();
  const media = createFakeMedia(o.preset ?? 'stoppedEmpty', { clock });
  const effects = o.effects === undefined ? null : o.effects;
  const keys = attachKeys({ target: window, media, effects: () => effects });
  cleanups.push(() => keys.dispose());
  const calls = () => media.calls.map((c) => [c.method, ...c.args]);
  /** @param {string} key @param {KeyboardEventInit & { target?: EventTarget }} [init] */
  const press = (key, init = {}) => {
    const { target = document.body, ...rest } = init;
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest });
    target.dispatchEvent(e);
    return e;
  };
  return { clock, media, effects, keys, calls, press };
}

describe('Space', () => {
  it('plays when stopped and pauses when playing', async () => {
    const r = rig();
    expect(r.press(' ').defaultPrevented).toBe(true);
    await flush();
    r.media.set({ playState: 'play' });
    r.press(' ');
    await flush();
    expect(r.calls().map(([m]) => m)).toEqual(['play', 'pause']);
  });

  it('resumes from pause by playing', async () => {
    const r = rig();
    r.media.set({ playState: 'pause' });
    r.press(' ');
    await flush();
    expect(r.calls().map(([m]) => m)).toEqual(['play']);
  });

  it.each([['metaKey'], ['ctrlKey'], ['altKey']])('does nothing with %s held (Cmd-Space is the system\'s)', async (mod) => {
    const r = rig();
    const e = r.press(' ', { [mod]: true });
    await flush();
    expect(r.calls()).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('the arrows', () => {
  it('seek five seconds from the live position, never below zero', async () => {
    const r = rig({ preset: 'playing' });
    r.clock.advance(20_000);
    expect(r.media.elapsed()).toBe(20);
    r.press('ArrowRight');
    await flush();
    r.press('ArrowLeft');                                      // the fake applied the first seek: 25 -> 20
    await flush();
    expect(r.calls()).toEqual([['seek', 20 + SEEK_STEP_SEC], ['seek', 20]]);
    r.media.clearCalls();
    r.media.set({ playState: 'stop', elapsed: 2 });
    r.press('ArrowLeft');
    await flush();
    expect(r.calls()).toEqual([['seek', 0]]);
  });

  it('change the volume by five and clamp at both ends', async () => {
    const r = rig();                                          // volume 50
    r.press('ArrowUp');
    await flush();
    r.media.set({ volume: 98 });
    r.press('ArrowUp');
    r.media.set({ volume: 3 });
    r.press('ArrowDown');
    await flush();
    expect(r.calls()).toEqual([['setVolume', 50 + VOLUME_STEP], ['setVolume', 100], ['setVolume', 0]]);
  });

  it('send nothing for Up and Down when MPD has no mixer (volume -1)', async () => {
    const r = rig();
    r.media.set({ volume: -1 });
    const up = r.press('ArrowUp');
    const down = r.press('ArrowDown');
    await flush();
    expect(r.calls()).toEqual([]);
    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);
  });

  it('ignore modifiers', async () => {
    const r = rig();
    r.press('ArrowRight', { metaKey: true });
    r.press('ArrowUp', { ctrlKey: true });
    r.press('ArrowDown', { altKey: true });
    await flush();
    expect(r.calls()).toEqual([]);
  });
});

describe('V', () => {
  it('steps to the next visualization, through whichever effects slot is mounted', () => {
    const effects = { step: vi.fn() };
    const r = rig({ effects });
    expect(r.press('v').defaultPrevented).toBe(true);
    expect(effects.step).toHaveBeenCalledWith(1);
  });

  it('does nothing without an effects slot (a skin with no EFFECTS element), or with a modifier or Shift', () => {
    const none = rig();
    expect(none.press('v').defaultPrevented).toBe(false);
    const effects = { step: vi.fn() };
    const r = rig({ effects });
    r.press('v', { metaKey: true });                           // Cmd-V is paste, no longer a visualization step
    r.press('V', { shiftKey: true });
    expect(effects.step).not.toHaveBeenCalled();
  });
});

describe('what is not ours', () => {
  it('other keys are left alone', async () => {
    const r = rig();
    for (const k of ['a', 'Enter', 'Escape', 'Tab', 'F5']) expect(r.press(k).defaultPrevented).toBe(false);
    await flush();
    expect(r.calls()).toEqual([]);
  });

  it('a key typed into a text field belongs to the field', async () => {
    const r = rig();
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(input, area);
    r.press(' ', { target: input });
    r.press('ArrowRight', { target: area });
    await flush();
    expect(r.calls()).toEqual([]);
  });

  it('an event the skin already took (defaultPrevented) is skipped', async () => {
    const r = rig();
    const skin = (/** @type {Event} */ e) => e.preventDefault();
    document.addEventListener('keydown', skin, true);          // where the engine's dispatch listens
    cleanups.push(() => document.removeEventListener('keydown', skin, true));
    r.press(' ');
    await flush();
    expect(r.calls()).toEqual([]);
  });

  it('a media command that fails is not an unhandled rejection', async () => {
    const r = rig();
    r.media.play = () => Promise.reject(new Error('MPD went away'));
    const rejections = vi.fn();
    process.on('unhandledRejection', rejections);
    try {
      r.press(' ');
      await flush();
      await flush();
      expect(rejections).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', rejections);
    }
  });

  it('dispose removes the listener', async () => {
    const r = rig();
    r.keys.dispose();
    r.press(' ');
    await flush();
    expect(r.calls()).toEqual([]);
  });
});

describe('skin first, against the engine\'s real input dispatch', () => {
  /** @param {string} tag @param {Record<string, string | number>} attrs @param {any[]} [children] */
  const N = (tag, attrs, children = []) => ({
    tag, attrs: Object.entries(attrs).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 })), children, line: 1,
  });
  const vfs = { sha: '0'.repeat(64), name: 't.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null };

  /** The engine's dispatch on a plane, with a sink whose `key` says whether a skin handler ran. */
  function engine(handles) {
    const theme = buildTheme(N('theme', {}, [N('view', { id: 'v', width: 100, height: 100, onkeydown: 'k()' })]), vfs, { probe: () => null });
    const plane = document.createElement('div');
    document.body.append(plane);
    const off = attachInput(plane, theme.views[0], () => null, createTestSkinWindow(), {
      gesture() {}, dragSlider() {}, key: (event) => handles(event),
    }, FAITHFUL);
    cleanups.push(off);
  }

  it('a key a skin handler ran for never reaches the defaults', async () => {
    engine(() => true);
    const r = rig();
    r.press(' ');
    r.press('ArrowRight');
    await flush();
    expect(r.calls()).toEqual([]);
  });

  it('a key no skin handler ran for does', async () => {
    engine(() => false);
    const r = rig();
    r.press(' ');
    await flush();
    expect(r.calls().map(([m]) => m)).toEqual(['play']);
  });

  it('the skin may take one key and leave the rest', async () => {
    engine((/** @type {string} */ event) => event === 'onkeypress');   // Space is also a character key, so it reaches onkeypress too
    const r = rig();
    r.press(' ');                                              // handled through onkeypress
    r.press('ArrowRight');                                     // not a character key: only onkeydown, unhandled
    await flush();
    expect(r.calls().map(([m]) => m)).toEqual(['seek']);
  });
});
