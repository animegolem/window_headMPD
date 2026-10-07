// @ts-check
// GIF decoder (ENGINE D3): own LZW, frames, disposal, transparency index. Phase 1 renders frame 0;
// the later frames are kept for phase 3.
//
// - `data` is frame 0 composited on a transparent canvas the size `readGifHeader` reports (the
//   logical screen, grown to hold the first frame). `frames` exists only for an animation (two
//   frames or more): one full-canvas composite per frame, taken right after that frame was drawn
//   and before its own disposal, and `frames[0].data` is the same array as `data`. `delayMs` is the
//   file's delay times ten, unclamped.
// - Disposal 2 clears the previous frame's rectangle to transparent (not to the background colour,
//   which browsers also ignore), disposal 3 restores the canvas from before that frame was drawn,
//   and a pixel at the transparency index leaves the canvas as it was.
// - At most `maxGifFrames` frames are read (512 by default). Frames also stop at a memory budget of
//   128 MiB, so a huge canvas with hundreds of frames cannot cost what the area cap would never
//   allow for one image. Either stop adds a diagnostic.
// - A rectangle that pokes out of the canvas is clipped; pixels are written straight into the
//   canvas, so a frame that claims 65,535 x 65,535 allocates nothing for the claim.
// - Truncation keeps what was decoded: the frames before the break, and the rows of frame 0 that
//   arrived. A first frame with no pixels at all is a failed decode.

import { readGifHeader, skipSubBlocks, withinCaps } from '../probe.js';
import { u16le } from './binary.js';

/** @typedef {import('../../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').ImageCaps} ImageCaps */

/** Bytes of retained frame composites beyond which later frames are dropped. */
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

/**
 * @param {Diagnostic[]} diags @param {string} code @param {string} detail
 * @returns {null}
 */
function fail(diags, code, detail) {
  diags.push({ code, detail, severity: 'warn' });
  return null;
}

/** Source row of each row of the interlaced stream. @param {number} h */
function interlaceRows(h) {
  const rows = new Uint32Array(h);
  let n = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows[n++] = y;
  return rows;
}

/**
 * Decode one frame's LZW stream straight into the canvas.
 * @param {Uint8Array} src packed codes, sub-block framing already removed
 * @param {number} minCode
 * @param {Uint8Array} bytes the file, for the colour table
 * @param {number} tableAt offset of the colour table
 * @param {number} tableEntries
 * @param {number} transparent palette index to skip, or -1
 * @param {{ left: number, top: number, w: number, h: number, interlaced: boolean }} rect
 * @param {Uint8ClampedArray} canvas @param {number} W @param {number} H
 * @returns {number} pixels of the frame that were decoded
 */
function drawFrame(src, minCode, bytes, tableAt, tableEntries, transparent, rect, canvas, W, H) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  const { left, top, w: fw, h: fh } = rect;
  const rowMap = rect.interlaced ? interlaceRows(fh) : null;
  const total = fw * fh;
  // Rows of a plain frame below the canvas can never be seen, so a frame that claims a huge height
  // stops being decoded where the canvas ends instead of burning time on pixels nobody will see.
  const limit = rowMap ? total : Math.min(total, Math.max(0, H - top) * fw);

  let size = minCode + 1;
  let next = eoi + 1;
  let old = -1;
  let first = 0;
  let acc = 0;
  let bits = 0;
  let at = 0;
  let px = 0; // pixels of the frame consumed so far
  let fx = 0;
  let fy = 0; // row of the stream
  /** @param {number} v */
  const put = (v) => {
    if (px < total) {
      const row = rowMap ? rowMap[fy] : fy;
      const cx = left + fx;
      const cy = top + row;
      if (v !== transparent && cx < W && cy < H && v < tableEntries) {
        const p = (cy * W + cx) * 4;
        const t = tableAt + v * 3;
        canvas[p] = bytes[t];
        canvas[p + 1] = bytes[t + 1];
        canvas[p + 2] = bytes[t + 2];
        canvas[p + 3] = 255;
      } else if (v !== transparent && cx < W && cy < H) {
        const p = (cy * W + cx) * 4; // an index past the table paints black
        canvas[p] = 0;
        canvas[p + 1] = 0;
        canvas[p + 2] = 0;
        canvas[p + 3] = 255;
      }
      px++;
      if (++fx === fw) { fx = 0; fy++; }
    }
  };

  for (;;) {
    while (bits < size) {
      if (at >= src.length) return px; // ran out of data: keep what we have
      acc |= src[at++] << bits;
      bits += 8;
    }
    let code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) { size = minCode + 1; next = eoi + 1; old = -1; continue; }
    if (code === eoi) return px;
    if (px >= limit) return total; // the frame is full (or the rest is off the canvas); ignore any trailing codes
    if (old === -1) {
      if (code >= clear) return px;
      put(code);
      old = code;
      first = code;
      continue;
    }
    const inCode = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) return px; // a code the table cannot have produced yet
      stack[sp++] = first; // KwKwK: the string is the previous one plus its own first byte
      code = old;
    }
    while (code >= clear) { stack[sp++] = suffix[code]; code = prefix[code]; }
    first = code;
    stack[sp++] = first;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    old = inCode;
    while (sp > 0) put(stack[--sp]);
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {ImageCaps} caps
 * @param {Diagnostic[]} diags
 * @returns {RgbaImage | null}
 */
export function decodeGif(bytes, caps, diags) {
  const len = bytes.length;
  const head = readGifHeader(bytes);
  if (!head) return fail(diags, 'image-corrupt', 'GIF has no image');
  const W = head.width;
  const H = head.height;
  // Before any allocation: the screen descriptor may claim anything.
  if (!withinCaps(W, H, caps)) return fail(diags, 'image-over-cap', `GIF ${W} x ${H} exceeds ${caps.maxAxis} per axis or ${caps.maxArea} pixels`);

  const globalEntries = head.tableEntries;
  const canvas = new Uint8ClampedArray(W * H * 4);
  /** @type {{ data: Uint8ClampedArray, delayMs: number }[]} */
  const frames = [];
  const frameBytes = W * H * 4;
  let retained = 0;
  let pos = 13 + globalEntries * 3;
  let transparent = -1;
  let disposal = 0;
  let delay = 0;
  /** @type {{ disposal: number, left: number, top: number, w: number, h: number } | null} */
  let prev = null;
  /** @type {Uint8ClampedArray | null} */
  let restore = null;
  let drawn = false; // a frame is on the canvas and has not been copied into `frames` yet
  let drawnDelay = 0;
  let stop = false;

  /** Copy the canvas into `frames`, honouring the memory budget. @returns {boolean} false when the budget is spent */
  const snapshot = () => {
    if (!drawn) return true;
    drawn = false;
    if (frames.length > 0 && retained + frameBytes > MAX_FRAME_BYTES) return false;
    frames.push({ data: canvas.slice(), delayMs: drawnDelay });
    retained += frameBytes;
    return true;
  };

  while (pos < len && !stop) {
    const c = bytes[pos];
    if (c === 0x21) {
      if (bytes[pos + 1] === 0xf9 && bytes[pos + 2] === 4 && pos + 8 <= len) {
        const packed = bytes[pos + 3];
        disposal = (packed >> 2) & 7;
        delay = u16le(bytes, pos + 4);
        transparent = packed & 1 ? bytes[pos + 6] : -1;
      }
      pos = skipSubBlocks(bytes, pos + 2);
      if (pos < 0) break;
    } else if (c === 0x2c) {
      if (pos + 10 > len) break;
      if (frames.length + (drawn ? 1 : 0) >= caps.maxGifFrames) {
        diags.push({ code: 'image-gif-frame-cap', detail: `GIF has more than ${caps.maxGifFrames} frames; the rest are dropped`, severity: 'info' });
        break;
      }
      const left = u16le(bytes, pos + 1);
      const top = u16le(bytes, pos + 3);
      const fw = u16le(bytes, pos + 5);
      const fh = u16le(bytes, pos + 7);
      const packed = bytes[pos + 9];
      pos += 10;
      let tableAt = 13;
      let entries = globalEntries;
      if (packed & 0x80) {
        entries = 2 << (packed & 7);
        tableAt = pos;
        pos += entries * 3;
      }
      if (pos >= len) break;
      const minCode = bytes[pos++];
      // Gather the sub-blocks into one run of packed codes.
      let total = 0;
      for (let p = pos; p < len;) {
        const n = bytes[p];
        if (n === 0) break;
        total += Math.min(n, len - p - 1);
        p += 1 + n;
      }
      const packedCodes = new Uint8Array(total);
      let filled = 0;
      let p = pos;
      while (p < len) {
        const n = bytes[p++];
        if (n === 0) break;
        const take = Math.min(n, len - p);
        packedCodes.set(bytes.subarray(p, p + take), filled);
        filled += take;
        p += n;
      }
      pos = Math.min(p, len);
      if (minCode < 1 || minCode > 11 || entries === 0 || fw === 0 || fh === 0) {
        if (!frames.length && !drawn) return fail(diags, 'image-corrupt', 'GIF first frame has no usable colour table or code size');
        break; // a bad later frame: keep the ones before it
      }
      // The previous frame is finished: copy it out, then dispose of it.
      if (!snapshot()) {
        diags.push({ code: 'image-gif-frames-memory', detail: 'GIF frames would exceed the 128 MiB retained-frame budget; the rest are dropped', severity: 'info' });
        break;
      }
      if (prev) {
        if (prev.disposal === 2) {
          for (let y = prev.top; y < Math.min(H, prev.top + prev.h); y++) {
            const row = y * W;
            canvas.fill(0, (row + prev.left) * 4, (row + Math.min(W, prev.left + prev.w)) * 4);
          }
        } else if (prev.disposal === 3 && restore) {
          canvas.set(restore);
        }
      }
      restore = disposal === 3 ? canvas.slice() : null;
      const decoded = drawFrame(packedCodes, minCode, bytes, tableAt, entries, transparent, { left, top, w: fw, h: fh, interlaced: !!(packed & 0x40) }, canvas, W, H);
      if (decoded === 0 && !frames.length) return fail(diags, 'image-corrupt', 'GIF first frame holds no pixels');
      drawn = true;
      drawnDelay = delay * 10;
      prev = { disposal, left, top, w: fw, h: fh };
      if (decoded < fw * fh) {
        diags.push({ code: 'image-gif-truncated', detail: `GIF frame ${frames.length} decoded ${decoded} of ${fw * fh} pixels`, severity: 'warn' });
      }
      // The graphic control extension describes the next image only.
      transparent = -1;
      disposal = 0;
      delay = 0;
    } else {
      break; // the trailer, or bytes that are not a block
    }
  }
  if (drawn) {
    // The last frame is final, so the canvas itself can be its snapshot.
    if (frames.length === 0 || retained + frameBytes <= MAX_FRAME_BYTES) {
      frames.push({ data: canvas, delayMs: drawnDelay });
    } else {
      diags.push({ code: 'image-gif-frames-memory', detail: 'GIF frames would exceed the 128 MiB retained-frame budget; the rest are dropped', severity: 'info' });
    }
    drawn = false;
  }
  if (!frames.length) return fail(diags, 'image-corrupt', 'GIF has no decodable frame');
  /** @type {RgbaImage} */
  const image = { width: W, height: H, data: frames[0].data };
  if (frames.length > 1) image.frames = frames;
  return image;
}
