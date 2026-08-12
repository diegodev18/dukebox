import path from 'node:path'
import { defineConfig } from 'vitest/config'

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
  },
})
