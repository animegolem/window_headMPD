// @ts-check
// The skin registry (ENGINE.md D12). The shell does not hand an archive to the engine directly: every
// archive, whatever its family, is first opened with the engine's own `openVfs`, so every family passes
// the same zip caps (D4); then each registered `SkinHost` is asked `canLoad(vfs)` (0..1) and the best
// one loads it. Phase 1 registers one host, the WMS engine; phase 2 registers Webamp's beside it
// without touching this file.
//
// The sidecar is found here too, by the hash `openVfs` computed, because the sidecar is keyed by the
// archive's SHA-256 and a host needs it at load (overlays are built into the model).
//
// `createEngineSkinHost(engine)` adapts the contract `Engine` (which takes archive bytes) to a
// `SkinHost` (which takes a `SkinVfs`). The registry remembers the bytes it opened under their vfs, so
// the adapter can pass them on. The archive is therefore opened twice, here and inside the engine; that
// is a hash and a central-directory read, and a `WmsSkinHost` that takes the vfs directly replaces the
// adapter without any caller changing.

import { openVfs as defaultOpenVfs } from '../engine/archive/vfs.js';

/** @typedef {import('../engine/contracts').SkinHost} SkinHost */
/** @typedef {import('../engine/contracts').HostedSkin} HostedSkin */
/** @typedef {import('../engine/contracts').SkinVfs} SkinVfs */
/** @typedef {import('../engine/contracts').Engine} Engine */
/** @typedef {import('../engine/contracts').HostAdapter} HostAdapter */
/** @typedef {import('../engine/contracts').Sidecar} Sidecar */
/** @typedef {'bad-archive' | 'no-host' | 'load-failed'} SkinLoadCode */

/** A skin that could not be opened or loaded. `code` says which step; `cause` is the underlying error. */
export class SkinLoadError extends Error {
  /** @param {SkinLoadCode} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message);
    this.name = 'SkinLoadError';
    this.code = code;
    this.cause = cause;
  }
}

/** The bytes each opened vfs came from, for adapters that need them. Keyed by the vfs object itself. @type {WeakMap<SkinVfs, Uint8Array>} */
const ARCHIVES = new WeakMap();

/** The archive bytes a registry opened this vfs from, or undefined. @param {SkinVfs} vfs */
export const archiveOf = (vfs) => ARCHIVES.get(vfs);

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e));

/**
 * The WMS engine as a registrable host: it takes any archive with a `.wms` definition.
 * @param {Engine} engine
 * @returns {SkinHost}
 */
export function createEngineSkinHost(engine) {
  return {
    family: 'wms',
    canLoad: (vfs) => (vfs.list('.wms').length > 0 ? 1 : 0),
    async load(vfs, ctx) {
      const archive = archiveOf(vfs);
      if (!archive) throw new Error('the engine skin host loads only archives the registry opened');
      const loaded = await engine.load(archive, { name: vfs.name, ...(ctx.sidecar ? { sidecar: ctx.sidecar } : {}) });
      return loaded;
    },
  };
}

/**
 * @param {{
 *   openVfs?: import('../engine/contracts').OpenVfsFn,
 *   log?: Pick<import('../engine/contracts').Log, 'warn'>,
 * }} [deps]
 */
export function createSkinRegistry(deps = {}) {
  const openVfs = deps.openVfs ?? defaultOpenVfs;
  /** @type {SkinHost[]} */
  const hosts = [];

  /**
   * The registered host with the highest `canLoad` above zero; the earlier registration wins a tie. A
   * host whose `canLoad` throws or answers nonsense scores zero.
   * @param {SkinVfs} vfs
   * @returns {SkinHost | null}
   */
  function best(vfs) {
    /** @type {SkinHost | null} */
    let winner = null;
    let top = 0;
    for (const host of hosts) {
      let score = 0;
      try {
        score = host.canLoad(vfs);
      } catch (e) {
        deps.log?.warn('skin registry: canLoad threw', { family: host.family, error: messageOf(e) });
      }
      if (typeof score === 'number' && Number.isFinite(score) && score > top) {
        top = Math.min(1, score);
        winner = host;
      }
    }
    return winner;
  }

  /**
   * Opens the archive through the engine's reader (zip caps included) and picks the host.
   * @param {Uint8Array} bytes @param {string} name
   * @returns {Promise<{ vfs: SkinVfs, host: SkinHost }>}
   * @throws {SkinLoadError} `bad-archive` or `no-host`
   */
  async function open(bytes, name) {
    /** @type {SkinVfs} */
    let vfs;
    try {
      vfs = await openVfs(bytes, name);
    } catch (e) {
      throw new SkinLoadError('bad-archive', `${name} is not a usable skin archive: ${messageOf(e)}`, e);
    }
    ARCHIVES.set(vfs, bytes);
    const host = best(vfs);
    if (!host) throw new SkinLoadError('no-host', `${name} is not a skin this app can load`);
    return { vfs, host };
  }

  return {
    /** @param {SkinHost} host @returns {() => void} */
    register(host) {
      hosts.push(host);
      return () => {
        const i = hosts.indexOf(host);
        if (i >= 0) hosts.splice(i, 1);
      };
    },

    /** @returns {readonly SkinHost[]} */
    hosts: () => [...hosts],

    open,

    /**
     * Open, find the sidecar, load.
     * @param {Uint8Array} bytes @param {string} name
     * @param {{ host: HostAdapter, sidecarFor?: (sha: string) => Promise<Sidecar | null | undefined> }} ctx
     *   `sidecarFor` is asked for the archive's hash; it should absorb its own failures (a sidecar that
     *   does not validate loads the skin without it)
     * @returns {Promise<{ skin: HostedSkin, vfs: SkinVfs, family: SkinHost['family'], sidecar: Sidecar | null }>}
     * @throws {SkinLoadError}
     */
    async load(bytes, name, ctx) {
      const { vfs, host } = await open(bytes, name);
      const sidecar = (await ctx.sidecarFor?.(vfs.sha)) ?? null;
      try {
        const skin = await host.load(vfs, { host: ctx.host, ...(sidecar ? { sidecar } : {}) });
        return { skin, vfs, family: host.family, sidecar };
      } catch (e) {
        throw new SkinLoadError('load-failed', `${name} failed to load: ${messageOf(e)}`, e);
      }
    },
  };
}
