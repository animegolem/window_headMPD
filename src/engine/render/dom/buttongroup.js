// @ts-check
// BUTTONGROUP (E D2 drawables table; spec 6.5; parity E3): one canvas of the group's box. The
// mapping image is indexed once into an owner per pixel (an exact RGB match against each
// BUTTONELEMENT's `mappingColor`) and a pixel list per element, so a state change recomposites only
// that element's pixels from the layer of its new state. Unowned pixels are painted from the `image`
// layer when `showBackground` says so and are never hit (the picker reads the planes, not this
// canvas); with it off they stay transparent.
//
// `showBackground` is the skin's value when the skin wrote one, else the engine switch
// (`showBackgroundDefault`: false in faithful, true in oracle-compat, allow-list U-23).

import { BUTTON_STATES, buttonState, refForState, stateRefs } from './states.js';
import { buildOwners, copyPixels, createSurface, unownedPixels } from './compose.js';
import { applyCursor, blit, ImageWatch, makeCanvas, num, placeBox, setAlpha, setVisible, str } from './dom.js';
import { keySpecFor } from './keyspec.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */
/** @typedef {import('./states.js').ButtonState} ButtonState */

const BOX_ATTRS = new Set(['left', 'top', 'width', 'height']);
/** A change to any of these re-reads every layer and the map. */
const GROUP_ATTRS = new Set([
  'image', 'hoverimage', 'downimage', 'hoverdownimage', 'disabledimage', 'mappingimage', 'transparencycolor',
  'clippingcolor', 'clippingimage', 'showbackground', 'radio', 'enabled', 'width', 'height',
]);
/** A change to any of these on a BUTTONELEMENT changes what it shows, or what it owns. */
const ELEMENT_STATE_ATTRS = new Set(['enabled', 'sticky', 'down']);

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable & { pointerParts(over: number | null, pressed: number | null): void }}
 */
export function createButtonGroup(ctx, el) {
  const node = makeCanvas(ctx.doc, 'buttongroup');
  const watch = new ImageWatch(ctx, () => paintAll());

  /** @type {{ owner: Int16Array, lists: Uint32Array[] } | null} */
  let owners = null;
  let ownersKey = '';
  /** @type {Uint32Array} */
  let unowned = new Uint32Array(0);
  /** The `out` surface and its box. */
  let out = createSurface(0, 0);
  /** Per element, what is drawn now. @type {ButtonState[]} */
  let shown = [];
  /** A script wrote `showBackground`: from then on the skin's value counts, declared or not. */
  let showBgWritten = false;
  let over = /** @type {number | null} */ (null);
  let pressed = /** @type {number | null} */ (null);
  /** Layers of the last full composite, to detect a landing that changes nothing. @type {Array<KeyedPlanes | null>} */
  let layersDrawn = [];

  // The model never adds or removes children after the build, so the list is read once.
  /** @type {ElementModel[] | null} */
  let cachedElements = null;
  const elements = () => (cachedElements ??= el.children.filter((c) => c.kind === 'buttonelement'));
  /** The last decoded planes of each state, kept on screen while a replacement decodes. @type {Array<KeyedPlanes | null>} */
  const lastGood = BUTTON_STATES.map(() => null);

  function showBackground() {
    const explicit = showBgWritten || el.source('showbackground') !== undefined || el.get('showbackground') === true;
    return explicit ? el.get('showbackground') === true : ctx.opts.showBackgroundDefault;
  }

  /** @returns {Array<KeyedPlanes | null>} the five layers in `BUTTON_STATES` order */
  function layers() {
    const refs = stateRefs({
      image: el.get('image'), hoverImage: el.get('hoverimage'), downImage: el.get('downimage'),
      hoverDownImage: el.get('hoverdownimage'), disabledImage: el.get('disabledimage'),
    });
    const spec = keySpecFor(el, 'button', ctx.opts);
    // Layers sharing a ref share one decode (the service caches by file and key).
    return BUTTON_STATES.map((s, i) => {
      const ref = refForState(refs, s);
      if (!ref) return (lastGood[i] = null);
      const got = watch.want(ref, spec);
      // Pending keeps the previous pixels; decoded-and-missing shows nothing.
      if (got.planes || got.fresh) lastGood[i] = got.planes;
      return lastGood[i];
    });
  }

  /** @param {number} i @returns {ButtonState} */
  function stateOf(i) {
    const child = elements()[i];
    const radio = el.get('radio') === true;
    return buttonState(
      {
        enabled: el.get('enabled') !== false && child.get('enabled') !== false,
        sticky: radio || child.get('sticky') === true,
        down: child.get('down') === true,
      },
      { over: over === i, pressed: pressed === i },
    );
  }

  function ensureOwners() {
    const w = num(el, 'width');
    const h = num(el, 'height');
    const list = elements();
    const colors = list.map((c) => {
      const mc = c.get('mappingcolor');
      return typeof mc === 'number' ? mc : null;
    });
    const mapRef = str(el, 'mappingimage').trim();
    const key = `${mapRef}|${w}x${h}|${colors.join(',')}`;
    if (owners && key === ownersKey) return;
    const map = mapRef ? watch.raw(mapRef) : null;
    out = createSurface(w, h);
    owners = map && out.width > 0 ? buildOwners(map, colors, out.width, out.height) : { owner: new Int16Array(out.width * out.height).fill(-1), lists: colors.map(() => new Uint32Array(0)) };
    unowned = unownedPixels(owners.owner);
    ownersKey = key;
    shown = [];
  }

  function paintAll() {
    ensureOwners();
    if (!owners) return;
    const ls = layers();
    const { width: w, height: h, data } = out;
    // Unowned pixels: the up layer when the background shows, else nothing.
    copyPixels(data, w, h, showBackground() ? ls[0] : null, unowned);
    const list = elements();
    shown = list.map((_, i) => stateOf(i));
    for (let i = 0; i < list.length; i++) copyPixels(data, w, h, ls[BUTTON_STATES.indexOf(shown[i])], owners.lists[i]);
    layersDrawn = ls;
    blit(node, out);
  }

  /** @param {number} i */
  function paintElement(i) {
    if (!owners || i < 0 || i >= owners.lists.length) return;
    const next = stateOf(i);
    if (shown[i] === next) return;
    shown[i] = next;
    // The layers are the ones last composited; a layer still decoding is picked up by paintAll on landing.
    const layer = layersDrawn[BUTTON_STATES.indexOf(next)] ?? null;
    copyPixels(out.data, out.width, out.height, layer, owners.lists[i]);
    blit(node, out);
  }

  function place() {
    placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: num(el, 'width'), height: num(el, 'height') });
  }

  return {
    node,
    apply(changed) {
      if (changed === null || [...changed].some((a) => BOX_ATTRS.has(a))) place();
      if (changed && changed.has('showbackground')) showBgWritten = true;
      if (changed === null || [...changed].some((a) => GROUP_ATTRS.has(a))) paintAll();
      if (changed === null || changed.has('visible')) setVisible(node, el.get('visible') !== false);
      if (changed === null || changed.has('alphablend')) setAlpha(node, num(el, 'alphablend', 255));
      if (changed === null || changed.has('cursor')) applyCursor(node, el);
    },
    applyChild(child, changed) {
      if (changed === null || changed.has('mappingcolor')) {
        paintAll();
        return;
      }
      if ([...changed].some((a) => ELEMENT_STATE_ATTRS.has(a))) paintElement(elements().indexOf(child));
    },
    pointerParts(o, p) {
      const before = [over, pressed];
      over = o;
      pressed = p;
      for (const i of new Set([...before, over, pressed])) if (i !== null) paintElement(i);
    },
    repaint: paintAll,
    dispose() {
      watch.dispose();
    },
  };
}
