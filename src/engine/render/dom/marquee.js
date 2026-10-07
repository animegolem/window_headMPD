// @ts-check
// TEXT `scrolling` (spec 6.10): `scrollingAmount` px every `scrollingDelay` ms, two spaces between the
// end of the text and its repeat, stepped on the engine clock so a test that advances the manual
// clock sees exactly the steps the real one would draw (no CSS animation: those ignore the injected
// clock, E D2). Pure: the text module measures, this module counts.

/** Defaults and the floor of the delay (spec 6.10: below 30 ms means the default). */
export const DEFAULT_AMOUNT = 6;
export const DEFAULT_DELAY = 85;
export const MIN_DELAY = 30;

/** The two characters between the end of the text and its repeat (non-breaking, so they survive `white-space: pre`). */
export const GAP = '  ';

/**
 * The step size and period actually used for the attributes a skin wrote.
 * @param {unknown} amount @param {unknown} delay
 * @returns {{ amount: number, delay: number }}
 */
export function marqueeParams(amount, delay) {
  const a = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : DEFAULT_AMOUNT;
  const d = typeof delay === 'number' && Number.isFinite(delay) && delay >= MIN_DELAY ? Math.trunc(delay) : DEFAULT_DELAY;
  return { amount: a || DEFAULT_AMOUNT, delay: d };
}

/**
 * The `text-indent` in px for a point in time. `cycle` is the width of the text plus its gap, the
 * distance after which the picture repeats. Left (the default) moves the text right to left.
 * @param {{ elapsed: number, amount: number, delay: number, cycle: number, direction: 'Left' | 'Right' }} o
 * @returns {number}
 */
export function marqueeIndent(o) {
  if (!(o.cycle > 0) || !(o.elapsed > 0)) return 0;
  const steps = Math.floor(o.elapsed / o.delay);
  const raw = (steps * o.amount) % o.cycle;
  if (raw === 0) return 0;
  return o.direction === 'Right' ? raw - o.cycle : -raw;
}
