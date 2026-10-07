// @vitest-environment happy-dom
// @ts-check
// createRenderer on a DOM without a 2D context: the layer tree and its order, the nodes' styles, the
// pixels each drawable hands to its canvas (read through a recording context), interaction state,
// "old pixels until new ones land", host slots, zoom, dispose and diffed writes. The in-Chromium
// counterparts (real compositing, masks, glyph metrics) are the skinlab fixtures.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInlineExecutor } from '../../../src/engine/image/service.js';
import { BLUE, GRAY, GREEN, RED, YELLOW, at, bmp, fakeWindow, frame, mountSkin, pixelsOf, recordingSlots, settle, stubCanvas, view } from './helpers.js';

/** @type {() => void} */
let restoreCanvas;
beforeEach(() => {
  restoreCanvas = stubCanvas();
  document.body.replaceChildren();
});
afterEach(() => restoreCanvas());

/** An executor that holds every job until `release()`. */
function manualExecutor() {
  const inline = createInlineExecutor();
  /** @type {Array<() => void>} */
  const held = [];
  return {
    run(/** @type {any} */ job) {
      return new Promise((resolve) => { held.push(() => resolve(inline.run(job))); });
    },
    held: () => held.length,
    release() { while (held.length) /** @type {() => void} */ (held.shift())(); },
  };
}

const px = (/** @type {number[]} */ c) => [...c, 255];

/** Wait for a condition the engine reaches on its own (a decode job reaching the executor). */
async function until(/** @type {() => boolean} */ cond) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

describe('layer tree and paint order', () => {
  it('builds div.view with the layers, the input plane, the windowed layer and the measurer', async () => {
    const s = await mountSkin({ wms: view(60, 40, '<SUBVIEW id="sv" left="2" top="3" width="20" height="10"/>') });
    const root = s.renderer.nodeOf(s.view.view);
    expect(root?.className).toBe('view');
    expect([...(root?.children ?? [])].map((n) => n.className)).toEqual(['layers', 'input', 'windowed', 'measure']);
    expect(s.renderer.plane).toBe(root?.children[1]);
    expect(s.renderer.windowed).toBe(root?.children[2]);
    expect(root?.parentElement).toBe(s.root);
    expect(root?.style.width).toBe('60px');
    expect(root?.style.height).toBe('40px');
    expect(root?.children[0].getAttribute('style')).toContain('pointer-events: none');
    expect(s.renderer.plane?.getAttribute('style')).toContain('pointer-events: auto');
  });

  it('orders a context\'s nodes by (z, document order) with the background at z 0 (E D2)', async () => {
    const img = bmp(2, 2, () => RED);
    const wms = view(40, 20, `<SUBVIEW id="sv" left="0" top="0" width="40" height="20">
        <BUTTON id="late" left="0" top="0" image="a.bmp" zIndex="1"/>
        <BUTTON id="neg" left="0" top="0" image="a.bmp" zIndex="-2"/>
        <BUTTON id="zero" left="0" top="0" image="a.bmp"/>
        <BUTTON id="late2" left="0" top="0" image="a.bmp" zIndex="1"/>
      </SUBVIEW>`);
    const s = await mountSkin({ wms, files: { 'a.bmp': img } });
    const ids = [...(s.renderer.nodeOf(s.view.byId('sv'))?.children ?? [])].map((n) => (n.className === 'bg' ? 'bg' : [...['late', 'neg', 'zero', 'late2']].find((id) => s.renderer.nodeOf(/** @type {any} */ (s.view.byId(id))) === n)));
    expect(ids).toEqual(['neg', 'bg', 'zero', 'late', 'late2']);
  });

  it('a runtime zIndex write re-sorts that parent and moves only what moved', async () => {
    const img = bmp(2, 2, () => RED);
    const wms = view(20, 20, `<SUBVIEW id="sv" left="0" top="0" width="20" height="20">
        <BUTTON id="a" left="0" top="0" image="a.bmp" zIndex="1"/>
        <BUTTON id="b" left="0" top="0" image="a.bmp" zIndex="1"/>
        <BUTTON id="c" left="0" top="0" image="a.bmp" zIndex="1"/>
      </SUBVIEW>`);
    const s = await mountSkin({ wms, files: { 'a.bmp': img } });
    const sv = /** @type {HTMLElement} */ (s.renderer.nodeOf(s.view.byId('sv')));
    const order = () => [...sv.children].map((n) => ['a', 'b', 'c'].find((id) => s.renderer.nodeOf(/** @type {any} */ (s.view.byId(id))) === n) ?? 'bg');
    expect(order()).toEqual(['bg', 'a', 'b', 'c']);
    s.view.byId('a')?.set('zIndex', 5, 'script');
    const moves = [];
    const mo = new MutationObserver((records) => moves.push(...records));
    mo.observe(sv, { childList: true });
    frame(s);
    await Promise.resolve();
    expect(order()).toEqual(['bg', 'b', 'c', 'a']);
    mo.disconnect();
  });

  it('a negative-z subview goes under the VIEW\'s own background', async () => {
    const s = await mountSkin({ wms: view(40, 20, '<SUBVIEW id="under" left="0" top="0" width="5" height="5" zIndex="-3"/><SUBVIEW id="over" left="0" top="0" width="5" height="5"/>') });
    const layers = s.renderer.nodeOf(s.view.view)?.children[0];
    expect([...(layers?.children ?? [])].map((n) => n.className)).toEqual(['sv', 'bg', 'sv']);
  });

  it('nested subviews are nested nodes; a PLAYER and a BUTTONELEMENT have no node', async () => {
    const wms = view(40, 20, `<PLAYER id="p"/>
      <SUBVIEW id="outer" left="0" top="0" width="30" height="20"><SUBVIEW id="inner" left="1" top="1" width="10" height="10"/></SUBVIEW>
      <BUTTONGROUP id="g" left="0" top="0" width="4" height="4"><BUTTONELEMENT id="e" mappingColor="#FF0000"/></BUTTONGROUP>`);
    const s = await mountSkin({ wms });
    expect(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('inner')))?.parentElement).toBe(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('outer'))));
    expect(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('p')))).toBeUndefined();
    expect(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('e')))).toBeUndefined();
  });

  it('ids named __proto__ and constructor are ordinary elements with their own nodes', async () => {
    const img = bmp(2, 2, () => RED);
    const wms = view(20, 20, '<BUTTON id="__proto__" left="1" top="1" image="a.bmp"/><BUTTON id="constructor" left="5" top="5" image="a.bmp"/>');
    const s = await mountSkin({ wms, files: { 'a.bmp': img } });
    const a = s.renderer.nodeOf(/** @type {any} */ (s.view.byId('__proto__')));
    const b = s.renderer.nodeOf(/** @type {any} */ (s.view.byId('constructor')));
    expect(a?.nodeName).toBe('CANVAS');
    expect(b?.nodeName).toBe('CANVAS');
    expect(a).not.toBe(b);
    expect(a?.style.left).toBe('1px');
    expect(b?.style.left).toBe('5px');
  });
});

describe('what the engine never writes', () => {
  it('no image element, no z-index, no markup setter, only the node kinds it makes', async () => {
    const setters = [];
    for (const prop of ['innerHTML', 'outerHTML']) {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
      if (d?.set) Object.defineProperty(Element.prototype, prop, { ...d, configurable: true, set(v) { setters.push(prop); return d.set?.call(this, v); } });
    }
    const img = bmp(4, 4, () => RED);
    const wms = view(60, 40, `<SUBVIEW id="sv" left="0" top="0" width="40" height="30" zIndex="-3" backgroundImage="a.bmp" backgroundTiled="true">
        <BUTTON id="b" left="1" top="1" image="a.bmp" zIndex="2"/><TEXT id="t" left="1" top="10" value="&lt;img src=x&gt;"/>
        <SLIDER id="s" left="2" top="20" width="20" height="6" backgroundImage="a.bmp" thumbImage="a.bmp"/>
      </SUBVIEW><EFFECTS id="fx" left="42" top="2" width="8" height="8"/><PLAYLIST id="pl" left="42" top="12" width="10" height="20"/>`);
    const s = await mountSkin({ wms, files: { 'a.bmp': img } });
    await settle(s);
    const seen = new Set();
    const mo = new MutationObserver((rs) => rs.forEach((r) => r.addedNodes.forEach((n) => seen.add(n.nodeName))));
    mo.observe(s.root, { childList: true, subtree: true });
    s.view.byId('b')?.set('zIndex', 7, 'script');
    frame(s);
    await Promise.resolve();
    mo.disconnect();
    const all = [...s.root.querySelectorAll('*')];
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((n) => n.nodeName === 'IMG' || n.nodeName === 'IFRAME' || n.nodeName === 'SCRIPT')).toEqual([]);
    expect(all.filter((n) => /** @type {HTMLElement} */ (n).style.zIndex !== '')).toEqual([]);
    expect(s.root.innerHTML).not.toMatch(/z-index/i);
    expect([...seen].filter((n) => n === 'IMG')).toEqual([]);
    expect(setters).toEqual([]);
    const t = s.renderer.nodeOf(/** @type {any} */ (s.view.byId('t')));
    expect(t?.children.length).toBe(0);
    expect(t?.textContent).toBe('<img src=x>');
  });
});

describe('BUTTON pixels and interaction state', () => {
  const solid = (c) => bmp(4, 3, () => c);

  async function skin() {
    const files = { 'up.bmp': solid(RED), 'hover.bmp': solid(GREEN), 'down.bmp': solid(BLUE), 'off.bmp': solid(GRAY), 'hd.bmp': solid(YELLOW) };
    const wms = view(30, 10, '<BUTTON id="b" left="2" top="2" image="up.bmp" hoverImage="hover.bmp" downImage="down.bmp" hoverDownImage="hd.bmp" disabledImage="off.bmp"/>');
    const s = await mountSkin({ wms, files });
    await settle(s);
    return { s, node: /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('b')))) };
  }

  it('paints the keyed image into a canvas of the button\'s box once the decode lands', async () => {
    const { node } = await skin();
    expect([node.width, node.height]).toEqual([4, 3]);
    expect(at(node, 0, 0)).toEqual(px(RED));
    expect(at(node, 3, 2)).toEqual(px(RED));
    expect(node.style.left).toBe('2px');
    expect(node.style.top).toBe('2px');
  });

  it('follows the pointer: hover, hoverDown, up again when the press is not over it', async () => {
    const { s, node } = await skin();
    const el = /** @type {any} */ (s.view.byId('b'));
    s.renderer.setPointer({ el }, null);
    expect(at(node, 1, 1)).toEqual(px(GREEN));
    s.renderer.setPointer({ el }, { el });
    expect(at(node, 1, 1)).toEqual(px(YELLOW));
    s.renderer.setPointer(null, { el });
    expect(at(node, 1, 1)).toEqual(px(RED));
    s.renderer.setPointer(null, null);
    expect(at(node, 1, 1)).toEqual(px(RED));
  });

  it('shows the disabled image when enabled is false, and the model decides (script write, frame)', async () => {
    const { s, node } = await skin();
    s.view.byId('b')?.set('enabled', false, 'script');
    frame(s);
    expect(at(node, 0, 0)).toEqual(px(GRAY));
    s.renderer.setPointer({ el: /** @type {any} */ (s.view.byId('b')) }, null);
    expect(at(node, 0, 0)).toEqual(px(GRAY)); // disabled beats hover
  });

  it('does not redraw a canvas whose picture has not changed', async () => {
    const { s, node } = await skin();
    const before = pixelsOf(node)?.puts;
    frame(s);
    s.renderer.setPointer(null, null);
    s.renderer.frame(new Map([[/** @type {any} */ (s.view.byId('b')), new Set(['image', 'enabled', 'down', 'width'])]]));
    expect(pixelsOf(node)?.puts).toBe(before);
  });
});

describe('old pixels until new ones land', () => {
  it('holds the picture while a replacement decodes, then shows it; a missing file clears it', async () => {
    const exec = manualExecutor();
    const files = { 'a.bmp': bmp(4, 3, () => RED), 'b.bmp': bmp(4, 3, () => GREEN) };
    const s = await mountSkin({ wms: view(10, 10, '<BUTTON id="b" left="0" top="0" image="a.bmp"/>'), files, executor: exec });
    const node = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('b'))));
    expect(pixelsOf(node)).toBeUndefined(); // nothing yet: the decode is held
    await until(() => exec.held() > 0);
    exec.release();
    await settle(s);
    expect(at(node, 0, 0)).toEqual(px(RED));

    s.view.byId('b')?.set('image', 'b.bmp', 'script');
    frame(s);
    await until(() => exec.held() > 0);
    expect(at(node, 0, 0)).toEqual(px(RED)); // still the old picture
    exec.release();
    await settle(s);
    expect(at(node, 0, 0)).toEqual(px(GREEN));

    s.view.byId('b')?.set('image', 'gone.bmp', 'script');
    frame(s);
    await settle(s);
    expect(at(node, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(s.diags.some((d) => d.code === 'image-missing')).toBe(true);
  });

  it('a late decode after dispose paints nothing and throws nothing', async () => {
    const exec = manualExecutor();
    const s = await mountSkin({ wms: view(10, 10, '<BUTTON id="b" left="0" top="0" image="a.bmp"/>'), files: { 'a.bmp': bmp(4, 3, () => RED) }, executor: exec });
    const node = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('b'))));
    s.renderer.dispose();
    await until(() => exec.held() > 0);
    exec.release();
    await settle(s);
    expect(pixelsOf(node)).toBeUndefined();
  });
});

describe('BUTTONGROUP', () => {
  async function skin(attrs = '', config = /** @type {'faithful' | 'compat'} */ ('faithful')) {
    const map = bmp(6, 2, (x) => (x < 2 ? [255, 0, 51] : x < 4 ? [0, 255, 0] : [9, 9, 9]));
    const files = { 'map.bmp': map, 'up.bmp': bmp(6, 2, () => RED), 'hover.bmp': bmp(6, 2, () => GREEN), 'down.bmp': bmp(6, 2, () => BLUE), 'off.bmp': bmp(6, 2, () => GRAY) };
    const wms = view(20, 10, `<BUTTONGROUP id="g" left="1" top="1" mappingImage="map.bmp" image="up.bmp" hoverImage="hover.bmp" downImage="down.bmp" disabledImage="off.bmp"${attrs}>
        <BUTTONELEMENT id="a" mappingColor="#FF0033"/><BUTTONELEMENT id="b" mappingColor="#00FF00"/></BUTTONGROUP>`);
    const s = await mountSkin({ wms, files, config });
    await settle(s);
    return { s, node: /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('g')))), g: /** @type {any} */ (s.view.byId('g')), a: /** @type {any} */ (s.view.byId('a')), b: /** @type {any} */ (s.view.byId('b')) };
  }

  it('paints owned pixels from their element\'s layer and leaves unowned ones clear (faithful default)', async () => {
    const { node } = await skin();
    expect(at(node, 0, 0)).toEqual(px(RED));
    expect(at(node, 3, 1)).toEqual(px(RED));
    expect(at(node, 4, 0)).toEqual([0, 0, 0, 0]);
    expect(at(node, 5, 1)).toEqual([0, 0, 0, 0]);
  });

  it('showBackground paints the unowned pixels from the up layer, declared or by the compat switch', async () => {
    expect(at((await skin(' showBackground="true"')).node, 5, 0)).toEqual(px(RED));
    expect(at((await skin('', 'compat')).node, 5, 0)).toEqual(px(RED));
    expect(at((await skin(' showBackground="false"', 'compat')).node, 5, 0)).toEqual([0, 0, 0, 0]);
  });

  it('a script that writes showBackground from then on decides', async () => {
    const { s, node, g } = await skin('', 'compat');
    expect(at(node, 5, 0)).toEqual(px(RED));
    // The model sees no change when a script writes the attribute's own default, so true, then false.
    g.set('showBackground', true, 'script');
    frame(s);
    expect(at(node, 5, 0)).toEqual(px(RED));
    g.set('showBackground', false, 'script');
    frame(s);
    expect(at(node, 5, 0)).toEqual([0, 0, 0, 0]);
  });

  it('hovering part 1 recomposites only that element\'s pixels', async () => {
    const { s, node, g } = await skin();
    s.renderer.setPointer({ el: g, part: 1 }, null);
    expect(at(node, 2, 0)).toEqual(px(GREEN));
    expect(at(node, 0, 0)).toEqual(px(RED));
    s.renderer.setPointer({ el: g, part: 0 }, { el: g, part: 0 });
    expect(at(node, 0, 0)).toEqual(px(BLUE)); // no hoverDown image: down
    expect(at(node, 2, 0)).toEqual(px(RED));
  });

  it('a BUTTONELEMENT target maps to its group and index', async () => {
    const { s, node, b } = await skin();
    s.renderer.setPointer({ el: b }, null);
    expect(at(node, 2, 0)).toEqual(px(GREEN));
  });

  it('element enabled, sticky and down change just that element', async () => {
    const { s, node, a, b } = await skin();
    b.set('enabled', false, 'script');
    frame(s);
    expect(at(node, 2, 0)).toEqual(px(GRAY));
    expect(at(node, 0, 0)).toEqual(px(RED));
    a.set('sticky', true, 'script');
    a.set('down', true, 'script');
    frame(s);
    expect(at(node, 0, 0)).toEqual(px(BLUE));
  });

  it('a group disabled disables every element', async () => {
    const { s, node, g } = await skin();
    g.set('enabled', false, 'script');
    frame(s);
    expect(at(node, 0, 0)).toEqual(px(GRAY));
    expect(at(node, 2, 0)).toEqual(px(GRAY));
  });

  it('a mapping colour change re-indexes the owners', async () => {
    const { s, node, a } = await skin();
    a.set('mappingColor', '#00FF00', 'script'); // a now names b's colour: first declared owns it, so a takes it
    frame(s);
    s.renderer.setPointer({ el: a, part: 0 }, null);
    expect(at(node, 2, 0)).toEqual(px(GREEN));
    expect(at(node, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('slots', () => {
  it('mounts EFFECTS in its context and PLAYLIST in the windowed layer, with view-px rects and folded attributes', async () => {
    const slots = recordingSlots();
    const wms = view(80, 50, `<SUBVIEW id="sv" left="5" top="4" width="40" height="30">
        <EFFECTS id="fx" left="2" top="3" width="10" height="8"/>
        <PLAYLIST id="pl" left="3" top="2" width="30" height="20" backgroundColor="#102030" onclick="x()"/>
      </SUBVIEW><VIDEO id="vid" left="60" top="2" width="10" height="10" backgroundColor="#445566"/>`);
    const s = await mountSkin({ wms, slots });
    const fx = slots.mounted.find((m) => m.kind === 'effects');
    const pl = slots.mounted.find((m) => m.kind === 'playlist');
    const vid = slots.mounted.find((m) => m.kind === 'video');
    expect(fx?.spec.rect).toEqual({ x: 7, y: 7, w: 10, h: 8 });
    expect(pl?.spec.rect).toEqual({ x: 8, y: 6, w: 30, h: 20 });
    expect(fx?.el.parentElement).toBe(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('sv'))));
    expect(pl?.el.parentElement).toBe(s.renderer.windowed);
    expect(pl?.el.style.left).toBe('8px');
    expect(vid?.el.style.backgroundColor).toBeTruthy();
    // attributes: every non-handler attribute, under its table name, in any letter case
    const attrs = pl?.spec.attrs;
    expect(attrs.get('backgroundColor')).toBe(0x102030);
    expect(attrs.get('BACKGROUNDCOLOR')).toBe(0x102030);
    expect(attrs.has('itemPlayingColor')).toBe(true);
    expect(attrs.has('onclick')).toBe(false);
    expect(attrs.get('constructor')).toBeUndefined();
    expect(s.renderer.slotOf(/** @type {any} */ (s.view.byId('fx')))).toBeDefined();
    expect(s.renderer.slotOf(/** @type {any} */ (s.view.byId('sv')))).toBeUndefined();
  });

  it('tells the slot where it went when an ancestor moves, and hides it with the ancestor', async () => {
    const slots = recordingSlots();
    const wms = view(80, 50, '<SUBVIEW id="sv" left="5" top="4" width="40" height="30"><EFFECTS id="fx" left="2" top="3" width="10" height="8"/></SUBVIEW>');
    const s = await mountSkin({ wms, slots });
    const fx = /** @type {any} */ (slots.mounted[0]);
    const n = fx.updates.length;
    s.view.byId('sv')?.set('left', 15, 'script');
    frame(s);
    expect(fx.spec.rect).toEqual({ x: 17, y: 7, w: 10, h: 8 });
    expect(fx.updates.length).toBe(n + 1);
    s.view.byId('sv')?.set('visible', false, 'script');
    frame(s);
    expect(fx.visible.at(-1)).toBe(false);
    s.view.byId('sv')?.set('visible', true, 'script');
    frame(s);
    expect(fx.visible.at(-1)).toBe(true);
  });

  it('disposes its slots with the renderer', async () => {
    const slots = recordingSlots();
    const s = await mountSkin({ wms: view(20, 20, '<EFFECTS id="fx" left="0" top="0" width="4" height="4"/>'), slots });
    s.renderer.dispose();
    expect(slots.mounted.every((m) => m.disposed)).toBe(true);
  });
});

describe('zoom, size, mount and dispose', () => {
  it('scales div.view by the window zoom, now and when it changes', async () => {
    const win = fakeWindow({ zoom: 1.5 });
    const s = await mountSkin({ wms: view(40, 20, ''), win });
    const root = /** @type {HTMLElement} */ (s.renderer.nodeOf(s.view.view));
    expect(root.style.transform).toBe('scale(1.5)');
    win.setZoomTo(1);
    expect(root.style.transform).toBe('');
    win.setZoomTo(2);
    expect(root.style.transform).toBe('scale(2)');
    win.setZoomTo(Number.NaN);
    expect(root.style.transform).toBe('');
  });

  it('follows the VIEW\'s size into the plane and the windowed layer', async () => {
    const s = await mountSkin({ wms: view(40, 20, '') });
    expect(s.renderer.plane?.style.width).toBe('40px');
    s.view.view.set('width', 90, 'script');
    frame(s);
    expect(s.renderer.plane?.style.width).toBe('90px');
    expect(s.renderer.windowed?.style.width).toBe('90px');
    expect(s.renderer.nodeOf(s.view.view)?.style.width).toBe('90px');
  });

  it('mounting again replaces the tree; dispose removes it and later frames do nothing', async () => {
    const s = await mountSkin({ wms: view(20, 20, '<BUTTON id="b" left="1" top="1" width="3" height="3"/>') });
    const first = s.renderer.nodeOf(s.view.view);
    s.renderer.mount(s.view);
    expect(first?.isConnected).toBe(false);
    expect(s.root.querySelectorAll('.view').length).toBe(1);
    const second = s.renderer.nodeOf(s.view.view);
    s.renderer.dispose();
    expect(second?.isConnected).toBe(false);
    expect(s.renderer.nodeOf(s.view.view)).toBeUndefined();
    expect(() => frame(s)).not.toThrow();
    expect(() => s.renderer.setPointer(null, null)).not.toThrow();
    s.renderer.mount(s.view); // a disposed renderer stays disposed
    expect(s.root.querySelectorAll('.view').length).toBe(0);
  });

  it('a hidden or faded element writes display and opacity', async () => {
    const s = await mountSkin({ wms: view(30, 20, '<SUBVIEW id="sv" left="0" top="0" width="10" height="10"/>') });
    const sv = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('sv'))));
    s.view.byId('sv')?.set('visible', false, 'script');
    s.view.byId('sv')?.set('alphaBlend', 51, 'script');
    frame(s);
    expect(sv.style.display).toBe('none');
    expect(sv.style.opacity).toBe('0.2');
    s.view.byId('sv')?.set('visible', true, 'script');
    s.view.byId('sv')?.set('alphaBlend', 255, 'script');
    frame(s);
    expect(sv.style.display).toBe('');
    expect(sv.style.opacity).toBe('');
  });

  it('a subview clips when it has a size and not when it has none; the option can turn it off', async () => {
    const wms = view(30, 20, '<SUBVIEW id="sized" left="0" top="0" width="10" height="10"/><SUBVIEW id="free" left="0" top="0"/>');
    const s = await mountSkin({ wms });
    expect(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('sized')))?.style.overflow).toBe('hidden');
    expect(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('free')))?.style.overflow).toBe('');
    const off = await mountSkin({ wms, opts: { subviewClip: false } });
    expect(off.renderer.nodeOf(/** @type {any} */ (off.view.byId('sized')))?.style.overflow).toBe('');
  });
});

describe('diffed writes', () => {
  it('an idle frame, even one that claims every attribute changed, writes nothing', async () => {
    const img = bmp(4, 4, () => RED);
    const wms = view(60, 40, `<SUBVIEW id="sv" left="2" top="2" width="40" height="30" backgroundColor="#223344">
        <BUTTON id="b" left="1" top="1" image="a.bmp"/><TEXT id="t" left="1" top="10" width="30" value="text"/>
        <SLIDER id="s" left="10" top="1" width="20" height="6" backgroundImage="a.bmp" thumbImage="a.bmp" value="30"/>
        <EFFECTS id="fx" left="2" top="20" width="6" height="6"/>
      </SUBVIEW>`);
    const s = await mountSkin({ wms, files: { 'a.bmp': img } });
    await settle(s);
    const mo = new MutationObserver(() => {});
    mo.observe(s.root, { attributes: true, childList: true, subtree: true, characterData: true });
    mo.takeRecords();
    const all = ['left', 'top', 'width', 'height', 'visible', 'alphablend', 'zindex', 'value', 'image', 'enabled', 'backgroundcolor', 'backgroundimage', 'fontsize', 'direction', 'min', 'max', 'tiled', 'slide', 'thumbimage'];
    s.renderer.frame(new Map(s.view.elements.map((el) => [el, new Set(all)])));
    await Promise.resolve();
    expect(mo.takeRecords().length).toBe(0);
    s.view.byId('b')?.set('left', 5, 'script');
    frame(s);
    const records = mo.takeRecords();
    expect(records.length).toBe(1);
    expect(records[0].target).toBe(s.renderer.nodeOf(/** @type {any} */ (s.view.byId('b'))));
    mo.disconnect();
  });
});

describe('TEXT', () => {
  /** Text widths from the number of characters: happy-dom has no layout. */
  let restoreWidth;
  beforeEach(() => {
    const d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return (this.textContent ?? '').length * 5; } });
    restoreWidth = () => (d ? Object.defineProperty(HTMLElement.prototype, 'offsetWidth', d) : delete (/** @type {any} */ (HTMLElement.prototype)).offsetWidth);
  });
  afterEach(() => restoreWidth());

  it('writes the oracle\'s box and text, and textWidth back to the model', async () => {
    const wms = view(120, 40, '<TEXT id="t" left="3" top="4" fontSize="7" foregroundColor="#77CE07" justification="Center" width="40" value="Hello"/>');
    const s = await mountSkin({ wms });
    const el = /** @type {any} */ (s.view.byId('t'));
    const n = /** @type {HTMLElement} */ (s.renderer.nodeOf(el));
    expect(n.tagName).toBe('SPAN');
    expect(n.textContent).toBe('Hello');
    for (const [prop, want] of [['left', '3px'], ['top', '4px'], ['width', '40px'], ['height', 'auto'], ['font-size', '9px'], ['color', '#77ce07'], ['text-align', 'center'], ['white-space', 'nowrap'], ['line-height', 'normal'], ['overflow', 'hidden'], ['text-overflow', 'ellipsis']]) {
      expect(n.style.getPropertyValue(/** @type {string} */ (prop)), String(prop)).toBe(want);
    }
    expect(el.get('textWidth')).toBe(25);
    s.view.byId('t')?.set('value', 'Hello world', 'script');
    frame(s);
    expect(n.textContent).toBe('Hello world');
    expect(el.get('textWidth')).toBe(55);
    // a skin cannot write the read-only textWidth
    expect(el.set('textWidth', 3, 'script')).toBe(false);
    expect(el.get('textWidth')).toBe(55);
  });

  it('a value is text, never markup', async () => {
    const s = await mountSkin({ wms: view(60, 20, '<TEXT id="t" left="0" top="0" value="&lt;b&gt;x&lt;/b&gt;"/>') });
    const n = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('t'))));
    expect(n.children.length).toBe(0);
    expect(n.textContent).toBe('<b>x</b>');
  });

  it('sanitises the font face and the flags', async () => {
    const wms = view(60, 20, '<TEXT id="t" left="0" top="0" fontFace="Arial, &quot;x}, Verdana" fontStyle="Bold Italic Underline Strikeout" value="x"/>');
    const s = await mountSkin({ wms });
    const n = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('t'))));
    expect(n.style.fontFamily).toContain('Arial');
    expect(n.style.fontFamily).not.toContain('}');
    expect(n.style.fontWeight).toBe('bold');
    expect(n.style.fontStyle).toBe('italic');
    expect(n.style.getPropertyValue('text-decoration-line')).toBe('underline line-through');
  });

  it('gets a black background with alphaBlend and none of its own; hover and disabled colours', async () => {
    const wms = view(60, 20, '<TEXT id="d" left="0" top="0" alphaBlend="100" value="x"/><TEXT id="h" left="0" top="10" foregroundColor="#FF0000" hoverForegroundColor="#00FF00" disabledForegroundColor="#808080" value="x"/>');
    const s = await mountSkin({ wms });
    const d = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('d'))));
    expect(d.style.backgroundColor).toBeTruthy();
    expect(d.style.opacity).toBe('0.392');
    const h = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('h'))));
    const el = /** @type {any} */ (s.view.byId('h'));
    expect(h.style.color).toBe('#ff0000');
    s.renderer.setPointer({ el }, null);
    expect(h.style.color).toBe('#00ff00');
    s.renderer.setPointer(null, null);
    el.set('enabled', false, 'script');
    frame(s);
    expect(h.style.color).toBe('#808080');
  });

  it('applies a sidecar overlay\'s letterSpacing, and only a safe one', async () => {
    const wms = view(60, 20, '<TEXT id="t" left="0" top="0" value="x"/>');
    const s = await mountSkin({ wms });
    const el = /** @type {any} */ (s.view.byId('t'));
    const n = /** @type {HTMLElement} */ (s.renderer.nodeOf(el));
    el.hostStyle = { letterSpacing: '-0.3px' };
    s.renderer.frame(new Map([[el, new Set(['value'])]]));
    expect(n.style.letterSpacing).toBe('-0.3px');
    el.hostStyle = { letterSpacing: '1px;color:red' };
    s.renderer.frame(new Map([[el, new Set(['value'])]]));
    expect(n.style.letterSpacing).toBe('');
  });

  it('a marquee steps on the clock it was given and only when the text overflows', async () => {
    let now = 0;
    const clock = { now: () => now };
    const wms = view(80, 40, `<TEXT id="m" left="0" top="0" width="20" scrolling="true" value="a long scrolling line"/>
      <TEXT id="fits" left="0" top="10" width="200" scrolling="true" value="x"/>
      <TEXT id="r" left="0" top="20" width="20" scrolling="true" scrollingDirection="Right" scrollingAmount="4" scrollingDelay="50" value="a long scrolling line"/>`);
    const s = await mountSkin({ wms, clock });
    const m = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('m'))));
    const r = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('r'))));
    const fits = /** @type {HTMLElement} */ (s.renderer.nodeOf(/** @type {any} */ (s.view.byId('fits'))));
    const tick = (t) => { now = t; frame(s); };
    tick(80);
    expect(m.style.textIndent).toBe('0px');
    tick(85);
    expect(m.style.textIndent).toBe('-6px');
    tick(170);
    expect(m.style.textIndent).toBe('-12px');
    expect(m.style.whiteSpace).toBe('pre');
    expect(m.textContent).toBe('a long scrolling line  a long scrolling line');
    expect(fits.style.textIndent).toBe('');
    tick(100); // 2 steps of 4 at 50 ms: cycle is 21 chars + 2 spaces = 115 px, so -115 + 8
    expect(r.style.textIndent).toBe(`${8 - 115}px`);
    // frame(dirty, now) overrides the clock
    s.renderer.frame(new Map(), 255);
    expect(m.style.textIndent).toBe('-18px');
  });
});
