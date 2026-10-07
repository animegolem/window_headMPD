// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { autoRle, bmpCase, bmpCaseIds, bmpCases, buildBmp, decodeRle, encodeRle } from './bmp-writer.js';
import { widenTo8 } from './bytes.js';
import { HAS_PIL, HAS_SIPS, makeTempDir, pilCompareImages, sipsSize, sipsToPng } from './ref-decoders.js';

const { PNG } = pngjs;
const u16 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => b[o] | (b[o + 1] << 8);
const u32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => u32(b, o) | 0;

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-bmp-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const all = bmpCases();
const valid = all.filter((c) => c.valid);

describe('BMP catalogue', () => {
  it('has unique ids and covers every depth, compression and header the card lists', () => {
    expect(new Set(bmpCaseIds()).size).toBe(bmpCaseIds().length);
    const have = new Set(all.map((c) => `${c.spec.bpp}:${c.spec.compression ?? 'rgb'}:${c.spec.header ?? 40}`));
    for (const bpp of [1, 4, 8, 16, 24, 32]) expect([...have].some((k) => k.startsWith(`${bpp}:`)), `${bpp} bpp`).toBe(true);
    expect(have).toContain('16:rgb:40');
    expect(have).toContain('16:bitfields:40');
    expect(have).toContain('8:rle8:40');
    expect(have).toContain('4:rle4:40');
    for (const h of [12, 52, 56, 108, 124]) expect([...have].some((k) => k.endsWith(`:${h}`)), `header ${h}`).toBe(true);
    expect(all.some((c) => c.spec.topDown)).toBe(true);
    expect(all.some((c) => c.spec.bpp <= 8 && c.spec.palette && c.spec.palette.length < 1 << c.spec.bpp)).toBe(true);
    expect(all.some((c) => c.width % 2 === 1)).toBe(true);
  });

  it('is deterministic: building a case twice gives identical bytes', () => {
    for (const id of ['24bpp-w5', 'rle8-delta', 'rle4-absolute-runs', 'v5-32bpp-bitfields', 'os2-core-8bpp']) {
      expect(Buffer.compare(bmpCase(id).bytes, bmpCase(id).bytes)).toBe(0);
    }
  });

  it.each(all.map((c) => [c.id, c]))('%s: file header and info header are self-consistent', (_id, c) => {
    const b = c.bytes;
    expect(String.fromCharCode(b[0], b[1])).toBe('BM');
    expect(u32(b, 2)).toBe(b.length);
    const header = c.spec.header ?? 40;
    expect(u32(b, 14)).toBe(header);
    const w = header === 12 ? u16(b, 18) : i32(b, 18);
    const hRaw = header === 12 ? u16(b, 20) : i32(b, 22);
    expect(w).toBe(c.width);
    expect(Math.abs(hRaw)).toBe(c.height);
    if (header !== 12) expect(hRaw < 0).toBe(Boolean(c.spec.topDown));
    expect(u16(b, header === 12 ? 22 : 26)).toBe(1); // planes
    expect(u16(b, header === 12 ? 24 : 28)).toBe(c.bpp);
    const off = u32(b, 10);
    expect(off).toBeGreaterThanOrEqual(14 + header);
    expect(off).toBeLessThanOrEqual(b.length);
    if (!c.spec.headerOnly && !c.spec.truncateRle && c.valid && !c.spec.declare) {
      // uncompressed data is exactly rows x padded stride
      if (!c.spec.compression || c.spec.compression === 'rgb' || c.spec.compression === 'bitfields') {
        expect(b.length - off).toBe((((c.width * c.bpp + 31) >>> 5) << 2) * c.height);
      }
    }
  });
});

describe('BMP pixel layout, checked by hand', () => {
  it('24 bpp is bottom-up BGR with rows padded to 4 bytes', () => {
    const rgba = Uint8Array.from([10, 20, 30, 255, 11, 21, 31, 255, 12, 22, 32, 255, /* row 1 */ 40, 50, 60, 255, 41, 51, 61, 255, 42, 52, 62, 255]);
    const bmp = buildBmp({ width: 3, height: 2, bpp: 24, rgba });
    const off = u32(bmp.bytes, 10);
    expect(Array.from(bmp.bytes.subarray(off, off + 12))).toEqual([60, 50, 40, 61, 51, 41, 62, 52, 42, 0, 0, 0]); // image row 1 comes first
    expect(Array.from(bmp.bytes.subarray(off + 12, off + 24))).toEqual([30, 20, 10, 31, 21, 11, 32, 22, 12, 0, 0, 0]);
    expect(Array.from(bmp.rgba ?? [])).toEqual(Array.from(rgba));
  });

  it('negative height stores rows top-down', () => {
    const rgba = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
    const bmp = buildBmp({ width: 1, height: 2, bpp: 24, rgba, topDown: true });
    const off = u32(bmp.bytes, 10);
    expect(i32(bmp.bytes, 22)).toBe(-2);
    expect(Array.from(bmp.bytes.subarray(off, off + 3))).toEqual([3, 2, 1]);
  });

  it('1 bpp packs the first pixel into the high bit and pads each row to a dword', () => {
    const bmp = buildBmp({ width: 9, height: 1, bpp: 1, palette: [[0, 0, 0], [255, 255, 255]], indices: [1, 0, 1, 1, 0, 0, 0, 1, 1] });
    const off = u32(bmp.bytes, 10);
    expect(Array.from(bmp.bytes.subarray(off, off + 4))).toEqual([0b10110001, 0b10000000, 0, 0]);
  });

  it('4 bpp packs the first pixel into the high nibble', () => {
    const bmp = buildBmp({ width: 3, height: 1, bpp: 4, palette: Array.from({ length: 16 }, (_, i) => [i, i, i]), indices: [0xa, 0x5, 0xc] });
    const off = u32(bmp.bytes, 10);
    expect(Array.from(bmp.bytes.subarray(off, off + 4))).toEqual([0xa5, 0xc0, 0, 0]);
  });

  it('16 bpp BI_RGB is X1R5G5B5 and expands each channel by bit replication', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0x80, 0x40, 0x08, 255]);
    const bmp = buildBmp({ width: 4, height: 1, bpp: 16, rgba });
    const off = u32(bmp.bytes, 10);
    expect(u16(bmp.bytes, off)).toBe(0x7c00);
    expect(u16(bmp.bytes, off + 2)).toBe(0x03e0);
    expect(u16(bmp.bytes, off + 4)).toBe(0x001f);
    expect(u16(bmp.bytes, off + 6)).toBe((0x10 << 10) | (0x08 << 5) | 0x01);
    expect(Array.from((bmp.rgba ?? new Uint8Array()).subarray(12, 15))).toEqual([widenTo8(0x10, 5), widenTo8(0x08, 5), widenTo8(0x01, 5)]);
    expect(bmp.rgba?.[0]).toBe(255);
  });

  it('widenTo8 replicates bits', () => {
    expect(widenTo8(0, 5)).toBe(0);
    expect(widenTo8(31, 5)).toBe(255);
    expect(widenTo8(16, 5)).toBe(0b10000100);
    expect(widenTo8(0b101, 3)).toBe(0b10110110);
    expect(widenTo8(1, 1)).toBe(255);
    expect(widenTo8(0b100000, 6)).toBe(0b10000010);
  });

  it('BI_BITFIELDS 5-6-5 writes the three masks after the INFOHEADER, before the pixels', () => {
    const bmp = buildBmp({ width: 2, height: 1, bpp: 16, compression: 'bitfields' });
    expect(u32(bmp.bytes, 30)).toBe(3);
    expect([u32(bmp.bytes, 54), u32(bmp.bytes, 58), u32(bmp.bytes, 62)]).toEqual([0xf800, 0x07e0, 0x001f]);
    expect(u32(bmp.bytes, 10)).toBe(14 + 40 + 12);
  });

  it('32 bpp: alpha bytes are zero by default and carried when asked, but the expected alpha is always 255', () => {
    const zero = buildBmp({ width: 2, height: 2, bpp: 32 });
    const src = buildBmp({ width: 2, height: 2, bpp: 32, alpha: 'source' });
    expect(zero.alphaNonZero).toBe(false);
    expect(src.alphaNonZero).toBe(true);
    const off = u32(src.bytes, 10);
    expect(src.bytes[off + 3]).not.toBe(0);
    for (const b of [zero, src]) for (let i = 3; i < (b.rgba?.length ?? 0); i += 4) expect(b.rgba?.[i]).toBe(255);
    expect(Array.from(zero.rgba ?? [])).toEqual(Array.from(src.rgba ?? []));
  });

  it('OS/2 core headers use 3-byte palette entries and 16-bit dimensions', () => {
    const bmp = buildBmp({ width: 3, height: 2, bpp: 8, header: 12, palette: [[1, 2, 3], [4, 5, 6]], indices: [0, 1, 0, 1, 0, 1] });
    expect(u32(bmp.bytes, 14)).toBe(12);
    expect(u32(bmp.bytes, 10)).toBe(14 + 12 + 2 * 3);
    expect(Array.from(bmp.bytes.subarray(26, 32))).toEqual([3, 2, 1, 6, 5, 4]); // BGR triples
  });

  it('a short palette sets biClrUsed unless overridden', () => {
    const short = buildBmp({ width: 2, height: 1, bpp: 8, palette: [[0, 0, 0], [9, 9, 9], [8, 8, 8]], indices: [0, 2] });
    expect(u32(short.bytes, 46)).toBe(3);
    expect(u32(short.bytes, 10)).toBe(14 + 40 + 3 * 4);
    const zero = buildBmp({ width: 2, height: 1, bpp: 8, palette: [[0, 0, 0], [9, 9, 9], [8, 8, 8]], indices: [0, 2], clrUsed: 0 });
    expect(u32(zero.bytes, 46)).toBe(0);
    expect(u32(zero.bytes, 10)).toBe(14 + 40 + 3 * 4);
  });

  it('rejects impossible combinations', () => {
    expect(() => buildBmp({ width: 2, height: 2, bpp: 16, header: 12 })).toThrow();
    expect(() => buildBmp({ width: 2, height: 2, bpp: 8, compression: 'rle8', topDown: true })).toThrow();
    expect(() => buildBmp({ width: 2, height: 2, bpp: 24, compression: 'rle8' })).toThrow();
    expect(() => buildBmp({ width: 2, height: 1, bpp: 4, palette: [[0, 0, 0]], indices: [0, 3] })).toThrow();
  });
});

describe('RLE encoder and reference decoder', () => {
  it('encodes each command the way the format defines it', () => {
    expect(Array.from(encodeRle([{ op: 'run', n: 5, idx: 7 }, { op: 'eol' }, { op: 'eob' }], 8))).toEqual([5, 7, 0, 0, 0, 1]);
    expect(Array.from(encodeRle([{ op: 'delta', dx: 3, dy: 2 }], 8))).toEqual([0, 2, 3, 2]);
    // RLE8 absolute: odd counts get a pad byte, even do not
    expect(Array.from(encodeRle([{ op: 'abs', idx: [1, 2, 3] }], 8))).toEqual([0, 3, 1, 2, 3, 0]);
    expect(Array.from(encodeRle([{ op: 'abs', idx: [1, 2, 3, 4] }], 8))).toEqual([0, 4, 1, 2, 3, 4]);
    // RLE4 absolute: nibbles packed high first; the data is padded to a whole word
    expect(Array.from(encodeRle([{ op: 'abs', idx: [1, 2, 3] }], 4))).toEqual([0, 3, 0x12, 0x30]);
    expect(Array.from(encodeRle([{ op: 'abs', idx: [1, 2, 3, 4, 5] }], 4))).toEqual([0, 5, 0x12, 0x34, 0x50, 0]);
    expect(Array.from(encodeRle([{ op: 'abs', idx: [1, 2, 3, 4, 5, 6, 7] }], 4))).toEqual([0, 7, 0x12, 0x34, 0x56, 0x70]);
    // RLE4 encoded run alternates the two nibbles
    expect(Array.from(encodeRle([{ op: 'run', n: 5, idx: [0xa, 0xb] }], 4))).toEqual([5, 0xab]);
    expect(Array.from(encodeRle([{ op: 'run', n: 4, idx: 3 }], 4))).toEqual([4, 0x33]);
    expect(() => encodeRle([{ op: 'abs', idx: [1, 2] }], 8)).toThrow(); // absolute runs need >= 3 (0,1 and 0,2 are escapes)
    expect(() => encodeRle([{ op: 'run', n: 256, idx: 1 }], 8)).toThrow();
  });

  it('decodes rows bottom-up and keeps unwritten pixels marked', () => {
    const stream = encodeRle([{ op: 'run', n: 2, idx: 5 }, { op: 'delta', dx: 1, dy: 1 }, { op: 'run', n: 1, idx: 6 }, { op: 'eob' }], 8);
    const d = decodeRle(stream, 4, 3, 8);
    expect(d.status).toBe('eob');
    expect(Array.from(d.written)).toEqual([1, 1, 0, 0, /* file row 1 */ 0, 0, 0, 1, /* file row 2 */ 0, 0, 0, 0]);
    expect(d.indices[0]).toBe(5);
    expect(d.indices[1]).toBe(5);
    expect(d.indices[4 + 3]).toBe(6); // x = 2 + 1 = 3, y = 0 + 1
  });

  it('reports truncation and overrun instead of reading past the end', () => {
    expect(decodeRle(Uint8Array.of(3, 1, 0), 8, 2, 8).status).toBe('truncated');
    expect(decodeRle(Uint8Array.of(9, 1), 8, 2, 8).status).toBe('overrun');
    expect(decodeRle(Uint8Array.of(0, 2, 1, 9), 8, 2, 8).status).toBe('overrun');
    expect(decodeRle(Uint8Array.of(0, 5, 1, 2, 3), 8, 2, 8).status).toBe('truncated');
  });

  it('the automatic encoder reproduces the source image exactly', () => {
    for (const [bpp, w, h, n] of /** @type {Array<[4|8, number, number, number]>} */ ([[8, 20, 6, 50], [4, 21, 5, 16], [8, 1, 3, 9], [4, 2, 2, 4]])) {
      const idx = Uint8Array.from({ length: w * h }, (_, i) => ((i % w) < 7 ? 2 : (i * 7) % n) % n);
      const d = decodeRle(encodeRle(autoRle(idx, w, h, bpp), bpp), w, h, bpp);
      expect(d.status).toBe('eob');
      expect(d.written.every((v) => v === 1)).toBe(true);
      for (let fileRow = 0; fileRow < h; fileRow++) {
        for (let x = 0; x < w; x++) expect(d.indices[fileRow * w + x]).toBe(idx[(h - 1 - fileRow) * w + x]);
      }
    }
  });

  /** @type {Record<string, [string, number]>} */
  const outcome = {
    'rle8-encoded-runs': ['eob', 0], 'rle8-absolute-runs': ['eob', 0], 'rle8-delta': ['eob', 13], 'rle8-auto-mixed': ['eob', 0],
    'rle8-early-eob': ['eob', 12], 'rle8-eol-eob-only-tail': ['eob', 0], 'rle8-truncated': ['truncated', 16], 'rle8-run-overrun': ['overrun', 12],
    'rle8-abs-overrun': ['overrun', 5], 'rle8-delta-out-of-range': ['overrun', 5],
    'rle4-encoded-runs': ['eob', 0], 'rle4-absolute-runs': ['eob', 0], 'rle4-delta': ['eob', 12], 'rle4-auto-mixed': ['eob', 0], 'rle4-truncated': ['truncated', 24],
  };
  it.each(Object.entries(outcome))('%s ends %s with the expected number of unwritten pixels', (id, [status, unwritten]) => {
    const c = bmpCase(id);
    expect(c.rleStatus).toBe(status);
    expect(c.written?.filter((v) => !v).length).toBe(unwritten);
    expect(c.valid).toBe(status === 'eob');
  });

  it('truncation keeps the rows decoded so far', () => {
    const c = bmpCase('rle8-truncated');
    const w = c.width;
    const rowWritten = (/** @type {number} */ topRow) => c.written?.subarray(topRow * w, (topRow + 1) * w).every((v) => v === 1);
    // 4 rows, bottom-up: file rows 0 and 1 are complete, so top-down rows 3 and 2
    expect(rowWritten(3)).toBe(true);
    expect(rowWritten(2)).toBe(true);
    expect(c.written?.subarray(0, 2 * w).some((v) => v === 1)).toBe(false);
  });
});

describe('BMP header lies and axis caps', () => {
  it('a 30000 x 30000 header with no pixel data is tiny and builds instantly', () => {
    for (const id of ['declared-30000x30000-24bpp-header-only', 'declared-30000x30000-8bpp-header-only']) {
      const t0 = performance.now();
      const c = bmpCase(id);
      expect(performance.now() - t0).toBeLessThan(50);
      expect(c.bytes.length).toBeLessThan(2048);
      expect(i32(c.bytes, 18)).toBe(30000);
      expect(i32(c.bytes, 22)).toBe(30000);
      expect(c.rgba).toBeNull();
    }
  });

  it('the axis fixtures carry real pixel data on either side of the 16,384 cap', () => {
    const a = bmpCase('axis-16384x20-24bpp');
    const b = bmpCase('axis-16385x20-24bpp');
    const c = bmpCase('axis-20x16385-24bpp');
    expect([a.width, a.height, b.width, b.height, c.width, c.height]).toEqual([16384, 20, 16385, 20, 20, 16385]);
    expect(a.bytes.length).toBe(54 + 16384 * 3 * 20);
    expect(b.bytes.length).toBeGreaterThan(a.bytes.length);
    expect(a.rgba?.length).toBe(16384 * 20 * 4);
  });
});

describe.skipIf(!HAS_SIPS)('BMP via sips (ImageIO)', () => {
  it.each(valid.filter((c) => c.ref.sips).map((c) => [c.id, c]))('%s opens with the right dimensions', (id, c) => {
    const p = join(dir, `${id}.bmp`);
    writeFileSync(p, c.bytes);
    expect(sipsSize(p)).toEqual({ width: c.width, height: c.height });
  });

  it.each(valid.filter((c) => c.ref.sipsPixels && c.rgba).map((c) => [c.id, c]))('%s decodes to the expected pixels', (id, c) => {
    const src = join(dir, `${id}.bmp`);
    const out = join(dir, `${id}.sips.png`);
    writeFileSync(src, c.bytes);
    expect(sipsToPng(src, out)).toBe(true);
    const png = PNG.sync.read(readFileSync(out));
    expect([png.width, png.height]).toEqual([c.width, c.height]);
    let wrong = 0;
    for (let i = 0; i < c.width * c.height; i++) {
      if (!c.written?.[i]) continue;
      for (let k = 0; k < 3; k++) if (png.data[i * 4 + k] !== c.rgba?.[i * 4 + k]) wrong++;
    }
    expect(wrong).toBe(0);
  });
});

describe.skipIf(!HAS_PIL)('BMP via Pillow', () => {
  it('every case flagged for Pillow decodes to the expected pixels, within its tolerance', () => {
    const items = valid.filter((c) => c.ref.pil && c.rgba).map((c) => {
      const p = join(dir, `${c.id}.pil.bmp`);
      writeFileSync(p, c.bytes);
      return { id: c.id, path: p, rgba: /** @type {Uint8Array} */ (c.rgba), written: c.written };
    });
    const res = pilCompareImages(items);
    /** @type {string[]} */
    const failures = [];
    for (const c of valid.filter((x) => x.ref.pil && x.rgba)) {
      const r = res[c.id];
      if (r.error) failures.push(`${c.id}: ${r.error}`);
      else if (r.size?.[0] !== c.width || r.size?.[1] !== c.height) failures.push(`${c.id}: size ${r.size}`);
      else if ((r.maxdiff ?? 0) > (c.ref.pilTolerance ?? 0)) failures.push(`${c.id}: max channel difference ${r.maxdiff} > ${c.ref.pilTolerance ?? 0}`);
    }
    expect(failures).toEqual([]);
    expect(items.length).toBeGreaterThan(35);
  }, 60000);
});
