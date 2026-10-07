// bless --target legacy --reason "..." [--states S1,S2] [--dpr 1,2] [--repin]
// The only way to change goldens.manifest.json. Implementing tasks run it once to prove the capture
// works; Opus blesses at the gates (E D9). Each capture is taken twice and must repeat exactly
// before anything is written.

import { captureState, stateById, withLegacySession } from './capture.mjs';
import { keyInputs, legacyKey, maskReport, parseOptions, requireLegacyTarget } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { EXIT, fail, usageError } from './exit.mjs';
import { MANIFEST_PATH, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';
import { parseDprs, parseStateIds } from './states.mjs';
import { BlessRefusal, HARNESS_VERSION, applyBless, readManifest, saveGolden, writeManifest } from './store.mjs';

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    reason: { type: 'string' },
    states: { type: 'string' },
    dpr: { type: 'string' },
    repin: { type: 'boolean', default: false },
  });
  requireLegacyTarget(values.target, { required: true });
  if (!values.reason || !values.reason.trim()) throw usageError('--reason "..." is required: the manifest records why the oracle changed');
  let ids;
  let dprs;
  try {
    ids = parseStateIds(values.states);
    dprs = parseDprs(values.dpr);
  } catch (e) {
    throw usageError(e.message);
  }

  const { fixture } = await prepare();
  const pin = await oraclePin();
  const manifest = await readManifest(MANIFEST_PATH);
  if (manifest.oraclePin !== null && manifest.oraclePin !== pin && !values.repin) {
    throw usageError(
      `refusing to bless: the oracle pin changed (manifest ${manifest.oraclePin.slice(0, 12)}, now ${pin.slice(0, 12)}), ` +
        'so a pinned file differs from the one the goldens describe. Re-run with --repin if that was intended.',
    );
  }

  const { captures, chromium } = await withLegacySession(async ({ baseUrl, browser, chromium }) => {
    const inputs = await keyInputs({ fixture, chromium });
    const out = [];
    for (const id of ids) {
      for (const dpr of dprs) {
        const state = stateById(id);
        const a = await captureState(browser, baseUrl, state, dpr);
        const b = await captureState(browser, baseUrl, state, dpr);
        if (a.pngSha256 !== b.pngSha256 || a.maskSha256 !== b.maskSha256) {
          throw fail(
            `${id} @${dpr}x is not deterministic (png ${a.pngSha256.slice(0, 10)} vs ${b.pngSha256.slice(0, 10)}, ` +
              `mask ${a.maskSha256.slice(0, 10)} vs ${b.maskSha256.slice(0, 10)}); nothing was blessed`,
          );
        }
        out.push({ ...a, target: 'legacy', key: legacyKey(inputs, id, dpr) });
        console.log(`  ${id.padEnd(4)} @${dpr}x  png ${a.pngSha256.slice(0, 10)}  mask ${a.maskSha256.slice(0, 10)}  popcount ${a.popcount}`);
      }
    }
    return { captures: out, chromium };
  });

  let result;
  try {
    result = applyBless(manifest, captures, {
      reason: values.reason,
      oraclePin: pin,
      repin: values.repin,
      extra: {
        skinSha256: fixture.sha256,
        chromiumRevision: chromium.revision,
        browserVersion: chromium.browserVersion,
        playwrightVersion: chromium.playwrightVersion,
        harnessVersion: HARNESS_VERSION,
      },
    });
  } catch (e) {
    if (e instanceof BlessRefusal) throw usageError(e.message);
    throw e;
  }

  const store = storeRoot();
  for (const c of captures) await saveGolden(c.key, { png: c.png, mask: c.maskBits }, store);
  await writeManifest(MANIFEST_PATH, result.manifest);

  for (const ch of result.changes) {
    console.log(`  ${ch.action.padEnd(9)} ${ch.state} @${ch.dpr}x${ch.previous ? `  (was png ${ch.previous.pngSha256.slice(0, 10)} mask ${ch.previous.maskSha256.slice(0, 10)})` : ''}`);
  }
  if (result.dropped) console.log(`dropped ${result.dropped} entr${result.dropped === 1 ? 'y' : 'ies'} blessed under an older oracle pin`);
  console.log(maskReport(captures));
  console.log(`goldens: ${store}/goldens`);
  console.log(`manifest: ${MANIFEST_PATH} (${result.manifest.entries.size} entries)`);
  return EXIT.PASS;
}
