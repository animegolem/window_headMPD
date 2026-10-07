// @ts-check
// The skin archive store as the page sees it (ENGINE.md D4): thin, validated calls over the Rust
// `skin_*` commands. Rust stores archives by SHA-256 and returns their bytes; the engine parses the
// zip in JS, so nothing here looks inside an archive.
//
//  - `read(sha)` returns the archive's bytes. `skin_read` answers with a raw response, which arrives
//    as an ArrayBuffer, never a JSON number array; the sha is checked (64 lowercase hex) before the IPC.
//  - `importDefault()` is the shell's first-run import. The path comes from `skin_default_path`, which
//    is `WINDOW_HEADMPD_SKIN` when that is set (the webview cannot read process env), else
//    `~/Downloads/Headspace.wmz` when the file exists. The fallback is imported only when no skin is
//    recorded yet, so a skin the owner removed or replaced is not brought back at every launch. A path
//    that is *not* the fallback can only be the env var, which is an explicit instruction, so it is
//    imported every time (the import is content-addressed, and returns the same record for the same
//    bytes). Rust does the real checks on the path (extension, regular file, size, central directory).
//
// `invoke` is an argument (Tauri's), so this file loads in Node.

/** @typedef {import('../../engine/contracts').Log} Log */
/** @typedef {(cmd: string, args?: any) => Promise<unknown> | unknown} InvokeFn */
/** @typedef {{ sha: string, name: string, family: string, bytes: number, imported_at: number }} SkinRecord `headcore::skinstore::SkinRecord` */
/**
 * @typedef {{
 *   list(): Promise<SkinRecord[]>,
 *   read(sha: string): Promise<Uint8Array>,
 *   importPath(path: string): Promise<SkinRecord>,
 *   importDefault(): Promise<SkinRecord | null>,
 *   remove(sha: string): Promise<void>,
 * }} SkinStore
 */

export const SHA_PATTERN = /^[0-9a-f]{64}$/;
/** Where `skin_default_path` looks when the env var is unset; a path ending so is the fallback. */
export const FALLBACK_SUFFIX = '/Downloads/Headspace.wmz';

/** @param {unknown} v */
const isRecord = (v) => !!v && typeof v === 'object' && typeof (/** @type {any} */ (v)).sha === 'string' && SHA_PATTERN.test(/** @type {any} */ (v).sha);

/**
 * @param {unknown} buf what `skin_read` resolved with
 * @returns {Uint8Array}
 */
function toBytes(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (Array.isArray(buf)) return Uint8Array.from(buf);
  throw new TypeError('skin_read returned something that is not bytes');
}

/**
 * @param {{ invoke: InvokeFn, log?: Pick<Log, 'info'> }} deps
 * @returns {SkinStore}
 */
export function createSkinStore(deps) {
  const { invoke } = deps;
  const info = (/** @type {string} */ m, /** @type {object} */ d) => { deps.log?.info(m, d); };

  /** @param {string} sha */
  function checkSha(sha) {
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new TypeError(`a skin sha is 64 lowercase hex digits, got "${String(sha).slice(0, 80)}"`);
  }

  /** @type {SkinStore} */
  const store = {
    async list() {
      const rows = await invoke('skin_list');
      return Array.isArray(rows) ? /** @type {SkinRecord[]} */ (rows.filter(isRecord)) : [];
    },

    async read(sha) {
      checkSha(sha);
      return toBytes(await invoke('skin_read', { sha }));
    },

    async importPath(path) {
      if (typeof path !== 'string' || path === '') throw new TypeError('a skin path is a non-empty string');
      const rec = await invoke('skin_import', { path });
      if (!isRecord(rec)) throw new TypeError('skin_import returned something that is not a skin record');
      return /** @type {SkinRecord} */ (rec);
    },

    async importDefault() {
      const path = await invoke('skin_default_path');
      if (typeof path !== 'string' || path === '') return null;
      if (path.endsWith(FALLBACK_SUFFIX) && (await store.list()).length > 0) return null;
      const rec = await store.importPath(path);
      info('skins: imported the default skin', { sha: rec.sha.slice(0, 12), name: rec.name });
      return rec;
    },

    async remove(sha) {
      checkSha(sha);
      await invoke('skin_remove', { sha });
    },
  };
  return store;
}
