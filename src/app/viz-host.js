// @ts-check
// VizHost, the `effects` slot (ENGINE.md D10.2): a canvas in the slot, the unchanged src/viz/index.js
// `Viz` drawing on it, the host overlays above it, and an EffectsControl that is the EFFECTS element's
// whole object model (`currentPreset`, `next()`, `mediacenter.effectPreset`, ...).
//
// Wiring, all of it from main.js:
//  - `new Viz(canvas, onPresetChange, captionEl)` (main.js:226-229). The caption element is the
//    overlays' strip; Viz toggles its `hidden` class.
//  - After a zoom change the pixel ratio is `devicePixelRatio * zoom` and the buffer is set again with
//    `updateStyle` false (main.js:369-370). Done once at mount and on every `SkinWindow.onZoom`.
//  - The palette: main.js:439-445 fetched a palette per song and dropped a late reply. That guard now
//    lives in PaletteService (a generation counter), which publishes only the reply for the current
//    song. This host applies each snapshot as it arrives (`default` is `setPalette(null)`, which keeps
//    the preset's own colour order; anything else hands over the clusters) and never after dispose.
//  - Clicks: the engine's input plane owns them. A click on the EFFECTS element with no `onclick`
//    reaches `EffectsControl.click()`, which steps to the next preset (D10.2, parity D25).
//
// The preset index is `mediacenter.effectPreset` (D6.1). `Viz` itself still reads and writes the legacy
// `localStorage.preset` when it starts and steps; that is the pinned file's business and harmless. After
// construction the pref wins: the stored index, when there is one, is stepped to. Any change that comes
// from the Viz (a step from the control, the shell's `V` key calling `viz.step`) is written back; one
// that comes from the pref store (another window) is applied without a write.
//
// A `Viz` that cannot start (no WebGL) leaves the slot without an `effects` control, with the overlays
// still mounted, so the notice can say what is wrong; it does not take the skin down.
//
// The class arrives through `deps.Viz` and this file never imports src/viz/index.js. The shell (boot.js)
// does that import, so "the unchanged src/viz/index.js" is what runs. The reason is the type check:
// `tsc --checkJs` follows a static import into the pinned viz files and reports 23 errors there
// (src/viz/{index,chorus,breath}.js), none of which this task may fix. See the W3.7 notes.

/** @typedef {import('../engine/contracts').SlotHandle} SlotHandle */
/** @typedef {import('../engine/contracts').SlotSpec} SlotSpec */
/** @typedef {import('../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../engine/contracts').PaletteService} PaletteService */
/** @typedef {import('../engine/contracts').PaletteSnapshot} PaletteSnapshot */
/** @typedef {import('../engine/contracts').PrefStore} PrefStore */
/** @typedef {import('../engine/contracts').Rect} Rect */
/** @typedef {import('./overlays.js').Overlays} Overlays */
/**
 * What this file uses of `Viz` (structural, so the pinned class stays out of the type graph).
 * @typedef {{
 *   index: number,
 *   readonly presets: ReadonlyArray<{ readonly title: string }>,
 *   readonly current: { readonly title: string },
 *   readonly renderer: { setPixelRatio(r: number): void, setSize(w: number, h: number, updateStyle?: boolean): void,
 *                        setAnimationLoop?(cb: null | (() => void)): void, dispose?(): void, forceContextLoss?(): void },
 *   step(dir: number): void,
 *   setPalette(swatches: unknown): void,
 *   feed?: (frame: unknown) => void,
 * }} VizLike
 * @typedef {new (canvas: HTMLCanvasElement, onPresetChange: (title: string) => void, captionEl?: HTMLElement | null) => VizLike} VizConstructor
 */

/** The pref the preset index lives in (D6.1). */
export const EFFECT_PREF = Object.freeze({ ns: 'mediacenter', key: 'effectPreset' });

/** @param {number} i @param {number} n */
const wrap = (i, n) => ((i % n) + n) % n;

/** @param {unknown} v @returns {number | null} a stored index, or null when absent or unusable */
function parseIndex(v) {
  if (typeof v !== 'string' || !/^-?\d{1,9}$/.test(v.trim())) return null;
  return Number.parseInt(v, 10);
}

/**
 * @param {{
 *   prefs: Pick<PrefStore, 'load' | 'write'> & Partial<Pick<PrefStore, 'onExternalChange'>>,
 *   palette: PaletteService,
 *   overlays: Overlays,
 *   mediacenterPrefs?: ReadonlyMap<string, string>,
 *   Viz: VizConstructor,
 * }} deps `mediacenterPrefs` is the already-loaded `mediacenter` namespace (G2), so the first frame
 *   starts on the stored preset; without it the namespace is loaded and applied when it arrives
 *   (unless the preset was moved meanwhile). `Viz` is the class of src/viz/index.js.
 * @returns {{ mount(el: HTMLElement, spec: SlotSpec, win: SkinWindow): SlotHandle }}
 */
export function createVizHost(deps) {
  const VizClass = deps.Viz;
  if (typeof VizClass !== 'function') throw new TypeError('createVizHost: deps.Viz is the Viz class of src/viz/index.js');

  return {
    mount(el, spec, win) {
      const doc = el.ownerDocument;
      const view = doc.defaultView ?? globalThis;
      let rect = { ...spec.rect };
      let visible = true;
      let disposed = false;
      /** Moves the control made itself or the shell made through the Viz, before the preset pref loaded. */
      let moved = false;

      const root = doc.createElement('div');
      root.className = 'wh-fx';
      const canvas = doc.createElement('canvas');
      canvas.className = 'wh-fx-viz';
      root.appendChild(canvas);
      const overlay = deps.overlays.mount(root);
      el.appendChild(root);

      const applySize = () => {
        for (const n of [root, canvas]) {
          n.style.width = `${rect.w}px`;
          n.style.height = `${rect.h}px`;
        }
      };
      applySize();

      /** @type {Set<() => void>} */
      const rectListeners = new Set();
      const fireRects = () => { for (const cb of [...rectListeners]) if (rectListeners.has(cb)) cb(); };

      /** @type {VizLike | null} */
      let viz = null;
      /** @type {EffectsControl | null} */
      let control = null;
      /** @type {Array<() => void>} */
      const teardown = [];
      /** While > 0 the Viz's own preset callbacks are our doing and handled by the caller. */
      let quiet = 0;
      /** @type {Set<() => void>} */
      const changeListeners = new Set();
      const fireChange = () => { for (const cb of [...changeListeners]) if (changeListeners.has(cb)) cb(); };
      const persist = () => { if (viz) deps.prefs.write(EFFECT_PREF.ns, EFFECT_PREF.key, String(viz.index)); };

      // Every change the Viz reports after construction, from the control or from anyone calling
      // `viz.step`, is written back and announced. The constructor reports once before `control` exists.
      const onPresetChange = () => {
        if (!control || quiet || disposed) return;
        moved = true;
        persist();
        fireChange();
      };

      try {
        viz = new VizClass(canvas, () => onPresetChange(), overlay.caption);
      } catch (e) {
        console.error('viz: the visualizer could not start', e);
      }

      /** Step the Viz to `i` by the shorter way round, with its callbacks held back. @param {number} i @returns {boolean} moved */
      function goTo(i) {
        if (!viz) return false;
        const n = viz.presets.length;
        const forward = wrap(i - viz.index, n);
        if (forward === 0) return false;
        const back = n - forward;
        quiet++;
        try {
          if (forward <= back) for (let k = 0; k < forward; k++) viz.step(1);
          else for (let k = 0; k < back; k++) viz.step(-1);
        } finally {
          quiet--;
        }
        return true;
      }

      if (viz) {
        const v = viz;
        /** @type {EffectsControl} */
        const effects = {
          get count() { return v.presets.length; },
          get index() { return v.index; },
          get title() { return v.current.title; },
          titleOf: (i) => (Number.isInteger(i) && i >= 0 && i < v.presets.length ? String(v.presets[i]?.title ?? '') : ''),
          setIndex(i) {
            if (typeof i !== 'number' || !Number.isFinite(i)) return;
            moved = true;
            if (goTo(Math.trunc(i))) { persist(); fireChange(); }
          },
          step(d) { v.step(d < 0 ? -1 : 1); },
          click() { v.step(1); },
          onChange(cb) {
            changeListeners.add(cb);
            return () => { changeListeners.delete(cb); };
          },
        };
        control = effects;

        // The stored preset wins over whatever the legacy localStorage gave the Viz.
        /** @param {ReadonlyMap<string, string> | undefined} m */
        const applyStored = (m) => {
          const i = parseIndex(m?.get(EFFECT_PREF.key));
          if (i !== null && goTo(i)) fireChange();
        };
        if (deps.mediacenterPrefs) {
          applyStored(deps.mediacenterPrefs);
        } else {
          deps.prefs.load(EFFECT_PREF.ns).then(
            (m) => { if (!disposed && !moved) applyStored(m); },
            () => { /* no stored preset is no preset */ },
          );
        }
        const follow = deps.prefs.onExternalChange?.(EFFECT_PREF.ns, (key, value) => {
          if (disposed || key !== EFFECT_PREF.key) return;
          const i = parseIndex(value);
          if (i !== null && goTo(i)) fireChange();
        });
        if (follow) teardown.push(follow);

        // Zoom: the buffer follows the zoom so the canvas stays sharp (main.js:369-370).
        /** @param {number} z */
        const applyZoom = (z) => {
          v.renderer.setPixelRatio((view.devicePixelRatio || 1) * z);
          v.renderer.setSize(rect.w, rect.h, false);
        };
        applyZoom(win.zoom);
        teardown.push(win.onZoom(applyZoom));

        // Palette: each snapshot as it lands (the stale-reply guard is the service's).
        /** @param {PaletteSnapshot} snap */
        const applyPalette = (snap) => {
          if (disposed) return;
          v.setPalette(snap.source === 'default' || snap.clusters.length === 0 ? null : snap.clusters);
        };
        applyPalette(deps.palette.snapshot());
        teardown.push(deps.palette.subscribe(applyPalette));
      }

      /** @type {SlotHandle} */
      const handle = {
        element: el,
        update(next) {
          if (disposed) return;
          rect = { ...next.rect };
          applySize();
          if (viz) {
            viz.renderer.setPixelRatio((view.devicePixelRatio || 1) * win.zoom);
            viz.renderer.setSize(rect.w, rect.h, false);
          }
          fireRects();
        },
        setVisible(v) {
          if (disposed || visible === !!v) return;
          visible = !!v;
          root.hidden = !visible;
          fireRects();
        },
        hitRects: () => (visible && !disposed ? [{ ...rect }] : []),
        onHitRectsChange(cb) {
          rectListeners.add(cb);
          return () => { rectListeners.delete(cb); };
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const off of teardown.splice(0)) off();
          overlay.dispose();
          if (viz) {
            // Viz has no teardown of its own: stop its loop, drop the GL context, and let the frame
            // channel it opened feed nothing (a failed send ends that subscription in Rust, D11).
            viz.feed = () => {};
            viz.renderer.setAnimationLoop?.(null);
            viz.renderer.dispose?.();
            viz.renderer.forceContextLoss?.();
          }
          changeListeners.clear();
          rectListeners.clear();
          root.remove();
        },
      };
      if (control) Object.defineProperty(handle, 'effects', { value: control, enumerable: true });
      return handle;
    },
  };
}
