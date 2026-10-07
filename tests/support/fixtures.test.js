// @ts-check
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HEADSPACE_SHA1, REPO_ROOT, describeCorpus, describeHeadspace, describeWithFixture, headspaceFixture, loadCorpusManifest,
  resolveCorpus, resolveHeadspace, writeTempSkin,
} from './fixtures.js';
import { HAS_UNZIP, makeTempDir, unzip } from './ref-decoders.js';
import { buildZip } from './zip-writer.js';

/** @type {string} */
let dir;
beforeAll(() => { dir = makeTempDir('w04-fixtures-'); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const sha1 = (/** @type {Uint8Array} */ b) => createHash('sha1').update(b).digest('hex');

describe('resolveHeadspace', () => {
  it('pins the owner\'s Headspace.wmz by SHA-1', () => {
    expect(HEADSPACE_SHA1).toMatch(/^[0-9a-f]{40}$/);
    expect(HEADSPACE_SHA1.startsWith('f9671f06')).toBe(true);
  });

  it('defaults to ~/Downloads/Headspace.wmz and honours SKINLAB_HEADSPACE', () => {
    const d = resolveHeadspace({ env: {} });
    expect(d.path).toBe(join(homedir(), 'Downloads', 'Headspace.wmz'));
    const e = resolveHeadspace({ env: { SKINLAB_HEADSPACE: join(dir, 'nope.wmz') } });
    expect(e.path).toBe(join(dir, 'nope.wmz'));
    expect(resolveHeadspace({ env: { SKINLAB_HEADSPACE: '~/x/y.wmz' } }).path).toBe(join(homedir(), 'x', 'y.wmz'));
  });

  it('reports an absent file with the path and the variable to set, and bytes() throws', () => {
    const f = resolveHeadspace({ env: { SKINLAB_HEADSPACE: join(dir, 'absent.wmz') } });
    expect(f).toMatchObject({ status: 'absent', ok: false });
    expect(f.reason).toContain(join(dir, 'absent.wmz'));
    expect(f.reason).toContain('SKINLAB_HEADSPACE');
    expect(() => f.bytes()).toThrow(/unavailable/);
  });

  it('reports a directory, a wrong file (with its actual SHA-1) and a right one', () => {
    const sub = join(dir, 'adir');
    mkdirSync(sub);
    expect(resolveHeadspace({ path: sub }).status).toBe('not-a-file');

    const wrongPath = join(dir, 'wrong.wmz');
    const wrongBytes = buildZip([{ name: 'a', data: 'wrong\n' }]);
    writeFileSync(wrongPath, wrongBytes);
    const wrong = resolveHeadspace({ path: wrongPath });
    expect(wrong).toMatchObject({ status: 'wrong-sha1', ok: false, sha1: sha1(wrongBytes) });
    expect(wrong.reason).toContain(sha1(wrongBytes));
    expect(wrong.reason).toContain('f9671f06');
    expect(() => wrong.bytes()).toThrow();

    const right = resolveHeadspace({ path: wrongPath, expectedSha1: sha1(wrongBytes) });
    expect(right).toMatchObject({ status: 'ok', ok: true, reason: '' });
    expect(Buffer.compare(right.bytes(), wrongBytes)).toBe(0);
  });
});

describe('describeWithFixture', () => {
  it('runs the suite under its own name when the fixture is usable', () => {
    const d = Object.assign(vi.fn(), { skip: vi.fn() });
    const fn = vi.fn();
    describeWithFixture({ ok: true, reason: '' }, 'my suite', fn, /** @type {any} */ (d));
    expect(d.skip).not.toHaveBeenCalled();
    expect(d).toHaveBeenCalledTimes(1);
    expect(d.mock.calls[0][0]).toBe('my suite');
    d.mock.calls[0][1]();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips with the reason in the title when it is not, and still registers the body so the tests show as skipped', () => {
    const d = Object.assign(vi.fn(), { skip: vi.fn() });
    const fn = vi.fn();
    const fixture = { ok: false, reason: 'no Headspace.wmz at /x' };
    describeWithFixture(fixture, 'my suite', fn, /** @type {any} */ (d));
    expect(d).not.toHaveBeenCalled();
    expect(d.skip.mock.calls[0][0]).toBe('my suite [skipped: no Headspace.wmz at /x]');
    d.skip.mock.calls[0][1]();
    expect(fn).toHaveBeenCalledWith(fixture);
  });
});

// The real wrappers: these suites skip on a machine without the art and run on the owner's.
describeHeadspace('Headspace fixture (the real wrapper)', (headspace) => {
  it('is the pinned archive', () => {
    expect(headspace.ok).toBe(true);
    expect(sha1(headspace.bytes())).toBe(HEADSPACE_SHA1);
  });
});

describeCorpus('corpus fixture (the real wrapper)', (corpus) => {
  it('lists both corpora', () => {
    expect(corpus.archives('wmp').length).toBeGreaterThan(300);
    expect(corpus.archives('wsz').length).toBeGreaterThan(0);
  });
});

describe('headspaceFixture', () => {
  it('is resolved once per process', () => {
    expect(headspaceFixture()).toBe(headspaceFixture());
  });
});

describe('resolveCorpus', () => {
  it('is not ok without skins/wmp and skins/wsz, and lists nothing', () => {
    const c = resolveCorpus({ root: join(dir, 'no-skins') });
    expect(c.ok).toBe(false);
    expect(c.reason).toContain('no corpus');
    expect(c.archives('wmp')).toEqual([]);
    const half = join(dir, 'half');
    mkdirSync(join(half, 'wmp'), { recursive: true });
    expect(resolveCorpus({ root: half }).ok).toBe(false);
  });

  it('lists archives of each corpus by name, case-insensitively by extension, ignoring other files', () => {
    const root = join(dir, 'skins');
    mkdirSync(join(root, 'wmp', 'sub'), { recursive: true });
    mkdirSync(join(root, 'wsz'));
    const z = buildZip([{ name: 'a', data: 'a' }]);
    for (const f of ['wmp/b.wmz', 'wmp/A.WMZ', 'wmp/notes.txt', 'wmp/sub/c.wmz', 'wsz/x.wsz', 'wsz/y.zip']) writeFileSync(join(root, f), z);
    const c = resolveCorpus({ root });
    expect(c.ok).toBe(true);
    expect(c.archives('wmp').map((a) => a.name)).toEqual(['A.WMZ', 'b.wmz', 'sub/c.wmz']);
    expect(c.archives('wsz').map((a) => a.name)).toEqual(['x.wsz', 'y.zip']);
    expect(c.archives('wmp')[0]).toMatchObject({ kind: 'wmp', path: join(root, 'wmp', 'A.WMZ') });
    expect(Buffer.compare(c.read(c.archives('wsz')[0]), z)).toBe(0);
  });
});

describe('loadCorpusManifest', () => {
  it('returns Maps keyed by archive name, so a name like `__proto__` or `constructor` is just a name', () => {
    const p = join(dir, 'manifest.json');
    writeFileSync(p, `{"version":1,"wmp":{"__proto__":"aa","constructor":"bb","normal.wmz":"cc"},"wsz":{"toString":"dd"}}`);
    const m = loadCorpusManifest(p);
    expect(m?.wmp instanceof Map).toBe(true);
    expect(m?.wmp.get('__proto__')).toBe('aa');
    expect(m?.wmp.get('constructor')).toBe('bb');
    expect(m?.wmp.has('hasOwnProperty')).toBe(false);
    expect(m?.wmp.size).toBe(3);
    expect(m?.wsz.get('toString')).toBe('dd');
    expect(m?.wsz.has('constructor')).toBe(false);
  });

  it('returns null for a missing file', () => {
    expect(loadCorpusManifest(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('writeTempSkin', () => {
  it('writes a .wmz outside the repository for WINDOW_HEADMPD_SKIN', () => {
    const p = writeTempSkin({ name: 'e6', onclick: 'while(1){}' });
    try {
      expect(p.endsWith('e6.wmz')).toBe(true);
      expect(resolve(p).startsWith(REPO_ROOT)).toBe(false);
      if (HAS_UNZIP) {
        const r = unzip(['-l', p]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('e6.wms');
      }
    } finally {
      rmSync(resolve(p, '..'), { recursive: true, force: true });
    }
  });

  it('can write into a chosen directory', () => {
    const p = writeTempSkin({}, { dir });
    expect(p).toBe(join(dir, 'skin.wmz'));
  });
});
