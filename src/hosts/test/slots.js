// @ts-check
// SlotProvider for the test host (ENGINE.md D8 TestHostAdapter, D10.2, D10.4). It gives the engine
// the two host surfaces a Headspace render needs without any of the app's code:
//
//   effects   a stub visualizer: a black canvas of the slot's size, the five preset titles in `viz:23`
//             order, and an EffectsControl whose index starts at `mediacenter.effectPreset`. Skinlab
//             shows exactly this where the oracle shows its own black stub (the "effects hole").
//   playlist  an injected widget factory. Until the real widget is injected (W5.1, from
//             src/app/widgets/playlist.js) a blank placeholder stands in: the empty slot element,
//             reporting its rect so the window shape has the playlist's box in it.
//
// Both report `[spec.rect]` from `hitRects()`. The coordinates are view px, the space of
// `SlotSpec.rect`, which is the one assumption made here (the contract does not say; the oracle's mask
// counts the effects canvas as a solid rect, so the stub must claim its box to leave only the 106
// screen corners to differ). A hidden slot reports nothing.
//
// A `video` slot is inert. Nothing here reads the global `document`: a canvas is created only when the
// element passed to `mount` has an `ownerDocument`, so the provider also runs headless in Node with
// plain objects for elements.

/** @typedef {import('../../engine/contracts').SlotProvider} SlotProvider */
/** @typedef {import('../../engine/contracts').SlotHandle} SlotHandle */
/** @typedef {import('../../engine/contracts').SlotSpec} SlotSpec */
/** @typedef {import('../../engine/contracts').SkinWindow} SkinWindow */
/** @typedef {import('../../engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../../engine/contracts').AttrValue} AttrValue */
/** @typedef {import('../../engine/contracts').Rect} Rect */
/** @typedef {import('../../engine/contracts').Unsubscribe} Unsubscribe */
/**
 * What W5.1 injects: the shape of `mountPlaylist(el, media, attrs)` of ENGINE.md §6.2. `win` is passed
 * as well, for widgets that listen on the window root (the combo list that closes on an outside press).
 * @typedef {(el: HTMLElement, media: MediaModel, attrs: ReadonlyMap<string, AttrValue>, win: SkinWindow) => SlotHandle} PlaylistFactory
 * @typedef {{ peek(ns: string): Map<string, string>, write(ns: string, key: string, value: string | null): void,
 *             onExternalChange?(ns: string, cb: (key: string, value: string | null) => void): Unsubscribe }} SlotPrefs the part of the prefs the effects slot uses
 * @typedef {{ prefs?: SlotPrefs, media?: MediaModel, playlist?: PlaylistFactory, titles?: readonly string[] }} SlotOptions
 * @typedef {{ kind: SlotSpec['kind'], el: HTMLElement, spec: SlotSpec, handle: SlotHandle, disposed: boolean }} MountRecord
 * @typedef {SlotProvider & { readonly mounted: MountRecord[] }} TestSlotProvider
 */

/** The titles of `viz:23`, in order; the skinlab viz-stub carries the same list (a test pins both to the source). */
export const EFFECTS_TITLES = Object.freeze(['Headspace: Point Cloud', 'Chorus', 'Bars and Waves: Ring', 'Ambience: Warp', 'Scope: Ribbon']);

/** The `mediacenter` pref the effects index lives in (D6.1). */
export const EFFECTS_PREF = Object.freeze({ ns: 'mediacenter', key: 'effectPreset' });

/** @param {number} i @param {number} n */
const wrap = (i, n) => ((i % n) + n) % n;

/** @param {string | undefined} v @param {number} n the stored index, wrapped like the stub viz does; 0 when unusable */
function indexFromPref(v, n) {
  const i = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(i) ? wrap(i, n) : 0;
}

/**
 * The host side of an EFFECTS element. `setIndex` and `step` wrap over the presets and persist to
 * `mediacenter.effectPreset` (as the real VizHost does, W3.7); a change that arrives from the pref
 * store is applied without writing it back.
 * @param {{ titles?: readonly string[], index?: number, persist?: (index: number) => void }} [opts]
 * @returns {EffectsControl & { applyExternal(index: number): void }}
 */
export function createEffectsControl(opts = {}) {
  const titles = opts.titles ?? EFFECTS_TITLES;
  const count = titles.length;
  if (count < 1) throw new RangeError('an effects control needs at least one preset');
  let index = wrap(opts.index ?? 0, count);
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** @param {number} next @param {boolean} persist */
  const set = (next, persist) => {
    if (typeof next !== 'number' || !Number.isFinite(next)) return;
    const i = wrap(Math.trunc(next), count);
    if (i === index) return;
    index = i;
    if (persist) opts.persist?.(index);
    for (const cb of [...listeners]) if (listeners.has(cb)) cb();
  };

  return {
    count,
    get index() { return index; },
    get title() { return titles[index]; },
    titleOf: (i) => (Number.isInteger(i) && i >= 0 && i < count ? titles[i] : ''),
    setIndex: (i) => set(i, true),
    step: (d) => set(index + (d < 0 ? -1 : 1), true),
    click() { set(index + 1, true); },                     // D10.2: a click with no skin onclick steps to the next preset
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    applyExternal: (i) => set(i, false),
  };
}

/**
 * The shared body of every stub slot: an element, a spec, a visibility flag and the rect reporting.
 * @param {HTMLElement} el @param {SlotSpec} spec
 * @param {{ onUpdate?: (spec: SlotSpec) => void, onVisible?: (v: boolean) => void, onDispose?: () => void, effects?: EffectsControl }} [hooks]
 * @returns {SlotHandle & { readonly spec: SlotSpec, readonly visible: boolean }}
 */
function baseHandle(el, spec, hooks = {}) {
  let current = spec;
  let visible = true;
  let disposed = false;
  /** @type {Set<() => void>} */
  const rectListeners = new Set();
  const fire = () => { for (const cb of [...rectListeners]) if (rectListeners.has(cb)) cb(); };

  /** @type {SlotHandle & { readonly spec: SlotSpec, readonly visible: boolean }} */
  const handle = {
    element: el,
    get spec() { return current; },
    get visible() { return visible; },
    update(next) {
      if (disposed) return;
      current = next;
      hooks.onUpdate?.(next);
      fire();
    },
    setVisible(v) {
      if (disposed || visible === !!v) return;
      visible = !!v;
      hooks.onVisible?.(visible);
      fire();
    },
    hitRects: () => (visible && !disposed ? [{ ...current.rect }] : []),
    onHitRectsChange(cb) {
      rectListeners.add(cb);
      return () => { rectListeners.delete(cb); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hooks.onDispose?.();
      rectListeners.clear();
    },
  };
  if (hooks.effects) Object.defineProperty(handle, 'effects', { value: hooks.effects, enumerable: true });
  return handle;
}

/**
 * The black canvas, when the element belongs to a document. Happy-dom and some headless contexts give
 * no 2D context, so that is allowed to be null: the canvas just stays blank, which is black enough for
 * a stub (the oracle's is black too).
 * @param {HTMLElement} el @param {SlotSpec} spec
 * @returns {{ canvas: HTMLCanvasElement, paint(r: Rect): void } | null}
 */
function mountBlackCanvas(el, spec) {
  const doc = el?.ownerDocument;
  if (!doc) return null;
  const canvas = doc.createElement('canvas');
  const paint = (/** @type {Rect} */ r) => {
    canvas.width = Math.max(1, Math.round(r.w));
    canvas.height = Math.max(1, Math.round(r.h));
    canvas.style.display = 'block';
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
    try {
      const g = canvas.getContext('2d');
      if (g) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
    } catch {
      // no 2D context in this environment: leave the canvas blank
    }
  };
  paint(spec.rect);
  canvas.dataset.slot = 'effects';
  el.appendChild(canvas);
  return { canvas, paint };
}

/**
 * @param {SlotOptions} [opts]
 * @returns {TestSlotProvider}
 */
export function createTestSlotProvider(opts = {}) {
  const titles = opts.titles ?? EFFECTS_TITLES;
  /** @type {MountRecord[]} */
  const mounted = [];

  /** @type {TestSlotProvider} */
  const provider = {
    mounted,
    mount(el, spec, win) {
      /** @type {SlotHandle} */
      let handle;
      if (spec.kind === 'effects') {
        const prefs = opts.prefs;
        const control = createEffectsControl({
          titles,
          index: indexFromPref(prefs?.peek(EFFECTS_PREF.ns).get(EFFECTS_PREF.key), titles.length),
          persist: (i) => prefs?.write(EFFECTS_PREF.ns, EFFECTS_PREF.key, String(i)),
        });
        // Another window changing the pref moves this one's index too, without writing it back.
        const unfollow = prefs?.onExternalChange?.(EFFECTS_PREF.ns, (key, value) => {
          if (key === EFFECTS_PREF.key) control.applyExternal(indexFromPref(value ?? undefined, titles.length));
        });
        const black = mountBlackCanvas(el, spec);
        handle = baseHandle(el, spec, {
          effects: control,
          onUpdate: (s) => black?.paint(s.rect),
          onVisible: (v) => { if (black) black.canvas.style.visibility = v ? 'visible' : 'hidden'; },
          onDispose: () => { unfollow?.(); black?.canvas.remove(); },
        });
      } else if (spec.kind === 'playlist') {
        if (!opts.media) throw new Error('the test slot provider needs `media` to mount a playlist');
        // An injected factory owns its handle outright. The placeholder is the only thing that needs the spec.
        handle = opts.playlist ? opts.playlist(el, opts.media, spec.attrs, win) : baseHandle(el, spec);
      } else {
        handle = baseHandle(el, spec);                       // video: inert
      }
      const record = { kind: spec.kind, el, spec, handle, disposed: false };
      mounted.push(record);
      const dispose = handle.dispose.bind(handle);
      handle.dispose = () => { record.disposed = true; dispose(); };
      return handle;
    },
  };
  return provider;
}
