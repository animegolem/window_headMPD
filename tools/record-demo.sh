#!/bin/zsh
# Record a promo clip: the app's scripted demo tour (src/demo.js) plus its
# own soundtrack, i.e. exactly what it sent to the speakers.
#
#   tools/record-demo.sh [out.mp4]
#
# Brings the app to the front, screen-records its window, triggers the tour
# over MPD's message channel, then trims at the sync flash and muxes.
set -euo pipefail
HERE=${0:A:h}
OUT=${1:-$PWD/window_headmpd-demo.mp4}
WORK=$(mktemp -d)
LEN=39.2        # seconds kept after the flash
PAD=0.2         # skip the flash itself

PID=$(pgrep -x window_head_mpd | head -1)
osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $PID) to true"
sleep 2
read X Y W H <<< "$(swift "$HERE/window-bounds.swift" "$PID")"
echo "window at $X,$Y ${W}x$H"

screencapture -x -v -V 45 -R"$X,$Y,$W,$H" "$WORK/raw.mov" &
CAP=$!
sleep 1.5
mpc sendmessage window_head "demo $WORK/sound.wav"
wait $CAP
until [[ -s $WORK/sound.wav ]]; do sleep 0.5; done

# The flash: first frame whose mean luma jumps way up.
FLASH=$(ffmpeg -hide_banner -i "$WORK/raw.mov" -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 |
  awk '/pts_time/ { split($0, a, "pts_time:"); t = a[2] + 0 } /YAVG/ { split($0, b, "="); if (b[2] + 0 > 200) { print t; exit } }')
[[ -n $FLASH ]] || { echo "no sync flash found in $WORK/raw.mov" >&2; exit 1; }
echo "sync flash at ${FLASH}s"

ffmpeg -hide_banner -loglevel error -y \
  -ss "$(( FLASH + PAD ))" -t $LEN -i "$WORK/raw.mov" \
  -ss $PAD -t $LEN -i "$WORK/sound.wav" \
  -map 0:v -map 1:a -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k -movflags +faststart "$OUT"
echo "wrote $OUT"
