# Skin engine: candidate design, delivery-first

Status: candidate design, 2026-10-06, branch `skin-engine`, nothing committed.
Angle: **incremental delivery first.** This design aims for the shortest path to Headspace running on the generic engine with the hand port deleted, then climbs the fixture ladder one rung at a time. Every wave ships something a Sonnet implementer can run and check without asking anyone. Anything the next rung does not need is cut, as long as cutting it does not force a rewrite later. Where cutting would force a rewrite, the seam is built now and the feature is deferred.

## 0. Summary

### 0.1 The plan in one page

1. **The oracle comes first (wave 0).** Before any engine code exists, a headless-Chrome harness (`skinlab`) captures the *legacy* hand port in the four parity states, plus a set of hover and press states. The goldens are content-addressed and live outside git, because they are pixels of Microsoft art. Only a manifest of hashes goes into git. From wave 1 onwards, every task that touches pixels or the hit mask is accepted by one command: `npm run skinlab -- verify`.
2. **Leaf modules come next and run in parallel (wave 1).** These are the zip VFS, the image decoders, the tolerant `.wms` scanner and the QuickJS script realm. None of them needs the DOM. Each is checked against numbers in the research notes (342 archives open, 195 of 195 parse, 12,863 of 12,868 handlers compile, and so on).
3. **Headspace renders statically (wave 2).** State 1 matches the oracle in pixels and in the mask.
4. **Headspace runs interactively (wave 3).** Script, bindings, animation and input are in place, and all four states plus the supplemental checks pass.
5. **Tauri host, app shell, cutover (wave 4).** The engine becomes the default. The legacy port is deleted once the criteria in §7 hold, and a git tag keeps the oracle reproducible.
6. **Rungs (waves 5 and 6).** R1 Miniplayer and R2 aoe are single-view rungs and switch on untrusted-skin loading. R3 PowerToys is multi-view: it puts real per-VIEW WebviewWindows on top of the `SkinWindow` seam and freezes the seam before phase 2.
7. **Phase 2** adds Winamp 2 through Webamp, behind the same `SkinHost`, `SkinWindow`, `HitShape` and `MediaPort` contracts. It also builds the PaletteService artifact tier and the Rust EQ band-set and PCM changes. **Phase 3** is the long tail of the WMP ladder (R4 to R9 and beyond).

### 0.2 Positions at a glance

| ID | Position |
|---|---|
| D1 | QuickJS-WASM on the main thread: `quickjs-emscripten-core@0.32.0` with `@jitl/quickjs-wasmfile-release-sync@0.32.0` (503 KB wasm, 254 KB npm tarball). One runtime per webview, one context per VIEW. A copy-only membrane passes primitives and opaque host handles; case-insensitive host members are realm-side Proxies; handlers run under `with(elementProxy)`; element ids sit on a global-prototype Proxy (a wave-1 spike decides, with a static fallback). Each dispatch gets an interrupt deadline, the runtime has a memory cap, and repeated faults unload the skin. |
| D2 | DOM layers, one positioned node per element, ordered by DOM order with no CSS z-index, with canvases where the engine composites pixels (buttongroup, tiled sliders, customslider frames). Text is DOM text with the oracle's CSS. Hit-testing is **not** done by the DOM: one engine picker runs over the scene model and decoded pixels, and the same model produces the window mask. |
| D3 | The engine's own BMP decoder (1/4/8/16/24/32 bpp, RLE4/RLE8, BITFIELDS, alpha forced opaque), `fast-png` for PNG and `omggif` for GIF, so pixels are identical in Chrome and WKWebView. JPEG goes through the browser with `colorSpaceConversion:'none'`. Keying follows each declaration. Decoding runs in a Web Worker, with an inline fallback for node tests. |
| D4 | The engine reads the zip in memory (its own central-directory reader plus `fflate` inflate) and never extracts to disk. The VFS is flat, case-insensitive and keyed by basename, last entry wins. Caps apply to entries, sizes and compression ratio. A skin's identity is the sha256 of the archive. Rust only imports the file (`appdata/skins/<sha256>.wmz`) and returns raw bytes. |
| D5 | A tolerant hand-written scanner (L4 repair ladder). For duplicate attributes the last one wins and a diagnostic is logged. Literals are applied first, then `jscript:` runs once in document order and is **not** re-evaluated (alignment handles resize). `wmpprop:`, `wmpenabled:` and `wmpdisabled:` bindings are evaluated host-side against the object model and never enter the realm. Each subview is a stacking context (Reading C); equal z falls back to document order. |
| D6 | Host objects are member tables keyed by lowercased name, exposed through the membrane. MPD is reached through a `MediaPort` (wrapping `player.js`), and EQ and balance through a `DspPort` (Rust). Unimplemented members are generated stubs that log once per (skin, api) to a coverage ledger. `loadPreference` returns `"--"` for an unset key. |
| D7 | A `SkinWindow` abstraction. Phase 1 binds it to **native** Tauri WebviewWindows, one per VIEW, and each webview runs its own engine session for its VIEW. Wave 4 adopts the existing `main` window; wave 6 adds the factory. Hit state and capture are per window, keyed by label. Headspace ignores `view.width` writes (D13); other skins honour them from wave 5. The phase-2 Webamp cluster uses `binding:'internal'` together with `HitShape.regions`. |
| D8 | `src/engine/` is TypeScript and Tauri-free, enforced by `tools/check-engine-imports.mjs`. A `HostAdapter` carries clock, windows and surfaces, prefs, media, dsp, audio, effects, widgets, actions, palette and diag. The skinlab `HarnessHost` is the second adapter and is built **before** the Tauri adapter. |
| D9 | `skinlab`: `playwright-core` driving the installed Google Chrome (version pinned in the manifest), DPR 1 and 2, the engine on a manual clock, the visualizer stubbed. The legacy port is captured with zero edits to `main.js`. Diffs are exact per pixel and per mask bit, with a deviations allow-list made of computed regions. A WebKit pass runs as report-only. vitest covers the pure modules, and corpus suites cover the ladder. |
| D10 | An app shell around any skin: the window menu, zoom, keyboard defaults, and the now-playing toast, notice and caption overlays. These overlays sit inside the EFFECTS host container. A sidecar mechanism carries Headspace-only extras. A demo bridge built on engine query handles replaces the DOM handles. A boot switch (`?engine=wmp`) lets legacy and engine coexist until cutover. |
| D11 | Phase 1 changes only the audio fan-out (`Vec<Channel>`). The WMP band centres already match `eq.rs`. Phase 2 adds `eq_configure` (band centres and Q per family), preamp, bypass, and an opt-in `Frame.pcm`. |
| D12 | `SkinHostFactory.probe/start → SkinSession` hides the family. The `MediaPort` is written once. PaletteService: phase 1 defines the `notan-palette/1`-shaped snapshot type and wraps today's k-means as `source:'local'`; phase 2 builds the artifact consumer. |

### 0.3 Critical path

```
W0 skinlab+legacy goldens ──┬─> W2 static render (state 1) ──> W3 interactive (states 1-4) ──> W4 Tauri host + cutover
W1 zip | images | scanner | realm | rust-mask ──┘                                                 │
                                                                                                    ├─> W5 R1/R2 + skin picker + untrusted on
                                                                                                    └─> W6 R3 multi-view + seam freeze ──> Phase 2
```

The tasks inside W1 and W2 run in parallel, because every interface they share is frozen in this document (§3) and is committed verbatim by an Opus task (W1.0 and W2.0) before the Sonnet tasks start.

## 1. Conventions

- Citations: `parity §n` / `parity Dn` = `docs/research/headspace-parity.md`; `spec §n` / `U-n` = `docs/research/wms-spec.md`; `survey §n` / `Gn` / `Rn` = `docs/research/corpus-survey.md`; `wmploc §n`; `webamp §n`; `wsz §n` = `docs/research/winamp2-corpus.md`; `notan Q1..Q3` = `docs/research/notan-input.md`. Code: `main:N`, `widgets:N`, `viz:N`, `demo:N`, `rust:N` (lib.rs), `click:N`, `audio.rs:N`.
- "Skin px" means the skin's own pixel space at zoom 1. The host multiplies by zoom.
- "Runnable" for a wave means a command that a fresh Sonnet session can run, which exits 0 or non-zero and prints a human-readable report.
- **Art rule:** no file derived from skin pixels enters git. That covers PNG goldens, mask bit arrays, decoded images and screenshots. Hashes, popcounts, bounding boxes, counts and coordinates are facts about art, and those may be committed (parity §0 conventions).
- Task owner codes: **O** = Opus (design, interface freezes, verification gates); **S** = Sonnet (implementation). Sizes: **S** ≤ half a day, **M** about 1 day, **L** about 2 days of focused work.

## 2. Decision register

Each entry gives the position, the evidence behind it, what was rejected, and which parts are cut now versus kept open.

### D1. Script realm

**Position: QuickJS compiled to WASM, running synchronously on the main thread of each webview.**

- Packages: `quickjs-emscripten-core@0.32.0` (MIT; JS glue of about 795 KB unpacked, tree-shaken in the bundle) and `@jitl/quickjs-wasmfile-release-sync@0.32.0` (MIT; `emscripten-module.wasm` 503.1 KB, npm tarball 254.2 KB, measured with `npm pack --dry-run`). The **sync** variant is required, because host calls must return values synchronously. The asyncify variant is neither needed nor wanted.
- Runtime layout: one QuickJS runtime per webview, with one context per VIEW. In phase 1 each VIEW gets its own webview (D7), so in practice one context per runtime. Limits (`RealmLimits`, §3.6): memory 32 MiB, stack 512 KiB, a deadline of 50 ms per handler, 1,000 ms per script-file load and per `onload`, 20 ms per `jscript:` expression, at most 64 live timers, minimum timer period 15 ms.
- **The membrane is copy-only.** Only `undefined | null | boolean | number | string | {$h: handle}` cross the boundary. A host object arrives in the realm as an opaque handle, and a realm-side Proxy factory, installed by a fixed bootstrap prelude, wraps it. That Proxy's `get`/`set`/`has` traps call host functions with the raw property name, and the **host** lowercases the name. Realm functions never cross. `setTimeout(fn, ms)` stores `fn` in a realm-side table and passes the host a number. Objects passed to host methods are coerced with `String(x)` inside the realm before they cross.
- **Case-insensitive host members over case-sensitive script identifiers:** host members (on `player`, `theme`, elements and so on) are resolved by the host's lowercased member tables. Script `var`s and functions are ordinary QuickJS globals and stay case-sensitive (U-28; wmploc §4.3 says 43 case-variant calls of skin functions throw in real WMP too).
- **Element-implicit handler scope:** a handler is compiled as `(function(PARAMS){ with (__scope(H)) { BODY } })` and called with `this` set to the element proxy. `__scope(H)`'s `has` trap answers true only for that element's attributes and methods, case-insensitively. Anything else falls through to the outer scope chain (spec §2.4; wmploc §4.3 item 1). Leading `identifier:` labels (`jscript:`, `javascript:`, `wmpprop:`) are stripped from handler text (U-6). PLAYER event parameters (`NewState`, ...) become `PARAMS`, which are case-sensitive (spec §2.2).
- **Element ids as globals:** the primary mechanism is `Object.setPrototypeOf(globalThis, idsProxy)`. The proxy's `has`/`get` resolve ids case-insensitively (survey §3.1: `Ice` `Volume` vs `volume`), so functions declared in script files, whose scope is global and not the handler's `with` chain, can still see `sEqEar`. Script globals are own properties of `globalThis` and therefore shadow ids. That is accepted (U-31: no collision observed). Host globals `player`, `theme`, `view`, `event`, `mediacenter` and `playerApplication` are own properties, so they win over an element with `id="view"` (G17; the choice is logged to the ledger when such a skin loads). **The fallback, if the spike shows QuickJS does not consult a Proxy prototype during global identifier resolution,** is to define accessor properties on `globalThis` for every id in its declared case, plus every case variant of that id that occurs lexically in the skin's `.js` and handler text (a static identifier scan). That covers every corpus case and loses only ids that are built by `eval` *and* mis-cased, which never occurs in the corpus.
- **`jscript:` layout expressions** are evaluated as a direct `eval(SRC)` inside `with(__scope(H))`. The result is the completion value, which handles trailing `;` (456 `top`s, spec §3.2) and `'a\r\rb'` string values.
- **Synchronous reads** are inherent: the host bridge answers on the same stack. `sEqEar.top`, `player.controls.currentPosition` and `view.width` are plain function calls into the engine's model.
- **Timers:** `view.timerInterval`/`ontimer` and `setTimeout` (string and function forms; `setInterval` occurs 0 times, survey §4) are host timers on the `HostAdapter.clock`, so the harness's manual clock controls them.
- **Faults:** an exception, syntax error or interrupt aborts only that dispatch, and a diagnostic is logged once per (skin, site) (wmploc §4.3 item 3: 36% of skins contain at least one bad name). The skin is unloaded on any OOM, or on 3 interrupts within 60 s. The host then shows a notice and falls back to the last skin that loaded cleanly.
- **First task is a spike (W1.4a) with pass/fail criteria** (§6), because none of the semantics above has been run in QuickJS yet.

Rejected alternatives:

- *Web Worker realm.* Synchronous reads of element state are the dominant pattern (`sEqEar.top`, `balance.left` in layout, `xPlTt.tooltip`). A worker could only serve them by running the whole object model inside the worker. Skin code would then share a realm with engine internals: it could monkey-patch `Array.prototype`, `postMessage` forged engine messages, `fetch`, and so on. That gives no real membrane, and fuel would mean killing the whole worker.
- *Sandboxed iframe.* The same problem: synchronous cross-frame access requires same-origin, which gives skin code the parent's realm.
- *Host eval* (`new Function` + `with`). It has no isolation or fuel, and the corpus comes from archive.org (notan Q3). It is kept **only** as a test-only `NativeRealm` for differential tests (same handler corpus, compare results), and the import lint keeps it out of app bundles.

Cut now and kept open: the WASM loads once per webview (about 250 KB gzip). No async realm, no shared runtime across views.

### D2. Renderer, text and hit-testing

**Position: DOM layers, with the engine as the sole hit-tester.**

- **Why the DOM:** the oracle is the DOM (parity §4.1), its text is CSS text with `-webkit-font-smoothing:none`, and parity counts any text diff as a failure. Rendering text with canvas `fillText` would put the most fragile pixels at risk for nothing. `demo.js` measures elements with `getBoundingClientRect` (parity §3.1), and DOM nodes give that for free. Host-drawn controls (the playlist, the effects canvas) are DOM or WebGL anyway.
- **Structure:** each SUBVIEW (and the VIEW) becomes a container `div` with `position:absolute; isolation:isolate; overflow:hidden` whenever it has an explicit size. Its children are appended **in paint order**, and no CSS `z-index` is used. That keeps the demo's `z-index: 1000/2000` budget intact (parity §3.1). Paint order is decided by `model/order.ts` (D5).
- **Images:** every visible image is a `<canvas>` filled from the engine's decoded and keyed RGBA (`ImageStore`), with `image-rendering: pixelated`. Blob-URL `<img>` is used only where an image is shown unchanged and large, as an optimisation behind the same API. No skin-provided URL reaches the DOM.
- **BUTTONGROUP per-pixel mapping:** one canvas. Ownership is an exact RGB match on the map, with no tolerance (spec §6.5). Each owned pixel takes its owner's state layer (disabled > down+hover > down > hover > up, each with the fallbacks of spec §6.4). For unowned pixels a `showBackground` switch picks either the `image` layer or alpha 0. The engine default is the documented `false` (U-23); a Headspace sidecar override is available (§2 D10, §8 risk 3).
- **SLIDER:** the track is a canvas. When `tiled` is set, `borderSize` defines untiled end caps and the middle is tiled, drawn by the engine (the hand port used CSS `border-image` with the same slice, parity G6, `css:83-95`). The foreground is a clip container (`slide=false`: revealed in place) or a translated layer (`slide=true`). The thumb is a canvas. Geometry follows the oracle formula: thumb travel = `length − thumbExtent`, and value from pointer = `(p − thumbExtent/2)/travel` (parity D32, the contract, which `demo:108-113` depends on). The documented `borderSize` inset reading lives behind `sliderTravel: 'oracle' | 'docs'`, default `oracle` (U-10).
- **CUSTOMSLIDER** (needed from R8, designed now): a canvas drawing frame `round(f·(N−1))` from the strip. The strip axis is whichever dimension of `image` is larger than `positionImage`'s (U-9). Hit-testing reads the gray map: a pixel with R=G=B is clickable, and its value is `min + g/255·(max−min)`.
- **alphaBlend:** CSS `opacity` on the element's container. Keyed pixels stay keyed (U-13). `alphaBlendTo` is driven by the animator.
- **moveTo, slideTo, moveSizeTo:** the engine `Animator` (D5) writes `left`/`top`/`width`/`height` on the model on every host-clock frame, and the renderer applies the dirty set once per frame. No CSS transitions are used, so the harness's manual clock is deterministic and `onEndMove` fires from the animator.
- **Subview `clippingColor`:** the container gets a `-webkit-mask-image` built from the background image's non-clipped pixels at their native size, with no repeat (parity D26). It clips the effects overlays too.
- **TEXT:** a `div` with `textContent` (never `innerHTML`), `white-space:nowrap`, and ellipsis when the text is too long (spec §6.10). Font size is `round(pt·4/3)` px, default 10 pt, so 13 px. The font face is `fontFace` sanitised to `[A-Za-z0-9 ,-]`, followed by the host fallback `Tahoma, Verdana, sans-serif` (parity D22), with `-webkit-font-smoothing:none` unless `fontSmoothing=true`. Underline and bold come from `fontStyle`. Scrolling marquees come in wave 5.
- **Hit-testing:** all engine nodes are `pointer-events:none` except host widget containers (the playlist). One set of pointer listeners on the surface root feeds `InputRouter`, which calls `pick(x, y)` in skin px. The picker walks the scene **top-down in paint order** with these rules (spec §2.7, parity D10):

| Situation | Result |
|---|---|
| `visible=false` | skip the subtree |
| `passThrough=true` | skip the element's own pixels. On a SUBVIEW, its children are still tested (U-7). |
| pixel clipped (`clippingColor` / `clippingImage`, or outside the parent's clip box) | not hit, keep walking down |
| `transparencyColor` pixel (or PNG alpha 0) on a BUTTON, BUTTONGROUP or SLIDER thumb | **hit** (BUTTON receives clicks on transparency, spec §5.5) |
| `transparencyColor` pixel on a VIEW or SUBVIEW background | not hit, falls through (Headspace's magenta face window reaches the screen and effects, parity B5) |
| BUTTONGROUP pixel not owned by any `mappingColor` | not hit, whatever `showBackground` says (spec §2.7) |
| BUTTON with no image but with `width`/`height` | rectangular hit |
| `enabled=false` | claims the pixel as `inert`: blocks events and does not drag |
| EFFECTS | role `effects`, so the host click action runs (D25: next preset) |
| PLAYLIST and other host widgets | role `widget`: native DOM events inside the widget container |
| any other painted, unclipped pixel (backgrounds, images, panels, text with no handler) | role `drag`, so `SkinWindow.startDrag()` (U-11; parity D29 records this as an intended deviation) |

- **Window mask = (painted alpha > 0 and not clipped) ∪ (claimed by any role).** `hit/coverage.ts` computes it from the model and the decoded images, so DOM layout is never read back (this removes parity §3.6's DOM-walk dependency). It is recomputed when the model's dirty set touches geometry, visibility, image or alpha, at most once per frame and at most 30 times a second during animations, plus one exact update when animations settle. That replaces notan Q1(c)'s MutationObserver: the engine owns the model, so it knows exactly when the shape changes.

Rejected: a full canvas compositor (text parity risk; the playlist and effects would need overlays anyway; demo and query measurement would lose their DOM boxes). DOM hit-testing via `elementFromPoint` (it cannot express clipped vs transparent pixels or buttongroup map ownership).

### D3. Image pipeline

**Position: deterministic JS decoders in a worker, with keying applied per declaration at use time.**

- **Sniff by magic bytes, never by extension** (survey §3.3: `Nautical vol_slider.bmp` is a GIF, and `drawer.bmp` is a JPEG).
- **BMP (`img/bmp.ts`, our own code):** BITMAPINFOHEADER and its V4/V5 extensions, plus OS/2 12-byte headers (cheap to add). Bit depths 1/4/8/16/24/32; BI_RGB, BI_RLE4 and BI_RLE8 (with delta, end-of-line and absolute runs), BI_BITFIELDS for 16 and 32 bits. Bottom-up and top-down rows, 4-byte-aligned stride, palettes shorter than 2^bpp. **Alpha is forced to 255** for every BMP (wsz §3.1: 28 of 29 32-bit bitmaps have alpha 0 everywhere; WMP and Winamp ignore it). 16-bit BI_RGB is 5-5-5 per the spec. The known ImageIO-vs-PIL disagreement on `Weird_Amp_2 text.bmp` (wsz §3.1) is recorded as an expected cross-check mismatch. The corpus needs RLE8 in 15 WMP skins (survey §3.3) and in 12% of Winamp bitmaps, including base-2.91 itself (wsz §1.3).
- **PNG: `fast-png`** (MIT). It is expected to decode colour types 0/2/3/4/6, `tRNS`, and 16-bit samples (scaled down). **This is not yet verified:** W1.2 has a vitest case per colour type, `tRNS` included. Fallback: UPNG.js. It is pure JS, so the pixels are the same in Chrome and WKWebView. Browser PNG decoding is rejected because gAMA/iCCP colour management can move `#FF00FF` off its key.
- **GIF: `omggif`** (MIT, about 25 KB). It gives the first frame now and the full frame list with delays for later (animated GIFs: 86 skins, survey §3.3; animation lands with R5 in phase 3).
- **JPEG:** decoded through an injected decoder. In the browser that is `createImageBitmap(blob, {colorSpaceConversion:'none', premultiplyAlpha:'none'})` → `OffscreenCanvas.getImageData`; in node tests it is `jpeg-js` (dev dependency). JPEG keys are unreliable by nature (the docs discourage them), and JPEG is the one format where the harness and the app may differ. That is accepted.
- **Keying (`img/key.ts`)** happens when an element asks for an image under a `KeySpec {transparency, clipping}`, and the result is cached per `(name, keyspec)`. A `transparencyColor` pixel gets alpha 0 and the per-pixel flag `keyed`. A `clippingColor` pixel gets alpha 0 and `clipped`. `Auto` means the colour of pixel (0,0). `none` or no declaration means no key (parity rule 5: SLIDER has no default `transparencyColor`; `_map` images are never keyed). If a PNG has real alpha *and* a key is declared, both apply (U-27; survey §3.3 counts 58 such skins).
- **Hue shift and saturation** on 8-bit BMPs (WMP 9+) are left to phase 3. The decoder keeps the palette indices so they can be added later.
- **Where decoding runs:** `img/pool.ts` starts one module Worker (`new URL('./worker.ts', import.meta.url)`) and transfers the bytes in and the RGBA out. In node and vitest it runs inline. Decoding is lazy and cached per skin session. Literal image references are preloaded before the first paint. A script-assigned image (`bEqHandle.image = "…"`) keeps showing the old pixels until the new ones are ready, and `session.idle()` waits for pending decodes, so the harness never captures a half-loaded state (parity I6).
- **Limits:** a decoded image may be at most 8192 px on either side and 32 MP; a session may hold at most 256 MP of decoded pixels in total. Anything beyond that renders as an empty image and logs a diagnostic (survey §3.3: the largest image in the corpus is 2528×3300 and unreferenced).

### D4. Skin loading and untrusted input

**Position: an in-memory archive in engine JS, never extracted. Rust only imports and serves bytes.**

- **Zip (`pkg/zip.ts`):** our own central-directory reader with `fflate`'s `inflateSync` (MIT) for deflate and stored entries. Local-header signatures are **not required**: every offset comes from the central directory, and the local header is used only for name and extra-field lengths. That recovers the 3 distinct (6 raw) archives with a corrupt first header (survey §1.2) without patching bytes. Zip64, encryption and multi-disk archives are rejected with a diagnostic.
- **VFS (`pkg/vfs.ts`):** a flat map keyed by the **lowercased basename**. The directory part is dropped, `/` and `\` are both accepted, and for duplicates the last entry in the archive wins (wsz §1.2; survey G7). Entries under `RESOURCE.FRK/`, `__MACOSX/` or `._*` are skipped, and so are directory entries. Names can never escape, because the VFS has no directory semantics and nothing is ever written to disk.
- **Caps (`ArchiveLimits`):** archive ≤ 32 MiB (Rust checks before reading), ≤ 4,096 entries, each entry ≤ 32 MiB uncompressed, total ≤ 128 MiB uncompressed, per-entry compression ratio ≤ 200:1 for entries above 1 MiB. Uncompressed sizes are checked against the central directory **and** while inflating (the stream is truncated at the cap). Survey §1.1: the largest corpus zip is 2.9 MB with 303 entries, so the caps sit far above real data.
- **Choosing among several `.wms` (`pkg/select.ts`):** the one with the fewest unresolved file references wins; ties go to a name matching the zip stem, then to the larger size (survey §1.2; U-17). An implicit `<stem>.js` loads automatically (11 skins).
- **Identity:** a skin is identified by the sha256 of the archive bytes (`crypto.subtle.digest`). The hash keys the prefs namespace, the sidecar, the window-position keys and the golden manifest.
- **Rust (wave 4):** `skin_import(path) -> {hash, name, bytes_len}` checks size, hashes, and copies the file to `$APPDATA/skins/<sha256>.wmz` (or `.wsz`). `skin_list() -> [{hash, name, family_hint}]`. `skin_read(hash) -> tauri::ipc::Response` returns the raw bytes. Rust never parses the zip: one parser, the engine's, is tested by the harness and used by the app.
- **Caching:** none beyond the imported archive and per-session decode caches. Parse and decode are cheap enough (median `.wms` 28 KB, median zip 518 KB). This can be revisited when R9 (xsn_sports, 2.9 MB, 424 subviews) shows a measured need.

### D5. Parsing, layout and bindings

- **Text decoding (`wms/text.ts`):** a BOM means UTF-16LE or UTF-8; otherwise pure ASCII; otherwise cp1252 (survey §2.1: 72/10/27/86 distinct, with zero UTF-8-without-BOM files). The same rule applies to `.js`.
- **Scanner (`wms/scan.ts`):** a hand-written tokenizer over tags and `name = "v"` / `'v'` pairs, with any whitespace around `=` and missing whitespace between attributes allowed. Tag and attribute names are folded to lowercase, and the tree is built with a stack. A close tag pops to the nearest case-insensitive match. Parsing stops at the first close of the root, ignoring anything after it (G5). The five XML entities and numeric references are decoded in values. Comments and unknown tags are kept as `unknown` nodes so they can be diagnosed. These are exactly the L4 rules of survey §2.3, which take the corpus to 195 of 195.
- **Duplicate attributes: the last one wins**, case variants included, with one diagnostic each (U-5; survey §2.2: in 299 sampled conflicts the second value reads as the author's intent).
- **Value classification (`wms/values.ts`):**
  - `jscript:` (keyword case-insensitive, leading whitespace allowed) is an expression.
  - `wmpprop:` is a binding path.
  - `wmpenabled:` and `wmpdisabled:` are bindings on a controls method name: the last path segment, without `()` or `;`, lowercased (U-4).
  - `res://` resolves through `om/resources.ts` (wmploc §5).
  - Any other text is a literal.
  - Unknown prefixes (`wmppprop:`, `wmpenable:`) are literals plus a diagnostic (G14).
  - Handler attributes (`on*`, `*_onchange`, and PLAYER's bare event names) are never classified; they are script.
- **Two-pass layout (`model/layout.ts`):**
  1. Every element is created in document order with its literal attributes. Width and height come from the image size where the attribute is absent (spec §5.1). A VIEW without a size takes its `backgroundImage` size (G21a).
  2. `jscript:` attributes are evaluated **once, in document order**. An attribute that has not been evaluated yet reads as its type default (U-3).
  3. Bindings are installed and settled.
  4. Alignment anchors (`horizontalAlignment`/`verticalAlignment`) are recorded relative to the parent's size **after** step 2.

  **There is no re-evaluation of `jscript:` values.** A parent resize (from `view.width` writes or `view.size`) moves and stretches children through their anchors. Evidence: spec §3.2. `left="jscript:view.width-N"` is paired with `horizontalAlignment="right"` in 2,773 of 2,791 cases. A live expression would make the alignment redundant, so the expression is the initial value and the alignment carries the live behaviour. Survey G13 ("must re-evaluate when a dependency changes") is an inference without a counter-example; the primary-source-style signal wins. If R6 (Blinx, alignment layout) shows a break, the escape hatch is a per-attribute `reevaluate` flag, and nothing has to be rewritten.
- **Bindings (`model/bindings.ts`)** are evaluated **host-side**, never in the realm:
  - A path is parsed into a root (a host global or an element id) plus segments, with an optional final call whose arguments are constant literals (`player.settings.getMode('loop')`, spec §3.3).
  - Each binding subscribes to `PropertyBus` keys for every segment, so element attributes and host properties both notify. When a key fires, the path is re-read and `element.set(attr, v, 'binding')` is applied.
  - **Re-entrancy guard:** `set` returns `false` and fires nothing when the coerced value is unchanged. A `_onchange` handler that writes the same value back to the player is therefore a no-op on the host side (spec §2.3; the volume and balance feedback loop of spec §6.7).
  - **Don't fight the drag:** a binding never writes to an element whose controller is dragging (parity D18). The binding resumes on `onDragEnd` and re-reads the value.
  - `currentPosition` and its derived paths are re-read on every host frame while the state is `play`. A `_onchange` that comes from the binding is coalesced to ≤ 10 Hz per element (U-19).
  - `wmpenabled:<method>` reads `controls.isAvailable(method)` and re-evaluates on `status`, `song` and `queue` events. `wmpdisabled:` is its negation.
- **Stacking (`model/order.ts`), Reading C (parity rule 4, spec §5.3, U-2):** each SUBVIEW, and the VIEW, is a stacking context. Its children (controls and nested subviews alike) are sorted by `(zIndex, docIndex)`, and its own background takes the slot `(0, −1)`, so children with z < 0 paint under it. A nested subview's z is relative to its parent context. A BUTTONELEMENT uses its group's z. **Equal z means document order, later on top** (U-1). The docs-vs-Headspace conflict is settled by parity rule 4's arithmetic: only Reading C reproduces state 1. That is the default, with `stacking:'flat'` behind an engine option for experiments. Runtime `zIndex` writes re-sort the parent only.
- **Events (`model/dispatch.ts`):**
  - Gesture order is `onmousedown`, then `onmouseup`, then `onclick`, and `onclick` fires only if press and release land on the same element (U-18). There is no bubbling to SUBVIEW handlers, except that a SUBVIEW `onclick` receives clicks on pixels it claims itself.
  - `_onchange` fires for every origin except `init`.
  - Slider `onPositionChange` fires only for user origin (spec §6.7).
  - `onEndMove` fires when an animation completes, including a reversed one. A cancelled move does not fire its end event; its replacement does.
  - `slideTo` and `moveSizeTo` also fire `onEndMove` (U-25).

### D6. Object model

- **Shape (`om/`):** each host class (`player`, `controls`, `settings`, `currentMedia`, `network`, `currentPlaylist`, `theme`, `view`, `event`, `mediacenter`, plus the element classes and the `equalizerSettings`, `videoSettings`, `effects`, `playlist` and `video` objects) is a **member table** `Map<lowercaseName, Member>`. A member is either `{kind:'prop', get, set?, bus?}` or `{kind:'method', call}`. The membrane resolves members by lowercased name (G19). Values cross as copies; sub-objects (`player.controls`) cross as handles.
- **Enums:** the constants from `RT_TEXT #132` (`os*` 0..20, `ps*` 0..11, `WMPPlaylistChangeEventTypes`) are installed as realm globals **before any script loads**, whether or not the skin lists `#132`. This is a deliberate leniency: `Kids` and `UPRISING` use them without loading it (wmploc §3.2). The `#169` `sprintf` shim is installed when it is listed, and so is `#134`/`#136` (cheap). Other `res://` script entries produce a warning and are skipped (wmploc §2.3). The 47 `RT_STRING` ids come from wmploc §5.3 and are resolved at attribute parse, on script assignment and in `theme.loadString`. `RT_IMAGE` and `RT_BITMAP` resolve to transparent images of the listed size.
- **Mapping onto MPD** (`MediaPort` wraps `player.js`; `DspPort` wraps Rust `set_eq`/`set_balance`):

| WMP member | MPD / host |
|---|---|
| `player.playState` | `stop`→1 `psStopped`, `pause`→2, `play`→3; disconnected→0 |
| `player.openState` | current song→13 `osMediaOpen`; connected with empty queue→6 `osPlaylistOpenNoMedia`; disconnected→0 |
| `player.status` | "Playing", "Paused", "Stopped", "Connecting…" (U-32, invented) |
| `controls.play/pause/stop/next/previous` | `play` or `pause 0` / `pause 1` / `stop` / `next` / `previous` (`player.js:107-116`) |
| `controls.currentPosition` (r/w) | extrapolated elapsed (`player.js:92-97`) / `seekcur` |
| `controls.currentPositionString`, `currentMedia.durationString` | `MM:SS`, with `H:MM:SS` from one hour up (spec §7.2) |
| `controls.isAvailable(m)` | phase 1 = the oracle's table (parity D16): `stop` iff not stopped, `pause` iff playing, `play`/`next`/`previous` always. `fastForward`/`fastReverse`: false. Revisited at R1 (parity open question 5). |
| `settings.volume` (r/w) | `setvol`. Reads −1 when there is no mixer, and writes are ignored then. |
| `settings.mute` | host-local: mute stores the volume and sets 0; unmute restores it; writing the current value is a no-op |
| `settings.balance` | `DspPort.balance` (Rust `set_balance`, host detent ±5, parity D17) |
| `settings.getMode/setMode('shuffle'/'loop')` | `random` / `repeat` |
| `currentMedia.duration/name/sourceURL` | duration / `songTitle(song)` / `file` |
| `currentMedia.getItemInfo(k)` | `Author`/`Artist`→Artist, `Title`, `Album`/`WM/AlbumTitle`, `Genre`, `WM/TrackNumber`→Track, `Bitrate`→status bitrate, else `""` |
| `currentMedia.imageSourceWidth/Height` | 0 (no video, parity D19) |
| `network.downloadProgress` | 100 (parity D2) |
| `eq.gainLevel1..10`, `eq.reset()`, `eq.bypass` | `DspPort.eq` (dB, clamped ±14 by `eq.rs:75` in phase 1) |
| `mediacenter.effectType/effectPreset` | host prefs namespace `mediacenter`. `effectPreset` defaults to the legacy `localStorage.preset` value for continuity (parity §3.4). |
| `effects.*` (`currentPreset`, `currentPresetTitle`, `next()`, `previous()`, `visible`) | `EffectsInstance` (host viz) |
| `playlist.setColumnResizeMode`, `.visible` | accepted and ignored / host widget visibility |
| `theme.savePreference/loadPreference` | `PrefPort` namespace `skin:<sha256>`. Values go through `String()`. **An unset key returns `"--"`.** |
| `theme.openView/closeView/currentViewID/openViewRelative` | stubs that log to the ledger until W6, then `WindowPort` |
| `view.minimize/close`, `view.width/height` | `SkinWindow` ops / resize policy (D7) |
| `view.returnToMediaCenter()` | `HostActions.returnToMediaCenter` (default: zoom toggle, parity D3) |
| `player.launchURL`, `theme.openDialog`, `theme.playSound` | phase 1: logged and rejected (`""` from `openDialog`) |

- **Conflict resolved, `loadPreference` for an unset key:** spec §7.3 / U-16 recommends `""`, and survey G20 measures that **83 of 94** preference-using skins test against the literal `"--"`. A real-world contract that most skins check outweighs a guess with no evidence, so the answer is `"--"`.
- **Element objects:** every element exposes its typed attributes (coerced on write per spec §2.4 and U-20; an invalid write keeps the previous value), the ambient methods `moveTo`, `slideTo`, `moveSizeTo` and `alphaBlendTo`, and the kind-specific members (`buttongroup.getButton/click`, `effects.next`, and so on). Image attributes are lazy (`.image = "x.bmp"` resolves case-insensitively and keeps the declared `KeySpec`).
- **Stubs and the coverage ledger (`om/ledger.ts`):** members marked `status:'stub'` return type-correct inert values (`0`, `""`, `false`, a no-op). On first use per (skin hash, api) they report to `diag.ledger`. Member access the tables do not know about returns `undefined` (as IDispatch would raise; we choose a quiet `undefined` plus a `missing` ledger entry). The skinlab run writes `out/coverage/<skin>.json`, and wave 5 adds the static corpus scanner CSV (`docs/coverage/api-rank.csv`, notan Q3) to rank what to implement next. Coverage is measured, never asserted.

### D7. Windows

- **The abstraction (`SkinWindow`, §3.1)** has a stable key `<skinHash>/<viewKey>`, a role (`main` or `aux`), a binding (`native` or `internal`), a `Surface` (a DOM root in skin px), and the operations `setSize`, `startDrag`, `minimize`, `close`, `setHitShape`, `setCapture` and `onClosed`, plus `zoom`. The engine never talks to Tauri. The skin's VIEW lifecycle maps onto these calls.
- **Phase-1 binding: one native WebviewWindow per VIEW (notan Q1).** Survey §1.1 counts 52% of skins with more than one view and up to 9. WMP's views are separate top-level windows with their own scopes (spec §2.1.7). A webview per view gives that scope separation for free, gives each view its own Keep-on-Top, and drags natively. **Each webview runs its own `SkinSession` for its own VIEW**, so cross-view coupling is only what WMP allows: preferences (localStorage is shared by every webview of the origin, and `storage` events carry changes across), the shared player (every webview receives the `mpd-idle` events), and `theme.openView/closeView` (a request to the host, which creates or closes the window).
- **Delivery order:** wave 4 adopts the existing `main` window (Headspace has one VIEW). Wave 6 adds `WebviewWindowBuilder` windows labelled `view-<n>` that load `index.html?skin=<hash>&view=<viewKey>`. They reuse the proven flag block from `tauri.conf.json:18-25` (transparent, undecorated, no shadow, `acceptFirstMouse`), start hidden, are sized from the VIEW, and are then shown. Capabilities to add in W6: `core:webview:allow-create-webview-window`, `core:window:allow-set-position`, `core:window:allow-show`, `core:window:allow-hide`, and widening the capability's `windows` list to `["main", "view-*"]`.
- **Per-window hit state (wave 1, Rust):** `HitState` becomes `windows: Mutex<HashMap<String, WinHit{mask: Option<Mask>, ignoring: Option<bool>}>>` and `capture: Mutex<Option<String>>` (the label of the capturing window). Commands take the caller's `WebviewWindow` as a parameter, so **the JS signatures do not change** and the legacy port keeps working. The poll loop iterates over all webview windows. While a window holds the capture, only that window is forced clickable; every other window follows its own mask. This fixes the global-`AtomicBool` bug of notan Q1(a). The binary mask arrives on the new `set_hit_mask_raw` (raw `Uint8Array` body with headers `x-width`, `x-height`, `x-zoom`; verified against Tauri 2.11: `InvokeArgs` accepts `Uint8Array` and `InvokeOptions.headers`, and Rust `ipc::Request::body()` returns `InvokeBody::Raw`). That replaces the 37,430-number JSON array of parity D11. The legacy `set_hit_mask` stays until the port is deleted. When two skin windows overlap, the poll interval drops from 16 ms to 8 ms (W6); an NSEvent monitor is considered only if misroutes reproduce (notan Q1).
- **`view.width/height` writes:** a resize policy per session. The default from wave 5 is `honor`: the native window is resized with its top-left anchored, `applyResize` runs on the alignment anchors, and the mask follows. The Headspace sidecar pins `ignore`, which keeps 760×394 (parity D13, the owner's recorded decision), so its four parity states stay comparable.
- **`startDrag`:** `getCurrentWindow().startDragging()` on a real `pointerdown` over a `drag`-role pixel. Synthetic events (from the demo) never start a native drag.
- **Persistence:** window position per `SkinWindow.key`, saved on move-end and stored in host prefs. On restore the main window comes first, and auxiliary windows are clamped to the work area of a connected monitor (notan Q1(e); W6). The `main` window keeps `center: true` until W6.
- **Room for phase 2:** `binding:'internal'` means a SkinHost that composites several logical windows (Webamp's main, EQ and playlist) inside **one** native window sized to the cluster or the screen, with `HitShape.kind:'regions'` (rectangles and polygons, webamp §2). The phase-1 WindowPort accepts the field and rejects `internal` until phase 2. Snap, dock and group are an explicit phase-2 extension to the contract (notan Q1). Phase 1 freezes only what WMP uses: open, close, size, drag, mask, capture and persist key.

### D8. Engine and host boundary

- **The package:** `src/engine/` is TypeScript (strict, `tsc --noEmit`), compiled by Vite like the rest of the app. It may import only from itself and from the allow-listed vendored libraries (`quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync`, `fflate`, `fast-png`, `omggif`).
- **The boundary rule:** `tools/check-engine-imports.mjs` fails the run if any file under `src/engine/` imports `@tauri-apps/*`, `src/host/**`, `src/app/**`, `src/main.js`, `src/widgets.js`, `src/player.js` or `src/viz/**`, or mentions `__TAURI`. `npm run check` = `typecheck + lint:engine + test`. A git pre-commit hook may be installed, but the gate is that Opus runs `npm run check` at every verification gate.
- **`HostAdapter` (§3.1)** has members `clock`, `windows`, `prefs`, `media`, `dsp`, `audio`, `effects`, `widgets`, `actions`, `palette` and `diag`.
- **The second adapter comes first:** `skinlab/host/harness-host.ts` (wave 2) has a manual clock, a fixture `MediaPort` with the canned states of parity §4.1, in-memory prefs, a recording `WindowPort` (every `setHitShape` is kept), a stub `EffectsProvider` that paints solid `#000000`, the real playlist widget fed by the fixture media, and a diag that collects into arrays. The Tauri adapter (`src/host/tauri/`) is built in wave 4, **after** the engine has passed the harness. That proves the seam rather than leaving it a hope (notan Q3(2)).

### D9. Oracle and tests

**skinlab** (`skinlab/`, Node ESM):

- **Browser:** `playwright-core` (no browser download) launches the installed **Google Chrome** (`channel:'chrome'`; `/Applications/Google Chrome.app` exists, node v26.8.1). Launch flags: `--force-device-scale-factor` per run, `--font-render-hinting=none`, `--disable-lcd-text`. Viewport 760×394 plus margin. The Chrome version and the OS build are written into every golden's provenance, and `verify` refuses to compare across a major-version change unless `--allow-chrome-drift` is given (reported, never silent).
- **Serving:** the harness starts Vite with `skinlab/vite.config.mjs`. Aliases map `@tauri-apps/api/*` to `skinlab/stubs/tauri/*.js` (the fixture of parity §4.1: canned `mpd` replies per state, recorded `set_*` calls, `palette` rejects, `engine_info` ok) and `/src/viz/index.js` to `skinlab/stubs/viz.js` (a `Viz` with the same API that fills its canvas with `#000`; titles and stepping are kept, so the preset title text is real). That makes the visualizer deterministic, and the effects hole is excluded from the diff anyway.
- **Fixture identity:** `SKINLAB_FIXTURES` defaults to `~/Downloads`. The harness **refuses** any `Headspace.wmz` whose sha1 is not `f9671f06…` (survey §0.9: the corpus copy is the 2000 revision and differs). It (re)generates `public/skin/` with `tools/convert_skin.py` when the stamp file is missing or stale.
- **Legacy capture with zero edits to `main.js`:**
  - States are reached by real Playwright mouse clicks in skin coordinates. State 2: the EQ handle at (224,185). State 3: the PL handle at (532,184). State 4: the vis element at (309+131, 31+13) = (440,44).
  - All states: `localStorage` is cleared and then seeded with `preset=1` (Chorus) and `eq` all zero.
  - The harness waits for `transitionend` plus 200 ms, then moves the pointer to (755, 390) (transparent, so no hover) and captures.
  - **The legacy capture runs on real time, not a frozen clock** (CSS transitions, `transitionend`, timers). The frozen clock is engine-side only. Determinism of the oracle is therefore *checked*, not built in: W0.2 acceptance 1 blesses twice and requires identical hashes.
  - Fallback, if a click proves flaky in the legacy port: seed `eqOpen`/`plOpen` so the boot replays the toggles (`main:582-583`). The engine side always uses clicks.
- **Engine capture:** the same click scripts (`skinlab/states.json`, written as skin-coordinate input steps) are replayed against `skinlab/pages/engine.html`, which mounts a `SkinSession` on the `HarnessHost`. Clicks and pointer moves are identical for the oracle and the engine. The manual clock advances 500 ms in 16 ms steps, then `await session.idle()`. Driving both sides with the same input is the symmetry that makes the diff meaningful.
- **Artifacts per (state, DPR):** a PNG of the surface region (`omitBackground:true`, RGBA), the recorded `HitShape` (engine) or `set_hit_mask` call (legacy), and a paint-order dump.
- **Diff:** exact RGBA equality outside the **exclusion** (the effects hole: the magenta pixels of `head.bmp` offset by (261,0), 31,487 px, computed at run time from the fixture) and outside the **allow-list** regions. Masks are compared bit for bit, again outside allow-listed regions. The output is a count, a bounding box and a diff PNG under `/tmp/skinlab/<run>/`, plus `report.json` and `report.md`.
- **Allow-list (`skinlab/allowlist.json`)**, entries `{id, states, kind:'computed'|'rect', region, reason, ref}`. **skinlab computes computed regions itself from the fixture at run time, using the engine's own `decodeBmp`.** U-23's region is the pixels of `play_controls_map.bmp` (and `minimize_close_map.bmp`) that match no `mappingColor` key, offset to the group's position. D11's region is the white pixels of `vid_bkgd.bmp` inside the 216×158 screen, offset to (270,59). No art-derived data is committed, and the engine needs no debug API. Initial entries:

| id | kind | region | ref |
|---|---|---|---|
| `U-23-showBackground` | computed | unowned pixels of the `transport` and minimize/close buttongroups (811 + 1 px differ; spec §6.5) | only while the engine default is `false`; removed if the owner picks the sidecar override |
| `D20-reset-y` | rect | (222,221)-(258,238), state 2 | parity D20 (y 127 per `.wms`) |
| `D21-preset-title` | rect | (321,65)-(426,82), state 4 | parity D21 (13 px per default 10 pt) |
| `D11-mask-corners` | computed, mask only | the 106 clipped corner pixels of the screen | parity D11 / §4.1 |
| `D1-freq-labels` | none | the sidecar overlay must match exactly | parity D1 |
| `U-10-slider-travel` | **empty** | the engine follows the oracle formula, so no deviation. The entry exists so that switching to `sliderTravel:'docs'` comes with its region. | parity D32 |

- **Goldens are content-addressed and live outside git:** `~/Library/Caches/window_headmpd/skinlab/<sha256>.png` and `.mask`. Git holds `skinlab/goldens.lock.json`, with one entry per (fixture, state, DPR): `png_sha256`, `mask_sha256`, `popcount`, `bbox`, `chrome`, `os`, `oracle_pins` (the sha1 prefixes of parity §Conventions), `wmz_sha1` and `created`.
  - `npm run skinlab -- bless --from legacy` creates them. It is an explicit command, run by Opus or the owner, and it refuses to overwrite without `--rebless`.
  - **Regeneration after the legacy port is deleted:** wave 4 tags `oracle/headspace-v1` at the pinned commit, and `bless --from tag:oracle/headspace-v1` checks the tag out into a temporary git worktree and captures from there. A regenerated golden must hash-equal the manifest, or the run fails.
  - The mask popcounts of parity §4.1 (89,328 / 122,636 / 123,258 / 89,328) come from an emulation. W0.2 regenerates them from the live oracle and records any difference for Opus. The live oracle wins (parity open question 9).
- **How a Sonnet implementer runs it:** `npm run skinlab -- verify --state all` (engine against goldens, exit code 1 on failure), `npm run skinlab -- verify --state 2 --dpr 2`, `npm run skinlab -- show --state 3` (headed, with devtools, for debugging), and `npm run skinlab -- supplemental`. If goldens are missing on a fresh machine, the error message prints the exact bless command.
- **WebKit gap:** Chrome is the harness browser, while the app runs WKWebView. Parity holds because both captures happen in the same Chrome, but bugs specific to WKWebView in the engine are not covered. Mitigation: `npm run skinlab -- verify --browser webkit` (Playwright's WebKit build, opt-in download) as a **report-only** pass at the W3 and W4 gates, plus an in-app smoke checklist at W4.
- **Unit tests (vitest, node):** `src/engine/**/*.test.ts` covers the zip reader, decoders, scanner, values, model, order, layout, bindings, animator, realm (QuickJS runs in node), picker and coverage, all on synthetic fixtures built inside the tests, so no art is involved.
- **Corpus suites** (`npm run corpus -- <suite>`; they need `skins/`, so they are not part of `npm test`): `zip`, `images`, `parse`, `scripts`, `layout`, `ladder`. Each prints the counts its acceptance criterion quotes, and those counts are committed as `docs/coverage/corpus-<suite>.txt` (numbers only).

### D10. App features around any skin

- **Boot and coexistence (wave 0):** `index.html` loads `src/boot.js`, which imports `src/app/main-engine.js` when `?engine=wmp` or `localStorage['boot.engine']==='wmp'`, and otherwise imports the untouched `src/main.js`. The legacy port stays the default until cutover (§7).
- **The app shell (`src/app/`, wave 4)** works around any `SkinSession`:
  - **Window menu:** right-click, Control-click or Option-click opens Keep on Top, Show on All Desktops and Larger/Normal Size (`main:484-535`). In wave 5 it gains Skins ▸ (a list and Import…). Option-click is captured before everything else. Right-click always opens the host menu; skin popup menus on right-click are phase 3.
  - **Zoom:** a CSS transform on each surface root, the native window size times zoom, and the hit-shape zoom. The effects renderer pixel ratio is reset on zoom (parity §3.2).
  - **Keyboard:** the host defaults (Space, ←/→ ±5 s, ↑/↓ volume ±5, V for next preset) apply only when the VIEW and the focused element have no key handler, and **never when Cmd or Ctrl is held**. ↑/↓ do nothing when the volume is −1 (fixes parity D9).
  - **Overlays:** `src/app/effects.js` implements `EffectsProvider`. It mounts the `Viz` canvas plus the now-playing toast, notice and caption DOM (same ids and CSS as now) **inside the EFFECTS container**, so they inherit the screen subview's clip (parity D4-D6, D26). A skin without EFFECTS gets no overlays in phase 1.
  - **Palette:** `src/app/palette.js` is the `PaletteService` facade. In phase 1 it is the `local` tier only: the Rust `palette` k-means feeds `viz.setPalette`, with the stale-result guard from `main:439-446`.
- **Sidecars (`src/sidecars/<sha256>.json`, committed; they hold no art):** per-skin compat data that never lives in the engine's semantics (parity rule 1). The Headspace sidecar holds:
  - `overlays`: the D1 frequency labels as declarative TEXT elements (x = 9 + 15·i, y = 121, 7 px, `#77ce07`, centred, width 15) inside `sEqView`;
  - `seekForegroundFollowsThumb: true` (parity D2);
  - `viewResize: 'ignore'` (D13);
  - optionally `showBackground: true` (U-23), if the owner wants the oracle look.

  The overlay schema is the engine's own element schema, so overlays go through the same renderer.
- **Demo tour (wave 4):** `src/app/demo-bridge.js` builds `ctx` for `runDemo`. `ui.transport`, `ui.plHandle`, `ui.eqHandle`, `ui.visNext` and `ui.reset` are `session.query()` handles exposing `getBoundingClientRect()`. Id-less elements are reached by query (`{tag:'button', within:'visDrop', ordinal:1}`, `{tag:'text', attr:{value:'reset'}}`). `ui.bands[i]` = `{node: handle, get value()}`. `toggleEq/Pl/Vis` call the skin's own functions through `realm.callGlobal('ToggleEqView')`, and `isOpen.*` reads `realm.getGlobal('eqIsOpen')`. The bridge is Headspace-specific, which is fine: the demo is a promo for this skin. `demo.js` changes only its `el` import. Its synthetic `PointerEvent`s still go to `document.elementFromPoint`, which is now the surface root, and the router consumes them (it does not use `setPointerCapture`, so synthetic ids cannot throw). The engine never uses CSS `z-index`, so the cursor (1000) and the flash (2000) stay on top, and the `body.demo` cursor rule is kept in the app CSS.
- **Cutover criteria:** §7.
- **CSP (wave 4):** `tauri.conf.json` gets `"csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost"`. This is defence in depth: skin code never touches the DOM, but the engine writes skin strings into it.

### D11. Audio-side changes

- **Phase 1 (W1.5):** fan-out only.
  - `Engine.subscriber` becomes `subscribers: Mutex<Vec<(u32, Channel<Frame>)>>`.
  - `audio_subscribe(on_frame) -> u32` and `audio_unsubscribe(id)`.
  - A channel whose `send` fails is dropped.

  This stops a second `Viz` from stealing the feed (parity §3.2, `audio.rs:85-87`) and unblocks per-window EFFECTS in W6. The legacy call ignores the return value, so it is compatible.
- **WMP band centres need no change:** `eq.rs:7-9` already uses 31…16 k, which matches `equalizerSettings` (spec §6.16). The ±14 dB clamp stays in phase 1 (Headspace's sliders are −14..14). The WMP range of ±20 dB comes with phase 2's `eq_configure`.
- **Phase 2:**
  - `eq_configure({centres_hz: Vec<f32>, q: f32, max_gain_db: f32})` (Winamp: 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k, ±12 dB; webamp §1.6);
  - `set_preamp(db)`;
  - `set_eq_enabled(bool)` (bypass);
  - `audio_subscribe(on_frame, {pcm: bool})`, which adds `Frame.pcm: Option<Vec<u8>>` (1024 mono bytes centred on 128, per subscriber, only when requested; about 61 KB/s at 60 Hz, webamp §1.5).

  `set_eq(gains)` is kept as the WMP-family call.

### D12. Phase-2 seam

- **`SkinHostFactory` (§3.1):** `probe(pkg) → confidence` and `start(pkg, host, opts) → SkinSession`. Phase 1 registers `wmpHost`. Phase 2 registers `winamp2Host` (Webamp via `webamp/lazy`, dynamically imported only when a `.wsz` is chosen, webamp §3). Both consume the same `HostAdapter`, which means the **same `MediaPort`** (the Webamp media class plus the Redux adapter translate it, webamp §1.4), the same `DspPort` (with `eq_configure`), the same `PrefPort`, and the same `WindowPort` (with `binding:'internal'` and `HitShape.regions`). `SkinSession.query()` and `idle()` give skinlab one driver for both families. Phase 2's oracle is the Webamp museum screenshot, report-only (wsz §6.10).
- **PaletteService placement:** the interface and snapshot type are in `src/engine/host.ts`, because skins and adapters consume them. The implementation is in `src/app/palette/`.
  - Phase 1 defines `PaletteSnapshot` with notan's exact shape: `source`, `association`, `track`, `roles` (the nine v1 keys **copied verbatim from the notan-palette/1 contract when it is implemented, never renamed**), `guarantees` (always `[]` for local and default), `clusters`, and one blessed OKLCH lerp. Phase 1 ships only `source:'local'`/`'default'` around today's k-means.
  - **Phase 2 (P2-W3) builds the artifact consumer:** Rust watches the parent directory of `$XDG_CONFIG_HOME/rmpc-auto-theme/palette/palette.json` (honouring `MUSIC_UI_PALETTE_PATH`, where an invalid value disables the source with a diagnostic) and emits file bytes. TS lifts grisaille's session semantics (the retention triple, serialized reads with one dirty follow-up, reattach backoff 1/2/4/8/10 s). Repaints from the two sources are debounced to one per song change. The engine never publishes a palette artifact (notan Q2).
  - It lands in phase 2 because no WMP rung needs it and Webamp's viscolors do not either. It is fully independent, though, so a free Sonnet slot can pull it forward after W4.

## 3. Interfaces (frozen by W1.0 and W2.0)

All of these go verbatim into `src/engine/host.ts`, `src/engine/model/types.ts` and `src/engine/realm/types.ts` before the parallel tasks start. A Sonnet task may add private helpers but may change none of these without an Opus edit to this section.

### 3.1 Host boundary (`src/engine/host.ts`)

```ts
export type Unsubscribe = () => void;
export type RGB = number;                         // 0xRRGGBB
export interface Rect { x: number; y: number; w: number; h: number }

export interface HostAdapter {
  readonly clock: Clock;
  readonly windows: WindowPort;
  readonly prefs: PrefPort;
  readonly media: MediaPort;
  readonly dsp: DspPort;
  readonly audio: AudioPort;
  readonly effects: EffectsProvider;
  readonly widgets: WidgetProvider;
  readonly actions: HostActions;
  readonly palette: PaletteService;
  readonly diag: DiagSink;
}

export interface Clock {
  now(): number;                                          // ms, monotonic
  onFrame(cb: (now: number) => void): Unsubscribe;        // rAF in app; ManualClock.advance() in harness
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
}

// ---- windows ----
export type WindowBinding = 'native' | 'internal';        // 'internal' rejected until phase 2
export interface SkinWindowSpec {
  key: string;                                            // `${skinHash}/${viewKey}`
  title: string;
  role: 'main' | 'aux';
  binding: WindowBinding;
  size: { w: number; h: number };                         // skin px
  position?: 'restore' | 'center' | { x: number; y: number } | { relativeTo: string; dx: number; dy: number };
  url?: string;                                           // aux native windows: page to load (W6)
}
export interface WindowPort {
  open(spec: SkinWindowSpec): Promise<SkinWindow>;        // first 'main' adopts the existing window
  current(): SkinWindow;                                  // the window this session lives in
}
export interface Surface {
  readonly root: HTMLElement;                             // positioned, skin-px sized, host applies scale(zoom)
  setSize(w: number, h: number): void;
}
export interface SkinWindow {
  readonly key: string;
  readonly role: 'main' | 'aux';
  readonly surface: Surface;
  readonly zoom: number;
  onZoom(cb: (z: number) => void): Unsubscribe;
  setSize(w: number, h: number): void;                    // skin px
  startDrag(): void;
  minimize(): void;
  close(): void;
  setHitShape(shape: HitShape): void;
  setCapture(on: boolean): void;
  onClosed(cb: () => void): Unsubscribe;
}
export type HitShape =
  | { kind: 'bitmap'; width: number; height: number; bits: Uint8Array }   // row-major, LSB-first, 1 = skin
  | { kind: 'regions'; width: number; height: number; rects: Rect[]; polygons: Array<Array<[number, number]>> };

// ---- prefs ----
export interface PrefPort { open(ns: string): PrefNamespace }   // 'skin:<sha256>' | 'host' | 'mediacenter' | 'window'
export interface PrefNamespace {
  get(key: string): string | undefined;
  set(key: string, value: string): void;                  // caps: 512 keys, key ≤128 chars, value ≤8 KiB, ns ≤256 KiB
  remove(key: string): void;
  on(cb: (key: string) => void): Unsubscribe;             // includes changes from other windows
}

// ---- media (MPD) ----
export type PlayState = 'stop' | 'play' | 'pause';
export interface SongInfo {
  id: number; pos: number; file: string;
  title: string; artist: string; album: string; genre: string; track: string;
  duration: number;                                       // s
}
export interface MediaSnapshot {
  connected: boolean; state: PlayState; duration: number; volume: number;    // volume -1 = no mixer
  random: boolean; repeat: boolean; single: boolean;
  bitrate: number; audioFormat: { rate: number; bits: number; channels: number } | null;
  song: SongInfo | null; queueLength: number; queueVersion: number; error: string | null;
}
export type MediaEvent = 'status' | 'song' | 'queue' | 'playlists' | 'connection';
export interface MediaPort {
  snapshot(): MediaSnapshot;                              // synchronous, cached
  elapsed(): number;                                      // s, extrapolated while playing
  queue(): readonly SongInfo[];
  storedPlaylists(): readonly string[];
  on(ev: MediaEvent, cb: () => void): Unsubscribe;
  play(): Promise<void>; pause(): Promise<void>; stop(): Promise<void>;
  next(): Promise<void>; previous(): Promise<void>;
  seek(sec: number): Promise<void>; setVolume(v: number): Promise<void>;
  setRandom(on: boolean): Promise<void>; setRepeat(on: boolean): Promise<void>;
  playPos(pos: number): Promise<void>;
  playlistSongs(name: string): Promise<SongInfo[]>;
  playPlaylist(name: string, pos: number): Promise<void>;
}
export interface DspPort {
  readonly eq: {
    gains(): readonly number[];                           // dB, 10 bands
    setGain(band: number, db: number): void;              // band 0..9
    reset(): void;
    enabled(): boolean; setEnabled(on: boolean): void;
    on(cb: () => void): Unsubscribe;
  };
  readonly balance: { get(): number; set(v: number): void; on(cb: () => void): Unsubscribe };  // -100..100
}
export interface AudioFrame { bands: Float32Array; wave: Float32Array; level: number; pcm?: Uint8Array }
export interface AudioPort { subscribe(cb: (f: AudioFrame) => void, opts?: { pcm?: boolean }): Unsubscribe }

// ---- host-provided controls ----
export interface EffectsProvider {
  mount(container: HTMLElement, size: { w: number; h: number }, win: SkinWindow): EffectsInstance;
}
export interface EffectsInstance {
  readonly effectType: string;
  readonly presetCount: number;
  presetIndex(): number; setPresetIndex(i: number): void;
  presetTitle(i?: number): string;
  next(): void; previous(): void;
  setVisible(v: boolean): void;
  click(): void;                                          // host default action on an effects click (D25: next)
  onPresetChange(cb: (i: number) => void): Unsubscribe;
  dispose(): void;
}
export interface PlaylistAttrs {
  backgroundColor: RGB | null; foregroundColor: RGB | null; itemPlayingColor: RGB | null;
  columns: Array<{ id: string; title: string }>; columnsVisible: boolean;
  dropDownVisible: boolean; playlistItemsVisible: boolean;
}
export interface HostWidget { update(attrs: Partial<PlaylistAttrs>): void; setVisible(v: boolean): void; dispose(): void }
export interface WidgetProvider { playlist(container: HTMLElement, attrs: PlaylistAttrs, size: { w: number; h: number }): HostWidget }

export interface HostActions {
  returnToMediaCenter(win: SkinWindow): void;             // default: toggle zoom 1 ↔ 1.5
  openDialog(kind: string, filter: string): string;       // phase 1: ''
  launchURL(url: string): void;                           // phase 1: diag only
  openView(spec: SkinWindowSpec): Promise<void>;          // W6; before W6: diag + ledger
  closeView(key: string): void;
}

// ---- palette (phase 1: local tier only) ----
export interface PaletteCluster { hex: string; share: number; oklch: [number, number, number] }
export interface PaletteSnapshot {
  source: 'artifact' | 'local' | 'default';
  association: 'current-uri' | 'retained' | 'default';
  track: { uri: string; generatedAt: string } | null;
  roles: Readonly<Record<string, string>> | null;         // the nine notan-palette/1 keys verbatim; null for local/default
  guarantees: readonly unknown[];                         // verified_pairs verbatim; always [] for local/default
  clusters: readonly PaletteCluster[];
}
export interface PaletteService {
  current(): PaletteSnapshot;
  on(cb: (s: PaletteSnapshot) => void): Unsubscribe;
  lerp(a: string, b: string, t: number): string;          // the one blessed polar-OKLCH lerp
}

// ---- diagnostics ----
export interface SourceSite { file: string; line: number; attr?: string; elementId?: string }
export interface DiagSink {
  warn(code: string, detail: string, site?: SourceSite): void;       // host dedupes per (skin, code, site)
  ledger(api: string, status: 'impl' | 'stub' | 'missing', site?: SourceSite): void;
  fault(kind: 'syntax' | 'exception' | 'interrupt' | 'oom' | 'stack', message: string, site?: SourceSite): void;
}

// ---- skin hosts (D12) ----
export type SkinFamily = 'wmp' | 'winamp2' | 'native';
export interface SkinPackage {
  readonly hash: string;                                  // sha256 hex of archive bytes
  readonly name: string;
  read(name: string): Uint8Array | null;                  // case-insensitive basename, last-in-archive wins
  list(ext?: string): readonly string[];
  readonly diagnostics: readonly { code: string; detail: string }[];
}
export interface StartOptions { viewKey?: string; sidecar?: Sidecar; engineOptions?: EngineOptions }
export interface EngineOptions {
  stacking?: 'context' | 'flat';                          // default 'context' (Reading C)
  sliderTravel?: 'oracle' | 'docs';                       // default 'oracle' (parity D32)
  showBackground?: boolean;                               // default false (docs, U-23); sidecar may override
}
export interface SkinHostFactory {
  readonly family: SkinFamily;
  probe(pkg: SkinPackage): number;                        // 0..1
  start(pkg: SkinPackage, host: HostAdapter, opts: StartOptions): Promise<SkinSession>;
}
export interface ElementQuery { id?: string; tag?: string; within?: string; ordinal?: number; attr?: Record<string, string> }
export interface QueryHandle {
  getBoundingClientRect(): DOMRect;                       // client coords, zoom applied
  readonly node: { getBoundingClientRect(): DOMRect };    // demo.js compatibility (ui.bands[i].node)
  get(attr: string): unknown;
  readonly value: number | undefined;
}
export interface SkinSession {
  readonly family: SkinFamily;
  readonly window: SkinWindow;
  query(q: ElementQuery): QueryHandle | null;
  idle(): Promise<void>;                                  // decodes done, no animation running, dirty set flushed
  callGlobal(name: string, args?: unknown[]): unknown;    // tests + demo bridge; copy semantics
  getGlobal(name: string): unknown;
  on(ev: 'fault' | 'closed' | 'unloaded', cb: (detail?: unknown) => void): Unsubscribe;
  dispose(): Promise<void>;
}
export interface Sidecar {
  overlays?: unknown[];                                   // engine element schema, parsed by wms/schema
  seekForegroundFollowsThumb?: boolean;
  viewResize?: 'honor' | 'ignore';
  showBackground?: boolean;
}
```

### 3.2 Package and images

```ts
// src/engine/pkg/zip.ts
export interface ArchiveLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxRatio: number }
export const DEFAULT_LIMITS: ArchiveLimits;               // 4096, 32 MiB, 128 MiB, 200
export interface ZipEntry { name: string; method: 0 | 8; compressedSize: number; size: number; offset: number; crc32: number }
export function readCentralDirectory(bytes: Uint8Array, limits?: ArchiveLimits): { entries: ZipEntry[]; diagnostics: Diag[] };
export function extract(bytes: Uint8Array, e: ZipEntry, limits?: ArchiveLimits): Uint8Array;   // throws ArchiveError on cap/CRC
// src/engine/pkg/vfs.ts
export function openSkinArchive(bytes: Uint8Array, name: string, limits?: ArchiveLimits): Promise<SkinPackage>;
// src/engine/pkg/select.ts
export function selectWms(pkg: SkinPackage): { file: string; reason: 'only' | 'fewest-unresolved' | 'stem' | 'size'; unresolved: number } | null;

// src/engine/img/decode.ts
export interface DecodedImage { width: number; height: number; rgba: Uint8ClampedArray; format: 'bmp' | 'png' | 'gif' | 'jpeg'; frames?: { rgba: Uint8ClampedArray; delayMs: number }[] }
export function sniff(bytes: Uint8Array): 'bmp' | 'png' | 'gif' | 'jpeg' | 'unknown';
export function decodeBmp(bytes: Uint8Array): DecodedImage;
export function decodeImage(bytes: Uint8Array, jpeg: (b: Uint8Array) => Promise<DecodedImage>): Promise<DecodedImage>;
// src/engine/img/key.ts
export interface KeySpec { transparency?: RGB | 'auto' | null; clipping?: RGB | 'auto' | null }
export interface KeyedImage {
  readonly name: string; readonly width: number; readonly height: number;
  readonly rgba: Uint8ClampedArray;                       // keyed and clipped pixels have alpha 0
  readonly flags: Uint8Array;                             // per pixel: 1 = keyed (transparency), 2 = clipped
}
export function applyKey(img: DecodedImage, name: string, key: KeySpec): KeyedImage;
// src/engine/img/store.ts
export class ImageStore {
  constructor(pkg: SkinPackage, diag: DiagSink);
  preload(refs: Array<{ name: string; key: KeySpec }>): Promise<void>;
  get(name: string, key: KeySpec): KeyedImage | null;     // sync; null until decoded or if missing
  load(name: string, key: KeySpec): Promise<KeyedImage | null>;
  pending(): number;
}
```

### 3.3 Parsing (`src/engine/wms/`)

```ts
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf16le' | 'utf8' | 'cp1252' | 'ascii' };
export interface RawAttr { name: string; value: string; line: number }           // name lowercased, value entity-decoded
export interface RawNode { tag: string; attrs: RawAttr[]; children: RawNode[]; line: number }
export interface Diag { code: string; detail: string; line?: number }
export function scanWms(text: string): { root: RawNode | null; diagnostics: Diag[] };
export type ElementKind = 'theme' | 'view' | 'subview' | 'button' | 'buttongroup' | 'buttonelement' | 'slider'
  | 'customslider' | 'text' | 'effects' | 'video' | 'playlist' | 'equalizersettings' | 'videosettings'
  | 'player' | 'controls' | 'mediacenter' | 'automenu' | 'listbox' | 'popup' | 'item' | 'editbox' | 'unknown';
export interface TagSchema { tag: string; kind: ElementKind; defaults: Readonly<Record<string, string>> }
export function resolveTag(tag: string): TagSchema;       // predefined tags = base kind + defaults (spec §6.4, §6.6, §6.7, §6.10, §6.13-6.15)
export type AttrType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'image' | 'handler' | { enum: readonly string[] };
export function attrType(kind: ElementKind, attr: string): AttrType | undefined;
export type AttrSource =
  | { kind: 'literal'; text: string }
  | { kind: 'jscript'; source: string }
  | { kind: 'wmpprop'; path: BindPath }
  | { kind: 'wmpenabled' | 'wmpdisabled'; method: string }
  | { kind: 'res'; url: string };
export interface BindPath { root: string; segments: string[]; call?: { name: string; args: Array<string | number | boolean> } }
export function classifyValue(attr: string, raw: string): AttrSource;
export function parseColor(s: string): RGB | 'none' | 'auto' | null;              // #RRGGBB, #RGB, 140 IE names
export function coerce(type: AttrType, v: unknown, prev: unknown): unknown;       // U-20: true/false/1/0, else prev
```

### 3.4 Model (`src/engine/model/types.ts`)

```ts
export type Origin = 'init' | 'layout' | 'script' | 'binding' | 'user' | 'anim' | 'host';
export type AttrValue = string | number | boolean | null;
export interface HandlerSite { key: string; event: string; source: string; params: string[]; site: SourceSite }
export interface ElementNode {
  readonly handle: number;                                // > 0, stable for the session
  readonly kind: ElementKind;
  readonly tag: string;
  readonly id: string;                                    // declared id or `Unnamed_<type>_<n>`
  readonly parent: ElementNode | null;
  readonly children: readonly ElementNode[];
  readonly docIndex: number;
  get(attr: string): AttrValue;                           // attr lowercased; typed per schema
  set(attr: string, v: unknown, origin: Origin): boolean; // coerces; returns changed; queues `<attr>_onchange` unless origin 'init'
  source(attr: string): AttrSource | undefined;
  readonly handlers: ReadonlyMap<string, HandlerSite>;    // key: lowercased event, e.g. 'onclick', 'value_onchange'
}
export interface ViewModel {
  readonly view: ElementNode;
  readonly elements: readonly ElementNode[];              // document order
  byHandle(h: number): ElementNode | undefined;
  byId(id: string): ElementNode | undefined;              // case-insensitive; first declared wins, dups diagnosed
  paintOrder(parent: ElementNode): ReadonlyArray<ElementNode | 'background'>;
  onChange(cb: (el: ElementNode, attr: string, v: AttrValue, origin: Origin) => void): Unsubscribe;
  takeDirty(): Map<ElementNode, Set<string>>;             // renderer + coverage, once per frame
}
export function buildView(theme: RawNode, viewNode: RawNode, overlays: RawNode[], diag: DiagSink): ViewModel;
export function runLayout(view: ViewModel, realm: Realm, images: ImageStore): Promise<void>;
export function applyResize(view: ViewModel, w: number, h: number): void;
export class BindingEngine { constructor(view: ViewModel, om: ObjectModel, clock: Clock); install(): void; dispose(): void }
export class Animator {
  constructor(view: ViewModel, clock: Clock, fire: (el: ElementNode, event: 'onendmove' | 'onendalphablend') => void);
  moveTo(el: ElementNode, x: number, y: number, ms: number, ease: 'linear' | 'inout', w?: number, h?: number): void;
  alphaBlendTo(el: ElementNode, a: number, ms: number): void;
  running(): number;
}
```

### 3.5 Render, input, hit (`src/engine/render/`, `input/`, `hit/`)

```ts
export interface MountedView {
  nodeOf(el: ElementNode): HTMLElement | undefined;
  effectsContainers(): Array<{ el: ElementNode; container: HTMLElement }>;
  flush(): void;                                          // apply takeDirty(); called from clock.onFrame
  dispose(): void;
}
export function mountView(view: ViewModel, surface: Surface, images: ImageStore, host: HostAdapter, opts: EngineOptions): MountedView;
export type PickRole = 'control' | 'effects' | 'widget' | 'drag' | 'inert';
export interface Pick { el: ElementNode; part: number | null; role: PickRole }          // part = buttonelement index
export function pick(view: ViewModel, images: ImageStore, x: number, y: number, opts: EngineOptions): Pick | null;
export function coverage(view: ViewModel, images: ImageStore, w: number, h: number, opts: EngineOptions): HitShape & { kind: 'bitmap' };
export class InputRouter {
  constructor(view: ViewModel, images: ImageStore, win: SkinWindow, dispatch: Dispatcher, opts: EngineOptions);
  attach(root: HTMLElement): Unsubscribe;                 // pointerdown/move/up/cancel/leave, keydown on window
}
```

### 3.6 Realm (`src/engine/realm/types.ts`)

```ts
export type RealmValue = undefined | null | boolean | number | string | { readonly $h: number };
export const ABSENT: unique symbol;
export interface HostBridge {
  get(h: number, name: string): RealmValue | typeof ABSENT;
  set(h: number, name: string, v: RealmValue): void;      // throw HostError → realm TypeError
  has(h: number, name: string): boolean;
  call(h: number, name: string, args: RealmValue[]): RealmValue;
  global(name: string): RealmValue | typeof ABSENT;       // element ids, case-insensitive
  timer(id: number, ms: number, repeat: boolean): void;
  clearTimer(id: number): void;
}
export interface RealmLimits { memoryBytes: number; stackBytes: number; handlerMs: number; loadMs: number; exprMs: number; maxTimers: number; minTimerMs: number }
export const DEFAULT_REALM_LIMITS: RealmLimits;           // 32 MiB, 512 KiB, 50, 1000, 20, 64, 15
export interface RealmFault { kind: 'syntax' | 'exception' | 'interrupt' | 'oom' | 'stack'; message: string; site?: SourceSite }
export type RealmResult<T> = { ok: true; value: T } | { ok: false; fault: RealmFault };
export interface HandlerRef { readonly id: number }
export interface Realm {
  installGlobals(names: Record<string, RealmValue>): void;          // host globals + #132 constants
  loadScript(file: string, source: string): RealmResult<void>;
  compile(site: HandlerSite, scopeHandle: number | null): RealmResult<HandlerRef>;
  run(ref: HandlerRef, args: RealmValue[], thisHandle: number | null, budgetMs?: number): RealmResult<RealmValue>;
  evalExpr(source: string, scopeHandle: number | null): RealmResult<RealmValue>;
  fireTimer(id: number): RealmResult<void>;
  getGlobal(name: string): RealmValue;
  callGlobal(name: string, args: RealmValue[]): RealmResult<RealmValue>;
  memoryUsage(): number;
  dispose(): void;
}
export function createQuickJsRealm(bridge: HostBridge, limits?: RealmLimits): Promise<Realm>;
export function createNativeRealm(bridge: HostBridge): Realm;       // TEST ONLY (differential); lint-banned outside *.test.ts
```

## 4. Module map

| Path | Responsibility | Public surface | Wave |
|---|---|---|---|
| `src/boot.js` | pick legacy or engine | none | W0 |
| `src/engine/host.ts` | contracts | §3.1 | W1.0 |
| `src/engine/pkg/{zip,vfs,select}.ts` | archive → `SkinPackage` | §3.2 | W1 |
| `src/engine/img/{bmp,decode,key,store,pool,worker}.ts` | decode, key, cache | §3.2 | W1, W2 |
| `src/engine/wms/{text,scan,values,schema}.ts` | `.wms` → `RawNode`, value classes, tag defaults | §3.3 | W1 |
| `src/engine/realm/{types,quickjs,bootstrap,native}.ts` | script realm and membrane | §3.6 | W1 |
| `src/engine/om/{player,controls,settings,media,network,theme,view,event,mediacenter,eq,effects,playlist,video,elements,resources,ledger,bridge}.ts` | host object model, `HostBridge` impl, `#132`/`#169`/RT_STRING | `ObjectModel`, `makeBridge(view, om)` | W3 |
| `src/engine/model/{types,element,view,order,layout,bindings,animator,dispatch}.ts` | scene model | §3.4 | W2, W3 |
| `src/engine/render/{mount,subview,button,buttongroup,slider,customslider,text,host-slots}.ts` | DOM renderer | §3.5 | W2 |
| `src/engine/input/{router,picker,controllers/*}.ts` | pointer routing, controllers | §3.5 | W2, W3 |
| `src/engine/hit/coverage.ts` | window mask | §3.5 | W2 |
| `src/engine/wmp/host.ts` | `wmpHost: SkinHostFactory` (glue: load → parse → model → realm → layout → render → bind) | §3.1 | W2, W3 |
| `src/host/tauri/{index,windows,media,dsp,audio,prefs,clock,skins}.ts` | `TauriHost` | `createTauriHost(): Promise<HostAdapter>` | W4 |
| `src/app/{main-engine,menu,zoom,keyboard,effects,palette,sidecars,demo-bridge}.js` | app shell | `bootEngine()` | W4 |
| `src/app/widgets/playlist.js` (+ css) | playlist widget behind `WidgetProvider` | `buildPlaylist(panel, media)` | W3 |
| `src/sidecars/<sha256>.json` | per-skin compat | `Sidecar` | W4 |
| `src/viz/index.js` | `Viz` gains `{audio}` injection (defaults to the Tauri subscribe, so legacy is unchanged) | `new Viz(canvas, onPreset, caption, opts?)` | W3 |
| `src-tauri/src/clickthrough.rs` | per-window masks, capture by label, raw mask | `set_hit_mask_raw`, `set_capture` | W1 |
| `src-tauri/src/audio.rs` | subscriber fan-out | `audio_subscribe -> u32`, `audio_unsubscribe` | W1 |
| `src-tauri/src/skins.rs` | import, list, read archives | `skin_import`, `skin_list`, `skin_read` | W4, W5 |
| `skinlab/{cli.mjs,vite.config.mjs,states.json,allowlist.json,goldens.lock.json}` | harness | CLI | W0 |
| `skinlab/stubs/{tauri/*,viz.js}`, `skinlab/pages/{legacy,engine}.html`, `skinlab/host/harness-host.ts` | fixtures, HarnessHost | | W0, W2 |
| `tools/check-engine-imports.mjs`, `tools/corpus.mjs`, `tools/pil-crosscheck.py` | gates and corpus suites | | W0, W1 |

Data flow for one VIEW session:

```
skin bytes ─(Rust skin_read | harness fs)─> openSkinArchive ─> SkinPackage
  ─> selectWms ─> decodeText ─> scanWms ─> RawNode tree (+ sidecar overlays)
  ─> buildView ─> ViewModel ───────────────┐
  ─> createQuickJsRealm(makeBridge(view, om)); installGlobals(#132, host globals)
  ─> loadScript(*.js in scriptFile order, stem.js) ─> compile all HandlerSites
  ─> ImageStore.preload(literal refs) ─> runLayout (pass 1 literals, pass 2 jscript)
  ─> BindingEngine.install ─> mountView(surface) ─> InputRouter.attach ─> view onload
  per frame: clock.onFrame → Animator.tick → bindings(currentPosition) → MountedView.flush
             → coverage() if shape-dirty (≤30 Hz while animating) → SkinWindow.setHitShape
  input: pointer → pick → controller → Dispatcher → realm.run(handler) → model.set → dirty
```

## 5. Hand-port features: where each one goes

Every row in parity §2 has an owner here: **E** = engine semantics, **H** = host, **S** = Headspace sidecar, **X** = dropped, recorded as an intended deviation.

| Parity row | Treatment |
|---|---|
| D1 freq labels | S (overlay); tooltip suffix X (FOLLOW-WMS) |
| D2 seek reveal | E implements `slide`, `useForegroundProgress`, `foregroundProgress`; S `seekForegroundFollowsThumb` |
| D3 return button | H action (zoom toggle); tooltip follows the `.wms` |
| D4-D7 overlays, palette | H (EffectsProvider and PaletteService) |
| D8 window menu, D9 keys | H (app shell) |
| D10, D11, D29, D33 picker and mask | E (picker, coverage); D29 drag widening is X-intended; D11 106 px is allow-listed |
| D12 playlist | H widget (same DOM and CSS) |
| D13 view width | S `viewResize:'ignore'` |
| D14 pl visible | E follows the `.wms` (visible mid-slide only) |
| D15 vis tooltip bug | E runs the script as written |
| D16 enabled table | E `isAvailable`, phase-1 oracle table |
| D17, D18 detent, debounce | H (DspPort balance detent; MediaPort volume debounce 40 ms); "don't fight the drag" is E |
| D19 video stub | E (never fires) |
| D20, D21 | FOLLOW-WMS, allow-listed |
| D22 font | H mapping (Tahoma, Verdana, sans-serif) |
| D23 persistence | H keys `eq`, `balance`, `zoom`, `onTop`, `allDesktops`, `preset` kept for continuity. Replaying `eqOpen`/`plOpen` drawers at boot is X: it is not WMP behaviour, the skin has no prefs, and the harness drives states by clicks. |
| D24 spline tension | X |
| D25 screen click | H `EffectsInstance.click()` |
| D26 container clip | E |
| D27 offline conversion | E runtime decode. `convert_skin.py` is reduced to the app icon at cutover. |
| D28 slider hover box | E reproduces it (hover image whenever the pointer is over the slider box) |
| D30 capture on buttons | E: every control press calls `SkinWindow.setCapture(true)` until up or cancel |
| D31 continuous values | E keeps doubles; host quantises (volume, gains, balance integers; seek none) |
| D32 travel | E `sliderTravel:'oracle'` |
| D34 diffed writes | E (dirty set only) |
| D35 zoom | H |

## 6. Wave plan

Every task lists: owner and size, inputs, deliverable, **acceptance** (commands that exit 0, plus the numbers they must print), and dependencies. "Ships" is what someone can run at the end of the wave. During phase 1 the legacy app must keep working at the end of every wave: every wave from W1 onwards ends with `npm run skinlab -- verify --legacy` (the legacy port re-captured against the manifest, bit-identical) and a manual `npm run tauri dev` smoke test.

### Wave 0: oracle first

Ships: `npm run skinlab -- bless --from legacy` produces goldens; `npm run check` runs; the app still boots legacy by default.

- **W0.1 Scaffolding** (S, M). Add `src/engine/` with `tsconfig.json` (strict), vitest, `tools/check-engine-imports.mjs`, the npm scripts `check`, `typecheck`, `lint:engine`, `test`, `skinlab` and `corpus`, and `src/boot.js` plus the `index.html` entry change.
  Acceptance:
  1. `npm run check` exits 0.
  2. A test plants a file importing `@tauri-apps/api/core` under `src/engine/__fixtures__/`, the lint exits 1, and the test then removes the file.
  3. `npm run tauri dev` boots legacy unchanged; with `?engine=wmp` it shows a notice "engine not ready".
  Deps: none.
- **W0.2 skinlab legacy capture** (S, L). Add `cli.mjs` with the subcommands `bless`, `verify` and `show`, the Vite config with aliases, the Tauri and viz stubs per parity §4.1, the fixture resolver with the sha1 check, `public/skin` generation with a stamp, `states.json` (states 1 to 4 plus supplemental: hover and press per transport element and min/close; play state; the EQ ear mid-animation at 60 ms is report-only), the content-addressed store, and `goldens.lock.json`.
  Acceptance:
  1. Running `bless --from legacy` twice yields identical `png_sha256`/`mask_sha256` for every entry.
  2. A wrong-sha1 fixture exits 2 with a message.
  3. The report prints the live mask popcounts per state next to parity §4.1's emulated 89,328 / 122,636 / 123,258 / 89,328, and flags any difference without failing.
  4. The manifest records the Chrome version and the oracle pins.
  Deps: W0.1.
- **W0.3 Oracle review** (O, S). Inspect every golden PNG, accept or reject them, write `allowlist.json` v0, and record the live popcounts in this document's appendix.
  Deps: W0.2.

### Wave 1: leaf modules, in parallel

Ships: `npm run skin -- inspect ~/Downloads/Headspace.wmz` prints the package listing, the chosen `.wms`, the tree summary, a decode and key census, the script load result, and the handler compile count. The corpus suites run.

- **W1.0 Freeze contracts** (O, S). Commit §3.1, §3.2, §3.3 and §3.6 verbatim as `.ts` files with `throw new Error('unimplemented')` bodies. Deps: W0.1.
- **W1.1 Zip, VFS, select** (S, M).
  Acceptance (vitest, synthetic zips built in tests):
  1. Stored and deflated entries, data descriptors, a corrupt local-header signature, `../evil`, `/abs`, `a\b.bmp`, `RESOURCE.FRK/x.bmp` and `__MACOSX/` are handled.
  2. For duplicate names after case-folding, the last one wins.
  3. A bomb of 1 MiB inflating past the ratio, more than 4,096 entries, or an over-cap total is rejected with `ArchiveError` before more than the cap is allocated.

  `npm run corpus -- zip`:
  1. 342 of 342 archives open.
  2. `bruteforce`, `QuantumRedshiftWMPSkin` and `SplinterCellWMPSkin` (and their twins) are fully readable, including `sc.wms`.
  3. `Nautical` selects `Nautical.wms`, and `Sports` selects `ExtremeSports.wms`.
  4. It prints 195 distinct sha256 values.

  Deps: W1.0.
- **W1.2 Image decoders and keying** (S, L).
  Acceptance (vitest): synthetic BMPs encoded in-test for 1/4/8/16 (5-5-5 and BITFIELDS 5-6-5)/24/32 bpp, RLE4 and RLE8 (encoded, delta, EOL and EOB runs), top-down, short palette, odd widths. 32-bit alpha comes out 255. `sniff` handles PNG-in-`.bmp`. Keying: `auto` uses pixel (0,0), and `none` leaves the image untouched.
  `npm run corpus -- images`: every image entry in `skins/wmp` and `skins/wsz` decodes with 0 throws, except the 9 `RESOURCE.FRK` files (survey §3.3: 16,231 distinct entries). `python3 -I tools/pil-crosscheck.py` compares RGB hashes with PIL. The only allowed mismatch is `Weird_Amp_2/text.bmp` (16-bit), and any JPEG mismatch is reported but not failed.
  `npm run skin -- inspect --key-census` on the fixture prints `head.bmp` magenta 31,487 / red 17,909, `vid_bkgd` white 106 and `viz_drop` magenta 352 (parity §0.2).
  Deps: W1.0.
- **W1.3 Scanner, values, schema** (S, M).
  Acceptance (vitest): the four failure classes and the tab or space padding around `=`. `npm run corpus -- parse`:
  1. 195 of 195 distinct files produce a root.
  2. Encoding census 72/10/27/86.
  3. Duplicate-attribute diagnostics in 67 skins (454 exact occurrences).
  4. Missing whitespace in 22 skins, end-tag case in 12, junk after the root in 1.
  5. Headspace: one VIEW 760×394, 23 subviews, the element count matches survey R0 (69), 25 `jscript:`, 18 `wmpprop:` and 2 `wmpenabled:` values.

  `resolveTag('pausebutton')` yields BUTTON with the defaults of spec §6.4. `parseColor` knows all 140 IE names.
  Deps: W1.0.
- **W1.4a Realm spike** (S, S, **gate**). Write a minimal QuickJS harness with a mock bridge. Pass or fail, each as a vitest case:
  1. An id resolves from inside a function declared in a loaded script (`sEqEar.moveto(1,2,3)` reaches `bridge.call`), including `SEQEAR`.
  2. `with(scope(H)){ down }` reads the attribute; `down = true` writes it; `Init()` falls through to the global.
  3. `player.OpenState == osMediaOpen` holds with openstate 13.
  4. `xPlTt.tooltip` reads `toolTip`.
  5. `eval("eq"+i+".left = 5")` writes through.
  6. `a = b.visible = false` works.
  7. `while(1){}` faults `interrupt` within the budget plus 10 ms.
  8. Allocating past the memory limit faults `oom`, and the next dispatch either works or the realm reports itself dead.
  9. `setTimeout("f()", 20)` and `setTimeout(function(){}, 20)` work.
  10. A syntax error in one handler does not affect the others.
  11. `this` is the element.
  12. `eval("1;")` returns 1 in `evalExpr`.

  If case 1 fails, implement the static-accessor fallback (D1) and re-run. Output: a one-page note in the PR description. Deps: W1.0.
- **W1.4b Realm implementation** (S, L). The full `createQuickJsRealm` per §3.6, the bootstrap prelude, constants (`#132`, `#134`, `#136`, `#169`), the RT_STRING table, and the test-only `createNativeRealm`.
  Acceptance: `npm run corpus -- scripts` loads all 219 distinct `.js` files without syntax faults and compiles all 12,868 handlers with exactly **5** syntax faults, all in `supersoni__Faith Hill` (survey §5.2). A differential test runs 200 sampled handler compilations in both realms and gets identical fault or no-fault results. Deps: W1.4a.
- **W1.5 Rust: per-window hit state, raw mask, fan-out** (S, M). Per D7 and D11.
  Acceptance:
  1. `cargo test`: `Mask::hit` with zoom, `WinHit` map insert and remove, a capture label that forces only its own window clickable, fan-out dropping a closed channel.
  2. `npm run skinlab -- verify --legacy` is bit-identical (the JS is unchanged).
  3. Manual: legacy click-through and slider capture behave as before, and `tools/facelab.html` plus the app both receive frames.

  Deps: the Rust work has none and can run in parallel with W0. Acceptance item 2 needs W0.2, so it runs at the W1 wave-end gate.

### Wave 2: Headspace renders statically

Ships: `npm run skinlab -- verify --state 1` passes for the engine (W2.8 adds a static in-app preview).

- **W2.0 Freeze model contracts** (O, S). Commit §3.4 and §3.5 verbatim. Deps: W1.0.
- **W2.1 Scene model and order** (S, L). `element.ts`, `view.ts`, `order.ts`, `dispatch.ts` (queueing only).
  Acceptance (vitest on the fixture via a local-only test, skipped when the fixture is absent): `paintOrder` reproduces parity §0.6 exactly (sEqEar, sPlEar, head; inside head: screen, visDrop, background, the z2 group, pause). Unnamed ids follow `Unnamed_<type>_<n>`. `byId('SEQEAR')` resolves. Coercion follows U-20 (`'false'` into a bool, `"ture"` keeps the previous value). Deps: W2.0, W1.3.
- **W2.2 Layout** (S, M).
  Acceptance: the Headspace values of parity §0.4: volume.left 89, volume.top 11, label 108, eq1 (11,44) … eq10.left 146, reset (140,**127**). 9SeriesDefault's `svMain.width` reads `svStub`'s literal 263 (forward read). QuickSilver's descendant `jscript:` read yields the default plus a diagnostic. Revert's `width="jscript:view.width-2*left"` evaluates. A VIEW without a size takes the image size (Miniplayer). Deps: W2.1, W1.4b, W2.3.
- **W2.3 ImageStore and worker pool** (S, M).
  Acceptance: preloading Headspace's literal references decodes everything; a missing name returns `null` plus one diagnostic; `KeySpec` caching works; the worker path and the inline path give identical bytes (vitest compares inline vs `node:worker_threads`). Deps: W1.2.
- **W2.4 DOM renderer** (S, L). Per D2.
  Acceptance: `skinlab verify --state 1 --dpr 1` passes against the legacy golden outside the exclusion and the U-23 computed region; DPR 2 is reported; no element carries a CSS `z-index` (a DOM assertion inside skinlab). Deps: W2.1, W2.2, W2.3, W2.6.
- **W2.5 Picker and coverage** (S, M).
  Acceptance: the state 1 mask bits equal the legacy golden outside `D11-mask-corners`. Picker unit tests: head magenta → `effects` (screen); head red → null; a pause-button magenta corner → `control` pause; an unowned transport pixel → `drag` (the head background below); the EQ panel at the closed ear → occluded by head. Deps: W2.1, W2.3.
- **W2.6 HarnessHost and engine page** (S, M). Per D8.
  Acceptance: `skinlab verify --engine --state 1` runs end to end; every `setHitShape` is recorded; the manual clock is deterministic (two runs give identical PNG hashes). Deps: W2.0.
- **W2.8 In-app static preview** (S, S). A surface-only shim in `src/app/main-engine.js`: it adopts the main window as the surface, reads the fixture bytes through a dev-only Rust command `dev_read_fixture`, and sets no hit mask, so the window stays clickable everywhere.
  Acceptance: `npm run tauri dev` with `?engine=wmp` shows static Headspace. Default boot is still legacy.
  Deps: W2.4.
- **W2.7 Gate** (O, M). Review the state 1 diffs, refine the allow-list, run `npm run check`, smoke `?engine=wmp`.

### Wave 3: Headspace is interactive

Ships: all four states and the supplemental set pass in skinlab. In the app, `?engine=wmp` is fully interactive (minus the app-shell features).

- **W3.1 Object model, bridge, ledger** (S, L). Per D6.
  Acceptance (vitest with a fixture MediaPort): every row of parity §3.7 resolves case-insensitively (`player.OpenState`, `player.openstate`); `loadPreference('nope') === "--"`; `controls.currentPositionString` gives `3:07`→`03:07` and 3,600 s→`01:00:00`; `getMode('loop')` follows `repeat`. The ledger for a Headspace session lists only the expected stubs (`pl.setColumnResizeMode`, `video`); diffing the ledger JSON against a committed `skinlab/expect/headspace-ledger.json` passes. Deps: W2.1, W1.4b.
- **W3.2 BindingEngine** (S, M).
  Acceptance: the 18 `wmpprop:` and 2 `wmpenabled:` bindings install. Fixture `stop→play` makes the pause button visible and enables the stop element. A volume change from MPD while a volume drag is live leaves the slider alone, and the slider re-syncs on release. No feedback loop: one MPD volume event leads to at most one `setVolume` call, and zero when the value is equal. `currentposition` updates every frame while playing. Deps: W3.1.
- **W3.3 Animator and dispatch** (S, M).
  Acceptance (manual clock): `moveTo(0, top, 120)` from 207 is at x=103.5±0.5 at 60 ms and settles at 0 by 120 ms; `onEndMove` fires exactly once; a reversed move fires its own end event; `alphaBlendTo` likewise; `slideTo` is eased in-out and fires `onEndMove`. Deps: W2.1.
- **W3.4 Input router and controllers** (S, L). Button, buttongroup, slider, clickable text, effects click, window drag, tooltips (the surface root's `title` follows the hot element), and capture on press (parity D30).
  Acceptance: `skinlab supplemental` passes, meaning the hover and press states of each transport and min/close element equal the legacy goldens outside the U-23 region. A synthetic sequence with `pointerId:1` reproduces the demo's event shapes, throws no exception, and clicks the right element. Deps: W2.4, W2.5, W3.3.
- **W3.5 Host widgets and the effects seam** (S, M).
  1. Refactor `src/playlist.js` into `src/app/widgets/playlist.js`, taking a media port (the old export stays as a wrapper with `player` as the default, so legacy is unchanged).
  2. Give the `Viz` constructor an optional `{audio}` argument.
  3. Add the effects provider stub for skinlab and the real one for the app.

  Acceptance: `skinlab verify --legacy` stays bit-identical (state 3 covers the playlist), and the manifest's oracle pins are updated in the same commit with a note. Deps: W2.6.
- **W3.6 wmpHost glue** (S, M). `src/engine/wmp/host.ts`: the full load sequence of §4, `onload` after layout, fault policy, `idle()` and `query()`.
  Acceptance: `skinlab verify --state all --dpr 1,2` passes (states 2 to 4 are reached by clicks on the handles and the vis element, exactly as for legacy); `realm.getGlobal('eqIsOpen') === true` after the state 2 script runs. Deps: W3.1 to W3.5.
- **W3.7 Gate** (O, M). All states at both DPRs, a report-only WebKit pass, a review of the allow-list (each entry justified), `npm run check`.

### Wave 4: Tauri host, app shell, cutover

Ships: the engine is the default; after the criteria in §7, the legacy port is deleted.

- **W4.1 TauriHost** (S, L). `src/host/tauri/*` per D7, D8 and D4, plus `src-tauri/src/skins.rs` (`skin_import`, `skin_read`). Default-skin resolution: the most recently used hash in host prefs; otherwise an imported Headspace; otherwise import `~/Downloads/Headspace.wmz` on first run; otherwise a notice and the menu.
  Acceptance: an in-app smoke checklist (play/pause/stop/next, seek drag, volume, balance, EQ, drawers, chooser, click-through on transparent pixels and inside the hole, drag the window by the head, a slider dragged off-skin keeps tracking), mask updates visible during a drawer slide (`js_log` shows `setHitShape` at ≤ 30 Hz), and no console errors under the CSP. Deps: W3.6.
- **W4.2 App shell** (S, M). Menu, zoom, keyboard, overlays, palette facade, sidecar loader, and the Headspace sidecar.
  Acceptance: `skinlab verify --state 2` with the sidecar passes the D1 labels **exactly** (no allow-list); the menu works on right-click, Ctrl-click and Option-click; zoom 1.5 sizes the window to 1140×591 and the mask follows. Deps: W4.1.
- **W4.3 Demo bridge** (S, M).
  Acceptance: `skinlab demo` runs the whole tour headless (with `record_*` stubbed) without exceptions, and hits these checkpoints: eq open by t=7.5 s, `ui.bands` values `[10,8,0,0,-5,0,0,0,6,9]` after the drags, visDrop open, the preset stepped 5 times. The owner then records `tools/record-demo.sh` in the app. Deps: W4.2.
- **W4.4 Cutover** (O, M). Check §7, tag `oracle/headspace-v1` at the oracle pin, flip the default, soak, delete the legacy code, and verify that `bless --from tag:oracle/headspace-v1` reproduces the manifest hashes.

### Wave 5: R1 Miniplayer, R2 aoe, skin loading

Ships: a "Skins ▸" menu with Import…, untrusted skins loading with fault unloading, and R1 and R2 playable.

- **W5.1 Skin picker and import** (S, M). `tauri-plugin-dialog`, `skin_list`, a menu, and per-skin last-used state.
- **W5.2 View sizing and resize policy** (S, M). VIEW size from the image, VIEW `transparencyColor`/`clippingColor` as the window shape, `honor` resize with `applyResize`.
- **W5.3 Predefined tags and remaining controls** (S, L). The full tables of spec §6.4, §6.6, §6.7, §6.10 and §6.13; sticky/`down`; MUTEBUTTON; TEXT `scrolling` marquee (6 px every 85 ms, two-space gap); `itemsPlaylist`.
- **W5.4 Static API scanner and ledger report** (S, M). `npm run corpus -- api-rank` writes `docs/coverage/api-rank.csv` (notan Q3). `skinlab ladder` renders per-rung ledger and fault tables.
- **W5.5 Rung goldens from self** (O, M). There is no oracle for R1 and R2. Acceptance is behavioural scripts (`states.json` per rung: play, pause, seek, volume, mute, drawer toggles) with zero realm faults, the ledger reviewed, and an Opus visual review of the captures. Those captures are then blessed as **regression** goldens (`--from engine`, manifest-only, same storage rule).

  Deps: W4.

Per-task acceptance for W5:
- W5.1: importing a `.wmz` copies it to `$APPDATA/skins/<sha256>.wmz`, and `skin_list` returns it. Importing the same file again creates no duplicate. A 33 MiB file is rejected before it is read. Choosing a skin from the menu restarts the session, and the last-used hash survives an app restart.
- W5.2: Miniplayer's VIEW size equals its `mini_background.bmp` dimensions. The recorded mask popcount equals that image's non-keyed pixel count. A script write `view.width = 400` resizes the native window, and right-aligned children keep their right margin.
- W5.3: on the manual clock, a `scrolling` TEXT advances 6 px every 85 ms with a two-space gap. A sticky MUTEBUTTON toggles `down` and `settings.mute`. `resolveTag` covers every predefined tag in spec §6.4, §6.6, §6.7 and §6.10, with a vitest case per tag.
- W5.4: `docs/coverage/api-rank.csv` lists, in its top rows, the members survey §5.4 ranks highest (`player.currentMedia`, `player.settings`, `player.controls`). `skinlab ladder` prints, per rung, the fault count and the stub and missing ledger counts.

### Wave 6: R3 PowerToys, multi-view, seam freeze

Ships: multi-window skins; `SkinHost`, `SkinWindow` and `HitShape` v1 frozen for phase 2.

- **W6.1 Window factory** (S, L). `WebviewWindowBuilder` views, capabilities, `theme.openView/closeView/currentViewID/openViewRelative`, positions persisted and clamped, main restored first, closing main closes all.
- **W6.2 Cross-view prefs and audio** (S, S). `storage` events, one audio subscription per window.
- **W6.3 Overlap routing** (S, M). An 8 ms poll when frames intersect, plus a scripted overlap test (two windows, alternating clicks in the overlap; misroutes counted, target 0 in 200).
- **W6.4 Seam freeze** (O, M). Review the contracts against Webamp's needs (webamp §2 and §4) and publish v1.

  Deps: W5.

Per-task acceptance for W6:
- W6.1: PowerToys calling `theme.openView('AlertDialog')` creates a second `view-*` window, and its label appears in Rust `HitState`. Closing main closes it. Window positions are restored on relaunch, clamped to the visible area. A view with a duplicate id in another view resolves to its own element.
- W6.2: a `savePreference` in one window is visible to `loadPreference` in the other on the next call. Two windows with EFFECTS both receive frames (the Rust fan-out count is 2).
- W6.3: misroute target 0 in 200, as stated above.
- W6.4: a written contract review in which each Webamp need from webamp §2 and §4 maps to a v1 member or to a named phase-2 extension.

### Phase 2 (outline, frozen seam)

- **P2-W1 Winamp host:** `winamp2Host` via `webamp/lazy`, the media class and Redux adapter over `MediaPort` (echo and idempotence guards, webamp §1.3), an `internal` binding window, `HitShape.regions` with Rust `set_hit_regions`, museum screenshot diffs (report-only). The 30-skin `skins/wsz` manifest is the fixture set.
- **P2-W2 Audio:** `eq_configure`, preamp, bypass, `Frame.pcm` opt-in; optional butterchurn facade.
- **P2-W3 PaletteService artifact tier** (notan-palette/1 consumer, per D12).
- **P2-W4 Sync state machine tests:** replays of recorded MPD idle sequences against the Webamp adapter.

## 7. Cutover criteria (legacy deletion)

All of these must hold, checked by Opus at W4.4:

1. `skinlab verify --state all --dpr 1,2` passes pixels and masks, and the only active allow-list entries are `U-23-showBackground` (or none, if the owner picked the sidecar override), `D20-reset-y`, `D21-preset-title` and `D11-mask-corners`.
2. `skinlab supplemental` passes, and `skinlab demo` passes its checkpoints.
3. The report-only WebKit pass shows no differences beyond the Chrome pass (any extra difference is investigated, not waived).
4. The in-app smoke checklist (W4.1) passes. The owner records the demo video on the engine.
5. The owner runs the engine as the default for a soak period of their choosing, with zero fault unloads in the log.
6. Tag `oracle/headspace-v1` exists, and `bless --from tag:oracle/headspace-v1` reproduces every manifest hash.

Then delete `src/main.js`, `src/widgets.js`, the legacy-only CSS, the `npm run skin` image generation and `public/skin/`. Reduce `tools/convert_skin.py` to the app-icon step. Remove the legacy `set_hit_mask` JSON command and the boot switch's legacy branch.

## 8. Accepted risks

1. **QuickJS semantics are not yet verified** (global-prototype Proxy lookup, `with` over a Proxy, interrupt granularity). This is mitigated by the W1.4a spike with a defined static fallback. The residual risk is ids that are built by `eval` *and* mis-cased, which occurs zero times in the corpus.
2. **The harness runs in Chrome and the app in WKWebView.** Parity is valid because both renders share one browser, but WKWebView-only bugs fall to the report-only WebKit pass and the manual smoke test.
3. **U-23 `showBackground` defaults to the documented `false`.** That changes about 811 pixels on Headspace's main face against the oracle (spec §6.5). It is owner-visible and needs the owner's call: the sidecar override restores the oracle look. Recorded in the allow-list, not baked in.
4. **No `jscript:` re-evaluation.** If R6 (alignment-heavy Blinx) shows a skin depending on it, the fix is a per-attribute flag, not a redesign.
5. **One webview per VIEW multiplies memory** (engine, a QuickJS runtime whose footprint is measured at W6, decoded art). Skins have up to 9 views. Accepted for phase 1 and measured in W6.
6. **Clickthrough polling at 16 ms (8 ms when overlapping)** can misroute clicks between overlapping windows. W6.3 measures it; NSEvent monitors are considered only on evidence.
7. **The goldens live outside git.** Reproducibility depends on the oracle tag, the fixture sha1 and the Chrome major version, all recorded in the manifest. A Chrome upgrade can force a re-bless.
8. **JPEG decoding differs between the harness and the app** (browser decoders). Rare in keyed contexts.
9. **The `isAvailable` table is pinned to the oracle** (play/next/previous always enabled). That is wrong for skins with `disabledImage` on PLAYBUTTON. Revisited at R1 (parity open question 5).
10. **Mapping MPD onto WMP enums** (`osPlaylistOpenNoMedia` for an empty queue, invented `player.status` strings) is guesswork (U-32). It is ledgered and adjustable without structural change.
11. **Host globals beat element ids** (`id="view"`, G17). One skin (Navigator) may break, and the choice is ledgered.

## 9. Left for phase 3 on purpose

- Rungs R4 to R9 and their features: `automenu`, `popup`, `listbox` and `editbox` as real host widgets; `res://` images beyond transparent placeholders; `clippingImage` on views; animated GIFs; `alphaBlend` crossfade stress (xsn_sports); `customslider` (designed in D2, built with R8); `view.size(handle)` resize grips with min and max sizes; `nineGridMargins` and `resizeImages`; `backgroundImageHueShift` and `saturation` on 8-bit BMPs; `.cur`/`.ani` cursors; `theme.playSound`; `openDialog`; `launchURL` with a confirmation; `mediaCollection`, `cdromCollection` and `dvd` (stubs remain); the `<bars>` and `<visualization>` tags.
- Skin popup menus on right-click (the host menu always wins in phases 1 and 2).
- Verifying the U-register against a real WMP render (U-2, U-10, U-23, U-25) and switching defaults on that evidence.
- **Our own new skins:** no new format. Phase 3 authors new skins as `.wms`/`.wmz` plus our sidecar extensions, so the engine needs nothing new to run them. A native declarative format is considered only if `.wms` limits actual authoring.
- Platforms other than macOS.

## 10. Conflicts between sources, resolved

| Topic | Sources | Resolution |
|---|---|---|
| `jscript:` re-evaluation | spec §3.2 / U-3 (once) vs survey G13 (re-evaluate) | Once, in document order, with alignment for live behaviour. The 2,773 of 2,791 pairing is the decisive evidence (D5). |
| `loadPreference` for an unset key | spec §7.3 / U-16 (`""`) vs survey G20 (`"--"`, 83 of 94 skins) | `"--"` (D6) |
| Slider thumb travel | the task's allow-list framing vs parity D32 (the oracle formula is the contract; `demo:112` needs 65) | The oracle formula is the default; the allow-list entry is empty unless switched (D2, D9) |
| Nested SUBVIEW z | MS docs ("absolute"; "no nested SUBVIEW") vs Headspace | Reading C stacking contexts, behind a switch (D5) |
| `showBackground` | docs default `false` vs the oracle painting `image` | Docs default, sidecar override, allow-listed (D2, risk 3) |
| Mask freshness mechanism | notan Q1(c) (MutationObserver) vs this design | The model's dirty set, because the engine owns the model (D2) |
| Prefs storage | notan Q3 (one JSON file per hash, atomic rename) vs incremental need | localStorage namespaced by hash, with caps, shared across webviews. A Rust file store only if localStorage proves insufficient. |
| Mask popcounts | parity §4.1 (emulated) vs the live oracle | The live oracle wins (W0.2 regenerates) |

## Appendix A: Headspace acceptance numbers in one place

- Fixture: `~/Downloads/Headspace.wmz` sha1 `f9671f06…`; `headspace.wms` sha1 `2870d4b1…` (UTF-16LE with BOM); `headspace.js` sha1 `073d4ffb…` (cp1252).
- View 760×394; 23 subviews; element count as survey R0 (69); 25 `jscript:`, 18 `wmpprop:`, 2 `wmpenabled:`.
- Layout (parity §0.4): volume (89,11); Volume label x 108; eq*i* x = 11 + 15·i, y 44; reset (140,127).
- Absolute geometry (parity §0.5): head (261,0); screen (270,59) 216×158; EQ ear x 207 closed, 0 open; PL ear x 277 closed, 488 open; drop y 33 closed, 59 open.
- Key census (parity §0.2): head magenta 31,487, red 17,909; vid_bkgd white 106; viz_drop magenta 352; play_controls_map 5 keys × 461 px (spec §6.5).
- Masks (emulated; W0.2 replaces them with live values): 89,328 / 122,636 / 123,258 / 89,328; bytes 37,430 each.
- Animations: 120 ms linear; EQ ear at 60 ms ≈ x 103.5.
- Live popcounts from W0.2: *(to be filled at W0.3)*.
