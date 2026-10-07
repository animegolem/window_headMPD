// BUTTON and BUTTONGROUP rendering (E D2 drawables table; spec 6.4, 6.5). Every picture is built here
// from flat colour blocks, so the expected pixels follow from the data written into the skin. The state
// resolution below is written out again, independently of the engine: disabled > hoverDown > down >
// hover > up, with the fallback chain `hover ?? up`, `down ?? hover ?? up`, `hoverDown ?? down`,
// `disabled ?? up` (widgets:46, D2).

export const area = 'render';

const RED = [200, 30, 30];
const GREEN = [30, 200, 30];
const BLUE = [30, 30, 200];
const GRAY = [128, 128, 128];
const YELLOW = [220, 220, 30];
const MAGENTA = [255, 0, 255];

const view = (w, h, body) =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

/** The image a BUTTON shows in a state, given which of its images the skin supplied. */
function resolve(images, state) {
  const chain = {
    up: ['image'],
    hover: ['hoverImage', 'image'],
    down: ['downImage', 'hoverImage', 'image'],
    hoverDown: ['hoverDownImage', 'downImage', 'hoverImage', 'image'],
    disabled: ['disabledImage', 'image'],
  }[state];
  for (const k of chain) if (images[k]) return images[k];
  return null;
}

export const cases = [
  {
    id: 'button-states',
    title: 'BUTTON: the five states and the fallback chain',
    async run(t) {
      const W = 10;
      const H = 8;
      const solid = (c) => t.bmp(W, H, () => c);
      const set = {
        full: { image: solid(RED), hoverImage: solid(GREEN), downImage: solid(BLUE), hoverDownImage: solid(YELLOW), disabledImage: solid(GRAY) },
        only: { image: solid(RED) },
        hoverOnly: { image: solid(RED), hoverImage: solid(GREEN) },
        downOnly: { image: solid(RED), downImage: solid(BLUE) },
      };
      const names = ['full', 'only', 'hoverOnly', 'downOnly'];
      const files = {};
      let wms = '';
      names.forEach((n, i) => {
        const attrs = [];
        for (const [k, img] of Object.entries(set[n])) {
          files[`${n}-${k}.bmp`] = img;
          attrs.push(`${k}="${n}-${k}.bmp"`);
        }
        wms += `<BUTTON id="${n}" left="${2 + i * 14}" top="2" ${attrs.join(' ')}/>`;
      });
      await t.mount({ wms: view(60, 14, wms), files });

      const rectOf = (i) => ({ x: 2 + i * 14, y: 2, w: W, h: H });
      const expectState = (n, state) => {
        const img = resolve(set[n], state);
        return t.px(W, H).image(img, 0, 0);
      };

      for (const [i, n] of names.entries()) {
        await t.pointer(null, null);
        await t.shot(`${n}-up`, rectOf(i), expectState(n, 'up'));
        await t.pointer(n, null);
        await t.shot(`${n}-hover`, rectOf(i), expectState(n, 'hover'));
        await t.pointer(n, n);
        await t.shot(`${n}-hoverDown`, rectOf(i), expectState(n, 'hoverDown'));
        // The press began here and the pointer has left: the oracle shows the up image.
        await t.pointer(null, n);
        await t.shot(`${n}-pressedOutside`, rectOf(i), expectState(n, 'up'));
      }

      for (const [i, n] of names.entries()) {
        await t.set(n, 'enabled', false);
        await t.shot(`${n}-disabled`, rectOf(i), expectState(n, 'disabled'));
      }
    },
  },

  {
    id: 'button-key-tile-sticky',
    title: 'BUTTON: transparencyColor, tiled, a latched sticky button, an image-less button',
    async run(t) {
      const keyed = t.bmp(10, 8, (x, y) => (x < 2 && y < 2 ? MAGENTA : RED));
      const tile = t.bmp(4, 4, (x, y) => ((x + y) % 2 === 0 ? GREEN : BLUE));
      const up = t.bmp(10, 8, () => RED);
      const down = t.bmp(10, 8, () => BLUE);
      const wms = view(
        60,
        30,
        `<BUTTON id="key" left="2" top="2" image="keyed.bmp" transparencyColor="#FF00FF"/>
         <BUTTON id="nokey" left="14" top="2" image="keyed.bmp"/>
         <BUTTON id="tile" left="26" top="2" width="10" height="8" image="tile.bmp" tiled="true"/>
         <BUTTON id="crop" left="38" top="2" width="6" height="5" image="tile.bmp"/>
         <BUTTON id="sticky" left="2" top="14" image="up.bmp" downImage="down.bmp" sticky="true" down="true"/>
         <BUTTON id="loose" left="14" top="14" image="up.bmp" downImage="down.bmp" sticky="false" down="true"/>
         <BUTTON id="blank" left="26" top="14" width="10" height="8"/>`,
      );
      await t.mount({ wms, files: { 'keyed.bmp': keyed, 'tile.bmp': tile, 'up.bmp': up, 'down.bmp': down } });

      const e = t.px(60, 30);
      e.image(keyed, 2, 2, { key: MAGENTA });
      e.image(keyed, 14, 2); // no key declared: the magenta stays
      // tiled: the 4x4 tile repeated over 10x8, cut at the box
      for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) e.put(26 + x, 2 + y, (x % 4 + y % 4) % 2 === 0 ? [...GREEN, 255] : [...BLUE, 255]);
      // not tiled: the image cropped to the 6x5 box
      e.image(tile, 38, 2, { crop: { x: 0, y: 0, w: 4, h: 4 } });
      e.image(down, 2, 14); // sticky and down: latched
      e.image(up, 14, 14); // `down` is ignored unless sticky
      // the image-less button paints nothing
      await t.shot('rest', { x: 0, y: 0, w: 60, h: 30 }, e);
      t.assert(t.node('blank').width === 10 && t.node('blank').height === 8, 'an image-less button with a size still has a 10x8 canvas');
    },
  },

  {
    id: 'buttongroup-states',
    title: 'BUTTONGROUP: per-pixel states, unowned pixels transparent by default',
    async run(t) {
      const EA = [255, 0, 51];
      const EB = [0, 255, 0];
      const OTHER = [90, 90, 90];
      const map = t.bmp(30, 10, (x) => (x < 10 ? EA : x < 20 ? EB : OTHER));
      const layer = (c) => t.bmp(30, 10, () => c);
      const imgs = { image: layer(RED), hoverImage: layer(GREEN), downImage: layer(BLUE), hoverDownImage: layer(YELLOW), disabledImage: layer(GRAY) };
      const files = { 'map.bmp': map };
      let attrs = '';
      for (const [k, img] of Object.entries(imgs)) { files[`${k}.bmp`] = img; attrs += ` ${k}="${k}.bmp"`; }
      const wms = view(40, 14, `<BUTTONGROUP id="g" left="4" top="2" mappingImage="map.bmp"${attrs}><BUTTONELEMENT id="ea" mappingColor="#FF0033"/><BUTTONELEMENT id="eb" mappingColor="#00FF00"/></BUTTONGROUP>`);
      await t.mount({ wms, files });

      /** Each region's colour for the states of the two elements. unowned is absent (transparent). */
      const picture = (a, b) => {
        const e = t.px(30, 10);
        e.fill([...a, 255], 0, 0, 10, 10);
        e.fill([...b, 255], 10, 0, 10, 10);
        return e;
      };
      const box = { x: 4, y: 2, w: 30, h: 10 };
      await t.shot('rest', box, picture(RED, RED));
      await t.pointer({ id: 'g', part: 0 });
      await t.shot('hover-a', box, picture(GREEN, RED));
      await t.pointer({ id: 'g', part: 0 }, { id: 'g', part: 0 });
      await t.shot('hoverDown-a', box, picture(YELLOW, RED));
      await t.pointer({ id: 'g', part: 1 }, { id: 'g', part: 0 });
      await t.shot('pressed-a-over-b', box, picture(RED, GREEN)); // a's press is not over a: up; b is hovered
      await t.pointer(null, null);
      await t.set('eb', 'enabled', false);
      await t.shot('disabled-b', box, picture(RED, GRAY));
      await t.set('ea', 'sticky', true);
      await t.set('ea', 'down', true);
      await t.shot('latched-a', box, picture(BLUE, GRAY));
    },
  },

  ...[
    { id: 'buttongroup-showbackground-true', title: 'BUTTONGROUP: showBackground="true" paints the unowned pixels from `image`', config: 'faithful', attr: ' showBackground="true"', painted: true },
    { id: 'buttongroup-showbackground-false', title: 'BUTTONGROUP: showBackground="false" leaves them, even under oracle-compat', config: 'compat', attr: ' showBackground="false"', painted: false },
    { id: 'buttongroup-showbackground-compat-default', title: 'BUTTONGROUP: undeclared showBackground follows the engine switch (compat paints)', config: 'compat', attr: '', painted: true },
    { id: 'buttongroup-showbackground-faithful-default', title: 'BUTTONGROUP: undeclared showBackground is false in faithful', config: 'faithful', attr: '', painted: false },
  ].map((v) => ({
    id: v.id,
    title: v.title,
    async run(t) {
      const EA = [255, 0, 51];
      const map = t.bmp(12, 6, (x) => (x < 6 ? EA : [10, 20, 30]));
      const up = t.bmp(12, 6, () => RED);
      const hover = t.bmp(12, 6, () => GREEN);
      const wms = view(20, 10, `<BUTTONGROUP id="g" left="2" top="2" mappingImage="map.bmp" image="up.bmp" hoverImage="hover.bmp"${v.attr}><BUTTONELEMENT id="ea" mappingColor="#FF0033"/></BUTTONGROUP>`);
      await t.mount({ wms, files: { 'map.bmp': map, 'up.bmp': up, 'hover.bmp': hover }, config: v.config });
      const e = t.px(12, 6);
      e.fill([...RED, 255], 0, 0, 6, 6);
      if (v.painted) e.fill([...RED, 255], 6, 0, 6, 6);
      await t.shot('rest', { x: 2, y: 2, w: 12, h: 6 }, e);
      // Hovering the owned half lights only that half; the unowned half is the up layer or nothing.
      await t.pointer({ id: 'g', part: 0 });
      const h = t.px(12, 6);
      h.fill([...GREEN, 255], 0, 0, 6, 6);
      if (v.painted) h.fill([...RED, 255], 6, 0, 6, 6);
      await t.shot('hover', { x: 2, y: 2, w: 12, h: 6 }, h);
    },
  })),
];
