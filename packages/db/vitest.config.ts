import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../scripts/vitest-coverage.mjs'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage,
  },
})
