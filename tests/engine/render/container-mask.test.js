// @vitest-environment happy-dom
// @ts-check
// WAVES 5F.2: a SUBVIEW's clip mask is sampled pixelated. Chromium scales a CSS mask image with the
// masked box's own `image-rendering`, so the subview that carries the mask also carries `pixelated`,
// and drops it with the mask. The pixels themselves are checked in Chromium by the skinlab fixture
// `subview-clippingcolor-mask-zoom2`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLUE, bmp, frame, mountSkin, settle, stubCanvas, view } from './helpers.js';

/** @type {() => void} */
let restoreCanvas;
beforeEach(() => {
  restoreCanvas = stubCanvas();
  document.body.replaceChildren();
});
afterEach(() => restoreCanvas());

const CLIPRED = [255, 0, 0];

/** A 6x6 background with a 1 px frame of the clipping colour. */
const framed = () => bmp(6, 6, (x, y) => (x < 1 || x >= 5 || y < 1 || y >= 5 ? CLIPRED : BLUE));

/** @param {HTMLElement | null | undefined} node */
const styleOf = (node) => ({
  mask: node?.style.getPropertyValue('mask-image') ?? '',
  rendering: node?.style.getPropertyValue('image-rendering') ?? '',
});

describe('SUBVIEW clip mask sampling (5F.2)', () => {
  it('a subview with a clippingColor mask is pixelated, so the mask scales like its canvases', async () => {
    const wms = view(20, 20, '<SUBVIEW id="sv" left="2" top="2" backgroundImage="bg.bmp" clippingColor="#FF0000"/>');
    const s = await mountSkin({ wms, files: { 'bg.bmp': framed() } });
    await settle(s);
    frame(s);
    const node = s.renderer.nodeOf(/** @type {any} */ (s.view.byId('sv')));
    const st = styleOf(node);
    expect(st.mask).toMatch(/^url\("?data:image\/png;base64,/);
    expect(st.rendering).toBe('pixelated');
  });

  it('a subview without a clip mask leaves image-rendering alone', async () => {
    const wms = view(20, 20, '<SUBVIEW id="plain" left="2" top="2" backgroundImage="bg.bmp"/><SUBVIEW id="sized" left="10" top="10" width="4" height="4"/>');
    const s = await mountSkin({ wms, files: { 'bg.bmp': framed() } });
    await settle(s);
    frame(s);
    for (const id of ['plain', 'sized']) {
      const st = styleOf(s.renderer.nodeOf(/** @type {any} */ (s.view.byId(id))));
      expect(st.mask).toBe('');
      expect(st.rendering).toBe('');
    }
  });

  it('dropping the background image drops the mask and the pixelated sampling with it', async () => {
    const wms = view(20, 20, '<SUBVIEW id="sv" left="2" top="2" width="6" height="6" backgroundImage="bg.bmp" clippingColor="#FF0000"/>');
    const s = await mountSkin({ wms, files: { 'bg.bmp': framed() } });
    await settle(s);
    frame(s);
    const el = /** @type {any} */ (s.view.byId('sv'));
    expect(styleOf(s.renderer.nodeOf(el)).rendering).toBe('pixelated');
    el.set('backgroundimage', '', 'script');
    frame(s);
    await settle(s);
    frame(s);
    expect(styleOf(s.renderer.nodeOf(el))).toEqual({ mask: '', rendering: '' });
  });
});
