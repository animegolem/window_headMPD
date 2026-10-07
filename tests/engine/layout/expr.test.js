// @ts-check
// `evaluateLayout` (WAVES W3.1 acceptance 1; ENGINE D5 "`jscript:` evaluation: once, in document
// order"; E §5.11). Every case builds a small VIEW from `.wms` text, loads it through the real
// builder, object graph and realm (harness.js), and runs the pass.

import { describe, expect, it } from 'vitest';
import { evaluateLayout, runLayoutPass, MAX_DIAGNOSTICS_PER_CODE } from '../../../src/engine/layout/expr.js';
import { openSession, skinBytes, wmsOf } from './harness.js';

/** @typedef {import('../../../src/engine/contracts').ElementModel} ElementModel */

/**
 * @param {string} body @param {{ script?: string, viewAttrs?: string }} [opts]
 */
async function open(body, opts = {}) {
  const s = await openSession(skinBytes(wmsOf(body, opts.viewAttrs), { script: opts.script }), { scripts: false });
  if (opts.script !== undefined) {
    const r = s.realm.loadScript('skin.js', opts.script);
    if (!r.ok) throw new Error(`script failed: ${r.reason}`);
  }
  const el = (/** @type {string} */ id) => /** @type {ElementModel} */ (s.view.byId(id));
  return { ...s, el };
}

const OPTS = { passBudgetMs: 1000 };

describe('evaluateLayout: once, in source order', () => {
  it('reads the literal of an element declared later (the 9SeriesDefault forward read)', async () => {
    const { view, realm, el } = await open(`
      <SUBVIEW id="main" left="250" width="jscript:view.width-stub.width-main.left;"/>
      <SUBVIEW id="stub" left="jscript:main.left+main.width" width="263"/>`);
    expect(el('main').get('width')).toBe(0);                    // before the pass: the default
    expect(evaluateLayout(view, realm, OPTS)).toEqual([]);
    expect(el('main').get('width')).toBe(760 - 263 - 250);      // stub.width is its literal
    expect(el('stub').get('left')).toBe(250 + (760 - 263 - 250)); // main.width is already evaluated: source order
  });

  it('reads a jscript: attribute that comes later as its default, and an earlier one as its value', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="a" left="jscript:b.left+1"/>
      <TEXT id="b" left="jscript:100"/>
      <TEXT id="c" left="jscript:b.left+1"/>`);
    evaluateLayout(view, realm, OPTS);
    expect(el('a').get('left')).toBe(1);        // b.left was still 0
    expect(el('b').get('left')).toBe(100);
    expect(el('c').get('left')).toBe(101);      // b.left now 100
  });

  it('lets an expression read its own element\'s attributes (view.width-2*left)', async () => {
    const { view, realm, el } = await open(`
      <SLIDER id="seek" left="7" top="86" width="jscript:view.width-2*left" height="13"/>`, { viewAttrs: 'id="main" width="256" height="130"' });
    evaluateLayout(view, realm, OPTS);
    expect(el('seek').get('width')).toBe(256 - 2 * 7);
  });

  it('reads the sibling jscript: attribute of its own element after it, table order: left before width', async () => {
    const { view, realm, el } = await open(`
      <SLIDER id="s" width="jscript:view.width-2*left" left="jscript:7"/>`, { viewAttrs: 'id="main" width="256" height="130"' });
    evaluateLayout(view, realm, OPTS);
    // `width` is written first in the markup, but left comes first in the attribute table
    expect(el('s').get('left')).toBe(7);
    expect(el('s').get('width')).toBe(256 - 14);
  });

  it('reads a script global (eqLeft+0)', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="t" left="JScript:eqLeft+0"/>
      <TEXT id="u" left="jscript:eqLeft+eqStep;" top="jscript:view.height-eqStep"/>`, { script: 'var eqLeft = 42; var eqStep = 8;' });
    expect(evaluateLayout(view, realm, OPTS)).toEqual([]);
    expect(el('t').get('left')).toBe(42);
    expect(el('u').get('left')).toBe(50);
    expect(el('u').get('top')).toBe(394 - 8);
  });

  it('accepts the spellings of the prefix and the trailing semicolon', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="a" left="jscript:view.width-1;"/>
      <TEXT id="b" left="JScript: view.width-2"/>
      <TEXT id="c" left="  JSCRIPT:view.width-3 ;"/>`);
    evaluateLayout(view, realm, OPTS);
    expect([el('a'), el('b'), el('c')].map((e) => e.get('left'))).toEqual([759, 758, 757]);
  });

  it('is the VIEW\'s own attributes too, first', async () => {
    const { view, realm } = await open(`<TEXT id="t" left="jscript:view.width"/>`, { viewAttrs: 'id="main" width="jscript:500" height="300"' });
    evaluateLayout(view, realm, OPTS);
    expect(view.view.get('width')).toBe(500);
    expect(view.byId('t')?.get('left')).toBe(500);          // the VIEW was evaluated before the TEXT
  });

  it('coerces the result to the attribute\'s type', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="a" left="jscript:10.5" top="jscript:11.5"/>
      <TEXT id="b" left="jscript:'12'" visible="jscript:0"/>
      <TEXT id="c" value="jscript:1+1" visible="jscript:view.width>100" foregroundColor="jscript:'#ff0000'"/>
      <TEXT id="d" justification="jscript:'right'" fontSize="jscript:'9 '"/>`);
    expect(evaluateLayout(view, realm, OPTS)).toEqual([]);
    expect([el('a').get('left'), el('a').get('top')]).toEqual([10, 12]);   // half to even
    expect(el('b').get('left')).toBe(12);
    expect(el('b').get('visible')).toBe(false);
    expect(el('c').get('value')).toBe('2');
    expect(el('c').get('visible')).toBe(true);
    expect(el('c').get('foregroundColor')).toBe(0xff0000);
    expect(el('d').get('justification')).toBe('Right');
    expect(el('d').get('fontSize')).toBe(9);
  });

  it('does not run jscript: text on an attribute the kind does not know (G12)', async () => {
    const { view, realm, el } = await open(`<TEXT id="t" bogus="jscript:view.width" left="jscript:3"/>`);
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats.total).toBe(1);
    expect(stats.evaluated).toBe(1);
    expect(el('t').get('bogus')).toBe('jscript:view.width');     // inert text
  });

  it('does not run handlers or wmpprop: values', async () => {
    const { view, realm } = await open(`
      <BUTTON id="b" onclick="jscript:alert(1)" visible="wmpenabled:player.controls.play" top="wmpprop:view.width"/>`);
    expect(runLayoutPass(view, realm, OPTS).total).toBe(0);
  });

  it('writes with origin layout: the attribute is dirty and its _onchange handler is queued', async () => {
    const { view, realm } = await open(`
      <SLIDER id="s" value="jscript:25" value_onchange="x=1" left="jscript:5"/>`);
    view.takeDirty();
    view.takeQueuedEvents();
    /** @type {string[]} */
    const origins = [];
    view.onChange((_el, attr, _v, origin) => { origins.push(`${attr}:${origin}`); });
    evaluateLayout(view, realm, OPTS);
    expect(origins).toEqual(['left:layout', 'value:layout']);    // table order inside the element
    expect([...view.takeDirty().get(/** @type {ElementModel} */ (view.byId('s'))) ?? []].sort()).toEqual(['left', 'value']);
    expect(view.takeQueuedEvents().map((q) => `${q.el.id}.${q.event}`)).toEqual(['s.value_onchange']);
  });

  it('treats the ids __proto__ and constructor as ordinary ids', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="__proto__" left="30"/>
      <TEXT id="constructor" left="jscript:__proto__.left+1" top="jscript:view.height"/>
      <TEXT id="after" left="jscript:constructor.left+1"/>`);
    expect(evaluateLayout(view, realm, OPTS)).toEqual([]);
    expect(el('constructor').get('left')).toBe(31);
    expect(el('constructor').get('top')).toBe(394);
    expect(el('after').get('left')).toBe(32);
  });
});

describe('evaluateLayout: faults and unusable results', () => {
  it('leaves the literal in place, says which element and attribute, and carries on', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="first" left="jscript:1"/>
      <TEXT id="bad" left="jscript:noSuchName+1" top="12"/>
      <TEXT id="throws" left="jscript:(function(){ throw new Error('boom'); })()"/>
      <TEXT id="last" left="jscript:first.left+1"/>`);
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats).toMatchObject({ total: 4, evaluated: 4, applied: 2, faulted: 2, unusable: 0, stopped: null });
    expect(el('bad').get('left')).toBe(0);        // the default: it had no literal
    expect(el('last').get('left')).toBe(2);       // the pass went on
    expect(stats.diagnostics.map((d) => [d.code, d.severity, d.elementId])).toEqual([
      ['layout-expr-fault', 'warn', 'bad'],
      ['layout-expr-fault', 'warn', 'throws'],
    ]);
    expect(stats.diagnostics[0].detail).toMatch(/left="jscript:noSuchName\+1"/);
    expect(stats.diagnostics[0].detail).toMatch(/ReferenceError/);
  });

  it('keeps the default when the result is not a value the attribute can hold, and says so', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="a" left="jscript:void 0"/>
      <TEXT id="b" left="jscript:view"/>
      <TEXT id="c" left="jscript:'abc'" visible="jscript:'ture'"/>
      <TEXT id="d" left="jscript:null"/>`);
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats.unusable).toBe(5);
    expect(stats.applied).toBe(0);
    expect(['a', 'b', 'c', 'd'].map((id) => el(id).get('left'))).toEqual([0, 0, 0, 0]);
    expect(el('c').get('visible')).toBe(true);
    expect(stats.diagnostics.map((d) => d.code)).toEqual(Array(5).fill('layout-expr-value'));
    expect(stats.diagnostics[0].detail).toMatch(/gave undefined/);
    expect(stats.diagnostics[1].detail).toMatch(/gave an object/);
  });

  it('runs an expression on a read-only attribute and drops its result with a diagnostic', async () => {
    const { view, realm, el } = await open(`<BUTTONGROUP id="g" buttonCount="jscript:g.left=9;5"/>`);
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats).toMatchObject({ evaluated: 1, applied: 0, unusable: 1 });
    expect(stats.diagnostics.map((d) => [d.code, d.severity])).toEqual([['layout-expr-readonly', 'info']]);
    expect(el('g').get('buttonCount')).toBe(0);
    expect(el('g').get('left')).toBe(9);          // the side effect of the expression stands
  });

  it('caps the diagnostics at 64 per code, then one -capped', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `<TEXT id="t${i}" left="jscript:nope${i}"/>`).join('\n');
    const { view, realm } = await open(rows);
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats.faulted).toBe(100);
    const faults = stats.diagnostics.filter((d) => d.code === 'layout-expr-fault');
    expect(faults).toHaveLength(MAX_DIAGNOSTICS_PER_CODE);
    expect(stats.diagnostics.filter((d) => d.code === 'layout-expr-fault-capped')).toHaveLength(1);
    expect(stats.diagnostics).toHaveLength(MAX_DIAGNOSTICS_PER_CODE + 1);
  });

  it('quotes a long skin expression clipped', async () => {
    const { view, realm } = await open(`<TEXT id="t" left="jscript:${'x'.repeat(500)}"/>`);
    const [d] = evaluateLayout(view, realm, OPTS);
    expect(d.detail.length).toBeLessThan(300);
  });

  it('ends the pass when the realm has unloaded, and leaves everything unevaluated', async () => {
    const { view, realm, el } = await open(`
      <TEXT id="a" left="jscript:1"/>
      <TEXT id="b" left="jscript:2"/>`);
    realm.unload('test');
    const stats = runLayoutPass(view, realm, OPTS);
    expect(stats).toMatchObject({ total: 2, evaluated: 0, stopped: 'unloaded', remaining: 2 });
    expect(stats.diagnostics.map((d) => d.code)).toEqual(['layout-pass-aborted']);
    expect(el('a').get('left')).toBe(0);
  });

  it('survives a realm call that throws, as a diagnostic', async () => {
    const { view, el } = await open(`<TEXT id="a" left="jscript:1"/><TEXT id="b" left="jscript:2"/>`);
    const broken = /** @type {any} */ ({
      health: { unloaded: false },
      evalExpression() { throw new Error('realm bug'); },
    });
    const stats = runLayoutPass(view, broken, OPTS);
    expect(stats.faulted).toBe(2);
    expect(stats.diagnostics.map((d) => d.code)).toEqual(['layout-expr-host-error', 'layout-expr-host-error']);
    expect(el('a').get('left')).toBe(0);
  });
});

describe('evaluateLayout: the pass cap', () => {
  const FIVE = `
    <TEXT id="a" left="jscript:1"/><TEXT id="b" left="jscript:2"/><TEXT id="c" left="jscript:3"/>
    <TEXT id="d" left="jscript:4"/><TEXT id="e" left="jscript:5"/>`;

  /**
   * A realm that costs `cost` ms of the test's clock per expression.
   * @param {import('../../../src/engine/contracts').Realm} realm @param {{ t: number }} clock @param {number} cost
   */
  const costly = (realm, clock, cost) => /** @type {import('../../../src/engine/contracts').Realm} */ (/** @type {unknown} */ ({
    get health() { return realm.health; },
    evalExpression(/** @type {number} */ el, /** @type {string} */ attr, /** @type {string} */ src) {
      clock.t += cost;
      return realm.evalExpression(el, attr, src);
    },
  }));

  it('stops when the budget is spent: the rest keep their literals, with one diagnostic', async () => {
    const { view, realm, el } = await open(FIVE);
    const clock = { t: 0 };
    const stats = runLayoutPass(view, costly(realm, clock, 400), { passBudgetMs: 1000, now: () => clock.t });
    // before each expression the clock reads 0, 400, 800, 1200: the first three run
    expect(stats).toMatchObject({ total: 5, evaluated: 3, applied: 3, stopped: 'budget', remaining: 2 });
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => el(id).get('left'))).toEqual([1, 2, 3, 0, 0]);
    expect(stats.diagnostics.map((d) => d.code)).toEqual(['layout-pass-budget']);
    expect(stats.diagnostics[0].detail).toMatch(/2 of 5/);
  });

  it('does not stop a pass that finishes in time', async () => {
    const { view, realm } = await open(FIVE);
    const clock = { t: 0 };
    const stats = runLayoutPass(view, costly(realm, clock, 100), { passBudgetMs: 1000, now: () => clock.t });
    expect(stats).toMatchObject({ evaluated: 5, stopped: null, remaining: 0 });
    expect(stats.diagnostics).toEqual([]);
  });

  it('a budget of zero evaluates nothing (real clock, no timing in the assertion)', async () => {
    const { view, realm, el } = await open(FIVE);
    const diagnostics = evaluateLayout(view, realm, { passBudgetMs: 0 });
    expect(diagnostics.map((d) => d.code)).toEqual(['layout-pass-budget']);
    expect(el('a').get('left')).toBe(0);
  });

  it('takes the contract\'s 1,000 ms when the budget is not a number', async () => {
    const { view, realm, el } = await open(FIVE);
    expect(evaluateLayout(view, realm, { passBudgetMs: NaN })).toEqual([]);
    expect(el('e').get('left')).toBe(5);
  });
});
