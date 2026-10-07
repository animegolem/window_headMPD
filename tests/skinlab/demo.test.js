// W4.4: the legacy demo capture. Everything here runs in Node on synthetic call logs: no browser, no art.
// The real tour (about 45 s of wall clock in Chromium) is the acceptance command itself,
// `npm run skinlab -- demo --target legacy`; set SKINLAB_DEMO_E2E=1 to run it from vitest too.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import main, {
  DEFAULT_MEDIA,
  DEMO_WAV,
  EXPECT,
  LOG_FORMAT,
  MOUNT_URL,
  buildLog,
  checkSummary,
  formatReport,
  parseDemoOptions,
  referenceCopy,
  summarize,
} from '../../tools/skinlab/cmd-demo.mjs';
import { EXIT } from '../../tools/skinlab/exit.mjs';
import { MEDIA_PRESET_NAMES } from '../../tools/skinlab/media-presets.js';
import { REPO_ROOT, SKINLAB_DIR } from '../../tools/skinlab/paths.mjs';
import { resolveHeadspace } from '../support/fixtures.js';

// ---- a synthetic tour: the shape of the real one (src/demo.js) with invented numbers ------------------------

const BASE_MS = 123_456; // an arbitrary performance.now() at record_start
const ZEROS = Array(10).fill(0);
const call = (t, cmd, args = {}) => ({ at: BASE_MS + t * 1000, kind: 'call', cmd, args });
const pref = (t, key, value) => ({ at: BASE_MS + t * 1000, kind: 'pref', key, value: String(value) });

const DRAGS = [
  [0, 10],
  [1, 8],
  [4, -5],
  [8, 6],
  [9, 9],
];

/** @returns {{events: object[], others: [string, number][]}} */
function tour({ eqOpenAt = 8.244, record = true, wav = DEMO_WAV, presets = ['2', '3', '4', '0', '1'], extra = [] } = {}) {
  const ev = [
    call(-1.8, 'set_eq', { gains: ZEROS }),
    pref(-1.8, 'eq', JSON.stringify(ZEROS)),
    call(-1.8, 'mpd', { args: ['play'] }),
    call(-1.5, 'mpd', { args: ['pause', '1'] }),
    call(-1.5, 'mpd', { args: ['seekcur', '0'] }),
  ];
  if (record) ev.push(call(0, 'record_start'));
  ev.push(call(0.12, 'js_log', { msg: 'demo: started' }), call(1.73, 'mpd', { args: ['play'] }), pref(5.5, 'plOpen', 'true'));
  if (eqOpenAt !== null) ev.push(pref(eqOpenAt, 'eqOpen', 'true'));
  let eq = [...ZEROS];
  let t = 8.96;
  for (const [band, db] of DRAGS) {
    ev.push(call(t, 'set_capture', { on: true }), call(t, 'set_eq', { gains: [...eq] }));
    const step = db > 0 ? 1 : -1;
    for (let v = step; Math.abs(v) <= Math.abs(db); v += step) {
      eq = eq.map((x, i) => (i === band ? v : x));
      ev.push(call((t += 0.03), 'set_eq', { gains: [...eq] }));
    }
    t += 0.05;
    ev.push(call(t, 'set_capture', { on: false }), pref(t, 'eq', JSON.stringify(eq)));
    t += 0.35;
  }
  presets.forEach((p, i) => ev.push(pref(17.2 + i * 3.9, 'preset', p)));
  // The reset click and the teardown send zeros AFTER the drags: "the last set_eq" is not the answer.
  ev.push(call(36.8, 'set_eq', { gains: ZEROS }), pref(36.8, 'eq', JSON.stringify(ZEROS)));
  if (record) ev.push(call(39.5, 'record_stop', { path: wav }));
  ev.push(call(39.5, 'js_log', { msg: `demo: wrote ${wav}` }), call(39.5, 'set_eq', { gains: ZEROS }), call(39.501, 'js_log', { msg: 'demo: done' }));
  ev.push(...extra);
  return { events: ev, others: [['engine_info', 1]] };
}

const logOf = (opts, header = { media: DEFAULT_MEDIA }) => buildLog(tour(opts), header);

// ---- options ------------------------------------------------------------------------------------------------

const usageCode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};

describe('demo options', () => {
  it('default to the S1 media preset and take --out as a resolved path', () => {
    expect(parseDemoOptions(['--target', 'legacy'])).toEqual({ target: 'legacy', media: DEFAULT_MEDIA, out: null });
    expect(DEFAULT_MEDIA).toBe('stoppedEmpty');
    expect(parseDemoOptions(['--target', 'legacy', '--media', 'playing', '--out', 'x/y']).out).toBe(path.resolve('x/y'));
  });

  it('exit 2 for a missing, engine, unknown or misspelled target, option and media', () => {
    expect(usageCode(() => parseDemoOptions([]))).toBe(EXIT.USAGE);
    expect(usageCode(() => parseDemoOptions(['--target', 'engine']))).toBe(EXIT.USAGE);
    expect(usageCode(() => parseDemoOptions(['--target', 'webkit']))).toBe(EXIT.USAGE);
    expect(usageCode(() => parseDemoOptions(['--target', 'legacy', '--bogus']))).toBe(EXIT.USAGE);
    expect(usageCode(() => parseDemoOptions(['--target', 'legacy', '--media', 'nope']))).toBe(EXIT.USAGE);
  });

  it('treats the media preset as a name, never as a property lookup', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(usageCode(() => parseDemoOptions(['--target', 'legacy', '--media', name])), name).toBe(EXIT.USAGE);
    }
    for (const name of MEDIA_PRESET_NAMES) expect(parseDemoOptions(['--target', 'legacy', '--media', name]).media).toBe(name);
  });

  it('keep a reference copy per media preset, since the verbs the tour sends depend on it', () => {
    expect(referenceCopy('stoppedEmpty', '/store')).toBe(path.join('/store', 'demo', 'legacy-stoppedEmpty.json'));
    expect(referenceCopy('playing', '/store')).not.toBe(referenceCopy('stoppedEmpty', '/store'));
  });

  it('is refused before any fixture or browser is touched', async () => {
    // main() validates first: these must reject with the usage code even where there is no fixture.
    await expect(main([])).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(main(['--target', 'legacy', '--media', '__proto__'])).rejects.toMatchObject({ code: EXIT.USAGE });
  });
});

// ---- the log ------------------------------------------------------------------------------------------------

describe('buildLog', () => {
  it('rebases every time on record_start, in seconds, with the stage setup negative', () => {
    const log = logOf();
    expect(log.format).toBe(LOG_FORMAT);
    expect(log.timeBase).toBe('record_start');
    expect(log.calls.find((c) => c.cmd === 'record_start').t).toBe(0);
    expect(log.calls.find((c) => c.cmd === 'record_stop').t).toBe(39.5);
    const first = log.calls[0];
    expect(first).toEqual({ t: -1.8, cmd: 'set_eq', args: { gains: ZEROS } });
    expect(log.prefs.find((p) => p.key === 'eqOpen')).toEqual({ t: 8.244, key: 'eqOpen', value: 'true' });
    // Rounded to the millisecond: no float dust from subtracting two performance.now() readings.
    for (const c of log.calls) expect(Math.round(c.t * 1000)).toBe(c.t * 1000);
  });

  it('records the header the comparison needs: target, media, wav, provenance', () => {
    const log = buildLog(tour(), { media: 'playing', skinSha256: 'a', oraclePin: 'b', chromiumRevision: '1243' });
    expect(log).toMatchObject({ target: 'legacy', media: 'playing', wav: DEMO_WAV, skinSha256: 'a', oraclePin: 'b', chromiumRevision: '1243' });
  });

  it('falls back to the trigger time when the tour never reached record_start, and says so', () => {
    const raw = tour({ record: false });
    const log = buildLog({ ...raw, startedAt: BASE_MS - 1800 }, { media: DEFAULT_MEDIA });
    expect(log.timeBase).toMatch(/no record_start/);
    expect(log.calls[0].t).toBe(0);
    expect(log.summary.recordStartT).toBeNull();
  });

  it('keeps the other command names as plain data, including __proto__ and constructor', () => {
    const raw = { ...tour(), others: [['__proto__', 2], ['constructor', 3], ['engine_info', 1]] };
    const log = buildLog(raw, { media: DEFAULT_MEDIA });
    expect(Object.getPrototypeOf(log.otherCalls)).toBeNull();
    expect(Object.keys(log.otherCalls).sort()).toEqual(['__proto__', 'constructor', 'engine_info']);
    expect(log.otherCalls.constructor).toBe(3);
    const back = JSON.parse(JSON.stringify(log));
    expect(Object.hasOwn(back.otherCalls, '__proto__')).toBe(true);
    expect(back.otherCalls.__proto__).toBe(2);
    expect(Object.getPrototypeOf(back.otherCalls)).toBe(Object.prototype); // nothing was polluted by the key
    expect({}.polluted).toBeUndefined();
  });
});

describe('summarize', () => {
  it('reads the tour: verbs, drawers, five drags, five preset steps', () => {
    const s = logOf().summary;
    expect(s.mpdVerbs).toEqual(['play', 'pause 1', 'seekcur 0', 'play']);
    expect(s.mpd[3]).toEqual({ t: 1.73, argv: ['play'] });
    expect(s.plOpenAt).toBe(5.5);
    expect(s.eqOpenAt).toBe(8.244);
    expect(s.drags.map((d) => [d.band, d.to])).toEqual(DRAGS);
    expect(s.drags.every((d) => d.endT > d.startT && d.inputs > 1)).toBe(true);
    expect(s.presetSteps).toBe(5);
    expect(s.presetValues).toEqual(['2', '3', '4', '0', '1']);
    expect(s.recordStopPath).toBe(DEMO_WAV);
    expect(s.durationS).toBe(39.501);
  });

  it('takes the band values after the drags from the last drag, not the last set_eq (the reset sends zeros)', () => {
    const raw = tour();
    const lastSetEq = [...raw.events].reverse().find((e) => e.cmd === 'set_eq');
    expect(lastSetEq.args.gains).toEqual(ZEROS);
    const s = buildLog(raw, { media: DEFAULT_MEDIA }).summary;
    expect(s.bandsAfterDrags).toEqual([10, 8, 0, 0, -5, 0, 0, 0, 6, 9]);
    expect(s.drags.map((d) => d.eq)).toEqual([
      [10, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [10, 8, 0, 0, 0, 0, 0, 0, 0, 0],
      [10, 8, 0, 0, -5, 0, 0, 0, 0, 0],
      [10, 8, 0, 0, -5, 0, 0, 0, 6, 0],
      [10, 8, 0, 0, -5, 0, 0, 0, 6, 9],
    ]);
  });

  it('reads the persisted eq of each drag as a second source for the same values', () => {
    const s = logOf().summary;
    expect(s.drags.map((d) => d.persisted)).toEqual(s.drags.map((d) => d.eq));
  });

  it('ignores a capture that opens twice or closes without opening', () => {
    const s = summarize(
      [
        { t: 0, cmd: 'set_capture', args: { on: false } },
        { t: 1, cmd: 'set_capture', args: { on: true } },
        { t: 1.1, cmd: 'set_eq', args: { gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } },
        { t: 1.2, cmd: 'set_capture', args: { on: true } },
        { t: 1.3, cmd: 'set_capture', args: { on: false } },
      ],
      [],
    );
    expect(s.drags).toHaveLength(1);
    expect(s.drags[0]).toMatchObject({ startT: 1, endT: 1.3, band: 0, to: 1 });
  });

  it('reports a drag that moved no band, or several, with a null band rather than a guess', () => {
    const on = (t) => ({ t, cmd: 'set_capture', args: { on: true } });
    const off = (t) => ({ t, cmd: 'set_capture', args: { on: false } });
    const eq = (t, gains) => ({ t, cmd: 'set_eq', args: { gains } });
    const s = summarize([on(1), off(2), on(3), eq(3.1, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]), off(4)], []);
    expect(s.drags.map((d) => [d.band, d.to])).toEqual([[null, null], [null, null]]);
  });

  it('counts only the preset writes at or after record_start (the stage setup steps are not the tour)', () => {
    const raw = tour({ extra: [pref(-1.0, 'preset', '1')] });
    expect(buildLog(raw, { media: DEFAULT_MEDIA }).summary.presetSteps).toBe(5);
  });

  it('separates the tour reports from anything else the legacy told js_log', () => {
    const s = logOf({ extra: [call(20, 'js_log', { msg: 'TypeError: boom @ main.js:1' })] }).summary;
    expect(s.jsLogErrors).toEqual(['TypeError: boom @ main.js:1']);
    expect(s.jsLog.map((l) => l.msg)).toContain('demo: done');
  });

  it('is empty-safe', () => {
    const s = summarize([], []);
    expect(s).toMatchObject({ recordStartT: null, drags: [], bandsAfterDrags: null, presetSteps: 0, eqOpenAt: null, durationS: 0 });
  });
});

describe('checkSummary', () => {
  it('passes the tour the card describes', () => {
    expect(checkSummary(logOf().summary)).toEqual([]);
  });

  it('names each way the reference can be wrong', () => {
    const problems = (opts, wav) => checkSummary(logOf(opts).summary, wav ? { wav } : undefined).join('\n');
    expect(problems({ record: false })).toMatch(/never called record_start/);
    expect(problems({ record: false })).toMatch(/never called record_stop/);
    expect(problems({ eqOpenAt: null })).toMatch(/EQ drawer never opened/);
    expect(problems({ eqOpenAt: 9.5 })).toMatch(/opened at t = 9\.5 s, after the first drag was due/);
    expect(problems({ presets: ['2', '3', '4', '0'] })).toMatch(/4 preset steps, expected 5/);
    expect(problems({ wav: '/tmp/other.wav' })).toMatch(/record_stop wrote to "\/tmp\/other\.wav"/);
    expect(problems({ extra: [call(20, 'js_log', { msg: 'oops' })] })).toMatch(/the legacy reported: oops/);
  });

  it('fails when a drag lands on the wrong value or the wrong band', () => {
    const raw = tour();
    // Bend the fifth drag's last input to 8 instead of 9 (and its persisted copy with it).
    const lastInput = [...raw.events].reverse().find((e) => e.cmd === 'set_eq' && e.args.gains[9] === 9);
    lastInput.args.gains = [...lastInput.args.gains];
    lastInput.args.gains[9] = 8;
    const problems = checkSummary(buildLog(raw, { media: DEFAULT_MEDIA }).summary).join('\n');
    expect(problems).toMatch(/band values after the drags are \[10,8,0,0,-5,0,0,0,6,8\]/);
    expect(problems).toMatch(/drag 5: the legacy persisted/); // the two sources disagree
  });

  it('fails when the legacy never reached the sliders', () => {
    const raw = tour();
    raw.events = raw.events.filter((e) => e.cmd !== 'set_capture');
    const problems = checkSummary(buildLog(raw, { media: DEFAULT_MEDIA }).summary).join('\n');
    expect(problems).toMatch(/drags moved bands \[\]/);
    expect(problems).toMatch(/band values after the drags are null/);
  });
});

describe('formatReport', () => {
  it('prints the numbers the owner and W5.3 read, with the measured EQ time beside the first-drag deadline', () => {
    const text = formatReport(logOf());
    expect(text).toMatch(/media stoppedEmpty/);
    expect(text).toMatch(/EQ drawer opened at t = 8\.244 s \(demo\.js clicks the handle at about 8\.2 s; first drag due 8\.6 s\)/);
    expect(text).not.toMatch(/7\.5/);
    expect(text).toContain('band values after the drags: [10,8,0,0,-5,0,0,0,6,9]');
    expect(text).toMatch(/preset steps: 5/);
    expect(text).toMatch(/play @-1\.80, pause 1 @-1\.50, seekcur 0 @-1\.50, play @1\.73/);
  });
});

// ---- the numbers against the pinned tour --------------------------------------------------------------------

// The pinned tour and its trigger are deleted with main.js at cutover (W6.2); the checks go with them.
const PINNED_PRESENT = existsSync(path.join(REPO_ROOT, 'src', 'demo.js')) && existsSync(path.join(REPO_ROOT, 'src', 'main.js'));

describe.skipIf(!PINNED_PRESENT)('EXPECT against the pinned src/demo.js', () => {
  /** Strip comments and read the schedule the tour keeps; a re-pin that changes it fails here first. */
  async function schedule() {
    const src = (await readFile(path.join(REPO_ROOT, 'src', 'demo.js'), 'utf8')).replace(/\/\/.*$/gm, '');
    const body = src.slice(src.indexOf('export async function runDemo'));
    const untils = [...body.matchAll(/await until\(([\d.]+)\)/g)].map((m) => ({ at: m.index, t: Number(m[1]) }));
    const nearest = (index) => untils.filter((u) => u.at < index).at(-1)?.t;
    const drags = [...body.matchAll(/await dragBand\((\d+), (-?\d+)\)/g)].map((m) => ({ band: Number(m[1]), db: Number(m[2]), at: m.index }));
    return { body, untils, nearest, drags };
  }

  it('drags the five bands to the values the card lists', async () => {
    const { drags } = await schedule();
    expect(drags.map((d) => d.band)).toEqual([...EXPECT.dragBands]);
    const eq = Array(10).fill(0);
    for (const d of drags) eq[d.band] = d.db;
    expect(eq).toEqual([...EXPECT.bandsAfterDrags]);
  });

  it('steps the preset once per scheduled click on the next button', async () => {
    const { body } = await schedule();
    const list = /for \(const t of \[([\d., ]+)\]\)/.exec(body);
    expect(list).not.toBeNull();
    expect(list[1].split(',').length).toBe(EXPECT.presetSteps);
  });

  it('clicks the EQ handle before the first drag starts, and starts that drag at the deadline the check uses', async () => {
    const { body, nearest, drags } = await schedule();
    expect(nearest(drags[0].at)).toBe(EXPECT.eqOpenBeforeS);
    // until(7.0), a 1100 ms glide, then the click: the toggle opens the drawer at about 8.1 s plus the
    // click itself, which has to land before the first drag is due.
    const eq = /await until\(([\d.]+)\);\s*await glide\(on\(ui\.eqHandle\), (\d+)\);\s*await click\(\);/.exec(body);
    expect(eq).not.toBeNull();
    expect(eq.index).toBeLessThan(drags[0].at);
    const clickAt = Number(eq[1]) + Number(eq[2]) / 1000;
    expect(clickAt).toBeLessThan(EXPECT.eqOpenBeforeS);
  });

  it('uses the wav path main.js falls back to when the trigger names none', async () => {
    const main = await readFile(path.join(REPO_ROOT, 'src', 'main.js'), 'utf8');
    expect(main).toContain(`rest.join(' ') || '${DEMO_WAV}'`);
  });
});

// ---- the mount ----------------------------------------------------------------------------------------------

describe('demo-legacy-mount.js', () => {
  const read = () => readFile(path.join(SKINLAB_DIR, 'demo-legacy-mount.js'), 'utf8');

  it('is served from where cmd-demo imports it', () => {
    expect(MOUNT_URL).toBe('/tools/skinlab/demo-legacy-mount.js');
  });

  it('loads into the booted legacy page: no imports of its own, nothing evaluated before the stub exists', async () => {
    const src = (await read()).replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\(/);
  });

  it('wraps invoke and Storage.prototype.setItem, answers record_start and record_stop itself, and never assigns localStorage.setItem', async () => {
    const src = (await read()).replace(/\/\/.*$/gm, '');
    expect(src).toMatch(/internals\.invoke = function/);
    expect(src).toMatch(/Storage\.prototype\.setItem = function/);
    expect(src).not.toMatch(/localStorage\.setItem\s*=/);
    expect(src).toMatch(/cmd === 'record_start' \|\| cmd === 'record_stop'/);
    expect(src).toContain("'mpd-message'");
    // The tour's verdict comes from its own js_log lines.
    expect(src).toContain("'demo: done'");
    expect(src).toMatch(/demo failed:/);
  });

  it('counts commands it does not log in a Map (command names are not ours)', async () => {
    const src = await read();
    expect(src).toMatch(/const others = new Map\(\)/);
  });
});

// ---- the real tour (opt-in: about 45 s of wall clock, Chromium, the fixture) --------------------------------

const fixture = resolveHeadspace();
const E2E = process.env.SKINLAB_DEMO_E2E === '1' && fixture.ok;

describe.skipIf(!E2E)('the legacy tour in Chromium', () => {
  it('runs headless and writes a log that passes the card', { timeout: 180_000 }, async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'skinlab-demo-test-'));
    try {
      await expect(main(['--target', 'legacy', '--out', out])).resolves.toBe(EXIT.PASS);
      const log = JSON.parse(await readFile(path.join(out, 'demo-legacy.json'), 'utf8'));
      expect(log.problems).toEqual([]);
      expect(log.summary.bandsAfterDrags).toEqual([...EXPECT.bandsAfterDrags]);
      expect(log.summary.presetSteps).toBe(5);
      expect(log.summary.eqOpenAt).toBeLessThan(EXPECT.eqOpenBeforeS);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
