// verify-legacy: re-capture the legacy and compare PNG and mask hashes with the manifest.
// Exit 0 pass, 1 drift or nothing to compare, 2 wrong fixture or usage, 77 skip.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureState, stateById, withLegacySession } from './capture.mjs';
import { keyInputs, legacyKey, maskReport, parseOptions, requireLegacyTarget, runId } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { EXIT, fail, usageError } from './exit.mjs';
import { MANIFEST_PATH, runOutDir, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';
import { parseDprs, parseStateIds } from './states.mjs';
import { compareToManifest, loadGolden, readManifest, saveGolden } from './store.mjs';

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    states: { type: 'string' },
    dpr: { type: 'string' },
  });
  requireLegacyTarget(values.target, { required: false });
  let ids;
  let dprs;
  try {
    ids = parseStateIds(values.states);
    dprs = parseDprs(values.dpr);
  } catch (e) {
    throw usageError(e.message);
  }

  const { fixture } = await prepare();
  const manifest = await readManifest(MANIFEST_PATH);
  if (!manifest.entries.size) throw fail('nothing to verify: the manifest has no goldens (run: npm run skinlab -- bless --target legacy --reason "...")');
  const pin = await oraclePin();
  if (manifest.oraclePin !== pin) {
    throw fail(
      `oracle drift: a pinned file changed since the goldens were blessed (manifest pin ${manifest.oraclePin?.slice(0, 12)}, now ${pin.slice(0, 12)}). ` +
        'If that was intended (the re-pin batch), Opus re-blesses with --repin.',
    );
  }

  const outDir = runOutDir(runId('verify-legacy'));
  await mkdir(outDir, { recursive: true });
  const store = storeRoot();

  const results = await withLegacySession(async ({ baseUrl, browser, chromium }) => {
    const inputs = await keyInputs({ fixture, chromium });
    const out = [];
    for (const id of ids) {
      for (const dpr of dprs) {
        const state = stateById(id);
        const cap = await captureState(browser, baseUrl, state, dpr);
        const key = legacyKey(inputs, id, dpr);
        const cmp = compareToManifest(manifest, { ...cap, key });
        let restored = false;
        if (cmp.status === 'ok' && !(await loadGolden(key, cmp.entry, store))) {
          // The local golden was missing or corrupt; this capture just verified against the manifest.
          await saveGolden(key, { png: cap.png, mask: cap.maskBits }, store);
          restored = true;
        }
        if (cmp.status !== 'ok') {
          await writeFile(path.join(outDir, `${id}@${dpr}x.png`), cap.png);
          await writeFile(path.join(outDir, `${id}@${dpr}x.mask`), cap.maskBits);
        }
        out.push({ id, dpr, key, cap, cmp, restored, reportOnly: state.reportOnly });
        const tag = cmp.status === 'ok' ? 'ok' : cmp.status === 'missing' ? 'MISSING (not blessed under these inputs)' : `DRIFT (${cmp.diffs.join(', ')})`;
        console.log(`  ${id.padEnd(4)} @${dpr}x  png ${cap.pngSha256.slice(0, 10)}  mask ${cap.maskSha256.slice(0, 10)}  ${tag}${state.reportOnly ? ' [report-only]' : ''}`);
      }
    }
    return out;
  });

  const gating = results.filter((r) => !r.reportOnly);
  const bad = gating.filter((r) => r.cmp.status !== 'ok');
  const warn = results.filter((r) => r.reportOnly && r.cmp.status !== 'ok');
  await writeFile(
    path.join(outDir, 'report.json'),
    `${JSON.stringify(
      results.map((r) => ({
        state: r.id,
        dpr: r.dpr,
        key: r.key,
        status: r.cmp.status,
        diffs: r.cmp.diffs,
        reportOnly: r.reportOnly,
        pngSha256: r.cap.pngSha256,
        maskSha256: r.cap.maskSha256,
        popcount: r.cap.popcount,
        bbox: r.cap.bbox,
      })),
      null,
      2,
    )}\n`,
  );
  console.log(maskReport(results.map((r) => ({ ...r.cap, state: r.id }))));
  const restored = results.filter((r) => r.restored).length;
  if (restored) console.log(`restored ${restored} local golden(s) in ${store}`);
  if (warn.length) console.log(`report-only: ${warn.map((r) => `${r.id}@${r.dpr}x`).join(', ')} differ from the manifest (not a failure)`);
  console.log(`output: ${outDir}`);
  if (bad.length) {
    console.error(`FAIL: oracle drift or missing goldens in ${bad.map((r) => `${r.id}@${r.dpr}x`).join(', ')}`);
    return EXIT.FAIL;
  }
  console.log(`PASS: ${gating.length} capture(s) match the manifest`);
  return EXIT.PASS;
}
