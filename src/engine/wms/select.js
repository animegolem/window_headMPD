// @ts-check
// Which `.wms` an archive means (E §5.2 `pickDefinition`; survey 1.2, spec 8.1, U-17). Two archives
// in the corpus hold two definition files (`Nautical`: `Nautical.wms` + `sample.wms`; `Sports`:
// `ExtremeSports.wms` + `saltmine.wms`), and the second is a stale skin whose art is mostly absent.
// WMP's own choice is unknown, so the rule is the one that works on all four copies: the file with
// the fewest unresolved file references, then the one named like the archive, then the larger.
//
// "A file reference" is counted the way survey 3.2 counted it, and `collectReferences` is the one
// definition of that count, so the picker, the builder's tests and the corpus run cannot disagree
// about it: every attribute whose value ends in a known file extension, plus each `scriptFile`
// entry that is not a `res://` resource. Handler text and `jscript:`/`wmpprop:` values are code,
// not file names, and are skipped.

import { decodeText } from '../text/decode.js';
import { scanWms } from './scan.js';

/** @typedef {import('../contracts').RawNode} RawNode */
/** @typedef {import('../contracts').SkinVfs} SkinVfs */

/** The extensions that make an attribute value a file reference (survey 3.2). */
export const REFERENCE_EXTENSIONS = Object.freeze(['bmp', 'gif', 'jpg', 'jpeg', 'png', 'js', 'cur', 'ani']);

const REFERENCE = new RegExp(`\\.(?:${REFERENCE_EXTENSIONS.join('|')})$`, 'i');
const CODE_VALUE = /^\s*(?:jscript|wmpprop|wmpenabled|wmpdisabled):/i;
const HANDLER_NAME = /^on[a-z]|_onchange$/;

/**
 * Every file reference in a scanned tree, in source order. A reference is returned as written; the
 * VFS folds case and path when it looks one up.
 * @param {RawNode | null} root
 * @returns {string[]}
 */
export function collectReferences(root) {
  /** @type {string[]} */
  const refs = [];
  if (!root) return refs;
  const pending = [root];
  while (pending.length) {
    const node = /** @type {RawNode} */ (pending.pop());
    for (const attr of node.attrs) {
      if (attr.name === 'scriptfile') {
        for (const piece of attr.value.split(';')) {
          const entry = piece.trim();
          if (entry && !/^res:\/\//i.test(entry)) refs.push(entry);
        }
      } else if (REFERENCE.test(attr.value) && !HANDLER_NAME.test(attr.name) && !CODE_VALUE.test(attr.value)) {
        refs.push(attr.value);
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
  }
  return refs;
}

/**
 * The references the archive does not hold (case, path and Unicode normalisation folded).
 * @param {SkinVfs} vfs @param {readonly string[]} refs
 * @returns {string[]}
 */
export const unresolvedReferences = (vfs, refs) => refs.filter((ref) => !vfs.has(ref));

/** The part of a file name before its extension, lower case. @param {string} name */
const stemOf = (name) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).replace(/\.[^.]*$/, '').toLowerCase();

/**
 * @typedef {Object} Candidate
 * @property {string} key       VFS key of the `.wms`
 * @property {number} unresolved
 * @property {number} size      bytes
 */

/** @type {WeakMap<SkinVfs, ReturnType<import('../contracts').PickDefinitionFn>>} */
const memo = new WeakMap();

/**
 * Choose the definition file. `wms` is the file's VFS key (lower case: `nautical.wms`). With one
 * `.wms` the answer is that file; with several, the reason says which rule decided. A file that
 * cannot be read loses to any that can. Null when the archive holds no `.wms`. The result is
 * memoised per VFS, because `buildTheme` asks again for the file's stem.
 * @type {import('../contracts').PickDefinitionFn}
 */
export const pickDefinition = (vfs) => {
  if (memo.has(vfs)) return /** @type {ReturnType<import('../contracts').PickDefinitionFn>} */ (memo.get(vfs));
  const result = choose(vfs);
  memo.set(vfs, result);
  return result;
};

/** @param {SkinVfs} vfs @returns {ReturnType<import('../contracts').PickDefinitionFn>} */
function choose(vfs) {
  const keys = vfs.list('.wms');
  if (keys.length === 0) return null;

  /** @type {Candidate[]} */
  const candidates = keys.map((key) => {
    const bytes = vfs.read(key);
    if (!bytes) return { key, unresolved: Infinity, size: 0 };
    const { root } = scanWms(decodeText(bytes).text);
    return { key, unresolved: unresolvedReferences(vfs, collectReferences(root)).length, size: bytes.length };
  });

  /** @param {Candidate} c @param {'only' | 'fewest-unresolved' | 'stem' | 'size'} reason */
  const pick = (c, reason) => Object.freeze({ wms: c.key, reason, unresolved: c.unresolved });

  if (candidates.length === 1) return pick(candidates[0], 'only');

  const fewest = Math.min(...candidates.map((c) => c.unresolved));
  let tied = candidates.filter((c) => c.unresolved === fewest);
  if (tied.length === 1) return pick(tied[0], 'fewest-unresolved');

  const archiveStem = stemOf(vfs.name);
  const named = tied.filter((c) => stemOf(c.key) === archiveStem);
  if (named.length === 1) return pick(named[0], 'stem');
  if (named.length > 1) tied = named;

  // The larger file; on a dead heat the first key in archive order, so the answer is repeatable.
  return pick(tied.reduce((best, c) => (c.size > best.size ? c : best)), 'size');
}
