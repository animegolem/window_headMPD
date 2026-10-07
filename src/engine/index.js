// @ts-check
// Composition root (ENGINE.md §5.10, §6.1). This is the W0.1 stub so the app shell and the harness
// have an entry point to import; W4.1 replaces it with the real engine.

/** @type {import('./contracts').CreateEngineFn} */
export const createEngine = (_host, _opts) => ({
  load: () => Promise.reject(new Error('engine not implemented')),
});
