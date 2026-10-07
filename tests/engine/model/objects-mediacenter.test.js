// @ts-check
import { describe, expect, it } from 'vitest';
import { makeGraph } from './objects-fakes.js';

describe('mediacenter persistence (acceptance 6)', () => {
  it('effectPreset persists to the mediacenter namespace, as text', () => {
    const t = makeGraph();
    t.write('mediacenter.effectPreset', 3);
    expect(t.store.peek('mediacenter').get('effectPreset')).toBe('3');
    expect(t.store.writes).toEqual([{ ns: 'mediacenter', key: 'effectPreset', value: '3' }]);
    expect(t.read('mediacenter.effectpreset')).toBe(3);
    expect(t.store.peek('a'.repeat(64)).size).toBe(0);          // never the skin namespace
  });

  it('every documented key persists with its own type, and an invalid write keeps the previous value', () => {
    const t = makeGraph();
    expect([t.read('mediacenter.effectType'), t.read('mediacenter.effectPreset'), t.read('mediacenter.videoZoom')]).toEqual(['', 0, 100]);
    expect([t.read('mediacenter.videoStretchToFit'), t.read('mediacenter.videoShrinkToFit'), t.read('mediacenter.showTitles'),
      t.read('mediacenter.showEffects'), t.read('mediacenter.contrastMode')]).toEqual([false, true, true, true, false]);

    t.write('mediacenter.effectType', 'bars');
    t.write('mediacenter.videoZoom', '150');
    t.write('mediacenter.videoStretchToFit', 'true');
    t.write('mediacenter.contrastMode', 1);
    expect(Object.fromEntries(t.store.peek('mediacenter'))).toEqual({ effectType: 'bars', videoZoom: '150', videoStretchToFit: 'true', contrastMode: 'true' });
    expect([t.read('mediacenter.effectType'), t.read('mediacenter.videoZoom'), t.read('mediacenter.videoStretchToFit'), t.read('mediacenter.contrastMode')])
      .toEqual(['bars', 150, true, true]);

    t.write('mediacenter.videoZoom', 'big');                  // not a number: stays 150
    t.write('mediacenter.showTitles', 'ture');                // not a boolean: stays true
    expect([t.read('mediacenter.videoZoom'), t.read('mediacenter.showTitles')]).toEqual([150, true]);
  });

  it('writing the same value again persists nothing more', () => {
    const t = makeGraph();
    t.write('mediacenter.effectPreset', 2);
    t.write('mediacenter.effectPreset', 2);
    t.write('mediacenter.effectPreset', '2');
    expect(t.store.writes).toHaveLength(1);
  });

  it('mediacenter.foo does not persist and is ledgered, but lives for the session', () => {
    const t = makeGraph();
    t.write('mediacenter.foo', 5);
    t.write('mediacenter.Foo', 'six');
    expect(t.store.writes).toEqual([]);
    expect(t.store.peek('mediacenter').size).toBe(0);
    expect(t.read('mediacenter.foo')).toBe('six');
    expect(t.counts()['mediacenter.foo unknown-member']).toBe(2);
    expect(t.read('mediacenter.bar')).toBeUndefined();
    expect(t.counts()['mediacenter.bar unknown-member']).toBe(1);
  });

  it('session-only keys are capped, and named __proto__ or constructor they are ordinary keys', () => {
    const t = makeGraph();
    t.write('mediacenter.__proto__', 7);
    t.write('mediacenter.constructor', 8);
    expect(t.read('mediacenter.__proto__')).toBe(7);
    expect(t.read('mediacenter.constructor')).toBe(8);
    expect(t.read('mediacenter.toString')).toBeUndefined();
    for (let i = 0; i < 100; i++) t.write(`mediacenter.k${i}`, i);
    expect(t.read('mediacenter.k0')).toBe(0);
    expect(t.read('mediacenter.k99')).toBeUndefined();
    t.write('mediacenter.long', 'x'.repeat(10000));
    expect(t.read('mediacenter.long')).toBeUndefined();         // over the key cap by now: dropped
  });

  it('a long session value is cut, and a handle is not stored', () => {
    const t = makeGraph();
    t.write('mediacenter.note', 'x'.repeat(10000));
    expect(String(t.read('mediacenter.note')).length).toBe(4096);
    t.write('mediacenter.obj', /** @type {any} */ ({ __h: 3 }));
    expect(t.read('mediacenter.obj')).toBeUndefined();
  });
});

describe('seeding from the stored namespace', () => {
  it('values arrive asynchronously, and `ready` says when', async () => {
    const t = makeGraph({ mediacenter: { effectPreset: '1', showTitles: 'false', foo: 'ignored' } });
    expect(t.read('mediacenter.effectPreset')).toBe(0);         // the defaults, until the load lands
    await t.graph.ready;
    expect(t.read('mediacenter.effectPreset')).toBe(1);
    expect(t.read('mediacenter.showTitles')).toBe(false);
    expect(t.read('mediacenter.foo')).toBeUndefined();          // not documented: never loaded
  });

  it('a map passed in is applied at once', async () => {
    const t = makeGraph({ mediacenterMap: new Map([['EFFECTPRESET', '4'], ['videoZoom', '120']]) });
    expect(t.read('mediacenter.effectPreset')).toBe(4);
    expect(t.read('mediacenter.videoZoom')).toBe(120);
    await t.graph.ready;
    expect(t.store.writes).toEqual([]);                         // reading the store is not writing it
  });

  it('a late load never overwrites what the script already wrote', async () => {
    const t = makeGraph({ mediacenter: { effectPreset: '1', videoZoom: '130' } });
    t.write('mediacenter.effectPreset', 4);
    await t.graph.ready;
    expect(t.read('mediacenter.effectPreset')).toBe(4);
    expect(t.read('mediacenter.videoZoom')).toBe(130);
  });

  it('a stored value that is not valid text for its key leaves the default', async () => {
    const t = makeGraph({ mediacenter: { videoZoom: 'wide', showTitles: 'maybe' } });
    await t.graph.ready;
    expect([t.read('mediacenter.videoZoom'), t.read('mediacenter.showTitles')]).toEqual([100, true]);
  });

  it('a failing load is logged and the defaults stand', async () => {
    const t = makeGraph({ failLoad: true });
    await t.graph.ready;
    expect(t.read('mediacenter.effectPreset')).toBe(0);
    expect(t.logs.warn.some((m) => m.includes('disk gone'))).toBe(true);
  });
});

describe('mediacenter change events', () => {
  it('a script write fires the key’s change source, only for that key and only on a change', () => {
    const t = makeGraph();
    /** @type {string[]} */
    const heard = [];
    t.graph.changeSource('mediacenter.effectPreset')?.subscribe(() => heard.push('preset'));
    t.graph.changeSource('mediacenter.videoZoom')?.subscribe(() => heard.push('zoom'));
    t.write('mediacenter.effectPreset', 2);
    t.write('mediacenter.effectPreset', 2);
    t.write('mediacenter.videoZoom', 100);                      // the default: not a change
    expect(heard).toEqual(['preset']);
    t.write('mediacenter.videoZoom', 90);
    expect(heard).toEqual(['preset', 'zoom']);
  });

  it('another webview writing the namespace updates the value and fires the change', () => {
    const t = makeGraph();
    let heard = 0;
    t.graph.changeSource('mediacenter.effectPreset')?.subscribe(() => { heard++; });
    t.store.external('mediacenter', 'effectPreset', '3');
    expect(t.read('mediacenter.effectPreset')).toBe(3);
    expect(heard).toBe(1);
    t.store.external('mediacenter', 'effectPreset', null);
    expect(t.read('mediacenter.effectPreset')).toBe(0);
    expect(heard).toBe(2);
    t.store.external('mediacenter', 'unrelated', 'x');
    t.store.external('mediacenter', '__proto__', 'x');
    expect(heard).toBe(2);
  });

  it('a late load fires the change for the keys it moved', async () => {
    const t = makeGraph({ mediacenter: { effectPreset: '2' } });
    let heard = 0;
    t.graph.changeSource('mediacenter.effectPreset')?.subscribe(() => { heard++; });
    await t.graph.ready;
    expect(heard).toBe(1);
  });
});
