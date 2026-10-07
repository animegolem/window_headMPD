# Music server research: read this first

Date: 2026-10-07. Written by the synthesizer after reading all 16 documents in this folder (8 lanes, 8 follow-ups; the long source lists were skimmed). Nothing in this folder has been built. Nothing was run against your live MPD for this README.

**Rule for reading the folder:** the `followup-*.md` files override the lanes. Where a lane line is dead, section 8 says which follow-up killed it. Do not copy numbers or graphs out of a lane without checking section 8.

Tags used here (the lanes use slightly different letters; I mapped them):

| Tag | Meaning |
|---|---|
| MEASURED | Someone ran it on this Mac, or read the exact source file, and said so |
| SOURCE | A cited page or document says it; the lane file carries the URL |
| DERIVED | Worked out on paper in a lane; not run, not machine-checked |
| RECOMMENDATION | Advice. Never a fact |
| UNCONFIRMED | Nobody could check it |

Words used (one clause each, so you do not need to look anything up):

- **Preamp**: one volume cut placed before the EQ so that boosts cannot push the signal past the loudest level the format can hold.
- **Bell / shelf**: the two shapes of EQ band. A bell lifts or cuts around one frequency; a shelf lifts or cuts everything above (or below) a frequency.
- **Q**: how narrow a bell is. High Q is narrow.
- **Biquad**: the tiny digital filter (five numbers) that makes one band.
- **AutoEq**: a free project that turns a published headphone measurement into a list of bands plus a preamp, in Equalizer APO's text format.
- **Dither**: a whisper of noise added when cutting audio to 16 bits so that quiet passages do not turn into buzzing distortion. TPDF is the standard recipe for it.
- **FIFO**: a pipe between two programs. MPD writes audio into one; your app reads it.
- **Tap**: a copy of the audio taken for the visualizer.
- **Clamp**: a hard stop at the loudest level, so nothing ever exceeds it.

---

## 1. The answer, in one screen

**What MPD lacks for this project.**

- It cannot change its sound while playing. An EQ is a block in the config file and a change needs a restart. There is no runtime control at all, and the one user prototype that added it lost every change whenever the output reopened (`mpd-audit.md` 1.5).
- It has no supported way to tap the audio. The pipe your app reads is 46 ms deep, MPD empties it when it fills, and MPD's maintainer calls the visualizer use of it "an abuse of an experimental MPD feature" that may be removed (`mpd-audit.md` 1.7; `followup-6.md` 1 corrects one detail: MPD does not delete the pipe on pause).
- Its macOS output does not notice the device changing. Its log has 32 failed opens and 91 failed volume sets, consistent with that (the cause is UNCONFIRMED; `hidden-problems.md` A3, `architecture.md` 2.3).
- It has no security by default. On this Mac it is reachable from the LAN with no password and announces itself over Bonjour (`followup-6.md` 3).
- Library songs are keyed by file path. No play counts, no ratings, no auto-update on macOS, crossfade only between same-format tracks (`mpd-audit.md` section 2).
- What it does have is a working EQ door: the installed MPD contains the ffmpeg filter plug-in (`followup-6.md` 4; `followup-2.md` 2).

**What a better server is.** One process owns the sound card and its clock. It decodes each file at its own rate, runs the EQ in 64-bit float, and converts once at the very end. The EQ is a list of bands in the AutoEq file format, not ten fixed sliders. The visualizer tap lives inside the server. Every track has a stable ID. An MPD-compatible door keeps rmpc, nowplayd, mpc and the app working. No system the landscape lane surveyed has all three of a documented protocol, native-rate DSP in the playback path, and a library you can link; that is the empty cell you are describing (`landscape.md` 2.1).

**Recommendation.** Two tracks, neither waiting on the other.

1. **Tonight, no code:** MPD's own ffmpeg filter carrying your headphones' AutoEq file (section 2). The math matches AutoEq to under 0.00005 dB on four profiles at five sample rates, which is numerical evidence and not a proof (`headphones-today.md` 6; `followup-4.md` 6). It has never run inside a live MPD.
2. **Build the server in C beside MPD, on port 6601:** "Ears" (EQ plays through the headphones), then "Daily" (replaces MPD for daily use), then "Cutover" (port 6600, MPD retired) (section 4). Formal verification starts as a checker that refuses a bad profile when it loads, with proofs following beside the build (section 5).

No lane estimated build time. Treat any schedule as unknown.

---

## 2. EQ your headphones today

This is `headphones-today.md` sections 3 to 5 with three overrides from the follow-ups folded in. It is a recipe for you to run; I have not run any of it.

**Step 0. Decide which route you are on.** (`followup-2.md` 1 and 3)

- **Wired jack.** The Mac's default output is "External Headphones". An analog jack carries no model name, so only you can say what is plugged in. Continue below.
- **AirPods Pro 3.** Two pairing records for AirPods Pro 3 exist on this Mac (probably one set paired twice). AutoEq has no Pro 3 file, and Pro 3 changes its own tuning with volume, so a fixed curve is the wrong tool. Use Apple's 3-band AirPods EQ (macOS 27) and leave the MPD filter off for that output. Not yet seen on this Mac because the AirPods are not connected (UNCONFIRMED).

**Step 1. Get your headphones' file.**

- Find the exact name. Pads, impedance versions and revisions are separate AutoEq entries.
- Either use https://autoeq.app and choose the "Equalizer APO Parametric" output, or fetch `.../results/<source>/<over-ear|in-ear>/<Model>/<Model> ParametricEQ.txt` from the AutoEq GitHub repo (path pattern and HTTP 200 on four files: `headphones-today.md` 3).
- The file is a `Preamp:` line plus lines like `Filter 1: ON PK Fc 8800 Hz Gain 5.1 dB Q 1.42`. `PK` is a bell, `LSC` a low shelf, `HSC` a high shelf.
- The HD 650 graph in the lanes is only a worked example. It is not yours.

**Step 2. Turn the file into one MPD graph line.** Use exactly one graph: the `headphones-today.md` section 4 block, which `followup-1.md` 4 confirms and tells you to keep. Retire the other two printed graphs (the `eq-dsp.md` HD 600 block and the `mpd-audit.md` blocks).

| AutoEq line | Becomes |
|---|---|
| (start of graph) | `aformat=sample_fmts=dblp,` |
| `Preamp: -6.1 dB` | `volume=-6.1dB:precision=double` |
| `PK Fc 8800 Hz Gain 5.1 dB Q 1.42` | `equalizer=f=8800:t=q:w=1.42:g=5.1:r=f64` |
| `LSC Fc 105 Hz Gain 6.4 dB Q 0.70` | `lowshelf=f=105:t=q:w=0.7:g=6.4:r=f64` |
| `HSC Fc 10000 Hz Gain -2.1 dB Q 0.70` | `highshelf=f=10000:t=q:w=0.7:g=-2.1:r=f64` |
| `OFF` lines | leave out |
| (end of graph) | `,aformat=sample_fmts=flt` |

Join pieces with commas and no spaces, in file order. The 64-bit flags matter: without them the bass drifts by up to 0.48 dB at 96 kHz (MEASURED, `headphones-today.md` 6). `headphones-today.md` Appendix A has a converter script that prints the whole block, if you would rather not do it by hand. The end `aformat=...flt` hands MPD float audio, and MPD's CoreAudio output takes float as is (`followup-1.md` 2). Do not add an `aformat=s16` tail (`followup-1.md` 4).

Optional extra margin (my RECOMMENDATION, from `followup-3.md` 2): 9 of 75 real AutoEq files leave their preamp 0.05 to 0.1 dB short of the true peak. If you want to be strict, lower the file's preamp by another 0.2 dB.

**Step 3. Check the graph without touching MPD.** From a terminal, with your graph between the quotes:

`ffmpeg -hide_banner -nostdin -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo -af "<GRAPH>" -t 1 -f null -`

No output and exit code 0 means valid. This is the same libavfilter MPD links (`headphones-today.md` 5). It was also run at 8 to 96 kHz: bands above half the sample rate are skipped with a warning and the rest still apply (`followup-2.md` 5).

**Step 4. Optional but recommended: prove the filter loads in a live MPD without touching yours.** `followup-2.md` 6 prepared a throwaway MPD on port 6601 with a silent "null" output, a graph, and two test files (96 kHz and 8 kHz). Its files are in `/tmp/msr-followup-2/` (temporary; recreate from the note if gone). It needs your yes, because it starts a second MPD process. Pass means MPD starts with the filter, plays both files to the end, and the log has no "failed" lines. Every `mpc` line must carry `-p 6601`. Without it, the final `kill` stops your real MPD. It does not test device pinning.

**Step 5. Back up and quit the app.**

- `cp /opt/homebrew/etc/mpd.conf ~/mpd.conf.bak-2026-10-07`
- Quit window_headMPD first, and start it again afterwards, so it does not believe it owns playback across the restart (`headphones-today.md` 5, step 5).

**Step 6. Edit the live config, `/opt/homebrew/etc/mpd.conf`.** The copy under `~/.config/mpd` is a retired decoy; edits there do nothing (`~/.config/mpd/README-config-location.txt`). I checked the live file: its blocks are "Visualizer FIFO", "OS X Output" (`mixer_type "hardware"`) and "Headspace" (software mixer, `enabled "no"`).

- Add a `filter { plugin "ffmpeg"  name "headphone_eq"  graph "<your graph>" }` block at top level.
- Add `filters "headphone_eq"` inside **both** "OS X Output" and "Headspace". Headspace is the path used while the app runs; without the line the correction vanishes whenever the app is open (`headphones-today.md` 1, item 2).
- Add a `device` line to "OS X Output", for example `device "External Headphones"`, and keep its name. This pins the output so that a connecting pair of AirPods cannot take over the music while the wired curve is still applied. The exact device string is UNCONFIRMED: read it in Audio MIDI Setup. A wrong name makes the output fail with "Found no audio device names" rather than fall back to the speakers (`followup-2.md` 4; source-read, untested). What MPD does when the pinned device vanishes, for example when you unplug the jack, and whether `mpc disable` then `mpc enable` recovers it, are both UNCONFIRMED. Test unplug and replug once, and keep the unpinned fallback (delete the `device` line and restart) in mind. Renaming the output is optional and safe: the only mention by name in your repos is `window_headMPD/README.md:64`.
- Leave "Visualizer FIFO" without a filter. Leave the app's ten sliders flat (see section 3, item 3).
- Limit: the Headspace path cannot be pinned, because the app opens the system default output itself (`followup-2.md` 4). While the app is in output mode the EQ follows whatever the default device is.

**Step 7. Restart.** `brew services restart mpd`. Your `state_file` restores the queue. A track that was playing will resume, because `restore_paused` is off (it was paused when checked).

**Step 8. Check.** `mpc outputs` should still list three outputs. Watch `~/.cache/mpd/log`. If MPD does not start, restore the backup, restart, and recheck the graph with step 3. Undo is always the same: restore the backup and restart.

**Step 9. Listen, and level-match.** Expect it to be quieter by the preamp (about 2 to 7 dB; the HD 650 example is 6.1 dB). A louder version sounds better, so an EQ-on versus EQ-off comparison is also a loudness comparison unless you match levels (`hidden-problems.md` A2).

What this does and does not do:

- It corrects only what MPD plays. Browser, video and calls are untouched. For those on a wired jack the lanes name SoundSource (paid) as the easiest route; if you buy it, remove the MPD filter that day or you will correct twice (`followup-2.md` 3; `headphones-today.md` 7). The other options in `headphones-today.md` 7 have bigger catches: eqMac's free tier is a 10-band graphic EQ that cannot match an AutoEq file, and CamillaDSP with BlackHole has the most moving parts.
- Order inside MPD per output: ReplayGain first, then your graph, then software volume, then MPD's own convert step last (`followup-1.md` 1). ReplayGain is off today.
- A headset call drops AirPods into hands-free mode, where any music curve is wrong. That holds for every EQ route (`followup-2.md` 3).
- There is no dither on the EQ'd path. The jack path stays float into CoreAudio (what CoreAudio does after that is UNCONFIRMED). On the Headspace path the final cut to 16 bits is plain rounding; the error is about -101 dBFS and only a very quiet fade could expose it (`followup-1.md` 4).
- Not yet run in a live MPD: the graph is measured with the same libavfilter, and the MPD wiring is read from source (`followup-1.md` 3). Step 4 is the cheap way to close that gap.

---

## 3. Problems you may not know you have

Ranked by what bites first. "Now" means the setup running today. Detail and evidence are in the lane named in the last column.

| # | Bites | Problem in plain words | Fix | Where |
|---|---|---|---|---|
| 1 | Now, serious | MPD is reachable by anyone on the same Wi-Fi: all interfaces, no password, firewall off, advertised over Bonjour. Full control, including `kill`. The May 2026 MPD CVEs are fixed in your 0.24.15. A connection test from a second device has not been done. | `bind_to_address` on both loopback addresses plus `zeroconf_enabled "no"`. A unix socket is not an option until the app's `mpd.rs` learns sockets. Use both `127.0.0.1` and `::1`, because nowplayd connects over `::1`. The app's client has no password or socket support, so do not add a password first. This edit can ride the same restart as step 7. | `followup-6.md` 3; `hidden-problems.md` A1 |
| 2 | Now | Your curve follows whatever the default output is. The AirPods Pro 3 are paired, so the music can jump to AirPods with the wired curve still on. Calls drop AirPods into a mode where a music curve is wrong. | Pin the output to a named device (section 2, step 6). Use Apple's EQ for AirPods. | `followup-2.md` 4 and 7 |
| 3 | Now | The app's own ten-band EQ protects headroom against about 60 percent of one boost. With every band at +14 dB a real +13.5 dB is left over, and a hidden soft clipper (starts at -3.1 dBFS) distorts: 0.97 percent at -1 dBFS and 2.8 percent at 0 dBFS. Even a cut-only setting is distorted on loud tracks. | Keep its sliders flat; the MPD filter does the headphone job. The server uses a computed preamp and a clamp. | `hidden-problems.md` A2; `formal-verification.md` S6, S7 |
| 4 | Now | The library is on Google Drive's Stream folder (by Google's documented path; not seen in the app). All 32,627 files are on disk today (1.2 TiB free), but in Stream mode unpinned files can be evicted if disk space runs low. MPD's log is 159 MB, 1.22 million update lines in total, 974,610 of them on 2026-08-21, plus thousands of probes of lyrics and image files. 289 "Operation not permitted" opens happened between 2026-08-31 and 09-06. | 30-second check in Drive's settings: Stream or Mirror. If Stream, tick "Available offline" on `Music`. Add a `.mpdignore`, update by path, rotate the log. The permission failures' cause is UNCONFIRMED (a changed signing identity or the Drive provider). | `followup-8.md` 3 and 4; `followup-7.md` 8; `hidden-problems.md` A7 |
| 5 | Now | MPD's macOS output is blind to device changes. The volume shown is a blend: MPD says 97 percent while the Mac says 81 (a stale device ID is the plausible cause; UNCONFIRMED). | Pinning may help (disable then enable re-runs the device lookup; UNCONFIRMED). The server re-resolves devices by UID and listens for removal. | `mpd-audit.md` 1.6, 1.10; `hidden-problems.md` A3 |
| 6 | Now | Through the app, everything is forced to 44.1 kHz / 16-bit before the EQ. 15,697 of 18,404 songs are already that; 2,650 are deeper and 943 are above 48 kHz. MPD dithers only about 1,180 of the deeper ones (44.1 kHz at 24 or 32 bit); the rest are plain-rounded. | An MPD-side EQ runs at the track's native rate, so the step-1 route avoids this. The server removes it by design. | `followup-1.md` 3; `followup-6.md` 2; `mpd-audit.md` P1 |
| 7 | Now | If the app dies, MPD's speakers stay off and MPD remembers that across restarts. Music "plays" into nothing. | `mpc enable "OS X Output"`, or a small watchdog. The server owns the device, so the takeover disappears. | `hidden-problems.md` A8 |
| 8 | Now | The app's audio thread takes locks. The 46 ms pipe means a reader stall over 46 ms loses audio. | Gone in the server (no pipe, lock-free ring). | `hidden-problems.md` A5; `followup-6.md` 1 |
| 9 | Now | The visualizer runs ahead of the sound: at least 100 ms, and 126 to 274 ms more over Bluetooth. | Delay the tap by the device's reported latency plus a per-device trim. | `hidden-problems.md` A6 |
| 10 | Housekeeping | `restore_paused` is off, so MPD resumes by itself after a restart. Ratings would live in `~/.cache/mpd`. The app's web view can send MPD any command, including `kill`. The log is never rotated. | `restore_paused "yes"`; a durable store keyed by track ID; a verb allow-list. | `hidden-problems.md` A10 to A12 |
| 11 | New server | Licensing: porting MPD code makes the server GPL. The Homebrew FFmpeg is a GPLv3 build. Winamp's licence 1.0.1 still bans distributing modified versions and reserves all distribution to Winamp (only the "No Forking" line was dropped). Microsoft skin art must stay out of any release. | Re-implement the protocol from its public documents. Use LGPL-only or system codecs. Do not read Winamp's source (a clean-room claim, not a licence ban). Call the feature "classic skin". | `hidden-problems.md` C5; `followup-8.md` 1 |
| 12 | New server | Real-time rules and gain staging: no allocation or locks in the audio callback, and one gain chain that survives gapless, ReplayGain, crossfade and EQ. | Section 4. | `architecture.md` 4; `followup-3.md` 1 |

**Looks wrong, is fine** (all MEASURED or read from source): the running MPD is 0.24.15 (the "0.24.0" that `mpc version` prints is the protocol number); `mpd --version` listing only "libsamplerate soxr" under Filters does not mean the ffmpeg filter is missing; MPD does not delete its FIFO on pause (the app's code comment says it does and is wrong); the four May 2026 CVEs do not apply to 0.24.15; the app does not flip the jack to 48 kHz on macOS (`followup-5.md` 6). Today's outputs are clean: Visualizer FIFO on, OS X Output on, Headspace off.

---

## 4. The replacement

Working names `audiod` and `ad_` are placeholders. Everything below is RECOMMENDATION unless tagged. Depth is in `architecture.md`; where `followup-3.md` or `followup-5.md` replaces a rule, I use theirs.

### 4.1 Architecture on one page

**Shape.** One long-lived process owns the sound card, the queue and the player. Every client talks to it through one C API: the Tauri app, an MPD-protocol shim, and later the Elixir layer. This is MPD's own split (daemon plus thin clients), so no behavior you rely on is lost (`architecture.md` 1).

**Language ruling** (`followup-5.md` 1 and 3). C11 for everything in the device callback and the public header: kernel, CoreAudio backend, decoders, player, ABI. Rust is allowed above the API line (MPD shim, native protocol, library workers) and as a decoder plug-in if a trigger fires. cpal and Symphonia stay out of the core. The deciding fact (MEASURED): cpal on macOS can set the device rate but cannot take hog mode (exclusive access) and exposes nothing for audio workgroups. The one C reuse library, miniaudio, has no hog mode on macOS either, so the backend is first-party in every route (about 500 to 850 lines of C; MPD's equivalent file is 837). The cost is real: your repos hold no first-party C today. What flips the ruling: Windows or Linux wanted before cutover (cpal behind the backend interface); Slice 0's acceptance still failing after one backend rewrite; a fuzzer finding a memory bug in a C decoder that Symphonia lacks.

**The audio path, one chain per output** (`followup-3.md` 1.1; replaces `architecture.md` 10.4):

1. Decode to float at the device rate. Any rate conversion happens here, once, only if the device cannot take the track's rate.
2. Per-track loudness gain, capped so it cannot exceed the track's peak. Unknown peak means no boost.
3. Track-to-track crossfade when enabled, equal-power curves.
4. EQ preamp. 5. EQ filters (64-bit, transposed direct form II).
6. Balance. 7. Volume. Both only ever cut.
8. Optional look-ahead limiter, off by default.
9. Clamp at plus or minus 1.0, always on. NaN becomes 0. Every hit is counted and shown.
10. Integer outputs only: TPDF dither, round, saturate.

Rules that go with it:

- **Headroom:** preamp = minus the true peak of the whole curve, over 20 Hz to half the sample rate, rounded up to 0.1 dB, evaluated densely (at least 200 points per octave, then refined). Cut-only profiles get 0. Loudness gain and preamp are two separate caps. Nothing that can add gain may sit after the clamp (`followup-3.md` 1.2).
- **Smoothing:** every change to level or response is a 20 ms raised-cosine transition. A slider edit ramps the parameter and redesigns the filter each sample, or every 128 samples at most with per-sample interpolation, never held. A structural change (add a band, load a profile, bypass) runs old and new chains and cross-fades their outputs with weights that sum to 1. Never a step, a linear fade, an equal-power fade between two versions of the same signal (+3 dB bump), or a reset of filter memory (`followup-3.md` 1.3).
- **Threads:** the device callback (CoreAudio's own real-time thread; no allocation, no locks, no system calls, bounded work, underrun means silence plus a counter), a decode thread, a control thread, library workers, and a network thread. Changes reach the callback as an immutable parameter block swapped by one atomic pointer (`architecture.md` 4).
- **Tap:** an overwrite ring of float frames after the graph, with a frame index so a reader sees gaps. It replaces both FIFOs (`architecture.md` 11).

**CoreAudio backend.** Written directly against CoreAudio, with the device found by UID and listeners for device-removed, jack-plugged and default-changed. Exclusive mode is off by default. Rate policy defaults to "fixed at the device's current rate" until a listening test says "follow the file" is better. The jack offers only 44.1, 48, 88.2 and 96 kHz (MEASURED, `followup-5.md` 2), so 176.4 and 192 kHz files must be resampled. Volume is software, in the graph.

**Decoders.** libFLAC or dr_flac (91 percent of the library), minimp3 or dr_mp3, libvorbis, libopus, and macOS AudioToolbox for the 49 M4A files. FFmpeg only as an optional plug-in from an LGPL build you make yourself. Fuzz every decoder from day one (`architecture.md` 6).

**Library.** A disposable SQLite index plus signed claims keyed by SHA-256. A second ID, the decoded-audio hash (FLAC already stores one), survives tag edits. Bootstrap by importing MPD's database file read-only. Reference the Drive folder in place (nothing copied; 439 GiB, which is 471 GB). Never trigger a Drive download, and treat cue sheets as first-class (`architecture.md` 12).

**Doors.**

- The C ABI is primary. The native door is a Unix socket (mode 0600, length-prefixed CBOR, no TCP by default).
- The MPD shim answers a measured short list (what the app, nowplayd, mpc and RMPC-Auto-Theme send; `architecture.md` 13.3). rmpc uses 74 command words (`landscape.md` 0.3), so its list is measured by a logging proxy on a spare port, not guessed. Every command not supported gets an explicit `ACK`; never half-implement (`architecture.md` 13.3, Mopidy's lesson).

**Elixir/BEAM** (`architecture.md` 14). The server is a separate OS process. A supervisor owns it through a Port (a crash arrives as a message), and commands travel over the socket. No NIFs anywhere near audio, which matches your existing house rule D01.

**Packaging** (`followup-7.md`). Ship one `.app`: the Tauri window, the server as a bundled helper, and a bundled login agent. Sign every piece with one stable identity. Put the usage strings in the main app's Info.plist, including the File Provider string that a background server needs before it can be asked for Drive access. Raise Tauri's default minimum macOS (10.13). `followup-7.md` recommends 14.4, which matters only if a system-wide process tap is ever added (Apple's floor for taps is 14.2; the 14.4 in some READMEs is second-hand). Whether a login-agent helper inherits the app's Drive consent is UNCONFIRMED; test it early (`followup-7.md` 10). Skip the App Sandbox: only the Mac App Store requires it, it would break the pipe and the takeover, and the transparent window's private API very likely rules out the App Store anyway (the Tauri link is UNCONFIRMED; Apple's public-API rule stands either way). Developer ID plus notarization is needed only when giving the app to others.

### 4.2 The sequence: T0 to T3

One chain; the lane "first steps" are the same thing (`followup-5.md` 5). T0 never waits for T1, and T1's tests use T0's measured profiles as golden vectors.

| Step | What | Delivers | Acceptance (from `architecture.md` 16) |
|---|---|---|---|
| **T0, tonight** | MPD ffmpeg filter (section 2) | EQ on the headphones now | You listen |
| **T1, "Ears"** | C kernel (64-bit filters, preamp, ramps, limiter, ring) plus CoreAudio backend. `audiod play <file> --eq <ParametricEQ.txt>`; FLAC and MP3 only | The same EQ file at native rate with no 16-bit cut; A/B against T0 on the same album; first rate-policy listening test | Swept sine and a 24-bit/96 kHz FLAC play an hour with no underruns; output matches an offline reference render within a stated tolerance; a filter change makes no click; unplug and replug recovers |
| **T2, "Daily"** | Queue and player state, gapless, MPD-state import, post-graph tap, native socket and MPD shim | **The first slice that replaces MPD for daily use**, running beside MPD on port 6601 | rmpc connects and plays an album; the app shows state, art, queue, and its message channel works; nowplayd and media keys work; `mpc status` and `mpc outputs` read sensibly; kill the server mid-track and a supervisor (launchd's keep-alive is enough; the BEAM layer is later) resumes at the saved position; sleep, wake and unplug do not hang it |
| **T3, "Cutover"** | Side-by-side soak with an underrun counter and event log; promote the rmpc commands it actually uses; move to port 6600 | MPD retired, its config and database kept untouched as rollback | A soak you are happy with |

Out of the first slice: crossfade and MixRamp, stickers, partitions, neighbors and mounts, network inputs and outputs, WASAPI and PipeWire, Vorbis, Opus and M4A decoding (1.2 percent of the library; added right after T2), the BEAM layer.

If T1 slips, patch today's app only in two cheap ways: keep the stream handle instead of leaking it, and act on the device-changed notice. Skip the `rubato` and `rtrb` rewrite, because it rebuilds in Rust what T1 builds in C (`followup-5.md` 5).

### 4.3 Phases to "Winamp, but better"

The Must, Should and Later lists are `winamp-better.md` 7. The order (W1 to W6) is my sequencing; the lane gives no order beyond Must, Should and Later.

| Step | What | From the Must list |
|---|---|---|
| **W1 (inside T1 and T2)** | The server's EQ is a list of bands, not ten sliders. Equalizer APO and AutoEq files load as written. A profile is stored per output route, so plugging in headphones switches it. A readout shows preamp, total boost, clamp hits and the signal path ("bit-perfect / resampled / EQ on"). | M1, M2, M6, M7, M14 |
| **W2** | Playback depth: gapless that honors encoder-delay tags, crossfade, loudness measured by the server (EBU R128) and stored in its own database, never written into your files. Vorbis, Opus and M4A decoders. | M4, M5 |
| **W3** | The faces. The ten sliders of each skin family become views onto the band list: classic Winamp (60 Hz to 16 kHz, plus or minus 12 dB; shelf, eight bells, shelf, which is Webamp's model; real Winamp's filters are UNCONFIRMED), WMP (31 Hz to 16 kHz, Q 1.41, plus or minus 14 dB, what the app does now), and AutoEq's ten-band layout. Rule: "slider equals the filter's gain", because every stock preset was authored that way. Load and save Winamp `.eqf` files and the 17 stock presets. Real HiDPI. A skin loader that treats skins as hostile (read in memory, never run anything). Hotkeys, Now Playing, mini-player. | M3, M8 to M13 |
| **W4** | Library depth: play counts, ratings and smart lists in a durable store keyed by track ID; search that folds dashes, quotes and accents. | S1 |
| **W5** | Visualizer (Butterchurn in the web view is the easy route; projectM is native with an OpenGL risk), internet radio, optional OpenSubsonic for phones, per-track EQ, art-derived skin tint, scrobbling. | S2 to S7 (Should list) |
| **W6** | Your own stack: the BEAM layer, then Orgiac-generated C swapped in module by module behind the same interfaces. Windows and Linux backends (shared mode first). Modern Winamp skins and AVS are deliberately not copied. | Later |

What nobody could establish: what filters real Winamp runs behind its ten sliders. The only public model is Webamp's (a low shelf, eight bells, a high shelf), and it may differ. The way to settle it is to measure real Winamp or WACUP on Windows, a sweep per slider (`winamp-better.md` 4.2 and 4.6).

---

## 5. What we formally verify

You verify user stories; proofs are replaceable. If the EQ is later re-implemented in Orgiac, the stories and golden test vectors carry over and the proofs are redone (`formal-verification.md` 2).

**The honest status.** Nothing is machine-checked today. No prover is installed: `lean` is an `elan` stub with no toolchain, and `coqc`, `rocq`, `frama-c`, `opam`, `why3`, `cbmc` and `kani` are all missing (MEASURED, `formal-verification.md` 1; `followup-5.md` 2). The strongest evidence so far is sweeps of a finite grid.

**The rungs** (`formal-verification.md` 2, plus one addition from `followup-4.md` 6):

| Rung | Meaning |
|---|---|
| E0 | Untested |
| E1 | A few examples behave |
| E2 | Every input in a stated, finite domain was run (a dense grid for many inputs) |
| DERIVED | Worked out on paper, not machine-checked. Proposed by `followup-4.md` as a rung between E2 and E3, because the lanes use it everywhere |
| E3 | A machine-checked proof about real numbers |
| E4 | The proof covers rounding |
| E5 | The proof reaches the binary |

Rule 10 of `formal-verification.md`: never write "verified" without a rung. By that rule the lanes' "math verified" for ffmpeg-versus-AutoEq is E1 (20 hand-picked settings, dense only along frequency), not E2 (`followup-4.md` 6).

**Principle** (`formal-verification.md` 1 and 10): the server refuses a profile it cannot vouch for. At load time the control side computes the filter numbers in 64-bit, checks stability with a margin, finds the true peak and sets the preamp, and rejects anything it cannot guarantee. The proofs later shrink to "the checker is right". Phase 0 of the proofs is this checker plus the kernel rules inside T1, not a separate project (`followup-5.md` 5).

| ID | Story (what you would check) | Property, with mode where it matters | Tool | Rung now, then reachable |
|---|---|---|---|---|
| S1 | The gain I set is the gain I get at the band's centre | Centre gain is exactly the set gain. Three-line algebra | Rocq or Lean for the algebra; Gappa or VCFloat2 for rounding | f64 formulas match to 7e-12 dB over 160 cases (E2). The app's 32-bit code is off by 0.003 dB at 44.1 kHz, 0.014 at 96, 0.40 at 192. Reach E3, and E4 with 64-bit |
| S2 | The EQ never goes unstable | Both poles inside the unit circle for every centre strictly between 0 and half the rate, any positive Q and gain (closed form). Plus a run-time floor on distance from the circle (1e-5) | Rocq; run-time check | Swept (E2) and DERIVED. The two shelves are checked numerically only and still need the algebra. Reach E3 |
| S3 | A flat setting changes nothing; EQ-off is bit-exact when rates match | 0 dB at DC and at half the rate; skip the stages when flat | Algebra; golden vectors | Filter DERIVED. Today's app is not bit-exact because its resampler always runs. Reach E3 plus E2 |
| S4a | Boost then the matching cut returns my sound | Holds in the cookbook mode (1e-12 dB). Fails in the matched-bell mode as printed: leftover 0.31 dB at 20 kHz (1.16 dB at plus-minus 12). Holds again if a cut is defined as the exact inverse of the boost ("B+") | Algebra; a golden test "under 1e-9 dB, every mode, whole band to half the rate" | Reach E3 in cookbook mode and B+ (`followup-4.md` 3 to 5) |
| S4b | Band order does not matter | Exact maths for any linear filter; float rounding by test | Algebra; test | Reach E3 plus E2 |
| S5 | A band means the same at 44.1, 96 and 192 kHz | Needs your choice of target (section 6). Default cookbook mode: a 16 kHz band is 0.34 octave wide at 44.1 kHz and almost 1 octave at 192 kHz. HD 600 example moves up to 0.14 dB between 44.1 and 48 kHz and 0.85 dB at 192 | Interval bounds against the chosen design | Today false at the top. Reach E3 once the target is picked |
| S6a | No steady sine clips after the EQ | Preamp is minus the peak over 20 Hz to half the rate. Coarse grid scans under-report: 1,024 linear points miss up to 5.8 dB | Certified peak search (interval branch and bound, CoqInterval) | App: false (+13.5 dB left). AutoEq's own preamp is within 0.12 dB on 75 real files. Reach E3 |
| S6b | Nothing at all can clip (any music, any glitch) | Preamp from the sum of the absolute impulse response. Costs a median 4.5 dB more headroom on real profiles. A named mode, not the default | Worst-case peak gain (Hilaire group; Coq work of Gallois-Wong, Boldo, Hilaire) | Tight, measured; reach E3 |
| S6c | The output never exceeds full scale | Clamp last, after volume, NaN to 0. Identity in range, so the EQ-off path stays bit-exact | Exhaustive 32-bit check (done for the app's old soft clip) | Reach E2 now; E3 with the clamp placed last |
| S7 | If I only cut, loud passages are untouched | No soft clipper in the linear path. App today fails: 0.83 percent distortion at -1 dBFS | Design change plus test | Today false. Reach E2 |
| S8 | The EQ adds no audible noise of its own | 64-bit state. With 32-bit the error is -110 dBFS at 44.1 kHz but -91 dBFS at 192 kHz, above 16-bit noise at -101 | VCFloat2 or Gappa for the recurrence | Reach E4 via 64-bit; the 32-bit proof is thesis-grade |
| S9 | Silence stays silent; one bad sample cannot kill a channel | Clear state after N zeros; reject non-finite input | Test | Today: never returns to exact zero; one NaN kills a channel for good. Reach E2 |
| S10 | Moving a slider does not click | 20 ms raised-cosine ramp. Measured -104 dBFS versus -42 for a step. A state-variable filter is not needed | Test, not proof | Today clicks. Reach E2 |
| S11 | Same file, same settings, same bits on every build | `-ffp-contract=off`, no fast-math, golden vectors | Compiler flags; golden vectors | Reach E2 |
| S12 | The audio thread never waits for the UI | Lock-free hand-off | RealtimeSanitizer (a dynamic check) | App: false. Reach E2 |
| P1 to P6 | Gapless has no gap or overlap; "next" is decided once; random, consume and single behave; queue edits or seeks at hand-off never leave an impossible state; every Play ends in sound or a visible error; pause and resume never replay stale audio | Model-checked rules | TLA+ or Quint with TLC; a model of the audio ring; Concuerror and PropEr for the Elixir side; trace-check against a sandbox MPD | E0 now. MPD's documents are silent on gapless and queue edits, so its behavior must be learned from experiments |
| L1, L2 | Stored FLAC decodes to exactly what was encoded; nothing in the library is silently altered | Check STREAMINFO's MD5 at end of decode; verify content hashes on read | The format; the blob design | Reach E2 for free |

Cannot be verified, so do not promise it: that a result sounds right, that a preset matches your headphone (a headphone's resonance is not a bell; `followup-4.md` 5), and what the OS or DAC does after the device edge. Whether CoreAudio clips float samples above 1.0 is UNCONFIRMED; the chain never relies on it.

Order of work (`formal-verification.md` 10, adjusted by `followup-3.md` and `followup-5.md`): Phase 0 inside T1 (64-bit, the checker, flags, golden vectors); Phase 1 beside T1, blocking nothing (Rocq for S1 to S4, certified peak and sum bounds, the TLA+ models); Phase 2 (Frama-C and VCFloat2 on the C kernel; trace-check the server); Phase 3 (carry stories to Orgiac). Bend 2 stays out of the signal path: no reals, no 64-bit floats, floats are axiomatic (`formal-verification.md` 8).

---

## 6. Decisions for the owner

You said not to wait, so none of these block section 2. Each has a recommended default.

| # | Decision | Options | Recommended default | Source |
|---|---|---|---|---|
| 1 | What is on the jack, and do you want AirPods corrected? | Wired model; AirPods | Wired via the MPD filter. AirPods via Apple's EQ, no MPD filter. Blocks the exact graph. | `followup-2.md` 8 |
| 2 | How far must the correction reach? | Music only; whole system | Music only (the MPD filter). Add SoundSource later if browser and video matter, and remove the MPD filter that day. | `followup-2.md` 3 |
| 3 | May the scratch-MPD test (section 2, step 4) run? | Yes; skip | Yes. It touches neither your MPD nor any sound device. | `followup-2.md` 6 |
| 4 | Lock down port 6600 now? Is the open port intentional (phone, other rooms)? | Both loopbacks plus Bonjour off; unix socket (not until the app's client supports it); leave open | Both loopbacks plus Bonjour off. Do it unless something on another device needs MPD. | `followup-6.md` 3 |
| 5 | Drive: Stream or Mirror? | Check, then pin offline | Run the 30-second check. If Stream, tick "Available offline". Decide mirror versus reference-in-place after the answer. | `followup-8.md` 5 |
| 6 | Language | C11 core; Rust shell | C11 inside the API line, with the three flip triggers in section 4.1. | `followup-5.md` 1 |
| 7 | EQ definition across sample rates, and the no-clip promise (coupled) | Cookbook "same as Equalizer APO" (A); matched bell with cut-as-inverse (B+); Orfanidis; cookbook bandwidth form. Sine-safe or any-signal. Below 20 Hz: ignore, or include DC | A as default and B+ as an option. Sine-safe over 20 Hz to half the rate; any-signal and DC as named modes. | `followup-4.md` 5; `followup-3.md` 5 |
| 8 | Where do the library's bytes live? | Reference Drive in place; local mirror of 439 GiB | Reference in place for the first slice. | `architecture.md` 12.4 |
| 9 | Signing | Apple Development identity now; paid Developer ID later | Use the one Apple Development identity you already hold for every piece. Pay for Developer ID only when giving the app to others. You hold the key; agents never do. | `followup-7.md` 3 |
| 10 | Winamp fidelity or feeling? | Measure real Winamp on Windows; ship the Webamp-style model | Ship "slider equals filter gain" now; measure later if presets must sound identical. | `winamp-better.md` 8 |
| 11 | Name | `audiod` is a placeholder | Yours to choose. | `architecture.md` 17 |

Smaller choices with defaults in the lanes: per-channel EQ (linked by default), visualizer route (Butterchurn), a 24-bit/96 kHz hi-res target (the jack tops out at 96 kHz), and classic skin extensions (`winamp-better.md` 8).

---

## 7. Index of the other documents

Lanes (the first research pass):

| File | One line |
|---|---|
| `mpd-audit.md` | What MPD is, where it falls short in 2026, and how your own code works around it. Chain diagram and the `aformat=s16` graph are dead. |
| `headphones-today.md` | The EQ-tonight recipe: AutoEq file to one MPD filter line, with the five-rate accuracy test and the five alternatives. The graph in its section 4 is the one to use. |
| `hidden-problems.md` | The ranked list of problems you may not know about, plus macOS audio traps and traps for the new server. Several lines corrected (section 8). |
| `landscape.md` | Survey of 20 music servers, players and audio stacks, the empty cell, and the capability list and compatibility targets for a C library. |
| `eq-dsp.md` | What a full-band parametric EQ must be: formulas, 64-bit precision, smoothing, headroom, dither, FIR, and the P1 to P10 property list. |
| `architecture.md` | The C server: objects, ABI sketch, real-time rules, backends, decoders, gapless, library, MPD shim, BEAM, and slices 0 to 2. |
| `formal-verification.md` | What can honestly be called verified: the E0 to E5 rungs, stories S1 to S12 and P1 to P6, tools, and a phased plan. |
| `winamp-better.md` | What Winamp and WACUP did right and wrong, Winamp's exact EQ controls, and the feature list for the standalone app. |

Follow-ups (these override the lanes):

| File | One line |
|---|---|
| `followup-1.md` | Where the EQ sits in MPD's chain and what format it hands over. Result: EQ runs before the 44.1/16 pin, there is no dither anywhere on the EQ'd path, and one graph is enough. |
| `followup-2.md` | Which headphones and which route. Result: AirPods Pro 3 are paired, the filter needs device pinning, and the scratch-MPD test is prepared. |
| `followup-3.md` | One gain chain, one headroom rule, one smoothing rule. Result: the chain in section 4, the 20 Hz window, clamp last, raised-cosine ramps. |
| `followup-4.md` | Whether "boost then cut equals wire" survives the matched mode. Result: no, unless a cut is the inverse of the boost; and the rung vocabulary fix. |
| `followup-5.md` | One language decision and one sequence. Result: C11 inside the API line, and T0 to T3. |
| `followup-6.md` | Five contradictions resolved: FIFO not deleted on pause, dither scope, network exposure, the filter exists, version 0.24.15. |
| `followup-7.md` | Packaging, signing, permissions, login start and updates for the standalone app; process-tap floor 14.2; new evidence on the permission errors. |
| `followup-8.md` | Winamp licence 1.0.1 text, library size and count units, update-storm figures, and Drive stream versus mirror. |

---

## 8. Dead lines in the lanes

Short list so no one copies a number that a follow-up killed. The lane files are not edited.

- **`mpd-audit.md`**: chain diagram (1.1, lines 46-47, 180) and the `aformat=s16` second graph with its third caveat (5.1) are wrong. UNCONFIRMED items 3 and 16 are resolved: no dither for float, and MPD always conforms the output to the pinned format. The "16-bit before the EQ" findings (P1) hold for the app's own EQ only, not an MPD-side EQ (`followup-1.md` 5).
- **`headphones-today.md`**: ReplayGain runs first, not after the EQ (line 139). The A/B pair of outputs (line 142) is superseded by device pinning. Line 247's "no built-in EQ" is superseded for AirPods. Section 6's title "Proof the math is right" means E1.
- **`eq-dsp.md`**: the worry that MPD silently drops a 64-bit graph back to 16-bit does not apply to the printed block (Route A). Its HD 600 graph is safe but retired. Rule 1 of 4.6 ("every 16 to 32 samples") is wrong if coefficients are held between recomputes. Summary item 10 and properties P2 and P3 are cookbook-mode only. "Math verified" means E1. The 14.4 figure for process taps should be 14.2. "Share one headroom budget" means two separate caps.
- **`architecture.md`**: section 11's "MPD deletes the FIFO on pause" is wrong. Section 2.4's "Drive is mirroring" is wrong. Section 10.4's headroom rule is wrong in both directions. Sections 5.1 and 5.4's "rate switch not exposed" is half wrong. "The daemon is 0.24.14" is 0.24.15. "439 GB" is 439 GiB (471 GB). Item 10 (language) is closed. The packaging requirement at line 87 is incomplete.
- **`hidden-problems.md`**: A4's "MPD does dither that step" is true only for 44.1 kHz at 24 or 32 bit. A4's "the app would ask for 48 kHz and flip the hardware" is wrong on macOS. The AirPods rows marked "Dormant" are live. C2's limiter before volume is the wrong place. C1's crossfade needs a fade law. A7's Stream versus Mirror unknown is now "Stream". File count 18,362 should read 18,401 (five types) or 18,403 (with wav). "Forbids forks" should read "forbids distributing modified versions".
- **`landscape.md`**: "MPD is 0.24.0" is 0.24.15. Section 0.4's doubt that the ffmpeg filter is compiled in is resolved: it is. Its Winamp note omits that licence 1.0.1 kept two of the three bans.
- **`winamp-better.md`**: "macOS 14.4" for taps is Apple's 14.2. Its question about whether the ffmpeg filter exists is resolved: yes. "Section 2.3" in the licence note means licence sections 3 and 5.
- **`formal-verification.md`**: S4 splits by mode (S4a holds in cookbook mode and B+ only). S5 option (a) as printed breaks S4. S6a reads "from 20 Hz up". S10's state-variable filter is not needed. "MPD here is 0.24.0" is 0.24.15. Section 12's open question on AutoEq's maximum is closed. "A correction built as the inverse of a measured peak cancels it" was never a theorem.
