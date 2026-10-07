// @ts-check
// Fonts, sizes, flags, colours, cursors: what a skin may say in a style (E D2 "Strings, fonts, cursors").
import { describe, expect, it } from 'vitest';
import { FALLBACK_FAMILY, cursorCss, decorationCss, fontFamilyCss, fontFlags, fontPx, letterSpacingCss, rgbCss } from '../../../src/engine/render/dom/strings.js';

describe('fontFamilyCss', () => {
  it('quotes each valid family and ends with the fallback stack (parity D22)', () => {
    expect(fontFamilyCss('Arial')).toBe(`"Arial", ${FALLBACK_FAMILY}`);
    expect(fontFamilyCss('Arial, Courier New')).toBe(`"Arial", "Courier New", ${FALLBACK_FAMILY}`);
    expect(fontFamilyCss('')).toBe(FALLBACK_FAMILY);
    expect(fontFamilyCss(undefined)).toBe(FALLBACK_FAMILY);
    expect(fontFamilyCss(null)).toBe(FALLBACK_FAMILY);
  });

  it('drops anything outside ^[A-Za-z0-9 ._-]{1,64}$ instead of repairing it (G27)', () => {
    const css = fontFamilyCss('Good, "evil}, url(x), a;b, back\\slash, </style>, Fine Face 2.0_x-y');
    expect(css).toBe(`"Good", "Fine Face 2.0_x-y", ${FALLBACK_FAMILY}`);
    for (const bad of ['evil', 'url', '}', ';', '\\', '<']) expect(css).not.toContain(bad);
  });

  it('drops an over-long name, an empty entry and a blank one', () => {
    expect(fontFamilyCss(`${'a'.repeat(65)}, , Ok`)).toBe(`"Ok", ${FALLBACK_FAMILY}`);
    expect(fontFamilyCss(`${'a'.repeat(64)}`)).toBe(`"${'a'.repeat(64)}", ${FALLBACK_FAMILY}`);
  });

  it('keeps at most eight families and does not choke on a huge list', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `F${i}`).join(',');
    const css = fontFamilyCss(many);
    expect((css.match(/"/g) ?? []).length).toBe(16);
  });

  it('treats `__proto__` and `constructor` as ordinary names', () => {
    expect(fontFamilyCss('__proto__, constructor')).toBe(`"__proto__", "constructor", ${FALLBACK_FAMILY}`);
  });
});

describe('fontPx', () => {
  it('is round(pt * 4 / 3): 7 pt is 9 px, the default 10 pt is 13 px (parity G8)', () => {
    expect(fontPx(7)).toBe(9);
    expect(fontPx(10)).toBe(13);
    expect(fontPx(5)).toBe(7);
    expect(fontPx(12)).toBe(16);
  });

  it('clamps and defaults instead of passing a hostile number through', () => {
    expect(fontPx(0)).toBe(1);
    expect(fontPx(-40)).toBe(1);
    expect(fontPx(1e9)).toBe(512);
    expect(fontPx(Number.NaN)).toBe(13);
    expect(fontPx('x')).toBe(13);
  });
});

describe('fontFlags and decorationCss', () => {
  it('reads the four flags in any case and order', () => {
    expect(fontFlags('Bold Italic')).toEqual({ bold: true, italic: true, underline: false, strikeout: false });
    expect(fontFlags('strikeout underline')).toEqual({ bold: false, italic: false, underline: true, strikeout: true });
  });

  it('Normal wins over everything (spec 6.10)', () => {
    expect(fontFlags('Bold Normal Underline')).toEqual({ bold: false, italic: false, underline: false, strikeout: false });
    expect(fontFlags('Normal')).toEqual({ bold: false, italic: false, underline: false, strikeout: false });
  });

  it('ignores non-strings and unknown words', () => {
    expect(fontFlags(null)).toEqual({ bold: false, italic: false, underline: false, strikeout: false });
    expect(fontFlags('Shiny')).toEqual({ bold: false, italic: false, underline: false, strikeout: false });
  });

  it('maps flags to text-decoration-line', () => {
    expect(decorationCss(fontFlags('Underline'))).toBe('underline');
    expect(decorationCss(fontFlags('Underline Strikeout'))).toBe('underline line-through');
    expect(decorationCss(fontFlags('Bold'))).toBe('none');
  });
});

describe('rgbCss', () => {
  it('writes six hex digits and nothing else', () => {
    expect(rgbCss(0xff00ff)).toBe('#ff00ff');
    expect(rgbCss(0)).toBe('#000000');
    expect(rgbCss(0x77ce07)).toBe('#77ce07');
    expect(rgbCss(0x1ffffff)).toBe('#ffffff'); // only the low 24 bits
  });

  it('is null for none, auto, unset and junk', () => {
    for (const v of ['none', 'auto', null, undefined, '#fff', Number.NaN, {}]) expect(rgbCss(v)).toBe(null);
  });
});

describe('cursorCss', () => {
  it('maps the documented names to CSS keywords', () => {
    expect(cursorCss('system')).toBe('default');
    expect(cursorCss('hand')).toBe('pointer');
    expect(cursorCss('help')).toBe('help');
    expect(cursorCss('sizeall')).toBe('move');
    expect(cursorCss('sizens')).toBe('ns-resize');
    expect(cursorCss('sizewe')).toBe('ew-resize');
    expect(cursorCss('sizenesw')).toBe('nesw-resize');
    expect(cursorCss('sizenwse')).toBe('nwse-resize');
  });

  it('maps the IE size* family the corpus uses to the nearest resize cursor (U-21)', () => {
    expect(cursorCss('sizetopright')).toBe('nesw-resize');
    expect(cursorCss('SizeTopLeft')).toBe('nwse-resize');
  });

  it('is null for a name it does not know, so the caller keeps the previous cursor', () => {
    expect(cursorCss('blink')).toBe(null);
    expect(cursorCss('pointer')).toBe(null);
    expect(cursorCss('foo.cur')).toBe(null);
    expect(cursorCss('x.ani')).toBe(null);
    expect(cursorCss(undefined)).toBe(null);
  });

  it('never finds an inherited member (cursor names are skin text)', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) expect(cursorCss(name)).toBe(null);
  });
});

describe('letterSpacingCss', () => {
  it('accepts a short signed decimal in px only', () => {
    expect(letterSpacingCss('-0.3px')).toBe('-0.3px');
    expect(letterSpacingCss('1px')).toBe('1px');
    for (const bad of ['1em', 'calc(1px)', '1px;color:red', '-0.3', '', '1e3px', 'url(x)', '0.3333px', 5, null]) expect(letterSpacingCss(bad)).toBe(null);
  });
});
