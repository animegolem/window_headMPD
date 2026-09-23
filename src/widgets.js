// WMP skin controls: image buttons, colour-mapped button groups, sliders.
// Each mirrors the element of the same name in headspace.wms.

import { invoke } from '@tauri-apps/api/core';

export const skin = (name) => `/skin/${name.toLowerCase()}.png`;

export function el(tag, parent, { cls, x, y, w, h, text, title } = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (x !== undefined) n.style.left = `${x}px`;
  if (y !== undefined) n.style.top = `${y}px`;
  if (w !== undefined) n.style.width = `${w}px`;
  if (h !== undefined) n.style.height = `${h}px`;
  if (text !== undefined) n.textContent = text;
  if (title) n.title = title;
  if (parent) parent.appendChild(n);
  return n;
}

export function image(parent, name, x, y, opts = {}) {
  const n = el('img', parent, { x, y, ...opts });
  n.src = skin(name);
  n.draggable = false;
  return n;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}

// While a drag is live, keep the window clickable even if the pointer leaves
// the skin's opaque pixels (see clickthrough.rs).
export function capture(on) {
  invoke('set_capture', { on }).catch(() => {});
}

/** <button> with up/hover/down/disabled images. */
export function button(parent, { x, y, up, hover, down, disabled, title, onClick }) {
  const n = image(parent, up, x, y, { title });
  const state = { up, hover: hover ?? up, down: down ?? hover ?? up, disabled: disabled ?? up };
  let isOver = false;
  let isDown = false;
  let isDisabled = false;
  for (const s of Object.values(state)) new Image().src = skin(s);

  const paint = () => {
    const key = isDisabled ? 'disabled' : isDown && isOver ? 'down' : isOver ? 'hover' : 'up';
    n.src = skin(state[key]);
  };
  n.addEventListener('pointerenter', () => { isOver = true; paint(); });
  n.addEventListener('pointerleave', () => { isOver = false; paint(); });
  n.addEventListener('pointerdown', (e) => {
    if (isDisabled || e.button !== 0) return;
    e.stopPropagation();
    isDown = true;
    try {
      n.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (the demo tour) have no real pointer to capture.
    }
    paint();
  });
  n.addEventListener('pointerup', (e) => {
    const wasDown = isDown;
    isDown = false;
    const r = n.getBoundingClientRect();
    isOver = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
    paint();
    if (wasDown && isOver && !isDisabled) onClick?.();
  });

  return {
    node: n,
    set images(imgs) {
      Object.assign(state, imgs);
      paint();
    },
    set disabled(v) {
      isDisabled = v;
      paint();
    },
    set title(t) {
      n.title = t;
    },
    set visible(v) {
      n.classList.toggle('hidden', !v);
    },
  };
}

/**
 * <buttongroup>: one strip of art for several buttons, with a colour map
 * saying which pixel belongs to which button. We composite per pixel so each
 * button lights up on its own, exactly like WMP did.
 */
export async function buttonGroup(parent, { x, y, map, up, hover, down, disabled, elements }) {
  const imgs = await Promise.all([map, up, hover, down, disabled].map((n) => loadImage(skin(n))));
  const w = imgs[0].width;
  const h = imgs[0].height;
  const data = imgs.map((i) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(i, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  });
  const [mapPx, ...layers] = data; // layers: up, hover, down, disabled

  const ids = Object.keys(elements);
  const owner = new Int8Array(w * h).fill(-1);
  const colorToIdx = new Map(ids.map((hex, i) => [parseInt(hex.slice(1), 16), i]));
  for (let p = 0; p < w * h; p++) {
    const rgb = (mapPx[p * 4] << 16) | (mapPx[p * 4 + 1] << 8) | mapPx[p * 4 + 2];
    owner[p] = colorToIdx.get(rgb) ?? -1;
  }

  const canvas = el('canvas', parent, { x, y });
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const out = g.createImageData(w, h);
  const st = ids.map(() => 0); // 0 up 1 hover 2 down 3 disabled
  let hot = -1;
  let pressed = -1;

  const paint = () => {
    for (let p = 0; p < w * h; p++) {
      const o = owner[p];
      const src = layers[o < 0 ? 0 : st[o]];
      out.data[p * 4] = src[p * 4];
      out.data[p * 4 + 1] = src[p * 4 + 1];
      out.data[p * 4 + 2] = src[p * 4 + 2];
      out.data[p * 4 + 3] = src[p * 4 + 3];
    }
    g.putImageData(out, 0, 0);
  };
  const disabledSet = new Set();
  const restate = () => {
    ids.forEach((_, i) => {
      st[i] = disabledSet.has(i) ? 3 : pressed === i && hot === i ? 2 : hot === i ? 1 : 0;
    });
    paint();
    const e = hot >= 0 ? elements[ids[hot]] : null;
    canvas.title = e?.title ?? '';
    canvas.style.cursor = 'default';
  };
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const px = Math.floor(((e.clientX - r.left) / r.width) * w);
    const py = Math.floor(((e.clientY - r.top) / r.height) * h);
    if (px < 0 || py < 0 || px >= w || py >= h) return -1;
    return owner[py * w + px];
  };

  canvas.addEventListener('pointermove', (e) => {
    const i = at(e);
    if (i !== hot) {
      hot = i;
      restate();
    }
  });
  canvas.addEventListener('pointerleave', () => {
    hot = -1;
    restate();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const i = at(e);
    if (i < 0 || disabledSet.has(i)) return;
    e.stopPropagation();
    pressed = i;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (the demo tour) have no real pointer to capture.
    }
    restate();
  });
  canvas.addEventListener('pointerup', (e) => {
    const i = at(e);
    const fire = pressed >= 0 && i === pressed;
    const target = pressed;
    pressed = -1;
    hot = i;
    restate();
    if (fire) elements[ids[target]].onClick?.();
  });

  restate();
  return {
    node: canvas,
    setDisabled(hex, v) {
      const i = ids.indexOf(hex);
      if (i < 0) return;
      if (v) disabledSet.add(i);
      else disabledSet.delete(i);
      restate();
    },
  };
}

/**
 * <slider>. `track` is either a tiled track (h/v) or a fixed background
 * image; value runs min..max (vertical sliders put max at the top).
 * onInput fires while dragging, onChange on release.
 */
export function slider(parent, opts) {
  const { x, y, length, vertical = false, min, max, thumb, title, onInput, onChange } = opts;
  const box = el('div', parent, { cls: 'abs', x, y, title });
  let thumbW;
  let thumbH;
  let trackLen;
  let fg = null;

  if (opts.background) {
    // Seek bar: fixed art, foreground revealed up to the playhead.
    image(box, opts.background, 0, 0);
    const clip = el('div', box, { cls: 'abs', x: 0, y: 0, w: 0, h: 9 });
    clip.style.overflow = 'hidden';
    image(clip, opts.foreground, 0, 0);
    fg = clip;
    thumbW = 18;
    thumbH = 9;
    trackLen = 163;
    box.style.width = '163px';
    box.style.height = '9px';
  } else {
    const t = el('div', box, { cls: `track ${vertical ? 'v' : 'h'}` });
    if (vertical) t.style.height = `${length}px`;
    else t.style.width = `${length}px`;
    thumbW = vertical ? 11 : 9;
    thumbH = 11;
    trackLen = length;
    box.style.width = `${vertical ? 11 : length}px`;
    box.style.height = `${vertical ? length : 11}px`;
  }
  const th = image(box, thumb.up, 0, 0);
  const travel = trackLen - (vertical ? thumbH : thumbW);

  let value = min;
  let dragging = false;
  let over = false;
  const paintThumb = () => {
    const name = dragging && thumb.down ? thumb.down : over && thumb.hover ? thumb.hover : thumb.up;
    th.src = skin(name);
  };
  const place = () => {
    const f = max === min ? 0 : (value - min) / (max - min);
    if (vertical) {
      th.style.left = '0px';
      th.style.top = `${Math.round((1 - f) * travel)}px`;
    } else {
      th.style.left = `${Math.round(f * travel)}px`;
      th.style.top = '0px';
    }
    if (fg) fg.style.width = `${Math.round(f * travel + thumbW / 2)}px`;
  };
  const fromEvent = (e) => {
    const r = box.getBoundingClientRect();
    const zoom = r.width / (vertical ? 11 : trackLen);
    let f;
    if (vertical) f = 1 - ((e.clientY - r.top) / zoom - thumbH / 2) / travel;
    else f = ((e.clientX - r.left) / zoom - thumbW / 2) / travel;
    f = Math.min(1, Math.max(0, f));
    return Math.round(min + f * (max - min));
  };

  box.addEventListener('pointerenter', () => { over = true; paintThumb(); });
  box.addEventListener('pointerleave', () => { over = false; paintThumb(); });
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragging = true;
    capture(true);
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events (the demo tour) have no real pointer to capture.
    }
    value = fromEvent(e);
    place();
    paintThumb();
    onInput?.(value);
  });
  box.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const v = fromEvent(e);
    if (v !== value) {
      value = v;
      place();
      onInput?.(value);
    }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    capture(false);
    paintThumb();
    onChange?.(value);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  place();
  return {
    node: box,
    get dragging() {
      return dragging;
    },
    get value() {
      return value;
    },
    set value(v) {
      if (dragging) return;
      value = Math.min(max, Math.max(min, v));
      place();
    },
  };
}
