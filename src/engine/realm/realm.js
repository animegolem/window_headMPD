// @ts-check
// The script realm of ENGINE D1 (§5.5 `createRealm`): QuickJS compiled to WASM, the synchronous variant,
// one module instance per skin session and one context per VIEW, behind the copy-only membrane.
//
// The pieces, in the order a view uses them:
//   - `createRealm` instantiates a fresh module, sets the memory and stack caps and the interrupt
//     handler, and boots the prelude (prelude.js) with the one native function of the membrane
//     (membrane.js). The native function is passed to the prelude as an argument, so it is never a
//     property of the realm global. The only prelude globals are `__IDS`, `__wmp_badAssign` and
//     `__wmp_src` (the loader's slot), all locked; the handler compiler, the `jscript:` evaluator, the
//     timer table and the dispatcher live in the boot closure and the entry object the host holds.
//   - `setIds`, `loadScript`, `evalExpression`, `runHandler`, `fireTimer`, `callGlobal` are the entry
//     points. Each runs under a wall-clock budget (E §10), drains the Promise job queue under the same
//     budget (at most 1,000 jobs), and turns what happened into `Ok` or a `Fault`.
//   - Faults (D1 "Budgets and faults"). Soft: an exception in skin code, a syntax error, a membrane
//     cap, the `_onchange` chain cap, re-entry. Each aborts one dispatch, is counted, and is logged once
//     per (site, reason). Hard: the budget (QuickJS's interrupt, a slow-builtin guard trip, E R19, or an
//     entry that ran past its deadline by more than `overrunSlackMs` without either firing), memory,
//     stack, the prelude failing, a host exception or abort out of the WASM call, or the duty cycle. One
//     OOM, abort or host exception unloads at once; so do 3 hard faults within 30 s.
//   - Memory (E §10 "WASM heap"). QuickJS's own memory limit counts per-allocation overhead, not size
//     (G2 review DOS-1), so it is not used. The module runs on a capped `WebAssembly.Memory` instead, and
//     memory is judged from that heap alone, never from what skin code threw (F5): an allocation the
//     capped heap refused, or a heap grown past `heapCap`, ends the entry as a hard 'memory' fault even
//     when skin code caught the error (DOS-6). A single request beyond the wasm32 address space is
//     refused before the heap is touched; it stays an ordinary soft exception.
//   - The fault domain: after any of those, or any hard fault at all, the instance is DISCARDED at
//     unload (every reference dropped, `dispose` never called), because a leaked handle or an
//     interrupted allocation makes `JS_FreeRuntime` abort the module (cand-F probe-1, RG0 item 6). Only
//     a realm with no hard fault disposes, inside a try/catch, and is discarded if even that throws.
//   - No synchronous re-entry: a host op never runs skin code before it returns. When the host calls
//     `runHandler` or `fireTimer` while an entry is running (an `_onchange` its own `set` queued, say),
//     the call is queued and dispatched FIFO after the outer entry returns, one level deeper than the
//     entry that caused it; past depth 32 the chain stops with a soft fault (D1, the slider ping-pong).
//     `evalExpression`, `callGlobal` and `loadScript` return values, so a re-entrant call to one is a
//     soft fault instead, and so is a re-entrant `setIds` (ids are set once per view, before any dispatch).
//     `readGlobal` reads a data property and runs no skin code (it drains no Promise jobs either), so it
//     is allowed. The whole drain of queued dispatches is bounded by `budgets.load` of wall time.
//   - Promise jobs drain after each entry under its budget, at most 1,000. Jobs an entry leaves past
//     that cap never run under the next entry (G2 review DOS-8, S2): before the next entry starts they
//     run as an entry of their own, site 'jobs', without the gesture; a flood that outlives that drain
//     too is a hard fault there.
//   - Duty cycle: realm time is summed per 1 s slice of wall time. Over 50% for 5 consecutive slices
//     throttles the realm (timer floor 40 ms, `health.dutyThrottled`; the host drops position
//     listeners to 2 Hz); over 80% for 10 consecutive slices is a hard fault. The throttle is sticky.
//   - The budget clock is `opts.wallClock`, never the engine clock, so a frozen test clock cannot
//     disable the interrupt.
//
// Script loading (D1 "Script files", E R20): each file is compiled first (compile only). If QuickJS
// rejects it with "invalid assignment left-hand side" at line L, the one `<call> = <rhs>` on L becomes
// `__wmp_badAssign()` (it throws `TypeError('Cannot assign to a function result')` at run time), at
// most 32 times per file, each a `script-rewrite` diagnostic; any other syntax error loses the file.
// A QuickJS compile never polls the interrupt, so a file over `maxScriptChars` is refused, a file is
// refused outright once the view's scripts budget is spent, and the deadline is checked before every
// compile: running out of time is a hard 'budget' fault, never a syntax diagnostic (G2 DOS-3).
// The repaired text is then loaded by global code that runs it through a direct eval inside
// `with(__IDS)` (prelude.js `LOADER_SOURCE`). `repairScript` is exported so the corpus gate measures
// the same repair the loader performs.
//
// The membrane's `has` sets come from `classMembers` and `setIds`. `setIds` carries no per-element list
// of markup attributes, so an element proxy's `has` answers from its class members only; a view runtime
// that wants a markup-only attribute in scope registers it as a member of a class of its own.
//
// Diagnostics the realm emits are capped per code and view (E §10 "realm diagnostics"): 64, then one
// `<code>-capped`, so no skin can grow the host log without bound (G2 DOS-7, F7).

import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { MEMBRANE_CAPS, checkWire, createMembrane, isHandleNumber } from './membrane.js';
import { HOST_GLOBAL_NAMES, LOADER_SOURCE, PRELUDE_SOURCE } from './prelude.js';
import { wmplocConstants } from './wmploc.js';

/** @typedef {import('../contracts').CreateRealmFn} CreateRealmFn */
/** @typedef {import('../contracts').Realm} Realm */
/** @typedef {import('../contracts').RealmOptions} RealmOptions */
/** @typedef {import('../contracts').Fault} Fault */
/** @typedef {import('../contracts').Wire} Wire */
/** @typedef {import('../contracts').HandlerSite} HandlerSite */
/** @typedef {import('../contracts').WmplocLibrary} WmplocLibrary */

/** The realm's own caps (E §10), beside the membrane's. */
export const REALM_CAPS = Object.freeze({
  maxLiveTimers: 64,
  timerFloorMs: 10,
  throttledTimerFloorMs: 40,
  maxTimerMs: 2 ** 31 - 1,
  maxChainDepth: 32,
  maxQueued: 4096,
  maxJobsPerDrain: 1000,
  hardFaultWindowMs: 30_000,
  hardFaultsToUnload: 3,
  maxRewritesPerFile: 32,
  dutySliceMs: 1000,
  dutyThrottleRatio: 0.5,
  dutyThrottleSlices: 5,
  dutyFaultRatio: 0.8,
  dutyFaultSlices: 10,
  maxScriptChars: 1024 * 1024,
  overrunSlackMs: 300,
  maxIdWriteDiags: 64,
  maxDiagsPerStream: 64,
});

/** The variant's own initial linear memory: the glue's `INITIAL_MEMORY || 16777216` (emscripten-module.mjs). */
const VARIANT_INITIAL_MEMORY = 16 * 1024 * 1024;
const WASM_PAGE = 65536;
/** The glue's own ceiling, 2 GiB (emscripten-module.mjs: `maximum: 32768` pages). */
const MAX_WASM_PAGES = 32768;
/** Failed growths per refused request: the glue tries 1.2x, 1.1x and 1.05x (or the request) and then gives up. */
const GROW_ATTEMPTS = 3;

/** Hard-fault reasons that unload at once (D1: one OOM or abort), whatever the count. */
const UNLOAD_AT_ONCE = new Set(['memory', 'abort', 'host-exception', 'prelude']);

/** @type {Ok} */
const OK_VOID = Object.freeze({ ok: true, value: undefined });
/** @type {Failure} */
const MEMORY = Object.freeze({ ok: false, kind: 'hard', reason: 'memory' });
/** @type {Failure} */
const BUDGET = Object.freeze({ ok: false, kind: 'hard', reason: 'budget' });
/** What `callEntry` returns instead of calling into a heap that ran out. */
const HEAP_GONE = Object.freeze({ heapGone: true });
/** @typedef {{ ok: true, value: any }} Ok */
/** @typedef {{ ok: false, kind: 'soft' | 'hard', reason: string }} Failure */
/** @typedef {Ok | Failure} Outcome */

/** @param {string} s @param {number} [max] */
const clip = (s, max = 300) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * A realm error dumped to the host, as a fault outcome. Budget and stack exhaustion are hard; everything
 * else a skin can throw is soft. Memory is never read from the thrown value (G2 F5): a skin can throw or
 * rethrow an 'out of memory' error of its own, and a real OOM is seen on the heap (`heapExhausted`).
 * A look-alike of the interrupt is turned back into a soft fault by `enter` unless the interrupt really
 * fired. A look-alike of a stack overflow stays hard: no host-visible signal tells it from a real one, and
 * a skin can cause a hard fault at will anyway, so the only effect is on its own view.
 * @param {unknown} err
 * @returns {Failure}
 */
function classifyError(err) {
  const e = /** @type {any} */ (err);
  const isObj = typeof e === 'object' && e !== null;
  const name = isObj && typeof e.name === 'string' ? e.name : '';
  const message = isObj && typeof e.message === 'string' ? e.message : '';
  if (name === 'InternalError') {
    if (/interrupted/.test(message)) return { ok: false, kind: 'hard', reason: 'budget' };
    if (/stack overflow/.test(message)) return { ok: false, kind: 'hard', reason: 'stack' };
  }
  if (name === 'RangeError' && /call stack/.test(message)) return { ok: false, kind: 'hard', reason: 'stack' };   // quickjs-ng's wording
  const text = isObj && (name || message) ? `${name || 'Error'}: ${message}` : `uncaught ${String(e)}`;
  return { ok: false, kind: 'soft', reason: clip(text) };
}

/** @param {Outcome} a @param {Outcome} b @returns {Outcome} the more severe of two outcomes */
const worse = (a, b) => {
  if (b.ok === true) return a;
  if (a.ok === true) return b;
  return b.kind === 'hard' && a.kind !== 'hard' ? b : a;
};

// ---------------------------------------------------------------------------------------------
// Call-assignment repair (E R20)

/**
 * Line and column of a QuickJS syntax error. The line is QuickJS's own `lineNumber`. The column is read
 * from the stack frame of the file that was compiled, right after its `fileName`, so a file name that
 * itself holds `:<n>:<n>` cannot move it (G2 F8); without a `fileName`, from the `:L:C` that ends the
 * frame's line.
 * @param {{ lineNumber?: unknown, stack?: unknown, fileName?: unknown }} err
 * @returns {{ line: number | null, column: number | null }}
 */
export function errorPosition(err) {
  /** @type {RegExpExecArray | null} */
  let m = null;
  if (typeof err.stack === 'string') {
    if (typeof err.fileName === 'string' && err.fileName !== '') {
      const at = err.stack.indexOf(`at ${err.fileName}:`);
      if (at >= 0) m = /^(\d+):(\d+)/.exec(err.stack.slice(at + err.fileName.length + 4));
    } else {
      m = /:(\d+):(\d+)\)?[ \t]*(?:\n|$)/.exec(err.stack);
    }
  }
  const line = typeof err.lineNumber === 'number' ? err.lineNumber : m ? Number(m[1]) : null;
  return { line, column: m ? Number(m[2]) : null };
}

/** @param {string} c */
const isIdentChar = (c) => /[\w$]/.test(c);

/**
 * Words that make `word(...)` no call (`return (a + b) = 1`, `typeof (x) = 1`), unless used as a property
 * name. One string, so the boundary checker does not read a quoted keyword as an import specifier.
 */
const KEYWORDS = new Set(('await break case catch class const continue debugger default delete do else export extends finally for '
  + 'function if import in instanceof let new of return super switch throw try typeof var void while with yield').split(' '));
/** Words an expression statement may follow (`return f(a) = 1`, `else f(a) = 1`). */
const LEAD_WORDS = new Set(['return', 'else', 'do', 'case', 'throw']);

/** @param {string} text @param {number} end index of the word's last character @returns {{ word: string, start: number }} */
const wordEndingAt = (text, end) => {
  let s = end;
  while (s > 0 && isIdentChar(text[s - 1])) s--;
  return { word: text.slice(s, end + 1), start: s };
};

/**
 * Whether an assignment expression may start right after `text[b]`, the last non-space character before
 * a left side: a statement boundary or bracket, a ternary branch, an assignment (plain or compound, not a
 * comparison), an arrow, or a word such as `return`. After any other operator (`x + f(a) = 1`,
 * `a && f(a) = 1`, `!f(a) = 1`) the left side is not a whole call, V8 rejects the text too, and the file
 * is lost as before (G2 S4).
 * @param {string} text @param {number} b
 */
const expressionMayStartAfter = (text, b) => {
  if (b < 0) return true;
  const c = text[b];
  if (isIdentChar(c)) return LEAD_WORDS.has(wordEndingAt(text, b).word);
  if (';{}([,:)'.includes(c)) return true;
  if (c === '?') return text[b - 1] !== '?';                          // a ternary, not `??`
  if (c === '>') return text[b - 1] === '=';                          // `=>`
  if (c !== '=') return false;
  const p = text[b - 1];
  if (p === '=' || p === '!') return false;                           // `==`, `===`, `!=`, `!==`
  if (p === '<' || p === '>') return text[b - 2] === p;               // `<<=`, `>>=`, `>>>=`, not `<=`, `>=`
  return true;
};

/**
 * Rewrite the one `<call> = <rhs>` on 1-based line `line` into `__wmp_badAssign()`. The `=` chosen is
 * the last plain assignment before `column` (QuickJS reports the token after it) whose left side ends
 * in a call; the left side extends back over the member chain (`a.b(c).d(e)`), the right side forward
 * to the end of the expression (`;`, `,`, a closing bracket or an unmatched ternary `:` at depth 0, a
 * comment, or the line end). Null when the line holds no such statement: when no candidate stands before
 * a known column (the `=` is then on an earlier line), or when the left side is not a whole call
 * expression (G2 S4: `(a + b) = 1`, `x + f(a) = 1`, `new Foo(x) = 1`).
 * @param {string} source
 * @param {number} line
 * @param {number | null} column
 * @returns {{ source: string, statement: string } | null}
 */
export function rewriteCallAssignment(source, line, column) {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const nl = source.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const nl = source.indexOf('\n', start);
  const end = nl < 0 ? source.length : nl;
  const text = source.slice(start, end);

  // One forward pass over the line: string and comment state, bracket pairs, candidate `=`s.
  /** @type {Map<number, number>} close index -> open index */
  const pairs = new Map();
  /** @type {Map<number, number>} open index -> close index */
  const opens = new Map();
  /** @type {number[]} */
  const stack = [];
  /** @type {number[]} */
  const candidates = [];
  /** @type {string | null} */
  let quote = null;
  let codeEnd = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && text[i + 1] === '/') { codeEnd = i; break; }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) { codeEnd = i; break; }
      i = close + 1;
      continue;
    }
    if (c === '(' || c === '[') stack.push(i);
    else if (c === ')' || c === ']') {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(i, open);
        opens.set(open, i);
      }
    } else if (c === '=' && text[i + 1] !== '=' && text[i + 1] !== '>' && !/[=!<>+\-*/%&|^?]/.test(text[i - 1] ?? '')) {
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j--;
      if (text[j] === ')' && pairs.has(j)) candidates.push(i);
    }
  }
  if (candidates.length === 0) return null;
  const limit = column === null ? Infinity : column - 1;
  const before = candidates.filter((i) => i < limit);
  // G2 F8: with a known column and nothing before it, the `=` is not on this line (`f() =\n 1`); the
  // caller then tries the line before. Without a column (that fallback), the last candidate.
  if (column !== null && before.length === 0) return null;
  const eq = before.length ? before[before.length - 1] : candidates[candidates.length - 1];

  // Left side: back from the `)` over the callee chain.
  let j = eq - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  let k = /** @type {number} */ (pairs.get(j)) - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;             // `f (x)` as well as `f(x)`
  // What stands before the `(` must make it a call: a callee name that is not a keyword (a property
  // named like one, `a.return(x)`, is fine), or the `)` or `]` of an earlier call or member.
  if (k < 0) return null;
  if (isIdentChar(text[k])) {
    const w = wordEndingAt(text, k);
    if (KEYWORDS.has(w.word) && text[w.start - 1] !== '.') return null;
  } else if (!((text[k] === ')' || text[k] === ']') && pairs.has(k))) return null;
  while (k >= 0) {
    const c = text[k];
    if (isIdentChar(c) || c === '.') k--;
    else if ((c === ')' || c === ']') && pairs.has(k)) k = /** @type {number} */ (pairs.get(k)) - 1;
    else break;
  }
  let lhsStart = k + 1;
  if (text[lhsStart] === '.') return null;                 // `a?.f(x) = 1`: an optional chain
  let b = k;
  while (b >= 0 && /\s/.test(text[b])) b--;
  if (b >= 0 && isIdentChar(text[b]) && wordEndingAt(text, b).word === 'new') {
    // `new Foo(x).bar(y)` is a call; `new Foo(x)` alone is a construction, which V8 rejects as a target.
    let calls = 0;
    for (let i = lhsStart; i <= j;) {
      const close = opens.get(i);
      if (close === undefined) { i++; continue; }
      if (text[i] === '(') calls++;
      i = close + 1;
    }
    if (calls < 2) return null;
    lhsStart = wordEndingAt(text, b).start;
    b = lhsStart - 1;
    while (b >= 0 && /\s/.test(text[b])) b--;
  }
  if (!expressionMayStartAfter(text, b)) return null;

  // Right side: forward to the end of the assignment expression.
  let depth = 0;
  let ternaries = 0;                                       // `?`s of the right side still waiting for their `:`
  /** @type {string | null} */
  let q = null;
  let r = eq + 1;
  for (; r < codeEnd; r++) {
    const c = text[r];
    if (q) {
      if (c === '\\') r++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((c === ';' || c === ',') && depth === 0) break;
    else if (c === '?' && depth === 0) {
      if (text[r + 1] === '?') r++;                        // `??`
      else if (text[r + 1] !== '.') ternaries++;           // not `?.`
    } else if (c === ':' && depth === 0) {
      if (ternaries === 0) break;                          // the `:` of a ternary the assignment sits in
      ternaries--;
    }
  }
  let rhsEnd = Math.min(r, codeEnd);
  while (rhsEnd > eq + 1 && /\s/.test(text[rhsEnd - 1])) rhsEnd--;
  const statement = text.slice(lhsStart, rhsEnd);
  const rewritten = `${text.slice(0, lhsStart)}__wmp_badAssign()${text.slice(rhsEnd)}`;
  return { source: source.slice(0, start) + rewritten + source.slice(end), statement };
}

/**
 * @typedef {{ name?: unknown, message?: unknown, lineNumber?: unknown, stack?: unknown, fileName?: unknown }} CompileError
 * @typedef {{ source: string, rewrites: Array<{ line: number, statement: string }>,
 *   error: null | { name: string, message: string, line: number | null }, stopped?: boolean }} RepairResult
 */

/**
 * Compile a script file, rewriting call assignments until it compiles (E R20). `compile` returns null
 * when the text compiles, else the dumped realm error. Any error other than "invalid assignment
 * left-hand side", a line with no call assignment on it, or a 33rd rewrite ends the repair with
 * `error` set: the file is lost. `stop`, asked before every compile, ends the repair with `stopped`
 * set (the loader's deadline: a compile cannot be interrupted, G2 DOS-3).
 * @param {string} source
 * @param {(src: string) => CompileError | null} compile
 * @param {{ maxRewrites?: number, stop?: () => boolean }} [opts]
 * @returns {RepairResult}
 */
export function repairScript(source, compile, opts = {}) {
  const max = opts.maxRewrites ?? REALM_CAPS.maxRewritesPerFile;
  let src = source;
  /** @type {RepairResult['rewrites']} */
  const rewrites = [];
  for (;;) {
    if (opts.stop?.()) return { source: src, rewrites, error: null, stopped: true };
    const err = compile(src);
    if (!err) return { source: src, rewrites, error: null };
    const name = typeof err.name === 'string' ? err.name : 'Error';
    const message = typeof err.message === 'string' ? err.message : String(err.message ?? '');
    const { line, column } = errorPosition(err);
    const lost = { source: src, rewrites, error: { name, message, line } };
    if (name !== 'SyntaxError' || message !== 'invalid assignment left-hand side' || line === null) return lost;
    if (rewrites.length >= max) return lost;
    // QuickJS reports the token after the `=`; when that token starts the next line, the `=` is on the one before.
    const next = rewriteCallAssignment(src, line, column) ?? (line > 1 ? rewriteCallAssignment(src, line - 1, null) : null);
    if (next === null) return lost;
    rewrites.push({ line, statement: next.statement });
    src = next.source;
  }
}

/**
 * Source text for a wmploc script library (`ScriptEntry.library`), for a loader that installs a
 * listed `#134`, `#136` or `#169` with `loadScript`: the constants as `var` declarations, then its
 * own source. `#132` is installed by the prelude whether or not it is listed.
 * @param {WmplocLibrary} library
 * @returns {string}
 */
export function librarySource(library) {
  let text = '';
  for (const [name, value] of Object.entries(library.constants)) {
    if (/^[A-Za-z_$][\w$]*$/.test(name)) text += `var ${name} = ${JSON.stringify(value)};\n`;
  }
  return text + library.source;
}

// ---------------------------------------------------------------------------------------------
// The realm

/**
 * Debug view of a realm for tests and the fault panel's health check: not part of the contract.
 * `heap` is the linear memory: its size now, the cap past which the realm faults, and its hard maximum.
 * @type {WeakMap<object, { objectCount(): number | null, state(): 'live' | 'disposed' | 'discarded', queued(): number, liveTimers(): number,
 *   heap(): { bytes: number, cap: number, max: number } }>}
 */
const debugViews = new WeakMap();

/**
 * Introspection a test or a health check may use; null for an object that is not a realm.
 * @param {Realm} realm
 */
export const realmDebug = (realm) => debugViews.get(realm) ?? null;

/** @type {CreateRealmFn} */
export const createRealm = async (opts) => {
  const { dispatcher, log, wallClock, budgets } = opts;
  const viewKey = String(opts.viewKey);

  // The heap (E §10 "WASM heap", G2 DOS-1). QuickJS's own memory limit counts only per-allocation
  // overhead under emscripten, so a skin could grow the heap to 2 GiB; the cap is put on the linear
  // memory instead. Its maximum sits 1/16 above `heapCap` because the glue grows by at least 5% at a
  // time, so an allocation can only be refused for growth once the heap is already past the cap. A
  // missing or non-finite limit fails closed: the variant's initial memory is all there is.
  const limit = Number.isFinite(opts.memoryLimitBytes) && opts.memoryLimitBytes > 0 ? opts.memoryLimitBytes : 0;
  const heapCap = VARIANT_INITIAL_MEMORY + limit;
  const maxPages = Math.min(MAX_WASM_PAGES, Math.ceil((heapCap + heapCap / 16) / WASM_PAGE));
  const wasmMemory = new WebAssembly.Memory({ initial: VARIANT_INITIAL_MEMORY / WASM_PAGE, maximum: maxPages });
  // The allocator's own word that memory ran out (F5, DOS-6): the glue's `grow` calls on this memory.
  // A request the heap refuses fails GROW_ATTEMPTS growths in a row; one that succeeds after a smaller
  // retry resets the count.
  let growFailures = 0;
  let allocFailed = false;
  const realGrow = wasmMemory.grow;
  Object.defineProperty(wasmMemory, 'grow', {
    value(/** @type {number} */ pages) {
      try {
        const r = realGrow.call(wasmMemory, pages);
        growFailures = 0;
        return r;
      } catch (e) {
        if (++growFailures >= GROW_ATTEMPTS) allocFailed = true;
        throw e;
      }
    },
  });
  /** True once memory ran out in this realm: a refused allocation, or a heap past the cap. */
  const heapExhausted = () => allocFailed || wasmMemory.buffer.byteLength > heapCap;

  /** @type {any} */ let mod = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory }));
  // A variant that ignored the memory (a CJS `{default}` wrapper does, silently) would run uncapped.
  if (mod.getWasmMemory() !== wasmMemory) throw new Error('realm: the QuickJS module did not take the capped memory');
  /** @type {any} */ let rt = mod.newRuntime();
  rt.setMaxStackSize(opts.maxStackBytes);
  /** @type {any} */ let ctx = rt.newContext();
  /** @type {any} */ let entry = null;
  /** @type {any} */ let sentinel = null;

  /** @type {'live' | 'disposed' | 'discarded'} */
  let state = 'live';
  // Set the moment the WASM call itself failed (an exception escaped it, or memory ran out): from then
  // on nothing touches the context again, not even to free a handle.
  let poisoned = false;
  let deadline = Infinity;
  let interrupts = 0;
  let guardTripped = false;
  let active = 0;
  let chainDepth = 0;
  let gestureDepth = 0;
  /** @type {'script' | null} */
  let phase = null;
  let scriptsSpent = 0;
  /** @type {string | null} */
  let pendingUnload = null;
  let pendingDiscard = false;
  const health = { soft: 0, hard: 0, unloaded: false, dutyThrottled: false };
  /** @type {number[]} */
  const hardTimes = [];
  /** @type {Set<string>} */
  const faultsLogged = new Set();
  /** @type {Array<{ kind: 'handler', el: number, site: HandlerSite, ctx: any, depth: number } | { kind: 'timer', id: number, depth: number }>} */
  const queue = [];
  let draining = false;

  /** @type {Map<number, { ms: number, repeat: boolean }>} */
  const liveTimers = new Map();
  let timerCapLogged = false;
  /** Ids written while a script file loads, reported after its collision check (G2 S3). @type {Set<string>} */
  const scriptIdWrites = new Set();

  /** @type {Map<string, { id: number, source: string, params: string, compiled: boolean, error: string | null }>} */
  const handlerCache = new Map();
  let nextHandlerId = 1;

  /** Handles the realm must never revoke after a dispatch: host globals and ids. */
  /** @type {Set<number>} */
  const permanent = new Set();

  // Duty cycle bookkeeping, in wall-clock slices.
  let sliceStart = wallClock();
  let sliceBusy = 0;
  let over50 = 0;
  let over80 = 0;

  // A broken log must not take the realm down, so every log call goes through these. Each diagnostic
  // code is one stream, capped per view (E §10, G2 DOS-7): past the cap one `<code>-capped` and then
  // nothing. Codes are the realm's own constants, never skin text.
  /** @type {Map<string, number>} */
  const diagCounts = new Map();
  /** @param {import('../contracts').Diagnostic} d */
  const diag = (d) => {
    const cap = d.code === 'realm-id-write' ? REALM_CAPS.maxIdWriteDiags : REALM_CAPS.maxDiagsPerStream;
    const n = (diagCounts.get(d.code) ?? 0) + 1;
    if (n > cap + 1) return;
    diagCounts.set(d.code, n);
    const out = n <= cap ? d : { code: `${d.code}-capped`, severity: /** @type {const} */ ('warn'), detail: `${viewKey}: more than ${cap} '${d.code}' diagnostics; the rest are not reported` };
    try {
      log.diag(out);
    } catch {
      // dropped
    }
  };
  /** @param {'info' | 'warn'} level @param {string} m @param {object} [d] */
  const say = (level, m, d) => {
    try {
      log[level](m, d);
    } catch {
      // dropped
    }
  };

  rt.setInterruptHandler(() => {
    // Out of memory ends the entry too; `enter` reports it as 'memory', not as the budget.
    if (heapExhausted()) return true;
    if (wallClock() > deadline) {
      interrupts++;
      return true;
    }
    return false;
  });

  const membrane = createMembrane({
    ctx,
    dispatcher,
    log,
    hooks: {
      heapOver: heapExhausted,
      guard() {
        if (wallClock() > deadline) {
          guardTripped = true;
          return true;
        }
        return false;
      },
      timerSet(id, ms, repeat) {
        if (!liveTimers.has(id) && liveTimers.size >= REALM_CAPS.maxLiveTimers) {
          if (!timerCapLogged) {
            timerCapLogged = true;
            diag({ code: 'realm-timer-cap', severity: 'warn', detail: `${viewKey}: more than ${REALM_CAPS.maxLiveTimers} live timers; the extra ones are refused` });
          }
          return false;
        }
        const floor = health.dutyThrottled ? REALM_CAPS.throttledTimerFloorMs : REALM_CAPS.timerFloorMs;
        const eff = Math.min(Math.max(ms, floor), REALM_CAPS.maxTimerMs);
        try {
          dispatcher.timer('set', id, eff, repeat);
        } catch (e) {
          say('warn', 'realm: dispatcher.timer threw', { viewKey, message: String(/** @type {any} */ (e)?.message ?? e) });
          return false;
        }
        liveTimers.set(id, { ms: eff, repeat });
        return true;
      },
      timerClear(id) {
        if (!liveTimers.delete(id)) return;
        try {
          dispatcher.timer('clear', id, 0, false);
        } catch {
          // the realm side has already forgotten it
        }
      },
      diag(code, detail) {
        if (code !== 'id-write') return;
        // While a script file loads, the write waits for the loader: a top-level `var x` naming an id is
        // reported by its collision check, any other write as `script-id-write` (G2 S3).
        if (phase === 'script') {
          if (scriptIdWrites.size <= REALM_CAPS.maxDiagsPerStream) scriptIdWrites.add(detail);
          return;
        }
        diag({ code: 'realm-id-write', severity: 'warn', elementId: detail, detail: `an assignment to the id '${clip(detail, 80)}' goes nowhere: ids beat script globals (U-31)` });
      },
    },
  });

  // ---- low-level calls into the prelude's entry object ---------------------------------------

  /**
   * Call one entry method. `plain` are host-built values (numbers, booleans, and source text, which
   * is not membrane traffic and has no 64 KiB cap); `wires` are skin-facing values, already checked.
   * @param {string} method @param {Array<number | string | boolean>} plain @param {Wire[]} [wires]
   */
  const callEntry = (method, plain, wires = []) => {
    // Nothing is copied into a heap that ran out: quickjs-emscripten writes a string through the NULL
    // a failed malloc returns, at address 0 (G2 DOS-1).
    if (heapExhausted()) return HEAP_GONE;
    /** @type {any[]} */
    const handles = [];
    for (const v of plain) {
      handles.push(typeof v === 'number' ? ctx.newNumber(v) : typeof v === 'string' ? ctx.newString(v) : v ? ctx.true : ctx.false);
    }
    for (const w of wires) handles.push(membrane.toRealm(w));
    try {
      return ctx.callMethod(entry, method, handles);
    } catch (e) {
      poisoned = true;
      throw e;
    } finally {
      if (!poisoned) for (const h of handles) h.dispose();
    }
  };

  /**
   * A thrown value as plain data for `classifyError`. A Promise is never dumped: quickjs-emscripten's
   * dump disposes promise handles itself (and nested ones twice), while the caller still owns this one,
   * so `throw Promise.resolve(1)` used to end as a host-side use-after-free (G2 F2).
   * @param {any} h
   */
  const dumpThrown = (h) => {
    const s = ctx.getPromiseState(h);
    if (s.notAPromise) return ctx.dump(h);
    if (s.type === 'fulfilled') s.value.dispose();
    else if (s.type === 'rejected') s.error.dispose();
    return 'a Promise';
  };

  /**
   * Read a call result, freeing it: the value through `read`, or the error classified. Once memory ran
   * out nothing is read or freed: the heap decides the outcome, whatever was thrown (F5).
   * @param {any} r @param {((h: any) => Outcome) | null} read
   * @returns {Outcome}
   */
  const settle = (r, read) => {
    if (r === HEAP_GONE || heapExhausted()) {
      poisoned = true;
      return MEMORY;
    }
    if (r.error) {
      const outcome = classifyError(dumpThrown(r.error));
      if (!poisoned) r.error.dispose();
      return outcome;
    }
    try {
      return read ? read(r.value) : OK_VOID;
    } finally {
      r.value.dispose();
    }
  };

  /** @param {any} h @returns {Outcome} */
  const readWire = (h) => {
    const c = membrane.fromRealm(h);
    if (c.ok === true) return { ok: true, value: c.value };
    return { ok: false, kind: 'soft', reason: `Error: membrane: ${c.reason === 'string' ? 'string longer than 65536 characters' : 'value cannot cross'}` };
  };

  /**
   * Run the Promise jobs the entry queued, one at a time, at most `maxJobsPerDrain`, under its budget.
   * One at a time because a reaction job turns the interrupt into a rejection and QuickJS would carry on
   * with the next job: the drain stops at the first trip instead (G2 DOS-8). Jobs left past the cap are a
   * fault of `floodKind` here and run as their own entry before the next one (`enter`).
   * @param {number} interruptsBefore @param {'soft' | 'hard'} floodKind
   * @returns {Outcome}
   */
  const drainJobs = (interruptsBefore, floodKind) => {
    for (let n = 0; n < REALM_CAPS.maxJobsPerDrain && rt.hasPendingJob(); n++) {
      if (interrupts > interruptsBefore || guardTripped || heapExhausted()) return OK_VOID;     // enter() turns it into the fault
      const r = rt.executePendingJobs(1);
      if (r.error) {
        if (heapExhausted()) {
          poisoned = true;
          return MEMORY;
        }
        const outcome = classifyError(dumpThrown(r.error));
        if (!poisoned) r.error.dispose();
        return outcome;
      }
    }
    if (rt.hasPendingJob() && interrupts === interruptsBefore && !guardTripped && !heapExhausted()) {
      return { ok: false, kind: floodKind, reason: `more than ${REALM_CAPS.maxJobsPerDrain} pending jobs` };
    }
    return OK_VOID;
  };

  // ---- duty cycle -------------------------------------------------------------------------------

  const throttle = () => {
    health.dutyThrottled = true;
    diag({ code: 'realm-throttled', severity: 'warn', detail: `${viewKey}: script time above ${REALM_CAPS.dutyThrottleRatio * 100}% of wall time for ${REALM_CAPS.dutyThrottleSlices} s; timers floored at ${REALM_CAPS.throttledTimerFloorMs} ms` });
    for (const [id, t] of liveTimers) {
      if (!t.repeat || t.ms >= REALM_CAPS.throttledTimerFloorMs) continue;
      t.ms = REALM_CAPS.throttledTimerFloorMs;
      try {
        dispatcher.timer('clear', id, 0, false);
        dispatcher.timer('set', id, t.ms, true);
      } catch {
        // keep going: the others still need the new floor
      }
    }
  };

  /** Close the current slice. @returns {boolean} true when this closes the 10th slice over 80% */
  const closeSlice = () => {
    const ratio = sliceBusy / REALM_CAPS.dutySliceMs;
    sliceStart += REALM_CAPS.dutySliceMs;
    sliceBusy = 0;
    over50 = ratio > REALM_CAPS.dutyThrottleRatio ? over50 + 1 : 0;
    over80 = ratio > REALM_CAPS.dutyFaultRatio ? over80 + 1 : 0;
    if (over50 >= REALM_CAPS.dutyThrottleSlices && !health.dutyThrottled) throttle();
    if (over80 >= REALM_CAPS.dutyFaultSlices) {
      over80 = 0;
      return true;
    }
    return false;
  };

  /** Account realm time [start, end). @returns {boolean} true when the duty cycle faults */
  const recordBusy = (start, end) => {
    const S = REALM_CAPS.dutySliceMs;
    let fault = false;
    if (start >= sliceStart + S) {
      fault = closeSlice() || fault;
      // A long idle gap: every slice in it was empty, so the counters start over.
      if (start >= sliceStart + S) {
        over50 = 0;
        over80 = 0;
        sliceStart += Math.floor((start - sliceStart) / S) * S;
      }
    }
    let t = Math.max(start, sliceStart);
    while (end > sliceStart + S) {
      sliceBusy += sliceStart + S - t;
      t = sliceStart + S;
      fault = closeSlice() || fault;
    }
    sliceBusy += Math.max(0, end - t);
    return fault;
  };

  // ---- faults and unload ---------------------------------------------------------------------

  /** @param {string} site @param {Failure} f @returns {Fault} */
  const recordFault = (site, f) => {
    /** @type {Fault} */
    const fault = { ok: false, kind: f.kind, reason: f.reason, site };
    const key = `${site}\u0000${f.reason}`;
    if (f.kind === 'soft') health.soft++;
    else health.hard++;
    if (!faultsLogged.has(key) && faultsLogged.size < 4096) {
      faultsLogged.add(key);
      diag({ code: f.kind === 'soft' ? 'realm-soft-fault' : 'realm-hard-fault', severity: f.kind === 'soft' ? 'warn' : 'error', detail: `${viewKey} ${site}: ${f.reason}` });
    }
    if (f.kind === 'hard') {
      const now = wallClock();
      hardTimes.push(now);
      while (hardTimes.length && now - hardTimes[0] > REALM_CAPS.hardFaultWindowMs) hardTimes.shift();
      if (UNLOAD_AT_ONCE.has(f.reason)) requestUnload(`hard fault: ${f.reason}`, true);
      else if (hardTimes.length >= REALM_CAPS.hardFaultsToUnload) requestUnload(`${REALM_CAPS.hardFaultsToUnload} hard faults within ${REALM_CAPS.hardFaultWindowMs / 1000} s`, true);
    }
    return fault;
  };

  /** @param {string} site @returns {Fault} */
  const unloadedFault = (site) => ({ ok: false, kind: 'hard', reason: 'unloaded', site });

  /** @param {string} reason @param {boolean} discard */
  const requestUnload = (reason, discard) => {
    if (state !== 'live') return;
    if (active > 0 || draining) {
      pendingUnload ??= reason;
      pendingDiscard ||= discard;
      return;
    }
    doUnload(reason, discard);
  };

  /** @param {string} reason @param {boolean} discard */
  const doUnload = (reason, discard) => {
    if (state !== 'live') return;
    queue.length = 0;
    pendingUnload = null;
    for (const id of liveTimers.keys()) {
      try {
        dispatcher.timer('clear', id, 0, false);
      } catch {
        // the view is going away either way
      }
    }
    liveTimers.clear();
    membrane.table.revokeAll();
    health.unloaded = true;
    if (!discard && !poisoned && health.hard === 0 && entry !== null) {
      try {
        sentinel.dispose();
        entry.dispose();
        ctx.dispose();
        rt.dispose();
        state = 'disposed';
        say('info', 'realm: unload: disposed', { viewKey, reason });
      } catch (e) {
        state = 'discarded';
        say('warn', 'realm: unload: dispose failed, instance discarded', { viewKey, reason, message: String(/** @type {any} */ (e)?.message ?? e) });
      }
    } else {
      state = 'discarded';
      say('info', 'realm: unload: discarded (never disposed)', { viewKey, reason });
    }
    // Drop every reference; a discarded module is reclaimed by the garbage collector.
    mod = rt = ctx = entry = sentinel = null;
  };

  // ---- the entry wrapper -----------------------------------------------------------------------

  /**
   * Run one entry point under a budget. `body` makes the realm call(s) and returns an Outcome.
   * `gesture` and `depth` hold for the body only: dispatches it queued drain afterwards, at their own
   * depth and outside the gesture. `jobs: false` neither runs nor drains Promise jobs (a read that runs
   * no skin code); `flood` is the fault for jobs left past the drain cap; `inherited` says the caller
   * already ran `runLeftoverJobs` and what it returned.
   * @param {string} site @param {number} budget @param {() => Outcome} body
   * @param {{ gesture?: boolean, depth?: number, jobs?: boolean, flood?: 'soft' | 'hard', inherited?: boolean }} [frame]
   * @returns {Ok | Fault}
   */
  const enter = (site, budget, body, frame = {}) => {
    if (state !== 'live') return unloadedFault(site);
    let inherited = frame.inherited ?? false;
    if (frame.inherited === undefined && frame.jobs !== false && active === 0 && site !== 'jobs') {
      const left = runLeftoverJobs();
      if (left === null) return unloadedFault(site);
      inherited = left;
    }
    const start = wallClock();
    // Every entry point refuses or defers while another runs, so entries nest only through
    // drainQueue, after the outer one has finished. Should one ever nest inside a running entry, it
    // saves the outer budget state, restores it on exit, and can never push the outer deadline later.
    const savedDeadline = deadline;
    const savedGuardTripped = guardTripped;
    // A missing or non-finite budget fails closed: the interrupt fires at once.
    deadline = Math.min(savedDeadline, start + (Number.isFinite(budget) ? Math.max(0, budget) : 0));
    const interruptsBefore = interrupts;
    guardTripped = false;
    const savedDepth = chainDepth;
    chainDepth = frame.depth ?? 0;
    if (frame.gesture) gestureDepth++;
    active++;
    /** @type {Outcome} */
    let outcome;
    try {
      outcome = body();
      if (!poisoned && !inherited && frame.jobs !== false) outcome = worse(outcome, drainJobs(interruptsBefore, frame.flood ?? 'soft'));
    } catch (e) {
      poisoned = true;
      const err = /** @type {any} */ (e);
      const abort = err?.name === 'RuntimeError' || /Aborted\(/.test(String(err?.message));
      say('warn', 'realm: exception escaped the WASM call', { viewKey, site, name: String(err?.name), message: clip(String(err?.message ?? err)) });
      outcome = { ok: false, kind: 'hard', reason: abort ? 'abort' : 'host-exception' };
    }
    // An entry can outrun its deadline with no interrupt poll or guard after it (one long native call as
    // its last work: a parse, an unguarded builtin): past the slack that is the budget fault too (G2 DOS-5).
    const end = wallClock();
    const overran = end > deadline + REALM_CAPS.overrunSlackMs;
    const tripped = interrupts > interruptsBefore || guardTripped || overran;
    active--;
    if (frame.gesture) gestureDepth--;
    chainDepth = savedDepth;
    deadline = savedDeadline;
    guardTripped = savedGuardTripped;
    if (tripped && (outcome.ok === true || outcome.kind !== 'hard')) outcome = BUDGET;
    // A skin can throw its own { name: 'InternalError', message: 'interrupted' }; only a real interrupt is a budget fault.
    if (!tripped && outcome.ok === false && outcome.reason === 'budget') outcome = { ok: false, kind: 'soft', reason: 'InternalError: interrupted' };
    // Memory is read from the heap alone, caught or not (F5, DOS-6): an allocation refused, or a heap
    // grown past the cap, is a hard 'memory' fault, which discards the instance.
    if (heapExhausted() && !(outcome.ok === false && (outcome.reason === 'abort' || outcome.reason === 'host-exception'))) {
      poisoned = true;
      outcome = MEMORY;
    }
    const dutyFault = recordBusy(start, end);
    /** @type {Ok | Fault} */
    let result = outcome.ok === true ? outcome : recordFault(site, outcome);
    if (dutyFault) {
      const f = recordFault(site, { ok: false, kind: 'hard', reason: 'duty-cycle' });
      if (result.ok === true || result.kind === 'soft') result = f;
    }
    if (active === 0) {
      drainQueue();
      if (pendingUnload !== null && !draining) doUnload(pendingUnload, pendingDiscard);
    }
    return result;
  };

  /**
   * Jobs an earlier entry left past its drain cap run before the next entry, as an entry of their own:
   * never under that entry, its budget, its fault site or its gesture (G2 DOS-8, S2). Should they
   * outlive that drain too (a self-rescheduling flood), it is a hard fault at 'jobs', and the next entry
   * leaves them queued rather than run them.
   * @returns {boolean | null} whether jobs are still pending; null when the realm is going away
   */
  const runLeftoverJobs = () => {
    if (poisoned || !rt.hasPendingJob()) return false;
    enter('jobs', budgets.handler, () => OK_VOID, { flood: 'hard' });
    if (state !== 'live' || pendingUnload !== null) return null;
    return !poisoned && rt.hasPendingJob();
  };

  // ---- deferred dispatch -------------------------------------------------------------------------

  const drainQueue = () => {
    if (draining) return;
    draining = true;
    // The depth cap bounds a chain, not its breadth: at a fan-out of 2 a drain could run ~130 k
    // dispatches without returning. One drain is one originating event, and it gets `budgets.load` of
    // wall time; the rest is dropped (G2 DOS-2).
    const drainStart = wallClock();
    try {
      while (queue.length && state === 'live' && pendingUnload === null) {
        if (!(wallClock() - drainStart <= budgets.load)) {
          recordFault('queue', { ok: false, kind: 'soft', reason: `queued dispatches ran over ${budgets.load} ms; the rest were dropped` });
          queue.length = 0;
          break;
        }
        const item = /** @type {typeof queue[number]} */ (queue.shift());
        const site = item.kind === 'handler' ? `handler ${item.el}.${item.site.event}` : `timer ${item.id}`;
        if (item.depth > REALM_CAPS.maxChainDepth) {
          recordFault(site, { ok: false, kind: 'soft', reason: `change chain deeper than ${REALM_CAPS.maxChainDepth}` });
          continue;
        }
        if (item.kind === 'handler') runHandlerNow(item.el, item.site, item.ctx, item.depth);
        else fireTimerNow(item.id, item.depth);
      }
    } finally {
      draining = false;
    }
  };

  /** @param {any} item @returns {Ok} */
  const defer = (item) => {
    if (queue.length >= REALM_CAPS.maxQueued) return /** @type {any} */ (recordFault('queue', { ok: false, kind: 'soft', reason: 'too many queued dispatches' }));
    queue.push(item);
    return OK_VOID;
  };

  // ---- entry points ---------------------------------------------------------------------------------

  /** @param {number} el @param {HandlerSite} site @param {any} rctx @param {number} depth @returns {Ok | Fault} */
  const runHandlerNow = (el, site, rctx, depth) => {
    const event = String(site.event).toLowerCase();
    const where = `handler ${el}.${site.event}`;
    const params = Array.isArray(site.params) ? site.params.map(String) : [];
    const paramsKey = JSON.stringify(params);
    const key = `${el}\u0000${event}`;
    let compiled = handlerCache.get(key);
    if (!compiled || compiled.source !== site.source || compiled.params !== paramsKey) {
      compiled = { id: nextHandlerId++, source: String(site.source), params: paramsKey, compiled: false, error: null };
      handlerCache.set(key, compiled);
    }
    if (compiled.error !== null) return recordFault(where, { ok: false, kind: 'soft', reason: compiled.error });

    // Parameter values, by name, own properties only (a param named `constructor` must not inherit).
    const given = rctx?.params;
    /** @type {Wire[]} */
    const values = [];
    for (const p of params) {
      const v = given && Object.prototype.hasOwnProperty.call(given, p) ? given[p] : undefined;
      const c = checkWire(v);
      if (!c.ok) return recordFault(where, { ok: false, kind: 'soft', reason: `Error: membrane: parameter ${p} cannot cross` });
      values.push(c.value);
    }
    const ev = isHandleNumber(rctx?.event) ? rctx.event : 0;
    const perDispatch = ev !== 0 && !permanent.has(ev);
    if (ev !== 0) membrane.table.issue(ev);
    membrane.table.issue(el);

    const budget = event === 'onload' || event === 'onclose' ? budgets.load : budgets.handler;
    let compileFailed = false;
    const entryRef = compiled;
    let result;
    try {
      result = enter(where, budget, () => {
        if (!entryRef.compiled) {
          const c = settle(callEntry('compileHandler', [entryRef.id, entryRef.params, entryRef.source]), null);
          if (c.ok === false) {
            compileFailed = c.kind === 'soft';
            return c;
          }
          entryRef.compiled = true;
        }
        const ran = settle(callEntry('runHandler', [entryRef.id, el, ev, perDispatch], values), null);
        // The dispatch has ended: its event handle dies now, before anything it queued runs.
        if (perDispatch) membrane.table.revoke(ev);
        return ran;
      }, { gesture: rctx?.gesture === true, depth });
    } finally {
      if (perDispatch) membrane.table.revoke(ev);
    }
    if (compileFailed && !result.ok) {
      compiled.error = result.reason;
      diag({ code: 'handler-syntax', severity: 'warn', line: site.line, detail: `${viewKey} ${where}: ${result.reason}` });
    }
    return result;
  };

  /** @param {number} id @param {number} depth @returns {Ok | Fault} */
  const fireTimerNow = (id, depth) => {
    const t = liveTimers.get(id);
    if (!t) return OK_VOID;                      // cleared, or already fired
    if (!t.repeat) liveTimers.delete(id);
    return enter(`timer ${id}`, budgets.handler, () => settle(callEntry('fireTimer', [id]), null), { depth });
  };

  /** @param {string} site @returns {Fault} */
  const reentry = (site) => recordFault(site, { ok: false, kind: 'soft', reason: 're-entrant call from a host op' });

  /** @type {Realm} */
  const realm = {
    setIds(ids) {
      if (state !== 'live') return;
      // Called from a host op it would run inside the dispatch that made the op; refused like the
      // other value-returning entry points (D1: no synchronous re-entry).
      if (active > 0 || draining) {
        diag({ code: 'realm-setids-reentry', severity: 'warn', detail: `${viewKey}: setIds called from inside a dispatch; ignored` });
        reentry('setIds');
        return;
      }
      /** @type {Array<[string, number, string]>} */
      const rows = [];
      for (const row of ids ?? []) {
        if (!row || typeof row.id !== 'string' || !isHandleNumber(row.handle)) continue;
        rows.push([row.id, row.handle, String(row.className)]);
        membrane.table.issue(row.handle);
        permanent.add(row.handle);
        if (HOST_GLOBAL_NAMES.includes(row.id)) {
          diag({ code: 'realm-id-shadowed', severity: 'warn', elementId: row.id, detail: `${viewKey}: id '${row.id}' loses to the host global of the same name (G17)` });
        } else if (row.id === 'eval' || row.id.startsWith('__wmp')) {
          diag({ code: 'realm-id-reserved', severity: 'warn', elementId: row.id, detail: `${viewKey}: id '${clip(row.id, 80)}' is reserved by the realm and cannot be reached by name` });
        }
      }
      enter('setIds', budgets.load, () => settle(callEntry('setIds', [JSON.stringify(rows)]), null));
    },

    loadScript(name, source) {
      const site = `script ${name}`;
      if (state !== 'live') return unloadedFault(site);
      if (active > 0) return reentry(site);
      if (typeof source !== 'string') return recordFault(site, { ok: false, kind: 'soft', reason: 'TypeError: script source is not a string' });
      const file = String(name);
      // A compile cannot be interrupted, so its size is capped (E §10 "script source", G2 S1) and a view
      // whose scripts budget is spent compiles nothing more (G2 DOS-3).
      if (source.length > REALM_CAPS.maxScriptChars) {
        diag({ code: 'script-too-large', severity: 'error', file, detail: `${source.length} characters, over the ${REALM_CAPS.maxScriptChars} cap; the file is not loaded` });
        return recordFault(site, { ok: false, kind: 'soft', reason: 'RangeError: script too large' });
      }
      if (!(scriptsSpent < budgets.scripts)) return recordFault(site, BUDGET);
      // Leftover jobs run first, outside this file's clock and its script phase.
      const inherited = runLeftoverJobs();
      if (inherited === null) return unloadedFault(site);
      const start = wallClock();
      phase = 'script';
      try {
        return /** @type {Ok | Fault} */ (enter(site, budgets.scripts - scriptsSpent, () => {
          // Checked before every compile, and before the loader's own parse.
          const overBudget = () => {
            if (wallClock() < deadline) return false;
            guardTripped = true;
            return true;
          };
          const repaired = repairScript(source, (src) => {
            if (heapExhausted()) return { name: 'InternalError', message: 'out of memory' };
            const r = ctx.evalCode(src, file, { type: 'global', compileOnly: true });
            if (r.error) {
              const err = ctx.dump(r.error);
              r.error.dispose();
              return err;
            }
            r.value.dispose();
            return null;
          }, { stop: overBudget });
          if (heapExhausted()) return settle(HEAP_GONE, null);
          // Before the syntax branch: running out of time is a budget fault, never a syntax diagnostic.
          if (repaired.stopped || overBudget()) return BUDGET;
          for (const rw of repaired.rewrites) {
            diag({ code: 'script-rewrite', severity: 'warn', file, line: rw.line, detail: `assignment to a call result rewritten to throw at run time (E R20): ${clip(rw.statement, 160)}` });
          }
          if (repaired.error) {
            const e = repaired.error;
            diag({ code: 'script-syntax', severity: 'error', file, line: e.line ?? undefined, detail: `${e.name}: ${e.message}; the file is not loaded` });
            return { ok: false, kind: 'soft', reason: clip(`${e.name}: ${e.message}`) };
          }
          const snap = settle(callEntry('snapshotGlobals', []), null);
          if (!snap.ok) return snap;
          const staged = settle(callEntry('stage', [repaired.source]), null);
          if (!staged.ok) return staged;
          const ran = settle(heapExhausted() ? HEAP_GONE : ctx.evalCode(LOADER_SOURCE, file, { type: 'global' }), null);
          if (poisoned) return ran;
          // Declarations hoist even when the file throws part-way, so the collision check runs either way.
          const clash = settle(callEntry('collisions', []), (h) => ({ ok: true, value: ctx.dump(h) }));
          /** @type {string[]} */
          const declared = [];
          if (clash.ok && Array.isArray(clash.value)) {
            for (const id of clash.value) {
              declared.push(String(id));
              diag({ code: 'script-id-collision', severity: 'warn', file, elementId: String(id), detail: `top-level declaration '${clip(String(id), 80)}' names an element id; the id wins (U-31), so the script's binding is unreachable by name` });
            }
          }
          for (const id of scriptIdWrites) {
            if (declared.includes(id)) continue;
            diag({ code: 'script-id-write', severity: 'warn', file, elementId: id, detail: `an assignment to the id '${clip(id, 80)}' while the file loaded goes nowhere: ids beat script globals (U-31)` });
          }
          return ran;
        }, { inherited }));
      } finally {
        phase = null;
        scriptIdWrites.clear();
        scriptsSpent += wallClock() - start;
      }
    },

    evalExpression(el, attr, src) {
      const site = `expr ${el}.${attr}`;
      if (state !== 'live') return unloadedFault(site);
      if (active > 0) return reentry(site);
      if (!isHandleNumber(el)) return recordFault(site, { ok: false, kind: 'soft', reason: 'TypeError: not an element handle' });
      membrane.table.issue(el);
      return enter(site, budgets.expr, () => settle(callEntry('evalExpr', [el, String(src)]), readWire));
    },

    runHandler(el, site, rctx) {
      const where = `handler ${el}.${site?.event}`;
      if (state !== 'live') return unloadedFault(where);
      if (!isHandleNumber(el) || !site || typeof site.source !== 'string' || typeof site.event !== 'string') {
        return recordFault(where, { ok: false, kind: 'soft', reason: 'TypeError: bad handler site' });
      }
      if (active > 0 || draining) return defer({ kind: 'handler', el, site, ctx: rctx, depth: chainDepth + 1 });
      return runHandlerNow(el, site, rctx, 0);
    },

    fireTimer(id) {
      if (state !== 'live') return unloadedFault(`timer ${id}`);
      if (active > 0 || draining) return defer({ kind: 'timer', id, depth: chainDepth + 1 });
      return fireTimerNow(id, 0);
    },

    callGlobal(name, args) {
      const site = `call ${name}`;
      if (state !== 'live') return unloadedFault(site);
      if (active > 0) return reentry(site);
      const list = Array.isArray(args) ? args : [];
      if (list.length > MEMBRANE_CAPS.maxArgs) return recordFault(site, { ok: false, kind: 'soft', reason: 'RangeError: membrane: more than 16 arguments' });
      /** @type {Wire[]} */
      const wires = [];
      for (const a of list) {
        const c = checkWire(a);
        if (c.ok === false) return recordFault(site, { ok: false, kind: 'soft', reason: `Error: membrane: argument cannot cross (${c.reason})` });
        if (c.value !== null && typeof c.value === 'object') membrane.table.issue(c.value.__h);
        wires.push(c.value);
      }
      return enter(site, budgets.handler, () => settle(callEntry('callGlobal', [String(name)], wires), readWire));
    },

    readGlobal(name) {
      if (state !== 'live' || typeof name !== 'string') return undefined;
      if (active > 0) {
        // Inside a host op: a data-property read runs no skin code, so it goes straight through.
        try {
          const r = settle(callEntry('readGlobal', [name]), readWire);
          return r.ok ? r.value : undefined;
        } catch {
          if (poisoned) recordFault(`read ${name}`, { ok: false, kind: 'hard', reason: 'host-exception' });
          return undefined;
        }
      }
      // A read runs no skin code, so it neither runs nor drains Promise jobs.
      const r = enter(`read ${name}`, budgets.handler, () => settle(callEntry('readGlobal', [name]), readWire), { jobs: false });
      return r.ok ? r.value : undefined;
    },

    get inGesture() {
      return gestureDepth > 0;
    },

    get health() {
      return { soft: health.soft, hard: health.hard, unloaded: health.unloaded, dutyThrottled: health.dutyThrottled };
    },

    unload(reason) {
      requestUnload(String(reason ?? 'unload'), false);
    },
  };

  debugViews.set(realm, {
    objectCount() {
      if (state !== 'live' || poisoned) return null;
      const h = rt.computeMemoryUsage();
      try {
        return Number(ctx.dump(h).obj_count);
      } finally {
        h.dispose();
      }
    },
    state: () => state,
    queued: () => queue.length,
    liveTimers: () => liveTimers.size,
    heap: () => ({ bytes: wasmMemory.buffer.byteLength, cap: heapCap, max: maxPages * WASM_PAGE }),
  });

  // ---- boot ---------------------------------------------------------------------------------------

  /** @type {Array<[string, number, string | null]>} */
  const hostGlobals = [];
  for (const name of HOST_GLOBAL_NAMES) {
    const h = opts.hostGlobals?.[/** @type {keyof RealmOptions['hostGlobals']} */ (name)];
    if (!isHandleNumber(h)) continue;
    membrane.table.issue(h);
    permanent.add(h);
    const cls = opts.classMembers.has(name) ? name : opts.classMembers.has(name.toLowerCase()) ? name.toLowerCase() : null;
    hostGlobals.push([name, h, cls]);
  }
  const cfg = {
    hostNames: HOST_GLOBAL_NAMES,
    hostGlobals,
    classMembers: [...opts.classMembers].map(([cls, members]) => [cls, [...members].map((m) => String(m).toLowerCase())]),
    constants: Object.entries(wmplocConstants()),
    seed: typeof opts.testSeed === 'string' ? opts.testSeed : null,
  };

  // Any failure of the prelude is the hard fault 'prelude' (D1), which unloads at once.
  /** @param {Outcome} o @returns {Outcome} */
  const preludeFailed = (o) => {
    say('warn', 'realm: the prelude failed', { viewKey, reason: o.ok === false ? o.reason : '' });
    return { ok: false, kind: 'hard', reason: 'prelude' };
  };
  enter('prelude', budgets.load, () => {
    const boot = ctx.evalCode(`({ boot: ${PRELUDE_SOURCE} })`, 'prelude.js', { type: 'global' });
    if (boot.error) return preludeFailed(settle(boot, null));
    const native = ctx.newFunctionWithOptions({ name: 'host', length: 0, isConstructor: false, fn: membrane.native });
    const cfgText = ctx.newString(JSON.stringify(cfg));
    /** @type {any} */
    let r;
    try {
      r = ctx.callMethod(boot.value, 'boot', [native, cfgText]);
    } catch (e) {
      poisoned = true;
      throw e;
    } finally {
      if (!poisoned) {
        native.dispose();
        cfgText.dispose();
        boot.value.dispose();
      }
    }
    if (r.error) return preludeFailed(settle(r, null));
    entry = r.value;
    sentinel = ctx.getProp(entry, 'm');
    membrane.setMethodSentinel(sentinel);
    return OK_VOID;
  });
  return realm;
};
