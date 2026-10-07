// A container masked by a `clippingImage` alone (WAVES 5F.10, ENGINE U-7). With no `backgroundImage` the
// clipping image is the whole mask: its pixels that are not the clipping colour keep the subtree, at the
// image's native size from the container's corner, and everything past the image is hidden. The corpus
// uses it as `backgroundColor="pink" clippingImage="infomask.gif"` overlays and as button-group masks.
// The SUBVIEWs here have an explicit size on purpose: a size-less masked SUBVIEW does not occur in the
// corpus (5F.10 (b) counted none) and Chromium's border-box mask-clip would hide its children.
// Every picture is computed from the data the case writes; nothing here comes from skin art.

export const area = 'render';

const BLUE = [30, 30, 200];
const GREEN = [30, 200, 30];
const CLIPRED = [255, 0, 0];

const view = (w, h, body) =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

/** The kept pixels of the 8x6 clipping image: a frame of the clipping colour and a notch, so there are inner and outer corners. */
const kept = (x, y) => x >= 1 && x < 7 && y >= 1 && y < 5 && !(x >= 4 && y < 2);
const MW = 8;
const MH = 6;

export const cases = [
  {
    id: 'subview-clippingimage-only-mask',
    title: 'SUBVIEW: a clippingImage with no background masks the children at the image\'s native size, not the box',
    async run(t) {
      // The clipping image is blue where kept, so `auto` (pixel 0,0 = the clipping colour) is red.
      const clip = t.bmp(MW, MH, (x, y) => (kept(x, y) ? BLUE : CLIPRED));
      // A child that covers the whole 12x12 box: only the mask decides where it shows.
      const green = t.bmp(12, 12, () => GREEN);
      const wms = view(
        16,
        16,
        `<SUBVIEW id="sv" left="2" top="2" width="12" height="12" clippingImage="clip.bmp">
           <BUTTON id="b" left="0" top="0" image="green.bmp"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'clip.bmp': clip, 'green.bmp': green } });
      // Kept pixels are green; the rest of the 12x12 box, past the 8x6 image, is hidden too.
      const e = t.px(16, 16);
      for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (kept(x, y)) e.fill([...GREEN, 255], 2 + x, 2 + y, 1, 1);
      await t.shot('clipimage-only', { x: 0, y: 0, w: 16, h: 16 }, e);
    },
  },
  {
    id: 'subview-clippingimage-colour-through-mask',
    title: 'SUBVIEW: backgroundColor + clippingColor + clippingImage shows the colour only through the mask (the corpus helpmask overlays)',
    async run(t) {
      const clip = t.bmp(MW, MH, (x, y) => (kept(x, y) ? BLUE : CLIPRED));
      const wms = view(
        16,
        16,
        '<SUBVIEW id="sv" left="2" top="2" width="12" height="12" backgroundColor="#1EC81E" clippingImage="clip.bmp" clippingColor="#FF0000"/>',
      );
      await t.mount({ wms, files: { 'clip.bmp': clip } });
      const e = t.px(16, 16);
      for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (kept(x, y)) e.fill([...GREEN, 255], 2 + x, 2 + y, 1, 1);
      await t.shot('clipimage-colour', { x: 0, y: 0, w: 16, h: 16 }, e);
    },
  },
  {
    id: 'subview-clippingimage-only-mask-zoom2',
    title: 'SUBVIEW: at zoom 2 a clippingImage-only mask scales without smoothing, like the canvases under it',
    async run(t) {
      const clip = t.bmp(MW, MH, (x, y) => (kept(x, y) ? BLUE : CLIPRED));
      const green = t.bmp(12, 12, () => GREEN);
      const wms = view(
        16,
        16,
        `<SUBVIEW id="sv" left="2" top="2" width="12" height="12" clippingImage="clip.bmp">
           <BUTTON id="b" left="0" top="0" image="green.bmp"/>
         </SUBVIEW>`,
      );
      await t.mount({ wms, files: { 'clip.bmp': clip, 'green.bmp': green }, zoom: 2 });
      // Each kept skin pixel is a whole 2x2 block of opaque green; every other screen pixel is empty.
      const e = t.px(32, 32);
      for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (kept(x, y)) e.fill([...GREEN, 255], (2 + x) * 2, (2 + y) * 2, 2, 2);
      await t.shot('clipimage-only-zoom2', { x: 0, y: 0, w: 32, h: 32 }, e);
      t.eq(t.computed(t.node('sv')).imageRendering, 'pixelated', 'the masked subview samples its mask pixelated');
    },
  },
];
