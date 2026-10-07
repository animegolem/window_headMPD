// @ts-check
// The picker (WAVES W3.5 acceptance 1; E §5.11 `pick`; E D2 hit table, picker roles). Models are built
// from synthetic raw trees through `buildTheme`; pixels are RgbaImage literals keyed by W1.3's
// `keyImage` through a synchronous in-test image service, so nothing here reads art or waits for a
// decode. One group of cases per row of the D2 hit table, one per role, then the walk's own rules.
import { describe, expect, it } from 'vitest';
import { pick } from '../../../src/engine/input/picker.js';
import {
  FAITHFUL, MAGENTA, N, ORACLE_COMPAT, RED, WHITE, dotted, el, image, slotsOf, solidImage, syncImages, viewOf,
} from '../shape/support.js';

/** @typedef {import('../../../src/engine/contracts').EngineOptions} EngineOptions */

/**
 * pick at a point, or null; `at` is where the view's top-left pixel is.
 * @param {import('../../../src/engine/contracts').ViewModel} view @param {import('../shape/support.js').SyncImages} images
 * @param {number} x @param {number} y @param {{ opts?: EngineOptions, slots?: ReturnType<typeof slotsOf> }} [o]
 */
const at = (view, images, x, y, o = {}) => pick(view, images, o.slots ?? slotsOf(), x, y, o.opts ?? FAITHFUL);

/** `id role` of a pick, for readable expectations. @param {ReturnType<typeof pick>} p */
const who = (p) => (p ? `${p.el.id} ${p.role}` : null);

describe('hit table: opaque and partly opaque pixels', () => {
  const images = syncImages({
    'b.bmp': solidImage(10, 10, 0x336699),
    'a.png': image(10, 10, (x) => (x < 5 ? [10, 20, 30, 128] : [10, 20, 30, 0])),
  });

  it('an opaque BUTTON pixel hits, a point beside it picks nothing, and local is relative to the element', () => {
    const v = viewOf([N('button', { id: 'btn', left: 5, top: 6, image: 'b.bmp' })], { images });
    expect(at(v, images, 7, 8)).toMatchObject({ role: 'control', part: null, local: { x: 2, y: 2 } });
    expect(at(v, images, 7, 8)?.el.id).toBe('btn');
    expect(at(v, images, 4, 8)).toBeNull();
    expect(at(v, images, 15, 8)).toBeNull(); // the button spans x 5..14
  });

  it('a partly opaque pixel hits and a fully transparent one does not (alpha counts, U-27)', () => {
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'a.png' })], { images });
    expect(who(at(v, images, 2, 3))).toBe('btn control');
    expect(at(v, images, 7, 3)).toBeNull();
  });

  it('keeps the fraction of the point in local, and uses the pixel under it', () => {
    const v = viewOf([N('button', { id: 'btn', left: 5, top: 5, image: 'b.bmp' })], { images });
    const p = at(v, images, 7.75, 9.5);
    expect(p?.local).toEqual({ x: 2.75, y: 4.5 });
    expect(at(v, images, 14.99, 5)?.el.id).toBe('btn'); // pixel 14 is the last one
    expect(at(v, images, 15, 5)).toBeNull();
  });
});

describe('hit table: keyed pixels on BUTTON, BUTTONGROUP owned pixels and slider thumbs', () => {
  const half = (left, right) => image(10, 10, (x) => (x < 5 ? left : right));

  it('BUTTON: a keyed pixel takes the click when buttonKeyedPixelsHit says so, and passes it when not', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('button', { id: 'btn', left: 5, top: 5, image: 'k.bmp', transparencyColor: '#FF00FF' })], { images });
    expect(who(at(v, images, 6, 6, { opts: FAITHFUL }))).toBe('btn control');
    expect(at(v, images, 6, 6, { opts: ORACLE_COMPAT })).toBeNull();
    // the opaque half hits under both
    expect(who(at(v, images, 12, 6, { opts: FAITHFUL }))).toBe('btn control');
    expect(who(at(v, images, 12, 6, { opts: ORACLE_COMPAT }))).toBe('btn control');
  });

  it('BUTTON: a key the skin did not declare keys nothing, so magenta is just a colour (per declaration)', () => {
    const images = syncImages({ 'k.bmp': half(MAGENTA, 0x336699) });
    const v = viewOf([N('button', { id: 'btn', left: 5, top: 5, image: 'k.bmp' })], { images });
    expect(who(at(v, images, 6, 6, { opts: ORACLE_COMPAT }))).toBe('btn control');
  });

  it('BUTTONGROUP: an owned keyed pixel is a hit only in faithful, and names the element and its index', () => {
    const images = syncImages({
      'map.bmp': half(0xff0033, 0x00ff00), 'g.bmp': half(MAGENTA, 0x336699),
    });
    const v = viewOf([
      N('buttongroup', { id: 'g', left: 5, top: 5, mappingImage: 'map.bmp', image: 'g.bmp', transparencyColor: '#FF00FF' }, [
        N('buttonelement', { id: 'e1', mappingColor: '#FF0033' }), N('buttonelement', { id: 'e2', mappingColor: '#00FF00' }),
      ]),
    ], { images });
    const keyed = at(v, images, 6, 6, { opts: FAITHFUL });
    expect(keyed).toMatchObject({ role: 'control', part: 0, local: { x: 1, y: 1 } });
    expect(keyed?.el.id).toBe('e1');
    expect(at(v, images, 6, 6, { opts: ORACLE_COMPAT })).toBeNull();
    for (const opts of [FAITHFUL, ORACLE_COMPAT]) {
      const p = at(v, images, 12, 6, { opts });
      expect([p?.el.id, p?.part, p?.role]).toEqual(['e2', 1, 'control']);
    }
  });

  it('slider: the thumb\'s keyed pixel hits in faithful only, and the track\'s keyed pixel never does', () => {
    const track = image(20, 10, (x) => (x < 6 ? [0, 0, 0, 0] : x === 15 ? MAGENTA : 0x445566));
    const images = syncImages({ 'track.bmp': track, 'thumb.bmp': half(MAGENTA, 0x778899) });
    const v = viewOf([
      N('slider', { id: 's', left: 5, top: 5, backgroundImage: 'track.bmp', thumbImage: 'thumb.bmp', transparencyColor: '#FF00FF', min: 0, max: 100, value: 0 }),
    ], { images, width: 40, height: 20 });
    // value 0: the thumb (10 wide) sits at the left edge, x 5..14; its left half (x 5..9) is keyed
    expect(who(at(v, images, 6, 8, { opts: FAITHFUL }))).toBe('s control');
    expect(at(v, images, 6, 8, { opts: ORACLE_COMPAT })).toBeNull();
    expect(who(at(v, images, 12, 8, { opts: ORACLE_COMPAT }))).toBe('s control'); // the thumb's opaque half
    // x 20 is the track's keyed pixel (index 15): never a hit, in either configuration
    expect(at(v, images, 20, 8, { opts: FAITHFUL })).toBeNull();
    expect(at(v, images, 20, 8, { opts: ORACLE_COMPAT })).toBeNull();
    expect(who(at(v, images, 18, 8, { opts: FAITHFUL }))).toBe('s control'); // the opaque track beyond the thumb
  });
});

describe('hit table: VIEW and SUBVIEW backgrounds', () => {
  it('a keyed background pixel passes the click to what is below, in both configurations', () => {
    const images = syncImages({ 'sv.bmp': image(10, 10, (x) => (x < 5 ? MAGENTA : 0x336699)), 'bg.bmp': solidImage(40, 40, 0x202020) });
    const v = viewOf([N('subview', { id: 'sv', left: 5, top: 5, backgroundImage: 'sv.bmp', transparencyColor: '#FF00FF' })], { images, view: { backgroundImage: 'bg.bmp' } });
    for (const opts of [FAITHFUL, ORACLE_COMPAT]) {
      expect(who(at(v, images, 6, 6, { opts }))).toBe('v chrome'); // the VIEW's own background
      expect(who(at(v, images, 12, 6, { opts }))).toBe('sv chrome');
    }
  });

  it('with nothing below the keyed pixel, the point picks nothing', () => {
    const images = syncImages({ 'sv.bmp': image(10, 10, (x) => (x < 5 ? MAGENTA : 0x336699)) });
    const v = viewOf([N('subview', { id: 'sv', left: 5, top: 5, backgroundImage: 'sv.bmp', transparencyColor: '#FF00FF' })], { images });
    expect(at(v, images, 6, 6)).toBeNull();
  });

  it('a backgroundColor fills the box and takes the hit; the VIEW\'s default white does too', () => {
    const images = syncImages({});
    const v = viewOf([N('subview', { id: 'sv', left: 5, top: 5, width: 10, height: 10, backgroundColor: '#336699' })], { images });
    expect(who(at(v, images, 6, 6))).toBe('sv chrome');
    expect(at(v, images, 20, 20)).toBeNull();
    const white = viewOf([], { images, view: { backgroundColor: '#FFFFFF' } });
    expect(who(at(white, images, 39, 39))).toBe('v chrome');
  });

  it('a mouse handler on a SUBVIEW makes its background a control', () => {
    const images = syncImages({});
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 10, height: 10, backgroundColor: '#336699', onClick: 'x();' })], { images });
    expect(who(at(v, images, 3, 3))).toBe('sv control');
  });
});

describe('hit table: clipping', () => {
  it('a SUBVIEW\'s clippingColor pixels are not hit, and clip its children too', () => {
    const images = syncImages({
      'sv.bmp': image(10, 10, (x) => (x < 5 ? 0x336699 : RED)), 'b.bmp': solidImage(10, 4, 0x888888), 'bg.bmp': solidImage(40, 40, 0x202020),
    });
    const v = viewOf([
      N('subview', { id: 'sv', left: 5, top: 5, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', zIndex: 1 })]),
    ], { images, view: { backgroundImage: 'bg.bmp' } });
    expect(who(at(v, images, 6, 6))).toBe('btn control');
    // the red half: the SUBVIEW's background is clipped away and so is the button inside it
    expect(who(at(v, images, 12, 6))).toBe('v chrome');
    expect(who(at(v, images, 12, 12))).toBe('v chrome');
  });

  it('a clippingColor the skin did not declare clips nothing, whatever colour pixel (0,0) is (the default is auto)', () => {
    const images = syncImages({ 'sv.bmp': solidImage(10, 10, RED) });
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp' })], { images });
    expect(who(at(v, images, 5, 5))).toBe('sv chrome');
  });

  it('a clippingImage names the region: its clippingColor pixels are outside it, even on a BUTTON', () => {
    const images = syncImages({
      'b.bmp': solidImage(10, 10, 0x336699), 'clip.bmp': image(10, 10, (x) => (x < 5 ? 0x000000 : MAGENTA)),
    });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', clippingImage: 'clip.bmp', clippingColor: '#FF00FF' })], { images });
    expect(who(at(v, images, 2, 5))).toBe('btn control');
    expect(at(v, images, 7, 5)).toBeNull();
  });

  it('a clippingImage with no clippingColor means auto: the colour of its pixel (0,0)', () => {
    const images = syncImages({
      'b.bmp': solidImage(10, 10, 0x336699), 'clip.bmp': image(10, 10, (x) => (x < 5 ? 0x000000 : WHITE)),
    });
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', clippingImage: 'clip.bmp' })], { images });
    expect(at(v, images, 2, 5)).toBeNull(); // black = pixel (0,0) = the clipped colour
    expect(who(at(v, images, 7, 5))).toBe('btn control');
  });

  it('a SUBVIEW clip mask only reaches as far as its image; beyond it the subtree is hidden', () => {
    const images = syncImages({ 'sv.bmp': solidImage(10, 10, 0x336699), 'b.bmp': solidImage(4, 4, 0x888888) });
    const v = viewOf([
      N('subview', { id: 'sv', left: 0, top: 0, width: 20, height: 10, backgroundImage: 'sv.bmp', clippingColor: '#FF0000' }, [
        N('button', { id: 'in', left: 2, top: 2, image: 'b.bmp', zIndex: 1 }), N('button', { id: 'out', left: 12, top: 2, image: 'b.bmp', zIndex: 1 }),
      ]),
    ], { images });
    expect(who(at(v, images, 3, 3))).toBe('in control');
    expect(at(v, images, 13, 3)).toBeNull();
  });
});

describe('hit table: BUTTONGROUP unowned pixels', () => {
  const images = syncImages({
    'map.bmp': image(10, 10, (x) => (x < 5 ? 0xff0033 : 0x123456)), 'g.bmp': solidImage(10, 10, 0x336699), 'bg.bmp': solidImage(40, 40, 0x202020),
  });
  /** @param {string} showBackground */
  const skin = (showBackground) => viewOf([
    N('buttongroup', { id: 'g', left: 5, top: 5, mappingImage: 'map.bmp', image: 'g.bmp', ...(showBackground ? { showBackground } : {}) }, [N('buttonelement', { id: 'e1', mappingColor: '#FF0033' })]),
  ], { images, view: { backgroundImage: 'bg.bmp' } });

  it.each(['true', 'false', ''])('an unowned pixel is never hit, with showBackground="%s" in either configuration', (showBackground) => {
    const v = skin(showBackground);
    for (const opts of [FAITHFUL, ORACLE_COMPAT]) {
      expect(who(at(v, images, 6, 6, { opts }))).toBe('e1 control');
      expect(who(at(v, images, 12, 6, { opts }))).toBe('v chrome'); // falls to the VIEW's background
    }
  });

  it('with nothing below it, an unowned pixel picks nothing', () => {
    const v = viewOf([
      N('buttongroup', { id: 'g', left: 0, top: 0, mappingImage: 'map.bmp', image: 'g.bmp', showBackground: 'true' }, [N('buttonelement', { id: 'e1', mappingColor: '#FF0033' })]),
    ], { images });
    expect(at(v, images, 8, 5)).toBeNull();
  });

  it('two elements that share a mappingColor: the first in the file owns the pixels', () => {
    const shared = syncImages({ 'map.bmp': solidImage(10, 10, 0xff0033), 'g.bmp': solidImage(10, 10, 0x336699) });
    const v = viewOf([
      N('buttongroup', { id: 'g', mappingImage: 'map.bmp', image: 'g.bmp' }, [N('buttonelement', { id: 'first', mappingColor: '#FF0033' }), N('buttonelement', { id: 'second', mappingColor: '#ff0033' })]),
    ], { images: shared });
    const p = at(v, shared, 5, 5);
    expect([p?.el.id, p?.part]).toEqual(['first', 0]);
  });

  it('ownership is an exact RGB match: a near colour owns nothing', () => {
    const near = syncImages({ 'map.bmp': solidImage(10, 10, 0xff0034), 'g.bmp': solidImage(10, 10, 0x336699) });
    const v = viewOf([N('buttongroup', { id: 'g', mappingImage: 'map.bmp', image: 'g.bmp' }, [N('buttonelement', { id: 'e1', mappingColor: '#FF0033' })])], { images: near });
    expect(at(v, near, 5, 5)).toBeNull();
  });
});

describe('hit table: sized things with no art', () => {
  it('a BUTTON with no image but a size is a hot-spot over its box; with no size it is nothing', () => {
    const images = syncImages({});
    const v = viewOf([
      N('button', { id: 'hot', left: 2, top: 2, width: 8, height: 6 }), N('button', { id: 'none', left: 20, top: 20 }),
    ], { images });
    expect(who(at(v, images, 2, 2))).toBe('hot control');
    expect(who(at(v, images, 9, 7))).toBe('hot control');
    expect(at(v, images, 10, 7)).toBeNull();
    expect(at(v, images, 20, 20)).toBeNull();
  });

  it('a BUTTON whose image is missing from the archive is still a hot-spot, as an empty button', () => {
    const images = syncImages({});
    const v = viewOf([N('button', { id: 'gone', left: 2, top: 2, width: 8, height: 6, image: 'missing.bmp' })], { images });
    expect(who(at(v, images, 4, 4))).toBe('gone control');
  });

  it('a TEXT takes its box: chrome without a handler, control with one, blocked when disabled', () => {
    const images = syncImages({});
    const v = viewOf([
      N('text', { id: 'plain', left: 0, top: 0, width: 10, height: 5, value: 'hi' }),
      N('text', { id: 'link', left: 0, top: 10, width: 10, height: 5, value: 'go', onClick: 'x();' }),
      N('text', { id: 'dead', left: 0, top: 20, width: 10, height: 5, value: 'no', onClick: 'x();', enabled: 'false' }),
      N('text', { id: 'idle', left: 0, top: 30, width: 10, height: 5, value: 'quiet', enabled: 'false' }),
    ], { images });
    expect(who(at(v, images, 3, 2))).toBe('plain chrome');
    expect(who(at(v, images, 3, 12))).toBe('link control');
    expect(who(at(v, images, 3, 22))).toBe('dead blocked');
    expect(who(at(v, images, 3, 32))).toBe('idle chrome'); // not interactive, so disabling it blocks nothing
    expect(at(v, images, 11, 2)).toBeNull();
  });

  it('a TEXT with no height is one line of its font, and its measured width stands in for a missing one', () => {
    const images = syncImages({});
    const v = viewOf([N('text', { id: 't', left: 0, top: 0, width: 20, value: 'hi', fontSize: 7 })], { images });
    // 7 pt is 9 px; one line at normal line height is about 11 px
    expect(who(at(v, images, 5, 10))).toBe('t chrome');
    expect(at(v, images, 5, 12)).toBeNull();
    const measured = viewOf([N('text', { id: 't', left: 0, top: 0, height: 8, value: 'hi' })], { images });
    expect(at(measured, images, 5, 3)).toBeNull(); // no width and no measurement yet
    el(measured, 't').set('textWidth', 12, 'host');
    expect(who(at(measured, images, 5, 3))).toBe('t chrome');
  });

  it('a TEXT can be clicked even with nothing to show', () => {
    const images = syncImages({});
    const v = viewOf([N('text', { id: 't', left: 0, top: 0, width: 10, height: 5, onClick: 'x();' })], { images });
    expect(who(at(v, images, 3, 2))).toBe('t control');
  });
});

describe('hit table: CUSTOMSLIDER', () => {
  it('only the grey pixels of positionImage take the hit; any other colour is dead', () => {
    const images = syncImages({ 'pos.bmp': image(10, 10, (x) => (x < 5 ? x * 50 * 0x010101 : MAGENTA)) });
    const v = viewOf([N('customslider', { id: 'dial', left: 5, top: 5, positionImage: 'pos.bmp', image: 'strip.bmp' })], { images });
    expect(who(at(v, images, 6, 6))).toBe('dial control'); // black is grey too
    expect(who(at(v, images, 9, 6))).toBe('dial control');
    expect(at(v, images, 11, 6)).toBeNull(); // magenta
    expect(at(v, images, 3, 6)).toBeNull(); // outside the map
  });
});

describe('roles', () => {
  const images = syncImages({ 'b.bmp': solidImage(10, 10, 0x336699), 'sv.bmp': solidImage(10, 10, 0x224466) });

  it('a disabled BUTTON is blocked, not missing: drawn art swallows the press', () => {
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', enabled: 'false' })], { images });
    expect(who(at(v, images, 5, 5))).toBe('btn blocked');
  });

  it('a BUTTONELEMENT or its group being disabled blocks that element only', () => {
    const map = syncImages({ 'map.bmp': image(10, 10, (x) => (x < 5 ? 0xff0033 : 0x00ff00)), 'g.bmp': solidImage(10, 10, 0x336699) });
    const v = viewOf([
      N('buttongroup', { id: 'g', mappingImage: 'map.bmp', image: 'g.bmp' }, [
        N('buttonelement', { id: 'e1', mappingColor: '#FF0033', enabled: 'false' }), N('buttonelement', { id: 'e2', mappingColor: '#00FF00' }),
      ]),
    ], { images: map });
    expect(who(at(v, map, 2, 5))).toBe('e1 blocked');
    expect(who(at(v, map, 8, 5))).toBe('e2 control');
    el(v, 'g').set('enabled', false, 'script');
    expect(who(at(v, map, 8, 5))).toBe('e2 blocked');
  });

  it('a slider is a control only with a thumb or a mouse handler; without either its pixels are chrome', () => {
    const v = viewOf([
      N('slider', { id: 'plain', left: 0, top: 0, backgroundImage: 'b.bmp' }),
      N('slider', { id: 'thumbed', left: 0, top: 12, backgroundImage: 'b.bmp', thumbImage: 'b.bmp' }),
      N('progressbar', { id: 'bar', left: 12, top: 0, backgroundImage: 'b.bmp', onMouseDown: 'x();' }),
      N('slider', { id: 'off', left: 12, top: 12, backgroundImage: 'b.bmp', thumbImage: 'b.bmp', enabled: 'false' }),
    ], { images, width: 30, height: 30 });
    expect(who(at(v, images, 3, 3))).toBe('plain chrome');
    expect(who(at(v, images, 3, 15))).toBe('thumbed control');
    expect(who(at(v, images, 15, 3))).toBe('bar control');
    expect(who(at(v, images, 15, 15))).toBe('off blocked');
  });

  it('an EFFECTS slot is `effects` over its box, over what the host reports when it reports, and `blocked` when disabled', () => {
    const v = viewOf([N('effects', { id: 'fx', left: 2, top: 2, width: 20, height: 20 })], { images });
    expect(who(at(v, images, 10, 10))).toBe('fx effects');
    expect(at(v, images, 25, 10)).toBeNull();
    const slots = slotsOf({ fx: [{ x: 4, y: 4, w: 6, h: 6 }] });
    expect(who(at(v, images, 5, 5, { slots }))).toBe('fx effects');
    expect(at(v, images, 15, 15, { slots })).toBeNull();
    el(v, 'fx').set('enabled', false, 'script');
    expect(who(at(v, images, 10, 10))).toBe('fx blocked');
  });

  it('a hidden EFFECTS slot or one under a hidden SUBVIEW takes nothing', () => {
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, width: 30, height: 30 }, [N('effects', { id: 'fx', width: 20, height: 20, visible: 'false' })])], { images });
    expect(at(v, images, 10, 10)).toBeNull();
  });

  it('a windowed PLAYLIST is `widget` over its reported rects, above every windowless control', () => {
    const v = viewOf([
      N('playlist', { id: 'pl', left: 0, top: 0, width: 20, height: 20 }),
      N('button', { id: 'over', left: 0, top: 0, image: 'b.bmp', zIndex: 9 }),
    ], { images });
    const slots = slotsOf({ pl: [{ x: 0, y: 0, w: 20, h: 20 }] });
    const p = at(v, images, 5, 5, { slots });
    expect(who(p)).toBe('pl widget');
    expect(p?.local).toEqual({ x: 5, y: 5 });
    expect(who(at(v, images, 5, 5))).toBe('over control'); // no slot, no widget
    el(v, 'pl').set('visible', false, 'script');
    expect(who(at(v, images, 5, 5, { slots }))).toBe('over control');
  });

  it('a PLAYLIST under a hidden ancestor is not there, and an open combo list reaches past the box', () => {
    const v = viewOf([
      N('subview', { id: 'hidden', width: 30, height: 30, visible: 'false' }, [N('playlist', { id: 'pl', width: 20, height: 20 })]),
      N('playlist', { id: 'pl2', left: 0, top: 0, width: 10, height: 10 }),
    ], { images });
    const slots = slotsOf({ pl: [{ x: 0, y: 0, w: 20, h: 20 }], pl2: [{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 12 }] });
    expect(who(at(v, images, 15, 15, { slots }))).toBeNull();
    expect(who(at(v, images, 5, 15, { slots }))).toBe('pl2 widget'); // the extra rect
  });

  it('a pixel only a SUBVIEW background paints is chrome', () => {
    const v = viewOf([N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp' })], { images });
    expect(who(at(v, images, 5, 5))).toBe('sv chrome');
  });
});

describe('the walk', () => {
  const images = syncImages({ 'b.bmp': solidImage(10, 10, 0x336699), 'sv.bmp': solidImage(10, 10, 0x224466) });

  it('passThrough lets the press fall to what is under it', () => {
    const v = viewOf([
      N('button', { id: 'under', left: 0, top: 0, image: 'b.bmp' }),
      N('text', { id: 'label', left: 0, top: 0, width: 10, height: 10, value: 'x', passThrough: 'true', zIndex: 5 }),
    ], { images });
    expect(who(at(v, images, 3, 3))).toBe('under control');
    el(v, 'label').set('passThrough', false, 'script');
    expect(who(at(v, images, 3, 3))).toBe('label chrome');
  });

  it('a passThrough SUBVIEW gives up its own pixels but its SUBVIEW and control children still hit (U-7)', () => {
    const v = viewOf([
      N('subview', { id: 'pass', left: 0, top: 0, backgroundImage: 'sv.bmp', passThrough: 'true' }, [
        N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', zIndex: 1, width: 4, height: 4 }),
        N('subview', { id: 'kid', left: 5, top: 5, backgroundImage: 'sv.bmp', width: 5, height: 5, zIndex: 1 }),
      ]),
    ], { images });
    expect(who(at(v, images, 2, 2))).toBe('btn control');
    expect(who(at(v, images, 7, 7))).toBe('kid chrome');
    expect(at(v, images, 7, 2)).toBeNull(); // the SUBVIEW's own background: passed through
  });

  it('visible=false skips the element and its whole subtree', () => {
    const v = viewOf([
      N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp', visible: 'false' }, [N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp', zIndex: 1 })]),
    ], { images });
    expect(at(v, images, 5, 5)).toBeNull();
    el(v, 'sv').set('visible', true, 'script');
    expect(who(at(v, images, 5, 5))).toBe('btn control');
  });

  it('the higher z wins, and equal z goes to the later tag (U-1)', () => {
    const v = viewOf([
      N('button', { id: 'low', left: 0, top: 0, image: 'b.bmp', zIndex: 1 }),
      N('button', { id: 'high', left: 0, top: 0, image: 'b.bmp', zIndex: 2 }),
      N('button', { id: 'tieA', left: 20, top: 0, image: 'b.bmp', zIndex: 3 }),
      N('button', { id: 'tieB', left: 20, top: 0, image: 'b.bmp', zIndex: 3 }),
    ], { images });
    expect(who(at(v, images, 5, 5))).toBe('high control');
    expect(who(at(v, images, 25, 5))).toBe('tieB control');
    el(v, 'low').set('zIndex', 7, 'script'); // a runtime z write re-sorts
    expect(who(at(v, images, 5, 5))).toBe('low control');
  });

  it('a negative-z child sits under its parent\'s background: hidden by opaque pixels, reachable through a keyed hole', () => {
    const holey = syncImages({ 'sv.bmp': image(10, 10, (x) => (x < 5 ? MAGENTA : 0x224466)), 'b.bmp': solidImage(10, 10, 0x336699) });
    const v = viewOf([
      N('subview', { id: 'sv', left: 0, top: 0, backgroundImage: 'sv.bmp', transparencyColor: '#FF00FF' }, [N('button', { id: 'under', left: 0, top: 0, image: 'b.bmp', zIndex: -1 })]),
    ], { images: holey });
    expect(who(at(v, holey, 7, 5))).toBe('sv chrome'); // opaque background over the button
    expect(who(at(v, holey, 2, 5))).toBe('under control'); // through the hole
  });

  it('a sized SUBVIEW clips its subtree to its box; a size-less one does not; the switch turns it off', () => {
    const kid = N('button', { id: 'btn', left: 8, top: 0, image: 'b.bmp', zIndex: 1 });
    const sized = viewOf([N('subview', { id: 'sv', left: 5, top: 5, width: 10, height: 10 }, [kid])], { images });
    expect(who(at(sized, images, 14, 6))).toBe('btn control'); // abs x 13..22, box ends at 14
    expect(at(sized, images, 15, 6)).toBeNull();
    expect(who(at(sized, images, 14, 6, { opts: { ...FAITHFUL, subviewClip: false } }))).toBe('btn control');
    expect(who(at(sized, images, 16, 6, { opts: { ...FAITHFUL, subviewClip: false } }))).toBe('btn control');
    const sizeless = viewOf([N('subview', { id: 'sv', left: 5, top: 5 }, [kid])], { images });
    expect(who(at(sizeless, images, 16, 6))).toBe('btn control');
  });

  it('nested SUBVIEWs add their offsets, and every level of box clipping applies', () => {
    const v = viewOf([
      N('subview', { id: 'outer', left: 10, top: 10, width: 15, height: 15 }, [
        N('subview', { id: 'inner', left: 5, top: 5, width: 20, height: 20 }, [N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })]),
      ]),
    ], { images });
    expect(who(at(v, images, 16, 16))).toBe('btn control'); // 10 + 5 + 1
    expect(who(at(v, images, 24, 24))).toBe('btn control');
    expect(at(v, images, 25, 24)).toBeNull(); // inner is wide enough, outer's box ends at 24
  });

  it('a point outside the VIEW, or not a number, picks nothing', () => {
    const v = viewOf([N('button', { id: 'btn', left: 0, top: 0, image: 'b.bmp' })], { images });
    for (const [x, y] of [[-1, 5], [5, -0.5], [40, 5], [5, 40], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY]]) expect(at(v, images, x, y)).toBeNull();
  });

  it('a tiled BUTTON fills its box, and an untiled one covers only its image', () => {
    const small = syncImages({ 's.bmp': solidImage(5, 10, 0x336699) });
    const v = viewOf([
      N('button', { id: 'tiled', left: 0, top: 0, width: 20, height: 10, image: 's.bmp', tiled: 'true' }),
      N('button', { id: 'once', left: 0, top: 20, width: 20, height: 10, image: 's.bmp' }),
    ], { images: small });
    expect(who(at(v, small, 17, 5))).toBe('tiled control');
    expect(who(at(v, small, 3, 25))).toBe('once control');
    expect(at(v, small, 8, 25)).toBeNull();
  });

  it('the thumb\'s edge is rounded like the oracle\'s: half a pixel of travel goes up', () => {
    const si = syncImages({ 'thumb.bmp': solidImage(5, 4, 0x778899) });
    const v = viewOf([N('slider', { id: 's', left: 0, top: 0, width: 20, height: 4, thumbImage: 'thumb.bmp', min: 0, max: 100, value: 50 })], { images: si });
    expect(at(v, si, 7, 2)).toBeNull(); // travel 15, half of it is 7.5, which rounds to 8
    expect(who(at(v, si, 8, 2))).toBe('s control');
    expect(who(at(v, si, 12, 2))).toBe('s control');
    expect(at(v, si, 13, 2)).toBeNull();
  });

  it('a slider thumb follows the value, vertical sliders put the maximum on top, and the thumb\'s travel is length - thumb', () => {
    const si = syncImages({ 'thumb.bmp': solidImage(4, 4, 0x778899) });
    const h = viewOf([N('slider', { id: 'h', left: 0, top: 0, width: 20, height: 4, thumbImage: 'thumb.bmp', min: 0, max: 100, value: 100 })], { images: si });
    expect(at(h, si, 3, 2)).toBeNull();
    expect(who(at(h, si, 17, 2))).toBe('h control'); // travel 16: the thumb is at x 16..19
    el(h, 'h').set('value', 50, 'script');
    expect(who(at(h, si, 9, 2))).toBe('h control'); // x 8..11
    expect(at(h, si, 17, 2)).toBeNull();
    const vert = viewOf([N('slider', { id: 'v', left: 0, top: 0, width: 4, height: 20, direction: 'vertical', thumbImage: 'thumb.bmp', min: 0, max: 100, value: 100 })], { images: si });
    expect(who(at(vert, si, 2, 1))).toBe('v control'); // the maximum is at the top
    expect(at(vert, si, 2, 17)).toBeNull();
    const docs = viewOf([N('slider', { id: 'd', left: 0, top: 0, width: 20, height: 4, thumbImage: 'thumb.bmp', borderSize: 4, min: 0, max: 100, value: 0 })], { images: si });
    expect(who(at(docs, si, 1, 2))).toBe('d control'); // oracle geometry: the edge starts at 0, borderSize does not move it
    const docsGeometry = { opts: { ...FAITHFUL, sliderGeometry: /** @type {const} */ ('docs') } };
    expect(at(docs, si, 1, 2, docsGeometry)).toBeNull(); // docs: the centre starts at borderSize, so the edge is at 2
    expect(who(at(docs, si, 3, 2, docsGeometry))).toBe('d control');
  });
});

describe('the image requests are the renderer\'s: same file, same spec', () => {
  it('asks for each image role under the KeySpec the D2 table gives it', () => {
    const images = syncImages({
      'bg.bmp': solidImage(40, 40, 0x111111), 'btn.bmp': solidImage(10, 10, 0x222222), 'track.bmp': solidImage(20, 4, 0x333333),
      'thumb.bmp': solidImage(4, 4, 0x444444), 'g.bmp': solidImage(10, 10, 0x555555), 'map.bmp': solidImage(10, 10, 0xff0033),
    });
    const v = viewOf([
      N('button', { id: 'b', left: 0, top: 0, image: 'btn.bmp', transparencyColor: '#FF00FF' }),
      N('slider', { id: 's', left: 0, top: 12, backgroundImage: 'track.bmp', thumbImage: 'thumb.bmp', transparencyColor: 'auto' }),
      N('buttongroup', { id: 'g', left: 20, top: 0, mappingImage: 'map.bmp', image: 'g.bmp' }, [N('buttonelement', { mappingColor: '#FF0033' })]),
    ], { images, view: { backgroundImage: 'bg.bmp' } });
    at(v, images, 1, 1);
    at(v, images, 1, 13);
    at(v, images, 21, 1);
    const asked = new Map(images.requests.map((r) => [r.ref, r.spec]));
    expect(asked.get('btn.bmp')).toEqual({ transparency: MAGENTA, hitKeyed: true });
    expect(asked.get('track.bmp')).toEqual({ transparency: 'auto', hitKeyed: false });
    expect(asked.get('thumb.bmp')).toEqual({ transparency: 'auto', hitKeyed: true });
    expect(asked.get('g.bmp')).toEqual({ transparency: null, hitKeyed: true });
    expect(asked.get('bg.bmp')).toEqual({ transparency: null, hitKeyed: false });
  });

  it('does not touch the image service for a point nowhere near a boxed element', () => {
    const images = syncImages({ 'btn.bmp': solidImage(10, 10, 0x222222) });
    const v = viewOf(Array.from({ length: 20 }, (_, i) => N('button', { id: `b${i}`, left: 0, top: 0, image: 'btn.bmp' })), { images, width: 100, height: 100 });
    at(v, images, 80, 80);
    expect(images.calls).toBe(0);
  });
});

describe('skin strings are never keys of a plain object (E §1 rule 6)', () => {
  it('ids, refs and mapping colours named __proto__ or constructor are ordinary', () => {
    const art = solidImage(10, 10, 0x336699);
    // An object literal's `__proto__` key would set the prototype, so the table is built as a Map.
    const images = syncImages(new Map([['__proto__', art], ['constructor', art], ['map.bmp', solidImage(10, 10, 0xff0033)]]));
    const v = viewOf([
      N('button', { id: '__proto__', left: 0, top: 0, image: '__proto__' }),
      N('button', { id: 'constructor', left: 20, top: 0, image: 'constructor' }),
      N('buttongroup', { id: 'toString', left: 0, top: 20, mappingImage: 'map.bmp', image: 'constructor' }, [N('buttonelement', { id: 'hasOwnProperty', mappingColor: '#FF0033' })]),
    ], { images });
    expect(who(at(v, images, 5, 5))).toBe('__proto__ control');
    expect(who(at(v, images, 25, 5))).toBe('constructor control');
    expect(who(at(v, images, 5, 25))).toBe('hasOwnProperty control');
    expect(images.raw('__proto__')).not.toBeNull();
    expect(images.raw('toString')).toBeNull();
    expect(images.get('valueOf', { hitKeyed: true })).toBeNull();
  });
});
