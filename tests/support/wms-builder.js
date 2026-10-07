// @ts-check
// Synthetic `.wms` text (ENGINE D9, D5): one string per `survey 2.2` failure class plus the
// tolerant-scanner cases W1.2 lists, a serialiser, a text encoder for the BOM/cp1252 cases, and a
// minimal valid skin that composes the BMP and zip writers into a loadable archive.
//
// Every failure case carries
//   `expat`:  whether a strict XML parser (expat) accepts the text, and the error it gives if not,
//             which the tests check so each fixture is known to be the class it claims to be;
//   `expect`: the tree a D5 scanner must produce (tags and attribute names lowercased, entities
//             decoded, duplicates resolved last-wins, attribute lists as Maps), with 1-based lines,
//             and `kinds`, the diagnostic kinds it must report. The kind names are this fixture's
//             vocabulary; the scanner's own diagnostic codes are W1.2's to choose.
//
// Browser-safe: no `node:` imports.

import { buildBmp } from './bmp-writer.js';
import { buildZip } from './zip-writer.js';

/**
 * @typedef {{ tag: string, attrs?: Array<[string, string]>, children?: WmsNode[] }} WmsNode
 * @typedef {{ tag: string, line: number, attrs: Map<string, string>, children: ExpectNode[] }} ExpectNode
 * @typedef {{ tree: ExpectNode, kinds: string[] }} WmsExpect
 */

/** @param {string} v */
const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Serialise a tree. Attributes are ordered pairs so a caller can write duplicates.
 * @param {WmsNode} node @param {{ eol?: string, indent?: string }} [opts] @returns {string}
 */
export function buildWms(node, opts = {}) {
  const eol = opts.eol ?? '\r\n';
  const unit = opts.indent ?? '  ';
  /** @param {WmsNode} n @param {string} pad @returns {string[]} */
  const lines = (n, pad) => {
    const attrs = (n.attrs ?? []).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    if (!n.children?.length) return [`${pad}<${n.tag}${attrs}/>`];
    return [`${pad}<${n.tag}${attrs}>`, ...n.children.flatMap((c) => lines(c, pad + unit)), `${pad}</${n.tag}>`];
  };
  return lines(node, '').join(eol) + eol;
}

// ---- text encodings ---------------------------------------------------------------------------

const CP1252 = new Map([
  ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85], ['†', 0x86], ['‡', 0x87],
  ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8a], ['‹', 0x8b], ['Œ', 0x8c], ['Ž', 0x8e], ['‘', 0x91],
  ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97], ['˜', 0x98],
  ['™', 0x99], ['š', 0x9a], ['›', 0x9b], ['œ', 0x9c], ['ž', 0x9e], ['Ÿ', 0x9f],
]);

/**
 * Encode text the ways the corpus stores it (survey 2.1).
 * @param {string} text
 * @param {'ascii'|'utf8'|'utf8-bom'|'utf16le'|'utf16be'|'cp1252'} enc
 * @returns {Uint8Array}
 */
export function encodeText(text, enc) {
  if (enc === 'utf8' || enc === 'utf8-bom') {
    const body = new TextEncoder().encode(text);
    return enc === 'utf8' ? body : Uint8Array.from([0xef, 0xbb, 0xbf, ...body]);
  }
  if (enc === 'utf16le' || enc === 'utf16be') {
    const le = enc === 'utf16le';
    const out = new Uint8Array(2 + text.length * 2);
    out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = le ? c & 255 : c >> 8;
      out[3 + i * 2] = le ? c >> 8 : c & 255;
    }
    return out;
  }
  return Uint8Array.from(text, (ch) => {
    const c = ch.charCodeAt(0);
    if (enc === 'ascii') {
      if (c > 0x7f) throw new Error(`U+${c.toString(16)} is not ASCII`);
      return c;
    }
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
    const v = CP1252.get(ch);
    if (v === undefined) throw new Error(`U+${c.toString(16)} is not in cp1252`);
    return v;
  });
}

// ---- failure cases ----------------------------------------------------------------------------

/** @param {string} tag @param {number} line @param {Array<[string,string]>} attrs @param {ExpectNode[]} [children] @returns {ExpectNode} */
const n = (tag, line, attrs, children = []) => ({ tag, line, attrs: new Map(attrs), children });

/** @param {string[]} ls @returns {string} CRLF-joined, as in 340 of 342 corpus files */
const crlf = (ls) => ls.join('\r\n') + '\r\n';

/**
 * @typedef {Object} WmsCase
 * @property {string} id
 * @property {string} doc
 * @property {string} survey   where the class comes from
 * @property {string} text
 * @property {{ wellFormed: boolean, error?: RegExp }} expat
 * @property {WmsExpect} expect
 */

/** @type {Array<Omit<WmsCase, 'text'> & { lines: string[], eol?: string }>} */
const CASES = [
  {
    id: 'dup-attr-exact-conflicting', survey: '2.2 / G2', doc: 'the same attribute twice with different values: the last wins (Ice.wms:144)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b1" toolTip="Equaliser Adjustment" left="1" toolTip="31hz"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /duplicate attribute/ },
    expect: { kinds: ['duplicate-attribute'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1'], ['tooltip', '31hz'], ['left', '1']])])]) },
  },
  {
    id: 'dup-attr-exact-max', survey: '2.2 / G2', doc: '`max="100"` then `max="wmpprop:…duration"` (Secura): the binding, being last, wins',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<SLIDER id="s" max="100" min="0" max="wmpprop:player.currentmedia.duration"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /duplicate attribute/ },
    expect: { kinds: ['duplicate-attribute'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('slider', 3, [['id', 's'], ['max', 'wmpprop:player.currentmedia.duration'], ['min', '0']])])]) },
  },
  {
    id: 'dup-attr-same-value', survey: '2.2', doc: 'an exact duplicate that repeats the same value (155 of the 454 occurrences)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b1" visible="true" left="2" visible="true"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /duplicate attribute/ },
    expect: { kinds: ['duplicate-attribute'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1'], ['visible', 'true'], ['left', '2']])])]) },
  },
  {
    id: 'dup-attr-case-variant', survey: '2.2 / G6', doc: '`toolTip` and `tooltip` on one element: distinct to XML, one attribute to WMP; the last wins (robbie.wms:459)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b1" toolTip="first" upToolTip="u1" tooltip="second" upTooltip="u2"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: ['duplicate-attribute'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1'], ['tooltip', 'second'], ['uptooltip', 'u2']])])]) },
  },
  {
    id: 'missing-whitespace-after-value', survey: '2.2 / G3', doc: 'no space between attributes: `cursor="hand"onClick="…"` (military.wms:122)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b1" cursor="hand"onClick="player.controls.previous();"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /not well-formed \(invalid token\)/ },
    expect: { kinds: ['missing-whitespace'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1'], ['cursor', 'hand'], ['onclick', 'player.controls.previous();']])])]) },
  },
  {
    id: 'missing-whitespace-several', survey: '2.2 / G3', doc: 'three attributes run together, including the `scriptFile="…;"titleBar=` shape (Primitive.wms:3)',
    lines: ['<THEME>', '<VIEW width="40"height="30"scriptFile="skin.js;res://wmploc.dll/RT_TEXT/#132;"titleBar="false" zIndex="8"backgroundImage="bg.bmp">', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /not well-formed \(invalid token\)/ },
    expect: { kinds: ['missing-whitespace'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30'], ['scriptfile', 'skin.js;res://wmploc.dll/RT_TEXT/#132;'], ['titlebar', 'false'], ['zindex', '8'], ['backgroundimage', 'bg.bmp']])]) },
  },
  {
    id: 'end-tag-case', survey: '2.2 / G4', doc: '`<Buttongroup>` closed by `</buttongroup>` (Primitive.wms:44)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<Buttongroup id="g" mappingimage="m.bmp">', '<BUTTONELEMENT id="e1" mappingcolor="#ff0000"/>', '</buttongroup>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /mismatched tag/ },
    expect: { kinds: ['end-tag-case'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('buttongroup', 3, [['id', 'g'], ['mappingimage', 'm.bmp']], [n('buttonelement', 4, [['id', 'e1'], ['mappingcolor', '#ff0000']])])])]) },
  },
  {
    id: 'end-tag-case-root', survey: '2.2 / G4', doc: 'the root opened `<theme` and closed `</THEME>` (science.wms:6)',
    lines: ['<theme title="t">', '<VIEW width="40" height="30">', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /mismatched tag/ },
    expect: { kinds: ['end-tag-case'], tree: n('theme', 1, [['title', 't']], [n('view', 2, [['width', '40'], ['height', '30']])]) },
  },
  {
    id: 'junk-after-root', survey: '2.2 / G5', doc: '`</THEME>or = "#BA1925"` then a second `</THEME>` (MotherLand): stop at the first root close',
    lines: ['<THEME title="t">', '<VIEW width="40" height="30">', '<BUTTON id="b1"/>', '</VIEW>', '</THEME>or = "#BA1925"', '<VIEW width="9" height="9"/>', '</THEME>'],
    expat: { wellFormed: false, error: /junk after document element/ },
    expect: { kinds: ['junk-after-root'], tree: n('theme', 1, [['title', 't']], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1']])])]) },
  },
  {
    id: 'tabs-around-equals', survey: '2.4 rule 3', doc: 'tabs and spaces around `=` (Portals.wms:11-17, Ice `top ="59"`): legal XML, easy to get wrong in a hand scanner',
    lines: ['<THEME>', '<VIEW\twidth\t=\t"40"\theight  =  "30"\ttop ="59">', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30'], ['top', '59']])]) },
  },
  {
    id: 'leading-blank-line', survey: '2.1', doc: 'blank lines and a copyright comment before the root (Sports/saltmine.wms:1)',
    lines: ['', '', '<!-- Copyright (c) 2002 Somebody & Co. -->', '<THEME title="t">', '<VIEW width="40" height="30"/>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 4, [['title', 't']], [n('view', 5, [['width', '40'], ['height', '30']])]) },
  },
  {
    id: 'entities-in-values', survey: '2.3 / G16', doc: 'the five predefined entities and numeric references (`&#13;`, `&#x41;`) in handler text (PowerToys.wms:8)',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b1" onclick="t1.value=&quot;LIBRARY&#13;ACCESS&quot;;a=1&amp;&amp;b&lt;2&gt;0;c=&apos;x&apos;;d=&#x41;"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b1'], ['onclick', 't1.value="LIBRARY\rACCESS";a=1&&b<2>0;c=\'x\';d=A']])])]) },
  },
  {
    id: 'comment-with-bare-ampersand', survey: '2.3', doc: 'a bare `&` inside a comment is legal (45 corpus hits, all in comments)',
    lines: ['<THEME>', '<!-- Head & Radio subview -->', '<VIEW width="40" height="30"/>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 3, [['width', '40'], ['height', '30']])]) },
  },
  {
    id: 'xml-declaration', survey: '2.1', doc: 'an `<?xml?>` declaration (0 of 342 have one) must be skipped, not tripped over',
    lines: ['<?xml version="1.0"?>', '<THEME><VIEW width="40" height="30"/></THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 2, [], [n('view', 2, [['width', '40'], ['height', '30']])]) },
  },
  {
    id: 'orphan-close-tag', survey: 'D5 rule 5', doc: 'a close tag with no open match is ignored',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '</BUTTON>', '<BUTTON id="b1"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: false, error: /mismatched tag/ },
    expect: { kinds: ['orphan-close-tag'], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 4, [['id', 'b1']])])]) },
  },
  {
    id: 'unknown-tags-and-attributes', survey: '2.4 rule 7 / G12', doc: 'unknown tags stay as inert nodes; misspelled attributes are kept (`resizAble`, `widht`)',
    lines: ['<THEME>', '<VIEW width="40" height="30" resizAble="true" widht="9">', '<network id="n1"/>', '<PLAYER><currentMedia id="cm" x="1"/></PLAYER>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30'], ['resizable', 'true'], ['widht', '9']], [n('network', 3, [['id', 'n1']]), n('player', 4, [], [n('currentmedia', 4, [['id', 'cm'], ['x', '1']])])])]) },
  },
  {
    id: 'mixed-case-names', survey: 'G6', doc: 'tags and attribute names in any case fold to lower case; values keep theirs',
    lines: ['<ThEmE TiTlE="MiXeD">', '<ViEw WIDTH="40" Height="30">', '<ButTon ID="Btn" BackgroundImage="Bg.BMP"/>', '</VIEW>', '</tHeMe>'],
    expat: { wellFormed: false, error: /mismatched tag/ },
    expect: { kinds: ['end-tag-case'], tree: n('theme', 1, [['title', 'MiXeD']], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'Btn'], ['backgroundimage', 'Bg.BMP']])])]) },
  },
  {
    id: 'single-quoted-and-unquoted', survey: 'D5 rule 2', doc: 'single-quoted values, and an unquoted value running to whitespace or `>` (neither occurs in the corpus)',
    lines: ["<THEME>", "<VIEW width='40' height=30 title=plain>", "</VIEW>", "</THEME>"],
    expat: { wellFormed: false, error: /not well-formed \(invalid token\)/ },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30'], ['title', 'plain']])]) },
  },
  {
    id: 'whitespace-padded-values', survey: 'G22', doc: '`width="600 "`: the scanner keeps the raw value, coercion trims later',
    lines: ['<THEME>', '<VIEW width="600 " height=" 30">', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '600 '], ['height', ' 30']])]) },
  },
  {
    id: 'jscript-and-binding-values', survey: 'G13 / G14', doc: 'attribute values with colons, semicolons and operators pass through untouched',
    lines: ['<THEME>', '<VIEW width="40" height="30">', '<BUTTON id="b" left="jscript:balance.left+balance.width+10;" top=" JScript: view.height-76" visible="wmpenabled:player.controls.pause" value="wmpprop:player.controls.currentPositionString"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 3, [['id', 'b'], ['left', 'jscript:balance.left+balance.width+10;'], ['top', ' JScript: view.height-76'], ['visible', 'wmpenabled:player.controls.pause'], ['value', 'wmpprop:player.controls.currentPositionString']])])]) },
  },
  {
    id: 'self-closing-and-explicit', survey: 'D5', doc: '`<BUTTON/>` and `<BUTTON></BUTTON>` give the same node; text content between elements is ignored',
    lines: ['<THEME>', '<VIEW width="40" height="30">', 'stray text', '<BUTTON id="a"/>', '<BUTTON id="b"></BUTTON>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 2, [['width', '40'], ['height', '30']], [n('button', 4, [['id', 'a']]), n('button', 5, [['id', 'b']])])]) },
  },
  {
    id: 'lf-line-endings', survey: '2.1', doc: 'LF-only text (2 of 342 files); line numbers still count',
    eol: '\n', lines: ['<THEME>', '', '<VIEW width="40" height="30">', '<BUTTON id="b1"/>', '</VIEW>', '</THEME>'],
    expat: { wellFormed: true },
    expect: { kinds: [], tree: n('theme', 1, [], [n('view', 3, [['width', '40'], ['height', '30']], [n('button', 4, [['id', 'b1']])])]) },
  },
  {
    id: 'all-classes-combined', survey: '2.2', doc: 'one file with every class at once, as real skins have',
    lines: [
      '<!-- all classes -->', '<theme title="t" title="u">', '<VIEW width="40"height="30" toolTip="a" tooltip="b">',
      '<Buttongroup id="g">', '<BUTTON id="b1" cursor="hand"onClick="x();" max="1" max="2"/>', '</buttongroup>', '</VIEW>', '</THEME>or = "#FF00FF"',
    ],
    expat: { wellFormed: false, error: /duplicate attribute/ },
    expect: {
      kinds: ['duplicate-attribute', 'missing-whitespace', 'end-tag-case', 'junk-after-root'],
      tree: n('theme', 2, [['title', 'u']], [n('view', 3, [['width', '40'], ['height', '30'], ['tooltip', 'b']], [n('buttongroup', 4, [['id', 'g']], [n('button', 5, [['id', 'b1'], ['cursor', 'hand'], ['onclick', 'x();'], ['max', '2']])])])]),
    },
  },
];

/**
 * @param {string} id
 * @returns {WmsCase}
 */
export function wmsCase(id) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`unknown wms case ${id}`);
  const { lines, eol, ...rest } = c;
  return { ...rest, text: lines.join(eol ?? '\r\n') + (eol ?? '\r\n') };
}
export const wmsCaseIds = () => CASES.map((c) => c.id);
/** @param {(id: string) => boolean} [filter] @returns {WmsCase[]} */
export const wmsCases = (filter) => CASES.filter((c) => !filter || filter(c.id)).map((c) => wmsCase(c.id));

// ---- a minimal valid skin ---------------------------------------------------------------------

/**
 * @typedef {Object} SkinOptions
 * @property {string} [name]          archive stem; the definition is `<name>.wms`
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [onclick]       handler text of the one BUTTON, e.g. `while(1){}`
 * @property {string} [script]        contents of `<name>.js`
 * @property {boolean} [implicitScript]  omit `scriptFile` so the `<name>.js` convention loads it
 * @property {WmsNode[]} [extra]      more elements appended to the VIEW
 * @property {Record<string, Uint8Array>} [extraFiles]
 * @property {'ascii'|'utf8'|'utf8-bom'|'utf16le'|'utf16be'|'cp1252'} [encoding]  of the `.wms` and `.js` (default ascii)
 */

/**
 * A skin the engine must load: one THEME, one sized VIEW with a background BMP, one BUTTON with an
 * image BMP and an optional handler, one script file. The ids and geometry are in `expect`.
 * @param {SkinOptions} [opts]
 * @returns {{ name: string, wms: string, js: string, files: Map<string, Uint8Array>, bytes: Uint8Array,
 *   expect: { width: number, height: number, view: string, button: string, buttonRect: {x:number,y:number,w:number,h:number}, script: string } }}
 */
export function minimalSkin(opts = {}) {
  const name = opts.name ?? 'skin';
  const width = opts.width ?? 64;
  const height = opts.height ?? 48;
  const script = opts.script ?? 'function noop() {}\r\n';
  const enc = opts.encoding ?? 'ascii';
  const button = { id: 'btn', left: 8, top: 8, width: 16, height: 16 };
  /** @type {Array<[string, string]>} */
  const btnAttrs = [['id', button.id], ['left', String(button.left)], ['top', String(button.top)], ['width', String(button.width)], ['height', String(button.height)], ['image', 'btn.bmp']];
  if (opts.onclick) btnAttrs.push(['onClick', opts.onclick]);
  /** @type {Array<[string, string]>} */
  const viewAttrs = [['id', 'main'], ['width', String(width)], ['height', String(height)], ['backgroundImage', 'bg.bmp'], ['titleBar', 'false']];
  if (!opts.implicitScript) viewAttrs.push(['scriptFile', `${name}.js`]);
  const wms = buildWms({
    tag: 'THEME', attrs: [['title', 'Synthetic fixture']],
    children: [{ tag: 'VIEW', attrs: viewAttrs, children: [{ tag: 'BUTTON', attrs: btnAttrs }, ...(opts.extra ?? [])] }],
  });
  const bg = buildBmp({ width, height, bpp: 24 }).bytes;
  const btn = buildBmp({ width: button.width, height: button.height, bpp: 8 }).bytes;
  /** @type {Map<string, Uint8Array>} */
  const files = new Map([
    [`${name}.wms`, encodeText(wms, enc)],
    [`${name}.js`, encodeText(script, enc)],
    ['bg.bmp', bg],
    ['btn.bmp', btn],
  ]);
  for (const [k, v] of Object.entries(opts.extraFiles ?? {})) files.set(k, v);
  const bytes = buildZip([...files].map(([fname, data]) => ({ name: fname, data, method: /** @type {'deflate'} */ ('deflate') })));
  return {
    name, wms, js: script, files, bytes,
    expect: { width, height, view: 'main', button: button.id, buttonRect: { x: button.left, y: button.top, w: button.width, h: button.height }, script: `${name}.js` },
  };
}
