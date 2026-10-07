// @vitest-environment happy-dom
// The effects slot's overlays (ENGINE.md D10.3): the track toast, the notice and the caption strip, and
// overlays.css as a verbatim copy of the hand port's rules. Media is the test host's scripted fake and
// time is its manual clock, so the 4.5 s toast and the 1.5 s notice retry are exact.
//
// Rule 6: no lookup here is keyed by a skin string. The text a song or MPD supplies is only ever shown
// (textContent), and one case feeds it markup and the keys `__proto__` and `constructor` as titles.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../src/hosts/test/clock.js';
import { createFakeMedia, presetQueue } from '../../src/hosts/test/media.js';
import { createOverlays, ENGINE_INFO, NOTICE_RETRY_MS, TOAST_MS, WAITING_TEXT } from '../../src/app/overlays.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
// Paths, not URLs: happy-dom replaces the global URL class, and fs wants Node's.
const here = dirname(fileURLToPath(import.meta.url));
const OVERLAYS_CSS = readFileSync(resolve(here, '../../src/app/overlays.css'), 'utf8');

afterEach(() => { document.body.innerHTML = ''; });

/** A promise the test settles later. */
function deferred() {
  /** @type {(v: unknown) => void} */ let resolve = () => {};
  /** @type {(e: unknown) => void} */ let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Overlays over a fake media and a manual clock; `reply` is what `engine_info` answers (a function of
 * the call number, so a test can make the second one different), every call is recorded.
 * @param {{ preset?: string, reply?: (n: number) => any, noticeColor?: any }} [o]
 */
function setup(o = {}) {
  const clock = createManualClock();
  const media = createFakeMedia(o.preset ?? 'stoppedQueue5', { clock });
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    const r = (o.reply ?? (() => ({ mode: 'output', routed: true, error: null })))(calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  const timers = { setTimer: (ms, cb) => clock.setTimer(ms, cb), clearTimer: (id) => clock.clearTimer(id) };
  const overlays = createOverlays({ media, invoke, timers, noticeColor: o.noticeColor });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mount = () => overlays.mount(host);
  return { clock, media, calls, invoke, timers, overlays, host, mount };
}

describe('the track toast', () => {
  it('shows the title and artist on a song change for 4.5 s', async () => {
    const t = setup();
    const m = t.mount();
    expect(m.toast.classList.contains('show')).toBe(false);
    await t.media.play();                                   // queue position 1: "Weightless"
    expect(t.media.snapshot().song.title).toBe('Weightless');
    expect([...m.toast.children].map((c) => [c.className, c.textContent])).toEqual([['', 'Weightless'], ['artist', 'Skinlab Fixture']]);
    expect(m.toast.classList.contains('show')).toBe(true);
    expect(TOAST_MS).toBe(4500);
    t.clock.advance(4499);
    expect(m.toast.classList.contains('show')).toBe(true);
    t.clock.advance(1);
    expect(m.toast.classList.contains('show')).toBe(false);
    expect(t.clock.pendingTimers()).toBe(0);                // the notice retry (1.5 s) has long since run
  });

  it('restarts the 4.5 s on the next song and replaces the text', async () => {
    const t = setup();
    const m = t.mount();
    await t.media.play();
    t.clock.advance(3000);
    await t.media.next();
    expect(m.toast.firstElementChild.textContent).toBe('Harbor Lights');
    t.clock.advance(4499);
    expect(m.toast.classList.contains('show')).toBe(true);
    t.clock.advance(1);
    expect(m.toast.classList.contains('show')).toBe(false);
  });

  it('clears when the song goes away, and leaves out an absent artist', async () => {
    const t = setup();
    const m = t.mount();
    await t.media.play();
    t.media.emit({ song: null });
    expect(m.toast.classList.contains('show')).toBe(false);
    expect(m.toast.children).toHaveLength(0);
    expect(t.clock.pendingTimers()).toBe(1);
    t.media.emit({ song: { ...presetQueue('stoppedQueue5')[2], artist: '' } });
    expect([...m.toast.children].map((c) => c.textContent)).toEqual(['Harbor Lights']);
  });

  it('falls back to the file stem when the song has no title', () => {
    const t = setup();
    const m = t.mount();
    t.media.emit({ song: { ...presetQueue('stoppedQueue5')[0], title: '', file: 'music/a dir/My Song.v2.flac' } });
    expect(m.toast.firstElementChild.textContent).toBe('My Song.v2');
  });

  it('restarts only when the file changes, and not for a song already playing at mount', () => {
    const t = setup();
    const song = presetQueue('stoppedQueue5')[1];
    t.media.emit({ song });
    const m = t.mount();                                    // mounted with a song already current
    expect(m.toast.classList.contains('show')).toBe(false);
    t.media.emit({ song: { ...song, title: 'Retagged' } });  // same file, new tags
    expect(m.toast.classList.contains('show')).toBe(false);
    t.media.emit({ song: presetQueue('stoppedQueue5')[3] });
    expect(m.toast.classList.contains('show')).toBe(true);
  });

  it('sets text, never markup, and is not fooled by prototype keys', () => {
    const t = setup();
    const m = t.mount();
    t.media.emit({ song: { ...presetQueue('stoppedQueue5')[0], title: '<img src=x onerror=alert(1)>', artist: '__proto__' } });
    expect(m.toast.querySelectorAll('img')).toHaveLength(0);
    expect(m.toast.firstElementChild.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(m.toast.lastElementChild.textContent).toBe('__proto__');
    t.media.emit({ song: { ...presetQueue('stoppedQueue5')[1], title: 'constructor', artist: '' } });
    expect(m.toast.textContent).toBe('constructor');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('keeps independent state per mount and cleans up on dispose', async () => {
    const t = setup();
    const a = t.mount();
    const host2 = document.createElement('div');
    const b = t.overlays.mount(host2);
    await t.media.play();
    expect(a.toast.classList.contains('show') && b.toast.classList.contains('show')).toBe(true);
    a.dispose();
    expect(a.toast.isConnected).toBe(false);
    expect(t.clock.pendingTimers()).toBe(2);               // b's toast timer and the notice retry
    t.clock.advance(4500);
    expect(b.toast.classList.contains('show')).toBe(false);
    b.dispose();
    b.dispose();
    t.overlays.dispose();
    expect(t.clock.pendingTimers()).toBe(0);
  });
});

describe('the notice', () => {
  it('says what engine_info says while MPD is connected, nothing when it has no error', async () => {
    const t = setup({ reply: () => ({ mode: 'output', routed: false, error: 'no audio route' }) });
    const m = t.mount();
    expect(m.notice.textContent).toBe('');
    await flush();
    expect(t.calls).toEqual([[ENGINE_INFO, undefined]]);
    expect(t.overlays.notice.text()).toBe('no audio route');
    expect(m.notice.textContent).toBe('no audio route');
    t.media.emit({ connected: true });                      // unchanged: nothing to do
    expect(t.calls).toHaveLength(1);
  });

  it('follows the connection: waiting while down, a fresh engine_info look when it comes back', async () => {
    const t = setup({ reply: (n) => ({ error: n === 1 ? null : 'routing broke' }) });
    const m = t.mount();
    await flush();
    expect(t.overlays.notice.text()).toBe('');
    t.media.set({ connected: false });
    expect(WAITING_TEXT).toBe('Waiting for MPD…');
    expect(m.notice.textContent).toBe('Waiting for MPD…');
    expect(t.calls).toHaveLength(1);                        // down: engine_info is not asked
    t.media.set({ connected: true });
    await flush();
    expect(t.calls).toHaveLength(2);
    expect(m.notice.textContent).toBe('routing broke');
  });

  it('treats a failing or odd engine_info as no error', async () => {
    for (const reply of [() => new Error('no such command'), () => null, () => 'oops', () => ({ error: 5 }), () => ({})]) {
      const t = setup({ reply });
      t.mount();
      await flush();
      expect(t.overlays.notice.text()).toBe('');
    }
  });

  it('asks again 1.5 s after it starts', async () => {
    const t = setup({ reply: (n) => ({ error: n === 1 ? null : 'late error' }) });
    const m = t.mount();
    await flush();
    expect(NOTICE_RETRY_MS).toBe(1500);
    t.clock.advance(1499);
    await flush();
    expect(t.calls).toHaveLength(1);
    t.clock.advance(1);
    await flush();
    expect(t.calls).toHaveLength(2);
    expect(m.notice.textContent).toBe('late error');
  });

  it('drops a reply that is older than the latest refresh', async () => {
    const slow = deferred();
    let n = 0;
    const clock = createManualClock();
    const media = createFakeMedia('stoppedQueue5', { clock });
    const invoke = () => (++n === 1 ? slow.promise : Promise.resolve({ error: null }));
    const overlays = createOverlays({ media, invoke, timers: { setTimer: (ms, cb) => clock.setTimer(ms, cb), clearTimer: (id) => clock.clearTimer(id) } });
    media.set({ connected: false });                        // supersedes the slow first look
    expect(overlays.notice.text()).toBe(WAITING_TEXT);
    slow.resolve({ error: 'x' });
    await flush();
    expect(overlays.notice.text()).toBe(WAITING_TEXT);
  });

  it('announces changes only, and not on subscription', async () => {
    const t = setup({ reply: () => ({ error: 'e' }) });
    const seen = [];
    const off = t.overlays.notice.subscribe((x) => seen.push(x));
    expect(seen).toEqual([]);
    await flush();
    await t.overlays.notice.refresh();
    expect(seen).toEqual(['e']);
    t.media.set({ connected: false });
    t.media.set({ connected: true });
    await flush();
    expect(seen).toEqual(['e', WAITING_TEXT, 'e']);
    off();
    t.media.set({ connected: false });
    expect(seen).toHaveLength(3);
  });

  it('works with no invoke at all, and shows a notice that was already set on a new mount', async () => {
    const clock = createManualClock();
    const media = createFakeMedia('stoppedQueue5', { clock });
    media.set({ connected: false });
    const overlays = createOverlays({ media });
    const host = document.createElement('div');
    expect(overlays.mount(host).notice.textContent).toBe(WAITING_TEXT);
    media.set({ connected: true });
    await flush();
    expect(overlays.notice.text()).toBe('');
    overlays.dispose();
  });

  it('uses the page timers when none are injected', () => {
    const media = createFakeMedia('stoppedQueue5');
    const overlays = createOverlays({ media });
    overlays.dispose();                                     // clears the real retry timer: nothing left to leak
  });

  it('sets the colour from a number, a hex string or a function, at mount time', () => {
    const colour = (noticeColor) => {
      const t = setup({ noticeColor });
      return t.mount().notice.style.getPropertyValue('--wh-notice');
    };
    expect(colour(0x77ce07)).toBe('#77ce07');
    expect(colour('#ABC')).toBe('#abc');
    expect(colour(() => 0x102030)).toBe('#102030');
    for (const bad of [undefined, null, -1, 0x1000000, 1.5, 'red', '#12', 'url(x)', () => 'javascript:1']) expect(colour(bad), String(bad)).toBe('');
    let late = null;                                        // the skin's colours exist only after it is built
    const t = setup({ noticeColor: () => late });
    const first = t.mount();
    late = 0x00ff00;
    expect(first.notice.style.getPropertyValue('--wh-notice')).toBe('');
    expect(t.mount().notice.style.getPropertyValue('--wh-notice')).toBe('#00ff00');
  });
});

describe('the caption', () => {
  it('is a hidden strip Viz can drive, last in paint order', () => {
    const t = setup();
    const m = t.mount();
    expect([...t.host.children].map((c) => c.className)).toEqual(['wh-toast', 'wh-notice', 'wh-caption hidden']);
    expect(m.caption.textContent).toBe('');
    // viz/index.js setCaption: textContent, and the `hidden` class off while there is text
    m.caption.textContent = 'hello';
    m.caption.classList.toggle('hidden', false);
    expect(m.caption.classList.contains('hidden')).toBe(false);
  });
});

// ---- the stylesheet is the hand port's -----------------------------------------------------------------

/** @param {string} text @returns {Array<{ selectors: string[], decls: Map<string, string> }>} */
function parseRules(text) {
  const out = [];
  const body = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
    }
    out.push({ selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
  }
  return out;
}

const ORACLE_CSS = resolve(here, '../../src/style.css');
const oracleExists = existsSync(ORACLE_CSS);   // deleted with the hand port at cutover (W6.2)

describe('overlays.css', () => {
  const mine = parseRules(OVERLAYS_CSS);
  const find = (rules, sel) => rules.find((r) => r.selectors.includes(sel));

  it('scopes every rule under the slot wrapper: no ids, no :root, body or html', () => {
    for (const rule of mine) {
      for (const sel of rule.selectors) {
        expect(sel, sel).toMatch(/^\.wh-fx\b/);
        expect(sel, sel).not.toMatch(/[#]|:root|\bbody\b|\bhtml\b/);
      }
    }
  });

  it('keeps the toast at the oracle\'s fade and the caption off the mask: no z-index anywhere', () => {
    expect(OVERLAYS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/z-index|mask/);
    expect(find(mine, '.wh-fx .wh-toast').decls.get('transition')).toBe('opacity 600ms');
  });

  // oracle selector -> [my selector, { set: changed values }, { add: new properties }]
  /** @type {Array<[string, string, Record<string, string>?, Record<string, string>?]>} */
  const PAIRS = [
    ['#nowPlaying', '.wh-fx .wh-toast'],
    ['#nowPlaying .artist', '.wh-fx .wh-toast .artist'],
    ['#nowPlaying.show', '.wh-fx .wh-toast.show'],
    ['#notice', '.wh-fx .wh-notice', { color: 'var(--wh-notice, #77ce07)' }],
    ['#caption', '.wh-fx .wh-caption'],
    ['.hidden', '.wh-fx .hidden'],
  ];

  describe.skipIf(!oracleExists)('against the pinned src/style.css', () => {
    const oracle = oracleExists ? parseRules(readFileSync(ORACLE_CSS, 'utf8')) : [];
    for (const [theirs, ours, set = {}, add = {}] of PAIRS) {
      it(`${theirs} is ${ours}`, () => {
        const a = find(oracle, theirs);
        const b = find(mine, ours);
        expect(a, `oracle has ${theirs}`).toBeDefined();
        expect(b, `overlays.css has ${ours}`).toBeDefined();
        const expected = new Map(a.decls);
        for (const [k, v] of Object.entries(set)) {
          expect(expected.has(k), `${theirs} has ${k}`).toBe(true);
          expected.set(k, v);
        }
        for (const [k, v] of Object.entries(add)) expected.set(k, v);
        expect(Object.fromEntries(b.decls)).toEqual(Object.fromEntries(expected));
      });
    }

    it('the canvas is `#skin img, #skin canvas` with `#skin #viz`\'s image-rendering override, at the slot\'s origin', () => {
      const generic = find(oracle, '#skin canvas').decls;
      const override = find(oracle, '#skin #viz').decls;
      const expected = new Map([...generic, ...override, ['left', '0'], ['top', '0']]);
      expect(Object.fromEntries(find(mine, '.wh-fx .wh-fx-viz').decls)).toEqual(Object.fromEntries(expected));
    });

    it('the wrapper clips and positions like `#screen`', () => {
      const screen = find(oracle, '#screen').decls;
      const wrapper = find(mine, '.wh-fx').decls;
      expect(wrapper.get('overflow')).toBe(screen.get('overflow'));
      expect(wrapper.get('position')).toBe('relative');     // the slot, not the page, is its containing block
    });
  });

  it('takes the page\'s font, smoothing and cursor onto the wrapper', () => {
    const w = find(mine, '.wh-fx').decls;
    expect(w.get('font')).toBe('9px Tahoma, Verdana, sans-serif');
    expect(w.get('-webkit-font-smoothing')).toBe('none');
    expect(w.get('cursor')).toBe('default');
  });
});
