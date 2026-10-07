// @ts-check
// RG0 item 7 (ENGINE D1, WAVES W1.4): every inline handler of the distinct WMP corpus compiles in
// QuickJS with exactly the five known failures of survey 5.2, and every script file compiles except the
// seven pinned call-assignment files below (G1 ruling; W2.2 item 10 makes the loader rewrite them and
// flips the script expectation to 219/219). Handlers come from the throwaway entity-decoding extractor
// next to the realm-gate tests, as the survey's did, so this gate does not wait for the scanner (W1.2)
// or the archive reader (W1.1).
//
//   npm run corpus -- realm-gate
//
// Skips, with the reason in the suite title, when skins/ is absent (WAVES global rule 4).

import { describe, expect, it } from 'vitest';
import { describeCorpus } from '../support/fixtures.js';
import { extractCorpus } from '../realm-gate/extract-handlers.mjs';
import { VARIANT_NAME, newInstance } from '../realm-gate/qjs.js';

/** Survey 5.2: 219 scripts, 12,868 handler attributes in 195 distinct archives, 5 failures. */
const EXPECTED = { archives: 195, scripts: 219, handlers: 12868, empty: 128, failures: 5 };
/** The five, all in one skin: a `jscript:` label used as an expression (`supersoni__Faith Hill.wmz/faithhill.wms:14-15`). */
const KNOWN_FAILURES = {
  archive: 'supersoni__Faith Hill.wmz',
  attrs: ['onMediaChange', 'onOpenStateChange', 'onPlayStateChange', 'onPositionChange', 'onStatusChange'],
};

/**
 * The seven script files QuickJS cannot compile, pinned by archive and file name, sorted by archive then
 * file in code-unit order (so `Revert (1).wmz` precedes `Revert.wmz`). Each holds one statement that
 * assigns to a call expression (the case below proves it). W2.2 item 10 (E R20) adds the loader's
 * rewrite; when it lands, this list becomes `[]` and the script case asserts 219 of 219.
 * @type {ReadonlyArray<readonly [archive: string, file: string]>}
 */
const KNOWN_SCRIPT_FAILURES = [
  ['Charlies_Angels_Full_Throttle.wmz', 'charlies Angels.js'],
  ['Revert (1).wmz', 'netgen.js'],
  ['Revert.wmz', 'netgen.js'],
  ['Tomb Raider 2.wmz', 'TombRaider.js'],
  ['compact.wmz', 'compact.js'],
  ['holiday_skin.wmz', 'gingerbread.js'],
  ['holiday_skin.wmz', 'msholiday.js'],
];

/** Code-unit order, not locale order, so the pinned list sorts the same on every machine. @param {string} a @param {string} b */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A handler exactly as D1 compiles it: `new Function(<params>, "with(__IDS){with(this){" + body + "\n}}")`,
 * checked here as a function expression in global code, compile only, so nothing runs. The `\n` before
 * the closers matters: a body ending in a `//` comment must not eat them.
 * @param {string} body
 */
const handlerSource = (body) => `(function(){with(__IDS){with(this){${body}\n}}})`;

/** D1: "Only if compilation fails is one leading `identifier:` stripped and compilation retried." @param {string} body */
const stripOneLabel = (body) => body.replace(/^\s*[A-Za-z_$][\w$]*\s*:/, '');

/** @type {(inst: import('../realm-gate/qjs.js').Instance, body: string) => { ok: boolean, via?: 'as-is' | 'label-stripped', message?: string }} */
function compileHandler(inst, body) {
  const first = inst.compile(handlerSource(body), 'handler.js');
  if (first.ok) return { ok: true, via: 'as-is' };
  const stripped = stripOneLabel(body);
  if (stripped !== body) {
    const second = inst.compile(handlerSource(stripped), 'handler.js');
    if (second.ok) return { ok: true, via: 'label-stripped' };
  }
  return { ok: false, message: `${first.error.name}: ${first.error.message}` };
}

describe('the compile check itself', () => {
  it('accepts a label prefix as-is, and rejects the survey 5.2 typo even after stripping a label', async () => {
    const inst = await newInstance();
    try {
      expect(compileHandler(inst, 'jscript:player.controls.play();')).toEqual({ ok: true, via: 'as-is' });
      expect(compileHandler(inst, 'wmpprop:x=1;\n// trailing comment')).toEqual({ ok: true, via: 'as-is' });
      expect(compileHandler(inst, '')).toEqual({ ok: true, via: 'as-is' });
      const typo = compileHandler(inst, 'tracktitle.value=jscript:player.currentmedia.name');
      expect(typo.ok).toBe(false);
      expect(!typo.ok && typo.message).toMatch(/SyntaxError/);
      // Compile only: a body that would throw if it ran compiles fine, and nothing ran.
      expect(compileHandler(inst, 'undefinedFn()')).toEqual({ ok: true, via: 'as-is' });
    } finally {
      inst.unload();
    }
  });
});

/**
 * The one pattern that stops 7 scripts compiling: assignment to a call expression, `eq.gainLevels(band) =
 * value;` and `theme.savePreference('k') = '--';`. V8 (the survey's engine) accepts it and throws a
 * ReferenceError only if it runs; QuickJS, bellard's and ng's alike, rejects it while parsing, so the whole
 * script file is lost. Rewriting the statement to an ordinary call makes it compile; that rewrite is the
 * proof that these statements are the only incompatibility, not a proposed implementation.
 */
const CALL_ASSIGNMENT = /^(\s*)([A-Za-z_$][\w$.]*\([^()\n]*\))[ \t]*=(?!=)[ \t]*([^;\n]+);/gm;
/** @param {string} source */
const rewriteCallAssignments = (source) => source.replace(CALL_ASSIGNMENT, '$1__badLhs($2, $3);');

/**
 * @typedef {Object} Scan
 * @property {ReturnType<typeof extractCorpus>} corpus
 * @property {number} scripts
 * @property {number} handlers
 * @property {number} empty
 * @property {Array<{ archive: string, file: string, where: string, source: string, message: string }>} scriptFailures
 * @property {Array<{ archive: string, tag: string, attr: string, message: string }>} handlerFailures
 * @property {number} asIs
 * @property {number} rescued
 * @property {Array<{ where: string, rewrittenCompiles: boolean, statements: number }>} rewrites
 * @property {number} compliantScriptsWithThePattern   scripts that compile and still contain the pattern (expected 0)
 */

/**
 * Compile everything once, in one instance, then dispose it.
 * @param {import('../support/fixtures.js').CorpusFixture} corpus
 * @returns {Promise<Scan>}
 */
async function scanCorpus(corpus) {
  const manifest = corpus.manifest();
  if (!manifest) throw new Error('tests/corpus.manifest.json is missing: run node tools/make-corpus-manifest.mjs');
  const extracted = extractCorpus(corpus.root, manifest.wmp);
  const scripts = extracted.archives.flatMap((a) => a.scripts.map((s) => ({ archive: a.archive, ...s })));
  const handlers = extracted.archives.flatMap((a) => a.handlers.map((h) => ({ archive: a.archive, ...h })));

  const inst = await newInstance({ memoryLimitBytes: 256 * 1024 * 1024 });
  try {
    /** @type {Scan['scriptFailures']} */
    const scriptFailures = [];
    /** @type {Scan['rewrites']} */
    const rewrites = [];
    let compliantScriptsWithThePattern = 0;
    for (const s of scripts) {
      const where = `${s.archive}!${s.file}`;
      const r = inst.compile(s.source, where);
      const statements = [...s.source.matchAll(CALL_ASSIGNMENT)].length;
      if (r.ok) {
        if (statements) compliantScriptsWithThePattern++;
        continue;
      }
      scriptFailures.push({ archive: s.archive, file: s.file, where, source: s.source, message: `${r.error.name}: ${r.error.message}` });
      rewrites.push({ where, statements, rewrittenCompiles: inst.compile(rewriteCallAssignments(s.source), where).ok });
    }

    /** @type {Scan['handlerFailures']} */
    const handlerFailures = [];
    let asIs = 0;
    let rescued = 0;
    for (const h of handlers) {
      const r = compileHandler(inst, h.src);
      if (!r.ok) handlerFailures.push({ archive: h.archive, tag: h.tag, attr: h.attr, message: r.message });
      else if (r.via === 'as-is') asIs++;
      else rescued++;
    }

    /** @type {Map<string, number>} */
    const buckets = new Map();
    for (const f of handlerFailures) buckets.set(f.message, (buckets.get(f.message) ?? 0) + 1);
    console.info(
      `RG0-REPORT item 7 (${VARIANT_NAME}): ${extracted.archives.length} distinct archives; ` +
        `${scripts.length} scripts, ${scripts.length - scriptFailures.length} compile, ${scriptFailures.length} fail [${scriptFailures.map((f) => f.where).join('; ')}]; ` +
        `${handlers.length} handlers (${handlers.filter((h) => h.src === '').length} empty): ${asIs} compile as-is, ${rescued} only after stripping one label, ` +
        `${handlerFailures.length} fail [${[...buckets].map(([m, n]) => `${n} x ${m}`).join('; ')}] in ${[...new Set(handlerFailures.map((f) => f.archive))].join(', ')}`,
    );

    return {
      corpus: extracted, scripts: scripts.length, handlers: handlers.length, empty: handlers.filter((h) => h.src === '').length,
      scriptFailures, handlerFailures, asIs, rescued, rewrites, compliantScriptsWithThePattern,
    };
  } finally {
    inst.unload();
  }
}

describeCorpus('realm gate RG0 item 7: the corpus compiles in QuickJS', (corpus) => {
  /** @type {Promise<Scan>|undefined} */
  let scanned;
  const scan = () => (scanned ??= scanCorpus(corpus));

  it(`reads the pinned inputs: ${EXPECTED.archives} distinct archives, ${EXPECTED.scripts} scripts, ${EXPECTED.handlers.toLocaleString('en')} handlers`, async () => {
    const s = await scan();
    expect(s.corpus.hashMismatches).toEqual([]);
    expect(s.corpus.archives.length).toBe(EXPECTED.archives);
    expect(s.scripts).toBe(EXPECTED.scripts);
    expect(s.handlers).toBe(EXPECTED.handlers);
    expect(s.empty).toBe(EXPECTED.empty);
  });

  it(`handlers: all ${EXPECTED.handlers.toLocaleString('en')} compile the D1 way, with exactly the ${EXPECTED.failures} known failures`, async () => {
    const s = await scan();
    expect(s.asIs + s.rescued + s.handlerFailures.length).toBe(EXPECTED.handlers);
    expect(s.handlerFailures.length).toBe(EXPECTED.failures);
    expect([...new Set(s.handlerFailures.map((f) => f.archive))]).toEqual([KNOWN_FAILURES.archive]);
    expect(s.handlerFailures.map((f) => f.attr).sort()).toEqual(KNOWN_FAILURES.attrs);
  });

  // G1 ruling: the card's "all 219 compile" was red for these 7 files, and the loader will rewrite their one
  // offending statement (E R20), so the gate pins the exact list instead. W2.2 item 10 flips this to
  // 219 of 219 and empties KNOWN_SCRIPT_FAILURES; until then any change to the list, in either direction,
  // is a finding.
  it(`scripts: ${EXPECTED.scripts - KNOWN_SCRIPT_FAILURES.length} of ${EXPECTED.scripts} compile; exactly the ${KNOWN_SCRIPT_FAILURES.length} pinned call-assignment files do not (W2.2 item 10 flips this to ${EXPECTED.scripts}/${EXPECTED.scripts})`, async () => {
    const s = await scan();
    const failed = s.scriptFailures
      .map((f) => /** @type {const} */ ([f.archive, f.file]))
      .sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]));
    expect(failed).toEqual(KNOWN_SCRIPT_FAILURES);
    expect(s.scripts - s.scriptFailures.length).toBe(EXPECTED.scripts - KNOWN_SCRIPT_FAILURES.length);
  });

  it('the script failures are one pattern, assignment to a call expression, and rewriting it makes every script compile', async () => {
    const s = await scan();
    expect(s.scriptFailures.length).toBe(KNOWN_SCRIPT_FAILURES.length);
    expect(new Set(s.scriptFailures.map((f) => f.message))).toEqual(new Set(['SyntaxError: invalid assignment left-hand side']));
    expect(s.rewrites.every((r) => r.rewrittenCompiles)).toBe(true);
    expect(s.rewrites.map((r) => r.statements)).toEqual(s.rewrites.map(() => 1));    // one statement per file
    expect(s.compliantScriptsWithThePattern).toBe(0);                                  // the pattern never appears in a script that compiles
  });
});
