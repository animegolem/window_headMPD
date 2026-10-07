// @ts-check
// W4.1 acceptance 1, `settled()` (E §5.10 HostedView): it resolves only once no tween runs, nothing is
// queued and no decode is in flight. Headless, Node, on the test host's manual clock: frames come only
// from `advance`, decodes only when the held executor releases them.
import { describe, expect, it } from 'vitest';
import { bmp, createTestHost, heldExecutor, open, skinZip, trace, until, wmsOf } from './helpers.js';

/** Let real time pass: promises that could resolve, would. */
const turn = () => new Promise((r) => setTimeout(r, 5));

/** @param {Promise<unknown>} p */
function watch(p) {
  const state = { done: false };
  p.then(() => { state.done = true; });
  return state;
}

describe('settled()', () => {
  it('waits for a tween and the end-of-move handler it queues', async () => {
    const wms = wmsOf(`<subview id="s" left="0" top="0" width="10" height="10" onendmove="theme.logString('end ' + left);"/>`);
    const { host, runtime } = await open(skinZip({ wms, js: 'function go(ms) { s.moveTo(100, 0, ms); }' }));
    runtime.inspector.callGlobal('go', [120]);
    const w = watch(runtime.settled());
    await turn();
    expect(w.done).toBe(false);
    host.clock.advance(64);
    await turn();
    expect(w.done).toBe(false);
    const mid = Number(runtime.inspector.attr('s', 'left'));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
    host.clock.advance(80);
    await turn();
    expect(w.done).toBe(true);
    expect(runtime.inspector.attr('s', 'left')).toBe(100);
    expect(trace(host)).toContain('skin: end 100');
  });

  it('waits one frame after a 0 ms tween (G3)', async () => {
    const wms = wmsOf(`<subview id="s" left="0" top="0" width="10" height="10" onendmove="theme.logString('end ' + left);"/>`);
    const { host, runtime } = await open(skinZip({ wms, js: 'function go(ms) { s.moveTo(40, 0, ms); }' }));
    runtime.inspector.callGlobal('go', [0]);
    const w = watch(runtime.settled());
    await turn();
    expect(w.done).toBe(false);
    expect(trace(host)).not.toContain('skin: end 40');
    host.clock.advance(16);
    await turn();
    expect(w.done).toBe(true);
    expect(trace(host)).toContain('skin: end 40');
  });

  it('resolves at once when nothing is going on', async () => {
    const { runtime } = await open(skinZip({ wms: wmsOf('') }));
    const w = watch(runtime.settled());
    await turn();
    expect(w.done).toBe(true);
  });

  it('waits for the decodes the load asked for (attach) and for those a change asks for (settled)', async () => {
    const exec = heldExecutor();
    const host = createTestHost();
    /** @type {any} */ (host).decode = exec;
    const wms = wmsOf('<subview id="s" left="0" top="0" backgroundImage="a.bmp"/>');
    const files = { 'a.bmp': bmp(8, 4, [200, 30, 30]), 'b.bmp': bmp(8, 4, [30, 200, 30]) };
    const attaching = open(skinZip({ wms, js: "function swap() { s.backgroundImage = 'b.bmp'; }", files }), { host });
    const a = watch(attaching);
    await until(() => exec.held() > 0);                           // the preload of E §3.1 step 7
    await turn();
    expect(a.done).toBe(false);                                   // attach waits for its images
    exec.release();
    const { runtime } = await attaching;

    runtime.inspector.callGlobal('swap');
    host.clock.advance(16);                                       // the frame takes the change and asks for b.bmp
    await until(() => exec.held() > 0);
    const w = watch(runtime.settled());
    await turn();
    expect(w.done).toBe(false);
    exec.release();
    await until(() => w.done);
    expect(exec.runs).toBe(2);
  });

  it('resolves for a disposed view', async () => {
    const wms = wmsOf('<subview id="s" left="0" top="0" width="10" height="10"/>');
    const { runtime } = await open(skinZip({ wms, js: 'function go() { s.moveTo(100, 0, 1000); }' }));
    runtime.inspector.callGlobal('go');
    const w = watch(runtime.settled());
    runtime.dispose();
    await turn();
    expect(w.done).toBe(true);
  });
});
