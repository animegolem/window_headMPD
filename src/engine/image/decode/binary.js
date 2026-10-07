// @ts-check
// Fixed-width integer reads shared by the probe and the four decoders. None of them bounds-checks:
// every caller tests the length of the header it is about to read first, and a read past the end of
// a typed array yields `undefined`, which the arithmetic turns into 0 or NaN, never a throw.

/** @param {Uint8Array} b @param {number} o */
export const u16le = (b, o) => b[o] | (b[o + 1] << 8);

/** @param {Uint8Array} b @param {number} o */
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** @param {Uint8Array} b @param {number} o */
export const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

/** @param {Uint8Array} b @param {number} o */
export const u16be = (b, o) => (b[o] << 8) | b[o + 1];

/** @param {Uint8Array} b @param {number} o */
export const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
