import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { coverage } from '../../scripts/vitest-coverage.mjs'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Test files share one database and truncate tables between tests, so
    // running them in parallel has them clearing each other's rows mid-test.
    fileParallelism: false,

    // Session tests start real containers. The 5s default is enough when they
    // run alone and not when the whole suite is competing for one daemon,
    // which made them fail only in a full run.
    testTimeout: 60_000,
    hookTimeout: 120_000,

    coverage: {
      ...coverage,
      exclude: [
        ...coverage.exclude,
        // `main.ts` only wires the process together (config load, signals,
        // listen) and is exercised by running the server, not by the suite.
        'src/main.ts',
        // Harness the suites build on (throwaway databases, Redis clients),
        // not server code under test.
        'src/testing/**',
      ],
    },
  },
})
