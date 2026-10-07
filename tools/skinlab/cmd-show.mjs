// show --target legacy --state S2 [--dpr 1] [--headless]
// Opens the legacy in a headed Chromium with devtools, driven into the state, and waits until the
// window is closed. --headless runs the same path without a window and exits (smoke test).

import { driveState, stateById, watchPage, withLegacySession } from './capture.mjs';
import { parseOptions, requireLegacyTarget } from './common.mjs';
import { prepare } from './cmd-prepare.mjs';
import { EXIT, usageError } from './exit.mjs';
import { VIEWPORT, parseDprs, parseStateIds } from './states.mjs';

export default async function main(argv) {
  const { values } = parseOptions(argv, {
    target: { type: 'string' },
    state: { type: 'string' },
    dpr: { type: 'string' },
    headless: { type: 'boolean', default: false },
  });
  requireLegacyTarget(values.target, { required: true });
  if (!values.state) throw usageError('--state <id> is required');
  let id;
  let dpr;
  try {
    [id] = parseStateIds(values.state);
    [dpr] = parseDprs(values.dpr ?? '1');
    if (values.state.includes(',')) throw new Error('show takes one state');
  } catch (e) {
    throw usageError(e.message);
  }
  const state = stateById(id);

  await prepare();
  await withLegacySession(
    async ({ baseUrl, browser }) => {
      const context = await browser.newContext({ viewport: { ...VIEWPORT }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const watch = watchPage(page);
      await driveState(page, watch, baseUrl, state);
      const mask = await page.evaluate(() => ({ updates: window.__skinlab.masks.length, calls: window.__skinlab.calls.length }));
      console.log(`${state.id} (${state.title}) at ${dpr}x: ${mask.updates} mask update(s), ${mask.calls} stub call(s); problems: ${watch.problems.length}`);
      for (const p of watch.problems) console.error(`  ${p}`);
      if (values.headless) return;
      console.log('window is open; close it to exit. window.__skinlab holds the recorded stub calls.');
      await new Promise((resolve) => browser.on('disconnected', resolve));
    },
    { headless: values.headless, devtools: !values.headless },
  );
  return EXIT.PASS;
}
