// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzlibSync } from 'fflate';
import pngjs from 'pngjs';
import { crc32, concat } from './bytes.js';
import { PNG_DEPTHS, buildPng, patternSamples, pngCase, pngCaseIds, pngCases } from './png-writer.js';
import { HAS_SIPS, makeTempDir, sipsSize } from './ref-decoders.js';

const { PNG } = pngjs;
const be32 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** @param {Uint8Array} bytes */
function chunks(bytes) {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** @type {Array<{type:string, data:Uint8Array, crcOk:boolean}>} */
  const out = [];
  for (let p = 8; p < bytes.length; ) {
    const len = be32(bytes, p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    const crc = be32(bytes, p + 8 + len);
    out.push({ type, data, crcOk: crc === crc32(concat(bytes.subarray(p + 4, p + 8), data)) });
    p += 12 + len;
  }
  return out;
}

/** The scanline bytes, after joining the IDATs and inflating. @param {Uint8Array} bytes */
const rawData = (bytes) => unzlibSync(concat(...chunks(bytes).filter((c) => c.type === 'IDAT').map((c) => c.data)));

/** Bytes the scanlines of a w x h image occupy: rows x (filter byte + packed row). */
const imageBytes = (/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ bitsPerPixel) => (w && h ? h * (1 + ((w * bitsPerPixel + 7) >> 3)) : 0);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const adam7Bytes = (/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ bpp) =>
  ADAM7.reduce((n, [x0, y0, dx, dy]) => n + imageBytes(Math.max(0, Math.ceil((w - x0) / dx)), Math.max(0, Math.ceil((h - y0) / dy)), bpp), 0);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-png-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const all = pngCases();
const valid = all.filter((c) => c.valid);

describe('PNG catalogue', () => {
  it('has unique ids and every colour type at every legal bit depth', () => {
    expect(new Set(pngCaseIds()).size).toBe(pngCaseIds().length);
    const have = new Set(all.map((c) => `${c.colorType}/${c.bitDepth}`));
    for (const [ct, depths] of Object.entries(PNG_DEPTHS)) for (const d of depths) expect(have, `type ${ct} depth ${d}`).toContain(`${ct}/${d}`);
    expect(have.size).toBe(15);
  });

  it('covers tRNS on every colour type that has it, Adam7, every filter, split IDAT and header lies', () => {
    const ids = pngCaseIds();
    expect(ids.filter((i) => i.includes('trns')).length).toBeGreaterThanOrEqual(10);
    expect(ids.filter((i) => i.startsWith('adam7-')).length).toBeGreaterThanOrEqual(10);
    for (const f of [0, 1, 2, 3, 4]) expect(ids).toContain(`rgb-8bit-filter-${f}`);
    expect(ids).toContain('rgba-8bit-split-idat');
    expect(ids.filter((i) => i.startsWith('declared-')).length).toBeGreaterThanOrEqual(3);
    expect(ids).toEqual(expect.arrayContaining(['idat-overflow', 'idat-underflow', 'axis-16384x20-gray-8bit', 'axis-16385x20-gray-8bit']));
  });

  it('is deterministic', () => {
    for (const id of ['rgba-16bit', 'adam7-rgb-8bit-11x9', 'indexed-4bit-trns-partial']) {
      expect(Buffer.compare(pngCase(id).bytes, pngCase(id).bytes)).toBe(0);
    }
  });

  it.each(all.map((c) => [c.id, c]))('%s: signature, chunk order and CRCs are right', (_id, c) => {
    const cs = chunks(c.bytes);
    expect(cs.every((x) => x.crcOk)).toBe(true);
    expect(cs[0].type).toBe('IHDR');
    expect(cs.at(-1)?.type).toBe('IEND');
    const types = cs.map((x) => x.type);
    const firstIdat = types.indexOf('IDAT');
    expect(firstIdat).toBeGreaterThan(0);
    for (const t of ['PLTE', 'tRNS']) if (types.includes(t)) expect(types.indexOf(t)).toBeLessThan(firstIdat);
    if (types.includes('PLTE') && types.includes('tRNS')) expect(types.indexOf('PLTE')).toBeLessThan(types.indexOf('tRNS'));
    // IDATs are consecutive
    const last = types.lastIndexOf('IDAT');
    expect(types.slice(firstIdat, last + 1).every((t) => t === 'IDAT')).toBe(true);
    const ihdr = cs[0].data;
    expect(ihdr.length).toBe(13);
    expect([be32(ihdr, 0), be32(ihdr, 4)]).toEqual([c.width, c.height]);
    expect([ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]]).toEqual([c.bitDepth, c.colorType, 0, 0, c.spec.interlace ? 1 : 0]);
  });

  it('16-bit samples are (b << 8) | (b ^ 0x0f), so the high byte and nearest rounding agree and the low byte differs', () => {
    for (const v of patternSamples(7, 5, 3, 16)) {
      const hi = v >> 8;
      expect(v & 255).toBe(hi ^ 0x0f);
      expect(Math.round(v / 257)).toBe(hi);
    }
  });

  it('rejects an illegal colour type and depth pair', () => {
    expect(() => buildPng({ width: 1, height: 1, colorType: 2, bitDepth: 4 })).toThrow();
    expect(() => buildPng({ width: 1, height: 1, colorType: 3, bitDepth: 16, palette: [[0, 0, 0]] })).toThrow();
    expect(() => buildPng({ width: 1, height: 1, colorType: 3, bitDepth: 8 })).toThrow();
  });
});

describe('PNG scanline data, checked without any PNG decoder', () => {
  it.each(valid.filter((c) => c.spec.rawOverride === undefined && c.spec.truncateIdat === undefined && !c.spec.declare).map((c) => [c.id, c]))('%s inflates to exactly the size IHDR implies', (_id, c) => {
    const bpp = CHANNELS[c.colorType] * c.bitDepth;
    const expected = c.spec.interlace ? adam7Bytes(c.width, c.height, bpp) : imageBytes(c.width, c.height, bpp);
    expect(rawData(c.bytes).length).toBe(expected);
  });

  it('fixed filters write that filter byte on every scanline; the default cycles 0..4 per row', () => {
    for (const f of [0, 1, 2, 3, 4]) {
      const c = pngCase(`rgb-8bit-filter-${f}`);
      const raw = rawData(c.bytes);
      const stride = 1 + 9 * 3;
      for (let y = 0; y < c.height; y++) expect(raw[y * stride]).toBe(f);
    }
    const c = pngCase('rgb-8bit');
    const raw = rawData(c.bytes);
    for (let y = 0; y < c.height; y++) expect(raw[y * (1 + 5 * 3)]).toBe(y % 5);
  });

  it('Adam7 rows are grouped by pass, and an empty pass writes nothing', () => {
    const one = pngCase('adam7-rgb-8bit-1x1');
    expect(rawData(one.bytes).length).toBe(1 + 3); // only pass 1 has a pixel
    const c = pngCase('adam7-gray-8bit-11x9');
    const raw = rawData(c.bytes);
    // pass 1 (x0=0, y0=0, step 8): 2 columns x 2 rows, first row has pixels (0,0) and (8,0)
    expect(raw.length).toBe(adam7Bytes(11, 9, 8));
    const first = c.samples;
    expect(raw[0]).toBe(0); // row 0 of the cycle uses filter 0, so the pixels are stored raw
    expect([raw[1], raw[2]]).toEqual([first[0], first[8]]);
  });

  it('split IDAT chunks join into one valid zlib stream', () => {
    const c = pngCase('rgba-8bit-split-idat');
    const idats = chunks(c.bytes).filter((x) => x.type === 'IDAT');
    expect(idats.length).toBeGreaterThan(3);
    expect(idats.slice(0, -1).every((x) => x.data.length === 7)).toBe(true);
    expect(rawData(c.bytes).length).toBe(imageBytes(12, 8, 32));
  });

  it('the broken fixtures are broken in the way they claim', () => {
    const over = pngCase('idat-overflow');
    expect(rawData(over.bytes).length).toBe(20 + 5000); // IHDR 4x4 grey implies 20
    expect([over.width, over.height]).toEqual([4, 4]);
    expect(rawData(pngCase('idat-underflow').bytes).length).toBe(10);
    expect(() => rawData(pngCase('idat-truncated-stream').bytes)).toThrow();
    const big = pngCase('declared-30000x30000-gray-8bit');
    expect(be32(chunks(big.bytes)[0].data, 0)).toBe(30000);
    expect(big.bytes.length).toBeLessThan(200);
    expect(be32(chunks(pngCase('declared-2147483647x1').bytes)[0].data, 0)).toBe(2147483647);
    expect(be32(chunks(pngCase('declared-zero-width').bytes)[0].data, 0)).toBe(0);
  });

  it('ancillary chunks sit before the image data and carry the values asked for', () => {
    const c = pngCase('rgb-8bit-ancillary-chunks');
    const cs = chunks(c.bytes);
    expect(cs.map((x) => x.type).slice(0, 7)).toEqual(['IHDR', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'tEXt', 'prVt']);
    expect(be32(cs[1].data, 0)).toBe(45455);
  });

  it('tRNS payloads: grey key is 2 bytes, RGB key 6, indexed one byte per entry', () => {
    const t = (/** @type {string} */ id) => chunks(pngCase(id).bytes).find((x) => x.type === 'tRNS')?.data.length;
    expect(t('gray-8bit-trns')).toBe(2);
    expect(t('rgb-16bit-trns')).toBe(6);
    expect(t('indexed-4bit-trns-partial')).toBe(3);
    expect(t('indexed-8bit-trns-full')).toBe(40);
  });
});

describe('PNG expected pixels', () => {
  it('sub-8-bit grey scales to the full range and 16-bit takes the high byte', () => {
    const g1 = buildPng({ width: 2, height: 1, colorType: 0, bitDepth: 1, samples: [0, 1] });
    expect(Array.from(g1.rgba ?? [])).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    const g2 = buildPng({ width: 4, height: 1, colorType: 0, bitDepth: 2, samples: [0, 1, 2, 3] });
    expect(Array.from(g2.rgba ?? []).filter((_, i) => i % 4 === 0)).toEqual([0, 85, 170, 255]);
    const g16 = buildPng({ width: 1, height: 1, colorType: 0, bitDepth: 16, samples: [0x80f1] });
    expect(g16.rgba?.[0]).toBe(0x80);
  });

  it('tRNS keys the exact sample only; indexed alpha is per entry and missing entries are opaque', () => {
    const k = buildPng({ width: 3, height: 1, colorType: 0, bitDepth: 8, samples: [7, 8, 7], trns: { gray: 7 } });
    expect([k.rgba?.[3], k.rgba?.[7], k.rgba?.[11]]).toEqual([0, 255, 0]);
    const i = buildPng({ width: 3, height: 1, colorType: 3, bitDepth: 2, palette: [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]], samples: [0, 1, 3], trns: [10, 20] });
    expect([i.rgba?.[3], i.rgba?.[7], i.rgba?.[11]]).toEqual([10, 20, 255]);
    const rgb16 = buildPng({ width: 2, height: 1, colorType: 2, bitDepth: 16, samples: [0x1234, 0x5678, 0x9abc, 0x1234, 0x5678, 0x9abd], trns: { r: 0x1234, g: 0x5678, b: 0x9abc } });
    expect([rgb16.rgba?.[3], rgb16.rgba?.[7]]).toEqual([0, 255]);
  });

  it('the output has no expectation when the file lies or is broken', () => {
    for (const id of ['declared-30000x30000-gray-8bit', 'idat-overflow', 'idat-truncated-stream']) expect(pngCase(id).rgba).toBeNull();
  });
});

describe('PNG via pngjs (an independent decoder)', () => {
  it.each(valid.filter((c) => c.rgba).map((c) => [c.id, c]))('%s decodes to the expected pixels', (_id, c) => {
    const img = PNG.sync.read(Buffer.from(c.bytes));
    expect([img.width, img.height]).toEqual([c.width, c.height]);
    let wrong = 0;
    for (let i = 0; i < /** @type {Uint8Array} */ (c.rgba).length; i += 4) {
      // pngjs zeroes the colour of a fully transparent pixel; two alpha-0 pixels are equal (D9)
      if (c.rgba?.[i + 3] === 0 && img.data[i + 3] === 0) continue;
      for (let k = 0; k < 4; k++) if (img.data[i + k] !== c.rgba?.[i + k]) wrong++;
    }
    expect(wrong).toBe(0);
  });
});

describe.skipIf(!HAS_SIPS)('PNG via sips (ImageIO)', () => {
  it.each(valid.map((c) => [c.id, c]))('%s opens with the right dimensions', (id, c) => {
    const p = join(dir, `${id}.png`);
    writeFileSync(p, c.bytes);
    expect(sipsSize(p)).toEqual({ width: c.width, height: c.height });
  });
});
