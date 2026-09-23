# window_headMPD

An [MPD](https://www.musicpd.org/) frontend for macOS that wears the Windows
Media Player 7 **Headspace** skin: the big green head, the speaker ears
with drawers that slide out, and three.js visualizations in the face's screen.

Everything works, not just the chrome:

- **Transport, seek, volume and playlists** talk to MPD directly. The right
  drawer shows the queue or any stored playlist; double-click to play.
- **The 10-band graphic EQ and the balance slider are real.** The app becomes
  MPD's speaker. MPD plays into a FIFO, and the app runs the audio through ten
  peaking biquads at WMP's own band centres before sending it to the sound
  card.
- **Visualizations** get their colours from the current album art, using the
  OKLab k-means engine from
  [color-tool-kmeans](https://github.com/animegolem/color-tool-kmeans) (the
  same one RMPC-Auto-Theme uses). Click the screen or use the chooser (the
  ☼ button) to switch between them.
- **The window is shaped like the head.** Clicks on transparent pixels pass
  through to whatever is behind it, and you drag the window by the head or
  the ears.

## Setup

You need Rust, Node, MPD, and your own copy of `Headspace.wmz`. The skin art
is Microsoft's, so this repo doesn't include it.

```sh
npm install
npm run skin -- ~/Downloads/Headspace.wmz   # extracts art + builds app icons
```

Add the app's output to `mpd.conf` and restart MPD:

```text
audio_output {
	type		"fifo"
	name		"Headspace"
	path		"/tmp/headspace.fifo"
	format		"44100:16:2"
	mixer_type	"software"
	enabled		"no"
}
```

Then run it:

```sh
npm run tauri dev      # or: npm run tauri build  -> src-tauri/target/release/bundle/macos/
```

`MPD_HOST` / `MPD_PORT` are honoured; the default is `127.0.0.1:6600`.

## How the audio routing works

On launch the app turns on the `Headspace` output and turns off MPD's
local-speaker outputs (`osx` and similar). While the app is open, MPD plays
through it. On quit it restores exactly what it changed. What it changed is
written to disk first, so if the app crashes, the next launch undoes it. If
you need your speakers back without relaunching:

```sh
mpc enable "OS X Output"; mpc disable Headspace
```

If no audio device can be opened, the app falls back to monitor mode:
MPD's own output keeps playing, the visuals still work, and the EQ and
balance do nothing.

The FIFO is paced by MPD's clock and the sound card by its own. The output
stream resamples to the device's rate and adjusts the ratio by at most 0.2%
to keep about 100 ms buffered. Pause and seek take effect within that
buffer.

## Keys

Space play/pause · ←/→ seek 5 s · ↑/↓ volume · V next visualization.
The "return to full mode" button under the seek bar toggles the size
between 1× and 1.5×.

## Layout

The skin's `headspace.wms` layout is ported by hand into `src/main.js`, and
the coordinates are the original ones. `src/widgets.js` reimplements WMP's
controls: button groups with colour hit-maps, and tiled sliders.
`src-tauri/src` holds the MPD client, the audio engine, the EQ, output
routing, and click-through.
