// @ts-check
// TEXT and the predefined texts (E D2 drawables table; spec 6.10; parity 4.1 "text parity"): one
// `span` per element. The text is set with `textContent` and nothing else; fonts, sizes and colours
// come from `strings.js`. The box is the oracle's: absolute at left/top, no padding, `line-height:
// normal`, `white-space: nowrap` unless `wordWrap`, `-webkit-font-smoothing: none`, a size of
// `round(pt * 4 / 3)` px. A width cuts the text with an ellipsis; no width lets the text size the box.
//
// `textWidth` (read-only to skins) is measured on the renderer's hidden span with the same font and
// written back with origin 'host'. `scrolling` is a marquee stepped on the engine clock (marquee.js):
// the text moves through `text-indent`, the content is the text, two spaces and the text again, and
// it runs only when the text does not fit the width the skin gave it.

import { GAP, marqueeIndent, marqueeParams } from './marquee.js';
import { applyCursor, makeNode, num, placeBox, px, setAlpha, setStyle, setVisible, str } from './dom.js';
import { NO_POINTER, textAttr, textVariant } from './states.js';
import { decorationCss, fontFamilyCss, fontFlags, fontPx, letterSpacingCss, rgbCss } from './strings.js';

/** @typedef {import('../../contracts').ElementModel} ElementModel */
/** @typedef {import('./dom.js').RenderContext} RenderContext */
/** @typedef {import('./dom.js').Drawable} Drawable */

/** Every attribute that can change how a TEXT looks or measures. */
const TEXT_ATTRS = new Set([
  'value', 'fontface', 'fontsize', 'fontstyle', 'foregroundcolor', 'backgroundcolor', 'justification',
  'hoverforegroundcolor', 'hoverbackgroundcolor', 'hoverfontstyle', 'disabledforegroundcolor',
  'disabledbackgroundcolor', 'disabledfontstyle', 'fontsmoothing', 'wordwrap', 'scrolling', 'scrollingamount',
  'scrollingdelay', 'scrollingdirection', 'left', 'top', 'width', 'height', 'enabled', 'alphablend',
]);

/** @param {string} v @returns {string} line breaks as `\n`, which is what `pre-line` honours */
const normaliseBreaks = (v) => v.replace(/\r\n?/g, '\n');

/**
 * @param {RenderContext} ctx @param {ElementModel} el
 * @returns {Drawable}
 */
export function createText(ctx, el) {
  const node = makeNode(ctx.doc, 'span', 'text');
  setStyle(node, 'margin', '0');
  setStyle(node, 'padding', '0');
  setStyle(node, 'line-height', 'normal');
  let pointer = NO_POINTER;
  let lastText = null;
  /** Marquee state: running or not, when it started, the period. */
  const marquee = { active: false, start: 0, cycle: 0, amount: 6, delay: 85, direction: /** @type {'Left' | 'Right'} */ ('Left'), key: '' };

  /** The font declarations shared by the node and the measurer. */
  function fontOf() {
    const flags = fontFlags(textAttr(el, 'FontStyle', textVariant(el.get('enabled') !== false, pointer)));
    return {
      family: fontFamilyCss(str(el, 'fontface')),
      size: px(fontPx(num(el, 'fontsize', 10))),
      weight: flags.bold ? 'bold' : 'normal',
      style: flags.italic ? 'italic' : 'normal',
      decoration: decorationCss(flags),
    };
  }

  /** Measurements by text and font, so a hover that changes nothing but a colour does not reflow. @type {Map<string, number>} */
  const measured = new Map();

  /** @param {string} text @returns {number} the width of `text` in the element's normal font, in px */
  function measure(text) {
    const normal = fontFlags(el.get('fontstyle'));
    const family = fontFamilyCss(str(el, 'fontface'));
    const size = px(fontPx(num(el, 'fontsize', 10)));
    const spacing = letterSpacingCss(/** @type {any} */ (el).hostStyle?.letterSpacing) ?? '';
    const key = `${family}|${size}|${normal.bold ? 'b' : ''}${normal.italic ? 'i' : ''}|${spacing}|${text}`;
    const known = measured.get(key);
    if (known !== undefined) return known;
    const m = ctx.measurer;
    setStyle(m, 'font-family', family);
    setStyle(m, 'font-size', size);
    setStyle(m, 'font-weight', normal.bold ? 'bold' : 'normal');
    setStyle(m, 'font-style', normal.italic ? 'italic' : 'normal');
    setStyle(m, 'letter-spacing', spacing);
    m.textContent = normaliseBreaks(text).replace(/\n/g, ' ');
    const width = m.offsetWidth;
    if (measured.size > 8) measured.clear(); // a script that rewrites `value` every frame must not grow this
    measured.set(key, width);
    return width;
  }

  function render() {
    const enabled = el.get('enabled') !== false;
    const variant = textVariant(enabled, pointer);
    const font = fontOf();
    const w = num(el, 'width');
    const h = num(el, 'height');
    const alpha = num(el, 'alphablend', 255);
    const value = normaliseBreaks(str(el, 'value'));
    const wordWrap = el.get('wordwrap') === true && w > 0;
    const scrolling = el.get('scrolling') === true && w > 0 && !wordWrap;

    // textWidth first, because the marquee needs it.
    const natural = measure(value);
    el.set('textwidth', natural, 'host');

    const params = marqueeParams(el.get('scrollingamount'), el.get('scrollingdelay'));
    const direction = el.get('scrollingdirection') === 'Right' ? 'Right' : 'Left';
    const active = scrolling && natural > w;
    const mKey = `${active ? 1 : 0}|${value}|${font.family}|${font.size}|${params.amount}|${params.delay}|${direction}`;
    if (mKey !== marquee.key) {
      marquee.key = mKey;
      marquee.active = active;
      marquee.start = ctx.now();
      marquee.amount = params.amount;
      marquee.delay = params.delay;
      marquee.direction = direction;
      marquee.cycle = active ? measure(value + GAP) : 0;
    }

    placeBox(node, { left: num(el, 'left'), top: num(el, 'top'), width: w, height: h }, true);
    setStyle(node, 'font-family', font.family);
    setStyle(node, 'font-size', font.size);
    setStyle(node, 'font-weight', font.weight);
    setStyle(node, 'font-style', font.style);
    setStyle(node, 'text-decoration-line', font.decoration === 'none' ? '' : font.decoration);
    setStyle(node, 'color', rgbCss(textAttr(el, 'ForegroundColor', variant)) ?? '#000000');
    const bg = rgbCss(textAttr(el, 'BackgroundColor', variant));
    // spec 5.4: a TEXT with alphaBlend and no colour of its own gets a black background.
    setStyle(node, 'background-color', bg ?? (alpha < 255 ? '#000000' : ''));
    setStyle(node, 'text-align', str(el, 'justification').toLowerCase() || 'left');
    setStyle(node, '-webkit-font-smoothing', el.get('fontsmoothing') === true ? 'auto' : 'none');
    setStyle(node, 'letter-spacing', letterSpacingCss(/** @type {any} */ (el).hostStyle?.letterSpacing) ?? '');
    setStyle(node, 'white-space', marquee.active ? 'pre' : wordWrap ? 'pre-line' : 'nowrap');
    // A width crops the text (with an ellipsis, spec 6.10); without one the text sizes the box.
    setStyle(node, 'overflow', w > 0 ? 'hidden' : '');
    setStyle(node, 'text-overflow', w > 0 && !marquee.active && !wordWrap ? 'ellipsis' : '');
    if (!marquee.active) setStyle(node, 'text-indent', '');

    const shown = marquee.active ? `${value.replace(/\n/g, ' ')}${GAP}${value.replace(/\n/g, ' ')}` : value;
    if (shown !== lastText) {
      node.textContent = shown;
      lastText = shown;
    }
    setVisible(node, el.get('visible') !== false);
    setAlpha(node, alpha);
    applyCursor(node, el);
  }

  return {
    node,
    apply(changed) {
      if (changed === null || [...changed].some((a) => TEXT_ATTRS.has(a))) render();
      else if (changed.has('visible')) setVisible(node, el.get('visible') !== false);
    },
    pointer(p) {
      pointer = p;
      render();
    },
    tick(now) {
      if (!marquee.active) return;
      setStyle(node, 'text-indent', px(marqueeIndent({ elapsed: now - marquee.start, amount: marquee.amount, delay: marquee.delay, cycle: marquee.cycle, direction: marquee.direction })));
    },
    repaint: render,
    dispose() {},
  };
}
