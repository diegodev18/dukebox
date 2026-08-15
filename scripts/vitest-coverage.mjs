/**
 * Shared Vitest coverage settings.
 *
 * Every package repeats the same provider, reporters and exclusions, so they
 * live here and each `vitest.config.ts` spreads the result into `test.coverage`.
 *
 * Usage (cwd = package root):
 *   import { coverage } from '../../scripts/vitest-coverage.mjs'
 *   export default defineConfig({ test: { coverage } })
 *
 * Coverage is opt-in per run (`vitest run --coverage`), so `enabled` stays
 * false here: a plain `pnpm test` should not pay for instrumentation.
 */

/**
 * Paths excluded in every package, on top of Vitest's own defaults.
 *
 * `dist/` is build output of the same sources, and counting it would report
 * each file twice. Config and setup files are harness, not code under test.
 */
export const coverageExclude = [
  '**/dist/**',
  '**/*.config.{ts,mts,js,mjs}',
  '**/vitest.setup.{ts,tsx}',
  '**/*.d.ts',
  // Barrel files re-export other modules and hold no logic of their own; their
  // statements count as covered or not purely by which siblings a test imports.
  '**/index.ts',
]

/** @type {import('vitest/node').CoverageV8Options} */
export const coverage = {
  provider: 'v8',
  // `text` for the terminal, `html` to browse a run locally, and `lcov` because
  // it is what external coverage tooling reads.
  reporter: ['text', 'html', 'lcov'],
  reportsDirectory: './coverage',
  // Report files the tests never import as 0% instead of omitting them — an
  // untested module is the thing coverage most needs to make visible.
  all: true,
  include: ['src/**/*.{ts,tsx}'],
  exclude: [...coverageExclude, 'src/**/*.test.{ts,tsx}'],
}
