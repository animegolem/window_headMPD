// @ts-check
// Archive identity (ENGINE D4): the SHA-256 of the archive bytes keys prefs, sidecars, saved
// geometry, goldens and caches. Pure: no DOM, no Tauri, just the platform's digest.

/** @type {import('../contracts').Sha256HexFn} */
export const sha256Hex = async (bytes) => {
  const subtle = globalThis.crypto?.subtle;
  // crypto.subtle exists only in secure contexts. The Tauri origin and localhost are; a plain
  // http page on another host is not, and there is no fallback by design (one digest, one path).
  if (!subtle) throw new Error('sha256Hex: crypto.subtle is unavailable in this context');
  const digest = new Uint8Array(await subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
};
