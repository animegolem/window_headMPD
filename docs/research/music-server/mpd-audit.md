# MPD audit

**Date:** 2026-10-07 · **Lane:** MPD AUDIT · **Scope:** what MPD is, where it falls short in 2026, and how our own code works around it. Nothing in this lane changed MPD's playback, outputs, or config, and the app was never started or stopped. The only commands sent to the running MPD were read-only `mpc` queries (listed under Sources).

How to read the tags in this document:

- **[V]** verified by me, on this machine or by reading the exact source file or doc named next to it.
- **[S]** stated by an outside source. The URL is in the Sources list at the end.
- **[I]** my inference from verified facts. The reasoning is shown.
- **UNCONFIRMED** I could not confirm it. The same items are collected in section 6.
- **[R]** a recommendation. Everything in section 5 is one.

All source-code facts come from the raw files at git tag `v0.24.15`, which matches the installed build. I read those files directly. I did not rely on page summaries for them.

---

## 0. The short version

1. MPD is a good "play music, take commands from many clients" daemon. It is a weak base for what you want to build. It has no way to change DSP while it runs, no sanctioned way to tap the audio, a thin macOS output, and only an all-or-nothing security model.
2. Almost everything window_headMPD does about audio is a workaround for two MPD gaps. The first is that MPD's filters are config-file-only. The second is that MPD has no way to hand a client a timed PCM stream. The app switches MPD's real outputs off, reads a pipe, resamples, EQs, and plays the sound itself.
3. The pipe the app depends on (MPD's "fifo" output) is described by MPD's maintainer as "an abuse of an experimental MPD feature" that "may be a reason to remove the plugin eventually" (issue #2052, 2024-07-05). The "proper" visualization plugin proposed in its place was closed unmerged on 2025-02-13 (#1449, #1910). The audio path is built on a feature upstream has said it may remove.
4. Measured on this Mac (idle reader): that pipe holds only **8,192 bytes, which is 46 ms** of CD-rate audio. MPD pushes on its own clock. When the pipe is full, MPD empties it and carries on (FifoOutputPlugin.cxx:198-216). A reader stall longer than about 46 ms silently loses audio.
5. Measured in your library (18,404 songs): 2,650 (14%) are deeper than 16-bit (24-bit, 32-bit, or float), and 943 of those are above 48 kHz. Another ~57 are 16-bit at an odd rate or mono. The Headspace pipe is pinned to `44100:16:2`, so MPD converts all of those before the EQ ever sees them. The app then resamples a second time to the device rate.
6. MPD is listening on **all network interfaces with no password** on this machine right now (`TCP *:6600 (LISTEN)`). By default every client has full permissions.
7. For the headphone EQ right now, MPD's own ffmpeg filter is available in your build and the filter graphs work offline. It is static (restart MPD to change) and it only applies to the output it is attached to. That is a recommendation in section 5.1. **I did not apply it.**
8. Three of the four MPD clients in your own repos (nowplayd, RMPC-Auto-Theme's publisher, window_headMPD) hand-roll or wrap the MPD wire protocol separately. The fourth, rmpc, is third-party. If the replacement server keeps even a thin MPD-protocol compatibility layer, all of them keep working during the transition.

---

## 1. What MPD is

### 1.1 Shape of the thing

MPD is one background process. Many clients talk to it over a plain-text, line-based protocol on TCP port 6600 or a unix socket. The clients do the UI. MPD does decoding, queue, and output. [V: S1, S2]

```
 files / http streams
        |
   input plugin ---> decoder plugin (flac, mpg123, vorbis, opus, ffmpeg, dsf, ...)
                           |
                 shared music buffer (audio_buffer_size, default 4 MiB)
                           |
        player: queue, gapless, crossfade, ReplayGain from tags
                           |
        +------------------+------------------+----------------------+
        |   per audio_output block, each with its own:                |
        |   format conversion -> volume/ReplayGain -> filters -> plugin
        +--> "OS X Output" (CoreAudio)  +--> "Headspace" (fifo)  +--> "Visualizer FIFO" (fifo)
```

Per-output `format`, `mixer_type`, `replay_gain_handler`, and `filters` settings are documented in S2 (section "Configuring audio outputs"). I did not read the C++ that wires the chain together. The diagram is the documented behavior, not a code trace.

### 1.2 The protocol (S1)

- **Text commands, text replies.** A reply is `key: value` lines ending in `OK`, or one `ACK [code@n] {command} message` line. There is no JSON, no schema, and no versioned types. [V: S1]
- **Binary replies.** `albumart` and `readpicture` return `binary: N`, then N raw bytes, in chunks. The client can raise the chunk size with `binarylimit`. [V: S1]
- **Command lists.** `command_list_begin ... command_list_end`. The doc says: "It does not execute any commands until the list has ended." On the first failure the rest are skipped. `idle` and `noidle` are not allowed inside one. The docs make **no promise that a list is a transaction**. [V: S1, section "Command lists"]
- **`idle`.** The client waits. MPD answers with only the **names** of subsystems that changed: `database update stored_playlist playlist player mixer output options partition sticker subscription message neighbor mount`. There is no detail, no sequence number, and no timestamp. Events accumulate while the client is busy, and while a client waits in `idle` the server turns off the idle timeout. [V: S1, "idle"]
- **Position is poll-only.** `status.elapsed` is a snapshot. The docs describe it as "Total time elapsed within the current song in seconds, but with higher resolution." No `idle` event ticks it forward, so every client has to extrapolate. [V: S1] Our clients do (player.js:93-97).
- **Timeouts.** `connection_timeout` defaults to 60 seconds, and idle waiters are excluded. `max_connections` defaults to 100. `max_output_buffer_size` (the largest single reply to a client) defaults to 8 MiB. [V: S2]
- **Messages.** Clients can `subscribe` to named channels and `sendmessage` to each other. window_headMPD uses this as a remote control (`mpc sendmessage window_head demo`, lib.rs:67-68). [V: S1; lib.rs:67-87]
- **One flat command namespace.** `kill` ("Kills MPD."), `enableoutput`, `disableoutput`, and the `partition` commands sit next to `play` and `status`. Which of them a client may use depends only on permissions (1.11). [V: S1]

### 1.3 Database

- The "simple" database plugin keeps a full copy of the library **in memory**. A gzip file on disk is only for persistence. [V: S3, "simple"]
- This machine: 18,404 songs, 2,043 directories, a 6.8 MB database file when uncompressed (`gunzip -c ~/.local/share/mpd/database`). The file was written by MPD 0.24.14. Every song in it was added between 2026-08-16 06:17 and 2026-08-17 05:35; the database records no song added after that. [V]
- Update is manual (`mpc update`). `auto_update` uses Linux inotify and **is Linux-only**. In issue #271 the maintainer wrote: "`auto_update` is only implemented on Linux." [S: #271]
- One `music_directory` only. Multiple roots have been requested since 2021 (#1252, open, 53 comments, 13 reactions). [S]
- Songs are addressed by their **path inside the music directory**. Stickers, queue entries, and stored playlists all key on that path. Moving a file breaks every reference to it. [V: S1 "Sticker addressing": `song` -> "File path within the database"]
- Your library sits behind a symlink into Google Drive: `~/Music/~~Artists~~ -> ~/Library/CloudStorage/GoogleDrive-.../My Drive/Music/~~Artists~~`. `follow_outside_symlinks "yes"` (mpd.conf:139). [V] Whether Drive serves files as online-only placeholders that fetch on demand is UNCONFIRMED. If it does, scan and play-start latency belong to Drive, not MPD.

### 1.4 What this MPD build can decode, output, and filter (installed: 0.24.15, Homebrew)

From `mpd --version` (this only prints the build and exits; it does not touch the running MPD): [V]

- **Decoders:** mpg123, vorbis, oggflac, flac, opus, dsdiff, dsf, faad, wavpack, mikmod, fluidsynth, gme, **ffmpeg** (a large fallback list), sndfile, pcm.
- **Output plugins:** shout, null, fifo, pipe, ao, openal, **osx**, httpd, snapcast, recorder.
- **Resamplers:** libsamplerate and soxr. Your `mpd.conf` has no `resampler` block, so which one MPD picks by default is UNCONFIRMED.
- **Filters:** `otool -L` on the binary shows it links `libavfilter.12.dylib`. `strings` finds the ffmpeg-filter error messages (for example "No such FFmpeg filter"). So the ffmpeg filter plugin is compiled in. [V]
- Library census from the database file: 16,747 FLAC, about 1,433 MP3, 158 Ogg, 49 M4A, 14 Opus, and a few others. [V]

### 1.5 The filter chain (the only DSP hook MPD has)

- **How it is configured.** A `filter { plugin "ffmpeg" name "x" graph "<libavfilter graph>" }` block in `mpd.conf`, then `filters "x"` inside an `audio_output` block. [V: S2 "Configuring filters"; S3]
- **When it is read.** `ffmpeg_filter_init` reads the `graph` string at startup and checks that it parses (FfmpegFilterPlugin.cxx:97-109). The graph is built fresh each time the output opens (`PreparedFfmpegFilter::Open`, same file, lines 57-95). The #1181 author lists pause/play and a format change between tracks as reopen events (see the #1181 bullet below). [V for the code; S for the list of events]
- **No reload.** There is no protocol command to change a filter. `SIGHUP` only "reopen log files ... and flush caches", not config. [V: S2 "Signals"] **Changing a filter means editing `mpd.conf` and restarting MPD.**
- **Maintainer-flagged API weakness.** The source says "TODO: improve the MPD filter API to allow returning the output format later, and eliminate this kludge" (FfmpegFilterPlugin.cxx:24-29). [V]
- **Runtime changes were prototyped by a user and not shipped.** Issue #1181 (open since 2021-06-03): the author drove libavfilter parameters live through zmq. He reports two problems. First, "when audio output is reopened ... all the runtime changes are lost." Second, "once the filters arg is set, there's no way to remove/add/reorder them." He asked for CamillaDSP support as an alternative. [S: #1181]
- **That zmq route is not available here.** `ffmpeg -filters` in your install (FFmpeg 9.0.2, the same `libavfilter` MPD links) shows no `zmq` or `azmq` filter. It does show `sendcmd` and `asendcmd`, which only script changes on a timeline. [V]
- **EQ-capable filters present in your FFmpeg** (checked with `ffmpeg -hide_banner -filters`): `equalizer`, `anequalizer`, `superequalizer` (18 bands), `firequalizer`, `afir` (FIR convolution from an impulse-response stream), `adynamicequalizer`, `bass`, `treble`, `highpass`, `lowpass`, `bandpass`, `bandreject`, `crossfeed`, `headphone` (HRTF), `loudnorm`, `alimiter`, `volume`, `aresample`. [V]
- **Offline test.** I ran a 1 kHz tone through three graphs with the `ffmpeg` command line. This does **not** exercise MPD:
  - `equalizer=f=1000:t=q:w=1:g=-6` lowered the mean level by exactly 6.0 dB (-44.1 to -50.1 dB).
  - `anequalizer=c0 f=1000 w=500 g=-6 t=1|c1 f=1000 w=500 g=-6 t=1` lowered it by 5.0 dB.
  - `superequalizer` with default settings changed it by 0.2 dB.
  - A malformed width type was rejected with an error.

  Scratch files are in `/tmp/msr-mpd-audit/`.

### 1.6 The macOS output ("osx") (OSXOutputPlugin.cxx at v0.24.15)

- **Device choice.** With no `device` setting (your case) it uses CoreAudio's `DefaultOutput` unit (line 141). Only a named `device` switches to `HALOutput` (line 141, line 561). The plugin's own record of the device (`dev_id`) is captured **once**, when the output object is created (line 183), and nothing updates it: I found no CoreAudio property listener in the file. That `dev_id` is what the hardware-volume mixer and the physical-format call (`osx_output_set_device_format`, line 705) use. Whether the `DefaultOutput` audio unit itself follows a macOS default-device switch is Apple's behavior, not the plugin's, and I did not test it: UNCONFIRMED. All of this is read from source, not tested.
- **Format.** `Open()` fills in a CoreAudio stream description from MPD's format (S16, S24 packed in 32, S32, float) and calls `osx_output_set_device_format(dev_id, asbd)` for the device it captured (lines 668-705). That tries to set the device's physical sample rate and bit depth to match.
- **Buffering.** A fixed 100 ms ring buffer (`MPD_OSX_BUFFER_TIME_MS = 100`, line 41, used at line 736). When full, `Delay()` makes MPD wait 25 ms (lines 786-791).
- **Exclusive mode.** `hog_device` takes CoreAudio hog mode for the process (lines 465-510). `dop` is DSD-over-PCM. `channel_map` routes channels. [V; S3 lists the same options]
- **Hardware volume.** It uses `kAudioHardwareServiceDeviceProperty_VirtualMainVolume` on the output scope (S5). That is the system volume slider for whichever device MPD is bound to.
- **Current care level.** In 2017 the maintainer wrote "there is no MPD developer with OS X, thus the OS X plugin is unmaintained and unsupported" (#72, 2017-07-31; repeated in #91). In 2026-08, 0.24.14 shipped "osx: fix format selection bugs" and "osx: fix volume truncation" (NEWS). So someone is fixing it now. Current ownership is UNCONFIRMED. The 0.25 draft NEWS adds "wasapi: detect device changes" (Windows) and has no osx line. [V: NEWS]

### 1.7 The FIFO output (the "tap") (FifoOutputPlugin.cxx at v0.24.15)

- **Creation and removal.** The FIFO is created (mode 0666) in the plugin's **constructor** if it does not exist, and `created` is set (lines 63-71, 107-114, 135-151). It is deleted only in `CloseFifo()`, called from the **destructor**, and only if MPD created it (lines 33-35, 89-105). `Open()` and `Close()` only create and delete a `Timer` (lines 153-163). So **MPD does not delete or recreate the FIFO on pause or stop.** The plugin docs agree: "If the path does not exist, it will be created when MPD is started, and removed when MPD is stopped ... If a FIFO already exists at the specified path it will be reused, and will not be removed when MPD is stopped." [V: S3, "fifo"]
- **Both ends held open.** MPD opens the FIFO **read-only and write-only, non-blocking, itself** (lines 140-145) and keeps both open for its lifetime. An external reader therefore never sees end-of-file while MPD runs. A reader's `read()` returns "would block" when there is no data.
- **Wall-clock push, no flow control.** `Play()` starts a Timer and adds the written bytes to it (lines 194-196). `Delay()` returns the Timer's wait (lines 183-189). The output therefore runs at real time, driven by MPD's clock. Then it does `write()`. On `EAGAIN` ("The pipe is full, so empty it", line 206) it calls `Cancel()`, which **resets the timer and reads (discards) everything pending in the pipe** (lines 165-181), then retries. **Anything the reader has not consumed is thrown away.**
- **Measured capacity.** On this Mac (macOS 27.0, arm64) a non-blocking FIFO accepted **8,192 bytes** before `EAGAIN`, measured with an idle reader (nothing was draining it while I wrote). I tried 1 KiB, 4 KiB, and 64 KiB writes and got the same result. At 44.1 kHz/16-bit/stereo (176,400 bytes/s) that is **46 ms**. I measured this with a throwaway script in `/tmp/msr-mpd-audit/fifo/`, not with MPD's own FIFOs. Whether the kernel enlarges the buffer under a draining reader, and whether MPD's own write sizes change this, were not tested: UNCONFIRMED. [V]
- **Upstream stance.** The docs call the plugin a plain PCM-to-FIFO writer (S3). The maintainer, on a visualizer bug: "This project does not support the ncmpcpp visualizer. This ncmpcpp feature is considered an abuse of an experimental MPD feature, and this ncmpcpp 'feature' may be a reason to remove the plugin eventually. For proper visualization, something like https://github.com/MusicPlayerDaemon/MPD/pull/1449 is needed." (#2052, 2024-07-05). [S]
- **That "proper visualization" never landed.** PR #1449 (a visualization output plugin) was closed 2025-02-13 with "I guess this PR was superseded by #1910". #1910 was closed the same day (not merged). The maintainer's last comment: "Is this going anywhere?" / "Apparently not." [S: #1449, #1910]

### 1.8 Partitions

A partition is "one frontend of a multi-player MPD process: it has separate queue, player and outputs." A client is attached to one partition at a time. `moveoutput` moves an output into the current partition, so an output belongs to one partition. All partitions share one database. [V: S1 "Partition commands"; S3] You use only `default` (`mpc partitions` printed `default`). Users who asked for "one saved playlist = its own live queue" were told that is a client feature (#2317, closed 2025-06-11). [S]

### 1.9 Gapless, crossfade, MixRamp, ReplayGain

- **Gapless:** the docs I downloaded (`user.rst`, `plugins.rst`, `protocol.rst`, `mpdconf.example`) do not mention the word. The musicpd.org front page does not list it either. I treat gapless as a default behavior for same-format tracks, inferred from the crossfade rule below. **UNCONFIRMED from docs.**
- **Crossfade and MixRamp need the same audio format** on both songs. The docs: "Cross-fading is only possible if both songs have the same audio format. At the cost of quality loss and higher CPU usage, you can make sure this is always given by configuring audio_output_format." The same page says setting a global `audio_output_format` is "usually not a good idea." [V: S2 "Cross-Fading"] A user hit this in #1503 and the maintainer answered "documented limitation". With your mix of formats (section 4), crossfade would silently skip across format changes.
- **ReplayGain** is read from tags only. MPD does not analyze loudness. The modes are `off`, `track`, `album`, `auto`. If `replaygain_missing_preamp` is unset, untagged songs "will appear too loud." It is applied by a software volume filter, which the docs say "prevents Bit-perfect playback". The alternative is `replay_gain_handler "mixer"`. [V: S2 "Replay Gain"] Yours is `off` (`mpc replaygain`). Tag coverage in your files is UNCONFIRMED. I did not read files on the Drive mount.
- **Known 2025-2026 bugs:** 0.24.15 (2026-08-27) "fix noise with replay gain and cross-fade". Open as of today: #2370 (Opus plus ReplayGain gives wrong volume, opened 2025-10-07) and #813 (a click between tracks that appears only with the **software** volume mixer, open since 2020-03-27). [V: NEWS; S: #2370, #813] #813 matters because your Headspace output uses the software mixer.

### 1.10 Volume and mixers (mixer/All.cxx, v0.24.15)

- **Reported volume.** `status.volume` is the **average** of all outputs that have a mixer. **Software mixers are counted even when their output is disabled.** Hardware mixers count only when their output is enabled (`output_mixer_get_volume`, `MultipleOutputs::GetVolume`). [V]
- **`setvol`.** It writes to every software mixer, enabled or not. It writes to a hardware mixer only if that output is enabled. [V]
- **Your outputs.** "Visualizer FIFO" has no mixer, "OS X Output" has `hardware`, "Headspace" has `software` (mpd.conf:343-352, 406-412). [V]
- **What that means.** While "OS X Output" is enabled (app closed, or the app in monitor mode), a `setvol` from the app's volume slider moves the Mac's system volume **and** Headspace's software gain, even though Headspace is switched off. While the app has taken over ("OS X Output" off), it moves only the software gain.
- **The reported number is a blend.** MPD says `volume: 97%` right now. The state file says `sw_volume: 100`. macOS says its output volume is 81 (`osascript` read). If 97 is the average of 100 and the Mac's volume as MPD sees it, MPD sees 94, not 81. A plausible cause is that MPD's hardware-volume mixer reads the device id it captured at startup (1.6) and the default device has changed since. The Mac's default is now "External Headphones". This is **UNCONFIRMED**.

### 1.11 Security and permissions

- By default every client is unauthenticated and has full permissions. Permissions are `read`, `add`, `player`, `control`, `admin`. `admin` covers outputs, stickers, partitions, mounts, and shutdown. There are `default_permissions`, `local_permissions` (for the unix socket), `host_permissions` (per IP), and one or more `password` lines. The docs: "the password option is not secure: passwords are sent in clear-text over the connection, and the client cannot verify the server's identity." [V: S2 "Permissions and Passwords"]
- `bind_to_address` defaults to `any`. [V: S2 "Listeners"]
- **This machine:** `lsof -iTCP -sTCP:LISTEN` shows `mpd ... TCP *:6600 (LISTEN)`. `mpd.conf` sets no `bind_to_address`, `password`, or `default_permissions`. [V] So any host that can reach the Mac on port 6600 can run `enableoutput`, `kill`, or `add`. Whether macOS's application firewall blocks inbound is UNCONFIRMED.
- **Permission names are coarse.** There are five bundles for one global namespace. There is no per-client identity and no scoping by file, queue, or output. The only per-source control is `host_permissions` by IP address.

### 1.12 Playlists and stickers

- **Queue.** One queue per partition. It is persisted in the state file. Yours has 23 entries. [V]
- **Stored playlists.** `.m3u` files in `playlist_directory`. They hold paths. `load`/`save` copy to and from the queue. **There are no smart playlists:** the request #1694 was closed by the maintainer ("Since nobody explained why this should be a server-side feature, I'll close the feature request.") and the answer was "use `searchadd`" or myMPD. [S]
- **Stickers.** Free-form name/value pairs in an SQLite file (`sticker_file`). MPD "itself does not assume any special meaning in them." Since 0.24 they can attach to songs, stored playlists, some tag values (Album, Artist, ...), and filter expressions. [V: S1 "Stickers"] **Play counts, ratings, last-played** are not recorded by MPD. Requests were closed with "implement play counts in stickers" (#939) and "Hard-coding the personal choices of one single user in the MPD core certainly isn't a good idea" (#126). [S]
- **Your usage.** Stored playlists: zero (`~/.config/mpd/playlists` is empty; `mpc lsplaylists` printed nothing). Stickers: zero rows (`select count(*) from sticker` gave 0). You use the queue plus the state file only. [V]

---

## 2. Where MPD falls short in 2026 (upstream, with evidence)

| # | Gap | Evidence | Status today |
|---|---|---|---|
| 1 | **No DSP or EQ that can change while playing.** Filters are config-time, reset on reopen, cannot be added or removed | #1181 (2021); S2 "Signals"; FfmpegFilterPlugin.cxx:97-109 | Open. Not in 0.25 draft NEWS |
| 2 | **No supported audio tap for visuals or external processing** | #2052 "abuse of an experimental MPD feature ... may be a reason to remove the plugin"; #1449 and #1910 closed unmerged 2025-02-13 | Nothing in 0.25 draft NEWS |
| 3 | **macOS output is second-class.** The plugin's device id (used for volume and format) is captured once at creation and never updated, with no CoreAudio listener in the source; a user in #271 asks for macOS integer mode that bypasses CoreAudio's float32 processing | OSXOutputPlugin.cxx:141,183,561; #72, #91 (2017 quotes); #271 | 0.24.14 fixed two bugs; ownership UNCONFIRMED |
| 4 | **No automatic library updates off Linux** | #271 maintainer quote | Workaround in your setup: `fswatch` and launchd |
| 5 | **One music root** | #1252 (open since 2021) | Open |
| 6 | **Library keyed by file path.** Move or rename loses stickers, playlist entries, history | S1 "Sticker addressing" | By design |
| 7 | **No play counts, ratings, or smart playlists in the core** | #126, #939, #1694 | Declined by maintainer |
| 8 | **Crossfade and MixRamp only for same-format neighbors** | S2 "Cross-Fading"; #1503 | Documented limitation |
| 9 | **ReplayGain only from tags; software volume blocks bit-perfect** | S2 "Replay Gain" | By design. 0.24.15 fixed one noise bug |
| 10 | **Protocol is untyped text. `idle` carries no detail, `elapsed` needs polling, command lists are not documented as transactions** | S1 | By design |
| 11 | **Security is all-or-nothing, with clear-text passwords and no TLS** | S2 "Permissions and Passwords" | By design |
| 12 | **One-person project.** In 2022 the maintainer wrote "I'm the only permanent MPD developer ... everything ends up being decided by me" (#1449). 0.25 is still "not yet released". 0.24.16 (pending) lists 38 fixes, mostly crashes, overflows, and use-after-free bugs | NEWS (master); #1449 | The repo was pushed to today, with 168 open issues (GitHub API) |
| 13 | **License.** Source files carry `SPDX-License-Identifier: GPL-2.0-or-later` | headers of the files in S4-S7 | Relevant if we ever copy code instead of re-implementing from the protocol docs |

---

## 3. How our own code uses MPD, and what it works around

### 3.1 window_headMPD, the audio takeover (src-tauri/src/audio.rs, outputs.rs, lib.rs)

What the app does, in order:

```
MPD decodes -> converts to 44.1k/16-bit stereo -> software volume (mixer_type "software")
  -> "Headspace" FIFO (46 ms of pipe, pushed on MPD's clock, mpd.conf:406-412)
  -> app reader thread (2 ms poll) -> ring (~100 ms target) -> 10 biquads at 44.1 kHz (eq.rs)
  -> cubic resampler to the device rate, ratio nudged up to 0.2% to hold the ring level
  -> cpal stream on the *default* output device only
```

Meanwhile `outputs.rs:111-139` switched "OS X Output" off and "Headspace" on. Pain points, each with evidence:

| # | Pain point | Evidence |
|---|---|---|
| P1 | **Hi-res is cut down before the EQ.** The Headspace output is pinned to `44100:16:2`, and the app's `IN_RATE` constant must be kept equal to it by hand. In the library, 15,697 songs are 44.1/16/2 (85%). The other 2,707 differ. 2,650 of them are deeper than 16-bit and get converted down by MPD: 1,161 at 44.1/24, 732 at 96/24, 320 at 48/24, 208 at 44.1/float, 127 at 88.2/24, 73 at 192/24, 29 at 32-bit. About 57 are 16-bit at another rate or mono. [I: whether dither is applied during 24-to-16 conversion is UNCONFIRMED; MPD has a `Dither` class in `src/pcm/` but I did not trace its use] | mpd.conf:410; audio.rs:29-31; database `Format:` census (section 4) |
| P2 | **Two resamplers in series, plus a clock hack.** MPD resamples to 44.1k, then the app resamples again to the device rate with a Catmull-Rom cubic. MPD's clock and the sound card's clock drift, so the app nudges the ratio up to 0.2% to hold the buffer | audio.rs:8-10, 284, 308-309, 349-361 |
| P3 | **No backpressure.** MPD writes on its own timer and, when the 8 KiB pipe is full, **empties it** (1.7). The app's reader polls every 2 ms. A stall longer than ~46 ms loses audio, which is audible as a click or skip. The 100 ms ring protects the output side only. [I: not measured in the app; I did not run it] | audio.rs:35, 246-248; FifoOutputPlugin.cxx:198-216; measured 46 ms |
| P4 | **A comment contradicts MPD's source.** audio.rs:179-180 says "When MPD creates it, MPD also deletes it on every close (pause, stop), which forces readers to chase a moving inode". At v0.24.15 MPD deletes the FIFO only at process exit and holds both ends open. Pre-creating the FIFO (audio.rs:181-190) is still correct, because the FIFO then survives an MPD exit. The reason in the comment is wrong. The `Ok(0)` "no writer" branch (audio.rs:216-222) can fire only after an MPD restart or exit | FifoOutputPlugin.cxx:33-35, 89-105, 135-163; S3 "fifo" |
| P5 | **Takeover edits shared global state.** Output enable flags belong to MPD, not to a client. rmpc, `mpc`, and anything else can flip them back, which gives double audio (one raw copy from MPD, one EQ'd copy from the app). `set()` ignores every error | outputs.rs:75-80, 111-139 |
| P6 | **Routing happens once per app launch.** `routed` is set before the loop and never reset. If MPD restarts while the app runs and its state file is gone, MPD comes back with Headspace off (`enabled "no"`, mpd.conf:412) and the speakers on. The app stays silent and never re-routes, and `engine_info.routed` still reads true | lib.rs:55, 62-65, 90-91; S2 `enabled` ("when there is no state file; with a state file, the previous state is restored") |
| P7 | **The "state-file trap".** Your state file stores each output's on/off (`audio_device_state:0:Headspace`, `:1:OS X Output`, ~/.cache/mpd/state:3-5). If the app crashes and MPD restarts before the app relaunches, MPD comes up routed into a FIFO nobody reads: silence. Recovery needs either the next app launch (`recover()`, outputs.rs:83-91) or the README's `mpc enable "OS X Output"`. No takeover record is on disk right now, so the app is not mid-takeover | outputs.rs:36-39, 83-91; lib.rs:112-118, 267-272 |
| P8 | **EQ and balance exist only while the app is running.** Run MPD without the app and you hear it raw. Balance (eq.rs:87-90) and mute (ENGINE.md:795, "emulated") are not MPD concepts. They are re-created in the host | eq.rs:87-90; ENGINE.md:795 |
| P9 | **Device handling is the default device only, float output only, no hot-swap.** The device is chosen once at start. A format other than f32 is refused. The stream error callback only logs. The default device here is "External Headphones" (built-in jack, 44.1 kHz) | audio.rs:271-279, 341 |
| P10 | **Seek bar timing ignores the app's own buffering.** `elapsed` is extrapolated from the last `status` plus wall time. The app's pipe and ring add roughly 100 ms or more between MPD's position and what you hear. [I: 100 ms ring + 46 ms pipe + device latency; not measured] | player.js:93-97; audio.rs:35 |
| P11 | **Visualizer amplitude follows MPD's software volume.** The tap sits after the software mixer. The analysis maps -60..0 dB to bars, so the bars shrink when the volume knob goes down. A hardware mixer would not do that. [I: not observed on screen] | audio.rs:243, 408; mpd.conf:411 |
| P12 | **Latency to resume after a pause or seek.** After the ring runs dry the app waits to refill ~100 ms before it sounds again (`primed`). README says pause and seek "take effect within that buffer" | audio.rs:299-306, 314-318 |

The whole MPD surface the app uses is small. From the source, 23 verbs: `status currentsong playlistinfo listplaylists listplaylistinfo play pause stop next previous seekcur setvol clear load idle outputs enableoutput disableoutput subscribe readmessages binarylimit readpicture albumart`. ENGINE.md:1900-1903 proposes a page-facing allow-list of the first 14, plus the `repeat random single consume` mode verbs for later. [V]

### 3.2 window_headMPD, the protocol client (mpd.rs, lib.rs, player.js)

| # | Issue | Evidence |
|---|---|---|
| C1 | **Hand-rolled client** ("so we speak it directly instead of pulling in a client crate"). TCP only. **No `password` command and no unix socket**, so it breaks the moment you secure MPD the way section 5.3 suggests. nowplayd supports both | mpd.rs:1-7, 15-20, 28-43; nowplayd README, config.rs:15-16 |
| C2 | **Command quoting escapes only `"` and `\`.** A newline inside an argument ends the line, and the rest would be read as a separate command. MPD itself refused newlines in song URIs in 0.24.11 for this class of problem. Low risk today because all arguments come from the app's own UI and MPD | mpd.rs:116-127; NEWS 0.24.11 ("playlist: do not allow newlines in song URIs") |
| C3 | **The page can send any MPD command, including `kill`.** `mpd` is a raw pass-through from the web view. ENGINE.md already plans a verb allow-list | lib.rs:29-50; ENGINE.md:369, 1900-1903; S1 `kill` |
| C4 | **Idle notices carry no detail.** Every `playlist` notice triggers a full `playlistinfo`. Fine at 23 songs, linear in queue length. MPD offers `plchanges` with a version number, which the app does not use. `status` and `currentsong` are two separate round trips, so they can straddle a song change | player.js:62-82; lib.rs:70-87 |
| C5 | **Reconnect logic.** The comment says "MPD closes idle clients after a minute" (60 s default). The app reconnects once on failure | lib.rs:27-28, 33-48; S2 `connection_timeout` |
| C6 | **Multi-step actions are separate commands**, not one command list. `playPlaylist` is `clear`, then `load`, then `play`. A client crash or another client's command between them leaves a half-done queue | player.js:119-124 |
| C7 | **Art lookup order.** `readpicture` (embedded) first, then `albumart` (folder file), with a fresh TCP connection per fetch | mpd.rs:136-164 (order at line 141) |

### 3.3 nowplayd (macOS Now Playing and media keys)

| # | Finding | Evidence |
|---|---|---|
| N1 | **Two connections by design**: a dedicated `idle player mixer options` listener and a separate command connection. The spec says this "removes the `noidle` cancellation dance" | SPEC.org:103-108; src/mpd/idle.rs:46-49 |
| N2 | **The 60 s `connection_timeout` broke the first live test.** The quiet command connection died while the idle one stayed up. It was found at the M3 live gate. Fix: ping-validate before use. Mutating commands are never blindly retried, because a retried `next` would double-advance | SPEC.org:125-148; revision log rev 0.10 |
| N3 | **Snapshot coherence is defended in the spec.** `status` plus `currentsong` go as one command list, `songid` is checked against `Id`, and it retries three times before declaring a fault. One suspected incoherence was later withdrawn as a harness artifact (rev 0.7, "250 ms harness fixtures, not MPD"). So I have **no confirmed MPD-side incoherence**, only a defensive contract | SPEC.org:155-166; rev 0.7 and 0.13 entries |
| N4 | **Art fetch is carefully strict.** `albumart` first, then `readpicture` only on a "no such file" ACK (code 50). An empty `readpicture` means no art. It checks the declared size, handles a connection drop at a nonzero offset, and caps size at 10 MiB | SPEC.org:341-351; artwork.rs:28, 420 |
| N5 | **Uses the `mpd_protocol` crate rather than a hand-rolled client.** The spec records that the crate's debug output would print the password, so the crate's tracing is permanently switched off | SPEC.org rev 0.7 and §11 FR-7 |
| N6 | **The reason nowplayd exists is a gap.** MPD has no macOS Now Playing or media-key integration of its own. [I: no mention in MPD's docs or in the output-plugin list; nowplayd's README states the purpose] | nowplayd README |

### 3.4 RMPC-Auto-Theme

- Its Rust publisher has **its own MPD client**: TCP or unix socket, `host` of the form `password@host`, then `albumart`, then `readpicture`, with chunk assembly and a 50-code ACK match. [V: src/publisher.rs:755-800, 855-935]
- **Its art order is the reverse of window_headMPD's.** The publisher tries `albumart` first and then `readpicture` (publisher.rs:918-920). window_headMPD tries `readpicture` first (mpd.rs:141). If a song has both a folder cover and different embedded art, the two apps can show different pictures for the same track. [I: not observed]
- The song-change trigger comes from rmpc, not from MPD directly. The hook script fetches art through the publisher by file path, not by "current song". The spec's "identity fence" exists because a track switch can land in the middle of a fetch and mislabel the bytes. [V: hook/on_song_change.sh:36-100; SPEC.org lines 283-287]

### 3.5 VampireOTP

MPD appears in exactly one place: AI-IMP-086 (the pane palette client) reads the current song through a read-only `rmpc song` command and compares its JSON `file` field before installing a palette. [V: RAG/AI-IMP/AI-IMP-086-baton-pane-addressable-palette.md:86-96] No other VampireOTP source, doc, or script that I could find talks to MPD. The estate does hold the surrounding agent-side sidecars (the launchd list below).

### 3.6 Sidecar jobs that exist only to cover MPD gaps (live on this Mac)

| Job | Covers |
|---|---|
| `com.golem.mpd-watch-artists` (fswatch to `mpc update`) | no auto-update on macOS. Its log is empty, 0 bytes since 2026-08-16. Either nothing changed or no event fired. UNCONFIRMED which |
| `io.github.animegolem.nowplayd` | macOS Now Playing and media keys |
| `sh.brew.mpd` | the running MPD, started as `mpd --no-daemon` |
| `window_headMPD` takeover | the audio tap and EQ (3.1) |

### 3.7 Count of independent MPD protocol implementations in your repos

Four code paths speak MPD: window_headMPD/mpd.rs (hand-rolled), nowplayd (the `mpd_protocol` crate), RMPC-Auto-Theme/publisher.rs (hand-rolled, about 200 lines), and rmpc (third party). The albumart/readpicture fallback, binary chunk assembly, the 60 s timeout, and password handling are each solved separately. [V] There is no shared Rust client crate in the estate.

---

## 4. Measured facts on this machine

| Fact | Value | How |
|---|---|---|
| MPD version | 0.24.15 binary (Homebrew, `mpd --version`); protocol greeting 0.24.0; mpc 0.35 | `mpd --version`; `mpc version` |
| Running | `sh.brew.mpd`, `mpd --no-daemon`, started 10:32 PM yesterday, uptime 11 h 33 m at check time | `ps`, `launchctl list`, `mpc stats` |
| Outputs now | 1 "Visualizer FIFO" on; 2 "OS X Output" on; 3 "Headspace" off | `mpc outputs` |
| Listener | `TCP *:6600 (LISTEN)`, no password, no `bind_to_address` | `lsof`; mpd.conf has neither |
| Library | 18,404 songs, 1,092 artists, 1,468 albums, 2,043 directories, 41 days 19 h play time | `mpc stats`; database file |
| Formats | 15,697 at 44.1/16/2; 1,161 at 44.1/24; 732 at 96/24; 320 at 48/24; 208 at 44.1/float; 127 at 88.2/24; 73 at 192/24; 36 at 48/16; 18 at 44.1/32; 15 mono 44.1/16; 11 at 96/32; 5 others (8, 16, 22.05, 24 kHz); 1 song with no `Format` | `gunzip -c` on the database file, then count the `Format:` lines |
| Deeper than 16-bit | 2,650 songs (14.4%); 943 (5.1%) of the library is above 48 kHz | same |
| Containers | about 16,747 FLAC, 1,433 MP3, 158 Ogg, 49 M4A, 14 Opus | same |
| ReplayGain / crossfade | `replay_gain_mode: off`; `crossfade: 0`; `mixrampdb 0` | `mpc` |
| Partitions | `default` only | `mpc partitions` |
| Stored playlists / stickers | 0 / 0 | playlist directory empty; sqlite count |
| Queue | 23 songs; state `pause`; `random on` | `mpc status`; state file |
| `volume` | MPD 97%; `sw_volume: 100`; macOS output volume 81 | `mpc status`; state file; `osascript` |
| Default audio device | "External Headphones" (built-in jack, 44.1 kHz). Others: MacBook Pro Speakers (44.1 kHz), DELL S2725QC (48 kHz), a virtual Teams device | `system_profiler SPAudioDataType` |
| FIFO capacity (idle reader) | 8,192 bytes = 46 ms at 44.1/16/2 | throwaway script in `/tmp/msr-mpd-audit/` |
| Config source of truth | `/opt/homebrew/etc/mpd.conf` (413 lines). `~/.config/mpd/README-config-location.txt` records that the XDG copy was a decoy twin | file reads |
| Takeover record | none on disk (`~/Library/Application Support/com.animegolem.windowheadmpd/` is empty) | `ls` |
| Libraries linked by the MPD binary | avfilter 12, avcodec 63, avformat 63, avutil 61 (FFmpeg), soxr, libsamplerate, CoreAudio, AudioToolbox, FLAC, opus, vorbis, mpg123, wavpack, sqlite3, curl, nfs, icu | `otool -L` |
| Upstream | 0.24.15 released 2026-08-27; 0.24.16 and 0.25 "not yet released"; 168 open issues; last push 2026-10-07 | NEWS; GitHub API |

---

## 5. Recommendations

These are opinions. Nothing in this section has been applied.

### 5.1 EQ the headphones now, with the least moving parts

**Option A: MPD's own ffmpeg filter (static).** Verified: the plugin is compiled in, the FFmpeg filters exist, and offline graphs work (1.5). The shape of the config, **not applied**. One setting per line, as in the shipped example config:

```
filter {
    plugin      "ffmpeg"
    name        "headphone-eq"
    graph       "volume=-4dB,equalizer=f=60:t=q:w=0.9:g=-2,equalizer=f=3000:t=q:w=2:g=-3"
}

audio_output {
    type        "osx"
    name        "OS X Output"
    mixer_type  "hardware"
    filters     "headphone-eq"
}
```

The two `equalizer` bands and the -4 dB are placeholders, not a recommended curve.

For the "Headspace" output, use a second filter block whose graph ends with a format guard (the reason is the third caveat below):

```
filter {
    plugin      "ffmpeg"
    name        "headphone-eq-fifo"
    graph       "volume=-4dB,equalizer=f=60:t=q:w=0.9:g=-2,equalizer=f=3000:t=q:w=2:g=-3,aformat=sample_fmts=s16:channel_layouts=stereo"
}
```

and add `filters "headphone-eq-fifo"` to the Headspace `audio_output` block.

Honest caveats:

- Editing the filter means editing `mpd.conf` and restarting MPD. There is no live control, and no zmq in this FFmpeg.
- A filter applies **only to the output it is attached to.** The app's takeover turns "OS X Output" off, so with window_headMPD in output mode you hear the Headspace path and not a filter attached only to "OS X Output". Attaching the matching filter to both outputs gives the same EQ in both situations. Only one of the two is audible at a time, so the correction is applied once. Leave the app's ten sliders flat so they do not stack on top.
- **Format hazard on the Headspace path.** `FfmpegFilterPlugin.cxx:67-70` shows MPD accepts whatever sample format the graph emits and only inserts an `aformat` when MPD cannot represent it. The `equalizer` family works in floating point internally. The app decodes the FIFO as 16-bit integers (audio.rs:228-229), so float data arriving there would be noise. Whether MPD re-applies the output's `format "44100:16:2"` after user filters is **UNCONFIRMED**. The trailing `aformat=sample_fmts=s16:channel_layouts=stereo` makes the question moot. The "OS X Output" variant does not need it, because CoreAudio takes float (OSXOutputPlugin.cxx:673).
- Boosts can clip, so put a negative `volume=` first (shown above).
- The curve itself is outside this lane. The headphone model is not recorded anywhere I read. The Mac's default device is "External Headphones".
- For the "full-band parametric, Equalizer-APO-style" goal, the path inside the same filter system is `firequalizer` (smooth curve from `gain_entry` points) or `afir` (convolve with a measured or designed impulse response). A parametric curve from a headphone database is a one-time conversion to either form. Not tested in this lane.

**Option B: the app's existing ten-band EQ** (eq.rs:7-9). It is already live whenever window_headMPD runs. It is limited to ten fixed centres, ±14 dB, 44.1 kHz input (P1).

**[R]** I recommend A on both outputs, and confirming the headphone model first. B stays available as the quick manual trim on top.

### 5.2 What the replacement server must do differently

| Area | MPD today | Recommendation for the replacement |
|---|---|---|
| **Audio clock** | MPD decodes on one clock and pushes into a pipe. The app resamples to fix the mismatch (P2, P3) | One process owns the decode, DSP, and device clock. No FIFO between player and EQ. Pull from the device callback, so there is no drift correction and no pipe loss |
| **Sample path** | Down-converts before the EQ (P1); resamples twice | Float internal format. Run the EQ at the source rate or at the device rate, and resample at most once with a band-limited resampler. Keep 24-bit and above intact |
| **DSP control** | Static filter graphs, restart to change (1.5) | A runtime API with typed bands, stored profiles, bypass, and safe parameter ramps. Make the filter state survive a device reopen, the issue #1181 describes |
| **Tap for visuals** | A FIFO that upstream calls abuse (1.7) | A first-class analysis tap: PCM or FFT frames that carry a timestamp relative to the audible clock. This is what MPD's maintainer proposed in 2022 and the PR died in 2025 |
| **Position** | Poll-only `elapsed`, decoded rather than audible | A continuous media clock, reporting both decoded and audible position |
| **Change events** | Subsystem names only (1.2) | Events with a payload, a monotonic sequence number, and per-object versions. Allow atomic snapshots (status plus current song plus queue version) |
| **Transactions** | Command lists, not documented as transactions | Real transactions for compound operations (`clear`+`load`+`play`) |
| **Identity of a track** | File path (1.3) | Content-hash identity, which matches the content-addressed blob plan. Stickers, play counts, ratings, and playlists survive moves and renames |
| **Play history** | Not recorded; DIY via stickers | Built in: play count, last played, skip count, rating |
| **Library** | One root, manual update on macOS, whole database in memory | Multiple roots, FSEvents-driven rescans, paged queries |
| **Loudness** | ReplayGain tags read only | Compute loudness (EBU R128) in the server and store it as metadata |
| **Auth** | Open by default, coarse permission bundles, clear-text password (1.11) | Unix socket by default. Per-client tokens with scoped capabilities. Fixes the raw-pass-through hole the engine already worries about (ENGINE.md:369) |
| **macOS device handling** | Plugin's device id fixed at creation; no listeners (1.6) | CoreAudio device-change listeners, optional exclusive/hog mode, rate matching, and clean recovery when a headphone jack or Bluetooth device appears or disappears |
| **Crossfade and gapless** | Same-format neighbors only (1.9) | Falls out for free if everything runs through one internal format |
| **Per-output chains** | Good idea, already in MPD: per-output format, volume, filters | Keep it |

What MPD gets right and the replacement should keep: named outputs with attributes, the queue-with-ids-and-versions model (`plchanges`), chunked binary art, the idle-style notification idea, tag-aware filter expressions, partitions as a concept, and the habit of keeping the player a server with many thin clients.

### 5.3 Migration and housekeeping

1. **Keep a thin MPD-protocol compatibility layer** in front of the new core, at least for the transition. rmpc, nowplayd, RMPC-Auto-Theme, and window_headMPD all speak it, and `mpc` is how your scripts reach it. Expose the new API natively and have the façade translate. The surface window_headMPD actually uses is only 23 verbs (section 3.1).
2. **Design from the protocol documents, not from MPD's source.** MPD's source is GPL-2.0-or-later (S4-S7 headers). Re-implementing a protocol from its public docs is a different act from copying code.
3. **Today's MPD hygiene, owner's call** (nothing applied by me):
   - Add `bind_to_address "127.0.0.1"` (or a unix socket path) to `mpd.conf` and restart MPD. This removes the all-interfaces exposure. Then teach window_headMPD's `mpd.rs` about `password` and unix sockets before enabling a password.
   - Make `route()` run again after every MPD reconnect, not once per launch (lib.rs:55, 62-65). Cheap, and it closes P6.
   - Fix the audio.rs:179-180 comment (P4).
   - Consider a single shared MPD client crate for window_headMPD, nowplayd, and RMPC-Auto-Theme. One fallback order for album art, one place for the 60 s timeout rule.
4. **Tests worth running later, by someone allowed to drive MPD** (I was not): stress the reader thread and watch for lost audio (P3); loopback-measure the end-to-end latency of app-takeover versus direct playback (P10, P12); run MPD at `log_level "verbose"` for a session with default-device changes (1.6, 1.10).

---

## 6. UNCONFIRMED list

1. Whether the 8 KiB (46 ms) pipe window holds with a reader that is draining it, and with MPD's own write sizes. I measured with a script and an idle reader. I did not run MPD or the app.
2. Whether lost audio from a stalled reader (P3) happens in practice in window_headMPD. It follows from the source and the measured capacity. I did not run the app.
3. Whether MPD applies dither when it converts 24-bit or float to 16-bit for the FIFO (P1). The class exists in `src/pcm/Dither.*`. I did not trace the call path.
4. Which resampler MPD picks by default in your build (soxr or libsamplerate). Your config sets none.
5. Whether MPD's volume reading is bound to a stale default device (1.10). It is consistent with source and with the 97 versus 81 discrepancy. It is not proven.
6. Whether MPD's `DefaultOutput` audio unit follows a macOS default-device switch. That is Apple's behavior, not the plugin's. The plugin's own device id is not updated (no listener in the source). I did not test unplugging headphones. You have plugged headphones into a running MPD and know whether sound followed.
7. Gapless behavior is not documented in the docs I downloaded. It is inferred from the same-format crossfade rule.
8. Whether the macOS application firewall blocks inbound connections to port 6600.
9. Whether Google Drive serves your library as on-demand placeholders, and so whether scan and start latency are Drive's.
10. Whether the fswatch/launchd update job has ever fired. Its log is empty, and the database records no song added after 2026-08-17.
11. Current ownership and care of the osx plugin. The 2017 quote and the 2026 fixes are the evidence on each side.
12. Whether the ReplayGain tags exist on your files. I did not read files on the Drive mount.
13. How much the seek bar leads the sound in the app (P10).
14. Whether the app's visualizer amplitude visibly follows the volume knob (P11).
15. Whether `anequalizer`, `equalizer`, `firequalizer`, or `afir` run correctly **inside MPD**, as opposed to the FFmpeg command line. The MPD source shows how the graph is built. I was not allowed to change MPD's config.
16. Whether MPD re-applies an output's `format` (for example `44100:16:2` on Headspace) after user filters, or passes the filter's native sample format through. If it passes float through, the app would misread it as 16-bit (5.1, third caveat). The trailing `aformat` guard avoids the question.
17. The ffmpeg-filters page on ffmpeg.org is cited only to confirm the filters are documented. The filter parameters I used come from my own local test, not from a page summary.

---

## Sources

MPD documentation (raw files at tag v0.24.15, matching the installed build):

- S1 Protocol reference: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.15/doc/protocol.rst (rendered: https://mpd.readthedocs.io/en/stable/protocol.html)
- S2 User manual: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.15/doc/user.rst (rendered: https://mpd.readthedocs.io/en/stable/user.html)
- S3 Plugin reference: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.15/doc/plugins.rst (rendered: https://mpd.readthedocs.io/en/stable/plugins.html)
- Example config: https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/v0.24.15/doc/mpdconf.example
- musicpd.org front page: https://www.musicpd.org/

MPD source (tag v0.24.15):

- S4 https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/output/plugins/FifoOutputPlugin.cxx
- S5 https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/output/plugins/OSXOutputPlugin.cxx
- S6 https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/filter/plugins/FfmpegFilterPlugin.cxx
- S7 https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/mixer/All.cxx

Release notes and repository facts:

- NEWS (master; 0.25 and 0.24.16 pending): https://github.com/MusicPlayerDaemon/MPD/blob/master/NEWS (the installed copy is `/opt/homebrew/opt/mpd/NEWS`)
- Tags: https://api.github.com/repos/MusicPlayerDaemon/MPD/tags
- Repository metadata (open issues 168, last push 2026-10-07): https://api.github.com/repos/MusicPlayerDaemon/MPD

Upstream issues and pull requests (read through the GitHub API):

- #72 macOS Bluetooth skipping, "OS X plugin is unmaintained and unsupported": https://github.com/MusicPlayerDaemon/MPD/issues/72
- #91 macOS skipping when idle: https://github.com/MusicPlayerDaemon/MPD/issues/91
- #126 playback metadata (last played, counts): https://github.com/MusicPlayerDaemon/MPD/issues/126
- #271 osx `sync_sample_rate` and bit depth; `auto_update` Linux-only: https://github.com/MusicPlayerDaemon/MPD/issues/271
- #813 click between tracks with software volume: https://github.com/MusicPlayerDaemon/MPD/issues/813
- #939 play and skip counts: https://github.com/MusicPlayerDaemon/MPD/issues/939
- #1181 change filters at runtime: https://github.com/MusicPlayerDaemon/MPD/issues/1181
- #1252 multiple music directories: https://github.com/MusicPlayerDaemon/MPD/issues/1252
- #1449 visualization output plugin RFC (closed unmerged 2025-02-13): https://github.com/MusicPlayerDaemon/MPD/pull/1449
- #1503 crossfade only between same format: https://github.com/MusicPlayerDaemon/MPD/issues/1503
- #1694 smart playlists: https://github.com/MusicPlayerDaemon/MPD/issues/1694
- #1910 visualization plugin first implementation (closed unmerged 2025-02-13): https://github.com/MusicPlayerDaemon/MPD/pull/1910
- #2052 FIFO visualizer is "an abuse of an experimental MPD feature": https://github.com/MusicPlayerDaemon/MPD/issues/2052
- #2317 multiple independent playlists: https://github.com/MusicPlayerDaemon/MPD/issues/2317
- #2370 Opus ReplayGain volume: https://github.com/MusicPlayerDaemon/MPD/issues/2370

Other:

- FFmpeg filter documentation (filter names only): https://ffmpeg.org/ffmpeg-filters.html

Local evidence (this machine, read-only):

- `/opt/homebrew/etc/mpd.conf`, `~/.config/mpd/README-config-location.txt`, `~/.cache/mpd/state`, `~/.cache/mpd/sticker.sql`, `~/.local/share/mpd/database` (gzip), `~/Library/LaunchAgents/com.golem.mpd-watch-artists.plist`
- `mpc` read-only commands (`version`, `outputs`, `status`, `stats`, `lsplaylists`, `replaygain`, `crossfade`, `mixrampdb`, `partitions`); `mpd --version`; `otool -L` and `strings` on the MPD binary; `lsof`; `launchctl list`; `system_profiler SPAudioDataType`; `osascript` (system volume); `ffmpeg -filters` and offline filter tests; a throwaway FIFO-capacity script. Scratch files are in `/tmp/msr-mpd-audit/`.
- Our code: `~/git/window_headMPD/src-tauri/src/{audio,eq,mpd,outputs,lib}.rs`, `~/git/window_headMPD/src/{player.js,main.js}`, `~/git/window_headMPD-engine/docs/design/ENGINE.md`, `~/git/nowplayd/{SPEC.org,README.md,src/mpd/idle.rs,src/artwork.rs}`, `~/git/RMPC-Auto-Theme/{SPEC.org,src/publisher.rs,hook/on_song_change.sh}`, `~/git/VampireOTP/RAG/AI-IMP/AI-IMP-086-baton-pane-addressable-palette.md`
