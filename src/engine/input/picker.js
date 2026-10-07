// @ts-check
// The picker (E §5.11 `pick`; E D2 "Picker" and "Hit planes"): which element takes a press at one point
// of the view, and in what role. Pure; it reads the model and the image service and holds no state.
//
// Coordinates. `x` and `y` are view px, the skin's own pixel space; the dispatcher has already divided
// the pointer's client position by the zoom. A fractional position is fine: the pixel under it is the
// floor, and `local` keeps the fraction.
//
// The walk. Native child windows (PLAYLIST and its kin) come first, whatever their z: they always
// paint above windowless controls and ignore clipping (spec 2.8). Then the VIEW is walked top-down in
// the paint order the model gives (`ViewModel.paintOrder`: z relative to the container, source order
// within a z, the container's own background at (0, 0)), reversed, and the first element with its
// `hit` bit set at the point wins. Subtrees are pruned as the walk goes down:
//   - `visible=false` skips the element and everything under it;
//   - a point outside a sized SUBVIEW's box (when `subviewClip` is on) skips that SUBVIEW and its
//     subtree, and so does a point the SUBVIEW's clip mask hides;
//   - `passThrough` removes the element's own pixels but not its children's, SUBVIEW or control (U-7:
//     a pass-through grouping layer must not strand its buttons).
//
// Which pixels hit is the D2 table, read from the keyed bit planes in `shape/scene.js`: opaque and
// partly opaque pixels do; keyed ones only for a BUTTON, an owned BUTTONGROUP pixel or a slider thumb
// when `buttonKeyedPixelsHit` says so; a VIEW/SUBVIEW background never takes its keyed pixels, so the
// click passes to what is below; clipped pixels never; unowned BUTTONGROUP pixels never; a BUTTON with
// no image takes its box; TEXT its box; CUSTOMSLIDER the grey pixels of its map.
//
// What comes back (`Pick`):
//   el     the element that takes the press. For a BUTTONGROUP it is the BUTTONELEMENT whose colour owns
//          the pixel (clicks "go to this element", spec 6.6): its handlers, `enabled` and tooltips are
//          the ones that apply, and "down and up on the same element" compares it directly.
//   part   that BUTTONELEMENT's index in its group (its `index` attribute); null for everything else.
//   local  the point relative to the element's top-left (the group's, for a BUTTONELEMENT).
//   role   control  buttons, group elements, sliders with a thumb, CUSTOMSLIDERs, anything with a mouse
//                   handler: the gesture goes to the skin;
//          blocked  the same, but `enabled=false`: the press is swallowed (no events, no drag);
//          effects  an EFFECTS slot: the host's click action unless the skin has an `onclick`;
//          widget   a native child control: it takes its own DOM events;
//          chrome   any other painted pixel: a real left press drags the frame (U-11).
// A point no element claims, or one outside the VIEW, picks nothing (null).

import {
  HIT, WINDOWED_KINDS, claimsOf, containerInfo, createScene, groupElements, isInteractive, isPassThrough,
  isVisible, num, originOf, windowedLayer,
} from '../shape/scene.js';

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').Pick} Pick */
/** @typedef {import('../contracts').PickRole} PickRole */
/** @typedef {import('../shape/scene.js').Scene} Scene */
/** @typedef {import('../shape/scene.js').Claim} Claim */
/** @typedef {import('../shape/scene.js').ContainerInfo} ContainerInfo */

/** Kinds whose claims never leave their width x height box, so a point outside it is a quick miss. */
const BOXED_KINDS = new Set(['button', 'buttongroup', 'slider', 'progressbar']);

/** @param {Claim} c @param {number} px @param {number} py */
const inRect = (c, px, py) => px >= c.x && py >= c.y && px < c.x + c.w && py < c.y + c.h;

/** @param {Claim[]} claims @param {number} px @param {number} py */
const takesHit = (claims, px, py) => {
  for (const c of claims) if (inRect(c, px, py) && (c.at(px, py) & HIT) !== 0) return true;
  return false;
};

/** The role of a press on an element other than a group's. @param {ElementModel} el @returns {PickRole} */
function roleOf(el) {
  const disabled = el.get('enabled') === false;
  if (el.kind === 'effects') return disabled ? 'blocked' : 'effects';
  if (WINDOWED_KINDS.has(el.kind)) return 'widget';
  if (isInteractive(el)) return disabled ? 'blocked' : 'control';
  return 'chrome';
}

/**
 * One container, from the top: its children in reverse paint order, its own background where the paint
 * order puts it. The caller has already tested the point against this container's box and clip mask.
 * @param {Scene} scene @param {ElementModel} container @param {number} ox @param {number} oy
 * @param {ContainerInfo} info @param {number} x @param {number} y @param {number} px @param {number} py
 * @returns {Pick | null}
 */
function pickIn(scene, container, ox, oy, info, x, y, px, py) {
  const order = scene.view.paintOrder(container);
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = order[i];
    if (entry === 'background') {
      if (isPassThrough(container) || !takesHit(info.claims, px, py)) continue;
      return { el: container, part: null, role: roleOf(container), local: { x: x - ox, y: y - oy } };
    }

    const el = entry;
    if (!isVisible(el) || WINDOWED_KINDS.has(el.kind)) continue;
    const ex = ox + num(el.get('left'));
    const ey = oy + num(el.get('top'));

    if (el.kind === 'subview') {
      // A sized SUBVIEW that does not hold the point is out before its background is even looked up.
      const w = num(el.get('width'));
      const h = num(el.get('height'));
      if (scene.opts.subviewClip && w > 0 && h > 0 && (px < ex || py < ey || px >= ex + w || py >= ey + h)) continue;
      const sub = containerInfo(scene, el, ex, ey);
      const b = sub.box;
      if (b && (px < b.x || py < b.y || px >= b.x + b.w || py >= b.y + b.h)) continue;
      if (sub.clipAt && sub.clipAt(px, py)) continue;
      const found = pickIn(scene, el, ex, ey, sub, x, y, px, py);
      if (found) return found;
      continue;
    }

    if (isPassThrough(el)) continue;
    if (BOXED_KINDS.has(el.kind)) {
      const w = num(el.get('width'));
      const h = num(el.get('height'));
      if (w > 0 && h > 0 && (px < ex || py < ey || px >= ex + w || py >= ey + h)) continue;
    }

    for (const c of claimsOf(scene, el, ex, ey)) {
      if (!inRect(c, px, py) || (c.at(px, py) & HIT) === 0) continue;
      const local = { x: x - ex, y: y - ey };
      if (el.kind !== 'buttongroup') return { el, part: null, role: roleOf(el), local };
      const index = c.partAt ? c.partAt(px, py) : -1;
      const target = groupElements(el)[index];
      if (!target) continue; // a hit with no owner cannot happen for a group, but never invent one
      const disabled = el.get('enabled') === false || target.get('enabled') === false;
      return { el: target, part: index, role: disabled ? 'blocked' : 'control', local };
    }
  }
  return null;
}

/** @type {import('../contracts').PickFn} */
export const pick = (view, images, slotRects, x, y, opts) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const scene = createScene(view, images, slotRects, opts);
  if (x < 0 || y < 0 || x >= scene.width || y >= scene.height) return null;
  const px = Math.floor(x);
  const py = Math.floor(y);

  // Native child windows sit above everything the frame draws, later in the source on top.
  const top = windowedLayer(scene);
  for (let i = top.length - 1; i >= 0; i--) {
    const { el, claims } = top[i];
    if (!takesHit(claims, px, py)) continue;
    const o = originOf(el);
    return { el, part: null, role: 'widget', local: { x: x - o.x, y: y - o.y } };
  }

  const root = view.view;
  const info = containerInfo(scene, root, 0, 0);
  if (info.clipAt && info.clipAt(px, py)) return null;
  return pickIn(scene, root, 0, 0, info, x, y, px, py);
};
