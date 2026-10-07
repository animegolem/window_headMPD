import { defineConfig, configDefaults } from 'vitest/config';

// Three suites in one config. `npm test` runs the `unit` project (everything under tests/ except the
// corpus and the timing files) and then the `timing` project; `npm run corpus` runs the `corpus`
// project, which walks skins/ and is slow. `timing` holds the realm tests that assert wall-clock
// budgets: they run one file at a time, after `unit` (groupOrder), so other test files cannot
// steal the CPU they measure (G2). A trailing
// CLI argument is a path filter inside the chosen project, so `npm test -- tests/engine/archive`
// and `npm run corpus -- zip` both work. Tests default to Node; a DOM-light test opts into
// happy-dom with a `// @vitest-environment happy-dom` docblock.
const TIMING = ['tests/realm-gate/**/*.test.{js,mjs}', 'tests/engine/realm/**/*.test.{js,mjs}'];

export default defineConfig({
  test: {
    passWithNoTests: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.{js,mjs}'],
          exclude: [...configDefaults.exclude, 'tests/corpus/**', 'tests/**/__out__/**', ...TIMING],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'timing',
          include: TIMING,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'corpus',
          include: ['tests/corpus/**/*.test.{js,mjs}'],
          exclude: [...configDefaults.exclude, 'tests/**/__out__/**'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
