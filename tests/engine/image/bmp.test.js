// @ts-check
// BMP decoder against every case of the W0.4 writer: pixel-exact RGBA, the diagnostics D3 asks for,
// the cap behaviour, and a few hand-built files the writer cannot make.

import { describe, expect, it } from 'vitest';
import { decodeImage, decodeImageWithDiagnostics } from '../../../src/engine/image/decode/index.js';
import { probeImage } from '../../../src/engine/image/probe.js';
import { bmpCase, bmpCaseIds } from '../../support/bmp-writer.js';
import { ByteWriter } from '../../support/bytes.js';
import { diffRgba } from './helpers.js';

const OVER_CAP = new Set(['axis-16385x20-24bpp', 'axis-20x16385-24bpp']);
const codes = (/** @type {{code:string}[]} */ d) => d.map((x) => x.code);

describe('BMP: every writer case decodes to the writer\'s pixels', () => {
  it.each(bmpCaseIds().filter((id) => !id.startsWith('declared-') && !OVER_CAP.has(id)))('%s', (id) => {
    const c = bmpCase(id);
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image, `${id}: ${JSON.stringify(diagnostics)}`).not.toBeNull();
    if (!image || !c.rgba) throw new Error('unreachable');
    expect([image.width, image.height]).toEqual([c.width, c.height]);
    expect(diffRgba(image.data, c.rgba, c.width), id).toBeNull();

    // diagnostics: exactly the ones D3 names
    const got = codes(diagnostics);
    expect(got.filter((x) => x === 'image-bmp-alpha-ignored').length, 'alpha diagnostic').toBe(c.alphaNonZero ? 1 : 0);
    expect(got.includes('image-bmp-rle-truncated')).toBe(c.rleStatus === 'truncated');
    expect(got.includes('image-bmp-rle-overrun')).toBe(c.rleStatus === 'overrun');
    // alpha is forced to 255 for every pixel the file wrote
    for (let i = 3; i < image.data.length; i += 4) {
      if (c.written && c.written[i >> 2] && image.data[i] !== 255) throw new Error(`${id}: alpha ${image.data[i]} at pixel ${i >> 2}`);
    }
    // the probe agrees with the decoder
    expect(probeImage(c.bytes)).toEqual({ format: 'bmp', width: c.width, height: c.height });
    // indexed form: 8-bit images only, complete images only
    const complete = !c.written || c.written.every((v) => v === 1);
    if (c.bpp === 8 && complete) {
      expect(image.indexed, 'indexed').toBeDefined();
      expect(Array.from(/** @type {any} */ (image.indexed).indices)).toEqual(Array.from(/** @type {any} */ (c.indices)));
      const pal = /** @type {any} */ (image.indexed).palette;
      expect(pal.length).toBe(768);
      c.palette?.forEach(([r, g, b], k) => expect([pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]]).toEqual([r, g, b]));
      for (let k = (c.palette?.length ?? 0) * 3; k < 768; k++) expect(pal[k]).toBe(0);
    } else {
      expect(image.indexed).toBeUndefined();
    }
  });
});

describe('BMP: the D3 pixel rules', () => {
  it('16-bit BI_RGB is X1R5G5B5 and BITFIELDS 5-6-5 widens by bit replication', () => {
    // one pixel of each: word 0x7FFF is white in 555, 0xFFFF white in 565; 0x0421 is (1,1,1) in 555
    const make = (/** @type {number} */ word, /** @type {boolean} */ bitfields) => {
      const w = new ByteWriter();
      const hdr = 40;
      const masks = bitfields ? 12 : 0;
      w.ascii('BM').u32(14 + hdr + masks + 4).u32(0).u32(14 + hdr + masks);
      w.u32(hdr).i32(1).i32(1).u16(1).u16(16).u32(bitfields ? 3 : 0).u32(4).u32(0).u32(0).u32(0).u32(0);
      if (bitfields) w.u32(0xf800).u32(0x07e0).u32(0x001f);
      w.u16(word).u16(0);
      return w.toBytes();
    };
    const px = (/** @type {number} */ word, /** @type {boolean} */ bf) => Array.from(/** @type {any} */ (decodeImage(make(word, bf))).data);
    expect(px(0x7fff, false)).toEqual([255, 255, 255, 255]);
    expect(px(0x0421, false)).toEqual([8, 8, 8, 255]); // 5 bits: 1 -> 0b00001000
    expect(px(0x4210, false)).toEqual([132, 132, 132, 255]); // 16 -> 0b10000100
    expect(px(0xffff, true)).toEqual([255, 255, 255, 255]);
    expect(px(0x0020, true)).toEqual([0, 4, 0, 255]); // 565 green keeps 6 bits: 1 -> 0b00000100
    expect(px(0x8000, false)).toEqual([0, 0, 0, 255]); // the X bit is ignored
  });

  it('a channel wider than 8 bits keeps its top byte', () => {
    const w = new ByteWriter();
    w.ascii('BM').u32(14 + 40 + 12 + 4).u32(0).u32(14 + 40 + 12);
    w.u32(40).i32(1).i32(1).u16(1).u16(32).u32(3).u32(4).u32(0).u32(0).u32(0).u32(0);
    w.u32(0x3ff00000).u32(0x000ffc00).u32(0x000003ff); // 10-10-10
    w.u32((0x3ff << 20) | (0x200 << 10) | 0x001);
    expect(Array.from(/** @type {any} */ (decodeImage(w.toBytes())).data)).toEqual([255, 128, 0, 255]);
  });

  it('a negative height on an RLE image reads the stream top-first, the mirror of the bottom-up reading', () => {
    const c = bmpCase('rle8-encoded-runs');
    const flipped = c.bytes.slice();
    new DataView(flipped.buffer).setInt32(22, -c.height, true);
    const up = /** @type {any} */ (decodeImage(c.bytes)).data;
    const down = /** @type {any} */ (decodeImage(flipped)).data;
    const rowBytes = c.width * 4;
    for (let y = 0; y < c.height; y++) {
      expect(Array.from(down.subarray(y * rowBytes, (y + 1) * rowBytes))).toEqual(Array.from(up.subarray((c.height - 1 - y) * rowBytes, (c.height - y) * rowBytes)));
    }
  });

  it('a palette index past the table paints black', () => {
    const c = bmpCase('8bpp-short-palette');
    const bytes = c.bytes.slice();
    const off = new DataView(bytes.buffer).getUint32(10, true);
    bytes[off] = 200; // the first stored row, first pixel; the palette has 16 entries
    const img = /** @type {any} */ (decodeImage(bytes));
    const y = c.height - 1; // first stored row is the bottom row
    const p = y * c.width * 4;
    expect(Array.from(img.data.subarray(p, p + 4))).toEqual([0, 0, 0, 255]);
  });

  it('a bad bfOffBits falls back to the layout the headers imply', () => {
    const c = bmpCase('24bpp-w5');
    const bytes = c.bytes.slice();
    new DataView(bytes.buffer).setUint32(10, 0, true);
    expect(diffRgba(/** @type {any} */ (decodeImage(bytes)).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
  });
});

describe('BMP: damaged files', () => {
  it('uncompressed data that stops early keeps the rows that arrived and says so', () => {
    const c = bmpCase('24bpp-w5');
    const rowBytes = ((5 * 24 + 31) >>> 5) << 2;
    const off = new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(10, true);
    const cut = c.bytes.slice(0, off + rowBytes * 2 + 3); // two full rows and a bit
    const { image, diagnostics } = decodeImageWithDiagnostics(cut);
    expect(codes(diagnostics)).toContain('image-bmp-truncated');
    const data = /** @type {any} */ (image).data;
    // stored rows 0 and 1 are the bottom two rows of the image
    const rgba = /** @type {any} */ (c.rgba);
    const rb = 5 * 4;
    expect(Array.from(data.subarray((c.height - 1) * rb))).toEqual(Array.from(rgba.subarray((c.height - 1) * rb)));
    expect(Array.from(data.subarray((c.height - 2) * rb, (c.height - 1) * rb))).toEqual(Array.from(rgba.subarray((c.height - 2) * rb, (c.height - 1) * rb)));
    expect(Array.from(data.subarray(0, rb))).toEqual(new Array(rb).fill(0));
  });

  it('a final row missing its padding still decodes completely', () => {
    const c = bmpCase('24bpp-w5');
    const cut = c.bytes.slice(0, c.bytes.length - 1); // w=5 at 24 bpp: 15 data bytes, 1 pad byte
    const { image, diagnostics } = decodeImageWithDiagnostics(cut);
    expect(codes(diagnostics)).not.toContain('image-bmp-truncated');
    expect(diffRgba(/** @type {any} */ (image).data, /** @type {any} */ (c.rgba), c.width)).toBeNull();
  });

  it('no pixel data, or less than one row, is a failed decode', () => {
    const c = bmpCase('24bpp-w5');
    const off = new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(10, true);
    expect(decodeImage(c.bytes.slice(0, off))).toBeNull();
    expect(decodeImage(c.bytes.slice(0, off + 10))).toBeNull();
  });

  it('shorter than the file header, an unknown DIB header and unsupported compression are failed decodes', () => {
    expect(decodeImage(Uint8Array.of(0x42, 0x4d, 0, 0))).toBeNull();
    const c = bmpCase('24bpp-w5');
    const odd = c.bytes.slice();
    new DataView(odd.buffer).setUint32(14, 41, true);
    expect(decodeImageWithDiagnostics(odd).diagnostics[0].code).toBe('image-unsupported');
    const jpegInside = c.bytes.slice();
    new DataView(jpegInside.buffer).setUint32(30, 4, true); // BI_JPEG
    expect(decodeImage(jpegInside)).toBeNull();
  });

  it('an RLE stream that holds one command leaves the rest transparent, not missing', () => {
    const c = bmpCase('rle8-encoded-runs'); // 8 x 4; the first command is a run of 8 pixels of index 1
    const off = new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(10, true);
    expect(decodeImage(c.bytes.slice(0, off))).toBeNull(); // no stream at all
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes.slice(0, off + 2));
    // the cut falls on a command boundary with no end-of-bitmap marker: still one diagnostic (D3)
    expect(codes(diagnostics)).toEqual(['image-bmp-rle-truncated']);
    const data = /** @type {any} */ (image).data;
    const rowBytes = c.width * 4;
    const bottom = Array.from(data.subarray((c.height - 1) * rowBytes));
    expect(bottom.filter((_, k) => k % 4 === 3)).toEqual(new Array(8).fill(255));
    expect(Array.from(data.subarray(0, (c.height - 1) * rowBytes)).every((v) => v === 0)).toBe(true);
  });

  it('an RLE stream that holds every row but has no final end-of-bitmap marker is complete, no diagnostic', () => {
    // Each case ends in 00 01 (EOB); dropping it leaves the stream ending on a command boundary.
    for (const id of ['rle8-encoded-runs', 'rle8-eol-eob-only-tail', 'rle4-encoded-runs']) {
      const c = bmpCase(id);
      const whole = decodeImageWithDiagnostics(c.bytes);
      const cut = decodeImageWithDiagnostics(c.bytes.slice(0, c.bytes.length - 2));
      expect(Array.from(c.bytes.slice(-2)), `${id}: ends in EOB`).toEqual([0, 1]);
      expect(codes(cut.diagnostics), id).toEqual([]);
      expect(cut.image, id).not.toBeNull();
      expect(Array.from(/** @type {any} */ (cut.image).data), id).toEqual(Array.from(/** @type {any} */ (whole.image).data));
    }
  });

  it('an RLE stream that stops after fewer rows than the bitmap has is truncated, whatever the cut point', () => {
    // rle8-encoded-runs is 8 x 4, 20 stream bytes: run, EOL, run, run, EOL, run, run, EOL, run, EOB.
    // Cut after each command. Only the cuts at 18 (last row filled) and 20 (the whole stream) are complete.
    const c = bmpCase('rle8-encoded-runs');
    const off = new DataView(c.bytes.buffer, c.bytes.byteOffset).getUint32(10, true);
    expect(c.bytes.length - off).toBe(20);
    const expected = new Map([[2, true], [4, true], [6, true], [8, true], [10, true], [12, true], [14, true], [16, true], [18, false], [20, false]]);
    for (const [cut, truncated] of expected) {
      const { diagnostics } = decodeImageWithDiagnostics(c.bytes.slice(0, off + cut));
      expect(codes(diagnostics).includes('image-bmp-rle-truncated'), `cut at stream byte ${cut}`).toBe(truncated);
    }
  });
});
