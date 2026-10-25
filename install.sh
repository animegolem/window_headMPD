#!/usr/bin/env bash
# Build window_headMPD from source and install it, using your own copy of
# the Headspace skin.
#
#   ./install.sh [path/to/Headspace.wmz]
#
# Without a path it looks for ~/Downloads/Headspace.wmz. The skin art is
# Microsoft's, so this script never downloads it: you bring the file.
#
# Run from a checkout, or straight from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/animegolem/window_headMPD/main/install.sh \
#     | bash -s -- ~/Downloads/Headspace.wmz
#
# Environment:
#   PREFIX                  where the app goes (default ~/Applications)
#   WINDOW_HEADMPD_SRC      where to clone when not run from a checkout
#                           (default ~/.local/share/window_headMPD/src)
#   NO_INSTALL=1            build only; leave the app in the build folder
set -euo pipefail

REPO=https://github.com/animegolem/window_headMPD.git
PREFIX=${PREFIX:-$HOME/Applications}
APP=window_headMPD.app

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

case ${1:-} in
  -h|--help) sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

[[ $(uname -s) == Darwin ]] || die "window_headMPD runs on macOS only."

# ---- the skin: refuse early, before anything is built ----
WMZ=${1:-$HOME/Downloads/Headspace.wmz}
if [[ ! -f $WMZ ]]; then
  die "no skin at $WMZ
  Pass the path to your own Headspace.wmz (the Windows Media Player 7 skin):
    ./install.sh /path/to/Headspace.wmz
  This repo can't ship or download it: the art is Microsoft's."
fi
WMZ=$(cd "$(dirname "$WMZ")" && pwd)/$(basename "$WMZ")
python3 - "$WMZ" <<'PY' || die "$WMZ is not a WMP skin (expected a .wmz zip holding headspace.wms)."
import sys, zipfile
try:
    names = [n.lower() for n in zipfile.ZipFile(sys.argv[1]).namelist()]
except zipfile.BadZipFile:
    sys.exit(1)
sys.exit(0 if any(n.endswith("headspace.wms") for n in names) else 1)
PY

# ---- tools ----
missing=()
for tool in git node npm cargo python3; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
((${#missing[@]} == 0)) || die "missing: ${missing[*]}. Install them (Rust from rustup.rs, the rest from Homebrew) and run again."
python3 -c 'import PIL' 2>/dev/null ||
  die "the skin converter needs Pillow: python3 -m pip install --user pillow"
command -v mpd >/dev/null || printf 'note: mpd is not on PATH. The app needs a running MPD (brew install mpd).\n'

# ---- the source ----
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)
if [[ -n $HERE && -f $HERE/src-tauri/tauri.conf.json ]]; then
  SRC=$HERE
else
  SRC=${WINDOW_HEADMPD_SRC:-$HOME/.local/share/window_headMPD/src}
  if [[ -d $SRC/.git ]]; then
    step "Updating $SRC"
    git -C "$SRC" pull --ff-only
  else
    step "Cloning into $SRC"
    mkdir -p "$(dirname "$SRC")"
    git clone --depth 1 "$REPO" "$SRC"
  fi
fi
cd "$SRC"

step "Installing JavaScript dependencies"
npm ci

step "Converting your skin"
python3 tools/convert_skin.py "$WMZ"
npx tauri icon src-tauri/icons/app-icon.png -o src-tauri/icons >/dev/null

step "Building the app (the first build compiles Rust and takes a few minutes)"
npx tauri build
# Ask Cargo where it built: CARGO_TARGET_DIR or a config file can move it.
TARGET=$(cargo metadata --format-version 1 --no-deps --manifest-path src-tauri/Cargo.toml |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')
BUILT=$TARGET/release/bundle/macos/$APP
[[ -d $BUILT ]] || die "the build finished but $BUILT is missing."

if [[ ${NO_INSTALL:-} == 1 ]]; then
  printf '\nBuilt %s (not installed: NO_INSTALL=1).\n' "$BUILT"
else
  step "Installing to $PREFIX/$APP"
  mkdir -p "$PREFIX"
  STAGE=$(mktemp -d "$PREFIX/.window_headMPD.XXXXXX")
  ditto "$BUILT" "$STAGE/$APP"
  rm -rf "${PREFIX:?}/$APP"
  mv "$STAGE/$APP" "$PREFIX/$APP"
  rmdir "$STAGE"
  printf '\nInstalled %s/%s\n' "$PREFIX" "$APP"
fi

# ---- MPD: print the output block; never edit someone's mpd.conf ----
conf=""
for f in "$HOME/.config/mpd/mpd.conf" "$HOME/.mpdconf" "$HOME/.mpd/mpd.conf" \
         /opt/homebrew/etc/mpd.conf /usr/local/etc/mpd.conf; do
  [[ -f $f ]] && { conf=$f; break; }
done
if [[ -n $conf ]] && grep -q 'name[[:space:]]*"Headspace"' "$conf"; then
  printf 'MPD: %s already has the Headspace output.\n' "$conf"
else
  cat <<EOF

One step left. Add this output to ${conf:-your mpd.conf}, then restart MPD:

audio_output {
	type		"fifo"
	name		"Headspace"
	path		"/tmp/headspace.fifo"
	format		"44100:16:2"
	mixer_type	"software"
	enabled		"no"
}
EOF
fi
