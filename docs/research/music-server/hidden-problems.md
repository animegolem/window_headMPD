# Hidden problems audit

**Date:** 2026-10-07
**Lane:** PROBLEMS THE OWNER MAY NOT KNOW THEY HAVE
**Machine audited:** MacBook Pro (Mac15,8, Apple M3 Max), macOS 27.0 (26A428), MPD 0.24.15 from Homebrew, window_headMPD checkout at `~/git/window_headMPD`.

## How to read this

Everything was read-only. I did not start or stop MPD or the app, change outputs, touch playback, edit any repo file or the MPD config, or install anything. The only MPD commands I ran were `mpc version`, `mpc outputs`, `mpc status` and `mpc stats`. All scratch work is in `/tmp/msr-hidden-problems/`.

Every finding carries one of these tags, so facts and advice never blur together:

- **[M] Measured**: observed on this machine, in this code, or in MPD's source today. The command or file is named.
- **[S] Simulated**: I re-implemented the app's own algorithm in numpy and measured that. It is a measurement of the algorithm, not of the running app.
- **[C] Cited**: an external claim, with its source number (S1, S2 ...) listed at the end.
- **[U] UNCONFIRMED**: I could not verify it. It is plausible, not established.
- **Fix**: my recommendation. Never mixed into a measured paragraph.

Severity: **HIGH** = hurts you now or exposes you. **MED** = will bite in ordinary use. **LOW** = cosmetic or a future trap.

---

## 1. What bites first

Ranked by how soon you will hit it and how bad it is. "NOW" means the setup running today. "NEW SERVER" means a design trap for the replacement.

| # | Sev | Problem in plain words | Fix in one line | When |
|---|-----|------------------------|-----------------|------|
| 1 | HIGH | MPD listens on every network interface with no password and no firewall. Anyone on the same Wi-Fi has full control. | `bind_to_address "127.0.0.1"` (or a unix socket); add password support to the app first. | NOW |
| 2 | HIGH | The EQ's clipping protection covers only about half of what a real boost does. A normal headphone-correction curve distorts loud tracks. | Preamp = minus the true peak of the whole curve, plus a limiter at the end. | NOW |
| 3 | MED | When the output device changes (unplug, monitor, AirPods), audio follows but the EQ curve does not. Headphone correction plays on speakers. MPD's own output also breaks on device changes (32 failed opens, 91 failed volume sets in its log). | Key EQ profiles by device ID; pause instead of silently rerouting to speakers. | NOW |
| 4 | MED | The music library lives on Google Drive's streaming folder. MPD's log shows an update storm (1.22 million lines, about 1,700 library scans in one evening) and thousands of probes of lyrics and image files. | `.mpdignore` for non-audio files, targeted updates, library available offline. | NOW |
| 5 | MED | Everything is forced through a 44.1 kHz / 16-bit pipe, then re-sampled again with a weak resampler. 14% of the sampled FLACs are hi-res. | Run the EQ at the device rate, use a proper resampler, drop the hard-coded rate. | NOW |
| 6 | MED | The audio callback takes locks and allocates memory. The FIFO is only 46 ms deep, and MPD throws audio away if the app falls behind. Rare dropouts under load. | Lock-free ring buffer, atomic coefficient swap, blocking reads. | NOW |
| 7 | MED | If the app dies, MPD's speakers stay switched off, and MPD remembers that across restarts. Music "plays" into nothing. | Watchdog that re-enables the speakers; the new server owns the device so there is no takeover. | NOW |
| 8 | MED | The visualizer runs ahead of what you hear by at least the device buffer, and by 120 to 270 ms more on Bluetooth. | Delay the visual tap by the device's reported latency plus a per-device trim. | NOW |
| 9 | MED | The volume knob is the macOS system volume (hardware mixer) on one path and a software volume on the other. Swapping paths changes what "volume" means. | One volume owner; digital volume in the engine. | NOW |
| 10 | LOW-MED | Ratings and play counts would live in `~/.cache/mpd/`, the folder cleaners delete. | Durable store, keyed by stable track ID. | NOW and NEW SERVER |
| 11 | LOW-MED | `restore_paused` is off, so MPD resumes playing by itself after a restart. | `restore_paused "yes"`. | NOW |
| 12 | LOW | Tauri exposes `mpd` (any command) and `record_stop(path)` (write anywhere) to every page. The skin sandbox protects it today. | Allow-list verbs; confine the write path. | NOW |
| 13 | HIGH later | Licensing: porting MPD code makes the new server GPL. The Homebrew FFmpeg is GPLv3. Winamp's source license forbids forks. | Clean-room protocol, LGPL-only or system codecs, keep Winamp source and Microsoft skin art out. | NEW SERVER |
| 14 | HIGH later | Real-time rules (no GC, no locks, no allocation in the audio thread) and a gain-staging chain that survives gapless, ReplayGain, crossfade and EQ. | Native audio thread; one chain: per-track gain, mix, EQ, limiter, volume, dither. | NEW SERVER |

---

## 2. Problems in the setup running today

### A1. MPD is open to the whole network (HIGH)

**[M] What I saw.**
- `lsof -nP -iTCP:6600 -sTCP:LISTEN` shows `mpd` (pid 92091) listening on `*:6600`. That is the wildcard address, not 127.0.0.1.
- `/opt/homebrew/etc/mpd.conf` has `bind_to_address`, `password` and `default_permissions` all commented out.
- `socketfilterfw --getglobalstate` says "Firewall is disabled". The Mac's LAN address is 192.168.0.18.
- The lsof line is an IPv6 socket. An IPv6 wildcard listener normally accepts IPv4 too. **[U]** I did not connect to it to prove that. From another device on your network, `nc 192.168.0.18 6600` would settle it.

**[C] What the docs say.** The default for `bind_to_address` is "any". With no password, every client gets full permissions including `admin`. Passwords are sent in clear text (S3).

**[C] This is not theoretical.** In May 2026 four MPD flaws were published, all reachable by unauthenticated network clients, all fixed in 0.24.11 (S6, S7, S8):
- CVE-2026-49127: stack buffer overflow, triggered by "two MPD commands referencing a malicious HTTP audio source" (CVSS 8.6).
- CVE-2026-49128: path traversal.
- CVE-2026-49129: server-side request forgery through the `add`, `readcomments`, `albumart`, `readpicture` and `load` commands.
- CVE-2026-49130: CRLF injection.

You run 0.24.15 (`brew list --versions mpd`), so those four are fixed. NEWS also lists more hardening queued for 0.24.16 (S5).

Your config enables the `curl` input plugin. That is the plugin the SSRF class goes through. Anyone who can connect can make your Mac fetch a URL.

Browsers can also talk to localhost services, so a web page can try to feed MPD protocol lines (S9, general class). **[U]** I did not test this against MPD, and I may not.

**Risk.** On any shared network (cafe, hotel, office), a stranger can control playback, list your library, make the Mac fetch URLs, and run `kill`.

**Fix.**
1. Add `bind_to_address "127.0.0.1"` to `mpd.conf`, or use a unix socket.
2. Before changing that, check every client. `mpd.rs` only does TCP to `MPD_HOST:MPD_PORT` and never sends `password`. A password or a unix socket needs a small app change first, or the app loses MPD. Localhost binding keeps the app, `mpc` and other TCP clients working.
3. If you want phone control later, use a password plus a VPN or SSH tunnel, because the password travels in clear text.
4. Turn the macOS firewall on as a second layer.
5. Update MPD when 0.24.16 ships.

I did not make this edit. It is a config change and I am read-only.

### A2. The EQ does not leave enough headroom, then distorts to cope (HIGH)

This matters most for "EQ my headphones right now".

**[M] What the code does** (`src-tauri/src/eq.rs`):
- The preamp is `10^(-peak*0.6/20)`, where `peak` is the single highest slider. It cancels only 60% of one band's boost.
- Whenever the EQ is not flat, a soft clipper starts at 0.7 (about -3.1 dBFS) and rounds off everything above it.
- The code's own unit test says it: "+12 dB at the band, minus the 7.2 dB headroom trim: ~ +4.8 dB". So a +12 dB boost nets +4.8 dB of uncompensated gain.

**[S] What a real curve does.** I computed the combined response of the app's ten peaking filters (Q 1.41, 44.1 kHz). Neighbouring bands overlap, so their boosts add.

| Scenario | True peak of the combined curve | App's preamp | Gain left uncompensated |
|---|---|---|---|
| one band +12 dB at 1 kHz | +12.0 dB | -7.2 dB | +4.8 dB |
| two adjacent bands +12 | +14.6 dB | -7.2 dB | +7.4 dB |
| three adjacent bands +12 | +17.0 dB | -7.2 dB | +9.8 dB |
| "smile" (+8 +6 +3 0 -2 0 +2 +4 +6 +8) | +9.3 dB at 32 Hz | -4.8 dB | +4.5 dB |
| bass lift (+10 +8 +6 +3, rest flat) | +11.9 dB at 32 Hz | -6.0 dB | +5.9 dB |
| all ten +14 | +21.9 dB at 500 Hz | -8.4 dB | +13.5 dB |

**[S] What the soft clipper costs.** A 997 Hz sine through it alone: clean at -3 dBFS, **0.97% distortion at -1 dBFS, 2.8% at 0 dBFS**. A modern loud master peaks there routinely.

**Reasoning, not measured:**
- The clipper acts on each channel separately, so a hard-panned peak shifts the stereo image.
- The cubic resampler after it can overshoot past full scale, and the output driver then hard-clips.
- EQ off is unity gain, and EQ on is quieter by the preamp, so every on/off comparison is a loudness comparison. Louder sounds better. A/B tests of an EQ need level-matching or you will fool yourself.
- `set_gains` swaps coefficients and the preamp instantly on every slider tick. The preamp can jump up to 8.4 dB in one sample, which is a step in the waveform, an audible tick. I did not measure the tick. My step test was inconclusive.

**Fix.**
- Set the preamp to minus the true maximum of the combined curve, computed from the actual response. This is the convention Equalizer APO uses: "Preamp: negative number dB ... useful when filters have positive gain to prevent clipping" (S10).
- Add a true-peak limiter after the EQ. Make the soft clipper a last-resort limiter at 0 dBFS, not -3 dBFS.
- Smooth the preamp and the coefficients over 10 to 20 ms.
- Ship each headphone profile with its own preamp value.
- Add a clip indicator.

### A3. Device changes: audio follows, the EQ curve does not (MED)

**[M] Devices on this machine now** (`system_profiler SPAudioDataType`):
- "External Headphones": default output, 44,100 Hz.
- "MacBook Pro Speakers": 44,100 Hz.
- "DELL S2725QC" over DisplayPort: 48,000 Hz.
- "Microsoft Teams Audio": a virtual device, 48,000 Hz.
- No Bluetooth audio device is listed right now.

**[M] What the app does** (cpal 0.18.2 from `Cargo.lock`, source read from the local cargo registry):
- `default_output_device()` becomes a "DefaultOutput" audio unit. When the system default changes, macOS reroutes the stream and cpal reports `DeviceChanged`. If there is no default device at all, cpal pauses the stream and reports `DeviceNotAvailable`. cpal's changelog describes the same (S11). This is better than I first assumed.
- The app's error callback only prints (`|e| eprintln!(...)` in `audio.rs`).
- `lib.rs` calls `std::mem::forget(stream)`, so the stream handle is gone. The app can never restart or rebuild it.
- Result: on a device switch the sound moves, but the EQ curve stays whatever it was. Pull the headphone jack and the headphone correction plays on the speakers.
- If the default device ever vanishes completely, the stream stays paused until relaunch. This MacBook always has its built-in speakers as a fallback, so that case is unlikely here.

**[M] What MPD's own output does** (MPD's `OSXOutputPlugin.cxx`, S2):
- It looks up the device ID once, when the output is created at MPD startup, and uses that ID for volume and format calls. I found no code that listens for the device changing or disappearing.
- Its log has `Failed to open "OS X Output"` 32 times and `Failed to set mixer for "OS X Output"` 91 times, always with OSStatus 560947818.
- That number is `0x216F626A`, the four characters `!obj`, which I believe is `kAudioHardwareBadObjectError` ("that audio object no longer exists"). I decoded the hex myself. **[U]** I did not find a source for the name.
- The failures cluster at 2026-08-20 17:xx (46 lines), 2026-08-22 04:xx (136) and 2026-09-08 07:xx (25). **[U]** I cannot tell from the log what caused each one (unplug, sleep, display change).

**Fix.**
- Key EQ profiles by device UID, not by name.
- React to `DeviceChanged` by switching profile, or by bypassing the EQ and showing "no profile for this device".
- Keep the stream handle and rebuild the stream on `DeviceNotAvailable` or `StreamInvalidated`.
- Policy worth copying from phones: never silently move headphone playback to speakers. Pause, and let the user resume.
- For MPD itself, the device ID is only re-read at startup. **[U]** whether disable/enable of the output is enough to recover without restarting MPD.

### A4. Sample rate and bit depth: forced to 44.1k/16, then resampled badly (MED)

**[M] The pipe.**
- Both FIFO outputs in `mpd.conf` are `format "44100:16:2"`.
- I sampled every 100th FLAC (167 files): 144 are 44.1 kHz/16-bit (86%). **23 (14%) are hi-res**: 10 at 44.1k/24-bit, 7 at 96k/24-bit, 4 at 48k/24-bit, 2 at 88.2k/24-bit.
- The hi-res files are re-sampled and cut to 16 bits before the EQ ever sees them. MPD does dither that step (`pcm_convert_to_16(buffer, dither, ...)` with `PcmDither`, S12), so it is not raw truncation.

**[M] The hard-coded rate.**
- `IN_RATE = 44100.0` in `audio.rs` must match the `format` line in `mpd.conf`. Nothing checks it.
- If someone changes the conf to 48 kHz and not the constant, music plays about a semitone and a half flat (44.1/48 = 0.919, which is -147 cents). **[S]** arithmetic.
- It would also skip. MPD would deliver 3,900 more frames a second than the app consumes. The ring would pass its 400 ms cap in about 3 to 4 seconds, and the app would drop about 300 ms of audio in one go, over and over. **[S]** arithmetic from `audio.rs` constants.

**[M] What the app asks the device for.**
- cpal 0.18 "default output configs now prefer 48 kHz, then 44.1 kHz" and "physical stream format is now set directly on the hardware device" (S11).
- Your headphone output is currently at 44,100 Hz. By the code and changelog, the app would ask for 48 kHz and flip the hardware to it. **[U]** at runtime. I may not start the app.
- The app then converts 44.1 kHz to 48 kHz itself with a cubic (Catmull-Rom) interpolator.
- MPD's own osx output also switches the device rate to match each track ("the plugin only changes the sample rate", S4; `osx_output_set_device_format` in S2). Two programs can fight over the hardware rate.

**[S] How good that interpolator is** (44.1 kHz to 48 kHz, the app's algorithm re-implemented):

| Test tone | Level error | Strongest false tone (relative to the tone) |
|---|---|---|
| 1 kHz | 0.00 dB | -92 dB |
| 5 kHz | -0.03 dB | -47 dB |
| 10 kHz | -0.38 dB | -26.5 dB |
| 15 kHz | -1.65 dB | -14 dB |
| 18 kHz | -3.1 dB | -8 dB |
| 20 kHz | -4.4 dB | -4 dB |

The false tones are "images", mirror copies of the real content. They are inharmonic, so they are the audible kind of error. For reference, MPD's own resamplers: libsamplerate's default type is documented as "Band limited sinc interpolation, fastest, 97dB SNR, 80% BW", and soxr has presets from "quick" to "very high" with "high" as default (S4). **[U]** Which one MPD picks when `mpd.conf` has no `resampler` block. The local binary links both.

**[S] Float32 precision.** The app's filters are 32-bit float. With the same filter form, a 10-band cascade run in float32 differs from float64 by only 68 to 74 dB below the signal. For music near -20 dBFS that is an error floor around -88 to -94 dBFS. That is above 16-bit quantization noise (roughly -100 dBFS), and it is worse for bass boosts. The error is relative to the signal. I rounded the coefficients from float64 to float32. The app computes them in float32, so its real error may be a little larger.

**Fix.**
- Make the device's current rate the internal rate, or run the EQ after resampling at the device rate (Equalizer APO runs at the device rate, S10).
- Use a real resampler (soxr, or the `rubato` crate).
- Do not change the hardware rate from the EQ path.
- Let MPD send float or 24-bit at the source rate, with the format agreed in a handshake rather than duplicated in two files.
- Keep filter state in 64-bit float. It is cheap on Apple Silicon.

### A5. Audio-thread safety and FIFO dropouts (MED)

**[M] In the audio callback** (`audio.rs`):
- It locks the `ring` and `eq` mutexes. The FIFO reader thread and the UI's `set_eq` call contend for them. `set_eq` computes sin, cos and pow for ten bands while holding the `eq` lock.
- `record()` locks and `push`es into a growable `Vec`, which means allocation in the callback.
- `push_tap` locks `tap`, which the analysis thread holds while it copies 2,048 samples.
- `tap_buf` grows if the OS ever asks for more than 4,096 frames.

**[M] FIFO behaviour.**
- A FIFO on this macOS holds **8,192 bytes**, which is 2,048 frames, **46 ms** of 44.1k/16-bit stereo. I measured it with non-blocking writes to a scratch FIFO in `/tmp/msr-hidden-problems/`, not MPD's.
- MPD's FIFO plugin, when the pipe is full, empties the pipe and carries on. The code says `case EAGAIN: /* The pipe is full, so empty it */ Cancel();`, and it paces itself with a software timer, not by the reader (S1).
- So if the app's reader thread is delayed by more than 46 ms, MPD discards the audio in the pipe. That is an audible dropout, not a pause.
- The reader polls with `sleep(2 ms)` when the pipe is empty. That is about 500 wakeups a second, playing or paused. MPD opens the FIFO once, in the output's constructor, and closes it only in the destructor. The plugin has no pause, enable or disable handler that closes it (S1). So the pipe never reports end-of-file while MPD runs, an empty read always comes back "would block", and the reader never gets to its slower 50 ms reopen branch. The analysis thread runs at 60 Hz forever, even paused or hidden.
- Side effect: MPD also holds the read end open itself, and its `Cancel()` drains the same pipe the app reads. That is how it empties a full pipe.
- When the ring buffer runs dry, the callback writes zeros mid-buffer with no fade (a click) and waits to refill 100 ms.
- If the ring ever exceeds 400 ms it drops the backlog in one go, which is an audible skip.

**[C] Why this matters.** Real-time audio rules are: never allocate, never take a lock, never wait (S13). macOS timer coalescing and App Nap throttle timers of hidden apps (S14). **[U]** Whether App Nap applies to a Tauri app that is playing audio. I did not establish it.

The library sits on a Drive File Provider volume (A7). Drive sync is exactly the kind of background load that makes a lock-contended thread late.

**[C] Apple Silicon detail for later.** Helper threads that do audio work must join the audio device's workgroup. Otherwise they can land on efficiency cores and miss deadlines (S15).

**Fix.**
- A lock-free single-producer/single-consumer ring (such as `rtrb`) between reader and callback.
- Hand EQ coefficients over by atomic swap or a triple buffer.
- Pre-allocate the recording buffer.
- A blocking read (`kqueue` or `poll`) on the FIFO instead of 2 ms sleeps.
- In the new server there is no FIFO at all (see C3).

### A6. Visualizer is ahead of the sound (MED)

**[M] Output mode.**
- The tap is taken inside the audio callback, the moment samples are handed to CoreAudio, not when they leave the device.
- cpal 0.18 supplies `info.timestamp().playback`, which "now include[s] device latency and safety offset" (S11). The app ignores it (`move |out, _|`).

**[M] Monitor mode** (MPD plays, the app only watches).
- The tap is MPD's FIFO. MPD feeds the FIFO and the OS X output at the same time.
- MPD's osx output buffers at least 100 ms before the device (`MPD_OSX_BUFFER_TIME_MS = 100` in S2), plus the device's own buffer. So the visuals lead by at least 100 ms.

**[C] Bluetooth adds more.** Measured AirPods latency (9to5Mac tests): 274 ms (1st gen), 178 ms (2nd gen), 144 ms (Pro), 126 ms (Pro 2) (S16). Rtings gives typical ranges of 150-220 ms for SBC and 120-180 ms for AAC (S17). **[U]** Whether CoreAudio reports the Bluetooth part to apps. An Apple developer-forum thread titled "Airpods actual audio latency is differ from AVAudioengine.session prediction and changes over time" suggests it does not (S18).

**[M] Anything else reading MPD's FIFO.** `mpd.conf` also has an enabled "Visualizer FIFO" at `/tmp/mpd.fifo`. It is a second timer-paced consumer with exactly the monitor-mode lead above. Whatever reads it (a terminal visualizer, `rmpc`) inherits the same lead. **[U]** I did not audit what reads it.

**[M] The analysis loop.** It is a free-running 60 Hz timer, not tied to the display. Each frame uses a 2,048-sample window (46 ms), so the picture is about 23 ms old on average. It sends frames whether or not the window is visible. **[U]** Whether frames queue up in the webview when hidden. That would show as visuals lagging after the window comes back.

**[M] Cosmetic.** The first 19 of 64 spectrum bands read only 1 or 2 FFT bins, and 11 bands read exactly the same bins as the band before. The waveform is thinned by 2 without filtering.

**Fix.**
- Delay the tap by `playback - callback` plus a per-device "visual delay" trim you can nudge (+/-500 ms), saved per device.
- Pull frames when the webview draws, not on a fixed timer.
- Compute spectra at the display's cadence.

### A7. Library on Google Drive: update storm, probing, flaky opens (MED)

**[M] Where the music is.**
- `~/Music/~~Artists~~` is a symlink to `~/Library/CloudStorage/GoogleDrive-…/My Drive/Music/~~Artists~~`. That is Drive's File Provider location. In "stream" mode, files "are primarily stored in the cloud but will be made available offline when accessed" (S19).
- I sampled 300 audio files and none was flagged `dataless` (not on disk) right now. **[U]** Whether the folder is pinned offline or Drive is in mirror mode.
- Size and mix: 18,404 songs in MPD, 18,362 audio files, **468.0 GB**, mean 25.5 MB. By type: 16,747 FLAC (91%), 1,433 MP3, 158 Ogg, 49 M4A, 14 Opus. Also 12,217 `.lrc`, 1,459 `.jpg`, 121 `.txt`, 104 `.png`, 71 `.log`, 54 `.m3u`, 53 `.cue`, 38 `.nfo`.
- No audio file is newer than the database (`find -newermt` found 0). The DB is current (last saved 2026-08-22 03:38:41).

**[M] The update storm** (`~/.cache/mpd/log`, 159 MB, 1,255,076 lines, no rotation):
- 1,220,318 lines are `update: removing …`, all cue-sheet virtual tracks (60 distinct `.cue` files).
- The hourly counts on the quiet days are exact multiples of 714 (714, 2,142, 3,570), so I read it as 714 cue tracks logged per scan. **[U]** That reading is mine.
- On that reading it is about 1,700 scans. About 1,690 of them ran between 2026-08-21 21:00 and 2026-08-22 01:00 (1,208,088 lines), roughly 7 a minute.
- 100 `exception: Update queue is full` lines, between 23:17 and 23:34.
- It stopped when the DB was saved at 03:38:41.
- A watcher script (`~/.config/mpd/watch-artists.sh`) runs `fswatch` on the Drive path and calls `mpc update` for the whole library after each quiet 10 seconds.
- **[U]** Why it ran away. A feedback loop (scanning touches files, Drive reports changes, the watcher fires again) is plausible. I did not establish it.
- **[U]** Why MPD logs the cue removals on every scan. The count per scan is constant.

**[M] Probing non-audio files.** The log has 20,508 `ffmpeg/tty`, 5,127 `ffmpeg/mpegts` (twice), 1,709 `ffmpeg/gif` and 226 `ffmpeg/lrc` lines. MPD's ffmpeg decoder tries to open lyrics, text and image files as media. MPD 0.24 made ffmpeg "query supported demuxers at runtime" (S5), which is the likely reason. On a streamed volume each probe reads file data, so it can force a download. The mechanism is **[U]**.

**[M] Flaky opens.** `Dead mechanical/Addict Rhythms/04 - Feathered Creatures.mp3` played on 08-29, then failed to open about 116 times on 08-31 and 09-02 (`mpg123: Cannot open file`). **[U]** The cause. Drive eviction or a sync in progress would fit.

**[M] A size cliff to know about.**
- The DB is 6.8 MB uncompressed (858 KB on disk). MPD caps one response at `max_output_buffer_size` = 8,192 KiB (S3).
- A full-library listing (`listallinfo`, what a naive web client asks for) would be roughly the same size as the DB text, so you are within about 20% of the cap. **[U]** I estimated this and did not run the command.

**Fix.**
- Put a root `.mpdignore` with `*.lrc`, `*.jpg`, `*.png`, `*.txt`, `*.nfo`, `*.log`, `*.pdf`, `*.sfv`, `*.m3u` in the library root (S3). **[U]** Whether the patterns apply to subfolders. Test on one album first.
- Change the watcher to `mpc update <changed path>`, with a longer quiet period (several minutes) and a lock so scans cannot stack.
- Mark the library folder "Available offline" in Drive, or keep a local copy for playback.
- Rotate the log: MPD reopens it on `SIGHUP` (S3).
- A new scanner should read headers only, whitelist audio extensions, and never open sidecar files.

### A8. Takeover leaves the speakers off if the app dies (MED)

**[M] How it works today.**
- The app writes `takeover.json` before switching outputs, then restores at exit (`outputs.rs`). That is good design.
- It only recovers at the next launch. Right now there is no `takeover.json` and the outputs are clean: FIFO on, OS X on, Headspace off (`mpc outputs`).
- MPD stores each output's on/off state in `~/.cache/mpd/state` (`audio_device_state:0:Headspace` and so on).

**[M] What happens if the app crashes** (S1 plus the state file):
- MPD keeps writing the FIFO at real-time speed into a pipe no one reads. The position advances and nothing is audible.
- If MPD restarts too, it comes back with the OS X output off. Even `rmpc` or `mpc` users get silence until the app relaunches or someone runs `mpc enable`.

**Fix.**
- A tiny launchd watchdog that re-enables the speakers when the app is not running.
- Long term, the new server owns the device and there is no takeover.

### A9. What "volume" means (MED)

**[M]**
- `mpc status` shows `volume: 97%`.
- The osx output is `mixer_type hardware`. In MPD's source that reads and writes `kAudioHardwareServiceDeviceProperty_VirtualMainVolume` on the device, which is **the macOS system volume for that device** (S2). The MPD knob moves the Mac's volume for every app.
- The Headspace FIFO output uses a software mixer. The state file records `sw_volume: 100`.
- The log's 91 mixer failures are volume changes silently failing against a stale device ID (A3).

**[U]** When the app swaps outputs, the number MPD reports comes from a different mixer, so the skin's volume slider may jump. I may not change outputs to test it. ENGINE.md D9 already notes that "with no MPD mixer it reads 0".

**Fix.** One owner of volume. In the new server, digital volume in float with dither, and the OS device volume left to the OS, shown read-only.

### A10. Ratings and play counts in a cache folder (LOW-MED)

**[M]**
- `~/.cache/mpd/sticker.sql` is 12 KB, last written Aug 16. It is nearly empty now, so nothing is at risk today.
- `~/.cache` is where cleaners and `rm -rf ~/.cache` habits look first. The database is rebuildable and sits in `~/.local/share/mpd/`.
- **[U]** Whether Time Machine includes `~/.cache`.

**Fix.** Anything you cannot regenerate (ratings, play counts, EQ choices) goes in a durable store, as an append-only event log. Key it by a stable track ID, not a file path. MPD's stickers hang off the song's path, so a rename or move would lose them. **[U]** I did not re-check that in the docs.

### A11. MPD resumes playing after a restart (LOW-MED)

**[C]** `restore_paused` defaults to `no`: "MPD is put into pause mode instead of starting playback after startup" only if set (S3).
**[M]** The state file says `state: pause` now, so you are fine today. If MPD stops while playing (crash, logout, reboot), it starts playing again at login at the saved volume.
**Fix.** `restore_paused "yes"`.

### A12. Tauri exposes too much to the page (LOW)

**[M]**
- The `mpd` command in `lib.rs` forwards any argument list to MPD, including `kill`, `update`, `add http://…`, `config` and `mount`.
- `record_stop(path)` writes a WAV to any path the page supplies.
- Tauri v2 default: "all commands that you registered in your app … are allowed to be used by all the windows and webviews of the app" unless restricted in the app manifest (S20).
- Mitigation exists. Skin scripts run in a QuickJS realm behind a membrane. The G2 review says no finding gains host capability; the host validates every op (`docs/research/realm-security-review-g2.md`). A hostile skin cannot reach these commands today.
- The exposure is: if the page code or the realm half were ever compromised, the attacker gets full MPD control and an arbitrary file write.

**Fix.** Restrict commands with an app manifest. Make `mpd` an allow-list of verbs. Confine `record_stop` to the app's data folder.

### A13. Small corrections

- **[M]** `mpc version` prints `mpd version: 0.24.0`. That is the protocol version. The daemon is 0.24.15 (`brew list --versions mpd`), and the DB header records 0.24.14.
- **[M]** `audio.rs` says MPD deletes the FIFO on every close. In MPD's source it only deletes it at shutdown, and only if MPD created it (S1). The app pre-creates the FIFO, so this is harmless. The comment is wrong.
- **[M]** The comment in `reader()` says end-of-file means "MPD closed the output (pause, stop, disable)". By the same source, MPD keeps the FIFO open the whole time it runs, so that branch should fire only when MPD exits (A5). Pause and stop show up as an empty pipe, not as end-of-file.
- **[M]** The current track's title tag (`mpc status`) contains a non-ASCII hyphen (`Yee‐Haw`: 3 bytes in UTF-8, consistent with U+2010), while its filename uses a plain `-`. A search typed with a normal hyphen would miss the tag. The new server needs search folding for dashes, quotes and accents.

---

## 3. macOS audio pitfalls, applied to this machine

| Pitfall | What happens | Applies here? | Fix |
|---|---|---|---|
| **Device switching** | Default output changes on unplug, monitor wake, Bluetooth connect. | Yes. Jack, speakers and the DELL monitor are three separate default candidates (A3). | Profile per device; pause instead of rerouting to speakers. |
| **Bluetooth: calls downgrade music** | When any app opens the headset microphone, macOS drops from A2DP to the hands-free profile and sample rate falls to 16 kHz class (S21, S22). Your EQ curve, built for the music profile, is then wrong. | Dormant: your output is the wired jack. Teams is installed (a "Microsoft Teams Audio" device is present), which is the usual trigger. | Detect rate or profile change and show a "call mode" warning. Prefer a headset with a separate mic. |
| **Bluetooth: codecs and latency** | macOS supports SBC and AAC; sources disagree on aptX; LDAC is not supported (S23). Latency 120-270 ms (A6). | Dormant. | Per-output delay, and a visual-delay trim. |
| **AirPods auto-switching** | Supported AirPods move between your Apple devices on the same Apple account. From macOS Sequoia a Mac can be switched to automatically. Setting "Connect to This Mac" to "When Last Connected to This Mac" stops it (S24). The Mac sees the device vanish. MPD logs `!obj`. cpal reroutes to speakers. | Dormant unless you use AirPods. | Set that option. Pause on device loss. |
| **Sample-rate changes** | MPD's osx output flips the device rate per track. cpal 0.18 asks for 48 kHz. Another app can change it too. | Yes (A4). | One owner for rate policy. |
| **Sleep and wake** | Streams can stop or point at stale devices after wake. I found no sleep or wake handler in cpal's CoreAudio source (not exhaustive). The 04:xx and 07:xx clusters of MPD failures could be wake events. | **[U]** | A test only you can run, since I may not touch playback: with the app in output mode and music playing, close the lid for 30 seconds, reopen, then press play. Repeat with the DELL monitor asleep. |

---

## 4. Traps for the new server

### C1. Gapless and EQ state

**[M] Today's app is fine here.** It reads one continuous stream from MPD, and `Eq` state lives across track changes. Nothing resets at a boundary. The only reset-like effect: filter state is not updated while the EQ is bypassed (`flat`), so turning the EQ back on after a long bypass resumes with stale state, a small click. **Reasoning, not measured.**

**State resets would happen in your own server if:**
- each track's decoder owns its own EQ instance;
- a track boundary changes sample rate (44.1 kHz to 96 kHz needs new coefficients, and the old state means nothing);
- a crossfade runs two decoders, each with its own EQ;
- a seek or skip jumps the waveform.

**[C]** MPD itself says crossfade only works "if both songs have the same audio format", and its code enforces it (S25). Forcing the FIFO to 44.1k/16 hides format changes from the app, which is why gapless holds today, at the cost in A4. With no forced format, a format change at a boundary makes MPD reopen the output. **[U]** that this produces a gap.

**Rule.**
- One mix bus at one fixed internal rate.
- EQ after the mix.
- Rate changes happen only at the device edge.
- Coefficient changes keep state (or run old and new for 10-20 ms and crossfade the results).
- Fade 5-10 ms on seek.

### C2. Gain staging: ReplayGain, crossfade, EQ, limiter

**[M] Today.**
- ReplayGain is off. Crossfade is 0 (state file).
- Only **8 of 167** sampled FLACs (4.8%) carry `REPLAYGAIN_TRACK_GAIN`. 1 of 14 sampled MP3s does.
- No scanner is installed (`rsgain` and `loudgain` not found).
- So turning on `replaygain "track"` today would change nothing for about 95% of the library.
- Random mode is on, so tracks from different eras play back to back.

**[C] MPD's settings.**
- `replaygain_limit` is on by default and "will use the peak from the ReplayGain tags to minimize clipping".
- `replay_gain_handler` defaults to `software`. The `mixer` option would move your system volume per track.
- `replaygain_preamp` is -15 to +15 dB (S3).
- MPD 0.24.15 "fix noise with replay gain and cross-fade" (S5). You have 0.24.15.

**Interplay.**
- MPD applies ReplayGain in its per-output chain, before the FIFO. The app's EQ preamp is separate and blind to it.
- Positive ReplayGain plus an EQ boost stacks on a track that was already near full scale. MPD's limit knows the track's peak, not the EQ's boost.

**Rule for the new server, one chain:** per-track gain, then crossfade mix, then EQ with auto-preamp, then true-peak limiter, then volume, then dither.
- Per-track gain goes before the mix, so crossfading a loud track into a quiet one does not jump.
- EQ and limiter go after the mix, so there is only one EQ instance.

**Warning about doing it in place.** Writing ReplayGain tags into files on Drive changes the files on a synced volume. **[U]** how much sync traffic that causes. Storing loudness in the server's own database, keyed by audio identity (C5), avoids touching the files.

### C3. Real-time safety in a garbage-collected runtime (BEAM/Elixir)

**[C] Good news.** Erlang garbage collection is per process: "a per process generational semi-space copying collector", with no global stop-the-world pause in the docs (S26).

**[C] Bad news.** BEAM is soft real-time, not hard real-time.
- Native functions should return "within 1 millisecond"; longer ones "degrade responsiveness of the VM" and cause "bad load balancing between schedulers".
- Dirty schedulers exist, but misclassifying CPU work "might starve ordinary schedulers" (S27).
- The audio callback has a hard deadline measured in microseconds to a few milliseconds.

**[C] Rules for any audio callback:** do not allocate, do not lock a mutex, do not wait on anything unpredictable (S13).

**Design.**
- The audio thread is native code (C, Rust, or Orgiac-generated C) with a lock-free ring buffer in and an atomic parameter mailbox.
- BEAM decides and sends control messages. It never touches samples in the callback.
- Join helper threads to the device's audio workgroup on Apple Silicon (S15).
- If Orgiac compiles to C, the risk moves into the generated C: any `malloc`, `free`, lock or `printf` in a generated callback is a bug. The compiler needs an "audio-safe" mode that rejects them. **[U]** that Orgiac has no such check today. I did not read it.
- **[U]** Denormal slowdowns on Apple Silicon. I did not research them.
- The webview's JavaScript runtime is also garbage-collected, but it is visual only and not in the audio path today. Keep it that way.

### C4. Clock drift across multiple outputs

**[M] MPD facts** (source):
- The FIFO output paces itself with a software timer (S1).
- The osx output is pulled by CoreAudio from a 100 ms ring (S2).
- All outputs are fed from one stream. I found no per-output resampling or delay compensation in MPD's docs. **[U]** (absence of evidence).

**[S] Arithmetic.** Two clocks 50 ppm apart drift 3 ms a minute, 180 ms an hour. Bluetooth sets add a fixed 126-274 ms (S16).

**[M] The app's drift control.** A proportional controller trims the resample ratio by at most 0.2% (about 3.5 cents), holding a 100 ms ring. That is sound for one device.

**[C] How multi-room systems do it.** Snapcast timestamps every chunk with server time, keeps each client's clock synchronised, and corrects "by removing/duplicating single samples"; "typically the deviation is below 0.2 ms" (S28).

**Design.**
- Each output is its own clock domain.
- Adaptive resampling per output (better sounding than dropping samples).
- Timestamps carried in the stream.
- A fixed per-output delay setting for Bluetooth and AirPlay-class devices.

### C5. Licensing

**[M] What you run today.**
- MPD is GPL: `COPYING` is GPL v2, source headers say `GPL-2.0-or-later` (S29).
- The local `mpd` links ffmpeg, libsoxr, libsamplerate, faad2, mpg123, lame, libsndfile, fluidsynth, game-music-emu and libmikmod (`otool -L`).
- The local FFmpeg 9.0.2 is configured `--enable-gpl --enable-version3` with x264 and x265.
- Today's boundary is clean. The app talks to MPD over TCP and links none of it.

**Traps for the new server.**
- **Porting MPD code** into Elixir, Orgiac or C, even translated, makes a derivative work under GPL. Reimplementing the protocol from its documentation is a different thing. **[U]** I am not a lawyer. Get one opinion before shipping.
- **Linking Homebrew's FFmpeg** drags in GPLv3. FFmpeg is LGPL only if built without `--enable-gpl` and `--enable-nonfree`, and linked dynamically, with source and build config shipped (S30).
- **You may not need FFmpeg.** Your library is 91% FLAC and 8% MP3. MP3 patents are expired (the last US one on 2017-04-16; European ones in 2012) (S31). **[U]** Apple's AudioToolbox should be able to decode AAC and ALAC on macOS without you shipping a codec. The libFLAC and mpg123 licenses, the AAC patent position, and Dolby and DTS licensing were not checked or researched.
- **Winamp.** The 2024 source release used the Winamp Collaborative License v1.0.1, which prohibits distributing modified versions. It also contained third-party proprietary code (Dolby, Fraunhofer, Microsoft) and was pulled in October 2024 (S32). Do not read or copy it. "Winamp" is a trademark: **[U]** who holds it, check before using the name.
- **Microsoft skin art.** The skins carry "(C) Microsoft Corporation. All rights reserved." strings (`wmploc-library.md` line 269). Keep them out of any public repo or release. I did not audit `skins/`.
- **Equalizer APO.** The configuration reference I read states no license (S10). **[U]** Treat its code as GPL-possible and do not copy it. The config format is a documented convention you may read and write.
- **AutoEq and measurement data** licensing: not researched. **[U]**

### C6. Content-addressed blobs and library scale

**[M] Scale today.**
- 468.0 GB across 18,362 audio files (mean 25.5 MB).
- The database is 6.8 MB uncompressed.
- Hashing every byte once is a few minutes of compute on this SSD. Here every byte also has to be on disk, and the library is on a Drive volume (A7).
- 18k songs is small. Scale is not the problem. The 8 MiB response cap (A7) and the scanner's probing are.

**[C] FLAC already carries an identity.** STREAMINFO has "MD5 checksum of the unencoded audio data", and zero "signifies that the value is not known" (S33). That gives you audio identity for 91% of the library by reading a header, with no hashing. MP3 and the rest have no such field.

**Trap.** A whole-file hash changes when you fix a tag, so ratings, plays and EQ settings tied to it vanish. Use two IDs: an audio identity (the decoded-audio hash, or STREAMINFO MD5) and a stable track ID that survives retagging.

**Trap.** Scanners must not open sidecar files (A7). Search must fold dashes, quotes and accents (A13).

### C7. "Formally verified" EQ math: what the proof has to cover

**[S]** The measured numbers above say where the real errors are:
- **Arithmetic model.** A proof about real numbers does not cover float32, which cost 68-74 dB of SNR in the app's form (A4). The spec must name the number format and the filter structure.
- **Time-varying filters.** Slider moves change coefficients while state is live. Proofs of a fixed filter do not cover stability or clicks during changes.
- **Nonlinear stages.** A limiter or clipper breaks the linear model (A2).
- **Sample-rate dependence.** Equalizer APO notes IIR coefficients are "normally dependent on the sample rate" (S10). The spec must say which rate and which warping.
- **Plumbing.** The audible bugs found in this audit (device changes, drift, dropouts, headroom) are all outside the biquad.

---

## 5. Checked and fine

- **Gapless in the current app.** One continuous stream, EQ state preserved across tracks (C1).
- **Default-device reroute.** cpal 0.18.2 follows the system default. The remaining gap is that the app ignores the notice (A3).
- **MPD version.** 0.24.15, past the four May 2026 CVEs (A1).
- **Database freshness.** No audio file is newer than the DB (A7).
- **Visualizer tap position.** Taken after the EQ, so it matches what is played (modulo latency, A6).
- **Takeover design.** Records before it changes, restores on clean exit (A8).
- **Right now.** No stale `takeover.json`. Outputs: FIFO on, OS X on, Headspace off.
- **ReplayGain and crossfade interplay.** Both off today, so none yet (C2).

## 6. Questions for the owner

1. Which headphones: the 3.5 mm jack ("External Headphones" is the default now), USB, or Bluetooth/AirPods? This sets how much of section 3 matters.
2. Is the Drive library in stream or mirror mode, and is `Music` pinned offline?
3. Is the open MPD port intentional (phone control, other rooms)? If so, what connects to it, and from where?
4. Which headphone measurement profile will you use? Its preamp value should travel with it.

---

## Sources

- S1. MPD FIFO output plugin source (`EAGAIN` empties the pipe; software timer; created/deleted only if MPD made the file): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/output/plugins/FifoOutputPlugin.cxx
- S2. MPD OS X output plugin source (device ID read at create; volume via `VirtualMainVolume`; `osx_output_set_device_format`; `MPD_OSX_BUFFER_TIME_MS = 100`; `hog_device`): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/output/plugins/OSXOutputPlugin.cxx
- S3. MPD user manual (bind address default "any", permissions, clear-text passwords, `max_output_buffer_size` 8192, `restore_paused`, replay gain settings, `.mpdignore`, `SIGHUP` log reopen, crossfade format rule): https://mpd.readthedocs.io/en/latest/user.html
- S4. MPD plugin reference (resamplers, FIFO and OS X output notes): https://mpd.readthedocs.io/en/latest/plugins.html
- S5. MPD NEWS (0.24.1 osx fixes, 0.24.11 path traversal, 0.24.15 replay gain plus crossfade noise, 0.24 ffmpeg demuxer query, 0.24.16 hardening): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/NEWS
- S6. MPD vulnerability list (May 2026): https://vuln.today/tag/mpd
- S7. CVE-2026-49127 (SUSE): https://www.suse.com/security/cve/CVE-2026-49127/
- S8. CVE-2026-49129 (Mondoo): https://mondoo.com/vulnerability-intelligence/vulnerability/CVE-2026-49129
- S9. Inter-protocol exploitation (general class): https://en.wikipedia.org/wiki/Inter-protocol_exploitation
- S10. Equalizer APO configuration reference (Preamp; rate-dependent coefficients; no license stated): https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
- S11. cpal changelog (0.18.0 default-device reroute, `DeviceChanged`, timestamps with latency, 48 kHz preference): https://raw.githubusercontent.com/RustAudio/cpal/master/CHANGELOG.md, plus cpal 0.18.2 source read from the local cargo registry (`src/host/coreaudio/macos/mod.rs`, `device.rs`), crate page https://crates.io/crates/cpal/0.18.2
- S12. MPD 16-bit dithering: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/pcm/Dither.cxx (the `PcmDither` class) and https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/pcm/FormatConverter.cxx (calls `pcm_convert_to_16(buffer, dither, ...)`)
- S13. Bencina, "Real-time audio programming 101: time waits for nothing" (the page was unreachable when I fetched it; the "don't allocate memory, don't lock a mutex" rules are from search excerpts): http://www.rossbencina.com/code/real-time-audio-programming-101-time-waits-for-nothing
- S14. Apple power efficiency (timer coalescing, App Nap), found by search and not fetched: https://www.apple.com/media/us/osx/2013/docs/OSX_Power_Efficiency_Technology_Overview.pdf
- S15. Apple audio workgroups: https://developer.apple.com/documentation/audiotoolbox/workgroup-management and forum thread https://developer.apple.com/forums/thread/747754
- S16. AirPods latency tests (9to5Mac): https://9to5mac.com/2019/12/22/airpods-latency-test/ and https://9to5mac.com/2022/11/15/airpods-pro-2-latency-test/
- S17. Bluetooth codec latency (Rtings): https://www.rtings.com/headphones/learn/latency
- S18. Apple Developer Forums, AirPods latency vs AVAudioEngine prediction: https://developer.apple.com/forums/thread/679274 (title only, from search)
- S19. Google Drive for desktop, stream vs mirror: https://support.google.com/drive/answer/13401938
- S20. Tauri v2 capabilities (all registered commands allowed to all windows by default): https://v2.tauri.app/security/capabilities/
- S21. Why Bluetooth sound quality drops on Mac when a mic is active: https://mjtsai.com/blog/2023/12/13/why-is-bluetooth-sound-quality-bad-on-my-mac
- S22. Hands-free profile codecs and rates (8/16/24 kHz): search summaries of https://www.gigazine.net/gsc_news/en/20231213-mac-bluetooth-sound-quality and https://swissmacuser.ch/?p=9309. **[U]** I did not fetch these.
- S23. macOS Bluetooth codec support (SBC, AAC; aptX disputed; no LDAC): https://9to5mac.com/guides/aptx/ and https://github.com/orgs/Homebrew/discussions/2606 (from search)
- S24. Apple, switch AirPods between devices: https://support.apple.com/104988
- S25. MPD crossfade code (`CanCrossFade`, same-format rule): https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/player/CrossFade.cxx
- S26. Erlang garbage collection: https://www.erlang.org/doc/apps/erts/garbagecollection.html
- S27. Erlang NIF guidance: https://www.erlang.org/doc/apps/erts/erl_nif.html
- S28. Snapcast: https://github.com/badaix/snapcast
- S29. MPD license: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/COPYING
- S30. FFmpeg legal: https://www.ffmpeg.org/legal.html
- S31. MP3 patent expiry: https://512pixels.net/2017/05/the-mp3-isnt-dead/ and https://gigazine.net/gsc_news/en/20170502-mp3-licensing-program-finished
- S32. Winamp source license: https://hackster.io/news/llama-group-releases-the-winamp-source-code-but-beware-its-restrictive-license-189e1b933c42 and https://www.gigazine.net/gsc_news/en/20241017-winamp-source-codes-deletes
- S33. FLAC STREAMINFO MD5 (RFC 9639 section 8.2): https://datatracker.ietf.org/doc/rfc9639

**Local evidence** (all read-only): `/opt/homebrew/etc/mpd.conf`; `~/.cache/mpd/{log,state,sticker.sql}`; `~/.local/share/mpd/database`; `~/.config/mpd/watch-artists.sh`; `~/git/window_headMPD/src-tauri/src/{audio,eq,mpd,outputs,lib}.rs` and `Cargo.lock`; `docs/research/{realm-security-review-g2,wmploc-library}.md`. Commands: `lsof`, `socketfilterfw`, `system_profiler SPAudioDataType`, `otool -L`, `ffmpeg -version`, `metaflac`, `ffprobe`, `find`, `stat`, `mpc version/outputs/status/stats`. Simulation scripts (`eqsim.py`, `rssim2.py`, `f32.py`, `pipecap.py`) and downloaded MPD sources are in `/tmp/msr-hidden-problems/`.
