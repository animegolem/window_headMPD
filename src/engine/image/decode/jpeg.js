// @ts-check
// JPEG decoder (ENGINE D3): `jpeg-js` 0.4.4, called only after our own scan of the marker segments has
// found the frame header and the axis and area caps have passed, so the library never sees a size
// the caps refuse. Baseline and progressive both decode; jpeg-js tolerates truncated scan data by
// default. The area cap (16,777,216 px) is the one size authority: jpeg-js's megapixel guard is set a
// hair above it, 16.78 MP (it counts a megapixel as 1,000,000 px, so 16.78 MP is 16,780,000 px), and
// cannot fire for a size that passed our check under the default caps, so the probe and the decoder
// agree. Its 256 MiB working-memory guard stays on as a second limit.

import { decode } from 'jpeg-js';
import { jpegSize, withinCaps } from '../probe.js';

/** @typedef {import('../../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').ImageCaps} ImageCaps */

/**
 * @param {Uint8Array} bytes
 * @param {ImageCaps} caps
 * @param {Diagnostic[]} diags
 * @returns {RgbaImage | null}
 */
export function decodeJpeg(bytes, caps, diags) {
  const size = jpegSize(bytes);
  if (!size) {
    diags.push({ code: 'image-corrupt', detail: 'JPEG has no readable frame header', severity: 'warn' });
    return null;
  }
  if (!withinCaps(size.width, size.height, caps)) {
    diags.push({ code: 'image-over-cap', detail: `JPEG ${size.width} x ${size.height} exceeds ${caps.maxAxis} per axis or ${caps.maxArea} pixels`, severity: 'warn' });
    return null;
  }
  try {
    const out = decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16.78, maxMemoryUsageInMB: 256 });
    const d = out.data;
    return { width: out.width, height: out.height, data: new Uint8ClampedArray(d.buffer, d.byteOffset, d.length) };
  } catch (e) {
    diags.push({ code: 'image-corrupt', detail: `JPEG does not decode: ${e instanceof Error ? e.message : String(e)}`, severity: 'warn' });
    return null;
  }
}
