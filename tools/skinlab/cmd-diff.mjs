// diff --files a.png b.png [--mask-a FILE --mask-b FILE] [--dpr N] [--within x0,y0,x1,y1]
//      [--config compat|faithful --state S1 [--mask-compat FILE]] [--strict] [--out DIR]
//
// Compare two screenshots (and, optionally, two hit masks) with the same machinery `check` uses. Used
// by G-WK (E D9): the two renderers in the real app, captured with screencapture, diffed with the same
// allow-list. Without --config and --state nothing is allowed: every difference is reported. With
// both, the allow-list entries for that configuration and state apply, their computed regions taken
// from the fixture (so it must be present: 77 when absent, 2 when it is the wrong file).
//
// Masks are the raw bit files of the golden store (1 bpp, row-major, LSB first, skin px). The skin size
// is the image size over the DPR. With --config faithful and masks, button-transparency needs the
// engine's compat mask too (--mask-compat; --mask-b is then the faithful engine mask).
//
// Prints the differing counts and the bounding box of every difference no entry allowed (inclusive
// skin px). --within x0,y0,x1,y1 allows every difference inside that half-open rect, so the diff
// passes exactly when all of them lie inside it. Exit 0 when nothing is left over, 1 when something
// is, 2 for usage. Output PNGs and report.json go to a
// run directory outside the repo (they are derived from skin art).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ALLOWLIST_PATH, CONFIGS, activeEntries, materialize, readAllowlist, strictViolations } from './allowlist.mjs';
import { decodePng, diffImages, diffMasks, judge, maskBytes, rectMask, renderDiff, reportOf, writeOutputs, xorMask } from './diff.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { REPO_ROOT, checkFixture, runOutDir } from './paths.mjs';
import { runId } from './common.mjs';
import { computeRegions, regionMask } from './regions.mjs';
import { SKIN_SIZE } from './states.mjs';

const n = (x) => x.toLocaleString('en-US');
const box = (b) => `(${b.x0},${b.y0})-(${b.x1},${b.y1})`;

/** `--within 0,86,476,256` as a half-open rect. */
export function parseWithin(text) {
  const parts = String(text).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || !parts.every(Number.isInteger) || parts[2] <= parts[0] || parts[3] <= parts[1]) {
    throw new Error('--within takes x0,y0,x1,y1 (integers, half-open, skin px) with x1 > x0 and y1 > y0');
  }
  return parts;
}

/** Whole skin px per image px: the DPR, from an explicit flag or the image width over the skin's. */
function dprFor(explicit, width, height, required) {
  if (explicit !== undefined) {
    const d = Number(explicit);
    if (!Number.isInteger(d) || d < 1) throw new Error(`--dpr must be a positive integer, got "${explicit}"`);
    return d;
  }
  const d = width / SKIN_SIZE.width;
  if (Number.isInteger(d) && d >= 1 && height === SKIN_SIZE.height * d) return d;
  if (required) throw new Error(`cannot infer the DPR of a ${width}x${height} image (skin ${SKIN_SIZE.width}x${SKIN_SIZE.height}); pass --dpr`);
  return 1;
}

async function readBytes(file, what) {
  try {
    return new Uint8Array(await readFile(file));
  } catch (e) {
    if (e && e.code === 'ENOENT') throw usageError(`${what}: no such file ${file}`);
    throw e;
  }
}

export default async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        files: { type: 'string', multiple: true },
        'mask-a': { type: 'string' },
        'mask-b': { type: 'string' },
        'mask-compat': { type: 'string' },
        dpr: { type: 'string' },
        within: { type: 'string' },
        config: { type: 'string' },
        state: { type: 'string' },
        strict: { type: 'boolean', default: false },
        out: { type: 'string' },
      },
    });
  } catch (e) {
    throw usageError(e.message);
  }
  const { values } = parsed;
  // `--files a.png b.png`: the first path is the option's value, the second arrives as a positional.
  const files = [...(values.files ?? []), ...parsed.positionals];
  if (files.length !== 2) throw usageError('usage: diff --files a.png b.png [--mask-a FILE --mask-b FILE] [--config C --state S] [--within x0,y0,x1,y1]');
  if (Boolean(values['mask-a']) !== Boolean(values['mask-b'])) throw usageError('--mask-a and --mask-b go together');
  if ((values.config === undefined) !== (values.state === undefined)) throw usageError('--config and --state go together (they select the allow-list entries)');
  if (values.config !== undefined && !CONFIGS.includes(values.config)) throw usageError(`unknown config "${values.config}" (known: ${CONFIGS.join(', ')})`);
  let within = null;
  if (values.within !== undefined) {
    try {
      within = parseWithin(values.within);
    } catch (e) {
      throw usageError(e.message);
    }
  }

  const outDir = values.out ? path.resolve(values.out) : runOutDir(runId('diff'));
  // The pictures are derived from skin art, which never goes inside the repository (global rule 2).
  const rel = path.relative(REPO_ROOT, outDir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw usageError(`--out ${outDir} is inside the repository; the diff PNGs are derived from skin art (use ~/Library/Caches/window_headmpd/ or /tmp)`);

  const a = await readBytes(files[0], 'first image');
  const b = await readBytes(files[1], 'second image');
  let pa;
  let pb;
  try {
    pa = decodePng(a);
    pb = decodePng(b);
  } catch (e) {
    throw usageError(`not a PNG: ${e.message}`);
  }
  if (pa.width !== pb.width || pa.height !== pb.height) throw fail(`the images differ in size: ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
  let dpr;
  try {
    dpr = dprFor(values.dpr, pa.width, pa.height, values.config !== undefined || Boolean(values['mask-a']));
  } catch (e) {
    throw usageError(e.message);
  }
  const sw = pa.width / dpr;
  const sh = pa.height / dpr;

  let maskA = null;
  let maskB = null;
  let maskC = null;
  if (values['mask-a']) {
    maskA = await readBytes(values['mask-a'], '--mask-a');
    maskB = await readBytes(values['mask-b'], '--mask-b');
    if (values['mask-compat']) maskC = await readBytes(values['mask-compat'], '--mask-compat');
    for (const [label, m] of [['--mask-a', maskA], ['--mask-b', maskB], ['--mask-compat', maskC]]) {
      if (m && m.length !== maskBytes(sw, sh)) throw usageError(`${label} is ${m.length} bytes, a ${sw}x${sh} mask is ${maskBytes(sw, sh)}`);
    }
  }

  /** @type {import('./diff.mjs').DiffEntry[]} */
  let entries = [];
  if (values.config !== undefined) {
    if (sw !== SKIN_SIZE.width || sh !== SKIN_SIZE.height) throw usageError(`the allow-list is for ${SKIN_SIZE.width}x${SKIN_SIZE.height} skin px; these images are ${sw}x${sh} at dpr ${dpr}`);
    const fixture = await checkFixture();
    if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
    if (fixture.status === 'badsha') throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}`);
    const regions = await computeRegions(new Uint8Array(await readFile(fixture.path)), { name: path.basename(fixture.path) });
    const list = await readAllowlist(ALLOWLIST_PATH);
    const active = activeEntries(list, { config: values.config, state: values.state });
    if (values.strict) {
      const nulls = strictViolations(active);
      if (nulls.length) throw fail(`--strict: ${nulls.join('; ')}`);
    }
    const needsCompat = active.some((e) => e.kind === 'mask' && e.region.kind === 'computed' && e.region.generator === 'faithful-xor-compat');
    if (needsCompat && maskA && !maskC) throw usageError('--config faithful with masks needs --mask-compat: button-transparency is faithfulMask XOR compatMask (--mask-b is the faithful one)');
    entries = materialize(
      // Without masks there is nothing for a mask entry to absorb, and the compare ignores them.
      active.filter((e) => maskA || e.kind !== 'mask'),
      {
        width: sw,
        height: sh,
        rect: (r) => rectMask(sw, sh, r),
        computed: (g) => (g === 'faithful-xor-compat' ? xorMask(maskB, maskC) : regionMask(regions, g)),
      },
    );
  }

  if (within) {
    // --within is an ad-hoc allowance: differences inside the rect are allowed, any outside it are not.
    const area = (within[2] - within[0]) * (within[3] - within[1]);
    const mask = rectMask(sw, sh, within);
    entries.push({ id: '--within', kind: 'pixel', mask, bound: area }, { id: '--within', kind: 'mask', mask, bound: area });
  }

  const pix = diffImages(pa, pb, { dpr, entries });
  const msk = maskA ? diffMasks(maskA, maskB, { width: sw, height: sh, entries }) : null;
  const pv = judge(pix, { strict: values.strict });
  const mv = msk ? judge(msk, { strict: values.strict }) : { pass: true, failures: [] };

  console.log(`images: ${pa.width}x${pa.height} (dpr ${dpr}, ${sw}x${sh} skin px)`);
  console.log(`pixels: ${n(pix.differingSkinPx)} skin px differ (${n(pix.differingDevicePx)} device px), ${n(pix.excludedSkinPx)} excluded, ${n(pix.absorbedSkinPx)} allowed, ${n(pix.unabsorbedSkinPx)} left over`);
  console.log(`  bounding box of the differences left over: ${pix.bbox ? box(pix.bbox) : 'none'} (inclusive), ${pix.componentCount} component(s)`);
  for (const c of pix.components.slice(0, 20)) console.log(`  component ${box(c)} ${n(c.count)} px`);
  if (pix.componentsTruncated) console.log(`  ... ${pix.componentCount - pix.components.length} more component(s)`);
  for (const e of pix.entries) console.log(`  entry ${e.id}: ${n(e.count)}${e.bound === null ? ' (null bound)' : ` of ${n(e.bound)}`} ${e.status}${e.unused ? ', absorbed nothing' : ''}`);
  if (msk) {
    console.log(`mask: ${n(msk.popcountA)} vs ${n(msk.popcountB)} bits set, xor ${n(msk.xorCount)}, ${n(msk.unabsorbedCount)} left over${msk.bbox ? `, in ${box(msk.bbox)}` : ''}`);
    for (const e of msk.entries) console.log(`  entry ${e.id}: ${n(e.count)}${e.bound === null ? ' (null bound)' : ` of ${n(e.bound)}`} ${e.status}${e.unused ? ', absorbed nothing' : ''}`);
  }

  const failures = [...pv.failures, ...mv.failures];
  if (within && !failures.length) console.log(`all differences lie inside (${within[0]},${within[1]})-(${within[2]},${within[3]})`);

  await writeOutputs(outDir, {
    pngs: { diff: renderDiff(pb, pix) },
    report: { files, dpr, config: values.config ?? null, state: values.state ?? null, within, pixels: reportOf(pix), mask: msk ? reportOf(msk) : null, failures },
  });
  console.log(`output: ${outDir}`);
  if (failures.length) {
    for (const f of failures) console.error(`FAIL: ${f}`);
    return EXIT.FAIL;
  }
  console.log('PASS: no differences left over');
  return EXIT.PASS;
}
