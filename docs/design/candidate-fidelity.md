# Skin engine design: candidate FIDELITY-FIRST

Status: candidate design, 2026-10-06, branch `skin-engine`, uncommitted. One of several candidates; this one optimises for reproducing WMP semantics exactly and for the widest share of the 195-skin corpus, with pixel parity against the Headspace hand port treated as non-negotiable. Where fidelity costs more code, this design pays it.

Evidence base (cited as `doc §n`): `docs/research/headspace-parity.md` (**parity**), `wms-spec.md` (**spec**), `corpus-survey.md` (**survey**), `wmploc-library.md` (**wmploc**), `webamp-spike.md` (**webamp**), `winamp2-corpus.md` (**wa2**), `notan-input.md` (**notan**), and the current code (`main:`, `widgets:`, `player:`, `viz:`, `demo:`, `lib.rs:`, `click:`, `audio.rs:`, `eq.rs:`). Two probes were run for this design in `/tmp/qjs-probe` (nothing in the repo): **probe-1** and **probe-2**, QuickJS-WASM behaviour, results quoted in D1.

---

## 0. Summary

The engine is a **WMS interpreter that runs the skin as written** (script, bugs and all) inside an isolated QuickJS realm, renders it as **DOM layers that mirror the scene graph** (the same medium the oracle uses, so text and image rasterisation are identical), hit-tests it **natively in the DOM through per-element `clip-path` regions** derived from the same keyed bitmaps that paint it, and drives everything from a **Tauri-free engine package behind a `HostAdapter`**, with the pixel-diff harness as the second adapter built before the Tauri one.

Fidelity stance, in one rule: **docs where they are unambiguous, corpus behaviour where the docs are silent or contradicted by working skins, the Headspace oracle where both are silent, and the UNCONFIRMED-register default last.** Every place the engine departs from the oracle is a named, measured allow-list entry, and the allow-list is *proved* by running a second engine configuration (`oracle-compat`) that must match the oracle with zero diff.

| # | Decision | Position (short) |
|---|---|---|
| D1 | Script realm | QuickJS-WASM, sync variant, main thread; one wasm instance per skin session (fault domain), one context per VIEW; `with`-scoped handlers over a case-insensitive Proxy membrane; ids as global accessors |
| D2 | Renderer | Hybrid DOM: node per element, Reading-C stacking by DOM order, `<canvas>` only for keyed bitmaps and per-pixel controls, DOM text with the oracle's CSS box, clock-driven JS animation, DOM-native hit-testing via `clip-path` |
| D3 | Images | Own pure-JS decode pipeline in a Worker (own BMP incl. RLE4/8, 16/32-bit; fast-png, omggif, jpeg-js), sniff by magic, per-declaration keying, never the browser decoder |
| D4 | Loading | Rust `skinpack` crate owns the untrusted zip (central directory, header repair, caps, flat case-folded index, sha256 identity); engine receives a sync in-memory `SkinVFS`; never extract to disk |
| D5 | Parse/layout/bindings | Tolerant scanner, last-duplicate-wins; two-pass `jscript:` evaluated **once** in document order; alignment anchoring for resize; live `wmpprop:`/`wmpenabled:` with drag suspension and re-entrancy guard; Reading C stacking |
| D6 | Object model | Host-side schema-driven objects, int enums, MPD via a `MediaModel` interface, optimistic sync reads, generated stubs with a coverage ledger |
| D7 | Windows | `SkinWindow` abstraction; WMP VIEWs bind to real Tauri WebviewWindows (one engine instance per view-webview), `view.width/height` honoured; per-window masks and capture in `clickthrough.rs` |
| D8 | Boundary | `src/engine/**` imports no Tauri, enforced in `npm test`; `HostAdapter` with surfaces, input, clock, prefs, media, audio, palette, effects, widgets, ledger |
| D9 | Oracle/tests | `skinlab`: pinned Playwright Chromium, DPR 1 and 2, frozen clock, viz stub; legacy goldens content-addressed outside git; per-window pixel and mask diff; `faithful` vs `oracle-compat` configs |
| D10 | App features | Shell features attach to engine queries, never to DOM ids; overlays mount inside the EFFECTS node; demo retargeted via an inspector; boot flag for coexistence |
| D11 | Audio | EQ profile per skin family (centres, Q, range, preamp, bypass), `Vec` subscriber fan-out, optional `pcm` in `Frame` |
| D12 | Phase-2 seam | `SkinHost` interface shared by `WmpHost` and `WebampHost`; `PaletteService` in the shell, local tier in phase 1, notan-palette/1 artifact tier in phase 3 |

Phases: **Phase 1** WMP engine to Headspace parity, single-view corpus breadth, cutover. **Phase 2** Webamp for `.wsz`. **Phase 3** WMP breadth: multi-view satellite windows, resizable views, the long tail. Section 7 has the wave plan.

---

## 1. Ground rules

1. **Precedence (parity §0.1 rule 1, sharpened).** The engine implements WMP semantics. The fidelity ladder for any behaviour is: (a) Microsoft docs where unambiguous (spec §1.1); (b) corpus behaviour where docs are silent or contradicted by working skins (spec §9.2, survey §5.3); (c) the Headspace oracle where both are silent; (d) the UNCONFIRMED-register default (spec §10). A behaviour taken from (c) or (d) is a named switch, not a constant.
2. **Two engine configurations.** `faithful` ships. `oracle-compat` exists to prove the allow-list: it flips exactly the switches that correspond to allow-list entries (showBackground U-23, slider travel U-10, sidecar overrides for D20/D21, the D11 mask over-approximation) and must reproduce the oracle with **zero pixel diff outside the excluded effects hole**. Then `faithful` vs oracle may differ only inside the allow-list, and every allow-list entry has a declared bound that the harness enforces (drift guard). This turns "allow-listed" from an assertion into a measurement.
3. **Run the skin's script as written.** No Headspace function name appears in engine code (parity §0.1 rule 2). Skin-specific departures live in a **sidecar** (our own data, never inside the `.wmz`), keyed by skin sha256.
4. **Case-insensitive everywhere except skin-declared script identifiers** (spec §2.2, survey §3.1, wmploc §4.3 item 2, U-28).
5. **No skin art in git**, including rendered goldens (a Headspace screenshot is Microsoft art). Committed: synthetic own-authored fixtures, hash manifests with provenance, counts and API names. Corpus and owner skins are read from `skins/` and `~/Downloads/Headspace.wmz`, skip-if-absent.
6. **Main keeps working until cutover.** The legacy hand port (`src/main.js`, `src/widgets.js`) stays the default and the oracle until the cutover criteria in D10 pass. All Rust changes are additive; legacy command signatures keep working.
7. **No CSS `z-index` in engine output** (parity §3.1: the demo cursor uses 1000, the flash 2000). Paint order is DOM order.

---

## 2. Decision register

Each entry: **Position**, **Rationale**, **Evidence**, **Consequences** (modules and contracts it fixes).

### D1. Script realm

**Position.** QuickJS compiled to WebAssembly, synchronous variant, on the main thread of each skin webview.

- Packages (pinned): `quickjs-emscripten-core@0.32.0` (MIT; JS glue, 795 KB unpacked including maps and `.d.ts`, the runtime JS is a fraction of that) and `@jitl/quickjs-wasmfile-release-sync@0.32.0` (wasm `emscripten-module.wasm` **503,134 bytes** raw, measured from the npm tarball). Loaded with a dynamic `import()` only in engine mode, so the legacy path pays nothing.
- **Instantiation model.** `WebAssembly.Module` compiled once per app process and cached; **one module instance per skin session** (`newQuickJSWASMModuleFromVariant(newVariant(base, { wasmModule }))`). One `QuickJSRuntime` per session, one `QuickJSContext` per VIEW (spec §2.1 step 3: "each view has its own variable scope"). Under the D7 satellite binding each webview holds exactly one context; the multi-context design keeps an `internal`-bound WMP view (several views in one process) possible later without changing the realm. The session instance is the **fault domain**: a WASM abort kills the whole module (probe-1 ended in `Aborted(Assertion failed: list_empty(&rt->gc_obj_list) ... JS_FreeRuntime)` after leaked handles), so on any abort the engine never calls `dispose` again; it drops every reference to the instance and lets GC reclaim it.
- **Caps.** Runtime memory limit 64 MB, max stack 1 MB (`rt.setMemoryLimit`, `rt.setMaxStackSize`). Every entry into the realm (handler dispatch, timer, binding `_onchange`, `jscript:` evaluation, script load) runs under an interrupt deadline: 50 ms per dispatch, 2,000 ms for initial script load. Fault policy: an interrupted or OOM dispatch aborts that dispatch only and counts a fault; 3 faults in 10 s, any OOM during load, or any WASM abort **unloads the realm** (bindings frozen, last frame stays painted, host notice "Skin script stopped", window menu offers Reload skin / Use default skin). A ReferenceError or TypeError is *not* a fault: it aborts that handler only (wmploc §4.3 item 3: 36% of unique skins contain such names).
- **Scope chain** (spec §2.4, U-31). Innermost to outermost: the firing element (attributes and methods, as `with`), then the context's global object, whose own properties are the host globals (`player`, `theme`, `view`, `event`, `mediacenter`, `playerApplication`), the wmploc constants (seeded before any skin script, wmploc §7.3 item 4), and the skin's script globals; then the VIEW's element ids. Ids are defined **after** the scripts' top-level code has run, as own accessor properties on the global object, for the declared spelling and every case variant of it found by a lexical scan of all script, handler and `jscript:` text in that VIEW (Ice's `Volume` vs `volume`, survey §3.1). A name a script already declared keeps the script's binding and logs a collision diagnostic (G17; WMP's order is unverified, recorded as U-31b in §8).
  - Rejected alternative for ids: a Proxy installed as the global object's prototype. probe-2 showed it resolves ids case-insensitively, but QuickJS then resolves *every* unknown global to `undefined` through the proxy's `get`, so `undefinedFn()` raised `TypeError` instead of `ReferenceError` and bare reads of undeclared names silently produce `undefined`. That loses JScript's ReferenceError semantics that the corpus' template leftovers depend on (wmploc §4.1 bucket B2). Accessors keep them.
- **Membrane (copy-only).** No host JS object ever enters the realm. Host objects are referenced by integer handles; the realm wraps each handle once in a cached Proxy (so `bEq === bEq` holds) whose `get`/`set`/`has` traps call three host functions (`__h_get(h, name)`, `__h_set(h, name, value)`, `__h_has(h, name)`), which case-fold `name` and look it up in the object's schema (D6). Values crossing: primitives copied; host objects become handles; realm functions passed to the host (timer callbacks) are retained by id in a realm-side registry and invoked by id; arrays and plain objects from the realm are deep-copied with a size cap (4,096 nodes). `has` answers true only for the schema's members of that element type plus attributes present in the markup, so bare `Init()` or `osMediaOpen` inside a handler fall through `with` to the globals (probe-1: `NotDefined()` inside `with(sEqEar){...}` gave `'NotDefined' is not defined`).
- **Handlers.** Each handler attribute compiles once into a realm function `function(<params>) { with (this) { <text> } }` called with `this` = the element proxy (spec §2.3: `this` is the firing element). `<params>` is empty except for PLAYER events, which get the documented parameter names with exact case (`NewState`, `ModeName`, `NewValue`, `scType`, `Param`, `oldPosition`, `newPosition`, spec §2.2, §6.19). Handler text is compiled **as is**: `jscript:`, `javascript:` and `wmpprop:` prefixes are valid JS statement labels (spec §2.3, U-6). Only if compilation fails is one leading `identifier:` stripped and compilation retried; if that fails the handler is recorded as a syntax diagnostic (survey §5.2: exactly 5 handlers in one skin).
- **`jscript:` attribute values** are evaluated as `(function(){ with (this) { return eval(<text as string literal>); } })` so a trailing `;` (456 `top`s end in `;`, spec §3.2) and statement forms work, and the completion value is the attribute value; direct `eval` inside `with` sees the element scope (probe-1: `eval("sEqEar" + ".top = 99")` worked).
- **Timers.** `setTimeout(code|fn, ms)` and `clearTimeout` (spec §2.6: string form, 18 uses; `setInterval` never occurs but is provided), at most 64 pending per view, minimum 10 ms; VIEW `timerInterval`/`ontimer` with the documented rules (default 1000, 0 = off, non-zero < 50 rejected keeping the previous value, timer runs only if `ontimer` exists, spec §6.2). Timers run on the host clock (D8) so the harness can freeze them.
- **Determinism hooks.** `Date` and `Math.random` inside the realm come from the WASM module's imports, which read the page clock; skinlab freezes the page clock (D9).

**Rationale.** The realm must support five things at once: element-implicit `with` scope, case-insensitive host members over case-sensitive script identifiers, ids as globals, **synchronous** reads of player and layout state from inside a handler (`sEqEar.moveto(eqClosedPos, sEqEar.top, speed)` reads `top` mid-statement, `hs.js` ToggleEqView), and hard caps on CPU and memory with fault unloading (notan Q3). Only an in-thread interpreter gives synchronous host access *and* caps. A Web Worker realm needs `SharedArrayBuffer` plus `Atomics.wait` for synchronous reads, which needs cross-origin isolation headers on Tauri's custom protocol (unverified there) and still has no memory cap. A sandboxed iframe without `allow-same-origin` is reachable only by `postMessage` (async); with `allow-same-origin` it is not isolated; and neither can interrupt `while(true){}`, which would freeze the app's only UI thread. Host `eval`/`Function` has the same no-cap problem and leaks globals (webamp §6 on webamp-modern's `<script>` injection). The interpreter's cost is speed, and skin scripts are small (survey §5.1: median 342 lines, max 3,938; probe-1 measured 10,000 proxied host reads in 30 ms, about 3 µs each).

**Evidence.** probe-1 (QuickJS 0.32.0 under Node 26): `with` + Proxy + case-insensitive `get` gave `[true, 207, 207, 50, "x"]` for `[Init(), left, sEqEar.LEFT, player.volume, upToolTip]`; assignment through `with` reached the host (`value` became 42); `while(true){}` interrupted after 51 ms with `InternalError: interrupted`; an allocation loop hit `InternalError: out of memory` at the cap; `eval` saw element ids. probe-2: global-prototype Proxy loses ReferenceError (above). Corpus syntax: all 219 scripts and 12,863 of 12,868 handlers compile as sloppy ES (survey §5.2); `eval` in 57/195 skins (G18), which QuickJS supports with the same scope.

**Consequences.** `src/engine/realm/` (D1 module map §4.6); D6's schema is the single source of truth for `has`/`get`/`set`; every realm entry goes through one `Realm.dispatch()` that owns the deadline and fault accounting; the realm wrapper uses quickjs-emscripten `Scope`/`Lifetime` discipline so handle leaks are test failures (W1.F acceptance checks `rt.dumpMemoryUsage()` object counts return to baseline after 1,000 dispatches).

### D2. Renderer

**Position.** Hybrid DOM, forced by D9.

- **One DOM node per scene element**, absolutely positioned in its parent's pixel space. A VIEW or SUBVIEW is a container `div` (`isolation: isolate`; `overflow: hidden` when it has a non-zero size, explicit or from its background image); its background is a **child layer** (`<canvas>` for an image, a filled `div` for `backgroundColor`), not a CSS background, because children with negative z must paint under it.
- **Stacking = DOM order, Reading C** (parity §0.1 rule 4; spec §5.3): within each container, children are emitted sorted by `(zIndex, documentIndex)`, with the background layer inserted at z = 0 **before** any z = 0 child; a runtime `zIndex` write re-sorts that container by re-appending nodes. No CSS `z-index` anywhere (rule 7).
- **Bitmaps** are `<canvas>` elements whose backing store is exactly the image size, filled with `putImageData` from the keyed RGBA (D3), styled `image-rendering: pixelated` (the oracle's rule, `css:39-46`), so at DPR 1 and 2 they rasterise identically to the oracle's `<img>` of the same pixels.
- **Text** is a DOM `div` that reproduces the oracle's text box exactly: absolute position, no padding, `line-height: normal`, `white-space: nowrap` unless `wordWrap`, `font-family` from the font map (system font → `Tahoma, Verdana, sans-serif`, D22), `font-size = round(pt * 4 / 3)` px (parity G8: 7 pt → 9 px), `-webkit-font-smoothing: none`, `color` from `foregroundColor`, `text-align` from `justification`, ellipsis cropping when the value overflows a set width (spec §6.10). `textWidth` is measured on a hidden DOM span with the same style, not on canvas, so measurement and paint share a rasteriser. `scrolling` is a clock-driven marquee (two-space gap, `scrollingAmount` px every `scrollingDelay` ms).
- **Per-pixel controls in canvas**: BUTTONGROUP (per-pixel ownership composite, the `widgets:102-207` algorithm generalised with `showBackground`, `radio`, `sticky`, per-element disabled), SLIDER/PROGRESSBAR tracks (colour mode with gradients; image mode with `tiled` and `borderSize` end caps drawn left-aligned, then the middle segment tiled from the start, D3 geometry), CUSTOMSLIDER (frame `round(f*(N-1))` blitted from the strip, spec U-9), and the BUTTON image states.
- **Slider foreground**: `slide=false` reveals the foreground in place through a clipping child `div`; `slide=true` translates it so its leading edge follows the thumb centre; `useForegroundProgress` constrains the thumb to `foregroundProgress`% and paints the foreground up to that edge (spec §6.7). Thumb geometry is a switch: `docs` (default: thumb centre travels `[b, L-b]`, spec §6.7) or `oracle` (`length - thumbExtent`, `widgets:245`). The two coincide at f = 0.5 (centre `L/2` in both) and at f = 0 for the seek bar (`b = 9 = 18/2`), which is every slider position in the four parity states (parity §4.1: EQ 0 dB, balance 0, volume 50, seek 0), so the switch costs no golden pixels.
- **alphaBlend** = CSS `opacity` on the element's node (subtree blended as a unit, spec §5.4; buttons inside a BUTTONGROUP share the group's). Keyed pixels stay keyed (U-13).
- **Animations are clock-driven JS**, not CSS transitions: `moveTo` linear, `slideTo` and `moveSizeTo(fSlide)` ease-in-out (cubic, U-25), `alphaBlendTo` linear, each frame computing the position from the `HostAdapter.clock` and writing integer `left`/`top` (or opacity), firing `onendmove`/`onendalphablend` after the final write. CSS transitions cannot be stepped by a frozen clock and would make `onEndMove` timing non-deterministic in the harness.
- **Hit-testing is DOM-native through `clip-path`.** Every element's hit region is computed from the same keyed bitmaps that paint it (table below) as a row-run region, merged into rectangles and serialised to `clip-path: path('M...Z ...')` (integer coordinates, so no partial coverage at DPR 1 or 2). Pointer events land on the element node itself, so `document.elementFromPoint` resolves to the control (the demo's input model, parity §3.1, keeps working) and the browser does the top-down search in paint order. The same regions, unioned per window and intersected with ancestor clips, produce the OS click-through mask (D7). webamp §2 verified in WKWebView that `elementFromPoint` respects `clip-path` at 1x and 2x.

Hit and paint rules per element (spec §2.7 table, §5.5; the oracle's answer to parity open question 3 is pinned: the head's magenta hole passes clicks to what is under it):

| Element | Paints | Hit region (clip-path) | Press with no handler |
|---|---|---|---|
| VIEW/SUBVIEW container | nothing itself | clips descendants to: its bounds (if sized) ∩ the non-`clippingColor` pixels of its background / `clippingImage` | n/a (`pointer-events: none` on the container) |
| VIEW/SUBVIEW background layer | image minus `transparencyColor`, `clippingColor` and alpha-0 pixels; or `backgroundColor` rect | exactly the painted pixels (keyed pixels are see-through to lower z *and* to clicks) | window drag |
| BUTTON with image | current state image, keyed | whole box (transparent pixels still receive clicks, `button-transparencycolor`), ∩ `clippingImage` region | n/a (interactive) |
| BUTTON without image, with width and height | nothing | whole box (spec §2.7) | n/a |
| BUTTONGROUP | owned pixels from each element's state layer; unowned pixels from `image` iff `showBackground` | owned pixels of valid `mappingColor`s (unowned are never clickable, `buttongroup-showbackground`), ∩ `clippingImage` | n/a |
| SLIDER/PROGRESSBAR | track, foreground, thumb | box | interactive iff `thumbImage` (spec §6.7), else window drag |
| CUSTOMSLIDER | current frame | pure-grey pixels of `positionImage` | n/a |
| TEXT | text, background colour | box (width×height or text extent) | window drag unless it has a mouse handler |
| EFFECTS / VIDEO windowless | host surface | box | host action (D10) |
| PLAYLIST, EDITBOX, LISTBOX, POPUP, windowed VIDEO/EFFECTS | host widget | box, in a per-window **top layer** above all windowless content (spec §2.8) | widget-defined |
| `visible=false` or `passThrough=true` | nothing / normally | none (`pointer-events: none`) | falls through |
| `enabled=false` | disabled art | region kept, events absorbed (no handler, no drag) | absorbed |

**Rationale.** D9 forces this. The oracle is a DOM render; two renders are pixel-identical only with the same browser, same geometry and the same text box (parity §4.1: "a text diff is a failure, not noise"). A canvas compositor rasterises text with `fillText`, which ignores `-webkit-font-smoothing: none` and differs from DOM glyph rasterisation, and it cannot interleave DOM text under its own pixels (Headspace's preset title, z 2 inside `visDrop` at z -1 inside the head, paints under the head art). A DOM tree that mirrors the scene graph also gives Reading C for free (the oracle's own structure, parity §0.6), cheap subtree moves (one `left` write per animation frame), and group opacity. The faithful alternative to a picker, an engine-side per-pixel hit walk, would give the same answer as `clip-path` but would break `elementFromPoint` and duplicate the browser's ordering logic; `clip-path` makes paint and hit share one region source.

**Evidence.** parity §0.1 rules 4-6, §0.3 (head composition), §0.6 (paint order), §4.1 (fixture); spec §2.7, §5.3-5.5; webamp §2 (clip-path hit-testing in WKWebView); `css:39-50`; `widgets:102-207`.

**Consequences.** `src/engine/render/` and `src/engine/hit/region.js` (§4.8-4.9). Engine output contains no `<img>` (no async decode races, parity I6 solved by construction). `clip-path` at zoom 1.5 anti-aliases region edges by half a device pixel; parity is checked at zoom 1 only (parity D35) and this is accepted (§8).

### D3. Image pipeline

**Position.** An own, pure-JS decode pipeline that never touches the browser's image decoders, running in a dedicated Worker in the app and directly in Node for tests.

- **Sniff by magic bytes**, never by extension (survey §3.3: Nautical's `vol_slider.bmp` is a GIF, `drawer.bmp` a JPEG).
- **BMP: own decoder** (`src/engine/image/bmp.js`, about 400 lines). Headers: BITMAPCOREHEADER (12), INFO (40), V2/V3 (52/56), V4 (108), V5 (124). Depths 1, 4, 8 (palette), 16, 24, 32. Compression BI_RGB, BI_RLE8, BI_RLE4 (all escape codes: end-of-line, end-of-bitmap, delta, absolute runs with word padding), BI_BITFIELDS, BI_ALPHABITFIELDS. Bottom-up and top-down. Rows padded to 4 bytes. Policies, fixed by spec: **16-bit BI_RGB is X1R5G5B5** (Microsoft's BITMAPINFOHEADER definition), BI_BITFIELDS masks are honoured (that is how 5-6-5 is expressed); this settles wa2 §3.1's ImageIO-vs-PIL disagreement by citing the format rather than either decoder. **32-bit BI_RGB alpha is ignored (opaque)**, as GDI does; an explicit alpha mask in BITFIELDS/V4/V5 is honoured unless every alpha is 0 (wa2 §3.1: 28 of 29 32-bit sheets are all-zero alpha). Truncated or out-of-range RLE data paints what was decoded, leaves the rest transparent, and logs one diagnostic. For 8-bit images the decoder also returns `{palette, indices}` so `hueShift`/`saturation` (8-bit BMP only, spec §6.2, §6.5) can recolour the palette and re-expand without re-decoding.
- **PNG: `fast-png@8.0.0`** (MIT) with colour-management ignored (no gAMA/iCCP application, as WMP's GDI path did not apply them), `tRNS` honoured. **GIF: `omggif@1.0.10`** (MIT), all frames decoded with disposal; phase 1 renders frame 0, phase 3 animates BUTTON `image` (spec §6.4: "including animated GIF"). **JPEG: `jpeg-js@0.4.4`** (BSD-3-Clause). Licences checked at W1.B.
- **Keying per declaration** (parity §0.1 rule 5): `transparencyColor` and `clippingColor` apply only on the element that declares them, to that element's images (for SLIDER: background, foreground and thumb, U-10 default; for BUTTONGROUP: all state images, never the `mappingImage`). Comparison is exact RGB on the decoded pixel. `Auto` = colour of pixel (0,0) of that image. A keyed pixel becomes alpha 0. PNG/GIF alpha is composited **and** keys are applied (U-27, survey §3.3: 58/195 skins combine them). The keyed result carries two regions: `paint` (alpha > 0 after keying) and `clip` (not `clippingColor`), which D2 turns into hit regions.
- **Caps.** At most 4,096 x 4,096 pixels per image and 64 megapixels decoded per session; larger images decode to nothing with a diagnostic (survey §3.3: the only image over 1500x1500 is an unreferenced 2528x3300 BMP, which fits).
- **Where it runs.** `src/engine/image/worker.js` holds the decoders; the main thread asks for `(entryName, keySpec)` and receives transferable `ArrayBuffer`s. Cache key: `sha1(entry bytes) + keySpec` (keySpec = transparency, clipping, hueShift, saturation). The session preloads every image referenced by a geometry-bearing attribute (`backgroundImage`, `image`, `mappingImage`, `thumbImage`, `positionImage`) before layout pass 2 (D5) because default sizes come from image sizes; state images (`hoverImage`, `downImage`, script-assigned `.image`) decode lazily and are cached (parity §3.7: `.image*` swaps art at runtime).

**Rationale.** Determinism is what makes the oracle comparison possible: pixels must be identical in Chrome (skinlab), WKWebView (the app) and Node (unit tests). Browser decoders apply colour management and differ between engines on 16-bit BMPs (wa2 §3.1) and on 32-bit alpha-0 sheets (a decoder that honours alpha makes them invisible). The oracle itself used PIL-decoded, colour-unmanaged pixels (`tools/convert_skin.py`), so an own decoder is also the closest reproduction of the oracle's input. RLE4/RLE8 matter: 15/195 WMP skins (survey §3.3) and 12% of Winamp bitmaps (wa2 §3.1).

**Evidence.** survey §3.3 (formats, RLE, alpha PNG, mismatched extensions), wa2 §1 item 3 and §3.1, parity §0.2 (keying census), spec §5.5, `tools/convert_skin.py`.

**Consequences.** `src/engine/image/` (§4.4). The Headspace acceptance test compares, for every non-map Headspace BMP, the engine's per-declaration keyed RGBA against the `public/skin/*.png` produced by `convert_skin.py`: alpha must match exactly and RGB must match where alpha > 0 (parity §0.2 measured that universal keying equals per-declaration keying for this skin, so equality here is a fact to assert, not hope for).

### D4. Skin loading and untrusted input

**Position.** Rust owns the archive; the engine owns everything after it.

- **`skinpack` crate** (`src-tauri/crates/skinpack`, lib + bin), used by the app and by Node tests (`cargo run -p skinpack -- pack <archive>`), so there is exactly one zip implementation. It reads the **central directory** only; for each entry it reads the local header's name and extra lengths but **does not require the local signature** (repairing the 3 distinct archives whose first local header is `01 00 01 00`, survey §1.2; SplinterCell's `.wms` is that entry). Methods: stored and deflate (`miniz_oxide`), anything else skipped with a diagnostic. CRC checked; mismatch keeps the bytes and logs.
- **Names**: `\` to `/`; strip drive letters and leading `/`; drop any entry whose path has a `..` segment; skip directories, `__MACOSX/`, `RESOURCE.FRK/`, AppleDouble `._*` (survey §1.2; wa2 §3.1). Index by **lower-cased basename** (WMP references are bare names; 341/342 archives are flat, survey §1.1; Winamp needs basename too, wa2 §1 item 2) and by lower-cased full path; **last entry in archive order wins** on collision, with a diagnostic (wa2 §1 item 2; Old_Mac-OS).
- **Caps**: archive ≤ 32 MB (corpus max 2.9 MB), ≤ 4,096 entries (max 303), entry uncompressed ≤ 32 MB, total uncompressed ≤ 128 MB, compression ratio ≤ 1,000:1 per entry (flat BMPs legitimately exceed 200:1; the absolute caps are the real guard). Exceeding a per-entry cap drops that entry; exceeding an archive cap rejects the archive.
- **Identity**: `skinId = sha256(archive bytes)`, lower hex. Prefs, sidecars, window positions and the coverage ledger key on it.
- **Storage**: `skin_import(path)` copies the archive to `$APPDATA/skins/<sha256>.<ext>` (dedupe by hash) and records `{id, name, format, importedAt}` in `$APPDATA/skins/index.json`. **Nothing is ever extracted to disk**: there is no filesystem write of an attacker-chosen name, so the traversal class does not exist. Packs are rebuilt per load (the corpus' largest pack is about 3 MB; cache later only if W1.A measures more than 50 ms).
- **Transport**: `skin_pack(id) -> Response` returns one raw binary body (`tauri::ipc::Response`, no JSON number arrays): magic `SKPK`, `u32` index length, JSON index `{ skinId, entries: [{ name, path, size, offset, crc32 }], diagnostics: [...] }`, then the concatenated entry bytes. The engine wraps it in a synchronous `SkinVFS`.
- **Engine side**: text decoding (BOM sniff; else ASCII; else cp1252 via `TextDecoder('windows-1252')`, survey §2.1, spec §8.2); **multi-`.wms` selection** by parsing every candidate: fewest unresolved file references, then stem equal to the archive stem, then larger file (survey §1.2, U-17); implicit `<stem>.js` autoload (wmploc §7.3).
- **Untrusted script I/O**: the realm has no network, no filesystem, no DOM. `res://` resolves only through the built-in table (wmploc §7.2-7.7). `player.URL` writes, `player.launchURL`, `theme.openDialog` are host policies (D6), default deny with a ledger entry.

**Rationale.** Zip is the untrusted boundary (notan Q3: "every skin is untrusted input, including the zip layer"); Rust is the safer place for it, and a single implementation used by both the app and the tests means the corpus robustness test exercises the production code. Not extracting removes the most common archive vulnerability outright; notan suggested extraction to `appdata/skins/<sha256>/`, which this design declines for that reason. The engine still gets synchronous access to bytes, which the load pipeline and `.image` swaps from script need.

**Evidence.** survey §1.1-1.2, §3.2 (case mismatches in 62/195 skins, missing refs in 46/195), G7, G8; wa2 §1 item 2, §4.1; notan Q3.

**Consequences.** `src-tauri/crates/skinpack`, `src-tauri/src/skins.rs`, `src/engine/vfs/` (§4.3). The Tauri capability for skin windows gains `skin_*` commands.

### D5. Parse, layout and bindings

**Position.**

*Scanner.* A hand-written tolerant tokenizer (`src/engine/wms/scanner.js`), never an XML parser (survey §2.4, spec §8.3-8.4):
1. Decode text (D4). Skip comments, `<?...?>`, leading whitespace.
2. Tag and attribute names are case-folded. Attributes are `name\s*=\s*("..."|'...')`, separated by optional whitespace (accepts `a="1"b="2"`, tabs around `=`). Values are entity-decoded (5 named entities plus numeric) before anything else sees them (survey §2.3).
3. **Duplicate attributes, including case-variant duplicates: last wins**, with a diagnostic (U-5; survey §2.2: in every sampled conflict the second value is the author's intent, `e-monee.wms:261,269` `max="100"` then `max="wmpprop:..."`). Attribute order is kept for diagnostics only.
4. End tags pop to the nearest case-insensitive match; an unmatched end tag is ignored; self-closing and open/close pairs are equivalent; text content is ignored; parsing stops at the first close of the root THEME (survey G5).
5. Unknown tags become generic elements in the tree (they can carry ids and handlers, e.g. undocumented `<network>`, `<currentMedia>` under PLAYER, spec §6.19); unknown attributes are kept but ignored by behaviour (G12).

*Attribute value classes* (parsed once per attribute): literal; `jscript:` (prefix case-insensitive, leading whitespace allowed); `wmpprop:`; `wmpenabled:`; `wmpdisabled:`; `res://` (resolved at parse for string-typed attributes, wmploc §7.7); typo prefixes (`wmppprop:`, `wmpenable:`, spec G14) are literal strings plus a diagnostic. Handler attributes (`on*`, `*_onchange`, PLAYER bare event names, `<controls currentPosition_onchange>`) are never classified; they compile as script (D1).

*Coercion* (spec §2.4, §3.1, U-20, U-22): numbers trimmed (`width="600 "`), booleans `true/false/1/0` case-insensitive, anything else invalid keeps the previous value; colours `#RRGGBB`, `#RGB` (U-29), the 140 IE names, `none`, `Auto`; script assignment coerces to the attribute's type (`player.settings.mute='false'` is false).

*Two-pass layout* (spec §2.1 step 4, §3.2, U-3):
- Pass 1: create every element in document order with literal values and predefined-tag defaults (G23: PLAYBUTTON, STOPELEMENT, VOLUMESLIDER... are generic elements plus a defaults table); preload geometry images (D3) so default sizes from images are known.
- Pass 2: evaluate every `jscript:` attribute **once, in document order**, in the realm with the element scope. An attribute not yet evaluated reads as its default (0 for numbers), which reproduces 9SeriesDefault's legal forward read of a literal (`svMain.width` reads `svStub.width` = 263, declared 816 lines later) and QuickSilver's order-dependent descendant read.
- **No re-evaluation.** `jscript:` values are never re-run on dependency changes. Resize is handled by **alignment anchoring**: after pass 2, each element records its margins against its parent; when the parent resizes (a `view.width` write, a SUBVIEW `moveSizeTo`), `horizontalAlignment` `right` keeps the right margin, `center` keeps the centre offset, `stretch` keeps both margins and changes `width` (likewise vertically), `left`/`top` keep the origin (spec §5.1). WMP 11 `right`/`bottom` are anchors of the same kind.
- This resolves the docs conflict: survey G13 says expressions "must re-evaluate when a dependency changes"; spec §3.2 says once. The corpus decides it: `left="jscript:view.width-N"` co-occurs with `horizontalAlignment="right"` in 2,773 of 2,791 cases, `top` with `verticalAlignment="bottom"` 2,602 times, `width="jscript:view.width"` with `stretch` 550 times. Authors used the expression for the initial position and the alignment attribute to keep it; a live expression would make the alignment redundant. Liveness, where authors wanted it, is spelled `wmpprop:` (e.g. `top="wmpprop:svEqualizerBottomMiddle.top"`, spec §3.3).

*Bindings.*
- `wmpprop:` path grammar: `segment ('.' segment)*`, `segment = ident | ident '(' literal (',' literal)* ')'`. The root resolves case-insensitively against host globals, then the VIEW's element ids (`mySlider.value`, `visEffects.currentPresetTitle`, `eq.gainLevel3`). Call segments with literal arguments are allowed (the predefined REPEATBUTTON binds `down="wmpprop:player.settings.getMode('loop')"`, spec §3.3). The binding subscribes to change notifications of every object on the path and re-resolves when an intermediate object is replaced (`currentMedia` on song change). An unresolvable path leaves the attribute at its default and logs once to the ledger.
- `wmpenabled:X` / `wmpdisabled:X`: take the last path segment, drop `()` and `;`, case-fold, evaluate `player.controls.isAvailable(name)` (negated for `wmpdisabled`), on **any** boolean attribute (U-4; spec §3.4: `visible` 287 uses, `enabled` 132, `tabStop` 46, `down` 3). Re-evaluated on play-state, open-state, queue and position-capability changes.
- One-way. Writing a bound attribute from script or user input overrides the value until the next source change (spec §3.3).
- **Settle and `_onchange`.** After pass 2, bindings are settled in document order. Every attribute value change, from any origin (script, user, binding, initial settle), fires `<attr>_onchange` if the value actually changed (spec §2.3; `attribute-onchange`). Re-entrancy guard: a write of an equal value is a no-op (no event); a cascade deeper than 8 is cut with a diagnostic; this breaks VOLUMESLIDER's `value` → `value_onchange` → `player.settings.volume=value` → binding loop (spec §6.7 consequence 1).
- **Drag suspension**: while the user drags a SLIDER or CUSTOMSLIDER, binding updates to its `value` are held (latest wins) and applied at drag end (parity D18; spec U-19).
- **Position tick**: `player.controls.currentPosition` changes are published at frame rate to host-side bindings (the oracle's smooth seek thumb, `main:462-468`), but realm-side listeners (`currentPosition_onchange`, a bound `value_onchange`) are coalesced to at most 10 Hz (U-19 says WMP's rate is unknown; 10 Hz bounds realm cost for the 176 `<controls>` listeners).

*Stacking* (the docs-vs-Headspace conflict). The docs say "the z index of a VIEW or SUBVIEW is an absolute index, while the z index of a control is relative to the VIEW or SUBVIEW that contains it". Headspace contradicts the "absolute" half for nested subviews: only Reading C (each SUBVIEW is a stacking context; its children, controls and nested subviews alike, sort by z relative to its background at 0, then document order; only VIEW-level SUBVIEWs carry an absolute z relative to the VIEW background) reproduces state 1 (parity §0.1 rule 4 works all three readings; spec §5.3 independently observes `visDrop`'s z 2 text painting under the head). Position: Reading C, behind a switch `stacking: 'context'|'additive'` for future evidence. Equal z: later in document order on top (U-1). BUTTONELEMENTs use their group's z. Windowed controls render in the per-window top layer (D2).

*SUBVIEW clipping.* A SUBVIEW with a non-zero size (explicit or from its background) clips its subtree to its bounds (spec §5.1 width: "the image cannot grow beyond its parent VIEW or SUBVIEW"); a zero-size SUBVIEW (no size, no background) does **not** clip, because literal docs would make such containers invisible and the corpus uses size-less grouping subviews (counted by the W4.E sweep; §8 risk). Its `clippingColor`/`clippingImage` region clips the whole subtree (parity D26), its `transparencyColor` does not (negative-z children must show through the hole).

**Evidence.** survey §2.2-2.4, G1-G5, G12-G14; spec §2.1, §3.1-3.4, §5.1, §5.3, §8.3-8.4, §9.1, U-1..U-5, U-19, U-20; parity §0.1 rule 4, §0.4.

**Consequences.** `src/engine/wms/`, `src/engine/model/{layout,bindings}.js` (§4.5, §4.7). The layout acceptance test is parity §0.4 and §0.5 reproduced exactly, including `reset.top = 127`.

### D6. Object model

**Position.** All host objects are host-side JavaScript classes generated from one **schema** (`src/engine/objects/schema.js`): for each object or element type, members with `{name, kind: 'prop'|'method'|'event', type, access, status: 'real'|'emulated'|'stub'|'unsupported', since}`. The realm sees them only through the D1 membrane, with case-insensitive member lookup (spec §2.2; survey §3.1: 1,700 non-majority spellings in 182/195 skins). Writes go to the host object, which applies them optimistically and asynchronously forwards commands; reads are always synchronous from in-memory state.

| Object | Implementation (phase 1) | MPD / host mapping |
|---|---|---|
| `player` | real | `playState`, `openState` as **integers** (81 skins compare to numeric literals, survey §5.3) per wmploc §7.5: play → 3/13, pause → 2/13, stop with a current song → 1/13, empty queue → 0/0. `status` synthesised ("Playing", "Paused", "Stopped", "Ready", "Connecting..."; U-32). `URL` read = current song URI; write = policy (default deny + ledger). `launchURL` = policy (default deny + ledger; setting to allow http(s) via the system browser after confirmation). `fullScreen` false. `versionInfo` "11.0.5721.5145". |
| `player.controls` | real | `play()` (`play` or `pause 0`), `pause()`, `stop()`, `next()`, `previous()`, `currentPosition` get (extrapolated, `player:92-97`) / set (`seekcur`), `currentPositionString` (`m:ss`, `h:mm:ss` from an hour, spec §7.2), `isAvailable(name)` with the **phase-1 table pinned to the oracle** (parity D16: `stop` iff not stopped; `pause` iff playing; `play`, `next`, `previous` always; `currentPosition` iff duration > 0; `fastForward`/`fastReverse` never). `fastForward/fastReverse/step` stubs. |
| `player.settings` | real/emulated | `volume` (`setvol`; MPD volume −1 reads 0 and writes are dropped), `mute` (**emulated**: remember the level, `setvol 0`; unmute restores; no-op without a mixer), `balance` (Rust `set_balance`, persisted host pref, D17 detent as a host binding rule), `getMode/setMode('loop'|'shuffle')` → MPD `repeat`/`random`, `autoRewind`/`showFrame` stored, `rate` 1, `autoStart` true. |
| `player.currentMedia` | real | `name` (Title, else Name, else file stem, `player:28-31`), `duration`, `durationString`, `sourceURL` (file), `imageSourceWidth/Height` 0 (audio-only, so `Init` calls `EndVideo()`, parity D19), `getItemInfo(key)` with a key map (`Author`/`Artist` → Artist, `Title`, `Album`/`WM/AlbumTitle`, `WM/TrackNumber` → Track, `Genre`, `Bitrate` → status bitrate × 1000, `FileSize` "", `Type` "audio"), `setItemInfo` stub. |
| `player.currentPlaylist` | real | `count`, `name` "Now Playing", `item(i)` → media object, `getItemInfo`. |
| `player.network` | emulated | `downloadProgress` 100, `bufferingProgress` 100, `bitRate`/`bandwidth` from status. |
| `player.mediaCollection`, `playlistCollection`, `cdromCollection`, `dvd`, `newPlaylist` | stub | type-correct inert values, ledger. |
| `theme` | real | `savePreference(k, v)` / `loadPreference(k)` on the per-skin store; **unset key returns `"--"`** (survey §5.3 and G20: 83 of 94 preference-using skins test `"--" != x`; spec U-16 suggested `""`, but the corpus behaviour decides it, since `""` would make those skins parse `""` as a stored value); `openView/openViewRelative/closeView/currentViewID` (phase 1: main view only, others ledger + no-op; phase 3 satellites, D7); `openDialog` → `""`; `playSound` stub (phase 3); `logString` → host log; `loadString` → string table (wmploc §7.7); `showErrorDialog` no-op; `author`, `title`, `copyright` from THEME. |
| `view` | real | `width`/`height` read/write (D7), `close()`, `minimize()`, `maximize()`/`restore()` stubs, `returnToMediaCenter()` → host action table (default: zoom toggle, parity D3), `size(handle)` (phase 3), `timerInterval`, `focusObjectID`, `title`, ambient attributes and `moveTo`/`alphaBlendTo`/... (spec §5.2: VIEW animations move or fade the window, phase 3). |
| `event` | real | populated per dispatch (spec §5.7): `x,y,clientX,clientY` in VIEW pixels, `offsetX/Y`, `screenX/Y`, `screenWidth/Height`, `button` bitmask, `keyCode` (Windows virtual-key codes mapped from `KeyboardEvent.code`), modifiers, `srcElement`, `fromElement`, `toElement`. Valid only during a handler. |
| `mediacenter` | emulated | persistent key/value object with change events (U-14), stored in the **host-global** prefs namespace (shared across skins, as WMP full mode was): `effectType`, `effectPreset`, `videoZoom`, `videoStretchToFit`, `videoShrinkToFit`, `showTitles`, `showEffects`, `contrastMode`. Seeded from the legacy `localStorage.preset` once at first engine run. |
| EQUALIZERSETTINGS (`eq`) | real | `gainLevel1..10` (dB, D11), `gainLevels(i)`, `bands` 10, `bypass` (host pref `eqEnabled`, default **enabled**: WMP's documented default `bypass=true` is a full-mode user state that skins never set; the oracle's EQ is always live), `reset()`, `currentPreset`/`presetCount`/`presetTitle` (one preset "Custom" in phase 1), `enableSplineTension` stored (no algorithm known: `unsupported`, parity D24), SRS/normalisation members stubs. |
| VIDEOSETTINGS | stub | KV store with change events. |
| EFFECTS (`visEffects`) | real (host) | `currentEffectType` (constant `"window_headMPD"`), `currentEffectTitle`, `currentPreset` ↔ Viz index, `currentPresetTitle`, `currentEffectPresetCount`, `effectCount` 1, `next()`/`previous()` (wrap, `viz:77-85`), `nextPreset/previousPreset`, `nextEffect/previousEffect` (single effect: step presets), `fullScreen` false, `settings()` no-op. |
| VIDEO | stub | never starts; `onvideostart`/`onvideoend` never fire (parity D19). |
| PLAYLIST | real (host widget) | `visible`, colours, `columns`, `columnsVisible`, `dropDownVisible`, `playlistItemsVisible`; `setColumnResizeMode`/`setColumnWidth` stored; selection methods phase 3. |
| wmploc | real | #132 constants (seeded before scripts, plus `osOpeningUnknownURL` behind `extras`), #169 `sprintf` family, #134/#136 constants, 47-id string table re-authored (wmploc §7.4-7.7). |

Element objects: every ambient attribute (spec §5.1) as typed properties, ambient methods (`moveTo`, `slideTo`, `moveSizeTo`, `alphaBlendTo`), element-type methods (`buttongroup.click(i)`, `getButton(i)`, `effects.next()`), `elementType`, and the documented read-only values (`textWidth`, `buttonCount`, `index`). Unnamed elements get the documented id `Unnamed_<elementtype>_<n>`, numbered in document order across the THEME (spec §5.1), which also gives the shell and the demo a WMP-defined address for id-less elements (parity §3.1: `visNext`, `reset`).

`MediaModel` (the MPD seam) is an interface the host supplies (D8 §4.2): a synchronous snapshot (`state`, `song`, `queue`, `status`, `volume`, `elapsed()`), commands returning promises, and change events. The shell implements it over `src/player.js` unchanged; skinlab implements it with fixtures.

**Coverage ledger.** Any access to a `stub` or `unsupported` member, or a binding/`res://` that does not resolve, logs once per `(skinId, apiPath)` to `HostAdapter.ledger`. The corpus sweep aggregates it into `docs/coverage/ledger.csv` (API names and counts only: facts about art, not art). A static demand scanner (`tools/api-demand.mjs`) ranks object-model call sites over the corpus into `docs/coverage/api-demand.csv`, and stubs are promoted to real in rank order (notan Q3 process items, adopted).

**Rationale.** Synchronous reads are part of WMP's contract (the script reads `sEqEar.top` and `player.OpenState` inline), so every value must be readable without awaiting MPD; optimistic writes keep `player.settings.volume = 50; x = player.settings.volume` consistent. A schema-driven model makes case-insensitivity, the membrane's `has`, the stub generator and the ledger one table instead of four.

**Evidence.** parity §3.7 (Headspace's host surface), spec §4, §6, §7, survey §5.3-5.4, wmploc §7.

**Consequences.** `src/engine/objects/` (§4.6); `src/shell/media-mpd.js` adapts `player.js`.

### D7. Windows

**Position.**

- **`SkinWindow`** is the only window abstraction the engine knows (§4.2): a surface with a root element, size, position, drag, minimise, close, always-on-top, a hit mask, capture, and a `binding` property (`'os-window' | 'internal'`) that the engine never branches on.
- **WMP VIEWs bind to real Tauri WebviewWindows**, one view per webview, each webview running **its own engine instance for its own VIEW**: the per-webview JS context gives WMP's per-view script scope for free (notan Q1(b); spec §2.1 step 7: views share state only through preferences; survey §5.3: views are independent top-level units with their own `onLoad`/`onClose`). Cross-view channels are exactly the ones WMP has: `theme.savePreference/loadPreference` (Rust prefs store, write-through with an `prefs-changed` broadcast; each engine keeps a synchronous cache, and `theme.openView` flushes pending writes before asking Rust to open the window, so the new view's `onload` reads them), `theme.openView/closeView/currentViewID` (Rust window factory), and the shared player (MPD idle events already broadcast to every webview; EQ and balance via `get_eq` plus an `eq-changed` event).
- Phase 1 runs only the main view (Headspace has one); the factory, the per-window clickthrough and the capability set are built in phase 1 so phase 3 only adds satellites.
- **Rejected for WMP: one compositor window** holding all views (the Webamp model). It breaks per-view Keep-on-Top (native WMP semantics, and the existing per-window menu, `main:484-535`), Spaces and multi-display placement, and needs a screen-sized transparent window. It is the right binding for the Webamp cluster (phase 2), where docking math needs one coordinate space; that is why `binding` is a property, not a type.
- **`view.width` / `view.height` writes are honoured** (fidelity; spec §6.2: `resizable` gates user resizing only, script resizing is always allowed; survey G21(f)). The host resizes the OS window anchored at its top-left (`setSize(w*zoom, h*zoom)`), the engine re-anchors children (D5), the mask is rebuilt. For Headspace this means 760 → 549 after a playlist close and back to 760 on open (`hs.js:16-17,96,130`). This **changes the parity contract's recorded D13 decision** ("Phase 1 ignores"), deliberately: it is pixel-neutral for the four states (state 1 at boot is 760 wide because `Init` never sets the width; after a playlist cycle it is 549, and the oracle's columns 549..759 are fully transparent and click-through in state 1, mask bbox x1 = 548, parity §4.1), and the harness compares the union rect treating pixels outside the engine window as transparent. A switch `honourViewResize` (default true) restores D13 if the owner prefers it. Window growth leftwards would need `set-position` (parity §3.3); phase 1 never grows leftwards.
- **`startDrag`**: a press on a chrome pixel (D2 table) calls `SkinWindow.startDrag()` (Tauri `startDragging`), exactly as `draggable()` did (`main:42-48`), but now for every unclaimed skin pixel (parity D29, an intended reviewed deviation).
- **Persistence**: window position per `(skinId, viewId)`, restored main-first, clamped to the visible frame of some display (notan Q1(e)).
- **Per-window clickthrough** (`clickthrough.rs`, notan Q1(a)): `HitState { masks: Mutex<HashMap<String, Mask>>, capture: Mutex<Option<String>> }` keyed by window label; `set_hit_mask` and `set_capture` take the caller's `WebviewWindow` from Tauri's command context, so the JS API is unchanged and a page cannot set another window's mask. The poll loop evaluates every registered window: `ignore = capture != Some(label) && !mask.hit(cursor - origin)`. Each window decides independently, which is correct for overlapping skin windows because each ignores only where it has no skin. Poll interval 16 ms, dropping to 8 ms while any two registered frames intersect (notan). The current global `AtomicBool` capture, which makes *every* window clickable during any drag, goes away. Masks also accept a regions form for phase 2 (`HitMask = bits | regions`).

**Evidence.** spec §2.1, §6.1-6.2, §7.3; survey §1.1 (views per skin: 1 view 93, up to 9), §5.3-5.4, G21; notan Q1; parity D13, §3.3, §3.5; `click:45-77`.

**Consequences.** `src/engine/session.js` (view lifecycle), `src/shell/windows.js`, `src-tauri/src/{clickthrough,windows,prefs}.rs`, capability `skin-*` window labels.

### D8. Engine/host boundary

**Position.** `src/engine/**` is a Tauri-free package. It may import only its own files and the allow-listed npm packages (`quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync`, `fast-png`, `omggif`, `jpeg-js`). It must not import `@tauri-apps/*`, `three`, `src/viz/**`, `src/shell/**`, `src/player.js`. `tools/check-engine-boundary.mjs` scans static and dynamic imports and fails `npm test`. The engine talks to the world only through `HostAdapter` (§4.2): surfaces (window factory), input capture, clock and frame scheduler, prefs (sync cache), skin VFS, `MediaModel`, audio frames, palette snapshot, effects surfaces, host widgets, host actions and policies, log and ledger.

Adapters: **`SkinlabAdapter`** (browser page in the harness: frozen clock, fixture media, in-memory prefs, masks recorded, effects stubbed) is built **first** (W3/W4.A), before **`TauriAdapter`** (W4.B) grows features, so the seam is proven rather than aspirational (notan Q3(2)). A thin **`NodeAdapter`** (no DOM) runs parser, layout, binding, object-model and realm tests under `node --test`.

**Rationale.** Views are created and destroyed at runtime with script-computed geometry, so the interpreter can never talk to Tauri directly anyway (notan Q1); the boundary also makes the oracle comparison a property of the engine rather than of the app.

**Consequences.** §4.2 is the contract every wave codes against; W0.1 freezes it as `src/engine/types.d.ts`.

### D9. Oracle and tests

**Position.** A `skinlab` harness (`skinlab/`, dev-only) driving a **pinned Playwright Chromium** (`playwright-core@1.63.0`, browser installed with `npx playwright install chromium` at that version; the browser revision is recorded in every golden's provenance; system Chrome is never used for goldens). macOS host (Tahoma is a system font there; `-webkit-font-smoothing` is honoured on macOS only). An **advisory** second run in Playwright WebKit flags engine-vs-WebKit divergences; a W4 Opus task checks the real WKWebView once (§7, gate G1).

Two capture paths, kept visibly separate:
- **Legacy capture** (`skinlab/legacy.html`): the hand port served by Vite with the parity §4.1 Tauri stub (`window.__TAURI_INTERNALS__` with canned `invoke` results, `set_*` recorded) and a **viz stub** aliased over `src/viz/index.js` (same API, five preset titles, draws nothing, no WebGL). `localStorage` seeded per parity §4.1 (`eq` zeros, `balance` 0, `preset` = 1 Chorus).
- **Engine capture** (`skinlab/engine.html`): the engine under `SkinlabAdapter`, no Tauri stub, same viz stub mounted by the adapter's effects surface, prefs seeded to the same values (`mediacenter.effectPreset = 1`, so state 4's title reads "Chorus").

Fixture: viewport 760x394 + margin, `deviceScaleFactor` 1 and 2, pointer parked off the window, page clock frozen (`page.clock.install`, stepped with `runFor`; it fakes `Date`, timers, `requestAnimationFrame`, `performance.now`). The legacy's CSS transitions run on real time, so legacy setup waits for `transitionend` + 200 ms (parity §4.1); the engine is stepped 200 ms on the fake clock. Engine state setup runs **the skin's own code**: S2 = `ToggleEqView()` called in the realm, and a second variant S2b = an injected press/release at `bEqHandle`'s centre; both must produce identical captures.

States: **S1** closed, **S2** EQ open, **S3** playlist open (5 rows; S3b 12 rows for the scrollbar), **S4** vis chooser open, each at DPR 1 and 2. Supplemental (parity §4.6): **S5.x** hover and down per transport/min-close element and per button, **S6** playing (pause button over play), **S7** mid-animation at 60 ms (sanity, tolerant), **S8** press-and-release outside the window (D30; Tauri only, Opus/owner manual).

Artifacts per state: PNG of each SkinWindow rect, mask bits, a stacking dump. **Goldens are content-addressed and never committed** (a Headspace render is Microsoft art): files live in `~/.cache/window_headmpd/skinlab/<sha256>.{png,bits}`; the committed `skinlab/goldens.manifest.json` records per state `{state, dpr, png_sha256, mask_sha256, popcount, bbox, provenance: {chromium_revision, playwright, flags, oracle_pins (the parity pin list of file sha1s), headspace_wmz_sha1, date}}`. `npm run skinlab -- bless legacy` (re)generates goldens and refuses if the oracle pins differ from the manifest unless `--repin`; `npm run skinlab -- verify legacy` re-renders and checks hashes (determinism gate, run twice in W0.3).

Diff (`npm run skinlab -- diff --config faithful|compat --states S1,S2,S3,S4 --dpr 1,2`):
- Per SkinWindow, over the union of the golden and engine rects, pixels outside the engine window count as transparent (D7). RGBA exact, compared premultiplied (two alpha-0 pixels are equal). **Excluded**: the effects hole, i.e. the magenta pixels of `head.bmp` offset by (261,0), computed from the pack at run time (31,487 px, parity §4.1).
- **Allow-list** `skinlab/allowlist/headspace.json`, typed entries, each with a declared bound: `rect` (D20 reset `(222,221)-(258,238)` state S2; D21 preset title `(321,65)-(426,82)` state S4); `pixelset` from a named generator, one entry per group with its own bound (`buttongroupUnowned(<transport group>)` bound 811, `buttongroupUnowned(<min/close group>)` bound 1: the unowned group pixels whose up-layer differs from what lies beneath, U-23, spec §6.5); `sliderTravel` with bound **0** in S1-S4 (asserts the f = 0.5 coincidence of D2 stays true); mask entries `screenCorners` (106 px, parity D11) and `buttonTransparencyBoxes` (button-box pixels over transparent background that the docs make clickable and the oracle's alpha mask does not; computed, bound recorded in W4.A).
- Failure if any differing pixel lies outside excluded ∪ allow-list, **or** any allow-list entry's actual count exceeds its bound (drift guard), **or** `compat` shows any pixel diff at all outside the hole.
- Report JSON + diff PNGs to `skinlab/out/` (gitignored).

Unit tests: `node --test tests/**` with **synthetic, own-authored fixtures committed** under `tests/fixtures/` (mini `.wms`/`.js` skins and a BMP generator `tests/fixtures/gen-bmp.mjs` that writes every depth and compression from pixel arrays). Corpus and Headspace tests are tagged and auto-skip with a message when `skins/wmp` or `HEADSPACE_WMZ` (default `~/Downloads/Headspace.wmz`) is absent. DOM-level control tests run in skinlab against synthetic fixture skins with expected pixels computed by the test from fixture data, not from art.

How a Sonnet implementer self-checks: every task in §7 names one command that must exit 0 (`npm test -- <glob>`, `npm run test:corpus -- <area>`, `npm run skinlab -- diff ...`, `cargo test -p <crate>`); the report JSON says which entry failed and where.

**Evidence.** parity §0.1 rules 6-8, §2 (D1-D35), §4; notan Q1 (oracle as skin-space rasterisation per SkinWindow), Q3 (content-addressed goldens, provenance, explicit re-bless); webamp appendix (Chromium and WKWebView agreed on probe 1).

### D10. App features around any skin

**Position.** Everything the oracle does that the `.wms` does not (parity §2 class (b)) becomes a **shell feature** in `src/shell/`, attached through `HostAdapter` hooks and the engine's inspector, never through DOM ids, so it works for any skin.

- **Window menu** (right-click, Control-click, Option-click; `main:484-535`): a right-button press is first dispatched to the skin (`event.button = 2`); if the hit element has no mouse handler, the host menu opens. Option-click stays a capture-phase host shortcut. Items: Keep on Top (per window), Show on All Desktops, size (1x/1.5x/2x), Use skin engine / legacy (until cutover), Reload skin, Skins... (phase 2 switcher).
- **Zoom**: CSS `transform: scale(z)` on the window root, `setSize`, mask `zoom`, Viz pixel ratio (`main:362-373`); parity checked at 1 only.
- **Overlays** (now-playing toast D4, notice D5, caption D6): a host overlay layer mounted **inside the EFFECTS element's node**, above its canvas, so the ancestor subview clip region applies (parity D26). Geometry from the oracle CSS relative to the effects box. Skins with no EFFECTS: no toast; the notice moves to the window menu's first item.
- **Keyboard**: focused element's `onkeydown`/`onkeypress`/`onkeyup`, then the VIEW's, then host defaults (Space, arrows, V) **only without modifiers** and never `setvol` when MPD volume is −1 (fixes parity D9 slips).
- **Effects and palette**: `HostAdapter.effects.mount(ref, canvas, {width, height})` → the shell creates `new Viz(canvas, onPresetChange, captionEl, {width, height})` (one small change to `viz/index.js`: size from options instead of the 216x158 constants, `viz:13-14`). `visEffects` delegates to it (D6). A click on an EFFECTS element without `onclick` steps the preset (parity D25, host). Palette per D12.
- **Host widgets**: PLAYLIST → `buildPlaylist(slotEl, attrs)` generalised from `playlist.js` with the honoured attributes (parity D12); EDITBOX/LISTBOX/POPUP/AUTOMENU in phase 3.
- **Demo tour**: `demo.js` is split into a generic driver and a per-skin choreography (`src/shell/demo/headspace.js`). The driver takes a `DemoTarget` built on the engine inspector: `rectOf(ref)`, `elementPoint(groupRef, mappingColor)` (centroid of owned pixels, replacing the 37/144 and 131/144 fractions), `sliderThumbPoint(ref, value)` (replacing `5.5 + (1-f)*65`, which hardcodes the oracle travel), `call(fnName)`, `get(varName)` (to read `eqIsOpen`), `skinRoot`, `zoom()`. Refs are ids or `Unnamed_*` ids (D6). Synthetic pointer events still go to `document.elementFromPoint`, which resolves to control nodes thanks to D2.
- **Coexistence**: `index.html` loads `src/boot.js`, which imports `main.js` (legacy) or `shell/shell.js` (engine) from `localStorage.engine` / `?engine=`; default `legacy` until cutover. Both use the same Rust backend; every Rust change is additive.
- **Cutover criteria** (all required): (1) `skinlab diff` passes S1-S4 at DPR 1 and 2 in both configs, S5-S6 in `faithful`; (2) the same render in the real WKWebView matches the skinlab engine render (Opus G1 check); (3) the demo tour completes on the engine with the recording identical in timing (±1 frame) to the legacy run; (4) S8 capture test passes in the app; (5) owner dogfoods the engine as default for 3 days with no realm fault and no stuck capture; (6) idle CPU and memory within 120% of legacy; (7) no `jscript:`/binding/ledger entries for Headspace other than the documented stubs. Then the legacy code moves to `skinlab/oracle/legacy/` (still runnable by the harness, pinned by sha1) and `convert_skin.py` shrinks to the icon step.

### D11. Audio-side changes

**Position** (all additive; the legacy keeps calling the old forms):

```rust
// eq.rs
pub struct EqProfile { pub centres: Vec<f32>, pub q: f32, pub min_db: f32, pub max_db: f32, pub has_preamp: bool }
pub const WMP: EqProfile    // centres 31,62,125,250,500,1k,2k,4k,8k,16k (eq.rs:7-9), Q 1.41, ±20 dB (spec §6.16 "normally -20 to +20", U-22)
pub const WINAMP: EqProfile // 60,170,310,600,1k,3k,6k,12k,14k,16k (webamp §1.6), ±12 dB, preamp
impl Eq { fn set_profile(&mut self, p: &EqProfile); fn set_gains(&mut self, g: &[f32]); fn set_preamp_db(&mut self, db: f32); fn set_bypass(&mut self, on: bool); fn state(&self) -> EqState }

// lib.rs commands
set_eq_profile(profile: "wmp" | "winamp")          // phase 1 uses "wmp"
set_eq(gains: Vec<f32>)                              // accepts the legacy [f32;10]
set_eq_preamp(db: f32); set_eq_bypass(on: bool)
get_eq() -> EqState { profile, gains, preamp_db, bypass, balance }   // + event "eq-changed" to all webviews
audio_subscribe(on_frame: Channel<Frame>, opts: Option<SubscribeOpts { pcm: bool }>) -> u32
audio_unsubscribe(id: u32)

// audio.rs
pub struct Frame { pub bands: Vec<f32>, pub wave: Vec<f32>, pub level: f32,
                   #[serde(skip_serializing_if = "Option::is_none")] pub pcm: Option<Vec<u8>> } // 1024 u8 centred on 128, mono (L=R)
subscribers: Mutex<Vec<(u32, Channel<Frame>, bool /*pcm*/)>>                                  // drop on send error
```

The WMP profile widens the clamp from ±14 to ±20 dB: the skin's slider range (Headspace −14..14) still bounds what the user can send, and other skins use the documented range. `bypass` is driven by the host pref (D6 `eq`). `pcm` is computed only when some subscriber asked for it (phase 2, Webamp's analyser and butterchurn facade, webamp §1.5: 1024 bytes at 60 Hz = 61 KB/s). Fan-out fixes the "second `Viz` steals the feed" defect (parity §3.2; `audio.rs:85-87`) and serves several EFFECTS and several views.

### D12. Phase-2 seam

**Position.**

```ts
interface SkinHost {
  readonly kind: 'wmp' | 'webamp' | 'native';
  load(vfs: SkinVFS, ctx: HostContext): Promise<void>;   // parse, decode, script load (WMP) / setSkinFromUrl (Webamp)
  initialWindows(): SkinWindowSpec[];                     // WMP: main VIEW; Webamp: one 'os-window' holding internal main/eq/playlist
  attach(win: SkinWindow): Promise<void>;
  applyCommand(cmd: HostCommand): void;                   // global hotkeys, menu actions
  inspector(): SkinInspector;                             // demo and tests
  unload(reason: 'switch' | 'close' | 'fault'): Promise<void>;
}
// The shell picks the host by sniffing the pack: a .wms → WmpHost; main.bmp (any case, any dir) → WebampHost.
```

Both hosts consume the **same `MediaModel`** (written once over MPD), the same `SkinWindow` factory (WMP: one OS window per VIEW; Webamp: one OS window, `internal` SkinWindows, mask as `regions` from Webamp's window rects and `REGION.TXT` polygons, webamp §2), the same audio fan-out and EQ profiles (D11). The Webamp-specific adapter (media class with echo guards, queue mirror via `__initialState` + `plchanges`, `__customMiddlewares`, duck-typed analyser, butterchurn facade) lives in `src/shell/hosts/webamp/`, outside the engine.

**PaletteService** lives in the shell, not the engine: WMP skins have no palette concept; it feeds the host visualizer (and in phase 2 optional Webamp viscolor mapping). Shape (notan Q2): `{ source: 'artifact'|'local'|'default', association: 'current-uri'|'retained'|'default', track: {uri, generatedAt}|null, roles: <the nine notan-palette/1 keys>|null, guarantees: [] , clusters: [{hex, share, oklch}], lerp(a, b, t) }`. **Phase 1** builds the interface and the `local` tier by wrapping the existing `palette` command (`lib.rs` k-means), with `roles: null` and `guarantees: []` (never partially filled, never inferred), so the viz consumes one interface from day one and behaviour is unchanged. **Phase 3** adds the `artifact` tier (notan-palette/1 consumer: retention triple, Rust-side parent-dir watch, `MUSIC_UI_PALETTE_PATH`, reattach back-off, one adoption per song change), because it is independent of either skin engine and its contract owner offered review then.

---

## 3. Architecture and data flow

```
                 ┌──────────────────────────── Rust (src-tauri) ────────────────────────────┐
 archive ──────► │ skinpack (crate): central dir, repair, caps, flat index, sha256            │
                 │ skins.rs: import/list/pack   prefs.rs: per-skin + global KV, broadcast     │
 MPD ◄─────────► │ mpd.rs / idle loop (mpd-idle, mpd-connection, mpd-message events)          │
 FIFO ─────────► │ audio.rs: EQ(profile) → speaker; FFT → Frame{bands,wave,level,pcm?} fan-out│
 cursor poll ──► │ clickthrough.rs: masks[label], capture: Option<label>                      │
                 │ windows.rs: SkinWindow factory (WebviewWindowBuilder, ?view=<id>)          │
                 └───────────▲───────────────────────────▲──────────────────────────▲─────────┘
                             │ invoke/events (raw bodies)│                          │
 ┌─ webview (one per OS window) ──────────────────────────────────────────────────────────────┐
 │ src/boot.js → legacy main.js  |  shell/shell.js                                             │
 │ shell/ (Tauri-aware): TauriAdapter, media-mpd (player.js), window menu, zoom, keyboard,     │
 │        overlays, effects-host (Viz), playlist widget, palette-service, demo                 │
 │            │ HostAdapter (§4.2)                                                             │
 │ engine/ (Tauri-free): Session → VFS → wms parse → model (scene, layout, bindings, anim)     │
 │                       → realm (QuickJS, one context per VIEW) ↔ objects (schema membrane)   │
 │                       → render/dom (nodes, canvases, text) → hit/region (clip-path, mask)   │
 │                       image/worker (decode + key)                                           │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Load pipeline** (`Session.open(skinId, viewId?)`): `host.skins.open(id)` → `SkinVFS` → select `.wms` (D4) → decode text → scan → tree → pass 1 (elements, literals, tag defaults) → preload geometry images in the worker → create realm context for the VIEW, seed host globals and wmploc, load `scriptFile` entries in order (+ `<stem>.js`), run top-level code → define id accessors → compile handlers → pass 2 `jscript:` in document order → record anchors → settle bindings (fires `_onchange`) → build DOM (render) → compute regions and mask → `host.surfaces` shows the window → fire VIEW `onload`. Budget: Headspace end-to-end < 250 ms on the owner's Mac (W3.D measures).

**Frame loop** (`host.clock.requestFrame`): advance animations and marquees → publish position tick to bindings → apply dirty attributes to DOM (diffed, parity D34) → if any region-relevant change (move, visibility, image swap, resize, z) recompute the window mask and send it if it changed (mask freshness is structural: the engine knows its own changes, so no MutationObserver is needed for engine content; host widgets report their own rects).

**Input path**: DOM pointer event on an element node (clip-path did the hit test) → `InputRouter` state machine (hover enter/leave, press, capture via `host.input.setCapture(true)` on **every** press on an interactive element (parity D30), release, click only if press and release are on the same element, dblclick, slider drag) → `event` object filled → `Realm.dispatch(handler)` → attribute changes → frame loop. Chrome press → `window.startDrag()`.

**Mask path**: per element, keyed bitmap → `Region` (row runs) → translate to window space → intersect ancestor clips → union → 1 bpp bits (LSB first, row-major, existing `click:` layout) → `set_hit_mask` raw body. Host widget and overlay rects union in.

---

## 4. Module map and public interfaces

Signatures are TypeScript-flavoured JSDoc contracts; W0.1 writes them verbatim into `src/engine/types.d.ts` and every module ships `// @ts-check`.

### 4.1 File layout

```
src/
  boot.js                    legacy|engine switch
  main.js widgets.js style.css playlist.js player.js demo.js   legacy (frozen until cutover)
  viz/                       unchanged except Viz size option
  engine/                    Tauri-free (D8)
    index.js                 createEngine(host) → Engine
    types.d.ts               all contracts in this section
    session.js               Session, view lifecycle, fault policy, sidecar application
    sidecar.js               per-skin compat data loader (schema-validated)
    vfs/ vfs.js select-wms.js text.js
    image/ sniff.js bmp.js png.js gif.js jpeg.js key.js worker.js client.js cache.js
    wms/ scanner.js tree.js values.js colors.js schema.js predefined.js res.js strings.js
    model/ element.js scene.js layout.js bindings.js animation.js ids.js
    realm/ module.js realm.js membrane.js handlers.js timers.js budget.js
    objects/ schema.js player.js controls.js settings.js media.js network.js playlist-obj.js
             theme.js view.js event.js mediacenter.js eq.js vidset.js effects.js video.js wmploc.js ledger.js
    render/dom/ window-root.js container.js bitmap.js button.js buttongroup.js slider.js
                customslider.js text.js slot.js styles.js
    hit/ region.js clip-path.js mask.js
    input/ router.js keyboard.js cursor.js tooltip.js
    inspect.js               SkinInspector for demo/tests
  shell/                     Tauri-aware app shell
    shell.js tauri-adapter.js media-mpd.js windows.js window-menu.js zoom.js keyboard.js
    overlays.js effects-host.js playlist-widget.js palette-service.js host-actions.js
    hosts/wmp-host.js        (phase 2: hosts/webamp/)
    demo/ driver.js headspace.js
sidecars/headspace.json      our data: accepted skin sha256s + compat entries + overlay labels
skinlab/                     dev harness (Node + Playwright)
  run.mjs legacy.html engine.html tauri-stub.js viz-stub.js skinlab-adapter.js states.mjs
  diff.mjs mask.mjs allowlist/headspace.json goldens.manifest.json corpus.mjs
tests/                       node --test; fixtures/ (synthetic, committed), corpus/ (skip-if-absent)
tools/ check-engine-boundary.mjs api-demand.mjs (convert_skin.py → icon only after cutover)
src-tauri/
  crates/skinpack/           lib + bin
  src/ lib.rs clickthrough.rs audio.rs eq.rs skins.rs prefs.rs windows.rs (mpd.rs outputs.rs unchanged)
docs/coverage/ api-demand.csv ledger.csv (counts and API names only)
```

### 4.2 HostAdapter and SkinWindow (`src/engine/types.d.ts`)

```ts
export interface HostAdapter {
  skins: { open(skinId: string): Promise<SkinVFS> };
  surfaces: {
    create(spec: SkinWindowSpec): Promise<SkinWindow>;
    current(): SkinWindow;                              // the window this engine instance lives in
  };
  input: { setCapture(on: boolean): void };              // caller window implied
  clock: { now(): number; requestFrame(cb: (t: number) => void): number; cancelFrame(id: number): void;
           setTimeout(cb: () => void, ms: number): number; clearTimeout(id: number): void };
  prefs: {                                               // synchronous cache, async persistence
    skin(skinId: string): PrefStore;                     // theme.savePreference/loadPreference
    global(): PrefStore;                                 // mediacenter.*, eqEnabled, host keys
  };
  media: MediaModel;
  audio: { subscribe(onFrame: (f: AudioFrame) => void, opts?: { pcm?: boolean }): () => void };
  eq: { get(): EqState; setGains(g: number[]): void; setBypass(on: boolean): void; setBalance(b: number): void;
        onChange(cb: (s: EqState) => void): () => void };
  palette: { snapshot(): PaletteSnapshot; onChange(cb: () => void): () => void };
  effects: { mount(ref: ElementRef, canvas: HTMLCanvasElement, size: { width: number; height: number },
                   overlayParent: HTMLElement): EffectsHandle };
  widgets: { create(kind: 'playlist' | 'editbox' | 'listbox' | 'popup' | 'automenu',
                    slot: HTMLElement, attrs: AttrBag, api: WidgetModelApi): HostWidget };
  actions: { returnToMediaCenter(): void; launchURL(url: string): boolean; openDialog(kind: string): string;
             setPlayerURL(url: string): boolean; playSound(name: string, bytes: Uint8Array): void };
  fonts: { family(fontFace: string | null): string };   // 'system' → 'Tahoma, Verdana, sans-serif'
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
  ledger(skinId: string, api: string, kind: 'stub' | 'unsupported' | 'unresolved-binding' | 'unresolved-res' | 'diagnostic'): void;
  notice(text: string | null): void;
}

export interface SkinWindowSpec { id: string; viewId: string; title: string; width: number; height: number;
  x?: number; y?: number; relativeTo?: { windowId: string; dx: number; dy: number };
  binding: 'os-window' | 'internal'; alwaysOnTop?: boolean; persistKey: string }

export interface SkinWindow {
  readonly id: string; readonly binding: 'os-window' | 'internal';
  readonly root: HTMLElement;                            // engine mounts here; host overlays above
  size(): { width: number; height: number }; setSize(w: number, h: number): Promise<void>;
  position(): { x: number; y: number }; setPosition(x: number, y: number): Promise<void>;
  zoom(): number; onZoom(cb: (z: number) => void): () => void;
  startDrag(): void; minimize(): void; close(): Promise<void>; setAlwaysOnTop(on: boolean): void;
  setMask(mask: HitMask): void;
  onCloseRequested(cb: () => Promise<void> | void): () => void;   // fires VIEW onclose first
}
export type HitMask =
  | { kind: 'bits'; width: number; height: number; bits: Uint8Array }          // 1 bpp, LSB first, skin px
  | { kind: 'regions'; regions: Array<{ x: number; y: number; w: number; h: number; polygon?: number[] }> };

export interface SkinVFS {
  readonly skinId: string; readonly archiveName: string;
  list(): Array<{ name: string; path: string; size: number }>;
  has(name: string): boolean;                             // case-insensitive basename, or path
  read(name: string): Uint8Array | null;
  diagnostics(): Diagnostic[];
}
export interface PrefStore { get(key: string): string | undefined; set(key: string, value: string): void;
  keys(): string[]; onChange(cb: (key: string) => void): () => void }
```

### 4.3 MediaModel (the MPD seam)

```ts
export interface MediaModel extends EventTarget {         // events: 'status' 'song' 'queue' 'connection'
  readonly connected: boolean;
  readonly state: 'play' | 'pause' | 'stop';
  readonly song: SongInfo | null;                         // MPD currentsong as a record
  readonly queue: SongInfo[]; readonly queueVersion: number;
  readonly status: Record<string, string>;
  elapsed(): number; duration(): number;                  // seconds; elapsed extrapolated while playing
  volume(): number;                                       // -1 when MPD has no mixer
  modes(): { repeat: boolean; random: boolean; single: boolean; consume: boolean };
  play(): Promise<void>; pause(): Promise<void>; stop(): Promise<void>; next(): Promise<void>; previous(): Promise<void>;
  seek(sec: number): Promise<void>; setVolume(v: number): Promise<void>;
  setMode(m: 'repeat' | 'random', on: boolean): Promise<void>; playPos(pos: number): Promise<void>;
  storedPlaylists(): string[]; playlistSongs(name: string): Promise<SongInfo[]>; playPlaylist(name: string, pos: number): Promise<void>;
}
```
`src/shell/media-mpd.js` wraps `player.js` (unchanged); `skinlab/skinlab-adapter.js` and `tests/fakes/media.js` provide fixture models with a scripted state machine.

### 4.4 Image (`src/engine/image/`)

```ts
export function sniff(bytes: Uint8Array): 'bmp' | 'png' | 'gif' | 'jpeg' | 'cur' | 'ico' | 'unknown';
export function decode(bytes: Uint8Array, limits?: { maxPixels: number }): DecodedImage;   // throws DecodeError
export interface DecodedImage { width: number; height: number; rgba: Uint8ClampedArray;
  indexed?: { palette: Uint8Array /*rgb*/; indices: Uint8Array }; frames?: GifFrame[];
  meta: { format: string; bpp?: number; compression?: string; hasAlpha: boolean }; diagnostics: string[] }
export interface KeySpec { transparency?: RGB | 'auto'; clipping?: RGB | 'auto'; hueShift?: number; saturation?: number }
export function applyKeys(img: DecodedImage, spec: KeySpec): KeyedBitmap;
export interface KeyedBitmap { width: number; height: number; rgba: Uint8ClampedArray;
  paint: Region; clip: Region | null }                      // regions in image space
export class ImageClient {                                  // main thread → worker
  constructor(vfs: SkinVFS, workerFactory: () => Worker);
  get(name: string, spec: KeySpec): Promise<KeyedBitmap | null>;   // null = missing/undecodable (logged)
  info(name: string): Promise<{ width: number; height: number } | null>;
  frameGrid(name: string, frameW: number, frameH: number): Promise<KeyedBitmap[]>;  // customslider strips
}
```

### 4.5 WMS parse and model (`src/engine/wms/`, `src/engine/model/`)

```ts
export function scan(text: string): { root: RawNode | null; diagnostics: Diagnostic[] };
export interface RawNode { tag: string /*lower*/; attrs: Map<string /*lower*/, string>; dupes: string[];
  children: RawNode[]; line: number }
export function classify(attr: string, raw: string, type: AttrType):
  { kind: 'literal'; value: unknown } | { kind: 'jscript'; code: string } | { kind: 'wmpprop'; path: PathSeg[] }
  | { kind: 'wmpenabled' | 'wmpdisabled'; method: string } | { kind: 'handler'; code: string; params: string[] };
export const SCHEMA: Record<string /*elementType*/, ElementSchema>;     // attrs, types, defaults, handlers, methods, status
export const PREDEFINED: Record<string /*tag*/, { base: string; defaults: Record<string, string> }>;

export class Element {                                    // model/element.js
  readonly type: string; readonly id: string; readonly docIndex: number; readonly parent: Element | null;
  readonly children: Element[];
  get(attr: string): unknown; set(attr: string, value: unknown, origin: 'script' | 'user' | 'binding' | 'layout' | 'anim'): boolean;
  on(attr: string, cb: (v: unknown, origin: string) => void): () => void;   // drives _onchange and DOM
  path(): string;                                         // 'view/subview[2]/button[0]' for diagnostics
}
export class Scene { readonly views: ViewModel[]; byId(viewId: string, id: string): Element | null;  // case-insensitive
  stackingOrder(container: Element): Element[];  }        // (z, docIndex), background at z 0 first
export function layoutPass1(view: ViewModel, images: ImageClient): Promise<void>;
export function layoutPass2(view: ViewModel, realm: ViewRealm): void;       // once, document order
export function reanchor(container: Element, oldSize: Size, newSize: Size): void;
export class Bindings { constructor(view: ViewModel, objects: ObjectGraph, clock: Clock);
  settle(): void; suspend(el: Element, attr: string): void; resume(el: Element, attr: string): void; dispose(): void }
export class Animator { constructor(clock: Clock);
  moveTo(el: Element, x: number, y: number, ms: number, ease: 'linear' | 'inout'): void;
  moveSizeTo(el: Element, x: number, y: number, w: number, h: number, ms: number, slide: boolean): void;
  alphaBlendTo(el: Element, a: number, ms: number): void; tick(t: number): void }   // fires onendmove/onendalphablend
```

### 4.6 Realm and objects (`src/engine/realm/`, `src/engine/objects/`)

```ts
export async function loadQuickJS(): Promise<QuickJSFactory>;              // compiles WebAssembly.Module once
export class SkinRealm {                                                    // one per Session = one wasm instance
  static create(factory: QuickJSFactory, limits: { memoryBytes: number; stackBytes: number }): Promise<SkinRealm>;
  context(viewId: string, globals: HostGlobals): ViewRealm;
  readonly faulted: boolean; onFault(cb: (reason: FaultReason) => void): () => void;
  discard(): void;                                                          // drop instance; never dispose after abort
}
export interface ViewRealm {
  loadScript(name: string, source: string): ScriptResult;                  // global code, 2 s deadline
  defineIds(ids: Array<{ id: string; spellings: string[]; handle: HostHandle }>): string[];   // returns collisions
  compileHandler(el: HostHandle, code: string, params: string[]): HandlerRef | CompileError;
  evalAttr(el: HostHandle, code: string): { ok: true; value: unknown } | { ok: false; error: string };
  dispatch(h: HandlerRef, thisEl: HostHandle, args: unknown[], event?: EventInit): DispatchResult;   // 50 ms deadline
  call(fnName: string, args?: unknown[]): DispatchResult;                  // shell/demo/tests: ToggleEqView()
  getGlobal(name: string): unknown;
}
export interface HostObject { readonly schema: ObjectSchema;               // membrane target
  hostGet(member: string /*lower*/): unknown; hostSet(member: string, v: unknown): boolean;
  hostCall(member: string, args: unknown[]): unknown; hostHas(member: string): boolean }
export function createObjectGraph(host: HostAdapter, session: SessionInfo): ObjectGraph;   // player, theme, view, ...
export function wmplocConstants(opts?: { extras?: boolean }): Record<string, unknown>;      // wmploc §7.5
export function resolveRes(url: string): { module: 'wmploc'; type: string; id: number } | null;
export function loadString(url: string): string;
```

### 4.7 Render, hit, input (`src/engine/render/dom/`, `hit/`, `input/`)

```ts
export class DomRenderer { constructor(win: SkinWindow, view: ViewModel, images: ImageClient, host: HostAdapter);
  build(): Promise<void>; applyDirty(): void; nodeOf(el: Element): HTMLElement; dispose(): void }
export class Region {                                       // hit/region.js: sorted row runs
  static fromAlpha(rgba: Uint8ClampedArray, w: number, h: number, pred: (a: number) => boolean): Region;
  static rect(x: number, y: number, w: number, h: number): Region;
  union(o: Region): Region; intersect(o: Region): Region; translate(dx: number, dy: number): Region;
  count(): number; toRects(): Array<[number, number, number, number]>; toClipPath(): string; isEmpty(): boolean }
export class MaskBuilder { constructor(view: ViewModel, renderer: DomRenderer);
  build(): { kind: 'bits'; width: number; height: number; bits: Uint8Array }; dirty(): void }
export class InputRouter { constructor(view: ViewModel, renderer: DomRenderer, realm: ViewRealm, host: HostAdapter);
  attach(): void; inject(type: 'move' | 'down' | 'up', x: number, y: number, button?: number): void; detach(): void }
export interface SkinInspector {
  find(ref: string): ElementRef | null;                     // id or Unnamed_<type>_<n>, case-insensitive
  rectOf(ref: ElementRef): DOMRect;                         // client coordinates
  elementPoint(group: ElementRef, mappingColor: string): { x: number; y: number };   // centroid of owned px
  sliderThumbPoint(ref: ElementRef, value: number): { x: number; y: number };
  call(fn: string, ...args: unknown[]): unknown; get(name: string): unknown;
  attr(ref: ElementRef, name: string): unknown; stackingDump(): string[]; mask(): Uint8Array;
}
```

### 4.8 Session and engine entry

```ts
export function createEngine(host: HostAdapter, opts?: { config?: 'faithful' | 'oracle-compat';
  switches?: Partial<Switches> }): Engine;
export interface Engine { open(skinId: string, viewId?: string): Promise<Session>; quickjs(): Promise<QuickJSFactory> }
export interface Session { readonly skinId: string; readonly views: ViewModel[]; readonly faulted: boolean;
  inspector(viewId?: string): SkinInspector; close(reason: 'user' | 'switch' | 'fault'): Promise<void> }
export interface Switches { stacking: 'context' | 'additive'; sliderGeometry: 'docs' | 'oracle';
  buttongroupShowBackgroundDefault: boolean; honourViewResize: boolean; seedConstantsEarly: boolean;
  positionTickHz: number; transparentButtonPixelsClickable: boolean }
// 'oracle-compat' = { sliderGeometry: 'oracle', buttongroupShowBackgroundDefault: true,
//                     transparentButtonPixelsClickable: false } + sidecar 'compat' overrides (D20, D21)
```

Sidecar (`sidecars/headspace.json`), validated by `src/engine/sidecar.js`:
```json
{ "skins": ["<sha256 of the owner's Headspace.wmz>"],
  "faithful": {
    "attr":    [{ "ref": "seek", "name": "foregroundProgressMode", "value": "playhead" }],
    "overlay": [{ "parent": "sEqView", "kind": "labels", "class": "freq", "y": 121,
                  "xs": [9,24,39,54,69,84,99,114,129,144], "w": 15, "texts": ["32","63","125","250","500","1K","2K","4K","8K","16K"],
                  "font": "7px Tahoma, Verdana, sans-serif", "color": "#77ce07", "letterSpacing": -0.3 }],
    "hostBindings": [{ "path": "player.settings.balance", "rule": "detent", "within": 6 },
                     { "path": "player.settings.volume", "rule": "debounce", "ms": 40 }] },
  "compat": { "attr": [{ "ref": "Unnamed_text_<n>", "name": "top", "value": 129 },
                       { "ref": "Unnamed_text_<m>", "name": "fontPx", "value": 9 }] } }
```
Config semantics: `oracle-compat` applies the `faithful` entries **plus** the `compat` entries, and compat wins on conflict, so the frequency labels, the `playhead` seek mode and the host bindings are present in both configs. `foregroundProgressMode: playhead` is the parity D2 compatibility (reveal edge = thumb centre, no thumb constraint), declared per skin so no other skin inherits it. The frequency labels (parity D1) are an overlay, not engine behaviour. `<n>`/`<m>` are filled in W2.A once Unnamed numbering exists.

### 4.9 Rust commands (all additive)

| Command / event | Signature | Notes |
|---|---|---|
| `skin_import` | `(path: String) -> SkinMeta {id, name, format, size}` | copies to `$APPDATA/skins/<sha256>.<ext>` |
| `skin_list` | `() -> Vec<SkinMeta>` | |
| `skin_pack` | `(id: String) -> tauri::ipc::Response` (raw `SKPK` body) | D4 |
| `prefs_snapshot` | `(scope: "skin:<id>" \| "global") -> HashMap<String,String>` | sync cache seed |
| `prefs_set` | `(scope, key, value) -> ()` | caps: 1,024 keys, key ≤ 256 B, value ≤ 8 KB, file ≤ 512 KB; atomic rename; event `prefs-changed {scope,key,value}` to all webviews |
| `set_hit_mask` | `(window: WebviewWindow, request: tauri::ipc::Request)` raw body `{w,h,zoom}` header + bits; legacy JSON form kept | per-window D7 |
| `set_hit_regions` | `(window, regions: Vec<HitRegion>, zoom: f64)` | phase 2 |
| `set_capture` | `(window: WebviewWindow, on: bool)` | capture = caller label |
| `skin_window_open` | `(spec: SkinWindowSpec) -> String /*label*/` | phase 3 satellites; label `skin-<viewId>-<n>` |
| `set_eq_profile`, `set_eq`, `set_eq_preamp`, `set_eq_bypass`, `get_eq`, event `eq-changed` | D11 | |
| `audio_subscribe`, `audio_unsubscribe` | D11 | |
| unchanged | `mpd`, `set_balance`, `engine_info`, `palette`, `js_log`, `record_start`, `record_stop` | |

Capabilities: `default.json` windows `["main", "skin-*"]`, add `allow-set-position`, `allow-show`, `allow-hide`.

---

## 5. Test and oracle plan (summary of D9 as commands)

| Command | What it proves | Needs |
|---|---|---|
| `npm test` | boundary check + all unit tests over synthetic fixtures | nothing local |
| `npm run test:corpus -- <area>` | areas `pack`, `parse`, `image`, `realm`, `layout`, `load` over the 195 distinct skins | `skins/wmp` |
| `npm run test:headspace -- <area>` | Headspace-specific facts (keying equality with `public/skin`, parity §0.4/0.5 geometry, script surface) | `HEADSPACE_WMZ`, `npm run skin` once |
| `cargo test --workspace` (in `src-tauri`) | skinpack, clickthrough decision fn, eq profiles, prefs, fan-out | nothing |
| `cargo run -p skinpack -- check skins/wmp` | 342/342 archives pack; stats match survey §1 | `skins/wmp` |
| `npm run skinlab -- bless legacy` / `verify legacy` | legacy goldens, determinism | Headspace, Playwright Chromium |
| `npm run skinlab -- diff --config compat|faithful --states ... --dpr 1,2` | parity | goldens |
| `npm run skinlab -- fixtures` | DOM control tests on synthetic skins (expected pixels computed from fixture data) | Playwright Chromium |
| `npm run skinlab -- corpus` | load every distinct skin's main view headless in `faithful`; faults, ledger, timings, screenshot thumbnails to `skinlab/out/` (gitignored) | `skins/wmp` |

Fixture ladder (survey §6) with phase targets: R0 Headspace (P1 parity), R1 Miniplayer and R2 aoe (P1: load, render, operate transport/volume/seek in skinlab with no fault), R3 PowerToys and R4 Revert (P1 main view; P3 full), R5 Atomic, R6 Blinx, R7 9SeriesDefault, R8 portals, R9 xsn_sports (P3). Negative pack (survey §6.1) in P1 `test:corpus -- pack,parse`.

---

## 6. How the pieces map onto the parity contract

| Parity item | Where it lands | Config |
|---|---|---|
| Rule 4 nested subviews as layers | D2/D5 Reading C | both |
| Rule 5 per-declaration keying | D3 `applyKeys` | both |
| Rule 6 mask is parity | D2 regions → D7 mask; D9 mask diff | both |
| D1 frequency labels | sidecar overlay | both |
| D2 seek foreground | engine implements docs; sidecar `playhead` mode | both |
| D3 return to full mode | host action table | both |
| D4-D7 overlays, palette | shell (D10, D12) | both |
| D8-D9 menu, keyboard | shell, skin-first order, modifier fix | both |
| D10-D11 picker, mask | clip-path regions; 106 screen corners allow-listed | faithful (compat reproduces the oracle's rect) |
| D12 playlist widget | host widget, same CSS | both |
| D13 window never resizes | **overridden**: `view.width` honoured, pixel-neutral (D7) | switch |
| D14 pl visibility mid-slide | follow WMS | both (not in settled states) |
| D15 vis tooltip bug | run script as written | both |
| D16 isAvailable table | pinned to oracle | both |
| D17/D18 detent, debounce | sidecar host bindings + generic drag suspension | both |
| D19 video stub | objects/video.js | both |
| D20 reset y | WMS (127); compat override 129 | allow-list rect |
| D21 preset title size | WMS (13 px); compat override 9 px | allow-list rect |
| D22 font mapping | host fonts | both |
| D23 prefs | host prefs (skin + global) | both |
| D25 click screen | host action on EFFECTS without onclick | both |
| D26 subview clip as container mask | container clip-path | both |
| D27 runtime decode | D3 | both |
| D28 slider hover over box | reproduce (switchable later) | both |
| D29 unclaimed pixels drag | intended deviation | both |
| D30 capture on every press | InputRouter | both |
| D31 continuous slider values | integer quantisation only in host bindings | both |
| D32 thumb travel | `sliderGeometry` docs vs oracle; 0 px in S1-S4 | allow-list bound 0 |
| D34 diffed writes | renderer dirty set | both |
| D35 zoom | host; parity at 1 | both |
| U-23 showBackground | docs default false; compat true | allow-list pixelset |

---

## 7. Wave plan

Owners: **S** = Sonnet implementer, **O** = Opus (design, review, verification gates). Every task lists files, the interface it delivers (§4), its acceptance command, and dependencies. A task is done when its command exits 0 and an Opus review signs it off. Tasks within a wave are independent unless a dependency is named.

### Phase 1: WMP engine to Headspace parity, single-view breadth, cutover

**Wave 0: foundations**

| Task | Owner | Files | Delivers | Acceptance | Deps |
|---|---|---|---|---|---|
| W0.1 Contract freeze | O | `src/engine/types.d.ts`, `package.json` (pinned deps: quickjs-emscripten-core 0.32.0, @jitl/quickjs-wasmfile-release-sync 0.32.0, fast-png 8.0.0, omggif 1.0.10, jpeg-js 0.4.4, playwright-core 1.63.0 dev), `tools/check-engine-boundary.mjs`, `tests/` scaffold, `src/boot.js` (legacy only) | §4 contracts, `npm test`, boundary rule | `npm test` green; `npm run build` builds the legacy app; `npm run tauri dev` unchanged | none |
| W0.2 Synthetic fixture kit | S | `tests/fixtures/gen-bmp.mjs`, `tests/fixtures/wms/*.wms` + `.js` (own-authored: nesting/z, keys, buttongroup map, slider modes, jscript chains incl. forward read, wmpprop/wmpenabled, handler scope, every malformed class of survey §2.2) | fixtures + generator | generated BMPs (1/4/8/16/24/32 bpp, RLE4/RLE8, BITFIELDS 565, top-down) open in `sips -g all` with the expected size; byte-stable hash snapshot test | W0.1 |
| W0.3 skinlab legacy capture | S | `skinlab/{run.mjs,legacy.html,tauri-stub.js,viz-stub.js,states.mjs,mask.mjs,goldens.manifest.json}`, Vite alias for the viz stub | bless/verify legacy, S1-S4 (+S3b, S5, S6) at DPR 1/2 | `npm run skinlab -- bless legacy && npm run skinlab -- verify legacy && npm run skinlab -- verify legacy` all exit 0; manifest records popcount/bbox per state and the deltas against parity §4.1's emulated reference (89,328 / 122,636 / 123,258 / 89,328) with an explanation for any difference | W0.1 |

**Wave 1: pure modules (parallel)**

| Task | Owner | Files | Delivers | Acceptance | Deps |
|---|---|---|---|---|---|
| W1.A skinpack | S | `src-tauri/crates/skinpack/**`, workspace `Cargo.toml` | D4 crate, `SKPK` format, `pack`/`check` CLI | `cargo test -p skinpack` (synthetic zips: bad local signature, `..` names, absolute paths, bombs over each cap, case collisions last-wins, `RESOURCE.FRK/`, `__MACOSX`, stored + deflate, CRC mismatch); `cargo run -p skinpack -- check skins/wmp` → 342/342 packed, SplinterCell's `sc.wms` readable, 0 panics, multi-`.wms` archives = 4 raw | W0.1 |
| W1.B image decode + keying | S | `src/engine/image/**` | §4.4 | `npm test -- tests/image` (every W0.2 BMP pixel-exact; RLE escapes; X1R5G5B5 vs BITFIELDS 565; 32-bit alpha policy; truncated input no throw; PNG tRNS; GIF frames; JPEG baseline); `npm run test:corpus -- image` (every referenced image of the 195 skins decodes or yields a logged null, no throw; Nautical's mis-extended files sniffed); `npm run test:headspace -- image` (per-declaration keyed RGBA equals `public/skin/*.png`: alpha exact, RGB exact where alpha > 0, maps unkeyed) | W0.1, W0.2 |
| W1.C scanner + tree + text | S | `src/engine/wms/{scanner,tree}.js`, `src/engine/vfs/text.js` | `scan()` | `npm test -- tests/wms`; `npm run test:corpus -- parse` → 195/195 parse; diagnostic counts per class equal survey §2.2 (67/22/12/8/1 distinct) ±1; Headspace: 1 VIEW, 23 SUBVIEWs, 69 elements | W0.2 |
| W1.D schema, values, res, wmploc | S | `src/engine/wms/{values,colors,schema,predefined,res,strings}.js`, `src/engine/objects/wmploc.js` | `SCHEMA`, `PREDEFINED`, `classify()`, `wmplocConstants`, `resolveRes`, `loadString` | `npm test -- tests/values tests/wmploc` (wmploc §7.9 tests 1-4; 140 IE colours; boolean/number oddities `ture`, `600 `; predefined expansion snapshot for every tag in survey G23; typo prefixes literal) | W0.1 |
| W1.E Rust backend generalisation | S | `src-tauri/src/{clickthrough,audio,eq,prefs,skins,lib}.rs`, `capabilities/default.json` | §4.9 table (except satellites) | `cargo test` (pure `want_ignore(windows, capture, cursor)` table tests incl. overlap; mask raw/legacy forms; fan-out drops a dead channel; prefs caps + atomic rename + broadcast; EQ: 0 dB profile = identity within 1e-6, WMP profile centres equal `eq.rs:7-9`); `npm run skinlab -- verify legacy` still green; Opus smoke: legacy app runs, sliders capture, demo tour runs | W0.1 |
| W1.F Realm + membrane | S | `src/engine/realm/**` | §4.6 realm half | `npm test -- tests/realm`: probe-1/probe-2 cases as tests; handler scope order; `has` false for non-members; id accessors incl. case variants and collision report; PLAYER param names exact-case; label-prefixed handlers compile; `jscript:` with trailing `;`; timers on a fake clock; 50 ms interrupt; OOM fault; simulated WASM abort discards the instance and a fresh session in the same process works; handle count back to baseline after 1,000 dispatches. `npm run test:corpus -- realm`: all corpus `.js` and handler attributes compile, exactly the 5 known failures (survey §5.2). `npm run test:headspace -- realm`: `headspace.js` loads against mock objects from parity §3.7, `Init()` runs, `ToggleEqView()` records `sEqEar.moveto(0, 86, 120)` | W0.1, W0.2 |

**Wave 2: model**

| Task | Owner | Files | Delivers | Acceptance | Deps |
|---|---|---|---|---|---|
| W2.A Elements, scene, stacking, ids | S | `src/engine/model/{element,scene,ids}.js` | `Element`, `Scene`, Unnamed ids | `npm test -- tests/scene` (negative z under background; nested contexts; equal-z document order; runtime z re-sort; coercion and invalid-keeps-previous); `npm run test:headspace -- scene`: stacking dump equals parity §0.6 order; Unnamed ids for `visNext` and `reset` printed and written into the sidecar | W1.C, W1.D |
| W2.B Layout | S | `src/engine/model/layout.js` | pass 1/2, anchors | `npm test -- tests/layout` (forward literal read, unevaluated jscript reads 0, self-reference `view.width-2*left`, right/center/stretch reanchor); `npm run test:headspace -- layout`: every row of parity §0.4 and §0.5 exactly (reset top 127; ear positions; panel and frame offsets); `npm run test:corpus -- layout`: 9SeriesDefault svMain/svStub, Revert, no exceptions over 195 main views | W2.A, W1.B (image sizes), W1.F |
| W2.C Bindings | S | `src/engine/model/bindings.js` | `Bindings` | `npm test -- tests/bindings` (call paths, element paths, intermediate replacement, wmpenabled 3 spellings, drag suspension, re-entrancy cut at equal value and at depth 8, 10 Hz realm coalescing on a fake clock) | W2.A, W2.D (fake objects allowed earlier) |
| W2.D Object model + ledger | S | `src/engine/objects/**`, `tests/fakes/media.js`, `tools/api-demand.mjs`, `docs/coverage/api-demand.csv` | `createObjectGraph`, `MediaModel` fake | `npm test -- tests/objects` (every parity §3.7 member resolves non-stub; isAvailable table = D16; enums; `durationString`; `loadPreference` unset `"--"`; mute emulation; ledger once per api); `node tools/api-demand.mjs skins/wmp` writes the CSV | W1.D, W1.F |
| W2.F Static vertical slice | S | `skinlab/static.mjs` | S1 from literal geometry only (no realm, no bindings; pause hidden, effects stubbed) through the W3.A/W3.B painters as they land | `npm run skinlab -- diff --config compat --states S1 --dpr 1 --static` passes once W3.A/W3.B exist; catches decoder, keying, stacking and text-box errors before realm and bindings are involved | W1.B, W1.C, W2.A |
| W2.E Animation | S | `src/engine/model/animation.js` | `Animator` | `npm test -- tests/animation` (moveTo 120 ms linear: x at 60 ms = 103 from 207→0 with round-half-up documented; onendmove once after final write; new moveTo replaces old; alphaBlendTo; ease-in-out curve) | W2.A |

**Wave 3: render, input, session**

| Task | Owner | Files | Delivers | Acceptance | Deps |
|---|---|---|---|---|---|
| W3.A Region + DOM core | S | `src/engine/hit/{region,clip-path}.js`, `src/engine/render/dom/{window-root,container,bitmap,styles,slot}.js` | `Region`, `DomRenderer` core | `npm test -- tests/region` (algebra, path serialisation, rect merging); `npm run skinlab -- fixtures --area core` (stacking, clip to bounds, subview clipping region, opacity, top layer for windowed slots, `elementFromPoint` hits per region table, including a descendant under a clipped ancestor at a clipped-out pixel, which must not hit: webamp §2 verified `clip-path` only on the hit element itself, so ancestor clipping of hit-testing is tested here, not assumed) | W2.A, W1.B |
| W3.B Controls | S | `src/engine/render/dom/{button,buttongroup,slider,customslider,text}.js` | painters per D2 | `npm run skinlab -- fixtures --area controls`: expected pixels computed by the tests from fixture data (buttongroup owner composite both showBackground values; slider docs and oracle geometry; tiled caps; slide true/false; foregroundProgress; customslider frame and grey hit; text box CSS, ellipsis, wordWrap, marquee step on fake clock) | W3.A |
| W3.C Input + mask | S | `src/engine/input/**`, `src/engine/hit/mask.js` | `InputRouter`, `MaskBuilder` | `npm run skinlab -- fixtures --area input` (click only when down/up on same element; capture called on every press; dblclick; slider drag with suspension; chrome press calls `startDrag`; disabled absorbs; passThrough falls through; key dispatch order); mask equals union of regions on fixtures | W3.A, W3.B, W2.C |
| W3.D Session + worker + sidecar + fault policy | S | `src/engine/{index,session,sidecar,inspect}.js`, `image/{worker,client}.js` | `createEngine`, `Session`, `SkinInspector` | `npm run skinlab -- diff --config compat --states S1 --dpr 1` passes (first visual milestone); load time logged < 250 ms; fault test: a fixture skin with `while(true){}` in `onclick` shows the notice and the window stays responsive | W3.A-C, W2.* |

**Wave 4: shell and parity**

| Task | Owner | Files | Delivers | Acceptance | Deps |
|---|---|---|---|---|---|
| W4.A Skinlab engine diff | S | `skinlab/{engine.html,skinlab-adapter.js,diff.mjs,allowlist/headspace.json}` | full D9 diff, both configs, mask diff, drift guard | `npm run skinlab -- diff --config compat --states S1,S2,S3,S3b,S4 --dpr 1,2` (0 px outside hole); `... --config faithful ...` (only allow-list, within bounds); S2 == S2b; S5/S6 in faithful | W3.D, W0.3 |
| W4.B TauriAdapter + shell | S | `src/shell/{shell,tauri-adapter,media-mpd,windows,window-menu,zoom,keyboard,host-actions}.js`, `src/boot.js` | engine mode in the app | `npm test -- tests/shell` (adapter unit tests with a mocked `invoke`); Opus smoke checklist in `npm run tauri dev -- -- ?engine=wmp`: transport, seek, volume, EQ audible, drawers, `view.width` 760/549, drag, minimise, close, menu, zoom, keys | W3.D, W1.E |
| W4.C Effects, overlays, playlist | S | `src/shell/{effects-host,overlays,playlist-widget,palette-service}.js`, `src/viz/index.js` (size option), `src/playlist.js` (slot + attrs) | D10 host features, PaletteService local tier | `npm run skinlab -- diff --config faithful --states S3,S3b` (playlist pixels); overlay toast inside the effects clip (fixture with a clipped corner); `tools/facelab.html` still works; viz renders at 216x158 identical to legacy (visual check by Opus) | W4.A, W4.B |
| W4.D Sidecar + demo retarget | S | `sidecars/headspace.json`, `src/shell/demo/{driver,headspace}.js`, `src/demo.js` (legacy untouched) | D1/D2/D17/D18 compat, `DemoTarget` | faithful S1-S4 still within allow-list with labels present (S2); demo tour runs headless in skinlab against the engine with the fixture media model and produces the same click sequence log as the legacy run | W4.A-C |
| W4.E Corpus sweep | S | `skinlab/corpus.mjs`, `docs/coverage/ledger.csv` | breadth report | `npm run skinlab -- corpus` completes for all 195; report lists per skin: load ok/fault, ms, ledger entries, unresolved refs; R1 Miniplayer and R2 aoe operate transport, volume and seek with no fault | W3.D |
| **G1 gate** | O | | verification | all W4 commands green; same Headspace states rendered in the real WKWebView (Tauri window screenshot with `screencapture -l`, or a Swift WKWebView runner) match the skinlab engine render outside the hole; S8 capture test by hand; demo recorded on the engine; Opus reviews ledger and sweep triage | W4.* |

**Wave 5: cutover**

| Task | Owner | Deliverable | Acceptance | Deps |
|---|---|---|---|---|
| W5.A Dogfood | owner + O | engine default behind the flag for 3 days | D10 criteria (5)-(7) | G1 |
| W5.B Cutover | S | `boot.js` default `wmp`; legacy to `skinlab/oracle/legacy/` (pinned sha1s); `convert_skin.py` icon-only (checked: only legacy `style.css:87,94,131-132` reads `/skin/*.png`; `playlist.js` and `viz/` do not; the harness keeps running the converter for the frozen oracle); README | `npm test`, all skinlab commands green against the moved oracle | W5.A |
| W5.C Final review | O | sign-off, phase-1 retrospective into `docs/design/` | | W5.B |

### Phase 2: Webamp for `.wsz`

| Wave | Tasks (owner) | Acceptance |
|---|---|---|
| P2-W1 | Extract `SkinHost` and `WmpHost` from the shell (O); `Frame.pcm` + `set_hit_regions` + `WINAMP` EQ profile with preamp (S, Rust); `WebampHost` thin mount of `webamp/lazy` with a media class, absolute window positions before render, hide-not-close (S) | one `.wsz` loads; play/pause/seek/volume round-trip with MPD; window shape correct (webamp §0 first step) |
| P2-W2 | Full mirror: echo/idempotence guards, `__initialState` + `plchanges` queue, `__customMiddlewares` for playlist/shuffle/repeat, duck-typed analyser, butterchurn facade, region mask with context-menu rect, double size, skin switcher menu with format sniff (S) | MPD idle replay state-machine tests (`npm test -- tests/webamp`); the 30 `skins/wsz` load without error |
| P2-W3 | Museum screenshot diff harness for `skins/wsz` (images kept outside git) (S); Opus gate | report per skin; Opus review |

### Phase 3: WMP breadth

Satellite views as WebviewWindows (`openView`, `openViewRelative`, `closeView`, `currentViewID`, per-view Keep-on-Top, positions); resizable views and `view.size(handle)` drag-resize with min/max; VIEW-level `moveTo`/`alphaBlendTo`; animated GIF for BUTTON images; `.cur`/`.ani` cursors; POPUP, LISTBOX, EDITBOX, AUTOMENU host widgets; `hueShift`/`saturation` on 8-bit art; `nineGridMargins`/`resizeImages`; RT_IMAGE/RT_BITMAP fallbacks; EQ presets; `theme.playSound`; PaletteService artifact tier (notan-palette/1); performance pass for R9 xsn_sports (424 subviews); conformance target: ≥ 90% of the 195 load and render their main view with no realm fault, ladder R3-R9 operable.

---

## 8. Risks accepted

1. **QuickJS fault isolation depends on discipline.** A leaked handle aborts the whole WASM module (probe-1). Mitigation: one instance per session, scope-based handle management, leak checks in W1.F. Residual: a real abort loses the session and needs a reload.
2. **Interpreter speed.** 3 µs per host read is fine for handlers; a skin that binds hundreds of `_onchange` handlers to the position tick could cost milliseconds per tick. Bounded by 10 Hz coalescing and the dispatch deadline; measured in W4.E.
3. **Chromium is the oracle browser, WKWebView is the product.** Text and canvas rasterisation can differ between them; both legacy and engine are DOM, so they should differ the same way, but this is checked only at G1.
4. **Follow-the-docs choices may not match a real WMP.** showBackground (U-23, 812 px), slider geometry (U-10), `foregroundProgress` (parity open question 1), transparency-pixel clickability, SUBVIEW clipping, `"--"` vs `""`, id precedence (U-31b). Each is a switch and the allow-list measures it, but without a real WMP render the "faithful" defaults are inferences.
5. **Allow-list drift.** Mitigated by per-entry bounds and the compat config, not eliminated: an engine bug that happens to fall inside an allow-listed rect is invisible.
6. **clip-path cost and edges.** Large, ragged regions mean long path strings (head.bmp: a few hundred rects); WebKit performance with many clipped nodes (R9: 424 subviews) is unmeasured; zoom 1.5 antialiases clip edges by half a device pixel.
7. **Honouring `view.width`** resizes a transparent macOS window mid-interaction; a one-frame flicker or a stale mask during the resize is possible. Switch available.
8. **Goldens are local-only.** Reproducing them needs the owner's `Headspace.wmz`, `npm run skin` and the pinned Chromium on this Mac; the manifest hashes make drift detectable but not recoverable elsewhere.
9. **One webview per VIEW** (phase 3) costs a WebContent process each; skins with 5-9 views may use several hundred MB. Prefs consistency across views relies on flush-before-open.
10. **Zero-size SUBVIEW non-clipping** is a deliberate departure from a literal docs reading, to be validated by the W4.E sweep.
11. **The Rust `skinpack` is on the test path**, so Node corpus tests need a cargo build; first run is slow.

## 9. Deliberately left to phase 3 (or later)

Multi-view satellites and every cross-view feature; user and script window resizing beyond `view.width/height` (`view.size`, min/max, stretch layout under drag); VIEW-level animation and window alpha; animated GIF; custom cursors; POPUP/LISTBOX/EDITBOX/AUTOMENU; playlist selection and editing methods; `hueShift`/`saturation`; nine-grid; WMP 11 `right`/`bottom` beyond the anchor model; EQ presets and spline tension (no known algorithm; may stay unsupported); `theme.playSound`; `launchURL`/`player.URL` allow policies; RT_IMAGE/RT_BITMAP placeholders; PaletteService artifact tier; video of any kind (MPD has none); Windows-only behaviours (`fontSmoothing` ClearType, native accessibility); a strict mode reproducing WMP's late #132 load order (wmploc §7.3, only for conformance reporting).

## 10. Open questions for the owner

1. D13 override: honour `view.width` (this design) or keep the window fixed at 760?
2. Faithful vs oracle look for the allow-listed items: the preset title at 13 px (docs) or 9 px (hand port); reset at y 127 or 129; transport-group unowned pixels drawn or not. The sidecar can pin the oracle look per skin.
3. `launchURL` and `player.URL` from skins: deny, or open http(s) in the browser after confirmation?
4. Should the EQ widen to ±20 dB for the WMP profile (docs) or stay ±14 (current DSP)?
5. Satellite views as separate webviews accept the memory cost, or should phase 3 revisit a compositor window for WMP too?
