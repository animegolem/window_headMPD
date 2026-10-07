// @ts-check
// The Tauri AudioFrameBus (ENGINE.md §5.6, D11): `audio_subscribe` over a Tauri `Channel`. The Rust
// side fans every frame out to each subscriber, so a subscription here is one channel and one Rust
// subscriber of its own; two subscriptions (two Viz instances, a skin plus the visualizer) do not
// steal each other's frames, which is the `parity 3.2` bug the fan-out fixes.
//
//  - The command takes `{ onFrame: Channel, opts: { pcm } }` and returns the subscriber id that
//    `audio_unsubscribe({ id })` takes. The id arrives asynchronously, so an unsubscribe that comes
//    first is remembered and sent when the id lands, and frames stop being delivered at once.
//  - A frame is `{ bands, wave, level }` with plain arrays (serde); the contract wants typed arrays.
//    `pcm` is passed on only to a subscriber that asked for it (phase 2; the Rust side includes it
//    only for those anyway). A malformed frame is dropped, not delivered half-built.
//
// `Channel` and `invoke` are arguments, so this file loads in Node. `index.js` supplies Tauri's.

/** @typedef {import('../../engine/contracts').AudioFrameBus} AudioFrameBus */
/** @typedef {import('../../engine/contracts').AudioFrame} AudioFrame */
/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {(cmd: string, args?: any) => Promise<unknown> | unknown} InvokeFn */
/** @typedef {new () => { onmessage: (frame: any) => void }} ChannelCtor Tauri's `Channel` */
/** @typedef {{ invoke: InvokeFn, Channel: ChannelCtor, log?: Pick<Log, 'warn'> }} TauriAudioOptions */
/** @typedef {AudioFrameBus & { subscribers(): number }} TauriAudio */

/** @param {unknown} v @returns {v is ArrayLike<number>} */
const isNumbers = (v) => Array.isArray(v) || ArrayBuffer.isView(v);

/**
 * One Rust frame as the contract's AudioFrame, or null when it is not one.
 * @param {unknown} raw @param {boolean} wantsPcm
 * @returns {AudioFrame | null}
 */
export function toAudioFrame(raw, wantsPcm) {
  if (!raw || typeof raw !== 'object') return null;
  const { bands, wave, level, pcm } = /** @type {Record<string, unknown>} */ (raw);
  if (!isNumbers(bands) || !isNumbers(wave) || typeof level !== 'number') return null;
  /** @type {AudioFrame} */
  const frame = { bands: Float32Array.from(bands), wave: Float32Array.from(wave), level };
  if (wantsPcm && isNumbers(pcm)) frame.pcm = Uint8Array.from(pcm);
  return frame;
}

/** @param {TauriAudioOptions} opts @returns {TauriAudio} */
export function createTauriAudio(opts) {
  const { invoke, Channel } = opts;
  /** @param {string} m @param {object} [d] */
  const warn = (m, d) => {
    if (opts.log) opts.log.warn(m, d);
    else console.warn(m, d);
  };
  let live = 0;

  return {
    subscribers: () => live,

    subscribe(subOpts, cb) {
      const wantsPcm = !!subOpts?.pcm;
      let active = true;
      /** The Rust subscriber id once it is known. @type {number | null} */
      let id = null;
      const channel = new Channel();
      channel.onmessage = (raw) => {
        if (!active) return;
        const frame = toAudioFrame(raw, wantsPcm);
        if (!frame) return;
        try { cb(frame); } catch (e) { warn(`audio: a frame callback threw: ${e instanceof Error ? e.message : String(e)}`); }
      };
      live++;

      /** @param {number} n */
      const release = (n) => {
        try {
          Promise.resolve(invoke('audio_unsubscribe', { id: n })).catch(() => {});
        } catch { /* the app is going away */ }
      };

      /** @type {Promise<unknown>} */
      let subscribed;
      try {
        subscribed = Promise.resolve(invoke('audio_subscribe', { onFrame: channel, opts: { pcm: wantsPcm } }));
      } catch (e) {
        subscribed = Promise.reject(e);
      }
      subscribed.then(
        (got) => {
          if (typeof got !== 'number') return;
          if (active) id = got;
          else release(got);                                 // unsubscribed while the id was in flight
        },
        (e) => { warn(`audio: audio_subscribe failed: ${e instanceof Error ? e.message : String(e)}`); },
      );

      return () => {
        if (!active) return;
        active = false;
        live--;
        channel.onmessage = () => {};
        if (id !== null) release(id);
      };
    },
  };
}
