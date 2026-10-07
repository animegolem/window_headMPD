// @ts-check
// The throwaway handler extractor (extract-handlers.mjs) checked against synthetic input: text
// encodings, entities, the tolerant attribute scan, the survey's primary-`.wms` rule, distinct-archive
// choice, and a real zip with a corrupt first local signature. No art is read here.

import { describe, expect, it } from 'vitest';
import { buildWms, encodeText, minimalSkin } from '../support/wms-builder.js';
import { buildZip } from '../support/zip-writer.js';
import {
  PRIMARY_RULINGS,
  decodeText,
  distinctArchives,
  extractArchive,
  extractHandlers,
  isHandlerAttribute,
  pickPrimaryWms,
  scanAttributes,
  unescapeEntities,
} from './extract-handlers.mjs';

const bytes = (/** @type {number[]} */ ...b) => Uint8Array.from(b);

describe('decodeText', () => {
  it('reads each BOM', () => {
    expect(decodeText(encodeText('<A b="é"/>', 'utf16le'))).toBe('<A b="é"/>');
    expect(decodeText(encodeText('<A b="é"/>', 'utf16be'))).toBe('<A b="é"/>');
    expect(decodeText(encodeText('<A b="é"/>', 'utf8-bom'))).toBe('<A b="é"/>');
  });

  it('reads valid UTF-8 as UTF-8 and anything else as Windows-1252', () => {
    expect(decodeText(encodeText('café', 'utf8'))).toBe('café');
    expect(decodeText(bytes(0x63, 0x61, 0x66, 0xe9))).toBe('café');       // lone 0xE9 is not UTF-8
    expect(decodeText(bytes(0x92))).toBe('’');                             // cp1252 curly apostrophe
  });
});

describe('unescapeEntities', () => {
  it('decodes the five XML entities and numeric references, once', () => {
    expect(unescapeEntities('a &lt; b &amp;&amp; c &gt; &quot;d&quot; &apos;e&apos;')).toBe('a < b && c > "d" \'e\'');
    expect(unescapeEntities('&#39;&#x27;&#X41;&#65;')).toBe("''AA");
    expect(unescapeEntities('&amp;lt;')).toBe('&lt;');                           // one pass, not two
  });

  it('leaves what it does not know exactly as written', () => {
    expect(unescapeEntities('x&nbsp;y &bogus; &#0; &#xD800; &#1114112; a&b')).toBe('x&nbsp;y &bogus; &#0; &#xD800; &#1114112; a&b');
  });
});

describe('scanAttributes', () => {
  /** @param {string} text */
  const scan = (text) => [...scanAttributes(text)].map((a) => `${a.tag}:${a.name}=${a.value}`);

  it('keeps duplicates and reads attributes with no whitespace between them', () => {
    expect(scan('<BUTTON id="a" onClick="x" onClick="y"/>')).toEqual(['BUTTON:id=a', 'BUTTON:onClick=x', 'BUTTON:onClick=y']);
    expect(scan('<BUTTON id="a"onClick="x"/>')).toEqual(['BUTTON:id=a', 'BUTTON:onClick=x']);
  });

  it('reads quotes, unquoted values, valueless attributes and a > inside a value', () => {
    expect(scan(`<A p='1' q=2 r s="a>b" t = "c" />`)).toEqual(['A:p=1', 'A:q=2', 'A:r=null', 'A:s=a>b', 'A:t=c']);
  });

  it('counts an empty value, which the survey counted', () => {
    expect(scan('<A onClick=""/>')).toEqual(['A:onClick=']);
  });

  it('skips comments, processing instructions, CDATA, declarations and end tags', () => {
    const text = '<?xml version="1.0"?><!-- <X onClick="no"/> --><![CDATA[ <Y onClick="no"/> ]]><!DOCTYPE z></Q onClick="no"><A onClick="yes"/>';
    expect(scan(text)).toEqual(['A:onClick=yes']);
  });

  it('survives truncated input without looping', () => {
    expect(scan('<A onClick="x')).toEqual(['A:onClick=x']);
    expect(scan('<A')).toEqual([]);
    expect(scan('<!-- never closed <A onClick="x"/>')).toEqual([]);
    expect(scan('< <<>')).toEqual([]);
  });

  it('is not fooled by attribute names that are skin-controlled keys', () => {
    expect(scan('<A __proto__="1" constructor="2" onClick="3"/>')).toEqual(['A:__proto__=1', 'A:constructor=2', 'A:onClick=3']);
  });
});

describe('extractHandlers', () => {
  it("applies the survey's definition: names starting with on or ending in _onchange, any case, entity-decoded", () => {
    const text = `<VIEW onLoad="a&lt;b" Value_OnChange="jscript:c();" ONCLICK='d' id="x" scriptFile="y.js" once="z" onclick="" notanon="n"/>`;
    expect(extractHandlers(text)).toEqual([
      { tag: 'VIEW', attr: 'onLoad', src: 'a<b' },
      { tag: 'VIEW', attr: 'Value_OnChange', src: 'jscript:c();' },
      { tag: 'VIEW', attr: 'ONCLICK', src: 'd' },
      { tag: 'VIEW', attr: 'once', src: 'z' },                                  // a prefix test, so `once` counts, as it did in the survey
      { tag: 'VIEW', attr: 'onclick', src: '' },
    ]);
    expect(isHandlerAttribute('playstate_onchange')).toBe(true);
    expect(isHandlerAttribute('id')).toBe(false);
  });
});

describe('pickPrimaryWms', () => {
  const e = (/** @type {string} */ name, /** @type {number} */ size) => ({ name, size });

  it('prefers the .wms whose stem is the archive stem, after stripping everything through the first __', () => {
    expect(pickPrimaryWms('Nautical.wmz', [e('Nautical.wms', 19644), e('sample.wms', 6415)])).toBe('Nautical.wms');
    expect(pickPrimaryWms('theskinsfactory__xsn_sports.wmz', [e('big.wms', 99), e('xsn_sports.wms', 1)])).toBe('xsn_sports.wms');
    expect(pickPrimaryWms('A.WMZ', [e('dir/a.WMS', 1), e('b.wms', 2)])).toBe('dir/a.WMS');
  });

  it('lets the last stem match win, and falls back to the largest', () => {
    expect(pickPrimaryWms('a.wmz', [e('a.wms', 1), e('sub\\a.wms', 9)])).toBe('sub\\a.wms');
    expect(pickPrimaryWms('zzz.wmz', [e('one.wms', 5), e('two.wms', 50), e('three.wms', 7)])).toBe('two.wms');
    expect(pickPrimaryWms('zzz.wmz', [])).toBeNull();
  });

  it("applies the survey's one manual ruling, Sports, over the largest-file fallback", () => {
    expect([...PRIMARY_RULINGS]).toEqual([['sports', 'extremesports.wms']]);
    const sports = [e('ExtremeSports.wms', 13247), e('saltmine.wms', 14795)];
    expect(pickPrimaryWms('Sports.wmz', sports)).toBe('ExtremeSports.wms');
    expect(pickPrimaryWms('saltmine__Sports.wmz', sports)).toBe('ExtremeSports.wms');
    expect(pickPrimaryWms('Other.wmz', sports)).toBe('saltmine.wms');             // the ruling is for that archive only
  });
});

describe('distinctArchives', () => {
  it('keeps one archive per SHA-256, preferring no __, then the shorter name, then the earlier', () => {
    const m = new Map([
      ['microsoft__Classic.wmz', 'h1'],
      ['Classic.wmz', 'h1'],
      ['theskinsfactory__Blinx.wmz', 'h2'],
      ['bb__Blinx.wmz', 'h2'],
      ['Unique.wmz', 'h3'],
    ]);
    // Result order is the preference order: no __ first, then shorter, then by name.
    expect(distinctArchives(m)).toEqual([
      { name: 'Unique.wmz', sha256: 'h3' },
      { name: 'Classic.wmz', sha256: 'h1' },
      { name: 'bb__Blinx.wmz', sha256: 'h2' },
    ]);
  });

  it('treats archive names named __proto__ and constructor as plain names', () => {
    const m = new Map([['__proto__', 'h1'], ['constructor', 'h2'], ['__proto__.wmz', 'h1']]);
    expect(distinctArchives(m).map((a) => a.name).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('extractArchive', () => {
  it('pulls the primary .wms handlers (entity-decoded) and every .js, in a real zip', () => {
    const skin = minimalSkin({ name: 'demo', onclick: 'if (a<b && c) { go("x"); }', script: 'function noop() {}\r\n' });
    const out = extractArchive('demo.wmz', skin.bytes);
    expect(out.primary).toBe('demo.wms');
    expect(out.handlers).toEqual([{ tag: 'BUTTON', attr: 'onClick', src: 'if (a<b && c) { go("x"); }' }]);
    expect(out.scripts).toEqual([{ file: 'demo.js', source: 'function noop() {}\r\n' }]);
  });

  it('takes only the primary .wms, matches .JS in any case and directory, and reads names like __proto__.js', () => {
    const wms = (/** @type {string} */ h) => encodeText(buildWms({ tag: 'THEME', children: [{ tag: 'VIEW', attrs: [['onLoad', h]] }] }), 'ascii');
    const zip = buildZip([
      { name: 'other.wms', data: wms('other()') },
      { name: 'main.wms', data: wms('main()') },
      { name: 'Scripts/MAIN.JS', data: 'var upper;' },
      { name: '__proto__.js', data: 'var p;' },
      { name: 'constructor.js', data: 'var c;' },
      { name: 'notes.txt', data: 'not a script' },
      { name: 'dir/', dir: true },
    ]);
    const out = extractArchive('main.wmz', zip);
    expect(out.primary).toBe('main.wms');
    expect(out.handlers.map((h) => h.src)).toEqual(['main()']);
    expect(out.scripts.map((s) => s.file).sort()).toEqual(['Scripts/MAIN.JS', '__proto__.js', 'constructor.js']);
  });

  it('reads an archive whose first local header signature is corrupt (3 corpus archives)', () => {
    const zip = buildZip([
      { name: 'skin.wms', data: buildWms({ tag: 'VIEW', attrs: [['onClick', 'salvaged()']] }), localSignature: Uint8Array.of(1, 0, 1, 0) },
      { name: 'skin.js', data: 'var x;' },
    ]);
    const out = extractArchive('skin.wmz', zip);
    expect(out.handlers.map((h) => h.src)).toEqual(['salvaged()']);
    expect(out.scripts.map((s) => s.file)).toEqual(['skin.js']);
  });

  it('returns nothing for an archive with no .wms and no .js', () => {
    const out = extractArchive('empty.wmz', buildZip([{ name: 'a.bmp', data: 'x' }]));
    expect(out).toEqual({ archive: 'empty.wmz', primary: null, handlers: [], scripts: [] });
  });
});
