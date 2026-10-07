# Winamp 2 (.wsz) skin corpus and format survey

Date: 2026-10-06. Branch `skin-engine`. Scope: the Winamp 2 "classic skin" half of the generic skin engine.
Companion to `docs/research/corpus-census.txt` (the WMP `.wms` corpus).

Copyright note: skin art belongs to its authors. Nothing in this doc reproduces art or readme text, only filenames, md5s,
URLs and header numbers. The downloaded skins live in `skins/wsz/` (gitignored by the `skins/` line in `.gitignore`).
The survey read the zips in memory. Outside `skins/` I wrote only `/tmp` scratch: API metadata, copies of Webamp and Audacious source files, five probe bitmaps (extracted from corpus skins for the decoder test) and one museum screenshot.

## 1. Findings that matter for engine design

1. **A classic skin has no layout file.** It is a zip of fixed-name sprite sheets read at hard-coded offsets, plus three optional text files. All geometry lives in the player. The `.wms` interpreter has no counterpart here. The engine needs a built-in "classic layout" table (Webamp's `skinSprites.ts` plus `skinSelectors.ts` are the reference, section 4).
2. **Member lookup must be a flat, case-insensitive, directory-insensitive namespace, last-in-archive wins.** 34% of the population keeps its files in a subfolder. Two corpus skins collide after case folding. `Old_Mac-OS` is *two different skins in one zip* (`Main.bmp` is 275x116 8-bit, `MAIN.BMP` is 372x460 24-bit).
3. **Do not rely on the browser's BMP decoder.** 12% of the corpus bitmaps are RLE8, and base-2.91 itself is RLE8. 6% are 32-bit, and 28 of those 29 have an all-zero alpha channel. One bitmap is 16-bit, and macOS ImageIO and PIL decode it differently. A small own decoder to RGBA, forcing alpha opaque, avoids all of this and gives deterministic pixels for the oracle comparison.
4. **Window shape is `region.txt` only, and the file's presence means little.** 30.8% of skins ship a `region.txt`, but 354 of the 898 non-empty files have no active polygon. 269 are byte-identical copies of base-2.91's fully commented-out template. Skins with an active region are about 18% of the population. The API's `transparent_pixels` metric is non-zero for 408 of the 424 active-region skins whose metric loaded, and for 0 of 2,456 other skins (section 3.3). Winamp 2 has no colour-key or per-pixel transparency.
5. **Missing files are normal and need a fallback.** In the 3,000-skin sample, 8.7% lack `balance.bmp`, 26% lack `numbers.bmp` (most of these carry `nums_ex.bmp`), 11% lack `eq_ex.bmp`, and about 1% lack each of several core sheets. An archived Winamp tutorial states "Anything you don't replace will use its Base Skin counterpart". Webamp and Audacious each implement something different (section 5).
6. **Fallback art is a copyright decision.** The natural fallback is base-2.91, which is Nullsoft's art, so it cannot be committed. Either the user supplies it locally (like Headspace.wmz) or we draw an original default with the same sheet geometry.
7. **Sheets are often the wrong size.** Real skins ship undersized sheets (`posbar` 307x4, `volume` 68x43) and oversized ones (`eqmain` 690x621, `main` 372x460). The engine should read fixed rectangles with bounds clamping, never trust the sheet dimensions, and decide what an out-of-bounds read yields.
8. **There is no Winamp oracle on this machine.** Webamp (MIT, runs in a browser) is the de facto reference. The Webamp museum publishes a 275x348 screenshot per skin (presumably main, EQ and playlist windows at default size, stacked, since 348 = 3 x 116; I did not inspect the pixels). That is a usable regression oracle for Phase 2, kept in `/tmp` or `skins/` only.

## 2. Corpus: acquisition, manifest, reproduction

### 2.1 Sources and recipe

- Webamp skin database GraphQL API: `POST https://api.webamp.org/graphql` (fields used: `fetch_skin_by_md5`, `skins(filter: APPROVED, first, offset)`, `search_classic_skins`, `ClassicSkin.archive_files {filename size is_directory text_content}`, `transparent_pixels`, `screenshot_url`). 93,603 skins in the museum, 12,713 with `filter: APPROVED`. Schema found by introspection (`__type(name:"ClassicSkin")`).
- Skin files: `https://r2.webampskins.org/skins/<md5>.wsz` (HTTP 200, md5 of the download equals `<md5>` for all 30). `cdn.webampskins.org/skins/<md5>.wsz` returned HTTP 530 at survey time.
- Museum page for any row: `https://skins.webamp.org/skin/<md5>`. Screenshot: `https://r2.webampskins.org/screenshots/<md5>.png` (base-2.91's is 275x348 RGBA).
- Internet Archive alternate: the `winampskins` collection (https://archive.org/details/winampskins, "Winamp Skins Collection") and per-skin items named `winampskin_<name>`. Example: `https://archive.org/download/winampskin_Winamp_Classic_CM/Winamp_Classic_CM.wsz` returned HTTP 200, 162,585 bytes (probed, not added to the corpus). `https://archive.org/advancedsearch.php?q=winampskins&fl[]=identifier&output=json` works. Mirrors also exist as `WinampSkinPack` (41.7 MB) and `2018_mywinamp_skins`. archive.org holds no skinning documentation that I could find. The best docs are Webamp's source and the archived tutorial in section 7.
- Selection method: metadata sample first (section 3), then hand-pick 30 skins to cover each edge case, then download by md5. Skins are named `<name>-<first 6 md5>.<ext>`.
- The default skin, `base-2.91.wsz`, is md5 `5e4f10275dcb1fb211d4a8b4f1bda236` (museum entry filename `base-2.91.wsz`, 101,121 bytes, 29 members).

### 2.2 Manifest (30 skins, 3.6 MB total, all md5-verified, all zip central directories valid)

Local path prefix: `skins/wsz/`. Size is the download in KiB. Three files carry a `.zip` extension, which is the same format (a `.wsz` is a renamed zip).

| local file | md5 | museum filename | KiB | why selected |
|---|---|---|---|---|
| `base-2.91-5e4f10.wsz` | `5e4f10275dcb1fb211d4a8b4f1bda236` | base-2.91.wsz | 98 | default skin; RLE8 8-bit; inert (commented) region.txt; .cur set |
| `Green-Dimension-V2-4308a2.wsz` | `4308a2fc648033bf5fe7c4d56a5c8823` | Green-Dimension-V2.wsz | 68 | complex shaped window, all 4 region sections (164 polys in [Normal]) |
| `Old_Mac-OS-981a68.wsz` | `981a6801ebcc4d66d1f5e311b587f192` | Old_Mac-OS.wsz | 205 | TWO DIFFERENT skins in one zip, names differing only by case (Main.bmp 275x116 8-bit vs MAIN.BMP 372x460 24-bit); inert region |
| `Pika_Amp-061589.wsz` | `061589029dde4c811f5c8013aae603d7` | Pika_Amp.wsz | 156 | small shaped skin, [Normal]+[Equalizer] only |
| `Winamp_Vista_Classic-4375c2.wsz` | `4375c26e97488769d883984287e2e8d2` | Winamp_Vista_Classic.wsz | 99 | Vista-style; pledit.txt with UTF-8 BOM, non-ASCII, LF-only |
| `224_Receiver-5eddd4.wsz` | `5eddd4551ab639a85951323a6df7463e` | 224_Receiver.wsz | 110 | nested folder; no nums_ex; no region |
| `73_1_-d5a631.wsz` | `d5a631e02b9c6b3d28048d3362fbc137` | 73[1].wsz | 142 | 24-bit; nums_ex only; avs.bmp |
| `several_mechs-0429ea.wsz` | `0429ea5cff3cf9288cd2dff2c140e09c` | several_mechs.wsz | 91 | nested folder (Robotech); 24-bit |
| `DTrans_B-68a4c8.wsz` | `68a4c8973ab3df3a2f8c6d93d7484d2f` | DTrans_B.wsz | 45 | heavy transparency (api transparent_pixels=98906); region [Normal]+[Equalizer] |
| `Blue_Silver_ver1-77b3ed.wsz` | `77b3ed369fa6fb3fe0692632d21ea9ce` | Blue_Silver_ver1.wsz | 163 | region with [WindowShade]; transparency 575px |
| `research_3_-_dreamboy-a87e80.wsz` | `a87e8011da05ac119abb5004346bc267` | research_3_-_dreamboy.wsz | 395 | region with 8 polygons per section |
| `Federal_Bureau_of_Imitations-213baf.wsz` | `213baf151d1daedfeba075bd0d61ba68` | Federal_Bureau_of_Imitations.wsz | 33 | small; inert region template |
| `Zero_X_Amp-d7d04c.wsz` | `d7d04cee1cdd3b05332f7be3a8a5c989` | Zero_X_Amp.wsz | 35 | minimal: missing cbuttons, balance, shufrep, playpaus, numbers, text |
| `utsukushii_xxv-b6c282.wsz` | `b6c28238debf7c1389e8b2c9a928e87d` | utsukushii xxv.wsz | 6 | minimal (6.3 KB): missing titlebar, volume, balance, playpaus, monoster, numbers; 1-polygon region |
| `Yugoamp_Yugoslavia_Jugoslavija-011a54.wsz` | `011a5411fed0755fef2b5c37dfd1c8ab` | Yugoamp_Yugoslavia_Jugoslavija.wsz | 15 | minimal: missing volume, balance, playpaus; no pledit.txt/viscolor.txt |
| `phreak-cf9e64.zip` | `cf9e64f33b672cb3feefb04eda3894d8` | phreak.zip | 72 | minimal: missing balance, eqmain, pledit; .zip extension |
| `Temple_of_the_Llama-b40405.wsz` | `b40405504ac19307fc71e2c54c924f96` | Temple_of_the_Llama.wsz | 347 | nested + duplicate pledit/titlebar (root and subfolder); missing numbers, text |
| `Fusion_AMPdeck_v5.5-9c1c1f.wsz` | `9c1c1f6b9275824adf939d54e9532bbb` | Fusion_AMPdeck_v5.5.wsz | 386 | nested; 2.9-era set (gen/genex/video); .png files present but only as screenshot extras |
| `Super-Mario-Anniversary-35-Webamp-Edition-a93610.zip` | `a9361068b24c6eb797c9438b5171f00b` | Super-Mario-Anniversary-35-Webamp-Edition.zip | 194 | PNG eqmain+posbar mixed with BMPs; .zip extension |
| `Tim_Kemp-9cda96.wsz` | `9cda96e3c9afd87a0742ae371aded48a` | Tim_Kemp.wsz | 49 | nested; 8-bit RLE8; inert region |
| `GRX-30-c87ef0.wsz` | `c87ef0ff1323dd029ccca91029dd55d7` | GRX-30.wsz | 46 | small 8-bit RLE8; inert region |
| `Guardian_amp-b147cb.wsz` | `b147cb0892f62f09046606b6a709c9f3` | Guardian_amp.wsz | 97 | nested; no balance, no numbers |
| `Pordey_Freutch-d2d433.wsz` | `d2d43306b7b16a9c9b60aab376020d7e` | Pordey_Freutch.wsz | 89 | no eq_ex/mb; region.txt that is a differently-worded commented tutorial (inert) |
| `greenness_V2-1e5e67.wsz` | `1e5e6747e5f56be785348fe24738747f` | greenness_V2.wsz | 32 | all 32-bit BMPs (alpha channel all zero); gen+genex |
| `RAPTOR-dae011.wsz` | `dae01165f5054754d810d7935ae67b1d` | RAPTOR.wsz | 121 | all 4 region sections 1-polygon each; 32-bit cbuttons with MIXED alpha |
| `the_CUBE_v1_by_Kuki-e55988.wsz` | `e5598897eab8dcecfadb6a426bd9f863` | the_CUBE_v1_by_Kuki.wsz | 31 | nums_ex only; heavy shape (115 polys); transparency 5950px |
| `Winamp_5-9a5b4f.wsz` | `9a5b4f03e7eb6e5ac6604f47f763cc72` | Winamp_5.wsz | 131 | Winamp 5-style; 32-bit alpha-0 bitmaps; many small polygons |
| `real_galaxy-546000.wsz` | `546000c129d29f15850b2d95776cb9cb` | real_galaxy.wsz | 62 | nested; tiny region with [WindowShade] |
| `Corroded1-0-e58f74.zip` | `e58f744b7fc60ecadedb0163c4bef3dc` | Corroded1-0.zip | 278 | nested; no eq_ex/mb/nums_ex; inert region; .zip extension |
| `Weird_Amp_2-3ffe3f.wsz` | `3ffe3f70a6e4de120b7b6bb1f0f7035c` | Weird_Amp_2.wsz | 31 | missing balance, monoster, numbers; 16-bit text.bmp |

The 30 are hand-picked for coverage, so statistics over them are not population statistics. Section 3 gives those.

### 2.3 Reproduction (the throwaway scripts were in `/tmp` and are gone)

- Population sample: GraphQL `skins(filter: APPROVED, first: 100, offset: O)` for 30 offsets. Offsets: `random.seed(7); sorted(random.sample(range(0, 12713-100, 100), 30))`. That is 3,000 skins. Query (names only, no art): `{ skins(first:100, offset:O, filter:APPROVED){ count nodes { ... on ClassicSkin { md5 filename transparent_pixels archive_files { filename size is_directory } } } } }`.
- Text content: the same offsets, with `archive_files { filename is_directory text_content }`, keeping only `region.txt`, `pledit.txt` and `viscolor.txt` (readmes were discarded in memory).
- `transparent_pixels` resolver fails ("Unexpected error") for 120 of the 3,000 nodes; those come back null. All 120 turned out to be active-region skins (section 3.3).
- The 30-skin survey: `zipfile.ZipFile(path).read(member)` in memory; BMP header fields by `struct`: DIB header size at byte 14, width/height at 18/22, bit count at 28, compression at 30, colours used at 46. Magic bytes (`BM`, PNG, JPEG, GIF) were sniffed on every image member regardless of extension.
- Caveats on the sample: `APPROVED` excludes NSFW and rejected skins and is an unknown ordering, so 30 contiguous blocks of 100 is a cluster sample, not simple random. Treat the percentages as roughly +-2 points of the museum's approved set, no better.

## 3. Survey results

### 3.1 The 30-skin corpus (survey over all members, last-in-archive wins for duplicate names)

Archive-level:
- 30/30 zips pass `testzip()`. 27 `.wsz`, 3 `.zip`. All members are stored or deflated.
- Nested in a subfolder: 9 of 30 (30%), all one level deep (`Name/main.bmp`). Folder names include spaces.
- Name collisions after case-folding: 2 of 30. `Old_Mac-OS` has 22 colliding names, and all 22 pairs have different content. `Temple_of_the_Llama` has root and subfolder copies of `pledit.bmp` and `titlebar.bmp` (same size).
- File-name case: 342 UPPER, 317 lower, 235 Capitalized, 35 Mixed stems. By skin, dominant style is lower in 14, UPPER in 10, Capitalized in 6. Case is not predictable.
- Cursors (`.cur`/`.ani`): 12 of 30 skins.
- Magic bytes vs extension: 0 mismatches. Two sprite sheets are real PNGs under a `.png` name (`Super-Mario...` `eqmain.png`, `posbar.png`), the rest are BMPs.

Sprite-sheet presence (n=30):

| file | present | file | present |
|---|---|---|---|
| main | 30 | eqmain | 29 |
| cbuttons | 29 | eq_ex | 25 |
| titlebar | 29 | pledit.bmp | 29 |
| posbar | 30 | gen / genex | 8 / 8 |
| volume | 28 | mb | 23 |
| balance | 24 | avs | 16 |
| shufrep | 29 | video | 9 |
| playpaus | 27 | pledit.txt | 27 |
| monoster | 28 | viscolor.txt | 27 |
| numbers | 17 | region.txt | 17 (10 active, 7 inert) |
| nums_ex | 13 | text | 28 |

Per-skin features (`main bpp` is the bit depths seen across all bitmaps in the skin; core-missing treats `nums_ex` as satisfying `numbers`; `region` shows which sections have an active polygon list: N=Normal, WS=WindowShade, EQ=Equalizer, EQWS=EqualizerWS, inert=file present but nothing active):

| skin | bpp | RLE8 | core missing | optional present | region | nested | cur |
|---|---|---|---|---|---|---|---|
| base-2.91 | 8 | y | - | eqx,mb,gen,gx,vid | inert | - | 8 |
| Green-Dimension-V2 | 24 | - | - | eqx,nx,mb,avs,gen,gx,vid | N+WS+EQ+EQWS | - | 27 |
| Old_Mac-OS | 8/24 | - | - | eqx,nx,mb,avs,gen,gx,vid | inert | - | 28 |
| Pika_Amp | 24 | - | - | eqx,mb | N+EQ | - | 0 |
| Winamp_Vista_Classic | 24 | - | - | eqx,nx,mb,avs,gen,gx,vid | - | - | 28 |
| 224_Receiver | 4/8 | - | - | eqx,mb | - | y | 0 |
| 73[1] | 8/24 | - | - | eqx,nx,mb,avs | - | - | 0 |
| several_mechs | 24 | - | - | mb | - | y | 0 |
| DTrans_B | 24 | - | - | eqx | N+EQ | - | 0 |
| Blue_Silver_ver1 | 24 | - | - | eqx,mb,avs | N+WS | - | 27 |
| research_3_-_dreamboy | 24 | - | - | eqx,mb,avs | N+EQ | - | 0 |
| Federal_Bureau_of_Imitations | 8/24 | y | - | eqx,mb,avs | inert | - | 27 |
| Zero_X_Amp | 8/24 | y | cbuttons,balance,shufrep,playpaus,numbers,text | mb,avs | - | y | 0 |
| utsukushii_xxv | 24 | - | titlebar,volume,balance,playpaus,monoster,numbers | eqx,vid | N | - | 0 |
| Yugoamp_Yugoslavia_Jugoslavija | 4/8/24 | - | volume,balance,playpaus | eqx | - | - | 0 |
| phreak | 24 | - | balance,eqmain,pledit | - | - | - | 0 |
| Temple_of_the_Llama | 24 | - | numbers,text | eqx,mb,avs | - | y | 27 |
| Fusion_AMPdeck_v5.5 | 24 | - | - | eqx,nx,mb,gen,gx,vid | - | y | 0 |
| Super-Mario-Anniversary-35 | 24 | - | - | eqx,nx,mb,gen,gx,vid | - | - | 24 |
| Tim_Kemp | 8 | y | - | eqx,mb,avs | inert | y | 27 |
| GRX-30 | 8 | y | - | eqx,mb,avs | inert | - | 27 |
| Guardian_amp | 8 | - | balance | eqx,nx,mb,avs | - | y | 0 |
| Pordey_Freutch | 8 | - | - | nx | inert | - | 28 |
| greenness_V2 | 32 | - | - | eqx,gen,gx,vid | - | - | 0 |
| RAPTOR | 24/32 | - | - | eqx,nx,mb,avs | N+EQ+WS+EQWS | - | 0 |
| the_CUBE_v1_by_Kuki | 24 | - | - | eqx,nx,mb,avs | N+WS+EQ+EQWS | - | 0 |
| Winamp_5 | 8/24/32 | - | - | eqx,nx,mb,gen,gx,vid | EQ+N | - | 0 |
| real_galaxy | 8 | - | - | eqx,nx,mb,avs | N+EQ+WS | y | 27 |
| Corroded1-0 | 24 | - | - | - | inert | y | 0 |
| Weird_Amp_2 | 16/24 | - | balance,monoster | eqx,nx,mb,avs | - | - | 0 |

Core-missing totals over the 30 (with `nums_ex` counted as satisfying `numbers`): balance 6, numbers 3, playpaus 3, text 2, monoster 2, volume 2, and one each of cbuttons, shufrep, eqmain, pledit, titlebar. Another 10 skins have no `numbers.bmp` but do have `nums_ex.bmp`. `main.bmp` and `posbar.bmp` are present in all 30.

Bitmap encoding (457 bitmaps in 30 skins):
- DIB header: all 457 use the 40-byte BITMAPINFOHEADER. No OS/2 12-byte headers, no V4/V5, no top-down (negative height) bitmaps.
- Bit depth: 24-bit 289 (63%), 8-bit 133 (29%), 32-bit 29 (6%), 4-bit 5, 16-bit 1.
- Compression: BI_RGB 401, **BI_RLE8 56 (12%)**, no RLE4, no BITFIELDS. All RLE8 bitmaps are 8-bit. base-2.91's own `main.bmp`, `cbuttons.bmp`, `balance.bmp`, `eqmain.bmp`, `monoster.bmp`, `numbers.bmp`, `posbar.bmp`, `shufrep.bmp`, `text.bmp` are RLE8.
- `main.bmp` encoding per skin: 24-bit raw 20, 8-bit RLE8 5, 8-bit raw 4, 32-bit raw 1.
- 32-bit alpha: of 29 32-bit bitmaps, 28 have alpha 0 on every pixel. `RAPTOR` `cbuttons.bmp` is mixed (4,808 pixels alpha 0, 84 at 255, 1 at 193). Classic Winamp ignores alpha. A decoder that honours it makes these sheets invisible.
- Decoder probe (macOS `sips`, which is ImageIO; I believe WKWebView uses the same decoder but did not verify): RLE8 decodes correctly (pixel-identical to PIL for base-2.91 `main.bmp` and `cbuttons.bmp`). 32-bit images come out with `hasAlpha: no` and RGB identical to PIL. The 16-bit `text.bmp` (`Weird_Amp_2`) decodes to different RGB in ImageIO than in PIL (a 5-5-5 versus 5-6-5 style disagreement; I did not establish which is right). The decoder question is therefore still open for 16-bit, and a custom decoder removes the dependency.

Sheet dimensions against base-2.91 (exact matches of the 30; "other" shows the commonest deviations). "Webamp extent" is the smallest rectangle containing every sprite Webamp reads from the sheet (computed from `skinSprites.ts`).

| sheet | base-2.91 (WxH) | Webamp extent | exact in corpus | notable deviations |
|---|---|---|---|---|
| main | 275x116 | 275x116 | 29/30 | `Old_Mac-OS` 372x460 (last-wins copy) |
| cbuttons | 136x36 | 136x36 | 29/29 | none |
| titlebar | 344x87 | 344x86 | 29/29 | none |
| posbar | 307x10 | 307x10 | 24/29 | 307x4 (x2), 307x3, 306x10, 307x11 |
| volume | 68x433 | 68x433 | 19/28 | 68x419, 68x420, 68x424, 75x435, 68x43 |
| balance | 68x433 | 47x433 | 13/24 | 47-wide variants (x7), 68x424 |
| shufrep | 92x85 | 92x85 | 27/29 | 220x174, 101x130 |
| playpaus | 42x9 | 48x9 | 26/27 | 42x10 |
| monoster | 58x24 | 56x24 | 23/28 | 56x24 (x5) |
| numbers | 99x13 | 90x13 | 15/17 | 108x13, 101x32 |
| nums_ex | 108x13 | 108x13 | 9/13 | 99, 107, 109, 111 wide |
| text | 155x74 | 155x18 | 5/28 | **155x18 (x23)**: the common size is the Webamp extent, not base-2.91's |
| eqmain | 275x315 | 275x315 | 23/28 | 690x621, 443x382, 275x294, 275x163, 277x318 |
| eq_ex | 275x82 | 275x56 | 13/25 | 275x56 (x8), 275x67, 275x133, 275x37, 275x29 |
| pledit | 280x186 | 280x186 | 21/29 | 280x190 (x5), 283x188 |
| gen | 194x109 | 178x86 | 4/8 | 178x103 (x2), 182x103, 232x103 |
| genex | 130x75 | (unsupported) | 5/8 | 112x59 (x3) |
| mb | 234x119 | (unsupported) | 2/23 | 242x119 (x13), 233x119 (x6) |
| video | 234x119 | (unsupported) | 3/9 | 233x119 (x5), 275x119 |
| avs | (not in base-2.91) | (unsupported) | 0/16 | 97x188 (x15) |

Text files (n=30):
- `region.txt` 17 files. 10 have active sections, 7 are inert. Active-section sets: N+WS+EQ+EQWS 3, N+EQ 3, N+EQ+WS 1, N+WS 1, EQ+N 1, N 1. Polygon counts per section range from 1 to 164 (`Green-Dimension-V2` `[Normal]`: 164 polygons, 656 points). Six of the seven inert files are byte-for-byte base-2.91's 5,826-byte template (md5 `cf99fc0cad72252dfd49124fbce76e3d`): `Corroded1-0`, `Federal_Bureau_of_Imitations`, `GRX-30`, `Old_Mac-OS`, `Tim_Kemp` and base-2.91 itself. `Pordey_Freutch` has a different 1,042-byte commented tutorial.
- `pledit.txt` 27 files, all with `[Text]` and the keys `Normal Current NormalBG SelectedBG Font`; 15 also have `MbFG` and `MbBG`. `Winamp_Vista_Classic` has a UTF-8 BOM, non-ASCII characters and LF-only line endings.
- `viscolor.txt` 27 files. Numeric-line counts: 24 lines x13, 23 x9, 22 x2, 25 x1, 26 x1, 27 x1. One file (`Green-Dimension-V2`) has two non-numeric header comment lines before the numbers.

### 3.2 Population statistics (3,000 skins sampled from 12,713 APPROVED)

Presence of files, by lower-cased stem across any directory and extension:

| file | skins | % | file | skins | % |
|---|---|---|---|---|---|
| main | 2,999 | 100.0 | eqmain | 2,973 | 99.1 |
| cbuttons | 2,999 | 100.0 | eq_ex | 2,670 | 89.0 |
| titlebar | 2,995 | 99.8 | pledit (bmp or txt) | 2,973 | 99.1 |
| posbar | 3,000 | 100.0 | gen | 455 | 15.2 |
| volume | 2,995 | 99.8 | genex | 452 | 15.1 |
| balance | 2,740 | 91.3 | mb | 2,256 | 75.2 |
| shufrep | 2,995 | 99.8 | avs | 1,614 | 53.8 |
| playpaus | 2,972 | 99.1 | video | 458 | 15.3 |
| monoster | 2,990 | 99.7 | viscolor | 2,890 | 96.3 |
| numbers | 2,221 | 74.0 | region (any file named region.*) | 924 (923 are region.txt) | 30.8 |
| nums_ex | 957 | 31.9 | text | 2,986 | 99.5 |

- Missing core sheets (count of 3,000, with `nums_ex` counted as satisfying `numbers`): balance 260 (8.7%), playpaus 28, eqmain 27, pledit 27, numbers 15, text 14, monoster 10, shufrep 5, titlebar 5, volume 5, main 1, cbuttons 1. 307 skins (10.2%) are missing at least one core sheet, 45 are missing two or more, counting `.bmp` and `.png` members only.
- Files in a subfolder: 1,022 of 3,000 (34.1%).
- File extensions across all members: `.bmp` 48,395, `.cur` 26,941, `.txt` 9,311, `.db` 152, `.jpg` 105, `.htm` 95, `.psd` 81, `.avs` 79, `.gif` 72, `.ini` 48, `.ttf` 46, `.eqf` 35, `.ani` 31, `.png` 26, `.dll` 17. Core sprite sheets are `.bmp` 38,109 times and `.png` 2 times, so PNG sheets are essentially absent from this classic-era sample.
- Skins with at least one `.cur`/`.ani`: 1,012 (33.7%).
- Sample caveat: the 3,000 excludes skins Webamp has not approved, and the museum itself is skewed toward skins people uploaded to archive sites, not toward every skin that ever existed.

`region.txt` content (898 non-empty files out of 923 present; 25 are empty):
- **354 (39%) have no active polygon list.** 269 of those are byte-identical to base-2.91's REGION.TXT (md5 `cf99fc0cad72252dfd49124fbce76e3d`, 5,826 bytes). The next most common duplicates are 29 and 17 copies of other files.
- 544 files define at least one active polygon list, which is 18.1% of the 3,000 skins. Active-section sets: Equalizer+Normal 197, Equalizer+EqualizerWS+Normal+WindowShade 116, Normal only 93, Equalizer+Normal+WindowShade 64, WindowShade only 17, Normal+WindowShade 12, plus a long tail.
- Section names counted over all files (active or commented): normal 522, equalizer 416, windowshade 245, equalizerws 151. Non-standard names also occur: `playlist` 7, `zoom` 6, `pledit` 6, `eqshade` 2, `window shade` 1, `normal new` 1. Webamp ignores these (`Skin.tsx:14-26`) and the archived tutorial does not document them.
- Polygons per active section: 1 polygon 829 sections, 2 polygons 119, 3 polygons 41, 4 polygons 31, 5 polygons 51, 6 polygons 25, 7 polygons 22, 8 polygons 7, 9 or more 181. About 1,306 active sections in all.
- Malformed active sections: 2 skins of 544. One has no `NumPoints`; one has a non-integer in the list. Webamp drops a section silently if either key is missing (`regionParser.ts:18-20`) and drops a polygon with fewer than 3 points (`:29-33`).

`pledit.txt` (2,869 of the 2,923 skins whose text was fetched):
- Sections: `[Text]` in 2,868. Keys: `normal` 2,867, `selectedbg` 2,867, `current` 2,864, `normalbg` 2,863, `font` 2,828, `mbfg` 1,793, `mbbg` 1,774.
- Colour values (11,461 across the four main colour keys): `#RRGGBB` 11,045 (96.4%), bare `RRGGBB` without `#` 163 (1.4%), other forms 253 (2.2%). The other forms are 8-digit (`#00FFFFFF`), short (`#000`), or with trailing spaces. The parser must tolerate all of them. Webamp prepends `#` when absent and keeps the first 7 characters (`skinParserUtils.ts:170-182`).

`viscolor.txt` (2,888 present): numeric-line counts 24 lines 1,737 (60.1%), 23 lines 867 (30.0%), 25 lines 169 (5.9%), 22 lines 37, everything else 78 (two files have only 2 lines, others up to 42). Short files must fall back per index, long files must not crash. Webamp starts from the default 24 colours and overwrites by line index (`utils.ts:89-101`).

### 3.3 `transparent_pixels` is a proxy for an active region, not a format property

The API's `transparent_pixels` is computed by Webamp's pipeline from a rendered skin screenshot, not from the zip, so it is a derived metric. Cross-tab against `region.txt` state over the 3,000:

| region.txt state | transparent_pixels > 0 | = 0 | null (API error) |
|---|---|---|---|
| active polygons (544) | 408 | 16 | 120 |
| inert template (354) | 0 | 354 | 0 |
| no region.txt (2,102) | 0 | 2,102 | 0 |

So 408 of 424 (96.2%) of active-region skins with a loaded metric show transparency, and 0 of 2,456 other skins do. This independently confirms that, in this museum, transparency exists only where an active region exists. The 120 nulls are all active-region skins, so the failing resolver is correlated with exactly the skins we care about, and the 96.2% should be read as a floor, not a rate. Winamp also has no colour-key transparency (the sheets are opaque, and 32-bit alpha is ignored, section 3.1). A forum post found by search says the same ("Transparencies in WinAMP can only be created with the regions.txt coordinates format", forums.wincustomize.com thread 41328; search snippet only, not fetched).

## 4. Winamp 2 classic skin format essentials

All Webamp references are to commit `88ed5815d968c201962f6549915579b3d2f93c5e` of https://github.com/captbaritone/webamp (committed 2026-08-23), under `packages/webamp/js/` unless stated. Audacious references are to commit `ee2516c561452a33c8b90a15ae9dbc4ded1721f3` of https://github.com/audacious-media-player/audacious-plugins, `src/skins/`. I read these files locally; line numbers are from those copies.

### 4.1 Container

- A `.wsz` is a zip with a renamed extension. Sources: archived tutorial `wsz.html` ("Winamp Skin Zip" files are standard ZIP archives), Jordan Eldredge's article ("the .wsz is actually just a .zip archive file that has been renamed"), Audacious `skins_util.cc:126-134` (extensions `.wsz` and `.zip` both map to zip). The survey saw `.zip` skins in the museum (3 of 30 here).
- The tutorial tells authors to zip the skin's *folder*, which explains the 34% subfolder rate. The format does not require it and the loader does not care.
- Lookup is by base name and extension, any directory, any case: Webamp builds `^(.*[/\\])?<base>.(<ext>)$` with the `i` flag (`skinParserUtils.ts:13-19`). Duplicates: "use the last matching file", to mimic Windows extraction order overwriting earlier files (`skinParserUtils.ts:32-45`). Audacious extracts to a folder and looks up `<name>.bmp`, `.png`, `.xpm` in that order with a case-insensitive path search (`skins_util.cc:86-98`).
- Image extension: classic Winamp reads `.bmp` only. WACUP added PNG sheets in beta 0.9.9.1364 (changelog: "Added support for loading classic skins using PNG images instead of bitmap (BMP) images", https://getwacup.com/changelog/beta_0_9_9_1364.html). Webamp accepts `(png|bmp)` (`skinParserUtils.ts:104-107`), and Webamp's own default skin uses PNG. The corpus sample has 2 PNG core sheets in 3,000 skins.

### 4.2 Windows, sizes, shade, double size

| window | normal size | shade size | source |
|---|---|---|---|
| main | 275x116 | 275x14 | `constants.ts:43-44`; `skinSprites.ts:137` (`MAIN_WINDOW_BACKGROUND` 275x116), `:587` (`MAIN_TITLE_BAR` 275x14), `:672` (`MAIN_SHADE_BACKGROUND` 275x14) |
| equalizer | 275x116 | 275x14 | `skinSprites.ts:425` (`EQ_WINDOW_BACKGROUND`), `:400` (`EQ_SHADE_BACKGROUND`) |
| playlist | (275 + 25 n) x (116 + 29 m), n and m integer segment counts, default 275x116 | height 14, width as the window | `selectors.ts:466-482`; `constants.ts:41-42` (`WINDOW_RESIZE_SEGMENT_WIDTH = 25`, `..._HEIGHT = 29`) |

- Shade sprites live in the same sheets as the normal chrome: main shade in `titlebar.bmp` at y=29 (focused) and y=42 (unfocused), x=27, 275x14 (`skinSprites.ts:672`, Audacious `skin.cc:438-454` comment); EQ shade in `eq_ex.bmp` rows y=0 (focused) and y=15, 275x14 (`skinSprites.ts:400`); playlist shade in `pledit.bmp`: left 25x14 at (72,42), tile 25x14 at (72,57), right 50x14 at (99,42) focused or (99,57) unfocused (`skinSprites.ts:237`; Audacious `skin.cc:418-436`). The shaded main window shows a 17x7 position track with 3x7 thumbs from `titlebar.bmp` (`MAIN_SHADE_POSITION_*`) and a text-sprite mini time. The EQ shade holds 3x7 volume and balance slider pieces in `eq_ex.bmp` at y=30.
- Every window has a focused and an unfocused titlebar variant (`titlebar.bmp` rows y=0 and y=15 at x=27, 275x14).
- Playlist frame (all in `pledit.bmp`, 280x186): top is left corner 25x20 + title + right corner 25x20 + a 25x20 tile (`skinSprites.ts:181-192`; the title graphic is 100x20 at x=26 per Audacious `skin.cc:326-333`, minimum 150 wide per the comment at `:321`). Bottom is a 125x38 left corner, a 150x38 right corner, a 25x38 tile at x=179, and an optional 75x38 mini-visualizer at x=205 once the window is wide enough (`skinSprites.ts:217`; Audacious `skin.cc:359-369`, which gives the 125+150+25 = 300 minimum when the visualizer is shown). Sides are 12x29 left and 19-20x29 right tiles starting at y=42 (Webamp uses width 20, Audacious 19, a one-pixel source disagreement). The archived tutorial describes the same tiling and calls the playlist "fully resizable".
- Double size: integer 2x, main and EQ only, nearest-neighbour. In Webamp, `canDouble` is true for main and equalizer and false for playlist (`reducers/windows.ts:38-67`), window pixel size is multiplied by 2 (`selectors.ts:471-482`), the window is drawn with `transform: scale(2)` from top-left (`css/webamp.css:115-120`), and `image-rendering: pixelated` is set on the main window (`css/main-window.css:6-10`). Because the clip path lives on the window element, region polygons scale with it. Toggle: `reducers/display.ts:110`.
- Z-order and docking are player behaviour, not skin data. Webamp's `WindowManager.tsx` is the reference if the engine ever wants the Winamp 2 snapping behaviour.

### 4.3 Sprite sheets (file, size, content)

`skinSprites.ts` is a table `{ sheet: [ {name, x, y, width, height}, ... ] }`. The sheets and where they start in that file:

| sheet | what it holds | `skinSprites.ts` |
|---|---|---|
| `main.bmp` | whole main-window background, 275x116 | 136 |
| `cbuttons.bmp` | prev, play, pause, stop, next (23x18 each, normal row y=0, pressed row y=18) and eject 22x16 | 116 |
| `titlebar.bmp` | titlebar variants, close/minimize/shade buttons (9x9), shade-mode pieces | 586 |
| `posbar.bmp` | seek track 248x10 and two 29x10 thumbs (normal at x=248, pressed at x=278) | 484 |
| `volume.bmp` | 28 stacked background frames of 15 px (68 wide, 420 tall in all; `components/MainWindow/MainVolume.tsx:10-14`) plus a 14x11 thumb at y=422 | 711 |
| `balance.bmp` | same idea, background `x=9, w=38` from a 68-wide sheet; thumbs at y=422 | 111 |
| `shufrep.bmp` | shuffle, repeat, EQ and playlist toggle buttons, 4 states each, 92x85 | 507 |
| `playpaus.bmp` | play/pause/stop indicator glyphs, 9x9 | 173 |
| `monoster.bmp` | mono/stereo indicators, 29x12 and 27x12, two states | 139 |
| `numbers.bmp` | digits 0-9, 9x13 each, plus a 5x1 minus sprite at (20,6) | 145 |
| `nums_ex.bmp` | digits 0-9 plus a no-minus and a minus cell at x=90 and x=99, 108x13 | 159 |
| `text.bmp` | bitmap font: 5x6 cells, 31 columns x 3 rows = 155x18 (`FONT_LOOKUP` and `CHAR_X/CHAR_Y` at `:14-103`, sheet at `:585`) | 585 |
| `eqmain.bmp` | EQ window background, titlebars, sliders, ON/AUTO/PRESETS, spline graph, 275x315 | 424 |
| `eq_ex.bmp` | EQ shade mode (275x14 bars, 3x7 slider pieces, buttons) | 392 |
| `pledit.bmp` | playlist chrome (see 4.2) and scroll handles 8x18 | 180 |
| `gen.bmp`, `genex.bmp` | Winamp 2.9/5 general windows (media library, AVS): resizable frame, a 7px-high letter font read from rows y=88 and y=96, and colour pixels along row 0 at x=48..90 | `gen` 722; `genex` is commented out in Webamp (`:757-838`) because the media library is unsupported |
| `mb.bmp`, `avs.bmp`, `video.bmp` | minibrowser, AVS and video windows (2.9/5.x era) | not in Webamp's table |

Digit mapping, character mapping and colour-pixel positions are in `skinSprites.ts:14-103`, `skinParser.js:95-139` (gen letters) and `skinParserUtils.ts:188-261` (genex colour x positions 48 through 90, step 2).

Archived-tutorial notes (https://winampskins.neocities.org/, retrieved 2026-10-06 through a summarising fetch tool, so the quotes below are the tool's rendering, not verified verbatim): `twonine.html` says `gen.bmp` "is used for general purpose windows such as the media library and the AVS window in Winamp versions greater than 2.9"; `video.bmp` is "resizeable and tiled, just like the playlist window"; `genex.bmp` holds buttons, sliders and "18 color control pixels (x-coordinates 48-82)". `equalizer.html` says `eq_ex.bmp` is "the file that illustrates ... the controls that are present in Winamp's Equalizer while in WindowShade mode". `wsz.html` says a skin is "composed of 45 files".

### 4.4 Text files

- `region.txt` (INI): four honoured sections `[Normal]`, `[WindowShade]`, `[Equalizer]`, `[EqualizerWS]`, each with `NumPoints=a,b,c` (points per polygon) and `PointList=x,y,x,y,...` on a single line. Webamp maps exactly those four names (`components/Skin.tsx:14-26`) and builds one SVG `clipPath` per section with one `<polygon>` per entry (`components/ClipPaths.tsx:20-33`), which by SVG rules is the union of the polygons, applied as `clip-path` (`Skin.tsx:120-126`). Other section names are ignored by Webamp. The coordinates are pixel corners (the comment block in `Pordey_Freutch`'s region.txt, lines 8-10, says "the Point is the upper-left corner of the Pixel"), x 0..275 and y 0..116 for normal windows, 0..14 for shade windows. base-2.91's own REGION.TXT is a commented tutorial (lines 26-39 describe the format, line 24 says "if WinAmp finds multiple definitions, it only does the first and ignores the rest", lines 73-77 explain that coordinates that do not follow the outside edge "mark transparent space limits"). Parsing rules in Webamp: `regionParser.ts:13-51` (list split on commas or spaces, `NumPoints` split on commas, polygons under 3 points dropped, a polygon list shorter than the counts tolerated). The archived tutorial's `config.html` lists the same four sections and says the `NumPoints` list "must be on a single line with comma separated numbers".
- `pledit.txt` (INI, `[Text]`): `Normal`, `Current`, `NormalBG`, `SelectedBG`, `Font`, and the 2.9-era `MbFG`, `MbBG`. Webamp's defaults when the file or key is missing: `#00FF00`, `#FFFFFF`, `#000000`, `#0000FF`, `Arial` (`baseSkin.json:34-40`). base-2.91's own PLEDIT.TXT has `SelectedBG=#0000C6`, which differs from Webamp's fallback `#0000FF`. The right fallback colour is therefore an open detail. Parsing: `skinParserUtils.ts:154-186`.
- `viscolor.txt`: 24 lines of `r,g,b` with trailing `//` comments (archived tutorial `config.html`: "It contains 24 lines. Each line is an RGB value followed by a comment"). Indices: 0 background, 1 dots, 2-17 spectrum analyser (2 = top, 17 = bottom), 18-22 oscilloscope, 23 peak dots. base-2.91's copy is `skins/wsz/base-2.91-5e4f10.wsz` member `VISCOLOR.TXT`, 589 bytes. Webamp's parser regex `^\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)` over lines (`utils.ts:89-101`); defaults are `baseSkin.json:8-33`. Audacious has its own default palette in `skin.cc:65-90` and skips lines with fewer than three numbers (`:166-168`).
- INI parsing: Webamp splits on any run of CR/LF, lower-cases section and key names, strips quotes, and ignores anything after a second `=` (`utils.ts:106-124`).
- Text-file encoding: one corpus `pledit.txt` has a UTF-8 BOM and LF-only endings; all others are ASCII with CRLF. Decode as latin-1 or UTF-8 tolerant, strip a BOM, and split on `\r\n|\r|\n`.
- Cursors: 24 optional `.cur` (or `.ani`, which is RIFF) names are read by Webamp: `CLOSE EQCLOSE EQNORMAL EQSLID EQTITLE MAINMENU MMENU MIN NORMAL PCLOSE PNORMAL POSBAR PSIZE PTBAR PVSCROLL PWINBUT PWSNORM PWSSIZE SONGNAME TITLEBAR VOLBAL WINBUT WSNORMAL WSPOSBAR` (`skinParser.js:10-52`). A file extension match of `CUR` with a RIFF magic is treated as animated (`skinParserUtils.ts:138-152`). base-2.91 ships 8 of them. A third of the sample skins have cursors. They are decorative and can be a late phase.

## 5. Fallback and missing-file behaviour (what implementations do)

| rule | evidence |
|---|---|
| Anything a skin omits comes from the base skin | Archived tutorial `base.html`: "The Base Skin is a copy of the default skin built into Winamp" and "Anything you don't replace will use its Base Skin counterpart" (summariser quote, see above). This is documented intent, not something I verified against Winamp itself. |
| `balance.bmp` missing: use `volume.bmp` | Audacious `skin.cc:52` (`{"balance", "volume"}`); Webamp `components/Skin.tsx:30-35` (`MAIN_BALANCE_BACKGROUND` falls back to `MAIN_VOLUME_BACKGROUND`, same for the thumb) |
| `nums_ex.bmp` missing: use `numbers.bmp` | Audacious `skin.cc:55` (`{"nums_ex", "numbers"}`). In the other direction, Audacious synthesises a 108-wide sheet with a dash from a 99-wide `numbers.bmp` (`skin.cc:175-188`: copy the 99 px, copy the 9 px at x=90 to x=99, copy the 5x1 minus at (20,6) to (101,6)). Webamp switches the time-display layout when `nums_ex` is present (`Skin.tsx:28`, `:112-118`). |
| `eq_ex.bmp` is optional | Audacious `skin.cc:195`: "eq_ex.bmp was added after Winamp 2.0 so some skins do not include it". 11% of the sampled skins lack it. |
| A missing sheet draws nothing | Webamp `Skin.tsx:59-61`: if a sprite image is absent, no CSS rule is emitted, so the element has no background. There is no per-sprite base-skin fallback in Webamp beyond the aliases above. Its `baseSkin.json` carries only the viscolors, the playlist colours and two small EQ images. |
| A missing core sheet rejects the skin | Audacious `skin.cc:191-196`: loading fails if any of the 14 pixmap ids is missing except `eq_ex` (aliases above apply). Real Winamp is documented as falling back instead. |
| Unparseable images are skipped silently | Webamp `skinParserUtils.ts:62-77` ("Like Winamp we will silently fail on images that don't parse"). |

Implementations disagree, so there is no single oracle for "what should a skin with no `titlebar.bmp` look like". The archived tutorial is the only source describing Winamp itself, and it says fall back.

## 6. Implications for the engine

1. **Two front ends, one scene graph.** The `.wms` interpreter reads layout from the skin. The classic front end has to *supply* the layout. Keep the classic layout as data (sheet, source rect, destination rect, hit rect, behaviour binding for each sprite), derived once from Webamp's `skinSprites.ts` and `skinSelectors.ts`, so the same renderer and the same MPD binding layer serve WMP, Winamp 2 and new skins. Expressing the classic layout in the same declarative form we will use for new skins gives us the generic engine the project wants.
2. **Archive loader.** Flat map keyed by lower-case basename (without directory), value = last matching zip entry; accept `/` and `\` separators; try `.bmp` then `.png`; sniff magic bytes instead of trusting the extension; never extract to disk (path-traversal safe; the survey did this).
3. **Own BMP decoder.** Needs BITMAPINFOHEADER, bottom-up rows, 4/8/16/24/32-bit, BI_RGB and BI_RLE8 (BI_RLE4 and BITFIELDS appeared zero times in 457 bitmaps but are cheap to add), palette lookup, alpha forced to 255, and a decision on whether row stride follows the spec (4-byte aligned). 8-bit palettes can be left indexed for any later palette effects. Output RGBA into an `ImageBitmap` or canvas. This also gives deterministic pixels for the oracle comparison.
4. **Sheet access with clamping.** Read each sprite as a fixed rectangle. When the sheet is smaller than the rectangle (posbar 307x4, volume 68x43, eq_ex 275x29) the engine needs a rule. The cheapest defensible rule is "treat unreadable pixels as transparent and log"; whether Winamp does something else is not known. When the sheet is larger (eqmain 690x621) ignore the extra. For `main.bmp` not 275x116 (`Old_Mac-OS` 372x460), crop top-left like a CSS background on a 275x116 element, as Webamp does.
5. **Fallback chain per file.** Order: skin file, alias (`balance`->`volume`, `nums_ex`<->`numbers`), base skin file. The base skin must not be committed (section 1 item 6). Offer a user-supplied `base-2.91.wsz` path in the app's local skins directory, and separately plan an original replacement default.
6. **Shape from `region.txt`.** Parse only the four sections. Treat a file with no active section as "no shape" (about 39% of region files). Build one path per section from the union of polygons and apply it to the window as a mask. Polygon vertices are pixel corners. Scale the mask with double size. Open questions: fill rule for overlapping polygons (union is what Webamp does through SVG `clip-path`; Winamp's Win32 region code is not documented in anything I read) and how a masked window behaves at the OS level in Tauri (transparent window, hit-testing outside the shape). The Headspace work presumably already solves this for `transparencycolor`; reuse it.
7. **Window model.** Main 275x116 and EQ 275x116 fixed, shade 275x14, playlist `(275+25n) x (116+29m)` plus shade, double size x2 for main and EQ only. Focus changes the titlebar row.
8. **Text and colours.** `pledit.txt` colour parser tolerant of missing `#`, 8-digit and trailing-space values. `viscolor.txt` per-index fallback with non-numeric lines skipped. `text.bmp` font is 5x6 cells in a fixed character grid. `numbers.bmp` and `nums_ex.bmp` for the time display.
9. **What MPD can drive.** (Design notes; I did not read `src/main.js` or the MPD client code.) Direct: play, pause, stop, prev, next, seek bar, volume, shuffle (`random`), repeat, elapsed/remaining time, marquee text from the current song, playlist window from the queue, kbps and kHz from `status`, mono/stereo from the audio format. Not native to MPD: balance, the 10-band EQ, the spectrum/oscilloscope visualiser (needs a FIFO or HTTP output of PCM, which a Tauri frontend may not have), eject (a file dialog is not meaningful for a remote MPD), and the 2.9-era media library, AVS and video windows. The engine should let a binding be "decorative" so skins render complete without the control working.
10. **Test oracle.** Webamp is the reference renderer. For Phase 2 regression, fetch the museum screenshot for each corpus skin (275x348, presumably three windows stacked at default size, from `https://r2.webampskins.org/screenshots/<md5>.png`) and diff our render. They are Webamp renders, so they share Webamp's choices (missing sprite draws nothing, polygon union), not necessarily Winamp's.
11. **Corpus as test fixture.** The 30 skins are chosen so that every row in the manifest exercises a distinct loader path: nested folders, case collision with different content (`Old_Mac-OS`), RLE8 (`base-2.91`, `Tim_Kemp`, `GRX-30`), 32-bit alpha-0 (`greenness_V2`, `Winamp_5`), mixed alpha (`RAPTOR`), 16-bit (`Weird_Amp_2`), PNG sheets (`Super-Mario...`), inert and heavy regions (`base-2.91`, `Green-Dimension-V2`, `the_CUBE_v1_by_Kuki`), minimal skins (`utsukushii_xxv`, `Zero_X_Amp`, `Yugoamp...`, `phreak`), BOM text (`Winamp_Vista_Classic`).

## 7. Open questions and unverified items

- What real Winamp 2/5 does for: a missing core sheet, an undersized sheet, a `main.bmp` of the wrong size, overlapping region polygons. All sources here are other reimplementations or an archived tutorial. No Winamp binary was run.
- Whether WKWebView decodes BMP through ImageIO (assumed, not checked), and which of ImageIO or PIL is right on 16-bit BMPs.
- The archived tutorial quotes in this doc came through a summarising fetch tool and were not checked against the raw HTML. The Webamp and Audacious line citations are from files I read directly.
- The "Skinner's Atlas" (cited in a Webamp comment at `skinParser.js:35-51` about the cursor set) was not found online in this pass; its content is only known through that comment.
- Population percentages come from a 30-block cluster sample of the approved set (section 2.3), and the 120 null `transparent_pixels` values are all active-region skins, so shape statistics derived from that field are a lower bound.
- Survey blind spots: I did not measure PNG-in-`.bmp` mismatches or BMP encodings across the 3,000 (only across the 30), and I did not render any skin.

## 8. Source index

Read directly:
- Webamp (MIT) at `88ed5815d968c201962f6549915579b3d2f93c5e`: `packages/webamp/js/{constants.ts, skinSprites.ts, skinParser.js, skinParserUtils.ts, regionParser.ts, utils.ts, selectors.ts, baseSkin.json, reducers/windows.ts, reducers/display.ts, components/Skin.tsx, components/MainWindow/index.tsx}`, `packages/webamp/css/{webamp.css, main-window.css}`. Raw: `https://raw.githubusercontent.com/captbaritone/webamp/master/<path>`.
- Audacious plugins at `ee2516c561452a33c8b90a15ae9dbc4ded1721f3`: `src/skins/skin.cc`, `src/skins/skins_util.cc`.
- Webamp skin API: https://api.webamp.org/graphql; museum https://skins.webamp.org/; assets `https://r2.webampskins.org/{skins,screenshots}/<md5>.{wsz,png}`.
- base-2.91 itself (`REGION.TXT`, `PLEDIT.TXT`, `VISCOLOR.TXT`, bitmap headers).
- Internet Archive: https://archive.org/details/winampskins; `https://archive.org/advancedsearch.php`; `https://archive.org/metadata/<id>/files`.

Read through a summarising fetch tool (treat as secondary):
- Archived Winamp skin tutorial: https://winampskins.neocities.org/ (`base.html`, `main.html`, `equalizer.html`, `playlist.html`, `twonine.html`, `config.html`, `wsz.html`). Referenced from the `wsz` Rust crate docs at https://docs.rs/wsz/latest/wsz/ as "a guide to the format".
- WACUP changelog: https://getwacup.com/changelog/beta_0_9_9_1364.html.
- Jordan Eldredge, "How winamp2-js loads native skins in your browser": https://jordaneldredge.com/how-winamp2-js-loads-native-skins-in-your-browser/.

Seen only as search results (not fetched; do not rely on): forums.wincustomize.com thread 41328 (region generator, transparency only via region.txt); O'Reilly "MP3: The Definitive Guide" ch. 4 (returned HTTP 403).
