// @ts-check
// The page's one module script (index.html). Both arms are dynamic imports, so the legacy path never
// fetches QuickJS and the engine path never fetches the hand port.
import { resolveMode } from './app/mode.js';

if (resolveMode() === 'engine') {
  await import('./app/boot.js');
} else {
  await import('./main.js');
  // As the entry script, main.js ran before the window `load` event, and its `load` listener
  // (main.js:586, the click-through mask pass once the skin art is in) fired after the images
  // arrived. Behind a dynamic import, `load` has usually fired already by the time that listener
  // exists, so replay it once the images are in. If `load` is still to come, the real one does
  // the job and nothing is replayed.
  if (document.readyState === 'complete') {
    await Promise.all(
      Array.from(document.querySelectorAll('img'), (img) =>
        img.complete
          ? null
          : new Promise((done) => {
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
            }),
      ),
    );
    window.dispatchEvent(new Event('load'));
  }
}
