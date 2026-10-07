// The scene around the controls (E D2 layer tree, drawables, slots, "Forbidden in engine code"):
// SUBVIEW clipping and its clippingColor mask, size-less subviews, paint order, alphaBlend, host slots,
// CUSTOMSLIDER frames, the DOM rules and diffed writes. Expected pixels come from the data written
// into each synthetic skin.

export const area = 'render';

const RED = [200, 30, 30];
const GREEN = [30, 200, 30];
const BLUE = [30, 30, 200];
const YELLOW = [220, 220, 30];
const CYAN = [30, 220, 220];
const MAGENTA = [255, 0, 255];
const CLIPRED = [255, 0, 0];

const view = (w, h, body, extra = '') =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false"${extra}>${body}</VIEW></THEME>`;

export const cases = [
  {
    id: 'subview-clip-nested',
    title: 'SUBVIEW: a sized subview clips its subtree; a nested one clips inside its parent',
    async run(t) {
      const red = t.bmp(10, 10, () => RED);
      const green = t.bmp(10, 10, () => GREEN);
      const wms = view(
        50,
        30,
        `<SUBVIEW id="sv1" left="5" top="5" width="20" height="16">
           <BUTTON id="b1" left="-3" top="-3" image="red.bmp"/>
           <SUBVIEW id="sv2" left="10" top="6" width="8" height="8">
             <BUTTON id="b2" left="4" top="4" image="green.bmp"/>
           </SUBVIEW>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'red.bmp': red, 'green.bmp': green } });
      // b1 covers view (2,2)-(12,12) but sv1 starts at (5,5): visible (5,5)-(12,12).
      // b2 covers view (19,15)-(29,25); sv2 is (15,11)-(23,19), inside sv1 (5,5)-(25,21): visible (19,15)-(23,19).
      const e = t.px(50, 30).fill([...RED, 255], 5, 5, 7, 7).fill([...GREEN, 255], 19, 15, 4, 4);
      await t.shot('clip', { x: 0, y: 0, w: 50, h: 30 }, e);
      // Moving the parent moves the clip with it.
      await t.set('sv1', 'left', 10);
      const m = t.px(50, 30).fill([...RED, 255], 10, 5, 2, 7).fill([...GREEN, 255], 24, 15, 1, 4);
      // b1 now spans view (7,2)-(17,12), clipped to sv1 (10,5)-(30,21): (10,5)-(17,12).
      m.fill([...RED, 255], 12, 5, 5, 7);
      // sv2 is at (20,11)-(28,19); b2 at (24,15)-(34,25): visible (24,15)-(28,19); sv1 right edge is 30.
      const moved = t.px(50, 30).fill([...RED, 255], 10, 5, 7, 7).fill([...GREEN, 255], 24, 15, 4, 4);
      await t.shot('clip-moved', { x: 0, y: 0, w: 50, h: 30 }, moved);
    },
  },

  {
    id: 'subview-sizeless-no-clip',
    title: 'SUBVIEW: a size-less subview does not clip (risk R10); a sized sibling does',
    async run(t) {
      const red = t.bmp(8, 8, () => RED);
      const wms = view(
        40,
        24,
        `<SUBVIEW id="grp" left="4" top="4"><BUTTON id="a" left="20" top="2" image="red.bmp"/></SUBVIEW>
         <SUBVIEW id="box" left="4" top="14" width="10" height="6"><BUTTON id="b" left="6" top="0" image="red.bmp"/></SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'red.bmp': red } });
      // grp has no size: a occupies view (24,6)-(32,14) whole.
      // box is (4,14)-(14,20); b occupies (10,14)-(18,22): visible (10,14)-(14,20).
      const e = t.px(40, 24).fill([...RED, 255], 24, 6, 8, 8).fill([...RED, 255], 10, 14, 4, 6);
      await t.shot('sizeless', { x: 0, y: 0, w: 40, h: 24 }, e);
      t.eq(t.computed(t.node('grp')).overflow, 'visible', 'the size-less subview has overflow: visible');
      t.eq(t.computed(t.node('box')).overflow, 'hidden', 'the sized subview has overflow: hidden');
    },
  },

  {
    id: 'subview-clip-switch',
    title: 'SUBVIEW: subviewClip=false turns clipping off',
    async run(t) {
      const red = t.bmp(8, 8, () => RED);
      const wms = view(30, 20, '<SUBVIEW id="box" left="2" top="2" width="6" height="6"><BUTTON id="b" left="4" top="0" image="red.bmp"/></SUBVIEW>');
      await t.mount({ wms, files: { 'red.bmp': red }, opts: { subviewClip: false } });
      await t.shot('no-clip', { x: 0, y: 0, w: 30, h: 20 }, t.px(30, 20).fill([...RED, 255], 6, 2, 8, 8));
    },
  },

  {
    id: 'subview-clippingcolor-mask',
    title: 'SUBVIEW: a clippingColor mask hides its background and also clips a child slot and a child button',
    async run(t) {
      // 16x16: a 4 px frame of the clipping colour around a blue centre.
      const bg = t.bmp(16, 16, (x, y) => (x < 4 || x >= 12 || y < 4 || y >= 12 ? CLIPRED : BLUE));
      const green = t.bmp(6, 6, () => GREEN);
      const wms = view(
        24,
        24,
        `<SUBVIEW id="sv" left="2" top="2" backgroundImage="bg.bmp" clippingColor="#FF0000">
           <EFFECTS id="fx" left="0" top="0" width="16" height="16"/>
           <BUTTON id="b" left="1" top="1" image="green.bmp"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'bg.bmp': bg, 'green.bmp': green } });
      // Inside the clip region (the centre [4,12)^2): the stub effects slot is black over the blue
      // background, and the button is green over both where it is inside ([4,7)^2). Outside it
      // (the frame) nothing shows at all: not the keyed background, not the slot, not the button.
      const e = t.px(24, 24).fill([0, 0, 0, 255], 2 + 4, 2 + 4, 8, 8).fill([...GREEN, 255], 2 + 4, 2 + 4, 3, 3);
      await t.shot('mask', { x: 0, y: 0, w: 24, h: 24 }, e);
      const css = t.computed(t.node('sv')).webkitMaskImage;
      t.assert(css.startsWith('url("data:image/png;base64,'), `the mask is a generated PNG data URL (got ${css.slice(0, 40)})`);
    },
  },

  {
    id: 'subview-background-keyed',
    title: 'SUBVIEW: transparencyColor keys only the background, backgroundTiled repeats it, backgroundColor fills',
    async run(t) {
      const bg = t.bmp(4, 4, (x) => (x < 2 ? BLUE : MAGENTA));
      const wms = view(
        30,
        16,
        `<SUBVIEW id="keyed" left="1" top="1" backgroundImage="bg.bmp" transparencyColor="#FF00FF"/>
         <SUBVIEW id="tiled" left="8" top="1" width="10" height="6" backgroundImage="bg.bmp" backgroundTiled="true" transparencyColor="#FF00FF"/>
         <SUBVIEW id="fill" left="20" top="1" width="6" height="6" backgroundColor="#336699"/>
         <SUBVIEW id="both" left="1" top="9" width="8" height="6" backgroundColor="#336699" backgroundImage="bg.bmp" transparencyColor="#FF00FF"/>`,
      );
      await t.mount({ wms, files: { 'bg.bmp': bg } });
      const e = t.px(30, 16);
      e.image(bg, 1, 1, { key: MAGENTA });
      for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) if (x % 4 < 2) e.put(8 + x, 1 + y, [...BLUE, 255]);
      e.fill([0x33, 0x66, 0x99, 255], 20, 1, 6, 6);
      // backgroundColor behind the keyed image: the colour shows through the keyed pixels, over the box
      e.fill([0x33, 0x66, 0x99, 255], 1, 9, 8, 6).image(bg, 1, 9, { key: MAGENTA });
      await t.shot('backgrounds', { x: 0, y: 0, w: 30, h: 16 }, e);
    },
  },

  {
    id: 'paint-order-z',
    title: 'Paint order: negative z under the background, equal z in document order, a runtime z re-sorts',
    async run(t) {
      const bg = t.bmp(20, 20, (x) => (x < 10 ? BLUE : MAGENTA));
      const red = t.bmp(20, 20, () => RED);
      const green = t.bmp(4, 4, () => GREEN);
      const yellow = t.bmp(8, 6, () => YELLOW);
      const cyan = t.bmp(8, 6, () => CYAN);
      const wms = view(
        20,
        20,
        `<SUBVIEW id="sv" left="0" top="0" backgroundImage="bg.bmp" transparencyColor="#FF00FF">
           <BUTTON id="neg" left="0" top="0" image="red.bmp" zIndex="-1"/>
           <BUTTON id="zero" left="2" top="2" image="green.bmp"/>
           <BUTTON id="b1" left="4" top="12" image="yellow.bmp" zIndex="1"/>
           <BUTTON id="b2" left="8" top="12" image="cyan.bmp" zIndex="1"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'bg.bmp': bg, 'red.bmp': red, 'green.bmp': green, 'yellow.bmp': yellow, 'cyan.bmp': cyan } });
      const scene = (order) => {
        const e = t.px(20, 20).image(red, 0, 0).image(bg, 0, 0, { key: MAGENTA }).image(green, 2, 2);
        for (const [img, x] of order) e.image(img, x, 12);
        return e;
      };
      // red (z -1) is under the background: only the keyed right half shows it
      await t.shot('equal-z-document-order', { x: 0, y: 0, w: 20, h: 20 }, scene([[yellow, 4], [cyan, 8]]));
      await t.set('b1', 'zIndex', 5);
      await t.shot('b1-raised', { x: 0, y: 0, w: 20, h: 20 }, scene([[cyan, 8], [yellow, 4]]));
      await t.set('b1', 'zIndex', 1);
      await t.shot('b1-back-to-equal', { x: 0, y: 0, w: 20, h: 20 }, scene([[yellow, 4], [cyan, 8]]));
      // The nodes are in paint order and nothing carries a z-index.
      const order = [...t.node('sv').children].map((n) => n.className);
      t.eq(order.join(','), 'button,bg,button,button,button', 'DOM order: the z -1 button, the background, then z 0, then the two z 1 buttons');
    },
  },

  {
    id: 'alphablend-subview',
    title: 'SUBVIEW: alphaBlend blends the subview as a unit',
    async run(t) {
      const wms = view(24, 16, '<SUBVIEW id="sv" left="2" top="2" width="16" height="10" backgroundColor="#0000FF" alphaBlend="128"/>', ' backgroundColor="#FFFFFF"');
      await t.mount({ wms });
      // 128/255 of blue over white: r = g = 255 * (1 - 128/255) = 127, b = 255. CSS opacity is 8-bit.
      const e = t.px(24, 16).fill([255, 255, 255, 255]).fill([127, 127, 255, 255], 2, 2, 16, 10);
      await t.shot('blended', { x: 0, y: 0, w: 24, h: 16 }, e, { tolerance: 2 });
      await t.set('sv', 'alphaBlend', 255);
      await t.shot('opaque', { x: 0, y: 0, w: 24, h: 16 }, t.px(24, 16).fill([255, 255, 255, 255]).fill([0, 0, 255, 255], 2, 2, 16, 10));
    },
  },

  {
    id: 'slot-effects',
    title: 'EFFECTS: a host slot in its context at its rect, following its subview, hidden with it',
    async run(t) {
      const wms = view(40, 30, '<SUBVIEW id="sv" left="4" top="3" width="30" height="20"><EFFECTS id="fx" left="2" top="1" width="10" height="8"/></SUBVIEW>');
      await t.mount({ wms });
      const handle = session(t).renderer.slotOf(t.el('fx'));
      t.assert(!!handle, 'slotOf returns the host handle');
      t.eq(JSON.stringify(handle.hitRects()), JSON.stringify([{ x: 6, y: 4, w: 10, h: 8 }]), 'the slot is told its rect in view px');
      t.eq(t.node('fx').parentElement, t.node('sv'), 'an effects slot lives in its context');
      await t.shot('black-stub', { x: 0, y: 0, w: 40, h: 30 }, t.px(40, 30).fill([0, 0, 0, 255], 6, 4, 10, 8));
      await t.set('sv', 'left', 10);
      t.eq(JSON.stringify(handle.hitRects()), JSON.stringify([{ x: 12, y: 4, w: 10, h: 8 }]), 'moving the subview moves the slot');
      await t.shot('moved', { x: 0, y: 0, w: 40, h: 30 }, t.px(40, 30).fill([0, 0, 0, 255], 12, 4, 10, 8));
      await t.set('sv', 'visible', false);
      t.eq(handle.hitRects().length, 0, 'a hidden subview hides its slot (no hit rect)');
      await t.shot('hidden', { x: 0, y: 0, w: 40, h: 30 }, t.px(40, 30));
      await t.set('sv', 'visible', true);
      await t.set('fx', 'width', 12);
      t.eq(JSON.stringify(handle.hitRects()), JSON.stringify([{ x: 12, y: 4, w: 12, h: 8 }]), 'resizing the element updates the slot');
    },
  },

  {
    id: 'slot-playlist-windowed',
    title: 'PLAYLIST: a windowed slot in the top layer at its view rect, ignoring z and clipping',
    async run(t) {
      const wms = view(60, 40, '<SUBVIEW id="sv" left="5" top="4" width="10" height="10"><PLAYLIST id="pl" left="3" top="2" width="30" height="20"/></SUBVIEW>');
      await t.mount({ wms });
      const s = session(t);
      const node = t.node('pl');
      t.assert(node.parentElement === s.renderer.windowed, 'a playlist slot is a child of div.windowed');
      t.eq(node.style.left, '8px', 'its left is the view x (5 + 3)');
      t.eq(node.style.top, '6px', 'its top is the view y (4 + 2)');
      t.eq(t.computed(node).overflow, 'visible', 'the sized parent subview does not clip it (spec 2.8)');
      const handle = s.renderer.slotOf(t.el('pl'));
      t.eq(JSON.stringify(handle.hitRects()), JSON.stringify([{ x: 8, y: 6, w: 30, h: 20 }]), 'the host is told the view rect');
      await t.set('sv', 'left', 20);
      t.eq(node.style.left, '23px', 'the windowed node follows its parent subview');
    },
  },

  {
    id: 'customslider-frames',
    title: 'CUSTOMSLIDER: the frame shown is round(f * (N - 1)) along the strip, horizontal and vertical',
    async run(t) {
      const colors = [RED, GREEN, BLUE];
      const hstrip = t.bmp(12, 4, (x) => colors[Math.floor(x / 4)]);
      const vstrip = t.bmp(4, 12, (x, y) => colors[Math.floor(y / 4)]);
      const pos = t.bmp(4, 4, () => [100, 100, 100]);
      const wms = view(
        20,
        10,
        `<CUSTOMSLIDER id="h" left="2" top="2" image="h.bmp" positionImage="pos.bmp" min="0" max="100" value="0"/>
         <CUSTOMSLIDER id="v" left="10" top="2" image="v.bmp" positionImage="pos.bmp" min="0" max="100" value="0"/>`,
      );
      await t.mount({ wms, files: { 'h.bmp': hstrip, 'v.bmp': vstrip, 'pos.bmp': pos } });
      for (const [value, frame] of [[0, 0], [25, Math.round(0.25 * 2)], [50, 1], [100, 2]]) {
        await t.set('h', 'value', value);
        await t.set('v', 'value', value);
        const e = t.px(20, 10).fill([...colors[frame], 255], 2, 2, 4, 4).fill([...colors[frame], 255], 10, 2, 4, 4);
        await t.shot(`value-${value}`, { x: 0, y: 0, w: 20, h: 10 }, e);
      }
    },
  },

  {
    id: 'dom-rules',
    title: 'DOM rules: layer tree shape, no image or markup nodes, no z-index, nodeOf, hostile ids',
    async run(t) {
      const img = t.bmp(6, 6, () => RED);
      const wms = view(
        60,
        40,
        `<SUBVIEW id="sv" left="0" top="0" width="40" height="30" zIndex="-3">
           <BUTTON id="__proto__" left="1" top="1" image="a.bmp" zIndex="2"/>
           <BUTTON id="constructor" left="9" top="1" image="a.bmp"/>
           <TEXT id="tx" left="1" top="10" value="text"/>
         </SUBVIEW>
         <SLIDER id="sl" left="2" top="32" width="20" height="6" backgroundColor="#222222"/>
         <EFFECTS id="fx" left="30" top="2" width="8" height="8"/>
         <PLAYLIST id="pl" left="40" top="2" width="10" height="20"/>`,
      );
      await t.mount({ wms, files: { 'a.bmp': img } });
      const s = session(t);
      const root = s.renderer.nodeOf(s.view.view);
      t.eq(root.className, 'view', 'the VIEW node is div.view');
      t.eq([...root.children].map((n) => n.className).join(','), 'layers,input,windowed,measure', 'div.view holds layers, the input plane, the windowed layer and the hidden measurer');
      t.eq(s.renderer.plane, root.children[1], 'the input plane is exposed');
      t.eq(t.computed(root.children[0]).pointerEvents, 'none', 'the painted layers take no pointer events');
      t.eq(t.computed(s.renderer.plane).pointerEvents, 'auto', 'the input plane does');
      t.assert(document.querySelectorAll('img').length === 0, 'no <img> anywhere');
      t.eq(t.node('__proto__').nodeName, 'CANVAS', 'an element called __proto__ has its node');
      t.eq(t.node('constructor').nodeName, 'CANVAS', 'an element called constructor has its node');
      t.eq(s.renderer.nodeOf(t.el('tx')).textContent, 'text', 'text is textContent');
      t.assert(s.renderer.slotOf(t.el('fx')) !== undefined && s.renderer.slotOf(t.el('pl')) !== undefined, 'both host slots mounted');
      t.assert(s.renderer.slotOf(t.el('tx')) === undefined, 'a TEXT has no slot');
      // sv is z -3: it is the first child of layers, under the background.
      const layers = root.children[0];
      t.eq([...layers.children].map((n) => n.className).join(','), 'sv,bg,slider,slot', 'paint order in the VIEW: the z -3 subview under the background, then the rest in document order');
    },
  },

  {
    id: 'diffed-writes',
    title: 'Diffed writes: a frame with nothing changed writes nothing (parity D34)',
    async run(t) {
      const img = t.bmp(6, 6, () => RED);
      const wms = view(
        40,
        30,
        `<SUBVIEW id="sv" left="2" top="2" width="30" height="20" backgroundColor="#223344">
           <BUTTON id="b" left="1" top="1" image="a.bmp"/>
           <TEXT id="tx" left="1" top="10" value="text"/>
           <SLIDER id="sl" left="10" top="1" width="20" height="6" backgroundColor="#222222" value="30"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'a.bmp': img } });
      const s = session(t);
      const root = document.getElementById('skin');
      const mo = new MutationObserver(() => {});
      mo.observe(root, { attributes: true, childList: true, subtree: true, characterData: true });
      mo.takeRecords();

      // A frame that claims every attribute changed, with nothing different: no DOM write at all.
      const all = ['left', 'top', 'width', 'height', 'visible', 'alphablend', 'zindex', 'value', 'image', 'enabled', 'backgroundcolor', 'backgroundimage', 'foregroundcolor', 'fontsize', 'direction', 'min', 'max', 'tiled', 'slide'];
      const dirty = new Map(s.view.elements.map((el) => [el, new Set(all)]));
      s.renderer.frame(dirty);
      const idle = mo.takeRecords();
      t.eq(idle.length, 0, `an idle frame writes nothing (saw ${idle.length}: ${idle.slice(0, 3).map((r) => `${r.type}:${r.attributeName ?? ''}`).join(' ')})`);

      // A real change touches exactly one node, once.
      t.el('b').set('left', 5, 'script');
      s.renderer.frame(s.view.takeDirty());
      const one = mo.takeRecords();
      t.eq(one.length, 1, `moving one button is one write (saw ${one.length})`);
      t.eq(one[0]?.target, t.node('b'), 'the write is on that button');

      // A slider value moves two positions and nothing else.
      t.el('sl').set('value', 60, 'script');
      s.renderer.frame(s.view.takeDirty());
      const slide = mo.takeRecords();
      t.assert(slide.length > 0 && slide.every((r) => r.type === 'attributes' && r.attributeName === 'style'), 'a slider value changes style attributes only (no node is added, no canvas is redrawn by a node swap)');
      mo.disconnect();
    },
  },
];

/** The mounted session the kit keeps. */
function session(t) {
  return t.session;
}
