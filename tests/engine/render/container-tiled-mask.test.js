// @vitest-environment happy-dom
// @ts-check
// WAVES 5F.5 (b): a `backgroundTiled` container's clip mask repeats like its background, and a VIEW
// whose background keys every pixel as the clipping colour (Gorillaz: a 50x28 tile of #33CC66 under a
// head drawn by its children) is not masked at all. The pixels are checked in Chromium by the skinlab
// fixtures of `tools/skinlab/fixtures/view-frame.case.js`.
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

/** A 4x4 tile with a column of the clipping colour. */
const striped = () => bmp(4, 4, (x) => (x === 3 ? CLIPRED : BLUE));
/** A tile that is entirely the clipping colour. */
const allClip = () => bmp(4, 4, () => CLIPRED);

/** @param {HTMLElement | null | undefined} node */
const maskOf = (node) => ({
  image: node?.style.getPropertyValue('mask-image') ?? '',
  repeat: node?.style.getPropertyValue('mask-repeat') ?? '',
  size: node?.style.getPropertyValue('mask-size') ?? '',
  position: node?.style.getPropertyValue('mask-position') ?? '',
});

/** The node that carries a container's mask: a SUBVIEW's own node, a VIEW's `div.layers`. @param {{ root: HTMLElement, renderer: any, view: any }} s @param {string} id */
function carrier(s, id) {
  const el = s.view.byId(id);
  const node = s.renderer.nodeOf(el);
  return el.kind === 'view' ? node.querySelector('.layers') : node;
}

/** @param {string} wms @param {Record<string, any>} files */
async function mounted(wms, files) {
  const s = await mountSkin({ wms, files });
  await settle(s);
  frame(s);
  return s;
}

describe('a tiled container tiles its clip mask (5F.5)', () => {
  it('a tiled SUBVIEW repeats the tile-sized mask from the origin; an untiled one does not', async () => {
    const s = await mounted(
      view(40, 40, '<SUBVIEW id="t" width="10" height="10" backgroundImage="tile.bmp" backgroundTiled="true" clippingColor="#FF0000"/>'
        + '<SUBVIEW id="n" left="20" width="10" height="10" backgroundImage="tile.bmp" clippingColor="#FF0000"/>'),
      { 'tile.bmp': striped() },
    );
    expect(maskOf(carrier(s, 't'))).toEqual({ image: expect.stringMatching(/^url\("?data:image\/png/), repeat: 'repeat', size: '4px 4px', position: '0 0' });
    expect(maskOf(carrier(s, 'n')).repeat).toBe('no-repeat');
  });

  it('a tiled VIEW does the same on its layers, and a script switching tiling off or on follows', async () => {
    const s = await mounted(view(40, 40, '', ' backgroundImage="tile.bmp" backgroundTiled="true" clippingColor="#FF0000"'), { 'tile.bmp': striped() });
    const layers = carrier(s, 'v');
    expect(maskOf(layers)).toMatchObject({ repeat: 'repeat', size: '4px 4px' });
    const v = s.view.view;
    v.set('backgroundtiled', false, 'script');
    frame(s);
    expect(maskOf(layers).repeat).toBe('no-repeat');
    v.set('backgroundtiled', true, 'script');
    frame(s);
    expect(maskOf(layers).repeat).toBe('repeat');
  });

  it('a tiled container with no area cannot tile, so it keeps the one-tile mask', async () => {
    const s = await mounted(
      view(40, 40, '<SUBVIEW id="flat" backgroundImage="tile.bmp" backgroundTiled="true" width="0" height="0" clippingColor="#FF0000"/>'),
      { 'tile.bmp': striped() },
    );
    expect(maskOf(carrier(s, 'flat')).repeat).toBe('no-repeat');
  });
});

describe('a VIEW whose whole background is the clipping colour is not masked (5F.5)', () => {
  it('leaves no mask on a VIEW over a tile that keeps nothing, tiled or not', async () => {
    for (const tiled of ['true', 'false']) {
      document.body.replaceChildren();
      // eslint-disable-next-line no-await-in-loop
      const s = await mounted(view(40, 40, '', ` backgroundImage="tile.bmp" backgroundTiled="${tiled}" clippingColor="#FF0000"`), { 'tile.bmp': allClip() });
      expect(maskOf(carrier(s, 'v')), `tiled=${tiled}`).toEqual({ image: '', repeat: '', size: '', position: '' });
    }
  });

  it('still masks a VIEW with a single kept pixel, and a SUBVIEW over a tile that keeps nothing (parity D26)', async () => {
    const one = bmp(4, 4, (x, y) => (x === 1 && y === 1 ? BLUE : CLIPRED));
    const s = await mounted(
      view(40, 40, '<SUBVIEW id="sv" width="4" height="4" backgroundImage="none.bmp" clippingColor="#FF0000"/>', ' backgroundImage="one.bmp" clippingColor="#FF0000"'),
      { 'one.bmp': one, 'none.bmp': allClip() },
    );
    expect(maskOf(carrier(s, 'v')).image).toMatch(/^url\("?data:image\/png/);
    expect(maskOf(carrier(s, 'sv')).image).toMatch(/^url\("?data:image\/png/);
  });

  it('reads an image whose pixel count is not a multiple of 8, the last byte partly padding', async () => {
    // 3x3 = 9 bits: the second byte holds one pixel and seven padding bits
    const s = await mounted(view(40, 40, '', ' backgroundImage="three.bmp" clippingColor="#FF0000"'), { 'three.bmp': bmp(3, 3, () => CLIPRED) });
    expect(maskOf(carrier(s, 'v')).image).toBe('');
  });
});
