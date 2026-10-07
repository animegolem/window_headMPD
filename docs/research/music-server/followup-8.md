# Follow-up 8: Winamp licence, library size, and whether Drive streams

Date: 2026-10-07. Resolves the critic's "small factual disagreements" across the landscape, hidden-problems, winamp-better, architecture and mpd-audit lanes. I changed no lane document; the corrections are listed in section 5 for whoever edits them.

## 0. Short answers

1. **Winamp licence.** The critic's account is itself wrong on one point. Version 1.0 already contained all three bans: no distributing modified versions, no forking, and only the maintainers may distribute. Version 1.0.1 (the day after the public release) deleted exactly one line, "No Forking", and added nothing. So 1.0.1 still forbids shipping any modified version. The clean-room conclusion stands.
2. **Library size and count.** No real conflict, only unstated units and one counting slip. Whole folder: 471.06 GB decimal, which is 438.7 GiB, which `du -h` prints as "439G". Audio only: 468.3 GB. hidden-problems' 18,362 files is an undercount by 39 (see 2).
3. **Update-storm figures.** Both are correct. One is a single day, the other is the whole log.
4. **Drive.** Google's own documentation puts the `~/Library/CloudStorage` folder in **Stream** mode, so hidden-problems' "streaming folder" is very likely right and architecture's "Drive is mirroring, not streaming" is the sentence that is wrong. I could not read the setting from the app itself. Every one of the 32,627 files is on local disk right now, but that does not tell the two modes apart.

## 1. Winamp licence (verified from the licence text itself)

**What I read.** The deleted repository `WinampDesktop/winamp` is gone, so I used two surviving copies on GitHub that share its commit history. The commit hash that Hackaday linked from the original address (`64a51755...`) is retrievable from both copies, which is how I know they hold the same upstream content.

**Version 1.0, section 5 "Restrictions", verbatim** (the copy at https://github.com/Twig6943/very-legal-winamp-fork/blob/community/LICENSE.md; GitHub's history for that file, https://github.com/Twig6943/very-legal-winamp-fork/commits/community/LICENSE.md, shows two commits authored from a winamp.com address on 2024-09-23):
- "No Distribution of Modified Versions: You may not distribute modified versions of the software, whether in source or binary form."
- "No Forking: You may not create, maintain, or distribute a forked version of the software."
- "Official Distribution: Only the maintainers of the official repository are allowed to distribute the software and its modifications."

**The change to 1.0.1.** Commit `64a51755c6f5d85039463c8bf7c2a9e98e862586`, 2024-09-25 13:30 UTC, author "winampgit" (github@winamp.com), message "Update LICENSE.md: Removing the forking language which was not clear". https://github.com/alexfreud/winamp/commit/64a51755c6f5d85039463c8bf7c2a9e98e862586 (I read it through the API, same address with `api.github.com/repos/`). The diff is 2 lines added and 3 removed:
- the title changes from "Version 1.0" to "Version 1.0.1";
- the "No Forking" line is deleted;
- a missing newline at the end of the file is added.

Nothing else changes. Even the Definitions section of the 1.0.1 file still says "version 1.0".

**What 1.0.1 therefore says** (same file at that commit): you may view and study the source (section 3); you may modify it "for private use only" (section 3); you may not distribute modified versions (section 5); only the official maintainers may distribute the software and its modifications (section 5); contributions are assigned to Winamp (section 4).

**Who said what.**
- landscape ("fork ban dropped in 1.0.1"): true, but it leaves out that the other two bans stayed. It understates the restriction.
- hidden-problems line 442 ("1.0.1 prohibits distributing modified versions"): correct. Its table row 13 ("forbids forks") is loose shorthand for 1.0.1.
- winamp-better line 81 ("forbade forks", with the two quoted lines): correct for 1.0 only, and does not say it was relaxed the next day.
- The critic's "1.0.1 deleted that sentence but added No Distribution of Modified Versions": wrong. A search summary attributed to Hackster says 1.0.1 "changed the line to" the modified-versions ban; I could not open the Hackster page (HTTP 403; https://hackster.io/news/llama-group-releases-the-winamp-source-code-but-beware-its-restrictive-license-189e1b933c42), so I only saw that summary. The diff shows nothing was added. heise has it right: 1.0.1 "deleted the sentence" about forking (https://heise.de/-9985700). Linuxiac and Hackaday are consistent with the diff (https://linuxiac.com/winamp-open-source-story-is-over/, https://hackaday.com/2024/09/28/winamp-a-few-days-later-you-can-fork-and-watch-for-gpl-violations/).

**Takedown, now checked.** On 2026-10-07 about 15:58 UTC, both `github.com/WinampDesktop/winamp` and `api.github.com/repos/WinampDesktop/winamp` return 404. A rename would redirect, so this is a deletion or a hide. heise's 2024-10-18 article says it was gone by then and that the Internet Archive holds a 2024-10-09 snapshot (about 2,700 forks); I did not see that snapshot (the archive rate-limited me). The exact deletion date is UNCONFIRMED. Copies of the code are still on GitHub today.

**What it means for us (my reading, not legal advice).** Nothing from that code can go into anything we release, whether or not forks are allowed to exist. Reading it is permitted by section 3, so the reason not to read it is contamination of a clean-room claim, not a licence ban. winamp-better's "(section 2.3)" on line 144 points to its own section 2.3, not a licence clause; the licence clauses are sections 3 and 5.

## 2. Library size and file count (measured)

Metadata only: `stat` on every file, no file contents read. Script in `/tmp/msr-followup-8/scripts/scan.py`.

| What | Files | Bytes | Decimal GB | GiB |
|---|---|---|---|---|
| Whole folder (everything `du` sees) | 32,627 | 471,062,733,214 | **471.06** | **438.71** |
| Audio files, any capitalisation, six extensions | 18,403 | 468,323,292,675 | 468.32 | 436.16 |
| Audio, lowercase extensions only (`find -name`, five types) | 18,362 | 467,951,720,960 | **467.95** | 435.81 |
| Everything that is not audio | 14,224 | 2,739,440,539 | 2.74 | 2.55 |

- **Units.** `du -shL` prints "439G" and BSD `du` counts in 1024s, so that is 439 GiB. The same bytes with `--si` print "471G". architecture's "439 GB" should read "439 GiB (471 GB)". hidden-problems' "468.0 GB" is decimal and audio only: 467.95 GB reproduces exactly from its own method.
- **The residual gap** after fixing units (471.06 minus 468.32) is the 2.74 GB of lyrics, cover art, PDFs and scans.
- **File count.** 18,362 is what a case-sensitive `find -name "*.flac"` and friends returns. It misses 21 `.FLAC` and 18 `.MP3` files (39 in all); case-insensitive, the five types give 18,401, which is also the sum of hidden-problems' own per-type list. Add 2 `.wav` for 18,403.
- **MPD's 18,404 songs** (`mpc stats`; also 18,404 `song_begin` entries in the database file) equal those 18,403 audio files plus one `.avi` video that MPD indexed. I matched every database path against the disk: one database entry has no audio-extension file (the `.avi`), and no audio file is missing from the database. The saved database contains zero `.cue/` entries.

## 3. Update-storm figures (measured, `~/.cache/mpd/log`, read only)

| Period | All lines | `update:` lines |
|---|---|---|
| 2026-08-16 | 5,912 | 5,712 |
| 2026-08-17 and 08-19 | not counted | 4,286 and 714 |
| **2026-08-21** | **1,000,669** | **974,610** |
| 2026-08-22 | 241,598 | 234,998 |
| **Whole log** | **1,255,076** | **1,220,320** (1,220,318 of them "removing") |

The five day figures add up to the whole-log figure. architecture's 974,610 of 1,000,669 is the single day 08-21; hidden-problems' 1,220,318 is the whole log. hidden-problems' 1,208,088 "between 21:00 on 08-21 and 01:00 on 08-22" also reproduces exactly. No lane is wrong; each should say which window it means.

## 4. Drive: stream or mirror

**Measured on this machine.**
- The library path is a symlink into `~/Library/CloudStorage/GoogleDrive-<account>/My Drive/Music/~~Artists~~`.
- A full census of all 32,627 files found 0 with the macOS "dataless" flag (content not on disk) and 0 with no allocated blocks. On-disk allocation is 438.8 GiB. architecture sampled 2,000 and hidden-problems 300; this replaces both.
- The data volume is 3.6 TiB with 1.2 TiB free, so there is no space pressure today.
- The `Music` folder carries only two extended attributes, a last-used date and a Drive item id. Whether that tells pinned from unpinned: UNCONFIRMED.
- I tried to copy Drive's own preference database into scratch to read the setting. The permission system denied it as credential exploration, and I did not look for another route. The setting is therefore not read from the app.

**Documented by Google.**
- On macOS 12.1 and up, "if you stream files", Drive uses Apple's File Provider; those files are in `~/Library/CloudStorage` and "you can't change this location". The older streaming method used `/Volumes/GoogleDrive`. https://support.google.com/drive/answer/12178485
- Mirrored files "are located in a folder on your computer" and you "choose where you want your My Drive files to appear". https://support.google.com/drive/answer/13401938
- The "Available offline" menu item "is only available when you're in 'Stream files' mode"; mirrored files are all on the computer already. https://support.google.com/drive/answer/16631477
- Google never writes the single sentence "mirroring never uses CloudStorage", so what follows is an inference from its documentation, not a quotation.

**Reading.**
- A library under `~/Library/CloudStorage/GoogleDrive-.../My Drive` is in **Stream** mode, by Google's documented path convention. That settles the question mpd-audit left UNCONFIRMED and hidden-problems marked [U], with one caveat: not observed in the app.
- "No dataless files" does not mean "mirror". In Stream mode a file stays on disk once opened, and MPD's first scan (2026-08-16 06:17 to 08-17 05:35, per mpd-audit) opened every file. Reading a placeholder file makes the system fetch its content (I believe the whole file; UNCONFIRMED). Mirror mode and Stream mode with everything already cached look identical to `stat`.
- In Stream mode an unpinned local file can be evicted. An Apple File Provider engineer: "FileProvider marks uploaded files as evictable in APFS, and the system will automatically evict eligible items upon low disk pressure." https://developer.apple.com/forums/thread/756058 Whether Drive's provider marks files that way, and at what free-space threshold, is UNCONFIRMED.
- Net: hidden-problems' premise holds, but the download risk is latent. Today every file is local; it becomes live if free space drops or Drive evicts.

## 5. Recommendations (mine) and what to correct

**For the owner, one 30-second check.** Drive menu-bar icon, Settings, Preferences, "My Drive syncing options": Stream or Mirror. Then right-click the `Music` folder in Finder. If "Offline access" shows and "Available offline" is ticked, it is pinned; if the item is absent entirely, it is Mirror mode.

**If Stream.** Tick "Available offline" on `Music`. It costs nothing extra (the 471 GB is already local and 1.2 TiB is free) and should stop eviction (that last part UNCONFIRMED).

**Fix ranking.** Keep hidden-problems' order. `.mpdignore`, targeted updates and log rotation do not depend on the Drive answer, because the storm and the probing are in the log either way. Pinning stays third, after the watcher change. architecture's requirement "never force a cloud download; check the dataless flag" stays, and is more necessary under Stream. The mirror-versus-reference decision in architecture 12.4 should wait for the owner's answer above.

**Corrections to the lane documents** (not applied):

| Document, line | Change |
|---|---|
| landscape.md 207 | Add: 1.0.1 still bans distributing modified versions and reserves all distribution to the maintainers. Availability: repo address returns 404 on 2026-10-07; copies persist. |
| hidden-problems.md 41 | "forbids forks" becomes "forbids distributing modified versions; only Winamp may redistribute". |
| hidden-problems.md 243, 450 | 18,362 becomes 18,401 (five types) or 18,403 (with wav); label 468.0 GB as decimal, lowercase-only. |
| hidden-problems.md 32, 247 | Say "whole log" next to 1,220,318 and 1.22 million. |
| hidden-problems.md 242, 486 | [U] becomes "Stream, per Google's documented path; not seen in the app". Pinning stays unknown. |
| winamp-better.md 81 | Add: 1.0.1 (2024-09-25) removed "No Forking"; the other two bans remain. |
| winamp-better.md 144 | "(section 2.3)" becomes "licence sections 3 and 5". |
| architecture.md 23, 82, 439, 441 | "439 GB" becomes "439 GiB (471 GB)"; say whole folder. |
| architecture.md 83 | Delete "Drive is mirroring, not streaming". Replace the 2,000-file sample with the full census. |
| mpd-audit.md 71, 375 | UNCONFIRMED becomes "Stream per Google's documented path; not seen in the app". |

**Related, not chased.** The log has 512 `Failed to open ... Operation not permitted` lines plus 191 more from the MP3 decoder, over 99 distinct files on 2026-08-31 to 09-06. Separately, 216 lines mention a CoreAudio `OSStatus` error (dates 08-20, 08-21, 08-22 and 09-08), 32 of them "Failed to open". Cause UNCONFIRMED; I did not investigate it.

## 6. Method

- Read-only on MPD: `mpc stats` only. MPD and the Drive app were not touched. I copied the MPD database and read the log, both read-only.
- Scratch: `/tmp/msr-followup-8/` (licence copies, API JSON, `scan.py`, `reconcile.py`). No repo file other than this note was written.
- UNCONFIRMED: exact deletion date of the Winamp repo; whether `Music` is pinned; whether Drive's provider marks files evictable; the Internet Archive snapshot (cited via heise, not seen).
