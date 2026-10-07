# Realm security review (gate G2, 2026-10-07)

Three Opus reviewers read `src/engine/realm/{realm,membrane,prelude}.js` line by line against ENGINE D1, §10, the W2.2 card and the G1/G2 rulings, each through one lens (escape and membrane; denial of service and faults; scope semantics). Every finding was then handed to an independent Opus verifier who tried to reproduce it under `/tmp`. All 25 reproduced; severities below are the verifier's. **No escape from the realm was found.** Fixes land in G2.F4 (WAVES.md).

**G2.F4 record (2026-10-07).** Fixed, each with a regression test: F1, F2, F3, F4, F5, F6, F7, F8, S1, S2, S3, S4, S6, DOS-1, DOS-2, DOS-3, DOS-4 (accidental paths), DOS-5, DOS-7, DOS-8, and DOS-6 for OOM. Not fixed, or fixed in part, with the reason:
- **S5** not fixed: binding PLAYER parameters innermost changes D1's handler compile string; needs an O ruling.
- **S7** not fixed: the verifier's fix is a D1 wording change (markup-only attributes are not in scope), not code.
- **S8** not fixed: the nonce-label wrapper changes D1's handler compile string; needs an O ruling. The repro still runs injected code at compile time, inside the realm and its budget.
- **DOS-9** not fixed: documentation and measurement only (§10 ceiling note, rg0 sweep shapes, the 128 KiB W3.R candidate).
- **DOS-6, stack half** not fixed: QuickJS gives the host no signal for a stack overflow skin code caught (unlike OOM, which the capped heap now reports), so a caught overflow still ends the entry ok. Needs O: accept as D1 wording (the verifier's fix) or a different mechanism.
- **F5, stack half** accepted: a thrown stack-overflow look-alike stays a hard 'stack' fault, as the verifier advised; only the skin's own view is affected. OOM is read from the heap alone.
- **S3 residual**: a second file redeclaring an id another file already declared logs no second collision (the prelude reports each id once); the first file's diagnostic stands.
- **S4 residual**: `f(a)\n= 5` and a line with a regex literal holding a quote are still not repaired; they lose the file, as before R20.
- **DOS-3 residual**: one uninterruptible compile per file remains (at most ~2.5 s for a 0.4 MiB file of 65k globals); DOS-5's overrun rule makes it a hard fault.
- **DOS-4 residual**: operators on large strings stay E R19's residual; DOS-5 now makes each such overrun a hard fault. A thrown value is still dumped with `ctx.dump` (non-Promise), so a huge thrown graph is slow, and now a hard fault past the slack.
- **Single requests past the wasm32 address space** are refused before the heap is touched and stay soft exceptions (no heap signal; nothing allocated).

## Lens: ESCAPE AND MEMBRANE

**Holds (with evidence):**
- The dispatcher is never a global. The native function reaches boot only as an argument (realm.js:976-983, prelude.js:119), and `entry` is held only by the host. p1 and the item-6 probe: `constructor.constructor('return this')()` is the realm global, and every candidate name (`host`, `__host`, `__TAURI_INTERNALS__`, ...) is undefined.
- Locked internals are locked. p1 shows `__IDS`, `__wmp_badAssign`, `eval` and `Proxy` are writable:false and configurable:false, and `__wmp_src` is a configurable:false accessor with no setter (prelude.js:340-349, 536). The guarded builtins are also non-writable and non-configurable (prelude.js:601; p1 `String.prototype.indexOf` is false/false). Caveat: their behaviour is not locked; see finding F4.
- `caller` and `arguments` walks fail. On a cached method, `m.caller` throws 'invalid property access'. A sloppy `f.caller` is undefined (p1).
- Element proxies have a null prototype and no own keys. `Object.getPrototypeOf(sEqEar)` is null. `__proto__`, `constructor` and `__h` reads are plain unknown-member gets the host answers. `setPrototypeOf` and `defineProperty` on a proxy only touch its private target, and every read still goes through the get trap to the host (p1; prelude.js:252-261).
- `has` never crosses. Element `has` is answered from realm-side Sets (prelude.js:233-236) and id `has` from byExact/byLower (prelude.js:277-281). `isReserved` (prelude.js:165) is a pure index check that skin code cannot tamper with, so `eval` and `__wmp_src` are never offered by an element's own `has`.
- Handle forgery fails on the host side. With `WeakMap.prototype.get` tampered so the realm half boxes arbitrary numbers, the never-issued handles 110 and 999 are refused with 'unknown or revoked handle'. Only handles already issued to this realm (1, 103, 105) pass (p9; membrane.js:268, 181).
- Revocation is enforced by the host table, not the realm flag. An event proxy whose realm-side `state.revoked` was reset to false (and `state.h` rewritten) after its dispatch is still refused (p14; realm.js:763/767, membrane.js:90-96). `revokeAll` closes the table for good (membrane.js:93-96).
- No synchronous re-entry from dispatcher ops (p12). Re-entrant `callGlobal`, `evalExpression` and `loadScript` are soft faults; `setIds` is refused (realm.js:793-797); `runHandler` and `fireTimer` are deferred and drained FIFO after the entry returns; `readGlobal` is allowed and runs no skin code (realm.js:905-916).
- Host errors cross as a fixed message (membrane.js:228-236, 250-258). Oversize strings from the host become a 'string' fault (membrane.js:218-221). Realm-to-host values are typed through `toWire` (prelude.js:188-206) and checked again in `fromRealm`. Values of 64 KiB or more throw before any host op (prelude.js:196).
- Views and sessions are isolated. Each `createRealm` call gets a new module instance (realm.js:313), and a global or `Object.prototype` change made in one realm is invisible in another (p9).
- Error-dump loops stay bounded. A thrown object whose `toJSON` and `toString` loop forever is still stopped by the live deadline as a hard 'budget' fault at about 100 ms (p2). A skin-thrown `{name:'InternalError',message:'interrupted'}` is correctly downgraded to soft (realm.js:671-673).
- The R20 rewrite cannot add capability. The replacement text is fixed (`__wmp_badAssign()`), the removed span lies on one line, and the result is loaded through the same LOADER, so it can only produce code the skin could have written itself (realm.js:235-237, 846). Cost and a wrong-target bug are reported as F5 and F7.
- The `#132` constants from wmploc.js reach the prelude as JSON data (realm.js:965, prelude.js:335-337), not source. They are writable and configurable as D1 intends. `librarySource` emits only identifier-checked names with JSON-stringified values (realm.js:285-291).

### F1 · medium · Oversize property keys are copied whole into host memory before the 64 KiB check; budget overshoots by seconds and host memory grows

- **Requirement:** ENGINE D1 membrane: 'strings (≤ 64 KiB) ... cross, in either direction'; §10 membrane 'strings ≤ 64 KiB'; D1 per-dispatch budget of 100 ms. This is not the documented R19 residual: R19 covers one builtin's realm CPU, bounded by the 64 MiB WASM cap. This path is the membrane's own cap, enforced after the copy, and it grows host memory.
- **Location:** src/engine/realm/membrane.js:243-247 (str: ctx.getString before the length test), membrane.js:269; src/engine/realm/prelude.js:237-249 (get/set traps send any key length), prelude.js:157-164 (lower caches huge keys)
- **Repro (reviewer):** /tmp/realmprobe/p5.mjs. One access `sEqEar['A'.repeat(16<<20)]` takes 216 ms (p4). The handler `var k='A'.repeat(16*1024*1024); for(;;){try{sEqEar[k]}catch(e){}}` ends as a hard 'budget' fault after 4,430 ms against a 100 ms budget; with a 30 MiB key, 8,913 ms. A 2-byte-char key with `set` takes 8,351 ms; `player[k]()` takes 7,121 ms. Host RSS rises from 89 MB to 557 MB. Each op UTF-8-encodes the whole key in WASM and decodes it into a host string before rejecting it, and QuickJS polls its interrupt only every few hundred loop iterations.
- **Verification:** Everything ran under /tmp. No repo files were edited.

Setup: copies of src/engine/realm in /tmp/f1verify/{orig,instr,hostfix,realmfix,both}/. `instr` is orig with ctx.getString timed. /tmp/f1verify/h2.mjs is the reviewer's h.mjs harness, pointed at a copy through REALM_DIR (fake dispatcher, 64 MiB memory cap, 100 ms handler budget). /tmp/f1verify/run.mjs runs one handler body on a fresh realm.

Minimal repro: `REALM_DIR=/tmp/f1verify/orig node /tmp/f1verify/run.mjs 'var k="A".repeat(16<<20); n=0; for(;;){ try{ sEqEar[k]; }catch(e){} n++; }'`
- orig: hard 'budget' fault after 3,326 ms, 87 iterations, RSS 273 MB.
- set path with a 12M two-byte key: 5,709 ms, RSS 362 MB.
- `player[k]()`: 4,172 ms.
- The instrumented run shows how much of that time is the host copy. ctx.getString takes 1,831 of 3,335 ms on the get path and 4,818 of 6,023 ms on the set path. In other words the host copies the whole key into a host string and only then rejects it as over 64 KiB (membrane.js:243-247 and :269).
- The defect itself: the realm half already checks the length of values (toWire, prelude.js:196), but never checks keys. The get/set traps (prelude.js:237-249) call lower(k) and then host() with keys of any length.

Control for the R19 class (pure realm, same key): `m.get(k)` on the skin's own Map takes 1,628-1,986 ms with flat RSS (88 MB). So the membrane path is 2-4x the documented R19 baseline and adds host-heap churn.

Memory (/tmp/f1verify/rss.mjs with --expose-gc): RSS goes 62 -> 362 MB and stays at 362 after gc(). heapUsed drops back to 4 MB and external from 77 to 2 MB. This is not a leak: it is transient host decode buffers plus the allocator keeping its peak RSS.

Effect of each half of the fix:
| Copy | get | set | call |
|---|---|---|---|
| orig | 3,326 ms | 5,709 ms | 4,172 ms |
| realm-half check only | 101 ms | 101 ms | 101 ms |
| host-half check only | 1,495 ms | 1,138 ms | 1,835 ms |
| both | ~101 ms | ~101 ms | ~101 ms |

RSS stays flat at 87-98 MB with the realm half in place.
- What is left with only the host half is the prelude's own lower(k). It runs the captured, unguarded toLowerCase, then a Map hash over 16 MiB, on every op.
- The OP_DIAG path (`__IDS[k]=1`) copies a 16 MiB key to the host once. The host half removes that copy (RSS 105 -> 88 MB).

The reviewer's host fix does not work as written. In this build, `ctx.getLength(h)` returns undefined for every string handle, and even for `[1,2,3]` (/tmp/f1verify/gl.mjs). As written, `n > max` never rejects anything (`undefined > 65536` is false), and the strict variant rejects every key (it broke all ops in /tmp/f1verify/sanity.mjs).
- `ctx.getProp(h,'length')` works and is O(1): 16,777,216 in 0.06 ms.
- It runs no skin code: a getter installed on Object.prototype.length never fired (ran=0).

Regression check: the realm suite ran against /tmp/f1verify/t, a staged copy of src with the combined fix, using `vitest run --project timing tests/engine/realm`. 117 tests in 9 files passed. wmploc.test.js could not load, only because tests/support/fixtures.js was missing from the staged copy, and wmploc.js is unchanged.

Why medium, not high:
- No escape: nothing over the cap reaches the dispatcher.
- The overshoot is bounded by the existing 3-hard-faults-in-30-s unload.
- No host memory is retained.
- The magnitude is comparable to R19 residuals the design already accepts.

It is still a real defect and not R19: it is the membrane's own D1 64 KiB cap, enforced after the copy, on a native call that has no guard.

Adjacent issue, realm-only and not part of F1: other prelude call sites of lower() still run the original toLowerCase on skin strings of any length.
- `k in sEqEar` (has trap): 2,669 ms orig, 2,646 ms with the fix.
- `__IDS[k]` get loop: 6,213 ms orig, 4,879 ms with the fix.
- idWritesNoted keeps skin keys without a bound.
- **Fix (verifier):** There are two halves; the realm half is the one that closes the overshoot.

1. Realm half (prelude.js traps(), get and set): right after the `state.revoked` check, add `if (k.length > MAX_STRING) throw new RealRangeError(TOO_LONG);`. It goes before lower() and before host(). The error becomes `RangeError: membrane: string longer than 65536 characters`, which matches what toWire already throws for values.

2. Host half (membrane.js): this is defence in depth, because the host must not trust the realm half. Read the length without copying, using `ctx.getProp(h, 'length')`. Do not use `ctx.getLength`: it returns undefined for strings in quickjs-emscripten-core 0.32, so the reviewer's version silently does nothing.

```js
const strLength = (h) => {
  const l = ctx.getProp(h, 'length');
  try {
    return ctx.typeof(l) === 'number' ? ctx.getNumber(l) : Infinity;
  } finally {
    l.dispose();
  }
};
```

Apply it in three places:
- In `str()`, change the first line to `if (h === undefined || ctx.typeof(h) !== 'string' || strLength(h) > max) return null;`. This also covers OP_DIAG.
- In fromRealm's `case 'string'`, add `if (strLength(h) > MEMBRANE_CAPS.maxStringLength) return { ok: false, reason: 'string' };` before `ctx.getString`.
- Keep the existing post-copy checks.

Optional:
- Make the native function return a failure once `hooks.guard()` is true.
- The same `k.length > MAX_STRING` early-out (return false or undefined) in the element `has` trap and in the __IDS has/get/set traps covers the realm-only cases noted in the evidence.

### F2 · low · `throw <any Promise>` causes a host-side QuickJSUseAfterFree and unloads the view at once

- **Requirement:** ENGINE D1 'Soft faults: an exception in skin code ... Soft faults never unload'; host-exception/abort is reserved for real WASM failures (realm.js:83 UNLOAD_AT_ONCE).
- **Location:** src/engine/realm/realm.js:467-472 (settle: classifyError(ctx.dump(r.error)) then r.error.dispose()), realm.js:492-495 (drainJobs, same pattern)
- **Repro (reviewer):** /tmp/realmprobe/p2.mjs. Handlers `throw Promise.resolve(1)`, `throw Promise.reject(2)` and `throw new Promise(function(){})` each return {kind:'hard', reason:'host-exception'}. Health shows unloaded:true and state 'discarded', and the log has 'exception escaped the WASM call' {name:'QuickJSUseAfterFree', message:'Lifetime not alive'}. Cause: quickjs-emscripten's dump() calls handle.dispose() for promise states, so settle disposes the handle a second time.
- **Verification:** The repro path the reviewer gave is wrong. /tmp/realmprobe/p2.mjs is the big-string comparison probe, and none of the probe scripts throw a Promise. I wrote my own repros in /tmp/f2verify/, using the reviewer's h.mjs harness, which follows tests/engine/realm/fake-host.js and runs the real src/engine/realm/realm.js with the quickjs-emscripten-core 0.32.0 release-sync build.

1. /tmp/f2verify/repro.mjs: in a handler, `throw Promise.resolve(1)`, `throw Promise.reject(2)` and `throw new Promise(function(){})` each return {ok:false, kind:'hard', reason:'host-exception'}. Health then reads {hard:1, unloaded:true}, realmDebug state is 'discarded', the next handler gets 'unloaded', and the log warns 'realm: exception escaped the WASM call' with QuickJSUseAfterFree 'Lifetime not alive'. The controls `throw {}`, `throw 5` and `throw new Error` stay soft and the realm stays live.

2. /tmp/f2verify/entries.mjs and entriesB.mjs: the same result through every entry point that calls settle(): loadScript at the top level, evalExpression, callGlobal, fireTimer, and `throw Promise.resolve()`. The drainJobs path is not reachable this way. `Promise.resolve().then(function(){throw Promise.resolve(1)})` and an async function rejection both return ok, because QuickJS reaction jobs catch the throw and turn it into a rejection.

3. Mechanism, read from the library source: QuickJSContext.dump() calls handle.dispose() on the pending, fulfilled and rejected Promise paths. settle() (realm.js:467-472) then calls r.error.dispose() again, and Lifetime.assertAlive throws before the disposer runs. There is no second JS_FreeValue and no damage to WASM memory. "Use-after-free" overstates it: this is a JS-side assertion. enter() catches it, sets poisoned and returns 'host-exception', and that reason is in UNLOAD_AT_ONCE, so the view unloads. This breaks ENGINE D1: "an exception in skin code" is a soft fault, and "Soft faults never unload".

4. /tmp/f2verify/fixcheck.mjs compares the fixes on patched copies under /tmp/f2verify/fixA and fixB.
- Fix A is the reviewer's minimum: `if (!poisoned && r.error.alive) r.error.dispose()`. It fixes the top-level cases but still fails, with a hard host-exception and UseAfterFree, on `throw Promise.reject(Promise.resolve(1))` and `throw Promise.reject(p)`. In those cases the second dispose happens inside dump() itself: its `error.consume(this.dump)` disposes a nested Promise that dump has already disposed.
- Fix B (below) makes every case `soft: uncaught a Promise`, and a later realm.unload() reaches state 'disposed'.
- The leak detector works. fixC, a deliberately leaky copy of Fix B, makes unload abort with `list_empty(&rt->gc_obj_list)` and the realm is discarded.

5. The realm unit tests (9 files, 117 tests) pass on both the original and Fix B. They ran from /tmp copies, without wmploc.test.js because that file reads the skins corpus.

Why low and not medium:
- A skin can already unload its own view with one statement, because one OOM unloads at once (`for(;;)a.push('x'.repeat(1e6))`).
- WMP's JScript has no Promise, so no corpus skin can hit this.
- D10.9 criterion 6 blocks only on uncaught host exceptions. This one is caught in enter() and recorded as a realm hard fault, which is reported but does not block. The only nearby test that checks for host-exception is faults.test.js:191, the RangeError for 1 MiB recursion, and the fix does not touch it.
- The real effects are a misclassified fault class and a wrong, alarming 'host-exception' diagnostic.
- **Fix (verifier):** In realm.js, never hand a Promise handle to ctx.dump. Add a helper beside settle() and use it in both settle() (line 469) and drainJobs() (line 493), replacing `classifyError(ctx.dump(r.error))` with `classifyError(dumpThrown(r.error))`. The existing `if (!poisoned) r.error.dispose()` lines stay as they are, because the caller still owns h:

  const dumpThrown = (h) => {
    const s = ctx.getPromiseState(h);
    if (s.notAPromise) return ctx.dump(h);          // dump does not dispose non-Promise handles
    if (s.type === 'fulfilled') s.value.dispose();  // getPromiseState returns a new result handle
    else if (s.type === 'rejected') s.error.dispose();
    return 'a Promise';                             // classifyError -> soft 'uncaught a Promise'
  };

Do not use the reviewer's weaker options:
- `r.error.alive`: the realm still unloads on `throw Promise.reject(Promise.resolve(1))`, because the double dispose happens inside dump's recursive consume.
- "Dump a dup": it would leak the dup on every non-Promise throw, since dump disposes only Promise handles, and that leak makes JS_FreeRuntime abort at unload.

This fix covers F2 only. It still calls ctx.dump (QTS_Dump) on non-Promise objects that skin code throws, so the reviewer's separate concern about dump running getters and toJSON on values the skin controls remains open. The fuller fix the reviewer described, reading name and message without running getters (in the prelude, or on the host through ctx.typeof and getOwnPropertyDescriptor), would close both, but it is a larger change. Add a faults.test.js case: `throw Promise.reject(Promise.resolve(1))` must be a soft fault, and the realm must still reach state 'disposed' after unload.

### F3 · medium · No size cap on script source and an uninterruptible compile; the R20 repair recompiles the whole file up to 33 times with no deadline check

- **Requirement:** §10 'top-level scripts of a view 2,000 ms'; D1 budgets on wallClock; E R20 '... at most 32 per file' (the per-file cost is not accounted for).
- **Location:** src/engine/realm/realm.js:256-276 (repairScript loop), realm.js:814-833 (loadScript: any length; the compile runs even when `budgets.scripts - scriptsSpent` <= 0), realm.js:568-574 (hard faults spaced more than 15 s apart never reach 3 in 30 s)
- **Repro (reviewer):** /tmp/realmprobe/p7.mjs and p8.mjs. A 1 MiB file of small functions plus 32 lines of `f(j) = 1;` takes 1,491 ms; 4 MiB takes 4,425 ms; 16 MiB takes 16,928 ms of main-thread time before the first hard fault (duty-cycle). A 2 MiB file with 32 rewrites takes 2,800 ms against the 2,000 ms budget. QuickJS does not poll its interrupt during parsing, and repairScript never consults the deadline. Each later file still compiles at least once even after the scripts budget is spent. Faults about 17 s apart fall outside the 30 s window, so several such files never trigger an unload (by reading realm.js:569-573; not run end to end).
- **Verification:** I wrote my own harness, /tmp/f3verify/h.mjs. It builds a realm with createRealm over a no-op dispatcher with FAITHFUL.budgets (scripts 2,000 ms) and a 64 MiB memory limit, the same way tests/engine/realm/fake-host.js does, but without vitest. The test file is one function that is never called, holding N MiB of `x = 1 + 2 * (3 - 4) / 5;`, plus a second uncalled function with k lines of `f(j) = 1;` (each of those lines triggers the E R20 rewrite). No repo files were edited.

E1 (node /tmp/f3verify/e1.mjs 2|6), one file per fresh realm:
- 2 MiB, k=0: 235 ms, {ok:true}.
- 2 MiB, k=32: 2,715 ms, {ok:true}. No fault, health.hard 0, loaded=1.
- 6 MiB, k=0: 737 ms.
- 6 MiB, k=32: 8,222 ms, {ok:true}. health.hard 0; only dutyThrottled is set.

So it is worse than the reviewer said: the overrun is not just late, it is silent. QuickJS never calls the interrupt handler while parsing, so `tripped` stays false and the file loads as OK. repairScript (realm.js:256-276) runs up to 33 full compiles with no deadline check, and the loader's eval parses the text again, so the cost is about 34 times one parse.

E2 (e2.mjs), one realm, four files in sequence (2 MiB k=32 three times, then 4 MiB k=0): 2,479, 2,459, 2,472 and 426 ms, every one {ok:true}, health.hard 0, 7.8 s in total. After the 2,000 ms budget is spent, enter() sets deadline = start. Its comment says it 'fails closed: the interrupt fires at once', but the interrupt is never polled, so later files still compile, repair and load in full.

E3 (e3.mjs), several files with k=32 in one realm:
- 12 MiB: about 14.4 s per file. Three duty-cycle hard faults, and the realm unloads after 43 s of main-thread time.
- 14 MiB: 17.3, 17.2, 16.9 and 17.7 s per file, each a hard 'duty-cycle' fault. health.hard reaches 4, state is still 'live' after 69 s, and nothing unloads. This confirms the reviewer's reading of realm.js:569-573 end to end: faults about 17 s apart never put 3 inside the 30 s window.

This is not a documented residual. E R20 says only 'at most 32 per file' and says nothing about the cost of a compile. E R19 covers builtins called from skin code that run long between interrupt polls, not the host's own compile in loadScript. §10 sets 'top-level scripts of a view 2,000 ms'. The impact is availability only: the skin webview's main thread freezes, bounded by the archive caps (32 MiB per entry, 256 MiB inflated). That is the same class as the accepted R19 residual (about 48 s for indexOf), but here it needs no skin code to run and the fix is cheap. Hence medium.

Fix check: I patched a copy at /tmp/f3fix/src/engine/realm/realm.js. E1 at 6 MiB with k=32 then ends at 2,079 ms as {ok:false, kind:'hard', reason:'budget'}. In E2 the first file ends at 2,054 ms with a hard budget fault, the next two fail in 0 ms, and three hard faults unload the realm as D1 intends. All 117 tests in tests/engine/realm (wmploc.test.js excluded) pass against the patched copy under vitest, including 'the scripts of a view share one 2,000 ms budget'.
- **Fix (verifier):** Smallest correct fix, in loadScript (realm.js, inside the enter body around line 824). Check the deadline before every parse that cannot be interrupted, and turn an overrun into a hard 'budget' fault through the existing guardTripped path:

  const overBudget = () => { if (wallClock() < deadline) return false; guardTripped = true; return true; };
  const repaired = repairScript(source, (src) => {
    if (overBudget()) return { name: 'InternalError', message: 'interrupted' };   // ends the R20 loop
    const r = ctx.evalCode(src, file, { type: 'global', compileOnly: true });
    ...
  });
  for (const rw of repaired.rewrites) diag(...);
  if (guardTripped || overBudget()) return { ok: false, kind: 'hard', reason: 'budget' };   // before the script-syntax branch and before the loader's eval parse

What this changes:
- When the view's scripts budget is already spent (deadline = start), the file now fails as a hard budget fault before any compile.
- The 33-compile repair stops at the deadline.
- The loader's eval does not start a second parse after the deadline has passed.
- The remaining overshoot is at most one parse of one file, about 65 ms per MiB as measured.

Optional hardening, which needs an O ruling because §10 has no cap on script size today: cap script source length in loadScript before compiling, for example 4 MiB to match the `.wms` text cap (the corpus maximum is 3,938 lines across 7 files). Make it a soft 'script too large' fault; it bounds that one remaining parse. Add a test: a 6 MiB file with 32 `f(j) = 1;` lines inside a function that is never called must end as hard 'budget' within budget + 300 ms, and a file loaded after the budget is spent must fault without compiling.

### F4 · low · The prelude's proxy handlers inherit from Object.prototype, so skin code can capture them, rewire `__IDS`, and redirect the locked `eval` and `__wmp_src`

- **Requirement:** ENGINE D1 'Prelude internals (__IDS, the captured dispatcher, the loader helpers) are non-writable, non-configurable' and the W2.2 card ('prelude internals non-writable'); prelude.js:24-26 states the loader's and the jscript evaluator's direct eval 'cannot be redirected'.
- **Location:** src/engine/realm/prelude.js:231-251 (traps() handler literal), prelude.js:276-296 (the __IDS handler literal), prelude.js:484-487 (FakeDate handler); the lock at prelude.js:349 is bypassed because `with(__IDS)` consults the handler first
- **Repro (reviewer):** /tmp/realmprobe/p15.mjs. A handler sets `Object.prototype.getOwnPropertyDescriptor = Function('got','return function(t,k){got.push(this)}')(got)` and calls `Object.getOwnPropertyDescriptor(__IDS,'q')`, which yields the __IDS handler {has,get,set}. Element handlers are captured the same way (p13). It then replaces `H.has` and `H.get` so that `eval` and `__wmp_src` resolve to a skin function. Afterwards `loadScript('later.js','var laterLoaded = 1;')` returns ok, but laterLoaded is undefined (the file never ran), and `evalExpression(2,'left','1+1')` returns {ok:true, value:42} from the skin function. No host capability is gained, because the host half still validates every op.
- **Verification:** I reproduced it with my own script, /tmp/f4verify/repro.mjs. It is standalone and mirrors fake-host.js: createRealm from the repo's src/engine/realm/realm.js, a logging fake dispatcher, ids volume=1 (slider) and btn=2 (button). `node repro.mjs orig` runs it on the unmodified realm; `node repro.mjs fixed` runs it on a patched copy in /tmp/f4verify/fixed/. No repo files were touched.

On the unmodified realm:
- **A, baseline:** loadScript('a.js','var aLoaded=1') returns ok with aLoaded=1. evalExpression(2,'left','volume.value + 1') returns 51.
- **B, capture and rewire:** I planted functions for all 13 trap names on Object.prototype and called Object.getPrototypeOf, Object.keys and similar on __IDS, btn and player. All three prelude handlers leak as `this` (keys "has+get+set", not frozen). The handler then replaces H.has and H.get with functions built through Function(...), so they live in global scope. Defined inside the handler, they recurse through with(__IDS) and blow the stack. After the swap, `eval` resolves to a skin function.
  - loadScript('later.js','var laterLoaded = 1; ...') returns {ok:true}, but laterLoaded stays undefined, and the skin function received the staged source text.
  - evalExpression(2,'left','1+1') returns {ok:true, value:42}.
  - So the claim at prelude.js:24-26 ("the loader's and the jscript evaluator's direct eval cannot be redirected") is false. So is header item 2 ("has ... never for ... eval"). The lock at :349 only covers the global binding, and with(__IDS) asks the proxy's has trap before it reaches that binding.
- **C, a second route with no capture:** Object.defineProperty(__IDS,'eval',{value:1,configurable:false}) succeeds, because the default trap forwards to the create(null) target. Every later loadScript and evalExpression then soft-faults with "TypeError: proxy: inconsistent has". This breaks those calls rather than redirecting them, and null-prototype handlers alone do not close it.
- **D, impact:** a skin that swaps WeakMap.prototype.get to forge handle 999 gets "Error: membrane: unknown or revoked handle", and no set op reaches the dispatcher. The host-side check holds, so there is no host capability.

**Not a documented residual.** R19 covers slow builtins and R20 covers assignment to a call. The D1 text "non-writable, non-configurable globals" holds literally for the bindings, so the defect is that the lock's stated purpose can be bypassed. The bypass works by tampering with Object.prototype, which arguably falls under prelude.js:40-42 ("integrity against a skin that tampers with intrinsics ... is not a security property"). Even so, the file makes a specific no-redirection promise, and that promise fails.

**Severity: low, down from medium.** Everything affected belongs to the same skin, in its own context: one context per VIEW and a fresh instance per session. The effect is that the skin's own later scripts or jscript: values silently don't run or return skin-chosen values, and loadScript reports ok, which misleads the diagnostics. Nothing reaches the host, another view or another skin.

**Fix verified:** in the patched copy, B shows no handlers leaking, later.js loads (laterLoaded=1) and 1+1 returns 2. C now throws "object is not extensible" at define time, and later loads and expressions work. I mirrored src, tests/engine/realm, tests/support and tools into /tmp/f4verify/mirror-{base,fixed} and ran `vitest run --project timing tests/engine/realm`. Both give 10 files, 316 passed and 5 skipped, so the fix breaks no existing test.
- **Fix (verifier):** This is a smaller fix than defining all 13 traps. It changes prelude.js only, and the full diff is at /tmp/f4verify/fixed/prelude.js against the repo file.

1. In step 1, capture `freeze = O.freeze` and add `const sealedTarget = () => freeze(create(null));`.
2. Write each of the three handler literals as `freeze({ __proto__: null, ... })`: traps() at 232, the __IDS handler at 276 and FakeDate at 484. A missing trap is then never looked up on Object.prototype, so the handler can no longer leak as `this`, and it cannot be mutated.
3. Use `sealedTarget()` instead of `create(null)` as the target in proxyFor() (:257) and for __IDS (:276). Default traps then reach an empty frozen null-prototype object. No skin code runs, and a skin can no longer plant a non-configurable property that trips the has invariant (route C). Proxy invariants are unaffected, because has, get and set returning true for a property the target lacks is legal on a non-extensible target.

No explicit trap forwarders are needed. Capturing Map and Set prototype methods is not required for this finding: isReserved(k) runs on the raw key before any Map or Set lookup in both has traps, so tampering with Map/Set can't make `eval` or `__wmp_src` resolve. Also correct the prelude.js:24-26 comment if any part of the claim is left unenforced.

### F5 · low · Fault classes can be spoofed: a thrown plain object named 'out of memory' unloads at once and leaves the instance poisoned

- **Requirement:** ENGINE D1 'Soft faults: an exception in skin code'; the hard-fault classes mean real memory or stack exhaustion. Only 'interrupted' is checked against an independent signal (realm.js:671-673).
- **Location:** src/engine/realm/realm.js:100-113 (classifyError trusts the dumped name and message), realm.js:470 (sets poisoned on 'memory')
- **Repro (reviewer):** /tmp/realmprobe/p2.mjs. A handler `throw {name:'InternalError', message:'out of memory'}` returns {kind:'hard', reason:'memory'}, and the realm is unloaded and discarded on the first fault, bypassing the 3-in-30 s rule. `throw {name:'InternalError', message:'stack overflow'}` counts as a hard 'stack' fault.
- **Verification:** The reviewer's cited repro, /tmp/realmprobe/p2.mjs, is a different probe: it measures string-compare opcode cost and does not test this finding. I wrote my own standalone harness, modelled on tests/engine/realm/fake-host.js: a real createRealm with a 64 MiB memory cap, a 256 KiB stack cap and a 100 ms handler budget. No repo files were edited.

/tmp/f5verify/f5.mjs (`node /tmp/f5verify/f5.mjs`):
- Control, already guarded at realm.js:671-673: `throw {name:'InternalError',message:'interrupted'}` gives soft, hard=0, state live.
- `throw {name:'InternalError',message:'out of memory'}` gives hard/memory, unloaded=true, state=discarded, after one throw.
- `throw new InternalError('out of memory')` gives the same result. `InternalError` is a global constructor in the realm (`typeof` returns 'function').
- `var e=new Error('out of memory'); e.name='InternalError'; throw e` gives the same result.
- `throw new Error('out of memory')` is soft, because the name is Error.
- `throw {name:'InternalError',message:'stack overflow'}` three times gives hard/stack, hard=3, unloaded and discarded through the 3-in-30 s rule.
- `throw new RangeError('Maximum call stack size exceeded')` three times gives the same result. In the bellard sync build this RangeError branch (realm.js:110) can only be reached by skin-thrown values. A real host RangeError takes the escape path and becomes 'host-exception'.
- Control: `throw {name:'TypeError'}` three times stays soft and live.
- Replay: `try{new ArrayBuffer(100*1024*1024)}catch(e){stash=e}` returns ok with hard=0, and a later `throw stash` gives hard/memory, discarded. A caught real stack overflow, rethrown three times, gives hard/stack, discarded. The rethrown object is the genuine error instance, so no check on the thrown value can tell a replay from a live fault.

/tmp/f5verify/realoom.mjs: a real OOM is trivial for a skin. `new ArrayBuffer(100 MiB)` takes 1 ms and `'x'.repeat(80 MiB)` takes 1 ms; both give hard/memory, unloaded and discarded. So the spoof gives a skin no new capability: it can already unload its own view at once.

/tmp/f5verify/signal.mjs (raw QuickJS runtime, same variant): after a real OOM from one oversized ArrayBuffer, memory_used_size was 86,434 bytes of a 64 MiB limit. That is the same value as after the spoof, because the failed allocation never landed. This oversized single allocation is the real OOM that actually reaches classifyError; my allocation loops hit the 100 ms budget first. So the reviewer's proposed signal, rt.computeMemoryUsage() near the limit, would wrongly downgrade real OOMs to soft.

Adjacent context only, not a separate finding (/tmp/f5verify/caught.mjs): a real OOM caught by skin code leaves hard=0 and the realm live, and a later realm.unload() disposes the instance (state 'disposed'). So D1's rule "never dispose after OOM" cannot be fully enforced while skin code can catch the error.

Assessment: this deviates from the letter of ENGINE D1. D1 says "Soft faults: an exception in skin code ... Soft faults never unload", yet a skin exception is classed hard and unloads. It also goes against the code's own anti-spoof intent: faults.test.js:158 covers only 'interrupted'. It is not a documented residual in R19 or R20. The impact is bounded to the skin's own view: it unloads early with a wrong reason ('memory' or 'stack') in the fault log and panel. The skin can already cause that for real in 1 ms. There is no escape, no cross-view effect and no capability gain, and the misclassification errs toward discarding the instance, which is the safe direction. Severity: low.
- **Fix (verifier):** Neither fix the reviewer proposed is correct.
1. Memory usage near the limit misses real OOMs from one oversized allocation (see signal.mjs).
2. Treating everything the prelude catches as soft would make every real OOM soft. A skin can catch a genuine OOM or stack-overflow error and rethrow it later, so no check on the thrown value, on the host or in the prelude, can tell a live fault from a replay.
3. Dropping 'memory' from UNLOAD_AT_ONCE while classifyError still sets poisoned would be worse than today. A poisoned realm that keeps running stops disposing call handles (realm.js:458) and errors (471, 494), and skips drainJobs (657).

Smallest correct fix: accept this as a documented residual, since no host-observable signal for an OOM or stack overflow exists in the quickjs-emscripten API used here.
(a) Extend the comment at realm.js:671-673 to say that memory and stack look-alikes, including a rethrown real error, are deliberately classed hard. The error is in the safe direction (discard), and a skin can cause the real fault at will.
(b) Add a residual row to ENGINE.md, or a sentence in D1 "Budgets and faults": "A skin that throws, or rethrows, an OOM or stack-overflow error gets the hard fault; the effect is limited to unloading its own view."
(c) Add a faults.test.js case next to line 158 that pins `throw new InternalError('out of memory')` to hard/memory/discarded and the stack look-alike to hard/stack.

Optional tightening: gate the `RangeError /call stack/` branch at realm.js:110 on the quickjs-ng variant. Under the bellard sync variant only skin code can reach it.

### F6 · low · ctx.dump runs skin code inside a native op (synchronous re-entry within the membrane) once the realm half is tampered with

- **Requirement:** ENGINE D1 'No synchronous re-entry'; membrane.js:7-8 says the host half 'assumes the realm half may have been tampered with', yet membrane.js:177 assumes boxes are untampered null-prototype objects.
- **Location:** src/engine/realm/membrane.js:176-183 (fromRealm object case: ctx.dump), src/engine/realm/prelude.js:200 (handleOf.get uses the uncaptured WeakMap.prototype.get)
- **Repro (reviewer):** /tmp/realmprobe/p9.mjs ('mid-op skin code'). With `WeakMap.prototype.get` replaced so toWire boxes an object carrying `toJSON(){ volume.top='nested-op'; return 5 }`, the statement `sEqEar.left = {tag:'evil'}` makes the host's dump run toJSON in the middle of the outer OP_SET. A nested dispatcher.set(1,'top','nested-op') reaches the host before the outer op finishes. toJSON also chooses the dumped `__h` (5), although the table check still rejects it. Separately, p2 shows an error's `name` getter and `toJSON` run during settle.
- **Verification:** Reproduced. I ran the reviewer's p9: the 'mid-op skin code' case gives ops [["set",1,"top","nested-op"]] and the outer set is rejected with 'unknown or revoked handle'.

My own repros are in /tmp/f6verify/. They call createRealm from the worktree with a fake dispatcher shaped like tests/engine/realm/fake-host.js. They also set Error.stackTraceLimit=Infinity so the host stack shows where each dispatcher call comes from.
- A, no tampering (repro.mjs): `sEqEar.left = {toJSON(){volume.top='nested';return 1}}` crosses as undefined. The host sees one op and no skin code runs.
- B, tampered (repro2.mjs): WeakMap.prototype.get returns a skin object `evil = {toJSON(){volume.top='nested'; return 1}}`. The dispatcher receives set(1,'top','nested') with host stack `forward<dispatch<native<fromRealm<dispatch<native`, so it is inside the outer OP_SET's fromRealm. Only then does the outer set(2,'left',{__h:1}) arrive, and it succeeds, because toJSON picked a handle that is in the table. ENGINE D1 says 'A host op never runs skin code before it returns', and that is violated. The comment at membrane.js:177 depends on the realm half being intact, which the file header says the host half must not assume.
- Prelude-only fix fails (repro3.mjs): I patched a copy in /tmp/f6verify/preludeonly so the prelude captures WeakMap.prototype.get, the reviewer's second suggestion. It does not close the hole. The skin catches `this` (the prelude's handleOf) in a replaced WeakMap.prototype.set when `volume` is first touched (proxyFor). It then calls `realSet.call(handleOf, evil, evil)`, and the same nested op comes back.
- Limits that still hold: a spinning toJSON ends in a hard 'budget' fault at 101 ms. Recursion toJSON->set->dump stops at depth 138 on QuickJS's stack limit; the host stack does not overflow. The handle-table check holds. No nested op happens while a dispatcher call is running, because fromRealm finishes before forward(). So the effect is reordered ops plus skin code running inside a membrane op. Nothing escapes.
- One more cost: a box holding 10k-30k references to a 1 KiB string makes a single op take 130-360 ms against the 100 ms budget, with zero dispatcher ops. It is recorded only as a SOFT fault, not a budget fault. QTS_Dump runs QuickJS's C JSON stringify, which skips the prelude's JSON.stringify guard, and the host then parses the result. This is not the R19 residual, which covers builtins the skin calls itself.
- Not documented and not intended: R19 and R20 do not cover this. ENGINE ledger #23 rejects host-side deep copies of realm objects for exactly this re-entry reason. prelude.js:40-42 says the worst that tampering with uncaptured intrinsics can do is break the skin's own lookups, and this shows otherwise.
- The finding's 'separately, p2' half: /tmp/realmprobe/p2.mjs is a big-string timing probe, so that citation is wrong. My repro4/5 confirm the behaviour anyway. A thrown `{toJSON(){volume.top=...}}` runs from settle (stack native<settle<enter), inside the entry with active>0 and the deadline live, and a spin there ends in a hard 'budget' fault. So that path breaks no D1 rule. It does let a skin spoof {name:'InternalError',message:'out of memory'} into a hard 'memory' fault that unloads the view at once, with no tampering needed. That belongs to the reviewer's separate fault-spoofing finding.
- Fix tested on a copy (/tmp/f6verify/patched, membrane.js only): cases B, C, D and repro3 all become a soft 'membrane: value cannot cross', toJSON never runs, and the big-dump op takes 0.2-0.3 ms. 117 of 117 realm tests pass. wmploc.test.js fails in the /tmp copy both with and without the patch, because a support import is missing there. No repo files were edited.
- **Fix (verifier):** In membrane.js fromRealm (lines 176-183), replace the `ctx.dump(h)` object case with a null test and a read of the single `__h` property:

```js
case 'object': {
  if (ctx.eq(h, ctx.null)) return { ok: true, value: null };
  const p = ctx.getProp(h, '__h');
  try {
    const n = ctx.typeof(p) === 'number' ? ctx.getNumber(p) : NaN;
    if (!isHandleNumber(n)) return { ok: false, reason: 'value' };
    if (!table.has(n)) return { ok: false, reason: 'handle' };
    return { ok: true, value: { __h: n } };
  } finally { p.dispose(); }
}
```

Why getProp is safe here: every object that reaches fromRealm was made by the prelude's box(). Native ops receive arguments only through toWire, and readWire reads the results of evalExpr, callGlobal and readGlobal through toWire as well. `host` and `box` are private to the prelude closure, and `create` is captured at boot. box() writes a plain data property onto a null-prototype object, so reading `__h` runs no getter, proxy trap or toJSON, whatever value the skin managed to place in it. A value that is not a number is rejected. This also removes the uncapped C stringify plus host JSON.parse cost.

If the host half should not even rely on box() being the only source, send handles as a typed scalar instead, for example a BigInt read on the host with ctx.getString, so the host reads no realm properties at all.

A prelude-only fix is not enough. Capturing WeakMap.prototype.get alone fails (repro3); if it is done as hygiene, capture both get and set and call them through apply.

Also update the comment at membrane.js:177, and add a membrane test: with WeakMap.prototype.get tampered and a toJSON that writes another element, no nested dispatcher op may occur.

### F7 · medium · Host diagnostics from `realm-id-write` have no cap: skin code can push unlimited entries into the host log

- **Requirement:** ENGINE §1 rule 6 and the ledger precedent (model/ledger.js MAX_LEDGER_ENTRIES 2048: 'a skin that walks a million made-up member ... is capped'). The realm caps faultsLogged at 4096 and warnOnce at 1024, but not this path.
- **Location:** src/engine/realm/prelude.js:289-295 (the __IDS set trap: one OP_DIAG per new key), src/engine/realm/realm.js:430-434 (hooks.diag forwards every one to log.diag)
- **Repro (reviewer):** /tmp/realmprobe/p3.mjs. A handler running `for(var i=0;i<1e6;i++) __IDS['k'+i+'_'+Math.random()]=1;` produces 18,505 host diagnostics in about 300 ms, each with a skin-chosen elementId of up to 512 characters. The set trap fires for any key, not only id names. Spread over timers under the 50% duty cap, that is about 30k host diagnostics per second, with host memory outside the 64 MiB realm cap.
- **Verification:** The finding reproduces, and the effect is stronger than the report says. I built the realm the same way tests/engine/realm/fake-host.js does (createRealm, a fake dispatcher, a log that keeps every diagnostic, 64 MiB memory cap, 100 ms handler budget). No repo files were touched.

1. /tmp/f7verify/repro.mjs: one handler with no fault runs `for (var i = 0; i < 5000; i++) __IDS["k" + i] = 1;`. It returns {ok:true} and the host receives 5000 `realm-id-write` diagnostics. `__IDS` is a locked global that skin code can read, and its set trap (prelude.js:289-295) calls OP_DIAG for every new string key, whether or not the key is an id. The only filter on the host side is in membrane.js:313-317 (code up to 64 characters, detail up to 512). hooks.diag (realm.js:430-434) then forwards every one to log.diag, with elementId set to the raw string the skin chose. With 400-character keys, 262,198 diagnostics arrived before a budget fault, and the last elementId was 399 characters long.

2. /tmp/f7verify/sustain.mjs: a setInterval callback fired back to back produced 1,386,000 host diagnostics in 10 s of script time (about 139k per second). The only thing that happened was one `duty-cycle` hard fault, and one hard fault does not unload the realm (that takes 3 in 30 s).

3. /tmp/f7verify/duty.mjs is the key result. The same timer, kept at 40% duty for 20 s of wall time, produced 1,515,000 host diagnostics (75k per second) with **zero faults and no `realm-throttled` diagnostic**. Host heap grew by 243 MB, about 12 MB/s. That memory sits outside the 64 MiB realm cap, and none of the realm's limits (budget, duty cycle, unload, faultsLogged ≤ 4096) notices it.

Is this a known exception? No. It is not ENGINE R19 (slow builtins) or R20 (the call-assignment rewrite), and D1/U-31 does not cover it either: D1 accepts that an id write is reported, not that the number of reports has no limit. Everywhere else, skin-driven diagnostics are capped or logged once: faultsLogged ≤ 4096, the timer-cap and throttle messages fire once, launchURL and setvol are logged once, and ledger.js has MAX_LEDGER_ENTRIES 2048. This path was missed.

Why medium rather than the reviewer's low: there is no production Log sink yet (src/hosts/tauri has none), but the contract `HostedSkin.diagnostics(): Diagnostic[]` returns the diagnostics as an array, so a sink is expected to keep them, and the only sink that exists (src/hosts/test/index.js:243) keeps them with no limit. A hostile skin can therefore grow host memory without bound and never trigger a fault or an unload.

Side notes:
- In the reviewer's p3, the second case (500-character keys) is not a valid measurement. The keys go over the 512-character detail cap and are dropped, so it logged one diagnostic. Use the 400-character run above instead.
- The realm-side `idWritesNoted` SafeSet also grows without limit, but inside the realm. That is not a separate finding.
- Normal use is unaffected: bare case-variant assignments such as `VOLUME = 1` and `Volume = 1` still go through the `with(__IDS)` path and log as before.

Fix check: I copied the four realm files to /tmp/f7verify/realm/, patched realm.js there, and linked node_modules. With the patch, repro-patched.mjs gives 64 `realm-id-write` diagnostics plus 1 `realm-id-write-cap` diagnostic. duty-patched.mjs gives 64 plus 1 over 20 s, no faults, and about 0 MB host heap growth. The legitimate case-variant diagnostics are unchanged. The existing assertion in scope.test.js:79 (`['Ice']`) stays within any cap of 1 or more.
- **Fix (verifier):** Add the cap on the host side in src/engine/realm/realm.js. The realm half is explicitly not the security boundary, so the cap cannot live in the prelude. Use a plain counter, not a Set keyed by skin strings, so the fix does not open a new way to grow host memory. I validated this exact change on a /tmp copy:

```js
// REALM_CAPS
  maxIdWriteDiags: 64,
// beside timerCapLogged
  let idWritesLogged = 0;
// hooks.diag, after the existing `if (code !== 'id-write' || phase === 'script') return;`
        if (idWritesLogged > REALM_CAPS.maxIdWriteDiags) return;
        if (++idWritesLogged > REALM_CAPS.maxIdWriteDiags) {
          diag({ code: 'realm-id-write-cap', severity: 'warn', detail: `${viewKey}: more than ${REALM_CAPS.maxIdWriteDiags} assignments to ids; the rest are not logged` });
          return;
        }
```

Also add the cap to ENGINE §10 (Realm row).

Optional extra protection, not required for the fix: in the prelude's __IDS set trap, call OP_DIAG only when byExact or byLower has the key, and stop adding to idWritesNoted once the cap is reached. This alone would not be enough, because a long id has 2^len case variants and skin code can tamper with the realm half anyway.

### F8 · low · The R20 rewrite can pick the wrong `=` because errorPosition takes the first `:L:C` in the stack, which can come from the file name

- **Requirement:** WAVES W2.2 item 10: 'rewrite the one offending <call> = <rhs> statement on L'.
- **Location:** src/engine/realm/realm.js:130-134 (`/:(\d+):(\d+)/` matches the first occurrence), realm.js:197-199 (choosing a candidate by column)
- **Repro (reviewer):** /tmp/realmprobe/p14.mjs. `loadScript('x:1:1', 'var a; function f(){}\nf() = 1, (a) = 2;\n')` logs two script-rewrite diagnostics: the valid `(a) = 2` is rewritten first (column 1 taken from the file name), then `f() = 1`. So valid code is replaced with a throwing call. Because the replacement text is fixed and the file is skin-authored, this cannot inject code or gain capability.
- **Verification:** All scripts are in /tmp/f8verify/. No repo files were edited. The patched copy lives at /tmp/f8verify/repo/src/engine/realm/realm.js, with node_modules symlinked in.

1. dump.mjs compiles with quickjs-emscripten compileOnly and dumps the error. The dumped compile error has only name, message, stack, fileName and lineNumber. There is no columnNumber, so the reviewer's 'use columnNumber' option does not apply to this variant. For the file name 'x:1:1' the stack is '    at x:1:1:2:7\n'. The regex /:(\d+):(\d+)/ matches ':1:1' first, which gives column 1 instead of 7. The line still comes out right, because lineNumber is set and wins.

2. run2.mjs builds a realm the way tests/engine/realm/fake-host.js does, with a minimal dispatcher and the same caps, then calls loadScript and readGlobal. Results against the repo's realm.js:
- Source 'var a = 0; function f(){}\ntry { f() = 1 } catch (e) {} (a) = 2;\n'. Named 'Skin.wmz!s.js' it loads ok, a=2, and only 'f() = 1' is rewritten. Named 'Skin 1:2:3.wmz!s.js' (the stack reads ':2:3', so column 3) it gets two script-rewrites: the valid ' (a) = 2' first, then 'f() = 1'. The load then fails with 'TypeError: Cannot assign to a function result' and a stays 0.
- The same shape with 's = "xa=y".replace(/(a)=/g, "")' after the bad statement. Under the colon name, the scanner treats '(a)=' inside the regex literal as a candidate. Rewriting it breaks the regex, giving 'SyntaxError: unexpected line terminator in regexp', and the whole file is lost (script-syntax). Under the plain name it loads ok with s="xy".
- A wider case the reviewer missed, with the PLAIN name 'Skin.wmz!s.js': 'var a = 0; function f(){}\ntry { f() =\n  1 } catch (e) {} (a) = 2;\n'. The column here is correct (3:3), but no candidate sits before it, so the branch `before.length ? ... : candidates[last]` picks '(a) = 2' anyway. Result: two rewrites (' (a) = 2', then 'f() ='), the load fails, a=0. So the reviewer's regex fix on its own does not close the finding.
- With both fixes below applied, run2.mjs against the patched copy gives: every case loads ok, a=2 and s="xy", with exactly one rewrite each ('f() = 1' or 'f() =').

3. corpus.mjs runs the original and patched repairScript over all 219 corpus scripts, using the realm-gate's compile check. Result: 219 of 219 identical, 0 lost with either version, 7 rewrites with each.

4. unit.mjs runs the rewriteCallAssignment and errorPosition expectations from tests/engine/realm/rewrite.test.js against the patched copy. All hold, plus the new colon-name cases.

This is not a documented residual. ENGINE R20 and WAVES W2.2 item 10 say the loader rewrites 'only statements QuickJS rejects', and here a statement QuickJS accepts gets rewritten.

Severity is low. The name is built by the host as 'archive!file'. A colon is legal in a macOS POSIX file name (a Finder '/' becomes ':') and in a zip entry name, so a skin can carry such a name. The rhsNextLine case needs no special name at all. In every case the damage stays inside the skin's own script: a valid statement is replaced by one that throws, or the file is lost. The replacement text is fixed, so no code is injected and no capability is gained. The corpus is unaffected.
- **Fix (verifier):** Two one-line changes in src/engine/realm/realm.js. Both are needed, and each fixes a different case.

(a) errorPosition (line 131). Take the frame's own `:L:C` at the end of its line, not the first one in the stack:

  const m = typeof err.stack === 'string' ? /:(\d+):(\d+)\)?[ \t]*(?:\n|$)/.exec(err.stack) : null;

This fixes names that contain ':<n>:<n>'. The dump also carries `fileName`, so another option is to skip past `fileName` in the stack and parse `^:(\d+):(\d+)`. That would also cope with a name containing a newline. QuickJS gives no columnNumber, so that option is out.

(b) rewriteCallAssignment (just before `const eq = ...`, line ~198). When a column is known and no candidate comes before it, the `=` is not on this line. Return null so repairScript falls back to line-1:

  if (column !== null && before.length === 0) return null;

This fixes the case where the right-hand side starts on the next line, with any file name. The null-column path, used for the line-1 fallback, keeps 'last candidate'.

The reviewer's extra idea, dropping parenthesised left sides as candidates, is not needed once the column is right. `(a) = 2` is valid and does no harm as a candidate.

Tests to add in tests/engine/realm/rewrite.test.js:
- `errorPosition({ lineNumber: 2, stack: '    at Skin 1:2:3.wmz!s.js:2:13\n' })` returns `{ line: 2, column: 13 }`.
- `rewriteCallAssignment('x; (a) = 2;', 1, 1)` returns null.
- A realm-level loadScript of 'var a = 0; function f(){}\ntry { f() =\n  1 } catch (e) {} (a) = 2;\n' under both a plain name and 'Skin 1:2:3.wmz!s.js'. Assert one script-rewrite ('f() =') and readGlobal('a') === 2.

Checked on a patched /tmp copy: the corpus repair output is unchanged (219/219, same 7 rewrites).

## Lens: Scope semantics and conformance

**Holds (with evidence):**
- Precedence is element, then id, then script global, then host global. Handlers compile to `with(__IDS){with(this){body\n}}` (prelude.js:356-361). p1: a slider handler's `value` returns the member (50). A script `var counter` and functions declared in scripts see ids (`helper()` returns volume.value). `function player(){}` replaces the host global (host globals are configurable and writable, prelude.js:317-332). On the button, `top` returns the member 129 even with a script `function top` loaded.
- The case-variant id rule (D1 b/c) is implemented at prelude.js:277-281: an exact id hits; a case-insensitive id hits only when no own global property with that exact name exists; host names and reserved names never hit. `Volume`, `VOLUME` and `ice` all reach their ids (p1), and the scope.test.js cases for `function Volume` and `function volume` pass.
- The G17 exception holds. hostNames are checked exactly (prelude.js:278), the realm-id-shadowed diagnostic is at realm.js:805-806, and the `View` case variant stays an id. Ids named `eval` or starting `__wmp` get the realm-id-reserved diagnostic (realm.js:807-808).
- Undeclared names throw ReferenceError as soft faults. p1: `nope` gives a soft `ReferenceError: 'nope' is not defined` and `typeof nope` is 'undefined'. A jscript: `nope` is a soft fault at `expr 2.left` (p2 H). Case-variant calls of skin functions still throw (scope.test.js). The corpus-survey 4.3 B1/B2 requirement is met.
- Host members are case-insensitive and script identifiers are case-sensitive. The proxy traps lowercase before crossing (prelude.js:233-248), and the host lowercases again (membrane.js:271). `has` is answered from realm-side Sets and never crosses (prelude.js:233-236).
- Handler labels work. `jscript:`, `javascript:`, `wmpprop:`, `JScript:` before a function declaration, and a doubled `jscript: jscript:` all compile as labels. `JScript:let` compiles only after the one-label strip (prelude.js:355-379). `break jscript;` keeps working because the label is not stripped when the handler already compiles (p2 J). Handlers that still fail are cached once and diagnosed as handler-syntax (realm.js:769-772).
- jscript: values use `return eval(src)` inside `with(__IDS){with(this){}}` (prelude.js:353). A trailing `;`, `;;`, an empty string, a statement form and an embedded `jscript:` label all return completion values. A `var` inside a jscript: value stays local and does not leak to the global (p2 H). The value's `this` is the element handle.
- Script loading is a direct eval inside with(__IDS) (prelude.js:54, realm.js:846). Functions hoist to the global and close over __IDS (p1 helper()). An Annex B block function is visible to handlers (p2 B). Top-level `this` is globalThis (p2 D). Collisions are checked even when a file throws part-way (realm.js:848-854).
- `eval("eq"+i+".left=5")` writes through, and `a = b.visible = false` works (scope.test.js passes). The corpus has no indirect eval and no `Function(`, so ids reachable only through the direct-eval chain is enough (grep.mjs: 0 hits).
- R20 call-assignment rewrite: `eq.gainLevels(b) = v`, two rewrites on one line, if/else, a function RHS, a ternary RHS and `)=` inside a string are all repaired, each logged as a script-rewrite diagnostic. 32 rewrites load and the functions are callable (`after32()` returns 1); the 33rd loses the file (p3). The cap check is at realm.js:269, and line numbers come from the dumped `lineNumber` (a file named `evil:1:1.js` still rewrote line 4).
- The prelude internals are locked: __IDS, __wmp_badAssign, __wmp_src (a read-once accessor) and `eval` are non-writable and non-configurable (prelude.js:340-349). The native function is never a global property; the only reserved globals in globalThis are eval, __IDS, __wmp_badAssign and __wmp_src (p1). `f.caller` and `arguments.callee.caller` return undefined (p6).
- Timers: string callbacks compile with only the with(__IDS) chain and `this` is the global (p5: 'undefined:50:true'). A bad string interval is a soft fault on each fire. The 64-live cap and the 10 ms floor are in realm.js:403-421.
- Gesture: inGesture is false when idle and true for host calls inside runHandler with {gesture:true}. A value_onchange queued by that handler runs with inGesture false (p5: [[call,true],[call,false]]), because gestureDepth is decremented before drainQueue (realm.js:651, 667, 681-684).
- Determinism with testSeed: Date.now(), argument-less new Date(), Date() and Reflect.construct(Date,[]) all read the engine clock. Math.random gives the same sequence in two realms with the same seed, and the unseeded realm uses the real clock (p5).
- Corpus host-model checks over 195 distinct archives and 12,508 ids found nothing the realm gets wrong. No id equals a JS built-in or prelude global, and none equals a PLAYER parameter name case-insensitively. No handler declares a local `var` named like an element member or an id, and no implicit assignment targets a case variant of an id. The only exact-name hits are Navigator nav.js `var speed` (a function local, so correct) and plain id assignments in Gorillaz and Creed2 (skin bugs; realm-id-write diagnostic at handler time). The largest corpus script is 54,504 characters.

### S1 · medium · loadScript compile time is never budgeted: the R20 repair loop recompiles up to 33 times with no deadline check, and an overrun without an interrupt is a soft fault

- **Requirement:** ENGINE §10 'top-level scripts of a view 2,000 ms'. D1 Budgets: 'the interrupt budget is exceeded' is a hard fault. W2.2 item 10 (rewrite, retry, at most 32 per file). R19 documents only builtin-call overshoot, not parse time.
- **Location:** src/engine/realm/realm.js:256-276 (repairScript loop), 814-861 (loadScript), 665-673 (enter classifies a budget fault only by `interrupts`/`guardTripped`)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p4c.mjs: four 4 MiB script files, each ending in 32 `f(k) = k;` lines and then `var = ;`. Each loadScript takes about 4.0-4.4 s (33 uninterruptible whole-file compiles), 16.9 s in total against the 2,000 ms whole-view budget. Three of the four end as soft `SyntaxError` faults and one as a duty-cycle hard fault; no budget fault is recorded and the view stays loaded. p4b.mjs 8 32: one 8 MiB file blocks for 8.1 s and ends soft ('too many closure variables'). The QuickJS parser does not poll the interrupt handler, and script files are capped only by the 32 MiB archive-entry cap. The largest corpus script is 54,504 characters.
- **Verification:** I wrote my own probes in /tmp/verify-s1/ and did not edit the repo. h.mjs builds a realm the same way tests/engine/realm/fake-host.js does: a fake dispatcher, real performance.now as wallClock, 64 MiB memory, 256 KiB stack, a 2000 ms scripts budget.

1. Smallest repro (e2.mjs), one fresh realm and one file each. A 4 MiB script followed by 32 lines `f(k) = k;` and then `var = ;` takes 3,921 ms and ends `soft SyntaxError: variable name expected` with health.hard = 0. The same file with no call-assignments takes 122 ms. That is the 33x multiplier from the R20 repair loop: each compile is about 120 ms, and nothing checks the deadline between attempts. The 2,000 ms view budget is blown about 2x and no budget fault is recorded.

2. The QuickJS parser never checks the interrupt (e4.mjs). One compile, with no rewrites, of a 31 MiB array literal followed by a syntax error takes 2,830 ms. It ends as a soft fault with hard = 0. So even one compile can exceed the whole view budget, and the only size limit is the 32 MiB archive-entry cap (src/engine/archive/zip.js:18).

3. Several files in one view (e3.mjs). Four of the 4 MiB files take 16,050 ms in total. Three end soft and one ends as a duty-cycle hard fault; no budget fault is recorded. A tiny valid file loaded after that still returns ok: its budget is 0, but it never runs enough code for the interrupt to fire.

4. Worst case found (e5.mjs). One 16 MiB array literal plus 32 call-assignments and a syntax error is a single loadScript call that blocks for 47,641 ms. It ends as one soft fault plus one duty-cycle hard fault, and the view stays loaded. That is the same size as the 48 s `indexOf` overshoot that R19 accepts as a residual. It also matters that scriptFile lists are not deduplicated or capped in count (wmploc.js parseScriptFile, wms/build.js:506): a skin can name the same file many times.

5. The file sizes involved are far beyond real skins. The largest corpus script is 54,504 characters (I re-ran /tmp/realmprobe-scope/size.mjs). On a valid file, the per-size load time is 10 ms at 0.05 MiB, 142 ms at 1 MiB and 1,041 ms at 4 MiB (e1.mjs).

Not a documented residual. R19 covers builtin calls that run as a single interpreter tick. R20 says only "at most 32 per file". Neither ENGINE nor WAVES mentions parse or compile time. D1 lists "the interrupt budget is exceeded" as a hard fault, and §10 sets 2,000 ms for the top-level scripts of a view. The code charges script time against one shared budget (`budgets.scripts - scriptsSpent`), but a compile cannot be interrupted.

Prototype fix, applied to a copy at /tmp/verify-s1/fix (patched by patch.py plus an inline addition; node_modules symlinked):
- f1.mjs: the 4 MiB file is refused at 0 ms as `soft RangeError: script too large`.
- A 0.99 MiB array literal plus 32 rewrites ends `hard budget` at 2,014-2,083 ms (budget plus at most one compile). Later files are refused at 0 ms with `hard budget`, and the third hard fault unloads the view, under the existing 3-in-30-s rule.
- A corpus-sized 54 KB file plus 32 rewrites still loads in about 70 ms. Its `TypeError: Cannot assign to a function result` is the expected R20 run-time throw, not a regression.
- The patched copy passes the repo's realm tests: 9 files and 117 tests, with wmploc.test.js left out because it does not touch loadScript. 117 plus wmploc's 204 tests equals the repo baseline of 321, which I re-ran: 10 files, 321 passing.
- **Fix (verifier):** Smallest correct fix, all in src/engine/realm/realm.js:

1. Add `maxScriptChars: 1024 * 1024` to REALM_CAPS, about 19 times the largest corpus script of 54,504 characters. Add the matching row to ENGINE §10. In loadScript, after the typeof check, reject a source longer than that cap: emit a `script-too-large` diagnostic and return a soft fault `RangeError: script too large`. This limits each compile, including the second compile in the loader's eval, to about 100-350 ms.

2. In loadScript, before `enter`: `if (scriptsSpent >= budgets.scripts) return recordFault(site, { ok: false, kind: 'hard', reason: 'budget' });`. This check does not depend on the clock. Without it, a file that runs too little code for the interrupt to fire still loads after the view budget is spent, and WKWebView's coarse performance.now makes a check against `deadline = start` unreliable.

3. Give `repairScript` an optional `opts.stop` and check it at the top of every loop iteration: `if (opts.stop?.()) return { source: src, rewrites, error: null, stopped: true }`. Add `stopped?: boolean` to the RepairResult typedef. In loadScript, pass a stop function that does `if (wallClock() > deadline) { guardTripped = true; return true; } return false;`, and when `repaired.stopped` is set, return `{ ok: false, kind: 'hard', reason: 'budget' }`. Setting guardTripped matters: without it, `enter` turns a 'budget' outcome with no interrupt into a soft fault. The corpus gate calls repairScript without `stop`, so it is unaffected.

I left out the reviewer's third item, a wall-time reclassification in `enter`. With the cap and `stop`, a compile can overrun by at most one compile of a file of 1 MiB or less. The eval phase already checks the interrupt, so a blanket check of `wallClock() - start > budget` would add nothing here and could produce false hard faults in handlers.

Refusing scripts once the view's budget is spent follows the existing shared-budget rule (rewrite.test.js already expects the second slow file to end as a hard 'budget' fault); the fix applies it to compile time too.

Tests to add to the timing project:
(a) A ~1 MiB array literal plus 32 call-assignments ends `hard budget` within 2,000 + 400 ms, and the next file is refused at 0 ms as `hard budget`.
(b) A source of maxScriptChars + 1 characters ends `soft` 'RangeError: script too large' at about 0 ms, with a `script-too-large` diagnostic.
(c) A file of about 54 KB plus 32 rewrites still loads, and its functions can be called.

### S2 · low · Promise jobs left over after the 1,000-job drain cap run inside the next entry, inheriting its gesture flag

- **Requirement:** W2.2 item 7: 'inGesture is true only inside runHandler(..., {gesture: true})'. D6.5 gesture gating (view.close/minimize user-gesture only). D1: pending jobs drain under the budget of the entry that queued them.
- **Location:** src/engine/realm/realm.js:651-657 (gestureDepth++ before body and drainJobs), 489-498 (executePendingJobs(1000) leaves the rest queued)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p5b.mjs. A non-gesture 'ontimer' handler runs `n = 0; function step(){ if (++n < 2500) Promise.resolve().then(step); else view.close(); } Promise.resolve().then(step);`. After that entry n is 1000 and close has not run. The next handler is a user click ({gesture:true}) with body `1`. It drains the leftover jobs and view.close() runs with realm.inGesture === true (output [true], n = 2500). Leftover jobs are also charged to the unrelated entry's site and budget.
- **Verification:** I wrote my own repro, separate from the reviewer's probe: /tmp/s2-verify/repro2.mjs. It calls createRealm with FAITHFUL.budgets and a fake dispatcher that records realm.inGesture on every view.* call. No repo files were edited.

Case A. onload calls setTimeout. The real fireTimer entry has no gesture. Its body queues a chain of 1,001 jobs (`n=0; function step(){ if (++n <= 1001) Promise.resolve().then(step); else view.close(); } Promise.resolve().then(step);`). After fireTimer: ok, and no close has run. The next runHandler(2, onclick '1', {gesture:true}) runs the leftover jobs, and view.close sees inGesture=true. The output is ["close:inGesture=true"].
Control B. The same chain at 999 jobs fits in one drain, and close sees inGesture=false.
Case C. Faults land on the wrong entry. A leftover job that spins for 50 ms is absorbed by evalExpression(2,'left','5'). That call returns {ok:false, kind:'hard', reason:'budget', site:'expr 2.left'}. The timer entry that queued the job reported ok.
Case D. A self-rescheduling flood never stops. Each later entry drains 1,000 more jobs, gesture entries included.

Root cause: in realm.js enter() (lines 651-667), gestureDepth stays raised across both body() and drainJobs(). drainJobs (489-498) stops at maxJobsPerDrain=1000, and the remaining jobs stay in the QuickJS runtime until the next entry drains them.

Side note: readGlobal is itself an entry when called outside one (line 917, enter(`read ${name}`)), so it drains pending jobs. That runs skin code, which contradicts the header comment saying it runs none. It also hides this bug in probes that read state between entries. The reviewer's p5b only fires because its chain (2500) exceeds 2 drains.

The reviewer's proposed fix is insufficient. I tested it on a /tmp copy (/tmp/s2-verify/treeB): one pre-drain at gestureDepth 0 before raising the gesture. With a 2,500-job chain from a timer followed by 3 clicks (/tmp/s2-verify/chain3000.mjs), the original code gives ["close:true"], the reviewer's single pre-drain still gives ["close:true"], and fix A below gives ["close:false"].

Fix A, on a /tmp copy (/tmp/s2-verify/tree): repro2 A gives close:inGesture=false, p5b gives [false], and the realm suite passes 9 files and 117 tests. That run excludes wmploc.test.js, which needs the repo's tests/support fixtures. Fix A does not address the misattribution in case C.

Why severity is low and not higher: each view has its own QuickJS runtime (createRealm makes a new module, runtime and context). So the leftover code that gains the gesture comes from the same skin that already writes the gesture handlers, and it could put view.close() in any onclick. Nothing gains a new capability. Promise does not exist in WMP's JScript, so no corpus skin is affected.

It is still a real deviation, not a documented residual (R19 and R20 do not cover it):
- The enter() docstring says the gesture holds for the body only.
- The tests pin that timers and _onchange calls queued by a gesture run outside it.
- D1 says jobs drain under the budget of the entry that ran them, but leftover jobs are charged to an unrelated entry's budget and fault site.
- **Fix (verifier):** Smallest correct fix (fix A): in enter(), scope the gesture to body() only, so every pending-job drain runs outside it, including jobs left past the 1,000 cap. In src/engine/realm/realm.js around 651-667, replace `if (frame.gesture) gestureDepth++; ... try { outcome = body(); if (!poisoned) outcome = worse(outcome, drainJobs()); }` with:

    let inGesture = frame.gesture === true;
    if (inGesture) gestureDepth++;
    active++;
    let outcome;
    try {
      try { outcome = body(); }
      finally { if (inGesture) gestureDepth--; inGesture = false; }
      if (!poisoned) outcome = worse(outcome, drainJobs());
    } catch (e) { ...unchanged... }

Then delete the later `if (frame.gesture) gestureDepth--;` after `active--`.

This matches the docstring ("gesture ... hold for the body only") and the event-handle precedent in runHandlerNow, which revokes the event handle before anything the handler queued runs. Verified on a /tmp copy: all 117 realm tests still pass, and p5b, repro2 and chain3000 all show close with inGesture=false.

Accepted behaviour change: a click handler's own `.then(() => view.close())` is no longer honoured. No test pins it, and JScript has no Promise.

Do not use the reviewer's single pre-drain. It leaves the hole open for any chain longer than 2 drains (shown at 2,500).

If keeping a gesture handler's own jobs inside the gesture is required: before raising the gesture, drain leftover jobs until hasPendingJob() is false, as their own non-gesture entry (for example site 'jobs', handler budget). This also fixes the misattribution in case C. The cost is that a perpetual flood becomes a budget hard fault on the next entry.

Add a test in timers.test.js item 7. A timer queues a chain of 2,500 jobs ending in view.close(); then run 3 gesture clicks with no readGlobal between entries, because readGlobal outside an entry drains jobs; expect seen == [false].

Separately, fix the realm.js header comment that says readGlobal "runs no skin code", or make readGlobal skip drainJobs.

### S3 · low · Id writes during script loading are silently swallowed: realm-id-write is suppressed in the script phase, and the collision snapshot catches only new exact-name own properties

- **Requirement:** D1 Script files: the id write-through is 'accepted and diagnosed'. W2.2 item 1: 'a top-level var x where x is an id writes through and is diagnosed'.
- **Location:** src/engine/realm/realm.js:430-434 (`phase === 'script'` drops the id-write hook); prelude.js:459-476 (snapshotGlobals/collisions)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p2.mjs case A. loadScript('a.js', 'volume = 5; function f(){ sEqEar = 3 } f();') returns ok with no diagnostics at all; both writes go nowhere. The same `Ice = 1` from a handler gives realm-id-write. Case E: e1.js `var volume = 1` and then e2.js `var volume = 2` log script-id-collision for e1.js only.
- **Verification:** Independent probe /tmp/verify-s3/v.mjs (uses the createRealm harness /tmp/realmprobe-scope/h.mjs, fake dispatcher; no repo edits).

Confirmed:
- A1 `loadScript('a.js','volume = 5;')` returns {ok:true}, logs no diagnostics, makes no dispatcher set and creates no global.
- A2 `function f(){ sEqEar = 3 } f();`: no diagnostics.
- A4 the case-variant write `Volume = 5;`: no diagnostics.
- A5 `eval("Ice = 1")` during load: no diagnostics.
- Controls: a handler-only `sEqEar = 4` logs realm-id-write:sEqEar. So does a script-declared `f` called only from a handler.

Worse than reported (A3): src/engine/realm/prelude.js `ids` set trap adds the name to `idWritesNoted` before the host hook in realm.js:432 drops it. After the A2 load, a later handler `f()` and a direct handler `sEqEar = 4` both stay silent. So one write during script load suppresses realm-id-write for that id for the rest of the realm, not only during loading.

E: e1.js `var volume = 1` then e2.js `var volume = 2` logs script-id-collision for e1.js only. Two files that both declare `function volume(){}` also log e1.js only. This happens because collisions() diffs new own properties, and the e2 initializer never reaches the host because the name is already in idWritesNoted.

Not a documented residual: R19 and R20 do not cover it. D1 says the write-through is "accepted and diagnosed", and the realm.js:431 comment assumes the collision check catches every case, but it catches only declarations.

Corpus impact: /tmp/realmprobe-scope/scan.mjs finds 7 implicit exact id writes in scripts across 195 archives: Creed2.js BioSplash x4 and gorillaz.js openright6/closeright/eq_controls. /tmp/verify-s3/ctx.mjs and ctx2.mjs show each one sits inside a function (ShowBio*, rightEarControls) with no top-level call, so none runs during load. The impact is diagnostics only: the write goes nowhere under U-31 either way.

Fix check: I copied realm.js to /tmp/verify-s3/fix/realm.js with absolute imports and a symlinked node_modules, then patched it (/tmp/verify-s3/fix/patch.mjs) and ran /tmp/verify-s3/fix/vf.mjs:
- A1, A2, A4 and A5 now log script-id-write:<name>:a.js. In A3, sEqEar is reported once, at load.
- The scope.test.js case `var volume = 5; var plain = 6; function sEqEar(){}` still logs exactly two script-id-collision entries and no script-id-write.
- A handler `Ice = 3; Ice = 4;` still logs exactly [realm-id-write:Ice].
- A script that writes and then throws still reports the write, and the next load is clean.
- E is unchanged.
I did not run vitest on the copy. The two scope.test.js expectations are preserved by inspection and by the runs above.
- **Fix (verifier):** A host-only change in src/engine/realm/realm.js; prelude.js is untouched.

1. Next to `let phase = null;` add `const scriptIdWrites = new Set();`.
2. In hooks.diag, replace `if (code !== 'id-write' || phase === 'script') return;` with `if (code !== 'id-write') return; if (phase === 'script') { scriptIdWrites.add(detail); return; }`.
3. In loadScript, after the script-id-collision loop and before `return ran`, report each buffered name that is not already in clash.value: `for (const id of scriptIdWrites) if (!declared.includes(id)) diag({ code: 'script-id-write', severity: 'warn', file, elementId: id, detail: ... })`, where `declared` is clash.value when it is an array and [] otherwise.
4. In the finally block, call `scriptIdWrites.clear()`.

Do not use the reviewer's "emit immediately" variant. `var volume = 5` fires the set trap and also appears in collisions(), so it would report the one case the drop was protecting twice. The buffer also covers A3: the name gets reported once, under script-id-write.

Leave out the reviewer's "compute collisions per file over declared names" half. In e2.js the redeclaration never reaches the host (the prelude has already noted the name), so a host fix can't reach it. Fixing it needs a static top-level declaration scan, or dropping the prelude's per-name dedup during script loading. The case is cosmetic, because e1.js has already reported that the binding is unreachable. Record it as a residual: the collision is reported once per realm, against the first file that declares the name. Optionally add a scope.test.js case: `loadScript('a.js','function f(){ sEqEar = 3 } f(); volume = 5;')` should log script-id-write for sEqEar and volume with file a.js.

### S4 · low · The R20 rewrite targets left sides other than `<call> = <rhs>`, and its left extent can produce a different error

- **Requirement:** W2.2 item 10 and E R20: rewrite 'the one offending `<call> = <rhs>` statement' into `__wmp_badAssign()`, which throws TypeError('Cannot assign to a function result').
- **Location:** src/engine/realm/realm.js:190-212 (any `)` before `=` is a candidate; the left side walks back over identifiers, `.` and brackets only)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p3.mjs. `var a, b; (a + b) = 1;` is rewritten (statement ' (a + b) = 1', with a leading space), so a file whose error is not a call assignment loads. `x + f(a) = 1;` rewrites only `f(a) = 1` and keeps `x +`. `new Foo(x).bar(y) = 1;` becomes `new __wmp_badAssign()` and throws 'TypeError: __wmp_badAssign is not a constructor'. `f(a)\n= 5;` is not repaired (the line-1 fallback assumes the `=` ends the earlier line). A line with a regex literal holding a quote (`s.replace(/'/g,'')`) is not repaired either. These last two only lose the file, as before. All 7 corpus cases are handled correctly.
- **Verification:** I ran /tmp/s4verify/repro.mjs, more.mjs and more2.mjs. Each loads a file with realm.loadScript over a plain createRealm (the /tmp/realmprobe-scope/h.mjs harness with a fake dispatcher). The repo's tests/engine/realm/fake-host.js could not be used: it calls afterEach, so it throws outside vitest. Each script then calls t(0) and t(1) through a handler and compares the result with V8's `new Function` parse. Nothing in the repo was changed.

Reproduced as reported:
- `(a + b) = 1` loads, with statement " (a + b) = 1" (leading space). V8 rejects it as an early error, so W2.2 item 10 says the file should be lost.
- `x + f(a) = 1` becomes `x + __wmp_badAssign()`.
- `new Foo(a).bar(a) = 1` becomes `new __wmp_badAssign()`, which throws "TypeError: __wmp_badAssign is not a constructor". This is a real call assignment (V8 compiles it), so the ruled message is wrong here.
- `f(a)\n= 5` is not repaired, nor is a line with `s.replace(/'/g,'')`. Both files are lost, the same as before R20.

Found beyond the report:
- `a && f(a) = 1` and `a || f(a) = 1` load, and the statement throws only when the left operand allows the call. Real runs gave t(0) = "noThrow" for `&&` and t(1) = "noThrow" for `||`.
- `a ?? f(a) = 1` gives "noThrow" for both 0 and 1. V8 rejects all three as early errors.
- `!f(a) = 1`, `x == f(a) = 1` and `return (a + b) = 1` (the walk swallows `return`) load. They do throw the correct TypeError.
- `new Foo(a) = 1` loads with the wrong message. V8 rejects it as an early error.
- `a ? f(a) = 1 : 0` is a real call assignment in the middle of a ternary (V8 compiles it). The right-side scan runs past the `:`, giving `a ? __wmp_badAssign();`, and the file is lost with "SyntaxError: expecting ':'".

Controls that are correct: `f(a)=1`, `return f(a) = 1`, and `a ? 0 : f(a) = 1` (which throws only when that branch runs, as in V8).

Impact: the only outcomes that go wrong at run time are the short-circuit cases, which do not always throw, and the `new` case, which gives the wrong message. The rest load a file the spec says to lose, but throw the right error in the right place. The two cases the rewrite misses (`f(a)\n= 5` and the regex) only lose the file, as before. None of these patterns is in the 219-script corpus (all 7 corpus cases are single-line and handled), and there is no budget or sandbox effect. That is why I rate it low. Not a documented residual: ENGINE R20 and WAVES W2.2 item 10 both limit the rewrite to `<call> = <rhs>`.
- **Fix (verifier):** The reviewer's fix is only partial. A "callee before `(`" test still accepts `x + f(a)`, `a && f(a)`, `!f(a)` and `new Foo(x)`, because `f` or `Foo` sits right before the `(`. It also accepts `return (a+b)`, because the whitespace skip at realm.js:203 lets the walk swallow `return`. And extending over `new` without a further check would accept `new Foo(x) = 1`.

The smallest correct fix, all in rewriteCallAssignment:

1. **Callee test.** After the whitespace skip at :203, the word ending at k must be an identifier that is not a reserved word (return, typeof, void, delete, throw, in, instanceof, case, else, do), or the char must be `)` or `]`. Otherwise return null. This rejects `(a + b) = 1` and `return (a + b) = 1`.

2. **Left-boundary test.** After the left walk (:206-211), look at the first non-space token before lhsStart. It must be one of:
   - start of line
   - `;` `{` `}` `(` `[` `,` `?` `:` `)`
   - an assignment `=` (plain or compound), but not the last char of `==`, `!=`, `<=` or `>=`
   - `=>`
   - the words return, else, do, case or throw

   If it is the word `new`, move lhsStart back over it, but only when a further call follows `new X(..)` in the chain. Anything else (`+ - * / % & | ^ ! ~ < >`, `&&`, `||`, `??`, typeof, void, delete) returns null, so the file is lost as the spec says.

3. **Right-side scan (:216-229).** Count depth-0 `?` seen in the right side, and stop at a depth-0 `:` that no right-side `?` matches. This fixes `a ? f(a) = 1 : 0` without breaking `f(a) = b ? c : d`.

Pin these in tests/engine/realm/rewrite.test.js:
- `(a + b) = 1` gives null
- `x + f(a) = 1` gives null
- `a && f(a) = 1` gives null
- `a ?? f(a) = 1` gives null
- `return (a + b) = 1` gives null
- `new Foo(x).bar(y) = 1` gives `__wmp_badAssign()`
- `a ? f(a) = 1 : 0` gives `a ? __wmp_badAssign() : 0`
- `a ? 0 : f(a) = 1` gives `a ? 0 : __wmp_badAssign()`
- `return f(a) = 1` gives `return __wmp_badAssign()`

Leave `f(a)\n= 5` and a regex literal holding a quote as residuals: they only lose the file, as before R20. Optionally name them in the ENGINE R20 row rather than adding a cross-line scan.

### S5 · low · PLAYER event parameters lose to a case-variant id (and to element members), so the exact-case binding rule does not protect them

- **Requirement:** D1 Scope chain (b): a case-variant id hits only when no exact-name binding exists, so a skin's exact-case declaration beats the case variant. W2.2 item 3: PLAYER parameters are visible in exact case.
- **Location:** src/engine/realm/prelude.js:276-281 (only `hasOwn(g, k)` is consulted) and 356-361 (parameters sit outside both `with` scopes)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p2.mjs case F. With ids [{id:'newstate', ...}], runHandler(100, {event:'playStateChange', source:'out = typeof NewState + ":" + NewState', params:['NewState']}, {params:{NewState:3}}) fails soft with 'TypeError: toPrimitive', because NewState resolves to the element proxy. The corpus has no such id and no schema member collides, so this is latent.
- **Verification:** I built a realm the way tests/engine/realm do it: createRealm over a fake dispatcher, harness at /tmp/s5verify/h.mjs, probe at /tmp/s5verify/run.mjs. Nothing in the repo was edited. Each case calls runHandler(100 = player, {event, params}, {params: values}) on the unmodified src/engine/realm.

Results on the repo realm:
1. Control, no colliding id: NewState gives "number:3".
2. id 'newstate' (case variant) against param NewState: fails soft with "TypeError: toPrimitive", because NewState resolved to the element proxy. This matches the reviewer's case F.
3. id 'NewState' (exact case): same TypeError. Rule (a) for exact ids also beats the param.
4. Asymmetry: a skin global `function NewState` does beat id 'newstate' ("function"), because ids `has` checks hasOwn(g,k). A parameter is not a global property, so the exact-case rule never sees it.
5. Corpus-shaped case: id 'playList' with PlaylistChange params ['Playlist','change'] gives "object:7". Playlist silently becomes the element, with no fault.
6. id 'Playlist' (exact case): also "object:7".
7. Synthetic: a param named like a member of `this` (status) gives "Playing", so the member beats the param.
8. A closure created in the handler and fired later by a timer also sees the id ("object").

Cause: prelude.js:356-361 compileBody builds construct(Function, [...params, 'with(__IDS){with(this){'+body+'}}']), so the parameters sit outside both `with` scopes. ENGINE D1 lines 235-239 prescribe exactly this compile string, so the code follows D1 to the letter. D1's precedence list never places parameters, and its rule (b) only protects own properties of the realm global. This is a spec gap, not an implementation slip, and it conflicts with W2.2 item 3 ("PLAYER parameters are visible in exact case only"). It also conflicts with JScript, where a procedure's formal parameters are its innermost scope. ENGINE R19/R20 and the rest of D1 say nothing about it, so it is not a documented residual.

Corpus: my read-only scan is /tmp/s5verify/corpus.mjs, which prints to stdout. The reviewer's "the corpus has no such id" holds only for the 7 names listed in D1. attrs.js PLAYER_EVENTS defines 14 parameters, including Playlist (PlaylistChange), Start (Buffering) and Item (MediaChange). Across 195 archives, 16 .wms files declare a colliding id: 15 are playlist/playList/Playlist (Grinch, Sports, robbie, TheUnit, compact, Gorillaz, tubeframe with exact-case 'Playlist', Plus! Space/Nature/Aquarium/da Vinci, The_Unit_v3, Heart_Butterfly, Josie, Deadside) and one is start (v2_underworld). None of the 17 PLAYER handlers that read a parameter sits in a .wms with a matching id, so the bug is still latent. When it does trigger on Playlist, the wrong value is another object and nothing faults, which makes it silent.

Member half: the schema (/tmp/s5verify/schema.mjs) shows no member of the `player` or `element.player` classes collides with any of the 14 names. The member-shadowing case therefore only shows up in synthetic tests.

Severity is low: the bug is latent today, it only matters if a skin uses that combination, and the fix needs a D1 ruling. The fix below was tried on a /tmp mirror of src/ and tests/engine/realm with node_modules, skins and tools symlinked or copied: `npx vitest run --project timing tests/engine/realm` gives 10 files and 321/321 tests passing, including leak.test.js, which does 1,000 dispatches with params ['NewState']. Probe cases 2, 3, 5, 6, 7 and 8 then bind the param (number:3, string:7, PARAM). Labels, a function declaration after a label, `return`, this===player, `arguments`, and ReferenceError for undeclared names all behave as before (/tmp/s5verify/edge.mjs).
- **Fix (verifier):** This needs an O ruling to amend ENGINE D1: PLAYER parameters bind innermost, ahead of members of `this` and ahead of ids (exact or case-variant), as JScript procedure formals do. D1's compile string would change accordingly. The smallest correct code change is in prelude.js compileBody only. Handlers without params keep their exact current form, and runHandler is unchanged:

```js
function compileBody(params, body) {
  if (params.length === 0) return construct(RealFunction, ['with(__IDS){with(this){' + body + '\n}}']);
  const list = [];
  for (let i = 0; i < params.length; i++) list[i] = params[i];
  list[params.length] = '';
  construct(RealFunction, list);   // validates the names as formal parameters before splicing
  let names = '';
  for (let i = 0; i < params.length; i++) names += (i === 0 ? '' : ',') + params[i];
  const factory = new RealFunction('with(__IDS){with(this){return function(' + names + '){' + body + '\n};}}');
  return function (...args) { return apply(apply(factory, this, []), this, args); };
}
```

The factory runs on every dispatch inside the `with` chain, so the parameters become the innermost scope. It uses the prelude's captured `apply`, so a skin that overwrites Function.prototype.apply cannot change how handlers are called. The reviewer's first option, a per-dispatch Set consulted by the ids `has` trap, is not correct. Scope is lexical, so a closure made in the handler and run later by a timer (probe case 8) would resolve NewState to the id once the Set is cleared. The reviewer's second option, nesting a function, is the right shape.

Add a scope.test.js case: id 'playList' plus PlaylistChange params ['Playlist','change'] gives the param value. Another case: id 'newstate' plus NewState gives 3.

### S6 · low · Test-mode determinism escape: Date.prototype.constructor is still the real Date

- **Requirement:** D1 Determinism: in test mode, argument-less `new Date()` reads the engine clock.
- **Location:** src/engine/realm/prelude.js:484-489 (FakeDate is a Proxy over RealDate; RealDate.prototype.constructor is unchanged)
- **Repro (reviewer):** node /tmp/realmprobe-scope/p5.mjs. With testSeed 'abc' and the engine clock at 12345, `new (new Date(0).constructor)().getTime() === 12345` is false and `Date.prototype.constructor === Date` is false, so the wall clock reaches a golden run. The plain forms are correct.
- **Verification:** I wrote my own probe, /tmp/verify-s6/repro.mjs, using createRealm with a fake dispatcher whose now() is manual, testSeed 'abc', and the engine clock set to 12345. Seeded results:
- These forms are correct and return 12345: `new Date().getTime()`, `Date.now()`, `Date()` (string), `Date.prototype.constructor.now()` (RealDate.now is patched), and `class X extends Date{}; new X().getTime()`.
- These forms escape to the wall clock, about 1.79e12: `new (new Date(0).constructor)().getTime()`, `new Date.prototype.constructor().getTime()`, and `new (Object.getPrototypeOf(new Date(0)).constructor)().getTime()`. The call form `Date.prototype.constructor()` also returns the real-time string.
- An identity check behaves differently by mode. With a seed, `Date.prototype.constructor === Date` and `new Date(0).constructor === Date` are both false. Without a seed, both are true. So test mode changes what a skin can observe, which the D1 determinism hooks are meant to prevent. This is the stronger reason it is a bug and not just a stretch of D1's wording, which names only `Date.now` and argument-less `new Date()`.
- The cause is at prelude.js:484-489. FakeDate is a Proxy over RealDate. The proxy's get on `prototype` returns RealDate.prototype, and that object's `constructor` is still RealDate.
- It is not an R19 or R20 residual.

Why low: a scan of the corpus .wms/.js files (with /tmp/realmprobe-scope/grep.mjs) finds no uses of `.constructor`. Only 4 archives (8 lines) use argument-less `new Date()`, all in the plain form, which works. So no corpus skin reaches the escape or the identity difference. A golden run is affected only if a skin outside the corpus uses that pattern.

Fix check: I applied the one-line fix to a copy of src under /tmp/verify-s6/patched/, with node_modules symlinked from the repo. All the escape forms then return 12345, the identity checks return true, the call form matches, `class extends Date` still returns 12345, and unseeded mode is unchanged. I added a regression test to a copy of prelude.test.js. It fails on the unpatched prelude ("expected [1791358484105, false, false, false] to deeply equal [4321, true, true, true]") and passes on the patched one. The patched copy passes 9 of the 10 realm test files (118 tests). I left out wmploc.test.js because it needs the corpus fixtures, which account for most of the 321-test baseline. It has no Date or testSeed assertions; its only `constructor` mentions are about null-prototype constant records. Nothing was written in the repo.
- **Fix (verifier):** In the seeded branch of prelude.js section 8, right after `defineProperty(g, 'Date', { value: FakeDate, ... })`, add one line:
  defineProperty(RealDate.prototype, 'constructor', { value: FakeDate, writable: true, enumerable: false, configurable: true });
Add a regression test to the 'determinism hooks' describe block in tests/engine/realm/prelude.test.js:
  it('under a test seed, the Date reached through a date instance is the engine clock too', async () => {
    const a = await makeRealm({ options: { testSeed: 'f9671f06' } });
    a.clock.advance(4321);
    expect(outOf(a, 'return [new (new Date(0).constructor)().getTime(), Date.prototype.constructor === Date, new Date(0).constructor === Date, Date.prototype.constructor() === Date()]')).toEqual([4321, true, true, true]);
  });
This test was verified to fail without the fix and pass with it.

### S7 · low · The element proxy's `has` omits 'attributes present in its markup'; the contract gives no channel for them

- **Requirement:** D1 Scope chain: 'The element proxy's has answers true only for members of the element's class plus attributes present in its markup, compared case-insensitively.'
- **Location:** src/engine/realm/realm.js:45-47 (says it is not implemented); prelude.js:233-236; contracts.d.ts setIds row {id, handle, className}
- **Repro (reviewer):** There is no realm API to pass per-element markup attributes. A handler on a TEXT element that names a markup-only attribute not in the class schema throws ReferenceError (p1 pattern: `min` on a button). realm.js suggests registering a per-element class instead, which W4.1 would have to do.
- **Verification:** Reproduced. It is a real gap between the D1 text and the §5.5 contract and implementation. It is not an R19/R20 residual, and D1 does not intend it: D1 (ENGINE.md:240-241) says element `has` is true for "members of the element's class plus attributes present in its markup". The only place the deviation is written down is the realm.js:45-47 header comment, which is code documentation, not a ruling. No repo files were edited.

Repro: /tmp/s7verify/repro.mjs, run as `node /tmp/s7verify/repro.mjs` from the worktree. It uses the real createRealm and the real schema `classMembers()`. Element handle 1 is class element.button, and its markup has `foo` and `down`. `setIds` is passed `attrs:['foo']` and silently ignores it, because the contract row is only {id, handle, className}.
- `out = down` → ok, true. `down` is a class member.
- `out = foo` → {ok:false, kind:'soft', reason:"ReferenceError: 'foo' is not defined", site:'handler 1.onclick'}. D1 says `foo` should resolve on the element.
- `typeof foo` → 'undefined'.
- `foo = 7` → ok, but it creates a realm global (readGlobal('foo') = 7) and does not write to the element. A later `jscript:foo` then returns 7.
- `this.foo` → 'bar' only because of the fake dispatcher. In the real stack, objects/core.js `read()` calls lookupMember → undefined → records `unknown-member` and returns undefined, and element objects pass no `opts.fallback`. So even with `has` true, a markup-only attribute would read as undefined and a write to it would be dropped.

Corpus impact: /tmp/s7verify/corpus.mjs (stdout only) runs the real `scanWms`, `resolveTag`, `elementClassName` and `lookupMember` over the primary .wms of all 195 distinct archives: 22,110 elements and 19,943 script-valued attributes. 1,254 elements carry at least one markup-only attribute. They are typos and undocumented names such as bordersize, enable, fonttype, scrollingammount, z-index, horizontalalignemnt, resizeable, which is G12's "kept but ignored". 0 handlers or jscript: values on the firing element name one of their own markup-only attributes bare. Positive control (/tmp/s7verify/control.mjs, same matcher): 2,942 bare references to markup attributes that are class members. So no corpus skin is affected. Severity low: spec drift with no observed effect.

INCIDENTAL, NOT S7 (needs separate routing, likely higher severity): event-kind schema members (`onload`, `onclose`, `on*`) are in `classMembers()`, so the element proxy's `has` case-folds a skin function name onto them. Repro /tmp/s7verify/side.mjs: VIEW handle with className 'view', script `function OnLoad(){ran=1}`, handler `onload="OnLoad();"` → {ok:false, kind:'soft', reason:'TypeError: not a function'}, ran=0. The handler's own attribute text shadows the skin's function. Scan /tmp/s7verify/side-scan-all.mjs counts 220 corpus handlers with this pattern:
- 65 on VIEW, across 57 archives. These are certain, e.g. Goo, aoe, rad `OnLoad();` and MSN, NPR `OnClose();`.
- 149 on PLAYER. Whether these break depends on W4.1 passing element.player rather than player.
- 2 customslider and 2 subview.

Nothing caught it because h.mjs and the realm tests use fake member lists with no event members, and no test in tests/engine/realm uses the schema's `classMembers()`. Candidate fix: leave kind:'event' members out of the `has` set, either in `schema.classMembers()` or when the prelude builds its member sets.
- **Fix (verifier):** Smallest correct fix is option (b), with O amending ENGINE D1 and no code change. Change the clause to: "The element proxy's has answers true only for members of the element's class (the schema's attribute table for its kind plus its methods), compared case-insensitively; an attribute present in markup but absent from the schema (a typo or undocumented name, G12) is not in scope, so a bare reference throws ReferenceError and an assignment falls through like any unknown name." Then point realm.js:45-47 at the amended text and drop its "register a per-element class" suggestion.

Option (a) costs more than the reviewer's fix line suggests and buys nothing the corpus uses. Adding an optional per-row `attrs` to §5.5 setIds and unioning it into a per-handle Set in the prelude only changes ReferenceError into undefined. The real host object (objects/core.js makeObject) answers unknown members with undefined plus an `unknown-member` ledger entry and drops writes. Making the clause mean anything would also need a host-object fallback for markup-only attributes and W4.1 wiring. The corpus has 0 uses against a 2,942-use positive control.

The incidental event-member shadowing finding (OnLoad / OnClose / On*Change) is a separate issue and should be routed on its own.

### S8 · low · QuickJS's Function constructor lets a handler body close the wrapper and run code at compile time, outside the with scopes

- **Requirement:** D1: handlers compile once to `new Function(<params>, "with(__IDS){with(this){" + body + "\n}}")`. The body is meant to be a FunctionBody; CreateDynamicFunction parses it standalone.
- **Location:** src/engine/realm/prelude.js:356-361, 363-379
- **Repro (reviewer):** node /tmp/realmprobe-scope/p2.mjs case I. The handler `}}}); out2 = 1; (function(){{{` compiles and sets out2 = 1 at compile time, in global scope. `}} out = typeof top; {{` runs outside with(this) ('undefined'). When the first compile fails and the label retry recompiles, injected statements can run twice. This stays inside the realm and its budget, so the boundary holds. The corpus does not do this (12,868 handlers compile as RG0 pinned).
- **Verification:** Reproduced independently, without editing the repo. Scripts: /tmp/verify-s8/repro.mjs (uses the /tmp/realmprobe-scope/h.mjs createRealm harness, which builds the realm the same way tests/engine/realm/fake-host.js does), /tmp/verify-s8/engines.mjs and /tmp/verify-s8/fix.mjs.

1. Escaping the function. The handler `}}}); hits = (typeof hits==='number'?hits:0)+1; ...; (function(){{{` returns {ok:true} and sets hits=1 on the first dispatch, during compileHandler at global scope outside both with() blocks. A second dispatch leaves hits at 1, so the injected code runs once per compile, not once per dispatch. No handler-syntax diagnostic is emitted.
2. Escaping the with blocks. `}} w = typeof top + '/' + typeof volume; {{` gives 'undefined/undefined' every dispatch. A normal handler gives 'number/object'. V8 also accepts this body because the wrapped text is a valid FunctionBody, so this part comes from D1's string concatenation, not from QuickJS.
3. Non-function result. `}}}); ({a:{b:{c:1` compiles to an object. Every dispatch then fails with a soft fault 'TypeError: not a function', and no handler-syntax diagnostic is ever emitted or cached. This is a diagnosability gap.
4. Running twice. `jscript: ; }}}); n2=...+1; throw new SyntaxError('b'); (function(){{{` runs the injected statement twice (n2=2): once on the first compile and once on the label-strip retry.
5. The boundary holds. A compile-time `for(;;){}` hits a hard 'budget' fault after about 101 ms, inside enter() with the handler budget (realm.js:750-766), and the realm keeps working afterwards. Nothing crosses the membrane.
6. Engines (engines.mjs). V8 throws SyntaxError on both the function escape and the comma escape (`}, y=1, function(){`). Both QuickJS variants in node_modules, the bellard build the realm uses and quickjs-ng, run the injected code (y=1), so switching variants does not help.

This is not a documented residual. R19 covers interrupt latency and R20 covers call-assignment rewrites; neither applies. D1 says a body that fails to compile 'becomes a syntax diagnostic', and here it runs instead.

Fix tested in plain QuickJS (fix.mjs). With a random label block inside with(this), all four escape bodies above become SyntaxErrors with zero side effects ('break/continue label not found' or 'unexpected token'). return, function declarations, let/var, a jscript: label with break jscript, two stacked labels and a trailing // comment all still compile, and the handler still resolves `top` through this and `volume` through __IDS. Corpus regression: all 12,938 handler attributes under skins/wmp were compiled with both wrappers, including the label-strip retry. 12,933 compile under both, with 0 acceptance differences and 0 side effects. The 5 failures match survey 5.2.
- **Fix (verifier):** Validate the exact text that runs. Put a per-compile random label block inside with(this) and end it with a break to that label. In compileBody (prelude.js:356-361), change the last argument to:

  'with(__IDS){with(this){' + N + ':{' + body + '\nbreak ' + N + ';}}}'

N is an identifier such as '__h' + 24 random hex characters. QuickJS parses the whole Function-constructor text before running any of it. Any body that closes the label block leaves `break N` unresolved, and the skin cannot declare a label it does not know, so the compile fails with a SyntaxError before anything runs. The existing label-strip retry then ends in the handler-syntax diagnostic, as D1 already specifies. This also covers the with() escape, the non-function result and the double run.

Generate N on the host, for example crypto.getRandomValues in realm.js, and pass it as a fourth argument to callEntry('compileHandler', ...). Do not use the prelude's Math.random: in test mode it is seeded from the skin's SHA-256, so it is predictable. The only visible change is fn.toString(), and no other behavior or determinism changes.

Use this in-wrapper check rather than a separate host-side compileOnly pre-check of a different wrapper text. A different text can parse differently from the one that actually runs. Apply the same wrapper to the timer string path at prelude.js:436 (`new RealFunction('with(__IDS){' + t.code + '\n}')`), which has the same class of problem. There the risk is cosmetic, because skin code builds timer strings at run time and already has full power inside the realm.

Add a line to ENGINE D1 or the R table: 'QuickJS's Function constructor evaluates its concatenated text, so handler bodies are compiled inside a nonce label block.'

## Lens: Denial of service and faults in the script realm

**Holds (with evidence):**
- Budgets fire on the wallClock passed in, not the engine clock. The harness dispatcher's now() always returns 0, and while(1){} in a handler is still hard/budget at 100.3-102 ms. Evidence: realm.js:383-389 (interrupt handler reads wallClock), realm.js:646 (deadline).
- Per-entry budgets measured. Scripts share 2,000 ms across files: one file is hard/budget at 2,002 ms; after a file uses 1,200 ms the next is cut at 799.7 ms. onload is cut at 1,000.4 ms, onclose at 1,000.2 ms, a handler or timer at about 100 ms, and a jscript: value at 20.5 ms. Evidence: realm.js:747, 781, 823, 869, 902.
- A missing or non-finite budget fails closed with deadline = start. Evidence: realm.js:646.
- The 1,000 ms jscript: pass cap is not the realm's job. It is EvaluateLayoutFn's passBudgetMs (contracts.d.ts:459), and the realm only enforces the 20 ms per-expression budget (realm.js:869).
- Promise jobs are drained inside the same entry and budget, at most 1,000 per drain: a self-rescheduling flood gives n=1001 and no fault. A job running while(1){} is hard/budget within the budget. Evidence: realm.js:489-498, 657.
- A thrown value whose name/message getter, toJSON, or Proxy traps loop forever ends as hard/budget at 100.2-100.5 ms. This works because ctx.dump of the thrown value runs inside enter() while the deadline is still live. Evidence: realm.js:467-472.
- A catastrophic regex is interrupted within budget: /(a+)+$/.test('a'.repeat(30)+'b') stops at 101 ms, and a loop of /(x+x+)+y/ over a 4,000-char string (under GUARD_MIN, so unguarded) stops at 100.2 ms.
- The duty cycle on a fake wall clock matches D1. At 60%, 79%, 90% and 100% busy, the throttle starts after 5 s above 50%. At 90% or more, the first hard fault comes at 10 s and the realm unloads at 30 s (third duty-cycle fault). At 79% it throttles but never faults. The throttle re-floors only repeating timers below 40 ms (a 5 ms interval goes to 40 ms; a 100 ms interval and a one-shot are left alone). Evidence: realm.js:502-553, 677-680.
- Timer caps hold. With 70 setTimeout calls, 64 are accepted and 6 return 0, with exactly one realm-timer-cap diag. A delay of 0 is floored to 10 ms and 1e12 is clamped to 2^31-1. Refused timers are never stored realm-side. Evidence: realm.js:403-421, prelude.js:404-413.
- The _onchange ping-pong between two sliders stops after 33 sets with one soft fault, 'change chain deeper than 32', and no hard fault. Evidence: realm.js:697-699, 878.
- A host exception escaping the WASM call is a hard fault that unloads at once and discards the instance. In a 30-case battery, 16 shapes escaped as a host RangeError (nested parens/arrays/ternary/unary/new/template/await parse, JSON.parse nesting, getter and toString recursion, generator and async recursion, nested array toString/flat/JSON.stringify). Every one gave hard/host-exception with state 'discarded', and a fresh createRealm worked afterwards. Evidence: realm.js:658-664, 83, 607-622.
- Discard-never-dispose after a hard fault holds in every probe: every realm that recorded a hard fault ended 'discarded'. Evidence: realm.js:607.
- Three hard faults within 30 s unload and discard. Evidence: realm.js:568-574 and the duty-cycle and id-write probes (health.hard 3, unloaded true, state discarded).
- Host-callback robustness: log calls are wrapped (realm.js:365-381), dispatcher.timer errors are caught (realm.js:413-418, 424-428, 508-513, 598-602), and membrane.native catches everything (membrane.js:250-258). Getter recursion that crosses the membrane at every level (get/set/call/timer/id-write) always ended in a clean QuickJS 'InternalError: stack overflow'. A depth scan never got a host RangeError swallowed inside membrane.native.
- The re-entrancy rules from W2.2 items 6 and 7 behave as described: handlers and timers queue FIFO and evalExpression/callGlobal/loadScript/setIds refuse while an entry runs. The breadth of that queue is reported as a finding below. Evidence: realm.js:784-886.
- wmploc.js feeds the realm only constant primitives and one array (wmplocConstants, wmploc.js:59-68) through JSON in the boot cfg (realm.js:965). SPRINTF_LIBRARY_SOURCE's per-key work is ordinary interruptible JS plus the guarded String.prototype.replace, so nothing in wmploc adds a DoS path.

### DOS-1 · high · The 64 MiB realm memory cap counts only per-allocation overhead, not allocation size: a skin can grow the WASM heap to 2 GiB with no fault

- **Requirement:** ENGINE §10 'Realm memory 64 MiB'; D1 'Hard faults: ... memory ... is exhausted'; RG0 item 5 'A 200 MB string hits the memory cap'; W2.2 item 4 'a 200 MB allocation is an OOM'
- **Location:** src/engine/realm/realm.js:315
- **Repro (reviewer):** Through the realm, with makeRealm-style options (memoryLimitBytes 64 MiB):
  hn.handler('hoard = [];', {event:'onload'});
  for (let i = 0; i < 400; i++) {
    const r = hn.handler('for (var i = 0; i < 40; i++) hoard.push("x".repeat((1 << 20) + hoard.length));');
    if (!r.ok) break;
  }
Result: host RSS +455 MiB at dispatch 10, +1,258 MiB at dispatch 30, +2,060 MiB at dispatch 50. Every dispatch is ok with health.hard 0. It only ends as hard/memory at dispatch 50 (4.2 s) when the wasm32 heap hits its 2 GiB maximum. On a bare runtime with rt.setMemoryLimit(64 MiB), both the bellard and quickjs-ng variants show this. 'x'.repeat(1 MiB) in a loop stops at 2,041 strings (RSS +2,058 MiB). {x:i} objects stop at exactly 3,543,307 for both object and short-string shapes (64 MiB / 18.9 B, i.e. only the per-allocation overhead is counted), with memory_used_size 243 MiB and RSS +316 MiB. RG0's 200 MB test passes only because that single allocation is larger than the limit on its own.
- **Verification:** Everything ran in /tmp/oomverify-67151 using the repo's own createRealm (src/engine/realm/realm.js), built the way makeRealm builds it: 64 MiB memory, 256 KiB stack, FAITHFUL.budgets, the real performance.now wall clock, a fake dispatcher with now() frozen at 0. No repo file was edited; realm.js and membrane.js have the same mtimes as before and contain none of the probe code.

1. Reviewer's repro (probe-realm.mjs) reproduces exactly. Every dispatch is ok with health.hard 0. RSS is +452 MiB at dispatch 10, +1,255 MiB at 30 and +2,058 MiB at 50. Dispatch 51 ends as hard/memory at 4.17 s. Peak footprint is 2.19 GB.

2. Mechanism, on a bare runtime (probe-bare.mjs, both variants). With 2,042 one-MiB strings live and the heap at 2,048 MiB, rt.dumpMemoryUsage() says "malloc_usable_size unavailable" and "memory allocated 7148 57184 (8.0 per block)". QuickJS under emscripten counts 8 bytes per block, so setMemoryLimit only refuses a single allocation larger than the cap. The quickjs-ng variant (0.12.1) behaves the same.

3. Faster than the reviewer's path. One onload entry running `for(;;) hoard.push(new Uint8Array(1<<24))` reaches the 2 GiB ceiling in about 107-151 ms. The interrupt handler was polled once during that whole run, so the reviewer's interrupt-handler check could not catch it.

4. This is not a documented residual. ENGINE R19 relies on this cap ("bounded by the 64 MiB memory cap"). RG0 item 5 and W2.2 item 4 pass only because 200 MB is a single allocation over the limit.

5. Extra hazard at the ceiling, already present in the repo (probe-newstring.mjs, probe-marshal2.mjs). When the heap cannot grow, quickjs-emscripten's ctx.newString ignores the NULL from _malloc and writes the host string at wasm address 0: 2,044 of the first 2,048 bytes changed, with no error. In the repo, filling to 2 GiB with typed arrays and then reading a host property that returns 60 KB traps with "table index is out of bounds" (a corrupted call_indirect). The realm contains this as hard/abort and discards the instance. It stays inside the wasm sandbox.

6. Fix validation on patched copies (x, x2, x3 under /tmp/oomverify-67151):
   - x2: capped memory alone is not enough. A small-object flood comes back as soft "uncaught " (ctx.dump of a dead heap is "" or null) and the realm stays live.
   - x: capped memory plus a post-entry check at max - max/32 misses the band where the heap can no longer grow. With 63 MiB + 8-9 MiB typed arrays the heap sits at 76.3-77.3 MiB, the result is soft "uncaught null", and the realm stays live.
   - x3 (the fix below): every shape ends as hard/memory and discarded, with RSS at most +83 MiB and no trap. Shapes tested: the reviewer's loop at dispatch #1, typed-array burst, string concatenation, object flood, the growth-plateau case, and window placements from 75.9 to 84.3 MiB. Marshal probes give memory, not abort. A legit skin cycling 20 x 1 MiB stays live for 200 dispatches. The existing realm suite passes 117/117 (9 files; wmploc.test.js was left out because it needs repo fixtures).

Severity: high rather than critical. The cap fails open by 32x, the gate tests pass while it is broken, and one entry can take a view to 2 GiB in about 150 ms. But the damage stops at the wasm32 ceiling, ends in a contained hard fault with discard, and does not compromise the host. It becomes critical if WKWebView's WebContent process is killed under N views x 2 GiB (one realm per view, every onload at skin load, discarded instances held until GC). That could not be tested from /tmp.
- **Fix (verifier):** Enforce the cap on the wasm linear memory, not on QuickJS's accounting. This is the smallest change tested correct (x3 above). All of it goes in createRealm in src/engine/realm/realm.js, except the membrane guard in step 4:

1. Give the module a capped WebAssembly.Memory. The variant imports its memory: the glue uses `d.wasmMemory`, or else creates one with maximum 32768 pages.
   ```
   import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
   const heapCap = 16 MiB /* variant INITIAL_MEMORY */ + opts.memoryLimitBytes;
   const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: Math.ceil((heapCap + heapCap / 16) / 65536) });
   mod = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory }));
   if (mod.getWasmMemory() !== wasmMemory) throw ...;
   ```
   Keep the identity assertion: passing a CJS `{default: variant}` wrapper silently drops the memory, and getWasmMemory is marked @experimental. The maximum sits 1/16 above heapCap because the glue grows by at least 5% (it tries 1.2x, then 1.1x, then 1.05x). So malloc can only return NULL once byteLength is already past heapCap.

2. In enter(), after body and drainJobs, add `if (wasmMemory.buffer.byteLength > heapCap && outcome is not 'abort') { poisoned = true; outcome = { ok:false, kind:'hard', reason:'memory' }; }`. This is required: at a dead heap the dumped error is "" or null, so classifyError would otherwise report a soft fault. It also catches a skin that catches its own OOM. 'memory' already unloads at once and discards.

3. Add `if (byteLength > heapCap) return true;` to the interrupt handler.

4. Hardening: at the top of membrane.native, `if (hooks.heapOver?.()) return ctx.undefined;`. This stops host-to-realm marshalling from writing through a NULL malloc at address 0.

Leave setMemoryLimit in place for the single-allocation refusal. Do not rely on the interrupt-handler-only check the reviewer proposed: it is polled about every 10k ticks, and 2 GiB can be allocated between two polls. Because of the 1.2x overgrowth, the effective cap is about 61-75 MiB of skin data; document that.

Tests: keep the 200 MB case as the single-allocation test. Add accumulation cases: 1 MiB strings across dispatches, `new Uint8Array(1<<24)` in one onload, an object flood, a caught OOM, and the 63 MiB + 8 MiB plateau placement. Each must end as hard/memory and discarded with heap at most heapCap x 17/16.

Docs: update ENGINE §10 (line 1947) and the R19 text to say that the cap is the linear-memory maximum. Re-check in WKWebView at W3.R that JSC accepts an imported memory with a smaller maximum.

### DOS-2 · high · The synchronous queue drain has no total bound: one host call blocked the main thread for 30 s with no handler ever over budget

- **Requirement:** D1 'No synchronous re-entry ... queued and dispatched after the current entry point returns, FIFO. The chain depth is capped at 32 per originating event'; §10 per-entry budgets (handler/_onchange 100 ms); D1 unload leaves 'The window menu keeps working'
- **Location:** src/engine/realm/realm.js:690-707 (drainQueue), 681-684
- **Repro (reviewer):** Three elements (ids volume/b/c = handles 1/2/3). The fake dispatcher's set(h,'value') calls realm.runHandler(h, {event:'value_onchange', source: src[h]}), where each source burns 5 ms and then writes two other sliders:
  1: 'var t=Date.now(); while(Date.now()-t<5){} b.value=1; c.value=1;'
  2: '... volume.value=1; c.value=1;'   3: '... volume.value=1; b.value=1;'
Then: hn.handler('volume.value = 5;', {el:2}).
Result: that single runHandler call returns after 30.0 s of continuous synchronous execution (11,937 handlers queued, 1,873 soft 'chain deeper than 32' and 'too many queued dispatches' faults). It ends only because the duty cycle hard-faults at 10, 20 and 30 s. It then returns {ok:true} even though the realm unloaded and was discarded during its own drain.
- **Verification:** Ran under /tmp/dosverify-dos2. repro.mjs imports the worktree's createRealm directly. It uses the real performance.now wallClock, a dispatcher whose now() is frozen at 0, FAITHFUL.budgets, 64 MiB memory and 256 KiB stack. dispatcher.set(h,'value',v) calls realm.runHandler(h,{event:'value_onchange',...}), which is the same pattern as the repo's own ping-pong test (tests/engine/realm/membrane.test.js:156). Like ElementModel.set, the dispatcher fires only when the value changes (elements.js:176 `if (Object.is(prev, next)) return false`).

**The reviewer's repro does not trigger it through the real model.** Its three sliders write constant 1s. With change detection on, it stops after 4 dispatches and 21 ms.

**Minimal repro that does trigger it.** One slider (`volume`, handle 1) whose value_onchange is `var t=Date.now(); while(Date.now()-t<5){} volume.value=1; volume.value=2;`. Each write changes the value, so every dispatch queues two more (fan-out 2). Then call `realm.runHandler(1,{event:'onclick',source:'volume.value = 5;'})`.

Unpatched results:
- **5 ms burn:** that one call ran synchronously for 29,979 ms. It ran 9,526 dispatches and logged 1,335 soft "too many queued dispatches" faults. It ended only because the duty cycle hard-faulted 3 times (at 10, 20 and 30 s), which unloaded and discarded the realm. The call still returned {ok:true}.
- **99 ms burn:** 30,033 ms, also unloaded.
- **0 ms burn:** 2,146 ms. It ends on its own at the depth cap after about 90k dispatches and 86k soft faults.
- **Linear ping-pong (fan-out 1) at 99 ms:** 3,179 ms. This is the worst case D1 already allows.

**Why it happens.** Depth 32 does not bound the total once fan-out is 2 or more. The queue holds at maxQueued=4096 for about 20 generations, so up to about maxQueued × maxChainDepth (roughly 131k) dispatches can run in one drain. The only thing that stops it is the duty cycle, after 30 s, during which the main thread never yields. That breaks D1's "The window menu keeps working".

**Not a documented residual.** R19 covers slow builtins, R20 call-assignment repair, and R11 _onchange ordering. D1's "capped at 32 per originating event" is meant to bound exactly this cascade.

**Caveat.** The W3 runtime that drains ElementModel.takeQueuedEvents into runHandler is not in the worktree yet. Real exposure depends on it calling runHandler from inside the dispatch, which is the path the realm header and its tests document. If it instead loops runHandler while active===0, the depth cap never applies at all: the same hole, but in another file.

**Fix check.** I patched a copy of realm.js at /tmp/dosverify-dos2/realm-patched.js (the fix below). Results:
- 5 ms self: 1,003 ms, realm stays live, 1 soft fault.
- 99 ms self: 1,101 ms, live.
- 0 ms self: 1,003 ms.
- 99 ms linear chain: 1,092 ms.
- 0 ms linear chain: unchanged (33 dispatches, one "deeper than 32" soft fault, 5 ms).

The repo's own ping-pong test runs in milliseconds, so the patch would not change it.

**Minor point.** The outer runHandler returns {ok:true} although the realm unloaded during its own drain. health.unloaded is set, so this is a small issue and not part of the fix.
- **Fix (verifier):** Put a wall-time limit on the whole drain in drainQueue (src/engine/realm/realm.js:690). A count cap alone is not enough: 256 dispatches × 100 ms is still 25.6 s. Nested enter() calls return at `if (draining)`, so one drain is one originating event and a local start time is enough. No new realm state and no contracts.d.ts change are needed.

  const drainQueue = () => {
    if (draining) return;
    draining = true;
    const drainStart = wallClock();
    try {
      while (queue.length && state === 'live' && pendingUnload === null) {
        if (wallClock() - drainStart > budgets.load) {
          recordFault('queue', { ok: false, kind: 'soft', reason: `change chain over ${budgets.load} ms; the rest of its queued dispatches dropped` });
          queue.length = 0;
          break;
        }
        ...existing body...

Dropping the rest is a soft fault, the same as D1's depth cap. The worst case becomes about budgets.load + one handler budget + the outer entry, roughly 1.1 s, compared with 30 s today.

The alternative limit REALM_CAPS.maxChainDepth × budgets.handler (3.2 s) keeps D1's linear 32 × 100 ms chain exactly as documented. budgets.load is tighter and reuses an existing budget.

Add a regression test: fan-out 2 with handlers that burn a few ms. It should return in about 1 s with one soft fault, and the realm should stay live.

### DOS-3 · high · Script compilation cannot be interrupted, and the R20 repair loop recompiles up to 33 times without checking the deadline: a 0.45 MiB file blocks for 27 s

- **Requirement:** §10 'top-level scripts of a view 2,000 ms'; D1 budgets; W2.2 item 10 (repair at most 32 per file)
- **Location:** src/engine/realm/realm.js:256-276 (repairScript loop), 814-833 (loadScript compile callback)
- **Repro (reviewer):** let s=''; for (let i=0;i<40000;i++) s+=`var v${i};\n`; for (let i=0;i<32;i++) s+=`f(${i}) = 1;\n`;
realm.loadScript('a.js', s)
Result: hard/budget after 26,961 ms in one synchronous call. Each compile-only pass of 40k global vars takes about 1.2 s (20k: 0.55 s, 80k: 2.85 s, where it then fails with 'too many closure variables'), and the file is compiled 34 times. Without the bad assignments it is 2.3 s. A file with 200k plain statements (2 MiB) and 32 rewrites takes 2.8 s. The scripts budget is not checked before compiling: after one file used up the 2,000 ms, a second loadScript still compiled and ran ('var x = 1' returned ok). Up to three such files run before the 3-hard-fault unload, so about 80 s of freeze. No cap on script source size exists in §10 (the archive entry cap is 32 MiB).
- **Verification:** All runs are in /tmp/dos3v-5100. The realm was built the way tests/engine/realm/fake-host.js builds one: createRealm from the worktree's src/engine/realm/realm.js, FAITHFUL.budgets (scripts 2000 ms), 64 MiB memory, 256 KiB stack, wallClock = performance.now, and a dispatcher whose now() always returns 0. No repo files were edited.

1. Compile is never interrupted (p2.mjs). Direct QuickJS ctx.evalCode with compileOnly, plus an interrupt handler that counts its calls:

| global vars | file size | compile-only time | interrupt polls |
|---|---|---|---|
| 10k | 0.10 MiB | 138 ms | 0 |
| 20k | 0.22 MiB | 260 ms | 0 |
| 40k | 0.45 MiB | 1,006 ms | 0 |
| 60k | 0.68 MiB | 2,173 ms | 0 |
| 65k | 0.73 MiB | 2,716 ms | 0 |

Time grows faster than linearly with the number of global vars. The compact form `var _0,_1,...` (p4.mjs) reaches 65,534 vars at 0.33 MiB and compiles in 3.0 s. 66,000 vars fail with "too many closure variables". So the cost of one compile is set by the number of globals, not by the file size.

2. Repro through the realm (p1.mjs, p3.mjs). The source is 40,000 lines of `var v${i};` plus 32 lines of `f(${i}) = 1;`, about 0.45 MiB, loaded with realm.loadScript('a.js', s).
- Result: {ok:false, kind:'hard', reason:'budget'} after 21,392 ms in one synchronous call, with 32 script-rewrite diagnostics. That is 33 compile-only passes plus the loader's own parse.
- The same file without the 32 bad assignments loads in 1,627 ms and returns ok.
- At 65,000 vars plus 32 bad assignments (0.73 MiB), one loadScript took 63,314 ms.

3. Budget not checked before compiling (p3.mjs). Three copies of the 40k+32 file loaded one after another:
- File 0: 22.5 s, budget fault plus duty-cycle fault.
- File 1: 21.3 s, even though its remaining budget was already 0. It went through all 33 compiles anyway. The realm unloaded after it (3 hard faults).
- File 2: refused as unloaded.
- Total freeze: 43.8 s.

So the reviewer's "up to 3 files, about 80 s" is slightly off. Each file also trips the duty-cycle hard fault, so the realm unloads after 2 files. The freeze is about 44 s at 0.45 MiB and about 126 s at 0.73 MiB.

4. One sub-claim did not reproduce as stated, and it does not matter. The reviewer says a second loadScript('var x = 1') returned ok after the budget was spent. In my run it returned hard 'budget' in 3.2 ms. Whether a tiny file passes depends on when QuickJS happens to poll its interrupt counter. The real point, that a file still compiles with no budget left, is shown by file 1 above.

5. Not a documented residual:
- R19 covers slow builtin calls made by running skin code. Script parsing is not covered, and neither is the up-to-33x repeat.
- R20 limits the repair to 32 rewrites per file but says nothing about time.
- §10 sets 2,000 ms for the top-level scripts of a view. This overshoots it by 10 to 30 times.
- Nothing in the corpus triggers it: the largest corpus .js is 107 KiB, and the 7 files that need a rewrite need one each. A crafted skin triggers it at will.

6. The fix was checked on a patched copy (fix/src, with node_modules symlinked):
- The 40k+32 run drops from 21.4 s to 2,273 ms, and files 1 and 2 are refused in 0 ms as hard budget faults. The realm unloads on the 3rd fault.
- The 65k+32 run drops from 63 s to 3,845 ms.
- The 40k file without rewrites still loads ok in 1,958 ms.
- The realm tests against the patched copy: 117 of 117 pass (rewrite, faults, duty, guards, timers, scope, membrane, leak, prelude). wmploc.test.js could not load in the sandbox because tools/make-corpus-manifest.mjs was not copied; that has nothing to do with the patch.
- **Fix (verifier):** The fix is two deadline checks in loadScript in src/engine/realm/realm.js (around lines 824-842). A QuickJS compile never calls the interrupt handler, so the budget has to be checked before each compile:

```js
const repaired = repairScript(source, (src) => {
  if (wallClock() >= deadline) { guardTripped = true; return { name: 'InternalError', message: 'interrupted' }; }
  const r = ctx.evalCode(src, file, { type: 'global', compileOnly: true });
  ...
});
// rewrite diags as now, then BEFORE the script-syntax branch and before snapshot/stage/LOADER_SOURCE:
if (guardTripped || wallClock() >= deadline) { guardTripped = true; return { ok: false, kind: 'hard', reason: 'budget' }; }
```

How it works:
- Setting guardTripped makes enter() report a hard 'budget' fault through its existing tripped path.
- The second check stops the loader's direct eval from parsing the text one more time once the budget is gone.
- The second check sits before the script-syntax diagnostic on purpose. A stop for budget is not a syntax error and must not be reported as one, so do not move it after that branch.
- Optionally, refuse at the top of loadScript when scriptsSpent >= budgets.scripts, so the refusal does not rely on the clock having moved past deadline.

What remains after the fix is one uninterruptible compile per file. QuickJS caps a file at 65,534 globals, which compiles in about 3 s; 3.8 s was measured with the fix. That is the same class as R19's one-builtin-call overshoot. Add it to R20 or R19 as a documented residual; a QuickJS build with finer interrupt polling (phase 3) would close it.

The reviewer's source-size cap is optional extra defence and does not shrink that residual. A 0.33 MiB compact var list already costs 3 s per compile. If added, set it around 1 MiB (the corpus maximum is 107 KiB) and list it in §10.

### DOS-4 · medium · Loops of unguarded O(n) builtins and of plain operators on large strings overshoot by about 100 calls: 4-12 s per 100 ms dispatch

- **Requirement:** §10 handler budget 100 ms; E R19 (says the guarded residual is 'one builtin call' and names unguarded examples only as single calls); W2.2 item 11 (budget + 300 ms)
- **Location:** src/engine/realm/prelude.js:96-111 (GUARDED_BUILTINS), 505-609
- **Repro (reviewer):** An onload sets s1='0'.repeat(16<<20); s2=' '.repeat(16<<20)+'1'; s3=('y'+s1).slice(1) (plus a Set st). Then, in a 100 ms handler:
  for(;;){s1==1}            3,841-12,036 ms (one call 66 ms; about 95 iterations between interrupt polls)
  for(;;){+s2}              7,656 ms
  for(;;){encodeURIComponent(s1)}  6,682 ms
  for(;;){escape(s)} (4M)   6,913 ms
  for(;;){s2.trim()}        4,943 ms
  for(;;){parseFloat(s2)}   4,107 ms
  for(;;){st.has(s1)} / Map.get   2,663 / 2,531 ms
  for(;;){s1===s3} / s1<s3 / switch   923 / 443 / 433 ms (8-16 MiB)
Each ends as hard/budget, but only at the next interrupt poll. A further unguarded native path is the realm's own dump of a thrown value: an onload builds big=[30000 refs to one 1000-char string], and 'throw big' then takes 450 ms per dispatch and is only a soft fault, repeatably.
- **Verification:** Probes are in /tmp/verify-dos4-89374 (h.mjs, p1.mjs to p6.mjs). The harness builds the realm the way tests/engine/realm/fake-host.js does: createRealm, the real performance.now as wallClock, a dispatcher with now() frozen at 0, FAITHFUL.budgets, 64 MiB memory, 256 KiB stack. No repo files were edited. This machine runs the reviewer's cases about 2-3x slower than their numbers.

p1: an onload sets s1='0'.repeat(16<<20), s2=' '.repeat(16<<20)+'1', s3=('y'+s1).slice(1), s4 (4M chars), plus a Set and a Map. Then each loop runs as a 100 ms onclick, twice:
- s1==1: 11,231 / 14,771 ms (one call 138 ms)
- +s2: 7,472 / 9,350 ms
- encodeURIComponent(s1): 5,472 / 6,542 ms
- escape(s4): 11,011 / 15,688 ms
- s2.trim(): 5,521 / 5,461 ms
- parseFloat(s2): 4,170 / 5,182 ms
- Set.has(s1): 2,548 / 2,750 ms; Map.get(s1): 2,439 / 3,047 ms
- s1===s3: 971 / 1,172 ms; s1<s3: 1,004 / 1,265 ms; switch: 1,181 / 1,262 ms
All end as hard/budget. Controls stay in budget: the guarded s1.indexOf('b') loop takes 115 ms and an empty loop 100 ms.

p2 counts iterations per dispatch: loose == 167, trim 164, parseFloat 110, guarded indexOf 3, empty loop 84,030. So the guard does its job; unguarded work simply runs until the next interrupt poll.

p3 corrects the reviewer: their numbers are a lower bound. Top-level handler code resolves every name through the with(__IDS)/with(this) proxy traps. Each trap is a JS call that uses up interrupt ticks, giving about 165 iterations per poll. With function-local operands, (function(){var a=s1; for(;;){a==1}})() on a 1 MiB string ran 9,746 iterations, 47,676 ms against a 100 ms budget. At 256 KiB it took 13,678 ms. Extrapolated (not run): about 10,000 x 48 ms, roughly 8 minutes per dispatch at 16 MiB.

p4: spread, one of R19's own named unguarded examples, in the same local loop over a 100k-element array overshoots to 16,016 ms (4,294 iterations). Multi-second to minute hangs are therefore already reachable through a residual R19 names and accepts (force-quit plus D10 safe-mode boot as recovery, phase 3 as closure). DOS-4 gives a skin no new capability.

p6: a raw context on both @jitl/quickjs-wasmfile-release-sync and quickjs-ng with a deadline interrupt handler. Each ran 9,997 iterations of a local a==1 loop on 1 MiB with exactly one interrupt call (24.9 s and 21.3 s). Swapping to ng does not help. obj[bigString] is cheap (0.1 s) and is not in the class.

Where the docs go wrong: R19 says "Residual overshoot is one builtin call" and that the guards "wrap the size-proportional builtins". The first holds only for guarded builtins: anything unguarded overshoots by up to about 10,000 calls. The second claims a completeness the table lacks (trim family, parseFloat/parseInt, the URI functions, escape/unescape, normalize, localeCompare, slice/substring/substr/at/concat, keyed Set/Map ops). Operators on large strings are not recorded at all. W2.2 item 11's own tests still pass (repeat and indexOf loops within budget + 300 ms).

Dump path (p2): an onload builds big = 30,000 references to one 1,000-char string. 'throw big' then takes 377-450 ms per dispatch and counts only as a soft fault. Back-to-back for 15 s it gave 37 dispatches; the duty cycle caught it (throttled, one hard fault) but did not unload. Cause: settle() calls ctx.dump(r.error), which JSON-serializes the whole thrown graph, and classifyError then runs String(e) over it before clip.

p5, a side finding in the reviewer's lens: 'throw Promise.resolve(1)' gives hard/host-exception (QuickJSUseAfterFree "Lifetime not alive") and the view unloads at once. quickjs-emscripten's dump() disposes promise handles, and settle() then disposes r.error again.
- **Fix (verifier):** What does not work:
- Switching to quickjs-ng: it polls identically, once per about 10,000 ticks.
- The memory cap: it only scales the cost of each call linearly, so it cannot bound a loop of about 10,000 calls.
- More prelude wrappers: none can reach ==, unary +, ===, <, or switch.
More guards narrow accidental paths only. They do not close this class against a hostile skin.

The smallest correct fix, in order:

(1) Rewrite ENGINE R19 (doc only). "One builtin call" applies to guarded builtins only. For any unguarded native work, a builtin or an operator such as ==, unary +, ===, <, switch or ToNumber on a large string, a loop overshoots by up to one interrupt-poll interval, about 10,000 calls. Record the numbers: 47.7 s at 1 MiB with local operands, about 8 minutes extrapolated at 16 MiB, and spread over 100k elements 16 s. Note that code at handler top level polls about 60x more often because of the with(__IDS) traps. Drop the claim that the guards cover "the size-proportional builtins".

(2) Optionally extend GUARDED_BUILTINS, which helps accidental paths only:
- String.prototype trim/trimStart/trimEnd/normalize/localeCompare/slice/substring/substr/at/concat ('str').
- A global table for parseFloat, parseInt, encodeURI, encodeURIComponent, decodeURI, decodeURIComponent, escape and unescape ('arg').
- Map/Set has/get/set/add/delete sized by stringSizeOf of the key. The prelude's own maps use short string or numeric keys, so they would not cross to the host.
- Do not wrap Number: guarded() would drop its statics and its new/constructor behaviour.

(3) An in-repo code fix: replace ctx.dump(r.error) in settle() and drainJobs() (src/engine/realm/realm.js:469 and 493) with a bounded, typed read:
- Check typeof first.
- For an object, read only name and message with getProp, keep them only if they are strings, and clip them before building any text.
- For anything else, use a fixed "uncaught <type>".
This removes the 450 ms soft-fault stall and the double-dispose of a thrown Promise, which today turns a one-line throw into host-exception and an immediate unload.

(4) The class itself closes only with phase 3, a QuickJS build with a smaller interrupt counter. A worker with terminate() would also close it, but it contradicts D1's main-thread design.

### DOS-5 · medium · An entry that overruns its budget without reaching another interrupt poll returns Ok (or only a soft fault), so these overruns never count toward unload

- **Requirement:** D1 'Hard faults: the interrupt budget is exceeded'; §10 budgets; 'unload: 3 hard faults in 30 s'
- **Location:** src/engine/realm/realm.js:665-676
- **Repro (reviewer):** onload: var p=[]; for (var i=0;i<40000;i++) p[i]='var v'+i+';'; src=p.join('\n')
Then repeat a 100 ms handler '(0,eval)(src)': 845, 835, 729, 673 ms, each {ok:true} with health {hard:0}. With 'new Function(src)' it is about 300 ms per dispatch, also ok. 'throw big' (DOS-4) is 450 ms and soft. A timer can repeat this forever; only the duty cycle (30 s at more than 80%) eventually unloads, and at 79% busy nothing ever does.
- **Verification:** All probes ran in /tmp/dos5-verify (/tmp/dos5-verify/repro.mjs and /tmp/dos5-verify/scale.mjs). They import the worktree's realm.js through an absolute path and build the realm the way tests/engine/realm/fake-host.js does: real performance.now wallClock, a dispatcher whose now() is 0, FAITHFUL.budgets, 64 MiB memory, 256 KiB stack. No repo file was edited.

Results on the unpatched realm:
- Smallest repro. onload `src = '0;\n'.repeat(3000000);`, then the onclick handler `(0,eval)(src)`. Each dispatch takes 564-575 ms against a 100 ms budget and returns {ok:true}, health {hard:0}.
- The reviewer's repro. onload builds 40,000 'var vN;' lines; `(0,eval)(src)` takes 776-826 ms per dispatch, {ok:true}, hard 0, six times in a row. The only consequence was dutyThrottled at the 6th.
- `new Function(src)` with the same 40,000 lines takes about 300 ms, {ok:true}. At 150,000 lines it takes about 830 ms and returns only a SOFT fault ('too many local variables'), so it does not count toward unload either.
- Strongest case, using the R19 residual itself. onload `s='a'.repeat(16<<20); t=s.slice(0,-1)+'b'; arr=[]; for(var i=0;i<300;i++) arr.push(s);`, then the handler `arr.indexOf(t); 0;`. Each dispatch takes 3,966 and 4,162 ms (40x the budget) and returns {ok:true}, hard 0.

Cause (realm.js:665-673): only `interrupts > interruptsBefore || guardTripped` counts as a budget overrun. QuickJS checks for an interrupt only every 10,000 interpreter steps, and the guards check only when a guarded builtin is called. When the slow call is the last real work in the entry, neither check runs after the deadline, and the overrun is never seen.

Why this is not the documented residual: R19 records that one builtin call can overrun, and says the realm then keeps running in cheap steps until the real interrupt fires. That means R19 still expects such a dispatch to count as a hard fault. R19 does not cover the case where the entry ends first, the overrun is reported Ok, and the 3-in-30-s unload never engages. D1 ('Hard faults: the interrupt budget is exceeded') and R3 ('three strikes in 30 s') both expect that unload to engage.

Severity reasoning: a skin timer paced to stay under 80% duty (for example a 4 s stall every 5.2 s) freezes the main thread for seconds at a time, indefinitely, with health reporting clean. It is never unloaded, and the overruns are missing from the corpus hard-fault report. It is medium rather than high because the stall length itself is R19's accepted residual (recovery by force-quit plus safe-mode), and the duty cycle still catches anything above 80%.

Fix tested on a copy (/tmp/dos5-verify/realm/realm.js):
- The 40k-var eval, the 3M-statement eval, the 150k-line Function soft-fault case and the 4 s indexOf case all become {kind:'hard', reason:'budget'}, and the realm unloads on the 3rd dispatch.
- In the 3rd patched indexOf dispatch health.hard reaches 4. That is the existing behaviour of enter() recording a duty-cycle fault in the same entry (lines 676-680), not double counting by the patch.
- Legitimate work is unchanged: a 300 ms onload and 90 ms handlers stay Ok. new Function at about 300-380 ms stays Ok, because it is under budget + 300 ms.
- tests/engine/realm (copied, imports pointed at the patched copy): 321/321 pass, the same as the unpatched baseline.
- tests/realm-gate/rg0.test.js against the patched copy: 47/47 pass, including the W2.2 item 11 slow-builtin bound tests.
- **Fix (verifier):** In src/engine/realm/realm.js `enter()`, also treat a wall-clock overrun past the deadline plus a fixed slack as a hard 'budget' fault, measured after the body and the job drain and before the deadline is restored. Diff (tested in /tmp):

  REALM_CAPS: add `overrunSlackMs: 300,` (the W2.2 item 11 bound).

  -    const tripped = interrupts > interruptsBefore || guardTripped;
  +    const end = wallClock();
  +    const overran = end > deadline + REALM_CAPS.overrunSlackMs;
  +    const tripped = interrupts > interruptsBefore || guardTripped || overran;
  ...
  -    const dutyFault = recordBusy(start, wallClock());
  +    const dutyFault = recordBusy(start, end);

`deadline` at that point is the entry's own min(saved, start+budget), so nested entries stay correct. The existing condition at line 671 then upgrades Ok or soft to hard 'budget'. Line 673 (the look-alike throw stays soft) still holds whenever no real overrun happened.

Notes:
- The slack is a fixed +300 ms whatever the budget: 400 ms for handlers, 320 ms for a jscript: expression (16x the 20 ms budget), 1,300 ms for onload and the prelude, and budget + 300 for loadScript.
- It is additive, not 2x the budget. 2x would hard-fault a legitimate late loadScript once scriptsSpent has nearly used up the 2,000 ms, and would escalate R3-style GC pauses on the 20 ms expression budget.
- It also covers the prelude boot entry: a boot slower than 1,300 ms under heavy load would now be a hard 'budget' fault at boot. That is a new failure point, though low risk.
- It is a general backstop for every R19 residual class (unguarded Object.keys, Array.from, spread and constructors; eval and Function parse; regex compile; the first call of a guarded builtin), not just the eval repro.
- It does not shorten a single stall, which stays the R19 residual. It makes each overrun past the slack count, so three within 30 s unload the view.
- Suggested test: an onclick of `(0,eval)(src)` over about 3M statements returns {ok:false, kind:'hard', reason:'budget'}, and three of them unload the realm.

### DOS-6 · low · OOM and stack overflow can be caught by skin try/catch and are swallowed inside Promise reactions: no hard fault, no unload, and the runtime is later disposed

- **Requirement:** D1 Fault domain 'after any WASM abort, OOM ... never calls dispose again'; D1 'One OOM or abort ... unloads the view'
- **Location:** src/engine/realm/realm.js:100-113 (classifyError only sees uncaught values), 489-498 (drainJobs), 607 (dispose condition)
- **Repro (reviewer):** hn.handler("try { s='x'.repeat(200e6) } catch (e) { out = String(e) }", {event:'onload'}) gives ok in 1.1 ms with out 'InternalError: out of memory' and hard 0. The next handler runs, and unload() then logs 'realm: unload: disposed'.
hn.handler("Promise.resolve().then(function(){ s='x'.repeat(200e6) })") gives ok with no diagnostic at all (the reaction turns the OOM into a rejection).
'function f(){f()} try{f()}catch(e){}' gives ok and is disposed later.
Across 17 caught-OOM shapes no dispose abort was observed, so this is a D1 deviation, not a demonstrated crash. Separately, drainJobs does not set poisoned on a 'memory' result (unlike settle at :470) before r.error.dispose().
- **Verification:** The probe ran in /tmp/dos6-verify, with h.mjs as the harness and p1 to p9 as probes. The realm was built by createRealm from src/engine/realm/realm.js, mirroring tests/engine/realm/fake-host.js: real performance.now wall clock, a dispatcher whose now() is frozen at 0, FAITHFUL.budgets, 64 MiB memory and 256 KiB stack. No repo files were touched.

1. The behaviour reproduces as described (p1):
   - "try { s='x'.repeat(200e6) } catch (e) { out = String(e) }" in onload gives {ok:true} in 1.9 ms. out is 'InternalError: out of memory', health hard is 0 and soft is 0. The next handler runs, and unload('skin switch') logs 'realm: unload: disposed'.
   - "Promise.resolve().then(function(){ s='x'.repeat(200e6) })" gives ok, with no diagnostic, and is then disposed.
   - "function f(){f()} try{f()}catch(e){...}" gives ok, out is 'InternalError: stack overflow', and it is disposed later.
   - Control: the uncaught OOM gives hard:memory and the realm is discarded (never disposed).

2. The harm D1's rule guards against (a JS_FreeRuntime abort on dispose) did not occur:
   - p6 covered 42 shapes, about 31 of them caught OOM or stack overflow. The OOM shapes include mid-operation failures: join and JSON growth, Array.from, concat, split, OOM inside sort, replace and getter callbacks, generators, destructuring, class fields, eval, with, finally chains, Proxy ownKeys, async/await, Promise.all, new Function and RegExp. The result was 0 dispose failures.
   - p8 and p9 kept the caught OOM and stack error objects live in the heap through dispose. The check printed "true:InternalError: out of memory" and "true:InternalError: stack overflow" before unload. Both still disposed cleanly with no warnings.
   - p2 forced an abort with a leaked handle. The result is a catchable "RuntimeError: Aborted(Assertion failed: list_empty(&rt->gc_obj_list) ... JS_FreeRuntime)", the process survives, and a fresh module evaluates 1+1 = 2. So even if a dispose did abort, doUnload's existing try/catch (realm.js:607-618) would turn it into a discard with a warning.

3. Intent: tests/engine/realm/faults.test.js:182-183 runs "try { q(); } catch (e) { return [e.name, d > 100]; }" through outOf, which throws on any non-ok result. So the implementer's own test asserts that a caught stack overflow returns ok to skin code. realm.js:15-16 classifies "an exception in skin code" as soft. For stack exhaustion this is intended behaviour, and D1's never-dispose list ("abort, OOM, leaked handles") does not include stack. The OOM half is a gap in D1's wording: "after any ... OOM ... never calls dispose again" and "One OOM ... unloads the view" are literally broader than what the host can observe. That gap is why I rate this low and not not-a-bug.

4. The drainJobs sub-claim cannot be reached (p7). Five job shapes (a .then reaction, a thenable job, async after await, catch/finally, a throw in a reaction) all give ok with 0 diagnostics: a catchable OOM always becomes a rejection, so executePendingJobs never returns a 'memory' error. Even if one did, recordFault sends 'memory' through UNLOAD_AT_ONCE with discard=true (realm.js:572 and :607), so poisoned does not affect disposal. The only effect would be a single r.error.dispose() call.

5. The reviewer's proposed detection signal cannot fire (p7). On a raw instance with a 64 MiB limit, a caught 'x'.repeat(2e8) leaves linear memory at 16777216 bytes before and after. QuickJS refuses the oversized request before it ever calls malloc, so the "DOS-1 buffer-size check" would not see any of these caught OOMs.

There is no DoS path: repeated caught OOMs fail up front in 0 to 2 ms, and expensive ones are cut by the entry budget like any other loop.

Side observations, out of scope here and not chased:
- QuickJS reports "malloc_usable_size unavailable". str_size reached 1.3 GB under a 64 MiB limit, and 1,485 x 256 KiB strings accumulated without OOM. So the cap only refuses single oversized requests; this is DOS-1's area.
- eval('1+'.repeat(3e7)+'1') ran 8,326 ms against a 1,000 ms onload budget and returned ok. Parsing does not poll the interrupt, and this case is not in the R19 list.
- Deep JSON.parse/stringify, yield* recursion and a toString recursion escape WASM as host RangeErrors at 256 KiB. They are classified host-exception and discarded, which is fail-safe.
- **Fix (verifier):** No code change is needed for the fault domain. The smallest correct fix is a wording amendment to ENGINE D1 (fault-domain bullet and "Budgets and faults"): "an OOM or stack exhaustion that ends a dispatch uncaught is a hard fault; one that skin code catches (try/catch or a Promise reaction, which turns it into a rejection) is ordinary skin behaviour, as in JScript, and the host cannot see it". Optionally add a faults test that pins this: a caught OOM, with the error kept live, still disposes cleanly on unload. That test doubles as the leak tripwire the never-dispose rule exists for.

Do not adopt the reviewer's "DOS-1 buffer-size check" for this purpose: linear memory does not move on a refused oversized request (16 MiB before and after), so it cannot flag these cases. The reviewer's fallback, "always discard, never dispose", is unnecessary, because the dispose is already inside a try/catch that turns any abort into a discard.

Optional one-line consistency nit: in drainJobs (realm.js:493), match settle by adding `if (!outcome.ok && outcome.kind === 'hard' && outcome.reason === 'memory') poisoned = true;` before the error is disposed. The path cannot currently be reached, and UNLOAD_AT_ONCE already discards, so this is cosmetic.

### DOS-7 · medium · Realm-side id-write diagnostics are uncapped and fire for any key: one skin grew the host heap by 1.28 GiB in 22 s

- **Requirement:** D1 membrane 'host validates every op'; ENGINE §1 caps on what skin-controlled input can make the host hold; precedent: image/service.js:190-191 caps distinct diagnostics
- **Location:** src/engine/realm/prelude.js:289-295 (__IDS set trap), src/engine/realm/realm.js:430-434 (hooks.diag)
- **Repro (reviewer):** __IDS is a locked but readable global. Repeat the handler
  if (typeof n !== 'number') n = 0; for (var i = 0; i < 1500; i++) __IDS['k' + (n++)] = 1;
1,660 times. Result: 2,491,291 'realm-id-write' diagnostics reach log.diag and the host heap grows by 1,282 MiB in 22.4 s. The only stop is the duty-cycle unload; at under 80% duty (the duty-cycle probe) nothing ever stops it. The set trap never checks that k is an id. Realm memory does not bound it either, because of DOS-1. Note: the only log.diag sink in the repo is the test host's array (src/hosts/test/index.js:243); the production sink is not written yet.
- **Verification:** All probes are in /tmp/dos7-verify. The harness is h.mjs: createRealm from src/engine/realm/realm.js, the real performance.now wall clock, a dispatcher whose now() is frozen at 0, FAITHFUL.budgets, 64 MiB memory, 256 KiB stack, and a log.diag sink that either keeps every diag ('retain', like src/hosts/test) or only counts them ('count'). No repo files were edited.

1. Minimal repro (p1.mjs). One onclick handler, `for (var i = 0; i < 1000; i++) __IDS['not_an_id_' + i] = 1;`, returns ok and emits 1000 distinct 'realm-id-write' diags, for example {code:'realm-id-write', elementId:'not_an_id_0', detail:"an assignment to the id 'not_an_id_0' goes nowhere..."}. The key is not an id, so the message is also wrong. `typeof __IDS` is 'object' and the global is non-writable but readable by skin code. Cause: the set trap at prelude.js:289-295 dedupes only by exact key and never checks that k is an id. hooks.diag at realm.js:430-434 forwards every report with no cap.

2. Sustained flood under the duty limit (p2.mjs, paced to 49% duty). The reviewer's 1500-writes-per-call body ran for 30 s: 1,896,000 diags (63k per second), 0 faults, realm still live, never throttled. With the retaining sink over 60 s: 3,529,860 diags and +539 MiB host heap after a forced GC. The reviewer's +1,282 MiB was measured without GC, so the exact figure differs but the effect is the same. The 60 s retain run also had one hard 'budget' fault at 53 s that the counting run did not have. Host-side cost of the diag path (array growth, GC) was charged to the skin's 100 ms handler budget.

3. Back to back with the counting sink (p2.mjs b2b). This is the reviewer's scenario: hard duty-cycle faults at 10 s, 20 s and about 30 s, then unload. Total 3,542,542 diags.

4. The reviewer's "realm memory does not bound it" is only partly true (p4.mjs). The realm-side `idWritesNoted` SafeSet fills the 64 MiB cap at about 3.54M entries, and diags stop at exactly 3,542,541. So the flood is bounded at about 3.5M per realm instance: very large, but finite. A secondary fault, to pass on (probably DOS-1's territory): that OOM inside the prelude's Proxy set trap comes back as `{kind:'soft', reason:'uncaught undefined'}`, not hard/memory. The realm stays 'live' at its memory ceiling, and a trivial next handler still returns ok.

5. Filtering keys to real ids does not bound it (p3.mjs). Without naming __IDS, a handler that assigns case variants of a real id ('playlistcontainerpanel') as bare names through direct eval got 10,863 distinct 'realm-id-write' diags. Each variant passes `byLower.has(lower(k))`, and the id has 2^22 case variants. The reviewer's first fix item alone only slows the flood. The cap is the part that bounds it.

6. The reviewer's warnOnce/64 KiB sub-item is a separate, bounded path. OP.DIAG already clips code to 64 chars and detail to 512 (membrane.js:313-316), so id-write diags cannot carry 64 KiB. warnOnce is reached only on dispatcher failures in GET/SET/CALL, and its `logged` Set stops at 1024 entries. The worst case is about 1024 × 64 Ki chars, roughly 128 MiB as UTF-16. Not part of DOS-7.

Not a documented residual: R19 covers slow builtins and R20 covers assignment rewrites. D1 calls for id write-through to be 'stated, diagnosed, accepted' (U-31), not for unbounded diagnostics for any key. Every other emitter caps: membrane warnOnce (1024), image/service.js MAX_REPORTED with an 'image-diagnostics-capped' marker, timerCapLogged, faultsLogged. Impact depends on the sink, because the production log.diag sink is not written yet. Even so, the realm hands skin-controlled, effectively unbounded volume to the host, which goes against D1 'host validates every op'. A hostile skin is needed; real skins write ids from static text, which bounds them.
- **Fix (verifier):** Required: a cap on the host side, in realm.js hooks.diag (line 430). It holds whatever the prelude does, and it is what D1 'host validates every op' asks for. Add `let idWriteDiags = 0;` next to timerCapLogged, plus REALM_CAPS.maxIdWriteDiags = 64 (the same as image MAX_REPORTED), then:

  diag(code, detail) {
    if (code !== 'id-write' || phase === 'script') return;
    if (idWriteDiags > REALM_CAPS.maxIdWriteDiags) return;
    if (++idWriteDiags > REALM_CAPS.maxIdWriteDiags) {
      diag({ code: 'realm-id-write-capped', severity: 'warn', detail: `${viewKey}: more than ${REALM_CAPS.maxIdWriteDiags} id writes; further ones are not reported` });
      return;
    }
    diag({ code: 'realm-id-write', ... as now ... });
  },

Recommended, not sufficient alone: in the prelude.js set trap (289-295), report only real ids and dedupe on the lowercased key. This fixes the wrong message for non-id keys and limits the realm-side Set to the number of ids:

  set(_t, k) {
    if (typeof k !== 'string') return true;
    const lk = lower(k);
    if ((byExact.has(k) || byLower.has(lk)) && !idWritesNoted.has(lk)) { idWritesNoted.add(lk); host(OP_DIAG, 'id-write', k); }
    return true;
  },

Add a test to tests/engine/realm/scope.test.js: 1000 `__IDS['x'+i]=1` writes, plus a case-variant loop over one id, should give at most 64 'realm-id-write' diags and one 'realm-id-write-capped'.

Out of scope here, for separate follow-ups: (a) the warnOnce key clipping the reviewer mentioned, which is bounded at 1024 entries; (b) a realm OOM inside the prelude set trap is classified as soft 'uncaught undefined' rather than hard/memory.

### DOS-8 · low · Promise jobs left over after a 1,000-job drain run under the next entry's budget and its fault is charged to that innocent site

- **Requirement:** D1 'executePendingJobs runs after every entry point under the same budget, at most 1,000 jobs per drain'; faults logged per site
- **Location:** src/engine/realm/realm.js:489-498
- **Repro (reviewer):** hn.handler("(function f(){ Promise.resolve().then(function(){ for(var i=0;i<3000;i++){}; f(); }); })();", {event:'onload'}) is ok in 50 ms. Then realm.evalExpression(2,'left','1') returns hard/budget at site 'expr 2.left' (20.4 ms): the leftover jobs used the jscript: value's 20 ms. The fault counts toward the 3-in-30 s unload against a layout expression.
- **Verification:** Probes are in /tmp/dosverify-8 (probe.mjs, probe2.mjs, probe3.mjs, probe4.mjs, probe5.mjs). Each one imports src/engine/realm/realm.js createRealm with the real performance.now wallClock, a dispatcher whose now() is always 0, FAITHFUL.budgets, 64 MiB memory and 256 KiB stack. No repo files were edited.

1. The reviewer's repro reproduces exactly. The onload `(function f(){ Promise.resolve().then(function(){ for(var i=0;i<3000;i++){}; f(); }); })();` returns ok in 54.8 ms. The next call, `evalExpression(2,'left','1')`, returns {ok:false, kind:'hard', reason:'budget', site:'expr 2.left'} in 20.4 ms. The diagnostic is 'realm-hard-fault probe/view expr 2.left: budget' and health.hard becomes 1.

2. Light chain `n=0;(function f(){n++;Promise.resolve().then(f);})()`. After onload n=1001, as the existing faults.test.js case asserts. Every later entry runs another 1,000 of the leftover jobs, including readGlobal, which is an entry with the handler budget and drains like the others. A readGlobal('n') moved n from 1001 to 2001, and evalExpression(2,'left','n') returned 4001. Nothing faults, and the chain runs forever.

3. probe2: the job reschedules first, then runs about 0.05 ms of work. Every later expr is hard/budget at 'expr 2.left' (51.7, 58.6 and 57.6 ms against a 20 ms budget). The third one unloads and discards the view. All three faults are charged to the innocent layout expression.

4. Severity is low. The 3-in-30 s counter is per realm, not per site, so who gets charged never changes whether the view unloads. Every job is the skin's own code. JScript has no Promise, so a WMP-era skin should never trigger this; I did not scan inside the skin archives. What does break: the diagnostic names the wrong site, the innocent expression or readGlobal loses its value (readGlobal returns undefined), and the entry that caused it reports ok.

5. This is neither a documented residual nor intended behaviour. D1 and §10 say only "at most 1,000 jobs per drain, inside the entry budget". Nothing in ENGINE or WAVES rules on leftover jobs, and R19 and R20 are unrelated.

Adjacent defect, found while verifying, with the same root cause:
- In this QuickJS build a promise reaction job turns the interrupt into a rejection, and executePendingJobs then keeps going. In probe3, a handler queues 1,000 jobs of `n++; while(1){}`, each with a `.then(null, ...)` rejection handler. It takes 163.9 ms against a 100 ms budget, n reaches 1000, and the skin's rejection handler sees 'InternalError: interrupted'.
- So the drain keeps running for up to 1,000 jobs after the deadline, and that multiplies the R19 unguarded-builtin residual. In probe4, 20 jobs of `for(;;) Object.keys(big)` took 14.1 s against a 100 ms budget. The same loop run directly in a handler (probe5) took 534 ms.
- That deserves its own finding, at least medium. The fix below closes it too.

Fix tested on a copy in /tmp/dosverify-8/fix (diff at /tmp/dosverify-8/fix.diff):
- In every probe, faults are now charged only to the originating site or to 'jobs', never to the expression or read.
- The reviewer case: onload gets a soft 'more than 1000 pending jobs', the following exprs return their values, and the budget trip lands on 'jobs'.
- probe2 and the light chain unload after three hard faults at 'jobs'.
- probe3 takes 100.7 ms instead of 163.9.
- The realm vitest suite, run on the copy: 116 of 117 pass. The baseline copy passes all 117. The one failure is faults.test.js 'a self-rescheduling job flood is cut at 1,000 jobs per drain'. It asserts the old ok/1001/hard=0 behaviour and needs updating to the new semantics. wmploc.test.js fails to import in the /tmp copy only, because its fixtures were not copied; it fails the same way on the baseline copy.
- **Fix (verifier):** All changes are in src/engine/realm/realm.js and take three steps (tested diff: /tmp/dosverify-8/fix.diff).

1. In drainJobs, run jobs one at a time and stop at the first trip, and charge leftover jobs to the entry that queued them. Pass interruptsBefore in from enter.

```js
const drainJobs = (interruptsBefore, floodKind = 'soft') => {
  for (let n = 0; n < REALM_CAPS.maxJobsPerDrain && rt.hasPendingJob(); n++) {
    if (interrupts > interruptsBefore || guardTripped) return OK_VOID; // enter() makes it hard/budget
    const r = rt.executePendingJobs(1);
    if (r.error) { const o = classifyError(ctx.dump(r.error)); if (!poisoned) r.error.dispose(); return o; }
  }
  if (rt.hasPendingJob() && interrupts === interruptsBefore && !guardTripped)
    return { ok: false, kind: floodKind, reason: `more than ${REALM_CAPS.maxJobsPerDrain} pending jobs` };
  return OK_VOID;
};
```

2. At the top of enter, after the state check, run inherited jobs as their own entry, with their own site and the handler budget.

```js
let inherited = false;
if (active === 0 && site !== 'jobs' && !poisoned && rt.hasPendingJob()) {
  enter('jobs', budgets.handler, () => OK_VOID);
  if (state !== 'live') return unloadedFault(site);
  inherited = !poisoned && rt.hasPendingJob();
}
```

3. After the body, drain only when the queue held nothing inherited.

```js
if (!poisoned && !inherited) outcome = worse(outcome, drainJobs(interruptsBefore, site === 'jobs' ? 'hard' : 'soft'));
```

Why the reviewer's proposed fix is not enough on its own:
- A separate 'jobs' entry by itself still leaves the real entry's own drain running the inherited jobs first, because QuickJS keeps a single FIFO job queue. Tested: the hard/budget still landed on 'expr 2.left'. That is why the skip-if-inherited guard is needed.
- A flood that survives its own 'jobs' drain must be hard, so three of them unload the view. Otherwise a self-sustaining chain would cost up to 100 ms on every entry with only the duty cycle as a backstop.

Two follow-ups:
- Update the faults.test.js flood case to the new behaviour. The handler now returns a soft fault, and a later readGlobal runs the 'jobs' pre-drain first.
- Add one line to ENGINE D1 stating the leftover-job rule.

### DOS-9 · low · At 256 KiB, many ordinary recursion shapes overflow the host stack instead of QuickJS's own check, so they unload at once instead of being a 'stack' fault

- **Requirement:** §10 stack 256 KiB (G1: 'the clean ceiling is 320-384 KiB'); W2.2 item 9
- **Location:** src/engine/realm/realm.js:316, 658-664, 83
- **Repro (reviewer):** Each line below, in a fresh realm under Node 26, gives hard/host-exception and the realm is unloaded and discarded at once:
  var o={get x(){return this.x}}; o.x
  var o={toString(){return ''+o}}; ''+o
  function* g(){ yield* g() } g().next()
  async function f(){ await f() } f()
  JSON.parse('['.repeat(100000)+']'.repeat(100000))
  eval('('.repeat(100000)+'1'+')'.repeat(100000))
By contrast, function f(){f()} f() is hard/stack and leaves the realm live. One accidental getter or toString recursion therefore kills the skin. Failure is safe (discard; a fresh realm works afterwards).
- **Verification:** Ran in /tmp/dosverify-9 (probe.mjs, caps.mjs, depth.mjs, corpus.mjs) under Node v26.8.1, darwin. Each case used a fresh createRealm from src/engine/realm/realm.js with the real performance.now wallClock, a fake dispatcher whose now() returns 0, FAITHFUL.budgets, 64 MiB memory and maxStackBytes 256 KiB, the same values as tests/engine/realm/fake-host.js. No repo files were edited and nothing was written inside the repo.

1. Reproduced as stated. At 256 KiB, each of these returns hard/host-exception, logs 'realm: exception escaped the WASM call' {RangeError, 'Maximum call stack size exceeded'}, and leaves the realm unloaded with state=discarded:
   - the getter, toString, `yield*` generator, async/await, JSON.parse 100k nesting and eval 100k-parens cases from the finding;
   - also setter recursion (`set x(v){this.x=v}`);
   - valueOf coercion (`o+1`);
   - `f.call(this)` recursion;
   - `[1].forEach(f)` recursion.
   `function f(){f()} f()` gives hard/stack and the realm stays live, as do arrow, method, `new C()`, try/rethrow and sort-callback recursion. A fresh realm works afterwards. The cause is UNLOAD_AT_ONCE containing 'host-exception' (realm.js:83) plus the catch at realm.js:658-664. A skin's own try/catch cannot catch the escape: `var o={get x(){return this.x}}; try{o.x}catch(e){}` still unloads.

2. 256 KiB sits right on the native-stack edge. Over 3 identical runs, that getter-under-try/catch case escaped twice and returned ok once. This is the same jitter tests/realm-gate/rg0.test.js:395 documents for plain recursion at 320-400 KiB.

3. Mechanism: V8's native stack is the binding limit. Under `node --stack-size=4000`, every ordinary shape becomes a realm 'stack' fault at 256 KiB. The RG0 sweep (rg0.test.js:403) measured only `function r(){return r()+1}`. So the 'clean ceiling 320-384 KiB' in ENGINE.md:1947 (§10) and contracts.d.ts:171 holds only for plain recursion.

4. Bounded recursion at 256 KiB (deepest depth that runs, then what happens just past it):

   | Shape | Deepest that runs | Just past it |
   |---|---|---|
   | plain | 1360 | stack |
   | getter | 1084 | stack |
   | toString | 1084 | stack |
   | f.call | 582 | stack |
   | forEach | 560 | stack |
   | generator | 558 | host-exception |
   | async | 619 | host-exception |
   | JSON.parse nesting | 10320 | host-exception |
   | eval parens | 579 | host-exception |

   So the accessor, call and forEach shapes escape only in their tiny-frame unbounded form. Generator, async, JSON.parse and parser nesting escape even when bounded.

5. Cap sweep (unbounded shapes):
   - 192 KiB: everything is 'stack' or ok except JSON.parse and eval-paren.
   - 160 KiB and below: JSON.parse becomes 'SyntaxError: stack overflow'. classifyError maps that to a soft fault, because it matches only InternalError and RangeError, which is inconsistent with D1's 'stack exhausted is hard'.
   - eval-paren escapes at every cap down to 64 KiB and also under --stack-size=4000. No cap value fixes parser nesting.
   - At 128 KiB, plain recursion runs to 677 frames (getter 538, generator 338); past that each ends as a clean 'stack' fault.

6. Corpus at 128 KiB vs 256 KiB: all 219 scripts in 195 archives load, and 6,581 load/click/timer handlers give an identical tally. This is a weak signal: most handlers soft-fault early against the bare dispatcher, so handler recursion depth against a real host is unmeasured.

7. Not a documented residual: R19 covers slow builtins and R20 call-assignment, and neither covers stack escape. The escape handling itself is per W2.2 item 9 and fails safe (discard, never dispose). What is wrong is the contract note.

8. Why this is more than a wording issue: a skin's accidental getter or toString recursion is reported with reason 'host-exception', not 'stack'. D10.9 criterion 6 ('zero uncaught host exceptions' blocks cutover, while 'realm hard faults on the long tail are reported') may therefore count an ordinary skin bug in the blocking bucket. It also unloads the view at once instead of counting toward 3 hard faults in 30 s. JScript's 'Out of stack space' is catchable; this is not.
- **Fix (verifier):** No code change is needed now; the behaviour matches W2.2 item 9. The smallest correct fix is documentation plus measurement:

(1) Correct the ceiling note in docs/design/ENGINE.md:1947 (§10 Realm memory/stack row) and src/engine/contracts.d.ts:171. The 320-384 KiB clean ceiling holds for plain function recursion only. At 256 KiB under Node 26, the following escape WASM as a host RangeError. Each becomes a 'host-exception' hard fault, unloads at once, is discarded, and cannot be caught by the skin's try/catch:
- recursion through native frames: accessors, toString/valueOf coercion, Function.prototype.call, forEach callbacks;
- generator and async recursion;
- JSON.parse nesting past about 10k;
- parser nesting, such as eval of deep parens.
Parser nesting escapes at every cap down to 64 KiB, so no cap value fixes it. Closing it needs a pre-parse nesting limit or a QuickJS build with a parser stack check.

(2) Extend the report-only sweep at tests/realm-gate/rg0.test.js:403 to these shapes, so the W3.R WKWebView re-measure covers them automatically.

(3) Record 128 KiB as a W3.R candidate, not a change now. Under Node it turns every shape except parser nesting into a realm 'stack' fault, and JSON.parse into a soft SyntaxError. It also roughly halves plain recursion depth (1360 to 677 frames), and the corpus check did not exercise handler depth against a real host.

Optional follow-on, which is a contract edit: give a host RangeError 'Maximum call stack size exceeded' its own reason, for example 'host-stack', still unload-at-once and discard. The corpus report under D10.9 criterion 6 could then separate skin recursion bugs from engine host exceptions. This changes the reason that tests/engine/realm/faults.test.js:191 asserts.
