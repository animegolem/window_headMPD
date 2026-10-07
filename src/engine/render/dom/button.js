// @ts-check
// BUTTON and the predefined buttons (E D2 drawables table; spec 6.4): one canvas of the button's box
// holding the keyed image of its current state. Resolution is `disabled > hoverDown > down > hover >
// up` with the fallback chain of `states.js`; `tiled` repeats the image to the box, otherwise it is
// cropped to it. A BUTTON with no image but a size is an empty canvas: nothing to see, but it is
// still there for the picker (spec 2.7).

import { copyRect, createSurface, tileRect } from './compose.js';
import { applyCursor, blit, ImageWatch, makeCanvas, num, placeBox, setAlpha, setVisible } from './dom.js';
import { keySpecFor } from './keyspec.js';
import { NO_POINTER, buttonState, refForState, stateRefs } from './states.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */

/** What changes the picture: the five images, the key, the size, the state inputs. */
const PICTURE_ATTRS = new Set([
  'image', 'hoverimage', 'downimage', 'hoverdownimage', 'disabledimage', 'transparencycolor', 'clippingcolor',
  'clippingimage', 'tiled', 'width', 'height', 'enabled', 'sticky', 'down',
]);
const BOX_ATTRS = new Set(['left', 'top', 'width', 'height']);

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable}
 */
export function createButton(ctx, el) {
  const node = makeCanvas(ctx.doc, 'button');
  const watch = new ImageWatch(ctx, () => paint());
  let pointer = NO_POINTER;
  /** @type {object | null} */
  let drawn = null;
  let drawnKey = '';

  function paint() {
    const w = num(el, 'width');
    const h = num(el, 'height');
    const state = buttonState({ enabled: el.get('enabled') !== false, sticky: el.get('sticky') === true, down: el.get('down') === true }, pointer);
    const refs = stateRefs({
      image: el.get('image'), hoverImage: el.get('hoverimage'), downImage: el.get('downimage'),
      hoverDownImage: el.get('hoverdownimage'), disabledImage: el.get('disabledimage'),
    });
    const ref = refForState(refs, state);
    const tiled = el.get('tiled') === true;
    /** @type {import('../../contracts').KeyedPlanes | null} */
    let planes = null;
    if (ref) {
      const got = watch.want(ref, keySpecFor(el, 'button', ctx.opts));
      // Pending: keep the last picture on screen. Missing: an empty button.
      if (!got.planes && !got.fresh) return;
      planes = got.planes;
    }
    const key = `${w}x${h}${tiled ? 't' : ''}`;
    if (planes === drawn && key === drawnKey) return;
    const surface = createSurface(w, h);
    if (planes) {
      if (tiled) tileRect(surface, 0, 0, w, h, planes, 0, 0, planes.width, planes.height);
      else copyRect(surface, 0, 0, planes, 0, 0, planes.width, planes.height);
    }
    blit(node, surface);
    drawn = planes;
    drawnKey = key;
  }

  function place() {
    placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: num(el, 'width'), height: num(el, 'height') });
  }

  return {
    node,
    apply(changed) {
      if (changed === null || [...changed].some((a) => BOX_ATTRS.has(a))) place();
      if (changed === null || [...changed].some((a) => PICTURE_ATTRS.has(a))) {
        const r = stateRefs({ image: el.get('image'), hoverImage: el.get('hoverimage'), downImage: el.get('downimage'), hoverDownImage: el.get('hoverdownimage'), disabledImage: el.get('disabledimage') });
        watch.warm(new Set(Object.values(r)), keySpecFor(el, 'button', ctx.opts));
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
