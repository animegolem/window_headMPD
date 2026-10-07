// @ts-check
// PNG decoder (ENGINE D3): own chunk parser and unfilter, `fflate` for the zlib stream.
//
// - IHDR, PLTE, tRNS, IDAT and IEND are read; every other chunk is skipped, and CRCs are not
//   checked (a skin that browsers refuse but GDI took is still a skin). gAMA, cHRM, sRGB and iCCP
//   are never applied: colour management could move #FF00FF off its key (D3).
// - The IDAT stream is inflated into a buffer of exactly the size IHDR implies, plus one spare byte.
//   fflate stops writing at the end of a buffer it was handed, so a stream that inflates past the
//   header is caught by length (expected + 1) and the allocation never exceeds the header's claim,
//   which the caps have already bounded. A stream that is short, truncated or overflowing is a
//   failed decode.
// - All colour types and depths; 16-bit samples keep their high byte; sub-8-bit grey scales as
//   v * 255 / (2^depth - 1); tRNS is matched on the full-depth sample before any scaling; Adam7.

import { unzlibSync } from 'fflate';
import { withinCaps } from '../probe.js';
import { u32be } from './binary.js';

/** @typedef {import('../../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../../contracts').ImageCaps} ImageCaps */

const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const TRNS = 0x74524e53;
const IDAT = 0x49444154;
const IEND = 0x49454e44;

/** Channels per colour type; 1 and 5 are not PNG colour types. */
const CHANNELS = [1, 0, 3, 1, 2, 0, 4];
/** Legal depths per colour type (PNG spec table 11.1). */
const DEPTHS = [[1, 2, 4, 8, 16], [], [8, 16], [1, 2, 4, 8], [8, 16], [], [8, 16]];
/** Adam7: x0, y0, dx, dy per pass. */
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/**
 * @param {Diagnostic[]} diags @param {string} code @param {string} detail
 * @returns {null}
 */
function fail(diags, code, detail) {
  diags.push({ code, detail, severity: 'warn' });
  return null;
}

/**
 * Unfilter the rows of one (sub)image in place. Each row is a filter byte then `rowBytes` bytes.
 * @param {Uint8Array} buf @param {number} start @param {number} rowBytes @param {number} rows
 * @param {number} bpp bytes per complete pixel, at least 1
 * @returns {boolean} false on a filter type outside 0..4
 */
function unfilter(buf, start, rowBytes, rows, bpp) {
  let prev = -1; // data offset of the previous row, -1 for the first row (all zero above it)
  let at = start;
  for (let r = 0; r < rows; r++) {
    const type = buf[at];
    const cur = at + 1;
    if (type === 1) {
      for (let i = bpp; i < rowBytes; i++) buf[cur + i] += buf[cur + i - bpp];
    } else if (type === 2) {
      if (prev >= 0) for (let i = 0; i < rowBytes; i++) buf[cur + i] += buf[prev + i];
    } else if (type === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? buf[cur + i - bpp] : 0;
        const b = prev >= 0 ? buf[prev + i] : 0;
        buf[cur + i] += (a + b) >> 1;
      }
    } else if (type === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? buf[cur + i - bpp] : 0;
        const b = prev >= 0 ? buf[prev + i] : 0;
        const c = i >= bpp && prev >= 0 ? buf[prev + i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        buf[cur + i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
    } else if (type !== 0) {
      return false;
    }
    prev = cur;
    at += rowBytes + 1;
  }
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @param {ImageCaps} caps
 * @param {Diagnostic[]} diags
 * @returns {RgbaImage | null}
 */
export function decodePng(bytes, caps, diags) {
  const len = bytes.length;
  /** @type {Uint8Array[]} */
  const idats = [];
  let idatTotal = 0;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlaced = false;
  /** @type {Uint8Array | null} */
  let plte = null;
  /** @type {Uint8Array | null} */
  let trns = null;
  let sawHeader = false;

  let pos = 8;
  while (pos + 8 <= len) {
    const clen = u32be(bytes, pos);
    const type = u32be(bytes, pos + 4);
    const start = pos + 8;
    const end = Math.min(start + clen, len); // a chunk that runs off the file keeps what is there
    if (!sawHeader) {
      if (type !== IHDR || end - start < 13) return fail(diags, 'image-corrupt', 'PNG does not start with IHDR');
      width = u32be(bytes, start);
      height = u32be(bytes, start + 4);
      depth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlaced = bytes[start + 12] === 1;
      if (!(width >= 1 && height >= 1)) return fail(diags, 'image-corrupt', `PNG size ${width} x ${height}`);
      // Before any allocation: IHDR may claim anything.
      if (!withinCaps(width, height, caps)) {
        return fail(diags, 'image-over-cap', `PNG ${width} x ${height} exceeds ${caps.maxAxis} per axis or ${caps.maxArea} pixels`);
      }
      if (!(DEPTHS[colorType] ?? []).includes(depth)) return fail(diags, 'image-corrupt', `PNG colour type ${colorType} at depth ${depth}`);
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] > 1) return fail(diags, 'image-corrupt', 'PNG compression, filter or interlace method is not 0');
      sawHeader = true;
    } else if (type === PLTE) {
      plte = bytes.subarray(start, end);
    } else if (type === TRNS) {
      trns = bytes.subarray(start, end);
    } else if (type === IDAT) {
      idats.push(bytes.subarray(start, end));
      idatTotal += end - start;
    } else if (type === IEND) {
      break;
    }
    pos = start + clen + 4;
  }
  if (!sawHeader) return fail(diags, 'image-corrupt', 'PNG has no IHDR');
  if (!idats.length) return fail(diags, 'image-corrupt', 'PNG has no IDAT');
  if (colorType === 3 && (!plte || plte.length < 3)) return fail(diags, 'image-corrupt', 'indexed PNG has no PLTE');

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  /** @type {{ x0: number, y0: number, dx: number, dy: number, pw: number, ph: number, rowBytes: number, offset: number }[]} */
  const passes = [];
  let expected = 0;
  for (const [x0, y0, dx, dy] of interlaced ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue; // an empty pass has no rows and no filter bytes
    const rowBytes = (pw * bitsPerPixel + 7) >> 3;
    passes.push({ x0, y0, dx, dy, pw, ph, rowBytes, offset: expected });
    expected += ph * (rowBytes + 1);
  }
  // Deflate cannot beat about 1032:1, so a stream this small cannot fill what IHDR promises.
  // Refuse it before allocating for the claim.
  if (idatTotal * 1032 + 1024 < expected) return fail(diags, 'image-corrupt', 'PNG IDAT is far too small for the size IHDR declares');

  /** @type {Uint8Array} */
  let idat;
  if (idats.length === 1) {
    idat = idats[0];
  } else {
    idat = new Uint8Array(idatTotal);
    let at = 0;
    for (const part of idats) { idat.set(part, at); at += part.length; }
  }
  /** @type {Uint8Array} */
  let raw;
  try {
    raw = unzlibSync(idat, { out: new Uint8Array(expected + 1) });
  } catch (e) {
    return fail(diags, 'image-corrupt', `PNG IDAT does not inflate: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw.length > expected) return fail(diags, 'image-png-idat-overflow', 'PNG IDAT inflates past the size IHDR declares');
  if (raw.length < expected) return fail(diags, 'image-corrupt', `PNG IDAT inflates to ${raw.length} of ${expected} bytes`);

  for (const ps of passes) {
    if (!unfilter(raw, ps.offset, ps.rowBytes, ps.ph, bpp)) return fail(diags, 'image-corrupt', 'PNG row with a filter type above 4');
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const maxSample = depth === 16 ? 65535 : (1 << depth) - 1;
  const scale = depth < 8 ? 255 / maxSample : 1; // 1, 2, 4 bits: 255, 85, 17, exact
  /** @param {number} v */
  const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : v * scale);
  // tRNS: grey one sample, RGB three, indexed one alpha per palette entry. Full-depth values.
  const keyGray = colorType === 0 && trns && trns.length >= 2 ? ((trns[0] << 8) | trns[1]) & maxSample : -1;
  const keyRgb = colorType === 2 && trns && trns.length >= 6 ? [((trns[0] << 8) | trns[1]) & maxSample, ((trns[2] << 8) | trns[3]) & maxSample, ((trns[4] << 8) | trns[5]) & maxSample] : null;
  const palCount = plte ? Math.min(256, Math.floor(plte.length / 3)) : 0;

  for (const ps of passes) {
    const row = new Uint16Array(ps.pw * channels);
    for (let py = 0; py < ps.ph; py++) {
      const at = ps.offset + py * (ps.rowBytes + 1) + 1;
      // Unpack the row to one sample per element.
      if (depth === 8) {
        for (let i = 0; i < row.length; i++) row[i] = raw[at + i];
      } else if (depth === 16) {
        for (let i = 0; i < row.length; i++) row[i] = (raw[at + 2 * i] << 8) | raw[at + 2 * i + 1];
      } else {
        for (let i = 0; i < row.length; i++) row[i] = (raw[at + ((i * depth) >> 3)] >> (8 - depth - ((i * depth) & 7))) & maxSample;
      }
      const y = ps.y0 + py * ps.dy;
      for (let px = 0; px < ps.pw; px++) {
        const p = (y * width + ps.x0 + px * ps.dx) * 4;
        const s = px * channels;
        if (colorType === 6) {
          out[p] = to8(row[s]);
          out[p + 1] = to8(row[s + 1]);
          out[p + 2] = to8(row[s + 2]);
          out[p + 3] = to8(row[s + 3]);
        } else if (colorType === 2) {
          out[p] = to8(row[s]);
          out[p + 1] = to8(row[s + 1]);
          out[p + 2] = to8(row[s + 2]);
          out[p + 3] = keyRgb && row[s] === keyRgb[0] && row[s + 1] === keyRgb[1] && row[s + 2] === keyRgb[2] ? 0 : 255;
        } else if (colorType === 3) {
          const v = row[s];
          if (v < palCount && plte) {
            out[p] = plte[v * 3];
            out[p + 1] = plte[v * 3 + 1];
            out[p + 2] = plte[v * 3 + 2];
          }
          out[p + 3] = trns && v < trns.length ? trns[v] : 255; // entries tRNS does not reach are opaque
        } else if (colorType === 4) {
          const g = to8(row[s]);
          out[p] = g;
          out[p + 1] = g;
          out[p + 2] = g;
          out[p + 3] = to8(row[s + 1]);
        } else {
          const g = to8(row[s]);
          out[p] = g;
          out[p + 1] = g;
          out[p + 2] = g;
          out[p + 3] = row[s] === keyGray ? 0 : 255;
        }
      }
    }
  }
  return { width, height, data: out };
}
