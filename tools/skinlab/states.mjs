// The legacy-side parity states of E D9, as data. Both targets reach a state through the same real
// mouse clicks in skin coordinates; the engine side (W2.7) reuses POINTS, PARK and the settle rules.
//
// S2b is engine-only (inspector.callGlobal('ToggleEqView')) and S5 (hover/press every element) gets
// its points at G2 from regions.mjs, so neither is listed here. S8 is manual, in-app.

import { hasMediaPreset } from './media-presets.js';

/** Viewport is 760x394 plus margin so the parked pointer and the clip never touch a scrollbar. */
export const SKIN_SIZE = Object.freeze({ width: 760, height: 394 });
export const VIEWPORT = Object.freeze({ width: 800, height: 440 });
export const CLIP = Object.freeze({ x: 0, y: 0, ...SKIN_SIZE });
export const DPRS = Object.freeze([1, 2]);

/** A transparent pixel in every state: bottom-right corner of the 760x394 skin. */
export const PARK = Object.freeze({ x: 755, y: 390 });

/** Centres of the elements to click, in skin px (parity 0.5: EQ handle (215,152) 18x66, PL handle
 *  (523,151) 18x67, transport vis element inside the group at (309,31)). */
export const POINTS = Object.freeze({
  eqHandle: Object.freeze({ x: 224, y: 185 }),
  plHandle: Object.freeze({ x: 532, y: 184 }),
  visElement: Object.freeze({ x: 440, y: 44 }),
});

/** Settle rules (E D9): wait for the animation's transitionend where the state animates, then
 *  200 ms, then two rAF. The 5 s cap turns a missing transitionend into a failure, not a hang. */
export const SETTLE = Object.freeze({ afterMs: 200, rafs: 2, transitionTimeoutMs: 5000 });

/** The legacy boots with a 300 ms timer that refreshes the mask (main.js:587); wait it out. */
export const BOOT_QUIET_MS = 450;

const earLeft = Object.freeze({ kind: 'transition', selector: '.ear', property: 'left' });

/**
 * id -> state. A Map, so a command-line id of `__proto__` or `constructor` is just "unknown".
 * `steps` are real clicks; `settle` says what to wait for after them.
 * `reportOnly` states are captured and printed but never fail verify-legacy.
 */
export const STATES = new Map(
  [
    { id: 'S1', title: 'closed', media: 'stoppedEmpty', steps: [], settle: { kind: 'none' } },
    {
      id: 'S2',
      title: 'EQ open',
      media: 'stoppedEmpty',
      steps: [{ click: 'eqHandle' }],
      settle: earLeft,
    },
    {
      id: 'S3',
      title: 'PL open (5 rows)',
      media: 'stoppedQueue5',
      steps: [{ click: 'plHandle' }],
      settle: earLeft,
    },
    {
      id: 'S3b',
      title: 'PL open (12 rows, Win2000 scrollbar)',
      media: 'stoppedQueue12',
      steps: [{ click: 'plHandle' }],
      settle: earLeft,
    },
    {
      id: 'S4',
      title: 'vis chooser open',
      media: 'stoppedEmpty',
      steps: [{ click: 'visElement' }],
      settle: { kind: 'transition', selector: '#visDrop', property: 'top' },
    },
    { id: 'S6', title: 'playing', media: 'playing', steps: [], settle: { kind: 'none' } },
    {
      // "60 ms after the EQ click" cannot be taken in real time (a screenshot alone takes longer), so
      // the transition is paused at 60 ms the moment it is created. Linear easing puts the ear at
      // x = 103.5 (E Appendix A: about 103). Report-only: the engine's manual clock reaches 60 ms
      // differently and the gate does not depend on it.
      id: 'S7',
      title: 'EQ mid-animation (60 ms)',
      media: 'stoppedEmpty',
      steps: [{ click: 'eqHandle' }],
      settle: { ...earLeft, kind: 'freeze', atMs: 60 },
      reportOnly: true,
    },
  ].map((s) => [s.id, Object.freeze({ reportOnly: false, ...s })]),
);

export const DEFAULT_STATE_IDS = Object.freeze([...STATES.keys()]);

/**
 * `parity 4.1`'s offline emulation of updateMask, for comparison only (open question 9: the live
 * oracle wins, and G0 records the live numbers). States without an entry have no reference.
 */
export const EMULATED_MASKS = new Map([
  ['S1', { popcount: 89328, bbox: { x0: 207, y0: 0, x1: 548, y1: 393 }, bitsSha1Prefix: '2967a5af0753' }],
  ['S2', { popcount: 122636, bbox: { x0: 0, y0: 0, x1: 548, y1: 393 }, bitsSha1Prefix: 'd9ba9bcf042b' }],
  ['S3', { popcount: 123258, bbox: { x0: 207, y0: 0, x1: 759, y1: 393 }, bitsSha1Prefix: '7bd9a1a5df99' }],
  ['S4', { popcount: 89328, bbox: { x0: 207, y0: 0, x1: 548, y1: 393 }, bitsSha1Prefix: '2967a5af0753' }],
]);

/** Parse `--states S1,S2`. Unknown ids are a usage error, never a lookup into Object.prototype. */
export function parseStateIds(list) {
  if (list === undefined || list === null || list === '') return [...DEFAULT_STATE_IDS];
  const ids = String(list)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('--states is empty');
  const seen = new Set();
  for (const id of ids) {
    if (!STATES.has(id)) throw new Error(`unknown state "${id}" (known: ${DEFAULT_STATE_IDS.join(', ')})`);
    seen.add(id);
  }
  return DEFAULT_STATE_IDS.filter((id) => seen.has(id));
}

/** Parse `--dpr 1,2`. */
export function parseDprs(list) {
  if (list === undefined || list === null || list === '') return [...DPRS];
  const out = [];
  for (const part of String(list).split(',')) {
    const n = Number(part.trim());
    if (!DPRS.includes(n)) throw new Error(`unsupported dpr "${part}" (known: ${DPRS.join(', ')})`);
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

// Fail at import time, not in the middle of a capture, if the table references something missing.
for (const s of STATES.values()) {
  if (!hasMediaPreset(s.media)) throw new Error(`state ${s.id}: unknown media preset ${s.media}`);
  for (const step of s.steps) if (!Object.hasOwn(POINTS, step.click)) throw new Error(`state ${s.id}: unknown point ${step.click}`);
}
