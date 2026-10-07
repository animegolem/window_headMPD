# wmploc.dll: the WMP built-in script library and string resources

Research note for the generic skin engine (branch `skin-engine`). Written 2026-10-06.
Question: what is `res://wmploc.dll/RT_TEXT/#132`, which other `res://` resources do skins use, and what must the engine shim?

Tags used below: **[verified]** = read from the actual bytes or from a cited source. **[inference]** = my reasoning; checkable but not directly confirmed.

Citation form for corpus sites: `skins/wmp/<archive>.wmz!<inner file>:<line>`, where the line number is in the decoded (UTF-16LE or UTF-8) text of the inner file. The owner's skin is cited as `~/Downloads/Headspace.wmz!<file>:<line>`.

---

## 0. Findings in brief

1. **`RT_TEXT #132` contains no functions.** [verified] It is a 3038-byte UTF-16LE script holding 33 `var` constants plus one array: the 21 open-state constants `osUndefined`..`osMediaWaiting` (0..20), the 12 play-state constants `psUndefined`..`psReconnecting` (0..11), and `WMPPlaylistChangeEventTypes`, an array of 10 name strings. It is byte-identical in the English `wmploc.dll` of WMP 10 and WMP 11 (same sha256, section 1). The hypothesis that it defines helpers such as `JumpToFlyout` is wrong: no function with that name, or any `*Flyout*` function, exists in any RT_TEXT resource of either DLL. Flyout logic lives in the DLL's named `FLYOUT.JS` (`vwPlayer_*` functions), which belongs to WMP's own built-in skins.
2. **Every use of #132 in the corpus is a read of one of those constants.** [verified] No skin in the corpus calls a function that #132 supplies, because #132 supplies none. `osMediaOpen` alone is read by 106 of the 195 unique skins. The library is always the *last* entry of the `scriptFile` list (437 of 437 `res://` entries).
3. **The only library function a skin ever uses comes from a different resource, `RT_TEXT #169`.** [verified] It is `sprintf` plus `String.prototype.sprintf`, included by the Microsoft skin `Revert` (2 unique skins, 4 archives). Two more small scripts exist (#134 font sizes, #136 visualizer-request constants); no corpus skin includes them.
4. **The "undefined function" census is not a library gap.** [verified] Of 404 bare calls to names a skin does not define, 53 are element-scope methods (`previous()`, `next()`, `moveTo()`, `alphaBlendTo()`), 43 are case-variants of a function the skin does define, and 308 are template leftovers or typos that throw in real WMP too. None is supplied by wmploc. Section 4.
5. **This changes the interpreter requirements, not the shim.** Handler code runs with the element as implicit scope (`down`, `width`, `previous()` resolve against the element), and an unresolved name must abort only that handler. Section 4.3.
6. **String resources are a separate, small problem.** 47 distinct `RT_STRING` ids are referenced, 220 times, by 6 unique skins (Microsoft's `Revert`, `Revert (1)`, `Compact`, `circle`, `9SeriesDefault`, plus the third-party `The Movies`). I read the real English text for all 47 from the DLLs (section 5). `res://-/` is an alias for wmploc (inference, strong evidence).
7. **No public documentation exists.** MSDN, the WMP 9 SDK help (1215 `.htm` topics, grepped locally) and skin-author pages never mention `wmploc`, `RT_TEXT` or `theme.loadString`. The two open-source WMP-skin engines I found (NullPlayer, webamp-modern) both define the constants from the MSDN enumerations (webamp cites the MSDN page in a comment; NullPlayer's table has the same values) and treat `RT_TEXT #132` as unresolvable. The ground truth here comes from extracting the DLLs.

---

## 1. Provenance and method

| Step | What | Where it lives |
|---|---|---|
| Corpus unpack | 342 archives in `skins/wmp/` (339 `.wmz`, 3 `.WMZ`) unzipped to `/tmp/wmpcorp/<name>/` | `/tmp` only |
| Corrupt archives | `bruteforce`, `QuantumRedshiftWMPSkin`, `SplinterCellWMPSkin` (plus their `theskinsfactory__` twins) fail `unzip` (`bruteforce`: `bad zipfile offset (local header sig)`). `unzip` still salvages entries: `bruteforce` and `QuantumRedshift` yielded their `.wms` and `.js`; `SplinterCell` yielded only `sc.js` (no `.wms`). | `/tmp` only |
| Dedupe | Hash of whitespace-stripped `.wms` + `.js` text. **195 unique-content skins out of 342 archives** (145 duplicate groups, mostly `vendor__name` copies). Counts below lead with unique-content skins, raw archives in parentheses. | analysis only |
| Call-site scan | Python scanner: decode each file (UTF-16LE/BOM, UTF-8/BOM, plain), strip comments and string literals, extract bare `ident(` calls from `.js` files and from event/`jscript:` attribute values in `.wms` (`on*`, `*_onchange`, any value starting `jscript:`, entities decoded), subtract identifiers defined by the skin (`function`, `x = function`), and subtract JS built-ins. A second pass finds free (non-call) identifiers the skin never defines, element ids excluded. | `/tmp/wmpwork/` (not committed) |
| Ground truth | Downloaded the English WMP 10 and WMP 11 installers from archive.org, extracted `wmploc.dll` with 7-Zip, parsed the PE resource directory with `pefile`, dumped RT_TEXT and RT_STRING. | `/tmp` only. **No Microsoft binary or script text was copied into the repo.** |

Binaries analysed (all under `/tmp`, none redistributed):

| Artifact | Source | sha256 |
|---|---|---|
| `wmp10-windowsxp-x86-enu.exe` | https://archive.org/details/wmp10x86 | `c1e71784c530035916aad5b09fa002abfbb7569b75208dd79351f29c6d197e03` |
| `wmploc.DLL` from it (3,371,008 B, 2005-01-28) | extracted | `888f3f3095a41de6d4e37a9d40143b0811eb1dd1adcf4cfb3b54fa5f443b2d08` |
| `wmp11-windowsxp-x86-en-us.exe` | https://archive.org/details/wmp11eng_swe | `ffd321a441a67001a893f3bde4bb1afba07d4d2c9659bfdb0fbb057e7945d970` |
| inner `wmp11.exe` | extracted | `e88708845c9c110629a79b65530d54647caa8b1d80c0ff89242e6bfe9dc7d4ed` |
| `wmploc.dll` from it (8,231,936 B, 2009-01-30) | extracted | `4160a613417304aa808849bc4dec99d5b1e42900a0a014f0634fdc5514c584f5` |
| RT_TEXT #132 resource blob (identical in both DLLs) | extracted | `30a639feafbed6d22b9065909e6c05908b8fc0b5c70e7ba40c2e3a136e061485` |
| RT_TEXT #169 resource blob (WMP 11) | extracted | `3e0c4a8a2c620bdc9702d28088c897d6fe8bf9089fd10c9128db2fee049cd945` |
| `wmploc_str.txt` (WMP 9 Series Swedish string table dump) | https://archive.org/details/wmploc_str | `e481d427a03e72e1749725fbaf05fd094609012757b5fdba15ad687b220ef148` |

Reproduction commands are in Appendix A.

---

## 2. What RT_TEXT #132 is

### 2.1 How `RT_TEXT` maps onto the PE file [verified / inference]

A `res://wmploc.dll/RT_TEXT/#132` URL names resource type `RT_TEXT`, id 132. `RT_TEXT` is not a standard Win32 resource type. In both DLLs it is the **custom numeric type 256**, which holds two kinds of entries:

- named entries, `ADVANCEDAUDIO.JS`, `MAINAPPSKIN2.WSZ`, `FLYOUT.JS` and so on (63 resources in the WMP 10 DLL, 68 in WMP 11): WMP's own built-in skins and their scripts;
- numeric entries: ids 132, 134, 136, 142, 169, 4003, 4011, 4013 in WMP 10; 132, 134, 136, 142, 143, 169, 2540, 4003, 4004, 4013 in WMP 11.

Type 257 holds images (`RT_IMAGE`: GIF and PNG), type 2 is `RT_BITMAP` (DIBs), type 6 is `RT_STRING`. The `RT_TEXT` = 256 identification is **[inference]**: it rests on id 132 of type 256 containing exactly the constants script that skins evidently need (section 3). The mapping for `RT_STRING` = 6 and `RT_BITMAP` = 2 is the standard Win32 numbering.

Corroboration: a 2008 Japanese Windows XP `wmploc.dll` resource-directory dump (https://github.com/katahiromz/wonders-dump, file `winxp-objdump/WINDOWS/system32/wmploc.dll.txt`) lists type `0x100`, id `0x84` (132) with size 0x5ee = 1518 bytes. The English UTF-16 blob is 3038 bytes, which is 1518 characters plus a BOM, so the Japanese DLL carries the same-length text in an 8-bit encoding **[inference]**. Also: https://github.com/tdebaets/wmp-wsz-format notes that `wmploc.dll` holds internal skins such as `MAINAPPSKIN2.WSZ`, matching the named type-256 entries. Note for the later Winamp phase: WMP's own `.WSZ` is a different, binary container (the extracted blobs do not start with a `PK` header), not a Winamp 2 `.wsz`.

### 2.2 Contents of #132 [verified]

Encoding: UTF-16LE with BOM, CRLF lines, 3038 bytes. A header comment says the values must match `wmpcore.h` (MSDN: the same numbers as `WMPOpenState` / `WMPPlayState`). Then 33 `var NAME = N;` lines and one array. **There is no `function` keyword anywhere in the file.**

Open states (value is the position; MSDN names the C enum `wmpos<Name>`):

| value | suffix after `os` | value | suffix after `os` |
|---|---|---|---|
| 0 | Undefined | 11 | MediaLoading |
| 1 | PlaylistChanging | 12 | MediaOpening |
| 2 | PlaylistLocating | 13 | **MediaOpen** |
| 3 | PlaylistConnecting | 14 | BeginCodecAcquisition |
| 4 | PlaylistLoading | 15 | EndCodecAcquisition |
| 5 | PlaylistOpening | 16 | BeginLicenseAcquisition |
| 6 | PlaylistOpenNoMedia | 17 | EndLicenseAcquisition |
| 7 | PlaylistChanged | 18 | BeginIndividualization |
| 8 | MediaChanging | 19 | EndIndividualization |
| 9 | MediaLocating | 20 | MediaWaiting |
| 10 | MediaConnecting | | |

Play states (`ps<Name>`, MSDN `wmpps<Name>`): 0 Undefined, 1 Stopped, 2 Paused, 3 Playing, 4 ScanForward, 5 ScanReverse, 6 Buffering, 7 Waiting, 8 MediaEnded, 9 Transitioning, 10 Ready, 11 Reconnecting.

`WMPPlaylistChangeEventTypes` is an array of the ten strings `Unknown, Clear, InfoChange, Move, Delete, Insert, Append, Private, NameChange, Morph` (indexable by the event-type argument of a playlist-change event). No corpus skin references it.

Cross-checks:

- All 33 values match the MSDN tables for `player.openState` (https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/player-openstate) and `player.playState` (https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/player-playstate). MSDN says the C constant is "the state value prefixed with `wmpos`/`wmpps`"; the skin-script names drop the `wmp` prefix. MSDN lists a 22nd open state, **`OpeningUnknownURL = 21`, which is not in #132** (the table stops at 20). webamp-modern and NullPlayer both add it.
- The skin `Cablemusic` defines its own `ps*` constants with identical values (`skins/wmp/Cablemusic.wmz!cablemusic.js:416-426`), independent confirmation.
- #132 is byte-identical in WMP 10 (2005) and WMP 11 (2009). `Headspace` (2001, WMP 7 era) already includes `res://wmploc/RT_TEXT/#132` (`~/Downloads/Headspace.wmz!headspace.wms:12`). **[inference]** the id has meant "the constants" since WMP 7; the MSDN pages above say these properties exist from "Windows Media Player version 7.0 or later".

### 2.3 The other RT_TEXT scripts a skin could include

| id | what it is (WMP 11 English DLL) | in corpus? | engine action |
|---|---|---|---|
| 132 | the constants above | 243 archives / 133 unique skins | **shim (required)** |
| 169 | `sprintf(str, s)`, `String.prototype.sprintf = sprintf`, `WMPStringsFunction_GetPositionText()`, and `g_kPositionFormatString` loaded from RT_STRING #2091 (`"%1 / %2"`) | `Revert`, `Revert (1)` only | **shim (small)** |
| 134 | three font-size globals, `parseInt(theme.loadString(RT_STRING #1889/#1892))`; the font-face and style lines are commented out | none | shim cheaply (values 8 and 9) or skip |
| 136 | five visualizer-request constants `VR_PRESET_PREV`=1, `VR_PRESET_NEXT`=2, `VR_VIZ_PREV`=3, `VR_VIZ_NEXT`=4, `VR_EXIT_PLAYER`=999 | none | shim cheaply or skip |
| 142, 143, 2540, 4003, 4004, 4011, 4013 (and named `*.JS`) | scripts of WMP's built-in skins: default-skin metadata and status code (`MetaDataObject`, `ShowStatus`, `MakeImage`), UPnP remote control, OCX layouts, full-screen bar | none | **do not shim**: they drive elements of the built-in skins. Warn and skip. |

The `res://-/RT_TEXT/#169` entry shows RT_TEXT ids are also reached through the `-` module alias (section 5.1).

---

## 3. Corpus census of the library

### 3.1 How skins include it

`scriptFile` is a semicolon-delimited list (MSDN `VIEW.scriptFile`: https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/view-scriptfile). Observed forms **[verified]**:

| `scriptFile` entry | references | archives | unique skins |
|---|---|---|---|
| `res://wmploc.dll/RT_TEXT/#132` | 417 | 233 | 125 |
| `res://wmploc/RT_TEXT/#132` (no `.dll`; this is what `Headspace` uses) | 16 | 10 | 8 |
| `res://-/RT_TEXT/#169` | 4 | 4 | 2 |
| **#132, either spelling** | **433** | **243** | **133** |

(`docs/research/corpus-census.txt` counts 416 + 15 = 431 `#132` references; my recount over all 342 archives, salvaged ones included, gives 417 + 16 = 433. I did not chase the difference of 2.)

Shape of the attribute (884 `scriptFile` attributes in total):

- The `res://` entry is the **last** entry in 437 of 437 cases, e.g. `scriptFile="roundlet.js;res://wmploc.dll/RT_TEXT/#132;"` (`skins/wmp/Roundlet.wmz!roundlet.wms:12`).
- 391 of 433 `#132` values end in a trailing `;`, which MSDN says "should not be present". The engine must tolerate empty entries.
- Entries per attribute: 1 entry 445, 2 entries 431, 3 entries 6, 5 entries 2. Skins with no `scriptFile` attribute at all: 23.
- 17 `.wms` files rely on MSDN's rule that a `.js` with the same base name as the `.wms` loads automatically (for example `skins/wmp/Kids.wmz!kids.wms` with `kids.js`). 285 list their same-named `.js` explicitly.
- One archive lists a script it does not ship (`Nautical`: `patton.js` is absent). A missing script must not fail the load.
- Headspace itself: `scriptFile="headspace.js;res://wmploc/RT_TEXT/#132"` (`~/Downloads/Headspace.wmz!headspace.wms:12`). Its only use of the library is `player.OpenState == osMediaOpen` at `~/Downloads/Headspace.wmz!headspace.js:28`.

### 3.2 Which constants skins actually read [verified]

Unique-content skins that read the name without defining it (raw archives in parentheses). Names not listed have zero uses: `osBeginCodecAcquisition`, `osEndCodecAcquisition`, `osOpeningUnknownURL`, `psMediaEnded` (only `Cablemusic`, which defines its own).

| constant | skins (raw) | uses (raw) |
|---|---|---|
| `osMediaOpen` | **106 (196)** | 344 |
| `psPlaying` | 41 (75) | 100 |
| `psStopped` | 33 (59) | 64 |
| `psPaused` | 29 (53) | 64 |
| `psUndefined` | 11 (21) | 23 |
| `osUndefined` | 8 (16) | 18 |
| `osPlaylistLoading` | 5 (10) | 10 |
| `psReady` | 4 (8) | 8 |
| `osPlaylistOpenNoMedia` | 3 (5) | 9 |
| the other 20 `os*` and `ps*` names that appear (15 `os*`, 5 `ps*`; these are the exhaustive state switches of the Microsoft reference skins) | 2 each (4 each) | 4-8 |
| `psReconnecting` | 1 (2) | 2 |

Totals: 111 unique skins (206 archives) read at least one library constant; 24 unique skins (40 archives) include #132 and never use it. Representative sites: `skins/wmp/Roundlet.wmz!roundlet.js:21` (`player.PlayState==psPlaying || ... psPaused`), `skins/wmp/Asimov_Radio.wmz!MBay.js:236` (the "idle" group `psUndefined || psReady || psStopped` tested together).

Skins that use the constants **without** including the library: `Kids` (`skins/wmp/Kids.wmz!kids.js:11`, `player.OpenState == osMediaOpen`) and `UPRISING` (`skins/wmp/howarduniversity__UPRISING.wmz!uprising.js:11`). In real WMP these would throw a ReferenceError at the first use, since #132 is never loaded; they are skin bugs. Case-variants of the constant names do not occur (the only hit is a comment, `skins/wmp/Jaws.wmz!jaws.js:52`).

Host-object member names are case-insensitive in practice and constants are not: the corpus spells `player.OpenState` (308 uses), `player.openState` (376), `player.openstate` (2), and likewise `PlayState`/`playState`/`playstate`/`Playstate`, while library constants always appear in the canonical case. **[inference]** WMP's host objects resolve member names case-insensitively (IDispatch) while skin-script identifiers stay case-sensitive JScript.

---

## 4. Task item 1: bare calls that the skin does not define

### 4.1 Result

Across all 342 archives, **81 distinct names** are called bare (no `.` receiver, not `new X`) without being defined in the skin's scripts and without being a JS built-in. They account for **404 uses in 155 archives**. Every constructor call (`new MetaDataObject`, `new CStation`, `new checkbox`, `new listbox`, ...) resolves to a skin-defined function or a JS built-in, so there is no constructor gap.

Splitting skins by whether they include #132 shows the same shape, which is what you would expect if the library is not involved: 66 distinct unresolved names in the 243 archives that include it, 22 in the 99 that do not.

Classification of the 404 uses (computed per use: first the element-scope set, then a case-insensitive match against the skin's own function names, else "absent"):

| bucket | uses | what it is | engine consequence |
|---|---|---|---|
| A. element-scope methods | 53 | `previous()`, `next()` (on `<effects>`), `moveTo()` (on `<text>`), `alphaBlendTo()` (on `<view>`) | handler code needs the element as implicit scope (4.3) |
| B1. case-variants | 43 | `onCloseVideo` vs the skin's `OnCloseVideo`, `StartVideo` vs `startVideo`, `updateMetadata` vs `UpdateMetadata`, `UpdateMetaData` vs `UpdateMetadata`, `onLoadVideo`, `Startvideo`, `EndVideo`, `moveinEarth` | JScript is case-sensitive; these throw in real WMP. Reproduce the throw. |
| B2. absent from the skin | 308 | template leftovers and typos: handlers copied from a template whose function the author renamed or deleted; names that dozens of *other* skins define (`OnOpenStateChange` 119, `EndVideo` 123, `StartVideo` 121, `UpdateMetadata` 85, `viewResizer` 89), or in no skin at all (`gotobig`, `gotogears`, `meatData`, `UpdateMetaData`) | a ReferenceError must abort only that handler, never the skin |
| C. supplied by wmploc | **0** | | |

The one unresolved name I could not place is `reset()` in `<playlist onmouseout>` and `<pausebutton onmouseout>` (6 archives: `skins/wmp/Beck.wmz!Beck.wms:468`, `skins/wmp/MSN.wmz!MSN.wms:176`). `EQUALIZERSETTINGS` has a `reset` method, but these are not equalizer elements. It is tallied under B2 above and treated as skin residue **[inference]**; it throws harmlessly if our elements lack the method.

### 4.2 Top of the ranking with representative call sites

Ranked by unique-content skins, then archives. "Where" is the enclosing tag and event attribute, or `script` for a `.js` file. "Elsewhere" is the number of other archives that *define* the name, which separates B2 from A.

| name | skins (raw) | uses | where | representative site | elsewhere | bucket |
|---|---|---|---|---|---|---|
| `previous` | 11 (19) | 19 | `<effects onclick>` | `skins/wmp/Roundlet.wmz!roundlet.wms:48` `onClick="previous();"` | 0 | A |
| `next` | 7 (12) | 14 | `<effects onclick>` | `skins/wmp/Radio.wmz!radio.wms:61` `onClick="next();"` | 0 | A |
| `updateMetadata` | 7 (14) | 26 | script | `skins/wmp/Secura.wmz!e-monee.js:36` `updateMetadata();` (defined as `UpdateMetadata` at `e-monee.js:416`) | 114 | B1 |
| `onCloseVideo` | 6 (13) | 13 | `<view onclose>` | `skins/wmp/Stars and Stripes.wmz!aim.high.wms:517` `onClose="onCloseVideo();"` (defined as `OnCloseVideo` at `aim.high.js:386`) | 2 | B1 |
| `detplay` | 6 (12) | 32 | script | `skins/wmp/Stars and Stripes.wmz!aim.high.js:158` `detplay();` | 2 | B2 |
| `OnOpenStateChange` | 5 (7) | 7 | script | `skins/wmp/Creed.wmz!Creed.js:17` | 119 | B2 |
| `SetVisibility` | 5 (9) | 13 | script | `skins/wmp/Creed.wmz!Creed.js:21`; `skins/wmp/Heart_Butterfly.wmz!butterfly.js:58` calls it but never defines it, while the near-identical `Roundlet` script does (`skins/wmp/Roundlet.wmz!roundlet.js:56`; template reuse is my inference) | 42 | B2 |
| `ZoomVideo` | 5 (7) | 7 | `<video onclick>` | `skins/wmp/Official_Xbox_MP71.wmz!xbox.wms:196` | 22 | B2 |
| `OnPlayStateChange` | 4 (6) | 6 | `<player playstate_onchange>` | `skins/wmp/Charlies_Angels_Full_Throttle.wmz!Charlies Angels.wms:13` | 84 | B2 |
| `EndVideo` | 4 (7) | 7 | `<video onvideoend>` | `skins/wmp/Secura.wmz!e-monee.wms:502` `JScript:EndVideo();` (skin defines lowercase `endVideo`, `e-monee.js:100`) | 123 | B1 |
| `UpdateMetaData` | 3 (6) | 6 | script | `skins/wmp/BMG__elvis.wmz!elvis.js:17` | 0 | B1 |
| `reset` | 3 (6) | 6 | `<playlist onmouseout>` | `skins/wmp/Beck.wmz!Beck.wms:468` | 2 | unplaced |
| `OnURLChange` | 3 (4) | 4 | `<player url_onchange>` | `skins/wmp/Charlies_Angels_Full_Throttle.wmz!Charlies Angels.wms:12` | 4 | B2 |
| `volUpDown` | 3 (6) | 8 | `<customslider onkeydown>` | `skins/wmp/Ice.wmz!Ice.wms:46` `volUpDown(event);` | 30 | B2 |
| `ToggleVisView` | 3 (6) | 6 | script | `skins/wmp/Kids.wmz!kids.js:33` | 5 | B2 |
| `htcpSliderUpdate` | 3 (5) | 5 | script | `skins/wmp/Rave-MP.wmz!rave.js:991` | 3 | B2 |
| `moveTo` | 2 (4) | 12 | `<text value_onchange>` | `skins/wmp/Revert.wmz!netgen.wms:211` `value_onchange="scrolling=false;moveTo(left,top,5000);"` | 0 | A |
| `alphaBlendTo` | 1 (2) | 8 | `<view onload/onmouseover/onmouseout/onkeydown>` | `skins/wmp/Revert (1).wmz!netgen.wms:17` `onLoad="vwPlayer_OnLoad();alphaBlendTo(40,9000);"` and lines 20-22 | 0 | A |
| `gotobig`, `gotogears` | 2 (4) each | 4 each | `<effects onclick>` | `skins/wmp/TheUnit.wmz!unit.wms:78`, `:83` | 0 | B2 |

The remaining ~60 names are singletons and doubletons of the same two patterns (B1/B2); I did not verify each individually.

### 4.3 What the reclassification means for the interpreter

These are **engine** requirements; none belongs in a wmploc shim.

1. **Event-handler code runs with the element as implicit scope.** [verified] `previous()` and `next()` are documented element methods of `EFFECTS` (https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/effects-next); `moveTo` and `alphaBlendTo` are documented "ambient attribute" methods on any element (WMP 9 SDK help, topics `ambientattributesmoveto.htm` and `ambientattributesalphablendto.htm`; SDK installer https://archive.org/details/WMPlayer9SeriesSDK). The same mechanism explains the free identifiers that appear in handlers and in `jscript:` attributes: `down` (`skins/wmp/9SeriesDefault.wmz!Corona.wms:668`, `onclick="JScript:down==false?player.controls.play():..."`), `width`/`left` (`Corona.wms:195`, `width="jscript:svBottomLeft.width-left"`), `textwidth` (`skins/wmp/Creed.wmz!Creed.wms:78`, `textwidth_onchange="JScript:scrolling=(textwidth>width);"`), `currentEffectType`/`currentPreset` (`currenteffecttype_onchange="mediacenter.effectType=currentEffectType;"`, e.g. `skins/wmp/Blinx.wmz!blinx.wms`, 100 archives). Suggested implementation: compile handler source with `new Function` (sloppy mode, so `with` is legal) inside `with(globalScope){ with(elementProxy){ ... } }`, where the element proxy's `has` trap answers true for every attribute and method of that element.
2. **Name resolution has two regimes.** Host-object members (`player.*`, element attributes and methods) match case-insensitively; script-defined identifiers and library constants match case-sensitively.
3. **Handler failures are local.** A ReferenceError (B1/B2 above) aborts that one handler and the skin keeps running; 123 of 342 archives (69 of 195 unique skins, 36%) contain at least one such name, so a strict "any error kills the skin" policy would reject over a third of the corpus.
4. **Script loading must be tolerant**: empty `scriptFile` entries, a trailing `;`, a missing script file, the same-name `.js` auto-load, and unknown `res://` entries (warn and continue).

---

## 5. String and other `res://` resources

### 5.1 Syntax and module aliases

Forms in the corpus: `res://wmploc.dll/RT_STRING/#2099`, `res://wmploc/RT_STRING/#2086`, `res://-/RT_STRING/#1812`, the same with `RT_TEXT`, `RT_IMAGE`, `RT_BITMAP`, and a type-less `res://-/#1792` / `res://wmploc/#1691`. Type names appear in mixed case (`RT_STRING`, `rt_string`). Module `-` is used by `Revert`, `Revert (1)` and `The Movies` (5 archives); `Compact`, `circle` and `9SeriesDefault` use `wmploc` or `wmploc.dll`.

**`-` = wmploc** is an **[inference]** with strong evidence: ids used under `-` (for example `res://-/RT_STRING/#1812`) exist in wmploc's string table with the text the control needs (`Close` on the control whose `onClick` is `view.close();`, `skins/wmp/Revert.wmz!netgen.wms:79`), the same skin mixes `res://-/` and `res://wmploc/` on neighbouring controls (`skins/wmp/Revert (1).wmz!netgen.wms:76` uses `res://wmploc/RT_STRING/#3904`), `res://-/RT_TEXT/#169` resolves only in wmploc, and WMP 10's other modules (`wmp.dll`, `wmpui.dll`, `wmpcore.dll`, `wmplayer.exe`) contain no `RT_STRING` resources at all. Normalise the module name case-insensitively: strip a trailing `.dll`, and treat `-` as `wmploc`. Anything else is unresolved.

### 5.2 Where skins use string ids

| attribute (or context) | example |
|---|---|
| `toolTip`, `upToolTip`, `downToolTip` | `upToolTip="res://-/RT_STRING/#1812"` (`skins/wmp/Revert.wmz!netgen.wms:79`) |
| `value` of a `<text>` | `<TEXT left="12" top="3" value="res://-/RT_STRING/#217" ...>` |
| `accName`, `accKeyboardShortcut` | `accKeyboardShortcut="res://-/RT_STRING/#2108"` (`netgen.wms:44`) |
| `fontFace` | `fontFace="res://-/RT_STRING/#1888"` (`netgen.wms:207`) |
| `scrollingDirection` | `scrollingDirection="jscript:theme.loadString('res://wmploc/RT_STRING/#1910');"` (`netgen.wms:214`) |
| `<theme author>`, `<theme copyright>` | `skins/wmp/circle.wmz!circle07.wms:6` |
| script assignment of an attribute | `tabTitle.value = "res://wmploc.dll/RT_STRING/#1827"` (`skins/wmp/compact.wmz!compact.js:295`); `QualityIcon.upToolTip="res://wmploc/RT_STRING/#2079"` (`skins/wmp/9SeriesDefault.wmz!metadata.js:416`); `onmouseup="toolTip='res://-/RT_STRING/#1845';"` |
| `theme.loadString(url)` call | `theme.loadString("res://wmploc.dll/RT_STRING/#2099")` (`metadata.js:15`) |

So the engine must resolve a `res://` string in three places: at attribute parse, when script **assigns** such a string to an attribute, and when `theme.loadString` is called. **[verified]** that all three occur in the corpus.

`theme.loadString(resUrl) -> string` is undocumented in the MSDN `THEME` reference (my fetch of `.../theme-loadstring` returned 404 and searches found nothing); it is used by Microsoft's own scripts (RT_TEXT #134, #142, #169, `metadata.js`). The signature is inferred from those uses.

### 5.3 The 47 ids the corpus references, with the real text

Source: `RT_STRING` of the English WMP 10 and WMP 11 `wmploc.dll`. Ids 1807..2150 are identical in both versions; 3904..3909 exist only in WMP 11 (they belong to `Revert (1)`, the WMP 11 version of Revert). Refs are total references; the parenthesised number is unique-content skins. All ids except 3904..3909 also exist in the WMP 9 Series Swedish table (https://archive.org/details/wmploc_str), with the same meaning, so ids are stable across versions 9, 10 and 11.

| id | refs (skins, unique) | attribute(s) | WMP 10/11 English | note |
|---|---|---|---|---|
| 217 | 8 (2) | `uptooltip`, `value` | Playlist | also painted as a pane title (`<TEXT value=...>`) |
| 1273 | 8 (2) | `uptooltip`, `downtooltip` | Quick Access Panel | quick-access panel button; same id for up and down |
| 1807 | 4 (2) | `uptooltip` | Mute | up-state of the mute toggle (asks to mute) |
| 1808 | 4 (2) | `downtooltip` | Sound | down-state of the mute toggle; the text is "Sound", not "Unmute" |
| 1809 | 6 (3) | `tooltip`, `ondragend` | Seek | seek slider tooltip; also assigned from `ondragend` (The Movies) |
| 1810 | 8 (2) | `uptooltip`, `value` | Volume | volume slider or label |
| 1811 | 4 (2) | `uptooltip` | Minimize | minimize button |
| 1812 | 24 (2) | `uptooltip`, `accname` | Close | close button, also its accName |
| 1813 | 4 (2) | `uptooltip` | Switch to full mode | Revert: `view.returnToMediaCenter()` button |
| 1814 | 4 (2) | `uptooltip` | Turn shuffle on | |
| 1815 | 4 (2) | `downtooltip` | Turn shuffle off | |
| 1816 | 4 (2) | `uptooltip` | Turn repeat on | |
| 1817 | 4 (2) | `downtooltip` | Turn repeat off | |
| 1827 | 2 (1) | script | SRS WOW Effects | Compact: settings-tab title, assigned from script |
| 1845 | 16 (2) | `value`, `onmouseup`, `tooltip`, `accname` | Balance | balance slider |
| 1846 | 4 (1) | script | On | Compact: EQ/SRS switch label, enabled branch |
| 1848 | 10 (3) | `uptooltip`, `value`, script | Graphic Equalizer | EQ pane title and tooltip |
| 1849 | 2 (1) | script | Video Settings | Compact: video-settings tab title |
| 1851 | 4 (1) | script | Off | Compact: EQ/SRS switch label, disabled branch |
| 1888 | 12 (2) | `fontface` | Arial | `fontFace`; **locale-dependent** (Arial en-US, Tahoma sv-SE) |
| 1910 | 12 (2) | `scrollingdirection` | left | a direction word, not UI text |
| 1998 | 2 (1) | `author` | Microsoft Corporation | `<theme author>` |
| 1999 | 2 (1) | `copyright` | (C) Microsoft Corporation. All rights reserved. | `<theme copyright>`; no year in the string |
| 2063 | 2 (1) | script | Buffering: %d%% complete | see 5.4 anomaly |
| 2066 | 4 (2) | script | %sKbps | format; en uses `%s`, sv uses `%1` |
| 2077 | 2 (1) | script | Protected Content | DRM status line |
| 2078 | 2 (1) | script | Authentic Content from %s | DRM status, `%s` = signer |
| 2079 | 2 (1) | script | Perfect Reception | QualityIcon tooltip |
| 2080 | 2 (1) | script | Network Congestion | QualityIcon tooltip |
| 2081 | 2 (1) | script | Poor reception | QualityIcon tooltip |
| 2086 | 2 (1) | script | %1, %2 | DVD chapter and title format, positional |
| 2092 | 2 (1) | script | Network is too busy to play file at original quality | QualityIcon tooltip |
| 2097 | 2 (1) | script | HDCD Audio CD playing | HDCD indicator tooltip |
| 2098 | 2 (1) | script | HDCD Audio CD detected | HDCD indicator tooltip |
| 2099 | 2 (1) | script | %s% complete | buffering tooltip format (sic) |
| 2108 | 8 (2) | `acckeyboardshortcut` | Right/Up Arrow to increase, Left/Down Arrow to decrease | accessibility only |
| 2109 | 4 (2) | `accname` | Seek | seek slider accName |
| 2110 | 2 (1) | `tooltip`, `onmouseup` | Volume | volume slider tooltip |
| 2114 | 8 (2) | `acckeyboardshortcut` | Spacebar or Enter | accessibility only |
| 2130 | 4 (2) | `accname` | Mute | mute accName |
| 2150 | 4 (2) | `accname` | Now Playing menu | accName |
| 3904 | 2 (1) | `accname` | Full Mode | new in WMP 11 |
| 3905 | 2 (1) | `accname` | Show Volume Slider | new in WMP 11 |
| 3906 | 2 (1) | `uptooltip` | Turn on graphic equalizer | new in WMP 11 |
| 3907 | 2 (1) | `downtooltip` | Turn off graphic equalizer | new in WMP 11 |
| 3908 | 2 (1) | `accname` | Enable and Disable Graphic Equalizer (toggle) | new in WMP 11 |
| 3909 | 2 (1) | `uptooltip` | Presets | new in WMP 11 |

(The 47 rows above are the whole corpus demand: the other ~2,600 ids in the table are never referenced.)

### 5.4 Flags for the shim

- **Anomaly, not resolved.** `skins/wmp/9SeriesDefault.wmz!metadata.js:505` `OnDisconnectTransport()` shows `theme.loadString("res://wmploc.dll/RT_STRING/#2063")`, but #2063 is the *buffering* line "Buffering: %d%% complete"; the id for "Disconnected" is #2064. The WMP 9 Swedish table and the WMP 10/11 English tables agree on this numbering. Real WMP would therefore show the raw `%d%%` text there **[inference, not observed in a running WMP]**. Do not "fix" it.
- **Locale-dependent non-text values.** `fontFace` via #1888 is a font family, `Arial` in English, `Tahoma` in Swedish. The shim must always return a usable face name (use the English value or the platform UI font); a blank `fontFace` is not equivalent. #1910 is the scroll direction word `left` (the corpus gives no right-to-left example; an RTL locale would presumably say `right`, **[inference]**).
- **Format strings** (#2063, #2066, #2078, #2086, #2099) are passed through the skin's own `sprintf` or `String.prototype.sprintf`; they use `%s`, `%1`, `%2`, and (#2063) `%d%%`. Return the raw template; do not pre-format.
- **Prior-art corrections.** NullPlayer's inferred table (https://github.com/ad-repo/nullplayer/blob/HEAD/Sources/NullPlayer/WMPSkin/WMPResourceStrings.swift) is a careful corpus-based guess; checked against the DLLs, these rows differ: 1808 ("Unmute", actual "Sound"), 1813 ("Return to Full Mode", actual "Switch to full mode"), 2063 ("Disconnected", actual the buffering line, see above), 1999 ("© 2000 Microsoft Corporation. All rights reserved.", actual "(C) Microsoft Corporation. All rights reserved." with no year), 2098 ("HDCD", actual "HDCD Audio CD detected"), 3904 ("Return to Full Mode", actual "Full Mode"), 3905 ("Volume", actual "Show Volume Slider"), 3906/3907 (capitalisation and wording), 3908 ("Equalizer", actual a long toggle description). The rest match. Its list of ids "deliberately left blank" (the format strings, #2079-#2081, #2092, #2097, #1273, #2150, #1888, #1910, #2108, #2114) can now all be filled from section 5.3.

### 5.5 Image resources (outside the wmploc-library question; unresolved)

| form | where | what it is | note |
|---|---|---|---|
| `res://wmploc/RT_IMAGE/#N` for N in 1770, 1771, 1773, 1774, 1776, 1782, 1783, 1784, 1787, 2023, 2024, 2030 | `skins/wmp/9SeriesDefault.wmz!metadata.js:18` (play-status icons) | RT_IMAGE (type 257): 32x15 GIFs, #2030 is 30x13 | WMP's own art |
| `res://wmploc.dll/RT_BITMAP/#N` for N in 288-290, 292-294, 373-375, 423, 424, 427, 521 | 9SeriesDefault scripts | #373-375, #423, #424, #427 are 29x29 DIBs (type 2); #521 is a 200x200 DIB in WMP 10 and a 200x200 PNG (type 257) in WMP 11; #288-#294 were not found in types 2, 257, 14 or 23 of either DLL | |
| `res://-/#1792` | `skins/wmp/Revert.wmz!netgen.wms:311` as `backgroundImage` | type-2 bitmap, 58x15 | an EQ-slider background |
| `res://-/#520` | `skins/wmp/Revert (1).wmz!netgen.js:337` (`ctrlAlbumArt.backgroundImage`) | 75x75 (bitmap in WMP 10, PNG in WMP 11) | the "no album art" placeholder |
| `res://wmploc/#1685`, `#1686`, `#1691`, `#1698` | `metadata.js:42-57` | **no resource with these ids in any type of the WMP 10 or 11 DLL** (presumably WMP 9-era ids **[inference]**) | high-contrast (`contrastMode` "BW"/"WB") play and pause images only |

Bare `#N` (no type) resolves over RT_BITMAP and RT_IMAGE **[inference]**. This is Microsoft art, so the engine cannot ship it. Fallback: a transparent image of the listed size, plus one diagnostic per unresolved image. None of these are on the Phase 1 (Headspace) path.

---

## 6. Web search log (what was and was not found)

Searches run: the literal `res://wmploc.dll/RT_TEXT/#132` with `scriptFile`; `wmploc` with `osMediaOpen`/`psPlaying`; `theme.loadString` with `res://wmploc`; skin-tutorial phrasings; GitHub code search for the constants and for `wmploc`.

| Source | URL | Finding |
|---|---|---|
| MSDN `VIEW.scriptFile` | https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/view-scriptfile | semicolon-delimited list; a `.js` with the `.wms` base name loads automatically; no mention of `res://` |
| MSDN `player.openState` | https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/player-openstate | values 0..21; "prefix with `wmpos`" |
| MSDN `player.playState` | https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/player-playstate | values 0..11; "prefix with `wmpps`" |
| MSDN `EFFECTS.next` | https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/effects-next | `next()` is an `EFFECTS` method, WMP 7+ |
| MSDN skin definition file structure | https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/skin-definition-file-structure | no mention of `res://`, `wmploc` or a built-in script |
| WMP 9 Series SDK (archive.org) | https://archive.org/details/WMPlayer9SeriesSDK | `wmpsdk.chm`, 1215 `.htm` topics: grep for `wmploc`, `res://`, `loadString` finds nothing; the skin-script names `osMediaOpen`/`psPlaying` appear nowhere (only the C enums `wmposMediaOpen`/`wmppsPlaying`); the only `LoadString` hits are unrelated C++ plug-in samples; the SDK sample skin `bigdrawer.wms` lists only `bigdrawer.js` |
| `tdebaets/wmp-wsz-format` | https://github.com/tdebaets/wmp-wsz-format | `wmploc.dll` embeds internal skins such as `MAINAPPSKIN2.WSZ`; WMP's `.WSZ` is its own binary format |
| NullPlayer WMP skin engine | https://github.com/ad-repo/nullplayer (`Sources/NullPlayer/WMPSkin/WMPObjectModel.swift`, enum `WMPScriptConstants`; `docs/wmp-skin-support-spike.md` section 3.4 and 7) | independently defines the same `os*`/`ps*` globals from MSDN and adds `osOpeningUnknownURL`; treats `res://wmploc.dll/RT_TEXT/#132` as an unresolvable entry that degrades to a warning |
| webamp-modern WMP engine | https://github.com/captbaritone/webamp (`packages/webamp-modern/src/skin/SkinEngine_WindowsMediaPlayer.ts` `_setGlobalVar`; `.../wmpClasses/View.ts` `addJsScript`) | defines the `os*` globals on `window` (not the `ps*`), keeps only the text before the first `;` of `scriptFile`, so it loads just the first script and drops every later entry, the `res://` one included |
| `wmploc_str` (archive.org) | https://archive.org/details/wmploc_str | a UTF-16 dump of the WMP 9 Series **Swedish** string table, ids 100-29211 (1861 strings); useful as an id-stability cross-check, not as English text |
| WMP 10 and WMP 11 English installers | https://archive.org/details/wmp10x86 , https://archive.org/details/wmp11eng_swe | the actual `wmploc.dll` files: primary source for everything in sections 2 and 5 |

Not found anywhere: any prose documentation of `RT_TEXT #132`, `res://-/`, or `theme.loadString`; Wine and ReactOS carry no `wmploc` resources. The web search tool surfaced no skin-author tutorial that mentions the library.

---

## 7. Proposed shim

### 7.1 Scope

| piece | needed for | priority |
|---|---|---|
| resource URL resolver | every `res://` use | must |
| script-library registry for `scriptFile` | all 243 archives that include #132 | must |
| constants (#132) | 111 unique skins read them; Headspace needs `osMediaOpen` | must |
| `theme.loadString` + attribute string resolution | 6 unique skins (Revert, Revert (1), Compact, circle, 9SeriesDefault, The Movies) | should (before the Microsoft reference skins) |
| #169 `sprintf` family | Revert, Revert (1) | should |
| #134, #136 | none in corpus | optional |
| RT_IMAGE / RT_BITMAP fallback | Microsoft reference skins only | later |

### 7.2 Resource URL resolver

```
parse:   /^res:\/\/([^\/]*)\/(?:([A-Za-z_]+)\/)?#(\d+)$/i
module:  lowercase; strip trailing ".dll"; accept "wmploc" or "-"; else unresolved
type:    uppercase; RT_TEXT | RT_STRING | RT_IMAGE | RT_BITMAP | (absent)
result:  {module:'wmploc', type, id}  or null (unresolved: warn once, continue)
```

Do **not** require an exact module spelling: `wmploc.dll` (417 of the `#132` references), `wmploc` (16) and `-` are all in use. Treat everything after `#` as a decimal id; one corpus string ends in `#` + a variable (`theme.loadString("res://wmploc/RT_STRING/#" + formatStringID)`, `skins/wmp/9SeriesDefault.wmz!metadata.js:231`), so resolution must also run on strings built at runtime.

### 7.3 `scriptFile` handling

1. Split on `;`, trim, drop empty entries.
2. A non-`res://` entry loads a skin script (missing file: warn, continue). Also auto-load `<wms base name>.js` if not already listed (17 `.wms` rely on it).
3. A `res://` entry is looked up in the library registry (below); an unknown one warns and is skipped, and its siblings still load.
4. **Evaluation order.** Real WMP loads entries in list order, with the library always last (437/437), so a skin that reads `osMediaOpen` in top-level code would throw in real WMP. The shim should seed the constants **before any skin script runs** (a superset of real behaviour; costs nothing). Offer a `strict` switch that reproduces real WMP, under which `Kids` and `UPRISING` fail on first use of `osMediaOpen`; keep it off by default but use it in conformance reporting.

### 7.4 Library registry

| key | behaviour |
|---|---|
| RT_TEXT 132 | install the constants (7.5) |
| RT_TEXT 169 | install `sprintf`, `String.prototype.sprintf`, `WMPStringsFunction_GetPositionText`, `g_kPositionFormatString` (7.6) |
| RT_TEXT 134 | `g_kSMALL_FONTSIZE = 8`, `g_kMEDIUM_FONTSIZE = 9` (from #1889 and #1892) |
| RT_TEXT 136 | `VR_PRESET_PREV = 1`, `VR_PRESET_NEXT = 2`, `VR_VIZ_PREV = 3`, `VR_VIZ_NEXT = 4`, `VR_EXIT_PLAYER = 999` |
| any other RT_TEXT id | warn, skip (built-in skin scripts depend on built-in skin elements) |

### 7.5 Constants (our own code)

```js
// Proposed src/skin/wmploc.js. Original code; names and values are the facts
// observed in RT_TEXT #132 and listed in MSDN player.openState / player.playState.
const OS = ['Undefined', 'PlaylistChanging', 'PlaylistLocating', 'PlaylistConnecting',
  'PlaylistLoading', 'PlaylistOpening', 'PlaylistOpenNoMedia', 'PlaylistChanged',
  'MediaChanging', 'MediaLocating', 'MediaConnecting', 'MediaLoading', 'MediaOpening',
  'MediaOpen', 'BeginCodecAcquisition', 'EndCodecAcquisition', 'BeginLicenseAcquisition',
  'EndLicenseAcquisition', 'BeginIndividualization', 'EndIndividualization', 'MediaWaiting'];
const PS = ['Undefined', 'Stopped', 'Paused', 'Playing', 'ScanForward', 'ScanReverse',
  'Buffering', 'Waiting', 'MediaEnded', 'Transitioning', 'Ready', 'Reconnecting'];

export function wmplocConstants({ extras = true } = {}) {
  const g = {};
  OS.forEach((n, i) => { g['os' + n] = i; });          // 0..20
  PS.forEach((n, i) => { g['ps' + n] = i; });          // 0..11
  if (extras) g.osOpeningUnknownURL = 21;              // MSDN value; NOT in RT_TEXT #132
  g.WMPPlaylistChangeEventTypes = ['Unknown', 'Clear', 'InfoChange', 'Move', 'Delete',
    'Insert', 'Append', 'Private', 'NameChange', 'Morph'];
  return g;                                            // seed as globals of the skin script scope
}
```

`extras` diverges from the DLL on purpose (21 is harmless and matches MSDN); a conformance run can turn it off.

Feeding the values from MPD is an engine concern, not part of the library. Proposal **[design choice, not verified against WMP]**:

| MPD | `player.playState` | `player.openState` |
|---|---|---|
| `state: play` | `psPlaying` (3) | `osMediaOpen` (13) |
| `state: pause` | `psPaused` (2) | `osMediaOpen` |
| `state: stop`, a current song or queue exists | `psStopped` (1) | `osMediaOpen` |
| queue empty | `psUndefined` (0) | `osUndefined` (0) |

At least one skin tests `psUndefined`, `psReady` and `psStopped` together as "idle" (`skins/wmp/Asimov_Radio.wmz!MBay.js:236`), and most of the 106 unique skins that read `osMediaOpen` only compare `openState` against it, so the exact idle encoding is low risk. MPD is audio-only, so `currentMedia.imageSourceWidth` stays 0, which is the other half of the common `osMediaOpen && imageSourceWidth > 0` video test (`~/Downloads/Headspace.wmz!headspace.js:28-29`).

### 7.6 The #169 string helpers (bug-compatible behaviour, our own code)

Observed behaviour of the DLL's `sprintf(str, s)` **[verified]**: if `s` is a string, replace **every** `%s` in `str` with it; otherwise iterate `s`'s enumerable members in order with a counter starting at 1 and replace the **first** case-insensitive occurrence of `%<counter>` with each member; return `str`. A number or `undefined` for `s` returns `str` unchanged. It is installed as both a global function and `String.prototype.sprintf`; when called as a method the receiver is ignored (`sz3.sprintf(bitrateString, kbps.toFixed(0))`, `skins/wmp/Revert.wmz!netgen.js:222`, formats `bitrateString` and ignores `sz3`).

Note the version difference: the skin-local copy in `9SeriesDefault` replaces only the first `%s` (`/%s/i`, `skins/wmp/9SeriesDefault.wmz!metadata.js:267-289`); the DLL's version (#169) replaces all (`/%s/g`). Implement the DLL's.

```js
export function sprintf(str, s) {
  if (typeof s === 'string') return str.replace(/%s/g, s);
  let index = 1;
  for (const k in s) {                                   // arrays: positional %1, %2 ...
    str = str.replace(new RegExp('%' + index, 'i'), s[k]); // first occurrence only
    index++;
  }
  return str;
}
// String.prototype.sprintf = function (fmt, s) { return sprintf(fmt, s); }  // receiver ignored
```

`WMPStringsFunction_GetPositionText()`: returns `""` if `player.controls.currentPositionString` is empty; otherwise, if `player.openState == osMediaOpen` and `player.currentMedia.duration > 0`, formats `g_kPositionFormatString` with `[currentPositionString, currentMedia.durationString]`; else returns just the position string. `g_kPositionFormatString = theme.loadString("res://wmploc/RT_STRING/#2091")`, which is `"%1 / %2"`.

### 7.7 Strings: `loadString` and attribute resolution

```
loadString(url):
    r = resolve(url)
    if r is null or r.type != RT_STRING:      return ""            // + warn once
    return STRINGS[r.id] ?? ""                                      // + warn once per unknown id
```

- `STRINGS` is the table in section 5.3 (the 47 corpus ids). **For distribution, re-author the labels** (they are short UI words; section 5.3 gives the shape and meaning of each) rather than ship Microsoft's text file; the English text above is the reference.
- Resolution points: (a) when an attribute value is a bare `res://...` URL at parse time; (b) on every script assignment to a string attribute (`toolTip`, `upToolTip`, `downToolTip`, `value`, `accName`, `accKeyboardShortcut`, `fontFace`, `scrollingDirection`, `author`, `copyright`); (c) in `theme.loadString`.
- Never resolve a *format* id to a blank. #2063, #2066, #2078, #2086, #2099 must return their template (`%d%%`, `%s`, `%1`, `%2`).
- Unknown ids: return `""` for text attributes, a sensible system face for `fontFace` ids, `left` for `scrollingDirection`.
- Accessibility attributes (`accName`, `accKeyboardShortcut`) need not render, but store the resolved text so they can later feed an ARIA label.
- Unknown modules (anything other than wmploc, wmploc.dll, `-`): unresolved, warn.

### 7.8 API summary

| name | signature | behaviour | source |
|---|---|---|---|
| `osXxx`, `psXxx` (33 names) | globals, `number` | the constants in 2.2; `osOpeningUnknownURL = 21` added | RT_TEXT #132 |
| `WMPPlaylistChangeEventTypes` | global `string[10]` | `Unknown`..`Morph` | RT_TEXT #132 |
| `sprintf` | `(str: string, s: string \| any[]) -> string` | 7.6 | RT_TEXT #169 |
| `String.prototype.sprintf` | `(fmt: string, s) -> string`, receiver ignored | same as `sprintf(fmt, s)` | RT_TEXT #169 |
| `WMPStringsFunction_GetPositionText` | `() -> string` | `"<position> / <duration>"` when a media is open with `duration > 0`, else the position string, else `""` | RT_TEXT #169 |
| `g_kPositionFormatString` | global `string` | `"%1 / %2"` | RT_TEXT #169 + RT_STRING #2091 |
| `g_kSMALL_FONTSIZE`, `g_kMEDIUM_FONTSIZE` | globals, `number` | 8 and 9 | RT_TEXT #134 (optional) |
| `VR_PRESET_PREV` .. `VR_EXIT_PLAYER` | globals, `number` | 1, 2, 3, 4, 999 | RT_TEXT #136 (optional) |
| `theme.loadString` | `(resUrl: string) -> string` | 7.7; `""` for anything unresolved | wmploc string table |
| attribute resolver | internal | resolves a `res://` value on parse and on script assignment | wmploc string table |

### 7.9 Tests the shim should ship with

1. Constants: every `os*`/`ps*` name equals the MSDN value; `Object.keys` matches the 33 + `osOpeningUnknownURL` (+ array).
2. `sprintf`: `%s` global; `%1`/`%2` positional; first-occurrence-only; number argument leaves the string unchanged; method form ignores the receiver; `"%sKbps".sprintf` with string argument gives `"128Kbps"`-style output.
3. Resolver: `wmploc`, `wmploc.dll`, `-`, mixed-case types, missing type, runtime-built `"...#" + id`, unknown module.
4. `scriptFile` parse: trailing `;`, two spaces, 5 entries, unknown `res://` entry skipped with siblings loaded, missing script.
5. Corpus smoke test over the 195 unique skins: no skin that includes #132 raises a ReferenceError for any name in the library set; the unresolved-call histogram equals the section 4.2 buckets A/B1/B2 and nothing else (guards against the shim silently masking a real gap).
6. Headspace: `player.OpenState == osMediaOpen` evaluates true for a loaded MPD song and false with an empty queue (`headspace.js:28`).

---

## 8. Risks and open questions

1. **Handler scope is the real work.** Element-implicit scope, case-insensitive host members, and handler-local failure all change what "undefined identifier" means. If the interpreter evaluates handlers as plain functions with only globals, `previous()`, `next()`, `down`, `width`, `value` and `currentEffectType` break in dozens of skins, and no shim can repair that.
2. **Seed-early versus faithful order.** Seeding constants before skin scripts is a deliberate superset of WMP. Whether to also emulate the strict failure of `Kids` and `UPRISING` is a product call.
3. **The 2063/2064 anomaly** is unresolved: either the skin author mis-numbered a resource, or WMP 9 numbered it differently from the WMP 9 Swedish dump (the dump agrees with 10/11, so the first is likelier). Unverified in a running WMP.
4. **Locale.** All corpus text assumes English wmploc. Locale-dependent ids (#1888 font, #1910 direction) must not be blanked.
5. **Copyright of the strings.** The 47 short labels are functionally necessary but are Microsoft text; the shim should carry re-authored equivalents, and the DLLs stay out of the repo.
6. **Image resources** (5.5) are unresolved; Microsoft's art cannot ship. Only the Microsoft reference skins need them.
7. **WMP 7/8/9 `wmploc.dll`** was not extracted (only the WMP 9 Swedish string dump and the WMP 10/11 English DLLs). "#132 has been constants-only since WMP 7" is an inference from the identical WMP 10/11 blobs, from the 2000-2001 skins that include it, and from the MSDN WMP 7+ property tables. A skin that depends on a *different* #132 could only be an older, non-corpus skin.
8. **Corpus ambiguity of `reset()`** on `<playlist>`/`<pausebutton>` (section 4.1) is unplaced.

---

## Appendix A. Reproduction

```sh
# provenance: download into an empty directory, never run, extract with 7-Zip
curl -L -o wmp10.exe https://archive.org/download/wmp10x86/wmp10-windowsxp-x86-enu.exe
7zz x -o/tmp/wmp10x/l1 wmp10.exe                  # payload contains wmploc.DLL directly
curl -L -o wmp11.exe https://archive.org/download/wmp11eng_swe/wmp11-windowsxp-x86-en-us.exe
7zz x -o/tmp/wmp11x/l1 wmp11.exe wmp11.exe -r      # inner installer in the RCDATA/CABINET
7zz x -o/tmp/wmp11x/l2 /tmp/wmp11x/l1/wmp11.exe wmploc.dll -r
python3 -m venv /tmp/pevenv && /tmp/pevenv/bin/pip install pefile
```

```python
# dump RT_TEXT (custom type 256) and RT_STRING (type 6); run with: python -I extract.py wmploc.dll outdir
import sys, os, struct, pefile
pe = pefile.PE(sys.argv[1]); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
strings = {}
for te in pe.DIRECTORY_ENTRY_RESOURCE.entries:
    tn = te.name.decode() if te.name else te.id
    for ne in te.directory.entries:
        nn = ne.name.decode() if ne.name else ne.id
        for le in ne.directory.entries:
            d = le.data.struct; data = pe.get_data(d.OffsetToData, d.Size)
            if tn == 256:                       # RT_TEXT
                open(f'{out}/rt_text_{nn}.bin', 'wb').write(data)
            elif tn == 6:                       # RT_STRING: 16 length-prefixed UTF-16 strings per block
                pos = 0
                for i in range(16):
                    n = struct.unpack_from('<H', data, pos)[0]; pos += 2
                    s = data[pos:pos + 2 * n].decode('utf-16le'); pos += 2 * n
                    if n: strings[(nn - 1) * 16 + i] = s   # string id = (block-1)*16 + index
```

Corpus scan: unzip every archive to `/tmp/wmpcorp/<name>/`; decode each `.wms`/`.js`; extract event-attribute JS (`on*`, `*_onchange`, `jscript:` values, HTML-entity decoded) and `.js` bodies; strip comments and string literals; match `(?<![\w$.])ident\s*\(`; subtract skin-defined function names and JS built-ins; dedupe skins by hash of whitespace-stripped `.wms`+`.js`.
