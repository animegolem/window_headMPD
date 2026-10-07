// @ts-check
// `parsePath` (E §5.11, E D5 bindings): the `wmpprop:` target of an attribute, as the binding engine
// reads it. The grammar is wms/values.js `parseBindPath`, the one grammar `classifyValue` also uses,
// so the builder and the engine cannot disagree on what a path is. This file adds the caps a binding
// needs on top of it (names and literals are skin text that ends up in ledger keys), and the way
// back from a parsed path to the text the object graph's `changeSource` takes.
//
//   parsePath('player.settings.getMode(\'loop\');')
//     -> { root: 'player', segments: [{ name: 'settings' }, { name: 'getMode', args: ['loop'] }] }

import { parseBindPath } from '../wms/values.js';

/** @typedef {import('../contracts').BindPath} BindPath */
/** @typedef {import('../contracts').BindSegment} BindSegment */

/**
 * What a binding path may hold beyond `parseBindPath`'s own limits (512 characters, 16 segments, 8
 * arguments). The longest corpus names are under 40 characters.
 */
export const PATH_CAPS = Object.freeze({ maxNameChars: 64, maxLiteralChars: 128 });

/**
 * @param {BindSegment} seg
 * @returns {boolean} whether the segment's name and string arguments are within the caps
 */
function segmentFits(seg) {
  if (seg.name.length > PATH_CAPS.maxNameChars) return false;
  return !seg.args || seg.args.every((a) => typeof a !== 'string' || a.length <= PATH_CAPS.maxLiteralChars);
}

/**
 * `segment ('.' segment)* ';'?` with call segments and literal arguments; null when the text is not
 * a path or is over a cap. The text is the part after `wmpprop:`.
 * @type {import('../contracts').ParsePathFn}
 */
export function parsePath(src) {
  if (typeof src !== 'string') return null;
  const path = parseBindPath(src);
  if (!path) return null;
  if (path.root.length > PATH_CAPS.maxNameChars) return null;
  return path.segments.every(segmentFits) ? path : null;
}

/** @param {string | number | boolean} v */
const literalText = (v) => (typeof v === 'string' ? `'${v.replace(/[\\']/g, '\\$&')}'` : String(v));

/**
 * The text of a parsed path, in the form `parsePath` reads back to the same path: the form the
 * object graph's `changeSource(path: string)` takes. Null when the path has no such text (a number
 * literal that prints in exponent form), which a caller treats as an unresolvable binding.
 * @param {BindPath} path
 * @returns {string | null}
 */
export function formatPath(path) {
  const text = [path.root, ...path.segments.map((s) => (s.args ? `${s.name}(${s.args.map(literalText).join(', ')})` : s.name))].join('.');
  const back = parsePath(text);
  return back && JSON.stringify(back) === JSON.stringify(path) ? text : null;
}

/**
 * The path a `wmpenabled:` or `wmpdisabled:` value binds: `Controls.isAvailable(<method>)` (E D5,
 * U-4). The method is the last segment of the markup's spelling, lower-cased by the classifier.
 * @param {string} method
 * @returns {BindPath}
 */
export const availabilityPath = (method) => ({
  root: 'player',
  segments: [{ name: 'controls' }, { name: 'isAvailable', args: [method] }],
});
