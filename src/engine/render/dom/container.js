// @ts-check
// VIEW and SUBVIEW: a stacking context with its own background (E D2 layer tree, "Every SUBVIEW is a
// stacking context", "SUBVIEW clippingColor"). The node holds, in paint order, an optional negative-z
// child list, the background slot (`div.bg`), and the children from z 0 up; `index.js` arranges them
// from `ViewModel.paintOrder`. The background slot carries `backgroundColor` as a CSS colour and the
// keyed `backgroundImage` as a canvas on top of it, so a negative-z child shows through exactly where
// the image is transparent, and `backgroundColor` stays part of the same z-0 layer.
//
// Clipping: a SUBVIEW with a non-zero size clips its subtree to its box (`subviewClip`, risk R10: a
// size-less grouping subview must not clip). A `clippingColor` (or `clippingImage`) becomes a PNG mask
// at the image's native size on the subview's node, so it clips the overlays and the child slots too
// (parity D26). A `backgroundTiled` container tiles its mask like its background (`mask-repeat`), or
// everything past the first tile would be hidden (5F.5). A VIEW whose background has no kept pixel at
// all is not masked. This is an engine ruling of 5F.5, taken from the Gorillaz art: its tile is 50x28
// and entirely the clipping colour, under a head the children draw, so WMP evidently does not let the
// VIEW's own background clip hide its children, and a mask over every pixel would hide the skin. Spec 5.5
// only says the region is the pixels that are not clippingColor; it does not cover a background with no
// kept pixel.
//
// A `clippingImage` with no `backgroundImage` is a mask on its own (U-7, 5F.10): the clipping image is
// decoded with the clipping colour as its key (default `auto`, its own pixel (0,0)) and its kept pixels
// become the mask at the image's native size, drawn once from the container's corner and never tiled.
// `shape/scene.js` asks the image service for exactly that pair, so the window shape, the picker and
// the pixels cannot disagree. Nothing is painted for such a container; only its subtree is clipped.

import { createSurface, tileRect } from './compose.js';
import { blit, ImageWatch, makeCanvas, makeNode, num, placeBox, px, setAlpha, setStyle, setVisible, str } from './dom.js';
import { clipMaskUrl } from './clipmask.js';
import { clippingOf, keySpecFor } from './keyspec.js';
import { rgbCss } from './strings.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */
/** @typedef {Drawable & { bgNode: HTMLElement }} ContainerDrawable */

/** The attributes that change what a background looks like. */
const BACKGROUND_ATTRS = new Set([
  'backgroundimage', 'backgroundcolor', 'backgroundtiled', 'transparencycolor', 'clippingcolor', 'clippingimage', 'width', 'height',
]);
const BOX_ATTRS = new Set(['left', 'top', 'width', 'height']);

/**
 * Whether a clip plane (1 = kept) keeps any of its first `n` pixels.
 * @param {Uint8Array} clip @param {number} n
 */
function anyKept(clip, n) {
  const full = n >> 3;
  for (let i = 0; i < full; i++) if (clip[i] !== 0) return true;
  const rest = n & 7;
  return rest !== 0 && (clip[full] & ((1 << rest) - 1)) !== 0;
}

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {ContainerDrawable}
 */
export function createContainer(ctx, el) {
  const isView = el.kind === 'view';
  const node = makeNode(ctx.doc, 'div', isView ? 'view' : 'sv');
  // `div.view` holds `div.layers` (the painted scene) beside the input plane and the windowed layer,
  // which `index.js` adds; a SUBVIEW is its own content.
  const content = isView ? makeNode(ctx.doc, 'div', 'layers') : node;
  if (isView) {
    node.appendChild(content);
    setStyle(node, 'transform-origin', '0 0');
    setStyle(content, 'left', '0px');
    setStyle(content, 'top', '0px');
    setStyle(content, 'pointer-events', 'none');
    setStyle(content, 'overflow', 'hidden');
  }
  setStyle(node, 'isolation', 'isolate');
  if (isView) setStyle(content, 'isolation', 'isolate');

  const bgNode = makeNode(ctx.doc, 'div', 'bg');
  const canvas = makeCanvas(ctx.doc, 'bgimg');
  bgNode.appendChild(canvas);

  const watch = new ImageWatch(ctx, () => paintBackground());
  /** @type {object | null} what the background canvas shows, by identity of the planes and the layout */
  let drawn = null;
  /** @type {WeakMap<object, string | null>} */
  const masks = new WeakMap();
  let drawnKey = '';

  function box() {
    return { w: num(el, 'width'), h: num(el, 'height') };
  }

  function paintBox() {
    const { w, h } = box();
    if (isView) {
      setStyle(node, 'left', '0px');
      setStyle(node, 'top', '0px');
    } else {
      setStyle(node, 'left', px(num(el, 'left')));
      setStyle(node, 'top', px(num(el, 'top')));
    }
    setStyle(node, 'width', px(w));
    setStyle(node, 'height', px(h));
    if (isView) {
      setStyle(content, 'width', px(w));
      setStyle(content, 'height', px(h));
    }
    // A size-less subview does not clip (R10); a VIEW's box is the window, so it always does.
    if (!isView) setStyle(node, 'overflow', ctx.opts.subviewClip && w > 0 && h > 0 ? 'hidden' : '');
    placeBox(bgNode, { left: 0, top: 0, width: w, height: h });
  }

  function paintBackground() {
    const { w, h } = box();
    const color = rgbCss(el.get('backgroundcolor'));
    setStyle(bgNode, 'background-color', color ?? '');
    const ref = str(el, 'backgroundimage').trim();
    if (!ref) {
      if (drawn !== null || drawnKey !== '') {
        blit(canvas, null);
        drawn = null;
        drawnKey = '';
      }
      paintClipImageMask();
      return;
    }
    const spec = keySpecFor(el, 'background', ctx.opts);
    const { planes, fresh } = watch.want(ref, spec);
    if (!planes) {
      // Not decoded yet: keep what is on screen. Decoded and gone (a missing file): show nothing.
      if (fresh && drawn !== null) {
        blit(canvas, null);
        drawn = null;
        drawnKey = '';
        applyMask(null, 0, 0, false);
      }
      return;
    }
    const tiled = el.get('backgroundtiled') === true && w > 0 && h > 0;
    const key = tiled ? `t${w}x${h}` : 'n';
    if (planes === drawn && key === drawnKey) return;
    if (tiled) {
      const surface = createSurface(w, h);
      tileRect(surface, 0, 0, w, h, planes, 0, 0, planes.width, planes.height);
      blit(canvas, surface);
    } else {
      blit(canvas, { width: planes.width, height: planes.height, data: planes.rgba });
    }
    drawn = planes;
    drawnKey = key;
    applyMask(planes, planes.width, planes.height, tiled);
  }

  /**
   * The mask of a container that has a `clippingImage` but no background: the clipping image itself,
   * keyed by the clipping colour, at its native size (the pair `shape/scene.js` asks for). Like the
   * background, an image that has not decoded yet leaves the mask on screen as it is, and one that
   * decoded to nothing (a missing file) removes it.
   */
  function paintClipImageMask() {
    const clip = clippingOf(el);
    if (clip.clipImage === undefined || clip.clipping === null) {
      applyMask(null, 0, 0, false);
      return;
    }
    const { planes, fresh } = watch.want(clip.clipImage, { transparency: null, clipping: clip.clipping, hitKeyed: false });
    if (planes) applyMask(planes, planes.width, planes.height, false);
    else if (fresh) applyMask(null, 0, 0, false);
  }

  /**
   * The clip mask, from the planes' clip bits, on the node that clips the subtree.
   * @param {import('../../contracts').KeyedPlanes | null} planes @param {number} mw @param {number} mh
   * @param {boolean} tiled the background repeats over the box, so the mask repeats with it
   */
  function applyMask(planes, mw, mh, tiled) {
    let url = null;
    if (planes && planes.clip) {
      url = masks.get(planes);
      if (url === undefined) {
        url = isView && !anyKept(planes.clip, planes.width * planes.height) ? null
          : clipMaskUrl({ width: planes.width, height: planes.height, clip: planes.clip });
        masks.set(planes, url);
      }
    }
    const target = content;
    const css = url ? `url("${url}")` : '';
    setStyle(target, '-webkit-mask-image', css);
    setStyle(target, 'mask-image', css);
    setStyle(target, '-webkit-mask-size', url ? `${mw}px ${mh}px` : '');
    setStyle(target, 'mask-size', url ? `${mw}px ${mh}px` : '');
    // The tile's own size and the origin make the repeat land on the background's tiles (`tileRect` from 0, 0).
    const repeat = tiled ? 'repeat' : 'no-repeat';
    setStyle(target, '-webkit-mask-repeat', url ? repeat : '');
    setStyle(target, 'mask-repeat', url ? repeat : '');
    setStyle(target, '-webkit-mask-position', url ? '0 0' : '');
    setStyle(target, 'mask-position', url ? '0 0' : '');
    // Chromium samples a mask image with the masked box's own `image-rendering`. Left at `auto`, a
    // DPR 2 (or zoomed) mask is bilinear: the opaque side of every clip edge loses a quarter of its
    // alpha, along the whole head silhouette (5F.2). `pixelated` scales the mask like the canvases
    // inside it, which is how the oracle's keyed <img> scales its baked-in clip. The property inherits:
    // the canvases below set it anyway, and a host surface that wants smoothing (VizHost's canvas,
    // overlays.css) says `auto` itself.
    setStyle(target, 'image-rendering', url ? 'pixelated' : '');
  }

  function paintCommon() {
    setVisible(node, el.get('visible') !== false);
    setAlpha(node, num(el, 'alphablend', 255));
  }

  return {
    node,
    content,
    bgNode,
    apply(changed) {
      let needBox = changed === null;
      let needBackground = changed === null;
      if (changed) {
        for (const a of changed) {
          if (BOX_ATTRS.has(a)) needBox = true;
          if (BACKGROUND_ATTRS.has(a)) needBackground = true;
        }
      }
      if (needBox) paintBox();
      if (needBackground) paintBackground();
      if (changed === null || changed.has('visible') || changed.has('alphablend')) paintCommon();
    },
    repaint: paintBackground,
    dispose() {
      watch.dispose();
    },
  };
}
