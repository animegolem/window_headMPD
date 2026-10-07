// @ts-check
// JPEG decoding through jpeg-js: baseline and progressive fixtures, the axis caps (checked from our
// own SOF scan, before the library allocates), and header lies.

import { describe, expect, it } from 'vitest';
import { encode } from 'jpeg-js';
import { decodeImage, decodeImageWithDiagnostics } from '../../../src/engine/image/decode/index.js';
import { jpegSize, probeImage } from '../../../src/engine/image/probe.js';
import { JPEGS, JPEG_H, JPEG_W, gradientAt } from './jpeg-fixtures.js';

const codes = (/** @type {{code:string}[]} */ d) => d.map((x) => x.code);

/** Largest per-channel distance from the source gradient over RGB. @param {Uint8ClampedArray} data */
function distanceFromGradient(data) {
  let worst = 0;
  for (let y = 0; y < JPEG_H; y++) {
    for (let x = 0; x < JPEG_W; x++) {
      const want = gradientAt(x, y);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(data[(y * JPEG_W + x) * 4 + c] - want[c]));
    }
  }
  return worst;
}

/** @param {Uint8Array} bytes */
const decodeOk = (bytes) => {
  const { image, diagnostics } = decodeImageWithDiagnostics(bytes);
  if (!image) throw new Error(`no image: ${JSON.stringify(diagnostics)}`);
  return image;
};

describe('JPEG: baseline and progressive', () => {
  it.each(Object.keys(JPEGS))('%s decodes to the right size, opaque, and close to the source', (name) => {
    const bytes = /** @type {any} */ (JPEGS)[name];
    const img = decodeOk(bytes);
    expect([img.width, img.height]).toEqual([JPEG_W, JPEG_H]);
    expect(img.data).toBeInstanceOf(Uint8ClampedArray);
    expect(img.data.length).toBe(JPEG_W * JPEG_H * 4);
    for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
    expect(probeImage(bytes)).toEqual({ format: 'jpeg', width: JPEG_W, height: JPEG_H });
    if (name.startsWith('gray')) {
      for (let i = 0; i < img.data.length; i += 4) expect([img.data[i], img.data[i + 1]]).toEqual([img.data[i + 2], img.data[i + 2]]);
    } else {
      expect(distanceFromGradient(img.data), name).toBeLessThan(name.endsWith('420') ? 14 : 6);
    }
  });

  it.each([['baseline444', 'progressive444'], ['baseline420', 'progressive420'], ['grayBaseline', 'grayProgressive']])('%s and %s carry the same coefficients, so they decode identically', (a, b) => {
    const A = decodeOk(/** @type {any} */ (JPEGS)[a]);
    const B = decodeOk(/** @type {any} */ (JPEGS)[b]);
    expect(Array.from(B.data)).toEqual(Array.from(A.data));
  });

  it('the progressive fixtures really are progressive (SOF2), the baseline ones SOF0', () => {
    const marker = (/** @type {Uint8Array} */ b) => {
      for (let i = 2; i < b.length - 1; i++) if (b[i] === 0xff && (b[i + 1] === 0xc0 || b[i + 1] === 0xc2)) return b[i + 1];
      return 0;
    };
    expect(marker(JPEGS.progressive420)).toBe(0xc2);
    expect(marker(JPEGS.progressive444)).toBe(0xc2);
    expect(marker(JPEGS.grayProgressive)).toBe(0xc2);
    expect(marker(JPEGS.baseline444)).toBe(0xc0);
    expect(marker(JPEGS.baseline420)).toBe(0xc0);
  });

  it('a JPEG cut in the scan data does not throw', () => {
    const bytes = JPEGS.baseline444;
    for (const keep of [bytes.length - 30, bytes.length >> 1]) {
      const r = decodeImageWithDiagnostics(bytes.slice(0, keep));
      if (r.image) expect([r.image.width, r.image.height]).toEqual([JPEG_W, JPEG_H]);
      else expect(codes(r.diagnostics)).toEqual(['image-corrupt']);
    }
  });

  it('garbage after the JPEG signature is a failed decode, not a throw', () => {
    const junk = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 1, 2, 0xff, 0xd9]);
    expect(decodeImage(junk)).toBeNull();
    expect(decodeImage(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('JPEG: caps and header lies', () => {
  /** @param {number} w @param {number} h */
  const encoded = (w, h) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([(i * 7) & 255, (i * 3) & 255, (i * 11) & 255, 255], i * 4);
    return new Uint8Array(encode({ data, width: w, height: h }, 60).data);
  };

  it('16,384 x 20 decodes and 16,385 x 20 and 20 x 16,385 are capped', () => {
    const ok = decodeOk(encoded(16384, 20));
    expect([ok.width, ok.height]).toEqual([16384, 20]);
    for (const [w, h] of [[16385, 20], [20, 16385]]) {
      const bytes = encoded(w, h);
      expect(jpegSize(bytes)).toEqual({ width: w, height: h });
      expect(probeImage(bytes)).toBeNull();
      const { image, diagnostics } = decodeImageWithDiagnostics(bytes);
      expect(image).toBeNull();
      expect(codes(diagnostics)).toEqual(['image-over-cap']);
    }
  });

  it('a frame header rewritten to 30000 x 30000 is refused from the header', () => {
    const lie = JPEGS.baseline444.slice();
    const sof = lie.findIndex((v, i) => v === 0xff && lie[i + 1] === 0xc0);
    lie[sof + 5] = 30000 >> 8; lie[sof + 6] = 30000 & 255; // height
    lie[sof + 7] = 30000 >> 8; lie[sof + 8] = 30000 & 255; // width
    expect(jpegSize(lie)).toEqual({ width: 30000, height: 30000 });
    expect(probeImage(lie)).toBeNull();
    expect(codes(decodeImageWithDiagnostics(lie).diagnostics)).toEqual(['image-over-cap']);
  });

  it('a frame height of 0 (a DNL segment would follow) is a failed probe and decode', () => {
    const zero = JPEGS.baseline444.slice();
    const sof = zero.findIndex((v, i) => v === 0xff && zero[i + 1] === 0xc0);
    zero[sof + 5] = 0; zero[sof + 6] = 0;
    expect(probeImage(zero)).toBeNull();
    expect(decodeImage(zero)).toBeNull();
  });

  /** A baseline fixture whose frame header claims `w` x `h`; its scan data does not fit that size. @param {number} w @param {number} h */
  const lying = (w, h) => {
    const lie = JPEGS.baseline444.slice();
    const sof = lie.findIndex((v, i) => v === 0xff && lie[i + 1] === 0xc0);
    lie[sof + 5] = h >> 8; lie[sof + 6] = h & 255; lie[sof + 7] = w >> 8; lie[sof + 8] = w & 255;
    return lie;
  };

  it('the area cap is the one size authority: the megapixel guard of jpeg-js never fires inside it', () => {
    // jpeg-js counts a megapixel as 1,000,000 px, so a limit of 16 MP would refuse everything between
    // 16,000,000 and 16,777,216 px that the probe accepts. The limit is 16.78 MP: a header inside the
    // cap reaches the library, which then fails on the scan data that does not fit the lie. (A *real*
    // image this size is out of reach for a unit test: encoding one takes seconds, and a 4:4:4 file
    // above about 12.5 MP trips jpeg-js's own 256 MiB memory guard first.)
    for (const [w, h] of [[5500, 3000], [4096, 4096]]) { // 16,500,000 px, and exactly 16,777,216
      const bytes = lying(w, h);
      expect(probeImage(bytes), `${w} x ${h}`).toEqual({ format: 'jpeg', width: w, height: h });
      const { image, diagnostics } = decodeImageWithDiagnostics(bytes);
      expect(image).toBeNull();
      expect(codes(diagnostics)).toEqual(['image-corrupt']);
      expect(diagnostics[0].detail, `${w} x ${h}`).not.toMatch(/maxResolutionInMP/);
    }
  });

  it('one pixel row over the area cap, with both axes legal, is refused from the header with image-over-cap', () => {
    const bytes = lying(4097, 4096); // 16,781,312 px: past the cap, and past jpeg-js's 16.78 MP too
    expect(jpegSize(bytes)).toEqual({ width: 4097, height: 4096 });
    expect(probeImage(bytes)).toBeNull();
    const { image, diagnostics } = decodeImageWithDiagnostics(bytes);
    expect(image).toBeNull();
    expect(codes(diagnostics)).toEqual(['image-over-cap']);
  });
});
