// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { buildGif, gifCase, gifCaseIds, gifCases, lzwEncode } from './gif-writer.js';
import { HAS_PIL, HAS_SIPS, makeTempDir, pilCompareGifs, sipsSize, sipsToPng } from './ref-decoders.js';

const { PNG } = pngjs;
const le16 = (/** @type {Uint8Array} */ b, /** @type {number} */ o) => b[o] | (b[o + 1] << 8);

/**
 * LZW decoder written separately from the encoder: the standard algorithm, widening the code size
 * when the next free code reaches 2^size. Returns the indices and how many clear codes it saw.
 * @param {Uint8Array} data @param {number} minCodeSize
 */
function lzwDecode(data, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const expand = (/** @type {number} */ code) => {
    /** @type {number[]} */
    const out = [];
    for (let c = code; ; c = prefix[c]) {
      if (c < clear) { out.push(c); break; }
      out.push(suffix[c]);
    }
    return out.reverse();
  };
  /** @type {number[]} */
  const out = [];
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let clears = 0;
  let widest = size;
  let bits = 0;
  let nbits = 0;
  let p = 0;
  for (;;) {
    while (nbits < size && p < data.length) { bits |= data[p++] << nbits; nbits += 8; }
    if (nbits < size) throw new Error('LZW data ended without an end-of-information code');
    const code = bits & ((1 << size) - 1);
    bits >>>= size;
    nbits -= size;
    if (code === clear) { size = minCodeSize + 1; next = eoi + 1; prev = -1; clears++; continue; }
    if (code === eoi) break;
    if (prev === -1) { out.push(code); prev = code; continue; }
    if (code > next) throw new Error(`LZW code ${code} beyond the table (${next})`);
    const entry = code < next ? expand(code) : [...expand(prev), expand(prev)[0]];
    for (const v of entry) out.push(v);
    if (next < 4096) { prefix[next] = prev; suffix[next] = entry[0]; next++; }
    if (next === 1 << size && size < 12) size++;
    if (size > widest) widest = size;
    prev = code;
  }
  return { indices: Uint8Array.from(out), clears, widest };
}

/**
 * A structural walk of a GIF with no dependence on the writer.
 * @param {Uint8Array} b
 */
function walkGif(b) {
  expect(String.fromCharCode(...b.subarray(0, 6))).toBe('GIF89a');
  const lsd = { width: le16(b, 6), height: le16(b, 8), packed: b[10], background: b[11] };
  let p = 13;
  if (lsd.packed & 0x80) p += 3 * (1 << ((lsd.packed & 7) + 1));
  /** @type {{ loop: number|null, comments: number, unknownApps: number, trailer: boolean }} */
  const info = { loop: null, comments: 0, unknownApps: 0, trailer: false };
  /** @type {Array<{ delay:number, disposal:number, transparent:number|null, hasGce:boolean, x:number, y:number, w:number, h:number, interlaced:boolean, localTable:number, minCode:number, lzw:Uint8Array }>} */
  const frames = [];
  /** @type {{delay:number, disposal:number, transparent:number|null}|null} */
  let gce = null;
  const readBlocks = () => {
    /** @type {number[]} */
    const out = [];
    for (;;) {
      if (p >= b.length) break; // a truncated file ends mid-block
      const n = b[p++];
      if (n === 0) break;
      for (let i = 0; i < n; i++) out.push(b[p++]);
    }
    return Uint8Array.from(out);
  };
  while (p < b.length) {
    const t = b[p++];
    if (t === 0x3b) { info.trailer = true; break; }
    if (t === 0x21) {
      const label = b[p++];
      if (label === 0xf9) {
        expect(b[p]).toBe(4);
        const packed = b[p + 1];
        gce = { delay: le16(b, p + 2), disposal: (packed >> 2) & 7, transparent: packed & 1 ? b[p + 4] : null };
        p += 6;
      } else if (label === 0xff) {
        const n = b[p++];
        const id = String.fromCharCode(...b.subarray(p, p + n));
        p += n;
        const data = readBlocks();
        if (id === 'NETSCAPE2.0' && data[0] === 1) info.loop = data[1] | (data[2] << 8);
        else info.unknownApps++;
      } else if (label === 0xfe) {
        readBlocks();
        info.comments++;
      } else {
        readBlocks();
      }
    } else if (t === 0x2c) {
      const x = le16(b, p), y = le16(b, p + 2), w = le16(b, p + 4), h = le16(b, p + 6), packed = b[p + 8];
      p += 9;
      const localTable = packed & 0x80 ? 1 << ((packed & 7) + 1) : 0;
      p += localTable * 3;
      const minCode = b[p++];
      const lzw = readBlocks();
      frames.push({ ...(gce ?? { delay: 0, disposal: 0, transparent: null }), hasGce: gce !== null, x, y, w, h, interlaced: Boolean(packed & 0x40), localTable, minCode, lzw });
      gce = null;
    } else {
      throw new Error(`unexpected GIF block 0x${t.toString(16)} at ${p - 1}`);
    }
  }
  return { lsd, frames, info };
}

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-gif-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const all = gifCases();
const valid = all.filter((c) => c.valid);
const complete = valid.filter((c) => c.canvases);

describe('GIF catalogue', () => {
  it('has unique ids and covers the card: multi-frame, transparency, disposal, NETSCAPE loop, 600 frames', () => {
    const ids = gifCaseIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['multi-3-no-loop', 'transparent-index', 'disposal-0-unspecified', 'disposal-1-keep', 'disposal-2-background', 'disposal-3-previous', 'netscape-loop-forever', 'netscape-loop-3', 'frames-600', 'frames-512', 'frames-513', 'interlaced', 'local-palettes', 'lzw-table-full-256']) expect(ids).toContain(id);
  });

  it('is deterministic', () => {
    expect(Buffer.compare(gifCase('disposal-3-previous').bytes, gifCase('disposal-3-previous').bytes)).toBe(0);
  });
});

describe('GIF structure, read by an independent walker', () => {
  it.each(valid.map((c) => [c.id, c]))('%s: frame count, geometry and extensions match what was asked for', (_id, c) => {
    const g = walkGif(c.bytes);
    expect(g.info.trailer).toBe(true);
    expect([g.lsd.width, g.lsd.height]).toEqual([c.width, c.height]);
    expect(g.frames.length).toBe(c.frameCount);
    expect(g.info.loop).toBe(c.spec.loop ?? null);
    g.frames.forEach((f, i) => {
      const want = c.frames[i];
      expect([f.x, f.y, f.w, f.h]).toEqual([want.rect.x, want.rect.y, want.rect.w, want.rect.h]);
      if (c.spec.frames[i].gce !== false) {
        expect(f.delay).toBe(want.delay);
        expect(f.disposal).toBe(want.disposal);
        expect(f.transparent).toBe(want.transparent);
      } else {
        expect(f.hasGce).toBe(false);
      }
      expect(f.interlaced).toBe(Boolean(c.spec.frames[i].interlaced));
      expect(f.localTable > 0).toBe(Boolean(c.spec.frames[i].palette));
    });
  });

  it('the 600-frame file has 600 image descriptors (and 512 / 513 sit either side of the cap)', () => {
    expect(walkGif(gifCase('frames-600').bytes).frames.length).toBe(600);
    expect(walkGif(gifCase('frames-512').bytes).frames.length).toBe(512);
    expect(walkGif(gifCase('frames-513').bytes).frames.length).toBe(513);
  });

  it('NETSCAPE2.0 loop counts, comment and unknown application extensions are where they should be', () => {
    expect(walkGif(gifCase('netscape-loop-forever').bytes).info.loop).toBe(0);
    expect(walkGif(gifCase('netscape-loop-3').bytes).info.loop).toBe(3);
    expect(walkGif(gifCase('single-4x4').bytes).info.loop).toBeNull();
    const ext = walkGif(gifCase('comment-and-unknown-extension').bytes).info;
    expect([ext.comments, ext.unknownApps]).toEqual([1, 1]);
  });

  it('minimum code size is at least 2, and covers the palette', () => {
    expect(walkGif(gifCase('palette-2').bytes).frames[0].minCode).toBe(2);
    expect(walkGif(gifCase('palette-16').bytes).frames[0].minCode).toBe(4);
    expect(walkGif(gifCase('palette-256').bytes).frames[0].minCode).toBe(8);
    expect(walkGif(gifCase('palette-3-padded').bytes).frames[0].minCode).toBe(2);
  });

  it('header lies and caps', () => {
    const big = gifCase('declared-30000x30000');
    const g = walkGif(big.bytes);
    expect([g.lsd.width, g.lsd.height, g.frames[0].w, g.frames[0].h]).toEqual([30000, 30000, 30000, 30000]);
    expect(big.bytes.length).toBeLessThan(200);
    expect(big.canvases).toBeNull();
    expect(walkGif(gifCase('truncated-mid-frame').bytes).frames.length).toBeLessThan(3);
    for (const [id, w, h] of /** @type {Array<[string, number, number]>} */ ([['axis-16384x20', 16384, 20], ['axis-16385x20', 16385, 20], ['axis-20x16385', 20, 16385]])) {
      const c = gifCase(id);
      expect([walkGif(c.bytes).lsd.width, walkGif(c.bytes).lsd.height]).toEqual([w, h]);
    }
    expect(walkGif(gifCase('truncated-mid-frame').bytes).info.trailer).toBe(false);
  });
});

describe('GIF LZW, round-tripped through a separate decoder', () => {
  it.each(complete.filter((c) => c.frameCount <= 4).map((c) => [c.id, c]))('%s: every frame decodes back to the indices written', (_id, c) => {
    const g = walkGif(c.bytes);
    g.frames.forEach((f, i) => {
      const { indices } = lzwDecode(f.lzw, f.minCode);
      const src = c.spec.frames[i].indices;
      expect(indices.length).toBe(f.w * f.h);
      let at = 0;
      if (f.interlaced) {
        // stream rows come in passes 0/8, 4/8, 2/4, 1/2
        /** @type {number[]} */
        const order = [];
        for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < f.h; y += st) order.push(y);
        for (const y of order) for (let x = 0; x < f.w; x++) expect(indices[at++]).toBe(src[y * f.w + x]);
      } else {
        for (let k = 0; k < src.length; k++) expect(indices[k]).toBe(src[k]);
      }
    });
  });

  it('a noisy 256-colour frame fills the 4096-entry table and the encoder emits clear codes mid-stream', () => {
    const f = walkGif(gifCase('lzw-table-full-256').bytes).frames[0];
    const { clears, indices } = lzwDecode(f.lzw, f.minCode);
    expect(clears).toBeGreaterThanOrEqual(2); // the opening clear, then at least one reset
    expect(indices.length).toBe(100 * 100);
    expect(lzwDecode(f.lzw, f.minCode).widest).toBe(12);
  });

  it('4-colour noise widens to 12 bits and resets; 3000 256-colour pixels widen to 12 bits without a reset', () => {
    const a = walkGif(gifCase('lzw-table-full-4').bytes).frames[0];
    const da = lzwDecode(a.lzw, a.minCode);
    expect(da.indices.length).toBe(200 * 150);
    expect(da.widest).toBe(12);
    expect(da.clears).toBeGreaterThanOrEqual(2);
    const b = walkGif(gifCase('lzw-width-12-no-reset').bytes).frames[0];
    const db = lzwDecode(b.lzw, b.minCode);
    expect(db.indices.length).toBe(3000);
    expect(db.widest).toBe(12);
    expect(db.clears).toBe(1);
  });

  it('every stream length round-trips, so the end code has the right width at every table boundary', () => {
    const noise = (/** @type {number} */ n, /** @type {number} */ mod) => Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 7) % mod);
    for (let n = 1; n <= 1200; n++) {
      const px = noise(n, 4);
      expect(Array.from(lzwDecode(lzwEncode(px, 2), 2).indices), `4 colours, ${n} pixels`).toEqual(px);
    }
    for (let n = 1; n <= 2300; n += n < 2100 && n > 1700 ? 1 : 7) {
      const px = noise(n, 256);
      expect(Array.from(lzwDecode(lzwEncode(px, 8), 8).indices), `256 colours, ${n} pixels`).toEqual(px);
    }
  });

  it('single-pixel and tiny streams are valid', () => {
    for (const px of [[0], [1, 1], [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]]) {
      expect(Array.from(lzwDecode(lzwEncode(px, 2), 2).indices)).toEqual(px);
    }
  });
});

describe('GIF expected canvases', () => {
  it('disposal methods leave different canvases (alpha-opaque pixel counts per frame)', () => {
    const opaque = (/** @type {string} */ id) => gifCase(id).canvases?.map((cv) => cv.filter((_, i) => i % 4 === 3 && cv[i] === 255).length);
    expect(opaque('disposal-0-unspecified')).toEqual([36, 36, 36]);
    expect(opaque('disposal-1-keep')).toEqual([36, 36, 36]);
    expect(opaque('disposal-2-background')).toEqual([36, 8, 6]); // frame 1 is 3x3 with a transparent hole; frame 2 is 3x2
    expect(opaque('disposal-3-previous')).toEqual([36, 8, 6]);
  });

  it('a pixel at the transparent index leaves the canvas as it was', () => {
    const keep = gifCase('disposal-1-keep').canvases;
    const hole = (1 + 1) * 6 + (1 + 1); // frame 1's centre pixel is index 0, transparent
    expect(Array.from(keep?.[1].subarray(hole * 4, hole * 4 + 4) ?? [])).toEqual(Array.from(keep?.[0].subarray(hole * 4, hole * 4 + 4) ?? []));
    const bg = gifCase('disposal-2-background').canvases;
    expect(bg?.[1][hole * 4 + 3]).toBe(0);
  });

  it('frame 0 of a partial first frame is transparent outside the rectangle', () => {
    const c = gifCase('first-frame-subrect');
    const a = (/** @type {number} */ x, /** @type {number} */ y) => c.canvases?.[0][(y * 8 + x) * 4 + 3];
    expect([a(0, 0), a(2, 1), a(5, 3), a(6, 3), a(2, 4)]).toEqual([0, 255, 255, 0, 0]);
  });

  it('rgba is frame 0, and a lying or truncated file has no expectation', () => {
    const c = gifCase('multi-3-no-loop');
    expect(Buffer.compare(c.rgba ?? new Uint8Array(), c.canvases?.[0] ?? new Uint8Array(1))).toBe(0);
    expect(gifCase('declared-30000x30000').rgba).toBeNull();
    expect(gifCase('truncated-mid-frame').rgba).toBeNull();
  });

  it('a frame with no colour table at all is refused', () => {
    expect(() => buildGif({ width: 1, height: 1, palette: null, frames: [{ indices: [0] }] })).toThrow();
  });
});

describe.skipIf(!HAS_SIPS)('GIF via sips (ImageIO)', () => {
  it.each(valid.map((c) => [c.id, c]))('%s opens with the right dimensions', (id, c) => {
    const p = join(dir, `${id}.gif`);
    writeFileSync(p, c.bytes);
    expect(sipsSize(p)).toEqual({ width: c.width, height: c.height });
  });

  it.each(complete.filter((c) => c.ref.pil && c.frameCount === 1 && c.width * c.height < 100000).map((c) => [c.id, c]))('%s frame 0 decodes to the expected pixels', (id, c) => {
    const src = join(dir, `${id}.gif`);
    const out = join(dir, `${id}.sips.png`);
    writeFileSync(src, c.bytes);
    expect(sipsToPng(src, out)).toBe(true);
    const png = PNG.sync.read(readFileSync(out));
    const exp = /** @type {Uint8Array} */ (c.canvases?.[0]);
    let wrong = 0;
    for (let i = 0; i < exp.length; i += 4) {
      if ((exp[i + 3] === 0) !== (png.data[i + 3] === 0)) { wrong++; continue; }
      if (exp[i + 3] && (exp[i] !== png.data[i] || exp[i + 1] !== png.data[i + 1] || exp[i + 2] !== png.data[i + 2])) wrong++;
    }
    expect(wrong).toBe(0);
  });
});

describe.skipIf(!HAS_PIL)('GIF via Pillow', () => {
  it('frame counts and every composited frame match, for each case flagged for Pillow', () => {
    const items = complete.filter((c) => c.ref.pil && c.width * c.height < 100000).map((c) => {
      const p = join(dir, `${c.id}.pil.gif`);
      writeFileSync(p, c.bytes);
      return { id: c.id, path: p, width: c.width, height: c.height, canvases: /** @type {Uint8Array[]} */ (c.canvases) };
    });
    const res = pilCompareGifs(items);
    /** @type {string[]} */
    const failures = [];
    for (const it of items) {
      const r = res[it.id];
      const c = gifCase(it.id);
      if (r.error) failures.push(`${it.id}: ${r.error}`);
      else if (r.frames !== c.frameCount) failures.push(`${it.id}: Pillow counts ${r.frames} frames, writer wrote ${c.frameCount}`);
      else if (r.bad?.some((n) => n > 0)) failures.push(`${it.id}: differing pixels per frame ${JSON.stringify(r.bad?.slice(0, 8))}`);
    }
    expect(failures).toEqual([]);
    expect(items.length).toBeGreaterThan(20);
  }, 120000);

  it('Pillow counts 600 frames in the 600-frame file', () => {
    const c = gifCase('frames-600');
    const p = join(dir, 'frames-600.gif');
    writeFileSync(p, c.bytes);
    const r = pilCompareGifs([{ id: 'x', path: p, width: 1, height: 1, canvases: /** @type {Uint8Array[]} */ (c.canvases) }]);
    expect(r.x.frames).toBe(600);
    expect(r.x.bad?.every((n) => n === 0)).toBe(true);
  });
});
