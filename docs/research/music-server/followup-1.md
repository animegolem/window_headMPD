# Follow-up 1: where the EQ sits in MPD's chain, and what format it hands over

Date: 2026-10-07. Scope: settle the disagreement between the mpd-audit, headphones-today and eq-dsp lanes about MPD's filter chain and format handoff. Read-only: MPD and the app were not started, stopped or reconfigured. Sources: MPD source at tag v0.24.15 (the installed Homebrew build is 0.24.15_1), FFmpeg source at tag n9.0.2 (the FFmpeg the installed MPD links), and the installed MPD binary.

## 1. Answer

1. **The EQ graph runs before the 44100:16:2 pin, at the track's own sample rate.** Order inside each output, from the source: ReplayGain, then normalize (off here), then your ffmpeg graph, then the software volume (only if `mixer_type "software"`), then MPD's convert step last. The convert step does the sample-rate change, the bit-depth change and the channel mapping, in that order. The Headspace `format "44100:16:2"` is applied after the graph. The critic's reading is right.
2. **One correction to the critic's order:** ReplayGain is first, not after the user filters. It is opened ahead of the chain in `output/Source.cxx`. With the default `replaygain_limit` it will not clip by itself.
3. **The graph's format handoff is settled:** MPD appends `aformat=flt|s32|s16` itself and takes whatever comes out. For the headphones-today block and the eq-dsp block that is 32-bit float, for 16-bit, 24-bit and float sources, at 44.1 and 96 kHz, mono and stereo. MPD's one-sample probe succeeded for every graph, so its fallback ("force output format = input format") never triggers.
4. **There is no dither anywhere on the EQ'd path.** MPD dithers only integer-to-16-bit (24 or 32-bit in, 16-bit out). Float to 16-bit, which is what any EQ graph hands over, is plain rounding. FFmpeg's default converter does not dither either, and I measured that MPD's kernel (replicated from its source) and FFmpeg give bit-identical 16-bit output. So the mpd-audit "s16 tail" does not lose dither: neither side has any.
5. **Which lane was wrong:** mpd-audit was wrong (diagram, tail block, two UNCONFIRMED items). headphones-today was right except one line about ReplayGain order. eq-dsp's printed block is safe as printed; its worry about a silent drop to 16-bit does not apply to that block but is real for graphs without precision flags. hidden-problems over-claims dither. Details in section 5.

## 2. The chain, per output on this machine

| Stage (in order) | OS X Output (mixer hardware, no format) | Headspace (mixer software, format 44100:16:2) |
|---|---|---|
| ReplayGain filter (exists even with replay gain off) | pass-through, stays 16-bit | lifts 16-bit to a 24-bit-in-32 container, even with replay gain off |
| Your ffmpeg graph | receives s16, s32 or float as the track is | receives s32 or float (16-bit tracks arrive as the 24-bit container, converted losslessly) |
| Graph output (with the headphones-today block) | float, track's rate | float, track's rate |
| Software volume | none | float multiply (pass-through at 100%) |
| Convert (last) | nothing to do: no format set, so the device gets float at the track's rate | resample to 44.1 kHz if needed, then float to 16-bit (rounded, no dither), then channels |
| Output plugin | CoreAudio takes float as-is | writes 16-bit to the FIFO |

The same `filter` block can be named on both outputs. MPD builds a separate copy of it per output, so they share no state.

## 3. Evidence

**Verified in source** (all v0.24.15; I diffed the v0.24 release: it differs only in flush bookkeeping, assertions, a cross-fade format fix and a DSD condition, so the chain order, the pin handling and the conversion code are the same across 0.24.x). Line numbers are for v0.24.15.

| Claim | Where |
|---|---|
| Normalize and your filters are chained first; software volume is chained after them; convert is chained last ("the convert filter must be the last one") | `src/output/Init.cxx` 126-128, 161-170, 244-248 |
| ReplayGain filters are opened first, and their output format feeds the main chain | `src/output/Source.cxx` 86-104 |
| The pin is applied to the chain's output format: `cf = in_audio_format.WithMask(config_audio_format)` where the input is what `source.Open` returned | `src/output/Thread.cxx` 38, 130-142; mask rule in `src/pcm/AudioFormat.cxx` 12-27 |
| Convert filter opens as a no-op, then is set to convert to the device format | `src/filter/plugins/ConvertFilterPlugin.cxx` 50-86; `src/output/Filtered.cxx` 66-114 |
| Convert = resample, then bit depth, then channels | `src/pcm/Convert.cxx` 38-72 |
| Both resamplers output float | `src/pcm/SoxrResampler.cxx` 226; `src/pcm/LibsamplerateResampler.cxx` 75 |
| Dither only for 24-bit and 32-bit integer input; float goes through `FloatToInteger` with no dither | `src/pcm/PcmFormat.cxx` 145-175, 35-59; `src/pcm/Neon.hxx` 53-72; `src/pcm/FormatConverter.cxx` 57-60 |
| Software mixer turns S16 into S24 in the ReplayGain stage | `src/pcm/Volume.cxx` 148-155; `src/output/Init.cxx` 205 |
| MPD's `S24_P32` (24-bit) is handed to ffmpeg as `s32`, with an automatic converter inserted in front | `src/lib/ffmpeg/Filter.cxx` 52-65; `src/filter/plugins/AutoConvertFilterPlugin.cxx` 28-50 |
| The ffmpeg plugin appends `aformat=flt|s32|s16`, probes with one silent sample, and only if that probe returns nothing forces output = input format | `src/lib/ffmpeg/Filter.cxx` 114-120; `src/filter/plugins/FfmpegFilterPlugin.cxx` 57-95; `src/lib/ffmpeg/DetectFilterFormat.cxx` 19-73 |
| MPD has no 64-bit float format (S8, S16, S24_P32, S32, FLOAT, DSD) | `src/pcm/SampleFormat.hxx` 17-41 |
| The osx plugin passes the format through and has a float path | `src/output/plugins/OSXOutputPlugin.cxx` 665-700 (float test at 673) |
| Each output gets its own filter instance | `src/filter/Factory.cxx` (MakeFilter creates a new one per call), `src/filter/LoadChain.cxx` |
| FFmpeg `equalizer` default precision is `auto`, which accepts s16p, s32p, fltp and dblp, so it keeps the source's depth if nothing forces otherwise | `libavfilter/af_biquads.c` 163-195, 1533-1534 |
| `r=` and `precision=` are the same option | `af_biquads.c` 1511-1513 |
| Band above Nyquist is bypassed with a warning, no error | `af_biquads.c` 808-811 |
| swresample `dither_method` default is 0 (none); float to s16 is `lrintf` (round to nearest) | `libswresample/options.c` 72; `libswresample/audioconvert.c` 79; docs: https://ffmpeg.org/ffmpeg-resampler.html |

The MPD manual says nothing about the order (https://mpd.readthedocs.io/en/latest/user.html: only "filters are instantiated in the given order"). The source is the only authority.

URLs: https://github.com/MusicPlayerDaemon/MPD/tree/v0.24.15/src (files above), https://github.com/FFmpeg/FFmpeg/tree/n9.0.2/libavfilter and /libswresample.

**Measured by me** (scratch in `/tmp/msr-followup-1/`; harness `harness/mpdgraph.c`):

- **Installed MPD binary contains the float-to-16 kernel and it has no dither.** Disassembly of `/opt/homebrew/opt/mpd/bin/mpd` shows the symbol `GlueOptimizedConvert<NeonFloatTo16, PortableFloatToInteger<S16>>::Convert`: four `fcvtzs #30`, four `sqrshrn #15` (saturating rounding narrow), no random-number code. The leftover samples (fewer than 16) go through a truncating path.
- **Graph negotiation, using the same libavfilter 12 (FFmpeg 9.0.2) that MPD links.** The harness repeats MPD's calls: abuffer, your graph, `aformat=flt|s32|s16`, abuffersink, then the one-sample probe. It is not MPD itself.

| Graph | s16 source | s32 source | float source | Biquads run in |
|---|---|---|---|---|
| headphones-today block (HD 650 example) | flt | flt | flt | 64-bit float |
| headphones-today block, preamp removed | flt | flt | flt | 64-bit float |
| eq-dsp block (HD 600 example) | flt | flt | flt | 64-bit float |
| eq-dsp block, preamp removed | flt | flt | flt | 64-bit float |
| mpd-audit option A as printed (no tail) | flt | flt | flt | 32-bit float |
| mpd-audit with `aformat=s16` tail | **s16** | **s16** | **s16** | 32-bit float, then cut to 16-bit |
| bare `equalizer=f=1000:t=q:w=1:g=3`, no flags | **s16** | **s32** | flt | **same as the source: 16-bit integer for a CD track** |

Repeated at 96 kHz for the headphones-today, eq-dsp and s16-tail graphs (s16 and s32 sources): same results. Mono 44.1 kHz s16 for the same three: same, except the s16-tail graph turns mono into stereo. The one-sample probe succeeded in every case (no fallback).

- **Float to 16-bit, three ways** (4 s of a 1 kHz tone, 44.1 kHz): MPD's kernel replicated from its source, FFmpeg's default `aformat=s16`, and FFmpeg with `aresample=dither_method=triangular` first.

| Test tone | MPD kernel | FFmpeg default | FFmpeg with triangular dither |
|---|---|---|---|
| -60 dBFS, strongest distortion line | -51.7 dB below the tone (about -112 dBFS) | identical, all 176,400 samples match | -70.9 dB |
| -100 dBFS (a third of one 16-bit step) | all zeros, tone is gone | identical | tone survives |

- **Library, from the MPD database** (18,403 songs with a Format line), by what happens on the Headspace path today with no EQ: 15,697 are 44.1/16/2 and pass untouched; 15 mono 44.1/16 only get channels copied; 1,179 (44.1 kHz at 24 or 32-bit) are dithered by MPD; 1,512 are rounded without dither (208 are float; the other 1,304 are at another rate and go through a float resampler, 41 of them 16-bit and 1,263 deeper than that). That is my arithmetic from the census and the source. With any EQ graph on, all of them become plain rounding.
- **Bands above Nyquist, HD 650 example graph:** 8 kHz tracks lose 3 bands (the 5332, 8800 and 10000 Hz ones), 16 kHz tracks lose 2 (8800 and 10000), 22.05 and 24 kHz tracks lose none. The library has 2 tracks at 8 kHz, 1 at 16 kHz, 1 at 22.05, 1 at 24, so 3 tracks (0.02%) lose any bands. Which bands depends on your own profile.

## 4. What this means for the owner (RECOMMENDATIONS)

- **Use one graph: the headphones-today block** (section 4 of `headphones-today.md`: `aformat=sample_fmts=dblp` head, `volume=...:precision=double`, every band with `r=f64`, `aformat=sample_fmts=flt` tail), on both outputs, with your own headphones' numbers. Retire the other two printed graphs as examples. The eq-dsp block is also safe, but it is a different headphone (HD 600) with the same shape, and no reason to give the owner two.
- **Keep the dblp head and the flt tail** even though the per-band `r=f64` already forces 64-bit. They cost nothing and keep the outcome the same for a profile with no Preamp line or one band without flags.
- **Do not add an `aformat=s16` tail** (the mpd-audit second block). It buys nothing: MPD already makes the 16-bit for the FIFO. It makes the 16-bit step happen at the track's native rate, then, for a resampled track, MPD rounds to 16-bit a second time after its own resampler. Two independent roundings add their noise power, about +3 dB (arithmetic, not measured). Inaudible, but pointless.
- **Accept plain rounding on the Headspace path.** The rounding error is about -101 dBFS rms; the only plausible audible case is a very quiet fade. On OS X Output the float goes straight to CoreAudio. Real dither belongs in the replacement server, last in the chain, as eq-dsp section 4.8 already says. If you ever want dither today, it needs its own graph for Headspace only (`...,aresample=dither_method=triangular,aformat=sample_fmts=s16`), which breaks the one-graph rule. I measured those two filters with the FFmpeg command-line tool, not inside MPD.
- **ReplayGain does not work the way headphones-today says.** It runs before the EQ, not after, and with the default `replaygain_limit` it will not clip by itself (comment in `ReplayGainFilterPlugin.cxx` 41-51). Whether a boosted loud track still stays under 0 dBFS after the EQ is UNCONFIRMED: the -0.65 dBFS peak measurement was without ReplayGain. It is off in the current config, so this is not urgent.

## 5. Lane documents corrected or extended (not edited here)

| Document | Where | Verdict |
|---|---|---|
| `mpd-audit.md` | 1.1 diagram, lines 46-47, and line 180 | **Wrong** (labelled untraced). Real order: ReplayGain, normalize, ffmpeg filters, software volume, convert last. |
| `mpd-audit.md` | 5.1 second block with the `aformat=s16` tail and the third caveat | **Wrong / moot.** Not needed; see section 4. |
| `mpd-audit.md` | UNCONFIRMED #3 (dither) and #16 (float misread by the app) | **Resolved.** #3: no dither for float. #16: moot, MPD's convert filter always conforms the output to the pinned 16-bit. |
| `mpd-audit.md` | line 23, P1 (line 191), table line 335 | **Still true for the app's own 10-band EQ** (it sits after the FIFO). **Does not apply to an MPD-side EQ**, which runs at native rate and depth. Extend with that sentence. |
| `landscape.md` | line 48 | Same: true for the app's EQ, not for an MPD-side EQ. |
| `headphones-today.md` | line 139 | **One error:** ReplayGain is first, not after the EQ. Everything else on the chain matches the source. |
| `headphones-today.md` | lines 257 and 140 | 257 is **answered** (no dither). 140 is right. |
| `headphones-today.md` | paste-ready block, section 4 | **Confirmed**, and is the one graph to keep. |
| `eq-dsp.md` | section 5 Route A, lines 479, 506, 519 | **Resolved.** The block negotiates float as printed. "Probably converted back to the source's format (16-bit)" is wrong for this block; the fallback only triggers if the one-sample probe returns nothing, which did not happen. The `aformat` suffix is optional. The silent-drop worry is real only for graphs like the bare `equalizer` row above. |
| `hidden-problems.md` | A4, line 150 ("MPD does dither that step") | **Over-claims.** True only for 24/32-bit integer at the same rate (1,179 tracks). Float input and anything resampled is rounded without dither. |

Errors in the critic's own message: (a) ReplayGain order, above; (b) "FormatConverter converts to 16-bit with PcmDither" holds only for integer input; (c) the convert step also resamples and maps channels, and resampling comes first.

## 6. What I could not confirm

- Nothing was run inside MPD. The harness uses the same FFmpeg libraries but not MPD's code. The running daemon has been up 12 h 26 min; its exact release was not confirmed (database last written by 0.24.14), but the files that decide this are identical or plumbing-only across v0.24 and v0.24.15.
- What CoreAudio does when converting MPD's float to the headphone jack's own format. UNCONFIRMED. Worth knowing because OS X Output is the path with no MPD-side 16-bit step.
- The inaudibility claims (the dither cost, band loss on 3 tracks) are from levels and arithmetic, not a listening test.
- Whether the per-track reopen of the graph at a rate change resets filter state audibly. Not tested.
