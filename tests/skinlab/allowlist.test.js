import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_PATH,
  ALLOWLIST_SCHEMA,
  AllowlistError,
  CONFIGS,
  GENERATORS,
  activeEntries,
  materialize,
  parseAllowlist,
  readAllowlist,
  strictViolations,
} from '../../tools/skinlab/allowlist.mjs';
import { ENGINE_STATES, parseConfigList, parseEngineStateIds } from '../../tools/skinlab/cmd-check.mjs';
import { parseWithin } from '../../tools/skinlab/cmd-diff.mjs';
import { popcount, rectMask } from '../../tools/skinlab/diff.mjs';
import { POINTS, STATES } from '../../tools/skinlab/states.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/** One valid entry, overridden per test. */
const entry = (over = {}) => ({
  id: 'e',
  kind: 'pixel',
  configs: ['faithful'],
  states: 'all',
  region: { kind: 'rect', rect: [0, 0, 4, 3] },
  bound: 5,
  exact: false,
  ref: 'x',
  why: 'y',
  ...over,
});
const file = (...entries) => JSON.stringify({ schema: ALLOWLIST_SCHEMA, entries });

describe('the committed allow-list (E 9)', () => {
  const list = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const at = (id) => list.entries.get(id);

  it('has exactly the seven entries of E 9, in its order', () => {
    expect([...list.entries.keys()]).toEqual([
      'effects-hole',
      'U-23-showBackground',
      'D20-reset-y',
      'D21-preset-title',
      'U-10-slider-travel',
      'D11-screen-corners',
      'button-transparency',
    ]);
  });

  it('names the same ids as the table in ENGINE.md section 9', () => {
    const text = readFileSync(path.join(REPO, 'docs', 'design', 'ENGINE.md'), 'utf8');
    const section = text.slice(text.indexOf('## 9. Deviations allow-list'), text.indexOf('## 10. Caps and budgets'));
    const ids = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
    expect(ids).toEqual([...list.entries.keys()]);
  });

  it('carries the kinds, configurations, states and regions of the table', () => {
    const row = (id) => {
      const e = at(id);
      return [e.kind, e.configs.join('+'), e.states === 'all' ? 'all' : e.states.join('+'), e.region.kind === 'rect' ? e.region.rect : e.region.generator];
    };
    expect(row('effects-hole')).toEqual(['pixel-exclusion', 'compat+faithful', 'all', 'effects-hole']);
    expect(row('U-23-showBackground')).toEqual(['pixel', 'faithful', 'all', 'unowned-buttongroup']);
    expect(row('D20-reset-y')).toEqual(['pixel', 'faithful', 'S2+S2b', [222, 221, 258, 238]]);
    expect(row('D21-preset-title')).toEqual(['pixel', 'faithful', 'S4', [321, 65, 426, 82]]);
    expect(row('U-10-slider-travel')).toEqual(['pixel', 'faithful', 'all', 'sliders']);
    expect(row('D11-screen-corners')).toEqual(['mask', 'compat+faithful', 'all', 'screen-corners']);
    expect(row('button-transparency')).toEqual(['mask', 'faithful', 'all', 'faithful-xor-compat']);
  });

  it('carries the bounds E 9 states, and null only where it says "measured at G4"', () => {
    expect(at('effects-hole')).toMatchObject({ bound: 31487, exact: true });
    expect(at('D11-screen-corners')).toMatchObject({ bound: 106, exact: true });
    expect(at('U-10-slider-travel')).toMatchObject({ bound: 0, exact: false });
    // "rect area", half-open: (258-222) x (238-221) and (426-321) x (82-65)
    expect(at('D20-reset-y').bound).toBe(36 * 17);
    expect(at('D21-preset-title').bound).toBe(105 * 17);
    expect(at('U-23-showBackground').bound).toBeNull();
    expect(at('button-transparency').bound).toBeNull();
    expect([...list.entries.values()].filter((e) => e.bound === null).map((e) => e.id)).toEqual(['U-23-showBackground', 'button-transparency']);
  });

  it('gives every entry its deviation reference and its reason', () => {
    for (const e of list.entries.values()) {
      expect(e.ref, e.id).toBeTruthy();
      expect(e.why, e.id).toBeTruthy();
    }
  });

  it('rects of the table are the ones its own numbers imply: the D21 title is the text box (321,65) 105 wide', () => {
    // parity 0.5: preset title at drop (30,6), width 105; drop open at (291,59): (321,65) to x 426.
    expect(at('D21-preset-title').region.rect.slice(0, 3)).toEqual([321, 65, 321 + 105]);
  });

  it('selects the entries of a configuration and state', () => {
    const ids = (config, state) => activeEntries(list, { config, state }).map((e) => e.id);
    expect(ids('compat', 'S1')).toEqual(['effects-hole', 'D11-screen-corners']);
    expect(ids('compat', 'S2b')).toEqual(['effects-hole', 'D11-screen-corners']);
    expect(ids('faithful', 'S1')).toEqual(['effects-hole', 'U-23-showBackground', 'U-10-slider-travel', 'D11-screen-corners', 'button-transparency']);
    expect(ids('faithful', 'S2')).toContain('D20-reset-y');
    expect(ids('faithful', 'S2b')).toContain('D20-reset-y');
    expect(ids('faithful', 'S2')).not.toContain('D21-preset-title');
    expect(ids('faithful', 'S4')).toContain('D21-preset-title');
    expect(ids('faithful', 'S4')).not.toContain('D20-reset-y');
  });

  it('treats a state id from the command line as plain data: __proto__ and constructor select only the "all" entries', () => {
    for (const state of ['__proto__', 'constructor', 'toString']) {
      expect(activeEntries(list, { config: 'faithful', state }).map((e) => e.id), state).toEqual(['effects-hole', 'U-23-showBackground', 'U-10-slider-travel', 'D11-screen-corners', 'button-transparency']);
    }
    expect(() => activeEntries(list, { config: '__proto__', state: 'S1' })).toThrow(AllowlistError);
  });

  it('strict mode refuses exactly the entries still in measure mode', () => {
    expect(strictViolations(activeEntries(list, { config: 'compat', state: 'S1' }))).toEqual([]);
    const v = strictViolations(activeEntries(list, { config: 'faithful', state: 'S2b' }));
    expect(v).toHaveLength(2);
    expect(v[0]).toMatch(/^U-23-showBackground: bound is null/);
    expect(v[1]).toMatch(/^button-transparency: bound is null/);
    expect(strictViolations([{ id: 'x', bound: 0 }])).toEqual([]);
  });

  it('every computed generator it names is one the tools can produce', () => {
    for (const e of list.entries.values()) {
      if (e.region.kind === 'computed') expect(GENERATORS.has(e.region.generator), e.id).toBe(true);
    }
    expect(CONFIGS).toEqual(['compat', 'faithful']);
  });

  it('readAllowlist reads the same file', async () => {
    expect([...(await readAllowlist()).entries.keys()]).toEqual([...list.entries.keys()]);
  });
});

describe('materialize', () => {
  it('generates one mask per entry in the order given, rects by the rect generator', () => {
    const list = parseAllowlist(
      file(
        entry({ id: 'r', region: { kind: 'rect', rect: [1, 1, 3, 2] }, bound: 'rect-area' }),
        entry({ id: 'c', kind: 'mask', region: { kind: 'computed', generator: 'screen-corners' }, bound: 2, exact: true }),
      ),
    );
    const asked = [];
    const out = materialize([...list.entries.values()], {
      width: 5,
      height: 4,
      rect: (r) => rectMask(5, 4, r),
      computed: (g, e) => {
        asked.push([g, e.id]);
        return rectMask(5, 4, [0, 0, 2, 1]);
      },
    });
    expect(out.map((e) => [e.id, e.kind, e.bound, e.exact])).toEqual([['r', 'pixel', 2, false], ['c', 'mask', 2, true]]);
    expect(popcount(out[0].mask)).toBe(2);
    expect(popcount(out[1].mask)).toBe(2);
    expect(asked).toEqual([['screen-corners', 'c']]);
  });
});

describe('validation', () => {
  const bad = (text, message) => {
    expect(() => parseAllowlist(text)).toThrow(AllowlistError);
    expect(() => parseAllowlist(text)).toThrow(message);
  };

  it('refuses text that is not the schema', () => {
    bad('{', /not valid JSON/);
    bad('[]', /not an object/);
    bad(JSON.stringify({ schema: 'nope', entries: [] }), /schema is "nope"/);
    bad(JSON.stringify({ schema: ALLOWLIST_SCHEMA, entries: {} }), /entries must be an array/);
    bad(file(null), /not an object/);
  });

  it('refuses a malformed entry, naming it', () => {
    bad(file(entry({ id: '' })), /id must be a non-empty string/);
    bad(file(entry(), entry()), /duplicate entry id "e"/);
    bad(file(entry({ kind: 'region' })), /entry "e": kind must be one of/);
    bad(file(entry({ configs: [] })), /configs must be a non-empty list/);
    bad(file(entry({ configs: ['both'] })), /configs must be a non-empty list/);
    bad(file(entry({ configs: ['compat', 'compat'] })), /repeats a name/);
    bad(file(entry({ states: [] })), /states must be "all" or a non-empty list/);
    bad(file(entry({ states: 'S1' })), /states must be "all" or a non-empty list/);
    bad(file(entry({ region: undefined })), /region is missing/);
    bad(file(entry({ region: { kind: 'blob' } })), /region.kind must be "rect" or "computed"/);
    bad(file(entry({ region: { kind: 'rect', rect: [0, 0, 0, 5] } })), /rect must be \[x0, y0, x1, y1\]/);
    bad(file(entry({ region: { kind: 'rect', rect: [0, 0, 5] } })), /rect must be/);
    bad(file(entry({ region: { kind: 'rect', rect: [-1, 0, 5, 5] } })), /rect must be/);
    bad(file(entry({ region: { kind: 'computed', generator: 'constructor' } })), /unknown region generator "constructor"/);
    bad(file(entry({ kind: 'mask', region: { kind: 'computed', generator: 'sliders' } })), /generator sliders produces pixel regions, not mask/);
    bad(file(entry({ bound: -1 })), /bound must be a non-negative integer/);
    bad(file(entry({ bound: 1.5 })), /bound must be a non-negative integer/);
    bad(file(entry({ bound: 'many' })), /bound must be a non-negative integer/);
    bad(file(entry({ bound: 'rect-area', region: { kind: 'computed', generator: 'sliders' } })), /"rect-area" needs a rect region/);
    bad(file(entry({ exact: 'yes' })), /exact must be true or false/);
    bad(file(entry({ exact: true, bound: null })), /an exact entry needs a bound/);
    bad(file(entry({ kind: 'pixel-exclusion', states: ['S1'], region: { kind: 'computed', generator: 'effects-hole' } })), /an exclusion applies to every state/);
    bad(file(entry({ ref: '' })), /ref \(the deviation reference\) is required/);
    bad(file(entry({ why: undefined })), /why is required/);
  });

  it('accepts the shapes it documents, resolving "rect-area"', () => {
    const list = parseAllowlist(file(entry({ bound: 'rect-area', region: { kind: 'rect', rect: [2, 3, 7, 9] } }), entry({ id: 'n', bound: null }), entry({ id: 'z', bound: 0 })));
    expect([...list.entries.values()].map((e) => e.bound)).toEqual([30, null, 0]);
  });

  it('keys entries by id in a Map: an id of __proto__ or constructor is just an id', () => {
    const list = parseAllowlist(file(entry({ id: '__proto__' }), entry({ id: 'constructor' })));
    expect([...list.entries.keys()]).toEqual(['__proto__', 'constructor']);
    expect(list.entries.get('__proto__').id).toBe('__proto__');
    expect(Object.getPrototypeOf(list.entries)).toBe(Map.prototype);
    expect(activeEntries(list, { config: 'faithful', state: 'S1' })).toHaveLength(2);
  });
});

describe('the check command tables (cmd-check, cmd-diff)', () => {
  it('has the engine-side states of the W2.7 card, S2b being the skin-driven S2', () => {
    expect([...ENGINE_STATES.keys()]).toEqual(['S1', 'S2', 'S2b', 'S4']);
    expect(ENGINE_STATES.get('S2b')).toMatchObject({ legacy: 'S2', steps: [{ call: 'ToggleEqView' }], media: 'stoppedEmpty' });
    for (const id of ['S1', 'S2', 'S4']) {
      // the same real clicks as the legacy: the steps come from states.mjs, not from a copy
      expect(ENGINE_STATES.get(id).steps, id).toBe(STATES.get(id).steps);
      expect(ENGINE_STATES.get(id).legacy).toBe(id);
      for (const step of ENGINE_STATES.get(id).steps) expect(Object.hasOwn(POINTS, step.click)).toBe(true);
    }
    for (const s of ENGINE_STATES.values()) expect(STATES.has(s.legacy), s.id).toBe(true);
  });

  it('parses --state and --config, and treats unknown names as plain strings, not members', () => {
    expect(parseEngineStateIds(undefined)).toEqual(['S1', 'S2', 'S2b', 'S4']);
    expect(parseEngineStateIds('S4, S2b')).toEqual(['S2b', 'S4']);
    for (const bad of ['S3', 'S5', 'constructor', '__proto__', 'toString', 'S1,nope']) expect(() => parseEngineStateIds(bad), bad).toThrow(/unknown engine state/);
    expect(() => parseEngineStateIds(',')).toThrow(/--state is empty/);
    expect(parseConfigList(undefined)).toEqual(['compat', 'faithful']);
    expect(parseConfigList('all')).toEqual(['compat', 'faithful']);
    expect(parseConfigList('faithful')).toEqual(['faithful']);
    expect(parseConfigList('faithful,compat')).toEqual(['compat', 'faithful']);
    for (const bad of ['both', 'constructor', '__proto__']) expect(() => parseConfigList(bad), bad).toThrow(/unknown config/);
  });

  it('parses --within as a half-open rect', () => {
    expect(parseWithin('0,86,476,256')).toEqual([0, 86, 476, 256]);
    expect(parseWithin(' 1, 2 ,3,4')).toEqual([1, 2, 3, 4]);
    for (const bad of ['1,2,3', '1,2,3,x', '5,0,5,9', '0,5,9,5', '1.5,0,9,9']) expect(() => parseWithin(bad), bad).toThrow(/--within takes/);
  });
});
