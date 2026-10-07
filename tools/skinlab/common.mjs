// Small pieces shared by the commands: argument parsing, the golden key's inputs, run ids, reports.

import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { usageError } from './exit.mjs';
import { oraclePin } from './pins.mjs';
import { EMULATED_MASKS } from './states.mjs';
import { HARNESS_VERSION, goldenKey } from './store.mjs';

/** parseArgs with a usage error (exit 2) instead of a stack trace. */
export function parseOptions(argv, options) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
    return { values, positionals };
  } catch (e) {
    throw usageError(e.message);
  }
}

/** The one place that decides `--target`: only the legacy exists in this task. */
export function requireLegacyTarget(value, { required }) {
  if (value === undefined) {
    if (required) throw usageError('--target legacy is required');
    return 'legacy';
  }
  if (value === 'engine') throw usageError('--target engine arrives with the engine side of skinlab (W2.7)');
  if (value !== 'legacy') throw usageError(`unknown --target "${value}" (only "legacy" exists here)`);
  return 'legacy';
}

export const runId = (cmd, now = new Date()) => `${now.toISOString().replace(/[:.]/g, '-')}-${cmd}`;

/** Everything in the key that is not the state and the DPR. */
export async function keyInputs({ fixture, chromium }) {
  return { skinSha256: fixture.sha256, oraclePin: await oraclePin(), chromiumRevision: chromium.revision, harnessVersion: HARNESS_VERSION };
}

export const legacyKey = (inputs, state, dpr) => goldenKey({ target: 'legacy', state, dpr, ...inputs });

const sha1Hex = (b) => createHash('sha1').update(b).digest('hex');
const n = (x) => x.toLocaleString('en-US');
const box = (b) => (b ? `(${b.x0},${b.y0})-(${b.x1},${b.y1})` : 'empty');
const same = (a, b) => a && b && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;

/**
 * Live mask popcounts and bounding boxes next to parity 4.1's emulated numbers (open question 9).
 * Differences are flagged, never failed: the live oracle wins, and Opus records it at G0.
 * @param {{state:string, dpr:number, popcount:number, bbox:object|null, maskBits:Buffer, maskSha256:string}[]} captures
 */
export function maskReport(captures) {
  const lines = ['hit mask, live vs parity 4.1 emulation (flags only, never a failure):'];
  const sw = Math.max(6, ...captures.map((c) => c.state.length + 1)); // S5.g1.play.hover is wider than S3b
  lines.push(`  ${'state'.padEnd(sw)}${'dpr'.padEnd(5)}${'live'.padStart(9)}  ${'bbox'.padEnd(22)}${'emulated'.padStart(9)}  ${'delta'.padStart(7)}  note`);
  const firstMask = new Map();
  for (const c of captures) {
    const ref = EMULATED_MASKS.get(c.state);
    const notes = [];
    let emu = '-';
    let delta = '-';
    if (!ref) notes.push('no reference');
    else {
      emu = n(ref.popcount);
      delta = c.popcount - ref.popcount === 0 ? '0' : `${c.popcount - ref.popcount > 0 ? '+' : ''}${n(c.popcount - ref.popcount)}`;
      if (c.popcount !== ref.popcount) notes.push('DIFFERS: popcount');
      if (!same(c.bbox, ref.bbox)) notes.push(`DIFFERS: bbox, emulated ${box(ref.bbox)}`);
      if (c.popcount === ref.popcount && !sha1Hex(c.maskBits).startsWith(ref.bitsSha1Prefix)) notes.push('DIFFERS: same count, different bits');
    }
    const prior = firstMask.get(c.state);
    if (prior === undefined) firstMask.set(c.state, c.maskSha256);
    else if (prior !== c.maskSha256) notes.push('DIFFERS from the first dpr');
    lines.push(`  ${c.state.padEnd(sw)}${String(c.dpr).padEnd(5)}${n(c.popcount).padStart(9)}  ${box(c.bbox).padEnd(22)}${emu.padStart(9)}  ${delta.padStart(7)}  ${notes.join('; ')}`);
  }
  return lines.join('\n');
}
