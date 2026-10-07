// @ts-check
// The generic demo driver (ENGINE.md D10.7), the part of `src/demo.js` that knows nothing about
// Headspace: a fake Windows 2000 cursor, glides, synthetic pointer events, the sync flash and the
// `record_*` timing. What to do and when is a `Choreography`, and where things are on screen comes from
// a `DemoTarget`; this file touches neither a skin id nor a pixel of art.
//
//   mpc sendmessage window_head "demo /path/to/soundtrack.wav"
//
// At t = 0 the whole view flashes white for 120 ms. The recorder starts on that frame, so trimming the
// screen recording at the flash lines it up with the soundtrack. Everything the tour reads from the
// outside world (time, hit testing, the recorder, the log) comes in through `TourEnv`, so skinlab runs
// the same code headless against a scripted clock.
//
// Synthetic `PointerEvent`s go to whatever `elementFromPoint` returns, which is the engine's input
// plane, so the picker handles the tour exactly as it handles a real mouse. They are not trusted
// events (`isTrusted` is false), so a press on bare skin never starts a native window drag.

/** @typedef {import('./target.js').DemoTarget} DemoTarget */
/** @typedef {import('./target.js').Point} Point */
/** @typedef {import('../../engine/contracts').EngineClock} EngineClock */

/**
 * @typedef {object} TourClock
 * @property {() => number} now                      ms
 * @property {(ms: number) => Promise<void>} sleep
 */
/**
 * @typedef {object} Recorder  the soundtrack side (Rust `record_start` / `record_stop`)
 * @property {() => Promise<unknown>} start
 * @property {(path: string) => Promise<unknown>} stop
 */
/**
 * @typedef {object} TourEnv
 * @property {TourClock} [clock]                     default: real time
 * @property {Document} [document]                   default: the page's
 * @property {(x: number, y: number) => Element | null} [elementFromPoint]   default: the document's
 * @property {Recorder} [record]                     default: the Tauri commands, loaded on demand
 * @property {(message: string) => void} [log]       default: Tauri's `js_log` when `record` defaulted, else silent
 */
/**
 * What a choreography may do. Points are client px, the space `DemoTarget` answers in.
 * @typedef {object} Director
 * @property {() => number} now                      ms on the tour clock
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(sec: number) => Promise<void>} until  wait until `sec` seconds after the sync flash
 * @property {() => number} elapsed                  seconds since the sync flash
 * @property {(x: number, y: number) => Point} viewPoint   view px to client px
 * @property {(p: Point) => void} moveTo
 * @property {(p: Point, ms: number) => Promise<void>} glide
 * @property {() => void} press
 * @property {() => void} release
 * @property {() => Promise<void>} click             press, 130 ms, release
 * @property {(message: string) => void} log
 */
/**
 * @typedef {object} Choreography
 * @property {string} name
 * @property {(target: DemoTarget, d: Director) => Promise<void>} stage    before the flash: set the scene
 * @property {(target: DemoTarget, d: Director) => Promise<void>} run      timed from the flash
 * @property {(target: DemoTarget, d: Director) => Promise<void>} [restore]   after the tour, even a failed one
 */

const CURSOR = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="19" shape-rendering="crispEdges">' +
    '<path d="M.5.5v15l4-4 3 7 2-1-3-7h5.5z" fill="#fff" stroke="#000"/></svg>',
)}`;

/** Above everything the engine draws, which stays far below 1000. */
const CURSOR_Z = 1000;
const FLASH_Z = 2000;
const FLASH_MS = 120;
const CLICK_HOLD_MS = 130;
const FRAME_MS = 16;

/** @param {number} t 0..1 */
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Real time. @type {TourClock} */
export const realClock = Object.freeze({
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/**
 * A tour clock over an `EngineClock`, so the test host's manual clock can run a tour in no real time.
 * @param {Pick<EngineClock, 'now' | 'setTimer'>} clock
 * @returns {TourClock}
 */
export const clockFromEngine = (clock) => ({
  now: () => clock.now(),
  sleep: (ms) => new Promise((resolve) => { clock.setTimer(ms, () => resolve(undefined)); }),
});

/**
 * The real recorder and log: Tauri commands. Loaded on demand so that nothing outside the app pulls
 * Tauri in.
 * @returns {Promise<{ record: Recorder, log: (message: string) => void }>}
 */
export async function tauriBridge() {
  const { invoke } = await import('@tauri-apps/api/core');
  return {
    record: { start: () => invoke('record_start'), stop: (path) => invoke('record_stop', { path }) },
    log: (message) => { invoke('js_log', { msg: message }).catch(() => {}); },
  };
}

/**
 * The cursor, the pointer state machine and the clock helpers for one tour.
 * @param {DemoTarget} target
 * @param {Required<Pick<TourEnv, 'clock' | 'document' | 'elementFromPoint' | 'log'>>} env
 * @returns {Director & { begin(): void, end(): void, startClock(): void, root: HTMLElement }}
 */
function createDirector(target, env) {
  const { clock, document: doc, elementFromPoint: hit } = env;
  const root = target.root();
  const cursor = doc.createElement('img');
  cursor.src = CURSOR;
  cursor.style.cssText = `position:absolute;z-index:${CURSOR_Z};pointer-events:none;width:12px;height:19px;`;

  /** @type {Point} */
  let pos = { x: 0, y: 0 };                                   // client px
  /** @type {Element | null} */
  let hovered = null;
  /** @type {Element | null} */
  let captured = null;
  /** @type {number | null} */
  let t0 = null;

  /** Client px to the cursor's coordinates inside the scaled root. @param {Point} p */
  const skinXY = (p) => {
    const r = root.getBoundingClientRect();
    const z = target.zoom();
    return { x: (p.x - r.left) / z, y: (p.y - r.top) / z };
  };

  /** @param {Element | null} node @param {string} type @param {{ buttons?: number }} [extra] */
  const fire = (node, type, extra = {}) => {
    node?.dispatchEvent(new PointerEvent(type, {
      clientX: pos.x,
      clientY: pos.y,
      bubbles: type !== 'pointerenter' && type !== 'pointerleave',
      cancelable: true,
      button: 0,
      buttons: extra.buttons ?? 0,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
    }));
  };

  /** @param {Point} p */
  const moveTo = (p) => {
    pos = p;
    const s = skinXY(p);
    cursor.style.left = `${s.x}px`;
    cursor.style.top = `${s.y}px`;
    if (captured) {
      fire(captured, 'pointermove', { buttons: 1 });
      return;
    }
    const under = hit(p.x, p.y);
    if (under !== hovered) {
      fire(hovered, 'pointerleave');
      hovered = under;
      fire(hovered, 'pointerenter');
    }
    fire(under, 'pointermove');
  };

  /** @param {Point} to @param {number} ms */
  const glide = async (to, ms) => {
    const from = { ...pos };
    const start = clock.now();
    for (;;) {
      const t = ms > 0 ? Math.min(1, (clock.now() - start) / ms) : 1;
      const k = ease(t);
      // The last step lands exactly on the target, not within a rounding error of it.
      moveTo(t >= 1 ? { ...to } : { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
      if (t >= 1) break;
      await clock.sleep(FRAME_MS);
    }
  };

  const press = () => {
    captured = hit(pos.x, pos.y);
    fire(captured, 'pointerdown', { buttons: 1 });
  };
  const release = () => {
    const node = captured;
    captured = null;
    fire(node, 'pointerup');
    // The engine ignores the DOM click; a plain DOM target gets the click it expects.
    node?.dispatchEvent(new MouseEvent('click', { clientX: pos.x, clientY: pos.y, bubbles: true }));
  };

  return {
    root,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    elapsed: () => (t0 === null ? 0 : (clock.now() - t0) / 1000),
    until: (sec) => clock.sleep(t0 === null ? 0 : Math.max(0, t0 + sec * 1000 - clock.now())),
    viewPoint(x, y) {
      const r = root.getBoundingClientRect();
      const z = target.zoom();
      return { x: r.left + x * z, y: r.top + y * z };
    },
    moveTo,
    glide,
    press,
    release,
    click: async () => {
      press();
      await clock.sleep(CLICK_HOLD_MS);
      release();
    },
    log: env.log,
    startClock: () => { t0 = clock.now(); },
    begin() {
      root.appendChild(cursor);
      doc.body.classList.add('demo');
    },
    end() {
      cursor.remove();
      doc.body.classList.remove('demo');
    },
  };
}

/**
 * Run one tour: set the scene, flash, record, perform, stop. A tour that fails still stops the recorder,
 * removes the cursor and runs the choreography's `restore`, then rejects with the original error.
 * @param {DemoTarget} target
 * @param {Choreography} choreography
 * @param {string} wavPath where the recorder writes the soundtrack (Rust accepts only /tmp, $TMPDIR and ~/Movies)
 * @param {TourEnv} [env]
 * @returns {Promise<void>}
 */
export async function runTour(target, choreography, wavPath, env = {}) {
  const bridge = env.record ? null : await tauriBridge();
  const record = /** @type {Recorder} */ (env.record ?? bridge?.record);
  const sink = env.log ?? bridge?.log ?? (() => {});
  const doc = env.document ?? globalThis.document;
  const log = (/** @type {string} */ m) => sink(`demo: ${m}`);
  const director = createDirector(target, {
    clock: env.clock ?? realClock,
    document: doc,
    elementFromPoint: env.elementFromPoint ?? ((x, y) => doc.elementFromPoint(x, y)),
    log,
  });

  /** @type {HTMLElement | null} */
  let flash = null;
  let recording = false;
  let completed = false;
  try {
    director.begin();
    await choreography.stage(target, director);

    // t = 0: the recorder starts, the view flashes, and the tour's clock starts with the flash.
    await record.start();
    recording = true;
    flash = doc.createElement('div');
    flash.style.cssText = `position:absolute;inset:0;background:#fff;z-index:${FLASH_Z};pointer-events:none;`;
    director.root.appendChild(flash);
    director.startClock();
    await director.sleep(FLASH_MS);
    flash.remove();
    log('started');

    await choreography.run(target, director);

    recording = false;
    await record.stop(wavPath).then(
      () => log(`wrote ${wavPath}`),
      (e) => log(`record failed: ${e}`),
    );
    completed = true;
  } finally {
    // An aborted tour must not leave the recorder running or a cursor over the owner's window.
    if (recording) await record.stop(wavPath).catch(() => {});
    flash?.remove();
    director.end();
    try {
      await choreography.restore?.(target, director);
    } catch (e) {
      log(`restore failed: ${e}`);
    }
    log(completed ? 'done' : 'aborted');
  }
}
