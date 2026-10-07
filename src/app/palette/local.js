// @ts-check
// The `local` palette tier (ENGINE.md §5.9, D12): today's Rust `palette` command (OKLab k-means over
// the song's cover art, `lib.rs:162-201`) wrapped into a PaletteSnapshot. No roles and no
// guarantees: only the artifact tier (phase 2) can honestly claim either.
//
// The reply is Rust's `Swatch[]`, already dominance-ordered: `{hex, share, oklch: [L, C, h]}`. It is
// checked rather than trusted, because a malformed reply must end in the default palette and not in
// a NaN inside the visualizer.

/** @typedef {import('../../engine/contracts').PaletteSnapshot} PaletteSnapshot */
/** @typedef {PaletteSnapshot['clusters'][number]} Cluster */
/** @typedef {(cmd: string, args?: Record<string, unknown>) => Promise<unknown>} Invoke the Tauri `invoke`, or a stand-in */

/** The Rust command's name. */
export const LOCAL_COMMAND = 'palette';

const HEX = /^#[0-9a-f]{6}$/i;
/** @param {unknown} n */
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The usable swatches of a `palette` reply, as frozen clusters in the reply's order. An entry that
 * is not `{hex: '#rrggbb', share: finite >= 0, oklch: [3 finite numbers]}` is dropped; hex is
 * lower-cased.
 * @param {unknown} reply
 * @returns {Cluster[]}
 * @throws {TypeError} when nothing usable is left (not an array, empty, or every entry malformed):
 *   the caller treats that like a rejected call, which is what the visualizer does with an empty reply
 */
export function clustersFromReply(reply) {
  if (!Array.isArray(reply)) throw new TypeError('palette reply is not an array');
  /** @type {Cluster[]} */
  const out = [];
  for (const s of reply) {
    if (s === null || typeof s !== 'object') continue;
    const { hex, share, oklch } = /** @type {Record<string, unknown>} */ (s);
    if (typeof hex !== 'string' || !HEX.test(hex)) continue;
    if (!finite(share) || /** @type {number} */ (share) < 0) continue;
    if (!Array.isArray(oklch) || oklch.length !== 3 || !oklch.every(finite)) continue;
    out.push(Object.freeze({
      hex: hex.toLowerCase(),
      oklch: /** @type {[number, number, number]} */ (Object.freeze([oklch[0], oklch[1], oklch[2]])),
      share: /** @type {number} */ (share),
    }));
  }
  if (out.length === 0) throw new TypeError('palette reply has no usable swatches');
  return out;
}

/**
 * Ask the Rust side for the palette of one song's cover art.
 * @param {Invoke} invoke
 * @param {string} file the song's MPD path, as `MediaState.song.file`
 * @param {() => number} [now] epoch milliseconds, stamped into `track.generatedAt`
 * @returns {Promise<PaletteSnapshot>} source `local`, association `current-uri`, `roles` null, no guarantees
 * @throws rejects when the call rejects, or the reply has no usable swatch
 */
export async function fetchLocalPalette(invoke, file, now = Date.now) {
  const clusters = clustersFromReply(await invoke(LOCAL_COMMAND, { file }));
  return Object.freeze({
    source: /** @type {const} */ ('local'),
    association: /** @type {const} */ ('current-uri'),
    track: Object.freeze({ uri: file, generatedAt: new Date(now()).toISOString() }),
    roles: null,
    guarantees: Object.freeze([]),
    clusters: Object.freeze(clusters),
  });
}
