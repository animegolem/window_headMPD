// PaletteService phase-1 tiers (ENGINE.md §5.9, D12): the `local` wrapper, the `default` palette, the
// stale-result guard of main.js:439-445 and the one polar-OKLCH lerp. The song source is the test
// host's fake MediaModel; `invoke` is a stand-in whose replies the test settles by hand, so the race
// cases are ordered exactly.
//
// No lookup keyed by a skin string is built here (colours are parsed, never looked up), so the
// `__proto__` / `constructor` rule does not apply.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMedia, presetQueue } from '../../src/hosts/test/media.js';
import { clustersFromReply, fetchLocalPalette } from '../../src/app/palette/local.js';
import { hexToOklch, lerp, oklchToHex, parseHex } from '../../src/app/palette/lerp.js';
import { createPaletteService, DEFAULT_HEXES, DEFAULT_SNAPSHOT } from '../../src/app/palette/service.js';

const QUEUE = presetQueue('stoppedQueue5');
const [SONG_A, SONG_B, SONG_C] = [QUEUE[0], QUEUE[1], QUEUE[2]];

/** One Rust `Swatch` per hex, shares descending, oklch from the real conversion. */
const swatches = (...hexes) => hexes.map((hex, i) => ({ hex, share: 1 / (i + 2), oklch: hexToOklch(hex) }));
const REPLY_A = swatches('#102030', '#c04030', '#e0e0a0');
const REPLY_B = swatches('#204010', '#30c0a0');

/** A promise the test settles later. */
function deferred() {
  /** @type {(v: unknown) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** An `invoke` whose `palette` replies are pending until `settle(file)`; every call is recorded. */
function slowInvoke() {
  /** @type {Array<[string, any]>} */ const calls = [];
  /** @type {Array<{ file: string, d: ReturnType<typeof deferred> }>} */ const pending = [];
  const invoke = (cmd, args) => {
    calls.push([cmd, args]);
    const d = deferred();
    pending.push({ file: args?.file, d });
    return d.promise;
  };
  /** Settle the oldest unsettled call for `file`. */
  const take = (file) => {
    const i = pending.findIndex((p) => p.file === file);
    if (i < 0) throw new Error(`no pending palette call for ${file}`);
    return pending.splice(i, 1)[0].d;
  };
  return {
    invoke,
    calls,
    resolve: async (file, reply) => { take(file).resolve(reply); await flush(); },
    reject: async (file, err = new Error('no art')) => { take(file).reject(err); await flush(); },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Service plus a log of every snapshot it announced. */
function setup(presetName = 'stoppedQueue5') {
  const media = createFakeMedia(presetName);
  const fake = slowInvoke();
  const svc = createPaletteService(media, fake.invoke, { now: () => Date.UTC(2026, 9, 6, 12, 0, 0) });
  /** @type {any[]} */ const seen = [];
  svc.subscribe((s) => seen.push(s));
  return { media, svc, seen, ...fake };
}

/** The two tiers' fixed claims, whatever else is in the snapshot. */
const expectNoClaims = (s) => {
  expect(s.roles).toBeNull();
  expect(s.guarantees).toEqual([]);
};

afterEach(() => vi.restoreAllMocks());

describe('default tier', () => {
  it('is the visualizer\'s red-to-violet, in its order', () => {
    const src = readFileSync(new URL('../../src/viz/index.js', import.meta.url), 'utf8');
    const m = /const DEFAULT_PALETTE = \[([^\]]+)\]/.exec(src);
    expect(m).not.toBeNull();
    const vizHexes = [...(m?.[1] ?? '').matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((x) => x[1]);
    expect(vizHexes.length).toBe(4);
    expect([...DEFAULT_HEXES]).toEqual(vizHexes);
  });

  it('is a complete, frozen snapshot with real OKLCH triples and equal shares', () => {
    const s = DEFAULT_SNAPSHOT;
    expect(s.source).toBe('default');
    expect(s.association).toBe('default');
    expect(s.track).toBeNull();
    expectNoClaims(s);
    expect(s.clusters.map((c) => c.hex)).toEqual([...DEFAULT_HEXES]);
    for (const c of s.clusters) {
      expect(c.oklch).toEqual(hexToOklch(c.hex));
      expect(c.share).toBeCloseTo(0.25, 12);
      expect(Object.isFrozen(c)).toBe(true);
    }
    expect(s.clusters.reduce((n, c) => n + c.share, 0)).toBeCloseTo(1, 12);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.clusters)).toBe(true);
    expect(Object.isFrozen(s.guarantees)).toBe(true);
  });

  it('is what a new service reports, with no call to Rust while no song is current', () => {
    const { svc, calls } = setup('stoppedEmpty');
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    expect(calls).toEqual([]);
  });
});

describe('local tier', () => {
  it('a song change asks Rust for that file and publishes the swatches as clusters', async () => {
    const { media, svc, seen, calls, resolve } = setup();
    media.set({ song: SONG_A });
    expect(calls).toEqual([['palette', { file: SONG_A.file }]]);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);                 // the old palette stays until the reply
    await resolve(SONG_A.file, REPLY_A);

    const s = svc.snapshot();
    expect(seen).toEqual([s]);
    expect(s.source).toBe('local');
    expect(s.association).toBe('current-uri');
    expect(s.track).toEqual({ uri: SONG_A.file, generatedAt: '2026-10-06T12:00:00.000Z' });
    expect(s.clusters).toEqual(REPLY_A.map(({ hex, share, oklch }) => ({ hex, share, oklch })));
    expectNoClaims(s);
    expect(Object.isFrozen(s) && Object.isFrozen(s.clusters) && Object.isFrozen(s.clusters[0])).toBe(true);
  });

  it('a service created while a song is already current looks at it straight away', async () => {
    const media = createFakeMedia('stoppedQueue5');
    media.set({ song: SONG_B });
    const fake = slowInvoke();
    const svc = createPaletteService(media, fake.invoke);
    expect(fake.calls).toEqual([['palette', { file: SONG_B.file }]]);
    await fake.resolve(SONG_B.file, REPLY_B);
    expect(svc.snapshot().source).toBe('local');
    expect(svc.snapshot().track?.uri).toBe(SONG_B.file);
  });

  it('only a song change asks Rust; other media changes do not', async () => {
    const { media, calls } = setup();
    media.set({ playState: 'play', volume: 20, elapsed: 5 });
    media.set({ queueVersion: 9, queueLength: 6 });
    media.emit(['playState', 'queueVersion']);                     // announced without a change
    expect(calls).toEqual([]);
  });

  it('every song event asks again, as main.js did, and each reply is published', async () => {
    const { media, svc, calls, resolve } = setup();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    media.emit(['song']);                                          // same song re-announced
    expect(calls.length).toBe(2);
    await resolve(SONG_A.file, REPLY_B);
    expect(svc.snapshot().clusters.map((c) => c.hex)).toEqual(['#204010', '#30c0a0']);
  });

  it('a song with no file is the default without a call to Rust', async () => {
    const { media, svc, calls } = setup();
    media.set({ song: { ...SONG_A, file: '' } });
    expect(calls).toEqual([]);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
  });
});

describe('stale-result guard', () => {
  it('a slow reply for an older song never replaces the newer one', async () => {
    const { media, svc, seen, resolve } = setup();
    media.set({ song: SONG_A });                                   // A asked, slow
    media.set({ song: SONG_B });                                   // B asked
    await resolve(SONG_B.file, REPLY_B);
    const afterB = svc.snapshot();
    expect(afterB.track?.uri).toBe(SONG_B.file);

    await resolve(SONG_A.file, REPLY_A);                           // A finally answers
    expect(svc.snapshot()).toBe(afterB);
    expect(seen).toEqual([afterB]);
  });

  it('an older reply that lands before the newer song\'s is dropped too', async () => {
    const { media, svc, seen, resolve } = setup();
    media.set({ song: SONG_A });
    media.set({ song: SONG_B });
    await resolve(SONG_A.file, REPLY_A);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);                 // nothing published for A
    expect(seen).toEqual([]);
    await resolve(SONG_B.file, REPLY_B);
    expect(svc.snapshot().track?.uri).toBe(SONG_B.file);
  });

  it('a slow rejection for an older song does not knock out the newer palette', async () => {
    const { media, svc, resolve, reject } = setup();
    media.set({ song: SONG_A });
    media.set({ song: SONG_B });
    await resolve(SONG_B.file, REPLY_B);
    const afterB = svc.snapshot();
    await reject(SONG_A.file);
    expect(svc.snapshot()).toBe(afterB);
  });

  it('a song that comes round again is answered once: its first reply is stale', async () => {
    const { media, svc, seen, calls, resolve } = setup();
    media.set({ song: SONG_A });
    media.set({ song: SONG_B });
    media.set({ song: SONG_A });
    expect(calls.map(([, a]) => a.file)).toEqual([SONG_A.file, SONG_B.file, SONG_A.file]);
    await resolve(SONG_A.file, REPLY_B);                           // the first A call
    expect(seen).toEqual([]);
    await resolve(SONG_B.file, REPLY_B);
    expect(seen).toEqual([]);
    await resolve(SONG_A.file, REPLY_A);                           // the second A call
    expect(seen.length).toBe(1);
    expect(svc.snapshot().clusters.map((c) => c.hex)).toEqual(['#102030', '#c04030', '#e0e0a0']);
  });

  it('the song going away publishes the default at once and drops the reply still out', async () => {
    const { media, svc, seen, resolve } = setup();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    media.set({ song: SONG_B });                                   // B in flight, A's palette showing
    media.set({ song: null });
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    expect(seen.length).toBe(2);                                   // A's palette, then the default
    await resolve(SONG_B.file, REPLY_B);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    expect(seen.length).toBe(2);
  });
});

describe('fallback to the default', () => {
  it('a rejected call publishes the default over the previous song\'s palette', async () => {
    const { media, svc, seen, resolve, reject } = setup();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    media.set({ song: SONG_B });
    await reject(SONG_B.file);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    expect(seen.map((s) => s.source)).toEqual(['local', 'default']);
  });

  it('a rejected call while already on the default announces nothing', async () => {
    const { media, svc, seen, reject } = setup();
    media.set({ song: SONG_A });
    await reject(SONG_A.file);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    expect(seen).toEqual([]);
  });

  it('an invoke that throws synchronously is a rejection', async () => {
    const media = createFakeMedia('stoppedQueue5');
    const svc = createPaletteService(media, () => { throw new Error('IPC gone'); });
    media.set({ song: SONG_A });
    await flush();
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
  });

  it.each([
    ['an empty array', []],
    ['null', null],
    ['an object', { hex: '#ffffff' }],
    ['entries without usable fields', [{ hex: 'red', share: 1, oklch: [0, 0, 0] }, { hex: '#ffffff', share: NaN, oklch: [0, 0, 0] }, 7, null]],
  ])('%s as the reply is the default', async (_name, reply) => {
    const { media, svc, resolve } = setup();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, reply);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
  });
});

describe('guarantees and roles, every tier', () => {
  it('are [] and null in every snapshot a service ever announces', async () => {
    const { media, svc, seen, resolve, reject } = setup();
    expectNoClaims(svc.snapshot());
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    media.set({ song: SONG_B });
    await resolve(SONG_B.file, REPLY_B);
    media.set({ song: SONG_C });
    await reject(SONG_C.file);
    media.set({ song: null });
    expect(seen.map((s) => s.source)).toEqual(['local', 'local', 'default']);
    for (const s of [...seen, svc.snapshot(), DEFAULT_SNAPSHOT]) expectNoClaims(s);
  });
});

describe('subscription', () => {
  it('unsubscribe stops notifications and is idempotent; a second subscribe is independent', async () => {
    const { media, svc, resolve } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const offA = svc.subscribe(a);
    svc.subscribe(b);
    offA();
    offA();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('the same function subscribed twice is two handles', async () => {
    const { media, svc, resolve } = setup();
    const cb = vi.fn();
    const off1 = svc.subscribe(cb);
    svc.subscribe(cb);
    off1();
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber is reported and does not stop the others', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { media, svc, resolve } = setup();
    const after = vi.fn();
    svc.subscribe(() => { throw new Error('consumer bug'); });
    svc.subscribe(after);
    media.set({ song: SONG_A });
    await resolve(SONG_A.file, REPLY_A);
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(svc.snapshot().source).toBe('local');
  });

  it('rejects a non-function callback', () => {
    const { svc } = setup();
    expect(() => svc.subscribe(/** @type {any} */ (null))).toThrow(TypeError);
  });

  it('dispose stops listening to the media model and discards a reply still out', async () => {
    const { media, svc, seen, calls, resolve } = setup();
    media.set({ song: SONG_A });
    svc.dispose();
    await resolve(SONG_A.file, REPLY_A);
    expect(svc.snapshot()).toBe(DEFAULT_SNAPSHOT);
    media.set({ song: SONG_B });
    expect(calls.length).toBe(1);
    expect(seen).toEqual([]);
  });

  it('exposes the one blessed lerp', () => {
    expect(setup().svc.lerp).toBe(lerp);
  });
});

describe('local reply checking', () => {
  it('keeps the usable entries in order, lower-cases hex, and copies the triple', () => {
    const triple = [0.5, 0.1, 40];
    const out = clustersFromReply([
      { hex: '#AABBCC', share: 0.6, oklch: triple },
      { hex: '#abc', share: 0.2, oklch: triple },                  // short hex: Rust never sends it
      { hex: '#112233', share: -1, oklch: triple },
      { hex: '#112233', share: 0.1, oklch: [1, 2] },
      { hex: '#112233', share: 0.1, oklch: [1, 2, Infinity] },
      { hex: '#445566', share: 0.4, oklch: [0.4, 0.05, 200], extra: 'ignored' },
    ]);
    expect(out).toEqual([
      { hex: '#aabbcc', share: 0.6, oklch: [0.5, 0.1, 40] },
      { hex: '#445566', share: 0.4, oklch: [0.4, 0.05, 200] },
    ]);
    triple[0] = 9;
    expect(out[0].oklch[0]).toBe(0.5);
    expect(Object.isFrozen(out[0].oklch)).toBe(true);
  });

  it('throws when nothing is usable', () => {
    expect(() => clustersFromReply([])).toThrow(TypeError);
    expect(() => clustersFromReply('nope')).toThrow(TypeError);
    expect(() => clustersFromReply([{ hex: 'x' }])).toThrow(TypeError);
  });

  it('fetchLocalPalette passes the file to the `palette` command', async () => {
    const invoke = vi.fn(async () => REPLY_B);
    const s = await fetchLocalPalette(invoke, 'a/b.flac', () => 0);
    expect(invoke).toHaveBeenCalledWith('palette', { file: 'a/b.flac' });
    expect(s.track).toEqual({ uri: 'a/b.flac', generatedAt: '1970-01-01T00:00:00.000Z' });
    expect(s.clusters.length).toBe(2);
  });
});

// ---- lerp --------------------------------------------------------------------------------------

const hex2 = (n) => n.toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
/** Smallest angle between two hues, degrees. */
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('colour conversion', () => {
  it('matches known OKLCH values (white, black, sRGB red, a mid grey)', () => {
    const [wl, wc] = hexToOklch('#ffffff');
    expect(wl).toBeCloseTo(1, 6);
    expect(wc).toBeLessThan(1e-6);
    expect(hexToOklch('#000000')).toEqual([0, 0, 0]);
    const [rl, rc, rh] = hexToOklch('#ff0000');
    expect(rl).toBeCloseTo(0.628, 3);
    expect(rc).toBeCloseTo(0.2577, 3);
    expect(rh).toBeCloseTo(29.23, 1);
    const [gl, gc, gh] = hexToOklch('#808080');
    expect(gl).toBeCloseTo(0.5999, 3);
    expect(gc).toBeLessThan(1e-6);
    expect(gh).toBe(0);                                            // powerless hue reads as 0
  });

  it('survives hex to OKLCH and back for 140,608 sRGB colours', () => {
    let bad = 0;
    for (let r = 0; r < 256; r += 5) {
      for (let g = 0; g < 256; g += 5) {
        for (let b = 0; b < 256; b += 5) {
          const hex = rgbHex(r, g, b);
          const [L, C, h] = hexToOklch(hex);
          if (oklchToHex(L, C, h) !== hex) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it('every grey reads as hueless', () => {
    for (let i = 0; i < 256; i++) expect(hexToOklch(rgbHex(i, i, i))[1]).toBeLessThan(1e-6);
  });

  it('compresses chroma, not lightness or hue, when a colour is outside sRGB', () => {
    const out = oklchToHex(0.7, 0.4, 150);                         // far outside sRGB
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    const [L, C, h] = hexToOklch(out);
    expect(L).toBeCloseTo(0.7, 1);
    expect(C).toBeLessThan(0.4);
    expect(hueGap(h, 150)).toBeLessThan(3);
  });

  it('parseHex takes #rgb and #rrggbb in any case and nothing else', () => {
    expect(parseHex('#FA0')).toEqual([255, 170, 0]);
    expect(parseHex('#ffAA00')).toEqual([255, 170, 0]);
    for (const bad of ['', 'ffaa00', '#ffaa0', '#ffaa000', '#ffaa00ff', '#gggggg', 'red', null, undefined, 12, {}]) {
      expect(parseHex(bad)).toBeNull();
    }
  });
});

describe('lerp', () => {
  const PAIRS = [
    ['#ff2020', '#3a6bff'], ['#000000', '#ffffff'], ['#808080', '#ff0000'], ['#00ffff', '#ff0000'],
    ['#102030', '#e0e0a0'], ['#8a3cff', '#e0307a'], ['#123456', '#123457'],
  ];

  it('lerp(a, a, t) is a, for every t', () => {
    for (const [a] of PAIRS) for (const t of [-1, 0, 0.1, 0.5, 0.999, 1, 2, NaN]) expect(lerp(a, a, t)).toBe(a);
  });

  it('the endpoints are exact', () => {
    for (const [a, b] of PAIRS) {
      expect(lerp(a, b, 0)).toBe(a);
      expect(lerp(a, b, 1)).toBe(b);
    }
  });

  it('clamps t, and reads NaN as 0', () => {
    expect(lerp('#ff2020', '#3a6bff', -5)).toBe('#ff2020');
    expect(lerp('#ff2020', '#3a6bff', 5)).toBe('#3a6bff');
    expect(lerp('#ff2020', '#3a6bff', Infinity)).toBe('#3a6bff');
    expect(lerp('#ff2020', '#3a6bff', NaN)).toBe('#ff2020');
  });

  it('answers in canonical lower-case #rrggbb, and a canonical input comes back unchanged', () => {
    expect(lerp('#FA0', '#000', 0)).toBe('#ffaa00');
    expect(lerp('#FFAA00', '#ffaa00', 0.5)).toBe('#ffaa00');
    for (const [a, b] of PAIRS) expect(lerp(a, b, 0.37)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is a polar OKLCH blend: lightness and chroma linear, hue on the short arc', () => {
    const a = oklchToHex(0.5, 0.12, 100);
    const b = oklchToHex(0.8, 0.06, 140);
    const [la, ca, ha] = hexToOklch(a);
    const [lb, cb, hb] = hexToOklch(b);
    const [lm, cm, hm] = hexToOklch(lerp(a, b, 0.5));
    expect(lm).toBeCloseTo((la + lb) / 2, 2);
    expect(cm).toBeCloseTo((ca + cb) / 2, 2);
    expect(hueGap(hm, (ha + hb) / 2)).toBeLessThan(2);
  });

  it('takes the short way round the hue wheel, both directions', () => {
    const a = oklchToHex(0.7, 0.1, 350);
    const b = oklchToHex(0.7, 0.1, 10);
    const [, , ha] = hexToOklch(a);
    const [, , hb] = hexToOklch(b);
    expect(hueGap(ha, 350)).toBeLessThan(1);
    expect(hueGap(hb, 10)).toBeLessThan(1);
    // The midpoint is at about 0 degrees, not 180: the long way would pass through cyan.
    expect(hueGap(hexToOklch(lerp(a, b, 0.5))[2], 0)).toBeLessThan(2);
    expect(hueGap(hexToOklch(lerp(b, a, 0.5))[2], 0)).toBeLessThan(2);
    // A quarter of the way from 350 to 10 is 355; from 10 to 350 it is 5.
    expect(hueGap(hexToOklch(lerp(a, b, 0.25))[2], 355)).toBeLessThan(2);
    expect(hueGap(hexToOklch(lerp(b, a, 0.25))[2], 5)).toBeLessThan(2);
    // Every step along the way stays within the 20 degree arc (hues near 0, never near 180).
    for (let t = 0.05; t < 1; t += 0.05) expect(hueGap(hexToOklch(lerp(a, b, t))[2], 0)).toBeLessThan(15);
  });

  it('two hues 200 degrees apart blend through the 160 degree arc, not the 200 one', () => {
    const a = oklchToHex(0.7, 0.1, 100);
    const b = oklchToHex(0.7, 0.1, 300);                           // 200 apart: the short arc runs 100 -> 0 -> 300 and midpoints at 20
    expect(hueGap(hexToOklch(lerp(a, b, 0.5))[2], 20)).toBeLessThan(3);
  });

  it('a grey end borrows the other end\'s hue instead of sliding through the wheel', () => {
    const red = '#ff2020';
    const [, , hRed] = hexToOklch(red);
    for (const t of [0.25, 0.5, 0.75]) {
      expect(hueGap(hexToOklch(lerp('#808080', red, t))[2], hRed)).toBeLessThan(4);
      expect(hueGap(hexToOklch(lerp(red, '#808080', t))[2], hRed)).toBeLessThan(4);
    }
    expect(lerp('#000000', '#ffffff', 0.5)).toBe('#636363');       // grey to grey stays grey
  });

  it('is symmetric: lerp(a, b, t) is lerp(b, a, 1 - t) to within one level', () => {
    for (const [a, b] of PAIRS) {
      const x = parseHex(lerp(a, b, 0.3));
      const y = parseHex(lerp(b, a, 0.7));
      for (let i = 0; i < 3; i++) expect(Math.abs(x[i] - y[i])).toBeLessThanOrEqual(1);
    }
  });

  it('never leaves sRGB, even between saturated colours', () => {
    const sat = ['#ff0000', '#00ff00', '#0000ff', '#00ffff', '#ff00ff', '#ffff00'];
    for (const a of sat) for (const b of sat) for (const t of [0.1, 0.33, 0.5, 0.8]) expect(parseHex(lerp(a, b, t))).not.toBeNull();
  });

  it('refuses anything that is not a hex colour', () => {
    expect(() => lerp('red', '#ffffff', 0.5)).toThrow(TypeError);
    expect(() => lerp('#ffffff', 'rgb(0,0,0)', 0.5)).toThrow(TypeError);
    expect(() => lerp(/** @type {any} */ (null), '#ffffff', 0.5)).toThrow(TypeError);
  });
});
