// Tests for tools/check-boundaries.mjs (ENGINE.md D8). The checker is exercised two ways: through
// `checkSource` for the rule matrix, and as a child process (`--root`, `--self-test --fixtures`)
// for exit codes and output. Every tree built here lives under os.tmpdir(); nothing is written
// into the repository.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSource } from '../../tools/check-boundaries.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = path.join(REPO, 'tools/check-boundaries.mjs');
const FIXTURES = path.join(REPO, 'tools/check-boundaries.fixtures');

/** @type {string[]} */
const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** @param {Record<string, string>} [files] repo-relative path -> text */
function makeTree(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-boundaries-'));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** @param {string[]} args @param {string} [cwd] */
function run(args, cwd = REPO) {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { encoding: 'utf8', cwd });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

/** Rules reported for one file, in report order. @param {string} file @param {string} text */
const rules = (file, text) => checkSource(file, text).map((v) => v.rule);

const ENGINE = 'src/engine/a.js';
const TEST_HOST = 'src/hosts/test/a.js';

describe('rule 1: forbidden imports under src/engine', () => {
  it.each([
    ["import { invoke } from '@tauri-apps/api/core';"],
    ["import '@tauri-apps/plugin-fs';"],
    ["export * from '../app/x.js';"],
    ["export { a } from '../hosts/test/index.js';"],
    ["import a from '../main.js';"],
    ["import a from '../main';"],
    ["import a from '../widgets.js';"],
    ["import a from '../player.js';"],
    ["import a from '../playlist.js';"],
    ["import a from '../viz/index.js';"],
    ["import a from '../viz';"],
    ["import a from '/src/app/boot.js';"],
    ["import a from '../main.js?raw';"],
    ["import a from '../App/boot.js';"],
    ["const m = await import('../app/x.js');"],
    ["/** @type {import('../app/boot').Shell} */"],
    ['const m = await import(`../hosts/test/index.js`);'],
  ])('flags %s', (source) => {
    expect(rules(ENGINE, source)).toEqual([1]);
  });

  // The specifier is found by `from '<spec>'` alone, so what sits in the clause before it does not
  // matter. A comment with an apostrophe or a semicolon in it used to hide the whole import.
  it.each([
    ["import {\n  invoke, // Tauri's IPC\n} from '@tauri-apps/api/core';"],
    ["import {\n  a, // it's here\n} from '../app/x.js';"],
    ["import { a /* a; b */ } from '../app/x.js';"],
    ["import {\n  a, // one; two\n  b, /* it's */\n} from '../hosts/test/index.js';"],
    ["export {\n  a, // it's here\n} from '../app/x.js';"],
    ["import { 'a-b' as ab } from '../app/x.js';"],
    ["import { 'from' as f } from '../app/x.js';"],
    ["import a from /* a comment */ '../app/x.js';"],
    ["import a from // it's here\n  '../app/x.js';"],
    ["import/**/'../app/x.js'"],
    ["import/**/('../app/x.js')"],
    ["import // it's here\n  '../app/x.js';"],
    ["const m = await import(// don't skip this\n  '../app/x.js');"],
  ])('flags an import with a comment or a quoted name in it: %j', (source) => {
    expect(rules(ENGINE, source)).toEqual([1]);
  });

  it('reports the line of the specifier for an import with a comment in its clause', () => {
    const [v] = checkSource(ENGINE, "import {\n  a, // it's here\n} from '../app/x.js';\n");
    expect(v).toMatchObject({ line: 3, rule: 1 });
  });

  it('reports a Tauri import once, as rule 1, not also as rule 2', () => {
    expect(rules(ENGINE, "import { invoke } from '@tauri-apps/api/core';")).toEqual([1]);
  });

  it('resolves relative to the importing file, not to src/engine', () => {
    expect(rules('src/engine/model/objects/a.js', "import '../../../app/x.js';")).toEqual([1]);
    // ../../app from model/objects is src/engine/app, an engine directory that merely shares a name.
    expect(rules('src/engine/model/objects/a.js', "import '../../app/x.js';")).toEqual([]);
    expect(rules('src/engine/render/dom/a.js', "import '../../../playlist.js';")).toEqual([1]);
  });

  it.each([
    ["import a from '../appendix.js';"],
    ["import a from '../viz-helpers.js';"],
    ["import a from '../player-utils.js';"],
    ["import a from '../../../../outside.js';"],
    ["import a from './contracts';"],
    ["/** @type {import('./contracts').CreateEngineFn} */"],
    ["/** @type {import('quickjs-emscripten-core').QuickJSContext} */"],
    // `from` followed by a string is a specifier; `from` as a method, a key or a name is not.
    ["const a = Array.from('../app/x.js');"],
    ["const a = Array.from(\"../app/x.js\");"],
    ["const from = '../app/x.js';"],
    ["const o = { from: '../app/x.js' };"],
    ["from('../app/x.js');"],
    ["const a = xfrom '../app/x.js';"],
    ["const a = fromage '../app/x.js';"],
    ["import {\n  a, // it's here\n} from './a.js';"],
    ["import { a /* a; b */ } from './a.js';"],
  ])('allows %s', (source) => {
    expect(rules(ENGINE, source)).toEqual([]);
  });

  it('names the file, the line of the specifier and the rule', () => {
    const [v] = checkSource('src/engine/x/y.js', "import {\n  a,\n  b,\n} from '../../app/z.js';\n");
    expect(v).toMatchObject({ file: 'src/engine/x/y.js', line: 4, rule: 1, name: 'forbidden-import' });
    expect(v.message).toContain('../../app/z.js');
  });
});

describe('rule 2: bare imports under src/engine', () => {
  it.each([
    ["import a from 'fflate';"],
    ["import a from 'jpeg-js';"],
    ["import a from 'quickjs-emscripten-core';"],
    ["import a from '@jitl/quickjs-wasmfile-release-sync';"],
    ["import a from '@jitl/quickjs-ng-wasmfile-release-sync';"],
    ["import a from 'fflate/esm/browser.js';"],
    ["import a from '@jitl/quickjs-wasmfile-release-sync/wasm';"],
    ["const a = await import('fflate');"],
    ['const a = await import("jpeg-js");'],
    ['const a = await import(`fflate`);'],
    ["const a = await import('./data.json', { with: { type: 'json' } });"],
    ["const a = await import(\n  /* a comment */ 'fflate',\n);"],
  ])('allows %s', (source) => {
    expect(rules(ENGINE, source)).toEqual([]);
  });

  it.each([
    ["import a from 'three';"],
    ["import a from 'vite';"],
    ["import a from 'node:fs';"],
    ["import a from 'fflate-evil';"],
    ["import a from 'jpeg-js2';"],
    ["import a from '@jitl/quickjs-other';"],
    ["import a from '@jitl';"],
    ["import a from 'https://cdn.example/x.js';"],
    ["import a from '//cdn.example/x.js';"],
    ["import a from 'data:text/javascript,1';"],
    ["import '';"],
    ["export * from 'three';"],
    ["const a = await import('three');"],
    ["/** @type {import('three').Scene} */"],
    ["import {\n  Scene, // three's scene\n} from 'three';"],
    ["import { Scene /* a; b */ } from 'three';"],
    ["import { 'a-b' as ab } from 'three';"],
    ["import 'three' // it's here"],
    ["import/**/'three'"],
    ["const a = await import(// don't skip this\n  'three');"],
  ])('flags %j', (source) => {
    expect(rules(ENGINE, source)).toEqual([2]);
  });

  // The checker documents that a `from '<spec>'` anywhere in the text is read as an import.
  it('reads `from` plus a string in a comment as an import, like any other text', () => {
    expect(rules(ENGINE, "// derived from 'three'")).toEqual([2]);
    expect(rules(ENGINE, "// derived from '../app/x.js'")).toEqual([1]);
    expect(rules(ENGINE, '// derived from "fflate"')).toEqual([]);
  });

  // The allow-list is a Set, so inherited object members are not on it.
  it.each(['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf'])(
    'does not let the specifier %s pass as allowed',
    (name) => {
      expect(rules(ENGINE, `import a from '${name}';`)).toEqual([2]);
      expect(rules(ENGINE, `const a = await import('${name}');`)).toEqual([2]);
    },
  );

  it.each([
    ['import(name)'],
    ["import('./x/' + name)"],
    ['import(`./${name}.js`)'],
    ['import(/* @vite-ignore */ name)'],
    ["import(flag ? 'fflate' : 'jpeg-js')"],
    // The parenthesis never closes, so there is no argument to read; skipping it would hide the import.
    ['import(name'],
    ["import('../app/x.js' "],
    ['import(// it\'s one\n name'],
  ])('reports a dynamic import with no single literal specifier: %s', (call) => {
    const [v] = checkSource(ENGINE, `const a = await ${call};`);
    expect(v).toMatchObject({ rule: 2 });
    expect(v.message).toContain('not one plain string literal');
  });

  it.each([
    ['// a dynamic import() call'],
    ['// a dynamic import(...) call'],
    ['const a = loader.import(name);'],
    ['const a = reimport(name);'],
    ['const a = important(name);'],
    // A line comment after the word is taken whole, so its apostrophes are not read as a specifier.
    ["// the import // it's one's thing's\nconst a = 1;"],
    ["// the import it's one's thing's\nconst a = 1;"],
  ])('does not mistake prose or a method for a dynamic import: %s', (source) => {
    expect(rules(ENGINE, source)).toEqual([]);
  });
});

describe('rule 3: banned sinks under src/engine', () => {
  // D8's list, copied here on purpose so the checker's list cannot shrink unnoticed.
  const SINKS = [
    'fetch(', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'eval(', 'new Function', 'Function(',
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', '__TAURI', 'localStorage',
    'sessionStorage', 'indexedDB',
  ];
  const PLAIN = 'src/engine/render/dom/a.js'; // not pure, so rule 5 stays out of the way

  it.each(SINKS)('flags %s', (token) => {
    expect(rules(PLAIN, `const x = a.${token};`)).toEqual([3]);
    expect(rules(PLAIN, `// ${token}`)).toEqual([3]);
    expect(rules(PLAIN, `const s = '${token}';`)).toEqual([3]);
  });

  it('reports one violation per line, naming every token on it', () => {
    expect(checkSource(PLAIN, 'new Function(body);')).toHaveLength(1);
    const [v] = checkSource(PLAIN, 'fetch(a); eval(b);');
    expect(v.message).toContain('"fetch("');
    expect(v.message).toContain('"eval("');
    expect(checkSource(PLAIN, 'fetch(a);\neval(b);').map((x) => x.line)).toEqual([1, 2]);
  });

  it('is a literal scan: look-alikes that contain a token are flagged too', () => {
    expect(rules(PLAIN, 'isFunction(x);')).toEqual([3]);
    expect(rules(PLAIN, 'prefetch(x);')).toEqual([3]);
  });

  it('exempts realm/prelude.js from rule 3 only', () => {
    const prelude = 'src/engine/realm/prelude.js';
    expect(rules(prelude, 'export const S = "fetch(1); eval(2); localStorage; new Function(3)";')).toEqual([]);
    expect(rules(prelude, "import a from 'three';")).toEqual([2]);
    expect(rules(prelude, "import a from '../../app/x.js';")).toEqual([1]);
    expect(rules(prelude, 'window.x;')).toEqual([5]);
  });

  it('exempts that exact path and nothing like it', () => {
    expect(rules('src/engine/prelude.js', 'eval(1);')).toEqual([3]);
    expect(rules('src/engine/realm/prelude.mjs', 'eval(1);')).toEqual([3]);
    expect(rules('src/engine/realm/sub/prelude.js', 'eval(1);')).toEqual([3]);
    expect(rules('src/engine/realm/prelude.js.bak.js', 'eval(1);')).toEqual([3]);
  });

  it('does not apply to the test host', () => {
    expect(rules(TEST_HOST, 'fetch(a); localStorage.x;')).toEqual([]);
  });
});

describe('rule 4: the test host imports no Tauri', () => {
  it.each([
    ["import { invoke } from '@tauri-apps/api/core';"],
    ["import '@tauri-apps/plugin-fs';"],
    ["export * from '@tauri-apps/api/window';"],
    ["const m = await import('@tauri-apps/api/event');"],
    ["import {\n  invoke, // Tauri's IPC\n} from '@tauri-apps/api/core';"],
    ["import { invoke /* a; b */ } from '@tauri-apps/api/core';"],
    ["import { 'invoke' as call } from '@tauri-apps/api/core';"],
    ["import/**/'@tauri-apps/plugin-fs';"],
    ["const m = await import(// don't skip this\n  '@tauri-apps/api/event');"],
  ])('flags %j', (source) => {
    expect(rules(TEST_HOST, source)).toEqual([4]);
    expect(rules('src/hosts/test/deep/b.js', source)).toEqual([4]);
  });

  it.each([
    ["import fs from 'node:fs';"],
    ["import { createEngine } from '../../engine/index.js';"],
    ["import a from 'anything-else';"],
    ["import a from '../../app/x.js';"],
    ['const m = await import(name);'],
    ['const m = await import(name'],
    ["import {\n  a, // it's here\n} from '../../engine/index.js';"],
  ])('allows %j', (source) => {
    expect(rules(TEST_HOST, source)).toEqual([]);
  });

  it('says rule 4 and names the file', () => {
    const [v] = checkSource('src/hosts/test/media.js', "import { invoke } from '@tauri-apps/api/core';");
    expect(v).toMatchObject({ file: 'src/hosts/test/media.js', line: 1, rule: 4, name: 'test-host-tauri' });
  });
});

describe('rule 5: pure directories name no document or window', () => {
  const PURE = [
    'archive/a.js', 'text/a.js', 'wms/a.js', 'image/decode/a.js', 'image/decode/sub/a.js', 'realm/a.js',
    'model/a.js', 'model/objects/a.js', 'layout/a.js', 'bind/a.js', 'anim/a.js', 'shape/a.js',
    'image/keying.js', 'image/probe.js', 'input/picker.js', 'wms/types.d.ts',
  ];
  const NOT_PURE = [
    'a.js', 'index.js', 'options.js', 'view-runtime.js', 'inspect.js', 'archive.js', 'image/service.js',
    'image/worker.js', 'image/keying-extra.js', 'image/decoder/a.js', 'input/dispatch.js', 'render/dom/a.js',
    'wms-notes/a.js', 'modeling/a.js', 'shapes/a.js',
  ];

  it.each(PURE)('flags window and document in %s', (rel) => {
    expect(rules(`src/engine/${rel}`, 'const w = window.innerWidth;')).toEqual([5]);
    expect(rules(`src/engine/${rel}`, 'const d = document;')).toEqual([5]);
  });

  it.each(NOT_PURE)('lets %s use them', (rel) => {
    expect(rules(`src/engine/${rel}`, 'const w = window.innerWidth, d = document;')).toEqual([]);
  });

  it('is a whole-word, case-sensitive match that comments and strings do not escape', () => {
    const f = 'src/engine/layout/a.js';
    expect(rules(f, 'const x = [SkinWindow, windowShape, documentOrder, subwindow, window_x, Window, Document];')).toEqual([]);
    expect(rules(f, 'const x = host.window;')).toEqual([5]);
    expect(rules(f, 'typeof window;')).toEqual([5]);
    expect(rules(f, '// the document')).toEqual([5]);
    expect(rules(f, "const s = 'window';")).toEqual([5]);
    expect(checkSource(f, 'window; document;')).toHaveLength(1); // one report per line
  });

  it('does not apply to the test host', () => {
    expect(rules(TEST_HOST, 'window.x; document.y;')).toEqual([]);
  });
});

describe('scope', () => {
  it('looks at nothing outside src/engine and src/hosts/test', () => {
    const bad = "import { invoke } from '@tauri-apps/api/core'; fetch(1); window.x;";
    for (const file of [
      'src/hosts/tauri/index.js', 'src/app/boot.js', 'src/main.js', 'src/demo.js', 'tools/x.mjs',
      'tests/engine/x.test.js', 'src/engineering/x.js', 'src/hosts/testing/x.js', 'src/engine.js',
    ]) {
      expect(rules(file, bad), file).toEqual([]);
    }
  });
});

describe('command line', () => {
  it('--self-test exits 0 and reports one caught violation per planted fixture, for every rule', () => {
    const r = run(['--self-test']);
    expect(r.status, r.all).toBe(0);

    const planted = [];
    for (const dir of ['src/engine', 'src/hosts/test']) {
      for (const file of readdirSync(path.join(FIXTURES, dir), { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const rel = path.posix.join(dir, path.relative(path.join(FIXTURES, dir), path.join(file.parentPath, file.name)).split(path.sep).join('/'));
        const markers = readFileSync(path.join(FIXTURES, rel), 'utf8').match(/@expect rule [1-5]/g) ?? [];
        for (const m of markers) planted.push({ rel, rule: Number(m.slice(-1)) });
      }
    }
    const caught = r.out.split('\n').filter((l) => l.startsWith('caught'));
    expect(caught).toHaveLength(planted.length);
    for (const { rel, rule } of planted) {
      expect(caught.some((l) => l.includes(`rule ${rule} `) && l.includes(`${rel}:`)), `${rel} rule ${rule}`).toBe(true);
    }
    for (const rule of [1, 2, 3, 4, 5]) expect(planted.some((p) => p.rule === rule), `rule ${rule}`).toBe(true);
    expect(r.out).toMatch(/clean +src\/engine\/realm\/prelude\.js/);
  });

  describe('--self-test fails when the checker stops catching something', () => {
    /** Copy the fixtures, apply `edit`, run the self-test against the copy. @param {(root: string) => void} edit */
    const mutated = (edit) => {
      const root = makeTree();
      cpSync(FIXTURES, root, { recursive: true });
      edit(root);
      return run(['--self-test', '--fixtures', root]);
    };

    it('passes on an unmodified copy', () => {
      expect(mutated(() => {}).status).toBe(0);
    });

    it('fails when a planted violation is defused', () => {
      const r = mutated((root) => writeFileSync(path.join(root, 'src/engine/rule3-fetch.js'), '// @expect rule 3\nexport const get = 1;\n'));
      expect(r.status).toBe(1);
      expect(r.err).toContain('src/engine/rule3-fetch.js: expected rules [3], checker reported []');
    });

    it('fails when a clean fixture starts tripping a rule', () => {
      const r = mutated((root) => writeFileSync(path.join(root, 'src/engine/realm/prelude.js'), "import a from 'three';\n"));
      expect(r.status).toBe(1);
      expect(r.err).toContain('src/engine/realm/prelude.js');
    });

    it('fails when a rule has no fixture left', () => {
      const r = mutated((root) => rmSync(path.join(root, 'src/hosts'), { recursive: true }));
      expect(r.status).toBe(1);
      expect(r.err).toContain('no fixture plants a caught violation of rule 4');
    });
  });

  it('exits 1 on a temporary file importing @tauri-apps/api/core under a copy of src/engine/, naming file and rule', () => {
    const root = makeTree();
    cpSync(path.join(REPO, 'src/engine'), path.join(root, 'src/engine'), { recursive: true });
    mkdirSync(path.join(root, 'src/engine/render/dom'), { recursive: true });
    writeFileSync(path.join(root, 'src/engine/zz-tmp-violation.js'), "import { invoke } from '@tauri-apps/api/core';\n");
    writeFileSync(path.join(root, 'src/engine/render/dom/zz-nested.js'), "\nimport { invoke } from '@tauri-apps/api/core';\n");
    const r = run(['--root', root]);
    expect(r.status, r.all).toBe(1);
    expect(r.err).toContain('src/engine/zz-tmp-violation.js:1: rule 1 (forbidden-import)');
    expect(r.err).toContain('src/engine/render/dom/zz-nested.js:2: rule 1 (forbidden-import)');
    expect(r.err).toContain('@tauri-apps/api/core');
  });

  it('exits 0 on a clean tree and counts the files it scanned', () => {
    const root = makeTree({
      'src/engine/index.js': "import { unzipSync } from 'fflate';\nexport { unzipSync };\n",
      'src/engine/wms/scan.js': 'export const scan = (s) => s;\n',
      'src/hosts/test/index.js': "import fs from 'node:fs';\nexport { fs };\n",
    });
    const r = run(['--root', root]);
    expect(r.status, r.all).toBe(0);
    expect(r.out).toContain('3 files scanned');
  });

  it('scans a root that has no src/hosts', () => {
    const root = makeTree({ 'src/engine/index.js': 'export {};\n' });
    expect(run(['--root', root]).status).toBe(0);
  });

  it('accepts --root=<dir>', () => {
    const root = makeTree({ 'src/engine/bad.js': 'eval(1);\n' });
    const r = run([`--root=${root}`]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('src/engine/bad.js:1: rule 3 (banned-sink)');
  });

  it('leaves non-code files, node_modules and out-of-scope trees alone', () => {
    const root = makeTree({
      'src/engine/index.js': 'export {};\n',
      'src/engine/table.json': '{"k":"fetch(window.document)"}\n',
      'src/engine/NOTES.md': 'innerHTML localStorage\n',
      'src/engine/node_modules/pkg/index.js': 'eval(1);\n',
      'src/app/boot.js': "import '@tauri-apps/api/core'; fetch(1);\n",
      'src/hosts/tauri/index.js': "import '@tauri-apps/api/core';\n",
    });
    expect(run(['--root', root]).status).toBe(0);
  });

  it('scans .mjs, .cjs, .ts and .d.ts files', () => {
    const root = makeTree({
      'src/engine/a.mjs': 'eval(1);\n',
      'src/engine/b.cjs': 'eval(1);\n',
      'src/engine/c.ts': 'eval(1);\n',
      'src/engine/d.d.ts': 'eval(1);\n',
    });
    const r = run(['--root', root]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('4 violation(s) in 4 file(s)');
  });

  it('uses the repository it lives in, not the working directory', () => {
    const elsewhere = makeTree();
    const r = run([], elsewhere);
    expect(r.status, r.all).not.toBe(2); // would be a usage error if it had scanned the empty cwd
    expect(r.all).toContain('check-boundaries');
  });

  it('exits 2 on bad usage', () => {
    expect(run(['--bogus']).status).toBe(2);
    expect(run(['--root']).status).toBe(2);
    expect(run(['--root', makeTree()]).status).toBe(2); // neither src/engine nor src/hosts/test
    expect(run(['--root', path.join(tmpdir(), 'check-boundaries-no-such-dir')]).status).toBe(2);
  });
});
