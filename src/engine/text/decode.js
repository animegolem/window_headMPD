// @ts-check
// Skin text decoding (ENGINE.md D4 "Definition file and text", §5.1 `decodeText`). The corpus has
// exactly four kinds of `.wms` and `.js` file (`survey 2.1`): UTF-16LE with a BOM, UTF-8 with a BOM,
// pure ASCII, and BOM-less text that only decodes as Windows-1252. So the rule is: BOM sniff, else
// ASCII, else cp1252. A BOM-less file with multi-byte UTF-8 is still cp1252: the corpus has none, and
// guessing UTF-8 from byte patterns would change how a legitimate cp1252 file reads.
//
// Pure and total: it runs under Node and in a Worker, and never throws, whatever the bytes are.
// Malformed input decodes to U+FFFD (UTF-8, unpaired UTF-16 surrogates) the way a WHATWG decoder
// would, so the string that comes out is always well-formed UTF-16 and safe to hand to the realm.

/** @typedef {ReturnType<import('../contracts').DecodeTextFn>['encoding']} Encoding */

// 0x80-0x9F are the only bytes where cp1252 differs from Latin-1. Written out rather than taken
// from `new TextDecoder('windows-1252')` so the mapping does not depend on the host's ICU build; the
// unit test cross-checks this table against the platform decoder. The five bytes Microsoft left
// undefined (0x81 0x8D 0x8F 0x90 0x9D) map to the C1 control of the same value, as WHATWG does.
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, // 0x80
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, // 0x88
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, // 0x90
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178, // 0x98
];

const FFFD = 0xfffd;
// `String.fromCharCode(...chunk)` spreads onto the call stack, so long inputs go through in slices.
const CHUNK = 8192;

/** @param {Uint16Array} units @param {number} n */
function unitsToString(units, n) {
  let out = '';
  for (let i = 0; i < n; i += CHUNK) {
    out += String.fromCharCode.apply(null, /** @type {any} */ (units.subarray(i, Math.min(n, i + CHUNK))));
  }
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} start first byte after the BOM
 * @param {boolean} le
 */
function decodeUtf16(bytes, start, le) {
  const n = (bytes.length - start) >> 1;
  const units = new Uint16Array(n);
  const lo = le ? 0 : 1;
  const hi = le ? 1 : 0;
  for (let i = 0, p = start; i < n; i++, p += 2) units[i] = bytes[p + lo] | (bytes[p + hi] << 8);
  // Replace unpaired surrogates so the result is well-formed. A trailing odd byte is a truncated
  // code unit and becomes one U+FFFD, as TextDecoder reports it.
  for (let i = 0; i < n; i++) {
    const u = units[i];
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = i + 1 < n ? units[i + 1] : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i++;
      else units[i] = FFFD;
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      units[i] = FFFD;
    }
  }
  const text = unitsToString(units, n);
  return (bytes.length - start) & 1 ? text + String.fromCharCode(FFFD) : text;
}

/** @param {Uint8Array} bytes @param {number} start */
function decodeCp1252(bytes, start) {
  const n = bytes.length - start;
  const units = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const b = bytes[start + i];
    units[i] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
  }
  return unitsToString(units, n);
}

/** @param {Uint8Array} bytes */
function isAscii(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
  return true;
}

/** @type {import('../contracts').DecodeTextFn} */
export const decodeText = (bytes) => {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xff && b1 === 0xfe) return { text: decodeUtf16(bytes, 2, true), encoding: 'utf-16le' };
  if (b0 === 0xfe && b1 === 0xff) return { text: decodeUtf16(bytes, 2, false), encoding: 'utf-16be' };
  if (b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf) {
    // A default TextDecoder strips exactly one leading BOM, which is the one just sniffed.
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
  }
  if (isAscii(bytes)) return { text: decodeCp1252(bytes, 0), encoding: 'ascii' };
  return { text: decodeCp1252(bytes, 0), encoding: 'cp1252' };
};
