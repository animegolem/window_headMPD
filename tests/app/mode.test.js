// @vitest-environment happy-dom
// resolveMode (ENGINE.md §2): query beats storage beats env, every read in a try/catch, default
// legacy. Two layers: injected sources pin the precedence rules exactly, and the page's own readers
// (happy-dom's location and localStorage, vi.stubEnv for VITE_ENGINE) pin that the real wiring reads
// the right places. A last block checks that entry.js imports exactly one of main.js or boot.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODE, resolveMode } from '../../src/app/mode.js';

const throws = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};
/** @param {string | null | undefined} v */
const returns = (v) => () => v;
/** @param {Partial<Record<'query' | 'storage' | 'env', () => string | null | undefined>>} over */
const sources = (over = {}) => ({
  query: returns(null),
  storage: returns(null),
  env: returns(undefined),
  ...over,
});

describe('resolveMode: precedence over injected sources', () => {
  it('defaults to legacy when no source holds a value', () => {
    expect(DEFAULT_MODE).toBe('legacy');
    expect(resolveMode(sources())).toBe('legacy');
  });

  it.each([
    ['query', 'query'],
    ['storage', 'storage'],
    ['env', 'env'],
  ])('%s alone selects the engine with "wmp"', (name) => {
    expect(resolveMode(sources({ [name]: returns('wmp') }))).toBe('engine');
  });

  it('query beats storage and env, both ways', () => {
    expect(resolveMode(sources({ query: returns('wmp'), storage: returns('legacy'), env: returns('legacy') }))).toBe('engine');
    expect(resolveMode(sources({ query: returns('legacy'), storage: returns('wmp'), env: returns('wmp') }))).toBe('legacy');
  });

  it('storage beats env, both ways', () => {
    expect(resolveMode(sources({ storage: returns('wmp'), env: returns('legacy') }))).toBe('engine');
    expect(resolveMode(sources({ storage: returns('legacy'), env: returns('wmp') }))).toBe('legacy');
  });

  it('the first source with a value decides, not the first one that says wmp', () => {
    expect(resolveMode(sources({ query: returns('legacy'), env: returns('wmp') }))).toBe('legacy');
  });

  it.each([null, undefined, '', 'WMP', 'wmp ', 'engine', 'junk'])(
    'an unrecognised value (%j) counts as unset and the next source decides',
    (junk) => {
      expect(resolveMode(sources({ query: returns(junk), storage: returns('wmp') }))).toBe('engine');
      expect(resolveMode(sources({ query: returns(junk), storage: returns(junk) }))).toBe('legacy');
    },
  );

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'the object-prototype name %s is an unknown value, not an engine request',
    (name) => {
      expect(resolveMode(sources({ query: returns(name) }))).toBe('legacy');
      expect(resolveMode(sources({ query: returns(name), env: returns('wmp') }))).toBe('engine');
    },
  );
});

describe('resolveMode: throwing sources', () => {
  it('a throwing storage falls back to env, then to legacy', () => {
    expect(resolveMode(sources({ storage: throws, env: returns('wmp') }))).toBe('engine');
    expect(resolveMode(sources({ storage: throws, env: returns('legacy') }))).toBe('legacy');
    expect(resolveMode(sources({ storage: throws }))).toBe('legacy');
  });

  it('a throwing query falls back to storage', () => {
    expect(resolveMode(sources({ query: throws, storage: returns('wmp') }))).toBe('engine');
  });

  it('a throwing env still lets an earlier source win, and falls to legacy otherwise', () => {
    expect(resolveMode(sources({ storage: returns('wmp'), env: throws }))).toBe('engine');
    expect(resolveMode(sources({ env: throws }))).toBe('legacy');
  });

  it('every source throwing is legacy, never an exception', () => {
    expect(resolveMode({ query: throws, storage: throws, env: throws })).toBe('legacy');
  });
});

describe('resolveMode: the page\'s own sources', () => {
  /** @param {string} search */
  const setSearch = (search) => window.happyDOM.setURL(`http://localhost:1420/${search}`);

  beforeEach(() => {
    setSearch('');
    localStorage.clear();
    vi.stubEnv('VITE_ENGINE', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
    setSearch('');
  });

  it('defaults to legacy on a bare page', () => {
    expect(resolveMode()).toBe('legacy');
  });

  it('reads ?engine=wmp from the page URL, among other parameters', () => {
    setSearch('?x=1&engine=wmp');
    expect(resolveMode()).toBe('engine');
  });

  it('reads localStorage.engine', () => {
    localStorage.setItem('engine', 'wmp');
    expect(resolveMode()).toBe('engine');
  });

  it('reads VITE_ENGINE', () => {
    vi.stubEnv('VITE_ENGINE', 'wmp');
    expect(resolveMode()).toBe('engine');
  });

  it('query beats storage beats env through the real readers', () => {
    vi.stubEnv('VITE_ENGINE', 'wmp');
    localStorage.setItem('engine', 'legacy');
    expect(resolveMode()).toBe('legacy');
    setSearch('?engine=wmp');
    expect(resolveMode()).toBe('engine');
    localStorage.setItem('engine', 'wmp');
    setSearch('?engine=legacy');
    expect(resolveMode()).toBe('legacy');
  });

  it('a localStorage whose accessor throws falls back to env, then legacy', () => {
    // Browsers throw on the property access itself (blocked site data, some private windows).
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: throws });
    try {
      expect(resolveMode()).toBe('legacy');
      vi.stubEnv('VITE_ENGINE', 'wmp');
      expect(resolveMode()).toBe('engine');
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
      else delete globalThis.localStorage;
    }
  });

  it('a localStorage whose getItem throws falls back to env, then legacy', () => {
    vi.stubGlobal('localStorage', { getItem: throws });
    expect(resolveMode()).toBe('legacy');
    vi.stubEnv('VITE_ENGINE', 'wmp');
    expect(resolveMode()).toBe('engine');
  });
});

describe('entry.js chooses exactly one front end', () => {
  // Stand-ins for the two front ends: importing the real ones would start the legacy app or QuickJS.
  const calls = /** @type {string[]} */ ([]);

  // A mock factory's result is cached across vi.resetModules(), so each test registers fresh
  // factories; the call log then shows which front ends this one entry.js evaluation imported.
  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
    vi.doMock('../../src/main.js', () => {
      calls.push('main');
      return {};
    });
    vi.doMock('../../src/app/boot.js', () => {
      calls.push('boot');
      return {};
    });
    window.happyDOM.setURL('http://localhost:1420/');
    localStorage.clear();
    vi.stubEnv('VITE_ENGINE', '');
  });
  afterEach(() => {
    vi.doUnmock('../../src/main.js');
    vi.doUnmock('../../src/app/boot.js');
    vi.unstubAllEnvs();
    localStorage.clear();
    window.happyDOM.setURL('http://localhost:1420/');
  });

  it('imports the legacy main.js by default and never loads boot.js', async () => {
    await import('../../src/entry.js');
    expect(calls).toEqual(['main']);
  });

  it('imports boot.js for ?engine=wmp and never loads main.js', async () => {
    window.happyDOM.setURL('http://localhost:1420/?engine=wmp');
    await import('../../src/entry.js');
    expect(calls).toEqual(['boot']);
  });

  it('replays window load once for the legacy when load already fired (main.js:586 mask pass)', async () => {
    let loads = 0;
    vi.doMock('../../src/main.js', () => {
      calls.push('main');
      window.addEventListener('load', () => loads++);
      return {};
    });
    expect(document.readyState).toBe('complete');
    await import('../../src/entry.js');
    expect(calls).toEqual(['main']);
    expect(loads).toBe(1);
  });

  it('imports legacy for ?engine=legacy even when storage asks for the engine', async () => {
    localStorage.setItem('engine', 'wmp');
    window.happyDOM.setURL('http://localhost:1420/?engine=legacy');
    await import('../../src/entry.js');
    expect(calls).toEqual(['main']);
  });
});
