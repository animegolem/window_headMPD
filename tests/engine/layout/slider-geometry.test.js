// @ts-check
// G3.F3: the slider geometry has one pure home, `layout/slider-geometry.js`. The renderer's
// `render/dom/slider-geometry.js` re-exports it (its numbers are pinned by
// tests/engine/render/slider-geometry.test.js), and the shape scene's thumb claim uses it
// (tests/engine/shape/shared-rules.test.js).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as home from '../../../src/engine/layout/slider-geometry.js';
import * as viaRenderer from '../../../src/engine/render/dom/slider-geometry.js';
import { fractionAt, thumbCentre, thumbEdge, valueAt } from '../../../src/engine/layout/slider-geometry.js';

const source = readFileSync(new URL('../../../src/engine/layout/slider-geometry.js', import.meta.url), 'utf8');
const NAMES = ['centreRange', 'fractionAt', 'fractionOf', 'revealEdge', 'stripFrame', 'thumbCentre', 'thumbEdge', 'valueAt'];

describe('layout/slider-geometry.js', () => {
  it('exports the geometry functions, and the renderer path is the same functions, not copies', () => {
    expect(Object.keys(home).sort()).toEqual(NAMES);
    expect(Object.keys(viaRenderer).sort()).toEqual(NAMES);
    for (const name of NAMES) expect(/** @type {any} */ (viaRenderer)[name], name).toBe(/** @type {any} */ (home)[name]);
  });

  it('is pure: it names no DOM global and imports nothing', () => {
    expect(source).not.toMatch(/\b(?:document|window)\b/);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
    expect(source).not.toMatch(/import\(/);
  });

  it('keeps the numbers the picker and the drag depend on: the oracle thumb and its pointer inverse', () => {
    const a = /** @type {const} */ ({ vertical: false, length: 71, thumb: 9, border: 0, geometry: 'oracle' });
    expect(thumbEdge(0.5, a)).toBe(31);
    expect(fractionAt(thumbCentre(0.25, a), a)).toBeCloseTo(0.25, 10);
    expect(valueAt(a.thumb / 2, a, -14, 14)).toBe(-14);
  });
});
