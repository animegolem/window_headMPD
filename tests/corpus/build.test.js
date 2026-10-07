// @ts-check
// `npm run corpus -- build` (WAVES W2.1 acceptance 3). Opens every distinct WMP archive in
// skins/wmp, picks its definition file, scans it and runs the literal pass, then checks what the
// plan promises and prints the numbers O compares against `survey`. The suite skips when skins/ is
// absent (WAVES global rule 4). Nothing is written to the repository: the report goes to the console.
//
//   hard: 195 distinct archives, 195 builds that do not throw, every one with a view, Nautical picks
//         Nautical.wms and Sports picks ExtremeSports.wms, no structural cap is hit anywhere (E §10
//         says the caps clear the corpus), and the reference counts below.
//   reference counts (survey 3.2): references are counted by `collectReferences`. The case-folded
//         resolutions match the survey exactly (716 in 62 skins). The unresolved references come to
//         89 in 45 skins where the survey says 90 in 46, and the gap is one skin, Raptor.wmz. One of
//         its elements has thumbImage="ball_thumb.bmp" followed by thumbImage="Eqbutton.bmp";
//         ball_thumb.bmp is not in the archive, and the last-wins rule (E D5 rule 4) drops the
//         first value. The survey collected attributes before collapsing duplicates, so it counted
//         that reference. Raptor has no other unresolved reference and is not among the 45
//         measured skins, which accounts for exactly +1 reference and +1 skin. The count here is
//         the right one under D5, so MEASURED stays pinned at 89 in 45 and the printed report
//         names the cause.
//
// Run it with `--silent=false` to see the printed report: `npx vitest run --project corpus build
// --silent=false`.

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { readZip } from '../../src/engine/archive/zip.js';
import { probeImage } from '../../src/engine/image/probe.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { collectReferences, pickDefinition, unresolvedReferences } from '../../src/engine/wms/select.js';
import { describeCorpus } from '../support/fixtures.js';

/** @typedef {import('../../src/engine/contracts').ThemeModel} ThemeModel */

const SURVEY = { distinct: 195, unresolvedRefs: 90, unresolvedSkins: 46, foldedRefs: 716, foldedSkins: 62 };
// What this count measures on the corpus as of the survey's own archive set.
const MEASURED = { unresolvedRefs: 89, unresolvedSkins: 45, foldedRefs: 716, foldedSkins: 62 };

/** @param {string} ref */
const baseName = (ref) => ref.replaceAll('\\', '/').split('/').pop() ?? ref;

/**
 * @typedef {Object} Row
 * @property {string} name
 * @property {string} sha
 * @property {string | null} wms
 * @property {string | null} reason
 * @property {number} views
 * @property {number} elements
 * @property {number} unresolved
 * @property {number} folded
 * @property {Map<string, number>} codes   diagnostic code -> count
 * @property {string | null} threw
 */

/** @type {Row[]} */
let rows = [];
/** @type {string[]} */
let unreadable = [];
/** @type {Array<{ name: string, wms: string[], pick: string | null }>} */
let multi = [];

describeCorpus('corpus build: skins/wmp', (corpus) => {
  beforeAll(async () => {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const entry of corpus.archives('wmp')) {
      const bytes = corpus.read(entry);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (seen.has(sha)) continue; // the survey's "distinct" column: one archive per SHA-256, first in name order
      seen.add(sha);

      /** @type {Row} */
      const row = { name: entry.name, sha, wms: null, reason: null, views: 0, elements: 0, unresolved: 0, folded: 0, codes: new Map(), threw: null };
      rows.push(row);
      try {
        const vfs = await openVfs(bytes, entry.name);
        const entryNames = new Map(readZip(bytes).entries.map((e) => [e.key, e.name]));
        const wmsKeys = vfs.list('.wms');
        const pick = pickDefinition(vfs);
        if (wmsKeys.length > 1) multi.push({ name: entry.name, wms: wmsKeys, pick: pick?.wms ?? null });
        if (!pick) { row.threw = 'no .wms'; continue; }
        row.wms = pick.wms;
        row.reason = pick.reason;

        const { root } = scanWms(decodeText(/** @type {Uint8Array} */ (vfs.read(pick.wms))).text);
        for (const ref of collectReferences(root)) {
          const key = vfs.resolve(ref);
          if (key === null) { row.unresolved++; continue; }
          const actual = entryNames.get(key);
          if (actual !== undefined && baseName(ref) !== baseName(actual)) row.folded++;
        }
        // the same count the picker uses must agree with this one
        expect(unresolvedReferences(vfs, collectReferences(root)).length).toBe(row.unresolved);

        /** @type {Map<string, import('../../src/engine/contracts').ImageProbe | null>} */
        const probed = new Map();
        const theme = buildTheme(/** @type {NonNullable<typeof root>} */ (root), vfs, {
          probe: (ref) => {
            const key = vfs.resolve(ref) ?? ref;
            if (!probed.has(key)) { const b = vfs.read(ref); probed.set(key, b ? probeImage(b) : null); }
            return probed.get(key) ?? null;
          },
        });
        row.views = theme.views.length;
        row.elements = theme.views.reduce((n, v) => n + v.elements.length, 0);
        for (const d of theme.diagnostics) row.codes.set(d.code, (row.codes.get(d.code) ?? 0) + 1);
      } catch (e) {
        row.threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        unreadable.push(`${entry.name}: ${row.threw}`);
      }
    }
  });

  it('builds all 195 distinct skins without throwing, each with at least one view', () => {
    expect(rows).toHaveLength(SURVEY.distinct);
    expect(unreadable).toEqual([]);
    expect(rows.filter((r) => r.threw !== null).map((r) => `${r.name}: ${r.threw}`)).toEqual([]);
    expect(rows.filter((r) => r.views < 1).map((r) => r.name)).toEqual([]);
  });

  it('picks Nautical.wms for Nautical and ExtremeSports.wms for Sports (U-17)', () => {
    expect(multi.map((m) => m.name).sort()).toEqual(['Nautical.wmz', 'Sports.wmz']);
    for (const m of multi) {
      const expected = m.wms.includes('nautical.wms') ? 'nautical.wms' : 'extremesports.wms';
      expect(m.pick, `${m.name} (${m.wms.join(', ')})`).toBe(expected);
    }
    const reasons = Object.fromEntries(rows.filter((r) => multi.some((m) => m.name === r.name)).map((r) => [r.name, r.reason]));
    // eslint-disable-next-line no-console
    console.log('W2.1 corpus: multi-wms picks', JSON.stringify(reasons));
    // every other archive has one definition file
    expect(rows.filter((r) => !multi.some((m) => m.name === r.name)).every((r) => r.reason === 'only')).toBe(true);
  });

  it('hits no structural cap anywhere (E §10: the caps clear the corpus)', () => {
    /** @type {string[]} */
    const hits = [];
    for (const r of rows) for (const [code, n] of r.codes) if (code.startsWith('cap-')) hits.push(`${r.name}: ${code} x${n}`);
    expect(hits).toEqual([]);
  });

  it('counts references the way survey 3.2 did', () => {
    const unresolved = rows.filter((r) => r.unresolved > 0);
    const folded = rows.filter((r) => r.folded > 0);
    const measured = {
      unresolvedRefs: unresolved.reduce((n, r) => n + r.unresolved, 0),
      unresolvedSkins: unresolved.length,
      foldedRefs: folded.reduce((n, r) => n + r.folded, 0),
      foldedSkins: folded.length,
    };
    const lines = [
      `W2.1 corpus: references (survey 3.2 vs measured)`,
      `  unresolved refs   survey ${SURVEY.unresolvedRefs}   measured ${measured.unresolvedRefs}   difference ${measured.unresolvedRefs - SURVEY.unresolvedRefs}`,
      `  unresolved skins  survey ${SURVEY.unresolvedSkins}   measured ${measured.unresolvedSkins}   difference ${measured.unresolvedSkins - SURVEY.unresolvedSkins}`,
      `  case-folded refs  survey ${SURVEY.foldedRefs}  measured ${measured.foldedRefs}  difference ${measured.foldedRefs - SURVEY.foldedRefs}`,
      `  case-folded skins survey ${SURVEY.foldedSkins}    measured ${measured.foldedSkins}    difference ${measured.foldedSkins - SURVEY.foldedSkins}`,
      '  the survey is one reference and one skin higher: Raptor.wmz has thumbImage="ball_thumb.bmp" (not in the',
      '  archive) then thumbImage="Eqbutton.bmp" on one element; the last-wins rule (E D5 rule 4) drops the first,',
      '  and the survey counted it before collapsing duplicates.',
      '  per-skin unresolved (archive: refs):',
      ...unresolved.map((r) => `    ${r.name}: ${r.unresolved}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(measured).toEqual(MEASURED);
  });

  it('reports what the build said, as numbers', () => {
    /** @type {Map<string, { skins: number, total: number }>} */
    const codes = new Map();
    for (const r of rows) {
      for (const [code, n] of r.codes) {
        const c = codes.get(code) ?? { skins: 0, total: 0 };
        c.skins++;
        c.total += n;
        codes.set(code, c);
      }
    }
    const counts = rows.map((r) => r.elements).sort((a, b) => a - b);
    const at = (/** @type {number} */ q) => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))];
    const lines = [
      'W2.1 corpus: build summary',
      `  skins ${rows.length}, views ${rows.reduce((n, r) => n + r.views, 0)}, elements ${counts.reduce((a, b) => a + b, 0)}`,
      `  elements per skin: median ${at(0.5)}, p90 ${at(0.9)}, max ${counts[counts.length - 1]}`,
      '  diagnostics by code (skins / total):',
      ...[...codes].sort().map(([code, c]) => `    ${code}: ${c.skins} / ${c.total}`),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    // Nothing in the corpus should be an outright error from the builder.
    expect(rows.filter((r) => [...r.codes.keys()].some((c) => c === 'no-root' || c === 'no-view')).map((r) => r.name)).toEqual([]);
  });
});

// A suite that skips still needs one visible test, so the skip reason shows up in the report.
describe('corpus build (module)', () => {
  it('exports nothing it should not: the survey numbers are the plan\'s, the measured ones are pinned', () => {
    expect(SURVEY.unresolvedRefs - MEASURED.unresolvedRefs).toBe(1);
  });
});
