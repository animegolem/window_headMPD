// @ts-check
// Shared by the image tests: a pixel comparison that names the first difference, and bit-plane
// readers. Nothing here depends on the code under test.

/**
 * Compare two RGBA buffers byte for byte.
 * @param {ArrayLike<number>} actual @param {ArrayLike<number>} expected @param {number} width
 * @param {{ ignoreRgbWhereAlpha0?: boolean }} [opts]
 * @returns {string | null} null when equal, else a message naming the first pixel that differs
 */
export function diffRgba(actual, expected, width, opts = {}) {
  if (actual.length !== expected.length) return `length ${actual.length}, expected ${expected.length}`;
  for (let i = 0; i < expected.length; i += 4) {
    const same = opts.ignoreRgbWhereAlpha0 && actual[i + 3] === 0 && expected[i + 3] === 0
      ? true
      : actual[i] === expected[i] && actual[i + 1] === expected[i + 1] && actual[i + 2] === expected[i + 2] && actual[i + 3] === expected[i + 3];
    if (!same) {
      const px = i >> 2;
      return `pixel (${px % width}, ${Math.floor(px / width)}) is ${Array.from({ length: 4 }, (_, k) => actual[i + k])}, expected ${Array.from({ length: 4 }, (_, k) => expected[i + k])}`;
    }
  }
  return null;
}

/** @param {Uint8Array} plane @param {number} i */
export const bit = (plane, i) => (plane[i >> 3] >> (i & 7)) & 1;

/** @param {Uint8Array} plane @param {number} count number of valid pixels @returns {number} set bits */
export function popcount(plane, count) {
  let n = 0;
  for (let i = 0; i < count; i++) n += bit(plane, i);
  return n;
}

/**
 * Pack 0/1 flags into a plane, the way the decoders and keying lay it out.
 * @param {ArrayLike<number>} flags @returns {Uint8Array}
 */
export function packBits(flags) {
  const out = new Uint8Array((flags.length + 7) >> 3);
  for (let i = 0; i < flags.length; i++) if (flags[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/** @param {Uint8Array} plane @param {number} count @returns {number[]} one 0/1 per pixel */
export function unpackBits(plane, count) {
  return Array.from({ length: count }, (_, i) => bit(plane, i));
}
