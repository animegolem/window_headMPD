// @ts-check
import { describe, expect, it } from 'vitest';
import { FALLBACK_SUFFIX, SHA_PATTERN, createSkinStore } from '../../../src/hosts/tauri/skins.js';

const SHA = '76a8662f469881bf5ed6eb93595042fdb188c65663135da6ff4dcd10b37bf85d';
const OTHER = 'c'.repeat(64);
const DOWNLOADS = '/Users/someone/Downloads/Headspace.wmz';
const record = (/** @type {string} */ sha, name = 'Headspace') => ({ sha, name, family: 'wms', bytes: 1234, imported_at: 1 });

/**
 * @param {{ path?: string | null, recorded?: unknown, replies?: Record<string, unknown>, failImport?: boolean }} [o]
 *   `recorded` is what `skin_list` answers with.
 */
function setup(o = {}) {
  /** @type {Array<[string, any]>} */
  const calls = [];
  /** @type {Array<[string, object | undefined]>} */
  const infos = [];
  const invoke = async (/** @type {string} */ cmd, /** @type {any} */ args) => {
    calls.push([cmd, args]);
    if (o.replies && cmd in o.replies) return o.replies[cmd];
    switch (cmd) {
      case 'skin_default_path': return o.path === undefined ? DOWNLOADS : o.path;
      case 'skin_list': return o.recorded ?? [];
      case 'skin_import':
        if (o.failImport) throw new Error('not a skin archive');
        return record(SHA);
      default: return undefined;
    }
  };
  const store = createSkinStore({ invoke, log: { info: (m, d) => { infos.push([m, d]); } } });
  return { store, calls, infos, cmds: () => calls.map(([c]) => c) };
}

describe('constants', () => {
  it('match the Rust side', () => {
    expect(SHA_PATTERN.test(SHA)).toBe(true);
    expect(FALLBACK_SUFFIX).toBe('/Downloads/Headspace.wmz');         // skin_cmds.rs DEFAULT_SKIN, behind a home directory
  });
});

describe('importDefault', () => {
  it('imports ~/Downloads/Headspace.wmz when no skin is recorded, and returns the record', async () => {
    const t = setup({ recorded: [] });
    const rec = await t.store.importDefault();
    expect(rec).toEqual(record(SHA));
    expect(t.calls).toEqual([['skin_default_path', undefined], ['skin_list', undefined], ['skin_import', { path: DOWNLOADS }]]);
    expect(t.infos).toHaveLength(1);
  });

  it('imports nothing when a skin is already recorded', async () => {
    const t = setup({ recorded: [record(OTHER, 'Other')] });
    expect(await t.store.importDefault()).toBeNull();
    expect(t.cmds()).toEqual(['skin_default_path', 'skin_list']);
    expect(t.infos).toEqual([]);
  });

  it('imports nothing when there is no default path (no env var, no file in Downloads)', async () => {
    for (const path of [null, '', undefined]) {
      const t = setup({ path: /** @type {any} */ (path === undefined ? null : path) });
      expect(await t.store.importDefault()).toBeNull();
      expect(t.cmds()).toEqual(['skin_default_path']);
    }
  });

  it('imports the WINDOW_HEADMPD_SKIN path every time, recorded skins or not', async () => {
    const t = setup({ path: '/tmp/other skin.wmz', recorded: [record(OTHER, 'Other')] });
    expect(await t.store.importDefault()).toEqual(record(SHA));
    expect(t.calls).toEqual([['skin_default_path', undefined], ['skin_import', { path: '/tmp/other skin.wmz' }]]);
  });

  it('lets a refused import reject, so the shell can show why', async () => {
    const t = setup({ recorded: [], failImport: true });
    await expect(t.store.importDefault()).rejects.toThrow('not a skin archive');
  });

  it('refuses a reply that is not a skin record', async () => {
    const t = setup({ recorded: [], replies: { skin_import: { sha: '__proto__' } } });
    await expect(t.store.importDefault()).rejects.toBeInstanceOf(TypeError);
  });
});

describe('read', () => {
  it('returns the raw response as a Uint8Array', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
    const t = setup({ replies: { skin_read: bytes.buffer } });
    const got = await t.store.read(SHA);
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([0x50, 0x4b, 3, 4]);
    expect(t.calls).toEqual([['skin_read', { sha: SHA }]]);
  });

  it('copes with the other shapes a response may take, and refuses a non-byte reply', async () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(await setup({ replies: { skin_read: u8 } }).store.read(SHA)).toBe(u8);
    expect(Array.from(await setup({ replies: { skin_read: [9, 8] } }).store.read(SHA))).toEqual([9, 8]);
    const view = new DataView(new Uint8Array([5, 6, 7, 8]).buffer, 1, 2);
    expect(Array.from(await setup({ replies: { skin_read: view } }).store.read(SHA))).toEqual([6, 7]);
    await expect(setup({ replies: { skin_read: 'nope' } }).store.read(SHA)).rejects.toBeInstanceOf(TypeError);
    await expect(setup({ replies: { skin_read: null } }).store.read(SHA)).rejects.toBeInstanceOf(TypeError);
  });

  it('checks the sha before any IPC: 64 lowercase hex only', async () => {
    const t = setup();
    for (const bad of ['', 'abc', SHA.toUpperCase(), `${SHA}0`, SHA.slice(1), '__proto__', 'constructor', `../${SHA}`, `${SHA}\n`, /** @type {any} */ (null), /** @type {any} */ (5)]) {
      await expect(t.store.read(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(t.calls).toEqual([]);
  });
});

describe('list, importPath, remove', () => {
  it('lists the records Rust has, dropping anything that is not one', async () => {
    const t = setup({ recorded: [record(SHA), null, 'x', { sha: 5 }, { sha: '__proto__' }, record(OTHER, 'Other')] });
    expect((await t.store.list()).map((r) => r.sha)).toEqual([SHA, OTHER]);
    expect(await setup({ recorded: 'broken' }).store.list()).toEqual([]);
  });

  it('importPath sends the path and returns the record', async () => {
    const t = setup();
    expect(await t.store.importPath('/tmp/a.wsz')).toEqual(record(SHA));
    expect(t.calls).toEqual([['skin_import', { path: '/tmp/a.wsz' }]]);
    await expect(t.store.importPath('')).rejects.toBeInstanceOf(TypeError);
    await expect(t.store.importPath(/** @type {any} */ (null))).rejects.toBeInstanceOf(TypeError);
  });

  it('remove checks the sha, then asks Rust', async () => {
    const t = setup();
    await t.store.remove(SHA);
    expect(t.calls).toEqual([['skin_remove', { sha: SHA }]]);
    await expect(t.store.remove('constructor')).rejects.toBeInstanceOf(TypeError);
    expect(t.calls).toHaveLength(1);
  });
});
