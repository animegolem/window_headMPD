// @ts-check
// `npm run corpus -- layout` (WAVES W3.1 acceptance 3). Opens every distinct WMP archive in
// skins/wmp the way the view runtime will for its main view (the first VIEW, U-8): the literal pass,
// the object graph and realm, the skin's own scripts, then the `jscript:` pass, `recordAnchors`,
// and a relayout up and back. Prints the numbers O compares against `survey` and `parity`. The
// suite skips when skins/ is absent (WAVES global rule 4). Nothing is written to the repository.
//
//   hard: 195 distinct archives, none of which makes the pass, the anchors or the relayout throw;
//         9SeriesDefault's `svMain.width` reads `svStub`'s literal 263 (859 - 263 - 250 = 346) and
//         `svStub.left` then reads that result; Revert's `view.width-2*left` evaluates (256 - 14 = 242);
//         no pass hits its 1,000 ms cap or finds the realm unloaded; a relayout up and back leaves
//         every element's geometry exactly where the pass put it.
//   printed: how many `jscript:` attributes the main views carry, how many evaluated and how many
//         faulted and why, the slowest pass, the elements a relayout moves, and how many elements
//         have two `jscript:` attributes whose order in the markup differs from the table order the
//         pass uses where one reads the other (the figure behind that decision in layout/expr.js).
//
// Run it with `--silent=false` to see the printed report: `npx vitest run --project corpus layout
// --silent=false`.

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { recordAnchors, relayout } from '../../src/engine/layout/align.js';
import { runLayoutPass } from '../../src/engine/layout/expr.js';
import { resolveTag } from '../../src/engine/wms/tags.js';
import { attrSpecsOf } from '../../src/engine/wms/attrs.js';
import { FAITHFUL } from '../../src/engine/options.js';
import { openSession } from '../engine/layout/harness.js';
import { describeCorpus } from '../support/fixtures.js';

/** @typedef {import('../../src/engine/contracts').ElementModel} ElementModel */
/** @typedef {import('../../src/engine/contracts').RawNode} RawNode */

const SURVEY = { distinct: 195 };

/** How much a relayout up changes the view by. */
const GROW = { w: 120, h: 80 };

/**
 * @typedef {Object} Row
 * @property {string} name
 * @property {string | null} threw
 * @property {string} viewId
 * @property {number} elements
 * @property {number} total          `jscript:` attributes in the main view
 * @property {number} evaluated
 * @property {number} faulted
 * @property {number} unusable
 * @property {string | null} stopped
 * @property {number} elapsedMs
 * @property {Map<string, number>} reasons    fault reason, first line up to the first colon, to count
 * @property {number} scriptsFailed
 * @property {boolean} unloaded
 * @property {number} aligned         elements with a non-default alignment
 * @property {number} moved           elements a relayout up changed
 * @property {boolean} roundTrip      geometry identical after up and back
 * @property {number} orderRisk       elements where markup order and table order give different values
 * @property {number} siblingReads    elements where one jscript: attribute reads another of the same element
 * @property {string[]} orderExamples
 * @property {Map<string, number[]>} geometry   id to [left, top, width, height] after the pass, for the named checks
 */

/** @type {Row[]} */
const rows = [];

/** @param {ElementModel[]} els @returns {string[]} */
const snapshot = (els) => els.map((e) => [e.get('left'), e.get('top'), e.get('width'), e.get('height')].join(','));

/**
 * Elements where a `jscript:` attribute reads a sibling `jscript:` attribute of its own element and
 * the markup puts the two in the opposite order from the attribute table. Those are the only
 * elements whose pass result depends on the within-element order.
 * @param {RawNode} root
 * @returns {{ count: number, reads: number, examples: string[] }} `reads` counts the elements where one
 *   `jscript:` attribute reads another of the same element in either order, `count` those where the order matters
 */
function orderRisk(root) {
  const view = root.children.find((c) => c.tag.toLowerCase() === 'view') ?? (root.tag.toLowerCase() === 'view' ? root : null);
  let count = 0;
  let reads = 0;
  /** @type {string[]} */
  const examples = [];
  if (!view) return { count, reads, examples };
  /** @type {RawNode[]} */
  const stack = [view];
  while (stack.length) {
    const node = /** @type {RawNode} */ (stack.pop());
    stack.push(...node.children);
    const table = new Map(attrSpecsOf(resolveTag(node.tag).kind).map((s, i) => [s.name.toLowerCase(), i]));
    const js = node.attrs.filter((a) => /^\s*jscript:/i.test(a.value) && table.has(a.name));
    if (js.length < 2) continue;
    const id = node.attrs.find((a) => a.name === 'id')?.value ?? '';
    let risky = false;
    let reading = false;
    for (const reader of js) {
      for (const read of js) {
        if (reader === read) continue;
        const name = read.name.replace(/[^\w]/g, '');
        const bare = new RegExp(`(?<![\\w.])${name}\\b`, 'i');                     // `left`
        const own = id ? new RegExp(`(?<![\\w.])${id.replace(/[^\w]/g, '\\$&')}\\s*\\.\\s*${name}\\b`, 'i') : null;   // `eq1.left` on eq1
        if (!bare.test(reader.value) && !own?.test(reader.value)) continue;
        reading = true;
        const markupBefore = js.indexOf(read) < js.indexOf(reader);
        const tableBefore = /** @type {number} */ (table.get(read.name)) < /** @type {number} */ (table.get(reader.name));
        if (markupBefore !== tableBefore) {
          risky = true;
          if (examples.length < 3) examples.push(`${node.tag}#${id || '?'} ${reader.name} reads ${read.name} (line ${node.line})`);
        }
      }
    }
    if (reading) reads++;
    if (risky) count++;
  }
  return { count, reads, examples };
}

describeCorpus('corpus layout: skins/wmp', (corpus) => {
  beforeAll(async () => {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const entry of corpus.archives('wmp')) {
      const bytes = corpus.read(entry);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (seen.has(sha)) continue;      // one archive per SHA-256, first in name order, as the survey counts
      seen.add(sha);

      /** @type {Row} */
      const row = {
        name: entry.name, threw: null, viewId: '', elements: 0, total: 0, evaluated: 0, faulted: 0, unusable: 0, stopped: null,
        elapsedMs: 0, reasons: new Map(), scriptsFailed: 0, unloaded: false, aligned: 0, moved: 0, roundTrip: true,
        orderRisk: 0, siblingReads: 0, orderExamples: [], geometry: new Map(),
      };
      rows.push(row);

      /** @type {Awaited<ReturnType<typeof openSession>> | null} */
      let session = null;
      try {
        // the real budgets: this gate measures what the engine will do, and runs alone on the owner's machine
        session = await openSession(bytes, { name: entry.name, track: false, realmOptions: { budgets: FAITHFUL.budgets } });
        const { view } = session;
        row.viewId = view.view.id;
        row.elements = view.elements.length;
        row.scriptsFailed = session.scripts.filter((s) => !s.result.ok).length;

        const stats = runLayoutPass(view, session.realm, { passBudgetMs: 1000 });
        recordAnchors(view);
        row.total = stats.total;
        row.evaluated = stats.evaluated;
        row.faulted = stats.faulted;
        row.unusable = stats.unusable;
        row.stopped = stats.stopped;
        row.elapsedMs = stats.elapsedMs;
        row.unloaded = session.realm.health.unloaded;
        for (const d of stats.diagnostics) {
          if (!d.code.startsWith('layout-expr-fault') && d.code !== 'layout-expr-hard-fault') continue;
          const reason = /: ([A-Za-z]+Error|[^:;]{1,40})/.exec(d.detail)?.[1] ?? 'other';
          row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + 1);
        }
        for (const id of ['svMain', 'svStub', 'seek']) {
          const el = view.byId(id);
          if (el) row.geometry.set(id, [el.get('left'), el.get('top'), el.get('width'), el.get('height')].map(Number));
        }
        row.aligned = view.elements.filter((e) => /^(right|center|stretch|bottom)$/i.test(`${e.get('horizontalalignment')}`) || /^(bottom|center|stretch)$/i.test(`${e.get('verticalalignment')}`)).length;

        const risk = orderRisk(session.root);
        row.orderRisk = risk.count;
        row.siblingReads = risk.reads;
        row.orderExamples = risk.examples;

        // a relayout up and back
        const w = Number(view.view.get('width'));
        const h = Number(view.view.get('height'));
        const before = snapshot([...view.elements]);
        relayout(view, w + GROW.w, h + GROW.h);
        const grown = snapshot([...view.elements]);
        row.moved = grown.filter((g, i) => g !== before[i]).length - 1;      // the VIEW itself always changes
        relayout(view, w, h);
        row.roundTrip = snapshot([...view.elements]).every((g, i) => g === before[i]);
      } catch (e) {
        row.threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      } finally {
        session?.close();
      }
    }
  });

  it('runs the layout pass over all 195 distinct main views without a host exception', () => {
    expect(rows).toHaveLength(SURVEY.distinct);
    expect(rows.filter((r) => r.threw !== null).map((r) => `${r.name}: ${r.threw}`)).toEqual([]);
  });

  it('never hits the pass cap or finds the realm unloaded', () => {
    expect(rows.filter((r) => r.stopped !== null).map((r) => `${r.name}: ${r.stopped}`)).toEqual([]);
    expect(rows.filter((r) => r.unloaded).map((r) => r.name)).toEqual([]);
  });

  it('9SeriesDefault: svMain.width reads svStub\'s literal 263, then svStub.left reads the result', () => {
    const nine = rows.filter((r) => /9SeriesDefault/i.test(r.name));
    expect(nine.length).toBeGreaterThan(0);
    for (const r of nine) {
      expect(r.viewId, r.name).toBe('vPlayer');
      expect(r.geometry.get('svMain'), r.name).toEqual([250, 0, 859 - 263 - 250, 289]);
      expect(r.geometry.get('svStub')?.[0], r.name).toBe(250 + (859 - 263 - 250));
      expect(r.geometry.get('svStub')?.[2], r.name).toBe(263);
    }
  });

  it('Revert: width="jscript:view.width-2*left" evaluates', () => {
    const revert = rows.filter((r) => /^(microsoft__)?Revert/i.test(r.name));
    expect(revert.length).toBeGreaterThan(0);
    for (const r of revert) {
      expect(r.viewId, r.name).toBe('vwPlayer');
      expect(r.geometry.get('seek'), r.name).toEqual([7, 86, 256 - 2 * 7, 13]);
    }
  });

  it('a relayout up and back restores every element exactly', () => {
    expect(rows.filter((r) => !r.roundTrip).map((r) => r.name)).toEqual([]);
  });

  it('prints the numbers for the survey comparison', () => {
    const sum = (/** @type {(r: Row) => number} */ f) => rows.reduce((n, r) => n + f(r), 0);
    /** @type {Map<string, number>} */
    const reasons = new Map();
    for (const r of rows) for (const [k, n] of r.reasons) reasons.set(k, (reasons.get(k) ?? 0) + n);
    const withJs = rows.filter((r) => r.total > 0);
    const slowest = [...rows].sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
    const risky = rows.filter((r) => r.orderRisk > 0);
    const moving = rows.filter((r) => r.moved > 0);
    const lines = [
      `W3.1 corpus: ${rows.length} main views, ${sum((r) => r.elements)} elements, ${withJs.length} skins with jscript: attributes (survey: 147/195 on left/top/width/height)`,
      `W3.1 corpus: ${sum((r) => r.total)} jscript: attributes, ${sum((r) => r.evaluated)} evaluated, ${sum((r) => r.faulted)} faulted, ${sum((r) => r.unusable)} unusable results; faults by reason ${JSON.stringify(Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])))}`,
      `W3.1 corpus: slowest pass ${slowest?.elapsedMs.toFixed(1)} ms (${slowest?.name}); skins whose scripts failed to load: ${rows.filter((r) => r.scriptsFailed > 0).length}`,
      `W3.1 corpus: ${rows.filter((r) => r.aligned > 0).length} skins have aligned elements (${sum((r) => r.aligned)}); a relayout of +${GROW.w} x +${GROW.h} moves elements in ${moving.length} of them (${sum((r) => r.moved)} elements)`,
      `W3.1 corpus: ${sum((r) => r.siblingReads)} elements read a sibling jscript: attribute of their own element; within-element order matters in ${risky.length} skins (${sum((r) => r.orderRisk)} elements)${risky.length ? `, e.g. ${risky.slice(0, 3).map((r) => `${r.name}: ${r.orderExamples[0]}`).join('; ')}` : ''}`,
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(withJs.length).toBeGreaterThan(0);
    // G3: pinned so a change cannot pass silently. The 28 TypeErrors are host properties called as
    // methods (mediacenter.effectType()), deferred to phase 3 (E §11.2); the 2 ReferenceErrors are a
    // real skin bug in howarduniversity__Jordan.
    expect(Object.fromEntries(reasons)).toEqual({ TypeError: 28, ReferenceError: 2 });
  });
});
