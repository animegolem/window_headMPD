// @ts-check
// W1.5: the wmploc shim, in the six groups of `wmploc 7.9`:
//   1 constants   2 sprintf (host copy and the realm text, run in QuickJS)   3 resolver and strings
//   4 scriptFile parsing and the library registry   5 corpus smoke (skips without skins/)
//   6 Headspace's `player.OpenState == osMediaOpen`
// The realm text is run in the real QuickJS build so a syntax or scope slip in it shows up here and
// not at W2.2. Every QuickJS handle is disposed: the module aborts at runtime disposal if one leaks.

import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SPRINTF_LIBRARY_SOURCE, STRING_IDS, loadString, lookupString, parseScriptFile, resolveRes,
  resolveStringAttribute, scriptLibrary, sprintf, wmplocConstants,
} from '../../../src/engine/realm/wmploc.js';
import { describeCorpus, describeHeadspace } from '../../support/fixtures.js';

// ---------------------------------------------------------------------------------------------
// A throwaway QuickJS realm

/** @type {Promise<import('quickjs-emscripten-core').QuickJSWASMModule> | undefined} */
let quickjs;
const getQuickJS = () => (quickjs ??= newQuickJSWASMModuleFromVariant(variant));

/**
 * Run `fn` with `run(src)` evaluating global code and returning the completion value as plain data.
 * @template T
 * @param {(run: (src: string) => any) => T} fn
 * @returns {Promise<T>}
 */
async function inRealm(fn) {
  const vm = (await getQuickJS()).newContext();
  try {
    return fn((src) => {
      const result = vm.evalCode(src);
      if (result.error) {
        const error = vm.dump(result.error);
        result.error.dispose();
        throw Object.assign(new Error(`${error.name}: ${error.message}`), { jsName: error.name });
      }
      const value = vm.dump(result.value);
      result.value.dispose();
      return value;
    });
  } finally {
    vm.dispose();
  }
}

/** `var name = <json>;` for each global, as the prelude would seed them. @param {Record<string, any>} globals */
const seed = (globals) => Object.entries(globals).map(([k, v]) => `var ${k} = ${JSON.stringify(v)};`).join('\n');

// ---------------------------------------------------------------------------------------------
// 1. Constants

// Transcribed from the MSDN tables for player.openState and player.playState, not derived from the
// module's own arrays, so a mis-ordered entry cannot agree with itself.
/** @type {Array<[string, number]>} */
const MSDN = [
  ['osUndefined', 0], ['osPlaylistChanging', 1], ['osPlaylistLocating', 2], ['osPlaylistConnecting', 3],
  ['osPlaylistLoading', 4], ['osPlaylistOpening', 5], ['osPlaylistOpenNoMedia', 6], ['osPlaylistChanged', 7],
  ['osMediaChanging', 8], ['osMediaLocating', 9], ['osMediaConnecting', 10], ['osMediaLoading', 11],
  ['osMediaOpening', 12], ['osMediaOpen', 13], ['osBeginCodecAcquisition', 14], ['osEndCodecAcquisition', 15],
  ['osBeginLicenseAcquisition', 16], ['osEndLicenseAcquisition', 17], ['osBeginIndividualization', 18],
  ['osEndIndividualization', 19], ['osMediaWaiting', 20],
  ['psUndefined', 0], ['psStopped', 1], ['psPaused', 2], ['psPlaying', 3], ['psScanForward', 4],
  ['psScanReverse', 5], ['psBuffering', 6], ['psWaiting', 7], ['psMediaEnded', 8], ['psTransitioning', 9],
  ['psReady', 10], ['psReconnecting', 11],
];

describe('1. constants (RT_TEXT #132)', () => {
  it.each(MSDN)('%s = %i', (name, value) => {
    expect(wmplocConstants()[name]).toBe(value);
  });

  it('holds exactly the 33 names, the extra and the event-type array', () => {
    expect(MSDN).toHaveLength(33);
    expect(Object.keys(wmplocConstants()).sort()).toEqual(
      [...MSDN.map(([n]) => n), 'osOpeningUnknownURL', 'WMPPlaylistChangeEventTypes'].sort());
  });

  it('adds osOpeningUnknownURL = 21 only with extras, on by default', () => {
    expect(wmplocConstants().osOpeningUnknownURL).toBe(21);
    expect(wmplocConstants({}).osOpeningUnknownURL).toBe(21);
    expect(wmplocConstants({ extras: true }).osOpeningUnknownURL).toBe(21);
    const strict = wmplocConstants({ extras: false });
    expect('osOpeningUnknownURL' in strict).toBe(false);
    expect(Object.keys(strict).sort()).toEqual([...MSDN.map(([n]) => n), 'WMPPlaylistChangeEventTypes'].sort());
  });

  it('carries the ten playlist-change event names, in order', () => {
    expect(wmplocConstants().WMPPlaylistChangeEventTypes).toEqual(
      ['Unknown', 'Clear', 'InfoChange', 'Move', 'Delete', 'Insert', 'Append', 'Private', 'NameChange', 'Morph']);
  });

  it('returns a fresh record each time, so a caller cannot change the next caller\'s', () => {
    const a = wmplocConstants();
    a.osMediaOpen = 99;
    /** @type {string[]} */ (a.WMPPlaylistChangeEventTypes).push('x');
    const b = wmplocConstants();
    expect(b.osMediaOpen).toBe(13);
    expect(b.WMPPlaylistChangeEventTypes).toHaveLength(10);
  });

  it('is a null-prototype record: `__proto__` and `constructor` find nothing', () => {
    const c = wmplocConstants();
    expect(Object.getPrototypeOf(c)).toBeNull();
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(key in c, key).toBe(false);
      expect(c[key], key).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. sprintf (RT_TEXT #169)

/** @type {Array<{ name: string, args: any[], expected: string }>} */
const SPRINTF_CASES = [
  { name: 'string form replaces every %s', args: ['%s and %s', 'x'], expected: 'x and x' },
  { name: 'string form with a unit', args: ['%sKbps', '128'], expected: '128Kbps' },
  { name: 'string form is case-sensitive about %s', args: ['%S %s', 'q'], expected: '%S q' },
  { name: 'array form is positional', args: ['%1 / %2', ['3:04', '4:20']], expected: '3:04 / 4:20' },
  { name: 'array form, placeholders out of order', args: ['%2 then %1', ['a', 'b']], expected: 'b then a' },
  { name: 'array form replaces only the first occurrence of each', args: ['%1 %1', ['x', 'y']], expected: 'x %1' },
  { name: 'array form ignores members beyond the placeholders', args: ['%1', ['a', 'b']], expected: 'a' },
  { name: 'array form, a placeholder with no member stays', args: ['%1 %2', ['a']], expected: 'a %2' },
  { name: 'array form, a member that holds the next placeholder is seen by the next round', args: ['%1 %2', ['%2', 'Z']], expected: 'Z %2' },
  { name: 'array form coerces members', args: ['%1', [7]], expected: '7' },
  { name: 'object form walks members in order', args: ['%1-%2', { a: 'x', b: 'y' }], expected: 'x-y' },
  { name: 'a number leaves the string alone', args: ['a %s b', 5], expected: 'a %s b' },
  { name: 'no second argument leaves the string alone', args: ['a %s b'], expected: 'a %s b' },
  { name: 'null leaves the string alone', args: ['a %s b', null], expected: 'a %s b' },
  { name: 'the replacement is literal: no $& pattern', args: ['%s', 'a$&b'], expected: 'a$&b' },
  { name: 'the replacement is literal: no $$ pattern', args: ['%1', ['$$']], expected: '$$' },
];

/** @param {any[]} args */
const callText = (args) => `sprintf(${args.map((a) => JSON.stringify(a)).join(', ')})`;

describe('2. sprintf', () => {
  describe.each(SPRINTF_CASES)('$name', ({ args, expected }) => {
    it('host copy', () => {
      expect(sprintf(args[0], args[1])).toBe(expected);
    });
    it('realm text, in QuickJS', async () => {
      const got = await inRealm((run) => run(`${SPRINTF_LIBRARY_SOURCE}\n${callText(args)}`));
      expect(got).toBe(expected);
    });
  });

  it('String.prototype.sprintf ignores its receiver', async () => {
    const got = await inRealm((run) => [
      run(`${SPRINTF_LIBRARY_SOURCE}\n"ignored".sprintf("%sKbps", "128")`),
      run('"ignored".sprintf("%1/%2", ["a", "b"])'),
      run('"ignored".sprintf("%1/%2")'),
    ]);
    expect(got).toEqual(['128Kbps', 'a/b', '%1/%2']);
  });

  it('installs sprintf, the method, the position helper and the format string as globals', async () => {
    const got = await inRealm((run) => run(`${SPRINTF_LIBRARY_SOURCE}
      [typeof sprintf, typeof "".sprintf, typeof WMPStringsFunction_GetPositionText, g_kPositionFormatString]`));
    expect(got).toEqual(['function', 'function', 'function', '%1 / %2']);
  });

  describe('WMPStringsFunction_GetPositionText', () => {
    /**
     * @param {{ position?: string, openState?: number, media?: { duration: number, durationString: string } | null }} state
     */
    const position = (state) => inRealm((run) => {
      const c = wmplocConstants();
      run(seed(c));
      run(`var player = ${JSON.stringify({
        openState: state.openState ?? c.osMediaOpen,
        controls: { currentPositionString: state.position ?? '' },
        currentMedia: state.media === undefined ? { duration: 0, durationString: '' } : state.media,
      })};`);
      run(SPRINTF_LIBRARY_SOURCE);
      return run('WMPStringsFunction_GetPositionText()');
    });

    it('is "" when there is no position text', async () => {
      expect(await position({ position: '', media: { duration: 180, durationString: '3:00' } })).toBe('');
    });
    it('is "position / duration" for an open media with a duration', async () => {
      expect(await position({ position: '1:00', media: { duration: 180, durationString: '3:00' } })).toBe('1:00 / 3:00');
    });
    it('is just the position when the media is not open, has no duration, or is absent', async () => {
      const media = { duration: 180, durationString: '3:00' };
      expect(await position({ position: '1:00', openState: 0, media })).toBe('1:00');
      expect(await position({ position: '1:00', media: { duration: 0, durationString: '0:00' } })).toBe('1:00');
      expect(await position({ position: '1:00', media: null })).toBe('1:00');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Resolver and strings

/** The 47 ids of `wmploc 5.3`, transcribed from that table. */
const CORPUS_STRING_IDS = [
  217, 1273, 1807, 1808, 1809, 1810, 1811, 1812, 1813, 1814, 1815, 1816, 1817, 1827, 1845, 1846, 1848, 1849, 1851,
  1888, 1910, 1998, 1999, 2063, 2066, 2077, 2078, 2079, 2080, 2081, 2086, 2092, 2097, 2098, 2099, 2108, 2109, 2110,
  2114, 2130, 2150, 3904, 3905, 3906, 3907, 3908, 3909,
];

/** The id #169's position text loads (`wmploc 7.6`): in the table, though no corpus skin names it. */
const POSITION_FORMAT_ID = 2091;

describe('3. resolver', () => {
  it.each([
    ['res://wmploc.dll/RT_TEXT/#132', { module: 'wmploc', type: 'RT_TEXT', id: 132 }],
    ['res://wmploc/RT_TEXT/#132', { module: 'wmploc', type: 'RT_TEXT', id: 132 }],
    ['res://-/RT_TEXT/#169', { module: 'wmploc', type: 'RT_TEXT', id: 169 }],
    ['res://-/RT_STRING/#1812', { module: 'wmploc', type: 'RT_STRING', id: 1812 }],
    ['res://WMPLOC.DLL/RT_STRING/#2099', { module: 'wmploc', type: 'RT_STRING', id: 2099 }],
    ['RES://Wmploc.Dll/rt_string/#2099', { module: 'wmploc', type: 'RT_STRING', id: 2099 }],
    ['res://wmploc/Rt_Image/#1770', { module: 'wmploc', type: 'RT_IMAGE', id: 1770 }],
    ['res://wmploc.dll/RT_BITMAP/#373', { module: 'wmploc', type: 'RT_BITMAP', id: 373 }],
    ['res://-/#1792', { module: 'wmploc', type: '', id: 1792 }],
    ['res://wmploc/#1691', { module: 'wmploc', type: '', id: 1691 }],
    ['res://wmploc/RT_STRING/#00132', { module: 'wmploc', type: 'RT_STRING', id: 132 }],
    ['  res://-/RT_STRING/#1812 \n', { module: 'wmploc', type: 'RT_STRING', id: 1812 }],
  ])('accepts %j', (url, expected) => {
    expect(resolveRes(url)).toEqual(expected);
  });

  it('resolves a string built at run time, as the corpus does', () => {
    const formatStringID = POSITION_FORMAT_ID;
    expect(resolveRes('res://wmploc/RT_STRING/#' + formatStringID)).toEqual({ module: 'wmploc', type: 'RT_STRING', id: 2091 });
  });

  it.each([
    ['an unknown module', 'res://wmpui.dll/RT_STRING/#1812'],
    ['an empty module', 'res:///RT_STRING/#1812'],
    ['wmploc with a double extension', 'res://wmploc.dll.dll/RT_STRING/#1812'],
    ['a module that merely starts with wmploc', 'res://wmploc2/RT_STRING/#1812'],
    ['an unknown type', 'res://wmploc/RT_FOO/#1812'],
    ['RT_RCDATA, a real type we do not map', 'res://wmploc/RT_RCDATA/#1812'],
    ['a numeric type', 'res://wmploc/256/#132'],
    ['a missing id', 'res://wmploc/RT_STRING/#'],
    ['a non-numeric id', 'res://wmploc/RT_STRING/#12a'],
    ['a signed id', 'res://wmploc/RT_STRING/#-1'],
    ['an id written without #', 'res://wmploc/RT_STRING/1812'],
    ['an id that overflows a double', `res://wmploc/RT_STRING/#${'9'.repeat(40)}`],
    ['a run-time string built from undefined', 'res://wmploc/RT_STRING/#' + undefined],
    ['a nested path', 'res://wmploc/RT_STRING/extra/#1812'],
    ['another scheme', 'file://wmploc/RT_STRING/#1812'],
    ['a plain file name', 'headspace.js'],
    ['the empty string', ''],
  ])('rejects %s', (_what, url) => {
    expect(resolveRes(url)).toBeNull();
  });

  it('rejects a non-string', () => {
    for (const v of [undefined, null, 132, {}, ['res://wmploc/RT_TEXT/#132']]) expect(resolveRes(/** @type {any} */ (v))).toBeNull();
  });

  it('finds nothing for the skin-controlled keys `__proto__` and `constructor`', () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(resolveRes(`res://${key}/RT_STRING/#1812`), `module ${key}`).toBeNull();
      expect(resolveRes(`res://wmploc/${key}/#1812`), `type ${key}`).toBeNull();
      expect(resolveRes(`res://wmploc/${key.toUpperCase()}/#1812`), `type ${key.toUpperCase()}`).toBeNull();
      expect(scriptLibrary(`res://wmploc/RT_TEXT/#${key}`), `id ${key}`).toBeNull();
      expect(resolveStringAttribute(key, 'res://wmploc/RT_STRING/#1812').value, `attribute ${key}`).toBe('res://wmploc/RT_STRING/#1812');
      expect(parseScriptFile(`${key};res://${key}/RT_TEXT/#132`)).toEqual([
        { kind: 'script', path: key }, { kind: 'unknown-res', url: `res://${key}/RT_TEXT/#132` }]);
    }
  });
});

describe('3. loadString and the string table', () => {
  it('holds exactly the 47 corpus ids and #2091', () => {
    expect(CORPUS_STRING_IDS).toHaveLength(47);
    expect([...STRING_IDS]).toHaveLength(48);
    expect([...STRING_IDS]).toEqual([...CORPUS_STRING_IDS, POSITION_FORMAT_ID].sort((a, b) => a - b));
  });

  it('answers #2091 with the position format, positional and raw (wmploc 7.6)', () => {
    const url = `res://wmploc/RT_STRING/#${POSITION_FORMAT_ID}`;
    expect(loadString(url)).toBe('%1 / %2');
    expect(lookupString(url)).toEqual({ text: '%1 / %2', problem: null });
    expect(loadString(`res://-/rt_string/#${POSITION_FORMAT_ID}`)).toBe('%1 / %2');
    expect(sprintf(loadString(url), ['1:05', '3:30'])).toBe('1:05 / 3:30');
  });

  it('is the literal #169 loads into g_kPositionFormatString', async () => {
    const got = await inRealm((run) => run(`${SPRINTF_LIBRARY_SOURCE}\ng_kPositionFormatString`));
    expect(got).toBe(loadString(`res://wmploc/RT_STRING/#${POSITION_FORMAT_ID}`));
  });

  it('resolves #2091 as a string attribute like any other id', () => {
    expect(resolveStringAttribute('toolTip', `res://wmploc/RT_STRING/#${POSITION_FORMAT_ID}`))
      .toEqual({ value: '%1 / %2', problem: null });
  });

  it('only RT_STRING names #2091: a type-less or RT_TEXT URL does not', () => {
    expect(lookupString(`res://wmploc/#${POSITION_FORMAT_ID}`)).toEqual({ text: '', problem: 'wrong-type' });
    expect(lookupString(`res://wmploc/RT_TEXT/#${POSITION_FORMAT_ID}`)).toEqual({ text: '', problem: 'wrong-type' });
  });

  it.each(CORPUS_STRING_IDS)('id %i resolves to non-blank text under every spelling of the module', (id) => {
    const text = loadString(`res://wmploc.dll/RT_STRING/#${id}`);
    expect(text.trim()).not.toBe('');
    expect(loadString(`res://wmploc/RT_STRING/#${id}`)).toBe(text);
    expect(loadString(`res://-/rt_string/#${id}`)).toBe(text);
  });

  it('keeps the format templates raw, never blank', () => {
    const at = (/** @type {number} */ id) => loadString(`res://wmploc/RT_STRING/#${id}`);
    expect(at(2063)).toContain('%d%%');
    expect(at(2066)).toContain('%s');
    expect(at(2078)).toContain('%s');
    expect(at(2086)).toMatch(/%1.*%2/);
    expect(at(2099)).toContain('%s%');
  });

  it('formats through sprintf as a skin would', () => {
    const at = (/** @type {number} */ id) => loadString(`res://wmploc/RT_STRING/#${id}`);
    expect(sprintf(at(2066), '128')).toBe('128Kbps');
    expect(sprintf(at(2078), 'Acme')).toContain('Acme');
    expect(sprintf(at(2086), ['3', 'Intro'])).toBe('3, Intro');
    expect(sprintf(at(2099), '50')).toMatch(/^50% /);
    expect(sprintf(at(2063), '50')).toBe(at(2063));  // the `%d%%` template is not a sprintf placeholder (wmploc 5.4)
  });

  it('keeps the two non-prose values what they are', () => {
    expect(loadString('res://-/RT_STRING/#1888')).toBe('Arial');
    expect(loadString('res://-/RT_STRING/#1910')).toBe('left');
  });

  it('returns "" for an unknown id, a non-string resource, an unresolvable URL and a non-string', () => {
    expect(loadString('res://wmploc/RT_STRING/#2090')).toBe('');        // a neighbour of #2091 that the table does not hold
    expect(loadString('res://wmploc/RT_STRING/#1')).toBe('');
    expect(loadString('res://wmploc/RT_TEXT/#132')).toBe('');
    expect(loadString('res://wmploc/#1812')).toBe('');
    expect(loadString('res://wmpui.dll/RT_STRING/#1812')).toBe('');
    expect(loadString('Close')).toBe('');
    expect(loadString(/** @type {any} */ (undefined))).toBe('');
  });

  it('says why a lookup was empty', () => {
    expect(lookupString('res://wmploc/RT_STRING/#1812')).toEqual({ text: expect.any(String), problem: null });
    expect(lookupString('Close')).toEqual({ text: '', problem: 'unresolved' });
    expect(lookupString('res://wmploc/RT_IMAGE/#1812')).toEqual({ text: '', problem: 'wrong-type' });
    expect(lookupString('res://wmploc/RT_STRING/#1')).toEqual({ text: '', problem: 'unknown-id' });
  });
});

describe('3. resolveStringAttribute', () => {
  const close = loadString('res://-/RT_STRING/#1812');

  it.each(['toolTip', 'upToolTip', 'downToolTip', 'value', 'accName', 'accKeyboardShortcut', 'fontFace',
    'scrollingDirection', 'author', 'copyright', 'TOOLTIP'])('resolves a res:// value of %s', (attribute) => {
    expect(resolveStringAttribute(attribute, 'res://-/RT_STRING/#1812')).toEqual({ value: close, problem: null });
  });

  it('leaves other attributes and other values alone', () => {
    expect(resolveStringAttribute('backgroundImage', 'res://-/#1792')).toEqual({ value: 'res://-/#1792', problem: null });
    expect(resolveStringAttribute('toolTip', 'Close')).toEqual({ value: 'Close', problem: null });
    expect(resolveStringAttribute('value', '')).toEqual({ value: '', problem: null });
  });

  it('blanks an unresolved text value but keeps a usable face and direction', () => {
    expect(resolveStringAttribute('toolTip', 'res://wmploc/RT_STRING/#1')).toEqual({ value: '', problem: 'unknown-id' });
    expect(resolveStringAttribute('value', 'res://wmpui.dll/RT_STRING/#1812')).toEqual({ value: '', problem: 'unresolved' });
    expect(resolveStringAttribute('fontFace', 'res://wmploc/RT_STRING/#1')).toEqual({ value: 'Arial', problem: 'unknown-id' });
    expect(resolveStringAttribute('scrollingDirection', 'res://nowhere/RT_STRING/#1')).toEqual({ value: 'left', problem: 'unresolved' });
  });

  it('resolves a value with surrounding whitespace the way the resolver does', () => {
    expect(resolveStringAttribute('toolTip', ' res://-/RT_STRING/#1812 ').value).toBe(close);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. scriptFile parsing and the library registry

describe('4. library registry', () => {
  it('knows #132, #134, #136 and #169, whichever spelling names them', () => {
    for (const url of ['res://wmploc.dll/RT_TEXT/#132', 'res://wmploc/RT_TEXT/#132', 'res://-/rt_text/#132']) {
      expect(scriptLibrary(url)?.id, url).toBe(132);
    }
    expect(scriptLibrary('res://-/RT_TEXT/#134')?.id).toBe(134);
    expect(scriptLibrary('res://-/RT_TEXT/#136')?.id).toBe(136);
    expect(scriptLibrary('res://-/RT_TEXT/#169')?.id).toBe(169);
  });

  it('#132 is installed before any script, whether or not listed; the rest when listed', () => {
    expect(scriptLibrary('res://wmploc/RT_TEXT/#132')).toEqual({
      id: 132, install: 'before-scripts', constants: wmplocConstants(), source: '' });
    for (const id of [134, 136, 169]) expect(scriptLibrary(`res://wmploc/RT_TEXT/#${id}`)?.install, `#${id}`).toBe('when-listed');
  });

  it('passes extras through to #132', () => {
    expect('osOpeningUnknownURL' in (scriptLibrary('res://wmploc/RT_TEXT/#132', { extras: false })?.constants ?? {})).toBe(false);
    expect(scriptLibrary('res://wmploc/RT_TEXT/#132')?.constants.osOpeningUnknownURL).toBe(21);
  });

  it('#134 and #136 are the font sizes and the visualizer requests', () => {
    expect({ ...scriptLibrary('res://wmploc/RT_TEXT/#134')?.constants }).toEqual({ g_kSMALL_FONTSIZE: 8, g_kMEDIUM_FONTSIZE: 9 });
    expect({ ...scriptLibrary('res://wmploc/RT_TEXT/#136')?.constants }).toEqual({
      VR_PRESET_PREV: 1, VR_PRESET_NEXT: 2, VR_VIZ_PREV: 3, VR_VIZ_NEXT: 4, VR_EXIT_PLAYER: 999 });
    expect(scriptLibrary('res://wmploc/RT_TEXT/#134')?.source).toBe('');
    expect(scriptLibrary('res://wmploc/RT_TEXT/#136')?.source).toBe('');
  });

  it('#169 ships the sprintf text and no data globals', () => {
    const lib = scriptLibrary('res://-/RT_TEXT/#169');
    expect(lib?.source).toBe(SPRINTF_LIBRARY_SOURCE);
    expect(Object.keys(lib?.constants ?? {})).toEqual([]);
  });

  it('every library record is a null-prototype record, so skin names find nothing in it', () => {
    for (const id of [132, 134, 136, 169]) {
      const constants = scriptLibrary(`res://wmploc/RT_TEXT/#${id}`)?.constants;
      expect(Object.getPrototypeOf(constants), `#${id}`).toBeNull();
      expect('constructor' in /** @type {object} */ (constants), `#${id}`).toBe(false);
    }
  });

  it('refuses the built-in skin scripts, other types and type-less ids', () => {
    for (const id of [142, 143, 2540, 4003, 4004, 4011, 4013, 0, 1]) expect(scriptLibrary(`res://wmploc/RT_TEXT/#${id}`), `#${id}`).toBeNull();
    expect(scriptLibrary('res://wmploc/RT_STRING/#132')).toBeNull();
    expect(scriptLibrary('res://wmploc/RT_IMAGE/#132')).toBeNull();
    expect(scriptLibrary('res://wmploc/#132')).toBeNull();
    expect(scriptLibrary('res://wmpui.dll/RT_TEXT/#132')).toBeNull();
    expect(scriptLibrary('headspace.js')).toBeNull();
  });

  it('hands out a fresh library each call', () => {
    const a = scriptLibrary('res://wmploc/RT_TEXT/#136');
    if (a) a.constants.VR_PRESET_PREV = 7;
    expect(scriptLibrary('res://wmploc/RT_TEXT/#136')?.constants.VR_PRESET_PREV).toBe(1);
  });

  it('seeds a realm: constants, then the #169 text, then a skin that shadows sprintf wins', async () => {
    const got = await inRealm((run) => {
      for (const id of [132, 134, 136, 169]) {
        const lib = scriptLibrary(`res://wmploc/RT_TEXT/#${id}`);
        if (lib) { run(seed(lib.constants)); if (lib.source) run(lib.source); }
      }
      const before = run('[osMediaOpen, psPlaying, VR_EXIT_PLAYER, g_kMEDIUM_FONTSIZE, sprintf("%s!", "a")]');
      run('function sprintf(str, s) { return "skin"; }');
      return [before, run('sprintf("%s", "a")')];
    });
    expect(got).toEqual([[13, 3, 999, 9, 'a!'], 'skin']);
  });
});

describe('4. scriptFile parsing', () => {
  const lib = (/** @type {number} */ id) => expect.objectContaining({ id });

  it('reads the common shape: a script, then #132 with a trailing ;', () => {
    expect(parseScriptFile('roundlet.js;res://wmploc.dll/RT_TEXT/#132;')).toEqual([
      { kind: 'script', path: 'roundlet.js' },
      { kind: 'library', url: 'res://wmploc.dll/RT_TEXT/#132', library: lib(132) },
    ]);
  });

  it('reads Headspace\'s form, with no trailing ; and no .dll', () => {
    expect(parseScriptFile('headspace.js;res://wmploc/RT_TEXT/#132')).toEqual([
      { kind: 'script', path: 'headspace.js' },
      { kind: 'library', url: 'res://wmploc/RT_TEXT/#132', library: lib(132) },
    ]);
  });

  it('trims entries and drops empty ones (two spaces, stray semicolons)', () => {
    expect(parseScriptFile('  a.js  ;; ;\t b.js ;  ')).toEqual([
      { kind: 'script', path: 'a.js' }, { kind: 'script', path: 'b.js' }]);
    expect(parseScriptFile('')).toEqual([]);
    expect(parseScriptFile(';;;')).toEqual([]);
    expect(parseScriptFile(undefined)).toEqual([]);
    expect(parseScriptFile(null)).toEqual([]);
  });

  it('keeps the order of a five-entry list', () => {
    const entries = parseScriptFile('a.js;res://wmploc/RT_TEXT/#134;b.js;res://-/RT_TEXT/#169;res://wmploc.dll/RT_TEXT/#132;');
    expect(entries.map((e) => (e.kind === 'script' ? e.path : e.kind === 'library' ? `#${e.library.id}` : e.url)))
      .toEqual(['a.js', '#134', 'b.js', '#169', '#132']);
  });

  it('skips an unknown res:// entry and still loads its siblings', () => {
    expect(parseScriptFile('a.js;res://wmploc/RT_TEXT/#4003;b.js;res://wmpui.dll/RT_TEXT/#132;res://wmploc/RT_STRING/#132;res://wmploc.dll/RT_TEXT/#132')).toEqual([
      { kind: 'script', path: 'a.js' },
      { kind: 'unknown-res', url: 'res://wmploc/RT_TEXT/#4003' },
      { kind: 'script', path: 'b.js' },
      { kind: 'unknown-res', url: 'res://wmpui.dll/RT_TEXT/#132' },
      { kind: 'unknown-res', url: 'res://wmploc/RT_STRING/#132' },
      { kind: 'library', url: 'res://wmploc.dll/RT_TEXT/#132', library: lib(132) },
    ]);
  });

  it('lists a missing script like any other: whether the archive has it is the loader\'s question', () => {
    expect(parseScriptFile('patton.js;res://wmploc.dll/RT_TEXT/#132;')[0]).toEqual({ kind: 'script', path: 'patton.js' });
  });

  it('appends <stem>.js as an implicit last entry unless it is already listed, in any case', () => {
    expect(parseScriptFile('res://wmploc/RT_TEXT/#132', { stem: 'kids' })).toEqual([
      { kind: 'library', url: 'res://wmploc/RT_TEXT/#132', library: lib(132) },
      { kind: 'script', path: 'kids.js', implicit: true },
    ]);
    expect(parseScriptFile(undefined, { stem: 'kids' })).toEqual([{ kind: 'script', path: 'kids.js', implicit: true }]);
    expect(parseScriptFile('KIDS.JS', { stem: 'kids' })).toEqual([{ kind: 'script', path: 'KIDS.JS' }]);
    expect(parseScriptFile('other.js;kids.js', { stem: 'Kids' }).filter((e) => e.kind === 'script' && e.implicit)).toEqual([]);
    expect(parseScriptFile('other.js', { stem: '' })).toEqual([{ kind: 'script', path: 'other.js' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Corpus smoke (wmploc 7.9 item 5). Skips when skins/ is absent.

const decoder = {
  /** @param {Uint8Array} u8 */
  text(u8) {
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
    if (u8.length > 3 && u8[1] === 0 && u8[3] === 0 && u8[0] !== 0 && u8[2] !== 0) return new TextDecoder('utf-16le').decode(u8);
    return new TextDecoder('latin1').decode(u8);
  },
};

/** @param {string} s */
const decodeEntities = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Blank out comments and string literals, keeping everything else (and the line structure). A string
 * ends at a raw newline, so a regex literal that holds a quote costs one line at most.
 * @param {string} src
 */
function stripCommentsAndStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else if (c === '"' || c === "'") {
      out += ' ';
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
      if (src[i] === '\n') out += '\n';
    } else {
      out += c;
    }
  }
  return out;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'with', 'new',
  'delete', 'void', 'instanceof', 'in', 'else', 'do', 'throw', 'case', 'try', 'var']);
const BUILTINS = new Set(['parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval', 'escape', 'unescape', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date',
  'RegExp', 'Error', 'Function', 'Math', 'ActiveXObject', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'Enumerator', 'VBArray', 'GetObject', 'CollectGarbage', 'ScriptEngine', 'alert']);
// Documented methods of an element, callable bare from its own handlers (`wmploc 4.3`).
const ELEMENT_METHODS = new Set(['previous', 'next', 'moveto', 'slideto', 'movesizeto', 'alphablendto', 'nextpreset',
  'previouspreset', 'click', 'getbutton', 'settings']);
const IDENT = '[A-Za-z_$][\\w$]*';

/** Identifiers a script declares: functions, vars, parameters, assignment targets, catch variables. @param {string} code */
function declaredNames(code) {
  const names = new Set();
  for (const m of code.matchAll(new RegExp(`\\bfunction\\s+(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of code.matchAll(new RegExp(`\\bfunction\\s*(?:${IDENT})?\\s*\\(([^)]*)\\)`, 'g'))) {
    for (const p of m[1].split(',')) if (p.trim()) names.add(p.trim());
  }
  for (const m of code.matchAll(new RegExp(`\\bcatch\\s*\\(\\s*(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of code.matchAll(new RegExp(`\\bvar\\s+([^;]*)`, 'g'))) {
    for (const part of m[1].split(',')) { const id = new RegExp(`^\\s*(${IDENT})`).exec(part); if (id) names.add(id[1]); }
  }
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})\\s*=(?!=)`, 'g'))) names.add(m[1]);
  return names;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ wms: string[], js: string[] } | null}  null when the archive cannot be read
 */
function readScripts(bytes) {
  try {
    const files = unzipSync(bytes, { filter: (f) => /\.(wms|js)$/i.test(f.name) });
    /** @type {{ wms: string[], js: string[] }} */
    const out = { wms: [], js: [] };
    for (const [name, data] of Object.entries(files)) (/\.wms$/i.test(name) ? out.wms : out.js).push(decoder.text(data));
    return out;
  } catch {
    return null;
  }
}

/** Attributes of a `.wms`: `[name, decoded value]`. @param {string} wms */
function attributes(wms) {
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const m of wms.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.push([m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? '')]);
  return out;
}

/** Everything the corpus scan learns about one archive. */
function scanSkin(/** @type {{ wms: string[], js: string[] }} */ scripts) {
  /** @type {string[]} */ const scriptFiles = [];
  /** @type {string[]} */ const codeParts = [...scripts.js];
  /** @type {number[]} */ const stringIds = [];
  for (const wms of scripts.wms) {
    for (const [name, value] of attributes(wms)) {
      if (name === 'scriptfile') scriptFiles.push(value);
      if (/^on\w+$/.test(name) || name.endsWith('_onchange')) codeParts.push(value.replace(/^\s*(?:jscript|javascript):/i, ''));
      else if (/^\s*jscript:/i.test(value)) codeParts.push(value.replace(/^\s*jscript:/i, ''));
    }
  }
  const everything = [...scripts.js, ...scripts.wms].join('\n');
  for (const m of everything.matchAll(/res:\/\/[^"'\s;)]*?RT_STRING\/#(\d+)/gi)) stringIds.push(Number(m[1]));

  const code = stripCommentsAndStrings(codeParts.join('\n;\n'));
  const declared = declaredNames(code);
  const declaredLower = new Map([...declared].map((n) => [n.toLowerCase(), n]));

  /** @type {string[]} */ const constantReads = [];
  for (const m of code.matchAll(/(?<![\w$.])((?:os|ps)[A-Z][\w$]*)/g)) if (!declared.has(m[1])) constantReads.push(m[1]);

  /** @type {string[]} */ const unresolvedCalls = [];
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?<!\\bfunction\\s+)(?<!\\bnew\\s+)(${IDENT})\\s*\\(`, 'g'))) {
    const name = m[1];
    if (!KEYWORDS.has(name) && !BUILTINS.has(name) && !declared.has(name)) unresolvedCalls.push(name);
  }
  return { scriptFiles, constantReads, unresolvedCalls, declared, declaredLower, stringIds };
}

describeCorpus('5. corpus smoke (wmploc 7.9 item 5)', (corpus) => {
  /** @type {{ readable: number, unreadable: string[], unique: number, scriptFileAttrs: number,
   *   resEntries: Array<{ archive: string, entry: import('../../../src/engine/realm/wmploc.js').ScriptEntry }>,
   *   includers132: Set<string>, constantGaps: Map<string, string[]>,
   *   buckets: { A: number, B1: number, B2: number, C: Map<string, string[]> }, distinctUnresolved: Set<string>,
   *   stringIdsOutside: Map<number, string[]> }} */
  let scan;

  beforeAll(() => {
    const constants = wmplocConstants();
    const shimNames = new Set([...Object.keys(constants), 'sprintf', 'WMPStringsFunction_GetPositionText',
      'g_kPositionFormatString', 'g_kSMALL_FONTSIZE', 'g_kMEDIUM_FONTSIZE', 'VR_PRESET_PREV', 'VR_PRESET_NEXT',
      'VR_VIZ_PREV', 'VR_VIZ_NEXT', 'VR_EXIT_PLAYER']);
    const known = new Set(STRING_IDS);
    scan = {
      readable: 0, unreadable: [], unique: 0, scriptFileAttrs: 0, resEntries: [], includers132: new Set(),
      constantGaps: new Map(), buckets: { A: 0, B1: 0, B2: 0, C: new Map() }, distinctUnresolved: new Set(),
      stringIdsOutside: new Map(),
    };
    const hashes = new Set();
    for (const archive of corpus.archives('wmp')) {
      const scripts = readScripts(corpus.read(archive));
      if (!scripts) { scan.unreadable.push(archive.name); continue; }
      scan.readable++;
      hashes.add(createHash('sha1').update([...scripts.wms, ...scripts.js].join('').replace(/\s+/g, '')).digest('hex'));
      const skin = scanSkin(scripts);

      /** @type {Set<number>} */ const listed = new Set();
      for (const value of skin.scriptFiles) {
        scan.scriptFileAttrs++;
        for (const entry of parseScriptFile(value)) {
          if (entry.kind === 'script') continue;
          scan.resEntries.push({ archive: archive.name, entry });
          if (entry.kind === 'library') {
            listed.add(entry.library.id);
            if (entry.library.id === 132) scan.includers132.add(archive.name);
          }
        }
      }

      if (listed.has(132)) {
        for (const name of new Set(skin.constantReads)) {
          if (!(name in constants)) scan.constantGaps.set(name, [...(scan.constantGaps.get(name) ?? []), archive.name]);
        }
      }
      for (const name of skin.unresolvedCalls) {
        scan.distinctUnresolved.add(name);
        if (shimNames.has(name) && !(name === 'sprintf' && listed.has(169))) {
          scan.buckets.C.set(name, [...(scan.buckets.C.get(name) ?? []), archive.name]);
        } else if (ELEMENT_METHODS.has(name.toLowerCase())) scan.buckets.A++;
        else if (skin.declaredLower.has(name.toLowerCase())) scan.buckets.B1++;
        else scan.buckets.B2++;
      }
      for (const id of skin.stringIds) {
        if (!known.has(id)) scan.stringIdsOutside.set(id, [...(scan.stringIdsOutside.get(id) ?? []), archive.name]);
      }
    }
    scan.unique = hashes.size;
    const unresolved = scan.buckets.A + scan.buckets.B1 + scan.buckets.B2;
    console.info(`[wmploc corpus] archives readable ${scan.readable}, unreadable ${scan.unreadable.length} (${scan.unreadable.join(', ')}); `
      + `distinct by wms+js hash ${scan.unique}; scriptFile attributes ${scan.scriptFileAttrs}; res:// entries ${scan.resEntries.length} `
      + `(#132: ${scan.resEntries.filter((r) => r.entry.kind === 'library' && r.entry.library.id === 132).length}, `
      + `#169: ${scan.resEntries.filter((r) => r.entry.kind === 'library' && r.entry.library.id === 169).length}); `
      + `archives including #132: ${scan.includers132.size}; unresolved bare calls A ${scan.buckets.A}, B1 ${scan.buckets.B1}, `
      + `B2 ${scan.buckets.B2} (total ${unresolved}, ${scan.distinctUnresolved.size} distinct names), C ${scan.buckets.C.size}`);
  }, 300_000);

  // The numbers are the research's (`wmploc 3.1`, `4.1`): this scan, written independently of the
  // Python one, lands on every one of them. A corpus that changes should fail here and be reviewed.
  it('reads all 342 archives and finds the research\'s 195 distinct skins', () => {
    expect(scan.unreadable).toEqual([]);
    expect(scan.readable).toBe(342);
    expect(scan.unique).toBe(195);
  });

  it('every res:// scriptFile entry is #132 (433) or #169 (4), and #132 is in 243 archives', () => {
    const unknown = scan.resEntries.filter((r) => r.entry.kind === 'unknown-res').map((r) => `${r.archive}: ${/** @type {any} */ (r.entry).url}`);
    expect(unknown).toEqual([]);
    const count = (/** @type {number} */ id) => scan.resEntries.filter((r) => r.entry.kind === 'library' && r.entry.library.id === id).length;
    expect({ total: scan.resEntries.length, 132: count(132), 169: count(169) }).toEqual({ total: 437, 132: 433, 169: 4 });
    expect(scan.includers132.size).toBe(243);
  });

  it('no skin that includes #132 reads an os*/ps* name the constants lack', () => {
    expect(Object.fromEntries(scan.constantGaps)).toEqual({});
  });

  it('the unresolved bare calls fall in buckets A 53, B1 43, B2 308 (81 names) and none in C', () => {
    expect(Object.fromEntries(scan.buckets.C)).toEqual({});
    expect({ A: scan.buckets.A, B1: scan.buckets.B1, B2: scan.buckets.B2, names: scan.distinctUnresolved.size })
      .toEqual({ A: 53, B1: 43, B2: 308, names: 81 });
  });

  it('every literal RT_STRING id a skin names is in the table', () => {
    expect(Object.fromEntries(scan.stringIdsOutside)).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Headspace (wmploc 7.9 item 6)

// ENGINE D6.2: what the object model will say for each MPD situation. Written out here from that
// table, because the shim does not own the mapping, only the numbers.
/**
 * @param {{ connected: boolean, song: object | null, queueLength: number }} mpd
 */
function openStateFor(mpd) {
  const c = wmplocConstants();
  return mpd.connected && (mpd.song !== null || mpd.queueLength > 0) ? c.osMediaOpen : c.osUndefined;
}

describeHeadspace('6. Headspace (wmploc 7.9 item 6)', (headspace) => {
  /** The statement of headspace.js that reads the library constant. */
  const statement = () => {
    const files = unzipSync(headspace.bytes(), { filter: (f) => /(^|\/)headspace\.js$/i.test(f.name) });
    const text = decoder.text(Object.values(files)[0]);
    const m = /vidIsPlaying\s*=\s*\(\s*player\.OpenState\s*==\s*osMediaOpen\s*\)[^;]*;/.exec(text);
    expect(m, 'headspace.js tests player.OpenState == osMediaOpen').not.toBeNull();
    return /** @type {RegExpExecArray} */ (m)[0];
  };

  const song = { id: 1, title: 'x' };
  const situations = [
    { what: 'a song loaded (playing or paused)', mpd: { connected: true, song, queueLength: 3 }, open: true },
    { what: 'stopped with a non-empty queue', mpd: { connected: true, song: null, queueLength: 2 }, open: true },
    { what: 'an empty queue', mpd: { connected: true, song: null, queueLength: 0 }, open: false },
    { what: 'MPD unreachable', mpd: { connected: false, song: null, queueLength: 0 }, open: false },
  ];

  it.each(situations)('player.OpenState == osMediaOpen is $open with $what', async ({ mpd, open }) => {
    const clause = /\(\s*player\.OpenState\s*==\s*osMediaOpen\s*\)/.exec(statement())?.[0] ?? '';
    const got = await inRealm((run) => {
      run(seed(wmplocConstants()));
      run(`var player = ${JSON.stringify({ OpenState: openStateFor(mpd), currentMedia: { ImageSourceWidth: 0 } })};`);
      return [run(clause), run(statement() + '\nvidIsPlaying')];
    });
    expect(got[0]).toBe(open);
    expect(got[1], 'audio only: ImageSourceWidth stays 0, so the video test is false').toBe(false);
  });

  it('is what the seeded constant does: without the library the same read is a ReferenceError', async () => {
    const error = await inRealm((run) => {
      run('var player = { OpenState: 13 };');
      try { run('player.OpenState == osMediaOpen'); } catch (e) { return /** @type {any} */ (e).jsName; }
      return null;
    });
    expect(error).toBe('ReferenceError');
  });
});
