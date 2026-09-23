// The one in the screenshot: a tilted plane of points, frequency across and
// time receding, heaved up by the spectrum and slowly turning.

import * as THREE from 'three';

const COLS = 64;
const ROWS = 48;
const ROW_RATE = 30; // new rows per second

export class PointCloud {
  title = 'Headspace: Point Cloud';

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 216 / 158, 0.1, 50);
    this.camera.position.set(0, 1.9, 3.1);
    this.camera.lookAt(0, 0.1, 0);

    this.history = new Float32Array(COLS * ROWS);
    const pos = new Float32Array(COLS * ROWS * 3);
    const col = new Float32Array(COLS * ROWS * 3);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = (r * COLS + c) * 3;
        pos[i] = (c / (COLS - 1) - 0.5) * 2.6;
        pos[i + 2] = (r / (ROWS - 1) - 0.5) * 2.6;
      }
    }
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.045,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.group = new THREE.Group();
    this.group.add(new THREE.Points(this.geom, mat));
    this.group.rotation.x = 0.15;
    this.scene.add(this.group);
    this.t = 0;
    this.acc = 0;
    this.tmp = new THREE.Color();
  }

  enter() {}

  update(dt, viz) {
    const { bands } = viz.audio;
    this.t += dt;
    this.acc += dt;
    if (this.acc >= 1 / ROW_RATE) {
      this.acc %= 1 / ROW_RATE;
      this.history.copyWithin(COLS, 0, COLS * (ROWS - 1));
      this.history.set(bands, 0);
    }
    const pos = this.geom.attributes.position.array;
    const col = this.geom.attributes.color.array;
    for (let r = 0; r < ROWS; r++) {
      const age = r / (ROWS - 1);
      const fade = 1 - age * 0.75;
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const h = this.history[i];
        pos[i * 3 + 1] = h * 0.95 - 0.2;
        // Colour runs across the palette with height, low notes warm.
        viz.gradient(0.15 + h * 0.6 + (c / COLS) * 0.25, this.tmp);
        const glow = (0.25 + h * 1.1) * fade;
        col[i * 3] = this.tmp.r * glow;
        col[i * 3 + 1] = this.tmp.g * glow;
        col[i * 3 + 2] = this.tmp.b * glow;
      }
    }
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.color.needsUpdate = true;
    this.group.rotation.y = Math.sin(this.t * 0.12) * 0.9 + 0.5;
    this.group.position.y = viz.audio.beat * 0.05;
  }
}
