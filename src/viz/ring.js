// Bars and Waves, 3D: a ring of spectrum bars over a mirror floor, with a
// wireframe core that kicks on the beat.

import * as THREE from 'three';

const N = 64;

export class Ring {
  title = 'Bars and Waves: Ring';

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 216 / 158, 0.1, 50);

    const box = new THREE.BoxGeometry(0.07, 1, 0.07);
    box.translate(0, 0.5, 0);
    this.bars = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial(), N);
    this.mirror = new THREE.InstancedMesh(
      box,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
      N,
    );
    this.scene.add(this.bars, this.mirror);

    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.35, 1),
      new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.8 }),
    );
    this.scene.add(this.core);

    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.c = new THREE.Color();
    this.up = new THREE.Vector3(0, 1, 0);
    this.t = 0;
  }

  enter() {}

  update(dt, viz) {
    const { bands, beat, bass } = viz.audio;
    this.t += dt;
    for (let i = 0; i < N; i++) {
      // Mirror the spectrum around the ring so it closes seamlessly.
      const b = bands[i < N / 2 ? i * 2 : (N - 1 - i) * 2 + 1];
      const a = (i / N) * Math.PI * 2;
      const h = 0.04 + b * 1.4;
      this.p.set(Math.cos(a) * 1.25, 0, Math.sin(a) * 1.25);
      this.q.setFromAxisAngle(this.up, -a);
      this.s.set(1, h, 1);
      this.m.compose(this.p, this.q, this.s);
      this.bars.setMatrixAt(i, this.m);
      this.s.set(1, -h, 1);
      this.m.compose(this.p, this.q, this.s);
      this.mirror.setMatrixAt(i, this.m);
      viz.gradient(0.1 + b * 0.9, this.c);
      this.bars.setColorAt(i, this.c);
      this.mirror.setColorAt(i, this.c);
    }
    for (const m of [this.bars, this.mirror]) {
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
    const k = 1 + bass * 0.6 + beat * 0.35;
    this.core.scale.setScalar(k);
    this.core.position.y = 0.45;
    this.core.rotation.y += dt * (0.4 + bass * 2);
    this.core.rotation.x += dt * 0.25;
    viz.gradient(0.95, this.core.material.color);

    const orbit = this.t * 0.25;
    this.camera.position.set(Math.cos(orbit) * 3.3, 1.5 + Math.sin(this.t * 0.3) * 0.4, Math.sin(orbit) * 3.3);
    this.camera.lookAt(0, 0.35, 0);
  }
}
