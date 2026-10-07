// @ts-check
// GIF decoder against every case of the W0.4 writer: frame 0, the composited frames, the four
// disposal methods, local palettes, interlacing, the LZW table limits, the 512-frame cap.

import { describe, expect, it } from 'vitest';
import { decodeImage, decodeImageWithDiagnostics } from '../../../src/engine/image/decode/index.js';
import { probeImage } from '../../../src/engine/image/probe.js';
import { buildGif, gifCase, gifCaseIds, lzwEncode } from '../../support/gif-writer.js';
import { diffRgba } from './helpers.js';

const OVER_CAP = new Set(['axis-16385x20', 'axis-20x16385']);
const codes = (/** @type {{code:string}[]} */ d) => d.map((x) => x.code);

describe('GIF: every writer case decodes to the writer\'s canvases', () => {
  const valid = gifCaseIds().filter((id) => !id.startsWith('declared-') && !id.startsWith('truncated-') && !OVER_CAP.has(id));
  it.each(valid)('%s', (id) => {
    const c = gifCase(id);
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image, `${id}: ${JSON.stringify(diagnostics)}`).not.toBeNull();
    if (!image || !c.canvases) throw new Error('unreachable');
    expect([image.width, image.height]).toEqual([c.width, c.height]);
    expect(diffRgba(image.data, c.canvases[0], c.width), `${id} frame 0`).toBeNull();
    expect(probeImage(c.bytes)).toEqual({ format: 'gif', width: c.width, height: c.height });

    const kept = Math.min(c.frameCount, 512);
    if (c.frameCount < 2) {
      expect(image.frames, 'a still image has no frames list').toBeUndefined();
    } else {
      const frames = /** @type {NonNullable<typeof image.frames>} */ (image.frames);
      expect(frames.length).toBe(kept);
      expect(frames[0].data, 'frame 0 shares data').toBe(image.data);
      for (let k = 0; k < kept; k++) {
        expect(diffRgba(frames[k].data, c.canvases[k], c.width), `${id} frame ${k}`).toBeNull();
        expect(frames[k].delayMs).toBe(c.frames[k].delay * 10);
      }
    }
    expect(codes(diagnostics).includes('image-gif-frame-cap')).toBe(c.frameCount > 512);
  });
});

describe('GIF: caps and damage', () => {
  it('the 600-frame GIF comes back with exactly 512 frames and one note', () => {
    const c = gifCase('frames-600');
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(/** @type {any} */ (image).frames.length).toBe(512);
    expect(codes(diagnostics)).toEqual(['image-gif-frame-cap']);
  });

  it('a custom frame cap applies', () => {
    const c = gifCase('frames-3');
    const img = /** @type {any} */ (decodeImageWithDiagnostics(c.bytes, { maxGifFrames: 2 }).image);
    expect(img.frames.length).toBe(2);
  });

  it('a GIF cut mid-frame keeps what arrived and does not throw', () => {
    const c = gifCase('truncated-mid-frame');
    const { image, diagnostics } = decodeImageWithDiagnostics(c.bytes);
    expect(image).not.toBeNull();
    expect([/** @type {any} */ (image).width, /** @type {any} */ (image).height]).toEqual([8, 8]);
    expect(codes(diagnostics)).toContain('image-gif-truncated');
  });

  it('a GIF cut inside frame 0 keeps the rows that arrived; one with no pixel data is missing', () => {
    const full = buildGif({ width: 20, height: 20, palette: [[200, 0, 0], [0, 200, 0], [0, 0, 200], [9, 9, 9]], frames: [{ indices: Uint8Array.from({ length: 400 }, (_, i) => (i * 7 + (i >> 4)) & 3) }] });
    const half = full.bytes.slice(0, full.bytes.length - 30);
    const part = /** @type {any} */ (decodeImageWithDiagnostics(half).image);
    expect(part).not.toBeNull();
    const nonEmpty = Array.from({ length: 400 }, (_, i) => part.data[i * 4 + 3]).filter((a) => a === 255).length;
    expect(nonEmpty).toBeGreaterThan(0);
    expect(nonEmpty).toBeLessThan(400);
    // header, table and image descriptor, then nothing
    const noData = full.bytes.slice(0, 13 + 12 + 10 + 1);
    expect(decodeImage(noData)).toBeNull();
  });

  it('a frame larger than the canvas is clipped without allocating for the claim', () => {
    // 4 x 4 canvas; the second frame's descriptor claims 65535 x 65535 at (2, 2)
    const base = buildGif({ width: 4, height: 4, palette: [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]], frames: [{ indices: new Uint8Array(16).fill(1) }, { indices: new Uint8Array(4).fill(2), rect: { x: 2, y: 2, w: 2, h: 2 } }] });
    const bytes = base.bytes.slice();
    // find the second image descriptor (0x2C) and rewrite its width and height
    const first = bytes.indexOf(0x2c);
    const second = bytes.indexOf(0x2c, first + 1 + 9);
    expect(second).toBeGreaterThan(first);
    bytes[second + 5] = 0xff; bytes[second + 6] = 0xff; bytes[second + 7] = 0xff; bytes[second + 8] = 0xff;
    const before = process.memoryUsage().arrayBuffers;
    const img = /** @type {any} */ (decodeImage(bytes));
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(2 * 1024 * 1024);
    expect(img).not.toBeNull();
    expect(img.frames.length).toBe(2);
    // the 2 x 2 patch of frame 1 only reached as far as the data went (4 pixels, row-major from the top-left of the claim)
    expect(Array.from(img.frames[1].data.subarray(0, 4))).toEqual([4, 5, 6, 255]);
  });

  it('a screen size of 0 x 0 takes the first frame\'s extents, and probe agrees', () => {
    const c = buildGif({ width: 5, height: 3, palette: [[1, 2, 3], [4, 5, 6]], frames: [{ indices: new Uint8Array(15).fill(1) }] });
    const bytes = c.bytes.slice();
    bytes[6] = bytes[7] = bytes[8] = bytes[9] = 0;
    expect(probeImage(bytes)).toEqual({ format: 'gif', width: 5, height: 3 });
    expect(diffRgba(/** @type {any} */ (decodeImage(bytes)).data, /** @type {any} */ (c.rgba), 5)).toBeNull();
  });

  it('an index past the colour table paints black', () => {
    // 2 x 1, a two-entry table, 2-bit LZW (alphabet of four): codes clear, 3, 1, end
    const bytes = Uint8Array.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0, 100, 100, 100, 200, 200, 200,
      0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 2, 0x5c, 0x0a, 0, 0x3b,
    ]);
    const img = /** @type {any} */ (decodeImage(bytes));
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
  });

  it('the 128 MiB retained-frame budget drops the rest with one note, whether it bites mid-stream or on the last frame', () => {
    // A 3000 x 3000 screen is 36 MB a frame (the budget holds three) and each frame is one pixel, so the
    // file stays tiny. The first frame is always kept; a later one is dropped when it would pass 128 MiB.
    const W = 3000;
    const lzw = Array.from(lzwEncode([1], 2));
    const gif = (/** @type {number} */ n) => {
      const out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, W & 255, W >> 8, W & 255, W >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
      for (let k = 0; k < n; k++) out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, lzw.length, ...lzw, 0);
      out.push(0x3b);
      return Uint8Array.from(out);
    };
    /** @type {[number, number, string[]][]} frames in the file, frames kept, diagnostics */
    const table = [[3, 3, []], [4, 3, ['image-gif-frames-memory']], [5, 3, ['image-gif-frames-memory']]];
    for (const [n, kept, want] of table) {
      const { image, diagnostics } = decodeImageWithDiagnostics(gif(n));
      expect(/** @type {any} */ (image).frames.length, `${n} frames in`).toBe(kept);
      expect(codes(diagnostics), `${n} frames in`).toEqual(want);
    }
  });

  it('GIF87a and a file with no trailer decode', () => {
    const c = gifCase('single-4x4');
    const a87 = c.bytes.slice();
    a87[4] = 0x37;
    expect(decodeImage(a87)).not.toBeNull();
    expect(decodeImage(c.bytes.slice(0, c.bytes.length - 1))).not.toBeNull();
  });
});
