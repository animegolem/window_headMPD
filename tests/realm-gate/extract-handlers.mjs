#!/usr/bin/env node
// @ts-check
// Throwaway extractor for RG0 item 7 (ENGINE D1, WAVES W1.4). It pulls every inline handler attribute
// and every script file out of the distinct WMP corpus the way the survey did (survey 5.1/5.2), so the
// realm gate does not wait for the real scanner (W1.2) or the archive reader (W1.1). Nothing here is
// engine code and nothing from it may be imported by src/.
//
// What "the survey way" means, because the acceptance counts (219 scripts, 12,868 handlers) depend on it:
//   - distinct archives only: one per SHA-256 (the corpus holds 342 archives, 195 distinct);
//   - per archive, one primary `.wms`: the one whose stem equals the archive stem (after stripping
//     everything through the first `__`, last match wins), else the largest by inflated size, except
//     for the survey's one manual ruling (`PRIMARY_RULINGS`: it picked by fewest unresolved file
//     references, which needs the image resolver this extractor does not have);
//   - a handler is any attribute of any start tag whose name starts with `on` or ends with `_onchange`,
//     case-insensitive, with a value (empty values count, the survey saw 128 to 129); duplicates count;
//   - the attribute value is entity-decoded, nothing else (no `jscript:` stripping, no trimming);
//   - scripts are every entry whose name ends in `.js`, case-insensitive, in any directory.
//
//   node tests/realm-gate/extract-handlers.mjs [skinsDir]     prints the counts

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * Decode skin text by BOM, else UTF-8, else Windows-1252 (the survey's three encodings).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The five XML entities plus numeric references; anything else is left as written. */
const NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

/**
 * @param {string} s
 * @returns {string}
 */
export function unescapeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED.get(name) ?? whole;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/**
 * @typedef {{ tag: string, name: string, value: string|null }} RawAttribute  value is not decoded
 */

/**
 * Walk every start tag of a tolerant read of `.wms` text and report its attributes, in order, with
 * duplicates. Comments, processing instructions, CDATA and declarations are skipped. It does not
 * need well-formedness: the corpus has duplicate attributes, attributes with no whitespace between
 * them and mismatched end-tag case, and none of them matter here.
 * @param {string} text
 * @returns {Generator<RawAttribute>}
 */
export function* scanAttributes(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return;
    /** @param {string} close */
    const skipTo = (close, from) => {
      const k = text.indexOf(close, from);
      return k < 0 ? n : k + close.length;
    };
    if (text.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4); continue; }
    if (text.startsWith('<?', lt)) { i = skipTo('?>', lt + 2); continue; }
    if (text.startsWith('<![CDATA[', lt)) { i = skipTo(']]>', lt + 9); continue; }
    if (text.startsWith('<!', lt) || text.startsWith('</', lt)) { i = skipTo('>', lt + 2); continue; }
    let p = lt + 1;
    while (p < n && !/[\s/>]/.test(text[p])) p++;
    const tag = text.slice(lt + 1, p);
    if (!tag) { i = lt + 1; continue; }
    for (;;) {
      while (p < n && /\s/.test(text[p])) p++;
      if (p >= n) break;
      const c = text[p];
      if (c === '>') { p++; break; }
      if (c === '/') { p++; continue; }
      const nameStart = p;
      while (p < n && !/[\s=>/]/.test(text[p])) p++;
      if (p === nameStart) { p++; continue; }
      const name = text.slice(nameStart, p);
      let q = p;
      while (q < n && /\s/.test(text[q])) q++;
      if (text[q] !== '=') { yield { tag, name, value: null }; continue; }
      q++;
      while (q < n && /\s/.test(text[q])) q++;
      const quote = text[q];
      let value;
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, q + 1);
        value = text.slice(q + 1, end < 0 ? n : end);
        p = end < 0 ? n : end + 1;
      } else {
        let r = q;
        while (r < n && !/[\s>]/.test(text[r])) r++;
        value = text.slice(q, r);
        p = r;
      }
      yield { tag, name, value };
    }
    i = p;
  }
}

/** The survey's definition of an inline handler attribute. @param {string} name */
export const isHandlerAttribute = (name) => {
  const l = name.toLowerCase();
  return l.startsWith('on') || l.endsWith('_onchange');
};

/**
 * @typedef {{ tag: string, attr: string, src: string }} Handler  src is entity-decoded
 */

/** @param {string} wmsText @returns {Handler[]} */
export function extractHandlers(wmsText) {
  /** @type {Handler[]} */
  const out = [];
  for (const a of scanAttributes(wmsText)) {
    if (a.value === null || !isHandlerAttribute(a.name)) continue;
    out.push({ tag: a.tag, attr: a.name, src: unescapeEntities(a.value) });
  }
  return out;
}

/** @param {string} entryName */
const baseName = (entryName) => entryName.replace(/\\/g, '/').split('/').pop() ?? entryName;
/** @param {string} entryName */
const stemOf = (entryName) => baseName(entryName).replace(/\.[^.]*$/, '').toLowerCase();

/** @param {string} archiveName the stem the survey matched `.wms` names against */
const archiveStemOf = (archiveName) => archiveName.replace(/\.[^.]*$/, '').replace(/^.*?__/, '').toLowerCase();

/**
 * The survey's manual ruling for the two archives with two `.wms` files (survey 1.1). `Nautical` is
 * settled by the stem rule; `Sports` is not: its larger file (`saltmine.wms`) has 65 unresolved
 * references and the survey took `ExtremeSports.wms`. Keyed by archive stem, case-folded.
 * @type {ReadonlyMap<string, string>}
 */
export const PRIMARY_RULINGS = new Map([['sports', 'extremesports.wms']]);

/**
 * @param {string} archiveName
 * @param {ReadonlyArray<{ name: string, size: number }>} wmsEntries
 * @returns {string|null}
 */
export function pickPrimaryWms(archiveName, wmsEntries) {
  if (!wmsEntries.length) return null;
  const archiveStem = archiveStemOf(archiveName);
  const ruled = PRIMARY_RULINGS.get(archiveStem);
  if (ruled !== undefined) {
    const hit = wmsEntries.find((e) => baseName(e.name).toLowerCase() === ruled);
    if (hit) return hit.name;
  }
  let primary = null;
  for (const e of wmsEntries) if (stemOf(e.name) === archiveStem) primary = e.name;
  if (primary !== null) return primary;
  let best = wmsEntries[0];
  for (const e of wmsEntries) if (e.size > best.size) best = e;
  return best.name;
}

/**
 * @typedef {Object} ExtractedArchive
 * @property {string} archive
 * @property {string|null} primary                       entry name of the primary `.wms`
 * @property {Handler[]} handlers
 * @property {Array<{ file: string, source: string }>} scripts
 */

/**
 * Read one archive. Only `.wms` and `.js` entries are inflated (fflate's filter), so a 2 MB skin
 * costs its text, not its bitmaps. The archives with a corrupt first local signature read fine
 * because fflate goes through the central directory.
 * @param {string} archiveName
 * @param {Uint8Array} bytes
 * @returns {ExtractedArchive}
 */
export function extractArchive(archiveName, bytes) {
  /** @type {Array<{ name: string, size: number }>} */
  const wms = [];
  const files = unzipSync(bytes, {
    filter(f) {
      const l = f.name.toLowerCase();
      if (l.endsWith('/')) return false;
      if (l.endsWith('.wms')) { wms.push({ name: f.name, size: f.originalSize }); return true; }
      return l.endsWith('.js');
    },
  });
  const primary = pickPrimaryWms(archiveName, wms);
  /** @type {Handler[]} */
  let handlers = [];
  /** @type {Array<{ file: string, source: string }>} */
  const scripts = [];
  for (const [file, data] of Object.entries(files)) {
    if (file === primary) handlers = extractHandlers(decodeText(data));
    else if (file.toLowerCase().endsWith('.js')) scripts.push({ file, source: decodeText(data) });
  }
  return { archive: archiveName, primary, handlers, scripts };
}

/**
 * Archive names to read: one per distinct SHA-256, preferring (as the survey did) a name without
 * `__`, then the shorter, then the earlier. The hashes come from the committed manifest and are
 * checked against the bytes actually read by the caller.
 * @param {ReadonlyMap<string, string>} manifestWmp name -> sha256
 * @returns {Array<{ name: string, sha256: string }>}
 */
export function distinctArchives(manifestWmp) {
  const order = [...manifestWmp].sort(([a], [b]) => {
    const ka = a.includes('__') ? 1 : 0;
    const kb = b.includes('__') ? 1 : 0;
    return ka - kb || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  });
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ name: string, sha256: string }>} */
  const out = [];
  for (const [name, sha256] of order) {
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    out.push({ name, sha256 });
  }
  return out;
}

/**
 * Walk the distinct WMP corpus.
 * @param {string} skinsDir
 * @param {ReadonlyMap<string, string>} manifestWmp
 * @returns {{ archives: ExtractedArchive[], hashMismatches: string[] }}
 */
export function extractCorpus(skinsDir, manifestWmp) {
  /** @type {ExtractedArchive[]} */
  const archives = [];
  /** @type {string[]} */
  const hashMismatches = [];
  for (const { name, sha256 } of distinctArchives(manifestWmp)) {
    const bytes = new Uint8Array(readFileSync(join(skinsDir, 'wmp', name)));
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) hashMismatches.push(name);
    archives.push(extractArchive(name, bytes));
  }
  return { archives, hashMismatches };
}

/** @param {string[]} argv */
function main(argv) {
  const skinsDir = resolve(argv[0] ?? join(REPO_ROOT, 'skins'));
  const manifestPath = join(REPO_ROOT, 'tests', 'corpus.manifest.json');
  if (!existsSync(join(skinsDir, 'wmp')) || !existsSync(manifestPath)) {
    console.log(`skip: no corpus at ${skinsDir}`);
    return;
  }
  const manifest = new Map(Object.entries(JSON.parse(readFileSync(manifestPath, 'utf8')).wmp));
  const { archives, hashMismatches } = extractCorpus(skinsDir, manifest);
  const handlers = archives.reduce((s, a) => s + a.handlers.length, 0);
  const scripts = archives.reduce((s, a) => s + a.scripts.length, 0);
  const empty = archives.reduce((s, a) => s + a.handlers.filter((h) => h.src === '').length, 0);
  console.log(`archives ${archives.length}, scripts ${scripts}, handlers ${handlers} (${empty} empty), hash mismatches ${hashMismatches.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
