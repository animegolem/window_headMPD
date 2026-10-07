// @ts-check
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_PATH, REPO_ROOT, buildManifest, isArchiveName, listArchives, readManifest, serialiseManifest } from '../../tools/make-corpus-manifest.mjs';
import { describeCorpus, loadCorpusManifest } from './fixtures.js';
import { makeTempDir } from './ref-decoders.js';
import { buildZip } from './zip-writer.js';

const sha256 = (/** @type {Uint8Array} */ b) => createHash('sha256').update(b).digest('hex');
const TOOL = join(REPO_ROOT, 'tools', 'make-corpus-manifest.mjs');
const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 60000 });

/** @type {string} */
let dir;
/** @type {string} */
let skins;
const files = new Map([
  ['wmp/b.wmz', buildZip([{ name: 'b', data: 'b' }])],
  ['wmp/A.WMZ', buildZip([{ name: 'a', data: 'a' }])],
  ['wmp/notes.txt', new TextEncoder().encode('not an archive')],
  ['wmp/sub/c.wmz', buildZip([{ name: 'c', data: 'c' }])],
  ['wmp/dup.wmz', buildZip([{ name: 'b', data: 'b' }])], // same bytes as b.wmz
  ['wsz/x.wsz', buildZip([{ name: 'x', data: 'x' }])],
  ['wsz/y.zip', buildZip([{ name: 'y', data: 'y' }])],
]);

beforeAll(() => {
  dir = makeTempDir('w04-manifest-');
  skins = join(dir, 'skins');
  for (const [name, bytes] of files) {
    mkdirSync(join(skins, name, '..'), { recursive: true });
    writeFileSync(join(skins, name), bytes);
  }
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('listArchives and isArchiveName', () => {
  it('matches .wmz, .wsz and .zip in any case, and nothing else', () => {
    for (const n of ['a.wmz', 'A.WMZ', 'b.Wsz', 'c.zip', 'd.ZIP']) expect(isArchiveName(n), n).toBe(true);
    for (const n of ['a.wms', 'a.txt', 'a.wmz.bak', 'wmz']) expect(isArchiveName(n), n).toBe(false);
  });

  it('walks subdirectories and sorts by code unit, so upper case sorts before lower', () => {
    expect(listArchives(join(skins, 'wmp'))).toEqual(['A.WMZ', 'b.wmz', 'dup.wmz', 'sub/c.wmz']);
  });
});

describe('make-corpus-manifest.mjs', () => {
  it('writes name -> SHA-256 for every archive of both corpora, one entry per line, sorted, with counts printed', () => {
    const out = join(dir, 'out.json');
    const r = run('--skins', skins, '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('wmp: 4 archives (3 distinct SHA-256)');
    expect(r.stdout).toContain('wsz: 2 archives (2 distinct SHA-256)');
    const text = readFileSync(out, 'utf8');
    const json = JSON.parse(text);
    expect(json.version).toBe(1);
    expect(Object.keys(json.wmp)).toEqual(['A.WMZ', 'b.wmz', 'dup.wmz', 'sub/c.wmz']);
    expect(Object.keys(json.wsz)).toEqual(['x.wsz', 'y.zip']);
    for (const [name, h] of Object.entries(json.wmp)) expect(h).toBe(sha256(/** @type {Uint8Array} */ (files.get(`wmp/${name}`))));
    expect(json.wmp['b.wmz']).toBe(json.wmp['dup.wmz']);
    expect(text.split('\n').filter((l) => /\.wmz": /i.test(l)).length).toBe(4);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamps: names and hashes only
  });

  it('is deterministic', () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    run('--skins', skins, '--out', a);
    run('--skins', skins, '--out', b);
    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
  });

  it('with the corpus absent prints a skip, exits 0 and leaves the output file alone', () => {
    const out = join(dir, 'untouched.json');
    writeFileSync(out, 'previous');
    const r = run('--skins', join(dir, 'does-not-exist'), '--out', out);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^skip: /);
    expect(readFileSync(out, 'utf8')).toBe('previous');
    const none = join(dir, 'never-written.json');
    expect(run('--skins', join(dir, 'does-not-exist'), '--out', none).status).toBe(0);
    expect(existsSync(none)).toBe(false);
  });

  it('exits 2 on bad usage', () => {
    expect(run('--bogus').status).toBe(2);
    expect(run('--skins').status).toBe(2);
  });
});

describe('manifest lookups keyed by file name', () => {
  it('buildManifest uses Maps, so `__proto__` and `constructor` are ordinary names', () => {
    const root = join(dir, 'proto-skins');
    mkdirSync(join(root, 'wmp'), { recursive: true });
    mkdirSync(join(root, 'wsz'), { recursive: true });
    const a = buildZip([{ name: 'p', data: 'p' }]);
    const b = buildZip([{ name: 'c', data: 'c' }]);
    writeFileSync(join(root, 'wmp', '__proto__'), a);
    writeFileSync(join(root, 'wmp', 'constructor'), b);
    writeFileSync(join(root, 'wsz', 'toString'), a);
    const m = buildManifest(root, { accept: () => true });
    expect(m.wmp instanceof Map).toBe(true);
    expect(m.wmp.get('__proto__')).toBe(sha256(a));
    expect(m.wmp.get('constructor')).toBe(sha256(b));
    expect(m.wmp.has('hasOwnProperty')).toBe(false);
    expect(m.wsz.get('toString')).toBe(sha256(a));
    expect(m.wsz.has('constructor')).toBe(false);

    // and the round trip through the file keeps them
    const p = join(dir, 'proto-manifest.json');
    writeFileSync(p, serialiseManifest(m));
    const back = readManifest(p);
    expect(back?.wmp.get('__proto__')).toBe(sha256(a));
    expect(back?.wmp.get('constructor')).toBe(sha256(b));
    expect(back?.wmp.size).toBe(2);
    expect(Object.getPrototypeOf(JSON.parse(readFileSync(p, 'utf8')).wmp)).toBe(Object.prototype); // JSON.parse made own properties, not a prototype swap
  });
});

describe('the committed tests/corpus.manifest.json', () => {
  const m = loadCorpusManifest(MANIFEST_PATH);

  it('exists and holds the 342 WMP archives (195 distinct, survey 1.1) and the wsz set', () => {
    expect(m).not.toBeNull();
    expect(m?.version).toBe(1);
    expect(m?.wmp.size).toBe(342);
    expect(new Set(m?.wmp.values()).size).toBe(195);
    expect(m?.wsz.size).toBe(30);
    for (const h of [...(m?.wmp.values() ?? []), ...(m?.wsz.values() ?? [])]) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('holds names and hashes only', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['version', 'wmp', 'wsz']);
    expect(text.length).toBeLessThan(120 * 1024);
  });

  it('lists the three upper-case .WMZ files (survey 1.1)', () => {
    for (const n of ['howarduniversity__TEDDY.WMZ', 'howarduniversity__UPRISING.WMZ', 'microsoft__PYRITE.WMZ']) expect(m?.wmp.has(n), n).toBe(true);
  });

  it('is serialised exactly as the tool would write it', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    expect(serialiseManifest(/** @type {any} */ (m))).toBe(text);
  });
});

describeCorpus('the committed manifest against the live corpus', (corpus) => {
  it('pins exactly the archives on disk, byte for byte', () => {
    const m = loadCorpusManifest();
    for (const kind of /** @type {const} */ (['wmp', 'wsz'])) {
      const live = corpus.archives(kind);
      expect(live.map((a) => a.name)).toEqual([...(m?.[kind].keys() ?? [])]);
      for (const a of live) expect(sha256(corpus.read(a)), `${kind}/${a.name}`).toBe(m?.[kind].get(a.name));
    }
  }, 120000);
});
