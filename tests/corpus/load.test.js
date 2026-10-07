// @ts-check
// `npm run corpus -- load` (WAVES W5.4 acceptance 1, the Node stage; E D6.7 and D10.9 criterion 6). Every
// distinct WMP skin goes through the real engine on the test host, headless, on the manual clock, with the
// real budgets (tools/corpus.mjs): archive, select, scan, build, realm, layout, bindings and `onload` in
// `load` and `attach`, then a scripted minute of play, pause, seek, resume, next and stop, then a moveTo
// probe. The Chromium stage is `npm run skinlab -- corpus` (tools/skinlab/cmd-corpus.mjs).
//
//   hard: all 195 distinct skins load and attach; zero host exceptions (nothing thrown out of load, attach,
//         the run or dispose, zero `runtime-error` diagnostics, nothing uncaught at process level); R0
//         (the owner's Headspace.wmz, outside skins/), R1 Miniplayer and R2 aoe have no realm hard fault
//         and do not unload; no element box over the canvas cap.
//   reported, not blocking: the hard-fault list of the long tail, size-less subviews, views that never go
//         quiet, load times, the ledger. The numbers go to docs/coverage/corpus-load.txt and ledger.md.
//
// The first block runs without art: it checks the runner and the renderers on synthetic skins, including
// the member names `__proto__` and `constructor` (global rule 5: the ledger aggregation is a lookup
// keyed by skin text), and the Chromium stage's row verdicts, its report and its hang handling
// (`rowFailures`, `renderChromiumReport`, `mountOne` against a stand-in page). The second block needs
// skins/ and skips, never fails, without it.
//
// Run it with `--silent=false` to see the report: `npx vitest run --project corpus load --silent=false`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEDGER_FILE, LOAD_FILE, PERPETUAL_NOTES, SURVEY_DISTINCT, aggregateLedger, collectDiagnostics, distinctArchives, gateFailures,
  implIndex, implOfEntry, perpetualNote, renderLedger, renderNodeReport, rungOf, runNodeStage, runSkin, staticDemand, summarize,
  updateSection, writeNodeReports,
} from '../../tools/corpus.mjs';
import { PageHang, mountOne, probe, renderChromiumReport, rowFailures } from '../../tools/skinlab/cmd-corpus.mjs';
import { describeCorpus, headspaceFixture } from '../support/fixtures.js';
import { buildZip } from '../support/zip-writer.js';

/** @typedef {import('../../tools/corpus.mjs').Row} Row */
/** @typedef {import('../../tools/corpus.mjs').StageResult} StageResult */

const VIEW = 'id="v" width="200" height="100" backgroundColor="none" titleBar="false"';

/** @param {string} body @param {string} [viewAttrs] */
const wmsOf = (body, viewAttrs = VIEW) => `<THEME>\r\n<VIEW ${viewAttrs}>\r\n${body}\r\n</VIEW>\r\n</THEME>\r\n`;

/** @param {string} wms @param {string} [js] @returns {Uint8Array} */
const zipOf = (wms, js) => buildZip([{ name: 'skin.wms', data: wms }, ...(js === undefined ? [] : [{ name: 'skin.js', data: js }])]);

/** A stage result around hand-made rows. @param {Row[]} rows @param {Partial<StageResult>} [more] @returns {StageResult} */
const stageOf = (rows, more = {}) => ({ archives: rows.length, rows, r0: null, uncaught: [], wallMs: 1, ...more });

/** A row with nothing wrong, for a test to damage in one place. @param {Partial<Row>} [over] @returns {Row} */
const cleanRow = (over = {}) => ({
  name: 'x.wmz', sha: 'a'.repeat(64), rung: null, loaded: true, threw: null, loadMs: 1, attachMs: 1, runMs: 1, views: 1, elements: 1,
  viewSize: { w: 200, h: 100 }, switches: 0, switchFaults: 0,
  health: { soft: 0, hard: 0, unloaded: false }, hardFaults: [], faultUnloads: 0, runtimeErrors: 0, runtimeErrorSites: [],
  diagnostics: new Map(), denied: 0, quiet: true, subviews: 0, sizeless: 0, clampHits: 0, moveTo: { driven: 0, landed: 0 }, ledger: [], ...over,
});

describe('the corpus runner on synthetic skins (no art)', () => {
  it('runs a well-behaved skin through load, attach, the scripted minute and the moveTo probe', async () => {
    const wms = wmsOf(
      `<subview id="s" left="0" top="0" width="40" height="30"/>
       <text id="t" left="0" top="40" width="100" height="14" value="wmpprop:player.status"/>`,
      `${VIEW} onload="theme.logString('up');"`,
    );
    const row = await runSkin(zipOf(wms), 'ok.wmz');
    expect(row.threw).toBeNull();
    expect(row.loaded).toBe(true);
    expect(row.views).toBe(1);
    expect(row.elements).toBe(3);                                     // the view, the subview and the text
    expect(row.health).toEqual({ soft: 0, hard: 0, unloaded: false });
    expect(row.runtimeErrors).toBe(0);
    expect(row.quiet).toBe(true);
    expect(row.moveTo.driven).toBe(2);
    expect(row.moveTo.landed).toBe(2);
    expect(row.sizeless).toBe(0);
    expect(row.clampHits).toBe(0);
    expect(gateFailures(stageOf([row]))).toEqual([]);
  });

  it('counts size-less subviews and over-cap boxes, and ledgers what a script reaches', async () => {
    const wms = wmsOf(
      `<subview id="s" left="0" top="0" width="40" height="30"/>
       <subview id="flat" left="0" top="0"/>
       <subview id="big" left="0" top="0" width="5000" height="10"/>`,
      `${VIEW} onload="touch();"`,
    );
    const js = 'function touch() { player.controls.fastForward(); var b = player.network.bandwidth; player.nonsense = 1; }';
    const row = await runSkin(zipOf(wms, js), 'reach.wmz');
    expect(row.subviews).toBe(3);
    expect(row.sizeless).toBe(1);
    expect(row.clampHits).toBe(1);
    const reached = new Map(row.ledger.map((e) => [`${e.kind}:${e.api}`, e.count]));
    expect(reached.get('stub:player.controls.fastForward')).toBe(1);
    expect(reached.get('stub:player.network.bandwidth')).toBe(1);
    expect(reached.get('unknown-member:player.nonsense')).toBe(1);
    const s = summarize(stageOf([row]));
    expect(s.sizeless).toBe(1);
    expect(s.clampHits).toBe(1);
  });

  it('keeps member names that are Object.prototype keys as plain names (global rule 5)', async () => {
    const wms = wmsOf('', `${VIEW} onload="touch();"`);
    const js = 'function touch() { var a = player.constructor; var b = player.__proto__; var c = theme.constructor; }';
    const row = await runSkin(zipOf(wms, js), 'proto.wmz');
    const apis = row.ledger.map((e) => e.api);
    expect(apis).toEqual(expect.arrayContaining(['player.constructor', 'player.__proto__', 'theme.constructor']));

    // The aggregate is a Map: a ledger entry named `__proto__` or `constructor` is a row, not a property.
    const rows = [
      cleanRow({ ledger: [{ api: '__proto__', kind: 'unknown-member', count: 2 }, { api: 'constructor', kind: 'stub', count: 1 }] }),
      cleanRow({ ledger: [{ api: '__proto__', kind: 'unknown-member', count: 3 }, { api: 'toString', kind: 'unknown-member', count: 1 }] }),
    ];
    const agg = aggregateLedger(rows);
    expect(agg).toBeInstanceOf(Map);
    expect(agg.get('unknown-member\u0000__proto__')).toEqual({ api: '__proto__', kind: 'unknown-member', skins: 2, hits: 5 });
    expect(agg.get('stub\u0000constructor')).toEqual({ api: 'constructor', kind: 'stub', skins: 1, hits: 1 });
    expect(agg.size).toBe(3);

    // Neither the impl lookup nor the report treats them as members of Object.prototype.
    const impl = implIndex();
    expect(impl).toBeInstanceOf(Map);
    expect(implOfEntry(impl, { api: 'constructor', kind: 'stub' })).toBe('-');
    expect(implOfEntry(impl, { api: '__proto__', kind: 'stub' })).toBe('-');
    expect(implOfEntry(impl, { api: 'player.controls.fastForward', kind: 'stub' })).toBe('stub');
    const text = renderLedger(stageOf(rows));
    expect(text).toContain('| __proto__ | unknown-member | - | 2 | 5 |');
    expect(text).toContain('| constructor | stub | - | 1 | 1 |');
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    expect(/** @type {any} */ ({}).skins).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });

  it('reads static demand into a Map, so a row named __proto__ or constructor is a row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'headmpd-demand-'));
    try {
      const file = join(dir, 'api-frequency.csv');
      writeFileSync(file, [
        'kind,name,refs,skins,refs_all_archives',
        'object-model,__proto__,5,3,9',
        'object-model,player.controls.play,4,2,6',
        'element-method,constructor,2,2,2',
        'element-method,constructor,1,4,1',
        'implicit-method,toString,1,1,1',
        'wmploc-132,osmediaopen,1,1,1',
        '',
      ].join('\n'));
      const demand = staticDemand(file);
      expect(demand).toBeInstanceOf(Map);
      expect(demand.get('o:__proto__')).toBe(3);
      expect(demand.get('o:player.controls.play')).toBe(2);
      expect(demand.get('m:constructor')).toBe(4);               // the most skins over the rows of one method name
      expect(demand.get('m:toString')).toBe(1);
      expect(demand.has('o:osmediaopen')).toBe(false);
      expect(demand.size).toBe(4);
      expect(staticDemand(join(dir, 'missing.csv')).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a hard fault by category and blocks only on a ladder rung', async () => {
    const wms = wmsOf('', `${VIEW} onload="f();"`);
    const js = 'function g() { g(); } function f() { g(); }';
    const long = await runSkin(zipOf(wms, js), 'tail.wmz');
    expect(long.health.hard).toBeGreaterThan(0);
    expect(long.hardFaults).toEqual(['handler stack']);
    expect(gateFailures(stageOf([long]))).toEqual([]);                // the long tail is reported, not blocking

    const rung = await runSkin(zipOf(wms, js), 'Miniplayer.wmz', { rung: 'R1' });
    const failures = gateFailures(stageOf([rung]));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^R1 Miniplayer\.wmz: realm hard faults: handler stack/);
    // The report carries the category and no handler text.
    const text = renderNodeReport(stageOf([long, rung]));
    expect(text.join('\n')).toContain('handler stack');
    expect(text.join('\n')).not.toMatch(/\bg\(\)|\bf\(\)/);
  });

  it('flags a view that never goes quiet and does not call it an exception', async () => {
    const wms = wmsOf(
      '<subview id="s" left="0" top="0" width="10" height="10" onendmove="s.moveTo(left == 0 ? 50 : 0, 0, 100);"/>',
      `${VIEW} onload="s.moveTo(50, 0, 100);"`,
    );
    const row = await runSkin(zipOf(wms), 'loop.wmz');
    expect(row.quiet).toBe(false);
    expect(row.threw).toBeNull();
    expect(row.runtimeErrors).toBe(0);
    expect(gateFailures(stageOf([row]))).toEqual([]);
    expect(summarize(stageOf([row])).perpetual).toHaveLength(1);
  });

  it('follows a splash view that hands over with theme.currentViewID and counts the switch', async () => {
    // The pattern of 34 corpus skins: a splash or preview VIEW whose onload sets its size to 0 and names the real
    // one. Since 5F.6 the window switches: the view shown has area, and the switch is a `view-switch` diagnostic.
    const wms = `<THEME>\r\n<VIEW id="splash" width="120" height="80" backgroundColor="none" titleBar="false" onload="theme.currentViewID = 'real'; view.width = 0; view.height = 0;"/>\r\n`
      + '<VIEW id="real" width="200" height="100" backgroundColor="none" titleBar="false"/>\r\n</THEME>\r\n';
    const row = await runSkin(zipOf(wms), 'splash.wmz');
    expect(row.threw).toBeNull();
    expect(row.views).toBe(2);
    expect(row.viewSize).toEqual({ w: 200, h: 100 });
    expect(row.switches).toBe(1);
    expect(row.switchFaults).toBe(0);
    expect(row.ledger.map((e) => e.api)).not.toContain('theme.currentViewID');   // a hand-over is not a ledger row
    const stage = stageOf([row]);
    expect(summarize(stage).collapsed).toEqual([]);
    expect(summarize(stage)).toMatchObject({ switches: 1, switchSkins: 1, switchFaults: 0 });
    const text = renderNodeReport(stage).join('\n');
    expect(text).toMatch(/view switches \(5F\.6:[^)]*\)[^:]*: 1 in 1 skins/);
    expect(text).toMatch(/views shown with no area after the scripted run[^:]*: 0$/m);
    expect(text).not.toMatch(/phase 1 does not make|wrote theme\.currentViewID/);
  });

  it('lists a view that has no area at the end, and a hand-over loop that the cap stops', async () => {
    const lone = await runSkin(zipOf(wmsOf('', `${VIEW} onload="view.width = 0; view.height = 0;"`)), 'lone.wmz');
    expect(lone.viewSize).toEqual({ w: 0, h: 0 });
    expect(lone.switches).toBe(0);
    expect(summarize(stageOf([lone])).collapsed.map((r) => r.name)).toEqual(['lone.wmz']);
    expect(renderNodeReport(stageOf([lone])).join('\n')).toMatch(/lone\.wmz \(.*\): 0x0, 0 view switches/);

    // Two views that name each other on load: the engine stops at four switches a second (5F.6).
    const wms = '<THEME>\r\n<VIEW id="a" width="50" height="50" backgroundColor="none" titleBar="false" onload="theme.currentViewID = \'b\';"/>\r\n'
      + '<VIEW id="b" width="60" height="60" backgroundColor="none" titleBar="false" onload="theme.currentViewID = \'a\';"/>\r\n</THEME>\r\n';
    const loop = await runSkin(zipOf(wms), 'loop-views.wmz');
    expect(loop.threw).toBeNull();
    expect(loop.switches).toBeGreaterThan(0);
    expect(loop.switchFaults).toBeGreaterThan(0);
    const stage = stageOf([loop]);
    expect(summarize(stage).switchFaultSkins.map((r) => r.name)).toEqual(['loop-views.wmz']);
    expect(renderNodeReport(stage).join('\n')).toMatch(/hand-overs that did not happen[^:]*: \d+ in 1 skins\n  loop-views\.wmz \(.*\): \d+/);
  });

  it('counts a diagnostic once although the session and the runtime both keep it', async () => {
    const wms = wmsOf('', `${VIEW} onload="f();"`);
    const js = 'function g() { g(); } function f() { g(); }';
    const row = await runSkin(zipOf(wms, js), 'twice.wmz');
    // One distinct hard fault (the handler's stack), one diagnostic: not one per list that holds it.
    expect(row.hardFaults).toEqual(['handler stack']);
    expect(row.diagnostics.get('realm-hard-fault')).toBe(1);
    expect(summarize(stageOf([row])).codes.get('realm-hard-fault')).toBe(1);

    const shared = { code: 'runtime-error', severity: 'error', detail: 'x' };
    const own = { code: 'runtime-error', severity: 'error', detail: 'x' };       // equal text, another report
    const kept = collectDiagnostics([shared], [shared, own]);
    expect(kept).toEqual([shared, own]);
    expect(kept[0]).toBe(shared);
    expect(collectDiagnostics()).toEqual([]);
    expect(collectDiagnostics([], [shared])).toEqual([shared]);
  });

  it('says what restarts a view that never goes quiet, when the skin was read', async () => {
    expect(PERPETUAL_NOTES).toBeInstanceOf(Map);
    const lolla = 'a30ab1a76515'.padEnd(64, '0');
    expect(perpetualNote(lolla)).toMatch(/colour cycle/);
    expect(perpetualNote(lolla)).toMatch(/5F\.6/);
    expect(perpetualNote('3fd10ce48a4d')).toMatch(/pulse/);
    for (const key of ['__proto__', 'constructor', 'toString', '', 'ffffffffffff']) expect(perpetualNote(key), key).toBeUndefined();
    const busy = [
      cleanRow({ name: 'Lollapalooza.wmz', sha: lolla, quiet: false }),
      cleanRow({ name: 'other.wmz', sha: 'e'.repeat(64), quiet: false }),
      cleanRow({ name: 'calm.wmz', sha: 'c'.repeat(64) }),
    ];
    const text = renderNodeReport(stageOf(busy)).join('\n');
    expect(text).toContain('a tween that restarts itself): 2');
    expect(text).toMatch(/Lollapalooza\.wmz \(a30ab1a76515\): the main view's 500 ms timer/);
    expect(text).toContain('other.wmz (eeeeeeeeeeee): cause not looked at');
    expect(text).not.toContain('calm.wmz (cccccccccccc): ');
  });

  it('names soft-fault in the ledger header and says its hits are distinct reasons per site', () => {
    const rows = [cleanRow({ ledger: [{ api: 'handler v.onload', kind: 'soft-fault', count: 2, detail: 'TypeError' }, { api: 'queue', kind: 'soft-fault', count: 1 }] })];
    const text = renderLedger(stageOf(rows));
    const header = text.slice(0, text.indexOf('## Summary'));
    expect(header).toMatch(/Ledgered kinds:[^\n]*`soft-fault`/);
    expect(header).toMatch(/distinct reasons\s+per site, not occurrences/);
    expect(header).not.toMatch(/phase 1 reads|does not switch views/);
    expect(text).toContain('| soft-fault | 2 | 1 |');
    expect(text).toContain('| handler v.onload | soft-fault | - | 1 | 2 |');
    // the realm line of the node report says the other number is occurrences
    expect(renderNodeReport(stageOf(rows)).join('\n')).toMatch(/realm soft faults: 0 in 0 skins \(occurrences, the realm's own count; the ledger counts each reason once per site/);
  });

  it('counts fault calls and unloaded realms on their own lines, each over its own skins', () => {
    // Two skins whose realm unloaded without a fault call, one that made fault calls (three of them) and kept its realm:
    // the two counts are different things, so neither may be printed over the other's denominator.
    const gone = { soft: 0, hard: 0, unloaded: true };
    const u = cleanRow({ name: 'u.wmz', sha: 'b'.repeat(64), health: gone });
    const u2 = cleanRow({ name: 'u2.wmz', sha: 'd'.repeat(64), health: gone });
    const f = cleanRow({ name: 'f.wmz', sha: 'c'.repeat(64), faultUnloads: 3 });
    const stage = stageOf([u, f, u2, cleanRow({ name: 'ok.wmz' })]);
    const s = summarize(stage);
    expect(s.faultUnloads).toBe(3);
    expect(s.faultUnloadSkins.map((/** @type {Row} */ x) => x.name)).toEqual(['f.wmz']);
    expect(s.unloaded.map((/** @type {Row} */ x) => x.name)).toEqual(['u.wmz', 'u2.wmz']);

    const lines = renderNodeReport(stage);
    const fault = lines.findIndex((l) => l.startsWith('fault unloads (host.actions.fault'));
    const realms = lines.findIndex((l) => l.startsWith('realms that unloaded (health.unloaded'));
    expect(fault).toBeGreaterThanOrEqual(0);
    expect(realms).toBeGreaterThan(fault);
    expect(lines[fault]).toMatch(/: 3 in 1 skins$/);                  // three calls, one skin made them (not "3 in 2")
    expect(lines[fault + 1]).toBe(`  f.wmz (${'c'.repeat(12)}): 3`);
    expect(lines[realms]).toMatch(/: 2 skins$/);                       // two realms, no "N in M" to mix with the calls
    expect(lines[realms + 1]).toBe(`  u.wmz (${'b'.repeat(12)})`);
    expect(lines[realms + 2]).toBe(`  u2.wmz (${'d'.repeat(12)})`);
    expect(lines[realms]).not.toMatch(/ in \d+ skins/);
    // the pre-fix line read "0 in 1 skins" for a realm that unloaded with no fault call: calls over unloaded realms
    expect(lines.join('\n')).not.toMatch(/fault unloads[^\n]*: 0 in 1 skins/);

    // Nothing unloaded and no fault call: both lines say zero, and no skin is listed under either.
    const none = renderNodeReport(stageOf([cleanRow()]));
    const i = none.findIndex((l) => l.startsWith('fault unloads (host.actions.fault'));
    expect(none[i]).toMatch(/: 0 in 0 skins$/);
    expect(none[i + 1]).toMatch(/^realms that unloaded \(health\.unloaded[^)]*\): 0 skins$/);
    expect(none[i + 2]).toBe('');
  });

  it('treats an archive the engine refuses as a failed load and names the phase', async () => {
    const row = await runSkin(buildZip([{ name: 'readme.txt', data: 'no skin here' }]), 'empty.wmz');
    expect(row.loaded).toBe(false);
    expect(row.threw?.phase).toBe('load');
    const failures = gateFailures(stageOf([row]));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^empty\.wmz: did not load \(load: Error: the archive has no \.wms/);
  });

  it('gates runtime-error diagnostics, host exceptions and process-level errors', () => {
    expect(gateFailures(stageOf([cleanRow({ runtimeErrors: 2, runtimeErrorSites: ['handler 3.onclick'] })]))[0]).toMatch(/2 runtime-error diagnostic\(s\) at handler 3\.onclick/);
    expect(gateFailures(stageOf([cleanRow({ threw: { phase: 'run', error: 'TypeError', message: 'boom' } })]))[0]).toMatch(/host exception in run: TypeError: boom/);
    const uncaught = stageOf([cleanRow()], { uncaught: [{ skin: 'x.wmz', kind: 'unhandledRejection', message: 'Error: late' }] });
    expect(gateFailures(uncaught)[0]).toMatch(/process-level unhandledRejection: Error: late/);
    expect(gateFailures(stageOf([cleanRow()]), { distinct: 195 })[0]).toMatch(/1 distinct skins ran, expected 195/);
    // R0 is checked too, and a Headspace that did not load is a failure.
    const r0 = cleanRow({ name: 'Headspace.wmz', rung: 'R0', loaded: false, threw: { phase: 'load', error: 'Error', message: 'no' } });
    expect(gateFailures(stageOf([cleanRow()], { r0 })).join('\n')).toMatch(/Headspace\.wmz: did not load/);
  });

  it('finds the distinct archives and the ladder rungs in a corpus directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headmpd-corpus-'));
    try {
      const a = zipOf(wmsOf('<subview id="a" left="0" top="0" width="9" height="9"/>'));
      const b = zipOf(wmsOf('<subview id="b" left="0" top="0" width="8" height="8"/>'));
      writeFileSync(join(dir, 'microsoft__Miniplayer.wmz'), a);
      writeFileSync(join(dir, 'Miniplayer.wmz'), a);                  // an alias: same bytes, one skin
      writeFileSync(join(dir, 'other.wmz'), b);
      writeFileSync(join(dir, 'notes.txt'), 'not an archive');
      const found = distinctArchives(dir);
      expect(found.archives).toBe(3);
      expect(found.distinct.map((e) => e.name)).toEqual(['Miniplayer.wmz', 'other.wmz']);
      expect(found.distinct[0].names).toEqual(['Miniplayer.wmz', 'microsoft__Miniplayer.wmz']);
      expect(found.distinct.map(rungOf)).toEqual(['R1', null]);

      const stage = await runNodeStage({ dir, headspace: null });
      expect(stage.archives).toBe(3);
      expect(stage.rows.map((r) => [r.name, r.rung, r.loaded])).toEqual([['Miniplayer.wmz', 'R1', true], ['other.wmz', null, true]]);
      expect(stage.r0).toBeNull();
      expect(stage.uncaught).toEqual([]);
      expect(gateFailures(stage)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('the report files', () => {
    /** @type {string} */
    let dir;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'headmpd-reports-')); });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    it('rewrites one stage section and keeps the other', () => {
      const file = join(dir, LOAD_FILE);
      const first = updateSection(file, 'node', ['node line one', 'node line two']);
      expect(first).toContain('== node stage ==\nnode line one\nnode line two\n== end node stage ==');
      expect(first).toContain('== chromium stage ==\n(not run yet)\n== end chromium stage ==');

      updateSection(file, 'chromium', ['chromium line']);
      const both = readFileSync(file, 'utf8');
      expect(both).toContain('node line two');
      expect(both).toContain('== chromium stage ==\nchromium line\n== end chromium stage ==');

      updateSection(file, 'node', ['node rewritten']);
      const after = readFileSync(file, 'utf8');
      expect(after).toContain('node rewritten');
      expect(after).not.toContain('node line one');
      expect(after).toContain('chromium line');
      expect(after.match(/== node stage ==/g)).toHaveLength(1);
    });

    it('renders the node section and the ledger from a stage result, with no pipes or control characters in a cell', async () => {
      const wms = wmsOf('', `${VIEW} onload="touch();"`);
      const js = 'function touch() { player.controls.fastForward(); }';
      const row = await runSkin(zipOf(wms, js), 'render.wmz', { sha: 'b'.repeat(64) });
      // A name a skin chose: it holds a pipe and a control character, which must not break a table row.
      const odd = cleanRow({ name: 'odd.wmz', ledger: [{ api: 'a|b\u0001c', kind: 'unknown-member', count: 1 }] });
      const stage = stageOf([row, odd], { r0: cleanRow({ name: 'Headspace.wmz', rung: 'R0', ledger: [{ api: 'video', kind: 'stub', count: 1 }] }) });
      writeNodeReports(stage, dir);
      const load = readFileSync(join(dir, LOAD_FILE), 'utf8');
      expect(load).toContain('loaded and attached: 2/2');
      expect(load).toContain('R0 Headspace.wmz');
      expect(load).toContain('R1: not run');
      const ledger = readFileSync(join(dir, LEDGER_FILE), 'utf8');
      expect(ledger).toContain('| player.controls.fastForward | stub | stub | 1 | 1 |');
      expect(ledger).toContain('| a\\|b c | unknown-member | - | 1 | 1 |');
      expect(ledger).toContain('## Headspace (R0)');
      expect(ledger).toMatch(/\| video \| stub \| - \| 1 \|/);
      // every table row has the same number of cells as its header
      for (const block of ledger.split('\n\n')) {
        const lines = block.split('\n').filter((l) => l.startsWith('|'));
        if (lines.length < 2) continue;
        const cells = (/** @type {string} */ l) => l.replace(/\\\|/g, '').split('|').length;
        for (const l of lines) expect(cells(l), l).toBe(cells(lines[0]));
      }
      // eslint-disable-next-line no-control-regex
      expect(ledger).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    });

    it('writes into a directory that does not exist yet', () => {
      const nested = join(dir, 'a', 'b');
      mkdirSync(join(dir, 'a'));
      writeNodeReports(stageOf([cleanRow()]), nested);
      expect(readFileSync(join(nested, LEDGER_FILE), 'utf8')).toContain('# Coverage ledger');
    });
  });
});

/** A Chromium-stage row with nothing wrong, for a test to damage in one place. @param {Partial<import('../../tools/skinlab/cmd-corpus.mjs').ChromiumRow>} [over] */
const chromeRow = (over = {}) => ({
  name: 'x.wmz', sha: 'a'.repeat(64), rung: null, mounted: true, mountError: null, unsettled: false, hang: false, hangWhy: '', crashed: false,
  problems: [], consoleErrors: 0, frame: { width: 200, height: 100, pixels: 20000, painted: 500 }, maskSet: 400, maskError: null,
  dom: { count: 3, maxArea: 20000, overCap: 0, nodes: 30, viewState: 'open' }, mountMs: 120, ...over,
});

/** @param {number} alpha an 8 x 4 PNG of one alpha value */
const pngOf = (alpha) => {
  const png = new PNG({ width: 8, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([10, 20, 30, alpha], i);
  return PNG.sync.write(png);
};

const META = { archives: 342, info: { playwrightVersion: '1.63.0', revision: '1243' }, config: 'faithful', wallMs: 5000, browserVersion: '153.0.0.0' };

describe('the Chromium stage on synthetic rows and a stand-in page (no art)', () => {
  describe('rowFailures', () => {
    it('passes a clean row, and a row that is not mounted says so once', () => {
      expect(rowFailures(chromeRow())).toEqual([]);
      expect(rowFailures(chromeRow({ unsettled: true }))).toEqual([]);                  // busy is reported, not failed
      expect(rowFailures(chromeRow({ maskSet: 0 }))).toEqual([]);                        // an empty mask is reported, not failed
      const dead = rowFailures(chromeRow({ mounted: false, mountError: 'the archive has no .wms', frame: null, maskSet: null }));
      expect(dead).toEqual(['did not mount: the archive has no .wms']);
    });

    it('names each failure kind', () => {
      expect(rowFailures(chromeRow({ crashed: true }))).toEqual(['renderer crash']);
      expect(rowFailures(chromeRow({ problems: ['page error: boom', 'HTTP 404: /x.png'] }))).toEqual(['page error: boom', 'HTTP 404: /x.png']);
      expect(rowFailures(chromeRow({ maskError: 'no mask yet' }))).toEqual(['mask: no mask yet']);
      expect(rowFailures(chromeRow({ frame: { width: 9, height: 9, pixels: 81, painted: 0 } }))).toEqual(['first frame is empty']);
      expect(rowFailures(chromeRow({ hang: true, hangWhy: 'screenshot: no answer in 20 s (the page\'s main thread is stuck)' }))).toEqual([
        'page hang (screenshot: no answer in 20 s (the page\'s main thread is stuck))',
      ]);
      expect(rowFailures(chromeRow({ hang: true, hangWhy: '' }))[0]).toBe('page hang (the page did not answer)');
    });

    it('does not add a mask or frame verdict to a crash or a hang', () => {
      expect(rowFailures(chromeRow({ crashed: true, maskError: 'gone', frame: { width: 1, height: 1, pixels: 1, painted: 0 } }))).toEqual(['renderer crash']);
      expect(rowFailures(chromeRow({ hang: true, hangWhy: 'x', maskError: 'gone', frame: { width: 1, height: 1, pixels: 1, painted: 0 } }))).toEqual(['page hang (x)']);
    });

    it('reports several failures of one row together', () => {
      const out = rowFailures(chromeRow({ problems: ['request failed: /a'], maskError: 'm', frame: { width: 1, height: 1, pixels: 1, painted: 0 } }));
      expect(out).toEqual(['request failed: /a', 'mask: m', 'first frame is empty']);
    });
  });

  describe('renderChromiumReport', () => {
    it('reports a clean run and says R0 was not run when it was not', () => {
      const text = renderChromiumReport([chromeRow(), chromeRow({ name: 'y.wmz', sha: 'b'.repeat(64) })], META).join('\n');
      expect(text).toContain('browser: Chromium 153.0.0.0 (Playwright 1.63.0, revision 1243), config faithful, DPR 1');
      expect(text).toContain('archives: 342; distinct SHA-256: 2');
      expect(text).toContain('mounted: 2/2');
      expect(text).toContain('renderer crashes: 0; page hangs: 0; uncaught page exceptions: 0 skins; failed requests: 0 skins');
      expect(text).toContain('first frame non-empty (a pixel with alpha > 0): 2/2');
      expect(text).toContain('window mask non-empty: 2/2');
      expect(text).toContain('R0 Headspace.wmz: not run (no file on this machine)');
      expect(text).toContain('stage wall time: 5.0 s');
      expect(text).toContain('failing skins: 0');
      expect(text).not.toMatch(/undefined|NaN|\[object/);
    });

    it('lists crashes, hangs with their reason, page errors, failed requests and mount errors', () => {
      const rows = [
        chromeRow({ name: 'crash.wmz', sha: '1'.repeat(64), crashed: true, mounted: false }),
        chromeRow({ name: 'hang.wmz', sha: '2'.repeat(64), hang: true, hangWhy: 'read the window mask: no answer in 20 s (the page\'s main thread is stuck)', mounted: true, frame: null, maskSet: null }),
        chromeRow({ name: 'err.wmz', sha: '3'.repeat(64), problems: ['page error: TypeError: x'] }),
        chromeRow({ name: 'req.wmz', sha: '4'.repeat(64), problems: ['HTTP 500: /a.png'], consoleErrors: 2 }),
        chromeRow({ name: 'stage.wmz', sha: '5'.repeat(64), problems: ['stage error: Target closed'] }),
        chromeRow({ name: 'nomount.wmz', sha: '6'.repeat(64), mounted: false, mountError: 'the archive has no .wms', frame: null, maskSet: null }),
      ];
      const text = renderChromiumReport(rows, META).join('\n');
      expect(text).toContain('mounted: 4/6');                                   // the crash and the unmountable skin are not
      expect(text).toContain('renderer crashes: 1; page hangs: 1; uncaught page exceptions: 1 skins; failed requests: 1 skins');
      expect(text).toContain("  hang: hang.wmz (222222222222): read the window mask: no answer in 20 s (the page's main thread is stuck)");
      expect(text).toContain('console errors logged by the page: 2');
      expect(text).toContain('failing skins: 6');
      expect(text).toContain('  crash.wmz (111111111111): renderer crash');
      expect(text).toContain('  nomount.wmz (666666666666): did not mount: the archive has no .wms');
      expect(text).toContain('  stage.wmz (555555555555): stage error: Target closed');
    });

    it('explains empty frames by the state of the view and lists empty masks', () => {
      const empty = { width: 300, height: 200, pixels: 60000, painted: 0 };
      const rows = [
        chromeRow({ name: 'collapsed.wmz', sha: '7'.repeat(64), frame: empty, dom: { count: 0, maxArea: 0, overCap: 0, nodes: 4, viewState: 'collapsed' } }),
        chromeRow({ name: 'hidden.wmz', sha: '8'.repeat(64), frame: empty, dom: { count: 0, maxArea: 0, overCap: 0, nodes: 4, viewState: 'hidden' } }),
        chromeRow({ name: 'nomask.wmz', sha: '9'.repeat(64), maskSet: 0 }),
        chromeRow({ name: 'fine.wmz', sha: 'a'.repeat(64) }),
      ];
      const text = renderChromiumReport(rows, META).join('\n');
      expect(text).toContain('first frame non-empty (a pixel with alpha > 0): 2/4');
      expect(text).toContain('by the state of the view\'s own node: collapsed 1, hidden 1, masked 0, open 0');
      expect(text).toContain('  collapsed: the view shown has no area');
      expect(text).toContain('  hidden: the view is display:none');
      expect(text).not.toContain('  open: the view has area');                     // only the states that occur get an explanation
      expect(text).toContain('  empty: collapsed.wmz (777777777777) window 300x200, collapsed');
      expect(text).toContain('window mask non-empty: 3/4');
      expect(text).toContain('  empty mask: nomask.wmz (999999999999) 200x100');
    });

    it('prints what restarts a busy view, or that nobody looked', () => {
      const rows = [
        chromeRow({ name: 'Lollapalooza.wmz', sha: `a30ab1a76515${'0'.repeat(52)}`, unsettled: true }),
        chromeRow({ name: 'mystery.wmz', sha: 'd'.repeat(64), unsettled: true }),
      ];
      const text = renderChromiumReport(rows, META).join('\n');
      expect(text).toContain('(a tween that restarts itself): 2');
      expect(text).toMatch(/  Lollapalooza\.wmz \(a30ab1a76515\): the main view's 500 ms timer starts the next 8 s fade/);
      expect(text).toContain('  mystery.wmz (dddddddddddd): cause not looked at');
    });

    it('keeps R0 out of the corpus counts and reports it on its own line', () => {
      const r0 = chromeRow({ name: 'Headspace.wmz', sha: 'f'.repeat(64), rung: 'R0', mountMs: 99, maskSet: 1234, frame: { width: 10, height: 10, pixels: 100, painted: 77 } });
      const text = renderChromiumReport([chromeRow(), r0], META).join('\n');
      expect(text).toContain('archives: 342; distinct SHA-256: 1');
      expect(text).toContain('mounted: 1/1');
      expect(text).toContain('R0 Headspace.wmz (ffffffffffff): mounted, first frame 77 painted px of 100, mask 1234 bits, 99 ms');
      const failed = renderChromiumReport([chromeRow(), chromeRow({ name: 'Headspace.wmz', sha: 'f'.repeat(64), rung: 'R0', mounted: false, mountError: 'x', frame: null, maskSet: null })], META).join('\n');
      expect(failed).toContain('R0 Headspace.wmz (ffffffffffff): NOT mounted');
      expect(failed).toContain('failing skins: 1');
    });
  });

  describe('probe', () => {
    it('passes an answer or a rejection through, and turns silence into a hang that names the probe', async () => {
      await expect(probe('ask', Promise.resolve(7), 1000)).resolves.toBe(7);
      await expect(probe('ask', Promise.reject(new Error('plain')), 1000)).rejects.toThrow('plain');
      const silent = probe('read the thing', new Promise(() => {}), 25);
      await expect(silent).rejects.toBeInstanceOf(PageHang);
      await expect(silent).rejects.toThrow("read the thing: no answer in 0.025 s (the page's main thread is stuck)");
    });

    it("turns Playwright's own TimeoutError into the same hang, and leaves no unhandled rejection behind", async () => {
      const seen = [];
      const note = (/** @type {unknown} */ e) => seen.push(e);
      process.on('unhandledRejection', note);
      try {
        const slow = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Timeout 30000ms exceeded'), { name: 'TimeoutError' })), 20));
        await expect(probe('screenshot', slow, 1000)).rejects.toBeInstanceOf(PageHang);
        // a promise that rejects after the timer already won
        const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 60));
        await expect(probe('late', late, 10)).rejects.toBeInstanceOf(PageHang);
        await new Promise((r) => setTimeout(r, 100));
      } finally {
        process.off('unhandledRejection', note);
      }
      expect(seen).toEqual([]);
    });
  });

  describe('mountOne against a stand-in page', () => {
    const HANG = Symbol('hang');
    const SHRUNK = { softMs: 10, hardMs: 5000, probeMs: 40, closeMs: 40, lookAgainMs: 0, maxNudges: 3 };
    const entry = { name: 'synthetic.wmz', sha: 's'.repeat(64) };
    const MASK = { b64: Buffer.from([0xff, 0x01]).toString('base64'), width: 4, height: 2 };       // 9 bits set

    /**
     * A page whose main thread answers `answer(kind)` for each `evaluate`; HANG never answers. `kind` is read off the
     * function the stage sends (mount, attached, settle, mask, frame, dom).
     * @param {(kind: string) => unknown} answer
     * @param {{ shots?: Buffer[], shotError?: Error, goto?: () => Promise<void>, closeHangs?: boolean }} [opts]
     */
    function standIn(answer, opts = {}) {
      const log = { closed: 0, shots: 0, kinds: /** @type {string[]} */ ([]) };
      const kindOf = (/** @type {string} */ src) => (/mount\(/.test(src) ? 'mount'
        : /settle\(/.test(src) ? 'settle'
          : /requestAnimationFrame/.test(src) ? 'frame'
            : /getElementById/.test(src) ? 'dom'
              : /try/.test(src) ? 'attached' : 'mask');
      const page = {
        on() {},
        goto: opts.goto ?? (async () => {}),
        waitForFunction: async () => {},
        evaluate(/** @type {Function} */ fn) {
          const kind = kindOf(String(fn));
          log.kinds.push(kind);
          const r = answer(kind);
          return r === HANG ? new Promise(() => {}) : Promise.resolve(r);
        },
        setViewportSize: async () => {},
        async screenshot() {
          log.shots++;
          if (opts.shotError) throw opts.shotError;
          const shots = opts.shots ?? [pngOf(255)];
          return shots[Math.min(log.shots - 1, shots.length - 1)];
        },
        close: () => { log.closed++; return opts.closeHangs ? new Promise(() => {}) : Promise.resolve(); },
      };
      return { context: { newPage: async () => page }, log };
    }

    const healthy = (/** @type {string} */ kind) => (kind === 'mount' ? { ok: true } : kind === 'mask' ? MASK : kind === 'attached' ? true
      : kind === 'dom' ? { count: 3, maxArea: 64, overCap: 0, nodes: 9, viewState: 'open' } : undefined);

    it('mounts, reads the mask and the frame, and passes a healthy page', async () => {
      const { context, log } = standIn(healthy);
      const row = await mountOne(context, 'http://x', entry, new Uint8Array([1, 2, 3]), 'faithful', SHRUNK);
      expect(row).toMatchObject({ mounted: true, hang: false, crashed: false, mountError: null, maskSet: 9, unsettled: false });
      expect(row.frame).toEqual({ width: 4, height: 2, pixels: 32, painted: 32 });
      expect(row.dom).toMatchObject({ count: 3, viewState: 'open' });
      expect(rowFailures(row)).toEqual([]);
      expect(log.closed).toBe(1);
    });

    it('looks once more at an empty first frame, then fails it', async () => {
      const { context, log } = standIn(healthy, { shots: [pngOf(0)] });
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(log.shots).toBe(2);
      expect(row.frame?.painted).toBe(0);
      expect(rowFailures(row)).toEqual(['first frame is empty']);
      const late = standIn(healthy, { shots: [pngOf(0), pngOf(255)] });
      const ok = await mountOne(late.context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(ok.frame?.painted).toBe(32);
      expect(rowFailures(ok)).toEqual([]);
    });

    it('reports a page whose main thread is stuck from the first probe as a hang, not for ever', async () => {
      const { context, log } = standIn(() => HANG);                      // mount never returns, nor does anything else
      const t0 = Date.now();
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(row.hang).toBe(true);
      expect(row.mounted).toBe(false);
      expect(row.hangWhy).toBe("is the view attached: no answer in 0.04 s (the page's main thread is stuck)");
      expect(rowFailures(row)).toEqual(["page hang (is the view attached: no answer in 0.04 s (the page's main thread is stuck))"]);
      expect(log.closed).toBe(1);
    });

    it.each([
      ['read the window mask', 'mask'],
      ['wait for a frame', 'frame'],
      ['read the DOM', 'dom'],
    ])('reports %s that never answers after the mount as a hang', async (label, stuckKind) => {
      const { context, log } = standIn((kind) => (kind === stuckKind ? HANG : healthy(kind)));
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(row.mounted).toBe(true);
      expect(row.hang).toBe(true);
      expect(row.hangWhy).toContain(`${label}: no answer in 0.04 s`);
      expect(log.closed).toBe(1);
    });

    it("reports Playwright's screenshot timeout as a hang", async () => {
      const shotError = Object.assign(new Error('page.screenshot: Timeout 40ms exceeded'), { name: 'TimeoutError' });
      const { context } = standIn(healthy, { shotError });
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(row.hang).toBe(true);
      expect(row.hangWhy).toContain('screenshot: no answer');
    });

    it('nudges a view that is still busy, then calls it unsettled and goes on to look at it', async () => {
      // mount never returns (the view's tween restarts itself); the page itself answers every probe.
      const { context, log } = standIn((kind) => (kind === 'mount' ? HANG : healthy(kind)));
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(row.unsettled).toBe(true);
      expect(row.hang).toBe(false);
      expect(row.mounted).toBe(true);
      expect(log.kinds.filter((k) => k === 'settle')).toHaveLength(SHRUNK.maxNudges);
      expect(rowFailures(row)).toEqual([]);
    });

    it('keeps an engine rejection as a mount error and an unreachable page as a stage error, neither a hang', async () => {
      const rejected = standIn((kind) => (kind === 'mount' ? { ok: false, error: 'the archive has no .wms' } : healthy(kind)));
      const a = await mountOne(rejected.context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(a).toMatchObject({ mounted: false, hang: false, mountError: 'the archive has no .wms' });
      const down = standIn(healthy, { goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); } });
      const b = await mountOne(down.context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(b.hang).toBe(false);
      expect(b.problems).toEqual(['stage error: net::ERR_CONNECTION_REFUSED']);
      expect(down.log.closed).toBe(1);
    });

    it('does not wait for a stuck page to close', async () => {
      const { context, log } = standIn(() => HANG, { closeHangs: true });
      const t0 = Date.now();
      const row = await mountOne(context, 'http://x', entry, new Uint8Array(1), 'faithful', SHRUNK);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(row.hang).toBe(true);
      expect(log.closed).toBe(1);
    });
  });
});

describeCorpus('corpus load: skins/wmp', () => {
  const headspace = headspaceFixture();
  /** @type {StageResult} */
  let result;

  beforeAll(async () => {
    result = await runNodeStage({ headspace: headspace.ok ? headspace.path : null });
  });

  it(`loads and attaches all ${SURVEY_DISTINCT} distinct skins with zero uncaught host exceptions`, () => {
    expect(result.rows).toHaveLength(SURVEY_DISTINCT);
    expect(summarize(result).loaded).toBe(SURVEY_DISTINCT);
    expect(gateFailures(result, { distinct: SURVEY_DISTINCT })).toEqual([]);
  });

  it('has R1 Miniplayer and R2 aoe in the corpus, with zero realm hard faults', () => {
    for (const rung of ['R1', 'R2']) {
      const found = result.rows.filter((r) => r.rung === rung);
      expect(found, rung).toHaveLength(1);
      expect(found[0].health, rung).toMatchObject({ hard: 0, unloaded: false });
      expect(found[0].hardFaults, rung).toEqual([]);
    }
  });

  it.skipIf(!headspace.ok)('runs R0, the owner\'s Headspace.wmz, with zero realm hard faults', () => {
    expect(result.r0).not.toBeNull();
    expect(result.r0?.loaded).toBe(true);
    expect(result.r0?.health).toMatchObject({ hard: 0, unloaded: false });
    expect(result.r0?.runtimeErrors).toBe(0);
  });

  it('finds no canvas-clamp hit: no element box is over the canvas cap (expected 0)', () => {
    expect(summarize(result).clampSkins.map((r) => `${r.name}: ${r.clampHits}`)).toEqual([]);
  });

  it('writes the numbers to docs/coverage/corpus-load.txt and the ledger to docs/coverage/ledger.md', () => {
    writeNodeReports(result);
    const lines = renderNodeReport(result);
    // eslint-disable-next-line no-console
    console.log(`W5.4 corpus (node stage)\n${lines.join('\n')}`);
    expect(lines.length).toBeGreaterThan(10);
    expect(aggregateLedger(result.rows).size).toBeGreaterThan(0);
  });
});
