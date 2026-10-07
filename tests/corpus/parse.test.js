// @ts-check
// `npm run corpus -- parse` (WAVES W1.2 acceptance 2). Decodes and scans the definition file of every
// distinct WMP archive in skins/wmp and checks the numbers `survey 2.1` and `survey 2.2` give. It
// prints the counts and writes them, numbers only, to docs/coverage/corpus-parse.txt. The suite skips
// when skins/ is absent (WAVES global rule 4).
//
// It reads archives with fflate directly rather than through the W1.1 reader, so it does not depend
// on a task that runs beside this one: only the `.wms` entries are inflated, by name.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { REPO_ROOT, describeCorpus } from '../support/fixtures.js';

const OUT = join(REPO_ROOT, 'docs', 'coverage', 'corpus-parse.txt');

// The two archives with more than one `.wms` (U-17). Which one is the skin's definition is
// `pickDefinition`'s job (W2.1, acceptance 3 names these two); this suite only needs the answer, so
// it keys on the file name and falls back to the stem rule and then the larger file.
const U17_PICKS = new Set(['nautical.wms', 'extremesports.wms']);

// survey 2.1 and 2.2, distinct column; the diagnostic codes are this scanner's own.
const EXPECTED_ENCODINGS = new Map([['utf-16le', 72], ['utf-8', 10], ['ascii', 27], ['cp1252', 86]]);
const EXPECTED_DIAGNOSTIC_SKINS = new Map([
  ['duplicate-attribute', 67],
  ['duplicate-attribute-case', 8],
  ['missing-whitespace', 22],
  ['end-tag-case', 12],
  ['junk-after-root', 1],
]);

// The same two tables for the [raw] column (all 342 archives, duplicates counted).
const RAW_ENCODINGS = new Map([['utf-16le', 120], ['utf-8', 19], ['ascii', 44], ['cp1252', 159]]);
const RAW_DIAGNOSTIC_SKINS = new Map([
  ['duplicate-attribute', 123],
  ['duplicate-attribute-case', 16],
  ['missing-whitespace', 39],
  ['end-tag-case', 19],
  ['junk-after-root', 1],
]);

/**
 * @typedef {Object} Archive
 * @property {string} name
 * @property {string} sha          SHA-256 of the archive
 * @property {Array<{ base: string, bytes: Uint8Array }>} wms   every `.wms` entry, in archive order
 */

/**
 * @typedef {Object} Tally
 * @property {number} files        `.wms` files scanned
 * @property {number} themeWithView  files whose root is a THEME with a VIEW child
 * @property {Map<string, number>} encodings
 * @property {Map<string, number>} diagnosticSkins   code -> number of files carrying it
 * @property {string[]} notThemeWithView
 */

/** @param {import('../support/fixtures.js').CorpusFixture} corpus @returns {{ archives: Archive[], unreadable: string[] }} */
function loadArchives(corpus) {
  /** @type {Archive[]} */
  const archives = [];
  /** @type {string[]} */
  const unreadable = [];
  for (const entry of corpus.archives('wmp')) {
    const bytes = corpus.read(entry);
    const sha = createHash('sha256').update(bytes).digest('hex');
    try {
      // fflate does not check the local-header signature, which is how the three corpus archives
      // with a damaged one still open.
      const files = unzipSync(bytes, { filter: (f) => /\.wms$/i.test(f.name) && (f.compression === 0 || f.compression === 8) });
      archives.push({
        name: entry.name,
        sha,
        wms: Object.entries(files).map(([name, data]) => ({ base: (name.split(/[\\/]/).pop() ?? name).toLowerCase(), bytes: data })),
      });
    } catch (e) {
      unreadable.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { archives, unreadable };
}

/** One archive per SHA-256, the first in name order, as the survey's "distinct" column counts. @param {Archive[]} all */
function distinct(all) {
  /** @type {Map<string, Archive>} */
  const bySha = new Map();
  for (const a of all) if (!bySha.has(a.sha)) bySha.set(a.sha, a);
  return [...bySha.values()];
}

/** @param {Archive} a @returns {{ base: string, bytes: Uint8Array } | undefined} */
function definitionOf(a) {
  if (a.wms.length <= 1) return a.wms[0];
  const stem = a.name.replace(/\.[^.]+$/, '').toLowerCase();
  return a.wms.find((f) => U17_PICKS.has(f.base))
    ?? a.wms.find((f) => f.base === `${stem}.wms`)
    ?? [...a.wms].sort((x, y) => y.bytes.length - x.bytes.length)[0];
}

/** @param {Array<{ name: string, bytes: Uint8Array }>} files @returns {Tally} */
function tally(files) {
  /** @type {Tally} */
  const t = { files: files.length, themeWithView: 0, encodings: new Map(), diagnosticSkins: new Map(), notThemeWithView: [] };
  for (const f of files) {
    const { text, encoding } = decodeText(f.bytes);
    t.encodings.set(encoding, (t.encodings.get(encoding) ?? 0) + 1);
    const { root, diagnostics } = scanWms(text);
    if (root?.tag === 'theme' && root.children.some((c) => c.tag === 'view')) t.themeWithView++;
    else t.notThemeWithView.push(f.name);
    for (const code of new Set(diagnostics.map((d) => d.code))) t.diagnosticSkins.set(code, (t.diagnosticSkins.get(code) ?? 0) + 1);
  }
  return t;
}

/** @param {Map<string, number>} m @returns {Array<[string, number]>} sorted by key, so the file is stable */
const sorted = (m) => [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

describeCorpus('corpus parse: skins/wmp', (corpus) => {
  /** @type {Archive[]} */
  let all = [];
  /** @type {string[]} */
  let unreadable = [];
  /** @type {Tally} */
  let primary;
  /** @type {Tally} */
  let everyWms;
  /** @type {Tally} */
  let raw;
  /** @type {Archive[]} */
  let uniq = [];

  beforeAll(() => {
    ({ archives: all, unreadable } = loadArchives(corpus));
    uniq = distinct(all);
    primary = tally(uniq.flatMap((a) => { const d = definitionOf(a); return d ? [{ name: `${a.name}/${d.base}`, bytes: d.bytes }] : []; }));
    everyWms = tally(uniq.flatMap((a) => a.wms.map((f) => ({ name: `${a.name}/${f.base}`, bytes: f.bytes }))));
    // The survey's [raw] column: every archive, duplicates included.
    raw = tally(all.flatMap((a) => { const d = definitionOf(a); return d ? [{ name: `${a.name}/${d.base}`, bytes: d.bytes }] : []; }));

    /** @param {Tally} t */
    const lines = (t) => [...sorted(t.encodings).map(([k, v]) => `encoding ${k} ${v}`), ...sorted(t.diagnosticSkins).map(([k, v]) => `diagnostic ${k} ${v}`)];
    const text = [
      '# corpus-parse: numbers from `npm run corpus -- parse` (tests/corpus/parse.test.js). No names, no art.',
      '# distinct = one definition .wms per distinct archive SHA-256; raw = one per archive file.',
      `wmp_archives ${all.length}`,
      `wmp_distinct ${uniq.length}`,
      `distinct_definition_files ${primary.files}`,
      `distinct_theme_root_with_view ${primary.themeWithView}`,
      `distinct_all_wms_files ${everyWms.files}`,
      `distinct_all_wms_theme_root_with_view ${everyWms.themeWithView}`,
      ...lines(primary).map((l) => `distinct ${l}`),
      `raw_definition_files ${raw.files}`,
      `raw_theme_root_with_view ${raw.themeWithView}`,
      ...lines(raw).map((l) => `raw ${l}`),
      '',
    ].join('\n');
    mkdirSync(join(REPO_ROOT, 'docs', 'coverage'), { recursive: true });
    writeFileSync(OUT, text);
    console.log(text);
  });

  it('every archive opens and every distinct archive has a definition file', () => {
    expect(unreadable).toEqual([]);
    expect(all.length).toBe(342);
    expect(uniq.length).toBe(195);
    expect(uniq.filter((a) => a.wms.length === 0).map((a) => a.name)).toEqual([]);
  });

  it('195/195 distinct definition files give a THEME root with at least one VIEW', () => {
    expect(primary.files).toBe(195);
    expect(primary.notThemeWithView).toEqual([]);
    expect(primary.themeWithView).toBe(195);
  });

  it('so does every one of the 197 .wms files in those archives', () => {
    expect(everyWms.files).toBe(197);
    expect(everyWms.notThemeWithView).toEqual([]);
  });

  it('encoding census: 72 UTF-16LE, 10 UTF-8 BOM, 27 ASCII, 86 cp1252, nothing else (survey 2.1)', () => {
    expect(sorted(primary.encodings)).toEqual(sorted(EXPECTED_ENCODINGS));
  });

  it('diagnostics by distinct skin: 67 duplicates, 8 case-variant, 22 missing whitespace, 12 end-tag case, 1 junk (survey 2.2)', () => {
    expect(sorted(primary.diagnosticSkins)).toEqual(sorted(EXPECTED_DIAGNOSTIC_SKINS));
  });

  it('the survey\'s raw column holds too: 120/19/44/159 encodings; 123, 16, 39, 19 and 1 skins with each repair', () => {
    expect(raw.themeWithView).toBe(342);
    expect(sorted(raw.encodings)).toEqual(sorted(RAW_ENCODINGS));
    expect(sorted(raw.diagnosticSkins)).toEqual(sorted(RAW_DIAGNOSTIC_SKINS));
  });

  it('those are the only repairs the corpus needs: no other diagnostic code appears in any of the 197 files', () => {
    const others = sorted(everyWms.diagnosticSkins).filter(([code]) => !EXPECTED_DIAGNOSTIC_SKINS.has(code));
    expect(others).toEqual([]);
  });

  it('the archives on disk are the ones tests/corpus.manifest.json pins', () => {
    const manifest = corpus.manifest();
    expect(manifest, 'tests/corpus.manifest.json is missing').not.toBeNull();
    const onDisk = new Map(all.map((a) => [a.name, a.sha]));
    expect(onDisk).toEqual(/** @type {NonNullable<typeof manifest>} */ (manifest).wmp);
  });
});

describe('corpus parse: negative checks that need no art', () => {
  it('the suite counts distinct archives by SHA-256, not by name', () => {
    /** @type {Archive} */
    const a = { name: 'a.wmz', sha: 'x', wms: [] };
    expect(distinct([a, { ...a, name: 'b.wmz' }, { ...a, name: 'c.wmz', sha: 'y' }]).map((x) => x.name)).toEqual(['a.wmz', 'c.wmz']);
  });

  it('picks the U-17 file, then the stem, then the larger one', () => {
    const f = (/** @type {string} */ base, /** @type {number} */ n) => ({ base, bytes: new Uint8Array(n) });
    expect(definitionOf({ name: 'Sports.wmz', sha: '', wms: [f('saltmine.wms', 9), f('extremesports.wms', 1)] })?.base).toBe('extremesports.wms');
    expect(definitionOf({ name: 'X.wmz', sha: '', wms: [f('a.wms', 9), f('x.wms', 1)] })?.base).toBe('x.wms');
    expect(definitionOf({ name: 'X.wmz', sha: '', wms: [f('a.wms', 1), f('b.wms', 9)] })?.base).toBe('b.wms');
    expect(definitionOf({ name: 'X.wmz', sha: '', wms: [] })).toBeUndefined();
  });
});
