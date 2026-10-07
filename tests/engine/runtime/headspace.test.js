// @ts-check
// W4.1 acceptance 4 and a headless walk through the owner's Headspace (skips without the fixture): the
// load and attach time under the test host is printed (target < 250 ms on the owner's Mac; reported,
// not gated), the S1 frame and mask are the VIEW's 760x394, the skin's own `ToggleEqView` opens the
// ear, the sidecar's compat entry moves `reset`, and the inspector's points land inside the parts the
// demo tour aims at. Nothing derived from the art is written anywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../../src/engine/index.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../../src/engine/options.js';
import { createTestHost } from '../../../src/hosts/test/index.js';
import { REPO_ROOT, describeHeadspace } from '../../support/fixtures.js';

/** The sidecar named by the archive's SHA-256 (W3.8), read as the shell would hand it over. @param {string} sha */
function sidecarOf(sha) {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'app', 'sidecars', `${sha}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The legacy capture's seed (tools/skinlab/engine-mount.js): preset 1, a flat EQ. */
const SEED = { mediacenter: { effectPreset: '1' }, app: { eq: JSON.stringify(Array(10).fill(0)), balance: '0' } };

describeHeadspace('Headspace on the view runtime', (headspace) => {
  /**
   * @param {import('../../../src/engine/contracts').EngineOptions} config
   */
  async function boot(config) {
    const bytes = headspace.bytes();
    const host = createTestHost({ media: 'stoppedEmpty', seed: SEED, dsp: { gains: Array(10).fill(0), balance: 0 } });
    const engine = createEngine(host, config);
    const t0 = performance.now();
    const probe = await engine.load(bytes, { name: 'Headspace.wmz' });
    const sidecar = sidecarOf(probe.sha);
    probe.dispose();
    const t1 = performance.now();
    const skin = await engine.load(bytes, { name: 'Headspace.wmz', ...(sidecar ? { sidecar } : {}) });
    const runtime = await skin.attach();
    const t2 = performance.now();
    host.clock.advance(500);
    await runtime.settled();
    return { host, skin, runtime, ms: { probe: t1 - t0, load: t2 - t1 } };
  }

  it('loads and attaches, and prints the time it took', async () => {
    const cold = await boot(FAITHFUL);
    const warm = await boot(FAITHFUL);
    // Straight to stderr as well: a reporter that keeps passing tests quiet must not hide the number.
    const line = `Headspace load + attach under the test host (headless): first ${cold.ms.load.toFixed(1)} ms, again ${warm.ms.load.toFixed(1)} ms (target < 250 ms; reported, not gated)`;
    console.log(line);
    process.stderr.write(`${line}\n`);
    expect(warm.runtime.health).toEqual({ soft: 0, hard: 0, unloaded: false });
    expect(warm.host.recorded.faults).toEqual([]);
    expect(warm.skin.views()).toEqual([expect.objectContaining({ width: 760, height: 394, main: true })]);
    expect(warm.host.window.recorded.initialSizes).toEqual([{ w: 760, h: 394 }]);
    const shape = warm.runtime.maskShape();
    expect([shape.width, shape.height]).toEqual([760, 394]);
  });

  it("opens the EQ ear through the skin's own ToggleEqView (S2b) and keeps the frame 760 wide", async () => {
    const { host, runtime } = await boot(FAITHFUL);
    expect(runtime.inspector.readGlobal('eqIsOpen')).toBe(false);
    expect(runtime.inspector.attr('sEqEar', 'left')).toBe(207);
    runtime.inspector.callGlobal('ToggleEqView');
    host.clock.advance(60);
    const mid = Number(runtime.inspector.attr('sEqEar', 'left'));
    expect(mid).toBeGreaterThanOrEqual(102);                       // parity: the ear is at about 103 at 60 ms
    expect(mid).toBeLessThanOrEqual(105);
    host.clock.advance(500);
    await runtime.settled();
    expect(runtime.inspector.readGlobal('eqIsOpen')).toBe(true);
    expect(runtime.inspector.attr('sEqEar', 'left')).toBe(0);
    expect(runtime.inspector.attr('sEqView', 'visible')).toBe(true);  // EqOnEndMove ran
    expect(runtime.maskShape().width).toBe(760);
  });

  it('puts reset at 127 in faithful and 129 in oracle-compat (parity D20)', async () => {
    const faithful = await boot(FAITHFUL);
    const compat = await boot(ORACLE_COMPAT);
    expect(faithful.runtime.inspector.attr('Unnamed_text_4', 'top')).toBe(127);
    expect(compat.runtime.inspector.attr('Unnamed_text_4', 'top')).toBe(129);
  });

  it('aims the tour inside the transport and on the band thumbs', async () => {
    const { runtime } = await boot(FAITHFUL);
    const ins = runtime.inspector;
    const transport = /** @type {import('../../../src/engine/contracts').Rect} */ (ins.rectOf('Unnamed_buttongroup_2'));
    expect(transport).toEqual({ x: 309, y: 31, w: 144, h: 25 });   // parity 0.5
    for (const color of ['#FFFF00', '#0000FF']) {
      const p = /** @type {{ x: number, y: number }} */ (ins.groupPoint('Unnamed_buttongroup_2', color));
      expect(p.x).toBeGreaterThanOrEqual(transport.x);
      expect(p.x).toBeLessThan(transport.x + transport.w);
      expect(p.y).toBeGreaterThanOrEqual(transport.y);
      expect(p.y).toBeLessThan(transport.y + transport.h);
    }
    const band = /** @type {import('../../../src/engine/contracts').Rect} */ (ins.rectOf('eq1'));
    const top = /** @type {{ x: number, y: number }} */ (ins.sliderThumbPoint('eq1', 14));
    const bottom = /** @type {{ x: number, y: number }} */ (ins.sliderThumbPoint('eq1', -14));
    expect(top.y).toBeLessThan(bottom.y);
    expect(top.y).toBeGreaterThan(band.y);
    expect(bottom.y).toBeLessThan(band.y + band.h);
    expect(top.x).toBe(band.x + band.w / 2);
  });
});

describe('Headspace fixture', () => {
  it('is optional: the suite above skips without it', () => {
    expect(typeof describeHeadspace).toBe('function');
  });
});
