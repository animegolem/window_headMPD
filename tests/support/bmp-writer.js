// @ts-check
// Synthetic BMP writer (ENGINE D9: own-authored fixtures; D3 lists what the decoder must read).
//
// `buildBmp(spec)` encodes one image and returns the bytes together with `rgba`, the pixels a
// conforming decoder produces (top-left origin, alpha forced to 255 per D3), and `written`, a
// per-pixel coverage mask. Pixels the stream never wrote (RLE delta skips, an early end-of-bitmap, a
// truncated or overrunning stream) are `written = 0` and `rgba = 0,0,0,0`: D3 fixes only "the rest is
// transparent" for truncation, not what a delta skip shows, so W1.3 decides and compares on
// `written`.
//
// `expected` is derived from the bytes actually written (quantised channels, the RLE stream run
// through a small reference decoder), never from the caller's intent, so a lossy depth stays
// self-consistent. Tests cross-check it against sips and Pillow.
//
// 16-bit and sub-8-bit channels widen by bit replication (`widenTo8`); D3 does not name the rule.

import { ByteWriter, catalog, maskGeometry, widenTo8 } from './bytes.js';

/** @typedef {[number, number, number]} Rgb3 */
/**
 * RLE commands. `run`: `n` pixels of `idx` (RLE4: `idx` is a nibble or a `[hi, lo]` pair that
 * alternates). `abs`: literal indices (>= 3). `delta`: move right `dx`, up `dy`. `eol`, `eob`.
 * @typedef {{op:'run', n:number, idx:number|[number,number]} | {op:'abs', idx:number[]}
 *   | {op:'delta', dx:number, dy:number} | {op:'eol'} | {op:'eob'}} RleOp
 */
/**
 * @typedef {Object} BmpSpec
 * @property {number} width
 * @property {number} height
 * @property {1|4|8|16|24|32} bpp
 * @property {'rgb'|'rle8'|'rle4'|'bitfields'} [compression]
 * @property {12|40|52|56|108|124} [header]   12 is the OS/2 core header (3-byte palette entries)
 * @property {boolean} [topDown]              negative height; not valid with RLE or the core header
 * @property {Rgb3[]} [palette]               indexed depths; may be shorter than 2^bpp
 * @property {number} [clrUsed]               override the header's biClrUsed
 * @property {ArrayLike<number>} [indices]    top-down, row-major palette indices
 * @property {Uint8Array} [rgba]              top-down RGBA for direct depths
 * @property {{r:number,g:number,b:number,a?:number}} [masks]  BI_BITFIELDS masks
 * @property {'zero'|'source'} [alpha]        32-bpp alpha byte: zero, or the source alpha
 * @property {RleOp[]} [rle]                  explicit RLE commands (else auto-encoded)
 * @property {number} [truncateRle]           keep only this many RLE bytes
 * @property {{width:number,height:number}} [declare]  header dimensions that lie about the data
 * @property {boolean} [headerOnly]           stop after the palette/masks: no pixel data
 */

const CS_SRGB = 0x73524742; // 'sRGB'

/** @param {number} w @param {number} h @returns {Uint8Array} an RGBA gradient, every pixel distinct-ish */
export function gradientRgba(w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = (x * 53 + y * 17 + 9) & 255;
      out[o + 1] = (x * 29 + y * 71 + 120) & 255;
      out[o + 2] = (x * 97 + y * 13 + 201) & 255;
      out[o + 3] = (x * 41 + y * 59 + 77) & 255;
    }
  }
  return out;
}

/** @param {number} n @returns {Rgb3[]} n distinct colours (the red step is odd, so no repeats up to 256) */
export function makePalette(n) {
  /** @type {Rgb3[]} */
  const p = [];
  for (let i = 0; i < n; i++) p.push([(i * 67 + 30) & 255, (i * 131 + 7) & 255, (i * 29 + 90) & 255]);
  return p;
}

/** @param {number} w @param {number} h @param {number} n @returns {Uint8Array} indices < n */
export function patternIndices(w, h, n) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (x * 3 + y * 5 + x * y) % n;
  return out;
}

/** @param {number} bpp @param {number} width */
const stride = (bpp, width) => ((width * bpp + 31) >>> 5) << 2;

// ---- RLE --------------------------------------------------------------------------------------

/** @param {RleOp[]} ops @param {4|8} bpp @returns {Uint8Array} */
export function encodeRle(ops, bpp) {
  const w = new ByteWriter();
  const nib = (/** @type {number|[number,number]} */ idx) =>
    Array.isArray(idx) ? ((idx[0] & 15) << 4) | (idx[1] & 15) : ((idx & 15) << 4) | (idx & 15);
  for (const o of ops) {
    if (o.op === 'run') {
      if (o.n < 1 || o.n > 255) throw new Error('rle run length 1..255');
      w.u8(o.n).u8(bpp === 8 ? /** @type {number} */ (o.idx) : nib(o.idx));
    } else if (o.op === 'abs') {
      const n = o.idx.length;
      if (n < 3 || n > 255) throw new Error('rle absolute run length 3..255');
      w.u8(0).u8(n);
      if (bpp === 8) {
        for (const v of o.idx) w.u8(v);
        if (n & 1) w.u8(0);
      } else {
        const bytes = (n + 1) >> 1;
        for (let i = 0; i < n; i += 2) w.u8(((o.idx[i] & 15) << 4) | (i + 1 < n ? o.idx[i + 1] & 15 : 0));
        if (bytes & 1) w.u8(0); // absolute data is word aligned
      }
    } else if (o.op === 'delta') {
      w.u8(0).u8(2).u8(o.dx).u8(o.dy);
    } else if (o.op === 'eol') {
      w.u8(0).u8(0);
    } else {
      w.u8(0).u8(1);
    }
  }
  return w.toBytes();
}

/**
 * Reference RLE decoder. Rows are in file order (row 0 is the bottom row). Stops at the first
 * command that would write outside the bitmap, and at a short stream.
 * @param {Uint8Array} data @param {number} w @param {number} h @param {4|8} bpp
 * @returns {{indices:Uint8Array, written:Uint8Array, status:'eob'|'end'|'truncated'|'overrun'}}
 */
export function decodeRle(data, w, h, bpp) {
  const indices = new Uint8Array(w * h);
  const written = new Uint8Array(w * h);
  let x = 0;
  let y = 0;
  let i = 0;
  /** @type {'eob'|'end'|'truncated'|'overrun'} */
  let status = 'end';
  const put = (/** @type {number} */ v) => { indices[y * w + x] = v; written[y * w + x] = 1; x++; };
  loop: while (i < data.length) {
    if (i + 1 >= data.length) { status = 'truncated'; break; }
    const a = data[i++];
    const b = data[i++];
    if (a > 0) {
      if (y >= h || x + a > w) { status = 'overrun'; break; }
      for (let k = 0; k < a; k++) put(bpp === 8 ? b : k & 1 ? b & 15 : b >> 4);
      continue;
    }
    if (b === 0) { x = 0; y++; continue; }
    if (b === 1) { status = 'eob'; break loop; }
    if (b === 2) {
      if (i + 1 >= data.length) { status = 'truncated'; break; }
      const dx = data[i++];
      const dy = data[i++];
      if (x + dx > w || y + dy >= h) { status = 'overrun'; break; }
      x += dx;
      y += dy;
      continue;
    }
    const dataBytes = bpp === 8 ? b : (b + 1) >> 1;
    const total = dataBytes + (dataBytes & 1);
    if (y >= h || x + b > w) { status = 'overrun'; break; }
    if (i + dataBytes > data.length) { status = 'truncated'; break; }
    for (let k = 0; k < b; k++) put(bpp === 8 ? data[i + k] : k & 1 ? data[i + (k >> 1)] & 15 : data[i + (k >> 1)] >> 4);
    i += Math.min(total, data.length - i);
  }
  return { indices, written, status };
}

/**
 * Greedy automatic encoder: runs where the same index repeats, absolute runs for literals, an
 * end-of-line after every row but the last, then end-of-bitmap. Input rows are top-down; RLE is
 * always stored bottom-up.
 * @param {ArrayLike<number>} indices @param {number} w @param {number} h @param {4|8} bpp
 * @returns {RleOp[]}
 */
export function autoRle(indices, w, h, bpp) {
  /** @type {RleOp[]} */
  const ops = [];
  const minRun = bpp === 8 ? 3 : 4;
  for (let fileRow = 0; fileRow < h; fileRow++) {
    const row = Array.from({ length: w }, (_, x) => indices[(h - 1 - fileRow) * w + x]);
    let x = 0;
    while (x < w) {
      let n = 1;
      while (x + n < w && row[x + n] === row[x] && n < 255) n++;
      if (n >= minRun) {
        ops.push({ op: 'run', n, idx: row[x] });
        x += n;
        continue;
      }
      let end = x;
      while (end < w && end - x < 255) {
        let r = 1;
        while (end + r < w && row[end + r] === row[end] && r < 255) r++;
        if (r >= minRun) break;
        end += r;
      }
      const lit = row.slice(x, end);
      if (lit.length >= 3) ops.push({ op: 'abs', idx: lit });
      else if (bpp === 8) for (const v of lit) ops.push({ op: 'run', n: 1, idx: v });
      else for (let k = 0; k < lit.length; k += 2) {
        if (k + 1 < lit.length) ops.push({ op: 'run', n: 2, idx: [lit[k], lit[k + 1]] });
        else ops.push({ op: 'run', n: 1, idx: lit[k] });
      }
      x = end;
    }
    ops.push({ op: fileRow === h - 1 ? 'eob' : 'eol' });
  }
  return ops;
}

// ---- the writer -------------------------------------------------------------------------------

const DEFAULT_MASKS = {
  16: { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 },
  32: { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: 0xff000000 },
};

/**
 * @param {BmpSpec} spec
 * @returns {{ bytes: Uint8Array, width: number, height: number, bpp: number,
 *   rgba: Uint8Array|null, written: Uint8Array|null, alphaNonZero: boolean,
 *   rleStatus: string|null, indices: Uint8Array|null, palette: Rgb3[]|null }}
 */
export function buildBmp(spec) {
  const { width: w, height: h, bpp } = spec;
  const header = spec.header ?? 40;
  const compression = spec.compression ?? 'rgb';
  const isRle = compression === 'rle8' || compression === 'rle4';
  const indexed = bpp <= 8;
  const bitfields = compression === 'bitfields';
  if (header === 12 && (![1, 4, 8, 24].includes(bpp) || compression !== 'rgb' || spec.topDown))
    throw new Error('OS/2 core header: 1/4/8/24 bpp, uncompressed, bottom-up only');
  if (isRle && (spec.topDown || bpp !== (compression === 'rle8' ? 8 : 4) || header === 12))
    throw new Error('RLE needs a matching 8/4 bpp, bottom-up, header >= 40');
  if (bitfields && ((bpp !== 16 && bpp !== 32) || header === 12)) throw new Error('BITFIELDS is 16/32 bpp');

  const palette = indexed ? (spec.palette ?? makePalette(1 << bpp)) : [];
  if (palette.length > 1 << bpp) throw new Error('palette longer than 2^bpp');
  const idx = indexed ? (spec.indices ?? patternIndices(w, h, palette.length)) : null;
  const src = indexed ? null : (spec.rgba ?? gradientRgba(w, h));

  /** @type {{r:number,g:number,b:number,a:number}|null} */
  let masks = null;
  if (bpp === 16 || bpp === 32) {
    const d = DEFAULT_MASKS[bpp];
    masks = { r: d.r, g: d.g, b: d.b, a: d.a, ...(spec.masks ?? {}) };
    if (bitfields && !spec.masks && bpp === 16) masks = { r: 0xf800, g: 0x07e0, b: 0x001f, a: 0 };
  }

  // Pixel data. `outRgba` is built top-down while encoding.
  const outRgba = new Uint8Array(w * h * 4);
  const outWritten = new Uint8Array(w * h).fill(1);
  const outIdx = new Uint8Array(w * h);
  let alphaNonZero = false;
  /** @type {string|null} */
  let rleStatus = null;
  const pix = new ByteWriter(Math.max(64, stride(bpp, w) * h));

  const lit = (/** @type {number} */ o, /** @type {number[]} */ c) => {
    outRgba[o] = c[0]; outRgba[o + 1] = c[1]; outRgba[o + 2] = c[2]; outRgba[o + 3] = 255;
  };

  if (isRle) {
    const ops = spec.rle ?? autoRle(/** @type {ArrayLike<number>} */ (idx), w, h, /** @type {4|8} */ (bpp));
    let stream = encodeRle(ops, /** @type {4|8} */ (bpp));
    if (spec.truncateRle !== undefined) stream = stream.slice(0, spec.truncateRle);
    const dec = decodeRle(stream, w, h, /** @type {4|8} */ (bpp));
    rleStatus = dec.status;
    outWritten.fill(0);
    for (let fileRow = 0; fileRow < h; fileRow++) {
      const top = h - 1 - fileRow;
      for (let x = 0; x < w; x++) {
        if (!dec.written[fileRow * w + x]) continue;
        const v = dec.indices[fileRow * w + x];
        if (v >= palette.length) throw new Error(`rle index ${v} outside the ${palette.length}-entry palette`);
        lit((top * w + x) * 4, palette[v]);
        outWritten[top * w + x] = 1;
        outIdx[top * w + x] = v;
      }
    }
    pix.bytes(stream);
  } else {
    const rowBytes = stride(bpp, w);
    for (let r = 0; r < h; r++) {
      const y = spec.topDown ? r : h - 1 - r;
      const start = pix.length;
      if (indexed) {
        let acc = 0;
        let nbits = 0;
        for (let x = 0; x < w; x++) {
          const v = /** @type {ArrayLike<number>} */ (idx)[y * w + x];
          if (v >= palette.length) throw new Error(`index ${v} outside the ${palette.length}-entry palette`);
          lit((y * w + x) * 4, palette[v]);
          outIdx[y * w + x] = v;
          acc = (acc << bpp) | v;
          nbits += bpp;
          if (nbits === 8) { pix.u8(acc); acc = 0; nbits = 0; }
        }
        if (nbits) pix.u8(acc << (8 - nbits));
      } else {
        const s = /** @type {Uint8Array} */ (src);
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          const rr = s[o], gg = s[o + 1], bb = s[o + 2], aa = s[o + 3];
          if (bpp === 24) {
            pix.u8(bb).u8(gg).u8(rr);
            lit(o, [rr, gg, bb]);
          } else if (bitfields || bpp === 16) {
            const m = /** @type {NonNullable<typeof masks>} */ (masks);
            const mm = bitfields ? m : { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 };
            const gr = maskGeometry(mm.r), gg_ = maskGeometry(mm.g), gb = maskGeometry(mm.b), ga = maskGeometry(mm.a);
            for (const g of [gr, gg_, gb, ga]) if (g.bits > 8) throw new Error('channel wider than 8 bits');
            const q = (/** @type {number} */ c, /** @type {{shift:number,bits:number}} */ g) => (g.bits ? c >>> (8 - g.bits) : 0);
            const qa = spec.alpha === 'source' ? q(aa, ga) : 0;
            const word = ((q(rr, gr) << gr.shift) | (q(gg, gg_) << gg_.shift) | (q(bb, gb) << gb.shift) | (qa << ga.shift)) >>> 0;
            if (bpp === 16) pix.u16(word); else pix.u32(word);
            if (qa) alphaNonZero = true;
            lit(o, [widenTo8(q(rr, gr), gr.bits), widenTo8(q(gg, gg_), gg_.bits), widenTo8(q(bb, gb), gb.bits)]);
          } else {
            // 32 bpp BI_RGB: B, G, R, then a byte GDI ignores
            const ab = spec.alpha === 'source' ? aa : 0;
            pix.u8(bb).u8(gg).u8(rr).u8(ab);
            if (ab) alphaNonZero = true;
            lit(o, [rr, gg, bb]);
          }
        }
      }
      pix.pad(rowBytes - (pix.length - start));
    }
  }
  const pixelBytes = spec.headerOnly ? new Uint8Array(0) : pix.toBytes();

  // Headers.
  const palBytes = header === 12 ? 3 : 4;
  const masksInline = header >= 52; // V2+ carry the masks inside the header
  const maskBlock = header === 40 && bitfields ? 12 : 0; // plain INFOHEADER: three masks follow it
  const palSize = indexed ? palette.length * palBytes : 0;
  const offBits = 14 + header + maskBlock + palSize;
  const out = new ByteWriter(offBits + pixelBytes.length);
  out.ascii('BM').u32(offBits + pixelBytes.length).u32(0).u32(offBits);
  const dw = spec.declare?.width ?? w;
  const dh = spec.declare?.height ?? h;
  out.u32(header);
  if (header === 12) {
    out.u16(dw).u16(dh).u16(1).u16(bpp);
  } else {
    out.i32(dw).i32(spec.topDown ? -dh : dh).u16(1).u16(bpp);
    out.u32({ rgb: 0, rle8: 1, rle4: 2, bitfields: 3 }[compression]);
    out.u32(isRle ? pixelBytes.length : bitfields || header > 40 ? 0 : pixelBytes.length);
    out.u32(2835).u32(2835);
    out.u32(spec.clrUsed ?? (indexed && palette.length < 1 << bpp ? palette.length : 0));
    out.u32(0);
    if (masksInline) {
      const m = masks ?? { r: 0, g: 0, b: 0, a: 0 };
      out.u32(m.r).u32(m.g).u32(m.b);
      if (header >= 56) out.u32(m.a);
      if (header >= 108) {
        // CSType, endpoints, gamma. V5 says sRGB; V4 says calibrated-RGB with zero endpoints because
        // sips (ImageIO) refuses a V4 header that says sRGB or 'Win ' but takes it as 0.
        out.u32(header === 124 ? CS_SRGB : 0).pad(36).pad(12);
        if (header === 124) out.u32(4).u32(0).u32(0).u32(0); // intent, profile data, size, reserved
      }
    } else if (maskBlock) {
      const m = /** @type {NonNullable<typeof masks>} */ (masks);
      out.u32(m.r).u32(m.g).u32(m.b);
    }
  }
  for (const [r, g, b] of palette) {
    out.u8(b).u8(g).u8(r);
    if (palBytes === 4) out.u8(0);
  }
  out.bytes(pixelBytes);

  const lies = spec.declare && (dw !== w || dh !== h);
  const gone = lies || spec.headerOnly;
  return {
    bytes: out.toBytes(),
    width: dw,
    height: dh,
    bpp,
    rgba: gone ? null : outRgba,
    written: gone ? null : outWritten,
    alphaNonZero,
    rleStatus,
    indices: indexed && !gone ? outIdx : null,
    palette: indexed ? palette : null,
  };
}

// ---- the catalogue ----------------------------------------------------------------------------

/**
 * `ref` says which independent decoders must agree with the writer on a case: `sips` opens it with
 * the right dimensions, `sipsPixels` decodes it to the expected pixels (via `sips -s format png`),
 * `pil` (Pillow) decodes it to the expected pixels within `pilTolerance` per channel, compared on
 * `written` pixels only. A false flag is a gap in that decoder, not a writer defect, and the reason
 * is in `refNote`. Measured on macOS sips-316 and Pillow 12.3.
 * @typedef {{ sips: boolean, sipsPixels: boolean, pil: boolean, pilTolerance?: number }} RefFlags
 */

/** @param {BmpSpec} spec @param {Partial<RefFlags>} [ref] @param {string} [refNote] */
const make = (spec, ref = {}, refNote = '') => () => ({
  ...buildBmp(spec),
  spec,
  ref: { sips: true, sipsPixels: true, pil: true, ...ref },
  refNote,
  valid: true,
});

/** @param {BmpSpec} spec @param {string} why */
const bad = (spec, why) => () => ({
  ...buildBmp(spec),
  spec,
  ref: { sips: false, sipsPixels: false, pil: false },
  refNote: why,
  valid: false,
});

const pal = makePalette;
const idxPat = patternIndices;

/** @type {RleOp[]} */
const RLE8_DELTA = [
  { op: 'run', n: 3, idx: 1 }, { op: 'delta', dx: 2, dy: 0 }, { op: 'run', n: 3, idx: 2 }, { op: 'eol' },
  { op: 'abs', idx: [3, 4, 5] }, { op: 'delta', dx: 0, dy: 1 }, { op: 'run', n: 2, idx: 6 }, { op: 'eol' },
  { op: 'abs', idx: [7, 8, 9, 10, 11] }, { op: 'run', n: 3, idx: 12 }, { op: 'eol' },
  { op: 'run', n: 8, idx: 13 }, { op: 'eob' },
];

/** @type {RleOp[]} */
const RLE4_DELTA = [
  { op: 'run', n: 3, idx: 1 }, { op: 'delta', dx: 2, dy: 0 }, { op: 'run', n: 3, idx: [2, 3] }, { op: 'eol' },
  { op: 'abs', idx: [4, 5, 6, 7] }, { op: 'delta', dx: 0, dy: 1 }, { op: 'run', n: 2, idx: 7 }, { op: 'eol' },
  { op: 'abs', idx: [8, 9, 10, 11] }, { op: 'run', n: 4, idx: [13, 14] }, { op: 'eol' },
  { op: 'run', n: 8, idx: 15 }, { op: 'eob' },
];

/** @type {Array<[string, string, () => any]>} */
const defs = [
  // uncompressed, each depth, odd widths so every row-padding amount occurs
  ['1bpp-w9', 'one-bit, 9 wide: two bytes of data and two of padding per row', make({ width: 9, height: 5, bpp: 1, palette: pal(2) })],
  ['1bpp-w1', 'one-bit, one pixel', make({ width: 1, height: 1, bpp: 1, palette: pal(2) })],
  ['1bpp-w32', 'one-bit, a row that fills its dword exactly', make({ width: 32, height: 3, bpp: 1, palette: pal(2) })],
  ['4bpp-w7', 'four-bit, odd width', make({ width: 7, height: 5, bpp: 4, palette: pal(16) })],
  ['4bpp-w1', 'four-bit, one pixel (high nibble only)', make({ width: 1, height: 3, bpp: 4, palette: pal(16) })],
  ['8bpp-w3', '256-colour, width 3 (one pad byte)', make({ width: 3, height: 4, bpp: 8, palette: pal(256), indices: idxPat(3, 4, 256) })],
  ['8bpp-w1', '256-colour, width 1 (three pad bytes)', make({ width: 1, height: 4, bpp: 8, palette: pal(256), indices: idxPat(1, 4, 256) })],
  ['8bpp-w16-topdown', '256-colour, top-down', make({ width: 16, height: 5, bpp: 8, palette: pal(256), indices: idxPat(16, 5, 256), topDown: true })],
  ['16bpp-x1r5g5b5-w5', '16-bit BI_RGB is X1R5G5B5 (D3)', make({ width: 5, height: 4, bpp: 16 }, { sipsPixels: false, pilTolerance: 1 }, 'sips widens 5 bits by shifting (max difference 7); Pillow uses x*255/31 (max difference 1); the writer replicates bits')],
  ['16bpp-bitfields-565-w5', '16-bit BI_BITFIELDS, 5-6-5, masks after the INFOHEADER', make({ width: 5, height: 4, bpp: 16, compression: 'bitfields' }, { sipsPixels: false, pilTolerance: 1 }, 'see 16bpp-x1r5g5b5-w5')],
  ['16bpp-bitfields-555-w3-topdown', '16-bit BI_BITFIELDS with the 5-5-5 masks, top-down', make({ width: 3, height: 3, bpp: 16, compression: 'bitfields', masks: { r: 0x7c00, g: 0x03e0, b: 0x001f }, topDown: true }, { sipsPixels: false, pilTolerance: 1 }, 'see 16bpp-x1r5g5b5-w5')],
  ['24bpp-w1', '24-bit, width 1 (one pad byte)', make({ width: 1, height: 3, bpp: 24 })],
  ['24bpp-w3', '24-bit, width 3 (three pad bytes)', make({ width: 3, height: 3, bpp: 24 })],
  ['24bpp-w5', '24-bit, width 5', make({ width: 5, height: 4, bpp: 24 })],
  ['24bpp-topdown', '24-bit, top-down', make({ width: 7, height: 4, bpp: 24, topDown: true })],
  ['32bpp-alpha-zero', '32-bit BI_RGB, alpha byte 0 everywhere (the Winamp sheets, wsz 3.1)', make({ width: 5, height: 3, bpp: 32 })],
  ['32bpp-alpha-nonzero', '32-bit BI_RGB with real alpha bytes: D3 forces 255 and logs one diagnostic', make({ width: 5, height: 3, bpp: 32, alpha: 'source' })],
  ['32bpp-bitfields-argb', '32-bit BI_BITFIELDS with an alpha mask (source alpha written, still forced to 255)', make({ width: 4, height: 3, bpp: 32, compression: 'bitfields', alpha: 'source' })],
  ['32bpp-topdown', '32-bit, top-down', make({ width: 4, height: 3, bpp: 32, topDown: true })],
  // palettes
  ['4bpp-short-palette', 'four-bit with a 5-entry palette and biClrUsed = 5', make({ width: 6, height: 3, bpp: 4, palette: pal(5), indices: idxPat(6, 3, 5) })],
  ['8bpp-short-palette', 'eight-bit with a 16-entry palette and biClrUsed = 16', make({ width: 6, height: 4, bpp: 8, palette: pal(16), indices: idxPat(6, 4, 16) })],
  ['8bpp-short-palette-clrused0', 'eight-bit, 16 palette entries on disk but biClrUsed = 0 (reads as 256); bfOffBits is the truth', make({ width: 6, height: 4, bpp: 8, palette: pal(16), indices: idxPat(6, 4, 16), clrUsed: 0 }, { sipsPixels: false }, 'sips sizes the palette from biClrUsed (0 means 256) and mis-reads the pixels; Pillow and the writer follow bfOffBits')],
  // header variants
  ['os2-core-1bpp', 'OS/2 core header, 1 bpp', make({ width: 9, height: 4, bpp: 1, header: 12, palette: pal(2) })],
  ['os2-core-4bpp', 'OS/2 core header, 4 bpp', make({ width: 5, height: 4, bpp: 4, header: 12, palette: pal(16) })],
  ['os2-core-8bpp', 'OS/2 core header, 8 bpp, 3-byte palette entries', make({ width: 5, height: 4, bpp: 8, header: 12, palette: pal(256), indices: idxPat(5, 4, 256) })],
  ['os2-core-24bpp', 'OS/2 core header, 24 bpp', make({ width: 5, height: 4, bpp: 24, header: 12 })],
  ['v2-16bpp-565', 'BITMAPV2INFOHEADER (52), masks inside the header', make({ width: 5, height: 4, bpp: 16, header: 52, compression: 'bitfields' }, { sipsPixels: false, pilTolerance: 1 }, 'see 16bpp-x1r5g5b5-w5')],
  ['v3-32bpp-bitfields', 'BITMAPV3INFOHEADER (56) with the alpha mask', make({ width: 4, height: 3, bpp: 32, header: 56, compression: 'bitfields', alpha: 'source' })],
  ['v4-32bpp', 'BITMAPV4HEADER (108), BI_RGB 32 bpp', make({ width: 4, height: 3, bpp: 32, header: 108 })],
  ['v4-16bpp-565', 'BITMAPV4HEADER, 16-bit BI_BITFIELDS 5-6-5', make({ width: 5, height: 4, bpp: 16, header: 108, compression: 'bitfields' }, { sipsPixels: false, pilTolerance: 1 }, 'see 16bpp-x1r5g5b5-w5')],
  ['v4-8bpp', 'BITMAPV4HEADER, 8 bpp', make({ width: 5, height: 4, bpp: 8, header: 108, palette: pal(256), indices: idxPat(5, 4, 256) })],
  ['v5-24bpp', 'BITMAPV5HEADER (124), 24 bpp', make({ width: 5, height: 4, bpp: 24, header: 124 })],
  ['v5-32bpp-bitfields', 'BITMAPV5HEADER, 32 bpp BI_BITFIELDS with alpha', make({ width: 4, height: 3, bpp: 32, header: 124, compression: 'bitfields', alpha: 'source' })],
  // RLE8
  ['rle8-encoded-runs', 'RLE8: only encoded runs, EOL between rows, EOB at the end', make({
    width: 8, height: 4, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 8, idx: 1 }, { op: 'eol' }, { op: 'run', n: 3, idx: 2 }, { op: 'run', n: 5, idx: 3 }, { op: 'eol' },
      { op: 'run', n: 1, idx: 4 }, { op: 'run', n: 7, idx: 5 }, { op: 'eol' }, { op: 'run', n: 8, idx: 6 }, { op: 'eob' }] })],
  ['rle8-absolute-runs', 'RLE8: absolute runs, odd lengths (pad byte) and even', make({
    width: 9, height: 3, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'abs', idx: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { op: 'eol' },
      { op: 'abs', idx: [10, 11, 12, 13] }, { op: 'run', n: 5, idx: 14 }, { op: 'eol' },
      { op: 'run', n: 2, idx: 15 }, { op: 'abs', idx: [16, 17, 18, 19, 20] }, { op: 'run', n: 2, idx: 21 }, { op: 'eob' }] })],
  ['rle8-delta', 'RLE8: delta moves, so some pixels are never written', make({ width: 8, height: 5, bpp: 8, compression: 'rle8', palette: pal(256), rle: RLE8_DELTA }, { sipsPixels: false }, 'sips draws the run after a delta with dy = 1 on the old row; Pillow agrees with the writer')],
  ['rle8-auto-mixed', 'RLE8 auto-encoded from a noisy image with long and short runs', make({
    width: 20, height: 6, bpp: 8, compression: 'rle8', palette: pal(256),
    indices: Uint8Array.from({ length: 120 }, (_, i) => ((i % 20) < 8 ? 3 : (i * 7) % 11) + (i >= 60 ? 40 : 0)) })],
  ['rle8-early-eob', 'RLE8: end-of-bitmap after two of four rows; the rest is unwritten', make({
    width: 6, height: 4, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 6, idx: 1 }, { op: 'eol' }, { op: 'abs', idx: [2, 3, 4, 5, 6, 7] }, { op: 'eob' }] }, { pil: false }, 'Pillow raises "not enough image data" when EOB comes early; sips fills the rest')],
  ['rle8-eol-eob-only-tail', 'RLE8: the last row ends with EOL then EOB (the long form)', make({
    width: 4, height: 2, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 4, idx: 1 }, { op: 'eol' }, { op: 'run', n: 4, idx: 2 }, { op: 'eol' }, { op: 'eob' }] })],
  ['rle8-truncated', 'RLE8: the stream ends mid-bitmap with no EOB; decoded rows stay (D3)', bad({
    width: 8, height: 4, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 8, idx: 1 }, { op: 'eol' }, { op: 'run', n: 8, idx: 2 }, { op: 'eol' }, { op: 'run', n: 8, idx: 3 }, { op: 'eob' }],
    truncateRle: 9 }, 'invalid by design: decoders disagree on partial output')],
  ['rle8-run-overrun', 'RLE8: a run crosses the row end; the image stops there (D3)', bad({
    width: 6, height: 3, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 6, idx: 1 }, { op: 'eol' }, { op: 'run', n: 9, idx: 2 }, { op: 'eol' }, { op: 'run', n: 6, idx: 3 }, { op: 'eob' }] }, 'invalid by design')],
  ['rle8-abs-overrun', 'RLE8: an absolute run crosses the row end', bad({
    width: 5, height: 2, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 5, idx: 1 }, { op: 'eol' }, { op: 'abs', idx: [1, 2, 3, 4, 5, 6, 7] }, { op: 'eob' }] }, 'invalid by design')],
  ['rle8-delta-out-of-range', 'RLE8: a delta jumps past the last row', bad({
    width: 5, height: 2, bpp: 8, compression: 'rle8', palette: pal(256), rle: [
      { op: 'run', n: 5, idx: 1 }, { op: 'delta', dx: 0, dy: 9 }, { op: 'run', n: 2, idx: 2 }, { op: 'eob' }] }, 'invalid by design')],
  // RLE4
  ['rle4-encoded-runs', 'RLE4: encoded runs, including odd counts that end on a high nibble', make({
    width: 9, height: 4, bpp: 4, compression: 'rle4', palette: pal(16), rle: [
      { op: 'run', n: 9, idx: 1 }, { op: 'eol' }, { op: 'run', n: 5, idx: [2, 3] }, { op: 'run', n: 4, idx: [4, 5] }, { op: 'eol' },
      { op: 'run', n: 1, idx: 6 }, { op: 'run', n: 8, idx: [7, 8] }, { op: 'eol' }, { op: 'run', n: 3, idx: [9, 10] }, { op: 'run', n: 6, idx: 11 }, { op: 'eob' }] })],
  ['rle4-absolute-runs', 'RLE4: absolute runs of 3 to 8 pixels (word padding after 1, 3, 5.. data bytes)', make({
    width: 8, height: 6, bpp: 4, compression: 'rle4', palette: pal(16), rle: [
      { op: 'abs', idx: [1, 2, 3] }, { op: 'run', n: 5, idx: 4 }, { op: 'eol' },
      { op: 'abs', idx: [5, 6, 7, 8] }, { op: 'abs', idx: [9, 10, 11, 12] }, { op: 'eol' },
      { op: 'abs', idx: [1, 3, 5, 7, 9] }, { op: 'abs', idx: [2, 4, 6] }, { op: 'eol' },
      { op: 'abs', idx: [13, 14, 15, 1, 2, 3] }, { op: 'run', n: 2, idx: 0 }, { op: 'eol' },
      { op: 'abs', idx: [4, 5, 6, 7, 8, 9, 10] }, { op: 'run', n: 1, idx: 11 }, { op: 'eol' },
      { op: 'abs', idx: [1, 2, 3, 4, 5, 6, 7, 8] }, { op: 'eob' }] }, { pil: false }, 'Pillow mis-decodes odd-length RLE4 absolute runs (drops the last nibble); sips agrees with the writer')],
  ['rle4-delta', 'RLE4: delta moves, some pixels never written', make({ width: 8, height: 5, bpp: 4, compression: 'rle4', palette: pal(16), rle: RLE4_DELTA }, { sipsPixels: false }, 'sips delta quirk, see rle8-delta; the abs runs are even so Pillow decodes them')],
  ['rle4-auto-mixed', 'RLE4 auto-encoded', make({
    width: 21, height: 5, bpp: 4, compression: 'rle4', palette: pal(16),
    indices: Uint8Array.from({ length: 105 }, (_, i) => ((i % 21) < 9 ? 2 : (i * 5) % 7) + (i >= 50 ? 8 : 0)) }, { pil: false }, 'see rle4-absolute-runs')],
  ['rle4-truncated', 'RLE4: the stream ends mid-bitmap', bad({
    width: 8, height: 4, bpp: 4, compression: 'rle4', palette: pal(16), rle: [
      { op: 'run', n: 8, idx: 1 }, { op: 'eol' }, { op: 'abs', idx: [1, 2, 3, 4, 5, 6, 7, 8] }, { op: 'eol' }, { op: 'run', n: 8, idx: 3 }, { op: 'eob' }],
    truncateRle: 9 }, 'invalid by design')],
  // dimension lies and axis caps (D3, §10)
  ['declared-30000x30000-24bpp-header-only', 'a 24-bit header declaring 30000 x 30000 with no pixel data: must be refused from the header, allocating nothing', bad({
    width: 1, height: 1, bpp: 24, declare: { width: 30000, height: 30000 }, headerOnly: true }, 'header-only lie')],
  ['declared-30000x30000-8bpp-header-only', 'the same for 8 bpp, with a palette', bad({
    width: 1, height: 1, bpp: 8, declare: { width: 30000, height: 30000 }, headerOnly: true }, 'header-only lie')],
  ['axis-16384x20-24bpp', 'widest allowed axis: 16,384 x 20 decodes', make({ width: 16384, height: 20, bpp: 24, rgba: gradientRgba(16384, 20) }, { sipsPixels: false }, 'size fixture')],
  ['axis-16385x20-24bpp', 'one past the axis cap: 16,385 x 20 is capped', make({ width: 16385, height: 20, bpp: 24, rgba: gradientRgba(16385, 20) }, { sipsPixels: false, pil: false }, 'valid file; the cap is decoder policy; size fixture')],
  ['axis-20x16385-24bpp', 'the same on the vertical axis', make({ width: 20, height: 16385, bpp: 24, rgba: gradientRgba(20, 16385) }, { sipsPixels: false, pil: false }, 'valid file; the cap is decoder policy; size fixture')],
];

const cat = catalog(defs.map(([id, doc, build]) => ({ id, doc, build: /** @type {any} */ (build) })));

/** Case ids, in catalogue order. */
export const bmpCaseIds = () => cat.ids();
/** @param {string} id one built case: `{id, doc, bytes, width, height, rgba, written, ref, valid, …}` */
export const bmpCase = (id) => cat.get(id);
/** @param {(id: string) => boolean} [filter] */
export const bmpCases = (filter) => cat.all(filter);
