// Computed allow-list regions (E §9, E D9), derived at run time from the skin's own bytes with the
// engine's own decoders, so no art coordinate is hardcoded here. No engine runtime is involved: only
// the archive reader, the text decoder, the tolerant scanner, the tag and colour tables and the image
// decoder (W1.1, W1.2, W1.3, W1.6).
//
//   effects-hole        the pixels of the background of the nearest ancestor of the EFFECTS element
//                       that declares a transparencyColor, equal to that colour, at that ancestor's
//                       absolute origin (Headspace: head.bmp's #FF00FF at (261,0): 31,487 px).
//   D11-screen-corners  the pixels of the EFFECTS element's own enclosing SUBVIEW background equal to
//                       its clippingColor, at that SUBVIEW's origin (vid_bkgd.bmp's white at (270,59):
//                       106 px). The oracle counts the effects canvas as a solid rectangle, so its
//                       mask has these bits and the engine's does not.
//   unowned pixels      for each BUTTONGROUP, the pixels of its rect that no child's mappingColor
//                       owns, by exact RGB match against the mapping image (U-23: the oracle paints
//                       them, the engine does not).
//   sliders             rects of SLIDER elements whose whole position chain is literal (U-10).
//   S5 points           per mapping colour, the centroid of its owned pixels in view px, snapped to the
//                       nearest owned pixel when the centroid falls off the shape: where skinlab
//                       hovers and presses.
//
// Absolute positions sum the literal `left` and `top` up the raw tree. An ancestor with a non-literal
// position (`jscript:`, `wmpprop:`) makes everything beneath it unresolved: it is listed, never guessed.
//
// Run directly it prints the numbers (never pixels):  node tools/skinlab/regions.mjs [skin.wmz]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { decodeImage } from '../../src/engine/image/decode/index.js';
import { probeImage } from '../../src/engine/image/probe.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { resolveTag } from '../../src/engine/wms/tags.js';
import { parseColor } from '../../src/engine/wms/values.js';
import { EXIT, skip, usageError } from './exit.mjs';
import { checkFixture } from './paths.mjs';
import { newMask, popcount, rectMask, setBit } from './diff.mjs';

/** @typedef {import('../../src/engine/contracts').RawNode} RawNode */

const LITERAL_INT = /^\s*[+-]?\d+\s*$/;
const hex6 = (n) => `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
const kindOf = (node) => resolveTag(node.tag).kind;

/** @param {RawNode} node @param {string} name @returns {string | undefined} attribute names arrive lowercased */
const attrOf = (node, name) => node.attrs.find((a) => a.name === name)?.value;

/**
 * A literal integer attribute: `{ value }`, `{ value: fallback }` when absent, or `{ bad }` when the
 * text is an expression or anything else non-literal.
 */
function literal(node, name, fallback = 0) {
  const raw = attrOf(node, name);
  if (raw === undefined) return { value: fallback };
  return LITERAL_INT.test(raw) ? { value: parseInt(raw, 10) } : { bad: `${name}="${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}"` };
}

/** Index the raw tree: parent and absolute position (literal chain only) of every node. */
function indexTree(root) {
  /** @type {Map<RawNode, { parent: RawNode | null, x: number, y: number, ok: boolean, why: string | null }>} */
  const info = new Map();
  const visit = (node, parent) => {
    const base = parent ? info.get(parent) : { x: 0, y: 0, ok: true, why: null };
    const l = literal(node, 'left');
    const t = literal(node, 'top');
    // An onEndMove handler means the skin moves this element at run time (Headspace's ears and
    // drop), so its literal left/top is only where it starts, not where a state shows it.
    const bad = l.bad ?? t.bad ?? (attrOf(node, 'onendmove') !== undefined ? `animated: onEndMove at line ${node.line}` : undefined);
    info.set(node, {
      parent,
      x: base.x + (l.value ?? 0),
      y: base.y + (t.value ?? 0),
      ok: base.ok && !bad,
      why: base.why ?? bad ?? null,
    });
    for (const c of node.children) visit(c, node);
  };
  visit(root, null);
  return info;
}

function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/**
 * The pixels of `ref`'s image equal to `color` (alpha > 0: a pixel that is already absent is never
 * keyed), placed at (ox, oy), clipped to the view and, when the owner has a literal size, to its box.
 */
function keyedPixels(img, color, ox, oy, view, box) {
  const mask = newMask(view.width, view.height);
  const w = box ? Math.min(img.width, box.w) : img.width;
  const h = box ? Math.min(img.height, box.h) : img.height;
  for (let y = 0; y < h; y++) {
    const vy = oy + y;
    if (vy < 0 || vy >= view.height) continue;
    for (let x = 0; x < w; x++) {
      const vx = ox + x;
      if (vx < 0 || vx >= view.width) continue;
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] === 0) continue;
      if (((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]) === color) setBit(mask, vy * view.width + vx);
    }
  }
  return { mask, count: popcount(mask) };
}

/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * @param {Uint8Array} archive the .wmz bytes
 * @param {{ name?: string }} [opts]
 */
export async function computeRegions(archive, opts = {}) {
  const vfs = await openVfs(archive, opts.name ?? 'skin.wmz');
  const wmsFiles = vfs.list('.wms');
  if (wmsFiles.length !== 1) throw new Error(`regions: expected one .wms in the archive, found ${wmsFiles.length}`);
  const wmsKey = wmsFiles[0];
  const { text } = decodeText(/** @type {Uint8Array} */ (vfs.read(wmsKey)));
  const scanned = scanWms(text);
  if (!scanned.root) throw new Error('regions: the .wms has no root element');
  const root = scanned.root;
  const info = indexTree(root);
  const diagnostics = [];
  const note = (code, detail, node) => diagnostics.push({ code, detail, severity: 'warn', ...(node ? { line: node.line } : {}) });

  const viewNode = [...walk(root)].find((n) => kindOf(n) === 'view');
  const vw = viewNode && literal(viewNode, 'width', NaN).value;
  const vh = viewNode && literal(viewNode, 'height', NaN).value;
  if (!Number.isInteger(vw) || !Number.isInteger(vh) || vw < 1 || vh < 1) throw new Error('regions: the VIEW has no literal width and height');
  const view = { width: vw, height: vh };

  /** @type {Map<string, { img: import('../../src/engine/contracts').RgbaImage | null }>} */
  const imageCache = new Map();
  const imageOf = (ref) => {
    if (!imageCache.has(ref)) {
      const bytes = vfs.read(ref);
      imageCache.set(ref, { img: bytes ? decodeImage(bytes) : null });
    }
    return imageCache.get(ref).img;
  };

  const boxOf = (node) => {
    const w = literal(node, 'width', NaN).value;
    const h = literal(node, 'height', NaN).value;
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { w, h } : null;
  };

  const ancestors = function* (node) {
    for (let p = info.get(node).parent; p; p = info.get(p).parent) yield p;
  };
  const isBacked = (n) => ['subview', 'view'].includes(kindOf(n)) && attrOf(n, 'backgroundimage') !== undefined;

  /** The keyed pixels of an ancestor's background: which attribute names the colour decides which region. */
  const keyedRegion = (owner, colorAttr, what) => {
    const colour = parseColor(attrOf(owner, colorAttr) ?? '');
    const at = info.get(owner);
    const ref = attrOf(owner, 'backgroundimage');
    const img = imageOf(ref);
    if (!at.ok) throw new Error(`regions: ${what}: the position of the ${kindOf(owner)} at line ${owner.line} is not literal (${at.why})`);
    if (!img) throw new Error(`regions: ${what}: ${ref} is missing or undecodable`);
    const { mask, count } = keyedPixels(img, /** @type {number} */ (colour), at.x, at.y, view, boxOf(owner));
    return { mask, count, offset: { x: at.x, y: at.y }, image: ref, color: hex6(/** @type {number} */ (colour)) };
  };

  // ---- effects-hole and D11-screen-corners ----
  const effects = [...walk(root)].find((n) => kindOf(n) === 'effects');
  let effectsHole = null;
  let screenCorners = null;
  if (!effects) {
    note('regions-no-effects', 'the skin has no EFFECTS element: no effects-hole and no screen corners');
  } else {
    const holeOwner = [...ancestors(effects)].find((n) => isBacked(n) && typeof parseColor(attrOf(n, 'transparencycolor') ?? '') === 'number');
    if (holeOwner) effectsHole = keyedRegion(holeOwner, 'transparencycolor', 'effects-hole');
    else note('regions-no-hole', 'no ancestor of the EFFECTS element declares a transparencyColor on a background', effects);
    const cornerOwner = [...ancestors(effects)].find((n) => isBacked(n) && typeof parseColor(attrOf(n, 'clippingcolor') ?? '') === 'number');
    if (cornerOwner) screenCorners = keyedRegion(cornerOwner, 'clippingcolor', 'D11-screen-corners');
    else note('regions-no-corners', 'no ancestor of the EFFECTS element declares a clippingColor on a background', effects);
  }

  // ---- BUTTONGROUPs ----
  let unownedMask = newMask(view.width, view.height);
  const buttonGroups = [];
  const s5 = [];
  const groupNodes = [...walk(root)].filter((n) => kindOf(n) === 'buttongroup');
  for (const [gi, g] of groupNodes.entries()) {
    const at = info.get(g);
    const group = {
      index: gi, id: attrOf(g, 'id') ?? null, line: g.line,
      mappingImage: attrOf(g, 'mappingimage') ?? null, image: attrOf(g, 'image') ?? null,
      abs: at.ok ? { x: at.x, y: at.y } : null, size: null, unowned: 0, elements: [], unresolved: at.ok ? null : at.why,
    };
    buttonGroups.push(group);
    if (!at.ok) {
      note('regions-group-unresolved', `BUTTONGROUP at line ${g.line}: position not literal (${at.why})`, g);
      continue;
    }
    const map = group.mappingImage ? imageOf(group.mappingImage) : null;
    if (!map) {
      note('regions-group-no-map', `BUTTONGROUP at line ${g.line}: mapping image ${group.mappingImage ?? '(none)'} is missing or undecodable`, g);
      continue;
    }
    const probe = group.image ? probeImage(vfs.read(group.image) ?? new Uint8Array(0)) : null;
    const size = { w: probe?.width ?? map.width, h: probe?.height ?? map.height };
    group.size = size;

    // Owners: first declared element wins a repeated colour. A Map keyed by the number, because the
    // attribute text is the skin's and an `id` of `__proto__` must be a name like any other.
    const owner = new Map();
    const labels = new Map();
    const elements = [];
    for (const child of g.children) {
      const raw = attrOf(child, 'mappingcolor');
      if (raw === undefined) continue;
      const colour = parseColor(raw);
      const index = elements.length;
      const id = attrOf(child, 'id') ?? null;
      const kind = kindOf(child);
      let label = id ?? (child.tag.endsWith('element') && child.tag !== 'buttonelement' ? child.tag.slice(0, -'element'.length) : null)
        ?? slug(attrOf(child, 'uptooltip') ?? '');
      if (!label) label = `e${index}`;
      const seen = labels.get(label) ?? 0;
      labels.set(label, seen + 1);
      if (seen) label = `${label}-${seen + 1}`;
      const el = { index, tag: child.tag, kind, id, label, line: child.line, mappingColor: typeof colour === 'number' ? hex6(colour) : null, owned: 0, centroid: null, point: null, snapped: false };
      elements.push(el);
      if (typeof colour !== 'number') {
        note('regions-bad-mapping-color', `mappingColor "${raw}" at line ${child.line} is not a colour; the element owns nothing`, child);
      } else if (owner.has(colour)) {
        note('regions-duplicate-mapping-color', `mappingColor ${hex6(colour)} at line ${child.line} repeats an earlier element's; the first one owns it`, child);
      } else owner.set(colour, index);
    }
    group.elements = elements;

    const ownedPixels = elements.map(() => []);
    let unowned = 0;
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        let who;
        if (x < map.width && y < map.height) {
          const o = (y * map.width + x) * 4;
          who = owner.get((map.data[o] << 16) | (map.data[o + 1] << 8) | map.data[o + 2]);
        }
        if (who === undefined) {
          unowned++;
          const vx = at.x + x;
          const vy = at.y + y;
          if (vx >= 0 && vx < view.width && vy >= 0 && vy < view.height) setBit(unownedMask, vy * view.width + vx);
        } else ownedPixels[who].push(y * size.w + x);
      }
    }
    group.unowned = unowned;

    for (const el of elements) {
      const px = ownedPixels[el.index];
      el.owned = px.length;
      if (!px.length) {
        if (el.mappingColor) note('regions-element-owns-nothing', `${el.label} (${el.mappingColor}) at line ${el.line} owns no pixel of ${group.mappingImage}`, g);
        continue;
      }
      let sx = 0;
      let sy = 0;
      for (const i of px) {
        sx += i % size.w;
        sy += Math.floor(i / size.w);
      }
      const cx = sx / px.length;
      const cy = sy / px.length;
      let bx = Math.round(cx);
      let by = Math.round(cy);
      if (!px.includes(by * size.w + bx)) {
        let best = Infinity;
        for (const i of px) {
          const x = i % size.w;
          const y = Math.floor(i / size.w);
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d < best) {
            best = d;
            bx = x;
            by = y;
          }
        }
        el.snapped = true;
      }
      el.centroid = { x: at.x + cx, y: at.y + cy };
      el.point = { x: at.x + bx, y: at.y + by };
      s5.push({ group: gi, element: el.index, label: el.label, color: el.mappingColor, x: el.point.x, y: el.point.y, snapped: el.snapped });
    }
  }

  // ---- sliders (U-10) ----
  const sliderMask = newMask(view.width, view.height);
  const sliders = { rects: [], unresolved: [] };
  for (const n of walk(root)) {
    if (kindOf(n) !== 'slider') continue;
    const at = info.get(n);
    const id = attrOf(n, 'id') ?? null;
    if (!at.ok) {
      sliders.unresolved.push({ id, line: n.line, why: at.why });
      continue;
    }
    // A literal width or height wins; the missing axis comes from the background image.
    const ref = attrOf(n, 'backgroundimage');
    const probe = ref ? probeImage(vfs.read(ref) ?? new Uint8Array(0)) : null;
    const lw = literal(n, 'width', NaN).value;
    const lh = literal(n, 'height', NaN).value;
    const w = Number.isInteger(lw) && lw > 0 ? lw : probe?.width;
    const h = Number.isInteger(lh) && lh > 0 ? lh : probe?.height;
    if (!w || !h) {
      sliders.unresolved.push({ id, line: n.line, why: 'no literal size and no readable backgroundImage' });
      continue;
    }
    const box = { w, h };
    sliders.rects.push({ id, line: n.line, x: at.x, y: at.y, w: box.w, h: box.h });
    const m = rectMask(view.width, view.height, [at.x, at.y, at.x + box.w, at.y + box.h]);
    for (let i = 0; i < m.length; i++) sliderMask[i] |= m[i];
  }

  return {
    name: vfs.name, sha: vfs.sha, wms: wmsKey, view,
    effectsHole, screenCorners, buttonGroups,
    unowned: { mask: unownedMask, count: popcount(unownedMask) },
    sliders: { ...sliders, mask: sliderMask, count: popcount(sliderMask) },
    s5, diagnostics: [...scanned.diagnostics.filter((d) => d.severity === 'error'), ...diagnostics],
  };
}

/** The masks of the computed generators this module owns (allowlist.json `region.generator`). */
export function regionMask(regions, generator) {
  switch (generator) {
    case 'effects-hole': return regions.effectsHole?.mask ?? newMask(regions.view.width, regions.view.height);
    case 'screen-corners': return regions.screenCorners?.mask ?? newMask(regions.view.width, regions.view.height);
    case 'unowned-buttongroup': return regions.unowned.mask;
    case 'sliders': return regions.sliders.mask;
    default: throw new Error(`regions.mjs does not generate "${generator}"`);
  }
}

const n = (x) => x.toLocaleString('en-US');
const pt = (p) => (p ? `(${p.x},${p.y})` : '-');

/** The numbers, as lines. No pixels, no file names beyond what the .wms itself says. */
export function describeRegions(r) {
  const out = [`regions of ${r.name} (sha256 ${r.sha.slice(0, 12)}…), definition ${r.wms}, view ${r.view.width}x${r.view.height}`];
  const keyed = (label, k) => (k ? `${label.padEnd(20)}${n(k.count).padStart(8)} px  ${k.image} == ${k.color} at ${pt(k.offset)}` : `${label.padEnd(20)}${'none'.padStart(8)}`);
  out.push(keyed('effects-hole', r.effectsHole), keyed('D11-screen-corners', r.screenCorners));
  out.push(`unowned BUTTONGROUP pixels (U-23): ${n(r.unowned.count)} px in ${r.buttonGroups.length} group(s)`);
  for (const g of r.buttonGroups) {
    const size = g.size ? `${g.size.w}x${g.size.h}` : '?';
    out.push(`  group ${g.index}${g.id ? ` "${g.id}"` : ''} line ${g.line} at ${pt(g.abs)} ${size}: ${n(g.unowned)} unowned of ${g.size ? n(g.size.w * g.size.h) : '?'}, ${g.elements.length} element(s)${g.unresolved ? `, UNRESOLVED (${g.unresolved})` : ''}`);
    for (const e of g.elements) out.push(`    ${e.label.padEnd(12)}${(e.mappingColor ?? 'bad colour').padEnd(10)}${n(e.owned).padStart(6)} px  centroid ${e.centroid ? `(${e.centroid.x.toFixed(1)},${e.centroid.y.toFixed(1)})` : '-'}`);
  }
  out.push(`S5 hover points (view px), ${r.s5.length}:`);
  for (const p of r.s5) out.push(`  ${`g${p.group}.${p.label}`.padEnd(18)}${p.color}  (${p.x}, ${p.y})${p.snapped ? '  snapped onto the shape' : ''}`);
  out.push(`sliders with a literal position (U-10): ${r.sliders.rects.length} rect(s), ${n(r.sliders.count)} px; ${r.sliders.unresolved.length} unresolved`);
  for (const s of r.sliders.rects) out.push(`  ${(s.id ?? `line ${s.line}`).padEnd(12)}(${s.x},${s.y}) ${s.w}x${s.h}`);
  for (const d of r.diagnostics) out.push(`  diagnostic ${d.code}: ${d.detail}`);
  return out;
}

// ---- command line ----------------------------------------------------------------------------------------

async function main(argv) {
  const files = argv.filter((a) => !a.startsWith('-'));
  const flags = argv.filter((a) => a.startsWith('-'));
  if (flags.length || files.length > 1) throw usageError('usage: node tools/skinlab/regions.mjs [skin.wmz]');
  let file = files[0];
  if (!file) {
    const fixture = await checkFixture();
    if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
    if (fixture.status === 'badsha') throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}`);
    file = fixture.path;
  }
  const regions = await computeRegions(new Uint8Array(await readFile(file)), { name: path.basename(file) });
  for (const line of describeRegions(regions)) console.log(line);
  return EXIT.PASS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e?.message ?? e);
      process.exitCode = typeof e?.code === 'number' ? e.code : EXIT.FAIL;
    },
  );
}
