// A SUBVIEW's clippingColor mask scaled by the view (WAVES 5F.2). Chromium samples a CSS mask image
// with the masked box's own `image-rendering`; left at `auto`, a 2x mask is bilinear and the kept side
// of every clip edge loses a quarter of its alpha. That is what made Headspace's head silhouette differ
// from the oracle at DPR 2. The fixtures run at DPR 1, so the view's zoom of 2 stands in for the device
// scale: the mask is scaled by the same factor on the same paint path.

export const area = 'render';

const BLUE = [30, 30, 200];
const GREEN = [30, 200, 30];
const CLIPRED = [255, 0, 0];

const view = (w, h, body) =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

/** The kept pixels of the mask: an 8x8 image minus a 1 px frame and a notch, so there are inner and outer corners. */
const kept = (x, y) => x >= 1 && x < 7 && y >= 1 && y < 7 && !(x >= 4 && y < 3);

export const cases = [
  {
    id: 'subview-clippingcolor-mask-zoom2',
    title: 'SUBVIEW: at zoom 2 a clippingColor mask scales without smoothing, like the canvases under it',
    async run(t) {
      const bg = t.bmp(8, 8, (x, y) => (kept(x, y) ? BLUE : CLIPRED));
      // A child that covers the whole subview: only the mask decides where it shows.
      const green = t.bmp(8, 8, () => GREEN);
      const wms = view(
        12,
        12,
        `<SUBVIEW id="sv" left="2" top="2" backgroundImage="bg.bmp" clippingColor="#FF0000">
           <BUTTON id="b" left="0" top="0" image="green.bmp"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'bg.bmp': bg, 'green.bmp': green }, zoom: 2 });
      // Each kept skin pixel is a whole 2x2 block of opaque green; every other screen pixel is empty.
      const e = t.px(24, 24);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (kept(x, y)) e.fill([...GREEN, 255], (2 + x) * 2, (2 + y) * 2, 2, 2);
      await t.shot('mask-zoom2', { x: 0, y: 0, w: 24, h: 24 }, e);
      t.eq(t.computed(t.node('sv')).imageRendering, 'pixelated', 'the masked subview samples its mask pixelated');
    },
  },
];
