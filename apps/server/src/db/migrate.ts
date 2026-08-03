import type { Database } from '@dukebox/db'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Bring the database schema up to date.
 *
 * Runs at startup rather than from the installer. An upgrade replaces the code
 * and restarts the service; if migrating were the installer's job, every
 * upgrade would need someone to remember a second step, and forgetting it
 * fails at the first query with an error that says nothing about migrations.
 *
 * Drizzle records what it has applied, so this is a no-op once current.
 */

/**
 * Locate the migrations directory.
 *
 * Checked in order because the layout differs between running from source and
 * running the built output — the built server lives one level deeper.
 */
export function findMigrationsFolder(): string {
  const candidates = [
    // Built: apps/server/dist/db/ -> packages/db/migrations
    new URL('../../../../packages/db/migrations', import.meta.url),
    // Source: apps/server/src/db/ -> packages/db/migrations
    new URL('../../../../../packages/db/migrations', import.meta.url),
  ]

  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)
    if (existsSync(path)) return path
  }

  throw new Error(
    'could not find the database migrations. Was the project built with `pnpm build`?',
  )
}

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: findMigrationsFolder() })
}
