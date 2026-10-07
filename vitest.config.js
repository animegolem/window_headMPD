import { defineConfig, configDefaults } from 'vitest/config';

// Two suites in one config. `npm test` runs the `unit` project (everything under tests/ except the
// corpus); `npm run corpus` runs the `corpus` project, which walks skins/ and is slow. A trailing
// CLI argument is a path filter inside the chosen project, so `npm test -- tests/engine/archive`
// and `npm run corpus -- zip` both work. Tests default to Node; a DOM-light test opts into
// happy-dom with a `// @vitest-environment happy-dom` docblock.
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
          exclude: [...configDefaults.exclude, 'tests/corpus/**', 'tests/**/__out__/**'],
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
        },
      },
    ],
  },
});
