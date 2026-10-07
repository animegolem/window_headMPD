// @vitest-environment happy-dom
// @ts-check
// The demo tour (WAVES W3.8; ENGINE D10.7): the generic driver against a fake `DemoTarget` on a scripted
// clock, the target built from an inspector, and the Headspace choreography, which must ask the screen
// where things are and never carry a pixel of the old layout. Time here is virtual: a 40 s tour runs in
// milliseconds, and the schedule is checked to the millisecond.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as macrotask } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clockFromEngine, runTour, tauriBridge } from '../../src/app/demo/driver.js';
import { TOUR_KEYS, createHeadspaceChoreography, parseTour } from '../../src/app/demo/headspace.js';
import { createDemoTarget } from '../../src/app/demo/target.js';
import { SIDECAR_SCHEMA } from '../../src/app/sidecar.js';
import { createEffectsControl } from '../../src/hosts/test/slots.js';
import { createFakeMedia } from '../../src/hosts/test/media.js';
import { createManualClock } from '../../src/hosts/test/clock.js';

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const HEADSPACE = '76a8662f469881bf5ed6eb93595042fdb188c65663135da6ff4dcd10b37bf85d';
// Paths, not `new URL(..., import.meta.url)`: happy-dom replaces the URL global and loses the file base.
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'app');
const SIDECAR = JSON.parse(readFileSync(join(APP, 'sidecars', `${HEADSPACE}.json`), 'utf8'));
const WAV = '/tmp/window_headmpd-demo-test.wav';
/** @param {string} file */
const source = (file) => readFileSync(join(APP, 'demo', file), 'utf8');

// ---- a virtual clock ---------------------------------------------------------------------------------------

/**
 * Time moves only when every promise in the program is waiting on it. `run` drives a promise to its
 * end; `at` schedules a probe at a virtual time.
 */
function virtualClock() {
  let t = 0;
  let seq = 0;
  /** @type {Array<{ at: number, seq: number, fire: () => void }>} */
  const queue = [];
  return {
    now: () => t,
    /** @param {number} ms @returns {Promise<void>} */
    sleep: (ms) => new Promise((resolve) => { queue.push({ at: t + Math.max(0, ms), seq: seq++, fire: () => resolve() }); }),
    /** @param {number} ms @param {() => void} fn */
    at(ms, fn) { queue.push({ at: ms, seq: seq++, fire: fn }); },
    /** @param {Promise<unknown>} promise */
    async run(promise) {
      let settled = false;
      /** @type {{ error: unknown } | null} */
      let failed = null;
      promise.then(() => { settled = true; }, (error) => { settled = true; failed = { error }; });
      for (;;) {
        await macrotask();                                     // every microtask the last step released
        if (settled) break;
        if (queue.length === 0) throw new Error('deadlock: nothing is waiting on the clock');
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = /** @type {NonNullable<typeof queue[number]>} */ (queue.shift());
        t = Math.max(t, next.at);
        next.fire();
      }
      if (failed) throw /** @type {{ error: unknown }} */ (failed).error;
    },
  };
}

// ---- a fake screen -----------------------------------------------------------------------------------------

const RECT = { left: 100, top: 50, width: 1140, height: 591, right: 1240, bottom: 641, x: 100, y: 50, toJSON() {} };
const ZOOM = 1.5;

/**
 * A DemoTarget over a screen that does not exist: every point it hands out is remembered under a name,
 * so a pointer event can be traced back to what the tour was aiming at. Every call is logged. Slider
 * values are kept (`setAttr` writes them), and the drawers toggle.
 * @param {{ clock: { now(): number }, media?: string, eq?: number[], open?: Record<string, boolean>, missing?: string[], effectsIndex?: number }} o
 */
function fakeScreen({ clock, media = 'stoppedQueue5', eq = [3, -2, 0, 5, 1, 0, 0, -4, 2, 7], open = {}, missing = [], effectsIndex = 0 }) {
  const root = document.createElement('div');
  const plane = document.createElement('div');
  root.appendChild(plane);
  document.body.appendChild(root);
  root.getBoundingClientRect = () => /** @type {DOMRect} */ (RECT);

  /** @type {Map<string, { x: number, y: number }>} */
  const points = new Map();
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @param {string} name */
  const issue = (name) => {
    if (missing.includes(name.split('/')[0].split('@')[0])) return null;
    let p = points.get(name);
    if (!p) {
      const k = points.size;
      p = { x: 300 + 37 * k, y: 120 + 11 * k };
      points.set(name, p);
      names.set(`${p.x},${p.y}`, name);
    }
    return { ...p };
  };

  /** @type {Array<[string, ...unknown[]]>} */
  const calls = [];
  /** @type {Map<string, number>} */
  const values = new Map(eq.map((v, i) => [`eq${i + 1}`, v]));
  /** @type {Record<string, boolean>} */
  const drawers = { eqIsOpen: false, plIsOpen: false, visIsOpen: false, ...open };
  const toggles = new Map([['ToggleEqView', 'eqIsOpen'], ['TogglePlView', 'plIsOpen'], ['ToggleVisView', 'visIsOpen']]);

  const fakeMedia = createFakeMedia(media, { clock });
  const effects = createEffectsControl({ index: effectsIndex });

  /** @type {import('../../src/app/demo/target.js').DemoTarget} */
  const target = {
    root: () => root,
    zoom: () => ZOOM,
    clientPoint(ref, fx, fy) { calls.push(['clientPoint', ref, fx, fy]); return issue(ref); },
    groupPoint(group, color) { calls.push(['groupPoint', group, color]); return issue(`${group}/${color}`); },
    sliderThumbPoint(ref, value) { calls.push(['sliderThumbPoint', ref, value]); return issue(`${ref}@${value}`); },
    call(fn, ...args) {
      calls.push(['call', fn, ...args]);
      const flag = toggles.get(fn);
      if (flag) drawers[flag] = !drawers[flag];
      return undefined;
    },
    get(name) { calls.push(['get', name]); return drawers[name] ?? null; },
    attr(ref, name) { calls.push(['attr', ref, name]); return values.get(ref) ?? 0; },
    setAttr(ref, name, v) { calls.push(['setAttr', ref, name, v]); values.set(ref, /** @type {number} */ (v)); },
    media: fakeMedia,
    effects,
  };

  /** @type {Array<{ type: string, t: number, name: string | undefined, x: number, y: number, buttons: number }>} */
  const events = [];
  for (const type of ['pointerenter', 'pointerleave', 'pointermove', 'pointerdown', 'pointerup', 'click']) {
    plane.addEventListener(type, (e) => {
      const m = /** @type {PointerEvent} */ (e);
      events.push({ type, t: clock.now(), name: names.get(`${m.clientX},${m.clientY}`), x: m.clientX, y: m.clientY, buttons: m.buttons });
    });
  }
  return { root, plane, target, calls, events, values, drawers, points, elementFromPoint: () => plane };
}

/** The recorder and the log of one run. @param {{ now(): number }} clock */
function fakeEnv(clock) {
  /** @type {Array<{ at: number, what: string, path?: string }>} */
  const recorder = [];
  /** @type {string[]} */
  const log = [];
  return {
    recorder,
    log,
    record: {
      start: async () => { recorder.push({ at: clock.now(), what: 'start' }); },
      stop: async (/** @type {string} */ path) => { recorder.push({ at: clock.now(), what: 'stop', path }); },
    },
    sink: (/** @type {string} */ m) => { log.push(m); },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
  invoke.mockClear();
});

// ---- the driver ------------------------------------------------------------------------------------------------

describe('the driver: pointer events', () => {
  /** A tour whose script is `run`, with no stage and nothing to restore. @param {(d: any, t: any) => Promise<void>} run */
  const tourOf = (run) => ({ name: 'test', stage: async () => {}, run: async (t, d) => run(d, t) });

  /** @param {(d: any, t: any) => Promise<void>} run */
  async function drive(run) {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, tourOf(run), WAV, {
      clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink,
    }));
    return { clock, screen, env };
  }

  it('a click is move, enter once, down, 130 ms, up, then the DOM click', async () => {
    const at = { x: 400, y: 300 };
    const { screen } = await drive(async (d) => {
      await d.glide(at, 100);
      await d.click();
    });
    const kinds = screen.events.map((e) => e.type);
    expect(kinds[0]).toBe('pointerenter');
    expect(kinds.filter((k) => k === 'pointerenter')).toHaveLength(1);
    expect(kinds).not.toContain('pointerleave');
    // 100 ms of glide is steps at 0, 16, ... 96 and the landing at 112 ms: eight moves in all.
    expect(kinds.slice(1, -3).every((k) => k === 'pointermove')).toBe(true);
    expect(kinds.slice(-3)).toEqual(['pointerdown', 'pointerup', 'click']);
    const [down, up, click] = screen.events.slice(-3);
    for (const e of [down, up, click]) expect([e.x, e.y]).toEqual([at.x, at.y]);
    expect(down.buttons).toBe(1);
    expect(up.buttons).toBe(0);
    expect(up.t - down.t).toBe(130);
    expect(click.t).toBe(up.t);
  });

  it('a glide eases in and out, in 16 ms frames, and lands exactly on the target', async () => {
    const from = { x: 20, y: 40 };
    const to = { x: 420, y: 340 };
    const { screen } = await drive(async (d) => {
      d.moveTo(from);
      await d.glide(to, 160);
    });
    const moves = screen.events.filter((e) => e.type === 'pointermove');
    expect(moves.map((m) => m.t - moves[0].t)).toEqual([0, 0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160]);
    expect([moves[0].x, moves[0].y]).toEqual([from.x, from.y]);
    const xs = moves.slice(1).map((m) => m.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));                 // never backwards
    expect(moves.at(-1)).toMatchObject({ x: to.x, y: to.y });          // exact, not within rounding
    expect(xs[1] - xs[0]).toBeLessThan(xs[7] - xs[6]);                  // slow at the start, quick in the middle
    expect(xs.at(-1) - xs.at(-2)).toBeLessThan(xs[7] - xs[6]);          // and slow at the end
  });

  it('lands on the target to the last bit even where from + (to - from) would be a bit off', async () => {
    const to = { x: 0.9, y: 0.9 };
    expect(1 / 3 + (to.x - 1 / 3)).not.toBe(to.x);                      // the case is real
    const { screen } = await drive(async (d) => {
      d.moveTo({ x: 1 / 3, y: 1 / 3 });
      await d.glide(to, 48);
    });
    const last = screen.events.filter((e) => e.type === 'pointermove').at(-1);
    expect([last?.x, last?.y]).toEqual([to.x, to.y]);
  });

  it('a zero-length glide is one move', async () => {
    const { screen } = await drive(async (d) => { await d.glide({ x: 7, y: 9 }, 0); });
    expect(screen.events.filter((e) => e.type === 'pointermove')).toHaveLength(1);
  });

  it('a drag: down at the start, moves with the button held to the captured element, no hover, up at the end', async () => {
    const start = { x: 410, y: 310 };
    const end = { x: 410, y: 210 };
    const { screen } = await drive(async (d) => {
      d.moveTo(start);
      d.press();
      await d.glide(end, 64);
      d.release();
    });
    const i = screen.events.findIndex((e) => e.type === 'pointerdown');
    const after = screen.events.slice(i);
    expect(after[0]).toMatchObject({ type: 'pointerdown', x: start.x, y: start.y, buttons: 1 });
    const held = after.slice(1, -2);
    expect(held.length).toBeGreaterThan(3);
    expect(held.every((e) => e.type === 'pointermove' && e.buttons === 1)).toBe(true);
    expect(held.at(-1)).toMatchObject({ x: end.x, y: end.y });
    expect(after.slice(-2).map((e) => e.type)).toEqual(['pointerup', 'click']);
    expect(after.at(-2)).toMatchObject({ x: end.x, y: end.y, buttons: 0 });
    // the only enter is the first move, before the press
    expect(screen.events.filter((e) => e.type === 'pointerenter' || e.type === 'pointerleave')).toHaveLength(1);
  });

  it('moving to another element leaves the first and enters the second', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const other = document.createElement('div');
    screen.root.appendChild(other);
    /** @type {string[]} */
    const trace = [];
    for (const type of ['pointerenter', 'pointerleave']) {
      screen.plane.addEventListener(type, () => trace.push(`plane:${type}`));
      other.addEventListener(type, () => trace.push(`other:${type}`));
    }
    let over = screen.plane;
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, tourOf(async (d) => {
      d.moveTo({ x: 1, y: 1 });
      over = other;
      d.moveTo({ x: 2, y: 2 });
      d.moveTo({ x: 3, y: 3 });
    }), WAV, { clock, elementFromPoint: () => over, record: env.record, log: env.sink }));
    expect(trace).toEqual(['plane:pointerenter', 'plane:pointerleave', 'other:pointerenter']);
  });

  it('pointer events carry the legacy fields: id 1, primary mouse, bubbling except enter and leave', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    /** @type {PointerEvent[]} */
    const seen = [];
    for (const type of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup']) screen.plane.addEventListener(type, (e) => seen.push(/** @type {PointerEvent} */ (e)));
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, tourOf(async (d) => { d.moveTo({ x: 5, y: 6 }); await d.click(); }), WAV, {
      clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink,
    }));
    for (const e of seen) {
      expect([e.pointerId, e.isPrimary, e.pointerType, e.button, e.cancelable]).toEqual([1, true, 'mouse', 0, true]);
      expect(e.bubbles).toBe(e.type !== 'pointerenter');
      expect(e.isTrusted).not.toBe(true);                             // synthetic, so a press on bare skin never starts a native drag
    }
    expect(seen.map((e) => e.type)).toEqual(['pointerenter', 'pointermove', 'pointerdown', 'pointerup']);
  });

  it('hits the page through document.elementFromPoint unless told otherwise', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const spy = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => /** @type {Element} */ (screen.plane));
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, tourOf(async (d) => { d.moveTo({ x: 11, y: 12 }); }), WAV, { clock, record: env.record, log: env.sink }));
    expect(spy).toHaveBeenCalledWith(11, 12);
    spy.mockRestore();
    expect(screen.events.map((e) => e.type)).toEqual(['pointerenter', 'pointermove']);
  });
});

describe('the driver: cursor, flash, recorder, log', () => {
  it('draws the cursor in skin px at z 1000 above the view, and takes it away', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    /** @type {Array<{ left: string, top: string, z: string, events: string, demo: boolean, attached: boolean }>} */
    const seen = [];
    const probe = () => {
      const img = /** @type {HTMLImageElement | undefined} */ ([...screen.root.children].find((c) => c.tagName === 'IMG'));
      seen.push({
        left: img?.style.left ?? '', top: img?.style.top ?? '', z: img?.style.zIndex ?? '',
        events: img?.style.pointerEvents ?? '', demo: document.body.classList.contains('demo'), attached: !!img,
      });
    };
    clock.at(150, probe);
    await clock.run(runTour(screen.target, {
      name: 'cursor',
      stage: async () => {},
      run: async (_t, d) => { d.moveTo({ x: 100 + 30 * ZOOM, y: 50 + 90 * ZOOM }); await d.sleep(100); probe(); },
    }, WAV, { clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink }));
    expect(seen[0]).toEqual({ left: '30px', top: '90px', z: '1000', events: 'none', demo: true, attached: true });
    expect(seen[1]).toMatchObject({ left: '30px', top: '90px', demo: true });
    expect([...screen.root.children].some((c) => c.tagName === 'IMG')).toBe(false);
    expect(document.body.classList.contains('demo')).toBe(false);
  });

  it('flashes the whole view white at z 2000 for 120 ms, and the recorder starts on that frame', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    const flash = () => [...screen.root.children].find((c) => /** @type {HTMLElement} */ (c).style?.zIndex === '2000');
    /** @type {Array<{ t: number, flash: boolean }>} */
    const seen = [];
    for (const t of [1499, 1501, 1619, 1621]) clock.at(t, () => { seen.push({ t, flash: !!flash() }); });
    let style = '';
    clock.at(1500 + 60, () => { style = /** @type {HTMLElement} */ (flash()).style.cssText; });
    await clock.run(runTour(screen.target, {
      name: 'flash', stage: async (_t, d) => { await d.sleep(1500); }, run: async (_t, d) => { await d.sleep(200); },
    }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }));
    expect(env.recorder[0]).toEqual({ at: 1500, what: 'start' });
    expect(seen).toEqual([{ t: 1499, flash: false }, { t: 1501, flash: true }, { t: 1619, flash: true }, { t: 1621, flash: false }]);
    expect(style).toContain('background: #fff');
    expect(style).toContain('pointer-events: none');
  });

  it('runs stage, then the recorder and the flash, then the run on the tour clock, then stops the recorder', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    /** @type {Array<[string, number]>} */
    const order = [];
    await clock.run(runTour(screen.target, {
      name: 'order',
      stage: async (_t, d) => { order.push(['stage', d.now()]); await d.sleep(1000); order.push(['staged', d.now()]); },
      run: async (_t, d) => {
        order.push(['run', d.now()]);
        await d.until(2);
        order.push(['until 2', d.now()]);
        expect(d.elapsed()).toBe(2);
        await d.until(1);                                              // already past: no wait
        order.push(['until 1', d.now()]);
      },
      restore: async (_t, d) => { order.push(['restore', d.now()]); },
    }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }));
    expect(order).toEqual([['stage', 0], ['staged', 1000], ['run', 1120], ['until 2', 3000], ['until 1', 3000], ['restore', 3000]]);
    expect(env.recorder).toEqual([{ at: 1000, what: 'start' }, { at: 3000, what: 'stop', path: WAV }]);
    expect(env.log).toEqual(['demo: started', `demo: wrote ${WAV}`, 'demo: done']);
  });

  it('until() before the flash waits for nothing', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    let at = -1;
    await clock.run(runTour(screen.target, {
      name: 'early', stage: async (_t, d) => { await d.until(5); at = d.now(); }, run: async () => {},
    }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }));
    expect(at).toBe(0);
  });

  it('a recorder that fails to stop is logged and the tour still ends', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, { name: 'x', stage: async () => {}, run: async () => {} }, WAV, {
      clock, elementFromPoint: screen.elementFromPoint, log: env.sink,
      record: { start: async () => {}, stop: async () => { throw new Error('disk full'); } },
    }));
    expect(env.log).toContain('demo: record failed: Error: disk full');
    expect(env.log.at(-1)).toBe('demo: done');
  });

  describe('a tour that fails', () => {
    it('stops the recorder, takes the cursor and the flash away, restores, and rejects with the error', async () => {
      const clock = virtualClock();
      const screen = fakeScreen({ clock });
      const env = fakeEnv(clock);
      const restore = vi.fn(async () => {});
      const boom = new Error('the skin is gone');
      const result = clock.run(runTour(screen.target, {
        name: 'boom', stage: async () => {}, run: async (_t, d) => { await d.sleep(10); throw boom; }, restore,
      }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }));
      await expect(result).rejects.toBe(boom);
      expect(env.recorder.map((r) => r.what)).toEqual(['start', 'stop']);
      expect(restore).toHaveBeenCalledTimes(1);
      expect([...screen.root.children]).toEqual([screen.plane]);
      expect(document.body.classList.contains('demo')).toBe(false);
      expect(env.log.at(-1)).toBe('demo: aborted');
    });

    it('never starts the recorder when the stage fails, and has nothing to stop', async () => {
      const clock = virtualClock();
      const screen = fakeScreen({ clock });
      const env = fakeEnv(clock);
      const restore = vi.fn(async () => {});
      const boom = new Error('no such drawer');
      await expect(clock.run(runTour(screen.target, {
        name: 'stage', stage: async () => { throw boom; }, run: async () => {}, restore,
      }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }))).rejects.toBe(boom);
      expect(env.recorder).toEqual([]);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(document.body.classList.contains('demo')).toBe(false);
    });

    it('does not let a failing restore hide the real error', async () => {
      const clock = virtualClock();
      const screen = fakeScreen({ clock });
      const env = fakeEnv(clock);
      const boom = new Error('first');
      await expect(clock.run(runTour(screen.target, {
        name: 'r', stage: async () => {}, run: async () => { throw boom; }, restore: async () => { throw new Error('second'); },
      }, WAV, { clock, record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }))).rejects.toBe(boom);
      expect(env.log).toContain('demo: restore failed: Error: second');
    });
  });
});

describe('the driver: clocks and the Tauri bridge', () => {
  it('clockFromEngine sleeps on the engine clock and reads its time', async () => {
    const engine = createManualClock({ start: 5 });
    const clock = clockFromEngine(engine);
    expect(clock.now()).toBe(5);
    let woke = false;
    const sleeping = clock.sleep(40).then(() => { woke = true; });
    engine.advance(39);
    await macrotask();
    expect(woke).toBe(false);
    engine.advance(1);
    await sleeping;
    expect(woke).toBe(true);
    expect(clock.now()).toBe(45);
  });

  it('a tour runs on the test host\'s manual clock too', async () => {
    const engine = createManualClock();
    const screen = fakeScreen({ clock: engine });
    const env = fakeEnv(engine);
    let finished = false;
    const done = runTour(screen.target, {
      name: 'manual', stage: async () => {}, run: async (_t, d) => { await d.sleep(500); },
    }, WAV, { clock: clockFromEngine(engine), record: env.record, log: env.sink, elementFromPoint: screen.elementFromPoint }).then(() => { finished = true; });
    await macrotask();                                                    // the tour reaches its first sleep at time 0
    for (let i = 0; i < 100 && !finished; i++) {
      engine.advance(16);
      await macrotask();
    }
    await done;
    // A frame-sized advance wakes a sleeper a little late, so the 120 ms flash and the 500 ms run take 620 to 700.
    expect(env.recorder[0]).toEqual({ at: 0, what: 'start' });
    expect(env.recorder[1].at).toBeGreaterThanOrEqual(620);
    expect(env.recorder[1].at).toBeLessThan(700);
  });

  it('without a recorder it uses the Tauri commands, loaded on demand, with the log going to js_log', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock });
    await clock.run(runTour(screen.target, { name: 't', stage: async () => {}, run: async () => {} }, WAV, {
      clock, elementFromPoint: screen.elementFromPoint,
    }));
    expect(invoke.mock.calls).toEqual([
      ['record_start'],
      ['js_log', { msg: 'demo: started' }],
      ['record_stop', { path: WAV }],
      ['js_log', { msg: `demo: wrote ${WAV}` }],
      ['js_log', { msg: 'demo: done' }],
    ]);
  });

  it('tauriBridge swallows a js_log that fails', async () => {
    invoke.mockRejectedValueOnce(new Error('no ipc'));
    const { log } = await tauriBridge();
    expect(() => log('x')).not.toThrow();
    await macrotask();
  });

  it('keeps Tauri out of the files: the driver reaches it only by a dynamic import, inside tauriBridge', () => {
    for (const file of ['driver.js', 'headspace.js', 'target.js']) {
      expect(source(file), file).not.toMatch(/^\s*import\b[^\n]*@tauri-apps/m);
    }
    expect(source('headspace.js')).not.toContain('@tauri-apps');
    expect(source('target.js')).not.toContain('@tauri-apps');
    expect(source('driver.js').match(/await import\('@tauri-apps\/api\/core'\)/g)).toHaveLength(1);
  });
});

// ---- the target --------------------------------------------------------------------------------------------------

describe('createDemoTarget', () => {
  /** @param {{ zoom?: number, rects?: Record<string, { x: number, y: number, w: number, h: number }> }} [o] */
  function build(o = {}) {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => /** @type {DOMRect} */ (RECT);
    // A Map, as the real inspector keeps its ids: `rects['__proto__']` would be Object.prototype.
    const rects = new Map(Object.entries(o.rects ?? { thing: { x: 10, y: 20, w: 40, h: 8 } }));
    /** @type {Array<[string, ...unknown[]]>} */
    const calls = [];
    /** @type {import('../../src/engine/contracts').SkinInspector} */
    const inspector = {
      find: () => null,
      rectOf: (ref) => rects.get(ref) ?? null,
      groupPoint: (g, c) => { calls.push(['groupPoint', g, c]); return g === 'gone' ? null : { x: 144, y: 13 }; },
      sliderThumbPoint: (r, v) => { calls.push(['sliderThumbPoint', r, v]); return r === 'gone' ? null : { x: 5, y: 6 + v }; },
      attr: (r, n) => { calls.push(['attr', r, n]); return 42; },
      setAttr: (r, n, v) => { calls.push(['setAttr', r, n, v]); },
      callGlobal: (n, a) => { calls.push(['callGlobal', n, a]); return 'called'; },
      readGlobal: (n) => { calls.push(['readGlobal', n]); return true; },
      stackingDump: () => [],
      root: () => root,
    };
    const media = createFakeMedia('stoppedEmpty');
    const effects = createEffectsControl();
    const target = createDemoTarget({ inspector, media, effects, zoom: () => o.zoom ?? ZOOM });
    return { target, root, calls, media, effects };
  }

  it('hands back the engine root, the live zoom, the media model and the effects control', () => {
    const { target, root, media, effects } = build();
    expect(target.root()).toBe(root);
    expect(target.zoom()).toBe(ZOOM);
    expect(target.media).toBe(media);
    expect(target.effects).toBe(effects);
  });

  it('turns view px into client px: the root\'s corner plus px times zoom', () => {
    const { target } = build();
    expect(target.clientPoint('thing')).toEqual({ x: 100 + (10 + 20) * ZOOM, y: 50 + (20 + 4) * ZOOM });
    expect(target.clientPoint('thing', 0, 0)).toEqual({ x: 100 + 10 * ZOOM, y: 50 + 20 * ZOOM });
    expect(target.clientPoint('thing', 1, 1)).toEqual({ x: 100 + 50 * ZOOM, y: 50 + 28 * ZOOM });
    expect(target.groupPoint('transport', '#FFFF00')).toEqual({ x: 100 + 144 * ZOOM, y: 50 + 13 * ZOOM });
    expect(target.sliderThumbPoint('eq1', 4)).toEqual({ x: 100 + 5 * ZOOM, y: 50 + 10 * ZOOM });
  });

  it('follows the zoom as it changes', () => {
    let z = 1;
    const { root, media, effects } = build();
    const inspector = /** @type {any} */ ({ rectOf: () => ({ x: 0, y: 0, w: 10, h: 10 }), root: () => root });
    const target = createDemoTarget({ inspector, media, effects, zoom: () => z });
    expect(target.clientPoint('a')).toEqual({ x: 105, y: 55 });
    z = 2;
    expect(target.clientPoint('a')).toEqual({ x: 110, y: 60 });
  });

  it.each([0, -1, NaN, Infinity])('treats a zoom of %s as 1', (z) => {
    const { target } = build({ zoom: z });
    expect(target.zoom()).toBe(1);
    expect(target.clientPoint('thing')).toEqual({ x: 100 + 30, y: 50 + 24 });
  });

  it('answers null for what the inspector cannot find', () => {
    const { target } = build();
    expect(target.clientPoint('nothing')).toBeNull();
    expect(target.groupPoint('gone', '#000000')).toBeNull();
    expect(target.sliderThumbPoint('gone', 1)).toBeNull();
  });

  it('refs named __proto__ and constructor are ordinary refs: unknown ones are null, known ones are found', () => {
    const { target } = build();
    expect(target.clientPoint('__proto__')).toBeNull();
    expect(target.clientPoint('constructor')).toBeNull();
    const named = build({ rects: JSON.parse('{ "__proto__": { "x": 0, "y": 0, "w": 10, "h": 10 }, "constructor": { "x": 10, "y": 10, "w": 10, "h": 10 } }') }).target;
    expect(named.clientPoint('__proto__')).toEqual({ x: 100 + 5 * ZOOM, y: 50 + 5 * ZOOM });
    expect(named.clientPoint('constructor')).toEqual({ x: 100 + 15 * ZOOM, y: 50 + 15 * ZOOM });
  });

  it('passes calls, reads and writes through to the inspector', () => {
    const { target, calls } = build();
    expect(target.call('ToggleEqView')).toBe('called');
    expect(target.call('Go', 1, 'two')).toBe('called');
    expect(target.get('eqIsOpen')).toBe(true);
    expect(target.attr('eq1', 'value')).toBe(42);
    target.setAttr('eq1', 'value', 7);
    expect(calls).toEqual([
      ['callGlobal', 'ToggleEqView', []],
      ['callGlobal', 'Go', [1, 'two']],
      ['readGlobal', 'eqIsOpen'],
      ['attr', 'eq1', 'value'],
      ['setAttr', 'eq1', 'value', 7],
    ]);
  });
});

// ---- the Headspace choreography ---------------------------------------------------------------------------------

describe('parseTour', () => {
  it('accepts the committed Headspace tour', () => {
    expect(parseTour(SIDECAR.tour)).toBe(SIDECAR.tour);
  });

  it('requires exactly the keys the sidecar schema requires for a tour', () => {
    const tour = /** @type {any} */ (SIDECAR_SCHEMA).$defs.tour;
    expect([...TOUR_KEYS].sort()).toEqual([...tour.required].sort());
    expect(Object.keys(tour.properties).sort()).toEqual([...TOUR_KEYS].sort());
  });

  /** @type {Array<[string, (t: any) => void, RegExp]>} */
  const bad = [
    ['a missing transport', (t) => { delete t.transport; }, /tour\.transport/],
    ['an empty reset', (t) => { t.reset = ''; }, /tour\.reset/],
    ['a numeric playColor', (t) => { t.playColor = 1; }, /tour\.playColor/],
    ['nine bands', (t) => { t.bands.pop(); }, /tour\.bands/],
    ['a band that is not a string', (t) => { t.bands[4] = null; }, /tour\.bands/],
    ['a rest point with a string', (t) => { t.rest.x = '4'; }, /tour\.rest/],
    ['no rest point', (t) => { delete t.rest; }, /tour\.rest/],
    ['a toggle with no vis', (t) => { delete t.toggle.vis; }, /tour\.toggle/],
    ['an isOpen that is a string', (t) => { t.isOpen = 'eqIsOpen'; }, /tour\.isOpen/],
  ];
  it.each(bad)('rejects %s', (_what, plant, message) => {
    const tour = structuredClone(SIDECAR.tour);
    plant(tour);
    expect(() => parseTour(tour)).toThrow(message);
    expect(() => createHeadspaceChoreography(tour)).toThrow(TypeError);
  });

  it.each([undefined, null, 3, 'tour', [], () => 0])('rejects a tour that is %j', (tour) => {
    expect(() => parseTour(tour)).toThrow(/no tour block/);
  });
});

describe('the Headspace choreography never carries a pixel of the old layout', () => {
  const text = source('headspace.js');
  /** A number that is not part of a longer one or of a decimal (28.7 s is a time, not a dB range). @param {number | string} n */
  const num = (n) => new RegExp(`(?<![\\w.])${n}(?![\\w.])`);

  // Whole file, comments included: a stray number in a comment is how a constant comes back.
  it.each([
    ['the travel of an equalizer slider', num(65)],
    ['the play fraction', /37\s*\/\s*144/],
    ['the visualization fraction', /131\s*\/\s*144/],
    ['the thumb offset', num('5\\.5')],
    ['the group centre line', /13\s*\/\s*25/],
    ['the group size', num(144)],
    ['the dB range of a band', new RegExp(`${num(14).source}|${num(28).source}`)],
    ['the resting spot', new RegExp(`${num(470).source}|${num(330).source}`)],
  ])('has no %s', (_what, pattern) => {
    expect(text).not.toMatch(pattern);
  });

  it('asks the screen: groupPoint for both colours, sliderThumbPoint for the bands, clientPoint for the rest', () => {
    expect(text).toContain('groupPoint(tour.transport, tour.playColor)');
    expect(text).toContain('groupPoint(tour.transport, tour.visColor)');
    expect(text).toContain('sliderThumbPoint(ref');
    expect(text).toContain('clientPoint(ref)');
  });

  it('names no element and no script of Headspace itself: every one comes from the tour', () => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const name of ['sEqView', 'bEqHandle', 'bPlHandle', 'eq1', 'Unnamed_', 'ToggleEqView', 'TogglePlView', 'ToggleVisView', 'eqIsOpen', 'plIsOpen', 'visIsOpen', 'visEffects']) {
      expect(code, name).not.toContain(name);
    }
  });
});

describe('the Headspace choreography on a fake screen', () => {
  /**
   * @param {{ media?: string, eq?: number[], open?: Record<string, boolean>, missing?: string[], effectsIndex?: number }} [o]
   * @returns {Promise<ReturnType<typeof fakeScreen> & { clock: ReturnType<typeof virtualClock>, env: ReturnType<typeof fakeEnv>, t0: number }>}
   */
  async function tour(o = {}) {
    const clock = virtualClock();
    const screen = fakeScreen({ clock, ...o });
    const env = fakeEnv(clock);
    await clock.run(runTour(screen.target, createHeadspaceChoreography(SIDECAR.tour), WAV, {
      clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink,
    }));
    return { ...screen, clock, env, t0: env.recorder[0].at };
  }

  /** @param {Awaited<ReturnType<typeof tour>>} run @param {string} type */
  const times = (run, type) => run.events.filter((e) => e.type === type).map((e) => [e.name, e.t - run.t0]);
  /** The time the last move of a glide of `ms` that starts at `start` happens. @param {number} start @param {number} ms */
  const lands = (start, ms) => start + Math.ceil(ms / 16) * 16;

  it('presses, in order: Play, the playlist handle, the equalizer handle, five bands, the chooser, five presets, reset', async () => {
    const run = await tour();
    const downs = run.events.filter((e) => e.type === 'pointerdown').map((e) => e.name);
    expect(downs).toEqual([
      'Unnamed_buttongroup_2/#FFFF00', 'bPlHandle', 'bEqHandle',
      'eq1@0', 'eq2@0', 'eq5@0', 'eq9@0', 'eq10@0',
      'Unnamed_buttongroup_2/#0000FF',
      ...Array(5).fill('Unnamed_button_4'),
      'Unnamed_text_4',
    ]);
  });

  it('keeps the legacy schedule: Play at 1.6 s, the preset clicks at 17.0 (after the glide), 20.9, 24.8, 28.7 and 32.6 s', async () => {
    const run = await tour();
    const downs = times(run, 'pointerdown');
    expect(downs[0]).toEqual(['Unnamed_buttongroup_2/#FFFF00', 1600]);
    expect(downs[1]).toEqual(['bPlHandle', lands(4500, 900)]);
    expect(downs[2]).toEqual(['bEqHandle', lands(7000, 1100)]);
    expect(downs[3]).toEqual(['eq1@0', lands(8600, 350)]);
    expect(downs[8]).toEqual(['Unnamed_buttongroup_2/#0000FF', lands(15000, 900)]);
    // The glide to the arrow starts at 16.4 s and takes 700 ms, so it is still moving at 17.0 s and the
    // first click waits for it (the legacy tour does the same); the other four are on the second.
    expect(downs.slice(9, 14)).toEqual([lands(16400, 700), 20900, 24800, 28700, 32600].map((t) => ['Unnamed_button_4', t]));
    expect(downs[14]).toEqual(['Unnamed_text_4', lands(35800, 1000)]);
    // each click is released 130 ms later
    const ups = times(run, 'pointerup');
    for (const i of [0, 1, 2, 8, 9, 10, 11, 12, 13, 14]) expect(ups[i][1]).toBe(/** @type {number} */ (downs[i][1]) + 130);
  });

  it('drags each band from where its thumb is to the target dB, with the button held', async () => {
    const run = await tour();
    const ups = run.events.filter((e) => e.type === 'pointerup').map((e) => e.name);
    expect(ups.slice(3, 8)).toEqual(['eq1@10', 'eq2@8', 'eq5@-5', 'eq9@6', 'eq10@9']);
    // between the press on eq1 and its release, every move holds the button
    const i = run.events.findIndex((e) => e.name === 'eq1@0' && e.type === 'pointerdown');
    const j = run.events.findIndex((e, k) => k > i && e.type === 'pointerup');
    const held = run.events.slice(i + 1, j);
    expect(held.length).toBeGreaterThan(20);
    expect(held.every((e) => e.type === 'pointermove' && e.buttons === 1)).toBe(true);
    // thumb asked for twice per drag (where it is, where it goes), by ref and dB, never by pixels
    const asked = run.calls.filter((c) => c[0] === 'sliderThumbPoint').map((c) => `${c[1]}:${c[2]}`);
    expect(asked).toEqual(['eq1:0', 'eq1:10', 'eq2:0', 'eq2:8', 'eq5:0', 'eq5:-5', 'eq9:0', 'eq9:6', 'eq10:0', 'eq10:9']);
  });

  it('aims Play and the chooser button at the pixels the two mapping colours own', async () => {
    const run = await tour();
    expect(run.calls.filter((c) => c[0] === 'groupPoint')).toEqual([
      ['groupPoint', 'Unnamed_buttongroup_2', '#FFFF00'],
      ['groupPoint', 'Unnamed_buttongroup_2', '#0000FF'],
    ]);
  });

  it('clicks the drawer handles, the chooser arrow and reset at the middle of their rects', async () => {
    const run = await tour();
    const asked = run.calls.filter((c) => c[0] === 'clientPoint');
    expect(asked.map((c) => c[1])).toEqual(['bPlHandle', 'bEqHandle', 'Unnamed_button_4', 'Unnamed_text_4']);
    for (const c of asked) expect([c[2], c[3]]).toEqual([undefined, undefined]);       // the target's default: the centre
  });

  it('sets the scene before the flash: drawers shut, equalizer flat, Chorus, queue paused at the start', async () => {
    const run = await tour({ open: { eqIsOpen: true, visIsOpen: true } });
    const stageEnd = run.t0;
    expect(run.t0).toBe(300 + 1500);                                                   // the play wait, then the settle
    const staged = run.calls.slice(0, run.calls.findIndex((c) => c[0] === 'sliderThumbPoint' || c[0] === 'groupPoint'));
    expect(staged.filter((c) => c[0] === 'call')).toEqual([['call', 'ToggleEqView'], ['call', 'ToggleVisView']]);
    expect(staged.filter((c) => c[0] === 'get').map((c) => c[1])).toEqual(['eqIsOpen', 'plIsOpen', 'visIsOpen']);
    expect(run.target.effects.title).toBe('Chorus');
    expect(run.target.media.snapshot().playState).not.toBe('stop');
    expect(/** @type {any} */ (run.target.media).calls.map((/** @type {any} */ c) => [c.method, ...c.args])).toEqual([['play'], ['pause'], ['seek', 0]]);
    expect(stageEnd).toBeGreaterThan(0);
  });

  it('writes every band to zero before the tour and puts the owner\'s equalizer back after it', async () => {
    const eq = [3, -2, 0, 5, 1, 0, 0, -4, 2, 7];
    const run = await tour({ eq });
    const writes = run.calls.filter((c) => c[0] === 'setAttr');
    expect(writes.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => ['setAttr', `eq${i + 1}`, 'value', 0]));
    expect(writes.slice(10)).toEqual(eq.map((v, i) => ['setAttr', `eq${i + 1}`, 'value', v]));
    expect(writes).toHaveLength(20);
    expect([...run.values.values()]).toEqual(eq);
  });

  it('reads the saved equalizer from the band sliders\' values, before touching anything', async () => {
    const run = await tour();
    const first = run.calls.slice(0, 10);
    expect(first).toEqual(Array.from({ length: 10 }, (_, i) => ['attr', `eq${i + 1}`, 'value']));
  });

  it('does not start a playing queue again', async () => {
    const run = await tour({ media: 'playing' });
    expect(/** @type {any} */ (run.target.media).calls.map((/** @type {any} */ c) => c.method)).toEqual(['pause', 'seek']);
    expect(run.t0).toBe(1500);
  });

  it.each([[0, 1], [1, 0], [3, 3], [4, 2]])('steps the visualization round to Chorus from preset %i (%i steps)', async (from, steps) => {
    const run = await tour({ effectsIndex: from });
    expect(run.target.effects.title).toBe('Chorus');
    expect(steps).toBeLessThan(5);
  });

  it('moves to the resting spot, in view px through the zoom, before the flash and again at the end', async () => {
    const run = await tour();
    const spot = { x: RECT.left + SIDECAR.tour.rest.x * ZOOM, y: RECT.top + SIDECAR.tour.rest.y * ZOOM };
    expect(run.events[0]).toMatchObject({ type: 'pointerenter', x: spot.x, y: spot.y });
    expect(run.events[1]).toMatchObject({ type: 'pointermove', x: spot.x, y: spot.y, t: 300 });
    expect(run.events.at(-1)).toMatchObject({ type: 'pointermove', x: spot.x, y: spot.y });
  });

  it('stops the recorder at 39.5 s with the soundtrack path, and logs the tour', async () => {
    const run = await tour();
    expect(run.env.recorder).toEqual([{ at: run.t0, what: 'start' }, { at: run.t0 + 39500, what: 'stop', path: WAV }]);
    expect(run.env.log).toEqual(['demo: started', 'demo: play at 1.730s', `demo: wrote ${WAV}`, 'demo: done']);
  });

  it('leaves nothing of itself on the page', async () => {
    const run = await tour();
    expect([...run.root.children]).toEqual([run.plane]);
    expect(document.body.classList.contains('demo')).toBe(false);
  });

  it('uses only what a DemoTarget has', async () => {
    const clock = virtualClock();
    const screen = fakeScreen({ clock, open: { eqIsOpen: true } });
    const env = fakeEnv(clock);
    /** @type {Set<string | symbol>} */
    const used = new Set();
    const spy = new Proxy(screen.target, { get: (t, k, r) => { used.add(k); return Reflect.get(t, k, r); } });
    await clock.run(runTour(spy, createHeadspaceChoreography(SIDECAR.tour), WAV, {
      clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink,
    }));
    const allowed = ['root', 'zoom', 'clientPoint', 'groupPoint', 'sliderThumbPoint', 'call', 'get', 'attr', 'setAttr', 'media', 'effects'];
    expect([...used].filter((k) => !allowed.includes(/** @type {string} */ (k)))).toEqual([]);
    // the tour needs the screen, the script and the transport; none of those is skipped
    for (const k of ['clientPoint', 'groupPoint', 'sliderThumbPoint', 'call', 'get', 'attr', 'setAttr', 'media', 'effects']) expect(used.has(k), k).toBe(true);
  });

  describe('when the skin is not what the sidecar says', () => {
    it.each([
      ['bPlHandle', /bPlHandle is not on screen/],
      ['Unnamed_buttongroup_2', /the play control is not on screen/],
      ['Unnamed_button_4', /Unnamed_button_4 is not on screen/],
    ])('a missing %s ends the tour with a message, and cleans up', async (gone, message) => {
      const clock = virtualClock();
      const screen = fakeScreen({ clock, missing: [gone] });
      const env = fakeEnv(clock);
      await expect(clock.run(runTour(screen.target, createHeadspaceChoreography(SIDECAR.tour), WAV, {
        clock, elementFromPoint: screen.elementFromPoint, record: env.record, log: env.sink,
      }))).rejects.toThrow(message);
      expect(env.recorder.map((r) => r.what)).toEqual(['start', 'stop']);
      expect([...screen.root.children]).toEqual([screen.plane]);
      expect(document.body.classList.contains('demo')).toBe(false);
      expect([...screen.values.values()]).toEqual([3, -2, 0, 5, 1, 0, 0, -4, 2, 7]);       // the owner's equalizer is back
      expect(env.log.at(-1)).toBe('demo: aborted');
    });
  });
});
