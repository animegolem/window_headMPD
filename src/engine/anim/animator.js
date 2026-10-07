// @ts-check
// The animator (E §5.11 `createAnimator`; E D2 "Animation"; spec 5.2; U-25): the one object that
// steps every `moveTo`, `slideTo`, `moveSizeTo` and `alphaBlendTo` tween of a view on the engine
// clock. The object model hands it targets (`model/objects/element.js`); the view runtime calls
// `frame(now)` once per frame, before bindings and the renderer (E §3.2), so this module never
// subscribes to the clock itself. It reads `clock.now()` only to stamp the moment a tween began.
//
//  - Two channels per element. A move tween drives `left`/`top` (and `width`/`height` for
//    `moveSizeTo`), a blend tween drives `alphaBlend`. A new call replaces only its own channel,
//    so a script may slide a drawer while fading it. `cancel(el)` stops both.
//  - A tween starts from the element's current model value, read when the call is made. That is
//    what makes a retarget and a reversed move continue from where the element is, not from where
//    the old tween was heading.
//  - Every write is an integer through `ElementModel.set(..., 'anim')`, so the model applies its
//    usual rules (dirty marks, `<attr>_onchange` queueing, change-only) and the renderer applies
//    only what changed. The final frame writes the exact target, not the interpolated value.
//  - Completion is reported through `fire`, after every write of that frame, in the order the
//    tweens were started. The finished tween is already gone when `fire` runs, so a callback that
//    starts the next move sees a clean state. A tween that is replaced or cancelled never fires:
//    only the replacement does, at its own end (parity 3.7; Headspace hides a drawer in
//    `onEndMove`, so a drawer that is toggled twice quickly must report once).
//  - A move to where the element already is still runs for its full duration and still fires.
//    Headspace replays its drawer toggles at boot and skins hide a drawer in `onEndMove`, so
//    skipping the no-op would lose the event.
//  - A zero-length tween is written, and fires, on the next `frame`, never inside the call: the
//    call comes from a script entry and `fire` must not run under it.
//
// Rounding: an interpolated value is `Math.round`ed, so a half goes up (a 207 px move is 103.5 px
// at its midpoint and is written as 104). The model's own `int` coercion rounds halves to even,
// but a tween only ever hands it integers, so the two rules never meet.
//
// The easing of `slideTo` and `moveSizeTo(..., true)` is a cubic ease-in-out. It is not CSS's
// `ease-in-out` bezier on purpose: the docs only say "accelerates from zero then decelerates to
// zero" (U-25), and a polynomial is exact on any clock.

/** @typedef {import('../contracts').ElementModel} ElementModel */
/** @typedef {import('../contracts').Animator} Animator */

/** @typedef {{ attr: string, from: number, to: number }} Track */
/**
 * @typedef {Object} Tween
 * @property {ElementModel} el
 * @property {'onendmove' | 'onendalphablend'} event
 * @property {number} start       engine time the call was made, ms
 * @property {number} duration    ms, finite and >= 0
 * @property {(p: number) => number} ease   maps 0..1 to 0..1
 * @property {Track[]} tracks
 */

/** @param {number} p */
const linear = (p) => p;

/** Cubic ease-in-out: 4p^3 up to the middle, then the mirror image. 0.0625 / 0.5 / 0.9375 at 25 / 50 / 75 %. @param {number} p */
const inOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - ((2 - 2 * p) ** 3) / 2);

/** An integer, never -0 (the model would see `-0` as a change from `0`). @param {number} n */
const toInt = (n) => {
  const r = Math.round(n);
  return r === 0 ? 0 : r;
};

/** The attribute as a finite number; an attribute the kind lacks reads as 0. @param {ElementModel} el @param {string} attr */
const numberOf = (el, attr) => {
  const v = el.get(attr);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** A duration: a negative time is a zero-length tween. @param {number} n */
const nonNegative = (n) => (n > 0 ? n : 0);

/**
 * @type {import('../contracts').CreateAnimatorFn}
 */
export const createAnimator = (clock, fire) => {
  /** Running tweens in the order they were started: the order they step and fire in. @type {Set<Tween>} */
  const order = new Set();
  /** @type {Map<ElementModel, Tween>} */
  const moves = new Map();
  /** @type {Map<ElementModel, Tween>} */
  const blends = new Map();

  /** @param {Tween} tw */
  const drop = (tw) => {
    order.delete(tw);
    const channel = tw.event === 'onendmove' ? moves : blends;
    if (channel.get(tw.el) === tw) channel.delete(tw.el);
  };

  /** Make `tw` the element's tween on its channel, dropping the one it replaces without firing. @param {Tween} tw */
  const install = (tw) => {
    const channel = tw.event === 'onendmove' ? moves : blends;
    const old = channel.get(tw.el);
    if (old) drop(old);
    channel.set(tw.el, tw);
    order.add(tw);
  };

  /** @type {Animator} */
  const animator = {
    moveTo(el, x, y, ms, ease, w, h) {
      if (![x, y, ms].every(Number.isFinite)) return;
      if ((w !== undefined && !Number.isFinite(w)) || (h !== undefined && !Number.isFinite(h))) return;
      /** @type {Track[]} */
      const tracks = [
        { attr: 'left', from: numberOf(el, 'left'), to: toInt(x) },
        { attr: 'top', from: numberOf(el, 'top'), to: toInt(y) },
      ];
      if (w !== undefined) tracks.push({ attr: 'width', from: numberOf(el, 'width'), to: toInt(w) });
      if (h !== undefined) tracks.push({ attr: 'height', from: numberOf(el, 'height'), to: toInt(h) });
      install({ el, event: 'onendmove', start: clock.now(), duration: nonNegative(ms), ease: ease === 'inout' ? inOutCubic : linear, tracks });
    },

    alphaBlendTo(el, a, ms) {
      if (!Number.isFinite(a) || !Number.isFinite(ms)) return;
      const to = toInt(Math.min(255, Math.max(0, a)));
      install({ el, event: 'onendalphablend', start: clock.now(), duration: nonNegative(ms), ease: linear,
        tracks: [{ attr: 'alphablend', from: numberOf(el, 'alphablend'), to }] });
    },

    cancel(el) {
      const move = moves.get(el);
      if (move) drop(move);
      const blend = blends.get(el);
      if (blend) drop(blend);
    },

    frame(now) {
      if (!Number.isFinite(now) || order.size === 0) return;
      /** @type {Tween[]} */
      const finished = [];
      // A snapshot, and a membership check per tween: a model listener that runs during a write
      // may start or cancel tweens, and a cancelled tween must neither write again nor fire.
      for (const tw of [...order]) {
        if (!order.has(tw)) continue;
        const p = tw.duration === 0 ? 1 : Math.min(1, Math.max(0, (now - tw.start) / tw.duration));
        const eased = p >= 1 ? 1 : tw.ease(p);
        for (const t of tw.tracks) {
          if (!order.has(tw)) break;
          tw.el.set(t.attr, p >= 1 ? t.to : toInt(t.from + (t.to - t.from) * eased), 'anim');
        }
        if (p >= 1 && order.has(tw)) {
          drop(tw);
          finished.push(tw);
        }
      }
      // Every callback runs even when one throws: the tweens are already gone, so the only thing a
      // skipped call would lose is its event. The first error is rethrown once all have fired.
      /** @type {{ error: unknown } | null} */
      let failure = null;
      for (const tw of finished) {
        try {
          fire(tw.el, tw.event);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    },

    running: () => order.size,
  };
  return animator;
};
