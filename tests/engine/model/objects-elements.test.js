// @ts-check
import { describe, expect, it } from 'vitest';
import { EFFECT_TITLE, EFFECT_TYPE } from '../../../src/engine/model/objects/element.js';
import { fakeEffects, headspaceLike, makeGraph } from './objects-fakes.js';

describe('element attributes', () => {
  it('reads resolve case-insensitively to the table’s members, with their types', () => {
    const t = makeGraph();
    expect(t.read('bEqHandle.upToolTip')).toBe('Open');
    expect(t.read('bEqHandle.uptooltip')).toBe('Open');
    expect(t.read('bEqHandle.UPTOOLTIP')).toBe('Open');
    expect(t.read('xEqTt.tooltip')).toBe('');                // text has toolTip; the markup set only value
    expect(t.read('xEqTt.value')).toBe('Open graphic equalizer controls');
    expect(t.read('sEqEar.left')).toBe(207);
    expect(t.read('sEqEar.visible')).toBe(true);
    expect(t.read('vid.visible')).toBe(false);
    expect(t.read('pl.visible')).toBe(false);
  });

  it('a colour reads as #rrggbb, none or auto; an unset value reads as the type’s empty', () => {
    const t = makeGraph();
    expect(t.read('pl.backgroundColor')).toBe('#285f03');
    expect(t.read('sEqEar.backgroundColor')).toBe('none');
    expect(t.read('sEqEar.clippingColor')).toBe('auto');
    expect(t.read('bEqHandle.transparencyColor')).toBe('');  // no default: unset
    expect(t.read('bEqHandle.cursor')).toBe('system');
  });

  it('an attribute a markup set that the table does not know is not a member', () => {
    const t = makeGraph();
    expect(t.read('bEqHandle.myAttribute')).toBeUndefined();
    expect(t.counts()['button.myattribute unknown-member']).toBe(1);
    t.write('bEqHandle.myAttribute', 5);
    expect(t.model.changes).toEqual([]);
  });

  it('a write goes through the model with origin script, and queues the _onchange event', () => {
    const t = makeGraph();
    t.write('bEqHandle.image', 'close.bmp');
    t.write('bEqHandle.upToolTip', 'Close');
    t.write('bEqHandle.hoverImage', 'close_hover.bmp');
    expect(t.read('bEqHandle.image')).toBe('close.bmp');
    expect(t.model.changes.map((c) => [c.el.id, c.attr, c.value, c.origin])).toEqual([
      ['bEqHandle', 'image', 'close.bmp', 'script'],
      ['bEqHandle', 'upToolTip', 'Close', 'script'],
      ['bEqHandle', 'hoverImage', 'close_hover.bmp', 'script'],
    ]);
    expect(t.model.queued.map((q) => q.event)).toEqual(['image_onchange', 'upToolTip_onchange', 'hoverImage_onchange']);
  });

  it('coercion keeps the previous value on invalid input (U-20)', () => {
    const t = makeGraph();
    t.write('sEqEar.visible', 'ture');
    expect(t.read('sEqEar.visible')).toBe(true);
    t.write('sEqEar.visible', 'false');
    expect(t.read('sEqEar.visible')).toBe(false);
    t.write('sEqEar.left', '  12 ');
    expect(t.read('sEqEar.left')).toBe(12);
    t.write('sEqEar.left', 'far');
    expect(t.read('sEqEar.left')).toBe(12);
    t.write('pl.backgroundColor', 'red');
    expect(t.read('pl.backgroundColor')).toBe('#ff0000');
    t.write('pl.backgroundColor', 'reddish');
    expect(t.read('pl.backgroundColor')).toBe('#ff0000');
  });

  it('a read-only attribute drops the write', () => {
    const t = makeGraph();
    t.write('bEqHandle.id', 'hacked');
    t.write('xEqTt.textWidth', 99);
    expect(t.read('bEqHandle.id')).toBe('bEqHandle');
    expect(t.read('xEqTt.textWidth')).toBe(0);
    expect(t.model.changes).toEqual([]);
  });

  it('a handle is not an attribute value', () => {
    const t = makeGraph();
    t.write('xEqTt.value', /** @type {any} */ ({ __h: t.el('sEqEar').handle }));
    expect(t.read('xEqTt.value')).toBe('Open graphic equalizer controls');
  });

  it('a res:// string resolves on assignment to a string attribute (wmploc 7.7)', () => {
    const t = makeGraph();
    t.write('xEqTt.value', 'res://wmploc/RT_STRING/#1810');
    expect(t.read('xEqTt.value')).toBe('Volume');
    t.write('xEqTt.toolTip', 'res://wmploc/RT_STRING/#9');           // unknown id: blank, and ledgered
    expect(t.read('xEqTt.toolTip')).toBe('');
    t.write('xEqTt.fontFace', 'res://wmploc/RT_STRING/#9');          // a usable face, never blank
    expect(t.read('xEqTt.fontFace')).toBe('Arial');
    expect(t.counts()['res://wmploc/RT_STRING/#9 unresolved-res']).toBe(2);
  });

  it('a slider value outside min..max is ignored when a script writes it (spec 6.7)', () => {
    const t = makeGraph();
    t.write('volume.value', 80);
    expect(t.read('volume.value')).toBe(80);
    t.write('volume.value', 101);
    t.write('volume.value', -1);
    expect(t.read('volume.value')).toBe(80);
    t.write('volume.value', 0);
    t.write('balance.value', -100);
    expect(t.read('volume.value')).toBe(0);
    expect(t.read('balance.value')).toBe(-100);
    t.write('eq1.value', 14.5);
    expect(t.read('eq1.value')).toBe(0);
  });

  it('the range rule is the script’s: a binding write of the same attribute is not filtered here', () => {
    const t = makeGraph();
    t.graph.elementObject(t.el('volume')).set('value', 500, 'binding');
    expect(t.read('volume.value')).toBe(500);
  });

  it('a slider with min >= max accepts any value (the range is meaningless until max arrives)', () => {
    const t = makeGraph({ elements: [...headspaceLike(), { kind: 'slider', id: 'seek', attrs: { min: 0, max: 0 } }] });
    t.write('seek.value', 55);
    expect(t.read('seek.value')).toBe(55);
  });

  it('a script write of a geometry attribute stops that element’s tween; other attributes do not', () => {
    const t = makeGraph();
    t.write('sEqEar.visible', false);
    t.write('sEqEar.zIndex', 3);
    expect(t.animCalls).toEqual([]);
    t.write('sEqEar.left', 5);
    t.write('sEqEar.alphaBlend', 100);
    t.graph.elementObject(t.el('sEqEar')).set('top', 9, 'binding');   // not a script write
    expect(t.animCalls).toEqual([['cancel', t.el('sEqEar')], ['cancel', t.el('sEqEar')]]);
  });
});

describe('element animation', () => {
  it('moveto(left, top, ms) is linear, in any case', () => {
    const t = makeGraph();
    t.call('sEqEar.moveto', [0, 0, 120]);
    t.call('sEqEar.moveTo', ['207', '5', '60']);
    expect(t.animCalls).toEqual([
      ['moveTo', t.el('sEqEar'), 0, 0, 120, 'linear'],
      ['moveTo', t.el('sEqEar'), 207, 5, 60, 'linear'],
    ]);
  });

  it('slideTo is the ease-in-out move; moveSizeTo carries the size and the flag', () => {
    const t = makeGraph();
    t.call('sEqEar.slideTo', [10, 20, 300]);
    t.call('sEqEar.moveSizeTo', [1, 2, 30, 40, 500, true]);
    t.call('sEqEar.moveSizeTo', [1, 2, 30, 40, 500, false]);
    t.call('sEqEar.moveSizeTo', [1, 2, 30, 40, 500]);
    expect(t.animCalls).toEqual([
      ['moveTo', t.el('sEqEar'), 10, 20, 300, 'inout'],
      ['moveTo', t.el('sEqEar'), 1, 2, 500, 'inout', 30, 40],
      ['moveTo', t.el('sEqEar'), 1, 2, 500, 'linear', 30, 40],
      ['moveTo', t.el('sEqEar'), 1, 2, 500, 'linear', 30, 40],
    ]);
  });

  it('alphaBlendTo clamps to 0..255 and a negative time is zero', () => {
    const t = makeGraph();
    t.call('sEqEar.alphaBlendTo', [300, 100]);
    t.call('sEqEar.alphaBlendTo', [-5, -1]);
    expect(t.animCalls).toEqual([
      ['alphaBlendTo', t.el('sEqEar'), 255, 100],
      ['alphaBlendTo', t.el('sEqEar'), 0, 0],
    ]);
  });

  it('a call with a missing or bad number does nothing', () => {
    const t = makeGraph();
    t.call('sEqEar.moveTo', [10, 20]);
    t.call('sEqEar.moveTo', ['a', 'b', 'c']);
    t.call('sEqEar.alphaBlendTo', []);
    expect(t.animCalls).toEqual([]);
  });

  it('only classes that have the verb offer it: a playlist has no alphaBlendTo, a buttonelement no moveTo', () => {
    const t = makeGraph();
    expect(t.call('pl.alphaBlendTo', [10, 10])).toBeUndefined();
    expect(t.call('bPlay.moveTo', [1, 2, 3])).toBeUndefined();
    expect(t.animCalls).toEqual([]);
    expect(t.counts()['playlist.alphablendto unknown-member']).toBe(1);
    expect(t.counts()['buttonelement.moveto unknown-member']).toBe(1);
  });
});

describe('element objects', () => {
  it('one object per element, with the element’s own handle, found again by objectOf', () => {
    const t = makeGraph();
    const el = t.el('bEqHandle');
    const a = t.graph.elementObject(el);
    expect(t.graph.elementObject(el)).toBe(a);
    expect(/** @type {any} */ (a).handle).toBe(el.handle);
    expect(t.graph.objectOf(el.handle)).toBe(a);
    expect(a.className).toBe('element.button');
    expect(t.graph.elementObject(t.el('eq')).className).toBe('eq');
    expect(t.graph.elementObject(t.el('vidset')).className).toBe('vidset');
    expect(t.graph.elementObject(t.el('visEffects')).className).toBe('element.effects');
  });

  it('graph handles never collide with element handles', () => {
    const t = makeGraph({ elements: headspaceLike().map((d, i) => ({ ...d, handle: 1000 + i * 7 })) });
    const maxElement = Math.max(...t.model.elements.map((e) => e.handle));
    const g = /** @type {any} */ (t.graph.globals);
    const handles = [g.player, g.theme, g.event, g.mediacenter, g.playerApplication].map((o) => o.handle);
    handles.push(t.read('player.controls'), t.read('player.settings'), t.read('player.currentMedia'), t.read('player.network'));
    for (const h of handles) expect(typeof h === 'number' ? h : /** @type {any} */ (h).__h).toBeGreaterThan(maxElement);
    expect(new Set(handles.map((h) => (typeof h === 'number' ? h : /** @type {any} */ (h).__h))).size).toBe(handles.length);
  });

  it('hostGlobals are the six global handles, each resolving to its global', () => {
    const t = makeGraph();
    const names = ['player', 'theme', 'view', 'event', 'mediacenter', 'playerApplication'];
    expect(Object.keys(t.graph.hostGlobals).sort()).toEqual([...names].sort());
    for (const name of names) {
      const handle = /** @type {any} */ (t.graph.hostGlobals)[name];
      expect(Number.isInteger(handle) && handle > 0, name).toBe(true);
      expect(t.graph.objectOf(handle), name).toBe(/** @type {any} */ (t.graph.globals)[name]);
    }
    expect(new Set(Object.values(t.graph.hostGlobals)).size).toBe(6);
    expect(Object.isFrozen(t.graph.hostGlobals)).toBe(true);
    expect(t.graph.hostGlobals.view).toBe(t.el('view1').handle);
  });

  it('an unknown handle is no object', () => {
    const t = makeGraph();
    expect(t.graph.objectOf(987654)).toBeNull();
    expect(t.graph.objectOf(-1)).toBeNull();
    expect(t.graph.objectOf(NaN)).toBeNull();
  });

  it('elements whose ids are __proto__ and constructor are ordinary ids', () => {
    const t = makeGraph({
      elements: [
        { kind: 'view', id: 'v' },
        { kind: 'button', id: '__proto__', attrs: { left: 5 } },
        { kind: 'button', id: 'constructor', attrs: { left: 6 } },
      ],
    });
    expect(t.read('__proto__.left')).toBe(5);
    expect(t.read('constructor.left')).toBe(6);
    expect(t.graph.changeSource('constructor.left')?.read()).toBe(6);
    expect(t.graph.changeSource('toString.left')).toBeNull();
    t.write('__proto__.left', 50);
    expect(t.read('__proto__.left')).toBe(50);
  });

  it('BUTTONGROUP getButton(i) returns the i-th BUTTONELEMENT', () => {
    const t = makeGraph();
    expect(t.call('playGroup.getButton', [0])).toEqual({ __h: t.el('bPlay').handle });
    expect(t.call('playGroup.getButton', [1])).toEqual({ __h: t.el('bStop').handle });
    expect(t.call('playGroup.getButton', [2])).toBeNull();
    expect(t.call('playGroup.getButton', [-1])).toBeNull();
    expect(t.call('playGroup.getButton', ['x'])).toBeNull();
    expect(t.call('playGroup.getButton', [0])).not.toBeNull();
    expect(t.read('bPlay.mappingColor')).toBe('#ffff00');
  });

  it('PLAYLIST accepts and ignores setColumnResizeMode; visible is live', () => {
    const t = makeGraph();
    expect(t.call('pl.setColumnResizeMode', [0, 'Stretches'])).toBeUndefined();
    expect(t.call('pl.setColumnResizeMode', [1, 'AutoSizeData'])).toBeUndefined();
    expect(t.counts()).toEqual({});                          // an emulated no-op leaves no ledger entry
    t.write('pl.visible', true);
    expect(t.read('pl.visible')).toBe(true);
    expect(t.model.changes.at(-1)?.attr).toBe('visible');
  });

  it('VIDEO is a stub surface: visible is live', () => {
    const t = makeGraph();
    t.write('vid.visible', true);
    expect(t.read('vid.visible')).toBe(true);
  });

  it('writes after dispose are inert and reads return nothing', () => {
    const t = makeGraph();
    t.graph.dispose();
    t.write('bEqHandle.image', 'x.bmp');
    expect(t.read('bEqHandle.image')).toBeUndefined();
    expect(t.model.changes).toEqual([]);
    expect(() => t.graph.dispose()).not.toThrow();
  });
});

describe('script click() queues onclick (G2)', () => {
  it('BUTTONGROUP click(i) queues the i-th BUTTONELEMENT’s onclick, not the group’s', () => {
    const t = makeGraph({ queue: true });
    expect(t.call('playGroup.click', [0])).toBeUndefined();
    expect(t.call('playGroup.click', [1])).toBeUndefined();
    expect(t.queuedEvents).toEqual([['bPlay', 'onclick'], ['bStop', 'onclick']]);
    expect(t.ledger.entries()).toEqual([]);                           // live: nothing ledgered
  });

  it('a bad index runs nothing: out of range, negative, not a number', () => {
    const t = makeGraph({ queue: true });
    for (const i of [2, -1, 99, 'x', null]) t.call('playGroup.click', [i]);
    t.call('playGroup.click', []);
    expect(t.queuedEvents).toEqual([]);
    expect(t.ledger.entries()).toEqual([]);
  });

  it('BUTTONELEMENT click() queues its own onclick, with or without arguments', () => {
    const t = makeGraph({ queue: true });
    t.call('bPlay.click');
    t.call('bStop.click', [7]);
    expect(t.queuedEvents).toEqual([['bPlay', 'onclick'], ['bStop', 'onclick']]);
    expect(t.ledger.entries()).toEqual([]);
  });

  it('reaches the buttons through getButton the way a skin writes it', () => {
    const t = makeGraph({ queue: true });
    const handle = /** @type {{ __h: number }} */ (t.call('playGroup.getButton', [1]));
    t.graph.objectOf(handle.__h)?.call('click', [], { gesture: false });
    expect(t.queuedEvents).toEqual([['bStop', 'onclick']]);
  });

  it('calls queue in call order, one entry per call, and never run anything themselves', () => {
    const t = makeGraph({ queue: true });
    t.call('playGroup.click', [1]);
    t.call('bPlay.click');
    t.call('playGroup.click', [1]);
    expect(t.queuedEvents.map(([id]) => id)).toEqual(['bStop', 'bPlay', 'bStop']);
    expect(t.model.changes).toEqual([]);                              // no handler ran, no attribute moved
  });

  it('is not gesture-gated: a skin may click its own buttons from a timer', () => {
    const t = makeGraph({ queue: true, gesture: false });
    t.call('bPlay.click', [], { gesture: false });
    expect(t.queuedEvents).toEqual([['bPlay', 'onclick']]);
    expect(t.actionLog.denied).toEqual([]);
  });

  it('without a queue, the call is a ledgered stub per class and queues nothing', () => {
    const t = makeGraph();
    expect(t.call('playGroup.click', [0])).toBeUndefined();
    t.call('playGroup.click', [1]);
    t.call('bPlay.click');
    expect(t.counts()['buttongroup.click stub']).toBe(2);
    expect(t.counts()['buttonelement.click stub']).toBe(1);
    expect(t.logs.warn).toEqual([]);
  });

  it('after dispose a click is inert', () => {
    const t = makeGraph({ queue: true });
    const group = t.obj('playGroup');
    const button = t.obj('bPlay');
    t.graph.dispose();
    group.call('click', [0], { gesture: false });
    button.call('click', [], { gesture: false });
    expect(t.queuedEvents).toEqual([]);
  });
});

describe('the EFFECTS element on the host control', () => {
  it('reads the control: preset, title, count; one effect', () => {
    const t = makeGraph();
    t.controls.set(t.el('visEffects'), fakeEffects({ index: 1 }));
    expect(t.read('visEffects.currentPreset')).toBe(1);
    expect(t.read('visEffects.currentPresetTitle')).toBe('Opus');
    expect(t.read('visEffects.currentEffectPresetCount')).toBe(5);
    expect(t.read('visEffects.effectCount')).toBe(1);
    expect(t.read('visEffects.currentEffectType')).toBe(EFFECT_TYPE);
    expect(t.read('visEffects.currentEffectTitle')).toBe(EFFECT_TITLE);
    expect(t.call('visEffects.effectTitle', [0])).toBe(EFFECT_TITLE);
    expect(t.call('visEffects.effectType', [0])).toBe(EFFECT_TYPE);
    expect(t.call('visEffects.effectTitle', [1])).toBe('');
  });

  it('currentPreset = n sets the control and the model, clamped to the count', () => {
    const t = makeGraph();
    const control = fakeEffects();
    t.controls.set(t.el('visEffects'), control);
    t.write('visEffects.currentPreset', 3);
    t.write('visEffects.currentPreset', 99);
    t.write('visEffects.currentPreset', -4);
    t.write('visEffects.currentPreset', 'two');
    expect(control.sets).toEqual([3, 4, 0]);
    expect(t.read('visEffects.currentPreset')).toBe(0);
    expect(t.el('visEffects').get('currentPreset')).toBe(0);
  });

  it('next() and previous() step the control, wrapping, and the nextPreset forms are the same', () => {
    const t = makeGraph();
    const control = fakeEffects({ index: 4 });
    t.controls.set(t.el('visEffects'), control);
    t.call('visEffects.next');
    expect(t.read('visEffects.currentPreset')).toBe(0);
    t.call('visEffects.previous');
    expect(t.read('visEffects.currentPreset')).toBe(4);
    t.call('visEffects.nextPreset');
    t.call('visEffects.previousPreset');
    expect(control.steps).toEqual([1, -1, 1, -1]);
    t.call('visEffects.nextEffect');
    t.call('visEffects.previousEffect');
    t.call('visEffects.settings');
    expect(control.steps).toHaveLength(4);
  });

  it('currentEffectType = x is accepted and changes nothing: one effect', () => {
    const t = makeGraph();
    t.write('visEffects.currentEffectType', 'someone-elses-effect');
    expect(t.read('visEffects.currentEffectType')).toBe(EFFECT_TYPE);
  });

  it('Headspace’s Init and OnClose against the host: mediacenter in, preset set, mediacenter out', () => {
    const t = makeGraph({ mediacenterMap: new Map([['effectPreset', '1']]) });
    const control = fakeEffects();
    t.controls.set(t.el('visEffects'), control);
    // Init
    t.write('visEffects.currentEffectType', t.read('mediacenter.effectType'));
    t.write('visEffects.currentPreset', t.read('mediacenter.effectPreset'));
    expect(t.read('visEffects.currentPresetTitle')).toBe('Opus');
    // the user picks another, then OnClose
    t.call('visEffects.next');
    t.write('mediacenter.effectType', t.read('visEffects.currentEffectType'));
    t.write('mediacenter.effectPreset', t.read('visEffects.currentPreset'));
    expect(t.store.peek('mediacenter').get('effectPreset')).toBe('2');
    expect(t.store.peek('mediacenter').get('effectType')).toBe(EFFECT_TYPE);
  });

  it('without a control (no slot yet) the object falls back to the element’s own values', () => {
    const t = makeGraph();
    expect(t.read('visEffects.currentPresetTitle')).toBe('');
    expect(t.read('visEffects.currentEffectPresetCount')).toBe(0);
    t.write('visEffects.currentPreset', 2);
    expect(t.read('visEffects.currentPreset')).toBe(2);
    expect(() => t.call('visEffects.next')).not.toThrow();
  });

  it('visible and fullScreen: visible is live, fullScreen is a stub that reads what was written', () => {
    const t = makeGraph();
    t.write('visEffects.visible', false);
    expect(t.read('visEffects.visible')).toBe(false);
    expect(t.read('visEffects.fullScreen')).toBe(false);
    t.write('visEffects.fullScreen', true);
    expect(t.read('visEffects.fullScreen')).toBe(true);
    expect(t.counts()['effects.fullScreen stub']).toBe(3);
  });
});

describe('equalizerSettings (eq)', () => {
  it('gainLevelN reads and writes the host DSP, any case; the port clamps and persists', () => {
    const t = makeGraph();
    expect(t.read('eq.gainLevel1')).toBe(0);
    t.write('eq.gainLevel3', 5);
    t.write('eq.GAINLEVEL10', -20);
    expect(t.dsp.eq.gains()[2]).toBe(5);
    expect(t.dsp.eq.gains()[9]).toBe(-14);                   // +-14 dB (D11)
    expect(t.read('eq.gainLevel3')).toBe(5);
    expect(t.read('eq.gainlevel10')).toBe(-14);
    expect(t.dsp.sent.eq).toHaveLength(2);
    t.write('eq.gainLevel3', 'loud');
    expect(t.read('eq.gainLevel3')).toBe(5);
    t.write('eq.gainLevel3', '7.5');
    expect(t.read('eq.gainLevel3')).toBe(7.5);
  });

  it('there are exactly ten bands, 1 to 10', () => {
    const t = makeGraph();
    expect(t.read('eq.bands')).toBe(10);
    expect(t.read('eq.gainLevel11')).toBeUndefined();
    expect(t.read('eq.gainLevel0')).toBeUndefined();
    expect(t.counts()['equalizerSettings.gainlevel11 unknown-member']).toBe(1);
  });

  it('gainLevels(i) is the 1-based read of a band; out of range is 0', () => {
    const t = makeGraph();
    t.write('eq.gainLevel4', 3);
    expect(t.call('eq.gainLevels', [4])).toBe(3);
    expect(t.call('eq.gainLevels', ['4'])).toBe(3);
    expect(t.call('eq.gainLevels', [0])).toBe(0);
    expect(t.call('eq.gainLevels', [11])).toBe(0);
    expect(t.call('eq.gainLevels', [])).toBe(0);
  });

  it('reset() zeroes every band', () => {
    const t = makeGraph();
    t.write('eq.gainLevel1', 4);
    t.write('eq.gainLevel9', -4);
    t.call('eq.reset');
    expect(t.dsp.eq.gains().every((g) => g === 0)).toBe(true);
  });

  it('bypass is host state and defaults to false: the EQ is live', () => {
    const t = makeGraph();
    expect(t.read('eq.bypass')).toBe(false);
    t.write('eq.bypass', 'true');
    expect(t.dsp.eq.bypass()).toBe(true);
    expect(t.read('eq.bypass')).toBe(true);
    t.write('eq.bypass', 'maybe');
    expect(t.read('eq.bypass')).toBe(true);
  });

  it('enableSplineTension is accepted with no DSP effect; the preset API names one preset', () => {
    const t = makeGraph();
    expect(t.read('eq.enableSplineTension')).toBe(true);
    t.write('eq.enableSplineTension', false);
    expect(t.read('eq.enableSplineTension')).toBe(false);
    expect(t.dsp.sent.eq).toEqual([]);
    expect([t.read('eq.currentPreset'), t.read('eq.presetCount'), t.read('eq.currentPresetTitle')]).toEqual([0, 1, 'Custom']);
    expect(t.call('eq.presetTitle', [0])).toBe('Custom');
  });

  it('the SRS and normalisation members are stubs with inert values', () => {
    const t = makeGraph();
    expect(t.read('eq.normalization')).toBe(false);
    expect(t.read('eq.truBassLevel')).toBe(50);
    expect(t.read('eq.currentSpeakerName')).toBe('Normal Speakers');
    expect(t.counts()['equalizerSettings.truBassLevel stub']).toBe(1);
  });
});

describe('videoSettings (vidset)', () => {
  it('holds brightness, contrast, hue and saturation locally, clamped to -127..127', () => {
    const t = makeGraph();
    expect([t.read('vidset.brightness'), t.read('vidset.contrast'), t.read('vidset.hue'), t.read('vidset.saturation')]).toEqual([0, 0, 0, 0]);
    t.write('vidset.contrast', 50);
    t.write('vidset.hue', 500);
    t.write('vidset.saturation', -500);
    t.write('vidset.brightness', 'dim');
    expect([t.read('vidset.contrast'), t.read('vidset.hue'), t.read('vidset.saturation'), t.read('vidset.brightness')]).toEqual([50, 127, -127, 0]);
    t.call('vidset.reset');
    expect([t.read('vidset.contrast'), t.read('vidset.hue'), t.read('vidset.saturation')]).toEqual([0, 0, 0]);
  });

  it('changes fire the local change source, once per change', () => {
    const t = makeGraph();
    let heard = 0;
    t.graph.changeSource('vidset.contrast')?.subscribe(() => { heard++; });
    t.write('vidset.contrast', 10);
    t.write('vidset.contrast', 10);
    t.call('vidset.reset');
    expect(heard).toBe(2);
  });
});
