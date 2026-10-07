// @ts-check
// Headspace through the picker and the shape rasteriser (WAVES W3.5 acceptance 2; ENGINE D2; `parity
// 0.3`, `4.1`). Node, no DOM. Needs the owner's `~/Downloads/Headspace.wmz`; skips with the reason in
// its title without it. The legacy S1 mask comparison also needs the golden store
// (`~/Library/Caches/window_headmpd/skinlab/goldens/`, filled by `skinlab bless --target legacy`) and
// skips, rather than fails, without it.
//
// The model is the literal pass (W2.1) plus the few writes the skin's own `Init()` and the player
// make before the first frame of state S1: the effects slot shown (`EndVideo`), the pause button
// hidden and the stop element disabled (both `wmpenabled:` bindings on a stopped player). Every
// position in S1 is literal, so no layout pass is needed; the diff against the legacy mask would say
// so if that were wrong. Everything expected is computed at run time from the art (key colours, map
// colours, image sizes). Nothing derived from the art is written anywhere.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { decodeImage } from '../../src/engine/image/decode/index.js';
import { probeImage } from '../../src/engine/image/probe.js';
import { pick } from '../../src/engine/input/picker.js';
import { rasterizeShapeWithDiagnostics } from '../../src/engine/shape/mask.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { pickDefinition } from '../../src/engine/wms/select.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { goldensDir, MANIFEST_PATH } from '../../tools/skinlab/paths.mjs';
import { readManifest } from '../../tools/skinlab/store.mjs';
import { describeHeadspace } from '../support/fixtures.js';
import { FAITHFUL, MAGENTA, ORACLE_COMPAT, RED, WHITE, slotsOf, syncImages } from '../engine/shape/support.js';

/** @typedef {import('../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../src/engine/contracts').ViewModel} ViewModel */
/** @typedef {import('../../src/engine/contracts').RgbaImage} RgbaImage */
/** @typedef {import('../../src/engine/contracts').EngineOptions} EngineOptions */

const W = 760;
const H = 394;

/** @type {ViewModel} */
let view;
/** @type {ReturnType<typeof syncImages>} */
let images;
/** @type {(name: string) => RgbaImage} */
let art;

/** @param {string} id @returns {ElementModel} */
const byId = (id) => /** @type {ElementModel} */ (view.byId(id));
/** The view-px top-left of an element whose own and ancestors' `left`/`top` are literal. @param {ElementModel} e */
const origin = (e) => {
  let x = 0;
  let y = 0;
  for (let n = /** @type {ElementModel | null} */ (e); n && n.parent; n = n.parent) { x += Number(n.get('left')); y += Number(n.get('top')); }
  return { x, y };
};
/** @param {ElementModel} e @param {ElementModel} root */
const within = (e, root) => { for (let n = /** @type {ElementModel | null} */ (e); n; n = n.parent) if (n === root) return true; return false; };

/** @param {number} x @param {number} y @param {EngineOptions} [opts] */
const at = (x, y, opts = FAITHFUL) => pick(view, images, slotsOf(), x, y, opts);

/** Every pixel of an image of exactly this colour, as image-local [x, y]. @param {RgbaImage} img @param {number} rgb */
function pixelsOf(img, rgb) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      if (((img.data[p] << 16) | (img.data[p + 1] << 8) | img.data[p + 2]) === rgb) out.push([x, y]);
    }
  }
  return out;
}

/** @param {{ width: number, height: number, bits: Uint8Array }} shape @returns {Set<number>} pixel indices of the set bits */
function setIndices(shape) {
  /** @type {Set<number>} */
  const out = new Set();
  for (let i = 0; i < shape.width * shape.height; i++) if ((shape.bits[i >> 3] >> (i & 7)) & 1) out.add(i);
  return out;
}

describeHeadspace('Headspace picker and shape (W3.5)', (headspace) => {
  beforeAll(async () => {
    const vfs = await openVfs(headspace.bytes(), 'Headspace.wmz');
    const picked = /** @type {NonNullable<ReturnType<typeof pickDefinition>>} */ (pickDefinition(vfs));
    const raw = /** @type {import('../../src/engine/contracts').RawNode} */ (scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read(picked.wms))).text).root);
    /** @type {Map<string, RgbaImage | null>} */
    const decoded = new Map();
    /** @param {string} ref @returns {RgbaImage | null} */
    const load = (ref) => {
      const key = vfs.resolve(ref);
      if (key === null) return null;
      if (!decoded.has(key)) {
        const bytes = vfs.read(key);
        decoded.set(key, bytes ? decodeImage(bytes) : null);
      }
      return decoded.get(key) ?? null;
    };
    images = syncImages({}, load);
    images.record = false;
    art = (name) => {
      const img = load(name);
      if (!img) throw new Error(`Headspace.wmz has no ${name}`);
      return img;
    };
    view = buildTheme(raw, vfs, { probe: (ref) => { const b = vfs.read(ref); return b ? probeImage(b) : null; } }).views[0];

    // State S1: closed, stopped, empty queue.
    byId('visEffects').set('visible', true, 'script'); // Init() -> EndVideo()
    pauseButton().set('visible', false, 'binding'); // wmpenabled:player.controls.pause, stopped
    transportGroup().children[2].set('enabled', false, 'binding'); // the stop element, wmpenabled:player.controls.stop
  });

  /** The head: the VIEW's first SUBVIEW. */
  const head = () => view.view.children[0];
  /** The five-element transport group (Unnamed_buttongroup_2, E D10.6). */
  const transportGroup = () => /** @type {ElementModel} */ (head().children.find((c) => c.kind === 'buttongroup' && c.children.length === 5));
  const pauseButton = () => /** @type {ElementModel} */ (head().children.find((c) => c.tag === 'pausebutton'));

  it('builds the S1 model the rest of the file assumes', () => {
    expect(view.view.children.map((c) => (c.id.startsWith('Unnamed') ? c.kind : c.id))).toEqual(['subview', 'sEqEar', 'sPlEar', 'xEqTt', 'xPlTt', 'xVisTt']);
    expect(origin(byId('sEqEar'))).toEqual({ x: 207, y: 86 }); // closed
    expect(origin(byId('sPlEar'))).toEqual({ x: 277, y: 86 });
    expect(origin(head())).toEqual({ x: 261, y: 0 });
    expect(transportGroup().id).toBe('Unnamed_buttongroup_2');
    expect(pauseButton().get('visible')).toBe(false);
  });

  describe('the picker (parity 0.3, 0.6)', () => {
    it('the head\'s magenta hole picks the effects slot, at every one of its pixels', () => {
      const holes = pixelsOf(art('head.bmp'), MAGENTA);
      expect(holes).toHaveLength(31487);
      const o = origin(head());
      for (const [x, y] of holes) {
        const p = at(o.x + x, o.y + y);
        if (!p || p.el.id !== 'visEffects' || p.role !== 'effects') throw new Error(`head (${x},${y}) picked ${p ? `${p.el.id} ${p.role}` : 'nothing'}`);
      }
    });

    it('with the host reporting the slot\'s rect, the hole still picks the effects slot', () => {
      const o = origin(byId('visEffects'));
      const slots = slotsOf({ visEffects: [{ x: o.x, y: o.y, w: 216, h: 158 }] });
      const p = pick(view, images, slots, 261 + 117, 138, FAITHFUL);
      expect([p?.el.id, p?.role]).toEqual(['visEffects', 'effects']);
    });

    it('head red picks nothing wherever no ear is under it', () => {
      const o = origin(head());
      const reds = pixelsOf(art('head.bmp'), RED);
      expect(reds).toHaveLength(17909);
      expect(at(o.x, o.y)).toBeNull(); // the head's own top-left corner
      let checked = 0;
      for (const [x, y] of reds) {
        if (o.y + y >= 86) continue; // the ears start at y 86 and show through the clipped head
        checked++;
        const p = at(o.x + x, o.y + y);
        if (p) throw new Error(`red (${x},${y}) picked ${p.el.id} ${p.role}`);
      }
      expect(checked).toBeGreaterThan(1000);
    });

    it('a pause-button magenta corner picks the pause button when it is shown (faithful), and passes through in oracle-compat', () => {
      const pause = pauseButton();
      pause.set('visible', true, 'binding');
      try {
        const o = origin(pause);
        const corners = pixelsOf(art('pause_01_default.bmp'), MAGENTA);
        expect(corners).toHaveLength(68);
        for (const [x, y] of corners) {
          const p = at(o.x + x, o.y + y, FAITHFUL);
          if (!p || p.el !== pause || p.role !== 'control') throw new Error(`pause corner (${x},${y}) picked ${p ? `${p.el.id} ${p.role}` : 'nothing'}`);
        }
        const [x, y] = corners[0];
        expect(at(o.x + x, o.y + y, ORACLE_COMPAT)?.el).not.toBe(pause); // the transport pixel beneath
        // an opaque pause pixel is the button in both, and hidden it is nobody
        expect(at(o.x + 11, o.y + 11, ORACLE_COMPAT)?.el).toBe(pause);
      } finally {
        pause.set('visible', false, 'binding');
      }
      const o = origin(pause);
      expect(at(o.x + 11, o.y + 11)?.el).not.toBe(pause);
    });

    it('an unowned transport pixel picks the head background (chrome), never the group or one of its elements', () => {
      const group = transportGroup();
      const map = art('play_controls_map.bmp');
      const keys = new Set(group.children.map((c) => Number(c.get('mappingcolor')) & 0xffffff));
      expect(keys.size).toBe(5);
      const o = origin(group);
      const h = origin(head());
      const headBg = art('head.bmp');
      let chrome = 0;
      let unowned = 0;
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const p4 = (y * map.width + x) * 4;
          if (keys.has((map.data[p4] << 16) | (map.data[p4 + 1] << 8) | map.data[p4 + 2])) continue;
          unowned++;
          const p = at(o.x + x, o.y + y);
          if (p && (p.el === group || p.el.parent === group)) throw new Error(`unowned (${x},${y}) picked the group`);
          // where the head paints under it, the head background takes the press
          const hx = o.x + x - h.x;
          const hy = o.y + y - h.y;
          const q = (hy * headBg.width + hx) * 4;
          const headColor = (headBg.data[q] << 16) | (headBg.data[q + 1] << 8) | headBg.data[q + 2];
          if (headColor !== RED && headColor !== MAGENTA) {
            expect([p?.el, p?.role]).toEqual([head(), 'chrome']);
            chrome++;
          }
        }
      }
      expect(unowned).toBe(25 * 144 - 5 * 461); // parity 6.5: 2,305 of 3,600 pixels are owned
      expect(chrome).toBeGreaterThan(1000);
    });

    it('each owned transport pixel picks its element, with the element\'s index as `part`', () => {
      const group = transportGroup();
      const map = art('play_controls_map.bmp');
      const o = origin(group);
      for (const [i, child] of group.children.entries()) {
        const key = Number(child.get('mappingcolor')) & 0xffffff;
        const owned = pixelsOf(map, key);
        expect(owned, child.id).toHaveLength(461);
        const [x, y] = owned[Math.floor(owned.length / 2)];
        const p = at(o.x + x, o.y + y);
        expect([p?.el, p?.part, p?.role]).toEqual([child, i, i === 2 ? 'blocked' : 'control']); // the stop element is disabled in S1
      }
    });

    it('the EQ panel under the closed ear is occluded by the head', () => {
      const ear = byId('sEqEar');
      const panel = byId('sEqView');
      panel.set('visible', true, 'script'); // as EqOnEndMove would, with the ear still closed
      try {
        const p0 = origin(panel);
        expect(p0).toEqual({ x: 291, y: 96 });
        const headBg = art('head.bmp');
        let covered = 0;
        for (let y = 0; y < 140; y++) {
          for (let x = 0; x < 171; x++) {
            const hx = p0.x + x - 261;
            const hy = p0.y + y;
            const q = (hy * headBg.width + hx) * 4;
            const c = (headBg.data[q] << 16) | (headBg.data[q + 1] << 8) | headBg.data[q + 2];
            if (c === RED) continue;
            covered++;
            const p = at(p0.x + x, p0.y + y);
            if (!p || within(p.el, ear)) throw new Error(`panel (${x},${y}) under the head picked ${p ? `${p.el.id} ${p.role}` : 'nothing'}`);
          }
        }
        expect(covered).toBeGreaterThan(20000);
        // and the panel is real: with the ear open and the panel shown, its own pixels take the press
        ear.set('left', 0, 'anim');
        // a point of the panel's own green: the sliders' `jscript:` positions have not run, so they all
        // sit at the panel's top-left, and nothing else is down here
        const green = at(84 + 100, 96 + 100);
        expect(green?.el).toBe(panel);
        expect(green?.role).toBe('chrome');
      } finally {
        ear.set('left', 207, 'anim');
        panel.set('visible', false, 'script');
      }
    });

    it('the EQ handle is a control at its closed position, and the ear art under it is chrome', () => {
      const h = origin(byId('bEqHandle'));
      expect(h).toEqual({ x: 215, y: 152 });
      const handle = art('L_drwr_open_01_default.bmp');
      const keyed = new Set(pixelsOf(handle, MAGENTA).map(([x, y]) => y * handle.width + x));
      // every pixel the button draws is the button, wherever the ear art beneath it is
      let drawn = 0;
      for (let y = 0; y < handle.height; y++) {
        for (let x = 0; x < handle.width; x++) {
          if (keyed.has(y * handle.width + x)) continue;
          const p = at(h.x + x, h.y + y);
          if (!p || p.el.id !== 'bEqHandle' || p.role !== 'control') throw new Error(`handle (${x},${y}) picked ${p ? p.el.id : 'nothing'}`);
          drawn++;
        }
      }
      expect(drawn).toBe(handle.width * handle.height - 328);
      // and a keyed pixel takes the click too (faithful), or hands it to the ear art beneath (oracle-compat)
      const [kx, ky] = pixelsOf(handle, MAGENTA)[0];
      expect(at(h.x + kx, h.y + ky, FAITHFUL)?.el.id).toBe('bEqHandle');
      expect(at(h.x + kx, h.y + ky, ORACLE_COMPAT)?.el.id).not.toBe('bEqHandle');
    });
  });

  describe('the window shape against the legacy S1 golden (parity 4.1)', () => {
    /** @returns {Promise<{ bits: Uint8Array, popcount: number } | null>} */
    async function legacyS1() {
      const manifest = await readManifest(MANIFEST_PATH);
      for (const [key, e] of manifest.entries) {
        const p = e.provenance;
        if (p.target !== 'legacy' || p.state !== 'S1' || p.dpr !== 1) continue;
        const file = join(goldensDir(), `${key}.mask`);
        if (!existsSync(file)) return null;
        const bits = new Uint8Array(readFileSync(file));
        // a golden that does not match its manifest entry is drift, not a reason to compare against it
        expect(createHash('sha256').update(bits).digest('hex')).toBe(e.maskSha256);
        return { bits, popcount: e.popcount };
      }
      return null;
    }

    /** @param {EngineOptions} opts */
    function engineShape(opts) {
      const out = rasterizeShapeWithDiagnostics(view, images, slotsOf(), opts);
      expect(out.diagnostics).toEqual([]);
      const s = /** @type {{ kind: 'bits', width: number, height: number, bits: Uint8Array }} */ (out.shape);
      expect([s.width, s.height]).toEqual([W, H]);
      return s;
    }

    it('compat differs from the golden by exactly the 106 screen corners; faithful adds the keyed handle pixels', async (ctx) => {
      const golden = await legacyS1();
      if (!golden) return ctx.skip();
      const legacy = setIndices({ width: W, height: H, bits: golden.bits });
      expect(legacy.size).toBe(golden.popcount);

      // the 106 white pixels of vid_bkgd.bmp at the screen's origin (parity 0.3, allow-list D11-screen-corners)
      const screen = origin(byId('visEffects'));
      const corners = new Set(pixelsOf(art('vid_bkgd.bmp'), WHITE).map(([x, y]) => (screen.y + y) * W + screen.x + x));
      expect(corners.size).toBe(106);

      const compat = setIndices(engineShape(ORACLE_COMPAT));
      const onlyLegacy = new Set([...legacy].filter((i) => !compat.has(i)));
      const onlyCompat = new Set([...compat].filter((i) => !legacy.has(i)));
      expect(onlyCompat.size).toBe(0);
      expect(onlyLegacy).toEqual(corners);

      // the handles' keyed pixels (allow-list button-transparency): magenta in the BUTTON image, hit but not painted
      const keyed = new Set();
      for (const [id, name] of /** @type {const} */ ([['bEqHandle', 'L_drwr_open_01_default.bmp'], ['bPlHandle', 'R_drwr_open_01_default.bmp']])) {
        const o = origin(byId(id));
        for (const [x, y] of pixelsOf(art(name), MAGENTA)) keyed.add((o.y + y) * W + o.x + x);
      }
      const faithful = setIndices(engineShape(FAITHFUL));
      const extra = new Set([...faithful].filter((i) => !legacy.has(i)));
      const expectedExtra = new Set([...keyed].filter((i) => !legacy.has(i)));
      expect(extra).toEqual(expectedExtra);
      const lacking = new Set([...legacy].filter((i) => !faithful.has(i)));
      expect(lacking).toEqual(corners);
      // the count, for the gate: a judge measured about 265 (130 EQ handle + 135 PL handle)
      console.log(`W3.5 S1 shape: legacy ${legacy.size}, compat ${compat.size} (-${onlyLegacy.size}), faithful ${faithful.size} (+${extra.size} keyed handle pixels, -${lacking.size} corners)`);
      expect(extra.size).toBeGreaterThan(200);
      expect(extra.size).toBeLessThan(330);
    });

    it('the shape does not depend on whether the host reports the effects slot or the engine falls back to the box', async () => {
      const screen = origin(byId('visEffects'));
      const slots = slotsOf({ visEffects: [{ x: screen.x, y: screen.y, w: 216, h: 158 }] });
      const a = rasterizeShapeWithDiagnostics(view, images, slots, FAITHFUL).shape;
      const b = rasterizeShapeWithDiagnostics(view, images, slotsOf(), FAITHFUL).shape;
      expect(a).toEqual(b);
    });

    it('every pixel the picker finds something on in S1 is in the faithful shape', () => {
      const s = engineShape(FAITHFUL);
      let hits = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 3) {
          const p = at(x, y);
          if (!p) continue;
          hits++;
          const i = y * W + x;
          if (!((s.bits[i >> 3] >> (i & 7)) & 1)) throw new Error(`(${x},${y}) picks ${p.el.id} ${p.role} but is not in the shape`);
        }
      }
      expect(hits).toBeGreaterThan(20000);
    });
  });
});
