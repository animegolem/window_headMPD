// Opus: Breath, after anthrupad's post: "After practicing breathing, Opus 5
// worked on incorporating breathing into their depiction of fear. Here's
// their construction of gasping and screaming."
//
// A blue relief tile on a pale ground. Quiet music: it breathes. A hard beat
// well above the running loudness: it gasps. A loud passage that keeps
// building: it screams, shaking, with the caption to match.

import * as THREE from 'three';
import { FACE_GLSL, follow } from './face.js';

const vert = /* glsl */ `
uniform vec4 uExpr;
uniform vec2 uJitter;
uniform float uSwell;
varying vec2 vP;
varying vec3 vPos, vN, vT, vB;
${FACE_GLSL}
float relief(vec2 p) {
  float r = length(p);
  // The face sits on a raised disc with a ridge round its edge.
  float disc = 0.10 * smoothstep(0.93, 0.86, r) + 0.06 * exp(-pow((r - 0.9) / 0.025, 2.0));
  return disc + faceHeight(p * (1.0 - uSwell * 0.04), uExpr) * smoothstep(0.95, 0.8, r);
}
void main() {
  vP = position.xy / 0.92 + uJitter;
  vN = normalMatrix * vec3(0.0, 0.0, 1.0);
  vT = normalMatrix * vec3(1.0, 0.0, 0.0);
  vB = normalMatrix * vec3(0.0, 1.0, 0.0);
  vec3 pos = position + vec3(0.0, 0.0, relief(vP) * 0.16);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform vec4 uExpr;
uniform vec3 uColor;
uniform float uSwell;
uniform float uFade;
uniform float uRound;
varying vec2 vP;
varying vec3 vPos, vN, vT, vB;
${FACE_GLSL}
float relief(vec2 p) {
  float r = length(p);
  float disc = 0.10 * smoothstep(0.93, 0.86, r) + 0.06 * exp(-pow((r - 0.9) / 0.025, 2.0));
  return disc + faceHeight(p * (1.0 - uSwell * 0.04), uExpr) * smoothstep(0.95, 0.8, r);
}
void main() {
  const float d = 0.004;
  vec2 g = vec2(relief(vP + vec2(d, 0.0)) - relief(vP - vec2(d, 0.0)),
                relief(vP + vec2(0.0, d)) - relief(vP - vec2(0.0, d))) / (2.0 * d);
  // Tile normal in view space, tilted by the relief gradient.
  vec3 n = normalize(normalize(vN) - (g.x * normalize(vT) + g.y * normalize(vB)) * 0.18);
  vec3 L = normalize(vec3(-0.45, 0.6, 0.65));
  float diff = max(dot(n, L), 0.0);
  float h = relief(vP);
  float ao = clamp(1.0 + min(h, 0.0) * 1.3, 0.25, 1.0);
  vec3 col = uColor * (0.35 + 0.75 * diff) * ao;
  // Round mode trims the square tile down to the face disc, just outside its rim.
  float cut = mix(1.0, smoothstep(0.98, 0.94, length(vP)), uRound);
  if (cut < 0.01) discard;
  gl_FragColor = vec4(col, uFade * cut);
  #include <colorspace_fragment>
}`;

/** The blue relief tile itself, reusable by other presets (Chorus summons it). */
export function reliefTile() {
  const u = {
    uExpr: { value: new THREE.Vector4() },
    uJitter: { value: new THREE.Vector2() },
    uSwell: { value: 0 },
    uFade: { value: 1 },
    uRound: { value: 0 },
    uColor: { value: new THREE.Color('#5b86cc') },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: u, transparent: true });
  return { mesh: new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 180, 180), mat), u };
}

/** Caption text for a scream that has lasted `secs`. */
export const scream = (secs) => 'A'.repeat(Math.min(14, 5 + Math.floor(secs * 5)));

export class Breath {
  title = 'Opus: Breath';
  clear = new THREE.Color('#f3f3f3');

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 216 / 158, 0.1, 50);
    this.camera.position.set(0.25, 0.45, 2.75);
    this.camera.lookAt(0, 0.02, 0);
    ({ mesh: this.tile, u: this.u } = reliefTile());
    this.tile.rotation.set(-0.12, 0.06, 0.012);
    this.scene.add(this.tile);

    this.t = 0;
    this.energyAvg = 0.3;
    this.loudFor = 0;
    this.gasp = 0;
    this.scream = 0;
    this.screamTime = 0;
  }

  enter() {}

  leave(viz) {
    viz.setCaption(null);
  }

  update(dt, viz) {
    const a = viz.audio;
    this.t += dt;
    const energy = a.bass * 0.4 + a.mid * 0.6;
    this.energyAvg = follow(this.energyAvg, energy, dt, 0.08, 0.08);
    const over = energy - this.energyAvg;

    if (a.beat > 0.95 && over > 0.06) this.gasp = 1;
    this.gasp = Math.max(0, this.gasp - dt * 2.5);
    this.loudFor = over > 0.05 ? this.loudFor + dt : Math.max(0, this.loudFor - dt * 1.5);
    this.scream = follow(this.scream, this.loudFor > 1.2 ? 1 : 0, dt, 4, 1.8);
    this.screamTime = this.scream > 0.5 ? this.screamTime + dt : 0;

    // A slow breath: in through the nose (swell), out through parted lips.
    const breath = Math.sin(this.t * 1.5);
    const exhale = Math.max(0, -breath);
    const open = Math.max(0.03 + exhale * 0.1, this.gasp * 0.65, this.scream);
    const brow = Math.max(this.gasp * 0.9, this.scream);
    this.u.uExpr.value.set(open, brow, this.scream * 0.75, Math.max(this.gasp, this.scream));
    this.u.uSwell.value = Math.max(0, breath) * (1 - this.scream);
    const shake = this.scream * 0.02 + this.gasp * 0.006;
    this.u.uJitter.value.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    viz.setCaption(this.scream > 0.5 ? scream(this.screamTime) : null);
  }
}
