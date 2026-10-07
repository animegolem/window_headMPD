// @ts-check
import { describe, expect, it } from 'vitest';
import { PREF_CAPS } from '../../../src/engine/model/policy.js';
import { makeGraph } from './objects-fakes.js';

describe('theme preferences (acceptance 4)', () => {
  it("loadPreference of a key never saved is '--'", () => {
    const t = makeGraph();
    expect(t.call('theme.loadPreference', ['nope'])).toBe('--');
  });

  it("loadPreference('constructor') and ('__proto__') are '--', never an inherited member", () => {
    const t = makeGraph();
    expect(t.call('theme.loadPreference', ['constructor'])).toBe('--');
    expect(t.call('theme.loadPreference', ['__proto__'])).toBe('--');
    expect(t.call('theme.loadPreference', ['toString'])).toBe('--');
    expect(t.call('theme.loadPreference', ['hasOwnProperty'])).toBe('--');
  });

  it('a skin may save and load keys named constructor and __proto__ as ordinary keys', () => {
    const t = makeGraph();
    t.call('theme.savePreference', ['constructor', 'c']);
    t.call('theme.savePreference', ['__proto__', 'p']);
    expect(t.call('theme.loadPreference', ['constructor'])).toBe('c');
    expect(t.call('theme.loadPreference', ['__proto__'])).toBe('p');
    expect(t.call('theme.loadPreference', ['toString'])).toBe('--');
    expect(Object.getPrototypeOf(t.skinPrefs)).toBe(Map.prototype);
  });

  it('savePreference stores String(value) and writes through to the skin namespace', () => {
    const t = makeGraph({ skinSha: 'b'.repeat(64) });
    t.call('theme.savePreference', ['count', 42]);
    t.call('theme.savePreference', ['flag', true]);
    t.call('theme.savePreference', ['text', 'hello']);
    t.call('theme.savePreference', [123, 'numeric key']);
    expect(t.call('theme.loadPreference', ['count'])).toBe('42');
    expect(t.call('theme.loadPreference', ['flag'])).toBe('true');
    expect(t.call('theme.loadPreference', ['123'])).toBe('numeric key');
    expect(t.store.peek('b'.repeat(64)).get('count')).toBe('42');
    expect(t.store.writes).toEqual([
      { ns: 'b'.repeat(64), key: 'count', value: '42' }, { ns: 'b'.repeat(64), key: 'flag', value: 'true' },
      { ns: 'b'.repeat(64), key: 'text', value: 'hello' }, { ns: 'b'.repeat(64), key: '123', value: 'numeric key' },
    ]);
  });

  it('loads what the namespace already held', () => {
    const t = makeGraph({ prefs: { plViewer: 'true' } });
    expect(t.call('theme.loadPreference', ['plViewer'])).toBe('true');
  });

  it('saving the stored value again writes nothing', () => {
    const t = makeGraph();
    t.call('theme.savePreference', ['k', 'v']);
    t.call('theme.savePreference', ['k', 'v']);
    expect(t.store.writes).toHaveLength(1);
  });

  it('a write from another window to this namespace reaches loadPreference', () => {
    const sha = 'c'.repeat(64);
    const t = makeGraph({ skinSha: sha });
    t.store.external(sha, 'shared', 'from elsewhere');
    expect(t.call('theme.loadPreference', ['shared'])).toBe('from elsewhere');
    t.store.external(sha, 'shared', null);
    expect(t.call('theme.loadPreference', ['shared'])).toBe('--');
  });

  describe('caps drop over-cap writes with a ledger entry', () => {
    it('key over 256 bytes', () => {
      const t = makeGraph();
      t.call('theme.savePreference', ['k'.repeat(257), 'v']);
      t.call('theme.savePreference', ['k'.repeat(256), 'v']);
      expect(t.skinPrefs.size).toBe(1);
      expect(t.store.writes).toHaveLength(1);
      expect(t.counts()['theme.savePreference cap']).toBe(1);
    });

    it('key bytes are UTF-8 bytes, not characters', () => {
      const t = makeGraph();
      t.call('theme.savePreference', ['é'.repeat(129), 'v']);       // 258 bytes in 129 characters
      expect(t.skinPrefs.size).toBe(0);
      t.call('theme.savePreference', ['é'.repeat(128), 'v']);       // 256 bytes
      expect(t.skinPrefs.size).toBe(1);
    });

    it('value over 4 KiB', () => {
      const t = makeGraph();
      t.call('theme.savePreference', ['big', 'v'.repeat(4097)]);
      expect(t.call('theme.loadPreference', ['big'])).toBe('--');
      t.call('theme.savePreference', ['big', 'v'.repeat(4096)]);
      expect(String(t.call('theme.loadPreference', ['big'])).length).toBe(4096);
    });

    it('a 257th key', () => {
      const t = makeGraph();
      for (let i = 0; i < 256; i++) t.call('theme.savePreference', [`k${i}`, '1']);
      expect(t.skinPrefs.size).toBe(256);
      t.call('theme.savePreference', ['one-too-many', '1']);
      expect(t.skinPrefs.size).toBe(256);
      expect(t.call('theme.loadPreference', ['one-too-many'])).toBe('--');
      t.call('theme.savePreference', ['k0', '2']);                        // an existing key still updates
      expect(t.call('theme.loadPreference', ['k0'])).toBe('2');
      expect(t.counts()['theme.savePreference cap']).toBe(1);
    });

    it('64 KiB per namespace, counting keys and values', () => {
      const t = makeGraph();
      const value = 'x'.repeat(4000);
      let saved = 0;
      for (let i = 0; i < 20; i++) {
        t.call('theme.savePreference', [`key${String(i).padStart(2, '0')}`, value]);
        if (t.skinPrefs.size > saved) saved = t.skinPrefs.size;
      }
      let total = 0;
      for (const [k, v] of t.skinPrefs) total += k.length + v.length;
      expect(total).toBeLessThanOrEqual(PREF_CAPS.maxNamespaceBytes);
      expect(t.skinPrefs.size).toBeLessThan(20);
      expect(t.counts()['theme.savePreference cap']).toBeGreaterThan(0);
    });

    it('the caps match the store the host runs (no write the store would reject gets through)', () => {
      const t = makeGraph();
      for (let i = 0; i < 40; i++) t.call('theme.savePreference', [`k${i}`, 'y'.repeat(3000)]);
      expect(t.store.rejected).toEqual([]);
    });
  });
});

describe('theme.loadString and the metadata', () => {
  it('resolves an RT_STRING url; an unresolved one is "" with an unresolved-res entry', () => {
    const t = makeGraph();
    expect(t.call('theme.loadString', ['res://wmploc/RT_STRING/#1910'])).toBe('left');
    expect(t.call('theme.loadString', ['res://wmploc.dll/RT_STRING/#2066'])).toBe('%sKbps');
    expect(t.call('theme.loadString', ['res://wmploc/RT_STRING/#9'])).toBe('');
    expect(t.call('theme.loadString', ['res://other/RT_STRING/#1810'])).toBe('');
    expect(t.call('theme.loadString', ['res://wmploc/RT_IMAGE/#1770'])).toBe('');
    expect(t.call('theme.loadString', ['not a url'])).toBe('');
    const c = t.counts();
    expect(c['res://wmploc/RT_STRING/#9 unresolved-res']).toBe(1);
    expect(c['res://other/RT_STRING/#1810 unresolved-res']).toBe(1);
    expect(c['res://wmploc/RT_IMAGE/#1770 unresolved-res']).toBe(1);
    expect(c['res://wmploc/RT_STRING/#1910 unresolved-res']).toBeUndefined();
  });

  it('author, title and copyright read the theme; a script may overwrite them', () => {
    const t = makeGraph({ theme: { author: 'res://wmploc/RT_STRING/#1998' } });
    expect(t.read('theme.title')).toBe('A Title');
    expect(t.read('theme.copyright')).toBe('(c) Someone');
    expect(t.read('theme.author')).toBe('Microsoft Corporation');
    t.write('theme.title', 'Renamed');
    expect(t.read('theme.title')).toBe('Renamed');
    expect(t.read('theme.version')).toBe(1);
    expect(t.read('theme.authorVersion')).toBe('');
  });

  it('logString goes to the host log, bounded in count and length', () => {
    const t = makeGraph();
    t.call('theme.logString', ['hello']);
    t.call('theme.logString', ['x'.repeat(5000)]);
    expect(t.logs.info[0]).toBe('skin: hello');
    expect(t.logs.info[1].length).toBeLessThan(600);
    for (let i = 0; i < 300; i++) t.call('theme.logString', [`line ${i}`]);
    expect(t.logs.info).toHaveLength(200);
    expect(t.counts()['theme.logString cap']).toBe(1);
  });

  it('openDialog returns "" and is ledgered as a stub; playSound and showErrorDialog are inert', () => {
    const t = makeGraph();
    expect(t.call('theme.openDialog', ['FILE_OPEN', 'FILES_ALLMEDIA'])).toBe('');
    expect(t.call('theme.playSound', ['ding.wav'])).toBeUndefined();
    expect(t.call('theme.showErrorDialog')).toBeUndefined();
    const c = t.counts();
    expect(c['theme.openDialog stub']).toBe(1);
    expect(c['theme.playSound stub']).toBe(1);
    expect(c['theme.showErrorDialog stub']).toBe(1);
  });

  it('phase 1 opens and closes no other view: it is logged and ledgered, the current view is untouched', () => {
    const t = makeGraph();
    expect(t.read('theme.currentViewID')).toBe('view1');
    t.call('theme.openView', ['plView']);
    t.call('theme.openView', ['plView']);
    t.call('theme.openViewRelative', ['plView', 10, 20]);
    t.call('theme.closeView', ['plView']);
    t.write('theme.currentViewID', 'plView');
    t.call('theme.openView', ['view1']);                      // the open one: nothing to do, nothing to say
    const c = t.counts();
    expect(c['theme.openView stub']).toBe(2);
    expect(c['theme.openViewRelative stub']).toBe(1);
    expect(c['theme.closeView stub']).toBe(1);
    expect(c['theme.currentViewID stub']).toBe(1);
    expect(t.logs.info.filter((m) => m.startsWith('theme.openView:'))).toHaveLength(1);
    expect(t.actionLog.run).toEqual([]);
  });

  it('closeView of the open view is view.close() by another name: gesture only', () => {
    const t = makeGraph();
    t.call('theme.closeView', ['view1'], { gesture: false });
    expect(t.actionLog.run).toEqual([]);
    expect(t.counts()['theme.closeView denied']).toBe(1);
    t.call('theme.closeView', ['VIEW1'], { gesture: true });
    expect(t.actionLog.run).toEqual([['close', { viewId: 'view1' }]]);
  });
});

describe('view (acceptance 5)', () => {
  it('close() outside a gesture is denied and ledgered; inside one it calls the host', () => {
    const t = makeGraph();
    t.state.gesture = false;
    t.call('view.close', [], { gesture: false });
    t.call('view.close', [], { gesture: false });
    expect(t.actionLog.run).toEqual([]);
    expect(t.counts()['view.close denied']).toBe(2);
    expect(t.actionLog.denied).toHaveLength(1);               // one notice per skin and api

    t.state.gesture = true;
    t.call('view.close', [], { gesture: false });             // inGesture() is the authority
    expect(t.actionLog.run).toEqual([['close', { viewId: 'view1' }]]);
  });

  it('the call context’s own gesture flag is honoured as well', () => {
    const t = makeGraph();
    t.call('view.minimize', [], { gesture: true });
    expect(t.actionLog.run).toEqual([['minimize', { viewId: 'view1' }]]);
    t.call('view.minimize', [], { gesture: false });
    expect(t.actionLog.run).toHaveLength(1);
    expect(t.counts()['view.minimize denied']).toBe(1);
  });

  it('returnToMediaCenter is a host action', () => {
    const t = makeGraph();
    t.call('view.returnToMediaCenter');
    expect(t.actionLog.run).toEqual([['returnToMediaCenter', { viewId: 'view1' }]]);
  });

  it('width and height read the model; a write updates it, so the script reads back what it wrote', () => {
    const t = makeGraph();
    expect(t.read('view.width')).toBe(549);
    expect(t.read('view.height')).toBe(394);
    t.write('view.width', 760);
    expect(t.read('view.width')).toBe(760);
    expect(t.el('view1').get('width')).toBe(760);
    expect(t.model.queued.some((q) => q.event === 'width_onchange')).toBe(true);
    t.write('view.width', 'wide');
    expect(t.read('view.width')).toBe(760);
  });

  it('timerInterval: 0 is off, under 50 is rejected and the old value kept', () => {
    const t = makeGraph();
    expect(t.read('view.timerInterval')).toBe(1000);
    t.write('view.timerInterval', 20);
    expect(t.read('view.timerInterval')).toBe(1000);
    expect(t.counts()['view.timerInterval cap']).toBe(1);
    t.write('view.timerInterval', 0);
    expect(t.read('view.timerInterval')).toBe(0);
    t.write('view.timerInterval', 49);
    expect(t.read('view.timerInterval')).toBe(0);
    t.write('view.timerInterval', 50);
    expect(t.read('view.timerInterval')).toBe(50);
    t.write('view.timerInterval', -1);
    expect(t.read('view.timerInterval')).toBe(50);
  });

  it('title is read-only; the phase-3 verbs are stubs', () => {
    const t = makeGraph();
    t.write('view.title', 'x');
    expect(t.read('view.title')).toBe('');
    for (const verb of ['maximize', 'restore', 'size', 'moveTo', 'alphaBlendTo']) t.call(`view.${verb}`, [1, 2, 3]);
    const c = t.counts();
    expect(c['view.maximize stub']).toBe(1);
    expect(c['view.moveTo stub']).toBe(1);
    expect(t.animCalls).toEqual([]);
  });

  it('the view global and its VIEW element are one object', () => {
    const t = makeGraph();
    const v = /** @type {any} */ (t.graph.globals.view);
    expect(t.graph.elementObject(t.el('view1'))).toBe(v);
    expect(v.handle).toBe(t.el('view1').handle);
    expect(t.graph.objectOf(t.el('view1').handle)).toBe(v);
  });
});

describe('event', () => {
  /** @returns {import('../../../src/engine/contracts').EventInit} */
  const init = () => ({
    x: 10, y: 20, clientX: 11, clientY: 21, offsetX: 3, offsetY: 4, screenX: 500, screenY: 600, screenWidth: 1920, screenHeight: 1080, button: 1, keyCode: 32,
    altKey: false, ctrlKey: true, shiftKey: false, srcElement: null, fromElement: null, toElement: null,
  });

  it('reads zeros and nulls between dispatches', () => {
    const t = makeGraph();
    expect([t.read('event.x'), t.read('event.keyCode'), t.read('event.ctrlKey'), t.read('event.srcElement')]).toEqual([0, 0, false, null]);
  });

  it('reads the current dispatch, case-insensitively, and forgets it afterwards', () => {
    const t = makeGraph();
    t.graph.setEvent({ ...init(), srcElement: t.el('bEqHandle'), fromElement: t.el('sEqEar') });
    expect(t.read('event.X')).toBe(10);
    expect(t.read('event.clientY')).toBe(21);
    expect(t.read('event.offsetX')).toBe(3);
    expect(t.read('event.screenX')).toBe(500);
    expect(t.read('event.button')).toBe(1);
    expect(t.read('event.keyCode')).toBe(32);
    expect(t.read('event.ctrlKey')).toBe(true);
    expect(t.read('event.shiftKey')).toBe(false);
    expect(t.read('event.srcElement')).toEqual({ __h: t.el('bEqHandle').handle });
    expect(t.graph.objectOf(t.el('bEqHandle').handle)?.get('id')).toBe('bEqHandle');
    expect(t.read('event.toElement')).toBeNull();
    t.graph.setEvent(null);
    expect(t.read('event.x')).toBe(0);
    expect(t.read('event.srcElement')).toBeNull();
  });

  it('screenWidth and screenHeight read the EventInit fields, and are live: no stub is ledgered', () => {
    const t = makeGraph();
    expect([t.read('event.screenWidth'), t.read('event.screenHeight')]).toEqual([0, 0]);   // between dispatches
    t.graph.setEvent(init());
    expect(t.read('event.screenWidth')).toBe(1920);
    expect(t.read('event.screenHeight')).toBe(1080);
    expect(t.read('event.SCREENWIDTH')).toBe(1920);
    t.graph.setEvent({ ...init(), screenWidth: 2560, screenHeight: 1440 });
    expect([t.read('event.screenWidth'), t.read('event.screenHeight')]).toEqual([2560, 1440]);
    t.graph.setEvent(null);
    expect([t.read('event.screenWidth'), t.read('event.screenHeight')]).toEqual([0, 0]);
    expect(t.ledger.entries()).toEqual([]);
  });

  it('screenWidth and screenHeight are read-only', () => {
    const t = makeGraph();
    t.graph.setEvent(init());
    t.write('event.screenWidth', 1);
    t.write('event.screenHeight', 1);
    expect([t.read('event.screenWidth'), t.read('event.screenHeight')]).toEqual([1920, 1080]);
  });

  it('event properties are read-only', () => {
    const t = makeGraph();
    t.graph.setEvent(init());
    t.write('event.x', 999);
    expect(t.read('event.x')).toBe(10);
  });
});
