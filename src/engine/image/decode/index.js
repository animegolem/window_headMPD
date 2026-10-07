// @ts-check
// Decoder entry (ENGINE D3, §5.4): magic-byte dispatch to the four decoders. Pure: bytes in, RGBA out,
// no DOM, no Worker, no clock. The 2 s wall-time cap belongs to the host's DecodeExecutor, which
// terminates the Worker; nothing here can enforce it from inside a synchronous call.
//
// `decodeImageWithDiagnostics` is the form the executors call (contract `DecodeImageWithDiagnosticsFn`,
// G1): D3 wants diagnostics (a 32-bit BMP with real alpha, an RLE stream that stops early, a GIF cut at
// the frame cap) and `decodeImage`, the plain contract function, has no channel for them, so it wraps
// this one and drops them.

import { DEFAULT_IMAGE_CAPS, detectFormat, resolveCaps } from '../probe.js';
import { decodeBmp } from './bmp.js';
import { decodeGif } from './gif.js';
import { decodeJpeg } from './jpeg.js';
import { decodePng } from './png.js';

export { DEFAULT_IMAGE_CAPS };

/** @typedef {import('../../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').ImageCaps} ImageCaps */

/**
 * Decode, never throw. On a failed or capped decode `image` is null and `diagnostics` says why;
 * on success it may still carry warnings (a clipped RLE stream, a dropped alpha channel).
 * @type {import('../../contracts').DecodeImageWithDiagnosticsFn}
 */
export const decodeImageWithDiagnostics = (bytes, caps) => {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const c = resolveCaps(caps);
  const format = detectFormat(bytes);
  if (!format) {
    diagnostics.push({ code: 'image-unknown-format', detail: 'bytes do not start with a BMP, PNG, GIF or JPEG signature', severity: 'warn' });
    return { image: null, diagnostics };
  }
  /** @type {RgbaImage | null} */
  let image = null;
  try {
    if (format === 'bmp') image = decodeBmp(bytes, c, diagnostics);
    else if (format === 'png') image = decodePng(bytes, c, diagnostics);
    else if (format === 'gif') image = decodeGif(bytes, c, diagnostics);
    else image = decodeJpeg(bytes, c, diagnostics);
  } catch (e) {
    // A decoder bug or an allocation failure must still be a missing image, not a crashed skin.
    image = null;
    diagnostics.push({ code: 'image-decode-error', detail: `${format}: ${e instanceof Error ? e.message : String(e)}`, severity: 'error' });
  }
  if (!image && !diagnostics.length) diagnostics.push({ code: 'image-corrupt', detail: `${format} could not be decoded`, severity: 'warn' });
  return { image, diagnostics };
};

/** @type {import('../../contracts').DecodeImageFn} */
export const decodeImage = (bytes, caps) => decodeImageWithDiagnostics(bytes, caps).image;
