# Phase 1 implementation plan: Headspace on the generic engine

Status: ratified plan, 2026-10-06, branch `skin-engine`. Nothing is implemented or committed.
Contract: `docs/design/ENGINE.md` (cited as `E §n` / `E Dn`). If this plan and ENGINE.md disagree,
ENGINE.md wins and the disagreement goes to Opus.

Phase 1 ends when Headspace runs on the generic engine at parity with the hand port, the hand port is
deleted, and the oracle is still reproducible from a git tag. The fixture-ladder rungs R1 and R2 are
an optional last wave.

## How to use this plan

**Task cards.** Each task names: id, title, owner, size, the files it **owns** (creates or edits; no
other task in the same wave touches them), the interfaces it implements or consumes (by reference to
ENGINE.md), the acceptance commands it must add and pass, and its dependencies. A task may create
private helper files under the directories it owns.

**Owners.** **S** = Sonnet implementer (one sitting). **O** = Opus (contracts, gates, re-pins,
triage, sign-off). Every S task ends with an O review of its diff against the card before the next
wave consumes it.

**Sizes.** S ≤ half a day, M ≈ one day, L ≈ two days of focused work.

**Global rules for every task.**

1. **Must not touch**: the pinned files (`src/main.js`, `src/widgets.js`, `src/player.js`,
   `src/playlist.js`, `src/style.css`, `src/viz/index.js`, `src/demo.js`, `src-tauri/tauri.conf.json`,
   `src-tauri/src/lib.rs`, `src-tauri/src/clickthrough.rs`, `tools/convert_skin.py`), except in W3.R
   and W6.2; `src/engine/contracts.d.ts`, `package.json`, `package-lock.json` (Opus-owned; request
   changes, do not make them); files owned by another task in the same wave.
2. **Art rule**: no task writes anything derived from skin art inside the repository. Goldens, diff
   images and decoded caches go to `~/Library/Caches/window_headmpd/` or `/tmp`. Hashes, counts and
   coordinates may be committed. Every acceptance run ends with
   `git status --porcelain --untracked-files=all` showing only the task's owned files.
3. **Implied acceptance** for every JS task: `npm run check` exits 0 (boundary checker plus
   `tsc --checkJs` against `contracts.d.ts`). For every Rust task:
   `cargo test --manifest-path src-tauri/Cargo.toml -p headcore` exits 0.
4. **Art-dependent tests skip, never fail, when the art is absent**: vitest marks them skipped;
   skinlab exits 77. Opus runs them on the owner's machine at each gate.
5. **Lookups keyed by skin strings are Maps or null-prototype objects** (E §1 rule 6). Every task that
   builds such a lookup adds a test with the keys `__proto__` and `constructor`.
6. **Contract changes stop the task.** If an interface in `contracts.d.ts` is wrong or missing, the
   task records the need and returns to O. It does not work around it.

**Gates.** Every wave ends with an Opus gate. Besides its wave-specific items, every gate runs:
`npm run check`, `npm test`, `npm run corpus` (owner machine),
`cargo test --manifest-path src-tauri/Cargo.toml -p headcore`, `npm run skinlab -- verify-legacy`
(until cutover), the art-rule `git status` check, and a review of each diff against its card.

## Wave overview

| Wave | Theme | Ships at the end |
|---|---|---|
| 0 | Scaffold, contracts, coexistence, boundary checker, test kit, **legacy oracle capture** | `npm run skinlab -- bless --target legacy` produces goldens; `npm run check` runs; the app still boots legacy |
| 1 | Pure leaves and the Rust core crate | Zip, scanner, decoders, keying, wmploc, value tables, the realm gate, `headcore` logic, test-host primitives, each with corpus numbers |
| 2 | Model foundations | Element model and paint order, the realm and membrane, the object model, the image service, MPD media model, palette, skinlab diff machinery |
| 3 | Layout, bindings, animation, rendering, hit, input, host widgets, **re-pin batch** | Every engine module exists and passes its unit and fixture tests; the Rust glue is wired into the app |
| 4 | Composition, Tauri host, app shell | **First end-to-end parity** (S1, S2, S2b, S4 compat at DPR 1); the shell compiles against the host |
| 5 | Parity completion, app integration, demo, corpus | All parity gates; in-app smoke; demo on the engine; corpus robustness; tag regeneration |
| 6 | Dogfood and cutover | Engine is the default; hand port deleted; oracle reproducible from `oracle/headspace-v1` |
| 7 | Optional: R1 Miniplayer, R2 aoe | Two more skins load and operate, with self-blessed regression goldens |

Critical path: W0.1 → W0.5 → W1.3, W1.4 → W2.1, W2.2, W2.3 → W3.1, W3.2, W3.4 → W4.1 → W5.1 → G5 → W6.

---

## Wave 0: scaffold, contracts and the oracle

W0.1 runs first. W0.2 to W0.5 run in parallel after it.

### W0.1 Scaffold and contracts · O · M

- **Owns**: `package.json`, `package-lock.json`, `src-tauri/Cargo.lock`, `vitest.config.js`, `tsconfig.check.json`,
  `.gitignore`, `src/engine/contracts.d.ts`, `src/engine/options.js`, `src/engine/index.js` (a stub
  whose `createEngine` returns an engine whose `load` rejects with `Error('engine not implemented')`;
  W4.1 replaces it), `src-tauri/Cargo.toml`
  (adds `[workspace] members = ["crates/headcore"]` and the path dependency, unused until W3.R),
  `src-tauri/crates/headcore/{Cargo.toml, src/lib.rs, src/hit.rs, src/fanout.rs, src/skinstore.rs,
  src/prefstore.rs, src/guards.rs}` (lib.rs declares the five modules; the module files are empty).
- **Implements**: E §5 verbatim as exported function types and interfaces (see the note at the top
  of E §5); `FAITHFUL` and `ORACLE_COMPAT` (E §5.10) in `options.js`; E §6.2 dependency list with
  exact versions (`quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`,
  `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`, `fflate@0.8.3`, `jpeg-js@0.4.4`; dev `vitest`,
  `happy-dom`, `typescript`, `playwright-core@1.63.0`, `pngjs`; Rust `sha2`, `tempfile`, `serde`,
  `serde_json` in `headcore`), with licences checked.
- **npm scripts** (pre-registered so no later task edits `package.json`):
  `test` runs vitest over `tests/**` **excluding** `tests/corpus/**` (an argument filters by path, so
  `npm test -- tests/engine/archive` works); `corpus` runs vitest over `tests/corpus/**` only, and its
  argument filters by file name (`npm run corpus -- zip` runs `tests/corpus/zip.test.js`);
  `check` = `node tools/check-boundaries.mjs && tsc --noEmit -p tsconfig.check.json`;
  `skinlab` = `node tools/skinlab/run.mjs`; `coverage` = `node tools/corpus.mjs`; the existing `dev`,
  `build`, `tauri` and `skin` scripts are unchanged. DOM-light unit tests opt into happy-dom per file
  (`// @vitest-environment happy-dom`).
- **`.gitignore`** adds `.skinlab/` (defensive; goldens live in `~/Library/Caches`) and
  `tests/**/__out__/`.
- **Acceptance**:
  1. `npm ci && npm test` exits 0 (vitest `passWithNoTests`).
  2. `npx tsc --noEmit -p tsconfig.check.json` exits 0.
  3. `cargo test --manifest-path src-tauri/Cargo.toml -p headcore` exits 0.
  4. `npm run build` builds the legacy app; `npm run tauri dev` behaves exactly as before.
  5. The oracle pin hashes (`parity` line 18) are unchanged (`shasum` the eleven files).
- **Deps**: none.

### W0.2 Coexistence entry · S · S

- **Owns**: `index.html`, `src/entry.js`, `src/app/mode.js`, `src/app/boot.js` (placeholder),
  `tests/app/mode.test.js`.
- **Implements**: E §2 coexistence. `resolveMode()` reads `?engine=wmp`, then
  `localStorage.engine`, then `import.meta.env.VITE_ENGINE`, default `'legacy'`; every read in a
  try/catch. `entry.js` dynamically imports `./main.js` or `./app/boot.js`. The placeholder `boot.js`
  shows "Skin engine not ready" and runs a **QuickJS smoke test** (instantiate the `-sync` variant,
  evaluate `1+1`, show the result). That smoke test is what W3.R uses to prove the CSP lets WASM in.
- **Acceptance**:
  1. `npm test -- tests/app/mode.test.js`: query beats storage beats env; a throwing `localStorage`
     falls back to the env and then to legacy.
  2. `npm run build` exits 0.
  3. Manual (O at G0): `npm run tauri dev` boots legacy unchanged; with `?engine=wmp` the placeholder
     shows "QuickJS OK: 2".
- **Deps**: W0.1.

### W0.3 Boundary checker · S · S

- **Owns**: `tools/check-boundaries.mjs`, `tools/check-boundaries.fixtures/**`,
  `tests/tools/check-boundaries.test.js`.
- **Implements**: E D8 rules 1 to 6: import rules, the allowed bare imports, the banned-sink scan
  (with the `realm/prelude.js` exemption), the test-host Tauri ban, the pure-directory
  `document`/`window` ban, and `--self-test`. Static and dynamic `import()` specifiers are both
  scanned; comments and strings are not exempt (simple and strict).
- **Acceptance**:
  1. `node tools/check-boundaries.mjs --self-test` exits 0, and reports one caught violation per
     planted fixture (at least one fixture per rule).
  2. `node tools/check-boundaries.mjs` exits 0 on the clean tree.
  3. `npm test -- tests/tools`: a temporary file importing `@tauri-apps/api/core` under a temp copy of
     `src/engine/` makes the checker exit 1 with the file and rule named.
- **Deps**: W0.1.

### W0.4 Test support kit · S · M

- **Owns**: `tests/support/{bmp-writer.js, png-writer.js, gif-writer.js, zip-writer.js,
  wms-builder.js, fixtures.js}`, `tests/support/*.test.js`, `tools/make-corpus-manifest.mjs`,
  `tests/corpus.manifest.json`.
- **Implements**: synthetic, own-authored fixture writers (E D9):
  - BMP: 1/4/8/16 (X1R5G5B5 and BITFIELDS 5-6-5)/24/32 bpp, RLE4 and RLE8 (encoded runs, absolute
    runs, delta, end-of-line, end-of-bitmap), top-down, short palettes, odd widths, OS/2 and V4/V5
    headers.
  - PNG: every colour type and bit depth, tRNS, Adam7; deliberately oversized IHDR variants.
  - GIF: multi-frame, transparency index, disposal, NETSCAPE loop; a 600-frame variant.
  - Zip: stored and deflate; traversal (`../x`), absolute, drive-letter and NUL names; symlink
    entries; a 10 KB entry declaring 4 GB; a 1 MiB entry over the ratio; ZIP64; encrypted; a corrupt
    first local signature (`01 00 01 00`); `__MACOSX/`, `RESOURCE.FRK/`, `._x`, `.DS_Store`;
    case-colliding names; CP437 and UTF-8-flagged names.
  - `.wms` builder: produces strings for each `survey 2.2` failure class and a minimal valid skin.
  - `fixtures.js`: resolves `SKINLAB_HEADSPACE` (default `~/Downloads/Headspace.wmz`), checks sha1
    `f9671f06…`, exposes `describeHeadspace` and `describeCorpus` wrappers that skip with a reason.
  - `make-corpus-manifest.mjs`: writes `tests/corpus.manifest.json` (entry name → SHA-256 for every
    archive under `skins/wmp` and `skins/wsz`; names and hashes only).
- **Acceptance**:
  1. `npm test -- tests/support`: every BMP and PNG writer output opens in `sips -g pixelWidth -g
     pixelHeight` with the expected size; every zip-writer archive is listed by `unzip -l` (the
     malicious ones produce the expected `unzip` error); GIF frame counts match.
  2. `node tools/make-corpus-manifest.mjs` lists 342 WMP archives (`survey 1.1`) and the `skins/wsz`
     set, and exits 0; with `skins/` absent it prints a skip and exits 0.
- **Deps**: W0.1.

### W0.5 skinlab: legacy oracle capture · S · L

- **Owns**: `tools/skinlab/{run.mjs, paths.mjs, pins.mjs, store.mjs, capture.mjs, states.mjs,
  vite.config.js, legacy.html, legacy-mount.js, tauri-stub.js, viz-stub.js, cmd-prepare.mjs,
  cmd-bless.mjs, cmd-verify-legacy.mjs, cmd-show.mjs, goldens.manifest.json}`,
  `tests/skinlab/{store,pins,states}.test.js`.
- **Implements**: E D9, legacy side.
  - `run.mjs` is a **dispatcher**: `run.mjs <cmd> …` imports `./cmd-<cmd>.mjs`. Later tasks add
    commands by owning new `cmd-*.mjs` files. Exit codes 0 pass, 1 fail, 2 usage or wrong fixture,
    77 skip.
  - `paths.mjs`: fixture resolution and the sha1 check (same env var as `tests/support/fixtures.js`);
    the golden store root `~/Library/Caches/window_headmpd/skinlab/`.
  - `pins.mjs`: the pinned-file list and `oraclePin` (SHA-256 over their bytes in a fixed order).
  - `store.mjs`: the content-addressed key (canonical JSON of E D9) and the manifest read/write.
  - `vite.config.js`: serves `legacy.html`; a `resolveId` plugin maps the absolute `src/viz/index.js`
    to `viz-stub.js` (pinned files untouched).
  - `tauri-stub.js`: `window.__TAURI_INTERNALS__` per `parity 4.1` (canned `mpd` replies per state,
    `engine_info` ok, `palette` rejects, event `listen` plumbing, window and menu plugin calls answered
    with no-ops), recording `set_hit_mask`, `set_capture`, `set_eq`, `set_balance`.
  - `viz-stub.js`: the `Viz` API (`presets` with the five titles of `viz:23`, `index` from
    `localStorage.preset`, `step`, `current.title`, `setPalette`, `setCaption`, a `renderer` with
    no-op `setPixelRatio`/`setSize`); fills its canvas black; no WebGL, no `audio_subscribe`.
  - `states.mjs`: the legacy-side states S1, S2, S3, S3b, S4, S6 and S7 of E D9 (click points
    (224, 185), (532, 184), (440, 44); media presets; park point (755, 390)). S5 points are added at
    G2 from `regions.mjs`.
  - `capture.mjs`: launches Playwright Chromium (`playwright-core`; refuses system Chrome), viewport
    760×394 plus margin, DPR 1 and 2, real-time settle (`transitionend` where the state animates, then
    200 ms, then two rAF), `page.screenshot({clip, omitBackground: true})`, and the mask from the
    **last** `set_hit_mask` recorded at settle time. (The legacy never refreshes the mask on vis-drop
    open, `parity` D33, so S4 correctly keeps S1's mask; waiting for a new call would hang.)
    **Never calls `page.clock.install`.**
  - Commands: `prepare` (fixture check; runs `python3 -I tools/convert_skin.py` into `public/skin/`
    when its stamp is stale; prints the Chromium revision), `bless --target legacy --reason "…"
    [--states …] [--repin]`, `verify-legacy` (re-capture and compare hashes with the manifest),
    `show --target legacy --state S2` (headed, devtools).
- **Acceptance**:
  1. `npm test -- tests/skinlab`: key canonicalisation is stable; `oraclePin` changes when any pinned
     file changes; manifest round-trip.
  2. `npm run skinlab -- bless --target legacy --reason "W0.5 initial"` exits 0 (O re-runs it at G0).
  3. `npm run skinlab -- verify-legacy` exits 0 **twice in a row** (determinism).
  4. The `bless` report prints live mask popcounts and bounding boxes per state next to `parity 4.1`'s
     emulated 89,328 / 122,636 / 123,258 / 89,328, flagging differences without failing.
  5. `SKINLAB_HEADSPACE=/nonexistent npm run skinlab -- verify-legacy` exits 77; a wrong-sha1 copy exits 2.
  6. Art rule: only `tools/skinlab/goldens.manifest.json` changes in the repo after a bless.
- **Deps**: W0.1.

### Gate G0 · O

*G0 rulings (2026-10-06):* W0.2's `src/entry.js` replays the window `load` event after the legacy
import when `load` already fired (the legacy mask pass at `main.js:586` would otherwise be lost
behind the dynamic import); skinlab's capture replays it the same way, so app and oracle match.
W0.5's S7 pauses the CSS transition at 60 ms instead of a real-time capture (report-only state):
ratified. A bless that finds a capture unchanged keeps its old provenance reason: ratified.

- Re-run `bless --target legacy --reason "G0"` and `verify-legacy` twice; inspect every golden PNG.
- Record the live popcounts in E Appendix A (replacing the emulated reference, `parity` open question 9).
- Manual: legacy app unchanged; `?engine=wmp` shows "QuickJS OK: 2" in `tauri dev` (no CSP yet).
- Commit nothing that contains art.

---

## Wave 1: pure leaves and the Rust core

All tasks run in parallel.

### W1.1 Archive reader and VFS · S · M

- **Owns**: `src/engine/archive/{zip.js, vfs.js, identity.js}`, `tests/engine/archive/*`,
  `tests/corpus/zip.test.js`.
- **Implements**: E §5.1 `readZip`, `DEFAULT_ZIP_CAPS`, `openVfs`, `sha256Hex`; E D4 reader and VFS rules.
- **Acceptance**:
  1. `npm test -- tests/engine/archive` (synthetic, from W0.4): stored and deflate entries read;
     traversal, absolute, drive-letter and NUL names skipped with diagnostics; symlink entries skipped;
     `__MACOSX/`, `RESOURCE.FRK/`, `._*`, `.DS_Store` skipped; the 4 GB-declared entry and the
     over-ratio entry return `null` **without allocating more than the cap** (assert
     `process.memoryUsage().arrayBuffers` grows < 2 MiB); ZIP64 rejected; encrypted skipped;
     corrupt-signature salvage when names match and skip when they do not; case collisions resolve
     last-wins with a diagnostic; CP437 vs UTF-8 names; `vfs.read('__proto__')` and
     `vfs.has('constructor')` are false for an archive without such entries, and true for one that has
     an entry literally named `__proto__`.
  2. `npm run corpus -- zip`: 342 of 342 WMP archives open; 195 distinct SHA-256 values; the three
     corrupt-header archives (`bruteforce`, `QuantumRedshiftWMPSkin`, `SplinterCellWMPSkin`, and their
     raw twins) yield every entry, including `sc.wms`; all `skins/wsz` archives open. Counts printed and
     written to `docs/coverage/corpus-zip.txt` (numbers only).
- **Deps**: W0.1, W0.4.

### W1.2 Text decoding and the tolerant scanner · S · M

- **Owns**: `src/engine/text/decode.js`, `src/engine/wms/scan.js`, `tests/engine/text/*`,
  `tests/engine/wms/scan.test.js`, `tests/corpus/parse.test.js`.
- **Implements**: E §5.1 `decodeText`; E §5.2 `scanWms`; E D5 scanner rules 1 to 6.
- **Acceptance**:
  1. `npm test -- tests/engine/text tests/engine/wms/scan`: one synthetic case per `survey 2.2` class
     (exact duplicate last-wins; case-variant duplicate last-wins; missing whitespace; tabs around
     `=`; end-tag case; junk after the root); entities including `&#13;`; a leading blank line; an
     orphan close tag; unknown tags kept as nodes; BOM sniffing of UTF-16LE/BE and UTF-8; cp1252 bytes
     0x80-0x9F mapped.
  2. `npm run corpus -- parse`: 195/195 distinct `.wms` produce a THEME root with at least one VIEW;
     encoding census 72 UTF-16LE / 10 UTF-8 BOM / 27 ASCII / 86 cp1252 (`survey 2.1`); duplicate
     diagnostics in 67 distinct skins, case-variant duplicates in 8, missing whitespace in 22, end-tag
     case in 12, junk after the root in 1 (`survey 2.2`). Counts written to
     `docs/coverage/corpus-parse.txt`.
  3. Headspace (skips without the fixture): one VIEW with 23 `subview` descendants; 25 attribute values
     with a `jscript:` prefix, 18 `wmpprop:`, 2 `wmpenabled:`.
- **Deps**: W0.1, W0.4.

### W1.3 Image probe, decoders and keying · S · L

- **Owns**: `src/engine/image/{probe.js, keying.js}`, `src/engine/image/decode/{index.js, bmp.js,
  png.js, gif.js, jpeg.js}`, `tests/engine/image/*`, `tests/corpus/images.test.js`,
  `tests/headspace/keying.test.js`.
- **Implements**: E §5.4 `probeImage`, `decodeImage`, `keyImage`; E D3 decoders, caps and keying; the
  D2 hit-plane rules for `hitKeyed`.
- **Acceptance**:
  1. `npm test -- tests/engine/image`: every W0.4 BMP decodes to the expected RGBA (pixel-exact);
     16-bit BI_RGB decodes as X1R5G5B5 and BITFIELDS as 5-6-5; 32-bit alpha comes out 255 with a
     diagnostic when the source alpha was non-zero; RLE overrun or truncation stops that image cleanly;
     every PNG colour type and depth, tRNS, Adam7; an IDAT that inflates past the IHDR size returns
     `null`; GIF frame 0, disposal and transparency; the 600-frame GIF is capped at 512; JPEG
     baseline and progressive; magic-byte detection ignores extensions; a 30000×30000 BMP/PNG/GIF/JPEG
     header returns `null` in < 5 ms with `arrayBuffers` growth < 1 MiB; a 16,384×20 image decodes and
     a 16,385×20 one is capped; keying: `auto` uses pixel (0,0), `none` leaves the image untouched,
     PNG alpha plus a key both apply, transparency vs clipping vs `hitKeyed` produce the planes of the
     E D2 table.
  2. `npm run corpus -- images`: every image entry in `skins/wmp` and `skins/wsz` decodes with **0
     throws**. Failures are listed with reasons; the only allowed failures are the 9 `RESOURCE.FRK/`
     fork files and non-image formats (the PSDs `survey 3.3` mentions); any other failure fails the
     suite. `Nautical` `vol_slider.bmp` decodes as a 9,494×144 GIF; `microsoft__pharaoh`
     `seek_steps.bmp` decodes at 15,990×20.
  3. `npm test -- tests/headspace/keying` (skips without the fixture or without `public/skin/`): key
     census `head.bmp` magenta 31,487 and red 17,909, `vid_bkgd.bmp` white 106, `viz_drop.bmp` magenta
     352, `L_drwr_*` 328 and `R_drwr_*` 340 each (`parity 0.2`); for every non-map BMP, the keyed RGBA
     under its per-declaration `KeySpec` (listed in the test from `parity 0.2`'s table) equals
     `public/skin/<name>.png`: alpha exact, RGB exact where alpha > 0.
- **Deps**: W0.1, W0.4.

### W1.4 Realm gate RG0 · S, then O sign-off · M

- **Owns**: `tests/realm-gate/*` and `tests/corpus/realm-gate.test.js` (including a throwaway
  `extract-handlers.mjs` that pulls handler attributes from the corpus with entity decoding, as the
  survey did).
- **Implements**: no engine code. Proves E D1 RG0 items 1 to 7 in QuickJS
  (`@jitl/quickjs-wasmfile-release-sync`), each as a vitest case.
- **Acceptance**:
  1. `npm test -- tests/realm-gate` passes items 1 to 6, including **`undefinedFn()` throws
     `ReferenceError`, a bare undeclared read throws `ReferenceError`, `typeof undeclared` is
     `'undefined'`**; the regex `(a+)+$` case and a Promise-job flood are interrupted within budget
     plus 10 ms; a 200 MB string hits the memory cap; after each hard fault a fresh instance in the
     same process evaluates `1+1`; the simulated-abort case is survived by discarding.
  2. `npm run corpus -- realm-gate`: all 219 corpus `.js`
     files and all 12,868 handlers compile in QuickJS with exactly the 5 known failures, all in
     `supersoni__Faith Hill` (`survey 5.2`).
  3. The task's final report states, for item 2 of RG0, which mechanism passed (direct eval inside
     `with`, or the Annex B fallback), and the measured cost of 10,000 `with(__IDS)` lookups.
- **On failure** of items 1 to 4: stop; O decides between the ng variant and the accessor fallback
  (E D1) and amends E D1 before W2.2 starts.
- **Deps**: W0.1.

### W1.5 wmploc shim · S · S

- **Owns**: `src/engine/realm/wmploc.js`, `tests/engine/realm/wmploc.test.js`.
- **Implements**: E §5.5 `wmplocConstants`, `resolveRes`, `loadString`; E D6.6 (`wmploc 7`): the
  resolver, the library registry (#132, #134, #136, #169 with the DLL's replace-all `sprintf`), the
  re-authored 47-id string table (our own wording; format templates kept as format syntax).
- **Acceptance**: `npm test -- tests/engine/realm/wmploc`: the six test groups of `wmploc 7.9`; the
  `os*` 0..20 and `ps*` 0..11 values; `osOpeningUnknownURL` 21 only with `extras`; `sprintf`
  string-form replace-all and object-form positional first-occurrence; `resolveRes` accepts
  `wmploc`, `wmploc.dll` and `-` modules and rejects anything else; O checks the string wording at G1.
- **Deps**: W0.1.

### W1.6 Value classes, tag and attribute tables · S · M

- **Owns**: `src/engine/wms/{values.js, tags.js, attrs.js}`, `tests/engine/wms/{values,tags,attrs}.test.js`.
- **Implements**: E §5.2 `resolveTag`, `attrSpec`, `classifyValue`, `parseColor`, `coerce`; E D5 value
  classes and coercion; the predefined-tag defaults of `spec 6.4`, `6.6`, `6.7`, `6.10`, `6.13`-`6.15`
  (G23); ambient attributes (`spec 5.1`) and per-kind attributes with types and defaults; host-only
  `x-` attributes accepted only with `origin 'sidecar'`.
- **Acceptance**: `npm test -- tests/engine/wms/values tests/engine/wms/tags tests/engine/wms/attrs`:
  a snapshot of every predefined tag's base kind and defaults (one case per tag in G23);
  `classifyValue` on `jscript:`, `JScript:`, ` jscript:` (leading space), `wmpprop:`, `wmpenabled:`,
  `wmpdisabled:`, `res://`, `wmppprop:` and `wmpenable:` (literal plus diagnostic), and handlers;
  `parseColor` knows all 140 IE names, `#RGB`, `none`, `auto`; `coerce`: `true/false/1/0` in any case,
  `'ture'` keeps the previous value, `'600 '` is 600, `-1` survives (U-22); `resolveTag('__proto__')`
  is `unknown`.
- **Deps**: W0.1.

### W1.7 headcore::hit · S · M

- **Owns**: `src-tauri/crates/headcore/src/hit.rs`.
- **Implements**: E D7.1 `Shape`, `Region`, `WindowHit`, `HitTable` (`set_shape`, `set_capture`,
  `remove`, `want_ignore`), `decode_bits_body`. Pure Rust, no Tauri.
- **Acceptance**: `cargo test --manifest-path src-tauri/Cargo.toml -p headcore hit`: bits hit-test at
  zoom 1 and 1.5 (floor of `x / zoom`), out-of-range is a miss; regions including a concave polygon;
  `want_ignore` with no shape is `false` (clickable); capture is per label: while A captures, A is
  never ignoring and B still follows its mask; `remove` drops a label and clears a capture it held;
  `decode_bits_body` rejects truncated input and a bit length that does not match `w × h`; a legacy
  JSON `Vec<u8>` mask converts to the same `Shape`.
- **Deps**: W0.1.

### W1.8 headcore::fanout and guards · S · S

- **Owns**: `src-tauri/crates/headcore/src/{fanout.rs, guards.rs}`.
- **Implements**: E D11 fan-out generic over a `FrameSink` trait
  (`fn send(&self, f: &F) -> Result<(), ()>`): `subscribe(label, sink, pcm) -> u64`, `unsubscribe(id)`,
  `drop_label(label)`, `send_all(frame)` dropping failed sinks, `wants_pcm()`. E §7 guards:
  `mpd_verb_allowed(verb) -> bool` (the exact list) and `record_path_allowed(path, tmpdir, home) -> bool`.
- **Acceptance**: `cargo test … -p headcore fanout guards`: N subscribers all receive; a failing sink is
  dropped and the rest still receive; unsubscribe by id; `drop_label` removes only that label's
  subscribers; `wants_pcm` tracks the flags; every allowed verb passes and `rm`, `sendmessage`,
  `password`, `kill`, `update`, `config` and an empty string fail; `record_path_allowed` accepts
  `/tmp/a.wav`, `/private/tmp/a.wav`, `$TMPDIR/a.wav`, `~/Movies/a.wav` and rejects `/etc/x`,
  `/tmp/../etc/x`, and a symlink under `/tmp` pointing outside (resolved by canonicalising the parent).
- **Deps**: W0.1.

### W1.9 headcore::skinstore and prefstore · S · M

- **Owns**: `src-tauri/crates/headcore/src/{skinstore.rs, prefstore.rs}`.
- **Implements**: E D4 Rust side (`import`, `list`, `read`, `remove` over a root directory, with the
  import guard, SHA-256 naming, write-to-temp then rename, `index.json`); E D6.4 prefs store
  (`load(ns) -> HashMap`, `write(ns, key, Option<value>)`, namespace validation `^[0-9a-f]{64}$ | app |
  mediacenter`, caps, atomic writes).
- **Acceptance**: `cargo test … -p headcore skinstore prefstore`: import rejects > 32 MiB, a wrong
  extension, a symlink, a non-regular file and a file with no EOCD; importing the same bytes twice
  creates one file; `read` rejects anything but 64 lowercase hex (including `../x` and uppercase);
  a simulated failure between temp write and rename leaves the previous file intact; prefs reject bad
  namespaces, a 257th key, a 4,097-byte value and a namespace over 64 KiB, and keep the previous state.
- **Deps**: W0.1.

### W1.10 Test-host primitives · S · S

- **Owns**: `src/hosts/test/{clock.js, media.js, prefs.js, dsp.js}`, `tests/hosts/test/*`.
- **Implements**: E §5.8 `EngineClock` (manual), E §5.6 `MediaModel` (scripted fake with presets
  `stoppedEmpty`, `stoppedQueue5`, `stoppedQueue12`, `playing` from `parity 4.1`, a call log and
  `emit(changes)`). **G0 ruling:** the preset rows (titles, durations, status fields) are imported
  from `tools/skinlab/media-presets.js`, the single source the legacy goldens were captured with;
  never re-typed. Otherwise S3/S3b cannot match pixel for pixel.), `DspPort` (fake, ±5 balance detent), `PrefStore` (in-memory Maps, `seed`, caps).
- **Acceptance**: `npm test -- tests/hosts/test`: `advance(100)` fires frames at 16 ms steps and timers
  in time order, `now()` frozen between advances; presets reproduce the `parity 4.1` status and queue
  records; the fake's `isAvailable` follows the oracle table (E D6); `stop()` while stopped is recorded
  but changes nothing; prefs caps reject over-cap writes; `load('x')` of a seeded namespace returns a
  `Map`.
- **Deps**: W0.1.

### Gate G1 · O

*G1 rulings (2026-10-06).* Contracts gained (all additive): `ArchiveError`; `AttrSpecForFn`,
`ClassifyValueDiagFn`, `ParseBindPathFn` (§5.2); `DecodeImageWithDiagnosticsFn` and
`KeyedPlanes.diagnostics`, the clip-bit sense (§5.4); `MediaState.queuePos` (§5.6);
`maxStackBytes` 256 KiB; the wmploc helper types (§5.5). Consumers: W2.1's builder and
`ElementModel.set` call `attrSpecFor` and `classifyValueDiag`; W2.4's executors call
`decodeImageWithDiagnostics` and W2.4 owns the RT_IMAGE/RT_BITMAP transparent fallback (wmploc 5.5);
W3.2's `parsePath` delegates to `wms/values.js` `parseBindPath` (one grammar) and adds its caps;
W4.2's `hit_set_bits` body is little-endian (`u32 w, u32 h, f64 zoom`, then the bits LSB-first,
row-major), as W1.7 pinned. RG0 items 1–6 pass; item 7's 7 call-assignment scripts and the slow-builtin
latency gap are ruled in W2.2 items 10–11 (E R19, R20). Ratified as implemented: darkseagreen
0x8FBC8F (the MS page's 8FBC8B is a typo against every other source); `res://` accepted on image as
well as string attributes (9SeriesDefault); scanner folds attribute names ASCII-only and keeps the
first position with the last value; `sprintf` treats `$` patterns literally; alpha-0 pixels are never
keyed. Fix-ups G1.F1–G1.F6 below (all passed). Known limit of the test host: its fake
`MediaModel` commands do not move `queuePos`; parity states use presets only, and any later test that
needs it extends `src/hosts/test/media.js`.

#### G1.F1 Image fix-ups · S · S
- **Owns**: W1.3's files (`src/engine/image/**`, `tests/engine/image/**`, `tests/headspace/keying.test.js`, `tests/corpus/images.test.js`).
- **Do**: (1) RLE decode that reaches the end of the stream on a command boundary, without end-of-bitmap,
  while rows remain, logs the same truncation diagnostic as a mid-command cut (E D3); fix the test at
  `tests/engine/image/bmp.test.js` that pins `[]`. (2) jpeg-js `maxResolutionInMP` becomes 16.78 so the
  16,777,216 px area cap is the one authority (probe and decode agree); update `jpeg.test.js`.
  (3) Annotate `decodeImageWithDiagnostics` with `DecodeImageWithDiagnosticsFn`; when keying produces
  warnings, put them on `KeyedPlanes.diagnostics`.
- **Acceptance**: `npm test -- tests/engine/image tests/headspace/keying`, `npm run corpus -- images`, `npm run check` (exit 0 except the known `src/hosts/test/media.js` queuePos error until G1.F3 lands).

#### G1.F2 Attribute-table fix-ups · S · S
- **Owns**: W1.6's files (`src/engine/wms/{values,tags,attrs}.js`, their tests).
- **Do**: the reviewer's PLAYLIST/AUTOMENU fix: PLAYLIST drops zIndex, clippingImage, clippingColor,
  passThrough, alphaBlend and the mouse/key/click handlers (spec 5.6, 6.13; keeps onfocus, onblur,
  onresize, onendmove, onendalphablend and `<attr>_onchange`); AUTOMENU keeps only id, left, top,
  visible (default false), elementType and no ambient events (spec 6.18), with tests. Annotate
  `attrSpecFor`, `classifyValueDiag` and `parseBindPath` with `AttrSpecForFn`, `ClassifyValueDiagFn`,
  `ParseBindPathFn`.
- **Acceptance**: `npm test -- tests/engine/wms/values tests/engine/wms/tags tests/engine/wms/attrs`, `npm run check` (same exception as F1).

#### G1.F3 Test-host queuePos · S · S
- **Owns**: W1.10's files (`src/hosts/test/**`, `tests/hosts/test/**`).
- **Do**: fill `MediaState.queuePos` from the preset's wire `status.song` (number, or null when absent);
  `song` stays null when `currentsong` is empty. Tests: `stoppedQueue5` has `queuePos` 1 and `song`
  null; `stoppedEmpty` has null; `emit` can change it.
- **Acceptance**: `npm test -- tests/hosts/test`, `npm run check` exits 0.

#### G1.F4 wmploc fix-ups · S · S
- **Owns**: W1.5's files (`src/engine/realm/wmploc.js`, `tests/engine/realm/wmploc.test.js`).
- **Do**: add string #2091 `"%1 / %2"` to the table (wmploc 7.6); annotate `parseScriptFile`,
  `scriptLibrary`, `lookupString`, `resolveStringAttribute` with the new §5.5 contract types and make
  the local typedefs import them instead of redefining them.
- **Acceptance**: `npm test -- tests/engine/realm/wmploc`, `npm run check` (same exception as F1).

#### G1.F5 Archive fix-ups · S · S
- **Owns**: W1.1's files (`src/engine/archive/**`, `tests/engine/archive/**`, `tests/corpus/zip.test.js`, `docs/coverage/corpus-zip.txt`).
- **Do**: skip, with a diagnostic, any entry whose folded basename is `''` or `.`; make the
  `.DS_Store` skip case-insensitive like the others; type `ArchiveError` against the contract's
  `ArchiveError` interface. Tests for each.
- **Acceptance**: `npm test -- tests/engine/archive`, `npm run corpus -- zip` (counts unchanged), `npm run check` (same exception as F1).

#### G1.F6 Realm-gate expectations · S · S
- **Owns**: W1.4's files (`tests/realm-gate/**`, `tests/corpus/realm-gate.test.js`).
- **Do**: RG0 item 7's script case asserts the exact pinned list of the 7 call-assignment failures
  (sorted, by archive and file) instead of `[]`, with a comment pointing at W2.2 item 10, which flips it
  to 219/219. Set the gate's stack cap constant to the contracted 256 KiB if it differs, and add a
  case documenting that a 1 MiB cap lets recursion escape WASM as a host `RangeError` (skip it if it is
  flaky on this host; record the measured threshold in the test's comment).
- **Acceptance**: `npm test -- tests/realm-gate`, `npm run corpus -- realm-gate` exits 0, `npm run check` (same exception as F1).

- RG0 sign-off (W1.4): mechanism chosen, E D1 amended if needed.
- wmploc string wording review.
- Review corpus counts against `survey`; any mismatch is explained or turned into a fix before wave 2.

---

## Wave 2: model foundations

All tasks run in parallel.

### W2.1 Build, element model, paint order · S · L

- **Owns**: `src/engine/wms/{select.js, build.js}`, `src/engine/model/elements.js`,
  `src/engine/layout/stack.js`, `tests/engine/wms/{select,build}.test.js`,
  `tests/engine/model/elements.test.js`, `tests/engine/layout/stack.test.js`,
  `tests/headspace/build.test.js`, `tests/corpus/build.test.js`.
- **Implements**: E §5.2 `pickDefinition`; E §5.3 `buildTheme`, `ElementModel`, `ViewModel` (the
  `_onchange` queue and dirty set included), `BuildCaps`; E §5.11 `paintOrder`; E D5 build rules
  (literal pass, probe-derived sizes, Unnamed ids, per-VIEW id scoping with last-declared-wins, sidecar
  overlays appended); E D2 paint order and Reading C; E §10 structural caps.
- **Acceptance**:
  1. `npm test -- tests/engine/wms/select tests/engine/wms/build tests/engine/model tests/engine/layout/stack`:
     negative z under the background; nested contexts never interleave; equal z in document order;
     runtime `zIndex` re-sorts one parent; coercion keeps the previous value on invalid input; caps
     (20,001 elements, depth 65, a 4,097-px view) trigger diagnostics and clamp, never throw; ids
     `__proto__` and `constructor` are ordinary ids; overlays are appended under their parent.
  2. `npm test -- tests/headspace/build`: `pickDefinition` returns `headspace.wms`; 1 VIEW 760×394; 23
     SUBVIEWs; 69 elements (`survey` R0); literal geometry per `parity 0.5` for every literal value;
     `paintOrder` reproduces `parity 0.6` exactly; the test **prints** the `Unnamed_*` ids of the
     `visDrop` next button, the `reset` text and the preset-title text (O copies them into the sidecar
     at G2).
  3. `npm run corpus -- build`: 195/195 distinct skins build without throwing; `Nautical` picks
     `Nautical.wms` and `Sports` picks `ExtremeSports.wms`; reference resolution, counted the way
     `survey 3.2` counted (attributes whose value ends in a known extension, plus `scriptFile`), reports
     90 unresolved references in 46 skins and 716 case-folded resolutions in 62; any difference is
     printed for O with the per-skin diff.
- **Deps**: W1.1, W1.2, W1.3, W1.6.

### W2.2 Realm and membrane · S · L (O review required)

- **Owns**: `src/engine/realm/{realm.js, membrane.js, prelude.js}`, `tests/engine/realm/*`
  (except `wmploc.test.js`).
- **Implements**: E §5.5 `createRealm`, `Realm`, `HostDispatcher`; E D1 in full: one module instance per
  session, the fault-domain rule (discard, never dispose after an abort or leak), the scope chain
  (`with(__IDS){with(this){…}}`, host globals as replaceable global properties, the G17 exception,
  prelude internals non-writable, dispatcher deleted), script loading by direct eval inside
  `with(__IDS)` (or the RG0-chosen fallback), `jscript:` evaluation, handler compilation with the
  label-retry rule, timers, determinism hooks, the membrane (copy-only, 64 KiB strings, 16 args,
  handle revocation, no synchronous re-entry, chain cap 32), budgets on `wallClock`, pending-job drain,
  duty cycle, soft and hard faults, unload.
- **Consumes**: W1.5 constants; a fake dispatcher and fake class member lists in tests.
- **Acceptance**: `npm test -- tests/engine/realm`:
  1. Precedence: element member > id > script global > host global; `Volume` reaches id `volume`;
     a skin `function volume()` beats the case-variant id; `id="player"` loses to `player` with a
     diagnostic; a skin `var view = 1` replaces the host global; a top-level `var x` where `x` is an id
     writes through and is diagnosed.
  2. **`ReferenceError`** for an undeclared call and an undeclared bare read inside a handler; it is a
     soft fault and the next handler runs.
  3. `this` is the element; PLAYER parameters are visible in exact case only; `jscript:` with a
     trailing `;` returns its value; a handler starting `jscript:` compiles; `eval("eq"+i+".left=5")`
     writes through; `a = b.visible = false` works.
  4. Budgets: `while(1){}` in a handler is a hard fault within 100 ms + 50 ms (10 ms when the file runs alone; G1: parallel test files add scheduler noise); a 200 MB allocation is
     an OOM; three hard faults in 30 s unload; after unload a new realm in the same process works; the
     budget still fires when the engine clock is frozen.
  5. Duty cycle: 64 timers at the 10 ms floor each burning 9 ms trigger the throttle within 5 s of
     simulated wall time, and a hard fault after 10 s at > 80%.
  6. Membrane: a probe that tries `__h`, `constructor.constructor('return this')()`, the deleted
     dispatcher name and `globalThis.__host` finds nothing usable; a 65 KiB string is rejected (soft
     fault); event handles are revoked after dispatch; writes queue and drain FIFO after the entry
     returns; a two-slider ping-pong stops at depth 32 with a soft fault.
  7. Timers: string and function forms on the manual clock; the 65th timer is refused; `inGesture` is
     true only inside `runHandler(..., {gesture: true})`.
  8. Leak check: after 1,000 dispatches the runtime's object count returns to its baseline.
- **G1 additions (rulings from RG0):**
  9. `maxStackBytes` 256 KiB; a host `RangeError` (or any non-realm exception) escaping the WASM
     call is a **hard fault** and the instance is discarded (never disposed).
  10. **Call-assignment rewrite** (E R20): `loadScript` compiles; on `SyntaxError` "invalid assignment
      left-hand side" at line L, rewrite the one offending `<call> = <rhs>` statement on L into
      `__wmp_badAssign()` (a prelude function that throws `TypeError('Cannot assign to a function
      result')`), retry, at most 32 rewrites per file, each a `script-rewrite` diagnostic; any other
      syntax error loses the file as before. Test: synthetic `eq.gainLevels(b) = v;` and
      `theme.savePreference('x')='--';` files load, their functions are callable, and the rewritten
      statement throws at run time; `npm run corpus -- realm-gate` then shows 219/219 scripts load
      (update its expectation from the pinned 7-name list).
  11. **Slow-builtin guards** (E R19): the prelude wraps the listed builtins (non-writable,
      non-configurable replacements installed before any skin code) with a cheap host check that
      throws once the current dispatch is over budget. Test: `for(;;){try{'y'.repeat(1e5)}catch(e){}}`
      and `for(;;){s.indexOf('b')}` over a 16 MiB string end as hard faults within budget + 300 ms;
      flip RG0's pinned latency test (`tests/realm-gate`) to assert the bound instead of the gap.
- **Deps**: W1.4 (signed off), W1.5.

### W2.3 Object model, policies, ledger · S · L

- **Owns**: `src/engine/model/{schema.js, policy.js, ledger.js}`, `src/engine/model/objects/*`,
  `tests/engine/model/{schema,policy,ledger,objects}*.test.js`.
- **Implements**: E §5.5 `SCHEMA`, `MemberSpec`, `HostObject`, `ObjectGraph`, `createObjectGraph`,
  `Ledger`; E D6 in full (the mapping table, enums of D6.2, `MM:SS`/`HH:MM:SS` strings, `"--"` for an
  unset pref, mediacenter key allow-list, mute emulation, balance detent and snap, eq bypass default
  false, policies of D6.5 including MPD rate caps and gesture gating, the ledger). Element objects are
  built against the `ElementModel` contract with an **in-test fake element**, so this task does not wait
  for W2.1.
- **Consumes**: W1.6 `attrSpec` (element member tables), W1.5, W1.10 fakes (`MediaModel`, `DspPort`,
  `PrefStore`).
- **Acceptance**: `npm test -- tests/engine/model/schema tests/engine/model/policy tests/engine/model/ledger tests/engine/model/objects`:
  1. Every member of `parity 3.7` resolves case-insensitively (`player.OpenState`, `player.openstate`,
     `player.currentMedia.ImageSourceWidth`) and is `live` or `emulated`.
  2. Enums: play 3/13, pause 2/13, stop with a song 1/13, stop with an empty queue and no song 0/0,
     disconnected 0/0 with status "Connecting…".
  3. `currentPositionString` gives `00:00` at 0 s, `03:07` at 187 s, `01:00:00` at 3,600 s;
     `durationString` the same format.
  4. `loadPreference('nope') === "--"`; `loadPreference('constructor') === "--"`;
     `player.constructor` is an unknown member (ledger `unknown-member`); pref caps drop over-cap
     writes with a ledger entry.
  5. Policies: `launchURL`, `URL=`, `setItemInfo` denied and ledgered once; `openDialog` returns `""`;
     `view.close()` with `inGesture() === false` is denied, with `true` it calls the host;
     11 `controls.next()` calls in one second from script reach the fake media 10 times; seek and
     volume coalesce to the latest within 40 ms.
  6. `mediacenter.effectPreset` persists to the `mediacenter` namespace; `mediacenter.foo` does not
     persist and is ledgered.
  7. `isAvailable` follows the oracle table (`parity` D16); `getMode('loop')` follows `repeat`;
     `settings.mute = 'false'` coerces; mute emulation restores the previous volume; with volume −1,
     reads give 0 and writes are dropped.
  8. Each stub returns a type-correct value; the ledger records each `(sha, api)` once.
- **Deps**: W1.5, W1.6, W1.10.

### W2.4 Image service and decode Worker · S · M

- **Owns**: `src/engine/image/{service.js, worker.js}`, `src/hosts/tauri/decode.js`,
  `tests/engine/image/service.test.js`, `tests/hosts/tauri/decode.test.js`.
- **Implements**: E §5.4 `createImageService`, `DecodeExecutor` (inline in `service.js` for tests; the
  Worker pool in `src/hosts/tauri/decode.js`); caching by `(sha256(bytes), KeySpec)`; LRU at 256 MiB;
  the 2 s terminate-and-recreate; "old pixels until new ones land"; `pending()`.
- **Acceptance**: `npm test -- tests/engine/image/service tests/hosts/tauri/decode`: the inline executor
  and a `node:worker_threads` stand-in for the Worker give byte-identical planes; a hanging decode
  (test hook) is terminated after 2 s, the image is missing, and the next job runs on a fresh worker;
  LRU evicts the least recently used past the cap; a missing ref returns `null` with one diagnostic;
  `raw()` returns unkeyed map images; `get()` returns the previous planes while a replacement is
  pending.
- **Deps**: W1.3.

### W2.5 MPD media model and DSP port (Tauri side) · S · M

- **Owns**: `src/hosts/tauri/{media.js, dsp.js}`, `tests/hosts/tauri/{media,dsp}.test.js`.
- **Implements**: E §5.6 `MediaModel` over the pinned `player.js` exports (`player`, `mpd`), which are
  imported, never edited; elapsed extrapolation as `player.js:92-97`; typed idempotent commands;
  `isAvailable` oracle table; the 40 ms volume coalescing; `DspPort` over `invoke('set_eq')` and
  `invoke('set_balance')` with persistence through a `PrefStore`, ±14 dB clamp, ±5 detent.
- **Acceptance**: `npm test -- tests/hosts/tauri/media tests/hosts/tauri/dsp` with a recorded fake
  `player`/`mpd`: `play()` while paused sends `pause 0`; `play()` while stopped sends `play`; `stop()`
  while stopped sends nothing; `seek(12.345)` sends `seekcur 12.35`; five `setVolume` calls within
  40 ms send one `setvol`; `subscribe` reports changed keys on `status`, `song`, `queue`; `set_eq`
  receives all ten gains on each band change; balance 4 goes to the DSP as 0.
- **Deps**: W0.1.

### W2.6 Palette service (local and default tiers) · S · S

- **Owns**: `src/app/palette/{service.js, local.js, lerp.js}`, `tests/app/palette.test.js`.
- **Implements**: E §5.9 and E D12 phase-1 tiers: `local` wraps `invoke('palette', {file})` into
  `clusters` with `roles: null`, `guarantees: []`, `association: 'current-uri'`; `default` is the
  red-to-violet of `viz:18`; the stale-result guard of `main:439-445`; one polar-OKLCH `lerp`.
- **Acceptance**: `npm test -- tests/app/palette`: a slow palette reply for an older song never replaces
  the newer one; a rejected call falls back to `default`; `guarantees` is always `[]` and `roles` always
  `null` for local and default; `lerp(a, a, t) === a`; `lerp` endpoints are exact; hue interpolation
  takes the short way round.
- **Deps**: W0.1.

### W2.7 skinlab engine side and the test host · S · L

- **Owns**: `tools/skinlab/{engine.html, engine-mount.js, diff.mjs, regions.mjs, allowlist.json,
  cmd-check.mjs, cmd-diff.mjs}`, `src/hosts/test/{index.js, window.js, slots.js}`,
  `tests/skinlab/{diff,regions,allowlist}.test.js`, `tests/hosts/test/{window,slots}.test.js`.
- **Implements**: E D9 engine side and E D8 TestHostAdapter.
  - `createTestHost(opts)` assembles W1.10's primitives with a `TestSkinWindow` (records `setShape`,
    `setCapture`, `startDrag`; fixed zoom) and a `SlotProvider` whose effects slot is the stub (black
    canvas, five titles, index from `mediacenter.effectPreset`) and whose playlist slot uses an
    **injected widget factory** (a blank placeholder until W5.1 injects the real widget).
  - `engine-mount.js` mounts `createTestHost()` + `createEngine(host, config)`, seeds the prefs exactly
    as the legacy capture does (`mediacenter.effectPreset = 1`, so the title reads "Chorus"; `app` EQ
    gains zero; balance 0), loads the archive and the sidecar (`src/app/sidecars/<sha>.json` if
    present) that the runner passes, and exposes `runtime` to the runner. Until W4.1 replaces the W0.1
    stub, `load` rejects and the mount reports "engine not implemented".
  - `cmd-check.mjs` drives the engine-side states S1, S2, S2b and S4: clicks for S1, S2 and S4 as in
    `states.mjs`, and for S2b `runtime.inspector.callGlobal('ToggleEqView')` followed by
    `clock.advance(500)` and `settled()`. When checking `faithful` it also renders `compat`, because
    `button-transparency` is defined from the two masks. (W5.1 adds S3, S3b, S5, S6 and S7.)
  - `diff.mjs`: exact premultiplied RGBA compare with the exclusion and allow-list masks, mask XOR,
    connected-component bounding boxes, per-entry absorbed counts against bounds, diff PNGs to the
    output directory, `report.json`.
  - `regions.mjs` (uses W1.1, W1.2, W1.3; no engine runtime): computes `effects-hole`,
    `D11-screen-corners` and the unowned pixels of each BUTTONGROUP (absolute positions by summing
    literal `left`/`top` up the raw tree), plus the S5 hover points (centroid of each mapping colour's
    owned pixels). `button-transparency` is defined at check time as
    `faithfulMask XOR compatMask` (the only switch that differs between the two configurations' masks),
    and its size is checked against its bound.
  - `allowlist.json` with every entry of E §9. Bounds start as `null`, which means **measure mode**:
    report the count and pass. `check --strict` fails on any `null` bound.
  - Commands: `check --config compat|faithful --state … --dpr … [--strict]` and
    `diff --files a.png b.png [--mask-a … --mask-b …]` (used by G-WK).
- **Acceptance**:
  1. `npm test -- tests/skinlab tests/hosts/test`: diff of an image against itself is 0; a one-pixel
     change inside an allow-listed rect is absorbed and counted; outside it fails; a bound of 0 with
     one absorbed pixel fails (drift guard); an entry absorbing nothing is reported; premultiplied
     equality treats all alpha-0 pixels as equal.
  2. With the fixture: `regions.mjs` prints `effects-hole` 31,487 and `D11-screen-corners` 106 exactly,
     plus the unowned counts per group and the S5 points.
  3. `npm run skinlab -- diff --files <legacy S1 golden> <legacy S2 golden>` reports differences only
     inside the union of the EQ ear's closed and open rects ((0,86)-(476,256)).
  4. `npm run skinlab -- check --config compat --state S1 --dpr 1` exits 1 with
     "engine not implemented" (not a crash).
- **Deps**: W0.5, W1.1, W1.2, W1.3, W1.10.

### W2.8 Static API ranking · S · S

- **Owns**: `tools/scan-api.mjs`, `docs/coverage/api-frequency.csv`, `tests/tools/scan-api.test.js`.
- **Implements**: E D6.7: ranks object-model members, `#132` names and element methods across the
  distinct corpus (scanner from W1.2 for attributes; a JS tokenizer pass for `.js` files), case-folded,
  names and counts only.
- **Acceptance**: `npm test -- tests/tools/scan-api` on a synthetic two-skin corpus; with `skins/`:
  `node tools/scan-api.mjs skins/wmp` writes the CSV, and its top rows include `player.controls`,
  `player.settings`, `player.currentMedia` (`survey 5.4`); `currentposition` is near 1,374 references
  (`spec 7.1`; O spot-checks the top 20 against `spec 7.1` counts at G2).
- **Deps**: W1.2.

### Gate G2 · O

*G2 rulings (2026-10-07).* Contracts (additive): `buildTheme` opts gain `stacking`; `ObjectGraph`
gains `objectOf`, `hostGlobals`, `ready` (W2.3's ObjectGraphPlus, now the contract); graph deps gain
`queueEvent` (script `click()` on BUTTONGROUP/BUTTONELEMENT queues `onclick`, drained FIFO by the
runtime after the entry returns, like `_onchange`) and `mediacenterPrefs`; `EventInit` gains
`screenWidth`/`screenHeight`; `MediaState.elapsed` is as of the last status (`elapsed()` extrapolates).
W4.1's runtime forwards origin-`script` writes of VIEW `width`/`height` to `SkinWindow.requestSize`
(no boundary exemption for `model/`). Seek and volume coalescing is a **trailing** 40 ms debounce
(the legacy's `main.js:102-103`), not a fixed batch. `Unnamed_<kind>_<n>` numbers per kind (as
built). PLAYER handler keys are the lowercased attribute names (`onopenstatechange`). Element
handles are 1..N per theme; W4.1 keys realms and dispatchers per session, so collisions across
themes cannot meet. DspPort `onChange` fires only when a stored value changes (both hosts).
`SlotHandle.hitRects()` is in view px. Realm tests that assert wall-clock bounds run in the
sequential `timing` vitest project (`npm test` runs `unit` then `timing`). E R19 rewritten with the
comparison-heavy residual. Fix-ups G2.F1–G2.F3:

#### G2.F1 Realm: string-consumer guard sizing · O · S
- **Owns**: W2.2's files (`src/engine/realm/{realm,membrane,prelude}.js`, `tests/engine/realm/*` except `wmploc.test.js`, `tests/realm-gate/**`, `tests/corpus/realm-gate.test.js`).
- **Do**: the W2.2 round-3 reviewer's instructions verbatim: a `stringSizeOf(v)` (string: length; number/boolean/undefined/null/symbol: ≤ 32; any object, function, bigint, array, typed array or proxy: `Infinity`; never reads through the operand) used for every operand a builtin turns into a string (String.prototype receivers including repeat/pad, the `arg` group incl. JSON.parse and the RegExp entries, replace/replaceAll subject and argument); the array-aware `sizeOf` stays for the array/typedarray tables and `spreadSize` for concat; update the GUARDED_BUILTINS comment. Tests: the five lying-`toString`/`Symbol.toPrimitive`/RegExp loop cases are hard faults within budget + 300 ms; small calls still return native results (`String.prototype.indexOf.call([1,2],'2') === 2`, `JSON.parse(['1']) === 1`, `/1/.test([1]) === true`, `'ab'.replace('b',[1]) === 'a1'`).
- **Acceptance**: `npm test -- tests/engine/realm tests/realm-gate`, `npm run corpus -- realm-gate`, `npm run check`.

#### G2.F2 Object model: clicks, screen size, debounce · S · S
- **Owns**: W2.3's files (`src/engine/model/{schema,policy,ledger}.js`, `src/engine/model/objects/**`, `tests/engine/model/{schema,policy,ledger,objects*}*`).
- **Do**: annotate the graph with the amended `ObjectGraph`/`CreateObjectGraphFn` (drop the local ObjectGraphPlus typedef); BUTTONGROUP `click(i)` and BUTTONELEMENT `click()` become live and call `deps.queueEvent(el, 'onclick')` (ledger `stub` when no `queueEvent` is supplied); `event.screenWidth`/`screenHeight` read the new `EventInit` fields; seek/volume coalescing becomes a trailing 40 ms debounce (latest value, sent 40 ms after the last write; rate cap unchanged). Tests for each.
- **Acceptance**: `npm test -- tests/engine/model`, `npm run check`.

#### G2.F3 DSP onChange on change only · S · S
- **Owns**: W2.5's files (`src/hosts/tauri/{media,dsp}.js`, `tests/hosts/tauri/{media,dsp}*`).
- **Do**: the Tauri `DspPort` fires `onChange` only when a stored value actually changes (a detented or clamped write that leaves the value where it was is silent), matching the test host; test it.
- **Acceptance**: `npm test -- tests/hosts/tauri`, `npm run check`.

#### G2.F4 Realm hardening from the security review · O · M
- **Owns**: W2.2's files (`src/engine/realm/{realm,membrane,prelude}.js`, `tests/engine/realm/*` except `wmploc.test.js`, `tests/realm-gate/**`, `tests/corpus/realm-gate.test.js`).
- **Source**: `docs/research/realm-security-review-g2.md` (25 verified findings; each has a repro and the verifier's fix). Apply the verifier's fix unless it conflicts with ENGINE D1, in which case stop and report.
- **Do** (every item gets a regression test built from its repro, asserting the bound):
  1. **DOS-1** heap cap: give the QuickJS module a capped `WebAssembly.Memory` (`maximum` from `memoryLimitBytes` plus the variant's initial memory, with the glue's growth margin), assert `getWasmMemory()` identity, and after each entry turn `buffer.byteLength > heapCap` into a hard `memory` fault (poison + discard). Test: the hoard loop ends as a hard memory fault with host RSS growth under ~2× the cap.
  2. **DOS-2** drain bound: `drainQueue` stops after `budgets.load` ms of wall time with one soft fault and drops the rest.
  3. **DOS-3 / F3 / S1** compile budget: `REALM_CAPS.maxScriptChars` 1 MiB (soft `script-too-large`); refuse `loadScript` when `scriptsSpent >= budgets.scripts` (hard `budget`, no compile); `repairScript` takes a `stop` callback checked before every compile; a stop or an overrun is a hard `budget` fault, never a syntax diagnostic.
  4. **DOS-5** overrun: an entry whose wall time passes `deadline + REALM_CAPS.overrunSlackMs` (300) is a hard `budget` fault even with no interrupt poll.
  5. **DOS-7 / F7** diagnostics: host-side `REALM_CAPS.maxIdWriteDiags` 64 then one `realm-id-write-capped`; the prelude reports only real ids, deduped on the lowercased key. Also cap every other realm-originated diagnostic stream at 64 per view.
  6. **F1** keys: reject keys and strings over 64 KiB before copying (realm half in the traps; host half reads `length` through `getProp` without `getString`).
  7. **DOS-4** extend guards (accidental paths only): String.prototype trim/trimStart/trimEnd/normalize/localeCompare/slice/substring/substr/at/concat; a global table for parseFloat, parseInt, encodeURI(Component), decodeURI(Component), escape, unescape; Map/Set has/get/set/add/delete sized by the key. Operators stay a recorded residual (E R19).
  8. Lows that are cheap: **F2** (`throw <Promise>` must not reach a host use-after-free), **F4** (prelude proxy handler objects null-prototype and frozen), **F5** (classify OOM only from QuickJS's own signal, not a thrown object's name), **DOS-6** (an OOM or stack overflow caught by skin `try/catch` still ends the entry as a hard fault), **DOS-8 / S2** (jobs left after the drain cap are dropped with a soft fault, never run under the next entry), **F8 / S4** (the R20 rewrite takes the position only from QuickJS's own location for this file, and only rewrites a `<call> = <rhs>` shape).
  9. Record any low you do not fix (S3, S5-S8, DOS-9) as a one-line note in the review doc's header with the reason.
- **Acceptance**: `npm test -- tests/engine/realm tests/realm-gate`, `npm run corpus -- realm-gate` (219/219 still load), `npm run check`, and every repro in the review doc re-run against the fixed realm with its bound.

- Copy the printed `Unnamed_*` ids into E §D10.6 placeholders (the sidecar itself is created in W3.8).
- Bless the legacy S5 states: add the S5 points from `regions.mjs` to `tools/skinlab/states.mjs` and
  run `bless --target legacy --states S5 --reason "G2: supplemental hover/press"`.
- Review the realm (W2.2) against E D1 line by line; this is the security core.

---

## Wave 3: layout, bindings, animation, rendering, hit, input, widgets, and the re-pin

All tasks run in parallel. W3.R is Opus.

### W3.1 Layout pass and alignment · S · M

- **Owns**: `src/engine/layout/{expr.js, align.js}`, `tests/engine/layout/{expr,align}.test.js`,
  `tests/headspace/layout.test.js`, `tests/corpus/layout.test.js`.
- **Implements**: E §5.11 `evaluateLayout`, `recordAnchors`, `relayout`; E D5 once-only `jscript:` in
  document order, forward reads of unevaluated values as their default, the 1,000 ms pass cap, anchors.
- **Consumes**: W2.1 model, W2.2 realm (with a fake dispatcher wired to the model in tests).
- **Acceptance**:
  1. `npm test -- tests/engine/layout/expr tests/engine/layout/align`: forward read of a literal;
     unevaluated `jscript:` reads 0; self-reference `view.width-2*left`; a script global read
     (`eqLeft+0`); right/center/stretch re-anchoring on `relayout`; a pass that exceeds 1,000 ms stops
     with a diagnostic and leaves the remaining attributes at their literals.
  2. `npm test -- tests/headspace/layout`: every row of `parity 0.4` (volume 89/11, label 108, eq1
     11/44, eq*i* x = 11 + 15·i, reset 140/**127**).
  3. `npm run corpus -- layout`: 9SeriesDefault `svMain.width` reads `svStub`'s literal 263; Revert's
     `view.width-2*left` evaluates; no host exception over the 195 main views.
- **Deps**: W2.1, W2.2.

### W3.2 Bindings · S · M

- **Owns**: `src/engine/bind/{paths.js, bindings.js}`, `tests/engine/bind/*`.
- **Implements**: E §5.11 `parsePath`, `createBindings`; E D5 bindings: the grammar with call segments,
  subscription to every object on the path and re-resolution on replacement, change-only assignment
  through the queue, drag suspension, `wmpenabled:`/`wmpdisabled:` on any boolean, per-frame position to
  host bindings and `realmTickHz` coalescing for realm-visible changes.
- **Consumes**: W2.1 model, W2.3 object graph (with W1.10 fakes).
- **Acceptance**: `npm test -- tests/engine/bind`: `player.settings.getMode('loop');` parses; a trailing
  `;` is accepted; replacing `currentMedia` re-resolves a bound `duration`; an equal value fires nothing;
  the stop element's `enabled` follows `isAvailable('stop')`; the pause button's `visible` follows
  `wmpenabled:player.controls.pause`; a volume change from media during a drag is held and applied once
  at drag end; one media volume event causes at most one `setVolume`, and zero when equal; on a 60 Hz
  manual clock, a bound seek `value` updates every frame while `value_onchange` reaches the realm at
  most 10 times per second.
- **Deps**: W2.1, W2.3.

### W3.3 Animator · S · S

- **Owns**: `src/engine/anim/animator.js`, `tests/engine/anim/*`.
- **Implements**: E §5.11 `createAnimator`; E D2 animation rules.
- **Acceptance**: `npm test -- tests/engine/anim`: `moveTo(0, top, 120)` from x 207 is at 103 or 104 at
  60 ms (rounding rule documented in the test) and at 0 by 120 ms; `onendmove` fires exactly once after
  the final write; a retarget cancels without firing and the replacement fires at its end, including a
  reversed move; `slideTo` follows the cubic ease-in-out curve at 25/50/75%; `alphaBlendTo` is linear and
  fires `onendalphablend`; everything on the manual clock.
- **Deps**: W2.1.

### W3.4 DOM renderer and the fixture harness · S · L

- **Owns**: `src/engine/render/dom/*`, `tools/skinlab/{fixture.html, fixture-mount.js,
  cmd-fixtures.mjs}`, `tools/skinlab/fixtures/*.case.js`, `tests/engine/render/*`.
- **Implements**: E §5.11 `createRenderer`; E D2 layer tree, drawables, slots, subview clipping and
  `mask-image` clip, `textContent`-only text with the oracle's box, font sanitising, cursor keywords,
  diffed writes. Fixture cases build synthetic skins with `tests/support` writers and compute expected
  pixels from the fixture data (never from art).
- **Consumes**: W2.1 model and paint order, W2.4 image service.
- **Acceptance**: `npm run skinlab -- fixtures --area render` passes every case: BUTTON states and the
  fallback chain; BUTTONGROUP per-pixel states with `showBackground` both ways (unowned pixels painted
  or not); a tiled slider with `borderSize` caps; `slide` true and false; a vertical slider; slider thumb
  at `'oracle'` and `'docs'` geometry; TEXT size, justification, ellipsis and underline; a marquee step on
  the manual clock; nested subview clip and a `clippingColor` mask that also clips a child slot; a
  size-less subview that does not clip; negative z under the background; equal z in document order;
  `alphaBlend` on a subview; a DOM assertion that no engine node has an inline or computed `z-index`
  other than `auto`, no `<img>`, and no `innerHTML` was used (checked by a `MutationObserver` that
  records node types).
- **Deps**: W2.1, W2.4.

### W3.5 Picker and window shape · S · M

- **Owns**: `src/engine/input/picker.js`, `src/engine/shape/mask.js`, `tests/engine/input/picker.test.js`,
  `tests/engine/shape/*`, `tests/headspace/picker.test.js`.
- **Implements**: E §5.11 `pick`, `rasterizeShape`; E D2 hit-plane table, picker roles, window shape
  rules including the popcount < 64 fallback.
- **Consumes**: W2.1 model, W1.3 keying planes (directly, through a small in-test image service).
- **Acceptance**:
  1. `npm test -- tests/engine/input/picker tests/engine/shape`: one unit case per row of the E D2 hit
     table and per role; `passThrough` falls through but its SUBVIEW children still hit; `enabled=false`
     returns `blocked`; a clipped pixel is skipped; `buttonKeyedPixelsHit` false turns keyed BUTTON
     pixels into misses; the shape of an all-transparent view is the full view rect with a diagnostic.
  2. `npm test -- tests/headspace/picker` (Node, no DOM): the head's magenta hole picks the effects
     slot; head red picks nothing; a pause-button magenta corner picks the pause button; an unowned
     transport pixel picks the head background (`chrome`); the EQ panel under the closed ear is occluded
     by the head; the S1 shape differs from the legacy S1 golden mask by exactly the 106 corners in
     `compat`, and by the 106 corners plus the keyed handle pixels in `faithful` (the count is printed).
- **Deps**: W2.1, W1.3.

### W3.6 Input dispatch · S · M

- **Owns**: `src/engine/input/dispatch.js`, `tests/engine/input/dispatch.test.js`.
- **Implements**: E §5.11 `attachInput`; E D2 gestures (down/up/click on the same element, dblclick,
  hover enter/leave without bubbling), capture on every control press until up or cancel, the DOM
  `click` ignored, `setPointerCapture` in try/catch, synthetic events never starting a native drag,
  slider drag phases, keyboard routing (focused element, then VIEW; returns whether a skin handler ran),
  tooltip and cursor on the input plane, right-press forwarding per E D10.1.
- **Consumes**: the `pick` signature only (tests inject a fake picker); a fake `InputSink`.
- **Acceptance**: `npm test -- tests/engine/input/dispatch` (happy-dom): press on A and release on B
  fires down on A, up on B, no click; press and release on A fire one click; a trailing DOM `click` adds
  nothing; `setCapture(true)` on press and `false` on up and on cancel; a press on `chrome` with
  `isTrusted` false never calls `startDrag`, and with a real-event flag it does; a right press on an
  element with `onmousedown` goes to the sink and reports "handled"; a slider drag emits begin, move and
  end with values from the `'oracle'` geometry; hover changes `title` and `cursor` on the plane.
- **Deps**: W2.1 (types only).

### W3.7 Host widgets: playlist, VizHost, overlays · S · M

- **Owns**: `src/app/widgets/{playlist.js, playlist.css}`, `src/app/viz-host.js`,
  `src/app/overlays.{js,css}`, `src/app/slots.js`, `tests/app/{playlist,viz-host,overlays}.test.js`.
- **Implements**: E D10.2 to D10.4: the playlist port (new file, pinned `playlist.js` untouched) over a
  `MediaModel` with the honoured attributes and the hand port's CSS scoped under the slot; the combo
  list closing on a window-root listener; `onHitRectsChange` for the open combo; VizHost creating
  `new Viz(...)` from the unchanged `src/viz/index.js` with an `EffectsControl`, pixel ratio on zoom,
  palette subscription with the stale guard; the toast, notice and caption inside the effects slot with
  CSS copied from `css:137-188`; `src/app/slots.js` composes these into a `SlotProvider`.
- **Acceptance**: `npm test -- tests/app/playlist tests/app/viz-host tests/app/overlays` (happy-dom; `Viz`
  mocked): five fake queue rows render with the current row class; double-click plays that position;
  choosing a stored playlist calls `playPlaylist`; the open combo reports its rect; the toast shows for
  4.5 s on a song change and the notice text follows connection and `engine_info`; `EffectsControl.step`
  wraps over five presets and persists to `mediacenter.effectPreset`. Pixel parity of the playlist is
  checked in W5.1 (S3).
- **Deps**: W1.10, W2.6.

### W3.8 Sidecar loader and the demo driver · S · M

- **Owns**: `src/app/sidecar.js`, `src/app/sidecar.schema.json`, `src/app/sidecars/<sha256>.json`
  (named by the owner's Headspace SHA-256, with the `Unnamed_*` refs O recorded at G2),
  `src/app/demo/{driver.js, headspace.js, target.js}`, `tests/app/{sidecar,demo}.test.js`.
- **Implements**: E D10.6 sidecar schema and validation (Maps for refs; `x-` attributes; `hostStyle`
  allow-list; `compat` block; `restore`; `viewResize`); E D10.7 `DemoTarget` built from a
  `SkinInspector`, the generic driver (copied from `demo.js`: cursor, glide, synthetic pointer events,
  flash, `record_*` timing) and the Headspace choreography using only `DemoTarget` calls
  (`groupPoint(transport, '#FFFF00' / '#0000FF')`, `sliderThumbPoint`, `call('ToggleEqView')`, …).
- **Acceptance**: `npm test -- tests/app/sidecar tests/app/demo`: the schema rejects unknown keys,
  non-`x-` host attributes outside `compat`, and a `hostStyle` key other than `letterSpacing`; refs
  named `__proto__` are plain refs; the driver run against a fake `DemoTarget` with a fake clock emits
  the expected pointer-event sequence for the first click and a band drag; the choreography never
  references a pixel constant from `demo.js` (asserted by a grep in the test for `65`, `37 / 144`,
  `131 / 144`).
- **Deps**: W2.1 (ids printed at G2).

### W3.R Re-pin batch: Rust glue, CSP, guards · O · M

- **Owns**: `src-tauri/src/lib.rs`, `src-tauri/src/clickthrough.rs` (deleted),
  `src-tauri/src/{hit_cmds.rs, skin_cmds.rs, prefs_cmds.rs}`, `src-tauri/src/audio.rs`,
  `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`,
  `tools/skinlab/goldens.manifest.json`.
- **Implements**: E D7.1 commands (`hit_set_bits`, `hit_set_regions`, `hit_capture`, and the legacy
  `set_hit_mask`/`set_capture` as caller-bound wrappers), the poll thread over `HitTable` with the 8 ms
  overlap rate and `Destroyed` cleanup; E D4 `skin_import/list/read/remove`; E D6.4
  `prefs_load(ns) -> HashMap<String,String>`, `prefs_write(ns, key, value: Option<String>)` plus a
  `prefs-changed` event; `skin_default_path() -> Option<String>` (returns the
  `WINDOW_HEADMPD_SKIN` environment variable if set, else `~/Downloads/Headspace.wmz` if it exists; the
  webview cannot read process env itself); E D11 fan-out wiring (`audio_subscribe` accepting both call shapes and
  returning an id, `audio_unsubscribe`, per-label drop); E §7 CSP and `devCsp`, the `mpd` verb
  allow-list, the `record_stop` path guard, `allow-set-position`.
- **Acceptance**:
  1. `cargo build` and `cargo test` in `src-tauri` pass.
  2. `npm run skinlab -- bless --target legacy --repin --reason "W3.R re-pin"`: the oracle pin changes,
     so keys change, but **every PNG and mask hash equals the previous manifest's**; otherwise revert.
     This only proves the JS-visible pinned files did not change the oracle; it cannot see Rust or CSP.
  3. In-app smoke checklist, legacy mode, items L1 to L12 (below) all pass.
  4. `?engine=wmp` in the real app shows "QuickJS OK: 2" **under the new CSP**, with no CSP violations in
     the console. If WKWebView rejects `'wasm-unsafe-eval'`, apply E R14's fallback and record it.
  5. The pin table in `parity` line 18 is superseded by `tools/skinlab/pins.mjs` plus the manifest; O
     notes the new hashes in E Appendix A.
- **Deps**: W1.7, W1.8, W1.9.

### Gate G3 · O

- Review every engine module against its ENGINE.md section; confirm `tsc --checkJs` covers them all.
- Confirm the sidecar refs resolve on the built model (`inspector` does not exist yet; use
  `ViewModel.byId` in a one-off test).

---

## Wave 4: composition, Tauri host, app shell

All tasks run in parallel.

### W4.1 View runtime, engine entry, inspector · S · L (O review required)

- **Owns**: `src/engine/{index.js, view-runtime.js, inspect.js}`, `tests/engine/runtime/*`.
- **Implements**: E §5.10 `createEngine`, `Engine`, `LoadedSkin`, `ViewRuntime`, `SkinInspector`,
  `WmsSkinHost` (`SkinHost`/`HostedSkin` of E D12 with `capabilities` `{eq: null, wantsPcm: false,
  windowModel: 'native-per-view', scripted: true}`); E §3.1 load sequence in exact order; the frame loop
  of E §3.2 (animator, position tick, bindings, renderer, mask with hash-gated sends); fault policy and
  fault-panel notification through `host.actions.fault`; sidecar application (overlays at build, `attrs`
  after layout, `compat` only under `oracle-compat`); `settled()`; `setInitialSize` at attach; a
  `headless` option (no renderer, input or shape) for the corpus runner; the inspector's `groupPoint`
  and `sliderThumbPoint`.
- **Consumes**: every wave-1 to wave-3 engine module; the TestHostAdapter.
- **Acceptance**:
  1. `npm test -- tests/engine/runtime` (headless, Node): an event log over a synthetic skin shows the
     E §3.1 order exactly (literal pass, prelude, scripts, `jscript:`, bindings, `onload`, queue drain);
     `settled()` resolves only after tweens, queued events and decodes finish; an `onload` that loops is
     a hard fault and `health.unloaded` becomes true after the third; `view.close()` from `onload` is
     denied.
  2. `npm run skinlab -- check --config compat --state S1,S2,S2b,S4 --dpr 1` exits 0 (bounds in measure
     mode). **This is the first end-to-end parity.**
  3. `npm run skinlab -- check --config faithful --state S1,S2,S4 --dpr 1` exits 0 in measure mode and
     reports the counts for `U-23-showBackground` and `button-transparency`.
  4. Headspace load time under the test host is printed (target < 250 ms on the owner's Mac; reported,
     not gated).
- **Deps**: W3.1 to W3.6, W2.1 to W2.4, W2.7, W3.8 (sidecar file).

### W4.2 Tauri host adapter · S · M

- **Owns**: `src/hosts/tauri/{index.js, window.js, prefs.js, audio.js, clock.js, skins.js}`,
  `tests/hosts/tauri/{window,prefs,audio,clock,skins}.test.js`.
- **Implements**: E §5.8 `HostAdapter` over Tauri: `createNativeSkinWindow` (zoom as CSS scale plus
  `setSize`, `setShape` as one raw `hit_set_bits` body per frame, `setCapture` via `hit_capture`,
  `startDrag`, `setInitialSize`, `requestSize` returning false, pins, `onClose`); `PrefStore` over
  `prefs_load`/`prefs_write` with the `prefs-changed` event; `AudioFrameBus` over `audio_subscribe` with
  a `Channel`; the rAF clock; `skins.js` (`importDefault()` for first run and `WINDOW_HEADMPD_SKIN`,
  `read(sha)`; the path comes from `skin_default_path`); `createTauriHost` composing these with W2.4's decode pool, W2.5's media and DSP, W2.6's
  palette and W3.7's slots.
- **Acceptance**: `npm test -- tests/hosts/tauri` with a mocked `invoke` and window: `setShape` called
  three times in one frame produces one `hit_set_bits` call whose body decodes to the last shape;
  identical shapes are not resent; `setZoom(1.5)` sets the transform, sizes the window to 1140×591 and
  resends the shape with zoom 1.5; prefs writes are debounced 250 ms; a `prefs-changed` event from
  another window reaches `onExternalChange`; `importDefault()` imports `~/Downloads/Headspace.wmz` only
  when no skin is recorded.
- **Deps**: W3.R, W2.4, W2.5, W2.6, W3.7.

### W4.3 App shell · S · M

- **Owns**: `src/app/{boot.js, menu.js, keys.js, zoom.js, fault-panel.js, migrate.js, skin-registry.js,
  restore.js, safe-mode.js, app.css}`, `tests/app/{menu,keys,zoom,fault-panel,migrate,restore,safe-mode,boot}.test.js`.
- **Implements**: E D10.1 menu (skin first; Control/Option always host; Option-held legacy/engine flip);
  E D10.5 keys; zoom; E D10.6 `restore`; E D10.8 fault panel, safe-mode marker, legacy prefs migration;
  E D12 `skin-registry` (every archive through `openVfs`; `canLoad`; one host registered in phase 1);
  `boot.js` composing `createTauriHost` + `createEngine` + the shell, against the contracts.
- **Acceptance**: `npm test -- tests/app` (happy-dom, mocked host and engine): a right press handled by
  the skin opens no menu, an unhandled one does, Control-click and Option-click always do; Space with
  Cmd held does nothing; ↑ with volume −1 sends nothing; migration copies the eight legacy keys once
  and never again; a set `boot.pending` at launch shows the fault panel without loading the skin;
  Shift at launch does the same; `restore` persists `eqOpen` after a dispatch that changes `eqIsOpen`
  and calls `ToggleEqView` after `onload` when it is true; `boot.js` boots against `createTestHost()` and
  a stub engine without throwing.
- **Deps**: contracts only (integration happens in W5.2).

### W4.4 Legacy demo capture · S · S

- **Owns**: `tools/skinlab/{cmd-demo.mjs, demo-legacy-mount.js}`, `tests/skinlab/demo.test.js`.
- **Implements**: runs the pinned legacy `runDemo` headless under the skinlab Tauri stub (triggered
  through the stubbed `mpd-message` event), and records the sequence of `mpd`, `set_eq`, `set_balance`,
  `record_start`/`record_stop` calls with timestamps and the band values after each drag, as the
  reference for W5.3.
- **Acceptance**: `npm run skinlab -- demo --target legacy` exits 0 and writes the call log to the
  output directory; the log shows EQ open by t = 7.5 s, band values `[10, 8, 0, 0, -5, 0, 0, 0, 6, 9]`
  after the drags, and five preset steps.
- **Deps**: W0.5.

### Gate G4 · O

- Set the allow-list bounds from W4.1's measured counts (`U-23-showBackground` per group,
  `button-transparency` per state; expected about 811 + 1 and about 265) and record them in E
  Appendix A. From now on skinlab runs with `--strict`.
- Triage any compat difference in S1/S2/S2b/S4 into fix tasks for wave 5F.

---

## Wave 5: parity completion, integration, demo, corpus

W5.1 to W5.5 run in parallel. Wave 5F (fixes) is cut by Opus from their reports.

### W5.1 Parity completion · S · L

- **Owns**: `tools/skinlab/{engine-mount.js, states.mjs, cmd-check.mjs}`.
- **Implements**: E D9 complete: engine-mount injects the real playlist widget (W3.7) into the test host's
  playlist slot; engine-side S3, S3b, S5, S6 and S7; `--browser webkit` (Playwright WebKit, report-only);
  `--strict` everywhere.
- **Acceptance** (the G5 criteria; a failing state produces a triage report, not a workaround):
  1. `npm run skinlab -- check --strict --config compat --state S1,S2,S2b,S3,S3b,S4 --dpr 1,2` exits 0:
     zero pixels outside the effects hole; mask XOR exactly the 106 corners.
  2. `npm run skinlab -- check --strict --config faithful --state S1,S2,S2b,S3,S3b,S4,S5,S6 --dpr 1,2`
     exits 0: every difference inside an allow-list entry within its bound.
  3. S2 equals S2b in both configurations.
  4. `npm run skinlab -- check --browser webkit --config faithful --state S1,S2,S3,S4 --dpr 2` produces a
     report (report-only).
- **Deps**: W4.1, W3.7.

### W5.2 App integration · S · M

- **Owns**: `src/app/boot.js`, `src/app/demo-trigger.js`, `tests/app/integration.test.js`.
- **Implements**: the real composition in the app: safe-mode check, skin resolution and first-run
  import, sidecar load, `engine.load`, `attach`, shell features, restore, the `mpd-message` demo trigger
  calling `runTour(target, headspaceChoreography, wav)`.
- **Acceptance**: `npm test -- tests/app/integration`; `npm run build` exits 0; then O runs the **in-app
  smoke checklist** (below) items L1 to L12 in legacy mode and E1 to E10 in engine mode.
- **Deps**: W4.1, W4.2, W4.3, W3.8.

### W5.3 Demo on the engine · S · M

- **Owns**: `tools/skinlab/demo-engine-mount.js`, `tools/skinlab/cmd-demo.mjs` (adds `--target engine`
  and `--compare`).
- **Implements**: E D10.7 acceptance: the tour runs headless against the engine with the test host, the
  call log is recorded in W4.4's format, and `--compare` diffs it against the legacy log.
- **Acceptance**: `npm run skinlab -- demo --target engine --compare` exits 0: the same ordered `mpd`
  verbs and arguments and the same `set_eq` vectors as the legacy log (timestamps within 1 frame of
  each other's schedule are not compared); EQ open by t = 7.5 s; band values
  `[10, 8, 0, 0, -5, 0, 0, 0, 6, 9]`; five preset steps.
- **Deps**: W4.1, W4.4, W3.8.

### W5.4 Corpus robustness and ledger · S · M

- **Owns**: `tools/corpus.mjs`, `tools/skinlab/cmd-corpus.mjs`, `tests/corpus/load.test.js`,
  `docs/coverage/{ledger.md, corpus-load.txt}`.
- **Implements**: E D6.7 and E D10.9 criterion 6. Node stage: every distinct skin through the headless
  runtime (zip, select, scan, build, realm, layout, bindings, `onload`, a scripted minute of play,
  pause, seek and `moveTo` targets on the manual clock). Chromium stage (`skinlab corpus`): mount, first
  frame, mask.
- **Acceptance**: `npm run corpus -- load` and `npm run skinlab -- corpus`: 195/195 distinct skins
  with **zero uncaught host exceptions and zero renderer crashes**; a non-empty first frame for every
  skin that loads; R0, R1 and R2 with zero realm hard faults; the hard-fault list, the canvas-clamp hits
  (expected 0), size-less subview counts and load times written to `docs/coverage/corpus-load.txt`;
  `docs/coverage/ledger.md` lists per member how many skins touched it and its impl.
- **Deps**: W4.1.

### W5.5 Oracle regeneration from a tag · S · S

- **Owns**: `tools/skinlab/cmd-bless.mjs` (adds `--from-tag`), `tests/skinlab/from-tag.test.js`.
- **Implements**: E D9 post-cutover regeneration: `bless --target legacy --from-tag <tag>` creates a
  temporary `git worktree` at the tag, runs `npm ci` there, captures from it, compares with the manifest,
  and removes the worktree.
- **Acceptance**: with a temporary local tag at the current HEAD (deleted after the test):
  `npm run skinlab -- bless --target legacy --from-tag skinlab-selftest --verify-only` exits 0 and
  reproduces every manifest hash.
- **Deps**: W0.5.

### Wave 5F: parity fixes · S tasks cut by O

O reads the W5.1 to W5.4 reports and cuts one fix task per root cause. Each fix task **owns the engine
or app modules it edits** (no two in the same sub-wave share a file), states the failing state and the
measured diff, and has the single acceptance "the named skinlab, demo or corpus command now exits 0,
and every previously green command stays green". A fix may not add an allow-list entry; only O can,
with a deviation id and a reason.

### Gate G5 · O (parity gate)

1. All W5.1 checks in `--strict` mode, both configurations, DPR 1 and 2.
2. WebKit report-only pass reviewed; every extra difference has a finding.
3. **G-WK, the in-app gate**: run the app on the legacy flag and on the engine flag; for S1 to S4, click
   the same points, capture with `swift tools/window-bounds.swift` + `screencapture -l <id> -o`, and run
   `npm run skinlab -- diff --files legacy.png engine.png` with the faithful allow-list. Pass means
   nothing outside the allow-list.
4. In-app smoke checklist, all items, engine mode.
5. Ledger review: Headspace's ledger lists only the expected stubs (`pl.setColumnResizeMode`, `video`).

---

## Wave 6: dogfood and cutover

### W6.1 Engine as the default · O · S

- **Owns**: `src/app/mode.js` (default becomes `'engine'`; the legacy branch stays reachable through the
  Option-menu flag).
- **Acceptance**: G5 passed; the owner dogfoods for a period the owner chooses with no fault unloads and
  no stuck capture (E D10.9 criterion 7).

### W6.2 Cutover · O · M

- **Owns**: deletes `src/main.js`, `src/widgets.js`, `src/playlist.js`, `src/demo.js`, `src/style.css`;
  edits `src/entry.js` (engine only), `index.html`, `tools/convert_skin.py` (icon step only),
  `package.json` (`skin` script), `src-tauri/src/lib.rs` (removes the legacy `set_hit_mask` JSON wrapper
  and `set_capture`), `tools/skinlab/` (legacy capture only through `--from-tag`), `.gitignore`
  (`public/skin/` line kept until the folder is gone).
- **Procedure**: check every E D10.9 criterion; create the tag `oracle/headspace-v1` at the last commit
  that contains the hand port; delete; run `npm run skinlab -- bless --target legacy --from-tag
  oracle/headspace-v1 --verify-only` and require every manifest hash; run the whole check suite against
  the tag-regenerated goldens.
- **Acceptance**: `npm run check`, `npm test`, `npm run build`, `cargo test`, the strict skinlab checks
  and the demo comparison all pass after deletion; the app boots straight into the engine.

### W6.3 Seam-freeze review · O · S

- Review E §5 against Webamp's needs (`webamp 2`, `webamp 4`), map each to a v1 member or a named
  phase-2 extension, and record the result in E D12. Phase 2 starts from this.

---

## Wave 7 (optional): rungs R1 Miniplayer and R2 aoe

Run only if waves 0 to 6 left budget. No legacy oracle exists for these skins, so acceptance is
behavioural plus an Opus visual review, after which the engine's own captures become regression goldens.

### W7.1 Rung harness · S · S

- **Owns**: `tools/skinlab/{cmd-rung.mjs, rungs/R1.states.mjs, rungs/R2.states.mjs}`, `cmd-bless.mjs`
  (adds `--target engine --skin <path>`).
- **Implements**: per-rung behaviour scripts: load, play, pause, seek, volume, mute (R1 sticky mute
  button), EQ (R2), and for each step the expected `MediaModel` calls and visible-state assertions.
- **Acceptance**: `npm run skinlab -- rung R1` and `rung R2` run their scripts and report; they skip
  with 77 when `skins/wmp` is absent.
- **Deps**: W5.1.

### W7.2 R1 fixes · S · M and W7.3 R2 fixes · S · M

- **Owns**: whichever engine modules the O-cut fix list names (disjoint between W7.2 and W7.3).
- Expected work, from `survey` R1/R2: view size and window shape from the VIEW `backgroundImage` and
  `transparencyColor` (E D7.4 initial size), the TEXT `scrolling` marquee, `currentPositionString` text,
  sticky `down` bound to `player.settings.mute`, RLE BMPs, 35 case-mismatched references, `itemsPlaylist`.
- **Acceptance**: `npm run skinlab -- rung R1` (W7.2) and `rung R2` (W7.3) exit 0 with zero realm faults;
  the ledger is reviewed; O visually reviews the captures and blesses them with
  `bless --target engine --skin … --reason "R1 regression baseline"`.

---

## In-app smoke checklist

Run by O on the owner's machine with MPD running and the FIFO output configured. Legacy items after
W3.R and at G5; engine items at W5.2 and G5. Each item is pass or fail with a note.

**Legacy mode (`L`)**

| # | Check |
|---|---|
| L1 | App boots; Headspace renders as before; no console errors. |
| L2 | Clicks pass through transparent pixels (the strip right of the closed head, the area outside the silhouette) to the window beneath. |
| L3 | Dragging by the head moves the window. |
| L4 | EQ and PL drawers open and close; the mask updates when they settle. |
| L5 | Dragging a slider thumb off the skin keeps tracking; releasing outside ends the drag. |
| L6 | Volume, balance (detent) and EQ change the sound. |
| L7 | Playlist: the combo switches to a stored playlist (MPD `clear` + `load` still allowed); double-click plays. |
| L8 | Vis chooser opens; preset steps; clicking the screen steps the preset. |
| L9 | Right-click, Control-click and Option-click menus; Keep on Top; Larger Size (mask follows). |
| L10 | Keyboard: Space, arrows, V. |
| L11 | Visualizer receives frames; `tools/facelab.html` still works. |
| L12 | `mpc sendmessage window_head "demo /tmp/window_headmpd-demo.wav"` runs the tour and writes the WAV (the `record_stop` guard allows `/tmp`). |

**Engine mode (`E`)**, in addition to L1 to L12 behaving the same:

| # | Check |
|---|---|
| E1 | Boot has no CSP violations; QuickJS instantiates. |
| E2 | S8: press a button, move off the window, release: the button is not stuck in its down art. |
| E3 | The mask updates during a drawer slide (the newly uncovered area is clickable before the slide ends). |
| E4 | Prefs persist across restarts: zoom, Keep on Top, Show on All Desktops, EQ gains, balance, drawer state (restored with animation). |
| E5 | Legacy prefs are migrated on the first engine boot. |
| E6 | Fault: a synthetic skin (built by `tests/support/wms-builder.js` into `/tmp`, loaded with `WINDOW_HEADMPD_SKIN`) with `while(1){}` in `onclick` shows the fault panel after the click; the window menu still works; "Reload skin" works. |
| E7 | Safe mode: Shift at launch shows the fault panel without loading the skin. |
| E8 | A synthetic skin whose pixels are all transparent is still reachable (full-rect mask) and its menu opens. |
| E9 | The demo tour runs on the engine (`mpc sendmessage window_head "demo …"`) and the owner records a video. |
| E10 | Activity Monitor: idle CPU and memory within 120% of the legacy build. |

---

## Appendix: file ownership by wave

No file appears twice within a wave. Gates edit only ENGINE.md, `allowlist.json` bounds,
`states.mjs` points (G2) and the manifest through `bless`.

| Wave | Task → owned paths |
|---|---|
| 0 | W0.1 `package.json`, lockfile, `vitest.config.js`, `tsconfig.check.json`, `.gitignore`, `src/engine/{contracts.d.ts, options.js, index.js (stub)}`, `src-tauri/Cargo.toml`, `src-tauri/crates/headcore/**` · W0.2 `index.html`, `src/entry.js`, `src/app/{mode,boot}.js` · W0.3 `tools/check-boundaries.*` · W0.4 `tests/support/**`, `tools/make-corpus-manifest.mjs`, `tests/corpus.manifest.json` · W0.5 `tools/skinlab/{run,paths,pins,store,capture,states,cmd-prepare,cmd-bless,cmd-verify-legacy,cmd-show}.mjs`, `vite.config.js`, `legacy.*`, `tauri-stub.js`, `viz-stub.js`, `goldens.manifest.json` |
| 1 | W1.1 `src/engine/archive/**` · W1.2 `src/engine/text/**`, `src/engine/wms/scan.js` · W1.3 `src/engine/image/{probe,keying}.js`, `src/engine/image/decode/**` · W1.4 `tests/realm-gate/**`, `tests/corpus/realm-gate.test.js` · W1.5 `src/engine/realm/wmploc.js` · W1.6 `src/engine/wms/{values,tags,attrs}.js` · W1.7 `headcore/src/hit.rs` · W1.8 `headcore/src/{fanout,guards}.rs` · W1.9 `headcore/src/{skinstore,prefstore}.rs` · W1.10 `src/hosts/test/{clock,media,prefs,dsp}.js` |
| 2 | W2.1 `src/engine/wms/{select,build}.js`, `src/engine/model/elements.js`, `src/engine/layout/stack.js` · W2.2 `src/engine/realm/{realm,membrane,prelude}.js` · W2.3 `src/engine/model/{schema,policy,ledger}.js`, `src/engine/model/objects/**` · W2.4 `src/engine/image/{service,worker}.js`, `src/hosts/tauri/decode.js` · W2.5 `src/hosts/tauri/{media,dsp}.js` · W2.6 `src/app/palette/**` · W2.7 `tools/skinlab/{engine.html, engine-mount.js, diff.mjs, regions.mjs, allowlist.json, cmd-check.mjs, cmd-diff.mjs}`, `src/hosts/test/{index,window,slots}.js` · W2.8 `tools/scan-api.mjs`, `docs/coverage/api-frequency.csv` |
| 3 | W3.1 `src/engine/layout/{expr,align}.js` · W3.2 `src/engine/bind/**` · W3.3 `src/engine/anim/**` · W3.4 `src/engine/render/**`, `tools/skinlab/{fixture.html, fixture-mount.js, cmd-fixtures.mjs, fixtures/**}` · W3.5 `src/engine/input/picker.js`, `src/engine/shape/**` · W3.6 `src/engine/input/dispatch.js` · W3.7 `src/app/widgets/**`, `src/app/{viz-host,overlays,slots}.*` · W3.8 `src/app/{sidecar.js, sidecar.schema.json}`, `src/app/sidecars/**`, `src/app/demo/**` · W3.R `src-tauri/src/{lib,audio,hit_cmds,skin_cmds,prefs_cmds}.rs`, `clickthrough.rs`, `tauri.conf.json`, `capabilities/default.json`, `tools/skinlab/goldens.manifest.json` |
| 4 | W4.1 `src/engine/{index,view-runtime,inspect}.js` · W4.2 `src/hosts/tauri/{index,window,prefs,audio,clock,skins}.js` · W4.3 `src/app/{boot,menu,keys,zoom,fault-panel,migrate,skin-registry,restore,safe-mode}.js`, `src/app/app.css` · W4.4 `tools/skinlab/{cmd-demo.mjs, demo-legacy-mount.js}` |
| 5 | W5.1 `tools/skinlab/{engine-mount.js, states.mjs, cmd-check.mjs}` · W5.2 `src/app/{boot,demo-trigger}.js` · W5.3 `tools/skinlab/{demo-engine-mount.js, cmd-demo.mjs}` · W5.4 `tools/corpus.mjs`, `tools/skinlab/cmd-corpus.mjs`, `docs/coverage/{ledger.md, corpus-load.txt}` · W5.5 `tools/skinlab/cmd-bless.mjs` · 5F: per fix card |
| 6 | W6.1 `src/app/mode.js` · W6.2 deletions and the files listed in its card · W6.3 ENGINE.md only |
| 7 | W7.1 `tools/skinlab/{cmd-rung.mjs, rungs/**, cmd-bless.mjs}` · W7.2/W7.3 per fix list |

Test files under `tests/` follow their task's prefix and are owned by that task.
