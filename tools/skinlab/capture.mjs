// Legacy capture: the vite server for legacy.html, pinned Playwright Chromium, and one state at one
// DPR becoming a PNG plus the last hit mask the legacy recorded (E D9).
//
// Real time on purpose: the legacy runs on CSS transitions and timers, and settles on transitionend
// + 200 ms + two rAF. This module never calls page.clock.install, so performance.now stays real.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { skip, usageError } from './exit.mjs';
import { SKINLAB_DIR } from './paths.mjs';
import { BOOT_QUIET_MS, CLIP, PARK, SETTLE, STATES, VIEWPORT, resolveStep } from './states.mjs';
import { maskStats, sha256Hex } from './store.mjs';

const require = createRequire(import.meta.url);

// ---- Chromium ---------------------------------------------------------------------------------------

/** The pinned build: the revision playwright-core@1.63.0 installs, and whether it is installed. */
export function chromiumInfo() {
  const pkgFile = require.resolve('playwright-core/package.json'); // browsers.json is not in its exports map
  const playwrightVersion = JSON.parse(readFileSync(pkgFile, 'utf8')).version;
  const registry = JSON.parse(readFileSync(path.join(path.dirname(pkgFile), 'browsers.json'), 'utf8'));
  const entry = registry.browsers.find((b) => b.name === 'chromium');
  if (!entry) throw new Error('playwright-core browsers.json has no chromium entry');
  let executablePath = null;
  try {
    executablePath = chromium.executablePath();
  } catch {
    // no registry entry for this platform
  }
  return {
    playwrightVersion,
    revision: String(entry.revision),
    expectedVersion: entry.browserVersion,
    executablePath,
    installed: Boolean(executablePath && existsSync(executablePath)),
  };
}

/** Deterministic rendering: software raster, sRGB, no LCD text. Scrollbars stay (S3b is the Win2000 one). */
const LAUNCH_ARGS = ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none', '--disable-gpu'];

export async function launchBrowser({ headless = true, devtools = false } = {}) {
  const info = chromiumInfo();
  if (!info.installed) {
    throw skip(`Chromium ${info.revision} is not installed (run: npx playwright-core install chromium)`);
  }
  // Playwright's own registry build only: never system Chrome, whose updates would drift the goldens.
  if (!info.executablePath.includes(`chromium-${info.revision}`)) {
    throw usageError(`refusing ${info.executablePath}: not the Playwright chromium-${info.revision} build`);
  }
  try {
    return await chromium.launch({
      executablePath: info.executablePath,
      headless,
      args: devtools ? [...LAUNCH_ARGS, '--auto-open-devtools-for-tabs'] : LAUNCH_ARGS,
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
  } catch (e) {
    if (/Executable doesn't exist/.test(String(e?.message))) throw skip(`Chromium ${info.revision} is not installed`);
    throw e;
  }
}

// ---- the legacy page server -------------------------------------------------------------------------

export async function startLegacyServer() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(SKINLAB_DIR, 'vite.config.js'),
    configLoader: 'native', // no temp bundle of the config file
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('vite did not report a port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

/**
 * Run `fn({baseUrl, browser, chromium})` with a server and a browser, and tear both down.
 * Exits 77 (skip) when Chromium is missing.
 */
export async function withLegacySession(fn, { headless = true, devtools = false } = {}) {
  const info = chromiumInfo();
  if (!info.installed) throw skip(`Chromium ${info.revision} is not installed (run: npx playwright-core install chromium)`);
  const server = await startLegacyServer();
  let browser;
  try {
    browser = await launchBrowser({ headless, devtools });
    return await fn({ baseUrl: server.url, browser, chromium: { ...info, browserVersion: browser.version() } });
  } finally {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// ---- driving one state ------------------------------------------------------------------------------

const withTimeout = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** Open the page for `state` and collect everything that must not happen while it runs. */
export function watchPage(page) {
  const problems = [];
  let rejectBoot;
  const failed = new Promise((_, reject) => (rejectBoot = reject));
  failed.catch(() => {}); // only awaited while booting
  const note = (msg) => {
    problems.push(msg);
    rejectBoot(new Error(msg));
  };
  page.on('pageerror', (e) => note(`page error: ${e.stack ?? e.message ?? e}`));
  page.on('requestfailed', (r) => note(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) note(`HTTP ${r.status()}: ${r.url()}`);
  });
  return { problems, failed };
}

async function boot(page, watch, url) {
  await page.goto(url, { waitUntil: 'load' });
  await Promise.race([
    page.waitForFunction(() => window.__skinlab?.booted === true, null, { timeout: 30_000, polling: 50 }),
    watch.failed,
  ]);
  // Every image decoded, fonts ready: the mask the legacy recorded during boot is only trustworthy
  // once nothing is still loading.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.complete && img.naturalWidth > 0
          ? true
          : new Promise((resolve, reject) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', () => reject(new Error(`image failed: ${img.src}`)), { once: true });
            }),
      ),
    );
  });
  await page.waitForTimeout(BOOT_QUIET_MS); // main.js:587 refreshes the mask 300 ms after boot
  // main.js:586 refreshes it on window load too, which a cold image cache can miss. Replaying that
  // same event on a settled page means the boot mask never depends on load ordering.
  await page.evaluate(() => window.dispatchEvent(new Event('load')));
}

async function armSettle(page, settle) {
  if (settle.kind === 'none') return;
  const spec = { selector: settle.selector, property: settle.property, atMs: settle.atMs ?? 0 };
  if (settle.kind === 'transition') {
    await page.evaluate(({ selector, property }) => {
      window.__skinlabWait = new Promise((resolve) => {
        const h = (e) => {
          if (e.propertyName === property && e.target instanceof Element && e.target.matches(selector)) {
            document.removeEventListener('transitionend', h, true);
            resolve(true);
          }
        };
        document.addEventListener('transitionend', h, true);
      });
    }, spec);
  } else if (settle.kind === 'freeze') {
    // Pause the transition at `atMs` the instant it exists, before its first frame: deterministic
    // where "screenshot 60 ms after the click" is not.
    await page.evaluate(({ selector, property, atMs }) => {
      window.__skinlabWait = new Promise((resolve) => {
        const h = (e) => {
          if (e.propertyName === property && e.target instanceof Element && e.target.matches(selector)) {
            document.removeEventListener('transitionrun', h, true);
            for (const a of e.target.getAnimations()) {
              a.pause();
              a.currentTime = atMs;
            }
            resolve(true);
          }
        };
        document.addEventListener('transitionrun', h, true);
      });
    }, spec);
  } else {
    throw new Error(`unknown settle kind ${settle.kind}`);
  }
}

/** Boot the legacy in `state`'s media preset, click its way to the state, and wait until it is still. */
export async function driveState(page, watch, baseUrl, state) {
  await boot(page, watch, `${baseUrl}/tools/skinlab/legacy.html?media=${encodeURIComponent(state.media)}`);
  await page.mouse.move(PARK.x, PARK.y); // no hover in S1, and the same starting pointer everywhere
  await armSettle(page, state.settle);
  for (const step of state.steps) {
    const { kind, at } = resolveStep(step);
    if (kind === 'click') {
      await page.mouse.click(at.x, at.y);
      // Park straight away: the ear slides under the pointer and would otherwise light up a band.
      await page.mouse.move(PARK.x, PARK.y);
    } else {
      // move and down leave the pointer where it is (no park): the hover or pressed art is the state.
      // down is never released; the fresh context per capture ends it, and the legacy acts on pointerup.
      await page.mouse.move(at.x, at.y);
      if (kind === 'down') await page.mouse.down();
    }
  }
  if (state.settle.kind !== 'none') {
    await withTimeout(page.evaluate(() => window.__skinlabWait), SETTLE.transitionTimeoutMs, `${state.id}: ${state.settle.kind} of ${state.settle.selector}`);
  }
  await page.evaluate(
    async ({ afterMs, rafs }) => {
      await new Promise((r) => setTimeout(r, afterMs));
      for (let i = 0; i < rafs; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    },
    SETTLE,
  );
}

/**
 * Capture `state` at `dpr`. A fresh context per capture: no storage, cache or pointer carries over.
 * @returns {Promise<{state:string, dpr:number, png:Buffer, maskBits:Buffer, pngSha256:string, maskSha256:string,
 *                    popcount:number, bbox:object|null, details:object}>}
 */
export async function captureState(browser, baseUrl, state, dpr) {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: dpr,
    serviceWorkers: 'block',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
  });
  try {
    const page = await context.newPage();
    const watch = watchPage(page);
    await driveState(page, watch, baseUrl, state);

    const png = await page.screenshot({ clip: { ...CLIP }, omitBackground: true, type: 'png' });
    const snap = await page.evaluate(() => ({
      mask: window.__skinlab.lastMask(),
      maskUpdates: window.__skinlab.masks.length,
      calls: window.__skinlab.calls.map((c) => ({ cmd: c.cmd, unhandled: c.unhandled === true, msg: c.cmd === 'js_log' ? c.args?.msg : undefined })),
      earX: document.querySelector('.ear')?.getBoundingClientRect().x ?? null,
    }));

    const problems = [...watch.problems];
    for (const c of snap.calls) {
      if (c.cmd === 'js_log') problems.push(`legacy reported an error: ${c.msg}`);
      if (c.unhandled) problems.push(`legacy invoked an unhandled command: ${c.cmd}`);
    }
    if (!snap.mask) problems.push('the legacy never sent set_hit_mask');
    if (problems.length) throw new Error(`${state.id} @${dpr}x: ${problems.join('; ')}`);

    const maskBits = Buffer.from(snap.mask.b64, 'base64');
    const { popcount, bbox } = maskStats(maskBits, snap.mask.width, snap.mask.height);
    return {
      state: state.id,
      dpr,
      png,
      maskBits,
      pngSha256: sha256Hex(png),
      maskSha256: sha256Hex(maskBits),
      popcount,
      bbox,
      details: {
        maskWidth: snap.mask.width,
        maskHeight: snap.mask.height,
        maskUpdates: snap.maskUpdates,
        earX: snap.earX,
        calls: Object.fromEntries(
          [...new Set(snap.calls.map((c) => c.cmd))].map((cmd) => [cmd, snap.calls.filter((c) => c.cmd === cmd).length]),
        ),
      },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

export const stateById = (id) => {
  const s = STATES.get(id);
  if (!s) throw usageError(`unknown state "${id}"`);
  return s;
};
