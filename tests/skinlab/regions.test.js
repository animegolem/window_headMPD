import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBit, popcount } from '../../tools/skinlab/diff.mjs';
import { computeRegions, describeRegions, regionMask } from '../../tools/skinlab/regions.mjs';
import { buildBmp } from '../support/bmp-writer.js';
import { describeHeadspace } from '../support/fixtures.js';
import { buildWms } from '../support/wms-builder.js';
import { buildZip } from '../support/zip-writer.js';

const REGIONS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'tools', 'skinlab', 'regions.mjs');

const MAGENTA = [255, 0, 255];
const WHITE = [255, 255, 255];
const GREY = [90, 90, 90];

/** A 24-bit BMP whose pixel (x, y) is fn(x, y) = [r, g, b]. */
function bmp(w, h, fn) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set([...fn(x, y), 255], (y * w + x) * 4);
  }
  return buildBmp({ width: w, height: h, bpp: 24, rgba }).bytes;
}

const node = (tag, attrs = {}, children = []) => ({ tag, attrs: Object.entries(attrs), children });

/**
 * A synthetic skin shaped like Headspace's face, in miniature (nothing here is skin art):
 *   view 120x80
 *   head subview (10,5), head.bmp 40x30 with a 6x5 magenta block at (4,6), transparencyColor magenta
 *     screen subview (4,6) 16x12, vid.bmp 16x13 with white at (0,0) (1,0) (0,1) and one white pixel in
 *       row 12, below the box; clippingColor white; holds the EFFECTS element
 *     buttongroup (2,3): map 10x6, A = 4x2 block at (0,0), B = a 5x5 ring at (5,0), the rest unowned
 *     a slider with literal position, one under an animated subview, one with a jscript position
 */
function skinBytes(over = {}) {
  const headAt = over.headAt ?? { left: '10', top: '5' };
  const groupAttrs = over.groupAttrs ?? { left: '2', top: '3' };
  const head = bmp(40, 30, (x, y) => (x >= 4 && x < 10 && y >= 6 && y < 11 ? MAGENTA : GREY));
  const vid = bmp(16, 13, (x, y) => ([[0, 0], [1, 0], [0, 1], [3, 12]].some(([a, b]) => a === x && b === y) ? WHITE : GREY));
  const A = [255, 0, 51];
  const B = [0, 255, 0];
  const ring = (x, y) => x >= 5 && x <= 9 && y >= 0 && y <= 4 && (x === 5 || x === 9 || y === 0 || y === 4);
  const map = bmp(10, 6, (x, y) => (x <= 3 && y <= 1 ? A : ring(x, y) ? B : [18, 52, 86]));
  const grp = bmp(10, 6, () => GREY);
  const slider = bmp(8, 4, () => GREY);
  const elements = [
    node('buttonelement', { id: '__proto__', mappingColor: '#FF0033' }),
    node('buttonelement', { id: 'constructor', mappingColor: '#00FF00' }),
    node('buttonelement', { id: 'bad', mappingColor: 'constructor' }),
    node('buttonelement', { id: 'dup', mappingColor: '#ff0033' }),
    node('prevelement', { mappingColor: '#123456' }),
  ];
  const screen = over.noEffects
    ? node('subview', { left: '4', top: '6', width: '16', height: '12', backgroundImage: 'vid.bmp', clippingColor: '#FFFFFF' })
    : node('subview', { left: '4', top: '6', width: '16', height: '12', backgroundImage: 'vid.bmp', clippingColor: '#FFFFFF' }, [node('effects', { id: 'fx' })]);
  const tree = node('theme', {}, [
    node('view', { width: over.viewWidth ?? '120', height: over.viewHeight ?? '80' }, [
      node('subview', { ...headAt, backgroundImage: 'head.bmp', transparencyColor: '#FF00FF', clippingColor: '#FF0000' }, [
        screen,
        node('buttongroup', { ...groupAttrs, mappingImage: 'map.bmp', image: 'grp.bmp' }, over.elements ?? elements),
        node('slider', { id: 'seek', left: '20', top: '30', width: '30', backgroundImage: 'slider.bmp' }),
        node('slider', { id: 'jsl', left: 'jscript:seek.left+3;', top: '40', backgroundImage: 'slider.bmp' }),
      ]),
      node('subview', { id: 'ear', left: '50', top: '40', width: '60', height: '30', onEndMove: 'Moved();' }, [
        node('slider', { id: 'inear', left: '1', top: '1', backgroundImage: 'slider.bmp' }),
      ]),
    ]),
  ]);
  const files = [
    ['skin.wms', buildWms(tree)],
    ['head.bmp', head],
    ['vid.bmp', vid],
    ['map.bmp', map],
    ['grp.bmp', grp],
    ['slider.bmp', slider],
    ...(over.extraWms ? [['other.wms', buildWms(tree)]] : []),
  ];
  return buildZip(files.map(([name, data]) => ({ name, data, method: 'deflate' })));
}

const at = (mask, w, x, y) => getBit(mask, y * w + x) === 1;

describe('computeRegions on a synthetic skin', () => {
  it('derives the effects hole from the nearest ancestor of EFFECTS that declares a transparencyColor', async () => {
    const r = await computeRegions(skinBytes());
    expect(r.view).toEqual({ width: 120, height: 80 });
    expect(r.wms).toBe('skin.wms');
    expect(r.effectsHole).toMatchObject({ count: 30, offset: { x: 10, y: 5 }, image: 'head.bmp', color: '#FF00FF' });
    // head (10,5) + magenta block at (4,6): view (14,11) to (19,15)
    expect(at(r.effectsHole.mask, 120, 14, 11)).toBe(true);
    expect(at(r.effectsHole.mask, 120, 19, 15)).toBe(true);
    expect(at(r.effectsHole.mask, 120, 13, 11)).toBe(false);
    expect(at(r.effectsHole.mask, 120, 20, 15)).toBe(false);
    expect(popcount(r.effectsHole.mask)).toBe(30);
  });

  it('derives the screen corners from the EFFECTS element\'s own subview, clipped to its box', async () => {
    const r = await computeRegions(skinBytes());
    // the white pixel in row 12 is below the 12-high box, so it is not counted
    expect(r.screenCorners).toMatchObject({ count: 3, offset: { x: 14, y: 11 }, image: 'vid.bmp', color: '#FFFFFF' });
    for (const [x, y] of [[14, 11], [15, 11], [14, 12]]) expect(at(r.screenCorners.mask, 120, x, y), `${x},${y}`).toBe(true);
    expect(at(r.screenCorners.mask, 120, 17, 23)).toBe(false);
  });

  it('drops pixels that fall outside the view', async () => {
    const r = await computeRegions(skinBytes({ headAt: { left: '112', top: '5' } }));
    // the magenta block starts at head x 4, so at view x 116; it is 6 wide, so x 120 and 121 are outside
    expect(r.effectsHole.count).toBe(4 * 5);
    expect(popcount(r.effectsHole.mask)).toBe(20);
  });

  it('finds the unowned pixels of a BUTTONGROUP by exact RGB against the mapping image', async () => {
    const r = await computeRegions(skinBytes());
    expect(r.buttonGroups).toHaveLength(1);
    const g = r.buttonGroups[0];
    // the prevelement owns #123456, the colour the map fills everything else with, so nothing is unowned
    expect(g).toMatchObject({ abs: { x: 12, y: 8 }, size: { w: 10, h: 6 }, mappingImage: 'map.bmp', image: 'grp.bmp', unowned: 0 });
    expect(g.elements.map((e) => [e.label, e.mappingColor, e.owned])).toEqual([
      ['__proto__', '#FF0033', 8],
      ['constructor', '#00FF00', 16],
      ['bad', null, 0],
      ['dup', '#FF0033', 0],
      ['prev', '#123456', 36],
    ]);
  });

  it('counts the pixels no element owns: without the element that owns the fill, the fill', async () => {
    // Drop the element that owns the fill colour: the 36 fill pixels become unowned.
    const r = await computeRegions(
      skinBytes({ elements: [node('buttonelement', { id: 'a', mappingColor: '#FF0033' }), node('buttonelement', { id: 'b', mappingColor: '#00FF00' })] }),
    );
    expect(r.buttonGroups[0].unowned).toBe(36);
    expect(r.unowned.count).toBe(36);
    // abs (12,8): the A block owns view (12..15, 8..9); (16,8) is the fill
    expect(at(r.unowned.mask, 120, 12, 8)).toBe(false);
    expect(at(r.unowned.mask, 120, 16, 8)).toBe(true);
    // the inside of the ring is unowned too
    expect(at(r.unowned.mask, 120, 12 + 7, 8 + 2)).toBe(true);
    expect(at(r.unowned.mask, 120, 12 + 5, 8)).toBe(false); // a ring pixel
  });

  it('treats skin-controlled ids and colours as data: __proto__, constructor and a bad colour', async () => {
    const r = await computeRegions(skinBytes());
    const g = r.buttonGroups[0];
    expect(g.elements.map((e) => e.id)).toEqual(['__proto__', 'constructor', 'bad', 'dup', null]);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain('regions-bad-mapping-color'); // mappingColor="constructor" is not a colour
    expect(codes).toContain('regions-duplicate-mapping-color');
    expect(codes).toContain('regions-element-owns-nothing');
    expect(Object.getPrototypeOf(r.s5)).toBe(Array.prototype);
    expect(r.s5.map((p) => p.label)).toEqual(['__proto__', 'constructor', 'prev']);
    // the same label twice gets a suffix: two elements with the id "x"
    const twice = await computeRegions(
      skinBytes({ elements: [node('buttonelement', { id: 'x', mappingColor: '#FF0033' }), node('buttonelement', { id: 'x', mappingColor: '#00FF00' })] }),
    );
    expect(twice.buttonGroups[0].elements.map((e) => e.label)).toEqual(['x', 'x-2']);
  });

  it('puts each S5 point on the element: the centroid, or the nearest owned pixel when the shape is hollow', async () => {
    const r = await computeRegions(skinBytes());
    const [a, b, fill] = r.s5;
    // A: a 4x2 block at group (0,0): centroid (1.5, 0.5), rounded to (2,1): owned, so not snapped
    expect(a).toMatchObject({ group: 0, label: '__proto__', color: '#FF0033', x: 12 + 2, y: 8 + 1, snapped: false });
    // B: a 5x5 ring at group (5,0): its centroid (7,2) is the hole, so the point snaps onto the ring.
    // Four ring pixels are equally near; the first in scan order wins: (7,0)
    expect(b).toMatchObject({ label: 'constructor', color: '#00FF00', x: 12 + 7, y: 8 + 0, snapped: true });
    const g = r.buttonGroups[0];
    expect(g.elements[1].centroid).toEqual({ x: 12 + 7, y: 8 + 2 });
    // the fill element's point is on the fill: not on A's block and not on B's ring
    const [lx, ly] = [fill.x - 12, fill.y - 8];
    expect(fill.label).toBe('prev');
    expect(lx <= 3 && ly <= 1).toBe(false);
    expect(lx >= 5 && lx <= 9 && ly >= 0 && ly <= 4 && (lx === 5 || lx === 9 || ly === 0 || ly === 4)).toBe(false);
  });

  it('lists a slider only when its whole position is literal and nothing moves it', async () => {
    const r = await computeRegions(skinBytes());
    // seek: head (10,5) + (20,30) = (30,35); width 30 literal, height 4 from the 8x4 image
    expect(r.sliders.rects).toEqual([{ id: 'seek', line: expect.any(Number), x: 30, y: 35, w: 30, h: 4 }]);
    expect(r.sliders.count).toBe(30 * 4);
    expect(r.sliders.unresolved.map((u) => u.id).sort()).toEqual(['inear', 'jsl']);
    const whys = Object.fromEntries(r.sliders.unresolved.map((u) => [u.id, u.why]));
    expect(whys.jsl).toMatch(/left="jscript:seek\.left\+3;"/);
    expect(whys.inear).toMatch(/animated: onEndMove at line \d+/);
    expect(at(r.sliders.mask, 120, 30, 35)).toBe(true);
    expect(at(r.sliders.mask, 120, 60, 35)).toBe(false);
  });

  it('does not guess a group whose position is not literal', async () => {
    const r = await computeRegions(skinBytes({ groupAttrs: { left: 'jscript:head.left;', top: '3' } }));
    const g = r.buttonGroups[0];
    expect(g.abs).toBeNull();
    expect(g.unresolved).toMatch(/left="jscript:head\.left;"/);
    expect(g.elements).toEqual([]);
    expect(r.unowned.count).toBe(0);
    expect(r.s5).toEqual([]);
    expect(r.diagnostics.some((d) => d.code === 'regions-group-unresolved')).toBe(true);
  });

  it('reports a skin with no EFFECTS element instead of inventing a hole', async () => {
    const r = await computeRegions(skinBytes({ noEffects: true }));
    expect(r.effectsHole).toBeNull();
    expect(r.screenCorners).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain('regions-no-effects');
    // the generators still answer: empty masks of the view's size
    expect(popcount(regionMask(r, 'effects-hole'))).toBe(0);
    expect(regionMask(r, 'effects-hole').length).toBe(Math.ceil((120 * 80) / 8));
  });

  it('refuses a skin it cannot measure', async () => {
    await expect(computeRegions(skinBytes({ viewWidth: 'jscript:1' }))).rejects.toThrow(/VIEW has no literal width and height/);
    await expect(computeRegions(skinBytes({ extraWms: true }))).rejects.toThrow(/expected one \.wms in the archive, found 2/);
  });

  it('serves the generators allowlist.json names, and refuses any other', async () => {
    const r = await computeRegions(skinBytes());
    expect(popcount(regionMask(r, 'effects-hole'))).toBe(30);
    expect(popcount(regionMask(r, 'screen-corners'))).toBe(3);
    expect(popcount(regionMask(r, 'unowned-buttongroup'))).toBe(r.unowned.count);
    expect(popcount(regionMask(r, 'sliders'))).toBe(120);
    for (const g of ['faithful-xor-compat', 'constructor', '__proto__']) expect(() => regionMask(r, g), g).toThrow(/does not generate/);
  });

  it('prints counts and coordinates, never pixels', async () => {
    const lines = describeRegions(await computeRegions(skinBytes()));
    const text = lines.join('\n');
    expect(text).toMatch(/effects-hole\s+30 px {2}head\.bmp == #FF00FF at \(10,5\)/);
    expect(text).toMatch(/D11-screen-corners\s+3 px {2}vid\.bmp == #FFFFFF at \(14,11\)/);
    expect(text).toMatch(/unowned BUTTONGROUP pixels \(U-23\): 0 px in 1 group/);
    expect(text).toMatch(/S5 hover points \(view px\), 3:/);
    expect(text).toMatch(/constructor\s+#00FF00\s+\(19, 8\)\s+snapped onto the shape/);
  });
});

describe('regions.mjs as a command', () => {
  const run = (...args) => spawnSync(process.execPath, [REGIONS, ...args], { encoding: 'utf8' });

  it('prints the numbers for a skin file and exits 0', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skinlab-regions-'));
    try {
      const file = path.join(dir, 'mini.wmz');
      writeFileSync(file, skinBytes());
      const out = run(file);
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/regions of mini\.wmz/);
      expect(out.stdout).toMatch(/effects-hole\s+30 px/);
      expect(out.stdout).toMatch(/D11-screen-corners\s+3 px/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on usage errors and 1 on a file it cannot measure', () => {
    expect(run('--nope').status).toBe(2);
    expect(run('a.wmz', 'b.wmz').status).toBe(2);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skinlab-regions-'));
    try {
      const file = path.join(dir, 'broken.wmz');
      writeFileSync(file, new Uint8Array([1, 2, 3, 4]));
      const out = run(file);
      expect(out.status).toBe(1);
      expect(out.stderr.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeHeadspace('regions of the Headspace fixture', (headspace) => {
  it('measures the effects hole at 31,487 px and the screen corners at 106 px, exactly (acceptance numbers, E Appendix A)', async () => {
    const r = await computeRegions(headspace.bytes(), { name: 'Headspace.wmz' });
    expect(r.view).toEqual({ width: 760, height: 394 });
    expect(r.effectsHole).toMatchObject({ count: 31487, offset: { x: 261, y: 0 }, image: 'head.bmp', color: '#FF00FF' });
    expect(r.screenCorners).toMatchObject({ count: 106, offset: { x: 270, y: 59 }, image: 'vid_bkgd.bmp', color: '#FFFFFF' });
    expect(popcount(r.effectsHole.mask)).toBe(31487);
    expect(popcount(r.screenCorners.mask)).toBe(106);
  });

  it('counts the unowned pixels per BUTTONGROUP: spec 6.5 says 1,295 of the transport group', async () => {
    const r = await computeRegions(headspace.bytes(), { name: 'Headspace.wmz' });
    expect(r.buttonGroups.map((g) => [g.abs, g.size, g.unowned, g.elements.length])).toEqual([
      [{ x: 362, y: 4 }, { w: 29, h: 16 }, 16, 2],
      [{ x: 309, y: 31 }, { w: 144, h: 25 }, 1295, 5],
    ]);
    expect(r.unowned.count).toBe(16 + 1295);
    expect(r.diagnostics).toEqual([]);
  });

  it('hovers every transport element and both min/close elements, on the element', async () => {
    const r = await computeRegions(headspace.bytes(), { name: 'Headspace.wmz' });
    expect(r.s5.map((p) => [p.label, p.color])).toEqual([
      ['minimize', '#FF00CC'],
      ['close', '#CC0066'],
      ['prev', '#FF0033'],
      ['play', '#FFFF00'],
      ['stop', '#00FF00'],
      ['next', '#00FFFF'],
      ['vis', '#0000FF'],
    ]);
    for (const p of r.s5) {
      const g = r.buttonGroups[p.group];
      expect(p.x, p.label).toBeGreaterThanOrEqual(g.abs.x);
      expect(p.x, p.label).toBeLessThan(g.abs.x + g.size.w);
      expect(p.y, p.label).toBeGreaterThanOrEqual(g.abs.y);
      expect(p.y, p.label).toBeLessThan(g.abs.y + g.size.h);
    }
    // the transport buttons sit left to right in the order the map draws them
    const xs = r.s5.slice(2).map((p) => p.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('lists the seek slider and leaves the ear sliders unresolved (the ears move)', async () => {
    const r = await computeRegions(headspace.bytes(), { name: 'Headspace.wmz' });
    expect(r.sliders.rects).toEqual([{ id: 'seek', line: expect.any(Number), x: 300, y: 223, w: 163, h: 9 }]);
    expect(r.sliders.unresolved).toHaveLength(12); // balance, volume, eq1..eq10
  });
});
