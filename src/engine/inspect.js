// @ts-check
// The skin inspector (E §5.10 `SkinInspector`, D10.7): what the demo driver, the shell and the tests may
// ask of an attached view without reaching into the engine. It answers from the model, in view px (the
// skin's own pixel space at zoom 1), with the current animated values, never from the DOM.
//
//   find / rectOf       an element by id or `Unnamed_<kind>_<n>`; its box is the sum of `left`/`top` up
//                       to the VIEW. A BUTTONELEMENT has no box of its own and answers with its group's.
//   groupPoint          a point inside the pixels a BUTTONGROUP's mapping image gives one colour: their
//                       centroid when that pixel is the colour's, else the colour's pixel nearest to it
//                       (a ring-shaped region has its centroid in the hole). The pick at that point is
//                       the element of that colour, which is what a tour clicks.
//   sliderThumbPoint    the thumb centre for a value, by the shared slider geometry
//                       (layout/slider-geometry.js), the same formula a drag inverts; the thumb's
//                       length comes from the image probe.
//   attr / setAttr      through the element's host object, as a script sees it (`eq.gainLevel3` is the
//                       DSP's band, not a model attribute), else the model; writes have origin 'host'.
//   callGlobal / readGlobal   the skin's own functions and globals (S2b, the sidecar's `restore`).
//   stackingDump        the paint order, one line per entry, indented per stacking context.
//
// Refs are skin text: every lookup goes through `ViewModel.byId`, whose indexes are Maps, so
// `__proto__` and `constructor` are ordinary ids.

import { fractionOf, thumbCentre } from './layout/slider-geometry.js';
import { groupElements, originOf } from './shape/scene.js';
import { parseColor } from './wms/values.js';

/** @typedef {import('./contracts').SkinInspector} SkinInspector */
/** @typedef {import('./contracts').ViewModel} ViewModel */
/** @typedef {import('./contracts').ElementModel} ElementModel */
/** @typedef {import('./contracts').ImageService} ImageService */
/** @typedef {import('./contracts').EngineOptions} EngineOptions */
/** @typedef {import('./contracts').HostObject} HostObject */
/** @typedef {import('./contracts').Wire} Wire */
/** @typedef {import('./contracts').Rect} Rect */

/**
 * @typedef {Object} InspectorDeps
 * @property {ViewModel} view
 * @property {ImageService} images
 * @property {Pick<EngineOptions, 'sliderGeometry'>} opts
 * @property {() => HTMLElement} root                     the engine's div.view
 * @property {(el: ElementModel) => HostObject | null} objectOf
 * @property {(name: string, args: Wire[]) => Wire} callGlobal   runs as an entry, drains what it queued
 * @property {(name: string) => Wire} readGlobal
 * @property {(fn: () => void) => void} write             runs `fn` as an entry, drains what it queued
 */

/** @param {unknown} v @param {number} [d] */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** A Wire from an attribute value or a host read: a method marker is not a value. @param {unknown} v @returns {Wire} */
function wireOf(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'string') return /** @type {Wire} */ (v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'object' && typeof (/** @type {{ __h?: unknown }} */ (v)).__h === 'number') return /** @type {{ __h: number }} */ (v);
  return undefined;
}

/**
 * @param {InspectorDeps} d
 * @returns {SkinInspector}
 */
export function createInspector(d) {
  const { view, images, opts } = d;

  /** @param {unknown} ref @returns {ElementModel | null} */
  const element = (ref) => (typeof ref === 'string' ? view.byId(ref) ?? null : null);

  /** @param {ElementModel} el @returns {Rect} */
  function rectOfElement(el) {
    if (el === view.view) return { x: 0, y: 0, w: num(el.get('width')), h: num(el.get('height')) };
    const box = el.kind === 'buttonelement' && el.parent ? el.parent : el;
    const o = originOf(box);
    return { x: o.x, y: o.y, w: num(box.get('width')), h: num(box.get('height')) };
  }

  /** @param {ElementModel} container @param {number} depth @param {string[]} out */
  function dump(container, depth, out) {
    const pad = '  '.repeat(depth);
    for (const entry of view.paintOrder(container)) {
      if (entry === 'background') {
        out.push(`${pad}(background of ${container.id})`);
        continue;
      }
      out.push(`${pad}${entry.kind} ${entry.id} z=${num(entry.get('zindex'))}${entry.get('visible') === false ? ' hidden' : ''}`);
      if (entry.kind === 'subview') dump(entry, depth + 1, out);
    }
  }

  return {
    find(ref) {
      const el = element(ref);
      return el ? { id: el.id, kind: el.kind } : null;
    },

    rectOf(ref) {
      const el = element(ref);
      return el ? rectOfElement(el) : null;
    },

    groupPoint(groupRef, mappingColor) {
      const group = element(groupRef);
      if (!group || group.kind !== 'buttongroup') return null;
      const color = parseColor(String(mappingColor ?? ''));
      if (typeof color !== 'number') return null;
      const ref = str(group.get('mappingimage'));
      const map = ref ? images.raw(ref) : null;
      if (!map) return null;
      // Only colours some BUTTONELEMENT claims are a part of the group (the first claim wins, as the picker's).
      if (!groupElements(group).some((c) => num(c.get('mappingcolor'), -1) === color)) return null;
      const w = Math.min(map.width, Math.max(0, Math.round(num(group.get('width'), map.width))));
      const h = Math.min(map.height, Math.max(0, Math.round(num(group.get('height'), map.height))));
      const data = map.data;
      const target = color & 0xffffff;
      let n = 0;
      let sx = 0;
      let sy = 0;
      /** @param {number} x @param {number} y */
      const owned = (x, y) => {
        const p = (y * map.width + x) * 4;
        return ((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]) === target;
      };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!owned(x, y)) continue;
          n++;
          sx += x + 0.5;
          sy += y + 0.5;
        }
      }
      if (n === 0) return null;
      let cx = sx / n;
      let cy = sy / n;
      if (!owned(Math.floor(cx), Math.floor(cy))) {
        let best = Infinity;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!owned(x, y)) continue;
            const dd = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
            if (dd < best) { best = dd; cx = x + 0.5; cy = y + 0.5; }
          }
        }
        // `best` is finite: n > 0 owned pixels exist.
      }
      const o = originOf(group);
      return { x: o.x + cx, y: o.y + cy };
    },

    sliderThumbPoint(ref, value) {
      const el = element(ref);
      if (!el || (el.kind !== 'slider' && el.kind !== 'progressbar')) return null;
      if (!Number.isFinite(value)) return null;
      const vertical = el.get('direction') === 'vertical';
      const w = num(el.get('width'));
      const h = num(el.get('height'));
      const thumbRef = str(el.get('enabled') === false ? el.get('thumbdisabledimage') || el.get('thumbimage') : el.get('thumbimage'));
      const probe = thumbRef ? images.probe(thumbRef) : null;
      const thumb = probe ? (vertical ? probe.height : probe.width) : 0;
      const axis = { vertical, length: vertical ? h : w, thumb, border: num(el.get('bordersize')), geometry: opts.sliderGeometry };
      const along = thumbCentre(fractionOf(value, num(el.get('min')), num(el.get('max'))), axis);
      const o = originOf(el);
      return vertical ? { x: o.x + w / 2, y: o.y + along } : { x: o.x + along, y: o.y + h / 2 };
    },

    attr(ref, name) {
      const el = element(ref);
      if (!el || typeof name !== 'string') return undefined;
      const obj = d.objectOf(el);
      const v = obj ? wireOf(obj.get(name.toLowerCase())) : undefined;
      if (v !== undefined) return v;
      return wireOf(el.get(name));
    },

    setAttr(ref, name, v) {
      const el = element(ref);
      if (!el || typeof name !== 'string') return;
      d.write(() => {
        const obj = d.objectOf(el);
        if (obj) obj.set(name.toLowerCase(), v, 'host');
        else el.set(name, v, 'host');
      });
    },

    callGlobal(name, args) {
      return d.callGlobal(String(name), Array.isArray(args) ? args : []);
    },

    readGlobal(name) {
      return d.readGlobal(String(name));
    },

    stackingDump() {
      /** @type {string[]} */
      const out = [`view ${view.view.id}`];
      dump(view.view, 1, out);
      return out;
    },

    root() {
      return d.root();
    },
  };
}
