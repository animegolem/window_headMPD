// The engine-side state table of `skinlab check` after W5.1: S3, S3b, S5, S6 and S7 join S1, S2, S2b
// and S4, `--state S5` stands for its fourteen members, and `--browser` names a known browser. Pure
// tables and parsers; nothing here starts a browser.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_STATES, parseBrowser, parseConfigList, parseEngineStateIds } from '../../tools/skinlab/cmd-check.mjs';
import { SKINLAB_DIR } from '../../tools/skinlab/paths.mjs';
import { POINTS, S5_POINTS, S5_STATE_IDS, STATES, STATE_GROUPS, expandStateGroups, resolveStep } from '../../tools/skinlab/states.mjs';

const S5_NAMES = ['g0.minimize', 'g0.close', 'g1.prev', 'g1.play', 'g1.stop', 'g1.next', 'g1.vis'];
const S5_IDS = S5_NAMES.flatMap((n) => [`S5.${n}.hover`, `S5.${n}.down`]);
const ALL = ['S1', 'S2', 'S2b', 'S3', 'S3b', 'S4', ...S5_IDS, 'S6', 'S7'];

describe('the engine state table', () => {
  it('has every state of E D9 in order, S2b right after S2', () => {
    expect([...ENGINE_STATES.keys()]).toEqual(ALL);
  });

  it('compares each state with the legacy golden of the same setup', () => {
    for (const s of ENGINE_STATES.values()) {
      expect(STATES.has(s.legacy), `${s.id} legacy`).toBe(true);
      expect(s.media, `${s.id} media`).toBe(STATES.get(s.legacy).media);
      if (s.id === 'S2b') continue;
      expect(s.legacy).toBe(s.id);
      expect(s.steps, `${s.id} steps are the legacy's`).toBe(STATES.get(s.id).steps);
    }
    expect(ENGINE_STATES.get('S2b')).toMatchObject({ legacy: 'S2', steps: [{ call: 'ToggleEqView' }] });
  });

  it('reaches S3, S3b and S5 by real input on points that exist', () => {
    expect(ENGINE_STATES.get('S3')).toMatchObject({ media: 'stoppedQueue5', steps: [{ click: 'plHandle' }] });
    expect(ENGINE_STATES.get('S3b')).toMatchObject({ media: 'stoppedQueue12', steps: [{ click: 'plHandle' }] });
    for (const id of S5_IDS) {
      const s = ENGINE_STATES.get(id);
      expect(s.steps, id).toHaveLength(1);
      const { kind, at } = resolveStep(s.steps[0]);
      expect(kind, id).toBe(id.endsWith('.hover') ? 'move' : 'down');
      expect(Object.values(S5_POINTS).some((p) => p === at), id).toBe(true);
    }
    expect(Object.keys(POINTS)).toContain('plHandle');
    expect(ENGINE_STATES.get('S6')).toMatchObject({ media: 'playing', steps: [] });
  });

  it('keeps S7 report-only and the clock-only settle, and nothing else', () => {
    expect([...ENGINE_STATES.values()].filter((s) => s.reportOnly).map((s) => s.id)).toEqual(['S7']);
    // settled() waits for tweens to finish, which a stopped manual clock never lets happen mid-slide.
    expect(ENGINE_STATES.get('S7').settle).toEqual({ kind: 'advance', ms: 60 });
    for (const s of ENGINE_STATES.values()) if (s.id !== 'S7') expect(s.settle, s.id).toEqual({ kind: 'settled' });
  });
});

describe('--state', () => {
  it('defaults to every state', () => {
    expect(parseEngineStateIds(undefined)).toEqual(ALL);
    expect(parseEngineStateIds('')).toEqual(ALL);
  });

  it('expands S5 to its fourteen states and still takes them one by one', () => {
    expect(S5_STATE_IDS).toEqual(S5_IDS);
    expect(parseEngineStateIds('S5')).toEqual(S5_IDS);
    expect(parseEngineStateIds('S5.g1.play.hover')).toEqual(['S5.g1.play.hover']);
    // The acceptance command's list, in the order given by the table and once each.
    expect(parseEngineStateIds('S6,S5,S1,S2b,S3b,S3,S4,S2,S5.g0.close.down')).toEqual(['S1', 'S2', 'S2b', 'S3', 'S3b', 'S4', ...S5_IDS, 'S6']);
    expect(parseEngineStateIds('S4, S2b')).toEqual(['S2b', 'S4']);
    expect(parseEngineStateIds('S7')).toEqual(['S7']);
  });

  it('refuses anything else, and treats prototype names as unknown', () => {
    for (const bad of ['S8', 'S5.', 'S5.g1.play', 'S5.g9.play.hover', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'S1,nope']) {
      expect(() => parseEngineStateIds(bad), bad).toThrow(/unknown engine state/);
    }
    expect(() => parseEngineStateIds(',')).toThrow(/--state is empty/);
  });

  it('keeps group lookups to the groups: prototype names expand to themselves', () => {
    expect(STATE_GROUPS.has('S5')).toBe(true);
    expect([...STATE_GROUPS.keys()]).toEqual(['S5']);
    expect(expandStateGroups(['__proto__', 'constructor', 'toString', 'S1'])).toEqual(['__proto__', 'constructor', 'toString', 'S1']);
    expect(expandStateGroups(['S1', 'S5', 'S6'])).toEqual(['S1', ...S5_IDS, 'S6']);
  });
});

describe('--browser and --config', () => {
  it('is chromium unless webkit is asked for', () => {
    expect(parseBrowser(undefined)).toBe('chromium');
    expect(parseBrowser('')).toBe('chromium');
    expect(parseBrowser('chromium')).toBe('chromium');
    expect(parseBrowser('webkit')).toBe('webkit');
    for (const bad of ['firefox', 'Chromium', 'constructor', '__proto__']) expect(() => parseBrowser(bad), bad).toThrow(/unknown browser/);
  });

  it('still parses the configurations', () => {
    expect(parseConfigList(undefined)).toEqual(['compat', 'faithful']);
    expect(parseConfigList('faithful')).toEqual(['faithful']);
    for (const bad of ['constructor', '__proto__', 'strict']) expect(() => parseConfigList(bad), bad).toThrow(/unknown config/);
  });
});

describe('the engine page mount', () => {
  const source = readFileSync(path.join(SKINLAB_DIR, 'engine-mount.js'), 'utf8');

  it('injects the real playlist widget, not the blank placeholder', () => {
    expect(source).toMatch(/import \{ mountPlaylist \} from '\.\.\/\.\.\/src\/app\/widgets\/playlist\.js'/);
    expect(source).toMatch(/PLAYLIST_FACTORY = \(el, media, attrs, win\) => mountPlaylist\(el, media, attrs, win\)/);
    expect(source).toMatch(/slots: \{ playlist: PLAYLIST_FACTORY \}/);
    expect(source).not.toMatch(/PLAYLIST_FACTORY = undefined/);
  });

  it('exposes the bare clock for the mid-animation state', () => {
    expect(source).toMatch(/advance\(ms\) \{\s*state\.host\.clock\.advance\(ms\);\s*\}/);
  });
});
