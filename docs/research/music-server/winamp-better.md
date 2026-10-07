# "Winamp, but better" as a standalone app

Date: 2026-10-07
Lane: WINAMP, BUT BETTER AS A STANDALONE APP (music-server research, lane `winamp`)
Status: research draft. Nothing committed; this is the only file written inside any repo, and no MPD setting was touched. Scratch work is in `/tmp/msr-winamp/`.

How to read the tags. **VERIFIED** means I read it in a primary source or a local file. **COMPUTED** means I calculated it from published formulas with `/tmp/msr-winamp/analysis.py` (results in `/tmp/msr-winamp/results.json`). **UNCONFIRMED** means I could not check it. Where a page was read through a summarising fetch tool, or only as a search-result snippet, the source list says so, and the claim is flagged. Sections 1 to 4 are facts and calculations; sections 5 to 8 are recommendations. The few recommendations that sit inside sections 1 to 4 are labelled "Recommendation".

---

## 0. Bottom line

1. **Winamp's equalizer is a ten-slider graphic EQ, and its control surface is exactly known.** Bands 60, 170, 310, 600 Hz, 1, 3, 6, 12, 14, 16 kHz. Each slider is a 6-bit value, 0 = +12 dB, 31 = 0 dB, 63 = -12 dB. Preamp uses the same scale. (VERIFIED, section 4.1.)
2. **What filters Winamp runs behind those sliders is not documented anywhere I could read.** The only public reference model is Webamp's (a low shelf, eight peaking filters, a high shelf, all in series). Webamp chose those filters; Winamp's own may differ. There is no Winamp on this machine to measure. (UNCONFIRMED, section 4.2.)
3. **The current app's EQ cannot play Winamp presets.** Its ten fixed bands (31 Hz to 16 kHz) miss the stock "Full Treble" preset by 12.5 dB at the worst frequency even with the best least-squares gains inside its +/-14 dB limit, and an unlimited fit would ask 30 dB of one band. One EQ engine cannot serve both skin families (.wsz uses Winamp's bands, .wmz uses WMP's) while the interface is "ten fixed bands". (COMPUTED, section 4.5.)
4. **Recommendation: the server's EQ should be a list of arbitrary filter sections ("parametric"), and each skin family gets a thin mapping from its ten sliders onto sections.** Winamp-style sliders become a compatibility layer on top, not the engine. This also gives the owner headphone correction (AutoEq profiles) with no extra machinery. (Section 5.2.)
5. **Hi-res is currently lost before the EQ runs.** MPD's "Headspace" output is forced to 44.1 kHz / 16-bit, so everything is converted to CD format first. (VERIFIED from `mpd.conf` and `audio.rs`.)
6. **The same filter produces a different curve at 44.1 kHz than at 96 kHz** with the textbook formula. A 16 kHz peak differs by up to 8 dB at 20 kHz between 44.1 kHz and a high-rate reference. If the math is to be formally verified, "which curve is correct" has to be decided first. (COMPUTED, section 4.4.)
7. **What aged worst in Winamp is not the player but its packaging**: tiny fixed-pixel skins on high-DPI screens, Windows-only and DirectX 9, skins that can carry code, and a plug-in DLL model that modern OS security fights. A server-plus-skin-face design fixes most of these by construction. (Section 2.3.)
8. **Right now, for headphones**: several MIT-licensed macOS apps apply a system-wide parametric EQ and import AutoEq profiles. One short paragraph in section 6. I did not install anything.

---

## 1. Where the project stands today (local facts)

All VERIFIED by reading the files, or by read-only commands, on 2026-10-07.

| Topic | What I found | Where |
|---|---|---|
| How the app gets audio | MPD writes to a FIFO output named "Headspace" with `format "44100:16:2"`, `enabled "no"` in the config. At the time I looked: Visualizer FIFO enabled, OS X Output enabled, Headspace disabled (`mpc outputs`). The app enables Headspace and disables the speaker output while it runs, and restores them on exit. | `/opt/homebrew/etc/mpd.conf`, `outputs.rs`, `mpc outputs` |
| What that means | MPD's per-output `format` setting says "always open the audio output with the specified audio format, regardless of the format of the input file". So every track reaches the app as 44.1 kHz, 16-bit stereo. A 24/96 file is converted before the app ever sees it. | MPD manual (user docs), `audio.rs` line 31 (`IN_RATE = 44100`) |
| The app's EQ | Ten peaking filters at 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz (WMP's band centres), all with Q 1.41, gains clamped to +/-14 dB, run in series per channel in 32-bit float. A "headroom trim" lowers the whole signal by 0.6 x the largest boost, and a soft clipper rounds off peaks above 0.7 of full scale. Balance is separate. | `eq.rs` lines 7-13, 75, 83, 114-125 |
| The engine's DSP interface | `DspPort.eq` is `gains()`, `setGain(band, dB)`, `reset()`, `bypass`, plus balance. Fixed ten bands, no frequency or Q. | `ENGINE.md` line 1593 |
| MPD on this machine | Installed binary is MPD 0.24.15 (Homebrew). It has the `osx`, `fifo`, `httpd`, `snapcast` outputs, an ffmpeg decoder, and a Qobuz input plug-in. Its "Filters" line names `libsamplerate` and `soxr`, which are resamplers; whether the FFmpeg filter-graph plug-in (the one that could do EQ) is built in is UNCONFIRMED from here. `mpc version` printed 0.24.0, which is the protocol version, not the program version, so I cannot tell from here whether the running daemon is the same build as the installed binary. | `mpd --version`, `mpc version` |
| What MPD already does | Crossfade (needs both songs in the same format), MixRamp gapless crossfading, ReplayGain (track, album or auto; preamp; clipping limit), a crude "volume normalization". The user manual contains no equalizer. | MPD manual (user, plugins pages) |
| Related projects | `nowplayd` already bridges MPD to macOS Now Playing, media keys and AirPods gestures. `RMPC-Auto-Theme` derives a colour theme from album art. | `~/git/nowplayd` README and SPEC, `~/git/RMPC-Auto-Theme` README |
| Skin corpus | Classic skins have no layout file: they are fixed-name bitmap sheets read at fixed positions. 93,603 skins are in the Webamp museum; a 3,000-skin sample is the project's corpus. | `docs/research/winamp2-corpus.md` |

---

## 2. What Winamp and WACUP actually do

Winamp here means the 2.x line (1998) and the 5.x line (2003 to 5.9.x, 2022-2024). WACUP is the community project that replaces Winamp's pieces one at a time. As of today (2026-10-07) its newest public preview is 1.99.55, build 25130, dated 2026-09-30, for 32-bit and 64-bit Windows. It is built by one developer, is free, and says plainly that it is not open source. It aims to become its own player that still loads Winamp plug-ins. (VERIFIED: WACUP home page.)

### 2.1 Feature inventory

| Area | Winamp 2.x / 5.x | WACUP | Evidence |
|---|---|---|---|
| Plug-in model | Seven plug-in kinds: input (decoders), output, visualisation, DSP/effect, general purpose, media library, portables. | Same model, kept compatible. Replaced roughly 70-75% of Winamp's own plug-ins and DLLs by Dec 2019; by preview 1.99.11 it no longer needs Winamp 5.666's own program file. | Wikipedia (Winamp, SDK section); WACUP blog "200 weeks"; WACUP 1.99.11 changelog |
| Playback and formats | Input plug-ins per format. 5.9 added https streams and hi-res (24-bit, 192 kHz) playback. | New native inputs (for example a FLAC plug-in, an experimental Shorten plug-in). Multichannel files handled, with a surround on/off option. | Neowin 5.9 snippet (UNCONFIRMED, search snippet only); WACUP 25130 changelog |
| Output | Output plug-ins; DirectSound is the classic one (search-result snippets only, UNCONFIRMED in detail). | Own output plug-ins named in the changelog: "notsodirect", "notsoyasapi" (WASAPI, now with basic balance) and "notsowavey". | WACUP 1.99.11 and 25130 changelogs |
| Equalizer | Ten-band graphic EQ, preamp, ON and AUTO buttons, presets (`.eqf`), a spline curve drawn above the sliders. Range +/-12 dB. | Native EQ since preview 1.99.11, with switchable "frequency bands" and "limiter" options on the ON button menu (what the alternative bands are: UNCONFIRMED). In the latest build the author fixed "the equaliser not working well with more than 2 channels" and admits stereo handling was likely never right before. | `in2.h`; Webamp; WACUP 1.99.11 and 25130 changelogs |
| Gapless | Gapless for MP3 and AAC in 5.x. | Handles the iTunes gapless tag in its MP4 input; a fix for it appears in the changelog. | Wikipedia (Winamp); WACUP 1.99.11 changelog |
| Crossfade | Search snippets describe crossfade as a setting of the DirectSound output plug-in (UNCONFIRMED). Modern skins have crossfade controls (a WACUP fix mentions "the skin crossfading controls", which the null output does not support). | Same skins and controls. | WACUP 1.99.11 changelog |
| ReplayGain | In 5.x. | Own ReplayGain scanning that writes tags; input plug-ins react live when the preference is toggled; bug fixes for MP3 and AAC. | Wikipedia (Winamp); WACUP changelogs |
| Media library | Local media views (audio, video, date, frequency), playlists, CD import and burn, podcast RSS, album art, auto-tagging. | Own replacement library plug-in; library playlists with "remove missing" and duplicate reports. | Wikipedia (Winamp); WACUP 25130 changelog |
| Visualisation | Spectrum and oscilloscope built in. Plug-ins: MilkDrop (by Ryan Geiss, DirectX 9) and AVS (Advanced Visualization Studio). | Ships MilkDrop; its changelog handles a missing "DirectX 9.0c". | Winamp corpus doc (`viscolor.txt` entries); Geiss's MilkDrop page; WACUP 1.99.11 changelog |
| Global hotkeys | A "Global Hotkeys" general plug-in (Preferences > General Preferences > Global Hotkeys). Primary page: UNCONFIRMED, search snippets only. | Same plug-in, with an action to toggle every embedded window, and notes about running under WINE. | WACUP 1.99.11 and 25130 changelogs |
| Classic skins | Bitmap sheets in a renamed zip, 275 x 116 main window, optional `region.txt` polygon shapes, 1x or 2x size. | Adds PNG sheets for classic skins (beta 1364) and a surround-indicator row in the skin image. | Winamp corpus doc; WACUP changelogs |
| Modern skins | Winamp 3's "Wasabi" skin engine reached Winamp 5 as `gen_ff`: XML layouts, PNG art with real alpha, scripts in a compiled language called MAKI. | Carries modern-skin support; the 4K post names the Big Bento modern skin as the one that copes with high DPI. The author calls modern-skin support "a hefty task on its own". | Wikipedia (Winamp); WaSDP readme snippet; WACUP blogs (Dec 2019, Jan 2020) |

### 2.2 What people still love

- **Skins as self-expression.** The Webamp skin museum is the strongest evidence: it holds 93,603 skins and its launch thread on Hacker News drew almost 700 points. A reimplementation of Winamp 2.9 in HTML5 (Webamp) is itself a perennial hit (the original thread, 622 points). (VERIFIED from the Hacker News listing and the local corpus doc.)
- **The efficient, unfussy feel.** One commenter on the 2024 source-release thread: "The only music player that wasn't annoying. Just did its job with a streamlined interface, without the clutter and clunky graphics that competitors thought was the way to go." (Hacker News, item 41636804.)
- **Visualisers as part of the ritual.** A commenter on the Swift-for-macOS Winamp clone: "seeing the visualizations here reminded me of how great it was to load up some music in Winamp … turn on the geiss visualizer". (Hacker News, item 45926224.)
- **The playlist editor and window docking** as a compact, always-there control surface (Winamp 2.x was described as modular windows that dock together). (Wikipedia.)
- **Plug-ins and community upkeep.** WACUP exists because people wanted it to continue. Its author argues "what makes Winamp Winamp is a hard question to answer", and that many people just want the skins. (WACUP blog, Dec 2019.)

### 2.3 What aged badly

| Problem | Evidence |
|---|---|
| **High-DPI.** The classic skin is a 275 x 116 bitmap design with only 1x and 2x sizes. The WACUP author on a 4K monitor: classic skins in normal mode are "unusable", modern skins are "blurry to different degrees", and he lists a dozen scaling faults in the player and its preferences. | WACUP blog, 2020-01-09 |
| **Windows-only, DirectX 9.** BleepingComputer says the 2024 source release "uses DirectX 9 SDK". MilkDrop needs DirectX 9.0c. | BleepingComputer, 2024-09-25; Geiss; WACUP changelog |
| **Skins can be code.** Winamp 5.55 had a stack buffer overflow (CVE-2009-1831) triggered by a crafted MAKI script in a skin. | Rapid7 module page |
| **Skins are hostile archives.** A scan of the museum's raw collection found 127 skins nested inside other skins, encrypted zips, personal files, and an executable worm game. | Jordan Eldredge, "Investigating corrupt Winamp skins" (2024-07) |
| **The plug-in DLL model fights modern OS security.** WACUP's own changelog adds a dialog because Windows "Smart App Control" can make plug-in loading "sit for almost a minute & appearing to be broken". | WACUP 25130 changelog |
| **The rewrite and the bloat.** Winamp 3 was a full rewrite that "consumed too many system resources and was unstable"; users went back to 2.x. Later versions were seen as bloated. | Wikipedia (Winamp) |
| **The EQ itself is limited.** Ten fixed bands, no control over width, no per-channel setting, and one broad preamp as the only headroom tool. A competing plug-in vendor's page says the "standard winamp equalizer has only -6dB...+6dB" of range, which contradicts the +/-12 dB in Winamp's SDK. I treat that as an unverified vendor claim. | `in2.h`; yohng.com page (UNCONFIRMED) |
| **A licensing tangle.** The 2024 source release forbade forks ("No Forking", "Only the maintainers of the official repository are allowed to distribute"), per a quote of the licence file in the discussion thread. By mid-October 2024 the repository had been deleted; a check of the GitHub address on 2026-10-07 returns "Not Found". | Hacker News items 41636804, 41861056; GitHub API check |

---

## 3. What modern expectations add

| Expectation | What the market shows | Notes for us |
|---|---|---|
| **Parametric EQ and one-click headphone correction** | AutoEq publishes correction for thousands of headphones in several shapes, including a ten-band graphic preset and a parametric list. Equalizer APO's text format (`Filter 1: ON PK Fc 105 Hz Gain 2.5 dB Q 0.70`, plus `Preamp:`) is what the tools I read about import. | This is the owner's immediate need, and the reason the engine must be parametric (section 5.2). |
| **System-wide EQ on macOS without a driver** | Several MIT-licensed menu-bar apps use Apple's Core Audio "process tap" (macOS 14.4 or later) and import AutoEq files. One lists 15 filter types, 5/10/15/31-band layouts, convolution, a limiter, and 5-10 ms added delay. | Sets the bar: per-device profiles, automatic headroom, a limiter. |
| **Loudness leveling, gapless and "sweet" fades** | Plexamp advertises gapless, "Sweet Fades", loudness leveling, sample-rate matching, offline downloads, and a ten-band equalizer. Even the paid incumbent still ships a ten-band graphic EQ. | Ten sliders remain the expected face; parametric is the expert upgrade behind it. |
| **Lossless and hi-res** | Apple's support page says most Macs need an external DAC above 48 kHz, with some MacBook Pro models doing up to 96 kHz natively (read through a summarising tool, UNCONFIRMED wording). MPD already handles DSD and has an `osx` output with "hog" (exclusive) mode. | Need a bit-perfect path that sets the device rate, and honest labelling when EQ or volume breaks bit-perfection. |
| **Library sync and open APIs** | OpenSubsonic is a REST API with optional extensions (ReplayGain, lyrics, transcoding profiles) that existing servers and apps share. | A server that can also speak it gets phone clients for free. UNCONFIRMED which servers implement which extensions. |
| **Now-playing and media-key integration** | macOS routes media keys, Control Center and the lock screen only to apps registered through Apple's media framework. | The owner already has `nowplayd`. Keep this in the server, not each skin. |
| **Mini-player and global hotkeys** | Tauri provides a global-shortcut plug-in on Windows, Linux and macOS, with no feature enabled until the app grants it. | The classic skin's "windowshade" view and WMP's compact mode are the mini-player, supplied by the skin engine. |
| **Synced lyrics, scrobbling** | WACUP's changelog tracks an online lyrics lookup; OpenSubsonic has structured-lyrics endpoints. | Optional extras, not core. |

---

## 4. Winamp's graphic EQ, exactly (control surface)

### 4.1 Facts (VERIFIED unless marked)

**Band centres.** 60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000 Hz. Sources: Webamp's constants, and the preset field names in the `.eqf` parser (hz60 to hz16000).

**Slider scale.** Winamp's plug-in header describes the equalizer call: `EQSet(int on, char data[10], int preamp)` with the comment "0-64 each, 31 is +0, 0 is +12, 63 is -12". (The comment says 0-64 but the endpoints given are 0 and 63, so the range is 64 values.) DrO, the WACUP author, wrote in a direct message quoted in the Webamp `.eqf` README that for the preamp slider "-12dB = 0x3F, 0dB = 0x1F, 12dB = 0 (so a 0-63 range) that seems to be the same for the other sliders (and matches 1:1 with the sdk details)". He hedged ("seems", and elsewhere "need to double-check the range base"), so treat it as strong corroboration, not a measurement.

Two things to carry forward:
- **Neutral is 31, not 32.** An older web post about the `.eqf` format says neutral is 0x20. The SDK header and DrO say 0x1F (31). I follow the SDK.
- **The in-between values are my assumption.** The sources give three anchor points. I assume straight lines between them, which means one step is 12/31 = 0.387 dB above neutral and 12/32 = 0.375 dB below, so the slider is very slightly asymmetric (UNCONFIRMED whether Winamp does exactly that). Webamp instead maps its own 1-64 domain linearly onto 0-100 and then to -12...+12 dB; Webamp's "neutral" (value 33) therefore lands at +0.19 dB before its snap-to-centre zone catches it.

**`.eqf` file layout.** Header text `Winamp EQ library file v1.1`, a Ctrl-Z byte, `!--`, then per preset: a 257-byte name field (256 plus a terminator), 10 bytes for the sliders in ascending frequency order, 1 byte for the preamp. Several presets can follow one another in a file (the `winamp.q1` file works this way). Each byte is inverted: value = 64 - byte in Webamp's reader, so it reads 1-64 with 33 as neutral.

**The spline graph is only a drawing.** Webamp draws the curve above the sliders as a natural cubic spline through the ten points on a 113 x 19 pixel canvas. Nothing says Winamp's sound follows that curve (UNCONFIRMED), and Webamp's sound does not.

**The stock presets.** Webamp ships Winamp's 17 built-in presets as data (every one has the preamp at neutral). I converted them to dB with the rule above:

| Preset | 60 | 170 | 310 | 600 | 1k | 3k | 6k | 12k | 14k | 16k | Peak of the combined curve (dB @ Hz) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Classical | 0 | 0 | 0 | 0 | 0 | 0 | -4.9 | -4.9 | -4.9 | -6.4 | -0.0 @ 20 |
| Club | 0 | 0 | +1.9 | +3.5 | +3.5 | +3.5 | +1.9 | 0 | 0 | 0 | +6.1 @ 731 |
| Dance | +5.8 | +4.3 | +1.2 | -0.4 | -0.4 | -4.1 | -4.9 | -4.9 | -0.4 | -0.4 | +5.8 @ 20 |
| Laptop speakers/headphones | +2.7 | +6.6 | +3.1 | -2.6 | -1.9 | +0.8 | +2.7 | +5.8 | +7.7 | +8.9 | +14.2 @ 13670 |
| Large hall | +6.2 | +6.2 | +3.5 | +3.5 | 0 | -3.4 | -3.4 | -3.4 | 0 | 0 | +8.0 @ 183 |
| Party | +4.3 | +4.3 | 0 | 0 | 0 | 0 | 0 | 0 | +4.3 | +4.3 | +5.3 @ 14649 |
| Pop | -1.5 | +2.7 | +4.3 | +4.7 | +3.1 | -1.1 | -1.9 | -1.9 | -1.5 | -1.5 | +7.7 @ 587 |
| Reggae | 0 | 0 | -0.8 | -4.1 | 0 | +3.9 | +3.9 | 0 | 0 | 0 | +5.0 @ 5497 |
| Rock | +4.7 | +2.7 | -3.8 | -5.2 | -2.6 | +2.3 | +5.4 | +6.6 | +6.6 | +6.6 | +13.7 @ 13205 |
| Soft | +2.7 | +0.8 | -1.1 | -1.9 | -1.1 | +2.3 | +5.0 | +5.8 | +6.6 | +7.3 | +13.1 @ 13358 |
| Ska | -1.9 | -3.4 | -3.0 | -0.8 | +2.3 | +3.5 | +5.4 | +5.8 | +6.6 | +5.8 | +12.9 @ 13205 |
| Full Bass | +5.8 | +5.8 | +5.8 | +3.5 | +0.8 | -3.0 | -5.6 | -6.8 | -7.1 | -7.1 | +9.3 @ 287 |
| Soft Rock | +2.3 | +2.3 | +1.2 | -0.8 | -3.0 | -3.8 | -2.6 | -0.8 | +1.6 | +5.4 | +5.4 @ 20000 |
| Full Treble | -6.4 | -6.4 | -6.4 | -3.0 | +1.6 | +6.6 | +9.7 | +9.7 | +9.7 | +10.4 | +20.6 @ 13205 |
| Full Bass & Treble | +4.3 | +3.5 | 0 | -4.9 | -3.4 | +0.8 | +5.0 | +6.6 | +7.3 | +7.3 | +14.4 @ 13358 |
| Live | -3.4 | 0 | +2.3 | +3.1 | +3.5 | +3.5 | +2.3 | +1.6 | +1.6 | +1.2 | +5.9 @ 810 |
| Techno | +4.7 | +3.5 | 0 | -3.8 | -3.4 | 0 | +4.7 | +5.8 | +5.8 | +5.4 | +11.9 @ 13205 |

The slider columns are VERIFIED data converted by the rule above. The last column is COMPUTED with the reference model of section 4.2 at 44.1 kHz and is the highest point of the combined curve with the preamp at neutral. Section 4.5 uses the same curves to test what today's app could reproduce.

### 4.2 What Winamp's filters really are: UNCONFIRMED

In the SDK header, `EQSet` sits under the heading "eq stuff" in the structure each input plug-in fills in, and the comment ends "Do nothing to ignore." So Winamp hands the ten values and the preamp to the input plug-in, which may apply the EQ itself or ignore it. Whether Winamp 5's own core also applies an EQ for formats whose plug-in ignores it is UNCONFIRMED (WACUP's changelog says it later implemented the EQ in its own core). The header tells me what the controls are, not what the filters are. I found no public description of Winamp's own equalizer filters (type, width, or whether the end bands are shelves). A search for measurements turned up nothing usable.

The Winamp source code was published in 2024 and mirrors exist, but I did not read any of it, on purpose: its licence forbids derived distributions (section 2.3), and a reimplementation that never looked at it keeps a clean position. **Recommendation: keep it that way** and settle the question by measurement (section 4.6).

What does exist is a working model by Webamp (MIT licence, VERIFIED from its source): a chain of ten browser filters in this order, with the preamp as a plain gain in front.

| Band | Filter type | Width setting |
|---|---|---|
| 60 Hz | low shelf | the browser's fixed slope (S = 1) |
| 170, 310, 600, 1k, 3k, 6k, 12k, 14k Hz | peaking | Webamp sets no width, so the browser default Q = 1 applies (default confirmed by the spec's formulas) |
| 16 kHz | high shelf | S = 1 |

I call this the **reference model** below. It is a good, standard, inspectable starting point. It is not known to equal Winamp.

One hint that it may differ: under this model the stock "Full Treble" preset would add up to +20.6 dB near 13 kHz with the preamp untouched, which seems a lot for a shipped preset. That is an inference, not evidence.

### 4.3 The filter formulas (for whoever writes and verifies the code)

A "biquad" is the small digital filter section these EQs are built from: five numbers per section, processing each sample from the previous two. The formulas below are the ones in the W3C Web Audio specification, which derives them from the widely used "Audio EQ Cookbook" (VERIFIED, read from the spec text).

```
A  = 10^(gain_dB / 40)
w0 = 2 * pi * f0 / fs                      (fs = sample rate)
Peaking, width Q:   alpha = sin(w0) / (2*Q)
    b0 = 1 + alpha*A    b1 = -2*cos(w0)    b2 = 1 - alpha*A
    a0 = 1 + alpha/A    a1 = -2*cos(w0)    a2 = 1 - alpha/A
Low shelf, slope S (S = 1 gives alpha_S = sin(w0)/sqrt(2), equivalent to Q = 0.7071):
    alpha_S = sin(w0)/2 * sqrt((A + 1/A)*(1/S - 1) + 2)
    b0 =    A*[(A+1) - (A-1)*cos(w0) + 2*sqrt(A)*alpha_S]
    b1 =  2*A*[(A-1) - (A+1)*cos(w0)]
    b2 =    A*[(A+1) - (A-1)*cos(w0) - 2*sqrt(A)*alpha_S]
    a0 =       (A+1) + (A-1)*cos(w0) + 2*sqrt(A)*alpha_S
    a1 =    -2*[(A-1) + (A+1)*cos(w0)]
    a2 =       (A+1) + (A-1)*cos(w0) - 2*sqrt(A)*alpha_S
High shelf (same alpha_S):
    b0 =    A*[(A+1) + (A-1)*cos(w0) + 2*sqrt(A)*alpha_S]
    b1 = -2*A*[(A-1) + (A+1)*cos(w0)]
    b2 =    A*[(A+1) + (A-1)*cos(w0) - 2*sqrt(A)*alpha_S]
    a0 =       (A+1) - (A-1)*cos(w0) + 2*sqrt(A)*alpha_S
    a1 =     2*[(A-1) - (A+1)*cos(w0)]
    a2 =       (A+1) - (A-1)*cos(w0) - 2*sqrt(A)*alpha_S
Output: a0*y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
```

Two facts that follow directly and are worth keeping as proof obligations. At 0 dB, A = 1 and the numerator equals the denominator, so a flat slider is an exact pass-through (COMPUTED, holds for all three types). At its own centre a peaking section shows exactly its slider gain (COMPUTED to 1e-12 dB), and a shelf shows exactly half (6.000 dB for +12).

**Test vectors** (reference model, fs = 48000 Hz, one slider at +6 dB, other sliders flat, coefficients divided by a0; COMPUTED with `/tmp/msr-winamp/vectors.py`):

| Band | Type | b0 | b1 | b2 | a1 | a2 |
|---|---|---|---|---|---|---|
| 60 | low shelf | 1.0019295335 | -1.9906328729 | 0.9887900665 | -1.9906545032 | 0.9906979697 |
| 170 | peaking Q 1 | 1.0077777153 | -1.9838792182 | 0.9765928064 | -1.9838792182 | 0.9843705218 |
| 310 | peaking Q 1 | 1.0140895339 | -1.9700636793 | 0.9575972593 | -1.9700636793 | 0.9716867932 |
| 600 | peaking Q 1 | 1.0268939080 | -1.9399574079 | 0.9190622332 | -1.9399574079 | 0.9459561412 |
| 1000 | peaking Q 1 | 1.0439530870 | -1.8953207239 | 0.8677222848 | -1.8953207239 | 0.9116753718 |
| 3000 | peaking Q 1 | 1.1187341242 | -1.6273226524 | 0.6426672220 | -1.6273226524 | 0.7614013463 |
| 6000 | peaking Q 1 | 1.1992413635 | -1.1311024326 | 0.4003790371 | -1.1311024326 | 0.5996204006 |
| 12000 | peaking Q 1 | 1.2601941901 | 0.0000000000 | 0.2169402574 | 0.0000000000 | 0.4771344475 |
| 14000 | peaking Q 1 | 1.2535872703 | 0.3857468005 | 0.2368239177 | 0.3857468005 | 0.4904111881 |
| 16000 | high shelf | 1.2695171859 | 0.5503485750 | 0.2602410402 | 0.7946195937 | 0.2854872074 |

### 4.4 What the numbers say about this design (all COMPUTED, reference model unless stated)

**The bands are unevenly spaced.** Gaps in octaves from one band to the next: 1.50, 0.87, 0.95, 0.74, 1.58, 1.00, 1.00, **0.22, 0.19**. The top three bands (12, 14, 16 kHz) sit inside 0.41 of an octave. A Q = 1 peak is 1.39 octaves wide, so these three overlap almost completely: raising 14 kHz also raises 12 kHz's centre by 73% of the amount.

**Sliders interact.** When several sliders are raised, each filter's tails add to its neighbours. Examples at 44.1 kHz:

| Setting | Combined curve |
|---|---|
| All sliders +12 dB | a lumpy boost from +8.2 dB (lowest point, near 76 Hz) to +25.7 dB (highest point, near 13 kHz). At 48 kHz the peak is +26.9 dB, at 96 kHz +30.6 dB |
| All sliders -12 dB | mirror image |
| One slider at +12, rest flat | exactly +12 at its own centre. The 60 Hz slider also lifts 20 Hz by +11.8 dB (it is a shelf). The 16 kHz slider lifts 20 kHz by +11.8 dB at 44.1 kHz, but only +8.3 dB at 192 kHz |

**Making the sliders hit their targets exactly ("compensation") has a limit.** One can solve for the internal filter gains that make the combined curve pass through every slider value at the ten centres (the standard method in the engineering literature for cascade graphic EQs; see Välimäki and Reiss 2016). The matrix involved has a condition number of 11.9, which is manageable for typical settings: the Rock preset needs internal gains of at most 8.4 dB and Full Treble at most 13.6 dB. But a zig-zag in the top three bands (12k +12, 14k -12, 16k +12) needs internal gains of **+59, -71 and +79 dB**, which no real implementation should attempt. For comparison, the layout AutoEq uses for its ten-band graphic EQ (31.25 Hz doubling to 16 kHz, Q = 1.414) has a condition number of 2.0 and at most 18% leakage into a neighbour.

**The textbook filter changes with sample rate.** The standard formula squeezes the response near the top of the band at low sample rates. The worst difference, anywhere from 20 Hz to 20 kHz, against a 384 kHz reference:

| Filter | 44.1 kHz | 48 kHz | 96 kHz | 192 kHz |
|---|---|---|---|---|
| 16 kHz peak, Q 1, +12 dB | 7.96 dB (at 20 kHz) | 6.17 | 0.91 | 0.16 |
| 14 kHz peak | 6.71 | 5.59 | 1.08 | 0.20 |
| 12 kHz peak | 5.17 | 4.45 | 0.99 | 0.19 |
| 8 kHz peak | 2.55 | 2.19 | 0.56 | 0.11 |
| 16 kHz high shelf | 3.60 | 3.06 | 0.51 | 0.09 |

So "the Winamp EQ" would sound and measure differently on a 44.1 kHz file and a 96 kHz file, unless the design says otherwise. Published alternatives that keep the response the same at every rate exist (for peaking filters: Orfanidis 1997; Vicanek 2016, which gives closed-form matched peaking coefficients and states the problem plainly: the bilinear transform warps response towards Nyquist).

**Single-precision rounding is fine at CD rate, not at high rates.** Rounding a 31 Hz, Q 1.41, +12 dB filter's coefficients to 32-bit floating point moves its response by 0.001 dB at 44.1 kHz, 0.11 dB at 96 kHz and 0.20 dB at 192 kHz (62 Hz: 0.006, 0.03, 0.12 dB). That measures coefficient rounding only, not the running arithmetic. It is a reason to compute coefficients in double precision and to decide the state precision deliberately.

**The app's own EQ boosts more than its trim removes.** With every slider at +12 dB its combined curve peaks at +18.4 dB, the headroom trim takes off 7.2 dB, and a net +11.2 dB remains; at +14 dB the figures are +21.9, 8.4 and +13.5 dB (COMPUTED from the code in `eq.rs`). Loud material will therefore reach the soft clipper. Lowering by the full peak, as AutoEq's approach does, would leave no net boost.

**The app already almost equals AutoEq's ten-band layout.** AutoEq's graphic preset is peaking filters at 31.25 x 2^n Hz with Q = sqrt(2), +/-12 dB (VERIFIED from its source). The app uses 31, 62, 125… with Q 1.41. Across 200 random settings the two differ by at most 0.24 dB (COMPUTED).

### 4.5 Fitting Winamp presets onto the app's present bands (COMPUTED)

The question: could today's app (ten peaking filters at 31 to 16000 Hz, Q 1.41, +/-14 dB) load a Winamp preset and sound the same? I took the reference-model curve for each stock preset and found, by least squares between 30 Hz and 16 kHz, the ten app-band gains that come closest. This tests the band layout, not Winamp itself (the target is the reference model of section 4.2).

| Preset | Largest band gain an unlimited fit asks for (dB) | Worst error, best fit within +/-14 dB (dB) | Typical (RMS) error, same fit (dB) |
|---|---:|---:|---:|
| Classical | 14.4 | 6.0 | 1.1 |
| Club | 4.8 | 1.0 | 0.4 |
| Dance | 6.5 | 3.2 | 0.9 |
| Laptop speakers/headphones | 21.6 | 7.6 | 1.7 |
| Large hall | 6.9 | 2.1 | 0.8 |
| Party | 7.5 | 2.5 | 0.6 |
| Pop | 6.5 | 2.0 | 0.6 |
| Reggae | 5.3 | 1.4 | 0.5 |
| Rock | 19.3 | 7.0 | 1.6 |
| Soft | 18.8 | 6.5 | 1.4 |
| Ska | 17.9 | 6.3 | 1.4 |
| Full Bass | 20.6 | 7.5 | 1.7 |
| Soft Rock | 4.5 | 1.1 | 0.4 |
| Full Treble | 30.1 | 12.5 | 2.8 |
| Full Bass & Treble | 20.9 | 7.6 | 1.7 |
| Live | 4.6 | 1.8 | 0.5 |
| Techno | 16.5 | 5.8 | 1.4 |

The mild presets (Club, Soft Rock, Live, Reggae, Pop) fit within about 1 to 2 dB. The strong ones do not: Rock is off by up to 7.0 dB at the worst frequency, Full Bass by 7.5, Laptop speakers/headphones by 7.6, and Full Treble by 12.5 dB, with one band asked for 30 dB if the limit is lifted (and even then the least-squares fit is still 15 dB off at its worst point; that is larger than the limited fit's 12.5 dB because least squares minimises the average error, not the worst one). The cause is structural: the reference model's end bands are shelves that reach to the edge of the spectrum, which a peaking filter at 31 Hz or 16 kHz cannot reproduce, and its 12, 14 and 16 kHz bands sit 0.2 octave apart, where the app has one band.

### 4.6 How to settle "what does Winamp really do" (recommendation)

Measure it. A sweep or noise test: for each of the ten sliders at +12, +6, -6 and -12 dB (and the preamp), play a known test file through real Winamp or WACUP with its output captured, divide the output spectrum by the input spectrum, and fit each band's type, width and gain to the result. Whether Winamp's "disk writer" output passes through the built-in EQ is UNCONFIRMED; a loopback capture avoids the question. The result becomes a small data table (type, Q or slope per band), which the verified math then implements. If it turns out to match the reference model, we have Webamp's behaviour confirmed for free.

---

## 5. Mapping onto filters, and what to build

### 5.1 Exact mapping, in tiers of certainty

| Layer | Definition | Status |
|---|---|---|
| Slider value to dB | 0 to +12, 31 to 0, 63 to -12, straight lines between | anchors VERIFIED, line shape assumed |
| dB to filter gain | `gain_dB` of one section per band, sections in series | Webamp reference, not confirmed as Winamp |
| Filter shapes | low shelf, 8 peaking, high shelf; peaking Q = 1, shelf S = 1 | Webamp reference, to be replaced by measured values |
| Coefficients | formulas of section 4.3 | exact for the chosen model |
| Preamp | plain gain, `10^(dB/20)`, same scale as sliders | Webamp; matches the SDK scale |

### 5.2 Recommended design

1. **"Slider = filter gain" (Winamp and Webamp semantics) is the compatibility rule.** Every stock preset was authored against interacting filters, so any other rule changes how presets sound. **"Slider = response at the centre" (the compensation method) must not be the default**: it is ill-conditioned above 12 kHz (section 4.4).
2. **The parametric mode is a separate mode, not a reinterpretation of the ten sliders.** It is a list of sections, each with type (peak, low shelf, high shelf, plus high-pass, low-pass and notch for completeness), frequency, gain, and Q or slope, an on/off flag, a master preamp, and optional separate left and right lists.
3. **Skin families map onto it on the client side:**

   | Face | Ten sliders become |
   |---|---|
   | Classic `.wsz` | the Winamp profile: shelf, 8 peaks, shelf at 60…16000 Hz, +/-12 dB (shape numbers replaced by measurements) |
   | WMP `.wmz` | 31…16000 Hz, Q 1.41, +/-14 dB (what the app does now) |
   | "AutoEq ten-band" | 31.25 x 2^n Hz, Q 1.414, +/-12 dB (AutoEq's graphic preset, so its output loads directly; these are not the ISO 266 centres 31.5, 63, 125…) |
   | Parametric view | the section list itself |

4. **Define the response independently of sample rate** (decision for the owner, section 8). I recommend choosing one definition (a matched-response design, or the textbook one run at a fixed internal rate) and verifying against that. Otherwise device changes silently change the sound by several dB near the top.
5. **Automatic headroom.** Compute the combined curve's peak and lower the preamp by that peak (AutoEq's approach; its source defines a 0.2 dB headroom constant), and keep a limiter after the EQ. WACUP's own "limiter option" and the macOS apps' lookahead limiters point the same way.
6. **Compute coefficients in 64-bit floats** and keep section state in 64-bit unless a measurement says otherwise.
7. **Interface consequence.** Today's `DspPort.eq.setGain(band, dB)` with ten fixed bands (ENGINE.md line 1593; `eq.rs`) is too narrow. The engine needs a call that sets a whole section list, a profile identifier for display, and a preamp. The ten-slider `equalizerSettings` object in the WMP skin API (ENGINE.md line 803) and the classic EQ window would sit on top of it as views.
8. **Import and export Equalizer APO text.** It is the lingua franca: `Preamp:`, `Filter n: ON PK|LS|HS|LSC|HSC|LP|HP|NO Fc … Hz Gain … dB Q …`, and `GraphicEQ:` lines (VERIFIED from its configuration reference). A Winamp shelf would export as a shelf with Q 0.7071; whether Equalizer APO's shelf-with-Q convention equals this one exactly is UNCONFIRMED and needs a test with its published conventions.

---

## 6. Headphone EQ right now (pointer only)

No installs were made, so none of this is tested. AutoEq (autoeq.app) outputs corrections for headphone models in formats including a ten-band graphic preset and a parametric list. Because the app's ten bands are nearly AutoEq's ten-band layout (section 4.4), the graphic preset's ten gains could be entered into the app's sliders today, with the preamp lowered by the largest boost (the app's own trim removes less than the full peak, so watch for clipping). For a proper parametric profile, several MIT-licensed macOS menu-bar apps use Apple's Core Audio process tap (macOS 14.4 or later), import AutoEq and Equalizer APO files, and do not need a virtual audio driver: ParaEQ and MacEQ are two I read about. Their stated limits include "some DRM paths can bypass the system mix". I read their GitHub pages and did not run or audit the code. The owner should judge them on their own.

---

## 7. Feature list for a standalone app on the replacement server

Server means the replacement for MPD (the C API and the process that owns audio). Face means the skinned app. "Must" is what makes it Winamp-but-better at launch; "Should" follows; "Later" is deliberately deferred.

### 7.1 Must

| # | Feature | Where | Why |
|---|---|---|---|
| M1 | Parametric EQ (section list, preamp, auto-headroom, limiter), with Winamp, WMP and AutoEq ten-slider profiles | server, face maps | section 5 |
| M2 | Import and export of Equalizer APO text and AutoEq profiles; per-output-device profile that switches when headphones are plugged in | server | headphones now; macOS apps set the expectation |
| M3 | Winamp `.eqf` and built-in presets (the 17) load and save | face | exact and sourced (section 4.1) |
| M4 | Gapless playback that honours encoder-delay tags (LAME header, iTunes gapless tag), plus ordinary crossfade (on auto-advance, on manual skip, fade on pause, stop and seek), with a per-album "never crossfade" switch for live and mixed albums | server | crossfading a gapless album disturbs its rhythm (Wikipedia, Gapless playback) |
| M5 | ReplayGain 2 (track, album, auto), preamp, peak-based clipping protection; stored in the server's own database so the user's files are never rewritten | server | MPD already has it; keep parity. ReplayGain 2.0 is based on ITU-R BS.1770 and EBU R128 (Wikipedia); its exact reference level is UNCONFIRMED because the specification page refused my fetch |
| M6 | Bit-perfect path when EQ is off and volume is at 100%: open the device at the file's sample rate, no conversion; plainly say when something has broken bit-perfection | server | removes the 44.1 kHz/16-bit bottleneck of section 1 |
| M7 | Resampling and dither done once, at the edge, with a stated quality | server | MPD offers a choice of resamplers (this build lists libsamplerate and soxr) |
| M8 | Classic `.wsz` face, including `region.txt` shapes, double size, windowshade, docking of main, EQ and playlist windows | face | the owner's skin engine |
| M9 | WMP `.wmz` face | face | the owner's skin engine |
| M10 | Real HiDPI: integer 2x and 3x with sharp edges by default, an optional smoothed mode, and per-monitor scale | face | the 4K report from the WACUP author is the single clearest failure of the original |
| M11 | Skin loader that treats skins as hostile: read the archive in memory, never extract to disk, never run anything from it, tolerate corrupt zips and bitmaps, cap sizes | face | CVE-2009-1831 and the museum's corrupt-skin scan |
| M12 | Playlist/queue: queue, saved playlists, m3u and pls import, "jump to file" search, user-defined title format strings (WACUP's title formatting is a loved power feature) | server and face | Winamp's heart |
| M13 | Global hotkeys (user-assignable) and media keys, Now Playing, Control Center and AirPods controls; menu-bar mini-player (the skin's windowshade or compact view) | face and server | media keys stay with the `nowplayd` approach, in the server |
| M14 | Live spectrum and oscilloscope from the audio the user actually hears | server publishes frames | already built in the app |

### 7.2 Should

| # | Feature | Notes |
|---|---|---|
| S1 | Library with scan, tags, art, search, smart lists (recently added, most played), play counts and ratings | Winamp's library was the part that grew heaviest; keep it small and fast |
| S2 | Per-track or per-album EQ ("AUTO" in Winamp loaded presets per file) | cheap once EQ profiles are data |
| S3 | MilkDrop-style visualiser | Two routes. Butterchurn (MIT, WebGL2, already used by Webamp) fits a skin engine that lives in a web view. projectM (LGPL-2.1, C library, MilkDrop-compatible, latest release 4.1.8 dated 2026-10-06) renders with OpenGL, which Apple deprecated in macOS 10.14; whether the macOS on this machine (Darwin 27.0.0) still ships it is UNCONFIRMED |
| S4 | Internet radio (SHOUTcast/Icecast), podcasts | MPD already plays http streams |
| S5 | Optional OpenSubsonic access, so phone apps can use the same server | UNCONFIRMED which extensions are worth supporting |
| S6 | Album-art-derived colour (the owner's `notan-palette` work) to tint skins that allow it | exists in the owner's other project |
| S7 | Scrobbling and synced lyrics | optional |

### 7.3 Later, or deliberately not copied

- **Winamp "modern" skins (Wasabi XML plus MAKI scripts).** Large effort (WACUP's author calls it "a hefty task on its own") and a code-execution surface with a CVE. Webamp also leaves them unsupported.
- **AVS (Advanced Visualization Studio).** BSD-licensed and ported (a Linux library exists, and the project lists 64-bit and standalone ports as goals), but I saw no macOS support. Skip until asked.
- **Winamp-style plug-in DLLs.** A stable, small server API plus out-of-process helpers replaces them, and avoids the load-time and security problems above.
- **Bundled services, ads, toolbars, CD burning, device sync.** Not part of what people love.
- **The name and logo.** "Winamp" is a trademark; one commenter in a thread on a macOS Winamp clone predicted a cease-and-desist for using it. Name the feature "classic skin", not "Winamp". This is a note, not legal advice, and the commenter is not an authority.

### 7.4 Why this beats the original (summary)

A parametric, headroom-managed EQ with headphone profiles. A response that does not change with sample rate. A bit-perfect path. Skins that are loaded as data only, at any screen density. A server that any face (this app, rmpc, a phone, Control Center) can use. A takeover that is crash-safe (already in `outputs.rs`).

---

## 8. Open decisions for the owner

1. **Fidelity or feeling?** Is the goal that Winamp presets sound the same as in real Winamp (needs the measurement in 4.6, and a Windows machine or compatible runner), or that they feel right? The rest of the plan works either way.
2. **Rate-independent EQ definition** (5.2, item 4): matched-response design or fixed internal rate? This is the one choice the formal proof depends on.
3. **Per-channel EQ**: separate left and right lists, or linked only? (Cheap in the model, costs UI.)
4. **Visualiser route**: Butterchurn inside the web view (easy, fits the engine) or projectM (native, OpenGL risk)?
5. **Hi-res target**: is 24-bit/96 kHz or 192 kHz output on this Mac a real requirement? That decides how much of M6 and M7 matters at launch.
6. **Classic skin extensions** (WACUP's surround-indicator row, PNG sheets): accept as optional extras, or stay strictly 2.x?

---

## 9. Sources

Verification notes. Pages marked (raw) I downloaded as text and searched, or read through an API. Pages marked (summary) I read through a fetch tool that summarises pages; it got at least one date wrong (it printed 2024 for a release the GitHub API dates 2026), so those claims are lower confidence and are flagged where they matter. Pages marked (snippet) were seen only in search results. The Hydrogenaudio ReplayGain 2.0 page and Ars Technica refused or were blocked, and I did not use them. Neowin was blocked too; its one claim here comes from a search snippet.

**Local files (read only)**
- `/Users/golem/git/window_headMPD/src-tauri/src/eq.rs`, `audio.rs`, `outputs.rs`, `lib.rs`
- `/opt/homebrew/etc/mpd.conf`; `~/.config/mpd/README-config-location.txt`; `mpc version`, `mpc outputs`, `mpc status`, `mpd --version` on 2026-10-07
- `/Users/golem/git/window_headMPD-engine/docs/design/ENGINE.md` (DspPort at line 1593, equalizerSettings at 803, MediaModel at 1580)
- `/Users/golem/git/window_headMPD-engine/docs/research/winamp2-corpus.md`, `headspace-parity.md`
- `/Users/golem/git/nowplayd/README.md`, `SPEC.org`; `/Users/golem/git/RMPC-Auto-Theme/README.md`

**Winamp and Webamp**
- Winamp plug-in header `in2.h` (EQSet comment), mirror: https://stuff.mit.edu/afs/sipb/project/vlcplayer/src/faad2/plugins/in_mp4/in2.h (raw)
- Winamp Global Hotkeys settings path (search snippet only): https://www.howtogeek.com/793/assign-keyboard-media-keys-to-work-in-winamp/
- Winamp 5.9 feature claim (https and 24-bit/192 kHz playback): https://www.neowin.net/software/winamp-59-build-9999/ (snippet only; the page itself was blocked)
- Webamp equalizer code (raw): https://raw.githubusercontent.com/captbaritone/webamp/master/packages/webamp/js/media/index.ts and `.../js/constants.ts`, `.../js/actionCreators/equalizer.ts`, `.../js/utils.ts`, `.../js/components/EqualizerWindow/EqGraph.tsx`, `.../spline.js`, `.../presets/builtin.json`
- Webamp `.eqf` package and README with DrO's quoted messages (raw): https://raw.githubusercontent.com/captbaritone/webamp/master/packages/winamp-eqf/README.md, `.../src/parser.ts`
- Webamp repository: https://github.com/captbaritone/webamp (summary); Webamp EQ docs: https://docs.webamp.org/docs/features/equalizer (summary)
- Winamp on Wikipedia: https://en.wikipedia.org/wiki/Winamp (summary)
- Winamp source release: https://www.bleepingcomputer.com/news/software/the-llama-is-freed-winamp-goes-open-source-after-27-years (raw)
- Hacker News: https://news.ycombinator.com/item?id=41636804 (licence text quoted by a commenter), https://news.ycombinator.com/item?id=41861056 (repository deleted), https://news.ycombinator.com/item?id=45926224 (Swift clone for macOS), https://news.ycombinator.com/item?id=24373699 (skin museum), https://news.ycombinator.com/item?id=16333550 (Webamp) (all via the Algolia API, raw)
- GitHub address check, `api.github.com/repos/WinampDesktop/winamp`, returned "Not Found" on 2026-10-07 (raw)
- Rapid7, Winamp MAKI buffer overflow (CVE-2009-1831): https://www.rapid7.com/db/modules/exploit/windows/fileformat/winamp_maki_bof (summary)
- Jordan Eldredge, corrupt skins: https://jordaneldredge.com/notes/corrupted-skins/ (summary)
- Wasabi/MAKI background: Winamp Skin Development Pack readme (snippet only)
- Third-party EQ page with a +/-6 dB claim: https://old.yohng.com/eq10.html (summary)

**WACUP**
- Home page (raw): https://getwacup.com/
- Changelog build 25130, x64 (raw): https://getwacup.com/changelog/beta_1_99_55_25130_x64.html
- Preview 1.99.11 changelog (raw): https://getwacup.com/preview/preview_1_99_11_18916.html
- Beta 1364 (PNG classic skins): https://getwacup.com/changelog/beta_0_9_9_1364.html (summary)
- Blog, 4K: https://getwacup.com/blog/index.php/2020/01/09/wacup-and-winamp-and-4k-just-how-bad-is-it/ (raw)
- Blog, 200 weeks: https://getwacup.com/blog/index.php/2019/12/02/200-weeks-of-wacup-thoughts-plans-and-tldr/ (raw)

**Visualisation**
- projectM README (raw): https://raw.githubusercontent.com/projectM-visualizer/projectm/master/README.md; releases (GitHub API, raw): https://api.github.com/repos/projectM-visualizer/projectm/releases
- Butterchurn: https://github.com/jberg/butterchurn (summary)
- MilkDrop by Ryan Geiss: https://www.geisswerks.com/milkdrop/ (summary)
- vis_avs: https://github.com/grandchild/vis_avs (summary); AVS history: https://en.wikipedia.org/wiki/Advanced_Visualization_Studio (snippet)
- OpenGL deprecation in macOS 10.14: https://appleinsider.com/articles/18/06/04/opengl-opencl-deprecated-in-favor-of-metal-2-in-macos-1014-mojave (snippet)

**Filter math**
- W3C Web Audio API, BiquadFilterNode formulas: https://www.w3.org/TR/webaudio/ (raw)
- Audio EQ Cookbook (W3C copy): https://www.w3.org/TR/audio-eq-cookbook/
- Vicanek, Matched Second Order Digital Filters (2016): https://www.vicanek.de/articles/BiquadFits.pdf (raw)
- Välimäki and Reiss, All About Audio Equalization (Applied Sciences 6(5):129, 2016): https://acris.aalto.fi/ws/portalfiles/portal/9936551/applsci_06_00129.pdf (raw)
- Orfanidis, Digital Parametric Equalizer Design with Prescribed Nyquist-Frequency Gain, JAES 45(6), 1997: cited via Vicanek; not fetched

**Headphone EQ and the macOS landscape**
- AutoEq README and constants (raw): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/README.md, `.../autoeq/constants.py`; web app https://autoeq.app (not opened)
- Equalizer APO configuration reference (raw): https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
- ParaEQ: https://github.com/joerawr/ParaEQ (summary); MacEQ: https://github.com/ksvan/MacEQ (summary); Core Audio taps background (snippet)
- Apple, lossless and hi-res: https://support.apple.com/en-us/118295 (summary)

**Other products and standards**
- Plexamp: https://www.plex.tv/plexamp/ (summary)
- OpenSubsonic: https://opensubsonic.netlify.app/ (summary)
- Tauri global shortcut plug-in: https://v2.tauri.app/plugin/global-shortcut/ (summary)
- MPD manual, user and plug-in pages (raw): https://mpd.readthedocs.io/en/latest/user.html, https://mpd.readthedocs.io/en/latest/plugins.html
- ReplayGain: https://en.wikipedia.org/wiki/ReplayGain (summary); Gapless playback: https://en.wikipedia.org/wiki/Gapless_playback (summary)

**My own artifacts (scratch, not committed)**
- `/tmp/msr-winamp/analysis.py` (all COMPUTED numbers), `/tmp/msr-winamp/results.json` (its output), `/tmp/msr-winamp/vectors.py` (test vectors), `/tmp/msr-winamp/dl/` (downloaded sources)
