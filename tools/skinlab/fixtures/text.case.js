// TEXT rendering (E D2 drawables table; spec 6.10; parity 4.1 "text parity", G8, D22). Glyph pixels
// depend on the machine's fonts, so these cases assert the box and the style the engine wrote, as the
// browser computed them, plus one solid-colour box for exact pixels. A text diff against the oracle is
// the parity gate's job (W5.1); here the contract is that the engine emits the oracle's box.

export const area = 'render';

const view = (w, h, body) =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

/** The width the page itself measures for `text` in a font, for comparing with `textWidth`. */
function measure(t, family, px, weight, text) {
  const s = document.createElement('span');
  s.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${family};font-size:${px}px;font-weight:${weight}`;
  s.textContent = text;
  document.body.appendChild(s);
  const w = s.offsetWidth;
  s.remove();
  return w;
}

export const cases = [
  {
    id: 'text-style',
    title: 'TEXT: size = round(pt * 4/3), justification, ellipsis, flags, sanitised faces, textContent only, textWidth',
    async run(t) {
      const wms = view(
        200,
        120,
        `<TEXT id="seven" left="2" top="2" fontSize="7" value="Hi"/>
         <TEXT id="def" left="2" top="14" value="Hi"/>
         <TEXT id="cen" left="2" top="30" width="60" justification="Center" value="mid"/>
         <TEXT id="rig" left="2" top="44" width="60" justification="Right" value="right"/>
         <TEXT id="crop" left="2" top="58" width="30" value="The quick brown fox jumps"/>
         <TEXT id="free" left="70" top="58" value="The quick brown fox jumps"/>
         <TEXT id="flags" left="2" top="72" fontStyle="Bold Italic Underline Strikeout" value="flags"/>
         <TEXT id="normal" left="60" top="72" fontStyle="Normal Bold Underline" value="normal"/>
         <TEXT id="face" left="2" top="86" fontFace="Arial, &quot;evil}, Courier New,  , url(x)" value="face"/>
         <TEXT id="markup" left="2" top="100" value="&lt;b&gt;x&lt;/b&gt;&lt;img src=x&gt;"/>
         <TEXT id="alpha" left="100" top="2" alphaBlend="100" value="dim"/>
         <TEXT id="hover" left="100" top="14" foregroundColor="#FF0000" hoverForegroundColor="#00FF00" disabledForegroundColor="#808080" value="hover"/>
         <TEXT id="fallback" left="100" top="30" foregroundColor="#0000FF" value="fb"/>
         <TEXT id="wrap" left="100" top="44" width="30" height="24" wordWrap="true" value="aaa bbb ccc ddd"/>
         <TEXT id="smooth" left="100" top="72" fontSmoothing="true" value="smooth"/>`,
      );
      await t.mount({ wms });
      const cs = (id) => t.computed(t.node(id));

      t.eq(cs('seven').fontSize, '9px', 'fontSize 7 pt is 9 px (parity G8)');
      t.eq(cs('def').fontSize, '13px', 'the default 10 pt is 13 px');
      t.eq(cs('cen').textAlign, 'center', 'Center justification');
      t.eq(cs('rig').textAlign, 'right', 'Right justification');
      t.eq(cs('crop').textOverflow, 'ellipsis', 'a width crops with an ellipsis');
      t.eq(cs('crop').overflow, 'hidden', 'the crop clips');
      const crop = t.node('crop');
      t.assert(crop.scrollWidth > crop.clientWidth, `the long text overflows its 30 px box (scrollWidth ${crop.scrollWidth}, clientWidth ${crop.clientWidth})`);
      t.eq(crop.clientWidth, 30, 'the box is exactly the width the skin gave');
      t.assert(t.el('crop').get('textWidth') > 30, `textWidth (${t.el('crop').get('textWidth')}) is the whole string's width, not the cropped box`);
      t.eq(cs('free').textOverflow, 'clip', 'no width: the text sizes the box, nothing is cropped');
      t.eq(t.node('free').offsetWidth, t.el('free').get('textWidth'), 'with no width the box is textWidth wide');

      t.eq(cs('flags').fontWeight, '700', 'Bold');
      t.eq(cs('flags').fontStyle, 'italic', 'Italic');
      t.eq(cs('flags').textDecorationLine, 'underline line-through', 'Underline and Strikeout');
      t.eq(cs('normal').fontWeight, '400', 'Normal wins over Bold');
      t.eq(cs('normal').textDecorationLine, 'none', 'Normal wins over Underline');

      const family = t.node('face').style.fontFamily;
      t.assert(family.includes('Arial') && family.includes('Courier New'), `the two valid faces survive: ${family}`);
      t.assert(!family.includes('evil') && !family.includes('url') && !family.includes('}'), `the invalid faces are dropped: ${family}`);
      t.assert(family.endsWith('Tahoma, Verdana, sans-serif'), `the fallback stack follows: ${family}`);

      const markup = t.node('markup');
      t.eq(markup.children.length, 0, 'text is never parsed as markup: no child elements');
      t.eq(markup.textContent, '<b>x</b><img src=x>', 'the value is the text, as written');

      t.eq(cs('def').whiteSpace, 'nowrap', 'white-space: nowrap unless wordWrap');
      t.eq(cs('def').lineHeight, 'normal', 'line-height: normal');
      t.eq(cs('def').paddingTop, '0px', 'no padding');
      t.eq(cs('def').position, 'absolute', 'positioned at left/top');
      t.eq(t.node('def').style.left, '2px', 'left');
      t.eq(t.node('def').style.top, '14px', 'top');
      t.eq(cs('def').webkitFontSmoothing, 'none', 'font smoothing off, as the oracle');
      t.eq(cs('smooth').webkitFontSmoothing, 'auto', 'fontSmoothing="true" turns it on');
      t.eq(cs('wrap').whiteSpace, 'pre-line', 'wordWrap with a width wraps');

      t.eq(cs('alpha').backgroundColor, 'rgb(0, 0, 0)', 'alphaBlend with no backgroundColor gets a black background (spec 5.4)');
      t.eq(cs('def').backgroundColor, 'rgba(0, 0, 0, 0)', 'no backgroundColor: transparent');

      const width = measure(t, cs('def').fontFamily, 13, 400, 'Hi');
      t.eq(t.el('def').get('textWidth'), width, 'textWidth is the width the page measures for the same string and font');
      await t.set('def', 'value', 'Hi there');
      t.eq(t.el('def').get('textWidth'), measure(t, cs('def').fontFamily, 13, 400, 'Hi there'), 'textWidth follows the value');
      await t.set('def', 'value', '');
      t.eq(t.el('def').get('textWidth'), 0, 'an empty string is 0 wide');

      t.eq(cs('hover').color, 'rgb(255, 0, 0)', 'normal colour');
      await t.pointer('hover');
      t.eq(cs('hover').color, 'rgb(0, 255, 0)', 'hover colour');
      await t.pointer('fallback');
      t.eq(cs('fallback').color, 'rgb(0, 0, 255)', 'hover falls back to the normal colour when unset');
      await t.pointer(null);
      await t.set('hover', 'enabled', false);
      t.eq(cs('hover').color, 'rgb(128, 128, 128)', 'disabled colour');
    },
  },

  {
    id: 'text-box',
    title: 'TEXT: the box is exactly left, top, width and height (solid backgroundColor, no glyphs)',
    async run(t) {
      const wms = view(30, 16, '<TEXT id="b" left="3" top="2" width="12" height="6" backgroundColor="#336699" value=""/>');
      await t.mount({ wms });
      await t.shot('box', { x: 0, y: 0, w: 30, h: 16 }, t.px(30, 16).fill([0x33, 0x66, 0x99, 255], 3, 2, 12, 6));
      await t.set('b', 'left', 10);
      await t.set('b', 'width', 4);
      await t.shot('moved', { x: 0, y: 0, w: 30, h: 16 }, t.px(30, 16).fill([0x33, 0x66, 0x99, 255], 10, 2, 4, 6));
      await t.set('b', 'visible', false);
      await t.shot('hidden', { x: 0, y: 0, w: 30, h: 16 }, t.px(30, 16));
    },
  },

  {
    id: 'text-marquee',
    title: 'TEXT: a marquee steps scrollingAmount px every scrollingDelay ms on the manual clock',
    async run(t) {
      const wms = view(
        120,
        40,
        `<TEXT id="m" left="2" top="2" width="20" scrolling="true" value="a long line of scrolling text"/>
         <TEXT id="r" left="2" top="14" width="20" scrolling="true" scrollingDirection="Right" scrollingAmount="4" scrollingDelay="50" value="a long line of scrolling text"/>
         <TEXT id="fast" left="2" top="26" width="20" scrolling="true" scrollingDelay="10" value="a long line of scrolling text"/>
         <TEXT id="fits" left="40" top="2" width="100" scrolling="true" value="x"/>`,
      );
      await t.mount({ wms });
      const indent = (id) => t.node(id).style.textIndent;
      await t.advance(0);
      t.eq(indent('m'), '0px', 'nothing has moved at t = 0');
      t.assert(t.node('m').textContent.includes('  '), 'the repeat follows two spaces');
      t.eq(t.computed(t.node('m')).whiteSpace, 'pre', 'a marquee keeps its spaces');

      // Frames fall every 16 ms; a step is due when elapsed / 85 passes a whole number.
      await t.advance(80); // last frame at 80 ms: no step yet
      t.eq(indent('m'), '0px', 'no step before 85 ms');
      await t.advance(20); // frames to 96 ms: one step
      t.eq(indent('m'), '-6px', 'one step of scrollingAmount (6) after 85 ms');
      await t.advance(80); // frames to 176 ms: two steps
      t.eq(indent('m'), '-12px', 'two steps after 170 ms');
      t.eq(indent('fast'), '-12px', 'a delay under 30 ms means the default 85 (spec 6.10)');
      t.eq(indent('fits'), '', 'text that fits does not scroll');

      // Right: the text moves left to right, 4 px every 50 ms. After 176 ms: 3 steps = 12 px.
      const text = t.el('r').get('value');
      t.assert(t.node('r').textContent.length > text.length, 'the content is the text, the gap and the text again');
      const got = Number.parseFloat(indent('r'));
      t.assert(got < 0 && got > -t.el('r').get('textWidth') - 20, `moving right shows a negative indent that is the cycle minus 12 px (got ${got})`);
      const cycleWidth = t.el('r').get('textWidth') + measure(t, t.computed(t.node('r')).fontFamily, 13, 400, '  ');
      t.eq(got, 12 - cycleWidth, 'Right: indent = steps * amount - cycle');

      // Retargeting the text restarts the marquee at the current time.
      await t.set('m', 'value', 'another very long line of text, scrolling');
      t.eq(indent('m'), '0px', 'a new value restarts the marquee');
    },
  },
];

