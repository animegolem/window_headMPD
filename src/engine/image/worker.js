// @ts-check
// The decode job runner and the Worker entry (ENGINE D3, §5.4, §6.1).
//
// `runDecodeJob` is the one place a decode job becomes keyed planes: decode the bytes, decode the
// clipping image when the job carries one, key. The inline executor in service.js (Node tests, the
// test host) and the Tauri Worker both call it, so the two give byte-identical planes by construction.
// It lives here rather than in service.js so the Worker bundle carries the decoders and the keyer and
// nothing else (service.js pulls in the wmploc string table).
//
// Message protocol, one job per message:  { id, job }  ->  { id, planes }
//   - `planes` is the KeyedPlanes (its typed arrays are transferred, not copied) or null for a missing
//     image. A null reply also carries `diagnostics`: the decoder's reasons, which the contract's
//     `DecodeExecutor.run` has no channel for (see `decodeFailures`).
//   - The bytes in `job` arrive in buffers the host transferred; the Worker owns them.
//
// Importing this module anywhere but inside a Worker is inert: the message listener is attached only
// when the global scope is a WorkerGlobalScope. There is no test hook here.

import { decodeImageWithDiagnostics } from './decode/index.js';
import { keyImage } from './keying.js';

/** @typedef {import('../contracts').DecodeJob} DecodeJob */
/** @typedef {import('../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */

/**
 * Why a job ended as a missing image. `DecodeExecutor.run` resolves null for it and has nowhere to put
 * the reason, so an executor records it here, keyed by the job object it was handed, and the image
 * service reads it back to write its one diagnostic ("bmp: end of data inside a command" instead of
 * "could not be decoded"). A WeakMap: the entry dies with the job.
 * @type {WeakMap<DecodeJob, Diagnostic[]>}
 */
export const decodeFailures = new WeakMap();

/**
 * Decode and key one job. Never throws: any failure is a null result with the reason in `diagnostics`.
 * Decoder warnings on a success (alpha dropped from a 32-bit BMP, a clipped RLE stream) ride on
 * `planes.diagnostics` together with the keyer's own.
 * @param {DecodeJob} job
 * @returns {{ planes: KeyedPlanes | null, diagnostics: Diagnostic[] }}
 */
export function runDecodeJob(job) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  try {
    const main = decodeImageWithDiagnostics(job.bytes);
    diagnostics.push(...main.diagnostics);
    if (!main.image) return { planes: null, diagnostics };

    let clipImg = null;
    if (job.clipBytes) {
      const clip = decodeImageWithDiagnostics(job.clipBytes);
      for (const d of clip.diagnostics) diagnostics.push({ ...d, detail: `clipping image: ${d.detail}` });
      clipImg = clip.image; // null here makes keyImage report the clipping image as not supplied
    }

    const planes = keyImage(main.image, job.key, clipImg);
    if (planes.diagnostics) diagnostics.push(...planes.diagnostics);
    if (diagnostics.length) planes.diagnostics = diagnostics;
    return { planes, diagnostics };
  } catch (e) {
    // keyImage allocates from the image size; a decoder slip or an allocation failure is a missing image
    diagnostics.push({ code: 'image-decode-error', detail: e instanceof Error ? e.message : String(e), severity: 'error' });
    return { planes: null, diagnostics };
  }
}

/**
 * The buffers of a result, each once, for a transfer list (a buffer named twice makes
 * `postMessage` throw).
 * @param {KeyedPlanes} planes
 * @returns {ArrayBuffer[]}
 */
export function transferablesOf(planes) {
  /** @type {Set<ArrayBufferLike>} */
  const buffers = new Set([planes.rgba.buffer, planes.paint.buffer, planes.hit.buffer]);
  if (planes.clip) buffers.add(planes.clip.buffer);
  return /** @type {ArrayBuffer[]} */ ([...buffers]);
}

/**
 * One request to one reply, plus what to transfer back. The Worker entry below is a thin wrapper, so
 * a test can drive the protocol from any thread.
 * @param {{ id: number, job: DecodeJob }} request
 * @returns {{ response: { id: number, planes: KeyedPlanes | null, diagnostics?: Diagnostic[] }, transfer: ArrayBuffer[] }}
 */
export function handleDecodeRequest(request) {
  const { planes, diagnostics } = runDecodeJob(request.job);
  if (!planes) return { response: { id: request.id, planes: null, diagnostics }, transfer: [] };
  return { response: { id: request.id, planes }, transfer: transferablesOf(planes) };
}

// The Worker entry. `globalThis` is typed as a Window under the DOM lib, which has neither
// `WorkerGlobalScope` nor the `{ transfer }` form of `postMessage`, so go through `any`.
const scope = /** @type {any} */ (globalThis);
if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope) {
  scope.addEventListener('message', (/** @type {MessageEvent} */ event) => {
    const { response, transfer } = handleDecodeRequest(event.data);
    scope.postMessage(response, { transfer });
  });
}
