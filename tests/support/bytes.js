// @ts-check
// Private helpers shared by the writers in this directory. Browser-safe on purpose (no `node:`
// imports, no Buffer): skinlab fixture cases run in a Chromium page and import these writers too.

/** Standard CRC-32 (IEEE 802.3), the one PNG and zip both use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** One raw CRC table step, without the pre/post inversion (ZipCrypto's key schedule uses it). */
export const crcStep = (/** @type {number} */ c, /** @type {number} */ byte) => (CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)) >>> 0;

/**
 * @param {Uint8Array} bytes
 * @param {number} [crc] running value from a previous call, for chunked input
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Growable little-endian byte sink. */
export class ByteWriter {
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.len = 0;
  }
  /** @param {number} extra */
  #grow(extra) {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  get length() { return this.len; }
  /** @param {number} v */
  u8(v) { this.#grow(1); this.buf[this.len++] = v & 0xff; return this; }
  /** @param {number} v */
  u16(v) { return this.u8(v).u8(v >>> 8); }
  /** @param {number} v */
  u32(v) { return this.u16(v).u16(v >>> 16); }
  /** @param {number} v */
  i32(v) { return this.u32(v >>> 0); }
  /** @param {number} v unsigned, may exceed 2^32 (used by ZIP64 fields) */
  u64(v) { return this.u32(v % 0x100000000).u32(Math.floor(v / 0x100000000)); }
  /** @param {Uint8Array|ArrayLike<number>} a */
  bytes(a) {
    this.#grow(a.length);
    this.buf.set(a, this.len);
    this.len += a.length;
    return this;
  }
  /** @param {string} s ASCII only */
  ascii(s) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  /** Big-endian, for PNG. @param {number} v */
  u32be(v) { return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v); }
  /** @param {number} n @param {number} [fill] */
  pad(n, fill = 0) { for (let i = 0; i < n; i++) this.u8(fill); return this; }
  /** Overwrite a u32 already written. @param {number} at @param {number} v */
  patch32(at, v) {
    this.buf[at] = v; this.buf[at + 1] = v >>> 8; this.buf[at + 2] = v >>> 16; this.buf[at + 3] = v >>> 24;
  }
  /** @returns {Uint8Array} a copy sized to the content */
  toBytes() { return this.buf.slice(0, this.len); }
}

/** @param {...Uint8Array} parts */
export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** @param {string} s ASCII @returns {Uint8Array} */
export function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Deterministic PRNG (mulberry32), so every fixture is byte-identical between runs.
 * @param {number} seed @returns {() => number} floats in [0, 1) */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} n @param {number} seed @returns {Uint8Array} incompressible-looking bytes */
export function noiseBytes(n, seed) {
  const r = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 256) | 0;
  return out;
}

/**
 * Widen an n-bit channel value to 8 bits by bit replication, the usual rule (libpng, PIL, Webamp).
 * ENGINE D3 does not name the rule for 16-bit BMP and sub-8-bit channels, so the writers' expected
 * pixels use this one and say so; W1.3 must match it or raise the gap.
 * @param {number} v @param {number} bits 1..8
 */
export function widenTo8(v, bits) {
  if (bits >= 8) return v >>> (bits - 8);
  let out = 0;
  for (let shift = 8 - bits; ; shift -= bits) {
    out |= shift >= 0 ? v << shift : v >>> -shift;
    if (shift <= 0) break;
  }
  return out & 0xff;
}

/** @param {number} mask @returns {{shift:number,bits:number}} contiguous mask geometry */
export function maskGeometry(mask) {
  if (!mask) return { shift: 0, bits: 0 };
  let shift = 0;
  while (!((mask >>> shift) & 1)) shift++;
  let bits = 0;
  while ((mask >>> (shift + bits)) & 1) bits++;
  return { shift, bits };
}

/**
 * A lazy catalog: fixtures are built on demand, so importing a writer costs nothing and the 16,385-
 * pixel-wide and 4,097-entry cases exist only in the tests that ask for them.
 * @template T
 * @param {Array<{ id: string, doc: string, build: () => T }>} defs
 */
export function catalog(defs) {
  const byId = new Map();
  for (const d of defs) {
    if (byId.has(d.id)) throw new Error(`duplicate fixture id ${d.id}`);
    byId.set(d.id, d);
  }
  return {
    ids: () => defs.map((d) => d.id),
    /** @param {string} id */
    get(id) {
      const d = byId.get(id);
      if (!d) throw new Error(`unknown fixture id ${id}`);
      return { id: d.id, doc: d.doc, ...d.build() };
    },
    /** @param {(id: string) => boolean} [filter] */
    all(filter) {
      return defs.filter((d) => !filter || filter(d.id)).map((d) => ({ id: d.id, doc: d.doc, ...d.build() }));
    },
  };
}
