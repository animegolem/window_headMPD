// @ts-check
// Caps and hostile headers across all four formats (ENGINE D3, section 10): a 30,000 x 30,000 header is
// refused in under 5 ms without allocating, 16,384 is the widest axis, the area cap is 16,777,216.

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_CAPS, decodeImage, decodeImageWithDiagnostics } from '../../../src/engine/image/decode/index.js';
import { detectFormat, probeImage } from '../../../src/engine/image/probe.js';
import { bmpCase } from '../../support/bmp-writer.js';
import { buildGif, gifCase } from '../../support/gif-writer.js';
import { pngCase } from '../../support/png-writer.js';
import { JPEGS } from './jpeg-fixtures.js';

const codes = (/** @type {{code:string}[]} */ d) => d.map((x) => x.code);

function lyingJpeg() {
  const lie = JPEGS.baseline444.slice();
  const sof = lie.findIndex((v, i) => v === 0xff && lie[i + 1] === 0xc0);
  lie[sof + 5] = 30000 >> 8; lie[sof + 6] = 30000 & 255;
  lie[sof + 7] = 30000 >> 8; lie[sof + 8] = 30000 & 255;
  return lie;
}

/** @type {Array<[string, () => Uint8Array]>} */
const HOSTILE = [
  ['BMP 24 bpp', () => bmpCase('declared-30000x30000-24bpp-header-only').bytes],
  ['BMP 8 bpp', () => bmpCase('declared-30000x30000-8bpp-header-only').bytes],
  ['PNG', () => pngCase('declared-30000x30000-gray-8bit').bytes],
  ['PNG Adam7', () => pngCase('declared-30000x30000-adam7').bytes],
  ['PNG width 2^31 - 1', () => pngCase('declared-2147483647x1').bytes],
  ['GIF', () => gifCase('declared-30000x30000').bytes],
  ['JPEG', lyingJpeg],
];

describe('a 30,000 x 30,000 header', () => {
  it.each(HOSTILE)('%s: null from the header in under 5 ms with under 1 MiB of buffers', (_name, make) => {
    const bytes = make();
    expect(probeImage(bytes)).toBeNull();
    decodeImage(bytes); // warm up
    // Best of three: the claim is that the refusal is cheap, not that the scheduler never stalls it.
    const before = process.memoryUsage().arrayBuffers;
    let ms = Infinity;
    let img = /** @type {unknown} */ (undefined);
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      img = decodeImage(bytes);
      ms = Math.min(ms, performance.now() - t0);
    }
    const growth = process.memoryUsage().arrayBuffers - before;
    expect(img).toBeNull();
    expect(ms).toBeLessThan(5);
    expect(growth).toBeLessThan(1024 * 1024);
    expect(codes(decodeImageWithDiagnostics(bytes).diagnostics)).toEqual(['image-over-cap']);
  });

  it('an illegal zero-width PNG is a failed decode', () => {
    expect(decodeImage(pngCase('declared-zero-width').bytes)).toBeNull();
    expect(probeImage(pngCase('declared-zero-width').bytes)).toBeNull();
  });
});

describe('the axis cap: 16,384 decodes, 16,385 does not', () => {
  const wide = /** @type {Array<[string, string, string, string]>} */ ([
    ['BMP', 'axis-16384x20-24bpp', 'axis-16385x20-24bpp', 'axis-20x16385-24bpp'],
    ['PNG', 'axis-16384x20-gray-8bit', 'axis-16385x20-gray-8bit', 'axis-20x16385-gray-8bit'],
    ['GIF', 'axis-16384x20', 'axis-16385x20', 'axis-20x16385'],
  ]);
  it.each(wide)('%s', (name, okId, wideId, tallId) => {
    const get = (/** @type {string} */ id) => (name === 'BMP' ? bmpCase(id) : name === 'PNG' ? pngCase(id) : gifCase(id));
    const ok = get(okId);
    expect(probeImage(ok.bytes)).toEqual({ format: name.toLowerCase(), width: 16384, height: 20 });
    expect(/** @type {any} */ (decodeImage(ok.bytes)).width).toBe(16384);
    for (const id of [wideId, tallId]) {
      const c = get(id);
      expect(probeImage(c.bytes), id).toBeNull();
      const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
      expect(image, id).toBeNull();
      expect(codes(diagnostics), id).toEqual(['image-over-cap']);
    }
  });
});

describe('the area cap and custom caps', () => {
  it('the defaults are the §10 numbers', () => {
    expect({ ...DEFAULT_IMAGE_CAPS }).toEqual({ maxAxis: 16384, maxArea: 16777216, maxGifFrames: 512 });
  });

  it('16,384 x 1,025 is over the area cap and 16,384 x 1,024 is exactly at it', () => {
    // headers only: the over-cap one never allocates, the at-cap one is merely probed
    const make = (/** @type {number} */ w, /** @type {number} */ h) => {
      const b = bmpCase('24bpp-w5').bytes.slice();
      const dv = new DataView(b.buffer);
      dv.setInt32(18, w, true);
      dv.setInt32(22, h, true);
      return b;
    };
    expect(probeImage(make(16384, 1025))).toBeNull();
    expect(probeImage(make(16384, 1024))).toEqual({ format: 'bmp', width: 16384, height: 1024 });
  });

  it('caps passed to decodeImage override the defaults', () => {
    const c = pngCase('rgb-8bit'); // 5 x 4
    expect(decodeImage(c.bytes, { maxAxis: 5 })).not.toBeNull();
    expect(decodeImage(c.bytes, { maxAxis: 4 })).toBeNull();
    expect(decodeImage(c.bytes, { maxArea: 20 })).not.toBeNull();
    expect(decodeImage(c.bytes, { maxArea: 19 })).toBeNull();
    expect(decodeImage(c.bytes, {})).not.toBeNull();
  });
});

describe('detection is by magic bytes only', () => {
  it('names each format from its signature and nothing else', () => {
    expect(detectFormat(bmpCase('24bpp-w5').bytes)).toBe('bmp');
    expect(detectFormat(pngCase('rgb-8bit').bytes)).toBe('png');
    expect(detectFormat(gifCase('single-4x4').bytes)).toBe('gif');
    expect(detectFormat(JPEGS.baseline444)).toBe('jpeg');
    expect(detectFormat(new Uint8Array(0))).toBeNull();
    expect(detectFormat(Uint8Array.of(0x42))).toBeNull();
    expect(detectFormat(new TextEncoder().encode('8BPS\x00\x01'))).toBeNull(); // a PSD
  });

  it('a GIF is decoded as a GIF whatever it was called, and non-images are unknown, never a throw', () => {
    // there is no file name in the API at all; this pins that a GIF payload is not misread as a BMP
    const gif = buildGif({ width: 2, height: 2, palette: [[1, 2, 3], [4, 5, 6]], frames: [{ indices: [0, 1, 1, 0] }] });
    expect(probeImage(gif.bytes)?.format).toBe('gif');
    const { image, diagnostics } = decodeImageWithDiagnostics(new TextEncoder().encode('8BPS\x00\x01 not a bitmap'));
    expect(image).toBeNull();
    expect(codes(diagnostics)).toEqual(['image-unknown-format']);
    expect(decodeImage(new Uint8Array(0))).toBeNull();
    expect(probeImage(new Uint8Array(0))).toBeNull();
  });

  it('no decoder needs Buffer (the page has none)', () => {
    const cases = [bmpCase('24bpp-w5').bytes, bmpCase('rle8-auto-mixed').bytes, pngCase('adam7-rgba-8bit-11x9').bytes, gifCase('multi-3-no-loop').bytes, ...Object.values(JPEGS)];
    const saved = globalThis.Buffer;
    const results = [];
    try {
      // @ts-expect-error simulating a page without Node globals
      delete globalThis.Buffer;
      for (const bytes of cases) results.push(decodeImage(bytes) !== null);
    } finally {
      globalThis.Buffer = saved;
    }
    expect(results.every(Boolean)).toBe(true);
  });

  it('every truncation of every format is a null or an image, never a throw', () => {
    const samples = [bmpCase('24bpp-w5').bytes, bmpCase('rle8-auto-mixed').bytes, pngCase('rgb-8bit').bytes, pngCase('adam7-rgba-8bit-11x9').bytes, gifCase('multi-3-no-loop').bytes, JPEGS.progressive420];
    for (const bytes of samples) {
      for (let n = 0; n <= bytes.length; n += Math.max(1, bytes.length >> 6)) {
        expect(() => decodeImage(bytes.slice(0, n))).not.toThrow();
        expect(() => probeImage(bytes.slice(0, n))).not.toThrow();
        // decodeImage wraps every decoder in a catch-all, so "not.toThrow" cannot fail for a decoder bug;
        // the catch-all's own diagnostic is what shows a decoder that threw.
        expect(codes(decodeImageWithDiagnostics(bytes.slice(0, n)).diagnostics), `truncated to ${n}`).not.toContain('image-decode-error');
      }
    }
  });

  it('a spread of single-byte corruptions never throws', () => {
    const samples = [bmpCase('rle4-auto-mixed').bytes, pngCase('indexed-4bit').bytes, gifCase('lzw-width-12-no-reset').bytes, JPEGS.baseline420];
    for (const bytes of samples) {
      for (let at = 0; at < Math.min(bytes.length, 400); at += 3) {
        const bad = bytes.slice();
        bad[at] ^= 0xff;
        expect(() => decodeImage(bad)).not.toThrow();
        expect(codes(decodeImageWithDiagnostics(bad).diagnostics), `byte ${at} flipped`).not.toContain('image-decode-error');
      }
    }
  });
});
