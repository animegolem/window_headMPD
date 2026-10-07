# Follow-up 2: which headphones, which route, how far the EQ must reach

Date: 2026-10-07. Closes the critic's gap "EQ-today cannot be finished: headphone model unknown, never loaded in any MPD, scope question never asked."
Status: written without waiting for your answers, as you said. I did not start any MPD (hard rule). Nothing in your config or repos was touched.

Labels: MEASURED = I ran a read-only command on this Mac today. SOURCE = a cited page or source file. RECOMMENDATION = my advice. UNCONFIRMED = I could not check it.

## The answer

1. **You have two routes, not one.** This Mac lists two pairing records for AirPods Pro 3, possibly one set paired twice (they share one case serial number; both "Not Connected" right now), and its current default output is the wired jack ("External Headphones", 44.1 kHz). No earlier lane looked at the Bluetooth pairing list. (MEASURED, section 1.)
2. **The wired model cannot be found from the machine.** An analog plug carries no identity. Only you can say what is on the jack. This is the one real question left for AutoEq on the wired side.
3. **AirPods Pro 3 have no AutoEq file, and a fixed curve is the wrong tool for them.** Use Apple's own 3-band AirPods EQ instead (macOS 27 has it). It is stored on the AirPods and applies to every app. (Section 3.)
4. **The "filter hits whatever device is on" risk is live, not theoretical,** because AirPods can take over the default output at any time. The fix is to pin each MPD output to a named device. (Section 4, SOURCE, untested.)
5. **Your MPD can run the filter plugin.** The installed binary links libavfilter and contains the plugin's code. It is the same ffmpeg install the lanes tested with. `mpd --version` does not show this, which is misleading. (Section 2.)

## 1. What is on the machine (MEASURED)

| Item | Finding |
|---|---|
| Default output | "External Headphones", Apple, built-in, 44,100 Hz (`system_profiler SPAudioDataType`). I cannot tell whether a plug is in it at this moment. |
| Other outputs | "MacBook Pro Speakers" (44.1 kHz), "DELL S2725QC" over DisplayPort (48 kHz), a virtual "Microsoft Teams Audio" device |
| Bluetooth audio | Two paired AirPods Pro records, both with Bluetooth product ID 0x2027, sharing one case serial number (so possibly one set paired twice). Not connected. (`system_profiler SPBluetoothDataType`) |
| What 0x2027 is | **AirPods Pro 3 (2025).** macOS's own type table maps Apple Bluetooth product 8231 (= 0x2027) to `com.apple.airpods-pro-2025`, icon `airpods.pro.gen3`, model code `AirPods3,4`. File: `/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/CoreTypes-0028.bundle/Contents/Info.plist`. The same table maps 8228 to AirPods Pro 2 (USB-C), in `CoreTypes-0012.bundle`. |
| Mac and OS | MacBook Pro `Mac15,8`, M3 Max; macOS 27.0 (`sw_vers`) |
| MPD outputs now | `mpc outputs`: Visualizer FIFO on, **OS X Output on**, Headspace off (so the app is not in output mode). The `osx` block has no `device` line, so it follows the system default. |
| Wired set | Unknown. Apple's jack on 2021-or-later MacBook Pro detects impedance and drives up to 3 V RMS for 150 ohm to 1 kohm headphones, so 300-ohm studio cans are fine ([Apple 108351](https://support.apple.com/en-us/108351)). An AutoEq preamp of several dB will cost some loudness. |

## 2. Does the owner's MPD have the ffmpeg filter? Yes (MEASURED)

- `otool -L /opt/homebrew/bin/mpd` shows it links `libavfilter.12.dylib` from `/opt/homebrew/opt/ffmpeg`. The `ffmpeg` command on this Mac is 9.0.2 from the same Cellar. So "the same libavfilter MPD uses" in headphones-today is true as written.
- `strings` on the binary finds the plugin's own messages: `Missing "graph" configuration`, `avfilter_graph_parse2() failed`, `abuffer`, `abuffersink`.
- Trap: `mpd --version` prints "Filters: libsamplerate soxr". That list is the resamplers, not filter plugins. Do not read it as "no ffmpeg filter".
- `~/.cache/mpd/log` has zero filter lines (MEASURED). That fits "never loaded" but does not prove it, since MPD does not log a successful filter start at the default level.
- Still unverified without a live MPD: the filter loading in a running MPD, graph rebuild between tracks of different sample rates, and what a restart does. Section 6 is a one-command test for you to approve.

## 3. Decision (b): how far must the correction reach?

Three layers exist. Pick **one** per device, or you correct twice.

| Layer | Covers | Precision | Cost / catch |
|---|---|---|---|
| MPD `filter` block | Only what MPD plays | Exact AutoEq shapes (headphones-today section 6) | Free. Browser, video, calls untouched. |
| Apple's AirPods EQ (macOS 27) | Everything the AirPods play, any app, any device | 3 sliders (low, mid, high). Apple gives no dB range ([Apple, Mac](https://support.apple.com/en-us/120634), [Apple, AirPods guide](https://support.apple.com/guide/airpods/customize-eq-te819024i19r/web)). One forum post says the maximum cut is -6 dB (UNCONFIRMED). | Free. AirPods only. Stored on the AirPods. Models: AirPods Pro 2 or later, AirPods 4, AirPods Max 2. Not yet seen on this Mac, since the AirPods are not connected (UNCONFIRMED). |
| System-wide EQ app (SoundSource, eqMac, BlackHole + CamillaDSP) | Everything on the chosen device | Parametric; details unconfirmed per headphones-today section 7 | Paid or fiddly. This is the only way to AutoEq-correct the wired jack for browser, video and calls. |

RECOMMENDATION:
- **Wired set, today:** MPD filter. It fixes music in MPD, the thing you asked about. If browser and video also matter, add SoundSource later and remove the MPD filter that day.
- **AirPods Pro 3:** do not put an AutoEq curve in MPD. Use Apple's EQ if you want to tune them. Leave the MPD filter off on that output.
- **Calls:** a headset call drops AirPods from music mode to hands-free mode and any curve built for music is then wrong (hidden-problems S21/S22, unchanged). That holds for every layer above.

Why no fixed curve for AirPods Pro 3:
- AutoEq has no Pro 3 file. Its [index](https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/INDEX.md) lists AirPods, AirPods Pro, many AirPods Pro 2 variants, AirPods 4 and Max, and nothing for Pro 3. The repository's default branch is `master` and its last push is 2025-07-20 ([GitHub API](https://api.github.com/repos/jaakkopasanen/AutoEq), MEASURED), before Pro 3 was announced on 2025-09-09 ([Apple](https://www.apple.com/newsroom/2025/09/introducing-airpods-pro-3-the-ultimate-audio-experience/)). Pro 2 files do not describe Pro 3: reviewers measured a different shape ([SoundGuys](https://www.soundguys.com/why-you-dont-like-the-sound-of-the-apple-airpods-pro-3-146958/)).
- Pro 3 changes its own tuning with volume. SoundGuys: bass and treble "are boosted to an absurd degree as you get quieter." A fixed curve is right at one volume only. Apple also runs its own Adaptive EQ on top ([Apple](https://www.apple.com/newsroom/2025/09/introducing-airpods-pro-3-the-ultimate-audio-experience/)).
- headphones.com describes a V-shaped tuning and lists no EQ profile ([thread](https://forum.headphones.com/t/apple-airpods-pro-3-official-frequency-response-measurements-discussion-thread/26448)).

## 4. Making the filter device-safe (SOURCE: [MPD 0.24.x `OSXOutputPlugin.cxx`](https://github.com/MusicPlayerDaemon/MPD/blob/v0.24.x/src/output/plugins/OSXOutputPlugin.cxx); untested)

- No `device` line, or `device "default"`: MPD asks for macOS's "Default Output" audio unit (source: lines 130-135). Apple describes that unit as the one for the user-designated default device ([Apple, System-Supplied Audio Units](https://developer.apple.com/library/archive/documentation/MusicAudio/Conceptual/CoreAudioOverview/SystemAudioUnits/SystemAudioUnits.html)), so I expect it to follow a switch. Not tested in MPD; hidden-problems saw the same follow-the-default behaviour in the app's cpal stream. That is today's config. Connect AirPods and I expect the music to move to them with the wired curve still on.
- `device "<exact name>"`: MPD looks the device up by exact name (the name shown in Audio MIDI Setup, not a UID) when the output is enabled. If no device has that name, the output fails with "Found no audio device names" instead of falling back to the speakers. Docs: [MPD plugins](https://mpd.readthedocs.io/en/latest/plugins.html). I read the `v0.24.x` branch head; your binary is 0.24.15 (small version-drift risk).
- RECOMMENDATION, shape only (replace your `OS X Output` block):

```
audio_output { type "osx"  name "Jack"  device "External Headphones"  mixer_type "hardware"  filters "wired_eq" }
# add an AirPods output later only if you want one, with Apple's EQ and no MPD filter
```

- Only enable the output for the device in use, or MPD plays to both. This replaces headphones-today's "A/B pair on the same device".
- Renaming is safe: the only mention of `OS X Output` by name in your five repos is `window_headMPD/README.md:64`.
- The app's `Headspace` path cannot be pinned from MPD, because the app opens the system default via cpal (`audio.rs`). While the app is in output mode, EQ follows the default device (hidden-problems #3).
- UNCONFIRMED: that `"External Headphones"` is the exact name MPD sees (it compares CoreAudio's device name string exactly; `system_profiler` shows the same label, but I did not check the two against each other; read the name in Audio MIDI Setup).
- UNCONFIRMED: what MPD does at runtime when a pinned output vanishes (retry timing); whether `mpc disable` then `enable` recovers it. The source's `Enable()` re-runs the lookup, so I expect yes.

## 5. New measurement: the filter at low sample rates (MEASURED, ffmpeg only, not MPD)

headphones-today tested 44.1 to 192 kHz. I ran its exact HD 650 graph at 96, 44.1, 22.05, 16, 11.025 and 8 kHz.
- All exit code 0. At 16 kHz and below ffmpeg prints `Invalid frequency and/or width!` and skips only the filters above half the sample rate (8800 Hz and 10 kHz at 16 kHz; also 5332 Hz at 8 kHz). The rest still apply. A 3169 Hz tone drops 7.45 dB at 44.1 kHz and 7.79 dB at 8 kHz, so the filters that remain still work; the 0.3 dB difference fits the missing top filters (not isolated).
- So an 8 kHz file will not break the graph; the log will carry warnings. Whether MPD reports them as errors is UNCONFIRMED (section 6 settles it).

## 6. The one test that settles live load (needs your approval)

Prepared, not run. Everything is in `/tmp/msr-followup-2/` (will vanish on reboot; the config is short enough to recreate): `mpd-scratch.conf` (port 6601, localhost only, `null` output, its own state/log files, a graph (preamp plus 4 filters) that passes `ffmpeg` at 96 kHz and 8 kHz) and `scratch/music/t96k.flac` (96 kHz, 24-bit) and `t8k.flac` (8 kHz, 16-bit).

```
mpd --no-daemon /tmp/msr-followup-2/mpd-scratch.conf &
mpc -h 127.0.0.1 -p 6601 update --wait
mpc -h 127.0.0.1 -p 6601 add t96k.flac; mpc -h 127.0.0.1 -p 6601 add t8k.flac
mpc -h 127.0.0.1 -p 6601 play     # watch /tmp/msr-followup-2/scratch/log
mpc -h 127.0.0.1 -p 6601 kill     # stops only the scratch daemon
```

Pass means: MPD starts with the filter block, plays the 96 kHz track then the 8 kHz track to the end, and `mpc status` shows the format change with no "failed" lines in the log. It does not touch your MPD, your outputs or any sound device. It does **not** test device pinning; that needs a real device and a second, audible test.

## 7. What this corrects or extends

- **hidden-problems.md, lines 338-340: wrong.** It labels AirPods risks "Dormant" and "Dormant unless you use AirPods". AirPods Pro 3 are paired to this Mac (two records), so those two risks (call downgrade, auto-switching) are live. Line 123 ("No Bluetooth audio device is listed right now") is still true; it only means they are not connected.
- **headphones-today.md, line 247: missed for AirPods.** "macOS has no built-in system-wide EQ" was hedged as UNCONFIRMED and is true for the wired jack and for any non-AirPods device. But option 5 "Not a solution" is superseded for AirPods: macOS 27 has a 3-band EQ, stored on the AirPods (per accessory, not system-wide).
- **headphones-today.md, line 255 and line 24:** "I found no model name" stands for the wired set. Extended: the AirPods model is now known.
- **headphones-today.md, line 142 (A/B switch):** superseded by device-pinned outputs (section 4).
- **headphones-today.md, section 6 test range:** extended to 8 kHz (section 5).
- **eq-dsp.md line 19, landscape.md line 50:** HD 600 stays a placeholder. Nothing changes except that AirPods Pro 3 have no AutoEq file.
- **The critic:** right that no lane found the model; the Bluetooth half was on the machine all along. Also right that a scratch MPD is the only way to prove live load.

## 8. Needed from you

1. What is plugged into the jack (brand and model), and do you also want the music corrected on AirPods? (My advice above: Apple's EQ there, not AutoEq.)
2. Must the browser, video and calls be corrected too? If yes for the wired set, the answer is a system-wide app. If music only, the MPD filter is enough.
3. May I (or you) run the section 6 scratch test?
