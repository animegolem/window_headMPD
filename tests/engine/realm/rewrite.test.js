// @ts-check
// W2.2 acceptance item 10 (E R20): a script statement that assigns to a call result is a QuickJS parse
// error but a run-time error in JScript and V8. The loader rewrites exactly those statements, one at a
// time and at most 32 per file, into `__wmp_badAssign()`, which throws at run time; every other syntax
// error still loses the file. The corpus half (219/219) is tests/corpus/realm-gate.test.js.

import { describe, expect, it } from 'vitest';
import { FAITHFUL } from '../../../src/engine/options.js';
import { REALM_CAPS, errorPosition, repairScript, rewriteCallAssignment } from '../../../src/engine/realm/realm.js';
import { makeRealm, outOf, wallClock } from './fake-host.js';

describe('rewriteCallAssignment', () => {
  /** @param {string} line @param {number | null} [column] */
  const one = (line, column = null) => rewriteCallAssignment(line, 1, column);

  it('replaces the whole assignment expression and keeps the rest of the line', () => {
    expect(one('  eq.gainLevels(band) = value; next();')).toEqual({ source: '  __wmp_badAssign(); next();', statement: 'eq.gainLevels(band) = value' });
    expect(one("theme.savePreference('x')='--';")).toEqual({ source: '__wmp_badAssign();', statement: "theme.savePreference('x')='--'" });
    expect(one('if (on) f (a, g(b)) = [1, 2], x = 1;')?.source).toBe('if (on) __wmp_badAssign(), x = 1;');
    expect(one('x = a.b(c).d(e) = 1 // note')?.source).toBe('x = __wmp_badAssign() // note');
    expect(one('{ obj[k](1) = 2 }')?.source).toBe('{ __wmp_badAssign() }');
  });

  it('ignores comparisons, arrows, compound operators and text inside strings', () => {
    expect(one('if (f(a) == 1) g(b) === 2;')).toBeNull();
    expect(one('var s = "f(x) = 1"; h(f(x) <= 2, (y) => 3);')).toBeNull();
    expect(one('total += f(x);')).toBeNull();
  });

  it('picks the assignment before the reported column when a line has two', () => {
    const line = 'a(1) = 2; b(3) = 4;';
    expect(one(line, 8)?.source).toBe('__wmp_badAssign(); b(3) = 4;');
    expect(one(line, 18)?.source).toBe('a(1) = 2; __wmp_badAssign();');
  });

  it('works on the right line of a longer file and never changes the line count', () => {
    const src = 'var a = 1;\nfunction f() {\n  eq.gainLevels(b) = v;\n}\n';
    const r = rewriteCallAssignment(src, 3, null);
    expect(r?.source).toBe('var a = 1;\nfunction f() {\n  __wmp_badAssign();\n}\n');
    expect(r?.source.split('\n')).toHaveLength(src.split('\n').length);
    expect(rewriteCallAssignment(src, 9, null)).toBeNull();
  });

  it('errorPosition reads lineNumber or the stack', () => {
    expect(errorPosition({ lineNumber: 4, stack: '    at f.js:4:22\n' })).toEqual({ line: 4, column: 22 });
    expect(errorPosition({ stack: '    at Tomb Raider 2.wmz!TombRaider.js:12:7\n' })).toEqual({ line: 12, column: 7 });
    expect(errorPosition({})).toEqual({ line: null, column: null });
  });

  // G2 F8: the first `:L:C` of the stack could come from the file name itself.
  it('errorPosition takes the column from the frame of this file, not from a :n:n inside its name', () => {
    expect(errorPosition({ lineNumber: 2, stack: '    at Skin 1:2:3.wmz!s.js:2:13\n' })).toEqual({ line: 2, column: 13 });
    expect(errorPosition({ lineNumber: 2, fileName: 'Skin 1:2:3.wmz!s.js', stack: '    at Skin 1:2:3.wmz!s.js:2:13\n' })).toEqual({ line: 2, column: 13 });
    expect(errorPosition({ lineNumber: 1, fileName: 'x:1:1', stack: '    at x:1:1:1:7\n' })).toEqual({ line: 1, column: 7 });
  });

  it('with a known column and no candidate before it, the line holds no rewrite (the = is on an earlier line)', () => {
    expect(rewriteCallAssignment('x; (a) = 2;', 1, 1)).toBeNull();
    expect(rewriteCallAssignment('try { f() =\n  1 } catch (e) {} (a) = 2;', 2, 3)).toBeNull();
    expect(rewriteCallAssignment('try { f() =\n  1 } catch (e) {} (a) = 2;', 1, null)?.source).toBe('try { __wmp_badAssign()\n  1 } catch (e) {} (a) = 2;');
  });

  // G2 S4: only a whole `<call> = <rhs>` is rewritten; anything else stays the parse error it is in V8.
  it('rewrites only a left side that is a whole call expression', () => {
    for (const line of ['(a + b) = 1', 'x + f(a) = 1', 'a && f(a) = 1', 'a || f(a) = 1', 'a ?? f(a) = 1', 'return (a + b) = 1', '!f(a) = 1',
      'x == f(a) = 1', 'new Foo(a) = 1', 'typeof (x) = 1', 'a?.f(x) = 1', 'x <= f(a) = 1']) {
      expect([line, one(line)]).toEqual([line, null]);
    }
    expect(one('new Foo(x).bar(y) = 1')?.source).toBe('__wmp_badAssign()');
    expect(one('a ? f(a) = 1 : 0')?.source).toBe('a ? __wmp_badAssign() : 0');
    expect(one('a ? 0 : f(a) = 1')?.source).toBe('a ? 0 : __wmp_badAssign()');
    expect(one('return f(a) = 1')?.source).toBe('return __wmp_badAssign()');
    expect(one('f(a) = b ? c : d;')?.source).toBe('__wmp_badAssign();');
    expect(one('x <<= f(a) = 1')?.source).toBe('x <<= __wmp_badAssign()');
    expect(one('else o.return(1) = 2;')?.source).toBe('else __wmp_badAssign();');
    expect(one('g = () => f(a) = 1;')?.source).toBe('g = () => __wmp_badAssign();');
  });
});

describe('repairScript', () => {
  /** A compile stand-in: a SyntaxError at the first line holding `)=` or `) =`. @param {string} src */
  const fakeCompile = (src) => {
    const lines = src.split('\n');
    const i = lines.findIndex((l) => /\)\s*=(?!=)/.test(l));
    return i < 0 ? null : { name: 'SyntaxError', message: 'invalid assignment left-hand side', lineNumber: i + 1 };
  };

  it('repairs one statement per round and reports each', () => {
    const r = repairScript('f(1) = 2;\nok();\ng(3) = 4;', fakeCompile);
    expect(r.error).toBeNull();
    expect(r.source).toBe('__wmp_badAssign();\nok();\n__wmp_badAssign();');
    expect(r.rewrites).toEqual([{ line: 1, statement: 'f(1) = 2' }, { line: 3, statement: 'g(3) = 4' }]);
  });

  it(`stops after ${REALM_CAPS.maxRewritesPerFile} rewrites: the file is lost`, () => {
    const src = Array.from({ length: REALM_CAPS.maxRewritesPerFile + 1 }, (_, i) => `f(${i}) = ${i};`).join('\n');
    const r = repairScript(src, fakeCompile);
    expect(r.rewrites).toHaveLength(REALM_CAPS.maxRewritesPerFile);
    expect(r.error).toMatchObject({ name: 'SyntaxError', line: REALM_CAPS.maxRewritesPerFile + 1 });
    expect(repairScript(src.split('\n').slice(0, 32).join('\n'), fakeCompile).error).toBeNull();
  });

  it('asks stop() before every compile and ends, stopped, the first time it says yes', () => {
    let compiles = 0;
    const counting = (/** @type {string} */ src) => {
      compiles++;
      return fakeCompile(src);
    };
    const src = Array.from({ length: 10 }, (_, i) => `f(${i}) = ${i};`).join('\n');
    const r = repairScript(src, counting, { stop: () => compiles >= 3 });
    expect(r).toMatchObject({ stopped: true, error: null });
    expect(r.rewrites).toHaveLength(3);
    expect(compiles).toBe(3);
    expect(repairScript('ok();', fakeCompile, { stop: () => true })).toMatchObject({ stopped: true, rewrites: [] });
  });

  it('any other syntax error loses the file untouched', () => {
    const r = repairScript('var = ;', () => ({ name: 'SyntaxError', message: "unexpected token in expression: '='", lineNumber: 1 }));
    expect(r).toEqual({ source: 'var = ;', rewrites: [], error: { name: 'SyntaxError', message: "unexpected token in expression: '='", line: 1 } });
  });
});

describe('item 10: the loader rewrites call assignments in QuickJS', () => {
  it('synthetic eq.gainLevels(b) = v and theme.savePreference(\'x\')=\'--\' files load; their functions run; the statement throws', async () => {
    const hn = await makeRealm();
    const eqFile = 'var gains = [];\nfunction setGain(b, v) {\n  gains.push(b);\n  eq.gainLevels(b) = v;\n  gains.push("after");\n}\nfunction other() { return 7; }\n';
    const prefFile = "function reset() { theme.savePreference('x')='--'; }\nfunction fine() { return 'fine'; }\n";
    expect(hn.realm.loadScript('eq.js', eqFile)).toEqual({ ok: true, value: undefined });
    expect(hn.realm.loadScript('prefs.js', prefFile)).toEqual({ ok: true, value: undefined });
    expect(outOf(hn, "return [other(), fine(), typeof setGain, typeof reset]")).toEqual([7, 'fine', 'function', 'function']);
    const a = hn.handler('setGain(3, 6);');
    expect(a).toMatchObject({ ok: false, kind: 'soft', reason: 'TypeError: Cannot assign to a function result' });
    expect(outOf(hn, 'return gains')).toEqual([3]);                         // the statement threw where it stood
    expect(hn.handler('reset();')).toMatchObject({ ok: false, kind: 'soft', reason: 'TypeError: Cannot assign to a function result' });
    expect(outOf(hn, 'try { reset(); } catch (e) { return [e instanceof TypeError, e.message]; }')).toEqual([true, 'Cannot assign to a function result']);
    const rewrites = hn.log.diags.filter((d) => d.code === 'script-rewrite');
    expect(rewrites.map((d) => [d.file, d.line])).toEqual([['eq.js', 4], ['prefs.js', 1]]);
    expect(rewrites[0].detail).toMatch(/eq\.gainLevels\(b\) = v/);
  });

  it('a file with any other syntax error is lost as a soft fault, and its neighbours still load', async () => {
    const hn = await makeRealm();
    const lost = hn.realm.loadScript('bad.js', 'function a() {\n  return 1 +;\n}');
    expect(lost).toMatchObject({ ok: false, kind: 'soft', site: 'script bad.js' });
    expect(!lost.ok && lost.reason).toMatch(/^SyntaxError/);
    expect(hn.log.diags.find((d) => d.code === 'script-syntax')).toMatchObject({ file: 'bad.js', line: 2 });
    expect(hn.realm.loadScript('good.js', 'function b() { return 2; }').ok).toBe(true);
    expect(outOf(hn, 'return [typeof a, b()]')).toEqual(['undefined', 2]);
  });

  it('a script that throws part-way keeps its hoisted declarations, as a soft fault', async () => {
    const hn = await makeRealm();
    const r = hn.realm.loadScript('throws.js', 'var early = 1;\nundefinedFn();\nvar late = 2;\nfunction hoisted() { return 3; }');
    expect(r).toMatchObject({ ok: false, kind: 'soft' });
    expect(outOf(hn, "return [early, typeof late, hoisted()]")).toEqual([1, 'undefined', 3]);
  });

  it('the scripts of a view share one 2,000 ms budget', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('slow.js', 'var t = Date.now(); while (Date.now() - t < 1500) {}').ok).toBe(true);
    const second = hn.realm.loadScript('slow2.js', 'var u = Date.now(); while (Date.now() - u < 1500) {}');
    expect(second).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
  });

  // G2 F8: the position comes from QuickJS's own location for this file.
  it('a file name holding :n:n, or a right side on the next line, rewrites only the call assignment', async () => {
    const src = 'var a = 0; function f(){}\ntry { f() =\n  1 } catch (e) {} (a) = 2;\n';
    for (const name of ['Skin.wmz!s.js', 'Skin 1:2:3.wmz!s.js']) {
      const hn = await makeRealm();
      expect(hn.realm.loadScript(name, src)).toEqual({ ok: true, value: undefined });
      expect(hn.log.diags.filter((d) => d.code === 'script-rewrite').map((d) => d.detail)).toEqual([expect.stringMatching(/: f\(\) =$/)]);
      expect(hn.realm.readGlobal('a')).toBe(2);
    }
    const hn = await makeRealm();
    expect(hn.realm.loadScript('Skin 1:2:3.wmz!s.js', 'var a = 0, s; function f(){}\ntry { f() = 1 } catch (e) {} (a) = 2; s = "xa=y".replace(/(a)=/g, "");\n').ok).toBe(true);
    expect([hn.realm.readGlobal('a'), hn.realm.readGlobal('s')]).toEqual([2, 'xy']);
  });
});

// G2 DOS-3 / F3 / S1: a QuickJS compile never polls the interrupt, and the R20 repair compiled a file up
// to 33 times with no deadline check: a 0.45 MiB file blocked for 27 s.
describe('the compile budget', () => {
  it('a file over 1 MiB is refused at once as a soft fault, with a script-too-large diagnostic', async () => {
    const hn = await makeRealm();
    const t = wallClock();
    const r = hn.realm.loadScript('huge.js', `var x = '${'x'.repeat(REALM_CAPS.maxScriptChars)}';`);
    expect(wallClock() - t).toBeLessThan(50);
    expect(r).toMatchObject({ ok: false, kind: 'soft', reason: 'RangeError: script too large' });
    expect(hn.log.diags.filter((d) => d.code === 'script-too-large').map((d) => d.file)).toEqual(['huge.js']);
    expect(hn.realm.loadScript('max.js', `var y = '${'y'.repeat(REALM_CAPS.maxScriptChars - 12)}';`).ok).toBe(true);
  });

  // A 1 MiB file compiles in ~50 ms here, so 33 compiles take ~1.6 s; a view with a 300 ms scripts
  // budget shows the stop the same way the 2,000 ms one does with a slower file.
  const SCRIPTS = 300;
  const tight = { options: { budgets: { ...FAITHFUL.budgets, scripts: SCRIPTS } } };
  /** @param {string} tail */
  const bigFile = (tail) => {
    let s = 'function big() {\n';
    while (s.length < REALM_CAPS.maxScriptChars - 2000) s += 'x = 1 + 2 * (3 - 4) / 5;\n';
    s += '}\n';
    for (let i = 0; i < REALM_CAPS.maxRewritesPerFile; i++) s += `function g${i}() { f(${i}) = 1; }\n`;
    return s + tail;
  };

  it('the repair stops at the deadline: a hard budget fault within budget + 300 ms, and the next file is refused without compiling', async () => {
    const hn = await makeRealm(tight);
    const t = wallClock();
    const r = hn.realm.loadScript('big.js', bigFile(''));
    const ms = wallClock() - t;
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(ms).toBeLessThanOrEqual(SCRIPTS + 300);
    const t2 = wallClock();
    expect(hn.realm.loadScript('tiny.js', 'var tiny = 1;')).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(wallClock() - t2).toBeLessThan(10);
    expect(hn.realm.readGlobal('tiny')).toBeUndefined();
  });

  it('running out of time is never reported as a syntax error, even when the file has one', async () => {
    const hn = await makeRealm(tight);
    const r = hn.realm.loadScript('bad.js', bigFile('var = ;\n'));
    expect(r).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(hn.log.diags.filter((d) => d.code === 'script-syntax')).toEqual([]);
  });

  it('once a file spent the 2,000 ms, a tiny file is refused as a budget fault without compiling', async () => {
    const hn = await makeRealm();
    expect(hn.realm.loadScript('slow.js', 'var t = Date.now(); while (Date.now() - t < 2500) {}')).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    const t = wallClock();
    expect(hn.realm.loadScript('tiny.js', 'var tiny = 1;')).toMatchObject({ ok: false, kind: 'hard', reason: 'budget' });
    expect(wallClock() - t).toBeLessThan(10);
    expect(hn.realm.readGlobal('tiny')).toBeUndefined();
  });

  it('a corpus-sized file with 32 rewrites still loads under the real budget, and its functions run', async () => {
    const hn = await makeRealm();
    let s = 'var total = 0;\nfunction add(n) { total += n; return total; }\n';
    while (s.length < 54_000) s += 'function pad() { var q = [1, 2, 3].join("-"); return q; }\n';
    for (let i = 0; i < REALM_CAPS.maxRewritesPerFile; i++) s += `function g${i}() { eq.gainLevels(${i}) = 1; }\n`;
    expect(hn.realm.loadScript('corpus-sized.js', s)).toEqual({ ok: true, value: undefined });
    expect(hn.log.diags.filter((d) => d.code === 'script-rewrite')).toHaveLength(REALM_CAPS.maxRewritesPerFile);
    expect(outOf(hn, 'return [add(2), add(3), typeof g31]')).toEqual([2, 5, 'function']);
  });
});
