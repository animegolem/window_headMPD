// @ts-check
// 5F.6 (b), E D6.7: every soft-fault site reaches the coverage ledger as a `soft-fault` entry, named by
// its site with the element's id in place of the realm's handle number. Headless, Node; synthetic skins.
import { describe, expect, it } from 'vitest';
import { WIDE, open, skinZip, wmsOf } from './helpers.js';

/** @param {import('../../../src/engine/contracts').LedgerEntry[]} entries */
const softFaults = (entries) => new Map(entries.filter((e) => e.kind === 'soft-fault').map((e) => [e.api, e]));

describe('soft faults in the ledger', () => {
  it('records handlers, expressions, scripts and timers by site', async () => {
    const wms = wmsOf(`
      <button id="b" left="0" top="0" width="10" height="10" onclick="nosuch();"/>
      <text id="t" left="jscript:undefinedThing.x" top="0" width="10" height="10" value="x"/>`,
    'id="v" width="200" height="100" backgroundColor="none" titleBar="false" onload="alsoMissing();"');
    const js = 'function boom() { setTimeout(function () { throw new Error("late"); }, 10); }';
    const { runtime, skin } = await open(skinZip({ wms, js: `${js}\nthis is not javascript` }));
    let found = softFaults(skin.ledger());
    expect(found.get('handler v.onload')?.detail).toMatch(/alsoMissing/);
    expect(found.get('expr t.left')?.detail).toMatch(/undefinedThing/);
    expect(found.get('script skin.js')?.detail).toMatch(/SyntaxError/);

    // A syntax error stops the whole file, so the functions come from a second skin.
    const second = await open(skinZip({ wms: wmsOf('<button id="b" left="0" top="0" width="10" height="10" onclick="nosuch();"/>'), js }));
    second.runtime.inspector.callGlobal('boom');
    second.host.clock.advance(20);
    await second.runtime.settled();
    found = softFaults(second.skin.ledger());
    expect(found.get('timer')?.detail).toMatch(/late/);
    expect(runtime.realmHealth.soft).toBe(3);
  });

  it('counts a site once per reason the realm reports, and takes element ids as plain strings', async () => {
    const wms = wmsOf(`
      <text id="__proto__" left="0" top="0" width="10" height="10" value="a" value_onchange="missingA();"/>
      <text id="constructor" left="0" top="20" width="10" height="10" value="b" value_onchange="missingB();"/>`);
    const { runtime, skin } = await open(skinZip({ wms }));
    runtime.inspector.setAttr('__proto__', 'value', 'z');
    runtime.inspector.setAttr('__proto__', 'value', 'y');     // the same site and reason: reported once
    runtime.inspector.setAttr('constructor', 'value', 'z');
    await runtime.settled();
    expect(runtime.realmHealth.soft).toBe(3);
    const found = softFaults(skin.ledger());
    expect(found.get('handler __proto__.value_onchange')).toMatchObject({ kind: 'soft-fault', count: 1 });
    expect(found.get('handler __proto__.value_onchange')?.detail).toMatch(/missingA/);
    expect(found.get('handler constructor.value_onchange')?.detail).toMatch(/missingB/);
    expect(found.size).toBe(2);
  });

  it('records the runtime chain cap under the handler that hit it', async () => {
    const wms = wmsOf(`
      <text id="a" left="0" top="0" width="10" height="10" value="0" value_onchange="b.value = value + 'x';"/>
      <text id="b" left="0" top="20" width="10" height="10" value="0" value_onchange="a.value = value + 'y';"/>`);
    const { runtime, skin } = await open(skinZip({ wms, js: 'function kick() { a.value = "go"; }' }));
    runtime.inspector.callGlobal('kick');
    await runtime.settled();
    const entry = [...softFaults(skin.ledger()).values()].find((e) => /chain deeper than/.test(e.detail ?? ''));
    expect(entry?.api).toMatch(/^handler [ab]\.value_onchange$/);
  });
});

describe('the drain cap (5F.8)', () => {
  // The count branch of the cap: 4096 dispatches in one drain. The wall-clock branch shares its message
  // and its ledger line, but `wallClock` is bound when the module loads and `budgets.load` also bounds
  // the prelude, so a test cannot shrink it without breaking the load.
  const wms = wmsOf(`
    <text id="a" left="0" top="0" width="10" height="10" value="0" value_onchange="na++; b.value = 'from ' + value;"/>
    <text id="b" left="0" top="20" width="10" height="10" value="0" value_onchange="nb++;"/>`);
  const js = `var na = 0, nb = 0;
function kick() { for (var i = 0; i < 4100; i++) a.value = 'v' + i; }`;

  it('records the dropped dispatches under the queue site and ends the drain', async () => {
    const { runtime, skin } = await open(skinZip({ wms, js }), { opts: { budgets: { ...WIDE, load: 120_000 } } });
    runtime.inspector.callGlobal('kick');
    await runtime.settled();

    // 4096 `a` events wait (the model's own cap), each queues a `b` event behind the ones already
    // waiting, and the drain stops at 4096 dispatches with every `b` event still queued.
    const na = /** @type {number} */ (runtime.inspector.readGlobal('na'));
    const nb = /** @type {number} */ (runtime.inspector.readGlobal('nb'));
    expect(na).toBe(4096);
    expect(nb).toBe(0);

    const entry = softFaults(skin.ledger()).get('queue');
    expect(entry).toMatchObject({ kind: 'soft-fault', api: 'queue', count: 1 });
    expect(entry?.detail).toMatch(/queued dispatches ran over 120000 ms or 4096 dispatches/);
    const caps = runtime.diagnostics().filter((d) => d.code === 'runtime-drain-cap');
    expect(caps).toHaveLength(1);
    expect(caps[0].severity).toBe('warn');
    expect(runtime.health.unloaded).toBe(false);
    expect(runtime.health.hard).toBe(0);

    // What was dropped is gone, not postponed: the next gesture starts from an empty queue.
    runtime.inspector.callGlobal('kick');
    await runtime.settled();
    expect(runtime.inspector.readGlobal('na')).toBe(4096 + 4096);
    expect(softFaults(skin.ledger()).get('queue')).toMatchObject({ count: 1 });                  // the same reason at a site is one entry
    expect(runtime.diagnostics().filter((d) => d.code === 'runtime-drain-cap')).toHaveLength(1);   // reported once per view
  });
});
