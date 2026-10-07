# Headspace parity contract

What the .wms interpreter (Phase 1 of the skin engine) must satisfy before the hand port in `src/main.js` can be deleted. The hand port is the oracle for pixels and behaviour. Where the oracle disagrees with the .wms, section 0 says who wins.

Status: research draft, 2026-10-06, branch `skin-engine`, nothing committed. Author: parity research agent.

## Conventions and sources

| Short name | What it is |
|---|---|
| `wms:N` | `headspace.wms` from `~/Downloads/Headspace.wmz` (sha1 `2870d4b1…`, wmz sha1 `f9671f06…`), decoded with `iconv -f UTF-16LE -t UTF-8`. The decode keeps a UTF-8 BOM and CRLF, 523 lines. Line numbers are those of `cat -n` on the decoded text. |
| `hs.js:N` | `headspace.js` from the same zip (sha1 `073d4ffb…`, ISO-8859, CRLF). |
| `main:N`, `widgets:N`, `css:N`, `player:N`, `playlist:N`, `viz:N`, `demo:N` | `src/main.js`, `src/widgets.js`, `src/style.css`, `src/player.js`, `src/playlist.js`, `src/viz/index.js`, `src/demo.js`. |
| `rust:N`, `click:N`, `eq.rs:N`, `audio.rs:N` | `src-tauri/src/lib.rs`, `clickthrough.rs`, `eq.rs`, `audio.rs`. |
| `conv:N` | `tools/convert_skin.py`. |
| MS docs | Microsoft Learn archive pages for the WMP 7 skin reference, cited by URL where used. |

Oracle pin (sha1 prefixes, working tree of `skin-engine`, HEAD `437cbe0`): `main.js 434ea843`, `widgets.js 7814d10f`, `player.js 832f1421`, `playlist.js 75664167`, `style.css 2e306967`, `viz/index.js f7fce284`, `demo.js 4e789edf`, `tauri.conf.json 6da9d4af`, `lib.rs 39a9a3b5`, `clickthrough.rs 952ba343`, `convert_skin.py 93248204`. If any of these change, re-derive the oracle before comparing against it.

Skin art is Microsoft's. Everything below was measured from an unzip in `/tmp/headspace-src`. The measurement scripts live in `/tmp/hs-scripts` and are not committed. Numbers derived from art (pixel counts, hashes) are facts about the art, not art.

## 0. Ground rules and measured facts

### 0.1 Rules of the contract

1. **Precedence.** The engine renders what the .wms and WMP semantics say. The parity harness compares against the hand port and carries an explicit allow-list of hand-port slips (section 2, rows marked FOLLOW-WMS, with line refs). Slips are never baked into the engine silently. If the owner prefers the oracle's look, that is a per-skin override in a sidecar, not engine behaviour.
2. **Run the skin's script as written.** `headspace.js` is executed, bugs included (for example the tooltip bug at `hs.js:112`). The engine must not special-case Headspace function names.
3. **Case-insensitive everywhere.** Attribute names (`wms:293` `backgroundimage`, `wms:495` `backgroundcolor`, vs `backgroundImage` elsewhere), JScript property access (`hs.js:92` `xPlTt.tooltip` vs `hs.js:69` `xEqTt.toolTip`), image file names inside the zip (`EQ_01_DF.bmp`, `L_drwr_open_01_default.bmp`, `left_X_01_default.bmp` vs the lowercased names the hand port uses, `conv:71`, `widgets:6`), and `mappingColor` hex strings (`widgets:118` compares the parsed integer, but `setDisabled('#00FF00')` at `widgets:200` does an exact-case `indexOf` on the key strings, so keys must be normalised).
4. **Subviews nest, and each subview is a compositing layer.** Headspace nests subviews up to three deep: the screen (`wms:116`) and the drop (`wms:135`) inside the head; the ear art and `sEqView` inside `sEqEar` (`wms:185-226`); the frame images inside `sEqView` (`wms:230-249`); the whole PL ear and its panel frames (`wms:435-504`, `wms:477-492`). The engine must support arbitrary SUBVIEW nesting. The MS SUBVIEW page says a SUBVIEW "can contain other skin element except for VIEW, THEME, and other SUBVIEW elements" (https://learn.microsoft.com/en-us/windows/win32/wmp/subview-element), and the zIndex page says "The z index of a VIEW or SUBVIEW is an absolute index, while the z index of a control is relative to the z index of the VIEW or SUBVIEW that contains it", plus "The background bitmap of a VIEW or SUBVIEW has a fixed z index of zero. If you want a control to be behind the background, the zIndex must be set to a negative number", and "BUTTONELEMENT elements use the zIndex of their BUTTONGROUP" (https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-zindex). The skin contradicts the first sentence of each, and the zIndex sentence does not say what a nested subview's z is relative to. Worked arithmetic shows which model is forced:
   - *Reading A, every subview's z is absolute:* screen -2, PL panel -1, drop -1, head background 0. The PL panel then paints above the screen, so the closed-state hole would show the green panel instead of the effects. State 1 fails.
   - *Reading B, nested z is relative to the parent but painting is flat:* screen -2, PL panel -1 + (-1) = -2, tie broken by document order. The PL ear comes after the head in the file (`wms:429` vs `wms:16`), so the panel paints later, above the screen. State 1 fails.
   - *Reading C, the only one that works:* **each subview is a compositing layer. Its children, controls and nested subviews alike, are ordered by z relative to that subview's own background (which sits at 0), then by document order. Only VIEW-level subviews carry an absolute z relative to the view's background.** Under C, `sEqEar` and `sPlEar` (z -1) are whole layers below the whole head layer (z 0), and inside the head layer the screen (-2) and drop (-1) sit below the head background (0). That is exactly what the oracle's DOM order produces. D14 depends on this model.
   Whether a subview clips its children to its own bounds (the screen and the panels, which have explicit width and height) is assumed and not verified against a real WMP.
5. **Keying is per declaration.** `transparencyColor` and `clippingColor` apply only where declared. The hand port keys magenta on every non-map BMP at conversion time (`conv:66-69`) and adds red for `head` and white for `vid_bkgd` (`conv:33-36`). I verified this is pixel-identical for Headspace (0.2), but the engine must key per declaration, because (a) the two attributes mean different things (clipping = transparent and non-clickable; transparency = see-through, and a BUTTON still receives clicks on it, https://learn.microsoft.com/en-us/windows/win32/wmp/button-transparencycolor and https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-clippingcolor), and (b) SLIDER.transparencyColor has no default (https://learn.microsoft.com/en-us/windows/win32/wmp/slider-transparencycolor), so undeclared slider art must not be keyed. `_map` images are never keyed (`conv:66-67`).
6. **The hit mask is part of parity.** The window shape is a fifth artifact per screenshot state (section 4).
7. **The hand port stays in the tree** until all four states pass pixel and mask comparison under the fixture in section 4.
8. **Never track art.** The harness reads the unzip in `/tmp` and the locally generated, gitignored `public/skin/`.

### 0.2 Key-colour census of the Headspace art (measured)

Counts are exact-RGB matches in the decoded 24-bit BMPs.

| File | Size | Magenta FF00FF | Red FF0000 | White FFFFFF | Declared in .wms |
|---|---|---|---|---|---|
| `head.bmp` | 234×394 | 31,487 | 17,909 | 0 | subview `transparencyColor=#FF00FF`, `clippingColor=#FF0000` (`wms:19-20`) |
| `vid_bkgd.bmp` | 216×159 | 0 | 0 | 106 (only other colour is black) | subview `clippingColor=#FFFFFF` (`wms:119`) |
| `viz_drop.bmp` | 174×26 | 352 | 0 | 0 | subview `clippingColor=#FF00FF` (`wms:138`), note clipping, not transparency |
| `left_ear.bmp` / `right_ear.bmp` | 84×170 / 87×170 | 2,265 / 2,291 | 0 | 16 / 17 | `transparencyColor=#FF00FF` (`wms:188`, `wms:451`); the white pixels are art, not keyed |
| `left_drawer_right.bmp`, `right_drawer_left.bmp` | 16×160, 13×160 | 541, 680 | 0 | 0 | `transparencyColor` (`wms:223`, `wms:437`) |
| `L_drwr_*.bmp` (7) / `R_drwr_*.bmp` (7) | 18×66 / 18×67 | 328 / 340 each | 0 | 0 | button `transparencyColor` (`wms:196`, `wms:459`) |
| `pause_0{1,2,3}_*.bmp` | 23×23 | 68 each | 0 | 0 | `transparencyColor` (`wms:68`) |
| `thumb_0{1,2,3}_*.bmp` | 18×9 | 8 each | 0 | 0 | slider `transparencyColor` (`wms:98`) |
| `viz_drop_L_*.bmp` | 22×21 | 7 each | 0 | 0 | button `transparencyColor` (`wms:148`) |
| `horizontal_slider` 15×11, `horizontal_thumb` 9×11, `vertical_slider` 11×15, `vertical_thumb` 11×11 | | 0 | 0 | 1 each (specular highlight) | none declared (`wms:250-416`); pixel (0,0) is dark green, not magenta |
| All other BMPs | | 0 | 0 | 0 (except the one-pixel highlights above) | n/a |

Conclusion: every image that contains magenta has a matching declaration, so keying every file produces identical pixels for this skin. This is hand-port-specific, not WMP-faithful, and the engine must not rely on it for other skins.

### 0.3 head.bmp composition (measured)

- Red (17,909 px): everything outside the head silhouette. Bounding box is the whole bitmap (corners and sides). Clipped: transparent and non-clickable.
- Magenta (31,487 px): the screen hole. Every magenta pixel lies inside the screen rect (head-relative x 9..224, y 59..216); none outside.
- Opaque head art inside the screen rect: 2,535 px (the lip around the hole). Red inside the screen rect: 106 px.
- Those 106 red pixels are exactly the 106 white pixels of `vid_bkgd.bmp` (same coordinates, rows 0..16, the two top corners). 31,487 + 106 + 2,535 = 34,128 = 216×158. So the screen's clipped corners coincide with the head's clipped corners, and nothing visible differs whether the screen is clipped by its own `clippingColor` or by the head.
- Head opaque pixels in total: 42,800.
- Consequence for z-order: the screen (z -2) and the visual drop (z -1) are only visible through the magenta hole, because they paint below the head's own background (z 0).

### 0.4 Values the hand port hardcodes from `jscript:` expressions

The .wms uses `jscript:` layout expressions with a dependency order (volume depends on balance; each eqN depends on eqN-1; reset depends on eq10 and eq1; the Volume label depends on volume). The engine must evaluate them lazily with dependency resolution. Resolved values:

| Expression | wms line | Resolved | Hand port |
|---|---|---|---|
| `volume.left = balance.left + balance.width + 10` | 268 | 8 + 71 + 10 = 89 | `main:99` `8 + 71 + 10` OK |
| `volume.top = balance.top` | 269 | 11 | `main:99` OK |
| Volume label `left = volume.left + 19` | 279 | 108 | `main:106` OK |
| `eq1.left = balance.left + 3` | 288 | 11 | `main:110` `11 + 15*i` OK |
| `eq1.top = balance.top + 33` | 289 | 44 | `main:113` OK |
| `eqN.left = eqN-1.left + 15` | 301-405 (eq2 at 301 through eq10 at 405) | 11, 26, 41, …, 146 | OK |
| `eqN.top = eq1.top` | 302-406 | 44 | OK |
| `reset.left = eq10.left - 6` | 418 | 146 - 6 = 140 | `main:125` `11 + 135 - 6` = 140 OK |
| `reset.top = eq1.top + 83` | 419 | 44 + 83 = **127** | `main:125` `y: 129`. **2 px slip (D20).** |

### 0.5 Absolute geometry in view space (760×394)

Head origin is (261,0). Ear x depends on drawer state: EQ closed x=207, open x=0 (`hs.js:5-6`); PL closed x=277, open x=488 (`hs.js:8-9`). Ear y is 86 for both (`wms:179`, `wms:430`).

| Element | Parent-relative | Size | Absolute |
|---|---|---|---|
| head art | (261,0) | 234×394 | (261,0) |
| screen subview | head (9,59) | 216×158 | (270,59) |
| visual drop (hidden, closed) | head (30,33) | 174×26 | (291,33) |
| visual drop (open) | head (30,59) | 174×26 | (291,59) |
| drop buttons L / R / X (open) | drop (9,3) / (135,3) / (157,8) | 22×21 / 22×21 / 13×13 | (300,62) / (426,62) / (448,67) |
| preset title text (open) | drop (30,6) w105 | | (321,65) |
| minimize/close group | head (101,4) | 29×16 | (362,4) |
| transport group | head (48,31) | 144×25 | (309,31) |
| pause button | head (74,32) | 23×23 | (335,32) |
| EQ button | head (15,214) | 20×19 | (276,214) |
| PL button | head (204,214) | 19×20 | (465,214) |
| seek slider | head (39,223) | 163×9, thumb 18×9, travel 145 | (300,223) |
| theme button | head (101,232) | 35×31 | (362,232) |
| EQ ear | (ex,86) | 269×170 | closed (207,86), open (0,86) |
| `left_ear` / `left_drawer_top` / `left_drawer_bottom` / `left_drawer_right` | ear (0,0) / (84,0) / (84,150) / (251,0) | 84×170 / 167×10 / 168×10 / 16×160 | |
| EQ handle / EQ close | ear (8,66) / (72,7) | 18×66 / 11×11 | closed handle (215,152); open handle (8,152), close (72,93) |
| EQ panel (`sEqView`) | ear (84,10) | 171×140 | open (84,96)-(255,236) |
| EQ frame images left / top / bottom / right | panel (0,0) / (10,0) / (10,137) / (166,0) | 10×140 / 157×11 / 157×3 / 5×140 | |
| Balance / Volume sliders | panel (8,11) / (89,11) | 71×11 each | open (92,107) / (173,107) |
| "Balance" / "Volume" labels | panel (25,22) / (108,22) | | open (109,118) / (192,118) |
| EQ bands 1..10 | panel (11+15·i, 44) | 11×76 | open (95+15·i, 140) |
| PL ear | (px,86) | 272×170 | closed (277,86), open (488,86) |
| `right_drawer_left` / `right_drawer_top` / `right_drawer_bottom` / `right_ear` | ear (0,0) / (13,0) / (13,150) / (185,0) | 13×160 / 172×10 / 172×10 / 87×170 | |
| PL handle / PL close | ear (185+61,65) / (185+4,7) | 18×67 / 11×11 | closed handle (523,151); open handle (734,151), close (677,93) |
| PL panel | ear (13,10) | 172×140 | open (501,96)-(673,236) |
| PL frame images left / top / bottom / right | panel (0,0) / (10,0) / (10,137) / (167,0) | 10×140 / 157×11 / 157×3 / 5×140 | |

Note the EQ right frame image sits at x=166 and overlaps the top image's last column (top spans 10..166 inclusive); the PL panel is one pixel wider so its right image at 167 does not overlap. Reproduce both as drawn.

### 0.6 Paint order of the oracle (bottom to top)

1. EQ ear (z -1, first in document): panel with frame images, then `left_ear` (with handle and close at z 1 inside it), `left_drawer_top`, `left_drawer_bottom`, `left_drawer_right`.
2. PL ear (z -1, second): panel with frame images and the playlist, then `right_drawer_left`, `right_drawer_top`, `right_drawer_bottom`, `right_ear` (with handle and close).
3. Head subview (z 0), inside it: screen (z -2: `vid_bkgd`, effects canvas, nowPlaying/notice/caption in the hand port), visual drop (z -1), head background (z 0), then the z 2 group (minimize/close, transport, EQ button, PL button, seek, theme button), then pause (z 3).

This is Reading C from rule 4 in 0.1. DOM order in `main.js` matches this: `eqEar` (`main:54`), `plEar` (`main:140`), `head` (`main:164`) with `screen` (`main:167`), `visDrop` (`main:183`), head art (`main:191`), then the controls (`main:253-302`).

## 1. Feature map: .wms / headspace.js element to hand-port realisation

"Hand port" says how `main.js` and `widgets.js` do it today. Class letters are defined in section 2.

### 1.A View, window, scripting

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| A1 | View 760×394, no title bar, not resizable, no background colour | `wms:8-15` | Transparent, undecorated, non-resizable, shadowless Tauri window 760×394 (`tauri.conf.json:18-25`, `macOSPrivateApi` at `:13`). `#skin` is 760×394 at 0,0 with `transform-origin: 0 0` (`css:30-37`). |
| A2 | Width switches 549 closed to 760 when the playlist opens | `hs.js:16-17`, set at `hs.js:96`, reset at `hs.js:130` | Not honoured: window is always 760 wide (D13). The 211 px right of the closed head is transparent and click-through via the mask. |
| A3 | `scriptFile="headspace.js;res://wmploc/RT_TEXT/#132"` | `wms:12` | n/a (script is hand-ported). Engine must load `headspace.js` and ignore `res://` entries (416 occurrences of `res://wmploc.dll/rt_text/#132` in the corpus, see the RES line of `corpus-census.txt`). |
| A4 | `onLoad="Init();"` | `wms:13`, `hs.js:21-31` | Boot sequence `main:582-590`: restore drawer states by calling the toggles (animates at launch), `setZoom`, `applyPins`, mask, `player.start()`. `Init`'s `visEffects.current* = mediacenter.effect*` is the `Viz` constructor reading `localStorage.preset` (`viz:46-52`). `vidIsPlaying` is always false, so `EndVideo()` semantics apply: effects visible. Column resize modes (`hs.js:23-24`) are baked into `playlist.js` CSS. |
| A5 | `onClose="OnClose();"` persists effect type and preset | `wms:14`, `hs.js:33-37` | Persisted on every `step` (`viz:80-83`), not on close. |
| A6 | `view.minimize()` / `view.close()` | `wms:31`, `wms:36` | `win.minimize()` / `win.close()` (`main:257-258`). |
| A7 | Window drags by any skin pixel that is not a control (no title bar) | implicit | `draggable()` on ear art (`main:42-48`, `main:60-65`, `main:147-152`); head via the capture handler and root handler (`main:189-232`). Panels, drop art, buttongroup non-button pixels and the seek bar background do not drag (D29). |
| A8 | Tooltip strings kept in hidden TEXT elements `xEqTt`, `xPlTt`, `xVisTt`; script reads `.toolTip` and `.value` | `wms:507-521`, `hs.js:69,78,92,102,112,119` | Tooltips set directly via `title` (`main:318-320`, `main:337-339`). Engine: hidden elements must exist (`enabled=false`, `visible=false`) and be script-readable. |
| A9 | `jscript:` layout expressions | `wms:268-269,279,288-289,301-406,418-419` | Resolved to literals (0.4). |

### 1.B Head subview and clipping

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| B1 | Head subview at (261,0), background `head.bmp` | `wms:16-19` | `head` div 234×394 (`main:164`) holding `<img>` `head.png` (`main:191`). |
| B2 | `clippingColor="#FF0000"`: red is transparent and non-clickable | `wms:19` | Baked to alpha 0 at conversion (`conv:33-36`, `conv:39-49`). Click-through comes from the hit mask (`main:380-408`, `click:45-77`). |
| B3 | `transparencyColor="#FF00FF"`: magenta is see-through to what is behind in z-order | `wms:20` | Baked to alpha 0 at conversion (`conv:69`). |
| B4 | Negative-z children paint below the head's background and show through the magenta hole | screen `wms:116` (z -2), drop `wms:135` (z -1) | DOM order only (`main:167`, `main:183`, then head art `main:191`). No CSS z-index. |
| B5 | Head art receives clicks where opaque; the hole passes clicks to what is under it | implicit | Art is `pointer-events: none` (`main:192`). Two handlers emulate picking: a capture handler on `#skin` that drags when the press target is inside ears, screen or drop and `headAlpha(x,y) > 16` (`main:193-227`), and a bubble handler that drags when the target is `#skin` or `head` (`main:228-232`). `headAlpha` hardcodes the origin 261 and size 234×394 (`main:196-206`). |

### 1.C Screen, effects, video

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| C1 | Screen subview at head (9,59) 216×158, background `vid_bkgd.bmp` (216×159 black, 106 white corner pixels), `clippingColor=#FFFFFF`, z -2 | `wms:116-120` | `#screen` div (`main:167-168`, `css:125-128`, `overflow: hidden`) with `vid_bkgd` image (`main:169`). |
| C2 | `effects` control 216×158, initially hidden, shown by `EndVideo()` | `wms:121-126`, `hs.js:54-59` | One WebGL canvas 216×158 (`main:170-172`), always visible, `image-rendering: auto` override (`css:48-50`), masked by `vid_bkgd.png` at its natural 216×159 (`css:130-135`; the mask is not stretched, row 158 is simply unused). The mask applies to the canvas only, not to nowPlaying/notice/caption (D26). |
| C3 | `currentEffectType` / `currentPreset` bound to `mediacenter.*`; `previous()` / `next()` | `wms:123-124`, `wms:149,158`, `hs.js:25-26` | `Viz` presets (5: PointCloud, Chorus, Ring, Warp, Ribbon, `viz:23`); index persisted under `preset` (`viz:46-52`, `viz:80-83`); `step(±1)` wraps (`viz:77-85`). |
| C4 | `video` control at (12,11) 193×135, hidden; `OnVideoStart` / `OnVideoEnd` call `StartVideo` / `EndVideo` | `wms:127-132`, `hs.js:39-59`, `hs.js:28-30` | Absent. MPD has no video. `StartVideo` hides the effects and, if the chooser is open, closes it (`hs.js:43-46`); `ToggleVisView` refuses to open while `vidIsPlaying` (`hs.js:115`). All dead for MPD but the engine needs a `video` stub that never fires (D19). |
| C5 | Click on the screen | not in the .wms | Canvas `click` calls `viz.step(1)` (`main:238`), tooltip "Click for the next visualization" (`main:170`) (D25). |

### 1.D Visualization chooser (`visDrop`)

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| D1 | Subview `visDrop` at head (30,33), `viz_drop.bmp` 174×26, `clippingColor=#FF00FF`, z -1, `visible=false`, `onEndMove=VisDropOnEndMove` | `wms:135-141` | `#visDrop` div, class `abs hidden`, at (30,33) (`main:181-186`), image `viz_drop` (`main:185`); the 352 magenta pixels are alpha 0. |
| D2 | Buttons: previous (9,3), next (135,3), close (157,8), all z 1; previous and next call `visEffects.previous()` / `.next()`, close calls `ToggleVisView()` | `wms:142-169` | `main:240-251`. Disabled art is wired but never used. |
| D3 | Text at drop (30,6) width 105, centred, z 2, value `visEffects.currentPresetTitle` | `wms:170-174` | `#presetTitle` (`main:186`, `css:190-202`), set from the `Viz` `onPresetChange` callback (`main:234-237`). Font 9px black with ellipsis (D21). |
| D4 | `ToggleVisView`: close = `moveto(left, 33, 120)`; open = `visible=true`, `moveto(left, 59, 120)`; both set `vis.upToolTip = xVisTt.value`; `VisDropOnEndMove` sets `visible = visIsOpen` | `hs.js:107-122`, `hs.js:140-147` | `toggleVis` (`main:348-357`): open removes `hidden`, then after two `requestAnimationFrame`s sets `top: 59px`; close sets `top: 33px`. `#visDrop { transition: top 120ms linear }` (`css:66-68`). `transitionend` hides it when closed (`main:358-360`). `moveTo` is linear and its third argument is milliseconds (https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-moveto), so 120 ms linear is correct. `visOpen` is not persisted. |
| D5 | `vis` button element `#0000FF` in the transport group, tooltip "Open visualization chooser", `onClick=ToggleVisView()` | `wms:57-61` | Transport map entry `'#0000FF'` (`main:270`). Tooltip never changes (D15). |

### 1.E Buttons and button groups

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| E1 | Minimize/close group at head (101,4) z 2; `mappingImage` plus four state images (29×16); elements `#FF00CC` minimize and `#CC0066` close | `wms:22-39` | `buttonGroup(head, …)` (`main:253-260`). |
| E2 | Transport group at head (48,31) z 2; 144×25; elements `prevelement #FF0033`, `playelement #FFFF00`, `stopelement #00FF00`, `nextelement #00FFFF`, `buttonelement #0000FF` | `wms:40-62` | `buttonGroup(head, …)` (`main:262-272`); actions in `player.js:107-116`: previous = `previous`, play = `pause 0` if paused else `play`, stop = `stop`, next = `next`. Predefined element defaults (tooltip, `enabled="wmpenabled:player.controls.X"`, `cursor="system"`): https://learn.microsoft.com/en-us/windows/win32/wmp/stopelement, https://learn.microsoft.com/en-us/windows/win32/wmp/nextelement, https://learn.microsoft.com/en-us/windows/win32/wmp/prevelement. |
| E3 | Buttongroup rendering: one art strip, the map image says which pixel belongs to which button, each button lights independently | `wms:22-62` | `widgets:102-207`. Loads map plus four state images, builds `owner[]` by exact RGB match of the map (`widgets:116-122`), draws a `<canvas>` of the group size compositing per pixel: owned pixels from the owner's current state layer, unowned pixels from the up layer (`widgets:133-143`, `widgets:129-132`). State per button: disabled over down (needs press and hover on the same button) over hover over up (`widgets:147`). Hit test by map pixel under the pointer (`widgets:154-160`). Click fires on `pointerup` over the same button that received `pointerdown` (`widgets:186-194`). Tooltip is the element's `title` (`widgets:151`). Cursor default (`widgets:152`). |
| E4 | Stop element is disabled when nothing can be stopped | predefined `enabled=wmpenabled:player.controls.stop` | `transport.setDisabled('#00FF00', state === 'stop')` on each `status` (`main:418`). Prev, next and play are never disabled (D16). |
| E5 | Pause button at head (74,32), z 3, over the play element; `visible` bound to `wmpenabled:player.controls.pause`; magenta corners (68 px) transparent | `wms:63-70` | `button(head, …)` after the transport group so it paints above (`main:274-278`); `pauseBtn.visible = state === 'play'` (`main:417`); action `pause 1`. The `<img>` box is 23×23 and receives clicks on its transparent corners, which is correct for transparencyColor buttons (button doc quoted in 0.1). |
| E6 | EQ and PL buttons at head (15,214) / (204,214), z 2, four states, tooltips swap with drawer state | `wms:71-90` | `main:280-287`; tooltips swapped in `toggleEq` / `togglePl` (`main:318-320`, `main:337-339`). Disabled art unused. |
| E7 | Simple BUTTON states | all `<button>` | `widgets:44-95`: images for up, hover, down, disabled; fallback chain `hover ?? up`, `down ?? hover ?? up`, `disabled ?? up` (`widgets:46`). All state images preloaded (`widgets:50`). `pointerdown` stops propagation (so the window does not drag) and sets pointer capture in a try/catch (`widgets:58-68`). Click on `pointerup` if still over (`widgets:69-76`). Buttons never call `set_capture` (D30). |
| E8 | Theme button "Return to Full Mode" at head (101,232), z 2, `onClick="view.returnToMediaCenter();"` | `wms:107-114` | Repurposed: toggles zoom 1 / 1.5 (`main:298-302`). Tooltip "Toggle size". (D3) |

### 1.F Seek slider

| # | Feature | .wms | Hand port |
|---|---|---|---|
| F1 | Geometry: left 39, top 223, no width or height, so sized from `backgroundImage="progressbar.bmp"` (163×9); thumb 18×9; `transparencyColor=#FF00FF` | `wms:91-99` | `slider(head, {x: 39, y: 223, background, foreground, thumb})` (`main:289-296`). Constants `thumbW = 18`, `thumbH = 9`, `trackLen = 163`, box 163×9 are hardcoded (`widgets:229-232`), not read from the images. |
| F2 | `slide="false"`: the foreground image does not move, it is revealed in place over the background | `wms:93` | Foreground image inside a `clip` div of height 9 and `overflow: hidden`, width grown from 0 (`widgets:225-228`, `widgets:263`). This is the `slide=false` model: https://learn.microsoft.com/en-us/windows/win32/wmp/slider-slide |
| F3 | `useForegroundProgress="true"`, `foregroundProgress="wmpprop:player.network.downloadProgress"`: foreground tracks download progress (percent 0..100) and the thumb is constrained to that region | `wms:103-104` | Ignored. Clip width is the thumb centre, `round(f * 145 + 9)` px (`widgets:263`), so the pink foreground is revealed up to the playhead. D2. Semantics: https://learn.microsoft.com/en-us/windows/win32/wmp/slider-foregroundprogress and https://learn.microsoft.com/en-us/windows/win32/wmp/slider-useforegroundprogress |
| F4 | `min=0`, `max=wmpprop:player.currentmedia.duration`, `value=wmpprop:player.controls.currentposition` | `wms:99-101` | Fixed range 0..1000 normalised by duration: `seek.value = elapsed / duration * 1000` every animation frame while not dragging (`main:462-468`); `player.elapsed` extrapolates between status events (`player.js:92-97`). |
| F5 | `onDragEnd="player.controls.currentposition=value;"` | `wms:102` | `onChange` on release: `player.seek(v / 1000 * duration)` if duration > 0, MPD `seekcur` (`main:293-295`, `player.js:115`). A plain click (press and release) seeks on release. |
| F6 | `borderSize="9"` | `wms:99` | Thumb travel is `trackLen - thumbW = 145` (`widgets:245`); fg width is `round(f*travel + thumbW/2)`. Here the two readings of borderSize coincide (9 = 18/2). See D34 for the other sliders. |
| F7 | `toolTip="Seek"` | `wms:92` | `title` on the slider box (`widgets:216`). |

### 1.G Equalizer ear (`sEqEar`)

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| G1 | Subview `sEqEar` at (207,86) 269×170, z -1, `backgroundColor=none`, `transparencyColor=#FF00FF`, `onEndMove=EqOnEndMove` | `wms:178-184` | `eqEar` div (`main:54`) with `.ear { transition: left 120ms linear }` (`css:60-64`). `EQ_CLOSED = 207`, `EQ_OPEN = 0` (`main:52-53`). |
| G2 | Ear art: `left_ear` at (0,0) (with handle and close inside), `left_drawer_top` (84,0), `left_drawer_bottom` (84,150), `left_drawer_right` (251,0) | `wms:185-225` | Images `main:61-64`, all `draggable` (window drag). |
| G3 | Handle button at ear (8,66), z 1, swaps images and tooltip on toggle; close button at (72,7), z 1, initially hidden, no down image | `wms:190-208`, `hs.js:66-69,75-78` | `main:67-74`, image swap via `eqHandle.images = …` (`main:317`). Close has no down image, so down falls back to hover (`widgets:46`). |
| G4 | `ToggleEqView`: open sets `sEqView.visible = bEqClose.visible = true` immediately and moves to 0; close moves to 207 and hides nothing until `EqOnEndMove` sets both to `eqIsOpen` | `hs.js:61-81`, `hs.js:134-138` | `toggleEq` (`main:310-322`): open unhides panel and close at once and sets `left`; `transitionend` hides panel and close when closed (`main:323-327`) and refreshes the mask. Matches the .wms. State persisted as `eqOpen` (`main:321`). |
| G5 | `sEqView` panel at ear (84,10) 171×140, `backgroundColor=#285F03`, z -1, initially hidden, with four frame subviews (left (0,0), top (10,0), bottom (10,137), right (166,0)) | `wms:226-249` | `eqPanel` (`.panel`, `css:70-74`, `main:55-59`). |
| G6 | Balance slider: tiled, `borderSize=7`, width 71 at panel (8,11), −100..100, `horizontal_slider.bmp` (15×11) plus `horizontal_thumb.bmp` (9×11), bound to `player.settings.balance` | `wms:250-260` | `slider(eqPanel, …)` (`main:82-94`). Tiled track is a CSS `border-image`: `url(horizontal_slider.png) 0 7 fill / 0 7px repeat` with `border-width: 0 7px`, height 11 (`css:83-88`). The 7 is `borderSize`, hardcoded. Vertical equivalent `css:90-95`. Balance state is local (`balanceVal`, `main:78`) and goes to Rust `set_balance` (`main:80`), not MPD. Detent and snap-back (D17). |
| G7 | Volume slider: same art, left `jscript` = 89, 0..100, `value_onchange` sets volume and clears mute | `wms:267-277` | `main:97-106`: input debounced 40 ms to MPD `setvol` (`main:102-103`); slider follows MPD while not dragging (`main:420`). Mute does not exist. |
| G8 | Labels "Balance" at (25,22) and "Volume" at (108,22), `foregroundColor=#77CE07`, `fontSize=7` | `wms:261-266`, `wms:278-283` | `.label` divs (`main:95`, `main:106`, `css:97-103`), 9px, colour `--label #77ce07`. fontSize is in points (default 10, https://learn.microsoft.com/en-us/windows/win32/wmp/text-fontsize); 7 pt is 9.33 px, the hand port uses 9 px (`round(pt*4/3)` reproduces it). |
| G9 | Ten vertical sliders `eq1..eq10`: tiled, `borderSize=7`, height 76, −14..14, `vertical_slider.bmp` (11×15) plus `vertical_thumb.bmp` (11×11), `value=wmpprop:eq.gainLevelN`, `value_onchange` sets it | `wms:287-416` | `FREQS.map` (`main:108-124`), x = 11 + 15·i, y = 44; vertical track `css:90-95`; `onInput` stores the gain and calls `set_eq` with all ten (`main:116-119`); `onChange` persists `eq` (`main:120`). Slider tooltip adds the frequency (D1). |
| G10 | `equalizerSettings id="eq" enableSplineTension="true"` | `wms:285` | No element. Gains go to Rust `set_eq`. DSP is ten independent RBJ peaking biquads, Q 1.41 (`eq.rs:13`, gains clamped ±14 dB at `eq.rs:75`); spline tension is not modelled. |
| G11 | `reset` text, underlined, `#DDDDDD`, 7 pt, hand cursor, `onClick="eq.reset();"`, tooltip | `wms:417-426` | `.link` div at (140,129) (`main:125`, `css:115-121`); on `pointerdown` zeroes all bands, sends, persists (`main:126-132`). y is 129, the .wms says 127 (D20). |

### 1.H Playlist ear (`sPlEar`)

| # | Feature | .wms / headspace.js | Hand port |
|---|---|---|---|
| H1 | Subview `sPlEar` at (277,86) 272×170, z -1, `backgroundColor=none`, `onEndMove=PlOnEndMove` | `wms:429-434` | `plEar` div (`main:140`), `PL_CLOSED = 277`, `PL_OPEN = 488` (`main:138-139`), same 120 ms linear transition (`css:60-64`). |
| H2 | Ear art: `right_drawer_left` (0,0), `right_drawer_top` (13,0), `right_drawer_bottom` (13,150), `right_ear` (185,0) z 0 holding handle (61,65) and close (4,7) | `wms:435-472` | `main:147-160`; close button down state falls back to hover. |
| H3 | Panel at ear (13,10) 172×140, z -1, `#285F03`, four frame images | `wms:473-492` | `plPanel` (`.panel`, `main:141-145`). |
| H4 | `<playlist id="pl">` 172×140, `backgroundcolor=#285F03`, `foregroundcolor=white`, `columnsVisible=false`, `columns="name=Name;Duration=Time"`, `dropDownVisible=true`, `playlistItemsVisible=true`, `visible=false`; script: column 0 stretches, column 1 auto-sizes | `wms:493-503`, `hs.js:23-24` | `buildPlaylist(plPanel)` (`main:146`, whole of `playlist.js`): Windows 2000 combo box on top, two-column list, no header (D12). |
| H5 | `TogglePlView`: close hides `pl` immediately then moves to 277; open sets `view.width = 760`, shows `bPlClose`, moves to 488; `PlOnEndMove` sets `pl.visible = bPlClose.visible = plIsOpen` and on close `view.width = 549` | `hs.js:83-105`, `hs.js:124-132` | `togglePl` (`main:329-341`) un-hides the whole panel, playlist included, at the start of opening and hides it at `transitionend` (`main:342-346`). `view.width` ignored. D13, D14. |

### 1.I Cross-cutting engine semantics the Headspace skin exercises

| # | Semantic | Evidence | Hand port |
|---|---|---|---|
| I1 | Tooltips from `upToolTip` (buttons, elements) and `toolTip` (sliders, text) | `wms:58,73,83,92,108,…` | Native `title` attributes. |
| I2 | Hover and down images, per-state | all buttons | `widgets:44-95`, `widgets:102-207`. |
| I3 | Hand cursor on `reset`; all other controls default cursor | `wms:423` | `.link { cursor: pointer }` (`css:120`); everything else `cursor: default` (`css:25`, `widgets:152`). |
| I4 | Default text: 10 pt, black, Windows system font | text docs (`text-fontsize`, `text-foregroundcolor`, `text-fontface`) | `body { font: 9px Tahoma, Verdana, sans-serif; -webkit-font-smoothing: none }` (`css:26-27`). |
| I5 | Pixel art is never smoothed | n/a | `#skin img, #skin canvas { image-rendering: pixelated }` (`css:39-46`); `#viz` overrides to `auto` (`css:48-50`). |
| I6 | Images decode and cache before first use | n/a | `widgets:50` preloads state images; `buttonGroup` awaits its five images (`widgets:103`) and `main.js` awaits each group in order, so document order survives async loading. |
| I7 | `tabStop="wmpenabled:player.controls.play"` | `wms:50` | Ignored. No Tab focus order. |

## 2. Deviations of the hand port from the .wms

Classes:

- **(a)** must be reproduced by the engine as WMP semantics.
- **(b)** app-level feature the host provides around any skin.
- **(c)** Headspace-specific hack: drop it, or turn it into a generic mechanism.

Phase-1 treatment: **REPRODUCE** (engine output must match the oracle), **FOLLOW-WMS** (engine follows the .wms, harness allow-lists the difference), **HOST** (host-provided, visuals must match the oracle), **DROP**.

| ID | Hand-port behaviour | .wms / WMP reference | Class | Phase-1 treatment and engine requirement |
|---|---|---|---|---|
| D1 | EQ frequency labels under the ten sliders: 7 px, `#77ce07`, 15 px wide, centred, at y=121 (`main:108-111`, `css:105-113`); slider tooltips add "(32Hz)" etc. (`main:114`). Label text 32, 63, 125, 250, 500, 1K, 2K, 4K, 8K, 16K disagrees with the DSP band centres 31, 62, 125, … (`eq.rs:7-9`). | Not in the .wms. Tooltip is constant "Graphic equalizer control" (`wms:291`). | (c) | REPRODUCE through a generic skin-sidecar overlay mechanism (declarative extra elements shipped next to the .wmz, never inside it). Labels must come out pixel-identical in state 2. Tooltip suffix: FOLLOW-WMS. Phase 1 keeps the label text exactly as drawn (32, 63); the 32/31 and 63/62 mismatch with the DSP is a separate decision for the owner, not a parity change. |
| D2 | Seek foreground is revealed up to the thumb centre (playhead) (`widgets:263`). | `useForegroundProgress=true` and `foregroundProgress=downloadProgress` (`wms:103-104`): per MS docs the foreground tracks download progress and the thumb is constrained to it. On a local file that is presumably 100 percent, i.e. a fully pink bar. Not verified in a real WMP. | (a) plus (b) | REPRODUCE. Engine implements `slide`, `useForegroundProgress`, `foregroundProgress` as specified. The host supplies `player.network.downloadProgress` (100 for local MPD files). To match the oracle, the Headspace compat layer maps the foreground reveal edge to the thumb centre. Do not bind `downloadProgress` to the playhead: that would also clamp the thumb and block forward seeking. Record in the sidecar so another skin does not inherit it. |
| D3 | "Return to Full Mode" repurposed to toggle zoom 1 / 1.5 (`main:298-302`). | `view.returnToMediaCenter()` (`wms:112`); returnbutton in 26 corpus skins. | (b) | HOST. Host-defined action table for `returnToMediaCenter`, default: zoom toggle. Tooltip: the skin's `upToolTip` ("Return to Full Mode") is the WMP truth; "Toggle size" is the hand port's. FOLLOW-WMS on tooltip text unless the owner objects. |
| D4 | Now-playing overlay: title (bold 10 px, white, 1 px black shadow) and artist (85 percent opacity) at the bottom of the screen, 4.5 s, 600 ms fade, on each song change (`main:173`, `main:432-437`, `css:137-160`). | Not in the .wms. | (b) | HOST. Generic "track toast" drawn over the effects/video surface of any skin, clipped by the screen's clipping mask. Appears at `left/right: 16px; bottom: 14px` of the 216×158 surface in Headspace. |
| D5 | Notice text: "Waiting for MPD…" or the routing error from `engine_info` (`main:175`, `main:448-459`, `css:162-173`), centred, colour `--label`. | Not in the .wms. | (b) | HOST. Overlay on the effects surface. Colour `#77ce07` is Headspace's label green (`wms:263`); give the host a theme-colour fallback for other skins. |
| D6 | Caption strip for presets that talk: grey 92 percent box, 15 px Helvetica, centred at bottom 10 px (`main:177`, `viz:70-75`, `css:176-188`). | Not in the .wms. | (b) | HOST. Host owns the caption element, still passed to `Viz` (4.2). |
| D7 | Album-art palette drives visualization colours via Rust `palette` (`main:412-446`), with a stale-result guard (`paletteFor === file`). | Not in the .wms. | (b) | HOST. Independent of the skin. |
| D8 | Window menu on right-click, Control-click or Option-click: Keep on Top, Show on All Desktops, Larger/Normal Size (`main:484-535`). | WMP skins can define their own menus (`popup`, `automenu`; 6 and 8 corpus skins). | (b) | HOST. Menu must not break skins that handle `onmousedown` or `onkeydown`: skin first, host default second. Alt-click is captured before everything (`main:526-535`). |
| D9 | Keyboard: Space toggle, ←/→ seek ±5 s, ↑/↓ volume ±5, V next visualization (`main:471-483`). Modifier keys are ignored (Cmd-V also triggers). With volume −1 (no mixer), ↑ sends `setvol 4` (`main:477`). | Skins implement `onKeyDown` in script (corpus: `onkeydown` 655 uses). | (b) | HOST. Skin handlers first, host defaults on unhandled keys. Fix the modifier and −1 issues when moving the code. |
| D10 | Head art `pointer-events: none` plus two root handlers and an alpha-tested drag (`main:189-232`). | Implicit in z-order and clipping semantics. | (c) to (a) | Replace with one generic picker: walk elements top-down in paint order, skip pixels that are clipped or whose image alpha is 0 where the element does not receive clicks on transparency, first hit wins; unclaimed opaque skin pixels drag the window. Threshold today is alpha > 16 (`main:207`); with binary-keyed art any non-zero alpha is equivalent. |
| D11 | Hit-mask rasterisation: walk the DOM, draw images by alpha, fill rects for `.panel` and `data-rect` elements, threshold alpha > 16, send 1-bit LSB-first row-major bits plus zoom (`main:375-408`). Refreshed only on `transitionend` of the ears, `setZoom`, `load` and a 300 ms timer (`main:326`, `main:345`, `main:372`, `main:586-587`). | WMP derives the window region from clipping. | (b) | HOST. Engine produces the composite alpha of the whole view and the host turns it into the mask. Known defects of the oracle, none to be copied: canvas filled as a solid rect, so the 106 clipped corner pixels of the screen count as solid (reference emulation: 34,128 rect pixels vs 34,022 visible); `drawImage` ignores `overflow: hidden`, so the 216×159 `vid_bkgd` is drawn one row taller than the 158 px screen (no net effect: `head.bmp` is opaque across the whole screen width at that row, checked, so the mask bits are unchanged); the mask is stale for up to 120 ms while an ear slides; bits sent as a JSON number array (`Array.from(bits)`, 37,430 numbers). |
| D12 | Playlist drawer content is a hand-built Windows 2000 widget: combo box with a two-ring bevel, white-on-navy value, arrow button, drop list (`css:288-368`), list rows 14 px / 11 px font (`css:217-243`), Win2000 scrollbar (`css:251-285`), now-playing row `#a9ff2b`, selection `#1c4702`, empty text `--label` (`css:6-12`). Geometry: combo at panel (2,2) right 2, height 18; list at left 2, top 22, right 2, bottom 2 (`css:206-215`, `css:288-295`). Combo chooses the queue or a stored playlist; double-click plays (`playlist.js`). | `<playlist>` attributes `wms:493-503`. The real WMP 7 control's look is not documented here. | (b) | HOST. `<playlist>` maps to a host widget; for Phase 1 it is exactly `buildPlaylist` with the same CSS. The attributes it honours implicitly: `backgroundcolor` and `foregroundcolor` (panel `#285F03`, text white), `columnsVisible=false` (no header), `dropDownVisible=true` (combo), `playlistItemsVisible=true`. |
| D13 | The window never resizes: 760 wide in every state (`tauri.conf.json:18-19`, `main:371`). | `view.width` 549 closed, 760 when the playlist opens (`hs.js:16-17,96,130`). | (b) | HOST. Decision recorded: Phase 1 ignores `view.width` and `view.height` writes, keeps 760×394 in all four states and relies on the click-through mask. The engine still exposes `view.width` / `view.height` as read/write properties that fire a host callback, because the census shows `view.width` referenced in 441 places and `view.height` in 519 (reads or writes, not split out). Per-skin window sizing comes with the next phase (needs a sized-before-show window). |
| D14 | On open, the whole playlist panel including combo and list is shown at the start of the slide; on close it stays until `transitionend` (`main:329-346`). | `pl.visible` is false on close start (`hs.js:87`) and set true only at `PlOnEndMove` (`hs.js:126`). The green panel itself is never hidden (`wms:473-476`). The EQ ear behaves as the hand port does (`hs.js:73,136-138`). | (a) | FOLLOW-WMS. Not visible in a settled screenshot; visible mid-slide. Also keep the panel visible when the ear is closed, as the .wms does: it is fully occluded by the head and the screen (computed from the art: 0 of 24,080 PL-panel pixels at the closed position are uncovered by head or screen alpha, and likewise 0 of 23,940 for the EQ panel at x=207), so the settled closed screenshot is unaffected. |
| D15 | Vis button tooltip never changes (`main:240-251`, `main:270`). | `ToggleVisView` sets `vis.upToolTip = xVisTt.value` in both branches (`hs.js:112`, `hs.js:119`): after the first toggle the tooltip says "Close visualization chooser" even when closed. Original skin bug. | (a) | FOLLOW-WMS: run the script as written. Tooltips are not pixels. |
| D16 | Only the stop element reacts to state; play, previous, next are never disabled (`main:418`); `tabStop` ignored. | Predefined elements are `enabled=wmpenabled:player.controls.X`. | (a) | Engine implements `wmpenabled:` through a host predicate table. Phase-1 table equals the oracle: stop enabled iff state is not `stop`; pause visible iff state is `play`; play, previous, next always enabled. |
| D17 | Balance detent: values within ±5 snap to 0 for the DSP, and on release the thumb snaps to the centre (`main:86-91`). | None. | (b) | HOST binding behaviour for `player.settings.balance`. Not a skin attribute. |
| D18 | Volume input debounced 40 ms (`main:102-103`); two-way binding does not overwrite the slider while it is being dragged (`main:420`). | `value_onchange` (`wms:275`) also clears mute. | (b) | HOST for the debounce. The "do not fight the drag" rule is generic engine binding behaviour. |
| D19 | No `video` element; no `StartVideo` / `EndVideo` / `vidIsPlaying` path. | `wms:127-132`, `hs.js:28-30,39-59`. | (b) | Stub `video` that never starts. `player.currentMedia.ImageSourceWidth` reads 0 and `OpenState` reads media-open so `Init` calls `EndVideo()`. |
| D20 | `reset` label at y=129 (`main:125`). | `eq1.top + 83` = 127 (`wms:419`). | slip | FOLLOW-WMS: engine puts it at y=127. Allow-list rect, absolute, EQ open: (222,221)-(258,238). |
| D21 | Preset title is 9 px (`css:197`). | `text` default fontSize 10 pt, about 13 px; no `fontSize` set (`wms:170-174`). | slip | FOLLOW-WMS with the pt-to-px rule `round(pt*4/3)`. Allow-list rect: (321,65)-(426,82) absolute. If the owner prefers 9 px, put it in the sidecar. Also note the hand port's `text-overflow: ellipsis` (`css:198-200`) has no .wms counterpart. |
| D22 | Text face is the page default `9px Tahoma, Verdana, sans-serif` (`css:26`). | No `fontFace` anywhere: "Windows system font". | (b) | HOST font mapping: system font becomes Tahoma, Verdana, sans-serif. Keep identical for pixel parity. |
| D23 | Persisted state: zoom, EQ gains, balance, `eqOpen`, `plOpen`, always-on-top, all-desktops, preset index; open drawers replayed at boot with animation (`main:582-583`). | Skins use `theme.savePreference` / `loadPreference` (about 1,000 corpus uses); Headspace uses none. | (b) | HOST preference store backing both the host's own keys (4.4) and the skin's `savePreference` / `loadPreference` calls. |
| D24 | EQ DSP ignores `enableSplineTension` (`wms:285`). | | (b) | Out of scope for the skin engine. |
| D25 | Clicking the screen cycles the visualization (`main:238`); canvas tooltip (`main:170`). | Not in the .wms. | (b) | HOST, attached to the effects element's surface. |
| D26 | The `vid_bkgd` mask is applied to the canvas only (`css:130-135`). | `clippingColor=#FFFFFF` on the screen subview (`wms:119`). | (c) to (a) | Implement subview `clippingColor` as a mask on the whole subview container at the image's native size, so it also clips nowPlaying, notice and caption. Identical pixels today because the 106 clipped pixels are the head's red corners too and no overlay text touches them. |
| D27 | Art converted offline to PNG with every non-map BMP keyed on magenta, `head` also on red, `vid_bkgd` on white, file names lowercased (`conv:33-36`, `conv:66-71`); runtime refers to `/skin/<lowercase>.png` (`widgets:6`). | Per-element declarations. | (c) | The engine decodes BMP (and later other formats) at runtime from the zip, with per-declaration keying and case-insensitive entry names. `convert_skin.py` stays only for the app icon (`conv:76-84`). |
| D28 | Slider thumb hover image shows whenever the pointer is over the whole slider box, not just the thumb (`widgets:275-276`). | Not documented. | (a) | REPRODUCE for Headspace (the seek bar is mostly thumb-height anyway); verify against another source before generalising. |
| D29 | Pressing on non-control skin pixels drags the window only for ear art and head (see A7). Drop art, panels, the seek background and non-button pixels of a buttongroup do nothing. | Implicit: skin chrome drags. | (a) | With the generic picker (D10) every unclaimed opaque pixel drags. This changes behaviour in those areas; list it as an intended, reviewed deviation from the oracle. |
| D30 | Buttons set pointer capture but never `set_capture` (`widgets:58-68`); only sliders do (`widgets:281`, `widgets:304`). While the cursor is over transparent pixels the Rust thread makes the window ignore the mouse (`click:53-72`), so releasing a press off the skin can lose `pointerup` and leave a button's down state stuck. | | (c) | Engine: any `pointerdown` on a control calls `set_capture(true)` until `pointerup` or `pointercancel`. Unverified in a running app; test it. |
| D31 | Slider values are rounded to integers in the slider's own units (`widgets:272`), and thumb position is rounded (`widgets:257-263`). Seek uses a normalised 0..1000 range. | `max` is the duration in seconds. | (b) | Keep continuous values inside the control; quantise only in host bindings (integers for gains, volume, balance; none for seek). If the seek range becomes `max=duration` with integer values, seek granularity drops to whole seconds, a behavioural change. |
| D32 | Thumb travel is `length - thumbExtent` for every slider (`widgets:245`): horizontal 71-9 = 62, vertical 76-11 = 65, seek 163-18 = 145. | `borderSize` "defines an offset … from the beginning and end of the slider" (https://learn.microsoft.com/en-us/windows/win32/wmp/slider-bordersize). | (a) | State the hand-port formula as the contract. Under a "centre inset by borderSize" reading the EQ sliders would travel 57 (horizontal) and 62 (vertical) and differ from the oracle; only the seek bar matches both readings. Not verifiable without real WMP; `demo.js:112` depends on 65. Open question 2. |
| D33 | Nothing refreshes the hit mask while a drawer slides; mask is also not refreshed on drop open (no need, drop lies inside the screen rect). | | (b) | See D11. |
| D34 | rAF loop writes slider styles every frame, even when unchanged (`main:462-468`, `widgets:254-264`). | | (b) | Engine: diff before writing. |
| D35 | Zoom 1.5 scales pixel art with nearest-neighbour (`css:44-45`), giving uneven pixel widths. Renderer pixel ratio is `devicePixelRatio * zoom` (`main:369-370`). | | (b) | HOST. Parity is checked at zoom 1 only. |

### 2.1 Summary lists

(a) The engine must reproduce as WMP semantics: nested subviews as compositing layers (0.1 rule 4); per-declaration `transparencyColor` / `clippingColor`; paint order by zIndex with the MS rules; negative-z children below the parent's background; subview `clippingColor` as a container mask; `moveTo(left, top, ms)` linear plus `onEndMove`; `visible` and `enabled` toggles driven from script; `slide`, `useForegroundProgress`, `foregroundProgress`; `wmpenabled:` bindings; `wmpprop:` two-way bindings that do not fight a drag; tooltip swapping through hidden TEXT elements; case-insensitive attributes, script properties and zip entries; `jscript:` layout expressions with dependency order; `res://` in `scriptFile` ignored; unclaimed skin pixels drag the window; BUTTON receives clicks on its transparent pixels while clipped pixels are non-clickable; stub `video` control.

(b) The host must provide around any skin: window creation and sizing (including `view.width` / `view.height` and the click-through mask); preference store (`savePreference` / `loadPreference` plus host keys); keyboard defaults and window menu; the track toast, notice and caption overlays on the effects/video surface; album-art palette; EQ and balance DSP and the `player.network.downloadProgress`, `settings.*`, `controls.*`, `currentMedia.*` shims over MPD; the `playlist` widget; font mapping; `returnToMediaCenter` action; the demo tour hooks.

(c) Headspace-specific, drop or genericise: EQ frequency labels (sidecar overlay); seek foreground-by-playhead (sidecar compat mode); head-art pointer transparency with the two root handlers (generic picker); DOM-walking mask rasteriser (composite alpha of the engine's output); universal offline magenta keying and `EXTRA_KEYS` (per-declaration runtime keying); hardcoded constants (`234×394`, `261`, thumb sizes 18/9/11, `border-image` slice 7, 216×159 mask-size, coordinates in `main.js`); buttons not calling `set_capture`; baked-in 760×394.

## 3. External contracts that must survive

### 3.1 `demo.js` needs from the UI

`runDemo(ctx, wavPath)` is started by an MPD client message `mpc sendmessage window_head "demo <wav>"` (`rust:68`, `rust:77-82`, `main:546-578`). It needs:

- `ctx.root`: the positioned `#skin` element, `getBoundingClientRect()` giving the origin, `transform: scale(zoom)` with origin top-left; `ctx.zoom()` returns the live zoom (`demo:36-39`, `demo:99-102`).
- `ctx.player`, `ctx.viz` (`viz.current.title`, `viz.step`), `ctx.mpd(...)` (`demo:129`, `demo:131-135`).
- `ui` handles (`main:559-572`):

| Handle | What demo.js does with it | Hand-port source |
|---|---|---|
| `ui.transport` | DOM node of the play-controls buttongroup, a single element 144×25. The demo clicks at fractions (37/144, 13/25) for Play and (131/144, 13/25) for the vis button (`demo:151`, `demo:174`). | `buttonGroup` canvas (`widgets:124`), `main:559-560` |
| `ui.plHandle`, `ui.eqHandle` | Clicked at their centre (`demo:158-162`). | handle buttons' `<img>` |
| `ui.visNext` | Clicked five times (`demo:177-182`). In the .wms it has no id (`wms:152-160`); the engine must expose id-less elements by a deterministic path or ordinal. | R button inside `visDrop` |
| `ui.reset` | Clicked (`demo:185-186`). Also id-less (`wms:417-426`). | `.link` div |
| `ui.bands[i]` | `.node.getBoundingClientRect()` (11×76) and `.value`; the demo computes the thumb centre as `top + zoom * (5.5 + (1 - f) * 65)` with `f = (db + 14) / 28` (`demo:108-113`), so thumb extent 11 and travel 65 are hard dependencies (D32). Drags with synthetic `pointermove` carrying `buttons: 1`. | `slider()` return value |
| `ui.getEq`, `ui.setEq`, `ui.toggleEq`, `ui.togglePl`, `ui.toggleVis`, `ui.isOpen.{eq,pl,vis}` | Stage setup (`demo:121-130`) and teardown (`demo:197`). | `main:539-544`, `main:306-360` |

- **Input model.** The demo dispatches synthetic `PointerEvent`s (`pointerId: 1`) to `document.elementFromPoint(x, y)`, with `pointerenter` / `pointerleave` non-bubbling, `pointermove`, `pointerdown`, `pointerup`, then a `click` `MouseEvent` (`demo:40-96`). So: the skin must be real DOM elements that `elementFromPoint` resolves to the control itself; controls must listen for `pointerenter` / `pointerleave` / `pointermove` / `pointerdown` / `pointerup`; `setPointerCapture` must be inside a try/catch because synthetic ids throw (`widgets:62-66`, `widgets:179-183`, `widgets:282-286`).
- **Z-index budget.** The fake cursor uses `z-index: 1000` (`demo:31`), the sync flash `z-index: 2000` (`demo:142`). Nothing in the engine's DOM may use `z-index >= 1000`. If the engine maps WMP `zIndex` to CSS, normalise to rank order (corpus has `zindex` values in the thousands). Prefer document order.
- **Cursor.** `body.demo` hides the cursor (`css:370-374`, `demo:122`). Keep the rule and the class.
- **Rust.** `record_start`, `record_stop({ path })` (`demo:140`, `demo:191`), `js_log` (`demo:26`).
- **Coordinates.** Resting spot `(470, 330)` in skin pixels (`demo:136`, `demo:188`) is just right of the head silhouette at that height.
- **Timing.** Assumes the drawers finish within about 1 s of a click and the chooser opens in time for `visNext` (`demo:157-182`); 120 ms linear transitions satisfy it.

### 3.2 `viz/index.js` needs from the host

- `new Viz(canvas, onPresetChange, captionEl)` (`viz:40`): a real `<canvas>` with CSS size 216×158 (`W`, `H` at `viz:13-14`) in the DOM before construction, able to create a WebGL context. `onPresetChange(title)` is called synchronously from the constructor (`viz:52`) and on each `step` (`viz:84`).
- `viz.renderer.setPixelRatio(devicePixelRatio * zoom)` and `setSize(216, 158, false)` after any zoom change (`main:369-370`). The host must keep calling these.
- `captionEl`: a DOM element whose `textContent` and `hidden` class are driven (`viz:71-75`); the global `.hidden { display: none !important }` rule (`css:56-58`) must exist; it is positioned relative to a 216×158 positioned ancestor (`css:176-188`).
- Public surface used by the host: `viz.step(±1)` (wraps), `viz.current.title` (five titles: "Headspace: Point Cloud", "Chorus", "Bars and Waves: Ring", "Ambience: Warp", "Scope: Ribbon"), `viz.setPalette(swatches | null)`, `viz.setCaption`, `viz.renderer`.
- The constructor calls `audio_subscribe` with a `Channel`; Rust keeps one subscriber (`audio.rs:85-87`), so a second `Viz` steals the feed. `tools/facelab.html` constructs `Viz` outside Tauri and relies on the `try/catch` around it (`viz:54-60`).
- `#skin #viz { image-rendering: auto }` (`css:48-50`) must override the global pixelated rule.
- Persistence: `localStorage.preset`, a raw integer index into the presets array (`viz:46-50`, `viz:80-83`), not JSON-wrapped, not name-based, so adding or removing presets reshuffles saved choices.

### 3.3 Rust commands, events and capabilities

| Name | Signature | JS call sites | Notes |
|---|---|---|---|
| `mpd` | `args: string[]` to key/value pairs | `player.js:7` | Shared command connection with one reconnect (`rust:30-50`). |
| event `mpd-connection` | boolean | `player.js:44-48` | |
| event `mpd-idle` | `string[]` of changed subsystems | `player.js:49` | |
| event `mpd-message` | string, from channel `window_head` | `main:547` | Demo trigger (`rust:68`, `rust:77-82`). |
| `audio_subscribe` | `onFrame: Channel<{bands, wave, level}>` | `viz:55-57` | 64 bands, 256 wave samples. |
| `set_eq` | `gains: number[10]` (dB, clamped ±14) | `main:79` | Band centres 31 to 16,000 Hz (`eq.rs:7-9`). |
| `set_balance` | `balance: number` (−100..100) | `main:80` | Opposite-channel attenuation (`eq.rs:87-90`). |
| `engine_info` | returns `{ mode: 'output' \| 'monitor', routed: boolean, error: string \| null }` | `main:455` | Only `.error` is displayed. |
| `palette` | `file: string` returns `[{ hex, share, oklch: [L, C, h] }]` | `main:441` | Used by `viz:92-113`. |
| `set_hit_mask` | `width, height, bits: number[], zoom` | `main:407` | 1 bpp, row-major, LSB first, mask pixels are skin pixels and `zoom` converts window points (`click:25-36`). Reference size 760×394 gives 37,430 bytes. |
| `set_capture` | `on: boolean` | `widgets:40` | Disables ignore-cursor-events while a drag is live (`click:53-55`). |
| `js_log` | `msg: string` | `main:18`, `demo:26` | |
| `record_start`, `record_stop` | `record_stop(path: string)` | `demo:140`, `demo:191` | Needs output mode (`audio.rs:89-96`). |

Window API calls: `startDragging`, `minimize`, `close`, `setSize(LogicalSize)`, `setAlwaysOnTop`, `setVisibleOnAllWorkspaces`, and the menu API (`main:16`, `main:44-46`, `main:257-258`, `main:371`, `main:488-489`, `main:491-520`). Capabilities granted (`capabilities/default.json:8-14`): start-dragging, minimize, close, set-size, set-always-on-top, set-visible-on-all-workspaces, `core:menu:default`. There is no `set-position`; a window that grows leftwards would need one. Window is `transparent`, `decorations: false`, `shadow: false`, `resizable: false`, `acceptFirstMouse` (`tauri.conf.json:20-25`).

### 3.4 Stored preferences

| Key | Encoding | Written at | Meaning |
|---|---|---|---|
| `zoom` | JSON 1 or 1.5 | `main:367` | |
| `eq` | JSON number[10] | `main:120`, `main:131`, `main:543` | Gains in dB. Sent to Rust at boot (`main:133`). |
| `balance` | JSON integer | `main:91` | Sent to Rust at boot (`main:134`). |
| `eqOpen`, `plOpen` | JSON boolean | `main:321`, `main:340` | Replayed at boot by calling the toggles (`main:582-583`). |
| `onTop`, `allDesktops` | JSON boolean | `main:499`, `main:508` | Applied at boot (`main:585`). |
| `preset` | raw integer string | `viz:82` | Index into `viz.presets`. |

Not persisted: `visOpen`, volume (MPD owns it), playlist combo choice and row selection.

### 3.5 Window sizing

Hardcoded 760×394 in: `tauri.conf.json:18-19`; `main:371` (`setSize`, multiplied by zoom); `main:382-383`, `main:404-407` (mask canvas and bits); `css:34-35` (`#skin`); `main:164`, `main:196-206` (head 234×394 and `headAlpha` origin 261); `demo:136`, `demo:188` (`at(470, 330)`). Rust takes mask dimensions from JS (`click:15-23`, `rust:211-213`), so the engine can change them without Rust edits. Zoom is applied as a CSS transform on `#skin` plus `win.setSize`, so at 1.5 the window is 1140×591.

For Phase 1 the window stays 760×394 (D13). The next phase needs the window created hidden, sized from the skin, then shown.

### 3.6 DOM and CSS contracts other code depends on

- ids: `skin`, `screen`, `viz`, `nowPlaying`, `notice`, `caption`, `visDrop`, `presetTitle`, `combo`, `comboList`, `plList`. Classes: `abs`, `hidden`, `panel`, `ear`, `track h|v`, `label`, `freq`, `link`, `row sel now`, `empty`, `show`, `artist`, `demo`.
- `updateMask` (`main:380-408`) walks `root.children` by `.hidden`, `.panel`, `dataset.rect` (set on the canvas, `main:172`), `IMG`, `CANVAS`, `DIV`, using `offsetLeft` / `offsetTop` chains. Engine output must either stay walkable by it or the host must switch to producing the same bits from the engine's composite alpha. The second is the better design; it removes the dependence.
- `playlist.js` registers a `document`-level `pointerdown` that closes the combo list (`playlist.js:95`).

### 3.7 Host-object surface the skin touches

This is what the engine's script host and `wmpprop:` / `wmpenabled:` / `jscript:` bindings must expose for Headspace, with the MPD-side meaning in the last column. Names are case-insensitive. Element ids are JScript globals (`view`, `player`, `mediacenter`, `eq`, `visEffects`, `vid`, `pl`, `vis`, `bEq`, `bPl`, `bEqHandle`, `bEqClose`, `bPlHandle`, `bPlClose`, `sEqEar`, `sPlEar`, `sEqView`, `visDrop`, `balance`, `volume`, `eq1`..`eq10`, `xEqTt`, `xPlTt`, `xVisTt`).

| Object member | Used at | Meaning for MPD (hand-port behaviour) |
|---|---|---|
| `player.OpenState`, constant `osMediaOpen` | `hs.js:28` | Media open iff a song is loaded. |
| `player.currentMedia.ImageSourceWidth` | `hs.js:29` | 0 (no video), so `Init` calls `EndVideo()`. |
| `wmpprop:player.currentmedia.duration` (read) | `wms:100` | `status.duration` or `song.Time` (`player.js:88-90`). |
| `wmpprop:player.controls.currentposition` (read, written by `onDragEnd`) | `wms:101-102` | Elapsed seconds, extrapolated per frame; write is `seekcur` (`player.js:92-97`, `player.js:115`). |
| `wmpprop:player.network.downloadProgress` | `wms:104` | 100 for local files (D2). |
| `wmpenabled:player.controls.play` | `wms:50` | Always enabled (D16). |
| `wmpenabled:player.controls.pause` | `wms:64` | Enabled iff `state === 'play'` (`main:417`). |
| `player.controls.{play,pause,stop,next,previous}()` via predefined elements | `wms:47-56` | `play`/`pause 0`, `pause 1`, `stop`, `next`, `previous` (`player.js:107-116`). Stop enabled iff `state !== 'stop'` (`main:418`). |
| `player.settings.balance` (read and write) | `wms:256-257` | Host-local value, persisted as `balance`, to `set_balance` (D17). |
| `player.settings.volume` (read and write), `player.settings.mute` (write `'false'`) | `wms:274-275` | MPD `setvol`; ignored when `status.volume` is −1; mute has no MPD equivalent. |
| `mediacenter.effectType`, `mediacenter.effectPreset` (read at `Init`, written at `OnClose`) | `hs.js:25-26`, `hs.js:35-36`, `wms:123-124` | Preset index in `localStorage.preset`; effect type has one value. |
| `visEffects.currentEffectType`, `.currentPreset`, `.currentPresetTitle`, `.previous()`, `.next()`, `.visible` | `hs.js:25-26`, `wms:149`, `wms:158`, `wms:172`, `hs.js:49`, `hs.js:56` | `Viz` (5 presets, wrapping `step`); `visible` always true effectively. |
| `vid.visible`, events `OnVideoStart`, `OnVideoEnd` | `hs.js:50`, `hs.js:58`, `wms:129-130` | Stub, never fires (D19). |
| `eq.gainLevel1`..`gainLevel10` (read and write), `eq.reset()`, `equalizerSettings` | `wms:296-413`, `wms:424`, `wms:285` | Host-persisted array of ten dB values, `set_eq`; `reset` zeroes all. |
| `pl.setColumnResizeMode(col, mode)`, `pl.visible` | `hs.js:23-24`, `hs.js:87`, `hs.js:126` | Accept and ignore the first; `visible` toggles the host playlist widget (D12, D14). |
| `view.minimize()`, `view.close()`, `view.returnToMediaCenter()`, `view.width` (write) | `wms:31`, `wms:36`, `wms:112`, `hs.js:96`, `hs.js:130` | Window minimize, close, host action (D3), host callback ignored in Phase 1 (D13). |
| Element methods and properties: `moveto(left, top, ms)`, `.left`, `.top`, `.width`, `.visible`, `.image`, `.hoverImage`, `.downImage`, `.upToolTip`, `.toolTip`, `.value` | `hs.js:65-118`, `wms:268-419` | Layout and state; `.image*` swaps art at runtime, so image resolution must be lazy and cached. |
| Events: `onLoad`, `onClose`, `onEndMove` (three subviews), `onClick`, `onDragEnd`, `value_onchange`, `OnVideoStart`, `OnVideoEnd` | `wms:13-14`, `wms:140`, `wms:183`, `wms:433` and others | `onEndMove` fires when the 120 ms move completes, on every completion including a reversed one. |

## 4. Screenshot checklist

### 4.1 Fixture (what makes two renders comparable)

Both renderers run in the same WebKit instance (one page, two mount points, or two pages in one browser), so pixels match if DOM geometry, CSS, image bytes and stacking match. Required fixture:

- Tauri stub: `window.__TAURI_INTERNALS__` with `invoke`, `metadata.currentWindow.label = 'main'`, `transformCallback`, `convertFileSrc`; `invoke` returns canned values: `mpd status` → `{state: 'stop', volume: '50'}` in states 1, 2 and 4 (empty queue), and `{state: 'stop', volume: '50', playlist: '1', playlistlength: '5', song: '1'}` in state 3 (the row highlight reads `status.song`, `playlist.js:65`); `currentsong` → empty in every state, so no now-playing toast and no palette call; `playlistinfo` → five records (state 3 only, empty otherwise); `listplaylists` → empty; `engine_info` → `{mode: 'output', routed: true, error: null}`; `palette` → rejects; `set_*` → no-ops that record their arguments (the mask bits are one of the recorded calls).
- Zoom 1, device pixel ratio 1 and then 2; pointer off the window (no hover); no keyboard focus effects.
- localStorage cleared, then `eq` all zeros, `balance` 0, `preset` = 1 (Chorus, shortest title), `eqOpen` / `plOpen` as the state requires (set via the toggle, then wait for `transitionend` plus 200 ms).
- MPD stopped, elapsed 0: seek thumb at left 0, foreground clip width 9 px (hidden under the thumb), stop element in its disabled art, pause button hidden. Volume 50: volume thumb at left 31. EQ thumbs at the middle (top 33, `Math.round(32.5)`), balance thumb left 31.
- `nowPlaying`, `notice`, `caption` empty.
- Dynamic region excluded from the diff, or frozen: the effects hole, i.e. the set of magenta pixels of `head.bmp` offset by (261,0) (31,487 px, computed at run time from the unzip), in all four states. Everything else is compared exactly.
- Allow-listed rects (section 2): D20 reset text (state 2), D21 preset title (state 4), and the D1 tooltip suffix is not a pixel.
- Text parity depends on identical CSS: `font: 9px Tahoma, Verdana, sans-serif`, `-webkit-font-smoothing: none`, absolute positioning at the listed x/y with no padding and `line-height: normal`, `white-space: nowrap`. The engine's TEXT must emit the equivalent box. A text diff is a failure, not noise.
- Artifacts per state: a PNG of the page at DPR 1 and 2, the recorded `set_hit_mask` call (width, height, bits, zoom), and the DOM stacking order (for debugging).

Reference hit-mask values from an offline emulation of `updateMask` over the art (`/tmp/hs-scripts/mask.py`, not the live app). Re-derive them from the live oracle before using them as goldens; they check my reading of the algorithm, not the engine.

| State | Popcount | Bounding box (x0,y0)-(x1,y1) | Bytes | Bits sha1 (prefix) |
|---|---|---|---|---|
| 1 closed | 89,328 | (207,0)-(548,393) | 37,430 | `2967a5af0753` |
| 2 EQ open | 122,636 | (0,0)-(548,393) | 37,430 | `d9ba9bcf042b` |
| 3 PL open | 123,258 | (207,0)-(759,393) | 37,430 | `7bd9a1a5df99` |
| 4 vis open | 89,328 (identical to state 1) | (207,0)-(548,393) | 37,430 | `2967a5af0753` |

State 4 equals state 1 because the drop lies entirely inside the screen rect, which is already solid in the oracle mask. An engine that derives the mask from composite alpha will differ from these by the oracle's one real over-approximation (D11): the 106 clipped corner pixels of the screen. That difference is expected and should be allow-listed explicitly in the mask comparison rather than copied.

### 4.2 State 1: closed

Setup: nothing open. Must be pixel-identical (outside the excluded hole):

- Head art at (261,0), alpha exactly as in 0.3: red and magenta are alpha 0.
- Screen backing: `vid_bkgd` visible only through the hole; 106 corner pixels clipped.
- Minimize/close group at (362,4), transport group at (309,31) with stop in the disabled layer and the rest in the up layer; unowned pixels from the up layer.
- EQ button (276,214), PL button (465,214), theme button (362,232), seek background (300,223) with thumb at the left, foreground hidden behind it.
- EQ ear closed at x=207: only `left_ear` and the open-state handle outside the head silhouette are visible (handle at (215,152), art `L_drwr_open_01_default`). PL ear closed at x=277: `right_ear` and handle at (523,151) (`R_drwr_open_01_default`). Panels hidden; close buttons hidden.
- Paint order as in 0.6; where an ear overlaps the head, the head wins.
- Hit mask per 4.1.

### 4.3 State 2: EQ drawer open

Setup: `toggleEq()` and settle. Must be pixel-identical:

- EQ ear at x=0. Handle at (8,152) with close art `L_drwr_close_01_default`; close button at (72,93) in `left_X_01_default`.
- Panel (84,96)-(255,236), `#285F03`, with the four frame images placed per 0.5 (the right image overlapping the top image's last column).
- Balance at (92,107) and volume at (173,107): tiled tracks 71×11 (7 px ends, 1 px middle repeated), thumbs at left 31.
- "Balance" label (109,118) and "Volume" label (192,118), `#77ce07`, 9 px.
- Ten vertical sliders at x = 95+15·i, y = 140, tiled 11×76, thumbs at top 33.
- Frequency labels (D1) at y = 217 and the `reset` link, underlined `#dddddd` (at y=225 in the oracle, y=223 per .wms: allow-listed rect).
- EQ button tooltip is not a pixel; its title text should read "Close graphic equalizer controls".
- Everything from state 1 outside the ear is unchanged.
- Hit mask per 4.1.

### 4.4 State 3: playlist open

Setup: `togglePl()` and settle. Must be pixel-identical:

- PL ear at x=488. Handle at (734,151) with `R_drwr_close_01_default`; close at (677,93) in `right_X_01_default`.
- Panel (501,96)-(673,236) `#285F03` with four frame images.
- Playlist widget (D12): combo at (503,98), 168×18, Windows 2000 bevel, icon, white-on-navy "Now Playing", arrow button; list at (503,118), 168×116, five 14 px rows at 11 px, the current row (index 1) coloured `#a9ff2b`, durations right-aligned. No scrollbar with five rows; add a variant with twelve rows to cover the Win2000 scrollbar (13 px wide, buttons, checker track).
- Everything from state 1 outside the ear is unchanged.
- Hit mask per 4.1. The window stays 760 wide in all states (D13).

### 4.5 State 4: visualization chooser open

Setup: `toggleVis()` and settle (120 ms plus the double `requestAnimationFrame`). Must be pixel-identical:

- Drop at (291,59) 174×26: `viz_drop` art with clipped corners (352 px), previous (300,62), next (426,62), close (448,67), preset title "Chorus" centred in (321,65) width 105 (rect allow-listed, D21).
- Layer order: above the screen backing, below the head art; visible only through the hole. The clipped corners show the live viz underneath (inside the excluded region).
- Everything else as state 1.
- Hit mask per 4.1.

### 4.6 Supplemental checks (not part of the four, cheap to add)

- Hover and down art for each of the five transport elements and both minimize/close elements: only that element's pixels switch layer; neighbours stay in up; disabled stop stays in the disabled layer under hover.
- Play state: pause button at (335,32) above the play pixels, magenta corners showing the play art underneath; stop in the up layer.
- Mid-animation sample at 60 ms for the EQ ear (x about 103) and the drop (y about 46): only a sanity check on linear easing and on D14 (the engine will show an empty green panel without playlist content while the ear slides).
- Button press and release outside the window (D30).

## 5. Open questions and unverified assumptions

1. What a real WMP 7 draws in the seek bar for a local file (D2). The MS docs say `foregroundProgress` follows `downloadProgress` and constrains the thumb; I could not run WMP or Wine. The oracle's playhead reveal is treated as a compat decision, not as truth.
2. Thumb travel and `borderSize` (D32). Docs describe `borderSize` as an offset that bounds thumb positions but not exactly how; the hand port's `length - thumbExtent` is the contract until checked against a real render.
3. Whether the head subview's transparent magenta region still swallows clicks (SUBVIEW `transparencyColor` is documented without a click statement; BUTTON's is "still receives clicks"). The hand port lets the screen receive clicks through the hole. The screen click-to-cycle is a host feature either way.
4. Fallback when a state image is missing (`left_X_03_down`, `right_X_03_down`, pause `disabled`, all `*_04_disabled` on non-disableable buttons). Hand port: down falls back to hover then up; disabled falls back to up. WMP's rule is undocumented here.
5. `wmpenabled:` evaluation for MPD: should previous and next be disabled at queue ends, play when the queue is empty? Phase 1 pins the oracle's table (D16); decide before the second skin.
6. Whether any corpus skin relies on `view.width` actually resizing the window (441 uses of `view.width`, 519 of `view.height` in the census) and what the host must do about them.
7. Preset title font (D21): 10 pt per docs vs 9 px in the oracle; which does the owner want.
8. Windows system font on macOS (D22): Tahoma is the oracle's choice; confirm it exists on every target Mac.
9. The reference mask goldens in 4.1 come from an emulation. They should be regenerated from the live oracle.
10. Uneven hover model for sliders (D28): whole box vs thumb only.

## 6. Sources

Local: `src/main.js`, `src/widgets.js`, `src/player.js`, `src/playlist.js`, `src/style.css`, `src/viz/index.js`, `src/demo.js`, `src-tauri/src/lib.rs`, `src-tauri/src/clickthrough.rs`, `src-tauri/src/eq.rs`, `src-tauri/src/audio.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `tools/convert_skin.py`, `docs/research/corpus-census.txt`, `~/Downloads/Headspace.wmz` (unzipped to `/tmp/headspace-src`, never into tracked paths).

Microsoft Learn (archived WMP SDK skin reference), all fetched 2026-10-06:

- zIndex: https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-zindex
- clippingColor: https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-clippingcolor
- BUTTON transparencyColor: https://learn.microsoft.com/en-us/windows/win32/wmp/button-transparencycolor
- SLIDER transparencyColor: https://learn.microsoft.com/en-us/windows/win32/wmp/slider-transparencycolor
- VIEW transparencyColor: https://learn.microsoft.com/en-us/windows/win32/wmp/view-transparencycolor
- SLIDER slide, borderSize, tiled, useForegroundProgress, foregroundProgress: https://learn.microsoft.com/en-us/windows/win32/wmp/slider-slide, https://learn.microsoft.com/en-us/windows/win32/wmp/slider-bordersize, https://learn.microsoft.com/en-us/windows/win32/wmp/slider-tiled, https://learn.microsoft.com/en-us/windows/win32/wmp/slider-useforegroundprogress, https://learn.microsoft.com/en-us/windows/win32/wmp/slider-foregroundprogress
- moveTo (third argument is milliseconds, linear): https://learn.microsoft.com/en-us/windows/win32/wmp/ambientattributes-moveto
- onEndMove: https://learn.microsoft.com/en-us/windows/win32/wmp/onendmove
- SUBVIEW and BUTTONGROUP: https://learn.microsoft.com/en-us/windows/win32/wmp/subview-element, https://learn.microsoft.com/en-us/windows/win32/wmp/buttongroup-element
- PAUSEBUTTON, STOPELEMENT, NEXTELEMENT, PREVELEMENT defaults: https://learn.microsoft.com/en-us/windows/win32/wmp/pausebutton, https://learn.microsoft.com/en-us/windows/win32/wmp/stopelement, https://learn.microsoft.com/en-us/windows/win32/wmp/nextelement, https://learn.microsoft.com/en-us/windows/win32/wmp/prevelement
- TEXT fontSize, fontFace, foregroundColor: https://learn.microsoft.com/en-us/windows/win32/wmp/text-fontsize, https://learn.microsoft.com/en-us/windows/win32/wmp/text-fontface, https://learn.microsoft.com/en-us/windows/win32/wmp/text-foregroundcolor
- VIEW: https://learn.microsoft.com/en-us/windows/win32/wmp/view-element

PLAYELEMENT's page returned 404 under the slug tried; its defaults are inferred from the three sibling elements and not cited.
