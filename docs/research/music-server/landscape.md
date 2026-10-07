# Music server landscape

Date: 2026-10-07. Lane: LANDSCAPE.
Question: what do modern music servers, players and audio stacks solve that MPD does not, what do their APIs look like, and what should a C library that replaces MPD expose and stay compatible with?

How to read this document.

- Section 0 is measured on this machine (read-only commands, file reads, and two small ffmpeg tests in `/tmp/msr-landscape/`). Nothing in MPD, its config, or the app was changed or started.
- Section 1 states facts about other systems. Every external fact carries a number like [12] that points to the Sources list at the end. Where a primary source did not say, the line is marked UNCONFIRMED.
- Sections 2, 3 and 4 are judgement. They say "I recommend" or "my reading". Section 5 collects every UNCONFIRMED item in one place.

---

## 0. What this machine runs today (measured)

Measured 2026-10-07 with `mpc version`, `mpc outputs`, `mpc status`, `otool -L` on the installed `mpd` binary, reading `/opt/homebrew/etc/mpd.conf`, and reading `window_headMPD/src-tauri/src/*.rs`.

### 0.1 MPD as configured

- MPD is 0.24.0.
- `/opt/homebrew/etc/mpd.conf` declares three outputs (`mpc outputs` agrees):
  1. "Visualizer FIFO". Raw audio into a named pipe at `/tmp/mpd.fifo`, format `44100:16:2`. Enabled.
  2. "OS X Output". The `osx` (CoreAudio) plugin with `mixer_type "hardware"`. Enabled. No `format` line.
  3. "Headspace". A named pipe at `/tmp/headspace.fifo`, format `44100:16:2`, software mixer. Disabled in config; the app switches it on while it runs.
- Library is `~/Music/~~Artists~~` with symlinks followed. The sticker database is on.

### 0.2 How the app taps and EQs audio today

Read from `audio.rs`, `eq.rs`, `outputs.rs`, `mpd.rs`, `lib.rs`.

- MPD plays into the Headspace pipe. A reader thread moves the audio into a ring of about 100 ms. A `cpal` output stream (a Rust library that talks to CoreAudio) pulls from the ring, runs the EQ, resamples to whatever rate the sound card's default configuration reports, and feeds the visualiser from what it actually played.
- MPD's clock and the sound card's clock drift apart, so the resampler nudges its ratio by at most 0.2 percent to keep the ring level.
- The EQ is ten fixed peaking filters (RBJ "cookbook" biquads) at 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz, one octave wide (Q 1.41), plus or minus 14 dB, with an automatic preamp cut of 0.6 dB per dB of the largest boost, then a soft clipper. Balance is a separate opposite-channel cut.
- `outputs.rs` takes over sound by switching MPD's local-speaker outputs off while the app runs, after writing down what it changed so a crash can be undone on the next launch.
- `mpd.rs` speaks MPD's text protocol directly (no client library).

### 0.3 The measured compat floor (what real software already sends MPD)

| Software | MPD commands it uses (measured by reading its source) |
|---|---|
| window_headMPD | `status` `currentsong` `playlistinfo` `listplaylists` `listplaylistinfo` `load` `clear` `play` `pause` `stop` `next` `previous` `seekcur` `setvol` `outputs` `enableoutput` `disableoutput` `idle` `subscribe` `readmessages` `binarylimit`, plus binary art (`readpicture`, `albumart`). The demo is triggered with `mpc sendmessage window_head "demo <wav>"`. |
| nowplayd | `status` `currentsong` `idle` `play` `pause` `next` `previous` `stop` `readpicture` `albumart` `password`. Accepts `tcp://` or `unix://` addresses. |
| RMPC-Auto-Theme | Needs album art through `readpicture` or `albumart`; requires rmpc 0.11 or later (its README). |
| rmpc (client crate `rmpc-mpd`, master branch as fetched 2026-10-07) | 74 distinct command words in `mpd_client.rs` [67], including `idle`/`noidle`, `command_list_*`, queue edits (`add` `move` `swap` `deleteid` `playlistclear`), `find` `search` `findadd` `searchadd`, `lsinfo` `listall` `listfiles`, stored playlists, `sticker`, `partition`/`newpartition`/`moveoutput`, `mount`/`unmount`/`listmounts`, `outputs`/`toggleoutput`, `channels`/`subscribe`/`readmessages`, `decoders`, `update`/`rescan`, `crossfade`, `getvol`/`setvol`/`volume`. Album art goes through separate binary calls. |

### 0.4 What this setup cannot do (the baseline the survey is read against)

1. **Quality ceiling before the EQ.** The Headspace pipe is declared `44100:16:2`. MPD converts every track to 44.1 kHz, 16-bit stereo before our EQ sees it; the app then converts again to the card's rate. A 96 kHz or 24-bit file is reduced at the first step. (Fact: the format line and the resampler are in the files named above. The statement that this loses information is arithmetic on those two facts, not a listening test.)
2. **Two clocks.** MPD's pace and the sound card's pace are bridged by the 0.2 percent resampler nudge. In one process there would be one clock, the device's.
3. **The EQ cannot say what real headphone corrections say.** Headphone-correction files from AutoEq are lists of arbitrary-frequency filters with their own Q and shelf types. I downloaded one (Sennheiser HD 600, oratory1990 measurement, `/tmp/msr-landscape/dl/hd600.txt` [43]). It is `Preamp: -6.3 dB` plus ten filters: a low shelf at 105 Hz, a high shelf at 10 kHz, and eight peaks at 125, 522, 1298, 2166, 3158, 5433, 6639, 8445 Hz with Q from 0.55 to 5.82. The app's EQ has fixed centres, fixed Q 1.41 and peaking only. It cannot load that file as written. (This is only a format example; I do not know which headphones the owner has.)
4. **No DSP seam in MPD's own filter list, but there is a door.** MPD's documented filters are `ffmpeg`, `hdcd`, `normalize`, `null`, `route` [4]. The `ffmpeg` filter takes an FFmpeg filter graph and "requires building with libavfilter" [4]. Measured on the installed binary: `otool -L` shows it links `libavfilter.12.dylib`, and `strings` finds the four filter-plugin names `ffmpeg`, `hdcd`, `normalize` and `route` as separate strings (the string `ffmpeg` alone is not proof, since MPD also has an `ffmpeg` decoder and input plugin). My reading: the link line plus the filter names mean the filter plugin is compiled in; UNCONFIRMED until MPD is run with such a block. A filter is attached per output with `filters "name"` pointing at a `filter { plugin "ffmpeg" name "..." graph "..." }` block [3][4]. So stock MPD on this machine appears able to run an EQ inside its own playback path, on the "OS X Output", with no pipe and no app. **I did not test it inside MPD** (that needs a config edit and a restart, which this lane may not do). What I did test, with the same FFmpeg libraries the MPD binary links (`libavfilter 12.1.102`):
   - `equalizer=f=1000:t=q:w=1.41:g=6` on a 1 kHz tone raised it from -21.1 dB to -15.1 dB mean level, as expected (+6.0 dB).
   - The AutoEq HD 600 profile above, rewritten as a chain (`volume`, `lowshelf`, `equalizer` x8, `highshelf`) parses and runs without error. I did not measure whether FFmpeg's shelf filters match Equalizer APO's shelf shape.
   - UNCONFIRMED: whether MPD runs this filter in 16-bit or in float; whether the graph can be changed without restarting MPD (the protocol reference I read lists no command for it [1]); how the graph behaves at the CoreAudio device's native rate.
   This is a pointer for whichever lane covers "EQ the headphones now". It is not a recommendation to edit the config from here.

---

## 1. Survey, system by system

Summary first, then one block per system. "Solves" means: what it does that MPD, as it runs here, does not.

| System | Role | Wire or API shape | Licence |
|---|---|---|---|
| MPD 0.24 (baseline) | Daemon: library, queue, decode, output | Line-based text over TCP/socket, `idle` events, binary art [1] | GPL-2.0 [2] |
| Mopidy | Daemon with pluggable music sources | HTTP JSON-RPC + WebSocket, MPD, MPRIS frontends [8] | Apache-2.0 [9] |
| Navidrome | Library server, streams to clients | Subsonic 1.16.1 + OpenSubsonic REST [19] | GPL-3.0 [20] |
| gonic | Library server, optional server-side playback | Subsonic REST, jukebox [21] | GPL-3.0 [21] |
| Jellyfin | Media server with remote-controllable sessions | REST/OpenAPI, WebSocket, SyncPlay [22][25] | GPL-2.0 [22][23] |
| Plex / Plexamp | Server + dedicated music client | Proprietary; client has 10-band EQ [63] | UNCONFIRMED (not stated on page) |
| Roon (RAAT) | Core + DSP + network audio transport | Roon API (Apache-2.0, Node) [28]; RAAT closed [26] | Core and RAAT: no public source found, UNCONFIRMED |
| Snapcast | Synchronised multi-room transport | Binary stream protocol + JSON-RPC [30][31] | GPL-3.0 [30] |
| Music Assistant | Source aggregator + many player types | Sendspin over WebSocket [34]; API shape UNCONFIRMED | Apache-2.0 [33] |
| PipeWire | OS audio graph with filter nodes | Graph config, `filter-chain` module [35] | MIT [36] |
| Equalizer APO | Windows system-wide EQ (reference for the DSP model) | Plain-text config [39]; COM plug-in model [40] | GPL-2.0 [37] |
| CamillaDSP | Standalone DSP engine, runs on macOS | YAML pipeline + WebSocket control [41] | GPL-3.0 and MPL-2.0 [41] |
| libmpv | Embeddable player engine | C API: properties, commands, events [44] | Header ISC; core GPL-2.0+ or LGPL-2.1+ [44][45] |
| Symphonia | Rust decoders | Library [48] | MPL-2.0 [48] |
| cpal | Rust audio I/O (CoreAudio etc.) | Library [49] | Apache-2.0 [49] |
| rodio | Rust playback on cpal | Library [50] | MIT or Apache-2.0 [50] |
| foobar2000 | Desktop player with component SDK | C++ SDK [51] | Closed freeware; SDK BSD-3 per a secondary source [53] |
| DeaDBeeF | Desktop player with C plugin API | C plugin API v1.19 [55] | Player GPL-2.0; plug-in header zlib-style [54][56] |
| Strawberry | Desktop library player on GStreamer | Qt app [57] | GPL [57] |
| WACUP | Winamp continuation | Not documented in what I read | Freeware, closed source [59] |

### 1.1 MPD (baseline, for contrast)

- **Shape.** Commands are lines of text; replies are `key: value` lines ending in `OK` or `ACK [error@position] {command} message`. Command lists batch several commands. `idle` waits for change notices from 14 named areas: database, update, stored_playlist, playlist, player, mixer, output, options, partition, sticker, subscription, message, neighbor, mount. Binary replies (album art) are chunked with a size limit the client sets (`binarylimit`). Tags number 48 or more. "Partitions" give independent players with their own queues and outputs over one shared database. Stickers attach key/value data to songs. [1][3]
- **Audio path.** Output plugins include `osx`, `fifo`, `httpd`, `pipe`, `recorder`, `pipewire`, `snapcast`, `wasapi`, `alsa` and others; resamplers are `internal`, `libsamplerate`, `soxr`; the `osx` plugin has `device`, `hog_device` (exclusive access), `dop` (DSD over PCM) and `channel_map` [4]. Software ReplayGain is a volume filter and "prevents bit-perfect playback" [3].
- **Filters.** `ffmpeg`, `hdcd`, `normalize`, `null`, `route` [4]. Nothing in the protocol reference mentions an EQ [1].
- **Licence.** GPL-2.0 [2]. Anything that copies MPD code inherits it. Reimplementing the protocol from its public description is a separate matter (see Mopidy-MPD below, which does it under Apache-2.0 [15]); this is not legal advice.
- **Release state.** 0.24 was released 2025-03-11; the NEWS file I read lists 0.25 as unreleased [5].

### 1.2 Mopidy

- **Solves.** Music *sources*. Backends plug in Spotify-like services or local storage; a core actor presents them as one library and queue [8].
- **Shape.** Python. Frontends expose HTTP (JSON-RPC over HTTP and WebSocket), MPD and MPRIS [8]. Audio is GStreamer. Volume control is software by default [10].
- **DSP.** The architecture page mentions none [8]. The audio output setting takes a GStreamer pipeline fragment, and a forum answer shows `output = equalizer-10bands band2=3.0 ! alsasink` with the catch that the values are fixed when Mopidy starts [11]. GStreamer's `equalizer-10bands` covers 10 bands between 30 Hz and 15 kHz [12]; `equalizer-nbands` is fully parametric with 1 to 64 bands [13]. UNCONFIRMED: that this exact string works in current Mopidy (forum report only).
- **Mopidy-MPD.** An Apache-2.0 reimplementation of the MPD protocol on top of Mopidy. Documented gaps: no output toggling, no client-to-client channels, no stickers, crossfade or ReplayGain, no database statistics, no live database updates; `listall` and `listallinfo` are off by default [15]. Consequence for us: three commands window_headMPD uses today (`outputs`/`enableoutput`/`disableoutput`, `subscribe`, `readmessages`) are exactly the ones Mopidy-MPD omits.
- **Licence.** Apache-2.0 [9].

### 1.3 Navidrome, gonic and the Subsonic/OpenSubsonic family

- **Solves.** Remote listening. A server holds the library for many users and hands audio to apps on phones and laptops. The server does not play anything itself [18].
- **Shape.** REST over HTTP, XML or JSON replies. Endpoint families: browsing (by folder and by tags), three search endpoints, streaming, download, HLS, cover art, lyrics, playlists, bookmarks, sharing, podcasts, user management, and a jukebox (server-side playback) family. OpenSubsonic extends the old Subsonic API (baseline 1.8.0 and up) without breaking it; a server lists its extensions through `getOpenSubsonicExtensions`; the page lists 28 extensions including playback reporting, transcoding with offset seek, and API-key authentication [16]. The spec repo is Apache-2.0 [17].
- **Navidrome.** Implements Subsonic API 1.16.1 "with some exceptions" plus OpenSubsonic extensions. Per-user or per-player transcoding (Opus supported), multiple libraries with per-user access, automatic rescanning. No video. Folder browsing is simulated. Jukebox is not in its supported list. Plugins were listed as "upcoming" on the page I read [18][19]. GPL-3.0 [20].
- **gonic.** Go, GPL-3.0. Subsonic server with jukebox mode "for gapless server-side audio playback instead of streaming", folder or tag browsing, ffmpeg transcoding with cache. Its README claims an initial scan of about 50,000 tracks in around 10 minutes and incremental scans around 6 seconds (author's claim, not measured here) [21].
- **What they do not solve.** All DSP is the client's job. No `idle`-style change stream is documented in what I read (UNCONFIRMED; the Subsonic API is request/response).

### 1.4 Jellyfin

- **Solves.** One server for many users and many kinds of media, with *sessions*: one client can send play, pause, seek and volume commands to another client's session. A session advertises which commands it supports [22][75].
- **Shape.** REST described by an OpenAPI file; audio streams at `/Audio/{itemId}/stream` [24]. The TypeScript SDK (MPL-2.0) generates classes for sessions, audio, SyncPlay (synchronised playback across devices) and WebSocket [25]. The server shows a Swagger page at `/api-docs/swagger/index.html` when running [22].
- **DSP.** None found in what I read.
- **Licence.** GPL-2.0 [22][23]. Descended from Emby 3.5.2 and ported to .NET [22].
- **Relevance.** The session and remote-control model is the closest mainstream analogue to "several UIs controlling one player". The API is tied to Jellyfin's own library, so it is a model to study, not a protocol to implement.

### 1.5 Plex and Plexamp

- **Solves.** A polished dedicated music client with "sonic analysis" (a neural network that finds sonically similar tracks and powers track and album radio), free loudness leveling, a headless Raspberry Pi mode, and a ten-band EQ [63].
- **Gating.** The ten-band EQ and headless mode are Plex Pass features on the page [63].
- **EQ detail.** Community posts say the EQ is parametric internally with Q fixed at 1.41 per band and a pre-amp; this is forum material, not Plex documentation [64]. UNCONFIRMED. (Same Q as this app's EQ.)
- **Licence and API.** The page does not state a licence; treat as proprietary. UNCONFIRMED. I did not find a public protocol document for the music client.

### 1.6 Roon and RAAT

- **Solves.** A core that does the library and the DSP, and a transport that sends audio to devices around the house while each device keeps its own clock. Roon says "audio devices must own the audio clock", because two clocks never agree and letting the DAC set the pace removes the need for drift compensation. Multi-room sync target is within 1 ms. Endpoint behaviour is delivered to the device at run time as a script. A manufacturer SDK has existed since November 2015. [26]
- **DSP.** Each zone has its own, independently configurable DSP engine. The page lists eight filters including parametric EQ, convolution and crossfeed. Most processing is off by default unless the device needs it. "Insufficient headroom is one of the most common reasons why DSP configurations don't sound right." A signal-path display shows whether playback is bit-perfect. [27] Users import AutoEq convolution files for headphone correction [29].
- **API.** The Roon API (Node.js, WebSocket, Apache-2.0) exposes zones and transport control, browsing, and images. It lets an extension control Roon, not replace it [28].
- **Transport detail.** Press and trade sources say RAAT sends audio over TCP into a buffer on the endpoint. The Roon page I fetched does not say TCP or UDP. UNCONFIRMED. [26]
- **Licence.** No public source found for Roon Core or RAAT. UNCONFIRMED.

### 1.7 Snapcast

- **Solves.** Perfectly synchronised playback across rooms. The server reads PCM from sources (named pipe, ALSA, TCP, process output, librespot, AirPlay, PipeWire, JACK, file), encodes it (PCM, FLAC, Vorbis or Opus), stamps chunks with server time and sends them over TCP. Each client measures its clock offset and corrects drift by dropping or duplicating single samples; the README claims typical deviation below 0.2 ms. [30]
- **Shape.** An 8-message binary protocol (Hello, Time, Codec Header, Wire Chunk, Server Settings, Client Info, Error and others) and a JSON-RPC control API over TCP, HTTP or WebSocket. Offset is estimated as half the difference between the two measured one-way latencies. [30][31]
- **Link to MPD.** MPD has a `snapcast` output plugin that makes MPD act as a Snapcast server [4].
- **Licence.** GPL-3.0 [30].

### 1.8 Music Assistant and Sendspin

- **Solves.** One place to combine many music sources (Spotify, Apple Music, YouTube Music, TIDAL, Qobuz, Deezer, Plex, TuneIn, Audible, Audiobookshelf, Pocket Casts, local files) and play to many kinds of speaker (Sonos, AirPlay, Google Cast, Sendspin, Home Assistant players, WiiM, HEOS, MusicCast, Bluesound, Squeezelite, DLNA, Alexa), with Home Assistant automations and voice. Backed by the Open Home Foundation. [32]
- **Sendspin.** The foundation's own synchronised-audio protocol over WebSocket, spec at github.com/Sendspin/spec. Status on the page: "still in technical preview. It works, but expect it to change." Audio is "sent to Sendspin players as 16 bit". The web player uses lossless FLAC on desktop browsers and Android and Opus on Safari and iOS. Roles: players, a controller, metadata and artwork. [34]
- **Licence.** Server Apache-2.0 [33]. API shape (WebSocket or REST): not stated on the pages I read, UNCONFIRMED.

### 1.9 PipeWire

- **Solves.** An operating-system audio graph where an EQ is a node you insert. Its `filter-chain` module builds processing graphs and presents them as a virtual sink or source. Built-in biquads: `bq_lowpass`, `bq_highpass`, `bq_bandpass`, `bq_lowshelf`, `bq_highshelf`, `bq_peaking`, `bq_notch`, `bq_allpass`, `bq_raw`; plus `param_eq`, `convolver`, `delay`, `mixer` and others; LADSPA, LV2 and SOFA plug-ins. A `param_eq` example uses `{ type = bq_peaking, freq = 1000, gain = 3.0, q = 1.0 }` and can read its filters from a text file. [35]
- **Platform.** The cpal README lists PipeWire as a Linux and BSD host [49]. I found nothing putting PipeWire on macOS. UNCONFIRMED. MPD 0.24 gained a PipeWire output [5].
- **Licence.** MIT [36].

### 1.10 Equalizer APO (and what an "APO" is)

- **What an APO is.** An Audio Processing Object is a Windows plug-in: a COM object, in user mode, running in-process and in real time, that applies one effect (graphic EQ, reverb, echo cancellation and so on) to an audio stream. Windows has three places to put one: per stream before the mix (SFX), per mode after the mix (MFX), and per output endpoint always applied (EFX). [40]
- **Equalizer APO.** A system-wide EQ for Windows 7 to 11 (last update on its page: 2025-11-28), GPL-2.0 [37]. Its config is a plain-text list, easy to read and to share: `Preamp: -6.5 dB`, `Filter 1: ON PK Fc 50.0 Hz Gain -10.0 dB Q 2.50`. Filter codes: `PK`/`PEQ`/`Modal` (peaking), `LP`, `HP`, `BP`, `LS`/`LSC` and `HS`/`HSC` (shelves, with fixed 6 or 12 dB slope variants), `NO` (notch), `AP` (all-pass), `IIR` (raw coefficients). Other commands: `Channel`, `Include`, `Device` (apply only to named devices), `GraphicEQ`, `Convolution`, `Copy`, `Delay`. [38][39]
- **Why it matters here.** It is the reference for the *vocabulary* of a full-band parametric EQ, and AutoEq already publishes headphone corrections in exactly this syntax [42][43]. The architectural lesson from the APO model is that the DSP is a small object inserted at a defined point in the path, configured by plain data, with the application free to be unaware of it.
- **macOS has no APO equivalent in this survey.** Pointers for another lane, not examined here: a Core Audio process-tap approach (macOS 14.2 or later, no driver) used by the third-party `eqtune` [73][74], and a virtual-device (HAL driver) approach used by other tools [72]. I did not verify Apple's own documentation (the page would not load).

### 1.11 CamillaDSP

- **Solves.** The closest existing thing to "a full-band parametric EQ with a control API" that runs on macOS today. A Rust DSP engine described as a "flexible cross-platform IIR and FIR engine for crossovers, room correction etc." It captures from one audio device and plays to another; CoreAudio is supported, including virtual devices such as BlackHole. IIR filters are biquads (Peaking, Lowshelf, Highshelf, Notch, Allpass, Linkwitz-Riley); FIR is by FFT convolution. The pipeline is a YAML file; a WebSocket server changes it at run time. [41]
- **Licence.** Dual GPL-3.0 and MPL-2.0 (the optional ASIO backend is GPL-3.0 only) [41].
- **Limit.** It is a DSP box in front of or behind a player, not a player; it adds a second hop in the path, like the FIFO does today.

### 1.12 AutoEq (data, not a player)

- A web app and Python library that turns headphone measurements into EQ settings. MIT. Outputs: `ParametricEQ.txt` (Equalizer APO syntax), `GraphicEQ.txt`, fixed-band settings, and convolution WAV. Measurement sources include oratory1990, Crinacle, Innerfidelity, Rtings and headphone.com; targets include the Harman over-ear 2018 curve. [42]

### 1.13 mpv and libmpv

- **Solves.** A complete decode, filter and output engine you can embed, with a documented C API. Create a handle, set options, initialise, send commands, get and set *properties*, observe property changes, and wait on an event queue. The API is "generally fully thread-safe", though everything is serialised through a single lock in the playback core. [44]
- **Licence.** The client API header is ISC. The mpv core is GPL-2.0 or later by default and LGPL-2.1 or later when built with `-Dgpl=false`, with the caveat that the build switch alone "does not in itself create a LGPLv2.1+ license grant". [44][45]
- **DSP.** Audio filters can use FFmpeg's graph; community docs show a 10-band `equalizer` filter and FFmpeg's `anequalizer` through it [47]. UNCONFIRMED against the current manual (the manual page I fetched was truncated; the cited `af.rst` is an older commit).
- **macOS output.** mpv has a CoreAudio output and a separate exclusive-mode variant, `coreaudio_exclusive`, per its source. A code comment says it was created for AC-3 passthrough [46]. Option names UNCONFIRMED.
- **My reading.** libmpv is the best precedent for the *shape* of the API (handle, properties, commands, events) and a candidate engine to borrow from, but it is a player core. It has no tag database or search. It is a thing to link, not a replacement for MPD's library and server role.

### 1.14 Rust audio stack: Symphonia, cpal, rodio

- **Symphonia** (MPL-2.0). Pure-Rust demuxing and decoding. Lossless: FLAC, ALAC, PCM, WAV (all gapless). Lossy: MP3 and Vorbis (gapless), AAC-LC (no gapless), ADPCM. Opus, HE-AAC and WavPack are listed as in work; DSD is not mentioned. It has no resampling and no playback. Speed is "generally +/-15%" of FFmpeg. [48]
- **cpal** (Apache-2.0). Cross-platform audio I/O: CoreAudio, WASAPI, ALSA, JACK, PipeWire, ASIO, Web Audio. Model: pick a host, pick a device, build a stream. Exclusive mode and device-rate selection are not described in its README. UNCONFIRMED. [49] The app uses cpal 0.18 (measured, `Cargo.toml`) and today takes the device's default configuration.
- **rodio** (MIT or Apache-2.0). Playback on top of cpal, decoding via Symphonia by default. Its README warns that the core audio engine is being rewritten. [50]
- **My reading.** Symphonia and cpal are the two reasonable building blocks for a native Rust engine; rodio hides the two things we need to control (device rate and where DSP sits).

### 1.15 foobar2000

- Closed-source freeware. The Mac version is 2.26, requires macOS 11 or later, Intel or Apple Silicon, and takes components built for Mac. The SDK page lists a release dated 2026-10-01 with Xcode 13 to 26 and Visual Studio project files. [51][52]
- A secondary source (Wikipedia) says the core is closed and the SDK is three-clause BSD, and describes a COM-like C++ service model [53]. The SDK page I fetched did not state the licence. UNCONFIRMED from a primary source.
- A DSP component (`foo_dsp_effect`) is listed on the components site [76]. I did not verify the built-in DSP manager or EQ type. UNCONFIRMED.

### 1.16 DeaDBeeF

- Repo shows GPL-2.0 with `COPYING.GPLv2` and `COPYING.LGPLv2.1` files; the plug-in API header and the `COPYING` file I fetched carry a zlib-style licence. Per-plug-in licences UNCONFIRMED. Multi-platform including macOS per the repo page. [54][55][56]
- **Plug-in API (C, version 1.19).** Three plug-in kinds, which is the best-fit precedent for our own C boundary [55]:
  - DSP (`DB_dsp_t`): `process()` on interleaved float samples, may change sample rate and format; parameters by index with names (`num_params`, `get_param_name`, `set_param`, `get_param`); `can_bypass()`; `reset()`.
  - Output (`DB_output_t`): `init`, `free`, `setformat`, `play`, `stop`, `pause`, `unpause`, `state`, optional `enum_soundcards`, a `has_volume` flag.
  - Decoder (`DB_decoder_t`): `open`, `init`, `free`, `read`, `seek`, `seek_sample`, `insert` (adds tracks to a playlist), `read_metadata`, `write_metadata`.
  - Plus a host struct of 200 or more function pointers for playlists, config, threading and so on, versioned by `vmajor` and `vminor`; "plugins built against older versions continue functioning until a major version increment".

### 1.17 Strawberry

- C++ and Qt on GStreamer, GPL. Library organiser with smart playlists, Subsonic streaming, unofficial Tidal, Spotify and Qobuz, scrobbling to Last.fm, ListenBrainz and Subsonic, MPRIS2 on Linux. macOS releases are "currently available to sponsors only". [57]
- It has an equalizer, and a forum answer says it exists only with the GStreamer backend [58]. EQ type (graphic or parametric) and band count: UNCONFIRMED.

### 1.18 WACUP, Winamp, Webamp

- **WACUP.** "A media player that's made to emulate some of your favourite media players from the past & bring them into the future." Freeware, explicitly not open source, x86 and x64 builds; latest listed build #25130 dated 2026-09-30. Windows only is inferred, not stated. Which Winamp plug-in types it loads: not stated on the page. UNCONFIRMED. [59]
- **Winamp itself.** Its source was published in September 2024 under the "Winamp Collaborative License", which at first forbade forks (that clause was dropped in version 1.0.1), and the repository was deleted in mid-October 2024; reasons given are speculation about third-party code (Intel IPP, Dolby). Current availability: UNCONFIRMED. [60]
- **Winamp's DSP plug-in shape.** A public SDK header (seen via a third-party mirror) shows a `ModifySamples` callback that edits 16-bit integer samples in place and may return between half and double the sample count [61]. My reading: the plug-in ABI itself pinned the whole ecosystem to 16-bit; that is what to avoid.
- **Webamp.** An MIT-licensed HTML5 and JavaScript reimplementation of Winamp with full skin support and Milkdrop through Butterchurn (also MIT) [62]. (The repo's `webamp-spike.md` already covers this for the skin work; not repeated here.)

---

## 2. Patterns across the field (my reading)

### 2.1 Where each system puts the seam

| Where the seam is | Systems | What they leave to someone else |
|---|---|---|
| Daemon with a text or HTTP protocol, DSP not in the protocol | MPD, Mopidy, Navidrome, gonic, Jellyfin | DSP is a config-file or client matter, or absent |
| Sync and transport between devices | Snapcast, RAAT, Sendspin | The player and library |
| Audio graph with insertable DSP | PipeWire, Equalizer APO, CamillaDSP, GStreamer | The player and library |
| Library you link, not a daemon | libmpv, Symphonia, cpal, rodio | Everything above decoding and output |
| Desktop player with internal DSP chain | foobar2000, DeaDBeeF, Strawberry, WACUP, Plexamp | A server protocol others can use |

No system I surveyed has all three of: a documented server protocol, a DSP chain inside the playback path at native rate, and an embeddable library form. Roon comes closest to the first two and is closed. What the owner is describing is the empty cell: library form (row 4) with a DSP hook in the path (row 3) and a wire door in the MPD style (row 1).

### 2.2 Five patterns that carry over

1. **DSP sits in the engine, never in the wire protocol.** MPD puts it in config blocks, Mopidy in a GStreamer string, Roon in per-zone engines, Plexamp in the client. Nobody sends EQ settings over the protocol clients speak. A new engine should still expose the DSP state through its own API, because the app needs to drive sliders, but the MPD-compatible door can stay EQ-free.
2. **The output device owns the clock.** Roon says so outright [26]; Snapcast gets the same effect by correcting each client to server time [30]. This app has two clocks bridged by a 0.2 percent resampler nudge (section 0.2). An in-process engine removes one clock instead of managing the difference.
3. **DSP plug-in interfaces converge on the same few things.** DeaDBeeF: float buffers, parameters by index, bypass, reset, may change rate [55]. Equalizer APO: a defined insertion point and a text config [38][40]. PipeWire and CamillaDSP: biquad types by name and a pipeline description [35][41]. Winamp: 16-bit ints, in place, limited length change [61], which is the cautionary example. Latency reporting is not documented in any of the sources I read; adding it is my suggestion, not a finding.
4. **The headphone-EQ world speaks one text format.** AutoEq exports Equalizer APO syntax, PipeWire's `param_eq` can read filters from a text file, CamillaDSP uses the same biquad vocabulary [35][41][42]. A DSP model of `preamp + ordered list of {type, frequency, gain, Q}` per channel, with import and export of the Equalizer APO text, makes the engine compatible with AutoEq and Equalizer APO directly, and with PipeWire and CamillaDSP at the level of filter types (whether PipeWire's `param_eq` file is the same text format is UNCONFIRMED). The vocabulary to cover is the Equalizer APO list in section 1.10.
5. **Make the signal path inspectable.** Roon's signal-path display tells you whether playback is bit-perfect and what touched it [27]. MPD's own documentation notes that software ReplayGain breaks bit-perfect playback [3]. For a UI-taste owner, a visible "bit-perfect / resampled / EQ on" badge is a feature that no other server in the survey except Roon offers.

### 2.3 Licence picture for a C library (not legal advice)

- Easy to use from a closed or permissive library: Symphonia (MPL-2.0, file-level copyleft: changes to Symphonia's own files must be shared), cpal (Apache-2.0), rodio (MIT or Apache-2.0), PipeWire (MIT), AutoEq data and code (MIT), Webamp (MIT), libmpv's header (ISC).
- Copyleft to be aware of: MPD (GPL-2.0), Snapcast (GPL-3.0), Navidrome and gonic (GPL-3.0), Jellyfin (GPL-2.0), Equalizer APO (GPL-2.0), CamillaDSP (dual-licensed GPL-3.0 and MPL-2.0 per its README), mpv core (GPL-2.0+ unless built LGPL), DeaDBeeF (GPL-2.0).
- So reading these projects for ideas is free; copying code from the GPL ones makes the library GPL. The MPD wire protocol has a documented permissive reimplementation (Mopidy-MPD, Apache-2.0 [15]).

---

## 3. Recommendation: the API surface for a C library that replaces MPD

Written as capabilities, not signatures. Each line says what the owner gets, what it replaces in the current setup, and where the survey saw it work. The three existing seams in `ENGINE.md` section 5.6 (`MediaModel`, `DspPort`, `AudioFrameBus`) are the demands the engine already makes; the table at the end maps them.

### 3.0 Shape

- **A library you link, with an optional daemon around it.** The app links the engine directly; a separate small program can host the same library for other clients. libmpv shows the pattern (create, configure, initialise, command, property, event) [44]; MPD shows what happens when only the daemon form exists (this FIFO detour).
- **Thread-safe handle, events by callback or by file descriptor to wait on.** libmpv's statement of thread safety is the model to match or beat [44].

### 3.1 Capabilities, in order of importance to the owner

1. **Native-quality signal path with a DSP slot in it.** Decode, then DSP, then the output device, at the file's native rate and depth when the device allows it, float inside, no pipe, no second resampler. The slot is where ReplayGain, EQ and balance live, in that order, visibly. Models: Equalizer APO's insertion point [40], DeaDBeeF's DSP plug-in [55].
2. **A parametric EQ whose state is plain data.** Preamp plus an ordered list of filters per channel (or linked), each with type (peaking, low and high shelf, low and high pass, band pass, notch, all-pass, raw biquad), frequency, gain, Q, and an on/off flag; a whole-chain bypass; import and export of the Equalizer APO and AutoEq text format; and the current ten-slider EQ expressed as ten peaking filters so the existing skin sliders keep working. Convolution (headphone WAV files) can be a later addition to the same list. Models: Equalizer APO vocabulary [39], PipeWire `param_eq` and biquad names [35], CamillaDSP [41], AutoEq outputs [42].
3. **Headroom and signal-path report.** The engine tells the UI the total boost, the automatic headroom cut it applied, whether the path is bit-perfect, the format at each stage (file, DSP, device), and whether a resample happened. Model: Roon [27].
4. **Output devices as first-class objects.** Enumerate devices, choose one, set exclusive access, follow the device's rate, optional DSD over PCM, channel map, more than one active output, and network outputs (HTTP stream, Snapcast server, recorder, a PCM tap) as optional plug-ins. MPD's `osx` plugin already has device, `hog_device`, `dop` and `channel_map` [4]; its `snapcast`, `httpd` and `recorder` outputs are the precedent for the optional ones. Rust `cpal` covers the device side on macOS but does not document exclusive mode or rate selection [49], so the exclusive-mode path may need CoreAudio directly. UNCONFIRMED until tested.
5. **Transport and queue (what `MediaModel` needs).** Play, pause, stop, next, previous, seek, volume, repeat, random, single, consume; queue add, remove, move, shuffle, play-by-position; one state snapshot with a clock reference so the UI can extrapolate elapsed time (the app does this today); stored playlists load, save and list. All of this is in the measured compat floor (section 0.3).
6. **Library, tags and art.** Scan and watch the music directory; the 48-plus tag fields MPD exposes [1]; search and filtered lists; embedded and folder album art delivered as bytes; stickers (arbitrary key/value per song, for ratings and play counts). Give every track a stable opaque ID and treat the path as an attribute, not the identity. MPD addresses library songs by path or URI (as rmpc's `add` and `findadd` calls do); an ID that is not the path is what lets content-addressed storage slot in later without breaking clients.
7. **Typed events.** Every change delivers what changed and the new value, not just "player changed, go ask". Keep MPD's 14 area names as a stable grouping so the compat door can translate them to `idle` replies [1]. Add messages and channels (the app's demo hook uses them) and subscriptions.
8. **Analysis tap (what `AudioFrameBus` needs).** Spectrum bands, waveform and level, taken after the DSP and aligned with what the device is playing, plus an optional raw PCM tap (a file descriptor or a FIFO path for tools like ncmpcpp's visualiser; the owner's `Visualizer FIFO` output suggests that use, UNCONFIRMED from ncmpcpp's own documentation).
9. **Plug-in boundaries in C.** Three kinds, as DeaDBeeF does: decoder, DSP, output [55]. Built-in decoders can wrap Symphonia [48]; the C ABI should be versioned so old plug-ins keep loading until a major version, which is DeaDBeeF's rule [55].

### 3.2 Wire doors, separate from the core and optional

- **MPD protocol (0.24 behaviour), on TCP 6600 and a Unix socket.** See section 4. This is what lets the current app, `nowplayd`, `rmpc`, `mpc` and `ncmpcpp` keep working while the engine changes underneath.
- **A small JSON-over-WebSocket control channel for the app and tools.** Snapcast and CamillaDSP both control a running engine this way [30][41]. Carries what MPD cannot: DSP state, signal-path report, device selection, typed events.
- **OpenSubsonic REST, read-mostly, later.** Only worth building if phone apps are wanted. It is cheap to add on top of a library with stable IDs and art bytes [16][19]. Skip jukebox: Navidrome skips it and gonic uses it only for server-side playback, which this engine does natively [19][21].

### 3.3 Deliberately out of scope for the first version (judgement)

Video, streaming-service accounts (Mopidy and Music Assistant territory [8][32]), multi-room clock sync, and a Roon-style zone model. Keep the clock design compatible with adding a Snapcast or Sendspin output later (their clients own sync, the server timestamps chunks [30][31][34]).

### 3.4 Mapping to the engine's existing seams

| ENGINE.md seam (section 5.6) | What it needs today | What the C library provides | Capability above |
|---|---|---|---|
| `MediaModel` | State snapshot, queue, stored playlists, play and seek, volume, repeat and random, `isAvailable` | Same, as a snapshot plus typed events; elapsed from a clock reference | 5, 6, 7 |
| `DspPort` | `eq.gains/setGain/reset/bypass`, `balance` -100..100 with a plus or minus 5 detent | A filter list with the ten-band view as a special case, plus balance, plus import and export | 2 |
| `AudioFrameBus` | `bands`, `wave`, `level`, optional `pcm` | Same frame, taken after the DSP at the device's rate | 8 |
| (new, no seam yet) | Not present | Signal-path report; device enumeration and exclusive mode | 3, 4 |

---

## 4. Compatibility targets

### 4.1 Recommendation

Speak the **MPD 0.24 text protocol** as a door on port 6600 and a Unix socket, and measure compatibility against the real clients the owner uses, not against the whole protocol. Greet as `OK MPD 0.24.x` (the app's own client only checks for a greeting starting `OK MPD`, measured in `mpd.rs`; whether libmpdclient or rmpc switch features on the version number is UNCONFIRMED, so the safe choice is to claim the version whose commands are actually implemented).

### 4.2 Targets, in priority order

| Priority | Client | Why | Evidence |
|---|---|---|---|
| 1 | window_headMPD (the app itself) | It is the product; the door must carry it unchanged during the transition | Commands in section 0.3 |
| 1 | nowplayd | Media keys and Control Center; runs as a separate daemon | Commands in section 0.3; `unix://` or `tcp://` address |
| 1 | `mpc` | Scripts and the demo trigger (`sendmessage`) | Needs libmpdclient 2.18 [69] |
| 2 | rmpc | The owner's TUI and the target of RMPC-Auto-Theme | Minimum MPD 0.23.5 [65]; BSD-3-Clause licence [66]; its own protocol client with 74 command words including partitions, stickers, mounts [67] |
| 2 | ncmpcpp | The classic TUI | Uses libmpdclient (2.8 or later) [68]; in maintenance mode, described as feature complete [68] |
| 3 | The rest of the field | musicpd.org lists dozens of clients across command line, terminal, desktop, web, mobile and utility types; the entries marked macOS are MPC Bar, Persephone, Stylophone, swmpc and Sola MPD [71] | Do not target individually; libmpdclient-conformance is the proxy |

Why libmpdclient matters: `mpc` and `ncmpcpp` both sit on it [68][69], and it is BSD-licensed C [70]. A client that works because it uses libmpdclient will work against any server that answers like MPD; clients with their own protocol code (rmpc's `rmpc-mpd`, the app's `mpd.rs`) are where gaps will show first.

### 4.3 What compatible should mean, in three levels

1. **Level 1, enough for the app, nowplayd and mpc.** Greeting, `status`, `currentsong`, `idle`, `noidle`, `playlistinfo`, transport commands, `setvol`, `seekcur`, stored playlists, `readpicture`, `albumart`, `binarylimit`, `password`, `outputs`, and the message channel commands (`subscribe`, `readmessages`, `sendmessage`).
2. **Level 2, enough for rmpc and ncmpcpp.** The full set in section 0.3 row 4, including database search and `findadd`, `lsinfo`, stickers, and at least a single "default" partition.
3. **Level 3, the rest.** Mounts and neighbors, extra partitions, `decoders`, and similar. Mopidy-MPD shows a partial implementation can be useful [15] but it omits `outputs`, channels and stickers, which would break the app, rmpc's sticker features and the demo hook.

`outputs`, `enableoutput` and `disableoutput` keep a meaning in the new engine: they map to real output devices. The takeover logic in `outputs.rs` becomes unnecessary once the EQ lives inside the engine, but the commands still need to answer for rmpc and ncmpcpp.

### 4.4 Not worth chasing

- Jellyfin's or Plex's APIs: server-product protocols tied to their own libraries [22][63].
- RAAT: closed, device-side [26].
- The Roon API: it controls a Roon Core and does not substitute for one [28].
- Subsonic jukebox: see 3.2.

### 4.5 How to know the door is good enough (suggestion)

Record real conversations between the target clients and real MPD (same command sequences, same replies), then replay each client's recording against the new engine and diff the replies. That turns "stay compatible" into a repeatable test. Not tried here.

---

## 5. UNCONFIRMED (collected)

1. Whether MPD's `ffmpeg` filter runs a working EQ on this machine's "OS X Output" (not tested in MPD; only the FFmpeg libraries were tested), whether it works in float or 16-bit, and whether it can be changed without restarting MPD. (0.4)
2. Whether FFmpeg's shelf filters match Equalizer APO's shelf shape. (0.4)
3. Mopidy: that the forum's `equalizer-10bands ... ! alsasink` output string works in current Mopidy. (1.2)
4. Navidrome: whether its plugin system has since shipped; the page said "upcoming". (1.3)
5. Subsonic and OpenSubsonic: whether any change-notification stream exists. (1.3)
6. Plexamp: licence and proprietary status (page silent); that its EQ is parametric internally with Q 1.41 (forum report only). (1.5)
7. Roon: RAAT over TCP (not on Roon's own page); open or closed source status of Core and RAAT. (1.6)
8. Music Assistant: its own API shape (WebSocket or REST). (1.8)
9. PipeWire on macOS. (1.9)
10. libmpv: current manual's audio filter syntax; macOS exclusive-mode option names. (1.13)
11. cpal: exclusive mode and sample-rate selection on CoreAudio. (1.14, 3.1 item 4)
12. foobar2000: SDK licence from a primary source; built-in DSP manager and EQ type. (1.15)
13. DeaDBeeF: licences of individual plug-ins; the built-in EQ type. (1.16)
14. Strawberry: EQ type and band count. (1.17)
15. WACUP: which Winamp plug-in types it loads; whether it is Windows only. (1.18)
16. Winamp source: whether any official copy is available now. (1.18)
17. ncmpcpp's use of the `Visualizer FIFO`: README does not say; inferred from the output's name. (3.1 item 8)
18. Apple's own Core Audio taps documentation: not read (page did not load). (1.10)
19. Whether libmpdclient and rmpc gate features on the version in MPD's greeting. (4.1)
20. Whether PipeWire's `param_eq` text file uses the Equalizer APO syntax. (2.2)

---

## Sources

Local files read or measured (no external URL):

- `/opt/homebrew/etc/mpd.conf`; `~/.config/mpd/README-config-location.txt`; `mpc version`, `mpc outputs`, `mpc status`; `otool -L /opt/homebrew/bin/mpd` (library list only).
- `~/git/window_headMPD/src-tauri/src/{audio,eq,mpd,outputs,lib}.rs` and `src-tauri/Cargo.toml`; `~/git/window_headMPD/src/*.js` (MPD command names).
- `~/git/window_headMPD-engine/docs/design/ENGINE.md` (sections 5.6, `MediaModel`, `DspPort`, `AudioFrameBus`) and `docs/research/headspace-parity.md`.
- `~/git/nowplayd/README.md` and `src/`; `~/git/RMPC-Auto-Theme/README.md`.
- Scratch in `/tmp/msr-landscape/` (`ff/` ffmpeg tests, `dl/` downloaded docs and the AutoEq sample).

External:

1. MPD protocol reference. https://mpd.readthedocs.io/en/latest/protocol.html
2. MPD licence text (GPL-2.0). https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/COPYING
3. MPD user manual. https://mpd.readthedocs.io/en/latest/user.html and source https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/doc/user.rst
4. MPD plugin reference. https://mpd.readthedocs.io/en/latest/plugins.html
5. MPD release notes. https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/NEWS
6. MPD ffmpeg filter source. https://raw.githubusercontent.com/MusicPlayerDaemon/MPD/master/src/filter/plugins/FfmpegFilterPlugin.cxx
7. FFmpeg filters documentation. https://ffmpeg.org/ffmpeg-filters.html
8. Mopidy architecture. https://docs.mopidy.com/stable/api/architecture/
9. Mopidy licence. https://raw.githubusercontent.com/mopidy/mopidy/main/LICENSE
10. Mopidy configuration. https://docs.mopidy.com/stable/config/
11. Mopidy forum, GStreamer output parameters. https://discourse.mopidy.com/t/change-gstreamer-parameters-in-audio-output-during-playback/4995
12. GStreamer equalizer-10bands. https://gstreamer.freedesktop.org/documentation/equalizer/equalizer-10bands.html
13. GStreamer equalizer-nbands. https://gstreamer.freedesktop.org/documentation/equalizer/equalizer-nbands.html
14. GStreamer licence file (LGPL-2.1 text). https://raw.githubusercontent.com/GStreamer/gstreamer/main/LICENSE
15. Mopidy-MPD. https://github.com/mopidy/mopidy-mpd and https://mopidy.com/ext/mpd/
16. OpenSubsonic API documentation. https://opensubsonic.netlify.app/docs/opensubsonic-api/
17. OpenSubsonic spec repository. https://github.com/opensubsonic/open-subsonic-api
18. Navidrome overview. https://www.navidrome.org/docs/overview/
19. Navidrome Subsonic API notes. https://www.navidrome.org/docs/developers/subsonic-api/
20. Navidrome licence. https://raw.githubusercontent.com/navidrome/navidrome/master/LICENSE
21. gonic. https://github.com/sentriz/gonic
22. Jellyfin README. https://raw.githubusercontent.com/jellyfin/jellyfin/master/README.md
23. Jellyfin licence. https://raw.githubusercontent.com/jellyfin/jellyfin/master/LICENSE
24. Jellyfin OpenAPI file. https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json
25. Jellyfin TypeScript SDK. https://typescript-sdk.jellyfin.org/
26. Roon, RAAT. https://help.roonlabs.com/portal/en/kb/articles/raat
27. Roon, DSP engine. https://help.roonlabs.com/portal/kb/articles/dsp-engine
28. Roon API (Node). https://github.com/RoonLabs/node-roon-api
29. Roon community, convolution headphone correction. https://community.roonlabs.com/t/using-convolution-filters-for-headphone-correction/71727
30. Snapcast. https://github.com/badaix/snapcast
31. Snapcast binary protocol. https://raw.githubusercontent.com/badaix/snapcast/master/doc/binary_protocol.md
32. Music Assistant. https://www.music-assistant.io/
33. Music Assistant server licence. https://raw.githubusercontent.com/music-assistant/server/dev/LICENSE
34. Sendspin in Music Assistant. https://www.music-assistant.io/player-support/sendspin
35. PipeWire filter-chain. https://docs.pipewire.org/page_module_filter_chain.html
36. PipeWire licence. https://raw.githubusercontent.com/PipeWire/pipewire/master/COPYING
37. Equalizer APO project page. https://sourceforge.net/projects/equalizerapo/
38. Equalizer APO documentation. https://sourceforge.net/p/equalizerapo/wiki/Documentation/
39. Equalizer APO configuration reference. https://sourceforge.net/p/equalizerapo/wiki/Configuration%20reference/
40. Microsoft, Audio Processing Object architecture. https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/audio-processing-object-architecture
41. CamillaDSP. https://github.com/HEnquist/camilladsp
42. AutoEq. https://github.com/jaakkopasanen/AutoEq
43. AutoEq sample (Sennheiser HD 600, oratory1990). https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sennheiser%20HD%20600/Sennheiser%20HD%20600%20ParametricEQ.txt
44. libmpv client header. https://raw.githubusercontent.com/mpv-player/mpv/master/include/mpv/client.h
45. mpv licensing. https://raw.githubusercontent.com/mpv-player/mpv/master/Copyright
46. mpv CoreAudio exclusive output (third-party mirror of source). https://git.tjdev.de/mirror/mpv/src/commit/514af9fbd1e27b3cfd27598cc85c29d8159b89a0/audio/out/ao_coreaudio_exclusive.c
47. mpv audio filters (older commit of `af.rst`). https://github.com/mpv-player/mpv/blob/222899fbbe523320e66ae1600fabe45b58d48686/DOCS/man/af.rst
48. Symphonia. https://github.com/pdeljanov/Symphonia
49. cpal. https://github.com/RustAudio/cpal
50. rodio. https://github.com/RustAudio/rodio
51. foobar2000 SDK. https://www.foobar2000.org/SDK
52. foobar2000 for Mac. https://www.foobar2000.org/mac
53. foobar2000 (secondary source for SDK licence). https://en.wikipedia.org/wiki/Foobar2000
54. DeaDBeeF repository. https://github.com/DeaDBeeF-Player/deadbeef
55. DeaDBeeF plug-in header. https://raw.githubusercontent.com/DeaDBeeF-Player/deadbeef/master/include/deadbeef/deadbeef.h
56. DeaDBeeF COPYING. https://raw.githubusercontent.com/DeaDBeeF-Player/deadbeef/master/COPYING
57. Strawberry. https://github.com/strawberrymusicplayer/strawberry
58. Strawberry forum, equalizer. https://forum.strawberrymusicplayer.org/topic/555/how-to-enable-the-equalizer-on-linux-mint/4
59. WACUP. https://getwacup.com/
60. Winamp source release and removal (heise). https://heise.de/-9985700
61. Winamp DSP header (third-party mirror). https://git.txlyre.website/txlyre/winamp/src/main/Src/Winamp/DSP.H
62. Webamp. https://github.com/captbaritone/webamp
63. Plexamp. https://www.plex.tv/plexamp/
64. Plex forum, Plexamp EQ. https://forums.plex.tv/t/plexamp-where-is-the-parametric-eq/709040
65. rmpc installation (minimum MPD 0.23.5). https://rmpc.mierak.dev/installation/
66. rmpc Cargo manifest (licence). https://raw.githubusercontent.com/mierak/rmpc/master/Cargo.toml
67. rmpc MPD client crate source. https://raw.githubusercontent.com/mierak/rmpc/master/rmpc-mpd/src/mpd_client.rs
68. ncmpcpp. https://github.com/ncmpcpp/ncmpcpp and https://raw.githubusercontent.com/ncmpcpp/ncmpcpp/master/configure.ac
69. mpc README. https://raw.githubusercontent.com/MusicPlayerDaemon/mpc/master/README.rst
70. libmpdclient. https://github.com/MusicPlayerDaemon/libmpdclient
71. MPD clients list. https://www.musicpd.org/clients/
72. macOS system-wide audio (SotF guide). https://sotf.spinorama.org/guides/macos-daemon/
73. eqtune. https://docs.rs/crate/eqtune/0.5.0
74. Core Audio taps explainer. https://www.recall.ai/blog/core-audio-taps
75. Jellyfin forum, session commands. https://forum.jellyfin.org/t-integration-help-v10-11-session-commands-via-api-return-204-no-content-do-nothing
76. foobar2000 component foo_dsp_effect. https://foobar2000.org/components/view/foo_dsp_effect/release/0.51
