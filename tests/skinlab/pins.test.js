import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PINNED_FILES, oraclePin, pinDigests } from '../../tools/skinlab/pins.mjs';

let root;

/** A tree with all eleven pinned files, each with its own content. */
function makeTree() {
  const dir = mkdtempSync(path.join(tmpdir(), 'skinlab-pins-'));
  PINNED_FILES.forEach((f, i) => {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), `// fake ${f}\n${'x'.repeat(i + 3)}\n`);
  });
  return dir;
}

beforeEach(() => {
  root = makeTree();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('PINNED_FILES', () => {
  it('is the eleven files of parity line 18, in that order', () => {
    expect([...PINNED_FILES]).toEqual([
      'src/main.js',
      'src/widgets.js',
      'src/player.js',
      'src/playlist.js',
      'src/style.css',
      'src/viz/index.js',
      'src/demo.js',
      'src-tauri/tauri.conf.json',
      'src-tauri/src/lib.rs',
      'src-tauri/src/clickthrough.rs',
      'tools/convert_skin.py',
    ]);
    expect(Object.isFrozen(PINNED_FILES)).toBe(true);
  });
});

describe('oraclePin', () => {
  it('is 64 hex characters and stable', async () => {
    const a = await oraclePin(root);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await oraclePin(root)).toBe(a);
  });

  it('changes when any one pinned file changes by a single byte', async () => {
    const base = await oraclePin(root);
    const seen = new Set([base]);
    for (const f of PINNED_FILES) {
      const file = path.join(root, f);
      const original = readFileSync(file);
      const flipped = Buffer.from(original);
      flipped[0] ^= 1;
      writeFileSync(file, flipped);
      const changed = await oraclePin(root);
      expect(changed, f).not.toBe(base);
      seen.add(changed);
      writeFileSync(file, original);
      expect(await oraclePin(root), `${f} restored`).toBe(base);
    }
    expect(seen.size).toBe(PINNED_FILES.length + 1); // every file moves the pin to its own value
  });

  it('changes when a byte is appended', async () => {
    const base = await oraclePin(root);
    writeFileSync(path.join(root, 'src/style.css'), `${readFileSync(path.join(root, 'src/style.css'), 'utf8')}\n`);
    expect(await oraclePin(root)).not.toBe(base);
  });

  it('depends on the order of the files', async () => {
    const forward = await oraclePin(root, PINNED_FILES);
    const reversed = await oraclePin(root, [...PINNED_FILES].reverse());
    expect(reversed).not.toBe(forward);
  });

  it('cannot be fooled by moving a byte across a file boundary', async () => {
    const a = path.join(root, 'src/main.js');
    const b = path.join(root, 'src/widgets.js');
    writeFileSync(a, 'AAAB');
    writeFileSync(b, 'CCC');
    const before = await oraclePin(root);
    writeFileSync(a, 'AAA');
    writeFileSync(b, 'BCCC');
    expect(await oraclePin(root)).not.toBe(before);
  });

  it('names the missing file instead of hashing around it', async () => {
    rmSync(path.join(root, 'src/demo.js'));
    await expect(oraclePin(root)).rejects.toThrow('pinned file is missing: src/demo.js');
  });
});

describe('pinDigests', () => {
  it('lists each file with its own sha256 and size', async () => {
    const digests = await pinDigests(root);
    expect(digests.map((d) => d.file)).toEqual([...PINNED_FILES]);
    for (const d of digests) {
      const data = readFileSync(path.join(root, d.file));
      expect(d.bytes).toBe(data.length);
      expect(d.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});
