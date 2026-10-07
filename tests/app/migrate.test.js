// @vitest-environment happy-dom
// Legacy prefs migration (ENGINE.md D10.8): the eight `localStorage` keys the hand port kept are copied
// into the `app` and `mediacenter` namespaces once, in the legacy value format, and never again. The
// readers that consume them (the DSP, the zoom, the pins, the VizHost preset) are run over the result so
// "copied" means "read back as the owner left it".
//
// Rule 6: no lookup here is keyed by skin text; the legacy key names are the shell's own.
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_KEYS, MIGRATED_MARKER, migrateLegacyPrefs } from '../../src/app/migrate.js';
import { parseZoom } from '../../src/app/zoom.js';
import { createPins } from '../../src/app/menu.js';
import { createTauriDsp } from '../../src/hosts/tauri/dsp.js';
import { createMemoryPrefs } from '../../src/hosts/test/prefs.js';
import { createTestSkinWindow } from '../../src/hosts/test/window.js';

/** A localStorage of what the hand port wrote: `store` JSON-stringified its values, viz wrote `preset` bare. */
const LEGACY = Object.freeze({
  zoom: '1.5',
  eq: '[0,0,3,0,-5,0,0,0,6,9]',
  balance: '-20',
  eqOpen: 'true',
  plOpen: 'false',
  onTop: 'true',
  allDesktops: 'false',
  preset: '3',
});
/** @param {Record<string, string>} [data] */
const storage = (data = LEGACY) => ({ getItem: (/** @type {string} */ k) => (Object.hasOwn(data, k) ? data[k] : null) });

describe('migrateLegacyPrefs', () => {
  it('lists the eight legacy keys of D10.8', () => {
    expect([...LEGACY_KEYS]).toEqual(['zoom', 'eq', 'balance', 'eqOpen', 'plOpen', 'onTop', 'allDesktops', 'preset']);
  });

  it('copies all eight verbatim: seven into app, the preset into mediacenter as effectPreset', async () => {
    const prefs = createMemoryPrefs();
    const r = await migrateLegacyPrefs({ storage: storage(), prefs });
    expect(r).toMatchObject({ ran: true, skipped: [] });
    expect(r.copied).toEqual([...LEGACY_KEYS]);
    const app = prefs.peek('app');
    for (const k of LEGACY_KEYS.filter((k) => k !== 'preset')) expect(app.get(k)).toBe(LEGACY[/** @type {keyof typeof LEGACY} */ (k)]);
    expect(app.has('preset')).toBe(false);
    expect(prefs.peek('mediacenter').get('effectPreset')).toBe('3');
    expect(app.get(MIGRATED_MARKER)).toBe('1');
  });

  it('runs once: the marker stops a second run, and a changed legacy value is not copied over the engine\'s own', async () => {
    const prefs = createMemoryPrefs();
    await migrateLegacyPrefs({ storage: storage(), prefs });
    prefs.write('app', 'zoom', '1');                           // the engine has since saved its own
    const writes = prefs.writes.length;
    const second = await migrateLegacyPrefs({ storage: storage({ ...LEGACY, zoom: '1.5', balance: '50' }), prefs });
    expect(second).toEqual({ ran: false, copied: [], skipped: [] });
    expect(prefs.writes.length).toBe(writes);
    expect(prefs.peek('app').get('zoom')).toBe('1');
    expect(prefs.peek('app').get('balance')).toBe('-20');
  });

  it('never again, even across a new PrefStore over the same files', async () => {
    const first = createMemoryPrefs();
    await migrateLegacyPrefs({ storage: storage(), prefs: first });
    const reopened = createMemoryPrefs();
    reopened.seed('app', first.peek('app'));
    reopened.seed('mediacenter', first.peek('mediacenter'));
    expect((await migrateLegacyPrefs({ storage: storage(), prefs: reopened })).ran).toBe(false);
    expect(reopened.writes).toEqual([]);
  });

  it('copies only what the owner ever set, and writes the marker anyway', async () => {
    const prefs = createMemoryPrefs();
    const r = await migrateLegacyPrefs({ storage: storage({ zoom: '1.5' }), prefs });
    expect(r.copied).toEqual(['zoom']);
    expect(r.skipped).toEqual([]);
    expect([...prefs.peek('app').keys()].sort()).toEqual([MIGRATED_MARKER, 'zoom']);
  });

  it('keeps a value the namespace already has', async () => {
    const prefs = createMemoryPrefs();
    prefs.seed('app', { zoom: '1' });
    prefs.seed('mediacenter', { effectPreset: '0' });
    const r = await migrateLegacyPrefs({ storage: storage(), prefs });
    expect(prefs.peek('app').get('zoom')).toBe('1');
    expect(prefs.peek('mediacenter').get('effectPreset')).toBe('0');
    expect(r.skipped).toEqual([{ key: 'zoom', reason: 'already set' }, { key: 'preset', reason: 'already set' }]);
    expect(prefs.peek('app').get('eq')).toBe(LEGACY.eq);
  });

  it('skips values the hand port could not have written, and says so', async () => {
    const prefs = createMemoryPrefs();
    const r = await migrateLegacyPrefs({
      storage: storage({
        zoom: 'banana', eq: '["a"]', balance: '999', eqOpen: '1', plOpen: 'null', onTop: 'TRUE', allDesktops: '{}',
        preset: '-1',
      }),
      prefs,
    });
    expect(r.copied).toEqual([]);
    expect(r.skipped.map((s) => s.key)).toEqual([...LEGACY_KEYS]);
    expect(r.skipped.every((s) => s.reason === 'invalid')).toBe(true);
    expect(r.ran).toBe(true);
    expect([...prefs.peek('app').keys()]).toEqual([MIGRATED_MARKER]);
  });

  it('skips an eq with more than ten bands and a value over the length cap', async () => {
    const prefs = createMemoryPrefs();
    const r = await migrateLegacyPrefs({
      storage: storage({ eq: JSON.stringify(Array(11).fill(0)), balance: ` ${'0'.repeat(2000)}` }),
      prefs,
    });
    expect(r.copied).toEqual([]);
    expect(r.skipped.map((s) => s.key)).toEqual(['eq', 'balance']);
  });

  it('a localStorage that cannot be read migrates nothing and writes no marker, so the next launch tries again', async () => {
    const prefs = createMemoryPrefs();
    expect(await migrateLegacyPrefs({ storage: null, prefs })).toMatchObject({ ran: false, copied: [], error: 'no localStorage' });
    expect(prefs.writes).toEqual([]);
  });

  it('a getItem that throws skips that key and carries on', async () => {
    const prefs = createMemoryPrefs();
    const throwing = {
      getItem(/** @type {string} */ k) {
        if (k === 'eq') throw new DOMException('denied', 'SecurityError');
        return Object.hasOwn(LEGACY, k) ? LEGACY[/** @type {keyof typeof LEGACY} */ (k)] : null;
      },
    };
    const r = await migrateLegacyPrefs({ storage: throwing, prefs });
    expect(r.skipped).toEqual([{ key: 'eq', reason: 'unreadable' }]);
    expect(r.copied).toHaveLength(7);
    expect(prefs.peek('app').has(MIGRATED_MARKER)).toBe(true);
  });

  it('a pref store that cannot load writes nothing and does not throw', async () => {
    const write = vi.fn();
    const r = await migrateLegacyPrefs({ storage: storage(), prefs: { load: () => Promise.reject(new Error('io')), write } });
    expect(r).toMatchObject({ ran: false, error: 'io' });
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves the legacy keys where they are (the hand port still reads them until cutover)', async () => {
    const data = { ...LEGACY };
    await migrateLegacyPrefs({ storage: storage(data), prefs: createMemoryPrefs() });
    expect(data).toEqual(LEGACY);
  });
});

describe('what reads the migrated values', () => {
  it('the DSP starts at the owner\'s EQ and balance, and sends them to the audio path', async () => {
    const prefs = createMemoryPrefs();
    await migrateLegacyPrefs({ storage: storage(), prefs });
    const sent = /** @type {Array<[string, any]>} */ ([]);
    const dsp = await createTauriDsp(async (cmd, args) => { sent.push([cmd, args]); }, prefs);
    expect([...dsp.eq.gains()]).toEqual([0, 0, 3, 0, -5, 0, 0, 0, 6, 9]);
    expect(dsp.balance.get()).toBe(-20);
    expect(sent.map(([c]) => c).sort()).toEqual(['set_balance', 'set_eq']);
  });

  it('the zoom and the pins find the legacy values through their bare-key fallback', async () => {
    const prefs = createMemoryPrefs();
    await migrateLegacyPrefs({ storage: storage(), prefs });
    expect(parseZoom(prefs.peek('app').get('zoom'))).toBe(1.5);
    const win = createTestSkinWindow({ key: 'sha/main' });
    const pins = createPins({ win, prefs });
    expect(await pins.restore()).toEqual({ onTop: true, allDesktops: false });
  });

  it('the visualizer preset is the integer VizHost parses', async () => {
    const prefs = createMemoryPrefs();
    await migrateLegacyPrefs({ storage: storage(), prefs });
    expect(/^-?\d{1,9}$/.test(/** @type {string} */ (prefs.peek('mediacenter').get('effectPreset')))).toBe(true);
  });
});
