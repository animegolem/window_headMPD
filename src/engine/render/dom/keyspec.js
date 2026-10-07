// @ts-check
// The KeySpec rules moved to `image/keyspec.js` (G3.F3) so the picker and the shape rasteriser share
// them without reaching into the renderer. Re-exported here so the renderer's own imports and its
// tests are unchanged.
export * from '../../image/keyspec.js';
