// @ts-check
// Tests for tools/scan-api.mjs (ENGINE D6.7, WAVES W2.8). Three layers: the JavaScript tokenizer, the
// counting rules (`analyzeSkin` and `rank` on strings), and archives plus the command line on a
// synthetic two-skin corpus built with the test kit. The last block runs over skins/wmp and skips
// without it (WAVES global rule 4). Every tree written here lives under os.tmpdir().
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CSV_HEADER, OBJECT_ROOTS, REPO_ROOT, T_ID, WMPLOC_132_NAMES,
  analyzeSkin, collectArchives, rank, renderCsv, scanArchive, tokenize,
} from '../../tools/scan-api.mjs';
import { wmplocConstants } from '../../src/engine/realm/wmploc.js';
import { describeCorpus } from '../support/fixtures.js';
import { makeTempDir } from '../support/ref-decoders.js';
import { encodeText } from '../support/wms-builder.js';
import { buildZip } from '../support/zip-writer.js';

const TOOL = join(REPO_ROOT, 'tools', 'scan-api.mjs');

/** @param {string} text identifiers `tokenize` finds, in order */
const identifiers = (text) => {
  const { types, vals } = tokenize(text);
  return vals.filter((_, i) => types[i] === T_ID);
};

/** A one-VIEW definition. @param {string} body elements @param {string} [scriptFile] */
const wmsOf = (body, scriptFile = '') => `<THEME><VIEW id="main"${scriptFile ? ` scriptFile="${scriptFile}"` : ''}>${body}</VIEW></THEME>`;

/**
 * Rank one skin on its own: `kind name` -> refs in the distinct corpus.
 * @param {string | string[]} wms @param {string[]} [js]
 */
function count(wms, js = []) {
  const facts = analyzeSkin(Array.isArray(wms) ? wms : [wms], js);
  return new Map(rank([{ sha: 'x', facts, files: { wms: 0, js: 0 } }]).rows.map((r) => [`${r.kind} ${r.name}`, r.refs]));
}

describe('tokenize', () => {
  it('skips line comments, block comments and an unterminated block comment', () => {
    expect(identifiers('a /* b */ c // d\ne')).toEqual(['a', 'c', 'e']);
    expect(identifiers('a /* b\nc')).toEqual(['a']);
  });

  it('skips string contents, escapes and line continuations; an unterminated string ends at its line', () => {
    expect(identifiers('"a\\"b" + c')).toEqual(['c']);
    expect(identifiers("'it\\'s' + d")).toEqual(['d']);
    expect(identifiers('"a\\\r\nb" + e')).toEqual(['e']);
    expect(identifiers('x = "abc\ny = 1')).toEqual(['x', 'y']);
  });

  it('tells a regex literal from a division, and confines a wrong guess to one line', () => {
    expect(identifiers('a / b / c')).toEqual(['a', 'b', 'c']);
    expect(identifiers('x = /"/g.test(s)')).toEqual(['x', 'test', 's']);
    expect(identifiers("return /a'b/.test(c)")).toEqual(['return', 'test', 'c']);
    expect(identifiers('x = /[/]y/.z; w = 1')).toEqual(['x', 'z', 'w']);
    expect(identifiers('a = (b) / c / d')).toEqual(['a', 'b', 'c', 'd']);
    expect(identifiers('a = /oops\nb')).toEqual(['a', 'oops', 'b']);
  });

  it('reads numbers, `==` and non-ASCII identifiers', () => {
    expect(identifiers('0x1F + .5 + 1e3 + 2.5')).toEqual([]);
    expect(identifiers('a.b == c === d')).toEqual(['a', 'b', 'c', 'd']);
    expect(identifiers('é.ñ = 1')).toEqual(['é', 'ñ']);
    const { vals } = tokenize('a = b == c');
    expect(vals.filter((v) => v === '=')).toHaveLength(1);
  });

  it('is total: lone surrogates, NUL and junk do not throw, and a megabyte of it ends', () => {
    expect(identifiers('\ud800 x \u0000 `y` @')).toContain('x');
    const junk = '"\'/*/`\\(){}[].=\n'.repeat(70_000);
    const t0 = Date.now();
    tokenize(junk);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('stays linear on one long line of regex openers that never close', () => {
    const t0 = Date.now();
    const { types } = tokenize('=/['.repeat(400_000));
    expect(types.length).toBeGreaterThan(400_000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('object-model rows', () => {
  it('counts a path and each of its prefixes, case-folded, ignoring comments and strings', () => {
    const rows = count(wmsOf(''), [
      'Player.Controls.CurrentPosition = 5;',
      '// player.settings.volume',
      '/* theme.openView("x") */',
      'var s = "view.close()";',
    ]);
    expect(rows).toEqual(new Map([
      ['object-model player', 1],
      ['object-model player.controls', 1],
      ['object-model player.controls.currentposition', 1],
    ]));
  });

  it('ends a path at a call, scans the arguments, and ignores what follows the call', () => {
    const rows = count(wmsOf(''), [
      "player.settings.getMode(theme.loadPreference('x')); player.currentPlaylist.item(0).name;",
    ]);
    expect(rows.get('object-model player.settings.getmode')).toBe(1);
    expect(rows.get('object-model theme.loadpreference')).toBe(1);
    expect(rows.get('object-model player.currentplaylist.item')).toBe(1);
    expect(rows.get('object-model player')).toBe(2);
    expect([...rows.keys()].filter((k) => /\bname\b/.test(k))).toEqual([]);
  });

  it('counts every reference, reads and writes alike, and sees through whitespace and comments', () => {
    const rows = count(wmsOf(''), ['player . settings /* v */ . volume = player.settings.volume - 5;']);
    expect(rows.get('object-model player.settings.volume')).toBe(2);
  });

  it('caps a path at eight segments and drops an over-long name', () => {
    const long = 'a'.repeat(200);
    const rows = count(wmsOf(''), [`player.a.b.c.d.e.f.g.h.i.j; player.${long}.x;`]);
    expect(rows.get('object-model player.a.b.c.d.e.f.g')).toBe(1);
    expect(rows.has('object-model player.a.b.c.d.e.f.g.h')).toBe(false);
    expect([...rows.keys()].some((k) => k.includes(long))).toBe(false);
  });

  it('reads wmpprop:, wmpenabled: and wmpdisabled: values from the definition', () => {
    const rows = count(wmsOf([
      '<SLIDER id="vol" value="wmpprop:player.settings.volume" max="WMPProp:player.currentMedia.duration"/>',
      '<BUTTON id="b" down="wmpprop:player.settings.getMode(\'loop\')" visible="wmpenabled:player.controls.pause;" enabled="wmpdisabled:player.Controls.Play()"/>',
      '<SLIDER id="eq1" value="wmpprop:eq.gainLevel1"/>',
      '<TEXT id="t" value="res://wmploc/RT_STRING/#1809"/>',
    ].join('')));
    expect(rows).toEqual(new Map([
      ['object-model player', 5],
      ['object-model player.settings', 2],
      ['object-model player.settings.volume', 1],
      ['object-model player.settings.getmode', 1],
      ['object-model player.currentmedia', 1],
      ['object-model player.currentmedia.duration', 1],
      ['object-model player.controls', 2],
      ['object-model player.controls.pause', 1],
      ['object-model player.controls.play', 1],
    ]));
  });

  it('reads handlers and jscript: values as script, with or without a label', () => {
    const rows = count(wmsOf([
      '<BUTTON id="a" onClick="player.controls.play();" onMouseDown="JScript:view.minimize()"/>',
      '<SLIDER id="s" value_onchange="wmpprop:player.settings.volume = value;" left="jscript:view.width-121;"/>',
      '<PLAYER playStateChange="theme.logString(NewState)"/>',
    ].join('')));
    expect(rows.get('object-model player.controls.play')).toBe(1);
    expect(rows.get('object-model view.minimize')).toBe(1);
    expect(rows.get('object-model player.settings.volume')).toBe(1);
    expect(rows.get('object-model view.width')).toBe(1);
    expect(rows.get('object-model theme.logstring')).toBe(1);
  });

  it('knows the documented globals and no others', () => {
    expect([...OBJECT_ROOTS].sort()).toEqual(['event', 'mediacenter', 'player', 'theme', 'view']);
    const rows = count(wmsOf(''), ['eq.reset; vidset.contrast = 1; window.x;']);
    expect([...rows.keys()].filter((k) => k.startsWith('object-model'))).toEqual([]);
  });
});

describe('element-method rows', () => {
  it('counts `<id>.<method>(` for ids the skin declares, by method name, case-folded', () => {
    const rows = count(wmsOf('<SUBVIEW id="svEq"/><BUTTON id="Btn"/>'), [
      'svEq.moveTo(1, 2, 120); btn.alphaBlendTo(0, 5); svEq.top = 3; Math.floor(2); str.indexOf("x"); svEq.children.item(0);',
    ]);
    expect(rows).toEqual(new Map([
      ['element-method moveto', 1],
      ['element-method alphablendto', 1],
    ]));
  });

  it('takes ids from every definition file of the skin', () => {
    const rows = count([wmsOf('<SUBVIEW id="one"/>'), wmsOf('<SUBVIEW id="two"/>')], ['one.moveTo(1,2); two.moveTo(3,4);']);
    expect(rows.get('element-method moveto')).toBe(2);
  });

  it('counts `this.<method>(` in a handler, not in a script file', () => {
    const rows = count(wmsOf('<TEXT id="t" onClick="this.moveTo(1,2)"/>'), ['function F() { this.moveTo(1); }']);
    expect(rows.get('element-method moveto')).toBe(1);
  });
});

describe('implicit-method rows', () => {
  it('counts a bare call in a handler or jscript: value, not in a script file', () => {
    const rows = count(wmsOf('<EFFECTS id="fx" onClick="next();"/><TEXT id="t" value_onchange="moveTo(left,top,5);" left="jscript:previous()"/>'), ['next(); moveTo(1,2);']);
    expect(rows).toEqual(new Map([
      ['implicit-method next', 1],
      ['implicit-method moveto', 1],
      ['implicit-method previous', 1],
    ]));
  });

  it('drops keywords, constructors, JScript built-ins and names the skin defines', () => {
    const rows = count(wmsOf([
      '<BUTTON id="a" onClick="if (x) { return(y); } while(z) {} switch(q) {} var o = new Foo(); parseInt(a); eval(b); setTimeout(c, 1);"/>',
      '<BUTTON id="b" onClick="f(); g(); h(); k(); next();"/>',
    ].join('')), ['var f = function () {}; function g() {} h = function () {}; var i = 1, k = 2;']);
    expect(rows).toEqual(new Map([['implicit-method next', 1]]));
  });

  it('keeps a call that another skin defines out of every skin, and a call nobody defines in', () => {
    const calls = analyzeSkin([wmsOf('<BUTTON id="a" onClick="UpdateMetadata(); gotoBig();"/>')], []);
    const definer = analyzeSkin([wmsOf('')], ['function updatemetadata() {}']);
    const { rows } = rank([
      { sha: 'a', facts: calls, files: { wms: 1, js: 0 } },
      { sha: 'b', facts: definer, files: { wms: 1, js: 1 } },
    ]);
    expect(rows.filter((r) => r.kind === 'implicit-method').map((r) => r.name)).toEqual(['gotobig']);
  });

  it('does not take an assignment in a handler for a definition', () => {
    const rows = count(wmsOf('<TEXT id="t" onClick="scrolling = false; scrolling();"/>'));
    expect(rows.get('implicit-method scrolling')).toBe(1);
  });
});

describe('wmploc-132 rows', () => {
  const lib = 'headspace.js;res://wmploc.dll/RT_TEXT/#132;';

  it('takes its name set from the wmploc shim', () => {
    expect(WMPLOC_132_NAMES).toEqual(new Set(Object.keys(wmplocConstants())));
    expect(WMPLOC_132_NAMES.has('osMediaOpen')).toBe(true);
    expect(WMPLOC_132_NAMES.has('WMPPlaylistChangeEventTypes')).toBe(true);
  });

  it('counts bare uses in a skin that lists #132, case-folded, in script and in handlers', () => {
    const rows = count(wmsOf('<BUTTON id="a" onClick="if (player.openState == osMediaOpen) go();"/>', lib), [
      'switch (player.playState) { case psPlaying: break; }',
      'if (player.openState == osMediaOpen && x.osMediaOpen) {}',
    ]);
    expect(rows.get('wmploc-132 osmediaopen')).toBe(2);
    expect(rows.get('wmploc-132 psplaying')).toBe(1);
  });

  it('matches the DLL\'s spelling exactly, and ignores members, calls and strings', () => {
    const rows = count(wmsOf('', lib), ['OsMediaOpen; a.psPaused; psStopped(); "psReady";']);
    expect([...rows.keys()].filter((k) => k.startsWith('wmploc-132'))).toEqual([]);
  });

  it('skips a skin that does not list #132, and a name the skin defines itself', () => {
    const uses = ['x = osMediaOpen + psPlaying;'];
    expect(count(wmsOf('', 'headspace.js'), uses).has('wmploc-132 osmediaopen')).toBe(false);
    expect(count(wmsOf('', 'res://wmploc/RT_TEXT/#134;'), uses).has('wmploc-132 osmediaopen')).toBe(false);
    const own = count(wmsOf('', lib), ['var psPlaying = 3;', 'osMediaOpen = 13;', 'x = osMediaOpen + psPlaying + psPaused;']);
    expect(own.has('wmploc-132 psplaying')).toBe(false);
    expect(own.has('wmploc-132 osmediaopen')).toBe(false);
    expect(own.get('wmploc-132 pspaused')).toBe(1);
  });
});

describe('names that skins control (E §1 rule 6)', () => {
  it('treats __proto__, constructor and toString as ordinary names', () => {
    const wms = wmsOf('<SUBVIEW id="__proto__"/><BUTTON id="constructor" onClick="__proto__.moveTo(1,2); constructor.close(); constructor(); toString(); valueOf(); this.hasOwnProperty();"/>');
    const rows = count(wms, ['player.__proto__.x(); theme.constructor; player.constructor.prototype;']);
    expect(rows.get('element-method moveto')).toBe(1);
    expect(rows.get('element-method close')).toBe(1);
    expect(rows.get('element-method hasownproperty')).toBe(1);
    expect(rows.get('implicit-method constructor')).toBe(1);
    expect(rows.get('implicit-method tostring')).toBe(1);
    expect(rows.get('implicit-method valueof')).toBe(1);
    expect(rows.get('object-model player.__proto__.x')).toBe(1);
    expect(rows.get('object-model player.__proto__')).toBe(1);
    expect(rows.get('object-model theme.constructor')).toBe(1);
    expect(rows.get('object-model player.constructor.prototype')).toBe(1);
    expect(rows.get('object-model player')).toBe(2);
    // Nothing leaked onto the prototypes the lookups share.
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(/** @type {any} */ ({}).moveto).toBeUndefined();
  });

  it('a skin that names its element __proto__ or constructor is not another skin\'s receiver', () => {
    const a = analyzeSkin([wmsOf('<SUBVIEW id="__proto__"/>')], ['__proto__.moveTo(1);']);
    const b = analyzeSkin([wmsOf('<SUBVIEW id="other"/>')], ['__proto__.moveTo(1);']);
    expect(a.counts.get('element-method\tmoveto')).toBe(1);
    expect(b.counts.has('element-method\tmoveto')).toBe(false);
  });
});

describe('ranking and the CSV', () => {
  /** @param {string} sha @param {string} js */
  const result = (sha, js) => ({ sha, facts: analyzeSkin([wmsOf('')], [js]), files: { wms: 1, js: 1 } });

  it('counts a byte-identical archive in refs_all_archives only', () => {
    const a = result('A', 'player.controls.play(); player.controls.play();');
    const b = result('B', 'player.controls.play();');
    const { rows, distinct } = rank([a, b, { ...a }]);
    expect(distinct).toBe(2);
    const row = rows.find((r) => r.name === 'player.controls.play');
    expect(row).toMatchObject({ refs: 3, skins: 2, refsAll: 5 });
  });

  it('sorts by refs, then refs_all_archives, then kind and name, whatever the input order', () => {
    const inputs = [result('A', 'theme.a; theme.b; theme.b; view.z;'), result('B', 'view.z; theme.c;'), result('C', 'theme.a;')];
    const first = renderCsv(rank(inputs).rows);
    expect(renderCsv(rank([...inputs].reverse()).rows)).toBe(first);
    const lines = first.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines.slice(1, 4)).toEqual([
      'object-model,theme,5,3,5',
      'object-model,theme.a,2,2,2',
      'object-model,theme.b,2,1,2',
    ]);
    expect(first.endsWith('\n')).toBe(true);
  });

  it('quotes a name that would break a field', () => {
    expect(renderCsv([{ kind: 'object-model', name: 'a,"b"', refs: 1, skins: 1, refsAll: 1 }])).toBe(`${CSV_HEADER}\nobject-model,"a,""b""",1,1,1\n`);
  });
});

describe('archives and the command line', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let corpus;
  /** @type {Uint8Array} */
  let skinA;
  /** @type {Uint8Array} */
  let skinB;

  const defA = [
    '<THEME author="Zoë"><VIEW id="main" scriptFile="a.js;res://wmploc/RT_TEXT/#132">',
    '  <SUBVIEW id="drawer"/>',
    '  <SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="player.settings.volume=value;"/>',
    '  <BUTTON id="go" visible="wmpenabled:player.controls.pause" onClick="drawer.moveTo(1,2,120);"/>',
    '</VIEW></THEME>',
  ].join('\r\n');
  const jsA = 'function f() { if (player.openState == osMediaOpen) player.controls.currentPosition = 0; }\r\n';
  const defB = '<THEME><VIEW id="main"><TEXT id="t" onClick="next(); theme.savePreference(\'k\', \'caf\xe9\');"/></VIEW></THEME>';
  const jsB = 'theme.loadPreference("k"); player.controls.currentPosition;';

  beforeAll(() => {
    dir = makeTempDir('w28-scan-api-');
    corpus = join(dir, 'skins', 'wmp');
    mkdirSync(corpus, { recursive: true });
    skinA = buildZip([
      { name: 'a.wms', data: encodeText(defA, 'utf16le') },
      { name: 'a.js', data: encodeText(jsA, 'utf8-bom') },
      { name: 'art.bmp', data: 'player.controls.eject' }, // not a definition or a script: never scanned
    ]);
    // Upper-case extension, as TEDDY and sankofa skin have.
    skinB = buildZip([
      { name: 'b.WMS', data: encodeText(defB, 'cp1252') },
      { name: 'B.JS', data: encodeText(jsB, 'ascii') },
    ]);
    writeFileSync(join(corpus, 'a.wmz'), skinA);
    writeFileSync(join(corpus, 'a copy.wmz'), skinA); // same bytes under another name
    writeFileSync(join(corpus, 'B.WMZ'), skinB);
    writeFileSync(join(corpus, 'notes.txt'), 'player.controls.eject');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** @param {string[]} args */
  const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60_000 });

  it('reads UTF-16LE, UTF-8 BOM, cp1252 and ASCII, and every .wms and .js in any case', async () => {
    const a = await scanArchive(skinA, 'a.wmz');
    const b = await scanArchive(skinB, 'B.WMZ');
    expect(a.files).toEqual({ wms: 1, js: 1 });
    expect(b.files).toEqual({ wms: 1, js: 1 });
    const { rows } = rank([a, b]);
    const get = (/** @type {string} */ kind, /** @type {string} */ name) => rows.find((r) => r.kind === kind && r.name === name);
    expect(get('object-model', 'player.settings.volume')).toMatchObject({ refs: 2, skins: 1 });
    expect(get('object-model', 'player.controls.pause')).toMatchObject({ refs: 1, skins: 1 });
    expect(get('object-model', 'player.controls.currentposition')).toMatchObject({ refs: 2, skins: 2 });
    expect(get('object-model', 'theme.savepreference')).toMatchObject({ refs: 1, skins: 1 });
    expect(get('object-model', 'theme.loadpreference')).toMatchObject({ refs: 1, skins: 1 });
    expect(get('object-model', 'player.controls.eject')).toBeUndefined();
    expect(get('element-method', 'moveto')).toMatchObject({ refs: 1, skins: 1 });
    expect(get('implicit-method', 'next')).toMatchObject({ refs: 1, skins: 1 });
    expect(get('wmploc-132', 'osmediaopen')).toMatchObject({ refs: 1, skins: 1 });
  });

  it('collects archives from a directory or a file, and ignores everything else', () => {
    expect(collectArchives([corpus]).map((p) => p.slice(corpus.length + 1))).toEqual(['B.WMZ', 'a copy.wmz', 'a.wmz']);
    expect(collectArchives([join(corpus, 'a.wmz'), join(corpus, 'notes.txt'), join(dir, 'missing')])).toEqual([join(corpus, 'a.wmz')]);
  });

  it('writes the CSV: names and counts only, deterministic, with the summary on stdout', () => {
    const out1 = join(dir, 'one.csv');
    const out2 = join(dir, 'two.csv');
    const r = run(corpus, '--out', out1);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('archives 3 (2 distinct), 3 .wms and 3 .js files');
    expect(r.stdout).toContain(`wrote ${out1}`);
    expect(run(corpus, '--out', out2).status).toBe(0);
    const text = readFileSync(out1, 'utf8');
    expect(text).toBe(readFileSync(out2, 'utf8'));
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toContain('object-model,player.controls.currentposition,2,2,3');
    expect(lines).toContain('object-model,player.settings.volume,2,1,4');
    for (const line of lines.slice(1)) expect(line, line).toMatch(/^(object-model|wmploc-132|element-method|implicit-method),[\w$.]+,\d+,\d+,\d+$/);
    // No archive or file name, and nothing of the art.
    expect(text).not.toMatch(/wmz|\.wms|a\.js|b\.js|copy|eject|zo\u00eb|caf\u00e9/i);
  });

  it('takes several paths and single archive files', () => {
    const out = join(dir, 'many.csv');
    const r = run(join(corpus, 'a.wmz'), join(corpus, 'B.WMZ'), '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('archives 2 (2 distinct)');
    expect(readFileSync(out, 'utf8').startsWith(`${CSV_HEADER}\n`)).toBe(true);
  });

  it('with no archives prints a skip, exits 0 and leaves the output alone', () => {
    const out = join(dir, 'untouched.csv');
    writeFileSync(out, 'previous');
    mkdirSync(join(dir, 'empty'), { recursive: true });
    for (const where of [join(dir, 'no-such-dir'), join(dir, 'empty')]) {
      const r = run(where, '--out', out);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('skip: no archives');
      expect(readFileSync(out, 'utf8')).toBe('previous');
    }
  });

  it('exits 2 on bad usage', () => {
    for (const args of [['--bogus'], ['--out'], [corpus, '-x']]) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('usage:');
    }
  });

  it('exits 1 and writes nothing when an archive cannot be read', () => {
    const bad = join(dir, 'bad');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'ok.wmz'), skinA);
    writeFileSync(join(bad, 'junk.wmz'), 'this is not a zip');
    const out = join(dir, 'bad.csv');
    const r = run(bad, '--out', out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('junk.wmz');
    expect(r.stderr).toContain('1 of 2 archives could not be read');
    expect(existsSync(out)).toBe(false);
  });
});

// The acceptance of W2.8 against the owner's corpus: survey 5.4 (distinct skins), spec 7.1 (raw counts).
describeCorpus('scan-api over skins/wmp', (corpus) => {
  /** @type {import('../../tools/scan-api.mjs').Row[]} */
  let rows = [];
  let distinct = 0;
  let archives = 0;

  beforeAll(async () => {
    const results = [];
    for (const entry of corpus.archives('wmp')) results.push(await scanArchive(corpus.read(entry), entry.name));
    archives = results.length;
    ({ rows, distinct } = rank(results));
  }, 120_000);

  const row = (/** @type {string} */ kind, /** @type {string} */ name) => rows.find((r) => r.kind === kind && r.name === name);
  const near = (/** @type {number | undefined} */ actual, /** @type {number} */ expected, /** @type {number} */ tolerance) => {
    expect(actual).toBeDefined();
    expect(Math.abs(/** @type {number} */ (actual) - expected)).toBeLessThanOrEqual(expected * tolerance);
  };

  it('scans the 342 archives, 195 of them distinct', () => {
    expect(archives).toBe(342);
    expect(distinct).toBe(195);
  });

  it('puts player.controls, player.settings and player.currentmedia among the top rows (survey 5.4)', () => {
    const top = rows.slice(0, 12).map((r) => r.name);
    for (const name of ['player.controls', 'player.settings', 'player.currentmedia']) expect(top, name).toContain(name);
  });

  it('counts currentPosition near the 1,374 references of spec 7.1', () => {
    near(row('object-model', 'player.controls.currentposition')?.refsAll, 1374, 0.06);
  });

  it('agrees with spec 7.1 raw counts and survey 5.4 skin counts on a spread of members', () => {
    // [name, spec 7.1 references over all archives, survey 5.4 distinct skins or 0 where it gives none]
    /** @type {Array<[string, number, number]>} */
    const expected = [
      ['player.settings.volume', 1734, 0], ['player.settings.mute', 602, 0], ['player.settings.balance', 388, 0],
      ['player.controls.pause', 471, 0], ['player.controls.stop', 378, 0], ['player.launchurl', 1014, 131],
      ['player.currentmedia.duration', 494, 0], ['player.playstate', 725, 132], ['player.openstate', 683, 165],
      ['theme.savepreference', 3052, 0], ['theme.loadpreference', 2668, 94], ['theme.openview', 897, 89],
      ['mediacenter.effecttype', 659, 130], ['event.keycode', 614, 72], ['view.close', 737, 175],
    ];
    for (const [name, rawRefs, skins] of expected) {
      const r = row('object-model', name);
      expect(r, name).toBeDefined();
      near(r?.refsAll, rawRefs, 0.08);
      if (skins) near(r?.skins, skins, 0.06);
    }
    near(row('object-model', 'player.settings')?.skins, 177, 0.06);
  });

  it('finds #132 in use by the 104 skins that load it and use osMediaOpen (survey 5.5)', () => {
    near(row('wmploc-132', 'osmediaopen')?.skins, 104, 0.04);
  });

  it('ranks the ambient and EFFECTS methods the corpus calls (survey 5.4)', () => {
    for (const name of ['moveto', 'alphablendto', 'setcolumnresizemode', 'next', 'previous']) {
      expect(row('element-method', name), name).toBeDefined();
    }
  });
});
