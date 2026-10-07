# Parametric EQ and DSP: what exists, what the server's DSP core must be, and how to EQ headphones tonight

Date: 2026-10-07
Lane: PARAMETRIC EQ AND DSP (one of several lanes; the others own architecture, MPD audit, landscape, Winamp parity)

## 0. The short version

1. **The field converges on one filter recipe.** AutoEq, CamillaDSP and ffmpeg build their peaking and shelf filters from the "Audio EQ Cookbook" (RBJ) formulas; I confirmed this by reading AutoEq's and CamillaDSP's source and by measuring ffmpeg's `equalizer`/`lowshelf`/`highshelf` (they match the cookbook to better than 1e-10 dB). For Equalizer APO and PipeWire I could not read the filter code, so the same recipe is an assumption there (UNCONFIRMED), though AutoEq's presets are fitted with it and published for both. [S1][S9][S10][S26]
2. **Equalizer APO's text format is the interchange language.** `Preamp: -6.3 dB` plus `Filter 1: ON PK Fc 8445 Hz Gain 3.3 dB Q 1.61`. AutoEq writes it, Peace edits it, PipeWire and ffmpeg-based setups can be fed from it. The server should read and write it. [S4][S9][S11]
3. **Math decision: 64-bit floating point, transposed direct form II, coefficients recomputed from the filter definition at the current sample rate.** Measured: with 32-bit float the error against a 64-bit reference sits only 45 to 85 dB below the signal, and it is worst for low bands at high sample rates (a 31 Hz band at 192 kHz: error only 49 dB below the signal). The cost of 64-bit is nothing: 32 filters, 2 channels, 192 kHz uses 2.4% of one core on this machine. (Section 4.4)
4. **One real design choice (owner's call): how to treat the "cramping" near the top of the spectrum.** The standard recipe forces the response to exactly 0 dB at half the sample rate, which squeezes any boost above 8 kHz. A 16 kHz +6 dB bell at 44.1 kHz is wrong by up to 3.9 dB against its own analog prototype. A closed-form fix exists for bells (Vicanek 2016): error drops to 0.44 dB. But AutoEq tuned its presets against the squeezed version at 44.1 kHz. So: default "same as Equalizer APO", optional "analog-matched". (Section 4.5)
5. **Parameter changes must be smoothed.** Measured: the app's current way (swap coefficients instantly, keep filter memory) produces a click as loud as -34 dBFS for a 12 dB change and about -64 dBFS for a 1 dB slider step. Ramping the parameters over 20 ms brings it below -92 dBFS. (Section 4.6)
6. **Headroom rule: lower the preamp by the peak of the combined response, rounded up, no soft clipper.** The app's current rule (60% of the biggest boost) leaves a 3.3 dB overshoot on the HD 600 ten-band preset, and then a hidden `tanh` clipper distorts every loud passage (0.97% THD at -1 dBFS). (Sections 3 and 4.7)
7. **Dither only when writing integers, TPDF, last in the chain.** The app's WAV writer truncates; measured: a -60 dBFS tone gets a distortion spur at -44 dB relative to itself, against -74 dB with TPDF dither. (Section 4.8)
8. **The new server owns the sound card clock, so the drift-chasing resampler disappears.** The app's cubic resampler measurably dulls the top octave (-1.65 dB at 15 kHz, -3.1 dB at 18 kHz) and breathes with the clock. Use libsoxr for rate conversion; it is already on this machine. (Sections 3 and 4.9)
9. **FIR convolution is an option, not the core.** Zero extra latency for the IIR core; FIR adds one block (about 3 to 6 ms) with minimum-phase impulse responses, or half the filter length with linear phase (about 50 ms for AutoEq's 4,410-tap files). (Section 4.10)
10. **Everything in the DSP core is a pure function with an algebraic spec**, so the "formally verified" goal is realistic for it: stability, unity gain at DC, exact gain at the centre frequency, boost-then-cut equals wire, bounded output. List in section 4.13.
11. **EQ the headphones tonight, no code:** (a) MPD's own ffmpeg filter (math verified; this MPD binary contains the plug-in, checked by reading the file, not by running it; format handling inside MPD is untested); (b) the app's ten sliders with AutoEq's ten-band preset values; (c) CamillaDSP; (d) a macOS system-wide app. Section 5 has a worked example. I did not touch MPD or the app.
12. **I do not know which headphones you have.** The worked example uses the Sennheiser HD 600 because it is a common AutoEq entry. Say the model and I (or you) can fetch the right file.

## 1. How to read this

- **Verified** means I ran it, read the source, or measured it in this session. My scripts are in `/tmp/msr-eq-dsp/work/` (scratch; may be wiped). Section 8 has the raw numbers so nothing depends on the scratch files.
- **[S#]** points to the source list at the end.
- **Recommendation** is my opinion, not a fact.
- **UNCONFIRMED** means I could not verify it. I list them all in section 7.
- "dBFS" is decibels relative to digital full scale; "dB re signal" means relative to the signal's own level.

## 2. Prior art

### 2.1 Equalizer APO (Windows, system-wide)

**What it is.** An open-source parametric/graphic equalizer for Windows, written by Jonas Thedering, GPLv2, version 1.4.2 dated 28 November 2025, Windows Vista to 11 on x64, x86 and ARM64. It advertises "virtually unlimited number of filters", very low latency, low CPU use, VST plug-in support, and a Room EQ Wizard file reader. [S5]

**Architecture.** It is an Audio Processing Object (APO): a COM object, user-mode, real-time, loaded in-process into the Windows audio engine's signal graph. Windows has three places for such effects: stream effects (SFX, one instance per stream, before the mix), mode effects (MFX, after the mix for a mode), endpoint effects (EFX, always applied, after everything). [S7] Equalizer APO is installed per chosen device, and its installer offers "pre-mix" or "post-mix" placement; the config command `Stage:` selects the same two stages. [S4][S6] Consequence worth noting: because it sits inside the OS mixer, it EQs every application with no change to those applications, except programs that bypass the system effect path (for example hardware-accelerated OpenAL). [S5][S6] macOS has no equivalent insertion point in its mixer; the alternatives are a virtual device, a process tap, or EQ inside the player. That is the real reason a music server that owns its output is the right place for the EQ here.

**Config language.** A plain text file, `config.txt`, reloaded when saved: "adjust the preamp value while music is running ... the volume changes immediately each time after you save the file". [S6] Commands (syntax lines quoted from [S4]):

| Command | Syntax | Meaning |
|---|---|---|
| Preamp | `Preamp: <negative number> dB` | Overall gain; several on one channel add in dB. |
| Filter | `Filter <n>: ON <Type> Fc <Hz> Hz Gain <dB> dB Q <q>` or `... BW Oct <octaves>` | One biquad. |
| GraphicEQ | `GraphicEQ: <freq> <gain>; <freq> <gain>; ...` | Gains interpolated linearly against log frequency. |
| Convolution | `Convolution: <file>` | FIR from an impulse-response file; the file's sample rate "must match" the device; files in the config folder reload automatically. |
| Channel | `Channel: L R C LFE RL RR RC SL SR` or `all` | Which channels the following lines apply to. |
| Copy | `Copy: <target>=<factor>*<source>+...` | Channel routing and mixing; factors may be in dB. |
| Device | `Device: <pattern>; ...` | Which audio device the following lines apply to. |
| Include, Delay, Stage | `Include: <file>`, `Delay: <t> ms` or `<n> samples`, `Stage: pre-mix post-mix` | |
| If / EndIf, Eval | expressions with constants such as `sampleRate`, `deviceName`, `stage` | Conditional config; the docs recommend them for rate-dependent coefficients. |
| IIR | `Filter <n>: ON IIR Order <m> Coefficients <b0..bm> <a0..am>` | Raw coefficients. |

**Filter types** [S4]: PK (also written MODAL or PEQ), LP, HP, BP, LS and HS (the shelves), LSC and HSC (shelves given by centre frequency), NO (notch), AP (all-pass), plus fixed 6 and 12 dB/octave shelf forms. Gain is required for peaking and shelves; Q or `BW Oct` is optional for most. The reference table says Q/BW is optional for shelves from version 1.2.1 and does not state the default.

**What I could not confirm:** the filter formulas inside Equalizer APO (the SourceForge code page refused my fetch), its internal sample format, and exactly how "LS", "LSC" and "LS 12dB" differ (the summary I could read describes "centre freq., x dB per oct." for the C form and "corner freq." for the fixed forms, but not how Q enters). All UNCONFIRMED. AutoEq writes `LSC ... Q 0.70` and `HSC ... Q 0.70` and describes them as Equalizer APO files, so the shelf-with-Q reading is the working assumption. [S9]

**Peace** is the GUI on top: needs Equalizer APO installed, up to 31 sliders per channel "or unlimited if you will", filter types "peak, low/high pass and shelf, band, notch, all pass and many others", nine speaker layouts, presets, an effects panel (up/down-mix, crossfeed, bass and treble, channel routing) and an AutoEQ interface; GPLv2; last updated 2026-03-15. [S8]

### 2.2 AutoEq (headphone correction from measurements)

**What it is.** A tool and a measurement collection: "Collection of headphone measurements ... from oratory1990, crinacle, Innerfidelity, Rtings and legacy headphone.com measurements", a set of target curves, and an optimizer that fits equalizer settings to (target minus measurement). MIT licence. The web app autoeq.app is the intended front door; the repository mainly serves developers. [S9]

**Targets it ships** (directory listing): Harman over-ear 2013, 2015 and 2018, Harman in-ear 2016, 2017 and 2019 (each with a "without bass" variant), diffuse-field variants, oratory1990's own targets, per-database Harman variants, and a flat `zero.csv`. Its README example uses `harman_over-ear_2018` and `harman_over-ear_2018_wo_bass`. [S9]

**Output formats:** ParametricEQ.txt (Equalizer APO), GraphicEQ, FixedBandEQ (ten-band), and convolution/FIR (WAV impulse responses at 44.1 and 48 kHz). [S9] For the Sennheiser HD 600 from oratory1990 the ParametricEQ.txt is (verified, fetched today):

```
Preamp: -6.3 dB
Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70
Filter 2: ON PK Fc 125 Hz Gain -2.7 dB Q 0.55
Filter 3: ON PK Fc 8445 Hz Gain 3.3 dB Q 1.61
Filter 4: ON PK Fc 522 Hz Gain 0.7 dB Q 1.02
Filter 5: ON PK Fc 1298 Hz Gain -1.2 dB Q 2.14
Filter 6: ON HSC Fc 10000 Hz Gain -3.1 dB Q 0.70
Filter 7: ON PK Fc 3158 Hz Gain -1.8 dB Q 3.67
Filter 8: ON PK Fc 2166 Hz Gain 0.9 dB Q 3.32
Filter 9: ON PK Fc 6639 Hz Gain 2.2 dB Q 5.82
Filter 10: ON PK Fc 5433 Hz Gain -1.2 dB Q 5.70
```

**Facts from AutoEq's source (verified by reading `constants.py`, `peq.py`, `frequency_response.py`):** [S9]

- Its biquads are the cookbook peaking, low-shelf and high-shelf formulas with Q (`peq.py`, class `Peaking`, `LowShelf`, `HighShelf`, method `biquad_coefficients`). Shelves are written as `LSC`/`HSC`.
- **It fits against the digital response at 44,100 Hz by default** (`DEFAULT_FS = 44100`; the response used in the optimizer is computed from those coefficients at the preset's sample rate). So the "squeezed" top end of the cookbook filter is baked into the fit.
- Limits it gives the optimizer: bell centre 20 Hz to 10 kHz, Q 0.18248 to 6, gain +/-20 dB; shelf centre 20 Hz to 10 kHz, Q 0.4 to 0.7 ("Shelf filters start to overshoot below 0.4" and "above 0.7"); the comment on the minimum bell Q says "AUNBandEq has maximum bandwidth of 5 octaves which is Q of 0.182479", so Apple's N-band EQ audio unit was a design constraint.
- Presets of the optimizer: `10_BAND_GRAPHIC_EQ` is bells at 31.25 x 2^i Hz (i = 0..9), Q = sqrt(2), +/-12 dB; `31_BAND_GRAPHIC_EQ`: 20 x 2^(i/3) Hz, Q 4.318473; `8_PEAKING_WITH_SHELVES`: low shelf 105 Hz Q 0.7, high shelf 10 kHz Q 0.7, eight bells.
- **Preamp = minus the maximum of the combined response**, printed to one decimal (`Preamp: {-compound.max_gain:.1f} dB`), the maximum taken on a 1.02-ratio grid over 20 Hz to 20 kHz. For FIR and graphic outputs it normalises to a 0.2 dB margin (`PREAMP_HEADROOM = 0.2`).
- FIR files: built with `firwin2` then SciPy's `minimum_phase`, gain at Nyquist set to zero, code comment "Inspired by" Equalizer APO's `GraphicEQFilter.cpp`. By the code (`n = round(22050/5) = 4410`, doubled by `firwin2`, halved by `minimum_phase`) the 44.1 kHz minimum-phase IR is 4,410 samples, about 100 ms; the HD 600 file is 18,044 bytes, which roughly agrees for 32-bit samples (sample format UNCONFIRMED).
- The README's 2022 note: the optimizer "treats +10 kHz range as average value instead of trying to fix it precisely". Above 10 kHz the correction is deliberately loose.

**Recommendation (not a fact):** treat an AutoEq preset as a good starting point for one measured unit on one rig, not a guarantee for your unit.

### 2.3 CamillaDSP (Rust DSP engine, YAML config)

Version 4.1.3 (released 2026-04-09), GPL-3.0 or MPL-2.0; prebuilt binaries include macOS Apple Silicon. [S10]

- **Pipeline:** three threads (capture, processing, playback) joined by queues of fixed-size chunks; capture converts to 64-bit float "(or optionally 32-bit)" and optionally resamples; processing runs the listed filters and mixers; playback converts back. [S10] In the source `PrcFmt` is `f64` unless built with the `32bit` feature (verified).
- **Biquads:** `Free` (raw coefficients), `Lowpass/Highpass` (Q), first-order `LowpassFO/HighpassFO`, `Lowshelf/Highshelf` (gain, plus either `slope` in dB/octave or `q`), `Peaking` (Q or bandwidth in octaves), `Notch`, `GeneralNotch`, `Bandpass`, `Allpass`, `AllpassFO`, `LinkwitzTransform`; combos `ButterworthHighpass/Lowpass`, `LinkwitzRiley...`, `Tilt`, `FivePointPeq`, and `GraphicEqualizer` (any number of bands; the README says gains are limited to +/-40 dB in one place and +/-20 dB in another). [S10]
- **Topology and precision (verified in `src/filters/biquad.rs`):** "Direct Form 2 Transposed"; code `out = s1 + b0*in; s1 = s2 + b1*in - a1*out; s2 = b2*in - a2*out;`; states that become subnormal numbers are flushed to zero; coefficients are the cookbook formulas (comment credits an online biquad designer).
- **FIR:** convolution by FFT; if the filter is longer than the chunk size it uses segmented convolution; the filename may contain `$samplerate$` so one config serves several rates. Latency is the chunk size: suggested 1024 samples at 44.1/48 kHz (about 22 ms), 2048 at 88.2/96 kHz, 4096 at 176.4/192 kHz. [S10]
- **Dither** is a filter meant to be last: `Flat` (triangular; "To linearize the samples, this should be 2" LSB), `Highpass`, and noise-shaped types tuned for 44.1, 48, 88.2, 96 and 192 kHz (Fweighted, Gesemann, Lipshitz, Shibata families); its advice: above 48 kHz "no need for anything more advanced than the Highpass subtype". **Limiter:** hard or soft clip at a set level. [S10]
- **macOS:** CoreAudio via AudioUnits; it always exchanges 32-bit float with CoreAudio and lets CoreAudio convert to the device's physical format; capturing other applications needs a virtual device, BlackHole recommended, which can have its clock rate-adjusted to follow a real device; if the capture device's rate changes, CamillaDSP stops and must be reloaded; the first launch needs microphone permission (it covers all capture). [S10] There is also a `Stdin` capture type that reads raw samples piped in from another program "without going via a virtual soundcard". [S10] BlackHole 2ch is a Homebrew cask (version 0.7.1 today, not installed here). [S25] CamillaDSP is not a Homebrew formula (`brew info camilladsp` says no such formula); it is a release download.

### 2.4 PipeWire filter-chain and EasyEffects (Linux)

PipeWire's filter-chain module has built-in biquads (`bq_lowpass`, `bq_highpass`, `bq_bandpass`, `bq_lowshelf`, `bq_highshelf`, `bq_peaking`, `bq_notch`, `bq_allpass`, each with Freq, Q, Gain controls, and a `bq_raw` for explicit coefficients, selected per sample rate), a `param_eq` that chains biquads and "accepts configuration from AutoEQ and Squiglink", and a convolver (block size 64 to 256 samples; tail size; reported latency). [S11] EasyEffects is a Linux GUI for PipeWire built on third-party plug-in suites (Linux Studio Plugins, Calf, ZamAudio and others), GPL-3 or later; its README as I could read it does not mention AutoEq import. [S12] Neither runs on macOS; they matter as proof that "AutoEq text in, biquad chain out" is the norm.

### 2.5 eqMac, SoundSource, and the macOS situation

- **eqMac:** system-wide on macOS through a loopback audio driver "based on Apple's Null Audio Server Driver Plug-in" running in user space; free tier has Basic and Advanced (fixed ten bands); the **Expert EQ** ("Unlimited Bands - Gain, Bandwidth (Q Factor or Octaves), Frequency, Multiple filter types") is Pro: $3 per month, $30 per year, or $40 lifetime; macOS 10.13 or later, Intel and Apple Silicon. The public repository is Apache-2.0 but frozen at v1.3.2 ("all the newer releases are done on a private fork"). Its pages do not mention AutoEq or Equalizer APO import. [S13]
- **SoundSource (Rogue Amoeba):** "built-in 10-band equalizer and support for Audio Units"; the page I read lists macOS 15 to 27 for version 6.1.5 and gives no price or filter types. [S14]
- Another lane read about MIT-licensed menu-bar apps that use Apple's Core Audio process tap (macOS 14.4 or later) and import AutoEq files (named there: ParaEQ, MacEQ). I did not verify those; see `winamp-better.md` section 6. [S29]

### 2.6 ffmpeg filters, and MPD's ffmpeg filter plug-in

- MPD's manual has no equalizer. [S15] MPD does have a filter plug-in called `ffmpeg` ("Configures a FFmpeg filter graph. Requires libavfilter", setting `graph`), attached to an output with `filters`. [S15] The plug-in builds an ffmpeg graph from MPD's input format and detects the output format. [S16]
- **Verified on this machine:** `/opt/homebrew/bin/mpd` (0.24.15) is linked against `libavfilter.12.dylib`, `libavcodec`, `libsoxr` and `libsamplerate` (`otool -L`). `mpd --version` lists "Filters: libsamplerate soxr", but that line is hard-coded to the two resampler back-ends in MPD's `src/CommandLine.cxx` (read today), so it says nothing about filter plug-ins. **The `ffmpeg` filter plug-in is compiled into this binary:** `strings /opt/homebrew/bin/mpd` contains the plug-in's own error text `Missing "graph" configuration` (it appears at `FfmpegFilterPlugin.cxx` line 102 and nowhere else in MPD's source as far as I read), and the binary imports `avfilter_graph_parse2`, `avfilter_graph_config` and `avfilter_link`. I checked the file only; MPD was not run. Another lane read the version listing as "does not appear to be compiled in"; the binary says otherwise. How the plug-in behaves at run time on this machine is untested.
- ffmpeg's `equalizer` (bell), `lowshelf`, `highshelf`, `bass`, `treble` filters have `width_type` (including `q`), `transform` (including `tdii`) and `precision` (including `f64`) options in the ffmpeg installed here (9.0.2; `ffmpeg -h filter=equalizer`). [S26] **I verified by impulse response that `equalizer=...:t=q`, `lowshelf=...:t=q` and `highshelf=...:t=q` equal the cookbook formulas with Q: maximum difference 0.00000 dB on five test filters, and 1.2e-11 dB on the ten-filter HD 600 chain plus its preamp.** (Section 8.)

### 2.7 Table: the field at a glance

| Tool | Where it sits | Filter model | Math | Platform now |
|---|---|---|---|---|
| Equalizer APO | Windows audio engine (APO, pre/post-mix) | Unlimited biquads, GraphicEQ, FIR, routing, VST | Cookbook form assumed; precision UNCONFIRMED | Windows |
| Peace | GUI for Equalizer APO | Up to 31 sliders per channel or unlimited | n/a | Windows |
| AutoEq | Offline generator | PK/LSC/HSC lists, ten- and 31-band graphic, FIR | Cookbook at 44.1 kHz default | Any (Python); output feeds others |
| CamillaDSP | Own process between devices | Biquads, FIR, mixers, dither, limiter | Cookbook, TDF-II, f64 | Linux, Windows, macOS (aarch64 binary) |
| PipeWire filter-chain | Inside PipeWire | `bq_*`, `param_eq`, convolver | Not read | Linux |
| EasyEffects | GUI on PipeWire | Plug-in suites | Not read | Linux |
| eqMac | Loopback driver + app | Free: fixed 10 bands. Pro: unlimited bands | Not published | macOS |
| SoundSource | App with per-app effects | 10-band EQ, Audio Units | Not published | macOS |
| ffmpeg in MPD | Inside MPD's output | `equalizer`, `lowshelf`, `highshelf` | Cookbook, verified | Wherever MPD has libavfilter |

### 2.8 What the prior art agrees on

1. Filters are a list of (type, frequency, gain, Q) rows plus one preamp, per channel set.
2. Biquad coefficients come from the cookbook; the chain is a cascade of those biquads.
3. Headroom is handled by a preamp equal to minus the peak of the combined curve. Nobody relies on a soft clipper for it.
4. Anything that needs an arbitrary curve is a FIR convolution at the device rate.
5. 64-bit processing where the engine is serious about it (CamillaDSP); 32-bit float is what the OS exchanges.

## 3. What today's app does (verified by reading `eq.rs`, `audio.rs`, and by measurement)

Context facts first. This is an Apple M3 Max; the default output device right now is "External Headphones" (built-in jack) at 44,100 Hz, the display is at 48,000 Hz, the speakers at 44,100 Hz (`system_profiler SPAudioDataType`, read-only). `mpc outputs` right now: Visualizer FIFO enabled, OS X Output enabled, Headspace disabled. `/opt/homebrew/etc/mpd.conf` defines Headspace as a FIFO with `format "44100:16:2"`. [S28]

| # | Fact | Evidence |
|---|---|---|
| F1 | Audio path: MPD writes 16-bit 44.1 kHz stereo to the FIFO; the app converts to 32-bit float, runs the EQ at 44.1 kHz, then a Catmull-Rom cubic resampler to the device rate, then the device. Anything MPD plays is reduced to CD format first. | `audio.rs:29-31`, `:226-232`, `:309-329`; `mpd.conf` |
| F2 | EQ: ten cookbook peaking filters at 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000 Hz, Q 1.41, +/-14 dB, 32-bit float, transposed direct form II, per channel. Centre frequencies are clamped to 0.45 of the sample rate. | `eq.rs:7-13`, `:25-40`, `:99-105` |
| F3 | The ten bands are almost AutoEq's ten-band graphic layout (31.25 x 2^i, Q sqrt(2), +/-12 dB). AutoEq's FixedBandEQ.txt can be typed into the sliders (section 5, route B). | `constants.py` (`10_BAND_GRAPHIC_EQ`) |
| F4 | `set_gains` swaps all coefficients instantly and keeps the filter memory. Measured: this causes a click. High-pass part of the output (above 3 kHz), peak, for a 200 Hz tone at -6 dBFS through a bell at 200 Hz: **-34.5 to -42.1 dBFS** for a 12 dB step, **-64.3 dBFS** for a 1 dB step, **-76.3 dBFS** for a 0.25 dB step (worst of eight phases). A slider drag is a train of such steps. My simulation uses 64-bit, same structure. | `eq.rs:74-84`; section 4.6 |
| F5 | Headroom: preamp is `10^(-0.6 x largest boost / 20)`. On the HD 600 ten-band preset (largest boost 6.9 dB) that is -4.1 dB, but the true peak of the combined response is +7.47 dB, so a full-scale tone at 31.4 Hz would leave 3.3 dB over full scale before the clipper. AutoEq's own preamp for that preset is -7.5 dB. | `eq.rs:82-83`; `hd600_fixed.txt` |
| F6 | A `tanh` soft clipper above 0.7 (-3.1 dBFS) runs after the filters whenever the EQ is not flat. Measured distortion on a sine: 0.00% up to -3.1 dBFS, **0.14% at -2, 0.97% at -1, 2.85% at 0 dBFS**. On the ten-band HD 600 preset the clipper starts to act when a 31 Hz tone reaches -6.4 dBFS at the input. | `eq.rs:114-125` |
| F7 | The resampler is a Catmull-Rom cubic and its fractional position drifts to chase MPD's clock. Measured at 44.1 to 48 kHz: tone gain **-0.38 dB at 10 kHz, -1.65 at 15 kHz, -3.1 at 18 kHz, -4.4 at 20 kHz**; the non-tone residual (images folded back) is **-26 dB re tone for a 10 kHz tone and -14 dB for 15 kHz** (-46 dB at 5 kHz, -89 dB at 1 kHz). At the same rate, the gain depends on the fractional position: a 15 kHz tone is 0 dB at offset 0 and **-3.5 dB at offset 0.5**, so the top octave "breathes" as the offset drifts. My re-implementation of `cubic()` reproduces the code exactly. | `audio.rs:309`, `:349-361`; section 4.9 |
| F8 | The audio callback takes locks on the ring buffer and the EQ. (Architecture lane covers this.) | `audio.rs:297`, `:310` |
| F9 | The WAV recorder converts with `(s * 32767) as i16`, which truncates toward zero, with no dither. Measured: at -60 dBFS the biggest distortion spur is -44.4 dB re the tone (truncate) vs -53.3 (round) vs -73.6 (TPDF dither). | `audio.rs:121`; section 4.8 |
| F10 | None of these defects are in the skin or UI layer; they live in a few hundred lines that the server replaces. | |

## 4. Specification: the DSP core the server needs

All of this is **Recommendation** unless tagged **Verified** or sourced. Names are suggestions.

### 4.1 Where it sits in the chain

Stage order (agrees with the architecture lane's section 10.3): decoder output as float, rate conversion if needed, loudness gain, **preamp**, **EQ filters** (and optional FIR), balance, volume, optional limiter, **dither**, convert to the device format. The preamp is the one stage that makes the boost safe; volume comes after the EQ so that the volume knob does not change what the filters see.

Number format: **64-bit floating point inside the DSP, 32-bit float at the device edge** (CoreAudio's native exchange format, per [S10]'s description of how CamillaDSP talks to it). The DSP core is plain C with no allocation, fixed loop bounds, no global state, built without fast-math and with FMA contraction off, so identical input gives identical bits (my tests used `-ffp-contract=off`).

### 4.2 The filter definition (what is stored)

A band is stored as a definition that does not depend on the sample rate:

```
band = { on, type, f0_hz, gain_db, q | bandwidth_octaves | slope }
types: PK, LS, HS, LP, HP, BP, NOTCH, AP   (+ first-order LP1, HP1)
chain = { preamp_db, [band...], per channel set }
```

**Coefficients are never stored.** They are a pure function `design(band, fs, mode) -> (b0,b1,b2,a1,a2)` with a0 normalised to 1, recomputed whenever the sample rate changes (section 4.9).

Accepted domain (reject, do not silently clamp): `0 < f0 < 0.49 fs`, `Q > 0`, gain within +/-20 dB, Q in 0.18 to 10 for the analog-matched peaking design. The matched design was verified numerically over exactly that grid (section 4.5); widen only after extending the grid. For shelves: the cookbook's slope parameter S=1 is the steepest shelf that stays monotonic, and S=1 equals Q = 1/sqrt(2) = 0.7071 at any gain (from the cookbook's relation `1/Q = sqrt((A+1/A)(1/S-1)+2)`, setting S=1). So **a shelf with Q above 0.7071 overshoots** (this is what AutoEq's "0.4 to 0.7" comment is about). The UI should show that.

### 4.3 The exact formulas (RBJ / W3C Audio EQ Cookbook) [S1]

Given sample rate `Fs`, centre or corner frequency `f0`, gain `dBgain` (peaking and shelves only), and Q, bandwidth BW (octaves) or shelf slope S:

```
A     = 10^(dBgain/40)                   (peaking and shelves)
w0    = 2*pi*f0/Fs
alpha = sin(w0)/(2Q)                                           [Q form]
      = sin(w0) * sinh( ln(2)/2 * BW * w0/sin(w0) )             [BW form]
      = sin(w0)/2 * sqrt( (A + 1/A)*(1/S - 1) + 2 )             [S form, shelves]
relations:  1/Q = 2*sinh( ln(2)/2 * BW * w0/sin(w0) )   (digital filter)
            1/Q = 2*sinh( ln(2)/2 * BW )                  (analog prototype)
            1/Q = sqrt( (A + 1/A)*(1/S - 1) + 2 )         (shelf slope to Q)
```

Then `H(z) = (b0 + b1 z^-1 + b2 z^-2)/(a0 + a1 z^-1 + a2 z^-2)`; divide all six by `a0` before use.

```
LPF   b0=(1-cos w0)/2   b1=1-cos w0      b2=(1-cos w0)/2   a0=1+alpha  a1=-2cos w0  a2=1-alpha
HPF   b0=(1+cos w0)/2   b1=-(1+cos w0)   b2=(1+cos w0)/2   a0=1+alpha  a1=-2cos w0  a2=1-alpha
BPF (skirt gain = Q)    b0=sin(w0)/2=Q*alpha   b1=0   b2=-Q*alpha          (same a's)
BPF (0 dB peak)         b0=alpha   b1=0   b2=-alpha                          (same a's)
notch                   b0=1   b1=-2cos w0   b2=1                            (same a's)
APF                     b0=1-alpha   b1=-2cos w0   b2=1+alpha                (same a's)
peakingEQ  b0=1+alpha*A  b1=-2cos w0  b2=1-alpha*A   a0=1+alpha/A  a1=-2cos w0  a2=1-alpha/A
lowShelf   b0=   A*((A+1) - (A-1)cos w0 + 2*sqrt(A)*alpha)
           b1= 2*A*((A-1) - (A+1)cos w0)
           b2=   A*((A+1) - (A-1)cos w0 - 2*sqrt(A)*alpha)
           a0=      (A+1) + (A-1)cos w0 + 2*sqrt(A)*alpha
           a1=  -2*((A-1) + (A+1)cos w0)
           a2=      (A+1) + (A-1)cos w0 - 2*sqrt(A)*alpha
highShelf  b0=   A*((A+1) + (A-1)cos w0 + 2*sqrt(A)*alpha)
           b1=-2*A*((A-1) + (A+1)cos w0)
           b2=   A*((A+1) + (A-1)cos w0 - 2*sqrt(A)*alpha)
           a0=      (A+1) - (A-1)cos w0 + 2*sqrt(A)*alpha
           a1=   2*((A-1) - (A+1)cos w0)
           a2=      (A+1) - (A-1)cos w0 - 2*sqrt(A)*alpha
```

In the cookbook the peaking filter's Q is defined so that "a boost of N dB followed by a cut of N dB for identical Q and f0/Fs results in a precisely flat unity gain filter". [S1] **Verified:** peaking(+9 dB) times peaking(-9 dB) is flat to 4e-14 dB. Also verified: the cookbook peaking filter has exactly 0 dB at DC and at Nyquist, and exactly the set gain at `f0`.

**First-order (6 dB/octave) low-pass and high-pass** (bilinear transform with `K = tan(pi*f0/Fs)`; CamillaDSP uses the same form [S10]): low-pass `b0=b1=K/(1+K)`, `a1=(K-1)/(1+K)`; high-pass `b0=1/(1+K)`, `b1=-b0`, `a1=(K-1)/(1+K)`; `b2=a2=0`. **Verified:** -3.0103 dB at `f0`, unity at DC (low-pass) and at Nyquist (high-pass).

**Evaluating the response** for the UI curve and for the preamp (numerically robust form, Vicanek eq. 25-27 [S2]): with `phi0 = 1 - sin^2(w/2)`, `phi1 = sin^2(w/2)`, `phi2 = 4*phi0*phi1`, `A0=(1+a1+a2)^2`, `A1=(1-a1+a2)^2`, `A2=-4*a2`, `B0=(b0+b1+b2)^2`, `B1=(b0-b1+b2)^2`, `B2=-4*b0*b2`:

```
|H(e^jw)|^2 = (B0*phi0 + B1*phi1 + B2*phi2) / (A0*phi0 + A1*phi1 + A2*phi2)
```

This avoids complex arithmetic and cancellation near DC. DC gain is `(b0+b1+b2)/(1+a1+a2)`.

**Stability (exact, from the coefficients):** with `H(z)` as above and `a0 = 1`, a biquad is stable exactly when `|a1| < 1 + a2` and `a2 < 1` (Vicanek eq. 3, "the stability triangle"). [S2] **Verified:** all ten HD 600 filters and all 1,620 grid cases of the matched design satisfy it. For the cookbook types that share the denominator `1 + alpha`, `-2cos w0`, `1 - alpha` (low-pass, high-pass, band-pass, notch, all-pass) it follows by algebra: `a2 = (1-alpha)/(1+alpha) < 1` for `alpha > 0`, and `|a1| < 1 + a2` reduces to `|cos w0| < 1`, i.e. `0 < f0 < Fs/2`. The same holds for the peaking filter with `alpha` replaced by `alpha/A` in the denominator. The two shelves have a different denominator (`(A+1) -/+ (A-1)cos w0 + 2*sqrt(A)*alpha`, etc.); I checked them numerically for the HD 600's two shelves (inside the triangle at 44.1 and 48 kHz) but have not shown it algebraically, so P1 in 4.13 keeps shelf stability as an item to prove.

### 4.4 Topology and precision

**Structure: transposed direct form II, 64-bit.**

```
y  = b0*x + z1
z1 = b1*x - a1*y + z2
z2 = b2*x - a2*y          (a0 = 1)
```

Same as the app, and as CamillaDSP's `process_single`. [S10] Sources for the choice: Earlevel recommends it for its "good floating point characteristics" and two delays; [S18] Julius O. Smith gives the reason that in this form "the zeros effectively precede the poles", which helps where poles give large gain that the zeros compensate; [S19] Wishnick notes it is not time-varying stable in general, which section 4.6 handles. [S17]

**Measured (64-bit versus 32-bit), error against a 64-bit reference, white noise at -20 dBFS RMS, 2^21 samples** (errors are dB relative to the output power; more negative is better):

| Filter set | Rate | 32-bit coefficients only | 32-bit TDF-II (what `eq.rs` does) | 32-bit direct form I |
|---|---|---|---|---|
| HD 600 ten filters | 44.1 kHz | -88.3 | -84.8 | -82.9 |
| HD 600 ten filters | 96 kHz | -78.4 | -74.2 | -72.0 |
| HD 600 ten filters | 192 kHz | -75.5 | -66.2 | -63.2 |
| 31 Hz bell +12 dB, Q 1.41 | 44.1 kHz | -97.3 | -68.7 | -65.4 |
| 31 Hz bell +12 dB, Q 1.41 | 96 kHz | -62.8 | -57.3 | -54.7 |
| 31 Hz bell +12 dB, Q 1.41 | 192 kHz | -58.2 | -48.7 | -45.8 |
| 30 Hz shelf +6 and 20 Hz bell +6 | 192 kHz | -52.1 | -44.6 | -41.9 |

Reading: even with exact arithmetic afterwards, rounding the *coefficients* to 32-bit alone leaves the 31 Hz band at 192 kHz with an error only 58 dB below the signal (the response is wrong by 0.20 dB between 10 and 200 Hz; 0.11 dB at 96 kHz). The cause is that low-frequency filters at high rates have poles very close to 1 (radius 0.99982 at 192 kHz), and the numerator involves differences of near-equal numbers. 16-bit audio has a noise floor near -98 dBFS, so 32-bit TDF-II is borderline at 44.1 kHz and clearly inadequate for bass bands at high rates. **CPU cost of 64-bit is trivial: 1.95 ns per biquad-sample (scalar, one core); 32 filters x 2 channels x 192 kHz = 2.4% of one core.** (Vicanek's note that some of his formulas "require double precision" is about *computing* coefficients for his lowpass and highpass designs, a different point; it supports 64-bit design arithmetic as well. [S2])

**Denormals.** **Verified:** the HD 600 cascade's impulse response decays into subnormal numbers (about 1.5e-323) within 2^18 samples (5.9 s at 44.1 kHz). Subnormal arithmetic can be slow on some CPUs. Flush filter states to zero when they fall below about 1e-30 (CamillaDSP flushes explicitly [S10]) or set the CPU's flush-to-zero mode at callback entry (the architecture lane's rule 7).

**Ringing and delay of real presets (verified):** HD 600 parametric set: group delay up to 1.5 ms at 20 Hz; impulse response below 1e-6 after 1,005 samples (23 ms at 44.1 kHz). HD 600 ten-band set (+6.9 dB at 31 Hz): group delay up to 11.3 ms near 30 Hz; tail below 1e-6 after 7,358 samples (167 ms).

### 4.5 Frequency cramping near Nyquist, and the fixes

**The problem.** The cookbook's bilinear transform maps the whole analog frequency axis onto 0 to Nyquist, so analog response above 8 kHz or so is squeezed. For a bell, the digital response is forced to **exactly 0 dB at Nyquist**, whereas the analog prototype is not. The result is a narrower, weaker bell. [S1][S2]

**Measured (cookbook versus the analog prototype, +6 dB bell, Q 1.41; maximum difference over 20 Hz to 20 kHz):**

| Rate | Bell at 10 kHz | Bell at 16 kHz |
|---|---|---|
| 44.1 kHz | 1.57 dB | 3.88 dB |
| 48 kHz | 1.33 dB | 3.30 dB |
| 88.2 kHz | 0.40 dB | 0.79 dB |
| 96 kHz | 0.34 dB | 0.65 dB |
| 176.4 kHz | 0.10 dB | 0.17 dB |
| 192 kHz | 0.08 dB | 0.15 dB |

At 44.1 kHz, the 10 kHz bell: analog 4.69 / 2.54 / 1.51 / 1.14 dB at 12 / 15 / 18 / 20 kHz; cookbook 3.58 / 0.99 / 0.23 / 0.05 dB. **Oversampling cuts the error by about 4x per doubling** (so 2x oversampling, 88.2 kHz, still leaves 0.4 dB for the 10 kHz bell and 0.8 dB for the 16 kHz bell; 4x, 176.4 kHz, gets to about 0.1 and 0.17 dB), at the cost of a resampler up and down and its delay. Vicanek says the same in one line: "Oversampling provides remedy but at a high CPU cost". [S2]

**Option 1, closed-form analog-matched bell (Vicanek 2016).** [S2] Poles from impulse invariance; zeros chosen to make DC gain 1 and the gain at `f0` exactly the target, with a minimum-phase numerator. **Verified in my implementation:** gain at `f0` equals the target to 4 decimals, DC is 0 dB, stable, over a grid of 1,620 cases (rates 44.1, 48, 96 kHz; `f0` from 20 Hz to 0.49 Fs; gains -20 to +20 dB; Q 0.18 to 10): no failures. Error against analog (max over 20 Hz to 20 kHz): 10 kHz bell 0.34 dB at 44.1 kHz and 0.21 dB at 48 kHz versus the cookbook's 1.57 and 1.33; 16 kHz bell 0.44 versus 3.88 at 44.1 kHz; at 96 kHz 0.008 and 0.005 dB.

Inputs `fs, f0, gain_dB, Q`. Steps (source equations 12, 44, 45, 29; the mapping `q = 1/(2*sqrt(G)*Q)` comes from the prototype in eq. 42, whose denominator is `w0^2 + s*w0/(sqrt(G)*Q) + s^2`):

```
G  = 10^(gain_dB/20)             (linear gain at f0)
w0 = 2*pi*f0/fs
q  = 1/(2*sqrt(G)*Q)
a1 = -2*exp(-q*w0)*cos(sqrt(1-q^2)*w0)     if q <= 1
a1 = -2*exp(-q*w0)*cosh(sqrt(q^2-1)*w0)    if q >  1
a2 = exp(-2*q*w0)
phi0 = 1 - sin^2(w0/2);  phi1 = sin^2(w0/2);  phi2 = 4*phi0*phi1
A0 = (1+a1+a2)^2;  A1 = (1-a1+a2)^2;  A2 = -4*a2;   B0 = A0
R1 = (A0*phi0 + A1*phi1 + A2*phi2) * G^2
R2 = (-A0 + A1 + 4*(phi0-phi1)*A2) * G^2
B2 = (R1 - R2*phi1 - B0) / (4*phi1^2)
B1 = R2 + B0 + 4*(phi1-phi0)*B2
W  = 0.5*(sqrt(B0) + sqrt(B1))
b0 = 0.5*(W + sqrt(W^2 + B2));   b1 = 0.5*(sqrt(B0) - sqrt(B1));   b2 = -B2/(4*b0)
```

The paper's other matched designs (low-pass, high-pass, band-pass, and "even simpler" versions matched at Nyquist) are in the same document; its 2019 note covers matched **first-order** shelves only. [S2][S3] **There is no matched second-order shelf in those two papers.** For second-order shelves the options are the cookbook (the HD 600's 10 kHz high shelf at Q 0.7, -3.1 dB, differs from its analog prototype by at most 0.37 dB at 44.1 kHz, 0.32 at 48 kHz, 0.08 at 96 kHz), oversampling, or Orfanidis' prescribed-Nyquist-gain designs (JAES 1997; Vicanek's note says the centre frequency must be at least half a bandwidth below Nyquist for it) which I did not implement. [S2][S27]

**The decisive fact about presets.** AutoEq fits its filters against the cookbook response at 44.1 kHz. So the squeezed top end is part of what was optimized. **Measured on the HD 600 preset:** the cookbook cascade at 48 kHz differs from the cookbook cascade at 44.1 kHz by at most 0.14 dB (at 12.5 kHz); at 88.2 kHz by 0.67 dB; at 96 kHz by 0.71 dB; at 192 kHz by 0.85 dB (near 13 kHz in each case). Swapping the ten bells for the matched design at 44.1 kHz (shelves unchanged) differs from the cookbook by at most 0.62 dB (at 11.7 kHz).

**Recommendation, as a choice for the owner.**

| Mode | What it does | Good | Bad |
|---|---|---|---|
| A. "Equalizer APO compatible" (default) | Cookbook at the working sample rate | Same as AutoEq's fit and every other tool; imported presets behave as published. | Response shifts with sample rate: up to 0.14 dB between 44.1 and 48 kHz, up to 0.85 dB at 192 kHz (HD 600 example), mostly 10 to 15 kHz where the preset is loosest anyway. |
| B. "Analog-matched" (switch) | Matched bells (Vicanek), cookbook shelves | Response nearly independent of sample rate; a bell means what its label says. | Differs from the published fit by up to 0.6 dB in the top octaves. |
| C. Oversample first | Cookbook at >= 88.2 kHz | Any filter type | Delay, CPU, a resampler pair; error still 0.4 to 0.8 dB at 2x and about 0.1 to 0.17 dB at 4x |

The mode is stored in the profile so a preset always renders the same way. The UI draws the curve from the actual coefficients (formula above), so what the owner sees is what the filter does in either mode.

### 4.6 Coefficient smoothing on parameter change

**Measured.** A 200 Hz sine at -6 dBFS through a bell at 200 Hz, Q 1.41; gain changes at t = 0.5 s; metric is the peak level of the part of the output above 3 kHz in the next 150 ms (any content there is an artifact); worst of eight phases of the tone; the measurement floor is about -104 dBFS (spectral leakage of the test). 64-bit throughout.

| Method | 12 dB step | 1 dB step |
|---|---|---|
| Swap coefficients, TDF-II, keep state (the app today) | -34.5 to -42.1 dBFS | -64.3 |
| Swap coefficients, direct form I | -64.6 to -70.8 | -93.0 |
| Ramp coefficients linearly over 5 ms, TDF-II | -80.6 to -86.8 | not measured |
| Ramp coefficients linearly over 20 ms, TDF-II | -92.3 to -99.4 | -119.0 |
| Ramp coefficients linearly over 50 ms, TDF-II | -97.4 to -108.4 | not measured |
| Re-design every sample from a gain ramped in dB over 20 ms, TDF-II | -92.5 to -100.0 | -119.0 |
| Ramp coefficients over 20 ms, direct form I | -104.3 to -117.1 | not measured |
| Cross-fade old and new chain, **linear** fade, 20 ms | -58.1 to -70.1 | not measured |
| Cross-fade old and new chain, **raised-cosine** fade, 20 ms | -102.8 to -114.8 | -130.6 |

A 0.25 dB step swapped hard: -76.3 dBFS (TDF-II) and -105.0 (direct form I); with a 20 ms ramp -131.4 dBFS.

Source support: Wishnick (DAFx-14) writes that direct form II and lattice structures "are not necessarily stable when coefficients are changed", lists transposed direct form II among the time-varying-unstable structures, says "interpolating TDF-II coefficients can give less sensible intermediate transfer functions", and found that "output switching, i.e., eliminating the transient response of a filter, is not desirable in musical applications". He proposes the state-variable filter (SVF) as time-varying stable. [S17]

**Rules (Recommendation):**

1. **Smooth the parameters, not the coefficients.** Ramp gain in dB, frequency in log-frequency, Q in log-Q, over a default of **20 ms** (user range 10 to 50 ms), and recompute the coefficients from the smoothed parameters. Re-design **every sample** was measured; recomputing every 16 to 32 samples is the obvious economy and is **not measured here** (UNCONFIRMED but low risk; measure when built). The matched bell is cheap enough ("so the filter characteristic may be modulated with near sample rate updating", Vicanek [S2]).
2. **Structural changes** (add or remove a band, change type, load a preset, bypass on/off, change mode): cross-fade the old chain into the new one with a **raised-cosine** law over 20 ms. A straight linear fade is 40 to 50 dB worse because of the slope kinks at its ends.
3. **Adding a bell or shelf costs nothing structurally:** at 0 dB gain the cookbook filter is an exact identity (numerator equals denominator), so insert it at 0 dB and ramp the gain.
4. **Never reset or swap filter memory** to hide a change.
5. If a future feature sweeps parameters at audio rate (an LFO), switch those sections to an SVF (Wishnick's recommendation) rather than pushing TDF-II harder. Not needed for UI edits.
6. Parameter hand-off from the control thread to the audio thread is the architecture lane's immutable-block-and-atomic-pointer scheme. This section only fixes the *audio-side ramp law*.

### 4.7 Preamp and headroom

**What the field does.** Preamp = minus the peak of the combined response. AutoEq: `Preamp: -{max_gain:.1f} dB`, max taken over 20 Hz to 20 kHz on a 1.02-ratio grid. [S9] Equalizer APO's `Preamp:` exists for exactly this; values add. [S4]

**Verified on the HD 600 parametric preset.** My cookbook cascade gives a maximum of +6.263 dB at the lowest grid point (20 Hz), which rounds to AutoEq's `-6.3 dB`; that agreement validates my implementation against AutoEq's. Two further facts:

- The true maximum is at **DC: +6.500 dB** (the low shelf's full gain), 0.24 dB above the audible-band maximum. After a -6.3 dB preamp a full-scale 20 Hz tone peaks at -0.04 dBFS, and at DC the output would be +0.2 dB over full scale. Nothing audible lives there, but a formal statement "cannot clip" has to cover it.
- The *sum* of all positive gains in that preset is 13.6 dB and the largest single gain is 6.5 dB; the true peak of the combination is 6.5 dB. Neither shortcut is right: "largest single gain" can be too small when bands overlap (the ten-band preset: peak +7.47 dB against largest gain +6.9), "sum" is far too large.

**Rule.**

```
H_peak_dB = max over f in {DC} U [20 Hz, Fs/2]  of  20*log10 |H_total(f)|     (cascade, using the response formula in 4.3)
preamp_dB = -ceil_to_0.1dB( max(0, H_peak_dB) )
```

Evaluate on at least 200 points per octave plus the exact DC value, then refine local maxima. **Round up**, not to nearest (AutoEq rounds to nearest, which can leave a few hundredths of a dB over). Total pre-gain from loudness normalisation and the EQ preamp share one budget; the architecture lane owns the loudness side.

**What this guarantees and what it does not.** It guarantees a steady sine at any frequency cannot exceed full scale after the EQ. It does not bound broadband music: for any linear filter the true worst-case output is `max|x| x ||h||_1` where `||h||_1` is the sum of the absolute impulse response. **Measured:** HD 600 parametric: `||h||_1` = +9.14 dB against peak response +6.50 dB; ten-band preset: +11.30 dB against +7.47 dB. A "provably never clips" mode would cost 2.6 and 3.8 dB more headroom for a bound that real music essentially never approaches (my judgement, not measured on music). Offer it as an option, not the default.

**No soft clipper in the linear path.** The app's `tanh` at -3.1 dBFS adds up to 2.85% distortion when it acts (F6). Instead: an **optional, off-by-default look-ahead limiter after the EQ** whose transfer function is written down, as the last guard (CamillaDSP's `Limiter` is a hard or soft clip at a set level [S10]; ffmpeg has an `alimiter` look-ahead limiter [S26]). If a limiter is used, measure *true* peak: ITU-R BS.1770-5 specifies 4x oversampling (48 kHz to 192 kHz) with a 48-tap, 4-phase interpolating FIR, 2x being sufficient for 96 kHz material, because "the true-peak value may occur between samples". [S20] Whether CoreAudio clamps or wraps float samples above 1.0 at the device boundary is UNCONFIRMED.

### 4.8 Dither

- **Only when converting to integers**, and only once, as the very last stage. When the device is fed 32-bit float (CoreAudio's normal exchange format, [S10]) the server adds none; CoreAudio converts to the device's physical format.
- **Method:** TPDF (triangular) dither, peak-to-peak 2 LSB, then rounding to nearest: `q = round(x * 2^(N-1) + r1 - r2)` with `r1, r2` independent uniform on [0,1), then clip to the integer range and count clips. Lipshitz, Wannamaker and Vanderkooy's survey is the standard reference for the amplitude (not opened; found by search) [S22]; CamillaDSP's "Flat" subtype says the same: triangular, amplitude 2 LSB "to linearize". [S10] MPD's own 24-to-16-bit dither code appears to subtract two random values, which gives a triangular distribution (my reading of `Dither.cxx`, not tested) [S16].
- **Noise shaping:** only for 16-bit output at 44.1 and 48 kHz, where there is no spare bandwidth; CamillaDSP lists tuned shapers (F-weighted, Gesemann, Shibata) for those rates and says above 48 kHz the plain high-pass dither is enough. [S10]
- **Measured (one-bin tone, 2^18 samples, spur = biggest single spectral line other than the tone):**

| Tone level | Truncate (what `write_wav` does) | Round, no dither | Round + TPDF |
|---|---|---|---|
| -20 dBFS | -83.8 dBc | -106.0 | -113.8 |
| -60 dBFS | -44.4 | -53.3 | -73.6 |
| -80 dBFS | -18.8 | -25.3 | -54.0 |
| -90 dBFS | -0.8 | -14.6 | -43.3 |

(dBc = dB relative to the tone. TPDF trades correlated distortion for a slightly higher, constant noise floor: total 20 Hz to 20 kHz residual at -60 dBFS is -33.7 dB re tone with dither, -38.4 with plain rounding. That is the intended trade.)

### 4.9 Sample-rate changes and rate conversion

1. **Definitions are rate-free; coefficients are derived** (4.2). When the working rate changes, redesign every section at the new rate, recompute the preamp, zero the filter memory (the old memory belongs to a different system), and fade in with the structural-change fade of 4.6.
2. **Which rate the EQ runs at** is a policy the architecture lane owns (follow the file's rate when the device can, otherwise a fixed rate with conversion). The DSP consequence: with mode A (cookbook) the same preset's response moves slightly with rate (section 4.5 numbers); with mode B it hardly moves.
3. **Rate conversion quality.** Use libsoxr, already installed here and linked by MPD. It advertises configurable bandwidth, aliasing and rejection, a variable-rate mode, and "bit-perfect within practical occupied-bandwidth limits"; at its High Quality preset converting 44.1 to 48 kHz it has about 1,000 output samples (~20 ms) of latency, which can be reduced with passband and FFT-size parameters. [S23] MPD itself offers libsamplerate and soxr plus its own converter. [S15] Do not interpolate with a cubic (F7).
4. **No drift correction.** The new server's sound card is the only clock and the decoder is paced by it, so there is no second clock to chase and no variable-ratio resampler (architecture lane, section 7). The app's nudging resampler exists only because MPD paces the FIFO.
5. **FIR impulse responses are rate-specific** (Equalizer APO requires the file's rate to equal the device's [S4]; CamillaDSP substitutes `$samplerate$` in file names [S10]). Store each IR with its rate; on a rate change load the matching file or resample the IR offline with the same converter.
6. **Device rate changed by someone else** (headphones plugged in, Audio MIDI Setup): CoreAudio sends a notification; CamillaDSP simply stops and needs a reload when its capture device changes rate [S10]. The server must listen and rebuild (architecture lane 2.3).

### 4.10 FIR / convolution option

- **What it is for:** arbitrary curves (Equalizer APO's `GraphicEQ`, AutoEq's graphic and FIR outputs), room correction, filter files from Room EQ Wizard, linear-phase correction. Not for live slider edits.
- **Algorithm:** uniform-partition FFT convolution (overlap-save), block size B (default 256 samples: 5.8 ms at 44.1 kHz, 2.7 ms at 96 kHz). Gardner's non-uniform partitioning gives zero input-output delay at higher cost (JAES 43(3), 1995; found by search, page not opened). [S21] References for blocks: PipeWire's convolver uses 64 to 256 samples [S11]; CamillaDSP chunk size 1024 at 44.1 kHz [S10].
- **Latency:** added delay equals the block size B. Plus, for a **linear-phase** IR of length L, the filter's own delay `(L-1)/2` samples: for an AutoEq-sized linear-phase IR (about 4,410 taps at 44.1 kHz, per the code in 2.2) about 50 ms. **Minimum-phase** IRs (what AutoEq ships) have almost no extra delay but share the same response magnitude. IIR sections add no buffering delay at all; their group delay is the frequency-dependent figure in 4.4.
- **Normalisation:** AutoEq normalises FIR gain to -0.2 dB below full scale and sets the gain at Nyquist to zero. [S9] Apply the same headroom rule as 4.7 using the IR's measured peak response.
- **Cost:** CamillaDSP's README quotes (for its v0.5.0) 8 channels of 262k-tap FIR at 192 kHz at about 55% of a Raspberry Pi 4. [S10] Not a constraint on an M3 Max.
- **Order in the chain:** after the IIR sections and the preamp, before balance and volume; changes handled by the structural cross-fade of 4.6.

### 4.11 Latency budget

| Part | Added delay | Note |
|---|---|---|
| IIR cascade | 0 samples buffering | Group delay up to 1.5 ms (HD 600 parametric) to 11 ms (ten-band, bass boost) near 30 Hz, inherent to minimum-phase boosts |
| Parameter smoothing | 20 ms to reach the new setting | Not audio delay: how long the slider takes to be fully effective |
| FIR, minimum-phase | B samples (e.g. 256 = 5.8 ms at 44.1 kHz) | |
| FIR, linear-phase | B + (L-1)/2 (e.g. 5.8 + 50 ms) | |
| soxr resample (High Quality, 44.1 to 48 kHz) | ~1,000 output samples (~20 ms) | Configurable lower [S23] |
| Oversampled EQ (mode C) | Two resampler delays | |
| Device buffer | Set by CoreAudio; the architecture lane owns it | Dominates |

For music playback none of this matters except at seek, pause and track change, where the filter tails (23 to 167 ms for the HD 600 sets) simply ring out or are cleared by the structural fade.

### 4.12 Interchange format and parser rules

Adopt **Equalizer APO's text syntax** as the on-disk and import/export format for profiles, with extra comment lines (`# ...`) for the server's own metadata (headphone name, target name, mode A or B, source URL). [S4][S9]

Phase 1 (needed for AutoEq and Peace output): `Preamp: x dB`; `Filter n: ON|OFF type Fc f Hz Gain g dB Q q` with types `PK`, `LSC`, `HSC`, `LS`, `HS` (shelf given a Q), `LP`, `HP`, `BP`, `NO`, `AP`; `BW Oct x` as an alternative to Q; `Channel:`. Phase 2: `GraphicEQ:` (build a FIR, or fit biquads), `Convolution:`, `Copy:`, `Delay:`, `Include:`, `Device:`. Phase 3: `If:` and `Eval:` expressions, `Stage:`, VST hosting (Equalizer APO advertises it [S5]; out of scope for the core).

Parser rules to avoid guessing: a shelf with a Q is the cookbook shelf with Q (this is what AutoEq writes and fits); a shelf with `x dB` slope forms, and `LS`/`HS` with no Q, are **UNCONFIRMED** (default Q and the meaning of the slope form not readable in the source I could fetch). Treat those as "needs the owner's example file or a test on a Windows machine" and refuse with a clear message rather than guess. Preamp lines add; unknown lines are preserved on round trip.

### 4.13 What can be formally verified (for the verification lane)

The DSP core is small, pure, total, and mostly algebra. Properties, in order of cheapness:

| # | Property | Kind of proof |
|---|---|---|
| P1 | Every accepted (type, f0, Q, gain, Fs) gives coefficients with `|a1| < 1 + a2` and `a2 < 1` (stable) | Algebra; a few lines for peaking, low-pass, high-pass, band-pass, notch, all-pass (4.3); the two shelves are still to prove (checked numerically only) |
| P2 | Peaking filter: DC gain exactly 1, Nyquist gain exactly 1, gain at `f0` exactly `A^2`; zero gain gives an identity | Algebra (all checked numerically here) |
| P3 | peaking(g) composed with peaking(-g) is exactly flat (numerator and denominator swap) | Algebra |
| P4 | The design functions are total on the declared domain: no NaN, no infinity, no division by zero | Interval analysis; Gappa proves bounds on numerical programs and produces Coq/Rocq or Why3 proofs [S24] |
| P5 | Floating-point error of the design arithmetic and of one TDF-II step is bounded | Flocq, "a formalization of floating-point arithmetic for the Rocq proof assistant" [S24]; Gappa |
| P6 | State and output of a stable second-order section stay bounded for bounded input; real-number bound `max|y| <= ||h||_1 max|x|` | Standard theorem; for the *floating-point* recursion this is the hard part: Feret's ellipsoid abstract domain (ESOP 2004) is the published method for second-order filters [S24] |
| P7 | Preamp rule: with the preamp from 4.7 and the response maximum evaluated correctly, a steady sine cannot exceed full scale | Needs P2 plus a proof that the grid-plus-refinement maximum is an upper bound (or a closed-form bound) |
| P8 | The parameter smoother reaches its target in exactly N samples, is monotone, never overshoots | Finite-state; easy |
| P9 | Dither: error after TPDF and rounding is bounded by 1.5 LSB and has zero mean; clip counter exact | Easy |
| P10 | Rate change: coefficients are a function of (definition, Fs) only; nothing from the old rate survives | Structural; by construction |

Not provable in any useful sense: that the result sounds right, that a preset matches a given headphone, what the OS or DAC does after the device edge. Two things the proof does **not** cover and the owner should know: the response computed at 44.1 kHz by the cookbook is the *specified* behaviour in mode A, so P2 proves "same as Equalizer APO", not "matches analog"; and none of this proves the ear's verdict.

Suggested API shape (signatures only), consistent with the architecture lane's `ad_dsp_set`:

```c
typedef struct { double b0, b1, b2, a1, a2; } eq_coef;                 /* a0 normalised to 1 */
typedef enum { EQ_PK, EQ_LS, EQ_HS, EQ_LP, EQ_HP, EQ_BP, EQ_NOTCH, EQ_AP, EQ_LP1, EQ_HP1 } eq_type;
typedef struct { int on; eq_type type; double f0_hz, gain_db, q; } eq_band;   /* the rate-free definition */
typedef enum { EQ_MODE_APO_COMPAT, EQ_MODE_ANALOG_MATCHED } eq_mode;
int    eq_design(eq_coef *out, const eq_band *b, double fs, eq_mode mode);    /* pure; error code if outside domain */
void   eq_response_db(const eq_coef *c, int n_sections, const double *f_hz, int n_f, double fs, double *out_db);
double eq_preamp_db(const eq_coef *c, int n_sections, double fs);              /* rule of 4.7 */
```

## 5. EQ the headphones right now

I changed nothing on this machine and did not run MPD, the app, or any installer. Everything below is a recipe for the owner. Steps marked "not tested in place" use math I verified offline but have not exercised inside the target program.

**Which headphones?** Unknown (the Mac reports its jack as "External Headphones", which is the port, not the model). The example uses the Sennheiser HD 600 from oratory1990's results because it is a standard entry; the files are in AutoEq under `results/oratory1990/over-ear/Sennheiser HD 600/`. [S9] Over-ear versus in-ear changes the target (Harman over-ear 2018 versus in-ear 2019). Tell me the model and which of AutoEq's databases to prefer and the exact files can be fetched.

### Route A: MPD's own ffmpeg filter (smallest change, best math, not tested in place)

A filter block plus one line on the output that goes to the headphones. The ten-filter HD 600 preset as one `graph` (verified: the chain matches the cookbook cascade plus preamp to 1.2e-11 dB; the `graph` value is one long line):

```
filter {
    plugin "ffmpeg"
    name   "headphone_eq"
    graph  "volume=-6.3dB:precision=double,lowshelf=f=105:t=q:w=0.7:g=6.5:precision=f64:transform=tdii,equalizer=f=125:t=q:w=0.55:g=-2.7:precision=f64:transform=tdii,equalizer=f=8445:t=q:w=1.61:g=3.3:precision=f64:transform=tdii,equalizer=f=522:t=q:w=1.02:g=0.7:precision=f64:transform=tdii,equalizer=f=1298:t=q:w=2.14:g=-1.2:precision=f64:transform=tdii,highshelf=f=10000:t=q:w=0.7:g=-3.1:precision=f64:transform=tdii,equalizer=f=3158:t=q:w=3.67:g=-1.8:precision=f64:transform=tdii,equalizer=f=2166:t=q:w=3.32:g=0.9:precision=f64:transform=tdii,equalizer=f=6639:t=q:w=5.82:g=2.2:precision=f64:transform=tdii,equalizer=f=5433:t=q:w=5.7:g=-1.2:precision=f64:transform=tdii"
}
audio_output {
    type "osx"
    name "OS X Output"
    mixer_type "hardware"
    filters "headphone_eq"
}
```

Syntax from the MPD manual and plug-in reference: a `filter` block with `plugin`, `name`, and `graph`; attached by `filters` in the `audio_output` block. [S15] Notes: it needs an MPD restart; it affects only that output (the Visualizer FIFO would not be EQ'd unless given the same `filters` line); while the window_headMPD app is in output mode it switches OS X Output off, so the app and this filter are alternatives, not a stack. The plug-in is present in this MPD binary (section 2.6). What is **unconfirmed**: how it behaves in use. MPD's plug-in tries to detect the graph's output format and, if it cannot, forces the output format to equal the input format (`FfmpegFilterPlugin.cxx` lines 78-88 [S16]). MPD has no 64-bit float sample format that I know of, so the 64-bit result is probably converted back to the source's format: for a 16-bit source that is 16-bit output after the -6.3 dB preamp, converted by libswresample with, by default, no dither (a guess from the source I read, UNCONFIRMED). Appending `,aformat=sample_fmts=flt` to the graph should hand MPD 32-bit float, which it does understand (also UNCONFIRMED). Also unknown: where MPD places this filter relative to its software volume or ReplayGain. If MPD refuses the block at start-up, the log will say so; remove the block and it is as before. Replace the graph with one built from your own headphone's file (the mapping is mechanical: `PK` becomes `equalizer`, `LSC` becomes `lowshelf`, `HSC` becomes `highshelf`, `Q` becomes `w=` with `t=q`, and `Preamp` becomes `volume=`).

### Route B: the app's ten sliders (works with the app as it is, with a caveat)

The app's bands are at 31, 62, 125, ... 16000 Hz with Q 1.41, which is AutoEq's ten-band layout to within rounding (`FixedBandEQ`). The HD 600 values (verified from the AutoEq file) are: 31 Hz +6.9, 62 +3.3, 125 -1.1, 250 -1.6, 500 +0.6, 1k -0.8, 2k +0.1, 4k -1.0, 8k +3.9, 16k -6.5 dB; AutoEq's preamp for it is -7.5 dB. **Caveat:** the app's own headroom trim for these settings is only -4.1 dB, leaving the combined response 3.3 dB over full scale before its clipper (F5, F6), so loud bass will be clipped and distorted. Lower the app's output or the source level by a further 3.4 dB to match AutoEq's -7.5 dB. The resampler flaw (F7) also dulls and wobbles the top octave in this route. It works tonight; it is not good sound.

### Route C: CamillaDSP in front of the headphones (best quality tool available today, extra moving parts, not tested)

A release download (not a Homebrew formula), macOS Apple Silicon binary, no install needed beyond unzipping. [S10] It needs audio to arrive from MPD, by either: (i) a virtual device (BlackHole 2ch, `brew install --cask blackhole-2ch`, a driver install; MPD's `osx` output pointed at it, which means changing MPD's config) or (ii) MPD's `pipe` output (`command` setting, run through the shell [S15]) feeding CamillaDSP's `Stdin` capture, which avoids a driver. [S10] Each filter is a block like this (keys from the CamillaDSP reference; device names as shown in Audio MIDI Setup):

```yaml
filters:
  preamp:   {type: Gain,   parameters: {gain: -6.3}}
  ls105:    {type: Biquad, parameters: {type: Lowshelf,  freq: 105,   gain: 6.5,  q: 0.7}}
  pk125:    {type: Biquad, parameters: {type: Peaking,   freq: 125,   gain: -2.7, q: 0.55}}
  hs10000:  {type: Biquad, parameters: {type: Highshelf, freq: 10000, gain: -3.1, q: 0.7}}
  # ... one entry per line of the AutoEq file
pipeline:
  - {type: Filter, names: [preamp, ls105, pk125, hs10000]}   # then the rest, in any order
```

A third-party converter from AutoEq text to CamillaDSP YAML exists (`autoeq2camilladsp`; seen in a search result, not opened). CamillaDSP needs microphone permission for the terminal on first launch (capture covers all recording) [S10], and stops when the capture device's rate changes. [S10]

### Route D: a system-wide macOS app

eqMac Pro (Expert EQ, unlimited bands, $40 lifetime; no AutoEq import mentioned on its pages) [S13], SoundSource (10-band EQ plus Audio Unit hosting) [S14], or the process-tap apps another lane found (ParaEQ, MacEQ; AutoEq import; macOS 14.4 or later). [S29] None tested by me.

**My ranking for "tonight, least risk, best sound":** A if it loads, then C, then D, then B. A is a few lines in the config and reversible, the plug-in is in the binary, and the math is verified; the open risks are format handling inside MPD (a possible quiet drop back to 16-bit, mitigated by the `aformat` suffix) and that I have not run it.

## 6. Questions for the owner

1. Which headphones (model, over-ear or in-ear, any pad changes)?
2. Default mode: A "same as Equalizer APO" (my recommendation) or B "analog-matched"? (4.5)
3. Is a dedicated, always-on "automatic preamp" acceptable (the volume drops by the preamp when a profile loads)? Every other tool does this; the app does not. (4.7)
4. Should the server refuse Equalizer APO config forms I could not confirm (`LS`/`HS` without Q, slope forms) until there is a sample file from a real Equalizer APO setup? (4.12)
5. IIR first and FIR later, as written? Or is a linear-phase option wanted in the first release? (4.10)

## 7. Register of UNCONFIRMED items

- Equalizer APO internals: filter formulas, internal sample format, config reload mechanism, exact meaning of `LS`/`HS`/`LSC`/`HSC` forms, default Q of shelves, behaviour of the `Stage` command (the SourceForge code page refused fetches; the wiki summaries were incomplete).
- How MPD's `ffmpeg` filter behaves at run time on this machine (the plug-in is present in the binary; I did not run MPD): the sample format MPD feeds the chain and takes back, a possible silent conversion of the 64-bit result back to 16-bit without dither, and where the chain sits relative to MPD's software volume and ReplayGain.
- Equalizer APO and PipeWire using the cookbook formulas (assumed, not read).
- Algebraic stability of the two cookbook shelves (checked numerically for two filters only).
- Whether CoreAudio clamps or wraps float samples above full scale at the device edge.
- Whether recomputing coefficients every 16 to 32 samples (rather than every sample) matches the per-sample click figures. Low risk; measure when built.
- AutoEq FIR WAV sample format (the code says 4,410 samples; the file size roughly agrees for 32-bit samples).
- Lipshitz/Wannamaker/Vanderkooy survey and Gardner's paper: citations come from search results; I did not open the papers. Orfanidis (1997) and Massberg (2011) are cited through Vicanek's reference list.
- Apple's N-band EQ audio unit specifications (the Apple page returned only a title; the only fact used is AutoEq's source comment about its 5-octave maximum bandwidth).
- Third-party macOS apps (ParaEQ, MacEQ), `autoeq2camilladsp`: not opened by me.
- The CamillaDSP YAML and the MPD filter block have not been run in their target programs.

## 8. Appendix: measured numbers (so nothing depends on the scratch files)

Scratch scripts, all in `/tmp/msr-eq-dsp/work/`: `biq.py` (designs and response), `exp1_validate.py`, `exp2_cramp.py`, `exp_click.c` with `exp_click_analyze.py` and `exp_click_small.py`, `exp_prec.c`, `exp_cubic.py`, `exp_dither2.py`, `exp_ffmpeg.py`, `bench.c`. Downloaded sources are under `/tmp/msr-eq-dsp/dl*`. Python used NumPy 2.5.3 in isolated mode; C built with `clang -O2 -ffp-contract=off`.

**A1. Validation against AutoEq.** HD 600 parametric preset, cookbook cascade at 44.1, 48 and 96 kHz: maximum +6.263 dB at 20 Hz in all three; AutoEq's stated preamp -6.3 dB equals minus that value to one decimal. The cascade at DC is +6.500 dB. Stability triangle: 0 violations in 20 filter designs.

**A2. Matched bell versus cookbook versus analog (max deviation over 20 Hz to 20 kHz).**

| fs | f0 | Q | Cookbook | Matched (Vicanek) |
|---|---|---|---|---|
| 44.1k | 10 kHz | 1.41 | 1.568 dB | 0.344 |
| 44.1k | 10 kHz | 0.70 | 2.654 | 0.588 |
| 44.1k | 16 kHz | 1.41 | 3.875 | 0.441 |
| 44.1k | 16 kHz | 0.70 | 4.147 | 0.284 |
| 48k | 10 kHz | 1.41 | 1.327 | 0.210 |
| 48k | 16 kHz | 1.41 | 3.298 | 0.231 |
| 96k | 10 kHz | 1.41 | 0.335 | 0.008 |
| 96k | 16 kHz | 1.41 | 0.648 | 0.005 |

Gain at Nyquist for the 10 kHz, Q 1.41 case at 44.1 kHz: cookbook exactly 0 dB, analog +0.886 dB, matched +1.406 dB at its last grid point. (Matched bells at 1 kHz: 0.003 dB error against 0.016 for the cookbook.)

**A3. Cookbook error against analog by rate, +6 dB bell.** 10 kHz Q 5: 44.1k 1.146, 48k 0.960, 88.2k 0.276, 96k 0.232, 176.4k 0.068, 192k 0.058 dB.

**A4. HD 600 cascade versus 44.1 kHz.** 48k: 0.141 dB max (12.5 kHz); 88.2k: 0.672 (13.0 kHz); 96k: 0.707 (13.0 kHz); 192k: 0.846 (13.2 kHz). Matched bells (shelves cookbook) at 44.1k versus cookbook: 0.615 dB (11.7 kHz).

**A5. Coefficient rounding to 32-bit, 31 Hz bell +12 dB Q 1.41, max response error 10 to 200 Hz.** 44.1k: 0.001 dB; 96k: 0.111 dB; 192k: 0.197 dB.

**A6. Headroom.** HD 600 parametric: `||h||_1` 2.864 (+9.14 dB); response maximum +6.50 dB; sum of positive gains 13.6 dB. HD 600 FixedBandEQ: stated preamp -7.5 dB; true maximum +7.471 dB at 31.4 Hz; `||h||_1` 3.672 (+11.30 dB); the app's rule gives -4.14 dB so 3.33 dB remain over full scale; soft-clip knee -3.1 dBFS reached at -6.43 dBFS input.

**A7. Clicks, full table (peak of the >3 kHz part, worst of 8 phases, dBFS; gain steps 0 to +12 / +12 to 0 / 0 to -12 dB).**

| Method | 0 to +12 | +12 to 0 | 0 to -12 |
|---|---|---|---|
| hard swap, TDF-II | -42.1 | -34.5 | -42.0 |
| hard swap, DF1 | -70.8 | -64.6 | -70.5 |
| coefficient ramp 5 ms, TDF-II | -83.2 | -80.6 | -86.8 |
| coefficient ramp 20 ms, TDF-II | -92.3 | -92.7 | -99.4 |
| coefficient ramp 50 ms, TDF-II | -97.4 | -100.6 | -108.4 |
| coefficient ramp 20 ms, DF1 | -104.3 | -117.1 | -114.2 |
| re-design each sample, 20 ms, TDF-II | -92.5 | -93.3 | -100.0 |
| linear cross-fade 20 ms | -58.1 | -58.1 | -70.1 |
| raised-cosine cross-fade 5 / 20 / 50 ms | -79.7 / -102.8 / -104.3 | -79.5 / -103.7 / -118.9 | -91.7 / -114.8 / -116.3 |

Small steps (0 to +1 dB / 0 to +0.25 / +6 to +7): hard TDF-II -64.3 / -76.3 / -60.6; hard DF1 -93.0 / -105.0 / -90.0; ramp 20 ms TDF-II -119.0 / -131.4 / -109.5; raised-cosine cross-fade 20 ms -130.6 / -143.0 / -112.0.

**A8. Resampler (re-implementation of `audio.rs` `cubic()`).** Tone gain at 44.1 to 48 kHz: 1 kHz 0.000, 5 kHz -0.027, 10 kHz -0.381, 15 kHz -1.652, 18 kHz -3.105, 20 kHz -4.436 dB. Non-tone residual re tone: -89.5, -46.5, -26.4, -13.8, -7.6, -3.8 dB. Static fractional offset 0.50: 10 kHz -0.74, 15 kHz -3.53, 18 kHz -7.63 dB; at offset 0.25 15 kHz is -1.55 dB.

**A9. ffmpeg versus cookbook.** `equalizer` at 1 kHz Q 1.41 +6, at 8445 Hz Q 1.61 +3.3, at 16 kHz Q 1.41 +6; `lowshelf` 105 Hz Q 0.7 +6.5; `highshelf` 10 kHz Q 0.7 -3.1 (all `t=q`, `precision=f64`, `transform=tdii`, 44.1 kHz, impulse response, 300 log-spaced frequencies): maximum difference 0.00000 dB each. Full HD 600 chain with `volume=-6.3dB`: 1.2e-11 dB.

**A10. Matched-bell robustness.** 1,620 cases (rates 44.1, 48, 96 kHz; f0 in {20, 100, 1000, 5000, 10000, 16000, 20000, 0.45 Fs, 0.49 Fs} below Nyquist; gain {-20, -12, -6, -1, -0.1, 0.1, 1, 6, 12, 20} dB; Q {0.18, 0.5, 1, 2, 5, 10}): zero cases non-finite, unstable, off target at `f0` by more than 1e-3 dB, or off 0 dB at DC by more than 1e-3 dB.

**A11. Quantisation and clipping.** Tables in 4.8 and F6.

**A12. CPU and ringing.** 1.95 ns per biquad-sample (32 sections, f64 TDF-II, one core, Apple M3 Max); 2.4% of a core for 32 sections x 2 channels x 192 kHz. HD 600 parametric: max group delay 1.48 ms (20 Hz), tail below 1e-6 after 1,005 samples; ten-band: 11.32 ms (30 Hz), 7,358 samples.

## Sources

- [S1] R. Bristow-Johnson, "Audio EQ Cookbook", W3C Working Group Note, 8 June 2021 (editor R. Toy): https://www.w3.org/TR/audio-eq-cookbook/ (read in full; all formulas in 4.3)
- [S2] M. Vicanek, "Matched Second Order Digital Filters", 14 Feb 2016: https://vicanek.de/articles/BiquadFits.pdf (read in full; text extracted with pdftotext)
- [S3] M. Vicanek, "Matched One-Pole Digital Shelving Filters", 2019: https://vicanek.de/articles/ShelvingFits.pdf
- [S4] Equalizer APO, Configuration reference: https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/ (read through a page summariser; syntax lines as returned)
- [S5] Equalizer APO project pages: https://sourceforge.net/projects/equalizerapo/ and https://equalizerapo.com/
- [S6] Equalizer APO documentation: https://sourceforge.net/p/equalizerapo/wiki/Documentation/
- [S7] Microsoft, "Audio Processing Object Architecture": https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/audio-processing-object-architecture
- [S8] Peace, Equalizer APO GUI: https://sourceforge.net/projects/peace-equalizer-apo-extension/
- [S9] AutoEq: https://github.com/jaakkopasanen/AutoEq ; source read: https://github.com/jaakkopasanen/AutoEq/blob/master/autoeq/constants.py , `peq.py` and `frequency_response.py` in the same folder, `peq.yaml`; HD 600 files: https://github.com/jaakkopasanen/AutoEq/tree/master/results/oratory1990/over-ear/Sennheiser%20HD%20600 ; targets: https://github.com/jaakkopasanen/AutoEq/tree/master/targets
- [S10] CamillaDSP v4.1.3: https://github.com/HEnquist/camilladsp (README.md, backend_coreaudio.md, `src/filters/biquad.rs`, `Cargo.toml`, `src/lib.rs`; release metadata via the GitHub API)
- [S11] PipeWire filter-chain module: https://docs.pipewire.org/page_module_filter_chain.html
- [S12] EasyEffects: https://github.com/wwmm/easyeffects
- [S13] eqMac: https://github.com/bitgapp/eqMac and https://eqmac.app/
- [S14] SoundSource: https://rogueamoeba.com/soundsource/
- [S15] MPD user manual: https://mpd.readthedocs.io/en/latest/user.html ; plug-in reference: https://mpd.readthedocs.io/en/latest/plugins.html
- [S16] MPD source: https://github.com/MusicPlayerDaemon/MPD/blob/master/src/filter/plugins/FfmpegFilterPlugin.cxx , https://github.com/MusicPlayerDaemon/MPD/blob/master/src/pcm/Dither.cxx and https://github.com/MusicPlayerDaemon/MPD/blob/master/src/CommandLine.cxx (the `--version` text); binary check: `strings` and `nm -u` on `/opt/homebrew/bin/mpd` (file inspection only)
- [S17] A. Wishnick, "Time-Varying Filters for Musical Applications", DAFx-14, Erlangen 2014: https://dafx.de/paper-archive/2014/dafx14_aaron_wishnick_time_varying_filters_for_.pdf (read; details page https://dafx.de/paper-archive/details/yfd4LbdXr2Cywsqxfby8ug)
- [S18] N. Redmon, "Biquad C++ source code": https://www.earlevel.com/main/2012/11/26/biquad-c-source-code/
- [S19] J. O. Smith, "Numerical Robustness of TDF-II": https://ccrma.stanford.edu/~jos/fp/Numerical_Robustness_TDF_II.html
- [S20] ITU-R BS.1770-5 (11/2023), Annex 2 (true-peak): https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1770-5-202311-I!!PDF-E.pdf (downloaded and read)
- [S21] W. G. Gardner, "Efficient Convolution without Input-Output Delay", JAES 43(3), 127-136, 1995: https://aes2.org/publications/elibrary-page/?id=7957 (citation from a search result; page not opened)
- [S22] Lipshitz, Wannamaker, Vanderkooy, "Quantization and Dither: A Theoretical Survey", JAES 40, 355-375, 1992: https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/reading/Lipshitz_1992.pdf (link from a search result; not opened)
- [S23] libsoxr README: https://github.com/chirlu/soxr/blob/master/README ; https://soxr.sourceforge.net
- [S24] Flocq: https://flocq.gitlabpages.inria.fr/ ; Gappa: https://gappa.gitlabpages.inria.fr/ ; J. Feret, "Static Analysis of Digital Filters", ESOP 2004: https://www.di.ens.fr/~feret/publications/esop2004.pdf (abstract only, via search result)
- [S25] BlackHole: https://existential.audio/blackhole/ ; Homebrew cask: https://github.com/Homebrew/homebrew-cask/blob/HEAD/Casks/b/blackhole-2ch.rb (via `brew info --cask blackhole-2ch`, read-only)
- [S26] ffmpeg filter options: local `ffmpeg -hide_banner -h filter=equalizer` (ffmpeg 9.0.2, libavfilter 12.1.102) and `ffmpeg -filters`; project docs https://ffmpeg.org/ffmpeg-filters.html (page too long for the summariser; not used as a source)
- [S27] S. J. Orfanidis, "Digital Parametric Equalizer Design with Prescribed Nyquist-Frequency Gain", JAES 45(6), 444-455, 1997; M. Massberg, "Digital Low-Pass Filter Design with Analog-Matched Magnitude Response", AES Convention 131, 2011: both cited as given in [S2]'s reference list, not opened: http://www.ece.rutgers.edu/~orfanidi/ece348/peq.pdf and http://www.aes.org/e-lib/browse.cfm?elib=16077
- [S28] Local, read-only: `/Users/golem/git/window_headMPD/src-tauri/src/{eq,audio,outputs}.rs`; `/opt/homebrew/etc/mpd.conf`; `mpc outputs`, `mpc status`; `mpd --version`; `otool -L /opt/homebrew/bin/mpd`; `system_profiler SPAudioDataType`; `/Users/golem/git/window_headMPD-engine/docs/design/ENGINE.md` (`DspPort`, line 1593)
- [S29] Peer lane notes in this folder: `winamp-better.md` (section 6, macOS process-tap apps), `architecture.md` (sections 4, 7, 10)
