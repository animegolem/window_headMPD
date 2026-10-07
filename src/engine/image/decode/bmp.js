// @ts-check
// BMP decoder (ENGINE D3). Headers of 12 (OS/2), 40, 52, 56, 64, 108 and 124 bytes; bottom-up and
// top-down; 1, 4, 8, 16, 24 and 32 bits; BI_RGB, BI_RLE8, BI_RLE4 and BI_BITFIELDS.
//
// Decisions that D3 or the fixtures leave open, written down where the code makes them:
// - 16-bit BI_RGB is X1R5G5B5. BI_BITFIELDS takes its masks from the file, whatever their widths.
// - A channel narrower than 8 bits widens by bit replication (0b10101 -> 0b10101101), a wider one
//   keeps its top 8 bits.
// - Alpha is 255 for every BMP. A non-zero alpha channel (32-bit fourth byte, or the alpha mask of
//   a BITFIELDS image) adds one `image-bmp-alpha-ignored` diagnostic.
// - Pixel data starts at bfOffBits. The palette holds biClrUsed entries (2^bpp when that is 0),
//   trimmed to what actually sits before the pixel data; an index past it paints black.
// - RLE follows the Win32 stream rules and stops *before* a command that would write outside the
//   bitmap or read past the end of the stream. Pixels the stream never wrote (delta skips, an early
//   end-of-bitmap, everything after a stop) are 0,0,0,0, transparent. GDI would show palette entry 0
//   for a skipped pixel; the fixtures and D3's "the rest is transparent" fix the other reading.
// - A stream that runs out, mid-command or on a command boundary, before the cursor has reached the
//   end of the bitmap and without an end-of-bitmap marker is truncated (`image-bmp-rle-truncated`).
//   A stream that fills every row but lacks the final end-of-bitmap marker is complete, no diagnostic.
// - An uncompressed image with too little pixel data keeps the rows that are there and leaves the
//   rest transparent, with a diagnostic; with not even one row it is a failed decode.

import { BMP_HEADER_SIZES, withinCaps } from '../probe.js';
import { i32le, u16le, u32le } from './binary.js';

/** @typedef {import('../../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').ImageCaps} ImageCaps */

/**
 * @param {Diagnostic[]} diags @param {string} code @param {string} detail @param {Diagnostic['severity']} [severity]
 * @returns {null}
 */
function fail(diags, code, detail, severity = 'warn') {
  diags.push({ code, detail, severity });
  return null;
}

/**
 * Widen an n-bit channel value to 8 bits: replicate the bits below 8, keep the top byte above.
 * @param {number} v @param {number} bits
 */
function widenTo8(v, bits) {
  if (bits === 0) return 0;
  if (bits >= 8) return v >>> (bits - 8);
  let out = 0;
  for (let shift = 8 - bits; ; shift -= bits) {
    out |= shift >= 0 ? v << shift : v >>> -shift;
    if (shift <= 0) break;
  }
  return out & 0xff;
}

/**
 * One BITFIELDS channel: where it sits, and a lookup table that widens it when it is at most 8
 * bits. A mask that is not one contiguous run is read as its lowest run, which is what GDI wants.
 * @param {number} mask
 */
function makeChannel(mask) {
  let shift = 0;
  let bits = 0;
  if (mask) {
    while (!((mask >>> shift) & 1)) shift++;
    while (shift + bits < 32 && (mask >>> (shift + bits)) & 1) bits++;
  }
  const low = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
  let lut = null;
  if (bits <= 8) {
    lut = new Uint8Array(1 << bits);
    for (let v = 0; v < lut.length; v++) lut[v] = widenTo8(v, bits);
  }
  return { shift, bits, low, lut };
}

/** @param {ReturnType<typeof makeChannel>} ch @param {number} word unsigned */
function pick(ch, word) {
  const v = ch.bits >= 32 ? word >>> ch.shift : (word >>> ch.shift) & ch.low;
  return ch.lut ? ch.lut[v] : v >>> (ch.bits - 8);
}

/**
 * @param {Uint8Array} bytes
 * @param {Partial<ImageCaps> & ImageCaps} caps
 * @param {Diagnostic[]} diags
 * @returns {RgbaImage | null}
 */
export function decodeBmp(bytes, caps, diags) {
  const len = bytes.length;
  if (len < 26) return fail(diags, 'image-corrupt', 'BMP shorter than its file header');
  const offBits = u32le(bytes, 10);
  const hdr = u32le(bytes, 14);
  if (!BMP_HEADER_SIZES.includes(hdr)) return fail(diags, 'image-unsupported', `BMP DIB header of ${hdr} bytes`);
  if (len < 14 + hdr) return fail(diags, 'image-corrupt', 'BMP shorter than its DIB header');

  let width;
  let rawHeight;
  let bpp;
  let compression = 0;
  let clrUsed = 0;
  let palEntry = 3;
  if (hdr === 12) {
    width = u16le(bytes, 18);
    rawHeight = u16le(bytes, 20);
    bpp = u16le(bytes, 24);
  } else {
    width = i32le(bytes, 18);
    rawHeight = i32le(bytes, 22);
    bpp = u16le(bytes, 28);
    compression = u32le(bytes, 30);
    clrUsed = u32le(bytes, 46);
    palEntry = 4;
  }
  if (width < 1 || rawHeight === 0) return fail(diags, 'image-corrupt', `BMP size ${width} x ${rawHeight}`);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  // Before any allocation: a header may claim anything.
  if (!withinCaps(width, height, caps)) {
    return fail(diags, 'image-over-cap', `BMP ${width} x ${height} exceeds ${caps.maxAxis} per axis or ${caps.maxArea} pixels`);
  }
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return fail(diags, 'image-unsupported', `BMP at ${bpp} bits per pixel`);
  const rle = compression === 1 || compression === 2;
  const bitfields = compression === 3 && hdr !== 64; // for a 64-byte OS/2 header, 3 means Huffman
  const supported =
    (compression === 0) || (compression === 1 && bpp === 8) || (compression === 2 && bpp === 4) || (bitfields && (bpp === 16 || bpp === 32));
  if (!supported) return fail(diags, 'image-unsupported', `BMP compression ${compression} at ${bpp} bits per pixel`);

  // Channel masks. A 40-byte header keeps them in the 12 bytes after it; the larger ones inside.
  let maskR = 0x7c00;
  let maskG = 0x03e0;
  let maskB = 0x001f;
  let maskA = 0;
  if (bpp === 32) { maskR = 0x00ff0000; maskG = 0x0000ff00; maskB = 0x000000ff; }
  if (bitfields) {
    if (len < 66) return fail(diags, 'image-corrupt', 'BMP ends inside its channel masks');
    maskR = u32le(bytes, 54);
    maskG = u32le(bytes, 58);
    maskB = u32le(bytes, 62);
    // A 40- or 52-byte header has no alpha mask; at 32 bits the bits no colour mask claims are the
    // alpha channel as far as the "is any alpha set" diagnostic goes.
    maskA = hdr >= 56 ? u32le(bytes, 66) : bpp === 32 ? ~(maskR | maskG | maskB) >>> 0 : 0;
  }

  // Layout: [file header][DIB header][masks][palette][pixels at bfOffBits].
  const palStart = 14 + hdr;
  let palCount = 0;
  if (bpp <= 8) {
    const full = 1 << bpp;
    palCount = clrUsed > 0 ? Math.min(clrUsed, full) : full;
  }
  let off = offBits;
  if (off < palStart || off > len) off = palStart + (bitfields && hdr === 40 ? 12 : 0) + palCount * palEntry; // a bad bfOffBits: trust the layout
  if (off >= len) return fail(diags, 'image-corrupt', 'BMP has no pixel data');
  if (bpp <= 8) palCount = Math.min(palCount, Math.floor((off - palStart) / palEntry));
  const pal = new Uint8Array(256 * 3); // RGB, black past the table
  for (let i = 0; i < palCount; i++) {
    const o = palStart + i * palEntry;
    pal[i * 3] = bytes[o + 2];
    pal[i * 3 + 1] = bytes[o + 1];
    pal[i * 3 + 2] = bytes[o];
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const indices = bpp === 8 ? new Uint8Array(width * height) : null;
  let alphaSeen = false;
  let complete = true;

  if (rle) {
    const r = decodeRle(bytes, off, width, height, bpp === 8 ? 8 : 4, topDown, pal, data, indices);
    if (r.status === 'truncated') {
      diags.push({ code: 'image-bmp-rle-truncated', detail: 'BMP RLE stream ends before the bitmap is complete; the rest of the image is transparent', severity: 'warn' });
    } else if (r.status === 'overrun') {
      diags.push({ code: 'image-bmp-rle-overrun', detail: 'BMP RLE command leaves the bitmap; the image stops there and the rest is transparent', severity: 'warn' });
    }
    complete = r.written === width * height;
  } else {
    const rowBytes = ((width * bpp + 31) >>> 5) << 2;
    const lastRowBytes = (width * bpp + 7) >> 3; // a writer may leave the final row unpadded
    const avail = len - off;
    const rows = avail < lastRowBytes ? 0 : Math.min(height, Math.floor((avail - lastRowBytes) / rowBytes) + 1);
    if (rows === 0) return fail(diags, 'image-corrupt', 'BMP pixel data holds less than one row');
    if (rows < height) {
      complete = false;
      diags.push({ code: 'image-bmp-truncated', detail: `BMP pixel data holds ${rows} of ${height} rows; the rest is transparent`, severity: 'warn' });
    }
    const chR = makeChannel(maskR);
    const chG = makeChannel(maskG);
    const chB = makeChannel(maskB);
    for (let r = 0; r < rows; r++) {
      const src = off + r * rowBytes;
      const y = topDown ? r : height - 1 - r;
      let p = y * width * 4;
      if (bpp === 24) {
        for (let x = 0; x < width; x++, p += 4) {
          const o = src + x * 3;
          data[p] = bytes[o + 2];
          data[p + 1] = bytes[o + 1];
          data[p + 2] = bytes[o];
          data[p + 3] = 255;
        }
      } else if (bpp === 32 && !bitfields) {
        for (let x = 0; x < width; x++, p += 4) {
          const o = src + x * 4;
          data[p] = bytes[o + 2];
          data[p + 1] = bytes[o + 1];
          data[p + 2] = bytes[o];
          data[p + 3] = 255;
          if (bytes[o + 3]) alphaSeen = true;
        }
      } else if (bpp === 32 || bpp === 16) {
        const wide = bpp === 32;
        for (let x = 0; x < width; x++, p += 4) {
          const o = src + x * (wide ? 4 : 2);
          const word = wide ? u32le(bytes, o) : u16le(bytes, o);
          data[p] = pick(chR, word);
          data[p + 1] = pick(chG, word);
          data[p + 2] = pick(chB, word);
          data[p + 3] = 255;
          if (maskA && (word & maskA) !== 0) alphaSeen = true;
        }
      } else {
        const rowIdx = y * width;
        for (let x = 0; x < width; x++, p += 4) {
          const b = bytes[src + (x * bpp >> 3)];
          const idx = bpp === 8 ? b : bpp === 4 ? (x & 1 ? b & 15 : b >> 4) : (b >> (7 - (x & 7))) & 1;
          data[p] = pal[idx * 3];
          data[p + 1] = pal[idx * 3 + 1];
          data[p + 2] = pal[idx * 3 + 2];
          data[p + 3] = 255;
          if (indices) indices[rowIdx + x] = idx;
        }
      }
    }
  }
  if (alphaSeen) {
    diags.push({ code: 'image-bmp-alpha-ignored', detail: 'BMP carries a non-zero alpha channel; alpha is forced to 255', severity: 'info' });
  }
  /** @type {RgbaImage} */
  const image = { width, height, data };
  // Indices cannot say "transparent", so an image with unwritten pixels has no indexed form.
  if (indices && complete) image.indexed = { palette: pal, indices };
  return image;
}

/**
 * RLE8 and RLE4. File rows run bottom-up unless the header is top-down.
 * @param {Uint8Array} bytes @param {number} start @param {number} width @param {number} height
 * @param {4 | 8} bpp @param {boolean} topDown @param {Uint8Array} pal @param {Uint8ClampedArray} out
 * @param {Uint8Array | null} indices
 * @returns {{ status: 'eob' | 'end' | 'truncated' | 'overrun', written: number }}
 */
function decodeRle(bytes, start, width, height, bpp, topDown, pal, out, indices) {
  const len = bytes.length;
  let i = start;
  let x = 0;
  let y = 0; // file row
  let written = 0;
  /** @type {'eob' | 'end' | 'truncated' | 'overrun'} */
  let status = 'end';
  const put = (/** @type {number} */ v) => {
    const row = topDown ? y : height - 1 - y;
    const q = row * width + x;
    const p = q * 4;
    out[p] = pal[v * 3];
    out[p + 1] = pal[v * 3 + 1];
    out[p + 2] = pal[v * 3 + 2];
    out[p + 3] = 255;
    if (indices) indices[q] = v;
    written++;
    x++;
  };
  while (i < len) {
    if (i + 1 >= len) { status = 'truncated'; break; }
    const a = bytes[i++];
    const b = bytes[i++];
    if (a > 0) {
      if (y >= height || x + a > width) { status = 'overrun'; break; }
      if (bpp === 8) for (let k = 0; k < a; k++) put(b);
      else for (let k = 0; k < a; k++) put(k & 1 ? b & 15 : b >> 4);
      continue;
    }
    if (b === 0) { x = 0; y++; continue; }
    if (b === 1) { status = 'eob'; break; }
    if (b === 2) {
      if (i + 1 >= len) { status = 'truncated'; break; }
      const dx = bytes[i++];
      const dy = bytes[i++];
      if (x + dx > width || y + dy >= height) { status = 'overrun'; break; }
      x += dx;
      y += dy;
      continue;
    }
    // Absolute run of b pixels, padded to a 16-bit boundary.
    const dataBytes = bpp === 8 ? b : (b + 1) >> 1;
    if (y >= height || x + b > width) { status = 'overrun'; break; }
    if (i + dataBytes > len) { status = 'truncated'; break; }
    if (bpp === 8) for (let k = 0; k < b; k++) put(bytes[i + k]);
    else for (let k = 0; k < b; k++) put(k & 1 ? bytes[i + (k >> 1)] & 15 : bytes[i + (k >> 1)] >> 4);
    i += Math.min(dataBytes + (dataBytes & 1), len - i);
  }
  // The stream ran out with no end-of-bitmap marker. It is complete only if the cursor reached the end
  // of the bitmap (past the last row, or at the end of the last row). The cursor is the test, not the
  // written count: a delta skip legitimately leaves pixels unwritten.
  if (status === 'end' && !(y >= height || (y === height - 1 && x >= width))) status = 'truncated';
  return { status, written };
}
