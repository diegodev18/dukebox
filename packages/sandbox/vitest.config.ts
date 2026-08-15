import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../scripts/vitest-coverage.mjs'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // These tests drive a real Docker daemon: pulling images, starting
    // containers, and waiting on graceful stops all exceed the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,

    coverage: {
      ...coverage,
      // A manual smoke test (`pnpm smoke`) against a real repository.
      exclude: [...coverage.exclude, 'src/cli.ts'],
    },
  },
})
