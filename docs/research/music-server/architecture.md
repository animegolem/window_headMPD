# Architecture of a C API that replaces MPD

Date: 2026-10-07
Lane: ARCHITECTURE OF A C API THAT REPLACES MPD (music-server research)
Status: research draft. Nothing in this file was built; nothing outside this file and `/tmp/msr-architecture/` was written. MPD was never started, stopped or commanded (only `mpc version`, `mpc stats`, `mpc status`, `mpc outputs` were run).

## How to read this

- **Measured** means I read it from this machine or from a primary source today (2026-10-07). The path or URL is given.
- **Recommendation** means my judgment. It is never presented as a fact.
- **UNCONFIRMED** means I looked and could not confirm it. Treat it as a question.
- External claims carry a source tag like [S4]; the URL list is at the end. Local facts carry `path:line`.
- Where the working name is needed I use "the server" and the C prefix `ad_` (for "audio daemon"). Both are placeholders; naming is the owner's call.

---

## 1. Bottom line

1. **Shape.** One long-lived process, the server, owns the sound card, the queue and the player state. Everything else is a client of the same C API: the Tauri app (in-process or over a socket), an MPD-protocol shim so rmpc, mpc, nowplayd and window_headMPD keep working, and later the Elixir/BEAM layer. This is the same split MPD already has (daemon holds state, clients come and go), so no behaviour the owner relies on is lost.
2. **The audio path is the product.** The server decodes at the file's native rate and depth, runs the EQ in floating point, and hands the result to CoreAudio itself. Today's EQ path cannot do that (section 2).
3. **Real-time rules are non-negotiable.** The device callback never allocates, never takes a lock, never touches a file or socket. MPD's own macOS output already follows this rule; the owner's current app does not (sections 4 and 2.2).
4. **Language decision (owner's call, recommendation given).** The audio kernel (filters, gain, ring buffer, parameter hand-off) is plain, allocation-free C from day one, because that is the shape both a formal verifier and a later Orgiac-to-C re-emission want. The C ABI is the contract. The rest may be C too (my recommendation) or a Rust shell (the named alternative). Section 15.
5. **Library.** A derived, disposable index (rebuilt from files) plus signed claims keyed by SHA-256. Bootstrap from MPD's existing database file instead of rescanning. Do not copy 439 GB (section 12).
6. **MPD shim.** The minimum command list is measured from the owner's own tools (section 13.3).
7. **BEAM.** The server is a separate OS process. Elixir talks to it over a Unix socket, supervised as a Port. No NIFs anywhere near audio (section 14).
8. **First slice runs beside MPD on another port**, so the existing setup is never at risk during the build (section 16).

---

## 2. Why MPD is the wrong shape here (measured on this machine)

Each item below is a fact from this machine and the requirement it creates.

### 2.1 Today the EQ'd path truncates high-resolution files

**Measured.**
- `/opt/homebrew/etc/mpd.conf` defines the "Headspace" output as a FIFO with `format "44100:16:2"`. The app hard-codes the same: `~/git/window_headMPD/src-tauri/src/audio.rs:31` (`IN_RATE = 44100.0`).
- I read the FLAC STREAMINFO header of a random 3,000-file sample (2,997 readable) of the 16,747 FLAC files in `~/Music/~~Artists~~` (script in `/tmp/msr-architecture/flacinfo.py`, run with `python3 -I`):

| Rate / depth | Share of sample |
|---|---|
| 44.1 kHz / 16 bit | 85.2% |
| 44.1 kHz / 24 bit | 6.5% |
| 96 kHz / 24 bit | 4.8% |
| 48 kHz / 24 bit | 2.2% |
| 88.2 kHz / 24 bit | 0.9% |
| 192 kHz / 24 bit | 0.3% |
| 48 kHz / 16 bit | 0.1% |

  So 14.7% are 24-bit and about 6.0% are 88.2 kHz or higher. Roughly one FLAC in seven (about 2,500 files, extrapolated from the sample) is something other than 44.1/16.
- MPD's other output, "OS X Output", has no format forced, and MPD's macOS plugin sets the device's physical format to match the music (`OSXOutputPlugin.cxx`, `osx_output_set_device_format`, around lines 352-431 of the file I downloaded) [S4]. So listening through MPD's own output keeps full quality but has no EQ; listening through the app's EQ means MPD converts to 44.1/16 first.
- How MPD converts is UNCONFIRMED. `mpd.conf` names no resampler; MPD's manual says the built-in resampler is "very poor" and libsamplerate defaults to interpolator type 2 [S2]. Which one this Homebrew build picks I did not determine.

**Requirement.** EQ and full resolution must coexist: decode natively, filter in float, convert once at the very end.

### 2.2 The current app fights two clocks and locks inside the audio callback

**Measured.** (`~/git/window_headMPD/src-tauri/src/audio.rs`)
- MPD's clock and the sound card's clock are independent. The file header says so (lines 8-11). The output callback therefore nudges the resampling ratio by up to 0.2% to hold the ring near 100 ms (`:309`, `step = base_step * (1.0 + 0.002 * err)`; `TARGET_FRAMES = 4410` at `:35`). 0.2% is about 3.5 cents of pitch (computed: 1200 x log2(1.002)).
- The resampler is 4-point Catmull-Rom cubic interpolation (`:351`). Its quality has not been measured.
- Inside the cpal output callback (`:296-345`) the code takes `engine.ring.lock()` (`:297`), `engine.eq.lock()` (`:310`), `record()` which locks `rec` (`:127`), and `push_tap()` which locks `tap` (`:258`). A UI thread holding the EQ lock while the callback needs it is a textbook priority inversion. I read no glitch reports, so this may never have bitten; it is still the pattern the real-time rules forbid (section 4).
- Only two channels are rendered; channels 3 and up are zeroed (`:333`).
- The output opens `device.default_output_config()` (`:276`) and takes whatever rate the system is at. There is no rate switching and no device-lost handling beyond a printed stream error (`:341`).

**Requirement.** Make the sound card the only clock; drive decoding from ring fill level; no ratio nudging; no locks in the callback.

### 2.3 MPD's macOS output is blind to the device changing

**Measured.**
- `mpd.log` (`~/.cache/mpd/log`, 159 MB) carries 216 lines with OSStatus 560947818. In hex that is `0x216F626A`, the four characters `'!obj'` (checked with Python: `bytes.fromhex('216f626a') == b'!obj'`), which I read as CoreAudio's "bad object" error. Distribution by date: 2026-08-20 (49), 2026-08-21 (6), 2026-08-22 (136), 2026-09-08 (25).
- It shows up as 91 failed hardware-mixer sets (each logged twice, 182 lines; read failures appear too) and 32 failed opens of "OS X Output". `mpd.conf` sets `mixer_type "hardware"` on that output.
- In MPD's source, `OSXOutput::Create` looks up the default output device once and stores the ID (`osx.cxx:175-184`, field `dev_id` at `:86`), and I found no device-alive or property-listener call anywhere in that file (grep for `DeviceIsAlive`, `PropertyListener`, `AddPropertyListener` returned nothing) [S4].
- That the stale device ID is the cause of the `'!obj'` lines is UNCONFIRMED. It is consistent with the source.
- `system_profiler SPAudioDataType` on this machine lists outputs: **External Headphones** (built-in, 44,100 Hz, default output), MacBook Pro Speakers (built-in, 44,100), and DELL S2725QC (DisplayPort, 48,000). So the owner's headphones are on the built-in jack, a wired analog route. Which of the three the owner treats as primary day to day is not knowable from files.

**Requirement.** The server must re-resolve its device and react when it disappears, reappears, or changes route (jack plugged or unplugged), and it must key EQ profiles to the route so a headphone correction never lands on the speakers. The CoreAudio header offers what is needed: `kAudioDevicePropertyDeviceUID`, `...DeviceIsAlive`, `...JackIsConnected`, `...DataSource(s)`, `...TransportType` [S9]. How macOS 27 exposes the jack switch (separate device versus a data-source change on one device) is UNCONFIRMED; `system_profiler` lists two entries but that is a display, not the API.

### 2.4 The library lives in Google Drive, and cue sheets churn the updater

**Measured.**
- `~/Music/~~Artists~~` is a symlink to `~/Library/CloudStorage/GoogleDrive-<account>/My Drive/Music/~~Artists~~` (`ls -l`).
- The library holds 18,404 songs, 1,468 albums, 1,092 artists, 439 GB (`mpc stats`; `du -shL`). By extension (case-folded, files only): 16,747 flac, 1,433 mp3, 158 ogg, 49 m4a, 14 opus, plus 12,217 lrc, 1,459 jpg, 53 cue, 54 m3u.
- In a 2,000-file random sample of audio files, none had the macOS "dataless" flag (`st_flags & SF_DATALESS`) and none had zero allocated blocks, so the files are physically present locally; Drive is mirroring, not streaming, at the moment I looked.
- MPD logged 289 `Failed to open "..." Operation not permitted` exceptions, in bursts between 2026-08-31 and 2026-09-06 (512 lines mention the error). The cause is UNCONFIRMED. macOS privacy permission for a background daemon and the cloud file provider are both plausible.
- On 2026-08-21 the log has 1,000,669 lines; 974,610 of them (97%) are `update:` lines, overwhelmingly `update: removing .../<album>.cue/trackNN` (the eight most frequent message classes that day were all of this kind). That is MPD's database updater repeatedly removing the virtual tracks of cue sheets. The same day the ffmpeg decoder probed non-audio files (`.lrc`, `.txt`) and printed format-detection warnings (for example 16,388 "Format tty detected only with low score").

**Requirement.** The scanner must (a) treat a cue sheet as first-class (stable identity for each virtual track), (b) only open files whose extension and magic bytes say "audio", (c) never force a cloud download (check the dataless flag before reading), and (d) run as a properly identified app bundle so macOS privacy prompts attach to it. nowplayd already ships as a launchd-loaded `.app` for the same class of reason (`~/git/nowplayd/README.md`, "installer builds a release LSUIElement bundle").

### 2.5 What the owner's own tools need from a server

**Measured.** From source (not from traffic):
- window_headMPD front end (`~/git/window_headMPD/src/player.js:66-123`): `status`, `currentsong`, `playlistinfo`, `listplaylists`, `listplaylistinfo`, `play [pos]`, `pause 0|1`, `stop`, `next`, `previous`, `seekcur`, `setvol`, `clear`, `load`. Rust side: `idle` (`lib.rs:70`), `outputs`, `enableoutput`, `disableoutput` (`outputs.rs`), `readpicture`, `albumart`, `binarylimit`, plus a remote-control channel: `subscribe window_head` and `readmessages` when `idle` reports `message` (`lib.rs:68-80`, driven by `mpc sendmessage window_head demo`). Address from `MPD_HOST`/`MPD_PORT` (`mpd.rs:15-18`).
- nowplayd (`~/git/nowplayd/src/mpd/`): `idle` on `player mixer options`, `status`, `currentsong`, `play`, `pause`, `stop`, `next`, `previous`, `ping`, `password`, `readpicture`, `albumart`; address from `NOWPLAYD_MPD_ADDRESS` (tcp:// or unix://). It also documents MPD's 60-second idle connection timeout as a design input (`SPEC.org`).
- rmpc: the TUI client the owner runs. Its command surface is UNCONFIRMED. rmpc's README requirement (via RMPC-Auto-Theme) is album art through `readpicture` or `albumart` [`~/git/RMPC-Auto-Theme/README.md`]; its site did not state protocol requirements [S33].
- MPD state file (`~/.cache/mpd/state`) holds exactly: `sw_volume`, one `audio_device_state:<0|1>:<name>` per output, `state`, `current`, `time`, `random`, `repeat`, `single`, `consume`, `crossfade`, `mixrampdb`, `mixrampdelay`, `lastloadedplaylist`, then `playlist_begin` with the queue as `<pos>:<path>` lines. The sticker file is 12 KB with 0 rows; `~/.config/mpd/playlists` is empty or absent.

**Requirement.** The shim's first list is short and known. rmpc's surface is a measurement step (section 13.3), not a guess.

---

## 3. Core objects

The server has six core objects. Each has one owner thread, one persisted shape, and one event bit.

| Object | What it is | Owner-visible behaviour | Persisted? |
|---|---|---|---|
| **Library** | Index of tracks: path, size, mtime, content hash, tags, durations, cue tracks, loudness. Disposable and rebuildable (section 12). | Browse, search, album art, "what is this file". | Index: yes (derived). Claims: yes (source of truth). |
| **Queue** | Ordered list of queue items. Each item gets an id that is never reused during a run (MPD's `songid`). | Add, remove, move, shuffle; random/repeat/single/consume flags. | Yes, exactly like MPD's `playlist_begin` block. |
| **Player** | The state machine below. Owns "what is playing and where". | Play, pause, stop, seek, next, previous; elapsed time. | The fields in the MPD state file (2.5). |
| **Outputs** | Named routes to a device (built-in jack, DisplayPort, a recorder, a tap). Each has its own DSP graph instance. | Enable/disable, exclusive mode, rate policy, volume. | Name, enabled flag, options. |
| **DSP graph** | The chain between decoded audio and the device: input convert, preamp, filters, balance, volume, limiter, final convert. Per output. | EQ presets, headphone profile, bypass. | The parameter set, keyed by output route. |
| **Events** | One bitmask of "what changed", delivered through one file descriptor. | Clients wake up and re-read what they care about. | No. |

### 3.1 Player state machine

Three public states (stop, play, pause), with internal sub-states that clients never need to see but the engine must have.

| State | Event | Next | What happens |
|---|---|---|---|
| stop | play(item) | play/opening | Resolve item; open decoder; open or reuse output; prebuffer. |
| play/opening | ring above start threshold | play/running | Start device callback. |
| play/opening | decoder or device error | stop | Raise `player` event with the error text; no retry loop on the same item. |
| play/running | pause | pause | Fade to zero over a few ms inside the graph, then stop the callback or output silence; keep decoder and ring. |
| play/running | seek(t) | play/seeking | Flush ring, reposition decoder, refill, resume. Position clock restarts from t. |
| play/running | current item ends, next ready | play/running (next) | Gapless hand-off (section 8): no state change visible to clients except `player`. |
| play/running | device lost | play/stalled | Queue and position kept; raise `output` event; try re-resolving the device on a timer and on device-list changes; resume at the saved frame on success. |
| play/stalled | device back | play/opening | Reopen and continue. |
| pause | play | play/running | Resume. If the device was released for being idle, reopen it first. |
| any | stop | stop | Fade, flush, close decoder; output idle-release timer starts (section 5.1). |

**Clock rule (Recommendation).** Playback position is counted in frames the device callback has actually consumed. The status snapshot publishes (frames consumed, host time) so clients can interpolate. This replaces the present arrangement where the front end extrapolates elapsed time (`ENGINE.md:1572-1579`, `MediaState.elapsed` "elapsed extrapolated").

### 3.2 Events

**Recommendation.** One 32-bit mask. Bits 0 to 13 are MPD's 14 `idle` subsystem names, in this order: `database`, `update`, `stored_playlist`, `playlist`, `player`, `mixer`, `output`, `options`, `partition`, `sticker`, `subscription`, `message`, `neighbor`, `mount` [S3]. Native-only bits follow: `device_lost`, `dsp`, `tap_overflow`, `claim`. The shim then maps bit to string with a table lookup and no logic. Events are delivered by reading one file descriptor (poll/kqueue friendly), never by calling back into client code from any server thread.

### 3.3 The C API (sketch, signatures only)

The sketch shows the shape and the rules, not a finished header.

```c
/* audiod.h -- working name, sketch only. All functions are thread-safe unless noted.
   No function here may be called from, and none calls back on, an audio thread. */
#define AD_ABI_VERSION 1                       /* bumped only on incompatible change */
typedef struct ad_server ad_server;            /* opaque; one engine instance            */
typedef uint64_t ad_id;                        /* item/output/filter ids, never reused   */
typedef int ad_status;                         /* 0 ok, negative = AD_E_* (stable codes) */

/* Every struct a caller fills or reads starts with `uint32_t struct_size`, so old
   callers keep working against a newer server and vice versa. */
ad_status ad_open (const ad_config *cfg, ad_server **out);
void      ad_close(ad_server *);

/* Events: one fd to poll; take() returns and clears the bitmask. */
int       ad_event_fd(ad_server *);
uint32_t  ad_events_take(ad_server *);

/* Player and queue. */
ad_status ad_play  (ad_server *, ad_id item_or_0);
ad_status ad_pause (ad_server *, int on);
ad_status ad_stop  (ad_server *);
ad_status ad_seek  (ad_server *, double seconds);
ad_status ad_queue_add(ad_server *, const char *uri, ad_id after, ad_id *new_id);
ad_status ad_player_snapshot(ad_server *, ad_player_snapshot *out);   /* plain struct copy */

/* Outputs: options are data (device uid, enabled, exclusive, rate policy, volume). */
ad_status ad_outputs_list(ad_server *, ad_output_info *buf, size_t *count);
ad_status ad_output_configure(ad_server *, ad_id output, const ad_output_opts *);

/* DSP: the whole parameter set is applied atomically, per output route. */
ad_status ad_dsp_set(ad_server *, ad_id output, const ad_dsp_params *);
ad_status ad_dsp_get(ad_server *, ad_id output, ad_dsp_params *out);

/* PCM tap: lossy by design (overwrite ring); the reader sees gaps via frame index. */
ad_status ad_tap_open(ad_server *, ad_tap_point where, ad_tap **out);
size_t    ad_tap_read(ad_tap *, float *dst, size_t frames, uint64_t *first_frame_index);

/* Library: queries return snapshots; mutation goes through claims. */
ad_status ad_library_query(ad_server *, const ad_query *, ad_result **out);
void      ad_result_free(ad_result *);
```

ABI rules (Recommendation):
1. Opaque handles and plain structs only; no C++ types, no exceptions across the boundary.
2. Every struct that crosses the boundary begins with its own size; new fields are appended.
3. Error codes are stable integers plus an `ad_strerror`.
4. Memory a function returns is freed by a matching `_free` from the same library.
5. No client callback ever runs on an audio or decode thread. Events go through the fd.
6. The ABI version is checked at `ad_open`.

---

## 4. Real-time audio rules

### 4.1 The rules

**Measured sources for the rule itself.**
- MPD's macOS render callback carries this comment: "This function (the 'render callback' osx_render) is called by the OS X audio subsystem (CoreAudio) to request audio data ... This function has hard time constraints so it cannot do IO (debug statements) or memory allocations." It reads from a ring buffer and nothing else (`osx.cxx:582-603`) [S4].
- The ring it reads is MPD's `RingBuffer`, documented in its header as "A thread-safe (single-producer, single-consumer; lock-free" and built on `std::atomic_size_t` read/write positions (`RingBuffer.hxx:13,25`) [S5].
- CoreAudio's own header marks the device callback types with `CA_REALTIME_API` (`AudioHardware.h:793,836`) [S9].
- Apple's docs say real-time threads that render to the same deadline should join the device's audio workgroup (`os_workgroup_join`), obtained from the I/O audio unit or from the HAL; the device property is `kAudioDevicePropertyIOThreadOSWorkgroup` (`AudioHardware.h:1027`) [S7][S8][S9].

**Recommendation: the ten rules for the device callback.**
1. No allocation or free. Everything it touches is allocated before the stream starts.
2. No locks of any kind (mutex, read-write lock, `Mutex` guard, `@synchronized`). A try-lock that falls back to silence is still a lock; do not use it.
3. No system calls: no file, socket, `printf`, logging, `sleep`, `pthread_cond_wait`.
4. Bounded work: a fixed number of frames per call, no loops whose length depends on data.
5. Parameter changes arrive only through a small single-producer ring of fixed-size commands or an atomically swapped pointer to an immutable parameter block (4.4).
6. Memory behind an old parameter block is freed by the control thread after the callback acknowledges the swap by a generation counter, never by the callback.
7. Denormal numbers are flushed to zero at callback entry (practice; verify with a test tone fading to silence and a CPU-time trace).
8. Underrun policy: output silence for the missing frames, increment a counter, set an event bit, never wait.
9. The callback never calls the public C API, and no public C API call blocks on the callback.
10. On macOS the thread joins the device workgroup once, and leaves it before the stream is destroyed.

### 4.2 Thread map

| Thread | Priority class | May allocate / lock? | Job |
|---|---|---|---|
| Device callback (CoreAudio I/O thread) | System real-time (CoreAudio creates it; we do not make our own on macOS) | No / No | Pull from decode ring; run DSP graph; write the device buffer; copy post-DSP frames to the tap ring; bump the frame counter. |
| Decode (one active, one preparing the next track) | Elevated, not real-time (a high QoS class; verify with an underrun counter) | Yes (bounded) / Yes, but never while holding a lock the callback needs | Read file, decode, convert to float, resample if needed, fill the decode ring to a high-water mark. |
| Control (one) | Normal | Yes / Yes | Owns queue, player state machine, outputs, persistence, API calls, event mask. |
| Library worker(s) | Background | Yes / Yes | Scan, hash, probe tags, loudness analysis. |
| Net (one or few) | Normal | Yes / Yes | Native socket and MPD shim; translates bytes to API calls. |
| Analysis (optional, may live in a client) | Normal | Yes / Yes | FFT and band reduction for visualisers (section 11). |

### 4.3 Rings

| Ring | From to | Kind | Size (Recommendation) | If full or empty |
|---|---|---|---|---|
| Decode ring | decode to callback | SPSC float frames | About 250 ms at the output rate (MPD uses 100 ms on macOS, `osx.cxx:41`) [S4] | Empty: silence plus underrun count. Full: decode thread waits. |
| Command ring | control to callback | SPSC, fixed-size records | A few hundred records | Full: control thread retries; never blocks the callback. |
| Event ring | callback to control | SPSC, fixed-size records | A few hundred records | Full: drop oldest, set an overflow bit. |
| Tap ring | callback to any reader | SPSC, overwrite | 1-2 seconds of frames | Reader behind: it sees a jump in frame index. The callback never waits. |

### 4.4 Changing a filter while music plays

**Recommendation.** The control thread builds a complete new parameter block (all biquad coefficients for all stages, gains, a generation number) and publishes it with one atomic pointer store. The callback loads the pointer once per call and cross-fades from the old coefficients to the new over a fixed short ramp (for example 10-20 ms) to avoid zipper noise. A parameter block is immutable once published. This is the pattern that lets the same code be proven correct as a pure function of (state, block, input).

### 4.5 What not to carry forward from `audio.rs`

The locks at `:297`, `:310`, `:127`, `:258`; the `VecDeque` as the ring; the ratio nudge at `:309`; the fixed 44.1 kHz input; the two-channel limit. The structure that is worth keeping: the 64-band, 2048-point analysis (`audio.rs:38-41`) as a client-side or optional module, and `eq.rs`'s coefficient math as the first reference implementation (section 10).

---

## 5. Output backends

### 5.1 CoreAudio (first-party)

**Measured.**
- MPD does exclusive mode and format switching in one file of 837 lines (`OSXOutputPlugin.cxx`) [S4]: `hog_device` option via `kAudioDevicePropertyHogMode` (`osx_output_hog_device`, `:464-500`); format switching via `kAudioStreamPropertyAvailablePhysicalFormats` and `kAudioStreamPropertyPhysicalFormat` (`osx_output_set_device_format`, `:352-431`); buffer size set to the device maximum (`osx_output_set_buffer_size`); a 100 ms ring (`:41`). MPD documents `hog_device` as "Hog the device. This means that it takes exclusive control of the audio output device it is playing through, and no other program can access it." [S2]. It does not list sample-rate switching as an option; it simply does it.
- The CoreAudio header defines hog mode: "A pid_t indicating the process that currently owns exclusive access to the AudioDevice or a value of -1 indicating that the device is currently available to all processes. If the AudioDevice is in a non-mixable mode, the HAL will automatically take hog mode on behalf of the first process to start an IOProc." and, for setting: "the value passed in is ignored ... If the current process owns exclusive access, it is released ... If no process has exclusive access ... this process gains ownership" (`AudioHardware.h:932-944`) [S9].
- The header also has `kAudioDevicePropertyNominalSampleRate` and `...AvailableNominalSampleRates` (`AudioHardwareBase.h:754-755`), `kAudioDevicePropertyDeviceIsAlive` (`:746`); and in `AudioHardware.h`, `kAudioDevicePropertyHogMode` (`:1018`), `kAudioDevicePropertyBufferFrameSize` and `...Range` (`:1019-1020`), and `kAudioDevicePropertyIOThreadOSWorkgroup` (`:1027`) [S9].
- The SDK on this machine also ships `AudioHardwareTapping.h` (`AudioHardwareCreateProcessTap`), an API for tapping other processes' audio [S9]. That is a different, system-wide route to EQ; it is outside this lane.
- AudioToolbox on this machine declares codec IDs for AAC (`kAudioFormatMPEG4AAC`), Apple Lossless, FLAC and Opus (`CoreAudioBaseTypes.h:397,414,431,432`), so macOS can decode all of them system-side [S9].
- Hog mode and release on process exit: the header does not say what happens if the owning process dies. UNCONFIRMED.

**Recommendation.**
- Write the backend directly against CoreAudio, not through cpal: AUHAL (an output AudioUnit with a render callback, as MPD does) or a raw HAL IOProc; both are first-party and both can reach hog mode, format switching and the workgroup (Apple hangs the workgroup off the output unit via `kAudioOutputUnitProperty_OSWorkgroup`, or off the device via the HAL) [S7][S9]. Reasons: cpal's output config here is the device's default (`audio.rs:276`) with no hog, rate switch, or workgroup handle exposed that I could confirm; and the whole job is about 500 lines of well-trodden C (MPD's file is the map).
- Device resolution by UID, not by cached ID. Re-resolve on `kAudioHardwarePropertyDevices` and default-output changes; listen to `DeviceIsAlive` and `JackIsConnected`. This directly answers the `'!obj'` log lines.
- **Exclusive mode off by default**, per-output option. When on: take hog mode, set the physical format to the track's native rate/depth if available, release after a short idle time when paused or stopped (the Microsoft guidance for the Windows equivalent says exactly this: release the device promptly when idle [S11]). Never leave it held while paused for minutes.
- **Rate policy** per output: `follow` (switch the device to the track's rate when the device lists it), `fixed N` (always resample to N), `nearest`. Default for the built-in jack: `fixed` at the device's current rate (44,100 Hz here) until a listening test says follow is audibly better. Whether a given DAC clicks or pauses on a rate switch is UNCONFIRMED and must be tested on the owner's actual outputs.
- Our own resampler (section 7) does all rate conversion, so the quality is the same on every device and not whatever the OS does.
- Software volume in the graph, not the hardware mixer. The hardware mixer is what is failing in the log (2.3), and on some outputs (DisplayPort, digital) it does not exist. Dither (TPDF, last stage) only when the final format is an integer physical format; skip it when the device takes float.
- Bluetooth output is UNCONFIRMED here; the owner's three listed outputs are not Bluetooth.

### 5.2 WASAPI (Windows)

**Measured** (Microsoft Learn) [S11]. An application can open a stream in exclusive mode and then has "exclusive use of the audio endpoint device". The page warns that "all system sounds, notifications, and audio from other applications are silenced", that the user can disable exclusive mode per device, and, as a tip, that from Windows 10 `IAudioClient3` shared-mode streams can have very low periods, so "Evaluate shared-mode low-period streams before committing to exclusive mode unless you have a hard requirement for bit-exact output or custom sample rates." Event-driven buffering plus MMCSS ("Pro Audio") is the documented way to keep the service thread on time. Volume controls for shared streams do not apply to exclusive streams.

**Recommendation.** Shared mode first, exclusive as an option, same structure as CoreAudio: event-driven callback feeding from the same decode ring. Not in the first slice.

### 5.3 PipeWire / ALSA (Linux)

**Measured.** PipeWire's graph is nodes with ports joined by links; ALSA devices appear as nodes, and compatibility layers exist for Pulse and JACK clients [S12]. PipeWire ships a parametric-equalizer module that loads AutoEq-format files (filter types `PK`, `LSC`, `HSC`) [S13], which is useful prior art for the filter-file format in section 10. `pw_stream` real-time details: UNCONFIRMED (the overview page does not cover them and I did not fetch the stream API page).

**Recommendation.** Native ALSA `hw:` output first for exclusive bit-perfect behaviour; PipeWire stream second. Not in the first slice.

### 5.4 Reuse versus write

| Option | What it gives | What it lacks (as read) |
|---|---|---|
| miniaudio (single-file C, public domain or MIT-0) [S10] | One API over WASAPI, Core Audio, ALSA, PulseAudio, JACK and more | PipeWire not listed; no mention of exclusive mode in the README I read; unconfirmed whether it exposes macOS hog mode or workgroups |
| cpal (Rust; what the app uses today) | Cross-platform callback streams | Not C; hog and rate-switch exposure UNCONFIRMED |
| Own backend per OS behind one small C interface | Exactly the controls this project wants, auditable, small | You maintain three backends |

**Recommendation.** Own backends behind a tiny vtable (`list`, `open(request) -> negotiated`, `start`, `stop`, `close`, plus device-change events). miniaudio is a reasonable stopgap for Linux and Windows later because it is a single file under a permissive licence, but check its exclusive-mode and PipeWire support at that time.

---

## 6. Decoding

**Measured library mix** (2.4): FLAC about 91%, MP3 about 8%, Ogg Vorbis 158, M4A 49, Opus 14 files. That order is the build order.

| Decoder | Covers | Licence (as fetched) | Notes |
|---|---|---|---|
| libFLAC | FLAC | BSD 3-clause (Xiph `COPYING.Xiph`) [S19] | Reference decoder. The `flac`/`metaflac` command-line tools are separate. The distribution's own `COPYING` returned 404 when I tried to confirm a library-vs-tools split; UNCONFIRMED. |
| dr_flac / dr_mp3 / dr_wav | FLAC, MP3, WAV | Public domain, single-file C [S17] | dr_mp3 reports `delayInPCMFrames`, `paddingInPCMFrames`, `totalPCMFrameCount` (`dr_mp3.h:420-422`) [S17][local copy in `/tmp/msr-architecture/src/dr_mp3.h`]. |
| minimp3 | MP3 | CC0 1.0 (`LICENSE`) [S18] | `minimp3_ex.h` parses the Xing/Info/LAME tag: delay = field + 528 + 1, padding = field - (528 + 1) (`:193-260`); passes the ISO conformance vectors at PSNR above 96 dB per its README [S18]. |
| libopus + opusfile | Opus | BSD 3-clause; royalty-free patent grant [S22] | Needed for 14 files and for completeness. |
| libvorbis | Ogg Vorbis | BSD 3-clause [S23] | 158 files. |
| Symphonia (Rust) | FLAC, MP3, Vorbis, AAC-LC, ALAC, WAV, Ogg | MPL 2.0 [S16] | README status: FLAC, MP3, Vorbis "Excellent"; AAC-LC "Great" but gapless "No"; Opus "In work". Only relevant if the shell is Rust. |
| AudioToolbox (macOS system) | AAC, ALAC, FLAC, Opus, MP3 IDs present | System framework | macOS-only; behaviour tied to the OS release [S9]. |
| FFmpeg (libavcodec) | Nearly everything | LGPL 2.1+ only if built without `--enable-gpl` and `--enable-nonfree`; dynamic linking; attribution and source-offer duties [S15] | The Homebrew ffmpeg 9.0.2 on this machine is `--enable-gpl` (`ffmpeg -version`). Linking it would make the server GPL. |

**Recommendation.**
- Own decoders for the formats that carry the music: FLAC (libFLAC or dr_flac), MP3 (minimp3 or dr_mp3), Vorbis (libvorbis), Opus (libopus). They are portable and give the same samples on every OS, which matters for test vectors and for any later proof about the signal path.
- On macOS only, AudioToolbox for M4A (AAC/ALAC), 49 files, 0.3% of the library. It is already on the machine and avoids shipping an AAC decoder with patent questions. Patent status of AAC: UNCONFIRMED, not researched here.
- FFmpeg only as an optional, dynamically loaded plugin for exotic formats, from an LGPL build the project makes itself. Never the default decoder. Reason in one line: the owner's installed build is GPL, and a quiet GPL contamination of a library meant to become the owner's own language is worse than 49 files of M4A.
- Decoders are plugins behind a small C vtable (`probe`, `open`, `read_frames`, `seek_frames`, `trim_info`, `close`), so Orgiac-generated decoders can replace any of them one at a time.
- The decoder reads untrusted files. Fuzz every decoder from day one (clang's libFuzzer and AddressSanitizer are available with the Xcode toolchain on this machine).

---

## 7. Resampling

**Measured.**
- soxr is LGPL 2.1 or later (examples directory excluded; `pffft.c` has its own licence) [S24]. Its README advertises configurable phase response, bandwidth, aliasing rejection and a variable-rate mode [S24]. I could not fetch an independent quality comparison (the SRC comparison site is blocked from the US [S34]); soxr quality figures are UNCONFIRMED here.
- libsamplerate (Secret Rabbit Code) was relicensed to 2-clause BSD in 2016; its best converter is documented at 145 dB signal-to-noise with the passband to 96% of theoretical bandwidth, and it supports time-varying ratios [S25].
- MPD offers three resamplers: its own ("quality is very poor"), libsamplerate, and soxr [S2].

**Recommendation.**
- The resampler is a replaceable module behind `open(in_rate, out_rate, channels) -> process(in, out) -> flush`. Default: soxr if LGPL dynamic linking is acceptable (the owner's long-term plan is a new language, so a dynamically linked LGPL library is the easy case); libsamplerate as the BSD alternative. Choose by a null test on the owner's own files (resample 96k to 44.1k and back, compare to the original, compute noise floor), not by reputation.
- **When resampling happens.** Only when the device cannot take the track's rate (policy `fixed` or an unsupported rate). If the device follows the file's rate, nothing resamples at all.
- **The single-clock rule.** The sound card clock is the only clock. The decoder runs as fast as the ring allows and no faster. There is therefore never a drift-correcting resampler. A secondary output (a recorder, a network stream) is not a clock; if it falls behind, it drops or resamples on its own thread and never slows the primary.

---

## 8. Gapless and crossfade

### 8.1 What marks the true start and end of a track

**Measured.**
- FLAC: STREAMINFO "Total number of interchannel samples in the stream. A value of 0 here means the number of total samples is unknown." and an MD5 of "the unencoded audio data" [S20].
- Opus: the ID header carries pre-skip, "the number of samples (at 48 kHz) to discard from the decoder output when starting playback"; the final Ogg page's granule position says how many samples to keep at the end [S21].
- MP3: the LAME/Xing/Info tag carries encoder delay and padding; minimp3 parses it and adds the 528+1 decoder delay (`minimp3_ex.h:193-260`) [S18]. The primary fetch of the LAME tag specification failed (TLS error); the code is the evidence.
- M4A: Apple-style `iTunSMPB` carries priming, remainder and sample count; the ISO-standard route is edit lists (`elst`) [S28]. Per-encoder delays (for example Apple AAC 2,112 priming samples) are from forum posts: UNCONFIRMED, never hard-code them.
- Symphonia's README says AAC-LC has no gapless support [S16].

### 8.2 MPD's approach

**Measured.** MPD's decoder fills a `MusicPipe`, a queue of 4,096-byte chunks guarded by a mutex (`MusicChunk.hxx:20,136`; `MusicPipe.hxx`, class comment "A queue of #MusicChunk objects", `Mutex mutex`) [S6]. So MPD itself is not lock-free between decoder and player; only the final CoreAudio ring is. The player thread keeps a crossfade state machine (`player/Thread.cxx`, `CrossFadeState`) [S6]. MPD's manual says crossfade needs both songs in the same audio format, and that forcing one global format costs quality and CPU (paraphrase of the manual's note) [S1]. MixRamp (overlap based on tagged loudness) needs both songs' MixRamp tags or `mixramp_analyzer`, and the same format [S1].

### 8.3 Design

**Recommendation.**
- Two decoder slots. While track A plays, slot B opens and decodes track B up to a pre-roll of about one second, already trimmed (delay at start, padding at end) and already converted to the graph's working format (float, device rate).
- Because both tracks are converted before they meet, the identical-format restriction MPD documents does not apply. That is the one place a float graph is strictly better than MPD's pipeline.
- Gapless: when A's final frame is queued, B's first frame follows in the same ring with no silence. This is the default; no setting.
- Crossfade (off in the first slice): equal-power curves, applied inside the graph on the two streams for the overlap length; a track not clearly longer than the fade skips the fade. MPD has a similar guard (`CanCrossFadeSong` in `player/CrossFade.cxx` requires the fade to be shorter than the song and the song to reach a minimum length) [S6].
- Rate changes between tracks (96 kHz then 44.1 kHz, with `follow` policy): switch the device only at a track boundary and insert a short mute; gapless across a rate change is physically impossible on most hardware.
- A test fixture for every format: a synthetic album that is one continuous sine wave split across files with exact delay/padding tags; the pass criterion is bit-exact continuity at the join.

---

## 9. Loudness

**Measured.**
- ReplayGain 2.0 is, in practice, EBU R128 / ITU BS.1770 measurement with a target of -18 LUFS (loudgain's README: "loudgain uses EBU R128 loudness measuring but at a target of -18 LUFS"); tags are `REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK`, album variants [S26].
- Opus uses a different convention: `R128_TRACK_GAIN` and `R128_ALBUM_GAIN`, Q7.8 fixed-point dB, relative to -23 LUFS, applied on top of the ID header's output gain [S21][S26].
- libebur128 is MIT, ANSI C, and implements momentary, short-term and integrated loudness, loudness range (EBU Tech 3342) and true-peak, with incremental use [S27].
- MPD's ReplayGain settings: `replaygain` (album, track, auto), `replaygain_preamp` (-15 to 15 dB), `replaygain_missing_preamp`, `replaygain_limit`, `replay_gain_handler` (software, mixer, none) [S1].

**Recommendation.**
- Store loudness as a number in LUFS plus true-peak, not as a tag-style gain. Convert to the playback target at play time. This keeps one measurement useful for any target (-18 for ReplayGain-compatible, -23 for broadcast, anything else).
- Compute it with libebur128 in the library worker, once per distinct audio hash (section 12).
- Read existing `REPLAYGAIN_*` and `R128_*` tags as a head start; mark them "claimed by file" and verify against the measured value when the worker gets to it.
- **Loudness is a claim keyed by audio hash and is never written back into the owner's files.** The files stay byte-identical, so hashes do not change.
- The gain is one stage in the graph, with a preamp and a limiter, before volume. EQ boosts and loudness gain share one headroom budget (section 10).

---

## 10. DSP graph and the EQ

### 10.1 Ground truth: the parametric filter list

**Measured.** Equalizer APO's configuration is lines like `Filter 1: ON PK Fc 50 Hz Gain -3.0 dB Q 10.00`, with a `Preamp` command for overall gain [S14]. AutoEq's `ParametricEQ.txt` uses the same shape with filter codes `PK`, `LSC`, `HSC` (peaking, low shelf, high shelf), `Fc`, `Gain`, `Q`; PipeWire's parametric-equalizer module loads it [S13]. I only confirmed `PK`, `LS`/`LSC` and `HS`/`HSC` from the search summaries; other filter types in Equalizer APO's reference (low-pass, high-pass, band-pass, notch, all-pass) are UNCONFIRMED here.

**Recommendation.** The graph's native EQ is exactly this: a list of (type, frequency, gain in dB, Q) filters plus one preamp, per channel set. The loader accepts the Equalizer APO / AutoEq text format directly, so a headphone profile downloaded from AutoEq works on day one. Everything else is a projection onto it.

### 10.2 The WMP ten-band slider EQ is a preset projection

**Measured.** `~/git/window_headMPD/src-tauri/src/eq.rs`: ten RBJ-cookbook peaking biquads at 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000 and 16000 Hz (`:7-9`), Q 1.41 (`:13`), gains clamped to -14..+14 dB (`:75`), pre-gain `10^(-peak x 0.6 / 20)` (`:83`), per-channel transposed direct form II (`:100-110`), a soft clip above 0.7 (`:116-126`), and balance as opposite-channel attenuation (`:87-89`, applied at `:108`). ENGINE.md defines the host seam as `DspPort`: `eq.gains()`, `setGain(band, db)`, `reset()`, `bypass()` (default false), and `balance` -100..100 with a detent of plus or minus 5 handled by the host (`docs/design/ENGINE.md:1593-1597`, `:795`, `:803`).

**Recommendation.** The ten sliders become ten fixed PK filters in the native list. `DspPort.eq` maps onto `ad_dsp_set` with no new seam in the engine repo. Balance, bypass and the preamp map one-to-one. The soft clip is replaced by a limiter whose transfer function is written down (a hidden `tanh` above -3 dBFS colours the sound whenever it triggers), off by default in a bit-perfect path.

### 10.3 Per-output graphs and route keys

**Recommendation.**
- Each output has its own graph instance and its own parameter set, because the headphone correction must not apply to the speakers. The profile is keyed by route (device UID plus data source or jack state), so plugging headphones in switches profile automatically (2.3).
- The Player produces one decoded float stream; each enabled output receives it through its own ring. One output is the clock master (usually the device the owner hears); others follow best-effort.
- Stage order: input convert, loudness gain, preamp, filters, balance, volume, limiter, dither and final convert. Taps sit before and after the graph (section 11).

### 10.4 Numeric form and verification

**Recommendation.** These choices keep the math checkable. Which prover and which property to prove belongs to the verification lane.
- The kernel is allocation-free C with fixed-size loops, no recursion, no global mutable state, fixed-width types.
- Coefficient computation is a pure function (type, fc, gain, Q, fs) to five numbers; filtering is a pure function of (state, coefficients, input block). Both are testable against an offline reference render.
- Build flags pinned so the same inputs give the same bits: no fast-math, FMA contraction off.
- Filter state in double precision. Low-frequency filters at high sample rates (a 30 Hz peak at 192 kHz) are where single-precision direct-form biquads lose accuracy; that is general DSP knowledge, not measured here; settle it with a test at 192 kHz.
- One headroom rule: preamp is at least the negative of the largest positive filter gain (what Equalizer APO's `Preamp` is for); the loudness gain is added to that budget; the limiter is the last resort, not the plan.

---

## 11. PCM tap for visualisers

**Measured.**
- Today there are two FIFOs: `/tmp/mpd.fifo` ("Visualizer FIFO", 44100:16:2) and `/tmp/headspace.fifo`, both in `mpd.conf`. The app taps what it plays after the EQ so "the visuals line up with your ears" (`audio.rs:6`), and runs a 2048-point FFT to 64 bands plus 256 wave points at 60 frames per second (`:38-41`, `:379`).
- `AudioFrameBus` in the engine's contract can carry optional raw PCM: `AudioFrame { bands, wave, level, pcm?: Uint8Array }` and `subscribe(opts: { pcm?: boolean }, ...)` (`ENGINE.md:1598-1599`).
- MPD's FIFO writes into a pipe; when MPD closes the output on pause or stop it deletes the FIFO, and readers must chase a moving file (`audio.rs:179-181` comment).

**Recommendation.**
- Replace both FIFOs with a tap inside the server. Two tap points: **post-graph** (what reaches the device; the default, matching today) and **pre-graph** (the decoded signal, useful for analysis and for checking what the EQ did).
- Format: 32-bit float, interleaved, at the output rate, with a monotonically increasing frame index. The reader sees a gap as a jump in the index. Overwrite semantics (the callback never waits).
- Delivery: in-process shared ring for the Tauri app; over a socket, a binary frame stream with a `pcm` subscription. This satisfies `AudioFrameBus.pcm`.
- The 64-band FFT stays out of the real-time path and out of the core: a separate optional analysis module or the client does it from the tap.
- The tap is lossy by design and must never be used as an output (recording is an output with its own ring).

---

## 12. The library as content-addressed blobs with signed claims

### 12.1 Vocabulary already in the owner's stack

**Measured.** The VampireOTP blob-kernel spec (`~/git/VampireOTP/RAG/design/SPEC-BLOB-KERNEL-draft-v0_4-2026-09-13.org`) defines: a ref is `kind || alg || sha256(bytes)`, 34 bytes on the wire, text form `<kind>:sha256-<64 hex>` (`:68,78`); a claim is a signed, causally linked, content-addressed record, signed with Ed25519 (`:137`); everything derived (indexes, locators, snapshots) is disposable and rebuilt from claims and bytes (rule K3, `:62`); and application NIFs are forbidden (`[D01]`, `:37`).

### 12.2 Three layers

**Recommendation.**
1. **Blob.** The bytes of a file, named by SHA-256. A tag edit changes the blob's hash; that is correct and expected.
2. **Audio identity.** A second hash that survives tag edits: SHA-256 of the canonical decoded samples (interleaved little-endian, source depth), computed by the library worker. For FLAC the file already stores an MD5 of exactly that data in its header (RFC 9639 section 8.2, "MD5 checksum of the unencoded audio data") [S20]. That header value can be read without decoding, so it works as a cache key (header MD5 to a previously computed audio identity) that lets the worker skip decoding a file it has already seen. Checking that the header MD5 agrees with the decoded samples is the integrity test, and that one does require decoding. Two files with different tags but the same audio identity are the same recording.
3. **Claims.** Signed statements that attach meaning to a blob or an audio identity: "tags are X", "duration is N frames", "loudness is -9.4 LUFS, true peak -0.3 dBTP", "this cue track starts at frame F of blob B", "this item belongs to playlist P at position n", "rating is 4". The signer's key is the owner's. Claims replace the three MPD stores the owner barely uses: stickers (0 rows), stored playlists (`.m3u`), and cue-sheet virtual tracks.

### 12.3 The index is derived

**Recommendation.** An SQLite file keyed by blob ref holds the fast-to-query projection (path, size, mtime, tags, durations, loudness, cue tracks). It can be deleted and rebuilt from the files plus the claim log (rule K3). The player reads only this index and the file bytes; it never needs the claim log in the hot path.

### 12.4 Where the bytes live (owner decision, flag)

**Measured.** 439 GB, 18,404 songs, in Google Drive's CloudStorage folder (2.4). SHA-256 throughput on this machine: 1,710 MB across 60 random FLAC files in 0.82 s, about 2,080 MB/s (Python `hashlib`, `/tmp/msr-architecture`; cache state unknown, so a first real pass is bounded by disk reads and could be much slower). At that rate a full pass would be about 4 minutes; treat it as a lower bound.

**Recommendation.** Reference in place; do not copy. The blob store is an adapter with a locator table (`ref -> path`), verified on read when cheap. The first scan hashes lazily (on first play, and in the background at low priority), honours the dataless flag (never triggers a Drive download), and re-verifies by (size, mtime) first. The owner's decision: whether to also keep a local mirror of the 439 GB (full copy: simplest, safest against Drive trouble, costs 439 GB), or reference the Drive folder in place (nothing copied, depends on Drive being mounted and permitted). I recommend reference-in-place for the first slice.

### 12.5 Bootstrap from MPD

**Measured.** MPD's database is a gzip-compressed text file at `~/.local/share/mpd/database` (858,697 bytes compressed, 6,826,919 uncompressed), `format: 2`, written by mpd 0.24.14 (header lines). `mpc version` reports the protocol greeting `0.24.0`; the daemon is 0.24.14. Importing it gives tags and durations for all 18,404 songs without opening a single audio file.

**Recommendation.** Slice 1 imports that file read-only to seed the index, then verifies lazily. This also shows what MPD thinks the cue tracks are, which is the data to test the cue handling against (2.4).

---

## 13. Transports

### 13.1 The C ABI

In-process users (the Tauri app) link the library and call section 3.3 directly. The ABI is the primary contract; the socket protocols below are thin renderings of it.

### 13.2 Native Unix-socket protocol

**Recommendation.**
- Length-prefixed binary frames (a 4-byte length, then a canonical CBOR map), request/response with an id, plus a server-pushed event frame and the PCM stream frame. CBOR matches the encoding the owner's blob kernel already uses for claims (`SPEC-BLOB-KERNEL...:68,125`).
- A Unix-domain socket in the user's runtime directory, mode 0600. No TCP listener by default.
- The Elixir side connects with `gen_tcp` and a `{local, Path}` address. Erlang's `gen_tcp` documents the `local` address family; it also states that with `inet_backend = socket` the `local` domain "will fail with {error, enotsup}", so the default `inet` backend must be used for the Unix socket [S35].

### 13.3 The MPD compatibility shim

**Why it matters.** The owner's tools speak MPD (2.5). A shim lets them work unchanged while the server grows.

**Measured facts about the protocol.** Greeting `OK MPD <version>`; line-based commands; replies end with `OK` or `ACK [error@command_listNum] {current_command} message_text`; `idle` with 14 named subsystems; binary replies for `albumart` and `readpicture` announced as `binary: N` then N raw bytes; `binarylimit`; `config` is local-socket only; partitions, stickers, channel messages exist [S3]. MPD listens on TCP and, via `bind_to_address`, on Unix sockets [S1].

**Recommendation.**
- **Tier 1 (the measured list, slice 1):** greeting `OK MPD 0.24.0`; `status`, `currentsong`, `playlistinfo`, `listplaylists`, `listplaylistinfo`, `play`, `pause`, `stop`, `next`, `previous`, `seekcur`, `setvol`, `clear`, `load`, `idle` and `noidle`, `outputs`, `enableoutput`, `disableoutput`, `readpicture`, `albumart`, `binarylimit`, `subscribe`, `readmessages`, `sendmessage`, `ping`, `password`, `command_list_begin`/`command_list_end`. nowplayd treats MPD's 60-second idle-connection timeout as a design input (`~/git/nowplayd/SPEC.org`); the shim should offer the same timeout so their liveness logic keeps working.
- **Tier 2 (rmpc's browsing needs; measure first):** `lsinfo`, `find`, `search`, `list`, `listall`/`listallinfo`, `add`, `addid`, `delete`, `deleteid`, `move`, `moveid`, `shuffle`, `random`, `repeat`, `single`, `consume`, `playid`, `seekid`, `plchanges`, `tagtypes`, `stats`, `update`, `config`, `replay_gain_mode`, `crossfade`. rmpc's actual list is UNCONFIRMED.
- **How to measure rmpc without touching MPD:** run a logging proxy on a spare port in front of the new server (or on a copy of the shim) and point rmpc at it with `MPD_HOST`/`MPD_PORT`; the transcript is the exact command list. Do not put the proxy in front of the real MPD (a standing rule for this research), and do not run it as part of this lane.
- **What to refuse politely:** `partition` commands, stickers, neighbors, mounts, `listmounts`; return `ACK` with a clear message. Do not half-implement them (see below).
- **The cautionary tale.** Mopidy's MPD frontend is the best-known second implementation of the protocol, and its own documentation lists the gaps: single password, no output toggling, no channels, no stickers, no crossfade, no replay gain, no stats, no live database update; it blacklists `listall` and `listallinfo` by default [S31]. Clients that assume a full MPD can misbehave on a partial one, so a partial shim must answer *every* command it does not support with an explicit `ACK`, and the supported set must be written down.
- The shim only ever calls the public C API (section 15), so it is the same client any other front end could be.
- Event mapping is a table lookup (3.2).

---

## 14. BEAM integration

**Measured.**
- Erlang's NIF documentation: "As a NIF library is dynamically linked into the emulator process, this is the fastest way of calling C-code from Erlang (alongside port drivers). Calling NIFs requires no context switches. But it is also the least safe, because a crash in a NIF brings the emulator down too." [S29a]
- NIFs should return within about 1 millisecond ("usually a well-behaving native function is to return to its caller within 1 millisecond"); longer work belongs on dirty schedulers (`ERL_NIF_DIRTY_JOB_CPU_BOUND`, `..._IO_BOUND`) [S29b].
- Port drivers share the NIF risk ("A driver callback that crash will crash the whole VM") while external programs "run outside the VM"; ports to external programs carry bytes over pipes with `{packet, N}` framing, deliver `{'EXIT', Port, Reason}` when the program dies, and close the program when the owner process exits [S29c][S29d].
- Membrane, the Elixir multimedia framework, offers both NIFs and C nodes: NIFs "can even crash entire VM, whereas C Nodes are isolated and can be supervised like Elixir processes, but they are slower due to inter-process communication" [S30].
- The owner's own house rulings already say the same: the blob kernel's `[D01] no application NIFs` (`SPEC-BLOB-KERNEL...:37`) and VampireOTP ADR-0001's "Model compute runs in an out-of-process runtime (never inside an unkillable BEAM NIF when recovery depends on fencing it)" and "the process is the fence" (`~/git/VampireOTP/RAG/ADR/ADR-0001-interfaces-and-recovery.md:95,98`).

**Recommendation.**
- **The audio thread never lives in the BEAM, and the BEAM never lives in the audio process.** The server is a separate OS process. A BEAM crash must not stop the music; a server crash must not take the BEAM down.
- **Port for lifecycle, socket for traffic.** An Elixir supervisor owns the server's OS process through a Port (`spawn_executable`, `exit_status`), so a crash is an `EXIT` message and the supervisor restarts it. Commands and events travel over the Unix socket of 13.2, so the BEAM is just one more client. Equivalently, the server writes its own state file (2.5) and resumes at the saved position after a restart.
- **Typed actor edges.** In Elixir, Player, Queue, Outputs and Library each get one GenServer that holds a typed view and translates between messages and the socket protocol. The audio process knows nothing about actors.
- **No NIFs.** The only place a NIF could be tempting is hashing or parsing in the library; do those in the library worker process instead.
- Orgiac later: because the C ABI and the socket protocol are the contract, a module (a decoder, the resampler, even the kernel) can be replaced by Orgiac-generated C without the Elixir layer noticing. That is the reason to keep every module behind the vtables in sections 5 and 6.

---

## 15. Module boundaries

| Module | Job | Depends on | Language (Recommendation) | Thread |
|---|---|---|---|---|
| `kernel` | Biquads, gain, ramps, limiter, dither, SPSC rings, parameter-block swap, loudness stage math | Nothing but libc math | Plain C, allocation-free | Device callback and others |
| `backend_coreaudio` (later `_wasapi`, `_alsa`, `_pipewire`) | Open device, negotiate format, hog, rate, workgroup, device-alive; calls the kernel in its callback | `kernel` | C | Device callback |
| `decode_*` plugins | probe/open/read/seek/trim info | libFLAC or dr_flac, minimp3, libvorbis, libopus, AudioToolbox | C | Decode |
| `resample` | Rate conversion behind one interface | soxr or libsamplerate | C | Decode |
| `player` | State machine, queue, gapless hand-off, position clock | all above, `library` interface | C | Control |
| `graph` | Per-output stage list, parameter blocks, filter-file loader (Equalizer APO / AutoEq) | `kernel` | C | Control builds, callback runs |
| `library` | Index, scanner, hasher, cue handling, claim verification | SQLite, sha256, Ed25519, libebur128 | C (a Rust shell is the alternative) | Library workers |
| `tap` | Overwrite ring, subscriptions | `kernel` | C | Callback writes, others read |
| `events` | Mask plus fd | none | C | Control |
| `api` | The public C ABI | everything above | C | Any |
| `mpdshim` | MPD protocol on TCP/Unix | `api` only (public header) | C or Rust (any) | Net |
| `nativeproto` | CBOR socket protocol | `api` only | C or Rust (any) | Net |
| `bin/audiod` | Process: config, launchd, logging, signal handling | `api`, `mpdshim`, `nativeproto` | C | Main |

**Boundary rules (Recommendation).**
1. The shim and the native protocol are built against the public header only. If they need something the header lacks, the header grows; they never reach into internals.
2. Nothing but `kernel` code runs inside the device callback, plus the backend's thin glue.
3. Every plugin family (backend, decoder, resampler) is behind a small C vtable.
4. `library` is a service the player queries through a narrow interface (`resolve(uri) -> {path, trim info, loudness}`), so the queue and player work even when the index is rebuilding.

**Language decision for the owner.**
- *Recommendation:* everything on the audio path and the public ABI in C11. Reasons: the owner's stated goal is "a C API"; Orgiac emits C, so every module can be swapped for generated C one at a time; verification tooling for C is the mature route (verification lane to confirm); one toolchain, no FFI on the audio path.
- *Named alternative:* a Rust shell around the C kernel, exporting the C ABI through a header generator, reusing the owner's existing Rust knowledge (`eq.rs`, `audio.rs`, `rustfft`, `nowplayd`'s protocol code) and Symphonia (MPL 2.0) for FLAC/MP3/Vorbis [S16]. Gains: memory safety when parsing hostile files; faster to a first sound for a Rust-fluent agent. Costs: two toolchains, a foreign-function boundary on the audio path, a generated rather than designed header, and Orgiac would later have to replace Rust with C anyway. Symphonia marks Opus "In work" and AAC-LC gapless "No" [S16].
- Either way the kernel stays C, and the ABI and socket protocols are identical, so the choice can change later without disturbing clients.

---

## 16. Minimal first slice that could replace MPD for daily use

**Principle.** It runs beside MPD on another port (for example 6601). The owner's tools already take their address from the environment (`MPD_HOST`/`MPD_PORT` in `mpd.rs:15-18`; `NOWPLAYD_MPD_ADDRESS` in nowplayd's README), so trying it never touches the live MPD. Cutover is changing a port number.

### Slice 0: "Ears" (headphones, EQ, no protocol)

- `audiod play <file> --eq <ParametricEQ.txt>` plays FLAC and MP3 on the default output through the HAL, with native-rate decoding, float EQ, software volume.
- Kernel in C: biquads, preamp, limiter, SPSC rings, parameter swap.
- Acceptance: a swept-sine and a 24-bit/96 kHz FLAC play without underruns for one hour; the EQ output matches an offline reference render within a stated tolerance; changing a filter while playing makes no click; unplugging and re-plugging the headphones recovers.
- This is the earliest point at which the owner hears a parametric EQ on the headphones. The kernel is output-agnostic C, so it could also be dropped into today's app as a stopgap; which stopgap is best is for the EQ lanes.

### Slice 1: "Daily"

- Queue, player state machine, state persistence in the MPD state-file shape, random/repeat/single/consume.
- Gapless for FLAC and MP3 using total-sample counts and the LAME tag.
- Library: import MPD's gzip database read-only; lazy hashing; cue sheets as first-class; extension and magic-byte filter; dataless check.
- CoreAudio backend: device resolution by UID, device-alive and jack listeners, stalled state and resume; software volume only; rate policy `fixed` at the device rate with soxr for conversion.
- Post-graph PCM tap with a socket stream (replaces both FIFOs).
- Native socket and the MPD shim Tier 1 (13.3).
- Acceptance (each is a real daily action): rmpc connects and plays an album; window_headMPD shows state, art and queue, and its remote-control message channel works; nowplayd shows Now Playing and the media keys work; `mpc status` and `mpc outputs` read sensibly; kill the server mid-track and the supervisor resumes at the saved position; sleep and wake the machine and unplug the headphones without a hang.

### Slice 2: "Cutover"

- Run side by side for a stretch of daily listening with an underrun counter and the event log; compare against MPD on the same albums.
- rmpc transcript by logging proxy; promote Tier 2 commands it actually uses.
- Move the server to port 6600 and retire MPD, only after a soak the owner is happy with. Keep MPD's config and database untouched as the rollback.

### Explicitly out of the first slice

Crossfade and MixRamp; stickers; partitions; neighbors and mounts; network inputs and streaming outputs; WASAPI and PipeWire; Ogg Vorbis, Opus and M4A decoding (158 + 14 + 49 files, 1.2% of the library; add right after slice 1); signed claims beyond the local index; the BEAM layer; the native-protocol clients beyond the shim.

---

## 17. Risks and open decisions

| # | Item | Why it matters | Next step |
|---|---|---|---|
| 1 | Library lives in Google Drive (symlink into CloudStorage) | Privacy permissions and file-provider behaviour caused 289 failed opens last month (cause UNCONFIRMED); hashing must never force downloads | Owner decides mirror vs reference in place (12.4); ship the daemon as a `.app` bundle like nowplayd |
| 2 | Which output the owner EQs and listens on | Built-in jack today (measured); hog mode and rate switching matter mostly for a USB/DAC route the owner may not use | Owner confirms outputs; test `follow` vs `fixed` on the built-in jack |
| 3 | Rate switching behaviour on real outputs | Possible clicks or multi-second pauses; supported rates of the built-in jack UNCONFIRMED | Listening test in slice 0 |
| 4 | Hog mode release on crash | Header silent (UNCONFIRMED); a stuck hog silences everything else | Test: hog, kill -9, read `HogMode` property |
| 5 | rmpc's command surface | The shim may silently lack something | Logging proxy transcript (13.3) |
| 6 | Resampler quality | No independent comparison fetched | Null-test on the owner's 96 kHz files |
| 7 | MPD's resampler and dither on the current FIFO path | Needed to describe today's quality accurately (2.1) | Not needed for the build; optional |
| 8 | AAC patent status; AudioToolbox behaviour across OS releases | M4A is 0.3% of the library | Defer; revisit when M4A is added |
| 9 | Decoder security | Untrusted files in an always-on daemon | Fuzz every decoder; optionally decode in a sandboxed helper later |
| 10 | Language choice (C versus Rust shell) | Affects how fast slice 1 lands and how Orgiac later replaces it | Owner decides (section 15) |
| 11 | Name | Placeholders `audiod` and `ad_` | Owner decides |
| 12 | Verification scope | Which properties of the kernel are proven (stability, bounded output, bit-exact coefficients) | Verification lane |

---

## 18. Sources

**External (fetched or searched 2026-10-07; a failure is noted where one happened).**

- [S1] MPD user manual: https://mpd.readthedocs.io/en/latest/user.html
- [S2] MPD plugin reference (osx output options, fifo, resamplers, decoders): https://mpd.readthedocs.io/en/latest/plugins.html
- [S3] MPD protocol: https://mpd.readthedocs.io/en/latest/protocol.html
- [S4] MPD source, macOS output plugin: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/output/plugins/OSXOutputPlugin.cxx (downloaded to `/tmp/msr-architecture/src/osx.cxx`; line numbers are from that copy)
- [S5] MPD source, lock-free SPSC ring: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/util/RingBuffer.hxx
- [S6] MPD source, chunk, pipe, output interface, crossfade, player thread: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/MusicChunk.hxx , .../src/MusicPipe.hxx , .../src/output/Interface.hxx , .../src/player/CrossFade.cxx , .../src/player/Thread.cxx
- [S7] Apple, Adding Parallel Real-Time Threads to Audio Workgroups: https://developer.apple.com/documentation/audiotoolbox/adding-parallel-real-time-threads-to-audio-workgroups
- [S8] Apple WWDC20 session 10224, Meet Audio Workgroups: https://developer.apple.com/videos/play/wwdc2020/10224/
- [S9] Local macOS SDK CoreAudio and AudioToolbox headers: `/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/CoreAudio.framework/Headers/{AudioHardware.h,AudioHardwareBase.h,AudioHardwareTapping.h}` and `.../CoreAudioTypes.framework/Headers/CoreAudioBaseTypes.h`. Apple's web page for `kAudioDevicePropertyHogMode` returned no content to the fetcher; the header text is the source.
- [S10] miniaudio README: https://raw.githubusercontent.com/mackron/miniaudio/master/README.md
- [S11] Microsoft Learn, Exclusive-Mode Streams: https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams
- [S12] PipeWire overview: https://docs.pipewire.org/page_overview.html
- [S13] PipeWire parametric equalizer module (AutoEq format): https://man.archlinux.org/man/libpipewire-module-parametric-equalizer.7.en
- [S14] Equalizer APO configuration reference: https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/ (read via search summary only)
- [S15] FFmpeg legal and LGPL checklist: https://ffmpeg.org/legal.html
- [S16] Symphonia README: https://raw.githubusercontent.com/pdeljanov/Symphonia/master/README.md
- [S17] dr_libs (dr_flac, dr_mp3, dr_wav): https://github.com/mackron/dr_libs ; `dr_mp3.h` downloaded from https://raw.githubusercontent.com/mackron/dr_libs/master/dr_mp3.h
- [S18] minimp3: https://github.com/lieff/minimp3 , licence https://raw.githubusercontent.com/lieff/minimp3/master/LICENSE (CC0), `minimp3_ex.h` https://raw.githubusercontent.com/lieff/minimp3/master/minimp3_ex.h
- [S19] Xiph FLAC licence (BSD 3-clause): https://raw.githubusercontent.com/xiph/flac/master/COPYING.Xiph
- [S20] RFC 9639, FLAC: https://www.rfc-editor.org/rfc/rfc9639.html
- [S21] RFC 7845, Ogg Opus: https://datatracker.ietf.org/doc/html/rfc7845
- [S22] Opus licence and patent grant: https://opus-codec.org/license/
- [S23] libvorbis licence: https://raw.githubusercontent.com/xiph/vorbis/master/COPYING
- [S24] soxr: https://sourceforge.net/p/soxr/code/ci/master/tree/README and https://sourceforge.net/p/soxr/code/ci/master/tree/LICENCE
- [S25] libsamplerate: https://libsndfile.github.io/libsamplerate/ and https://libsndfile.github.io/libsamplerate/license.html
- [S26] loudgain (ReplayGain 2.0 at -18 LUFS, Opus -23 LUFS): https://github.com/Moonbase59/loudgain . The hydrogenaudio ReplayGain 2.0 specification page returned 403.
- [S27] libebur128: https://github.com/jiixyj/libebur128
- [S28] iTunSMPB and gapless in M4A: https://ffmpeg.org/pipermail/ffmpeg-devel/2012-July/127839.html and hydrogenaudio forum posts surfaced by search (per-encoder delays are not confirmed)
- [S29a] Erlang NIF caveats: https://www.erlang.org/doc/system/nif.html
- [S29b] Erlang `erl_nif`: https://www.erlang.org/doc/apps/erts/erl_nif.html
- [S29c] Erlang port drivers: https://www.erlang.org/doc/apps/erts/erl_driver.html
- [S29d] Erlang ports: https://www.erlang.org/doc/system/ports.html
- [S30] Membrane, native code integration: https://membrane-core.hexdocs.pm/08_native_code_integration.html
- [S31] Mopidy-MPD limitations: https://mopidy.com/ext/mpd/ and https://pypi.org/project/mopidy-mpd (read via search summary)
- [S33] rmpc site (no protocol requirements stated): https://rmpc.mierak.dev/
- [S34] SRC comparison site, blocked from the US at fetch time: https://src.infinitewave.ca/
- [S35] Erlang `gen_tcp` (`local` address family, `inet_backend = socket` caveat): https://www.erlang.org/doc/apps/kernel/gen_tcp.html
- Attempted and unreachable: Ross Bencina, "Real-time audio programming 101" (connection refused twice, content not used); Timur Doumler's article on locks in real-time audio (HTTP 500, content not used); Gabriel's MP3 info tag page (TLS error, replaced by the `minimp3_ex.h` code).

**Local (read only).**
- `~/git/window_headMPD/src-tauri/src/{audio,eq,mpd,outputs,lib}.rs`, `~/git/window_headMPD/src/player.js`
- `~/git/window_headMPD-engine/docs/design/ENGINE.md` (MediaModel, DspPort, AudioFrameBus: lines 1572-1599, 795, 803, 1278-1280)
- `~/git/window_headMPD-engine/docs/research/headspace-parity.md`
- `~/git/nowplayd/{README.md,SPEC.org,src/mpd/}`
- `~/git/RMPC-Auto-Theme/README.md`
- `~/git/VampireOTP/RAG/design/SPEC-BLOB-KERNEL-draft-v0_4-2026-09-13.org`, `~/git/VampireOTP/RAG/ADR/ADR-0001-interfaces-and-recovery.md`
- `/opt/homebrew/etc/mpd.conf`, `~/.cache/mpd/{log,state,sticker.sql}`, `~/.local/share/mpd/database`
- Read-only commands: `mpc version|stats|status|outputs`, `system_profiler SPAudioDataType`, `du`, `ffmpeg -version`, `stat` flags on a 2,000-file sample.
- Scratch: `/tmp/msr-architecture/` (`flacinfo.py` and downloaded source copies under `src/`).

Orgiac is described in the task brief only; I found no Orgiac document under `~/git/VampireOTP/RAG`, `~/git/VampireOTP/planning`, `~/claude-folder` or this repo's `docs`, so every statement about Orgiac here is the brief's, not a verified fact.
