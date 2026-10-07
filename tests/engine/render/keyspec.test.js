// @ts-check
// KeySpec derivation (spec 5.5 "per declaration"; E D3 keying; E D2 hit planes). The renderer and the
// picker share this function so they ask the image service for the same (file, spec) pair.
import { describe, expect, it } from 'vitest';
import { clippingOf, keySpecFor, specToken, transparencyOf } from '../../../src/engine/render/dom/keyspec.js';
import { buildTheme } from '../../../src/engine/wms/build.js';

const vfs = { sha: '0'.repeat(64), name: 'x', diagnostics: [], has: () => false, read: () => null, list: () => [], resolve: () => null };
const attrs = (o) => Object.entries(o).map(([name, value], i) => ({ name: name.toLowerCase(), value: String(value), line: i + 1 }));
/** One element of a tag with attributes. */
function make(tag, a = {}) {
  const raw = { tag: 'theme', attrs: [], line: 1, children: [{ tag: 'view', attrs: attrs({ id: 'v', width: 10, height: 10 }), line: 1, children: [{ tag, attrs: attrs({ id: 'e', ...a }), children: [], line: 2 }] }] };
  return buildTheme(/** @type {any} */ (raw), vfs, { probe: () => null }).views[0].byId('e');
}

describe('transparencyOf', () => {
  it('is a colour, auto, or nothing', () => {
    expect(transparencyOf(make('button', { transparencyColor: '#FF00FF' }))).toBe(0xff00ff);
    expect(transparencyOf(make('button', { transparencyColor: 'auto' }))).toBe('auto');
    expect(transparencyOf(make('button', { transparencyColor: 'none' }))).toBe(null);
    expect(transparencyOf(make('button'))).toBe(null); // a BUTTON declares no default
    expect(transparencyOf(make('slider'))).toBe(null); // rule 5: an undeclared slider key keys nothing
    expect(transparencyOf(make('buttongroup'))).toBe(null); // its default is `none`
  });
});

describe('clippingOf', () => {
  it('clips only what the skin declared: the default `auto` on every element clips nothing', () => {
    expect(clippingOf(make('subview'))).toEqual({ clipping: null });
    expect(clippingOf(make('button'))).toEqual({ clipping: null });
  });

  it('a declared clippingColor clips from the image itself', () => {
    expect(clippingOf(make('subview', { clippingColor: '#FF0000' }))).toEqual({ clipping: 0xff0000 });
    expect(clippingOf(make('subview', { clippingColor: 'auto' }))).toEqual({ clipping: 'auto' });
  });

  it('`none` declared clips nothing', () => {
    expect(clippingOf(make('subview', { clippingColor: 'none' }))).toEqual({ clipping: null });
  });

  it('a clippingImage brings its own region; its colour defaults to auto', () => {
    expect(clippingOf(make('button', { clippingImage: 'c.bmp' }))).toEqual({ clipping: 'auto', clipImage: 'c.bmp' });
    expect(clippingOf(make('button', { clippingImage: ' c.bmp ', clippingColor: '#00FF00' }))).toEqual({ clipping: 0x00ff00, clipImage: 'c.bmp' });
  });

  it('a script that gives an undeclared element a clipping colour makes it count', () => {
    const el = make('subview');
    el.set('clippingColor', '#112233', 'script');
    expect(clippingOf(el)).toEqual({ clipping: 0x112233 });
  });
});

describe('keySpecFor', () => {
  const faithful = { buttonKeyedPixelsHit: true };
  const compat = { buttonKeyedPixelsHit: false };

  it('keyed pixels of a BUTTON, a group image and a thumb take hits when the option says so; backgrounds and tracks never', () => {
    const el = make('button', { transparencyColor: '#FF00FF' });
    expect(keySpecFor(el, 'button', faithful)).toEqual({ transparency: 0xff00ff, hitKeyed: true });
    expect(keySpecFor(el, 'button', compat)).toEqual({ transparency: 0xff00ff, hitKeyed: false });
    expect(keySpecFor(el, 'thumb', faithful).hitKeyed).toBe(true);
    expect(keySpecFor(el, 'background', faithful).hitKeyed).toBe(false);
    expect(keySpecFor(el, 'track', faithful).hitKeyed).toBe(false);
    expect(keySpecFor(el, 'strip', faithful).hitKeyed).toBe(false);
  });

  it('carries the clipping half only when there is one', () => {
    const plain = keySpecFor(make('subview', { transparencyColor: '#FF00FF' }), 'background', faithful);
    expect('clipping' in plain).toBe(false);
    const clipped = keySpecFor(make('subview', { clippingColor: '#FF0000', transparencyColor: '#FF00FF' }), 'background', faithful);
    expect(clipped).toEqual({ transparency: 0xff00ff, hitKeyed: false, clipping: 0xff0000 });
  });

  it('specToken tells two specs apart and is stable', () => {
    const a = keySpecFor(make('button', { transparencyColor: '#FF00FF' }), 'button', faithful);
    const b = keySpecFor(make('button', { transparencyColor: '#00FF00' }), 'button', faithful);
    expect(specToken(a)).toBe(specToken({ ...a }));
    expect(specToken(a)).not.toBe(specToken(b));
    expect(specToken({ hitKeyed: true })).not.toBe(specToken({ hitKeyed: false }));
  });
});
