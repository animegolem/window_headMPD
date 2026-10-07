// @ts-check
// The Tauri host's DecodeExecutor (ENGINE D3, §6.2): one module Worker running src/engine/image/worker.js,
// jobs queued and run one at a time, bytes transferred in and planes transferred out.
//
// One job at a time is what makes the 2 s cap enforceable: the timer starts when a job is handed to the
// Worker, so there is exactly one job to blame when it fires. The Worker is then terminated, the job
// resolves null (a missing image), and the next job spawns a fresh Worker. A Worker that crashes or
// cannot start is handled the same way. Nothing here retries a job.
//
// The Worker is created lazily, on the first job, never at import. `createWorker` is the seam for tests
// (a `node:worker_threads` stand-in); in the app the default builds the real module Worker. The
// `new Worker(new URL(...))` spelling is the one Vite recognises and bundles.

import { decodeFailures } from '../../engine/image/worker.js';

/** @typedef {import('../../engine/contracts').DecodeExecutor} DecodeExecutor */
/** @typedef {import('../../engine/contracts').DecodeJob} DecodeJob */
/** @typedef {import('../../engine/contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../../engine/contracts').Log} Log */

/**
 * The part of the Web Worker interface the pool uses. A `node:worker_threads` wrapper in the tests
 * provides the same four members.
 * @typedef {{
 *   postMessage(message: any, transfer: ArrayBuffer[]): void,
 *   terminate(): unknown,
 *   onmessage: ((event: { data: any }) => void) | null,
 *   onerror: ((event: { message?: string }) => void) | null,
 * }} WorkerLike
 */

/**
 * @typedef {Object} DecodeExecutorOptions
 * @property {() => WorkerLike} [createWorker]  default: the module Worker for engine/image/worker.js
 * @property {number} [timeoutMs]               wall time per decode before the Worker is terminated (default 2000)
 * @property {Log} [log]                        told when a Worker is terminated or lost
 */

/** @typedef {DecodeExecutor & { dispose(): void }} WorkerDecodeExecutor */

/** Wall time for one decode, then terminate (D3, §10). */
export const DECODE_TIMEOUT_MS = 2000;

/** @returns {WorkerLike} */
const spawnModuleWorker = () => /** @type {WorkerLike} */ (/** @type {unknown} */ (new Worker(new URL('../../engine/image/worker.js', import.meta.url), { type: 'module' })));

/**
 * @param {DecodeExecutorOptions} [opts]
 * @returns {WorkerDecodeExecutor}
 */
export function createWorkerDecodeExecutor(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DECODE_TIMEOUT_MS;
  const createWorker = opts.createWorker ?? spawnModuleWorker;
  const log = opts.log;

  /** @type {WorkerLike | null} */
  let worker = null;
  /** The job the Worker is running. @type {{ id: number, job: DecodeJob, resolve: (planes: KeyedPlanes | null) => void, timer: ReturnType<typeof setTimeout> } | null} */
  let active = null;
  /** @type {Array<{ job: DecodeJob, resolve: (planes: KeyedPlanes | null) => void }>} */
  const queue = [];
  let nextId = 1;
  let disposed = false;

  /**
   * End the active job as a missing image and drop the Worker if `kill`. The reason goes where the
   * image service looks for it.
   * @param {string} code @param {string} detail @param {boolean} kill
   */
  function failActive(code, detail, kill) {
    const job = active;
    if (!job) return;
    active = null;
    clearTimeout(job.timer);
    decodeFailures.set(job.job, [{ code, detail, severity: 'error' }]);
    if (kill) discardWorker();
    log?.warn(`image decode worker: ${detail}`, { code });
    job.resolve(null);
  }

  function discardWorker() {
    const w = worker;
    worker = null; // before terminate: handlers of the old Worker check identity and go quiet
    try {
      w?.terminate();
    } catch {
      // a Worker that is already gone has nothing left to terminate
    }
  }

  /** @param {WorkerLike} from @param {{ id?: number, planes?: KeyedPlanes | null, diagnostics?: import('../../engine/contracts').Diagnostic[] }} msg */
  function onMessage(from, msg) {
    if (from !== worker || !active || msg?.id !== active.id) return; // a reply from a Worker already discarded
    const job = active;
    active = null;
    clearTimeout(job.timer);
    const planes = msg.planes ?? null;
    if (!planes && msg.diagnostics) decodeFailures.set(job.job, msg.diagnostics);
    job.resolve(planes);
    pump();
  }

  function pump() {
    if (active || disposed) return;
    const next = queue.shift();
    if (!next) return;
    try {
      if (!worker) {
        const w = createWorker();
        w.onmessage = (event) => onMessage(w, event.data);
        w.onerror = (event) => {
          if (w !== worker) return;
          failActive('image-worker-crashed', `the Worker failed${event?.message ? `: ${event.message}` : ''}`, true);
          if (!active) discardWorker(); // it died while idle; the next job gets a fresh one
          pump();
        };
        worker = w;
      }
    } catch (e) {
      decodeFailures.set(next.job, [{ code: 'image-worker-unavailable', detail: `the decode Worker could not start: ${e instanceof Error ? e.message : String(e)}`, severity: 'error' }]);
      next.resolve(null);
      pump();
      return;
    }

    const id = nextId++;
    // Transfer copies, never the caller's buffers: the VFS may hand out a view into the archive's own
    // buffer, and transferring that would detach the whole archive.
    const bytes = next.job.bytes.slice();
    /** @type {DecodeJob} */
    const sent = { bytes, key: next.job.key };
    /** @type {ArrayBuffer[]} */
    const transfer = [bytes.buffer];
    if (next.job.clipBytes) {
      const clip = next.job.clipBytes.slice();
      sent.clipBytes = clip;
      transfer.push(clip.buffer);
    }
    active = { id, job: next.job, resolve: next.resolve, timer: setTimeout(() => timedOut(id), timeoutMs) };
    try {
      worker.postMessage({ id, job: sent }, transfer);
    } catch (e) {
      failActive('image-worker-crashed', `the job could not be sent: ${e instanceof Error ? e.message : String(e)}`, true);
      pump();
    }
  }

  /** @param {number} id */
  function timedOut(id) {
    if (!active || active.id !== id) return;
    failActive('image-decode-timeout', `a decode ran longer than ${timeoutMs} ms; the Worker was terminated`, true);
    pump();
  }

  return {
    run(job) {
      return new Promise((resolve) => {
        if (disposed) {
          resolve(null);
          return;
        }
        queue.push({ job, resolve });
        pump();
      });
    },

    dispose() {
      disposed = true;
      if (active) {
        const job = active;
        active = null;
        clearTimeout(job.timer);
        job.resolve(null);
      }
      discardWorker();
      for (const q of queue.splice(0)) q.resolve(null);
    },
  };
}
