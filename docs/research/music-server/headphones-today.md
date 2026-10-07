# EQ the owner's headphones today (macOS, zero new code)

Date: 2026-10-07
Lane: EQ THE OWNER'S HEADPHONES TODAY (music-server research)
Audience: the owner (deep OS and UI taste, does not code)

Tags used below: **MEASURED** = I ran it on this machine today. **SOURCE** = a cited document or source file says so, `[S#]` points into the list at the end. **UNCONFIRMED** = I could not verify it. **RECOMMENDATION** = my opinion, not a fact.

---

## 1. Bottom line

**RECOMMENDATION: use MPD's own `ffmpeg` filter, and put it on two outputs, not one.** It costs nothing, installs nothing, and the Homebrew MPD already has what it needs. It EQs everything MPD plays (not other apps). Steps are in section 5.

Six things you would otherwise trip over:

1. **The filter is built into your MPD.** MEASURED: `/opt/homebrew/bin/mpd` links Homebrew's `libavfilter` and contains the filter's own error text (`Missing "graph" configuration`). Do not be misled by `mpd --version`: its "Filters:" list only ever prints the two resamplers (libsamplerate, soxr). That list is hard-coded in MPD's source and cannot show the ffmpeg filter at all [S7].
2. **Window_headMPD bypasses your normal speaker output.** SOURCE (the app's own `outputs.rs`, read in your checkout): when the app runs in output mode it switches off every local `osx` output and plays MPD through the `Headspace` FIFO output instead. A filter line on "OS X Output" alone would be silent while the app is running. The same filter line has to go on `Headspace` too (snippet in section 4).
3. **The app's ten sliders cannot do this job.** MEASURED: the best possible setting of the app's ten fixed bands (RBJ peaking, Q 1.41, +/-14 dB, centres from `eq.rs`) against a real AutoEq profile still misses by 0.62 dB RMS and 3.29 dB at the worst frequency. It has no shelves and no narrow bands. Keep its sliders flat (flat is a true pass-through in `eq.rs`) and use them as tone controls on top.
4. **The conversion is exact if you keep four small flags.** MEASURED: four real AutoEq profiles through the exact graph MPD builds, compared with AutoEq's own filter math, agree to under 0.00005 dB from 20 Hz to 20 kHz at 44.1, 48, 88.2, 96 and 192 kHz. Drop the precision flags and the bass drifts by up to 0.48 dB at 96 kHz (section 6).
5. **MPD only reads its config at start-up, and a typo should stop it starting.** SOURCE: the graph is parsed while the config loads and throws on error [S3]; I expect that to be fatal at start-up (not tested). Validate the text with `ffmpeg` first (section 5, step 3), and keep a backup.
6. **I never ran this inside a live MPD** (hard rule for this task). Everything about the graph is measured with the same libavfilter MPD links; the MPD wiring is read from MPD's source. First real listen is yours.

I do not know which headphones you own. I found no model name in any file I was allowed to read; macOS only reports the jack as "External Headphones" (MEASURED, `system_profiler SPAudioDataType`). Section 3 shows how to find yours. The worked example uses a Sennheiser HD 650 only because it is a real AutoEq file I could download and test.

---

## 2. What is on this machine (MEASURED, read-only)

| Item | Finding |
|---|---|
| MPD | 0.24.15 (Homebrew bottle 0.24.15_1), `mpd --version`. (`mpc version` prints 0.24.0, which is the protocol version, not the daemon.) |
| How MPD runs | launchd agent `sh.brew.mpd`, status started, running `mpd --no-daemon` (`brew services list`, `pgrep`). Restart command is `brew services restart mpd`. |
| Which config is live | `/opt/homebrew/etc/mpd.conf`. The copy under `~/.config/mpd` is retired and edits there do nothing (see `~/.config/mpd/README-config-location.txt`). |
| ffmpeg filter present | `otool -L` shows `libavfilter.12.dylib` from `/opt/homebrew/opt/ffmpeg`. `strings` finds `Missing "graph" configuration` (unique to the filter plugin source [S3]). The Homebrew formula builds with `-Dffmpeg=enabled` [S33]. |
| FFmpeg on the machine | ffmpeg 9.0.2 (libavfilter 12.1.101, same library MPD links). The `ffmpeg` command exists, so you can test graphs without touching MPD. |
| Added in MPD | The ffmpeg filter arrived in MPD 0.22 (2020-09-23), per the NEWS file shipped with your install (`/opt/homebrew/Cellar/mpd/0.24.15_1/NEWS`). A fix for "filters producing no output" is in 0.23.16, so 0.24.15 has it. |
| Current outputs | `mpc outputs`: 1 Visualizer FIFO (on), 2 OS X Output (on), 3 Headspace (off, app not running right now). |
| Audio device | Default output is the MacBook's "External Headphones" jack (Built-in, 44.1 kHz). Also present: DELL monitor over DisplayPort, built-in speakers. |
| Library | Sampled: FLAC 16-bit/44.1 kHz stereo, plus MP3. High-rate files are not your common case, but the graph below is right for them anyway. |
| OS | macOS 27.0 (build 26A428). |

---

## 3. Find your headphones in AutoEq and get the file

AutoEq turns a published measurement of a headphone into a short list of EQ filters. Its README calls its own saved results "not for normal users" because the web app exists; the web app is the front door [S12].

1. **Get the exact name.** Variants matter: earpads (stock vs aftermarket), impedance versions (for example 80 vs 250 ohm), "Pro" vs non-Pro, post-2020 revisions. AutoEq lists several of these as separate entries [S13].
2. **Search at https://autoeq.app** and pick your model. Choose the "Equalizer APO Parametric" style of output (AutoEq's wiki describes it as the standard parametric format most apps can take [S17]). AutoEq's own examples target the Harman over-ear 2018 curve, which is a taste target rather than "neutral", and its command line has a bass-boost option [S12]. Whether the web app exposes the same target and bass controls I could not check (UNCONFIRMED).
3. **Or fetch the file straight from GitHub.** The recommended-results list keeps, per model, only the highest-accuracy measurement [S13]. Path pattern (MEASURED: HTTP 200 for four files today):
   `https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/<source>/<over-ear|in-ear>/<Model>/<Model> ParametricEQ.txt`
   Example (the HD 650 used below): [S19].
   RECOMMENDATION: when several sources exist, prefer the one the recommended list shows; in practice that is usually oratory1990 for over-ear (my judgment, the README does not rank sources).
4. **Know the limits.** AutoEq says individual units vary from the measured sample, and the Preamp line exists to prevent clipping [S12]. Judge by ear; if one filter bothers you, deleting a single filter from the graph is safe.
5. **If your model is not listed**, AutoEq points to its own guide for making settings yourself [S13]. That is outside this lane.

### What the file looks like (real HD 650 profile, AutoEq/oratory1990)

```
Preamp: -6.1 dB
Filter 1: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70
Filter 2: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42
Filter 3: ON PK Fc 118 Hz Gain -3.1 dB Q 0.50
Filter 4: ON PK Fc 37 Hz Gain 0.7 dB Q 3.96
Filter 5: ON PK Fc 3169 Hz Gain -1.7 dB Q 3.89
Filter 6: ON HSC Fc 10000 Hz Gain -2.1 dB Q 0.70
Filter 7: ON PK Fc 1227 Hz Gain -1.2 dB Q 2.53
Filter 8: ON PK Fc 2055 Hz Gain 1.2 dB Q 3.23
Filter 9: ON PK Fc 587 Hz Gain 0.4 dB Q 1.19
Filter 10: ON PK Fc 5332 Hz Gain -1.1 dB Q 5.75
```

AutoEq writes exactly three filter types: `PK` (a bell), `LSC` (low shelf) and `HSC` (high shelf), each with centre frequency, gain and Q [S15]. The Equalizer APO manual defines LSC/HSC as shelves with a centre frequency and a Q [S18]. AutoEq computes all three with the standard RBJ audio-EQ-cookbook formulas, shelves using `alpha = sin(w0)/(2Q)` [S14]. FFmpeg's `equalizer`, `lowshelf` and `highshelf` accept a Q width (`t=q`) [S11], and the measurement in section 6 shows they agree.

---

## 4. Convert it by hand, and the paste-ready MPD snippet

### The conversion (a text editor job, one line in, one piece out)

| AutoEq line | Becomes this piece of the graph |
|---|---|
| `Preamp: -6.1 dB` | `volume=-6.1dB:precision=double` |
| `Filter n: ON PK  Fc 8800 Hz Gain 5.1 dB Q 1.42` | `equalizer=f=8800:t=q:w=1.42:g=5.1:r=f64` |
| `Filter n: ON LSC Fc 105 Hz Gain 6.4 dB Q 0.70` | `lowshelf=f=105:t=q:w=0.7:g=6.4:r=f64` |
| `Filter n: ON HSC Fc 10000 Hz Gain -2.1 dB Q 0.70` | `highshelf=f=10000:t=q:w=0.7:g=-2.1:r=f64` |
| `Filter n: OFF ...` | leave out |

Glue the pieces with commas and **no spaces**, in this order: `aformat=sample_fmts=dblp,` then the preamp piece, then the filters in file order, then `,aformat=sample_fmts=flt`. (A cascade of filters gives the same sound in any order; file order keeps the preamp in front so nothing clips.) If the profile has no Preamp line, skip that piece.

Why the extra flags (MEASURED, section 6): `aformat=...dblp` plus `precision=double` and `r=f64` keep every stage in 64-bit float. FFmpeg's `volume` filter defaults to 32-bit float and pulls the rest of the chain down with it; 32-bit biquads at low frequencies and high sample rates bend the bass. The closing `aformat=...flt` makes the filter hand MPD floating-point audio, which MPD's `osx` output accepts as-is (it has a float path, source line 673 of the plugin [S8]), so nothing is squeezed to 16-bit before the headphone jack.

A script that does the same conversion is in Appendix A, for when you want it automatic.

### Paste-ready template (do not edit your real file from this; copy to a scratch copy first)

This keeps your existing output blocks exactly as they are today and adds one line to two of them. The graph on the `graph` line is the HD 650 example. **Replace it with the graph for your own headphones.**

```
# --- headphone correction (AutoEq), added 2026-10-07 ---------------------
# Put this block anywhere at top level, for example above the first audio_output
# (MPD reads the whole file before building outputs, so order should not matter;
# I did not test the reverse order).
# EXAMPLE ONLY: Sennheiser HD 650 (AutoEq / oratory1990). Replace the graph.
filter {
	plugin	"ffmpeg"
	name	"headphone_eq"
	graph	"aformat=sample_fmts=dblp,volume=-6.1dB:precision=double,lowshelf=f=105:t=q:w=0.7:g=6.4:r=f64,equalizer=f=8800:t=q:w=1.42:g=5.1:r=f64,equalizer=f=118:t=q:w=0.5:g=-3.1:r=f64,equalizer=f=37:t=q:w=3.96:g=0.7:r=f64,equalizer=f=3169:t=q:w=3.89:g=-1.7:r=f64,highshelf=f=10000:t=q:w=0.7:g=-2.1:r=f64,equalizer=f=1227:t=q:w=2.53:g=-1.2:r=f64,equalizer=f=2055:t=q:w=3.23:g=1.2:r=f64,equalizer=f=587:t=q:w=1.19:g=0.4:r=f64,equalizer=f=5332:t=q:w=5.75:g=-1.1:r=f64,aformat=sample_fmts=flt"
}

# Your existing local output, with ONE added line (filters).
audio_output {
	type		"osx"
	name		"OS X Output"
	mixer_type	"hardware"
	filters		"headphone_eq"
}

# Your existing app output, with the SAME one added line.
# Without it, the correction vanishes whenever window_headMPD is running.
audio_output {
	type		"fifo"
	name		"Headspace"
	path		"/tmp/headspace.fifo"
	format		"44100:16:2"
	mixer_type	"software"
	enabled		"no"
	filters		"headphone_eq"
}

# Leave "Visualizer FIFO" without a filters line unless you want the
# visualizer to see the corrected sound.
```

Facts behind the template:

- `filter { plugin "ffmpeg"  name "..."  graph "..." }` plus `filters "name"` inside an `audio_output` is the documented shape; filters in the `filters` list run in the order given [S1][S2]. `graph` is the only setting the ffmpeg plugin reads, and a missing one is an error at config load [S3].
- Each output builds its own chain: your filters first, then replay gain, then the software volume if used, then format conversion last [S6]. So the correction sits before the `Headspace` FIFO's forced `44100:16:2` conversion. Replay gain is off in your config today; if you turn it on, it is applied after the EQ and can push peaks over full scale (RECOMMENDATION: leave it off, or keep an eye on clipping).
- MPD feeds the graph the track's own sample rate and hands it MPD's channel layout; at the end MPD appends its own `aformat` (float, 32-bit int or 16-bit int) and reads the result back [S3][S4]. When the track's sample rate changes I expect MPD to reopen the output and rebuild the graph, which recomputes the coefficients for the new rate (my reading of the source, not stepped through live). The five-rate test below shows the graph is right at each rate.

### Optional A/B switch (RECOMMENDATION, untested by me)

MPD has no way to change a filter graph while it runs. If you want a quick flat-versus-corrected switch without restarting, give MPD two `osx` outputs with the same device, one with the `filters` line and one without, and enable only one at a time (`mpc enable` / `mpc disable`). Enabling both would play everything twice into the same device. The app's takeover code looks for local outputs by plugin type (`osx` is in its list), so extra `osx` outputs should be handled, but I did not test that. Anything else that refers to "OS X Output" by name would need to follow the rename.

Same caveat for the DELL monitor and built-in speakers: the filter applies to whatever device MPD plays into. If you switch away from the headphones, the correction is wrong for the new device. The A/B pair is the way around that.

---

## 5. Apply it safely (RECOMMENDATION, steps for you to run)

1. **Back up.** `cp /opt/homebrew/etc/mpd.conf ~/mpd.conf.bak-2026-10-07`.
2. **Get your graph** (section 4 by hand, or Appendix A).
3. **Check the graph with ffmpeg, without touching MPD.** From a terminal, with your graph between the quotes:
   `ffmpeg -hide_banner -nostdin -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo -af "<GRAPH>" -t 1 -f null -`
   MEASURED with the HD 650 graph: no output and exit code 0 (valid). With one filter name misspelled it prints `No such filter: 'equalizr'` and exits 8. This is the same libavfilter MPD uses, so a pass here means MPD will parse it.
4. **Optional listen-before-you-commit.** Render a track through the graph and play the result in any player, no MPD change needed:
   `ffmpeg -i "song.flac" -af "<GRAPH>" -c:a flac corrected.flac`
5. **Quit window_headMPD first, and start it again afterwards.** If it stays open during an MPD restart, MPD comes back with the output states from the config file (Headspace off, OS X Output on) while the app still believes it owns playback, and its `takeover.json` record stays on disk (`outputs.rs` writes it on takeover and removes it on a clean exit). My reasoning from reading that file, not a tested failure.
6. **Edit `/opt/homebrew/etc/mpd.conf`** (the live one) to add the three pieces from section 4.
7. **Restart MPD:** `brew services restart mpd`. Playback stops briefly and, because your config has a `state_file`, MPD comes back with the queue and position restored. (`restore_paused` is not set, so a track that was playing resumes; it is paused right now.)
8. **Check.** `mpc outputs` should list the same three outputs. Watch `~/.cache/mpd/log` (your `log_file`) for errors. If MPD does not start at all, the graph or config line is wrong: restore the backup, restart, and recheck with step 3.
9. **Listen.** Expect it to be noticeably quieter, by roughly 3 to 6 dB (this profile's preamp is -6.1 dB); that is the Preamp line doing its job, so turn the volume up to taste. Compare with the corrected-render from step 4 if unsure.

To undo: restore the backup file and restart. MPD itself is untouched, nothing else was installed.

---

## 6. Proof the math is right (MEASURED)

Method: replicate MPD's exact graph (source [S3][S4]): an input buffer in the track's sample format, then the user graph, then MPD's own `aformat=sample_fmts=flt|s32|s16`. Feed a one-sample impulse, take the FFT of what comes out, and compare with an independent implementation of AutoEq's own biquad formulas (`autoeq/peq.py`, [S14]). Scripts were scratch in `/tmp/msr-headphones-today/` and will not persist; the method is a short Python script plus one ffmpeg command per sample rate.

**Result for the final graph (what the template uses): worst error over 20 Hz to 20 kHz**

| Profile (all oratory1990, AutoEq) | 44.1 kHz | 48 kHz | 88.2 kHz | 96 kHz | 192 kHz |
|---|---|---|---|---|---|
| Sennheiser HD 650 | < 0.00005 dB | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 |
| Audio-Technica ATH-M50x | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 |
| Beyerdynamic DT 770 Pro | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 |
| Apple AirPods Max | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 | < 0.00005 |

Left and right channels came out bit-identical. Frames in equals frames out (131072 / 131072): no samples lost or added.

**Why the precision flags are there (HD 650, same test, graph without them):**

| Sample rate | Worst bass-region error without flags |
|---|---|
| 44.1 kHz | 0.006 dB |
| 48 kHz | 0.094 dB |
| 96 kHz | 0.477 dB |

I traced the cause (tested at 96 kHz). With `volume=...:precision=double` the filters stay in 64-bit and the error is 0.0000 dB even without `r=f64`. With `volume` at its default and nothing else changed, the error returns (0.477 dB). So the flags that matter are the `volume` one and the `dblp` start; `r=f64` on each filter is belt-and-braces and stays in the template.

**Delay (HD 650, M50x, DT 770 Pro, AirPods Max):** the first output sample appears at index 0, so the filter adds no fixed delay (no look-ahead; IIR biquads). Group delay of the EQ shape itself peaks at 4.00, 3.12, 4.76 and 0.32 ms respectively, only in the lowest bass. The impulse response is above -80 dB for 8 to 36 ms. Irrelevant for music; there is no video lip-sync in MPD.

**Headroom:** with the HD 650 profile, 60, 105 and 1000 Hz sines at -0.1 dBFS came out at -2.45, -6.03 and -6.73 dBFS, matching the profile's own gain there (-2.36, -5.94, -6.64 dB). AutoEq sets the Preamp line to the negative of the combined curve's peak gain [S15] (for the HD 650 that is -6.1 dB, while the biggest single boost is +6.4 dB), so a hot track should not clip inside the filter, and the filter ends in float anyway.

**What this does not prove:** it proves ffmpeg's filters equal AutoEq's formulas at the sampled settings, as numerical evidence rather than a mathematical proof. It does not prove MPD's wiring in a live process (I could not start MPD). For the formally verified goal in the long-term plan, treat this as a reference test, not a proof.

---

## 7. All five options, side by side

| | 1. MPD ffmpeg filter | 2. eqMac | 3. SoundSource | 4. CamillaDSP + BlackHole | 5. Apple built-ins |
|---|---|---|---|---|---|
| Cost | $0 | Free tier; Pro $40 lifetime, or $3/month, $30/year [S25] | $49 new, $25 to upgrade from 5 (as of 2025-12-05, [S22]) | $0 (GPL tools) | $0 |
| Affects | Only MPD, only outputs you tag | All apps (system-wide, via a virtual driver [S26]) | All apps or one app [S20] | Only apps whose output is set to BlackHole (normally everything) | Music.app only, or AirPods/Beats only |
| Matches AutoEq exactly | Yes, measured | Free: no (10-band graphic). Pro: UNCONFIRMED | Loads the ParametricEQ.txt directly; how it is rendered UNCONFIRMED | Likely (parametric biquads with Q); UNCONFIRMED | No |
| Added latency | None measured | UNCONFIRMED | UNCONFIRMED | Chunk size / sample rate (docs suggest about 22 ms chunks) plus device buffers [S27] | n/a |
| Setup | 15 min, one restart | Install app and audio driver | Install app, load profile | Install driver, download a binary, write YAML, keep it running | n/a |
| Main risk | Config typo stops MPD (validate first) | Closed-source since 1.3.2; macOS 27 UNCONFIRMED | Paid; trial limits UNCONFIRMED | Volume keys and device switching UNCONFIRMED; most moving parts | Not a solution |

### 1. MPD's `ffmpeg` filter (recommended)

- Steps: sections 3 to 5.
- Affects only MPD (browser, video calls, games stay uncorrected). Fine for a music-server project; it is the one option that keeps working when you later replace MPD with your own server, because the same biquad list is what that server's DSP stage must do.
- Risks: restart needed to change anything; typo stops MPD starting; device-agnostic (applies to speakers too); the app must also have the line on `Headspace`; no live toggle (optional A/B pair).
- Verification: section 6.

### 2. eqMac

- SOURCE: free for the "Basic" (bass/mids/treble) and "Advanced" (10 fixed-band graphic) EQs; "Expert" (unlimited bands with gain, bandwidth and frequency) is Pro. Also lists reference presets for 4600+ headphones in both tiers. Site says macOS 10.13+, Intel and Apple Silicon [S25]. AutoEq's own wiki table lists eqMac Expert as parametric and paid, eqMac Advanced as graphic and free [S16]. A Homebrew cask exists at version 1.9.2 and is not flagged deprecated (MEASURED, `brew info --cask`).
- "Open source" is only partly true. SOURCE: the public repository is Apache-2.0 but holds v1.3.2 without the Pro features; newer releases are built from a private fork [S26]. Homebrew's 1.9.2 is therefore closed source. It works through a user-space audio driver that grabs the system audio stream [S26].
- Fits AutoEq? The free 10-band version is the same kind of limit as the app's sliders (section 1, item 3; the fit I measured used the app's own band layout, so for eqMac Advanced it is an expectation, not a measurement). Whether Expert offers shelf filters and accepts an AutoEq text file: UNCONFIRMED (the site does not say; a search snippet mentions "multiple filter types").
- UNCONFIRMED: works on macOS 27, how the driver installs, latency.

### 3. SoundSource (Rogue Amoeba, commercial)

- SOURCE: version 6.1.5 (2026-10-05) lists macOS 15 to 27 [S20][S21]. Homebrew cask is 6.1.5 and requires macOS 15 or later (MEASURED, `brew info --cask`). Price $49 new and $25 to upgrade from version 5, as of 2025-12-05 [S22].
- It has a "Headphone EQ" effect built on AutoEq data with thousands of headphone models [S23]. Release 5.3.0 (2021-01-29) added loading your own profiles; 5.6.0 (2023-05-23) added "AutoEq profiles in the Equalizer APO format"; 5.7.0 (2024-09-16) added "Add Other Profile..." for AutoEq JSON profiles [S21]. So your downloaded ParametricEQ.txt should load directly. It also has a plain 10-band EQ, system-wide and per-app effects, and Audio Unit hosting [S20]. Version 6.0 lets Headphone EQ run per app [S22].
- UNCONFIRMED: whether Headphone EQ renders the profile as true parametric filters or folds it into 10 bands (a 2021 forum post said 10-band and "parametric in beta" [S24]); whether Headphone EQ is still limited to the default output device (the version 5 manual says it is [S23]); what the trial limits are (the trial page returned 404); latency.
- Fit: the easiest way to correct the browser, video and calls as well. If you buy it later, remove the MPD filter first or you will correct twice.

### 4. CamillaDSP with BlackHole

- SOURCE: BlackHole is a free virtual loopback driver (GPL-3.0), Homebrew `blackhole-2ch`, Intel and Apple Silicon, claims zero added driver latency; macOS cannot change the volume of a Multi-Output device [S29]. Homebrew's cask is 0.7.1 (MEASURED). CamillaDSP runs on macOS (CoreAudio), Apple Silicon included, supports Peaking, Lowshelf and Highshelf biquads with Q, and is configured in YAML [S27]. A BlackHole-to-headphones example config exists in its CoreAudio notes [S28]. Homebrew has no `camilladsp` formula (MEASURED), so you download a release binary and may need to clear macOS quarantine with `xattr` [S27]. A third-party converter from AutoEq to CamillaDSP exists, not vetted by me [S30].
- Latency: the engine waits for a whole chunk; chunk duration is chunk size divided by sample rate, with typical values near 22 ms [S27].
- Steps in outline: install BlackHole, set it as the system output, run CamillaDSP capturing BlackHole and playing to the headphones, keep it running at login.
- UNCONFIRMED: whether the macOS volume keys still control the headphones when the system output is BlackHole; how video apps cope with the added delay; CamillaDSP's shelf-Q convention equalling AutoEq's (the docs fetched showed two different version numbers, 4.1 and 3.0.0, so I also cannot name the current release).
- Fit: most work, most power (FIR, crossfeed). It is the closest thing on the Mac to Equalizer APO. Worth revisiting when the long-term DSP design needs a reference, not as today's answer.

### 5. Anything Apple provides

- Music app equalizer: Window > Equalizer, 20+ presets, adjustable sliders, saved presets [S31]. Only affects playback inside Music.app, so it does nothing for MPD.
- Headphone Accommodations (System Settings > Accessibility > Audio): documented for AirPods and Beats on Mac with macOS Sequoia or later; amplifies soft sounds and adjusts frequencies to suit the listener's hearing [S32]. Not documented for a wired jack headphone, and it is a hearing aid-style tuner, not a measured-headphone correction curve.
- AUNBandEQ: Apple's parametric audio unit ships with macOS, but AutoEq's wiki notes it needs a plug-in host [S16]. Apple provides no system-wide host.
- macOS has no built-in system-wide EQ (a web search for macOS 27 found none; absence is UNCONFIRMED).
- Not evaluated: several newer small system-wide EQ apps turned up in searches (SoundMax, EQer, Spectra, eqtune [S34]); I did not vet them.

---

## 8. Things I could not confirm

- A live MPD run with the filter loaded (hard rule). Everything MPD-side is from its source and the binary's linkage.
- Your headphone model.
- Whether MPD can hot-reload its config for a new filter: the user manual does not say [S1]; plan on a restart.
- Whether MPD dithers when it converts the filter's output down to the `Headspace` FIFO's 16-bit format. (The `osx` output gets float and is not affected.)
- SoundSource: trial limits, true-parametric rendering of Headphone EQ, default-device-only limit in version 6, latency.
- eqMac: macOS 27 support, driver install on this OS, Expert shelf and import behaviour, how the 4600-headphone presets are built, latency.
- CamillaDSP: current version, shelf-Q convention, BlackHole volume-key behaviour, video latency.
- That "no added fixed delay" holds inside MPD's own output pipeline; I measured the filter, not MPD's buffers.

---

## 9. Notes for the long-term plan (short)

- AutoEq's file is a list of RBJ biquads. That is the whole contract the replacement server's EQ has to honor for "EQ the headphones": Preamp + PK/LSC/HSC with Fc, gain, Q. The four-profile, five-rate measurement above is a ready golden test for any future DSP stage and for its formal-verification story, as a reference rather than a proof.
- The 32-bit finding is a design warning. Stages in single precision visibly bend low-frequency bands at 96 kHz (0.48 dB here). The current app EQ (`eq.rs`) is single-precision throughout; I measured ffmpeg's filters, not `eq.rs`, and `eq.rs` only runs 31 Hz and up at Q 1.41 at 44.1 kHz, so I would not assume the same size of error. Check before a parametric low-frequency band is added.
- `eq.rs`'s ten bands, fixed Q 1.41 and +/-14 dB range are a graphic EQ in the WMP sense. A parametric and shelf-capable engine is a different component, not a tweak of the sliders.

---

## Appendix A. Converter script (optional)

Copy to a file named `peq2mpd.py` and run `python3 -I peq2mpd.py "<path to ParametricEQ.txt>"`. It only reads the file and prints a ready `filter { ... }` block. It refuses any line type it does not understand instead of guessing. MEASURED: it produced the graph in section 4 from the HD 650 file; it prints an error and exits 1 for a `LS` line and for a file with no ON filters; the output graph for all four profiles passed the section 6 test.

```python
#!/usr/bin/env python3
"""AutoEq ParametricEQ.txt -> MPD filter block (ffmpeg graph)."""
import re
import sys

FILTER_RE = re.compile(
    r"^Filter\s*\d*\s*:\s*(ON|OFF)\s+(PK|LSC|HSC)\s+Fc\s+([-+0-9.]+)\s*Hz"
    r"\s+Gain\s+([-+0-9.]+)\s*dB\s+Q\s+([-+0-9.]+)\s*$", re.IGNORECASE)
PREAMP_RE = re.compile(r"^Preamp\s*:\s*([-+0-9.]+)\s*dB\s*$", re.IGNORECASE)
KIND = {"PK": "equalizer", "LSC": "lowshelf", "HSC": "highshelf"}

def num(s):
    v = float(s)
    return str(int(v)) if v == int(v) else repr(v)

def convert(lines):
    parts = ["aformat=sample_fmts=dblp"]
    preamp, n_on = 0.0, 0
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = PREAMP_RE.match(line)
        if m:
            preamp = float(m.group(1))
            continue
        m = FILTER_RE.match(line)
        if m:
            state, kind, fc, gain, q = m.groups()
            if state.upper() == "ON":
                parts.append(f"{KIND[kind.upper()]}=f={num(fc)}:t=q:w={num(q)}"
                             f":g={num(gain)}:r=f64")
                n_on += 1
            continue
        raise SystemExit("cannot convert (only Preamp, PK, LSC, HSC with Q):\n  " + line)
    if n_on == 0:
        raise SystemExit("no ON filters found")
    if preamp != 0.0:
        parts.insert(1, f"volume={num(preamp)}dB:precision=double")
    parts.append("aformat=sample_fmts=flt")
    return ",".join(parts), n_on, preamp

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 -I peq2mpd.py <ParametricEQ.txt>")
    with open(sys.argv[1], encoding="utf-8-sig") as f:
        graph, n_on, preamp = convert(f.read().splitlines())
    print(f"# {n_on} filters, preamp {preamp} dB")
    print('filter {\n\tplugin\t"ffmpeg"\n\tname\t"headphone_eq"')
    print(f'\tgraph\t"{graph}"\n}}')
    print('# then add inside each audio_output that should be corrected:')
    print('#\tfilters\t"headphone_eq"')
```

---

## Sources

MPD
- [S1] MPD user manual, filter blocks and the `filters` output setting: https://mpd.readthedocs.io/en/stable/user.html
- [S2] MPD plugin reference, ffmpeg filter (`graph`, requires libavfilter): https://mpd.readthedocs.io/en/stable/plugins.html
- [S3] MPD 0.24 source, ffmpeg filter plugin: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/filter/plugins/FfmpegFilterPlugin.cxx
- [S4] MPD 0.24 source, graph construction and the trailing `aformat=flt|s32|s16`: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/lib/ffmpeg/Filter.cxx
- [S5] MPD 0.24 source, how frames go through the graph: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/filter/plugins/FfmpegFilter.cxx
- [S6] MPD source, output filter-chain order: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/output/Init.cxx and https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/output/Filtered.cxx
- [S7] MPD 0.24 source, `--version` output (Filters list is the two resamplers only): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/CommandLine.cxx
- [S8] MPD 0.24 source, `osx` output plugin (float support, device and mixer settings): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/output/plugins/OSXOutputPlugin.cxx
- [S9] MPD 0.24 source, config block parser: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.x/src/config/File.cxx
- [S10] MPD NEWS (read from the local install): /opt/homebrew/Cellar/mpd/0.24.15_1/NEWS; upstream https://github.com/MusicPlayerDaemon/MPD/blob/master/NEWS
- [S33] Homebrew mpd formula (read with `brew cat mpd`; build flags `-Dffmpeg=enabled`): https://formulae.brew.sh/formula/mpd

FFmpeg, AutoEq, Equalizer APO
- [S11] FFmpeg filter documentation (`equalizer`, `bass`/`lowshelf`, `treble`/`highshelf`, `volume`, `aformat`): https://ffmpeg.org/ffmpeg-filters.html
- [S12] AutoEq README: https://github.com/jaakkopasanen/AutoEq
- [S13] AutoEq recommended-results list: https://github.com/jaakkopasanen/AutoEq/blob/master/results/README.md
- [S14] AutoEq filter math (`peq.py`): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/peq.py
- [S15] AutoEq file writer (`PK`/`LSC`/`HSC`, Preamp = -max gain): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/autoeq/frequency_response.py
- [S16] AutoEq wiki, Choosing an Equalizer App (macOS table): https://github.com/jaakkopasanen/AutoEq/wiki/Choosing-an-Equalizer-App
- [S17] AutoEq wiki home (Equalizer APO parametric option): https://github.com/jaakkopasanen/AutoEq/wiki
- [S18] Equalizer APO configuration reference (Preamp, Filter, LSC/HSC): https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
- [S19] Sample profile used (HD 650): https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sennheiser%20HD%20650/Sennheiser%20HD%20650%20ParametricEQ.txt (others tested: the same path pattern for Audio-Technica ATH-M50x, Beyerdynamic DT 770 Pro, Apple AirPods Max)

Alternatives
- [S20] SoundSource product page: https://rogueamoeba.com/soundsource/
- [S21] SoundSource release notes: https://rogueamoeba.com/soundsource/releasenotes.php and https://rogueamoeba.com/support/releasenotes/?product=SoundSource
- [S22] TidBITS on SoundSource 6.0 (price, per-app Headphone EQ): https://tidbits.com/watchlist/soundsource-6-0/
- [S23] SoundSource 5 manual, built-in effects (Headphone EQ, default-device limit, AutoEq): https://www.rogueamoeba.com/support/manuals/legacy/soundsource5/?page=effects-builtin
- [S24] Forum thread on SoundSource 5 Headphone EQ (10-band remark): https://forum.headphones.com/t/soundsource-5-with-headphone-eq/9940
- [S25] eqMac site (tiers, price, requirements): https://eqmac.app/
- [S26] eqMac repository (Apache-2.0, v1.3.2 public, private fork, driver design): https://github.com/bitgapp/eqMac
- [S27] CamillaDSP README (platforms, biquads, chunk size, xattr note): https://github.com/HEnquist/camilladsp
- [S28] CamillaDSP CoreAudio backend notes (BlackHole config example): https://github.com/HEnquist/camilladsp/blob/master/backend_coreaudio.md
- [S29] BlackHole README: https://github.com/ExistentialAudio/BlackHole
- [S30] autoeq2camilladsp (third party, not vetted): https://github.com/Ebert-Hanke/autoeq2camilladsp
- [S31] Apple, Music app equalizer: https://support.apple.com/guide/music/adjust-the-sound-quality-museb684a3de/mac
- [S32] Apple, Headphone Accommodations on Mac: https://support.apple.com/en-ie/guide/mac-help/mchl8028e24e/mac and for AirPods https://support.apple.com/guide/airpods/set-headphone-accommodations-devcd05671ab/web
- [S34] eqtune (unvetted, Core Audio process-tap approach): https://docs.rs/crate/eqtune/0.3.1

Local files read (not modified): `~/git/window_headMPD/src-tauri/src/{eq,audio,outputs}.rs`, `/opt/homebrew/etc/mpd.conf`, `~/.config/mpd/README-config-location.txt`, `~/.cache/mpd/log` (tail), the MPD binary (`otool -L`, `strings`), `brew` metadata, `mpc outputs` and `mpc status` (read-only).
