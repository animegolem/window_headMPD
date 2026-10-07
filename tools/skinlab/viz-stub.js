// Stands in for src/viz/index.js in skinlab (vite.config.js maps the absolute path here, so the
// pinned file stays untouched). Same API as the real Viz, no WebGL and no audio_subscribe: the
// canvas is plain black, which is what the effects hole shows in every golden.

export const W = 216;
export const H = 158;

// The titles of viz:23, in order.
const TITLES = ['Headspace: Point Cloud', 'Chorus', 'Bars and Waves: Ring', 'Ambience: Warp', 'Scope: Ribbon'];

export class Viz {
  presets = TITLES.map((title) => ({ title, enter() {}, leave() {}, update() {} }));
  renderer = { setPixelRatio() {}, setSize() {}, setAnimationLoop() {}, setClearColor() {}, render() {} };

  constructor(canvas, onPresetChange, captionEl = null) {
    this.captionEl = captionEl;
    this.onPresetChange = onPresetChange;
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    let saved = 0;
    try {
      saved = parseInt(localStorage.getItem('preset') ?? '0', 10) || 0;
    } catch {}
    this.index = Math.abs(saved) % this.presets.length;
    onPresetChange(this.current.title);
  }

  get current() {
    return this.presets[this.index];
  }

  setCaption(text) {
    if (!this.captionEl) return;
    this.captionEl.textContent = text ?? '';
    this.captionEl.classList.toggle('hidden', !text);
  }

  step(dir) {
    this.index = (this.index + dir + this.presets.length) % this.presets.length;
    try {
      localStorage.setItem('preset', String(this.index));
    } catch {}
    this.onPresetChange(this.current.title);
  }

  setPalette() {}
  feed() {}
}
