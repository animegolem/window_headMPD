// @ts-check
// The object graph over the real element model: `scanWms` and `buildTheme` (both contracted, E 5.2 and
// 5.3) build the view, and the graph is made from it. The other object tests use an in-test fake
// element so they do not depend on the builder; this one is the check that the two agree. The
// builder is another task's module (W2.1), so it is imported dynamically: if it is missing or does not
// load, this file skips and says why, and W2.1's own tests report the failure.
import { describe, expect, it } from 'vitest';
import { scanWms } from '../../../src/engine/wms/scan.js';
import { createObjectGraph } from '../../../src/engine/model/objects/index.js';
import { createLedger } from '../../../src/engine/model/ledger.js';
import { FAITHFUL } from '../../../src/engine/options.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import { createFakeDsp } from '../../../src/hosts/test/dsp.js';
import { createFakeMedia } from '../../../src/hosts/test/media.js';
import { createMemoryPrefs } from '../../../src/hosts/test/prefs.js';

/** @type {typeof import('../../../src/engine/wms/build.js') | null} */
let builder = null;
/** @type {string} */
let missing = '';
try {
  builder = await import('../../../src/engine/wms/build.js');
} catch (e) {
  missing = e instanceof Error ? e.message : String(e);
}

const WMS = `<THEME title="T" author="res://wmploc/RT_STRING/#1998">
<VIEW id="v" width="549" height="394" scriptFile="a.js">
  <SUBVIEW id="sEqEar" left="207" top="0" width="260" height="394">
    <BUTTON id="bEqHandle" left="8" top="66" upToolTip="Open" image="x.bmp"/>
    <TEXT id="xEqTt" value="Open graphic equalizer controls" onclick="Go();"/>
    <SLIDER id="volume" min="0" max="100" value="30" value_onchange="jscript:player.settings.volume=value;"/>
    <BUTTONGROUP id="g" mappingImage="m.bmp" width="80" height="20"><BUTTONELEMENT id="bPlay" mappingColor="#FFFF00"/><BUTTONELEMENT mappingColor="#00FF00"/></BUTTONGROUP>
  </SUBVIEW>
  <EFFECTS id="visEffects"/><VIDEO id="vid" visible="false"/><PLAYLIST id="pl" visible="false"/>
  <EQUALIZERSETTINGS id="eq"/>
  <BUTTON id="constructor" left="5"/><BUTTON id="__proto__" left="6"/>
</VIEW></THEME>`;

function make() {
  const { root } = scanWms(WMS);
  const vfs = /** @type {any} */ ({ sha: 'x', name: 'x', has: () => false, read: () => null, list: () => [], resolve: () => null, diagnostics: [] });
  const theme = /** @type {NonNullable<typeof builder>} */ (builder).buildTheme(/** @type {any} */ (root), vfs, { probe: () => null });
  const view = theme.views[0];
  const clock = createManualClock();
  const media = createFakeMedia('stoppedQueue5', { clock });
  const ledger = createLedger('x');
  /** @type {any[]} */
  const anim = [];
  const host = /** @type {any} */ ({
    clock, media, dsp: createFakeDsp(), prefs: createMemoryPrefs(),
    actions: { run() {}, denied() {}, fault() {} }, log: { info() {}, warn() {}, diag() {} },
  });
  const graph = createObjectGraph(/** @type {any} */ ({
    host, view, theme, skinSha: 'x', prefs: new Map(), ledger, opts: FAITHFUL,
    animate: { moveTo: (/** @type {any[]} */ ...a) => anim.push(['moveTo', ...a]), alphaBlendTo: () => {}, cancel: (/** @type {any[]} */ ...a) => anim.push(['cancel', ...a]) },
    effectsOf: () => null,
    inGesture: () => false,
  }));
  /** @param {string} id */
  const el = (id) => /** @type {import('../../../src/engine/contracts').ElementModel} */ (view.byId(id));
  return { graph, view, theme, ledger, anim, el, host };
}

describe.skipIf(!builder)(`the graph over buildTheme's model${builder ? '' : ` (skipped: wms/build.js did not load: ${missing})`}`, () => {
  it('every element has an object under its own handle, and graph handles sit above them all', () => {
    const t = make();
    const maxElement = Math.max(...t.view.elements.map((e) => e.handle));
    for (const e of t.view.elements) {
      const o = t.graph.elementObject(e);
      expect(/** @type {any} */ (o).handle).toBe(e.handle);
      expect(t.graph.objectOf(e.handle)).toBe(o);
    }
    expect(/** @type {any} */ (t.graph.globals.player).handle).toBeGreaterThan(maxElement);
    expect(t.graph.objectOf(t.view.view.handle)).toBe(t.graph.globals.view);
  });

  it('attributes read what the model holds, in any case, with the model’s own element type', () => {
    const t = make();
    const o = t.graph.elementObject(t.el('sEqEar'));
    expect([o.get('left'), o.get('TOP'), o.get('width'), o.get('visible')]).toEqual([207, 0, 260, true]);
    expect(t.graph.elementObject(t.el('bEqHandle')).get('uptooltip')).toBe('Open');
    expect(t.graph.elementObject(t.el('bEqHandle')).get('id')).toBe('bEqHandle');
    expect(t.graph.elementObject(t.el('vid')).get('visible')).toBe(false);
    expect(t.graph.globals.view.get('width')).toBe(549);
  });

  it('a script write goes through the model: the value changes, onChange sees origin script, the handler event queues', () => {
    const t = make();
    /** @type {Array<[string, string, unknown, string]>} */
    const seen = [];
    t.view.onChange((e, attr, v, origin) => { seen.push([e.id, attr, v, origin]); });
    t.graph.elementObject(t.el('sEqEar')).set('left', 100, 'script');
    expect(t.el('sEqEar').get('left')).toBe(100);
    t.graph.elementObject(t.el('volume')).set('value', 55, 'script');
    expect(seen).toEqual([['sEqEar', 'left', 100, 'script'], ['volume', 'value', 55, 'script']]);
    expect(t.view.takeQueuedEvents().map((q) => `${q.el.id}.${q.event}`)).toEqual(['volume.value_onchange']);
    expect(t.anim).toEqual([['cancel', t.el('sEqEar')]]);
  });

  it('a slider value out of range is ignored; in range it is kept', () => {
    const t = make();
    const o = t.graph.elementObject(t.el('volume'));
    o.set('value', 500, 'script');
    expect(o.get('value')).toBe(30);
    o.set('value', 99, 'script');
    expect(o.get('value')).toBe(99);
  });

  it('view.width writes the VIEW element, and reads it back', () => {
    const t = make();
    t.graph.globals.view.set('width', 760, 'script');
    expect(t.view.view.get('width')).toBe(760);
    expect(t.graph.globals.view.get('width')).toBe(760);
  });

  it('theme metadata read the model’s resolved strings', () => {
    const t = make();
    expect(t.graph.globals.theme.get('title')).toBe('T');
    expect(t.graph.globals.theme.get('author')).toBe('Microsoft Corporation');
  });

  it('BUTTONGROUP getButton(i) answers with the children the builder made, unnamed ones included', () => {
    const t = make();
    const g = t.graph.elementObject(t.el('g'));
    const first = /** @type {any} */ (g.call('getbutton', [0], { gesture: false }));
    const second = /** @type {any} */ (g.call('getbutton', [1], { gesture: false }));
    expect(t.graph.objectOf(first.__h)?.get('id')).toBe('bPlay');
    expect(t.graph.objectOf(second.__h)?.get('id')).toMatch(/^Unnamed_buttonelement_/);
    expect(t.graph.objectOf(second.__h)?.get('mappingcolor')).toBe('#00ff00');
    expect(g.get('buttoncount')).toBe(2);
  });

  it('paths resolve through the real ids, in any case, and ids named constructor and __proto__ are ordinary', () => {
    const t = make();
    expect(t.graph.changeSource('volume.value')?.read()).toBe(30);
    expect(t.graph.changeSource('BEQHANDLE.left')?.read()).toBe(8);
    expect(t.graph.changeSource('eq.gainLevel2')?.read()).toBe(0);
    expect(t.graph.changeSource('constructor.left')?.read()).toBe(5);
    expect(t.graph.changeSource('__proto__.left')?.read()).toBe(6);
    expect(t.graph.changeSource('toString.left')).toBeNull();
    /** @type {unknown[]} */
    const heard = [];
    const s = t.graph.changeSource('volume.value');
    s?.subscribe(() => heard.push(s.read()));
    t.el('volume').set('value', 70, 'binding');
    t.el('volume').set('value', 70, 'binding');
    expect(heard).toEqual([70]);
  });

  it('the graph reaches the object model through a handle it handed out', () => {
    const t = make();
    const controls = /** @type {any} */ (t.graph.globals.player.get('controls'));
    const o = t.graph.objectOf(controls.__h);
    expect(o?.className).toBe('controls');
    expect(o?.get('currentpositionstring')).toBe('00:00');
  });

  it('nothing the graph records is a surprise on a skin that uses only documented members', () => {
    const t = make();
    t.graph.elementObject(t.el('sEqEar')).set('left', 1, 'script');
    t.graph.globals.player.get('openstate');
    t.graph.globals.mediacenter.get('effectpreset');
    expect(t.ledger.entries()).toEqual([]);
  });
});
