// The canned MPD world of `parity 4.1`, shared by the Node side (states.mjs) and the page side
// (tauri-stub.js). Plain data and no imports so both can load it.
//
// The queue content is invented for skinlab (the fixture only says "five records" and "twelve"),
// so the engine's TestHost presets `stoppedQueue5` / `stoppedQueue12` must reproduce THESE rows
// exactly, or S3 and S3b cannot match pixel for pixel. Titles vary in length on purpose: one is long
// enough to ellipsize in the 168 px drawer, one is over an hour so the h:mm:ss branch of fmtTime runs.
//
// `playing` carries no `duration` and no `song`: player.elapsed extrapolates with performance.now()
// while playing, and a duration would make the seek thumb drift between captures. With duration 0
// the thumb stays at 0 (main.js:465) and parity 4.6 still holds: pause visible, stop in its up layer.
// `currentsong` is empty in every preset, so there is no now-playing toast and no `palette` call.

const TRACKS = [
  ['Opening Titles', 127],
  ['Weightless', 222],
  ['Harbor Lights', 258],
  ['A Very Long Track Title That Will Not Fit In The Drawer', 301],
  ['Interlude', 49],
  ['Tidal', 213],
  ['Glass Garden', 372],
  ['Night Bus', 178],
  ['Paper Moons', 244],
  ['Static Bloom', 201],
  ['Long Exposure', 3725],
  ['Last Light', 287],
];

const base = { state: 'stop', volume: '50' };

/** name -> {status: object, queue: number}. A Map: preset names come from the command line. */
const PRESETS = new Map([
  ['stoppedEmpty', { status: { ...base }, queue: 0 }],
  ['stoppedQueue5', { status: { ...base, playlist: '1', playlistlength: '5', song: '1' }, queue: 5 }],
  ['stoppedQueue12', { status: { ...base, playlist: '1', playlistlength: '12', song: '1' }, queue: 12 }],
  ['playing', { status: { state: 'play', volume: '50', elapsed: '0' }, queue: 0 }],
]);

export const MEDIA_PRESET_NAMES = Object.freeze([...PRESETS.keys()]);

export const hasMediaPreset = (name) => PRESETS.has(name);

export function mediaPreset(name) {
  const p = PRESETS.get(name);
  if (!p) throw new Error(`unknown media preset "${name}" (known: ${MEDIA_PRESET_NAMES.join(', ')})`);
  return p;
}

/** `mpd status` reply: the flat [key, value] pairs player.js turns into an object. */
export const statusPairs = (name) => Object.entries(mediaPreset(name).status);

/** The queue as records, for assertions. */
export function queueRecords(name) {
  const n = mediaPreset(name).queue;
  return TRACKS.slice(0, n).map(([title, secs], i) => ({
    file: `skinlab/track-${String(i + 1).padStart(2, '0')}.flac`,
    Artist: 'Skinlab Fixture',
    Album: 'Parity Queue',
    Title: title,
    Time: String(secs),
    duration: `${secs}.000`,
    Pos: String(i),
    Id: String(i + 1),
  }));
}

/** `mpd playlistinfo` reply: flat pairs, each record starting at its `file` key. */
export const queuePairs = (name) => queueRecords(name).flatMap((r) => Object.entries(r));
