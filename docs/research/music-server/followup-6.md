# Follow-up 6: five contradictions between the lane documents, resolved

Date: 2026-10-07. Scope: the critic's item "findings not carried between lanes". Everything below was checked against primary sources: MPD source at git tag `v0.24.15` (Homebrew builds that tag unpatched, see item 5), the running daemon on this Mac, and the installed binary. Nothing was changed, started or stopped. MPD was only observed through `lsof`, `netstat`, `ps`, `stat` and the read-only `mpc` commands. I did not connect to port 6600.

Labels: **Measured** = I ran it on this machine today. **Source** = read in MPD's code at the tag shown. **Port** = my own Python re-implementation of MPD's dither code; it is not a measurement of MPD itself. **UNCONFIRMED** = not established.

## Verdicts

| # | Question | Answer | Lane that was wrong | Lanes extended |
|---|---|---|---|---|
| 1 | Does MPD delete the FIFO on pause or stop? | **No.** It creates the FIFO when MPD starts and deletes it only at exit, and only if MPD created it. | architecture section 11 | mpd-audit 1.7/P4 and hidden-problems A5/A13 were right |
| 2 | Does MPD dither when it cuts audio to 16-bit for the FIFO? | **Only for 24-bit and 32-bit integer audio that needs no rate change.** Float and resampled audio is not dithered. The critic's "yes" is incomplete. | hidden-problems A4 ("MPD does dither that step") for resampled files | mpd-audit #3/P1, headphones-today section 8, architecture risk 7, eq-dsp 4.8 |
| 3 | Is MPD reachable from the network? | **Yes, over IPv4 and IPv6, with no firewall, and it advertises itself on the LAN.** One last link (a test from a second device) is still untested. | none; the lanes left it open | hidden-problems A1, mpd-audit #8, #6 |
| 4 | Is the ffmpeg filter in this MPD? | **Yes.** The final 16-bit conversion runs after it. | landscape 0.4, winamp-better section 1 | winamp-better section 6, mpd-audit 321 |
| 5 | Which MPD version runs? | **0.24.15.** | architecture (0.24.14), landscape and formal-verification (0.24.0) | winamp-better line 34 |

---

## 1. The FIFO is not deleted on pause or stop

**Answer.** MPD creates every FIFO output's file once, at startup, even for outputs that are switched off. It removes the file only when MPD exits, and only if MPD created it. `audio.rs:179-181` carries a comment that was never true, and architecture section 11 copied it as a measured fact.

**Source** (`FifoOutputPlugin.cxx`, v0.24.15 [S1]):
- The constructor calls `OpenFifo()` (line 70). `OpenFifo()` creates the file if missing and sets `created = true` (lines 107-114, 135-151). It then opens it twice, read-only and write-only, both non-blocking (lines 140, 145).
- The only delete is `Delete()` (lines 73-87), reached from `CloseFifo()` (89-105). `CloseFifo()` is called from the destructor (33-35) and from a failed open.
- `Open()` and `Close()` only create and destroy a `Timer` (153-163).
- I read the same file at v0.19.21, v0.20.23, v0.21, v0.21.1, v0.21.5, v0.22.9 and v0.23.17 [S2]. The delete is never in the pause path. In v0.19.21 it sits in a `Close()` that is called only from `fifo_output_finish` (lines 202-206), not from `fifo_output_close` (222-226). Versions before 0.19 were not checked.

**Measured** (pid 92091, up 12 h 19 min, now paused at 1:32):
- `/tmp/mpd.fifo` (inode 115293716) and `/tmp/headspace.fifo` (inode 115293720) were both born at 22:32:45. The MPD process started at 22:32:45. So MPD made them.
- `lsof` shows MPD holding both ends open on both files (fds 12 and 13, 14 and 15). That includes "Headspace", which `mpc outputs` reports as **disabled**.
- The `audio.rs` comment was introduced in commit `cd1d6b8` ("WMP7 Headspace skin as an MPD frontend"; found with `git log -S`). No source in that repo backs it, so it reads as an assumption.

**What this changes.** The reason "readers must chase a moving file" is gone. Pause and stop leave an empty pipe that is still open, so a reader sees "no data", never end-of-file, while MPD runs. The other reasons to drop the FIFO stand: 8 KiB deep (46 ms), MPD empties a full pipe, no backpressure, and upstream calls it an abuse. Architecture's recommendation (an in-server tap) is unaffected. Only its stated reason changes.

**Corrects:** architecture section 11, third bullet under Measured. **Confirms:** mpd-audit 1.7 and P4; hidden-problems A5 and A13.

---

## 2. Dither: it exists, but it covers less than the lanes say

**Answer.** MPD dithers only when it converts **24-bit or 32-bit integer** samples to 16-bit. It does **not** dither when the audio is float, and the resampler always produces float. So a 44.1 kHz/24-bit file is dithered on its way to the FIFO, while 96/24, 88.2/24, 48/24, 192/24 and 44.1/float files are not. This only matters while "Headspace" or "Visualizer FIFO" is the output; both are pinned to `44100:16:2`. "OS X Output" has no `format` line, so MPD gives CoreAudio whatever format the pipeline produces.

**Source** (v0.24.15):
- `FormatConverter.cxx:57-60`: converting to S16 calls `pcm_convert_to_16(buffer, dither, ...)` [S3].
- `PcmFormat.cxx:146-171` [S4]: S16 passes through. S24_P32 and S32 go through `Dither24To16` and `Dither32To16` (lines 44 and 57). **FLOAT goes to `pcm_allocate_float_to_16(buffer, src)`, which has no dither argument.**
- `Convert.cxx:38-56, 115-119` [S5]: any rate change runs the resampler first. The resampler's output format is then float, and only afterwards does the format converter run. Both resamplers set `af.format = SampleFormat::FLOAT` (`LibsamplerateResampler.cxx:75`, `SoxrResampler.cxx:226`). `mpd.conf` has no `resampler` block, so the default applies: libsamplerate (`ConfiguredResampler.cxx:44-47`).
- Float to 16-bit: the plain code truncates (`FloatConvert.hxx:25-27`, a cast). On arm64 `PcmFormat.cxx:92-100` swaps in a NEON routine (`NeonFloatTo16`: convert to a fixed-point integer, then a saturating rounding narrow). **Measured** in the installed binary: that routine is compiled in at `0x10007af00` (`fcvtzs.4s ... #0x1e` then `sqrshrn.4h ... #0xf`, from `otool -tV`). So on this Mac, float to 16-bit rounds to nearest, with no dither. The last few samples of each buffer (fewer than 16) use the truncating path.
- The algorithm (`Dither.cxx:14-44`, `Prng.hxx:11-15` [S6]) is more than triangular dither. It adds two masked values from a simple generator (triangular), plus a three-term **error feedback** (`sample += error[0] - error[1] + error[2]`), which is noise shaping.

**Port results** (my re-implementation of `Dither.cxx`, 24 to 16 bit; scripts in `/tmp/msr-followup-6/`):
- The added random term is triangular in shape. Its variance is 11,463 against 10,923 for an ideal triangle.
- The error feedback works out to a noise transfer of `1 - z^-1 + 0.5z^-2 - 0.5z^-3`. That gives -33 dB at 100 Hz, -13.5 dB at 1 kHz, about -2 to -3 dB at 5 to 10 kHz, +4 dB at 15 kHz and +9 dB at 20 kHz (44.1 kHz rate). Noise moves out of the midrange and toward the top of the band.
- Total error is about 1.0 LSB (16-bit) rms against 0.28 for plain rounding. That is about -90 dBFS. In the port, 83% of the noise power is above 15 kHz.
- **Low-bit repetition.** The generator is the common 32-bit multiply-and-add type, and its lowest 8 bits repeat every 256 samples (checked). For 24 to 16 bit, only those 8 bits are used. So the random term repeats exactly every 256 samples (5.8 ms, 172 Hz), whatever the music is. On digital silence the port's output is a repeating 256-sample pattern (autocorrelation 0.999 at a lag of 256) with spectral lines at multiples of 172 Hz, mostly between 18 and 22 kHz, at about -90 dBFS rms in total. Whether that is audible: not tested; at normal listening levels I expect not. It matters for the new server's design: use a generator whose low bits do not cycle, and two independent streams.

**Library impact.** I used mpd-audit P1's census (not re-counted). Of the 2,650 songs deeper than 16-bit: **1,161 at 44.1/24 are dithered** (plus up to 29 at 32-bit if they are at 44.1 kHz); **about 1,460 are not** (732 at 96/24, 320 at 48/24, 208 at 44.1/float, 127 at 88.2/24, 73 at 192/24). That is 44% dithered, 55% rounded without dither. The 15,697 songs already at 44.1/16/2 pass through bit for bit.

**The EQ route (headphones-today section 8, open item).** `Init.cxx:244-247` [S7]: "the convert filter must be the last one in the chain". So whatever the ffmpeg graph emits is converted by MPD afterwards, for the FIFO to 44100:16:2. **Measured** with `ffprobe` and FFmpeg 9.0.2 on `equalizer` graphs ending in MPD's own `aformat=sample_fmts=flt|s32|s16` (the string is in `lib/ffmpeg/Filter.cxx:115-119`): input s16 comes out s16, s32 comes out s32, flt comes out flt. The recommended graph in headphones-today ends in its own `aformat=sample_fmts=flt`, so it emits float, and the FIFO leg is converted undithered. The "OS X Output" leg stays float as long as the graph ends in float; `OSXOutputPlugin.cxx:673-685` describes whatever format it is handed to CoreAudio. Whether CoreAudio's own device-format choice (lines 336-343) forces a conversion: UNCONFIRMED. For the owner's headphones today none of this is audible work: the headphone path is "OS X Output".

**Corrects:** hidden-problems A4, the bullet "MPD does dither that step" (true only for 44.1k 24/32-bit). **Extends:** mpd-audit #3 and P1 (closes the UNCONFIRMED); headphones-today section 8 (closes the open item); architecture risk 7; eq-dsp 4.8 ("appears to subtract two random values": yes, and it also has error feedback and a 256-sample repeat). eq-dsp's own measurement that undithered rounding at -60 dBFS leaves a spur at -53 dB re the tone (finding F9) is the cost of the undithered path.

---

## 3. Exposure: reachable, discoverable, unauthenticated

**Answer.** Any device that can reach this Mac on its LAN address can talk to MPD on port 6600 and has full control. Nothing blocks it on the Mac, and MPD announces itself over Bonjour. The CVE the lanes cite does not apply to this version.

**Measured:**
- One listener: `netstat` shows `tcp46 *.6600 LISTEN`. In Apple's `netstat` source, "46" means an IPv6 socket that also takes IPv4 (`inet.c:415-417`) [S8]. Direct proof of IPv4: `lsof` shows the daemon's accepted socket (fd 20u) as type IPv6 carrying `127.0.0.1:6600->127.0.0.1:50184`, which `netstat` lists as `tcp4`. That peer is `rmpc`. A second client, `nowplayd`, connects over `[::1]`.
- `mpd.conf`: `bind_to_address`, `password` and `default_permissions` are all commented out (lines 85, 169, 173). The documented default is "any", and with no password every client gets all permissions [S9].
- Application firewall: `socketfilterfw` reports "Firewall is disabled (State = 0)", block-all disabled, stealth off, and incoming connections to `mpd` permitted (both the Cellar and the `opt` path). The packet filter (pf) could not be read without root (`Permission denied`): UNCONFIRMED, though pf is normally off on macOS.
- Bonjour: MPD's zeroconf defaults to yes [S9], the binary contains the registration code, and `dns-sd -B _mpd._tcp` returned "Music Player @ golems-MacBook-Pro" on interface 14, which is `en0` (192.168.0.18/24). It is discoverable, not only reachable. A second MPD host on the LAN advertises the same way.
- No client isolation to another LAN host: 192.168.0.14 answered two pings in 1 to 2 ms, and the ARP table lists several other neighbours on `en0`. Router or access-point isolation would normally show up here.

**CVE-2026-49127** (NVD, published 2026-05-28 [S10]): stack buffer overflow in `pcm_unpack_24be`, reachable by unauthenticated network attackers using two commands that point at a malicious HTTP source. CVSS 3.1 base 8.6 (`AV:N/AC:L/PR:N/UI:N`), CVSS 4.0 base 8.8. Affected: before 0.24.11. SUSE's page confirms the text and says SUSE products are not affected [S11]. The local NEWS for 0.24.11 lists "decoder pcm: fix stack buffer overflow". This machine runs 0.24.15, so it is not vulnerable to this one. The exposure itself is unchanged: with no password, a LAN device does not need a bug.

**Still open:** a connection from a second device (`nc 192.168.0.18 6600`). I did not do it, because a probe of 6600 would talk to MPD outside the read-only rule. Everything else points the same way.

**Practical note for the fix.** Binding to `127.0.0.1` alone could break `nowplayd`, which reached MPD over `[::1]` (its default address is `localhost`). The manual allows several `bind_to_address` lines [S9], so use both loopback addresses or a unix socket, and add `zeroconf_enabled "no"`. I changed nothing; that is the owner's file.

**Extends:** hidden-problems A1 (its IPv4 "[U]" is closed), mpd-audit #8 and #6. The conclusion in both stands.

---

## 4. The ffmpeg filter is in this MPD

**Answer.** Yes. Three lanes had already verified it (mpd-audit line 80, eq-dsp 2.6, headphones-today); landscape and winamp-better had not.

**Measured** on `/opt/homebrew/Cellar/mpd/0.24.15_1/bin/mpd`:
- `otool -L` links `libavfilter.12.dylib`.
- `strings` finds the plug-in's error texts (`Missing "graph" configuration`, `avfilter_graph_parse2() failed`, `avfilter_link() failed`, `avfilter_graph_config() failed`).
- `nm -u` imports `avfilter_graph_parse2`, `avfilter_graph_parse_ptr`, `avfilter_graph_config`, `avfilter_link` and `avfilter_get_by_name`.

**Source:** the plug-in is registered only under `#ifdef HAVE_LIBAVFILTER` (`Registry.cxx:19-22` [S12]). Homebrew's formula builds with `-Dffmpeg=enabled`. The "Filters: libsamplerate soxr" line in `mpd --version` lists resamplers only, so it says nothing about this plug-in.

**Run-time behavior is untested** (I cannot start MPD). Two earlier open points are now answered from source. The output's `format` **is** applied after user filters (`Init.cxx:244-247`, and `Thread.cxx:38` applies the format mask to the filter's output). This closes mpd-audit line 321's UNCONFIRMED.

**Corrects:** landscape 0.4 and its open question 1 (partly), winamp-better section 1 (line 34). **Extends:** winamp-better section 6, whose headphone pointer lists the app's sliders and macOS menu-bar apps but omits MPD's own ffmpeg-filter route, the one headphones-today recommends. mpd-audit line 321.

---

## 5. Versions: 0.24.15

**Answer.** The running daemon is MPD 0.24.15.

**Measured:**
- `lsof -p 92091` shows the executable as `/opt/homebrew/Cellar/mpd/0.24.15_1/bin/mpd`. The binary was installed 2026-08-30 11:37; the process started 2026-10-06 22:32:45. `brew list --versions mpd` says `0.24.15_1`; `mpd --version` says 0.24.15.
- The greeting `0.24.0` is a constant: `meson.build:129` sets `PROTOCOL_VERSION` to `'0.24.0'` at tag v0.24.15 [S13]. It is what `mpc version` prints and says nothing about the build.
- The database header `mpd_version: 0.24.14` is the version of the daemon that last wrote the file. The file's mtime is 2026-08-22 03:38. MPD 0.24.14 was released 2026-08-13 and 0.24.15 on 2026-08-27 (local NEWS). The upgrade came on 2026-08-30. The database simply has not been rewritten since.
- Homebrew's formula downloads the upstream v0.24.15 tarball (with a sha256) and has no patches. So the source I read at the tag is the code that runs, and the NEON routine found in the disassembly matches it.

**Corrects:** architecture (database section: "the daemon is 0.24.14"), landscape 0.1 ("MPD is 0.24.0"), formal-verification (line 72, "MPD here is 0.24.0"). **Closes:** winamp-better line 34 ("cannot tell whether the running daemon is the installed binary"). mpd-audit, hidden-problems, headphones-today and eq-dsp were right.

---

## Still UNCONFIRMED

1. A real connection to port 6600 from a second device, and the router's behavior toward it.
2. pf (the packet filter) state; it needs root to read.
3. Whether the Python port matches MPD's dither bit for bit. The source is simple and I transcribed it line by line, but I did not extract MPD's output.
4. Whether the 256-sample repeat is audible on real music.
5. Which songs are at 44.1 kHz among the 29 at 32-bit (they decide whether those are dithered).
6. Whether CoreAudio's chosen device format forces a conversion step on "OS X Output".
7. MPD's behavior on pause for versions before 0.19.
8. Run-time behavior of the ffmpeg filter inside MPD.

## Sources

- [S1] FIFO plugin, v0.24.15: https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/output/plugins/FifoOutputPlugin.cxx
- [S2] Older tags of the same file: https://github.com/MusicPlayerDaemon/MPD/blob/v0.19.21/src/output/plugins/FifoOutputPlugin.cxx , https://github.com/MusicPlayerDaemon/MPD/blob/v0.20.23/src/output/plugins/FifoOutputPlugin.cxx , https://github.com/MusicPlayerDaemon/MPD/blob/v0.23.17/src/output/plugins/FifoOutputPlugin.cxx (also v0.21, v0.21.1, v0.21.5, v0.22.9)
- [S3] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/pcm/FormatConverter.cxx
- [S4] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/pcm/PcmFormat.cxx (with `FloatConvert.hxx`, `Neon.hxx` in the same folder)
- [S5] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/pcm/Convert.cxx (with `ConfiguredResampler.cxx`, `LibsamplerateResampler.cxx`, `SoxrResampler.cxx`)
- [S6] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/pcm/Dither.cxx and `Prng.hxx` beside it
- [S7] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/output/Init.cxx and `Thread.cxx` beside it; `src/lib/ffmpeg/Filter.cxx`
- [S8] Apple `netstat`: https://github.com/apple-oss-distributions/network_cmds/blob/main/netstat.tproj/inet.c
- [S9] MPD manual, `bind_to_address` and zeroconf: https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/doc/user.rst
- [S10] NVD record: https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-49127 (human page https://nvd.nist.gov/vuln/detail/CVE-2026-49127)
- [S11] SUSE: https://www.suse.com/security/cve/CVE-2026-49127/
- [S12] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/src/filter/Registry.cxx
- [S13] https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.15/meson.build
- Local: `/opt/homebrew/Cellar/mpd/0.24.15_1/NEWS`, `brew cat mpd`, `lsof`, `netstat`, `socketfilterfw`, `dns-sd`, `otool`, `nm`, `strings`.
- Scratch: `/tmp/msr-followup-6/` (downloaded sources in `src/`, `sim.py` and `sim2.py` for the dither port, `web/` for the NVD record and disassembly).
