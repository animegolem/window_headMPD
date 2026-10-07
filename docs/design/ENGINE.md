# The generic skin engine: ratified design

Status: ratified design, 2026-10-06, branch `skin-engine`. Nothing is implemented or committed.
Synthesised from three candidate designs (`candidate-fidelity.md`, `candidate-safety.md`,
`candidate-delivery.md`) and three judge verdicts. Where the candidates disagreed, each decision
takes the option the judges scored strongest and grafts the good parts of the others. Every error
the judges found is fixed; section 13 maps each finding to the section that fixes it.

The phase-1 implementation plan is `docs/design/WAVES.md`. This document is its contract. If the
two disagree, this document wins, and the disagreement goes back to Opus.

## Conventions

Evidence citations use the research notes' own section names:

| Short | File |
|---|---|
| `parity` | `docs/research/headspace-parity.md` (D-rows are its section-2 deviations; `parity 4.1` is the fixture) |
| `spec`, `U-n` | `docs/research/wms-spec.md` and its UNCONFIRMED register |
| `survey`, `Gn`, `Rn` | `docs/research/corpus-survey.md`, its gotchas and its fixture ladder |
| `wmploc` | `docs/research/wmploc-library.md` |
| `webamp` | `docs/research/webamp-spike.md` |
| `wsz` | `docs/research/winamp2-corpus.md` |
| `notan Qn` | `docs/research/notan-input.md` |
| `cand-F`, `cand-S`, `cand-D` | the fidelity, safety and delivery candidates |

Code is cited as `main:N`, `widgets:N`, `demo:N`, `viz:N`, `player:N`, `lib.rs:N`, `click:N`,
`audio.rs:N`, `eq.rs:N` against HEAD `1c68557` (the oracle pin of `parity` line 18 still holds).

"Skin px" means the skin's own pixel space at zoom 1. "Pure" means a module that touches no DOM
and runs under Node. **S** marks Sonnet implementation work and **O** marks Opus work (design,
gates, re-pins, triage).

---

## 0. Summary

1. **Skin script runs in QuickJS compiled to WASM**, synchronously on the main thread of the skin's
   webview. The realm is one module instance per skin session, one context per VIEW, and sits behind
   a copy-only membrane: primitives and revocable integer handles cross it, nothing else does. Element
   ids resolve through a `with`-scoped Proxy whose `has` trap answers from realm-side sets, so unknown
   names still throw `ReferenceError`. Budgets use the real wall clock. A fault aborts one dispatch;
   repeated faults unload the view; a WASM abort discards the instance without disposing it.
2. **The renderer is a hybrid.** A retained DOM tree holds one `div` per SUBVIEW stacking context,
   one `canvas` per drawable (pixels the engine decoded and keyed itself) and DOM text for TEXT.
   **Paint and hit are separate bit planes.** One engine-owned picker hit-tests through a single
   input plane per window, and the same planes produce the OS click-through mask.
3. **Every image is decoded by our own pure-JS decoders** (BMP with RLE4/RLE8/16/32-bit, PNG via
   bounded `fflate` inflate, GIF, JPEG via capped `jpeg-js`), in a Worker in the app and inline in
   Node. Caps are probed from headers before any allocation.
4. **Archives are parsed in memory by one JS zip reader and never extracted.** Rust stores the
   archive by SHA-256 and returns its bytes on request. The VFS is flat, case-folded and Map-backed.
   All caps clear the 342-archive corpus.
5. **Parse, layout and bindings follow WMP and the corpus.** The scanner is tolerant and the last
   duplicate attribute wins. `jscript:` is evaluated once, in document order, with alignment anchors
   for resize. `wmpprop:`/`wmpenabled:` bindings are host-side and re-resolve when an object on the
   path is replaced. Every SUBVIEW is a stacking context (Reading C).
6. **The object model is schema-driven and host-side.** One table drives the membrane, the realm's
   `has` sets, bindings, stubs, per-API policies and the coverage ledger. MPD is reached only
   through the typed `MediaModel`.
7. **Windows are `SkinWindow`s.** Phase 1 binds the existing `main` WebviewWindow and keeps parity
   D13: script writes to `view.width` are ignored. Rust click-through becomes per-window and bound
   to the calling window. Phase 2 adds a cluster binding for Webamp.
8. **`src/engine/` is Tauri-free** behind a `HostAdapter`. A committed checker bans Tauri imports
   and the security sinks, and `tsc --checkJs` checks every module against one `contracts.d.ts`.
   The test adapter is built before the Tauri adapter and doubles as the oracle harness's host.
9. **The oracle is `skinlab`**: pinned Playwright Chromium, DPR 1 and 2, a manual engine clock, the
   visualizer stubbed, and goldens of the legacy hand port that are content-addressed and kept
   outside git. Two engine configurations (`faithful`, which ships, and `oracle-compat`) turn the
   deviations allow-list into a measurement. Because Chromium cannot see Rust or the CSP, an in-app
   WKWebView gate is part of cutover.
10. **The app shell works around any skin**: skin-first right-click, zoom, keyboard defaults,
    overlays inside the EFFECTS slot, drawer restore, safe-mode boot, a fault panel, and a demo tour
    retargeted through an inspector.
11. **Audio changes in phase 1 are frame fan-out only.** EQ profiles, preamp, bypass and PCM frames
    come in phase 2.
12. **`SkinHost`/`HostedSkin` is the phase-2 seam.** Every skin family passes the same archive caps.
    `PaletteService` lives host-side: local and default tiers in phase 1, the notan-palette/1
    artifact tier in phase 2.

### 0.1 Decision register at a glance

| ID | Position | Primary source | Grafts |
|---|---|---|---|
| D1 | QuickJS-WASM sync, main thread, membrane, `with(__IDS)` ids, wall-clock budgets | cand-S | cand-F probe-2 test, per-session instance, never dispose after abort |
| D2 | Hybrid DOM layers; separate paint/hit planes; engine picker; input plane | cand-S | cand-D "synthetic events never drag"; cand-F switch for keyed-button hit |
| D3 | Own decoders; header probe; 16,384 axis cap; Worker with terminate | cand-S | cand-F palette-index retention, X1R5G5B5 rule |
| D4 | In-memory JS zip, flat Map VFS, archive stored by hash, never extracted | cand-S | import-path guard; canonical re-zip for Webamp |
| D5 | Tolerant scanner; once-only `jscript:`; host-side bindings; Reading C | cand-F | cand-S `_onchange` queue; pass-time cap |
| D6 | Schema + policy + ledger; MPD mapping; prefs in Rust | cand-S | cand-F member mapping; spec §7.2 time strings |
| D7 | `SkinWindow`, native binding, caller-bound per-window hit, D13 kept | cand-S | cand-D per-session resize policy (phase 3) |
| D8 | Tauri-free engine, `HostAdapter`, boundary checker, `tsc --checkJs` | cand-S | |
| D9 | skinlab, faithful vs oracle-compat with bounded allow-list | cand-F | cand-S content addressing, exit 77; cand-D tag regeneration |
| D10 | Shell features attached to engine queries; demo driver plus choreography | cand-F | cand-S fault panel; drawer restore; safe mode |
| D11 | Phase-1 fan-out only, legacy call shape kept, ±14 dB | cand-S, cand-D | cand-F `EqProfile` shape for phase 2 |
| D12 | `SkinHost`/`HostedSkin.capabilities`; PaletteService artifact tier in phase 2 | cand-S | cand-D `query()`/`idle()`, seam-freeze review |

---

## 1. Ground rules

1. **Skin art never enters git.** That covers goldens, diff images, decoded caches and anything
   rendered from art. Facts about art (hashes, pixel counts, coordinates, API names) may be committed.
   `skins/`, `public/skin/` and all skinlab output stay untracked.
2. **The hand port is the oracle** and keeps running until cutover (`parity 0.1` rule 7).
3. **The engine follows WMP semantics.** Slips of the hand port are allow-listed, never baked in
   (`parity 0.1` rule 1). Anything Headspace-only lives in a sidecar keyed by archive SHA-256.
4. **The engine never special-cases a skin.** No Headspace function name, id or coordinate appears in
   `src/engine/` (`parity 0.1` rule 2).
5. **No skin-controlled string becomes markup, CSS source, a URL the page fetches, a window label or
   a filesystem path.**
6. **Every lookup keyed by a skin-controlled string is a `Map` or a null-prototype object.** That
   covers VFS entry names, element ids, pref keys, schema members, sidecar refs and mediacenter keys.
   `loadPreference('constructor')` returns `"--"`, and `player.constructor` is an unknown member.
7. **The phase-1 fixture is the owner's `~/Downloads/Headspace.wmz`** (wmz sha1 `f9671f06…`). It is
   not `skins/wmp/Headspace.wmz`, the 2000 revision (`survey 0` item 9). Tests that need art skip
   when it is absent: skinlab exits 77, and vitest marks the test skipped. They never fail for that.
8. **Pinned files** (`tools/skinlab/pins.mjs` `PINNED_FILES` is the list of record: `main.js`,
   `widgets.js`, `player.js`, `playlist.js`, `style.css`, `viz/index.js`, `demo.js`,
   `tauri.conf.json`, `lib.rs`, `convert_skin.py`; `clickthrough.rs` left the set at G3, replaced by
   `hit_cmds.rs` in the re-pin, and is deleted) are edited only in the Opus re-pin batch (WAVES W3.R) and at cutover. Sonnet
   tasks list them as "must not touch".
9. **macOS only.** Target WKWebView on macOS 14 or later.

---

## 2. Phases

| Phase | Goal | Exit |
|---|---|---|
| 1 | Generic WMP engine plus app shell; Headspace at parity with the hand port; corpus-wide load robustness; legacy deleted | Cutover criteria (D10.9) |
| 2 | Winamp 2 `.wsz` through Webamp behind `SkinHost`; EQ profiles, preamp, bypass, PCM frames; cluster window binding; PaletteService artifact tier | 10 `skins/wsz` skins pass the museum-screenshot diff within tolerance; MPD round-trip state-machine tests green |
| 3 | WMP corpus breadth (ladder R3 to R9), multi-view windows, view resizing, the long tail of elements, our own skins | Per-rung acceptance; coverage ledger above thresholds the owner agrees |

Coexistence: `index.html` loads `src/entry.js`, which imports `src/main.js` (legacy, the default)
or `src/app/boot.js` (engine). The choice comes from `?engine=wmp`, `localStorage.engine`, or
`VITE_ENGINE`. The window menu gains an Option-held item to flip the flag. `main.js` keeps all its
side effects on import, so legacy behaviour is unchanged. The engine path is loaded by a dynamic
`import()`, so the legacy path never pays for QuickJS.

---

## 3. Architecture

```
                     ┌──────────────── one webview per SkinWindow (phase 1: the 'main' window) ────────────────┐
 Rust (src-tauri)    │ src/app/ (AppShell, Tauri-aware)         src/engine/ (Tauri-free, checker-enforced)     │
 ────────────────    │ ─────────────────────────────────         ──────────────────────────────────────         │
 headcore crate      │ src/hosts/tauri: HostAdapter ───────────► createEngine(host, opts)                       │
  hit  skinstore     │   window  (SkinWindow, native)              archive/  zip reader, caps, Map VFS          │
  fanout prefstore   │   prefs   (Rust files, per sha)             text/ wms/ decode, scan, select, build       │
  guards             │   media   (MediaModel over player.js)       image/    probe, decoders, keying, service  │
 src/*.rs glue:      │   dsp     (set_eq / set_balance)            realm/    QuickJS, membrane, prelude, wmploc │
  hit_*  skin_*      │   audio   (AudioFrameBus over fan-out)      model/    elements, schema, objects, ledger  │
  prefs_* audio_*    │   decode  (Worker pool)                     layout/   jscript: pass, align, stack        │
 mpd idle, mpd cmd   │   slots   (VizHost, playlist widget)        bind/     wmpprop:/wmpenabled:               │
 audio.rs fan-out    │   palette (PaletteService)                  anim/     moveTo/slideTo/alphaBlendTo        │
                     │   clock, actions, log                       render/   DOM layer tree, drawables          │
                     │ menu, zoom, keys, overlays, sidecars,        input/    picker, dispatch                   │
                     │ demo driver, fault panel, safe mode          shape/    window mask                        │
                     └──────────────────────────────────────────────────────────────────────────────────────────┘
 tools/skinlab/: TestHostAdapter (src/hosts/test) + legacy oracle capture + diff, pinned headless Chromium
```

### 3.1 Load sequence (one VIEW)

1. AppShell resolves the skin SHA-256 (last used, else auto-import of the owner's Headspace) and
   calls `skin_read(sha)` for the bytes. It loads the sidecar (`src/app/sidecars/<sha>.json`) if
   one exists, and calls `engine.load(bytes, {sidecar})`.
2. `archive/zip` indexes the central directory under caps; `archive/vfs` builds the flat case-folded
   Map; `archive/identity` confirms the SHA-256.
3. `wms/select` picks the `.wms` (fewest unresolved references, then stem match, then size; `survey
   1.2`, U-17). `text/decode` sniffs BOM, ASCII or cp1252. `wms/scan` yields a raw tree and
   diagnostics. `wms/build` applies tag defaults and attribute types and creates the element model
   **with literal values only**. Default sizes come from `image/probe` (header bytes). Sidecar
   overlays are appended. Structural caps apply (§10).
4. `realm` creates the VIEW context: prelude, `#132` constants, host globals, the id list and
   class member sets. Then the skin's `scriptFile` entries run in order (implicit `<stem>.js` last
   if not listed); top-level code runs under the scripts budget.
5. `layout/expr` evaluates every `jscript:` value once, in document order. `layout/align` records
   alignment anchors. Sidecar attribute overrides apply (compat entries only under `oracle-compat`).
6. `bind` installs and settles `wmpprop:`/`wmpenabled:`/`wmpdisabled:`. Resulting `_onchange` events
   are queued.
7. `image/service` decodes the images visible elements show, plus their state images, in the Worker.
8. `render` mounts the layer tree into `SkinWindow.root`. `shape/mask` rasterises the shape and
   `SkinWindow.setShape` sends it.
9. VIEW `onload` runs, then the `_onchange` queue drains, then the first frame paints, then
   `SkinWindow.show()` (phase 1: the main window is already visible; see D7.4).
10. AppShell applies sidecar `restore` entries (drawer replay, D10.6).

### 3.2 Steady state

- **Frame loop** (`host.clock.onFrame`): the animator steps tweens and marquees; the position tick
  publishes `currentPosition` to host bindings; dirty attributes apply to the DOM (diffed, fixes
  `parity` D34). If any shape-relevant change happened (move, visibility, image, size, z, alpha), the
  mask is rasterised and sent only if its hash changed. Mask freshness is structural: the engine
  owns the model, so no MutationObserver is needed (resolves `notan Q1(c)` differently, with the
  same effect). Host slots report their own rect changes.
- **Input**: pointer events on the window's input plane go to `input/picker`, then the element's
  gesture state machine, then a realm handler dispatch (with the `event` object), then model writes,
  then the dirty set.
- **Media**: `MediaModel` changes go to bindings and object-model change sources. Realm-visible
  position changes are coalesced to `realmTickHz` (10 Hz).

---

## 4. Decision register

### D1. Script realm

**Position.** QuickJS compiled to WASM, synchronous variant, on the main thread of each skin webview.

- Packages, pinned exactly: `quickjs-emscripten-core@0.32.0` (MIT, JS glue) and
  `@jitl/quickjs-wasmfile-release-sync@0.32.0` (MIT). `emscripten-module.wasm` is 503,134 B raw and
  231,517 B gzip -9, measured by cand-S and cand-F from the npm tarball. The variant is loaded with
  `newQuickJSWASMModuleFromVariant`, so `@jitl/quickjs-ng-wasmfile-release-sync` can be swapped in by
  changing one import if bellard QuickJS fails the RG0 gate. It loads only on the engine path.
- **The `-sync` variant, not asyncify.** Every host read the corpus needs (player state, element
  geometry, prefs) is already in memory, so host functions never await. Asyncify is roughly twice the
  size and slower, and buys nothing.
- **Instances and contexts.** The `WebAssembly.Module` is compiled once per webview and cached. Each
  skin session gets **one module instance** (cand-F) with one `QuickJSRuntime`, and each VIEW gets
  one `QuickJSContext` (`spec 2.1` step 3: each view has its own scope). Phase 1 runs one VIEW per
  webview, so in practice it is one context per instance.
- **Fault domain.** cand-F probe-1 shows that a leaked handle makes `JS_FreeRuntime` abort the
  emscripten module (`Assertion failed: list_empty(&rt->gc_obj_list)`). Rules: after any WASM abort,
  OOM, or a health check that finds leaked handles, the engine **never calls `dispose` again**. It
  drops every reference to the instance and lets GC reclaim it. A clean unload (skin switch, window
  close with zero faults) disposes normally inside a try/catch. A new session always gets a fresh
  instance, so "Reload skin" and "Choose another skin" still work in that webview.

**Scope chain** (`spec 2.4`, U-31). Precedence is **element, then ids, then script globals, then
host globals**. The single exception (G17): an id that equals a host-global name (`id="player"`,
`id="view"`) loses to the host global, with a diagnostic.

- Handlers compile once, in the realm, to
  `new Function(<params>, "with(__IDS){with(this){" + body + "\n}}")` and are called with `this` set
  to the element proxy. `<params>` is empty except for PLAYER events, which get the documented
  parameter names in exact case (`NewState`, `ModeName`, `scType`, `NewValue`, `Param`,
  `oldPosition`, `newPosition`; `spec 2.2`, `6.19`).
- The element proxy's `has` answers true only for members of the element's class plus attributes
  present in its markup, compared case-insensitively. Anything else falls through.
- `__IDS` is a realm-side Proxy. `has(k)` is true when (a) k equals a VIEW id exactly, or (b) k
  equals an id case-insensitively **and** no own property named exactly k exists on the realm global
  (so `Volume` reaches id `volume`, `survey 3.1` Ice, while a skin's own `function volume()` beats
  the case variant), and in both cases (c) k is not one of the six host-global names. `has` is
  answered from a realm-side `Set`; `get` returns the cached element proxy. Unknown names make
  `has` return false, fall through to the global object, and throw `ReferenceError` as JScript does
  (`wmploc 4.3`, bucket B2, 308 uses).
- **Host globals** (`player`, `theme`, `view`, `event`, `mediacenter`, `playerApplication`) are
  installed before any skin script as **configurable, writable** data properties of the realm
  global. `event` is a configurable accessor that returns the current dispatch's event proxy. A skin
  `var`/`function` with the same name replaces the host global, which is exactly "script globals
  before host globals".
- **Prelude internals** (`__IDS`, the captured dispatcher, the loader helpers) are non-writable,
  non-configurable globals. The single native dispatcher function is captured in a prelude closure
  and **deleted** from the global before any skin code runs.
- **Rejected for ids:** a Proxy on the global object's prototype (cand-D's primary mechanism).
  cand-F probe-2 showed QuickJS then resolves *every* unknown global to `undefined`: `undefinedFn()`
  raises `TypeError` and a bare typo read continues silently. That breaks WMP's abort-this-handler
  semantics. **Documented fallback** if RG0 shows `with` over a Proxy is too slow or wrong: own
  accessor properties on the global for every id in its declared case plus every case variant found
  by a lexical scan of the VIEW's script, handler and `jscript:` text (cand-F). That fallback also
  keeps `ReferenceError`.
- **Script files** are evaluated by global code `with(__IDS){ eval(__src) }`, a direct eval. Per
  EvalDeclarationInstantiation, their `function`/`var` declarations land in the global variable
  environment while the functions close over `__IDS`, so `sEqEar.moveto(...)` inside a
  `headspace.js` function resolves. Consequence, accepted and diagnosed: a top-level
  `var x = …` where `x` exactly equals an element id assigns through to the element (ids beat script
  globals, U-31: no collision observed in the corpus). The loader statically lists declared
  top-level names and logs each collision with an id. Fallback if QuickJS deviates: wrap the source
  in `with(__IDS){…}` and rely on Annex B.3.3 hoisting. RG0 decides.
- **`jscript:` values** compile as `function(){ with(__IDS){ with(this){ return eval(__src); } } }`.
  Direct eval gives the completion value, so a trailing `;` (456 `top`s, `spec 3.2`) and statement
  forms work.
- **Handler text** compiles as-is: `jscript:`, `javascript:` and `wmpprop:` prefixes are valid
  statement labels (`spec 2.3`, U-6). Only if compilation fails is one leading `identifier:` stripped
  and compilation retried. If that also fails, the handler becomes a syntax diagnostic (`survey 5.2`:
  exactly 5 handlers in one skin).
- **Case rules**: proxies lowercase member names before they cross; skin-declared names are
  ordinary case-sensitive QuickJS bindings (U-28). Case-variant calls of skin functions still throw,
  as in WMP (`wmploc 4.1` bucket B1, 43 uses).
- **Constants**: the prelude installs the `#132` constants (`os*`, `ps*`, `WMPPlaylistChangeEventTypes`,
  plus `osOpeningUnknownURL`) before any skin script, whether or not the skin lists `#132` (`wmploc
  7.3` item 4). `#169` `sprintf` installs when listed; `#134`/`#136` are cheap and install when
  listed. Other `res://` script entries warn and are skipped.
- **Timers**: the prelude defines `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`.
  Callbacks (a function, or a string compiled with the `with(__IDS)` chain) live in a realm-side
  table; the host schedules numeric ids on the **engine clock** (manual in tests). VIEW
  `timerInterval`/`ontimer` follow `spec 6.2`: default 1000, 0 is off, a non-zero value below 50 is
  rejected and the previous value kept, and the timer runs only if `ontimer` exists.
- **Determinism**: in test mode the prelude replaces `Date.now` and argument-less `new Date()` with
  the engine clock, and seeds `Math.random` from the skin SHA-256.

**The membrane (copy-only).** Only `undefined | null | boolean | finite number | string (≤ 64 KiB) |
{__h: n}` cross, in either direction. A handle is a frozen realm-side object that the prelude turns
into a cached Proxy, so `bEq === bEq` holds. No host object, function, array or host exception
crosses. Host errors become a realm `Error` with a fixed message. Array-valued constants live
realm-side. Exactly one native function crosses, `HostDispatcher` (§5.5):

- `has` never crosses. At boot the host sends each class's lowercased member list and the view's id
  list, and the prelude answers `has` from realm-side `Set`s. Identifier resolution in handlers stays
  inside WASM.
- The host validates every op: the handle exists and is not revoked; the member exists in the class
  schema (unknown: `get` returns `undefined` and records `unknown-member` in the ledger; `set` is
  ignored; `call` returns `undefined`); argument count (≤ 16) and types coerce per `spec 2.4` and
  U-20; per-API policy and rate caps apply (D6.5). Event handles are revoked when their dispatch
  ends; every handle of a view is revoked when its context goes away.
- **No synchronous re-entry.** A host op never runs skin code before it returns. Changes a script
  write causes (a `value` assignment firing `value_onchange`, a binding update) are queued and
  dispatched after the current entry point returns, FIFO. The chain depth is capped at 32 per
  originating event; hitting the cap is a soft fault (it stops `value_onchange` ping-pong between
  two sliders). Whether WMP fires `_onchange` synchronously is unverified; the queue is the
  isolation-preserving choice (risk R11).

**Budgets and faults** (all numbers in §10). The budget clock is a `wallClock` captured from the
real `performance.now` at module load. It is a separate `RealmOptions` field from the engine clock,
and skinlab never installs Playwright's fake clock, so a frozen engine clock cannot disable the
interrupt (fixes cand-F's frozen-clock hang). `executePendingJobs` runs after every entry point under
the same budget, at most 1,000 jobs per drain.

*G2 rulings (security review, `docs/research/realm-security-review-g2.md`).*
- **Memory** is read from the heap only: the module gets a capped `WebAssembly.Memory`, and an entry
  that leaves the heap past its cap, or three failed `grow` calls, is a hard `memory` fault, caught or
  not. QuickJS's own `setMemoryLimit` is not used (it counts allocation overhead, not size, and its
  refusal leaves no heap signal, so OOM could only be read from a thrown object's name, which skin code
  can spoof). A single request past what wasm32 can address (about 2 GiB) stays an ordinary soft
  exception.
- **A stack overflow that skin code catches is ordinary skin behaviour** (JScript's "out of stack
  space" was catchable too). This QuickJS build gives the host no stack signal, so only an uncaught
  overflow, or one that escapes WASM as a host `RangeError`, is a hard fault.
- **Leftover jobs.** Jobs still pending after an entry's 1,000-job drain are charged to that entry
  as a soft fault, then run as their own `jobs` entry (no gesture, handler budget) before the next
  entry starts; a flood that survives that drain is a hard fault at `jobs`. Jobs never run inside
  another entry. QuickJS has no API to discard pending jobs.
- **Guard slots.** Prototype guards (String, Array, typed arrays, JSON, RegExp, Map, Set) are
  non-writable and non-configurable. Global-function guards (`parseFloat`, `parseInt`, the URI
  functions, `escape`, `unescape`, `Number.parse*`) stay writable so a skin may declare its own
  `function escape()`; the native originals are reachable only through the prelude's private table.

- **Soft faults**: an exception in skin code, a syntax error, a membrane cap, or a re-entrancy cap
  hit. Each aborts that dispatch only, is logged once per (site, message), and is counted. Soft faults
  never unload.
- **Hard faults**: the interrupt budget is exceeded, memory or stack is exhausted, the prelude
  throws, or the WASM module aborts. One OOM or abort, or 3 hard faults within 30 s, **unloads the
  view**: timers are cleared, handles revoked, the instance discarded per the fault-domain rule, the
  last frame stays painted, and the AppShell fault panel offers "Reload skin", "Choose another skin"
  and (until cutover) "Use legacy Headspace". The window menu keeps working.
- **Duty cycle**: if realm CPU exceeds 50% of wall time over 5 consecutive 1 s windows, the realm is
  throttled: the timer floor rises to 40 ms, realm position listeners drop to 2 Hz, and the ledger
  records it. Above 80% for 10 consecutive windows is a hard fault. This closes the hole where many
  timers or a 45 ms `ontimer` at a 50 ms interval pin the main thread without ever tripping the
  per-dispatch budget.

**Rationale.** The realm must give, at once: element-implicit `with` scope, case-insensitive host
members over case-sensitive script identifiers, ids as globals, **synchronous** reads of player and
layout state mid-statement (`sEqEar.moveto(eqClosedPos, sEqEar.top, speed)`), and hard CPU and memory
caps (notan Q3). Only an in-thread interpreter gives synchronous access *and* caps. cand-F probe-1
measured 10,000 proxied host reads in 30 ms (about 3 µs each); skin scripts are small (`survey 5.1`:
median 342 lines, maximum 3,938).

**Rejected.**

| Option | Why not |
|---|---|
| Host eval (`new Function` + `with` + Proxy in the page) | No isolation: `(function(){return this})()` reaches `window.__TAURI_INTERNALS__.invoke`, raw `mpd` passthrough (`lib.rs:29-50`) and `record_stop` writing any path (`lib.rs:146`). No CPU bound. SES `lockdown()` would freeze the app's own intrinsics (three.js, Webamp later). |
| Web Worker realm | Synchronous reads need the whole object model in the worker, or `SharedArrayBuffer` + `Atomics.wait`, which needs cross-origin isolation under Tauri's custom protocol (unverified). The global-stripping denylist grows with WebKit. Kept as a phase-3 option: QuickJS *inside* a Worker if the R9 perf gate fails. |
| Sandboxed iframe | Opaque-origin iframes are async (`postMessage`); same-origin ones are not isolated; neither can interrupt `while(1){}` in WebKit's shared process. |

**Evidence.** cand-F probe-1 (`with` + Proxy + case-insensitive `get`; `while(true)` interrupted at
51 ms; OOM at the cap; `eval` sees ids) and probe-2 (global-prototype Proxy loses ReferenceError);
`survey 5.2` (219 scripts, 12,863 of 12,868 handlers compile sloppy, `eval` in 57/195 skins);
`wmploc 4.3`.

**Gate RG0** (WAVES W1.4) must prove all of these in QuickJS before any realm work proceeds. Any of
items 1 to 4 failing sends the work back to O to swap in the ng variant or the accessor fallback.
1. Sloppy `with` over a Proxy with `has` traps resolves element members and ids, including
   case variants.
2. Global-code direct `eval` inside `with(__IDS)` hoists `function`/`var` to the global while
   closures see `__IDS`; otherwise the Annex B fallback passes.
3. A `-sync` host function called from inside a Proxy trap returns synchronously.
4. **`undefinedFn()` throws `ReferenceError`; a bare read of an undeclared name throws
   `ReferenceError`; `typeof undeclared === 'undefined'`** (probe-2 as a test).
5. The interrupt stops `while(1){}`, deep recursion, a catastrophic regex
   (`/(a+)+$/.test('a'.repeat(30)+'b')`) and a Promise-job flood, each within budget plus 10 ms.
   A 200 MB string hits the memory cap. After each, a fresh instance in the same process works.
6. A simulated abort (leaked handle, then dispose) is survived by discarding, and a new instance
   works.
7. All 219 corpus `.js` files and all 12,868 handlers compile in QuickJS with exactly the 5 known
   failures (`survey 5.2`). Handlers come from a throwaway entity-decoding extractor, as the survey
   did, so the gate does not wait for the scanner.

### D2. Renderer and hit-testing

**Position.** A hybrid renderer: a retained DOM layer tree whose leaves are `canvas` elements
holding pixels the engine composited from decoded RGBA, DOM elements for TEXT, host-widget slots
for windowed controls, and **engine-owned hit-testing** through one input plane per window. Paint
and hit come from **separate bit planes**, so a node can paint pixels it does not claim
(BUTTONGROUP unowned pixels with `showBackground=true`, CUSTOMSLIDER frames outside the grey map),
and claim pixels it does not paint (keyed BUTTON pixels).

**Layer tree.**

```
SkinWindow.root (host-owned, transparent)
└─ div.view           VIEW size; transform: scale(zoom); transform-origin 0 0
   ├─ div.layers      pointer-events:none; the painted scene; DOM order = paint order
   │  ├─ div.sv       one per SUBVIEW: position:absolute; isolation:isolate; overflow:hidden when sized
   │  │  ├─ canvas    background slot (z 0 within this context)
   │  │  ├─ canvas…   drawables
   │  │  ├─ span…     TEXT
   │  │  ├─ div.slot  EFFECTS / VIDEO (windowless host surfaces)
   │  │  └─ div.sv    nested SUBVIEW = nested stacking context
   ├─ div.input       position:absolute; inset:0; pointer-events:auto; owns title and cursor
   └─ div.windowed    host widgets WMP draws as native child windows (PLAYLIST now; EDITBOX,
                      LISTBOX, POPUP in phase 3), at their element rects, pointer-events:auto
```

- **Paint order is DOM order, never CSS `z-index`.** Within a context, children sort by
  `(zIndex, kind, documentIndex)`, where the context's background has the fixed slot `(0, 0)` and
  every child has kind 1. A child at `zIndex=0` therefore paints over the background and a negative
  child under it (`spec 5.3`). Equal z: later in the document is on top (U-1). A runtime `zIndex`
  write re-sorts that parent only. No engine node sets `z-index`, which keeps the demo's 1000/2000
  budget (`parity 3.1`).
- **Every SUBVIEW is a stacking context** (Reading C, D5). It clips its subtree to its box when it
  has a non-zero size, explicit or image-derived. A size-less SUBVIEW does not clip, because the
  corpus uses size-less grouping subviews (cand-F, risk R10). Switch: `subviewClip`.
- **SUBVIEW `clippingColor`/`clippingImage`** becomes `-webkit-mask-image` on the `div.sv`, from a
  PNG data URL the engine generates from the clip bits at native size, not stretched. It clips
  overlays too (`parity` D26) and matches the oracle's own `mask-image` mechanism (`css:130-135`).
  `transparencyColor` on a SUBVIEW keys only its background canvas, so negative-z children show
  through.
- **Windowed controls** sit in the top layer: they "always paint above windowless controls" and
  ignore z, alpha and clipping (`spec 2.8`). They receive native DOM events (scrolling, the combo
  drop-down).

**Drawables** (one module each under `src/engine/render/dom/`):

| Element | DOM | Drawing |
|---|---|---|
| VIEW/SUBVIEW background | `canvas` | Keyed image blitted once; `backgroundTiled` repeats it to the box; `backgroundColor` (not `none`) is a CSS background on the `div`. |
| BUTTON and predefined buttons | `canvas` w×h | One keyed image per state. Resolution `disabled > hoverDown > down > hover > up`, with the fallback chain `hover ?? up`, `down ?? hover ?? up`, `disabled ?? up` (`spec 6.4`, `widgets:46`). `tiled` repeats. A BUTTON with no image but a size is an empty canvas that still hit-tests (`spec 2.7`). |
| BUTTONGROUP | one `canvas` | Per-pixel composite generalised from `widgets:102-207`, made incremental: at load the map is indexed into an owner array (exact RGB match, `spec 6.5`) and one pixel list per element; a state change recomposites only that element's pixels. Unowned pixels: painted from `image` iff `showBackground` (default `false`, U-23); **never hit**. |
| SLIDER, PROGRESSBAR | `canvas` track, fg, thumb | Track as is, or with `tiled`: the first and last `borderSize` px are end caps and the middle repeats from the start edge (equal to the oracle's `border-image` slice for Headspace's 1 px middles, `css:83-95`). Foreground: `slide=false` reveals in place up to the reveal edge; `slide=true` translates it with the thumb; `useForegroundProgress`/`foregroundProgress` per `spec 6.7`. Thumb geometry by `sliderGeometry`: **`'oracle'` (default in every config)** travel = `length − thumbExtent`, value = `(p − thumbExtent/2)/travel` (`parity` D32, U-10 default, `demo:108-113`); `'docs'` centres the thumb over `[b, L−b]`. Vertical sliders put max at the top. Values stay continuous inside the control (D31). |
| CUSTOMSLIDER (phase 3) | one `canvas` | Frame `round(f·(N−1))` from the strip along its longer axis. **Hit and value come from the grey `positionImage` plane**: pure grey `g` maps to `min + g/255·(max−min)`, non-grey is dead (`spec 6.8`, U-9). The paint plane is the frame. |
| TEXT and predefined texts | `span` | `textContent` only. Size `round(pt·4/3)` px (7 pt is 9 px, `parity` G8); default 10 pt. Face from the sanitised family list (below). Colour, hover and disabled colours, `justification`, `white-space: nowrap` unless `wordWrap`, ellipsis when cropped (`spec 6.10`), `-webkit-font-smoothing: none`, `line-height: normal`, no padding: the oracle's text box (`parity 4.1`). `textWidth` is measured on a hidden span with the same style. `scrolling` is a marquee stepped on the engine clock (`scrollingAmount` px every `scrollingDelay` ms, two-space gap). TEXT with `alphaBlend` and no `backgroundColor` gets a black background (`spec 5.4`). |
| EFFECTS | `div.slot` | Host slot: VizHost mounts its canvas and overlays inside (D10.2). Windowless by default, so it stacks and clips like any control. |
| VIDEO | `div.slot` | Inert stub: `backgroundColor` only; `onvideostart` never fires (`parity` D19). |
| PLAYLIST | slot in `div.windowed` | Host widget (D10.4). |

Canvases are sized in skin px, CSS-scaled by the view transform, with `image-rendering: pixelated`
(`css:39-46`). Pixels go in by `putImageData` from the keyed RGBA, so at DPR 1 and 2 they rasterise
like the oracle's PNG `<img>` of the same pixels (risk R6 covers DPR 2).

**Animation.** `moveTo(x, y, ms)` is linear; `slideTo` and `moveSizeTo(…, fSlide=true)` use a cubic
ease-in-out (U-25); `alphaBlendTo(a, ms)` is linear in alpha. One `Animator` steps every tween on the
engine clock, writes integer `left`/`top`/`width`/`height` (or `alphaBlend`) to the model, and the
renderer applies only changed values. Completion fires `onEndMove` for all three move methods and
`onEndAlphaBlend` for blends, queued after the frame. A new move on an element cancels the old one
without firing its end event; the replacement fires at its end, including a reversed move
(`parity 3.7`). `alphaBlend` maps to CSS `opacity` on the node (a SUBVIEW or BUTTONGROUP blends as a
unit, `spec 5.4`); keyed pixels stay keyed (U-13). No CSS transitions are used (they ignore the
injected clock).

**Strings, fonts, cursors.** Text and tooltips are set with `textContent` and the `title` property
only. `fontFace` is split on commas (G27); each family must match `^[A-Za-z0-9 ._-]{1,64}$` or is
dropped; survivors are quoted, followed by `Tahoma, Verdana, sans-serif` (`parity` D22). `res://`
faces resolve through the string table first. `cursor` keywords map to CSS keywords (`hand` to
`pointer`, `system` to `default`, `size*` to the resize cursors; an unknown name keeps the previous,
U-21). `.cur`/`.ani` files are phase 3 and will be decoded by us into a blob URL. A skin string is
never placed in `url()`.

**Hit planes.** Each drawable carries `paint` (alpha > 0 after keying) and `hit` bit planes at skin
resolution, produced with its pixels (D3):

| Pixel | `hit` | Source |
|---|---|---|
| opaque or partly opaque | 1 | |
| keyed by `transparencyColor` on BUTTON, BUTTONGROUP owned pixel, SLIDER thumb | 1 when `buttonKeyedPixelsHit` (faithful default), else 0 | `spec 2.7`, `button-transparencycolor` |
| keyed by `transparencyColor` on a VIEW/SUBVIEW background | 0: passes to lower layers | Headspace's magenta face window passes clicks to the screen (`parity 0.3`, open question 3) |
| `clippingColor` / outside `clippingImage` | 0, and clips the subtree for subviews | `spec 5.5` |
| BUTTONGROUP pixel owned by no `mappingColor` | 0, whatever `showBackground` says | `spec 2.7` |
| BUTTON without image but with a size | 1 over its box | `spec 2.7` |
| TEXT | 1 over its box | |
| CUSTOMSLIDER | the grey pixels of `positionImage` | `spec 6.8` |

**Picker** (`input/picker.js`, pure). It walks the view in paint order, top-down; maps the point into
each element's local coordinates; skips `visible=false` subtrees, `passThrough=true` elements (their
SUBVIEW children are still tested, U-7) and points outside an ancestor's clip box or clip mask; and
returns the first element whose `hit` bit is set, with a role:

| Role | When | Effect |
|---|---|---|
| `control` | buttons, sliders, elements with any mouse handler | receives the gesture |
| `blocked` | `enabled=false` on an interactive element | press is swallowed: drawn, no events, no drag (`spec 2.7`) |
| `effects` | EFFECTS slot | host click action (D10.2) unless the skin has `onclick` |
| `widget` | windowed slot | native DOM events inside the widget |
| `chrome` | any other painted, unclipped pixel | a **real** left press calls `SkinWindow.startDrag()` (U-11; `parity` D29 is an intended, reviewed deviation: every unclaimed opaque pixel drags). Synthetic events never start a native drag (cand-D). |
| none | no hit bit | no-op; the OS mask normally passes the click through |

**Gestures** (U-18): `onmousedown`, `onmouseup`, `onclick` (only when down and up are on the same
element), `ondblclick`, hover enter/leave, no bubbling. Any press on a control calls
`SkinWindow.setCapture(true)` until `pointerup` or `pointercancel` (fixes `parity` D30). The DOM
`click` event is ignored; clicks are derived from down/up, so the demo's extra synthetic `click`
(`demo:93-96`) cannot double-fire. `setPointerCapture` sits in a try/catch (synthetic ids throw,
`parity 3.1`). Tooltip and cursor follow the hovered element through the input plane's `title` and
`cursor`. `D28` is reproduced: a slider's thumb hover image shows whenever the pointer is over the
slider box.

**Window shape** (`shape/mask.js`, pure). For each visible element in paint order, it ORs
`paint ∪ (hit if the element is interactive)`, clipped by ancestor boxes and masks; slots and
windowed widgets contribute their reported rects. It is recomputed from a dirty flag at most once
per frame, **including during animations** (fixes `parity` D11/D33), and sent only on a hash change.
A shape with popcount below 64 is replaced by the full view rect plus a diagnostic, so a skin whose
pixels are all transparent cannot make the window unreachable (§10). Expected differences from the
oracle: (a) 106 screen-corner bits fewer, because the oracle treats the effects canvas as a solid
rect (`parity 4.1`); (b) in `faithful` only, the keyed BUTTON pixels outside every painted pixel.
On Headspace that is 130 keyed EQ-handle pixels and 135 keyed PL-handle pixels over keyed ear art,
about 265 bits per state as measured by a judge. The harness computes the set at run time and
records the bound (§9.4).

**Rejected.** *Pure DOM `<img>` per state* (the hand port) needs a URL per keyed variant and lets the
browser test boxes, not pixels. *One canvas compositor per window* would draw TEXT with `fillText`,
which ignores `-webkit-font-smoothing` and differs from the oracle's DOM text ("a text diff is a
failure", `parity 4.1`). *DOM `clip-path` hit regions* (cand-F) put paint and hit on one node: the
clip hides the ~811 unowned BUTTONGROUP pixels that `showBackground=true` must paint (which would
break the oracle-compat zero-diff gate), would clip CUSTOMSLIDER frames to the grey map, and builds
path strings that grow with region raggedness (a checkerboard image becomes millions of rects, an
algorithmic DoS).

**Forbidden in engine code:** `innerHTML`, `insertAdjacentHTML`, `<img src>` of any skin-derived URL,
CSS `z-index`, `elementFromPoint` or `pointer-events` tricks for skin elements, CSS transitions for
skin animation.

### D3. Image pipeline

**Position.** Our own pure-JS decoders for every format. Header-only probing provides layout sizes;
caps are checked from headers before allocating; keying is per declaration in the same pass;
decoding runs in a Worker in the app and inline in Node.

| Format | Implementation | Corpus facts behind it |
|---|---|---|
| BMP | Own, about 400 lines. Headers 12 (OS/2), 40, 52, 56, 108, 124 bytes. Bottom-up and top-down. 1/4/8/16/24/32 bpp. BI_RGB, BI_RLE8, BI_RLE4 (end-of-line, end-of-bitmap, delta, absolute runs with word padding), BI_BITFIELDS. **16-bit BI_RGB is X1R5G5B5** (the format definition; settles `wsz 3.1`'s ImageIO-vs-PIL split by spec, not by either decoder). **Alpha is forced to 255** for every BMP (GDI and Winamp ignore it; 28 of 29 32-bit Winamp sheets have all-zero alpha, `wsz 3.1`); a non-zero alpha channel logs one diagnostic. A palette shorter than 2^bpp is accepted. Truncated or out-of-range RLE stops that image: decoded rows stay, the rest is transparent, one diagnostic. 8-bit images also return `{palette, indices}` for phase-3 `hueShift`/`saturation` (cand-F). | WMP referenced: 24 bpp 2,902, 8 bpp 587, 4 bpp 66, 1 bpp 3; RLE in 15/195 skins (`survey 3.3`). Winamp: RLE8 in 12% incl. base-2.91 (`wsz 1.3`). |
| PNG | Own chunk parser (IHDR, PLTE, tRNS, IDAT, IEND; others ignored), `fflate@0.8.3` `inflateSync` **into a buffer of exactly the size IHDR implies** (overflow marks the image corrupt), own unfilter; all colour types and bit depths (16-bit scaled down), Adam7. No gAMA/iCCP application (GDI did not apply it; colour management could move `#FF00FF` off its key). | Alpha PNG in 61/195 skins, tRNS in 43 (`survey 3.3`) |
| GIF | Own LZW decoder, about 250 lines: frames, disposal, transparency index, NETSCAPE loop; frame cap. Phase 1 renders frame 0; phase 3 animates. | 1,569 multi-frame GIFs, max 145 frames |
| JPEG | `jpeg-js@0.4.4` (BSD-3-Clause), called with `maxResolutionInMP 16.78`, `maxMemoryUsageInMB: 256`, `useTArray: true`, after our own SOF header probe has checked the axis and area caps. | 450 referenced JPGs in 66 skins |
| Detection | Magic bytes only; the extension is ignored. | `Nautical` `vol_slider.bmp` is a GIF, `drawer.bmp` a JPEG (G7) |

**Why not the browser decoders.** (1) The harness is Chromium and the app is WKWebView; browser
JPEG and 16-bit BMP decoding differ between engines (`wsz 3.1`), so browser decoding would make the
oracle comparison engine-dependent. (2) BMP alpha must be forced opaque. (3) Every decoder becomes a
Node unit test. (4) ImageIO never parses attacker bytes; the browser only ever sees RGBA we produced.
cand-D's `createImageBitmap` for JPEG is rejected on (1) and (4).

**Caps** (also in §10). Per axis ≤ **16,384 px**; area ≤ 16,777,216 px (64 MiB RGBA); GIF frames ≤ 512;
live decoded bytes ≤ 256 MiB per skin session, LRU-evicted beyond that; 2 s wall time per decode,
after which the Worker is terminated and recreated and the image is "missing". The axis cap is set
by referenced CUSTOMSLIDER strips: `microsoft__pharaoh` `seek_steps.bmp` 15,990×20 (the widest),
`Nautical` `vol_slider.bmp` 9,494×144, `The_Doobie_Brothers` `vol_anim` 9,152×45 and `pos_anim`
4,683×91, `Ice` `Vid-set.bmp` 9,144×12, `Gold` `progress.bmp` 6,223×13, `Official_Xbox_XP/MP71`
`vol.png` 5,040×28, `XBOX/Official_Xbox` `seek.png` 4,192×13. An 8,192 or 4,096 cap would reject
4 to 8 real skins. (`survey 3.3`'s "the only image over 1500×1500" means over 1,500 on *both* axes;
it is not a maximum width.) The area cap clears the largest image, an unreferenced 2,528×3,300.

A failed or capped decode yields a **missing image**: it renders as nothing and logs one diagnostic
(`survey 3.2`: missing files are common and must not abort a skin).

**Keying.** A pure function of `(sha256 of entry bytes, KeySpec)`, cached by that pair:

- Exact RGB match, no tolerance. `auto` is pixel (0,0) of that image. `none` or no declaration means
  no key. A SLIDER without a declared `transparencyColor` is not keyed (`parity 0.1` rule 5).
- Keys apply to whichever image is currently shown; a script that swaps `image` keeps the key
  (`spec 5.5`).
- PNG/GIF alpha is composited **and** keys apply (U-27; 58 skins combine them, `survey 3.3`).
- Map images (`mappingImage`, `positionImage`) are never keyed; they stay raw RGB.
- Output: RGBA (keyed pixels alpha 0) plus the `paint`, `hit` and `clip` bit planes of D2.

This replaces the hand port's universal offline magenta keying (`parity` D27). For Headspace the
per-declaration result equals `public/skin/*.png` (alpha exact, RGB exact where alpha > 0), which
`parity 0.2` measured; WAVES W1.3 asserts it.

**Where it runs.** `image/probe.js` is synchronous on the main thread over header bytes only, and
gives layout its default sizes. `image/decode/*` and `image/keying.js` are pure functions over
`Uint8Array`. `ImageService` uses the host's `DecodeExecutor`: the Tauri adapter has a one-Worker
module pool (bytes transferred in, RGBA and planes transferred out); the test adapter runs inline.
Decodes are lazy (images an element currently shows plus its state images, like `widgets:50`). A
script assigning `el.image = "x.bmp"` returns immediately; the old pixels stay until the new decode
lands, and `settled()` waits for pending decodes, so the harness never captures a half-loaded state
(`parity` I6).

### D4. Skin loading and untrusted input

**Position.** Rust stores archives and returns their bytes by content hash; the engine parses the
zip in JS, in memory, under caps, into a flat case-insensitive VFS. Nothing is ever extracted to
disk, so the design cannot express a filesystem path derived from an entry name. One zip reader
serves the app, the harness, Node tests and (phase 2) the Webamp path. (`notan Q3(1)` suggested
extracting to `appdata/skins/<sha256>/`; storing the archive keeps the content-hash namespace and
removes the extraction bug class. `wsz 6` item 2 recommends the same.)

**Rust side** (`headcore::skinstore`, glued as commands at the re-pin):

```rust
#[tauri::command] fn skin_import(app: AppHandle, path: String) -> Result<SkinRecord, String>;
#[tauri::command] fn skin_list(app: AppHandle) -> Vec<SkinRecord>;
#[tauri::command] fn skin_read(app: AppHandle, sha: String) -> Result<tauri::ipc::Response, String>;
#[tauri::command] fn skin_remove(app: AppHandle, sha: String) -> Result<(), String>;
#[tauri::command] fn skin_default_path() -> Option<String>;   // WINDOW_HEADMPD_SKIN, else ~/Downloads/Headspace.wmz if present
#[derive(Serialize)] struct SkinRecord { sha: String, name: String, family: String, bytes: u64, imported_at: u64 }
```

- `skin_import` is called only by AppShell code (first-run import of the owner's Headspace, the
  `WINDOW_HEADMPD_SKIN` env var exposed through `skin_default_path() -> Option<String>`, since the
  webview cannot read process env; phase-2 open dialog or drag and drop). Because it would
  otherwise be an arbitrary-file-read primitive, it accepts only paths ending in `.wmz`, `.wsz` or
  `.zip` (case-insensitive) that are regular files (not symlinks) of at most 32 MiB with an
  end-of-central-directory signature in the last 65,557 bytes. It hashes with SHA-256 and writes
  `app_data_dir/skins/<sha>.<ext>` by write-to-temp then rename, and updates `skins/index.json`.
- `skin_read` and `skin_remove` accept only `^[0-9a-f]{64}$`. Bytes return as a raw
  `tauri::ipc::Response`, never a JSON number array.
- Rust never parses entries.

**Zip reader** (`src/engine/archive/zip.js`):

- Find the end-of-central-directory record in the last 65,557 bytes. Reject ZIP64 and multi-disk
  archives (no corpus need). Walk the central directory only.
- Methods stored and deflate. Encrypted entries and other methods are skipped with a diagnostic.
- **Corrupt local headers** (3 distinct corpus archives have `01 00 01 00` instead of `PK\3\4`,
  `survey 1.2`): if the local signature is wrong but the local header's name bytes equal the central
  directory's name, read the data at `offset + 30 + nameLen + extraLen` and log; otherwise skip.
- Inflate with `fflate` into a buffer of exactly the declared size; overflow, underflow or a size
  over the caps marks the entry corrupt (`read` returns `null`). A CRC mismatch is logged, not fatal.
- Names: UTF-8 when flag bit 11 is set, else CP437. `\` becomes `/`. Names with NUL, a leading `/`,
  a drive letter or a `..` segment are skipped. Directory entries, symlinks (`S_IFLNK` in the Unix
  external attributes), `__MACOSX/`, `RESOURCE.FRK/`, AppleDouble `._*` and `.DS_Store` are skipped.
- Caps (§10): archive 32 MiB, 4,096 entries, 32 MiB per entry, 256 MiB total inflated (counted
  lazily, only entries actually read), ratio ≤ 1,024:1 for entries over 1 MiB (corpus maximum 130:1,
  `Old_Mac-OS` `cropper.bmp`), names ≤ 255 bytes.

**VFS** (`archive/vfs.js`). The key is the NFC-normalised, lowercased **basename**. References reduce
the same way, so `Bass_SliderBG.bmp` finds `bass_sliderbg.bmp` (62/195 skins need this, `survey 3.2`)
and `pl\pl_dropdown_wood.png` finds `pl_dropdown_wood.png`. Collisions after folding: the last entry
in the central directory wins, with a diagnostic (Webamp's rule, `wsz 4.1`; `Old_Mac-OS`). The map is
a `Map`, so an entry named `__proto__` is just a name. `res://` references never reach the VFS.

**Definition file and text.** Several `.wms` (2 distinct archives): fewest unresolved file
references, then stem equal to the archive name, then larger (U-17; picks `Nautical.wms` and
`ExtremeSports.wms`). Text: BOM sniff (UTF-16LE, UTF-16BE, UTF-8), else pure ASCII, else
Windows-1252 (`survey 2.1`: no BOM-less UTF-8 in the corpus). Same rule for `.js`. The implicit
`<stem>.js` loads when not listed (11/195 skins).

**Identity and caching.** The archive SHA-256 (64 hex; the first 12 in logs) keys prefs, sidecars,
window state, goldens and caches. Decoded images live in an in-memory LRU per session. A persistent
decode cache is a phase-3 optimisation, only if R9 load time exceeds 1 s.

**Phase 2 (Webamp).** `openVfs` validates first; Webamp then receives a **canonical re-zip of the
validated VFS** (stored entries, normalised names) as a `blob:` URL, never the original bytes. That
removes the parser differential between our reader and JSZip.

### D5. Parse, layout and bindings

**Scanner** (`wms/scan.js`): a hand-written tokenizer over the decoded string, not an XML parser
(`survey 2.4`, `spec 8.4`).

1. Skip comments, `<?…?>` and leading whitespace; ignore text content.
2. Lowercase tag and attribute names. Accept `name="v"`, `name='v'`, whitespace or tabs around `=`
   (`Portals.wms`), missing whitespace between attributes (22 distinct skins, G3), and an unquoted
   value up to whitespace or `>`.
3. Decode entities (`&amp; &lt; &gt; &quot; &apos;` and numeric, including `&#13;`) in attribute
   values before any value reaches script (`survey 2.3`, G16).
4. **Duplicate attributes, including case-variant duplicates: the last one wins**, with a diagnostic
   (U-5; 299 conflicting duplicates in 67 skins all read as "the second value is the author's intent",
   `survey 2.2`, `Secura` `max="100"` then `max="wmpprop:…duration"`).
5. A close tag pops to the nearest case-insensitive open match; an orphan close tag is ignored;
   scanning stops after the first close of the root (G5, `MotherLand`).
6. Unknown tags become inert nodes that can still carry ids and handlers (undocumented `<network>`,
   `<currentMedia>` under PLAYER, `spec 6.19`); they are never rendered and the ledger records
   `unknown-tag`. Unknown attributes are kept but have no behaviour (G12).

Output: `RawNode { tag, attrs: RawAttr[] (after last-wins), children, line }` plus diagnostics with
line numbers. Acceptance: 195/195 distinct corpus `.wms` give a THEME root with at least one VIEW.

**Value classes** (parsed once per attribute): literal; `jscript:` (prefix case-insensitive, optional
leading whitespace, trailing `;` handled by eval); `wmpprop:`; `wmpenabled:`/`wmpdisabled:`;
`res://` (string attributes, resolved through `wmploc 7.7`); handler (`on*`, `*_onchange`, PLAYER's
bare event names, `<controls currentPosition_onchange>`). Handlers are never classified; they
compile as script. A misspelled prefix (`wmppprop:`, `wmpenable:`, 18 skins, G14) stays a literal
string with a diagnostic.

**Coercion** (`spec 2.4`, `3.1`, U-20, U-22): numbers are trimmed (`width="600 "`); booleans are
`true/false/1/0` case-insensitive, anything else keeps the previous value; colours are `#RRGGBB`,
`#RGB` (U-29), the 140 IE names, `none`, `auto`. Script assignment coerces to the attribute's type
(`player.settings.mute='false'` is false).

**Build.** Every element is created in document order with literal values and predefined-tag defaults
(G23: PLAYBUTTON, STOPELEMENT, VOLUMESLIDER… are a base type plus a defaults table, `spec 6.4`,
`6.6`, `6.7`, `6.10`, `6.13-6.15`). Width and height default from the probed image size (`spec
5.1`); a VIEW without a size takes its `backgroundImage` size (G21a). Ids are case-preserved and
scoped per VIEW; a repeated id resolves to the last declaration, with a diagnostic (30 skins). An
id-less element gets WMP's own `Unnamed_<kind>_<n>`, numbered per kind in document order across the
THEME (`spec 5.1`); that is also the stable address the demo and sidecars use.

**`jscript:` evaluation: once, in document order** (U-3). Order per VIEW: literal pass; prelude;
skin scripts' top-level code; the `jscript:` pass; binding settle; `onload`. An expression that reads
a `jscript:` attribute not yet evaluated reads that attribute's default (0), which is exactly the
9SeriesDefault forward-read case (`svMain.width` reads `svStub.width` = 263, declared 816 lines
later, `spec 2.1` step 4). Scripts load before the pass because expressions read script globals
(`Portals.wms:715` `left="JScript:eqLeft+0"`). The whole pass is capped at 1,000 ms in addition to the
20 ms per-expression budget.

There is no re-evaluation. The research disagrees (`spec 3.2`/U-3 says once; G13 says re-evaluate
when a dependency changes), and the corpus decides it: `left="jscript:view.width-N"` is paired with
`horizontalAlignment="right"` in 2,773 of 2,791 cases, `top` with `verticalAlignment="bottom"` 2,602
times, and `width="jscript:view.width"` with `stretch` 550 times. Authors used the expression for the
initial position and the alignment to keep it; liveness is spelled `wmpprop:`
(`top="wmpprop:svX.top"`, `spec 3.3`). After the pass, `layout/align` records the size each container's children were placed for (G3: so a script move or resize between the pass and a relayout keeps the element's current margins, and a slid drawer is not snapped back). Inside one element, `jscript:` attributes evaluate in attribute-table order (G3; corpus: order matters in 0 elements).
A parent resize (phase 3) re-places by alignment: `right` keeps the right margin, `center` the centre
offset, `stretch` both margins, `left`/`top` the origin. If R6 shows a skin that needs liveness, the
escape hatch is a per-attribute `reevaluate` flag (cand-D), not a redesign.

**Stacking: the docs-versus-Headspace conflict.** The docs say a VIEW/SUBVIEW z is absolute and a
control's z is relative to its container (`spec 5.3`). Read literally (Reading A) or as an additive
flat sort (Reading B), Headspace's closed state paints the playlist panel over the screen. Only
**Reading C, every SUBVIEW is a stacking context**, reproduces the skin (`parity 0.1` rule 4 works all
three; `spec 5.3` agrees independently from the `visDrop` slide). Within a context, children
(controls and nested SUBVIEWs alike) are ordered by their own z relative to the context's background
at 0, then document order, and never interleave with the context's siblings. Only VIEW-level SUBVIEWs
order against the VIEW background. BUTTONELEMENTs use their group's z. Equal z means document order
(U-1). Switch: `stacking: 'context' | 'flat'`.

**Bindings** (`bind/`), host-side, never in the realm:

- `wmpprop:` grammar: `segment ('.' segment)* ';'?` where `segment = ident | ident '(' literal (','
  literal)* ')'`. The root resolves case-insensitively against host globals, then the VIEW's element
  ids (`eq.gainLevel3`, `visEffects.currentPresetTitle`, `vidset`). Call segments with literal
  arguments are allowed (`player.settings.getMode('loop')`, `spec 3.3`).
- A binding subscribes to the change source of **every object on the path** and re-resolves when an
  intermediate object is replaced (`currentMedia` on a song change). An unresolvable path leaves the
  default and records `unresolved-binding` once.
- One-way, assigning **only if the coerced value differs**. The assignment fires `<attr>_onchange`
  through the queue (`spec 2.3`). A script or user write overrides until the next source change.
- **No feedback loops**: a binding never writes the player. `value_onchange` handlers that write the
  player back go through `MediaModel`/`DspPort` setters, which are no-ops when the value equals the
  current or pending value (`spec 6.7` consequence 1). The 32-deep chain cap is the backstop.
- **Drag suspension**: while the user drags a SLIDER or CUSTOMSLIDER, updates to its `value` (and
  `max`) are held, latest wins, and applied at drag end (`parity` D18).
- `wmpenabled:X`/`wmpdisabled:X`: take the last path segment, drop `()` and `;`, case-fold, and bind
  `controls.isAvailable(name)` (negated for `wmpdisabled:`) on **any** boolean attribute (U-4:
  `visible` 287, `enabled` 132, `tabStop` 46, `down` 3). Re-evaluated on play-state, open-state, queue
  and position changes.
- **Position**: `currentPosition` publishes to host-side bindings **every frame** while playing (the
  oracle's smooth seek thumb, `main:462-468`, `parity` F4). Realm-visible changes
  (`currentPosition_onchange`, a bound `value_onchange`) are coalesced to `realmTickHz` = 10 Hz
  (U-19 leaves WMP's rate unknown; 176 skins listen). Seeks and state changes publish immediately.

### D6. Object model

**Position.** Host-side objects behind handles, every class declared in **one schema**. The membrane's
validation, the realm's `has` sets, the binding resolver, the stub generator, per-API policies and
the coverage ledger all read the same table.

```ts
type MemberImpl = 'live' | 'emulated' | 'stub' | 'denied';
interface MemberSpec {
  name: string;                         // canonical spelling, e.g. 'currentPosition'
  kind: 'prop' | 'method' | 'event';
  type: 'number' | 'string' | 'bool' | 'object' | 'void';
  access?: 'r' | 'rw';
  impl: MemberImpl;
  changeSource?: string;                // e.g. 'media.elapsed'; drives bindings
  stubValue?: Wire;                     // type-correct inert value for stubs
  policy?: PolicyId;                    // D6.5
}
type ClassSchema = ReadonlyMap<string /* lowercased */, MemberSpec>;
```

Case-insensitivity is structural: keys are lowercased once when the schema is built and at each
Proxy access. Element attributes use the same table (`xPlTt.tooltip` reaches `toolTip`, `parity 0.1`
rule 3). Element host objects are built against the `ElementModel` contract (§5.3), so the object
model can be implemented and tested with an in-test fake element before the builder exists.

**Mapping (phase 1).**

| Object | Members | MPD / host |
|---|---|---|
| `player` | `playState`, `openState` (integers, D6.2), `status` (synthesised: "Playing", "Paused", "Stopped", "Ready", "Connecting…", U-32), `URL` (read: current file URI; write `denied`), `controls`, `settings`, `currentMedia`, `network`, `currentPlaylist`, `versionInfo` "11.0.5721.5145", `fullScreen` false | `launchURL` `denied`; `mediaCollection`, `playlistCollection`, `cdromCollection`, `dvd`, `newPlaylist` are inert stub objects |
| `player.controls` | `play()` (`play`, or `pause 0` when paused), `pause()`, `stop()`, `next()`, `previous()`; `currentPosition` (r: extrapolated elapsed, `player:92-97`; w: `seekcur`); **`currentPositionString` as `MM:SS`, or `HH:MM:SS` from one hour (`03:07`, `01:00:00`; `spec 7.2`)**; `isAvailable(name)` | `fastForward`, `fastReverse`, `step` stubs (MPD has no scan) |
| `isAvailable` table | **phase 1 = the oracle's** (`parity` D16): `stop` iff not stopped; `pause` iff playing; `play`, `next`, `previous` always; `currentPosition` iff duration > 0; `fastForward`/`fastReverse` never | switch `availability: 'oracle' \| 'mpd'`; the richer table is a phase-3 decision (`parity` open question 5) |
| `player.settings` | `volume` (`setvol`; with no MPD mixer it reads 0, writes are dropped and logged once, `parity` D9); `mute` **emulated** (remember volume, `setvol 0`, restore; writing the current value is a no-op); `balance` (host-local through `DspPort`, persisted; values within ±5 go to the DSP as 0, and the stored value snaps to 0 so the bound slider snaps back at drag end, `parity` D17); `getMode/setMode('loop'\|'shuffle')` → MPD `repeat`/`random` | `rate` 1, `autoStart` true, others stub |
| `player.currentMedia` | `name` (Title, else Name, else file stem, `player:28-31`), `duration`, **`durationString` (same format as `currentPositionString`)**, `sourceURL`, `getItemInfo(key)` (`Author`/`Artist`→Artist, `Title`, `Album`/`WM/AlbumTitle`, `WM/TrackNumber`→Track, `Genre`, `Bitrate`→status bitrate × 1000, `Type` "audio", others `""`), `imageSourceWidth`/`Height` 0 | `setItemInfo` `denied` |
| `player.currentPlaylist` | `count`, `name` "Now Playing", `item(i)`, `getItemInfo` | |
| `player.network` | `downloadProgress` 100, `bufferingProgress` 100, `bitRate` from status | rest stub |
| `theme` | `savePreference`, `loadPreference` (D6.4); `loadString` (`wmploc 7.7`); `logString` (host log); `author`, `title`, `copyright`; `currentViewID` (read) | `openView`/`openViewRelative`/`closeView`: phase 1 logs and no-ops for views other than the current one (phase 3 via `WindowManager`); `openDialog` returns `""`; `playSound` stub; `showErrorDialog` no-op |
| `view` | `width`, `height` (read; a write updates the model, so script reads back what it wrote, and calls `SkinWindow.requestSize`, which phase 1 ignores per `parity` D13); `minimize()`, `close()` (**honoured only inside a user-gesture dispatch**, D6.5); `returnToMediaCenter()` (host action, default zoom toggle, `parity` D3); `timerInterval`, `title`, `focusObjectID` | `size(handle)`, `maximize`, `restore`, VIEW-level `moveTo`/`alphaBlendTo`: phase 3 |
| `event` | `x y clientX clientY offsetX offsetY screenX screenY screenWidth screenHeight button keyCode altKey ctrlKey shiftKey srcElement fromElement toElement` (`spec 5.7`); `keyCode` is the Windows virtual-key code mapped from `KeyboardEvent.code`; the handle is revoked after the dispatch | |
| `mediacenter` | the documented keys only: `effectType`, `effectPreset`, `videoZoom`, `videoStretchToFit`, `videoShrinkToFit`, `showTitles`, `showEffects`, `contrastMode` (U-14); persisted in the host-global `mediacenter` namespace with change events; seeded once from the legacy `localStorage.preset` | other keys live for the session only and record a ledger entry (no cross-skin store) |
| `equalizerSettings` (`eq`) | `gainLevel1..10` (dB, host EQ state through `DspPort`, persisted), `gainLevels(i)`, `reset()`, `bands` 10, `bypass` (host state, **default false**: EQ active; WMP's documented `true` reflects its own full-mode toggle, and every Headspace user today has the EQ live), `enableSplineTension` (accepted, no DSP effect, `parity` G10) | presets: one "Custom"; SRS and normalisation stub |
| `videoSettings` | `brightness contrast hue saturation` held locally, `reset()` | no effect |
| EFFECTS element | `currentEffectType` (constant), `currentEffectTitle`, `currentPreset`, `currentPresetTitle`, `currentEffectPresetCount`, `effectCount` 1, `next()`, `previous()`, `nextPreset()`, `previousPreset()`, `fullScreen` false, `settings()` no-op | mapped onto the host `EffectsControl` (VizHost) |
| PLAYLIST element | `visible`, colours read at build, `setColumnResizeMode`/`setColumnWidth` accepted and ignored | selection methods phase 3 |
| VIDEO element | stub; `onvideostart`/`onvideoend` never fire | `parity` D19 |
| every element | ambient attributes (`spec 5.1`), `moveTo slideTo moveSizeTo alphaBlendTo` (`spec 5.2`), per-type attributes (`image`, `hoverImage`, `downImage`, `upToolTip`, `toolTip`, `value`, `down`, …), `elementType`, read-only `textWidth`, `buttonCount`, `index`; BUTTONGROUP `click(i)`, `getButton(i)` | |

**D6.2 Enums.** `playState`/`openState` are integers (81 skins compare against numeric literals,
`survey 5.3`). Mapping per `wmploc 7.5`: play → `psPlaying` 3 / `osMediaOpen` 13; pause → `psPaused`
2 / 13; stop with a current song or a non-empty queue → `psStopped` 1 / 13; **empty queue and no
current song → `psUndefined` 0 / `osUndefined` 0**; MPD unreachable → 0 / 0 with status
"Connecting…". (cand-D's `osPlaylistOpenNoMedia` departs from `wmploc 7.5` and is not used.)

**D6.3 `MediaModel`** (the MPD seam, §5.6) is written once. The Tauri adapter wraps the exported
`player` and `mpd` of the pinned, unchanged `player.js`; the test adapter is a scripted fake that
records calls. Commands are typed and idempotent against the current or pending state, never raw MPD
strings.

**D6.4 Preferences.** `theme.savePreference(key, value)` stores `String(value)`;
`theme.loadPreference(key)` returns the stored string or **`"--"` when unset**. The research
disagrees (U-16 recommends `""`); the corpus decides: 83 of the 94 preference-using skins test
`"--" != x` (`survey 5.3`, G20). Prefs are namespaced by archive SHA-256, and no API takes a
namespace, so cross-skin reads are impossible. They live in **Rust files**
(`app_data_dir/prefs/<ns>.json`, write-to-temp then rename), not `localStorage` (which has one origin
quota shared with host keys and is readable by any page-realm code). Caps: 256 keys, key ≤ 256 B,
value ≤ 4 KiB, 64 KiB per namespace; over-cap writes are dropped with a ledger entry; caps enforced
in JS and again in Rust. The namespace loads into a `Map` before scripts run (reads are synchronous)
and writes through debounced 250 ms. Namespaces: `<sha256>` (skin), `app` (window, zoom, legacy
host keys), `mediacenter`.

**D6.5 Policies for dangerous or meaningless APIs.**

| API | Corpus use | Phase-1 policy |
|---|---|---|
| `player.launchURL(url)` | 1,014 refs (`spec 7.1`) | `denied`; logged once per skin with the URL; phase 3 may add an http(s)-only confirm |
| `player.URL = …` | 294 | `denied` (the user owns the MPD queue) |
| `theme.openDialog` | 282 | returns `""` |
| `theme.playSound(wav)` | 95 | stub; phase 3 decodes from the VFS and plays capped |
| `theme.openView` loops | 897 | phase 1: current view only; phase 3: ≤ 16 open views per skin, ≤ 4 opens per second |
| `view.close()`, `view.minimize()` | | honoured only during a pointer or key handler dispatch (a user gesture); from `onload`, timers or bindings they are `denied` and logged, so a skin cannot close itself at every launch |
| `setTimeout` floods | 18 | 64 live timers per view, 10 ms floor (D1) |
| `savePreference` floods | 3,052 | D6.4 caps and debounce |
| MPD commands from script origin | | ≤ 10 per second per verb; `seek` and `setVolume` are a trailing 40 ms debounce (`parity` D18; G2): the latest value is sent 40 ms after the last write, never dropped; a write over the rate cap is deferred and logged as `cap` |
| `currentMedia.setItemInfo` | 8 | `denied` |
| `mediaCollection`, `cdromCollection`, `dvd`, `playlistCollection` | 7-20 skins | inert stub objects |

**D6.6 `res://` and wmploc** (`realm/wmploc.js`) implements `wmploc 7` exactly: the resolver
(module `wmploc`, `wmploc.dll` or `-`; types `RT_TEXT RT_STRING RT_IMAGE RT_BITMAP` or none;
runtime-built ids), the library registry (#132 seeded before scripts; #169 `sprintf` family, the
DLL's replace-all variant; #134 and #136), and a **re-authored** English string table for the 47
corpus ids (Microsoft's labels cannot ship; format templates such as `%1 / %2` stay as format
syntax). `RT_IMAGE`/`RT_BITMAP` resolve to a transparent image of the documented size plus a
diagnostic.

**D6.7 Coverage ledger.** Every `stub`, `denied`, `unknown-member`, `unknown-tag`,
`unresolved-binding`, `unresolved-res` and soft-fault site is recorded once per `(skinSha, api)` by
`model/ledger.js`. `tools/scan-api.mjs` ranks object-model members, `#132` names and element methods
across the local corpus into `docs/coverage/api-frequency.csv` (names and counts only), and stubs are
implemented in rank order (`notan Q3`). `tools/corpus.mjs` loads every distinct skin through the test
host and renders `docs/coverage/ledger.md`. Coverage is measured, never asserted.

### D7. Windows

**Position.** A `SkinWindow` abstraction (§5.7), frozen in phase 1 with one binding, `native`: one
Tauri `WebviewWindow` per WMP VIEW, one engine instance per webview. Phase 1 adopts the existing
`main` window and opens nothing else. A `cluster` binding (several logical windows in one host
window) is reserved for phase 2 and decided with Webamp code in hand (`notan Q1`).

Why native windows for WMP views: views are top-level windows in WMP (`spec 2.1` step 7); 52% of
distinct skins have several views, up to 9 (`survey 1.1`); per-view Keep on Top is native WMP
behaviour and the window menu already expresses it; and a webview per view is its own fault domain
and its own script scope. Cost: one WebContent process per open view (measured in phase 3).

**D7.1 Per-window click-through** (`headcore::hit`; glue `src-tauri/src/hit_cmds.rs` at the re-pin;
replaces `clickthrough.rs`):

```rust
pub enum Shape { Bits { w: u32, h: u32, bits: Vec<u8> }, Regions(Vec<Region>) }
pub struct Region { x: f64, y: f64, w: f64, h: f64, poly: Option<Vec<f64>> }
pub struct WindowHit { shape: Option<Shape>, zoom: f64 }
pub struct HitTable { windows: HashMap<String, WindowHit>, capture: Option<String> }
impl HitTable {
    pub fn set_shape(&mut self, label: &str, shape: Shape, zoom: f64);
    pub fn set_capture(&mut self, label: &str, on: bool);
    pub fn remove(&mut self, label: &str);
    pub fn want_ignore(&self, label: &str, x: f64, y: f64) -> bool;   // window-local logical px
}
pub fn decode_bits_body(body: &[u8]) -> Result<(Shape, f64), String>; // u32 w, u32 h, f64 zoom, bits
```

```rust
#[tauri::command] fn hit_set_bits(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String>;
#[tauri::command] fn hit_set_regions(window: WebviewWindow, regions: Vec<Region>, zoom: f64);
#[tauri::command] fn hit_capture(window: WebviewWindow, on: bool);
// legacy, kept until cutover as wrappers onto the caller's entry:
#[tauri::command] fn set_hit_mask(window: WebviewWindow, width: usize, height: usize, bits: Vec<u8>, zoom: f64);
#[tauri::command] fn set_capture(window: WebviewWindow, on: bool);
```

- **Commands take `window: WebviewWindow` and act on the caller's label.** No label argument exists,
  so no page can set another window's shape or capture.
- `capture` names one window instead of a global `AtomicBool`. Today any slider drag in any window
  makes every window clickable and steals clicks meant for windows beneath (`notan Q1(a)`,
  `click:45-77`). Now only the capturing window is forced clickable.
- The poll thread iterates registered windows every 16 ms, and every 8 ms while two registered frames
  intersect. Entries drop on `WindowEvent::Destroyed`. An NSEvent monitor is considered only if
  misroutes reproduce (`notan Q1`).
- `Regions` serves phase 2 (Webamp rectangles plus `region.txt` polygons, `webamp 2`). It costs about
  30 lines of point-in-polygon now, and doing it in phase 1 keeps the module from being reopened.
- `None` (no shape yet) keeps the window clickable, as today. The JS side never sends a shape with
  popcount below 64 (D2), so a skin cannot make itself unreachable.

**D7.2 Labels.** Phase-3 secondary windows are labelled `skin-<sha12>-<n>`, never from skin-controlled
strings (a VIEW id in a label risks invalid-label errors, collisions and capability-glob surprises).
`capabilities/default.json` grows to `"windows": ["main", "skin-*"]` in phase 3.

**D7.3 `view.width`/`view.height`.** Phase 1 keeps the owner's recorded decision `parity` D13: writes
update the model (Headspace sets 549/760 and reads them back) and call `requestSize`, which returns
`false`. The window stays 760×394 and the mask makes the unused strip click-through. Phase 3 adds a
**per-session resize policy** (cand-D): `honor` by default, the window resized with its top-left
anchored and children re-placed by alignment; a sidecar can pin `ignore`, and the Headspace sidecar
does, so its parity states stay comparable. Resizes are clamped to the view-size cap (§10). cand-F's
"honour by default in phase 1" is rejected: it changes a recorded parity decision without owner
sign-off.

**D7.4 Initial size.** At attach, the host sizes the window to the VIEW's size × zoom before the first
frame. That is not a script write, so D13 does not apply. For Headspace it is a no-op (760×394); it is
what lets the optional R1/R2 rungs show at their own size. "Sized before show" for new windows
(`parity 3.5`) comes with the phase-3 window factory.

**D7.5 Drag.** The picker's `chrome` role calls `SkinWindow.startDrag()` (Tauri `startDragging`),
replacing `draggable()`, `headAlpha` and the two root handlers (`main:42-48`, `main:189-232`).

**D7.6 Persistence.** Per `SkinWindow.key` (`<sha256>/<viewId>`): zoom, Keep on Top, Show on All
Desktops, and (phase 3) position, in the `app` prefs namespace. The main window keeps `center: true`
in phase 1, as today. In phase 3 the main view restores first and secondary views are clamped to
visible monitor frames (`notan Q1(e)`).

**D7.7 Room for the Webamp cluster.** Webamp lays out main, equalizer, playlist and Milkdrop inside
one container with its own docking (`webamp 2`). The cluster binding is one native host window whose
shape is `Regions` (each Webamp window's rect clipped by its `region.txt` polygons, plus the context
menu's rect) and whose `root` is Webamp's container. Whether that window is screen-sized or
bounding-box-sized is a phase-2 decision. The only expected phase-2 extension is
`SkinWindow.subWindows?(): {id, rect}[]` for persistence; snap and dock hooks are an explicit phase-2
contract extension.

### D8. Engine/host boundary

**Position.** `src/engine/` is a Tauri-free package with one entry point, `createEngine(host,
opts)`. Everything platform-specific comes through `HostAdapter` (§5.8). Two adapters exist:
`src/hosts/test/` (built first, the harness's host, runs in Node and Chromium) and `src/hosts/tauri/`.
The repo stays plain JavaScript; `src/engine/contracts.d.ts` is the single source of types, and every
module carries `// @ts-check`.

**Enforcement** (`tools/check-boundaries.mjs`, run by `npm run check`):

1. No import under `src/engine/**` starts with `@tauri-apps/` or resolves into `src/app/`,
   `src/hosts/`, `src/main.js`, `src/widgets.js`, `src/player.js`, `src/playlist.js`, `src/viz/`.
2. Allowed bare imports under `src/engine/**`: `fflate`, `jpeg-js`, `quickjs-emscripten-core`,
   `@jitl/quickjs-wasmfile-release-sync`, `@jitl/quickjs-ng-wasmfile-release-sync`.
3. No occurrence under `src/engine/**` of `fetch(`, `XMLHttpRequest`, `WebSocket`, `importScripts`,
   `eval(`, `new Function`, `Function(`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
   `document.write`, `__TAURI`, `localStorage`, `sessionStorage`, `indexedDB`. The one exemption is
   `src/engine/realm/prelude.js`, whose content is realm source shipped as a string.
4. `src/hosts/test/**` must not import `@tauri-apps/*`.
5. The pure directories (`archive`, `text`, `wms`, `image/decode`, `image/keying.js`,
   `image/probe.js`, `realm`, `model`, `layout`, `bind`, `anim`, `input/picker.js`, `shape`) must not
   reference `document` or `window`, so they run under Node in vitest.
6. `--self-test` runs the checker over `tools/check-boundaries.fixtures/`, which plants one violation
   per rule, and fails unless every one is caught.

Plus `tsc --noEmit -p tsconfig.check.json` (`allowJs`, `checkJs`, `strict` off, `noImplicitAny` off)
over `src/engine/**`, `src/hosts/**` and `src/app/**` against `contracts.d.ts`. This is how a Sonnet
task proves it implemented the interface it was given. `contracts.d.ts` is owned by Opus; a task
that needs a change stops and returns to O.

**TestHostAdapter** (`src/hosts/test/`): a manual clock (`advance(ms)` runs frames in 16 ms steps and
fires timers in order; `now()` is frozen between advances); a scripted fake `MediaModel` with the
`parity 4.1` presets (`stoppedEmpty`, `stoppedQueue5`, `stoppedQueue12`, `playing`), a call log and
`emit(changes)`; in-memory prefs with `seed(ns, entries)`; a fake `DspPort`; silent or replayed audio
frames; a `TestSkinWindow` over a harness `div` that records every `setShape`, `setCapture` and
`startDrag`; an inline decode executor; slots with a stub effects control (black canvas, the five
preset titles in `viz:23` order) and an injected playlist-widget factory; recording `actions` and
`log`. With `window` and `slots` omitted it runs headless in Node.

### D9. Oracle and tests

**Position.** `skinlab` (`tools/skinlab/`) drives **pinned Playwright Chromium**: `playwright-core@1.63.0`
and the Chromium revision it installs with `npx playwright install chromium`. System Chrome is never
used for goldens (cand-D's auto-updating Chrome would drift goldens on minor versions). It captures
the **legacy hand port** in the parity states as goldens, renders the engine through the
TestHostAdapter, and diffs per `SkinWindow` for pixels and hit mask.

- **Clocks.** Legacy capture runs on real time (its CSS transitions and timers) and settles on
  `transitionend` + 200 ms + two rAF; its mask is the **last** `set_hit_mask` recorded at that point
  (the legacy does not refresh the mask on vis-drop open, `parity` D33, so S4 keeps S1's mask). The engine runs on the
  test host's manual clock: after each input, `advance(500)` in 16 ms steps, then
  `runtime.settled()`. **skinlab never calls `page.clock.install`**, so `performance.now`, which the
  realm budget uses, stays real.
- **Legacy mounting** with zero edits to pinned files: `tools/skinlab/vite.config.js` resolves the
  absolute `src/viz/index.js` to `viz-stub.js` (the same API: black 216×158 canvas, the five titles,
  `step`, `setPalette`, `renderer` no-ops; no WebGL); `tauri-stub.js` installs
  `window.__TAURI_INTERNALS__` with `parity 4.1`'s canned replies (`mpd status` per state,
  `currentsong` empty, `playlistinfo` five or twelve records in state 3/3b, `engine_info` ok,
  `palette` rejects) and records `set_hit_mask`, `set_capture`, `set_eq` and `set_balance`;
  `localStorage` is seeded with `eq` zeros, `balance` 0 and `preset` 1 (Chorus).
- **Input.** States are reached by real Playwright mouse clicks in skin coordinates, identical for
  both targets, then the pointer parks at (755, 390), a transparent pixel. Viewport 760×394 plus
  margin; `deviceScaleFactor` 1 and 2; no focus ring.
- **Fixture.** `SKINLAB_HEADSPACE` (default `~/Downloads/Headspace.wmz`) must have sha1 `f9671f06…`,
  or the run exits 2. If it is absent, or Chromium is not installed, the run exits **77 (skip)**.
  `prepare` runs `python3 -I tools/convert_skin.py` to generate the legacy's gitignored `public/skin/`
  when its stamp is stale.

**States.**

| State | Setup | Notes |
|---|---|---|
| S1 closed | load | |
| S2 EQ open | click the EQ handle centre (224, 185) | |
| S2b | engine only: `inspector.callGlobal('ToggleEqView')` | must equal S2 pixel- and mask-exactly (the skin's own code path) |
| S3 PL open | media `stoppedQueue5`; click the PL handle centre (532, 184) | |
| S3b | media `stoppedQueue12`; same click | covers the Win2000 scrollbar |
| S4 vis open | click the transport's vis element at (440, 44) | |
| S5.e.h / S5.e.d | hover / press each transport element and both min/close elements | supplemental (`parity 4.6`) |
| S6 playing | media `playing`, elapsed 0 | pause over play; stop in its up layer |
| S7 mid-animation | 60 ms after the EQ click | report-only (EQ ear x ≈ 103) |
| S8 press-release outside | in-app only, manual | D30 capture |

**Two engine configurations** (cand-F's measurement idea). `faithful` ships. `oracle-compat` flips
exactly the switches that correspond to allow-list entries (`showBackgroundDefault: true`,
`buttonKeyedPixelsHit: false`) and applies the sidecar's `compat` block (reset `top` 129, preset
title `fontSize` 7 pt = 9 px). `sliderGeometry` is `'oracle'` in **both**. Gates:

1. **compat**: zero differing pixels outside the effects-hole exclusion, at DPR 1 and 2, in S1, S2,
   S2b, S3, S3b, S4; mask XOR exactly the `D11-screen-corners` set (106 bits).
2. **faithful**: every differing pixel lies inside an allow-list entry, and **no entry absorbs more
   than its bound** (drift guard); the mask XOR lies inside `D11-screen-corners ∪
   button-transparency`, each within its bound.
3. **S2 == S2b** in both configurations.
4. Supplemental S5 and S6 in `faithful` within the allow-list.

Because the paint and hit planes are separate (D2), compat can paint the unowned BUTTONGROUP pixels
and still keep them out of the hit plane; that is what makes gate 1 reachable.

**What is compared.** Per state, DPR and `SkinWindow` rect (phase 1 has one; keying by window lets a
5-view skin or the Webamp cluster reuse it, `notan Q1`): (1) pixels: `page.screenshot({clip,
omitBackground: true})` RGBA, compared exactly, premultiplied (two alpha-0 pixels are equal), outside
the exclusion; (2) the hit mask: legacy is the last recorded `set_hit_mask`, engine is
`runtime.maskShape()`, compared as XOR in skin px. The report goes to the skinlab output directory:
`legacy.png`, `engine.png`, `diff.png` and `report.json`, with the differing-pixel count, bounding
boxes per connected component, and per allow-list entry the absorbed count against its bound (an
entry absorbing 0 is reported, so stale entries surface).

**Goldens: content-addressed, outside git** (cand-S plus cand-D).

- Store: `~/Library/Caches/window_headmpd/skinlab/` (outside the repo, so `git add -A` cannot catch
  art). Run output: `~/Library/Caches/window_headmpd/skinlab/out/<run>/`.
- Key: SHA-256 of canonical JSON `{target, state, dpr, skinSha256, oraclePin, chromiumRevision,
  harnessVersion}`, where `oraclePin` hashes the bytes of the pinned files in a fixed order.
- Committed: `tools/skinlab/goldens.manifest.json`, mapping each key to `{pngSha256, maskSha256,
  popcount, bbox, provenance}`. These are facts about the art, like the hashes in `parity`.
- `check` recomputes the key. If the local golden is missing it re-captures from the legacy and
  **verifies the PNG and mask hashes against the manifest** before use; a mismatch is a hard failure
  ("oracle drift").
- `bless --target legacy --reason "…"` is the only way to change the manifest. It refuses when the
  oracle pin differs from the manifest's, unless `--repin` is given, and it records the reason and the
  old hashes. Implementing tasks never bless; Opus does.
- **After cutover** (cand-D): the cutover commit is preceded by the tag `oracle/headspace-v1` at the
  last commit containing the hand port. `bless --from-tag oracle/headspace-v1` checks the tag out
  into a temporary `git worktree` (with `npm ci` there) and captures from it. The result must
  hash-equal the manifest. The legacy oracle stays reproducible without living in the tree.

**What Chromium cannot see.** skinlab runs in Chromium with a Tauri stub, so Rust code (hit, fan-out,
prefs, skins) and the CSP never execute there. The re-pin batch's "legacy goldens still reproduce"
check guards only the JS-pinned files. Two more gates cover the rest:

- **Report-only WebKit pass**: `skinlab check --browser webkit` (Playwright WebKit) at the parity
  gate. Any difference beyond the Chromium pass is investigated, not waived.
- **G-WK, the in-app gate (O, cutover criterion)**: both renderers in the real app, in the same
  WKWebView, which is what `parity 4.1` actually specifies ("both renderers run in the same WebKit
  instance"). Run the app on the legacy flag and on the engine flag, drive S1 to S4 by clicking the
  same points, capture the window with `tools/window-bounds.swift` + `screencapture -l <id> -o`, and
  diff with `skinlab diff --files a.png b.png` and the same allow-list. The in-app smoke checklist
  (WAVES W5.2) covers the Rust paths.

**Unit and corpus tests.**

- `npm test` runs vitest over every pure module with **synthetic, own-authored fixtures** generated by
  test code: BMPs of every depth and compression (`tests/support/bmp-writer.js`), PNG and GIF writers,
  a zip writer with malicious variants (traversal, absolute, drive letter and NUL names; symlink
  entries; a 10 KB→4 GB bomb header; corrupt local signature; ZIP64; encrypted), `.wms` strings for
  each XML failure class of `survey 2.2`, and each gotcha G1-G27 that is not art.
- `npm run corpus -- <suite>` runs the corpus suites (`zip`, `parse`, `images`, `scripts`, `build`,
  `layout`, `load`) over `skins/wmp` and `skins/wsz`, pinned by `tests/corpus.manifest.json` (name →
  SHA-256, committed). They skip when `skins/` is absent and print the counts their acceptance
  quotes; those counts are committed under `docs/coverage/` as numbers only.
- `tests/headspace/*` assert Headspace facts (keying equality, `parity 0.4`/`0.5` geometry, paint
  order, the script surface), skipping without the fixture.
- Skinlab `fixtures` render synthetic skins built by test code and compare against expected pixels
  computed from fixture data, not from art.
- Fixture ladder (`survey 6`): R0 Headspace is the phase-1 parity target. R1 Miniplayer and R2 aoe are
  an optional phase-1 wave (behaviour scripts plus self-blessed regression goldens). R3 to R9 are
  phase 3. The negative pack (`survey 6.1`) runs in the `zip`, `parse` and `load` suites.

**How a Sonnet implementer self-checks** (every task card names which of these must exit 0):

```
npm test -- <path-or-pattern>             # vitest, Node, synthetic fixtures; no art needed
npm run check                             # boundary checker + tsc --checkJs
npm run corpus -- <suite>                 # corpus suites; skip when skins/ is absent
npm run skinlab -- check --config compat|faithful --state S1[,S2…] --dpr 1[,2]
npm run skinlab -- fixtures --area <area> # synthetic DOM rendering tests
npm run skinlab -- verify-legacy          # oracle drift check
cargo test --manifest-path src-tauri/Cargo.toml -p headcore
```

skinlab exit codes: 0 pass, 1 fail, 2 usage error or wrong fixture, 77 skip.

### D10. App features around any skin

All of this lives in `src/app/` (Tauri-aware), never in the engine. The engine exposes slots, element
rects, globals and actions; the shell decides what to do with them.

**D10.1 Window menu.** Right-click, Control-click or Option-click opens a native menu built per
window: Keep on Top, Show on All Desktops, separator, Larger/Normal Size, separator, Reload Skin, and
(Option held) "Use Legacy Headspace"/"Use Skin Engine" until cutover. Phase 2 adds Skin ▸ (imported
skins, Import Skin…). **Skin first, host second** (`parity` D8): a right press whose picked element
has an `onmousedown`, `onmouseup` or `onclick` handler goes to the skin (`event.button = 2`) and no
menu opens; otherwise the host menu opens. Control-click and Option-click are captured before the
picker (as `main:526-535` does) and always open the menu.

**D10.2 Effects host, visualizer, palette.** `src/app/viz-host.js` implements the `effects` slot: it
creates a canvas in the slot and `new Viz(canvas, onPresetChange, captionEl)` from the unchanged
`src/viz/index.js`. With Rust fan-out (D11) each `Viz` gets its own frames. Its `EffectsControl` maps
the EFFECTS element's `currentPreset`, `currentPresetTitle`, `next()`, `previous()` and
`mediacenter.effectPreset` onto `viz.index`, `viz.current.title` and `viz.step(±1)`. A click on an
EFFECTS element with no `onclick` steps to the next preset (`parity` D25; `WMPEFFECTS`' own default is
`onclick="next();"`, `spec 6.14`). The viz pixel ratio is reset on zoom (`main:369-370`). VizHost
reads `PaletteService` and calls `viz.setPalette` on change, keeping the stale-result guard of
`main:439-445`.

**D10.3 Overlays.** The track toast (`parity` D4), the notice ("Waiting for MPD…" or the routing error,
D5) and the caption (D6) mount **inside the EFFECTS slot**, above its canvas, so the containing
subview's clip mask clips them too (`parity` D26). Their CSS is copied pixel-for-pixel from
`css:137-188` into `src/app/overlays.css`, scoped under the slot. The notice colour comes from the
sidecar, else the skin's first TEXT `foregroundColor`. A skin without EFFECTS gets no toast, and the
notice becomes the window menu's first (disabled) item.

**D10.4 Playlist widget.** `src/app/widgets/playlist.js` is a new port of `src/playlist.js` (the pinned
file stays untouched) that takes a `MediaModel` and a slot element and honours `backgroundColor`,
`foregroundColor`, `columnsVisible`, `dropDownVisible`, `playlistItemsVisible`, `itemPlayingColor`,
`itemSelectedColor` and `itemSelectedBackgroundColor`. Its CSS is the hand port's (`css:206-368`)
scoped under the slot, so S3 compares pixel-for-pixel (`parity` D12). The document-level `pointerdown`
that closes the combo list (`playlist.js:95`) becomes a listener on the window root. The open combo
list reports its rect through `SlotHandle.onHitRectsChange`, so the mask includes it.

**D10.5 Keyboard.** The focused element's, then the VIEW's `onkeydown`/`onkeypress`/`onkeyup` run first
(`spec 6.2`: 518 VIEWs have `onKeyPress`). If no skin handler ran for the event, the shell defaults
apply: Space toggles, ←/→ seek ±5 s, ↑/↓ volume ±5, V next visualization (`main:471-483`). Defaults
now **ignore events with Cmd, Ctrl or Alt held** and **do nothing to volume when MPD reports no
mixer**, fixing both slips `parity` D9 lists.

**D10.6 Sidecars** (`src/app/sidecars/<sha256>.json`, committed: our own data keyed by the archive
hash, schema-validated by `src/app/sidecar.js` before use, refs stored in Maps):

```json
{
  "schema": "window_headmpd-sidecar/1",
  "skin": "76a8662f469881bf5ed6eb93595042fdb188c65663135da6ff4dcd10b37bf85d",
  "overlays": [ { "parent": "sEqView", "tag": "text",
                  "attrs": { "left": 9, "top": 121, "width": 15, "value": "32", "fontSize": 5,
                             "foregroundColor": "#77CE07", "justification": "center" },
                  "hostStyle": { "letterSpacing": "<from css:105-113>" } } ],
  "attrs":   [ { "ref": "seek", "name": "x-foregroundMode", "value": "playhead" } ],
  "compat":  { "attrs": [ { "ref": "Unnamed_text_4", "name": "top", "value": 129 },
                          { "ref": "Unnamed_text_1", "name": "fontSize", "value": 7 } ] },
  "actions": { "returnToMediaCenter": "zoomToggle" },
  "restore": [ { "global": "eqIsOpen", "toggle": "ToggleEqView", "pref": "eqOpen" },
               { "global": "plIsOpen", "toggle": "TogglePlView", "pref": "plOpen" } ],
  "viewResize": "ignore",
  "tour": { "transport": "Unnamed_buttongroup_2", "playColor": "#FFFF00", "visColor": "#0000FF",
            "eqHandle": "bEqHandle", "plHandle": "bPlHandle", "visNext": "Unnamed_button_4",
            "reset": "Unnamed_text_4", "bands": ["eq1", "…", "eq10"],
            "toggle": { "eq": "ToggleEqView", "pl": "TogglePlView", "vis": "ToggleVisView" },
            "isOpen": { "eq": "eqIsOpen", "pl": "plIsOpen", "vis": "visIsOpen" } }
}
```

- `overlays` reproduce the EQ frequency labels (`parity` D1) as trusted TEXT elements appended to a
  subview after the literal pass. Labels are 7 px = `fontSize` 5 pt by the `round(pt·4/3)` rule.
  `hostStyle` is a small allow-list (`letterSpacing` only) for oracle CSS with no WMS attribute. Any
  skin can get labels this way.
- `attrs` set attributes on named elements in both configs: ordinary WMS attributes (G3: the Headspace PLAYLIST colours the oracle paints) and host-only ones (prefixed `x-`, accepted only from sidecars). `x-foregroundMode:
  playhead` reveals the seek foreground to the thumb centre instead of `foregroundProgress`, without
  constraining the thumb (`parity` D2), for this skin only.
- `compat` applies only under `oracle-compat`.
- `restore` keeps the owner-visible drawer restore (`parity` D23, classified HOST). After every
  dispatch, the shell reads each `global` (a cheap primitive read) and persists changes under `pref`
  in the `app` namespace. After `onload`, it calls each `toggle` whose pref is true (animated, as
  today). cand-D dropped this behaviour; this design keeps it without engine special-casing.
- Ids filled at G2 from the builder (per-kind numbering): transport `Unnamed_buttongroup_2` (the minimize/close group is `_1`), pause `Unnamed_button_1`, vis-drop prev/next/close `Unnamed_button_3/4/5`, preset title `Unnamed_text_1`, reset `Unnamed_text_4`.
- Balance detent and volume debounce are host-wide behaviours (D6), not sidecar data.

**D10.7 Demo tour.** The demo becomes a generic **driver** (`src/app/demo/driver.js`: cursor glide,
synthetic pointer events, flash and `record_*` timing, copied from `demo.js`) and a **Headspace
choreography** (`src/app/demo/headspace.js`) that uses only a `DemoTarget`:

```ts
interface DemoTarget {
  root(): HTMLElement;                         // the engine's div.view (scale transform origin)
  zoom(): number;
  clientPoint(ref: string, fx?: number, fy?: number): { x: number; y: number } | null;
  groupPoint(groupRef: string, mappingColor: string): { x: number; y: number } | null;  // centroid of owned px
  sliderThumbPoint(ref: string, value: number): { x: number; y: number } | null;      // replaces 5.5 + (1-f)*65
  call(fn: string, ...args: Wire[]): Wire;     // ToggleEqView etc.
  get(name: string): Wire;                     // eqIsOpen etc.
  attr(ref: string, name: string): Wire;       // band values
  setAttr(ref: string, name: string, v: Wire): void;  // stage setup (eq gains via eq.gainLevelN)
  media: MediaModel; effects: EffectsControl;
}
```

`src/app/demo/target.js` builds it from `ViewRuntime.inspector`. The `37/144` and `131/144` fractions
become `groupPoint(transport, '#FFFF00' / '#0000FF')`, and the travel-65 band math becomes
`sliderThumbPoint`. Synthetic `PointerEvent`s still go to `document.elementFromPoint`, which returns
the input plane, so the picker handles the tour as it handles a real mouse. The fake cursor (z 1000)
and flash (z 2000) stay above everything, and the `body.demo` cursor rule moves to `src/app/app.css`.
The `mpd-message` trigger is wired in the shell. `src/demo.js` stays pinned and untouched; it is
deleted with `main.js` at cutover (its only importer), so the `widgets.js` import never dangles.
Acceptance: the tour runs headless in skinlab against the engine with a scripted clock, and its
`MediaModel` call sequence and `set_eq` values equal the legacy run's.

**D10.8 Robustness.**

- **Fault panel** (`src/app/fault-panel.js`): on unload, a host-drawn panel in the window root ("This
  skin stopped: <reason>") with Reload skin, Choose another skin (phase 2), and Use legacy Headspace
  (until cutover). The window menu keeps working, and the shape includes the panel.
- **Safe-mode boot**: AppShell writes a `boot.pending` marker to the `app` namespace before loading a
  skin and clears it 10 s after the first frame. If the marker is still set at the next launch, or
  Shift is held at launch, the shell skips the skin and shows the fault panel. A skin that crashes
  the WebContent process, or loops at every launch, cannot lock the owner out.
- **Legacy prefs migration** (`src/app/migrate.js`): on the first engine boot, legacy `localStorage`
  keys (`zoom`, `eq`, `balance`, `eqOpen`, `plOpen`, `onTop`, `allDesktops`, `preset`) are copied
  into the `app` and `mediacenter` namespaces once. Host code may use `localStorage`; the engine may
  not.

**D10.9 Coexistence and cutover.** Coexistence is `src/entry.js` (section 2). **Cutover** (deleting
`main.js`, `widgets.js`, `playlist.js`, `demo.js`, `style.css`, the legacy branch of `entry.js`,
`public/skin/` generation and the offline keying in `convert_skin.py`, which keeps only its icon step)
happens when all of these hold:

1. skinlab gates 1 to 4 of D9 pass at DPR 1 and 2, with only the allow-list of §9.
2. The report-only WebKit pass shows nothing beyond the Chromium pass, or every extra difference has
   an Opus finding.
3. **G-WK passes**: legacy and engine in the real app, S1 to S4, diffed with the same allow-list.
4. The in-app smoke checklist passes (WAVES W5.2), including S8 (press-release outside the window)
   and slider capture.
5. The demo tour passes its headless acceptance, and the owner records a video on the engine.
6. The corpus run (`skinlab corpus`) over all 195 distinct WMP skins has **zero uncaught host
   exceptions and zero renderer crashes**, and a non-empty first frame for every skin that loads.
   Realm hard faults on the long tail are reported, not blocking; R0 to R2 must have none.
7. Owner dogfooding on the engine flag for a period the owner chooses, with no fault unloads and no
   stuck capture.
8. The tag `oracle/headspace-v1` exists, and `bless --from-tag oracle/headspace-v1` reproduces every
   manifest hash.
9. Opus signs off the ledger and the allow-list.

### D11. Audio-side changes

| Change | Phase | Where | Signature |
|---|---|---|---|
| **Frame fan-out** | 1 (logic in `headcore::fanout` in wave 1; wired at the re-pin) | `headcore::fanout`, `audio.rs`, `lib.rs` | `audio_subscribe(window: WebviewWindow, on_frame: Channel<Frame>, opts: Option<SubscribeOpts>) -> u64`; `audio_unsubscribe(id: u64)`. Each frame goes to every subscriber; a send error drops that subscriber; a destroyed window drops its subscribers. The old call shape `audio_subscribe({onFrame})` (`viz:55-57`) still works, so the pinned `viz/index.js` needs no edit. Fixes `parity 3.2`'s "a second `Viz` steals the feed". `headcore::fanout` is generic over a `FrameSink` trait, so it has no Tauri dependency. |
| EQ clamp | 1: unchanged | `eq.rs` | ±14 dB stays (Headspace's sliders are −14..14). cand-F's phase-1 widening to ±20 is rejected as an unneeded audio-path change. |
| **EQ profile** | 2 | `eq.rs` (`Coeffs` becomes a `Vec`) | `set_eq_profile(profile: EqProfile)` with `EqProfile { centres_hz: Vec<f32> /* 1..=16 */, q: f32, min_db: f32, max_db: f32, has_preamp: bool }`. WMP = 31…16 kHz, Q 1.41, ±14 (today's `eq.rs:7-14`; ±20 per `spec 6.16` only if the owner asks); Winamp = 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k Hz, ±12 dB plus preamp ±12 dB (`webamp 1.6`). `set_eq(gains: [f32; 10])` stays as the WMP shim. The profile comes from `HostedSkin.capabilities.eq`. |
| **Preamp, bypass** | 2 | `eq.rs` | Preamp is a gain stage before the biquads, inside the soft clip (`eq.rs:116`). Bypass skips the biquads and keeps balance. WMP `eq.bypass` defaults to false (D6). |
| **PCM in `Frame`** | 2 | `audio.rs` | `Frame { bands, wave, level, #[serde(skip_serializing_if = "Option::is_none")] pcm: Option<Vec<u8>> }`: the latest 1,024 samples, mono, `u8` centred on 128, computed only while a subscriber asked for it (Webamp's analyser and the butterchurn facade, `webamp 1.5`; about 61 KB/s at 60 Hz). |
| Balance | unchanged | `set_balance` | The ±5 detent is a host binding rule (`parity` D17); Webamp's ±25 detent applies only inside Webamp. |

The DSP band centres versus the Headspace labels (31 vs "32", 62 vs "63", `parity` D1) stay as they
are; that is an owner decision, not a parity change.

### D12. Phase-2 seam: `SkinHost`, and where the palette lives

**`SkinHost`** (§5.10). `src/app/skin-registry.js` opens every archive with the engine's `openVfs`,
so **every family passes the same zip caps**, then asks each registered host for `canLoad(vfs)` and
loads with the best. `WmsSkinHost` is the `Engine` behind this interface (`LoadedSkin` and
`ViewRuntime` extend `HostedSkin` and `HostedView`). `HostedSkin.capabilities` makes the family
differences explicit up front: `eq` profile, `wantsPcm`, `windowModel` (`native-per-view` or
`cluster`) and `scripted`. `HostedView` carries cand-D's `query()` (via the inspector) and
`settled()`, so one skinlab driver serves both families. `MediaModel`, `DspPort`, `AudioFrameBus`,
`PrefStore`, `PaletteService` and `WindowManager` are written once and shared.

**Seam freeze.** At the end of phase 1, Opus reviews the contracts against Webamp's needs (`webamp 2`,
`webamp 4`) and maps each to a v1 member or a named phase-2 extension (cand-D W6.4). Expected
extensions: `SkinWindow.subWindows`, snap/dock hooks, `HitShape.regions` (already present).

**What phase 2 adds behind it** (`src/skinhosts/webamp/`, same boundary rules as the engine):

- `webamp/lazy`, dynamically imported only when a `.wsz` is chosen (`webamp 3`: 191,751 B gzip without
  butterchurn), pinned to `webamp@2.3.1`. All private-API use (`__customMediaClass`,
  `__customMiddlewares`, `__initialState`, raw action names) goes through one module with a boot-time
  self-test (the spike's probe 1) that fails closed.
- An `IMedia` implementation over `MediaModel` with echo and idempotence guards; the queue from
  `__initialState` plus `plchanges` diffs; playlist, shuffle and repeat actions swallowed by a
  middleware and turned into typed `MediaModel` calls.
- Archive: the canonical re-zip of the validated VFS, as a `blob:` URL (D4). The CSP's `connect-src`
  gains `blob:` in phase 2.
- **Webamp runs in the page realm.** Phase 2 therefore (a) replaces raw `mpd` passthrough reachable
  from that webview with the typed command set, (b) gives the Webamp window a capability file that
  excludes `record_*` and the skin import commands, and (c) relies on the phase-1 `mpd` verb
  allow-list (§10) as the backstop.
- Window: the cluster binding (D7.7). Audio: `AudioFrameBus.subscribe({pcm: true})`. EQ:
  `capabilities.eq` = the Winamp profile.
- Tests: the Webamp museum screenshot per `skins/wsz` skin as the oracle (`wsz 6` item 10), diffed by
  the same skinlab code per window rect, kept out of git. Butterchurn presets may need
  `'unsafe-eval'`; that is decided in phase 2 and scoped to the Webamp window if needed.

**`PaletteService`** (§5.9) lives host-side in `src/app/palette/`; engines and skin hosts receive it
through `HostAdapter.palette` and never read files.

- **Phase 1** builds the interface plus the `local` tier (today's Rust `palette` OKLab k-means over
  the cover, `lib.rs:162-201`, as `clusters`, with `roles: null` and `guarantees: []`) and the
  `default` tier (the hand port's red-to-violet, `viz:18`). VizHost consumes it, so the visualizer
  behaves exactly as today.
- **Phase 2** builds the `artifact` tier as the third conformance consumer of `notan-palette/1`
  (`notan Q2`), with the contract owner's review: a Rust watcher (`notify`) attached to the parent
  directory of `$XDG_CONFIG_HOME/rmpc-auto-theme/palette/palette.json`, or `MUSIC_UI_PALETTE_PATH`
  (an invalid value disables the artifact source with a diagnostic, never a fallback path), before the
  first read; a JS decoder porting grisaille's consumer semantics (the retention triple
  latestAttempt/candidate/retained, where failures never adopt or relabel retained colours;
  serialized reads with one dirty follow-up; reattach at 1, 2, 4, 8, 10 s, continuing at the cap);
  the vendored synthetic fixture set pinned by checksum, additive only; one adoption per song change
  when local and artifact both land. `roles` is all nine v1 keys verbatim or null, never partial and
  never renamed; `guarantees` is `verified_pairs` verbatim or `[]` (only an exact-lookup helper, no
  inferred pairs); `association` never claims "now playing". We never publish our local extraction
  as an artifact.
- Engine adapters map their colour slots to roles with per-slot fallbacks (the Headspace preset
  gradient now, Winamp `viscolor`/`pledit` in phase 2, WMP colour slots in phase 3). The nine roles
  never grow.

---

## 5. Contracts (`src/engine/contracts.d.ts`)

W0.1 (Opus) writes these verbatim. Sonnet tasks implement them and may add private helpers, never
change them. Two mechanical departures in `contracts.d.ts` (G0): §5.5's `animate:
Pick<Animator, ...>` is spelled out member by member, because the §5.11 `Pick` interface shadows
TypeScript's utility type; and a type-only `Buffer` shim exists so `jpeg-js`'s typings check
(engine code still may not use `Buffer`).

Function signatures are written below as declarations for readability. In the file, W0.1 expresses
each as an exported function type (`export type ReadZipFn = (bytes: Uint8Array, caps?: Partial<ZipCaps>)
=> ZipIndex`), and each module annotates its export with
`/** @type {import('../contracts').ReadZipFn} */`, so `tsc --checkJs` proves the implementation
matches. Constants (`DEFAULT_ZIP_CAPS`, `FAITHFUL`, `ORACLE_COMPAT`, `SCHEMA`) are typed the same
way and live in their modules (`options.js` is written by W0.1).

### 5.1 Primitives and archive

```ts
export type Rgb = number;                                   // 0xRRGGBB
export interface Rect { x: number; y: number; w: number; h: number }
export type Unsubscribe = () => void;
export interface Diagnostic { code: string; detail: string; severity: 'info' | 'warn' | 'error';
  file?: string; line?: number; elementId?: string }

export interface ZipCaps { maxArchiveBytes: number; maxEntries: number; maxEntryBytes: number;
  maxTotalInflated: number; maxRatio: number; maxNameBytes: number }
export const DEFAULT_ZIP_CAPS: ZipCaps;                     // 32 MiB, 4096, 32 MiB, 256 MiB, 1024, 255
export interface ZipEntry { name: string; key: string; method: 0 | 8; csize: number; usize: number;
  crc: number; offset: number }
export interface ZipIndex { readonly entries: readonly ZipEntry[]; readonly diagnostics: Diagnostic[];
  read(e: ZipEntry): Uint8Array | null }                    // null = corrupt or over cap; never throws
export function readZip(bytes: Uint8Array, caps?: Partial<ZipCaps>): ZipIndex;   // throws ArchiveError only for not-a-zip / archive caps
export interface SkinVfs {
  readonly sha: string;                                     // SHA-256 hex of the archive bytes
  readonly name: string;                                    // archive file name, display only
  has(ref: string): boolean;
  read(ref: string): Uint8Array | null;                     // null = missing; never throws
  list(ext?: string): string[];                             // keys, e.g. list('.wms')
  resolve(ref: string): string | null;                      // ref -> key
  readonly diagnostics: readonly Diagnostic[];
}
export function openVfs(bytes: Uint8Array, name: string, caps?: Partial<ZipCaps>): Promise<SkinVfs>;
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-16le' | 'utf-16be' | 'utf-8' | 'ascii' | 'cp1252' };
```

### 5.2 Parse

```ts
export interface RawAttr { name: string; value: string; line: number }      // name lowercased, entities decoded
export interface RawNode { tag: string; attrs: RawAttr[]; children: RawNode[]; line: number }
export function scanWms(text: string): { root: RawNode | null; diagnostics: Diagnostic[] };
export function pickDefinition(vfs: SkinVfs): { wms: string; reason: 'only' | 'fewest-unresolved' | 'stem' | 'size'; unresolved: number } | null;

export type ElementKind = 'theme' | 'view' | 'subview' | 'button' | 'buttongroup' | 'buttonelement' | 'slider'
  | 'customslider' | 'progressbar' | 'text' | 'effects' | 'video' | 'playlist' | 'equalizersettings'
  | 'videosettings' | 'player' | 'controls' | 'settings' | 'mediacenter' | 'automenu' | 'listbox' | 'popup'
  | 'item' | 'editbox' | 'unknown';
export interface TagSchema { tag: string; kind: ElementKind; defaults: ReadonlyMap<string, string> }
export function resolveTag(tag: string): TagSchema;
export type AttrType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'image' | 'handler' | 'cursor' | { enum: readonly string[] };
export interface AttrSpec { name: string; type: AttrType; default: unknown; access: 'r' | 'rw' }
export function attrSpec(kind: ElementKind, attr: string): AttrSpec | undefined;
export type AttrSource =
  | { kind: 'literal'; text: string }
  | { kind: 'jscript'; source: string }
  | { kind: 'wmpprop'; path: BindPath }
  | { kind: 'wmpenabled' | 'wmpdisabled'; method: string }
  | { kind: 'res'; url: string }
  | { kind: 'handler'; source: string; params: string[] };
export interface BindSegment { name: string; args?: Array<string | number | boolean> }
export interface BindPath { root: string; segments: BindSegment[] }
export function classifyValue(kind: ElementKind, attr: string, raw: string): AttrSource;
export function parseColor(s: string): Rgb | 'none' | 'auto' | null;
export function coerce(type: AttrType, v: unknown, prev: unknown): unknown;   // U-20: invalid keeps prev
```

### 5.3 Element model

```ts
export type Origin = 'init' | 'layout' | 'script' | 'binding' | 'user' | 'anim' | 'host' | 'sidecar';
export type AttrValue = string | number | boolean | null;
export interface HandlerSite { event: string; source: string; params: string[]; line: number }
export interface ElementModel {
  readonly handle: number;                                  // > 0, stable for the session
  readonly kind: ElementKind;
  readonly tag: string;
  readonly id: string;                                      // declared id or Unnamed_<type>_<n>
  readonly parent: ElementModel | null;
  readonly children: readonly ElementModel[];
  readonly docIndex: number;
  get(attr: string): AttrValue;                             // attr case-insensitive
  set(attr: string, v: unknown, origin: Origin): boolean;   // coerces; true if changed; queues <attr>_onchange unless origin 'init'
  source(attr: string): AttrSource | undefined;
  readonly handlers: ReadonlyMap<string, HandlerSite>;      // lowercased event name
}
export interface ViewModel {
  readonly view: ElementModel;
  readonly elements: readonly ElementModel[];               // document order
  byHandle(h: number): ElementModel | undefined;
  byId(id: string): ElementModel | undefined;               // exact, then case-insensitive
  paintOrder(container: ElementModel): ReadonlyArray<ElementModel | 'background'>;
  onChange(cb: (el: ElementModel, attr: string, v: AttrValue, origin: Origin) => void): Unsubscribe;
  takeDirty(): Map<ElementModel, Set<string>>;
  takeQueuedEvents(): Array<{ el: ElementModel; event: string }>;   // the _onchange queue, FIFO
}
export interface ThemeModel {
  readonly views: readonly ViewModel[];
  readonly meta: { author: string; title: string; copyright: string; currentViewID: string | null };
  scriptsFor(viewId: string): string[];                     // scriptFile order, implicit <stem>.js last
  readonly diagnostics: readonly Diagnostic[];
}
export interface BuildCaps { maxElements: number; maxDepth: number; maxAttrs: number; maxAttrValue: number;
  maxViews: number; maxViewAxis: number }
export function buildTheme(root: RawNode, vfs: SkinVfs, opts: { probe: (ref: string) => ImageProbe | null;
  overlays?: SidecarOverlay[]; caps?: Partial<BuildCaps> }): ThemeModel;
```

### 5.4 Images

```ts
export interface ImageProbe { format: 'bmp' | 'png' | 'gif' | 'jpeg'; width: number; height: number }
export function probeImage(bytes: Uint8Array): ImageProbe | null;
export interface ImageCaps { maxAxis: number; maxArea: number; maxGifFrames: number }
export interface RgbaImage { width: number; height: number; data: Uint8ClampedArray;
  indexed?: { palette: Uint8Array; indices: Uint8Array }; frames?: { data: Uint8ClampedArray; delayMs: number }[] }
export function decodeImage(bytes: Uint8Array, caps?: Partial<ImageCaps>): RgbaImage | null;
export interface KeySpec { transparency?: Rgb | 'auto' | null; clipping?: Rgb | 'auto' | null;
  hitKeyed: boolean; clipImage?: string }                   // clipImage = VFS ref of clippingImage
export interface KeyedPlanes { width: number; height: number; rgba: Uint8ClampedArray;
  paint: Uint8Array; hit: Uint8Array; clip: Uint8Array | null }   // 1 bit per pixel, row-major, LSB first
export function keyImage(img: RgbaImage, spec: KeySpec, clipImg?: RgbaImage | null): KeyedPlanes;
export interface DecodeJob { bytes: Uint8Array; key: KeySpec; clipBytes?: Uint8Array }
export interface DecodeExecutor { run(job: DecodeJob): Promise<KeyedPlanes | null> }   // null = missing
export interface ImageService {
  probe(ref: string): ImageProbe | null;
  get(ref: string, spec: KeySpec): KeyedPlanes | null;      // sync; null until decoded or missing
  load(ref: string, spec: KeySpec): Promise<KeyedPlanes | null>;
  raw(ref: string): RgbaImage | null;                       // map images: never keyed
  pending(): number;
}
export function createImageService(vfs: SkinVfs, exec: DecodeExecutor, log: Log): ImageService;
```

### 5.5 Realm and object model

```ts
export type Wire = undefined | null | boolean | number | string | { readonly __h: number };
export interface HostDispatcher {
  get(h: number, key: string): Wire | { method: true };     // key lowercased by the proxy
  set(h: number, key: string, v: Wire): void;
  call(h: number, key: string, args: Wire[]): Wire;         // args.length <= 16
  timer(op: 'set' | 'clear', id: number, ms: number, repeat: boolean): void;
  now(): number;                                            // engine clock, ms
}
export interface RealmBudgets { scripts: number; load: number; handler: number; expr: number; exprPass: number }
export interface RealmOptions {
  viewKey: string;
  memoryLimitBytes: number;                                 // 64 MiB
  maxStackBytes: number;                                    // 256 KiB (G1)
  budgets: RealmBudgets;                                    // 2000, 1000, 100, 20, 1000 ms
  wallClock: () => number;                                  // real performance.now, captured at module load
  dispatcher: HostDispatcher;
  classMembers: ReadonlyMap<string, readonly string[]>;     // class -> lowercased members (from the schema)
  hostGlobals: Readonly<Record<'player' | 'theme' | 'view' | 'event' | 'mediacenter' | 'playerApplication', number>>; // handles
  log: Log;
  testSeed?: string;
}
export type Fault = { ok: false; kind: 'soft' | 'hard'; reason: string; site: string };
export type Ok<T = Wire> = { ok: true; value: T };
export interface Realm {
  setIds(ids: ReadonlyArray<{ id: string; handle: number; className: string }>): void;   // once per view
  loadScript(name: string, source: string): Ok<void> | Fault;
  evalExpression(el: number, attr: string, src: string): Ok | Fault;
  runHandler(el: number, site: HandlerSite, ctx?: { event?: number; params?: Readonly<Record<string, Wire>>; gesture?: boolean }): Ok<void> | Fault;
  fireTimer(id: number): Ok<void> | Fault;
  callGlobal(name: string, args: Wire[]): Ok | Fault;      // demo, sidecar restore, tests
  readGlobal(name: string): Wire;                           // primitives only
  readonly inGesture: boolean;                              // true while a pointer/key handler runs
  readonly health: { soft: number; hard: number; unloaded: boolean; dutyThrottled: boolean };
  unload(reason: string): void;                             // revoke, clear timers, discard or dispose per D1
}
export function createRealm(opts: RealmOptions): Promise<Realm>;

export type MemberImpl = 'live' | 'emulated' | 'stub' | 'denied';
export type PolicyId = 'deny-log' | 'gesture-only' | 'rate-mpd' | 'pref-caps' | 'timer-caps' | 'view-current-only';
export interface MemberSpec { name: string; kind: 'prop' | 'method' | 'event'; type: 'number' | 'string' | 'bool' | 'object' | 'void';
  access?: 'r' | 'rw'; impl: MemberImpl; changeSource?: string; stubValue?: Wire; policy?: PolicyId }
export type ClassSchema = ReadonlyMap<string, MemberSpec>;
export const SCHEMA: ReadonlyMap<string, ClassSchema>;      // 'player', 'controls', 'settings', 'media', 'network', 'playlistObj',
                                                            // 'theme', 'view', 'event', 'mediacenter', 'eq', 'vidset', 'element.<kind>', …
export interface HostObject {
  readonly className: string;
  get(member: string): Wire | { method: true };
  set(member: string, v: Wire, origin: Origin): void;
  call(member: string, args: Wire[], ctx: { gesture: boolean }): Wire;
}
export interface ObjectGraph {
  readonly globals: Readonly<Record<'player' | 'theme' | 'view' | 'event' | 'mediacenter' | 'playerApplication', HostObject>>;
  elementObject(el: ElementModel): HostObject;
  changeSource(path: string): { read(): Wire; subscribe(cb: () => void): Unsubscribe } | null;
  setEvent(ev: EventInit | null): void;
  dispose(): void;
}
export interface EventInit { x: number; y: number; clientX: number; clientY: number; offsetX: number; offsetY: number;
  screenX: number; screenY: number; button: number; keyCode: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean;
  srcElement: ElementModel | null; fromElement: ElementModel | null; toElement: ElementModel | null }
export function createObjectGraph(deps: { host: HostAdapter; view: ViewModel; theme: ThemeModel; skinSha: string;
  prefs: Map<string, string>; ledger: Ledger; opts: EngineOptions;
  animate: Pick<Animator, 'moveTo' | 'alphaBlendTo' | 'cancel'>;     // element moveTo/slideTo/alphaBlendTo
  effectsOf: (el: ElementModel) => EffectsControl | null;            // EFFECTS element objects
  inGesture: () => boolean }): ObjectGraph;                          // D6.5 gesture gating
export interface LedgerEntry { api: string; kind: 'stub' | 'denied' | 'unknown-member' | 'unknown-tag' | 'unresolved-binding'
  | 'unresolved-res' | 'soft-fault' | 'cap'; count: number; detail?: string }
export interface Ledger { record(api: string, kind: LedgerEntry['kind'], detail?: string): void; entries(): LedgerEntry[] }
export function createLedger(skinSha: string): Ledger;
export function wmplocConstants(opts?: { extras?: boolean }): Record<string, number | string[]>;
export function resolveRes(url: string): { module: 'wmploc'; type: string; id: number } | null;
export function loadString(url: string): string;
```

### 5.6 Media, DSP, audio

```ts
export interface SongInfo { id: number; pos: number; file: string; title: string; artist: string; album: string;
  genre: string; track: string; date: string; durationSec: number }
export interface MediaState {
  connected: boolean; playState: 'play' | 'pause' | 'stop';
  elapsed: number; duration: number;                        // s; elapsed extrapolated
  volume: number;                                           // 0..100, or -1 when MPD has no mixer
  random: boolean; repeat: boolean; single: boolean; consume: boolean;
  song: SongInfo | null; queueLength: number; queueVersion: number;
  bitrateKbps: number | null; error: string | null;
}
export interface MediaModel {
  snapshot(): Readonly<MediaState>;
  elapsed(): number;                                        // live extrapolation for per-frame reads
  subscribe(cb: (changed: ReadonlySet<keyof MediaState>) => void): Unsubscribe;
  queue(): readonly SongInfo[];
  storedPlaylists(): readonly string[];
  playlistSongs(name: string): Promise<readonly SongInfo[]>;
  play(): Promise<void>; pause(): Promise<void>; stop(): Promise<void>; next(): Promise<void>; previous(): Promise<void>;
  seek(sec: number): Promise<void>; setVolume(v: number): Promise<void>;
  setMode(mode: 'loop' | 'shuffle', on: boolean): Promise<void>;
  playQueuePos(pos: number): Promise<void>; playPlaylist(name: string, pos: number): Promise<void>;
  isAvailable(control: string): boolean;
}
export interface DspPort {
  eq: { gains(): readonly number[]; setGain(band: number, db: number): void; reset(): void;
        bypass(): boolean; setBypass(on: boolean): void; onChange(cb: () => void): Unsubscribe };
  balance: { get(): number; set(v: number): void; onChange(cb: () => void): Unsubscribe };   // -100..100, detent ±5
}
export interface AudioFrame { bands: Float32Array; wave: Float32Array; level: number; pcm?: Uint8Array }
export interface AudioFrameBus { subscribe(opts: { pcm?: boolean }, cb: (f: AudioFrame) => void): Unsubscribe }
```

### 5.7 Windows

```ts
export type MaskShape =
  | { kind: 'bits'; width: number; height: number; bits: Uint8Array }      // 1 bpp, row-major, LSB first, skin px
  | { kind: 'regions'; width: number; height: number; regions: { x: number; y: number; w: number; h: number; poly?: number[] }[] };
export interface SkinWindow {
  readonly key: string;                                     // `${skinSha}/${viewId}`
  readonly binding: 'native' | 'cluster';
  readonly root: HTMLElement;
  readonly zoom: number;
  onZoom(cb: (z: number) => void): Unsubscribe;
  setZoom(z: number): Promise<void>;
  setInitialSize(w: number, h: number): Promise<void>;      // attach-time sizing (D7.4)
  requestSize(w: number, h: number): Promise<boolean>;      // script writes; phase 1 returns false
  setShape(shape: MaskShape): void;                         // coalesced to one IPC per frame
  setCapture(on: boolean): void;
  startDrag(): void;
  show(): Promise<void>; hide(): Promise<void>; minimize(): Promise<void>; close(): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>; setVisibleOnAllWorkspaces(on: boolean): Promise<void>;
  bounds(): Promise<Rect>;
  onClose(cb: () => void): Unsubscribe;
}
export interface WindowManager {                            // phase 3 beyond the first view
  open(viewId: string, at?: { left: number; top: number; relative: boolean }): Promise<boolean>;
  close(viewId: string): Promise<void>;
  isOpen(viewId: string): boolean;
}
```

### 5.8 Host adapter

```ts
export interface EngineClock {
  now(): number;                                            // engine time, ms (animations, timers, marquees)
  onFrame(cb: (now: number) => void): Unsubscribe;
  setTimer(ms: number, cb: () => void): number;
  clearTimer(id: number): void;
}
export interface PrefStore {
  load(ns: string): Promise<Map<string, string>>;           // ns = 64-hex skin sha | 'app' | 'mediacenter'
  write(ns: string, key: string, value: string | null): void;    // debounced write-through; caps enforced
  onExternalChange(ns: string, cb: (key: string, value: string | null) => void): Unsubscribe;
}
export interface SlotSpec { kind: 'effects' | 'playlist' | 'video'; attrs: ReadonlyMap<string, AttrValue>; rect: Rect }
export interface EffectsControl { readonly count: number; readonly index: number; readonly title: string;
  titleOf(i: number): string; setIndex(i: number): void; step(d: 1 | -1): void; click(): void;
  onChange(cb: () => void): Unsubscribe }
export interface SlotHandle {
  readonly element: HTMLElement;
  update(spec: SlotSpec): void; setVisible(v: boolean): void;
  hitRects(): Rect[]; onHitRectsChange(cb: () => void): Unsubscribe;
  readonly effects?: EffectsControl;
  dispose(): void;
}
export interface SlotProvider { mount(el: HTMLElement, spec: SlotSpec, win: SkinWindow): SlotHandle }
export interface HostActions {
  run(action: 'returnToMediaCenter' | 'minimize' | 'close', ctx: { viewId: string }): void;
  denied(api: string, detail: string): void;                // one notice per skin per api
  fault(reason: string): void;                              // shows the fault panel
}
export interface Log { info(m: string, d?: object): void; warn(m: string, d?: object): void; diag(d: Diagnostic): void }
export interface HostAdapter {
  readonly kind: 'tauri' | 'test';
  readonly window: SkinWindow;
  readonly windows: WindowManager;
  readonly clock: EngineClock;
  readonly prefs: PrefStore;
  readonly media: MediaModel;
  readonly dsp: DspPort;
  readonly audio: AudioFrameBus;
  readonly palette: PaletteService;
  readonly decode: DecodeExecutor;
  readonly slots: SlotProvider;
  readonly actions: HostActions;
  readonly log: Log;
}
```

### 5.9 Palette

```ts
export type NotanRole = string;                             // the nine notan-palette/1 v1 keys, verbatim
export interface PaletteSnapshot {
  source: 'artifact' | 'local' | 'default';
  association: 'current-uri' | 'retained' | 'default';
  track: { uri: string; generatedAt: string } | null;
  roles: Readonly<Record<NotanRole, string>> | null;        // all nine or null
  guarantees: readonly { a: NotanRole; b: NotanRole; kind: string }[];   // verbatim; [] unless artifact
  clusters: readonly { hex: string; oklch: [number, number, number]; share: number }[];
}
export interface PaletteService {
  snapshot(): PaletteSnapshot;
  subscribe(cb: (s: PaletteSnapshot) => void): Unsubscribe;
  lerp(a: string, b: string, t: number): string;            // the one blessed polar-OKLCH lerp
}
```

### 5.10 Engine API, inspector, sidecar, skin hosts

```ts
export interface EngineOptions {
  config: 'faithful' | 'oracle-compat';
  sliderGeometry: 'oracle' | 'docs';                        // 'oracle' in both configs
  showBackgroundDefault: boolean;                           // faithful false (U-23), compat true
  buttonKeyedPixelsHit: boolean;                            // faithful true (spec 2.7), compat false
  stacking: 'context' | 'flat';
  subviewClip: boolean;
  availability: 'oracle' | 'mpd';
  realmTickHz: number;                                      // 10
  budgets: RealmBudgets;
  testSeed?: string;
}
export const FAITHFUL: EngineOptions;
export const ORACLE_COMPAT: EngineOptions;
export function createEngine(host: HostAdapter, opts?: Partial<EngineOptions>): Engine;
export interface Engine { load(archive: Uint8Array, opts?: { name?: string; sidecar?: Sidecar }): Promise<LoadedSkin> }
export interface LoadedSkin extends HostedSkin { attach(viewId?: string): Promise<ViewRuntime> }
export interface ViewRuntime extends HostedView {
  readonly viewId: string;
  readonly inspector: SkinInspector;
  readonly realmHealth: Realm['health'];
}
export interface SkinInspector {
  find(ref: string): { id: string; kind: ElementKind } | null;      // id or Unnamed_<type>_<n>
  rectOf(ref: string): Rect | null;                                 // view px, current animated value
  groupPoint(groupRef: string, mappingColor: string): { x: number; y: number } | null;   // view px
  sliderThumbPoint(ref: string, value: number): { x: number; y: number } | null;       // view px
  attr(ref: string, name: string): Wire;
  setAttr(ref: string, name: string, v: Wire): void;                // origin 'host'
  callGlobal(name: string, args?: Wire[]): Wire;
  readGlobal(name: string): Wire;
  stackingDump(): string[];
  root(): HTMLElement;                                              // div.view
}
export interface SidecarOverlay { parent: string; tag: 'text'; attrs: Readonly<Record<string, AttrValue>>;
  hostStyle?: { letterSpacing?: string } }
export interface Sidecar {
  schema: 'window_headmpd-sidecar/1'; skin: string;
  overlays?: SidecarOverlay[];
  attrs?: { ref: string; name: string; value: AttrValue }[];
  compat?: { attrs?: { ref: string; name: string; value: AttrValue }[] };
  actions?: { returnToMediaCenter?: 'zoomToggle' | 'none' };
  restore?: { global: string; toggle: string; pref: string }[];
  viewResize?: 'honor' | 'ignore';
  tour?: Record<string, unknown>;
}
export interface EqProfile { centres_hz: number[]; q: number; min_db: number; max_db: number; has_preamp: boolean }
export interface SkinHost {
  readonly family: 'wms' | 'wsz' | 'native';
  canLoad(vfs: SkinVfs): number;                            // 0..1
  load(vfs: SkinVfs, ctx: { host: HostAdapter; sidecar?: Sidecar }): Promise<HostedSkin>;
}
export interface HostedSkin {
  readonly sha: string;
  readonly family: SkinHost['family'];
  readonly capabilities: { eq: EqProfile | null; wantsPcm: boolean; windowModel: 'native-per-view' | 'cluster'; scripted: boolean };
  views(): { id: string; width: number; height: number; main: boolean }[];
  attach(viewId?: string): Promise<HostedView>;
  diagnostics(): Diagnostic[];
  ledger(): LedgerEntry[];
  dispose(): void;
}
export interface HostedView {
  maskShape(): MaskShape;                                   // the last shape sent
  settled(): Promise<void>;                                 // no tween, no queued events, no pending decode
  readonly health: { soft: number; hard: number; unloaded: boolean };
  dispose(): void;
}
```

### 5.11 Internal engine modules (contracted so waves can run in parallel)

```ts
// layout/
export function evaluateLayout(view: ViewModel, realm: Realm, opts: { passBudgetMs: number }): Diagnostic[];
export function recordAnchors(view: ViewModel): void;
export function relayout(view: ViewModel, w: number, h: number): void;     // phase 3 caller
export function paintOrder(container: ElementModel, opts: { stacking: 'context' | 'flat' }): ReadonlyArray<ElementModel | 'background'>;
// bind/
export function parsePath(src: string): BindPath | null;
export interface BindingEngine { install(): void; suspend(el: ElementModel, attr: string): void; resume(el: ElementModel, attr: string): void;
  frame(now: number): void; dispose(): void }
export function createBindings(view: ViewModel, graph: ObjectGraph, clock: EngineClock, opts: { realmTickHz: number }): BindingEngine;
// anim/
export interface Animator { moveTo(el: ElementModel, x: number, y: number, ms: number, ease: 'linear' | 'inout', w?: number, h?: number): void;
  alphaBlendTo(el: ElementModel, a: number, ms: number): void; cancel(el: ElementModel): void; frame(now: number): void; running(): number }
export function createAnimator(clock: EngineClock, fire: (el: ElementModel, event: 'onendmove' | 'onendalphablend') => void): Animator;
// render/
export interface Renderer { mount(view: ViewModel): void; frame(dirty: Map<ElementModel, Set<string>>): void;
  nodeOf(el: ElementModel): HTMLElement | undefined; slotOf(el: ElementModel): SlotHandle | undefined; dispose(): void }
export function createRenderer(root: HTMLElement, images: ImageService, slots: SlotProvider, win: SkinWindow, opts: EngineOptions): Renderer;
// input/
export type PickRole = 'control' | 'blocked' | 'effects' | 'widget' | 'chrome';
export interface Pick { el: ElementModel; part: number | null; role: PickRole; local: { x: number; y: number } }
export function pick(view: ViewModel, images: ImageService, slotRects: (el: ElementModel) => Rect[], x: number, y: number, opts: EngineOptions): Pick | null;
export interface InputSink { gesture(el: ElementModel, event: string, init: EventInit, part: number | null): void;
  key(event: 'onkeydown' | 'onkeypress' | 'onkeyup', init: EventInit): boolean;   // true if a skin handler ran
  dragSlider(el: ElementModel, phase: 'begin' | 'move' | 'end', value: number): void }
export function attachInput(plane: HTMLElement, view: ViewModel, pickAt: (x: number, y: number) => Pick | null,
  win: SkinWindow, sink: InputSink, opts: EngineOptions): Unsubscribe;
// shape/
export function rasterizeShape(view: ViewModel, images: ImageService, slotRects: (el: ElementModel) => Rect[], opts: EngineOptions): MaskShape;
```

---

## 6. Module map

Paths are new unless marked. "Pure" means no DOM; it runs under Node.

### 6.1 Engine (`src/engine/`, Tauri-free)

| Path | Pure | Responsibility | Public interface (§5) |
|---|---|---|---|
| `contracts.d.ts` | | every cross-module type | types only |
| `index.js` | | composition root, `WmsSkinHost` | `createEngine`, `Engine`, `LoadedSkin` |
| `options.js` | ✓ | defaults and presets | `FAITHFUL`, `ORACLE_COMPAT` |
| `view-runtime.js` | | orders the load sequence (§3.1), owns the dirty set, the frame loop, fault policy, sidecar application | `ViewRuntime` |
| `inspect.js` | | inspector for the demo, tests and the shell | `SkinInspector` |
| `archive/zip.js` | ✓ | central-directory reader, caps, salvage | `readZip` |
| `archive/vfs.js` | ✓ | flat case-folded Map VFS | `openVfs` |
| `archive/identity.js` | ✓ | SHA-256 via `crypto.subtle` | `sha256Hex` |
| `text/decode.js` | ✓ | BOM/ASCII/cp1252 | `decodeText` |
| `wms/scan.js` | ✓ | tolerant tokenizer | `scanWms` |
| `wms/select.js` | ✓ | multi-`.wms` choice | `pickDefinition` |
| `wms/tags.js`, `wms/attrs.js` | ✓ | tag defaults, attribute types | `resolveTag`, `attrSpec` |
| `wms/values.js` | ✓ | value classes, colours, coercion | `classifyValue`, `parseColor`, `coerce` |
| `wms/build.js` | ✓ | literal pass, ids, overlays, structural caps | `buildTheme` |
| `model/elements.js` | ✓ | `ElementModel`, `ViewModel`, `_onchange` queue, dirty set | (constructed by `buildTheme`) |
| `layout/stack.js` | ✓ | paint order (Reading C) | `paintOrder` |
| `layout/expr.js` | ✓ | the `jscript:` pass | `evaluateLayout` |
| `layout/align.js` | ✓ | anchors, relayout | `recordAnchors`, `relayout` |
| `image/probe.js` | ✓ | header-only sizes | `probeImage` |
| `image/decode/{index,bmp,png,gif,jpeg}.js` | ✓ | decoders under caps | `decodeImage` |
| `image/keying.js` | ✓ | per-declaration keys, bit planes | `keyImage` |
| `image/service.js` | | cache, lazy decode, LRU | `createImageService` |
| `image/worker.js` | | Worker entry for the Tauri executor | message protocol `{id, job} -> {id, planes}` |
| `realm/realm.js` | ✓ | QuickJS instance/context, budgets, faults, duty cycle | `createRealm` |
| `realm/membrane.js` | ✓ | handle table, marshalling, validation, revocation | internal to `realm.js` and `view-runtime.js` |
| `realm/prelude.js` | ✓ | realm-side bootstrap source as a string | `PRELUDE_SOURCE` (the one checker exemption) |
| `realm/wmploc.js` | ✓ | `#132/#134/#136/#169`, `res://`, strings | `wmplocConstants`, `resolveRes`, `loadString` |
| `model/schema.js` | ✓ | class member tables | `SCHEMA` |
| `model/objects/*.js` | ✓ | `player`, `controls`, `settings`, `media`, `network`, `playlistObj`, `theme`, `view`, `event`, `mediacenter`, `eq`, `vidset`, `effects`, `element` | `createObjectGraph` |
| `model/policy.js` | ✓ | per-API policies and rate caps | used by objects |
| `model/ledger.js` | ✓ | coverage ledger | `createLedger` |
| `bind/paths.js`, `bind/bindings.js` | ✓ | `wmpprop:` grammar, live bindings | `parsePath`, `createBindings` |
| `anim/animator.js` | ✓ | tweens on the engine clock | `createAnimator` |
| `render/dom/*.js` | | layer tree, one drawable per element kind, slots | `createRenderer` |
| `input/picker.js` | ✓ | top-down hit test | `pick` |
| `input/dispatch.js` | | gestures, hover, capture, drag, keys, tooltip, cursor | `attachInput` |
| `shape/mask.js` | ✓ | window shape from the scene | `rasterizeShape` |

### 6.2 Hosts, app, tools, Rust

| Path | Responsibility | Public interface |
|---|---|---|
| `src/entry.js`, `src/app/mode.js` | legacy/engine flag | `resolveMode(): 'legacy' \| 'engine'` |
| `src/hosts/test/{index,clock,media,prefs,dsp,window,slots}.js` | `TestHostAdapter` | `createTestHost(opts): HostAdapter & { clock: { advance(ms) }, media: FakeMedia, recorded }` |
| `src/hosts/tauri/index.js` | `TauriHostAdapter` | `createTauriHost(opts): Promise<HostAdapter>` |
| `src/hosts/tauri/{window,media,dsp,prefs,audio,decode,clock,skins}.js` | adapter parts; `media.js` wraps pinned `player.js` | `createNativeSkinWindow`, `createMpdMediaModel(player, mpd)`, … |
| `src/app/boot.js` | AppShell entry: safe mode, skin resolve, load, attach, menu, keys, overlays, restore, demo trigger | side effect |
| `src/app/{menu,keys,zoom,fault-panel,migrate,skin-registry,sidecar}.js`, `app.css` | D10 | `attachMenu`, `attachKeys`, `loadSidecar(sha)`, … |
| `src/app/viz-host.js`, `overlays.js`, `overlays.css` | effects slot, overlays | `createSlotProvider(deps): SlotProvider` |
| `src/app/widgets/playlist.js`, `playlist.css` | playlist slot | `mountPlaylist(el, media, attrs): SlotHandle` |
| `src/app/palette/{service,local,lerp}.js` | `PaletteService` local/default tiers | `createPaletteService(media, invoke)` |
| `src/app/demo/{driver,headspace,target}.js` | demo tour | `runTour(target, choreography, wav)` |
| `src/app/sidecars/<sha256>.json`, `sidecar.schema.json` | per-skin data | `Sidecar` |
| `tools/check-boundaries.mjs` (+ `.fixtures/`) | D8 rules | exit non-zero on violation |
| `tools/scan-api.mjs` | static API ranking | writes `docs/coverage/api-frequency.csv` |
| `tools/corpus.mjs` | corpus load in Node, ledger | writes `docs/coverage/ledger.md` |
| `tools/skinlab/run.mjs` | CLI dispatcher: `run.mjs <cmd>` imports `cmd-<cmd>.mjs` | exit 0/1/2/77 |
| `tools/skinlab/cmd-*.mjs` | `prepare`, `bless`, `verify-legacy`, `check`, `fixtures`, `diff`, `show`, `demo`, `corpus` | |
| `tools/skinlab/{vite.config.js, legacy.html, legacy-mount.js, engine.html, engine-mount.js, fixture.html, fixture-mount.js, tauri-stub.js, viz-stub.js, states.mjs, capture.mjs, store.mjs, pins.mjs, diff.mjs, regions.mjs, allowlist.json, goldens.manifest.json, fixtures/*.case.js}` | D9 | |
| `tests/support/*` | synthetic writers, fixture resolver | |
| `src-tauri/crates/headcore/` | pure Rust: `hit`, `fanout`, `skinstore`, `prefstore`, `guards` | no Tauri dependency; `cargo test -p headcore` |
| `src-tauri/src/{hit_cmds,skin_cmds,prefs_cmds}.rs` | Tauri glue (re-pin) | commands of D4, D6.4, D7.1, D11 |
| `src-tauri/src/lib.rs` (pinned) | wiring at the re-pin | registers the commands, keeps legacy wrappers |

**Dependencies** (exact versions in `package.json`, lockfile committed). Runtime:
`quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`, `fflate@0.8.3`,
`jpeg-js@0.4.4`. Dev: `vitest`, `happy-dom` (DOM-light unit tests), `typescript` (check only),
`playwright-core@1.63.0`, `pngjs`. Rust: `sha2`, `tempfile`; phase 2 adds `notify`. Licences are
checked by W0.1.

---

## 7. Page hardening (applied in the re-pin batch)

- `app.security.csp`:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'`.
  `connect-src 'self'` is required: the `wasmfile` variant fetches its `.wasm` from the app origin
  (cand-S and cand-D omitted it, which would block QuickJS in the app only). `'wasm-unsafe-eval'`
  exists only for QuickJS. If WKWebView rejects it, fall back to `'unsafe-eval'` in `script-src` only
  and record it as an open risk; the realm's isolation does not depend on the CSP (R14).
  `'unsafe-inline'` styles stay because the renderer writes `element.style` (CSSOM, which WebKit gates
  under the same keyword) and the legacy does too. `app.security.devCsp` adds the Vite origin and its
  websocket. Phase 2 adds `blob:` to `connect-src`.
- `mpd` gains a verb allow-list (`headcore::guards::mpd_verb_allowed`): `status currentsong
  playlistinfo listplaylists listplaylistinfo play pause stop next previous seekcur setvol clear load
  repeat random single consume` (every verb `player.js`, `playlist.js` and `demo.js` use, plus the
  mode verbs). The blast radius of any page-realm compromise shrinks from "any MPD command" to these.
- `record_stop` accepts only a path under `/tmp`, `/private/tmp`, `$TMPDIR` or `~/Movies`
  (`headcore::guards::record_path_allowed`); `demo.js`'s default `/tmp/window_headmpd-demo.wav` passes.
- `capabilities/default.json` adds `core:window:allow-set-position` (persisted positions, phase 3)
  and nothing else in phase 1.

---

## 8. Data the engine never trusts, in one place

| Input | Defence |
|---|---|
| Archive bytes | JS reader under caps; never extracted; Map VFS; corrupt entries are `null` |
| Images | header probe and caps before allocation; pure-JS decoders; Worker terminate after 2 s |
| `.wms` text | tolerant scanner; structural caps; entity decoding only in values; no markup ever produced |
| Skin script | QuickJS realm, membrane, budgets, duty cycle, policies, gesture gating |
| Skin strings in the DOM | `textContent`, `title`, sanitised font families, keyword cursors; never `url()` |
| Skin strings as keys | Maps or null-prototype objects everywhere |
| Pref keys and values | caps in JS and Rust; per-sha namespace; debounce |
| Window labels | never derived from skin strings |
| Paths | none derived from skins; `skin_read` takes 64 hex; `skin_import` path guard; `record_stop` path guard |

---

## 9. Deviations allow-list (Headspace, phase 1)

`tools/skinlab/allowlist.json`, committed. Computed regions are derived at run time from the art by
`regions.mjs` with the engine's own decoders, so no art coordinates are hardcoded. Each entry has an
id, kind, configs, states, region generator, a **bound** (the maximum count it may absorb) and its
deviation reference. A new difference is either an engine bug or a new entry added by Opus; never by
the implementing task.

| Id | Kind | Configs | States | Region | Bound | Why |
|---|---|---|---|---|---|---|
| `effects-hole` | pixel exclusion | both | all | `head.bmp` pixels equal to `#FF00FF`, offset (261, 0) | 31,487 px (exact) | the visualizer is stubbed differently on each side (`parity 4.1`) |
| `U-23-showBackground` | pixel | faithful | all | pixels of each BUTTONGROUP rect owned by no `mappingColor`, from the maps | measured at G4; `spec 6.5` predicts ~811 in the transport group and 1 in min/close | engine follows the docs (unowned not painted); the oracle paints them |
| `D20-reset-y` | pixel | faithful | S2, S2b | rect (222,221)-(258,238) | rect area | engine puts `reset` at `eq1.top + 83` = 127; oracle at 129 |
| `D21-preset-title` | pixel | faithful | S4 | rect (321,65)-(426,82) | rect area | engine uses the 10 pt default = 13 px; oracle 9 px |
| `U-10-slider-travel` | pixel | faithful | all | slider rects | **0** | `sliderGeometry: 'oracle'` in both configs; the entry exists so flipping the switch comes with its region |
| `D11-screen-corners` | mask | both | all | the 106 white pixels of `vid_bkgd.bmp`, offset (270, 59) | 106 (exact) | the oracle counts the effects canvas as a solid rect (`parity 4.1`) |
| `button-transparency` | mask | faithful | all | keyed pixels of interactive BUTTON images not covered by any painted pixel | measured at G4; a judge measured 130 (EQ handle) + 135 (PL handle) ≈ 265 per state | BUTTON receives clicks on transparency (`spec 2.7`); the oracle's alpha mask does not |

Owner-visible consequences, accepted under `parity 0.1` rule 1: the ~811 px around the transport
buttons, the preset title size, and reset 2 px higher. If the owner prefers the oracle's look for
any of these, the sidecar's `compat` mechanism can be promoted to a per-skin faithful setting.

---

## 10. Caps and budgets (single table)

| Area | Cap | Value | Evidence it clears the corpus |
|---|---|---|---|
| Archive | size | 32 MiB | max 2.9 MB (`survey 1.1`); WSZ < 0.5 MB |
| | entries | 4,096 | max 303 |
| | per entry | 32 MiB | largest 2,528×3,300 24-bit BMP ≈ 25 MB |
| | total inflated (lazy) | 256 MiB | |
| | ratio (entries > 1 MiB) | 1,024:1 | max 130:1 |
| | name | 255 B | |
| Images | per axis | 16,384 px | widest referenced 15,990 (pharaoh) |
| | area | 16,777,216 px | largest 8.3 M px |
| | GIF frames | 512 | max 145 |
| | live decoded per skin | 256 MiB, LRU | |
| | decode wall time | 2 s, then Worker terminate | |
| | JPEG | `maxResolutionInMP` 16.78, `maxMemoryUsageInMB` 256 | |
| `.wms` | text | 4 MiB | max 189 KB (`survey 6`, R9) |
| | elements per THEME | 20,000 | R9 has 556 elements in the main file |
| | nesting depth | 64 | |
| | attributes per element | 256; value ≤ 64 KiB | |
| | VIEWs | 64 | max 9 |
| | view size per axis | 4,096 px | |
| | engine-allocated canvas | ≤ 4,096 per axis and ≤ 16.7 M px; larger boxes clamp with a diagnostic | the corpus run reports clamp hits (expected 0) |
| Realm | memory / stack | 64 MiB of skin data, enforced as the WASM heap cap below / 256 KiB (G1: 1 MiB escaped WASM as a host RangeError under Node 26; the clean ceiling is 320–384 KiB and host-dependent; re-measured in WKWebView at W3.R) | |
| | top-level scripts of a view | 2,000 ms | `digitaldj` 3,938 lines in 7 files |
| | `onload`, `onclose` | 1,000 ms | |
| | handler, `_onchange`, timer, `ontimer` | 100 ms | |
| | one `jscript:` / whole pass | 20 ms / 1,000 ms | |
| | pending jobs per drain | 1,000, inside the entry budget | |
| | duty cycle | > 50% over 5 s throttles; > 80% over 10 s is a hard fault | |
| | membrane | strings and property keys ≤ 64 KiB, checked before copy (G2); ≤ 16 args | |
| | WASM heap | `memoryLimitBytes` + the variant's initial memory, as a capped `WebAssembly.Memory` (G2: QuickJS's own limit counts allocation overhead, not size) | |
| | script source | 1 MiB per file (G2) | corpus maximum 54,504 chars |
| | compile | deadline checked before every compile; a spent scripts budget refuses the file (G2) | QuickJS never polls during parsing |
| | overrun | an entry past deadline + 300 ms is a hard `budget` fault even without an interrupt poll (G2) | |
| | queued-dispatch drain | `budgets.load` ms of wall time, then the rest is dropped with a soft fault (G2) | |
| | realm diagnostics | 64 per stream per view, then one `*-capped` (G2) | |
| | timers | 64 live per view; floor 10 ms; `timerInterval` < 50 rejected | |
| | `_onchange` chain | depth 32 | |
| | unload | 1 OOM or abort, or 3 hard faults in 30 s | |
| Host APIs | MPD from script | ≤ 10/s per verb; seek and volume coalesce at 40 ms | |
| | prefs | 256 keys, key ≤ 256 B, value ≤ 4 KiB, 64 KiB per namespace, 250 ms debounce | |
| | `view.close/minimize` | user gesture only | |
| | `openView` (phase 3) | 16 open, 4 per second | |
| Window | mask | popcount < 64 → full view rect | |
| Rust | `skin_import` | `.wmz/.wsz/.zip`, regular file, ≤ 32 MiB, EOCD present | |
| | `skin_read`, prefs ns | `^[0-9a-f]{64}$` (or `app`, `mediacenter` for prefs) | |
| | `mpd` | verb allow-list (§7) | |
| | `record_stop` | path guard (§7) | |

---

## 11. Phase 2 and phase 3

### 11.1 Phase 2 (Winamp 2 through Webamp, plus shared infrastructure)

- `src/skinhosts/webamp/` behind `SkinHost` (D12): media class, Redux sync, private-API wrapper with
  self-test, canonical re-zip, cluster window binding with `Regions` masks, context-menu rect.
- Rust: `set_eq_profile`, preamp, bypass, `Frame.pcm` (D11); `hit_set_regions` is already in phase 1.
- PaletteService artifact tier (D12), reviewed with the notan-palette/1 contract owner.
- Skins ▸ menu, Import Skin… (`tauri-plugin-dialog`), skin switching, family sniffing.
- Typed MPD command set for page-realm code; per-window capabilities for the Webamp window; CSP
  `connect-src blob:`.
- Tests: Webamp museum-screenshot diffs per `skins/wsz` skin; MPD idle-sequence replays against the
  Webamp adapter.

### 11.2 Deliberately left to phase 3

- Calling a host property as a method (`mediacenter.effectType()`, JScript IDispatch): the host half returns the value (G3.F4), but the realm's proxy hands script the value itself, so `x.prop()` throws in QuickJS first; 28 corpus `jscript:` faults, none in Headspace (it binds through `wmpprop:`). Needs a realm-side mechanism (a zero-argument call rewrite in the R20 style), pinned by `tests/corpus/layout.test.js`.
- Opening secondary views (`theme.openView`, `closeView`, `openViewRelative`) as native windows with
  `skin-<sha12>-<n>` labels, per-view realms, prefs coherence events, position persistence, the
  overlap-misroute test (0 in 200).
- The resize policy: honouring `view.width`/`view.height`, `view.size(edge)` grips (83 skins),
  alignment relayout, `minWidth`…`maxHeight`, VIEW-level `moveTo`/`alphaBlendTo`.
- CUSTOMSLIDER (designed, not built), animated GIF, `.cur`/`.ani` cursors, `nineGridMargins`,
  `resizeImages`, `hueShift`/`saturation` on 8-bit BMPs (the decoder already keeps indices).
- EDITBOX, LISTBOX/POPUP/ITEM, AUTOMENU host widgets; skin popup menus; PLAYLIST selection and
  editing methods.
- `theme.playSound`, an opt-in `launchURL` confirm, EQ presets and spline tension, `videoSettings`
  effects, `<bars>`, `RT_IMAGE`/`RT_BITMAP` beyond placeholders.
- The `availability: 'mpd'` table (`spec 3.4`) versus the oracle's (`parity` open question 5).
- A `Viz` size option for EFFECTS elements other than 216×158 (needs a `viz/index.js` change).
- A persistent decode cache; the realm in a Worker or a realm-side mirror of hot members, only if the
  R9 perf gate says so.
- Our own new skins: authored as `.wms`/`.wmz` plus sidecar extensions, so the engine needs nothing
  new. A native declarative format (`NativeSkinHost`) only if `.wms` limits authoring; `buildTheme`
  produces a format-neutral `ThemeModel` to keep that possible.
- Real-WMP ground truth for U-2, U-10, U-23, U-25: if the owner can produce screenshots from a Windows
  VM before Microsoft's 2026-11-10 skin end-of-life (`spec 1.1`), they become phase-3 goldens.
- Platforms other than macOS.

---

## 12. Risks accepted

| # | Risk | Why accepted | Mitigation / tripwire |
|---|---|---|---|
| R1 | QuickJS semantics differ from JScript in a corner (`with` over Proxy, eval hoisting, Annex B) | Isolation is worth more than perfect fidelity; the corpus is ES3-shaped | RG0 gate before realm work; ng variant; accessor fallback |
| R2 | Membrane crossing cost on heavy skins | One auditable dispatcher | R9 perf gate (phase 3 entry); realm-side mirror or Worker realm if it fails |
| R3 | Wall-clock budgets misfire under GC pauses or load | The sync variant exposes no instruction counter | Generous 100 ms; three strikes in 30 s; soft faults never unload |
| R4 | Chromium oracle vs WKWebView product (text rasterisation, `pixelated` scaling, canvas vs `<img>`, `mask-image` resampling at DPR 2) | Relative comparison in one browser is what parity needs | Own decoders remove the image half; WebKit report-only pass; **G-WK in-app gate before cutover** |
| R5 | Legacy capture non-determinism (CSS transitions, async image loads) | It is the oracle we have | Determinism gate (bless twice, identical hashes); manifest hash check on every machine |
| R6 | DPR-2 pixel mismatch between canvas leaves and the oracle's `<img>` | Exact at DPR 1 by construction | DPR 2 is in every gate |
| R7 | One webview per WMP view is memory-heavy for 5-9-view skins (phase 3) | Isolation and native per-view behaviour | Measure at R6; the interface allows a cluster binding for WMP too |
| R8 | Click misrouting between overlapping windows under 16 ms polling | Known since `notan Q1` | 8 ms polling while frames intersect; NSEvent monitor only on evidence |
| R9 | Following the docs makes Headspace differ visibly from today (U-23 ~811 px, preset title size, reset y) | `parity 0.1` rule 1 | Allow-listed with bounds; sidecar can restore the oracle look per skin |
| R10 | Size-less SUBVIEWs do not clip (a reading of the docs) | Corpus grouping subviews | The corpus run reports such subviews; switch `subviewClip` |
| R11 | `_onchange` is always queued, never synchronous; WMP's order is unverified | Keeps the membrane free of re-entry | Ledger counts handlers that read their own change mid-statement; revisit on evidence |
| R12 | Webamp private APIs drift (phase 2) | Pinned version, one wrapper, boot self-test | `webamp 7` risk 2 |
| R13 | Re-authored `res://` strings differ in wording from WMP | Microsoft text cannot ship | Only 6 distinct skins use them |
| R19 | Slow-builtin interrupt latency: QuickJS polls its interrupt handler about every 10,000 interpreter ticks, and a builtin call is one tick however long it runs | Guards in the prelude wrap the size-proportional builtins (string search/repeat/pad/split/replace/case, array join/sort/indexOf/includes/slice/splice/concat/fill/reverse/flat, JSON.parse/stringify, RegExp exec/test and the Symbol.replace/split/match family) and throw before running once the dispatch is over budget; the loop then spins in cheap ticks and the real interrupt fires. For a **guarded** builtin the residual overshoot is one call. **Unguarded native work** (operators on large strings such as `==`, unary `+`, `===`, `<`, `switch`, and any builtin not on the guard list) overshoots by up to one interrupt-poll interval, about 10,000 operations: the G2 review measured 47.7 s at 1 MiB with local operands in a loop. Handler top-level code polls about 60× more often because of the `with(__IDS)` traps. The guards narrow accidental paths only; they do not close this class against a hostile skin. For most calls that is bounded by the 64 MiB memory cap (~150 ms measured); comparison-heavy calls over many references to large strings are not (W2.2 review: `arr.indexOf(s)` over 4,000 references to one 16 MiB string takes ~48 s), nor are unguarded builtins (`Object.keys`, `Array.from`, spread, constructors), nor a regex compiled from a large string argument (`'a'.match(big)` 4.3 s, `'a'.search(big)` 4.8 s, `new RegExp(big)` 6.2 s at a 4 MiB argument, G2.F1 review). Recovery for those is force-quit plus the safe-mode boot (D10); a QuickJS build with fine-grained interrupt polling (phase 3) closes the class | RG0 measured 0.8–2.2 s overshoot for `for(;;){'y'.repeat(1e5)}` and minutes for `indexOf` over 16 MiB without guards; phase 3 may build QuickJS with a smaller interrupt counter |
| R21 | jpeg-js's own `maxMemoryUsageInMB` 256 guard rejects 4:4:4 JPEGs above about 12.5 MP that the 16.7 MP area cap and the probe accept (G1.F1 measured: 11.56 MP decodes, 12.96 MP is `image-corrupt`) | Corpus maximum is 8.3 MP; the decode fails closed with a diagnostic | Raise the guard or add a JPEG-specific area cap if a real skin needs it |
| R20 | Assignment to a call expression (`eq.gainLevels(band) = v`) is a QuickJS parse error but a run-time error in JScript and V8 | The loader rewrites only statements QuickJS rejects with "invalid assignment left-hand side" into a call that throws `TypeError('Cannot assign to a function result')` at run time, one statement at a time, at most 32 per file, each logged as a `script-rewrite` diagnostic | 7 of 219 corpus scripts; without the rewrite each file would be lost whole |
| R14 | WKWebView may not honour `'wasm-unsafe-eval'`, and Chromium cannot detect an in-app WASM failure | A strict CSP is worth trying | The re-pin gate boots the engine in the real app; fallback `'unsafe-eval'` in `script-src` only |
| R15 | Contract drift between parallel Sonnet tasks | Waves are parallel by design | One Opus-owned `contracts.d.ts`; `tsc --checkJs` in every acceptance; Opus gate per wave |
| R16 | Goldens are local-only (owner's fixture, pinned Chromium on this Mac) | Art cannot be shared | Manifest hashes make drift detectable; tag regeneration keeps the oracle reproducible after cutover |
| R17 | Chromium headless font availability (Tahoma) differs from the app | macOS ships Tahoma | G-WK; `parity` open question 8 |
| R18 | The 40 ms MPD coalescing changes how fast a skin can drive volume | Bounds MPD floods | Same as the oracle's debounce |

---

## 13. Judge findings resolved

| # | Finding | Resolution |
|---|---|---|
| 1 | cand-F hit regions as `clip-path` on the painting node break `showBackground` and CUSTOMSLIDER, and grow with region complexity | D2: separate paint/hit planes and an engine picker; no `clip-path` hit-testing |
| 2 | cand-S/cand-D mask acceptance claims XOR = 106 corners while ORing keyed BUTTON pixels (~265 extra bits) | D2 window shape, D9 gates, §9 entry `button-transparency` with a measured bound; compat turns the bits off |
| 3 | Image caps of 4,096 or 8,192 per side reject referenced CUSTOMSLIDER strips; cand-S's rationale cites the wrong widest image | D3/§10: 16,384 axis cap, rationale corrected to pharaoh 15,990×20 and the full list |
| 4 | `currentPositionString` as `m:ss` contradicts `spec 7.2` | D6: `MM:SS` / `HH:MM:SS` (`03:07`, `01:00:00`) |
| 5 | CSP `connect-src` without `'self'` blocks the `.wasm` fetch | §7: `connect-src 'self' ipc: http://ipc.localhost`; phase 2 adds `blob:` |
| 6 | cand-S keeps `demo.js` unedited while deleting `widgets.js` at cutover | D10.7: new driver/choreography in `src/app/demo/`; `demo.js` is deleted with `main.js` |
| 7 | cand-F `sliderGeometry` defaults to `docs` against `parity` D32 and U-10 | D2/D9: `'oracle'` in both configs; `U-10` entry bound 0 |
| 8 | cand-F honours `view.width` in phase 1, overriding `parity` D13 | D7.3: phase 1 ignores; phase-3 resize policy with Headspace pinned to `ignore` |
| 9 | cand-D global-prototype Proxy loses `ReferenceError`; its spike never tests it | D1: `with(__IDS)` with `has` false for unknowns; RG0 item 4 tests it |
| 10 | cand-S 4 Hz position regresses the oracle's per-frame seek thumb | D5: per frame to host bindings, 10 Hz to the realm |
| 11 | cand-D right-click always opens the host menu, against `parity` D8 | D10.1: skin first, host second; Ctrl/Option-click always host |
| 12 | cand-D drops the `eqOpen`/`plOpen` boot replay that `parity` D23 calls HOST | D10.6: sidecar `restore` |
| 13 | cand-D decodes JPEG with the browser | D3: `jpeg-js` with caps after our header probe |
| 14 | cand-D drives auto-updating system Chrome | D9: pinned Playwright Chromium; revision in the golden key |
| 15 | cand-S precedence table contradicts its `with(__HG)` chain; script `var` matching an id writes through | D1: no host-global `with`; host globals are replaceable global properties; the G17 exception stated once; id write-through stated, diagnosed, accepted (U-31) |
| 16 | All three run the oracle in Chromium while `parity 4.1` says one WebKit instance | D9: WebKit report-only pass plus the G-WK in-app gate as a cutover criterion |
| 17 | cand-F deadline clock under `page.clock.install` never fires | D1/D9: budget on the real `performance.now`; skinlab never installs a fake page clock |
| 18 | cand-F has no CSP and no `record_stop` guard | §7 |
| 19 | cand-S/cand-D dispose the runtime after OOM, which can abort the module | D1 fault domain: discard, never dispose after an abort or leak |
| 20 | cand-D 1 GiB session decode budget | D3/§10: 256 MiB live decoded per skin |
| 21 | cand-F/cand-D `fast-png` with no IDAT output bound; omggif with no frame cap; jpeg-js uncapped; no decode timeout | D3: own PNG with exact-size inflate, frame cap 512, JPEG caps, 2 s Worker terminate |
| 22 | cand-F labels from VIEW ids | D7.2: `skin-<sha12>-<n>` |
| 23 | cand-F deep-copies realm objects host-side (re-entrancy) and has no string cap | D1 membrane: primitives and handles only; 64 KiB strings; no synchronous re-entry |
| 24 | cand-D `skin_read` validation unstated; `dev_read_fixture` not cfg-gated | D4: 64-hex only; no dev-only Rust command exists (the dev path uses `skin_import` from the env var) |
| 25 | cand-D prefs in `localStorage` | D6.4: Rust files per namespace with caps |
| 26 | cand-D 200:1 ratio cap | D4: 1,024:1 (corpus max 130:1, so 200:1 was safe, but 1,024 leaves headroom for flat BMPs) |
| 27 | No aggregate CPU cap; no cap on the whole `jscript:` pass | D1 duty cycle; D5 1,000 ms pass cap |
| 28 | No structural caps on the `.wms`; unbounded canvas boxes | §10 `.wms` caps and the canvas clamp |
| 29 | No safe mode; `view.close()` from `onload` | D10.8 safe-mode boot; D6.5 gesture gating |
| 30 | An all-zero mask makes the window unreachable | D2/D7.1: popcount < 64 → full view rect |
| 31 | Host lookups keyed by skin strings are plain objects | Ground rule 6; Map-typed contracts (`ClassSchema`, `PrefStore.load`, `TagSchema.defaults`) |
| 32 | No MPD command rate limit | D6.5 and §10 |
| 33 | Phase-2 Webamp reaches raw `mpd` and re-parses original bytes | D12: canonical re-zip, typed commands, scoped capabilities; phase-1 verb allow-list as a backstop |
| 34 | Realm gates skip regex backtracking and `executePendingJobs` | D1 RG0 item 5; pending-job drain inside the budget |
| 35 | cand-D W2.4 cannot reach S1 parity before the object model and bindings; W2.2 needs the bridge from W3 | WAVES: first parity in wave 4 after model, bindings and realm; contracts §5.11 let layout, bindings and renderer run in parallel |
| 36 | Element HostObject needs the builder (undeclared dependency) | D6: built against the `ElementModel` contract with an in-test fake |
| 37 | Rust "legacy goldens still reproduce" checks are vacuous | D9 "What Chromium cannot see"; in-app smoke and G-WK |
| 38 | Pinned files edited by Sonnet tasks without a re-pin | Ground rule 8; WAVES W3.R is the only edit point before cutover |
| 39 | cand-S cutover blocks on all 195 skins having zero hard faults | D10.9 criterion 6: host exceptions block; realm hard faults on the long tail are reported |
| 40 | cand-D `openState` 6 for an empty queue departs from `wmploc 7.5` | D6.2: `psUndefined`/`osUndefined` |
| 41 | cand-F widens the EQ clamp to ±20 dB in phase 1 | D11: ±14 stays |
| 42 | `mediacenter` as an open cross-skin store | D6: documented keys only persist |
| 43 | `skin_import` is an arbitrary-file-read primitive | D4: extension, regular-file, size and EOCD guard |
| 44 | Research conflict U-16 `""` vs G20 `"--"` | `"--"` (all three agreed; confirmed) |

---

## 14. Research disagreements resolved

| Question | Positions | Decision | Why |
|---|---|---|---|
| `loadPreference` for an unset key | U-16 `""`; G20 `"--"` | `"--"` | 83 of 94 preference-using skins test `"--" != x` |
| `jscript:` re-evaluation | U-3 once; G13 on dependency change | once, plus alignment anchors | 2,773/2,791 `view.width-N` lefts pair with `horizontalAlignment="right"` |
| Nested SUBVIEW z | docs absolute; Headspace needs contexts | Reading C, switchable | `parity 0.1` rule 4 arithmetic; `spec 5.3` `visDrop` |
| Thumb travel | docs `[b, L-b]`; oracle `L - thumb` | oracle | `parity` D32 contract; `demo:112` |
| `showBackground` default | docs false; oracle paints | docs, allow-listed with a bound | `parity 0.1` rule 1 |
| Extract skins or keep zipped | `notan Q3(1)` extract; `wsz 6` never | keep the archive, parse in memory | removes the extraction bug class |
| Mask freshness | `notan Q1(c)` MutationObserver | model dirty set | the engine owns the model |
| Prefs storage | `notan Q3` per-hash files; cand-D localStorage | per-hash Rust files | quota, isolation, page-realm readability |
| Duplicate attributes | U-5, `survey 2.2` | last wins, diagnostic | sampled conflicts read as author intent |
| `eq.bypass` default | docs true | false (EQ active) | today's users have an active EQ |
| Mask popcounts | `parity 4.1` emulated | the live oracle wins | `parity` open question 9; recorded at G0 |
| PaletteService artifact tier | cand-F phase 3; cand-S/D phase 2 | phase 2 | independent of either engine; the contract owner offered review |

---

## Appendix A. Headspace acceptance numbers

- Fixture: `~/Downloads/Headspace.wmz` sha1 `f9671f06…`; `headspace.wms` sha1 `2870d4b1…` (UTF-16LE
  with BOM, 523 lines); `headspace.js` sha1 `073d4ffb…` (cp1252, 147 lines).
- Model: 1 VIEW 760×394, no id, `backgroundColor="none"`; 23 SUBVIEWs; 69 elements; 25 `jscript:`,
  18 `wmpprop:`, 2 `wmpenabled:` values (`survey` R0).
- Layout (`parity 0.4`): volume (89, 11); Volume label x 108; eq*i* x = 11 + 15·i, y 44; reset (140,
  **127**).
- Absolute geometry (`parity 0.5`): head (261, 0); screen (270, 59) 216×158; EQ ear x 207 closed, 0
  open; PL ear x 277 closed, 488 open; drop y 33 closed, 59 open; EQ handle closed (215, 152) 18×66;
  PL handle closed (523, 151) 18×67; transport (309, 31) 144×25.
- Paint order: `parity 0.6`.
- Key census (`parity 0.2`): head magenta 31,487, red 17,909; `vid_bkgd` white 106; `viz_drop`
  magenta 352; `L_drwr_*` 328 magenta each, `R_drwr_*` 340; `play_controls_map` 5 keys.
- Masks (emulated; G0 replaces them with live values): 89,328 / 122,636 / 123,258 / 89,328; 37,430
  bytes each.
- Animations: 120 ms linear; EQ ear at 60 ms ≈ x 103.
- Live popcounts from G0: 89,328 / 122,636 / 123,258 / 89,328 (S1–S4), equal to the emulation bit for bit; S5/S6/S7 keep S1's mask.
- Oracle pin after the G3 re-pin (ten pinned files, `clickthrough.rs` removed): `1e6971e35fa009d5b3c8676b2bfdba36dd1055e6de34f95468611cd1bd7328e2`; all 42 manifest slots (21 states × DPR 1, 2) carried over with identical PNG and mask hashes.
- Measured bounds from G4 (faithful, S1/S2/S4 at DPR 1): `U-23-showBackground` 812 px, `button-transparency` 265 px; compat mask XOR 106 (the screen corners).
