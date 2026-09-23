// A scripted tour for making a promo video. A Windows 2000 arrow cursor
// glides around the skin and "clicks" by dispatching real pointer events, so
// every button shows its hover and pressed art and every control really acts.
//
// Triggered over MPD's client-to-client channel:
//
//   mpc sendmessage window_head "demo /path/to/soundtrack.wav"
//
// At t=0 the whole skin flashes white for a few frames. The flash is the
// sync mark: the WAV (what the app sent to the speakers) starts on that
// frame, so trimming the screen recording at the flash lines them up.

import { invoke } from '@tauri-apps/api/core';
import { el } from './widgets.js';

const CURSOR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="19" shape-rendering="crispEdges">' +
    '<path d="M.5.5v15l4-4 3 7 2-1-3-7h5.5z" fill="#fff" stroke="#000"/></svg>',
)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export async function runDemo(ctx, wavPath) {
  const { root, zoom, player, viz, ui } = ctx;
  const log = (m) => invoke('js_log', { msg: `demo: ${m}` }).catch(() => {});

  // ---- the fake cursor ----
  const cur = el('img', root);
  cur.src = CURSOR;
  cur.style.cssText = 'position:absolute;z-index:1000;pointer-events:none;width:12px;height:19px;';
  let pos = { x: 0, y: 0 }; // client coordinates
  let hovered = null;
  let captured = null;

  const skinXY = (p) => {
    const r = root.getBoundingClientRect();
    return { x: (p.x - r.left) / zoom(), y: (p.y - r.top) / zoom() };
  };
  const fire = (target, type, extra = {}) =>
    target?.dispatchEvent(
      new PointerEvent(type, {
        clientX: pos.x,
        clientY: pos.y,
        bubbles: !['pointerenter', 'pointerleave'].includes(type),
        cancelable: true,
        button: 0,
        buttons: extra.buttons ?? 0,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
      }),
    );
  const moveTo = (p) => {
    pos = p;
    const s = skinXY(p);
    cur.style.left = `${s.x}px`;
    cur.style.top = `${s.y}px`;
    const under = document.elementFromPoint(p.x, p.y);
    if (captured) {
      fire(captured, 'pointermove', { buttons: 1 });
      return;
    }
    if (under !== hovered) {
      fire(hovered, 'pointerleave');
      hovered = under;
      fire(hovered, 'pointerenter');
    }
    fire(under, 'pointermove');
  };
  const glide = async (to, ms) => {
    const from = { ...pos };
    const t0 = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - t0) / ms);
      const k = ease(t);
      moveTo({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
      if (t >= 1) break;
      await sleep(16);
    }
  };
  const press = () => {
    captured = document.elementFromPoint(pos.x, pos.y);
    fire(captured, 'pointerdown', { buttons: 1 });
  };
  const release = () => {
    const t = captured;
    captured = null;
    fire(t, 'pointerup');
    t?.dispatchEvent(new MouseEvent('click', { clientX: pos.x, clientY: pos.y, bubbles: true }));
  };
  const click = async () => {
    press();
    await sleep(130);
    release();
  };

  // Client point for skin coordinates, or for a spot inside an element.
  const at = (sx, sy) => {
    const r = root.getBoundingClientRect();
    return { x: r.left + sx * zoom(), y: r.top + sy * zoom() };
  };
  const on = (node, fx = 0.5, fy = 0.5) => {
    const r = node.getBoundingClientRect();
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  };
  // Where a vertical EQ slider's thumb sits for a gain in dB.
  const band = (i, db) => {
    const r = ui.bands[i].node.getBoundingClientRect();
    const z = zoom();
    const f = (db + 14) / 28;
    return { x: r.left + r.width / 2, y: r.top + z * (5.5 + (1 - f) * 65) };
  };
  const dragBand = async (i, db) => {
    await glide(band(i, ui.bands[i].value), 350);
    press();
    await glide(band(i, db), 450);
    release();
  };

  // ---- set the stage (before the flash, so it's cut from the video) ----
  document.body.classList.add('demo');
  const savedEq = ui.getEq();
  if (ui.isOpen.eq()) ui.toggleEq();
  if (ui.isOpen.pl()) ui.togglePl();
  if (ui.isOpen.vis()) ui.toggleVis();
  ui.setEq(Array(10).fill(0));
  let guard = 0;
  while (viz.current.title !== 'Chorus' && guard++ < 20) viz.step(1);
  if (player.state === 'stop') {
    await ctx.mpd('play');
    await sleep(300);
  }
  await ctx.mpd('pause', 1);
  await ctx.mpd('seekcur', 0);
  moveTo(at(470, 330));
  await sleep(1500);

  // ---- t = 0: sync flash + soundtrack ----
  await invoke('record_start');
  const flash = el('div', root);
  flash.style.cssText = 'position:absolute;inset:0;background:#fff;z-index:2000;';
  const T0 = performance.now();
  await sleep(120);
  flash.remove();
  const until = (sec) => sleep(Math.max(0, T0 + sec * 1000 - performance.now()));
  log('started');

  // Hit play on the current song.
  await until(0.4);
  await glide(on(ui.transport, 37 / 144, 13 / 25), 1000);
  await until(1.6);
  await click();
  log(`play at ${((performance.now() - T0) / 1000).toFixed(3)}s`);

  // The drawers.
  await until(4.5);
  await glide(on(ui.plHandle), 900);
  await click();
  await until(7.0);
  await glide(on(ui.eqHandle), 1100);
  await click();

  // A bass-and-treble smile you can hear (the app is the speaker).
  await until(8.6);
  await dragBand(0, 10);
  await dragBand(1, 8);
  await dragBand(4, -5);
  await dragBand(8, 6);
  await dragBand(9, 9);

  // Second half: the visualization chooser, flipping through the presets.
  await until(15.0);
  await glide(on(ui.transport, 131 / 144, 13 / 25), 900);
  await click();
  await until(16.4);
  await glide(on(ui.visNext), 700);
  for (const t of [17.0, 20.9, 24.8, 28.7, 32.6]) {
    await until(t);
    await click();
  }

  // Put the EQ back and step aside.
  await until(35.8);
  await glide(on(ui.reset), 1000);
  await click();
  await until(37.6);
  await glide(at(470, 330), 900);
  await until(39.5);

  await invoke('record_stop', { path: wavPath }).then(
    () => log(`wrote ${wavPath}`),
    (e) => log(`record failed: ${e}`),
  );
  cur.remove();
  document.body.classList.remove('demo');
  ui.setEq(savedEq);
  log('done');
}
