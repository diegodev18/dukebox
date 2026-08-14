import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/schema'

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
  const client = postgres(url, {
    max: options.max ?? 10,

    // Postgres prints a NOTICE for every "already exists, skipping" during a
    // migration, and postgres.js dumps each one as a multi-line object. On an
    // up-to-date database that is a wall of text before any real output, and
    // it reads like a stack of errors when it is the opposite: confirmation
    // that there was nothing left to do. Genuine failures arrive as thrown
    // errors, not notices.
    onnotice: () => {},
  })

  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  }
}

export { schema }
