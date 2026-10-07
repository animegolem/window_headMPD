// @ts-check
// The animator (W3.3; E §5.11 `createAnimator`; E D2 "Animation"; parity 3.7). Models are built
// through `buildTheme` from synthetic raw trees, so a tween writes through the real attribute
// tables, `coerce`, the dirty set and the `_onchange` queue. Time moves only on the manual clock:
// `step(ms)` advances it and then hands the animator the clock's `now()`, which is what the view
// runtime's frame callback does. The 60 ms and 120 ms points of the card are not on the clock's
// 16 ms frame grid, so most tests call `frame` directly at those instants; one test wires the
// animator to `onFrame` to cover the grid itself.
//
// Rounding rule, pinned here: an interpolated value is `Math.round`ed, so a half goes up. The card's
// 207 px drawer move is at 103.5 px at 60 ms and is written as 104.
//
// The animator keeps its tweens in Maps keyed by `ElementModel` objects, never by a skin string, so
// the `__proto__` / `constructor` key rule (global rule 5) has no lookup to test; one case with
// elements of those ids is included anyway.
import { describe, expect, it } from 'vitest';
import { createAnimator } from '../../../src/engine/anim/animator.js';
import { buildTheme } from '../../../src/engine/wms/build.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';

/** @typedef {import('../../../src/engine/contracts').RawNode} RawNode */
/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */

/** @param {Record<string, string | number>} o */
const attrsOf = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** @param {string} tag @param {Record<string, string | number>} [attrs] @param {RawNode[]} [children] @returns {RawNode} */
const N = (tag, attrs = {}, children = []) => ({ tag, attrs: attrsOf(attrs), children, line: 1 });

const vfs = () => ({
  sha: '0'.repeat(64), name: 'test.wmz', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null,
});

/**
 * One view of the given children, a manual clock and an animator whose `fire` writes to the shared
 * `log` beside every model write, so a test can read the order the two happened in.
 * @param {RawNode[]} kids
 * @param {{ fire?: (el: ElementModel, event: string) => void }} [opts]
 */
function rig(kids, opts = {}) {
  const theme = buildTheme(N('theme', {}, [N('view', { id: 'v', width: 800, height: 400 }, kids)]), vfs(), { probe: () => null });
  const view = theme.views[0];
  const clock = createManualClock();
  /** @type {Array<{ kind: 'write', id: string, attr: string, value: unknown, origin: string } | { kind: 'fire', id: string, event: string, at: number }>} */
  const log = [];
  view.onChange((el, attr, value, origin) => { log.push({ kind: 'write', id: el.id, attr, value, origin }); });
  const anim = createAnimator(clock, (el, event) => {
    log.push({ kind: 'fire', id: el.id, event, at: clock.now() });
    opts.fire?.(el, event);
  });
  /** @param {string} id */
  const el = (id) => {
    const found = view.byId(id);
    if (!found) throw new Error(`no element ${id}`);
    return found;
  };
  /** Advance the clock by `ms` and run the frame the runtime would run at that instant. @param {number} ms */
  const step = (ms) => {
    clock.advance(ms);
    anim.frame(clock.now());
  };
  const fires = () => log.filter((e) => e.kind === 'fire');
  const writes = () => log.filter((e) => e.kind === 'write');
  return { view, clock, anim, log, el, step, fires, writes };
}

/** Headspace's EQ ear: a SUBVIEW drawer at x 207 that slides to 0 in 120 ms (`sEqEar.moveto(eqOpenedPos, top, speed)`). */
const ear = () => N('subview', { id: 'sEqEar', left: 207, top: 5, width: 40, height: 60 });

describe('moveTo: linear', () => {
  it('moves 207 to 0 in 120 ms: 104 at 60 ms (103.5 rounds up), 0 by 120 ms', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.anim.moveTo(e, 0, 5, 120, 'linear');
    expect(e.get('left')).toBe(207);                       // the call itself writes nothing
    r.step(0);
    expect(e.get('left')).toBe(207);                       // the frame at the start instant is still at the start
    r.step(60);
    expect([103, 104]).toContain(e.get('left'));          // the card's bound ...
    expect(e.get('left')).toBe(104);                       // ... and the rule: halves go up
    expect(e.get('top')).toBe(5);                          // an unchanged axis stays where it is
    r.step(59);
    expect(e.get('left')).toBe(2);                         // 207 - 207 * 119 / 120 = 1.725
    expect(r.anim.running()).toBe(1);
    r.step(1);
    expect(e.get('left')).toBe(0);
    expect(r.anim.running()).toBe(0);
  });

  it('writes every value as an integer and only through origin "anim"', () => {
    const r = rig([ear()]);
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    for (let t = 0; t < 130; t += 7) r.step(7);
    const ws = r.writes();
    expect(ws.length).toBeGreaterThan(3);
    for (const w of ws) {
      expect(w.origin).toBe('anim');
      expect(Number.isInteger(w.value)).toBe(true);
    }
    // Strictly one attribute moved, monotonically toward the target.
    const lefts = ws.filter((w) => w.attr === 'left').map((w) => /** @type {number} */ (w.value));
    expect(ws.every((w) => w.attr === 'left')).toBe(true);
    expect(lefts).toEqual([...lefts].sort((a, b) => b - a));
    expect(lefts.at(-1)).toBe(0);
  });

  it('never writes -0 (the model would count it as a change from 0)', () => {
    const r = rig([N('subview', { id: 's', left: 1, top: 0 })]);
    r.anim.moveTo(r.el('s'), 0, 0, 100, 'linear');
    r.step(60);                                             // 1 - 0.6 = 0.4 -> 0
    r.step(40);
    const ws = r.writes();
    for (const w of ws) expect(Object.is(w.value, -0)).toBe(false);
    expect(r.el('s').get('left')).toBe(0);
  });

  it('writes the exact target on the final frame, however late it comes', () => {
    const r = rig([ear()]);
    r.anim.moveTo(r.el('sEqEar'), 33, 9, 120, 'linear');
    r.step(100000);
    expect([r.el('sEqEar').get('left'), r.el('sEqEar').get('top')]).toEqual([33, 9]);
    expect(r.fires()).toHaveLength(1);
  });

  it('runs on the engine clock: wired to onFrame it finishes on the first frame at or after 120 ms', () => {
    const r = rig([ear()]);
    r.clock.onFrame((now) => r.anim.frame(now));
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.clock.advance(112);                                   // frames at 16 .. 112
    expect(r.fires()).toHaveLength(0);
    expect(r.el('sEqEar').get('left')).toBe(14);            // 207 - 207 * 112 / 120 = 13.8
    r.clock.advance(200);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'sEqEar', event: 'onendmove', at: 128 }]);
    expect(r.el('sEqEar').get('left')).toBe(0);
    expect(r.writes().filter((w) => w.attr === 'left')).toHaveLength(8);   // frames 16 .. 128, each a new value
  });

  it('measures from the moment of the call, not from the next frame', () => {
    const r = rig([ear()]);
    r.clock.advance(50);                                    // a script entry in the middle of a frame interval
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 100, 'linear');
    r.step(50);
    expect(r.el('sEqEar').get('left')).toBe(104);           // halfway after 50 ms of a 100 ms move
    r.step(50);
    expect(r.el('sEqEar').get('left')).toBe(0);
  });
});

describe('onendmove', () => {
  it('fires exactly once, after the final write, and never again', () => {
    const r = rig([ear()]);
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.step(119);
    expect(r.fires()).toHaveLength(0);
    r.step(1);
    const kinds = r.log.map((e) => e.kind);
    expect(kinds.at(-1)).toBe('fire');
    expect(kinds.filter((k) => k === 'fire')).toHaveLength(1);
    const last = r.writes().at(-1);
    expect(last).toMatchObject({ attr: 'left', value: 0 });
    expect(r.fires()[0]).toEqual({ kind: 'fire', id: 'sEqEar', event: 'onendmove', at: 120 });
    const before = r.log.length;
    for (let i = 0; i < 20; i++) r.step(16);
    expect(r.log).toHaveLength(before);                    // no more writes, no more events
    expect(r.anim.running()).toBe(0);
  });

  it('the callback sees the finished state: the model is at the target and nothing is running', () => {
    /** @type {{ left: unknown, running: number } | null} */
    let seen = null;
    const r = rig([ear()], {
      fire: (el) => { seen = { left: el.get('left'), running: r.anim.running() }; },
    });
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.step(120);
    expect(seen).toEqual({ left: 0, running: 0 });
  });

  it('still fires for a move to where the element already is (Headspace replays its drawer toggles)', () => {
    const r = rig([ear()]);
    r.view.takeDirty();
    r.anim.moveTo(r.el('sEqEar'), 207, 5, 120, 'linear');
    r.step(60);
    expect(r.fires()).toHaveLength(0);
    r.step(60);
    expect(r.fires()).toHaveLength(1);
    expect(r.writes()).toHaveLength(0);                    // nothing changed, so nothing was written
    expect(r.view.takeDirty().size).toBe(0);
  });

  it('fires for a move the model refuses (an attribute the kind does not have)', () => {
    const r = rig([N('playlist', { id: 'pl' })]);
    r.anim.alphaBlendTo(r.el('pl'), 0, 50);                // PLAYLIST has no alphaBlend (spec 2.8)
    r.step(50);
    expect(r.writes()).toHaveLength(0);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'pl', event: 'onendalphablend', at: 50 }]);
  });

  it('a zero-length (or negative) move writes and fires on the next frame, never inside the call', () => {
    const r = rig([ear()]);
    r.anim.moveTo(r.el('sEqEar'), 10, 20, 0, 'linear');
    expect(r.el('sEqEar').get('left')).toBe(207);
    expect(r.fires()).toHaveLength(0);
    expect(r.anim.running()).toBe(1);
    r.step(16);
    expect([r.el('sEqEar').get('left'), r.el('sEqEar').get('top')]).toEqual([10, 20]);
    expect(r.fires()).toHaveLength(1);
    expect(r.anim.running()).toBe(0);

    r.anim.moveTo(r.el('sEqEar'), 1, 2, -40, 'linear');
    r.step(16);
    expect(r.el('sEqEar').get('left')).toBe(1);
    expect(r.fires()).toHaveLength(2);
  });

  it('tween writes take the model\'s normal change path: dirty marks and a queued left_onchange', () => {
    const r = rig([N('subview', { id: 's', left: 100, top: 0, left_onchange: 'Moved();' })]);
    r.view.takeDirty();
    r.view.takeQueuedEvents();
    r.anim.moveTo(r.el('s'), 0, 0, 100, 'linear');
    r.step(50);
    expect([...(r.view.takeDirty().get(r.el('s')) ?? [])]).toEqual(['left']);
    expect(r.view.takeQueuedEvents()).toEqual([{ el: r.el('s'), event: 'left_onchange' }]);
  });

  it('a frame where the rounded value did not change marks nothing dirty', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0 })]);
    r.view.takeDirty();
    r.anim.moveTo(r.el('s'), 1, 0, 1000, 'linear');         // 0.4 px of travel at t=400: still 0
    r.step(400);
    expect(r.view.takeDirty().size).toBe(0);
    r.step(100);                                            // 0.5 rounds up
    expect(r.el('s').get('left')).toBe(1);
    expect(r.view.takeDirty().size).toBe(1);
  });
});

describe('retargeting', () => {
  it('a new move cancels the old one without firing; the replacement fires at its own end', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.anim.moveTo(e, 0, 5, 120, 'linear');
    r.step(30);
    r.anim.moveTo(e, 100, 5, 60, 'linear');                 // starts from where the ear is now (155)
    expect(r.anim.running()).toBe(1);
    r.step(30);                                              // t=60: the replacement is halfway from 155 to 100
    expect(e.get('left')).toBe(128);                          // 155.25 -> 155; 155 + (100 - 155) / 2 = 127.5 -> 128
    r.step(30);                                              // t=90: the replacement is done
    expect(e.get('left')).toBe(100);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'sEqEar', event: 'onendmove', at: 90 }]);
    r.step(200);                                             // the old tween's end time (120) passed in silence
    expect(r.fires()).toHaveLength(1);
  });

  it('a reversed move continues from where the element is and fires once, at the reversed end', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.anim.moveTo(e, 0, 5, 120, 'linear');
    r.step(60);
    expect(e.get('left')).toBe(104);
    r.anim.moveTo(e, 207, 5, 120, 'linear');                // close the drawer again, mid-flight
    r.step(60);                                              // t=120: the first move's end time passes silently
    expect(e.get('left')).toBe(156);                          // 104 + (207 - 104) / 2 = 155.5 -> 156
    expect(r.fires()).toHaveLength(0);
    r.step(60);                                              // t=180
    expect(e.get('left')).toBe(207);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'sEqEar', event: 'onendmove', at: 180 }]);
    r.step(500);
    expect(r.fires()).toHaveLength(1);
  });

  it('two calls in the same tick fire once', () => {
    const r = rig([ear()]);
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.anim.moveTo(r.el('sEqEar'), 207, 5, 120, 'linear');
    expect(r.anim.running()).toBe(1);
    r.step(120);
    expect(r.fires()).toHaveLength(1);
    expect(r.el('sEqEar').get('left')).toBe(207);
  });

  it('a retarget from a linear move to a slide, and back, takes the new curve', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 1600, 0, 400, 'linear');
    r.step(200);
    expect(s.get('left')).toBe(800);
    r.anim.moveTo(s, 0, 0, 400, 'inout');                   // a quarter of the way along the new curve is 6.25 %
    r.step(100);
    expect(s.get('left')).toBe(750);                          // 800 - 800 * 0.0625
    r.step(300);
    expect(s.get('left')).toBe(0);
    expect(r.fires()).toHaveLength(1);
  });

  it('a script write cancels like cancel(el): the model keeps the script\'s value and nothing fires', () => {
    // The object model calls `cancel(el)` before a script's write of a tweened attribute.
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.anim.moveTo(e, 0, 5, 120, 'linear');
    r.step(60);
    r.anim.cancel(e);
    e.set('left', 150, 'script');
    r.step(500);
    expect(e.get('left')).toBe(150);
    expect(r.fires()).toHaveLength(0);
    expect(r.anim.running()).toBe(0);
  });
});

describe('slideTo: cubic ease-in-out', () => {
  it('follows 4p^3 up to the middle and its mirror after, at 25 / 50 / 75 %', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 1600, 0, 400, 'inout');
    r.step(100);
    expect(s.get('left')).toBe(100);                        // 1600 * 0.0625
    r.step(100);
    expect(s.get('left')).toBe(800);                        // 1600 * 0.5
    r.step(100);
    expect(s.get('left')).toBe(1500);                       // 1600 * 0.9375
    r.step(100);
    expect(s.get('left')).toBe(1600);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 's', event: 'onendmove', at: 400 }]);
  });

  it('starts slow and ends slow, never overshoots, and never moves backwards', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 1600, 0, 400, 'inout');
    /** @type {number[]} */
    const seen = [];
    for (let t = 0; t < 400; t++) {
      r.step(1);
      seen.push(/** @type {number} */ (s.get('left')));
    }
    expect(seen[0]).toBe(0);                                // 1 ms in: 4 * (1/400)^3 * 1600 is far below half a pixel
    expect(seen[398] - seen[397]).toBeLessThanOrEqual(1);   // the last ms barely moves
    expect(Math.max(...seen)).toBeLessThanOrEqual(1600);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // The middle is the fastest part: steeper than a linear move (4 px/ms) would be.
    expect(seen[200] - seen[199]).toBeGreaterThan(4);
  });
});

describe('moveSizeTo (a move that also tweens width and height)', () => {
  it('moves and resizes together, linear, and fires onendmove once', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, width: 100, height: 50 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 40, 20, 100, 'linear', 200, 150);
    r.step(50);
    expect([s.get('left'), s.get('top'), s.get('width'), s.get('height')]).toEqual([20, 10, 150, 100]);
    r.step(50);
    expect([s.get('left'), s.get('top'), s.get('width'), s.get('height')]).toEqual([40, 20, 200, 150]);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 's', event: 'onendmove', at: 100 }]);
  });

  it('with the slide flag it uses the cubic curve on every axis', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, width: 100, height: 50 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 160, 0, 100, 'inout', 260, 210);
    r.step(25);
    expect([s.get('left'), s.get('width'), s.get('height')]).toEqual([10, 110, 60]);   // 6.25 % of 160, 160, 160
    r.step(25);
    expect([s.get('left'), s.get('width'), s.get('height')]).toEqual([80, 180, 130]);
    r.step(50);
    expect([s.get('left'), s.get('width'), s.get('height')]).toEqual([160, 260, 210]);
  });

  it('a plain moveTo does not touch width and height, even after a moveSizeTo was replaced mid-flight', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, width: 100, height: 50 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 40, 20, 100, 'linear', 200, 150);
    r.step(50);
    r.anim.moveTo(s, 0, 0, 100, 'linear');
    r.step(100);
    expect([s.get('left'), s.get('top'), s.get('width'), s.get('height')]).toEqual([0, 0, 150, 100]);
    expect(r.fires()).toHaveLength(1);
  });

  it('width alone and height alone each tween only their own axis', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, width: 100, height: 50 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 0, 0, 100, 'linear', 200, undefined);
    r.step(100);
    expect([s.get('width'), s.get('height')]).toEqual([200, 50]);
    r.anim.moveTo(s, 0, 0, 100, 'linear', undefined, 10);
    r.step(100);
    expect([s.get('width'), s.get('height')]).toEqual([200, 10]);
  });
});

describe('alphaBlendTo', () => {
  it('is linear in alpha and fires onendalphablend (not onendmove) once at the end', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, alphaBlend: 200 })]);
    const s = r.el('s');
    r.anim.alphaBlendTo(s, 0, 100);
    r.step(25);
    expect(s.get('alphaBlend')).toBe(150);
    r.step(25);
    expect(s.get('alphaBlend')).toBe(100);
    r.step(25);
    expect(s.get('alphaBlend')).toBe(50);
    expect(r.fires()).toHaveLength(0);
    r.step(25);
    expect(s.get('alphaBlend')).toBe(0);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 's', event: 'onendalphablend', at: 100 }]);
    expect(r.writes().every((w) => w.attr === 'alphablend' && w.origin === 'anim')).toBe(true);
  });

  it('starts from the default 255 and fades up as well as down', () => {
    const r = rig([N('subview', { id: 's' })]);
    const s = r.el('s');
    r.anim.alphaBlendTo(s, 55, 100);
    r.step(50);
    expect(s.get('alphaBlend')).toBe(155);
    r.step(50);
    r.anim.alphaBlendTo(s, 255, 100);
    r.step(50);
    expect(s.get('alphaBlend')).toBe(155);
    r.step(50);
    expect(s.get('alphaBlend')).toBe(255);
    expect(r.fires().map((f) => f.event)).toEqual(['onendalphablend', 'onendalphablend']);
  });

  it('clamps the target to 0..255', () => {
    const r = rig([N('subview', { id: 's', alphaBlend: 100 })]);
    const s = r.el('s');
    r.anim.alphaBlendTo(s, 900, 10);
    r.step(10);
    expect(s.get('alphaBlend')).toBe(255);
    r.anim.alphaBlendTo(s, -50, 10);
    r.step(10);
    expect(s.get('alphaBlend')).toBe(0);
  });

  it('a retarget cancels without firing, and the replacement fires at its end', () => {
    const r = rig([N('subview', { id: 's', alphaBlend: 255 })]);
    const s = r.el('s');
    r.anim.alphaBlendTo(s, 0, 100);
    r.step(50);
    expect(s.get('alphaBlend')).toBe(128);                   // 127.5 rounds up
    r.anim.alphaBlendTo(s, 255, 100);                         // fade back in from 128
    r.step(100);
    expect(s.get('alphaBlend')).toBe(255);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 's', event: 'onendalphablend', at: 150 }]);
  });
});

describe('two channels, many elements', () => {
  it('a move and a blend on one element run side by side; each replaces only its own channel', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, alphaBlend: 255 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 100, 0, 100, 'linear');
    r.anim.alphaBlendTo(s, 0, 200);
    expect(r.anim.running()).toBe(2);
    r.step(50);
    r.anim.moveTo(s, 0, 0, 100, 'linear');                  // replaces the move, leaves the fade alone
    expect(r.anim.running()).toBe(2);
    r.step(100);                                             // t=150: the new move is done, the fade is at 75 %
    expect([s.get('left'), s.get('alphaBlend')]).toEqual([0, 64]);   // 255 * (1 - 150 / 200) = 63.75
    expect(r.fires().map((f) => f.event)).toEqual(['onendmove']);
    r.step(50);
    expect(s.get('alphaBlend')).toBe(0);
    expect(r.fires().map((f) => f.event)).toEqual(['onendmove', 'onendalphablend']);
    expect(r.anim.running()).toBe(0);
  });

  it('cancel(el) stops both channels silently and leaves the element where it is', () => {
    const r = rig([N('subview', { id: 's', left: 0, top: 0, alphaBlend: 255 })]);
    const s = r.el('s');
    r.anim.moveTo(s, 100, 0, 100, 'linear');
    r.anim.alphaBlendTo(s, 0, 100);
    r.step(50);
    r.anim.cancel(s);
    expect(r.anim.running()).toBe(0);
    const frozen = [s.get('left'), s.get('alphaBlend')];
    expect(frozen).toEqual([50, 128]);
    const writesBefore = r.writes().length;
    r.step(500);
    expect([s.get('left'), s.get('alphaBlend')]).toEqual(frozen);
    expect(r.writes()).toHaveLength(writesBefore);
    expect(r.fires()).toHaveLength(0);
  });

  it('cancel on an element with no tween is a no-op, and the element can animate afterwards', () => {
    const r = rig([N('subview', { id: 'a', left: 0 }), N('subview', { id: 'b', left: 0 })]);
    r.anim.cancel(r.el('a'));
    r.anim.moveTo(r.el('b'), 10, 0, 10, 'linear');
    r.anim.cancel(r.el('a'));                                // another element's cancel leaves b alone
    expect(r.anim.running()).toBe(1);
    r.anim.cancel(r.el('b'));
    r.anim.moveTo(r.el('b'), 20, 0, 10, 'linear');
    r.step(10);
    expect(r.el('b').get('left')).toBe(20);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'b', event: 'onendmove', at: 10 }]);
  });

  it('every write of a frame lands before the first end event, and events follow start order', () => {
    const r = rig([N('subview', { id: 'a', left: 0 }), N('subview', { id: 'b', left: 0 }), N('subview', { id: 'c', left: 0 })]);
    r.anim.moveTo(r.el('a'), 10, 0, 100, 'linear');
    r.anim.moveTo(r.el('b'), 10, 0, 50, 'linear');          // ends first
    r.anim.alphaBlendTo(r.el('c'), 0, 100);                 // ends with a
    r.step(50);
    expect(r.fires().map((f) => f.id)).toEqual(['b']);
    r.log.length = 0;
    r.step(50);
    expect(r.log.map((e) => (e.kind === 'write' ? `w:${e.id}.${e.attr}` : `f:${e.id}.${e.event}`))).toEqual([
      'w:a.left', 'w:c.alphablend', 'f:a.onendmove', 'f:c.onendalphablend',
    ]);
  });

  it('elements with the ids __proto__ and constructor animate like any other', () => {
    const r = rig([N('subview', { id: '__proto__', left: 0 }), N('subview', { id: 'constructor', left: 0 })]);
    r.anim.moveTo(r.el('__proto__'), 10, 0, 10, 'linear');
    r.anim.moveTo(r.el('constructor'), 20, 0, 10, 'linear');
    r.step(10);
    expect([r.el('__proto__').get('left'), r.el('constructor').get('left')]).toEqual([10, 20]);
    expect(r.fires().map((f) => f.id)).toEqual(['__proto__', 'constructor']);
  });

  it('running() counts tweens in flight', () => {
    const r = rig([N('subview', { id: 'a', left: 0, alphaBlend: 255 }), N('subview', { id: 'b', left: 0 })]);
    expect(r.anim.running()).toBe(0);
    r.anim.moveTo(r.el('a'), 10, 0, 100, 'linear');
    r.anim.alphaBlendTo(r.el('a'), 0, 50);
    r.anim.moveTo(r.el('b'), 10, 0, 100, 'linear');
    expect(r.anim.running()).toBe(3);
    r.step(50);
    expect(r.anim.running()).toBe(2);
    r.step(50);
    expect(r.anim.running()).toBe(0);
  });
});

describe('the frame boundary', () => {
  it('ignores a non-finite time, and a time before the start leaves the element where it is', () => {
    const r = rig([ear()]);
    r.clock.advance(100);
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.anim.frame(NaN);
    r.anim.frame(Infinity);
    r.anim.frame(50);                                       // the frame timestamp is behind the call
    expect(r.el('sEqEar').get('left')).toBe(207);
    expect(r.anim.running()).toBe(1);
    r.step(120);
    expect(r.el('sEqEar').get('left')).toBe(0);
    expect(r.fires()).toHaveLength(1);
  });

  it('a frame with nothing running does nothing', () => {
    const r = rig([ear()]);
    r.step(16);
    expect(r.log).toHaveLength(0);
  });

  it('drops a call with a non-finite number, and leaves a running tween alone', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.anim.moveTo(e, NaN, 5, 100, 'linear');
    r.anim.moveTo(e, 0, Infinity, 100, 'linear');
    r.anim.moveTo(e, 0, 5, Infinity, 'linear');
    r.anim.moveTo(e, 0, 5, NaN, 'linear');
    r.anim.moveTo(e, 0, 5, 100, 'linear', NaN, 10);
    r.anim.moveTo(e, 0, 5, 100, 'linear', 10, Infinity);
    r.anim.alphaBlendTo(e, NaN, 100);
    r.anim.alphaBlendTo(e, 10, Infinity);
    expect(r.anim.running()).toBe(0);

    r.anim.moveTo(e, 0, 5, 100, 'linear');
    r.anim.moveTo(e, NaN, 5, 100, 'linear');                // must not replace the good one
    expect(r.anim.running()).toBe(1);
    r.step(100);
    expect(e.get('left')).toBe(0);
    expect(r.fires()).toHaveLength(1);
  });

  it('a callback that starts the next move gets a clean slate, and the new move runs and fires', () => {
    let first = true;
    const r = rig([ear()], {
      fire: (el) => {
        if (!first) return;
        first = false;
        r.anim.moveTo(el, 207, 5, 40, 'linear');
        expect(r.anim.running()).toBe(1);
      },
    });
    r.anim.moveTo(r.el('sEqEar'), 0, 5, 120, 'linear');
    r.step(120);
    expect(r.anim.running()).toBe(1);                        // the follow-up, started inside the callback
    expect(r.el('sEqEar').get('left')).toBe(0);              // and not stepped in the frame that started it
    r.step(20);
    expect(r.el('sEqEar').get('left')).toBe(104);
    r.step(20);
    expect(r.el('sEqEar').get('left')).toBe(207);
    expect(r.fires().map((f) => f.at)).toEqual([120, 160]);
    expect(r.anim.running()).toBe(0);
  });

  it('a throwing callback does not swallow the other events of the frame; the first error is rethrown', () => {
    let calls = 0;
    const r = rig([N('subview', { id: 'a', left: 0 }), N('subview', { id: 'b', left: 0 }), N('subview', { id: 'c', left: 0 })], {
      fire: (el) => {
        calls++;
        if (el.id === 'a') throw new Error('boom a');
        if (el.id === 'b') throw new Error('boom b');
      },
    });
    for (const id of ['a', 'b', 'c']) r.anim.moveTo(r.el(id), 10, 0, 50, 'linear');
    r.clock.advance(50);
    expect(() => r.anim.frame(r.clock.now())).toThrow('boom a');
    expect(calls).toBe(3);
    expect(r.anim.running()).toBe(0);
    expect(r.writes()).toHaveLength(3);                      // every final write happened first
    r.step(100);
    expect(calls).toBe(3);
  });

  it('a model listener that cancels the tween on its final write suppresses the event and the rest of its writes', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    r.view.onChange((el, attr, v) => { if (attr === 'left' && v === 0) r.anim.cancel(el); });
    r.anim.moveTo(e, 0, 9, 100, 'linear');
    r.step(100);
    expect(e.get('left')).toBe(0);
    expect(e.get('top')).toBe(5);                            // the tween was cancelled between its two writes
    expect(r.fires()).toHaveLength(0);
    expect(r.anim.running()).toBe(0);
  });

  it('a model listener that retargets mid-frame leaves only the replacement to fire', () => {
    const r = rig([ear()]);
    const e = r.el('sEqEar');
    let again = true;
    r.view.onChange((el, attr, v) => {
      if (again && attr === 'left' && v === 0) { again = false; r.anim.moveTo(el, 207, 5, 100, 'linear'); }
    });
    r.anim.moveTo(e, 0, 5, 100, 'linear');
    r.step(100);
    expect(r.fires()).toHaveLength(0);
    expect(r.anim.running()).toBe(1);
    r.step(100);
    expect(e.get('left')).toBe(207);
    expect(r.fires()).toEqual([{ kind: 'fire', id: 'sEqEar', event: 'onendmove', at: 200 }]);
  });
});
