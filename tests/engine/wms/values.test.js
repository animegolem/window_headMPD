// @ts-check
import { describe, expect, it } from 'vitest';
import { classifyValue, classifyValueDiag, coerce, parseBindPath, parseColor } from '../../../src/engine/wms/values.js';

/** @typedef {import('../../../src/engine/contracts').ElementKind} ElementKind */

// The 140 names of the WMP colour reference (spec 3.1), as published, except darkseagreen: the page
// prints 8FBC8B, one digit off the standard value every browser and IE use, which is 8FBC8F.
/** @type {Array<[string, number]>} */
const IE_COLORS = [
  ['aliceblue', 0xf0f8ff], ['antiquewhite', 0xfaebd7], ['aqua', 0x00ffff], ['aquamarine', 0x7fffd4],
  ['azure', 0xf0ffff], ['beige', 0xf5f5dc], ['bisque', 0xffe4c4], ['black', 0x000000],
  ['blanchedalmond', 0xffebcd], ['blue', 0x0000ff], ['blueviolet', 0x8a2be2], ['brown', 0xa52a2a],
  ['burlywood', 0xdeb887], ['cadetblue', 0x5f9ea0], ['chartreuse', 0x7fff00], ['chocolate', 0xd2691e],
  ['coral', 0xff7f50], ['cornflowerblue', 0x6495ed], ['cornsilk', 0xfff8dc], ['crimson', 0xdc143c],
  ['cyan', 0x00ffff], ['darkblue', 0x00008b], ['darkcyan', 0x008b8b], ['darkgoldenrod', 0xb8860b],
  ['darkgray', 0xa9a9a9], ['darkgreen', 0x006400], ['darkkhaki', 0xbdb76b], ['darkmagenta', 0x8b008b],
  ['darkolivegreen', 0x556b2f], ['darkorange', 0xff8c00], ['darkorchid', 0x9932cc], ['darkred', 0x8b0000],
  ['darksalmon', 0xe9967a], ['darkseagreen', 0x8fbc8f], ['darkslateblue', 0x483d8b], ['darkslategray', 0x2f4f4f],
  ['darkturquoise', 0x00ced1], ['darkviolet', 0x9400d3], ['deeppink', 0xff1493], ['deepskyblue', 0x00bfff],
  ['dimgray', 0x696969], ['dodgerblue', 0x1e90ff], ['firebrick', 0xb22222], ['floralwhite', 0xfffaf0],
  ['forestgreen', 0x228b22], ['fuchsia', 0xff00ff], ['gainsboro', 0xdcdcdc], ['ghostwhite', 0xf8f8ff],
  ['gold', 0xffd700], ['goldenrod', 0xdaa520], ['gray', 0x808080], ['green', 0x008000],
  ['greenyellow', 0xadff2f], ['honeydew', 0xf0fff0], ['hotpink', 0xff69b4], ['indianred', 0xcd5c5c],
  ['indigo', 0x4b0082], ['ivory', 0xfffff0], ['khaki', 0xf0e68c], ['lavender', 0xe6e6fa],
  ['lavenderblush', 0xfff0f5], ['lawngreen', 0x7cfc00], ['lemonchiffon', 0xfffacd], ['lightblue', 0xadd8e6],
  ['lightcoral', 0xf08080], ['lightcyan', 0xe0ffff], ['lightgoldenrodyellow', 0xfafad2], ['lightgreen', 0x90ee90],
  ['lightgrey', 0xd3d3d3], ['lightpink', 0xffb6c1], ['lightsalmon', 0xffa07a], ['lightseagreen', 0x20b2aa],
  ['lightskyblue', 0x87cefa], ['lightslategray', 0x778899], ['lightsteelblue', 0xb0c4de], ['lightyellow', 0xffffe0],
  ['lime', 0x00ff00], ['limegreen', 0x32cd32], ['linen', 0xfaf0e6], ['magenta', 0xff00ff],
  ['maroon', 0x800000], ['mediumaquamarine', 0x66cdaa], ['mediumblue', 0x0000cd], ['mediumorchid', 0xba55d3],
  ['mediumpurple', 0x9370db], ['mediumseagreen', 0x3cb371], ['mediumslateblue', 0x7b68ee], ['mediumspringgreen', 0x00fa9a],
  ['mediumturquoise', 0x48d1cc], ['mediumvioletred', 0xc71585], ['midnightblue', 0x191970], ['mintcream', 0xf5fffa],
  ['mistyrose', 0xffe4e1], ['moccasin', 0xffe4b5], ['navajowhite', 0xffdead], ['navy', 0x000080],
  ['oldlace', 0xfdf5e6], ['olive', 0x808000], ['olivedrab', 0x6b8e23], ['orange', 0xffa500],
  ['orangered', 0xff4500], ['orchid', 0xda70d6], ['palegoldenrod', 0xeee8aa], ['palegreen', 0x98fb98],
  ['paleturquoise', 0xafeeee], ['palevioletred', 0xdb7093], ['papayawhip', 0xffefd5], ['peachpuff', 0xffdab9],
  ['peru', 0xcd853f], ['pink', 0xffc0cb], ['plum', 0xdda0dd], ['powderblue', 0xb0e0e6],
  ['purple', 0x800080], ['red', 0xff0000], ['rosybrown', 0xbc8f8f], ['royalblue', 0x4169e1],
  ['saddlebrown', 0x8b4513], ['salmon', 0xfa8072], ['sandybrown', 0xf4a460], ['seagreen', 0x2e8b57],
  ['seashell', 0xfff5ee], ['sienna', 0xa0522d], ['silver', 0xc0c0c0], ['skyblue', 0x87ceeb],
  ['slateblue', 0x6a5acd], ['slategray', 0x708090], ['snow', 0xfffafa], ['springgreen', 0x00ff7f],
  ['steelblue', 0x4682b4], ['tan', 0xd2b48c], ['teal', 0x008080], ['thistle', 0xd8bfd8],
  ['tomato', 0xff6347], ['turquoise', 0x40e0d0], ['violet', 0xee82ee], ['wheat', 0xf5deb3],
  ['white', 0xffffff], ['whitesmoke', 0xf5f5f5], ['yellow', 0xffff00], ['yellowgreen', 0x9acd32],
];

describe('parseColor', () => {
  it('knows all 140 IE names, in any case and with blanks around', () => {
    expect(IE_COLORS).toHaveLength(140);
    expect(new Set(IE_COLORS.map(([n]) => n)).size).toBe(140);
    for (const [name, rgb] of IE_COLORS) {
      expect(parseColor(name), name).toBe(rgb);
      expect(parseColor(name.toUpperCase()), name).toBe(rgb);
      expect(parseColor(`  ${name[0].toUpperCase()}${name.slice(1)}\t`), name).toBe(rgb);
    }
  });

  it('anchors: well-known values that do not come from the table above', () => {
    expect(parseColor('red')).toBe(0xff0000);
    expect(parseColor('lime')).toBe(0x00ff00);
    expect(parseColor('blue')).toBe(0x0000ff);
    expect(parseColor('fuchsia')).toBe(parseColor('magenta'));
    expect(parseColor('magenta')).toBe(0xff00ff);
    expect(parseColor('aqua')).toBe(parseColor('cyan'));
    expect(parseColor('white')).toBe(0xffffff);
    expect(parseColor('black')).toBe(0);
    expect(parseColor('gray')).toBe(0x808080);
  });

  it('takes both spellings of grey (the reference prints lightgrey, IE takes the rest too)', () => {
    for (const [grey, gray] of [
      ['lightgray', 'lightgrey'], ['darkgrey', 'darkgray'], ['dimgrey', 'dimgray'], ['grey', 'gray'],
      ['slategrey', 'slategray'], ['darkslategrey', 'darkslategray'], ['lightslategrey', 'lightslategray'],
    ]) {
      expect(parseColor(grey), grey).not.toBeNull();
      expect(parseColor(grey), grey).toBe(parseColor(gray));
    }
  });

  it('parses #RRGGBB and #RGB, either case', () => {
    expect(parseColor('#FF00FF')).toBe(0xff00ff);
    expect(parseColor('#ff00ff')).toBe(0xff00ff);
    expect(parseColor('#000000')).toBe(0);
    expect(parseColor('#FFFFFF')).toBe(0xffffff);
    expect(parseColor(' #77CE07 ')).toBe(0x77ce07);
    expect(parseColor('#f0a')).toBe(0xff00aa); // U-29: each digit doubles
    expect(parseColor('#FFF')).toBe(0xffffff);
    expect(parseColor('#000')).toBe(0);
    expect(parseColor('#123')).toBe(0x112233);
  });

  it('parses none and auto, in any case', () => {
    for (const s of ['none', 'None', 'NONE', ' none ']) expect(parseColor(s), s).toBe('none');
    for (const s of ['auto', 'Auto', 'AUTO', ' auto']) expect(parseColor(s), s).toBe('auto');
  });

  it('knows the Windows system names the docs use for PLAYLIST defaults', () => {
    expect(parseColor('graytext')).toBe(0x808080);
    expect(parseColor('GrayText')).toBe(0x808080);
    for (const s of ['windowtext', 'highlight', 'highlighttext', 'buttonface', 'buttontext']) {
      expect(typeof parseColor(s), s).toBe('number');
    }
  });

  it('returns null for everything else', () => {
    for (const s of ['', ' ', '#', '#1', '#12', '#1234', '#12345', '#1234567', '#GGGGGG', '#ff00f', 'ff00ff', '0xff00ff',
      'notacolor', 'rgb(1,2,3)', 'transparent', 'red green', 'redd', '#ff00ff00', 'none none']) {
      expect(parseColor(s), JSON.stringify(s)).toBeNull();
    }
    for (const v of [undefined, null, 5, {}, []]) expect(parseColor(/** @type {any} */ (v))).toBeNull();
  });

  it('does not find inherited members for __proto__ and constructor', () => {
    for (const s of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
      expect(parseColor(s), s).toBeNull();
    }
  });
});

describe('coerce: booleans', () => {
  it('reads true/false/1/0 in any case, as text, number or boolean', () => {
    for (const v of ['true', 'TRUE', 'True', ' true ', '1', ' 1', 1, true]) expect(coerce('bool', v, false), String(v)).toBe(true);
    for (const v of ['false', 'FALSE', 'False', ' false', '0', 0, false]) expect(coerce('bool', v, true), String(v)).toBe(false);
  });

  it("keeps the previous value for anything else ('ture' is a corpus typo, U-20)", () => {
    for (const prev of [true, false]) {
      for (const v of ['ture', 'fale', 'yes', 'no', '', ' ', '2', '-1', 'null', 2, -1, 0.5, NaN, null, undefined, {}, []]) {
        expect(coerce('bool', v, prev), `${String(v)} with prev ${prev}`).toBe(prev);
      }
    }
  });

  it("player.settings.mute='false' is false (spec 2.4)", () => {
    expect(coerce('bool', 'false', true)).toBe(false);
  });
});

describe('coerce: numbers', () => {
  it("trims text: '600 ' is 600 (G22)", () => {
    expect(coerce('int', '600 ', 0)).toBe(600);
    expect(coerce('int', '  42\t', 0)).toBe(42);
    expect(coerce('float', ' 0.5 ', 0)).toBe(0.5);
  });

  it('-1 survives, as a number and as text (U-22)', () => {
    expect(coerce('int', -1, 7)).toBe(-1);
    expect(coerce('int', '-1', 7)).toBe(-1);
    expect(coerce('float', -1, 7)).toBe(-1);
    expect(coerce('float', '-1', 7)).toBe(-1);
    expect(coerce('int', '-100', 7)).toBe(-100);
    expect(coerce('float', '-20.5', 7)).toBe(-20.5);
  });

  it('accepts a sign and a bare fraction', () => {
    expect(coerce('int', '+5', 0)).toBe(5);
    expect(coerce('float', '.5', 0)).toBe(0.5);
    expect(coerce('float', '5.', 0)).toBe(5);
    expect(coerce('float', '1.25', 0)).toBe(1.25);
  });

  it('keeps the previous value for blanks, text and non-finite numbers', () => {
    for (const type of /** @type {const} */ (['int', 'float'])) {
      for (const v of ['', ' ', '\t', 'abc', '12px', '1e3', '0x10', '1,5', '--1', '1 2', 'NaN', 'Infinity', NaN, Infinity, -Infinity, null, undefined, true, false, {}, []]) {
        expect(coerce(type, v, 99), `${type} ${String(v)}`).toBe(99);
      }
    }
  });

  it('rounds an int the way OLE does, half to even', () => {
    expect(coerce('int', 2.4, 0)).toBe(2);
    expect(coerce('int', 2.5, 0)).toBe(2);
    expect(coerce('int', 3.5, 0)).toBe(4);
    expect(coerce('int', 2.6, 0)).toBe(3);
    expect(coerce('int', -2.5, 0)).toBe(-2);
    expect(coerce('int', -3.5, 0)).toBe(-4);
    expect(coerce('int', '12.5', 0)).toBe(12);
    expect(coerce('int', 760.5, 0)).toBe(760);
    expect(Object.is(coerce('int', -0.4, 1), 0)).toBe(true);
    expect(Object.is(coerce('int', -0, 1), 0)).toBe(true);
  });

  it('leaves a float alone', () => {
    expect(coerce('float', 2.5, 0)).toBe(2.5);
    expect(coerce('float', '0.1', 0)).toBe(0.1);
  });
});

describe('coerce: strings, images, handlers', () => {
  it('passes text through untouched and stringifies numbers and booleans', () => {
    for (const type of /** @type {const} */ (['string', 'image', 'handler'])) {
      expect(coerce(type, ' keep me ', 'x'), type).toBe(' keep me ');
      expect(coerce(type, '', 'x'), type).toBe('');
      expect(coerce(type, 12, 'x'), type).toBe('12');
      expect(coerce(type, true, 'x'), type).toBe('true');
      expect(coerce(type, null, 'x'), type).toBe('x');
      expect(coerce(type, undefined, 'x'), type).toBe('x');
      expect(coerce(type, {}, 'x'), type).toBe('x');
      expect(coerce(type, NaN, 'x'), type).toBe('x');
    }
  });
});

describe('coerce: colours', () => {
  it('turns text into the parseColor form', () => {
    expect(coerce('color', '#FF00FF', null)).toBe(0xff00ff);
    expect(coerce('color', 'White', null)).toBe(0xffffff);
    expect(coerce('color', ' none ', 0)).toBe('none');
    expect(coerce('color', 'Auto', 0)).toBe('auto');
    expect(coerce('color', '#abc', 0)).toBe(0xaabbcc);
  });

  it('keeps the previous value for an invalid colour, even a null one', () => {
    expect(coerce('color', 'reddish', 0x123456)).toBe(0x123456);
    expect(coerce('color', '', 'none')).toBe('none');
    expect(coerce('color', 'reddish', null)).toBeNull();
    expect(coerce('color', null, 5)).toBe(5);
    expect(coerce('color', undefined, 5)).toBe(5);
    expect(coerce('color', true, 5)).toBe(5);
  });

  it('is idempotent on typed values', () => {
    expect(coerce('color', 0xff00ff, 0)).toBe(0xff00ff);
    expect(coerce('color', 0, 5)).toBe(0);
    expect(coerce('color', 0xffffff, 5)).toBe(0xffffff);
    expect(coerce('color', 'none', 0)).toBe('none');
    expect(coerce('color', 'auto', 0)).toBe('auto');
  });

  it('rejects numbers that are not an Rgb', () => {
    for (const v of [-1, 0x1000000, 1.5, NaN, Infinity]) expect(coerce('color', v, 7), String(v)).toBe(7);
  });
});

describe('coerce: cursors', () => {
  it('lowercases the documented names and keeps cursor files as written', () => {
    for (const n of ['system', 'hand', 'help', 'sizeall', 'sizenesw', 'sizens', 'sizenwse', 'sizewe', 'uparrow']) {
      expect(coerce('cursor', n, 'x'), n).toBe(n);
      expect(coerce('cursor', n.toUpperCase(), 'x'), n).toBe(n);
    }
    expect(coerce('cursor', 'Hand', 'system')).toBe('hand');
    expect(coerce('cursor', ' Pointer.CUR ', 'system')).toBe('Pointer.CUR');
    expect(coerce('cursor', 'wait.ani', 'system')).toBe('wait.ani');
  });

  it('keeps an unknown name so the renderer can map it (U-21), and ignores non-text', () => {
    expect(coerce('cursor', 'SizeTopRight', 'system')).toBe('sizetopright');
    expect(coerce('cursor', 5, 'system')).toBe('system');
    expect(coerce('cursor', null, 'system')).toBe('system');
  });
});

describe('coerce: enums', () => {
  const justification = { enum: ['Left', 'Right', 'Center'] };

  it('matches case-insensitively and answers with the member', () => {
    expect(coerce(justification, 'right', 'Left')).toBe('Right');
    expect(coerce(justification, ' CENTER ', 'Left')).toBe('Center');
    expect(coerce(justification, 'Left', 'Right')).toBe('Left');
  });

  it('keeps the previous value for anything else', () => {
    for (const v of ['', 'middle', 'Left Right', 1, true, null, undefined, {}]) expect(coerce(justification, v, 'Center'), String(v)).toBe('Center');
  });

  it('does not find inherited members', () => {
    for (const v of ['__proto__', 'constructor', 'toString', 'length']) expect(coerce(justification, v, 'Left'), v).toBe('Left');
  });
});

describe('coerce: unknown types keep the previous value', () => {
  it('returns prev for a type it does not know', () => {
    expect(coerce(/** @type {any} */ ('quaternion'), 5, 'prev')).toBe('prev');
    expect(coerce(/** @type {any} */ ('__proto__'), 5, 'prev')).toBe('prev');
    expect(coerce(/** @type {any} */ ('constructor'), 5, 'prev')).toBe('prev');
  });
});

describe('parseBindPath', () => {
  it('reads dotted paths', () => {
    expect(parseBindPath('player.status')).toEqual({ root: 'player', segments: [{ name: 'status' }] });
    expect(parseBindPath('eq.gainLevel3')).toEqual({ root: 'eq', segments: [{ name: 'gainLevel3' }] });
    expect(parseBindPath('player.currentMedia.duration')).toEqual({
      root: 'player', segments: [{ name: 'currentMedia' }, { name: 'duration' }],
    });
    expect(parseBindPath('vidset')).toEqual({ root: 'vidset', segments: [] });
  });

  it('keeps the spelling, because the root resolves case-insensitively later', () => {
    expect(parseBindPath('Player.Controls.currentPosition')).toEqual({
      root: 'Player', segments: [{ name: 'Controls' }, { name: 'currentPosition' }],
    });
  });

  it('allows a trailing semicolon and blanks between tokens', () => {
    expect(parseBindPath('player.settings.volume;')).toEqual(parseBindPath('player.settings.volume'));
    expect(parseBindPath(' player . settings . volume ; ')).toEqual(parseBindPath('player.settings.volume'));
  });

  it('reads call segments with literal arguments', () => {
    expect(parseBindPath("player.settings.getMode('loop')")).toEqual({
      root: 'player', segments: [{ name: 'settings' }, { name: 'getMode', args: ['loop'] }],
    });
    expect(parseBindPath('player.settings.getMode("shuffle");')?.segments[1]).toEqual({ name: 'getMode', args: ['shuffle'] });
    expect(parseBindPath("a.f('x', 3, -1.5, true, FALSE, \"y\")")?.segments[0]).toEqual({ name: 'f', args: ['x', 3, -1.5, true, false, 'y'] });
    expect(parseBindPath('a.f()')?.segments[0]).toEqual({ name: 'f', args: [] });
    expect(parseBindPath("a.f('it\\'s')")?.segments[0]).toEqual({ name: 'f', args: ["it's"] });
  });

  it('refuses what is not a path', () => {
    const bad = ['', ' ', ';', '.', 'player.', '.player', 'player..status', 'player.settings.volume = value', 'player settings',
      '1abc', 'a.1b', 'foo(1)', 'foo(1).bar', 'a.f(x)', "a.f('x", "a.f('x'", "a.f('x',)", 'a.f(1 2)', 'a.f(,1)', 'a[0]', 'a.b;c', 'a.b;;',
      'a-b', 'a.f(true false)'];
    for (const s of bad) expect(parseBindPath(s), JSON.stringify(s)).toBeNull();
  });

  it('caps its input: path length, segment count, argument count', () => {
    expect(parseBindPath('a.' + 'b'.repeat(600))).toBeNull();
    // the root plus 16 segments is the longest accepted path
    expect(parseBindPath(Array.from({ length: 18 }, () => 'a').join('.'))).toBeNull();
    expect(parseBindPath(Array.from({ length: 17 }, () => 'a').join('.'))).not.toBeNull();
    expect(parseBindPath(`a.f(${Array.from({ length: 9 }, () => '1').join(',')})`)).toBeNull();
    expect(parseBindPath(`a.f(${Array.from({ length: 8 }, () => '1').join(',')})`)).not.toBeNull();
  });
});

/** @type {Array<[string, ElementKind, string, string, import('../../../src/engine/contracts').AttrSource]>} */
const CASES = [
  // jscript: prefix case-insensitive, optional leading blanks, trailing `;` left for the evaluator
  ['jscript:', 'subview', 'left', 'jscript:view.width-121', { kind: 'jscript', source: 'view.width-121' }],
  ['JScript:', 'subview', 'top', 'JScript:balance.top', { kind: 'jscript', source: 'balance.top' }],
  ['JSCRIPT:', 'text', 'width', 'JSCRIPT:view.width', { kind: 'jscript', source: 'view.width' }],
  [' jscript: (leading blank)', 'subview', 'top', ' jscript:view.height-76', { kind: 'jscript', source: 'view.height-76' }],
  ['jscript: (blank after the colon)', 'subview', 'top', 'jscript: equalizer1.top', { kind: 'jscript', source: 'equalizer1.top' }],
  ['jscript: trailing ;', 'subview', 'left', 'jscript:balance.left+balance.width+10;', { kind: 'jscript', source: 'balance.left+balance.width+10;' }],
  ['jscript: empty', 'subview', 'left', 'jscript:', { kind: 'jscript', source: '' }],
  ['jscript: string escapes', 'text', 'value', "JScript:'a\\r\\rb'", { kind: 'jscript', source: "'a\\r\\rb'" }],
  ['jscript: multi-line', 'text', 'value', 'jscript:\n a\n + b', { kind: 'jscript', source: 'a\n + b' }],
  ['jscript: on a boolean', 'button', 'visible', 'jscript:player.playstate!=psUndefined;', { kind: 'jscript', source: 'player.playstate!=psUndefined;' }],
  // wmpprop:
  ['wmpprop: simple', 'text', 'value', 'wmpprop:player.status', { kind: 'wmpprop', path: { root: 'player', segments: [{ name: 'status' }] } }],
  ['WMPPROP: any case', 'slider', 'value', 'WMPPROP:eq.gainLevel1', { kind: 'wmpprop', path: { root: 'eq', segments: [{ name: 'gainLevel1' }] } }],
  [' wmpprop: (leading blank)', 'slider', 'max', ' wmpprop:player.currentMedia.duration', { kind: 'wmpprop', path: { root: 'player', segments: [{ name: 'currentMedia' }, { name: 'duration' }] } }],
  ['wmpprop: a call', 'button', 'down', "wmpprop:player.settings.getMode('loop')", { kind: 'wmpprop', path: { root: 'player', segments: [{ name: 'settings' }, { name: 'getMode', args: ['loop'] }] } }],
  ['wmpprop: another element', 'subview', 'top', 'wmpprop:svEqualizerBottomMiddle.top', { kind: 'wmpprop', path: { root: 'svEqualizerBottomMiddle', segments: [{ name: 'top' }] } }],
  // wmpenabled: and wmpdisabled:
  ['wmpenabled: plain', 'button', 'enabled', 'wmpenabled:player.controls.play', { kind: 'wmpenabled', method: 'play' }],
  ['wmpenabled: with ;', 'button', 'visible', 'wmpenabled:player.controls.pause;', { kind: 'wmpenabled', method: 'pause' }],
  ['wmpenabled: with () and ;', 'button', 'enabled', 'wmpenabled:player.Controls.Play();', { kind: 'wmpenabled', method: 'play' }],
  ['wmpenabled: camel case folds', 'button', 'enabled', 'WMPENABLED:player.controls.fastForward', { kind: 'wmpenabled', method: 'fastforward' }],
  ['wmpenabled: bare name', 'button', 'tabStop', 'wmpenabled:next', { kind: 'wmpenabled', method: 'next' }],
  ['wmpenabled: on down', 'button', 'down', 'wmpenabled:player.controls.stop', { kind: 'wmpenabled', method: 'stop' }],
  ['wmpdisabled:', 'button', 'enabled', 'wmpdisabled:player.controls.stop', { kind: 'wmpdisabled', method: 'stop' }],
  ['wmpdisabled: on visible', 'button', 'visible', 'wmpdisabled:player.Controls.Previous();', { kind: 'wmpdisabled', method: 'previous' }],
  // res://
  ['res:// tooltip', 'button', 'uptooltip', 'res://-/RT_STRING/#1809', { kind: 'res', url: 'res://-/RT_STRING/#1809' }],
  ['res:// font face', 'text', 'fontface', 'res://wmploc/RT_STRING/#1888', { kind: 'res', url: 'res://wmploc/RT_STRING/#1888' }],
  ['res:// in a string attribute, odd case and blanks', 'text', 'tooltip', ' RES://wmploc.dll/RT_STRING/#2066 ', { kind: 'res', url: 'RES://wmploc.dll/RT_STRING/#2066' }],
  ['res:// image', 'button', 'image', 'res://wmploc.dll/RT_IMAGE/#2024', { kind: 'res', url: 'res://wmploc.dll/RT_IMAGE/#2024' }],
  ['res:// in scriptFile stays text (it is a ; list)', 'view', 'scriptFile', 'res://wmploc.dll/RT_TEXT/#132;', { kind: 'literal', text: 'res://wmploc.dll/RT_TEXT/#132;' }],
  ['res:// in a numeric attribute', 'subview', 'left', 'res://wmploc/RT_STRING/#1', { kind: 'literal', text: 'res://wmploc/RT_STRING/#1' }],
  ['res:// in an unknown attribute', 'button', 'nosuchattr', 'res://wmploc/RT_STRING/#1', { kind: 'literal', text: 'res://wmploc/RT_STRING/#1' }],
  // handlers: raw text, never classified
  ['handler: jscript: label kept', 'button', 'onclick', 'jscript:view.close();', { kind: 'handler', source: 'jscript:view.close();', params: [] }],
  ['handler: plain', 'button', 'onClick', 'player.controls.play()', { kind: 'handler', source: 'player.controls.play()', params: [] }],
  ['handler: empty', 'button', 'onclick', '', { kind: 'handler', source: '', params: [] }],
  ['handler: _onchange', 'slider', 'value_onchange', 'player.settings.balance=value;', { kind: 'handler', source: 'player.settings.balance=value;', params: [] }],
  ['handler: _onchange with wmpprop: label', 'slider', 'value_onchange', 'wmpprop:player.settings.volume = value;updateVolToolTip();', { kind: 'handler', source: 'wmpprop:player.settings.volume = value;updateVolToolTip();', params: [] }],
  ['handler: wmpenabled: text in onclick is script', 'button', 'onclick', 'wmpenabled:player.controls.play', { kind: 'handler', source: 'wmpenabled:player.controls.play', params: [] }],
  ['handler: res:// text in a handler is script', 'button', 'onclick', 'res://x', { kind: 'handler', source: 'res://x', params: [] }],
  ['handler: slider drag', 'slider', 'onDragEnd', 'player.controls.currentposition=value;', { kind: 'handler', source: 'player.controls.currentposition=value;', params: [] }],
  ['handler: controls tick', 'controls', 'currentPosition_onchange', 'OnPos();', { kind: 'handler', source: 'OnPos();', params: [] }],
  ['handler: view onload', 'view', 'onload', 'Init();', { kind: 'handler', source: 'Init();', params: [] }],
  ['handler: on* of an unknown element', 'unknown', 'onfoo', 'x()', { kind: 'handler', source: 'x()', params: [] }],
  ['handler: PLAYER bare PlayStateChange', 'player', 'playstatechange', 'vw_OnPlayStateChange(NewState);', { kind: 'handler', source: 'vw_OnPlayStateChange(NewState);', params: ['NewState'] }],
  ['handler: PLAYER openstatechange', 'player', 'openstatechange', 'vwPlayer_OnOpenStateChange(NewState);', { kind: 'handler', source: 'vwPlayer_OnOpenStateChange(NewState);', params: ['NewState'] }],
  ['handler: PLAYER modeChange keeps exact case', 'player', 'modeChange', 'updateShuffRep()', { kind: 'handler', source: 'updateShuffRep()', params: ['ModeName', 'NewValue'] }],
  ['handler: PLAYER scriptcommand', 'player', 'scriptcommand', 'cmd(scType, Param)', { kind: 'handler', source: 'cmd(scType, Param)', params: ['scType', 'Param'] }],
  ['handler: PLAYER positionchange', 'player', 'positionchange', 'f(oldPosition,newPosition)', { kind: 'handler', source: 'f(oldPosition,newPosition)', params: ['oldPosition', 'newPosition'] }],
  ['handler: PLAYER playlistchange', 'player', 'playlistchange', 'f(Playlist, change)', { kind: 'handler', source: 'f(Playlist, change)', params: ['Playlist', 'change'] }],
  ['handler: PLAYER onplaystatechange form', 'player', 'onplaystatechange', 'f(NewState)', { kind: 'handler', source: 'f(NewState)', params: ['NewState'] }],
  ['handler: PLAYER currentplaylistchange', 'player', 'currentplaylistchange', 'f(change)', { kind: 'handler', source: 'f(change)', params: ['change'] }],
  ['handler: PLAYER mediachange', 'player', 'mediachange', 'f(Item)', { kind: 'handler', source: 'f(Item)', params: ['Item'] }],
  ['handler: PLAYER cdrommediachange', 'player', 'cdrommediachange', 'f(CdromNum)', { kind: 'handler', source: 'f(CdromNum)', params: ['CdromNum'] }],
  ['handler: PLAYER an event without parameters', 'player', 'statuschange', 'f()', { kind: 'handler', source: 'f()', params: [] }],
  ['handler: PLAYER OpenState_onchange has none', 'player', 'OpenState_onchange', 'f()', { kind: 'handler', source: 'f()', params: [] }],
  ['not a handler: an event name off a PLAYER', 'button', 'playstatechange', 'f()', { kind: 'literal', text: 'f()' }],
  ['not a handler: a PLAYER property', 'player', 'url', 'http://example.com/a.wma', { kind: 'literal', text: 'http://example.com/a.wma' }],
  // literals
  ['literal number', 'subview', 'left', '12', { kind: 'literal', text: '12' }],
  ['literal with a trailing blank', 'view', 'width', '600 ', { kind: 'literal', text: '600 ' }],
  ['literal empty', 'text', 'value', '', { kind: 'literal', text: '' }],
  ['literal text with a colon', 'text', 'value', 'Note: hello', { kind: 'literal', text: 'Note: hello' }],
  ['literal URL', 'text', 'value', 'http://example.com/', { kind: 'literal', text: 'http://example.com/' }],
  ['javascript: is not an attribute prefix (spec 3.2)', 'text', 'value', 'javascript:alert(1)', { kind: 'literal', text: 'javascript:alert(1)' }],
  ['jscript in the middle is text', 'text', 'value', 'use jscript:x', { kind: 'literal', text: 'use jscript:x' }],
  ['a colour', 'text', 'foregroundcolor', '#FF00FF', { kind: 'literal', text: '#FF00FF' }],
];

describe('classifyValue', () => {
  it.each(CASES)('%s', (_label, kind, attr, raw, expected) => {
    expect(classifyValue(kind, attr, raw)).toEqual(expected);
    expect(classifyValueDiag(kind, attr, raw).source).toEqual(expected);
  });

  it('is case-insensitive in the attribute name', () => {
    expect(classifyValue('button', 'OnClick', 'x()').kind).toBe('handler');
    expect(classifyValue('slider', 'Value_OnChange', 'x()').kind).toBe('handler');
    expect(classifyValue('player', 'PlayStateChange', 'x(NewState)')).toMatchObject({ params: ['NewState'] });
    expect(classifyValue('text', 'FontFace', 'res://wmploc/RT_STRING/#1888').kind).toBe('res');
  });

  it('gives a handler its own copy of the parameter list', () => {
    const first = classifyValue('player', 'playstatechange', 'x');
    if (first.kind !== 'handler') throw new Error('not a handler');
    first.params.push('Evil');
    expect(classifyValue('player', 'playstatechange', 'x')).toMatchObject({ params: ['NewState'] });
  });

  it('does not mistake skin-controlled names for inherited members', () => {
    for (const attr of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      for (const kind of /** @type {ElementKind[]} */ (['button', 'player', 'unknown', 'theme'])) {
        expect(classifyValue(kind, attr, 'plain'), `${kind}.${attr}`).toEqual({ kind: 'literal', text: 'plain' });
        expect(classifyValue(kind, attr, 'res://wmploc/RT_STRING/#1'), `${kind}.${attr}`).toEqual({ kind: 'literal', text: 'res://wmploc/RT_STRING/#1' });
      }
    }
    expect(classifyValue('player', 'constructor', 'f()')).toEqual({ kind: 'literal', text: 'f()' });
    expect(classifyValue('player', '__proto__', 'f()')).toEqual({ kind: 'literal', text: 'f()' });
    expect(classifyValue('player', 'onconstructor', 'f()').kind).toBe('handler'); // an on* name is a handler on any kind
    // The values are skin text too: a prefix word that names an inherited member is plain text.
    expect(classifyValue('text', 'value', '__proto__:x')).toEqual({ kind: 'literal', text: '__proto__:x' });
    expect(classifyValue('text', 'value', 'constructor:x')).toEqual({ kind: 'literal', text: 'constructor:x' });
  });
});

describe('classifyValueDiag: diagnostics', () => {
  it.each([
    ['wmppprop:player.status', 'text', 'value', 'misspelled-prefix'],
    ['wmpenable:player.controls.play', 'button', 'enabled', 'misspelled-prefix'],
    ['wmpdisable:player.controls.play', 'button', 'enabled', 'misspelled-prefix'],
    ['wmprop:player.status', 'text', 'value', 'misspelled-prefix'],
    ['WMPPPROP:player.status', 'text', 'value', 'misspelled-prefix'],
    [' wmpenabeld:player.controls.play', 'button', 'visible', 'misspelled-prefix'],
  ])('%s stays a literal and carries a diagnostic', (raw, kind, attr, code) => {
    const { source, diagnostic } = classifyValueDiag(/** @type {ElementKind} */ (kind), attr, raw);
    expect(source).toEqual({ kind: 'literal', text: raw });
    expect(diagnostic).toMatchObject({ code, severity: 'warn' });
    expect(diagnostic?.detail).toContain(attr);
  });

  it.each([
    ['wmpprop:', 'text', 'value'],
    ['wmpprop:player.', 'text', 'value'],
    ['wmpprop:player.settings.volume = value', 'text', 'value'],
    ['wmpprop:foo(1)', 'text', 'value'],
    ['WMPPROP: a b', 'subview', 'left'],
  ])('%s is not a path: literal plus a diagnostic', (raw, kind, attr) => {
    const { source, diagnostic } = classifyValueDiag(/** @type {ElementKind} */ (kind), attr, raw);
    expect(source).toEqual({ kind: 'literal', text: raw });
    expect(diagnostic).toMatchObject({ code: 'invalid-binding-path', severity: 'warn' });
  });

  it.each([['wmpenabled:'], ['wmpdisabled:player.controls.'], ['wmpenabled:player.controls.pl ay'], ['wmpenabled:1']])(
    '%s names no method: literal plus a diagnostic',
    (raw) => {
      const { source, diagnostic } = classifyValueDiag('button', 'enabled', raw);
      expect(source).toEqual({ kind: 'literal', text: raw });
      expect(diagnostic).toMatchObject({ code: 'invalid-availability-name', severity: 'warn' });
    },
  );

  it('files no diagnostic for valid prefixes, handlers, or text that merely resembles one', () => {
    for (const [kind, attr, raw] of /** @type {Array<[ElementKind, string, string]>} */ ([
      ['text', 'value', 'wmpprop:player.status'], ['button', 'enabled', 'wmpenabled:player.controls.play'],
      ['button', 'enabled', 'wmpdisabled:player.controls.play'], ['text', 'value', 'jscript:1'],
      ['button', 'onclick', 'wmppprop:player.status'], ['slider', 'value_onchange', 'wmpenable:x'],
      ['text', 'value', 'WMP: ready'], ['text', 'value', 'wmpplayer: x'], ['text', 'value', 'Prop: x'], ['text', 'value', 'Script: x'],
      ['text', 'value', 'http://example.com'], ['text', 'value', '12:30'], ['text', 'value', ''],
    ])) {
      expect(classifyValueDiag(kind, attr, raw).diagnostic, `${attr}=${raw}`).toBeNull();
    }
  });

  it('bounds the skin text it copies into a diagnostic', () => {
    const raw = 'wmppprop:' + 'x'.repeat(5000);
    const { diagnostic } = classifyValueDiag('text', 'value', raw);
    expect(diagnostic?.code).toBe('misspelled-prefix');
    expect(/** @type {string} */ (diagnostic?.detail).length).toBeLessThan(200);
    const bad = classifyValueDiag('text', 'value', 'wmpprop:a b' + 'y'.repeat(5000)).diagnostic;
    expect(/** @type {string} */ (bad?.detail).length).toBeLessThan(200);
  });
});
