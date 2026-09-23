// Ambience: a domain-warped swirl in the cover's colours. Time runs faster
// when the music is louder; bass swells the vortex, treble adds grain.

import * as THREE from 'three';

const frag = /* glsl */ `
precision highp float;
uniform float uTime, uBass, uMid, uHigh, uBeat;
uniform vec3 uC0, uC1, uC2, uC3;
uniform vec2 uRes;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
vec3 pal(float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  if (t < 1.0) return mix(uC0, uC1, t);
  if (t < 2.0) return mix(uC1, uC2, t - 1.0);
  return mix(uC2, uC3, t - 2.0);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 2.2;
  float r = length(p);
  float a = atan(p.y, p.x);
  // Swirl: angle twists with radius, more with bass.
  a += (1.2 + uBass * 2.5) / (r + 0.35) + uTime * 0.2;
  vec2 q = vec2(cos(a), sin(a)) * r;
  vec2 w = vec2(fbm(q * 1.4 + uTime * 0.15), fbm(q * 1.4 - uTime * 0.12 + 5.2));
  float n = fbm(q * 2.0 + w * (1.5 + uMid * 2.0));
  vec3 col = pal(n * 1.25 - 0.1 + uBeat * 0.15);
  col *= 0.55 + n * 0.9 + uBass * 0.4;
  col += (hash(vUv * uRes + uTime) - 0.5) * uHigh * 0.18;
  col *= smoothstep(1.7, 0.3, r);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Warp {
  title = 'Ambience: Warp';

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.u = {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uBeat: { value: 0 },
      uRes: { value: new THREE.Vector2(216, 158) },
      uC0: { value: new THREE.Color() },
      uC1: { value: new THREE.Color() },
      uC2: { value: new THREE.Color() },
      uC3: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: frag,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  }

  enter() {}

  update(dt, viz) {
    const a = viz.audio;
    const s = (x, v) => x + (v - x) * Math.min(1, dt * 8);
    this.u.uTime.value += dt * (0.35 + a.level * 6);
    this.u.uBass.value = s(this.u.uBass.value, a.bass);
    this.u.uMid.value = s(this.u.uMid.value, a.mid);
    this.u.uHigh.value = s(this.u.uHigh.value, a.high);
    this.u.uBeat.value = a.beat;
    viz.palette.colors.forEach((c, i) => this.u[`uC${i}`].value.copy(c));
  }
}
