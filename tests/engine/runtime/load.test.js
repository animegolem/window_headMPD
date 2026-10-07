// @ts-check
// W4.1 acceptance 1, the load sequence (E §3.1): headless, in Node, on the test host. The skin logs what
// it sees through `theme.logString`, which the test host records in the same list as the runtime's own
// `engine: <step>` lines, so one list shows the order: literal pass, prelude, scripts, `jscript:`,
// bindings, onload, then the queue drain.
import { describe, expect, it } from 'vitest';
import { open, skinZip, trace, wmsOf } from './helpers.js';

const ORDER_WMS = wmsOf(
  `<text id="t" left="7" top="jscript:mark('expr') + 3" width="50" height="10"
     value="wmpprop:player.status" value_onchange="theme.logString('onchange ' + value);"/>`,
  `id="v" width="200" height="100" backgroundColor="none" titleBar="false" onload="theme.logString('onload ' + t.left + ' ' + t.top);"`,
);
const ORDER_JS = `
theme.logString('script ' + t.left + ' ' + t.top + ' ' + osMediaOpen);
function mark(s) { theme.logString(s); return 1; }
`;

describe('the load sequence (E §3.1)', () => {
  it('runs literal pass, prelude, scripts, jscript:, bindings, onload and the queue drain in that order', async () => {
    const { host, runtime } = await open(skinZip({ wms: ORDER_WMS, js: ORDER_JS }));
    const lines = trace(host);
    const status = runtime.inspector.attr('t', 'value');
    expect(typeof status).toBe('string');
    expect(status).not.toBe('');
    expect(lines).toEqual([
      'engine: definition',
      'engine: literal pass',
      'engine: prelude',
      'engine: ids',
      'engine: scripts',
      // the literal pass ran (left is 7), the `jscript:` pass has not (top reads its default 0), the
      // prelude's #132 constants are there (osMediaOpen is 13)
      'skin: script 7 0 13',
      'engine: jscript:',
      'skin: expr',
      'engine: anchors',
      'engine: sidecar',
      'engine: bindings',
      'engine: decode',
      'engine: render',
      'engine: shape',
      'engine: onload',
      // onload sees the evaluated top (1 + 3); the binding's value_onchange waited for it
      'skin: onload 7 4',
      'engine: queue drain',
      `skin: onchange ${status}`,
      'engine: first frame',
      'engine: show',
    ]);
    expect(runtime.health).toEqual({ soft: 0, hard: 0, unloaded: false });
  });

  it('drains `_onchange` and script click() FIFO after the entry that queued them', async () => {
    const wms = wmsOf(`
      <text id="t" left="0" top="0" width="10" height="10" value="a" value_onchange="theme.logString('changed ' + value);"/>
      <buttongroup id="g" left="0" top="20" width="10" height="10">
        <buttonelement id="be" mappingColor="#FF0000" onclick="theme.logString('clicked'); t.value = 'c';"/>
        <buttonelement id="be2" mappingColor="#00FF00" onclick="theme.logString('clicked 2');"/>
      </buttongroup>`,
    `id="v" width="200" height="100" backgroundColor="none" titleBar="false"
      onload="t.value = 'b'; be.click(); g.click(1); theme.logString('onload done');"`);
    const { host, runtime } = await open(skinZip({ wms }));
    const skinLines = trace(host).filter((l) => l.startsWith('skin: ') || l === 'engine: queue drain');
    expect(skinLines).toEqual([
      'skin: onload done',
      'engine: queue drain',
      'skin: changed b',
      'skin: clicked',
      'skin: clicked 2',
      // the write in the first click's handler queued its own change, behind what was already queued
      'skin: changed c',
    ]);
    expect(runtime.inspector.attr('t', 'value')).toBe('c');
  });

  it('runs a click() from a later entry as soon as that entry returns', async () => {
    const wms = wmsOf(`<buttongroup id="g" left="0" top="20" width="10" height="10">
        <buttonelement id="be" mappingColor="#FF0000" onclick="theme.logString('clicked');"/>
      </buttongroup>`);
    const js = `function press() { be.click(); theme.logString('pressed'); }`;
    const { host, runtime } = await open(skinZip({ wms, js }));
    runtime.inspector.callGlobal('press');
    expect(trace(host).filter((l) => l.startsWith('skin: '))).toEqual(['skin: pressed', 'skin: clicked']);
  });

  it('denies view.close() from onload (D6.5: not a user gesture)', async () => {
    const wms = wmsOf('', `id="v" width="200" height="100" backgroundColor="none" titleBar="false" onload="view.close(); view.minimize();"`);
    const { host, runtime } = await open(skinZip({ wms }));
    expect(host.recorded.actions).toEqual([]);
    expect(host.recorded.denied.map((d) => d.api)).toEqual(expect.arrayContaining(['view.close', 'view.minimize']));
    expect(runtime.health.unloaded).toBe(false);
  });

  it('describes the skin as a WMS host does (E D12)', async () => {
    const wms = wmsOf('', 'id="main" width="320" height="200" backgroundColor="none" titleBar="false"');
    const { skin, runtime } = await open(skinZip({ wms }), { attach: false });
    expect(runtime).toBeNull();
    expect(skin.family).toBe('wms');
    expect(skin.capabilities).toEqual({ eq: null, wantsPcm: false, windowModel: 'native-per-view', scripted: true });
    expect(skin.views()).toEqual([{ id: 'main', width: 320, height: 200, main: true }]);
    expect(skin.sha).toMatch(/^[0-9a-f]{64}$/);
    const rt = await skin.attach('MAIN');                        // case-insensitive, like ids
    expect(rt.viewId).toBe('main');
    await expect(skin.attach()).rejects.toThrow(/already attached/);
    await expect(skin.attach('nope')).rejects.toThrow(/no view/);
    rt.dispose();
    const again = await skin.attach();
    expect(again.viewId).toBe('main');
    skin.dispose();
    await expect(skin.attach()).rejects.toThrow(/disposed/);
  });

  it('rejects an archive with no definition file', async () => {
    await expect(open(skinZip({ wms: '' }).slice(0, 0))).rejects.toThrow();
    const { buildZip } = await import('../../support/zip-writer.js');
    await expect(open(buildZip([{ name: 'readme.txt', data: 'no skin here' }]))).rejects.toThrow(/no \.wms/);
  });
});
