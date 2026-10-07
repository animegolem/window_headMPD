// @ts-check
// Shared pieces of the view-runtime tests (W4.1): synthetic skins zipped from strings and BMPs, a test
// host, wide realm budgets, and a decode executor that holds its jobs. Everything is synthetic: no skin
// art. Not a test file (vitest collects only *.test.js).

import { createInlineExecutor } from '../../../src/engine/image/service.js';
import { createEngine } from '../../../src/engine/index.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createTestHost } from '../../../src/hosts/test/index.js';
import { buildBmp } from '../../support/bmp-writer.js';
import { buildZip } from '../../support/zip-writer.js';

/**
 * These tests run in the parallel `unit` project, where a scheduler stall during a trivial handler would
 * become a hard budget fault (the reason the realm's own timing tests run sequentially, G2). The budget
 * tests pass tight budgets of their own.
 * @type {import('../../../src/engine/contracts').RealmBudgets}
 */
export const WIDE = Object.freeze({ scripts: 10_000, load: 5000, handler: 2000, expr: 2000, exprPass: 5000 });

/** A 24-bit BMP of one colour, or of `pixel(x, y)`. @param {number} w @param {number} h @param {number[] | ((x: number, y: number) => number[])} fill */
export function bmp(w, h, fill) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = typeof fill === 'function' ? fill(x, y) : fill;
      rgba.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return buildBmp({ width: w, height: h, bpp: 24, rgba }).bytes;
}

/**
 * A `.wms` with one VIEW.
 * @param {string} body the markup inside the VIEW
 * @param {string} [viewAttrs]
 */
export const wmsOf = (body, viewAttrs = 'id="v" width="200" height="100" backgroundColor="none" titleBar="false"') =>
  `<THEME>\r\n<VIEW ${viewAttrs}>\r\n${body}\r\n</VIEW>\r\n</THEME>\r\n`;

/**
 * Zip a synthetic skin: `skin.wms`, `skin.js` when a script is given, and any other files.
 * @param {{ wms: string, js?: string, files?: Record<string, Uint8Array | string> }} spec
 * @returns {Uint8Array}
 */
export function skinZip(spec) {
  /** @type {Array<{ name: string, data: Uint8Array | string }>} */
  const entries = [{ name: 'skin.wms', data: spec.wms }];
  if (spec.js !== undefined) entries.push({ name: 'skin.js', data: spec.js });
  for (const [name, data] of Object.entries(spec.files ?? {})) entries.push({ name, data });
  return buildZip(entries);
}

/**
 * A decode executor that holds every job until `release()`.
 * @returns {import('../../../src/engine/contracts').DecodeExecutor & { held(): number, release(): void, runs: number }}
 */
export function heldExecutor() {
  const inline = createInlineExecutor();
  /** @type {Array<() => void>} */
  const held = [];
  const exec = {
    runs: 0,
    run(/** @type {import('../../../src/engine/contracts').DecodeJob} */ job) {
      exec.runs++;
      return new Promise((resolve) => { held.push(() => resolve(inline.run(job))); });
    },
    held: () => held.length,
    release() { while (held.length) /** @type {() => void} */ (held.shift())(); },
  };
  return /** @type {any} */ (exec);
}

/** Wait for a condition the engine reaches on its own (real time, small steps). @param {() => boolean} cond */
export async function until(cond, ms = 2000) {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > ms) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Load a synthetic skin through the real engine on a test host and attach its view.
 * @param {Uint8Array} bytes
 * @param {{ host?: ReturnType<typeof createTestHost>, hostOptions?: Parameters<typeof createTestHost>[0],
 *   opts?: Partial<import('../../../src/engine/contracts').EngineOptions>, sidecar?: any, name?: string, attach?: boolean }} [o]
 */
export async function open(bytes, o = {}) {
  const host = o.host ?? createTestHost(o.hostOptions);
  const engine = createEngine(host, { budgets: WIDE, ...(o.opts ?? {}) });
  const skin = await engine.load(bytes, { name: o.name ?? 'skin.wmz', ...(o.sidecar ? { sidecar: o.sidecar } : {}) });
  const runtime = o.attach === false ? null : await skin.attach();
  return { host, skin, runtime: /** @type {import('../../../src/engine/view-runtime.js').AttachedView} */ (runtime) };
}

/** The `engine: …` and `skin: …` log lines, in order. @param {ReturnType<typeof createTestHost>} host */
export const trace = (host) => host.recorded.logs.map((l) => l.message).filter((m) => m.startsWith('engine: ') || m.startsWith('skin: '));

export { FAITHFUL, createTestHost };
