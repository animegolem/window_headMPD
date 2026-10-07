// @ts-check
// Synthetic PNG writer (ENGINE D9, D3): every colour type and legal bit depth, tRNS, Adam7, all five
// filters, split IDAT, ancillary chunks, and deliberately wrong headers (oversized IHDR, an IDAT
// that inflates past or short of the size IHDR implies).
//
// `buildPng(spec)` returns the bytes plus `rgba`, the pixels a conforming decoder produces
// (top-left origin, 8-bit). Rules the expectation relies on, which ENGINE D3 states loosely:
//   - sub-8-bit grey scales as v * 255 / (2^depth - 1) (exact for 1, 2, 4 bits);
//   - 16-bit samples scale down by their high byte. The pattern generator writes 16-bit samples as
//     (b << 8) | (b ^ 0x0f), so the high byte and nearest-rounding agree and a decoder that takes
//     the low byte is still caught;
//   - tRNS on grey/RGB is an exact match of the full-depth sample; on indexed it is one alpha per
//     palette entry, missing entries opaque.
// Pixels are compared by pngjs and sips in this directory's tests.

import { zlibSync } from 'fflate';
import { ByteWriter, catalog, concat, crc32, asciiBytes } from './bytes.js';

/** @typedef {[number, number, number]} Rgb3 */
/**
 * @typedef {Object} PngSpec
 * @property {number} width
 * @property {number} height
 * @property {0|2|3|4|6} colorType
 * @property {1|2|4|8|16} bitDepth
 * @property {ArrayLike<number>} [samples]   interleaved native-depth samples, top-down, row-major
 * @property {Rgb3[]} [palette]
 * @property {{gray:number}|{r:number,g:number,b:number}|number[]} [trns]
 * @property {boolean} [interlace]           Adam7
 * @property {0|1|2|3|4|'cycle'} [filter]    per-row filter type (default 'cycle': row n uses n % 5)
 * @property {number} [idatChunk]            split the zlib stream into IDAT chunks of this size
 * @property {Array<{type:string, data:Uint8Array}>} [extraChunks]  written between IHDR and PLTE/IDAT
 * @property {{width:number,height:number}} [declare]   IHDR dimensions that lie about the data
 * @property {Uint8Array} [rawOverride]      replace the pre-compression scanline bytes
 * @property {number} [truncateIdat]         keep only this many bytes of the zlib stream
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Legal bit depths per colour type (PNG spec table 11.1). */
export const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data) {
  const w = new ByteWriter(data.length + 12);
  w.u32be(data.length);
  const td = concat(asciiBytes(type), data);
  w.bytes(td).u32be(crc32(td));
  return w.toBytes();
}

/**
 * Deterministic sample pattern, in range for the depth. 16-bit samples are (b << 8) | (b ^ 0x0f).
 * @param {number} w @param {number} h @param {number} channels @param {number} depth
 * @param {number} [limit] exclusive upper bound for the value (indexed images)
 * @returns {number[]}
 */
export function patternSamples(w, h, channels, depth, limit) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        const base = (x * 37 + y * 91 + c * 61 + 11) % 251;
        if (limit !== undefined) out.push((x * 3 + y * 5 + x * y + c) % limit);
        else if (depth === 16) out.push((base << 8) | (base ^ 0x0f));
        else if (depth === 8) out.push(base);
        else out.push(base & ((1 << depth) - 1));
      }
    }
  }
  return out;
}

/** @param {number} type @param {Uint8Array} cur @param {Uint8Array} prev @param {number} bpp */
function filterRow(type, cur, prev, bpp) {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[i] = (cur[i] - pred) & 255;
  }
  return out;
}

/**
 * Filter and serialise one (sub)image: scanlines padded to bytes, one filter byte each.
 * @param {number[]} px samples of the sub-image, row-major
 * @param {number} w @param {number} h @param {number} channels @param {number} depth
 * @param {PngSpec['filter']} filter @param {number} rowBase first row's index, for the 'cycle' mode
 */
function serialise(px, w, h, channels, depth, filter, rowBase) {
  if (w === 0 || h === 0) return new Uint8Array(0);
  const bitsPerPixel = channels * depth;
  const rowLen = (w * bitsPerPixel + 7) >> 3;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new ByteWriter(h * (rowLen + 1));
  let prev = new Uint8Array(rowLen);
  for (let y = 0; y < h; y++) {
    const cur = new Uint8Array(rowLen);
    let bit = 0;
    for (let i = 0; i < w * channels; i++) {
      const v = px[y * w * channels + i];
      if (depth === 16) { cur[i * 2] = v >> 8; cur[i * 2 + 1] = v & 255; }
      else if (depth === 8) cur[i] = v;
      else { cur[bit >> 3] |= v << (8 - depth - (bit & 7)); bit += depth; }
    }
    const type = filter === undefined || filter === 'cycle' ? (rowBase + y) % 5 : filter;
    out.u8(type).bytes(filterRow(type, cur, prev, bpp));
    prev = cur;
  }
  return out.toBytes();
}

/** @param {PngSpec} spec @param {number[]} samples @returns {Uint8Array} */
function expectedRgba(spec, samples) {
  const { width: w, height: h, colorType: ct, bitDepth: d } = spec;
  const out = new Uint8Array(w * h * 4);
  const to8 = (/** @type {number} */ v) => (d === 16 ? v >> 8 : d === 8 ? v : Math.round((v * 255) / ((1 << d) - 1)));
  const n = CHANNELS[ct];
  for (let i = 0; i < w * h; i++) {
    const s = samples.slice(i * n, i * n + n);
    let r, g, b, a = 255;
    if (ct === 0) {
      r = g = b = to8(s[0]);
      if (spec.trns && 'gray' in spec.trns && spec.trns.gray === s[0]) a = 0;
    } else if (ct === 2) {
      [r, g, b] = [to8(s[0]), to8(s[1]), to8(s[2])];
      const t = /** @type {any} */ (spec.trns);
      if (t && 'r' in t && t.r === s[0] && t.g === s[1] && t.b === s[2]) a = 0;
    } else if (ct === 3) {
      [r, g, b] = /** @type {Rgb3[]} */ (spec.palette)[s[0]];
      if (Array.isArray(spec.trns) && s[0] < spec.trns.length) a = spec.trns[s[0]];
    } else if (ct === 4) {
      r = g = b = to8(s[0]);
      a = to8(s[1]);
    } else {
      [r, g, b, a] = [to8(s[0]), to8(s[1]), to8(s[2]), to8(s[3])];
    }
    out.set([r, g, b, a], i * 4);
  }
  return out;
}

/**
 * @param {PngSpec} spec
 * @returns {{ bytes: Uint8Array, width: number, height: number, colorType: number, bitDepth: number,
 *   rgba: Uint8Array|null, samples: number[] }}
 */
export function buildPng(spec) {
  const { width: w, height: h, colorType: ct, bitDepth: d } = spec;
  if (!PNG_DEPTHS[ct]?.includes(d)) throw new Error(`illegal PNG colour type ${ct} at depth ${d}`);
  const channels = CHANNELS[ct];
  if (ct === 3 && !spec.palette) throw new Error('indexed PNG needs a palette');
  const samples = Array.from(
    spec.samples ?? patternSamples(w, h, channels, d, ct === 3 ? /** @type {Rgb3[]} */ (spec.palette).length : undefined),
  );
  if (samples.length !== w * h * channels) throw new Error('sample count does not match the dimensions');

  let raw;
  if (spec.rawOverride) {
    raw = spec.rawOverride;
  } else if (!spec.interlace) {
    raw = serialise(samples, w, h, channels, d, spec.filter, 0);
  } else {
    const parts = [];
    let rowBase = 0;
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.max(0, Math.ceil((w - x0) / dx));
      const ph = Math.max(0, Math.ceil((h - y0) / dy));
      if (!pw || !ph) continue; // an empty pass has no scanlines and no filter bytes
      const px = [];
      for (let y = y0; y < h; y += dy) for (let x = x0; x < w; x += dx) for (let c = 0; c < channels; c++) px.push(samples[(y * w + x) * channels + c]);
      parts.push(serialise(px, pw, ph, channels, d, spec.filter, rowBase));
      rowBase += ph;
    }
    raw = concat(...parts);
  }
  let z = zlibSync(raw, { level: 6 });
  if (spec.truncateIdat !== undefined) z = z.slice(0, spec.truncateIdat);

  const out = new ByteWriter(z.length + 128);
  out.bytes(SIGNATURE);
  const ihdr = new ByteWriter(13);
  ihdr.u32be(spec.declare?.width ?? w).u32be(spec.declare?.height ?? h).u8(d).u8(ct).u8(0).u8(0).u8(spec.interlace ? 1 : 0);
  out.bytes(chunk('IHDR', ihdr.toBytes()));
  for (const c of spec.extraChunks ?? []) out.bytes(chunk(c.type, c.data));
  if (spec.palette) out.bytes(chunk('PLTE', Uint8Array.from(spec.palette.flat())));
  if (spec.trns) {
    const t = /** @type {any} */ (spec.trns);
    const tw = new ByteWriter();
    if (Array.isArray(t)) tw.bytes(t);
    else if ('gray' in t) tw.u8(t.gray >> 8).u8(t.gray);
    else for (const v of [t.r, t.g, t.b]) tw.u8(v >> 8).u8(v);
    out.bytes(chunk('tRNS', tw.toBytes()));
  }
  const step = spec.idatChunk ?? z.length;
  for (let i = 0; i < z.length || i === 0; i += Math.max(1, step)) out.bytes(chunk('IDAT', z.subarray(i, i + step)));
  out.bytes(chunk('IEND', new Uint8Array(0)));

  const lies = spec.declare && (spec.declare.width !== w || spec.declare.height !== h);
  return {
    bytes: out.toBytes(),
    width: spec.declare?.width ?? w,
    height: spec.declare?.height ?? h,
    colorType: ct,
    bitDepth: d,
    rgba: lies || spec.rawOverride || spec.truncateIdat !== undefined ? null : expectedRgba(spec, samples),
    samples,
  };
}

// ---- the catalogue ----------------------------------------------------------------------------

const pal16 = Array.from({ length: 16 }, (_, i) => /** @type {Rgb3} */ ([(i * 67 + 30) & 255, (i * 131 + 7) & 255, (i * 29 + 90) & 255]));
/** @param {number} n palette of exactly n distinct-ish entries */
const palOf = (n) => pal16.concat(Array.from({ length: Math.max(0, n - 16) }, (_, i) => /** @type {Rgb3} */ ([(i * 11 + 3) & 255, (i * 7 + 99) & 255, (i * 53 + 200) & 255]))).slice(0, n);

/** @param {PngSpec} spec @param {string} [note] */
const ok = (spec, note = '') => () => ({ ...buildPng(spec), spec, valid: true, note });
/** @param {PngSpec} spec @param {string} note */
const wrong = (spec, note) => () => ({ ...buildPng(spec), spec, valid: false, note });

/** @type {Array<{id:string, doc:string, build:() => any}>} */
const defs = [];
const NAMES = { 0: 'gray', 2: 'rgb', 3: 'indexed', 4: 'graya', 6: 'rgba' };
for (const [ctS, depths] of Object.entries(PNG_DEPTHS)) {
  const ct = /** @type {0|2|3|4|6} */ (Number(ctS));
  for (const d of depths) {
    const w = d < 8 ? 9 : 5;
    /** @type {PngSpec} */
    const spec = { width: w, height: 4, colorType: ct, bitDepth: /** @type {any} */ (d) };
    if (ct === 3) spec.palette = palOf(1 << d);
    defs.push({ id: `${NAMES[ct]}-${d}bit`, doc: `colour type ${ct}, ${d}-bit, ${w} wide, filter cycling per row`, build: ok(spec) });
  }
}
// tRNS
{
  for (const d of [1, 2, 4, 8, 16]) {
    const w = 6, h = 3;
    const samples = patternSamples(w, h, 1, d);
    defs.push({ id: `gray-${d}bit-trns`, doc: `grey ${d}-bit with a tRNS key equal to sample 0 (some pixels keyed)`, build: ok({ width: w, height: h, colorType: 0, bitDepth: /** @type {any} */ (d), samples, trns: { gray: samples[0] } }) });
  }
  for (const d of [8, 16]) {
    const w = 5, h = 3;
    const samples = patternSamples(w, h, 3, d);
    samples[3] = samples[0]; samples[4] = samples[1]; samples[5] = samples[2]; // pixels 0 and 1 equal, both keyed
    defs.push({ id: `rgb-${d}bit-trns`, doc: `RGB ${d}-bit with a tRNS key, two pixels keyed`, build: ok({ width: w, height: h, colorType: 2, bitDepth: /** @type {any} */ (d), samples, trns: { r: samples[0], g: samples[1], b: samples[2] } }) });
  }
  defs.push({ id: 'indexed-4bit-trns-partial', doc: 'indexed 4-bit, tRNS covers 3 of 16 entries (the rest opaque)', build: ok({ width: 9, height: 4, colorType: 3, bitDepth: 4, palette: palOf(16), trns: [0, 128, 255] }) });
  defs.push({ id: 'indexed-8bit-trns-full', doc: 'indexed 8-bit, a tRNS alpha for every palette entry', build: ok({ width: 7, height: 5, colorType: 3, bitDepth: 8, palette: palOf(40), trns: Array.from({ length: 40 }, (_, i) => (i * 37) & 255) }) });
  defs.push({ id: 'indexed-1bit-trns-index0', doc: 'indexed 1-bit with index 0 fully transparent (the common GIF-to-PNG shape)', build: ok({ width: 9, height: 4, colorType: 3, bitDepth: 1, palette: palOf(2), trns: [0] }) });
}
// Adam7
for (const [name, ct, d, extra] of /** @type {Array<[string, 0|2|3|4|6, any, Partial<PngSpec>]>} */ ([
  ['gray-8bit', 0, 8, {}], ['gray-1bit', 0, 1, {}], ['rgb-8bit', 2, 8, {}], ['rgba-8bit', 6, 8, {}], ['rgb-16bit', 2, 16, {}],
  ['graya-8bit', 4, 8, {}], ['indexed-4bit', 3, 4, { palette: palOf(16) }], ['indexed-2bit', 3, 2, { palette: palOf(4) }],
])) {
  defs.push({ id: `adam7-${name}-11x9`, doc: `Adam7, ${name}, 11 x 9 (all seven passes occupied; filters cycle across passes)`, build: ok({ width: 11, height: 9, colorType: ct, bitDepth: d, interlace: true, ...extra }) });
}
for (const [w, h] of [[1, 1], [3, 2], [2, 5], [5, 1], [8, 8], [9, 17]]) {
  defs.push({ id: `adam7-rgb-8bit-${w}x${h}`, doc: `Adam7 at ${w} x ${h}: some passes are empty and carry no filter bytes`, build: ok({ width: w, height: h, colorType: 2, bitDepth: 8, interlace: true }) });
}
// filters, chunk layout, ancillary chunks
for (const f of [0, 1, 2, 3, 4]) {
  defs.push({ id: `rgb-8bit-filter-${f}`, doc: `RGB 8-bit, every row filter type ${f}`, build: ok({ width: 9, height: 6, colorType: 2, bitDepth: 8, filter: /** @type {any} */ (f) }) });
  defs.push({ id: `gray-4bit-filter-${f}`, doc: `grey 4-bit (bpp rounds up to 1 byte), every row filter type ${f}`, build: ok({ width: 9, height: 6, colorType: 0, bitDepth: 4, filter: /** @type {any} */ (f) }) });
}
defs.push({ id: 'rgba-8bit-split-idat', doc: 'RGBA 8-bit, IDAT split into 7-byte chunks', build: ok({ width: 12, height: 8, colorType: 6, bitDepth: 8, idatChunk: 7 }) });
{
  const u32 = (/** @type {number[]} */ ...v) => { const w = new ByteWriter(); for (const x of v) w.u32be(x); return w.toBytes(); };
  const text = (/** @type {string} */ k, /** @type {string} */ v) => asciiBytes(`${k}\0${v}`);
  defs.push({
    id: 'rgb-8bit-ancillary-chunks',
    doc: 'RGB 8-bit with gAMA, cHRM, sRGB, pHYs, tEXt and a private chunk: none may change the pixels',
    build: ok({
      width: 5, height: 4, colorType: 2, bitDepth: 8,
      extraChunks: [
        { type: 'gAMA', data: u32(45455) },
        { type: 'cHRM', data: u32(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000) },
        { type: 'sRGB', data: Uint8Array.of(0) },
        { type: 'pHYs', data: concat(u32(2835, 2835), Uint8Array.of(1)) },
        { type: 'tEXt', data: text('Comment', 'synthetic fixture') },
        { type: 'prVt', data: Uint8Array.of(1, 2, 3) },
      ],
    }, 'gAMA/iCCP are not applied (D3): colour management could move #FF00FF off its key'),
  });
  defs.push({
    id: 'gray-8bit-gamma-0.5',
    doc: 'grey 8-bit with gAMA 0.5: decoded values stay the stored samples (no gamma applied)',
    build: ok({ width: 5, height: 4, colorType: 0, bitDepth: 8, extraChunks: [{ type: 'gAMA', data: u32(50000) }] }),
  });
}
// the key colour, as the corpus uses it
defs.push({
  id: 'rgb-8bit-magenta-key',
  doc: 'RGB 8-bit with #FF00FF pixels (the skins\' colour key) and nothing else special',
  build: ok({ width: 4, height: 2, colorType: 2, bitDepth: 8, samples: [255, 0, 255, 1, 2, 3, 255, 0, 255, 255, 0, 254, 0, 0, 0, 255, 0, 255, 9, 9, 9, 255, 0, 255] }),
});
// header lies and caps
{
  /** @param {number} dw @param {number} dh */
  const tiny = (dw, dh) => ({ width: 1, height: 1, colorType: /** @type {0} */ (0), bitDepth: /** @type {8} */ (8), declare: { width: dw, height: dh } });
  defs.push({ id: 'declared-30000x30000-gray-8bit', doc: 'IHDR says 30000 x 30000 over a one-pixel IDAT: refused from the header, allocating nothing', build: wrong(tiny(30000, 30000), 'header lie') });
  defs.push({ id: 'declared-30000x30000-adam7', doc: 'the same, interlaced', build: wrong({ ...tiny(30000, 30000), interlace: true }, 'header lie') });
  defs.push({ id: 'declared-2147483647x1', doc: 'IHDR width 2^31 - 1', build: wrong(tiny(2147483647, 1), 'header lie') });
  defs.push({ id: 'declared-zero-width', doc: 'IHDR width 0 (illegal)', build: wrong(tiny(0, 5), 'illegal header') });
  defs.push({ id: 'axis-16384x20-gray-8bit', doc: '16,384 x 20: the widest allowed axis decodes', build: ok({ width: 16384, height: 20, colorType: 0, bitDepth: 8, samples: new Uint8Array(16384 * 20).map((_, i) => (i * 7) & 255), filter: 0 }) });
  defs.push({ id: 'axis-16385x20-gray-8bit', doc: '16,385 x 20: one past the axis cap', build: ok({ width: 16385, height: 20, colorType: 0, bitDepth: 8, samples: new Uint8Array(16385 * 20).map((_, i) => (i * 7) & 255), filter: 0 }, 'valid file; the cap is decoder policy') });
  defs.push({ id: 'axis-20x16385-gray-8bit', doc: '20 x 16,385: one past the axis cap, vertical', build: ok({ width: 20, height: 16385, colorType: 0, bitDepth: 8, samples: new Uint8Array(20 * 16385).map((_, i) => (i * 7) & 255), filter: 0 }, 'valid file; the cap is decoder policy') });
  // 4 x 4 grey 8-bit implies 4 * (4 + 1) = 20 bytes of scanline data.
  defs.push({ id: 'idat-overflow', doc: 'IHDR 4 x 4 grey, but the IDAT inflates to 20 + 5000 bytes: the image is corrupt (D3)', build: wrong({ width: 4, height: 4, colorType: 0, bitDepth: 8, rawOverride: new Uint8Array(20 + 5000) }, 'inflate past the IHDR size') });
  defs.push({ id: 'idat-underflow', doc: 'IHDR 4 x 4 grey, but the IDAT inflates to only 10 bytes', build: wrong({ width: 4, height: 4, colorType: 0, bitDepth: 8, rawOverride: new Uint8Array(10) }, 'short data') });
  defs.push({ id: 'idat-truncated-stream', doc: 'a valid 12 x 12 RGB image whose zlib stream is cut in half', build: wrong({ width: 12, height: 12, colorType: 2, bitDepth: 8, samples: Array.from({ length: 12 * 12 * 3 }, (_, i) => (i * 13) & 255), truncateIdat: 30 }, 'truncated stream') });
}

const cat = catalog(defs);
export const pngCaseIds = () => cat.ids();
/** @param {string} id */
export const pngCase = (id) => cat.get(id);
/** @param {(id: string) => boolean} [filter] */
export const pngCases = (filter) => cat.all(filter);
