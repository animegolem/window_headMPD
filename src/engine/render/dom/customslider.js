// @ts-check
// CUSTOMSLIDER (E D2 drawables table, phase 3 in the plan but cheap here; spec 6.8, U-9): one canvas
// of one frame. The strip (`image`, or its hover, down and disabled variants) holds N frames along
// whichever axis is longer than the position map; the frame shown is `round(f * (N - 1))`. Hit and
// value come from the grey `positionImage`, which is the picker's and the input's business, not this
// canvas's. The frame size is the position map's, probed from its header.

import { copyRect, createSurface } from './compose.js';
import { applyCursor, blit, ImageWatch, makeCanvas, num, px, setAlpha, setStyle, setVisible, str } from './dom.js';
import { keySpecFor } from './keyspec.js';
import { fractionOf, stripFrame } from './slider-geometry.js';
import { NO_POINTER } from './states.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */

const BOX_ATTRS = new Set(['left', 'top', 'width', 'height']);

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable}
 */
export function createCustomSlider(ctx, el) {
  const node = makeCanvas(ctx.doc, 'customslider');
  const watch = new ImageWatch(ctx, () => paint());
  let pointer = NO_POINTER;
  /** @type {object | null} */
  let drawnPlanes = null;
  let drawnKey = '';

  /** The strip for the current state; each variant falls back to `image` (spec 6.8). */
  function stripRef() {
    const image = str(el, 'image').trim();
    if (el.get('enabled') === false) return str(el, 'disabledimage').trim() || image;
    if (pointer.pressed) return str(el, 'downimage').trim() || image;
    if (pointer.over) return str(el, 'hoverimage').trim() || image;
    return image;
  }

  function paint() {
    const ref = stripRef();
    const mapRef = str(el, 'positionimage').trim();
    const mapProbe = mapRef ? ctx.images.probe(mapRef) : null;
    const fw = mapProbe?.width || num(el, 'width');
    const fh = mapProbe?.height || num(el, 'height');
    let planes = null;
    if (ref) {
      const got = watch.want(ref, keySpecFor(el, 'strip', ctx.opts));
      if (!got.planes && !got.fresh) return;
      planes = got.planes;
    }
    const f = fractionOf(num(el, 'value'), num(el, 'min', 0), num(el, 'max', 100));
    // The strip runs along the axis in which it is longer than one frame.
    const horizontal = planes ? planes.width > fw || planes.height <= fh : true;
    const frames = planes && fw > 0 && fh > 0 ? Math.max(1, Math.floor((horizontal ? planes.width / fw : planes.height / fh))) : 1;
    // A reversed range (min > max) is a reversed dial; the fraction already follows it.
    const frame = stripFrame(f, frames);
    const key = `${fw}x${fh}f${frame}`;
    if (planes === drawnPlanes && key === drawnKey) return;
    const surface = createSurface(fw, fh);
    if (planes) copyRect(surface, 0, 0, planes, horizontal ? frame * fw : 0, horizontal ? 0 : frame * fh, fw, fh);
    blit(node, surface);
    drawnPlanes = planes;
    drawnKey = key;
  }

  return {
    node,
    apply(changed) {
      if (changed === null || [...changed].some((a) => a === 'left' || a === 'top')) {
        // The size is the frame's, set when the canvas is drawn.
        setStyle(node, 'left', px(num(el, 'left')));
        setStyle(node, 'top', px(num(el, 'top')));
      }
      if (changed === null || [...changed].some((a) => !BOX_ATTRS.has(a) || a === 'width' || a === 'height')) {
        watch.warm(['image', 'hoverimage', 'downimage', 'disabledimage'].map((n) => str(el, n).trim()), keySpecFor(el, 'strip', ctx.opts));
        paint();
      }
      if (changed === null || changed.has('visible')) setVisible(node, el.get('visible') !== false);
      if (changed === null || changed.has('alphablend')) setAlpha(node, num(el, 'alphablend', 255));
      if (changed === null || changed.has('cursor')) applyCursor(node, el);
    },
    pointer(p) {
      pointer = p;
      paint();
    },
    repaint: paint,
    dispose() {
      watch.dispose();
    },
  };
}
