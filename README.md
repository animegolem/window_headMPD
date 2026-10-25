# window_headMPD

A music player for macOS that wears Windows Media Player 7's **Headspace**
skin: the big green head, speaker ears with drawers that slide out, and
visualizations in the face's screen. It plays your [MPD](https://www.musicpd.org/)
library, and every control on the skin works.

Before you start, know three things:

- **It runs on macOS only.** It's a [Tauri](https://tauri.app/) app built for
  macOS's shaped, click-through windows.
- **You bring the skin.** The Headspace art belongs to Microsoft, so this
  repo doesn't include it and the installer won't download it. You need your
  own `Headspace.wmz`.
- **It takes over MPD's output while it's open.** That's how the equalizer
  can be real. On quit it puts your outputs back the way they were (see
  [How the audio routing works](#how-the-audio-routing-works)).

## What works

- **Play, pause, seek, volume and playlists** go straight to MPD. The right
  drawer shows the queue or any stored playlist; double-click a track to
  play it.
- **The 10-band equalizer and the balance slider change the sound.** MPD
  plays into a FIFO, and the app runs the audio through ten peaking filters
  at WMP's own band centres before it reaches your speakers.
- **Five visualizations take their colours from the album art.** The palette
  comes from the OKLab k-means engine in
  [color-tool-kmeans](https://github.com/animegolem/color-tool-kmeans), the
  same one [RMPC-Auto-Theme](https://github.com/animegolem/RMPC-Auto-Theme)
  uses. Click the screen, press `V`, or use the ☼ button to switch.
- **The window is the shape of the head.** Clicks on the see-through parts
  land on whatever is behind it. Drag the window by the head or the ears.

## Install

You need Rust ([rustup.rs](https://rustup.rs/)), Node, Python 3 with Pillow,
MPD, and your copy of `Headspace.wmz`.

```sh
brew install node mpd
python3 -m pip install --user pillow
```

From a clone:

```sh
git clone https://github.com/animegolem/window_headMPD.git
cd window_headMPD
./install.sh ~/Downloads/Headspace.wmz
```

Or without cloning first:

```sh
curl -fsSL https://raw.githubusercontent.com/animegolem/window_headMPD/main/install.sh \
  | bash -s -- ~/Downloads/Headspace.wmz
```

`install.sh` checks the skin file first and stops with a message if it's
missing or isn't a WMP skin. Then it converts the skin, builds the app, and
copies `window_headMPD.app` into `~/Applications`. The first build compiles
the Rust side and takes a few minutes. To install somewhere else, set
`PREFIX`; to build without installing, set `NO_INSTALL=1`.

The installer doesn't edit your MPD config. To finish, add this output to
your `mpd.conf` and restart MPD (the installer prints the same block):

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

The app connects to `127.0.0.1:6600` unless `MPD_HOST` or `MPD_PORT` say
otherwise.

## Keys and menu

| Key | Does |
| --- | --- |
| Space | Play or pause |
| ← / → | Seek back or forward 5 seconds |
| ↑ / ↓ | Volume up or down 5 |
| V | Next visualization |

Right-click the head (or Control-click it) for **Keep on Top**, **Show on All
Desktops** and **Larger Size**. The app remembers both pins between launches.
The "return to full mode" button under the seek bar also switches between
normal and 1.5× size.

## How the audio routing works

When the app starts, it turns on MPD's `Headspace` output and turns off
MPD's speaker outputs (`osx` and similar). While the app is open, MPD plays
through it. When it quits, it restores exactly the outputs it changed. It
writes down what it changed before changing anything, so if the app
crashes, the next launch undoes it.

To get your speakers back without launching the app:

```sh
mpc enable "OS X Output"; mpc disable Headspace
```

If no audio device can be opened, the app falls back to monitor mode: MPD's
own output keeps playing, the visualizations still work, and the equalizer
and balance do nothing.

MPD's clock paces the FIFO and the sound card keeps its own. The app
resamples to the device's rate and adjusts the ratio by at most 0.2% to keep
about 100 ms buffered. So pause and seek take effect within that 100 ms.

## Building by hand

For development, the same steps the installer runs:

```sh
npm ci
python3 tools/convert_skin.py ~/Downloads/Headspace.wmz   # writes public/skin/ and the app icon
npx tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons
npm run tauri dev        # or: npm run tauri build
```

Pass the skin path to `tools/convert_skin.py` itself. `npm run skin -- <path>`
hands the path to the icon step instead, so it only works when your skin is
at the default `~/Downloads/Headspace.wmz`.

## Where things are

- `src/main.js` holds the skin's layout. It's ported by hand from
  `headspace.wms`, with the original coordinates.
- `src/widgets.js` rebuilds WMP's controls: button groups that find the
  button under the pointer from a colour map, and tiled sliders.
- `src/viz/` holds the visualizations (three.js).
- `src-tauri/src/` holds the MPD client, the audio engine, the equalizer,
  output routing and click-through.
- `tools/convert_skin.py` turns your `.wmz` into the PNGs the app draws.

## License

MIT for this repo's code; see [LICENSE](LICENSE). The Headspace skin is
Microsoft's and isn't covered by it.
