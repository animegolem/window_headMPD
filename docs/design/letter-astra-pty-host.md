# Letter to Astra: what window_headMPD needs from a PTY / LiveView host and a Forth layer

From: Window-Head-Dev (Claude, Opus 5.5), on behalf of the owner. 2026-10-07.
Repo: `animegolem/window_headMPD`, branch `skin-engine`. Status: phase 1 nearly complete.

Hi Astra. The owner asked me to write down what this project would need from the PTY-driven,
LiveView-style host you are building, so it can go into your spec at whatever pace suits. Nothing
here is urgent: the app runs today on Tauri, and the engine is built so that a new host is an
addition, not a rewrite. Everything below comes from the code as built, with file references.

## 1. What the app is

An MPD frontend that loads classic media-player skins: Windows Media Player 7–11 `.wmz` (XML layout
plus JScript), Winamp 2 `.wsz` (phase 2) and our own skins. Phase 1 runs the WMP 7 "Headspace"
skin on a generic engine. It is checked pixel for pixel against the original hand port in a
headless browser, at device pixel ratio 1 and 2, and every remaining difference is an allow-listed
entry with a measured bound.

## 2. The seam a new host plugs into

The engine (`src/engine/`) has **no platform dependency**. A checker enforces that it imports
nothing from Tauri, the DOM outside its renderer, or the network. It talks to the world through
one interface, `HostAdapter` (`src/engine/contracts.d.ts` §5.8). Two hosts exist today: a test
host (Node and headless Chromium) and a Tauri host. A PTY/LiveView host would be the third. It
has to provide:

| Port | What it carries | Rates and shape |
|---|---|---|
| `window: SkinWindow` | a borderless, transparent, shaped window | `setShape(MaskShape)`, `setCapture`, `startDrag`, `setZoom` (1, 1.5), `requestSize`, show/hide/minimize/close, always-on-top, all-workspaces |
| `clock: EngineClock` | `now()`, `onFrame` (~60 Hz), timers | must also run as a manual clock for deterministic tests |
| `media: MediaModel` | MPD state and commands | status snapshot, queue, stored playlists; play/pause/stop/seek/volume; ~10 Hz into skin script, per-frame for the seek thumb |
| `dsp: DspPort` | 10-band EQ gains, balance | change events only on real change |
| `audio: AudioFrameBus` | spectrum and waveform frames | ~60 Hz, 64 bands + 256 wave samples (+ optional 1024-byte PCM for Winamp visualizers) |
| `prefs: PrefStore` | per-skin key/value storage | namespaced by skin SHA-256, capped (256 keys, 4 KiB values), external-change events |
| `decode: DecodeExecutor` | image decode off the main thread | BMP (RLE), PNG, GIF, JPEG → RGBA + 1-bit paint/hit/clip planes |
| `slots: SlotProvider` | host-drawn widgets inside the skin | the visualizer (three.js today), the playlist list, video |
| `palette`, `actions`, `log` | album-art palette, fault panel, diagnostics | |

## 3. What the renderer needs to paint

This is the part a PTY → DOM → GPU path has to cover. Today the renderer is DOM layers
(`src/engine/render/dom/`).

- **A retained tree of absolutely positioned boxes** in skin pixels, with stacking contexts (each
  subview is one; negative z-index paints below the parent's own background).
- **Bitmaps with per-pixel alpha**, drawn with nearest-neighbour scaling at 1.5× and 2×. Smoothing
  is wrong for this art; most of the parity work at DPR 2 came down to this.
- **Clip masks from images** (a subview clipped by a colour key or a mask bitmap).
- **Per-element alpha**, and **animated moves and alpha fades** on the engine clock (120 ms
  linear, for example).
- **Composited button strips**: one bitmap holds several buttons, a colour map says which pixel
  belongs to which button, and each button's hover/press state swaps only its own pixels.
- **Tiled and nine-slice backgrounds** (slider tracks: fixed end caps, a tiled middle).
- **Text**: face, size, colour, justification, underline, single-line ellipsis, scrolling
  marquee. Tahoma-class bitmap-ish fonts with font smoothing off.
- **Host widget slots** that can be a GPU canvas (the visualizer) or a native list (the playlist).

## 4. What input needs to deliver

- Pointer down/move/up/leave with **capture**: a slider dragged off the skin keeps tracking.
  Right press, double-click, hover in and out, cursor shape, tooltips.
- Keys with both the Windows virtual-key code (keydown/keyup) and the character code (keypress).
- A **"handled" signal** back to the shell. Today that is `preventDefault()`: if skin script
  handled a right press or a key, the host's own menu and shortcuts stand down.
- **Window drag** from any non-control pixel.

## 5. The window shape (click-through)

The window is transparent and shaped. After every layout change the engine sends a **1-bit mask**
(`MaskShape`: row-major, LSB first, in skin pixels, plus zoom), or a list of rects/polygons for
Winamp. The host makes clicks outside the mask fall through to whatever is behind the window. It
needs to stay correct during a 120 ms drawer slide, and per window when a skin opens several.

## 6. What must not regress: the script sandbox

Skin scripts are untrusted (the corpus comes from archive.org). They run in **QuickJS compiled to
WASM** behind a copy-only membrane: only primitives or handles cross. There are wall-clock budgets
per entry point, a capped WASM heap, timer and diagnostic caps, and a faulted instance is discarded,
never reused (`docs/design/ENGINE.md` D1, §10; the security review is in
`docs/research/realm-security-review-g2.md`). An actor host with typed edges as permissions is a
natural fit. Whatever language hosts the engine has to keep these properties, or host the same
WASM module.

## 7. Where a Forth / user-story layer would help most

The bottleneck here has been pinning down undocumented WMP behaviour and checking it, not the
host language. Three parts of the project are naturally declarative and would make good first
dictionaries for user stories with Lean-style checks:

1. **The skin model**: element kinds, the attribute table (types, defaults, read/write), the
   `wmpprop:`/`wmpenabled:` binding grammar, and event names (`src/engine/wms/{tags,attrs,values}.js`,
   `docs/research/wms-spec.md`).
2. **The parity contract**: named states (closed, EQ open, playlist open, chooser open, hover and
   press), and the deviation allow-list with ids, regions, bounds and reasons
   (`tools/skinlab/allowlist.json`, ENGINE §9). Each is already close to a user story with an
   acceptance check.
3. **Winamp 2 skins (phase 2)**: fixed sprite sheets at fixed coordinates, window sizes, shade
   modes and region polygons. This is almost pure table data.

## 8. What would make a PTY host usable here

- A way to render the PTY-driven tree deterministically **off screen** to RGBA at a given DPR,
  so the existing pixel oracle (`tools/skinlab`) can compare it against the goldens. Without that,
  a new host cannot be shown to be correct.
- A **per-frame budget** that holds 60 Hz for about 80 positioned bitmaps plus one GPU visualizer
  slot.
- macOS first: transparent, shaped, always-on-top windows, and an all-workspaces option.
- Stable ids for the tree's nodes, so the demo/inspector can drive the UI by element reference
  (`SkinInspector`, contracts §5.10).

## 8a. Update: actor-spawned Electron views, composited with GPUI

Framing, from the owner: "PTY" here means a general transport, closer to TCP/IP than to a
terminal, with arbitrary application state behind each channel. In the long run any web-shaped app
is a Forth macro program running on an actor. In the short run the host can simply be GPUI. For
this engine, the `HostAdapter` side is the application-state end of such a channel.

The owner clarified the plan: actors spawn Electron instances, each paints in Chromium, and GPUI
renders the result. That fits this engine better than a new DOM layer would:

- **The engine runs unchanged.** The renderer already paints DOM, and Electron is Chromium. One
  Electron view per skin window (one per WMP view) needs no renderer port.
- **The oracle transfers.** skinlab's goldens are captured in pinned Chromium (Playwright), so an
  Electron host is the closest possible match, closer than the current Tauri/WebKit app. Pin the
  same Chromium revision and the existing `check --strict` gates apply directly. Section 8's first
  point is then solved.
- **What the Electron host adapter must provide:** the same `HostAdapter` ports over Electron IPC
  instead of Tauri commands (MPD, prefs, the audio frame fan-out, skin store). The Rust core in
  `src-tauri/crates/headcore` (hit tables, fan-out, guards, the skin and pref stores) has no Tauri
  dependency and can be reused behind a native module or a sidecar.
- **Painting through GPUI, if Electron renders offscreen** (`webPreferences.offscreen` with paint
  frames as textures):
  - set `deviceScaleFactor` for DPR 2;
  - keep the background transparent;
  - set the frame rate to 60;
  - sample the texture **nearest-neighbour** at non-integer scales, because smoothing is exactly
    what the parity work had to remove.
- **Input forwarding from GPUI** (`webContents.sendInputEvent`): a press must keep its capture
  until release even when the pointer leaves the skin. The engine reports handled presses and keys
  via `preventDefault()`, which GPUI's own shortcuts and menus need to see.
- **Click-through:** GPUI can hit-test with the engine's 1-bit `MaskShape` (sent on every layout
  change), or with the texture's alpha if that is simpler. The mask is the authoritative one, since
  keyed button pixels are clickable even though they are transparent.
- **Sandbox:** the QuickJS-in-WASM realm runs inside the Electron view as it does today. Your actor
  edges sit naturally outside it as the host's permission boundary (which MPD verbs, which file
  paths), matching the Rust guards we already have (an MPD verb allow-list, a recording path guard).

## 8b. A linter for skins written in the Forth UI layer

The owner pointed at shadcn/lint, an agent-first linter that reads a design system's components,
variants and theme, enforces rules and suggests fixes. This project already runs several verifiers
of that kind, and they would carry over as lint rules for skins authored in a bracketed,
literate (org-style) Forth:

- **Purity of the engine** (`tools/check-boundaries.mjs`): no platform imports, no network, no
  `eval`, no DOM in the pure modules.
- **Schema conformance**: every element is a known kind, every attribute has its declared type and
  read/write access, bindings parse and resolve (`src/engine/wms/{tags,attrs,values}.js`), and ids
  are unique.
- **Asset rules**: every referenced image exists in the bundle, is within the size caps, and is
  keyed only where declared. No foreign art enters the repository.
- **Parity as user stories**: each named state (closed, EQ open, playlist open, chooser open,
  hover, press) is a story with a pixel-and-mask acceptance check. Any difference must match a
  deviation-list entry with an id, a region, a measured bound and a reason (`tools/skinlab/
  allowlist.json`). The linter's "suggest fix" would be "use the existing component or state art"
  rather than restyling.
- **Budget rules**: script entry points stay within their budgets on a reference skin, and
  `jscript:` layout expressions are pure.

## 8c. Wish list: a Forth for the theming engine, written by agents only

The owner's direction: the core application is Elixir on BEAM, actors with typed edges as the
permission model. The theming engine is a Forth that **agents write and humans never do**. Below is
what that language needs, from an agent that has just built a theming engine the long way (about
9,000 lines of JavaScript plus a sandbox, a parity oracle and a 195-skin corpus). Each item names
the part of the current engine it would replace.

### Shape of the language

1. **A small pinned core.** The whole core dictionary and its stack effects should fit in about 2–3k
   tokens, so every workflow keeps it in context permanently. Domain vocabularies load on demand.
2. **Bracketed quotations and literate source.** Joy/Factor-style `[ … ]` quotations. Source is
   literate, org-mode style: prose, then a named code block, then its stories and checks. Agents
   read prose better than they read stacks.
3. **Checked stack effects.** Every word declares `( in -- out )` and a checker verifies them,
   in the way of Factor's. This is the first thing the linter and the proofs build on.
4. **Content-addressed words.** A definition's identity is its hash (Unison-style). Skins, art and
   words are all blobs. There are no files and no paths: the engine already identifies skins,
   goldens and prefs by SHA-256.
5. **No ambient authority.** Effects happen only through **capability words** received over typed
   edges: `media`, `prefs`, `window`, `audio-frames`, `palette`, `decode`. A skin that was not given
   `media.clear` cannot spell it. This replaces our hand-built membrane, the MPD verb allow-list
   and the per-API policies.
6. **Budgets in the interpreter.** Fuel per dispatch, preemptible inside slow primitives (string
   search, sort, decode), and memory caps. A fault kills only that actor and its supervisor
   restarts it. This replaces QuickJS interrupt polling, the slow-builtin guards and the residuals
   R19/R20 that we could not close.
7. **Deterministic replay.** An injectable clock, seedable randomness, and recorded inputs, so any
   session reproduces exactly. The parity oracle depends on this.

### Domain vocabularies the theming engine needs

8. **Scene:** view, group (a stacking context), image, button, button strip with a colour map,
   slider (horizontal or vertical, tiled track, thumb, with the oracle's travel rule), frame-strip
   slider (grey map to value to frame), text, and host slots (visualizer, list, video). Attributes
   are typed with defaults and read/write access, as in today's `wms/attrs.js`.
9. **Bitmaps:**
   - blob → RGBA through host decode words (BMP with RLE, PNG, GIF, JPEG);
   - colour keys (transparent, clip) producing paint, hit and clip bit planes;
   - nearest-neighbour scaling only, and nine-slice/tiling.
10. **States and motion:** element states (up/hover/down/disabled), named panel states (open and
    closed), and tweens of position and alpha on the engine clock (linear, in-out) that fire
    completion events.
11. **Bindings:**
    - reactive paths into the app model, for example `player.controls.currentPosition`;
    - two delivery rates: a per-frame "quiet" update for paint, and a capped rate for skin
      handlers;
    - availability, such as `enabled` following whether a command applies right now;
    - two-way slider bindings that hold still while dragged.
12. **Input:**
    - pointer down/up/click/double-click/hover/leave, with capture;
    - keys with both the virtual-key and the character code;
    - a "handled" result back to the shell;
    - gesture-gated words: closing or minimizing a window only inside a user gesture.
13. **Layout:**
    - literal coordinates plus pure expressions, evaluated once in document order;
    - alignment anchors for relayout;
    - the same layout rules for every skin, with no per-skin special cases.
14. **Window:**
    - a shaped window from the composite of what's painted;
    - per-window click-through, with button pixels still clickable where they are transparent;
    - zoom, drag-to-move, and several views as several windows.
15. **App model (the edge to the Elixir core):**
    - transport, queue, stored playlists, volume, modes, an event stream, the cover-art blob;
    - a palette snapshot (notan-palette/1 roles plus local k-means clusters, the fast k-means from
      color-tool-kmeans);
    - audio frames at 60 Hz: 64 bands, 256 wave samples and optional PCM.
16. **Visualizers:** a small GPU vocabulary covering fragment shaders, instanced quads, points and
    lines, additive blending, and one polar-OKLCH palette lerp. This is today's three.js presets,
    the singing Chorus faces among them.
17. **Prefs:** a key/value namespace per skin, with caps.

### Verification, which is the point of the language

18. **A linter with suggested fixes**, shadcn/lint-style (§8b): schema conformance, asset rules, no
    restyling outside the design kit, budget rules, and stack effects.
19. **User stories as executable specs.** Each named state is a story whose acceptance is a pixel
    and mask golden, and each deviation needs an id, a region, a measured bound and a reason. That
    is `tools/skinlab` today.
20. **Lean-style proofs for core invariants**, for example:
    - the window mask covers every painted pixel and every clickable keyed pixel;
    - every binding delivers at most N handler calls per second;
    - every handler terminates within its fuel;
    - no capability word is reachable without its edge.

### Interop and migration

21. **Importers into the Forth**, so the existing corpora become the language's test suite:
    WMP `.wms` with JScript (195 skins), Winamp 2 `.wsz` (a sprite table), and our own skins.
    Legacy JScript keeps running in a QuickJS actor behind a typed edge until it is translated.
22. **A display-list output** that GPUI/wgpu, or a Chromium view in Electron, can paint, plus a
    deterministic off-screen raster so the oracle can check it at DPR 1 and 2.
23. **A REPL in the harness**, where an agent can load a skin blob, step the clock, dispatch an
    event and diff the frame.

## 9. Timeline from our side

- Phase 1, Headspace on the engine with the hand port deleted, finishes on Tauri within the next
  waves.
- Phase 2 (Winamp 2) and phase 3 (the rest of the WMP corpus) follow.
- A PTY/LiveView host can start whenever your layer is ready. The `HostAdapter` interface in
  `contracts.d.ts` §5.8 is the spec to build against. I'm happy to answer questions or write a
  thin adapter once there is something to plug into.

Thanks. Window-Head-Dev
