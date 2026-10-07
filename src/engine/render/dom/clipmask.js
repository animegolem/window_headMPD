// @ts-check
// A SUBVIEW's `clippingColor` as a CSS mask (E D2 "SUBVIEW clippingColor/clippingImage"): a PNG the
// engine writes itself from the clip bits at the image's native size, set as `-webkit-mask-image` on
// the subview's `div`. The data URL holds nothing the skin wrote: it is a 1-bit palette PNG whose
// opaque pixels are the kept ones, generated from bits, and the page's CSP allows `data:` images.
//
// Why a PNG at all: the oracle clips with a `mask-image` too (css:130-135), so the engine's clip and
// the oracle's meet the same compositor path. Why not `canvas.toDataURL`: this module stays pure and
// runs under Node, so the encoder is tested without a browser.

import { zlibSync } from 'fflate';

/** @typedef {{ width: number, height: number, clip: Uint8Array | null }} ClipPlanes */

/** @type {Uint32Array | null} */
let crcTable = null;

/** @param {Uint8Array} bytes @returns {number} */
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Uint8Array} data @returns {Uint8Array} */
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * The mask PNG for a keyed image's clip plane (1 = inside = kept), or null when nothing is clipped
 * or the image has no area. Bit depth 1, a two-entry palette, `tRNS` making index 0 transparent.
 * @param {ClipPlanes} planes
 * @returns {Uint8Array | null}
 */
export function clipMaskPng(planes) {
  const { width: w, height: h, clip } = planes;
  if (!clip || w < 1 || h < 1) return null;
  const rowBytes = (w + 7) >> 3;
  const raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const base = y * (rowBytes + 1) + 1; // the byte before it is the filter type, 0
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((clip[i >> 3] >> (i & 7)) & 1) raw[base + (x >> 3)] |= 0x80 >> (x & 7); // PNG packs the leftmost pixel in the top bit
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // indexed colour
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', Uint8Array.from([0, 0, 0, 0, 0, 0])),
    chunk('tRNS', Uint8Array.from([0, 255])),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * `data:image/png;base64,...` for a clip plane, or null when there is nothing to clip.
 * @param {ClipPlanes} planes
 * @returns {string | null}
 */
export function clipMaskUrl(planes) {
  const png = clipMaskPng(planes);
  if (!png) return null;
  let s = '';
  for (let i = 0; i < png.length; i += 0x2000) s += String.fromCharCode(...png.subarray(i, i + 0x2000));
  return `data:image/png;base64,${btoa(s)}`;
}
