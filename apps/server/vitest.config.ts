import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Test files share one database and truncate tables between tests, so
    // running them in parallel has them clearing each other's rows mid-test.
    fileParallelism: false,
  },
})
