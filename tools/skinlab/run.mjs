#!/usr/bin/env node
// skinlab dispatcher: `run.mjs <cmd> ...` imports ./cmd-<cmd>.mjs and runs its default export with
// the remaining arguments. Later tasks add commands by owning new cmd-*.mjs files; nothing here
// changes. Exit codes: 0 pass, 1 fail, 2 usage or wrong fixture, 77 skip (E D9).

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, ExitError } from './exit.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

function commands() {
  return readdirSync(dir)
    .map((f) => /^cmd-([a-z][a-z0-9-]*)\.mjs$/.exec(f)?.[1])
    .filter(Boolean)
    .sort();
}

function usage(out = console.error) {
  out(`usage: npm run skinlab -- <command> [options]\ncommands: ${commands().join(', ')}\nexit codes: 0 pass, 1 fail, 2 usage or wrong fixture, 77 skip`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') {
    usage(console.log);
    return EXIT.PASS;
  }
  // The name is matched against the files that exist, so it can never be a path.
  if (!cmd || !commands().includes(cmd)) {
    if (cmd) console.error(`unknown command "${cmd}"`);
    usage();
    return EXIT.USAGE;
  }
  const mod = await import(pathToFileURL(path.join(dir, `cmd-${cmd}.mjs`)).href);
  if (typeof mod.default !== 'function') throw new Error(`cmd-${cmd}.mjs has no default export`);
  return (await mod.default(rest)) ?? EXIT.PASS;
}

let code;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof ExitError) {
    console.error(e.message);
    code = e.code;
  } else {
    console.error(e?.stack ?? e);
    code = EXIT.FAIL;
  }
}
process.exitCode = code;
// A lingering handle (a dev server that was slow to close) must not hold the exit code hostage.
setTimeout(() => process.exit(code), 2000).unref();
