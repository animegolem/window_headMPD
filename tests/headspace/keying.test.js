// @ts-check
// Headspace keying (WAVES W1.3 acceptance 3; ENGINE D3). Needs the owner's `Headspace.wmz` and the
// locally generated, untracked `public/skin/`; skips with the reason in its title without either.
//
// Two claims from `parity 0.2`, both measured on the art:
//   1. the key-colour census (head.bmp magenta 31,487 and red 17,909, vid_bkgd white 106, ...);
//   2. for every BMP, keying it under the KeySpec its own .wms declaration implies gives exactly the
//      pixels of the hand port's offline-keyed `public/skin/<name>.png`: alpha exact, RGB exact where
//      alpha > 0. The hand port keys magenta on everything; the engine keys per declaration; for this
//      skin the two agree because every image that contains magenta has a matching declaration.
// Nothing derived from the art is written anywhere: the test reads, compares and discards.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeImage } from '../../src/engine/image/decode/index.js';
import { keyImage } from '../../src/engine/image/keying.js';
import { REPO_ROOT, describeHeadspace } from '../support/fixtures.js';
import { diffRgba, popcount } from '../engine/image/helpers.js';

/** @typedef {import('../../src/engine/contracts').KeySpec} KeySpec */

const MAGENTA = 0xff00ff;
const RED = 0xff0000;
const WHITE = 0xffffff;
const PUBLIC_SKIN = join(REPO_ROOT, 'public', 'skin');
const HAVE_PUBLIC = existsSync(PUBLIC_SKIN);

// Each image's KeySpec, from `headspace.wms` (line numbers in parentheses). `hitKeyed` is the
// faithful per-element-kind choice of the D2 table: a VIEW/SUBVIEW background passes clicks on its
// keyed pixels through, a BUTTON or SLIDER takes them. Names are the archive's, case-folded.
/** @type {Map<string, KeySpec>} */
const SPECS = new Map();
/** @param {string[]} names @param {KeySpec} spec */
const declare = (names, spec) => names.forEach((n) => SPECS.set(n.toLowerCase(), spec));
const STATES = ['01_default', '02_rollover', '03_down'];
const DRAWER_ART = ['L', 'R'].flatMap((side) => ['open', 'close'].flatMap((dir) => STATES.map((st) => `${side}_drwr_${dir}_${st}.bmp`)));

declare(['head.bmp'], { transparency: MAGENTA, clipping: RED, hitKeyed: false }); // head subview (19-20)
declare(['vid_bkgd.bmp'], { clipping: WHITE, hitKeyed: false }); // screen subview (119)
declare(['viz_drop.bmp'], { clipping: MAGENTA, hitKeyed: false }); // visDrop subview: clipping, not transparency (138)
declare(['left_ear.bmp', 'right_ear.bmp', 'left_drawer_right.bmp', 'right_drawer_left.bmp'], { transparency: MAGENTA, hitKeyed: false }); // subview backgrounds (188, 223, 437, 451)
declare(
  [
    ...DRAWER_ART, 'L_drwr_04_disabled.bmp', 'R_drwr_04_disabled.bmp', // the ear handle buttons (196, 459)
    ...STATES.map((st) => `pause_${st}.bmp`), // (68)
    ...[...STATES, '04_disabled'].map((st) => `viz_drop_L_${st}.bmp`), // (148)
  ],
  { transparency: MAGENTA, hitKeyed: true },
);
declare(
  ['progressbar.bmp', 'progressbar_foreground.bmp', ...STATES.map((st) => `thumb_${st}.bmp`)],
  { transparency: MAGENTA, hitKeyed: true }, // the seek slider's transparencyColor (98)
);
// Everything else has no declaration: no key, and the map images are never keyed (`parity 0.1` rule 5).
/** @param {string} name @returns {KeySpec} */
const specFor = (name) => SPECS.get(name.toLowerCase()) ?? { hitKeyed: false };

/** Pixels of exactly this colour (any alpha). @param {Uint8ClampedArray} data @param {number} rgb */
function countColor(data, rgb) {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) === rgb) n++;
  return n;
}

describeHeadspace('Headspace keying', (headspace) => {
  /** @type {Map<string, Uint8Array> | null} */
  let bmps = null;
  const archive = () => {
    if (!bmps) {
      bmps = new Map();
      const files = unzipSync(headspace.bytes(), { filter: (f) => /\.bmp$/i.test(f.name) });
      for (const [name, data] of Object.entries(files)) bmps.set(name, data);
    }
    return bmps;
  };
  /** @param {string} name */
  const raw = (name) => {
    const bytes = archive().get(name);
    if (!bytes) throw new Error(`Headspace.wmz has no ${name}`);
    const img = decodeImage(bytes);
    if (!img) throw new Error(`${name} did not decode`);
    return img;
  };

  it('the archive holds the BMPs the tables below cover, and every declared name exists', () => {
    const names = new Set([...archive().keys()].map((n) => n.toLowerCase()));
    expect(names.size).toBeGreaterThan(70);
    for (const declared of SPECS.keys()) expect(names.has(declared), declared).toBe(true);
  });

  it('every BMP decodes, opaque, with no diagnostics worth raising', () => {
    for (const [name, bytes] of archive()) {
      const img = decodeImage(bytes);
      expect(img, name).not.toBeNull();
      for (let i = 3; i < /** @type {any} */ (img).data.length; i += 4) {
        if (/** @type {any} */ (img).data[i] !== 255) throw new Error(`${name}: alpha ${/** @type {any} */ (img).data[i]} at ${i >> 2}`);
      }
    }
  });

  describe('key census (parity 0.2)', () => {
    it('head.bmp: 234 x 394, magenta 31,487, red 17,909', () => {
      const img = raw('head.bmp');
      expect([img.width, img.height]).toEqual([234, 394]);
      expect(countColor(img.data, MAGENTA)).toBe(31487);
      expect(countColor(img.data, RED)).toBe(17909);
    });

    it('vid_bkgd.bmp: white 106; viz_drop.bmp: magenta 352', () => {
      expect(countColor(raw('vid_bkgd.bmp').data, WHITE)).toBe(106);
      expect(countColor(raw('viz_drop.bmp').data, MAGENTA)).toBe(352);
    });

    it('L_drwr_* 328 and R_drwr_* 340 magenta pixels each, seven files apiece', () => {
      const names = [...archive().keys()];
      const left = names.filter((n) => /^L_drwr_/i.test(n));
      const right = names.filter((n) => /^R_drwr_/i.test(n));
      expect([left.length, right.length]).toEqual([7, 7]);
      for (const n of left) expect(countColor(raw(n).data, MAGENTA), n).toBe(328);
      for (const n of right) expect(countColor(raw(n).data, MAGENTA), n).toBe(340);
    });

    it('the other keyed art matches the rest of the census table', () => {
      expect(countColor(raw('left_ear.bmp').data, MAGENTA)).toBe(2265);
      expect(countColor(raw('right_ear.bmp').data, MAGENTA)).toBe(2291);
      expect(countColor(raw('left_drawer_right.bmp').data, MAGENTA)).toBe(541);
      expect(countColor(raw('right_drawer_left.bmp').data, MAGENTA)).toBe(680);
      for (const n of ['pause_01_default.bmp', 'pause_02_rollover.bmp', 'pause_03_down.bmp']) expect(countColor(raw(n).data, MAGENTA), n).toBe(68);
      for (const n of ['thumb_01_default.bmp', 'thumb_02_rollover.bmp', 'thumb_03_down.bmp']) expect(countColor(raw(n).data, MAGENTA), n).toBe(8);
      for (const n of ['viz_drop_L_01_default.bmp', 'viz_drop_L_02_rollover.bmp', 'viz_drop_L_03_down.bmp', 'viz_drop_L_04_disabled.bmp']) expect(countColor(raw(n).data, MAGENTA), n).toBe(7);
    });
  });

  describe('head.bmp planes (parity 0.3, ENGINE D2)', () => {
    it('keyed under the head subview declaration: 42,800 visible pixels, 74,287 inside the clip region', () => {
      const img = raw('head.bmp');
      const n = img.width * img.height;
      const out = keyImage(img, specFor('head.bmp'));
      expect(popcount(out.paint, n)).toBe(42800);
      expect(popcount(out.hit, n)).toBe(42800); // the face window passes clicks through
      expect(popcount(/** @type {Uint8Array} */ (out.clip), n)).toBe(n - 17909);
    });

    it('with hitKeyed the 31,487 magenta pixels take hits too, and red never does', () => {
      const img = raw('head.bmp');
      const n = img.width * img.height;
      const out = keyImage(img, { ...specFor('head.bmp'), hitKeyed: true });
      expect(popcount(out.paint, n)).toBe(42800);
      expect(popcount(out.hit, n)).toBe(42800 + 31487);
    });

    it('vid_bkgd.bmp clips its 106 white corners; viz_drop.bmp its 352 magenta pixels', () => {
      const vid = raw('vid_bkgd.bmp');
      const vidOut = keyImage(vid, specFor('vid_bkgd.bmp'));
      expect(popcount(vidOut.paint, vid.width * vid.height)).toBe(vid.width * vid.height - 106);
      const drop = raw('viz_drop.bmp');
      const dropOut = keyImage(drop, specFor('viz_drop.bmp'));
      expect(popcount(dropOut.hit, drop.width * drop.height)).toBe(drop.width * drop.height - 352);
    });
  });

  describe.skipIf(!HAVE_PUBLIC)('per-declaration keying equals public/skin/*.png (parity 0.2)', () => {
    const names = () => [...archive().keys()].sort();
    it('covers every BMP in the archive, maps included', () => {
      expect(names().length).toBeGreaterThan(70);
    });

    it('alpha exact, RGB exact where alpha > 0, for every BMP', () => {
      const failures = /** @type {string[]} */ ([]);
      for (const name of names()) {
        const png = join(PUBLIC_SKIN, name.toLowerCase().replace(/\.bmp$/, '.png'));
        if (!existsSync(png)) {
          failures.push(`${name}: no ${png}`);
          continue;
        }
        const ref = PNG.sync.read(readFileSync(png));
        const img = raw(name);
        const out = keyImage(img, specFor(name));
        if (ref.width !== img.width || ref.height !== img.height) {
          failures.push(`${name}: size ${img.width}x${img.height}, png ${ref.width}x${ref.height}`);
          continue;
        }
        const d = diffRgba(out.rgba, ref.data, img.width, { ignoreRgbWhereAlpha0: true });
        if (d) failures.push(`${name}: ${d}`);
      }
      expect(failures).toEqual([]);
    });

    it('the planes of every keyed BMP agree with its keyed alpha: paint is alpha > 0, hit is a superset', () => {
      for (const name of names()) {
        const img = raw(name);
        const out = keyImage(img, specFor(name));
        const n = img.width * img.height;
        for (let i = 0; i < n; i++) {
          const painted = out.rgba[i * 4 + 3] > 0;
          const p = (out.paint[i >> 3] >> (i & 7)) & 1;
          const h = (out.hit[i >> 3] >> (i & 7)) & 1;
          if (p !== (painted ? 1 : 0) || (p && !h)) throw new Error(`${name}: pixel ${i} paint ${p} hit ${h} alpha ${out.rgba[i * 4 + 3]}`);
        }
      }
    });
  });

  it('a SLIDER with no declared key is not keyed: horizontal_slider, horizontal_thumb and the vertical pair', () => {
    for (const name of ['horizontal_slider.bmp', 'horizontal_thumb.bmp', 'vertical_slider.bmp', 'vertical_thumb.bmp']) {
      const img = raw(name);
      const out = keyImage(img, specFor(name));
      expect(diffRgba(out.rgba, img.data, img.width), name).toBeNull();
    }
  });
});
