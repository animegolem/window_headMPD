// @ts-check
// SLIDER and PROGRESSBAR (E D2 drawables table; spec 6.7 and 6.9; parity F and D28 to D34): a box
// holding a track canvas, a foreground (clipped to its reveal edge) and a thumb canvas.
//
//   track       the keyed `backgroundImage`; with `tiled`, `borderSize` px at each end are caps and the
//               middle repeats from the start edge. Colour mode (no images at all) paints
//               `backgroundColor` with an optional gradient to `backgroundEndColor` instead.
//   foreground  revealed up to an edge: with `slide=false` the image stays put and the box shows more
//               of it; with `slide=true` the image moves so its leading edge is the reveal edge. The
//               edge is the thumb centre, or `foregroundProgress` percent of the track when
//               `useForegroundProgress` is on and `x-foregroundMode` is 'progress' (parity D2).
//               A disabled slider shows no foreground (spec 6.7).
//   thumb       positioned by `slider-geometry.js`; no `thumbImage` means no thumb and an inert
//               slider.
//
// Writes are diffed: a value that moves the thumb touches only the thumb's and the reveal's `left`
// and `top` (parity D34).

import { createSurface, drawTrack, tileRect } from './compose.js';
import { applyCursor, blit, ImageWatch, makeCanvas, makeNode, num, placeBox, px, setAlpha, setStyle, setVisible, str } from './dom.js';
import { keySpecFor } from './keyspec.js';
import { fractionOf, revealEdge, thumbEdge } from './slider-geometry.js';
import { rgbCss } from './strings.js';
import { NO_POINTER, thumbRef, thumbState } from './states.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('../../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */

const BOX_ATTRS = new Set(['left', 'top', 'width', 'height']);
/** These move the thumb and the reveal edge and redraw nothing. */
const POSITION_ATTRS = new Set(['value', 'min', 'max', 'foregroundprogress', 'useforegroundprogress', 'x-foregroundmode']);

/**
 * `#a` or `linear-gradient(to <dir>, #a, #b)` for two optional colours, null when there is no start
 * colour. The direction runs from the start of the track (the bottom, for a vertical slider).
 * @param {number | string | boolean | null} a @param {number | string | boolean | null} b @param {boolean} vertical
 * @returns {{ color: string, image: string }}
 */
function colourFill(a, b, vertical) {
  const from = rgbCss(a);
  const to = rgbCss(b);
  if (from && to) return { color: from, image: `linear-gradient(${vertical ? 'to top' : 'to right'}, ${from}, ${to})` };
  return { color: from ?? '', image: '' };
}

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable}
 */
export function createSlider(ctx, el) {
  const node = makeNode(ctx.doc, 'div', 'slider');
  setStyle(node, 'overflow', 'hidden');
  const track = makeCanvas(ctx.doc, 'track');
  const fgClip = makeNode(ctx.doc, 'div', 'fgclip');
  setStyle(fgClip, 'overflow', 'hidden');
  const fg = makeCanvas(ctx.doc, 'fg');
  const fgFill = makeNode(ctx.doc, 'div', 'fgfill');
  const thumb = makeCanvas(ctx.doc, 'thumb');
  fgClip.append(fg, fgFill);
  node.append(track, fgClip, thumb);

  const watch = new ImageWatch(ctx, () => paintPixels());
  let pointer = NO_POINTER;
  /** @type {{ track: object | null, trackKey: string, fg: object | null, fgKey: string, thumb: object | null }} */
  const drawn = { track: null, trackKey: '', fg: null, fgKey: '', thumb: null };
  /** The thumb's extent along and across the axis, from the image header or the planes. */
  let thumbExtent = { along: 0, across: 0 };
  /** The foreground's canvas extent along the axis (for `slide`). */
  let fgAlong = 0;
  let hasFg = false;
  let hasThumb = false;

  const isVertical = () => el.get('direction') === 'vertical';
  const geometry = () => ctx.opts.sliderGeometry;

  /** @param {string} ref @param {'track' | 'thumb'} part */
  function planesFor(ref, part) {
    const got = watch.want(ref, keySpecFor(el, part, ctx.opts));
    return got;
  }

  /** Every image a state of this slider can show is asked for with the first. */
  function warmAll() {
    const refs = (/** @type {string[]} */ names) => names.map((n) => str(el, n).trim());
    watch.warm(refs(['backgroundimage', 'backgroundhoverimage', 'disabledimage', 'foregroundimage', 'foregroundhoverimage']), keySpecFor(el, 'track', ctx.opts));
    watch.warm(refs(['thumbimage', 'thumbhoverimage', 'thumbdownimage', 'thumbdisabledimage']), keySpecFor(el, 'thumb', ctx.opts));
  }

  function paintPixels() {
    const w = num(el, 'width');
    const h = num(el, 'height');
    const vertical = isVertical();
    const length = vertical ? h : w;
    const enabled = el.get('enabled') !== false;
    const over = pointer.over;
    const bgImage = str(el, 'backgroundimage').trim();
    const fgImage = str(el, 'foregroundimage').trim();
    const colourMode = !bgImage && !fgImage;

    // ---- track
    const trackRef = !enabled
      ? str(el, 'disabledimage').trim() || bgImage
      : (over && str(el, 'backgroundhoverimage').trim()) || bgImage;
    {
      const tiled = el.get('tiled') === true;
      const border = num(el, 'bordersize');
      let planes = null;
      let skip = false;
      if (trackRef) {
        const got = planesFor(trackRef, 'track');
        if (!got.planes && !got.fresh) skip = true; // pending: keep the picture
        planes = got.planes;
      }
      const key = `${w}x${h}${vertical ? 'v' : 'h'}${tiled ? 't' : ''}${border}`;
      if (!skip && !(planes === drawn.track && key === drawn.trackKey)) {
        const surface = createSurface(w, h);
        if (planes) drawTrack(surface, planes, { vertical, length, tiled, border });
        blit(track, surface);
        drawn.track = planes;
        drawn.trackKey = key;
      }
      const bg = !enabled && el.get('disabledcolor') !== null ? colourFill(el.get('disabledcolor'), null, vertical) : colourFill(el.get('backgroundcolor'), el.get('backgroundendcolor'), vertical);
      setStyle(node, 'background-color', bg.color);
      setStyle(node, 'background-image', bg.image);
    }

    // ---- foreground
    {
      hasFg = false;
      const fgRef = enabled ? (over && str(el, 'foregroundhoverimage').trim()) || fgImage : '';
      if (fgRef) {
        const got = planesFor(fgRef, 'track');
        hasFg = true;
        if (got.planes || got.fresh) {
          const planes = got.planes;
          const tiled = el.get('tiled') === true;
          const key = `${w}x${h}${vertical ? 'v' : 'h'}${tiled ? 't' : ''}`;
          if (!(planes === drawn.fg && key === drawn.fgKey)) {
            if (!planes) {
              blit(fg, null);
              fgAlong = 0;
            } else if (tiled) {
              const s = createSurface(vertical ? planes.width : length, vertical ? length : planes.height);
              tileRect(s, 0, 0, s.width, s.height, planes, 0, 0, planes.width, planes.height);
              blit(fg, s);
              fgAlong = vertical ? s.height : s.width;
            } else {
              blit(fg, { width: planes.width, height: planes.height, data: planes.rgba });
              fgAlong = vertical ? planes.height : planes.width;
            }
            drawn.fg = planes;
            drawn.fgKey = key;
          }
        }
        setStyle(fgFill, 'display', 'none');
        setStyle(fg, 'display', 'block');
      } else if (colourMode && enabled) {
        // Colour mode: the fill is a CSS colour the length of the track, revealed like an image.
        hasFg = true;
        const f = colourFill(el.get('foregroundcolor'), el.get('foregroundendcolor'), vertical);
        setStyle(fgFill, 'background-color', f.color);
        setStyle(fgFill, 'background-image', f.image);
        setStyle(fgFill, 'display', 'block');
        setStyle(fg, 'display', 'none');
        fgAlong = length;
        // The size only: `layout` places it (it moves with the reveal edge).
        setStyle(fgFill, 'width', px(vertical ? w : length));
        setStyle(fgFill, 'height', px(vertical ? length : h));
      } else {
        setStyle(fg, 'display', 'none');
        setStyle(fgFill, 'display', 'none');
        drawn.fg = null;
        drawn.fgKey = '';
      }
    }

    // ---- thumb
    {
      const state = thumbState(enabled, pointer);
      const ref = thumbRef(
        { thumbImage: el.get('thumbimage'), thumbHoverImage: el.get('thumbhoverimage'), thumbDownImage: el.get('thumbdownimage'), thumbDisabledImage: el.get('thumbdisabledimage') },
        state,
        over,
      );
      if (!ref) {
        hasThumb = false;
        thumbExtent = { along: 0, across: 0 };
        if (drawn.thumb !== null) blit(thumb, null);
        drawn.thumb = null;
      } else {
        hasThumb = true;
        const probe = ctx.images.probe(ref);
        const got = planesFor(ref, 'thumb');
        if (got.planes || got.fresh) {
          if (got.planes !== drawn.thumb) {
            blit(thumb, got.planes ? { width: got.planes.width, height: got.planes.height, data: got.planes.rgba } : null);
            drawn.thumb = got.planes;
          }
        }
        const tw = got.planes?.width ?? probe?.width ?? 0;
        const th = got.planes?.height ?? probe?.height ?? 0;
        thumbExtent = vertical ? { along: th, across: tw } : { along: tw, across: th };
      }
    }
    layout();
  }

  /** Thumb and reveal positions from the value: no pixels are drawn here. */
  function layout() {
    const w = num(el, 'width');
    const h = num(el, 'height');
    const vertical = isVertical();
    const length = vertical ? h : w;
    const cross = vertical ? w : h;
    const f = fractionOf(num(el, 'value'), num(el, 'min', 0), num(el, 'max', 100));
    const axis = { vertical, length, thumb: thumbExtent.along, border: num(el, 'bordersize'), geometry: geometry() };

    if (hasThumb) {
      const along = thumbEdge(f, axis);
      const across = Math.round((cross - thumbExtent.across) / 2);
      setStyle(thumb, 'display', 'block');
      setStyle(thumb, 'left', px(vertical ? across : along));
      setStyle(thumb, 'top', px(vertical ? along : across));
    } else {
      setStyle(thumb, 'display', 'none');
    }

    if (hasFg) {
      const mode = el.get('x-foregroundmode') === 'playhead' ? 'playhead' : 'progress';
      const edge = revealEdge(f, axis, { mode, useProgress: el.get('useforegroundprogress') === true, progress: num(el, 'foregroundprogress') });
      const slide = el.get('slide') !== false;
      setStyle(fgClip, 'display', 'block');
      if (vertical) {
        // The fill grows from the bottom: the clip is the lower `edge` px of the box.
        placeBox(fgClip, { left: 0, top: length - edge, width: w, height: edge });
        const at = slide ? 0 : -(length - edge);
        setStyle(fg, 'top', px(at));
        setStyle(fg, 'left', '0px');
        setStyle(fgFill, 'top', px(at));
        setStyle(fgFill, 'left', '0px');
      } else {
        placeBox(fgClip, { left: 0, top: 0, width: edge, height: h });
        const at = slide ? edge - fgAlong : 0;
        setStyle(fg, 'left', px(at));
        setStyle(fg, 'top', '0px');
        setStyle(fgFill, 'left', px(at));
        setStyle(fgFill, 'top', '0px');
      }
    } else {
      setStyle(fgClip, 'display', 'none');
    }
  }

  function place() {
    placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: num(el, 'width'), height: num(el, 'height') });
  }

  return {
    node,
    apply(changed) {
      if (changed === null) {
        place();
        warmAll();
        paintPixels();
        setVisible(node, el.get('visible') !== false);
        setAlpha(node, num(el, 'alphablend', 255));
        applyCursor(node, el);
        return;
      }
      let boxChanged = false;
      let pixels = false;
      let position = false;
      for (const a of changed) {
        if (BOX_ATTRS.has(a)) boxChanged = true;
        if (POSITION_ATTRS.has(a)) position = true;
        else if (!BOX_ATTRS.has(a) && a !== 'visible' && a !== 'alphablend' && a !== 'left' && a !== 'top') pixels = true;
      }
      if (boxChanged) place();
      if (pixels || (boxChanged && (changed.has('width') || changed.has('height')))) {
        if (pixels) warmAll();
        paintPixels();
      }
      else if (position) layout();
      if (changed.has('visible')) setVisible(node, el.get('visible') !== false);
      if (changed.has('alphablend')) setAlpha(node, num(el, 'alphablend', 255));
      if (changed.has('cursor')) applyCursor(node, el);
    },
    pointer(p) {
      pointer = p;
      paintPixels();
    },
    repaint: paintPixels,
    dispose() {
      watch.dispose();
    },
  };
}
