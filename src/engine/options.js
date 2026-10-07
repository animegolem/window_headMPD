// @ts-check
// The two engine configurations of ENGINE.md D9 and §5.10. `faithful` ships; `oracle-compat` flips
// exactly the switches that correspond to deviations allow-list entries (§9), so the skinlab diff
// between them measures the allow-list instead of hiding it. Both are frozen because they are shared
// defaults: a caller passes a partial override to `createEngine(host, opts)` instead.
//
// The literals are annotated before freezing because `Object.freeze` would otherwise hide a
// misspelt or extra key from the type check.

/** @typedef {import('./contracts').EngineOptions} EngineOptions */
/** @typedef {import('./contracts').RealmBudgets} RealmBudgets */

/** @type {RealmBudgets} */
const budgets = { scripts: 2000, load: 1000, handler: 100, expr: 20, exprPass: 1000 }; // ms, §5.5

/** @type {EngineOptions} */
const faithful = {
  config: 'faithful',
  sliderGeometry: 'oracle',        // 'oracle' in both configs (D2, D9; parity D32, U-10)
  showBackgroundDefault: false,    // U-23: BUTTONGROUP pixels no mappingColor owns stay unpainted
  buttonKeyedPixelsHit: true,      // spec 2.7: a BUTTON takes clicks on its transparent pixels
  stacking: 'context',             // Reading C: every SUBVIEW is a stacking context (D5)
  subviewClip: true,               // a SUBVIEW with a non-zero size clips its subtree (D2, R10)
  availability: 'oracle',          // phase 1 uses the oracle's isAvailable table (D6, parity D16)
  realmTickHz: 10,
  budgets: Object.freeze(budgets),
};

/** @type {EngineOptions} */
const oracleCompat = {
  ...faithful,
  config: 'oracle-compat',
  showBackgroundDefault: true,     // allow-list entry U-23-showBackground
  buttonKeyedPixelsHit: false,     // allow-list entry button-transparency
};

/** @type {EngineOptions} */
export const FAITHFUL = Object.freeze(faithful);

/** @type {EngineOptions} */
export const ORACLE_COMPAT = Object.freeze(oracleCompat);
