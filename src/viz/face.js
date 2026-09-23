// The relief face: Opus 5's way of drawing a face, as a heightfield. Sums of
// Gaussian bumps and hollows (brow ridge, sockets, eyeballs, nose, cheeks,
// lips) plus a mouth cavity that deepens and stretches as it opens. Shared by
// the Chorus and Breath presets.
//
// p is face space: roughly -1..1, +y up. Expression e:
//   x  mouth open      0 closed .. 1 full scream
//   y  brows raised    0 .. 1
//   z  eyes squeezed   0 .. 1
//   w  fear            inner brow ends tilt up

export const FACE_GLSL = /* glsl */ `
float gs(vec2 p, vec2 c, vec2 s) {
  vec2 d = (p - c) / s;
  return exp(-dot(d, d));
}
float gr(vec2 p, vec2 c, vec2 s, float a) {
  vec2 d = p - c;
  float cs = cos(a), sn = sin(a);
  d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y) / s;
  return exp(-dot(d, d));
}
float faceHeight(vec2 p, vec4 e) {
  float open = e.x, brow = e.y, squeeze = e.z, fear = e.w;
  float h = 0.0;
  float my = -0.40 - open * 0.10;   // the jaw drops as it opens
  float mw = 0.25 + open * 0.03;    // a wide, singing gape
  float mh = 0.025 + open * 0.17;
  for (int i = 0; i < 2; i++) {
    float s = i == 0 ? -1.0 : 1.0;
    float ey = 0.13 + brow * 0.04;
    h += 0.42 * gr(p, vec2(0.30 * s, 0.30 + brow * 0.10 + fear * 0.03), vec2(0.27, 0.075), s * fear * 0.4);
    h -= 0.32 * gs(p, vec2(0.30 * s, ey), vec2(0.17, 0.10 * (1.0 - squeeze * 0.6)));
    h += 0.20 * (1.0 - squeeze) * gs(p, vec2(0.29 * s, ey + 0.01), vec2(0.075, 0.06));
    h -= 0.10 * gs(p, vec2(0.065 * s, -0.17), vec2(0.035, 0.025));
    h += 0.14 * gs(p, vec2(0.40 * s, -0.20), vec2(0.18, 0.16));
  }
  h += 0.30 * gs(p, vec2(0.0, 0.02), vec2(0.075, 0.22));
  h += 0.18 * gs(p, vec2(0.0, -0.12), vec2(0.11, 0.07));
  h += 0.12 * gs(p, vec2(0.0, my + mh + 0.03), vec2(mw * 1.05, 0.045));
  h += 0.10 * gs(p, vec2(0.0, my - mh - 0.035), vec2(mw * 0.95, 0.05));
  h -= (0.22 + open * 0.55) * gs(p, vec2(0.0, my), vec2(mw, mh));
  return h;
}
vec2 faceGrad(vec2 p, vec4 e) {
  const float d = 0.004;
  return vec2(
    faceHeight(p + vec2(d, 0.0), e) - faceHeight(p - vec2(d, 0.0), e),
    faceHeight(p + vec2(0.0, d), e) - faceHeight(p - vec2(0.0, d), e)
  ) / (2.0 * d);
}
`;

/** Ease `x` toward `target` with separate attack and release rates (per second). */
export function follow(x, target, dt, attack, release) {
  const rate = target > x ? attack : release;
  return x + (target - x) * Math.min(1, dt * rate);
}
