// @ts-check
// PNG decoder against every case of the W0.4 writer (all colour types and depths, tRNS, Adam7, the
// five filters, split IDAT, ancillary chunks), a second opinion from pngjs, and the IDAT size rules.

import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { zlibSync } from 'fflate';
import { decodeImage, decodeImageWithDiagnostics } from '../../../src/engine/image/decode/index.js';
import { probeImage } from '../../../src/engine/image/probe.js';
import { buildPng, pngCase, pngCaseIds } from '../../support/png-writer.js';
import { diffRgba } from './helpers.js';

const OVER_CAP = new Set(['axis-16385x20-gray-8bit', 'axis-20x16385-gray-8bit']);
const codes = (/** @type {{code:string}[]} */ d) => d.map((x) => x.code);

describe('PNG: every writer case decodes to the writer\'s pixels', () => {
  const valid = pngCaseIds().filter((id) => !id.startsWith('declared-') && !id.startsWith('idat-') && !OVER_CAP.has(id));
  it.each(valid)('%s', (id) => {
    const c = pngCase(id);
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image, `${id}: ${JSON.stringify(diagnostics)}`).not.toBeNull();
    if (!image || !c.rgba) throw new Error('unreachable');
    expect([image.width, image.height]).toEqual([c.width, c.height]);
    expect(diffRgba(image.data, c.rgba, c.width), id).toBeNull();
    expect(probeImage(c.bytes)).toEqual({ format: 'png', width: c.width, height: c.height });
    expect(diagnostics).toEqual([]);
  });

  // pngjs is an independent decoder: colour-managed paths aside, it must agree on the RGBA of the
  // common cases, which also guards against the writer and the decoder sharing a misreading.
  it.each(['rgba-8bit', 'rgb-8bit', 'indexed-8bit', 'gray-8bit', 'graya-8bit', 'rgb-16bit-trns', 'indexed-4bit-trns-partial', 'adam7-rgba-8bit-11x9', 'rgb-8bit-filter-4'])('agrees with pngjs on %s', (id) => {
    const c = pngCase(id);
    const ref = PNG.sync.read(Buffer.from(c.bytes));
    const img = /** @type {any} */ (decodeImage(c.bytes));
    // pngjs zeroes the colour under a tRNS-keyed pixel; we keep it, and it is invisible either way
    expect(diffRgba(img.data, ref.data, c.width, { ignoreRgbWhereAlpha0: true }), id).toBeNull();
  });
});

describe('PNG: size rules', () => {
  it('an IDAT that inflates past the IHDR size is a failed decode with its own diagnostic', () => {
    const c = pngCase('idat-overflow');
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image).toBeNull();
    expect(codes(diagnostics)).toEqual(['image-png-idat-overflow']);
  });

  it('an IDAT that inflates to less than IHDR promises, or is cut short, is a failed decode', () => {
    expect(decodeImage(pngCase('idat-underflow').bytes)).toBeNull();
    expect(decodeImage(pngCase('idat-truncated-stream').bytes)).toBeNull();
  });

  it('a decompression bomb allocates for the header, not for the stream', () => {
    // 4 x 4 grey promises 20 bytes; the stream inflates to 40 MB of zeros from a few dozen KB
    const bomb = pngCase('idat-overflow'); // same header shape
    const raw = new Uint8Array(40 * 1024 * 1024);
    const bytes = buildPng({ width: 4, height: 4, colorType: 0, bitDepth: 8, rawOverride: raw }).bytes;
    expect(bytes.length).toBeLessThan(100_000);
    const before = process.memoryUsage().arrayBuffers;
    expect(decodeImage(bytes)).toBeNull();
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(2 * 1024 * 1024);
    expect(bomb.valid).toBe(false);
  });

  it('a stream far too small for a large header is refused before anything is allocated', () => {
    const tiny = zlibSync(new Uint8Array(10));
    const c = buildPng({ width: 16000, height: 1000, colorType: 6, bitDepth: 8, rawOverride: new Uint8Array(10) });
    expect(c.bytes.length).toBeGreaterThan(tiny.length);
    const before = process.memoryUsage().arrayBuffers;
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image).toBeNull();
    expect(codes(diagnostics)).toEqual(['image-corrupt']);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(1024 * 1024);
  });

  it('PNG metadata never changes the pixels: gAMA 0.5 leaves grey values as stored', () => {
    const c = pngCase('gray-8bit-gamma-0.5');
    expect(diffRgba(/** @type {any} */ (decodeImage(c.bytes)).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
  });
});

describe('PNG: tolerance', () => {
  it('ignores CRCs, a missing IEND and bytes after IEND', () => {
    const c = pngCase('rgba-8bit');
    const noIend = c.bytes.slice(0, c.bytes.length - 12);
    const trailing = new Uint8Array([...c.bytes, 1, 2, 3, 4, 5]);
    expect(decodeImage(noIend)).not.toBeNull();
    expect(diffRgba(/** @type {any} */ (decodeImage(noIend)).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
    expect(diffRgba(/** @type {any} */ (decodeImage(trailing)).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
  });

  it('a wrong CRC on a chunk does not stop the decode', () => {
    const c = pngCase('rgb-8bit');
    const bytes = c.bytes.slice();
    // IHDR is bytes 8..33: length(4) type(4) data(13) crc(4); damage its CRC
    for (let i = 29; i < 33; i++) bytes[i] ^= 0xa5;
    expect(diffRgba(/** @type {any} */ (decodeImage(bytes)).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
  });

  it('a damaged signature, no IHDR first, no IDAT and a missing palette are failed decodes', () => {
    const c = pngCase('indexed-8bit');
    expect(decodeImage(c.bytes.slice(1))).toBeNull();
    const noPlte = buildPng({ width: 3, height: 3, colorType: 3, bitDepth: 8, palette: [[1, 2, 3]], samples: new Array(9).fill(0) }).bytes;
    expect(decodeImage(noPlte)).not.toBeNull();
    // strip the PLTE chunk (length 3, type, data, crc = 15 bytes) from the file
    const at = noPlte.findIndex((_, i) => noPlte[i] === 0x50 && noPlte[i + 1] === 0x4c && noPlte[i + 2] === 0x54 && noPlte[i + 3] === 0x45);
    const stripped = new Uint8Array([...noPlte.slice(0, at - 4), ...noPlte.slice(at + 4 + 3 + 4)]);
    expect(decodeImage(stripped)).toBeNull();
    expect(decodeImage(c.bytes.slice(0, 33))).toBeNull(); // IHDR only
  });

  it('a tRNS table shorter than the palette leaves the other entries opaque', () => {
    const c = buildPng({ width: 2, height: 1, colorType: 3, bitDepth: 8, palette: [[10, 20, 30], [40, 50, 60]], samples: [1, 0], trns: [7] });
    const img = /** @type {any} */ (decodeImage(c.bytes));
    expect(Array.from(img.data)).toEqual([40, 50, 60, 255, 10, 20, 30, 7]); // pixel 0 is entry 1 (no tRNS entry), pixel 1 entry 0 with alpha 7
  });
});
