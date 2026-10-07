// @ts-check
// Which image or colour an element shows for its interaction state (E D2; spec 6.4, 6.5, 6.7, 6.10).
import { describe, expect, it } from 'vitest';
import { BUTTON_STATES, buttonState, refForState, stateRefs, textAttr, textVariant, thumbRef, thumbState } from '../../../src/engine/render/dom/states.js';
import { buildTheme } from '../../../src/engine/wms/build.js';

const idle = { over: false, pressed: false };
const over = { over: true, pressed: false };
const pressedOver = { over: true, pressed: true };
const pressedAway = { over: false, pressed: true };
const on = { enabled: true, sticky: false, down: false };

describe('buttonState', () => {
  it('is up, hover, hoverDown by the pointer', () => {
    expect(buttonState(on, idle)).toBe('up');
    expect(buttonState(on, over)).toBe('hover');
    expect(buttonState(on, pressedOver)).toBe('hoverDown');
  });

  it('shows up when the press began here and the pointer has left (widgets:48-52)', () => {
    expect(buttonState(on, pressedAway)).toBe('up');
  });

  it('disabled beats everything', () => {
    for (const p of [idle, over, pressedOver, pressedAway]) expect(buttonState({ ...on, enabled: false, sticky: true, down: true }, p)).toBe('disabled');
  });

  it('a latched sticky button is down, and hoverDown under the pointer', () => {
    expect(buttonState({ ...on, sticky: true, down: true }, idle)).toBe('down');
    expect(buttonState({ ...on, sticky: true, down: true }, over)).toBe('hoverDown');
  });

  it('`down` without `sticky` is ignored (spec 6.4)', () => {
    expect(buttonState({ ...on, sticky: false, down: true }, idle)).toBe('up');
  });
});

describe('stateRefs', () => {
  it('applies `hover ?? up`, `down ?? hover ?? up`, `hoverDown ?? down`, `disabled ?? up`', () => {
    expect(stateRefs({ image: 'u' })).toEqual({ up: 'u', hover: 'u', down: 'u', hoverDown: 'u', disabled: 'u' });
    expect(stateRefs({ image: 'u', hoverImage: 'h' })).toEqual({ up: 'u', hover: 'h', down: 'h', hoverDown: 'h', disabled: 'u' });
    expect(stateRefs({ image: 'u', downImage: 'd' })).toEqual({ up: 'u', hover: 'u', down: 'd', hoverDown: 'd', disabled: 'u' });
    expect(stateRefs({ image: 'u', hoverImage: 'h', downImage: 'd', hoverDownImage: 'hd', disabledImage: 'x' })).toEqual({ up: 'u', hover: 'h', down: 'd', hoverDown: 'hd', disabled: 'x' });
  });

  it('treats blank and non-string refs as not given', () => {
    expect(stateRefs({ image: ' u ', hoverImage: '  ', downImage: null, disabledImage: 3 })).toEqual({ up: 'u', hover: 'u', down: 'u', hoverDown: 'u', disabled: 'u' });
    expect(stateRefs({})).toEqual({ up: '', hover: '', down: '', hoverDown: '', disabled: '' });
  });

  it('refForState reads the state by name, and BUTTON_STATES lists the five', () => {
    const refs = stateRefs({ image: 'u', hoverImage: 'h' });
    expect(refForState(refs, 'hover')).toBe('h');
    expect(BUTTON_STATES).toEqual(['up', 'hover', 'down', 'hoverDown', 'disabled']);
  });
});

describe('slider thumb', () => {
  it('is disabled, then down while pressed anywhere, then hover over the whole box (parity D28)', () => {
    expect(thumbState(false, pressedOver)).toBe('disabled');
    expect(thumbState(true, pressedAway)).toBe('down');
    expect(thumbState(true, over)).toBe('hover');
    expect(thumbState(true, idle)).toBe('up');
  });

  it('down falls back to hover when the pointer is over, then to the thumb (widgets:268)', () => {
    const i = { thumbImage: 'u', thumbHoverImage: 'h', thumbDownImage: 'd', thumbDisabledImage: 'x' };
    expect(thumbRef(i, 'down', true)).toBe('d');
    expect(thumbRef({ thumbImage: 'u', thumbHoverImage: 'h' }, 'down', true)).toBe('h');
    expect(thumbRef({ thumbImage: 'u', thumbHoverImage: 'h' }, 'down', false)).toBe('u');
    expect(thumbRef({ thumbImage: 'u' }, 'hover', true)).toBe('u');
    expect(thumbRef(i, 'disabled', false)).toBe('x');
    expect(thumbRef({ thumbImage: 'u' }, 'disabled', false)).toBe('u');
    expect(thumbRef({}, 'up', false)).toBe('');
  });
});

describe('TEXT variants', () => {
  const wrap = (attrs) => {
    const raw = (n) => ({ name: n.toLowerCase(), value: String(attrs[n]), line: 1 });
    const theme = buildTheme({ tag: 'theme', attrs: [], line: 1, children: [{ tag: 'view', attrs: [{ name: 'id', value: 'v', line: 1 }], line: 1, children: [{ tag: 'text', attrs: [{ name: 'id', value: 't', line: 1 }, ...Object.keys(attrs).map(raw)], children: [], line: 2 }] }] },
      { sha: '0'.repeat(64), name: 'x', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null }, { probe: () => null });
    return theme.views[0].byId('t');
  };

  it('picks disabled, then hover, else normal', () => {
    expect(textVariant(false, over)).toBe('disabled');
    expect(textVariant(true, over)).toBe('hover');
    expect(textVariant(true, idle)).toBe('normal');
  });

  it('each variant falls back to the normal attribute when it is not set', () => {
    const el = wrap({ foregroundColor: '#ff0000', hoverForegroundColor: '#00ff00' });
    expect(textAttr(el, 'ForegroundColor', 'normal')).toBe(0xff0000);
    expect(textAttr(el, 'ForegroundColor', 'hover')).toBe(0x00ff00);
    expect(textAttr(el, 'ForegroundColor', 'disabled')).toBe(0xff0000);
    expect(textAttr(el, 'BackgroundColor', 'hover')).toBe('none');
    expect(textAttr(el, 'FontStyle', 'hover')).toBe('Normal');
  });
});
