// @ts-check
// Synthetic GIF89a writer (ENGINE D9, D3): multi-frame images, transparency index, the four disposal
// methods, local and global palettes, interlacing, the NETSCAPE2.0 loop extension, comment and
// unknown application extensions, a real variable-width LZW encoder that fills and resets its
// table, and header lies (30000 x 30000, the 512-frame cap).
//
// `buildGif(spec)` returns the bytes plus `canvases`: for each frame, the full-canvas RGBA right
// after that frame was drawn (before its own disposal), using the standard model: the canvas starts
// fully transparent, disposal 2 clears the previous frame's rectangle to transparent (not to the
// background colour, which browsers also ignore), disposal 3 restores the canvas from before the
// previous frame, and a pixel at the transparent index leaves the canvas as it was.
// `canvases[0]` is what phase 1 renders (frame 0, D3).

import { ByteWriter, catalog, noiseBytes } from './bytes.js';

/** @typedef {[number, number, number]} Rgb3 */
/**
 * @typedef {Object} GifFrame
 * @property {ArrayLike<number>} indices  pixel indices of the frame rectangle, row-major, natural row order
 * @property {{x:number,y:number,w:number,h:number}} [rect]  default: the whole canvas
 * @property {number} [delay]             hundredths of a second (default 10)
 * @property {0|1|2|3} [disposal]
 * @property {number|null} [transparent]  transparent palette index
 * @property {Rgb3[]} [palette]           local colour table
 * @property {boolean} [interlaced]
 * @property {boolean} [gce]              false: no graphic control extension for this frame
 */
/**
 * @typedef {Object} GifSpec
 * @property {number} width
 * @property {number} height
 * @property {Rgb3[]|null} [palette]      global colour table (null: none)
 * @property {number} [background]        background colour index
 * @property {GifFrame[]} frames
 * @property {number|null} [loop]         NETSCAPE2.0 loop count (0 = forever); null/undefined: no extension
 * @property {string} [comment]           a comment extension before the first frame
 * @property {boolean} [unknownApp]       an unknown application extension before the first frame
 * @property {{width:number,height:number}} [declare]  logical screen and first image size that lie
 * @property {number} [truncate]          keep only this many bytes of the file
 */

/** Table sizes 2, 4, ... 256: the GIF "size" field is log2(n) - 1. @param {number} n */
const tableBits = (n) => Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/**
 * Variable-width LZW as GIF wants it. Emits a clear code first and again whenever the 4096-entry
 * table fills; the code width grows one code before the table needs it, which is the timing real
 * decoders expect.
 * @param {ArrayLike<number>} px @param {number} minCodeSize @returns {Uint8Array} packed codes
 */
export function lzwEncode(px, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let next = eoi + 1;
  let size = minCodeSize + 1;
  let table = new Map();
  const out = new ByteWriter(Math.max(64, px.length >> 1));
  let cur = 0;
  let nbits = 0;
  const emit = (/** @type {number} */ code, /** @type {number} */ width) => {
    cur |= code << nbits;
    nbits += width;
    while (nbits >= 8) { out.u8(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  emit(clear, size);
  let prefix = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next === 4096) {
      emit(clear, size);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix, size);
  // A decoder adds a table entry when it reads that last code, and widens if the table just filled
  // its current width, before it reads the end code. Mirror that, or the end code is the wrong size.
  if (next >= 1 << size && size < 12) size++;
  emit(eoi, size);
  if (nbits) out.u8(cur & 255);
  return out.toBytes();
}

/** @param {ByteWriter} w @param {Uint8Array} data GIF data sub-blocks of at most 255 bytes, then a terminator */
function subBlocks(w, data) {
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    w.u8(n).bytes(data.subarray(i, i + n));
  }
  w.u8(0);
}

/** @param {number} h @returns {number[]} source row for each interlaced stream row */
function interlaceOrder(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
  return rows;
}

/**
 * @param {GifSpec} spec
 * @returns {{ bytes: Uint8Array, width: number, height: number, frameCount: number,
 *   canvases: Uint8Array[]|null, loop: number|null|undefined, rgba: Uint8Array|null,
 *   frames: Array<{delay:number, disposal:number, transparent:number|null, rect:{x:number,y:number,w:number,h:number}}> }}
 */
export function buildGif(spec) {
  const { width: W, height: H } = spec;
  const gct = spec.palette ?? null;
  const w = new ByteWriter(1024);
  w.ascii('GIF89a');
  w.u16(spec.declare?.width ?? W).u16(spec.declare?.height ?? H);
  const gbits = gct ? tableBits(gct.length) : 0;
  w.u8((gct ? 0x80 : 0) | (7 << 4) | (gct ? gbits - 1 : 0)).u8(spec.background ?? 0).u8(0);
  if (gct) {
    for (let i = 0; i < 1 << gbits; i++) w.bytes(gct[i] ?? [0, 0, 0]);
  }
  if (spec.loop !== undefined && spec.loop !== null) {
    w.u8(0x21).u8(0xff).u8(11).ascii('NETSCAPE2.0').u8(3).u8(1).u16(spec.loop).u8(0);
  }
  if (spec.comment !== undefined) {
    w.u8(0x21).u8(0xfe);
    subBlocks(w, Uint8Array.from(spec.comment, (c) => c.charCodeAt(0)));
  }
  if (spec.unknownApp) {
    w.u8(0x21).u8(0xff).u8(11).ascii('XMP DataXMP').u8(4).ascii('abcd').u8(0);
  }

  /** @type {Uint8Array[]} */
  const canvases = [];
  const meta = [];
  let canvas = new Uint8Array(W * H * 4);
  /** @type {Uint8Array|null} */
  let before = null;
  /** @type {GifFrame|null} */
  let prev = null;
  let prevRect = null;
  let firstImage = true;
  for (const f of spec.frames) {
    const rect = f.rect ?? { x: 0, y: 0, w: W, h: H };
    const table = f.palette ?? gct;
    if (!table) throw new Error('frame has no colour table');
    const disposal = f.disposal ?? 0;
    const transparent = f.transparent ?? null;
    const delay = f.delay ?? 10;
    meta.push({ delay, disposal, transparent, rect });
    if (f.gce !== false) {
      w.u8(0x21).u8(0xf9).u8(4).u8((disposal << 2) | (transparent !== null ? 1 : 0)).u16(delay).u8(transparent ?? 0).u8(0);
    }
    const lbits = f.palette ? tableBits(f.palette.length) : 0;
    w.u8(0x2c).u16(rect.x).u16(rect.y);
    w.u16(firstImage && spec.declare ? spec.declare.width : rect.w).u16(firstImage && spec.declare ? spec.declare.height : rect.h);
    w.u8((f.palette ? 0x80 | (lbits - 1) : 0) | (f.interlaced ? 0x40 : 0));
    firstImage = false;
    if (f.palette) for (let i = 0; i < 1 << lbits; i++) w.bytes(f.palette[i] ?? [0, 0, 0]);
    const minCode = Math.max(2, f.palette ? lbits : gbits);
    const order = f.interlaced ? interlaceOrder(rect.h) : null;
    const stream = order
      ? Array.from({ length: rect.w * rect.h }, (_, i) => f.indices[order[Math.floor(i / rect.w)] * rect.w + (i % rect.w)])
      : f.indices;
    w.u8(minCode);
    subBlocks(w, lzwEncode(stream, minCode));

    // Expected composite: dispose the previous frame, then draw this one.
    if (prev && prevRect) {
      const pd = prev.disposal ?? 0;
      if (pd === 2) {
        for (let y = prevRect.y; y < prevRect.y + prevRect.h; y++)
          for (let x = prevRect.x; x < prevRect.x + prevRect.w; x++)
            if (x < W && y < H) canvas.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 4);
      } else if (pd === 3 && before) {
        canvas = before.slice();
      }
    }
    before = canvas.slice();
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const v = f.indices[y * rect.w + x];
        const cx = rect.x + x, cy = rect.y + y;
        if (v === transparent || cx >= W || cy >= H) continue;
        const c = table[v];
        canvas.set([c[0], c[1], c[2], 255], (cy * W + cx) * 4);
      }
    }
    canvases.push(canvas.slice());
    prev = f;
    prevRect = rect;
  }
  w.u8(0x3b);
  let bytes = w.toBytes();
  if (spec.truncate !== undefined) bytes = bytes.slice(0, spec.truncate);
  const lies = spec.declare && (spec.declare.width !== W || spec.declare.height !== H);
  return {
    bytes,
    width: spec.declare?.width ?? W,
    height: spec.declare?.height ?? H,
    frameCount: spec.frames.length,
    canvases: lies || spec.truncate !== undefined ? null : canvases,
    rgba: lies || spec.truncate !== undefined ? null : canvases[0] ?? null,
    loop: spec.loop,
    frames: meta,
  };
}

// ---- the catalogue ----------------------------------------------------------------------------

/** @param {number} n @returns {Rgb3[]} */
const palette = (n) => Array.from({ length: n }, (_, i) => /** @type {Rgb3} */ ([(i * 67 + 30) & 255, (i * 131 + 7) & 255, (i * 29 + 90) & 255]));
/** @param {number} w @param {number} h @param {number} n @param {number} [seed] */
const pat = (w, h, n, seed = 0) => Uint8Array.from({ length: w * h }, (_, i) => ((i % w) * 3 + Math.floor(i / w) * 5 + seed) % n);

/**
 * `ref.pil` says Pillow reproduces every composited frame (a gap flag, not a writer defect).
 * @param {GifSpec} spec @param {{pil?:boolean}} [ref] @param {string} [note]
 */
const ok = (spec, ref = {}, note = '') => () => ({ ...buildGif(spec), spec, valid: true, ref: { sips: true, pil: true, ...ref }, note });
/** @param {GifSpec} spec @param {string} note */
const wrong = (spec, note) => () => ({ ...buildGif(spec), spec, valid: false, ref: { sips: false, pil: false }, note });

/** @param {number} n 1x1 frames cycling through four colours */
const manyFrames = (n) => ({
  width: 1, height: 1, palette: palette(4), loop: 0,
  frames: Array.from({ length: n }, (_, i) => ({ indices: [i % 4], delay: 2 })),
});

// A 6 x 6 canvas with frames that overlap, so each disposal method leaves a different canvas.
/** @param {0|1|2|3} d @returns {GifSpec} */
const disposalSpec = (d) => ({
  width: 6, height: 6, palette: palette(8), loop: 0,
  frames: [
    // Index 7 is declared transparent but never used, so each frame has a transparency index:
    // without one, Pillow fills a disposed rectangle with the background colour, not transparent.
    { indices: pat(6, 6, 4, 0), transparent: 7, disposal: d },
    { indices: Uint8Array.from([5, 5, 5, 5, 0, 5, 5, 5, 5]), rect: { x: 1, y: 1, w: 3, h: 3 }, transparent: 0, disposal: d },
    { indices: Uint8Array.from([6, 6, 6, 6, 6, 6]), rect: { x: 3, y: 4, w: 3, h: 2 }, transparent: 7, disposal: d },
  ],
});

/** @type {Array<{id:string, doc:string, build:() => any}>} */
const defs = [
  { id: 'single-4x4', doc: 'one 4 x 4 frame, 4-colour global palette', build: ok({ width: 4, height: 4, palette: palette(4), frames: [{ indices: pat(4, 4, 4) }] }) },
  { id: 'single-no-gce', doc: 'one frame with no graphic control extension', build: ok({ width: 5, height: 3, palette: palette(4), frames: [{ indices: pat(5, 3, 4), gce: false }] }) },
  { id: 'palette-2', doc: 'two colours: minimum code size is still 2', build: ok({ width: 9, height: 3, palette: palette(2), frames: [{ indices: pat(9, 3, 2) }] }) },
  { id: 'palette-16', doc: 'sixteen colours, min code size 4', build: ok({ width: 9, height: 5, palette: palette(16), frames: [{ indices: pat(9, 5, 16) }] }) },
  { id: 'palette-256', doc: '256 colours, min code size 8', build: ok({ width: 20, height: 13, palette: palette(256), frames: [{ indices: pat(20, 13, 256, 7) }] }) },
  { id: 'palette-3-padded', doc: 'three colours: the table is padded to 4 entries', build: ok({ width: 5, height: 4, palette: palette(3), frames: [{ indices: pat(5, 4, 3) }] }) },
  { id: 'transparent-index', doc: 'transparency index 1: those pixels come out alpha 0', build: ok({ width: 6, height: 5, palette: palette(4), frames: [{ indices: pat(6, 5, 4), transparent: 1 }] }) },
  { id: 'interlaced', doc: 'one interlaced frame, 7 x 11 (all four passes occupied)', build: ok({ width: 7, height: 11, palette: palette(8), frames: [{ indices: pat(7, 11, 8), interlaced: true }] }) },
  { id: 'multi-3-no-loop', doc: 'three full frames, no NETSCAPE extension', build: ok({ width: 4, height: 4, palette: palette(8), frames: [0, 1, 2].map((s) => ({ indices: pat(4, 4, 8, s * 3), delay: 5 + s })) }) },
  { id: 'netscape-loop-forever', doc: 'NETSCAPE2.0 with loop count 0 (forever)', build: ok({ width: 4, height: 4, palette: palette(8), loop: 0, frames: [0, 1].map((s) => ({ indices: pat(4, 4, 8, s), delay: 7 })) }) },
  { id: 'netscape-loop-3', doc: 'NETSCAPE2.0 with loop count 3', build: ok({ width: 4, height: 4, palette: palette(8), loop: 3, frames: [0, 1].map((s) => ({ indices: pat(4, 4, 8, s), delay: 7 })) }) },
  { id: 'disposal-0-unspecified', doc: 'three overlapping frames, disposal 0', build: ok(disposalSpec(0)) },
  { id: 'disposal-1-keep', doc: 'three overlapping frames, disposal 1 (leave in place)', build: ok(disposalSpec(1)) },
  { id: 'disposal-2-background', doc: 'three overlapping frames, disposal 2 (clear to transparent)', build: ok(disposalSpec(2)) },
  { id: 'disposal-3-previous', doc: 'three overlapping frames, disposal 3 (restore previous)', build: ok(disposalSpec(3)) },
  {
    id: 'local-palettes',
    doc: 'no global table; every frame has its own local palette of a different size',
    build: ok({ width: 5, height: 4, palette: null, loop: 0, frames: [
      { indices: pat(5, 4, 4), palette: palette(4) },
      { indices: pat(5, 4, 16, 1), palette: palette(16).reverse() },
      { indices: pat(5, 4, 2), palette: palette(2), interlaced: true },
    ] }),
  },
  {
    id: 'first-frame-subrect',
    doc: 'the first frame covers only part of the canvas; the rest of frame 0 stays transparent',
    build: ok({ width: 8, height: 6, palette: palette(4), frames: [
      { indices: pat(4, 3, 4), rect: { x: 2, y: 1, w: 4, h: 3 } },
      { indices: pat(8, 6, 4, 2) },
    ] }, { pil: false }, 'Pillow places a partial first frame on a background-coloured canvas; the writer model is transparent'),
  },
  { id: 'lzw-table-full-256', doc: 'noise over 256 colours: the 4096-entry table fills and the encoder emits a clear code mid-stream', build: ok({ width: 100, height: 100, palette: palette(256), frames: [{ indices: noiseBytes(10000, 5) }] }) },
  { id: 'lzw-table-full-4', doc: 'random 4-colour data: codes reach 12 bits and the table resets at min code size 2', build: ok({ width: 200, height: 150, palette: palette(4), frames: [{ indices: noiseBytes(30000, 6).map((v) => v & 3) }] }) },
  { id: 'lzw-width-12-no-reset', doc: '3000 random 256-colour pixels: codes reach 12 bits but the 4096-entry table never fills', build: ok({ width: 60, height: 50, palette: palette(256), frames: [{ indices: noiseBytes(3000, 7) }] }) },
  { id: 'comment-and-unknown-extension', doc: 'a comment extension and an unknown application extension precede frame 0', build: ok({ width: 4, height: 4, palette: palette(4), comment: 'synthetic fixture', unknownApp: true, frames: [{ indices: pat(4, 4, 4) }] }) },
  { id: 'frames-3', doc: 'three 1 x 1 frames with delay 2 (a counting baseline)', build: ok(manyFrames(3)) },
  { id: 'frames-512', doc: '512 frames: exactly the frame cap (§10)', build: ok(manyFrames(512)) },
  { id: 'frames-513', doc: '513 frames: one over the cap', build: ok(manyFrames(513)) },
  { id: 'frames-600', doc: '600 frames: a decoder capped at 512 stops early without throwing', build: ok(manyFrames(600)) },
  { id: 'axis-16384x20', doc: '16,384 x 20, the widest allowed axis', build: ok({ width: 16384, height: 20, palette: palette(16), frames: [{ indices: pat(16384, 20, 16) }] }) },
  { id: 'axis-16385x20', doc: '16,385 x 20: one past the axis cap', build: ok({ width: 16385, height: 20, palette: palette(16), frames: [{ indices: pat(16385, 20, 16) }] }, {}, 'valid file; the cap is decoder policy') },
  { id: 'axis-20x16385', doc: '20 x 16,385: one past the axis cap, vertical', build: ok({ width: 20, height: 16385, palette: palette(16), frames: [{ indices: pat(20, 16385, 16) }] }, {}, 'valid file; the cap is decoder policy') },
  { id: 'declared-30000x30000', doc: 'logical screen and image descriptor say 30000 x 30000 over a 1 x 1 data stream', build: wrong({ width: 1, height: 1, palette: palette(4), declare: { width: 30000, height: 30000 }, frames: [{ indices: [1] }] }, 'header lie') },
  { id: 'truncated-mid-frame', doc: 'a three-frame file cut in the middle of frame 1', build: wrong({ width: 8, height: 8, palette: palette(8), frames: [0, 1, 2].map((s) => ({ indices: pat(8, 8, 8, s) })), truncate: 120 }, 'truncated') },
];

const cat = catalog(defs);
export const gifCaseIds = () => cat.ids();
/** @param {string} id */
export const gifCase = (id) => cat.get(id);
/** @param {(id: string) => boolean} [filter] */
export const gifCases = (filter) => cat.all(filter);
