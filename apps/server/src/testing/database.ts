import {
  createDatabase,
  devices,
  pairingCodes,
  projects,
  secrets as secretsTable,
  sessions,
  type Database,
} from '@dukebox/db'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'

/**
 * Shared test database setup.
 *
 * A single connection, so every test file works against the same session
 * rather than racing each other through a pool.
 */

const url = process.env.DUKEBOX_DATABASE_URL
if (!url) throw new Error('DUKEBOX_DATABASE_URL is required; run via docker/verify.sh')

const connection = createDatabase(url, { max: 1 })

// Annotated rather than inferred: the inferred type reaches into the db
// package's internals and does not survive being written to a declaration file.
export const db: Database = connection.db

let closed = false

/**
 * Close the pool.
 *
 * Idempotent: every test file registers this in afterAll, and they share one
 * connection, so it is called once per file.
 */
export async function close(): Promise<void> {
  if (closed) return
  closed = true
  await connection.close()
}

/** Apply migrations, so a clean Postgres is enough to run the tests. */
export async function prepareDatabase(): Promise<void> {
  // Notices are silenced by the connection itself, so nothing extra is needed
  // here to keep migration and TRUNCATE chatter out of the test output.
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url)),
  })
}

/** Clear every table. Projects and devices cascade to the rest. */
export async function resetDatabase(): Promise<void> {
  // `secrets` is listed explicitly rather than left to the cascade: a
  // server-wide secret has no project to cascade from, so it would survive and
  // leak into the next test.
  await db.execute(
    sql`truncate table ${projects}, ${sessions}, ${devices}, ${pairingCodes}, ${secretsTable} restart identity cascade`,
  )
}
