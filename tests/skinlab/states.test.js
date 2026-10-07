import { describe, expect, it } from 'vitest';
import config from '../../tools/skinlab/vite.config.js';
import { SKINLAB_DIR, REPO_ROOT } from '../../tools/skinlab/paths.mjs';
import path from 'node:path';
import {
  MEDIA_PRESET_NAMES,
  hasMediaPreset,
  mediaPreset,
  queuePairs,
  queueRecords,
  statusPairs,
} from '../../tools/skinlab/media-presets.js';
import {
  BOOT_QUIET_MS,
  CLIP,
  DEFAULT_STATE_IDS,
  DPRS,
  EMULATED_MASKS,
  PARK,
  POINTS,
  S5_POINTS,
  SETTLE,
  SKIN_SIZE,
  STATES,
  STEP_KINDS,
  VIEWPORT,
  parseDprs,
  parseStateIds,
  resolveStep,
} from '../../tools/skinlab/states.mjs';
import { computeRegions } from '../../tools/skinlab/regions.mjs';
import { describeHeadspace } from '../support/fixtures.js';

const S5_NAMES = ['g0.minimize', 'g0.close', 'g1.prev', 'g1.play', 'g1.stop', 'g1.next', 'g1.vis'];
const S5_IDS = S5_NAMES.flatMap((n) => [`S5.${n}.hover`, `S5.${n}.down`]);

describe('the state table', () => {
  it('has the legacy-side states of E D9, in order', () => {
    expect(DEFAULT_STATE_IDS).toEqual(['S1', 'S2', 'S3', 'S3b', 'S4', ...S5_IDS, 'S6', 'S7']);
    expect(DEFAULT_STATE_IDS).toEqual([...STATES.keys()]);
  });

  it('only references media presets and click points that exist', () => {
    for (const s of STATES.values()) {
      expect(hasMediaPreset(s.media), `${s.id} media`).toBe(true);
      for (const step of s.steps) expect(() => resolveStep(step), `${s.id} ${JSON.stringify(step)}`).not.toThrow();
    }
  });

  it('uses the E D9 setups', () => {
    const at = (id) => STATES.get(id);
    expect(at('S1').steps).toEqual([]);
    expect(at('S2').steps).toEqual([{ click: 'eqHandle' }]);
    expect(at('S3').media).toBe('stoppedQueue5');
    expect(at('S3').steps).toEqual([{ click: 'plHandle' }]);
    expect(at('S3b').media).toBe('stoppedQueue12');
    expect(at('S3b').steps).toEqual([{ click: 'plHandle' }]);
    expect(at('S4').steps).toEqual([{ click: 'visElement' }]);
    expect(at('S6').media).toBe('playing');
    expect(at('S6').steps).toEqual([]);
  });

  it('waits for the transition the state animates, and for none where nothing moves', () => {
    for (const id of ['S2', 'S3', 'S3b']) expect(STATES.get(id).settle).toEqual({ kind: 'transition', selector: '.ear', property: 'left' });
    expect(STATES.get('S4').settle).toEqual({ kind: 'transition', selector: '#visDrop', property: 'top' });
    expect(STATES.get('S1').settle).toEqual({ kind: 'none' });
    expect(STATES.get('S6').settle).toEqual({ kind: 'none' });
  });

  it('keeps S7 report-only, frozen 60 ms into the EQ ear transition', () => {
    const s7 = STATES.get('S7');
    expect(s7.reportOnly).toBe(true);
    expect(s7.settle).toMatchObject({ kind: 'freeze', atMs: 60, selector: '.ear', property: 'left' });
    for (const s of STATES.values()) if (s.id !== 'S7' && !s.id.startsWith('S5.')) expect(s.reportOnly, s.id).toBe(false);
  });

  it('table entries are frozen', () => {
    for (const s of STATES.values()) expect(Object.isFrozen(s)).toBe(true);
  });
});

describe('S5 hover and press states (E D9, supplemental)', () => {
  it('has a hover and a pressed state for each of the 7 regions.mjs points, between S4 and S6', () => {
    expect(Object.keys(S5_POINTS)).toEqual(S5_NAMES);
    expect(DEFAULT_STATE_IDS.filter((id) => id.startsWith('S5.'))).toEqual(S5_IDS);
    const ids = [...STATES.keys()];
    expect(ids.indexOf('S5.g0.minimize.hover')).toBe(ids.indexOf('S4') + 1);
    expect(ids.indexOf('S5.g1.vis.down')).toBe(ids.indexOf('S6') - 1);
  });

  it('hover moves the pointer there, pressed holds the button down, on the stopped empty player (stop: playing)', () => {
    for (const name of S5_NAMES) {
      const hover = STATES.get(`S5.${name}.hover`);
      const down = STATES.get(`S5.${name}.down`);
      expect(hover.steps, hover.id).toEqual([{ move: name }]);
      expect(down.steps, down.id).toEqual([{ down: name }]);
      for (const s of [hover, down]) {
        // The legacy disables stop while stopped, so only a playing capture shows its hover and pressed art.
        expect(s.media, s.id).toBe(name === 'g1.stop' ? 'playing' : 'stoppedEmpty');
        expect(s.settle, s.id).toEqual({ kind: 'none' });
        expect(s.reportOnly, s.id).toBe(true);
      }
    }
  });

  it('pins the 7 points as printed by regions.mjs', () => {
    expect(S5_POINTS).toEqual({
      'g0.minimize': { x: 369, y: 12 },
      'g0.close': { x: 384, y: 12 },
      'g1.prev': { x: 321, y: 43 },
      'g1.play': { x: 346, y: 43 },
      'g1.stop': { x: 372, y: 43 },
      'g1.next': { x: 397, y: 43 },
      'g1.vis': { x: 439, y: 43 },
    });
    for (const p of Object.values(S5_POINTS)) {
      expect(p.x).toBeLessThan(PARK.x);
      expect(p.y).toBeLessThan(PARK.y);
    }
  });

  it('keeps S5 ids out of the bare "S5" spelling: ids are explicit', () => {
    expect(() => parseStateIds('S5')).toThrow(/unknown state/);
    expect(parseStateIds('S5.g1.play.down,S5.g1.play.hover,S1')).toEqual(['S1', 'S5.g1.play.hover', 'S5.g1.play.down']);
  });

  describeHeadspace('against the computed regions', (headspace) => {
    it('S5_POINTS equal the points computeRegions derives from the skin', async () => {
      const regions = await computeRegions(headspace.bytes(), { name: 'Headspace.wmz' });
      const computed = Object.fromEntries(regions.s5.map((p) => [`g${p.group}.${p.label}`, { x: p.x, y: p.y }]));
      expect(S5_POINTS).toEqual(computed);
    });
  });
});

describe('the step vocabulary', () => {
  it('has click, move and down', () => {
    expect(STEP_KINDS).toEqual(['click', 'move', 'down']);
  });

  it('resolves click against POINTS, and move and down against POINTS or S5_POINTS', () => {
    expect(resolveStep({ click: 'eqHandle' })).toEqual({ kind: 'click', name: 'eqHandle', at: POINTS.eqHandle });
    expect(resolveStep({ move: 'g1.play' })).toEqual({ kind: 'move', name: 'g1.play', at: S5_POINTS['g1.play'] });
    expect(resolveStep({ down: 'g1.play' })).toEqual({ kind: 'down', name: 'g1.play', at: { x: 346, y: 43 } });
    expect(resolveStep({ move: 'eqHandle' }).at).toEqual(POINTS.eqHandle);
  });

  it('refuses a click on an S5 point, unknown points, Object.prototype names and anything but one kind', () => {
    expect(() => resolveStep({ click: 'g1.play' })).toThrow(/unknown point/);
    for (const bad of ['nope', '__proto__', 'constructor', 'toString']) {
      for (const kind of STEP_KINDS) expect(() => resolveStep({ [kind]: bad }), `${kind} ${bad}`).toThrow(/unknown point/);
    }
    expect(() => resolveStep({})).toThrow(/exactly one/);
    expect(() => resolveStep({ move: 'g1.play', down: 'g1.play' })).toThrow(/exactly one/);
    expect(() => resolveStep({ move: 42 })).toThrow(/unknown point/);
  });
});

describe('click points, park point and geometry', () => {
  // parity 0.5: EQ handle (215,152) 18x66, PL handle (523,151) 18x67, transport group (309,31) 144x25.
  it('click the centres of the handles (parity 0.5)', () => {
    expect(POINTS.eqHandle).toEqual({ x: 215 + 9, y: 152 + 33 });
    expect(POINTS.plHandle).toEqual({ x: 523 + 9, y: 151 + 33 });
  });

  it('click inside the transport group (the vis element)', () => {
    expect(POINTS.visElement.x).toBeGreaterThanOrEqual(309);
    expect(POINTS.visElement.x).toBeLessThan(309 + 144);
    expect(POINTS.visElement.y).toBeGreaterThanOrEqual(31);
    expect(POINTS.visElement.y).toBeLessThan(31 + 25);
  });

  it('matches the numbers the card names', () => {
    expect(POINTS).toEqual({ eqHandle: { x: 224, y: 185 }, plHandle: { x: 532, y: 184 }, visElement: { x: 440, y: 44 } });
    expect(PARK).toEqual({ x: 755, y: 390 });
  });

  it('parks inside the viewport and the clip, and the viewport has a margin', () => {
    expect(PARK.x).toBeLessThan(CLIP.width);
    expect(PARK.y).toBeLessThan(CLIP.height);
    expect(CLIP).toEqual({ x: 0, y: 0, width: 760, height: 394 });
    expect(SKIN_SIZE).toEqual({ width: 760, height: 394 });
    expect(VIEWPORT.width).toBeGreaterThan(SKIN_SIZE.width);
    expect(VIEWPORT.height).toBeGreaterThan(SKIN_SIZE.height);
    expect(DPRS).toEqual([1, 2]);
  });

  it('settles on 200 ms and two rAF, after the 300 ms boot timer', () => {
    expect(SETTLE.afterMs).toBe(200);
    expect(SETTLE.rafs).toBe(2);
    expect(BOOT_QUIET_MS).toBeGreaterThan(300);
  });
});

describe('parseStateIds', () => {
  it('defaults to every state', () => {
    expect(parseStateIds(undefined)).toEqual(DEFAULT_STATE_IDS);
    expect(parseStateIds('')).toEqual(DEFAULT_STATE_IDS);
  });

  it('keeps table order and drops duplicates', () => {
    expect(parseStateIds('S4,S1,S4')).toEqual(['S1', 'S4']);
    expect(parseStateIds(' S3b , S2 ')).toEqual(['S2', 'S3b']);
  });

  it('rejects unknown ids, including Object.prototype names', () => {
    for (const bad of ['S5', 's1', 'S2b', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'S1,nope']) {
      expect(() => parseStateIds(bad), bad).toThrow(/unknown state/);
    }
    expect(Object.prototype.polluted).toBeUndefined();
  });
});

describe('parseDprs', () => {
  it('defaults to 1 and 2, and sorts', () => {
    expect(parseDprs(undefined)).toEqual([1, 2]);
    expect(parseDprs('2,1')).toEqual([1, 2]);
    expect(parseDprs('2')).toEqual([2]);
    expect(parseDprs('1,1')).toEqual([1]);
  });

  it('rejects anything else', () => {
    for (const bad of ['3', '1.5', 'x', '0']) expect(() => parseDprs(bad), bad).toThrow(/unsupported dpr/);
  });
});

describe('the parity 4.1 emulated masks', () => {
  it('are the numbers of the card, with S1 and S4 identical', () => {
    expect(EMULATED_MASKS.get('S1').popcount).toBe(89328);
    expect(EMULATED_MASKS.get('S2').popcount).toBe(122636);
    expect(EMULATED_MASKS.get('S3').popcount).toBe(123258);
    expect(EMULATED_MASKS.get('S4').popcount).toBe(89328);
    expect(EMULATED_MASKS.get('S4')).toEqual(EMULATED_MASKS.get('S1'));
    expect(EMULATED_MASKS.get('S2').bbox).toEqual({ x0: 0, y0: 0, x1: 548, y1: 393 });
    expect(EMULATED_MASKS.get('S3').bbox).toEqual({ x0: 207, y0: 0, x1: 759, y1: 393 });
  });

  it('give S3b, S6 and S7 no reference', () => {
    for (const id of ['S3b', 'S6', 'S7']) expect(EMULATED_MASKS.has(id), id).toBe(false);
  });
});

describe('media presets (parity 4.1)', () => {
  it('has the four presets', () => {
    expect(MEDIA_PRESET_NAMES).toEqual(['stoppedEmpty', 'stoppedQueue5', 'stoppedQueue12', 'playing']);
  });

  it('stopped states report state stop, volume 50', () => {
    expect(Object.fromEntries(statusPairs('stoppedEmpty'))).toEqual({ state: 'stop', volume: '50' });
    expect(Object.fromEntries(statusPairs('stoppedQueue5'))).toEqual({ state: 'stop', volume: '50', playlist: '1', playlistlength: '5', song: '1' });
    expect(Object.fromEntries(statusPairs('stoppedQueue12'))).toMatchObject({ playlistlength: '12', song: '1' });
  });

  it('playing has elapsed 0 and no duration, so the seek thumb cannot drift', () => {
    const s = Object.fromEntries(statusPairs('playing'));
    expect(s).toEqual({ state: 'play', volume: '50', elapsed: '0' });
    expect(s.duration).toBeUndefined();
    expect(s.song).toBeUndefined();
  });

  it('queues have five and twelve records, the first five shared', () => {
    expect(queueRecords('stoppedEmpty')).toHaveLength(0);
    const five = queueRecords('stoppedQueue5');
    const twelve = queueRecords('stoppedQueue12');
    expect(five).toHaveLength(5);
    expect(twelve).toHaveLength(12);
    expect(twelve.slice(0, 5)).toEqual(five);
    expect(new Set(twelve.map((r) => r.file)).size).toBe(12);
  });

  it('exercise truncation and the h:mm:ss branch', () => {
    const twelve = queueRecords('stoppedQueue12');
    expect(twelve.some((r) => r.Title.length > 40)).toBe(true);
    expect(twelve.some((r) => Number(r.Time) >= 3600)).toBe(true);
  });

  it('queue pairs are flat key/value pairs with each record starting at `file` (player.js records())', () => {
    const pairs = queuePairs('stoppedQueue5');
    expect(pairs.every((p) => Array.isArray(p) && p.length === 2 && typeof p[1] === 'string')).toBe(true);
    expect(pairs.filter(([k]) => k === 'file')).toHaveLength(5);
    expect(pairs[0][0]).toBe('file');
  });

  it('refuses names that are not presets, including Object.prototype names', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'nope']) {
      expect(hasMediaPreset(bad), bad).toBe(false);
      expect(() => mediaPreset(bad), bad).toThrow(/unknown media preset/);
    }
  });
});

describe('vite viz swap (the pinned src/viz/index.js stays untouched)', () => {
  const plugin = config.plugins.find((p) => p.name === 'skinlab-viz-stub');
  const main = path.join(REPO_ROOT, 'src', 'main.js');
  const stub = path.join(SKINLAB_DIR, 'viz-stub.js');

  it('maps the viz entry however it is spelled', () => {
    expect(plugin.resolveId('./viz/index.js', main)).toBe(stub);
    expect(plugin.resolveId('/src/viz/index.js', main)).toBe(stub);
    expect(plugin.resolveId(path.join(REPO_ROOT, 'src/viz/index.js'), main)).toBe(stub);
    expect(plugin.resolveId('./index.js', path.join(REPO_ROOT, 'src/viz/ring.js'))).toBe(stub);
    expect(plugin.resolveId('./viz/index.js?t=1', `${main}?t=1`)).toBe(stub);
  });

  it('leaves every other import alone', () => {
    expect(plugin.resolveId('./widgets.js', main)).toBeNull();
    expect(plugin.resolveId('./viz/chorus.js', main)).toBeNull();
    expect(plugin.resolveId('three', path.join(REPO_ROOT, 'src/viz/index.js'))).toBeNull();
    expect(plugin.resolveId('@tauri-apps/api/core', main)).toBeNull();
    expect(plugin.resolveId('./viz/index.js', undefined)).toBeNull();
  });

  it('serves from the repo root with no dependency discovery', () => {
    expect(config.root).toBe(REPO_ROOT);
    expect(config.optimizeDeps.noDiscovery).toBe(true);
    expect(config.server.hmr).toBe(false);
  });
});
