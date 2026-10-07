// @ts-check
// Boundary checker for ENGINE.md D8, run by `npm run check` before `tsc`.
//
//   node tools/check-boundaries.mjs                 scan the repository this file lives in
//   node tools/check-boundaries.mjs --root <dir>    scan <dir>/src/engine and <dir>/src/hosts/test
//   node tools/check-boundaries.mjs --self-test     scan tools/check-boundaries.fixtures/ and fail
//                                                   unless every planted violation is caught
//
// Exit 0 clean, 1 violations (or a failed self-test), 2 bad usage.
//
// The scan is deliberately dumb: regular expressions over the raw text of every .js/.mjs/.cjs/.ts
// (including .d.ts) file, so a comment or a string that says `import '@tauri-apps/api/core'` or
// `fetch(` is a violation too. JSDoc type imports (`import('./contracts').X`) are therefore
// scanned like code, which is what we want: a type import is still a dependency edge. The rules
// are path-scoped, so anything outside src/engine/ and src/hosts/test/ is never looked at.
//
// A static specifier is found by the `from` keyword followed by a string literal, wherever that
// sits, not by parsing the clause in front of it: a comment inside a multi-line import
// (`invoke, // Tauri's IPC`) holds quotes and semicolons, and a clause parser that gives up at the
// first one under-reports. The price is that prose such as `// derived from 'three'` is read as an
// import and flagged, which is the same trade the comment-and-string scan above makes.
//
// Fixture format: tools/check-boundaries.fixtures/ is a miniature repository root (src/engine/...,
// src/hosts/test/...). A planted violation carries one `@expect rule N` marker per violation it
// must produce; a file without markers must come out clean. The self-test compares the two.
//
// Known forms this does not follow (each would need a parser, not a regex): `import.meta.glob`,
// `new URL(spec, import.meta.url)`, `require`, and a specifier spelled with escape sequences
// (`'../app/x.js'`) or holding the other quote character. A string assembled at run time
// and handed to a dynamic import is not followed but is reported, as is a dynamic import whose
// parenthesis never closes.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURES_ROOT = path.join(HERE, 'check-boundaries.fixtures');

const ENGINE_DIR = 'src/engine';
const TEST_HOST_DIR = 'src/hosts/test';
const SCANNED_DIRS = [ENGINE_DIR, TEST_HOST_DIR];
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * @typedef {1 | 2 | 3 | 4 | 5} RuleId
 * @typedef {{ file: string, line: number, rule: RuleId, name: string, message: string }} Violation
 */

/** @type {Record<RuleId, string>} */
const RULE_NAMES = {
  1: 'forbidden-import',
  2: 'bare-import',
  3: 'banned-sink',
  4: 'test-host-tauri',
  5: 'pure-dom',
};

// Rule 2. A Set, not an object literal: a specifier is arbitrary source text and `constructor` or
// `__proto__` must not find an inherited member.
const ALLOWED_BARE = new Set([
  'fflate',
  'jpeg-js',
  'quickjs-emscripten-core',
  '@jitl/quickjs-wasmfile-release-sync',
  '@jitl/quickjs-ng-wasmfile-release-sync',
]);

// Rule 1. Everything an engine import may not resolve into (repo-relative, lower-case: macOS
// volumes are case-insensitive, so `../App/x.js` reaches src/app/ there).
const FORBIDDEN_DIRS = ['src/app', 'src/hosts', 'src/viz'];
const FORBIDDEN_FILES = ['src/main.js', 'src/widgets.js', 'src/player.js', 'src/playlist.js'];

// Rule 3. Literal substrings, as D8 writes them. `isFunction(` trips `Function(` and `prefetch(`
// trips `fetch(`; that is the price of a scan with no parser and the fix is a rename.
const SINKS = [
  'fetch(', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'eval(', 'new Function', 'Function(',
  'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', '__TAURI', 'localStorage',
  'sessionStorage', 'indexedDB',
];
// realm/prelude.js is realm source shipped as a string, so it is the one file allowed to name them.
// The exemption is for rule 3 only; rules 1, 2 and 5 still apply to it.
const SINK_EXEMPT = 'src/engine/realm/prelude.js';

// Rule 5, relative to src/engine/. Directories match by prefix, files exactly.
const PURE_DIRS = ['archive', 'text', 'wms', 'image/decode', 'realm', 'model', 'layout', 'bind', 'anim', 'shape'];
const PURE_FILES = ['image/keying.js', 'image/keyspec.js', 'image/probe.js', 'input/picker.js'];
const DOM_GLOBAL = /\b(?:document|window)\b/g;

// Specifier extraction. `d` gives the position of the specifier so a multi-line import reports the
// line the specifier is on. STATIC_FROM is just `from` followed by a string: nothing is assumed
// about the import or export clause in front of it (see the header). `.from(` is a method and
// `'from'` a string-named binding, so a dot or a quote in front of the word rules it out. A
// comment between the keyword and the specifier counts as whitespace (TRIVIA); a line comment
// must be taken whole, newline included, so the pattern cannot stop in the middle of one and read
// an apostrophe in the comment as the opening quote.
const TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const STATIC_FROM = new RegExp(String.raw`(?<![\w$.'"])from(?![\w$])${TRIVIA}(['"])([^'"\n]*)\1`, 'dg');
const SIDE_EFFECT = new RegExp(String.raw`(?<![\w$.])import${TRIVIA}(['"])([^'"\n]*)\1`, 'dg');
const DYNAMIC_OPEN = new RegExp(String.raw`(?<![\w$.])import${TRIVIA}\(`, 'g');
const LITERAL_ARG = /^\(*\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`)\s*\)*$/;

/** @typedef {{ spec: string | null, index: number }} Ref  spec is null for an unreadable dynamic import */

/**
 * Text of the first argument of a call whose `(` ends just before `start`, or null when the
 * parenthesis never closes (prose, or a syntax error).
 * @param {string} text
 * @param {number} start
 */
function firstArgument(text, start) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 1;
    } else if (c === '/' && text[i + 1] === '/' && /[\s(,]/.test(text[i - 1] ?? ' ')) {
      const end = text.indexOf('\n', i);
      if (end < 0) return null;
      i = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if (c === ',' && depth === 0) {
      return text.slice(start, i);
    }
  }
  return null;
}

/** @param {string} text @returns {Ref[]} */
function extractRefs(text) {
  /** @type {Ref[]} */
  const refs = [];
  for (const m of text.matchAll(STATIC_FROM)) refs.push({ spec: m[2], index: m.indices[2][0] });
  for (const m of text.matchAll(SIDE_EFFECT)) refs.push({ spec: m[2], index: m.indices[2][0] });
  for (const m of text.matchAll(DYNAMIC_OPEN)) {
    const arg = firstArgument(text, m.index + m[0].length);
    if (arg === null) {
      // An unclosed call is a syntax error or a quote the scan lost track of; either way the
      // specifier was not read, and skipping it would let the import through unreported.
      refs.push({ spec: null, index: m.index });
      continue;
    }
    const bare = arg.replace(/\/\*[\s\S]*?\*\/|(?<=^|[\s(])\/\/[^\n]*/g, '').trim();
    // `import()` and `import(...)` in prose are not calls (the empty call is a syntax error).
    if (bare === '' || bare === '...' || bare === '…') continue;
    const lit = LITERAL_ARG.exec(bare);
    refs.push({ spec: lit ? (lit[1] ?? lit[2] ?? lit[3]) : null, index: m.index });
  }
  return refs;
}

/** @param {string} spec */
function isPathSpec(spec) {
  return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
    || (spec.startsWith('/') && !spec.startsWith('//'));
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. @param {string} spec */
function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Repo-relative lower-case path a path specifier resolves to, or null when it leaves the repo. A
 * leading `/` is root-relative, as Vite reads it. Query and hash suffixes (`?url`, `?worker`) are
 * not part of the path.
 * @param {string} fromFile repo-relative, posix
 * @param {string} spec
 */
function resolveSpec(fromFile, spec) {
  const clean = spec.replace(/[?#][\s\S]*$/, '');
  const joined = clean.startsWith('/')
    ? path.posix.normalize(clean.replace(/^\/+/, ''))
    : path.posix.join(path.posix.dirname(fromFile), clean);
  const out = path.posix.normalize(joined).replace(/\/+$/, '').toLowerCase();
  return out === '..' || out.startsWith('../') ? null : out;
}

/** @param {string} resolved lower-case repo-relative path */
function forbiddenTarget(resolved) {
  for (const dir of FORBIDDEN_DIRS) {
    if (resolved === dir || resolved.startsWith(`${dir}/`)) return `${dir}/`;
  }
  for (const file of FORBIDDEN_FILES) {
    if (resolved === file || resolved === file.slice(0, -'.js'.length)) return file;
  }
  return null;
}

/** @param {string} text */
function lineLocator(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (/** @type {number} */ index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** @param {string} s */
const q = (s) => JSON.stringify(s);

/** @param {string} rel path relative to src/engine/ */
function isPure(rel) {
  return PURE_FILES.includes(rel) || PURE_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

/**
 * Check one file's text against every rule its path puts it under.
 * @param {string} file repo-relative path with forward slashes, e.g. `src/engine/wms/scan.js`
 * @param {string} text
 * @returns {Violation[]}
 */
export function checkSource(file, text) {
  const inEngine = file.startsWith(`${ENGINE_DIR}/`);
  const inTestHost = file.startsWith(`${TEST_HOST_DIR}/`);
  if (!inEngine && !inTestHost) return [];

  const lineOf = lineLocator(text);
  /** @type {Violation[]} */
  const found = [];
  /** @param {number} index @param {RuleId} rule @param {string} message */
  const add = (index, rule, message) =>
    found.push({ file, line: lineOf(index), rule, name: RULE_NAMES[rule], message });

  for (const { spec, index } of extractRefs(text)) {
    if (spec === null) {
      if (inEngine) add(index, 2, 'dynamic import() whose specifier is not one plain string literal cannot be checked');
      continue;
    }
    if (isPathSpec(spec)) {
      const hit = inEngine ? forbiddenTarget(resolveSpec(file, spec) ?? '') : null;
      if (hit) add(index, 1, `imports ${q(spec)}, which resolves into ${hit}`);
    } else if (spec === '@tauri-apps' || spec.startsWith('@tauri-apps/')) {
      // One report, not two: a Tauri import is also off the rule-2 list, but the Tauri rule names it.
      if (inEngine) add(index, 1, `imports ${q(spec)}; the engine is Tauri-free`);
      else add(index, 4, `imports ${q(spec)}; the test host must run without Tauri`);
    } else if (inEngine && !ALLOWED_BARE.has(packageName(spec))) {
      add(index, 2, `bare import ${q(spec)} is not on the engine allow-list (${[...ALLOWED_BARE].join(', ')})`);
    }
  }

  if (inEngine && file !== SINK_EXEMPT) {
    /** @type {Map<number, string[]>} line -> tokens, so `new Function(` is one report, not two */
    const byLine = new Map();
    /** @type {Map<number, number>} line -> first index */
    const firstIndex = new Map();
    for (const token of SINKS) {
      for (let i = text.indexOf(token); i !== -1; i = text.indexOf(token, i + 1)) {
        const line = lineOf(i);
        const tokens = byLine.get(line) ?? [];
        if (!tokens.includes(token)) tokens.push(token);
        byLine.set(line, tokens);
        if (!firstIndex.has(line)) firstIndex.set(line, i);
      }
    }
    for (const [line, tokens] of byLine) {
      add(firstIndex.get(line) ?? 0, 3, `banned under src/engine/: ${tokens.map(q).join(', ')}`);
    }
  }

  if (inEngine && isPure(file.slice(ENGINE_DIR.length + 1))) {
    /** @type {Set<number>} */
    const seen = new Set();
    for (const m of text.matchAll(DOM_GLOBAL)) {
      const line = lineOf(m.index);
      if (seen.has(line)) continue;
      seen.add(line);
      add(m.index, 5, `references ${m[0]}; pure directories must run under Node`);
    }
  }

  return found.sort((a, b) => a.line - b.line || a.rule - b.rule);
}

/**
 * Repo-relative paths of the code files under one scanned directory of `root`, sorted.
 * Symlinked directories are not followed; symlinked files are.
 * @param {string} root
 * @param {string} sub
 * @returns {string[]}
 */
function listCode(root, sub) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      if (ent.name === 'node_modules') continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = `${rel}/${ent.name}`;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          isFile = statSync(childAbs).isFile();
        } catch {
          isFile = false;
        }
        isDir = false;
      }
      if (isDir) walk(childAbs, childRel);
      else if (isFile && CODE_FILE.test(ent.name)) out.push(childRel);
    }
  };
  walk(path.join(root, sub), sub);
  return out;
}

/**
 * Scan a tree. `src/hosts/test` may be absent (it does not exist until W2.7); a root with neither
 * scanned directory is a usage error, so a mistyped --root cannot pass silently.
 * @param {string} root
 * @returns {{ violations: Violation[], scanned: string[] }}
 */
export function checkTree(root) {
  const present = SCANNED_DIRS.filter((d) => existsSync(path.join(root, d)));
  if (present.length === 0) {
    throw new UsageError(`${root} has neither ${ENGINE_DIR}/ nor ${TEST_HOST_DIR}/`);
  }
  const scanned = present.flatMap((d) => listCode(root, d));
  const violations = scanned.flatMap((file) => checkSource(file, readFileSync(path.join(root, file), 'utf8')));
  return { violations, scanned };
}

/**
 * @param {string} fixturesRoot
 * @returns {{ ok: boolean, lines: string[], problems: string[], caught: number, clean: number }}
 */
export function selfTest(fixturesRoot) {
  const { violations, scanned } = checkTree(fixturesRoot);
  /** @type {Map<string, Violation[]>} */
  const byFile = new Map();
  for (const v of violations) byFile.set(v.file, [...(byFile.get(v.file) ?? []), v]);

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Set<number>} */
  const planted = new Set();
  let caught = 0;
  let clean = 0;
  for (const file of scanned) {
    const text = readFileSync(path.join(fixturesRoot, file), 'utf8');
    const expected = [...text.matchAll(/@expect rule ([1-5])\b/g)].map((m) => Number(m[1])).sort();
    const found = byFile.get(file) ?? [];
    const got = found.map((v) => v.rule).sort();
    if (expected.join() !== got.join()) {
      problems.push(`${file}: expected rules [${expected.join(', ')}], checker reported [${got.join(', ')}]`);
    } else if (expected.length === 0) {
      clean++;
      lines.push(`clean   ${file}`);
    } else {
      for (const v of found) {
        caught++;
        planted.add(v.rule);
        lines.push(`caught  rule ${v.rule} (${v.name})  ${v.file}:${v.line}`);
      }
    }
  }
  for (const rule of /** @type {RuleId[]} */ ([1, 2, 3, 4, 5])) {
    if (!planted.has(rule)) problems.push(`no fixture plants a caught violation of rule ${rule}`);
  }
  return { ok: problems.length === 0, lines, problems, caught, clean };
}

class UsageError extends Error {}

/** @param {string[]} argv */
function parseArgs(argv) {
  let root = REPO_ROOT;
  let fixtures = FIXTURES_ROOT;
  let selfTestMode = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (flag === '--self-test') {
      selfTestMode = true;
    } else if (flag === '--root' || flag === '--fixtures') {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (!value) throw new UsageError(`${flag} needs a directory`);
      if (flag === '--root') root = path.resolve(value);
      else fixtures = path.resolve(value);
    } else {
      throw new UsageError(`unknown argument ${q(arg)}; usage: check-boundaries.mjs [--root <dir>] [--self-test [--fixtures <dir>]]`);
    }
  }
  return { root, fixtures, selfTestMode };
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  try {
    const { root, fixtures, selfTestMode } = parseArgs(argv);
    if (selfTestMode) {
      const result = selfTest(fixtures);
      for (const line of result.lines) console.log(line);
      for (const problem of result.problems) console.error(`FAIL    ${problem}`);
      if (!result.ok) {
        console.error('check-boundaries --self-test: FAILED');
        return 1;
      }
      console.log(`check-boundaries --self-test: ok, ${result.caught} planted violations caught (rules 1-5), ${result.clean} clean fixtures stayed clean`);
      return 0;
    }
    const { violations, scanned } = checkTree(root);
    if (violations.length === 0) {
      console.log(`check-boundaries: ok (${scanned.length} files scanned)`);
      return 0;
    }
    for (const v of violations) console.error(`${v.file}:${v.line}: rule ${v.rule} (${v.name}): ${v.message}`);
    const files = new Set(violations.map((v) => v.file)).size;
    console.error(`check-boundaries: ${violations.length} violation(s) in ${files} file(s), ${scanned.length} files scanned`);
    return 1;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`check-boundaries: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
