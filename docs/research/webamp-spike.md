# Webamp spike: can it be the Winamp 2 (.wsz) renderer for window_headMPD?

Status: research, 2026-10-06. Nothing in the repo was changed except this file.

Source examined: https://github.com/captbaritone/webamp (MIT, Jordan Eldredge), shallow clone at
commit `88ed581` (2026-08-23), `packages/webamp` = npm `webamp@2.3.1`. Line numbers below are
against that commit and drift fast; `js/` means `packages/webamp/js/`.

Method: read the code, then ran five throwaway probes (page + harness in `/tmp/webamp-spike/`,
not in the repo) in a real **WKWebView** (a ~60-line Swift runner, `wk.swift`; same engine Tauri
uses on macOS, macOS 27.0, UA `AppleWebKit/605.1.15`). Probe 1 was also run in headless Chrome and
the two engines produced identical results; probes 2 to 5 ran in WKWebView only. The owner's skin
and the corpus were not used: the probes loaded Webamp's own bundled base skin, rebuilt with a
synthetic `REGION.TXT`, in `/tmp` only. Results are summarised in the appendix.

## 0. Recommendation (read this first)

**Adopt Webamp as the Winamp 2 `.wsz` renderer, driven through `__customMediaClass` plus a small
set of Redux-level adapters. Do not fork. Do not write our own classic-skin renderer.**

Why, in two sentences: Webamp's own docs name MPD as an intended use of the custom-media hook
(`packages/webamp-docs/docs/06_API/05_custom-media-impl.md:5`), and I verified end to end in
WKWebView that a no-audio media class, direct Redux dispatches, a duck-typed analyser, a
`butterchurn` facade fed with our own samples, and window rectangles/region polygons readable from state (and matching the DOM) are
all enough to meet the stated requirements with zero audio played by Webamp and no fork.
Writing our own renderer would re-implement ~2.2k lines of window components plus ~3.9k lines of
sprite tables, parsers and CSS that Webamp already encodes and tests, for a result that would only match
Webamp's long tail of skin quirks after weeks of work (section 5).

The honest cost is not the media shim (small) but **keeping Webamp's local playlist/transport
state subordinate to MPD** (section 1.3). Budget roughly 10 to 15 focused days for a complete
integration (section 1.7); a thin "single track" version is 2 days.

First concrete spike step (about a day): mount `webamp/lazy` into the existing transparent
window with a ~150-line media class bound to `invoke('mpd', ...)`, an `__initialState` queue
built from `playlistinfo`, a duck-typed analyser fed from the existing Rust `Frame` stream, and
a `Frame.pcm` field (section 1.5). Acceptance: load one `.wsz`, play/pause/seek/volume
round-trip with MPD, spectrum alive, window shape correct.

## 1. Q1: injection point for an external source of truth (MPD)

### 1.1 What exists

The double-underscore options are "private": declared at `js/webampLazy.tsx:36-42` and accepted by
both `webamp` and `webamp/lazy` (`js/webamp.ts:27`). `webamp.store` is the public-ish escape hatch:

| Hook | Where | What it gives us |
|---|---|---|
| `__customMediaClass: IMediaClass` | `js/webampLazy.tsx:41,130`; `js/media/index.ts:16-89` | Replaces the whole `Media` class (the only place `AudioContext` and `<audio>` are created). Constructor takes **no arguments** (`new (): IMedia`), so inject the Tauri bridge by closure/factory. |
| `__customMiddlewares: Middleware[]` | `js/webampLazy.tsx:38,134`; `js/store.ts:50-55` | Redux middlewares appended after `withExtraArgument`, `mediaMiddleware`, `emitterMiddleware`. Can swallow actions before the reducer (see 1.3). |
| `__initialState` | `js/webampLazy.tsx:37,135`; `js/store.ts:37-43` | Deep-merged over reducer defaults at construction. The O(n) way to load a large queue. |
| `webamp.store` | `js/webampLazy.tsx:59`; docs `06_API/06_acessing-internals.md` | Public-ish: `dispatch`/`getState`/`subscribe`. "May change in future versions". |
| `importButterchurn` | `js/types.ts:189-197`; `js/actionCreators/milkdrop.ts:39-57` | Lets us hand Webamp a wrapped butterchurn module (see 1.5). |

Stability signals: the docs call the custom media impl "a bit of a hack... not considered stable"
(`05_custom-media-impl.md:7-9`) but `js/media/index.ts:91-93` carries a comment that
https://winampify.io/ replaces the class, and asks that breaking changes be communicated to its
author. So the surface is load-bearing for at least one downstream and unlikely to change
silently. `IMedia`/`IMediaClass` are **not exported from the package root** (`js/webamp.ts:24`
exports only `./types`); derive the type with
`NonNullable<ConstructorParameters<typeof Webamp>[0]['__customMediaClass']>`.

Prior art (read, not copied):
- Spotify via Webamp UI: https://github.com/remigallego/winampify (`js/actions/webamp.ts`), also
  https://github.com/KiPSOFT/winampfy (`src/main.ts`). Both known from Webamp's own docs/comment
  and a GitHub code search for `__customMediaClass`; I did not read their source, only reamp's.
- https://github.com/renaobrien/reamp (MIT, 2026): `apps/desktop/src/renderer/reamp-media.ts` is a
  complete 162-line `IMedia` that forwards transport over IPC and emits `timeupdate`/`playing`/
  `fileLoaded`; `analyser-feed.ts` (49 lines) patches a real `AnalyserNode`'s read methods;
  `webamp-host.ts` shows the `STOP`-on-close guard hack. It sidesteps queue sync entirely by
  using a single synthetic track `reamp:current`. Useful as the "thin" template.

### 1.2 The `IMedia` contract

`js/media/index.ts:16-89`: `setVolume(0..100)`, `setBalance(-100..100)`, `setPreamp(0..100)`,
`on(event, cb)`, `timeElapsed()` (s), `duration()` (s), `play(): Promise`, `pause()`, `stop()`,
`seekToPercentComplete(0..100)`, `loadFromUrl(url, autoPlay)`, `setEqBand(band, 0..100)`,
`disableEq()`, `enableEq()`, `getAnalyser(): AnalyserNode`, `dispose()`.

Events the middleware subscribes to (`js/mediaMiddleware.ts:18-56`): `timeupdate`
(dispatches `UPDATE_TIME_ELAPSED` with `media.timeElapsed()`), `ended` (dispatches `next()`),
`playing` (`IS_PLAYING`), `waiting`/`stopWaiting` (`START_WORKING`/`STOP_WORKING`: the spinner
lamp), `fileLoaded` (`SET_MEDIA`). The middleware also pushes initial volume/balance/preamp at
construction (`mediaMiddleware.ts:12-15`; seen as `setVolume 78, setBalance 0, setPreamp 50`
in probe 1). Nothing else touches audio: grep for `AudioContext|new Audio|createElement("audio")`
outside `js/media/` finds only `js/fileUtils.ts:70` (`genMediaDuration`, reachable only when a
track is added without a `duration`).

**Verified (probe 1, WKWebView and Chrome): with a custom media class Webamp constructed 0
AudioContexts and created 0 `<audio>` elements.** "No audio played by Webamp" holds by
construction (`js/webampLazy.tsx:130`: `new (__customMediaClass || Media)()`).

### 1.3 The shim is necessary but not sufficient: where Webamp's own logic fights MPD

The media class only sees what `mediaMiddleware` forwards. Everything else is reducer-local
state. These are the specific fights, each confirmed in probe 1 unless noted:

1. **Next/previous/end-of-track are decided locally.** `next()` -> `getNextTrackId`
   (`js/selectors.ts:187-225`) -> `playTrack(id)` (`js/actionCreators/media.ts:8-18`) ->
   `PLAY_TRACK` -> `media.loadFromUrl(url, true)` (`mediaMiddleware.ts:80-86`). And
   `media.on("ended")` triggers `next()` (`mediaMiddleware.ts:25-27`). MPD advances on its own,
   so the media class must **never emit `ended`**, and the MPD-idle handler must move
   `currentTrack` itself. `playlist.currentTrack` is settable only via `PLAY_TRACK` /
   `BUFFER_TRACK` (`js/reducers/playlist.ts:131-136`), both of which are forwarded to
   `loadFromUrl`. So the media class needs an idempotence guard ("this songid is already
   MPD's current song: no-op"). Confirmed: clicking `#next` produced
   `loadFromUrl("mpd://songid/102", true)`.
2. **Echo.** Dispatching `PAUSE`/`STOP` to mirror an MPD state change is forwarded back to
   `media.pause()`/`media.stop()` (confirmed: sync dispatches produced `pause`, `stop` calls).
   `IS_PLAYING` and `UPDATE_TIME_ELAPSED` are reducer-only and safe. So the class compares
   against last-known MPD state and drops no-ops. Same for `SET_VOLUME`. `close()` also
   dispatches `STOP` (`js/actionCreators/index.ts:117-119`): reamp needed a `stopGuard` for it.
   Do not call `webamp.close()`; hide the container instead.
3. **Shuffle, repeat and every playlist edit are never forwarded.** `TOGGLE_SHUFFLE`/
   `TOGGLE_REPEAT` only flip booleans (`js/reducers/media.ts:64-67`; no case in
   `mediaMiddleware.ts`); `REMOVE_TRACKS`, `REVERSE_LIST`, `RANDOMIZE_LIST`, `SET_TRACK_ORDER`,
   `DRAG_SELECTED`, `REMOVE_ALL_TRACKS` are pure reducer cases (`js/reducers/playlist.ts:76-143`).
   Confirmed: dispatching them produced no media call. Translating them to `random`/`repeat`/
   `deleteid`/`move`/`shuffle`/`clear` needs a `__customMiddlewares` entry. Because the custom
   middleware runs after `mediaMiddleware` in the chain but **before the reducer**, it can
   swallow an action (not call `next`) and let MPD's `idle: playlist` event drive the real
   state change (by Redux semantics and `store.ts:50-55`; **not run**). Caveat: `mediaMiddleware`
   still runs its post-`next` switch for swallowed media actions, so this only works for the
   playlist/shuffle/repeat actions, not transport.
4. **Honest bitrate/sample rate need a direct dispatch.** `mediaMiddleware.ts:48-55` hard-codes
   `kbps: "128", khz: "44"` on `fileLoaded` and the `tracks` reducer ignores them anyway
   (`js/reducers/tracks.ts:56-65`); `loadMediaFile` with `metaData` lies `44000/192000/2`
   (`js/actionCreators/files.ts:276-278`). The real values come only from a `SET_MEDIA_TAGS`
   dispatch (`tracks.ts:91-116`), which takes `bitrate` in bps and `sampleRate` in Hz and
   formats them Winamp-style (`tracks.ts:9-36`). Verified: `bitrate: 320000` -> "320",
   `sampleRate: 44100` -> "44", `numberOfChannels: 1/2` toggles the MONO/STEREO lights,
   marquee reads `1. Artist - Title (3:35)`, time digits read `01:05` from
   `UPDATE_TIME_ELAPSED {elapsed: 65}`.
5. **Tracks without `duration`/`metaData` trigger network fetches.** `loadMediaFile`
   (`files.ts:223-289`) calls `fetchMediaDuration` (creates an `<audio>`, `files.ts:164-177`,
   `fileUtils.ts:62-87`) and `fetchMediaTags` (music-metadata over the URL) when those are
   missing; an `mpd://` URL would just error. Bypass `loadMediaFile`: dispatch
   `ADD_TRACK_FROM_URL` + `SET_MEDIA_TAGS` yourself, using the **MPD songid as the Webamp track
   id** (ids are plain numbers; `tracks`/`playlist.trackOrder` accept them directly; verified).
6. **Other traps.** `play()` with an empty playlist opens a file dialog
   (`media.ts:24-37`); `pause()` is a toggle that dispatches `PLAY` when not playing
   (`media.ts:39-48`); `playTrack` while stopped dispatches `BUFFER_TRACK` and calls
   `loadFromUrl(url, false)` (`media.ts:8-18`), which MPD cannot "cue", so the media class must
   remember the pending songid and use it on the next `play()`. `REMOVE_TRACKS` removes ids
   from `trackOrder` but never from the `tracks` map (`tracks.ts` has no removal case): reusing
   songids avoids growth. Balance snaps `|x| < 25` to 0 (`media.ts:120-130`) versus the hand
   port's detent of 6 (`src/main.js:86`).
7. **Bulk queue cost is quadratic.** Measured in WKWebView: 1,000 tracks mirrored by per-track
   `ADD_TRACK_FROM_URL`+`SET_MEDIA_TAGS` took 198 ms; 5,000 took 4.6 s. Load the initial queue
   via `__initialState` (`store.ts:37-43`, O(n)) and apply later changes as MPD `plchanges`
   diffs (small). The playlist window itself is windowed
   (`js/selectors.ts:301-307` slices `trackOrder`), so rendering a long queue is cheap.

### 1.4 Mapping tables

Webamp control -> what the media class receives -> MPD:

| Webamp action | Forwarded to | MPD / engine |
|---|---|---|
| play (thunk `PLAY`) | `media.play()` | `play`, or `pause 0` if paused; use pending songid |
| pause (toggle) | `media.pause()` / `play()` | `pause 1` / `pause 0` |
| `STOP` | `media.stop()` | `stop` |
| next/prev, double-click row | `loadFromUrl(url, true)` | `playid <songid>` |
| `SEEK_TO_PERCENT_COMPLETE` | `seekToPercentComplete(p)` | `seekcur <duration * p/100>` |
| `SET_VOLUME` | `setVolume(0..100)` | `setvol` (guard against echo) |
| `SET_BALANCE` | `setBalance(-100..100)` | Rust `set_balance` (`lib.rs:132`) |
| `SET_BAND_VALUE` | `setEqBand(band, 0..100)`; preamp via `setPreamp` | Rust `set_eq` (`lib.rs:127`), needs band remap (1.6) |
| `SET_EQ_ON/OFF` | `enableEq()`/`disableEq()` | Rust bypass flag (not present today) |
| `TOGGLE_SHUFFLE/REPEAT` | not forwarded | custom middleware -> `random`/`repeat` |
| remove/crop/reverse/randomize/sort/drag | not forwarded | custom middleware -> `deleteid`/`move`/`shuffle`/`clear` |

MPD event -> what we dispatch into `webamp.store`:

| MPD fact | Dispatch |
|---|---|
| `state: play` | `IS_PLAYING` (reducer-only) |
| `state: pause` / `stop` | `PAUSE` / `STOP`, media class drops the echo |
| `elapsed` (interpolated client-side) | `UPDATE_TIME_ELAPSED {elapsed}` (`reducers/media.ts:54-55`); the position slider floors to whole seconds (`MainWindow/Position.tsx:8`) |
| `songid`, `Pos` | `PLAY_TRACK {id: songid}` (guarded) or `BUFFER_TRACK` |
| `playlistinfo` / `plchanges` | `ADD_TRACK_FROM_URL`, `SET_MEDIA_TAGS`, `SET_TRACK_ORDER`, `REMOVE_TRACKS` |
| `audio` (44100:16:2), `bitrate` | `SET_MEDIA_TAGS {sampleRate, bitrate*1000, numberOfChannels}` |
| `volume`, `random`, `repeat` | `SET_VOLUME`, `TOGGLE_SHUFFLE`/`TOGGLE_REPEAT` when they differ |

Webamp's repeat is a boolean; MPD's `single`/`consume` have no Winamp control and stay MPD-side.

### 1.5 The visualizer: the finding that shapes the Rust side

The mini visualizer and Milkdrop need different things, and the obvious trick only fixes one.

- **Classic spectrum/oscilloscope (main window, 76x16, `js/components/Vis.tsx:69-70`).** Reads only
  `analyser.getByteTimeDomainData`, sets `fftSize = 1024` (`Vis.tsx:55`), reads
  `frequencyBinCount` (`VisPainter.ts:120`), and runs its own JS FFT (`js/components/FFTNullsoft.ts`,
  `VisPainter.ts:55-68`). It never calls `getByteFrequencyData`. So a **duck-typed object**
  (`{fftSize, frequencyBinCount, getByteTimeDomainData(u8), getByteFrequencyData(u8)}`) is enough:
  verified in probe 1 (duck-typed object accepted and read), and with a real node whose read
  method is patched (reamp's trick) in probe 3 (61 patched calls in 1 s). Input needed: **1024 time-domain bytes (128-centred) per
  frame**, mono is fine. Our current `Frame` (`audio.rs:43-47`: 64 smoothed bands, 256 wave
  floats, level) does **not** contain that; the 64-band data is useless to Webamp.
  The mini vis is disabled while the Milkdrop window is open
  (`js/selectors.ts:569-575` returns `MILKDROP`, `Vis.tsx:127-129` paints nothing).
- **Milkdrop (butterchurn).** Webamp calls `butterchurn.createVisualizer(analyser.context, ...)`
  then `connectAudio(analyser)` (`js/components/MilkdropWindow/Visualizer.tsx:53-69`).
  Butterchurn's `AudioProcessor` connects your node into its own `DelayNode` and three
  `AnalyserNode`s and reads those (`butterchurn@3.0.0-beta.5 dist/butterchurn.js:3069-3127,
  3165-3167`). **Patching your analyser does nothing for Milkdrop. Verified in WKWebView: 0
  reads of the patched node over 3 s while the canvas rendered at ~50 to 55 fps.** Webamp calls
  `visualizer.render()` bare (`Visualizer.tsx:135`), but butterchurn supports
  `render({audioLevels: {timeByteArray, timeByteArrayL, timeByteArrayR}})`
  (`dist/butterchurn.js:11642-11654`, three 1024-byte arrays).

Three ways to feed Milkdrop, cheapest first:

| Option | How | Fork? | Notes |
|---|---|---|---|
| **A. Facade (recommended)** | Wrap `createVisualizer` so `render()` calls `render({audioLevels: ourFrame})` and `connectAudio` is a no-op. Inject via `__butterchurnOptions.importButterchurn` (Webamp dispatches whatever it returns as `GOT_BUTTERCHURN`, `actionCreators/milkdrop.ts:42-44`). | No | **Verified (probe 5):** 191 facade renders in 3.5 s, no errors, and butterchurn's internal `timeByteArray` equalled our fed bytes exactly. Still needs a real (never-running-audio) `AudioContext` for `analyser.context`. The pre-bundled `webamp/butterchurn` entry hard-codes `importButterchurn` (`js/webampWithButterchurn.ts:34-37`), so for production use `webamp/lazy` with our own `__butterchurnOptions` (read from `webampLazy.tsx:100-126,166-172`, **not run**: probe 5 patched `createVisualizer` on the butterchurn object that the bundled entry had put in Redux, which exercises the same `render({audioLevels})` path). |
| B. Real WebAudio pump | Push PCM from Rust into an `AudioWorklet`/scheduled `AudioBufferSourceNode`s feeding the analyser, never connected to `destination`. | No | Verified feasible (probe 4): in WKWebView an analyser fed by a graph with **no path to destination** returns live data (sine min 64 / max 191); `AudioWorklet` and `ScriptProcessor` exist. Costs continuous PCM (below) and a latency buffer. |
| C. Fork `Visualizer.tsx:135` | Pass `audioLevels` directly. | Yes | Not needed given A. |

Rust-side requirement for either: extend `Frame` with `pcm` (the 1024 most recent samples as
`u8`, centred on 128). L/R is wanted by butterchurn (`timeByteArrayL/R`); the tap is mono today
(`audio.rs:60`), duplicating mono into L/R is acceptable for a first cut. Bandwidth over the Tauri
`Channel` at 60 Hz: mono 1024 B = **61 KB/s**, L+R **123 KB/s**. For option B (continuous,
non-overlapping PCM) stereo i16 is 176 KB/s, stereo f32 353 KB/s.

AudioContext note (probe 4, plain WKWebView): created `suspended`, reported `running` ~500 ms
later with no user gesture. Tauri/wry may configure autoplay differently, so verify in-app;
Webamp's own `Media` installs click/keydown resume handlers for this reason
(`js/media/index.ts:117-139`) and a custom class would need the same.

### 1.6 EQ and balance

Webamp's ten bands are fixed at 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k Hz
(`js/constants.ts:11-13`, `js/types.ts:62-72`), values 0..100 mapping to -12..+12 dB
(`js/media/index.ts` `setEqBand`), plus a preamp. The skin art bakes those labels into
`EQMAIN.BMP`. The Rust EQ is WMP-style: centres 31..16000 Hz, +-14 dB, Q 1.41
(`src-tauri/src/eq.rs:7-14`), no preamp, no bypass. For Winamp skins the engine therefore needs a
**per-skin-family band set** (and preamp, and bypass): an `Eq::set_bands(centres)` plus a
preamp gain stage, about a day of Rust. Balance range differs too (Webamp -100..100 with a
+-25 detent, hand port detent 6). Webamp's `.eqf` presets are handled by the separate `winamp-eqf`
package (ISC) and `packages/webamp/presets/builtin.json` (17 factory presets in 0..100 units).

### 1.7 Effort estimates (my estimates, focused engineer-days, someone who already knows this repo)

| Option | Scope | Estimate |
|---|---|---|
| **1. Thin** | Media class only, single synthetic track (reamp pattern); duck-typed analyser; no queue mirror, no playlist edits. Transport, seek, volume, time, marquee, mini vis work. | 2 days |
| **2. Full mirror (recommended)** | 1 + echo/idempotence guards (1.5) + `__initialState` queue and `plchanges` sync with real tags (2 to 3) + playlist-edit/shuffle/repeat middleware (2) + Rust `Frame.pcm` and Milkdrop facade (2) + EQ band-set/preamp/bypass in Rust (1) + vector hit regions (section 2, 1.5) + skin loading/switching (1) + testing across ~10 skins (1 to 2) | 10 to 15 days |
| **3. Fork** | Add `SET_QUEUE`/`SET_CURRENT_TRACK` reducer actions, drop local next/ended logic, let `Visualizer` take external levels. | Saves ~3 days of guards, adds a standing merge cost. Every wall I found has a non-fork workaround, so not justified now. |
| **4. Own renderer** | See section 5. | 3 to 5 weeks to core parity, long tail open-ended |

## 2. Q2: transparent window, free positioning, per-window rectangles and masks

**Yes, it renders into an existing transparent window, and we can derive an exact vector mask
without rasterizing.**

Mounting: `renderInto(node)` (node must be non-static, `js/webampLazy.tsx:497-504`) or
`renderWhenReady(node)` (appends under `document.body`). `#webamp` is `position:absolute; top:0;
left:0` and measures **0x0** (probe 1: `webampRoot {0,0,0,0}`), so it does not swallow clicks
outside the windows (`js/components/App.tsx:80-93` toggles `right/bottom` only during a resize
measurement). Each window is its own `position:absolute` div moved with
`transform: translate(x, y)` (`js/components/WindowManager.tsx:195-199`).

Gotcha, verified: by default `renderInto` **re-centres** the whole layout inside the container
(`centerWindowsInContainer`, `js/actionCreators/windows.ts:107-125`; probe 1 moved a requested
`left:100` to 438). To keep absolute coordinates, dispatch
`{type:'UPDATE_WINDOW_POSITIONS', absolute:true, positions:{main:{x,y},...}}` **before** render:
`reducers/windows.ts:181-187` then sets `positionsAreRelative=false` and centring is skipped.
Probe 2 confirmed exact placement (main at 100,50; EQ at 400,50; playlist at 100,270).

Per-window rectangles (what the click-through mask needs):
- State: `webamp.store.getState().windows.genWindows[id] = {open, shade, size:[w,h], position}`
  and `display.doubled`. The selectors are not exported from the package, so replicate
  `getWPixelSize` (`js/selectors.ts:471-481`): `width = 275 + 25*size[0]`,
  `height = (shade ? 14 : 116 + 29*size[1])`, then x2 if `doubled` and the window `canDouble`
  (main and equalizer only; `reducers/windows.ts:38-80`). Constants:
  `js/constants.ts:41-44`. Verified: playlist with size [2,2] measured 325x174; doubled main
  550x232 while playlist stayed 325x174.
- Subscribe with `webamp.store.subscribe` (or `__onStateChange`, `webampLazy.tsx:556`).
- Region masks: `getSkinRegion` (`js/selectors.ts:766`) = `state.display.skinRegion`, parsed from
  `REGION.TXT` by `js/regionParser.ts:13-50` (INI sections lowercased, `NumPoints` +
  `PointList`, polygons under 3 points dropped) into `{normal, windowshade, equalizer,
  equalizerws}: string[]` of `"x,y x,y ..."` polygons in **window-local, unscaled** pixels
  (`js/components/Skin.tsx:14-26,120-126`). **Only those four exist**: playlist and Milkdrop/gen
  windows are plain rectangles. Applied with `clip-path: url(#...)`; when a window is doubled the
  polygon scales with the element (probe 2). Verified in WKWebView with
  `document.elementFromPoint`: points in the cut corners of an octagonal region hit the page
  underneath, at 1x and 2x, so the DOM hit-testing already agrees with the polygon.
- Winamp 2 skins are BMP (no alpha), so the region polygons plus rectangles are the complete
  shape. PNG sprites are accepted (`skinParserUtils.ts:107`), so a WACUP-style PNG skin could
  carry alpha, which a vector mask would miss; rare, and the hand-port pixel walk could be the
  fallback for those.

Things outside `#webamp` that the mask must include:
- Context menu: portaled to `document.body` as `#webamp-context-menu`, absolutely positioned at
  the click (`js/components/ContextMenu.tsx:15-40`; verified parent is `BODY`). An open menu is a
  rectangle the window list does not know about; observe it (MutationObserver) and add its
  `getBoundingClientRect`.
- Milkdrop "desktop" mode portals a full-screen `.webamp-desktop` node
  (`js/components/MilkdropWindow/Desktop.tsx`); Milkdrop fullscreen uses the Fullscreen API
  (`MilkdropWindow/index.tsx`, gated on `document.fullscreenEnabled`, unverified in Tauri).
  Treat both as "off" for a click-through shell.
- `ClipPaths` appends a 0x0 `<svg>` to `body` (`js/components/ClipPaths.tsx:15-18`): harmless.

Rust side: today `set_hit_mask` takes a full bitmap (`lib.rs:210-213`,
`clickthrough.rs:15-33`) and the hand port rasterizes the DOM into it (`src/main.js:376-407`).
For a screen-sized window that is ~620 KB of bits (3440x1440) sent as a JSON number array,
roughly 2 MB per update while a window is dragged. Replace it for this skin family with a
`set_hit_regions([{x,y,w,h,polygon?}])` command; point-in-rect/polygon in `Mask::hit` is about
30 lines. Dragging uses window-level mouse listeners (`WindowManager.tsx:99-103`), so use the
existing `set_capture(true/false)` on mouse down/up exactly as the hand port does.

Layout and docking (all free in Webamp): drag with edge snapping at 15 px
(`js/snapUtils.ts:3`), main window drags every window docked to it (`WindowManager.tsx:139-144`),
docking is preserved across shade/double toggles by `withWindowGraphIntegrity`
(`js/actionCreators/windows.ts:22-50`), windows are clamped to the parent's size
(`WindowManager.tsx:74-79`, size from `js/utils.ts:376-392`). `ensureWindowsAreOnScreen` has an
"I give up" branch that resets sizes and re-stacks (`windows.ts:310-313`); in a screen-sized
transparent window it will not fire unless the layout cannot fit. Zoom: Webamp only has x2
"double size". For arbitrary zoom (the hand port's 1.5x) prefer native webview zoom over a CSS
transform on a wrapper, because drag math uses raw client coordinates (untested here).

## 3. Q3: dependencies, bundle size, Tauri/WebKit

Dependencies (`packages/webamp/package.json`): react ^19.1, react-dom, react-redux ^8.0.5,
redux ^5.0.0-alpha.0, redux-thunk ^3.1, reselect ^3, classnames, lodash, invariant, tinyqueue,
jszip ^3.10, music-metadata ^11.6, plus workspace packages `ani-cursor` (MIT, animated cursors ->
CSS) and `winamp-eqf` (ISC), and optional butterchurn 3.0.0-beta.5 / butterchurn-presets
3.0.0-beta.4 (both MIT; the presets package is 16.9 MB unpacked). All are `devDependencies`
because rollup bundles them: the published tarball ships only `built/` and has no runtime
dependencies. Note the unusual React 19 + react-redux 8 + redux 5 alpha combination; we would
not own it, only consume the bundle.

Measured from the published 2.3.1 tarball (`built/`, ES modules):

| Entry | Raw | gzip -9 |
|---|---|---|
| `webamp.bundle.min.mjs` (everything incl. JSZip, music-metadata) | 939,426 B | 298,071 B |
| `webamp.lazy-bundle.min.mjs` (`webamp/lazy`) | 577,381 B | 191,751 B |
| `webamp.butterchurn-bundle.min.mjs` (+ butterchurn + 107 presets) | 2,028,329 B | 516,085 B |

Sourcemap attribution of the full bundle (1.79 M source chars): react-dom 29.2%, Webamp's own code
24.8%, music-metadata 19.3% (plus its fflate/file-type/strtok3 deps ~10%), jszip 6.8%.
**Recommended entry: `webamp/lazy`** (`docs 07_guides/03_bundle-size.md`) with
`requireJSZip: () => import('jszip')` (needed for `.wsz`) and a `requireMusicMetadata` that
rejects (we always supply tags, so it is never called; it is a required option by type). Load
butterchurn itself lazily through `__butterchurnOptions.importButterchurn`. Load the whole thing
with a dynamic `import()` only when a `.wsz` skin is chosen, so Headspace users pay nothing.

WebKit/Tauri (all run in a real WKWebView, probe results in the appendix):
- Works and matches Chrome: skin parsing (184 ms for a base-size skin), sprite slicing via
  canvas, `createImageBitmap` (present, with a fallback anyway: `skinParserUtils.ts:62-77`),
  `clip-path: url(#svg)`, range-input thumb styling (`-webkit-slider-thumb`), CSS animations,
  `image-rendering: -webkit-optimize-contrast`, hit-testing through clip paths.
- WebGL2 present (`EXT_color_buffer_float`, `OES_texture_float_linear` true;
  `OES_texture_half_float_linear` false) and butterchurn rendered a fully non-black canvas with
  107 bundled presets.
- Webamp already carries the Safari workarounds (`#webamp .window { -webkit-transform:
  translateZ(0) }` "work around rendering bug with clip-path", `css/webamp.css:111-114`). Open
  upstream Safari issues are about playback or iOS (#125 spectrum amplitude from WebAudio,
  #431 `:active` on High Sierra, #1105/#1279 iOS), all moot when Webamp does not play audio.
- **Unverified, must be checked inside the actual Tauri window:** animated `.ani` cursors
  (`cursor: url(data:...)` via `ani-cursor`), file drag-and-drop of `.wsz`/audio onto the window
  (Tauri's native drop handling may pre-empt DOM `dataTransfer`), Fullscreen API, AudioContext
  autoplay policy under wry's configuration, and whether a running-but-unconnected
  `AudioContext` interferes with the app's own cpal output.
- Skin loading is `fetch()`-based: `setSkinFromUrl` (`js/actionCreators/files.ts:116-129`) is the
  public path and `setSkinFromBlob` is not exported. Hand it a Tauri asset-protocol URL or a
  `blob:` URL created from bytes read by Rust. Skins stay on disk outside the repo.
- `dispose()` is documented as leaky (`webampLazy.tsx:541-554`) and `renderInto` throws if
  called twice (`webampLazy.tsx:512-514`): mount once, hide by CSS, drop its hit regions.
- Licence: code is MIT (`LICENSE.txt`). The README says "the Winamp name, interface, and sample
  audio file are surely property of Nullsoft" (`README.md` "License"). The default skin
  (`assets/skins/base-2.91.wsz`, and its PNGs as data URIs in `css/base-skin.css`) is Nullsoft
  art and ships inside every Webamp bundle. We never copy it into tracked paths, but a built app
  that embeds the bundle carries it. See open questions.

## 4. Assembled integration shape

```
Rust (existing)         Webview page                         Webamp (lazy, mounted once)
audio_subscribe  -----> frame feed (pcm bytes) ------------> duck-typed analyser (mini vis)
(Frame + pcm)                                  \-----------> butterchurn facade render({audioLevels})
mpd idle/status  -----> adapter: state -> store.dispatch --> IS_PLAYING, UPDATE_TIME_ELAPSED,
                                                             ADD_TRACK_FROM_URL, SET_MEDIA_TAGS...
                 <----- IMedia class (guards echo) <-------- mediaMiddleware forwards transport
                 <----- __customMiddlewares (playlist) <---- REMOVE_TRACKS, TOGGLE_SHUFFLE...
set_hit_regions  <----- store.subscribe -> rects+polygons    window positions, region polygons
set_eq/balance   <----- setEqBand/setBalance                 (per-skin band set)
```

Keep a thin `SkinHost` interface in our engine (`mount(container)`, `applyMpdState(state)`,
`onCommand`, `hitRegions()`), so the WMP interpreter and Webamp are interchangeable hosts and
the MPD adapter is written once.

## 5. Q4: if we did not adopt it: what to lift as data, and how big is our own renderer

Everything below is code/data under MIT (Webamp's licence), reusable with attribution. The art
is not (section 3).

| Asset | Size | Use |
|---|---|---|
| `js/skinSprites.ts` | 841 lines | Sprite tables: **212 static sprites on 15 active sheets** (BALANCE 3, CBUTTONS 12, MAIN 1, MONOSTER 4, NUMBERS 12, NUMS_EX 12, PLAYPAUS 5, PLEDIT 60, EQ_EX 12, EQMAIN 22, POSBAR 3, SHUFREP 16, TITLEBAR 27, VOLUME 3, GEN 20) with `{name,x,y,width,height}`. GENEX (16) is commented out (`:757-838`). Plus `FONT_LOOKUP`, 69 glyphs in 5x6 cells in a 3-row grid (`:14-84,86-105`) for TEXT.BMP; and 52 GEN letter sprites generated by pixel scanning. Cross-check: base skin yields 321 slices = 212 + 69 + 52 minus the absent NUMS_EX 12. |
| `js/skinSelectors.ts` | 403 lines | Sprite name -> CSS selector (including `:active`, `.selected`, `.shade`, `.stop` states). |
| `css/main-window.css`, `equalizer-window.css`, `playlist-window.css`, `gen-window.css` | 505 + 196 + 314 + 130 lines (81 + 30 + 50 + 22 rules) | The control coordinates: the Winamp analogue of `headspace.wms`. Window sizes: 275x116 base, shade 14 px, playlist/gen resize steps 25x29. |
| `js/regionParser.ts` | 51 lines | `REGION.TXT` to polygons. |
| `js/utils.ts:89-127` | `parseViscolors` (24 colours), `parseIni` | VISCOLOR.TXT, PLEDIT.TXT. |
| `js/skinParserUtils.ts:154-262` | `getPlaylistStyle`, `getGenExColors` (22 colours at x=48..90 step 2) | PLEDIT.TXT, GENEX.BMP. |
| `js/skinParser.js:10-52,95-139` | 24 cursor names; GEN variable-width font scan | |
| `js/components/EqualizerWindow/spline.js`, `EqGraph.tsx` | spline + graph | EQ response curve, 112 lines. |
| `js/snapUtils.ts`, `resizeUtils.ts` | 183 + 141 lines | Docking/snapping and resize-graph integrity. |
| `js/components/VisPainter.ts`, `FFTNullsoft.ts` | 775 + 203 lines | Winamp-exact spectrum/oscilloscope painters (bar falloff, peaks, colouring). |
| `packages/webamp/presets/builtin.json` | 4.4 KB | EQ factory presets. |
| `packages/winamp-eqf` (ISC), `packages/ani-cursor` (MIT) | small | `.eqf` and `.ani` codecs. |

**Do not lift:** `assets/skins/base-2.91.wsz`, `css/base-skin.css` (data-URI PNGs),
`js/baseSkin.json` images: Nullsoft art.

What the windows are (the renderer's scope), as encoded by Webamp: main (275x116, plus shade
275x14), equalizer (275x116, plus shade), playlist (9-slice frame, resizable by 25x29 steps,
plus shade, scrollbar, five menu groups, track list), gen frame (Milkdrop) with the generated GEN
font, 24 cursors, optional per-window regions, mini visualizer. Controls: title bar buttons
(menu/minimize/shade/close, pressed and inactive states), clutter bar, 5 transport buttons +
eject, time digits, play/pause/work indicators, marquee (31 char, 220 ms step), kbps/khz text,
mono/stereo, volume, balance, position bar, EQ/PL toggles, shuffle, repeat, 10 EQ sliders +
preamp, ON/AUTO/PRESETS, and the context menu.

Size of our own renderer, for comparison: Webamp's window components are 2,232 lines of TSX
(menus are about a third of that) plus shared widgets (`WinampButton` 100, `VerticalSlider` 129,
`ResizeTarget` 86, `DropTarget` 81, `ContextMenu` 118), `WindowManager` 208, `Skin` 155, vis 1,186,
and 2,057 lines of data/parsers plus 1,801 lines of CSS. My estimate for a leaner renderer that
reuses the data tables is **2.5 to 3.5k lines of TS and 3 to 5 weeks** to parity on the core
windows with docking, shade modes, regions, fonts and vis, and then an open-ended tail of skin
quirks that Webamp has accumulated since 2014. Versus Option 2's 10 to 15 days, that is why the
recommendation is to adopt.

## 6. Adjacent finding for the generic-engine effort (not the question asked)

`packages/webamp-modern` (MIT, ~27.6k lines TS/JS, experimental) is a **multi-format skin
engine registry** in the same monorepo, relevant to the owner's "load any skin" goal:
- `packages/webamp-modern/src/skin/SkinEngine.ts:17-52,183`: `SkinEngine` base with
  `canProcess(path)`, `identifyByFile`, `priority`, and `registerSkinEngine`; the class comment says
  "we support multiple skin-formats".
- Engines: `SkinEngine_WindowsMediaPlayer.ts` (593 lines; `.wmz`/`.wms`, `canProcess` at `:33-35`, registered at `:510`)
  plus `wmpClasses/` (13 files, ~1.3k lines: Button, ButtonGroup, Slider, SubView, Text, Theme,
  View, Vis, Player, PlayListGui, ...), `SkinEngine_WinampClassic.ts` (399), `_KJofol`, `_Sonique`,
  `_Cowon`, `_JetAudio`, `_Audion`, `_WAL` (Winamp Modern with a Maki VM, `src/maki/`).
- `assets/winamp_classic/` re-expresses the classic Winamp 2 windows as Wasabi XML (1,562 lines
  across `xml/*.xml`, e.g. `player-normal.xml` has every main-window control with x/y/image
  names) plus `.maki` scripts: classic layout as declarative data, if we ever adopt that model.
- Caveats: the WMP engine is clearly work in progress, and it executes skin JScript by injecting
  a `<script>` element into `document.head` with `;debugger;` appended
  (`wmpClasses/View.ts:107-118`): no sandbox, globals leak onto `window`. Our WMP interpreter
  should not copy that. The `.wms` XML/UTF-16 handling and class list are still worth reading as
  a cross-check against the hand-port oracle. I did not evaluate it beyond reading these files.

## 7. Risks and open questions

Risks (ranked):
1. **Queue/transport sync correctness** (echo loops, pending-songid, swallowed playlist actions):
   the bulk of the work; mitigate with an explicit "MPD is truth" adapter and a state-machine
   test that replays recorded MPD idle sequences.
2. **Private API drift**: `__customMediaClass`, `__customMiddlewares`, raw action names and the
   `webamp.store` shape are unstable by the maintainers' own words. Pin the version, wrap all
   dispatches in one module, add a boot-time self-test (like probe 1) to CI.
3. **WKWebView-in-Tauri differences** not covered by my harness (cursors, DnD, autoplay policy,
   fullscreen); a one-hour in-app smoke test settles them.
4. **Mask staleness** during drags and menu opens: update on every window-position action and
   on the `#webamp-context-menu` mutation; keep `set_capture` during drags.
5. **Quadratic bulk dispatch** for large queues: use `__initialState` + `plchanges` diffs.
6. **Distribution**: the shipped app embeds Nullsoft's base skin art via the Webamp bundle.

Open questions for the owner:
- Is shipping a build that embeds Webamp's bundled Nullsoft default skin acceptable, or should we
  build Webamp from source with a replacement default skin (the CSS is generated by
  `scripts/compileSkin.ts` from a `.wsz`)?
- Should EQ band centres switch per skin family (needs Rust change), or keep WMP centres and
  accept that Winamp skin labels (60/170/310...) will not match the actual filters?
- Do we want Milkdrop at all (butterchurn plus 107 presets adds about 1.1 MB raw / 220 KB gzip over
  the plain bundle: 2,028,329 vs 939,426 B; WebGL2 required) or only the classic mini visualizer? The facade makes Milkdrop cheap, but it is optional.
- Coexistence: one window with two skin hosts (Headspace vanilla DOM and Webamp), or a separate
  webview per host?

## Appendix: probe results (WKWebView unless noted)

Harness: static server (`python3 -I -m http.server --directory`), `test*.html` importing the
published 2.3.1 ES bundles, and `wk.swift` (WKWebView in an alpha-0, click-through, activation-
policy-prohibited window so `requestAnimationFrame` still ticks; prints `#out` when
`document.title == "DONE"`). Not persisted in the repo.

| Probe | Result |
|---|---|
| 1. Custom media + Redux-direct sync (Chrome and WKWebView, identical) | 0 AudioContexts, 0 `<audio>`; queue/tags mirrored; kbps 320, khz 44, stereo lit, marquee `1. Artist - Title (3:35)`, time 01:05; clicks forwarded as `play`/`pause`/`stop`/`loadFromUrl(mpd://songid/102,true)`; `PAUSE`/`STOP` sync dispatches echoed to the media class; `REMOVE_TRACKS`, shuffle/repeat toggles forwarded nothing; region polygons and `<clipPath>` present; main 275x116, doubled 550x232; `#webamp` root 0x0; context menu parent `BODY`; 321 skin images for the base skin |
| 2. Layout, hit-testing, perf | absolute positions preserved when dispatched before render; skin load 184 ms; `elementFromPoint` in an octagon's cut corner hits the page underneath at 1x and 2x; WebGL2 true; AudioContext `suspended` at creation; 1,000 tracks 198 ms, 5,000 tracks 4,609 ms |
| 3. Milkdrop with a patched real analyser | 107 presets, canvas fully painted at ~50 to 55 fps, **0** reads of the patched analyser while Milkdrop is open, 61 reads in 1 s after closing it (mini vis) |
| 4. WebAudio without a speaker path | context `suspended` -> `running` in ~500 ms with no gesture; analyser fed by oscillator or scheduled buffers with no connection to `destination` returned live samples (min 64, max 191); `AudioWorklet` and `ScriptProcessor` present |
| 5. Milkdrop facade | 191 `render({audioLevels})` calls in 3.5 s, no errors, butterchurn's internal `timeByteArray` equal to the fed bytes |
