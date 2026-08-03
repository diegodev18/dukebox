import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = ReturnType<typeof createDatabase>['db']

/**
 * Open a connection pool.
 *
 * The caller owns the returned `close`: long-lived processes keep the pool for
 * their lifetime, while short-lived scripts and tests must close it or the
 * process will not exit.
 */
export function createDatabase(url: string, options: { max?: number } = {}) {
  // No `transform` is configured: Drizzle handles type parsing itself, and a
  // postgres.js transform on top of it would convert values twice.
  const client = postgres(url, { max: options.max ?? 10 })

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  }
}

export { schema }
