// @vitest-environment happy-dom
// G3.F5, end to end and without art: the committed Headspace sidecar's `attrs`, written to a PLAYLIST
// under origin 'sidecar', reach the W3.7 widget as the colours the oracle's playlist.css paints
// (parity S3/S3b). The chain is the real one: a skin built through the zip, scanner and builder, the
// real renderer's slot (its `SlotSpec.attrs` come from the element's attribute table), and
// `mountPlaylist` as the slot provider. The playlist element is the one `parity` H4 describes, written
// by hand here; the proof against the owner's archive is in sidecar.test.js.
import { afterEach, describe, expect, it } from 'vitest';
import { loadSidecar, sidecarAttrs } from '../../src/app/sidecar.js';
import { mountPlaylist } from '../../src/app/widgets/playlist.js';
import { createFakeMedia } from '../../src/hosts/test/media.js';
import { frame, mountSkin, view } from '../engine/render/helpers.js';

const HEADSPACE = '76a8662f469881bf5ed6eb93595042fdb188c65663135da6ff4dcd10b37bf85d';

/** parity H4: `<playlist id="pl">` 172x140, the skin's own two colours, nothing set for the item colours. */
const PLAYLIST = `<PLAYLIST id="pl" left="13" top="10" width="172" height="140" backgroundColor="#285F03" foregroundColor="white"
  columnsVisible="false" dropDownVisible="true" playlistItemsVisible="true" visible="false"/>`;

afterEach(() => { document.body.innerHTML = ''; });

/** A skin with the Headspace playlist whose slot is the real widget over a fake queue. */
async function mount() {
  const media = createFakeMedia('stoppedQueue5');
  const slots = { mount: (/** @type {HTMLElement} */ el, /** @type {any} */ spec, /** @type {any} */ win) => mountPlaylist(el, media, spec, win) };
  const s = await mountSkin({ wms: view(200, 160, PLAYLIST), slots });
  const pl = /** @type {NonNullable<ReturnType<typeof s.view.byId>>} */ (s.view.byId('pl'));
  const root = () => /** @type {HTMLElement} */ (s.root.querySelector('.wh-pl'));
  const vars = () => Object.fromEntries(
    ['--wh-pl-bg', '--wh-pl-fg', '--wh-pl-now', '--wh-pl-sel', '--wh-pl-sel-bg'].map((v) => [v, root().style.getPropertyValue(v)]),
  );
  return { s, pl, root, vars };
}

/**
 * Apply the sidecar's writes the way the shell will: after layout, under origin 'sidecar'.
 * @param {Awaited<ReturnType<typeof mount>>} t @param {boolean} compat
 */
async function applySidecar(t, compat) {
  const sidecar = /** @type {NonNullable<Awaited<ReturnType<typeof loadSidecar>>>} */ (await loadSidecar(HEADSPACE));
  for (const [ref, writes] of sidecarAttrs(sidecar, { compat })) {
    const el = t.s.view.byId(ref);
    if (el?.id === 'pl') for (const { name, value } of writes) el.set(name, value, 'sidecar');
  }
  frame(t.s);
}

describe('the Headspace sidecar and the playlist widget', () => {
  it('without the sidecar the widget gets WMP\'s item colours: green playing row, navy selection', async () => {
    const t = await mount();
    expect(t.vars()).toEqual({
      '--wh-pl-bg': '#285f03', '--wh-pl-fg': '#ffffff', '--wh-pl-now': '#00ff00', '--wh-pl-sel': '#ffffff', '--wh-pl-sel-bg': '#0a246a',
    });
  });

  it.each([false, true])('with the sidecar attrs (compat %s) it paints what playlist.css paints', async (compat) => {
    const t = await mount();
    await applySidecar(t, compat);
    expect(t.vars()).toEqual({
      '--wh-pl-bg': '#285f03',       // panel
      '--wh-pl-fg': '#ffffff',       // text
      '--wh-pl-now': '#a9ff2b',      // playing row
      '--wh-pl-sel': '#ffffff',      // selected text: the default highlighttext, as the oracle's .row.sel
      '--wh-pl-sel-bg': '#1c4702',   // selected row
    });
    // the playing row of the fake queue is the one the colour is for
    expect(t.root().querySelectorAll('.wh-pl-row.is-now')).toHaveLength(1);
  });

  it('the colours reach the widget by a later update of its spec, without remounting it', async () => {
    const t = await mount();
    const widget = t.root();
    await applySidecar(t, false);
    expect(t.root()).toBe(widget);
    expect(widget.style.getPropertyValue('--wh-pl-now')).toBe('#a9ff2b');
  });
});
