// @ts-check
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/engine/archive/identity.js';
import { noiseBytes } from '../../support/bytes.js';

const node = (/** @type {Uint8Array} */ b) => createHash('sha256').update(b).digest('hex');

describe('sha256Hex', () => {
  it('matches the published vectors', async () => {
    expect(await sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('agrees with node:crypto on assorted sizes, 64 lower-case hex digits each', async () => {
    for (const n of [1, 63, 64, 65, 4096, 1_000_003]) {
      const b = noiseBytes(n, n);
      const hex = await sha256Hex(b);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
      expect(hex).toBe(node(b));
    }
  });

  it('hashes the view, not the buffer behind it', async () => {
    const backing = noiseBytes(1000, 4);
    const view = backing.subarray(100, 300);
    expect(await sha256Hex(view)).toBe(node(backing.slice(100, 300)));
    expect(await sha256Hex(view)).not.toBe(node(backing));
  });

  it('accepts a Node Buffer', async () => {
    const b = /** @type {Uint8Array} */ (/** @type {unknown} */ (Buffer.from('some bytes')));
    expect(await sha256Hex(b)).toBe(node(b));
  });
});
