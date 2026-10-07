# Candidate design: the generic skin engine, safety-and-seams first

Status: candidate design, 2026-10-06, branch `skin-engine`. Nothing implemented, nothing committed.
Angle: every skin is hostile input from archive.org. This candidate optimises for an airtight script and zip
sandbox, a Tauri-free engine behind a `HostAdapter`, a test `HostAdapter` that doubles as the pixel oracle,
and seams that make phase 2 (Webamp `.wsz`) and phase 3 (the rest of the WMP corpus, our own skins) cheap.

Evidence citations use the research notes' own section names:
`parity` = `docs/research/headspace-parity.md`, `spec` = `docs/research/wms-spec.md`,
`survey` = `docs/research/corpus-survey.md`, `wmploc` = `docs/research/wmploc-library.md`,
`webamp` = `docs/research/webamp-spike.md`, `wsz` = `docs/research/winamp2-corpus.md`,
`notan` = `docs/research/notan-input.md`. Code is cited as `main:N`, `widgets:N`, `lib.rs:N`, `click:N`,
`audio.rs:N` against HEAD `437cbe0`.

## 0. Summary

One page, for the reviewer who reads nothing else.

1. **Skin script never runs in the page's JS realm.** It runs in QuickJS compiled to WASM
   (`quickjs-emscripten-core@0.32.0` + `@jitl/quickjs-wasmfile-release-sync@0.32.0`, MIT; the WASM is
   503,134 B raw, 231,517 B gzip -9, measured from the npm tarball). The only door between the skin and
   the app is a copy-only membrane: primitives and integer handles cross, nothing else. Every op is
   checked against a per-class member table. A wall-clock interrupt budget, a memory cap and a stack
   cap bound each dispatch; repeated hard faults unload the skin.
2. **Skin archives are parsed in engine JS, never extracted to disk.** Rust copies the archive into
   `appdata/skins/<sha256>.<ext>` on import and hands bytes back by hash. The engine's own zip reader
   enforces entry, size, ratio and pixel caps, normalises names into a flat case-insensitive VFS, and
   cannot express a path, so traversal and symlinks are impossible by construction.
3. **Images are decoded by our own pure-JS decoders** (BMP incl. RLE4/RLE8/16/32-bit, PNG via `fflate`,
   GIF, JPEG via a vendored pure-JS decoder), in a Worker in the app and inline in Node tests. Pixels are
   identical in the Chromium harness and in WKWebView, and every decoder is unit-testable in Node.
4. **The engine is a Tauri-free package** (`src/engine/`) driven through a `HostAdapter` (surfaces,
   clock, prefs, media model, audio frames, palette, decode executor, log). A committed check script
   fails the build if anything under `src/engine/` imports `@tauri-apps/*` or touches `fetch`, `eval`,
   `Function`, `XMLHttpRequest`, `WebSocket`, `innerHTML` or `window.__TAURI*`.
5. **The second `HostAdapter` is the oracle harness** (`tools/skinlab/`), built in wave 1 before the
   Tauri adapter grows features. It captures the legacy hand port in the four parity states as goldens
   (Chromium pinned by `playwright-core@1.63.0`, DPR 1 and 2, viz stubbed by a skinlab-only Vite alias)
   and diffs the engine per `SkinWindow` for pixels and hit mask. Goldens are screenshots of Microsoft
   art and **never enter git**; only a provenance manifest of hashes is committed.
6. **Renderer is a hybrid**: a retained DOM tree (one `div` per SUBVIEW stacking context, one `canvas`
   per drawable whose pixels the engine composites from decoded RGBA, DOM text for TEXT) with **engine-owned
   hit-testing** over per-element hit maps and one input plane per window. The DOM never fetches a skin
   URL and never sees skin-controlled markup.
7. **Windows are `SkinWindow`s.** Phase 1 freezes the interface and ships the native binding (one Tauri
   `WebviewWindow` per WMP view, one engine instance per webview). Phase 2 adds a cluster binding for
   Webamp. Rust's click-through becomes per-window now (`HashMap<label, WindowHit>`,
   `capture: Option<label>`, binary mask), and `audio_subscribe` fans out to many channels.
8. **Skin families plug in through `SkinHost`** (`WmsSkinHost` now, `WebampSkinHost` in phase 2,
   `NativeSkinHost` later), all consuming the same `MediaModel`, `AudioFrameBus`, `PaletteService`,
   `PrefStore` and `WindowManager`. The MPD adapter is written once.
9. **Phased delivery with the hand port alive until cutover**: `index.html` loads a 6-line `src/entry.js`
   that imports either `src/main.js` (legacy, default) or `src/app/boot.js` (engine), chosen by a
   persisted flag. Pinned oracle files are untouched until a gated Opus re-pin step (section 3.3).

## 1. Threat model and ground rules

### 1.1 What a hostile skin can try

| Vector | Concrete reach today if skin code ran in the page | Design answer |
|---|---|---|
| Script escapes to the page realm | `(function(){return this})()` in sloppy mode returns `window`; from there `window.__TAURI_INTERNALS__.invoke` reaches every command. `mpd(args)` is raw command passthrough (`lib.rs:29-50`), so a skin could `clear` the queue, `rm` playlists, or `sendmessage`. `record_stop(path)` writes a WAV to an arbitrary path (`lib.rs:146-148`, `audio.rs:98-101`). `csp: null` (`tauri.conf.json:31`) lets it `fetch` anywhere. | D1: separate WASM realm, no page globals exist there. CSP set (1.3). Rust commands bind to the caller window (D7). |
| CPU or memory exhaustion | `while(1){}` in `onload` freezes the only UI thread; a 2 GB string kills the webview. | D1: interrupt budget, memory and stack caps, fault unloading. |
| Zip bombs, traversal, symlinks, corrupt headers | Entries named `../../x`, a 10 KB entry inflating to 4 GB, symlink entries, 3 corpus archives with a corrupt first local header (`survey 1.2`). | D4: in-memory reader, caps, flat VFS keyed by basename, no disk extraction. |
| Decompression bombs in images | A 30000×30000 PNG, a GIF with 10,000 frames, RLE that never terminates. | D3: header probe before allocation, area and frame caps, decode in a Worker with a timeout. |
| Markup or CSS injection | Skin strings rendered with `innerHTML`; `fontFace="x;}body{..."`; `url()` in a cursor. | D2: `textContent` only; font family sanitised to an allow-listed character set; cursors decoded by us into blob URLs or mapped to keywords. |
| Abuse of host APIs | `player.launchURL` (1,014 uses, `spec 7.1`), `player.URL=` (294), `theme.openDialog` (282), `theme.savePreference` flooding, `theme.openView` loops. | D6: per-API policy (deny and log, inert stub, or capped), coverage ledger. |
| Cross-skin data access | Skin A reads skin B's prefs. | D4/D6: prefs namespaced by archive SHA-256; the realm has no key outside its namespace. |
| Decoder memory-safety bugs | Browser image decoders (ImageIO) parse attacker bytes. | D3: our decoders are pure JS (memory-safe); the browser only ever sees RGBA we produced. |

### 1.2 Ground rules for every wave

1. **Skin art never enters git** (`.gitignore:9-15`). That includes goldens, diff images, decoded caches and
   anything rendered from art. Facts about art (hashes, pixel counts, coordinates) may be committed.
2. **The hand port is the oracle** and keeps running on `main` until cutover (`parity 0.1` rule 7).
3. **The engine follows WMP semantics; slips of the hand port are allow-listed, never baked in**
   (`parity 0.1` rule 1).
4. **No module under `src/engine/` may import `@tauri-apps/*`** or use the globals listed in summary item 4.
5. **No skin-controlled string becomes markup, CSS source, a URL the page fetches, or a filesystem path.**
6. **The phase-1 fixture is the owner's `~/Downloads/Headspace.wmz`**, wmz sha1 `f9671f06…`
   (`parity` conventions table), not `skins/wmp/Headspace.wmz`, which is the 2000 revision and differs in
   77 lines of `headspace.wms` (`survey 0` item 9). The harness verifies the hash and **skips with a
   message, never fails**, when the art is absent; CI has no art.

### 1.3 Page hardening (phase 1, wave 4, Opus-gated because `tauri.conf.json` is pinned)

- `app.security.csp`:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'`.
  `'wasm-unsafe-eval'` exists only for QuickJS. No `'unsafe-eval'`: nothing in the page evals.
  `app.security.devCsp` adds the Vite dev server origin and its websocket.
  `'unsafe-inline'` styles stay because the renderer writes `element.style` (that is CSSOM, not
  inline-style injection, but WebKit gates both under the same keyword) and the legacy hand port does too.
- `capabilities/default.json`: `"windows": ["main", "skin-*"]` so secondary view windows (phase 3) get the
  same window permissions; add `core:window:allow-set-position` (needed for persisted positions) and
  nothing else. Skin windows get no `core:webview:*` or plugin permissions.
- `record_stop` gains a guard: the path must resolve under `$TMPDIR` or `~/Movies`. Not reachable from skin
  code under this design, but it is the only file-writing command and costs four lines.

## 2. Architecture at a glance

```
                       ┌──────────────────────── one webview per SkinWindow (native binding) ─────────────────────────┐
 Rust (src-tauri)      │  src/app/ (AppShell, Tauri-aware)           src/engine/ (Tauri-free, CI-enforced)              │
 ─────────────────     │  ──────────────────────────────────         ─────────────────────────────────────              │
 skins.rs  ──bytes──────► TauriHostAdapter ── HostAdapter ──────────► createEngine(host)                                 │
 (import, read by sha) │   .surfaces  (SkinWindow, native)            ├ archive/  zip reader, caps, flat VFS            │
 prefs.rs  ◄──json─────►   .prefs     (PrefStore, per skin sha)       ├ wms/      decode, tolerant scan, build          │
 mpd idle  ──events────►   .media     (MediaModel over player.js)     ├ image/    probe, decoders, keying (in Worker)   │
 mpd cmd   ◄──typed────    .audio     (AudioFrameBus)                 ├ realm/    QuickJS + membrane + prelude + wmploc │
 audio.rs  ──Frames────►   .palette   (PaletteService)                ├ model/    object model, schemas, ledger         │
 (fan-out) │               .clock     (rAF + performance.now)         ├ layout/   two-pass jscript:, alignment, z       │
 click.rs  ◄──shape────    .decode    (Worker pool)                   ├ bind/     wmpprop:/wmpenabled: engine           │
 (per label)│              .log                                       ├ anim/     moveTo/slideTo/alphaBlendTo           │
           │  AppShell: menu, zoom, keys, overlays,                   ├ render/   DOM layer tree, drawables             │
           │  VizHost (src/viz), playlist widget, demo                ├ input/    picker, dispatch, capture, drag       │
           │                                                          └ shape/    window mask from the scene            │
           └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 tools/skinlab/: TestHostAdapter (fake media, frozen clock, recorded calls) + legacy oracle capture + diff, headless Chromium
```

Data flow for one skin load (phase 1, single view):

1. AppShell asks Rust for the selected skin's bytes (`skin_read(sha)`), passes them to
   `engine.load(bytes, {sidecar})`.
2. `archive/zip` indexes the central directory under caps; `archive/vfs` builds the flat, case-folded
   name map; `archive/identity` confirms the SHA-256.
3. `wms/select` picks the `.wms` (fewest unresolved references, `survey 1.2`); `text/decode` sniffs
   BOM/cp1252; `wms/scan` produces a raw tree plus diagnostics; `wms/build` applies tag defaults and
   attribute types and creates the element model **with literal values only**, probing image headers for
   default sizes.
4. `realm` boots a QuickJS context for the view: prelude, `#132` constants, skin `scriptFile`s
   (top-level code), then `layout/expr` evaluates `jscript:` attributes in document order, then
   `bind` settles `wmpprop:`/`wmpenabled:`, then `onload` runs.
5. `image/service` decodes the art referenced by visible elements in the Worker, applying per-declaration
   keys; `render/dom` builds the layer tree in the `SkinWindow` root; `shape/mask` rasterises the window
   shape and the surface sends it to Rust.
6. Steady state: `MediaModel` changes and the 4 Hz position tick flow into bindings; pointer events on the
   input plane go through `input/picker` to element state machines and realm handlers; script writes flow
   back through the membrane into the element model; the renderer and mask update once per frame from a
   dirty set.

## 3. Phasing, coexistence and the oracle pin

### 3.1 Phases

| Phase | Goal | Exit |
|---|---|---|
| 1 | Generic WMP engine + host, Headspace at parity with the hand port; corpus-wide load smoke | Cutover criteria (D10.7) met; hand port deleted |
| 2 | Winamp 2 `.wsz` through Webamp behind `SkinHost`; EQ profiles, PCM frames, cluster windows, palette artifact tier | 10 `.wsz` skins from `skins/wsz` pass the Webamp-museum screenshot diff within tolerance; MPD round-trip tests green |
| 3 | WMP corpus fidelity (fixture ladder R1..R9, `survey 6`), multi-view windows, view resizing, our own skin format | Ladder rungs pass their per-rung acceptance; coverage ledger above agreed thresholds |

### 3.2 Coexistence

`index.html` changes its one script tag to `/src/entry.js` (`index.html` is not pinned):

```js
// src/entry.js
let mode = 'legacy';
try { mode = localStorage.getItem('engine') ?? import.meta.env.VITE_ENGINE ?? 'legacy'; } catch {}
await (mode === 'engine' ? import('./app/boot.js') : import('./main.js'));
```

`main.js` keeps all its side effects on import, so behaviour on `main` is unchanged. The window menu gets
a hidden item (Option held) to flip the flag; `VITE_ENGINE=engine npm run tauri dev` does it for a run.

### 3.3 Pinned files and the re-pin gate

`parity` line 18 pins sha1 prefixes of `main.js`, `widgets.js`, `player.js`, `playlist.js`, `style.css`,
`viz/index.js`, `demo.js`, `tauri.conf.json`, `lib.rs`, `clickthrough.rs`, `convert_skin.py`. Rules:

1. Sonnet tasks may not edit pinned files. Each task card lists them under "must not touch".
2. New behaviour that needs a pinned file changed is staged as a **re-pin batch**: wave 4 task W4-R
   (Opus) applies all pinned-file edits at once (`lib.rs` commands and wiring, `clickthrough.rs`
   replaced by `hit.rs`, `tauri.conf.json` CSP), re-derives the pin table, re-captures goldens with `skinlab bless --reason`, and verifies the
   re-captured legacy goldens are pixel-identical to the previous ones. If they are not, the batch is
   reverted, because a pinned-file edit then changed the oracle.
3. Until W4-R, Rust work lands in **new** files (`src-tauri/src/hit.rs`, `skins.rs`, `prefs.rs`,
   `fanout.rs`) compiled but not yet wired into `lib.rs`; their unit tests run with `cargo test`.
4. The viz stub for legacy capture is a skinlab-only Vite alias (`tools/skinlab/vite.config.js`
   `resolve.alias['/src/viz/index.js']`), never an edit to `viz/index.js`.
5. `player.js` and `viz/index.js` stay untouched through phase 1. The engine's `MediaModel` wraps the
   exported `player` and `mpd` (trusted host code; the realm only ever sees typed methods), and once Rust
   fans frames out (D11) each `new Viz(...)` simply registers its own channel, so `viz/index.js` needs no
   change to run one visualizer per EFFECTS element.

## D1. Script realm

**Position: QuickJS compiled to WASM, on the main thread, one runtime per webview and one context per
VIEW, synchronous host calls, a wall-clock interrupt budget, memory and stack caps, behind a copy-only
membrane.** Packages: `quickjs-emscripten-core@0.32.0` (MIT, ~175 KB tarball of JS glue) plus the variant
`@jitl/quickjs-wasmfile-release-sync@0.32.0` (MIT; `emscripten-module.wasm` 503,134 B raw, 231,517 B
gzip -9, measured 2026-10-06 from `npm pack` into `/tmp`). The variant is loaded through
`newQuickJSWASMModuleFromVariant` so `@jitl/quickjs-ng-wasmfile-release-sync` can be swapped in by
changing one import if bellard QuickJS shows a semantic gap in the W1 gate.

Why `-sync` and not asyncify: every host read the corpus needs (player state, element geometry, prefs)
is already in memory on the main thread, so host functions never need to await. The asyncify build is
roughly twice the size and slower, and buys nothing here.

### D1.1 Options weighed

| Option | Isolation | CPU bound | Sync reads | Verdict |
|---|---|---|---|---|
| Host eval (`new Function` + `with` + Proxy in the page) | None. `(function(){return this})()` or `({}).constructor.constructor('return this')()` reaches `window` and `__TAURI_INTERNALS__.invoke` (raw `mpd` passthrough `lib.rs:29`, arbitrary-path `record_stop` `lib.rs:146`). SES `lockdown()` would freeze the app's own intrinsics (three.js, Webamp in phase 2) and still has no CPU bound. | None: `while(1){}` freezes the only UI thread | Yes | Rejected (also `notan` Q3(1)) |
| Web Worker realm | Strong if globals are stripped, but stripping `fetch`, `importScripts`, `WebSocket`, `indexedDB`, `caches`, `self.constructor` is a denylist that grows with WebKit | Strong (`terminate()`) | No. Needs the whole element model in the worker, or `SharedArrayBuffer` + `Atomics.wait`, which needs cross-origin isolation headers we have not verified under Tauri's custom protocol | Rejected for phase 1; kept as a phase-3 fallback by running *QuickJS inside a Worker* if main-thread budgets prove too tight |
| Sandboxed iframe (`sandbox="allow-scripts"`) | Opaque origin, but Tauri v2's IPC injection policy for iframes is configuration-dependent | None in WebKit: same-process iframe loops freeze the UI | No (postMessage only) | Rejected |
| **QuickJS-WASM, main thread** | **Total: the realm has no DOM, no `fetch`, no timers, no IPC; it can touch only what the prelude gives it** | **Interrupt handler checked by QuickJS on loops and calls** | **Yes** | **Chosen** |

Size cost: 231.5 KB gzip of WASM plus glue, loaded only when the engine mode is on (`entry.js` dynamic
import), so the legacy path pays nothing.

### D1.2 What the corpus requires of the realm, and how each is met

| Requirement | Evidence | Mechanism |
|---|---|---|
| ES3-ish sloppy JS, `eval` with built identifiers, `switch`, `try` | `survey 5.2`: 219 `.js` and 12,863/12,868 handlers compile in V8 sloppy; `eval` in 57/195 skins (G18) | QuickJS is a full ES2023 engine with sloppy mode, `with` and direct `eval`. Gate test W1-RG0 recompiles the whole corpus **in QuickJS** (the survey only proved V8). |
| Element-implicit handler scope | `wmploc 4.3`, `spec 2.4`, G15: `value`, `down`, `previous()`, `moveTo(left,top,5000)`, `currentEffectType` | Each handler compiles once to `new Function(<params>, "with(__HG){with(__IDS){with(__EL){" + body + "\n}}}")` inside the realm, called with `this` = element proxy. The innermost `with` is the firing element. |
| Bare-name precedence: element, then ids, then script globals, then host globals | `spec 2.4`, U-31 | `__EL.has(k)`: k is a member of the element's class (case-insensitive). `__IDS.has(k)`: an id of this view matches k exactly, or matches case-insensitively and **no** script global named exactly k exists (so `Volume` reaches id `volume`, `survey 3.1` Ice, while a skin's own `function volume()` still wins over a case-variant). `__HG.has(k)`: k is one of `player theme view event mediacenter playerApplication` (always lowercase in the corpus, `survey 3.1`). Ids that collide with a host global (`id="player"`, `id="view"`, G17) lose to the host global and log a diagnostic: the skins that do this only work if the host name wins. |
| Case-insensitive host members, case-sensitive script identifiers | `survey 3.1` (8% of host member refs are case variants), `wmploc 3.2`, U-28 | Proxies lowercase the key before the membrane; skin-declared names are ordinary QuickJS bindings. Case-variant calls of skin functions (`wmploc 4.1` bucket B1, 43 uses) still throw, as in WMP. |
| The scope objects themselves cannot be clobbered | a skin writing `__IDS = null` would break every handler | The prelude defines `__HG`, `__IDS` and the loader helpers on the realm global as non-writable, non-configurable properties; per-handler `__EL` is a `new Function` parameter, not a global. |
| Element ids as globals inside functions declared in `.js` files | G17; `headspace.js` calls `sEqEar.moveto` inside functions | Each script file is evaluated by global code `with(__HG){with(__IDS){eval(__src)}}` (direct eval). Per ES EvalDeclarationInstantiation, its `function`/`var` declarations land in the global variable environment while the functions close over the two `with` scopes. Fallback if QuickJS deviates: wrap the source in the two `with` blocks and rely on Annex B.3.3 block-function hoisting. W1-RG0 decides between them by test. |
| `#132` constants visible before any skin script | `wmploc 7.3` item 4 (seed early, a deliberate superset) | Prelude installs `os*`, `ps*`, `osOpeningUnknownURL`, `WMPPlaylistChangeEventTypes`; `#169` installs `sprintf` family on demand. |
| Synchronous reads of player and layout state | `parity 3.7`; `headspace.js` reads `sEqEar.left`, `player.OpenState` | Host functions are synchronous: `get(h,'left')` reads the element model's current (animated) value. |
| `jscript:` layout expressions | `spec 3.2`, 11,924 values | `realm.evalExpression(el, attr, src)` compiles `with(...){ return (<src minus trailing ;>) }` with the same scope chain. |
| PLAYER event parameters by exact name | `spec 2.2` (`NewState`, `ModeName`, `scType`) | Passed as named `Function` parameters, outside the `with` chain, so they shadow nothing else. |
| `this` is the firing element | `survey 5.3`, `StartAction(this)` | `fn.call(elProxy)`. |
| A failing handler must not kill the skin | `wmploc 4.3` item 3: 69/195 unique skins contain a name that throws | Each entry point catches; a skin-code exception is a **soft fault** (logged once per site and message, counted, never unloads). |
| Timers | `spec 2.6`: string-form `setTimeout` in 18 uses; VIEW `timerInterval`/`ontimer` in 79 skins | Prelude defines `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`; callbacks (function or string, compiled with the global scope chain) stay in a realm-side table; the host schedules ids on the **engine clock** (frozen in tests). Caps: 64 live timers per view, minimum delay 10 ms, `timerInterval` < 50 ignored with previous value kept (`spec 6.2`). |
| Deterministic time in the harness | `new Date` in 4 skins, `Math.random` in 2 (`survey 5.2`) | Prelude replaces `Date.now` and argument-less `new Date()` with the engine clock and seeds `Math.random` from the skin SHA in test mode. |

### D1.3 The membrane (copy-only)

What crosses, in either direction: `undefined`, `null`, booleans, finite numbers, strings up to
64 KiB, and **handles** (a realm-side frozen object `{__h: n}` that the prelude converts to a cached
Proxy). Nothing else: no host objects, no functions, no arrays (array-valued members such as
`WMPPlaylistChangeEventTypes` live realm-side), no exceptions with host stacks (host errors become a
realm `Error` with a fixed message).

The host side exposes exactly one native function to the prelude, which captures it in a closure and
deletes it from the realm's global before any skin code runs:

```ts
// src/engine/realm/membrane.js
type Wire = undefined | null | boolean | number | string | { handle: number };
const enum Op { Get = 1, Set = 2, Call = 3, Timer = 4, Now = 5, Log = 6 }
interface HostDispatcher {
  get(h: number, key: string): Wire | { method: true };   // key already lowercased by the proxy
  set(h: number, key: string, v: Wire): void;              // coercion and validation host-side
  call(h: number, key: string, args: Wire[]): Wire;        // args.length <= 16
  timer(op: 'set' | 'clear', id: number, ms: number, repeat: boolean): void;
  now(): number;                                           // engine clock, ms
}
```

`has` never crosses: at boot the host sends each class's lowercased member list and the view's id list,
and the prelude answers `has` from realm-side `Set`s. That keeps identifier resolution inside handlers
(three `with` lookups per free name) entirely inside WASM. `get`, `set` and `call` cross; their cost is
measured by the R9 perf gate (W3-RP).

Host-side validation on every op: the handle exists and is not revoked; the member exists in the class
schema (unknown member: `get` returns `undefined` and records `unknown-member` in the ledger, `set` is
ignored, `call` returns `undefined`); argument count and types are coerced per `spec 2.4` and U-20
(`'false'` to `false`, `'1'`/`'0'` accepted, otherwise previous value kept); per-API policy and rate caps
apply (D6.5). Event handles (`event`) are revoked when their dispatch ends; all handles of a view are
revoked when the view's context is disposed.

**No synchronous re-entry.** A host op never runs skin code before it returns. Changes caused by a
script write (a `value` assignment firing `value_onchange`, a binding update) are queued and dispatched
after the current entry point returns, FIFO, with a chain depth cap of 32 per originating event (it
stops `value_onchange` ping-pong between two bound sliders, and the cap hit is logged as a soft fault).

### D1.4 Budgets and fault unloading

| Entry point | Wall-clock budget | Notes |
|---|---|---|
| all scripts of a view (top-level code) | 2,000 ms total | `digitaldj` has 3,938 lines in 7 files (`survey 6.1`) |
| `onload`, `onclose` | 1,000 ms | |
| event handler, `_onchange`, `ontimer` tick, timer callback | 100 ms | |
| one `jscript:` expression | 20 ms | |

- The budget clock is `performance.now()` **even when the engine clock is frozen** in the harness; the
  two clocks are separate parameters of `RealmOptions`.
- `runtime.setMemoryLimit(64 MiB)` per runtime; `runtime.setMaxStackSize(1 MiB)`.
- **Hard faults**: interrupt (budget exceeded), out-of-memory, stack overflow, a realm that throws
  during the prelude. One OOM, or 3 hard faults within 30 s, **unloads the view**: the context is
  disposed, every handle revoked, timers cleared, the `SkinWindow` shows the AppShell fault panel
  ("This skin stopped: <reason>", window menu still works, "Use legacy Headspace" and "Choose another
  skin" items). Because one runtime holds all contexts of a webview, an OOM disposes the runtime.
- Soft faults never unload. Their counts feed the ledger.

### D1.5 Realm interface

```ts
// src/engine/realm/realm.js
interface RealmOptions {
  viewKey: string;
  memoryLimitBytes: number;         // default 64 MiB
  maxStackBytes: number;            // default 1 MiB
  budgets: { scripts: number; load: number; handler: number; expr: number };
  wallClock: () => number;          // performance.now in app and harness
  dispatcher: HostDispatcher;
  classMembers: Record<string, string[]>;   // className -> lowercased members (from model/schema)
  log: Log;
  testSeed?: string;                 // seeds Math.random, enables frozen Date
}
type Fault = { ok: false; kind: 'soft' | 'hard'; reason: string; site: string };
type Ok<T = Wire> = { ok: true; value: T };
interface Realm {
  setIds(ids: string[]): void;                                        // case-preserved, once per view
  loadScript(name: string, source: string): Ok<void> | Fault;
  evalExpression(el: number, attr: string, src: string): Ok | Fault;
  runHandler(el: number, attr: string, src: string,
             ctx?: { event?: number; params?: Record<string, Wire> }): Ok<void> | Fault;
  fireTimer(id: number): Ok<void> | Fault;
  callGlobal(name: string, args: Wire[]): Ok | Fault;                 // demo tour, sidecar hooks
  readGlobal(name: string): Wire;                                      // primitives only
  readonly health: { soft: number; hard: number; disposed: boolean };
  dispose(): void;
}
function createRealm(opts: RealmOptions): Promise<Realm>;
```

### D1.6 What this forbids

- `eval`, `new Function`, `<script>` injection or `import()` of skin text anywhere in the page realm
  (enforced by `tools/check-boundaries.mjs`; webamp-modern's `document.head` injection, `webamp 6`, is the
  anti-pattern).
- Passing a host object, function or DOM node into the realm.
- Running skin code re-entrantly from inside a host op.
- Any realm path to `invoke`, `fetch`, the filesystem, or another skin's prefs.

## D2. Renderer and hit-testing

**Position: hybrid. A retained DOM layer tree whose leaves are `canvas` elements holding pixels the
engine composited itself from decoded RGBA, DOM `span`s for TEXT, host-widget slots for windowed
controls, and engine-owned hit-testing through one input plane per window.** The DOM is used for what it
is good at (stacking, clipping, compositing, scaling, text shaping), never for loading skin resources or
deciding which element was clicked.

### D2.1 Why not the alternatives

- **Pure DOM `<img>` per state (the hand port's `widgets.js`)**: needs a URL per image, so either blob URLs
  for every keyed variant or a public asset path; leaves hit-testing to the browser, which tests boxes,
  not pixels, which is why the hand port needs `pointer-events: none` on the head art plus two root
  handlers and an alpha-tested drag (`main:189-232`, `parity` D10).
- **One canvas compositor per window**: deterministic and simple to hit-test, but TEXT would be drawn
  by `fillText`, which does not match the oracle's DOM text pixels (`parity 4.1`: "A text diff is a
  failure, not noise"); the playlist widget (`parity` D12) is DOM anyway; every animation frame would
  repaint the whole window.
- **Hybrid**: canvas leaves give pixel identity with the oracle's PNG `<img>`s at DPR 1 (same RGBA, same
  position, `image-rendering: pixelated` on both); DOM text gives text identity; DOM subview `div`s give
  free clipping and group opacity; the engine's picker gives exact WMP hit semantics.

### D2.2 Layer tree

```
SkinWindow.root (host-owned, transparent)
└─ div.view            width/height = VIEW size, transform: scale(zoom), transform-origin 0 0
   ├─ div.layers       pointer-events: none; the painted scene, DOM order = paint order
   │  ├─ div.sv#sEqEar      position:absolute; left/top; w/h; overflow:hidden; isolation:isolate
   │  │  ├─ canvas.bg       the subview background (if any) at its z = 0 slot
   │  │  ├─ canvas.button   ...
   │  │  └─ div.sv ...      nested subview = nested stacking context
   │  └─ ...
   ├─ div.input        position:absolute; inset:0; pointer-events:auto; title/cursor from hover
   └─ div.windowed     host widgets that WMP draws as native child windows (PLAYLIST now;
                       EDITBOX, LISTBOX, POPUP in phase 3), each absolutely positioned at its
                       element rect, pointer-events:auto
```

- **Paint order is DOM order, never CSS `z-index`.** Children of a VIEW or SUBVIEW are sorted by
  `(zIndex, kind, documentOrder)` where the parent's background has the fixed slot `(0, 0)` and every
  child has kind 1, so a child with `zIndex=0` paints over the background and a negative child under it
  (`spec 5.3`, `parity 0.1` rule 4). Equal z: later in the document paints on top (U-1). A runtime
  `zIndex` write re-sorts that parent only. No engine node ever sets `z-index`, which keeps the demo's
  `z-index: 1000/2000` overlay budget intact (`parity 3.1`).
- **Every SUBVIEW is a stacking context** (`isolation: isolate`; Reading C, D5.4) and clips its subtree
  to its box when it has an explicit or image-derived size (`overflow: hidden`), behind the switch
  `subviewClip` (default on; the parity doc flags the clip as assumed, `parity 0.1` rule 4).
- **Subview `clippingColor`** becomes a `-webkit-mask-image` on the subview `div` from a data URL the
  engine generates from the background's clip bits at native size (not stretched), so it clips overlays
  too (`parity` D26). `transparencyColor` on a subview keys only its background canvas.
- **Windowed controls sit above everything**, which is WMP's own rule: PLAYLIST, EDITBOX, LISTBOX, POPUP,
  windowed VIDEO/EFFECTS "always paint above windowless controls" and ignore z, alpha and clipping
  (`spec 2.8`). That is also what lets them receive native DOM events (scrolling, double-click, the
  combo drop-down) above the input plane.

### D2.3 Drawables (one module each under `src/engine/render/dom/`)

| Element | DOM | How it is drawn |
|---|---|---|
| VIEW/SUBVIEW background | `canvas.bg` | Keyed image blitted once; `backgroundTiled` repeats to the box; `backgroundColor` (not `none`) is a CSS background on the `div`. |
| BUTTON (and predefined buttons) | `canvas` w×h | One keyed image per state; state resolution `disabled > hoverDown > down > hover > up` with the fallback chain of `spec 6.4`; `tiled` repeats; a BUTTON with no image but a size is an empty canvas that still hit-tests (`spec 2.7`). |
| BUTTONGROUP | one `canvas` | Per-pixel composite as in `widgets:102-207`, but incremental: at load the map is indexed into an owner array plus one pixel list per element (exact RGB match, `spec 6.5`); a state change recomposites only that element's pixels from the matching state layer. Unowned pixels: `showBackground=false` (default) leaves them transparent and unclickable; `true` paints them from `image`, still unclickable (`spec 2.7`, U-23). |
| SLIDER / PROGRESSBAR | `canvas.track`, `canvas.fg`, `canvas.thumb` | Track: `backgroundImage` as is, or with `tiled` the first and last `borderSize` px are end caps and the middle column(s) repeat (matches the hand port's `border-image` slice, `css:83-95`). Foreground: `slide=false` reveals a fixed image up to the reveal edge (a `clip` width); `slide=true` translates it so its leading edge follows the thumb. Thumb travel by the `sliderGeometry` switch: `'oracle'` (default) = `length - thumbExtent`, `'docs'` = centre over `[b, L-b]` (U-10, `parity` D32). Vertical sliders put max at the top. |
| CUSTOMSLIDER (phase 3) | one `canvas` | Frame `round(f·(N-1))` blitted from the strip along its longer axis; hit and value from the gray `positionImage`: pure gray `g` maps to `min + g/255·(max-min)`, non-gray is dead (`spec 6.8`, U-9). |
| TEXT (and predefined texts) | `span` | `textContent` only. Font: `round(pt·4/3)` px (7 pt is 9 px, `parity` G8), face from the sanitised family list (D2.5), style, colour, hover and disabled colours, `justification`, `white-space: nowrap`, ellipsis when cropped (`spec 6.10`), `-webkit-font-smoothing: none`. `scrolling` is a marquee moved on the engine clock (`scrollingAmount` px every `scrollingDelay` ms, two-space gap). |
| EFFECTS | `div.slot.effects` | Host slot: the AppShell's VizHost mounts a `canvas` and the overlays (now playing, notice, caption) inside it (D10). Windowless by default, so it stacks and clips like any control. |
| VIDEO | `div.slot.video` | Inert stub: `backgroundColor`, never fires `onvideostart` (`parity` D19). |
| PLAYLIST | slot in `div.windowed` | Host widget (D10.4). |

Pixels are put into canvases from `ImageBitmap`s the image service produced (D3); a canvas is sized in
skin pixels, CSS-scaled by the view transform, with `image-rendering: pixelated` (`css:39-46`).

### D2.4 Animation

`moveTo(x, y, ms)` is linear; `slideTo` and `moveSizeTo(..., fSlide=true)` use a cubic ease-in-out
(U-25); `alphaBlendTo(a, ms)` is linear in alpha. An `Animator` steps all active tweens on the
**engine clock** (`host.clock.onFrame`), writes the element model, and the renderer applies
`left/top/width/height/opacity` only for values that changed (fixes `parity` D34). Completion fires
`onEndMove` for all three move methods and `onEndAlphaBlend` for blends, queued after the frame. A new
move on an element cancels the old one without firing its end event; the new one fires at its end.
Because the clock is injected, the harness can step 60 ms and capture the mid-animation sample of
`parity 4.6` exactly. `alphaBlend` maps to CSS `opacity` on the element's node (a SUBVIEW and a
BUTTONGROUP blend as a unit, `spec 5.4`); keyed pixels stay keyed under alpha (U-13); TEXT with
`alphaBlend` and no `backgroundColor` gets a black background (`spec 5.4`).

### D2.5 Strings, fonts and cursors

- Text and tooltips are set with `textContent` and the `title` property only.
- `fontFace` is split on commas (`survey` G27); each family must match `^[A-Za-z0-9 ._-]{1,64}$` or is
  dropped; survivors are quoted and followed by the system fallback `Tahoma, Verdana, sans-serif`
  (`parity` D22). `res://` faces resolve through the string table first (`wmploc 5.4`: #1888 is "Arial").
- `cursor`: keywords map to CSS keywords (`hand` to `pointer`, `system` to `default`, `size*` to the
  resize cursors, unknown keeps the previous, U-21). `.cur`/`.ani` files are phase 3 and will be decoded
  by us into a PNG blob URL; a skin string is never placed in `url()`.

### D2.6 Hit-testing (engine-owned)

Each drawable carries two bit planes at skin resolution, produced with its pixels (D3.3):
`paint` (alpha > 0 after keying) and `hit`. The `hit` rules:

| Pixel | `hit` | Source |
|---|---|---|
| opaque or partly opaque | 1 | |
| keyed by `transparencyColor`, element is BUTTON, BUTTONGROUP (owned pixel) or SLIDER thumb | 1 (still receives clicks) | `spec 2.7`, `button-transparencycolor` |
| keyed by `transparencyColor` on a VIEW/SUBVIEW background | 0: passes to lower layers | needed so Headspace's magenta face window passes clicks to the z −2 screen (`parity 0.3`, open question 3) |
| keyed by `clippingColor` / outside `clippingImage` | 0, and clips the subtree for subviews | `spec 5.5` |
| BUTTONGROUP pixel not owned by any `mappingColor` | 0 | `spec 2.7` |
| BUTTON without image but with a size | 1 over its box | `spec 2.7` |
| TEXT | 1 over its box | |

The **picker** walks the view's paint order top-down, maps the point into each element's local
coordinates, skips `visible=false` and `passThrough=true` elements and points outside an ancestor's clip
box or clip mask, and returns the first element whose `hit` bit is set. Then:

- an element with interactive behaviour (buttons, sliders, elements with any mouse handler, host slots)
  receives the gesture, unless `enabled=false`, in which case the press is **swallowed** (drawn, no
  events, no drag; `spec 2.7`);
- an inert element (background, image, label without handlers) is **chrome**: a left press starts a
  window drag (`spec` U-11; this is `parity` D29's intended, reviewed deviation: every unclaimed opaque
  pixel drags);
- nothing hit: no-op (the OS mask should already have let the click through).

Gesture model: `onmousedown`, `onmouseup`, `onclick` (only when down and up are on the same element),
`ondblclick`, hover enter/leave, no bubbling to parents (U-18). Any press on a control calls
`SkinWindow.setCapture(true)` until `pointerup`/`pointercancel` (fixes `parity` D30). The DOM `click`
event is ignored; clicks are derived from down/up, so the demo tour's extra synthetic `click`
(`demo:93-96`) cannot double-fire. Keyboard events go to the VIEW's and focused element's `onkey*`
handlers first and to AppShell defaults only if no skin handler ran for that key (D10.3).

### D2.7 Window shape

`shape/mask` produces the shape from the scene, not the DOM: per visible element in paint order,
OR (`paint` ∪ `hit` of interactive elements) clipped by ancestor clip boxes and masks; windowed-control
slots and host overlays contribute their rects. This is "union of painted non-clipped pixels plus
clickable keyed pixels" (U-12 extended by the BUTTON rule). It is recomputed from a dirty flag at most
once per frame, **including during animations** (fixes `parity` D11/D33 staleness), and sent only when
its hash changes. Expected difference from the oracle: the oracle counts the effects canvas as a solid
rectangle, so it over-approximates by exactly the 106 clipped screen-corner pixels (`parity 4.1`); that
set is the only mask allow-list entry until the harness shows otherwise.

### D2.8 What this forbids

`innerHTML`, `insertAdjacentHTML`, `<img src>` of any skin-derived URL, CSS `z-index` on engine nodes,
browser hit-testing (`elementFromPoint`, `pointer-events` tricks) for skin elements, CSS transitions
for skin animation (they ignore the injected clock).

## D3. Image pipeline

**Position: our own pure-JS decoders for every format, run in a Worker in the app and inline in Node
tests; per-declaration keying in the same pass; header-only probing for layout sizes before any
decode; hard caps checked before allocation.**

### D3.1 Decoders

| Format | Implementation | Corpus facts that shape it |
|---|---|---|
| BMP | Own, ~400 lines: BITMAPINFOHEADER (40 B) plus V4/V5 header lengths tolerated, OS/2 12 B accepted; bottom-up and top-down; 1/4/8/16/24/32 bpp; BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS (16-bit defaults to 5-5-5 when no masks); row stride 4-byte aligned; palette lookup; **alpha forced to 255** | WMP: 24 bpp 2,902, 8 bpp 587, 4 bpp 66, 1 bpp 3 referenced; RLE in 15/195 skins (`survey 3.3`). Winamp: RLE8 12% incl. base-2.91; 32-bit with all-zero alpha 28 of 29; one 16-bit file decoded differently by ImageIO and PIL (`wsz 3.1`). |
| PNG | Own chunk parser (IHDR, PLTE, tRNS, IDAT, IEND; ignore others), `fflate@0.8.3` `inflateSync` with an output bound, own unfilter; all colour types and bit depths; interlace (Adam7) | Alpha PNG in 61/195 skins, `tRNS` in 43 (`survey 3.3`) |
| GIF | Own LZW decoder, ~250 lines; frames, disposal, transparency index, NETSCAPE loop; phase 1 renders frame 0, phase 3 animates | 1,569 multi-frame GIFs, max 145 frames (`survey 3.3`) |
| JPEG | Vendored pure-JS baseline+progressive decoder (`jpeg-js`, licence checked at vendoring) | 450 referenced JPGs in 66 skins |
| Format detection | Magic bytes only; extension ignored | `Nautical` `vol_slider.bmp` is a GIF, `drawer.bmp` a JPEG (`survey 3.3`, G7) |

Why own decoders and not `createImageBitmap(blob)`: (1) the harness is Chromium and the app is
WKWebView, and browser JPEG and 16-bit BMP decoding differ between engines (`wsz 3.1` decoder probe), so
browser decoding would make the oracle comparison engine-dependent; (2) BMP alpha must be forced opaque,
which browsers do not do for 32-bit BMPs; (3) every decoder becomes a Node unit test; (4) the browser's
native decoders (ImageIO) never see attacker bytes, only RGBA we produced. Cost: about 1,000 lines plus
`fflate` (~8 KB gzip for inflate) and a vendored JPEG decoder.

### D3.2 Caps (checked from headers before allocating)

| Cap | Value | Evidence it clears the corpus |
|---|---|---|
| width or height | ≤ 16,384 px | widest real image: `Nautical` `vol_slider.bmp` GIF 9,494×144 (`survey 3.3`), so an 8,192 cap would reject a real skin |
| area | ≤ 16,777,216 px (64 MiB RGBA) | largest real image 2,528×3,300 = 8.3 M px (`survey 3.3`, unreferenced) |
| GIF frames | ≤ 512 | max 145 |
| decoded bytes per skin | ≤ 256 MiB live, LRU-evicted beyond | |
| per-decode wall time | 2 s, then the Worker is terminated and recreated, the image is "missing" | |
| RLE | a run or escape that would write outside the bitmap ends decoding of that image | |

A failed or capped decode yields a **missing image**, which renders as nothing and logs one diagnostic
(`survey 3.2`: missing files are common and must not abort the skin).

### D3.3 Keying (per declaration)

Keying is a pure function of `(asset bytes hash, KeySpec)`, cached by that pair:

```ts
interface KeySpec {
  transparency?: Rgb | 'auto' | null;   // 'auto' = pixel (0,0); null/none = no key
  clipping?: Rgb | 'auto' | null;
  hitKeyed: boolean;                    // true for BUTTON, BUTTONGROUP, SLIDER thumb (D2.6)
  clipImage?: AssetRef;                 // clippingImage (corpus 36/195 skins)
}
interface KeyedImage {
  width: number; height: number;
  bitmap: ImageBitmap;                  // paint pixels (keyed to alpha 0)
  paint: Uint8Array;                    // 1 bit per pixel, alpha > 0
  hit: Uint8Array;                      // 1 bit per pixel, D2.6 rules
  clip?: Uint8Array;                    // subview background clip bits, for the mask-image and picker
}
```

Rules: exact RGB match, no tolerance; keys apply to whichever image is currently shown (script may swap
`image`; the key stays, `spec 5.5`); PNG/GIF alpha is composited **and** keys are applied (U-27, 58
skins have both, `survey 3.3`); map images (`mappingImage`, `positionImage`) are never keyed and are
kept as raw RGB for ownership lookups; a SLIDER without a declared `transparencyColor` is not keyed
(`parity 0.1` rule 5). This replaces the hand port's offline universal magenta keying (`parity` D27).

### D3.4 Where it runs

- `image/probe.js` (main thread, synchronous, header bytes only) returns `{format, width, height}` for
  layout: element `width`/`height` default to the image size before anything is decoded.
- `image/decode/*` and `image/keying.js` are pure functions over `Uint8Array`, with no DOM.
- `ImageService` asks the host for a `DecodeExecutor`. The Tauri adapter provides a one-Worker pool
  (module Worker, bytes transferred in, RGBA and bit planes transferred out, `ImageBitmap` created on the
  main thread); the test adapter runs inline. Moving decode out of the main thread also lets a decoder
  hang be cut off by `terminate()`.
- Decodes are lazy (only images an element currently shows, plus its state images for instant hover,
  like `widgets:50`) and memoised by `(sha256(entry bytes), KeySpec)`. A script assigning
  `el.image = "x.bmp"` returns immediately; the old pixels stay until the new decode lands (one frame
  normally).

## D4. Skin loading and untrusted input

**Position: Rust only stores and returns archive bytes by content hash; the engine parses the zip in JS
in memory under caps into a flat, case-insensitive VFS; nothing is ever extracted to disk.** The design
cannot express a filesystem path derived from an entry name, so traversal and symlink attacks have
nothing to act on. (`notan` Q3(1) suggests extracting to `appdata/skins/<sha256>/`; this candidate keeps
the content-hash namespace but stores the archive, not its contents, which removes the extraction step
and its whole bug class. `wsz 6` item 2 recommends the same for Winamp.)

### D4.1 Rust side (`src-tauri/src/skins.rs`, new)

```rust
#[tauri::command] fn skin_import(app: AppHandle, path: String) -> Result<SkinRecord, String>;
#[tauri::command] fn skin_list(app: AppHandle) -> Vec<SkinRecord>;
#[tauri::command] fn skin_read(app: AppHandle, sha: String) -> Result<tauri::ipc::Response, String>; // raw bytes
#[tauri::command] fn skin_remove(app: AppHandle, sha: String) -> Result<(), String>;
#[derive(Serialize)] struct SkinRecord { sha: String, name: String, family: String, bytes: u64, imported_at: u64 }
```

- `skin_import` is called only by AppShell code (native open dialog, drag and drop, or the phase-1
  `WINDOW_HEADMPD_SKIN` env var pointing at `~/Downloads/Headspace.wmz`). It reads at most 32 MiB,
  requires a `PK` signature somewhere in the last 64 KiB (an end-of-central-directory record), hashes with
  SHA-256, writes `app_data_dir/skins/<sha>.<wmz|wsz|zip>` by write-to-temp-then-rename, and updates
  `skins/index.json`. `family` is a guess from the extension and the presence of a `.wms` entry name in
  the central directory; the engine re-derives it.
- `skin_read` accepts only `^[0-9a-f]{64}$`; anything else is an error, so no JS string ever becomes a
  path. Bytes return as a raw `tauri::ipc::Response` (no JSON number arrays).
- Rust never parses entries. One zip implementation (the engine's) serves the app, the harness and the
  Node tests.

### D4.2 Zip reader (`src/engine/archive/zip.js`)

```ts
interface ZipCaps {
  maxArchiveBytes: number;      // 32 MiB   (corpus max: WMP 2.9 MB, survey 1.1; WSZ < 0.5 MB, wsz 2.2)
  maxEntries: number;           // 4,096    (corpus max 303)
  maxEntryBytes: number;        // 32 MiB   (largest real entry: a 2,528×3,300 24-bit BMP ≈ 25 MB)
  maxTotalInflated: number;     // 256 MiB  (lazy: counts only entries actually read)
  maxRatio: number;             // 1,024:1, enforced for entries over 1 MiB
  maxNameBytes: number;         // 255
}
interface ZipEntry { name: string; key: string; method: 0 | 8; csize: number; usize: number; crc: number; offset: number }
interface ZipIndex { entries: ZipEntry[]; diagnostics: Diagnostic[]; read(e: ZipEntry): Uint8Array | null }
function readZip(bytes: Uint8Array, caps?: Partial<ZipCaps>): ZipIndex;   // throws only for "not a zip"
```

Rules:
- Find the end-of-central-directory record in the last 65,557 bytes; ZIP64 and multi-disk archives are
  rejected (no corpus need). Walk the central directory only; never scan for local headers.
- Methods: stored and deflate. Encrypted entries, other methods: skipped with a diagnostic.
- **Corrupt local header salvage** (3 distinct corpus archives have `01 00 01 00` instead of `PK\3\4`,
  `survey 1.2`): if the local signature is wrong but the local header's name bytes equal the central
  directory's name, read the data at `offset + 30 + nameLen + extraLen` and log; otherwise skip the entry.
- Inflate with `fflate` into a buffer of exactly the declared size; overflow, underflow or a size over
  the caps marks the entry corrupt (read returns `null`). CRC mismatch is logged, not fatal.
- Names: UTF-8 when flag bit 11 is set, else CP437; `\` becomes `/`; names with NUL, a leading `/`, a drive
  letter or a `..` segment are skipped; directory entries, symlinks (Unix mode `S_IFLNK` in the external
  attributes), `__MACOSX/`, `RESOURCE.FRK/` (`survey 1.2`) and `.DS_Store` are skipped.

### D4.3 VFS (`src/engine/archive/vfs.js`)

```ts
interface SkinVfs {
  readonly sha: string;                         // SHA-256 of the archive bytes, lowercase hex
  has(ref: string): boolean;
  read(ref: string): Uint8Array | null;         // null = missing; never throws
  list(ext?: string): string[];                 // keys, e.g. list('.wms')
  resolve(ref: string): string | null;          // ref -> key (diagnostics for case or path mismatch)
}
function openVfs(bytes: Uint8Array, caps?: Partial<ZipCaps>): Promise<SkinVfs>;
```

Key = NFC-normalised, lowercased **basename** of the entry; references are reduced the same way, so
`Bass_SliderBG.bmp` finds `bass_sliderbg.bmp` (62/195 skins need this, `survey 3.2`) and
`pl\pl_dropdown_wood.png` finds `pl_dropdown_wood.png`. Collisions after folding: last entry in the
central directory wins, with a diagnostic (Webamp's rule, `wsz 4.1`; the `Old_Mac-OS` two-skins-in-one
case). `res://` references never reach the VFS (D6.6).

### D4.4 Picking the definition file and decoding text

- Several `.wms` (2 distinct archives, `survey 1.2`): choose the one with the fewest unresolved file
  references, then the one whose stem matches the archive name, then the larger (works on all four
  corpus cases; U-17).
- Text: BOM sniff (UTF-16LE, UTF-16BE, UTF-8), else ASCII, else Windows-1252 (`survey 2.1`: no UTF-8
  without BOM exists in the corpus). Same for `.js`.
- Implicit `<stem>.js` is loaded when not listed (11/195 skins, `survey 1.2`).

### D4.5 Identity, caching and prefs namespace

- Skin identity is the archive SHA-256 (64 hex; the first 12 in logs). It keys prefs (D7.6),
  sidecars (D10.6), goldens (D9) and caches.
- Caches: decoded images live in an in-memory LRU per session (D3.2). A persistent decode cache
  (`app_data_dir/cache/<sha>/`, derived art, never in git) is a phase-3 optimisation, only if load time
  for R9 (`xsn_sports`, 2.9 MB) exceeds 1 s.

### D4.6 What this forbids

Writing any entry to disk; trusting an entry's declared size, extension or local header; any JS-side
path concatenation for skins; a second zip implementation in Rust.

## D5. Parse, layout and bindings

### D5.1 Tolerant scanner (`src/engine/wms/scan.js`)

A hand-written tokenizer over the decoded string, not an XML parser (`survey 2.4`, `spec 8.4`):

- Comments, processing instructions and text content are skipped; entities (`&amp; &lt; &gt; &quot;
  &apos;` and numeric) are decoded in attribute values **before** any value reaches script (`survey 2.3`,
  G16).
- Tag and attribute names are lowercased. Attribute syntax accepts `name="v"`, `name='v'`, whitespace or
  tabs around `=` (`Portals.wms`), missing whitespace between attributes (22 distinct skins, G3), and an
  unquoted value up to whitespace or `>` (never seen; cheap insurance).
- **Duplicate attributes, including case-variant duplicates: the last one wins**, with a diagnostic.
  Evidence: 299 conflicting duplicates in 67 skins, every sampled one reads as "the second value is the
  author's intent" (`survey 2.2`, `Secura` `max="100"` then `max="wmpprop:…duration"`); U-5.
- A close tag pops to the nearest open element with a case-insensitive name match; an orphan close tag is
  ignored; scanning stops after the first close of the root (`survey` G5, `MotherLand`).
- Output: `RawNode { tag, attrs: [name, value, line][], children, line }` plus diagnostics with line
  numbers. Acceptance: 195/195 distinct corpus `.wms` produce a THEME root with at least one VIEW (the
  repair ladder reached 195/195, `survey 2.3`).

### D5.2 Building the element model (`src/engine/wms/build.js`, `tags.js`, `attrs.js`)

- `tags.js`: one table mapping every tag to a base type plus default attributes: the predefined buttons,
  elements, sliders, texts, playlists, `wmpeffects`, `wmpvideo` (`spec 6.4`, `6.6`, `6.7`, `6.10`, `6.13`,
  `6.14`, `6.15`; G23). Unknown tags become inert nodes (kept in the tree, never rendered, ledger
  `unknown-tag`).
- `attrs.js`: per base type, `name -> {type, default, access}`; types `int float bool color string file
  enum handler`. Unknown or misspelled attributes are ignored (G12). Coercion follows U-20 (`true/false/1/0`
  any case; invalid keeps the previous value) and U-22 (minus signs).
- Value classes: literal; `jscript:` (case-insensitive, optional leading whitespace, trailing `;`
  stripped); `wmpprop:`; `wmpenabled:`/`wmpdisabled:`; `res://` (string attributes, resolved via
  `wmploc`); handler (`on*`, `*_onchange`, and the bare PLAYER event names such as `openstatechange`,
  `spec 6.19`). A misspelled prefix (`wmppprop:`, `wmpenable:`, 18 skins, G14) stays a literal string with a
  diagnostic.
- Ids: declared ids are case-preserved; id-less elements get WMP's own `Unnamed_<type>_<n>` (`spec 5.1`),
  which is also the stable address the demo tour and sidecars use. Ids are scoped per VIEW (30 skins
  repeat ids inside a view: last declared wins for lookup, with a diagnostic; `survey` G17).
- **Literal pass**: every element is created in document order with literal values only; `width`/`height`
  default from `image.probe` of the element's image (D3.4).

### D5.3 Evaluation order and the `jscript:` rule

Order per view: (1) literal pass; (2) prelude and `#132`; (3) skin scripts' top-level code, in
`scriptFile` order, implicit `<stem>.js` last; (4) the `jscript:` pass in document order; (5) bindings
settle; (6) `onload`; (7) first frame painted; (8) `SkinWindow.show()`.

Scripts load before the `jscript:` pass because expressions read script globals (`Portals.wms:715`
`left="JScript:eqLeft+0"`, G13), and no corpus script touches an element at top level (`spec 2.1` step 3,
U-33). An expression that reads a `jscript:` attribute not yet evaluated reads the attribute's default
(0), which is exactly the 9SeriesDefault forward-read case (`spec 2.1` step 4, U-3).

**`jscript:` attributes are evaluated once.** The research disagrees: `spec 3.2`/U-3 says once,
`survey` G13 says re-evaluate when a dependency changes. This candidate takes **once**, because 2,773 of
2,791 `left="jscript:view.width-N"` values are paired with `horizontalAlignment="right"` (and 2,602 `top`s
with `verticalAlignment="bottom"`, 550 widths with `stretch`): authors used the expression for the initial
position and the alignment attribute to keep it anchored, which a live expression would make redundant.
Live following is what `wmpprop:` element bindings are for (`top="wmpprop:svX.top"`, `spec 3.3`). After
the pass, `layout/align.js` records each element's margins for its alignment; a parent resize (phase 3)
re-places by alignment, never by re-running script. G13's "moveTo" case is covered by `wmpprop:`.

### D5.4 Stacking: the docs-versus-Headspace conflict

The docs say a VIEW/SUBVIEW z is absolute and a control's z is relative to its container (`spec 5.3`).
Read literally (Reading A) or as an additive flat sort (Reading B), Headspace's closed state paints the
playlist panel over the screen; only **Reading C, every SUBVIEW is a stacking context**, reproduces the
skin (`parity 0.1` rule 4 works all three; `spec 5.3` agrees independently from the `visDrop` slide). The
engine implements C: each SUBVIEW's children (controls and nested SUBVIEWs alike) are ordered by their own
z relative to that SUBVIEW's background at 0, then document order, and never interleave with the
SUBVIEW's siblings; only VIEW-level SUBVIEWs order against the VIEW background. A `stacking: 'context' |
'flat'` engine option exists for phase-3 experiments; nothing else reads it. BUTTONELEMENTs use their
group's z (`spec 5.3`). Equal z: document order (U-1).

### D5.5 Bindings (`src/engine/bind/`)

- `wmpprop:` paths are parsed **host-side** by a small grammar (`ident ('.' ident)* ('(' literal (',' literal)* ')')? ';'?`),
  never by the realm. Roots: `player`, `mediacenter`, `theme`, `view`, and element ids (`eq`, `vidset`,
  `visEffects` are element ids). Calls with literal arguments are allowed for the documented exception
  `player.settings.getMode('loop')` (`spec 3.3`).
- Each object-model property declares its change source (a `MediaState` field, an element attribute, a
  `mediacenter` key, a pref). A binding subscribes, recomputes on change, coerces to the target
  attribute's type, and assigns **only if the value differs**. The assignment fires `<attr>_onchange`
  (queued, D1.3), as the docs require (`spec 2.3`).
- **No feedback loops**: a binding never writes the player; `value_onchange` handlers that write the
  player back go through `MediaModel` setters, which are no-ops when the value equals the current or
  pending one (`spec 6.7` consequence 1).
- **Drag suspension**: while the user drags a slider, bindings targeting its `value` (and `max`) are
  suspended; at drag end they re-sync (`parity` D18, `spec 6.7` consequence 2).
- `wmpenabled:`/`wmpdisabled:` bind any boolean attribute (`visible` 287, `enabled` 132, `tabStop` 46,
  `down` 3; `spec 3.4`) to `MediaModel.isAvailable(name)`, where `name` is the last path segment,
  lowercased, with `()` and `;` dropped (U-4); re-evaluated on play-state, queue and position changes.
- Position: `MediaModel` publishes `currentPosition` changes at 4 Hz while playing, and immediately on
  seek and state change (U-19 default). This bounds `currentPosition_onchange` script traffic (176 skins
  listen) to 4 calls per second.

## D6. Object model

### D6.1 Shape

The object model lives **host-side** in `src/engine/model/`. The realm sees it only as Proxies over
handles (D1.3). Every class is declared in one schema table, so the membrane's validation, the realm's
`has` sets, the binding resolver, the stub generator and the coverage ledger all read the same source:

```ts
// src/engine/model/schema.js
type MemberImpl = 'live' | 'stub' | 'denied';
interface MemberSpec {
  name: string;                       // canonical spelling, e.g. 'currentPosition'
  kind: 'prop' | 'method';
  type: 'number' | 'string' | 'bool' | 'object' | 'void';
  access?: 'r' | 'rw';
  impl: MemberImpl;
  changeSource?: string;              // for bindings, e.g. 'media.elapsed'
  stubValue?: Wire;                   // what a stub returns (type-correct, inert)
  policy?: PolicyId;                  // D6.5
}
type ClassSchema = Record<string /* lowercased member */, MemberSpec>;
const SCHEMA: Record<ClassName, ClassSchema>;   // player, controls, settings, media, network, playlistObj,
                                                // theme, view, event, mediacenter, element.<type>, ...
```

Case-insensitivity is structural: keys are lowercased once at schema build and at each Proxy access;
the canonical spelling is kept only for diagnostics. Element attributes follow the same table
(`xPlTt.tooltip` reaches `toolTip`, `parity 0.1` rule 3).

Host objects behind the handles:

| Global / object | Live in phase 1 | Notes |
|---|---|---|
| `player` | `playState`, `openState` (integers, `wmploc 7.5` mapping), `status` (synthesised English strings), `URL` (read: current file URI; write: `denied`), `controls`, `settings`, `currentMedia`, `network`, `currentPlaylist` (count, name), `versionInfo` | `launchURL` `denied`; `mediaCollection`, `playlistCollection`, `cdromCollection`, `dvd` are inert stub objects |
| `player.controls` | `play() pause() stop() next() previous()`, `currentPosition` (r: elapsed; w: seek), `currentPositionString` (`m:ss`, `h:mm:ss` over an hour, `spec 7.2`), `isAvailable(name)` | `fastForward/fastReverse` stub (MPD has no scan) |
| `player.settings` | `volume` (MPD `setvol`; ignored when MPD reports no mixer, `parity` D9), `mute` (emulated: remember volume, `setvol 0`, restore), `balance` (host-local, Rust `set_balance`, persisted, detent per `parity` D17), `getMode/setMode('loop'|'shuffle')` (MPD `repeat`/`random`) | `rate`, `autoStart`, … stub |
| `player.currentMedia` | `duration`, `durationString`, `name`, `sourceURL`, `getItemInfo(key)` (`Author`/`Artist` → artist, `Title`, `Album`/`WM/AlbumTitle`, `Genre`, `WM/TrackNumber`, `Bitrate`; others `""`), `imageSourceWidth`/`Height` = 0 | `setItemInfo` `denied` |
| `player.network` | `downloadProgress` = 100, `bufferingProgress` = 100 | rest stub |
| `theme` | `savePreference`, `loadPreference` (D6.4), `loadString` (`wmploc 7.7`), `logString` (to log), `author`, `title`, `copyright`, `currentViewID` (read) | `openView`/`closeView`/`openViewRelative`: phase 1 log + no-op for views other than the current one; phase 3 via `WindowManager` (D7). `openDialog` returns `""` (`denied`), `playSound` stub until phase 3, `showErrorDialog` no-op |
| `view` | `width`, `height` (read; write updates the model and calls `SkinWindow.requestSize`, which phase 1 ignores per `parity` D13), `minimize()`, `close()`, `returnToMediaCenter()` (host action table, D10.5), `timerInterval`, `title`, `focusObjectID` | `size(handle)`, `maximize`, `restore`, `view.moveTo`, `view.alphaBlendTo`: phase 3 |
| `event` | `x y clientX clientY offsetX offsetY screenX screenY button keyCode altKey ctrlKey shiftKey srcElement fromElement toElement screenWidth screenHeight` (`spec 5.7`); handle revoked after the dispatch | |
| `mediacenter` | `effectType`, `effectPreset` (bound to VizHost, persisted app-level), `videoZoom`, `videoStretchToFit`, `videoShrinkToFit`, `showTitles`, `showEffects`, `contrastMode` (persisted key/value with change events, U-14) | |
| `equalizerSettings` element (`eq`) | `gainLevel1..10` (host EQ state, persisted, Rust `set_eq`), `reset()`, `bands` = 10, `bypass`, `enableSplineTension` (accepted, no DSP effect, `parity` G10) | presets, SRS, normalisation: stub |
| `videoSettings` element | `brightness contrast hue saturation` held locally, `reset()` | no effect (no video) |
| EFFECTS element | `currentEffectType`, `currentPreset`, `currentPresetTitle`, `currentEffectTitle`, `next() previous() nextPreset() previousPreset()`, `effectCount`, `currentEffectPresetCount` | mapped onto the VizHost presets (D10.2) |
| PLAYLIST element | `setColumnResizeMode` (accepted, ignored), `visible`, colours read at build | most methods stub |
| VIDEO element | stub; `onvideostart` never fires | `parity` D19 |
| every element | ambient attributes and `moveTo slideTo moveSizeTo alphaBlendTo` (`spec 5.1`, `5.2`), per-type attributes (`image`, `hoverImage`, `downImage`, `upToolTip`, `value`, `down`, …) | BUTTONGROUP `click(i)`, `getButton(i)`, `buttonCount` |

### D6.2 Enums and strings

`playState`/`openState` are the integer enums from `wmploc 2.2` (81 skins compare against numeric literals,
`survey 5.3`). Mapping from MPD (`wmploc 7.5`): play → `psPlaying`(3)/`osMediaOpen`(13); pause →
`psPaused`(2)/13; stop with a current song or non-empty queue → `psStopped`(1)/13; empty queue →
`psUndefined`(0)/`osUndefined`(0). `player.status`: "Playing", "Paused", "Stopped", "Ready",
"Connecting…" (MPD not reachable), invented per U-32.

### D6.3 MediaModel (the MPD seam)

```ts
// src/engine/contracts.d.ts
interface SongInfo { file: string; title: string; artist: string; album: string; genre: string;
                     track: string; date: string; durationSec: number; pos: number; id: number }
interface MediaState {
  connected: boolean;
  playState: 'play' | 'pause' | 'stop';
  elapsed: number; duration: number;        // seconds; elapsed extrapolated by the model
  volume: number;                           // 0..100, or -1 when MPD has no mixer
  random: boolean; repeat: boolean; single: boolean; consume: boolean;
  song: SongInfo | null;
  queueLength: number; queueVersion: number;
  audio: { rate: number; bits: number; channels: number } | null;
  bitrateKbps: number | null;
  error: string | null;                     // routing error from engine_info
}
interface MediaModel {
  snapshot(): Readonly<MediaState>;
  subscribe(cb: (changed: ReadonlySet<keyof MediaState>) => void): () => void;
  queue(): Promise<readonly SongInfo[]>;
  playlists(): Promise<readonly string[]>;
  playlistSongs(name: string): Promise<readonly SongInfo[]>;
  // commands: typed, idempotent against current/pending state, never raw MPD strings
  play(): Promise<void>; pause(): Promise<void>; stop(): Promise<void>;
  next(): Promise<void>; previous(): Promise<void>;
  seek(sec: number): Promise<void>; setVolume(v: number): Promise<void>;
  setMode(mode: 'loop' | 'shuffle', on: boolean): Promise<void>;
  playQueuePos(pos: number): Promise<void>; playPlaylist(name: string, pos: number): Promise<void>;
  isAvailable(control: string): boolean;    // wmpenabled: table
}
```

The Tauri adapter implements it over the existing `player` and `mpd` exports of `player.js` (unchanged,
pinned); the test adapter implements it as a scripted fake that records calls. The `isAvailable` table in
phase 1 is the oracle's (`parity` D16: stop iff not stopped, pause iff playing, play/next/previous always),
behind `availability: 'oracle' | 'mpd'`; the richer `spec 3.4` table is a phase-3 decision.

### D6.4 Preferences

`theme.savePreference(key, value)` stores `String(value)`; `theme.loadPreference(key)` returns the stored
string or **`"--"` when unset**. The research disagrees (`spec` U-16 recommends `""`); the corpus decides
it: 83 of the 94 preference-using skins test `"--" != x` (`survey 5.3`, G20, `blinx.js:273`,
`Ice Script.js:72`), which only makes sense if WMP returned `"--"`. Prefs are namespaced by archive
SHA-256 (cross-skin reads are impossible: there is no API that takes a namespace). Caps: 256 keys, 4 KiB
per value, 64 KiB per skin; over-cap writes are dropped with a ledger entry. The whole namespace is loaded
into memory before scripts run (reads are synchronous) and written through to Rust, debounced 250 ms.

### D6.5 Policies for dangerous or meaningless APIs

| API | Corpus use | Phase-1 policy |
|---|---|---|
| `player.launchURL(url)` | 1,014 refs (`spec 7.1`) | `denied`: logged once per skin with the URL; phase 3 may offer an http(s)-only confirm prompt in AppShell |
| `player.URL = …` | 294 | `denied` (MPD queue is owned by the user) |
| `theme.openDialog` | 282 | returns `""` |
| `theme.playSound(wav)` | 95 | stub; phase 3: decode WAV from the VFS, play via WebAudio, capped length |
| `theme.openView` loops | 897 | phase 3: max 16 open views per skin, max 4 opens per second |
| `setTimeout` floods | 18 | 64 live timers per view (D1.2) |
| `savePreference` floods | 3,052 | D6.4 caps |
| `player.currentMedia.setItemInfo` | 8 | `denied` |
| `mediaCollection`, `cdromCollection`, `dvd`, `playlistCollection` | 7-20 skins | inert stub objects |

### D6.6 `res://` and the wmploc shim

`src/engine/realm/wmploc.js` implements `wmploc 7` exactly: the resolver (module `wmploc`, `wmploc.dll`
or `-`; types `RT_TEXT RT_STRING RT_IMAGE RT_BITMAP` or none; runtime-built ids), the library registry
(#132 constants seeded before scripts; #169 `sprintf` family; #134, #136 cheap; other ids warn and
skip), and a **re-authored** English string table for the 47 corpus ids (`wmploc 5.3`, risk 5: the
labels are Microsoft text, so we ship our own equivalents; format templates are kept verbatim as
format syntax, e.g. `%s% complete`). `RT_IMAGE`/`RT_BITMAP` resolve to a transparent image of the
documented size plus a diagnostic.

### D6.7 Coverage ledger

- Every `stub`, `denied`, `unknown-member`, `unknown-tag` and soft-fault site is recorded once per
  `(skinSha, api)` by `model/ledger.js` (`record(skinSha, api, kind, detail?)`), which the host can read
  (`engine.ledger()`).
- `tools/scan-api.mjs` (W1) statically ranks object-model members, `#132` names and element methods
  across the local corpus and writes `docs/coverage/api-frequency.csv` (names and counts only; no art,
  committed). Members are implemented in that rank order.
- `npm run coverage` (W4) loads every distinct corpus skin through the test adapter, runs `onload` plus a
  scripted minute (play, pause, seek, open each drawer-like `moveTo` target the skin calls), and renders
  `docs/coverage/ledger.md`: per member, how many skins touched it and its impl. Coverage becomes measured,
  not asserted (`notan` Q3 process item).

## D7. Windows

**Position: a `SkinWindow` abstraction frozen in phase 1 with one binding, `native` (one Tauri
`WebviewWindow` per WMP VIEW, one engine instance per webview); a `cluster` binding (several logical
skin windows in one host window) is reserved for phase 2 and decided with Webamp code in hand. The Rust
click-through becomes per-window in phase 1.** (`notan` Q1, which this candidate adopts with one
change: the engine instance, not just the realm, is per webview.)

Why native windows for WMP views: views are top-level windows in WMP (`spec 2.1` step 7, `theme.openView`
"opens VIEW in a new window", `spec 6.1`); 52% of distinct skins have several views, up to 9 (`survey
1.1`); per-view Keep on Top is native WMP behaviour and the window menu already expresses it; and a
webview per view gives each view its own failure domain (a faulted view unloads alone). Cost: one
WKWebView process per open view (phase 3 measures it; median skin opens 2).

### D7.1 Interface

```ts
// src/engine/contracts.d.ts
type MaskShape =
  | { kind: 'bits'; width: number; height: number; bits: Uint8Array }     // 1 bpp, row-major, LSB first
  | { kind: 'regions'; regions: { x: number; y: number; w: number; h: number; poly?: number[] }[] };
interface SkinWindow {
  readonly key: string;                 // `${skinSha}/${viewId}`: also the persistence key
  readonly binding: 'native' | 'cluster';
  readonly root: HTMLElement;           // transparent, positioned; engine mounts div.view here
  readonly zoom: number;
  setZoom(z: number): Promise<void>;    // CSS scale + window size + mask zoom
  requestSize(w: number, h: number): Promise<boolean>;   // view.width/height writes; phase 1 returns false
  setShape(shape: MaskShape): void;     // replaces the whole shape; coalesced to one IPC per frame
  setCapture(on: boolean): void;
  startDrag(): void;
  show(): Promise<void>; hide(): Promise<void>;
  minimize(): Promise<void>; close(): Promise<void>;
  setAlwaysOnTop(on: boolean): Promise<void>;
  setVisibleOnAllWorkspaces(on: boolean): Promise<void>;
  bounds(): Promise<{ x: number; y: number; w: number; h: number }>;
  onClose(cb: () => void): () => void;
}
interface WindowManager {                // other views of the same skin (phase 3 beyond the first)
  open(viewId: string, at?: { left: number; top: number; relative: boolean }): Promise<boolean>;
  close(viewId: string): Promise<void>;
  isOpen(viewId: string): boolean;
}
```

### D7.2 Native binding

- Phase 1: the existing `main` window is the one native `SkinWindow`; nothing else opens.
- Phase 3: `WindowManager.open` calls Rust `skin_window_open({sha, viewId, x, y, w, h})`, which builds a
  `WebviewWindow` with the proven flag block of `tauri.conf.json:18-25` (transparent, no decorations,
  no shadow, not resizable, `acceptFirstMouse`), `visible: false`, label `skin-<sha12>-<n>`, URL
  `index.html?skin=<sha>&view=<viewId>`. The new webview's engine loads the same archive, attaches only
  that view, and calls `show()` after `onload` and the first frame ("sized before show", `parity 3.5`).
  Cross-view state is what WMP shares: the player (MPD), prefs (Rust store plus `prefs-changed` events)
  and `theme.currentViewID`.

### D7.3 Per-window click-through in Rust (`src-tauri/src/hit.rs`, replaces `clickthrough.rs` at W4-R)

```rust
pub enum Shape { Bits { w: u32, h: u32, bits: Vec<u8> }, Regions(Vec<Region>) }
pub struct Region { x: f64, y: f64, w: f64, h: f64, poly: Option<Vec<f64>> }
struct WindowHit { shape: Option<Shape>, zoom: f64 }
pub struct HitState {
    windows: Mutex<HashMap<String, WindowHit>>,   // keyed by window label
    capture: Mutex<Option<String>>,               // the one label holding a drag capture
}
#[tauri::command] fn hit_set_bits(window: WebviewWindow, request: tauri::ipc::Request<'_>) -> Result<(), String>;
                  // raw body: u32 width, u32 height, f64 zoom, then bits; no JSON number arrays
#[tauri::command] fn hit_set_regions(window: WebviewWindow, regions: Vec<Region>, zoom: f64);
#[tauri::command] fn hit_capture(window: WebviewWindow, on: bool);
```

- **Commands take `window: WebviewWindow` and act on the caller's label.** No label argument exists, so
  one window cannot change another's shape or capture.
- `capture` names a window instead of a global `AtomicBool`: today any slider drag in any window would
  make every window clickable and steal clicks meant for windows beneath (`notan` Q1(a); `click:45-77`).
- The poll thread iterates registered windows every 16 ms (8 ms while two registered window frames
  intersect, `notan` Q1); entries are dropped on `WindowEvent::Destroyed`.
- The legacy `set_hit_mask {width, height, bits: number[], zoom}` and `set_capture {on}` stay registered
  as thin wrappers onto the caller's entry, so the pinned hand port keeps working until cutover.
- `Regions` is used by phase 2 (Webamp windows are rectangles plus `region.txt` polygons, `webamp 2`) and
  costs about 30 lines of point-in-polygon now; doing it in phase 1 keeps `hit.rs` from being reopened.

### D7.4 `view.width`/`view.height`

Phase 1 keeps `parity` D13: writes update the model (script reads back what it wrote, `headspace.js`
sets 549/760) and call `requestSize`, which returns `false`; the window stays 760×394 and the mask makes
the unused strip click-through. Phase 3 implements `requestSize` (resize anchored top-left; leftward
growth needs `allow-set-position`), re-places children by alignment (D5.3) and supports `view.size(edge)`
resize grips (83 skins, `survey 5.4`).

### D7.5 Drag

The picker's "chrome" result calls `SkinWindow.startDrag()` (Tauri `startDragging`), replacing the hand
port's `draggable()` list, `headAlpha` and the two root handlers (`main:42-48`, `main:189-232`).

### D7.6 Persistence

Per `SkinWindow.key`: zoom, always-on-top, all-desktops, last position (phase 3 for secondary views),
stored in the app namespace of `PrefStore` (`app_data_dir/prefs/app.json`), separate from the skin's own
namespace (`app_data_dir/prefs/<sha>.json`), both written by Rust with write-to-temp-then-rename. Restore
order: main view first, secondary views clamped to visible monitor frames (`notan` Q1(e)).

### D7.7 Room for the Webamp cluster (phase 2)

Webamp lays out main, equalizer, playlist and Milkdrop windows inside one container, with its own
docking and snapping (`webamp 2`). The cluster binding is one native host window whose `SkinWindow`
shape is `Regions` (each Webamp window's rect, clipped by its `region.txt` polygons, plus the context
menu's rect) and whose `root` is Webamp's container. Whether the host window is screen-sized or
bounding-box-sized is a phase-2 decision. Nothing in the phase-1 interface prevents either; the only
phase-2 extension expected is `SkinWindow.subWindows?(): {id, rect}[]` for persistence.

## D8. Engine / host boundary

**Position: `src/engine/` is a Tauri-free package with one entry point, `createEngine(host)`. Everything
platform-specific comes through `HostAdapter`. Two adapters exist from wave 2: `TauriHostAdapter`
(`src/hosts/tauri/`) and `TestHostAdapter` (`src/hosts/test/`), and the test one is the oracle harness's
engine host. The boundary is enforced by a committed check script and a JSDoc type check.**

### D8.1 HostAdapter

```ts
// src/engine/contracts.d.ts
interface HostAdapter {
  readonly kind: 'tauri' | 'test';
  window: SkinWindow;               // the surface this engine instance renders into (native binding)
  windows: WindowManager;           // other views (phase 3)
  clock: EngineClock;               // injected: rAF + performance.now in the app, manual in tests
  prefs: PrefStore;
  media: MediaModel;
  audio: AudioFrameBus;
  palette: PaletteService;
  decode: DecodeExecutor;
  slots: SlotProvider;              // EFFECTS, PLAYLIST, VIDEO host widgets
  actions: HostActions;             // returnToMediaCenter, denied-API notices, fault panel
  log: Log;
}
interface EngineClock {
  now(): number;                                  // ms, engine time (animations, timers, marquees)
  onFrame(cb: (now: number) => void): () => void; // one callback per painted frame
  setTimer(ms: number, cb: () => void): number;
  clearTimer(id: number): void;
}
interface PrefStore {
  load(ns: string): Promise<Record<string, string>>;   // ns = skin sha or 'app'
  write(ns: string, key: string, value: string | null): void;  // debounced write-through
  onExternalChange(ns: string, cb: (key: string, value: string | null) => void): () => void;
}
interface AudioFrame { bands: Float32Array; wave: Float32Array; level: number; pcm?: Uint8Array }
interface AudioFrameBus { subscribe(opts: { pcm?: boolean }, cb: (f: AudioFrame) => void): () => void }
interface DecodeJob { bytes: Uint8Array; key: KeySpec; keyImage?: Uint8Array }
interface DecodeExecutor { run(job: DecodeJob): Promise<DecodedImage | null> }   // null = missing
interface SlotSpec { kind: 'effects' | 'playlist' | 'video'; attrs: Record<string, string>; rect: Rect }
interface SlotHandle {
  update(spec: SlotSpec): void; setVisible(v: boolean): void;
  hitRects(): Rect[]; onHitRectsChange(cb: () => void): () => void;
  effects?: EffectsControl;        // present for kind 'effects'
  dispose(): void;
}
interface EffectsControl { count: number; index: number; title: string;
  setIndex(i: number): void; step(d: 1 | -1): void; onChange(cb: () => void): () => void }
interface SlotProvider { mount(el: HTMLElement, spec: SlotSpec): SlotHandle }
interface HostActions {
  run(action: 'returnToMediaCenter' | 'minimize' | 'close', ctx: { viewId: string }): void;
  denied(api: string, detail: string): void;       // one notice per skin per api
  fault(reason: string): void;                     // shows the AppShell fault panel
}
interface Log { info(m: string, d?: object): void; warn(m: string, d?: object): void; diag(d: Diagnostic): void }
```

`PaletteService` is defined in D12.3. `MediaModel` in D6.3. `SkinWindow` in D7.1.

### D8.2 Engine API

```ts
// src/engine/index.js
function createEngine(host: HostAdapter, opts?: EngineOptions): Engine;
interface EngineOptions {
  sliderGeometry?: 'oracle' | 'docs';         // U-10, default 'oracle'
  showBackgroundDefault?: boolean;            // U-23, default false (docs)
  stacking?: 'context' | 'flat';              // D5.4, default 'context'
  subviewClip?: boolean;                      // default true
  availability?: 'oracle' | 'mpd';            // D6.3, default 'oracle'
  budgets?: Partial<RealmOptions['budgets']>;
  testSeed?: string;
}
interface Engine {
  load(archive: Uint8Array, opts?: { sidecar?: Sidecar }): Promise<LoadedSkin>;
}
interface LoadedSkin {
  readonly sha: string;
  readonly family: 'wms';
  readonly views: { id: string; width: number; height: number; main: boolean }[];
  attach(viewId?: string): Promise<ViewRuntime>;     // mounts into host.window
  diagnostics(): Diagnostic[];
  ledger(): LedgerEntry[];
  dispose(): void;
}
interface ViewRuntime {
  readonly viewId: string;
  element(ref: string): { id: string; type: string } | null;  // ref = id or Unnamed_<type>_<n>
  rectOf(ref: string): Rect | null;                            // in view pixels, current (animated) value
  callGlobal(name: string, args?: Wire[]): Wire;               // demo tour and sidecar hooks
  readGlobal(name: string): Wire;
  maskBits(): MaskShape;                                       // the last shape sent
  settled(): Promise<void>;                                    // no tween running, no queued events, images decoded
  readonly health: { soft: number; hard: number; unloaded: boolean };
}
```

### D8.3 Enforcement

- `tools/check-boundaries.mjs` (W0), run by `npm run check` and by every task's acceptance:
  1. no import specifier under `src/engine/**` starting with `@tauri-apps/`, or resolving into `src/app/`,
     `src/hosts/`, `src/main.js`, `src/widgets.js`, `src/player.js`, `src/viz/`;
  2. allowed bare imports under `src/engine/**`: `fflate`, `quickjs-emscripten-core`,
     `@jitl/quickjs-wasmfile-release-sync`, and `src/engine/vendor/*`;
  3. no occurrence under `src/engine/**` of `fetch(`, `XMLHttpRequest`, `WebSocket`, `importScripts`,
     `eval(`, `new Function`, `Function(`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
     `document.write`, `__TAURI`, `localStorage`, `sessionStorage`, `indexedDB`; the one exemption is
     `src/engine/realm/prelude.js`, whose content is realm source shipped as a string (listed in the
     script with a comment);
  4. `src/hosts/test/**` must not import `@tauri-apps/*` either.
- `tsc --noEmit -p tsconfig.check.json` (`allowJs`, `checkJs`, `strict` off, `noImplicitAny` off) checks
  `src/engine/**` and `src/hosts/**` against `src/engine/contracts.d.ts`. This is how a Sonnet task proves
  it implemented the interface it was given.
- The pure part of the engine (`archive`, `text`, `wms`, `image`, `realm`, `model`, `layout`, `bind`)
  must also not touch `document` or `window`; check rule 5 enforces that for those directories, so they
  run under Node in `vitest`.

### D8.4 TestHostAdapter

`src/hosts/test/index.js` exports `createTestHost(opts)`:

- `clock`: manual; `advance(ms)` runs frames at 60 Hz steps and fires timers in order; `now()` frozen
  between advances.
- `media`: a scripted fake with the `parity 4.1` fixture as presets (`stoppedEmpty`, `stoppedQueue5`), a
  call log, and `emit(changes)`.
- `prefs`: in-memory map, with `seed(ns, entries)`.
- `audio`: silent, or a replay of recorded frames.
- `window`: a `TestSkinWindow` over a `div` in the harness page that records every `setShape` and
  `setCapture`, and reports a fixed zoom.
- `decode`: inline executor (same pure functions as the Worker).
- `slots`: the real playlist widget and a stub effects slot (black canvas, five fake preset titles in the
  oracle's order, `viz:23`), so the playlist pixels are real in state 3 and the effects region is excluded.
- `actions`, `log`: recorders.

The same adapter also runs headless in Node for pure tests (with `window` and `slots` omitted).

## D9. Oracle and tests

**Position: a `skinlab` harness in headless Chromium (pinned through `playwright-core@1.63.0` and its
bundled Chromium revision), DPR 1 and 2, frozen engine clock, viz stubbed, that captures the legacy hand
port in the four parity states as goldens and diffs the engine per `SkinWindow` for pixels and hit mask.
Goldens never enter git; a provenance manifest of their hashes does. Built in wave 1, before any engine
renderer exists, so the oracle is proven first (`notan` Q3(2)).**

### D9.1 Layout

```
tools/skinlab/
  vite.config.js        alias '/src/viz/index.js' -> ./viz-stub.js (legacy only); serves ./index.html
  index.html            ?target=legacy|engine&state=1..4&dpr=1|2
  tauri-stub.js         window.__TAURI_INTERNALS__ per parity 4.1: canned mpd/engine_info/palette replies,
                        records set_hit_mask/set_capture/set_eq/set_balance args, label 'main'
  viz-stub.js           Viz look-alike: black 216x158 canvas, 5 titles in viz:23 order, step/setPalette/renderer no-ops
  legacy-mount.js       seeds localStorage (eq zeros, balance 0, preset 1), imports /src/main.js
  engine-mount.js       createTestHost() + createEngine(); loads the archive the runner passes in
  run.mjs               CLI: prepare | capture | check | bless   (playwright-core, no test framework)
  diff.mjs              exact RGBA compare with exclusion and allow-list masks; writes diff PNGs (pixelmatch@8, pngjs)
  regions.mjs           computes runtime regions from the art with the engine's own decoders
  allowlist.json        committed: every allowed difference, with its deviation id and reason
  goldens.manifest.json committed: provenance + hashes, no pixels
.skinlab/               gitignored: goldens/, out/, ledger/, cache/
```

### D9.2 Preconditions and skipping

`run.mjs prepare` resolves the fixture from `SKINLAB_HEADSPACE` (default `~/Downloads/Headspace.wmz`),
verifies the archive SHA-1 prefix `f9671f06` (`parity` conventions), and checks that the legacy's
generated `public/skin/` exists (running `python3 -I tools/convert_skin.py` if not). Any missing piece
prints the reason and **exits 77 (skip)**; CI treats 77 as success-with-warning and runs only unit
tests. Nothing in the harness copies art into tracked paths.

### D9.3 The four states, both targets

| State | Setup (same input on both targets) | Legacy settle | Engine settle |
|---|---|---|---|
| 1 closed | load | all `<img>` decoded, 2 rAF after the 300 ms mask timer (`main:587`) | `runtime.settled()` |
| 2 EQ open | synthetic click on the EQ button centre (286, 223) | `transitionend` on the ear + 200 ms (`parity 4.1`) | `clock.advance(200)`, `settled()` |
| 3 PL open | media preset `stoppedQueue5`; click the PL button centre (474, 224) | as above | as above |
| 4 vis open | click the transport's vis element at (440, 44) (demo's 131/144, 13/25 of the group, `parity 3.1`) | as above, plus the double rAF (`main:353`) | as above |

Inputs are `PointerEvent`s dispatched exactly as `demo.js` does (`demo:40-96`), so the same path exercises
the legacy DOM and the engine's input plane. Pointer then moves off-window (no hover state). Viewport is
760×394, `deviceScaleFactor` 1 and 2, no focus ring.

### D9.4 What is compared

Per state and DPR, per `SkinWindow` rect (phase 1 has one; the comparison is keyed by window so a 5-view
skin or the Webamp cluster later reuses it, `notan` Q1 "ORACLE"):

1. **Pixels**: `page.screenshot({clip: windowRect, omitBackground: true})` (RGBA, transparent background),
   compared exactly (no tolerance, no anti-aliasing allowance) outside the exclusion and allow-list masks.
2. **Hit mask**: legacy = the bits of its last recorded `set_hit_mask` call; engine =
   `runtime.maskBits()`. Compared as XOR; the XOR must be a subset of the mask allow-list.
3. **Report**: `.skinlab/out/<state>@<dpr>/{legacy.png, engine.png, diff.png, report.json}`; `report.json`
   lists differing-pixel count, bounding boxes per connected component, and which allow-list entries
   absorbed how many pixels (an entry absorbing 0 pixels is reported, so stale entries surface).

Exclusions and allow-list (all committed in `allowlist.json`, computed regions derived at run time from
the art by `regions.mjs`, so no coordinates of art pixels need hardcoding):

| Entry | Kind | Region | Why |
|---|---|---|---|
| effects hole | pixel exclusion, all states | `head.bmp` pixels equal to `#FF00FF`, offset (261, 0): 31,487 px | the visualizer is stubbed differently on each side (`parity 4.1`) |
| U-23 `showBackground` | pixel allow-list, all states | pixels of each BUTTONGROUP rect not owned by any of its `mappingColor`s, from the map at run time | engine follows the docs (unowned not painted); oracle paints them: ~811 px in the transport group, 1 in minimize/close (`spec 6.5`) |
| U-10 thumb travel | pixel allow-list | **empty** while `sliderGeometry: 'oracle'` (default); filled by `regions.mjs` from the slider rects only if the switch is flipped | `demo.js:112` hard-depends on travel 65 (`parity` D32) |
| D20 reset y | pixel allow-list, state 2 | (222,221)-(258,238) | engine puts `reset` at `eq1.top + 83` = 127, oracle at 129 |
| D21 preset title | pixel allow-list, state 4 | (321,65)-(426,82) | engine uses the 10 pt default = 13 px, oracle 9 px |
| D11 screen corners | **mask** allow-list, all states | the 106 `vid_bkgd.bmp` white pixels, offset (270, 59) | oracle counts the canvas as a solid rect (`parity 4.1`) |

Nothing else is allowed. A new difference is either an engine bug or a new reviewed allow-list entry
with a deviation id, added by an Opus verification step, never by the implementing task.

### D9.5 Goldens: content-addressed, outside git

- Golden key = SHA-256 of the canonical JSON `{target:'legacy', state, dpr, skinSha256, oraclePin,
  chromiumVersion, harnessVersion}`, where `oraclePin` is the hash of the pinned files' bytes (the
  `parity` line-18 list).
- Files: `.skinlab/goldens/<key>.png`, `<key>.mask.bin`, `<key>.json` (gitignored).
- Committed: `tools/skinlab/goldens.manifest.json` mapping each key to `{pngSha256, maskSha256,
  popcount, bbox, provenance}`. This is a set of facts about the art, like the hashes already in
  `parity`, not art.
- `check` recomputes the key from the current pin and browser. If the local golden is missing it
  re-captures from the legacy and **verifies the PNG and mask hashes against the manifest** before
  using it, so every machine proves the oracle reproduces. A hash mismatch is a hard failure ("oracle
  drift"), which catches an accidental edit of a pinned file or a browser change.
- `bless --reason "<text>"` is the only way to change the manifest; it records the reason and the old
  hashes. Implementing tasks never bless.
- The reference mask values in `parity 4.1` came from an emulation; the first `capture` replaces them
  with live-oracle values (`parity 5` item 9) and the doc's table is updated by Opus.

### D9.6 How a Sonnet implementer runs it

```
npm test                         # vitest, Node: every pure module (no art needed for synthetic fixtures)
npm run check                    # boundary script + tsc checkJs
npm run skinlab -- check         # all 4 states x DPR 1,2; exit 0 pass, 1 fail, 77 skip (no art)
npm run skinlab -- check --state 2 --dpr 1 --open   # one state, opens the diff PNG
npm run corpus                   # corpus smoke over skins/wmp (skips if absent)
```

Every task card in the wave plan names which of these must exit 0.

### D9.7 Unit tests and the fixture ladder

- **Synthetic fixtures** (committed, generated by test code, original content): BMPs of every bit
  depth and compression written by a tiny encoder in `tests/support/bmp-writer.js`; PNG/GIF via `fflate`
  and a hand-written GIF encoder; malicious zips (traversal names, symlink entries, 10 KB → 4 GB bomb
  header, corrupt local signature, ZIP64, encrypted); `.wms` strings reproducing each of the four XML
  failure classes (`survey 2.2`) and each gotcha G1-G27 that is not art.
- **Corpus fixtures** (`skins/wmp`, `skins/wsz`, gitignored; skipped when absent), pinned by
  `tests/corpus.manifest.json` (file name → SHA-256; committed): ladder R0 (owner's Headspace) to R9
  (`survey 6`) and the negative pack (`survey 6.1`).
- Per-module corpus tests: scan 195/195; VFS resolves every reference that case-folding can resolve and
  reports exactly the 90 truly missing (`survey 3.2`); decoders decode every referenced image (16,231
  entries minus the 9 fork files, `survey 3.3`); realm compiles all 219 `.js` and 12,868 handlers in
  QuickJS with exactly the 5 known failures (`survey 5.2`); `wmploc 7.9` tests 1-6.

## D10. App features around any skin

All of this lives in `src/app/` (AppShell, Tauri-aware), never in the engine. The engine exposes slots,
element rects, globals and actions; the AppShell decides what to do with them.

### D10.1 Window menu

Right-click, Control-click or Option-click on a `SkinWindow` opens a native menu (`parity` D8), built per
window: Keep on Top, Show on All Desktops, separator, Larger/Normal Size, separator, Skin ▸ (imported
skins, "Import Skin…"), Reload Skin, and with Option held, "Use Legacy Headspace" / "Use Skin Engine"
(the coexistence flag). Skin first, host second: a right press whose picked element has an
`onmousedown`/`onmouseup` handler goes to the skin and no menu opens; Control- and Option-click always
open the menu (captured before the picker, as `main:526-535` does).

### D10.2 Effects host, visualizer and palette

- `VizHost` (`src/app/viz-host.js`) implements `SlotProvider.mount` for `effects`: it creates a canvas in
  the slot and `new Viz(canvas, onPresetChange, captionEl)` from the unchanged `src/viz/index.js`; with
  Rust fan-out (D11) each `Viz` registers its own frame channel. Its `EffectsControl` maps the EFFECTS
  element's `currentPreset`, `currentPresetTitle`, `next()`, `previous()` and `mediacenter.effectPreset`
  onto `viz.index`, `viz.current.title`, `viz.step(±1)`. The presets (Point Cloud, Chorus, Ring, Warp,
  Ribbon, `viz:23`) need no change.
- A click on an EFFECTS element that has no `onclick` handler steps to the next preset (`parity` D25;
  `WMPEFFECTS`' own default is `onclick="next();"`, `spec 6.14`, so this is the same behaviour).
- Overlays inside the effects slot, with the hand port's CSS copied into a scoped stylesheet
  (`src/app/overlays.css`, pixel-identical rules from `css:137-188`): the track toast (`parity` D4), the
  notice ("Waiting for MPD…" or the routing error, colour from the sidecar or the skin's first TEXT
  `foregroundColor`, `parity` D5), the caption (D6). The slot sits inside the subview that holds the
  EFFECTS element, so the subview's clip mask clips the overlays too (`parity` D26).
- Palette: `VizHost` reads `PaletteService` (D12.3) and calls `viz.setPalette` on change, keeping the
  stale-result guard of `main:439-445`.

### D10.3 Keyboard

The VIEW's and the focused element's `onkeydown`/`onkeypress`/`onkeyup` run first (`spec 6.2`: 518
VIEWs have `onKeyPress`). If no skin handler ran for the event, AppShell defaults apply: Space toggles,
←/→ seek ±5 s, ↑/↓ volume ±5, V next visualization (`main:471-483`), now ignoring events with
Cmd/Ctrl/Alt held and doing nothing when MPD reports no mixer (fixing the two bugs `parity` D9 lists).

### D10.4 Playlist widget

`src/app/widgets/playlist.js` is `src/playlist.js` ported to take a `MediaModel` and a slot element,
honouring the `<playlist>` attributes that matter (`backgroundColor`, `foregroundColor`, `columnsVisible`,
`dropDownVisible`, `playlistItemsVisible`, `itemPlayingColor`, `itemSelectedColor`,
`itemSelectedBackgroundColor`). Its CSS is the hand port's (`css:206-368`) scoped under the slot, so
state 3 compares pixel-for-pixel (`parity` D12). The document-level `pointerdown` that closes the combo
list (`playlist.js:95`) becomes a listener on the window root. The open combo list reports its rect
through `SlotHandle.onHitRectsChange`, so the mask includes it.

### D10.5 Host actions

`view.returnToMediaCenter()` runs a host action table, default **zoom toggle** (`parity` D3); minimize
and close map to the `SkinWindow`. The tooltip stays the skin's ("Return to Full Mode", FOLLOW-WMS).

### D10.6 Sidecars (our files, never inside a skin)

`src/app/sidecars/<sha256>.json`, committed (original content keyed by the archive hash), validated by a
JSON schema before use:

```json
{
  "skin": "<sha256 of ~/Downloads/Headspace.wmz>",
  "overlays": [ { "parent": "sEqView", "type": "text", "left": 9, "top": 121, "width": 15,
                  "value": "32", "fontSize": 7, "foregroundColor": "#77CE07", "justification": "center" } ],
  "compat":   { "seekForeground": "playhead" },
  "actions":  { "returnToMediaCenter": "zoomToggle" },
  "tour":     { "transport": "<ref>", "eqHandle": "bEqHandle", "plHandle": "bPlHandle",
                "visNext": "<Unnamed_button_n>", "reset": "<Unnamed_text_n>",
                "bands": ["eq1", "eq2", "eq3", "eq4", "eq5", "eq6", "eq7", "eq8", "eq9", "eq10"],
                "toggle": { "eq": "ToggleEqView", "pl": "TogglePlView", "vis": "ToggleVisView" },
                "isOpen": { "eq": "eqIsOpen", "pl": "plIsOpen", "vis": "visIsOpen" } }
}
```

- `overlays` reproduce the EQ frequency labels (`parity` D1) as trusted TEXT elements appended to a
  subview after the literal pass. They are generic: any skin can get labels this way.
- `compat.seekForeground: "playhead"` makes the seek slider reveal its foreground to the thumb centre
  instead of `foregroundProgress` (`parity` D2), for this skin only.
- The ten label nodes, the tour refs (the `Unnamed_*` ordinals are filled in by W4 from the built
  model) and the global names come from `parity 3.1`, `3.7` and `headspace.js`.

### D10.7 Demo tour retargeting, without editing `demo.js`

`demo.js` is pinned and needs only DOM-shaped handles. `src/app/demo-adapter.js` builds the `ctx` it
expects from the engine:

- `root` is the engine's `div.view` (its `getBoundingClientRect` gives the origin; the scale transform is
  the same as the hand port's `#skin`); `zoom()` reads `SkinWindow.zoom`.
- Every `ui` node is a **virtual node** `{ getBoundingClientRect: () => clientRect(runtime.rectOf(ref)) }`;
  `ui.bands[i]` is `{ node, get value() }` over the engine's `eq` object; `getEq`/`setEq` read and write
  `eq.gainLevelN`; `toggleEq/Pl/Vis` call `runtime.callGlobal(sidecar.tour.toggle.*)`; `isOpen.*` read
  `runtime.readGlobal(sidecar.tour.isOpen.*)`.
- The demo dispatches `PointerEvent`s to `document.elementFromPoint` (`demo:44-61`), which now returns
  the input plane, so the engine's picker handles the tour exactly as it handles a real mouse. Its fake
  cursor (`z-index: 1000`) and flash (`2000`) still sit above everything (D2.2 sets no `z-index`).
- The band math `5.5 + (1-f)·65` (`demo:108-113`) holds because `sliderGeometry` defaults to `'oracle'`.

Acceptance: the tour runs end to end in the engine under the harness with a scripted clock, and the
sequence of `MediaModel` calls and `set_eq` values equals the legacy run's.

### D10.8 Coexistence and cutover

Coexistence is `src/entry.js` (section 3.2). **Cutover** (deleting `main.js`, `widgets.js`,
`playlist.js`'s legacy copy, the offline keying in `convert_skin.py`, and `public/skin/`) happens when
all of these hold:

1. `npm run skinlab -- check` passes all four states at DPR 1 and 2 with only the D9.4 allow-list, and
   the supplemental checks of `parity 4.6` pass (hover/down per element, play state, 60 ms mid-animation
   sample within the D14 allowance, press-release outside the window).
2. The demo tour (D10.7) passes its acceptance and produces a video indistinguishable to the owner.
3. The corpus smoke (`npm run corpus`) loads all 195 distinct WMP skins with zero hard faults, zero
   uncaught host exceptions, and renders a non-empty first frame for each.
4. One week of owner dogfooding on the engine flag with no regressions filed.
5. An Opus verification pass signs off on the ledger and the allow-list.

## D11. Audio-side changes

| Change | Phase | Where | Signature |
|---|---|---|---|
| **Frame fan-out** | 1 (code in W1, wired at W4-R) | `src-tauri/src/fanout.rs`, `audio.rs` subscriber field | `audio_subscribe(window: WebviewWindow, on_frame: Channel<Frame>, opts: Option<SubscribeOpts>) -> u64`; `audio_unsubscribe(id: u64)`. `Engine.subscribers: Mutex<Vec<Sub { id, label, ch, pcm }>>`; each frame is sent to every subscriber; a send error drops that subscriber; a destroyed window drops its subscribers. The old call shape `audio_subscribe({onFrame})` (`viz:55-57`) still works, so the pinned `viz/index.js` needs no edit. Fixes `parity 3.2`'s "a second `Viz` steals the feed". |
| **EQ profile** | 2 | `eq.rs` (`Coeffs` array becomes a `Vec`) | `set_eq_profile(profile: EqProfile)` with `EqProfile { centres_hz: Vec<f32> /* 1..=16 */, q: f32, gains_db: Vec<f32>, range_db: f32, preamp_db: f32, bypass: bool }`. Profiles: WMP = 31…16 kHz, ±14 dB, Q 1.41, preamp 0 (today's `eq.rs:7-14`); Winamp = 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k Hz, ±12 dB plus preamp ±12 dB (`webamp 1.6`). `set_eq(gains: [f32; 10])` stays as the WMP-profile shim (the pinned hand port calls it). The profile comes from `HostedSkin.capabilities.eq` at skin load. |
| **Preamp and bypass** | 2 | `eq.rs` | Preamp is a gain stage before the biquads, inside the soft clip (`eq.rs:116`). Bypass skips the biquads, keeps balance. For WMP skins `eq.bypass` is host state defaulting to **false** (EQ active), not WMP's documented `true` (`spec 6.16`): WMP's default reflects its own EQ on/off UI, and every Headspace user today has the EQ active; skins that expose an on/off toggle (WMP 11 strings 3906-3908, `wmploc 5.3`) write it explicitly. |
| **PCM in `Frame`** | 2 | `audio.rs` analysis thread | `Frame { bands, wave, level, #[serde(skip_serializing_if = "Option::is_none")] pcm: Option<Vec<u8>> }`: the most recent 1,024 samples, mono, `u8` centred on 128, computed only while at least one subscriber asked for `pcm`. Feeds Webamp's duck-typed analyser and the butterchurn facade (`webamp 1.5`; 61 KB/s at 60 Hz mono). L/R comes later if Milkdrop needs it. |
| Balance | unchanged | `set_balance` | The detent stays a host binding rule (`parity` D17); Webamp's ±25 detent applies only inside Webamp. |

The DSP band centres versus the Headspace labels (31 vs "32", 62 vs "63", `parity` D1) stay as they are:
that is an owner decision, not a parity change.

## D12. Phase-2 seam: `SkinHost`, and where the palette lives

### D12.1 `SkinHost`

```ts
// src/engine/contracts.d.ts
interface SkinHost {
  readonly family: 'wms' | 'wsz' | 'native';
  canLoad(vfs: SkinVfs): number;                 // 0..1: a .wms entry -> wms; main.bmp|png and no .wms -> wsz
  load(vfs: SkinVfs, ctx: { host: HostAdapter; sidecar?: Sidecar }): Promise<HostedSkin>;
}
interface HostedSkin {
  readonly sha: string;
  readonly family: SkinHost['family'];
  readonly capabilities: {
    eq: EqProfile | null;                         // D11
    wantsPcm: boolean;                            // Webamp: true
    windowModel: 'native-per-view' | 'cluster';   // WMP: native; Webamp: cluster
    scripted: boolean;                            // WMP: true (realm); Webamp: false
  };
  views(): { id: string; width: number; height: number; main: boolean }[];
  attach(viewId?: string): Promise<HostedView>;   // renders into ctx.host.window
  diagnostics(): Diagnostic[];
  ledger(): LedgerEntry[];
  dispose(): void;
}
interface HostedView {
  rectOf(ref: string): Rect | null;
  maskBits(): MaskShape;
  settled(): Promise<void>;
  readonly health: { soft: number; hard: number; unloaded: boolean };
}
```

`WmsSkinHost` is the `Engine` of D8.2 behind this interface (`LoadedSkin` and `ViewRuntime` extend
`HostedSkin`/`HostedView`). `src/app/skin-registry.js` opens the archive with the engine's `openVfs`
(so **every family passes the same zip caps**), asks each registered host for `canLoad`, and loads with the
best. The MPD adapter (`MediaModel`), the audio bus, prefs, palette and windows are written once and
shared.

### D12.2 What phase 2 adds behind it (from `webamp 0`, `1.3-1.7`, `2`)

`src/skinhosts/webamp/` (same boundary rules as the engine: no `@tauri-apps/*`):

- `webamp/lazy` loaded by dynamic `import()` only when a `.wsz` is chosen (`webamp 3`: 191,751 B gzip
  without butterchurn), pinned to `webamp@2.3.1`; all private-API use (`__customMediaClass`,
  `__customMiddlewares`, `__initialState`, raw action names) goes through one module with a boot-time
  self-test (the spike's probe 1) that fails closed.
- `IMedia` implementation over `MediaModel` with echo and idempotence guards; queue from
  `__initialState` plus `plchanges` diffs; playlist/shuffle/repeat actions swallowed by a middleware and
  turned into typed `MediaModel` calls.
- Archive: `openVfs` validates first; Webamp then receives a `blob:` URL of the same bytes
  (`setSkinFromUrl`), so its JSZip only ever sees an archive that passed our caps.
- Window: the cluster binding (D7.7), shape = `Regions` from `windows.genWindows` and the parsed
  `skinRegion`, plus the context menu's rect via a `MutationObserver` (`webamp 2`).
- Audio: `AudioFrameBus.subscribe({pcm: true})` feeding the duck-typed analyser and the butterchurn
  facade (`webamp 1.5` option A).
- EQ: `capabilities.eq` = the Winamp profile (D11).
- Tests: the Webamp museum screenshot per `skins/wsz` skin as the oracle (`wsz 6` item 10), compared by the
  same `skinlab diff` per window rect, kept in `.skinlab/`.

### D12.3 `PaletteService`

```ts
type NotanRole = string;   // the nine notan-palette/1 v1 keys, verbatim, never renamed or extended
interface PaletteSnapshot {
  source: 'artifact' | 'local' | 'default';
  association: 'current-uri' | 'retained' | 'default';   // never claims "now playing"
  track: { uri: string; generatedAt: string } | null;
  roles: Record<NotanRole, string> | null;               // all nine or null, never partial
  guarantees: { a: NotanRole; b: NotanRole; kind: string }[];   // verbatim; always [] unless artifact
  clusters: { hex: string; oklch: [number, number, number]; share: number }[];  // share-ordered
}
interface PaletteService {
  snapshot(): PaletteSnapshot;
  subscribe(cb: (s: PaletteSnapshot) => void): () => void;
  lerp(a: string, b: string, t: number): string;          // the one blessed polar-OKLCH lerp
}
```

- **Placement**: `src/app/palette/` (host side); the engine and skin hosts receive it through
  `HostAdapter.palette` and never read files.
- **Phase 1 builds the interface and the `local` and `default` tiers only**: `local` wraps today's Rust
  `palette` command (OKLab k-means over the cover, `lib.rs:162-201`) into `clusters`, with `roles: null`
  and `guarantees: []`; `default` is the hand port's red-to-violet (`viz:18`). VizHost consumes it, so
  the visualizer behaves exactly as today.
- **Phase 2 builds the `artifact` tier** as the third conformance consumer of `notan-palette/1`
  (`notan` Q2): a Rust watcher (`notify`) on the parent directory of
  `$XDG_CONFIG_HOME/rmpc-auto-theme/palette/palette.json`, or `MUSIC_UI_PALETTE_PATH` (an invalid value
  disables the artifact source with a diagnostic, no fallback path), emitting the file's bytes; a JS
  decoder porting grisaille's consumer semantics (retention triple; serialized read plus one dirty
  follow-up; reattach at 1/2/4/8/10 s); the vendored synthetic fixture set pinned by checksum; one adopt
  per song change when local and artifact both land. It never publishes our local extraction as an
  artifact. Engine adapters map their colour slots to roles with per-slot fallbacks (Headspace preset
  gradient, Winamp `viscolor`/`pledit` in phase 2, WMP colour slots in phase 3); the nine roles never
  grow. Phase 2 because nothing in phase-1 parity reads roles, and the conformance work wants the
  contract owner's review (`notan` closing paragraph).

## 4. Module map

Paths are new unless marked (pinned) or (existing). "Pure" = no DOM, runs under Node.

### 4.1 Engine (`src/engine/`, Tauri-free)

| Path | Responsibility | Public interface |
|---|---|---|
| `contracts.d.ts` | Every cross-module type in this doc | types only |
| `index.js` | Composition root | `createEngine(host, opts): Engine` (D8.2); `WmsSkinHost` (D12.1) |
| `archive/zip.js` (pure) | Central-directory reader, caps, salvage | `readZip(bytes, caps?): ZipIndex` (D4.2) |
| `archive/vfs.js` (pure) | Flat case-folded VFS | `openVfs(bytes, caps?): Promise<SkinVfs>` (D4.3) |
| `archive/identity.js` (pure) | SHA-256 via `crypto.subtle` | `sha256Hex(bytes): Promise<string>` |
| `text/decode.js` (pure) | BOM/cp1252 sniff | `decodeText(bytes): { text: string; encoding: 'utf-16le' \| 'utf-16be' \| 'utf-8' \| 'ascii' \| 'cp1252' }` |
| `wms/scan.js` (pure) | Tolerant tokenizer | `scanWms(text): { root: RawNode \| null; diagnostics: Diagnostic[] }` |
| `wms/select.js` (pure) | Multi-`.wms` choice, implicit `<stem>.js` | `pickDefinition(vfs): { wms: string; scripts(viewNode): string[] }` |
| `wms/tags.js`, `wms/attrs.js` (pure) | Tag defaults, attribute types, coercion | `TAGS: Record<tag, {base, defaults}>`; `coerce(type, raw, prev): unknown` |
| `wms/build.js` (pure) | Literal pass, ids, value classes | `buildTheme(root, vfs, probe): ThemeModel` |
| `image/probe.js` (pure) | Header-only size | `probeImage(bytes): { format, width, height } \| null` |
| `image/decode/{bmp,png,gif,jpeg,index}.js` (pure) | Decoders under caps | `decodeImage(bytes, caps?): RgbaImage \| null`; `RgbaImage { width, height, data: Uint8ClampedArray, frames? }` |
| `image/keying.js` (pure) | Per-declaration keys, bit planes | `keyImage(img, spec: KeySpec, clipImg?): KeyedPlanes` |
| `image/service.js` | Cache, lazy decode, `ImageBitmap` creation | `createImageService(vfs, exec: DecodeExecutor): { get(ref, spec): KeyedImage \| null; load(ref, spec): Promise<KeyedImage \| null>; size(ref) }` |
| `image/worker.js` | Worker entry for the Tauri adapter's executor | message protocol `{id, bytes, key} -> {id, result}` |
| `realm/realm.js` | QuickJS runtime/context, budgets, faults | `createRealm(opts): Promise<Realm>` (D1.5) |
| `realm/membrane.js` | Handle table, marshalling, validation | `createMembrane(schema, model, ledger): HostDispatcher & { handleOf(obj): number; revoke(h): void }` |
| `realm/prelude.js` | Realm-side bootstrap source (string) | `PRELUDE_SOURCE: string` (the one boundary-check exemption) |
| `realm/wmploc.js` (pure) | `#132/#169/#134/#136`, `res://` resolver, strings | `resolveRes(url)`, `libraryFor(res)`, `loadString(url)`, `WMPLOC_CONSTANTS` (`wmploc 7.8`) |
| `model/schema.js` (pure) | Class member tables | `SCHEMA`, `membersOf(className): string[]` (D6.1) |
| `model/objects/*.js` (pure) | `player`, `controls`, `settings`, `media`, `network`, `theme`, `view`, `event`, `mediacenter`, `eq`, `vidset`, element classes | each `create<Class>(deps): HostObject` with `get/set/call` per schema |
| `model/ledger.js` (pure) | Coverage ledger | `createLedger(sha): { record(api, kind, detail?); entries(): LedgerEntry[] }` |
| `model/elements.js` (pure) | Element model: attributes, events queue | `ElementModel { id, type, parent, children, get(attr), set(attr, v, origin), on(attr, cb) }` |
| `layout/expr.js` | `jscript:` pass | `evaluateLayout(theme, view, realm): void` |
| `layout/align.js` (pure) | Alignment margins, re-place on resize | `recordAnchors(view)`, `relayout(view, w, h)` |
| `layout/stack.js` (pure) | Paint order per stacking context | `paintOrder(container): ElementModel[]` (D5.4) |
| `bind/paths.js` (pure) | `wmpprop:` grammar | `parsePath(src): BindingPath \| null` |
| `bind/bindings.js` | Live bindings, suspension, `wmpenabled:` | `createBindings(model, media, objects): { settle(); suspend(el, attr); resume(el, attr); dispose() }` |
| `anim/animator.js` | Tweens on the engine clock | `createAnimator(clock): { moveTo(el, x, y, ms, ease); alphaTo(el, a, ms); cancel(el) }` |
| `render/dom/*.js` | Layer tree and one drawable per element type | `createRenderer(root, images, opts): { mount(view); frame(dirty); dispose() }` |
| `input/picker.js` | Top-down hit test | `pick(view, x, y): { el, kind: 'control' \| 'chrome' \| 'blocked' } \| null` |
| `input/dispatch.js` | Gestures, hover, capture, drag, keys, tooltips, cursor | `attachInput(plane, view, deps): () => void` |
| `shape/mask.js` | Window shape from the scene | `rasterizeShape(view, slots): MaskShape` (D2.7) |
| `view-runtime.js` | Orders the load sequence (D5.3), owns the dirty set | `attachView(loaded, viewId, host): Promise<ViewRuntime>` |
| `vendor/jpeg.js` | Vendored pure-JS JPEG decoder | `decodeJpeg(bytes): RgbaImage` |

### 4.2 Hosts, app, harness, Rust

| Path | Responsibility | Public interface |
|---|---|---|
| `src/entry.js` | Legacy/engine flag | side effect only (3.2) |
| `src/hosts/tauri/index.js` | `TauriHostAdapter` | `createTauriHost(opts): Promise<HostAdapter>` |
| `src/hosts/tauri/window.js` | Native `SkinWindow` | `createNativeSkinWindow(webviewWindow, root): SkinWindow` |
| `src/hosts/tauri/media.js` | `MediaModel` over `player.js` (pinned, unchanged) | `createMpdMediaModel(player, mpd): MediaModel` |
| `src/hosts/tauri/{prefs,audio,decode,clock}.js` | Adapter pieces | per D8.1 |
| `src/hosts/test/index.js` | `TestHostAdapter` | `createTestHost(opts): HostAdapter & { clock: { advance(ms) }; media: FakeMedia; recorded }` |
| `src/app/boot.js` | AppShell entry | side effect: picks skin, loads, attaches, wires menu/keys/overlays |
| `src/app/menu.js`, `keys.js`, `zoom.js` | D10.1, D10.3, zoom | `attachMenu(win, ctx)`, `attachKeys(win, runtime, media)` |
| `src/app/viz-host.js`, `overlays.css` | Effects slot, overlays | `createVizHost(palette): SlotProvider` (effects part) |
| `src/app/widgets/playlist.js`, `playlist.css` | Playlist slot | `mountPlaylist(el, media, attrs): SlotHandle` |
| `src/app/palette/*.js` | `PaletteService` local/default tiers | `createPaletteService(media, invoke): PaletteService` |
| `src/app/sidecars/*.json`, `sidecar.js` | Sidecar schema and loader | `loadSidecar(sha): Sidecar \| null` |
| `src/app/demo-adapter.js` | Builds `demo.js`'s `ctx` | `demoContext(runtime, win, vizHost, media, sidecar): DemoCtx` |
| `src/app/skin-registry.js` | Family selection | `registerHost(h: SkinHost)`, `loadSkin(bytes): Promise<HostedSkin>` |
| `tools/skinlab/*` | Oracle harness | D9.1 |
| `tools/check-boundaries.mjs` | Boundary rules | `node tools/check-boundaries.mjs` exits non-zero on violation |
| `tools/scan-api.mjs` | Static API ranking | writes `docs/coverage/api-frequency.csv` |
| `tools/corpus.mjs` | Corpus smoke and ledger | writes `.skinlab/ledger/`, `docs/coverage/ledger.md` |
| `src-tauri/src/hit.rs` | Per-window click-through | D7.3 |
| `src-tauri/src/fanout.rs` | Frame fan-out | D11 |
| `src-tauri/src/skins.rs` | Skin library | D4.1 |
| `src-tauri/src/prefs.rs` | Prefs files | `prefs_load(ns) -> HashMap<String,String>`, `prefs_write(ns, key, value: Option<String>)`; `ns` must be `app` or 64 hex; caps of D6.4 enforced again in Rust |
| `src-tauri/src/lib.rs` (pinned) | Wiring, at W4-R only | registers the commands above, keeps legacy `set_hit_mask`/`set_capture` wrappers |

New dependencies: runtime `quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`,
`fflate@0.8.3`; dev `vitest`, `typescript` (check only), `playwright-core@1.63.0`, `pixelmatch@8`,
`pngjs`; Rust `sha2`, `tempfile` (atomic writes) and, in phase 2, `notify`. Pin exact versions in
`package.json` and commit `package-lock.json`.

## 5. Wave plan

Conventions for every task card:
- **Owner**: S = Sonnet implementer, O = Opus (design, verification, re-pin). Every S task ends with an O
  review of the diff against the card before the next wave consumes it.
- **Implements**: the exact interface from `src/engine/contracts.d.ts` the module must satisfy.
- **Must not touch**: always the pinned files (`src/main.js`, `widgets.js`, `player.js`, `playlist.js`,
  `style.css`, `viz/index.js`, `demo.js`, `tauri.conf.json`, `lib.rs`, `clickthrough.rs`,
  `tools/convert_skin.py`), `contracts.d.ts` (changes go back to O), and other tasks' modules.
- **Acceptance**: commands that exit non-zero on failure. `npm run check` (boundary + types) is implied
  for every JS task, `cargo test` for every Rust task. Corpus-dependent tests skip (never fail) when
  `skins/` or the Headspace fixture is absent; O runs them on the owner's machine.
- **Art rule**: no task writes anything derived from art outside `.skinlab/` or `/tmp`.

### Wave 0: scaffolding and contracts (O, one sitting)

| Task | Deliverable | Acceptance |
|---|---|---|
| W0-1 | `src/engine/contracts.d.ts` with every interface in this doc; empty module files exporting stubs that throw `not implemented` | `npm run check` passes |
| W0-2 | `package.json` scripts `test`, `check`, `skinlab`, `corpus`, `coverage`; pinned deps (4.2); `vitest.config.js`; `tsconfig.check.json`; `.gitignore` adds `.skinlab/` | `npm test` runs (0 tests), `npm run check` passes |
| W0-3 | `tools/check-boundaries.mjs` with rules D8.3 1-5 and a self-test fixture directory of violating files | `node tools/check-boundaries.mjs --self-test` passes (every planted violation detected) |
| W0-4 | `src/entry.js`, `index.html` script tag | `npm run tauri dev` boots the legacy Headspace unchanged; `VITE_ENGINE=engine` boots to a "not implemented" notice |
| W0-5 | `tests/support/` writers (BMP all depths/RLE, minimal PNG, GIF, zip builder incl. malicious variants), `tests/corpus.manifest.json` | writers' own round-trip tests pass |

### Wave 1: pure foundations, the oracle, Rust files (parallel)

| Task | Owner | Module | Implements | Acceptance (all must exit 0) | Deps |
|---|---|---|---|---|---|
| W1-A zip + VFS | S | `archive/zip.js`, `vfs.js`, `identity.js` | `readZip`, `openVfs`, `sha256Hex` | `npm test -- archive`: synthetic suite (traversal, absolute, drive-letter, NUL names skipped; symlink skipped; `__MACOSX/` and `RESOURCE.FRK/` skipped; bomb rejected by ratio and by total cap without allocating; ZIP64 rejected; encrypted skipped; corrupt-signature salvage when names match and skip when not; collision last-wins with diagnostic). Corpus: all 342 archives open; the 3 corrupt-header archives (`survey 1.2`) yield every entry; reference resolution over the 195 distinct skins reports exactly 90 missing references (`survey 3.2`) | W0 |
| W1-B text + scanner | S | `text/decode.js`, `wms/scan.js` | `decodeText`, `scanWms` | `npm test -- wms/scan`: one synthetic case per failure class (duplicate, case-variant duplicate last-wins, missing whitespace, tabs around `=`, end-tag case, junk after root, entities incl. `&#13;`, leading blank line). Corpus: 195/195 distinct `.wms` give a THEME with ≥1 VIEW; encoding counts equal `survey 2.1` (72 UTF-16LE, 10 UTF-8 BOM, 27 ASCII, 86 cp1252) | W0 |
| W1-C images | S | `image/probe.js`, `image/decode/*`, `image/keying.js`, `vendor/jpeg.js` | `probeImage`, `decodeImage`, `keyImage` | `npm test -- image`: every synthetic BMP depth/compression decodes to the expected RGBA; 32-bit alpha forced to 255; RLE overrun stops cleanly; area cap and 16,384 axis cap enforced from headers before allocation (a crafted 30000×30000 header allocates < 1 MB); GIF frame cap; keying: transparency vs clipping bit planes per D2.6 table; `auto` = pixel (0,0). Corpus: every referenced image in the 195 skins decodes (fork files excluded), `Nautical` `vol_slider.bmp` decodes as GIF; Headspace key census equals `parity 0.2` (e.g. `head.bmp`: 31,487 magenta, 17,909 red) | W0 |
| W1-RG0 realm gate | S, then O sign-off | `tests/realm-gate/` | none (proof) | `npm test -- realm-gate` proves in QuickJS: (1) sloppy `with` over Proxy with `has` traps; (2) global-code direct `eval` inside two `with`s hoists `function`/`var` to global while closures see the `with` scopes (else the Annex B fallback passes); (3) a `-sync` host function called from inside a Proxy trap returns synchronously; (4) the interrupt handler stops `while(1){}` and a deep recursion, the memory limit stops a 200 MB string, and the runtime stays usable after each; (5) **all 219 corpus `.js` and 12,868 handlers compile in QuickJS with exactly the 5 known failures** (`survey 5.2`; handlers extracted by a throwaway entity-decoding extractor in the test, as the survey did, so this gate does not wait for W1-B). If (1)-(3) fail, stop and return to O (switch variant to quickjs-ng and re-run) | W0 |
| W1-D realm | S | `realm/realm.js`, `membrane.js`, `prelude.js` | `createRealm`, `HostDispatcher` | `npm test -- realm`: name precedence table of D1.2 (element > id > script global > host global; `Volume` reaches id `volume`; skin `function volume()` beats case-variant id; `id="player"` loses); `this`; PLAYER params; ReferenceError is a soft fault and the next handler runs; budget and memory faults are hard; 3 hard faults in 30 s unload; handles revoked after dispose and after an event dispatch; no host object, function or array crosses (a probe that tries `__h`, `constructor.constructor`, `globalThis.__host` finds nothing); re-entrancy queue depth cap 32; timers on a manual clock, 64-timer cap; frozen `Date` in test mode | W1-RG0 |
| W1-E wmploc | S | `realm/wmploc.js` | per `wmploc 7.8` | `npm test -- wmploc`: the six test groups of `wmploc 7.9`; the string table is re-authored (O checks wording) | W0 |
| W1-O oracle | O designs, S builds | `tools/skinlab/*` (legacy side only) | D9 | `npm run skinlab -- capture --target legacy` produces 4 states × DPR 1,2 goldens; running it twice gives identical PNG and mask hashes (determinism); the live mask popcounts are recorded and O updates `parity 4.1`'s table; with the fixture absent the command exits 77 | W0 |
| W1-R1 hit | S | `src-tauri/src/hit.rs` (new, not wired) | D7.3 | `cargo test hit`: bits hit-test incl. zoom; regions incl. concave polygon; capture is per label; destroyed label removed; raw-body decoder rejects truncated input | — |
| W1-R2 fan-out | S | `src-tauri/src/fanout.rs` (new, not wired) | D11 row 1 | `cargo test fanout`: N subscribers all receive; a failing sender is dropped; unsubscribe by id; drop by label | — |
| W1-R3 skins + prefs | S | `src-tauri/src/skins.rs`, `prefs.rs` (new, not wired) | D4.1, D6.4 | `cargo test skins prefs`: import rejects > 32 MiB and non-zip; sha naming; `skin_read` rejects anything but 64 hex; prefs namespace validation; caps; atomic write leaves the old file intact on simulated failure | — |
| W1-S scanner | S | `tools/scan-api.mjs` | D6.7 | writes `docs/coverage/api-frequency.csv`; O spot-checks top 20 against `spec 7.1` counts | W1-B |

### Wave 2: the model

| Task | Owner | Module | Acceptance | Deps |
|---|---|---|---|---|
| W2-A build | S | `wms/select.js`, `tags.js`, `attrs.js`, `build.js`, `model/elements.js` | Headspace builds 1 VIEW 760×394, 23 SUBVIEWs, 69 elements (`survey` R0) with literal geometry matching `parity 0.5` for every literal; predefined tag defaults per `spec 6.4/6.6/6.7/6.10`; `Unnamed_<type>_<n>` ids; multi-`.wms` picks `Nautical.wms` and `ExtremeSports.wms`; misspelled prefixes stay literal; corpus 195/195 build without throwing | W1-A, B, C(probe), E |
| W2-B object model | S | `model/schema.js`, `model/objects/*`, `model/ledger.js` | Every member in D6.1's table exists with the stated impl; case-insensitive lookup; enums per D6.2 against a fake `MediaState` table; `loadPreference` unset returns `"--"`; pref caps; `launchURL`/`URL=`/`openDialog` policies recorded in the ledger; stub values type-correct | W0, W1-D (contract) |
| W2-C layout | S | `layout/expr.js`, `align.js`, `stack.js` | Headspace's 25 `jscript:` values resolve to `parity 0.4` (reset top = 127); 9SeriesDefault forward read gives `svStub.width` = 263 and unevaluated reads = 0; `Portals` `eqLeft+0` reads a script global; paint order of Headspace equals `parity 0.6` exactly (Reading C) | W2-A, W1-D |
| W2-D bindings | S | `bind/paths.js`, `bind/bindings.js` | path grammar incl. `getMode('loop')` and trailing `;`; change-only assignment; `_onchange` queued; no player write from a binding; drag suspension; `wmpenabled:` last-segment rule; Headspace: pause visible iff playing, stop element disabled iff stopped (`parity` D16) | W2-A, W2-B |
| W2-E media | S | `src/hosts/tauri/media.js`, fake in `src/hosts/test/media.js` | idempotent commands against a recorded fake `mpd`; elapsed extrapolation equals `player.js:92-97`; 4 Hz position publication; `isAvailable` oracle table | W0 |
| W2-F test host | S | `src/hosts/test/*` | D8.4; `clock.advance` ordering test; recorded `setShape`/`setCapture` | W2-E |
| W2-G image service | S | `image/service.js`, `image/worker.js`, `src/hosts/tauri/decode.js` | inline and Worker executors give identical bytes; 2 s hang → worker restarted, image missing; LRU eviction at the cap; swapped `image` keeps old pixels until ready | W1-C |
| W2-H palette | S | `src/app/palette/*` | local/default tiers per D12.3; `guarantees` always `[]`; stale-result guard | W0 |
| W2-I skinlab engine side | S | `tools/skinlab/engine-mount.js`, `diff.mjs`, `regions.mjs`, `allowlist.json`, the `check` subcommand of `run.mjs` | `engine-mount` mounts `createTestHost()` + `createEngine()` per D8.4 (renders an empty view until W3-E); `diff.mjs` exact compare, exclusion and allow-list application, `report.json` with per-entry absorbed counts; `regions.mjs` computes the effects hole, the unowned buttongroup pixels and the 106 screen corners with the engine's own decoders. Acceptance: `check` of a legacy golden against itself reports 0 differences; state 1 against state 2 reports a difference confined to the EQ ear's rect; an allow-list entry that absorbs nothing is reported | W2-F, W1-C, W1-O |

### Wave 3: rendering and interaction

| Task | Owner | Module | Acceptance | Deps |
|---|---|---|---|---|
| W3-A renderer | S | `render/dom/*` | Per-drawable visual tests in `skinlab` against synthetic skins (committed, original art generated by test code): button states and fallbacks, buttongroup per-pixel states with `showBackground` both ways, tiled slider with `borderSize` caps, `slide` true/false, vertical slider, TEXT size/justify/ellipsis, nested subview clip and clip mask, negative z under background; no engine node has `z-index` (DOM assertion) | W2-C, W2-G |
| W3-B animator | S | `anim/animator.js` | linear `moveTo` at t = 60 ms puts the EQ ear at x ≈ 103 (`parity 4.6`); cancel-on-retarget fires one `onEndMove`; `alphaBlendTo` end event; all on the manual clock | W2-A |
| W3-C picker + input | S | `input/picker.js`, `dispatch.js` | D2.6 rule table as unit cases; Headspace: press on the face-hole reaches the effects slot, press on head art starts drag, press on a disabled stop element is swallowed; click only on same-element down/up; DOM `click` ignored; capture set on press, cleared on up/cancel; tooltip/cursor follow hover | W3-A, W1-D |
| W3-D shape | S | `shape/mask.js` | Headspace state 1 mask equals the legacy golden's mask XOR exactly the 106 corner pixels; mask updates every frame of an ear slide; unchanged scene sends nothing | W3-A |
| W3-E runtime | S, O review | `view-runtime.js`, `index.js` | D5.3 ordering asserted by an event log; `settled()` semantics; **`npm run skinlab -- check --state 1 --dpr 1` passes** (first end-to-end parity) | W2-*, W3-A..D |
| W3-F host widgets | S | `src/app/widgets/playlist.js`, `viz-host.js`, `overlays.css` | playlist pixels in state 3 equal legacy (harness, playlist rect only); effects control maps presets; overlays clipped by the subview mask | W2-E, W2-H |
| W3-RP perf gate | O | measurement | R9 `xsn_sports` loads, runs `onload` and 60 s of scripted interaction under the test host with no hard fault; median handler < 2 ms, p99 < 20 ms; membrane crossings per second recorded. If it fails, O decides between a realm-side mirror of hot read-only members or a phase-3 move of the realm into a Worker; phase 1 does not block on it | W3-E |

### Wave 4: integration, re-pin and parity

| Task | Owner | Module | Acceptance | Deps |
|---|---|---|---|---|
| W4-R re-pin batch | O | `lib.rs`, `hit.rs` replacing `clickthrough.rs`, `fanout.rs`/`skins.rs`/`prefs.rs` wiring, `tauri.conf.json` CSP, `capabilities/default.json`, `record_stop` guard | legacy still works in the app; `skinlab capture --target legacy` reproduces the **previous** golden hashes byte-for-byte (otherwise revert); new pin table committed to `parity`; `skinlab bless --reason "W4-R re-pin"` updates only the provenance; **engine mode boots in the real Tauri app under the new CSP** (QuickJS WASM instantiates; skinlab cannot see this because it runs in Chromium); if WKWebView rejects `'wasm-unsafe-eval'`, loosen only `script-src` to `'unsafe-eval'` for the engine build and record it as an open risk | W1-R1..R3 |
| W4-A Tauri host | S | `src/hosts/tauri/*` | engine flag boots Headspace in the app from `WINDOW_HEADMPD_SKIN`; manual checklist: drag, minimize, close, drawers, seek, volume, EQ audible, playlist plays | W3-E, W4-R |
| W4-B AppShell | S | `src/app/*`, `src/app/sidecars/<sha>.json` | menu, zoom 1/1.5 (mask and viz pixel ratio follow), keyboard rules incl. modifier fix, notices, toast; sidecar labels pixel-identical in state 2; `returnToMediaCenter` toggles zoom | W4-A, W3-F |
| W4-C demo | S | `src/app/demo-adapter.js` | D10.7 acceptance (same call sequence as legacy) | W4-B |
| W4-P parity | O verifies, S fixes | any engine module | `npm run skinlab -- check` all states, DPR 1 and 2, with only the D9.4 allow-list; `parity 4.6` supplemental checks | W4-B, W4-R |
| W4-K corpus + ledger | S | `tools/corpus.mjs` (runs inside skinlab's Chromium, since the first-frame check needs the renderer; pure stages also run under Node) | 195/195 distinct skins: zero hard faults, no uncaught host exception, non-empty first frame; `docs/coverage/ledger.md` generated | W3-E |

### Wave 5: cutover (O)

Apply D10.8. Delete the hand port, the legacy branch of `entry.js`, the offline keying in
`convert_skin.py` (keep the icon path), `public/skin/` generation; re-pin nothing. After cutover `check` can no longer re-capture a missing legacy golden, so before deleting the hand port O
blesses the engine's own output as goldens with `target:'engine'` (same content addressing and manifest); from then on
the engine is regression-tested against itself plus the allow-list history.

### Phase 2 waves (outline)

| Wave | Tasks |
|---|---|
| P2-W1 | Rust `set_eq_profile`, preamp, bypass, `Frame.pcm` (S); `skinhosts/webamp` media class and Redux sync with replayed MPD idle sequences as a state-machine test (S); PaletteService artifact tier: Rust watcher + decoder + fixtures (S, notan review) |
| P2-W2 | Cluster `SkinWindow` binding, `Regions` shape, context-menu observer (S); skin registry and `canLoad` (S); `.wsz` museum-screenshot oracle in skinlab (S) |
| P2-W3 | Integration on 10 `skins/wsz` skins chosen to cover the `wsz 2.2` manifest rows; O verification |

### Phase 3 waves (outline)

Ladder-driven (`survey 6`): R1 Miniplayer (view sized from image, predefined buttons, mute emulation),
R2 aoe (RLE, case refs, `itemsPlaylist`), R3 PowerToys and R6 Blinx (multi-view native windows via
`WindowManager`, per-view realms, prefs coherence, `view.width` resizing with alignment relayout), R4
Revert and R7 9SeriesDefault (popup/automenu/listbox host widgets, `res://` strings, `#169`), R5 Atomic and
R8 portals (`clippingImage`, CUSTOMSLIDER, animated GIF), R9 xsn_sports (alphaBlend crossfades, perf).
Each rung is one wave with its own skinlab acceptance (render plus scripted interaction, compared against
the engine's previous blessed output and, where possible, owner-supplied real-WMP screenshots).

## 6. Risks accepted

| # | Risk | Why accepted | Mitigation / tripwire |
|---|---|---|---|
| R1 | QuickJS semantics differ from WMP's JScript or V8 in a corner (`with` + Proxy, direct-eval hoisting, Annex B) | Isolation is worth more than perfect fidelity; the corpus is ES3-shaped | W1-RG0 gate before any realm work; ng variant swap; corpus compile in QuickJS |
| R2 | Membrane crossing cost on heavy skins (one host call per member access) | Simplicity and auditability of a single dispatcher | W3-RP perf gate on R9; phase-3 options: realm-side mirror of read-only hot members, or the realm in a Worker |
| R3 | Wall-clock budgets misfire under GC pauses or a busy machine | Deterministic instruction counting is not exposed by the sync variant | Generous budgets (100 ms per handler), three strikes in 30 s, soft faults never unload |
| R4 | The oracle runs in Chromium, the app in WKWebView: text rasterisation, `pixelated` scaling and `border-image` vs canvas tiling may differ between engines | Relative comparison inside one browser is what the parity contract needs; Chromium is scriptable and pinnable | Own decoders remove the image half of the gap; a manual in-app screenshot check per state at W4-P; phase 3 may add Playwright WebKit as a second browser |
| R5 | Legacy golden capture is non-deterministic (CSS transitions, async image loads) | It is the oracle we have | W1-O acceptance requires two identical captures; settle on `transitionend` + 200 ms + 2 rAF; manifest hash check on every machine |
| R6 | Hybrid renderer pixel mismatch at DPR 2 (canvas leaf vs `<img>`) | Exact at DPR 1 by construction | DPR 2 is in the check matrix from W3-E on |
| R7 | One webview per WMP view is memory-heavy for 5-9-view skins | Isolation per view, native per-view window behaviour | Measured in phase 3 at R6; the `SkinWindow` interface allows a cluster binding for WMP too |
| R8 | Click misrouting between overlapping skin windows with 16 ms cursor polling | Known since `notan` Q1 | 8 ms polling while frames intersect; NSEvent monitor only if misroutes reproduce |
| R9 | Allow-listing `showBackground` (U-23) and the preset title (D21) means the engine's Headspace differs visibly from today's app (~811 px around the transport buttons) | `parity 0.1` rule 1: follow WMP, allow-list slips | If the owner prefers the old look, a sidecar override restores it for this skin only |
| R10 | Webamp private APIs drift (phase 2) | Pinned version, one wrapper module, boot self-test | `webamp 7` risk 2 |
| R11 | Re-authored `res://` strings differ in wording from WMP | Microsoft text cannot ship (`wmploc 8` risk 5) | Only 6 distinct skins use them |
| R12 | Contract drift between parallel Sonnet tasks | Waves are parallel by design | One `contracts.d.ts` owned by O, `tsc` checkJs in every acceptance, O review between waves |
| R14 | The CSP keyword `'wasm-unsafe-eval'` is honoured by Chromium; whether the shipped WKWebView honours it is unverified, and the Chromium harness cannot detect an in-app WASM instantiation failure | A strict CSP is part of the safety position | W4-R acceptance boots the engine in the real app; documented fallback is `'unsafe-eval'` in `script-src` only, which still leaves the skin realm isolated (its isolation does not depend on CSP) |
| R13 | 4 Hz position updates make thumbs step visibly on very short tracks | Bounds script traffic for 176 listening skins | Raise to 10 Hz if the owner notices; script `_onchange` coalescing stays at 4 Hz |

## 7. Deliberately left to phase 3 (or later)

- Opening secondary views (`theme.openView`, `closeView`, `openViewRelative`) as native windows, per-view
  realms in their own webviews, prefs coherence events, view position persistence.
- Honouring `view.width`/`view.height` writes, `view.size(edge)` resize grips, alignment relayout on
  resize, `minWidth`…`maxHeight`, `view.moveTo`/`view.alphaBlendTo` on the window itself.
- CUSTOMSLIDER, animated GIFs, `.cur`/`.ani` cursors, `nineGridMargins`/`resizeImages`,
  `hueShift`/`saturation` of 8-bit BMPs, `backgroundImageHueShift`.
- EDITBOX, LISTBOX/POPUP/ITEM, AUTOMENU host widgets; PLAYLIST attributes beyond D10.4.
- `theme.playSound`, an opt-in `launchURL` prompt, EQ presets and spline tension, `videoSettings` effects,
  `<bars>`, `RT_IMAGE`/`RT_BITMAP` resources.
- The `availability: 'mpd'` table (`spec 3.4`) versus the oracle's (`parity` open question 5).
- A persistent decode cache; moving the realm into a Worker; the realm-side mirror (only if W3-RP says so).
- Our own new skin format (`NativeSkinHost`): it should compile to the same element model and renderer,
  which this design keeps possible by making `wms/build` produce a format-neutral `ThemeModel`.
- Real-WMP ground truth for U-2, U-10, U-23: if the owner can produce screenshots from a Windows VM before
  Microsoft's 2026-11-10 skin end-of-life (`spec 1.1`), they become phase-3 goldens.

## 8. Research disagreements resolved here

| Question | Research positions | This design | Why |
|---|---|---|---|
| `loadPreference` for an unset key | `spec` U-16: `""`; `survey` G20: `"--"` | `"--"` | 83 of 94 preference-using skins test `"--" != x` |
| `jscript:` re-evaluation | `spec` U-3: once; `survey` G13: on dependency change | once, plus alignment anchors | 2,773/2,791 `view.width-N` lefts are paired with `horizontalAlignment="right"` |
| Nested SUBVIEW z | docs: absolute; Headspace needs stacking contexts | stacking contexts (Reading C), switchable | `parity 0.1` rule 4 arithmetic; `spec 5.3` `visDrop` observation |
| Thumb travel | docs: `[b, L-b]`; oracle: `L - thumb` | oracle, switchable, empty allow-list | `demo.js:112` depends on 65 |
| `showBackground` default | docs: false; oracle paints | docs, allow-listed | `parity 0.1` rule 1 |
| Extract skins to `appdata/skins/<sha>/` (`notan`) or keep zipped | `notan` Q3(1): extract; `wsz 6`: never extract | keep the archive, parse in memory | removes the extraction bug class; one zip implementation for app, harness and Node |
| Duplicate attributes | `spec` U-5 and `survey 2.2`: last wins (inferred) | last wins, diagnostic | sampled conflicts read as author intent |
| `eq.bypass` default | docs: true | false (EQ active) | today's users have an active EQ; skins with toggles write it |
