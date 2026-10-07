# Windows Media Player skin format (WMP 7 - 11): reference for the skin engine

Status: research reference for the generic skin engine (branch `skin-engine`). Written 2026-10-06 from Microsoft's archived SDK pages plus a census of the local corpus (342 `.wmz`, `skins/wmp/`; census `docs/research/corpus-census.txt`). Nothing here copies skin art; all art inspected was unzipped under `/tmp` only.

Legend: **Docs** = stated by Microsoft; **Corpus** = observed in the 339 parsed `.wms` files (counts are from my own lenient parse, so they can differ by a few from the older census); **Hand port** = `src/widgets.js` / `src/main.js` (the Phase 1 oracle); **UNCONFIRMED (U-n)** = not established by a primary source, listed in the register in section 10.

## 1. Scope, sources and conventions

### 1.1 Primary sources
All reference pages live under one base, `B` = `https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/`; `B`<slug>, `.../wmp/<slug>` and `<.../wmp/<slug>>` all mean `B` + slug (the pages are archived; the same slugs also resolve under `learn.microsoft.com/en-us/windows/win32/wmp/`, whose canonical URL is the archive). Entry points:

* Overview and structure: `B`windows-media-player-skins, `B`about-skins, `B`skin-files, `B`skin-definition-file, `B`skin-definition-file-structure, `B`art-files (+ `primary-images`, `mapping-images`, `alternate-images`, `art-file-formats`), `B`jscript-files, `B`writing-code (+ `handling-events`, `external-events`, `internal-events`, `writing-event-code`, `secondary-events`, `using-jscript`, `working-with-the-player`, `event-handlers`, `calling-functions`), `B`new-for-windows-media-player-skins.
* Reference: `B`skin-programming-reference (index), `B`ambient-attributes, `B`ambient-event-handlers, `B`ambient-event-attributes, `B`miscellaneous (+ `color-reference`, `global-attributes`, `listening-attributes`).
* Per element: given in each section 6.x heading.
* Skin creation tutorials used only for cross-checking: `B`building-your-first-skin, `B`adding-a-slider, `B`creating-custom-sliders, `B`adding-a-playlist, `B`adding-video, `B`adding-visualizations.
* Object model pages (player, controls, settings, media, network) are the ordinary WMP control docs, e.g. `B`player-playstate, `B`player-openstate, `B`controls-isavailable, `B`settings-getmode.
* Microsoft's own end-of-life notice on every page: "Skins will no longer be supported in Windows Media Player Legacy (WMPL) starting November 10, 2026, on Windows 11 version 24H2 and later." The documentation set is frozen, so there will be no further corrections.

Missing from the docs and found only in the corpus: the `<mediacenter>` object, `StickyBorderWidth`, `<bars>`, `res://` resources and the shared script, nested SUBVIEWs, optional `JScript:` prefix, `<attr>_onchange` on PLAYER. A web search for the `mediacenter` object found no Microsoft page for it.

### 1.1b Companion notes in this directory
Written in parallel by other agents; this reference cites them instead of repeating them: `docs/research/wmploc-library.md` (the contents of `res://wmploc.dll/RT_TEXT/#132` and the 47 `RT_STRING` ids, read from the real DLL bytes), `docs/research/headspace-parity.md` (the parity contract for Headspace incl. the zIndex arithmetic and slider travel), `docs/research/corpus-survey.md` (distinct-skin counts: 195 unique skins out of 342 archives; this document's counts are raw over 339 files unless stated), `docs/research/corpus-census.txt`.

### 1.2 Versions
WMP 7.0 introduced skins; 7.1 and WMP for Windows XP changed nothing; 9 Series added AUTOMENU, EDITBOX, LISTBOX/POPUP/ITEM, COLUMN, PLAYERAPPLICATION, `alphaBlend`, `alphaBlendTo`, accessibility attributes, many PLAYLIST/EQ/BUTTONGROUP attributes, `playSound`, `openViewRelative`, VIEW `resizeBackgroundImage`/`backgroundImageHueShift`/`backgroundImageSaturation`; WMP 10 added five PLAYLIST attributes and the `gradient` backgroundImage; WMP 11 added `right`, `bottom`, `nineGridMargins`, `resizeImages`, `moveSizeTo`, `slideTo` (`B`new-for-windows-media-player-skins). Per-page "Version" stamps are used in the tables below. The "new for 9" list also names predefined tags (VOLUMESLIDER, PLAYBUTTON-family, BALANCESLIDER...) whose own pages say "7.0 or later": a Docs inconsistency (U-24). An engine should simply accept every attribute regardless of version.

### 1.3 Engine-critical facts (read these first)
1. A `.wms` is **not** reliably well-formed XML: 42% of corpus files fail a strict parse (duplicate attributes, missing whitespace between attributes, tag-case mismatches). Names are case-insensitive everywhere. Parse leniently (section 8).
2. Text encoding is mixed: UTF-16LE+BOM, UTF-8(+BOM) and Windows-1252; there is **no** XML declaration in any of the 341 files.
3. **Nested SUBVIEWs are normal** (254 of 339 skins, depth up to 4) although the docs forbid them. A SUBVIEW is a positioned, stackable surface with its own background, not just a container.
4. Script is **JScript (ES3)** with the skin's element ids, `player`, `theme`, `view`, `event`, `mediacenter` as globals, case-insensitive names for host objects, and a Microsoft-supplied shared script (`res://wmploc.dll/RT_TEXT/#132`, 433 references, 133 unique skins) that is only a table of `ps*`/`os*` constants. Section 4.2.
5. **Three attribute-value languages**: literal, `jscript:` (evaluated once after load, in document order), `wmpprop:` / `wmpenabled:` / `wmpdisabled:` (live bindings). Section 3.
6. Layout is absolute pixels relative to the parent VIEW/SUBVIEW; `left="jscript:view.width-N"` occurs 2,791 times, 2,773 of them *together with* `horizontalAlignment="right"`, to place and then anchor controls. Section 5.1, 9.1.
7. Transparency has **two** independent mechanisms (`transparencyColor` = paint key, still clickable; `clippingColor/Image` = shape, not clickable) and stacking is by `zIndex` with the parent's background at 0. Section 5.3 to 5.5.
8. Several controls are native windows in real WMP (PLAYLIST, VIDEO unless `windowless`, EFFECTS if `windowed`, EDITBOX, LISTBOX, POPUP): they ignore z-order/alpha/clipping. Our engine will draw them itself and must decide which of these quirks to keep.

## 2. Execution model

Documentation of the runtime is thin (`B`handling-events, `B`internal-events, `B`external-events, `B`using-jscript, `B`calling-functions, `B`listening-attributes, `B`global-attributes). Everything marked "Corpus" below is inferred from how 339 working skins behave and is therefore a *requirement for compatibility*, not a Microsoft guarantee.

### 2.1 Load sequence
1. **Locate and parse** the single `.wms` (section 8). Root is THEME, then one or more VIEWs. Element and attribute names are case-insensitive; unknown attributes and typos are silently ignored (corpus: `horizontalAlignemnt`, `z-index`, `transparencycoloro`, `resizeable` ... all occur and the skins load).
2. **Choose the initial VIEW.** Docs: `THEME.currentViewID` selects it at design time (page `theme-currentviewid`), and `VIEW.category` (`All`/`Radio`/`CD`/`DVD`/`Music`/`Video`) says which media type a VIEW is for. Corpus: 174 skins have several VIEWs, only 24 set `currentViewID`, **no VIEW uses `category`**; every secondary VIEW is opened from script with `theme.openView(id)`. Rule that fits the corpus: *first VIEW in document order is the main window* (U-8).
3. **Per VIEW:** a fresh script scope is created ("each view has its own variable scope", `view-element`; "files loaded in other views are not in scope with the current view", `calling-functions`). All files of a VIEW are loaded, in order, into **one shared global scope** (functions and `var`s from every file, plus the constants script, are visible to every handler in that VIEW; Headspace's `headspace.js` reads `osMediaOpen`, defined by the library that is loaded *after* it, which works because handlers only run once everything is loaded). Load, in order, every file in `scriptFile` (`;`-separated; may contain `res://` entries, section 4.2) and the auto-loaded `<skinname>.js` that sits next to `<skinname>.wms` ("loaded automatically ... need not be specified", `view-scriptfile`, `jscript-files`). Be tolerant: 391 of 433 `res://` entries end with a trailing `;` (the docs say it "should not be present"), so ignore empty entries, missing files and unknown `res://` URLs (warn and continue; `wmploc-library.md` 4.3). No corpus `.js` file touches an element id at top level (0 of 385 files, checked outside functions and `var` initialisers), so scripts-before-elements versus elements-before-scripts is unobservable; all skin code runs from `onload`, handlers and bindings (U-33).
4. **Create the elements, then evaluate expressions.** Evidence favours two phases: (i) create every element in document order with its *literal* attribute values (so any element's literal geometry is readable by any expression, even one declared later); (ii) evaluate the `jscript:` values in document order, then settle `wmpprop:`/`wmpenabled:`/`wmpdisabled:` bindings from the player. The decisive case is Microsoft's own 9SeriesDefault: `svMain` (line 36) has `width="JScript:view.width-svStub.width-svMain.left;"` and reads `svStub.width` (literal `263`), but `svStub` is declared 816 lines later (line 852), and `svStub` in turn has `left="JScript:svMain.left+svMain.width"` which needs `svMain`'s *already evaluated* width, i.e. document order for the expressions. Under a one-phase "evaluate when the tag is parsed" model the forward read could not work (U-3).
5. **`onload`** fires on the VIEW "when the VIEW is first displayed". Corpus: 904 VIEWs use it, typically `onload="Init();"`.
6. **Run time:** user input and player changes raise events (2.3); `ontimer` ticks every `timerInterval` ms (default 1000, 0 = off, <50 = error) but only if `ontimer` is implemented.
7. **`onclose`** fires when the VIEW is about to close (591 uses; used for `savePreference`). Closing the main VIEW ends the skin; `theme.openView(id)` opens additional **top-level windows**, each with its own scope. Views cannot read each other's attributes; the corpus shares state between views only through `theme.savePreference/loadPreference` (3,052 / 2,668 references).

### 2.2 Id registry and scoping
* Every element with an `id` becomes a **global name in its VIEW's scope**, flat across SUBVIEW nesting, so `bEq.upToolTip = xEqTt.toolTip` reaches across subviews (Headspace `headspace.js` ToggleEqView). Elements without `id` get `Unnamed_<type>_<n>`.
* **Name lookup is case-insensitive**: eleven corpus skins reference an id with a different case than declared (`EQ` vs `eq`, `VisEffects` vs `visEffects`, `Volume` vs `volume`), and Headspace's own script calls `sEqEar.moveto(...)` and reads `xPlTt.tooltip` while the attributes are `moveTo` / `toolTip`. The WMP script host therefore exposes element and host-object members through a case-insensitive IDispatch. Plain JScript variables and functions declared by the skin's `.js` remain ordinary case-sensitive JScript (UNCONFIRMED but implied, U-28).
* THEME has no `id` (docs) yet 205 corpus THEMEs carry one; ignore it. VIEW ids are visible to other VIEWs and to THEME (`view-element`: "id ... must be used from within other VIEW elements or from within the THEME element"), which is how `theme.openView('plView')` works.
* Case-sensitivity exception: PLAYER event **parameter names** must be typed exactly (`NewState`, `ModeName`, `scType`...), per every `player-player-*` page.

### 2.3 Event handling
* A handler attribute's text is JScript. `on` + event name (`onclick`, `onMouseDown`, ...) for ambient events; `<attribute>_onchange` for attribute changes; for PLAYER also the bare event name. The attribute value is run as a statement list, `;`-separated, on a single line ("care must be taken not to exceed the line length that JScript permits", `event-handlers`).
* **The `JScript:` prefix is optional for handlers.** Corpus: 19,168 handler values have no prefix, 3,120 have `JScript:`; 12 have `javascript:` (BMG__elvis) and 117 `*_onchange` handlers start with `wmpprop:` (e.g. `value_onchange="wmpprop:player.settings.volume = value;updateVolToolTip();"`). All of these work in WMP, which fits one explanation: handler text is evaluated as JScript where `jscript:`, `javascript:` and `wmpprop:` parse as **statement labels** (valid JScript, no effect). Safe engine rule: for handlers, strip any leading `identifier:` (UNCONFIRMED, U-6). The prefix is **not** optional for attribute values (3.2).
* Quotes: single quotes inside double-quoted attributes (`B`writing-event-code). `&#13;` and the XML entities are decoded by the XML layer before script sees the text.
* **A failing handler must not kill the skin**: a ReferenceError (misspelled or undefined name) aborts only that handler; 36% of unique corpus skins contain at least one such name and still work (`wmploc-library.md` 4.3).
* Context object: global `event` exposes the properties of 5.7 for the duration of the handler.
* **Event parameters** of PLAYER events are visible as local names (2.2). Handlers on non-PLAYER elements get none.
* `this` is the firing element (`onclick="...currentPosition=value;this.toolTip='res://-/RT_STRING/#1809'"`, 3 skins).
* `_onchange` fires whenever the attribute value changes, however it changed (script, user interaction, or a `wmpprop:` binding). The docs state this generally (`attribute-onchange`); only `SLIDER`/`CUSTOMSLIDER.onPositionChange` is explicitly *user-only*. Engine consequence: a bound `value` plus `value_onchange` that writes the player back (VOLUMESLIDER, BALANCESLIDER defaults, Headspace volume/balance/EQ) **must be re-entrancy-guarded** (write only if the value really differs, never feed a binding update back into the player).
* Handler order for one gesture: `onmousedown`, `onmouseup`, `onclick` (`onclick` only when down and up are on the same element), `ondblclick`; slider `onDragBegin`/`onDragEnd`/`onPositionChange`. Not specified by the docs (U-18).

### 2.4 Name resolution inside a handler or `jscript:` expression
Evidence (docs and corpus):
* `MUTEBUTTON`: `onclick="jscript:player.settings.mute=down;"` : `down` is the **firing element's own attribute**.
* `WMPEFFECTS`: `onclick="next();"` : `next` is a method of the firing EFFECTS element.
* `attribute-onchange` example: `value_onchange="JScript: if (value == 100) backgroundColor = 'green';"` : both are attributes of the element (assignment changes it).
* Headspace: `value_onchange="player.settings.balance=value;"`, `onClick="eq.reset();"`, `onDragEnd="player.controls.currentposition=value;"`.

So bare identifiers resolve through, in this order (precedence between layers 1 and 3 UNCONFIRMED, U-31):
1. the firing element (its attributes and methods, as if inside `with(this)`),
2. element ids of the same VIEW,
3. the VIEW's script globals (functions/vars from all `scriptFile`s, and the shared script),
4. host globals: `player`, `theme`, `view`, `event`, `mediacenter`, `playerApplication`, plus anything the host registers (a C++ app's scriptable object).

Values read back are typed: numbers/booleans as JS numbers/booleans, strings as strings; **assignment coerces to the attribute's type**: Headspace sets `player.settings.mute='false'` (a *string* 'false' into a Boolean). Invalid values are ignored with the previous value kept (documented on many pages: `button-down`, `button-transparencycolor`, `view-timerinterval`, `buttongroup-showbackground`, ...). Corpus has `visible="ture"` (2), `visible="1"` (6), `"0"` (1); what WMP does with `1`/`0` is UNCONFIRMED (U-20).

### 2.5 Binding semantics (`wmpprop:`, `wmpenabled:`, `wmpdisabled:`)
See section 3.3. In short: one-way, live, target to attribute; targets are player properties, other elements' attributes, or `mediacenter`/`eq`/`vidset` object attributes.

### 2.6 Time-based behaviour
* VIEW `timerInterval`/`ontimer` (2.1.6). JScript's `setTimeout("code", ms)` is available with the **string form** (18 corpus uses, e.g. `setTimeout("LoadEqualizerPreference()",1000)`); `setInterval`/`clearTimeout` never occur; `window.*` appears 6 times and `ActiveXObject`, `document`, `alert` never.
* Animations are driven by `moveTo`/`slideTo`/`moveSizeTo`/`alphaBlendTo` (5.2). They are asynchronous; the end event is `onendmove`/`onendalphablend`. Headspace relies on `onEndMove` to hide drawers *after* sliding out (`EqOnEndMove`, `PlOnEndMove`, `VisDropOnEndMove`). The ambient methods also apply to the **VIEW itself** (`view.moveTo` 36 uses, `view.alphaBlendTo` 10).
* `wmpprop:` bindings to `player.controls.currentPosition` update continuously while playing (1,374 `currentposition` references; 176 `<controls currentPosition_onchange>` listeners). WMP's tick rate is not documented (U-19); `PositionChange` is explicitly **not** raised during normal playback (`player-player-positionchange`).

### 2.7 Painting and hit-testing model
Painting order inside a window: VIEW background at z = 0; every child painted in `zIndex` order (negative = behind the parent's own background, 5.3); windowed controls (real HWNDs) always on top. Inside each SUBVIEW the same rule applies recursively, relative to that SUBVIEW.
Hit-testing goes top-down through the same order, with these documented per-control rules:

| Situation | Result | Source |
|---|---|---|
| `visible=false` | not drawn, clicks fall through to what is behind | `ambientattributes-visible` |
| `enabled=false` | drawn (disabled art), no mouse/keyboard events delivered, no tab stop; non-input events still delivered | `ambientattributes-enabled` |
| `passThrough=true` | control is drawn and ignored for hit-testing; events reach what is under it | `ambientattributes-passthrough` (corpus 863 true, on TEXT labels over buttons) |
| pixel equals `transparencyColor` | not drawn; **still receives clicks** (BUTTON, BUTTONGROUP docs) | `button-transparencycolor`, `buttongroup-transparencycolor` |
| pixel equals `clippingColor` in `clippingImage` (or VIEW/SUBVIEW `backgroundImage`) | not drawn and **not clickable**; clicks pass to the desktop for the outermost shape | `ambientattributes-clippingcolor/-clippingimage` |
| BUTTON with no `image` but `width`+`height` | invisible hot-spot over whatever is behind (323 corpus buttons, 182 with width and height) | `button-image` |
| BUTTONGROUP pixel not owned by any `mappingColor` | with `showBackground=false` not drawn and not clickable; `true`: drawn from `image`, not clickable | `buttongroup-showbackground` |

A VIEW with `backgroundColor="none"` and no background image, as in Headspace, gets its window shape from the painted pixels of its children (the hand port's click-through does exactly this); the docs do not state it (U-12).
There is **no explicit window-drag handler in any corpus skin** (0 `onmousedown` on VIEW/SUBVIEW besides resize grips), so dragging the window by any non-control pixel is built into WMP (U-11). `view.size('bottomright')` on a grip's `onmousedown` (371 uses) is the standard resize idiom.

### 2.8 Native-window controls
PLAYLIST, EDITBOX, LISTBOX, POPUP, VIDEO (unless `windowless=true`) and EFFECTS (if `windowed=true`) are hosted as child windows: always rectangular, always above windowless siblings, no `zIndex`, `alphaBlend`, clipping, `passThrough`, and most mouse/keyboard events. Skin authors compensate by leaving a transparent hole in the art above them (Headspace's magenta face-window) instead of covering them.

## 3. Attribute value syntax

Sources: `B`listening-attributes, `B`internal-events, `B`writing-event-code, `B`color-reference, `B`text-wordwrap (the `JScript:` value example).

### 3.1 Literal types
| Type | Spelling | Notes |
|---|---|---|
| Number | `"12"`, `"-3"`, `"0.5"` | `long` unless noted; `width` is a 16-bit int 0..32767. |
| Boolean | `"true"` / `"false"` (any case) | corpus also `1`(6), `0`(1), `ture`(2), `fale`(2): invalid => previous/default (U-20). |
| String | any text | XML entities decoded; `&#13;` = line break in TEXT `value`. |
| Colour | `#RRGGBB` (6 hex digits), an IE colour name (`color-reference`: 140 names, e.g. `white`, `black`, `graytext`), or `none`/`Auto` where an attribute allows it | `none` for `transparencyColor` = no transparency; for other colour attributes = transparent. `Auto` = colour of pixel (0,0). Corpus: `mappingColor` is always `#RRGGBB` (5,649/5,655); `transparencyColor` is `#ff00ff` 8,895 times. 3-digit `#RGB` never appears (support UNCONFIRMED, U-29). System names such as `graytext` appear as PLAYLIST defaults. |
| Filename | relative name inside the skin | no path semantics for cursors ("Cursor file name paths are ignored"). Corpus: flat zips (341 of 342); `res://` URLs also occur (3.5). |
| Enumerations | `Left/Right/Center`, `horizontal/vertical`, `Bold Underline` ... | case-insensitive. |
| Coordinates | integers in the parent's pixel space | |

### 3.2 `jscript:` expressions
`attr="jscript:EXPR"` (the keyword is case-insensitive: `JScript:`; leading whitespace occurs twice; a trailing `;` is allowed, 456 `top`s end with `;`). The value of the expression, evaluated as JScript in the VIEW scope with the name resolution of 2.4, becomes the attribute value. Used for:
* **Layout** (the overwhelming majority): `left="jscript:view.width-121"`, `width="jscript:view.width"`, `top="jscript:balance.top"`, `left="jscript:balance.left+balance.width+10;"`, `height="jscript:view.height-158"`. 11,924 `jscript:` attribute values in the corpus: width 820 `ID.width`, height 735 `ID.height`, top 456+301 `ID.top`, left `view.width-N` ...
* Initial values: `value="jscript:drawerspeed;"`, `value="jscript: eq.currentPresetTitle"` (3), `visible="jscript:player.playstate!=psUndefined;"` (2), `enabled="jscript:chkDecVol();"` (3).
* Strings with escapes: `value="JScript:'a\r\rb'"` (`text-wordwrap`).

When it is evaluated: **once, after all elements exist with their literal attributes, in document order** (U-3). Evidence: (a) `left="jscript:view.width-N"` is paired with `horizontalAlignment="right"` in 2,773 of 2,791 cases, `top` with `verticalAlignment="bottom"` 2,602 times, `width="jscript:view.width"` with `horizontalAlignment="stretch"` 550 times: authors use the expression for the **initial** position and the alignment attribute to keep the anchor when the VIEW is resized (a live expression would make the alignment redundant); (b) referenced ids are declared before use 4,525 times, but 8 references are not: 2 in 9SeriesDefault are a **real forward reference** (`svMain.width` reads `svStub.width`, declared 816 lines later, literal 263) plus a self-reference (`svMain.left`), and 6 are three copies of QuickSilver where a SUBVIEW's width reads a *descendant* video's width (`videoWin.width`, itself a `jscript:` value, so its value at that moment is order-dependent). Hence a literal attribute is readable from anywhere, a `jscript:` attribute is readable only after its own evaluation. For live behaviour use `wmpprop:`.

### 3.3 `wmpprop:` live bindings
`attr="wmpprop:TARGET"`. Docs: "If the value of one attribute is specified to be the wmpprop: of a second attribute, the first value will be automatically updated to reflect the second value each time the second value changes." (`listening-attributes`, `internal-events`).
* One-way: target to attribute. Writing the attribute does not write the target; skins add `value_onchange` for that.
* `TARGET` is a dotted property path: `player.settings.volume`, `player.controls.currentPosition`, `player.currentMedia.duration`, `player.network.downloadProgress`, `mySlider.value`, `eq.gainLevel3`, `vidset.contrast`, `mediacenter.effectType`, `visEffects.currentPresetTitle`, `view.width`-style paths are not used (corpus: top bound names listed in 9.1).
* Docs warning: "Do not use wmpprop on Windows Media Player methods", yet the **predefined REPEATBUTTON/SHUFFLEBUTTON bind `down="wmpprop:player.settings.getMode('loop')"`**: a path with a call and constant arguments is accepted and must be re-evaluated when the mode changes (`ModeChange` event). Corpus counts for `wmpprop:` as attribute value: 6,332; by attribute: `value` 4,800, `max` 368, `enabled` 224, `down` 162, `visible` 128, `currentEffectType`/`currentPreset` 119 each, `foregroundProgress` 107, `left` 45, `top` 34, `tabStop` 25, `alphaBlend` 24. Layout bindings follow other elements (`top="wmpprop:svEqualizerBottomMiddle.top"`): a following element moves when its leader animates.
* Corpus oddity: `wmpprop:` as a *handler* prefix (117 times) is a label, 2.3.

### 3.4 `wmpenabled:` / `wmpdisabled:`
Docs: bind an attribute to whether a *method of the Controls object* is currently available ("methods of the Control object that are supported by the isAvailable method"): `enabled="wmpenabled:player.controls.play"`. `wmpdisabled:` is the negation.
* The accepted method names are exactly the `isAvailable` strings (`controls-isavailable`): `currentItem`, `currentMarker`, `currentPosition`, `fastForward`, `fastReverse`, `next`, `pause`, `play`, `previous`, `step`, `stop`.
* **In practice they bind any boolean attribute**, not only `enabled` as the docs imply: corpus `wmpenabled:` on `visible` 287, `enabled` 132, `tabStop` 46, `down` 3 (and once on `onclick`, an author error); `wmpdisabled:` on `enabled` 4, `visible` 2. Headspace: `visible="wmpenabled:player.controls.pause"` on the PAUSEBUTTON (swap play/pause) and `tabStop="wmpenabled:player.controls.play"`.
* Spelling: bare `player.controls.play` 454, with `;` 4, with `()` and `;` 11 (`player.Controls.Play();` in the docs example). Treat as "last path segment, ignore parentheses/semicolon/case" (U-4).
* Semantics to implement: re-evaluate `controls.isAvailable(name)` on play-state, open-state, playlist and position changes. For MPD: `play` available unless playing; `pause`/`stop` only when playing/paused; `next`/`previous` when queue length > 1 or (loop or shuffle); `currentPosition` and `fastForward`/`fastReverse` need seekable media (`fastForward/Reverse`: false for MPD, which has no scan).

### 3.5 `res://` URLs
Form `res://<module>/<RESTYPE>/#<id>` with module `wmploc`, `wmploc.dll` or `-` (current module = wmploc.dll), and RESTYPE `RT_TEXT`, `RT_STRING`, `RT_IMAGE`, `RT_BITMAP`. They address resources inside WMP's localisation DLL, which we do not have. Corpus counts (raw): `RT_TEXT/#132` as a `scriptFile` entry 433; `RT_STRING` (tooltips, `accName`, `accKeyboardShortcut`, `value`, even `fontFace`) ~220; `RT_IMAGE/#2024`-style images (9SeriesDefault) 32; `RT_BITMAP` 26; `res://-/RT_TEXT/#169` 4. `-` is an alias for the current module, wmploc.dll (`docs/research/wmploc-library.md` 5.1). Engine policy: provide the shared script (4.2) and the English string table (7.2); render unknown images as empty (RT_IMAGE contents are unresolved in `wmploc-library.md` 5.5). No fallback is documented (U-15).

### 3.6 Event-handler values
See 2.3. A handler may contain several statements and call functions from `scriptFile`s.

### 3.7 Colour of absent/`none`
VIEW `backgroundColor` default `white` (VIEW) / `none` (SUBVIEW). Headspace sets the VIEW to `none` so that only its children paint.

## 4. Global objects available to script

### 4.1 Documented globals (`B`global-attributes)
| Global | Refers to | Notes |
|---|---|---|
| `player` | the Player (WMP control) object | "you must use the name `player`", `working-with-the-player`. Members used by skins: section 7. |
| `theme` | the THEME element | `openView`, `closeView`, `currentViewID`, `savePreference`, `loadPreference`, `openDialog`, `playSound`, `logString`, `showErrorDialog`, `openViewRelative`, `author`, `title`, ... (6.1). |
| `view` | the *current* VIEW | alternative to the VIEW's `id`. Methods `close`, `minimize`, `maximize`, `restore`, `returnToMediaCenter`, `size`, plus ambient (`moveTo`, `alphaBlendTo`, ...) and attributes (`width`, `height`, `title`, `backgroundImage`, `timerInterval`, `focusObjectID`, `minWidth`...). Corpus references (raw occurrences, incl. `jscript:` layout expressions and duplicate skin variants): `view.width` 4,771, `view.height` 4,708, `view.close` 737, `view.minHeight` 158, `view.timerInterval` 236. |
| `event` | event attributes during a handler | 5.7. Corpus: `event.keyCode` 614, `shiftKey` 84, `button` 51, `screenHeight` 38. |
| `playerApplication` | PlayerApplication object | only in remoted-control hosts; ignore. |
| host scriptable object | optional | a C++ host can name one (`using-skins-with-the-windows-media-player-control`). This is the natural place for an engine to expose MPD-specific extensions. |

### 4.2 Shared constants script (`res://wmploc/RT_TEXT/#132`)
Loaded by the last entry of `scriptFile` in 433 corpus references (243 archives, 133 unique skins), including Headspace (`scriptFile="headspace.js;res://wmploc/RT_TEXT/#132"`). **Contents verified from the real `wmploc.dll` (WMP 10 and 11, byte-identical) by `docs/research/wmploc-library.md` section 2.2**: a 3,038-byte UTF-16LE script with **33 `var` constants and no functions**: 21 open-state constants `osUndefined`..`osMediaWaiting` (0..20), 12 play-state constants `psUndefined`..`psReconnecting` (0..11), and an array `WMPPlaylistChangeEventTypes` = `Unknown, Clear, InfoChange, Move, Delete, Insert, Append, Private, NameChange, Morph`. The numeric values are the documented ones (`B`player-openstate, `B`player-playstate); the skin names drop the `wmp` prefix of the C enum names. Corpus reads: `osMediaOpen` 351 (106 of 195 unique skins), `psPlaying` 117, `psPaused` 70, `psStopped` 69, `psUndefined`, `psScanForward/Reverse`, `psReady`, ... Some skins define the constants themselves (Cablemusic `psPlaying = 3` ...). The engine must provide:

| playState | value | | openState | value | | openState | value |
|---|---|---|---|---|---|---|---|
| psUndefined | 0 | | osUndefined | 0 | | osMediaOpen | 13 |
| psStopped | 1 | | osPlaylistChanging | 1 | | osBeginCodecAcquisition | 14 |
| psPaused | 2 | | osPlaylistLocating | 2 | | osEndCodecAcquisition | 15 |
| psPlaying | 3 | | osPlaylistConnecting | 3 | | osBeginLicenseAcquisition | 16 |
| psScanForward | 4 | | osPlaylistLoading | 4 | | osEndLicenseAcquisition | 17 |
| psScanReverse | 5 | | osPlaylistOpening | 5 | | osBeginIndividualization | 18 |
| psBuffering | 6 | | osPlaylistOpenNoMedia | 6 | | osEndIndividualization | 19 |
| psWaiting | 7 | | osPlaylistChanged | 7 | | osMediaWaiting | 20 |
| psMediaEnded | 8 | | osMediaChanging | 8 | | | |
| psTransitioning | 9 | | osMediaLocating | 9 | | | |
| psReady | 10 | | osMediaConnecting | 10 | | | |
| psReconnecting | 11 | | osMediaLoading | 11 | | | |
| | | | osMediaOpening | 12 | | | |

The docs also list a 22nd open state `OpeningUnknownURL = 21` that #132 does **not** define. Other `RT_TEXT` scripts exist (#169 = `sprintf` helpers used by 2 unique Microsoft skins; #134 font sizes; #136 visualizer-request constants) and are described in `wmploc-library.md` sections 2.3 and 7.6. No other function comes from wmploc (that note's call census: 404 "undefined" bare calls are element methods, case variants or genuine typos that throw in WMP too).
Sources: `B`player-playstate, `B`player-openstate; contents: `docs/research/wmploc-library.md`.

### 4.3 `mediacenter` (undocumented global and tag)
`<mediacenter videoZoom_onchange="StartPlaying();"/>` (2 tags) and 3,200 script references. It is the settings object shared with the WMP full mode: `videoZoom` (1,664 refs), `effectType` (659) and `effectPreset` (635) (persisted visualization choice: Headspace copies `visEffects.currentEffectType` to it in `OnClose` and back in `Init`), `videoStretchToFit` (167), `videoShrinkToFit` (66), `showTitles` (12), `showEffects`, `contrastMode`. The semantics are inferred from usage only (U-14). A skin engine can implement it as a persistent key/value object with change events.

## 5. Ambient attributes, methods, events and the `event` object

"Ambient" = available on (nearly) every element. Source index: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/ambient-attributes>. Per-attribute pages are `.../wmp/ambientattributes-<name>`. WMP version in the last column (7 = WMP 7.0+, 9 = WMP 9 Series+, 11 = WMP 11 only).

### 5.1 Ambient attributes

| Attribute | Type / values / default | Semantics (from the docs) | Ver |
|---|---|---|---|
| `id` | String; design-time only. Default `Unnamed_<elementtype>_<num>` (num counts unnamed controls in the theme). | Any name legal in VBA. Script resolves bare names to elements by id. `THEME` does not support `id` (use global `theme`). | 7 |
| `left` | long px, default 0 | Distance to left edge of parent VIEW/SUBVIEW. Negative allowed: the parent's left border clips the control. | 7 |
| `top` | long px, default 0 | As `left`; negative clipped by parent top. | 7 |
| `right` | long px | Distance to parent's right edge. "Behavior for negative values, or when `width` is not specified, is undefined." | 11 |
| `bottom` | long px, default 0 | As `right`, w.r.t. bottom/`height`. Undefined if `height` unspecified. | 11 |
| `width` | 16-bit int 0..32767; default 0 **or the width of the control's `image`** | Smaller than the image => image clipped. Larger => click region extends beyond image. "The image cannot grow beyond its parent VIEW or SUBVIEW" regardless. | 7 |
| `height` | long px; default 0 or image height | Same rules as `width`. | 7 |
| `zIndex` | long, default 0, signed | See 5.3. | 7 |
| `visible` | Boolean, default true. (AUTOMENU default false.) | If false, "click events are passed to the control behind it". | 7 |
| `enabled` | Boolean, default true. Not supported on SUBVIEW. | Disabled: no tab stop, receives no ambient mouse/keyboard events (still receives other ambient events, e.g. `_onchange`). | 7 |
| `tabStop` | Boolean. Default true except AUTOMENU and TEXT (false). N/A to EFFECTS. | Tab order = document order of tags. | 7 |
| `horizontalAlignment` | `left` (default) / `right` / `center` / `stretch` | Placement when the VIEW or parent SUBVIEW is resized. `stretch` keeps both left and right margins; the control stretches, but the image itself does not scale unless it is resizable (`resizeImages`), instead the clickable region grows unless bounded by a `clippingImage`. | 7 |
| `verticalAlignment` | `top` (default) / `bottom` / `center` / `stretch` | As above, vertical. Any combination of the two is allowed. | 7 |
| `alphaBlend` | long 0..255, default 255 | See 5.4. | 9 |
| `clippingImage` | String filename, no default | Region mask; see 5.5. | 7 |
| `clippingColor` | String: `Auto` (default; pixel 0,0) or any IE colour | Colour in the clipping image that is cut out. | 7 |
| `passThrough` | Boolean, default false | If true the control passes all mouse events to the control under it (example: a TEXT label over a button). Not supported by VIEW/SUBVIEW/PLAYLIST; not VIDEO when `windowless=false`; not EFFECTS when `windowed=true`. | 7 |
| `resizeImages` | Boolean | Images in the control resize with the control. Needed for `nineGridMargins`. | 11 |
| `nineGridMargins` | String `"left,top,right,bottom"` px | 3x3 nine-grid scaling margins. Requires `resizeImages=true`. | 11 |
| `elementType` | read-only String | Element tag name, e.g. `BUTTON`. | 7 |
| `accName` | String, default = `id` | Accessibility name. Also applies to buttons inside a BUTTONGROUP. | 9 |
| `accDescription` | String, default "" | Accessibility description. | 9 |
| `accKeyboardShortcut` | String, default "" (BUTTON: "Spacebar or Enter"; SLIDER: "Right/Up Arrow to increase, Left/Down Arrow to decrease") | Description only; does not bind a key. | 9 |

Sources: `.../wmp/ambient-attributes` and each `.../wmp/ambientattributes-<attr>` page (accname, accdescription, acckeyboardshortcut, alphablend, bottom, clippingcolor, clippingimage, elementtype, enabled, height, horizontalalignment, id, left, ninegridmargins, passthrough, resizeimages, right, tabstop, top, verticalalignment, visible, width, zindex).

### 5.2 Ambient methods (animation)

| Method | Signature | Notes | Ver |
|---|---|---|---|
| `moveTo` | `el.moveTo(newLeft, newTop, time)` | Linear motion over `time` ms. Fires `onendmove`. Intended for SUBVIEW trays. | 7 |
| `slideTo` | `el.slideTo(newX, newY, moveTime)` | Non-linear (ease-in/ease-out, "accelerates from zero then decelerates to zero"). | 11 |
| `moveSizeTo` | `el.moveSizeTo(newX, newY, newWidth, newHeight, moveTime, fSlide)` | Animates position and size; `fSlide=true` non-linear, `false` linear. | 11 |
| `alphaBlendTo` | `el.alphaBlendTo(newVal, alphaTime)` | Animates `alphaBlend` 0..255 over ms. Fires `onendalphablend`. | 9 |

Sources: `.../wmp/ambientattributes-moveto`, `-slideto`, `-movesizeto`, `-alphablendto`.
The `onendmove` page says it fires "when an element completes a **moveTo** operation"; whether `slideTo`/`moveSizeTo` also fire it, and the easing curve/frame rate, are UNCONFIRMED (U-25). Corpus: SUBVIEWs attach `onEndMove` 394 times (Headspace hides drawers in it). The animation methods also apply to the VIEW (window) itself: `view.moveTo` 36 corpus uses, `view.alphaBlendTo` 10.

### 5.3 zIndex semantics

Source: `.../wmp/ambientattributes-zindex` (verbatim rules in quotes).

* `zIndex` is a signed long, default 0; negative values are legal and common (corpus: 535 SUBVIEWs, 98 TEXT, 62 EFFECTS, 42 PLAYLIST, 16 VIDEO have negative z; SUBVIEW -1 and -2 are the most frequent; 15,709 of 38,377 elements set `zIndex`).
* "The background bitmap of a VIEW or SUBVIEW has a fixed z index of zero. If you want a control to be behind the background, the zIndex must be set to a negative number." So a control with `zIndex<0` is painted *under its parent's background image*, visible only where that background is transparent (`transparencyColor`) or clipped.
* "The z index of a VIEW or SUBVIEW is an absolute index, while the z index of a control is relative to the z index of the VIEW or SUBVIEW that contains it."
  *Stacking-context reading*: a SUBVIEW and everything inside it form one layer at the SUBVIEW's z (absolute for VIEW-level SUBVIEWs); children, controls and nested SUBVIEWs alike, are ordered among themselves by their own z relative to that SUBVIEW's background (0), then by document order, and never interleave with the SUBVIEW's siblings. *Additive/flat reading*: a child's absolute z = parent's z + child's z and everything is sorted globally.
  **The docs do not disambiguate (U-2), but Headspace does.** `docs/research/headspace-parity.md` section 0.1 rule 4 works the arithmetic for three readings (all-absolute, flat-relative with document-order ties, stacking context) and only the stacking context reproduces the skin: `sEqEar`/`sPlEar` (z=-1) are whole layers under the whole head layer (z=0), and inside the head layer `screen` (-2) and `visDrop` (-1) are under the head bitmap. My independent observation agrees: `visDrop` (z=-1) contains buttons z=1 and text z=2 and slides down from *behind* the brow through the face window; in a flat/additive model its text would paint over the head art. The hand port stacks `screen`, `visDrop`, then the head image (`src/main.js` 166-191), i.e. the stacking-context reading. Implement that; whether a SUBVIEW also clips its children to its own bounds is assumed, not verified.
* Equal z within one parent: not specified (U-1). Document order (later tag paints on top) is the natural reading and matches the doc's statement that tab order follows tag order (`ambientattributes-tabstop`).
* BUTTONELEMENTs have no z; "use the zIndex of their BUTTONGROUP" (corpus: 0 BUTTONELEMENTs set it).
* Not supported by PLAYLIST (nor BROWSER, which is not part of this element set). Ignored for VIDEO when `windowless=false`, and for EFFECTS when `windowed=true` (native windows paint above everything).
* zIndex can be changed at run time (`video.zIndex=-5`, corpus Colorchooser) which must re-sort.

### 5.4 alphaBlend semantics

Source: `.../wmp/ambientattributes-alphablend`.

* 0 = fully transparent, 255 = opaque (default). WMP 9 Series or later; not supported on Windows 98.
* Each element has its own value **except buttons inside a BUTTONGROUP** (group is blended as a unit).
* On a VIEW, it sets the opacity of the entire skin window.
* Does not work for windowed controls: PLAYLIST, EFFECTS (windowed), LISTBOX, POPUP, EDITBOX, and VIDEO when `windowless=false`.
* **`transparencyColor` is not supported together with `alphaBlend`** ("The transparencyColor attributes used by several elements are not supported with alphaBlend"). Engine implication: when alphaBlend < 255, keyed-out pixels may not stay keyed; behaviour UNCONFIRMED (U-13). Corpus: SUBVIEWs set `alphaBlend` 1,469 times, VIEWs 2, PLAYLIST-class controls never.
* TEXT with `alphaBlend` and no `backgroundColor` gets an implicit **black** background (black text on it becomes unreadable).

### 5.5 clippingColor / clippingImage vs transparencyColor

Sources: `.../wmp/ambientattributes-clippingcolor`, `.../ambientattributes-clippingimage`, `.../button-transparencycolor`, `.../buttongroup-transparencycolor`, `.../view-transparencycolor`.

| | `transparencyColor` | `clippingImage` + `clippingColor` |
|---|---|---|
| Applies to | The control's own image(s): BUTTON, BUTTONGROUP, SLIDER and CUSTOMSLIDER images (incl. thumb, in practice), VIEW/SUBVIEW `backgroundImage`. Whichever image is currently shown (script may swap `image`; the key stays). | Any control (ambient). For VIEW/SUBVIEW the clip source is the `backgroundImage` itself, so they use only `clippingColor` (corpus: 255 SUBVIEWs and 71 VIEWs have `clippingColor` with a `backgroundImage` and no `clippingImage`; 37 SUBVIEWs do use `clippingImage`, which the docs say is unsupported there). |
| Effect | Pixels of that colour are not painted; what is behind shows through. | The control's **region** is the pixels that are NOT `clippingColor`. Outside it the control is invisible, "transparent, non-clickable portions". "The clipping color can indicate multiple regions." |
| Hit-testing | **Still clickable** (BUTTON: "The BUTTON will still receive clicks on the transparent region"; BUTTONGROUP: "clickable unless clipped by the clippingImage tag"). | Not clickable; also defines the window outline for the top-level shape. |
| Values | `Auto` (pixel 0,0), an IE colour, or `None`; BUTTONGROUP default None; BUTTON/SLIDER no default. | `Auto` (default; pixel 0,0) or an IE colour. |
| Where declared | **Only where written**: `docs/research/headspace-parity.md` rule 5 (a SLIDER has no default `transparencyColor`, so undeclared slider art must not be keyed; map images are never keyed). | likewise per declaration |
| Cost / formats | cheap; JPG discouraged | "performance penalty"; PNG/JPG/BMP/GIF (not animated); JPG warned. |
| Unsupported on | (not with alphaBlend, U-13) | PLAYLIST (both), VIEW/SUBVIEW `clippingImage`, VIDEO windowless=false, EFFECTS windowed=true |

**Worked example, Headspace** (the head SUBVIEW, decoded `headspace.wms` lines 16-21; art analysed from the `/tmp` extraction): the head SUBVIEW has `backgroundImage="head.bmp" clippingColor="#FF0000" transparencyColor="#FF00FF"`. `head.bmp` is 234x394: **red** `#FF0000` = 17,909 px over the whole bitmap (pixel (0,0) is red, so `Auto` would give the same) = outside the head, invisible *and* click-through (this is the window's shape); **magenta** `#FF00FF` = 31,487 px in the rectangle (10,59)-(223,215) = the face window: invisible but **hit-testable** and it lets the `vid_bkgd` SUBVIEW (z=-2), the EFFECTS/VIDEO inside it, and the sliding `visDrop` SUBVIEW (z=-1) show through. The hand port's `tools/convert_skin.py` bakes both keys into alpha and keeps `headArt` `pointer-events:none` so the face window stays clickable, matching these rules.
Related rule for a VIEW with `backgroundColor="none"` and no `backgroundImage` (Headspace): the window outline is the union of the children's painted, non-clipped pixels (inferred, U-12).
Corpus keys: `transparencyColor` `#ff00ff` 8,895, `#ffffff` 398, `#00ff00` 309, `#ff0000` 269; `clippingColor` `#ff00ff` (BUTTON 122, SUBVIEW 70, BUTTONGROUP 52), `#ff0000` (SUBVIEW 77, VIEW 32), `white`/`#ffffff`.

### 5.6 Ambient event handlers

Source: `.../wmp/ambient-event-handlers` and `.../wmp/<handler>`. Handler attribute = `on` + event name, value is script (see section 3).

| Handler | Fires when | N/A for |
|---|---|---|
| `attribute_onchange` (e.g. `value_onchange`) | any skin attribute changes; name = attribute + `_onchange`. Example from docs: `value_onchange="JScript: if (value == 100) backgroundColor = 'green';"` | |
| `onclick` | click | PLAYLIST, POPUP, VIDEO, LISTBOX; VIDEO when `windowless=false`; EFFECTS when `windowed=true` |
| `ondblclick` | double-click | PLAYLIST, POPUP; VIDEO(windowless=false); EFFECTS(windowed=true) |
| `onmousedown` | mouse button down | PLAYLIST; VIDEO(windowless=false); EFFECTS(windowed=true) |
| `onmouseup` | button released over element | PLAYLIST |
| `onmousemove` | pointer moves over element | PLAYLIST; VIDEO(windowless=false); EFFECTS(windowed=true) |
| `onmouseover` | pointer first enters | PLAYLIST |
| `onmouseout` | pointer leaves | PLAYLIST |
| `onkeydown` / `onkeypress` (alphanumeric only) / `onkeyup` | keyboard | PLAYLIST, EFFECTS; VIDEO(windowless=false) |
| `onfocus` / `onblur` | element gains/loses keyboard focus | EFFECTS, POPUP |
| `onresize` | control resizes | |
| `onendmove` | completes a `moveTo` | |
| `onendalphablend` | completes `alphaBlendTo` | |

VIEW-only handlers (`onload`, `onclose`, `onerror`, `ontimer`) are in section 6.2. The `external-events` page also lists `load`, `close`, `resize`, `timer`, `error` as "events supported by skin elements".

### 5.7 The `event` object (global `event`, valid only inside a handler)

Source: `.../wmp/ambient-event-attributes` and `.../wmp/event-<name>`. All read-only. "You can only process event attributes in JScript code" as `event.<name>`.

| Property | Type | Meaning |
|---|---|---|
| `altKey`, `ctrlKey`, `shiftKey` | Boolean | modifier down at event time |
| `button` | long | 0 none, 1 left, 2 right, 3 both (bitmask of buttons down) |
| `keyCode` | long | "ASCII key code" of key pressed |
| `x`, `y` | long | pointer relative to the **application window** (the VIEW) |
| `clientX`, `clientY` | long | pointer relative to client region of the application window (identical to x,y when `titleBar=false`; whether they differ with a title bar is UNCONFIRMED, U-26) |
| `offsetX`, `offsetY` | long | pointer relative to the element firing the event |
| `screenX`, `screenY` | long | absolute screen pointer position |
| `screenWidth`, `screenHeight` | long | available screen size in px (sum over monitors) |
| `srcElement` | object | element that fired the event |
| `fromElement` | object | element the event came from; NULL if none |
| `toElement` | object | only for `onblur`: element focus moved to; otherwise NULL |

## 6. Element reference

Conventions: "Ver" = first WMP version. `R/W` = read/write at run time; `design` = XML only. Every element also has the ambient attributes/handlers of section 5 unless a row says otherwise. Base URL `B` = `https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/`; each element heading gives its page.

### 6.1 THEME
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/theme-element>

Root element, exactly one per `.wms`; contains one or more VIEWs. Accessed from script only as global `theme` (no `id`). **No event handlers.**

| Attribute | Type | Access | Notes |
|---|---|---|---|
| `author` | String | R/W | skin author. Corpus: THEME carries `author` 332x, `copyright` 331x, `title` 152x, `authorVersion` 43x, `currentViewID` 32x, and (ignored) `id` 205x; VIEW never has `author` (one doc example puts it there). |
| `authorVersion` | String | R | |
| `copyright` | String | R/W | |
| `title` | String | R/W | skin title |
| `version` | float | design | "Specifying a value ... has no effect. The value is always 1.0." Corpus: attribute is present as e.g. `version="1.0"`. |
| `currentViewID` | String (a VIEW id) | R/W | Setting it "automatically closes the existing currentView (pointed to by the `view` global) and opens the specified VIEW". At design time it chooses the initial view (`<THEME currentViewID="startView">`); otherwise the first VIEW in document order is the main window (the doc example's own comment says the first VIEW "would have been the default view"; corpus: 174 multi-VIEW skins, 24 use `currentViewID`, 0 use `category`; U-8). |

| Method | Signature | Notes |
|---|---|---|
| `openView` | `theme.openView(viewId)` | Opens VIEW in a **new window** (does not close the current one). |
| `openViewRelative` | `theme.openViewRelative(viewId, left, top)` | WMP 9+. Initial offset from skin's top-left; negative = left/above. Position honoured only the first call; afterwards the last user-dragged position is reused. (The doc's syntax line mistakenly prints `theme.openView(view, left, top)`.) |
| `closeView` | `theme.closeView(viewId)` | |
| `savePreference` | `theme.savePreference(key, value)` | String key/value into the **registry**; survives player restarts. Not encrypted. See 7.3. |
| `loadPreference` | `theme.loadPreference(key)` -> String | Missing-key return value UNCONFIRMED (U-16); see 7.3. |
| `openDialog` | `theme.openDialog('FILE_OPEN','FILES_ALLMEDIA')` -> String URL or "" | Only those two argument values are legal. |
| `playSound` | `theme.playSound(wavFile)` | WMP 9+. WAV only; played by the OS, independent of the player. |
| `logString` | `theme.logString(msg)` | Writes to the error log if logging enabled. |
| `showErrorDialog` | `theme.showErrorDialog()` | Only meaningful when `Settings.enableErrorDialogs` is false; in WMP 9+ must be called from the `error` handler. |

Sources: `.../theme-author`, `-authorversion`, `-copyright`, `-currentviewid`, `-title`, `-version`, `-closeview`, `-loadpreference`, `-logstring`, `-opendialog`, `-openview`, `-openviewrelative`, `-playsound`, `-savepreference`, `-showerrordialog` (all under `B`).

### 6.2 VIEW
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/view-element>

Child of THEME only; contains all other elements. **Each VIEW has its own variable scope** and cannot share attribute values with other views (see section 2). Script reaches the *current* view as global `view`, and other views/THEME by `id`.

| Attribute | Type / default | Ver | Notes |
|---|---|---|---|
| `backgroundImage` | String | 7 | BMP/JPG/GIF/PNG. If an **8-bit BMP**, `backgroundImageHueShift` / `Saturation` can recolour it at run time. "You must define the backgroundImage attribute or your view will have no starting image" (skin-definition-file-structure). In a WM Download package also requires `backgroundColor`. |
| `backgroundColor` | IE colour or `none`; default `white` for VIEW, `none` for SUBVIEW | 7 | |
| `backgroundTiled` | Boolean, default false (SUBVIEW too) | 7 | Image repeated horizontally and vertically to fill the view size. |
| `backgroundImageHueShift` | float 0.0..360.0, default 0.0 | 9 | 8-bit BMP only. |
| `backgroundImageSaturation` | float 0.0..2.0, default 1.0 | 9 | 8-bit BMP only. |
| `resizeBackgroundImage` | Boolean, default false | 9 | true: image stretches to current `width`/`height`. |
| `transparencyColor` | IE colour, no default | 7 | Colour of `backgroundImage` made transparent (defines window shape). JPG discouraged. Also on SUBVIEW. |
| `title` | String <=255 chars; design-time, read-only after | 7 | "The display name for the theme"; the window title when `titleBar` is true (corpus: only 11 VIEWs set it; THEME `title` is the common one). |
| `titleBar` | Boolean, default **true**; read-only | 7 | If shown: control box, minimize, close are shown and the title is the VIEW `title`. With a title bar and `Video.zoom` changed, the skin must resize itself. |
| `resizable` | Boolean, **read-only**, default = `titleBar` | 7 | Without a title bar the user can only resize via `view.size(handle)`. It gates *user* resizing only: Headspace has `resizable="false"` and its script sets `view.width = 760` / `549` (drawer open/close), so **script resizing is always allowed**. Corpus: `true` 400, `false` 285, unset 284; misspelling `resizeable` 8x. |
| `minWidth`,`minHeight`,`maxWidth`,`maxHeight` | long >=0; 0 = unrestricted | 7 | Limits while resizing. |
| `category` | `All` (default) / `Radio` / `CD` / `DVD` / `Music` / `Video` | 7 | The media category the VIEW is "intended for". How WMP would select among category-tagged VIEWs is not documented, and no corpus VIEW uses it. |
| `scriptFile` | write-only String; `;`-separated names, no leading/trailing spaces or `;` | 7 | Loads JScript. A `<skinname>.js` next to `<skinname>.wms` loads automatically (section 2). |
| `timerInterval` | long ms; default **1000**; 0 = off; <50 (non-zero) => error, previous value kept | 7 | Timer only runs if `ontimer` is implemented. |
| `focusObjectID` | String (element id); run-time only | 7 | Which element has keyboard focus. |
| `width`, `height` | ambient | 7 | VIEW size when given (doc example `width=500 height=300`; Headspace `760x394`); for a VIEW without them the size presumably comes from `backgroundImage` (not stated). Script may assign `view.width/height` at any time (Headspace, Classic). |

| Method | Notes |
|---|---|
| `close()` | Closes the VIEW (closing the main view ends the skin). |
| `minimize()`, `maximize()`, `restore()` | window state. |
| `returnToMediaCenter()` | switch back to WMP full mode. |
| `size(handle)` | `handle` in `top,right,bottom,left,topright,bottomright,bottomleft,topleft`. Call from `onmousedown`; runs the drag-resize loop itself, honours min/max. |

| Handler | Notes |
|---|---|
| `onload` | "when the VIEW is first displayed". Corpus: 904 VIEWs, usually `onload="Init();"`. |
| `onclose` | "about to be closed" (used for `savePreference`). |
| `ontimer` | every `timerInterval` ms. |
| `onerror` | only when `Settings.enableErrorDialogs` is false. |

The VIEW supports ambient attributes and event handlers "except where noted" (e.g. `passThrough`, `clippingImage`, `enabled` do not apply).

Corpus attributes on VIEW beyond the table (counts over 969 VIEWs): `id` 837 (needed for `openView`), `onKeyPress` 518 (hotkeys, `event.keyCode`), `onTimer` 285, `onResize` 31, `onKeyDown` 2, `onMouseOver/Out` 4, `zIndex` 14, `visible` 4, `left/top` 2, `alphaBlend` 2, `width_onchange`/`height_onchange` 4, `focusObjectID_onchange` 2, `tabStop` 10, and the **undocumented `stickyBorderWidth`** (12x, one skin, value 4; presumably window-edge snapping distance; UNCONFIRMED, U-30; ignore). `titleBar` is `false` in 952 of 969 VIEWs (the rest default true), `backgroundColor` set in 867, `backgroundImage` in only 135, `clippingColor` 80, `transparencyColor` 46. The window size is `width`/`height` when given (855 VIEWs); a VIEW with only `backgroundImage` takes the image size.

Sources under `B`: `view-backgroundcolor`, `-backgroundimage`, `-backgroundimagehueshift`, `-backgroundimagesaturation`, `-backgroundtiled`, `-category`, `-close`, `-focusobjectid`, `-maxheight`, `-maximize`, `-maxwidth`, `-minheight`, `-minimize`, `-minwidth`, `-onclose`, `-onerror`, `-onload`, `-ontimer`, `-resizable`, `-resizebackgroundimage`, `-restore`, `-returntomediacenter`, `-scriptfile`, `-size`, `-timerinterval`, `-title`, `-titlebar`, `-transparencycolor`.

### 6.3 SUBVIEW
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/subview-element>

A positioned, stackable sub-surface inside a VIEW "for parts of your skin that you want to move around, hide, or show" (drawers, trays, but also the skin's whole decorative skeleton).

* **Nesting.** Docs: always a child of a VIEW; may contain any element "except for VIEW, THEME, and other SUBVIEW elements". **Corpus contradicts this**: 12,804 SUBVIEWs, of which 10,452 are direct children of a VIEW, 1,886 nested one level, 357 at level 2, 105 at level 3, 4 at level 4; 254 of 339 skins nest (Headspace: 23 SUBVIEWs, nesting to level 2). Support arbitrary nesting. Children are positioned relative to the SUBVIEW's top-left; `zIndex` of a child is relative to its SUBVIEW (5.3); `visible=false`, `alphaBlend`, `moveTo` on a SUBVIEW apply to the whole subtree (Headspace slides drawers by moving a SUBVIEW).
* Own attributes (defined under VIEW): `backgroundImage`, `backgroundColor` (default `none`), `backgroundTiled`, `backgroundImageHueShift`, `backgroundImageSaturation`, `resizeBackgroundImage`, `transparencyColor`. `backgroundTiled` repeats the image to fill `width`x`height` (corpus: `true` 2,829, `false` 14: used for stretchable skin edges).
* `width`/`height` default to the background image size; with no background image and no size the SUBVIEW has zero size (Headspace's `sEqEar` gives `width/height` and `backgroundColor="none"` so its children have a clipping rectangle).
* Documented event handlers: only the ambient `onendmove` and `onresize`. Corpus adds `onendalphablend` 48, `onclick` 14, `onkeydown` 1.
* Ambient attributes "except where noted": `enabled` unsupported (corpus uses it 104x anyway), `passThrough` unsupported by the docs but used 554x on SUBVIEWs (U-7), `clippingImage` unsupported by the docs, used 37x.
* Corpus attribute census for SUBVIEW (12,804): `zIndex` 11,514, `left` 10,487, `top` 10,422, `backgroundImage` 10,138, `id` 7,311, `transparencyColor` 6,424, `horizontalAlignment` 5,990, `verticalAlignment` 5,573, `width` 3,797, `height` 3,733, `backgroundTiled` 2,843, `visible` 2,187, `alphaBlend` 1,469, `backgroundColor` 1,100, `passThrough` 554, `onEndMove` 394, `clippingColor` 289.
* `moveTo/slideTo/moveSizeTo` on a SUBVIEW are the standard way to slide a drawer (Headspace: `sEqEar.moveto(eqOpenedPos, sEqEar.top, speed)` with `speed=120` ms).

### 6.4 BUTTON (and predefined buttons)
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/button-element>

A stand-alone, individually positioned button. Position/size come from ambient `left/top/width/height`; `width`/`height` default to the image size.

| Attribute | Type / default | Semantics | Ver |
|---|---|---|---|
| `image` | filename (BMP/JPG/PNG/GIF incl. animated GIF) | Up-state image. **If no `image` but `width`+`height` are given, "the image directly behind this control is displayed"**: the button is a hit-region over whatever is drawn beneath (typically the VIEW background), so a skin can paint buttons on the background. Larger than `width`x`height` => cropped. Failed load => red-X placeholder image. | 7 |
| `hoverImage` | filename; falls back to `image` | Up + mouse over. | 7 |
| `downImage` | filename; falls back to `image` | Pressed (mouse down, or latched when `sticky` and `down`). | 7 |
| `hoverDownImage` | filename; falls back to `downImage` | Down state + mouse over. | 7 |
| `disabledImage` | filename | Shown when `enabled=false`. (The page says "disabled attribute"; it means `enabled=false`.) | 7 |
| `sticky` | Boolean, default false | Toggle: click latches down state until clicked again. | 7 |
| `down` | Boolean, default false | Current latched state. Setting true is **ignored unless `sticky=true`**. Commonly bound: `down="wmpprop:player.settings.mute"`. | 7 |
| `tiled` | Boolean, default false | Repeat the image to fill `width`x`height` if the image is smaller. Forced false if no image. | 7 |
| `transparencyColor` | `Auto` (pixel 0,0) / IE colour / `None`; no default | Colour keyed out of all of the button's images. **Transparent area still receives clicks.** Invalid colour => previous value kept. | 7 |
| `cursor` | `system` (default), `hand`, `help`, `sizeall`, `sizenesw`, `sizens`, `sizenwse`, `sizewe`, `uparrow`, or `*.ani`/`*.cur` | Cursor files must be in the .wms directory / inside the .wmz; any path component is ignored. Unknown value => previous value kept. | 7 |
| `upToolTip` | String <=1024, default "" (none) | Tooltip while up. | 7 |
| `downToolTip` | String <=1024, default "" | Tooltip while down. | 7 |

State resolution (derived from the fallbacks above): disabled -> `disabledImage`; down+hover -> `hoverDownImage` -> `downImage` -> `image`; down -> `downImage` -> `image`; hover -> `hoverImage` -> `image`; else `image`. Handlers: all ambient (`onclick`, `onmousedown`, ...).

**Predefined buttons** (`.../wmp/closebutton`, `ffwdbutton`, `imagebutton`, `minimizebutton`, `mutebutton`, `nextbutton`, `pausebutton`, `playbutton`, `prevbutton`, `repeatbutton`, `returnbutton`, `rewbutton`, `shufflebutton`, `stopbutton`) are plain BUTTONs with default attribute values; any default can be overridden by writing the attribute explicitly.

| Tag | Defaults |
|---|---|
| CLOSEBUTTON | `onclick="jscript:view.close();"` `upToolTip="Close"` |
| MINIMIZEBUTTON | `onclick="jscript:view.minimize();"` `upToolTip="Minimize"` |
| RETURNBUTTON | `onclick="jscript:view.returnToMediaCenter();"` `upToolTip="Return to Full Mode"` |
| IMAGEBUTTON | `cursor="Hand"` (just an image container) |
| PLAYBUTTON | `onclick="jscript:player.controls.play()"` `upToolTip="Play"` `cursor="system"` `enabled="wmpenabled:player.controls.play"` |
| PAUSEBUTTON | `...controls.pause()` / "Pause" / `wmpenabled:player.controls.pause` |
| STOPBUTTON | `...controls.stop()` / "Stop" / `wmpenabled:player.controls.stop` |
| NEXTBUTTON | `...controls.next()` / "Next" / `wmpenabled:player.controls.next` |
| PREVBUTTON | `...controls.previous()` / "Previous" / `wmpenabled:player.controls.previous` |
| FFWDBUTTON | `...controls.fastForward()` / "Fast Forward" / `wmpenabled:player.controls.fastForward` |
| REWBUTTON | `...controls.fastReverse()` / "Fast Reverse" / `wmpenabled:player.controls.fastReverse` |
| MUTEBUTTON | `onclick="jscript:player.settings.mute=down;"` `upToolTip="Mute"` `downToolTip="Sound"` `down="wmpprop:player.settings.mute"` `sticky="true"` |
| REPEATBUTTON | `onclick="jscript:player.settings.setMode('loop',down);"` tooltips "Turn Repeat On"/"Turn Repeat Off" `down="wmpprop:player.settings.getMode('loop')"` `sticky="true"` |
| SHUFFLEBUTTON | `onclick="jscript:player.settings.setMode('shuffle',down);"` tooltips "Turn Shuffle On"/"Turn Shuffle Off" `down="wmpprop:player.settings.getMode('shuffle')"` `sticky="true"` |

Engine notes: (1) `onclick="...mute=down;"` shows that **bare identifiers in a handler first resolve to the firing element's own attributes** (`down`), section 2.4. (2) Because the predefined `enabled="wmpenabled:..."` binding is a *default*, a skin that writes `<PLAYBUTTON disabledImage=.../>` greys the button out automatically when `controls.play` is unavailable (empty queue, or already playing); the MPD adapter therefore needs `controls.isAvailable(name)` (3.4). (3) Corpus spellings for the same binding differ (`wmpenabled:player.controls.play`, `...play;`, `player.Controls.Play();`): normalise by taking the last path segment, dropping `()`/`;` and ignoring case (U-4). Corpus use of predefined buttons and sliders: PAUSEBUTTON 213 tags, PLAYBUTTON 111, PREVBUTTON 111, NEXTBUTTON 108, STOPBUTTON 104, VOLUMESLIDER 62, RETURNBUTTON 32, MUTEBUTTON 18, FFWD/REWBUTTON 12 each, CLOSEBUTTON 12, MINIMIZEBUTTON 11, IMAGEBUTTON 9, SHUFFLE/REPEATBUTTON 9 each. Images that declare no `transparencyColor` are drawn opaque; Headspace declares `#FF00FF` exactly on the buttons whose bitmaps contain magenta (section 9.5).

Sources under `B`: `button-cursor`, `button-disabledimage`, `button-down`, `button-downimage`, `button-downtooltip`, `button-hoverdownimage`, `button-hoverimage`, `button-image`, `button-sticky`, `button-tiled`, `button-transparencycolor`, `button-uptooltip`.

### 6.5 BUTTONGROUP
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/buttongroup-element>

A set of non-rectangular buttons defined by **one set of state images** plus a **mapping image** whose colours identify each child BUTTONELEMENT's pixels. All images (`image`, `hoverImage`, `downImage`, `hoverDownImage`, `disabledImage`, `mappingImage`) are *the same size* (the group's size/position are the ambient `left/top/width/height`, defaulting to the image size). A button's visible state is obtained by copying **the pixels of the button's mapped region out of the appropriate state image**.

| Attribute | Type / default | Semantics | Ver |
|---|---|---|---|
| `mappingImage` | filename; **mandatory** | Colour map of clickable regions, same size as `image`. PNG/BMP/GIF(non-animated)/JPG (JPG discouraged). | 7 |
| `image` | filename | Normal state of all buttons. Cropped if larger than the group region. | 7 |
| `hoverImage` | filename; falls back to `image` | Hover (up). | 7 |
| `downImage` | filename; falls back to `image` | Down. | 7 |
| `hoverDownImage` | filename; falls back to `downImage` | Hover + down. | 7 |
| `disabledImage` | filename | Region of this image shown for a BUTTONELEMENT whose `enabled` is false. | 7 |
| `showBackground` | Boolean, default **false** | false: only the pixels in regions that match an assigned `mappingColor` are drawn. true: the **entire** `image` is drawn, and the area outside buttons comes from `image`. | 7 |
| `radio` | Boolean, default false | All elements become sticky; exactly one down at a time. | 7 |
| `transparencyColor` | `Auto` / IE colour / `None` (default None) | Keyed colour in all group images. "The transparent region is clickable unless clipped by the `clippingImage`". | 7 |
| `cursor` | as BUTTON | Applies to all buttons of the group. | 7 |
| `hueShift` | float 0..360, default 0 | Only for **8-bit BMP** images; applies to all of `image`, `hoverImage`, `downImage`, `hoverDownImage`, `disabledImage`. | 9 |
| `saturation` | float 0..2, default 1.0 | Same restriction. | 9 |
| `buttonCount` | long, read-only | | 9 |

Methods (WMP 9+): `click(index)` runs that element's `onclick`; `getButton(index)` -> BUTTONELEMENT object. Handlers: all ambient. `zIndex`, `alphaBlend` are those of the group (elements have none; alphaBlend is per group, not per element).

**Map images are not flat.** The docs say to "copy the art you created for your background to a mapping layer" and flood-fill each button, so a map holds the background art (anti-aliased, hundreds of colours) *plus* the flat key colours: Headspace's `play_controls_map.bmp` has 366 distinct colours of which exactly 5 are keys (`#FF0033` prev, `#FFFF00` play, `#00FF00` stop, `#00FFFF` next, `#0000FF` vis; 461 px each = 2,305 owned of 3,600). Ownership must therefore be an **exact RGB match** (the hand port does exactly that, `widgets.js` lines 114-123); no nearest-colour or tolerance, and lossy JPG maps are unreliable (corpus maps: png 605, bmp 590, gif 247, jpg 17).

**Unowned pixels (U-23).** With the documented default `showBackground=false` only pixels owned by a BUTTONELEMENT are painted; the rest of the group's rectangle shows what is behind. The hand port paints the *whole* group image (`layers[o<0?0:st[o]]`, i.e. `showBackground=true`), which is only equivalent if the unowned pixels coincide with the art underneath. Measured on Headspace: for the transport group, 811 of its 1,295 unowned pixels differ from `head.bmp` underneath (mean per-channel delta 34, max 189, 257 px over 30); for the minimize/close group 1 pixel differs (by 2). So an engine implementing the docs literally will differ from the oracle in roughly 800 pixels around the transport buttons. Only a real-WMP screenshot can settle which is right; implement `showBackground` as documented and make it a switch.

Sources under `B`: `buttongroup-buttoncount`, `-click`, `-cursor`, `-disabledimage`, `-downimage`, `-getbutton`, `-hoverdownimage`, `-hoverimage`, `-hueshift`, `-image`, `-mappingimage`, `-radio`, `-saturation`, `-showbackground`, `-transparencycolor`.

### 6.6 BUTTONELEMENT (and predefined elements)
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/buttonelement-element>

One mapped button in a BUTTONGROUP. Only child of BUTTONGROUP. Has **no geometry of its own**: its hit/paint region is the set of mapping-image pixels equal to `mappingColor`.

| Attribute | Type / default | Semantics | Ver |
|---|---|---|---|
| `mappingColor` | IE colour, no default | Colour key in the group's `mappingImage`. All clicks in that region go to this element. "If an invalid color is specified, the BUTTONELEMENT is not activated." Compare exactly (no tolerance is documented; see 9.3 for how skins pick colours). | 7 |
| `sticky` | Boolean, default false | Toggle semantics; down region shown from group `downImage`. | 7 |
| `down` | Boolean, default false | Ignored unless `sticky`. | 7 |
| `upToolTip` / `downToolTip` | String <=1024, "" none | | 7 |
| `cursor` | as BUTTON | | 7 |
| `index` | long, read-only | position within group | 9 |
| `enabled`, `tabStop` | ambient | **The only ambient attributes supported** by BUTTONELEMENT. | 7 |

Method: `click()` runs this element's `onclick` (WMP 9+). Handlers: ambient handlers.

Predefined elements (all attributes overridable; `.../wmp/ffwdelement`, `nextelement`, `pauseelement`, `playerelement` (= PLAYELEMENT), `prevelement`, `rewelement`, `stopelement`):

| Tag | Defaults |
|---|---|
| PLAYELEMENT | `onclick="jscript:player.controls.play()"` `upToolTip="Play"` `cursor="system"` `enabled="wmpenabled:player.controls.play"` |
| PAUSEELEMENT | `...controls.pause()` "Pause" `wmpenabled:player.controls.pause` |
| STOPELEMENT | `...controls.stop()` "Stop" `wmpenabled:player.controls.stop` |
| NEXTELEMENT | `...controls.next()` "Next" |
| PREVELEMENT | `...controls.previous()` "Previous" |
| FFWDELEMENT | `...controls.fastForward()` "Fast Forward" |
| REWELEMENT | `...controls.fastReverse()` "Fast Reverse" (the parent page's summary table says `controls.rewind`; the element's own page says `fastReverse`, which is the real API; use `fastReverse`) |

(There are no MUTE/REPEAT/SHUFFLE/CLOSE/MINIMIZE *ELEMENT* tags in the docs; corpus census agrees: only stop/next/play/prev/pause/ffwd/rew elements appear.)

Complete doc example (buttonelement-mappingcolor page): THEME > VIEW(backgroundImage, titleBar=False) > PLAYER URL + EFFECTS + BUTTONGROUP(mappingImage, hoverImage) > two BUTTONELEMENT(mappingColor="#00FF00"/"#FF0000", onClick="JScript:myeffects.next();").

Sources under `B`: `buttonelement-click`, `-cursor`, `-down`, `-downtooltip`, `-index`, `-mappingcolor`, `-sticky`, `-uptooltip`.

### 6.7 SLIDER (also BALANCESLIDER, SEEKSLIDER, VOLUMESLIDER)
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/slider-element>

A horizontal/vertical value control. Two construction styles: (a) **colours** (`backgroundColor` + `foregroundColor`, optional gradient end colours); (b) **images** (`backgroundImage` + `foregroundImage` + `thumbImage`). Position = fraction `(value-min)/(max-min)` of the track.

| Attribute | Type / default | Semantics |
|---|---|---|
| `min` | float, default 0 | Must be < `max`. |
| `max` | float, default 100 | Must be > `min`. Often `wmpprop:player.currentMedia.duration`. |
| `value` | float, default = `min` | Current position. **Out-of-range assignment is ignored** (value and thumb unchanged). |
| `direction` | `horizontal` (default; min at left, max at right) / `vertical` (**min at bottom, max at top**) | Axis of fill/movement. |
| `backgroundColor` | IE colour, no default | Track fill. |
| `backgroundEndColor` | IE colour | Gradient from `backgroundColor` to this. |
| `foregroundColor` | IE colour, default `white` | Fill that "covers the background as position increases". |
| `foregroundEndColor` | IE colour | Gradient from `foregroundColor` to this. |
| `disabledColor` | IE colour | Colour when `enabled=false` in colour mode. |
| `backgroundImage` | filename (non-animated) | Main track image. If smaller than the control and `tiled`, tiled along `direction`; with `borderSize>0`, that many px at each end are untiled end-caps and only the middle is tiled. |
| `backgroundHoverImage` | filename; falls back to `backgroundImage` | |
| `foregroundImage` | filename | Shown on one side of an invisible line at the thumb; background on the other. If smaller than the foreground area and `tiled`, tiled to fill. |
| `foregroundHoverImage` | filename | Doc says falls back to `backgroundImage` (probable doc typo for `foregroundImage`; UNCONFIRMED, U-10). |
| `disabledImage` | filename; falls back to `backgroundImage` | **"When a slider control is disabled, no foreground image is visible."** |
| `thumbImage` | filename | The movable thumb. **"If no thumb image is specified, the slider is non-interactive."** Centered in the narrow dimension; if larger than the control, ends are cut. **Slider position = centre of the thumb**, so with `borderSize=0` only half the thumb is visible at the extremes; set `borderSize >= thumb half-length`. |
| `thumbHoverImage` | filename | If absent, no hover change. |
| `thumbDownImage` | filename; falls back to `thumbImage` | While dragging. |
| `thumbDisabledImage` | filename; falls back to `thumbImage` | |
| `slide` | Boolean, default **true** | true: the foreground image *slides* (is pulled along behind the thumb, i.e. its right edge tracks the thumb, showing its own right-hand part). false: the foreground image stays fixed and is *revealed* (clipped) up to the thumb. |
| `tiled` | Boolean; the page's table marks **true** as "Default" | Applies only to image mode. Signal from the corpus: Headspace writes `tiled="true"` explicitly on its 12 balance/volume/EQ sliders (not on the seek bar, whose art already equals the control size); corpus overall `true` 255, `false` 154, unset 3,402. Authors writing both values hints the effective default may be false; the hand port tiles exactly the 12 sliders that say `true` (U-10). |
| `borderSize` | long px, default 0 | Inset at each end (left/right if horizontal, top/bottom if vertical) that bounds the thumb's min/max positions "beyond which the foreground ... will not be applied". |
| `transparencyColor` | IE colour, no default | Applies to the slider's background and foreground images (thumb too in practice, UNCONFIRMED, U-10). |
| `useForegroundProgress` | Boolean, default false | Enables `foregroundProgress`. |
| `foregroundProgress` | float 0..100 | Download/buffer progress shown as an extra foreground; "the position of the slider thumb is constrained to the area of the foreground progress" (so a seek bar cannot be dragged beyond the buffered part). |
| `toolTip` | String <=1024, no default | |
| `cursor` | as BUTTON but **default `hand`** | |

**Geometry (what the oracle does, and where the docs differ; U-10).** Let `L` = track length along `direction`, `t` = thumb length along it, `b` = `borderSize`, `f = (value-min)/(max-min)` (vertical: `f` measured from the bottom).
* Docs: the slider position is the *centre* of the thumb, and `borderSize` bounds the thumb's min/max positions, so the thumb centre travels over `[b, L-b]`: `centre(f) = b + f*(L-2b)`. With `b=0` half the thumb is outside the control at the ends; set `b >= t/2` to avoid that.
* Hand port (`src/widgets.js` `slider`): thumb *left edge* travels `0 .. L-t`, i.e. centre over `[t/2, L-t/2]`, ignoring `b`; for the seek bar the foreground image is clipped to width `f*(L-t) + t/2` (`slide=false`: foreground *revealed*, not moved).
* For Headspace's seek bar these agree: `borderSize=9`, thumb 18 px, track 163 px, travel 145 = 163 - 18. They **disagree for the volume/balance/EQ sliders**: `borderSize=7`, horizontal thumb 9 px (`horizontal_thumb.bmp` 9x11), track `width=71` (docs: centre over [7,64], travel 57; oracle: [4.5,66.5], travel 62), vertical EQ thumb 11 px, track `height=76` (docs: travel 62; oracle: 65). The track art is a 15 px tile with `borderSize=7` (7+1+7), which fits `borderSize` as the *end-cap size of the tiled background*, so both readings are plausible. Resolve against a real WMP screenshot before trusting either (U-10).
* `slide=false` (Headspace seek bar): foreground image stays fixed and is revealed from the track start to the thumb centre. `slide=true` (default; only 10 corpus sliders say it explicitly vs 1,446 `false`): foreground image is moved so its leading edge follows the thumb (exact offset UNCONFIRMED, U-10).
* Value-from-pointer: the oracle maps pointer x (minus half thumb) over `travel`, clamps to [0,1], rounds to an integer value.

Handlers: `onDragBegin` (left button down and drag starts), `onDragEnd` (left button released after drag), `onPositionChange` (position changed by **user** click/drag only). **Setting `value` from script does not fire `onPositionChange`; use `value_onchange`** (docs on both pages). Plus all ambient handlers.

Predefined sliders (pages `.../wmp/balanceslider`, `seekslider`, `volumeslider`):

| Tag | Defaults |
|---|---|
| BALANCESLIDER | `toolTip="Balance" max="100" min="-100" value="wmpprop:player.settings.balance" value_onchange="jscript:player.settings.balance=value;"` |
| SEEKSLIDER | `toolTip="Seek" min="0" max="wmpprop:player.currentMedia.duration" value="wmpprop:player.controls.currentPosition" foregroundProgress="wmpprop:player.network.downloadProgress" useForegroundProgress="true" onDragEnd="jscript:player.controls.currentPosition=value;"` |
| VOLUMESLIDER | `toolTip="Volume" min="0" max="100" value="wmpprop:player.settings.volume" value_onchange="jscript:player.settings.volume=value; player.settings.mute=false;"` |

Engine-relevant consequences: (1) `VOLUMESLIDER`/`BALANCESLIDER` write the player on every `value_onchange`, including changes that originated from the `wmpprop:` binding itself, so the runtime must break the feedback loop (set only when changed). (2) `SEEKSLIDER` applies the seek only on `onDragEnd`, while `value` keeps being driven by `wmpprop:player.controls.currentPosition` during drag unless the binding is suspended while dragging (UNCONFIRMED how WMP suspends it, U-19; an engine must).

Sources under `B`: `slider-backgroundcolor`, `-backgroundendcolor`, `-backgroundhoverimage`, `-backgroundimage`, `-bordersize`, `-cursor`, `-direction`, `-disabledcolor`, `-disabledimage`, `-foregroundcolor`, `-foregroundendcolor`, `-foregroundhoverimage`, `-foregroundimage`, `-foregroundprogress`, `-max`, `-min`, `-ondragbegin`, `-ondragend`, `-onpositionchange`, `-slide`, `-thumbdisabledimage`, `-thumbdownimage`, `-thumbhoverimage`, `-thumbimage`, `-tiled`, `-tooltip`, `-transparencycolor`, `-useforegroundprogress`, `-value`.

### 6.8 CUSTOMSLIDER
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/customslider-element>

A slider of arbitrary shape (knobs, dials, bars drawn as frame strips). The visible image is chosen among N **sub-images** by the slider value; the user's click/drag is mapped to a value by a grayscale **positionImage** map.

| Attribute | Type / default | Semantics |
|---|---|---|
| `image` | filename; **required** | A strip of N sub-images "arranged either horizontally or vertically". Each sub-image has exactly the **size of `positionImage`**. |
| `positionImage` | filename; **required** | Not displayed. Pixels that are pure gray (R=G=B) are clickable and encode a position; **any non-gray pixel is not clickable** (corpus maps use magenta `#FF00FF` for the dead area). |
| `hoverImage`, `downImage`, `disabledImage` | filenames; each defaults to `image` | Same strip layout as `image`. |
| `min` / `max` | float, 0 / 100 | Corpus: reversed ranges occur (Cablemusic `min="100" max="0"`), although the docs require max > min. |
| `value` | float, default = `min` | Out of range => warning, value unchanged. |
| `transparencyColor` | IE colour | Key colour of the strips. |
| `toolTip` | String <=1024 | |
| `cursor` | as BUTTON; **default `hand`** | |

Handlers: `onDragBegin`, `onDragEnd`, `onPositionChange` (user-driven only; script-set `value` does not fire it, use `value_onchange`). The corpus also puts `direction` (68), `borderSize` (291), `tiled` (56), `foregroundProgress` (22), `onMouseUp` (145) and `onKeyDown` (322) on CUSTOMSLIDERs; only the last two are meaningful (ambient handlers), the rest are ignored cargo.

**What the docs say vs what skins do (U-9).** Docs: the map has exactly N gray regions, "color values ... range evenly across the gray scale spectrum from black to white, first region pure black and last pure white", increment `255/(N-1)` rounded, region k <-> sub-image k. **Real maps do not follow that.** Measured on the corpus (strip size / map size = frames N; distinct gray levels in the map):

| Skin / control | image | map | frames N | distinct grays |
|---|---|---|---|---|
| Blinx `vol` | 715x40 | 55x40 | 13 (horizontal) | 30 |
| Age_of_Mythology `vol` | 918x41 | 51x41 | 18 (horizontal) | 30 |
| BlueCrush `seek` | 2108x148 | 68x148 | 31 (horizontal) | 30 |
| Back to the Future `seek` | 108x400 | 108x20 | 20 (vertical) | 30 |
| Cablemusic `volumeSlider` | 118x400 | 118x20 | 20 (vertical) | 21 |
| Ginger Man `vol` | 87x315 | 87x15 | 21 (vertical) | 30 |
| Combat Flight Sim 3 `main_seek` | 1725x75 | 75x75 | 23 (horizontal) | 254 |
| Creed `Progress` | 3200x5 | 128x5 | 25 (horizontal) | 135 |
| Crimson Skies `seek` | 3300x64 | 66x64 | 50 (horizontal) | 231 |
| Frostbite `volume` | 741x39 | 39x39 | 19 (horizontal) | 223 |
| Gold `vol_anim` | 3150x104 | 126x104 | 25 (horizontal) | 70 |

So: (1) the gray level of the clicked map pixel is a **continuous position**: `g in 0..255` <-> fraction `g/255` of `[min, max]` (0 = `min`, 255 = `max`; the tutorial text "the grayscale bitmap defines which values will be used when clicked" agrees); (2) the **frame is a function of the value**, evenly across the N sub-images (`frame = round(fraction*(N-1))` is the natural choice; rounding/flooring UNCONFIRMED, U-9); (3) the strip axis is whichever dimension of `image` exceeds `positionImage`'s (the other dimension is equal). A map often has the "0" end at the right or bottom (Blinx's gray 0 is at x=54, gray 255 at x=0.7), which is simply a reversed dial; do not assume left-to-right.
Source for the doc rules: `.../wmp/customslider-image`, `-positionimage`; tutorial `.../wmp/creating-custom-sliders`; the map statistics are mine.

Sources under `B`: `customslider-cursor`, `-disabledimage`, `-downimage`, `-hoverimage`, `-image`, `-max`, `-min`, `-ondragbegin`, `-ondragend`, `-onpositionchange`, `-positionimage`, `-tooltip`, `-transparencycolor`, `-value`.

### 6.9 PROGRESSBAR
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/progressbar-element>

"This element is identical to the SLIDER element": same attributes, methods, events. It exists only as a naming convenience for non-interactive sliders ("normally a slider that is not interactive, but there is nothing that prevents it from being used interactively"). Implement as an alias of SLIDER with no predefined defaults. Per the SLIDER rule, with no `thumbImage` it is non-interactive.

### 6.10 TEXT (and CURRENTPOSITIONTEXT, DURATIONTEXT, STATUSTEXT, TRACKNAMETEXT)
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/text-element>

A single-style text label (also the building block for text "buttons": it takes ambient click events, `cursor`, hover colours). `tabStop` default **false** for TEXT.

| Attribute | Type / default | Semantics |
|---|---|---|
| `value` | String | Displayed text. If `width` is unset the control is as wide as the string; if `height` unset, one line. Too long => **cropped with an ellipsis**, and (if `toolTip` unset) the full text shows as a tooltip. Normally bound: `value="wmpprop:player.status"`. May be a script (`value="JScript:'a\r\rb'"`) or contain `&#13;` for line breaks. |
| `fontFace` | String | Any installed font; unavailable => Windows system font (no font installation). |
| `fontSize` | long **points**, default 10 | |
| `fontStyle` | space-separated subset of `Bold Italic Underline Strikeout`, or `Normal` (default). `Normal` wins over all others. | |
| `foregroundColor` | IE colour, default `black` | |
| `backgroundColor` | IE colour or `none`, default `none` (transparent) | Fills the control's `width`x`height` (or the text extent if size unset). With `alphaBlend` and no `backgroundColor` a **black** background is used. |
| `justification` | `Left` (default) / `Right` / `Center` | Also where scrolling text first appears. |
| `hoverForegroundColor`, `hoverBackgroundColor`, `hoverFontStyle` | | Each falls back to the non-hover attribute when unspecified. |
| `disabledForegroundColor`, `disabledBackgroundColor`, `disabledFontStyle` | | Used when `enabled=false`; each falls back to the normal attribute. |
| `fontSmoothing` | Boolean, default false | OS anti-aliasing (WMP 10 = ClearType). Warns it blends the transparency colour into glyphs: do not use over transparency. |
| `wordWrap` | Boolean, default false | Wraps only between words; a word longer than the control is clipped on its own line. **Ignored if `width` is unspecified** (control resizes instead). Forced breaks: `&#13;` in XML, or `\r` in a `JScript:'...'` value. |
| `scrolling` | Boolean, default false | Marquee. Provides a **two-space buffer** between end of text and the repeated start. |
| `scrollingAmount` | positive int px, default **6** | Pixels per step. |
| `scrollingDelay` | int ms, min 30, default **85** (below 30 => default) | Time between steps. |
| `scrollingDirection` | `Left` (default; text moves right-to-left) / `Right` | |
| `textWidth` | int, read-only | Width in px of `value` using the current face/size/style. |
| `toolTip` | String <=1024, no default | If unset and text truncated or `wordWrap` true, tooltip = full text. `""` suppresses the tooltip. |
| `cursor` | as BUTTON (default `system`) | |

Handlers: all ambient (`onclick`, `onmouseover`, ...). The doc example gives TEXT `enabled="wmpenabled:player.controls.play"` with `disabledForegroundColor` to build text buttons.

Predefined TEXT elements (pages `.../wmp/currentpositiontext`, `durationtext`, `statustext`, `tracknametext`):

| Tag | Defaults |
|---|---|
| CURRENTPOSITIONTEXT | `value="wmpprop:player.controls.currentPositionString" tabstop="true" justification="right"` |
| DURATIONTEXT | `value="wmpprop:player.currentMedia.DurationString" tabstop="true" justification="right"` |
| STATUSTEXT | `value="wmpprop:player.status" tabstop="true"` |
| TRACKNAMETEXT | `value="wmpprop:player.currentMedia.name" tabstop="true"` |

Note `currentPositionString` formatting (`mm:ss`, hours when needed) and `player.status` strings are WMP-defined; see 7.2 for the strings the MPD adapter must synthesise.

Sources under `B`: `text-backgroundcolor`, `-cursor`, `-disabledbackgroundcolor`, `-disabledfontstyle`, `-disabledforegroundcolor`, `-fontface`, `-fontsize`, `-fontsmoothing`, `-fontstyle`, `-foregroundcolor`, `-hoverbackgroundcolor`, `-hoverfontstyle`, `-hoverforegroundcolor`, `-justification`, `-scrolling`, `-scrollingamount`, `-scrollingdelay`, `-scrollingdirection`, `-textwidth`, `-tooltip`, `-value`, `-wordwrap`.

### 6.11 EDITBOX
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/editbox-element>

Native text-entry control (**windowed**: no `alphaBlend`, `clippingImage` etc.). Requires WMP for Windows XP or later. Supports ambient attributes and **all ambient handlers except `onclick`**.

| Attribute | Type / default | Semantics |
|---|---|---|
| `value` | String, default "" | Text. |
| `editStyle` | `normal` (default) / `password` / `uppercase` / `lowercase` / `number` / `multiline` | `password` (asterisks) and `multiline` are **design-time only**, and a multiline box cannot change style at run time. `number` accepts digits only. |
| `readOnly` | Boolean, default false | |
| `textLimit` | long, default 0 = no limit | Max characters the user can type. |
| `wordWrap` | Boolean, default **true** | Only meaningful for `multiline`; off => truncated. |
| `border` | Boolean, default true; design-time only | 2px sunken system-colour border. |
| `backgroundColor` | IE colour or `none`; default = Windows window colour | |
| `foregroundColor` | IE colour; default = Windows text colour | |
| `fontFace` | String; default "Tahoma" (English systems) | Falls back to system font. |
| `fontSize` | long pt, default 10 | |
| `fontStyle` | as TEXT; reads back "" by default (rendered Normal) | |
| `justification` | `Left` (default) / `Right` / `Center` | 2px inner margin. |
| `lineCount` | long, read-only | Useful for multiline. |

Methods (all callable only after the control is visible): `getLine(index)` -> String ("" if invalid); `getLineFromChar(charIndex)` -> long (the doc text says "position is 1" meaning the page lost a minus sign: **-1 = current line**, U-22); `getLineIndex(lineIndex)` -> char index of first char of that line (-1 => line with caret); `getSelectionStart()`, `getSelectionEnd()` (caret position when nothing selected; char indices); `replaceSelection(text)`; `setSelection(start, end)` (0,-1 = select all; start -1 = deselect; the pages again lost their minus signs, U-22).

Sources under `B`: `editbox-backgroundcolor`, `-border`, `-editstyle`, `-fontface`, `-fontsize`, `-fontstyle`, `-foregroundcolor`, `-getline`, `-getlinefromchar`, `-getlineindex`, `-getselectionend`, `-getselectionstart`, `-justification`, `-linecount`, `-readonly`, `-replaceselection`, `-setselection`, `-textlimit`, `-value`, `-wordwrap`.

### 6.12 LISTBOX, ITEM and POPUP
Sources: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/listbox-element>, <.../wmp/item-element>, <.../wmp/popup-element>

LISTBOX is a windowed (native) list. **POPUP is "identical to LISTBOX except the default value of `popUp`"**: LISTBOX `popUp=false` (always shown); POPUP `popUp=true` (hidden until `show()`, width sized to its content, ambient `width` ignored, auto-hidden when an item is picked or `dismiss()` is called). WMP for Windows XP or later. `onclick` not applicable to LISTBOX/POPUP; `onfocus/onblur` N/A to POPUP; `alphaBlend` unsupported (windowed).

ITEM: child of LISTBOX/POPUP only; one attribute `value` (String, display text). Items can also be added at run time.

| Attribute | Type / default | Notes |
|---|---|---|
| `selectedItem` | long, R/W | Selecting one line unselects the others. |
| `focusItem` | long, R/W | Item with the dotted focus rectangle (Enter selects it); may differ from `selectedItem`. |
| `firstVisibleItem` | long, R/W | Scroll position. |
| `itemCount` | long, R | |
| `multiSelect` | Boolean, default false; design-time | |
| `sorted` | Boolean, default false; design-time | |
| `readOnly` | Boolean, default false; design-time | Text can be selected by user unless true. |
| `popUp` | Boolean; design-time | prefer the tag name instead. |
| `border` | Boolean, default true; design-time | |
| `backgroundColor`, `foregroundColor`, `fontFace`, `fontSize`, `fontStyle` | as EDITBOX | Windows defaults. |

Methods: `appendItem(text)`, `insertItem(index, text)`, `replaceItem(index, text)`, `deleteItem(index)` (later indexes shift), `deleteAll()`, `getItem(index)` -> String, `findItem(startIndex, searchString)` -> index (case-insensitive substring search starting *after* startIndex; start at the top with -1), `getNextSelectedItem(startIndex)` (-1 to start), `setSelectedState(index, bool)`, `show()`, `dismiss()`. (The pages print "1" where "-1" is meant; hyphen lost in the archive, U-22.)

Sources under `B`: `listbox-appenditem`, `-backgroundcolor`, `-border`, `-deleteall`, `-deleteitem`, `-dismiss`, `-finditem`, `-firstvisibleitem`, `-focusitem`, `-fontface`, `-fontsize`, `-fontstyle`, `-foregroundcolor`, `-getitem`, `-getnextselecteditem`, `-insertitem`, `-itemcount`, `-multiselect`, `-popup`, `-readonly`, `-replaceitem`, `-selecteditem`, `-setselectedstate`, `-show`, `-sorted`; `item-value`.

### 6.13 PLAYLIST (and COLUMN, DROPDOWNPLAYLIST, ITEMSPLAYLIST)
Sources: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/playlist-element>, <.../wmp/column-element>, <.../wmp/dropdownplaylist>, <.../wmp/itemsplaylist>

Native (windowed, owner-drawn by WMP) list of the current/selected playlist with optional drop-down selector, column headers and toolbar. Per the ambient pages it does **not** support `zIndex`, `clippingImage`, `clippingColor`, `passThrough`, `alphaBlend`, and no mouse/keyboard ambient events (`onclick`, `onmouse*`, `onkey*`). It always paints above windowless controls. For our engine this is the control that must be re-implemented as an MPD queue view; the skin controls its colours, geometry (ambient), columns and which sub-parts are visible.

Attributes (WMP 7 unless noted; colours are IE colour values):

| Attribute | Type / default | Notes |
|---|---|---|
| `playlist` | Playlist object, no default | If invalid/unset the control shows the currently playing item's playlist. |
| `columns` | `DB_NAME=Friendly;DB_NAME=Friendly;...` | Max 31 columns. DB_NAME among Album, Artist, Author, Bitrate, CDTrackEnabled, Copyright, CreationDate, DigitallySecure, Duration, Genre, MediaType, MetadataSource, Name, OriginalIndex, PlayCount, SourceURL, Status, TOC (plus reserved Checked, FileType, MediaAttribute, ModifiedBy, PlaylistAttribute, Rating, Style). Unknown-in-library => blank. Duplicate column: first left-aligned, later ones right-aligned. Corpus form: `columns="name=Name;Duration=Time"`. |
| `columnOrder` | `"0;1;2;3"` default | Semicolon-separated column indexes. |
| `columnCount` | long R | |
| `columnsVisible` | Boolean, default true | Column headers shown. |
| `playlistItemsVisible` | Boolean, default true | Items area (headers + rows + scrollbars). |
| `dropDownVisible` | Boolean, default true | Drop-down selector shown. |
| `dropDownList` | `showAll` (default) / `showAlbums` / `showCD` / `showClips` / `showCurrent` / `showLibrary` / `showRadio` / `showQueries` | What the drop-down lists. |
| `dropDownToolTip` | String, default "Display playlists, audio, video, or radio stations" | |
| `dropDownImage`, `dropDownBackgroundImage` | filename (9+) | Button at the right of the drop-down / its background. 8-bit BMP recolourable by `hueShift`, `saturation`. |
| `hueShift`, `saturation` | float 0..360 / 0..2 (9+) | For those two images. |
| `backgroundColor` | default Windows window colour | |
| `backgroundImage` | filename; tiled if smaller; the literal `gradient` (WMP 10) draws a gradient from `backgroundColor` (top) to `statusColor` | |
| `foregroundColor` | default Windows text colour | |
| `itemPlayingColor` | default `#00FF00` | Highlight for the playing item. |
| `itemPlayingBackgroundColor` | default `#222222` | |
| `itemErrorColor` | default `red` (9+) | |
| `disabledItemColor` | default `graytext` | Disabled CD track / offline content. |
| `itemSelectedColor`, `itemSelectedBackgroundColor`, `itemSelectedFocusLostColor`, `itemSelectedBackgroundFocusLostColor` | WMP 10; defaults = Windows highlight text / highlight / button text / button face | (the focus-lost background page's summary text mislabels it "text colour"). |
| `statusColor` | default = `backgroundColor` (9+) | Status line background. |
| `statusTextColor` | default `none` (WMP 10) | |
| `leftStatus`, `rightStatus` | String with `%keyword%` tokens (9+) | Tokens: `count`, `size`, `duration`, `SelectedCount/Size/Duration`, `CheckedCount/Size/Duration`, `DurationString`, `CheckedDurationString`, or any `getItemInfo` key. `"Total Time: %duration%"` => `Total Time: 07:00`. |
| `checkboxesVisible` | Boolean, default false | Far-left check column. |
| `editButtonVisible` | Boolean, default false (9+) | Lower-left edit menu button. |
| `toolbarVisible` | Boolean, default false (WMP 10) | |
| `allowColumnSorting` | Boolean, default true | |
| `allowItemEditing` | Boolean, default true | In-place edit. |
| `itemCount` | long R (9+) | Count of **expanded** rows. |
| `itemMedia(i)`, `itemPlaylist(i)` | Media / Playlist R (9+) | Of the expanded row. |
| `copying` | Boolean R | CD rip in progress. |

Methods: `abortCopy()`, `copy()` (checked CD items), `addSelectedToPlaylist(playlist)`, `deleteSelected()`, `deleteSelectedFromLibrary()`, `moveSelectedUp()`, `moveSelectedDown()`, `getNextSelectedItem(i)` / `getNextCheckedItem(i)` (returns -1, rendered "1" on the page (U-22), when none; `...2` variants support nested playlists), `setSelectedState(i, bool)` / `setCheckedState(i, bool)` (i=-1 means all; `...2` variants), `setColumnResizeMode(col, mode)`, `setColumnWidth(col, px)` (also sets mode Fixed), `sortColumn(col)` (toggles asc/desc; needs `allowColumnSorting`).

**COLUMN** (WMP 9+; child of PLAYLIST only): `columnName` (header text), `columnID` (a `Media.getItemInfo` name; extra accepted ids `name`, `duration`, `sourceURL`, `status`, `size`, `extension`), `columnResizeMode` (`AutosizeHeader` default, `AutosizeData`, `Fixed`, `Stretches`), `columnWidth` (px; only honoured when mode is `Fixed`).

Predefined: **DROPDOWNPLAYLIST** = `playlistItemsVisible="false"` (just the drop-down). **ITEMSPLAYLIST** = `backgroundColor="black" columns="name=Name;Duration=Time" columnsVisible="false" dropDownVisible="false" foregroundColor="white"`.

Sources under `B`: `playlist-<attr>` for every attribute above (allowcolumnsorting ... toolbarvisible), `playlist-<method>` (abortcopy ... sortcolumn), `column-columnid`, `-columnname`, `-columnresizemode`, `-columnwidth`.

### 6.14 EFFECTS (visualizations) and WMPEFFECTS
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/effects-element>, <.../wmp/wmpeffects>

Hosts WMP visualizations (plug-in DLLs). **`windowed` default false = windowless**: the control can be clipped/covered and non-rectangular. `windowed=true` (design-time only): real child window, "any image covering the visualization window is ignored, and the visualization window has the highest-level z-order", and `zIndex/alphaBlend/clipping/passThrough/mouse events` stop working (section 5). For our engine EFFECTS is a *placeholder surface* (we have no WMP visualizations), but skins bind to its attributes (`currentEffectType`, `currentPreset`, `currentPresetTitle`...), so it must exist as an object.

| Attribute / method | Type / default | Notes |
|---|---|---|
| `windowed` | Boolean, default false; design-time | see above |
| `allowAll` | Boolean, default true | true: cycle all registered visualizations; false: only those authored in nested EFFECTS tags. |
| `currentEffect` | object | default = first authored, else first registered. Exposes the visualization's own IDispatch properties (`MyEffects.currentEffect.backgroundColor="blue"`). |
| `currentEffectType` | String R/W | registry name (unique id); set to switch effect. Corpus binds `currentEffectType="wmpprop:mediacenter.effectType"`. |
| `currentEffectTitle` | String R | display title. |
| `currentPreset` | long R/W, 0-based, default 0 | Corpus: `currentPreset="wmpprop:mediacenter.effectPreset"`. |
| `currentPresetTitle` | String R | |
| `currentEffectPresetCount` | long R | |
| `effectCount` | long R (WMP XP+) | |
| `effectTitle(i)`, `effectType(i)` | String (WMP 9+) | by registry index. |
| `effectCanGoFullScreen` | Boolean R (XP+) | |
| `effectHasPropertyPage` | Boolean R | |
| `fullScreen` | Boolean R/W run-time only | only while playing/paused; video needs a video plug-in, audio needs a full-screen-capable visualization. |
| `next()` | | next preset, rolling to next visualization; wraps last->first. |
| `previous()` | | previous preset; wraps first->last. |
| `nextEffect()`, `previousEffect()` | | skip presets; authoring order; wrap only if `allowAll=false`. |
| `nextPreset()`, `previousPreset()` | | within current visualization; wrap. |
| `settings()` | | opens the visualization's property page. |

WMPEFFECTS defaults: `horizontalAlignment="stretch" verticalAlignment="stretch" height="200" width="250" tabStop="false" onclick="next();"` (note the bare `next()`: **a bare method name in a handler resolves on the firing element itself**, section 2.4). The initial preset follows the player's View > Visualizations menu.
Corpus also shows an undocumented nested `<bars .../>` (3 uses) under EFFECTS: attributes `levelColor, peakColor, backgroundColor, displayMode, transparent, fadeMode, fadeRate, levelWidth, levelFallbackSpeed, showPeaks, peakHangTime, horizontalSpacing, levelScale` = settings for the built-in Bars visualization. UNCONFIRMED semantics (U-14).

Sources under `B`: `effects-allowall`, `-currenteffect`, `-currenteffectpresetcount`, `-currenteffecttitle`, `-currenteffecttype`, `-currentpreset`, `-currentpresettitle`, `-effectcangofullscreen`, `-effectcount`, `-effecthaspropertypage`, `-effecttitle`, `-effecttype`, `-fullscreen`, `-next`, `-nexteffect`, `-nextpreset`, `-previous`, `-previouseffect`, `-previouspreset`, `-settings`, `-windowed`.

### 6.15 VIDEO and WMPVIDEO
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/video-element>, <.../wmp/wmpvideo>

Video surface. **`windowless` default FALSE = windowed**: fastest, always rectangular and on top (images over it ignored, `zIndex`/`passThrough`/clipping/`alphaBlend`/mouse+key events do not work). `windowless=true` (design-time): clippable/overlappable. If a skin has no VIDEO element and content has video, WMP "will return to full mode and your skin will not be displayed" (skin-definition-file-structure page).

| Attribute | Type / default | Notes |
|---|---|---|
| `windowless` | Boolean, default false; design-time | |
| `backgroundColor` | IE colour or `none`; default `none` (transparent when no video) | Fills letterbox bars when video smaller and `stretchToFit=false`. |
| `stretchToFit` | Boolean, default false | Ignored if width/height not specified. |
| `shrinkToFit` | Boolean, default true | Ignored if no width/height. |
| `maintainAspectRatio` | Boolean, default true | |
| `zoom` | long 1..max-fit, default 100 | Not with `fullScreen`. With explicit size can scale up to fit; without, limited to <=100. If `shrinkToFit` false the proportion changes to fill; true keeps proportion. |
| `fullScreen` | Boolean R/W, run-time, after file loaded; Esc returns | |
| `cursor` | as BUTTON; reads back "" by default | |
| `toolTip` | String <=1024 | |

Handlers: `onvideostart` (video loaded and rendering), `onvideoend` (stops rendering and unloaded) plus ambient ones where applicable. **WMPVIDEO** defaults: `backgroundColor="black" horizontalAlignment="stretch" verticalAlignment="stretch"` (also follows the player's View > Video Size menu). Headspace uses the pattern: `OnVideoStart="StartVideo();" OnVideoEnd="EndVideo();"` to swap visualization/video panes; the shared script uses `player.currentMedia.ImageSourceWidth>0` to detect video.

Sources under `B`: `video-backgroundcolor`, `-cursor`, `-fullscreen`, `-maintainaspectratio`, `-onvideoend`, `-onvideostart`, `-shrinktofit`, `-stretchtofit`, `-tooltip`, `-windowless`, `-zoom`.

### 6.16 EQUALIZERSETTINGS
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/equalizersettings-element>

Non-visual object (give it an `id`, e.g. `<equalizerSettings id="eq" enableSplineTension="true"/>`) that proxies the player's EQ; the skin builds the UI from sliders bound with `value="wmpprop:eq.gainLevel1"` and `value_onchange="eq.gainLevel1=value;"`. Supports `attribute_onchange`. (Corpus: some skins also put geometry attrs `left/top/width/height` and `backgroundImage` on it, 17 uses; ignored/undocumented.)

| Attribute | Type / default | Notes |
|---|---|---|
| `gainLevel1`..`gainLevel10` | float, "normally -20 to +20" dB (docs print "20 to +20", minus lost), default 0 | Band centres: 1=31 Hz ... 10=16 kHz (ISO octaves 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k). "If not specified, previous value is retained" at design time. |
| `gainLevels(band)` | float; band 1..10 | Parameterised; **cannot be set in the tag nor used with `wmpprop:`** (use the numbered ones). |
| `bands` | long R | number of bands (10). |
| `bypass` | Boolean, default true | EQ filter bypassed in the graph. |
| `currentPreset` | long R/W | |
| `currentPresetTitle` | String R | |
| `presetCount` | long R | |
| `enableSplineTension` | Boolean, default true (9+) | Smooth interpolation between neighbouring bands when dragging. |
| `splineTension` | float 0.0..10.0, default 3.0 (9+) | |
| `crossFade` | Boolean, default false (9+) | |
| `crossFadeWindow` | long ms 0..10000, default 250 (9+) | |
| `normalization` | Boolean, default false (9+) | |
| `normalizationAverage`, `normalizationPeak` | float R (9+) | |
| `enhancedAudio` | Boolean, default false (9+) | Gates the SRS items below. |
| `speakerSize` | 0 headphones / 1 normal / 2 large (9+) | ignored if `enhancedAudio=false`. |
| `currentSpeakerName` | `Headphones` / `Normal Speakers` / `Large Speakers` R (9+) | |
| `truBassLevel`, `wowLevel` | long 0..100, default 50 (9+) | ignored if `enhancedAudio=false`. |
| methods `nextPreset()`, `previousPreset()` (wrap), `presetTitle(i)` (9+), `reset()` (all gains to 0 dB) | | |

For an MPD engine: MPD has no graphic EQ; the engine must either implement it (e.g. an `equalizer` outputs chain) or hold the values locally and report "unavailable".

Sources under `B`: `equalizersettings-bands`, `-bypass`, `-crossfade`, `-crossfadewindow`, `-currentpreset`, `-currentpresettitle`, `-currentspeakername`, `-enablesplinetension`, `-enhancedaudio`, `-gainlevels`, `-gainlevel1`..`-gainlevel10`, `-nextpreset`, `-normalization`, `-normalizationaverage`, `-normalizationpeak`, `-presetcount`, `-presettitle`, `-previouspreset`, `-reset`, `-speakersize`, `-splinetension`, `-trubasslevel`, `-wowlevel`.

### 6.17 VIDEOSETTINGS
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/videosettings-element>

Non-visual proxy for video colour controls (WMP for Windows XP or later). Attributes `brightness`, `contrast`, `hue`, `saturation`: each long -127..+127, default 0; method `reset()`. Supports only `attribute_onchange`. Typical corpus use: `<videosettings id="vidset"/>` and sliders with `value="wmpprop:vidset.contrast"` (131 bindings each).
Sources under `B`: `videosettings-brightness`, `-contrast`, `-hue`, `-saturation`, `-reset`.

### 6.18 AUTOMENU
Source: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/automenu-element>

WMP 9+. Shows the full-mode "Quick Access Panel". Only ambient `left`/`top` apply (position at which it appears); `visible` default false. Method `show("Play")` (argument always "Play"). Not implementable on MPD except as a stub or as an MPD playlist/artist/album/genre popup. Source for method: `.../wmp/automenu-show`.

### 6.19 PLAYER, SETTINGS, CONTROLS (design-time player initialisation) and the sub-object tags
Sources: <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/player-element>, <.../wmp/settings-element>, <.../wmp/controls-element>, <.../wmp/playerapplication-element>

`<PLAYER>` configures and listens to the player object (script name `player`, no `id`). It may contain `<SETTINGS>` and `<CONTROLS>` (and, in the wild, `<NETWORK>`, `<CURRENTMEDIA>`, `<CURRENTPLAYLIST>`, `<EQUALIZERSETTINGS>`; see below).

* Design-time attribute: `URL` (media to open at load).
* **Event handler attributes on PLAYER** (documented as "events fired from the Player object"; each event's parameters are visible in the handler **by exact name including capitalisation**, the one place WMP is case-sensitive): `AudioLanguageChange`, `Buffering(Start)`, `CdromMediaChange(CdromNum)`, `CurrentItemChange()`, `CurrentMediaItemAvailable(bstrItemName)`, `CurrentPlaylistChange(change)`, `CurrentPlaylistItemAvailable`, `DomainChange`, `Error()`, `MarkerHit(MarkerNum)`, `MediaChange(Item)`, `MediaCollection*`, `MediaError`, `ModeChange(ModeName, NewValue)` (ModeName `shuffle`/`loop`), `OpenPlaylistSwitch`, `OpenStateChange(NewState)`, `PlaylistChange(Playlist, change)` (change 0 Unknown, 1 Clear, 2 InfoChange, 3 Move, 4 Delete, 5 Insert, 6 Append, 7 Not supported), `PlaylistCollection*`, `PlayStateChange(NewState)`, `PositionChange(oldPosition, newPosition)` (fires only on explicit seeks, not during normal playback), `ScriptCommand(scType, Param)`, `StatusChange()`.
  Observed spellings in the corpus (all work): bare `modechange="..."`, `openstatechange=`, `playstatechange=`, `mediachange=`, `cdrommediachange=`, `scriptcommand=`, `playlistchange=`, `currentmediaitemavailable=`, `currentplaylistchange=`, an undocumented `disconnect=`, and the `onplaystatechange=` form (1 skin). Corpus census: **`OpenState_onchange` (472), `PlayState_onchange` (455), `Status_onchange` (111), `CurrentPlaylist_onchange` (82), `URL_onchange` (10)** are the dominant forms: the `<attr>_onchange` convention applies to the player's properties too.
* `<SETTINGS>` design-time attrs: `autoStart`, `balance`, `baseURL`, `defaultFrame`, `enableErrorDialogs`, `invokeURLs`, `mute`, `playCount`, `rate`, `volume` (set initial values). Corpus: no `<settings>` tag occurs (0 uses); skins set these from script.
* `<CONTROLS>` design-time attrs: `currentAudioLanguage`, `currentAudioLanguageIndex`, `currentItem`, `currentMarker`, `currentPosition`, `currentPositionTimecode`. In practice only `currentPosition_onchange` is used (176 of 176 `<controls>`): the standard position-tick listener, e.g. `<player><controls currentPosition_onchange="OnPos();"/></player>`.
* `<PLAYERAPPLICATION>` (remoted control only) attrs `hasDisplay`, `playerDocked`; global `playerApplication.switchToPlayerApplication()`. Irrelevant for us.
* Undocumented element `<mediacenter>` (global `mediacenter`, 2 tags, about 3,200 script references; section 4.3): player-wide persistent UI state shared with WMP full mode: `videoZoom`, `videoStretchToFit`, `videoShrinkToFit`, `effectType`, `effectPreset`, `showTitles`, `showEffects`, `contrastMode`; supports `videoZoom_onchange`. UNCONFIRMED (U-14; no Microsoft page found).

Sources under `B` for PLAYER events: `player-player-<event>` (e.g. `player-player-playstatechange`, `-openstatechange`, `-modechange`, `-playlistchange`, `-scriptcommand`, `-positionchange`); `player-url`.

## 7. Runtime object surface used by skins

Skins script the standard WMP control object model (`player`), so an engine must supply these objects. The list below is limited to members that the corpus actually references (top counts; full docs: `B`player-object, `B`controls-object, `B`settings-object, `B`media-object, `B`network-object, `B`playlist-object). Counts are raw occurrences in all 339 `.wms` plus `.js` files (duplicate skin variants such as `_MP7`/`_MPXP` and `microsoft__*` copies are counted each time, so they overstate the number of distinct skins; the census file counts differently and is lower).

### 7.1 Members by frequency
| Object | Members seen (count) |
|---|---|
| `player.settings` | `volume` 1,734; `mute` 602; `getMode` 477; `balance` 388; `setMode` 307; `rate` 8; `mode` 8; `autoStart`, `playCount`, `bass`, `treble`, `hue/saturation/contrast/brightness` (4 each). `getMode/setMode` names: `loop`, `shuffle` (WMP 7+), `autoRewind`, `showFrame` (WMP 9+; `settings-getmode`, `-setmode`). volume 0..100, balance -100..100 (the docs print "100 to 100", minus lost, U-22), mute Boolean. |
| `player.controls` | `currentPosition` 1,374 (seconds, double; settable seek); `pause` 471; `play` 464; `stop` 378; `isAvailable(name)` 342; `currentPositionString` 270; `next` 221; `previous` 219; `fastForward` 22; `fastReverse` 22; also `seek` (4), `shuffle`, `repeat`, `eject` (2 each; not in the WMP object model: UNCONFIRMED, U-32). |
| `player.currentMedia` | `imageSourceWidth` 1,001 (>0 means video); `getItemInfo(key)` 603; `duration` 494; `name` 402; `imageSourceHeight` 243; `durationString` 82; `sourceURL` 32; `setItemInfo` 8; `attributeCount`, `getAttributeName` (4). `getItemInfo` keys seen: `Author` 301, `Bitrate` 34, `Artist` 28, `Album` 25, `Title` 20, `Copyright` 14, `Type` 12, `WM/AlbumTitle`, `BannerInfoURL`, `UserRating`, `UserEffectiveRating`, `FileSize`, `PlayCount`, `WM/TrackNumber`. |
| `player.currentPlaylist` | `count` 115; `name` 65; `getItemInfo` 20; `setItemInfo` 18; `item`, `isIdentical`. |
| `player.network` | `downloadProgress` 113 (0..100; binds to SLIDER `foregroundProgress`); `bufferingProgress` 30; `bandwidth` 16; `bitRate` 14; `sourceProtocol`, `receptionQuality`, `maxBitRate`. |
| `player` | `launchURL(url)` 1,014; `playState` 725; `openState` 683; `URL` 294 (set to open media); `status` 258 (string); `fullScreen` 39; `versionInfo` 16; also `playlistCollection`, `mediaCollection`, `cdromCollection`, `newPlaylist`. |
| `theme` | `savePreference` 3,052; `loadPreference` 2,668; `openView` 897; `closeView` 313; `currentViewID` 316; `openDialog` 282; `playSound` 95; `logString` 36; `loadString(resUrl)` 32 (undocumented; returns the resource string of a `res://.../RT_STRING/#n` URL, e.g. `scrollingDirection="jscript:theme.loadString('res://wmploc/RT_STRING/#1910');"` = a localised "Left"/"Right"; `#2066` a bit-rate format string); `openViewRelative` 16. |
| `view` | see 4.1. |

### 7.2 Strings the player produces
* `player.controls.currentPositionString`, `player.currentMedia.durationString`: `HH:MM:SS` with the `HH:` part **omitted when the item is shorter than one hour** (`B`controls-currentpositionstring, `B`media-durationstring); so `3:07` is `03:07`, one hour is `01:00:00`.
* `player.status`: free text ("subject to change at any time, should be used for display purposes only", `B`player-status); `StatusChange` fires on change. WMP's English strings (Playing, Stopped, Paused, Buffering, Connecting to..., Ready) are not documented in the SDK (UNCONFIRMED, U-32); the engine must invent equivalents.
* `res://[wmploc|wmploc.dll|-]/RT_STRING/#n` localized strings: 47 distinct ids are referenced by the corpus (220 references, 6 unique skins); the real English text of all of them is tabulated in `docs/research/wmploc-library.md` section 5.3 (read from WMP 10/11 `wmploc.dll`). The ones decorating the standard controls: 1807 "Mute", 1808 "Sound" (the unmute state), 1809 "Seek", 1810 "Volume", 1811 "Minimize", 1812 "Close", 1813 "Switch to full mode", 1814/1815 "Turn shuffle on/off", 1816/1817 "Turn repeat on/off", 1845 "Balance", 1848 "Graphic Equalizer", 217 "Playlist", 1273 "Quick Access Panel", 1888 `fontFace` "Arial" (locale-dependent: always return a usable face), 1910 "left" (a `scrollingDirection` value, via `theme.loadString`), 1998/1999 Microsoft author/copyright strings, 2108/2114 accessibility shortcut strings, 2066 "%sKbps" (format), 3904..3909 WMP 11 additions. The predefined elements' own English tooltips (6.4) are the Microsoft SDK text for the same commands (e.g. RETURNBUTTON "Return to Full Mode" vs resource 1813 "Switch to full mode").
* `theme.loadString(url)` resolves such a URL at run time (32 corpus calls).

### 7.3 Preferences (`theme.savePreference` / `theme.loadPreference`)
Docs (`B`theme-savepreference, `B`theme-loadpreference): String key to String value in the **registry**, kept between player runs, unencrypted. Corpus use: every value is a **string** and tests compare strings (`"true"==theme.loadPreference("plViewer")` 67+62+39+... times; `theme.savePreference('plViewer', "true")` 110). Typical content: which drawers/views are open, window sizes, EQ values, `htcpID`. What a never-saved key returns is not documented and the corpus only ever compares against `"true"`/`"false"`/`"--"` or feeds it to `parseInt`/`Number` (U-16); return `""`. Scope (per skin or global) is not documented; a per-skin namespace is safest. Preferences are the only cross-VIEW channel (2.1.7).

## 8. Package, encoding and parser requirements

### 8.1 Package (`B`skin-files, `B`skin-definition-file, `B`art-files)
A skin is "a group of files": one **skin definition file** (`.wms`, XML), **art files** and optional **JScript files** (`.js`). The distributable is a `.wmz`, a ZIP of those files; WMP also accepts them unpacked in a folder (cursor files "must be in the same directory as the .wms file or in the .wmz file"). Corpus (342 `.wmz`, all open as valid ZIPs):

| Fact | Corpus |
|---|---|
| Layout | flat: only 1 of 342 zips has subdirectories; all references are bare file names. All 342 open with a ZIP central-directory reader; three (`bruteforce`, `QuantumRedshiftWMPSkin`, `SplinterCellWMPSkin`, plus `theskinsfactory__` twins) fail Info-ZIP `unzip` with a bad local-header offset yet are salvageable (`wmploc-library.md` section 1) |
| Entry types | png 11,998, gif 7,642, bmp 7,293, jpg 1,357, js 385, wms 343, wav 46, cur 42, ani 4; stray `.psd`(11) `.txt` `.bak` `.lnk` `.html` `.exe` |
| Several `.wms` in one zip | 4 zips (`Nautical`: `Nautical.wms`+`sample.wms`; `Sports`: `ExtremeSports.wms`+`saltmine.wms`, each twice). The docs say only one is allowed; which one WMP loads is unknown (U-17): prefer the `.wms` whose references resolve against the zip, then the one named like the zip |
| Art formats (docs) | BMP (recommended), GIF (animated allowed for `image`), JPG, PNG. "If you use one of the compressed file formats that defines a color as transparent ... do not define a color as transparent in the image file": the documented transparency mechanisms are `transparencyColor`/`clippingColor`. Yet skins ship real PNG alpha (in the first 140 zips, 966 of 5,121 PNGs, 44 skins, have non-opaque pixels). Whether WMP honours it is unconfirmed (U-27); an engine should composite PNG/GIF alpha *and* apply the key colours |
| Image size limits | `width` attribute is a 16-bit int 0..32767; no image-size limit documented |
| Sound | `theme.playSound` plays WAV only |
| Cursors | `.cur`/`.ani`, name only (path ignored); corpus also uses unknown names like `sizetopright` (24x) which fall back to the previous cursor (U-21) |

### 8.2 Text encoding
No XML declaration exists in any of the 341 `.wms` files. Corpus byte-level census (raw files): **Windows-1252 (non-ASCII, no BOM): 160**, **UTF-16 LE with BOM: 117**, pure 7-bit ASCII: 45, UTF-8 with BOM: 19; **no file is UTF-8-without-BOM with non-ASCII bytes** (`docs/research/corpus-survey.md` section 2.1 gets 72/10/27/86 distinct and the same conclusion). Decode as: BOM -> UTF-16/UTF-8; else Windows-1252 (ASCII is a subset) (the `(C)` sign, `(c)`, and `'` show up as single bytes). `.js` files follow the same rule (Headspace's `headspace.js` is cp1252, its `.wms` is UTF-16LE). Strings from the shared script and `res://` come from the OS locale.

### 8.3 The `.wms` is not well-formed XML: required leniency
142 of 341 files (42%) fail a strict XML parse (Python ElementTree on the decoded text; `docs/research/corpus-survey.md` section 2.2 finds the same 41% with expat: 79 of 195 distinct skins, four mechanical classes, 67 distinct files with duplicate attributes and 22 with missing whitespace). Breakdown of the 141 failures in the 339-file extraction, plus what WMP evidently tolerates:

| Defect | Files | Example | Engine rule |
|---|---|---|---|
| **Duplicate attribute** | 103 (856 occurrences, mostly `toolTip`/`tooltip` 372, `borderSize` 95, `transparencyColor` 80, `max` 69, `min` 53, `visible` 25, `zIndex` 24) | `Creed`: `<subview zIndex="8" zIndex="30"`; `Age_of_Mythology`: `toolTip="Equaliser Adjustment" ... tooltip="31hz"` (a case-variant duplicate) | Keep attributes in order; which duplicate wins is unknown (U-5). My parser keeps the last. |
| **Missing whitespace between attributes** | 27 | `justification="left"value="wmpprop:..."`, `zIndex="99"backgroundimage="Clip.png"` | Tokenise attributes with a regex, not an XML parser |
| **Close-tag case mismatch** | 10 | `<buttongroup>` ... `</buttonGroup>` | Case-fold tag names when matching |
| Other | 1 | | |
| Case-variant names | pervasive | `scriptFile`, `ScriptFile`, `resizAble`, `onLoad`/`onload` | Case-fold element and attribute names |
| Unknown / misspelled attributes | pervasive | `horizontalAlignemnt` 26, `horizontalAlignmnet` 12, `tranparencycolor` 14, `transpaerncycolor` 2, `z-index` 16, `hegiht` 2, `visilble` 2, `uptooptop` 4, `timerInteval` | Ignore silently |
| Unclosed/orphan elements | a stray root-level `<prevelement>` | | Tolerate |
| No text content | none seen | | Element text is not used |

Entities: `&#13;` in TEXT `value`; standard XML entities decode normally. Attribute values may span lines (`onclick="jscript:\n player.URL = ..."` doc example).

### 8.4 Minimal parser contract (for Phase 1)
1. Decode (8.2). 2. Tokenise tags and `name=value` pairs with quoted values (double or single quotes), lower-casing tag/attribute names. 3. Build a tree with a stack; on a close tag pop to the nearest case-insensitive match. 4. Treat self-closing (`/>`) and open/close pairs identically. 5. Keep document order of elements (the `jscript:` pass of 2.1.4 runs in that order) and of attributes. 6. Do not validate attribute names. 7. Resolve filenames case-insensitively inside the zip (corpus art is referenced with differing case, e.g. `grayMap.GIF`, `L_drwr_open_01_default.bmp`).

## 9. Cross-check against the corpus and the hand port

Method: `unzip` of `*.wms`/`*.js` from all 342 `.wmz` into `/tmp` (art only for the specific measurements quoted), a lenient tag/attribute scanner (8.4) over 339 `.wms` (38,377 elements), and the census in `docs/research/corpus-census.txt`. Counts here are my own re-parse and can differ by a few from the census.

### 9.1 What the corpus actually uses
Element census (census file; tags / skins): subview 12,846/328, button 5,889/302, buttonelement 4,495/296, text 3,715/319, slider 3,667/308, buttongroup 1,467/298, view 971/337, player 601/297, customslider 565/148, video 452/310, theme 341/337, effects 340/311, playlist 320/298, equalizersettings 316/300, stopelement 254/218, nextelement 249/217, playelement 247/217, prevelement 246/213, pausebutton 213/176, controls 181/131, videosettings 158/158, pauseelement 142/123, playbutton 111/97, prevbutton 111/97, nextbutton 108/93, stopbutton 104/88, volumeslider 62/48, progressbar 39/32, currentpositiontext 38/36, balanceslider 32/32, seekslider 32/28, returnbutton 32/26, wmpvideo 32/32, itemsplaylist 24/24, mutebutton 18/16, statustext 17/17, ffwd/rewelement 14/12 each, wmpeffects 12/12, automenu 8/8, popup 6/6, listbox 6/4, editbox 5/5, durationtext 5/5, **not in the docs**: network 6, visualization 4, bars 3, mediacenter 2, currentmedia 2, currentplaylist 1. Never used: COLUMN, ITEM, SETTINGS, `category`; barely used: EDITBOX (5 tags), LISTBOX (6), POPUP (6), AUTOMENU (8).
Priority for the engine by skin count: SUBVIEW, BUTTON, BUTTONELEMENT+BUTTONGROUP, TEXT, SLIDER, PLAYER, VIDEO, EFFECTS, PLAYLIST, EQUALIZERSETTINGS, CUSTOMSLIDER (148 skins), then the predefined buttons/elements.

Most-bound `wmpprop:` targets (lower-cased): `player.currentmedia.duration` 368, `player.settings.volume` 364, `eq.gainlevel1..10` ~2,400 together, `player.controls.currentpositionstring` 244, `player.controls.currentposition` 224, `eq.enhancedaudio` 163, `eq.currentpresettitle` 162, `player.currentmedia.name` 133, `vidset.contrast/brightness/hue/saturation` 131 each, `player.settings.balance` 122, `mediacenter.effecttype/effectpreset` 119 each, `player.network.downloadprogress` 107, `player.settings.mute` 82, `player.currentmedia.durationstring` 39, `player.status` 22, `player.network.bufferingprogress` 14.
Layout expressions: `ID.width` 820, `ID.height` 735, `ID.top` 757, `view.width-N` pattern for `left` (`-121` 168, `-109` 165, `-174` 82 ...), `view.height-N` for `top`; `jscript:` values are 11,924 of all attribute values.

### 9.2 Documented vs observed (deltas an engine must accept)
| Topic | Docs | Corpus |
|---|---|---|
| SUBVIEW in SUBVIEW | forbidden | 254/339 skins, depth to 4 |
| THEME `id` | not supported | 205 THEMEs set it |
| THEME `title` | listed | 152 |
| VIEW `onKeyPress` etc. | ambient only | VIEW key handlers 518 |
| `stickyBorderWidth` | absent | 12 (one skin) |
| BUTTONELEMENT attributes | only `enabled`, `tabStop` ambient | also `onMouseOver` 227, `onMouseDown` 58, `onMouseOut` 18, `visible` 4, `accName` 36, `transparencyColor` 36 |
| SUBVIEW `passThrough`, `clippingImage`, `enabled` | unsupported | 554, 37, 104 |
| CUSTOMSLIDER | image, positionImage, ... | + `direction` 68, `borderSize` 291, `tiled` 56 |
| PLAYLIST | documented attrs | + undocumented `movebuttonsvisible` 152, `editbuttonsvisible` 151, `toolbarmargin` 44, `fonttype` 5, `font` 4 (pre-9 spellings: ignore) |
| `enabled` | `enabled` | misspelt `enable` on VIDEOSETTINGS 77, EQUALIZERSETTINGS 186, SUBVIEW 12 (ignored by WMP; harmless there) |
| JScript prefix | `JScript:` in examples | optional for handlers (2.3) |
| `wmpenabled:` | on `enabled` | also `visible`, `tabStop`, `down` |
| PLAYER events | documented as events (`PlayStateChange(NewState)`) | `<Prop>_onchange` dominates (OpenState 472, PlayState 455); bare event names are second |
| `res://` | absent | 433 `scriptFile` references (133 unique skins), ~220 `RT_STRING`, 32 `RT_IMAGE` |

### 9.3 Mapping and keys
`mappingColor`: `#RRGGBB` in 5,649 of 5,655 uses (4 empty, 2 stray `#`), never a colour name. `mappingImage` extensions: png 605, bmp 590, gif 247, jpg 17. `transparencyColor` values: `#ff00ff` 8,895, `#ffffff` 398, `#00ff00` 309, `#ff0000` 269, `#333333` 206, `#99ff00` 98, `#0000ff` 94, `white` 77. Boolean spellings for `visible`: `false` 2,928, `true` 1,361, `1` 6, `ture` 2, `0` 1.

### 9.4 Preferences and misc
`theme.loadPreference` call shapes: `"false"==theme.loadPreference("vidSnapper")` 212, `var x = theme.loadPreference("videoWidth")` 81, `"true"==theme.loadPreference("plViewer")` 67+62+39..., `loadPreference(id)` 35+33, `loadPreference('currView')!="--"` 4: values are strings; used to persist which windows are open and their sizes. `savePreference` is called with string literals (`"true"`/`"false"`).

### 9.5 Hand port (`src/widgets.js`, `src/main.js`) vs the rules in this document
| Rule here | Hand-port behaviour | Verdict |
|---|---|---|
| BUTTONGROUP ownership = exact RGB match of `mappingColor` on `mappingImage` | `colorToIdx` of `parseInt(hex)`; `owner[p]` from exact `(r<<16)\|(g<<8)\|b` (`widgets.js` 114-124) | match |
| State images are same-size layers sampled by owner | `layers[o<0?0:st[o]]` with states up/hover/down/disabled | match for owned pixels |
| Unowned pixels not painted (`showBackground=false`) | paints `layers[0]` for unowned pixels | **differs** (U-23: ~811 px in the transport group) |
| `transparencyColor`/`clippingColor` keys | `tools/convert_skin.py` bakes `#FF00FF` for every image plus per-file clipping keys (`head` red, `vid_bkgd` white) into alpha | equivalent for Headspace: every bitmap that contains magenta is declared `transparencyColor="#FF00FF"` on its tag (L/R drawer buttons; their *close*/disabled variants are not referenced in the `.wms` but are assigned from script to the same buttons, which keep the key; `pause_*`, `thumb_*`, `viz_drop_L_*`, `left/right_ear`, `left_drawer_right`, `right_drawer_left`, `head`) or `clippingColor="#FF00FF"` (`viz_drop`); no referenced bitmap lacking the declaration contains magenta |
| `clippingColor` pixels are non-clickable; `transparencyColor` pixels are clickable | `headArt` has `pointer-events:none` so the face window clicks fall to the screen layer; click-through (`clickthrough.rs`) follows opaque pixels | match |
| z: child with negative z paints under the parent's background; children not interleaved with parent siblings (reading A, U-2) | `screen`, `visDrop` appended before `headArt` inside `head` | match (assumes A) |
| SLIDER `slide=false`: foreground revealed to the thumb centre; `direction=vertical`: max at top | seek: clip width `f*travel + thumbW/2`; vertical `top=(1-f)*travel` | match |
| Seek geometry `borderSize=9`, thumb 18, track 163 | `trackLen=163 thumbW=18 travel=trackLen-thumbW=145` | match (docs and oracle agree) |
| Volume/balance/EQ geometry with `borderSize=7`, thumbs 9/11 | travel = `length - thumbW` (62 / 65) | **differs** from the docs' `length - 2*borderSize` (57 / 62), U-10 |
| `balance` snaps to 0 inside +-6 | `Math.abs(v)<6 ? 0 : v` (not a WMP rule; app behaviour) | n/a |
| SUBVIEW `moveTo(x, y, 120)` drawers; `onEndMove` hides after open/close | CSS transitions, `transitionend` | equivalent (linear vs eased unknown, U-25) |
| `video`/`effects` windowed: never covered | video sits in the face hole; `canvas` for visualization | equivalent |
| VIEW `width` changes (760 open / 549 closed) while `resizable="false"` | not modelled by the oracle (fixed layout) | note: engine must support script-driven `view.width` |
| `tabStop="wmpenabled:player.controls.play"`, `visible="wmpenabled:player.controls.pause"` | play/pause swap by state | match behaviourally |

### 9.6 Phase-1 minimum feature set (Headspace, 1 THEME, 1 VIEW, 23 SUBVIEW)
Tags: theme, view, subview(23), buttongroup(2), buttonelement(3), prevelement/playelement/stopelement/nextelement, pausebutton, button(10), slider(13), text(7), playlist(1), effects(1), video(1), equalizersettings(1).
Attributes: `author copyright` (theme); `backgroundColor width height titleBar resizable scriptFile onLoad onClose` (view); `left top width height zIndex id visible backgroundImage backgroundColor clippingColor transparencyColor onEndMove` (subview); `left top zIndex mappingImage image hoverImage downImage disabledImage` (buttongroup); `mappingColor onClick upToolTip id tabStop` (elements); `image hoverImage downImage disabledImage transparencyColor upToolTip onClick left top zIndex id visible` (button); `backgroundImage foregroundImage thumbImage thumbHoverImage thumbDownImage tiled slide borderSize min max value value_onchange onDragEnd useForegroundProgress foregroundProgress direction toolTip height width` (slider); `value left top width zIndex fontSize fontStyle foregroundColor justification cursor enabled visible toolTip onClick` (text); `columns columnsVisible dropDownVisible playlistItemsVisible backgroundColor foregroundColor` (playlist); `currentEffectType currentPreset` (effects); `OnVideoStart OnVideoEnd` (video); `enableSplineTension` (equalizersettings).
Value languages used: literals; `jscript:` for `left`/`top` of 13 sliders/texts (`balance.left+balance.width+10`, `eq1.left+15`); `wmpprop:` for `value` (14: `player.controls.currentposition`, `player.settings.balance|volume`, `eq.gainLevel1..10`, `visEffects.currentPresetTitle`), `max`, `foregroundProgress`, `currentEffectType`, `currentPreset`; `wmpenabled:` for `visible` and `tabStop`. Script: `headspace.js` (+ shared `res://wmploc/RT_TEXT/#132` for `osMediaOpen`), using `moveto`, `view.width=`, `pl.setColumnResizeMode(0,"Stretches")`, `visEffects.currentEffectType = mediacenter.effectType`, `player.currentMedia.ImageSourceWidth`, `player.OpenState == osMediaOpen`, chained assignments, `eq.reset()`, `view.minimize()/close()/returnToMediaCenter()`.

## 10. UNCONFIRMED register

Everything here lacks a primary source. "Default" is the recommended engine behaviour until a real WMP (or the owner's screenshots of Headspace) settles it. Inline `UNCONFIRMED` marks elsewhere point to these ids.

| Id | Question | Evidence so far | Default |
|---|---|---|---|
| U-1 | Paint order of equal-z siblings | Docs silent; tab order = tag order | later tag on top |
| U-2 | Is a child's z relative (stacking context) or additive to its parent's? | Docs sentence ambiguous; `headspace-parity.md` rule 4 shows only the stacking-context reading reproduces Headspace (three readings tested); hand port does that. Unverified against a real WMP render | stacking context, behind a switch |
| U-3 | When are `jscript:` values evaluated; are later elements visible? | Corpus: always paired with alignment (once); 4,525 backward refs vs 8 others, of which 9SeriesDefault's `svMain.width` reading `svStub.width` (declared 816 lines later) is a genuine forward read of a literal; QuickSilver reads a descendant's still-unevaluated `jscript:` width | two phases: literals first, then `jscript:` in document order; an unevaluated `jscript:` attribute reads as its default (0) |
| U-4 | Exact `wmpenabled:`/`wmpdisabled:` grammar and allowed attributes | Docs: methods of Controls on `enabled`; corpus: also `visible`, `tabStop`, `down`; with/without `()`/`;`; once in a handler | last segment, case-insensitive, any boolean attribute |
| U-5 | Duplicate attributes: first or last wins; case-variant duplicates | 856 occurrences in 103 files; no doc | last wins (mirrors repeated assignment); log |
| U-6 | Handler prefix `jscript:`/`javascript:`/`wmpprop:` | Optional/ignored in practice; label hypothesis | strip a leading `identifier:` from handler text |
| U-7 | Which ambient attributes apply to SUBVIEW beyond the docs (`passThrough`, `clippingImage`, `enabled`, `onclick`) | used 554/37/104/14 times | honour them |
| U-8 | Which VIEW is main | Corpus fits "first in document order"; `category` unused | first VIEW; `currentViewID` overrides |
| U-9 | CUSTOMSLIDER: gray->value mapping, frame rounding, axis | 11 maps measured: grays != frames; continuous 0..255 | value = min+(g/255)(max-min); frame = round(fraction*(N-1)); axis = larger image dimension |
| U-10 | SLIDER: thumb travel (`borderSize` vs half-thumb), `slide=true` offset, `foregroundHoverImage` fallback, `tiled` default | docs vs hand port disagree for borderSize 7 sliders | follow the oracle (half-thumb) until a screenshot says otherwise; tiled default = as written (explicit only) |
| U-11 | Window drag by background | 0 skins implement drag; hand port adds it | built in, except on controls |
| U-12 | Window shape of a VIEW with no background (union of children) | Headspace works this way in the oracle | union of painted non-clipped child pixels |
| U-13 | `alphaBlend` with `transparencyColor` (docs: unsupported) | 1,469 SUBVIEW alphaBlends exist | keep keys keyed, blend the rest |
| U-14 | Undocumented tags/objects: `mediacenter`, `<bars>`, `<visualization>`, PLAYER children `network/currentmedia/currentplaylist` | corpus usage only (4.3, 6.14, 6.19) | `mediacenter`: persistent object with change events; others: accept attributes, no behaviour |
| U-15 | `res://` resources | **Largely resolved** by `wmploc-library.md`: #132 = 33 constants, 47 RT_STRING texts read from the DLL. Open: `RT_IMAGE`/`RT_BITMAP` ids (9SeriesDefault, 32 + 26 refs), `OpeningUnknownURL` (21) | provide constants and the string table (7.2); empty images |
| U-16 | `loadPreference` for a missing key; scope | undocumented | return `""`; namespace per skin |
| U-17 | Several `.wms` in a `.wmz` | 4 zips | the one whose files resolve, else zip-name match |
| U-18 | Event order and propagation (`mousedown/up/click/dblclick`, hover/out, bubbling to SUBVIEW handlers) | docs silent; SUBVIEW `onclick` 14 uses | no bubbling; click needs down+up on same element; topmost hit-tested element only |
| U-19 | `currentPosition` tick rate; seek-slider drag suspension; binding feedback | `PositionChange` only on seeks; SEEKSLIDER applies on `onDragEnd` | ~4 Hz while playing; suspend binding while dragging; guard re-entrancy |
| U-20 | String<->Boolean/number coercion, invalid values | `mute='false'`, `visible="1"`, `"ture"`; docs "previous value kept" for invalid | parse true/false/1/0 case-insensitively; otherwise keep previous |
| U-21 | Unknown cursor names (`sizetopright` 24x), `.cur`/`.ani` hotspots | docs: unknown => previous | map to nearest CSS cursor; `.cur` via image-set where possible |
| U-22 | Minus signs lost in the docs ("-1", "-20..+20", "-100..100") | pages print "1", "20 to +20", "100 to 100" | treat as -1, -20..+20, -100..100 |
| U-23 | BUTTONGROUP unowned pixels vs `showBackground` default | docs: not painted; oracle paints them; 811 px differ in Headspace's transport group | implement docs, switchable |
| U-24 | Version stamps of predefined elements | "new for 9" list vs per-page "7.0" | accept all |
| U-25 | `onendmove` for slideTo/moveSizeTo, easing, frame rate | docs only name `moveTo` | fire for all three; cubic ease for slide |
| U-26 | `event.clientX/Y` vs `x/y` with a title bar | docs only | equal |
| U-27 | PNG/GIF alpha honoured? | 966 PNGs with real alpha in the first 140 zips; docs advise against | composite alpha and keys |
| U-28 | Case-sensitivity of skin-declared JScript variables/functions | `wmploc-library.md` 4.3 classifies host members as case-insensitive and script-defined names as case-sensitive (43 case-variant calls of defined functions are errors in WMP too); not verified against WMP itself | ordinary case-sensitive JScript |
| U-29 | `#RGB` 3-digit colours | never used in corpus; IE accepts | accept |
| U-30 | VIEW `stickyBorderWidth` | 12 uses in one skin, value 4, no doc | ignore |
| U-31 | Precedence when a firing element's attribute and a script global share a name (2.4) | no collision observed | element attribute first |
| U-32 | Player members/strings outside the documented object model: `controls.seek/shuffle/repeat/eject`, `player.status` texts | seen in 2-4 skins / undocumented text | stub (no-op) members; synthesise `status` strings |
| U-33 | Script load vs element creation order for top-level statements | 0 of 385 corpus `.js` touch element ids at top level, so unobservable | load scripts first, run `onload` after both |

## 11. Source index

All Microsoft pages are fetched from `B` = `https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/` on 2026-10-06 (page footers say last updated 2023-04-26). Full URL = `B` + slug.

| Area | Slugs |
|---|---|
| Overview | `windows-media-player-skins`, `about-skins`, `skin-files`, `skin-definition-file`, `skin-definition-file-structure`, `art-files`, `primary-images`, `mapping-images`, `alternate-images`, `art-file-formats`, `jscript-files`, `new-for-windows-media-player-skins`, `using-skins-with-the-windows-media-player-control` |
| Code and events | `writing-code`, `handling-events`, `external-events`, `internal-events`, `writing-event-code`, `secondary-events`, `using-jscript`, `working-with-the-player`, `event-handlers`, `calling-functions` |
| Tutorials | `adding-a-slider`, `creating-custom-sliders`, `adding-a-playlist`, `adding-video`, `adding-visualizations`, `choosing-files` |
| Reference index | `skin-programming-reference`, `miscellaneous`, `global-attributes`, `listening-attributes`, `color-reference` |
| Ambient | `ambient-attributes`, `ambientattributes-<accdescription accname acckeyboardshortcut alphablend alphablendto bottom clippingcolor clippingimage elementtype enabled height horizontalalignment id left movesizeto moveto ninegridmargins passthrough resizeimages right slideto tabstop top verticalalignment visible width zindex>`, `ambient-event-handlers`, `attribute-onchange`, `on<blur click dblclick endalphablend endmove focus keydown keypress keyup mousedown mousemove mouseout mouseover mouseup resize>`, `ambient-event-attributes`, `event-<altkey button clientx clienty ctrlkey fromelement keycode offsetx offsety screenheight screenwidth screenx screeny shiftkey srcelement toelement x y>` |
| THEME / VIEW / SUBVIEW | `theme-element`, `theme-<author authorversion closeview copyright currentviewid loadpreference logstring opendialog openview openviewrelative playsound savepreference showerrordialog title version>`; `view-element`, `view-<backgroundcolor backgroundimage backgroundimagehueshift backgroundimagesaturation backgroundtiled category close focusobjectid maxheight maximize maxwidth minheight minimize minwidth onclose onerror onload ontimer resizable resizebackgroundimage restore returntomediacenter scriptfile size timerinterval title titlebar transparencycolor>`; `subview-element` |
| Buttons | `button-element`, `button-<cursor disabledimage down downimage downtooltip hoverdownimage hoverimage image sticky tiled transparencycolor uptooltip>`, `closebutton ffwdbutton imagebutton minimizebutton mutebutton nextbutton pausebutton playbutton prevbutton repeatbutton returnbutton rewbutton shufflebutton stopbutton`; `buttongroup-element`, `buttongroup-<buttoncount click cursor disabledimage downimage getbutton hoverdownimage hoverimage hueshift image mappingimage radio saturation showbackground transparencycolor>`; `buttonelement-element`, `buttonelement-<click cursor down downtooltip index mappingcolor sticky uptooltip>`, `ffwdelement nextelement pauseelement playerelement prevelement rewelement stopelement` |
| Sliders | `slider-element`, `slider-<backgroundcolor backgroundendcolor backgroundhoverimage backgroundimage bordersize cursor direction disabledcolor disabledimage foregroundcolor foregroundendcolor foregroundhoverimage foregroundimage foregroundprogress max min ondragbegin ondragend onpositionchange slide thumbdisabledimage thumbdownimage thumbhoverimage thumbimage tiled tooltip transparencycolor useforegroundprogress value>`, `balanceslider seekslider volumeslider`; `customslider-element`, `customslider-<cursor disabledimage downimage hoverimage image max min ondragbegin ondragend onpositionchange positionimage tooltip transparencycolor value>`; `progressbar-element` |
| Text and input | `text-element`, `text-<...22 attrs>`, `currentpositiontext durationtext statustext tracknametext`; `editbox-element`, `editbox-<...>`; `listbox-element`, `listbox-<...>`, `item-element`, `item-value`, `popup-element` |
| Playlist | `playlist-element`, `playlist-<...>`, `column-element`, `column-<columnid columnname columnresizemode columnwidth>`, `dropdownplaylist`, `itemsplaylist` |
| Media | `effects-element`, `effects-<...>`, `wmpeffects`; `video-element`, `video-<...>`, `wmpvideo`; `equalizersettings-element`, `equalizersettings-<...>`; `videosettings-element`, `videosettings-<...>`; `automenu-element`, `automenu-show` |
| Player objects | `player-element`, `settings-element`, `controls-element`, `playerapplication-element`, `player-player-<playstatechange openstatechange positionchange modechange playlistchange scriptcommand buffering mediachange currentitemchange currentmediaitemavailable currentplaylistchange cdrommediachange markerhit statuschange error ...>`, `player-url`, `player-playstate`, `player-openstate`, `player-status`, `controls-isavailable`, `controls-currentposition`, `controls-currentpositionstring`, `media-durationstring`, `media-name`, `media-imagesourcewidth`, `settings-volume`, `settings-mute`, `settings-balance`, `settings-getmode`, `settings-setmode`, `network-downloadprogress` |

Local evidence (not published): lenient scanner and measurement scripts under `/tmp/wmpscripts/` (`lenient.py`, `q*.py`, `cs.py`), converted corpus under `/tmp/wmp_utf8/`, Headspace under `/tmp/wms_headspace/`; none is part of the repository. Hand port files: `src/widgets.js`, `src/main.js`, `tools/convert_skin.py`. Corpus census: `docs/research/corpus-census.txt`. A third-party description of the same format that could be used for a second opinion was not consulted (the task asked for primary sources); the `mediacenter` object has no Microsoft page that a web search could find.

