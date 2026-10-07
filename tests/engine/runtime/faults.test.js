// @ts-check
// W4.1 acceptance 1, the fault policy (E D1 "Budgets and faults"): a looping `onload` is a hard fault,
// the third hard fault unloads the view, and the shell hears about it once through
// `host.actions.fault`; after that nothing of the skin runs. Also here: realm timers on the host clock,
// the VIEW's `ontimer`, PLAYER events from media changes, and the queue's chain cap. Headless, Node.
import { describe, expect, it } from 'vitest';
import { WIDE, open, skinZip, trace, wmsOf } from './helpers.js';

/**
 * Tight enough that a loop is caught in a tenth of a second, loose enough that the trivial calls in
 * between survive a busy machine (this file runs in the parallel `unit` project).
 */
const TIGHT = Object.freeze({ ...WIDE, load: 120, handler: 120 });

describe('fault policy (E D1)', () => {
  it('turns a looping onload into a hard fault and unloads the view at the third, telling the shell once', async () => {
    const wms = wmsOf('<text id="t" left="0" top="0" width="10" height="10" value="x"/>',
      'id="v" width="200" height="100" backgroundColor="none" titleBar="false" onload="for (;;) {}"');
    const js = 'var calls = 0; function spin() { calls++; for (;;) {} } function ok() { return 7; }';
    const { host, runtime } = await open(skinZip({ wms, js }), { opts: { budgets: TIGHT } });

    expect(runtime.realmHealth.hard).toBe(1);
    expect(runtime.health.unloaded).toBe(false);
    expect(host.recorded.faults).toEqual([]);
    expect(runtime.inspector.callGlobal('ok')).toBe(7);         // one hard fault does not stop the skin

    runtime.inspector.callGlobal('spin');
    expect(runtime.realmHealth.hard).toBe(2);
    expect(runtime.health.unloaded).toBe(false);

    runtime.inspector.callGlobal('spin');
    expect(runtime.realmHealth.hard).toBe(3);
    expect(runtime.health.unloaded).toBe(true);
    expect(runtime.realmHealth.unloaded).toBe(true);
    expect(host.recorded.faults).toHaveLength(1);
    expect(host.recorded.faults[0]).toMatch(/3 hard faults/);
    expect(host.recorded.faults[0]).toMatch(/budget/);

    // Unloaded: nothing of the skin runs any more, and the shell is not told twice.
    expect(runtime.inspector.callGlobal('ok')).toBeUndefined();
    expect(runtime.inspector.readGlobal('calls')).toBeUndefined();
    host.clock.advance(100);
    await runtime.settled();
    expect(host.recorded.faults).toHaveLength(1);
    // The model is still readable: the last frame stays painted.
    expect(runtime.inspector.attr('t', 'value')).toBe('x');
  });

  it('keeps a soft fault to its own dispatch', async () => {
    const wms = wmsOf('', 'id="v" width="200" height="100" backgroundColor="none" titleBar="false" onload="nosuchfunction();"');
    const { host, runtime } = await open(skinZip({ wms, js: 'function ok() { return 1; }' }));
    expect(runtime.realmHealth.soft).toBe(1);
    expect(runtime.health.unloaded).toBe(false);
    expect(runtime.inspector.callGlobal('ok')).toBe(1);
    expect(host.recorded.faults).toEqual([]);
  });

  it('stops a ping-pong of _onchange handlers at the chain cap', async () => {
    const wms = wmsOf(`
      <text id="a" left="0" top="0" width="10" height="10" value="0" value_onchange="b.value = value + 'x';"/>
      <text id="b" left="0" top="20" width="10" height="10" value="0" value_onchange="a.value = value + 'y';"/>`);
    const { runtime } = await open(skinZip({ wms, js: "function go() { a.value = 's'; }" }));
    runtime.inspector.callGlobal('go');
    const a = String(runtime.inspector.attr('a', 'value'));
    expect(a.length).toBeLessThan(80);                            // 32 hops, not forever
    expect(runtime.diagnostics().some((d) => d.code === 'runtime-chain-cap')).toBe(true);
    expect(runtime.health.unloaded).toBe(false);
  });
});

describe('timers on the engine clock', () => {
  it('runs setTimeout and setInterval on the host clock, and clearInterval stops the interval', async () => {
    const js = `
      var once = 0, ticks = 0, id = 0;
      function start() {
        setTimeout(function () { once++; }, 50);
        id = setInterval(function () { ticks++; if (ticks === 3) clearInterval(id); }, 100);
      }`;
    const { host, runtime } = await open(skinZip({ wms: wmsOf(''), js }));
    runtime.inspector.callGlobal('start');
    host.clock.advance(40);
    expect(runtime.inspector.readGlobal('once')).toBe(0);
    host.clock.advance(20);
    expect(runtime.inspector.readGlobal('once')).toBe(1);
    host.clock.advance(1000);
    expect(runtime.inspector.readGlobal('ticks')).toBe(3);
    expect(runtime.inspector.readGlobal('once')).toBe(1);
  });

  it('drains what a timer callback queued', async () => {
    const wms = wmsOf('<text id="t" left="0" top="0" width="10" height="10" value="a" value_onchange="theme.logString(\'changed \' + value);"/>');
    const js = "function start() { setTimeout(function () { t.value = 'late'; }, 30); }";
    const { host, runtime } = await open(skinZip({ wms, js }));
    runtime.inspector.callGlobal('start');
    host.clock.advance(40);
    expect(trace(host)).toContain('skin: changed late');
  });

  it("runs the VIEW's ontimer every timerInterval ms, only while it is non-zero", async () => {
    const wms = wmsOf('', 'id="v" width="200" height="100" backgroundColor="none" titleBar="false" timerInterval="100" ontimer="ticks++;"');
    const { host, runtime } = await open(skinZip({ wms, js: 'var ticks = 0; function off() { view.timerInterval = 0; } function fast() { view.timerInterval = 20; }' }));
    host.clock.advance(350);
    expect(runtime.inspector.readGlobal('ticks')).toBe(3);
    runtime.inspector.callGlobal('fast');                         // under 50 ms: rejected, 100 stays (spec 6.2)
    host.clock.advance(100);
    expect(runtime.inspector.readGlobal('ticks')).toBe(4);
    runtime.inspector.callGlobal('off');
    host.clock.advance(500);
    expect(runtime.inspector.readGlobal('ticks')).toBe(4);
  });

  it('has no VIEW timer without an ontimer handler', async () => {
    const { host } = await open(skinZip({ wms: wmsOf('', 'id="v" width="200" height="100" backgroundColor="none" titleBar="false" timerInterval="100"') }));
    expect(host.clock.pendingTimers()).toBe(0);
  });
});

describe('PLAYER events', () => {
  it('raises PlayStateChange and ModeChange with their parameters', async () => {
    const wms = wmsOf(`<player id="p"
        PlayStateChange="theme.logString('state ' + NewState);"
        onModeChange="theme.logString('mode ' + ModeName + ' ' + NewValue);"/>`);
    const { host } = await open(skinZip({ wms }), { hostOptions: { media: 'stoppedQueue5' } });
    host.media.emit({ playState: 'play', elapsed: 0, duration: 100, song: host.media.queue()[0] });
    host.media.emit({ repeat: true });
    const lines = trace(host).filter((l) => l.startsWith('skin: '));
    expect(lines).toContain('skin: state 3');
    expect(lines).toContain('skin: mode loop true');
  });
});
