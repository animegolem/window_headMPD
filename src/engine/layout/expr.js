// @ts-check
// The `jscript:` pass (E §5.11 `evaluateLayout`; E D5 "`jscript:` evaluation: once, in source
// order"; E §3.1 step 5; spec 2.1 step 4, 3.2).
//
// After the literal pass every element exists with its literal values, and the skin's scripts have
// loaded. This pass walks the elements in source order and evaluates each `jscript:` attribute
// exactly once, in the realm, and writes the result back with origin 'layout'. Nothing here
// re-evaluates: the corpus pairs `left="jscript:view.width-N"` with `horizontalAlignment="right"` in
// 2,773 of 2,791 cases, so the expression places and the alignment (layout/align.js) keeps the
// anchor; liveness is spelled `wmpprop:`.
//
// What falls out of "one pass, in order":
//  - an expression reads a literal attribute of any element, wherever that element is declared
//    (9SeriesDefault's `svMain.width` reads `svStub.width`, a literal 263 declared 816 lines later);
//  - it reads a `jscript:` attribute that comes later in the file as that attribute's default, which
//    is what the model holds until the attribute's own turn (a number's 0), and an earlier one as its
//    value;
//  - it reads script globals (`left="JScript:eqLeft+0"`) because the scripts loaded first.
//
// Order within one element. `ElementModel` has no way to list an element's attributes in markup
// order, so the attributes of one element go in the order of the attribute table
// (left, top, right, bottom, width, height, then the rest). Position before size is also the order
// authors write them in, and the only case where it can matter is an expression that reads a
// sibling attribute of its own element (`width="jscript:view.width-2*left"`), which it does with
// the sibling's value as it stands at that point.
//
// Caps. A single expression is bounded by the realm (20 ms, `budgets.expr`). The pass as a whole is
// bounded here, by `passBudgetMs` of wall time (E §10: 1,000 ms), checked before each expression:
// the first expression that would start after the budget is spent ends the pass with one diagnostic,
// and every attribute not yet reached keeps its literal or default. A realm that has unloaded (an
// OOM, an abort, three hard faults) ends the pass the same way. The wall clock is captured at module
// load, like the realm's, so a frozen engine clock cannot disable the cap.
//
// Nothing in here throws on skin input. A fault from the realm is a diagnostic and the attribute
// stays where it was; a realm call that throws anyway (a bug, not skin text) is a diagnostic too.

import { attrSpecsOf } from '../wms/attrs.js';
import { coerce } from '../wms/values.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').ViewModel} ViewModel */
/** @typedef {import('../contracts').Realm} Realm */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../contracts').AttrSpec} AttrSpec */
/** @typedef {import('../contracts').ElementKind} ElementKind */

/** The pass cap when the caller gives none (E §10). */
export const DEFAULT_PASS_BUDGET_MS = 1000;

/** Diagnostics per code before one `<code>-capped` (the realm's rule, E §10 "realm diagnostics"). */
export const MAX_DIAGNOSTICS_PER_CODE = 64;

/** Longest skin-controlled snippet quoted in a diagnostic. */
const CLIP = 60;

const wallClock = performance.now.bind(performance);

/** Sentinel for "coerce found the value invalid". */
const INVALID = Symbol('invalid');

/** @param {string} s @param {number} [n] */
const clip = (s, n = CLIP) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * Options of the pass. `passBudgetMs` is the contract's; `now` is a seam for tests (a clock in
 * milliseconds that is allowed to be fake), and nothing in the engine passes it.
 * @typedef {{ passBudgetMs: number, now?: () => number }} LayoutOptions
 */

/**
 * What a pass did, for the corpus run and the tests. `evaluateLayout` returns only `diagnostics`.
 * @typedef {Object} LayoutStats
 * @property {Diagnostic[]} diagnostics
 * @property {number} total       `jscript:` attributes the pass found
 * @property {number} evaluated   expressions the realm was asked to evaluate
 * @property {number} applied     results written to the model (the value changed or not)
 * @property {number} faulted     expressions the realm faulted on, soft and hard
 * @property {number} unusable    results that could not be written: not a value of the attribute's type, or a read-only attribute
 * @property {'budget' | 'unloaded' | null} stopped   why the pass ended early, if it did
 * @property {number} remaining   attributes not reached when it did
 * @property {number} elapsedMs
 */

/**
 * The attributes of a kind that can carry a `jscript:` source: everything but handlers (a handler is
 * never classified, E D5). Built once per kind.
 * @type {Map<ElementKind, AttrSpec[]>}
 */
const specsByKind = new Map();

/** @param {ElementKind} kind @returns {AttrSpec[]} */
function valueSpecs(kind) {
  let specs = specsByKind.get(kind);
  if (!specs) specsByKind.set(kind, (specs = attrSpecsOf(kind).filter((s) => s.type !== 'handler')));
  return specs;
}

/**
 * A diagnostic list that stops growing at `MAX_DIAGNOSTICS_PER_CODE` per code.
 * @returns {{ list: Diagnostic[], add: (d: Diagnostic) => void }}
 */
function createSink() {
  /** @type {Diagnostic[]} */
  const list = [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  return {
    list,
    add(d) {
      const n = (counts.get(d.code) ?? 0) + 1;
      counts.set(d.code, n);
      if (n <= MAX_DIAGNOSTICS_PER_CODE) list.push(d);
      else if (n === MAX_DIAGNOSTICS_PER_CODE + 1) {
        list.push({ code: `${d.code}-capped`, severity: 'info', detail: `more than ${MAX_DIAGNOSTICS_PER_CODE} "${d.code}" diagnostics; the rest are dropped` });
      }
    },
  };
}

/**
 * Run the pass and report what it did.
 * @param {ViewModel} view @param {Realm} realm @param {LayoutOptions} opts
 * @returns {LayoutStats}
 */
export function runLayoutPass(view, realm, opts) {
  const now = typeof opts?.now === 'function' ? opts.now : wallClock;
  const budget = Number.isFinite(opts?.passBudgetMs) && opts.passBudgetMs >= 0 ? opts.passBudgetMs : DEFAULT_PASS_BUDGET_MS;
  const sink = createSink();
  const start = now();

  // Source order, then table order within an element. The list is built up front so the budget
  // diagnostic can say how many attributes it left alone.
  /** @type {Array<{ el: ElementModel, spec: AttrSpec, source: string }>} */
  const work = [];
  for (const el of view.elements) {
    for (const spec of valueSpecs(el.kind)) {
      const source = el.source(spec.name);
      if (source?.kind === 'jscript') work.push({ el, spec, source: source.source });
    }
  }

  /** @type {LayoutStats} */
  const stats = { diagnostics: sink.list, total: work.length, evaluated: 0, applied: 0, faulted: 0, unusable: 0, stopped: null, remaining: 0, elapsedMs: 0 };

  for (let i = 0; i < work.length; i++) {
    if (now() - start >= budget) {
      stats.stopped = 'budget';
      stats.remaining = work.length - i;
      sink.add({ code: 'layout-pass-budget', severity: 'warn',
        detail: `the jscript: pass used its ${budget} ms; ${stats.remaining} of ${work.length} attributes keep their literal values` });
      break;
    }
    if (realm.health.unloaded) {
      stats.stopped = 'unloaded';
      stats.remaining = work.length - i;
      sink.add({ code: 'layout-pass-aborted', severity: 'error',
        detail: `the script realm unloaded during the jscript: pass; ${stats.remaining} of ${work.length} attributes keep their literal values` });
      break;
    }

    const { el, spec, source } = work[i];
    const where = `${spec.name}="jscript:${clip(source)}"`;
    stats.evaluated++;

    let result;
    try {
      result = realm.evalExpression(el.handle, spec.name, source);
    } catch (e) {
      // The realm reports faults as values; a throw here is an engine bug, and it must not take
      // the load down with it.
      stats.faulted++;
      sink.add({ code: 'layout-expr-host-error', severity: 'error', elementId: el.id,
        detail: `${where}: the realm call threw: ${clip(e instanceof Error ? e.message : String(e), 120)}` });
      continue;
    }

    if (!result.ok) {
      stats.faulted++;
      sink.add({
        code: result.kind === 'hard' ? 'layout-expr-hard-fault' : 'layout-expr-fault',
        severity: result.kind === 'hard' ? 'error' : 'warn',
        elementId: el.id,
        detail: `${where}: ${clip(String(result.reason), 120)}; the attribute keeps its literal value`,
      });
      continue;
    }

    const value = result.value;
    // undefined, null and a host handle are not values an attribute can hold. `coerce` says whether
    // the rest fit the attribute's type; it keeps the previous value on a misfit (U-20), and that is
    // also what `ElementModel.set` does, but here the misfit gets a diagnostic.
    const usable = value !== undefined && value !== null && typeof value !== 'object' && coerce(spec.type, value, INVALID) !== INVALID;
    if (!usable) {
      stats.unusable++;
      sink.add({ code: 'layout-expr-value', severity: 'warn', elementId: el.id,
        detail: `${where} gave ${describe(value)}, which is not a valid ${typeof spec.type === 'string' ? spec.type : 'enum'} value; the attribute keeps its literal value` });
      continue;
    }
    if (spec.access === 'r') {
      // The model takes writes to a read-only attribute from markup and the host alone. The
      // expression has run (its side effects stand); its result goes nowhere.
      stats.unusable++;
      sink.add({ code: 'layout-expr-readonly', severity: 'info', elementId: el.id,
        detail: `${where}: ${spec.name} is read-only; the result is dropped` });
      continue;
    }
    el.set(spec.name, value, 'layout');
    stats.applied++;
  }

  stats.elapsedMs = now() - start;
  return stats;
}

/** @param {unknown} v */
function describe(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'object') return 'an object';
  return clip(String(v), 40);
}

/**
 * Evaluate every `jscript:` attribute of the VIEW once, in source order, and write the results with
 * origin 'layout'. Returns the diagnostics. Calling it again would evaluate everything again; the
 * runtime calls it once per view.
 * @type {import('../contracts').EvaluateLayoutFn}
 */
export const evaluateLayout = (view, realm, opts) => runLayoutPass(view, realm, /** @type {LayoutOptions} */ (opts)).diagnostics;
