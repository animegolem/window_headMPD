# Follow-up 5: one language decision, one sequence

Date: 2026-10-07
Resolves the critic's item "Build-versus-reuse and language: landscape and architecture recommend different stacks; cpal's macOS capability untested."
Corrects or extends: architecture (5.1, 5.4, 15, 17), landscape (1.14, 3.1, 5), hidden-problems (A4, section 3), formal-verification (7, 10). Details in section 6.
Scratch: `/tmp/msr-followup5/`. Nothing else was written. MPD and the app were never touched; only read-only CoreAudio property reads were run.

Tags: **Measured** = I ran it or read the file today. **Source** = a cited document says it. **Recommendation** = my judgment.

## 1. The answer

1. **Ruling (Recommendation).** C11 for everything inside the device callback and the public header: kernel, CoreAudio backend, decoders, player, C ABI. Rust is allowed above the API line (MPD shim, native protocol, library workers) and as a decoder plug-in behind the decoder interface if a trigger in section 3 fires. cpal and Symphonia are not in the core.
2. **The deciding fact is now settled, and it is 1 of 3.** cpal on macOS can set the device rate. It cannot hog the device. It exposes nothing for audio workgroups. The two it lacks are the two architecture 5.1 needs. (Section 2.)
3. **That fact does not push toward Rust either.** The one C reuse library, miniaudio, also has no hog mode on macOS. So the backend is first-party code in every route, and the reuse saving on the backend is gone. (Section 2.)
4. **Landscape has no numbered slice.** Its capability 1 (native path with a DSP slot) and 2 (EQ as plain data) are the same thing as architecture slice 0, eq-dsp section 4, and formal-verification Phase 0. The EQ-now answer is a different thing (no code). One sequence covers all of it. (Section 5.)
5. **A lane was wrong.** hidden-problems says the app "would ask for 48 kHz and flip the hardware to it." On macOS the source does not do that. Architecture's "rate switch not exposed" was also wrong. No lane's overall recommendation flips. (Section 6.)

## 2. What was tested, and what it shows

**How I settled it.** I read cpal 0.18.2 (the exact version in the app's `Cargo.lock`) from the local cargo registry, checked upstream's open issues, and ran a read-only C probe (`/tmp/msr-followup5/probe.c`). I did **not** run a cpal stream. A real test would change the owner's headphone-jack rate or take hog mode on a live device while MPD may be playing, which the hard rules forbid.

| Capability on macOS | cpal 0.18.2 | miniaudio 0.11.25 (C) | Apple's own C headers |
|---|---|---|---|
| Set device rate | **Yes**, implicitly. `build_output_stream_raw` calls `set_physical_format`, then falls back to `set_sample_rate`, which writes `kAudioDevicePropertyNominalSampleRate` and waits for a listener (`device.rs:88-200`, called at `:848`; the input path at `:724`). Any config rate that differs from the device's changes the whole system's rate. No opt-in. | Yes, but off unless `coreaudio.allowNominalSampleRateChange` is set (`miniaudio.h:35925-35950`, `:7165`) | Yes |
| Hog mode | **No.** Zero hits for "hog" in `src/host/coreaudio/`. Upstream issue #106 "Support Exclusive Mode" open since 2016-03-02. The v0.19 goals list (#1220) has "Exclusive mode on CoreAudio, PipeWire & WASAPI" unchecked. PR #1368 (opened 2026-09-13) is WASAPI only; its author says "I'll follow-up with another PR for CoreAudio 'hog mode'". | **No.** "No exclusive mode with the Core Audio backend for now." (`miniaudio.h:36272`) | Yes: `kAudioDevicePropertyHogMode` (`AudioHardware.h:1018`) |
| Workgroup | **No.** Zero hits for "workgroup" in cpal's source and in its issue tracker. | None found | Yes: `kAudioDevicePropertyIOThreadOSWorkgroup` (`AudioHardware.h:1027`), `os_workgroup_join` (`os/workgroup_object.h:178`) |
| Reach it from outside the library | No. `audio_device_id` is `pub(crate)` (`device.rs:362`). The public `Device::id()` returns the device UID string (`:431-463`), so a caller could look the device up again by UID. Untested. | n/a | n/a |

Two precision notes.
- **Workgroup nuance (Source).** Apple's WWDC20 session says the audio system's real-time threads are joined to the device workgroup automatically, and that only your own helper threads must join. So a design where the callback only pulls from a ring does not need the workgroup. The gap bites only if DSP or resampling ever moves onto a helper thread. The header's own doc string says the property is "the thread workgroup the AudioDevice's IO thread belongs to." [WWDC20 10224, via a summarising fetch; `AudioHardware.h:987-990`]
- **Rust bindings (Measured).** The bindings crate cpal itself uses, `objc2-core-audio` 0.3.2, defines the hog and workgroup selectors (`AudioHardware.rs:1308, 1327`). But `dispatch2` 0.3.1 deliberately skips workgroup functions (`translation-config.toml:17-18`, "Needs os_workgroup_t"), and I found no crate in the local registry that binds `os_workgroup_join`. A Rust shell would hand-declare that foreign call. Apple also marks `kAudioOutputUnitProperty_OSWorkgroup` as unavailable to Swift ("Swift is not supported for use with audio realtime threads", `AudioUnitProperties.h:2531-2533`); it says nothing about Rust.

**Measured on this Mac (read-only probe, nothing set).** All four outputs show hog owner -1 (nobody holds them) and have the workgroup property.

| Output | Rates it offers (Hz) | Current rate |
|---|---|---|
| External Headphones (built-in jack, default output) | 44100, 48000, 88200, 96000 | 44100 |
| MacBook Pro Speakers | 44100, 48000, 88200, 96000 | 44100 |
| DELL S2725QC (DisplayPort) | 32000, 44100, 48000 | 48000 |
| Microsoft Teams Audio (virtual) | 48000 | 48000 |

So the jack cannot take 176.4 or 192 kHz files without resampling. That closes architecture risk 3 for the jack (it listed the rates as UNCONFIRMED). Click or pause behaviour on a rate switch is still untested.

## 3. Decision and cost comparison

**Why C inside the API line, in order of weight (Recommendation).**
1. The owner's deliverable is a C API. Symphonia lists "Providing a C API for integration into other languages" as a *planned* feature, so even the Rust building blocks are not C-callable today.
2. Orgiac compiles to C (`ENGINE.md:2237`). Every C module can be swapped for generated C behind its interface. A Rust engine has to be re-expressed whole. I found no Orgiac spec for its C dialect or ABI in the files I could read. UNCONFIRMED.
3. The backend must be first-party anyway (section 2), so cpal saves stream plumbing only.
4. Symphonia does not remove the need for C. It has no Opus and no AAC-LC gapless, so those formats need libopus or AudioToolbox regardless.

**The strongest case for Rust (kept honest).** Memory safety when parsing hostile files in an always-on daemon (Symphonia is "100% safe Rust"). cpal gives WASAPI, ALSA, PipeWire and JACK on day one. The owner already has about 53,000 lines of Rust (nowplayd 28,145; RMPC-Auto-Theme 25,369), plus the `mpd_protocol` crate. Counterweights: those are clients and keep working over the socket in every route; the audio code worth carrying is small (`eq.rs` 167 lines as reference math; `audio.rs` 434 lines is what architecture 4.5 says not to carry); and the owner's repos contain no first-party C today (the only C found is vendored Bend), which is a real cost of my ruling.

| | **A. C inside the API line** (ruling) | **B. C kernel + Rust shell and Symphonia** | **C. Pure Rust: Symphonia + cpal + rubato + rtrb** |
|---|---|---|---|
| macOS backend | Write it: about 500 to 850 lines of C. MPD's equivalent file is 837 lines (architecture 5.1). Rate, hog, workgroup all reachable from Apple's C headers. | Same C backend (kernel stays C) | cpal covers rate only. Hog needs upstream (open 10 years) or out-of-band property calls. Workgroup needs hand-declared FFI. A first-party backend is still needed. |
| Decoders for this library | libFLAC or dr_flac, minimp3 (FLAC about 91%, MP3 about 8%, architecture 2.4); libvorbis, libopus, AudioToolbox for the tail | Symphonia: FLAC, MP3, Vorbis rated Excellent and gapless; Opus "-"; AAC-LC gapless "No". Needs a C wrapper we write. | Same Symphonia gaps. 63 files of the library (14 Opus, 49 M4A; about 0.3%) still need another decoder. |
| Public C ABI | Designed by hand | Generated by cbindgen, which "may randomly fail to support some particular situation" | Same |
| Panic or fault at the ABI | C faults crash the daemon | Since Rust 1.81 a panic in `extern "C"` aborts the process, closing a soundness hole but killing the daemon | Same |
| Toolchains | 1 (clang) | 2 | 1 plus header generator |
| Verification | Kernel in C. Frama-C WP's float model is "correct with respect to the IEEE specifications" but gives "very little support for proving properties with automated provers" (WP manual, Frama-C 33). VCFloat2 targets C. | Kernel is C, so same as A | Kernel in Rust: Kani rates f64 `sin`, `cos`, `pow`, `exp`, `sqrt`, `fma` "Partial: results are overapproximated"; Verus lists floating point as "Partially supported". |
| Verification tools installed here | None: `frama-c`, `opam`, `why3`, `coqc`, `rocq`, `cbmc`, `kani` all not found (Measured) | same | same |
| Orgiac on-ramp | Module-by-module swap | Rust shell is thrown away | Whole engine rewritten |
| Hostile-file safety | Fuzz plus sanitizers (architecture risk 9) | Better (Symphonia) | Better (Symphonia) |
| Windows and Linux later | Own backends or miniaudio | cpal usable only through a wrapper | cpal gives them now |
| Time to first sound | Not measured. My judgment: slowest of the three, because the backend is written first. | Middle | Fastest |

**Verification tilt is real but modest (Recommendation).** The valuable proofs (the load-time checker, the filter mathematics in Rocq) run on the control side and do not depend on the audio language. Neither language gets automatic float proofs. C wins on target tooling and on the kernel being the same code Orgiac will later emit. It is not the main reason.

**What flips the ruling.** Any one of these, then move that piece to Rust behind the same interface:
1. Windows or Linux is wanted before cutover. Use cpal as an optional non-macOS backend behind the backend interface.
2. Slice 0's acceptance (one hour without underruns; unplug and replug recovers) is still failing after the backend has been rewritten once.
3. A fuzzer finds a memory-safety bug in a C decoder that Symphonia does not have. Move that format to Symphonia as a decoder plug-in.

## 4. What this leaves open (UNCONFIRMED)

- Whether taking hog mode outside cpal, then letting cpal open a stream on the same device, works. Not tried.
- What happens to hog mode when the owning process is killed (architecture risk 4 stands).
- Whether a rate switch on the owner's jack clicks or pauses.
- Whether Symphonia 0.6.1 (2026-08-13) differs from the master README I read. The 0.6.1 release date is from crates.io; the codec table is from master.
- Library counts (14 Opus, 49 M4A, 158 Vorbis) are architecture's measurement; I did not re-count.
- Verus and WWDC statements came through a summarising fetch tool; Apple's "Adding Parallel Real-Time Threads" page returned only its title.

## 5. One sequence for the three timelines

The owner has three timelines because three lanes each wrote their own "first step". They are one chain.

| Step | What | Code needed | What it delivers | Lane first-steps that land here |
|---|---|---|---|---|
| **T0, tonight** | MPD's own `ffmpeg` filter with an AutoEq file, on both `OS X Output` and `Headspace` | None; config edit and restart | EQ on the headphones now. Math measured (agrees with AutoEq to under 0.00005 dB); never run inside a live MPD. | headphones-today route A; eq-dsp section 5 route A |
| **T1, slice 0 "Ears"** | C kernel (f64 biquads, preamp, ramps, limiter, SPSC ring) plus CoreAudio backend, plays FLAC and MP3 | Yes | Same EQ file, native-rate decode, no 16-bit truncation. A/B against T0 on the same album. First rate-policy listening test on the jack (44.1/48/88.2/96). | architecture slice 0; landscape capabilities 1 and 2; eq-dsp section 4; formal-verification Phase 0 |
| **T2, slice 1 "Daily"** | Queue, MPD-state import, gapless, tap, MPD shim Level 1 | Yes | rmpc, the app, nowplayd and mpc run against it on another port | architecture slice 1; landscape compatibility Level 1 (4.3) |
| **T3, slice 2 "Cutover"** | Side-by-side soak, then port 6600 | Small | MPD retired, config kept as rollback | architecture slice 2; landscape Level 2 |

Rules that make it one chain (Recommendation).
- T0 never waits for T1, and T1's acceptance test uses T0's measured profiles and five-rate results as golden vectors (headphones-today section 9 already says to).
- Formal-verification Phase 0 is the checker and kernel rules inside T1, not a separate project. Phase 1 proofs run beside T1 and block nothing.
- The hidden-problems fixes to today's app are patches on a path T3 deletes. Do only the two cheap ones if T1 slips: keep the stream handle instead of `std::mem::forget`, and act on `DeviceChanged`. Skip the `rubato` and `rtrb` rewrite; it rebuilds in Rust what T1 builds in C (soxr and the kernel ring).

## 6. Which lane documents this corrects or extends

| Document and section | Change |
|---|---|
| **hidden-problems A4** ("What the app asks the device for") and the **section 3** row "Sample-rate changes" | **Wrong on macOS, though the lane had marked it `[U] at runtime`.** `default_output_config` reads `kAudioDevicePropertyStreamFormat` (`device.rs:600-680`), so the app gets the device's current rate (44.1 kHz on the jack, matching the probe). The 48 kHz preference is in `try_with_standard_sample_rate`, called only from the aaudio, alsa, audioworklet and webaudio hosts. By source reading, not by running. What stays true: if a stream is ever built at a different rate, cpal switches the whole system's rate. The 44.1 to 48 kHz interpolator analysis applies only when the default output is already at 48 kHz (the DELL monitor). |
| **hidden-problems A4 and A5 fix lists** | Not wrong; scope them. `rubato`, `rtrb` and `DeviceChanged` handling are fixes for today's Rust app, not the server. |
| **architecture 5.1 and 5.4** ("rate switch ... not exposed", "hog and rate-switch exposure UNCONFIRMED") | **Half wrong.** Rate switching is exposed (section 2). Hog and workgroup are confirmed absent. The recommendation stands on the reasons in section 3. |
| **architecture 15 and 17 item 10** | Decision now made with a cost table. Item 10 can close. Item 3: jack rates measured (section 2). |
| **landscape 1.14, 3.1 item 4, 5 item 11** | UNCONFIRMED resolved: rate yes, exclusive no. |
| **landscape 3.1 item 9** ("built-in decoders can wrap Symphonia") | Extend: Symphonia has no C API, so the wrapper is ours, and it still lacks Opus. Landscape never states a language call; this note is that call. |
| **formal-verification 7 and 10** | No correction. Extend: its C weighting holds, for the reasons in the table above. |
| eq-dsp 4.1, headphones-today | No change. |

## Sources

- cpal 0.18.2 source: `/Users/golem/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cpal-0.18.2/` (version matches `~/git/window_headMPD/src-tauri/Cargo.lock`). Release date and latest version: https://crates.io/api/v1/crates/cpal (0.18.2, 2026-08-16).
- cpal upstream: https://github.com/RustAudio/cpal/issues/106 , https://github.com/RustAudio/cpal/pull/1368 , https://github.com/RustAudio/cpal/issues/1220
- miniaudio (0.11.25): https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h (saved as `/tmp/msr-followup5/miniaudio.h`)
- Symphonia README: https://raw.githubusercontent.com/pdeljanov/Symphonia/master/README.md (saved in scratch); version: https://crates.io/api/v1/crates/symphonia (0.6.1, 2026-08-13)
- Apple, Meet Audio Workgroups (WWDC20): https://developer.apple.com/videos/play/wwdc2020/10224/
- Apple SDK headers on this machine: `AudioHardware.h:987-990, 1018, 1027`; `AudioUnitProperties.h:2497-2508, 2531-2533`; `usr/include/os/workgroup_object.h:155-178` (under `/Applications/Xcode.app/.../MacOSX.sdk`)
- Frama-C 33.0 WP manual, sections 1.5 and the float roadmap: https://frama-c.com/download/frama-c-wp-manual.pdf
- Kani intrinsics: https://model-checking.github.io/kani/rust-feature-support/intrinsics.html
- Verus feature list: https://verus-lang.github.io/verus/guide/features.html
- Rust 1.81 (abort on uncaught panics in `extern "C"`): https://blog.rust-lang.org/2024/09/05/Rust-1.81.0/
- cbindgen: https://github.com/mozilla/cbindgen
- Orgiac as C-emitting long-term carrier: `docs/design/ENGINE.md:2237`
- Local measurements: `/tmp/msr-followup5/probe.c` (read-only CoreAudio properties); `wc -l` on the owner's Rust repos; tool presence by `which`.
