// @ts-check
// Sidecars (WAVES W3.8; ENGINE D10.6): the validator rejects what the schema does not name, refs are
// plain strings in Maps, `loadSidecar` checks the hash before it looks anything up, and the committed
// Headspace sidecar names elements that exist (the last block needs the owner's archive and skips
// without it; it writes nothing).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SIDECAR_CHARS, SIDECAR_SCHEMA, SIDECAR_SCHEMA_ID, SidecarError, loadSidecar, parseSidecar,
  sidecarAttrs, sidecarRefs, unsupportedKeywords, validateSidecar,
} from '../../src/app/sidecar.js';
import { attrSpecFor } from '../../src/engine/wms/attrs.js';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { probeImage } from '../../src/engine/image/probe.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { pickDefinition } from '../../src/engine/wms/select.js';
import { describeHeadspace } from '../support/fixtures.js';

/** SHA-256 of the owner's Headspace.wmz. The last block proves it against the archive when present. */
const HEADSPACE = '76a8662f469881bf5ed6eb93595042fdb188c65663135da6ff4dcd10b37bf85d';
const OTHER = 'ab'.repeat(32);
const DIR = new URL('../../src/app/sidecars/', import.meta.url);

/** @returns {any} a fresh copy of the committed sidecar, as plain JSON */
const committed = () => JSON.parse(readFileSync(new URL(`${HEADSPACE}.json`, DIR), 'utf8'));
/**
 * The committed Headspace `attrs`, in file order: the seek bar's host switch, then the PLAYLIST colours the
 * oracle's playlist.css paints (G3.F5). They apply in both configurations.
 */
const HEADSPACE_ATTRS = [
  { ref: 'seek', name: 'x-foregroundMode', value: 'playhead' },
  { ref: 'pl', name: 'backgroundColor', value: '#285F03' },
  { ref: 'pl', name: 'foregroundColor', value: '#FFFFFF' },
  { ref: 'pl', name: 'itemPlayingColor', value: '#A9FF2B' },
  { ref: 'pl', name: 'itemSelectedBackgroundColor', value: '#1C4702' },
];
/** @returns {any} the smallest valid sidecar */
const minimal = () => ({ schema: SIDECAR_SCHEMA_ID, skin: OTHER });

describe('the committed sidecars', () => {
  const files = readdirSync(DIR).filter((f) => !f.startsWith('.'));

  it('are named <sha256>.json, and each names its own file', () => {
    expect(files).toContain(`${HEADSPACE}.json`);
    for (const f of files) {
      expect(f).toMatch(/^[0-9a-f]{64}\.json$/);
      expect(JSON.parse(readFileSync(new URL(f, DIR), 'utf8')).skin).toBe(f.slice(0, -5));
    }
  });

  it.each(files)('%s validates', (f) => {
    const r = validateSidecar(JSON.parse(readFileSync(new URL(f, DIR), 'utf8')), { sha: f.slice(0, -5) });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('Headspace: ten EQ labels at x = 9 + 15i (parity D1), the two compat rows, restore, viewResize', () => {
    const r = validateSidecar(committed());
    const s = /** @type {NonNullable<typeof r.sidecar>} */ (r.sidecar);
    expect(s.overlays).toHaveLength(10);
    s.overlays?.forEach((o, i) => {
      expect(o.parent).toBe('sEqView');
      expect(o.attrs).toMatchObject({ left: 9 + 15 * i, top: 121, width: 15, fontSize: 5, foregroundColor: '#77CE07', justification: 'center' });
      expect(o.hostStyle).toEqual({ letterSpacing: '-0.3px' });
    });
    expect(s.overlays?.map((o) => o.attrs.value)).toEqual(['32', '63', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']);
    expect(s.attrs).toEqual(HEADSPACE_ATTRS);
    expect(s.compat?.attrs).toEqual([
      { ref: 'Unnamed_text_4', name: 'top', value: 129 },
      { ref: 'Unnamed_text_1', name: 'fontSize', value: 7 },
    ]);
    expect(s.actions).toEqual({ returnToMediaCenter: 'zoomToggle' });
    expect(s.restore).toEqual([
      { global: 'eqIsOpen', toggle: 'ToggleEqView', pref: 'eqOpen' },
      { global: 'plIsOpen', toggle: 'TogglePlView', pref: 'plOpen' },
    ]);
    expect(s.viewResize).toBe('ignore');
  });
});

describe('validateSidecar', () => {
  it('accepts the smallest sidecar and returns a copy', () => {
    const input = minimal();
    const r = validateSidecar(input);
    expect(r).toEqual({ ok: true, sidecar: input, problems: [] });
    expect(r.sidecar).not.toBe(input);
  });

  it.each([[null], [undefined], [42], ['text'], [true], [[]], [[minimal()]], [new Map()], [() => 0]])(
    'rejects a root that is not an object (%j) and never throws',
    (root) => {
      const r = validateSidecar(root);
      expect(r.ok).toBe(false);
      expect(r.sidecar).toBeNull();
      expect(r.problems.length).toBeGreaterThan(0);
    },
  );

  it('says what is missing', () => {
    const r = validateSidecar({});
    expect(r.problems.map((p) => p.message)).toEqual(['is missing "schema"', 'is missing "skin"']);
  });

  /** Each mutation plants one key the schema does not name, at a different depth. */
  const unknownKeyCases = /** @type {Array<[string, (s: any) => void, string]>} */ ([
    ['the top level', (s) => { s.extra = 1; }, '/extra'],
    ['an overlay', (s) => { s.overlays[0].extra = 1; }, '/overlays/0/extra'],
    ['an overlay hostStyle', (s) => { s.overlays[1].hostStyle.fontSize = '7px'; }, '/overlays/1/hostStyle/fontSize'],
    ['an attrs entry', (s) => { s.attrs[0].extra = 1; }, '/attrs/0/extra'],
    ['compat', (s) => { s.compat.extra = []; }, '/compat/extra'],
    ['a compat entry', (s) => { s.compat.attrs[1].extra = 1; }, '/compat/attrs/1/extra'],
    ['actions', (s) => { s.actions.onClose = 'none'; }, '/actions/onClose'],
    ['a restore entry', (s) => { s.restore[0].extra = 1; }, '/restore/0/extra'],
    ['the tour', (s) => { s.tour.extra = 1; }, '/tour/extra'],
    ['the tour rest point', (s) => { s.tour.rest.z = 1; }, '/tour/rest/z'],
    ['the tour toggle names', (s) => { s.tour.toggle.fx = 'f'; }, '/tour/toggle/fx'],
  ]);
  it.each(unknownKeyCases)('rejects an unknown key in %s', (_where, plant, path) => {
    const s = committed();
    plant(s);
    const r = validateSidecar(s);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual({ path, message: 'unknown key' });
  });

  describe('attribute names (attrs and compat.attrs)', () => {
    it('accepts an ordinary attribute name in attrs, not only in compat (the PLAYLIST colours)', () => {
      const s = committed();
      s.attrs.push({ ref: 'seek', name: 'top', value: 1 });
      const r = validateSidecar(s);
      expect(r.problems).toEqual([]);
      expect(r.sidecar?.attrs?.at(-1)).toEqual({ ref: 'seek', name: 'top', value: 1 });
    });

    it.each(['x-foregroundMode', 'X-Anything', 'x-a', 'itemPlayingColor', 'xforeground', 'constructor'])(
      'accepts %s in attrs and in compat (the x- test is case-insensitive, as attrs.js)',
      (name) => {
        const s = minimal();
        s.attrs = [{ ref: 'seek', name, value: 'playhead' }];
        s.compat = { attrs: [{ ref: 'seek', name, value: 'playhead' }] };
        expect(validateSidecar(s).problems).toEqual([]);
      },
    );

    it.each(['x-', 'x-1a', 'x_foreground', 'x-a b', '', '1top', '_top', '__proto__', 'item.playing', 'x-' + 'a'.repeat(65), 'a'.repeat(65)])(
      'rejects %j as an attribute name, in attrs and in compat',
      (name) => {
        const s = minimal();
        s.attrs = [{ ref: 'seek', name, value: 1 }];
        const r = validateSidecar(s);
        expect(r.ok).toBe(false);
        expect(r.problems.map((p) => p.path)).toEqual(['/attrs/0/name']);
        const t = minimal();
        t.compat = { attrs: [{ ref: 'seek', name, value: 1 }] };
        expect(validateSidecar(t).problems.map((p) => p.path)).toEqual(['/compat/attrs/0/name']);
      },
    );

    it('takes a colour as #RRGGBB text and an attribute value of any scalar type, and nothing structured', () => {
      const s = minimal();
      s.attrs = [
        { ref: 'pl', name: 'itemPlayingColor', value: '#A9FF2B' },
        { ref: 'pl', name: 'columnsVisible', value: false },
        { ref: 'pl', name: 'width', value: 172 },
      ];
      expect(validateSidecar(s).ok).toBe(true);
      s.attrs[0].value = { r: 1 };
      expect(validateSidecar(s).problems.map((p) => p.path)).toEqual(['/attrs/0/value']);
    });
  });

  describe('hostStyle', () => {
    /** @param {unknown} hostStyle */
    const withHostStyle = (hostStyle) => {
      const s = minimal();
      s.overlays = [{ parent: 'p', tag: 'text', attrs: { value: 'x' }, hostStyle }];
      return validateSidecar(s);
    };

    it.each(['color', 'fontFamily', 'cssText', 'letterspacing', '__proto__'])('rejects the key %s', (key) => {
      const hostStyle = JSON.parse(`{ "${key}": "-0.3px" }`);
      const r = withHostStyle(hostStyle);
      expect(r.ok).toBe(false);
      expect(r.problems).toEqual([{ path: `/overlays/0/hostStyle/${key}`, message: 'unknown key' }]);
    });

    it.each(['-0.3px', '0px', '1.5px', '12px', '-0.05em', 'normal'])('accepts letterSpacing %s', (v) => {
      expect(withHostStyle({ letterSpacing: v }).ok).toBe(true);
    });

    it.each(['1px; background: url(x)', 'url(x)', '1px }', '', '-.3px', '1000px', 'inherit', 5, null])('rejects letterSpacing %j', (v) => {
      expect(withHostStyle({ letterSpacing: v }).ok).toBe(false);
    });

    it('is optional, and the copy carries only letterSpacing', () => {
      const s = minimal();
      s.overlays = [{ parent: 'p', tag: 'text', attrs: {} }];
      const r = validateSidecar(s);
      expect(r.ok).toBe(true);
      expect(r.sidecar?.overlays?.[0]).not.toHaveProperty('hostStyle');
    });
  });

  describe('every other field', () => {
    /** @type {Array<[string, (s: any) => void, string]>} */
    const cases = [
      ['a wrong schema id', (s) => { s.schema = 'window_headmpd-sidecar/2'; }, '/schema'],
      ['an upper-case skin hash', (s) => { s.skin = s.skin.toUpperCase(); }, '/skin'],
      ['a short skin hash', (s) => { s.skin = s.skin.slice(1); }, '/skin'],
      ['a viewResize outside the enum', (s) => { s.viewResize = 'stretch'; }, '/viewResize'],
      ['an unknown returnToMediaCenter', (s) => { s.actions.returnToMediaCenter = 'zoom'; }, '/actions/returnToMediaCenter'],
      ['an overlay that is not text', (s) => { s.overlays[0].tag = 'button'; }, '/overlays/0/tag'],
      ['an overlay with no attrs', (s) => { delete s.overlays[0].attrs; }, '/overlays/0'],
      ['an overlay attribute that is an object', (s) => { s.overlays[0].attrs.value = { a: 1 }; }, '/overlays/0/attrs/value'],
      ['an overlay attribute that is an array', (s) => { s.overlays[0].attrs.value = [1]; }, '/overlays/0/attrs/value'],
      ['an overlay attribute over 256 characters', (s) => { s.overlays[0].attrs.value = 'x'.repeat(257); }, '/overlays/0/attrs/value'],
      ['an overlay attribute name with a space', (s) => { s.overlays[0].attrs['font size'] = 5; }, '/overlays/0/attrs/font size'],
      ['an overlay attribute named __proto__', (s) => { Object.defineProperty(s.overlays[0].attrs, '__proto__', { value: 1, enumerable: true }); }, '/overlays/0/attrs/__proto__'],
      ['an empty ref', (s) => { s.attrs[0].ref = ''; }, '/attrs/0/ref'],
      ['a ref with a control character', (s) => { s.attrs[0].ref = 'a\nb'; }, '/attrs/0/ref'],
      ['a ref over 128 characters', (s) => { s.attrs[0].ref = 'a'.repeat(129); }, '/attrs/0/ref'],
      ['a missing attribute value', (s) => { delete s.attrs[0].value; }, '/attrs/0'],
      ['a restore global that is not an identifier', (s) => { s.restore[0].global = 'eq-open'; }, '/restore/0/global'],
      ['a restore pref with a space', (s) => { s.restore[1].pref = 'pl open'; }, '/restore/1/pref'],
      ['nine tour bands', (s) => { s.tour.bands.pop(); }, '/tour/bands'],
      ['eleven tour bands', (s) => { s.tour.bands.push('eq11'); }, '/tour/bands'],
      ['a tour band that is a number', (s) => { s.tour.bands[3] = 4; }, '/tour/bands/3'],
      ['a tour colour without #', (s) => { s.tour.playColor = 'FFFF00'; }, '/tour/playColor'],
      ['a tour rest point off the page', (s) => { s.tour.rest.x = 5000; }, '/tour/rest/x'],
      ['a negative tour rest point', (s) => { s.tour.rest.y = -1; }, '/tour/rest/y'],
      ['a tour with a missing key', (s) => { delete s.tour.reset; }, '/tour'],
      ['overlays that is an object', (s) => { s.overlays = {}; }, '/overlays'],
      ['65 overlays', (s) => { s.overlays = Array.from({ length: 65 }, () => s.overlays[0]); }, '/overlays'],
    ];
    it.each(cases)('rejects %s', (_what, plant, path) => {
      const s = committed();
      plant(s);
      const r = validateSidecar(s);
      expect(r.ok).toBe(false);
      expect(r.problems.some((p) => p.path === path)).toBe(true);
    });
  });

  it('checks the skin against the hash it was loaded under', () => {
    expect(validateSidecar(minimal(), { sha: OTHER }).ok).toBe(true);
    const r = validateSidecar(minimal(), { sha: HEADSPACE });
    expect(r.ok).toBe(false);
    expect(r.problems[0].path).toBe('/skin');
  });

  it('reports at most 50 problems for a hostile file', () => {
    const s = minimal();
    for (let i = 0; i < 500; i++) s[`junk${i}`] = i;
    expect(validateSidecar(s).problems).toHaveLength(50);
  });

  it('returns a frozen deep copy that later edits of the input cannot reach', () => {
    const input = committed();
    const { sidecar } = validateSidecar(input);
    const s = /** @type {NonNullable<typeof sidecar>} */ (sidecar);
    input.overlays[0].attrs.value = 'changed';
    input.tour.bands[0] = 'changed';
    expect(s.overlays?.[0].attrs.value).toBe('32');
    expect(/** @type {any} */ (s.tour).bands[0]).toBe('eq1');
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.overlays)).toBe(true);
    expect(Object.isFrozen(s.overlays?.[0].attrs)).toBe(true);
    expect(Object.isFrozen(/** @type {any} */ (s.tour).bands)).toBe(true);
    expect(() => { /** @type {any} */ (s).viewResize = 'honor'; }).toThrow(TypeError);
  });

  it('keeps data-keyed maps null-prototype and fixed records plain', () => {
    const s = /** @type {NonNullable<ReturnType<typeof validateSidecar>['sidecar']>} */ (validateSidecar(committed()).sidecar);
    expect(Object.getPrototypeOf(/** @type {object} */ (s.overlays?.[0].attrs))).toBeNull();
    expect(Object.getPrototypeOf(s)).toBe(Object.prototype);
  });

  it('drops nothing it should keep and invents nothing', () => {
    const input = committed();
    expect(JSON.parse(JSON.stringify(validateSidecar(input).sidecar))).toEqual(input);
  });
});

describe('parseSidecar', () => {
  it('parses and validates JSON text', () => {
    expect(parseSidecar(JSON.stringify(minimal())).ok).toBe(true);
  });

  it.each(['', '{', 'undefined', '{"schema": }', '[1,2'])('says %j is not JSON', (text) => {
    const r = parseSidecar(text);
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toMatch(/not valid JSON/);
  });

  it('refuses text over the cap before parsing it', () => {
    const r = parseSidecar(' '.repeat(MAX_SIDECAR_CHARS + 1));
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toMatch(/cap/);
  });

  it('refuses a non-string', () => {
    expect(parseSidecar(/** @type {any} */ (minimal())).ok).toBe(false);
  });

  it('turns a "__proto__" key in the JSON into an unknown key, not a prototype', () => {
    const r = parseSidecar(`{ "schema": "${SIDECAR_SCHEMA_ID}", "skin": "${OTHER}", "__proto__": { "polluted": true } }`);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ path: '/__proto__', message: 'unknown key' }]);
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
  });
});

describe('refs are plain strings, in Maps (E §1 rule 6)', () => {
  const NAMES = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'prototype'];

  /** A sidecar that uses `name` as every kind of ref. @param {string} name */
  const withRef = (name) => {
    const s = committed();
    s.overlays[0].parent = name;
    s.attrs = [{ ref: name, name: 'x-foregroundMode', value: 'playhead' }];
    s.compat.attrs = [{ ref: name, name: 'top', value: 3 }];
    s.tour.reset = name;
    s.tour.bands[2] = name;
    return s;
  };

  it.each(NAMES)('%s is an ordinary ref in the validated sidecar', (name) => {
    const r = validateSidecar(withRef(name));
    expect(r.problems).toEqual([]);
    const s = /** @type {NonNullable<typeof r.sidecar>} */ (r.sidecar);
    expect(s.overlays?.[0].parent).toBe(name);
    expect(s.attrs?.[0].ref).toBe(name);
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(/** @type {any} */ ({}).polluted).toBeUndefined();
  });

  it.each(NAMES)('sidecarAttrs and sidecarRefs hold %s as a plain entry', (name) => {
    const s = /** @type {NonNullable<ReturnType<typeof validateSidecar>['sidecar']>} */ (validateSidecar(withRef(name)).sidecar);
    const attrs = sidecarAttrs(s, { compat: true });
    expect(attrs).toBeInstanceOf(Map);
    expect(attrs.get(name)).toEqual([{ name: 'x-foregroundMode', value: 'playhead' }, { name: 'top', value: 3 }]);
    expect([...attrs.keys()]).toEqual([name]);
    const refs = sidecarRefs(s);
    expect(refs).toBeInstanceOf(Map);
    expect(refs.get(name)).toEqual(expect.arrayContaining(['/overlays/0/parent', '/attrs/0/ref', '/compat/attrs/0/ref', '/tour/reset', '/tour/bands/2']));
    // A name that is not a ref does not appear just because Object.prototype has it.
    for (const other of NAMES.filter((n) => n !== name)) expect(attrs.has(other)).toBe(false);
  });

  it('a table that names no ref has no inherited ones', () => {
    const attrs = sidecarAttrs(/** @type {any} */ (validateSidecar(minimal()).sidecar), { compat: true });
    expect(attrs.size).toBe(0);
    for (const n of NAMES) expect(attrs.get(n)).toBeUndefined();
  });
});

describe('sidecarAttrs', () => {
  const s = /** @type {NonNullable<ReturnType<typeof validateSidecar>['sidecar']>} */ (validateSidecar(committed()).sidecar);

  /** The PLAYLIST colours, as sidecarAttrs lists them for `pl`. */
  const PLAYLIST = [
    { name: 'backgroundColor', value: '#285F03' },
    { name: 'foregroundColor', value: '#FFFFFF' },
    { name: 'itemPlayingColor', value: '#A9FF2B' },
    { name: 'itemSelectedBackgroundColor', value: '#1C4702' },
  ];

  it('without compat lists the attrs entries only: the seek switch and the PLAYLIST colours', () => {
    expect([...sidecarAttrs(s, { compat: false })]).toEqual([
      ['seek', [{ name: 'x-foregroundMode', value: 'playhead' }]],
      ['pl', PLAYLIST],
    ]);
  });

  it('with compat adds the compat entries after them, so the PLAYLIST colours are in both configurations', () => {
    expect([...sidecarAttrs(s, { compat: true })]).toEqual([
      ['seek', [{ name: 'x-foregroundMode', value: 'playhead' }]],
      ['pl', PLAYLIST],
      ['Unnamed_text_4', [{ name: 'top', value: 129 }]],
      ['Unnamed_text_1', [{ name: 'fontSize', value: 7 }]],
    ]);
  });

  it('the PLAYLIST colours are the ones the oracle paints (playlist.css), and nothing else of the playlist', () => {
    const colours = new Map(PLAYLIST.map((e) => [e.name, e.value.toLowerCase()]));
    expect(colours).toEqual(new Map([
      ['backgroundColor', '#285f03'],             // .wh-pl background fallback, style.css --drawer
      ['foregroundColor', '#ffffff'],             // #plList { color: #fff }
      ['itemPlayingColor', '#a9ff2b'],            // .row.now, --row-now
      ['itemSelectedBackgroundColor', '#1c4702'], // .row.sel, --row-sel
    ]));
    const css = readFileSync(new URL('../../src/app/widgets/playlist.css', import.meta.url), 'utf8');
    expect(css).toContain('var(--wh-pl-bg, #285f03)');
    expect(css).toContain('var(--wh-pl-now, #a9ff2b)');
    expect(css).toContain('var(--wh-pl-sel-bg, #1c4702)');
    // The selected row's text is not in the sidecar: the default itemSelectedColor is already white.
    expect(attrSpecFor('playlist', 'itemSelectedColor', 'sidecar')?.default).toBe(0xffffff);
  });

  it('keeps entries for one ref in file order, so the last of a name wins when applied in order', () => {
    const t = minimal();
    t.attrs = [{ ref: 'a', name: 'x-one', value: 1 }, { ref: 'a', name: 'x-one', value: 2 }];
    const r = sidecarAttrs(/** @type {any} */ (validateSidecar(t).sidecar), { compat: false });
    expect(r.get('a')).toEqual([{ name: 'x-one', value: 1 }, { name: 'x-one', value: 2 }]);
  });

  it('sidecarRefs lists the element refs and not the script names', () => {
    const refs = sidecarRefs(s);
    expect([...refs.keys()].sort()).toEqual([
      'Unnamed_button_4', 'Unnamed_buttongroup_2', 'Unnamed_text_1', 'Unnamed_text_4', 'bEqHandle', 'bPlHandle',
      'eq1', 'eq10', 'eq2', 'eq3', 'eq4', 'eq5', 'eq6', 'eq7', 'eq8', 'eq9', 'pl', 'sEqView', 'seek',
    ]);
    expect(refs.get('sEqView')).toHaveLength(10);
    expect(refs.get('pl')).toEqual(['/attrs/1/ref', '/attrs/2/ref', '/attrs/3/ref', '/attrs/4/ref']);
    expect(refs.has('ToggleEqView')).toBe(false);
    expect(refs.has('eqIsOpen')).toBe(false);
  });
});

describe('loadSidecar', () => {
  it('returns the validated sidecar for a hash whose source has one', async () => {
    const source = vi.fn(async () => minimal());
    const s = await loadSidecar(OTHER, source);
    expect(s).toEqual(minimal());
    expect(source).toHaveBeenCalledWith(OTHER);
  });

  it('returns null when the source has none (every skin but Headspace)', async () => {
    expect(await loadSidecar(OTHER, async () => undefined)).toBeNull();
    expect(await loadSidecar(OTHER, async () => null)).toBeNull();
  });

  it.each(['', 'abc', HEADSPACE.toUpperCase(), HEADSPACE.slice(1), `${HEADSPACE}0`, '../etc/passwd', '__proto__', 'constructor', 'toString', ` ${HEADSPACE}`])(
    'returns null for %j without asking the source',
    async (sha) => {
      const source = vi.fn(async () => minimal());
      expect(await loadSidecar(sha, source)).toBeNull();
      expect(source).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, 5, {}, []])('returns null for a hash that is not a string (%j)', async (sha) => {
    expect(await loadSidecar(/** @type {any} */ (sha), async () => minimal())).toBeNull();
  });

  it('throws a SidecarError listing the problems when the file does not validate', async () => {
    const bad = { ...minimal(), overlays: 'nope' };
    const e = await loadSidecar(OTHER, async () => bad).catch((err) => err);
    expect(e).toBeInstanceOf(SidecarError);
    expect(e.name).toBe('SidecarError');
    expect(e.sha).toBe(OTHER);
    expect(e.problems).toEqual([{ path: '/overlays', message: 'must be array, not "nope"' }]);
    expect(e.message).toContain(OTHER.slice(0, 12));
    expect(e.message).toContain('/overlays must be array');
  });

  it('throws when the file names another skin than the hash it was found under', async () => {
    const e = await loadSidecar(HEADSPACE, async () => minimal()).catch((err) => err);
    expect(e).toBeInstanceOf(SidecarError);
    expect(e.problems[0].path).toBe('/skin');
  });

  it('lets a failing source fail', async () => {
    await expect(loadSidecar(OTHER, async () => { throw new Error('disk'); })).rejects.toThrow('disk');
  });

  describe('the committed files, through the bundler glob', () => {
    it('finds the Headspace sidecar by its hash', async () => {
      const s = await loadSidecar(HEADSPACE);
      expect(s).toEqual(committed());
      expect(Object.isFrozen(s)).toBe(true);
    });

    it('finds none for any other hash', async () => {
      expect(await loadSidecar(OTHER)).toBeNull();
      expect(await loadSidecar('constructor')).toBeNull();
      expect(await loadSidecar('__proto__')).toBeNull();
    });
  });
});

describe('the schema file', () => {
  it('uses only keywords the validator implements', () => {
    expect(unsupportedKeywords(SIDECAR_SCHEMA)).toEqual([]);
  });

  it('is found out when it does not', () => {
    expect(unsupportedKeywords({ type: 'object', allOf: [] })).toEqual(['#: unsupported keyword "allOf"']);
    expect(unsupportedKeywords({ properties: { a: { oneOf: [] } } })).toEqual(['#/properties/a: unsupported keyword "oneOf"']);
    expect(unsupportedKeywords({ $defs: { a: { $ref: '#/x', type: 'string' } } })).toEqual(['#/$defs/a: $ref with sibling keywords (type)']);
    expect(unsupportedKeywords({ items: { patternProperties: {} } })).toEqual(['#/items: unsupported keyword "patternProperties"']);
  });

  it('has no unused definitions and no dangling $ref', () => {
    const text = JSON.stringify(SIDECAR_SCHEMA);
    const defs = Object.keys(/** @type {any} */ (SIDECAR_SCHEMA).$defs);
    for (const name of defs) expect(text, name).toContain(`"#/$defs/${name}"`);
    for (const m of text.matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)) expect(defs).toContain(m[1]);
  });

  it('names the same top-level keys as the contract\'s Sidecar', () => {
    expect(Object.keys(/** @type {any} */ (SIDECAR_SCHEMA).properties).sort()).toEqual(
      ['actions', 'attrs', 'compat', 'overlays', 'restore', 'schema', 'skin', 'tour', 'viewResize'],
    );
  });
});

describeHeadspace('the Headspace sidecar against the built model (G3: every ref resolves)', (headspace) => {
  /** @param {string} name */
  const build = async (name) => {
    const vfs = await openVfs(headspace.bytes(), name);
    const picked = /** @type {NonNullable<ReturnType<typeof pickDefinition>>} */ (pickDefinition(vfs));
    const raw = scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read(picked.wms))).text).root;
    const sidecar = /** @type {NonNullable<ReturnType<typeof validateSidecar>['sidecar']>} */ (validateSidecar(committed()).sidecar);
    const theme = buildTheme(/** @type {any} */ (raw), vfs, {
      probe: (ref) => { const b = vfs.read(ref); return b ? probeImage(b) : null; },
      overlays: sidecar.overlays ? [...sidecar.overlays] : undefined,
    });
    return { vfs, sidecar, view: theme.views[0], theme };
  };

  it('is the sidecar of this archive: the file name is its SHA-256', async () => {
    const { vfs, sidecar } = await build('Headspace.wmz');
    expect(vfs.sha).toBe(HEADSPACE);
    expect(sidecar.skin).toBe(vfs.sha);
  });

  it('every overlay parent, attribute ref and tour element exists on the built model', async () => {
    const { sidecar, view } = await build('Headspace.wmz');
    const missing = [...sidecarRefs(sidecar)].filter(([ref]) => !view.byId(ref)).map(([ref, at]) => `${ref} (${at.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('refs are of the kinds the sidecar says they are', async () => {
    const { sidecar, view } = await build('Headspace.wmz');
    const kind = (/** @type {string} */ id) => view.byId(id)?.kind;
    const tour = /** @type {any} */ (sidecar.tour);
    expect(kind('sEqView')).toBe('subview');
    expect(kind('seek')).toBe('slider');
    expect(kind('pl')).toBe('playlist');
    expect(kind('Unnamed_text_1')).toBe('text');
    expect(kind('Unnamed_text_4')).toBe('text');
    expect(view.byId('Unnamed_text_4')?.get('value')).toBe('reset');
    expect(kind(tour.transport)).toBe('buttongroup');
    expect(kind(tour.visNext)).toBe('button');
    expect(view.byId(tour.visNext)?.get('upToolTip')).toBe('Next visualization');
    expect(tour.bands.map(kind)).toEqual(Array(10).fill('slider'));
    expect(kind(tour.eqHandle)).toBe('button');
    expect(kind(tour.plHandle)).toBe('button');
  });

  it('the transport group owns the two mapping colours the tour aims at', async () => {
    const { sidecar, view } = await build('Headspace.wmz');
    const tour = /** @type {any} */ (sidecar.tour);
    const colours = view.byId(tour.transport)?.children.map((c) => Number(c.get('mappingColor')));
    expect(colours).toContain(parseInt(tour.playColor.slice(1), 16));
    expect(colours).toContain(parseInt(tour.visColor.slice(1), 16));
  });

  it('the skin declares the playlist\'s own colours and leaves the item colours at the WMP defaults', async () => {
    const { view } = await build('Headspace.wmz');
    const pl = /** @type {NonNullable<ReturnType<typeof view.byId>>} */ (view.byId('pl'));
    expect(pl.get('backgroundColor')).toBe(0x285f03);
    expect(pl.get('foregroundColor')).toBe(0xffffff);
    expect(pl.source('itemPlayingColor')).toBeUndefined();
    expect(pl.source('itemSelectedBackgroundColor')).toBeUndefined();
    expect(pl.get('itemPlayingColor')).toBe(0x00ff00);
    expect(pl.get('itemSelectedBackgroundColor')).toBe(0x0a246a);
  });

  it.each([false, true])('the sidecar attrs, written under origin sidecar (compat %s), give the PLAYLIST the oracle\'s colours', async (compat) => {
    const { sidecar, view } = await build('Headspace.wmz');
    const resetTop = view.byId('Unnamed_text_4')?.get('top');
    for (const [ref, writes] of sidecarAttrs(sidecar, { compat })) {
      for (const { name, value } of writes) {
        const el = /** @type {NonNullable<ReturnType<typeof view.byId>>} */ (view.byId(ref));
        const changed = el.set(name, value, 'sidecar');
        // A write the element model refuses, or coerces to nothing, leaves the old value and reports false;
        // the only write allowed to be a no-op is a restatement of what the skin already says.
        const restated = ref === 'pl' && (name === 'backgroundColor' || name === 'foregroundColor');
        expect(changed || restated, `${ref}.${name}`).toBe(true);
      }
    }
    const pl = /** @type {NonNullable<ReturnType<typeof view.byId>>} */ (view.byId('pl'));
    expect(pl.get('backgroundColor')).toBe(0x285f03);
    expect(pl.get('foregroundColor')).toBe(0xffffff);
    expect(pl.get('itemPlayingColor')).toBe(0xa9ff2b);
    expect(pl.get('itemSelectedBackgroundColor')).toBe(0x1c4702);
    expect(pl.get('itemSelectedColor')).toBe(0xffffff);
    expect(view.byId('seek')?.get('x-foregroundMode')).toBe('playhead');
    // compat.attrs reach the model only in the oracle-compat configuration
    expect(view.byId('Unnamed_text_4')?.get('top')).toBe(compat ? 129 : resetTop);
    expect(resetTop).not.toBe(129);
  });

  it('the notice colour fallback is the first TEXT whose foregroundColor the skin declared: #77CE07, the oracle\'s --label', async () => {
    const { view, sidecar } = await build('Headspace.wmz');
    const first = view.elements.find((e) => e.kind === 'text' && e.source('foregroundColor') !== undefined);
    expect(first).toBeDefined();
    expect(first?.get('foregroundColor')).toBe(0x77ce07);
    // The sidecar's own labels come after every literal element, so they cannot be the first.
    const labels = new Set(view.elements.slice(-/** @type {number} */ (sidecar.overlays?.length)));
    expect(labels.has(/** @type {any} */ (first))).toBe(false);
  });

  it('the x- attribute resolves for the sidecar and for nobody else', () => {
    expect(attrSpecFor('slider', 'x-foregroundMode', 'sidecar')?.name).toBe('x-foregroundMode');
    expect(attrSpecFor('slider', 'x-foregroundMode', 'script')).toBeUndefined();
    expect(attrSpecFor('slider', 'x-foregroundMode', 'init')).toBeUndefined();
  });

  it('the ten labels are appended under sEqView, after every skin element, with the sidecar\'s values', async () => {
    const { sidecar, view } = await build('Headspace.wmz');
    const added = view.elements.slice(-10);
    expect(added.map((e) => e.parent?.id)).toEqual(Array(10).fill('sEqView'));
    expect(added.map((e) => e.kind)).toEqual(Array(10).fill('text'));
    expect(added.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `Unnamed_text_${5 + i}`));
    added.forEach((e, i) => {
      const want = /** @type {NonNullable<typeof sidecar.overlays>} */ (sidecar.overlays)[i].attrs;
      expect(e.get('left')).toBe(want.left);
      expect(e.get('value')).toBe(want.value);
      expect(e.get('fontSize')).toBe(5);
    });
  });

  it('every script name the sidecar uses is declared by the skin\'s script', async () => {
    const { vfs, sidecar } = await build('Headspace.wmz');
    const script = decodeText(/** @type {Uint8Array} */ (vfs.read('headspace.js'))).text;
    const tour = /** @type {any} */ (sidecar.tour);
    const functions = [...(sidecar.restore ?? []).map((r) => r.toggle), ...Object.values(tour.toggle)];
    const globals = [...(sidecar.restore ?? []).map((r) => r.global), ...Object.values(tour.isOpen)];
    for (const f of /** @type {string[]} */ (functions)) expect(script, f).toMatch(new RegExp(`function\\s+${f}\\s*\\(`));
    for (const g of /** @type {string[]} */ (globals)) expect(script, g).toMatch(new RegExp(`var\\s+${g}\\s*=`));
  });
});
