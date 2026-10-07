// @ts-check
// Headspace through the `jscript:` pass (WAVES W3.1 acceptance 2; `parity 0.4`, `survey R0`;
// ENGINE D5). Needs the owner's `~/Downloads/Headspace.wmz`; skips with the reason in its title
// without it. Nothing derived from the art is written anywhere: the test reads numbers the research
// notes recorded and compares them with what the pass computes.
//
// The pass runs through the real builder, object graph and realm (tests/engine/layout/harness.js),
// with `headspace.js` loaded first, as the view runtime orders it (E §3.1 steps 4 and 5).

import { afterAll, beforeAll, expect, it } from 'vitest';
import { marginsOf, recordAnchors, relayout } from '../../src/engine/layout/align.js';
import { runLayoutPass } from '../../src/engine/layout/expr.js';
import { openSession } from '../engine/layout/harness.js';
import { describeHeadspace } from '../support/fixtures.js';

/** @typedef {import('../../src/engine/contracts').ElementModel} ElementModel */

/** @type {Awaited<ReturnType<typeof openSession>>} */
let session;
/** @type {ReturnType<typeof runLayoutPass>} */
let stats;

/** @param {string} id @returns {ElementModel} */
const byId = (id) => /** @type {ElementModel} */ (session.view.byId(id));
/** @param {ElementModel} el */
const place = (el) => [el.get('left'), el.get('top')];

/** The EQ panel's children are `balance, label, volume, label, eq(settings), eq1..eq10, reset`. */
const panelChildren = () => /** @type {ElementModel} */ (byId('balance').parent).children;

describeHeadspace('Headspace layout (W3.1)', (headspace) => {
  beforeAll(async () => {
    session = await openSession(headspace.bytes(), { name: 'Headspace.wmz', track: false });
    stats = runLayoutPass(session.view, session.realm, { passBudgetMs: 1000 });
    recordAnchors(session.view);
  });

  afterAll(() => { session?.close(); });

  it('loads headspace.js before the pass; the wmploc constants come from the prelude', () => {
    expect(session.scripts.map((s) => [s.name, s.result.ok])).toEqual([['headspace.js', true]]);
  });

  it('evaluates all 25 jscript: attributes of survey R0 without a fault, inside the pass cap', () => {
    expect(stats).toMatchObject({ total: 25, evaluated: 25, applied: 25, faulted: 0, unusable: 0, stopped: null });
    expect(stats.diagnostics).toEqual([]);
  });

  it('puts the volume slider at balance.left + balance.width + 10 = 89 and balance.top = 11 (parity 0.4)', () => {
    expect(place(byId('balance'))).toEqual([8, 11]);              // literals
    expect(byId('balance').get('width')).toBe(71);
    expect(place(byId('volume'))).toEqual([89, 11]);
  });

  it('puts the Volume label at volume.left + 19 = 108', () => {
    const label = panelChildren()[panelChildren().indexOf(byId('volume')) + 1];
    expect(label.kind).toBe('text');
    expect(label.get('value')).toBe('Volume');
    expect(place(label)).toEqual([108, 22]);                      // top is a literal 22
  });

  it('puts eq1 at balance.left + 3 = 11, balance.top + 33 = 44, and eq(i+1) 15 px right of eq(i)', () => {
    expect(place(byId('eq1'))).toEqual([11, 44]);
    for (let i = 1; i <= 10; i++) {
      expect(place(byId(`eq${i}`)), `eq${i}`).toEqual([11 + 15 * (i - 1), 44]);   // 11, 26, 41, ..., 146
    }
  });

  it('puts reset at eq10.left - 6 = 140 and eq1.top + 83 = 127 (the hand port has 129: the 2 px slip, parity D20)', () => {
    const reset = /** @type {ElementModel} */ (session.view.elements.find((e) => e.id === 'Unnamed_text_4'));
    expect(reset.get('value')).toMatch(/reset/i);
    expect(place(reset)).toEqual([140, 127]);
  });

  it('leaves every literal where the markup put it', () => {
    expect(byId('eq1').get('height')).toBe(76);
    expect(byId('eq1').get('width')).toBe(11);                    // probed from the background image
    expect([session.view.view.get('width'), session.view.view.get('height')]).toEqual([760, 394]);
  });

  it('records the margins in the EQ panel (171 x 140) after the pass', () => {
    expect(marginsOf(byId('volume'))).toEqual({ left: 89, top: 11, right: 171 - 89 - 71, bottom: 140 - 11 - 11 });
    expect(marginsOf(byId('eq10'))).toEqual({ left: 146, top: 44, right: 171 - 146 - 11, bottom: 140 - 44 - 76 });
  });

  it('has no alignment attributes anywhere, so a relayout moves nothing but the VIEW', () => {
    const before = session.view.elements.map((e) => [e.get('left'), e.get('top'), e.get('width'), e.get('height')]);
    relayout(session.view, 860, 494);
    expect(session.view.elements.map((e) => [e.get('left'), e.get('top'), e.get('width'), e.get('height')]).slice(1)).toEqual(before.slice(1));
    expect([session.view.view.get('width'), session.view.view.get('height')]).toEqual([860, 494]);
    relayout(session.view, 760, 394);
    expect(session.view.elements.map((e) => [e.get('left'), e.get('top'), e.get('width'), e.get('height')])).toEqual(before);
  });
});
