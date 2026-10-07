// @vitest-environment happy-dom
// @ts-check
// WAVES 5F.10 (a): a container with a `clippingImage` and no `backgroundImage` is masked by that image
// alone (U-7; the corpus has `backgroundColor="pink" clippingImage="infomask.gif"` overlays and
// button-group masks), at the image's native size and never tiled, and the mask is the one
// `shape/scene.js` asks the image service for, so the window shape, the picker and the pixels agree.
// The pixels are checked in Chromium by `tools/skinlab/fixtures/clipimage-mask.case.js`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeImage } from '../../../src/engine/image/decode/index.js';
import { clipMaskUrl } from '../../../src/engine/render/dom/clipmask.js';
import { containerInfo, createScene } from '../../../src/engine/shape/scene.js';
import { BLUE, bmp, frame, mountSkin, pixelsOf, settle, stubCanvas, view } from './helpers.js';

/** @type {() => void} */
let restoreCanvas;
beforeEach(() => {
  restoreCanvas = stubCanvas();
  document.body.replaceChildren();
});
afterEach(() => restoreCanvas());

const CLIPRED = [255, 0, 0];
const MW = 8;
const MH = 6;

/** The kept pixels of the 8x6 clipping image: a frame of the clipping colour and a notch. */
const kept = (/** @type {number} */ x, /** @type {number} */ y) => x >= 1 && x < 7 && y >= 1 && y < 5 && !(x >= 4 && y < 2);
const clipArt = () => bmp(MW, MH, (x, y) => (kept(x, y) ? BLUE : CLIPRED));

const DATA_URL = /^url\("?(data:image\/png;base64,[A-Za-z0-9+/]+=*)"?\)$/;

/** @param {HTMLElement | null | undefined} node */
const maskOf = (node) => ({
  image: node?.style.getPropertyValue('mask-image') ?? '',
  size: node?.style.getPropertyValue('mask-size') ?? '',
  repeat: node?.style.getPropertyValue('mask-repeat') ?? '',
  position: node?.style.getPropertyValue('mask-position') ?? '',
  rendering: node?.style.getPropertyValue('image-rendering') ?? '',
});

/** The node that carries a container's mask: a SUBVIEW's own node, a VIEW's `div.layers`. @param {{ renderer: any, view: any }} s @param {string} id */
function carrier(s, id) {
  const el = s.view.byId(id);
  const node = s.renderer.nodeOf(el);
  return el.kind === 'view' ? node.querySelector('.layers') : node;
}

/** The alpha of every pixel of a mask data URL, row-major. @param {string} css */
function alphaOf(css) {
  const m = DATA_URL.exec(css);
  if (!m) throw new Error(`not a data URL mask: ${css.slice(0, 40)}`);
  const png = Uint8Array.from(atob(m[1].slice('data:image/png;base64,'.length)), (c) => c.charCodeAt(0));
  const img = decodeImage(png);
  if (!img) throw new Error('mask PNG does not decode');
  return { width: img.width, height: img.height, at: (/** @type {number} */ x, /** @type {number} */ y) => img.data[(y * img.width + x) * 4 + 3] };
}

/** @param {string} wms @param {Record<string, any>} files */
async function mounted(wms, files = { 'clip.bmp': clipArt() }) {
  const s = await mountSkin({ wms, files });
  await settle(s);
  frame(s);
  return s;
}

const SV = (/** @type {string} */ attrs) => view(40, 40, `<SUBVIEW id="sv" left="3" top="4" width="20" height="20" ${attrs}/>`);

describe('a clippingImage with no background is a mask of its own (5F.10)', () => {
  it('masks the subview with the clipping image at its native size, not stretched to the box and not tiled', async () => {
    const s = await mounted(SV('clippingImage="clip.bmp"'));
    const st = maskOf(carrier(s, 'sv'));
    expect(st.image).toMatch(DATA_URL);
    expect(st).toMatchObject({ size: `${MW}px ${MH}px`, repeat: 'no-repeat', position: '0 0', rendering: 'pixelated' });
    const a = alphaOf(st.image);
    expect([a.width, a.height]).toEqual([MW, MH]);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) expect(a.at(x, y), `(${x},${y})`).toBe(kept(x, y) ? 255 : 0);
  });

  it('paints nothing of its own: the clipping image is never drawn, only the subtree is clipped', async () => {
    const s = await mounted(SV('clippingImage="clip.bmp"'));
    const canvas = /** @type {HTMLCanvasElement} */ (carrier(s, 'sv').querySelector('canvas.bgimg'));
    expect(pixelsOf(canvas)).toBeUndefined();
  });

  it('is the mask of the (file, spec) pair the shape path asks for, with a default or an explicit clipping colour', async () => {
    for (const colour of ['', ' clippingColor="#FF0000"']) {
      document.body.replaceChildren();
      // eslint-disable-next-line no-await-in-loop
      const s = await mounted(SV(`clippingImage="clip.bmp"${colour}`));
      const planes = s.images.get('clip.bmp', { clipping: colour ? 0xff0000 : 'auto', hitKeyed: false });
      expect(planes?.clip, colour || 'auto').not.toBeNull();
      expect(maskOf(carrier(s, 'sv')).image, colour || 'auto').toBe(`url("${clipMaskUrl(/** @type {any} */ (planes))}")`);
    }
  });

  it('agrees with shape/scene.js pixel for pixel, inside and outside the image', async () => {
    const s = await mounted(SV('clippingImage="clip.bmp"'));
    const a = alphaOf(maskOf(carrier(s, 'sv')).image);
    const scene = createScene(s.view, s.images, () => [], s.opts);
    const info = containerInfo(scene, /** @type {any} */ (s.view.byId('sv')), 3, 4);
    expect(info.clipAt).not.toBeNull();
    for (let y = -1; y < 12; y++) {
      for (let x = -1; x < 12; x++) {
        const hidden = /** @type {(x: number, y: number) => boolean} */ (info.clipAt)(3 + x, 4 + y);
        const shown = x >= 0 && y >= 0 && x < MW && y < MH && a.at(x, y) === 255;
        expect(hidden, `(${x},${y})`).toBe(!shown);
      }
    }
  });

  it('does not tile, whatever backgroundTiled says (there is no background to repeat)', async () => {
    const s = await mounted(SV('clippingImage="clip.bmp" backgroundTiled="true"'));
    expect(maskOf(carrier(s, 'sv'))).toMatchObject({ size: `${MW}px ${MH}px`, repeat: 'no-repeat' });
  });

  it('masks the children and the background colour: a backgroundColor stays on the node under the mask', async () => {
    const s = await mounted(SV('clippingImage="clip.bmp" clippingColor="#FF0000" backgroundColor="#FF8080"'));
    const node = carrier(s, 'sv');
    expect(maskOf(node).image).toMatch(DATA_URL);
    expect(node.querySelector('.bg')?.style.getPropertyValue('background-color')).not.toBe('');
  });

  it('is also the mask of a VIEW that has no background image, like the shape path', async () => {
    const s = await mounted(view(MW, MH, '', ' clippingImage="clip.bmp"'));
    expect(maskOf(carrier(s, 'v'))).toMatchObject({ size: `${MW}px ${MH}px`, repeat: 'no-repeat' });
    expect(maskOf(carrier(s, 'v')).image).toMatch(DATA_URL);
  });

  it('leaves a VIEW unmasked when its clipping image keeps nothing, as for a background (5F.5)', async () => {
    const s = await mounted(view(MW, MH, '', ' clippingImage="clip.bmp"'), { 'clip.bmp': bmp(MW, MH, () => CLIPRED) });
    expect(maskOf(carrier(s, 'v')).image).toBe('');
    // ... while a SUBVIEW with the same image stays masked (parity D26)
    document.body.replaceChildren();
    const sub = await mounted(SV('clippingImage="clip.bmp"'), { 'clip.bmp': bmp(MW, MH, () => CLIPRED) });
    expect(maskOf(carrier(sub, 'sv')).image).toMatch(DATA_URL);
  });

  it('shows no mask before the image has decoded and the mask once it lands, without another write', async () => {
    const s = await mountSkin({ wms: SV('clippingImage="clip.bmp"'), files: { 'clip.bmp': clipArt() } });
    frame(s);
    expect(maskOf(carrier(s, 'sv')).image).toBe('');
    await settle(s);
    expect(maskOf(carrier(s, 'sv')).image).toMatch(DATA_URL);
  });

  it('has no mask when the clipping image is missing, and does not throw', async () => {
    const s = await mounted(SV('clippingImage="gone.bmp"'), {});
    expect(maskOf(carrier(s, 'sv'))).toEqual({ image: '', size: '', repeat: '', position: '', rendering: '' });
  });

  it('has no mask without a clipping image, and `clippingColor` alone does not mask a container with no background', async () => {
    const s = await mounted(SV('clippingColor="#FF0000"'));
    expect(maskOf(carrier(s, 'sv')).image).toBe('');
  });
});

describe('a script that changes the clipping image (5F.10)', () => {
  it('adds, swaps and removes the mask', async () => {
    const other = bmp(4, 4, (x) => (x < 2 ? BLUE : CLIPRED));
    const s = await mounted(SV(''), { 'clip.bmp': clipArt(), 'other.bmp': other });
    const el = /** @type {any} */ (s.view.byId('sv'));
    const node = () => carrier(s, 'sv');
    expect(maskOf(node()).image).toBe('');

    el.set('clippingimage', 'clip.bmp', 'script');
    frame(s);
    await settle(s);
    frame(s);
    expect(maskOf(node())).toMatchObject({ size: `${MW}px ${MH}px`, rendering: 'pixelated' });
    const first = maskOf(node()).image;
    expect(first).toMatch(DATA_URL);

    el.set('clippingimage', 'other.bmp', 'script');
    frame(s);
    await settle(s);
    frame(s);
    expect(maskOf(node()).size).toBe('4px 4px');
    expect(maskOf(node()).image).not.toBe(first);

    el.set('clippingimage', '', 'script');
    frame(s);
    expect(maskOf(node())).toEqual({ image: '', size: '', repeat: '', position: '', rendering: '' });
  });

  it('follows the clipping colour: another colour keys other pixels of the same file', async () => {
    const two = bmp(4, 2, (x) => (x < 2 ? [0, 255, 0] : CLIPRED));
    const s = await mounted(SV('clippingImage="two.bmp" clippingColor="#FF0000"'), { 'two.bmp': two });
    const el = /** @type {any} */ (s.view.byId('sv'));
    const before = alphaOf(maskOf(carrier(s, 'sv')).image);
    expect([before.at(0, 0), before.at(3, 0)]).toEqual([255, 0]);
    el.set('clippingcolor', 0x00ff00, 'script');
    frame(s);
    await settle(s);
    frame(s);
    const after = alphaOf(maskOf(carrier(s, 'sv')).image);
    expect([after.at(0, 0), after.at(3, 0)]).toEqual([0, 255]);
  });

  it('gives way to a background image when one is set, and back again when it is cleared', async () => {
    const bg = bmp(10, 10, (x) => (x < 5 ? BLUE : CLIPRED));
    const s = await mounted(SV('clippingImage="clip.bmp" clippingColor="#FF0000"'), { 'clip.bmp': clipArt(), 'bg.bmp': bg });
    const el = /** @type {any} */ (s.view.byId('sv'));
    expect(maskOf(carrier(s, 'sv')).size).toBe(`${MW}px ${MH}px`);
    el.set('backgroundimage', 'bg.bmp', 'script');
    frame(s);
    await settle(s);
    frame(s);
    // with a background, the mask is that of the background's planes (clip region read through the clipping image)
    expect(maskOf(carrier(s, 'sv')).image).toMatch(DATA_URL);
    el.set('backgroundimage', '', 'script');
    frame(s);
    expect(maskOf(carrier(s, 'sv')).size).toBe(`${MW}px ${MH}px`);
  });
});

describe('skin strings are never keys of a plain object (E §1 rule 6)', () => {
  it('a clipping image named __proto__ or constructor is an ordinary file, and a missing toString is just missing', async () => {
    const art = clipArt();
    const files = Object.fromEntries([['__proto__', art], ['constructor', art]]);
    const s = await mounted(
      view(60, 40,
        '<SUBVIEW id="a" width="20" height="20" clippingImage="__proto__"/>'
        + '<SUBVIEW id="b" left="20" width="20" height="20" clippingImage="constructor"/>'
        + '<SUBVIEW id="c" left="40" width="20" height="20" clippingImage="toString"/>'),
      files,
    );
    expect(maskOf(carrier(s, 'a')).image).toMatch(DATA_URL);
    expect(maskOf(carrier(s, 'b')).image).toMatch(DATA_URL);
    expect(maskOf(carrier(s, 'c')).image).toBe('');
  });
});
