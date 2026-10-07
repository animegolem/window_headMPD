// @ts-check
import { describe, expect, it } from 'vitest';
import { decodeText } from '../../../src/engine/text/decode.js';
import { encodeText } from '../../support/wms-builder.js';

/** No lone surrogate halves (String.prototype.isWellFormed needs a newer lib than the project checks against). @param {string} s */
const wellFormed = (s) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

const bytesOf = (/** @type {number[]} */ ...b) => Uint8Array.from(b);

/** Seeded PRNG (mulberry32) so a failure replays. @param {number} seed */
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('BOM sniffing (survey 2.1)', () => {
  const sample = 'THEME © café — “quoted” €';

  it('UTF-16LE: FF FE, BOM stripped', () => {
    const r = decodeText(encodeText(sample, 'utf16le'));
    expect(r).toEqual({ text: sample, encoding: 'utf-16le' });
  });

  it('UTF-16BE: FE FF, BOM stripped', () => {
    const r = decodeText(encodeText(sample, 'utf16be'));
    expect(r).toEqual({ text: sample, encoding: 'utf-16be' });
  });

  it('UTF-8: EF BB BF, BOM stripped', () => {
    const r = decodeText(encodeText(sample, 'utf8-bom'));
    expect(r).toEqual({ text: sample, encoding: 'utf-8' });
  });

  it('a BOM wins over the bytes that follow it', () => {
    // After FF FE the rest is ASCII-looking, but it is UTF-16 because the BOM says so.
    expect(decodeText(bytesOf(0xff, 0xfe, 0x41, 0x00, 0x42, 0x00))).toEqual({ text: 'AB', encoding: 'utf-16le' });
    expect(decodeText(bytesOf(0xfe, 0xff, 0x00, 0x41, 0x00, 0x42))).toEqual({ text: 'AB', encoding: 'utf-16be' });
    expect(decodeText(bytesOf(0xef, 0xbb, 0xbf, 0x41))).toEqual({ text: 'A', encoding: 'utf-8' });
  });

  it('a BOM and nothing else is an empty text', () => {
    expect(decodeText(bytesOf(0xff, 0xfe))).toEqual({ text: '', encoding: 'utf-16le' });
    expect(decodeText(bytesOf(0xfe, 0xff))).toEqual({ text: '', encoding: 'utf-16be' });
    expect(decodeText(bytesOf(0xef, 0xbb, 0xbf))).toEqual({ text: '', encoding: 'utf-8' });
  });

  it('only a full UTF-8 BOM counts: EF BB alone is cp1252', () => {
    expect(decodeText(bytesOf(0xef, 0xbb, 0x41))).toEqual({ text: 'ï»A', encoding: 'cp1252' });
  });

  it('keeps supplementary characters in UTF-16 (surrogate pairs) and UTF-8', () => {
    const emoji = 'a\u{1f600}b';
    expect(decodeText(encodeText(emoji, 'utf16le')).text).toBe(emoji);
    expect(decodeText(encodeText(emoji, 'utf16be')).text).toBe(emoji);
    expect(decodeText(encodeText(emoji, 'utf8-bom')).text).toBe(emoji);
  });

  it('UTF-16 with an unpaired surrogate or an odd length gives U+FFFD, never a lone surrogate or an error', () => {
    // high surrogate then 'A'; lone low surrogate; high surrogate at the very end
    const le = (/** @type {number[]} */ units) => Uint8Array.from([0xff, 0xfe, ...units.flatMap((u) => [u & 255, u >> 8])]);
    expect(decodeText(le([0xd800, 0x41])).text).toBe('�A');
    expect(decodeText(le([0xdc00, 0x41])).text).toBe('�A');
    expect(decodeText(le([0x41, 0xd83d])).text).toBe('A�');
    // one byte after the BOM, and three: a truncated trailing code unit
    expect(decodeText(bytesOf(0xff, 0xfe, 0x41)).text).toBe('�');
    expect(decodeText(bytesOf(0xff, 0xfe, 0x41, 0x00, 0x42)).text).toBe('A�');
    expect(decodeText(bytesOf(0xfe, 0xff, 0x00, 0x41, 0x00)).text).toBe('A�');
    for (const t of [le([0xd800]), le([0xdbff, 0xdbff, 0xdc00]), le([0xdfff, 0xd800])]) expect(wellFormed(decodeText(t).text)).toBe(true);
  });

  it('malformed UTF-8 after the BOM decodes to U+FFFD and does not throw', () => {
    const r = decodeText(bytesOf(0xef, 0xbb, 0xbf, 0x41, 0xc3, 0x28, 0xff, 0x42));
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('A�(�B');
  });
});

describe('ASCII and cp1252', () => {
  it('pure 7-bit bytes are ascii (the empty input too)', () => {
    expect(decodeText(encodeText('<THEME/>\r\n', 'ascii'))).toEqual({ text: '<THEME/>\r\n', encoding: 'ascii' });
    expect(decodeText(new Uint8Array(0))).toEqual({ text: '', encoding: 'ascii' });
    // NUL and the control range are still 7-bit
    expect(decodeText(bytesOf(0, 1, 0x1a, 0x7f)).encoding).toBe('ascii');
  });

  it('any byte >= 0x80 without a BOM makes it cp1252', () => {
    expect(decodeText(bytesOf(0x41, 0x80)).encoding).toBe('cp1252');
    expect(decodeText(bytesOf(0xff)).encoding).toBe('cp1252');
    expect(decodeText(bytesOf(0xff)).text).toBe('ÿ');
    expect(decodeText(bytesOf(0xfe)).encoding).toBe('cp1252'); // not the start of a BOM
  });

  it('maps 0x80-0x9F to the Windows typographic characters and leaves 0xA0-0xFF as Latin-1', () => {
    const wanted = new Map([
      [0x80, '€'], [0x82, '‚'], [0x83, 'ƒ'], [0x84, '„'], [0x85, '…'], [0x86, '†'],
      [0x87, '‡'], [0x88, 'ˆ'], [0x89, '‰'], [0x8a, 'Š'], [0x8b, '‹'], [0x8c, 'Œ'],
      [0x8e, 'Ž'], [0x91, '‘'], [0x92, '’'], [0x93, '“'], [0x94, '”'], [0x95, '•'],
      [0x96, '–'], [0x97, '—'], [0x98, '˜'], [0x99, '™'], [0x9a, 'š'], [0x9b, '›'],
      [0x9c, 'œ'], [0x9e, 'ž'], [0x9f, 'Ÿ'],
    ]);
    for (const [byte, ch] of wanted) expect(decodeText(bytesOf(0x41, byte)).text, `0x${byte.toString(16)}`).toBe(`A${ch}`);
    expect(decodeText(bytesOf(0xa0, 0xa9, 0xe9, 0xff)).text).toBe(' ©éÿ');
  });

  it('the five bytes Microsoft left undefined map to the C1 control of the same value', () => {
    for (const b of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) expect(decodeText(bytesOf(0x41, b)).text).toBe(`A${String.fromCharCode(b)}`);
  });

  it('agrees with the platform windows-1252 decoder on every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const r = decodeText(all);
    expect(r.encoding).toBe('cp1252');
    expect(r.text).toBe(new TextDecoder('windows-1252').decode(all));
    expect(r.text.length).toBe(256);
  });

  it('round-trips the cp1252 text the fixture writer produces', () => {
    const text = '/*\r\n ©2000 Microsoft — “hello” • € ™\r\n*/';
    expect(decodeText(encodeText(text, 'cp1252'))).toEqual({ text, encoding: 'cp1252' });
  });

  it('BOM-less UTF-8 with multi-byte characters is cp1252, as the corpus rule says (survey 2.1)', () => {
    const utf8 = new TextEncoder().encode('café');
    expect(decodeText(utf8)).toEqual({ text: 'cafÃ©', encoding: 'cp1252' });
  });

  it('BOM-less UTF-16 is not sniffed from the zero bytes', () => {
    const r = decodeText(bytesOf(0x3c, 0x00, 0x41, 0x00));
    expect(r).toEqual({ text: '<\u0000A\u0000', encoding: 'ascii' });
  });
});

describe('long inputs and robustness', () => {
  it('decodes across the internal chunk boundary unchanged', () => {
    const n = 8192 * 3 + 17;
    const text = Array.from({ length: n }, (_, i) => String.fromCharCode(0x41 + (i % 26))).join('');
    for (const enc of /** @type {const} */ (['ascii', 'utf16le', 'utf16be', 'utf8-bom'])) {
      expect(decodeText(encodeText(text, enc)).text === text, enc).toBe(true);
    }
    // a surrogate pair straddling the chunk edge survives
    const edge = `${'x'.repeat(8191)}\u{1f600}${'y'.repeat(10)}`;
    expect(decodeText(encodeText(edge, 'utf16le')).text === edge).toBe(true);
    expect(decodeText(encodeText(edge, 'utf16be')).text === edge).toBe(true);
  });

  it('decodes a few MiB without blowing the call stack', () => {
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x41);
    big[big.length - 1] = 0x80;
    const r = decodeText(big);
    expect(r.encoding).toBe('cp1252');
    expect(r.text.length).toBe(big.length);
    expect(r.text.endsWith('A€')).toBe(true);
  });

  it('never throws and always returns well-formed text, whatever the bytes', () => {
    const rand = rng(1234);
    const prefixes = [[], [0xff, 0xfe], [0xfe, 0xff], [0xef, 0xbb, 0xbf], [0xef], [0xff]];
    for (let k = 0; k < 400; k++) {
      const prefix = prefixes[k % prefixes.length];
      const body = Uint8Array.from({ length: Math.floor(rand() * 64) }, () => (rand() < 0.3 ? 0xd8 + Math.floor(rand() * 8) : Math.floor(rand() * 256)));
      const r = decodeText(Uint8Array.from([...prefix, ...body]));
      expect(typeof r.text).toBe('string');
      expect(wellFormed(r.text)).toBe(true);
      expect(['utf-16le', 'utf-16be', 'utf-8', 'ascii', 'cp1252']).toContain(r.encoding);
    }
  });
});
