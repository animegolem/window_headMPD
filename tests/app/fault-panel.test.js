// @vitest-environment happy-dom
// The fault panel (ENGINE.md D10.8): the host-drawn "this skin stopped" panel with its ways out, the
// window shape that includes it, and the text it will and will not show. The window is the test host's
// `TestSkinWindow`, which records every shape and drag.
//
// Rule 6: nothing here is keyed by a skin string. A fault reason can quote the skin, so one test feeds
// the panel markup, control characters and a very long string, and one uses `__proto__` and
// `constructor` as the reason.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIZE, MAX_MESSAGE_CHARS, PANEL_SIZE, createFaultPanel, panelRect, sanitizeMessage, shapeWithPanel,
} from '../../src/app/fault-panel.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { document.body.replaceChildren(); });

/** @param {Partial<import('../../src/app/fault-panel.js').FaultActions>} [actions] @param {object} [over] */
function rig(actions = {}, over = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const win = createTestSkinWindow({ root });
  const reload = vi.fn();
  const warn = vi.fn();
  const panel = createFaultPanel({ win, root, actions: { reload, ...actions }, log: { warn }, ...over });
  return { root, win, reload, warn, panel };
}
const text = (/** @type {ReturnType<typeof rig>} */ r) => r.root.querySelector('.wh-fault-message')?.textContent;
const buttons = (/** @type {ReturnType<typeof rig>} */ r) => [...r.root.querySelectorAll('button')].map((b) => b.textContent);
/** Whether pixel (x, y) is set in a bits shape. @param {any} shape */
const bit = (shape, x, y) => { const i = y * shape.width + x; return (shape.bits[i >> 3] >> (i & 7)) & 1; };
const popcount = (/** @type {Uint8Array} */ bits) => bits.reduce((n, b) => { let v = b; while (v) { n += v & 1; v >>= 1; } return n; }, 0);

describe('panelRect', () => {
  it('centres the panel in the window', () => {
    expect(panelRect({ w: 760, h: 394 })).toEqual({ x: 210, y: 133, w: PANEL_SIZE.w, h: PANEL_SIZE.h });
  });

  it('shrinks to a window smaller than the panel and stays inside it', () => {
    expect(panelRect({ w: 100, h: 50 })).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });
});

describe('sanitizeMessage', () => {
  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeMessage('a\u0000b\u001b[31m\n\n  c\t\u2028d')).toBe('a b [31m c d');
  });

  it('caps the length with an ellipsis', () => {
    const out = sanitizeMessage('x'.repeat(5000));
    expect(out).toHaveLength(MAX_MESSAGE_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('turns null and undefined into nothing', () => {
    expect(sanitizeMessage(undefined)).toBe('');
    expect(sanitizeMessage(null)).toBe('');
  });
});

describe('show and hide', () => {
  it('draws the panel in the window root, centred, with the message and the buttons', () => {
    const r = rig();
    r.panel.show('This skin stopped: it ran out of time');
    const el = /** @type {HTMLElement} */ (r.root.querySelector('.wh-fault'));
    expect(r.panel.visible()).toBe(true);
    expect(text(r)).toBe('This skin stopped: it ran out of time');
    expect(buttons(r)).toEqual(['Reload skin']);
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(['210px', '133px', '340px', '128px']);
    expect(el.getAttribute('role')).toBe('alertdialog');
  });

  it('shows the buttons the shell can honour: choosing a skin and the legacy app when it has them', () => {
    const r = rig({ chooseSkin: vi.fn(), useLegacy: vi.fn() });
    r.panel.show('x');
    expect(buttons(r)).toEqual(['Reload skin', 'Choose another skin', 'Use legacy Headspace']);
  });

  it('a second show() replaces the text and keeps one panel', () => {
    const r = rig();
    r.panel.show('first');
    r.panel.show('second');
    expect(r.root.querySelectorAll('.wh-fault')).toHaveLength(1);
    expect(text(r)).toBe('second');
  });

  it('hide() removes it', () => {
    const r = rig();
    r.panel.show('x');
    r.panel.hide();
    expect(r.panel.visible()).toBe(false);
    expect(r.root.querySelector('.wh-fault')).toBeNull();
    r.panel.hide();                                             // again: nothing to do
  });

  it('is sized to the window the shell says it has', () => {
    const r = rig({}, { size: () => ({ w: 549, h: 394 }) });
    r.panel.show('x');
    expect(/** @type {HTMLElement} */ (r.root.querySelector('.wh-fault')).style.left).toBe('104px');
  });

  it('draws in the window root when none is given, else in #skin, else the body', () => {
    const win = createTestSkinWindow({ root: null });
    const a = createFaultPanel({ win, actions: { reload() {} } });
    a.show('x');
    expect(document.body.querySelector('.wh-fault')).not.toBeNull();
    a.hide();
    const skin = document.createElement('div');
    skin.id = 'skin';
    document.body.append(skin);
    const b = createFaultPanel({ win, actions: { reload() {} } });
    b.show('x');
    expect(skin.querySelector('.wh-fault')).not.toBeNull();
  });
});

describe('what it shows', () => {
  it('only ever as text: markup, control characters and a long reason are neutralised', () => {
    const r = rig();
    r.panel.show(`<img src=x onerror=alert(1)>\u0007${'a'.repeat(1000)}`);
    expect(r.root.querySelector('.wh-fault img')).toBeNull();
    expect(text(r)?.startsWith('<img src=x onerror=alert(1)> a')).toBe(true);
    expect(text(r)?.length).toBe(MAX_MESSAGE_CHARS);
  });

  it.each(['__proto__', 'constructor'])('a reason named %s is just text', (name) => {
    const r = rig();
    r.panel.show(name);
    expect(text(r)).toBe(name);
  });
});

describe('the window shape', () => {
  it('includes the panel: the shape sent holds its rectangle and nothing outside it', () => {
    const r = rig();
    r.panel.show('x');
    const shape = /** @type {any} */ (r.win.lastShape());
    expect(shape).toMatchObject({ kind: 'bits', width: DEFAULT_SIZE.w, height: DEFAULT_SIZE.h });
    const rect = panelRect(DEFAULT_SIZE);
    expect(bit(shape, rect.x, rect.y)).toBe(1);
    expect(bit(shape, rect.x + rect.w - 1, rect.y + rect.h - 1)).toBe(1);
    expect(bit(shape, rect.x - 1, rect.y)).toBe(0);
    expect(bit(shape, rect.x, rect.y + rect.h)).toBe(0);
    expect(popcount(shape.bits)).toBe(rect.w * rect.h);
    expect(popcount(shape.bits)).toBeGreaterThanOrEqual(64);   // the host refuses a shape with fewer (D2)
  });

  it('adds the panel to the dead skin\'s last shape, so the skin stays clickable under it', () => {
    const base = { kind: /** @type {const} */ ('bits'), width: 760, height: 394, bits: new Uint8Array(Math.ceil((760 * 394) / 8)) };
    base.bits[0] = 0xff;                                       // pixels (0..7, 0): the skin's
    const r = rig({}, { baseShape: () => base });
    r.panel.show('x');
    const shape = /** @type {any} */ (r.win.lastShape());
    expect(bit(shape, 3, 0)).toBe(1);
    expect(bit(shape, 300, 200)).toBe(1);
    expect(base.bits.every((b, i) => i === 0 ? b === 0xff : b === 0)).toBe(true);   // the base is not modified
  });

  it('a base shape of another size is ignored, and a regions base gets one more region', () => {
    const other = { kind: /** @type {const} */ ('bits'), width: 100, height: 100, bits: new Uint8Array(1250).fill(255) };
    const a = rig({}, { baseShape: () => other });
    a.panel.show('x');
    expect(bit(/** @type {any} */ (a.win.lastShape()), 5, 5)).toBe(0);
    const regions = { kind: /** @type {const} */ ('regions'), width: 760, height: 394, regions: [{ x: 0, y: 0, w: 10, h: 10 }] };
    expect(shapeWithPanel(regions, DEFAULT_SIZE, panelRect(DEFAULT_SIZE))).toMatchObject({ kind: 'regions', regions: [{ x: 0, y: 0, w: 10, h: 10 }, { x: 210, y: 133 }] });
  });
});

describe('the buttons', () => {
  it('Reload skin calls the shell\'s reload', () => {
    const r = rig();
    r.panel.show('x');
    /** @type {HTMLButtonElement} */ (r.root.querySelector('.wh-fault-reload')).click();
    expect(r.reload).toHaveBeenCalledOnce();
  });

  it('Use legacy Headspace calls the flip, and a failing action is logged, not thrown', async () => {
    const useLegacy = vi.fn(() => Promise.reject(new Error('no flip')));
    const r = rig({ useLegacy });
    r.panel.show('x');
    /** @type {HTMLButtonElement} */ (r.root.querySelector('.wh-fault-legacy')).click();
    await flush();
    expect(useLegacy).toHaveBeenCalledOnce();
    expect(r.warn).toHaveBeenCalledWith('fault panel: Use legacy Headspace failed', { error: 'Error: no flip' });
  });

  it('a synchronous throw is logged too', () => {
    const r = rig({ reload: () => { throw new Error('boom'); } });
    r.panel.show('x');
    /** @type {HTMLButtonElement} */ (r.root.querySelector('.wh-fault-reload')).click();
    expect(r.warn).toHaveBeenCalled();
  });
});

describe('dragging', () => {
  it('a left press on the panel itself drags the window; on a button, or with Control, it does not', () => {
    const r = rig();
    r.panel.show('x');
    const el = /** @type {HTMLElement} */ (r.root.querySelector('.wh-fault'));
    const down = (/** @type {Element} */ t, init = {}) => t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ...init }));
    down(el);
    expect(r.win.recorded.drags).toBe(1);
    down(/** @type {Element} */ (r.root.querySelector('button')));
    down(el, { ctrlKey: true });
    down(el, { button: 2 });
    expect(r.win.recorded.drags).toBe(1);
  });
});
