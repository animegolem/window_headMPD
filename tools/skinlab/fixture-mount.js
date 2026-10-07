// The in-page half of skinlab's synthetic fixtures (E D9 "Skinlab fixtures render synthetic skins built
// by test code and compare against expected pixels computed from fixture data, not from art").
//
// cmd-fixtures.mjs opens this page once per case in pinned Chromium and drives it:
//
//   start(id)      imports nothing new; runs the case's `run(t)` until its first stop
//   next(result)   resumes a case that stopped at a screenshot, with Node's verdict on it
//
// Each call returns the next stop: `{ shot }` (Node takes the screenshot of `rect` and compares it with
// `expected`, premultiplied-equal, within `tolerance`) or `{ done, report }`. The case builds its skin
// with the tests/support writers (browser-safe), mounts it through the real chain (openVfs, scanWms,
// buildTheme, createImageService, createRenderer) on the test host's manual clock, and computes the
// expected pixels itself from the data it wrote.
//
// Every case is also held to the DOM rules of E D2: no `<img>` or other forbidden node is ever added
// under the skin root, no engine node carries an inline or computed z-index, and nothing assigns
// markup through the HTML setters. A MutationObserver and setter traps are installed before the
// renderer exists, so they see its first write.

import { openVfs } from '../../src/engine/archive/vfs.js';
import { decodeText } from '../../src/engine/text/decode.js';
import { scanWms } from '../../src/engine/wms/scan.js';
import { buildTheme } from '../../src/engine/wms/build.js';
import { createImageService } from '../../src/engine/image/service.js';
import { createRenderer } from '../../src/engine/render/dom/index.js';
import { createTestHost } from '../../src/hosts/test/index.js';
import { FAITHFUL, ORACLE_COMPAT } from '../../src/engine/options.js';
import { buildBmp } from '../../tests/support/bmp-writer.js';
import { buildZip } from '../../tests/support/zip-writer.js';

const modules = import.meta.glob('./fixtures/*.case.js', { eager: true });

/** @type {Map<string, { id: string, area: string, title: string, run: (t: any) => Promise<void> }>} */
const CASES = new Map();
for (const mod of Object.values(modules)) {
  const m = /** @type {any} */ (mod);
  for (const c of m.cases ?? []) CASES.set(c.id, { ...c, area: m.area });
}

const CONFIGS = { faithful: FAITHFUL, compat: ORACLE_COMPAT };

// ---- the DOM watch -----------------------------------------------------------------------------------

/** Node names an engine must never add (E D2 "Forbidden", D8 rule 3). */
const FORBIDDEN_NODES = new Set(['IMG', 'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'STYLE', 'VIDEO', 'AUDIO']);

const watch = { added: new Set(), htmlSetters: /** @type {string[]} */ ([]) };

let trapsInstalled = false;

function installTraps() {
  if (trapsInstalled) return;
  trapsInstalled = true;
  for (const prop of ['innerHTML', 'outerHTML']) {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(Element.prototype, prop, {
      ...d,
      set(v) {
        watch.htmlSetters.push(prop);
        return d.set.call(this, v);
      },
    });
  }
  const insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function trap(...a) {
    watch.htmlSetters.push('insertAdjacentHTML');
    return insertAdjacentHTML.apply(this, a);
  };
}

function observe(root) {
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        watch.added.add(n.nodeName);
        if (n.querySelectorAll) for (const d of n.querySelectorAll('*')) watch.added.add(d.nodeName);
      }
    }
  });
  mo.observe(root, { childList: true, subtree: true });
  return mo;
}

/** @param {HTMLElement} root @returns {string[]} the DOM rules the page broke */
function domViolations(root) {
  const bad = [];
  for (const n of root.querySelectorAll('*')) {
    if (FORBIDDEN_NODES.has(n.nodeName)) bad.push(`forbidden node <${n.nodeName.toLowerCase()}> in the tree`);
    if (n.style.zIndex !== '') bad.push(`inline z-index "${n.style.zIndex}" on ${describe(n)}`);
    const z = getComputedStyle(n).zIndex;
    if (z !== 'auto') bad.push(`computed z-index "${z}" on ${describe(n)}`);
  }
  for (const name of watch.added) if (FORBIDDEN_NODES.has(name)) bad.push(`a <${name.toLowerCase()}> was added at some point`);
  if (watch.htmlSetters.length) bad.push(`markup was assigned through ${[...new Set(watch.htmlSetters)].join(', ')}`);
  return [...new Set(bad)].slice(0, 8);
}

const describe = (n) => `<${n.nodeName.toLowerCase()}${n.className ? `.${String(n.className).split(' ')[0]}` : ''}>`;

// ---- pixels -----------------------------------------------------------------------------------------

/** 760x394 is 1.2 MB of RGBA: go in slices, a spread of the whole array would overflow the stack. */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(s);
}

/** An expected picture: RGBA, transparent until drawn on. */
class Px {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  /** Fill a rectangle (default all) with `[r, g, b, a?]`. */
  fill(rgba, x = 0, y = 0, w = this.w - x, h = this.h - y) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.put(xx, yy, rgba);
    }
    return this;
  }

  put(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    this.data.set([r, g, b, a], (y * this.w + x) * 4);
    return this;
  }

  get(x, y) {
    const o = (y * this.w + x) * 4;
    return [...this.data.subarray(o, o + 4)];
  }

  /**
   * Draw an image from `bmp()` over the picture at (dx, dy), clipped to it. `key` is a colour whose
   * pixels are transparent, so what is under them shows; every other pixel is opaque and replaces
   * what was there. `crop` takes `{x, y, w, h}` of the source only.
   */
  image(img, dx, dy, { key = null, crop = null } = {}) {
    const c = crop ?? { x: 0, y: 0, w: img.width, h: img.height };
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const o = ((c.y + y) * img.width + c.x + x) * 4;
        const p = [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
        const keyed = key !== null && p[0] === key[0] && p[1] === key[1] && p[2] === key[2];
        if (!keyed) this.put(dx + x, dy + y, p);
      }
    }
    return this;
  }
}

/**
 * A 24-bit BMP as the engine will read it, and the pixels it holds. `pixel(x, y)` is `[r, g, b]`.
 * @param {number} w @param {number} h @param {(x: number, y: number) => number[]} pixel
 */
function bmp(w, h, pixel) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...pixel(x, y).slice(0, 3), 255], (y * w + x) * 4);
  const built = buildBmp({ width: w, height: h, bpp: 24, rgba });
  return { bytes: built.bytes, rgba, width: w, height: h };
}

// ---- the case kit ------------------------------------------------------------------------------------

/** The stop the driver is waiting for, and the case waiting for the driver. */
const channel = { stop: /** @type {null | ((m: any) => void)} */ (null), resume: /** @type {null | ((r: any) => void)} */ (null) };

function pause(message) {
  return new Promise((resume) => {
    channel.resume = resume;
    const stop = channel.stop;
    channel.stop = null;
    stop?.(message);
  });
}

const raf = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{ id: string, title: string }} def */
function makeKit(def) {
  const failures = [];
  const notes = [];
  const root = /** @type {HTMLElement} */ (document.getElementById('skin'));
  const session = /** @type {any} */ ({});

  const t = {
    id: def.id,
    title: def.title,
    session,
    bmp,
    px: (w, h) => new Px(w, h),
    assert(cond, message) {
      if (!cond) failures.push(message);
    },
    eq(actual, expected, message) {
      if (actual !== expected) failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    note: (m) => notes.push(m),

    /**
     * Build the archive, run the real load chain and mount the renderer.
     * @param {{ wms: string, files?: Record<string, { bytes: Uint8Array } | Uint8Array>, config?: 'faithful' | 'compat', opts?: object, zoom?: number, media?: string }} o
     */
    async mount(o) {
      const entries = [{ name: 'skin.wms', data: o.wms }];
      for (const [name, f] of Object.entries(o.files ?? {})) entries.push({ name, data: f.bytes ?? f });
      const archive = buildZip(entries);
      const host = createTestHost({ window: { root, zoom: o.zoom ?? 1 }, media: o.media });
      const vfs = await openVfs(archive, 'fixture.wmz');
      const scanned = scanWms(decodeText(vfs.read('skin.wms')).text);
      const images = createImageService(vfs, host.decode, host.log);
      const theme = buildTheme(scanned.root, vfs, { probe: (ref) => images.probe(ref) });
      const view = theme.views[0];
      const opts = { ...(CONFIGS[o.config ?? 'faithful']), ...(o.opts ?? {}) };
      const renderer = createRenderer(root, images, host.slots, host.window, opts, { clock: host.clock, log: host.log });
      installTraps();
      watch.added.clear();
      watch.htmlSetters.length = 0;
      session.observer = observe(root);
      renderer.mount(view);
      host.clock.onFrame(() => renderer.frame(view.takeDirty()));
      Object.assign(session, { host, vfs, images, theme, view, renderer, opts, diagnostics: [...theme.diagnostics] });
      await host.window.setInitialSize(view.view.get('width'), view.view.get('height'));
      await t.settle();
      return session;
    },

    el(id) {
      const el = session.view.byId(id);
      if (!el) throw new Error(`no element "${id}"`);
      return el;
    },
    node(id) {
      return session.renderer.nodeOf(t.el(id));
    },
    /** Write an attribute the way a script would, then apply it. */
    async set(id, attr, value, origin = 'script') {
      t.el(id).set(attr, value, origin);
      session.renderer.frame(session.view.takeDirty());
      await t.settle();
    },
    computed: (node) => getComputedStyle(node),
    rect: (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    /** The picked element and part, as the picker names them. */
    async pointer(over, pressed = null) {
      const target = (spec) => (spec ? { el: t.el(spec.id ?? spec), part: spec.part ?? null } : null);
      session.renderer.setPointer(target(over), target(pressed));
      await t.settle();
    },

    /** Move the manual clock; frames (and so the renderer's tick) run every 16 ms inside it. */
    async advance(ms) {
      session.host.clock.advance(ms);
      await t.settle();
    },

    /** Decodes landed, one frame applied, the compositor caught up. */
    async settle() {
      for (let i = 0; i < 400 && session.images.pending() > 0; i++) await sleep(5);
      await sleep(0);
      session.renderer.frame(session.view.takeDirty());
      await raf();
      await raf();
    },

    /**
     * Stop here and have Node screenshot `rect` and compare it with `expected` (a Px).
     * @param {string} name @param {{ x: number, y: number, w: number, h: number }} rect @param {Px} expected
     * @param {{ tolerance?: number }} [o]
     */
    async shot(name, rect, expected, o = {}) {
      if (expected.w !== rect.w || expected.h !== rect.h) {
        failures.push(`shot ${name}: expected picture is ${expected.w}x${expected.h}, rect is ${rect.w}x${rect.h}`);
        return;
      }
      await t.settle();
      const verdict = await pause({ shot: { name, rect, expected: toBase64(expected.data), tolerance: o.tolerance ?? 0 } });
      if (!verdict.ok) failures.push(`shot ${name}: ${verdict.detail}`);
    },
  };

  /** What the page can say about the DOM after the case, folded into the report. */
  t.finish = () => {
    if (session.renderer) failures.push(...domViolations(root));
    for (const d of session.diagnostics ?? []) if (d.severity === 'error') failures.push(`build diagnostic: ${d.code} ${d.detail}`);
  };
  t.failures = failures;
  t.notes = notes;
  return t;
}

async function runCase(id) {
  const def = CASES.get(id);
  if (!def) return { id, pass: false, failures: [`no such case "${id}"`], notes: [] };
  const t = makeKit(def);
  try {
    await def.run(t);
    t.finish();
  } catch (e) {
    t.failures.push(`threw: ${e?.stack ?? e}`);
  }
  try {
    t.session.renderer?.dispose();
    t.session.observer?.disconnect();
  } catch (e) {
    t.failures.push(`dispose threw: ${e?.message ?? e}`);
  }
  return { id, pass: t.failures.length === 0, failures: t.failures, notes: t.notes };
}

window.__skinlabFixture = {
  booted: true,
  list: () => [...CASES.values()].map((c) => ({ id: c.id, area: c.area, title: c.title })),
  start(id) {
    return new Promise((resolve) => {
      channel.stop = resolve;
      runCase(id).then((report) => {
        const stop = channel.stop;
        channel.stop = null;
        stop?.({ done: true, report });
      });
    });
  },
  next(result) {
    return new Promise((resolve) => {
      channel.stop = resolve;
      const resume = channel.resume;
      channel.resume = null;
      resume?.(result);
    });
  },
};
