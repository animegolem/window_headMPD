// @ts-check
// `parsePath` (E §5.11, E D5 bindings): the `wmpprop:` grammar with call segments, the caps this
// module adds, and the way back to text that the object graph reads.
import { describe, expect, it } from 'vitest';
import { parseBindPath } from '../../../src/engine/wms/values.js';
import { PATH_CAPS, availabilityPath, formatPath, parsePath } from '../../../src/engine/bind/paths.js';

describe('parsePath', () => {
  it("parses a path with a call segment: player.settings.getMode('loop');", () => {
    expect(parsePath("player.settings.getMode('loop');")).toEqual({
      root: 'player',
      segments: [{ name: 'settings' }, { name: 'getMode', args: ['loop'] }],
    });
  });

  it('accepts a trailing `;` or none, and blanks around the tokens', () => {
    const plain = parsePath('player.controls.currentPosition');
    expect(plain).toEqual({ root: 'player', segments: [{ name: 'controls' }, { name: 'currentPosition' }] });
    expect(parsePath('player.controls.currentPosition;')).toEqual(plain);
    expect(parsePath('  player . controls . currentPosition ;  ')).toEqual(plain);
  });

  it('reads literal arguments: single and double quotes, numbers, booleans, none', () => {
    expect(parsePath("a.b(\"x\", 'y', 3, -1.5, true, FALSE)")?.segments[0].args).toEqual(['x', 'y', 3, -1.5, true, false]);
    expect(parsePath('a.b()')?.segments[0].args).toEqual([]);
    expect(parsePath("a.b('it\\'s')")?.segments[0].args).toEqual(["it's"]);
  });

  it('keeps case (the object graph folds it) and takes an element id as the root', () => {
    expect(parsePath('eq.gainLevel3')).toEqual({ root: 'eq', segments: [{ name: 'gainLevel3' }] });
    expect(parsePath('visEffects.currentPresetTitle')?.root).toBe('visEffects');
    expect(parsePath('vidset')).toEqual({ root: 'vidset', segments: [] });
  });

  it('is the one grammar: whatever values.js parses, parsePath parses, and the other way', () => {
    const texts = [
      "player.settings.getMode('loop');", 'player.currentMedia.DurationString', 'a.b.c.d', "x.f(1,2,'3')", '$a._b9',
      '', '.a', 'a.', 'a..b', 'a(1)', 'a.b(', "a.b('x", 'a.b(foo)', 'a b', 'a.b;c', '1a', 'a.b(1,)', '(a)',
    ];
    for (const t of texts) expect(parsePath(t), JSON.stringify(t)).toEqual(parseBindPath(t));
  });

  it('refuses what is not a path, and non-strings', () => {
    for (const bad of ['', ';', '.a', 'a.', 'a..b', 'a.b(', "a.b('x", 'a.b(foo)', 'a(1).b', 'wmpprop:a.b', 'a.b c']) {
      expect(parsePath(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parsePath(/** @type {any} */ (undefined))).toBeNull();
    expect(parsePath(/** @type {any} */ (42))).toBeNull();
    expect(parsePath(/** @type {any} */ ({ root: 'a', segments: [] }))).toBeNull();
  });

  it('caps the text, the segments, the arguments, the names and the string literals', () => {
    expect(parsePath(`a.${'b'.repeat(PATH_CAPS.maxNameChars)}`)).not.toBeNull();
    expect(parsePath(`a.${'b'.repeat(PATH_CAPS.maxNameChars + 1)}`)).toBeNull();
    expect(parsePath(`${'r'.repeat(PATH_CAPS.maxNameChars + 1)}.x`)).toBeNull();
    expect(parsePath(`a.f('${'s'.repeat(PATH_CAPS.maxLiteralChars)}')`)).not.toBeNull();
    expect(parsePath(`a.f('${'s'.repeat(PATH_CAPS.maxLiteralChars + 1)}')`)).toBeNull();
    expect(parsePath(`a.${Array.from({ length: 16 }, () => 'x').join('.')}`)).not.toBeNull();
    expect(parsePath(`a.${Array.from({ length: 17 }, () => 'x').join('.')}`)).toBeNull();
    expect(parsePath(`a.f(${Array.from({ length: 9 }, () => '1').join(',')})`)).toBeNull();
    expect(parsePath(`a.${'x'.repeat(600)}`)).toBeNull();
  });

  it('treats __proto__ and constructor as ordinary names, never as inherited members', () => {
    const p = parsePath('__proto__.constructor.__proto__');
    expect(p).toEqual({ root: '__proto__', segments: [{ name: 'constructor' }, { name: '__proto__' }] });
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);          // the result is a plain object ...
    expect(Object.getPrototypeOf(parsePath('a.constructor'))).toBe(Object.prototype);
    expect(parsePath('constructor')).toEqual({ root: 'constructor', segments: [] });
    expect(({}).constructor).toBe(Object);                            // ... and nothing was polluted
    expect(parsePath("a.f('__proto__', 'constructor')")?.segments[0].args).toEqual(['__proto__', 'constructor']);
  });
});

describe('formatPath', () => {
  it('prints text that parsePath reads back to the same path', () => {
    for (const t of [
      "player.settings.getMode('loop')", 'player.controls.currentPosition', "a.f(1, -2.5, true, 'x y')", 'a.f()', 'eq.gainLevel10',
      "a.f('it\\'s', 'back\\\\slash')", 'vidset',
    ]) {
      const path = /** @type {import('../../../src/engine/contracts').BindPath} */ (parsePath(t));
      const text = /** @type {string} */ (formatPath(path));
      expect(text, t).toBeTypeOf('string');
      expect(parsePath(text), t).toEqual(path);
    }
  });

  it('returns null for a path that has no text form', () => {
    expect(formatPath({ root: 'a', segments: [{ name: 'f', args: [1e21] }] })).toBeNull();
    expect(formatPath({ root: 'a', segments: [{ name: 'f', args: [Number.NaN] }] })).toBeNull();
    expect(formatPath({ root: 'not a name', segments: [] })).toBeNull();
  });

  it('prints a wmpenabled name as player.controls.isAvailable(name)', () => {
    expect(formatPath(availabilityPath('stop'))).toBe("player.controls.isAvailable('stop')");
    expect(parsePath("player.controls.isAvailable('stop')")).toEqual(availabilityPath('stop'));
    expect(formatPath(availabilityPath("it's"))).toBe("player.controls.isAvailable('it\\'s')");   // quoted, and it reads back
  });
});
