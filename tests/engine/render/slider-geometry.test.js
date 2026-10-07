// @ts-check
// Thumb geometry (E D2 SLIDER row; parity D32, D31; spec 6.7, U-10): the oracle's numbers, the docs'
// reading, the pointer inverse, the reveal edge and the CUSTOMSLIDER frame.
import { describe, expect, it } from 'vitest';
import { centreRange, fractionAt, fractionOf, revealEdge, stripFrame, thumbCentre, thumbEdge, valueAt } from '../../../src/engine/render/dom/slider-geometry.js';

const oracle = (o) => ({ vertical: false, border: 0, geometry: /** @type {const} */ ('oracle'), ...o });
const docs = (o) => ({ vertical: false, border: 0, geometry: /** @type {const} */ ('docs'), ...o });

describe('fractionOf', () => {
  it('is the 0..1 position of a value, clamped; an empty or invalid range is 0', () => {
    expect(fractionOf(50, 0, 100)).toBe(0.5);
    expect(fractionOf(-4, 0, 100)).toBe(0);
    expect(fractionOf(400, 0, 100)).toBe(1);
    expect(fractionOf(5, 3, 3)).toBe(0);
    expect(fractionOf(Number.NaN, 0, 100)).toBe(0);
    expect(fractionOf(0, -100, 100)).toBe(0.5);
  });

  it('follows a reversed range (min above max, seen in the corpus)', () => {
    expect(fractionOf(75, 100, 0)).toBe(0.25);
  });
});

describe('oracle geometry: travel is length - thumb for every slider (parity D32)', () => {
  it('the horizontal EQ-style slider: 71 long, 9 thumb, travel 62', () => {
    const a = oracle({ length: 71, thumb: 9 });
    expect(thumbEdge(0, a)).toBe(0);
    expect(thumbEdge(1, a)).toBe(62);
    expect(thumbEdge(0.5, a)).toBe(31);
  });

  it('the vertical slider: 76 long, 11 thumb, travel 65, maximum at the top', () => {
    const a = oracle({ length: 76, thumb: 11, vertical: true });
    expect(thumbEdge(1, a)).toBe(0);
    expect(thumbEdge(0, a)).toBe(65);
    expect(thumbEdge(0.5, a)).toBe(33); // Math.round(32.5), as the oracle (parity 4.1)
    expect(thumbCentre(0.5, a)).toBe(38);
  });

  it('the seek bar: 163 long, 18 thumb, travel 145; the demo\'s unrounded centre is 5.5 + (1 - f) * 65', () => {
    expect(thumbEdge(1, oracle({ length: 163, thumb: 18 }))).toBe(145);
    const v = oracle({ length: 76, thumb: 11, vertical: true });
    for (const f of [0, 0.25, 0.5, 1]) expect(thumbCentre(f, v)).toBeCloseTo(5.5 + (1 - f) * 65, 10);
  });

  it('a thumb longer than the track pins to 0', () => {
    expect(thumbEdge(1, oracle({ length: 5, thumb: 9 }))).toBe(0);
  });

  it('borderSize does not move the oracle thumb', () => {
    expect(thumbEdge(1, oracle({ length: 71, thumb: 9, border: 7 }))).toBe(62);
  });
});

describe('docs geometry: the thumb centre runs over [b, L - b]', () => {
  it('horizontal: 71 long, borderSize 7, thumb 9 (centre over [7, 64], travel 57)', () => {
    const a = docs({ length: 71, thumb: 9, border: 7 });
    expect(centreRange(a)).toEqual({ lo: 7, hi: 64 });
    expect(thumbEdge(0, a)).toBe(Math.round(7 - 4.5)); // 3: round(2.5)
    expect(thumbEdge(1, a)).toBe(Math.round(64 - 4.5)); // 60: round(59.5)
  });

  it('vertical: 76 long, borderSize 7, thumb 11 (centre over [7, 69], travel 62)', () => {
    const a = docs({ length: 76, thumb: 11, border: 7, vertical: true });
    expect(centreRange(a)).toEqual({ lo: 7, hi: 69 });
    expect(thumbCentre(1, a)).toBe(7);
    expect(thumbCentre(0, a)).toBe(69);
  });

  it('a border over half the track is clamped to half', () => {
    expect(centreRange(docs({ length: 20, thumb: 4, border: 99 }))).toEqual({ lo: 10, hi: 10 });
  });

  it('agrees with the oracle on the seek bar, where borderSize is half the thumb', () => {
    const seek = { length: 163, thumb: 18, border: 9 };
    for (const f of [0, 0.3, 0.5, 1]) expect(thumbEdge(f, docs(seek))).toBe(thumbEdge(f, oracle(seek)));
  });
});

describe('pointer to value', () => {
  it('fractionAt inverts thumbCentre, for both geometries and both axes', () => {
    for (const a of [oracle({ length: 71, thumb: 9 }), docs({ length: 71, thumb: 9, border: 7 }), oracle({ length: 76, thumb: 11, vertical: true }), docs({ length: 76, thumb: 11, border: 7, vertical: true })]) {
      for (const f of [0, 0.1, 0.5, 0.9, 1]) expect(fractionAt(thumbCentre(f, a), a)).toBeCloseTo(f, 10);
    }
  });

  it('clamps outside the track', () => {
    const a = oracle({ length: 71, thumb: 9 });
    expect(fractionAt(-50, a)).toBe(0);
    expect(fractionAt(500, a)).toBe(1);
    expect(fractionAt(5, oracle({ length: 9, thumb: 9 }))).toBe(0);
  });

  it('valueAt is continuous (parity D31): the EQ range -14..14 at the demo\'s thumb centre', () => {
    const a = oracle({ length: 76, thumb: 11, vertical: true });
    expect(valueAt(5.5 + (1 - 0.25) * 65, a, -14, 14)).toBeCloseTo(-7, 10);
    expect(valueAt(5.5, a, -14, 14)).toBe(14);
  });
});

describe('revealEdge', () => {
  const a = oracle({ length: 163, thumb: 18 });
  const playhead = { mode: /** @type {const} */ ('playhead'), useProgress: false, progress: 0 };

  it('follows the thumb centre: round(f * travel + t / 2) (widgets:263)', () => {
    expect(revealEdge(0, a, playhead)).toBe(9);
    expect(revealEdge(1, a, playhead)).toBe(154);
    expect(revealEdge(0.5, a, playhead)).toBe(Math.round(0.5 * 145 + 9));
  });

  it('follows foregroundProgress percent of the track when it is used and the mode is progress (parity D2)', () => {
    const p = { mode: /** @type {const} */ ('progress'), useProgress: true, progress: 50 };
    expect(revealEdge(0, a, p)).toBe(Math.round(163 / 2));
    expect(revealEdge(1, a, { ...p, progress: 100 })).toBe(163);
    expect(revealEdge(1, a, { ...p, progress: 400 })).toBe(163);
    expect(revealEdge(1, a, { ...p, progress: -5 })).toBe(0);
  });

  it('the host-only playhead mode ignores foregroundProgress; progress without useForegroundProgress is the playhead', () => {
    expect(revealEdge(0.5, a, { mode: 'playhead', useProgress: true, progress: 100 })).toBe(revealEdge(0.5, a, playhead));
    expect(revealEdge(0.5, a, { mode: 'progress', useProgress: false, progress: 100 })).toBe(revealEdge(0.5, a, playhead));
  });
});

describe('stripFrame', () => {
  it('is round(f * (N - 1)) and 0 for a single frame', () => {
    expect([0, 0.25, 0.5, 0.75, 1].map((f) => stripFrame(f, 3))).toEqual([0, 1, 1, 2, 2]);
    expect(stripFrame(1, 1)).toBe(0);
    expect(stripFrame(0.9, 0)).toBe(0);
    expect(stripFrame(2, 5)).toBe(4);
    expect(stripFrame(-1, 5)).toBe(0);
  });
});
