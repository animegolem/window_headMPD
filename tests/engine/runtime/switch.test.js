// @ts-check
// 5F.6 (a): the single-window view switch. A script that hands the main window to another view of the
// theme (a write of `theme.currentViewID`, or `openView` from a view with no area) gets the switch after
// its dispatch: the old view's `onclose`, then the named view attached in the same window, sized to it,
// with a `view-switch` diagnostic. At most four switches a second; a loop gets a soft fault. The runtime
// `attach` returns stays the shell's handle across switches. Headless, Node; synthetic skins only.
import { describe, expect, it } from 'vitest';
import { MAX_SWITCHES_PER_SECOND } from '../../../src/engine/index.js';
import { createTestHost, open, skinZip, trace } from './helpers.js';

/**
 * A theme of several views. Each view is `[attrs, body]`; every view logs its load and its close.
 * @param {Array<[string, string, string?]>} views `[id, extra VIEW attributes, body]`
 */
const themeOf = (views) => `<THEME>\r\n${views.map(([id, attrs, body = '']) =>
  `<VIEW id="${id}" ${attrs} backgroundColor="none" titleBar="false" onload="theme.logString('load ${id}'); ${id.replace(/\W/g, '_')}Load();" onclose="theme.logString('close ${id}');">\r\n${body}\r\n</VIEW>`).join('\r\n')}\r\n</THEME>\r\n`;

/** The `skin: …` lines, without the prefix. @param {ReturnType<typeof createTestHost>} host */
const said = (host) => trace(host).filter((l) => l.startsWith('skin: ')).map((l) => l.slice(6));

/** Every view's `<id>Load()` defined, empty unless given. @param {string[]} ids @param {Record<string, string>} bodies */
const scriptOf = (ids, bodies) => ids.map((id) => `function ${id.replace(/\W/g, '_')}Load() { ${bodies[id] ?? ''} }`).join('\n');

describe('a splash that writes theme.currentViewID', () => {
  const wms = themeOf([
    ['splash', 'width="120" height="80"', '<text id="s" left="0" top="0" width="20" height="10" value="splash"/>'],
    ['mainView', 'width="300" height="200"', '<text id="m" left="0" top="0" width="20" height="10" value="main"/>'],
  ]);
  const js = `${scriptOf(['splash', 'mainView'], {
    splash: "view.width = 0; view.height = 0; theme.currentViewID = 'mainView'; theme.logString('after the write');",
  })}\nfunction where() { return theme.currentViewID; }`;

  it('hands the window over once its onload has run: onclose, then the named view, sized to it', async () => {
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    expect(runtime.viewId).toBe('mainView');
    expect(said(host)).toEqual(['load splash', 'after the write', 'close splash', 'load mainView']);
    expect(host.window.recorded.initialSizes).toEqual([{ w: 120, h: 80 }, { w: 300, h: 200 }]);
    expect(runtime.inspector.attr('m', 'value')).toBe('main');
    expect(runtime.inspector.find('s')).toBeNull();
    expect(runtime.inspector.callGlobal('where')).toBe('mainView');
    const sw = runtime.diagnostics().filter((d) => d.code === 'view-switch');
    expect(sw).toHaveLength(1);
    expect(sw[0].detail).toMatch(/theme\.currentViewID: .*"mainView" instead of "splash"/);
    expect(skin.diagnostics().map((d) => d.code)).toContain('view-switch');
    // A switch made is not a stub any more.
    expect(skin.ledger().filter((e) => e.api === 'theme.currentViewID')).toEqual([]);
    expect(runtime.maskShape().width).toBe(300);
  });

  it('keeps the runtime the shell holds: dispose closes the view shown now', async () => {
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    runtime.dispose();
    expect(said(host).at(-1)).toBe('close mainView');
    expect(runtime.health.unloaded).toBe(true);
    skin.dispose();
    expect(said(host).filter((l) => l === 'close mainView')).toHaveLength(1);
  });
});

describe('a splash that hands over to a control view that only opens the others', () => {
  const wms = themeOf([
    ['preview', 'width="100" height="100"'],
    ['controlView', ''],
    ['mainView', 'width="228" height="368"', '<text id="m" left="0" top="0" width="20" height="10" value="main"/>'],
    ['plView', 'width="240" height="157"'],
  ]);
  const js = scriptOf(['preview', 'controlView', 'mainView', 'plView'], {
    preview: "view.width = 0; view.height = 0; view.backgroundImage = ''; theme.currentViewID = 'controlView';",
    controlView: "if ('true' == theme.loadPreference('plViewer')) theme.openView('plView'); theme.openView('mainView');",
    mainView: "theme.openView('plView');",
  });

  it('ends on the view the control view opens, and never sizes the window to nothing', async () => {
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    expect(runtime.viewId).toBe('mainView');
    expect(said(host)).toEqual(['load preview', 'close preview', 'load controlView', 'close controlView', 'load mainView']);
    expect(host.window.recorded.initialSizes).toEqual([{ w: 100, h: 100 }, { w: 228, h: 368 }]);
    expect(runtime.diagnostics().filter((d) => d.code === 'view-switch').map((d) => d.detail.split(':')[0])).toEqual(['theme.currentViewID', 'theme.openView']);
    // mainView has an area, so its own openView is a second window: phase 3, a stub.
    expect(skin.ledger().find((e) => e.api === 'theme.openView')?.kind).toBe('stub');
  });

  it('takes the last view a dispatch opens', async () => {
    const { host, skin } = await open(skinZip({ wms, js }), { attach: false });
    host.prefs.write(skin.sha, 'plViewer', 'true');
    const runtime = await skin.attach();
    expect(runtime.viewId).toBe('mainView');
    expect(said(host)).toEqual(['load preview', 'close preview', 'load controlView', 'close controlView', 'load mainView']);
  });
});

describe('what does not switch', () => {
  it('a sized view opening another, an unknown id, the view shown, and a view on its way out', async () => {
    const wms = themeOf([
      ['mainView', 'width="200" height="100"'],
      ['eqView', 'width="100" height="50"'],
    ]);
    const js = `${scriptOf(['mainView', 'eqView'], {
      mainView: "theme.openView('eqView'); theme.currentViewID = 'noSuchView'; theme.currentViewID = 'MAINVIEW';",
    })}\nfunction leave() { theme.currentViewID = 'eqView'; }`;
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    expect(runtime.viewId).toBe('mainView');
    expect(skin.ledger().map((e) => [e.api, e.kind])).toEqual(expect.arrayContaining([['theme.openView', 'stub'], ['theme.currentViewID', 'stub']]));
    expect(host.window.recorded.initialSizes).toHaveLength(1);
    expect(runtime.diagnostics().some((d) => d.code === 'view-switch')).toBe(false);
  });

  it('an onclose that writes theme.currentViewID', async () => {
    const wms = `<THEME>
<VIEW id="a" width="50" height="50" onclose="theme.currentViewID = 'b';"><text id="t" left="0" top="0" width="5" height="5" value="a"/></VIEW>
<VIEW id="b" width="60" height="60" onload="theme.logString('load b');"/>
</THEME>`;
    const { host, runtime } = await open(skinZip({ wms }));
    runtime.dispose();
    await runtime.settled();
    expect(said(host)).toEqual([]);
    expect(host.window.recorded.initialSizes).toHaveLength(1);
  });
});

describe('a switch after load', () => {
  const wms = themeOf([
    ['full', 'width="200" height="100"', '<text id="f" left="0" top="0" width="20" height="10" value="full"/>'],
    ['mini', 'width="80" height="20"', '<text id="n" left="0" top="0" width="20" height="10" value="mini"/>'],
    ['tiny', 'width="40" height="10"'],
  ]);
  const js = `${scriptOf(['full', 'mini', 'tiny'], {})}
function toMini() { theme.currentViewID = 'tiny'; theme.currentViewID = 'mini'; theme.logString('handler ends'); }
function back() { theme.currentViewID = 'full'; }
function opened() { theme.openView('mini'); }`;

  it('runs after the dispatch, makes one switch for it (its last write), and the inspector follows', async () => {
    const { host, runtime } = await open(skinZip({ wms, js }));
    const handle = runtime.inspector;
    expect(runtime.viewId).toBe('full');
    runtime.inspector.callGlobal('toMini');
    expect(runtime.viewId).toBe('full');                      // not inside the dispatch
    expect(said(host).at(-1)).toBe('handler ends');
    await runtime.settled();
    expect(runtime.viewId).toBe('mini');
    expect(said(host).slice(-3)).toEqual(['handler ends', 'close full', 'load mini']);
    expect(handle.attr('n', 'value')).toBe('mini');
    expect(handle.find('f')).toBeNull();
    expect(host.window.recorded.initialSizes.at(-1)).toEqual({ w: 80, h: 20 });
    expect(runtime.diagnostics().filter((d) => d.code === 'view-switch')).toHaveLength(1);
  });

  it('calls the shell back after a dispatch of the view shown now', async () => {
    const { runtime } = await open(skinZip({ wms, js }));
    let n = 0;
    runtime.onDispatch(() => { n++; });
    runtime.inspector.callGlobal('toMini');
    await runtime.settled();
    const before = n;
    runtime.inspector.callGlobal('back');
    expect(n).toBeGreaterThan(before);
  });
});

describe('a skin that flips views in a loop', () => {
  const wms = themeOf([
    ['a', 'width="50" height="50"'],
    ['b', 'width="60" height="60"'],
  ]);
  const js = scriptOf(['a', 'b'], { a: "theme.currentViewID = 'b';", b: "theme.currentViewID = 'a';" });

  it(`switches ${MAX_SWITCHES_PER_SECOND} times in a second, then gets a soft fault and stays`, async () => {
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    expect(runtime.diagnostics().filter((d) => d.code === 'view-switch')).toHaveLength(MAX_SWITCHES_PER_SECOND);
    expect(runtime.viewId).toBe('a');
    expect(runtime.health.soft).toBe(1);
    expect(runtime.health.unloaded).toBe(false);
    expect(skin.ledger().find((e) => e.kind === 'soft-fault')).toMatchObject({ api: 'theme.currentViewID', count: 1 });
    expect(runtime.diagnostics().filter((d) => d.code === 'view-switch-cap')).toHaveLength(1);
    expect(host.recorded.faults).toEqual([]);

    // A second later the window may switch again (and the loop is cut again).
    host.clock.advance(1000);
    runtime.inspector.callGlobal('aLoad');
    await runtime.settled();
    expect(runtime.diagnostics().filter((d) => d.code === 'view-switch')).toHaveLength(2 * MAX_SWITCHES_PER_SECOND);
    expect(runtime.health.soft).toBe(2);
  });
});

describe('a loop slower than the cap', () => {
  it('does not keep attach waiting for good, and stops when the window is disposed', async () => {
    const wms = themeOf([
      ['a', 'width="50" height="50"'],
      ['b', 'width="60" height="60"'],
    ]);
    const js = scriptOf(['a', 'b'], { a: "theme.currentViewID = 'b';", b: "theme.currentViewID = 'a';" });
    const host = createTestHost();
    // Every read of the engine clock is 300 ms later, so no second ever holds four switches.
    let t = 0;
    host.clock.now = () => (t += 300);
    const { runtime } = await open(skinZip({ wms, js }), { host });
    const made = runtime.diagnostics().filter((d) => d.code === 'view-switch').length;
    expect(made).toBeGreaterThanOrEqual(MAX_SWITCHES_PER_SECOND);
    expect(made).toBeLessThanOrEqual(MAX_SWITCHES_PER_SECOND + 2);
    expect(runtime.health.soft).toBe(0);
    runtime.dispose();
    await runtime.settled();
    const after = host.window.recorded.initialSizes.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(host.window.recorded.initialSizes.length).toBeLessThanOrEqual(after + 1);   // at most the attach in flight
  });
});

describe('view ids a lookup must not inherit', () => {
  it('switches to views named __proto__ and constructor, and not to toString', async () => {
    const wms = `<THEME>
<VIEW id="start" width="50" height="50" onload="theme.currentViewID = '__proto__';"/>
<VIEW id="__proto__" width="60" height="60" onload="theme.logString('proto'); theme.currentViewID = 'constructor';"/>
<VIEW id="constructor" width="70" height="70" onload="theme.logString('ctor'); theme.currentViewID = 'toString';"/>
</THEME>`;
    const { host, runtime, skin } = await open(skinZip({ wms }));
    expect(runtime.viewId).toBe('constructor');
    expect(said(host)).toEqual(['proto', 'ctor']);
    expect(host.window.recorded.initialSizes.map((s) => s.w)).toEqual([50, 60, 70]);
    expect(skin.ledger().find((e) => e.api === 'theme.currentViewID')?.kind).toBe('stub');
  });
});

describe('a view that cannot start', () => {
  it('leaves the window as last painted and tells the shell', async () => {
    const wms = themeOf([
      ['a', 'width="50" height="50"'],
      ['b', 'width="60" height="60"'],
    ]);
    const js = `${scriptOf(['a', 'b'], {})}\nfunction go() { theme.currentViewID = 'b'; }`;
    const { host, runtime } = await open(skinZip({ wms, js }));
    host.prefs.load = () => Promise.reject(new Error('disk gone'));
    runtime.inspector.callGlobal('go');
    await runtime.settled();
    expect(host.recorded.faults).toHaveLength(1);
    expect(host.recorded.faults[0]).toMatch(/view "b" could not start: disk gone/);
    expect(runtime.diagnostics().map((d) => d.code)).toContain('view-switch-failed');
    expect(runtime.health.unloaded).toBe(true);
  });
});

describe('attach once a hand-over has happened (5F.8)', () => {
  const wms = themeOf([
    ['splash', 'width="120" height="80"'],
    ['mainView', 'width="300" height="200"'],
  ]);
  const js = scriptOf(['splash', 'mainView'], { splash: "theme.currentViewID = 'mainView';" });

  it('refuses every view while the main window is up, the one switched to included', async () => {
    const { host, runtime, skin } = await open(skinZip({ wms, js }));
    expect(runtime.viewId).toBe('mainView');
    // `attach` was keyed on the view it started with, so asking for the view shown now got through.
    await expect(skin.attach('mainView')).rejects.toThrow(/already attached.*"mainView"/);
    await expect(skin.attach('splash')).rejects.toThrow(/already attached.*"mainView"/);
    await expect(skin.attach()).rejects.toThrow(/already attached/);
    expect(host.window.recorded.initialSizes).toEqual([{ w: 120, h: 80 }, { w: 300, h: 200 }]);   // nothing was mounted
    expect(said(host)).toEqual(['load splash', 'close splash', 'load mainView']);
    runtime.dispose();
    const again = await skin.attach('mainView');
    expect(again.viewId).toBe('mainView');
    skin.dispose();
  });

  it('lets one of two attaches that overlap through', async () => {
    const { host, skin } = await open(skinZip({ wms, js }), { attach: false });
    const results = await Promise.allSettled([skin.attach('splash'), skin.attach('mainView')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(/** @type {PromiseRejectedResult} */ (results[1]).reason.message).toMatch(/already attached \(view "splash" is still opening\)/);
    expect(host.window.recorded.initialSizes).toEqual([{ w: 120, h: 80 }, { w: 300, h: 200 }]);
    skin.dispose();
  });

  it('takes attach again after one that failed, and after the window was disposed with the skin', async () => {
    const { host, skin } = await open(skinZip({ wms, js }), { attach: false });
    const load = host.prefs.load;
    host.prefs.load = () => Promise.reject(new Error('disk gone'));
    await expect(skin.attach()).rejects.toThrow(/disk gone/);
    host.prefs.load = load;
    const rt = await skin.attach();
    expect(rt.viewId).toBe('mainView');
    skin.dispose();
    expect(rt.health.unloaded).toBe(true);
    await expect(skin.attach()).rejects.toThrow(/disposed/);
  });
});

describe('a first view with no area (5F.8)', () => {
  /** A host that refuses a window size of 0, as Tauri's does. */
  const strictHost = () => {
    const host = createTestHost();
    const real = host.window.setInitialSize.bind(host.window);
    host.window.setInitialSize = async (w, h) => {
      if (!(w > 0 && h > 0)) throw new RangeError(`the window size ${w}x${h} is not positive`);
      return real(w, h);
    };
    return host;
  };

  it('never sizes the window to nothing; the view it hands over to sizes it', async () => {
    const wms = `<THEME>
<VIEW id="control" titleBar="false" backgroundColor="none" onload="theme.logString('load control'); theme.currentViewID = 'mainView';"/>
<VIEW id="mainView" width="90" height="60" titleBar="false" backgroundColor="none" onload="theme.logString('load mainView');"/>
</THEME>`;
    const host = strictHost();
    const { runtime } = await open(skinZip({ wms }), { host });
    expect(runtime.viewId).toBe('mainView');
    expect(said(host)).toEqual(['load control', 'load mainView']);
    expect(host.window.recorded.initialSizes).toEqual([{ w: 90, h: 60 }]);
    expect(host.recorded.faults).toEqual([]);
  });

  it('is shown as it is when it hands over to nobody', async () => {
    const wms = '<THEME><VIEW id="control" titleBar="false" backgroundColor="none"/></THEME>';
    const host = strictHost();
    const { runtime } = await open(skinZip({ wms }), { host });
    expect(runtime.viewId).toBe('control');
    expect(runtime.health.unloaded).toBe(false);
    expect(host.window.recorded.initialSizes).toEqual([]);
  });
});
