// @ts-check
// Header-only image probe (ENGINE D3, §5.4). Synchronous and allocation-free: it reads a few dozen
// bytes at the front of the file, so layout can give an element its default size without decoding
// anything. Detection is by magic bytes only; the file extension is never consulted (G7).
//
// A header whose size breaks a cap probes as `null`, the same answer `decodeImage` gives, so an image
// the decoder will refuse never lends an element a 30,000 px default size.

import { i32le, u16be, u16le, u32be, u32le } from './decode/binary.js';

/** @typedef {import('../contracts').ImageProbe} ImageProbe */
/** @typedef {import('../contracts').ImageCaps} ImageCaps */

/** Per axis 16,384 px, area 16,777,216 px (64 MiB RGBA), GIF frames 512 (D3, §10). @type {Readonly<ImageCaps>} */
export const DEFAULT_IMAGE_CAPS = Object.freeze({ maxAxis: 16384, maxArea: 16777216, maxGifFrames: 512 });

/** @param {Partial<ImageCaps> | undefined} caps @returns {ImageCaps} */
export function resolveCaps(caps) {
  return {
    maxAxis: caps?.maxAxis ?? DEFAULT_IMAGE_CAPS.maxAxis,
    maxArea: caps?.maxArea ?? DEFAULT_IMAGE_CAPS.maxArea,
    maxGifFrames: caps?.maxGifFrames ?? DEFAULT_IMAGE_CAPS.maxGifFrames,
  };
}

/** @param {number} w @param {number} h @param {ImageCaps} caps */
export const withinCaps = (w, h, caps) => w >= 1 && h >= 1 && w <= caps.maxAxis && h <= caps.maxAxis && w * h <= caps.maxArea;

/** @param {Uint8Array} b @returns {ImageProbe['format'] | null} */
export function detectFormat(b) {
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

/** DIB header sizes the BMP decoder reads: OS/2 core, INFO, V2, V3, OS/2 2.x, V4, V5. */
export const BMP_HEADER_SIZES = [12, 40, 52, 56, 64, 108, 124];

/**
 * @param {Uint8Array} b
 * @returns {{ width: number, height: number } | null} the stored size, uncapped
 */
function bmpSize(b) {
  if (b.length < 26) return null;
  const hdr = u32le(b, 14);
  if (!BMP_HEADER_SIZES.includes(hdr)) return null;
  if (hdr === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
  const w = i32le(b, 18);
  const h = i32le(b, 22);
  if (w <= 0 || h === 0) return null;
  return { width: w, height: Math.abs(h) };
}

/** @param {Uint8Array} b @returns {{ width: number, height: number } | null} */
function pngSize(b) {
  if (b.length < 24) return null;
  // IHDR must be the first chunk: length 13, then the type.
  if (u32be(b, 8) !== 13 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const w = u32be(b, 16);
  const h = u32be(b, 20);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/**
 * Position after a run of data sub-blocks that starts at `p`, or -1 if the file ends first.
 * @param {Uint8Array} b @param {number} p
 */
export function skipSubBlocks(b, p) {
  while (p < b.length) {
    const n = b[p++];
    if (n === 0) return p;
    p += n;
  }
  return -1;
}

/**
 * The first part of a GIF that sizing needs. The canvas is the logical screen, grown to hold the
 * first frame when that frame pokes out of it (a screen of 0 x 0 is then replaced by the frame).
 * The decoder uses this same function, so probe and decode cannot disagree about the size.
 * @param {Uint8Array} b
 * @returns {{ width: number, height: number, descriptorAt: number, left: number, top: number,
 *   frameW: number, frameH: number, tableEntries: number } | null}
 */
export function readGifHeader(b) {
  if (detectFormat(b) !== 'gif' || b.length < 13) return null;
  const flags = b[10];
  const tableEntries = flags & 0x80 ? 2 << (flags & 7) : 0;
  let p = 13 + tableEntries * 3;
  while (p < b.length) {
    const c = b[p];
    if (c === 0x21) {
      p = skipSubBlocks(b, p + 2);
      if (p < 0) return null;
    } else if (c === 0x2c) {
      if (p + 10 > b.length) return null;
      const left = u16le(b, p + 1);
      const top = u16le(b, p + 3);
      const frameW = u16le(b, p + 5);
      const frameH = u16le(b, p + 7);
      const width = Math.max(u16le(b, 6), left + frameW);
      const height = Math.max(u16le(b, 8), top + frameH);
      if (!width || !height) return null;
      return { width, height, descriptorAt: p, left, top, frameW, frameH, tableEntries };
    } else {
      return null; // a trailer, or bytes that are not a block, before any image
    }
  }
  return null;
}

/** SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC). @param {number} m */
const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/**
 * Walk the marker segments to the frame header. Our own scan, so the caps are checked before
 * jpeg-js allocates anything. A height of 0 means the real height follows in a DNL segment, which
 * we do not support.
 * @param {Uint8Array} b @returns {{ width: number, height: number } | null}
 */
export function jpegSize(b) {
  let p = 2;
  while (p + 3 < b.length) {
    if (b[p] !== 0xff) return null;
    while (p < b.length && b[p] === 0xff) p++; // fill bytes
    const m = b[p++];
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue; // standalone markers
    if (m === 0xd9 || m === 0xda || m === 0x00) return null; // end of image or scan data before a frame header
    if (p + 2 > b.length) return null;
    const len = u16be(b, p);
    if (len < 2) return null;
    if (isSof(m)) {
      if (p + 7 > b.length) return null;
      const height = u16be(b, p + 3);
      const width = u16be(b, p + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    p += len;
  }
  return null;
}

/**
 * Format and stored size from the header alone, before any cap is applied.
 * @param {Uint8Array} bytes
 * @returns {ImageProbe | null}
 */
export function readHeader(bytes) {
  const format = detectFormat(bytes);
  if (!format) return null;
  const size = format === 'bmp' ? bmpSize(bytes) : format === 'png' ? pngSize(bytes) : format === 'gif' ? readGifHeader(bytes) : jpegSize(bytes);
  return size ? { format, width: size.width, height: size.height } : null;
}

/** @type {import('../contracts').ProbeImageFn} */
export const probeImage = (bytes) => {
  const header = readHeader(bytes);
  return header && withinCaps(header.width, header.height, DEFAULT_IMAGE_CAPS) ? header : null;
};
