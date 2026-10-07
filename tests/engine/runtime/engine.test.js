// @ts-check
// The composition root (E §5.10, D10.6, D12): options, the `SkinHost` seam, the sidecar applied in its
// three places (overlays at build, `attrs` after layout, `compat` only under oracle-compat), the ledger,
// and a view's end (`onclose`, nothing it queues runs). Headless, Node.
import { describe, expect, it } from 'vitest';
import { openVfs } from '../../../src/engine/archive/vfs.js';
import { WmsSkinHost, createEngine, createWmsSkinHost, resolveOptions } from '../../../src/engine/index.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../../src/engine/options.js';
import { buildZip } from '../../support/zip-writer.js';
import { WIDE, createTestHost, open, skinZip, trace, wmsOf } from './helpers.js';

const SIDE_WMS = wmsOf(`
  <subview id="panel" left="0" top="0" width="100" height="50">
    <text id="label" left="2" top="3" width="40" height="10" value="x" fontSize="10"/>
    <text id="constructor" left="2" top="20" width="40" height="10" value="y"/>
  </subview>
  <slider id="seek" left="0" top="60" width="100" height="10" min="0" max="10"/>`);

/** @param {string} sha @param {object} [extra] */
const sidecarFor = (sha, extra = {}) => ({
  schema: 'window_headmpd-sidecar/1',
  skin: sha,
  overlays: [{ parent: 'panel', tag: 'text', attrs: { left: 50, top: 3, width: 20, value: 'ov' } }],
  attrs: [
    { ref: 'label', name: 'top', value: 7 },
    { ref: 'seek', name: 'x-foregroundMode', value: 'playhead' },
    { ref: 'constructor', name: 'value', value: 'from sidecar' },
    { ref: '__proto__', name: 'value', value: 'nowhere' },
    { ref: 'label', name: 'noSuchAttribute', value: 1 },
  ],
  compat: { attrs: [{ ref: 'label', name: 'fontSize', value: 7 }] },
  ...extra,
});

/** The archive's SHA-256 as the engine computes it. @param {Uint8Array} bytes */
const shaOf = async (bytes) => (await openVfs(bytes, 'skin.wmz')).sha;

describe('options', () => {
  it('start from the configuration named and take every key given, budgets per key', () => {
    expect(resolveOptions(undefined)).toEqual(FAITHFUL);
    expect(resolveOptions({ config: 'oracle-compat' })).toEqual(ORACLE_COMPAT);
    const o = resolveOptions({ realmTickHz: 5, stacking: undefined, budgets: /** @type {any} */ ({ handler: 7 }) });
    expect(o.realmTickHz).toBe(5);
    expect(o.stacking).toBe('context');
    expect(o.budgets).toEqual({ ...FAITHFUL.budgets, handler: 7 });
    expect(Object.isFrozen(o)).toBe(true);
  });
});

describe('the sidecar', () => {
  it('appends overlays, writes attrs in faithful and keeps compat to oracle-compat', async () => {
    const bytes = skinZip({ wms: SIDE_WMS });
    const sha = await shaOf(bytes);
    const { runtime, skin } = await open(bytes, { sidecar: sidecarFor(sha) });
    const ins = runtime.inspector;
    expect(ins.attr('label', 'top')).toBe(7);
    expect(ins.attr('label', 'fontSize')).toBe(10);               // compat only
    expect(ins.attr('seek', 'x-foregroundMode')).toBe('playhead');
    expect(ins.attr('constructor', 'value')).toBe('from sidecar');
    expect(ins.stackingDump().some((l) => /text Unnamed_text_\d+/.test(l))).toBe(true);
    const codes = runtime.diagnostics().map((d) => d.code);
    expect(codes).toContain('sidecar-ref-missing');             // `__proto__` names no element
    expect(codes).toContain('sidecar-attr-unknown');
    expect(skin.diagnostics().map((d) => d.code)).toEqual(expect.arrayContaining(['sidecar-ref-missing', 'sidecar-attr-unknown']));

    const compat = await open(bytes, { sidecar: sidecarFor(sha), opts: { ...ORACLE_COMPAT, budgets: WIDE } });
    expect(compat.runtime.inspector.attr('label', 'fontSize')).toBe(7);
    expect(compat.runtime.inspector.attr('label', 'top')).toBe(7);
  });

  it('is ignored, with a diagnostic, when it is for another skin', async () => {
    const bytes = skinZip({ wms: SIDE_WMS });
    const { runtime, skin } = await open(bytes, { sidecar: sidecarFor('0'.repeat(64)) });
    expect(runtime.inspector.attr('label', 'top')).toBe(3);
    expect(skin.diagnostics().map((d) => d.code)).toContain('sidecar-wrong-skin');
  });

  it('survives a sidecar of the wrong shape', async () => {
    const bytes = skinZip({ wms: SIDE_WMS });
    const sha = await shaOf(bytes);
    const { runtime } = await open(bytes, { sidecar: { schema: 'window_headmpd-sidecar/1', skin: sha, attrs: [null, 7, { ref: 'label' }, { ref: 'label', name: 'top', value: { no: 1 } }], overlays: 'x' } });
    expect(runtime.inspector.attr('label', 'top')).toBe(3);
    expect(runtime.diagnostics().filter((d) => d.code === 'sidecar-invalid').length).toBeGreaterThan(0);
  });
});

describe('WmsSkinHost (E D12)', () => {
  it('can load an archive with a .wms and loads it from the VFS', async () => {
    const bytes = skinZip({ wms: wmsOf('<text id="t" left="0" top="0" width="5" height="5" value="hi"/>') });
    const vfs = await openVfs(bytes, 'skin.wmz');
    expect(WmsSkinHost.family).toBe('wms');
    expect(WmsSkinHost.canLoad(vfs)).toBe(1);
    expect(WmsSkinHost.canLoad(await openVfs(buildZip([{ name: 'main.bmp', data: 'x' }]), 'x.wsz'))).toBe(0);
    const host = createTestHost();
    const hosted = await createWmsSkinHost({ budgets: WIDE }).load(vfs, { host });
    expect(hosted.sha).toBe(vfs.sha);
    const view = /** @type {any} */ (await hosted.attach());
    expect(view.inspector.attr('t', 'value')).toBe('hi');
    expect(view.maskShape().kind).toBe('bits');
    hosted.dispose();
  });
});

describe('the ledger and diagnostics', () => {
  it('counts unknown tags by tag', async () => {
    const { skin } = await open(skinZip({ wms: wmsOf('<network id="n"/><foo/><foo/>') }));
    const entries = skin.ledger().filter((e) => e.kind === 'unknown-tag').map((e) => e.api);
    expect(entries).toEqual(expect.arrayContaining(['<network>', '<foo>']));
  });

  it('logs every load step through the host', async () => {
    const host = createTestHost();
    const engine = createEngine(host, { budgets: WIDE });
    const skin = await engine.load(skinZip({ wms: wmsOf('') }));
    expect(trace(host)).toEqual(['engine: definition', 'engine: literal pass']);
    await skin.attach();
    expect(trace(host).at(-1)).toBe('engine: show');
  });
});

describe('the end of a view', () => {
  it('runs onclose on dispose, and nothing it queues', async () => {
    const wms = wmsOf('<text id="t" left="0" top="0" width="5" height="5" value="a" value_onchange="theme.logString(\'changed\');"/>',
      `id="v" width="200" height="100" backgroundColor="none" titleBar="false" onclose="theme.logString('closing'); t.value = 'b';"`);
    const { host, runtime, skin } = await open(skinZip({ wms }));
    skin.dispose();
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: closing']);
    expect(runtime.health.unloaded).toBe(true);
    expect(runtime.inspector.callGlobal('anything')).toBeUndefined();
  });

  it('stops its timers', async () => {
    const js = 'var n = 0; function start() { setInterval(function () { n++; }, 20); }';
    const { host, runtime } = await open(skinZip({ wms: wmsOf(''), js }));
    runtime.inspector.callGlobal('start');
    host.clock.advance(50);
    runtime.dispose();
    expect(host.clock.pendingTimers()).toBe(0);
  });
});
