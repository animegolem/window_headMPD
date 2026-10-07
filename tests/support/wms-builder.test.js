// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWms, encodeText, minimalSkin, wmsCase, wmsCaseIds, wmsCases } from './wms-builder.js';
import { HAS_PYTHON, HAS_SIPS, HAS_UNZIP, expatCheck, makeTempDir, sipsSize, unzip, unzipEntry } from './ref-decoders.js';
import { buildBmp } from './bmp-writer.js';

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-wms-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const cases = wmsCases();

describe('wms failure cases', () => {
  it('has one case per survey 2.2 class and the scanner cases W1.2 lists', () => {
    const ids = wmsCaseIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'dup-attr-exact-conflicting', 'dup-attr-case-variant', 'missing-whitespace-after-value', 'end-tag-case', 'junk-after-root', // survey 2.2's five classes
      'tabs-around-equals', 'entities-in-values', 'leading-blank-line', 'orphan-close-tag', 'unknown-tags-and-attributes', 'all-classes-combined',
    ]) expect(ids, id).toContain(id);
  });

  it('lines are CRLF, as in 340 of 342 corpus files, except the LF case', () => {
    for (const c of cases) {
      const crlf = (c.text.match(/\r\n/g) ?? []).length;
      const lf = (c.text.match(/\n/g) ?? []).length;
      if (c.id === 'lf-line-endings') expect(crlf).toBe(0);
      else expect(crlf).toBe(lf);
    }
  });

  /** The hand-written expectations: every node sits on the line it claims, and every attribute name is there. */
  it.each(cases.map((c) => [c.id, c]))('%s: expected nodes and attributes are where the text says', (_id, c) => {
    const lines = c.text.split(/\r?\n/);
    /** @param {import('./wms-builder.js').ExpectNode} node */
    const check = (node) => {
      const line = lines[node.line - 1] ?? '';
      expect(line.toLowerCase(), `<${node.tag}> on line ${node.line}`).toContain(`<${node.tag}`);
      for (const [name, value] of node.attrs) {
        expect(line.toLowerCase(), `${node.tag}@${name}`).toContain(name);
        if (!/[&<>\r']/.test(value) && value.trim() === value) expect(line, `${node.tag}@${name}=${value}`).toContain(value);
      }
      expect(node.attrs instanceof Map).toBe(true);
      for (const name of node.attrs.keys()) expect(name).toBe(name.toLowerCase());
      node.children.forEach(check);
    };
    check(c.expect.tree);
    expect(c.expect.tree.tag).toBe('theme');
  });

  describe.skipIf(!HAS_PYTHON)('against expat, as the corpus survey judged them', () => {
    it('each case is well-formed or fails with the recorded error', () => {
      const res = expatCheck(cases.map((c) => ({ id: c.id, text: c.text })));
      /** @type {string[]} */
      const failures = [];
      for (const c of cases) {
        const r = res[c.id];
        if (r.ok !== c.expat.wellFormed) failures.push(`${c.id}: expat ${r.ok ? 'accepts' : `rejects (${r.error})`}, fixture says ${c.expat.wellFormed ? 'well-formed' : 'broken'}`);
        else if (!r.ok && c.expat.error && !c.expat.error.test(r.error ?? '')) failures.push(`${c.id}: expat said "${r.error}", expected ${c.expat.error}`);
      }
      expect(failures).toEqual([]);
    });

    it('the failure classes are the ones survey 2.2 names, each rejected for its own reason', () => {
      const err = (/** @type {string} */ id) => expatCheck([{ id, text: wmsCase(id).text }])[id].error ?? '';
      expect(err('dup-attr-exact-conflicting')).toMatch(/duplicate attribute/);
      expect(err('missing-whitespace-after-value')).toMatch(/not well-formed \(invalid token\)/);
      expect(err('end-tag-case')).toMatch(/mismatched tag/);
      expect(err('junk-after-root')).toMatch(/junk after document element/);
      expect(expatCheck([{ id: 'x', text: wmsCase('dup-attr-case-variant').text }]).x.ok).toBe(true); // distinct to XML, a duplicate to WMP
    });
  });

  it('duplicate-bearing cases have more than one write to the winning attribute in their text', () => {
    const text = wmsCase('dup-attr-exact-conflicting').text;
    expect(text.match(/toolTip=/g)?.length).toBe(2);
    expect(text).toContain('toolTip="31hz"');
    expect(wmsCase('junk-after-root').text).toContain('</THEME>or = "#BA1925"');
    expect(wmsCase('junk-after-root').text.match(/<\/THEME>/g)?.length).toBe(2);
  });

  it('every case that needs diagnostics names the kinds, and clean cases name none', () => {
    for (const c of cases) {
      if (['tabs-around-equals', 'entities-in-values', 'leading-blank-line', 'jscript-and-binding-values'].includes(c.id)) expect(c.expect.kinds, c.id).toEqual([]);
    }
    expect(wmsCase('all-classes-combined').expect.kinds).toEqual(['duplicate-attribute', 'missing-whitespace', 'end-tag-case', 'junk-after-root']);
  });
});

describe('buildWms', () => {
  it('writes ordered attribute pairs (duplicates allowed), escapes values, nests with CRLF', () => {
    const text = buildWms({ tag: 'THEME', children: [{ tag: 'VIEW', attrs: [['a', '1'], ['a', '2'], ['t', 'x & <y> "z"']], children: [{ tag: 'BUTTON' }] }] });
    expect(text).toBe('<THEME>\r\n  <VIEW a="1" a="2" t="x &amp; &lt;y> &quot;z&quot;">\r\n    <BUTTON/>\r\n  </VIEW>\r\n</THEME>\r\n');
  });
});

describe('encodeText', () => {
  const sample = 'THEME © café — “quoted” €';
  it('writes the BOMs and byte orders the corpus uses (survey 2.1)', () => {
    const le = encodeText(sample, 'utf16le');
    expect(Array.from(le.subarray(0, 2))).toEqual([0xff, 0xfe]);
    expect(new TextDecoder('utf-16le').decode(le.subarray(2))).toBe(sample);
    const be = encodeText(sample, 'utf16be');
    expect(Array.from(be.subarray(0, 2))).toEqual([0xfe, 0xff]);
    expect(new TextDecoder('utf-16be').decode(be.subarray(2))).toBe(sample);
    const u8 = encodeText(sample, 'utf8-bom');
    expect(Array.from(u8.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8').decode(u8.subarray(3))).toBe(sample);
    expect(encodeText('abc', 'utf8')).toEqual(new TextEncoder().encode('abc'));
    expect(Array.from(encodeText('abc', 'ascii'))).toEqual([97, 98, 99]);
  });

  it('cp1252 maps 0x80-0x9F to their typographic characters and leaves 0xA0-0xFF alone', () => {
    const bytes = encodeText(sample, 'cp1252');
    expect(new TextDecoder('windows-1252').decode(bytes)).toBe(sample);
    expect(bytes[sample.indexOf('—')]).toBe(0x97);
    expect(bytes[sample.indexOf('€')]).toBe(0x80);
    expect(bytes[sample.indexOf('©')]).toBe(0xa9);
  });

  it('refuses characters the encoding cannot hold', () => {
    expect(() => encodeText('é', 'ascii')).toThrow();
    expect(() => encodeText('日', 'cp1252')).toThrow();
  });
});

describe('minimalSkin', () => {
  it('writes a THEME with one sized VIEW, one BUTTON and a script, and says where they are', () => {
    const s = minimalSkin();
    expect(s.wms).toContain('<THEME title="Synthetic fixture">');
    expect(s.wms).toContain('<VIEW id="main" width="64" height="48" backgroundImage="bg.bmp" titleBar="false" scriptFile="skin.js">');
    expect(s.wms).toContain('<BUTTON id="btn" left="8" top="8" width="16" height="16" image="btn.bmp"/>');
    expect([...s.files.keys()]).toEqual(['skin.wms', 'skin.js', 'bg.bmp', 'btn.bmp']);
    expect(s.expect).toMatchObject({ width: 64, height: 48, view: 'main', button: 'btn', script: 'skin.js', buttonRect: { x: 8, y: 8, w: 16, h: 16 } });
  });

  it('puts a handler on the button when asked, escaped for XML (the E6 `while(1){}` skin)', () => {
    const s = minimalSkin({ onclick: 'while(1){}' });
    expect(s.wms).toContain('onClick="while(1){}"');
    const tricky = minimalSkin({ onclick: 'a<b&&c>"d"' });
    expect(tricky.wms).toContain('onClick="a&lt;b&amp;&amp;c>&quot;d&quot;"');
  });

  it('can leave the script to the `<stem>.js` convention', () => {
    const s = minimalSkin({ name: 'Stem', implicitScript: true });
    expect(s.wms).not.toContain('scriptFile');
    expect([...s.files.keys()]).toContain('Stem.js');
    expect([...s.files.keys()]).toContain('Stem.wms');
  });

  it('encodes the definition and script as asked and carries extra files and elements', () => {
    const s = minimalSkin({ encoding: 'utf16le', extra: [{ tag: 'SUBVIEW', attrs: [['id', 'sv']] }], extraFiles: { 'extra.bin': Uint8Array.of(1, 2, 3) } });
    const wms = s.files.get('skin.wms');
    expect(Array.from(wms?.subarray(0, 2) ?? [])).toEqual([0xff, 0xfe]);
    expect(new TextDecoder('utf-16le').decode(wms?.subarray(2))).toBe(s.wms);
    expect(s.wms).toContain('<SUBVIEW id="sv"/>');
    expect(Array.from(s.files.get('extra.bin') ?? [])).toEqual([1, 2, 3]);
  });

  it('is deterministic and its BMPs are the writer\'s', () => {
    const a = minimalSkin({ width: 10, height: 6 });
    const b = minimalSkin({ width: 10, height: 6 });
    expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
    expect(Buffer.compare(a.files.get('bg.bmp') ?? new Uint8Array(), buildBmp({ width: 10, height: 6, bpp: 24 }).bytes)).toBe(0);
  });

  it.skipIf(!HAS_PYTHON)('the definition is well-formed XML', () => {
    expect(expatCheck([{ id: 'm', text: minimalSkin({ onclick: 'x()' }).wms }]).m).toEqual({ id: 'm', ok: true });
  });

  it.skipIf(!HAS_UNZIP)('the archive lists with unzip and its entries read back', () => {
    const s = minimalSkin({ name: 'probe', onclick: 'while(1){}' });
    const p = join(dir, 'probe.wmz');
    writeFileSync(p, s.bytes);
    const r = unzip(['-t', p]);
    expect(r.status, r.output).toBe(0);
    for (const name of ['probe.wms', 'probe.js', 'bg.bmp', 'btn.bmp']) expect(r.output).toContain(name);
    expect(new TextDecoder().decode(unzipEntry(p, 'probe.wms') ?? new Uint8Array())).toBe(s.wms);
  });

  it.skipIf(!HAS_SIPS)('the images open at the sizes the VIEW and BUTTON declare', () => {
    const s = minimalSkin({ width: 90, height: 40 });
    writeFileSync(join(dir, 'bg.bmp'), s.files.get('bg.bmp') ?? new Uint8Array());
    writeFileSync(join(dir, 'btn.bmp'), s.files.get('btn.bmp') ?? new Uint8Array());
    expect(sipsSize(join(dir, 'bg.bmp'))).toEqual({ width: 90, height: 40 });
    expect(sipsSize(join(dir, 'btn.bmp'))).toEqual({ width: 16, height: 16 });
  });
});
