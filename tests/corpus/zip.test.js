// @ts-check
// The archive reader over the whole corpus (ENGINE D4; WAVES W1.1 acceptance 2). Run with
// `npm run corpus -- zip`; skips, never fails, when skins/ is absent. Writes counts and nothing else
// to docs/coverage/corpus-zip.txt: no names of art, no art-derived bytes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openVfs } from '../../src/engine/archive/vfs.js';
import { readZip } from '../../src/engine/archive/zip.js';
import { REPO_ROOT, describeCorpus } from '../support/fixtures.js';

const REPORT = join(REPO_ROOT, 'docs', 'coverage', 'corpus-zip.txt');
const SKIP_CODES = ['zip-name-too-long', 'zip-name-unsafe', 'zip-junk', 'zip-symlink', 'zip-encrypted', 'zip-method', 'zip-local-header-bad'];
const CORRUPT_HEADER_STEMS = ['bruteforce', 'QuantumRedshiftWMPSkin', 'SplinterCellWMPSkin'];
const MiB = 1024 * 1024;

/**
 * Entry count and directory count straight from the central directory, as an independent check on
 * the reader's accounting (it shares no code with it).
 * @param {Uint8Array} b
 */
function centralCounts(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  let eocd = b.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  let dirs = 0;
  for (let i = 0; i < total; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const last = nameLen ? b[p + 46 + nameLen - 1] : 0;
    if (last === 0x2f || last === 0x5c) dirs++;
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { total, dirs };
}

/** @typedef {ReturnType<typeof newStats>} Stats */
function newStats() {
  return {
    archives: 0, opened: 0, shaMismatches: /** @type {string[]} */ ([]), distinct: new Set(),
    centralEntries: 0, directories: 0, exposed: 0, skipped: 0, accountingFailures: /** @type {string[]} */ ([]),
    skipByCode: /** @type {Map<string, number>} */ (new Map()),
    salvaged: 0, collisions: 0, nullReads: /** @type {string[]} */ ([]), crcMismatches: 0, otherReadDiagnostics: 0, openFailures: /** @type {string[]} */ ([]),
    maxEntries: 0, maxEntryBytes: 0, maxRatioOver1MiB: 0, maxInflatedPerArchive: 0, inflatedBytes: 0,
    corrupt: /** @type {Array<{ name: string, salvaged: number, exposed: number, central: number, nulls: number }>} */ ([]),
    scWms: /** @type {string[]} */ ([]),
  };
}

/** @param {import('../support/fixtures.js').CorpusFixture} corpus @param {'wmp'|'wsz'} kind @param {Map<string, string>|undefined} manifest */
async function scan(corpus, kind, manifest) {
  const s = newStats();
  for (const entry of corpus.archives(kind)) {
    s.archives++;
    const bytes = corpus.read(entry);
    /** @type {import('../../src/engine/contracts').SkinVfs} */
    let vfs;
    try { vfs = await openVfs(bytes, entry.name); } catch (e) { s.openFailures.push(`${entry.name}: ${/** @type {Error} */ (e).message}`); continue; }
    s.opened++;
    s.distinct.add(vfs.sha);
    if (manifest && manifest.get(entry.name) !== vfs.sha) s.shaMismatches.push(entry.name);

    const index = readZip(bytes);
    const { total, dirs } = centralCounts(bytes);
    const skips = index.diagnostics.filter((d) => SKIP_CODES.includes(d.code));
    s.centralEntries += total; s.directories += dirs; s.exposed += index.entries.length; s.skipped += skips.length;
    if (total !== index.entries.length + dirs + skips.length) s.accountingFailures.push(entry.name);
    for (const d of skips) s.skipByCode.set(d.code, (s.skipByCode.get(d.code) ?? 0) + 1);
    const salvaged = index.diagnostics.filter((d) => d.code === 'zip-local-header-salvaged').length;
    s.salvaged += salvaged;
    s.collisions += vfs.diagnostics.filter((d) => d.code === 'vfs-case-collision').length;
    s.maxEntries = Math.max(s.maxEntries, total);

    let nulls = 0;
    let inflated = 0;
    for (const e of index.entries) {
      const got = index.read(e);
      if (got === null) { nulls++; s.nullReads.push(`${entry.name}: ${e.name}`); continue; }
      inflated += got.length;
      s.maxEntryBytes = Math.max(s.maxEntryBytes, e.usize);
      if (e.usize > MiB && e.csize > 0) s.maxRatioOver1MiB = Math.max(s.maxRatioOver1MiB, e.usize / e.csize);
    }
    s.inflatedBytes += inflated;
    s.maxInflatedPerArchive = Math.max(s.maxInflatedPerArchive, inflated);
    s.crcMismatches += index.diagnostics.filter((d) => d.code === 'zip-crc-mismatch').length;
    s.otherReadDiagnostics += index.diagnostics.filter((d) => /^zip-(entry|ratio|total)/.test(d.code)).length;

    if (CORRUPT_HEADER_STEMS.some((stem) => entry.name === `${stem}.wmz` || entry.name === `theskinsfactory__${stem}.wmz`)) {
      s.corrupt.push({ name: entry.name, salvaged, exposed: index.entries.length, central: total - dirs - skips.length, nulls });
    }
    if (/SplinterCell/i.test(entry.name)) s.scWms.push(`${entry.name}: has=${vfs.has('sc.wms')} bytes=${vfs.read('sc.wms')?.length ?? 'null'}`);
  }
  return s;
}

describeCorpus('zip', (corpus) => {
  const manifest = corpus.manifest();
  /** @type {{ wmp?: Stats, wsz?: Stats }} */
  const done = {};

  it('opens every WMP archive, each with the SHA-256 the manifest pins', async () => {
    const s = (done.wmp = await scan(corpus, 'wmp', manifest?.wmp));
    console.log(`wmp: ${s.opened} of ${s.archives} archives open, ${s.distinct.size} distinct SHA-256, ${s.exposed} entries exposed of ${s.centralEntries} central entries`);
    expect(s.openFailures).toEqual([]);
    expect(s.archives).toBe(342);
    expect(s.opened).toBe(342);
    expect(s.distinct.size).toBe(195);
    expect(s.shaMismatches).toEqual([]);
  });

  it('opens every WSZ archive', async () => {
    const s = (done.wsz = await scan(corpus, 'wsz', manifest?.wsz));
    console.log(`wsz: ${s.opened} of ${s.archives} archives open, ${s.distinct.size} distinct SHA-256, ${s.exposed} entries exposed of ${s.centralEntries} central entries`);
    expect(s.openFailures).toEqual([]);
    expect(s.opened).toBe(s.archives);
    expect(s.archives).toBeGreaterThanOrEqual(30);
    expect(s.shaMismatches).toEqual([]);
  });

  it('accounts for every central entry (exposed, directory, or skipped with a diagnostic) and reads every exposed one cleanly', () => {
    for (const kind of /** @type {const} */ (['wmp', 'wsz'])) {
      const s = /** @type {Stats} */ (done[kind]);
      expect(s.accountingFailures, `${kind} accounting`).toEqual([]);
      expect(s.nullReads, `${kind} null reads`).toEqual([]);
      expect(s.crcMismatches, `${kind} CRC mismatches`).toBe(0);
      expect(s.otherReadDiagnostics, `${kind} read diagnostics`).toBe(0);
      // the corpus fits inside the D4 caps with room (section 10 evidence column)
      expect(s.maxEntries, `${kind} entries`).toBeLessThanOrEqual(4096);
      expect(s.maxEntryBytes, `${kind} entry bytes`).toBeLessThanOrEqual(32 * MiB);
      expect(s.maxRatioOver1MiB, `${kind} ratio`).toBeLessThanOrEqual(1024);
      expect(s.maxInflatedPerArchive, `${kind} inflated`).toBeLessThanOrEqual(256 * MiB);
    }
  });

  it('the three corrupt-header archives and their raw twins yield every entry, including sc.wms', () => {
    const s = /** @type {Stats} */ (done.wmp);
    expect(s.corrupt.map((c) => c.name).sort()).toEqual(CORRUPT_HEADER_STEMS.flatMap((x) => [`${x}.wmz`, `theskinsfactory__${x}.wmz`]).sort());
    for (const c of s.corrupt) {
      expect(c.salvaged, `${c.name} salvage diagnostics`).toBe(1);
      expect(c.exposed, `${c.name} exposed`).toBe(c.central);
      expect(c.nulls, `${c.name} null reads`).toBe(0);
    }
    expect(s.scWms).toHaveLength(2);
    for (const line of s.scWms) expect(line, line).toMatch(/has=true bytes=[1-9]\d*$/);
    expect(s.salvaged, 'salvage happens for those six and no other archive').toBe(6);
  });

  it('writes the counts to docs/coverage/corpus-zip.txt', () => {
    const { wmp, wsz } = /** @type {Required<typeof done>} */ (done);
    /** @param {string} k @param {Stats} s */
    const block = (k, s) => [
      `${k} archives: ${s.archives}`,
      `${k} archives opened: ${s.opened}`,
      `${k} distinct SHA-256: ${s.distinct.size}`,
      `${k} SHA-256 differing from tests/corpus.manifest.json: ${s.shaMismatches.length}`,
      `${k} central directory entries: ${s.centralEntries}`,
      `${k} directory entries (dropped silently): ${s.directories}`,
      `${k} entries exposed: ${s.exposed}`,
      `${k} entries skipped with a diagnostic: ${s.skipped}`,
      ...[...s.skipByCode].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, n]) => `${k}   ${code}: ${n}`),
      `${k} local headers salvaged: ${s.salvaged}`,
      `${k} case collisions resolved last-wins: ${s.collisions}`,
      `${k} exposed entries that read as null: ${s.nullReads.length}`,
      `${k} CRC mismatches: ${s.crcMismatches}`,
      `${k} largest central directory (entries): ${s.maxEntries}`,
      `${k} largest entry (bytes): ${s.maxEntryBytes}`,
      `${k} highest ratio of an entry over 1 MiB (to 1): ${Math.round(s.maxRatioOver1MiB)}`,
      `${k} largest archive inflated (bytes): ${s.maxInflatedPerArchive}`,
      `${k} total inflated and read (bytes): ${s.inflatedBytes}`,
    ];
    const lines = [
      'Archive reader over the corpus: numbers only (WAVES W1.1, ENGINE D4).',
      'Regenerate with: npm run corpus -- zip',
      '',
      ...block('wmp', wmp), '',
      ...block('wsz', wsz), '',
      `corrupt-header archives (wmp) salvaged with every entry read: ${wmp.corrupt.length}`,
      `sc.wms readable in the SplinterCell archives: ${wmp.scWms.length}`,
    ];
    mkdirSync(join(REPO_ROOT, 'docs', 'coverage'), { recursive: true });
    writeFileSync(REPORT, `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    expect(lines.length).toBeGreaterThan(20);
  });
});
