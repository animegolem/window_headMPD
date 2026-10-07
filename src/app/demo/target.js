// @ts-check
// DemoTarget (ENGINE.md D10.7): everything the demo tour may ask of the app it is touring, built from a
// `SkinInspector`. The driver and the choreography see only this, so neither knows whether the skin
// came from the engine, the test host or, one day, another skin family.
//
// The inspector speaks view px (the skin's own pixel space at zoom 1). The tour moves a cursor in
// client px, so this is where the two meet: a point is `root.left + x * zoom`, with `root` the
// engine's div.view, whose transform origin is its top-left corner.

/** @typedef {import('../../engine/contracts').SkinInspector} SkinInspector */
/** @typedef {import('../../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../../engine/contracts').EffectsControl} EffectsControl */
/** @typedef {import('../../engine/contracts').Wire} Wire */
/** @typedef {{ x: number, y: number }} Point client px */

/**
 * @typedef {object} DemoTarget
 * @property {() => HTMLElement} root       the engine's div.view (the scale transform's origin)
 * @property {() => number} zoom
 * @property {(ref: string, fx?: number, fy?: number) => Point | null} clientPoint
 *   a point inside an element, as fractions of its rect (the centre by default); null for an unknown ref
 * @property {(groupRef: string, mappingColor: string) => Point | null} groupPoint
 *   the centroid of the pixels a BUTTONGROUP maps to that colour
 * @property {(ref: string, value: number) => Point | null} sliderThumbPoint
 *   where the thumb sits for a value, in the slider's own units
 * @property {(fn: string, ...args: Wire[]) => Wire} call   call a script global
 * @property {(name: string) => Wire} get                    read a script global
 * @property {(ref: string, name: string) => Wire} attr
 * @property {(ref: string, name: string, v: Wire) => void} setAttr
 * @property {MediaModel} media
 * @property {EffectsControl} effects
 */

/**
 * @param {{ inspector: SkinInspector, media: MediaModel, effects: EffectsControl, zoom: () => number }} parts
 *   `zoom` is the live zoom of the window the skin is in (`SkinWindow.zoom`)
 * @returns {DemoTarget}
 */
export function createDemoTarget({ inspector, media, effects, zoom }) {
  /** @returns {number} a usable scale, never 0 or NaN */
  const scale = () => {
    const z = zoom();
    return Number.isFinite(z) && z > 0 ? z : 1;
  };

  /** View px to client px. @param {{ x: number, y: number } | null} p @returns {Point | null} */
  const toClient = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const box = inspector.root().getBoundingClientRect();
    return { x: box.left + p.x * scale(), y: box.top + p.y * scale() };
  };

  return {
    root: () => inspector.root(),
    zoom: scale,
    clientPoint(ref, fx = 0.5, fy = 0.5) {
      const r = inspector.rectOf(ref);
      return r ? toClient({ x: r.x + r.w * fx, y: r.y + r.h * fy }) : null;
    },
    groupPoint: (groupRef, mappingColor) => toClient(inspector.groupPoint(groupRef, mappingColor)),
    sliderThumbPoint: (ref, value) => toClient(inspector.sliderThumbPoint(ref, value)),
    call: (fn, ...args) => inspector.callGlobal(fn, args),
    get: (name) => inspector.readGlobal(name),
    attr: (ref, name) => inspector.attr(ref, name),
    setAttr: (ref, name, v) => inspector.setAttr(ref, name, v),
    media,
    effects,
  };
}
