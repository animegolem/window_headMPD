// @ts-check
// The skin's flat file namespace (ENGINE D4). Skins reference files by whatever path and case their
// author typed, so the key is the NFC, lower-cased basename and a reference reduces the same way
// (`Bass_SliderBG.bmp` finds `bass_sliderbg.bmp`, `pl\pl_dropdown_wood.png` finds
// `pl_dropdown_wood.png`). Entry names are skin-controlled, so the lookup is a Map: an entry named
// `__proto__` is just a name.

import { sha256Hex } from './identity.js';
import { foldKey, readZip } from './zip.js';

/** @typedef {import('../contracts').ZipEntry} ZipEntry */

/** @type {import('../contracts').OpenVfsFn} */
export const openVfs = async (bytes, name, caps) => {
  const index = readZip(bytes, caps); // an ArchiveError rejects the promise
  const sha = await sha256Hex(bytes);

  /** @type {Map<string, ZipEntry>} */
  const files = new Map();
  for (const e of index.entries) {
    const prior = files.get(e.key);
    // Several archives collide after folding (`Old_Mac-OS` holds two different skins); the last
    // entry in the central directory wins, which is Webamp's rule.
    if (prior) index.diagnostics.push({ code: 'vfs-case-collision', severity: 'warn', file: e.key, detail: `'${prior.name}' is replaced by '${e.name}' (last entry wins)` });
    files.set(e.key, e);
  }

  /** @param {string} ref */
  const lookup = (ref) => (typeof ref === 'string' ? files.get(foldKey(ref)) : undefined);

  return Object.freeze({
    sha,
    name: String(name),
    has: (ref) => lookup(ref) !== undefined,
    read(ref) {
      const e = lookup(ref);
      return e ? index.read(e) : null;
    },
    list(ext) {
      const keys = [...files.keys()];
      if (ext === undefined) return keys;
      const suffix = ext.toLowerCase();
      return keys.filter((k) => k.endsWith(suffix));
    },
    resolve: (ref) => lookup(ref)?.key ?? null,
    // The reader's own array, so a CRC mismatch found by a later read() shows up here too.
    diagnostics: index.diagnostics,
  });
};
