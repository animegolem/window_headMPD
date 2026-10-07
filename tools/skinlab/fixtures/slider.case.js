// SLIDER rendering (E D2 drawables table; spec 6.7; parity F, D28 to D34). The geometry and the
// foreground rules below are written out again from the contract, not read from the engine:
//   'oracle'  thumb left = round(f * (L - t)); the foreground reveals to round(f * (L - t) + t / 2)
//   'docs'    the thumb centre runs over [b, L - b]
//   vertical  the maximum is at the top, the fill grows from the bottom
//   slide     false: the foreground stays and is revealed; true: its far edge follows the reveal edge

export const area = 'render';

const DARK = [40, 40, 40];
const WHITE = [250, 250, 250];
const GREEN = [30, 200, 30];
const BLUE = [30, 30, 200];
const GRAY = [128, 128, 128];

const view = (w, h, body) =>
  `<THEME><VIEW id="v" width="${w}" height="${h}" backgroundColor="none" titleBar="false">${body}</VIEW></THEME>`;

/** Nine distinct column colours: a cap pair, a five-column middle, a cap pair. */
const COLUMNS = [[250, 0, 0], [0, 250, 0], [0, 0, 250], [250, 250, 0], [0, 250, 250], [250, 0, 250], [120, 0, 0], [0, 120, 0], [0, 0, 120]];

export const cases = [
  {
    id: 'slider-tiled-caps',
    title: 'SLIDER: tiled track with borderSize caps, untiled, tiled without caps',
    async run(t) {
      const track = t.bmp(9, 5, (x) => COLUMNS[x]);
      const wms = view(40, 14, '<SLIDER id="s" left="4" top="4" width="30" height="5" backgroundImage="track.bmp" tiled="true" borderSize="2"/>');
      await t.mount({ wms, files: { 'track.bmp': track } });
      const rect = { x: 4, y: 4, w: 30, h: 5 };
      const picture = (colOf) => {
        const e = t.px(30, 5);
        for (let x = 0; x < 30; x++) {
          const c = colOf(x);
          if (c !== null) e.fill([...COLUMNS[c], 255], x, 0, 1, 5);
        }
        return e;
      };
      // caps 0,1 and 7,8; the middle (columns 2..6) repeats from the start edge and is cut at 28
      await t.shot('tiled-caps', rect, picture((x) => (x < 2 ? x : x >= 28 ? 7 + (x - 28) : 2 + ((x - 2) % 5))));
      await t.set('s', 'borderSize', 0);
      await t.shot('tiled-no-caps', rect, picture((x) => x % 9));
      await t.set('s', 'tiled', false);
      await t.shot('untiled', rect, picture((x) => (x < 9 ? x : null)));
    },
  },

  {
    id: 'slider-slide',
    title: 'SLIDER: slide true and false, foregroundProgress, x-foregroundMode, disabled',
    async run(t) {
      const bg = t.bmp(30, 6, () => DARK);
      const fg = t.bmp(30, 6, (x) => [x * 8, 100, 50]);
      const thumb = t.bmp(6, 6, () => WHITE);
      const wms = view(40, 12, '<SLIDER id="s" left="2" top="2" backgroundImage="bg.bmp" foregroundImage="fg.bmp" thumbImage="thumb.bmp" min="0" max="100" value="50" slide="false"/>');
      await t.mount({ wms, files: { 'bg.bmp': bg, 'fg.bmp': fg, 'thumb.bmp': thumb } });
      const rect = { x: 2, y: 2, w: 30, h: 6 };

      // L = 30, thumb 6, so travel 24. At 50%: thumb left 12, reveal edge round(12 + 3) = 15.
      const picture = ({ reveal, slide, thumbLeft, fgOn = true }) => {
        const e = t.px(30, 6).image(bg, 0, 0);
        if (fgOn) {
          if (slide) e.image(fg, reveal - 30, 0, { crop: { x: 0, y: 0, w: 30, h: 6 } }); // clipped below
          else e.image(fg, 0, 0, { crop: { x: 0, y: 0, w: Math.min(30, reveal), h: 6 } });
        }
        if (slide && fgOn) {
          // the image is drawn at x = reveal - 30 and only the part inside [0, reveal) shows
          const e2 = t.px(30, 6).image(bg, 0, 0);
          for (let x = 0; x < reveal; x++) for (let y = 0; y < 6; y++) e2.put(x, y, [...fg.rgba.subarray((y * 30 + (x - (reveal - 30))) * 4, (y * 30 + (x - (reveal - 30))) * 4 + 4)]);
          e2.image(thumb, thumbLeft, 0);
          return e2;
        }
        e.image(thumb, thumbLeft, 0);
        return e;
      };

      await t.shot('reveal-50', rect, picture({ reveal: 15, slide: false, thumbLeft: 12 }));
      await t.set('s', 'slide', true);
      await t.shot('slide-50', rect, picture({ reveal: 15, slide: true, thumbLeft: 12 }));
      await t.set('s', 'slide', false);
      await t.set('s', 'value', 0);
      await t.shot('reveal-0', rect, picture({ reveal: 3, slide: false, thumbLeft: 0 }));
      await t.set('s', 'value', 100);
      await t.shot('reveal-100', rect, picture({ reveal: 27, slide: false, thumbLeft: 24 }));

      // foregroundProgress: the reveal edge is the progress, not the playhead (parity D2) ...
      await t.set('s', 'value', 50);
      await t.set('s', 'useForegroundProgress', true);
      await t.set('s', 'foregroundProgress', 100);
      await t.shot('progress-100', rect, picture({ reveal: 30, slide: false, thumbLeft: 12 }));
      await t.set('s', 'foregroundProgress', 50);
      await t.shot('progress-50', rect, picture({ reveal: 15, slide: false, thumbLeft: 12 }));
      await t.set('s', 'foregroundProgress', 100);
      // ... unless the sidecar says playhead
      await t.set('s', 'x-foregroundMode', 'playhead', 'sidecar');
      await t.shot('playhead-mode', rect, picture({ reveal: 15, slide: false, thumbLeft: 12 }));
      // a skin cannot set the host-only attribute itself
      await t.set('s', 'x-foregroundMode', 'progress', 'script');
      await t.shot('playhead-mode-kept', rect, picture({ reveal: 15, slide: false, thumbLeft: 12 }));

      // disabled: no foreground image is visible (spec 6.7)
      await t.set('s', 'enabled', false);
      await t.shot('disabled', rect, picture({ reveal: 15, slide: false, thumbLeft: 12, fgOn: false }));
    },
  },

  {
    id: 'slider-vertical',
    title: 'SLIDER: a vertical slider puts the maximum at the top',
    async run(t) {
      const bg = t.bmp(6, 30, () => DARK);
      const fg = t.bmp(6, 30, () => GREEN);
      const thumb = t.bmp(6, 4, () => WHITE);
      const wms = view(14, 40, '<SLIDER id="s" left="2" top="2" direction="vertical" backgroundImage="bg.bmp" foregroundImage="fg.bmp" thumbImage="thumb.bmp" min="0" max="100" value="75" slide="false"/>');
      await t.mount({ wms, files: { 'bg.bmp': bg, 'fg.bmp': fg, 'thumb.bmp': thumb } });
      const rect = { x: 2, y: 2, w: 6, h: 30 };
      // L = 30, t = 4, travel 26. f = .75: thumb top round(.25 * 26) = 7 (6.5 rounds up);
      // the fill is the lower round(.75 * 26 + 2) = round(21.5) = 22 rows.
      const picture = (f) => {
        const travel = 26;
        const top = Math.round((1 - f) * travel);
        const fill = Math.round(f * travel + 2);
        const e = t.px(6, 30).image(bg, 0, 0);
        e.fill([...GREEN, 255], 0, 30 - fill, 6, fill);
        e.fill([...WHITE, 255], 0, top, 6, 4);
        return e;
      };
      await t.shot('value-75', rect, picture(0.75));
      await t.set('s', 'value', 0);
      await t.shot('value-0', rect, picture(0));
      await t.set('s', 'value', 100);
      await t.shot('value-100', rect, picture(1));
      await t.set('s', 'slide', true);
      // sliding vertical: the image's top edge follows the reveal edge; with a plain colour image the look is the same
      await t.shot('slide-100', rect, picture(1));
    },
  },

  ...['oracle', 'docs'].map((geometry) => ({
    id: `slider-geometry-${geometry}`,
    title: `SLIDER: thumb positions under the '${geometry}' geometry`,
    async run(t) {
      const bg = t.bmp(40, 6, () => DARK);
      const thumb = t.bmp(8, 6, () => WHITE);
      const wms = view(46, 10, '<SLIDER id="s" left="3" top="2" backgroundImage="bg.bmp" thumbImage="thumb.bmp" min="0" max="100" value="0" borderSize="6"/>');
      await t.mount({ wms, files: { 'bg.bmp': bg, 'thumb.bmp': thumb }, opts: { sliderGeometry: geometry } });
      // L = 40, thumb 8, borderSize 6.
      //   oracle: left = round(f * 32)         -> 0, 16, 32
      //   docs:   centre = 6 + f * 28, left = round(centre - 4) -> 2, 16, 30
      const left = (f) => (geometry === 'oracle' ? Math.round(f * 32) : Math.round(6 + f * 28 - 4));
      for (const [f, v] of [[0, 0], [0.5, 50], [1, 100]]) {
        await t.set('s', 'value', v);
        await t.shot(`value-${v}`, { x: 3, y: 2, w: 40, h: 6 }, t.px(40, 6).image(bg, 0, 0).image(thumb, left(f), 0));
      }
    },
  })),

  {
    id: 'slider-thumb-states',
    title: 'SLIDER: thumb up, hover over the whole box (parity D28), down while dragging, disabled',
    async run(t) {
      const bg = t.bmp(30, 8, () => DARK);
      const up = t.bmp(6, 8, () => WHITE);
      const hover = t.bmp(6, 8, () => GREEN);
      const down = t.bmp(6, 8, () => BLUE);
      const off = t.bmp(6, 8, () => GRAY);
      const wms = view(36, 12, '<SLIDER id="s" left="2" top="2" backgroundImage="bg.bmp" thumbImage="up.bmp" thumbHoverImage="hover.bmp" thumbDownImage="down.bmp" thumbDisabledImage="off.bmp" min="0" max="100" value="100"/>');
      await t.mount({ wms, files: { 'bg.bmp': bg, 'up.bmp': up, 'hover.bmp': hover, 'down.bmp': down, 'off.bmp': off } });
      const rect = { x: 2, y: 2, w: 30, h: 8 };
      const picture = (img) => t.px(30, 8).image(bg, 0, 0).image(img, 24, 0);
      await t.shot('up', rect, picture(up));
      await t.pointer('s'); // anywhere over the box, not only over the thumb
      await t.shot('hover', rect, picture(hover));
      await t.pointer('s', 's');
      await t.shot('down', rect, picture(down));
      await t.pointer(null, 's'); // dragging out of the box keeps the down image
      await t.shot('down-outside', rect, picture(down));
      await t.pointer(null, null);
      await t.set('s', 'enabled', false);
      await t.shot('disabled', rect, picture(off));
    },
  },

  {
    id: 'slider-colour-mode',
    title: 'SLIDER: colours instead of images',
    async run(t) {
      const wms = view(36, 10, '<SLIDER id="s" left="2" top="2" width="30" height="6" backgroundColor="#204060" foregroundColor="#80C0FF" min="0" max="100" value="50" slide="false"/>');
      await t.mount({ wms });
      const e = t.px(30, 6).fill([0x20, 0x40, 0x60, 255]);
      e.fill([0x80, 0xc0, 0xff, 255], 0, 0, 15, 6); // no thumb: the reveal edge is round(.5 * 30)
      await t.shot('colour-50', { x: 2, y: 2, w: 30, h: 6 }, e);
      await t.set('s', 'enabled', false);
      await t.shot('colour-disabled', { x: 2, y: 2, w: 30, h: 6 }, t.px(30, 6).fill([0x20, 0x40, 0x60, 255]));
    },
  },
];
