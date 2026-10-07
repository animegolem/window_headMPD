// W5.5: bless --from-tag. Everything here runs in Node against throwaway git repositories and
// synthetic manifests: no browser, no art, no npm. The real thing (npm ci, 42 Chromium captures against
// the real manifest) is the acceptance command itself:
//   git tag skinlab-selftest && npm run skinlab -- bless --target legacy --from-tag skinlab-selftest --verify-only

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import main, {
  blessFromTag,
  checkTagName,
  childFailure,
  cleanEnv,
  compareReportToManifest,
  diffManifests,
  installDeps,
  parseFilter,
  resolveTag,
  withTagWorktree,
} from '../../tools/skinlab/cmd-bless.mjs';
import { EXIT, ExitError } from '../../tools/skinlab/exit.mjs';
import { S5_STATE_IDS } from '../../tools/skinlab/states.mjs';
import { applyBless, emptyManifest, goldenKey, parseManifest, serializeManifest, writeManifest } from '../../tools/skinlab/store.mjs';

// ---- helpers ----------------------------------------------------------------------------------------

const hex = (c) => c.repeat(64);
const PIN = hex('a');
const MANIFEST_REL = 'tools/skinlab/goldens.manifest.json';

const exitCode = async (argv) => {
  try {
    await main(argv);
    return EXIT.PASS;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
};

/** git for the fixtures: no user config, no signing, no hooks, no inherited repository. */
function git(cwd, ...args) {
  return gitIn(cwd, undefined, ...args);
}

function gitIn(cwd, input, ...args) {
  return execFileSync('git', ['-c', 'user.name=skinlab-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    input,
    env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

/** A repository with a tagged first commit and a later commit that changes the tagged file. */
async function makeRepo(dir) {
  git(dir, 'init', '-q');
  await mkdir(path.join(dir, 'tools', 'skinlab'), { recursive: true });
  for (const f of ['run.mjs', 'cmd-verify-legacy.mjs', 'cmd-bless.mjs']) await writeFile(path.join(dir, 'tools', 'skinlab', f), `// stub ${f}\n`);
  await writeFile(path.join(dir, 'src.txt'), 'at the tag\n');
  await writeFile(path.join(dir, MANIFEST_REL), '{"the": "manifest the tag carried"}\n'); // not valid, and never to be read
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  const tagged = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', 'skinlab-selftest');
  git(dir, 'tag', '-a', '-m', 'annotated', 'oracle/headspace-v1');
  await writeFile(path.join(dir, 'src.txt'), 'after the tag\n');
  git(dir, 'commit', '-q', '-am', 'two');
  git(dir, 'branch', 'not-a-tag');
  // A tag whose commit has an empty tree: it predates tools/skinlab altogether.
  const emptyTree = gitIn(dir, '', 'hash-object', '-t', 'tree', '-w', '--stdin');
  git(dir, 'tag', 'bare-tag', git(dir, 'commit-tree', emptyTree, '-m', 'bare'));
  return { tagged, head: git(dir, 'rev-parse', 'HEAD') };
}

const worktrees = (repo) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));

let tmp;
let repo;
let base;
let ids;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skinlab-from-tag-')));
  repo = path.join(tmp, 'repo');
  base = path.join(tmp, 'worktrees');
  await mkdir(repo);
  ids = await makeRepo(repo);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

// ---- options ------------------------------------------------------------------------------------------

describe('bless option validation', () => {
  it('--verify-only needs --from-tag', async () => {
    expect(await exitCode(['--target', 'legacy', '--verify-only'])).toBe(EXIT.USAGE);
  });

  it('--from-tag without --verify-only needs a --reason, as any bless does', async () => {
    expect(await exitCode(['--target', 'legacy', '--from-tag', 'skinlab-selftest'])).toBe(EXIT.USAGE);
    expect(await exitCode(['--target', 'legacy', '--from-tag', 'skinlab-selftest', '--reason', '  '])).toBe(EXIT.USAGE);
  });

  it('--verify-only writes nothing, so --repin contradicts it', async () => {
    expect(await exitCode(['--target', 'legacy', '--from-tag', 'x', '--verify-only', '--repin'])).toBe(EXIT.USAGE);
  });

  it('rejects an empty tag, a tag that looks like an option, and a missing value', async () => {
    expect(await exitCode(['--target', 'legacy', '--from-tag', '', '--verify-only'])).toBe(EXIT.USAGE);
    expect(await exitCode(['--target', 'legacy', '--from-tag', '--upload-pack=x', '--verify-only'])).toBe(EXIT.USAGE);
    expect(await exitCode(['--target', 'legacy', '--from-tag'])).toBe(EXIT.USAGE);
  });

  it('keeps refusing --target engine', async () => {
    expect(await exitCode(['--target', 'engine', '--from-tag', 'x', '--verify-only'])).toBe(EXIT.USAGE);
  });
});

describe('parseFilter', () => {
  it('splits --states and --dpr, and treats absent or empty as everything', () => {
    expect(parseFilter(undefined, undefined)).toEqual({ states: null, dprs: null });
    expect(parseFilter('', '')).toEqual({ states: null, dprs: null });
    expect(parseFilter('S1, S2b', '2,1')).toEqual({ states: ['S1', 'S2b'], dprs: [2, 1] });
  });

  it('expands a state group (S5) to its members, so the coverage scope matches what a tag captures', () => {
    expect(parseFilter('S5', undefined).states).toEqual(S5_STATE_IDS);
    expect(parseFilter('S1,S5', undefined).states).toEqual(['S1', ...S5_STATE_IDS]);
    expect(parseFilter('__proto__,constructor', undefined).states).toEqual(['__proto__', 'constructor']);
  });

  it('refuses an empty list and a dpr that is not a number', () => {
    expect(() => parseFilter(',', undefined)).toThrow(ExitError);
    expect(() => parseFilter(undefined, 'two')).toThrow(ExitError);
  });
});

// ---- the tag -------------------------------------------------------------------------------------------

describe('resolveTag', () => {
  it('resolves a lightweight tag to its commit, not to HEAD', async () => {
    expect(await resolveTag(repo, 'skinlab-selftest')).toBe(ids.tagged);
    expect(ids.tagged).not.toBe(ids.head);
  });

  it('peels an annotated tag with a slash in its name to the commit', async () => {
    expect(await resolveTag(repo, 'oracle/headspace-v1')).toBe(ids.tagged);
  });

  it('refuses what is not a tag: a branch, HEAD, a revision, a missing name', async () => {
    for (const name of ['not-a-tag', 'HEAD', 'HEAD~1', ids.head, 'nope', 'constructor', '__proto__']) {
      await expect(resolveTag(repo, name), name).rejects.toMatchObject({ code: EXIT.USAGE });
    }
  });

  it('refuses names that are not valid refs, before git is asked about a revision', async () => {
    for (const name of ['', '   ', '-x', 'a b', 'a..b', 'a:b', 'a~1', 'a\\b', 'a/']) {
      await expect(resolveTag(repo, name), JSON.stringify(name)).rejects.toMatchObject({ code: EXIT.USAGE });
    }
    expect(() => checkTagName('-x')).toThrow(ExitError);
    expect(() => checkTagName(undefined)).toThrow(ExitError);
  });

  it('says so when the directory is not a git checkout at all', async () => {
    const plain = path.join(tmp, 'plain');
    await mkdir(plain);
    await expect(resolveTag(plain, 'skinlab-selftest')).rejects.toMatchObject({ code: EXIT.FAIL, message: expect.stringContaining('not a git checkout') });
  });
});

// ---- the worktree --------------------------------------------------------------------------------------

describe('withTagWorktree', () => {
  const run = (fn, extra = {}) => withTagWorktree({ repoRoot: repo, tag: 'skinlab-selftest', commit: ids.tagged, base, install: async () => {}, log: () => {}, ...extra }, fn);

  it('checks the tagged commit out outside the repository, with the tag\'s content, and removes it afterwards', async () => {
    const branchesBefore = git(repo, 'branch', '--list');
    let seen;
    const out = await run(async ({ dir, commit }) => {
      seen = { dir, commit, text: await readFile(path.join(dir, 'src.txt'), 'utf8'), head: git(dir, 'rev-parse', 'HEAD'), listed: worktrees(repo) };
      return 'result';
    });
    expect(out).toBe('result');
    expect(seen.commit).toBe(ids.tagged);
    expect(seen.text).toBe('at the tag\n'); // the tag's content, not HEAD's
    expect(seen.head).toBe(ids.tagged);
    expect(path.relative(repo, seen.dir).startsWith('..')).toBe(true);
    expect(path.relative(base, seen.dir).startsWith('..')).toBe(false);
    expect(seen.listed).toContain(seen.dir);
    expect(existsSync(seen.dir)).toBe(false);
    expect(worktrees(repo)).toEqual([repo]);
    expect(git(repo, 'branch', '--list')).toBe(branchesBefore);
    expect(await readFile(path.join(repo, 'src.txt'), 'utf8')).toBe('after the tag\n');
  });

  it('leaves the checkout on a detached HEAD', async () => {
    await run(async ({ dir }) => {
      expect(() => execFileSync('git', ['-C', dir, 'symbolic-ref', '-q', 'HEAD'], { stdio: 'ignore', env: cleanEnv() })).toThrow();
    });
  });

  it('removes the worktree when the callback throws, with the error intact', async () => {
    let dir;
    await expect(
      run(async (w) => {
        dir = w.dir;
        throw new Error('capture blew up');
      }),
    ).rejects.toThrow('capture blew up');
    expect(existsSync(dir)).toBe(false);
    expect(worktrees(repo)).toEqual([repo]);
    expect(await readdir(base)).toEqual([]);
  });

  it('removes the worktree when the install fails, even with untracked files in it', async () => {
    let dir;
    await expect(
      run(async () => {}, {
        install: async (d) => {
          dir = d;
          await mkdir(path.join(d, 'node_modules', 'x'), { recursive: true });
          await writeFile(path.join(d, 'node_modules', 'x', 'index.js'), '');
          throw new Error('npm ci failed');
        },
      }),
    ).rejects.toThrow('npm ci failed');
    expect(existsSync(dir)).toBe(false);
    expect(worktrees(repo)).toEqual([repo]);
  });

  it('cleans up the empty directory when git itself refuses', async () => {
    await expect(run(async () => {}, { commit: hex('0').slice(0, 40) })).rejects.toMatchObject({ code: EXIT.FAIL });
    expect(await readdir(base)).toEqual([]);
    expect(worktrees(repo)).toEqual([repo]);
  });

  it('gives every run its own directory and leaves no signal handlers behind', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const dirs = [];
    await run(async ({ dir }) => dirs.push(dir));
    await run(async ({ dir }) => dirs.push(dir));
    expect(new Set(dirs).size).toBe(2);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('installDeps', () => {
  const calls = () => {
    const seen = [];
    return { seen, exec: async (...a) => void seen.push(a) };
  };

  it('runs npm ci with an explicit --prefix, in the worktree, with npm and git variables removed', async () => {
    const { seen, exec } = calls();
    const dir = path.join(base, 'wt');
    await installDeps(dir, { base, repoRoot: repo, exec });
    expect(seen).toHaveLength(1);
    const [cmd, args, opts] = seen[0];
    expect(cmd).toBe('npm');
    expect(args.slice(0, 3)).toEqual(['ci', '--prefix', dir]);
    expect(opts.cwd).toBe(dir);
    expect(Object.keys(opts.env).filter((k) => k.startsWith('npm_') || k === 'INIT_CWD')).toEqual([]);
  });

  it('refuses the live checkout and anything outside the scratch directory, without running npm', async () => {
    const { seen, exec } = calls();
    await expect(installDeps(repo, { base, repoRoot: repo, exec })).rejects.toThrow(/refusing/);
    await expect(installDeps(base, { base, repoRoot: repo, exec })).rejects.toThrow(/refusing/);
    await expect(installDeps(path.join(tmp, 'elsewhere'), { base, repoRoot: repo, exec })).rejects.toThrow(/refusing/);
    expect(seen).toEqual([]);
  });

  it('turns an npm failure into a failure that shows the tail of npm\'s complaint', async () => {
    const dir = path.join(base, 'wt');
    const exec = async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'npm error code EUSAGE\nnpm error lock file out of sync\n' });
    };
    await expect(installDeps(dir, { base, repoRoot: repo, exec })).rejects.toMatchObject({ code: EXIT.FAIL, message: expect.stringContaining('lock file out of sync') });
  });
});

describe('cleanEnv', () => {
  it('drops what npm run and git hooks export, and keeps the rest', () => {
    const out = cleanEnv({
      PATH: '/usr/bin',
      HOME: '/h',
      SKINLAB_HEADSPACE: '/x.wmz',
      npm_config_local_prefix: '/live',
      npm_package_json: '/live/package.json',
      npm_lifecycle_event: 'skinlab',
      INIT_CWD: '/live',
      GIT_DIR: '/live/.git',
      GIT_WORK_TREE: '/live',
      GIT_INDEX_FILE: '/live/.git/index',
      GIT_EDITOR: 'true',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/h', SKINLAB_HEADSPACE: '/x.wmz', GIT_EDITOR: 'true' });
  });
});

describe('childFailure', () => {
  it('maps the tag\'s exit codes onto skinlab\'s', () => {
    expect(childFailure('x', { code: 77, stderr: '' }).code).toBe(EXIT.SKIP);
    expect(childFailure('x', { code: 2, stderr: 'wrong fixture' }).code).toBe(EXIT.USAGE);
    expect(childFailure('x', { code: 1, stderr: 'a\nb' }).code).toBe(EXIT.FAIL);
    expect(childFailure('x', { code: 137, stderr: '' }).code).toBe(EXIT.FAIL);
    expect(childFailure('x', { code: 1, stderr: 'a\nlast words' }).message).toContain('last words');
  });
});

// ---- the comparison ------------------------------------------------------------------------------------

const keyFor = (state, dpr, extra = {}) =>
  goldenKey({ target: 'legacy', state, dpr, skinSha256: hex('5'), oraclePin: PIN, chromiumRevision: '1243', harnessVersion: 1, ...extra });

/** A manifest of legacy entries for states x dprs; each capture's hashes derive from state and dpr. */
function makeManifest(stateIds = ['S1', 'S2'], dprs = [1, 2], extra) {
  const captures = [];
  for (const state of stateIds) {
    for (const dpr of dprs) captures.push({ key: keyFor(state, dpr, extra), target: 'legacy', state, dpr, ...hashesFor(state, dpr), popcount: 7, bbox: null });
  }
  return applyBless(emptyManifest(), captures, { reason: 'test', oraclePin: PIN, at: '2026-01-01T00:00:00.000Z' }).manifest;
}

function hashesFor(state, dpr) {
  const seed = [...`${state}@${dpr}`].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  return { pngSha256: seed.repeat(8), maskSha256: seed.split('').reverse().join('').repeat(8) };
}

/** What the tag's verify-legacy writes to report.json for a state and DPR that reproduce. */
const rowFor = (state, dpr, over = {}) => ({ state, dpr, key: keyFor(state, dpr), status: 'ok', diffs: [], reportOnly: false, ...hashesFor(state, dpr), popcount: 7, bbox: null, ...over });

describe('compareReportToManifest', () => {
  const manifest = makeManifest();
  const allRows = () => [rowFor('S1', 1), rowFor('S1', 2), rowFor('S2', 1), rowFor('S2', 2)];

  it('passes when every capture hash-equals its entry and every entry was reproduced', () => {
    const v = compareReportToManifest(manifest, allRows());
    expect(v).toMatchObject({ ok: true, failures: [], warnings: [], expected: 4, covered: 4 });
  });

  it('fails on a png or mask hash that differs under the same key (drift)', () => {
    const rows = allRows();
    rows[1] = rowFor('S1', 2, { pngSha256: hex('e') });
    rows[2] = rowFor('S2', 1, { maskSha256: hex('d') });
    const v = compareReportToManifest(manifest, rows);
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual(['S1@2x differs from the manifest (png)', 'S2@1x differs from the manifest (mask)']);
  });

  it('fails when the key is not in the manifest, which is what a different pin, Chromium or harness looks like', () => {
    const rows = allRows().map((r) => ({ ...r, key: keyFor(r.state, r.dpr, { chromiumRevision: '9999' }) }));
    const v = compareReportToManifest(manifest, rows);
    expect(v.ok).toBe(false);
    expect(v.failures.filter((f) => f.includes('not in the manifest under these inputs'))).toHaveLength(4);
    expect(v.covered).toBe(0);
  });

  it('holds a report-only state to its hash as well: a regeneration must reproduce every entry (E D9, D10.9 criterion 8)', () => {
    const rows = allRows();
    rows[3] = rowFor('S2', 2, { reportOnly: true, pngSha256: hex('e') });
    const drifted = compareReportToManifest(manifest, rows);
    expect(drifted.ok).toBe(false);
    expect(drifted.failures).toHaveLength(1); // once, as drift: not again as a missing entry
    expect(drifted.failures[0]).toContain('S2@2x');
    expect(drifted.failures[0]).toContain('(png)');
    expect(drifted).toMatchObject({ expected: 4, covered: 3 }); // the drifted row covers nothing
    // A report-only row whose mask drifted, or whose key is not in the manifest, fails the same way.
    rows[3] = rowFor('S2', 2, { reportOnly: true, maskSha256: hex('d') });
    expect(compareReportToManifest(manifest, rows)).toMatchObject({ ok: false, covered: 3 });
    rows[3] = rowFor('S2', 2, { reportOnly: true, key: keyFor('S2', 2, { chromiumRevision: '9999' }) });
    const moved = compareReportToManifest(manifest, rows);
    expect(moved.ok).toBe(false);
    expect(moved.failures.some((f) => f.startsWith('S2@2x is not in the manifest under these inputs'))).toBe(true);
    // And an entry the tag never reported still fails, report-only or not.
    const dropped = compareReportToManifest(manifest, allRows().slice(0, 3));
    expect(dropped.ok).toBe(false);
    expect(dropped.failures).toEqual(['S2@2x: a manifest entry the tag did not reproduce']);
  });

  it('does not let a drifted row count as covering its entry, report-only or gating', () => {
    for (const reportOnly of [true, false]) {
      const rows = allRows().map((r) => rowFor(r.state, r.dpr, { reportOnly, pngSha256: hex('e') }));
      expect(compareReportToManifest(manifest, rows)).toMatchObject({ ok: false, expected: 4, covered: 0 });
    }
  });

  it('fails when --states/--dpr match no manifest entry, instead of passing on 0/0', () => {
    const v = compareReportToManifest(manifest, allRows(), { states: ['S9'], dprs: null });
    expect(v).toMatchObject({ ok: false, expected: 0, covered: 0 });
    expect(v.failures).toEqual([expect.stringContaining('nothing was verified')]);
    expect(compareReportToManifest(manifest, allRows(), { states: null, dprs: [3] }).ok).toBe(false);
  });

  it('fails when the tag reproduced a subset of the manifest, unless --states/--dpr scope the check', () => {
    const rows = [rowFor('S1', 1), rowFor('S1', 2)];
    expect(compareReportToManifest(manifest, rows)).toMatchObject({ ok: false, expected: 4, covered: 2 });
    expect(compareReportToManifest(manifest, rows, { states: ['S1'], dprs: null })).toMatchObject({ ok: true, expected: 2, covered: 2 });
    expect(compareReportToManifest(manifest, [rowFor('S1', 2), rowFor('S2', 2)], { states: null, dprs: [2] })).toMatchObject({ ok: true, expected: 2, covered: 2 });
  });

  it('ignores manifest entries of other targets', () => {
    const m = makeManifest(['S1'], [1]);
    const [k, e] = [...m.entries][0];
    m.entries.set(hex('c'), { ...e, provenance: { ...e.provenance, target: 'engine' } });
    expect(k).toBeTruthy();
    expect(compareReportToManifest(m, [rowFor('S1', 1)])).toMatchObject({ ok: true, expected: 1, covered: 1 });
  });

  it('fails on an empty report and on a malformed row', () => {
    expect(compareReportToManifest(manifest, [])).toMatchObject({ ok: false });
    expect(compareReportToManifest(manifest, undefined)).toMatchObject({ ok: false });
    const rows = allRows();
    rows[0] = { ...rows[0], key: 'nope' };
    const v = compareReportToManifest(manifest, rows);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain('malformed');
  });

  it('is not confused by state ids that are names on Object.prototype', () => {
    const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const m = makeManifest(odd, [1]);
    const rows = odd.map((s) => rowFor(s, 1));
    expect(compareReportToManifest(m, rows)).toMatchObject({ ok: true, expected: 4, covered: 4 });
    expect(compareReportToManifest(m, rows, { states: ['__proto__'], dprs: null })).toMatchObject({ ok: true, expected: 1, covered: 1 });
    expect(compareReportToManifest(m, rows.slice(1), { states: null, dprs: null })).toMatchObject({ ok: false, failures: ['__proto__@1x: a manifest entry the tag did not reproduce'] });
  });
});

describe('diffManifests', () => {
  it('tells added, removed, rewritten (same key, other hashes) and unchanged apart', () => {
    const before = makeManifest(['S1', 'S2'], [1]);
    const after = { ...before, entries: new Map(before.entries) };
    const [k1, e1] = [...before.entries][0];
    const [k2] = [...before.entries][1];
    after.entries.set(k1, { ...e1, pngSha256: hex('e') });
    after.entries.delete(k2);
    after.entries.set(hex('f'), { ...e1, provenance: { ...e1.provenance, state: 'S3' } });
    expect(diffManifests(before, after)).toEqual({ added: [hex('f')], removed: [k2], rewritten: [k1], unchanged: [] });
    expect(diffManifests(before, before)).toMatchObject({ added: [], removed: [], rewritten: [], unchanged: [k1, k2] });
  });
});

// ---- blessFromTag, with the tag's skinlab replaced by a fake -----------------------------------------------

describe('blessFromTag', () => {
  let manifestPath;
  let manifest;
  let reportDir;
  let calls;

  const verifyChild = (rows, { code = 0, expectManifest } = {}) =>
    vi.fn(async (dir, args) => {
      calls.push({ dir, args });
      if (expectManifest) expect(await readFile(path.join(dir, MANIFEST_REL), 'utf8')).toBe(expectManifest);
      await writeFile(path.join(reportDir, 'report.json'), JSON.stringify(rows));
      return { code, stdout: `  S1 @1x ok\noutput: ${reportDir}\nPASS\n`, stderr: '' };
    });
  const options = (extra = {}) => ({ repoRoot: repo, manifestPath, base, install: async () => {}, log: () => {}, ...extra });
  const allRows = () => [rowFor('S1', 1), rowFor('S1', 2), rowFor('S2', 1), rowFor('S2', 2)];

  beforeEach(async () => {
    manifest = makeManifest();
    manifestPath = path.join(tmp, 'goldens.manifest.json');
    await writeManifest(manifestPath, manifest);
    reportDir = path.join(tmp, 'out');
    await mkdir(reportDir);
    calls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const manifestText = () => readFile(manifestPath, 'utf8');

  describe('--verify-only', () => {
    it('runs the tag\'s verify-legacy in a worktree holding the tag\'s files and our manifest, and passes', async () => {
      const text = await manifestText();
      const child = verifyChild(allRows(), { expectManifest: text });
      const code = await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true, states: 'S1,S2', dpr: '1,2' }, options({ runChild: child }));
      expect(code).toBe(EXIT.PASS);
      expect(child).toHaveBeenCalledTimes(1);
      const { dir, args } = calls[0];
      expect(args).toEqual(['tools/skinlab/run.mjs', 'verify-legacy', '--target', 'legacy', '--states', 'S1,S2', '--dpr', '1,2']);
      expect(path.relative(base, dir).startsWith('..')).toBe(false);
      expect(existsSync(dir)).toBe(false); // removed afterwards
      expect(worktrees(repo)).toEqual([repo]);
      expect(await manifestText()).toBe(text); // never written
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^PASS: tag skinlab-selftest \([0-9a-f]{12}\) reproduces 4\/4 manifest entries/));
    });

    it('fails when the report drifts although the tag exited 0', async () => {
      const rows = allRows();
      rows[0] = rowFor('S1', 1, { pngSha256: hex('e') });
      expect(await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: verifyChild(rows) }))).toBe(EXIT.FAIL);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('S1@1x differs from the manifest (png)'));
      expect(worktrees(repo)).toEqual([repo]);
    });

    it('fails when a report-only row drifts although the tag exited 0, and still removes the worktree', async () => {
      const rows = allRows();
      rows[3] = rowFor('S2', 2, { reportOnly: true, pngSha256: hex('e') });
      const text = await manifestText();
      const child = verifyChild(rows);
      expect(await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: child }))).toBe(EXIT.FAIL);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('S2@2x differs from the manifest (png)'));
      expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/^PASS/));
      expect(existsSync(calls[0].dir)).toBe(false);
      expect(worktrees(repo)).toEqual([repo]);
      expect(await manifestText()).toBe(text);
    });

    it('fails when --states/--dpr match nothing in the manifest, rather than passing on 0/0', async () => {
      const code = await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true, states: 'S1', dpr: '3' }, options({ runChild: verifyChild([rowFor('S1', 1)]) }));
      expect(code).toBe(EXIT.FAIL);
      expect(console.log).not.toHaveBeenCalledWith(expect.stringMatching(/^PASS/));
      expect(worktrees(repo)).toEqual([repo]);
    });

    it('fails when an entry was not reproduced', async () => {
      expect(await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: verifyChild(allRows().slice(0, 3)) }))).toBe(EXIT.FAIL);
    });

    it('maps the tag\'s own failure onto our exit code and still removes the worktree', async () => {
      for (const [code, want] of [[77, EXIT.SKIP], [2, EXIT.USAGE], [1, EXIT.FAIL]]) {
        const err = await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: async () => ({ code, stdout: '', stderr: 'boom' }) })).catch((e) => e);
        expect(err).toBeInstanceOf(ExitError);
        expect(err.code).toBe(want);
        expect(worktrees(repo)).toEqual([repo]);
        expect(await readdir(base)).toEqual([]);
      }
    });

    it('needs the tag\'s verify-legacy to print where its report went', async () => {
      const err = await blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: async () => ({ code: 0, stdout: 'PASS\n', stderr: '' }) })).catch((e) => e);
      expect(err.code).toBe(EXIT.FAIL);
      expect(err.message).toContain('output directory');
    });

    it('is a usage error for a tag that does not exist, and creates nothing', async () => {
      const runChild = vi.fn();
      await expect(blessFromTag({ tag: 'no-such-tag', verifyOnly: true }, options({ runChild }))).rejects.toMatchObject({ code: EXIT.USAGE });
      expect(runChild).not.toHaveBeenCalled();
      expect(existsSync(base)).toBe(false);
    });

    it('is a usage error for a tag that predates the harness, and removes the worktree', async () => {
      const runChild = vi.fn();
      await expect(blessFromTag({ tag: 'bare-tag', verifyOnly: true }, options({ runChild }))).rejects.toMatchObject({ code: EXIT.USAGE, message: expect.stringContaining('predates') });
      expect(runChild).not.toHaveBeenCalled();
      expect(worktrees(repo)).toEqual([repo]);
      expect(await readdir(base)).toEqual([]);
    });

    it('refuses an empty manifest: there is nothing to verify', async () => {
      await writeManifest(manifestPath, emptyManifest());
      await expect(blessFromTag({ tag: 'skinlab-selftest', verifyOnly: true }, options({ runChild: verifyChild([]) }))).rejects.toMatchObject({ code: EXIT.FAIL, message: expect.stringContaining('nothing to verify') });
    });
  });

  describe('without --verify-only (a bless through the tag)', () => {
    /** The tag's bless: edits the worktree's manifest copy, as the real one would. */
    const blessChild = (edit, { code = 0 } = {}) =>
      vi.fn(async (dir, args) => {
        calls.push({ dir, args });
        const file = path.join(dir, MANIFEST_REL);
        const m = parseManifest(await readFile(file, 'utf8'));
        edit(m);
        await writeManifest(file, m);
        return { code, stdout: 'blessed\n', stderr: '' };
      });
    const bless = (child, extra = {}) => blessFromTag({ tag: 'skinlab-selftest', verifyOnly: false, reason: 'chromium bump', ...extra }, options({ runChild: child }));

    it('runs the tag\'s bless with the reason and the filters, and adds new keys stamped with the tag', async () => {
      const added = keyFor('S3', 1, { chromiumRevision: '2000' });
      const child = blessChild((m) => {
        const [, e] = [...m.entries][0];
        m.entries.set(added, { ...e, provenance: { ...e.provenance, state: 'S3', dpr: 1 } });
      });
      expect(await bless(child, { states: 'S3', dpr: '1', repin: true })).toBe(EXIT.PASS);
      expect(calls[0].args).toEqual(['tools/skinlab/run.mjs', 'bless', '--target', 'legacy', '--states', 'S3', '--dpr', '1', '--reason', 'chromium bump', '--repin']);
      const after = parseManifest(await manifestText());
      expect(after.entries.size).toBe(manifest.entries.size + 1);
      expect(after.entries.get(added).provenance.blessedFromTag).toEqual({ tag: 'skinlab-selftest', commit: ids.tagged });
      expect(existsSync(calls[0].dir)).toBe(false);
    });

    it('leaves the manifest file untouched when the tag reproduced everything', async () => {
      const text = await manifestText();
      expect(await bless(blessChild(() => {}))).toBe(EXIT.PASS);
      expect(await manifestText()).toBe(text);
    });

    it('refuses to take a manifest in which a blessed key now has other hashes, and says which', async () => {
      const text = await manifestText();
      const [k, e] = [...manifest.entries][0];
      const child = blessChild((m) => m.entries.set(k, { ...e, pngSha256: hex('e') }));
      expect(await bless(child)).toBe(EXIT.FAIL);
      expect(await manifestText()).toBe(text);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${e.provenance.state}@${e.provenance.dpr}x: the tag's capture hashes differently under the same key`));
    });

    it('does not touch the manifest when the tag\'s bless fails', async () => {
      const text = await manifestText();
      const child = blessChild((m) => m.entries.clear(), { code: 2 });
      await expect(bless(child)).rejects.toMatchObject({ code: EXIT.USAGE });
      expect(await manifestText()).toBe(text);
      expect(worktrees(repo)).toEqual([repo]);
    });

    it('needs a reason', async () => {
      await expect(blessFromTag({ tag: 'skinlab-selftest', verifyOnly: false }, options({ runChild: vi.fn() }))).rejects.toMatchObject({ code: EXIT.USAGE });
    });

    it('seeds the worktree with the manifest it will judge against, even when the tag carried another', async () => {
      const text = await manifestText();
      const child = vi.fn(async (dir) => {
        expect(await readFile(path.join(dir, MANIFEST_REL), 'utf8')).toBe(text);
        return { code: 0, stdout: '', stderr: '' };
      });
      expect(await bless(child)).toBe(EXIT.PASS);
      expect(child).toHaveBeenCalled();
    });
  });

  it('serializes the manifest it compares with exactly as the store would (sanity for the fixtures)', async () => {
    expect(await manifestText()).toBe(serializeManifest(manifest));
  });
});
