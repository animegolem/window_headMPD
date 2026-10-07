// W5.3F: unit tests for the engine half of tools/skinlab/cmd-demo.mjs (W5.3): the translation of what the
// test host saw into `mpd` verbs, the engine log, its options, and the comparison with the legacy log.
// Everything runs in Node on synthetic logs shaped like the real ones: no browser, no fixture, no art. The
// legacy half is tests/skinlab/demo.test.js. The real tour is the acceptance command itself,
// `npm run skinlab -- demo --target engine --compare` (about a second of wall clock on the manual clock);
// it is not run from here.
//
// The synthetic tours keep the numbers of the real one (demo.js: five drags to [10, 8, 0, 0, -5, 0, 0, 0, 6, 9],
// five preset steps, the EQ handle clicked at about 8.2 s) and the real difference in shape: the legacy sends
// a vector per 30 ms input and re-sends the current vector when a drag starts and at the teardown, brackets
// only its sliders in set_capture, and resets with one zero vector; the engine takes the capture on every
// control press, sends a vector per changed value, and resets by writing ten sliders inside one handler.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME_MS } from '../../src/hosts/test/clock.js';
import { CONFIGS } from '../../tools/skinlab/allowlist.mjs';
import main, {
  DEFAULT_MEDIA,
  DEMO_WAV,
  ENGINE_LOG_FILE,
  ENGINE_MOUNT_URL,
  EXPECT,
  LOG_FILE,
  LOG_FORMAT,
  buildLog,
  checkEngineLog,
  checkSummary,
  compareLogs,
  engineRaw,
  eqSteps,
  formatReport,
  mpdArgvOf,
  parseEngineDemoOptions,
  peekTarget,
  summarize,
} from '../../tools/skinlab/cmd-demo.mjs';
import { EXIT } from '../../tools/skinlab/exit.mjs';
import { MEDIA_PRESET_NAMES } from '../../tools/skinlab/media-presets.js';
import { SKINLAB_DIR } from '../../tools/skinlab/paths.mjs';

// Names a skin or a command line can carry that an object lookup would mistake for a property.
const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

// ---- a synthetic tour on each side ---------------------------------------------------------------------------

const BASE_MS = 50_000; // an arbitrary clock reading at record_start
const ZEROS = Object.freeze(Array(10).fill(0));
const DRAGS = Object.freeze([[0, 10], [1, 8], [4, -5], [8, 6], [9, 9]]);
const PRESETS = Object.freeze(['2', '3', '4', '0', '1']);
const FIRST_DRAG_AT = 8.96;
const DRAG_EVERY = 0.82;

/** The legacy stage setup and the first play, as the legacy tour sends them raw (canned `mpd status`: never `pause 0`). */
const LEGACY_VERBS = Object.freeze([
  [-1.8, ['play']],
  [-1.5, ['pause', '1']],
  [-1.5, ['seekcur', '0']],
  [1.73, ['play']],
]);
/** The same four MediaModel commands. The empty queue never starts, so the host's play state stays `stop`. */
const ENGINE_MEDIA = Object.freeze([
  [-1.8, 'play', []],
  [-1.5, 'pause', []],
  [-1.5, 'seek', [0]],
  [1.73, 'play', []],
]);

const sortedByTime = (events) => events.map((e, i) => [e, i]).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([e]) => e);

/** What demo-legacy-mount.js records. @returns {{events: object[], others: [string, number][]}} */
function legacyTour({ eqOpenAt = 8.244, plOpenAt = 5.5, presets = PRESETS, drags = DRAGS, verbs = LEGACY_VERBS, wav = DEMO_WAV, record = true } = {}) {
  const events = [];
  const add = (t, kind, rest) => events.push({ at: BASE_MS + Math.round(t * 1000), kind, ...rest });
  const call = (t, cmd, args = {}) => add(t, 'call', { cmd, args });
  const pref = (t, key, value) => add(t, 'pref', { key, value: String(value) });

  call(-1.8, 'set_eq', { gains: [...ZEROS] });
  pref(-1.8, 'eq', JSON.stringify(ZEROS));
  for (const [t, args] of verbs) call(t, 'mpd', { args });
  if (record) call(0, 'record_start');
  call(0.12, 'js_log', { msg: 'demo: started' });
  if (plOpenAt !== null) pref(plOpenAt, 'plOpen', true);
  if (eqOpenAt !== null) pref(eqOpenAt, 'eqOpen', true);

  let eq = [...ZEROS];
  drags.forEach(([band, db], i) => {
    let t = FIRST_DRAG_AT + i * DRAG_EVERY;
    call(t, 'set_capture', { on: true });
    call(t, 'set_eq', { gains: [...eq] }); // the legacy re-sends the current vector when a drag starts
    const step = Math.sign(db);
    for (let v = step; step !== 0 && Math.abs(v) <= Math.abs(db); v += step) {
      eq = eq.map((x, k) => (k === band ? v : x));
      call((t += 0.03), 'set_eq', { gains: [...eq] });
    }
    call((t += 0.05), 'set_capture', { on: false });
    pref(t, 'eq', JSON.stringify(eq));
  });
  presets.forEach((p, i) => pref(17.2 + i * 3.9, 'preset', p));
  call(36.8, 'set_eq', { gains: [...ZEROS] });
  pref(36.8, 'eq', JSON.stringify(ZEROS));
  if (record) call(39.5, 'record_stop', { path: wav });
  call(39.5, 'js_log', { msg: `demo: wrote ${wav}` });
  call(39.5, 'set_eq', { gains: [...ZEROS] }); // the teardown
  call(39.501, 'js_log', { msg: 'demo: done' });
  return { events: sortedByTime(events), others: [['engine_info', 1]] };
}

/**
 * What demo-engine-mount.js records, before `engineRaw` turns the `media` events into `mpd` calls.
 * `skew` moves everything after record_start; `fractional` sends the in-between values the way an
 * unquantised slider does; `finalFor` is what the last value of a drag becomes.
 */
function engineTour({
  skew = 0,
  eqOpenAt = 8.244,
  plOpenAt = 5.5,
  presets = PRESETS,
  drags = DRAGS,
  media = ENGINE_MEDIA,
  wav = DEMO_WAV,
  record = true,
  fractional = false,
  finalFor = (_band, db) => db,
  extra = [],
} = {}) {
  const events = [];
  const shifted = (t) => (t > 0 ? t + skew : t);
  const add = (t, kind, rest) => events.push({ at: BASE_MS + Math.round(shifted(t) * 1000), kind, ...rest });
  const call = (t, cmd, args = {}) => add(t, 'call', { cmd, args });
  const pref = (t, key, value) => add(t, 'pref', { key, value: String(value) });
  const press = (from, to, inside = () => {}) => {
    call(from, 'set_capture', { on: true });
    inside();
    call(to, 'set_capture', { on: false });
  };

  for (const [t, method, args, before = 'stop'] of media) add(t, 'media', { method, args, before });
  if (record) call(0, 'record_start');
  call(0.12, 'js_log', { msg: 'demo: started' });
  press(1.6, 1.73);
  press(5.356, 5.5);
  if (plOpenAt !== null) pref(plOpenAt, 'plOpen', true);
  press(8.1, 8.244);
  if (eqOpenAt !== null) pref(eqOpenAt, 'eqOpen', true);

  let eq = [...ZEROS];
  drags.forEach(([band, db], i) => {
    const t = FIRST_DRAG_AT + i * DRAG_EVERY;
    const n = Math.abs(db);
    const step = Math.sign(db);
    press(t, t + 0.016 * (n + 1), () => {
      for (let k = 1; k <= n; k++) {
        const v = k === n ? finalFor(band, db) : step * (fractional ? k - 0.37 : k);
        eq = eq.map((x, b) => (b === band ? v : x));
        call(t + 0.016 * k, 'set_eq', { gains: [...eq] });
      }
    });
  });
  presets.forEach((p, i) => {
    const t = 17.2 + i * 3.9;
    press(t - 0.144, t);
    pref(t, 'preset', p);
  });
  press(36.656, 36.8, () => {
    // The reset writes ten sliders inside one handler: one vector per band that moved, all at one instant.
    for (let band = 0; band < 10; band++) {
      if (eq[band] === 0) continue;
      eq = eq.map((x, b) => (b === band ? 0 : x));
      call(36.8, 'set_eq', { gains: [...eq] });
    }
  });
  if (record) call(39.5, 'record_stop', { path: wav });
  call(39.5, 'js_log', { msg: `demo: wrote ${wav}` });
  call(39.5, 'js_log', { msg: 'demo: done' });
  for (const e of extra) events.push({ at: BASE_MS + Math.round(shifted(e.t) * 1000), ...e.event });
  return { events: sortedByTime(events), others: [['set_shape', 17]], startedAt: BASE_MS - 1800 };
}

const legacyLog = (opts, header = {}) => buildLog(legacyTour(opts), { media: DEFAULT_MEDIA, ...header });

/** The engine's pipeline in cmd-demo.mjs: `engineRaw` first, then `buildLog` for the engine. */
function engineLog(opts, header = {}) {
  const { raw, problems } = engineRaw(engineTour(opts));
  expect(problems, 'the synthetic engine tour only uses commands that have a translation').toEqual([]);
  return buildLog(raw, { media: DEFAULT_MEDIA, target: 'engine', engine: { config: 'faithful', steps: 2583, wallMs: 800, host: {} }, ...header });
}

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return undefined;
};
const setEqCount = (log) => log.calls.filter((c) => c.cmd === 'set_eq').length;
const verbsOf = (log) => log.summary.mpdVerbs;

// ---- mpdArgvOf --------------------------------------------------------------------------------------------

describe('mpdArgvOf', () => {
  it('sends play, or pause 0 to resume a paused player (player.js:107-108)', () => {
    expect(mpdArgvOf('play', [])).toEqual([['play']]);
    expect(mpdArgvOf('play', [], undefined)).toEqual([['play']]);
    for (const before of ['stop', 'play', '', 'paused']) expect(mpdArgvOf('play', [], before), before).toEqual([['play']]);
    expect(mpdArgvOf('play', [], 'pause')).toEqual([['pause', '0']]);
  });

  it('sends the one-verb transport commands unchanged', () => {
    expect(mpdArgvOf('pause', [])).toEqual([['pause', '1']]);
    expect(mpdArgvOf('stop', [])).toEqual([['stop']]);
    expect(mpdArgvOf('next', [])).toEqual([['next']]);
    expect(mpdArgvOf('previous', [])).toEqual([['previous']]);
    // The state the command found changes nothing for them.
    expect(mpdArgvOf('pause', [], 'pause')).toEqual([['pause', '1']]);
  });

  it('seeks with two decimals, as player.js does, and sends nothing for a position that is not a finite number', () => {
    expect(mpdArgvOf('seek', [0])).toEqual([['seekcur', '0.00']]);
    expect(mpdArgvOf('seek', [1.5])).toEqual([['seekcur', '1.50']]);
    expect(mpdArgvOf('seek', [83])).toEqual([['seekcur', '83.00']]);
    for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined, {}]) {
      expect(mpdArgvOf('seek', [bad]), String(bad)).toEqual([]); // a known command with no verb is [], not null
    }
    expect(mpdArgvOf('seek', [])).toEqual([]);
  });

  it('rounds the volume to a whole number and never writes -0', () => {
    expect(mpdArgvOf('setVolume', [49.6])).toEqual([['setvol', '50']]);
    expect(mpdArgvOf('setVolume', [49.4])).toEqual([['setvol', '49']]);
    expect(mpdArgvOf('setVolume', [0])).toEqual([['setvol', '0']]);
    expect(mpdArgvOf('setVolume', [-0.4])).toEqual([['setvol', '0']]);
    for (const bad of [NaN, Infinity, '50', null, undefined]) expect(mpdArgvOf('setVolume', [bad]), String(bad)).toEqual([]);
  });

  it('names the two modes the way MPD does and sends nothing for another mode', () => {
    expect(mpdArgvOf('setMode', ['loop', true])).toEqual([['repeat', '1']]);
    expect(mpdArgvOf('setMode', ['loop', false])).toEqual([['repeat', '0']]);
    expect(mpdArgvOf('setMode', ['shuffle', true])).toEqual([['random', '1']]);
    expect(mpdArgvOf('setMode', ['shuffle', false])).toEqual([['random', '0']]);
    expect(mpdArgvOf('setMode', ['shuffle'])).toEqual([['random', '0']]);
    expect(mpdArgvOf('setMode', ['repeat', true])).toEqual([]);
    for (const name of PROTO_NAMES) expect(mpdArgvOf('setMode', [name, true]), name).toEqual([]);
  });

  it('plays a queue position and replaces the queue with a stored playlist, in the order player.js sends them', () => {
    expect(mpdArgvOf('playQueuePos', [3])).toEqual([['play', '3']]);
    expect(mpdArgvOf('playQueuePos', [0])).toEqual([['play', '0']]);
    expect(mpdArgvOf('playPlaylist', ['Evening mix', 2])).toEqual([['clear'], ['load', 'Evening mix'], ['play', '2']]);
  });

  it('has no translation (null) for a command it does not know, never for one it does', () => {
    for (const name of ['volume', 'toggle', 'isAvailable', '', 'Play', 'PLAY']) expect(mpdArgvOf(name, []), name).toBeNull();
    // A switch, not a table: the command comes from the page, and an object lookup would find these.
    for (const name of PROTO_NAMES) expect(mpdArgvOf(name, [], 'stop'), name).toBeNull();
  });

  it('hands out fresh arrays, so a caller cannot change the next answer', () => {
    mpdArgvOf('stop', [])[0].push('mutated');
    expect(mpdArgvOf('stop', [])).toEqual([['stop']]);
  });
});

// ---- engineRaw --------------------------------------------------------------------------------------------

describe('engineRaw', () => {
  const media = (at, method, args = [], before) => ({ at, kind: 'media', method, args, before });
  const call = (at, cmd, args = {}) => ({ at, kind: 'call', cmd, args });

  it('turns each media event into mpd calls at the same instant, in place and in order', () => {
    const raw = {
      events: [call(1, 'set_capture', { on: true }), media(2, 'play'), { at: 2, kind: 'pref', key: 'plOpen', value: 'true' }, media(3, 'seek', [12.5]), call(4, 'js_log', { msg: 'demo: x' })],
      others: [['set_shape', 3]],
      startedAt: 0.5,
    };
    const { raw: out, problems } = engineRaw(raw);
    expect(problems).toEqual([]);
    expect(out.events).toEqual([
      call(1, 'set_capture', { on: true }),
      call(2, 'mpd', { args: ['play'] }),
      { at: 2, kind: 'pref', key: 'plOpen', value: 'true' },
      call(3, 'mpd', { args: ['seekcur', '12.50'] }),
      call(4, 'js_log', { msg: 'demo: x' }),
    ]);
    // Everything else the page reported rides along.
    expect(out.others).toEqual([['set_shape', 3]]);
    expect(out.startedAt).toBe(0.5);
  });

  it('turns one command into several events when the player would send several verbs', () => {
    const { raw, problems } = engineRaw({ events: [media(7, 'playPlaylist', ['Mix', 4])] });
    expect(problems).toEqual([]);
    expect(raw.events).toEqual([call(7, 'mpd', { args: ['clear'] }), call(7, 'mpd', { args: ['load', 'Mix'] }), call(7, 'mpd', { args: ['play', '4'] })]);
  });

  it('lets the play state the command found choose the verb', () => {
    const verbs = (before) => engineRaw({ events: [media(0, 'play', [], before)] }).raw.events.map((e) => e.args.args);
    expect(verbs('stop')).toEqual([['play']]);
    expect(verbs(undefined)).toEqual([['play']]);
    expect(verbs('pause')).toEqual([['pause', '0']]);
  });

  it('drops a command that sends no verb without a problem, and tolerates arguments that are not an array', () => {
    const { raw, problems } = engineRaw({ events: [media(1, 'seek', [NaN]), media(2, 'seek', 'x'), { at: 3, kind: 'media', method: 'stop', args: null }, media(4, 'setMode', ['bogus', true])] });
    expect(problems).toEqual([]);
    expect(raw.events).toEqual([call(3, 'mpd', { args: ['stop'] })]);
  });

  it('reports a command it cannot translate, by name, and keeps translating the rest', () => {
    const { raw, problems } = engineRaw({ events: [media(1, 'play'), media(2, 'rewind'), media(3, 'next')] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"rewind"');
    expect(problems[0]).toMatch(/no mpd translation/);
    expect(raw.events.map((e) => e.args.args)).toEqual([['play'], ['next']]);
  });

  it('treats command names as names: __proto__, constructor and the rest are reported, never looked up', () => {
    for (const name of PROTO_NAMES) {
      const { raw, problems } = engineRaw({ events: [media(1, name), media(2, 'stop')] });
      expect(problems, name).toHaveLength(1);
      expect(problems[0]).toContain(JSON.stringify(name));
      expect(raw.events, name).toEqual([call(2, 'mpd', { args: ['stop'] })]);
    }
    // A method that is not a string at all is a name too: reported, not thrown on.
    const { raw, problems } = engineRaw({ events: [media(1, 5), media(2, null)] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/media command 5 has no mpd translation/);
    expect(raw.events).toEqual([]);
  });

  it('does not change what it was given', () => {
    const raw = { events: [media(1, 'play'), call(2, 'js_log', { msg: 'demo: x' })], others: [['a', 1]] };
    const before = structuredClone(raw);
    const out = engineRaw(raw).raw;
    expect(raw).toEqual(before);
    expect(out).not.toBe(raw);
    expect(out.events).not.toBe(raw.events);
  });

  it('is empty-safe', () => {
    expect(engineRaw({ events: [] })).toEqual({ raw: { events: [] }, problems: [] });
  });
});

// ---- buildLog for the engine -----------------------------------------------------------------------------------

describe('buildLog for the engine', () => {
  it('writes the log the legacy format asks for, with target engine and the engine block the caller passes', () => {
    const host = { faults: 0, health: { soft: 0, hard: 0, unloaded: false } };
    const log = engineLog({}, { skinSha256: 'abc', chromiumRevision: '1243', engine: { config: 'compat', steps: 9, wallMs: 5, host } });
    expect(log).toMatchObject({
      format: LOG_FORMAT,
      target: 'engine',
      media: DEFAULT_MEDIA,
      wav: DEMO_WAV,
      timeBase: 'record_start',
      skinSha256: 'abc',
      chromiumRevision: '1243',
      engine: { config: 'compat', steps: 9, wallMs: 5, host },
    });
    expect(log.calls.find((c) => c.cmd === 'record_start')).toEqual({ t: 0, cmd: 'record_start', args: {} });
    expect(ENGINE_LOG_FILE).toBe('demo-engine.json');
    expect(ENGINE_LOG_FILE).not.toBe(LOG_FILE);
  });

  it('reads the translated mpd verbs and the tour numbers out of the engine events', () => {
    const s = engineLog().summary;
    expect(s.mpdVerbs).toEqual(['play', 'pause 1', 'seekcur 0.00', 'play']);
    expect(s.drags.map((d) => [d.band, d.to])).toEqual(DRAGS);
    expect(s.bandsAfterDrags).toEqual([...EXPECT.bandsAfterDrags]);
    expect(s.presetSteps).toBe(5);
    expect(s.eqOpenAt).toBe(8.244);
    expect(s.plOpenAt).toBe(5.5);
    expect(s.recordStopPath).toBe(DEMO_WAV);
  });

  it('counts a set_capture bracket as a drag only when exactly one band moved inside it', () => {
    const log = engineLog();
    const captures = log.calls.filter((c) => c.cmd === 'set_capture' && c.args.on).length;
    // The engine takes the capture on every control press: play, both drawer handles, five preset clicks, the
    // reset and the five slider drags.
    expect(captures).toBe(1 + 2 + 5 + 1 + 5);
    expect(log.summary.drags).toHaveLength(5);
    // The same calls read the legacy way list every bracket, the reset (five bands) and the clicks (none) with a null band.
    const asLegacy = summarize(log.calls, log.prefs);
    expect(asLegacy.drags).toHaveLength(captures);
    expect(asLegacy.drags.filter((d) => d.band === null)).toHaveLength(captures - 5);
    // ... and `dragsOnly` can be asked for, or refused, explicitly.
    expect(buildLog({ events: [] }, { media: DEFAULT_MEDIA, target: 'engine' }).summary.drags).toEqual([]);
    const refused = buildLog(engineRaw(engineTour()).raw, { media: DEFAULT_MEDIA, target: 'engine', dragsOnly: false });
    expect(refused.summary.drags).toHaveLength(captures);
  });

  it('keeps `dragsOnly` out of the log header', () => {
    const log = buildLog(engineRaw(engineTour()).raw, { media: DEFAULT_MEDIA, target: 'engine', dragsOnly: true });
    expect(log).not.toHaveProperty('dragsOnly');
  });

  it('keeps the legacy reading as the default for target legacy', () => {
    const log = buildLog(legacyTour(), { media: DEFAULT_MEDIA });
    expect(log.target).toBe('legacy');
    // The legacy brackets only its sliders, so every bracket is a drag.
    expect(log.summary.drags).toHaveLength(5);
  });

  it('reads only call and pref events: a raw media event is not an mpd call until engineRaw has translated it', () => {
    const log = buildLog(engineTour(), { media: DEFAULT_MEDIA, target: 'engine' });
    expect(log.summary.mpdVerbs).toEqual([]);
    expect(log.calls.some((c) => c.cmd === 'mpd')).toBe(false);
  });

  it('times from the trigger, and says so, when the engine tour never reached record_start', () => {
    const { raw } = engineRaw(engineTour({ record: false }));
    const log = buildLog(raw, { media: DEFAULT_MEDIA, target: 'engine' });
    expect(log.timeBase).toMatch(/no record_start/);
    expect(log.summary.recordStartT).toBeNull();
    expect(checkSummary(log.summary, { target: 'engine' }).join('\n')).toMatch(/never called record_start/);
  });

  it('keeps the engine\'s other command names as plain data, including __proto__ and constructor', () => {
    const { raw } = engineRaw({ ...engineTour(), others: [['__proto__', 2], ['constructor', 3], ['set_shape', 17]] });
    const log = buildLog(raw, { media: DEFAULT_MEDIA, target: 'engine' });
    expect(Object.getPrototypeOf(log.otherCalls)).toBeNull();
    expect(Object.keys(log.otherCalls).sort()).toEqual(['__proto__', 'constructor', 'set_shape']);
    expect(log.otherCalls.constructor).toBe(3);
    const back = JSON.parse(JSON.stringify(log));
    expect(Object.hasOwn(back.otherCalls, '__proto__')).toBe(true);
    expect(back.otherCalls.__proto__).toBe(2);
    expect({}.polluted).toBeUndefined();
  });
});

// ---- the options ----------------------------------------------------------------------------------------------

describe('parseEngineDemoOptions', () => {
  it('defaults to the S1 media preset, the shipped faithful configuration and no comparison', () => {
    expect(parseEngineDemoOptions(['--target', 'engine'])).toEqual({
      target: 'engine',
      media: DEFAULT_MEDIA,
      config: 'faithful',
      compare: false,
      reference: null,
      out: null,
    });
  });

  it('takes every option, resolving the paths', () => {
    const o = parseEngineDemoOptions(['--target', 'engine', '--media', 'playing', '--config', 'compat', '--compare', '--reference', 'r/ref.json', '--out', 'o/dir']);
    expect(o).toEqual({
      target: 'engine',
      media: 'playing',
      config: 'compat',
      compare: true,
      reference: path.resolve('r/ref.json'),
      out: path.resolve('o/dir'),
    });
    expect(parseEngineDemoOptions(['--target=engine', '--config=compat']).config).toBe('compat');
  });

  it('knows both configurations and every media preset', () => {
    expect([...CONFIGS].sort()).toEqual(['compat', 'faithful']);
    for (const config of CONFIGS) expect(parseEngineDemoOptions(['--target', 'engine', '--config', config]).config).toBe(config);
    for (const name of MEDIA_PRESET_NAMES) expect(parseEngineDemoOptions(['--target', 'engine', '--media', name]).media).toBe(name);
  });

  it('exits 2 for an unknown configuration or media preset, treating the names as names', () => {
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--config', 'strict']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--config', 'Faithful']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--media', 'nope']))).toBe(EXIT.USAGE);
    for (const name of PROTO_NAMES) {
      expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--config', name])), `--config ${name}`).toBe(EXIT.USAGE);
      expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--media', name])), `--media ${name}`).toBe(EXIT.USAGE);
    }
  });

  it('exits 2 for --reference without --compare, and says what it needs', () => {
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--reference', 'x.json']))).toBe(EXIT.USAGE);
    expect(() => parseEngineDemoOptions(['--target', 'engine', '--reference', 'x.json'])).toThrow(/--reference needs --compare/);
    expect(() => parseEngineDemoOptions(['--target', 'engine', '--compare', '--reference', 'x.json'])).not.toThrow();
  });

  it('exits 2 unless the target is engine: these options are not the legacy capture\'s', () => {
    expect(code(() => parseEngineDemoOptions([]))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'legacy']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'webkit']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--compare']))).toBe(EXIT.USAGE);
  });

  it('exits 2 for an unknown option, a missing value, a value on a flag or a positional', () => {
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--bogus']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--media']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', '--compare=yes']))).toBe(EXIT.USAGE);
    expect(code(() => parseEngineDemoOptions(['--target', 'engine', 'extra']))).toBe(EXIT.USAGE);
  });

  it('reads --compare as a flag that takes no value', () => {
    const o = parseEngineDemoOptions(['--target', 'engine', '--compare', '--media', 'playing']);
    expect(o.compare).toBe(true);
    expect(o.media).toBe('playing');
  });
});

describe('peekTarget', () => {
  it('returns the --target value, whatever it is, in either spelling', () => {
    expect(peekTarget(['--target', 'engine'])).toBe('engine');
    expect(peekTarget(['--target=engine'])).toBe('engine');
    expect(peekTarget(['--target', 'legacy'])).toBe('legacy');
    expect(peekTarget(['--target', 'webkit'])).toBe('webkit'); // choosing a parser is all it does; the parser refuses it
  });

  it('is undefined without a --target', () => {
    expect(peekTarget([])).toBeUndefined();
    expect(peekTarget(['--media', 'playing', '--compare'])).toBeUndefined();
  });

  it('ignores options it does not know, in any order, and positionals', () => {
    expect(peekTarget(['--bogus', '--target', 'engine', 'extra', '--compare'])).toBe('engine');
    expect(peekTarget(['--compare', '--reference', 'x', '--target', 'engine'])).toBe('engine');
  });

  it('lets the last --target win and ignores anything after --', () => {
    expect(peekTarget(['--target', 'engine', '--target', 'legacy'])).toBe('legacy');
    expect(peekTarget(['--', '--target', 'engine'])).toBeUndefined();
  });

  it('never throws, and never mistakes a --target with no value for the engine', () => {
    for (const argv of [[], ['--target'], ['--target', '--media', 'playing'], ['-t', 'engine'], ['--=', '--target='], [null], ['--target', 'engine', null]]) {
      expect(() => peekTarget(argv), JSON.stringify(argv)).not.toThrow();
      expect(peekTarget(argv), JSON.stringify(argv)).not.toBe('engine');
    }
    // util.parseArgs throws on an argument that is not a string; this is only enough parsing to choose a parser.
    expect(peekTarget([null])).toBeUndefined();
  });
});

describe('main: the options are refused before a fixture or a browser is touched', () => {
  it('sends --target engine to the engine options and refuses what they refuse, in the engine parser\'s words', async () => {
    // Not the legacy parser's "--target engine has its own options": the engine options are the ones that judged these.
    await expect(main(['--target', 'engine', '--bogus'])).rejects.toThrow(/--bogus/);
    await expect(main(['--target', 'engine', '--config', 'strict'])).rejects.toThrow(/unknown --config "strict" \(known: compat, faithful\)/);
    await expect(main(['--target', 'engine', '--media', 'nope'])).rejects.toThrow(/unknown media preset "nope"/);
    await expect(main(['--target', 'engine', '--reference', 'x.json'])).rejects.toThrow(/--reference needs --compare/);
    for (const name of PROTO_NAMES) {
      await expect(main(['--target', 'engine', '--media', name]), name).rejects.toMatchObject({ code: EXIT.USAGE, message: expect.stringContaining(`unknown media preset "${name}"`) });
      await expect(main(['--target', 'engine', '--config', name]), name).rejects.toMatchObject({ code: EXIT.USAGE, message: expect.stringContaining(`unknown --config "${name}"`) });
    }
    await expect(main(['--target=engine', '--config', 'strict'])).rejects.toThrow(/unknown --config "strict"/);
  });

  it('refuses the engine-only flags for the legacy capture, naming the flag', async () => {
    await expect(main(['--target', 'legacy', '--compare'])).rejects.toThrow(/--compare applies to --target engine only/);
    await expect(main(['--target', 'legacy', '--config', 'compat'])).rejects.toThrow(/--config applies to --target engine only/);
    await expect(main(['--target', 'legacy', '--config=compat'])).rejects.toThrow(/--config applies to --target engine only/);
    await expect(main(['--target', 'legacy', '--reference', 'x.json'])).rejects.toThrow(/--reference applies to --target engine only/);
    for (const argv of [['--target', 'legacy', '--compare'], ['--compare'], ['--config', 'compat']]) {
      await expect(main(argv), argv.join(' ')).rejects.toMatchObject({ code: EXIT.USAGE });
    }
  });

  it('asks for a target when there is none, and refuses an unknown one', async () => {
    await expect(main([])).rejects.toThrow(/--target legacy or --target engine is required/);
    await expect(main(['--target'])).rejects.toMatchObject({ code: EXIT.USAGE });
    await expect(main(['--target', 'webkit'])).rejects.toThrow(/unknown --target "webkit"/);
  });
});

// ---- eqSteps ---------------------------------------------------------------------------------------------------

describe('eqSteps', () => {
  const eq = (t, gains) => ({ t, cmd: 'set_eq', args: { gains } });
  const v = (band, db) => ZEROS.map((x, i) => (i === band ? db : x));

  it('lists each distinct vector the audio path went through, in order', () => {
    expect(eqSteps([eq(1, v(0, 1)), eq(2, v(0, 2)), eq(3, v(1, 5))])).toEqual([
      { t: 1, gains: v(0, 1) },
      { t: 2, gains: v(0, 2) },
      { t: 3, gains: v(1, 5) },
    ]);
  });

  it('reads nothing from calls that are not set_eq or carry no vector', () => {
    const calls = [
      { t: 0, cmd: 'set_capture', args: { on: true } },
      { t: 0, cmd: 'set_balance', args: { balance: 4 } },
      { t: 1, cmd: 'set_eq' },
      { t: 1, cmd: 'set_eq', args: null },
      { t: 1, cmd: 'set_eq', args: {} },
      { t: 1, cmd: 'set_eq', args: { gains: 'not a vector' } },
      { t: 2, cmd: 'mpd', args: { args: ['play'] } },
    ];
    expect(eqSteps(calls)).toEqual([]);
    expect(eqSteps([])).toEqual([]);
  });

  it('drops a vector equal to the one before it: the legacy\'s re-send at drag start and at teardown is no step', () => {
    const calls = [eq(-1.8, [...ZEROS]), eq(8.96, [...ZEROS]), eq(9, v(0, 1)), eq(9.1, v(0, 1)), eq(39.5, v(0, 1))];
    expect(eqSteps(calls)).toEqual([{ t: 9, gains: v(0, 1) }]);
  });

  it('counts a return to an earlier vector, since only the neighbour is compared', () => {
    const steps = eqSteps([eq(1, v(0, 3)), eq(2, [...ZEROS]), eq(3, v(0, 3))]);
    expect(steps.map((s) => s.gains)).toEqual([v(0, 3), [...ZEROS], v(0, 3)]);
  });

  it('takes the baseline as the vector before the first call: the seeded zeros unless told otherwise', () => {
    expect(eqSteps([eq(1, [...ZEROS])])).toEqual([]);
    expect(eqSteps([eq(1, [...ZEROS])], v(2, 4))).toEqual([{ t: 1, gains: [...ZEROS] }]);
    expect(eqSteps([eq(1, v(2, 4))], v(2, 4))).toEqual([]);
  });

  it('makes calls at the same instant one step, the last vector winning (the engine\'s reset writes ten sliders in one handler)', () => {
    const reset = [eq(36.8, [0, 8, 0, 0, -5, 0, 0, 0, 6, 9]), eq(36.8, [0, 0, 0, 0, -5, 0, 0, 0, 6, 9]), eq(36.8, [0, 0, 0, 0, 0, 0, 0, 0, 6, 9]), eq(36.8, [...ZEROS])];
    const loud = [10, 8, 0, 0, -5, 0, 0, 0, 6, 9];
    expect(eqSteps([eq(12.7, loud), ...reset])).toEqual([
      { t: 12.7, gains: loud },
      { t: 36.8, gains: [...ZEROS] },
    ]);
  });

  it('counts a burst that ends where it began as no step at all', () => {
    expect(eqSteps([eq(1, v(0, 2)), eq(2, v(0, 9)), eq(2, v(0, 2))])).toEqual([{ t: 1, gains: v(0, 2) }]);
  });

  it('merges a burst across the other calls made at the same instant', () => {
    const calls = [eq(5, v(0, 1)), { t: 5, cmd: 'set_capture', args: { on: false } }, eq(5, v(0, 2))];
    expect(eqSteps(calls)).toEqual([{ t: 5, gains: v(0, 2) }]);
  });

  it('keeps instants apart that are not the same millisecond', () => {
    expect(eqSteps([eq(1, v(0, 1)), eq(1.001, v(0, 2))]).map((s) => s.gains)).toEqual([v(0, 1), v(0, 2)]);
  });

  it('does not round: a fractional gain is a different vector, which is how an unquantised host shows up', () => {
    const steps = eqSteps([eq(1, v(0, 0.025283950617282613)), eq(2, v(0, 1))]);
    expect(steps).toHaveLength(2);
    expect(steps[0].gains[0]).toBe(0.025283950617282613);
    expect(eqSteps([eq(1, v(1, 7.999999999999993))], v(1, 8))).toHaveLength(1);
  });

  it('hands back copies, so a caller cannot reach into the log through a step', () => {
    const calls = [eq(1, v(0, 4))];
    const steps = eqSteps(calls);
    steps[0].gains[0] = 99;
    expect(calls[0].args.gains[0]).toBe(4);
    expect(ZEROS.every((x) => x === 0)).toBe(true);
  });
});

// ---- compareLogs -----------------------------------------------------------------------------------------------

describe('compareLogs: the synthetic tours', () => {
  it('are the same tour, so the comparison is clean (they differ the way the real two do)', () => {
    const legacy = legacyLog();
    const engine = engineLog();
    expect(checkSummary(legacy.summary)).toEqual([]);
    expect(checkEngineLog(engine)).toEqual([]);
    expect(compareLogs(legacy, engine).problems).toEqual([]);
    // The legacy re-sends and the engine does not, and the engine's distinct steps are the legacy's.
    expect(setEqCount(legacy)).toBeGreaterThan(setEqCount(engine));
    expect(eqSteps(legacy.calls)).toHaveLength(39); // 10 + 8 + 5 + 6 + 9 inputs, then the reset
    expect(eqSteps(engine.calls).map((s) => s.gains)).toEqual(eqSteps(legacy.calls).map((s) => s.gains));
  });
});

describe('compareLogs', () => {
  const problemsOf = (legacyOpts, engineOpts, engineHeader) => compareLogs(legacyLog(legacyOpts), engineLog(engineOpts, engineHeader)).problems;

  it('reports the sizes and the timing as information, and fails on neither', () => {
    const legacy = legacyLog();
    const engine = engineLog();
    const { problems, info } = compareLogs(legacy, engine);
    expect(problems).toEqual([]);
    expect(info[0]).toBe(`set_eq: legacy sent ${setEqCount(legacy)} (39 distinct steps), engine sent ${setEqCount(engine)} (39 distinct steps)`);
    // Seventeen things happen on a schedule: four mpd verbs, two drawers, five drags, five presets, the stop.
    expect(info[1]).toMatch(new RegExp(`^timing, not compared \\(engine minus legacy\\): 17 events, 17 within one frame \\(${FRAME_MS} ms\\), largest \\+0\\.000 s at`));
  });

  describe('the reference', () => {
    const rejected = (reference) => {
      const out = compareLogs(reference, engineLog());
      expect(out.info).toEqual([]);
      return out.problems;
    };

    it('must be a legacy log of this format: anything else is one problem and no comparison', () => {
      const legacy = legacyLog();
      const notLegacy = [
        undefined,
        null,
        {},
        'a log',
        { ...legacy, format: 'skinlab-demo-log/0' },
        { ...legacy, target: 'engine' },
        { ...legacy, calls: undefined },
        { ...legacy, prefs: 'no' },
        engineLog(),
      ];
      for (const reference of notLegacy) {
        const problems = rejected(reference);
        expect(problems, JSON.stringify(reference)?.slice(0, 40)).toHaveLength(1);
        expect(problems[0]).toBe(`the reference is not a ${LOG_FORMAT} log written by --target legacy`);
      }
    });

    it('must have been captured on the media preset the engine ran on', () => {
      expect(compareLogs(legacyLog({}, { media: 'playing' }), engineLog()).problems).toEqual([expect.stringMatching(/captured on media playing and the engine ran on stoppedEmpty/)]);
      expect(compareLogs(legacyLog(), engineLog({}, { media: 'stoppedQueue5' })).problems).toEqual([expect.stringMatching(/captured on media stoppedEmpty and the engine ran on stoppedQueue5/)]);
    });

    it('must be of the same skin archive, when both logs say which', () => {
      expect(compareLogs(legacyLog({}, { skinSha256: 'aa' }), engineLog({}, { skinSha256: 'bb' })).problems).toEqual(['the reference and the engine run used different skin archives']);
      expect(compareLogs(legacyLog({}, { skinSha256: 'aa' }), engineLog({}, { skinSha256: 'aa' })).problems).toEqual([]);
      expect(compareLogs(legacyLog({}, { skinSha256: 'aa' }), engineLog()).problems).toEqual([]);
      expect(compareLogs(legacyLog(), engineLog({}, { skinSha256: 'bb' })).problems).toEqual([]);
    });
  });

  describe('the transport', () => {
    it('compares the ordered verbs and arguments, and a number as a number (seekcur 0 is seekcur 0.00)', () => {
      expect(verbsOf(legacyLog())).toContain('seekcur 0');
      expect(verbsOf(engineLog())).toContain('seekcur 0.00');
      expect(problemsOf()).toEqual([]);
    });

    it('fails on a verb the engine did not send, naming where the two part and both sequences', () => {
      const problems = problemsOf({}, { media: ENGINE_MEDIA.slice(0, 3) });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^mpd verbs differ: at index 3 the engine stopped \(3\); the legacy went on with "play"; legacy \[play, pause 1, seekcur 0, play\], engine \[play, pause 1, seekcur 0\.00\]$/);
    });

    it('fails on an extra verb', () => {
      const problems = problemsOf({}, { media: [...ENGINE_MEDIA, [2, 'next', []]] });
      expect(problems).toEqual([expect.stringMatching(/mpd verbs differ: at index 4 the engine has an extra "next" \(the legacy ended after 4\)/)]);
    });

    it('fails on a different verb, and on an argument that is a different number', () => {
      const resumed = [...ENGINE_MEDIA.slice(0, 3), [1.73, 'play', [], 'pause']]; // the player was paused: `pause 0`
      expect(problemsOf({}, { media: resumed })).toEqual([expect.stringMatching(/at index 3 the legacy has "play", the engine "pause 0"/)]);
      const seeked = [ENGINE_MEDIA[0], ENGINE_MEDIA[1], [-1.5, 'seek', [1.5]], ENGINE_MEDIA[3]];
      expect(problemsOf({}, { media: seeked })).toEqual([expect.stringMatching(/at index 2 the legacy has "seekcur 0", the engine "seekcur 1\.50"/)]);
    });

    it('compares anything that is not a plain number as the exact string, and never reads a name as a property', () => {
      const legacy = legacyLog({ verbs: [...LEGACY_VERBS, [2, ['load', '__proto__']], [2.1, ['load', 'constructor']]] });
      const same = engineLog({ media: [...ENGINE_MEDIA, [2, 'playPlaylist', ['__proto__', 0]]] });
      // Different on purpose: the engine's playPlaylist adds clear and play, so these two disagree, by index, not by crashing.
      expect(compareLogs(legacy, same).problems[0]).toMatch(/^mpd verbs differ: at index 4/);
      const clear = legacyLog({ verbs: [...LEGACY_VERBS, [2, ['clear']], [2, ['load', 'constructor']], [2, ['play', '0']]] });
      const engine = engineLog({ media: [...ENGINE_MEDIA, [2, 'playPlaylist', ['constructor', 0]]] });
      expect(compareLogs(clear, engine).problems).toEqual([]);
      const other = engineLog({ media: [...ENGINE_MEDIA, [2, 'playPlaylist', ['Constructor', 0]]] });
      expect(compareLogs(clear, other).problems).toEqual([expect.stringMatching(/at index 5 the legacy has "load constructor", the engine "load Constructor"/)]);
    });
  });

  describe('the equalizer', () => {
    it('fails on a distinct step that differs, with the first place the two parted and both counts', () => {
      const problems = problemsOf({}, { drags: [[0, 10], [1, 7], [4, -5], [8, 6], [9, 9]] });
      const steps = problems.find((p) => p.startsWith('set_eq steps differ'));
      expect(steps).toMatch(/^set_eq steps differ: at index 17 the legacy has \[10,8,0,0,0,0,0,0,0,0\], the engine \[10,7,0,0,-1,0,0,0,0,0\] \(legacy 39 steps, engine 38\)$/);
    });

    it('fails on a step the engine sent as a fraction', () => {
      const problems = problemsOf({}, { fractional: true });
      expect(problems).toEqual([expect.stringMatching(/^set_eq steps differ: at index 0 the legacy has \[1,0,0,0,0,0,0,0,0,0\], the engine \[0\.63,0,0,0,0,0,0,0,0,0\]/)]);
    });

    it('fails when the engine goes on after the legacy ended, or ends first', () => {
      const stepsProblem = (problems) => problems.find((p) => p.startsWith('set_eq steps differ'));
      const extraStep = { t: 38, event: { kind: 'call', cmd: 'set_eq', args: { gains: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] } } };
      expect(stepsProblem(problemsOf({}, { extra: [extraStep] }))).toBe(
        'set_eq steps differ: at index 39 the engine has an extra [1,0,0,0,0,0,0,0,0,0] (the legacy ended after 39) (legacy 39 steps, engine 40)',
      );
      // An engine that never reset stops one step short: the legacy's last step is the zeros of its reset.
      const engine = engineLog();
      engine.calls = engine.calls.filter((c) => !(c.cmd === 'set_eq' && c.t >= 36));
      expect(stepsProblem(compareLogs(legacyLog(), engine).problems)).toBe(
        'set_eq steps differ: at index 38 the engine stopped (38); the legacy went on with [0,0,0,0,0,0,0,0,0,0] (legacy 39 steps, engine 38)',
      );
    });

    it('fails on one drag fewer or one drag more, and says where the two parted', () => {
      const stepsProblem = (problems) => problems.find((p) => p.startsWith('set_eq steps differ'));
      expect(stepsProblem(problemsOf({}, { drags: [...DRAGS, [2, 3]] }))).toBe(
        'set_eq steps differ: at index 38 the legacy has [0,0,0,0,0,0,0,0,0,0], the engine [10,8,1,0,-5,0,0,0,6,9] (legacy 39 steps, engine 42)',
      );
      expect(stepsProblem(problemsOf({}, { drags: DRAGS.slice(0, 4) }))).toMatch(/^set_eq steps differ: at index 29 the legacy has \[10,8,0,0,-5,0,0,0,6,1\], the engine \[0,0,0,0,0,0,0,0,0,0\] \(legacy 39 steps, engine 30\)$/);
    });

    it('does not fail on how many set_eq calls were sent, only on the distinct steps', () => {
      const legacy = legacyLog();
      const engine = engineLog();
      expect(setEqCount(legacy)).not.toBe(setEqCount(engine));
      expect(compareLogs(legacy, engine).problems).toEqual([]);
    });

    it('fails on a drag that ended on another band or another value, and on the values after the drags', () => {
      const problems = problemsOf({}, { drags: [[0, 10], [1, 7], [4, -5], [8, 6], [9, 9]] });
      expect(problems).toContain('the slider drags differ: at index 1 the legacy has band 1 -> 8, the engine band 1 -> 7');
      expect(problems).toContain('band values after the drags: legacy [10,8,0,0,-5,0,0,0,6,9], engine [10,7,0,0,-5,0,0,0,6,9]');
      const band = problemsOf({}, { drags: [[0, 10], [2, 8], [4, -5], [8, 6], [9, 9]] });
      expect(band).toContain('the slider drags differ: at index 1 the legacy has band 1 -> 8, the engine band 2 -> 8');
    });

    it('fails on a drag the engine did not make, and on one it added', () => {
      const missing = problemsOf({}, { drags: DRAGS.slice(0, 4) });
      expect(missing).toContain('the slider drags differ: at index 4 the engine stopped (4); the legacy went on with band 9 -> 9');
      const added = problemsOf({}, { drags: [...DRAGS, [2, 3]] });
      expect(added).toContain('the slider drags differ: at index 5 the engine has an extra band 2 -> 3 (the legacy ended after 5)');
    });
  });

  describe('the preset steps', () => {
    it('fails on a step fewer or more, with both runs\' values', () => {
      expect(problemsOf({}, { presets: PRESETS.slice(0, 4) })).toEqual(['preset steps: legacy 5 (2 -> 3 -> 4 -> 0 -> 1), engine 4 (2 -> 3 -> 4 -> 0)']);
      expect(problemsOf({}, { presets: [...PRESETS, '5'] })).toEqual(['preset steps: legacy 5 (2 -> 3 -> 4 -> 0 -> 1), engine 6 (2 -> 3 -> 4 -> 0 -> 1 -> 5)']);
    });

    it('fails on the same number of steps landing on other presets', () => {
      expect(problemsOf({}, { presets: ['2', '3', '4', '1', '0'] })).toEqual(['preset steps: legacy 5 (2 -> 3 -> 4 -> 0 -> 1), engine 5 (2 -> 3 -> 4 -> 1 -> 0)']);
    });

    it('compares a preset index as text, so 1 and "1" agree', () => {
      const legacy = legacyLog({ presets: [2, 3, 4, 0, 1] });
      expect(compareLogs(legacy, engineLog()).problems).toEqual([]);
    });
  });

  describe('the drawers and the recorder', () => {
    it('fails when the engine never opened the EQ drawer', () => {
      expect(problemsOf({}, { eqOpenAt: null })).toEqual(['the engine never opened the EQ drawer']);
    });

    it('fails when the EQ drawer opened at or after the first drag, and when it opened after the deadline', () => {
      const first = FIRST_DRAG_AT;
      expect(problemsOf({}, { eqOpenAt: first })).toEqual([`the engine opened the EQ drawer at ${first.toFixed(3)} s, not before its first drag at ${first.toFixed(3)} s`]);
      expect(problemsOf({}, { eqOpenAt: first + 1 })).toEqual([expect.stringMatching(/the engine opened the EQ drawer at 9\.960 s, not before its first drag at 8\.960 s/)]);
      // Before the first drag, but after the 8.6 s the pinned tour schedules it for.
      expect(EXPECT.eqOpenBeforeS).toBeLessThan(first);
      expect(problemsOf({}, { eqOpenAt: 8.7 })).toEqual([`the engine opened the EQ drawer at 8.700 s, after ${EXPECT.eqOpenBeforeS} s`]);
      expect(problemsOf({}, { eqOpenAt: EXPECT.eqOpenBeforeS })).toEqual([]);
    });

    it('applies the deadline when the engine made no drag at all', () => {
      const out = problemsOf({}, { drags: [], eqOpenAt: 8.7 });
      expect(out).toContain(`the engine opened the EQ drawer at 8.700 s, after ${EXPECT.eqOpenBeforeS} s`);
    });

    it('fails when the playlist drawer opened in one run only', () => {
      expect(problemsOf({}, { plOpenAt: null })).toEqual(['the playlist drawer opened in one run only: legacy 5.500 s, engine never']);
      expect(problemsOf({ plOpenAt: null }, {})).toEqual(['the playlist drawer opened in one run only: legacy never, engine 5.500 s']);
      expect(problemsOf({ plOpenAt: null }, { plOpenAt: null })).toEqual([]);
    });

    it('fails when the recorder did not both start and stop, and does not also compare a path it has none of', () => {
      const problems = problemsOf({}, { record: false });
      expect(problems).toContain('the engine tour did not both start and stop the recorder');
      expect(problems.some((p) => /record_stop wrote to/.test(p))).toBe(false);
      // Without record_start the log is timed from the trigger, 1.8 s early, which the other checks then see too.
      expect(problems).toContainEqual(expect.stringMatching(/the engine opened the EQ drawer at 10\.044 s, after 8\.6 s/));
    });

    it('fails when the recording was written somewhere else', () => {
      expect(problemsOf({}, { wav: '/tmp/other.wav' })).toEqual([`record_stop wrote to "/tmp/other.wav" on the engine and "${DEMO_WAV}" on the legacy`]);
    });
  });

  describe('time', () => {
    const timing = (skew) => compareLogs(legacyLog(), engineLog({ skew }));

    it('is not compared: a tour 300 ms later or earlier than the legacy\'s is the same tour, and the information says by how much', () => {
      for (const [skew, sign] of [[0.3, '+'], [-0.3, '-']]) {
        const { problems, info } = timing(skew);
        expect(problems, `skew ${skew}`).toEqual([]);
        // The three stage-setup verbs are before record_start and do not move with it.
        expect(info[1], `skew ${skew}`).toMatch(new RegExp(`17 events, 3 within one frame \\(${FRAME_MS} ms\\), largest \\${sign}0\\.300 s at`));
      }
    });

    it('counts what is within one frame', () => {
      const { problems, info } = timing(0.008);
      expect(problems).toEqual([]);
      expect(info[1]).toMatch(/17 events, 17 within one frame/);
      expect(timing(0.032).info[1]).toMatch(/17 events, 3 within one frame/);
    });
  });

  describe('what it reads', () => {
    it('recomputes both summaries from the calls and prefs, whatever the files say about themselves', () => {
      const legacy = legacyLog();
      const engine = engineLog();
      // A summary that lies about a clean run changes nothing ...
      expect(compareLogs({ ...legacy, summary: { drags: [], mpd: [], presetSteps: 99 } }, { ...engine, summary: null }).problems).toEqual([]);
      // ... and one that lies about a broken run does not hide it.
      const broken = engineLog({ drags: DRAGS.slice(0, 4) });
      broken.summary = engine.summary;
      expect(compareLogs(legacy, broken).problems.length).toBeGreaterThan(0);
    });

    it('gives the same answer on the logs as they come back from disk, __proto__ and constructor keys included', () => {
      const { raw } = engineRaw({ ...engineTour(), others: [['__proto__', 2], ['constructor', 3]] });
      const engine = buildLog(raw, { media: DEFAULT_MEDIA, target: 'engine' });
      const legacy = buildLog({ ...legacyTour(), others: [['__proto__', 1], ['constructor', 1], ['engine_info', 1]] }, { media: DEFAULT_MEDIA });
      const direct = compareLogs(legacy, engine);
      const fromDisk = compareLogs(JSON.parse(JSON.stringify(legacy)), JSON.parse(JSON.stringify(engine)));
      expect(fromDisk).toEqual(direct);
      expect(fromDisk.problems).toEqual([]);
      expect({}.polluted).toBeUndefined();
    });

    it('leaves both logs as it found them', () => {
      const legacy = legacyLog();
      const engine = engineLog({ fractional: true });
      const [l, e] = [structuredClone(legacy), structuredClone(engine)];
      expect(compareLogs(legacy, engine).problems.length).toBeGreaterThan(0);
      expect(legacy).toEqual(l);
      expect(engine).toEqual(e);
    });

    it('lists every difference it finds, not only the first', () => {
      const problems = problemsOf({}, { eqOpenAt: null, plOpenAt: null, presets: PRESETS.slice(1), wav: '/tmp/other.wav', media: ENGINE_MEDIA.slice(0, 2) });
      for (const expected of [/^mpd verbs differ/, /^preset steps/, /^the engine never opened the EQ drawer/, /^the playlist drawer opened in one run only/, /^record_stop wrote to/]) {
        expect(problems.some((p) => expected.test(p)), String(expected)).toBe(true);
      }
    });
  });
});

// ---- checkEngineLog ----------------------------------------------------------------------------------------------

describe('checkEngineLog', () => {
  it('passes the tour the card describes', () => {
    expect(checkEngineLog(engineLog())).toEqual([]);
  });

  it('asks the engine the numbers it asks the legacy, in the engine\'s own words', () => {
    const problems = (opts) => checkEngineLog(engineLog(opts)).join('\n');
    expect(problems({ record: false })).toMatch(/never called record_start/);
    expect(problems({ record: false })).toMatch(/never called record_stop/);
    expect(problems({ eqOpenAt: null })).toMatch(/EQ drawer never opened/);
    expect(problems({ eqOpenAt: 9.5 })).toMatch(/opened at t = 9\.5 s, after the first drag was due \(8\.6 s\)/);
    expect(problems({ presets: PRESETS.slice(0, 4) })).toMatch(/4 preset steps, expected 5/);
    expect(problems({ wav: '/tmp/other.wav' })).toMatch(/record_stop wrote to "\/tmp\/other\.wav"/);
    expect(problems({ drags: DRAGS.slice(0, 4) })).toMatch(/drags moved bands \[0,1,4,8\], expected \[0,1,4,8,9\]/);
    expect(problems({ drags: DRAGS.slice(0, 4) })).toMatch(/band values after the drags are \[10,8,0,0,-5,0,0,0,6,0\]/);
    const noisy = engineLog({ extra: [{ t: 20, event: { kind: 'call', cmd: 'js_log', args: { msg: 'TypeError: boom' } } }] });
    expect(checkEngineLog(noisy)).toEqual(['the engine reported: TypeError: boom']);
  });

  it('does not ask the engine for the legacy\'s persisted copy of each drag: the test host persists nothing', () => {
    const log = engineLog();
    expect(log.summary.drags.every((d) => d.persisted === null)).toBe(true);
    expect(checkEngineLog(log)).toEqual([]);
    // The same log read as a legacy log is faulted for it, once per drag.
    expect(checkSummary(log.summary, { target: 'legacy' }).filter((p) => /the legacy persisted/.test(p))).toHaveLength(5);
  });

  describe('fractional gains', () => {
    it('names them on their own, with how many calls, the first one, and why', () => {
      const log = engineLog({ fractional: true });
      const sent = log.calls.filter((c) => c.cmd === 'set_eq');
      const problems = checkEngineLog(log);
      // Everything but each drag's last value is fractional; the ten values of the first drag come first.
      const fractional = sent.filter((c) => c.args.gains.some((g) => !Number.isInteger(g)));
      expect(fractional.length).toBeGreaterThan(0);
      expect(fractional.length).toBeLessThan(sent.length);
      expect(problems).toHaveLength(1); // the drags still land on whole values: only the fractions are wrong
      expect(problems[0]).toContain(`the engine sent ${fractional.length} of ${sent.length} set_eq calls with fractional gains`);
      expect(problems[0]).toContain(`first at t = ${fractional[0].t} s: [0.63]`);
      expect(problems[0]).toMatch(/parity D31 quantises gains in the host binding and nothing here does/);
    });

    it('shows at most three of the first call\'s fractional values', () => {
      const wide = engineLog();
      wide.calls.push({ t: 40, cmd: 'set_eq', args: { gains: [0.1, 0.2, 0.3, 0.4, 0.5, 1, 2, 3, 4, 5] } });
      expect(checkEngineLog(wide).join('\n')).toContain('first at t = 40 s: [0.1,0.2,0.3]');
    });

    it('goes with the wrong band values when the last input of a drag is a fraction too (the first real run)', () => {
      const drift = engineLog({ fractional: true, finalFor: (band, db) => (band === 1 ? db - 7e-15 : db) });
      const problems = checkEngineLog(drift);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/band values after the drags are \[10,7\.999999999999993,0,0,-5,0,0,0,6,9\]/);
      expect(problems[1]).toMatch(/with fractional gains/);
    });

    it('does not mind whole gains in a vector of any sign, including a negative zero', () => {
      const log = engineLog();
      log.calls.push({ t: 40, cmd: 'set_eq', args: { gains: [-3, 0, -0, 12, -12, 1, 2, 3, 4, 5] } });
      expect(checkEngineLog(log)).toEqual([]);
    });

    it('reads only set_eq calls that carry a vector', () => {
      const log = engineLog();
      log.calls.push(
        { t: 40, cmd: 'set_balance', args: { balance: 0.5 } },
        { t: 40, cmd: 'set_eq', args: { gains: 'x' } },
        { t: 40, cmd: 'set_eq' },
        { t: 40, cmd: 'mpd', args: { gains: [0.5] } },
      );
      expect(checkEngineLog(log)).toEqual([]);
    });
  });
});

// ---- formatReport on an engine log ------------------------------------------------------------------------------

describe('formatReport for the engine', () => {
  it('names the engine and prints the numbers a reader checks', () => {
    const text = formatReport(engineLog());
    expect(text).toMatch(/^engine demo tour, media stoppedEmpty, t = 0 at record_start/);
    expect(text).toMatch(/mpd \(4\): play @-1\.80, pause 1 @-1\.50, seekcur 0\.00 @-1\.50, play @1\.73/);
    expect(text).toContain('band values after the drags: [10,8,0,0,-5,0,0,0,6,9]');
    expect(text).toMatch(/preset steps: 5/);
    expect(text).toMatch(/drags \(5\): band 0 -> 10 @8\.96-9\.14, band 1 -> 8/);
  });

  it('prints a log with no tour in it without throwing', () => {
    const log = buildLog({ events: [] }, { media: DEFAULT_MEDIA, target: 'engine' });
    expect(() => formatReport(log)).not.toThrow();
    expect(formatReport(log)).toMatch(/record_start at never, record_stop at never/);
  });
});

// ---- the mount and the translation agree --------------------------------------------------------------------------

describe('demo-engine-mount.js', () => {
  const read = () => readFile(path.join(SKINLAB_DIR, 'demo-engine-mount.js'), 'utf8');

  it('is served from where cmd-demo imports it', async () => {
    expect(ENGINE_MOUNT_URL).toBe('/tools/skinlab/demo-engine-mount.js');
    await expect(read()).resolves.toContain('window.__skinlabDemoEngine = { run }');
  });

  it('records no media command that mpdArgvOf cannot translate', async () => {
    const src = (await read()).replace(/\/\/.*$/gm, '');
    const list = /const MEDIA_COMMANDS = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
    expect(list).not.toBeNull();
    const names = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(mpdArgvOf(name, [], 'stop'), name).not.toBeNull();
  });

  it('counts the command names it does not log in a Map (names come from the engine)', async () => {
    expect(await read()).toMatch(/const others = new Map\(\)/);
  });
});
