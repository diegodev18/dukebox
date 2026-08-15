import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../scripts/vitest-coverage.mjs'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    // Testing-library auto-cleans between tests only when it can see the
    // global afterEach; without this each render stacks in the same document.
    globals: true,
    setupFiles: ['./vitest.setup.ts'],

    coverage: {
      ...coverage,
      exclude: [
        ...coverage.exclude,
        // Browser entry points: they mount a root component and nothing else.
        // `preview.tsx` additionally exists only for manual UI inspection.
        'src/main.tsx',
        'src/preview.tsx',
      ],
    },
  },
})
