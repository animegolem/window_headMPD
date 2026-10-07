import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE_ENV, HEADSPACE_SHA1, REPO_ROOT, checkFixture, fixturePath, storeRoot } from '../../tools/skinlab/paths.mjs';
import {
  BlessRefusal,
  HARNESS_VERSION,
  ManifestError,
  applyBless,
  canonicalJson,
  compareToManifest,
  emptyManifest,
  goldenKey,
  goldenPaths,
  loadGolden,
  maskStats,
  parseManifest,
  readManifest,
  saveGolden,
  serializeManifest,
  sha256Hex,
  writeManifest,
} from '../../tools/skinlab/store.mjs';

const hex = (c) => c.repeat(64);
const PIN = hex('a');
const KEY_PARTS = {
  target: 'legacy',
  state: 'S1',
  dpr: 1,
  skinSha256: hex('b'),
  oraclePin: PIN,
  chromiumRevision: '1243',
  harnessVersion: 1,
};

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'skinlab-store-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('does not depend on insertion order', () => {
    expect(canonicalJson({ x: 1, y: { q: 1, p: 2 } })).toBe(canonicalJson({ y: { p: 2, q: 1 }, x: 1 }));
  });

  it('encodes scalars like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonicalJson([true, false, 0, -1.5])).toBe('[true,false,0,-1.5]');
  });

  it('refuses what JSON would silently change', () => {
    for (const bad of [undefined, () => 1, Number.NaN, Infinity, 1n, Symbol('x'), { a: undefined }]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });
});

describe('goldenKey', () => {
  it('is the SHA-256 of the canonical JSON of the seven E D9 fields', () => {
    const expected = createHash('sha256')
      .update(
        `{"chromiumRevision":"1243","dpr":1,"harnessVersion":1,"oraclePin":"${PIN}","skinSha256":"${hex('b')}","state":"S1","target":"legacy"}`,
      )
      .digest('hex');
    expect(goldenKey(KEY_PARTS)).toBe(expected);
  });

  it('is stable across calls and key order', () => {
    const reordered = Object.fromEntries(Object.entries(KEY_PARTS).reverse());
    expect(goldenKey(reordered)).toBe(goldenKey(KEY_PARTS));
    expect(goldenKey(KEY_PARTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any one field changes', () => {
    const base = goldenKey(KEY_PARTS);
    const variants = {
      target: 'engine',
      state: 'S2',
      dpr: 2,
      skinSha256: hex('c'),
      oraclePin: hex('d'),
      chromiumRevision: '1244',
      harnessVersion: 2,
    };
    const keys = new Set([base]);
    for (const [field, value] of Object.entries(variants)) {
      const k = goldenKey({ ...KEY_PARTS, [field]: value });
      expect(k, field).not.toBe(base);
      keys.add(k);
    }
    expect(keys.size).toBe(8);
  });

  it('ignores extra fields and refuses a missing one', () => {
    expect(goldenKey({ ...KEY_PARTS, note: 'x' })).toBe(goldenKey(KEY_PARTS));
    for (const f of Object.keys(KEY_PARTS)) {
      const { [f]: _omit, ...rest } = KEY_PARTS;
      expect(() => goldenKey(rest), f).toThrow(/missing/);
    }
  });

  it('exposes a numeric harness version', () => {
    expect(Number.isInteger(HARNESS_VERSION)).toBe(true);
  });
});

describe('maskStats', () => {
  // Pack exactly as main.js updateMask does.
  const pack = (w, h, on) => {
    const bits = new Uint8Array(Math.ceil((w * h) / 8));
    for (let i = 0; i < w * h; i++) if (on(i % w, Math.floor(i / w))) bits[i >> 3] |= 1 << (i & 7);
    return bits;
  };

  it('counts bits and boxes them inclusively', () => {
    const bits = pack(10, 4, (x, y) => x >= 2 && x <= 5 && y >= 1 && y <= 2);
    expect(maskStats(bits, 10, 4)).toEqual({ popcount: 8, bbox: { x0: 2, y0: 1, x1: 5, y1: 2 } });
  });

  it('handles an empty mask and a full one', () => {
    expect(maskStats(pack(7, 3, () => false), 7, 3)).toEqual({ popcount: 0, bbox: null });
    expect(maskStats(pack(7, 3, () => true), 7, 3)).toEqual({ popcount: 21, bbox: { x0: 0, y0: 0, x1: 6, y1: 2 } });
  });

  it('reads the legacy layout: bit i is y*width+x, least significant bit first', () => {
    const bits = new Uint8Array(3);
    bits[1] = 0b10; // bit 9 of a 5x4 mask: y=1, x=4
    expect(maskStats(bits, 5, 4)).toEqual({ popcount: 1, bbox: { x0: 4, y0: 1, x1: 4, y1: 1 } });
  });

  it('knows the real mask size: 760x394 is 37,430 bytes', () => {
    expect(maskStats(new Uint8Array(37430), 760, 394).popcount).toBe(0);
    expect(() => maskStats(new Uint8Array(37429), 760, 394)).toThrow(RangeError);
  });
});

const entry = (over = {}) => ({
  pngSha256: hex('1'),
  maskSha256: hex('2'),
  popcount: 89328,
  bbox: { x0: 207, y0: 0, x1: 548, y1: 393 },
  provenance: { target: 'legacy', state: 'S1', dpr: 1, oraclePin: PIN, reason: 'test', blessedAt: '2026-10-06T00:00:00.000Z', previous: null },
  ...over,
});

function sampleManifest() {
  const m = emptyManifest();
  m.oraclePin = PIN;
  m.entries.set(hex('9'), entry({ provenance: { ...entry().provenance, state: 'S3b', dpr: 2 } }));
  m.entries.set(hex('7'), entry({ provenance: { ...entry().provenance, state: 'S1', dpr: 2 } }));
  m.entries.set(hex('8'), entry({ provenance: { ...entry().provenance, state: 'S1', dpr: 1 } }));
  m.entries.set(hex('6'), entry({ provenance: { ...entry().provenance, state: 'S2', dpr: 1 }, bbox: null, popcount: 0 }));
  return m;
}

describe('manifest', () => {
  it('round-trips through text', () => {
    const m = sampleManifest();
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it('round-trips through a file, and the bytes are stable', async () => {
    const file = path.join(tmp, 'm.json');
    const m = sampleManifest();
    await writeManifest(file, m);
    const first = readFileSync(file, 'utf8');
    expect(await readManifest(file)).toEqual(m);
    await writeManifest(file, await readManifest(file));
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
  });

  it('orders entries by state then dpr whatever the insertion order', () => {
    const m = sampleManifest();
    const reversed = { ...m, entries: new Map([...m.entries].reverse()) };
    expect(serializeManifest(reversed)).toBe(serializeManifest(m));
    const order = Object.values(JSON.parse(serializeManifest(m)).entries).map((e) => `${e.provenance.state}@${e.provenance.dpr}`);
    expect(order).toEqual(['S1@1', 'S1@2', 'S2@1', 'S3b@2']);
  });

  it('keeps the five entry fields in a fixed order', () => {
    const e = Object.values(JSON.parse(serializeManifest(sampleManifest())).entries)[0];
    expect(Object.keys(e)).toEqual(['pngSha256', 'maskSha256', 'popcount', 'bbox', 'provenance']);
  });

  it('reads a missing file as an empty manifest', async () => {
    const m = await readManifest(path.join(tmp, 'nope.json'));
    expect(m.entries.size).toBe(0);
    expect(m.oraclePin).toBeNull();
  });

  it('accepts the initial committed manifest', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'tools/skinlab/goldens.manifest.json'), 'utf8');
    const m = parseManifest(text);
    expect(m.version).toBe(1);
  });

  it('rejects malformed manifests', () => {
    const wrap = (over) => JSON.stringify({ version: 1, oraclePin: null, entries: {}, ...over });
    expect(() => parseManifest('{')).toThrow(ManifestError);
    expect(() => parseManifest('[]')).toThrow(ManifestError);
    expect(() => parseManifest(wrap({ version: 2 }))).toThrow(/version/);
    expect(() => parseManifest(wrap({ oraclePin: 'xyz' }))).toThrow(/oraclePin/);
    expect(() => parseManifest(wrap({ entries: [] }))).toThrow(/entries/);
    expect(() => parseManifest(wrap({ entries: { [hex('1')]: { ...entry(), pngSha256: 'short' } } }))).toThrow(/pngSha256/);
    expect(() => parseManifest(wrap({ entries: { [hex('1')]: { ...entry(), popcount: -1 } } }))).toThrow(/popcount/);
    expect(() => parseManifest(wrap({ entries: { [hex('1')]: { ...entry(), bbox: { x0: 1 } } } }))).toThrow(/bbox/);
    expect(() => parseManifest(wrap({ entries: { [hex('1')]: { ...entry(), provenance: null } } }))).toThrow(/provenance/);
  });

  it('treats __proto__ and constructor keys as bad keys, never as lookups', () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      const text = `{"version":1,"oraclePin":null,"entries":{"${bad}":${JSON.stringify(entry())}}}`;
      expect(() => parseManifest(text), bad).toThrow(/not 64 hex/);
    }
    expect(Object.prototype.pngSha256).toBeUndefined();
    const m = parseManifest(serializeManifest(sampleManifest()));
    expect(m.entries.get('__proto__')).toBeUndefined();
    expect(m.entries.get('constructor')).toBeUndefined();
    expect(m.entries instanceof Map).toBe(true);
  });
});

describe('applyBless', () => {
  const cap = (state, dpr, over = {}) => ({
    key: goldenKey({ ...KEY_PARTS, state, dpr }),
    target: 'legacy',
    state,
    dpr,
    pngSha256: hex('1'),
    maskSha256: hex('2'),
    popcount: 5,
    bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
    ...over,
  });
  const opts = { reason: 'W0.5 initial', oraclePin: PIN, at: '2026-10-06T12:00:00.000Z' };

  it('adds entries with the reason and no previous hashes', () => {
    const { manifest, changes } = applyBless(emptyManifest(), [cap('S1', 1), cap('S1', 2)], opts);
    expect(manifest.oraclePin).toBe(PIN);
    expect(manifest.entries.size).toBe(2);
    expect(changes.map((c) => c.action)).toEqual(['added', 'added']);
    const e = manifest.entries.get(cap('S1', 1).key);
    expect(e.provenance).toMatchObject({ target: 'legacy', state: 'S1', dpr: 1, reason: 'W0.5 initial', previous: null, blessedAt: opts.at });
  });

  it('needs a reason', () => {
    expect(() => applyBless(emptyManifest(), [cap('S1', 1)], { ...opts, reason: '  ' })).toThrow(BlessRefusal);
  });

  it('refuses when the oracle pin differs, unless repin', () => {
    const blessed = applyBless(emptyManifest(), [cap('S1', 1)], opts).manifest;
    const newPin = hex('e');
    expect(() => applyBless(blessed, [cap('S1', 1)], { ...opts, oraclePin: newPin })).toThrow(/oracle pin changed/);
    const key = goldenKey({ ...KEY_PARTS, oraclePin: newPin, state: 'S1', dpr: 1 });
    const r = applyBless(blessed, [{ ...cap('S1', 1), key, pngSha256: hex('3') }], { ...opts, oraclePin: newPin, repin: true });
    expect(r.manifest.oraclePin).toBe(newPin);
    expect(r.manifest.entries.size).toBe(1);
    expect(r.changes[0].action).toBe('replaced');
    expect(r.changes[0].previous).toMatchObject({ pngSha256: hex('1'), maskSha256: hex('2') });
    expect(r.manifest.entries.get(key).provenance.previous.pngSha256).toBe(hex('1'));
  });

  it('drops entries blessed under another pin when repinning', () => {
    const blessed = applyBless(emptyManifest(), [cap('S1', 1), cap('S2', 1)], opts).manifest;
    const newPin = hex('e');
    const key = goldenKey({ ...KEY_PARTS, oraclePin: newPin, state: 'S1', dpr: 1 });
    const r = applyBless(blessed, [{ ...cap('S1', 1), key }], { ...opts, oraclePin: newPin, repin: true });
    expect(r.dropped).toBe(1); // S2 was not recaptured: its key can never be looked up again
    expect([...r.manifest.entries.values()].map((e) => e.provenance.state)).toEqual(['S1']);
  });

  it('leaves unchanged captures alone and replaces changed ones, recording old hashes', () => {
    const first = applyBless(emptyManifest(), [cap('S1', 1), cap('S2', 1)], opts).manifest;
    const second = applyBless(first, [cap('S1', 1), cap('S2', 1, { maskSha256: hex('4') })], {
      ...opts,
      reason: 'changed',
      at: '2026-10-07T00:00:00.000Z',
    });
    expect(second.changes.map((c) => c.action)).toEqual(['unchanged', 'replaced']);
    expect(second.manifest.entries.get(cap('S1', 1).key).provenance.reason).toBe('W0.5 initial'); // not churned
    const replaced = second.manifest.entries.get(cap('S2', 1).key);
    expect(replaced.maskSha256).toBe(hex('4'));
    expect(replaced.provenance.reason).toBe('changed');
    expect(replaced.provenance.previous).toMatchObject({ maskSha256: hex('2') });
  });

  it('replaces an entry whose key moved (another Chromium) and keeps untouched states', () => {
    const first = applyBless(emptyManifest(), [cap('S1', 1), cap('S2', 1)], opts).manifest;
    const key = goldenKey({ ...KEY_PARTS, chromiumRevision: '1300', state: 'S1', dpr: 1 });
    const r = applyBless(first, [{ ...cap('S1', 1), key }], opts);
    expect(r.manifest.entries.has(cap('S1', 1).key)).toBe(false);
    expect(r.manifest.entries.has(key)).toBe(true);
    expect(r.manifest.entries.has(cap('S2', 1).key)).toBe(true);
    expect(r.changes[0].action).toBe('replaced');
  });

  it('does not mutate its input', () => {
    const first = applyBless(emptyManifest(), [cap('S1', 1)], opts).manifest;
    const before = serializeManifest(first);
    applyBless(first, [cap('S1', 1, { pngSha256: hex('5') }), cap('S2', 1)], opts);
    expect(serializeManifest(first)).toBe(before);
  });
});

describe('compareToManifest', () => {
  const m = applyBless(
    emptyManifest(),
    [{ key: goldenKey(KEY_PARTS), target: 'legacy', state: 'S1', dpr: 1, pngSha256: hex('1'), maskSha256: hex('2'), popcount: 1, bbox: null }],
    { reason: 'r', oraclePin: PIN },
  ).manifest;
  const key = goldenKey(KEY_PARTS);

  it('reports ok, drift per artifact, and missing', () => {
    expect(compareToManifest(m, { key, pngSha256: hex('1'), maskSha256: hex('2') }).status).toBe('ok');
    expect(compareToManifest(m, { key, pngSha256: hex('3'), maskSha256: hex('2') })).toMatchObject({ status: 'drift', diffs: ['png'] });
    expect(compareToManifest(m, { key, pngSha256: hex('1'), maskSha256: hex('3') })).toMatchObject({ status: 'drift', diffs: ['mask'] });
    expect(compareToManifest(m, { key, pngSha256: hex('3'), maskSha256: hex('3') }).diffs).toEqual(['png', 'mask']);
    expect(compareToManifest(m, { key: hex('f'), pngSha256: hex('1'), maskSha256: hex('2') }).status).toBe('missing');
  });
});

describe('the local golden store', () => {
  const png = Buffer.from('not really a png');
  const mask = Buffer.from([1, 2, 3, 4]);
  const key = hex('c');
  const e = { pngSha256: sha256Hex(png), maskSha256: sha256Hex(mask) };

  it('keeps goldens under the root it is given, named by key', () => {
    const p = goldenPaths(key, tmp);
    expect(p.png).toBe(path.join(tmp, 'goldens', `${key}.png`));
    expect(p.mask).toBe(path.join(tmp, 'goldens', `${key}.mask`));
    expect(() => goldenPaths('../../etc/passwd', tmp)).toThrow(TypeError);
  });

  it('defaults to the Library/Caches store, outside the repo', () => {
    const root = storeRoot('/home/x');
    expect(root).toBe('/home/x/Library/Caches/window_headmpd/skinlab');
    expect(path.relative(REPO_ROOT, storeRoot()).startsWith('..')).toBe(true);
  });

  it('round-trips, and refuses a golden that does not hash to the manifest entry', async () => {
    expect(await loadGolden(key, e, tmp)).toBeNull(); // missing
    await saveGolden(key, { png, mask }, tmp);
    const got = await loadGolden(key, e, tmp);
    expect(got.png.equals(png)).toBe(true);
    expect(got.mask.equals(mask)).toBe(true);
    expect(await loadGolden(key, { ...e, pngSha256: hex('0') }, tmp)).toBeNull();
    writeFileSync(goldenPaths(key, tmp).mask, Buffer.from([9]));
    expect(await loadGolden(key, e, tmp)).toBeNull(); // corrupted on disk
  });
});

describe('fixture resolution (paths.mjs)', () => {
  it('prefers SKINLAB_HEADSPACE, expands ~, and defaults to ~/Downloads/Headspace.wmz', () => {
    expect(FIXTURE_ENV).toBe('SKINLAB_HEADSPACE');
    expect(fixturePath({ SKINLAB_HEADSPACE: '/tmp/x.wmz' }, '/home/u')).toBe('/tmp/x.wmz');
    expect(fixturePath({ SKINLAB_HEADSPACE: '~/skins/h.wmz' }, '/home/u')).toBe('/home/u/skins/h.wmz');
    expect(fixturePath({}, '/home/u')).toBe('/home/u/Downloads/Headspace.wmz');
    expect(fixturePath({ SKINLAB_HEADSPACE: '' }, '/home/u')).toBe('/home/u/Downloads/Headspace.wmz');
  });

  it('pins the owner copy by sha1', () => {
    expect(HEADSPACE_SHA1).toMatch(/^f9671f06[0-9a-f]{32}$/);
  });

  it('reports absent, a directory as absent, and a wrong sha1', async () => {
    expect((await checkFixture(path.join(tmp, 'nope.wmz'))).status).toBe('absent');
    expect((await checkFixture(tmp)).status).toBe('absent');
    const wrong = path.join(tmp, 'wrong.wmz');
    writeFileSync(wrong, 'definitely not Headspace');
    const r = await checkFixture(wrong);
    expect(r.status).toBe('badsha');
    expect(r.sha1).toBe(createHash('sha1').update('definitely not Headspace').digest('hex'));
  });
});

describe('run.mjs exit codes (no Chromium needed)', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools/skinlab/run.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 60_000,
    });

  it('2 for no command, an unknown one, and a path pretending to be one', () => {
    for (const args of [[], ['nope'], ['../../etc/passwd'], ['__proto__']]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('commands:');
    }
  });

  it('0 for --help, listing the commands', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    for (const c of ['bless', 'prepare', 'show', 'verify-legacy']) expect(r.stdout).toContain(c);
  });

  it('2 for usage mistakes in bless', () => {
    expect(run(['bless', '--target', 'legacy']).status).toBe(2); // no reason
    expect(run(['bless', '--reason', 'x']).status).toBe(2); // no target
    expect(run(['bless', '--target', 'engine', '--reason', 'x']).status).toBe(2);
    expect(run(['bless', '--target', 'legacy', '--reason', 'x', '--states', '__proto__']).status).toBe(2);
    expect(run(['bless', '--target', 'legacy', '--reason', 'x', '--frobnicate']).status).toBe(2);
  });

  it('77 when the fixture is absent, for every command that needs it', () => {
    const env = { [FIXTURE_ENV]: path.join(tmp, 'nonexistent.wmz') };
    expect(run(['verify-legacy'], env).status).toBe(77);
    expect(run(['prepare'], env).status).toBe(77);
    expect(run(['bless', '--target', 'legacy', '--reason', 'x'], env).status).toBe(77);
    expect(run(['show', '--target', 'legacy', '--state', 'S1'], env).status).toBe(77);
  });

  it('2 when the fixture has the wrong sha1', () => {
    const real = fixturePath();
    const wrong = path.join(tmp, 'Headspace.wmz');
    if (existsSync(real)) copyFileSync(real, wrong);
    writeFileSync(wrong, Buffer.concat([existsSync(wrong) ? readFileSync(wrong) : Buffer.alloc(0), Buffer.from([0])]));
    const env = { [FIXTURE_ENV]: wrong };
    const r = run(['verify-legacy'], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('wrong fixture');
    expect(run(['bless', '--target', 'legacy', '--reason', 'x'], env).status).toBe(2);
  });
});
