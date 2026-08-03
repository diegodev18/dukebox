import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // These tests drive a real Docker daemon: pulling images, starting
    // containers, and waiting on graceful stops all exceed the 5s default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
