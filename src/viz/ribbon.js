// Scope: the waveform drawn as a line, with its recent past trailing off
// into the distance like an oscilloscope with phosphor memory.

import * as THREE from 'three';

const TRAILS = 28;
const POINTS = 256;

export class Ribbon {
  title = 'Scope: Ribbon';

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 216 / 158, 0.1, 50);
    this.camera.position.set(0, 0.9, 2.3);
    this.camera.lookAt(0, 0, -0.8);
    this.lines = [];
    for (let i = 0; i < TRAILS; i++) {
      const pos = new Float32Array(POINTS * 3);
      for (let p = 0; p < POINTS; p++) pos[p * 3] = (p / (POINTS - 1) - 0.5) * 3.2;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.LineBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(g, m);
      this.scene.add(line);
      this.lines.push(line);
    }
    this.head = 0;
    this.acc = 0;
    this.t = 0;
  }

  enter() {}

  update(dt, viz) {
    const { wave, level, beat } = viz.audio;
    this.t += dt;
    this.acc += dt;
    if (this.acc >= 1 / 40) {
      this.acc %= 1 / 40;
      this.head = (this.head + 1) % TRAILS;
      const pos = this.lines[this.head].geometry.attributes.position;
      // Normalise quiet passages up so the line never goes flat and dull.
      const gain = 0.9 / Math.max(0.08, level * 3.5);
      for (let p = 0; p < POINTS; p++) {
        const edge = Math.sin((p / (POINTS - 1)) * Math.PI);
        pos.array[p * 3 + 1] = wave[p] * gain * edge * 0.6;
      }
      pos.needsUpdate = true;
    }
    for (let i = 0; i < TRAILS; i++) {
      const age = (this.head - i + TRAILS) % TRAILS;
      const line = this.lines[i];
      const f = age / TRAILS;
      line.position.z = -f * 3.2;
      line.position.y = f * 0.35;
      viz.gradient(1 - f * 0.9, line.material.color);
      line.material.opacity = (1 - f) ** 1.6 * (0.9 + beat * 0.3);
    }
    this.scene.rotation.z = Math.sin(this.t * 0.2) * 0.08;
  }
}
