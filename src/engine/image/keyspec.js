// @ts-check
// How an element's declarations become the `KeySpec` its images are decoded with (E D3 "Keying", E D2
// hit planes, spec 5.5). One function, because the renderer, the picker and the shape rasteriser must
// ask the image service for exactly the same (file, spec) pair: the service caches by it, so a
// consumer that spelt the spec differently would decode every image twice and could read hit bits
// that disagree with the pixels that were painted. This module is that one home; `render/dom/keyspec.js`
// re-exports it and `shape/scene.js` imports it. Pure (no DOM), which is why it sits beside the keying
// step rather than under the renderer.
//
// Three rules carry the weight:
//  - A key applies only where the skin declared it ("per declaration", spec 5.5). `transparencyColor`
//    defaults to nothing on every element but a BUTTONGROUP, whose default is `none`, so a missing
//    declaration never keys. `clippingColor` defaults to `auto` on every ambient element, which would
//    clip every opaque background away; it is therefore honoured only when the markup wrote it
//    (`source()` is set), when a script later gave it a colour, or when a `clippingImage` is named.
//  - A `clippingImage` brings its own region: the colour (default `auto`, pixel (0,0) of that image)
//    names what is outside it.
//  - `hitKeyed` says whether pixels keyed by `transparencyColor` still take clicks. A BUTTON, a
//    BUTTONGROUP's owned pixels and a slider thumb take them when the engine option says so (faithful,
//    spec 2.7); a VIEW or SUBVIEW background, and a slider's track and foreground, never do.

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').EngineOptions} EngineOptions */
/** @typedef {import('../contracts').KeySpec} KeySpec */

/**
 * Which of an element's images a spec is for.
 *  'background'  a VIEW or SUBVIEW `backgroundImage`
 *  'button'      a BUTTON image, or any BUTTONGROUP state image
 *  'thumb'       a slider thumb image
 *  'track'       a slider track or foreground image
 *  'strip'       a CUSTOMSLIDER frame strip
 * @typedef {'background' | 'button' | 'thumb' | 'track' | 'strip'} KeyPart
 */

/**
 * The element's `transparencyColor` as a KeySpec value: a colour, `auto`, or nothing.
 * @param {ElementModel} el
 * @returns {number | 'auto' | null}
 */
export function transparencyOf(el) {
  const t = el.get('transparencycolor');
  if (typeof t === 'number') return t;
  return t === 'auto' ? 'auto' : null;
}

/**
 * The clipping half of a KeySpec: `{ clipping, clipImage? }`, or `{ clipping: null }` when the skin
 * declared nothing that clips.
 * @param {ElementModel} el
 * @returns {{ clipping: number | 'auto' | null, clipImage?: string }}
 */
export function clippingOf(el) {
  const cc = el.get('clippingcolor');
  const color = typeof cc === 'number' ? cc : cc === 'auto' ? 'auto' : null;
  const image = el.get('clippingimage');
  const clipImage = typeof image === 'string' ? image.trim() : '';
  if (clipImage !== '') {
    // A named clipping image with no colour at all is the same as `auto` (the default).
    return { clipping: color ?? 'auto', clipImage };
  }
  const declared = el.source('clippingcolor') !== undefined || typeof cc === 'number';
  return declared && color !== null ? { clipping: color } : { clipping: null };
}

/**
 * The KeySpec for one image role of an element.
 * @param {ElementModel} el
 * @param {KeyPart} part
 * @param {Pick<EngineOptions, 'buttonKeyedPixelsHit'>} opts
 * @returns {KeySpec}
 */
export function keySpecFor(el, part, opts) {
  const hitKeyed = part === 'button' || part === 'thumb' ? !!opts.buttonKeyedPixelsHit : false;
  // A strip's frames are painted by the slider itself: the frame is the pixels, the key only hides
  // its background, and keyed pixels in a strip do not take clicks (the grey map decides, spec 6.8).
  /** @type {KeySpec} */
  const spec = { transparency: transparencyOf(el), hitKeyed };
  const clip = clippingOf(el);
  if (clip.clipping !== null) {
    spec.clipping = clip.clipping;
    if (clip.clipImage !== undefined) spec.clipImage = clip.clipImage;
  }
  return spec;
}

/**
 * A stable text for a spec, for the renderer's own "did anything change" checks. Not the image
 * service's cache key (the service normalises on its own).
 * @param {KeySpec} spec
 * @returns {string}
 */
export function specToken(spec) {
  return `${spec.transparency ?? '-'}|${spec.clipping ?? '-'}|${spec.hitKeyed ? 1 : 0}|${spec.clipImage ?? ''}`;
}
