// The head's screen: one three.js renderer, several presets, fed ~60 frames a
// second of spectrum + waveform from the Rust audio engine, tinted by an
// OKLab k-means palette pulled from the current album art.

import * as THREE from 'three';
import { Channel, invoke } from '@tauri-apps/api/core';
import { PointCloud } from './cloud.js';
import { Ring } from './ring.js';
import { Warp } from './warp.js';
import { Ribbon } from './ribbon.js';
import { Chorus } from './chorus.js';
import { Breath } from './breath.js';

export const W = 216;
export const H = 158;
const N_BANDS = 64;

// Before any album art arrives: the red-to-violet of the classic screenshot.
const DEFAULT_PALETTE = ['#ff2020', '#e0307a', '#8a3cff', '#3a6bff'];

export class Viz {
  presets = [PointCloud, Chorus, Breath, Ring, Warp, Ribbon].map((P) => new P());
  audio = {
    bands: new Float32Array(N_BANDS),
    wave: new Float32Array(256),
    level: 0,
    bass: 0,
    mid: 0,
    high: 0,
    beat: 0,
  };
  palette = {
    colors: DEFAULT_PALETTE.map((c) => new THREE.Color(c)),
    bg: new THREE.Color('#000000'),
  };
  #target = { colors: DEFAULT_PALETTE.map((c) => new THREE.Color(c)), bg: new THREE.Color('#000000') };
  #bassAvg = 0;

  constructor(canvas, onPresetChange, captionEl = null) {
    this.captionEl = captionEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(W, H, false);
    this.onPresetChange = onPresetChange;
    let saved = 0;
    try {
      saved = parseInt(localStorage.getItem('preset') ?? '0', 10) || 0;
    } catch {}
    this.index = Math.abs(saved) % this.presets.length;
    this.current.enter(this);
    onPresetChange(this.current.title);

    try {
      const ch = new Channel();
      ch.onmessage = (f) => this.feed(f);
      invoke('audio_subscribe', { onFrame: ch }).catch((e) => console.warn('audio', e));
    } catch {
      // Outside Tauri (tools/facelab.html): the caller feeds frames itself.
    }

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  get current() {
    return this.presets[this.index];
  }

  /** Text over the screen, for presets that talk. null hides it. */
  setCaption(text) {
    if (!this.captionEl) return;
    this.captionEl.textContent = text ?? '';
    this.captionEl.classList.toggle('hidden', !text);
  }

  step(dir) {
    this.current.leave?.(this);
    this.index = (this.index + dir + this.presets.length) % this.presets.length;
    try {
      localStorage.setItem('preset', String(this.index));
    } catch {}
    this.current.enter(this);
    this.onPresetChange(this.current.title);
  }

  /**
   * Swatches from the Rust `palette` command (dominance-ordered clusters).
   * Pick the four that carry the cover best, favouring colourful ones, then
   * order dark to light so presets can treat them as a gradient.
   */
  setPalette(swatches) {
    if (!swatches?.length) {
      this.#target.colors.forEach((c, i) => c.set(DEFAULT_PALETTE[i]));
      this.#target.bg.set('#000000');
      return;
    }
    const scored = swatches
      .map((s) => ({ ...s, score: Math.sqrt(s.share) * (0.25 + s.oklch[1] * 4) }))
      .sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, 4);
    while (picks.length < 4) picks.push(picks[picks.length % Math.max(1, picks.length)] ?? scored[0]);
    picks.sort((a, b) => a.oklch[0] - b.oklch[0]);
    picks.forEach((p, i) => {
      const c = this.#target.colors[i].set(p.hex);
      // Screens glow: lift anything too dark to read on black.
      const hsl = {};
      c.getHSL(hsl);
      if (hsl.l < 0.35) c.setHSL(hsl.h, Math.max(hsl.s, 0.5), 0.35 + i * 0.08);
    });
    const darkest = [...swatches].sort((a, b) => a.oklch[0] - b.oklch[0])[0];
    this.#target.bg.set(darkest.hex).multiplyScalar(0.25);
  }

  feed(f) {
    const a = this.audio;
    a.bands.set(f.bands);
    a.wave.set(f.wave);
    a.level = f.level;
    const avg = (lo, hi) => {
      let s = 0;
      for (let i = lo; i < hi; i++) s += a.bands[i];
      return s / (hi - lo);
    };
    a.bass = avg(0, 8);
    a.mid = avg(8, 32);
    a.high = avg(32, 64);
    // Beat: bass jumping clear of its recent average.
    this.#bassAvg = this.#bassAvg * 0.95 + a.bass * 0.05;
    if (a.bass > this.#bassAvg * 1.25 && a.bass > 0.3) a.beat = 1;
  }

  /** Sample the palette as a gradient, t in 0..1. */
  gradient(t, out) {
    const c = this.palette.colors;
    const x = Math.min(0.9999, Math.max(0, t)) * (c.length - 1);
    const i = Math.floor(x);
    return out.copy(c[i]).lerp(c[i + 1], x - i);
  }

  #tick() {
    const dt = Math.min(0.1, this.clock.getDelta());
    const k = 1 - Math.exp(-dt * 2.5);
    this.palette.colors.forEach((c, i) => c.lerp(this.#target.colors[i], k));
    this.palette.bg.lerp(this.#target.bg, k);
    this.audio.beat = Math.max(0, this.audio.beat - dt * 4);
    this.current.update(dt, this);
    this.renderer.setClearColor(this.current.clear ?? this.palette.bg);
    this.renderer.render(this.current.scene, this.current.camera);
  }
}
