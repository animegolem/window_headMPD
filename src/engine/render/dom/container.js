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
// (parity D26).

import { createSurface, tileRect } from './compose.js';
import { blit, ImageWatch, makeCanvas, makeNode, num, placeBox, px, setAlpha, setStyle, setVisible, str } from './dom.js';
import { clipMaskUrl } from './clipmask.js';
import { keySpecFor } from './keyspec.js';
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
      applyMask(null, 0, 0);
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
        applyMask(null, 0, 0);
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
    applyMask(planes, planes.width, planes.height);
  }

  /**
   * The clip mask, from the planes' clip bits, on the node that clips the subtree.
   * @param {import('../../contracts').KeyedPlanes | null} planes @param {number} mw @param {number} mh
   */
  function applyMask(planes, mw, mh) {
    let url = null;
    if (planes && planes.clip) {
      url = masks.get(planes);
      if (url === undefined) {
        url = clipMaskUrl({ width: planes.width, height: planes.height, clip: planes.clip });
        masks.set(planes, url);
      }
    }
    const target = content;
    const css = url ? `url("${url}")` : '';
    setStyle(target, '-webkit-mask-image', css);
    setStyle(target, 'mask-image', css);
    setStyle(target, '-webkit-mask-size', url ? `${mw}px ${mh}px` : '');
    setStyle(target, 'mask-size', url ? `${mw}px ${mh}px` : '');
    setStyle(target, '-webkit-mask-repeat', url ? 'no-repeat' : '');
    setStyle(target, 'mask-repeat', url ? 'no-repeat' : '');
    setStyle(target, '-webkit-mask-position', url ? '0 0' : '');
    setStyle(target, 'mask-position', url ? '0 0' : '');
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
