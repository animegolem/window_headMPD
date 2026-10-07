// The VIEW as the skin's frame (WAVES 5F.5, from the W5.4 corpus triage of docs/coverage/corpus-load.txt):
//   - `visible="false"` on a VIEW is ignored (gnome.wmz): the VIEW is the window and nothing shows it again;
//   - a VIEW with no size and no image is the bounding box of its visible children (iconic, Deadside);
//   - a `backgroundTiled` VIEW tiles its clip mask like its background (Gorillaz), and a VIEW whose
//     background keys every pixel as the clipping colour is not masked, the children outline the skin.
// Every picture is computed from the data the case writes; nothing here comes from skin art.

export const area = 'render';

const BLUE = [30, 30, 200];
const GREEN = [30, 200, 30];
const CLIPRED = [255, 0, 0];

/** A VIEW tag with the markup the case wants; `attrs` is the raw attribute text. */
const theme = (attrs, body) => `<THEME><VIEW id="v" ${attrs} backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

export const cases = [
  {
    id: 'view-visible-false-is-shown',
    title: 'VIEW: visible="false" on the VIEW itself does not hide the skin',
    async run(t) {
      const green = t.bmp(8, 6, () => GREEN);
      const wms = theme('width="8" height="6" visible="false"', '<BUTTON id="b" left="0" top="0" image="green.bmp"/>');
      await t.mount({ wms, files: { 'green.bmp': green } });
      t.eq(t.computed(t.node('v')).display, 'block', 'the VIEW node is displayed');
      t.assert(t.session.diagnostics.some((d) => d.code === 'view-visible-ignored'), 'the build says it ignored the attribute');
      await t.shot('shown', { x: 0, y: 0, w: 8, h: 6 }, t.px(8, 6).fill([...GREEN, 255]));
    },
  },
  {
    id: 'view-sizeless-box-of-children',
    title: 'VIEW: no width, no height, no image: the frame is the box of the visible children',
    async run(t) {
      const blue = t.bmp(6, 4, () => BLUE);
      const far = t.bmp(30, 30, () => GREEN);
      // `blue` ends at (8, 7). The hidden SUBVIEW lies far outside and must not stretch the frame.
      const wms = theme(
        '',
        `<SUBVIEW id="s" left="2" top="3" backgroundImage="blue.bmp"/>
         <SUBVIEW id="hidden" left="40" top="40" visible="false" backgroundImage="far.bmp"/>`,
      );
      await t.mount({ wms, files: { 'blue.bmp': blue, 'far.bmp': far } });
      t.eq(t.session.view.view.get('width'), 8, 'the VIEW width');
      t.eq(t.session.view.view.get('height'), 7, 'the VIEW height');
      const box = t.rect(t.node('v'));
      t.eq(`${box.w}x${box.h}`, '8x7', 'the VIEW node is the same size');
      t.assert(t.session.diagnostics.some((d) => d.code === 'view-size-from-children'), 'the build says where the size came from');
      await t.shot('frame', { x: 0, y: 0, w: 8, h: 7 }, t.px(8, 7).fill([...BLUE, 255], 2, 3, 6, 4));
    },
  },
  {
    id: 'view-tiled-clip-mask',
    title: 'VIEW: a tiled background tiles its clippingColor mask, so it clips every tile and not only the first',
    async run(t) {
      // A 4x4 tile whose right-hand column is the clipping colour; the VIEW is three tiles wide.
      const tile = t.bmp(4, 4, (x) => (x === 3 ? CLIPRED : BLUE));
      const green = t.bmp(12, 8, () => GREEN);
      const wms = theme(
        'width="12" height="8" backgroundImage="tile.bmp" backgroundTiled="true" clippingColor="#FF0000"',
        '<BUTTON id="b" left="0" top="0" image="green.bmp"/>',
      );
      await t.mount({ wms, files: { 'tile.bmp': tile, 'green.bmp': green } });
      // The green child covers the whole box: only the mask decides where it shows. Without the repeat the
      // mask would end at x = 4 and the two other tiles would be empty.
      const e = t.px(12, 8);
      for (let tileX = 0; tileX < 3; tileX++) e.fill([...GREEN, 255], tileX * 4, 0, 3, 8);
      await t.shot('tiled-mask', { x: 0, y: 0, w: 12, h: 8 }, e);
    },
  },
  {
    id: 'view-all-clip-tile-is-not-a-mask',
    title: 'VIEW: a background that is entirely the clippingColor does not hide the children (Gorillaz)',
    async run(t) {
      const tile = t.bmp(4, 4, () => CLIPRED);
      const green = t.bmp(8, 6, () => GREEN);
      const wms = theme(
        'width="8" height="6" backgroundImage="tile.bmp" backgroundTiled="true" clippingColor="#FF0000"',
        '<BUTTON id="b" left="0" top="0" image="green.bmp"/>',
      );
      await t.mount({ wms, files: { 'tile.bmp': tile, 'green.bmp': green } });
      await t.shot('children-show', { x: 0, y: 0, w: 8, h: 6 }, t.px(8, 6).fill([...GREEN, 255]));
    },
  },
];
