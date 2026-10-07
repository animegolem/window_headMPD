// @ts-check
// The Tauri decode Worker pool (W2.4), against a `node:worker_threads` stand-in for the Worker. The
// stand-in runs the real engine/image/worker.js job runner in a real thread, so a hanging decode can
// really be terminated and the planes really cross a thread boundary by transfer.
//
// The boot script is evaluated (`eval: true`) so the stand-in needs no file of its own. The hang and the
// crash are in that script, never in src/: the shipped worker has no test hook.
//
// Every image is synthetic (tests/support writers): no skin art.

import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { createImageService, createInlineExecutor } from '../../../src/engine/image/service.js';
import { decodeFailures, handleDecodeRequest, runDecodeJob } from '../../../src/engine/image/worker.js';
import { DECODE_TIMEOUT_MS, createWorkerDecodeExecutor } from '../../../src/hosts/tauri/decode.js';
import { buildBmp } from '../../support/bmp-writer.js';
import { buildGif } from '../../support/gif-writer.js';
import { buildPng } from '../../support/png-writer.js';
import { buildZip } from '../../support/zip-writer.js';

const WORKER_URL = new URL('../../../src/engine/image/worker.js', import.meta.url).href;
const MAGENTA = 0xff00ff;
const GREEN = 0x00ff00;

// What the Worker scope would be: the stand-in imports worker.js and answers messages with the same
// handleDecodeRequest the shipped entry calls. `mode` is the test's fault injection.
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then(({ handleDecodeRequest }) => {
  parentPort.on('message', (request) => {
    if (workerData.mode === 'hang') for (;;) {}
    if (workerData.mode === 'crash') throw new Error('stand-in crash');
    const { response, transfer } = handleDecodeRequest(request);
    parentPort.postMessage(response, transfer);
  });
});
`;

// The real entry: a worker whose global scope looks like a WorkerGlobalScope, so worker.js wires its own
// message listener, and the `{ transfer }` form of postMessage that a real Worker accepts.
const ENTRY_BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
class WorkerGlobalScope {}
globalThis.WorkerGlobalScope = WorkerGlobalScope;
Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
globalThis.postMessage = (message, options) => {
  parentPort.postMessage({ message, transferCount: options.transfer.length }, options.transfer);
};
import(workerData.url);
`;

/** @type {Array<{ inner: NodeWorker }>} */
const everSpawned = [];
afterEach(async () => {
  await Promise.all(everSpawned.splice(0).map((w) => w.inner.terminate()));
});

/**
 * The slice of the Web Worker interface the pool uses, over a worker_threads Worker.
 * @param {{ mode?: 'hang' | 'crash' | 'normal', boot?: string }} [opts]
 */
function standIn(opts = {}) {
  const inner = new NodeWorker(opts.boot ?? BOOT, { eval: true, workerData: { url: WORKER_URL, mode: opts.mode ?? 'normal' } });
  /** @type {any} */
  const w = {
    inner,
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: (/** @type {any} */ message, /** @type {ArrayBuffer[]} */ transfer) => inner.postMessage(message, transfer),
    terminate() {
      w.terminated = true;
      return inner.terminate();
    },
  };
  inner.on('message', (data) => w.onmessage?.({ data }));
  inner.on('error', (error) => w.onerror?.({ message: error.message }));
  everSpawned.push(w);
  return w;
}

/** A pool whose Workers are stand-ins; `modes[n]` is the mode of the nth Worker spawned. @param {Array<'hang' | 'crash' | 'normal'>} [modes] @param {object} [more] */
function poolOf(modes = [], more = {}) {
  /** @type {any[]} */
  const spawned = [];
  /** @type {string[]} */
  const warns = [];
  const pool = createWorkerDecodeExecutor({
    createWorker: () => {
      const w = standIn({ mode: modes[spawned.length] ?? 'normal' });
      spawned.push(w);
      return w;
    },
    log: { info() {}, warn: (m) => { warns.push(m); }, diag() {} },
    ...more,
  });
  return { pool, spawned, warns };
}

/** @param {number[][]} px */
const rgbaOf = (px) => Uint8Array.from(px.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
/** @param {number} w @param {number} h @param {Record<number, number[]>} [special] @param {number} [grey] */
const bmp = (w, h, special = {}, grey = 90) => buildBmp({ width: w, height: h, bpp: 24, rgba: rgbaOf(Array.from({ length: w * h }, (_, i) => special[i] ?? [grey, grey, grey])) }).bytes;

/** @param {any} a @param {any} b */
function expectSamePlanes(a, b) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  for (const f of ['rgba', 'paint', 'hit']) {
    expect(a[f].constructor, f).toBe(b[f].constructor);
    expect(Buffer.compare(Buffer.from(a[f].buffer, a[f].byteOffset, a[f].byteLength), Buffer.from(b[f].buffer, b[f].byteOffset, b[f].byteLength)), f).toBe(0);
  }
  if (b.clip === null) expect(a.clip).toBeNull();
  else expect(Buffer.compare(Buffer.from(a.clip), Buffer.from(b.clip))).toBe(0);
  expect(a.diagnostics).toEqual(b.diagnostics);
}

const jobs = () => {
  const png = buildPng({ width: 3, height: 2, colorType: 6, bitDepth: 8, samples: [255, 0, 255, 255, 10, 20, 30, 128, 1, 2, 3, 0, 4, 5, 6, 255, 255, 0, 255, 255, 7, 8, 9, 10] }).bytes;
  const gif = buildGif({ width: 6, height: 6, palette: [[255, 0, 255], [0, 200, 0], [0, 0, 200], [9, 9, 9]], frames: [{ indices: Uint8Array.from({ length: 36 }, (_, i) => (i * 7 + (i >> 3)) & 3) }] }).bytes;
  const alpha32 = buildBmp({ width: 2, height: 1, bpp: 32, alpha: 'source', rgba: rgbaOf([[10, 20, 30, 128], [40, 50, 60, 200]]) }).bytes;
  return /** @type {Array<[string, import('../../../src/engine/contracts').DecodeJob]>} */ ([
    ['bmp keyed', { bytes: bmp(7, 5, { 0: [255, 0, 255], 9: [255, 0, 255] }), key: { transparency: MAGENTA, hitKeyed: false } }],
    ['bmp keyed, keyed pixels hit', { bytes: bmp(7, 5, { 0: [255, 0, 255], 9: [255, 0, 255] }), key: { transparency: MAGENTA, hitKeyed: true } }],
    ['bmp auto', { bytes: bmp(4, 4, { 0: [1, 2, 3], 5: [1, 2, 3] }), key: { transparency: 'auto', hitKeyed: false } }],
    ['png alpha and key', { bytes: png, key: { transparency: MAGENTA, hitKeyed: true } }],
    ['gif frame 0', { bytes: gif, key: { transparency: MAGENTA, hitKeyed: false } }],
    ['clipped by a second image', { bytes: bmp(5, 3), clipBytes: bmp(5, 3, { 2: [0, 255, 0], 7: [0, 255, 0] }), key: { clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false } }],
    ['clip image is not a picture', { bytes: bmp(5, 3), clipBytes: new TextEncoder().encode('nope'), key: { clipping: GREEN, clipImage: 'mask.bmp', hitKeyed: false } }],
    ['32-bit bmp with a decoder warning', { bytes: alpha32, key: { hitKeyed: false } }],
  ]);
};

describe('the Worker pool and the inline executor give the same planes', () => {
  it.each(jobs().map(([name]) => [name]))('%s', async (name) => {
    const job = /** @type {any} */ (jobs().find(([n]) => n === name))[1];
    const inline = await createInlineExecutor().run(structuredClone(job));
    const { pool, spawned } = poolOf();
    const viaWorker = await pool.run(job);
    expect(inline).not.toBeNull();
    expect(viaWorker).not.toBeNull();
    expectSamePlanes(viaWorker, inline);
    expect(spawned).toHaveLength(1);
    pool.dispose();
  });

  it('a file that cannot be decoded is null from both, with the same reason', async () => {
    const job = { bytes: new TextEncoder().encode('not an image'), key: { hitKeyed: false } };
    const inlineJob = structuredClone(job);
    expect(await createInlineExecutor().run(inlineJob)).toBeNull();
    const { pool } = poolOf();
    expect(await pool.run(job)).toBeNull();
    expect(decodeFailures.get(job)).toEqual(decodeFailures.get(inlineJob));
    expect(decodeFailures.get(job)?.[0].code).toBe('image-unknown-format');
    pool.dispose();
  });

  it('is what the image service sees: the same keyed planes through either executor', async () => {
    const vfs = await openVfs(buildZip([{ name: 'a.bmp', data: bmp(6, 4, { 3: [255, 0, 255] }) }, { name: 'bad.bmp', data: new TextEncoder().encode('x') }]), 't.zip');
    const diags = /** @type {any[]} */ ([]);
    const log = { info() {}, warn() {}, diag: (/** @type {any} */ d) => diags.push(d) };
    const { pool } = poolOf();
    const a = createImageService(vfs, createInlineExecutor(), log);
    const b = createImageService(vfs, pool, log);
    const spec = { transparency: MAGENTA, hitKeyed: true };
    expectSamePlanes(await b.load('a.bmp', spec), await a.load('a.bmp', spec));
    expect(await b.load('bad.bmp', spec)).toBeNull();
    expect(diags.filter((d) => d.file === 'bad.bmp').map((d) => d.code)).toEqual(['image-unknown-format']);
    pool.dispose();
  });
});

describe('transfer', () => {
  it('never detaches the caller bytes, even a view into a larger buffer (the VFS hands those out)', async () => {
    const image = bmp(4, 4);
    const archive = new Uint8Array(image.length + 64).fill(7); // the "archive": the image sits inside it
    archive.set(image, 32);
    const view = archive.subarray(32, 32 + image.length);
    const clipImage = bmp(4, 4, { 0: [0, 255, 0] });
    const clipHolder = new Uint8Array(clipImage.length + 8);
    clipHolder.set(clipImage, 4);
    const clipView = clipHolder.subarray(4, 4 + clipImage.length);

    const { pool } = poolOf();
    const planes = /** @type {any} */ (await pool.run({ bytes: view, clipBytes: clipView, key: { clipping: GREEN, clipImage: 'm.bmp', hitKeyed: false } }));
    expect(planes).not.toBeNull();
    expect(planes.clip).not.toBeNull();
    expect(archive.buffer.byteLength).toBe(archive.length); // not detached
    expect(clipHolder.buffer.byteLength).toBe(clipHolder.length);
    expect(view.length).toBe(image.length);
    expect(clipView.length).toBe(clipImage.length);
    // and the same job can be sent again
    expectSamePlanes(await pool.run({ bytes: view, clipBytes: clipView, key: { clipping: GREEN, clipImage: 'm.bmp', hitKeyed: false } }), planes);
    pool.dispose();
  });

  it('the planes that come back are owned by the caller: ordinary, writable typed arrays', async () => {
    const { pool } = poolOf();
    const planes = /** @type {any} */ (await pool.run({ bytes: bmp(3, 3), key: { hitKeyed: false } }));
    expect(planes.rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(planes.rgba.buffer.byteLength).toBe(36);
    planes.rgba[0] = 1;
    expect(planes.rgba[0]).toBe(1);
    pool.dispose();
  });
});

describe('queueing', () => {
  it('runs jobs one at a time on one Worker and answers each with its own planes', async () => {
    const { pool, spawned } = poolOf();
    const sizes = [[2, 2], [3, 5], [8, 1], [4, 4], [6, 2], [1, 9]];
    const results = await Promise.all(sizes.map(([w, h]) => pool.run({ bytes: bmp(w, h), key: { hitKeyed: false } })));
    expect(results.map((r) => [r?.width, r?.height])).toEqual(sizes);
    expect(spawned).toHaveLength(1);
    pool.dispose();
  });

  it('does not create the Worker until the first job', async () => {
    const { pool, spawned } = poolOf();
    expect(spawned).toHaveLength(0);
    await pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } });
    await pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } });
    expect(spawned).toHaveLength(1);
    pool.dispose();
  });

  it('without a Worker to build, a job is a missing image with a reason, not an exception', async () => {
    // the default factory builds a module Worker, which Node does not have
    expect(typeof (/** @type {any} */ (globalThis).Worker)).toBe('undefined');
    const pool = createWorkerDecodeExecutor();
    const job = { bytes: bmp(2, 2), key: { hitKeyed: false } };
    expect(await pool.run(job)).toBeNull();
    expect(decodeFailures.get(job)?.[0].code).toBe('image-worker-unavailable');
    pool.dispose();
  });

  it('a factory that throws loses that job only; the next job tries again', async () => {
    let calls = 0;
    const real = poolOf();
    const pool = createWorkerDecodeExecutor({
      createWorker: () => {
        if (calls++ === 0) throw new Error('no thread for you');
        const w = standIn();
        real.spawned.push(w);
        return w;
      },
    });
    expect(await pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } })).toBeNull();
    expect(await pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } })).not.toBeNull();
    expect(calls).toBe(2);
    pool.dispose();
  });
});

describe('the 2 s cap', () => {
  it('is 2000 ms', () => {
    expect(DECODE_TIMEOUT_MS).toBe(2000);
  });

  it('a hanging decode is terminated after 2 s, the image is missing, and the next job runs on a fresh Worker', { timeout: 20_000 }, async () => {
    // the first Worker hangs on whatever it is given; no timeoutMs passed: this is the default cap
    const { pool, spawned, warns } = poolOf(['hang']);
    const hung = { bytes: bmp(3, 3), key: { hitKeyed: false } };
    const t0 = performance.now();
    const result = await pool.run(hung);
    const elapsed = performance.now() - t0;
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(5000);
    expect(spawned[0].terminated).toBe(true);
    expect(decodeFailures.get(hung)?.[0].code).toBe('image-decode-timeout');
    expect(warns.join('\n')).toContain('2000 ms');

    const next = { bytes: bmp(3, 3, { 0: [255, 0, 255] }), key: { transparency: MAGENTA, hitKeyed: false } };
    const planes = await pool.run(next);
    expect(spawned).toHaveLength(2); // a fresh Worker
    expect(spawned[1].terminated).toBe(false);
    expect(planes).not.toBeNull();
    expectSamePlanes(planes, await createInlineExecutor().run(structuredClone(next)));
    pool.dispose();
    expect(spawned[1].terminated).toBe(true);
  });

  it('jobs queued behind a hung one wait their turn and then run on the fresh Worker', { timeout: 20_000 }, async () => {
    const { pool, spawned } = poolOf(['hang'], { timeoutMs: 1000 });
    const hung = pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } });
    const behind = [pool.run({ bytes: bmp(3, 3), key: { hitKeyed: false } }), pool.run({ bytes: bmp(4, 4), key: { hitKeyed: false } })];
    expect(await hung).toBeNull();
    const done = await Promise.all(behind);
    expect(done.map((p) => [p?.width, p?.height])).toEqual([[3, 3], [4, 4]]);
    expect(spawned).toHaveLength(2);
    pool.dispose();
  });

  it('through the image service: the image is missing with one diagnostic, never retried, and others still load', { timeout: 20_000 }, async () => {
    const vfs = await openVfs(buildZip([{ name: 'slow.bmp', data: bmp(3, 3) }, { name: 'ok.bmp', data: bmp(4, 4, { 0: [255, 0, 255] }) }]), 't.zip');
    const diags = /** @type {any[]} */ ([]);
    const { pool, spawned } = poolOf(['hang'], { timeoutMs: 1000 });
    const svc = createImageService(vfs, pool, { info() {}, warn() {}, diag: (d) => diags.push(d) });
    const spec = { transparency: MAGENTA, hitKeyed: false };

    expect(await svc.load('slow.bmp', spec)).toBeNull();
    expect(svc.get('slow.bmp', spec)).toBeNull();
    expect(svc.pending()).toBe(0); // the failure is remembered, so a frame loop does not re-hang the Worker
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'image-decode-timeout', file: 'slow.bmp', severity: 'error' });
    expect(spawned).toHaveLength(1);

    const ok = /** @type {any} */ (await svc.load('ok.bmp', spec));
    expect(ok.rgba[3]).toBe(0);
    expect(spawned).toHaveLength(2);
    expect(diags).toHaveLength(1);
    pool.dispose();
  });
});

describe('a Worker that dies', () => {
  it('a crash mid-job is a missing image, and the next job gets a fresh Worker', async () => {
    const { pool, spawned, warns } = poolOf(['crash']);
    const job = { bytes: bmp(3, 3), key: { hitKeyed: false } };
    expect(await pool.run(job)).toBeNull();
    expect(decodeFailures.get(job)?.[0].code).toBe('image-worker-crashed');
    expect(decodeFailures.get(job)?.[0].detail).toContain('stand-in crash');
    expect(warns.length).toBeGreaterThan(0);
    expect(spawned[0].terminated).toBe(true);
    expect(await pool.run({ bytes: bmp(3, 3), key: { hitKeyed: false } })).not.toBeNull();
    expect(spawned).toHaveLength(2);
    pool.dispose();
  });
});

describe('dispose', () => {
  it('terminates the Worker and resolves everything outstanding as missing, at once', async () => {
    const { pool, spawned } = poolOf(['hang']);
    const t0 = performance.now();
    const all = [1, 2, 3].map((n) => pool.run({ bytes: bmp(n + 1, 2), key: { hitKeyed: false } }));
    await new Promise((r) => setTimeout(r, 50)); // let the first job reach the Worker
    pool.dispose();
    expect(await Promise.all(all)).toEqual([null, null, null]);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].terminated).toBe(true);
    // after dispose nothing is spawned and nothing hangs
    expect(await pool.run({ bytes: bmp(2, 2), key: { hitKeyed: false } })).toBeNull();
    expect(spawned).toHaveLength(1);
  });
});

describe('the Worker entry and its message protocol', () => {
  it('handleDecodeRequest: { id, job } -> { id, planes }, each buffer to transfer listed once', () => {
    const job = { bytes: bmp(5, 4, { 0: [255, 0, 255] }), clipBytes: bmp(5, 4, { 1: [0, 255, 0] }), key: { transparency: MAGENTA, clipping: GREEN, clipImage: 'm.bmp', hitKeyed: true } };
    const { response, transfer } = handleDecodeRequest({ id: 41, job });
    expect(response.id).toBe(41);
    const planes = /** @type {any} */ (response.planes);
    expect(planes.clip).not.toBeNull();
    expect(transfer).toHaveLength(4);
    expect(new Set(transfer).size).toBe(4);
    expect(new Set(transfer)).toEqual(new Set([planes.rgba.buffer, planes.paint.buffer, planes.hit.buffer, planes.clip.buffer]));
    expectSamePlanes(planes, /** @type {any} */ (runDecodeJob(job).planes));
    // no clip plane: three buffers
    const { transfer: three } = handleDecodeRequest({ id: 1, job: { bytes: bmp(2, 2), key: { hitKeyed: false } } });
    expect(three).toHaveLength(3);
  });

  it('a job that cannot be decoded answers with null planes and the reasons', () => {
    const { response, transfer } = handleDecodeRequest({ id: 9, job: { bytes: Uint8Array.from([1, 2, 3]), key: { hitKeyed: false } } });
    expect(response).toMatchObject({ id: 9, planes: null });
    expect(response.diagnostics?.[0].code).toBe('image-unknown-format');
    expect(transfer).toEqual([]);
  });

  it('runDecodeJob never throws: a hostile spec is a null result with a diagnostic', () => {
    const out = runDecodeJob(/** @type {any} */ ({ bytes: bmp(2, 2), key: null }));
    expect(out.planes).toBeNull();
    expect(out.diagnostics[0].code).toBe('image-decode-error');
  });

  it('inside a WorkerGlobalScope the module attaches its own listener and replies with { transfer }', async () => {
    const w = standIn({ boot: ENTRY_BOOT });
    const reply = new Promise((resolve, reject) => {
      w.inner.once('message', resolve);
      w.inner.once('error', reject);
    });
    const job = { bytes: bmp(4, 3, { 0: [255, 0, 255] }), key: { transparency: MAGENTA, hitKeyed: false } };
    // the entry is attached after the dynamic import resolves, so retry the request until it answers
    const sent = setInterval(() => w.inner.postMessage({ id: 5, job: { ...job, bytes: job.bytes.slice() } }), 20);
    /** @type {any} */
    const got = await reply.finally(() => clearInterval(sent));
    expect(got.message.id).toBe(5);
    expect(got.transferCount).toBe(3);
    expectSamePlanes(got.message.planes, /** @type {any} */ (runDecodeJob(job).planes));
  });
});
