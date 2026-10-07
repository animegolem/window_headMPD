// @ts-check
// G3.F3: the KeySpec rules have one pure home, `image/keyspec.js`. The renderer's `render/dom/keyspec.js`
// re-exports it (its own tests, tests/engine/render/keyspec.test.js, exercise the rules through that
// path), and the shape scene asks for the same specs (tests/engine/shape/shared-rules.test.js).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as home from '../../../src/engine/image/keyspec.js';
import * as viaRenderer from '../../../src/engine/render/dom/keyspec.js';

const source = readFileSync(new URL('../../../src/engine/image/keyspec.js', import.meta.url), 'utf8');

describe('image/keyspec.js', () => {
  it('exports the four rule functions, and the renderer path is the same functions, not copies', () => {
    expect(Object.keys(home).sort()).toEqual(['clippingOf', 'keySpecFor', 'specToken', 'transparencyOf']);
    expect(Object.keys(viaRenderer).sort()).toEqual(Object.keys(home).sort());
    for (const name of /** @type {const} */ (['clippingOf', 'keySpecFor', 'specToken', 'transparencyOf'])) {
      expect(viaRenderer[name], name).toBe(home[name]);
    }
  });

  it('is pure: it names no DOM global and imports nothing from the renderer', () => {
    expect(source).not.toMatch(/\b(?:document|window)\b/);
    expect(source).not.toMatch(/\bfrom\s+['"]/); // no static import at all: types only, through JSDoc
    expect(source).not.toMatch(/import\(['"][^'"]*render/);
  });
});
