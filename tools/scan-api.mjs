#!/usr/bin/env node
// @ts-check
// Static API ranking (ENGINE D6.7, WAVES W2.8). Reads every archive of a skin corpus and ranks what
// the skins' scripts and attribute values ask of the host, so that stubs are implemented in rank
// order (notan Q3) and the coverage ledger can be read against what the corpus demands. The output
// is names and counts only (WAVES global rule 2): no archive name, file name, line or text.
//
//   node tools/scan-api.mjs [<dir-or-archive>...] [--out <file>]
//
// With no path it scans skins/wmp. The CSV defaults to docs/coverage/api-frequency.csv. With the
// corpus absent it prints a skip, exits 0 and leaves the file alone. Exit codes: 0 written or
// skipped, 2 bad usage, 1 an archive could not be read (nothing is written: a partial ranking
// would be committed as if it were whole) or the file could not be written.
//
// Columns: kind,name,refs,skins,refs_all_archives
//   refs               references in the distinct corpus (one archive per SHA-256), the rank key
//   skins              how many of those distinct archives reference the name at least once
//   refs_all_archives  references over every archive, byte-identical copies and `_MP7`/`_MPXP`
//                      variants included. This is the unit `spec 7.1` counts in (1,374 for
//                      currentPosition), so the two can be compared row by row.
// Rows sort by refs, then refs_all_archives, then kind and name, so the file is stable.
//
// What a row means. Everything is case-folded (ASCII), because WMP resolves host members that way.
//   object-model     a dotted path from a documented global (`player theme view event mediacenter`,
//                    spec 4.1): `player.controls.currentposition`. Every prefix is a row of its own
//                    (`player`, `player.controls`), so the class-level demand of survey 5.4 is
//                    visible beside the leaf members. A path ends where a call starts, so
//                    `player.currentPlaylist.item(0).name` is `player.currentplaylist.item`.
//                    `wmpprop:` targets and `wmpenabled:` / `wmpdisabled:` names count too; the
//                    latter as `player.controls.<method>`, which is what they bind to (spec 3.4).
//   wmploc-132       a bare use of a name the shared script `res://wmploc/RT_TEXT/#132` defines
//                    (`osmediaopen`), counted only in a skin that lists that script and does not
//                    define the name itself. The name set comes from the wmploc shim.
//   element-method   `<id>.<method>(...)`, where `<id>` is an id some `.wms` of the same skin
//                    declares, or `this.<method>(...)` inside a handler or `jscript:` value. Counted
//                    by method name: the receiver is a per-skin id, which means nothing across skins.
//   implicit-method  a bare call `name(...)` inside a handler or `jscript:` value, which WMP runs
//                    with the firing element as implicit scope (spec 2.4): `previous()`, `moveTo(...)`.
//                    Names that any scanned skin defines as a function or variable, and JScript
//                    built-ins, are dropped (what is left is element methods and typos: wmploc 4.1).
//                    An element method that some other skin also defines as a function (`reset`)
//                    therefore shows only under element-method.
//
// Limits, all of them undercounts or small misattributions, never crashes:
//   - The JavaScript pass is a tokenizer, not a parser. Comments and strings are skipped, so API
//     names inside `eval("...")` text are not seen (the corpus builds those strings from fragments).
//     A `/` after `)`, `]`, `}`, a name or a literal is division, anywhere else a regex literal; a
//     wrong guess is confined to one line.
//   - Receivers held in variables (`var b = svDrawer; b.moveTo(...)`) are not followed.
//   - `.js` and `.wms` files are found by extension in the archive's flat namespace, so a name
//     the VFS folds together (two `pl_x.js` in different folders) counts once, as the engine would.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openVfs } from '../src/engine/archive/vfs.js';
import { decodeText } from '../src/engine/text/decode.js';
import { scanWms } from '../src/engine/wms/scan.js';
import { resolveTag } from '../src/engine/wms/tags.js';
import { classifyValueDiag } from '../src/engine/wms/values.js';
import { parseScriptFile, scriptLibrary } from '../src/engine/realm/wmploc.js';
import { isArchiveName, listArchives } from './make-corpus-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_CORPUS = join(REPO_ROOT, 'skins', 'wmp');
export const DEFAULT_OUT = join(REPO_ROOT, 'docs', 'coverage', 'api-frequency.csv');

/** The CSV's first line. */
export const CSV_HEADER = 'kind,name,refs,skins,refs_all_archives';

/** @typedef {'object-model' | 'wmploc-132' | 'element-method' | 'implicit-method'} Kind */

/** Globals a skin script can reach that are host objects (spec 4.1, E D6). A Set: names are skin text. */
export const OBJECT_ROOTS = new Set(['player', 'theme', 'view', 'event', 'mediacenter']);

/** The globals #132 installs, spelled as the DLL spells them (matched case-sensitively, wmploc 4.3). */
export const WMPLOC_132_NAMES = new Set(Object.keys(scriptLibrary('res://wmploc/RT_TEXT/#132')?.constants ?? {}));

// Words that can sit in front of `(` or a name without being a call or a use of one.
const KEYWORDS = new Set([
  'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'false', 'finally', 'for',
  'function', 'if', 'in', 'instanceof', 'new', 'null', 'return', 'switch', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with',
]);
// After these a `/` starts a regex literal.
const REGEX_AFTER = new Set(['case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'return', 'throw', 'typeof', 'void']);
// Bare calls that are JScript itself (folded), not element methods.
const JS_GLOBALS = new Set([
  'activexobject', 'alert', 'array', 'boolean', 'cleartimeout', 'clearinterval', 'date', 'decodeuri',
  'decodeuricomponent', 'encodeuri', 'encodeuricomponent', 'enumerator', 'error', 'escape', 'eval', 'function',
  'isfinite', 'isnan', 'number', 'object', 'parsefloat', 'parseint', 'regexp', 'setinterval', 'settimeout',
  'string', 'unescape',
]);

/** Longest name kept: a longer one is a hostile or broken file, not an API. */
const MAX_NAME = 128;
/** Most dotted segments one path contributes (each prefix is a row). */
const MAX_SEGMENTS = 8;
/** Most distinct rows kept; a skin that invents names without end cannot grow the table without end. */
const MAX_ROWS = 200_000;

// ---------------------------------------------------------------------------------------------
// The JavaScript tokenizer

/** Token types from `tokenize`. A literal's own text is never kept. */
export const T_ID = 0;
export const T_VAL = 1; // number, string or regex literal
export const T_PUNCT = 2;

const ID_START = /^\p{ID_Start}$/u;
const ID_CONTINUE = /^\p{ID_Continue}$/u;

/** @param {number} c */
const isLineEnd = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
/** @param {number} c */
const isDigit = (c) => c >= 48 && c <= 57;
/** @param {number} c */
const isAsciiStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

/** @param {string} text @param {number} i @returns {number} length in code units of the identifier start at i, or 0 */
function identStartLen(text, i) {
  const c = text.charCodeAt(i);
  if (c < 128) return isAsciiStart(c) ? 1 : 0;
  const cp = /** @type {number} */ (text.codePointAt(i));
  const ch = String.fromCodePoint(cp);
  return ID_START.test(ch) ? ch.length : 0;
}

/** @param {string} text @param {number} i start of an identifier @returns {number} index after it */
function identEnd(text, i) {
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c < 128) {
      if (isAsciiStart(c) || isDigit(c)) { j++; continue; }
      break;
    }
    const ch = String.fromCodePoint(/** @type {number} */ (text.codePointAt(j)));
    if (!ID_CONTINUE.test(ch)) break;
    j += ch.length;
  }
  return j;
}

/** End of the string literal opening at i, or of its line when it never closes. @param {string} text @param {number} i @param {number} q */
function stringEnd(text, i, q) {
  let j = i + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92) { // backslash: an escape, or a line continuation (which may be CRLF)
      j += text.charCodeAt(j + 1) === 13 && text.charCodeAt(j + 2) === 10 ? 3 : 2;
      continue;
    }
    if (c === q) return j + 1;
    if (isLineEnd(c)) return j;
    j++;
  }
  return text.length;
}

/** A regex literal longer than this is not one; the cap also keeps a long line of `/[` linear. */
const MAX_REGEX = 512;

/** End of the regex literal opening at i (flags included), or -1 when the line or the cap ends first. @param {string} text @param {number} i */
function regexEnd(text, i) {
  let inClass = false;
  const stop = Math.min(text.length, i + MAX_REGEX);
  for (let j = i + 1; j < stop; j++) {
    const c = text.charCodeAt(j);
    if (c === 92) { j++; continue; }
    if (isLineEnd(c)) return -1;
    if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) {
      let k = j + 1;
      while (k < text.length && /[a-z]/i.test(text[k])) k++;
      return k;
    }
  }
  return -1;
}

/**
 * Split JavaScript into identifiers, literals and single-character punctuators. Total: it never
 * throws and runs in time linear in the text, whatever the text is. `==` and `===` are one
 * punctuator each and `=>` too, so a lone `=` is an assignment.
 * @param {string} text
 * @returns {{ types: number[], vals: string[] }}
 */
export function tokenize(text) {
  /** @type {number[]} */
  const types = [];
  /** @type {string[]} */
  const vals = [];
  const n = text.length;
  let i = 0;
  let regexOk = true; // may a `/` here start a regex literal?
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) { i += 2; while (i < n && !isLineEnd(text.charCodeAt(i))) i++; continue; }
      if (d === 42) { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
      const end = regexOk ? regexEnd(text, i) : -1;
      if (end > 0) { types.push(T_VAL); vals.push('/'); regexOk = false; i = end; continue; }
      types.push(T_PUNCT); vals.push('/'); regexOk = true; i++;
      continue;
    }
    if (c === 34 || c === 39) {
      i = stringEnd(text, i, c);
      types.push(T_VAL); vals.push('"'); regexOk = false;
      continue;
    }
    if (isDigit(c) || (c === 46 && regexOk && isDigit(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) {
        const ch = text.charCodeAt(j);
        if (isAsciiStart(ch) || isDigit(ch)) j++;
        else if (ch === 46 && (isDigit(text.charCodeAt(j + 1)) || (isDigit(text.charCodeAt(j - 1)) && !identStartLen(text, j + 1)))) j++;
        else break;
      }
      types.push(T_VAL); vals.push('0'); regexOk = false; i = j;
      continue;
    }
    if (identStartLen(text, i)) {
      const end = identEnd(text, i);
      const word = text.slice(i, end);
      types.push(T_ID); vals.push(word);
      regexOk = REGEX_AFTER.has(word);
      i = end;
      continue;
    }
    if (c === 61) { // =, == and ===, =>
      const d = text.charCodeAt(i + 1);
      const len = d === 61 ? (text.charCodeAt(i + 2) === 61 ? 3 : 2) : d === 62 ? 2 : 1;
      types.push(T_PUNCT); vals.push(len === 1 ? '=' : text.slice(i, i + len));
      i += len; regexOk = true;
      continue;
    }
    types.push(T_PUNCT); vals.push(text[i]);
    regexOk = !(c === 41 || c === 93 || c === 125); // `)` `]` `}` end an operand
    i++;
  }
  return { types, vals };
}

// ---------------------------------------------------------------------------------------------
// Counting

/** ASCII-only fold, like the scanner's: `toLowerCase` also maps U+212A onto `k`. @param {string} s */
const fold = (s) => (/[A-Z]/.test(s) ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s);

/**
 * What one skin asks of the host. Every table is a Map or a Set, because every key is skin text.
 * @typedef {Object} SkinFacts
 * @property {Map<string, number>} counts   `kind\tname` -> references; implicit methods are not here yet
 * @property {Map<string, number>} bare     bare call name -> references (candidates for implicit-method)
 * @property {Map<string, number>} lib      #132 name (folded) -> references (candidates for wmploc-132)
 * @property {Set<string>} ids              declared element ids, folded
 * @property {Set<string>} defined          names the skin's own scripts define, folded
 * @property {boolean} loads132             some VIEW lists `res://.../RT_TEXT/#132` in `scriptFile`
 */

/** @returns {SkinFacts} */
const newFacts = () => ({ counts: new Map(), bare: new Map(), lib: new Map(), ids: new Set(), defined: new Set(), loads132: false });

/** @param {Map<string, number>} m @param {string} key @param {number} [by] */
const bump = (m, key, by = 1) => { m.set(key, (m.get(key) ?? 0) + by); };

/** One row for the path and one for each of its prefixes. @param {SkinFacts} f @param {string[]} names already folded */
function countPath(f, names) {
  const top = Math.min(names.length, MAX_SEGMENTS);
  let path = '';
  for (let k = 0; k < top; k++) {
    path = k === 0 ? names[0] : `${path}.${names[k]}`;
    if (path.length > MAX_NAME) return;
    bump(f.counts, `object-model\t${path}`);
  }
}

/**
 * Count the API references in one piece of JavaScript.
 * @param {string} text
 * @param {SkinFacts} f
 * @param {boolean} fromAttr  a handler or `jscript:` value: the firing element is the implicit scope
 */
export function scanScript(text, f, fromAttr) {
  const { types, vals } = tokenize(text);
  const n = types.length;
  for (let i = 0; i < n; i++) {
    if (types[i] !== T_ID) continue;
    // `x` in `foo().x` or `a[0].x` has no receiver we could name. A chain `a.b.c` is read whole from
    // its first name, so the later names never start one.
    if (i > 0 && types[i - 1] === T_PUNCT && vals[i - 1] === '.') continue;
    const prevWord = i > 0 && types[i - 1] === T_ID ? vals[i - 1] : '';
    const word = vals[i];

    const names = [fold(word)];
    let j = i;
    while (j + 2 < n && types[j + 1] === T_PUNCT && vals[j + 1] === '.' && types[j + 2] === T_ID) {
      names.push(fold(vals[j + 2]));
      j += 2;
    }
    if (names.some((s) => s.length > MAX_NAME)) { i = j; continue; }
    const isCall = j + 1 < n && types[j + 1] === T_PUNCT && vals[j + 1] === '(';
    const isAssigned = j + 1 < n && types[j + 1] === T_PUNCT && vals[j + 1] === '=';
    i = j;

    if (names.length === 1 && KEYWORDS.has(word)) continue;
    if (prevWord === 'new') continue; // a constructor, not a host member
    if (names.length === 1 && (prevWord === 'function' || prevWord === 'var')) { f.defined.add(names[0]); continue; }

    const root = names[0];
    if (OBJECT_ROOTS.has(root)) { countPath(f, names); continue; }

    if (names.length === 1) {
      if (isCall) {
        if (fromAttr) bump(f.bare, root);
      } else if (isAssigned) {
        // In a handler `down = false` assigns an attribute of the element, not a variable.
        if (!fromAttr) f.defined.add(root);
      } else if (WMPLOC_132_NAMES.has(word)) {
        bump(f.lib, root);
      }
      continue;
    }

    if (names.length === 2 && isCall && (f.ids.has(root) || (root === 'this' && fromAttr))) {
      bump(f.counts, `element-method\t${names[1]}`);
    }
  }
}

/**
 * Collect from one scanned `.wms`: element ids, whether #132 is listed, and the script text of every
 * handler and `jscript:` value; count `wmpprop:` and `wmpenabled:` references on the way.
 * @param {string} text
 * @param {SkinFacts} f
 * @param {string[]} attrScripts  receives the handler and `jscript:` sources
 */
function scanDefinition(text, f, attrScripts) {
  const { root } = scanWms(text);
  if (!root) return;
  // Iterative: a hostile file nests as deep as it likes.
  const stack = [root];
  while (stack.length) {
    const node = /** @type {import('../src/engine/contracts').RawNode} */ (stack.pop());
    const kind = resolveTag(node.tag).kind;
    for (const attr of node.attrs) {
      if (attr.name === 'id') {
        const id = fold(attr.value.trim());
        if (id) f.ids.add(id);
      } else if (attr.name === 'scriptfile') {
        if (parseScriptFile(attr.value).some((e) => e.kind === 'library' && e.library.id === 132)) f.loads132 = true;
      }
      const { source } = classifyValueDiag(kind, attr.name, attr.value);
      if (source.kind === 'handler' || source.kind === 'jscript') {
        attrScripts.push(source.source);
      } else if (source.kind === 'wmpprop') {
        const names = [fold(source.path.root)];
        for (const seg of source.path.segments) {
          names.push(fold(seg.name));
          if (seg.args) break; // a path ends where a call starts, as in script
        }
        if (OBJECT_ROOTS.has(names[0])) countPath(f, names);
      } else if (source.kind === 'wmpenabled' || source.kind === 'wmpdisabled') {
        countPath(f, ['player', 'controls', fold(source.method)]);
      }
    }
    for (const child of node.children) stack.push(child);
  }
}

/**
 * Facts for one skin from its decoded `.wms` and `.js` texts.
 * @param {string[]} wms
 * @param {string[]} js
 * @returns {SkinFacts}
 */
export function analyzeSkin(wms, js) {
  const f = newFacts();
  /** @type {string[]} */
  const attrScripts = [];
  // Ids first: `scanScript` needs every id of the skin before it can tell a receiver from a variable.
  for (const text of wms) scanDefinition(text, f, attrScripts);
  for (const text of js) scanScript(text, f, false);
  for (const text of attrScripts) scanScript(text, f, true);
  return f;
}

/**
 * @typedef {Object} ArchiveResult
 * @property {string} sha
 * @property {SkinFacts} facts
 * @property {{ wms: number, js: number }} files
 */

/**
 * Read one archive and count it. Rejects with the reader's `ArchiveError` when it is not a usable zip.
 * @param {Uint8Array} bytes
 * @param {string} name   display only
 * @returns {Promise<ArchiveResult>}
 */
export async function scanArchive(bytes, name) {
  const vfs = await openVfs(bytes, name);
  /** @param {string} ext @returns {string[]} */
  const texts = (ext) => vfs.list(ext).flatMap((key) => {
    const data = vfs.read(key);
    return data ? [decodeText(data).text] : [];
  });
  const wms = texts('.wms');
  const js = texts('.js');
  return { sha: vfs.sha, facts: analyzeSkin(wms, js), files: { wms: wms.length, js: js.length } };
}

/**
 * @typedef {Object} Row
 * @property {Kind} kind
 * @property {string} name
 * @property {number} refs
 * @property {number} skins
 * @property {number} refsAll
 */

/**
 * Fold archive results into ranked rows. The first archive of each SHA-256 is the distinct one.
 * @param {ArchiveResult[]} results
 * @returns {{ rows: Row[], distinct: number, truncated: boolean }}
 */
export function rank(results) {
  // A bare call is an implicit-scope method only if no scanned skin defines that name.
  const definedAnywhere = new Set();
  for (const r of results) for (const name of r.facts.defined) definedAnywhere.add(name);

  /** @type {Map<string, Row>} */
  const table = new Map();
  let truncated = false;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const r of results) {
    const isDistinct = !seen.has(r.sha);
    seen.add(r.sha);
    /** @type {Map<string, number>} */
    const counts = new Map(r.facts.counts);
    for (const [name, n] of r.facts.bare) {
      if (!definedAnywhere.has(name) && !JS_GLOBALS.has(name)) bump(counts, `implicit-method\t${name}`, n);
    }
    if (r.facts.loads132) {
      for (const [name, n] of r.facts.lib) if (!r.facts.defined.has(name)) bump(counts, `wmploc-132\t${name}`, n);
    }
    for (const [key, n] of counts) {
      let row = table.get(key);
      if (!row) {
        if (table.size >= MAX_ROWS) { truncated = true; continue; }
        const tab = key.indexOf('\t');
        row = { kind: /** @type {Kind} */ (key.slice(0, tab)), name: key.slice(tab + 1), refs: 0, skins: 0, refsAll: 0 };
        table.set(key, row);
      }
      row.refsAll += n;
      if (isDistinct) { row.refs += n; row.skins++; }
    }
  }
  /** @param {string} a @param {string} b */
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...table.values()].sort((a, b) => b.refs - a.refs || b.refsAll - a.refsAll || cmp(a.kind, b.kind) || cmp(a.name, b.name));
  return { rows, distinct: seen.size, truncated };
}

/** @param {string} s */
const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** @param {Row[]} rows @returns {string} */
export const renderCsv = (rows) =>
  `${[CSV_HEADER, ...rows.map((r) => `${r.kind},${csvField(r.name)},${r.refs},${r.skins},${r.refsAll}`)].join('\n')}\n`;

// ---------------------------------------------------------------------------------------------
// Command line

/**
 * Archives under each path (a directory is walked, a file is taken as it is), in path order.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function collectArchives(paths) {
  /** @type {string[]} */
  const found = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) for (const rel of listArchives(p)) found.push(join(p, rel));
    else if (isArchiveName(p)) found.push(p);
  }
  return found;
}

/** @param {string[]} argv @returns {{ paths: string[], out: string } | null} */
function parseArgs(argv) {
  /** @type {string[]} */
  const paths = [];
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' && argv[i + 1]) out = resolve(argv[++i]);
    else if (a.startsWith('-')) return null;
    else paths.push(resolve(a));
  }
  return { paths: paths.length ? paths : [DEFAULT_CORPUS], out };
}

/** @param {string[]} argv @returns {Promise<number>} exit code */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) {
    console.error('usage: node tools/scan-api.mjs [<dir-or-archive>...] [--out <file>]');
    return 2;
  }
  const archives = collectArchives(opts.paths);
  if (!archives.length) {
    console.log(`skip: no archives under ${opts.paths.join(', ')}; ${opts.out} left as it is`);
    return 0;
  }
  /** @type {ArchiveResult[]} */
  const results = [];
  let unreadable = 0;
  for (const path of archives) {
    try {
      results.push(await scanArchive(new Uint8Array(readFileSync(path)), path));
    } catch (e) {
      unreadable++;
      console.error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (unreadable) {
    console.error(`${unreadable} of ${archives.length} archives could not be read; ${opts.out} not written`);
    return 1;
  }
  const { rows, distinct, truncated } = rank(results);
  const files = results.reduce((sum, r) => ({ wms: sum.wms + r.files.wms, js: sum.js + r.files.js }), { wms: 0, js: 0 });
  /** @type {Map<string, number>} */
  const perKind = new Map();
  for (const r of rows) bump(perKind, r.kind);
  console.log(`archives ${results.length} (${distinct} distinct), ${files.wms} .wms and ${files.js} .js files`);
  console.log(`rows ${rows.length}: ${[...perKind].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (truncated) console.error(`warning: more than ${MAX_ROWS} distinct names; names beyond that were dropped`);
  try {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, renderCsv(rows));
  } catch (e) {
    console.error(`cannot write ${opts.out}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`wrote ${opts.out}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
