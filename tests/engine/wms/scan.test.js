// @ts-check
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { scanWms } from '../../../src/engine/wms/scan.js';
import { decodeText } from '../../../src/engine/text/decode.js';
import { buildWms, encodeText, wmsCase, wmsCases } from '../../support/wms-builder.js';
import { describeHeadspace } from '../../support/fixtures.js';

/** Seeded PRNG (mulberry32) so a failure replays. @param {number} seed */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */

/** A scanned tree as plain data: attributes as ordered `[name, value]` pairs. @param {RawNode} n @returns {any} */
const shape = (n) => ({ tag: n.tag, line: n.line, attrs: n.attrs.map((a) => [a.name, a.value]), children: n.children.map(shape) });

/** The fixture's expected tree in the same shape. @param {import('../../support/wms-builder.js').ExpectNode} n @returns {any} */
const expected = (n) => ({ tag: n.tag, line: n.line, attrs: [...n.attrs], children: n.children.map(expected) });

// The fixture calls an exact and a case-variant duplicate by one kind; the scanner reports two codes
// because the corpus census (survey 2.2) counts them separately.
const KIND = new Map([['duplicate-attribute-case', 'duplicate-attribute']]);
/** First-appearance order, each kind once. @param {Array<{ code: string }>} diagnostics */
const kindsOf = (diagnostics) => [...new Set(diagnostics.map((d) => KIND.get(d.code) ?? d.code))];
/** @param {Array<{ code: string, line?: number }>} diagnostics @param {string} code */
const linesOf = (diagnostics, code) => diagnostics.filter((d) => d.code === code).map((d) => d.line);
const codes = (/** @type {Array<{ code: string }>} */ diagnostics) => diagnostics.map((d) => d.code);

/** One element's attributes as a plain object (names are unique after the scan). @param {string} text */
const attrsOfRoot = (text) => {
  const { root } = scanWms(text);
  return Object.fromEntries((root?.attrs ?? []).map((a) => [a.name, a.value]));
};

describe('every survey 2.2 class and scanner case from the fixture writer', () => {
  const cases = wmsCases();

  it.each(cases.map((c) => [c.id, c]))('%s: tree, lines and diagnostics', (_id, c) => {
    const { root, diagnostics } = scanWms(c.text);
    expect(root).not.toBeNull();
    expect(shape(/** @type {RawNode} */ (root))).toEqual(expected(c.expect.tree));
    expect(kindsOf(diagnostics)).toEqual(c.expect.kinds);
    // Clean input produces no diagnostics at all. Unknown tags are the builder's `unknown-tag`.
    if (c.expect.kinds.length === 0) expect(diagnostics).toEqual([]);
    const lineCount = c.text.split('\n').length;
    for (const d of diagnostics) {
      expect(d.line, d.code).toBeGreaterThanOrEqual(1);
      expect(d.line, d.code).toBeLessThanOrEqual(lineCount);
      expect(['info', 'warn', 'error']).toContain(d.severity);
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });

  it.each([['utf16le'], ['utf16be'], ['utf8-bom'], ['ascii'], ['cp1252']])('%s bytes through decodeText scan to the same trees', (enc) => {
    for (const c of cases) {
      const { text } = decodeText(encodeText(c.text, /** @type {any} */ (enc)));
      expect(shape(/** @type {RawNode} */ (scanWms(text).root)), c.id).toEqual(expected(c.expect.tree));
    }
  });

  it('attributes land in first-appearance order, with the last value and the last line', () => {
    const { root } = scanWms('<THEME>\r\n<VIEW a="1" b="2"\r\n c="3"\r\n a="4"\r\n/>\r\n</THEME>');
    const view = /** @type {RawNode} */ (root).children[0];
    expect(view.attrs).toEqual([
      { name: 'a', value: '4', line: 4 },
      { name: 'b', value: '2', line: 2 },
      { name: 'c', value: '3', line: 3 },
    ]);
  });
});

describe('the five diagnostics the corpus counts, one by one', () => {
  it('duplicate-attribute: the same spelling twice, last wins (U-5)', () => {
    const { root, diagnostics } = scanWms(wmsCase('dup-attr-exact-conflicting').text);
    expect(codes(diagnostics)).toEqual(['duplicate-attribute']);
    expect(linesOf(diagnostics, 'duplicate-attribute')).toEqual([3]);
    expect(/** @type {RawNode} */ (root).children[0].children[0].attrs.find((a) => a.name === 'tooltip')?.value).toBe('31hz');
  });

  it('duplicate-attribute-case: the spellings differ only in case, last wins', () => {
    const { root, diagnostics } = scanWms(wmsCase('dup-attr-case-variant').text);
    expect(codes(diagnostics)).toEqual(['duplicate-attribute-case', 'duplicate-attribute-case']);
    const button = /** @type {RawNode} */ (root).children[0].children[0];
    expect(button.attrs.map((a) => [a.name, a.value])).toEqual([['id', 'b1'], ['tooltip', 'second'], ['uptooltip', 'u2']]);
  });

  it('a repeat is exact when that spelling was already seen, even after a case variant', () => {
    const { diagnostics } = scanWms('<THEME a="1" A="2" a="3" A="4"/>');
    expect(codes(diagnostics)).toEqual(['duplicate-attribute-case', 'duplicate-attribute', 'duplicate-attribute']);
    expect(attrsOfRoot('<THEME a="1" A="2" a="3" A="4"/>')).toEqual({ a: '4' });
  });

  it('a duplicate that repeats the same value is still reported', () => {
    expect(codes(scanWms(wmsCase('dup-attr-same-value').text).diagnostics)).toEqual(['duplicate-attribute']);
  });

  it('missing-whitespace: reported where it happens, and not for `"/>` or `" />`', () => {
    const { diagnostics } = scanWms(wmsCase('missing-whitespace-several').text);
    expect(codes(diagnostics)).toEqual(['missing-whitespace', 'missing-whitespace', 'missing-whitespace', 'missing-whitespace']);
    expect(linesOf(diagnostics, 'missing-whitespace')).toEqual([2, 2, 2, 2]);
    expect(scanWms('<THEME><VIEW a="1"/><VIEW a="1" /><VIEW a="1"\t/><VIEW a="1"></VIEW></THEME>').diagnostics).toEqual([]);
    expect(scanWms('<THEME><VIEW\na="1"\nb="2"\n/></THEME>').diagnostics).toEqual([]);
  });

  it('end-tag-case: the close tag spelling differs from the open tag, on the close tag line', () => {
    const { diagnostics } = scanWms(wmsCase('end-tag-case').text);
    expect(codes(diagnostics)).toEqual(['end-tag-case']);
    expect(linesOf(diagnostics, 'end-tag-case')).toEqual([5]);
    expect(linesOf(scanWms(wmsCase('end-tag-case-root').text).diagnostics, 'end-tag-case')).toEqual([4]);
    // the same spelling twice is not a case problem, even when it is not the usual spelling
    expect(scanWms('<Theme><View></View></Theme>').diagnostics).toEqual([]);
  });

  it('junk-after-root: stop at the first root close, report once, keep the tree', () => {
    const { root, diagnostics } = scanWms(wmsCase('junk-after-root').text);
    expect(codes(diagnostics)).toEqual(['junk-after-root']);
    expect(linesOf(diagnostics, 'junk-after-root')).toEqual([5]);
    expect(/** @type {RawNode} */ (root).children).toHaveLength(1);
    expect(/** @type {RawNode} */ (root).children[0].children[0].attrs[0].value).toBe('b1');
  });

  it('whitespace, comments and processing instructions after the root are not junk', () => {
    const tail = '\r\n  <!-- trailing & comment -->\r\n<?pi x?>\r\n\t\r\n';
    expect(scanWms(`<THEME><VIEW/></THEME>${tail}`).diagnostics).toEqual([]);
    expect(scanWms(`<THEME/>${tail}`).diagnostics).toEqual([]);
  });

  it('a second element after the root is junk and is not read', () => {
    const { root, diagnostics } = scanWms('<THEME/>\n<VIEW id="x"/>');
    expect(codes(diagnostics)).toEqual(['junk-after-root']);
    expect(linesOf(diagnostics, 'junk-after-root')).toEqual([2]);
    expect(/** @type {RawNode} */ (root).children).toEqual([]);
  });
});

describe('tags, attributes and values', () => {
  it('lower-cases tag and attribute names and keeps the case of values', () => {
    const { root } = scanWms('<ThEmE TiTlE="MiXeD"><ViEw ID="Main" BackgroundImage="Bg.BMP"/></tHeMe>');
    expect(shape(/** @type {RawNode} */ (root))).toMatchObject({ tag: 'theme', attrs: [['title', 'MiXeD']], children: [{ tag: 'view', attrs: [['id', 'Main'], ['backgroundimage', 'Bg.BMP']] }] });
  });

  it('folds ASCII only: the Kelvin sign and the Turkish dotted capital I stay what they are', () => {
    const { root } = scanWms('<THEME Key="1" İd="2"/>');
    expect(/** @type {RawNode} */ (root).attrs.map((a) => a.name)).toEqual(['Key', 'İd']);
  });

  it('accepts single quotes, double quotes inside single, and quotes of the other kind inside values', () => {
    expect(attrsOfRoot(`<THEME a='x"y' b="it's" c='' d=""/>`)).toEqual({ a: 'x"y', b: "it's", c: '', d: '' });
  });

  it('an unquoted value runs to whitespace or `>`, and `/>` still closes the element', () => {
    const { root, diagnostics } = scanWms('<THEME w=30 h=40 image=a/b.bmp>\n<VIEW id=v/>\n<VIEW id=w />\n</THEME>');
    expect(shape(/** @type {RawNode} */ (root))).toMatchObject({
      attrs: [['w', '30'], ['h', '40'], ['image', 'a/b.bmp']],
      children: [{ tag: 'view', attrs: [['id', 'v']], children: [] }, { tag: 'view', attrs: [['id', 'w']], children: [] }],
    });
    expect(diagnostics).toEqual([]);
  });

  it('tabs, spaces and line breaks around `=` and between attributes', () => {
    expect(attrsOfRoot('<THEME\ta\t=\t"1"\r\n\tb  =\r\n"2"\r\nc="3"/>')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('a valueless attribute is kept with an empty value and a diagnostic', () => {
    const { root, diagnostics } = scanWms('<THEME><VIEW enabled id="v"/></THEME>');
    expect(/** @type {RawNode} */ (root).children[0].attrs.map((a) => [a.name, a.value])).toEqual([['enabled', ''], ['id', 'v']]);
    expect(codes(diagnostics)).toEqual(['valueless-attribute']);
  });

  it('keeps raw values: padding, CRLF inside a value, `>` and `<` inside quotes', () => {
    expect(attrsOfRoot('<THEME a=" 600 " b="x\r\ny" c="a>b<c" d="jscript:\n player.URL = 1;"/>')).toEqual({
      a: ' 600 ', b: 'x\r\ny', c: 'a>b<c', d: 'jscript:\n player.URL = 1;',
    });
  });

  it('unknown tags and attributes stay as ordinary nodes, in source order, with their children', () => {
    const { root, diagnostics } = scanWms('<THEME><VIEW><network id="n"/><PLAYER><currentMedia id="cm" bogus="1"/></PLAYER><zzz><yyy/></zzz></VIEW></THEME>');
    const view = /** @type {RawNode} */ (root).children[0];
    expect(view.children.map((c) => c.tag)).toEqual(['network', 'player', 'zzz']);
    expect(view.children[1].children[0].attrs.map((a) => a.name)).toEqual(['id', 'bogus']);
    expect(view.children[2].children[0].tag).toBe('yyy');
    expect(diagnostics).toEqual([]);
  });

  it('keeps the root whatever it is called; the builder decides what a theme is', () => {
    expect(/** @type {RawNode} */ (scanWms('<html><body/></html>').root).tag).toBe('html');
  });
});

describe('entities (survey 2.3, G16)', () => {
  it('decodes the five predefined entities and numeric references in values', () => {
    expect(attrsOfRoot('<THEME a="&amp;&lt;&gt;&quot;&apos;" b="&#65;&#x42;&#X43;&#13;&#x0D;&#10;" c="&#x1F600;&#128512;"/>')).toEqual({
      a: `&<>"'`, b: 'ABC\r\r\n', c: '\u{1f600}\u{1f600}',
    });
  });

  it('decodes in one pass: &amp;lt; is the text &lt;, not <', () => {
    expect(attrsOfRoot('<THEME a="&amp;lt;" b="&amp;#65;" c="&amp;amp;"/>')).toEqual({ a: '&lt;', b: '&#65;', c: '&amp;' });
  });

  it('leaves a bare &, an unknown or mis-cased name, a missing `;` and an unusable number as written', () => {
    const v = 'a & b &nbsp; &AMP; &amp &#; &#x; &#xZZ; &#0; &#xD800; &#xDFFF; &#1114112; &#99999999; &#4294967296;';
    expect(attrsOfRoot(`<THEME a="${v}"/>`).a).toBe(v);
  });

  it('accepts the whole Unicode range a reference may name', () => {
    expect(attrsOfRoot('<THEME a="&#1;&#x10FFFF;&#x7F;"/>').a).toBe('\u0001\u{10ffff}\u007f');
    expect(attrsOfRoot('<THEME a="&#00000065;"/>').a).toBe('A');
  });

  it('decodes in attribute values only: names, comments and text keep their ampersands', () => {
    const { root, diagnostics } = scanWms('<THEME a&amp;b="1">&amp; text &lt;VIEW/&gt;<!-- Head & Radio --></THEME>');
    expect(/** @type {RawNode} */ (root).attrs.map((a) => a.name)).toEqual(['a&amp;b']);
    expect(/** @type {RawNode} */ (root).children).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('a decoded value is data: a decoded `<VIEW/>` is not a tag', () => {
    const { root } = scanWms('<THEME a="&lt;VIEW id=&quot;x&quot;/&gt;"/>');
    expect(/** @type {RawNode} */ (root).children).toEqual([]);
    expect(/** @type {RawNode} */ (root).attrs[0].value).toBe('<VIEW id="x"/>');
  });
});

describe('skin-controlled names are keys, never members (E §1 rule 6)', () => {
  it('attributes named __proto__, constructor, toString and hasOwnProperty are ordinary attributes', () => {
    const { root, diagnostics } = scanWms('<THEME __proto__="1" constructor="2" toString="3" hasOwnProperty="4" valueOf="5"/>');
    const node = /** @type {RawNode} */ (root);
    expect(node.attrs.map((a) => [a.name, a.value])).toEqual([
      ['__proto__', '1'], ['constructor', '2'], ['tostring', '3'], ['hasownproperty', '4'], ['valueof', '5'],
    ]);
    expect(diagnostics).toEqual([]);
    expect(Object.getPrototypeOf(node)).toBe(Object.prototype); // nothing was written onto a prototype
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
  });

  it('duplicates of those names resolve last-wins and are reported, not mistaken for an inherited member', () => {
    const { root, diagnostics } = scanWms('<THEME __proto__="1" constructor="2" __proto__="3" CONSTRUCTOR="4"/>');
    expect(/** @type {RawNode} */ (root).attrs.map((a) => [a.name, a.value])).toEqual([['__proto__', '3'], ['constructor', '4']]);
    expect(codes(diagnostics)).toEqual(['duplicate-attribute', 'duplicate-attribute-case']);
  });

  it('a first-time attribute named constructor is not a duplicate of Object.prototype.constructor', () => {
    expect(scanWms('<THEME constructor="x"/>').diagnostics).toEqual([]);
    expect(scanWms('<THEME __proto__="x"/>').diagnostics).toEqual([]);
  });

  it('tags named __proto__ and constructor, as open and close tags, are plain nodes', () => {
    const { root, diagnostics } = scanWms('<THEME><__proto__ id="a"><constructor/></__PROTO__><toString></toString></THEME>');
    const node = /** @type {RawNode} */ (root);
    expect(node.children.map((c) => c.tag)).toEqual(['__proto__', 'tostring']);
    expect(node.children[0].children[0].tag).toBe('constructor');
    expect(codes(diagnostics)).toEqual(['end-tag-case']);
  });

  it('entity names __proto__ and constructor stay literal', () => {
    expect(attrsOfRoot('<THEME a="&__proto__;" b="&constructor;" c="&toString;" d="&hasOwnProperty;"/>')).toEqual({
      a: '&__proto__;', b: '&constructor;', c: '&toString;', d: '&hasOwnProperty;',
    });
  });

  it('a close tag named constructor with nothing open is an orphan, not a lookup hit', () => {
    expect(codes(scanWms('<THEME></constructor></__proto__></THEME>').diagnostics)).toEqual(['orphan-close-tag', 'orphan-close-tag']);
  });
});

describe('comments, declarations and text', () => {
  it('skips comments (with a bare &, tags and quotes inside), <?...?>, <!DOCTYPE> and CDATA', () => {
    const text = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE theme>',
      '<!-- Copyright & Co <VIEW id="no"/> " -->',
      '<THEME>',
      '  <!-- <BUTTON id="no"/> --><VIEW id="v"><?x y?><![CDATA[ <BUTTON id="no"/> ]]></VIEW>',
      '  text <b stray text',
      '</THEME>',
    ].join('\r\n');
    const { root, diagnostics } = scanWms(text);
    expect(shape(/** @type {RawNode} */ (root))).toMatchObject({
      tag: 'theme', line: 4,
      children: [{ tag: 'view', line: 5, attrs: [['id', 'v']], children: [] }, { tag: 'b', line: 6, attrs: [['stray', ''], ['text', '']] }],
    });
    // `<b stray text` is cut off by the next tag; it stays open until `</THEME>` closes it implicitly
    expect(codes(diagnostics)).toEqual(['valueless-attribute', 'valueless-attribute', 'unterminated-tag', 'unclosed-tag']);
  });

  it('an unterminated comment ends the scan with a diagnostic and keeps what came before', () => {
    const { root, diagnostics } = scanWms('<THEME>\n<VIEW id="a"/>\n<!-- never closed\n<VIEW id="b"/>');
    expect(/** @type {RawNode} */ (root).children.map((c) => c.attrs[0].value)).toEqual(['a']);
    expect(linesOf(diagnostics, 'unterminated-comment')).toEqual([3]);
  });

  it('a `<` that starts no tag is text', () => {
    const { root, diagnostics } = scanWms('<THEME>a < b <3 << <  <VIEW id="v"/> </THEME>');
    expect(/** @type {RawNode} */ (root).children.map((c) => c.tag)).toEqual(['view']);
    expect(diagnostics).toEqual([]);
  });

  it('skips text and a leading BOM character before the root, including text that looks like a tag end', () => {
    const { root } = scanWms('﻿ \r\n garbage > here <THEME/>');
    expect(/** @type {RawNode} */ (root).tag).toBe('theme');
    expect(/** @type {RawNode} */ (root).line).toBe(2);
  });
});

describe('structure: nesting, implicit closes, orphans', () => {
  it('a close tag pops to the nearest open tag of that name, reporting each element it closes implicitly', () => {
    const { root, diagnostics } = scanWms('<THEME>\n<VIEW id="v">\n<SUBVIEW id="s">\n<BUTTON id="b">\n</VIEW>\n<VIEW id="w"/>\n</THEME>');
    const node = /** @type {RawNode} */ (root);
    expect(shape(node)).toMatchObject({
      children: [
        { tag: 'view', line: 2, children: [{ tag: 'subview', line: 3, children: [{ tag: 'button', line: 4 }] }] },
        { tag: 'view', line: 6 },
      ],
    });
    expect(codes(diagnostics)).toEqual(['unclosed-tag', 'unclosed-tag']);
    expect(linesOf(diagnostics, 'unclosed-tag')).toEqual([5, 5]);
  });

  it('an implicit close is not an end-tag-case; a case difference on the matched tag still is', () => {
    expect(codes(scanWms('<THEME><View><SUBVIEW></view></THEME>').diagnostics)).toEqual(['unclosed-tag', 'end-tag-case']);
  });

  it('the nearest match wins when a name repeats', () => {
    const { root } = scanWms('<THEME><SUBVIEW id="a"><SUBVIEW id="b"></SUBVIEW><BUTTON id="c"/></SUBVIEW></THEME>');
    const a = /** @type {RawNode} */ (root).children[0];
    expect(a.children.map((c) => c.tag)).toEqual(['subview', 'button']);
    expect(a.children[0].children).toEqual([]);
  });

  it('an orphan close tag is ignored, before the root too', () => {
    const { root, diagnostics } = scanWms('</VIEW>\n<THEME>\n</BUTTON>\n</THEME>');
    expect(/** @type {RawNode} */ (root).tag).toBe('theme');
    expect(linesOf(diagnostics, 'orphan-close-tag')).toEqual([1, 3]);
  });

  it('the open-name counts follow every pop: an element closed implicitly is an orphan afterwards', () => {
    // `</b>` pops c implicitly, so the later `</c>` has nothing to close; the second `<b>` is a fresh open.
    const { root, diagnostics } = scanWms('<a>\n<b><c>\n</b>\n</C>\n<b>\n</b>\n</b>\n</a>');
    expect(shape(/** @type {RawNode} */ (root)).children.map((/** @type {any} */ c) => c.tag)).toEqual(['b', 'b']);
    expect(codes(diagnostics)).toEqual(['unclosed-tag', 'orphan-close-tag', 'orphan-close-tag']);
    expect(linesOf(diagnostics, 'orphan-close-tag')).toEqual([4, 7]);
    // Nested same-name elements: two closes pair with two opens, the third is an orphan.
    const nested = scanWms('<r><a><a></a></a></a></r>');
    expect(codes(nested.diagnostics)).toEqual(['orphan-close-tag']);
    expect(shape(/** @type {RawNode} */ (nested.root)).children[0].children).toHaveLength(1);
  });

  it('`<A></A>` and `<A/>` give the same node, with or without whitespace in the close tag', () => {
    const a = shape(/** @type {RawNode} */ (scanWms('<THEME><A x="1"></A></THEME>').root));
    const b = shape(/** @type {RawNode} */ (scanWms('<THEME><A x="1"/></THEME>').root));
    const c = shape(/** @type {RawNode} */ (scanWms('<THEME><A x="1"  ></A  ></THEME>').root));
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('a close tag with attributes or spaces still closes', () => {
    const { root, diagnostics } = scanWms('<THEME><VIEW></ VIEW junk="1" ></THEME>');
    expect(/** @type {RawNode} */ (root).children).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });
});

describe('line numbers', () => {
  it('count LF, CRLF and lone CR as one break each, and a node is on the line of its `<`', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const text = ['<THEME>', '', '<VIEW', ' a="1"', ' b="2">', '<BUTTON/>', '</VIEW>', '</THEME>'].join(eol);
      const { root } = scanWms(text);
      const view = /** @type {RawNode} */ (root).children[0];
      expect([view.line, view.attrs.map((a) => a.line), view.children[0].line], JSON.stringify(eol)).toEqual([3, [4, 5], 6]);
    }
  });

  it('a multi-line attribute value moves the lines of what follows it', () => {
    const { root } = scanWms('<THEME>\n<VIEW onload="a();\nb();\nc();" id="v"/>\n<BUTTON/>\n</THEME>');
    const [view, button] = /** @type {RawNode} */ (root).children;
    expect([view.line, view.attrs[1].line, button.line]).toEqual([2, 4, 5]);
  });
});

describe('truncated and hostile text never throws and always returns a result', () => {
  it('empty, blank and tagless text have no root', () => {
    for (const text of ['', '   \r\n ', 'just words', '<!-- only a comment -->', '<?xml version="1.0"?>', '<', '<>', '</>', '< THEME/>']) {
      const r = scanWms(text);
      expect(r.root, JSON.stringify(text)).toBeNull();
      expect(codes(r.diagnostics).includes('no-root') || r.diagnostics.length > 0, JSON.stringify(text)).toBe(true);
    }
    expect(codes(scanWms('').diagnostics)).toEqual(['no-root']);
  });

  it('an unclosed root is still the root, with what was read', () => {
    const { root, diagnostics } = scanWms('<THEME>\r\n<VIEW id="v">\r\n<BUTTON id="b"/>');
    expect(shape(/** @type {RawNode} */ (root))).toMatchObject({ tag: 'theme', children: [{ tag: 'view', children: [{ tag: 'button' }] }] });
    expect(codes(diagnostics)).toEqual(['unclosed-tag', 'unclosed-tag']);
    expect(linesOf(diagnostics, 'unclosed-tag')).toEqual([3, 3]);
  });

  it('cut off inside a tag name, an attribute name, a value, or before `>`', () => {
    for (const text of ['<THEME', '<THEME ', '<THEME a', '<THEME a=', '<THEME a="', '<THEME a="1', '<THEME a="1"', '<THEME a="1" /', '<THEME><VIEW', '<THEME><VIEW id="a">', '<THEME></VIE']) {
      const r = scanWms(text);
      expect(r.root?.tag, text).toBe('theme');
      expect(r.diagnostics.length, text).toBeGreaterThan(0);
    }
    const r = scanWms('<THEME><VIEW id="a" width="4');
    expect(shape(/** @type {RawNode} */ (r.root)).children[0].attrs).toEqual([['id', 'a'], ['width', '4']]);
    expect(codes(r.diagnostics)).toContain('unterminated-value');
  });

  it('a missing `>` runs into the next tag, which is read normally', () => {
    const { root, diagnostics } = scanWms('<THEME>\n<VIEW id="a"\n<BUTTON id="b"/>\n</VIEW>\n</THEME>');
    const view = /** @type {RawNode} */ (root).children[0];
    expect(view.attrs.map((a) => a.value)).toEqual(['a']);
    expect(view.children.map((c) => c.attrs[0].value)).toEqual(['b']);
    expect(linesOf(diagnostics, 'unterminated-tag')).toEqual([2]);
  });

  it('a close tag with no `>` still closes, at the end of the text or before the next tag', () => {
    const atEnd = scanWms('<THEME><VIEW></VIEW');
    expect(shape(/** @type {RawNode} */ (atEnd.root)).children).toMatchObject([{ tag: 'view' }]);
    expect(codes(atEnd.diagnostics)).toEqual(['unterminated-tag', 'unclosed-tag']);

    const before = scanWms('<THEME>\n<VIEW></VIEW\n<BUTTON id="b"/>\n</THEME>');
    expect(/** @type {RawNode} */ (before.root).children.map((c) => c.tag)).toEqual(['view', 'button']);
    expect(codes(before.diagnostics)).toEqual(['unterminated-tag']);
    expect(linesOf(before.diagnostics, 'unterminated-tag')).toEqual([2]);
  });

  it('stray quotes, equals signs and slashes inside a tag are skipped and reported', () => {
    const { root, diagnostics } = scanWms('<THEME a="1" " = / b="2" \'x\' c/ d="3">\n</THEME>');
    expect(/** @type {RawNode} */ (root).attrs.map((a) => [a.name, a.value])).toEqual([['a', '1'], ['b', '2'], ['x', ''], ['c', ''], ['d', '3']]);
    expect(codes(diagnostics).filter((c) => c === 'stray-character').length).toBeGreaterThanOrEqual(3);
  });

  it('a 100,000-deep file builds without recursion, and every level is where it should be', () => {
    const depth = 100_000;
    const { root, diagnostics } = scanWms(`${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`);
    let d = 0;
    for (let n = root; n; n = n.children[0] ?? null) d++;
    expect(d).toBe(depth);
    expect(diagnostics).toEqual([]);
  });

  it('a 100,000-deep file that is never closed reports the open elements without recursion', () => {
    const depth = 100_000;
    const { root, diagnostics } = scanWms('<a>'.repeat(depth));
    expect(root?.tag).toBe('a');
    expect(codes(diagnostics).filter((c) => c === 'unclosed-tag').length).toBe(500); // per-code cap
    expect(codes(diagnostics)).toContain('diagnostics-truncated');
  });

  it('50,000 siblings scan quickly and in order', () => {
    const n = 50_000;
    const text = `<THEME>${Array.from({ length: n }, (_, i) => `<BUTTON id="b${i}" left="${i}"/>`).join('\r\n')}</THEME>`;
    const t0 = performance.now();
    const { root } = scanWms(text);
    const ms = performance.now() - t0;
    expect(/** @type {RawNode} */ (root).children).toHaveLength(n);
    expect(/** @type {RawNode} */ (root).children[n - 1].attrs[0].value).toBe(`b${n - 1}`);
    expect(ms).toBeLessThan(2000);
  });

  it('200,000 orphan close tags under a 20,000-deep chain cost O(1) each, not O(depth)', () => {
    const depth = 20_000;
    const text = `${'<a>'.repeat(depth)}${'</b>'.repeat(200_000)}`;
    const t0 = performance.now();
    const { root, diagnostics } = scanWms(text);
    const ms = performance.now() - t0;
    expect(root?.tag).toBe('a');
    let d = 0;
    for (let node = root; node; node = node.children[0] ?? null) d++;
    expect(d).toBe(depth); // no `</b>` closed anything
    expect(codes(diagnostics).filter((c) => c === 'orphan-close-tag')).toHaveLength(500);
    // The cap's marker follows the 500th orphan directly.
    expect(diagnostics[500].code).toBe('diagnostics-truncated');
    expect(diagnostics[500].detail).toContain('orphan-close-tag');
    expect(ms).toBeLessThan(2000);
  });

  it('about 40,000 case permutations of one attribute name cost O(1) each and keep one attribute', () => {
    const letters = 'abcdefghijklmnop';
    const count = 40_000; // 2^16 permutations exist
    const parts = new Array(count);
    for (let i = 0; i < count; i++) {
      let name = '';
      for (let k = 0; k < letters.length; k++) name += (i >> k) & 1 ? letters[k].toUpperCase() : letters[k];
      parts[i] = `${name}="${i}"`;
    }
    const text = `<THEME ${parts.join(' ')}/>`;
    const t0 = performance.now();
    const { root, diagnostics } = scanWms(text);
    const ms = performance.now() - t0;
    expect(/** @type {RawNode} */ (root).attrs).toEqual([{ name: letters, value: String(count - 1), line: 1 }]);
    expect(codes(diagnostics).filter((c) => c === 'duplicate-attribute-case')).toHaveLength(500);
    expect(codes(diagnostics)).not.toContain('duplicate-attribute');
    expect(diagnostics.at(-1)?.code).toBe('diagnostics-truncated');
    expect(ms).toBeLessThan(2000);
  });

  it('an element with 20,000 distinct attributes and one with 20,000 repeats of one attribute', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `a${i}="${i}"`).join(' ');
    expect(/** @type {RawNode} */ (scanWms(`<THEME ${many}/>`).root).attrs).toHaveLength(20_000);
    const same = scanWms(`<THEME ${'a="1" '.repeat(20_000)}/>`);
    expect(/** @type {RawNode} */ (same.root).attrs).toHaveLength(1);
    expect(codes(same.diagnostics).filter((c) => c === 'duplicate-attribute')).toHaveLength(500);
    expect(same.diagnostics.at(-1)?.code).toBe('diagnostics-truncated');
  });

  it('long diagnostics quote at most a short slice of skin text', () => {
    const name = 'x'.repeat(10_000);
    const { diagnostics } = scanWms(`<THEME ${name}="1" ${name}="2"/>`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].detail.length).toBeLessThan(200);
  });

  it('survives a seeded fuzz of tag-shaped fragments, and keeps its invariants', () => {
    const rand = rng(20261006);
    const pieces = ['<', '>', '/', '</', '/>', '"', "'", '=', ' ', '\n', '\r\n', 'a', 'B', 'view', 'id', '&', '&amp;', '&#13;', '&#x;', '#', '<!--', '-->', '<?', '?>', '<![CDATA[', ']]>', '<THEME', '</THEME>', '<VIEW ', 'x="1"', "y='2'", 'z=3', 'K', '﻿', '\u0000'];
    for (let k = 0; k < 3000; k++) {
      let text = '';
      const len = 1 + Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) text += pieces[Math.floor(rand() * pieces.length)];
      const { root, diagnostics } = scanWms(text);
      const lines = text.split(/\r\n|\r|\n/).length;
      for (const d of diagnostics) {
        expect(d.line).toBeGreaterThanOrEqual(1);
        expect(d.line).toBeLessThanOrEqual(lines);
      }
      /** @type {RawNode[]} */
      const todo = root ? [root] : [];
      while (todo.length) {
        const node = /** @type {RawNode} */ (todo.pop());
        expect(node.tag).toBe(node.tag.replace(/[A-Z]/g, ''));
        expect(node.line).toBeGreaterThanOrEqual(1);
        expect(node.line).toBeLessThanOrEqual(lines);
        const names = node.attrs.map((a) => a.name);
        expect(new Set(names).size).toBe(names.length);
        for (const a of node.attrs) {
          expect(a.name).toBe(a.name.replace(/[A-Z]/g, ''));
          expect(a.line).toBeGreaterThanOrEqual(node.line);
          expect(a.line).toBeLessThanOrEqual(lines);
        }
        todo.push(...node.children);
      }
    }
  });
});

describe('round trip with the fixture serialiser', () => {
  it('scanWms(buildWms(tree)) is the tree, for seeded random trees with hostile attribute values', () => {
    const rand = rng(77);
    const alphabet = ['a', 'Z', ' ', '\t', '>', "'", '&', ';', '#', '/', '=', '\r\n', '\n', 'é', '€', '\u{1f600}', 'jscript:', '&amp;', '&#13;', '<!--', '-->'];
    const value = () => Array.from({ length: Math.floor(rand() * 12) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
    const tags = ['THEME', 'VIEW', 'SUBVIEW', 'BUTTON', 'weird-tag', 'x.y', 'n:s', 'Q'];
    /** @param {number} depth @returns {import('../../support/wms-builder.js').WmsNode} */
    const tree = (depth) => ({
      tag: tags[Math.floor(rand() * tags.length)],
      attrs: Array.from({ length: Math.floor(rand() * 5) }, (_, i) => /** @type {[string, string]} */ ([`attr${i}${rand() < 0.3 ? 'X' : 'x'}`, value()])),
      children: depth > 0 ? Array.from({ length: Math.floor(rand() * 4) }, () => tree(depth - 1)) : [],
    });
    /** @param {import('../../support/wms-builder.js').WmsNode} n @returns {any} */
    const lowered = (n) => ({
      tag: n.tag.toLowerCase(),
      attrs: (n.attrs ?? []).map(([k, v]) => [k.toLowerCase(), v]),
      children: (n.children ?? []).map(lowered),
    });
    /** @param {any} n @returns {any} */
    const bare = (n) => ({ tag: n.tag, attrs: n.attrs, children: n.children.map(bare) });
    for (let k = 0; k < 300; k++) {
      const t = tree(3);
      const { root, diagnostics } = scanWms(buildWms(t));
      expect(bare(shape(/** @type {RawNode} */ (root))), `tree ${k}`).toEqual(lowered(t));
      // the serialiser escapes & < ", so no value can make the scanner repair anything
      expect(diagnostics, `tree ${k}`).toEqual([]);
    }
  });
});

describeHeadspace('Headspace (the owner\'s 2001 file)', (hs) => {
  /** @param {Uint8Array} archive @param {string} base */
  const entry = (archive, base) => {
    const files = unzipSync(archive, { filter: (f) => f.name.toLowerCase().split('/').pop() === base });
    const key = Object.keys(files)[0];
    if (!key) throw new Error(`no ${base} in the archive`);
    return files[key];
  };

  it('headspace.wms is the UTF-16LE file of ENGINE Appendix A, and headspace.js is cp1252', () => {
    const wms = entry(hs.bytes(), 'headspace.wms');
    expect(createHash('sha1').update(wms).digest('hex').startsWith('2870d4b1')).toBe(true);
    const d = decodeText(wms);
    expect(d.encoding).toBe('utf-16le');
    expect(d.text.length).toBe(22045);
    expect(d.text.split('\n').length - 1).toBe(523);

    const js = entry(hs.bytes(), 'headspace.js');
    expect(createHash('sha1').update(js).digest('hex').startsWith('073d4ffb')).toBe(true);
    const j = decodeText(js);
    expect(j.encoding).toBe('cp1252');
    expect(js.length).toBe(3590);
    expect(j.text.split('\n').length).toBe(147);
    expect(j.text).toContain('©2000 Microsoft');
    expect(j.text).not.toContain('�');
  });

  it('scans to one VIEW with 23 subview descendants, 69 elements, and the value classes survey R0 counts', () => {
    const { root, diagnostics } = scanWms(decodeText(entry(hs.bytes(), 'headspace.wms')).text);
    expect(diagnostics).toEqual([]);
    const theme = /** @type {RawNode} */ (root);
    expect(theme.tag).toBe('theme');
    const views = theme.children.filter((c) => c.tag === 'view');
    expect(views).toHaveLength(1);
    expect(theme.children).toHaveLength(1);
    const view = views[0];
    expect(Object.fromEntries(view.attrs.map((a) => [a.name, a.value]))).toMatchObject({ width: '760', height: '394', backgroundcolor: 'none' });
    expect(view.attrs.some((a) => a.name === 'id')).toBe(false);

    let nodes = 0;
    let subviews = 0;
    const counts = { jscript: 0, wmpprop: 0, wmpenabled: 0, wmpdisabled: 0 };
    /** @type {Array<[RawNode, boolean]>} */
    const todo = [[theme, false]];
    while (todo.length) {
      const [node, underView] = /** @type {[RawNode, boolean]} */ (todo.pop());
      nodes++;
      if (underView && node.tag === 'subview') subviews++;
      for (const a of node.attrs) {
        const v = a.value.trimStart().toLowerCase();
        if (v.startsWith('jscript:')) counts.jscript++;
        else if (v.startsWith('wmpprop:')) counts.wmpprop++;
        else if (v.startsWith('wmpenabled:')) counts.wmpenabled++;
        else if (v.startsWith('wmpdisabled:')) counts.wmpdisabled++;
      }
      for (const c of node.children) todo.push([c, underView || node === view]);
    }
    expect(subviews).toBe(23);
    expect(nodes).toBe(69);
    expect(counts).toEqual({ jscript: 25, wmpprop: 18, wmpenabled: 2, wmpdisabled: 0 });
  });
});
