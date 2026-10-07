// @ts-check
// Keyboard defaults (ENGINE.md D10.5, parity D9). The skin's handlers run first: the engine's input
// dispatch listens on the document in the capture phase, runs the focused element's and then the VIEW's
// `onkeydown`/`onkeypress`/`onkeyup`, and calls `preventDefault()` on the event when one ran. This module
// listens on the window in the bubble phase, so it sees that verdict, and only an unhandled key reaches
// the defaults, which are the hand port's (`main.js:471-483`):
//
//   Space        play or pause          Left / Right   seek -5 s / +5 s
//   Up / Down    volume +5 / -5         V              next visualization
//
// Two slips of the hand port are fixed on the way over (parity D9). A key with Cmd, Ctrl or Alt held is
// not ours (Cmd-V no longer steps the visualization, Cmd-Space no longer pauses). And with no MPD mixer
// (`MediaState.volume === -1`) Up and Down do nothing: the hand port sent `setvol 4` for Up there.
//
// A default that does nothing leaves the event alone. A default that acts calls `preventDefault()`, so
// the page does not scroll and a second listener sees that the key is taken.

/** @typedef {import('../engine/contracts').MediaModel} MediaModel */
/** @typedef {import('../engine/contracts').EffectsControl} EffectsControl */

export const SEEK_STEP_SEC = 5;
export const VOLUME_STEP = 5;

/** A key typed into a text field belongs to the field. @param {EventTarget | null} t */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** MPD errors are not the shell's to show: a refused seek or volume change is simply a no-op. @param {Promise<unknown> | void} p */
const quiet = (p) => { Promise.resolve(p).catch(() => {}); };

/**
 * @param {{
 *   target?: EventTarget,
 *   media: MediaModel,
 *   effects?: () => EffectsControl | null | undefined,
 * }} deps `target` is the window; `effects` finds the effects slot's control for V (a skin without an
 *   EFFECTS element has none, and V does nothing)
 * @returns {{ dispose(): void }}
 */
export function attachKeys({ target = globalThis, media, effects }) {
  /** @param {Event} ev */
  function onKeyDown(ev) {
    const e = /** @type {KeyboardEvent} */ (ev);
    if (e.defaultPrevented || e.isComposing) return;           // a skin handler ran, or an IME owns the key
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target)) return;

    let acted = false;
    switch (e.key) {
      case ' ': {
        quiet(media.snapshot().playState === 'play' ? media.pause() : media.play());
        acted = true;
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const to = Math.max(0, media.elapsed() + (e.key === 'ArrowLeft' ? -SEEK_STEP_SEC : SEEK_STEP_SEC));
        quiet(media.seek(to));
        acted = true;
        break;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const volume = media.snapshot().volume;
        if (volume < 0) break;                                  // no mixer: nothing to change
        const next = volume + (e.key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP);
        quiet(media.setVolume(Math.min(100, Math.max(0, next))));
        acted = true;
        break;
      }
      case 'v': {
        const control = effects?.();
        if (!control) break;
        control.step(1);
        acted = true;
        break;
      }
      default:
        return;
    }
    if (acted) e.preventDefault();
  }

  target.addEventListener('keydown', onKeyDown);
  return { dispose: () => target.removeEventListener('keydown', onKeyDown) };
}
