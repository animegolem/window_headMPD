// Chorus: seven glossy relief faces in a ring, each singing its own slice of
// the spectrum. A face's mouth opens when its band rises above its own recent
// average, so they trade lines like a choir instead of all gaping at once;
// when the whole mix surges, everybody sings. Singers go pale and bright.
// Behind the ring the Breath face waits, a shade off the background,
// breathing; hold the surge at the song's peak and it brightens and screams.

import * as THREE from 'three';
import { FACE_GLSL, follow } from './face.js';
import { reliefTile, scream } from './breath.js';

const COLORS = ['#a24f2b', '#8f8d28', '#2f8f33', '#2a8f86', '#2d5a9e', '#6a3a9e', '#9c3a80'];
const N = COLORS.length;

const vert = /* glsl */ `
varying vec3 vObjN, vN, vT, vB, vPos;
void main() {
  vObjN = normal;
  vN = normalMatrix * normal;
  vT = normalMatrix * vec3(1.0, 0.0, 0.0);
  vB = normalMatrix * vec3(0.0, 1.0, 0.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform vec4 uExpr;
uniform float uGlow;
varying vec3 vObjN, vN, vT, vB, vPos;
${FACE_GLSL}
void main() {
  vec3 on = normalize(vObjN);
  vec2 p = on.xy / 1.0;
  float mask = smoothstep(1.0, 0.85, length(p)) * smoothstep(0.05, 0.35, on.z);
  float h = faceHeight(p, uExpr) * mask;
  vec2 g = faceGrad(p, uExpr) * mask;
  vec3 n = normalize(normalize(vN) - (g.x * normalize(vT) + g.y * normalize(vB)) * 0.2);
  vec3 v = normalize(-vPos);
  vec3 L = normalize(vec3(-0.35, 0.75, 0.6));
  float diff = max(dot(n, L), 0.0);
  float fill = max(dot(n, normalize(vec3(0.5, -0.3, 0.8))), 0.0) * 0.25;
  float spec = pow(max(dot(n, normalize(L + v)), 0.0), 40.0) * 0.4;
  float rim = pow(1.0 - max(dot(normalize(vN), v), 0.0), 3.0);
  float ao = clamp(1.0 + h * 1.6, 0.3, 1.1);
  // Singers lift toward a pastel of their hue, never all the way to white;
  // the silent ones sink back into shadow.
  vec3 base = mix(uColor, mix(uColor, vec3(1.0), 0.4), uGlow);
  float light = 0.07 + diff * (0.55 + 0.45 * uGlow) + fill * (0.5 + 0.5 * uGlow);
  vec3 col = base * light * ao + spec * (0.6 + 0.4 * uGlow) + rim * base * 0.25;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Chorus {
  title = 'Chorus';

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 216 / 158, 0.1, 50);
    this.camera.position.set(0, 0, 4.4);
    const geo = new THREE.SphereGeometry(0.37, 64, 40);
    this.faces = COLORS.map((hex, i) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uColor: { value: new THREE.Color(hex) },
          uExpr: { value: new THREE.Vector4() },
          uGlow: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      const a = Math.PI / 2 - (i / N) * Math.PI * 2;
      mesh.position.set(Math.cos(a) * 1.02, Math.sin(a) * 1.02 - 0.02, 0);
      this.scene.add(mesh);
      return { mesh, mat, avg: null, open: 0, brow: 0, phase: i * 1.7 };
    });
    this.surge = 0;
    this.mixAvg = null;
    this.t = 0;

    // The guest: Breath's tile, small and far back, seen through the ring.
    ({ mesh: this.ghost, u: this.ghostU } = reliefTile());
    this.ghost.scale.setScalar(0.62);
    this.ghost.position.set(0, -0.02, -1.3);
    this.ghostU.uRound.value = 1;
    this.scene.add(this.ghost);
    this.ghostRest = new THREE.Color();
    this.ghostPeak = this.ghostU.uColor.value.clone();
    this.peakFor = 0;
    this.ghostFade = 0;
    this.screamFor = 0;
  }

  enter() {}

  leave(viz) {
    viz.setCaption(null);
  }

  update(dt, viz) {
    const { bands, beat } = viz.audio;
    this.t += dt;
    let mix = 0;
    for (let b = 0; b < bands.length; b++) mix += bands[b];
    mix /= bands.length;
    this.mixAvg = this.mixAvg === null ? mix : follow(this.mixAvg, mix, dt, 0.3, 0.3);
    // Everyone joins in when the whole mix jumps clear of where it's been.
    this.surge = follow(this.surge, mix > this.mixAvg + 0.07 ? 1 : 0, dt, 5, 1.5);

    this.faces.forEach((f, i) => {
      // Low voices at the top, running clockwise up the spectrum.
      const lo = Math.floor((i * bands.length) / N);
      const hi = Math.floor(((i + 1) * bands.length) / N);
      let e = 0;
      for (let b = lo; b < hi; b++) e += bands[b];
      e /= hi - lo;
      f.avg = f.avg === null ? e : follow(f.avg, e, dt, 0.6, 0.6);
      const solo = Math.min(1, Math.max(0, (e - f.avg) * 6));
      const target = Math.max(solo, this.surge * (0.55 + e * 0.5));
      f.open = follow(f.open, target, dt, 14, 5);
      f.brow = follow(f.brow, Math.max(f.open * 0.8, beat * 0.3), dt, 10, 3);
      const breathe = 0.5 + 0.5 * Math.sin(this.t * 1.4 + f.phase);
      f.mat.uniforms.uExpr.value.set(f.open + breathe * 0.04, f.brow, 0, this.surge * 0.6);
      f.mat.uniforms.uGlow.value = Math.min(1, f.open * 1.2);
      // Singers lean in a little.
      const s = 1 + f.open * 0.08 + breathe * 0.015;
      f.mesh.scale.setScalar(s);
      f.mesh.rotation.set(Math.sin(this.t * 0.7 + f.phase) * 0.08 - f.open * 0.12, Math.sin(this.t * 0.5 + f.phase) * 0.12, 0);
    });

    // The peak: the surge is up and nearly the whole ring is singing. Hold
    // it for a beat and the big face fades in, screaming along.
    const singing = this.faces.filter((f) => f.open > 0.45).length;
    const peak = this.surge > 0.7 && singing >= N - 2;
    this.peakFor = peak ? this.peakFor + dt : Math.max(0, this.peakFor - dt * 2);
    this.ghostFade = follow(this.ghostFade, this.peakFor > 0.6 ? 1 : 0, dt, 1.5, 0.8);
    const g = this.ghostFade;
    // At rest it's the background, lifted just enough for the relief to read.
    this.ghostRest.copy(viz.palette.bg).multiplyScalar(1.5).addScalar(0.01);
    this.ghostU.uColor.value.copy(this.ghostRest).lerp(this.ghostPeak, g);
    const exhale = Math.max(0, -Math.sin(this.t * 1.5));
    this.ghostU.uSwell.value = Math.max(0, Math.sin(this.t * 1.5)) * (1 - g);
    this.ghostU.uExpr.value.set(Math.max(0.03 + exhale * 0.1, g), g, 0.75 * g, g);
    const shake = g * 0.02;
    this.ghostU.uJitter.value.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    this.ghost.rotation.set(-0.08, Math.sin(this.t * 0.4) * 0.1, 0);
    this.screamFor = g > 0.6 ? this.screamFor + dt : 0;
    viz.setCaption(g > 0.6 ? scream(this.screamFor) : null);
  }
}
