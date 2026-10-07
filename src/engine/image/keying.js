// @ts-check
// Per-declaration colour keying and the paint, hit and clip bit planes (ENGINE D3, D2).
//
// A pure function of (decoded RGBA, KeySpec, optional clipping image). It never changes its input and
// always returns fresh arrays, so a cached decode can feed many keyings. Exact RGB match, no tolerance.
//
// How a pixel comes out, in order:
//   1. Source alpha: a BMP is opaque, a PNG or GIF brings its own. It is composited, and keys apply
//      on top of it (U-27).
//   2. `transparency` key: a visible pixel whose RGB equals the key gets alpha 0. Its `hit` bit is set
//      only when `spec.hitKeyed` is, which is how the caller says "a BUTTON takes clicks on its keyed
//      pixels" (faithful) or "a VIEW/SUBVIEW background passes them through" (D2 table).
//   3. `clipping` key: the control's region is every pixel that is NOT the clipping colour. A pixel
//      outside it gets alpha 0, `paint` 0, `hit` 0 and `clip` 0, whatever step 2 decided. The region
//      comes from `clipImg` when the spec names a `clipImage` and one is supplied (anywhere outside
//      that image is outside the region), otherwise from the image itself.
//
// Choices where the contract is silent:
//   - Keys look only at visible pixels. A pixel whose source alpha is 0 is already absent, so it is
//     never keyed or clipped, never hit, and `auto` read from such a pixel (0,0) means "no key".
//     Otherwise the colour a GIF or PNG leaves under its transparent pixels would decide hit-testing.
//   - `transparency` or `clipping` that is null or undefined means none. `auto` is pixel (0,0) of the
//     image the key applies to: the image itself, or `clipImg` for a clipping colour with a clipImage.
//     Callers resolve WMP's "clippingImage without a clippingColor means auto" before they get here.
//   - A `clipImage` with no `clipImg` supplied (the file was missing) clips nothing: `clip` is null.
//   - Each of those silent choices that costs the author something leaves a diagnostic on the result's
//     `diagnostics` (G1): a missing clipping image, and an `auto` key whose pixel (0,0) is fully
//     transparent. A keying with nothing to say has no `diagnostics` property at all.
//   - Keyed and clipped pixels keep their RGB; only alpha changes.
//
// Planes are 1 bit per pixel, row-major, least significant bit first, no padding between rows:
// pixel i = y * width + x is bit (i & 7) of byte (i >> 3), the layout of headcore::hit and the oracle's
// mask. `clip` is 1 for pixels inside the region and null when the spec clips nothing.

/** @typedef {import('../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../contracts').KeySpec} KeySpec */
/** @typedef {import('../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */

/**
 * @param {Uint8Array} plane @param {number} i pixel index, y * width + x
 * @returns {boolean}
 */
export const bitAt = (plane, i) => ((plane[i >> 3] >> (i & 7)) & 1) === 1;

/**
 * The colour a key stands for, as 0xRRGGBB, or -1 for none.
 * @param {number | 'auto' | null | undefined} key @param {Uint8ClampedArray} data
 */
function resolveKey(key, data) {
  if (key === null || key === undefined) return -1;
  if (key === 'auto') return data.length >= 4 && data[3] > 0 ? (data[0] << 16) | (data[1] << 8) | data[2] : -1;
  return key & 0xffffff;
}

/** @type {import('../contracts').KeyImageFn} */
export const keyImage = (img, spec, clipImg) => {
  const { width: w, height: h } = img;
  const n = w * h;
  const src = img.data;
  const rgba = new Uint8ClampedArray(src.subarray(0, n * 4));
  const paint = new Uint8Array((n + 7) >> 3);
  const hit = new Uint8Array((n + 7) >> 3);

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const tKey = resolveKey(spec.transparency, src);
  if (spec.transparency === 'auto' && tKey < 0) {
    diagnostics.push({ code: 'image-key-auto-unresolved', detail: 'transparency colour auto reads pixel (0,0), which is fully transparent; nothing is keyed', severity: 'info' });
  }

  // The clip region: from clipImg when one is named and present, else from the image itself.
  const wantsClip = spec.clipping !== null && spec.clipping !== undefined;
  const viaImage = wantsClip && !!spec.clipImage;
  const region = viaImage ? clipImg ?? null : img;
  const cKey = region && wantsClip ? resolveKey(spec.clipping, region.data) : -1;
  if (viaImage && !clipImg) {
    diagnostics.push({ code: 'image-key-clip-image-missing', detail: `clipping image ${spec.clipImage} was not supplied; nothing is clipped`, severity: 'warn' });
  } else if (region && spec.clipping === 'auto' && cKey < 0) {
    diagnostics.push({ code: 'image-key-auto-unresolved', detail: 'clipping colour auto reads pixel (0,0), which is fully transparent; no colour is clipped', severity: 'info' });
  }
  // From the image itself, an unresolvable key clips nothing; from a clipImage, the bounds still do.
  const clipOn = region !== null && wantsClip && (viaImage || cKey >= 0);
  const clip = clipOn ? new Uint8Array((n + 7) >> 3) : null;
  const cData = region ? region.data : src;
  const cw = region ? region.width : w;
  const ch = region ? region.height : h;
  const clipFromSelf = region === img;

  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const p = i * 4;
      const a = src[p + 3];
      let visible = a > 0;
      let keyed = false;
      if (visible && tKey >= 0 && ((src[p] << 16) | (src[p + 1] << 8) | src[p + 2]) === tKey) {
        rgba[p + 3] = 0;
        visible = false;
        keyed = true;
      }
      if (clip) {
        let inside;
        if (clipFromSelf) {
          inside = !(a > 0 && ((src[p] << 16) | (src[p + 1] << 8) | src[p + 2]) === cKey);
        } else if (x >= cw || y >= ch) {
          inside = false;
        } else {
          const q = (y * cw + x) * 4;
          inside = !(cData[q + 3] > 0 && ((cData[q] << 16) | (cData[q + 1] << 8) | cData[q + 2]) === cKey);
        }
        if (inside) {
          clip[i >> 3] |= 1 << (i & 7);
        } else {
          rgba[p + 3] = 0;
          visible = false;
          keyed = false;
        }
      }
      if (visible) {
        paint[i >> 3] |= 1 << (i & 7);
        hit[i >> 3] |= 1 << (i & 7);
      } else if (keyed && spec.hitKeyed) {
        hit[i >> 3] |= 1 << (i & 7);
      }
    }
  }
  /** @type {KeyedPlanes} */
  const out = { width: w, height: h, rgba, paint, hit, clip };
  if (diagnostics.length) out.diagnostics = diagnostics;
  return out;
};
