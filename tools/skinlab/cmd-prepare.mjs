// prepare: check the fixture, regenerate public/skin/ when stale, report the pinned Chromium.
// Exits 77 when the fixture or Chromium is missing, 2 for a wrong fixture.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromiumInfo } from './capture.mjs';
import { parseOptions } from './common.mjs';
import { fail, skip, usageError } from './exit.mjs';
import { HEADSPACE_SHA1, REPO_ROOT, checkFixture, storeRoot } from './paths.mjs';
import { canonicalJson } from './store.mjs';

const run = promisify(execFile);

/**
 * Fixture check, then python3 -I tools/convert_skin.py into public/skin/ when its stamp is stale.
 * The stamp lives in the golden store (not in the repo), keyed by this checkout's path, because
 * several worktrees share one cache and each has its own public/skin/.
 * @returns {Promise<{fixture: object, converted: boolean}>}
 */
export async function prepare({ log = console.log } = {}) {
  const fixture = await checkFixture();
  if (fixture.status === 'absent') throw skip(`fixture not found: ${fixture.path} (set SKINLAB_HEADSPACE to your Headspace.wmz)`);
  if (fixture.status === 'badsha') {
    throw usageError(`wrong fixture: ${fixture.path} has sha1 ${fixture.sha1}, expected ${HEADSPACE_SHA1}`);
  }
  log(`fixture: ${fixture.path} (sha1 ${fixture.sha1.slice(0, 8)}…)`);

  const converter = path.join(REPO_ROOT, 'tools', 'convert_skin.py');
  const want = canonicalJson({
    skinSha256: fixture.sha256,
    converterSha256: createHash('sha256').update(await readFile(converter)).digest('hex'),
  });
  const stampFile = path.join(storeRoot(), `prepare-${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12)}.json`);
  let have = null;
  try {
    have = JSON.parse(await readFile(stampFile, 'utf8')).want;
  } catch {
    // no stamp yet
  }
  const fresh = have === want && existsSync(path.join(REPO_ROOT, 'public', 'skin', 'head.png'));
  if (fresh) {
    log('legacy skin: public/skin is up to date');
    return { fixture, converted: false };
  }
  let result;
  try {
    result = await run('python3', ['-I', converter, fixture.path], { cwd: REPO_ROOT });
  } catch (e) {
    throw fail(`convert_skin.py failed: ${e.stderr || e.message}`);
  }
  await mkdir(path.dirname(stampFile), { recursive: true });
  await writeFile(stampFile, `${JSON.stringify({ want })}\n`);
  log(`legacy skin: regenerated (${result.stdout.trim().split('\n')[0]})`);
  return { fixture, converted: true };
}

export default async function main(argv) {
  parseOptions(argv, {});
  await prepare();
  const c = chromiumInfo();
  console.log(`chromium: playwright-core ${c.playwrightVersion} wants revision ${c.revision} (${c.expectedVersion})`);
  if (!c.installed) throw skip(`Chromium ${c.revision} is not installed (run: npx playwright-core install chromium)`);
  console.log(`          installed at ${c.executablePath}`);
  return 0;
}
