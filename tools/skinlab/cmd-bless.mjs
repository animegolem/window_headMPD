// bless --target legacy --reason "..." [--states S1,S2] [--dpr 1,2] [--repin]
// bless --target legacy --from-tag <tag> --verify-only [--states S1,S2] [--dpr 1,2]
// bless --target legacy --from-tag <tag> --reason "..." [--states S1,S2] [--dpr 1,2] [--repin]
//
// The only way to change goldens.manifest.json. Implementing tasks run it once to prove the capture
// works; Opus blesses at the gates (E D9). Each capture is taken twice and must repeat exactly
// before anything is written.
//
// --from-tag (E D9, after cutover): the legacy hand port may no longer be in the working tree, so the
// capture is taken from the tag that still holds it. A temporary `git worktree` is created at the tag
// (detached, under ~/Library/Caches/window_headmpd/skinlab/worktrees/, never inside the repo),
// `npm ci` runs there, the tag's own skinlab captures its own legacy app (its pinned files, its
// Playwright and Chromium, its harness), and the worktree is removed whatever happens. The current
// manifest is copied into the worktree first, so the tag's verdict is against the manifest we are
// verifying and not against whatever manifest the tag happened to carry.
//   --verify-only   runs the tag's `verify-legacy`, then re-checks its report against the manifest here:
//                   every capture, gating or report-only, must hash-equal its entry, and every entry in
//                   scope must have been reproduced that way (E D9, E D10.9 criterion 8). Report-only
//                   states (S5.*, S6, S7) are exempt from gating the working tree, not from this check.
//                   The manifest is never written.
//   (no --verify-only) runs the tag's `bless` with the given --reason, then copies the resulting
//                   manifest back. A tag is immutable, so an entry that keeps its key but changes its
//                   hashes is oracle drift, not a re-bless: the manifest is left alone and the command
//                   fails. New keys (another Chromium, say) are added.
// Exit codes follow skinlab: 0 pass, 1 fail, 2 usage or wrong fixture or no such tag, 77 skip.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { keyInputs, legacyKey, maskReport, parseOptions, requireLegacyTarget } from './common.mjs';
import { EXIT, fail, skip, usageError } from './exit.mjs';
import { MANIFEST_PATH, REPO_ROOT, storeRoot } from './paths.mjs';
import { oraclePin } from './pins.mjs';
import { expandStateGroups, parseDprs, parseStateIds } from './states.mjs';
import {
  BlessRefusal,
  HARNESS_VERSION,
  applyBless,
  compareToManifest,
  isSha256Hex,
  parseManifest,
  readManifest,
  saveGolden,
  serializeManifest,
  writeManifest,
} from './store.mjs';

const execFileP = promisify(execFile);

/** Where the tag's own copy of the manifest lives, relative to the worktree. */
const MANIFEST_REL = path.join('tools', 'skinlab', 'goldens.manifest.json');

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    reason: { type: 'string' },
    states: { type: 'string' },
    dpr: { type: 'string' },
    repin: { type: 'boolean', default: false },
    'from-tag': { type: 'string' },
    'verify-only': { type: 'boolean', default: false },
  });
  requireLegacyTarget(values.target, { required: true });
  const fromTag = values['from-tag'];
  const verifyOnly = values['verify-only'];
  if (verifyOnly && fromTag === undefined) {
    throw usageError('--verify-only goes with --from-tag (for the working tree, use: npm run skinlab -- verify-legacy)');
  }
  if (verifyOnly && values.repin) throw usageError('--verify-only changes nothing, so --repin has no meaning with it');
  if (!verifyOnly && (!values.reason || !values.reason.trim())) {
    throw usageError('--reason "..." is required: the manifest records why the oracle changed');
  }
  if (fromTag !== undefined) {
    checkTagName(fromTag);
    return blessFromTag({ tag: fromTag, verifyOnly, reason: values.reason, states: values.states, dpr: values.dpr, repin: values.repin });
  }
  return blessWorkingTree(values);
}

// ---- the working tree ---------------------------------------------------------------------------------

async function blessWorkingTree(values) {
  // Loaded here, not at the top, so --from-tag never needs the working tree's own capture code.
  const { captureState, stateById, withLegacySession } = await import('./capture.mjs');
  const { prepare } = await import('./cmd-prepare.mjs');

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

// ---- --from-tag: process environment ---------------------------------------------------------------

/** git variables that would point a nested git at some other repository than the one we name. */
const GIT_REDIRECTS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

/**
 * The environment for every process this command starts. Under `npm run`, npm exports
 * `npm_config_local_prefix` (this checkout) and friends; a nested `npm ci` that believed them could
 * reinstall node_modules in the live tree instead of the worktree. Nothing npm or git set for us steers
 * what we start.
 */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith('npm_') || k === 'INIT_CWD' || GIT_REDIRECTS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// No repository hook (husky and the like) runs for the checkout or the removal of a scratch worktree.
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null'];

/** Run git in `repoRoot`. Resolves with the exit code instead of throwing on a non-zero exit. */
async function git(repoRoot, args) {
  try {
    const { stdout, stderr } = await execFileP('git', [...GIT_SAFE, '-C', repoRoot, ...args], { env: cleanEnv(), maxBuffer: 1 << 24 });
    return { code: 0, stdout: stdout.trim(), stderr };
  } catch (e) {
    if (e && e.code === 'ENOENT') throw fail('git was not found on PATH');
    if (e && typeof e.code === 'number') return { code: e.code, stdout: String(e.stdout ?? '').trim(), stderr: String(e.stderr ?? '') };
    throw e;
  }
}

// ---- --from-tag: the tag ------------------------------------------------------------------------------

/** The cheap checks, before anything slow starts. */
export function checkTagName(tag) {
  if (typeof tag !== 'string' || tag.trim() === '') throw usageError('--from-tag needs a tag name');
  if (tag.startsWith('-')) throw usageError(`--from-tag "${tag}": a tag name cannot start with "-"`);
}

/**
 * The commit a tag names. Only refs/tags/ is consulted, so a branch, a revision expression or an
 * option-looking string can never be what is checked out. Annotated tags are peeled.
 * @returns {Promise<string>} the full commit id
 */
export async function resolveTag(repoRoot, tag) {
  checkTagName(tag);
  const ref = `refs/tags/${tag}`;
  const syntax = await git(repoRoot, ['check-ref-format', ref]);
  if (syntax.code !== 0) throw usageError(`--from-tag "${tag}" is not a valid tag name`);
  const rev = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (rev.code === 0 && /^[0-9a-f]{40,64}$/.test(rev.stdout)) return rev.stdout;
  if ((await git(repoRoot, ['rev-parse', '--git-dir'])).code !== 0) throw fail(`${repoRoot} is not a git checkout, which --from-tag needs`);
  throw usageError(`tag "${tag}" does not exist (or does not point at a commit); see: git tag -l`);
}

// ---- --from-tag: the temporary worktree ---------------------------------------------------------------

const isInside = (base, p) => {
  const rel = path.relative(base, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Remove a scratch worktree: git first (it forgets the registration), then the directory, then prune. Never throws. */
function removeWorktreeSync(repoRoot, base, dir) {
  if (!isInside(base, dir)) throw new Error(`refusing to remove ${dir}: it is not under ${base}`);
  const run = (args) => {
    try {
      execFileSync('git', [...GIT_SAFE, '-C', repoRoot, ...args], { stdio: 'ignore', env: cleanEnv() });
    } catch {
      // The directory removal below and the prune after it do the same job without git's help.
    }
  };
  run(['worktree', 'remove', '--force', dir]);
  rmSync(dir, { recursive: true, force: true });
  run(['worktree', 'prune']);
}

let activeChild = null;

/**
 * `npm ci` in the worktree. `--prefix` plus the cleaned environment keep it from ever touching the
 * live tree's node_modules, and the guard refuses any directory that is not a scratch worktree.
 */
export async function installDeps(dir, { base, repoRoot, log = () => {}, exec = execFileP, timeoutMs = 10 * 60_000 }) {
  if (!isInside(base, dir) || path.resolve(dir) === path.resolve(repoRoot)) {
    throw new Error(`refusing to run npm ci in ${dir}: not a scratch worktree under ${base}`);
  }
  const started = Date.now();
  log(`npm ci in the worktree (this can take a minute) ...`);
  try {
    await exec('npm', ['ci', '--prefix', dir, '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: dir,
      env: cleanEnv(),
      maxBuffer: 1 << 26,
      timeout: timeoutMs,
    });
  } catch (e) {
    if (e && e.code === 'ENOENT') throw fail('npm was not found on PATH');
    const tail = String(e?.stderr || e?.message || e).trim().split('\n').slice(-12).join('\n');
    throw fail(`npm ci failed in the tag's worktree:\n${tail}`);
  }
  log(`npm ci: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/**
 * Check `commit` out into a fresh detached worktree under `base`, run `install` and then `fn({dir,
 * commit})`, and remove the worktree afterwards: on success, on any throw, and on SIGINT/SIGTERM.
 */
export async function withTagWorktree({ repoRoot, tag, commit, base, install, log = () => {} }, fn) {
  await mkdir(base, { recursive: true });
  const realBase = realpathSync(base); // a symlinked parent (macOS /tmp) makes npm treat the project as a link
  const slug = String(tag).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
  const dir = await mkdtemp(path.join(realBase, `${slug}-`));
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    removeWorktreeSync(repoRoot, realBase, dir);
  };
  const onSignal = (signal) => {
    activeChild?.kill('SIGTERM');
    remove();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const added = await git(repoRoot, ['worktree', 'add', '--detach', dir, commit]);
    if (added.code !== 0) throw fail(`git worktree add failed: ${added.stderr.trim()}`);
    log(`worktree: ${dir} (detached at ${commit.slice(0, 12)})`);
    await install(dir);
    return await fn({ dir, commit });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    remove();
    if (existsSync(dir)) {
      console.error(`warning: could not remove ${dir}; remove it by hand, then: git -C ${repoRoot} worktree prune`);
    } else {
      log('worktree removed');
    }
  }
}

// ---- --from-tag: running the tag's skinlab -------------------------------------------------------------

/**
 * Run `node <args>` in the worktree with the output streamed (a capture run is minutes long) and
 * also collected.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runNode(dir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      activeChild = null;
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

/** What a non-zero exit of the tag's skinlab means for us (its own message is already on screen). */
export function childFailure(what, { code, stderr }) {
  const last = String(stderr).trim().split('\n').pop() ?? '';
  const why = last ? `: ${last}` : '';
  if (code === EXIT.SKIP) return skip(`${what} skipped (exit 77)${why}`);
  if (code === EXIT.USAGE) return usageError(`${what} refused (exit 2)${why}`);
  return fail(`${what} failed (exit ${code})${why}`);
}

/**
 * `--states`/`--dpr` as the tag will read them, split only far enough to scope the coverage check.
 * A group name (`S5`) is expanded to its members, as a tag whose skinlab accepts the group would do,
 * so the coverage scope here matches what that tag captures. The tag still gets the text as typed.
 */
export function parseFilter(states, dpr) {
  const list = (s, what) => {
    if (s === undefined || s === '') return null;
    const out = String(s).split(',').map((x) => x.trim()).filter(Boolean);
    if (!out.length) throw usageError(`${what} is empty`);
    return out;
  };
  const dprs = list(dpr, '--dpr')?.map((x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) throw usageError(`unsupported dpr "${x}"`);
    return n;
  });
  const named = list(states, '--states');
  return { states: named && expandStateGroups(named), dprs: dprs ?? null };
}

const filterArgs = ({ states, dpr }) => [...(states ? ['--states', states] : []), ...(dpr ? ['--dpr', dpr] : [])];

/**
 * Check the tag's verify-legacy report against the manifest here. Independent of the tag's own
 * verdict: the report's keys already encode the pin, Chromium, harness version and fixture, so a
 * mismatch of any of them shows as "missing"; a same-key hash difference is drift. Every capture,
 * gating or report-only, must hash-equal its entry (E D9: "the result must hash-equal the manifest";
 * E D10.9 criterion 8): `reportOnly` only keeps a state from gating the working tree, and a
 * regeneration from the tag is the check that holds it to its hash. Every legacy entry in scope must
 * also have been reproduced, which counts only a capture that hash-equals its entry, so `covered` is
 * the number of entries actually reproduced. A scope that matches no entry fails: nothing was verified.
 * @param {{entries: Map<string, object>}} manifest
 * @param {object[]} rows the tag's report.json
 * @param {{states: string[]|null, dprs: number[]|null}} [filter] the --states/--dpr in force
 * @returns {{ok: boolean, failures: string[], warnings: string[], expected: number, covered: number}}
 *   `warnings` is empty today (nothing in the check is advisory); it stays so the caller's shape holds.
 */
export function compareReportToManifest(manifest, rows, filter = { states: null, dprs: null }) {
  const failures = [];
  const warnings = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, failures: ['the tag captured nothing (its report is empty)'], warnings, expected: 0, covered: 0 };
  }
  // `judged`: keys of every well-formed row, so an entry whose row drifted is reported once (as drift)
  // and not again as absent. `reproduced`: the subset that hash-equals its entry, the only rows that
  // cover an entry.
  const judged = new Set();
  const reproduced = new Set();
  for (const r of rows) {
    const at = `${r?.state}@${r?.dpr}x`;
    if (!r || typeof r.state !== 'string' || !Number.isInteger(r.dpr) || !isSha256Hex(r.key) || !isSha256Hex(r.pngSha256) || !isSha256Hex(r.maskSha256)) {
      failures.push(`${at}: malformed report row`);
      continue;
    }
    judged.add(r.key);
    const cmp = compareToManifest(manifest, r);
    if (cmp.status === 'ok') {
      reproduced.add(r.key);
      continue;
    }
    const what =
      cmp.status === 'missing'
        ? 'is not in the manifest under these inputs (the tag\'s oracle pin, Chromium, harness version or fixture differ from the manifest\'s)'
        : `differs from the manifest (${cmp.diffs.join(', ')})`;
    failures.push(`${at} ${what}${r.reportOnly === true ? '; a report-only state, but a regeneration must reproduce it too' : ''}`);
  }
  let expected = 0;
  let covered = 0;
  for (const [key, e] of manifest.entries) {
    const p = e.provenance;
    if (p.target !== 'legacy') continue;
    if (filter.states && !filter.states.includes(p.state)) continue;
    if (filter.dprs && !filter.dprs.includes(p.dpr)) continue;
    expected++;
    if (reproduced.has(key)) covered++;
    else if (!judged.has(key)) failures.push(`${p.state}@${p.dpr}x: a manifest entry the tag did not reproduce`);
  }
  if (expected === 0) failures.push('no legacy manifest entry is in scope (--states/--dpr match none), so nothing was verified');
  return { ok: failures.length === 0, failures, warnings, expected, covered };
}

/** How `after` differs from `before`, by key. `rewritten` is the same key with other hashes. */
export function diffManifests(before, after) {
  const out = { added: [], removed: [], rewritten: [], unchanged: [] };
  for (const [k, e] of after.entries) {
    const old = before.entries.get(k);
    if (!old) out.added.push(k);
    else if (old.pngSha256 !== e.pngSha256 || old.maskSha256 !== e.maskSha256) out.rewritten.push(k);
    else out.unchanged.push(k);
  }
  for (const k of before.entries.keys()) if (!after.entries.has(k)) out.removed.push(k);
  return out;
}

async function readReport(stdout) {
  const dirs = [...String(stdout).matchAll(/^output: (.+)$/gm)];
  if (!dirs.length) throw fail("the tag's verify-legacy printed no output directory, so its report.json cannot be read");
  const file = path.join(dirs[dirs.length - 1][1].trim(), 'report.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    throw fail(`cannot read the tag's report ${file}: ${e.message}`);
  }
}

// ---- --from-tag: the command ------------------------------------------------------------------------

/**
 * @param {{tag:string, verifyOnly:boolean, reason?:string, states?:string, dpr?:string, repin?:boolean}} opts
 * @param {object} [deps] test seams: repoRoot, manifestPath, base, install, runChild, log
 */
export async function blessFromTag({ tag, verifyOnly, reason, states, dpr, repin = false }, deps = {}) {
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const manifestPath = deps.manifestPath ?? MANIFEST_PATH;
  const base = deps.base ?? path.join(storeRoot(), 'worktrees');
  const log = deps.log ?? console.log;
  const runChild = deps.runChild ?? runNode;
  const install = deps.install ?? ((dir) => installDeps(dir, { base: realpathSync(base), repoRoot, log }));
  const filter = parseFilter(states, dpr);
  if (!verifyOnly && (!reason || !reason.trim())) throw usageError('--reason "..." is required: the manifest records why the oracle changed');

  const manifest = await readManifest(manifestPath);
  if (verifyOnly && !manifest.entries.size) {
    throw fail('nothing to verify: the manifest has no goldens (run: npm run skinlab -- bless --target legacy --reason "...")');
  }
  const commit = await resolveTag(repoRoot, tag);
  log(`from-tag: ${tag} -> ${commit.slice(0, 12)}`);
  await mkdir(base, { recursive: true });

  const verdict = await withTagWorktree({ repoRoot, tag, commit, base, install, log }, async ({ dir }) => {
    const command = verifyOnly ? 'verify-legacy' : 'bless';
    if (!existsSync(path.join(dir, 'tools', 'skinlab', 'run.mjs')) || !existsSync(path.join(dir, 'tools', 'skinlab', `cmd-${command}.mjs`))) {
      throw usageError(`tag "${tag}" has no tools/skinlab ${command}: it predates the skinlab harness, so it cannot capture the legacy oracle`);
    }
    // The tag judges against the manifest we are verifying, not the one it carried.
    if (existsSync(manifestPath)) await copyFile(manifestPath, path.join(dir, MANIFEST_REL));
    else await rm(path.join(dir, MANIFEST_REL), { force: true });

    const run = ['tools/skinlab/run.mjs', command, '--target', 'legacy', ...filterArgs({ states, dpr })];
    if (verifyOnly) {
      const res = await runChild(dir, run);
      if (res.code !== 0) throw childFailure("the tag's verify-legacy", res);
      const v = compareReportToManifest(manifest, await readReport(res.stdout), filter);
      return {
        failures: v.failures,
        warnings: v.warnings,
        summary: `tag ${tag} (${commit.slice(0, 12)}) reproduces ${v.covered}/${v.expected} manifest entries`,
      };
    }
    run.push('--reason', reason, ...(repin ? ['--repin'] : []));
    const res = await runChild(dir, run);
    if (res.code !== 0) throw childFailure("the tag's bless", res);
    return adoptTagManifest({ dir, manifest, manifestPath, tag, commit, log });
  });

  for (const w of verdict.warnings) console.log(`warning (report-only): ${w}`);
  if (verdict.failures.length) {
    for (const f of verdict.failures) console.error(`  ${f}`);
    console.error(`FAIL: ${verifyOnly ? 'the tag does not reproduce the manifest' : 'refusing to take the tag\'s manifest'} (${verdict.failures.length} problem${verdict.failures.length === 1 ? '' : 's'})`);
    return EXIT.FAIL;
  }
  console.log(`PASS: ${verdict.summary}`);
  return EXIT.PASS;
}

/**
 * After the tag's bless: take its manifest back, unless a key that was already blessed now carries
 * other hashes (drift, which a tag must never produce). New keys are stamped with the tag they came from.
 */
async function adoptTagManifest({ dir, manifest, manifestPath, tag, commit, log }) {
  let next;
  try {
    next = parseManifest(await readFile(path.join(dir, MANIFEST_REL), 'utf8'));
  } catch (e) {
    throw fail(`the tag's bless left an unreadable manifest: ${e.message}`);
  }
  const d = diffManifests(manifest, next);
  if (d.rewritten.length) {
    const named = d.rewritten.map((k) => {
      const p = next.entries.get(k).provenance;
      return `${p.state}@${p.dpr}x: the tag's capture hashes differently under the same key`;
    });
    return {
      failures: [
        ...named,
        'the manifest was left as it was; the local golden store may hold these drifted captures under their keys, which fail the manifest check and are re-captured on demand',
      ],
      warnings: [],
      summary: '',
    };
  }
  for (const k of d.added) {
    const e = next.entries.get(k);
    e.provenance = { ...e.provenance, blessedFromTag: { tag, commit } };
  }
  const changed = serializeManifest(next) !== serializeManifest(manifest);
  if (changed) await writeManifest(manifestPath, next);
  log(`manifest: ${d.added.length} added, ${d.removed.length} removed, ${d.unchanged.length} unchanged${changed ? '' : ' (file untouched)'}`);
  return {
    failures: [],
    warnings: [],
    summary: `blessed from tag ${tag} (${commit.slice(0, 12)}): manifest has ${next.entries.size} entries`,
  };
}
