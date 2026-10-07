// @ts-check
// The binding engine (E §5.11 `createBindings`, E D5 bindings) on a real built skin, the real
// object graph and the test host's scripted media and manual clock. The realm is not in the loop:
// `drain` runs plain functions in place of the skin handlers the model queued.
import { describe, expect, it } from 'vitest';
import { buildView, countEvents, makeSkin } from './helpers.js';
import { createBindings } from '../../../src/engine/bind/bindings.js';
import { createManualClock } from '../../../src/hosts/test/clock.js';
import { createLedger } from '../../../src/engine/model/ledger.js';

/** The song a test host's queue holds at `pos`. @param {ReturnType<typeof makeSkin>} skin @param {number} pos */
const songAt = (skin, pos) => skin.media.queue()[pos];

describe('install and settle', () => {
  it('assigns every wmpprop: value from the player at load, in the attribute\'s type', () => {
    const skin = makeSkin(`
      <TEXT id="status" value="wmpprop:player.status"/>
      <TEXT id="dur" value="wmpprop:player.currentMedia.DurationString;"/>
      <SLIDER id="vol" min="0" max="100" value="wmpprop:player.settings.volume"/>
      <BUTTON id="loop" down="wmpprop:player.settings.getMode('loop')"/>
      <SLIDER id="net" foregroundProgress="wmpprop:player.network.downloadProgress"/>`);
    expect(skin.el('status').get('value')).toBe('Stopped');
    expect(skin.el('dur').get('value')).toBe('00:00');
    expect(skin.el('vol').get('value')).toBe(50);
    expect(skin.el('loop').get('down')).toBe(false);
    expect(skin.el('net').get('foregroundProgress')).toBe(100);
  });

  it('queues the _onchange of what settling changed, and nothing for what stayed at its default', () => {
    const skin = makeSkin(`
      <SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="a();"/>
      <SLIDER id="pos" value="wmpprop:player.controls.currentPosition" value_onchange="b();"/>`);
    expect(skin.drain()).toEqual(['vol.value_onchange']);            // 0 -> 50 changed, position 0 -> 0 did not
  });

  it('follows another element\'s attribute, whatever the document order', () => {
    const skin = makeSkin(`
      <BUTTON id="follower" top="wmpprop:leader.top" left="wmpprop:leader.left"/>
      <BUTTON id="leader" top="40" left="7"/>`);
    expect(skin.el('follower').get('top')).toBe(40);
    expect(skin.el('follower').get('left')).toBe(7);
    skin.el('leader').set('top', 90, 'script');                         // a leader that animates drags its followers
    expect(skin.el('follower').get('top')).toBe(90);
    skin.el('leader').set('top', 91, 'anim');
    expect(skin.el('follower').get('top')).toBe(91);
  });

  it('settles a chain of bindings through each other', () => {
    const skin = makeSkin(`
      <BUTTON id="c" top="wmpprop:b.top"/>
      <BUTTON id="b" top="wmpprop:a.top"/>
      <BUTTON id="a" top="12"/>`);
    expect(skin.el('b').get('top')).toBe(12);
    expect(skin.el('c').get('top')).toBe(12);
  });

  it('reaches the equalizer and the media center objects through their element ids', () => {
    const skin = makeSkin(`
      <EQUALIZERSETTINGS id="eq"/>
      <SLIDER id="band3" min="-14" max="14" value="wmpprop:eq.gainLevel3"/>`);
    expect(skin.el('band3').get('value')).toBe(0);
    skin.host.dsp.eq.setGain(2, 6);
    expect(skin.el('band3').get('value')).toBe(6);
  });

  it('is a no-op the second time and after dispose', () => {
    const skin = makeSkin('<SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="a();"/>');
    skin.drain();
    skin.bindings.install();
    expect(skin.drain()).toEqual([]);
    skin.bindings.dispose();
    skin.bindings.install();
    skin.media.set({ volume: 20 });
    expect(skin.el('vol').get('value')).toBe(50);
    skin.bindings.dispose();                                            // twice is fine
  });
});

describe('change-only assignment', () => {
  it('an equal value fires nothing', () => {
    const skin = makeSkin('<SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="a();"/>');
    skin.drain();
    skin.view.takeDirty();
    let changes = 0;
    skin.view.onChange(() => { changes++; });
    skin.media.emit(['volume']);                                        // announced again, same 50
    skin.media.emit(['volume', 'playState']);
    expect(changes).toBe(0);
    expect(skin.view.takeQueuedEvents()).toEqual([]);
    expect(skin.view.takeDirty().size).toBe(0);
  });

  it('a different value assigns once and queues one _onchange', () => {
    const skin = makeSkin('<SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="a();"/>');
    skin.drain();
    const origins = /** @type {string[]} */ ([]);
    skin.view.onChange((_el, _attr, _v, origin) => { origins.push(origin); });
    skin.media.emit({ volume: 70 });
    expect(skin.el('vol').get('value')).toBe(70);
    expect(origins).toEqual(['binding']);
    expect(skin.drain()).toEqual(['vol.value_onchange']);
  });

  it('coerces to the attribute\'s type, and an invalid value keeps the previous one', () => {
    const skin = makeSkin(`
      <BUTTON id="b" visible="wmpprop:player.playState"/>
      <TEXT id="t" fontSize="wmpprop:player.settings.volume"/>`);
    // playState 1 (stopped, with a queue) is true; fontSize is an int
    expect(skin.el('b').get('visible')).toBe(true);
    expect(skin.el('t').get('fontSize')).toBe(50);
    skin.media.set({ playState: 'play', volume: 7 });                   // playState 3 is not a boolean: the old value stays
    expect(skin.el('b').get('visible')).toBe(true);
    expect(skin.el('t').get('fontSize')).toBe(7);
    skin.media.set({ playState: 'stop', song: null, queueLength: 0 });   // playState 0 is false
    expect(skin.el('b').get('visible')).toBe(false);
  });

  it('a script or user write holds until the source changes again', () => {
    const skin = makeSkin('<SLIDER id="vol" min="0" max="100" value="wmpprop:player.settings.volume"/>');
    skin.el('vol').set('value', 12, 'user');
    skin.media.emit(['playState']);                                     // unrelated source
    expect(skin.el('vol').get('value')).toBe(12);
    skin.media.emit({ volume: 80 });
    expect(skin.el('vol').get('value')).toBe(80);
  });

  it('never writes the player', () => {
    const skin = makeSkin(`
      <SLIDER id="vol" value="wmpprop:player.settings.volume" value_onchange="a();"/>
      <SLIDER id="pos" value="wmpprop:player.controls.currentPosition" value_onchange="b();"/>
      <BUTTON id="loop" down="wmpprop:player.settings.getMode('loop')"/>`);
    skin.media.set({ playState: 'play', duration: 100, elapsed: 3 });
    skin.media.set({ volume: 20, repeat: true });
    skin.clock.advance(2000);
    skin.drain();                                                       // the handlers are not run: nothing answers back
    skin.media.set({ playState: 'pause' });
    expect(skin.media.calls).toEqual([]);
  });
});

describe('wmpenabled: and wmpdisabled:', () => {
  it('the stop element\'s enabled follows isAvailable(\'stop\')', () => {
    const skin = makeSkin('<BUTTONGROUP id="g" width="100" height="20"><STOPELEMENT id="stop"/><PLAYELEMENT id="play"/></BUTTONGROUP>');
    expect(skin.el('stop').source('enabled')).toEqual({ kind: 'wmpenabled', method: 'stop' });
    expect(skin.el('stop').get('enabled')).toBe(false);                 // stopped
    expect(skin.el('play').get('enabled')).toBe(true);                  // play is always available (parity D16)
    skin.media.set({ playState: 'play' });
    expect(skin.el('stop').get('enabled')).toBe(true);
    skin.media.set({ playState: 'pause' });
    expect(skin.el('stop').get('enabled')).toBe(true);
    skin.media.set({ playState: 'stop' });
    expect(skin.el('stop').get('enabled')).toBe(false);
    expect(skin.el('play').get('enabled')).toBe(true);
  });

  it('the pause button\'s visible follows wmpenabled:player.controls.pause', () => {
    const skin = makeSkin('<BUTTON id="pause" visible="wmpenabled:player.controls.pause"/><PAUSEBUTTON id="stdpause"/>');
    expect(skin.el('pause').get('visible')).toBe(false);
    skin.media.set({ playState: 'play' });
    expect(skin.el('pause').get('visible')).toBe(true);
    expect(skin.el('stdpause').get('enabled')).toBe(true);
    skin.media.set({ playState: 'pause' });
    expect(skin.el('pause').get('visible')).toBe(false);
    expect(skin.el('stdpause').get('enabled')).toBe(false);
  });

  it('takes the last path segment, ignoring case, () and ;, on any boolean attribute (U-4)', () => {
    const skin = makeSkin(`
      <BUTTON id="a" visible="wmpenabled:player.controls.Pause();"/>
      <BUTTON id="b" enabled="wmpenabled:player.Controls.PAUSE;"/>
      <BUTTON id="c" tabStop="wmpenabled:player.controls.pause"/>
      <BUTTON id="d" down="wmpenabled:player.controls.pause"/>
      <BUTTON id="e" visible="wmpdisabled:player.controls.pause"/>`);
    const all = () => ['a.visible', 'b.enabled', 'c.tabStop', 'd.down', 'e.visible'].map((s) => skin.el(s.split('.')[0]).get(s.split('.')[1]));
    expect(all()).toEqual([false, false, false, false, true]);
    skin.media.set({ playState: 'play' });
    expect(all()).toEqual([true, true, true, true, false]);
  });

  it('is re-evaluated when the position range appears: currentPosition needs a duration', () => {
    const skin = makeSkin('<SLIDER id="seek" enabled="wmpenabled:player.controls.currentPosition"/>');
    expect(skin.el('seek').get('enabled')).toBe(false);
    skin.media.set({ duration: 200 });
    expect(skin.el('seek').get('enabled')).toBe(true);
    skin.media.set({ duration: 0 });
    expect(skin.el('seek').get('enabled')).toBe(false);
  });

  it('queues enabled_onchange when availability changes', () => {
    const skin = makeSkin('<BUTTONGROUP id="g" width="9" height="9"><STOPELEMENT id="stop" enabled_onchange="x();"/></BUTTONGROUP>');
    skin.drain();
    skin.media.set({ playState: 'play' });
    expect(skin.drain()).toEqual(['stop.enabled_onchange']);
  });
});

describe('unresolved paths', () => {
  it('leaves the default and records unresolved-binding once per binding', () => {
    const skin = makeSkin(`
      <TEXT id="a" value="wmpprop:nosuch.thing"/>
      <TEXT id="b" value="wmpprop:player.nosuch" />
      <TEXT id="c" value="wmpprop:player.settings.volume.deeper"/>
      <TEXT id="d" value="wmpprop:player.currentMedia"/>`);
    expect(['a', 'b', 'c', 'd'].map((id) => skin.el(id).get('value'))).toEqual(['', '', '', '']);
    const entries = skin.ledger.entries().filter((e) => e.kind === 'unresolved-binding');
    expect(entries.map((e) => [e.api, e.count])).toEqual([
      ['nosuch.thing', 1], ['player.nosuch', 1], ['player.settings.volume.deeper', 1],
    ]);                                                                  // an object at the end reads nothing, but resolves
    skin.media.set({ volume: 9 });
    skin.clock.advance(100);
    expect(skin.ledger.entries().filter((e) => e.kind === 'unresolved-binding').map((e) => e.count)).toEqual([1, 1, 1]);
  });

  it('works without a ledger', () => {
    const skin = makeSkin('<TEXT id="a" value="wmpprop:nosuch.thing"/>', { ledger: false });
    expect(skin.el('a').get('value')).toBe('');
  });

  it('does not treat __proto__ and constructor as members, roots or attributes', () => {
    const skin = makeSkin(`
      <TEXT id="constructor" value="named constructor"/>
      <TEXT id="__proto__" value="named proto"/>
      <TEXT id="viaCtor" value="wmpprop:constructor.value"/>
      <TEXT id="viaProto" value="wmpprop:__proto__.value"/>
      <TEXT id="g1" value="wmpprop:player.constructor"/>
      <TEXT id="g2" value="wmpprop:player.__proto__.constructor"/>
      <TEXT id="g3" value="wmpprop:view.constructor.name"/>
      <TEXT id="g4" value="wmpprop:toString.name"/>`);
    expect(skin.el('viaCtor').get('value')).toBe('named constructor');   // an element with that id is an ordinary root
    expect(skin.el('viaProto').get('value')).toBe('named proto');
    for (const id of ['g1', 'g2', 'g3', 'g4']) expect(skin.el(id).get('value'), id).toBe('');
    expect(skin.ledger.entries().filter((e) => e.kind === 'unresolved-binding').length).toBe(4);
    // the hold table is keyed by skin text too
    const bindings = skin.bindings;
    for (const name of ['__proto__', 'constructor', 'value', 'toString']) {
      bindings.suspend(skin.el('viaCtor'), name);
      bindings.resume(skin.el('viaCtor'), name);
    }
    expect(({}).constructor).toBe(Object);
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});

describe('what is not a binding', () => {
  it('leaves handlers, jscript:, res:// and misspelled prefixes to the parts that own them', () => {
    const skin = makeSkin(`
      <BUTTON id="h" onclick="wmpprop:player.status" left="jscript:5" top="wmppprop:player.settings.volume" width="20"/>
      <TEXT id="r" value="res://wmploc/RT_STRING/#2091"/>`);
    const h = skin.el('h');
    expect(h.handlers.get('onclick')?.source).toBe('wmpprop:player.status');   // a label in front of a handler's code (spec 2.3)
    expect(h.get('left')).toBe(0);                                              // evaluated by the layout pass, not here
    expect(h.get('top')).toBe(0);
    expect(skin.el('r').get('value')).toBe('%1 / %2');                          // resolved by the builder
    expect(skin.ledger.entries().filter((e) => e.kind === 'unresolved-binding')).toEqual([]);
    skin.media.set({ volume: 12 });
    expect(h.get('top')).toBe(0);
  });

  it('does not bind a read-only attribute, not even through the quiet position path', () => {
    // the slider's ticks leave frames in between, where the quiet write would otherwise be tried
    const skin = makeSkin(`
      <SLIDER id="seek" value="wmpprop:player.controls.currentPosition" value_onchange="s();"/>
      <TEXT id="t" textWidth="wmpprop:player.controls.currentPosition" textWidth_onchange="x();" value="wmpprop:player.status"/>`);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 40 });
    skin.clock.advance(500);
    expect(skin.el('seek').get('value')).toBeGreaterThan(40);
    expect(skin.el('t').get('textWidth')).toBe(0);
    expect(skin.el('t').get('value')).toBe('Playing');
    expect(skin.ledger.entries().filter((e) => e.kind === 'unresolved-binding')).toEqual([]);
  });

  it('a sidecar-style x- attribute with a binding in its own markup is only text', () => {
    const skin = makeSkin('<SLIDER id="s" x-foregroundMode="wmpprop:player.status"/>');
    expect(skin.el('s').get('x-foregroundMode')).toBe('progress');             // the default: the skin's text did nothing
    expect(skin.ledger.entries()).toEqual([]);
  });
});

describe('re-resolution', () => {
  it('replacing currentMedia re-resolves a bound duration', () => {
    const skin = makeSkin(`
      <SLIDER id="seek" min="0" max="wmpprop:player.currentMedia.duration" value_onchange="x();" max_onchange="y();"/>
      <TEXT id="name" value="wmpprop:player.currentMedia.name"/>`);
    expect(skin.el('seek').get('max')).toBe(0);                          // no current song, no duration
    skin.drain();
    skin.media.set({ song: songAt(skin, 1), duration: songAt(skin, 1).durationSec });
    expect(skin.el('seek').get('max')).toBe(222);
    expect(skin.el('name').get('value')).toBe('Weightless');
    expect(skin.drain()).toEqual(['seek.max_onchange']);
    skin.media.set({ song: songAt(skin, 2), duration: songAt(skin, 2).durationSec });
    expect(skin.el('seek').get('max')).toBe(258);
    expect(skin.el('name').get('value')).toBe('Harbor Lights');
    skin.media.set({ song: null, duration: 0 });
    expect(skin.el('seek').get('max')).toBe(0);
    expect(skin.el('name').get('value')).toBe('');
  });

  it('resolves the path again when an object on it is replaced, and listens to the new one only', () => {
    const { view } = buildView('<TEXT id="t" value="wmpprop:a.cur.val"/>');
    /** a world of two objects: `a.cur` is one of them, and each has a `val` with its own change channel */
    const world = { cur: 'x1', vals: /** @type {Record<string, string>} */ ({ x1: 'one', x2: 'two' }) };
    /** @type {Map<string, Set<() => void>>} */
    const channels = new Map();
    const listen = (/** @type {string} */ ch, /** @type {() => void} */ cb) => {
      if (!channels.has(ch)) channels.set(ch, new Set());
      /** @type {Set<() => void>} */ (channels.get(ch)).add(cb);
      return () => { channels.get(ch)?.delete(cb); };
    };
    const fire = (/** @type {string} */ ch) => { for (const cb of [...(channels.get(ch) ?? [])]) cb(); };
    let resolved = 0;
    const graph = /** @type {any} */ ({
      changeSource(/** @type {string} */ path) {
        if (path !== 'a.cur.val') return null;
        resolved++;
        const cur = world.cur;                                           // the object this resolution found
        return {
          read: () => world.vals[cur],
          subscribe: (/** @type {() => void} */ cb) => {
            const stops = [listen('a.cur', cb), listen(`${cur}.val`, cb)];
            return () => { for (const stop of stops) stop(); };
          },
        };
      },
    });
    const engine = createBindings(view, graph, createManualClock(), { realmTickHz: 10 });
    engine.install();
    const t = /** @type {import('../../../src/engine/contracts').ElementModel} */ (view.byId('t'));
    expect(t.get('value')).toBe('one');
    expect([...channels.keys()].sort()).toEqual(['a.cur', 'x1.val']);
    world.vals.x1 = 'uno';
    fire('x1.val');
    expect(t.get('value')).toBe('uno');
    world.cur = 'x2';                                                    // the intermediate object is replaced
    fire('a.cur');
    expect(resolved).toBeGreaterThanOrEqual(3);
    expect(t.get('value')).toBe('two');
    expect(channels.get('x1.val')?.size).toBe(0);                        // the old object is no longer listened to
    expect(channels.get('x2.val')?.size).toBe(1);
    world.vals.x1 = 'changed';
    fire('x1.val');
    expect(t.get('value')).toBe('two');
    world.vals.x2 = 'dos';
    fire('x2.val');
    expect(t.get('value')).toBe('dos');
    engine.dispose();
    expect([...channels.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('keeps following the path through many notifications (each re-resolution replaces its listener)', () => {
    const skin = makeSkin('<SLIDER id="vol" value="wmpprop:player.settings.volume"/>');
    for (let v = 1; v <= 40; v++) {
      skin.media.set({ volume: v });
      expect(skin.el('vol').get('value')).toBe(v);
    }
  });
});

describe('drag suspension', () => {
  it('holds a volume change from media during a drag and applies it once at drag end', () => {
    const skin = makeSkin('<VOLUMESLIDER id="volume"/>');
    skin.drain();
    const volume = skin.el('volume');
    expect(volume.get('value')).toBe(50);
    skin.bindings.suspend(volume, 'value');
    skin.media.set({ volume: 30 });
    skin.media.set({ volume: 35 });
    skin.media.set({ volume: 40 });
    expect(volume.get('value')).toBe(50);                                // untouched mid-drag
    expect(skin.view.takeQueuedEvents()).toEqual([]);
    skin.bindings.resume(volume, 'value');
    expect(volume.get('value')).toBe(40);                                // latest wins
    expect(skin.drain()).toEqual(['volume.value_onchange']);             // applied once
    skin.bindings.resume(volume, 'value');                               // already released
    expect(skin.drain()).toEqual([]);
  });

  it('the user\'s own writes during the drag are not overwritten, and resume reads the source', () => {
    const skin = makeSkin('<VOLUMESLIDER id="volume"/>');
    const volume = skin.el('volume');
    skin.bindings.suspend(volume, 'value');
    volume.set('value', 61, 'user');
    skin.media.set({ volume: 44 });
    expect(volume.get('value')).toBe(61);
    // the drag-end handler writes the player first, as the runtime does ...
    skin.scriptWrite('settings.volume', 61);
    skin.bindings.resume(volume, 'value');
    // ... so the read sees what the user chose, not the stale 44
    expect(volume.get('value')).toBe(61);
  });

  it('holds a slider\'s max with its value, and nothing else', () => {
    const skin = makeSkin(`
      <SLIDER id="seek" min="0" max="wmpprop:player.currentMedia.duration" value="wmpprop:player.controls.currentPosition"/>
      <TEXT id="name" value="wmpprop:player.currentMedia.name"/>
      <BUTTON id="other" visible="wmpenabled:player.controls.pause"/>`);
    const seek = skin.el('seek');
    skin.bindings.suspend(seek, 'value');
    skin.media.set({ song: songAt(skin, 1), duration: 222 });
    expect(seek.get('max')).toBe(0);                                     // held with value
    expect(skin.el('name').get('value')).toBe('Weightless');             // other elements keep following
    skin.bindings.resume(seek, 'value');
    expect(seek.get('max')).toBe(222);
    // any bound attribute can be held; one with no binding is a no-op
    skin.bindings.suspend(skin.el('name'), 'value');
    skin.media.set({ song: songAt(skin, 2), duration: 258 });
    expect(skin.el('name').get('value')).toBe('Weightless');
    skin.bindings.resume(skin.el('name'), 'value');
    expect(skin.el('name').get('value')).toBe('Harbor Lights');
    skin.bindings.suspend(seek, 'toolTip');
    skin.bindings.resume(seek, 'toolTip');
    skin.media.set({ song: songAt(skin, 3), duration: 301 });
    expect(seek.get('max')).toBe(301);
  });

  it('holds a CUSTOMSLIDER the same way', () => {
    const skin = makeSkin('<CUSTOMSLIDER id="c" min="0" max="wmpprop:player.currentMedia.duration" value="wmpprop:player.settings.volume"/>');
    const c = skin.el('c');
    skin.bindings.suspend(c, 'value');
    skin.media.set({ volume: 33, song: songAt(skin, 1), duration: 222 });
    expect([c.get('value'), c.get('max')]).toEqual([50, 0]);
    skin.bindings.resume(c, 'value');
    expect([c.get('value'), c.get('max')]).toEqual([33, 222]);
  });

  it('snaps the balance slider back at drag end when the detent moved the stored value (parity D17)', () => {
    const skin = makeSkin('<BALANCESLIDER id="balance"/>');
    const balance = skin.el('balance');
    /** the balance slider's value_onchange: `player.settings.balance=value` */
    const handlers = { 'balance.value_onchange': (/** @type {import('../../../src/engine/contracts').ElementModel} */ el) => skin.scriptWrite('settings.balance', /** @type {number} */ (el.get('value'))) };
    skin.drain(handlers);
    skin.bindings.suspend(balance, 'value');
    balance.set('value', 3, 'user');                                     // within the +-5 detent
    skin.drain(handlers);
    expect(skin.host.dsp.balance.get()).toBe(0);
    expect(balance.get('value')).toBe(3);                                // held until the drag ends
    skin.bindings.resume(balance, 'value');
    expect(balance.get('value')).toBe(0);
  });

  it('does not poll a held position binding, and resumes with a fresh read', () => {
    const skin = makeSkin('<SLIDER id="seek" min="0" max="300" value="wmpprop:player.controls.currentPosition" value_onchange="x();"/>');
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.clock.advance(500);
    const seek = skin.el('seek');
    const before = /** @type {number} */ (seek.get('value'));
    skin.bindings.suspend(seek, 'value');
    skin.clock.advance(1000);
    expect(seek.get('value')).toBe(before);
    skin.bindings.resume(seek, 'value');
    expect(seek.get('value')).toBeCloseTo(skin.media.elapsed(), 6);
  });
});

describe('one media event, at most one command', () => {
  /** The volume slider's handler as the predefined VOLUMESLIDER spells it: player.settings.volume = value. */
  const writeVolume = (/** @type {ReturnType<typeof makeSkin>} */ skin) => ({
    'volume.value_onchange': (/** @type {import('../../../src/engine/contracts').ElementModel} */ el) => {
      skin.scriptWrite('settings.volume', /** @type {number} */ (el.get('value')));
      skin.scriptWrite('settings.mute', false);                          // the rest of the predefined handler: a no-op when not muted
    },
  });

  it('a volume change from MPD reaches the slider and sends nothing back', () => {
    const skin = makeSkin('<VOLUMESLIDER id="volume"/>');
    const handlers = writeVolume(skin);
    skin.drain(handlers);
    skin.media.set({ volume: 70 });
    expect(skin.el('volume').get('value')).toBe(70);
    expect(skin.drain(handlers)).toEqual(['volume.value_onchange']);     // the handler ran ...
    skin.clock.advance(1000);
    expect(skin.volumeCalls()).toEqual([]);                              // ... and found the player already there
    expect(skin.drain(handlers)).toEqual([]);
  });

  it('a drag sends one setVolume, and its echo sends none', () => {
    const skin = makeSkin('<VOLUMESLIDER id="volume"/>');
    const handlers = writeVolume(skin);
    skin.drain(handlers);
    const volume = skin.el('volume');
    skin.bindings.suspend(volume, 'value');
    for (const v of [52, 55, 60, 66]) {                                  // the pointer moves; the handler runs per change
      volume.set('value', v, 'user');
      skin.drain(handlers);
      skin.clock.advance(10);
    }
    skin.bindings.resume(volume, 'value');
    skin.drain(handlers);
    skin.clock.advance(100);                                             // the trailing 40 ms debounce fires
    expect(skin.volumeCalls().map((c) => c.args)).toEqual([[66]]);       // MPD echoed 66 in the fake: the binding found it equal
    expect(volume.get('value')).toBe(66);
    expect(skin.drain(handlers)).toEqual([]);
    skin.clock.advance(1000);
    expect(skin.volumeCalls().length).toBe(1);
  });

  it('several MPD volume events in a row send nothing', () => {
    const skin = makeSkin('<VOLUMESLIDER id="volume"/>');
    const handlers = writeVolume(skin);
    skin.drain(handlers);
    for (const v of [10, 20, 30, 31, 31, 90]) { skin.media.set({ volume: v }); skin.drain(handlers); }
    skin.clock.advance(2000);
    expect(skin.volumeCalls()).toEqual([]);
    expect(skin.el('volume').get('value')).toBe(90);
  });
});

describe('position bindings and the realm tick', () => {
  const SEEK = '<SLIDER id="seek" min="0" max="wmpprop:player.currentMedia.duration" value="wmpprop:player.controls.currentPosition" value_onchange="onSeek();"/>';
  const play = (/** @type {ReturnType<typeof makeSkin>} */ skin, duration = 300) => skin.media.set({ playState: 'play', duration, elapsed: 0 });

  it('on a 60 Hz clock the seek value updates every frame while value_onchange reaches the realm at most 10 times a second', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    skin.drain();
    const seek = skin.el('seek');
    /** @type {number[]} */
    const values = [];
    /** @type {number[]} */
    const positions = [];
    skin.clock.onFrame(() => {                                           // after the engine's own frame callback
      values.push(/** @type {number} */ (seek.get('value')));
      positions.push(skin.media.elapsed());
    });
    const counts = countEvents(skin, () => skin.clock.advance(1000));
    expect(values.length).toBeGreaterThanOrEqual(60);
    for (let i = 1; i < values.length; i++) expect(values[i], `frame ${i}`).toBeGreaterThan(values[i - 1]);
    expect(values[0]).toBeGreaterThan(0);
    expect(values).toEqual(positions);                                   // each frame shows that frame's live position
    const events = counts.get('seek.value_onchange') ?? 0;
    expect(events).toBeGreaterThanOrEqual(8);
    expect(events).toBeLessThanOrEqual(10);
  });

  it('holds the bound at 10 a second over a longer run, and at the configured rate', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    const counts = countEvents(skin, () => skin.clock.advance(5000));
    expect(counts.get('seek.value_onchange')).toBeLessThanOrEqual(50);
    expect(counts.get('seek.value_onchange')).toBeGreaterThanOrEqual(40);

    const slow = makeSkin(SEEK, { realmTickHz: 2 });
    play(slow);
    const slowCounts = countEvents(slow, () => slow.clock.advance(4000));
    expect(slowCounts.get('seek.value_onchange')).toBeLessThanOrEqual(8);
    expect(slowCounts.get('seek.value_onchange')).toBeGreaterThanOrEqual(6);
    expect(slow.el('seek').get('value')).toBeCloseTo(slow.media.elapsed(), 1);   // still every frame on the host side
  });

  it('never exceeds the rate in any one-second window', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    /** @type {number[]} */
    const stamps = [];
    for (let i = 0; i < 400; i++) {
      skin.clock.advance(16);
      for (const { event } of skin.view.takeQueuedEvents()) if (event === 'value_onchange') stamps.push(skin.clock.now());
    }
    for (let i = 0; i + 10 < stamps.length; i++) expect(stamps[i + 10] - stamps[i], `events ${i}..${i + 10}`).toBeGreaterThanOrEqual(1000);
  });

  it('a seek and a state change publish at once, and a paused player publishes nothing', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    skin.clock.advance(500);
    skin.drain();
    skin.media.set({ elapsed: 120 });                                    // a seek echoed by MPD, between frames
    expect(skin.el('seek').get('value')).toBeCloseTo(120, 6);
    expect(skin.drain()).toEqual(['seek.value_onchange']);
    skin.media.set({ playState: 'pause' });
    skin.drain();
    const counts = countEvents(skin, () => skin.clock.advance(2000));
    expect(counts.size).toBe(0);
    expect(skin.el('seek').get('value')).toBeCloseTo(120, 6);
  });

  it('tells the realm of a change that was written quietly and then stopped moving', () => {
    const skin = makeSkin(SEEK);
    skin.media.set({ playState: 'play', duration: 10.05, elapsed: 10 });
    skin.drain();
    const seek = skin.el('seek');
    const counts = countEvents(skin, () => skin.clock.advance(200));
    expect(seek.get('value')).toBe(10.05);                               // the position stopped at the duration
    expect(counts.get('seek.value_onchange')).toBe(1);                   // only the tick that carries the clamp: the move was quiet
  });

  it('puts the position string through the same path and tick', () => {
    const skin = makeSkin('<TEXT id="pos" value="wmpprop:player.controls.currentPositionString" value_onchange="t();"/>');
    skin.media.set({ playState: 'play', duration: 300, elapsed: 59.5 });
    skin.drain();
    const counts = countEvents(skin, () => skin.clock.advance(1100));
    expect(skin.el('pos').get('value')).toBe('01:00');
    expect(counts.get('pos.value_onchange')).toBe(1);                    // 00:59 -> 01:00: once, not per frame
  });

  it('writes between ticks with origin quiet, never init, and on a tick with origin binding', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    skin.drain();
    /** @type {Map<string, number>} */
    const origins = new Map();
    skin.view.onChange((el, attr, _v, origin) => {
      if (el.id === 'seek' && attr === 'value') origins.set(origin, (origins.get(origin) ?? 0) + 1);
    });
    skin.clock.advance(1000);
    expect([...origins.keys()].sort()).toEqual(['binding', 'quiet']);
    expect(origins.get('binding')).toBeLessThanOrEqual(10);
    expect(origins.get('quiet')).toBeGreaterThanOrEqual(50);
  });

  it('an element with no _onchange handler is written on every frame with origin binding', () => {
    const skin = makeSkin('<SLIDER id="seek" max="300" value="wmpprop:player.controls.currentPosition"/>');
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    /** @type {Set<string>} */
    const origins = new Set();
    skin.view.onChange((_e, _a, _v, origin) => origins.add(origin));
    skin.clock.advance(500);
    expect([...origins]).toEqual(['binding']);
  });

  it('gives <controls currentPosition_onchange> its tick, and only while the position moves', () => {
    const skin = makeSkin('<PLAYER><CONTROLS id="ctl" currentPosition_onchange="onPos();"/></PLAYER>');
    const ctl = skin.el('ctl');
    expect(skin.drain()).toEqual([]);                                    // no event at load
    expect(countEvents(skin, () => skin.clock.advance(1000)).size).toBe(0);   // stopped: silent
    play(skin);
    skin.drain();
    const counts = countEvents(skin, () => skin.clock.advance(1000));
    expect(counts.get('ctl.currentposition_onchange')).toBeGreaterThanOrEqual(8);
    expect(counts.get('ctl.currentposition_onchange')).toBeLessThanOrEqual(10);
    expect(/** @type {number} */ (ctl.get('currentPosition'))).toBeGreaterThan(0.8);
    skin.media.set({ playState: 'pause' });
    skin.drain();
    expect(countEvents(skin, () => skin.clock.advance(1000)).size).toBe(0);
  });

  it('leaves a CONTROLS element without the handler, or with its own binding, alone', () => {
    const skin = makeSkin(`
      <PLAYER><CONTROLS id="plain"/><CONTROLS id="own" currentPosition="wmpprop:player.settings.volume" currentPosition_onchange="p();"/></PLAYER>`);
    play(skin);
    skin.clock.advance(1000);
    expect(skin.el('plain').get('currentPosition')).toBe(0);
    expect(skin.el('own').get('currentPosition')).toBe(50);              // its own binding: the volume, not the position
  });

  it('is not confused by a clock that starts over', () => {
    const skin = makeSkin(SEEK);
    play(skin);
    skin.clock.advance(1000);
    skin.drain();
    skin.bindings.frame(5);                                              // time went backwards
    skin.bindings.frame(21);
    expect(skin.el('seek').get('value')).toBeCloseTo(skin.media.elapsed(), 9);
  });
});

describe('cap and failure handling', () => {
  it('stops a chain of bindings that feed each other more than 32 deep and records it', () => {
    // two bindings that rewrite each other's source through a coercion that never settles are not
    // expressible with real elements, so the graph is faked: every read returns a new number
    const skin = makeSkin('<BUTTON id="a" left="wmpprop:player.settings.volume"/>', { install: false });
    let n = 0;
    const real = skin.graph.changeSource;
    /** @type {Set<() => void>} */
    const subs = new Set();
    skin.graph.changeSource = (path) => (path === 'player.settings.volume'
      ? { read: () => ++n, subscribe: (cb) => { subs.add(cb); return () => { subs.delete(cb); }; } }
      : real(path));
    const el = skin.el('a');
    // the element's own change re-fires the source, like a binding whose source is an attribute that it writes
    skin.view.onChange((e) => { if (e === el) for (const cb of [...subs]) cb(); });
    skin.bindings.install();
    expect(n).toBeLessThanOrEqual(40);
    expect(skin.ledger.entries().some((e) => e.kind === 'cap' && e.api === 'wmpprop chain')).toBe(true);
  });

  it('survives a source whose read throws, and records it once', () => {
    const skin = makeSkin('<TEXT id="a" value="wmpprop:player.settings.volume"/><TEXT id="b" value="wmpprop:player.status"/>', { install: false });
    const real = skin.graph.changeSource;
    skin.graph.changeSource = (path) => {
      const src = real(path);
      return path === 'player.settings.volume' && src ? { read: () => { throw new Error('boom'); }, subscribe: (cb) => src.subscribe(cb) } : src;
    };
    skin.bindings.install();
    skin.media.set({ volume: 3 });
    skin.media.set({ volume: 4 });
    expect(skin.el('a').get('value')).toBe('');
    expect(skin.el('b').get('value')).toBe('Stopped');
    const faults = skin.ledger.entries().filter((e) => e.kind === 'soft-fault');
    expect(faults.map((e) => [e.api, e.count])).toEqual([['player.settings.volume', 1]]);
  });
});

describe('the quiet origin', () => {
  it('updates the element, marks it dirty and tells the change listeners, and queues no _onchange', () => {
    const { view } = buildView('<SLIDER id="s" value="1" value_onchange="a();"/>');
    const s = /** @type {import('../../../src/engine/contracts').ElementModel} */ (view.byId('s'));
    view.takeDirty();
    view.takeQueuedEvents();
    /** @type {string[]} */
    const origins = [];
    view.onChange((_el, _attr, _v, origin) => { origins.push(origin); });
    expect(s.set('value', 40, 'quiet')).toBe(true);
    expect(s.get('value')).toBe(40);
    expect([...(view.takeDirty().get(s) ?? [])]).toEqual(['value']);
    expect(view.takeQueuedEvents()).toEqual([]);
    expect(s.set('value', 40, 'quiet')).toBe(false);                    // change-only, like every origin
    expect(s.set('value', 41, 'binding')).toBe(true);
    expect(view.takeQueuedEvents()).toEqual([{ el: s, event: 'value_onchange' }]);
    expect(origins).toEqual(['quiet', 'binding']);
  });

  it('does not get past a read-only attribute (only init and host do)', () => {
    const { view } = buildView('<TEXT id="t"/>');
    const t = /** @type {import('../../../src/engine/contracts').ElementModel} */ (view.byId('t'));
    expect(t.set('textWidth', 99, 'quiet')).toBe(false);
    expect(t.get('textWidth')).toBe(0);
    expect(t.set('textWidth', 99, 'host')).toBe(true);
  });
});

describe('followers of a quiet write', () => {
  /** The G3 reviewer's case, verbatim. */
  const PAIR = `
    <SLIDER id="seek" value="wmpprop:player.controls.currentPosition" value_onchange="a();"/>
    <TEXT id="t" value="wmpprop:seek.value" value_onchange="b();"/>`;

  it('a text bound to a seek value tracks every frame and reaches the realm at most 10 times a second, like its leader', () => {
    const skin = makeSkin(PAIR);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.drain();
    const seek = skin.el('seek');
    const t = skin.el('t');
    /** @type {number[]} */
    const seen = [];
    /** @type {unknown[]} */
    const leader = [];
    skin.clock.onFrame(() => {                                           // after the engine's own frame callback
      seen.push(Number(t.get('value')));
      leader.push(seek.get('value'));
    });
    const counts = countEvents(skin, () => skin.clock.advance(1000));
    expect(seen.length).toBeGreaterThanOrEqual(60);
    expect(seen).toEqual(leader);                                        // the text shows each frame's seek value
    for (let i = 1; i < seen.length; i++) expect(seen[i], `frame ${i}`).toBeGreaterThan(seen[i - 1]);
    expect(counts.get('seek.value_onchange')).toBeLessThanOrEqual(10);
    expect(counts.get('seek.value_onchange')).toBeGreaterThanOrEqual(8);
    expect(counts.get('t.value_onchange')).toBeLessThanOrEqual(10);
    expect(counts.get('t.value_onchange')).toBeGreaterThanOrEqual(8);
  });

  it('applies with origin quiet when the leader was written quietly, and binding when it was not', () => {
    const skin = makeSkin(PAIR);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.drain();
    /** @type {Map<string, Set<string>>} */
    const origins = new Map();
    skin.view.onChange((el, attr, _v, origin) => {
      if (attr !== 'value') return;
      if (!origins.has(el.id)) origins.set(el.id, new Set());
      /** @type {Set<string>} */ (origins.get(el.id)).add(origin);
    });
    skin.clock.advance(1000);
    expect([...(origins.get('seek') ?? [])].sort()).toEqual(['binding', 'quiet']);
    expect([...(origins.get('t') ?? [])].sort()).toEqual(['binding', 'quiet']);
  });

  it('a seek publishes at once to the leader and to its follower', () => {
    const skin = makeSkin(PAIR);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.clock.advance(500);
    skin.drain();
    skin.media.set({ elapsed: 120 });
    expect(skin.el('t').get('value')).toBe('120');
    expect(skin.drain().sort()).toEqual(['seek.value_onchange', 't.value_onchange']);
  });

  it('the quietness is inherited down a chain of followers', () => {
    const skin = makeSkin(`${PAIR}
      <TEXT id="u" value="wmpprop:t.value" value_onchange="c();"/>
      <TEXT id="w" value="wmpprop:u.value" value_onchange="d();"/>`);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.drain();
    const counts = countEvents(skin, () => skin.clock.advance(1000));
    for (const id of ['seek', 't', 'u', 'w']) {
      expect(counts.get(`${id}.value_onchange`), id).toBeLessThanOrEqual(10);
      expect(counts.get(`${id}.value_onchange`), id).toBeGreaterThanOrEqual(8);
    }
    expect(skin.el('w').get('value')).toBe(skin.el('t').get('value'));
  });

  it('a follower of a write that is not quiet is told, whatever the rate', () => {
    const skin = makeSkin(`
      <BUTTON id="leader" top="1" top_onchange="a();"/>
      <BUTTON id="follower" top="wmpprop:leader.top" top_onchange="b();"/>`);
    skin.drain();
    for (let i = 2; i < 12; i++) skin.el('leader').set('top', i, 'script');
    const ran = skin.drain();
    expect(ran.filter((n) => n === 'follower.top_onchange').length).toBe(10);
    expect(ran.filter((n) => n === 'leader.top_onchange').length).toBe(10);
  });

  it('a held follower stays held through quiet writes and is applied once at resume', () => {
    const skin = makeSkin(PAIR);
    skin.media.set({ playState: 'play', duration: 300, elapsed: 0 });
    skin.clock.advance(300);
    skin.drain();
    const t = skin.el('t');
    skin.bindings.suspend(t, 'value');
    const before = t.get('value');
    skin.clock.advance(500);
    expect(t.get('value')).toBe(before);
    skin.bindings.resume(t, 'value');
    expect(Number(t.get('value'))).toBe(skin.el('seek').get('value'));
  });
});

describe('stub ledger entries', () => {
  /** @param {ReturnType<typeof makeSkin>} skin */
  const stubs = (skin) => skin.ledger.entries().filter((e) => e.kind === 'stub').map((e) => [e.api, e.count]);

  it('a stub bound through currentMedia is counted once, however many songs come and go', () => {
    const skin = makeSkin('<TEXT id="m" value="wmpprop:player.currentMedia.markerCount"/>');
    expect(stubs(skin)).toEqual([['player.currentMedia.markerCount', 1]]);
    for (let i = 0; i < 6; i++) skin.media.set({ song: songAt(skin, 1 + (i % 3)), duration: 100 + i });
    skin.media.set({ song: null, duration: 0 });
    skin.clock.advance(100);
    expect(stubs(skin)).toEqual([['player.currentMedia.markerCount', 1]]);
  });

  it('is counted once per binding: two bindings to one stub count two', () => {
    const skin = makeSkin(`
      <TEXT id="a" value="wmpprop:player.currentMedia.markerCount"/>
      <TEXT id="b" value="wmpprop:player.currentMedia.markerCount"/>
      <TEXT id="c" value="wmpprop:player.settings.rate"/>`);
    skin.media.set({ song: songAt(skin, 2), duration: 258 });
    skin.media.set({ song: songAt(skin, 3), duration: 301 });
    expect(stubs(skin)).toEqual([['player.currentMedia.markerCount', 2], ['player.settings.rate', 1]]);
  });

  it('still counts a stub that a later resolution reaches for the first time, and every other kind each time', () => {
    const { view } = buildView('<TEXT id="t" value="wmpprop:a.b.c"/>');
    const sha = 'f'.repeat(64);
    const ledger = createLedger(sha);
    let build = 0;
    const graph = /** @type {any} */ ({
      changeSource(/** @type {string} */ path) {
        if (path !== 'a.b.c') return null;
        build++;
        ledger.record('a.stubOne', 'stub');
        if (build >= 3) ledger.record('a.stubTwo', 'stub');
        ledger.record('a.odd', 'unknown-member');
        return { read: () => 'x', subscribe: (/** @type {() => void} */ cb) => { subs.add(cb); return () => { subs.delete(cb); }; } };
      },
    });
    /** @type {Set<() => void>} */
    const subs = new Set();
    const engine = createBindings(view, graph, createManualClock(), { realmTickHz: 10, ledger });
    engine.install();
    for (let i = 0; i < 3; i++) for (const cb of [...subs]) cb();
    const by = Object.fromEntries(ledger.entries().map((e) => [`${e.kind} ${e.api}`, e.count]));
    expect(by).toEqual({ 'stub a.stubOne': 1, 'stub a.stubTwo': 1, 'unknown-member a.odd': build });
    engine.dispose();
  });

  it('puts the ledger back as it found it, and copes with one that cannot be wrapped', () => {
    const skin = makeSkin('<TEXT id="m" value="wmpprop:player.currentMedia.markerCount"/>');
    const record = skin.ledger.record;
    skin.media.set({ song: songAt(skin, 1), duration: 222 });
    expect(skin.ledger.record).toBe(record);

    const { view } = buildView('<TEXT id="t" value="wmpprop:a.b"/>');
    /** @type {Array<[string, string]>} */
    const calls = [];
    const frozen = Object.freeze({ record: (/** @type {string} */ api, /** @type {string} */ kind) => { calls.push([api, kind]); }, entries: () => [] });
    const graph = /** @type {any} */ ({
      changeSource() {
        frozen.record('a.b', 'stub');
        return { read: () => 'x', subscribe: () => () => {} };
      },
    });
    const engine = createBindings(view, graph, createManualClock(), { realmTickHz: 10, ledger: /** @type {any} */ (frozen) });
    expect(() => engine.install()).not.toThrow();
    expect(calls).toEqual([['a.b', 'stub']]);
    engine.dispose();
  });
});
