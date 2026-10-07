// @ts-check
// The image service (ENGINE D3, §5.4): lazy decoding behind the host's `DecodeExecutor`, a cache keyed
// by (SHA-256 of the file's bytes, KeySpec), a 256 MiB LRU, and "old pixels until new ones land".
//
// What each call does:
//   probe(ref)        header-only size from the VFS bytes, memoised per file. Silent about problems:
//                     the builder and `load` report a file that is missing or not an image.
//   get(ref, spec)    sync cache read. On a miss it also starts the load (decodes are lazy: a caller that
//                     only ever calls get() still converges, and `pending()` covers the work), and meanwhile
//                     returns the ref's last good planes, or null when it has none. A file that failed to
//                     decode, or that the archive could not hand over, stays null and is not retried.
//   load(ref, spec)   the same work as a promise: planes, or null for a missing image. Concurrent calls
//                     for one (file, spec) share one job. It never rejects.
//   raw(ref)          the file's RGBA, never keyed, for map images (mappingImage, positionImage). Sync, so
//                     it decodes inline on the calling thread, once, and caches. Map images are small, and
//                     the area cap bounds a hostile one; the executor's 2 s wall-time cap does not apply.
//   pending()         loads in flight; `settled()` waits for zero.
//
// "Old pixels until new ones land" is per file here. The service can tell that a different KeySpec for
// the same file is a replacement (a script changed `transparencyColor`), and get() then keeps showing the
// planes it last delivered for that file. It cannot tell that `el.image = "b.bmp"` replaces "a.bmp",
// since it never sees elements: the renderer keeps its canvas until `load("b.bmp", ...)` resolves.
//
// Cache identity. The key is the SHA-256 of the file's bytes plus a canonical form of the KeySpec, so
// two names for one file share a decode and a clipImage is compared by the file it resolves to. SHA-256
// is async and get() is sync, so a ref-to-hash memo is filled by the first load; until then get() can
// only miss.
//
// A failed or capped decode is a missing image: null, one diagnostic, remembered. A decode the executor
// abandoned (the 2 s terminate) is the same, so a pathological file cannot re-hang the Worker every frame.
// So is an entry the archive cannot hand over (a corrupt deflate stream, an entry over a cap): remembered
// by VFS key, so no later get(), load() or raw() reads it again. That matters more than for a decode,
// because `vfs.read` inflates on the calling thread, which the Worker's 2 s cap does not bound, and it
// does not memoise a failure. The same goes for a clipping image that cannot be read.
//
// `res://` refs never reach the VFS (E §1 rule 5). wmploc 5.5 documents a few Microsoft-art image
// resources the engine cannot ship; they resolve to a transparent image of the documented size plus one
// `unresolved-res` diagnostic, and anything else under `res://` is a missing image.
//
// Lookups keyed by skin strings (VFS keys, refs) are Maps and Sets; nothing here indexes a plain object
// by a skin-controlled name.

import { sha256Hex } from '../archive/identity.js';
import { resolveRes } from '../realm/wmploc.js';
import { decodeImageWithDiagnostics } from './decode/index.js';
import { probeImage } from './probe.js';
import { decodeFailures, runDecodeJob } from './worker.js';

/** @typedef {import('../contracts').DecodeExecutor} DecodeExecutor */
/** @typedef {import('../contracts').DecodeJob} DecodeJob */
/** @typedef {import('../contracts').Diagnostic} Diagnostic */
/** @typedef {import('../contracts').ImageProbe} ImageProbe */
/** @typedef {import('../contracts').ImageService} ImageService */
/** @typedef {import('../contracts').KeySpec} KeySpec */
/** @typedef {import('../contracts').KeyedPlanes} KeyedPlanes */
/** @typedef {import('../contracts').Log} Log */
/** @typedef {import('../contracts').RgbaImage} RgbaImage */
/** @typedef {import('../contracts').SkinVfs} SkinVfs */
/**
 * The contract's ImageService plus a read-only view of the cache for tests and the inspector.
 * @typedef {ImageService & { stats(): { liveBytes: number, entries: number, maxBytes: number } }} ImageServiceWithStats
 */
/** @typedef {{ maxBytes?: number }} ImageServiceOptions */

/** Live decoded bytes per skin session, LRU-evicted beyond it (D3, §10). */
export const MAX_LIVE_BYTES = 256 * 1024 * 1024;

/** Distinct diagnostics remembered for de-duplication. Refs are skin-controlled, so the set is bounded. */
const MAX_REPORTED = 1024;
/** Remembered decode failures. A script cycling a key colour over a corrupt file would otherwise grow it forever. */
const MAX_MISSING = 4096;
/** Longest skin-controlled string echoed into a diagnostic. */
const MAX_ECHO = 200;

// ---------------------------------------------------------------------------------------------
// The inline executor

/**
 * Decodes on the calling thread. For Node tests and the test host; the Tauri app uses the Worker pool
 * in src/hosts/tauri/decode.js. Resolves asynchronously like the Worker does, and records the reason
 * for a missing image in `decodeFailures`.
 * @returns {DecodeExecutor}
 */
export function createInlineExecutor() {
  return {
    async run(job) {
      const { planes, diagnostics } = runDecodeJob(job);
      if (!planes) decodeFailures.set(job, diagnostics);
      return planes;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// wmploc 5.5: image resources the engine does not ship

/**
 * @typedef {{ width: number, height: number, format: ImageProbe['format'], types: readonly string[] }} ResImage
 */

/** @param {number[]} ids @param {ResImage} entry @returns {Array<[number, ResImage]>} */
const resRows = (ids, entry) => ids.map((id) => [id, entry]);

/**
 * The resources the corpus references and WMP's DLL holds (wmploc 5.5), by id. #520 and #521 are a
 * bitmap in WMP 10 and a PNG in WMP 11, so they answer to either type; a type-less `#N` answers to any.
 * #288-#294 and #1685-#1698 are not in either DLL and stay unresolved.
 * @type {ReadonlyMap<number, ResImage>}
 */
const RES_IMAGES = new Map([
  ...resRows([1770, 1771, 1773, 1774, 1776, 1782, 1783, 1784, 1787, 2023, 2024], { width: 32, height: 15, format: 'gif', types: ['RT_IMAGE'] }),
  ...resRows([2030], { width: 30, height: 13, format: 'gif', types: ['RT_IMAGE'] }),
  ...resRows([373, 374, 375, 423, 424, 427], { width: 29, height: 29, format: 'bmp', types: ['RT_BITMAP'] }),
  ...resRows([520], { width: 75, height: 75, format: 'bmp', types: ['RT_BITMAP', 'RT_IMAGE'] }),
  ...resRows([521], { width: 200, height: 200, format: 'bmp', types: ['RT_BITMAP', 'RT_IMAGE'] }),
  ...resRows([1792], { width: 58, height: 15, format: 'bmp', types: ['RT_BITMAP'] }),
]);

const RES_SCHEME = /^\s*res:\/\//i;

/** @param {number} width @param {number} height @param {boolean} allHit every pixel takes hits @returns {KeyedPlanes} */
function transparentPlanes(width, height, allHit) {
  const n = width * height;
  const bytes = (n + 7) >> 3;
  const hit = new Uint8Array(bytes);
  if (allHit) {
    hit.fill(0xff);
    if (n & 7) hit[bytes - 1] = (1 << (n & 7)) - 1; // no stray bits past the last pixel
  }
  return { width, height, rgba: new Uint8ClampedArray(n * 4), paint: new Uint8Array(bytes), hit, clip: null };
}

// ---------------------------------------------------------------------------------------------

/** @param {unknown} s @returns {string} a skin-controlled string, shortened for a diagnostic */
const echo = (s) => {
  const t = String(s);
  return t.length > MAX_ECHO ? `${t.slice(0, MAX_ECHO)}…` : t;
};

/** 0xRRGGBB as a canonical token, `a` for auto, `n` for none. @param {unknown} k */
const keyToken = (k) => (k === 'auto' ? 'a' : typeof k === 'number' ? (k & 0xffffff).toString(16) : 'n');

/** @param {KeyedPlanes} p */
const planesBytes = (p) => p.rgba.byteLength + p.paint.byteLength + p.hit.byteLength + (p.clip ? p.clip.byteLength : 0);

/**
 * `createImageService` with the cache cap exposed, for the LRU test. The contract's three-argument
 * form below is what the engine calls.
 * @param {SkinVfs} vfs
 * @param {DecodeExecutor} exec
 * @param {Log} log
 * @param {ImageServiceOptions} [opts]
 * @returns {ImageServiceWithStats}
 */
export function createImageServiceWithOptions(vfs, exec, log, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_LIVE_BYTES;

  /** The LRU: insertion order is recency, oldest first. A `value` is KeyedPlanes, or an RgbaImage under a `raw:` key.
   * @type {Map<string, { value: any, bytes: number }>} */
  const cache = new Map();
  let liveBytes = 0;
  /** Cache keys whose decode ended in a missing image. Never evicted by the LRU (they hold no pixels). @type {Set<string>} */
  const failed = new Set();
  /** Resolved VFS key -> SHA-256 of that file, filled by the first load. @type {Map<string, string>} */
  const hashes = new Map();
  /** Loads in flight, by `file \n spec`. @type {Map<string, Promise<KeyedPlanes | null>>} */
  const inflight = new Map();
  /** Decodes in flight, by cache key, so two names for one file and one spec share a job. @type {Map<string, Promise<KeyedPlanes | null>>} */
  const decoding = new Map();
  /** Resolved VFS key -> the cache key of the planes last delivered for that file (the "old pixels"). @type {Map<string, string>} */
  const shown = new Map();
  /** @type {Map<string, ImageProbe | null>} */
  const probes = new Map();
  /** Raw decodes that failed, by VFS key. @type {Set<string>} */
  const rawFailed = new Set();
  /** VFS keys whose `read` came back null (corrupt or over a cap). Bounded like `failed`. @type {Set<string>} */
  const unreadable = new Set();
  /** @type {Map<string, ResImage | null>} */
  const resMemo = new Map();
  /** @type {Set<string>} */
  const reported = new Set();

  /** Log a diagnostic once per (code, file, detail). @param {Diagnostic} d */
  const report = (d) => {
    const id = `${d.code}\n${d.file ?? ''}\n${d.detail}`;
    if (reported.has(id)) return;
    if (reported.size >= MAX_REPORTED) {
      if (reported.size === MAX_REPORTED) {
        reported.add('image-diagnostics-capped');
        log.diag({ code: 'image-diagnostics-capped', detail: `more than ${MAX_REPORTED} distinct image diagnostics; further ones are dropped`, severity: 'warn' });
      }
      return;
    }
    reported.add(id);
    log.diag(d);
  };

  /** @param {unknown} ref */
  const reportMissing = (ref) => report({ code: 'image-missing', file: echo(ref), severity: 'warn', detail: `no file '${echo(ref)}' in the archive; the image renders as nothing` });

  /** @param {Diagnostic[] | undefined} list @param {string} file */
  const forward = (list, file) => {
    for (const d of list ?? []) report(d.file === undefined ? { ...d, file } : d);
  };

  /** @param {string} ck @param {any} value @param {number} bytes */
  const insert = (ck, value, bytes) => {
    const old = cache.get(ck);
    if (old) {
      liveBytes -= old.bytes;
      cache.delete(ck);
    }
    cache.set(ck, { value, bytes });
    liveBytes += bytes;
    // Oldest first; the entry just inserted is last and is never the victim, so one image over the cap still caches.
    for (const [key, entry] of cache) {
      if (liveBytes <= maxBytes || cache.size <= 1) break;
      cache.delete(key);
      liveBytes -= entry.bytes;
    }
  };

  /** Read an entry and mark it most recently used. @param {string} ck */
  const touch = (ck) => {
    const entry = cache.get(ck);
    if (entry) {
      cache.delete(ck);
      cache.set(ck, entry);
    }
    return entry;
  };

  /** @param {string} ck */
  const markFailed = (ck) => {
    if (failed.size >= MAX_MISSING) failed.delete(failed.values().next().value);
    failed.add(ck);
  };

  /** Remember an entry the archive could not hand over, and say so once. @param {string} file resolved VFS key */
  const markUnreadable = (file) => {
    if (unreadable.size >= MAX_MISSING) unreadable.delete(unreadable.values().next().value);
    unreadable.add(file);
    report({ code: 'image-unreadable', file, severity: 'warn', detail: `'${file}' is corrupt or over a cap in the archive; the image renders as nothing` });
  };

  /** A ref with nothing to load: an element without an image declares an empty string. @param {unknown} ref */
  const isBlank = (ref) => typeof ref === 'string' && ref.trim() === '';

  /**
   * `res://` handling. undefined: not a res URL. null: unresolved or not an image, a missing image.
   * Otherwise the documented size, with the one diagnostic written.
   * @param {unknown} ref
   * @returns {ResImage | null | undefined}
   */
  const resImage = (ref) => {
    if (typeof ref !== 'string' || !RES_SCHEME.test(ref)) return undefined;
    if (resMemo.has(ref)) return resMemo.get(ref);
    if (resMemo.size >= 1024) resMemo.clear();
    const r = resolveRes(ref);
    const entry = r && (r.type === '' || r.type === 'RT_IMAGE' || r.type === 'RT_BITMAP') ? RES_IMAGES.get(r.id) : undefined;
    /** @type {ResImage | null} */
    const found = entry && (r?.type === '' || entry.types.includes(r?.type ?? '')) ? entry : null;
    if (found) {
      report({ code: 'unresolved-res', file: echo(ref), severity: 'info', detail: `${echo(ref)} is Microsoft art the engine does not ship; a transparent ${found.width}x${found.height} image stands in` });
    } else {
      report({ code: 'unresolved-res', file: echo(ref), severity: 'warn', detail: `${echo(ref)} is not an image resource the engine knows; the image renders as nothing` });
    }
    resMemo.set(ref, found);
    return found;
  };

  /** @param {ResImage} res @param {string} ref @param {KeySpec} spec */
  const placeholder = (res, ref, spec) => {
    const hitKeyed = !!spec?.hitKeyed;
    // Every pixel stands for art that is keyed away, so a keyed-hit element still takes clicks in its rect.
    const ck = `res:${echo(ref)}\n${hitKeyed ? 1 : 0}`;
    const hit = touch(ck);
    if (hit) return /** @type {KeyedPlanes} */ (hit.value);
    const planes = transparentPlanes(res.width, res.height, hitKeyed);
    insert(ck, planes, planesBytes(planes));
    return planes;
  };

  /** The canonical spec and the job's copy of it. @param {KeySpec} spec */
  const normalize = (spec) => {
    const clipping = spec?.clipping ?? null;
    /** @type {KeySpec} */
    const key = { transparency: spec?.transparency ?? null, clipping, hitKeyed: !!spec?.hitKeyed };
    // clipImage only means something next to a clipping key (keyImage ignores it otherwise)
    const clipImage = clipping !== null && spec?.clipImage ? spec.clipImage : null;
    if (clipImage !== null) key.clipImage = clipImage;
    // A res:// clipImage never reaches the VFS (D4): the VFS folds a ref to its basename, so a skin entry
    // named `#1770` would otherwise be picked up. It stays in the key, so the keyer reports it as missing.
    const clipFile = clipImage !== null && !RES_SCHEME.test(clipImage) ? vfs.resolve(clipImage) : null;
    const token = `t${keyToken(key.transparency)}c${keyToken(clipping)}h${key.hitKeyed ? 1 : 0}i${clipImage === null ? 'n' : clipFile ?? '!'}`;
    return { key, token, clipFile };
  };

  /**
   * The sync path shared by get() and load(): the cache key if the file's hash is known, and what the
   * cache says. @param {string} file @param {string} token
   */
  const lookup = (file, token) => {
    const hash = hashes.get(file);
    if (hash === undefined) return { ck: null, entry: undefined, failed: false };
    const ck = `${hash}|${token}`;
    return { ck, entry: touch(ck), failed: failed.has(ck) };
  };

  /**
   * @param {string} file resolved VFS key @param {string} token @param {KeySpec} key @param {string | null} clipFile
   * @returns {Promise<KeyedPlanes | null>}
   */
  async function work(file, token, key, clipFile) {
    try {
      const bytes = vfs.read(file);
      if (!bytes) {
        markUnreadable(file);
        return null;
      }
      let hash = hashes.get(file);
      if (hash === undefined) {
        hash = await sha256Hex(bytes);
        hashes.set(file, hash);
      }
      const ck = `${hash}|${token}`;

      // Another name for this file, or an earlier call, may have finished while the hash was computed.
      const done = touch(ck);
      if (done) {
        shown.set(file, ck);
        return /** @type {KeyedPlanes} */ (done.value);
      }
      if (failed.has(ck)) return null;

      let job = decoding.get(ck);
      if (!job) {
        job = runJob(file, ck, bytes, key, clipFile);
        decoding.set(ck, job);
        job.finally(() => decoding.delete(ck)).catch(() => {});
      }
      const planes = await job;
      if (planes) shown.set(file, ck);
      return planes;
    } catch (e) {
      report({ code: 'image-decode-failed', file, severity: 'error', detail: `decoding '${file}' failed: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
  }

  /**
   * One decode, off the cache. Lands the result (or the failure) before it resolves.
   * @param {string} file @param {string} ck @param {Uint8Array} bytes @param {KeySpec} key @param {string | null} clipFile
   * @returns {Promise<KeyedPlanes | null>}
   */
  async function runJob(file, ck, bytes, key, clipFile) {
    /** @type {DecodeJob} */
    const job = { bytes, key };
    if (clipFile !== null && !unreadable.has(clipFile)) {
      const clip = vfs.read(clipFile);
      if (clip) job.clipBytes = clip;
      else markUnreadable(clipFile); // the keyer still reports the clipping image as not supplied
    }
    /** @type {KeyedPlanes | null} */
    let planes = null;
    try {
      planes = await exec.run(job);
    } catch (e) {
      decodeFailures.set(job, [{ code: 'image-decode-failed', severity: 'error', detail: e instanceof Error ? e.message : String(e) }]);
    }
    if (planes) {
      insert(ck, planes, planesBytes(planes));
      forward(planes.diagnostics, file);
      return planes;
    }
    markFailed(ck);
    // The executor's reason, when it recorded one; else a generic line. One diagnostic either way.
    const why = decodeFailures.get(job);
    const first = why?.find((d) => d.severity === 'error') ?? why?.[0];
    report({
      code: first?.code ?? 'image-decode-failed',
      file,
      severity: first?.severity ?? 'warn',
      detail: `'${file}' could not be decoded${first ? `: ${first.detail}` : ''}; the image renders as nothing`,
    });
    return null;
  }

  /** @type {ImageServiceWithStats['load']} */
  const load = (ref, spec) => {
    if (isBlank(ref)) return Promise.resolve(null);
    const res = resImage(ref);
    if (res !== undefined) return Promise.resolve(res ? placeholder(res, /** @type {string} */ (ref), spec) : null);
    const file = vfs.resolve(ref);
    if (file === null) {
      reportMissing(ref);
      return Promise.resolve(null);
    }
    if (unreadable.has(file)) return Promise.resolve(null); // already reported; never inflate it again
    const { key, token, clipFile } = normalize(spec);
    const slot = `${file}\n${token}`;
    const running = inflight.get(slot);
    if (running) return running;
    const known = lookup(file, token);
    if (known.entry) {
      shown.set(file, /** @type {string} */ (known.ck));
      return Promise.resolve(known.entry.value);
    }
    if (known.failed) return Promise.resolve(null);
    // `finally` runs before any caller's continuation, so inflight and the cache are settled by then.
    const p = work(file, token, key, clipFile).finally(() => inflight.delete(slot));
    inflight.set(slot, p);
    return p;
  };

  return {
    probe(ref) {
      if (isBlank(ref)) return null;
      const res = resImage(ref);
      if (res !== undefined) return res ? { format: res.format, width: res.width, height: res.height } : null;
      const file = vfs.resolve(ref);
      if (file === null) return null;
      const memo = probes.get(file);
      if (memo !== undefined) return memo;
      const bytes = vfs.read(file);
      const p = bytes ? probeImage(bytes) : null;
      probes.set(file, p);
      return p;
    },

    get(ref, spec) {
      if (isBlank(ref)) return null;
      const res = resImage(ref);
      if (res !== undefined) return res ? placeholder(res, /** @type {string} */ (ref), spec) : null;
      const file = vfs.resolve(ref);
      if (file === null) {
        reportMissing(ref);
        return null;
      }
      if (unreadable.has(file)) return null; // already reported; never inflate it again
      const { token } = normalize(spec);
      const known = lookup(file, token);
      if (known.entry) {
        shown.set(file, /** @type {string} */ (known.ck));
        return known.entry.value;
      }
      if (known.failed) return null;
      // A miss: start (or join) the load, and keep the file's last good planes on screen meanwhile.
      load(ref, spec);
      const prev = shown.get(file);
      const old = prev === undefined ? undefined : touch(prev);
      return old ? old.value : null;
    },

    load,

    raw(ref) {
      if (isBlank(ref)) return null;
      const res = resImage(ref);
      if (res !== undefined) {
        if (!res) return null;
        const ck = `res-raw:${echo(ref)}`;
        const hit = touch(ck);
        if (hit) return hit.value;
        /** @type {RgbaImage} */
        const image = { width: res.width, height: res.height, data: new Uint8ClampedArray(res.width * res.height * 4) };
        insert(ck, image, image.data.byteLength);
        return image;
      }
      const file = vfs.resolve(ref);
      if (file === null) {
        reportMissing(ref);
        return null;
      }
      const ck = `raw:${file}`;
      const hit = touch(ck);
      if (hit) return hit.value;
      if (rawFailed.has(file) || unreadable.has(file)) return null;
      const bytes = vfs.read(file);
      if (!bytes) {
        markUnreadable(file);
        return null;
      }
      const { image, diagnostics } = decodeImageWithDiagnostics(bytes);
      if (!image) {
        rawFailed.add(file);
        const first = diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0];
        report({ code: first?.code ?? 'image-decode-failed', file, severity: first?.severity ?? 'warn', detail: `'${file}' could not be decoded${first ? `: ${first.detail}` : ''}; the image renders as nothing` });
        return null;
      }
      forward(diagnostics, file);
      // Frames and the palette are not wanted for a map image; drop them so the cache holds pixels only.
      /** @type {RgbaImage} */
      const flat = { width: image.width, height: image.height, data: image.data };
      insert(ck, flat, flat.data.byteLength);
      return flat;
    },

    pending: () => inflight.size,

    stats: () => ({ liveBytes, entries: cache.size, maxBytes }),
  };
}

/** @type {import('../contracts').CreateImageServiceFn} */
export const createImageService = (vfs, exec, log) => createImageServiceWithOptions(vfs, exec, log);
