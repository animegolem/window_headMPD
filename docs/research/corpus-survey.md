# WMP skin corpus survey

What real classic Windows Media Player skins look like in practice, measured to
shape the `.wms` interpreter (phase 1) and the runtime behind it.

- Date: 2026-10-06. Branch: `skin-engine`.
- Corpus: `skins/wmp/*.wmz` (342 files; census in `docs/research/corpus-census.txt`).
- Method: throwaway Python (stdlib `zipfile` + `xml.parsers.expat`, PIL for image
  decode, node `vm.Script` for script syntax) kept in `/tmp/corpus_work/`
  (`survey.py`, `agg1-4.py`, ...). Nothing in the repo was modified except this file.
  Skin art was never copied into tracked paths; the fixtures below were unzipped
  only into `/tmp/fixtures/`.
- Numbers are given as **distinct (raw)**: "116/195 (59%) [raw 200/342]". The
  corpus contains many byte-identical repackagings, so raw counts overstate
  prevalence; use the distinct column.
- Skin citations are `Skin.wmz/file.wms:line` (line numbers of the decoded file,
  identical to the original lines). The decoded/unzipped copies live under
  `/tmp/fixtures/<name>/_decoded/` and `/tmp/corpus_work/out/decoded/<skin>/`.

## 0. What the interpreter author most needs to know

1. **The corpus is half the size it looks.** 342 archives but only **195 distinct
   by SHA-256**: 147 are duplicates under author-prefixed names (`microsoft__`,
   `theskinsfactory__`, `skinwerkz__`, ...). Within the 195, one script template
   family (theskinsfactory "Blinx" lineage) covers 23 skins and a few more
   families cover 3-6 each.
2. **Strict XML fails on 41% of skins.** Only 116/195 (59%) [raw 200/342] parse
   as well-formed XML as-is. Every failure is one of four mechanical classes
   (duplicate attributes 67, missing whitespace between attributes 22, end-tag
   case mismatch 12, junk after the root 1). A tolerant tokenizer that handles
   exactly those makes 195/195 parse. Notably there are **zero** unescaped `&`
   or `<` inside attribute values (JScript in attributes is properly
   entity-escaped), zero unquoted attributes, zero XML declarations.
3. **Names are case-insensitive in practice.** 192/195 skins spell some
   attribute in a non-majority case; 106/195 do so for tags; 187/195 skins use
   two spellings of the same attribute internally. The same holds for host
   object members in script (`playState` / `PlayState` / `playstate`).
4. **File references are case-insensitive too.** 62/195 (32%) skins reference at
   least one file with different case than the zip entry (716 refs); a
   case-sensitive map lookup breaks one skin in three. Another 46/195 (24%)
   reference at least one file that is not in the archive at all (90 refs).
5. **Layout is an expression language, not static numbers.** 147/195 (75%)
   skins use `left/top/width/height="jscript:..."` expressions (6,751
   attributes), including the owner's Headspace (25 uses). `wmpprop:` data
   bindings appear in 189/195, `wmpenabled:` in 140/195.
6. **Scripts are plain ES3-ish JS and need no JScript-specific parsing.** All 219
   script files and 12,863 of 12,868 attribute handlers compile as ordinary
   sloppy-mode JS in V8 (the 5 failures are one skin's typo). The hard part is the
   *host model*, not the syntax: element ids as globals, handlers evaluated with
   the owning element's properties in scope, case-insensitive host members, a
   shared built-in script (`res://wmploc.dll/RT_TEXT/#132`) that supplies enum
   constants.
7. **`res://wmploc.dll/RT_TEXT/#132` is loaded by 133/195 skins and is almost
   certainly the `os*`/`ps*` enum constants** (`osMediaOpen`, `psPlaying`, ...).
   Evidence in section 5.5; I cannot read the DLL, so this is inferred.
8. **Multi-view skins are the norm above the trivial tier.** 48% have one view;
   the median is 2, p90 is 6, max 9. 45% use `theme.openView`, 48% persist state
   with `theme.savePreference`/`loadPreference`. 83 of 94 preference users
   compare `loadPreference` against the literal sentinel `"--"`.
9. **The owner's Headspace is not the corpus Headspace.** `~/Downloads/Headspace.wmz`
   differs from `skins/wmp/Headspace.wmz` in `headspace.wms` only (2001 vs 2000
   revision, 77 diff lines). The oracle must be the owner's copy.
10. **Archive hygiene is a real input problem**: 3 distinct archives have a
    corrupted first local-file-header signature (unreadable first entry), 1 has
    classic-Mac `RESOURCE.FRK/` resource-fork junk, 2 contain two `.wms` files,
    3 files use an uppercase `.WMZ` extension (and 3 distinct archives hold an
    uppercase `.WMS`/`.JS` inside), and one skin's `.bmp` files are really GIF/JPEG.

## 1. Corpus facts

### 1.1 Inventory

| Item | Distinct [raw] |
| --- | --- |
| Archives | 195 [342] |
| Files with uppercase `.WMZ` extension | 3 [3] (`howarduniversity__TEDDY.WMZ`, `howarduniversity__UPRISING.WMZ`, `microsoft__PYRITE.WMZ`) |
| Archives whose inner `.wms` has an uppercase extension (`BIGFAC.WMS`, `CODE15.WMS`, `SANKOFA.WMS`; TEDDY and sankofa also have `.JS`) | 3 [3] |
| Archives where the `.wms` could not be read by `zipfile` as-is | 3 [6] (corrupt first header, see 1.2) |
| Archives with more than one `.wms` | 2 [4] (`Nautical`, `Sports`; the `saltmine__*` copies are identical) |
| Elements per skin (primary `.wms`) | mean 113, median 95, p90 209, max 556 (`xsn_sports`) |
| `.wms` size | median 28 KB, p90 74 KB, max 198 KB |
| Zip size | median 518 KB, p90 1.6 MB, max 2.9 MB |
| Entries per zip | median 77, p90 159, max 303 |
| Views per skin | 1: 93, 2: 21, 3: 6, 4: 21, 5: 17, 6: 18, 7: 9, 8: 6, 9: 4 |
| Subviews per skin | mean 38, median 15, max 424 |
| First view size | median 439x373, min 192x82, max 1152x795 |

Author-prefix naming (`microsoft__`, `theskinsfactory__`, `skinwerkz__`,
`howarduniversity__`, `saltmine__`, ...) is the scraper's provenance tag; the
un-prefixed duplicate is byte-identical in every case I checked, so dedup by
archive hash.

Cross-check against `corpus-census.txt`: element totals agree within 1-2%
(subview 12,945 vs census 12,846; customslider 567 vs 565; view 982 vs 971). The
census says "parsed 337, bad 2": its glob missed the 3 uppercase `.WMZ` files
(342 - 3 = 339 attempted) and the 2 failures are, by inference, the two
`SplinterCellWMPSkin` copies (the only archives whose corrupt first header hits
the `.wms` itself). This survey covers all 342.

### 1.2 Archive-level defects

- **Corrupt first local-file header (3 distinct, 6 raw):** `bruteforce.wmz`,
  `SplinterCellWMPSkin.wmz`, `QuantumRedshiftWMPSkin.wmz`. Bytes 0-3 are
  `01 00 01 00` instead of `50 4B 03 04` (`PK\3\4`). The central directory is
  intact. `unzip -t` reports "bad zipfile offset (local header sig): 0" and
  Python raises `BadZipFile: Bad magic number for file header` on the first
  entry only. For SplinterCell that entry is `sc.wms` itself, so the whole skin
  is unreadable; for the other two it is an image, so one piece of art is lost
  and nothing else notices. Patching bytes 0-3 in memory repairs all three
  fully.
- **`RESOURCE.FRK/` junk:** `howarduniversity__TEDDY.WMZ` and
  `howarduniversity__Roboxcube.wmz` contain AppleDouble resource-fork entries
  named like images (`RESOURCE.FRK/HOVER.BMP`, 6,874 bytes). 9 entries, none
  decode as images. Skip directories and `RESOURCE.FRK/`, `__MACOSX/`.
- **Multi-`.wms` archives** (`Nautical.wmz`: `Nautical.wms` + `sample.wms`;
  `Sports.wmz`: `ExtremeSports.wms` + `saltmine.wms`). The second file is an
  independent stale skin definition whose art is mostly absent: `sample.wms`
  has 26 unresolved references and `saltmine.wms` has 65 (the real ones
  resolve 0). Neither has a name matching the zip in `Sports`. Selection rule
  that works on all four: **choose the `.wms` with the fewest unresolved
  references**, break ties by name match to the zip stem, then by size.
- **Implicit script file:** Microsoft documents that a `.js` file with the same
  stem as the `.wms` loads automatically without a `scriptFile` attribute
  ([VIEW.scriptFile](https://learn.microsoft.com/fr-fr/windows/win32/wmp/view-scriptfile)).
  11/195 skins rely on it (e.g. `PowerToys.wmz`, `cyberchannel.wmz`, `Kids.wmz`).
- **Zip entry names:** no backslashes in entry names; 2 archives have subdirectory
  entries (the `RESOURCE.FRK/` ones). 2 skins reference `pl\pl_dropdown_wood.png`
  with a backslash path (`TripleX for XP.wmz`, `TripleX for 7.1.wmz`); that file
  is absent anyway.
- **Dead art:** 151/195 (77%) skins contain images no `.wms` attribute references
  (some may be set from script at runtime, which I did not trace).

## 2. Well-formedness and encoding

### 2.1 Encodings of the `.wms`

| Encoding | Distinct [raw] |
| --- | --- |
| UTF-16 LE with BOM (`FF FE`) | 72 [120] |
| UTF-8 with BOM | 10 [19] |
| 7-bit ASCII only | 27 [44] |
| Non-ASCII with no BOM -> decodes only as cp1252 | 86 [159] |
| UTF-16 BE, UTF-8 without BOM, undefined cp1252 bytes (0x81 0x8D 0x8F 0x90 0x9D) | 0 [0] |

- No `.wms` has an `<?xml ...?>` declaration (0/342), so there is no declared
  encoding to disagree with the BOM. Detection rule that covers everything: BOM
  sniff, else ASCII, else cp1252 (never UTF-8-without-BOM in this corpus).
- Line endings: 340/342 CRLF, 2 LF-only; no bare CR.
- Leading whitespace or a blank line before the root: 10/195 [14/342]
  (`Sports.wmz/saltmine.wms:1`, `Ginger_man.wmz`, `QuickSilver.wmz`, ...). Most
  files begin with an XML comment (copyright), which is fine; a blank line
  before a hypothetical XML declaration would not be.
- The same BOM sniff applies to `.js`: 219 script files are ASCII 84, cp1252 74,
  UTF-16 61 (distinct-skin files). Headspace's `headspace.js` is cp1252
  (`/*\r ©2000 Microsoft...`).

### 2.2 Does `.wms` parse as XML as-is?

Parsed with expat after encoding detection (overriding any declaration).

| Result | Distinct [raw] |
| --- | --- |
| Well-formed as-is | **116/195 (59%)** [200/342 (58%)] |
| Not well-formed | 79/195 (41%) [142/342] |

Failure classes (skins with at least one instance; one skin can have several):

| Class | Distinct [raw] | First-error in expat terms |
| --- | --- | --- |
| Duplicate attribute on one element (case-sensitive exact duplicate) | 67 [123] | "duplicate attribute" is the first error for 55 [102] |
| Missing whitespace between attributes (`a="1"b="2"`) | 22 [39] | "not well-formed (invalid token)": first error for 17 [30] |
| End tag differs from start tag only in case (`<Buttongroup>...</buttongroup>`) | 12 [19] | "mismatched tag": first error for 7 [10] |
| Duplicate attribute differing only in case (`toolTip` + `tooltip`) | 8 [16] | parses fine as XML (distinct names); a semantic duplicate |
| Junk after the root close tag | 1 [1] (`howarduniversity__MotherLand.wmz`) | masked by an earlier duplicate-attribute error |

Duplicate attributes dominate. Of the 454 exact-duplicate occurrences in the
distinct set, 155 repeat the same value and **299 conflict**. Top attribute
names: `toolTip` 209, `max` 37, `transparencyColor` 36, `borderSize` 35, `min` 29,
`visible` 13, `zIndex` 12. Every sampled conflict reads as "the second value is the
author's intent": `Secura.wmz/e-monee.wms:261,269` `max="100"` then
`max="wmpprop:player.currentmedia.duration"`; `Nautical.wms:251` `borderSize="0"`
then `"15"`; `Jewel.wmz/jewel.wms:94` `fontStyle="normal"` then `"bold"`. That
suggests **last wins**, but this is an inference, not verified against real WMP.

### 2.3 Repair ladder (cumulative, each level re-parsed with expat)

| Level | Fix added | Parses, distinct [raw] |
| --- | --- | --- |
| L0 | none | 116 [200] |
| L1 | escape bare `&` / `<` inside attribute values | 116 [200] (no gain) |
| L2 | + quote unquoted attribute values, escape bare `&` in text | 116 [200] (no gain) |
| L3 | + drop later exact-duplicate attributes | 163 [287] |
| L4 | + insert missing whitespace between attributes, fix end-tag case to match start tag, discard junk after root | **195/195 [342/342]** |

L1 and L2 are no-ops: the standard "unescaped `&` in JScript attribute" failure
the task anticipated does not occur here. An independent grep for `&` not
followed by a valid entity finds 45 hits across all 342 decoded files, every one
inside an XML comment (legal), e.g. `Asimov_Radio.wmz/MediaBay.wms:33` `<!-- Head & Radio subview -->`.

Entities actually used (raw counts over all 342 decoded `.wms` files): `&amp;` 144,
`&gt;` 63, numeric 26, `&lt;` 15, `&quot;` 8. Handlers like
`PowerToys.wmz/PowerToys.wms:8` (`ontimer="t1.value=&quot;LIBRARY ACCESS ... \r...`)
need entity decoding *before* the JS engine sees the text.

Things that never occur: unquoted attribute values, valueless attributes, `--`
inside comments, unterminated comments, DOCTYPE, control characters, BOM
conflicts.

### 2.4 Parser rules this implies

1. Tokenize with a tolerant hand-written scanner, not a strict XML parser.
2. Fold case for tag names, attribute names and end-tag matching.
3. Accept `name ="v"` / `name = "v"` / tab-separated spacing (`Portals.wms:11-17`
   puts tabs around every `=`) and `a="1"b="2"`.
4. Duplicate attributes: keep both, apply last-wins (flag as a diagnostic);
   treat case-only duplicates the same way (`robbie.wmz/robbie.wms:459`
   `upTooltip` + `upToolTip`).
5. Stop at the first root close tag; ignore trailing bytes
   (`MotherLand/mLand1.wms:150`: `</THEME>or = "#BA1925"`, then a second
   `</THEME>` at 167).
6. Decode the five predefined entities plus numeric references in values; do not
   require escaping in comments.
7. Ignore unknown tags and attributes (see G12).

## 3. Names, references and images

### 3.1 Case variants

Tag names (59 distinct lowercased names): 48 appear in more than one spelling.
106/195 skins (54%) contain at least one non-majority tag spelling; 1,834 of
22,110 tag occurrences (8.3%) are non-majority. 47/195 (24%) skins mix spellings
of the same tag inside one file. Dominant tag style per skin: lowercase 170,
ALL-CAPS 23, camelCase/mixed 2.

Attribute names (258 distinct): 111 appear in more than one spelling; 192/195
skins have a non-majority spelling; 8,205 of 164,866 occurrences (5.0%);
187/195 skins mix spellings internally. Examples (corpus-wide counts):

- `zIndex` 8,604 / `zindex` 298 / `ZINDEX` 5
- `backgroundImage` 6,192 / `backgroundimage` 626
- `onClick` 4,802 / `onclick` 732 / `OnClick` 44 / `ONCLICK` 16 / `onCLick` 2
- `upToolTip` 3,767 / `upTooltip` 399 / `uptooltip` 348 / `uptoolTip` 23
- `customslider` tag: `customSlider` 140 / `CustomSlider` 104 / `customslider` 65 / `CUSTOMSLIDER` 6

Host-object members in script show the same noise: 1,700 of 21,134 `player.` /
`view.` / `theme.` / `mediacenter.` / `event.` member references (8%) are in a
non-majority spelling, in 182/195 skins (`playState` 259, `PlayState` 82,
`playstate` 42, `Playstate` 28). The **object names themselves are always
lowercase** (`player`, `view`, `theme`, `mediacenter`, `event`: zero other
spellings). Element ids also resolve case-insensitively in script: 4 skins
(`Ice.wmz`: `Volume.toolTip` in `Script.js:402` vs `id="volume"` at `Ice.wms:44`).

### 3.2 File references

Collected from every attribute whose value ends in a known extension, plus
`scriptFile` (split on `;`), checked against the zip entry names.

| Property | Distinct [raw] |
| --- | --- |
| Skins with at least one reference whose case differs from the zip entry | **62/195 (32%)** [108/342] (716 refs [1,264]) |
| Skins with at least one reference that resolves to nothing (even case-folded) | 46/195 (24%) [84/342] (90 refs) |
| `scriptFile` list ending in a trailing `;` | 114/195 (58%) [210/342] |
| `scriptFile` naming a script that is not in the zip | 1 (`howarduniversity__buffaloSoldier1.wmz`, `mland.js`) |
| References via a backslash path | 2 |

The documented form is "file names ... delimited with semicolons. Leading and
following spaces and semicolons should not be present"
([VIEW.scriptFile](https://learn.microsoft.com/fr-fr/windows/win32/wmp/view-scriptfile));
more than half of real skins ignore that, so a trailing `;` must be tolerated.

Worst case-mismatch offenders: `compact.wmz` 42, `bluegrid.wmz` 68, `digitaldj.wmz`
56, `aoe.wmz` 35 (`aoe.wms:45` `Bass_SliderBG.bmp` vs zip entry
`bass_sliderbg.bmp`), `Plus! SlimLine.wmz` 120. Recurring missing files: the
pair `pl_dropdown.png` / `pl_dropdown_back.png` in ~12 skins of one family;
`resize.cur` in `Tomb Raider 2.wmz` and `Charlies_Angels_Full_Throttle.wmz`
(`TombRaider.wms:161` `cursor="resize.cur"`); `Blinx.wmz/blinx.wms:254`
`c_fight_link_no.png`. A missing image must render as nothing, not abort the
skin.

### 3.3 Image formats

Referenced from `.wms` attributes (distinct skins; files):

| Format | Skins using | Files in zips |
| --- | --- | --- |
| BMP | 109 | 3,946 (3,560 referenced) |
| GIF | 108 | 4,087 (3,474 referenced) |
| PNG | 73 | 7,366 (6,528 referenced) |
| JPG | 66 | 832 (450 referenced) |

Most common mixes: BMP only 57, BMP+GIF 34, GIF+JPG+PNG 30, PNG only 14,
JPG+PNG 13. All 16,231 image entries in the distinct set decode in PIL except the
9 `RESOURCE.FRK/` fork files.

- **Alpha PNG** (colour type 4/6): 61/195 (31%) skins, 2,205 referenced files.
  Another 43/195 (22%) skins reference palette/RGB PNGs carrying a `tRNS` chunk.
  PIL modes seen: PNG RGBA 2,557, RGB 3,254, P 1,554.
- **Alpha PNG on an element that also sets `transparencyColor`:** 58/195 (30%).
  Example: `Blinx.wmz/blinx.wms:87` `backgroundImage="f_top_left.png"
  transparencyColor="#ff00ff"`, where `f_top_left.png` is RGBA 375x255. The
  precedence rule (alpha vs colour key) is unverified (open question).
- **Colour-key PNG without alpha:** `Blinx.wmz/blinx.wms:17` `main_back.png` is
  RGB 393x285 keyed with magenta, so even PNG skins rely on colour-keying.
- **Palette BMPs** 729 (PIL mode P), 24-bit RGB 3,187; BMP bit depths among
  referenced files: 24 bpp 2,902, 8 bpp 587, 4 bpp 66, 1 bpp 3. No 16- or 32-bit.
  **RLE-compressed BMPs** are referenced by 15/195 (8%) skins (`compact.wmz` 35,
  `Revert.wmz` 21, `gadget.wmz` 19, `pharaoh.wmz` 18). A BMP decoder must do RLE8/RLE4.
- **Multi-frame GIF:** 1,569 files in 86/195 (44%) skins, max 145 frames; 207
  carry the NETSCAPE loop extension. Whether WMP animates them in each context is
  unverified (open question).
- **Extension does not match content:** `Nautical.wmz` `vol_slider.bmp` is a GIF
  (9494x144) and `drawer.bmp` is a JPEG. Decode by magic number, never by
  extension. (Unreferenced files with the same problem may exist; PIL also
  recognised 3 `PSD` files among files named `.bmp/.jpg/.png`.)
- One 2528x3300 BMP (`Raptor.wmz/sktechsd.bmp`, unreferenced) is the only image
  over 1500x1500.
- **Cursor files:** `cursor=` is `hand` (1,999 uses) or a system name
  (`sizenwse` 145, `system` 79, `sizewe`...) or a file (`resize.cur` 26,
  `over.ani` 23, `sizetopright.cur` 12). Across all 342 archives there are 42 `.cur` and 4 `.ani` files.

## 4. Feature census

Skins having at least one occurrence (distinct, of 195) [raw, of 342].

| Feature | Distinct | % | [Raw] |
| --- | --- | --- | --- |
| `transparencyColor` | 187 | 96% | [333] |
| `backgroundColor="none"` | 186 | 95% | [330] |
| `wmpprop:` binding | 189 | 97% | [334] |
| `*_onchange` handler attribute | 188 | 96% | [333] |
| `slider` | 177 | 91% | [313] |
| `effects` (visualization pane) | 179 | 92% | [316] |
| `video` | 179 | 92% | [315] |
| `buttongroup` + `mappingImage` | 174 | 89% | [303] |
| `playlist` | 173 | 89% | [301] |
| `equalizerSettings` | 171 | 88% | [304] |
| `text` | 181 | 93% | [323] |
| `wmpenabled:` binding | 140 | 72% | [248] |
| `clippingColor` | 120 | 62% | [210] |
| `sticky` | 112 | 57% | [198] |
| `scrolling` | 102 | 52% | [175] |
| `videoSettings` | 90 | 46% | [158] |
| `backgroundTiled` | 90 | 46% | [157] |
| `minWidth`/`maxWidth`-family | 88 | 45% | [151] |
| `resizable="true"` | 85 | 44% | [147] |
| `customslider` (always with `positionImage`) | 84 | 43% | [149] |
| `passThrough` | 79 | 41% | [137] |
| `timerInterval` | 80 | 41% | [141] |
| `onTimer` | 86 | 44% | [153] |
| `onKeyDown/Press/Up` | 75 | 38% | [125] |
| `alphaBlend` attribute | 33 | 17% | [52] |
| `clippingImage` | 36 | 18% | [63] |
| `wmpEffects`/`wmpVideo` tag variants | 8 / 15 | 4% / 8% | [12 / 32] |
| `editbox` | 5 | 3% | [5] |
| `automenu` | 4 | 2% | [8] |
| `listbox` | 4 | 2% | [4] |
| `popup` | 3 | 2% | [6] |
| `titleBar="true"` | 0 | 0% | [0] |
| `keycode` attribute | 0 | 0% | [0] (key codes come from `event.keyCode`, 72 skins) |

Notes on the feature rows:

- **clippingImage vs clippingColor:** `clippingImage` never appears without
  `clippingColor` on the same element (36 of 36). `clippingColor` alone: 84;
  both: 36; neither: 75. Headspace is the "colour only" form
  (`headspace.wms:19` `clippingColor="#FF0000"` on the head subview, together with
  `transparencyColor`). `clippingImage` also sits on small button elements as a
  hit-test mask equal to the button's own image (`Atomic.wmz/atomic.wms:133-135`,
  `image="next.gif"` and `clippingimage="next.gif"`) and on whole views as a mask
  GIF (`portals.wmz/Portals.wms:41-42`, `clippingImage="mode2_main_mask.gif"`
  with `clippingColor="#FF00FF"`).
- **alphaBlend:** the attribute is mostly an initial-hidden value. Of its values,
  `0` appears 836 times, `255` 21, `wmpprop:videoResetButton.alphaBlend` 12
  and a few mid values. The real use is script-driven crossfades:
  `alphaBlendTo(...)` is called in 37 skins (622 calls) with an
  `onEndAlphaBlend` event (`xsn_sports.wmz/xsn.wms:62-65`,
  `xsn.js:14`). One skin, `xsn_sports`, has 316 `alphaBlend` attributes.
- **customslider:** `image` + `positionImage` (a greyscale map where pixel value
  encodes the slider position; `Portals.wms:712-731`, `Ice.wms:44`). 84 skins.
- **Timers:** `timerInterval` + `onTimer` in 79 skins; 49 skins also reference
  `view.timerInterval` from script; `timerInterval="0"` stops it
  (`9SeriesDefault.wmz/Corona.wms:873`). `setTimeout` appears in 2 skins,
  `setInterval` in none.
- **Video:** `<video>` appears in 92%; the common wiring is `onVideoStart` /
  `onVideoEnd` toggling visibility of the visualization pane
  (`headspace.wms:127`, `headspace.js:39,54` `StartVideo`/`EndVideo`).
- **popup / automenu / listbox / editbox** are rare (2-3% each) and are
  host-populated widgets: `Revert.wmz/netgen.wms:26` `<automenu id="menu"/>`
  (opened with `menu.show('Play')`), `netgen.wms:327` `<POPUP id="mnuEQSelect"
  selectedItem_onchange=...>`; `9SeriesDefault.wmz/Corona.wms:295` `<POPUP
  id="popupPreset" ...>` populated from `eq.currentPreset`. No items are declared
  in the skin.

## 5. Scripting surface

### 5.1 Volume

- 180/195 (92%) skins have a `scriptFile` attribute; 5 have no script file at all.
  scriptFile attributes per skin: 0:15, 1:95, 2:12, 3:7, 4:14, 5:17, 6:16, 7:9, 8:6, 9:4.
- 167 skins have exactly one `.js` in the zip, 21 have two, 1 has three, 1
  (`digitaldj.wmz`) has seven (3,938 lines).
- Script size: median 342 lines, p90 1,028, max 3,938.
- 12,868 inline handler attributes in the distinct set (`onClick` 5,596,
  `value_onchange` 2,128, `onLoad` 539, `onKeyDown` 386, ...).
  129 are empty strings (`onClick=""`).
- 85/195 (44%) of skins attach scripts to more than one view. In multi-view skins:
  65 load the same script set in every view, 10 only on the first view, 8 distinct
  per view, 8 mixed, 11 leave some views script-less.

### 5.2 Syntax

I compiled every `.js` (219) and every handler attribute (12,868, entity-decoded)
with node `vm.Script` in sloppy mode: **0 script files fail** and **5
handlers fail**, all one skin's typo (`supersoni__Faith Hill.wmz/faithhill.wms:14-15`,
`tracktitle.value=jscript:player.currentmedia...` is a label expression, not
valid). No `with`, `ActiveXObject`, `Enumerator`, `setInterval`, `@cc_on`,
`getElementById`, `alert`, or `eventobj` appears in any skin. (The two scripts with
uppercase `.JS` extensions, in `TEDDY` and `sankofa skin`, were compiled separately
and are excluded from the snippet-based API/eval/case tallies in sections 3.1, 5.3
and 5.4; that is 2 of 195 skins.) `try`/`catch` is in
12 skins, `new Date` in 4, `Math.random` in 2, `.item(i)` collection access in 24,
`eval(...)` in **57/195 (29%)**, 299 call sites. `switch` is in 132 skins. A stock
ES engine is sufficient syntactically; Microsoft's own doc says scripts should
not assume anything newer than JScript 4.0
([Using JScript](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/using-jscript)).

### 5.3 Host-model behaviours the corpus depends on

Each is measured; examples are in section 7.

- **Element ids are script globals.** 190/195 skins reference an id as a bare
  identifier (`pl.setColumnResizeMode`, `vid.visible`, `sEqEar.moveto` in
  `headspace.js`); 5,950 of 12,781 declared ids are referenced that way. ids
  repeat inside one view in 30 skins and across views in 41 (view-scoped).
- **Handlers run with the owning element's properties in scope.**
  `value_onchange="player.settings.volume=value;"`, `onclick="player.settings.mute=down;"`,
  `onClick="previous()"` (a method of the element itself), `StartAction(this)`.
  2,577 of 12,868 handlers (20%) in 183/195 skins use a bare element property
  (crude regex, so an upper bound).
- **Three handler spellings:** plain script, script prefixed `jscript:`
  (1,756 handlers in 139 skins, e.g. `onTimer="JScript:OnTimerTransport();"`), and
  handlers on non-`on*` attribute names for host events (`<player
  modeChange="...">`, `<controls currentPosition_onchange=...>`).
- **Attribute values with `jscript:` / `wmpprop:` / `wmpenabled:` prefixes.**
  `jscript:` on `left/top/width/height` in 147 skins (6,751 attributes; chained
  off other elements: `left="jscript:bass.left+2;"`); `wmpprop:` live bindings
  for `value`, `max`, `down`, `enabled`, `visible`, `currentEffectType`,
  `foregroundProgress`, `enableSplineTension`; `wmpenabled:` for
  `visible`/`enabled`/`tabStop`/`down`. Prefix typos exist in 18 skins
  (`wmppprop:`, `wmpenable:`, `wmpdisabled:`).
- **Host members are case-insensitive** (section 3.1).
- **`theme.loadPreference` returns the string `"--"` for an unset key**: 83 of 94
  preference-using skins test `"--" != x` (`Blinx.wmz/blinx.js:273`,
  `Ice.wmz/Script.js:72`). Stored values are strings (1,099 literal strings, 15
  numbers, 559 expressions). Open/closed state of views is persisted as
  `"true"`/`"false"` keys (`blinx.js:263` `theme.savePreference(id, "false")`;
  `Ice.wmz/Script.js:27,37` `loadPreference("plViewer")`).
- **Numeric enum values leak into scripts:** `switch (player.playState) { case 3:`
  (`blinx.js:68-70`); 81 skins compare `playState` to a numeric literal, so
  `playState`/`openState` must be integers matching `WMPPlayState`/`WMPOpenState`
  (`wmppsPlaying = 3`; `wmposMediaOpen = 13`).
- **Views are independent top-level units that coexist**, each with its own
  `onLoad`/`onClose`, `view` bound to the owning view, and shared `theme`/`player`
  (`Blinx.wmz`: `mainView`, `plView`, `eqView`, `videoView`, `infoView`;
  `theme.openView('videoView')` at `blinx.js:72`;
  `view.close()` at `blinx.js:267`). That reads as separate windows; confirm
  against the owner's expectations (open question).
- **Views start from an image, not a size.** 73 of 577 views have no
  width+height; 52 of those have a `backgroundImage`, which presumably supplies the
  size (`Miniplayer.wmz/miniplayer.wms:9-16`); 41 skins have an unsized *first* view.
  Theme-level `currentViewID` picks the start view in 16 skins and it need not be
  the first view in the file (`portals.wmz/Portals.wms:6` `currentViewID="mode1"`
  while `mode2` is declared first at :10 and `mode1` at :574).

### 5.4 Host API surface actually used (distinct skins)

Properties (top): `player.currentMedia` 178, `player.settings` 177,
`player.controls` 174, `view.close` 175, `view.minimize` 172,
`view.returnToMediaCenter` 169, `player.openState` 165, `player.playState` 132,
`player.launchURL` 131, `mediacenter.effectType` / `effectPreset` 130,
`player.URL` 117, `theme.openDialog` 114, `view.height` 102, `view.width` 97,
`theme.loadPreference` / `savePreference` 94, `theme.openView` 89,
`view.size` 83, `player.status` 79, `theme.closeView` 78, `mediacenter.videoZoom`
78, `event.keyCode` 72, `theme.currentViewID` 48, `player.currentPlaylist` 44.
Rare: `player.mediaCollection` 15, `player.cdromCollection` 20,
`player.playlistCollection` 7, `player.dvd` 6, `theme.playSound` 16,
`theme.loadString` 3.

Methods on elements/host (calls, skins): `moveTo(x,y,ms)` 1,217 calls in 134
skins (animated move with `onEndMove`), `alphaBlendTo(a,ms)` 622 in 37,
`setColumnResizeMode` 536 in 148 (playlist), `getItemInfo` 409 in 137, `next`/
`previous` (host and visualizer), `isAvailable` 223 in 77, `view.size(edge)`
219 in 84 (window-resize drag handle: `TombRaider.wms:161`
`onMouseDown="view.size('bottomright')"`), `setMode`/`getMode` (shuffle/repeat)
174/119, `nextPreset`/`previousPreset` ~100, `theme.openDialog` 164 in 114,
`appendItem` 39 in 17, `playSound` 51 in 16, `search` 27 in 10.

MPD relevance: most of `player.currentMedia.getItemInfo(...)`,
`player.controls.*`, `player.settings.volume/mute/balance`, `eq.gainLevelN`,
`mediacenter.effectType/Preset` and `player.currentPlaylist`/playlist element have a
natural MPD or app mapping; `mediaCollection`, `cdromCollection`, `dvd`,
`network`, `openDialog`, `launchURL`, `returnToMediaCenter` need an explicit
stub or policy.

### 5.5 The shared built-in script `res://wmploc.dll/RT_TEXT/#132`

133 of the 180 skins that carry a `scriptFile` mention it, spelled variously:
`res://wmploc.dll/RT_TEXT/#132;` (trailing `;`, 2000 revision),
`res://wmploc/RT_TEXT/#132` (no `.dll`, owner's Headspace,
`headspace.wms:12`), lower-case `rt_text`. 239 occurrences in total. Different shapes also exist: `res://-/RT_TEXT/#169`
(`Revert.wmz/netgen.wms:14`, the `-` meaning "current module") and dozens of
`res://-/RT_STRING/#NNNN` / `res://wmploc/RT_STRING/#NNNN` localized-string
references used as tooltips and accessibility text
(`netgen.wms:38` `toolTip="res://-/RT_STRING/#1809"`). Only 6/195 skins
reference a `res://` target other than `RT_TEXT/#132`.

What does #132 contain? I cannot read the DLL. Empirical reconstruction:

- Functions called but never defined in the skin do **not** concentrate on a
  shared name set (the highest count is 11 skins calling `previous`, which are
  element methods), so #132 is not a utility-function library.
- Free **enum constants** are the strong signal. `osMediaOpen` is used as a bare
  identifier in **106 skins; 104 of them load #132** (`headspace.js:28`
  `player.OpenState == osMediaOpen`, `miniplayer.js:7`). `psPlaying` 41 skins (39
  load #132), `psStopped` 33, `psPaused` 29, `psUndefined` 10, `osUndefined` 8,
  `psReady` 4, `osPlaylistLoading` 5, plus the rest of the family
  (`osMediaChanging`, `osBeginLicenseAcquisition`, `psReconnecting`, ...).
  Only 2 skins use them without loading #132 (`Kids.wmz`,
  `howarduniversity__UPRISING.WMZ`), and a few define their own `var psPlaying`.
- The names follow the public `WMPOpenState` / `WMPPlayState` enumerations with
  the `wmp` prefix dropped ([WMPOpenState](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/api/wmp/ne-wmp-wmpopenstate):
  `wmposUndefined = 0 ... wmposMediaOpen ... wmposOpeningUnknownURL`).
  By ordinal, `osMediaOpen` = 13. `WMPPlayState` runs `psUndefined`=0,
  `psStopped`=1, `psPaused`=2, `psPlaying`=3, `psScanForward`=4, `psScanReverse`=5,
  `psBuffering`=6, `psWaiting`=7, `psMediaEnded`=8, `psTransitioning`=9,
  `psReady`=10, `psReconnecting`=11 (matches the numeric `case 3: //playing` in
  `blinx.js`).

Minimum stub: define the `os*` and `ps*` constants (observed names listed
above; add the complete public enum). Whether #132 also contains other
globals is **unknown**; flag as a risk (section 8).

One residual signal: five function names are called but never defined, and are
called **only** by skins that load #132 (skins loading #132 / skins not loading
it): `updateMetadata` 7/0, `onCloseVideo` 6/0, `detplay` 6/0, `ZoomVideo` 5/0,
`EndVideo` 4/0. The likeliest explanation is one template family with dead
handler paths, but #132 defining a few video helpers cannot be ruled out. These
are the names to watch for as runtime `ReferenceError`s.

## 6. Fixture ladder

Ten rungs, ordered by what each one forces the engine to learn. All were
unzipped to `/tmp/fixtures/<Name>/` (ephemeral; re-create with
`unzip -q skins/wmp/<file>.wmz -d /tmp/fixtures/<Name>` and, for the three
corrupt-header archives, patch bytes 0-3 to `PK\3\4` first). Counts are from the
primary `.wms`. Skin art is third-party; fixtures stay outside tracked paths.

| Rung | Skin | Zip / wms | Views | Elements | Script | New things it forces |
| --- | --- | --- | --- | --- | --- | --- |
| R0 | Headspace (owner's) | 242 KB / 44 KB (UTF-16) | 1 | 69 | 147 lines | the oracle |
| R1 | Miniplayer | 49 KB / 5 KB | 1 | 17 | 27 lines | `wmpprop:` bindings, view-from-image, handlers with implicit element scope, slider+buttongroup |
| R2 | aoe | 135 KB / 8 KB | 1 | 35 | 119 lines | `jscript:` layout chains, case-mismatched refs, RLE BMPs, tag variants, `equalizerSettings` |
| R3 | PowerToys | 266 KB / 6 KB | 3 | 28 | 228 lines | multi-view `openView`, implicit `<stem>.js`, dup ids across views, `this`, `eval`, timer |
| R4 | Revert | 67 KB / 60 KB | 3 | 79 | 346 lines | `automenu` + `popup`, `res://` strings and `#169`, event attrs without `on`, `savePreference` |
| R5 | Atomic (`microsoft__Atomic`) | 198 KB / 42 KB | 2 | 77 | 301+81 lines | `clippingImage` buttons, per-view scripts, `savePreference`/`openView`, animated GIFs |
| R6 | Blinx | 1.4 MB / 49 KB | 5 | 140 | 580 lines | template family (23 skins), 5 coexisting views, alpha PNG + colour key, alignment layout, preferences |
| R7 | 9SeriesDefault | 224 KB / 74 KB | 2 | 124 | 1,199 lines (3 files) | Microsoft's own resizable default skin: multi-script views, `JScript:` handlers, `res://` x43, `eval`, `popup` |
| R8 | portals | 845 KB / 31 KB | 2 | 122 | 656 lines (2 files) | `customslider` x12, `clippingImage` x14 on views, animated GIFs, `currentViewID`, prefs |
| R9 | xsn_sports | 2.9 MB / 189 KB | 8 | 556 | 1,942 lines | `alphaBlend` x316 crossfades, 424 subviews, `customSlider` x19, alpha PNG x24, 31 key handlers, `eval`, 50 preference calls |

### R0. Headspace (owner's) - `~/Downloads/Headspace.wmz`

- 82 entries; `headspace.wms` is UTF-16LE with BOM (44,092 bytes, 22,045 chars);
  `headspace.js` is cp1252 (3,590 bytes, 147 lines). One `<view>` 760x394 with
  no `id`, `backgroundColor="none"`, 23 subviews, 69 elements, no timers, no
  preferences, no `openView`. It is a **single view that grows**:
  `view.width = widthOpened` at `headspace.js:96` (`TogglePlView`, :83) widens the
  window to reveal the right drawer and `view.width = widthClosed` (:130) narrows it.
- Features: `buttongroup` + `mappingImage` (2, `headspace.wms:23`), `pausebutton`
  visible via `wmpenabled:` (:64), 13 sliders (vertical EQ, volume, balance, seek)
  with `direction`, `<equalizerSettings enableSplineTension="true"/>` (:285),
  `<video>` (:127), `<effects>` (:121) bound to `mediacenter` effect type, a
  `<playlist>`.
- Runtime properties written from script: `.image/.hoverImage/.downImage`,
  `.upToolTip`, `.visible`, `view.width`, `moveto(x, y, speed)` with
  `onEndMove="EqOnEndMove();"` (`headspace.wms:183`), chained assignment
  `vidIsPlaying = vid.visible = false`, `pl.setColumnResizeMode(0, "Stretches")`.
  Elements double as data holders (`bEq.upToolTip = ... xEqTt.toolTip`).
- 25 `jscript:` attributes (`headspace.wms:268-269` `left="jscript:balance.left+balance.width+10;"`,
  `top="jscript:balance.top;"`, `:279`), 18 `wmpprop:`, 2 `wmpenabled:`
  (`:50` `tabStop="wmpenabled:player.controls.play"`).
- Uses `osMediaOpen` from #132 (`headspace.js:28`) and mixed-case host members
  (`player.OpenState`, `player.currentMedia.ImageSourceWidth`, :28-29).
- `scriptFile="headspace.js;res://wmploc/RT_TEXT/#132"` (:12), no trailing `;`.
- Gotcha: `skins/wmp/Headspace.wmz` is the 2000 revision (`theme id="headspace"`,
  `titleBar="false"`/`resizable="false"` repeated on subviews, `fontType`,
  `<equalizerSettings enable="true">`, no `wmpprop:` on effects, a
  `;`-terminated #132 spelling); the owner's file is 2001. Test against the
  owner's.

### R1. Miniplayer - `skins/wmp/Miniplayer.wmz` (= `microsoft__Miniplayer.wmz`)

- 40 entries, all BMP; `miniplayer.wms` (5,372 bytes, cp1252) + `miniplayer.js`
  (27 lines). 17 elements, one view with **no width/height**: size comes from
  `backgroundImage="mini_background.bmp"` and `transparencyColor` on the view
  itself (`miniplayer.wms:9-16`).
- Features: scrolling `<text>` bound to script, `<text value="wmpprop:player.controls.currentPositionString">`
  (:30), `buttongroup` min/close (:34), seek slider with `foregroundImage` +
  `useForegroundProgress` + `foregroundProgress="wmpprop:player.network.downloadProgress"`
  (:53-69), `playbutton`/`pausebutton`/`stopbutton`/`prevbutton`/`nextbutton`
  specialised tags, a sticky mute button bound to `down="wmpprop:player.settings.mute"`
  with `onclick="player.settings.mute=down;"` (:104-105).
- Gotchas: `value` and `down` in handlers resolve against the element
  (:65, :105, :118); `player.Controls.currentPosition` inside a binding with a
  capital C (:64); `getiteminfo` lower-case in script (`miniplayer.js:16`);
  `view.returnToMediaCenter()` (:146); `osMediaOpen` (`miniplayer.js:7`).
- Best first non-Headspace target: no multi-view, no timers, no layout expressions.

### R2. aoe (Age of Mythology, `skins/wmp/aoe.wmz` = `microsoft__aoe.wmz`)

- 33 entries; `aoe.wms` 7.8 KB, `aoe.js` 119 lines. 1 view, 35 elements, one subview.
- Features: `jscript:` chains (`aoe.wms:57-58` `left="jscript:bass.left+2;"`,
  `top="jscript:bass.top-15;"`, :65-66 `bass.top+bass.height+15;`, :86-87), three
  `buttongroup`s, `<equalizerSettings id="eq" enabled="true">`, specialised tags
  `<itemsPlaylist>` (:28), `<volumeSlider>` (:85), `<returnButton>` (:131).
- Gotchas: **35 file references differ in case from the zip entries** (e.g.
  `:45` `Bass_SliderBG.bmp` vs `bass_sliderbg.bmp`); **13 RLE-compressed BMPs**;
  `onClick="previous()"` on `<effects>` (:25) is a bare method of the element
  itself; `scriptFile="aoe.js;res://wmploc.dll/RT_TEXT/#132"` with no trailing `;`
  (:15); the `jscript:` values end in `;` (`"jscript:bass.left+2;"`).

### R3. PowerToys - `skins/wmp/PowerToys.wmz` (= `microsoft__PowerToys.wmz`)

- 7 entries only; `PowerToys.wms` 6 KB, `PowerToys.js` 228 lines **auto-loaded
  by stem, with no `scriptFile` attribute**. 3 views, 28 elements, 9 subviews.
- Features: first `<view>` has no id and runs a timer-driven probe
  (`ontimer="t1.value=&quot;LIBRARY ACCESS IS DISABLED\r...`, `timerInterval="900"`);
  `theme.openView('AlertDialog')` (:96); `player.mediaCollection` use; `eval` (2).
- Gotchas: `id="t1"` is declared in two different views (`PowerToys.wms:16`,
  `:40`), so ids are view-scoped; `onmousedown="StartAction(this);"` (:42) needs
  `this` = element; entity-escaped quotes and `\r` escapes inside a handler
  string; self-closing `<text ... />` / `<button ... />`; this skin needs the
  media library, which an MPD front-end does not have, so the interesting part is
  structure, not behaviour.

### R4. Revert - `skins/wmp/Revert.wmz` (a near-twin `Revert (1).wmz` differs slightly)

- 45 entries; `netgen.wms` is 60 KB for only 79 elements (very long handlers), 3
  views (`vwPlayer` 256x130 at :10, `vwEQ` :249, `vwPL` :574), `netgen.js` 346 lines.
- Features: `<automenu>` (:26), `<POPUP>` (:327), localized strings
  `toolTip="res://-/RT_STRING/#1809"` (:38), accessibility attributes
  `accName`, `accKeyboardShortcut`, script `res://-/RT_TEXT/#169` (:14),
  `stickyBorderWidth`, `theme.openViewRelative('vwEQ',0,130)` +
  `savePreference('vwEQ','true')` (`netgen.js:325`), `width="jscript:view.width-2*left"`
  (:30; an expression referencing the element's own `left`).
- Gotchas: event attributes without `on` and with parameters
  (`<PLAYER openstatechange="vwPlayer_OnOpenStateChange(NewState);" modeChange=...>`);
  `onTimer="jscript:if( timerinterval == 1000 ) { ctrlVis.alphablendto( 127, 250 ); ...}"`
  (:19, a `jscript:` handler with lower-cased host members and a bare
  `timerinterval` property); `&amp;` inside a URL in a handler (:25).
- This is the cleanest sample of the "WMP 8 / XP-era native-widget" dialect.

### R5. Atomic - `skins/wmp/microsoft__Atomic.wmz`

- 77 entries; `atomic.wms` 42 KB, `atomic1.js` 81 lines (main view) + `atomic.js`
  301 lines (second view). 2 views (`t` 440x160, `p2` resizable with `minwidth`),
  77 elements, 23 subviews.
- Features: **`clippingImage` on 12 tiny button subviews** (`atomic.wms:133-135`:
  `image="next.gif" clippingColor ="#FF00ff" clippingimage="next.gif"` with a
  space before `=`), hover-reveal via `onmouseover="n.visible=true"`, per-view
  scripts, `theme.savePreference('finalx', p2.width)` and `'x'` from
  `plbutton.down` (`atomic.js:63-65`), 4 `openView`, animated GIFs (2), 31
  `jscript:` attributes.
- Gotchas: `author = "Microsoft Corporation"` (spaces around `=`, :6); one of
  the three skins with whitespace-padded numeric attribute values.

### R6. Blinx - `skins/wmp/Blinx.wmz` (theskinsfactory family, 23 skins share the script)

- 96 entries, 1.4 MB; `blinx.wms` 49 KB, `blinx.js` 580 lines. 5 views
  (`mainView` 393x285, `plView`, `eqView`, `videoView`, `infoView`; resizable ones
  with `minWidth`/`minHeight`), 140 elements, 54 subviews, 12 alpha PNGs.
- Features: **alignment layout** instead of absolute numbers: frame pieces use
  `horizontalAlignment="stretch|right"`, `verticalAlignment="bottom|stretch"`,
  `backgroundTiled="true"` plus `jscript:view.height-76` (`blinx.wms:88-94`);
  `<video visible="false" onvideostart="theme.openView('videoView');">` (:15);
  `<controls currentPosition_onchange=...>` nested inside `<player>` (:12);
  `theme.savePreference/loadPreference` ("--" sentinel, `blinx.js:271-282`);
  `switch (player.playState) { case 3: ...` (`blinx.js:68-70`);
  `eval( button +".upToolTip = 'Hide " + tip + "'" )` (:188).
- Gotchas: `resizAble="true"` (`blinx.wms:82,151,215`, a garbled attribute name used on three
  views); `closeView('eqViewer')` at :126 passes an id that is not a view id (the
  script treats the string as a preference key); a missing file
  (`c_fight_link_no.png`, :254-255); `<view ... scriptFile="blinx.js">` repeated on
  every view means the same script is instantiated per view; `onClick="jscript:player.launchURL(...)"`.
- Highest leverage rung: the same code runs in 23 skins
  (`Back to the Future Trilogy`, `Crimson_Skies`, `Dreamcatcher`, `Frostbite`,
  `Ginger Man`, ...), so passing R6 buys roughly 12% of the distinct corpus.

### R7. 9SeriesDefault - `skins/wmp/9SeriesDefault.wmz` (= `microsoft__9SeriesDefault.wmz`)

- 119 entries; `Corona.wms` 74 KB (`THEME id="Corona"`), `Corona.js` 219 lines,
  `corona_tiny.js` 202, `metadata.js` 775. 2 views (`vPlayer` 859x468 resizable
  with `minWidth/minHeight`, `viewTiny` with `maxWidth/maxHeight`), 124 elements,
  33 subviews.
- Features: `scriptFile="Corona.js;metadata.js;res://wmploc.dll/RT_TEXT/#132"` (:18);
  `onTimer="JScript:OnTimerTransport();"` (:15) with `timerInterval="4000"`, and
  `timerInterval="0"` in the tiny view (:873); `<POPUP id="popupPreset"
  left="wmpprop:bPresetSelect.left" ...>` (:295: a `wmpprop:` binding to another
  element's property); 43 `res://` references; 66 `jscript:` attributes; `eval`
  9 times (`Corona.js:170-171` `eval("eq" + i + ".left = " + ...)`).
- This is the official reference of the late (WMP 9) dialect; 775 lines of
  metadata logic make it the best oracle for `getItemInfo`/`currentMedia`
  behaviour.

### R8. portals - `skins/wmp/portals.wmz` (theskinsfactory, 2001)

- 79 entries; `Portals.wms` 31 KB, `Portals.js` 203 + `Portals2.js` 453 lines
  (**one script per view**). 2 views (`mode2` 359x465 declared first, `mode1`
  550x400 start view via `<THEME currentViewID="mode1">` at :6), 122 elements.
- Features: **`customslider` x12** (`Portals.wms:712-731`: `left =
  "JScript:eqLeft+0"` where `eqLeft` is a script global, not an element
  property); **`clippingImage` x14** on views and buttons (:41-42 `clippingImage
  ="mode2_main_mask.gif"` + `clippingColor="#FF00FF"`, `image="mode2_main.jpg"`);
  19 multi-frame GIFs; 5 `savePreference` calls; `eval` 2.
- Gotchas: tab-and-space-padded attributes everywhere (`id 			= "mode2"`),
  `&amp;` inside an attribute (:4 `WEBPRO International &amp; The Pedestal ...`),
  `scriptFile="Portals2.js;res://wmploc.dll/RT_TEXT/#132;"`, `authorVersion` and
  `currentViewID` theme attributes, first-declared view is not the start view.

### R9. xsn_sports - `skins/wmp/xsn_sports.wmz` (theskinsfactory, 2003)

- 219 entries, 2.9 MB; `xsn.wms` 189 KB, `xsn.js` 1,942 lines. 8 views, 556
  elements, **424 subviews**, 316 `alphaBlend` attributes, 19 `customSlider`, 24
  alpha PNGs, 31 key handlers, 50 `savePreference`, 14 `eval`, 306 `jscript:`
  attributes.
- Features: stacked crossfade layers (`xsn.wms:62-65`
  `alphaBlend="255"` then `alphaBlend="0" ... onEndAlphaBlend="htcpCheck()"`),
  script-driven `alphaBlendTo(255,500)` (`xsn.js:14`) and
  `eval( win + x + "_" + num + ".alphaBlendTo(" + blend + "," + speed + ");" )`
  (`xsn.js:541`); a first "splash" view `versionView` with no size and a
  version check (`xsn.wms:12-13`, `onload="checkPlayerVersion();"`);
  9-patch frame subviews with stretch alignment; per-view timers (500 ms).
- Gotchas: this is the stress rung: ids are dynamic (`pl1_1`...); `resizAble`;
  missing files (2). Treat it as a performance and layering test, not a
  correctness milestone.

### 6.1 Negative-test pack (robustness, not difficulty)

Supplementary, independent of the ladder; each is a one-feature trap:

| Skin | Trap |
| --- | --- |
| `Ice.wmz` (`Ice.wms`) | 15 duplicate attrs with conflicting `toolTip` (`Ice.wms:144-149`, `toolTip="Equaliser Adjustment"` then `"31hz"`), `top ="59"` spacing, 3 missing-whitespace spots (:21, :28), `zIndex="99"backgroundimage=`, id used in script with different case (`Volume` vs `volume`), `Script.js` vs `script.js`, whitespace-padded numerics, 1 missing image |
| `Nautical.wmz` | two `.wms` (pick `Nautical.wms`), 10 duplicate attrs (`:251` `borderSize` 0 then 15), missing whitespace (:382), `vol_slider.bmp` is a GIF and `drawer.bmp` a JPEG, animated GIF, `nautical.js` vs `Nautical.js` |
| `Sports.wmz` | two `.wms`; the larger one (`saltmine.wms`) has 65 unresolved refs; `saltmine.wms:6` `width="600 "`; leading blank line (`saltmine.wms:1`) |
| `howarduniversity__MotherLand.wmz` | junk after root (`mLand1.wms:150` `</THEME>or = "#BA1925"`), 2 views |
| `howarduniversity__TEDDY.WMZ` | uppercase extension, `RESOURCE.FRK/*.BMP` fork junk, 3 case mismatches |
| `SplinterCellWMPSkin.wmz` | corrupt first local header (zip unreadable until bytes 0-3 are patched), missing whitespace (`sc.wms:257`), 6 views, 84 `jscript:` attrs |

Larger robustness extras (not on the ladder): `digitaldj.wmz` (7 script files,
3,938 lines, 26 key handlers, 56 case-mismatched refs, 190 `jscript:`
attributes, script-implemented widgets in `listbox.js`/`edit.js`/`checkbox.js`), `compact.wmz`
(= `microsoft__Compact.wmz`; 35 RLE BMPs, 42 case mismatches, `alphaBlend` x12,
5 `res://` targets other than #132), `howarduniversity__Lockskin.wmz` (10 elements, no script,
`clippingImage`: the smallest possible skin).

## 7. Gotcha catalogue

Each entry: what breaks, where it occurs, a short quote, and what the
runtime must do. `D` = distinct skins affected.

**G1. Strict XML rejects 41% of skins.** D=79. Duplicate attributes, missing
whitespace, end-tag case, junk after root (section 2). Needs the tolerant scanner
of section 2.4.

**G2. Duplicate attributes with conflicting values.** D=67 (299 conflicting
occurrences). `Ice.wmz/Ice.wms:144` `toolTip="Equaliser Adjustment" ... toolTip="31hz"`;
`Secura.wmz/e-monee.wms:261,269` `max="100"` ... `max="wmpprop:player.currentmedia.duration"`.
Keep the last; log a diagnostic.

**G3. No whitespace between attributes.** D=22. `Military.wmz/military.wms:122`
`cursor="hand"onClick="player.controls.previous();"`; `Main_Street.wmz/Main Street.wms:84`
`zIndex="8"backgroundImage="vidadjbg.bmp"`; `Primitive.wmz/skin2.wms:3`
`scriptFile="skin.js;res://wmploc.dll/RT_TEXT/#132;"titleBar="false"`.

**G4. End tag differs in case.** D=12. `Primitive.wmz/skin2.wms:44`
`<Buttongroup ...>` closed by `</buttongroup>` at :47; `Science.wmz/science.wms:6`
`<theme` closed by `</THEME>` at :284.

**G5. Junk after the root.** D=1. `MotherLand/mLand1.wms:150` `</THEME>or = "#BA1925"`
(editor leftover; a second `</THEME>` at :167). Stop at the first `</THEME>`.

**G6. Case-insensitive names everywhere.** Tags (106 skins), attributes (192),
host members (182), ids (4), file names (62), `.WMZ`/`.JS`/`.BMP` extensions.
`Blinx.wmz/blinx.wms:82` `resizAble="true"` (a garbled attribute that may be
meant as `resizable`; unknown attribute: see G12).

**G7. File references that do not match the zip.** Case (62 skins), absent
(46), wrong extension content (1), fork junk (2).
`aoe.wms:45` `Bass_SliderBG.bmp` -> entry `bass_sliderbg.bmp`;
`blinx.wms:254` `c_fight_link_no.png` absent; `Nautical.wmz/vol_slider.bmp` is a
GIF. Build a case-folded index; decode by magic number; draw nothing on a miss.

**G8. Corrupt zip, multi-`.wms`, implicit script.** `SplinterCell` first header
`01 00 01 00`; `Nautical.wmz` two `.wms`; `PowerToys.wmz` loads `PowerToys.js`
without a `scriptFile` attribute (and `Kids.wmz`, `cyberchannel.wmz`...).

**G9. `scriptFile` is a `;` list, often with a trailing `;`, and may name
resources.** D=114 with trailing `;`.
`Headspace(owner)/headspace.wms:12` `headspace.js;res://wmploc/RT_TEXT/#132` (no
`;`), `Portals.wms:16` `Portals2.js;res://wmploc.dll/RT_TEXT/#132;`,
`Corona.wms:18` three entries, `Revert/netgen.wms:14` `res://-/RT_TEXT/#169`.

**G10. `res://` resources with several spellings.** `res://wmploc.dll/RT_TEXT/#132`,
`res://wmploc/RT_TEXT/#132`, `res://-/RT_TEXT/#169`, `res://-/RT_STRING/#1809`
(tooltip text), `res://wmploc/rt_bitmap/#521`. Resolve the module spelling
case-insensitively, strip `.dll`, treat `-` as the current module; stub
`RT_STRING` lookups (`theme.loadString` is also used).

**G11. Free enum constants supplied by #132.** `headspace.js:28`
`player.OpenState == osMediaOpen`; `miniplayer.js:7`. D=106 use `osMediaOpen`.
Define `os*`/`ps*` before running any script, with the public enum values
(`psPlaying`=3, `osMediaOpen`=13).

**G12. Unknown or misspelled attributes must be ignored.** 85 of 258 attribute
names occur in at most 2 skins; many are typos: `scrollingAmmount`
(`Age_of_Mythology_MP7/aom.wms:42`), `scrolingDelay`
(`BlueCrush_MP7/blue_crush.wms:39`), `resizAble`, `resizeable` (6 views),
`timerinteval`, `zindez`, `widht`, `visilble`, `tootip`, `on_resize`,
`transparancycolor`, `z-index`. Never fail the skin on an unknown attribute or
tag (rare tags: `currentMedia`, `currentPlaylist`, `dropDownPlaylist`,
`mediaCenter`, `trackNameText` in 1 skin each).

**G13. `jscript:` layout expressions.** D=147, 6,751 attributes. Forms:
`left="jscript:balance.left+balance.width+10;"` (`headspace.wms:268`, note the
trailing `;`), `top="jscript:view.height-76"` (`blinx.wms:89`),
`width="jscript:view.width-2*left"` (`netgen.wms:30`, references own `left`),
`left="JScript:eqLeft+0"` (`Portals.wms:715`, a script global), `jscript: equalizer1.top`
(whitespace after the colon). Expressions reference other elements, `view`,
script globals and the element's own properties; they must re-evaluate when a
dependency changes (view resize, `moveTo`). Whether evaluation is lazy or
eager is not specified by the corpus.

**G14. `wmpprop:` / `wmpenabled:` bindings.** D=189 / 140. `value="wmpprop:player.controls.currentPositionString"`
(`miniplayer.wms:30`), `visible="wmpenabled:player.controls.pause"`
(`headspace.wms:64`), `max="wmpprop:player.currentmedia.duration"`,
`left="wmpprop:bPresetSelect.left"` (`Corona.wms:295`: bound to another element),
`visible="wmpprop:seek.enabled"` (`netgen.wms:47`). These are live, one-way
bindings against host properties and element properties, with `_onchange` writes
back (`value_onchange="player.settings.volume=value;"`). Typos exist in 18 skins
(`wmpdisabled:` at `Combat_Flight_Simulator_3.wmz/cfs3.wms:238`, `wmpenable:` at
`springflower.wms:194`): resolve unknown prefixes to a literal string, do not throw.

**G15. Handlers run in the element's scope.** D=183. `onDragEnd="player.controls.currentposition=value;"`
(`miniplayer.wms:65`), `onclick="player.settings.mute=down;"` (:105),
`onClick="previous()"` (`aoe.wms:25`), `onmousedown="StartAction(this);"`
(`PowerToys.wms:42`). Evaluate handlers with the element as the innermost scope
(and `this`), and `player`/`theme`/`view`/`mediacenter`/`event` as outer globals.

**G16. Handler value forms.** `jscript:` prefix (D=139): `onClick="jscript:player.launchURL(...)"`
(`blinx.wms:255`), `onTimer="JScript:OnTimerTransport();"` (`Corona.wms:15`);
empty handler `onClick=""` (129); non-script payloads `OnVideoEnd="false"`
(`Nautical/sample.wms:35`); a broken expression
`tracktitle.value=jscript:player.currentmedia.getiteminfo('author')+...`
(`Faith Hill/faithhill.wms:14`); handlers on non-`on*` names with parameters
(`<PLAYER openstatechange="vwPlayer_OnOpenStateChange(NewState);">`,
`netgen.wms:21`; `<player modeChange="updateShuffRep()" />`, `blinx.wms:85`);
nested event hosts (`<controls currentPosition_onchange=...>` inside `<player>`,
`blinx.wms:12`). Entities must be decoded first
(`PowerToys.wms:6` `&quot;`), including `&amp;` in URLs (`netgen.wms:25`).

**G17. Element ids are globals; ids collide with host names.** D=190 use bare ids.
Collisions: `Navigator.wmz/navigator.wms:109` `<Button id="view"`,
`skinwerkz__Deadside.wmz/deadside.wms:28` `id="player"`, plus `status`, `name`,
`top`, `date` in 1-6 skins each. Duplicate ids within a view in 30 skins
(`PowerToys.wms:16` and `:40` are in different views, so they are view-scoped).
Ids resolve case-insensitively (`Ice`). Give each view its own id table; decide
whether host names or element ids win on collision (real WMP behaviour
unverified).

**G18. `eval()` with built identifiers.** D=57, 299 sites.
`eval( button +".upToolTip = locShow" + tip + ".toolTip" );` (several template
skins, e.g. `WALL-E`), `eval(satID + ".down=true;")` (`circle.wmz`),
`eval("eq" + i + ".left = " + ...)` (`Corona.js:170`),
`eval( win + x + "_" + num + ".alphaBlendTo(...)" )` (`xsn.js:541`). `eval` must
see the same global scope as ordinary code, including element ids.

**G19. Host members need case-insensitive lookup and integer enums.**
`player.OpenState` (`headspace.js:28`), `player.currentmedia.getiteminfo`
(`miniplayer.js:16`), `player.Controls.currentPosition`
(`miniplayer.wms:64`), `playState`/`PlayState`/`playstate`/`Playstate`. Numeric
literals: `case 3: //playing` (`blinx.js:70`). Implement host objects as
case-folding proxies; user-defined JS names stay case-sensitive.

**G20. `loadPreference` unset sentinel and string-only storage.**
`if( "--" != dwScale )` (`Ice.wmz/Script.js:72`), `blinx.js:273`; open/closed
state persisted as `"true"`/`"false"` (`blinx.js:263`, `Script.js:27`). Return
`"--"` for unset keys; coerce values with `String()`.

**G21. Views.** (a) size from `backgroundImage` when width/height absent
(`miniplayer.wms:9-16`; 41 first views); (b) start view from
`theme currentViewID`, not file order (`Portals.wms:6`); (c) first view may be an
unsized splash/probe (`xsn.wms:12-13`); (d) views may be anonymous (Headspace
`<view` has no `id`); (e) resizable views use `minWidth/minHeight` and a script
`view.size('bottomright')` drag handle (`TombRaider.wms:161`); (f) `view.width =
n` from script resizes the window (`headspace.js:96,130`);
(g) alignment-based layout (`horizontalAlignment`/`verticalAlignment`
`stretch|right|bottom`) on subviews (`blinx.wms:88-94`).

**G22. Numeric attributes are not always clean numbers.** `width="600 "`
(`Sports/saltmine.wms:6`), trailing-`;` expressions, `jscript:` expressions in
numeric slots (75% of skins). Trim and parse leniently; only literal digits
should skip the expression path.

**G23. Specialised and aliased element tags.** `itemsPlaylist` (24 skins),
`volumeSlider`, `returnButton`, `playbutton`/`pausebutton`/`stopbutton`/`prevbutton`/
`nextbutton`/`rewbutton`/`ffwdbutton`/`mutebutton`, `buttonelement`
specialisations `playelement`/`stopelement`/`prevelement`/`nextelement`
(`headspace.wms:47-55`), `seekslider`, `balanceslider`, `progressbar`,
`currentpositiontext`, `durationtext`, `statustext`, `tracknametext`,
`wmpvideo`, `wmpeffects`. Phase 1 should treat the generic element + a table of
tag defaults rather than 60 bespoke classes.

**G24. Graphics semantics.** `transparencyColor` on views and subviews (96% of
skins) with a magenta key like `#FF00FF`; alpha PNG with and without a colour key
on the same element (58 skins); `clippingColor` as the hit-test/shape key
(`headspace.wms:19`); `clippingImage` as an explicit mask (`Portals.wms:41-42`)
or as the same image as the button (`atomic.wms:133-135`); `backgroundColor="none"`
(95%); `backgroundTiled` (46%); `mappingImage`/`mappingColor` button groups
(89%); `customslider` + `positionImage` greyscale maps (43%); RLE BMPs (15 skins);
multi-frame GIFs (86 skins); `.cur`/`.ani` cursors.

**G25. Animations and timers.** `moveTo(x,y,ms)` with `onEndMove`; `alphaBlendTo(a,ms)`
with `onEndAlphaBlend`; `timerInterval`/`onTimer` per view with `timerInterval="0"` to
stop; `view.timerInterval = ...` from script. `setTimeout` is rare (2 skins).

**G26. Host-populated widgets.** `<popup>`, `<automenu>`, `<listbox>`,
`<editbox>`, `<playlist>` columns (`setColumnResizeMode`), `<effects>`
(`mediacenter.effectType/effectPreset`, `nextPreset()`/`previousPreset()`),
`<equalizerSettings>` (`eq.gainLevelN`, `enableSplineTension`, `reset()`),
`<video>`. They need host data (MPD queue, EQ presets), not skin data.

**G27. Fonts.** `fontFace="arial narrow,arial,tahoma,verdana"`
(`Age_of_Mythology_MP7/aom.wms:42`) is a CSS-like fallback list; `fontSize` is in
points; `fontStyle="bold underline"`, `hoverFontStyle` (`PowerToys.wms`).

## 8. Open questions and unverified claims

- **Contents of `res://wmploc.dll/RT_TEXT/#132`.** Inferred to be the `os*`/`ps*`
  enum constants from usage; the DLL was not available. If it also defines helper
  globals the corpus does not call directly, a stub would silently miss them.
  Names to watch as `ReferenceError`s (called, undefined in the skin, only seen in
  skins that load #132): `updateMetadata`, `onCloseVideo`, `detplay`, `ZoomVideo`,
  `EndVideo`.
  (Verify by extracting resource #132 from a real `wmploc.dll` if one is on hand.)
- **Duplicate-attribute resolution in real WMP.** "Last wins" is inferred from
  author intent in the sampled conflicts, not observed.
- **alpha PNG vs `transparencyColor` precedence** when both are present on one
  element (58 skins).
- **Multi-frame GIF animation.** 86 skins carry them; unverified whether WMP
  animates them in each element type.
- **Whether views are separate windows.** Strongly suggested by `openView` /
  `closeView` / per-view `onLoad`/`onClose` and persisted open-state keys; not
  confirmed by documentation I could fetch. The same question decides how
  `view.width = ...` and `view.size('bottomright')` map to window geometry.
- **Eager vs lazy evaluation order of `jscript:` layout expressions** and
  which dependencies trigger re-evaluation.
- **Element id vs host-global collision order** (`id="view"`, `id="player"`).
- **Which `.wms` WMP itself selects from a multi-`.wms` archive.** The
  fewest-unresolved-references rule works on all four affected archives but is
  not WMP's documented behaviour.
- **Policy decisions, not facts:** what to do with `player.mediaCollection`,
  `cdromCollection`, `dvd`, `openDialog`, `launchURL`, `returnToMediaCenter`,
  `theme.playSound`, localized `res://...RT_STRING` text for an MPD front-end.
- **Dead art** was measured only against `.wms` attributes; runtime-assigned
  images (`.image = "x.bmp"`) were not traced, so 77% is an upper bound.
- Context: Microsoft's pages carry the notice that skins stop being supported in
  Windows Media Player Legacy starting 2026-11-10 on Windows 11 24H2+, which
  raises the archival value of an independent engine.

## 9. Sources

- [Skin Definition File Structure](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/skin-definition-file-structure):
  THEME/VIEW structure, clippingColor/backgroundImage guidance, video behaviour.
- [VIEW.scriptFile](https://learn.microsoft.com/fr-fr/windows/win32/wmp/view-scriptfile):
  semicolon list, implicit `<stem>.js` autoload, WMP 7.0 or later.
- [Using JScript](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/wmp/using-jscript):
  JScript 4.0 floor.
- [WMPOpenState](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/api/wmp/ne-wmp-wmpopenstate)
  and [WMPPlayState](https://learn.microsoft.com/zh-cn/previous-versions/windows/desktop/api/wmp/ne-wmp-wmpplaystate):
  enumerator order (the skin constants `os*`/`ps*` are not named in public
  docs; their mapping here is inferred from the corpus).
- Corpus evidence: every `Skin.wmz/file:line` citation above; extracted copies
  live in `/tmp/fixtures/` and `/tmp/corpus_work/out/decoded/` and are
  ephemeral. Machine-readable per-skin results: `/tmp/corpus_work/out/recs.json`,
  `/tmp/corpus_work/out/skins.tsv`, aggregation logs
  `/tmp/corpus_work/out/agg1.txt` ... `agg4.txt`.
