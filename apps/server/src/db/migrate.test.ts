import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findMigrationsFolder } from './migrate.js'

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dukebox-migrate-'))
}

describe('findMigrationsFolder', () => {
  it('finds migrations in the release bundle layout', async () => {
    const root = await fixtureRoot()
    const migrations = join(root, 'node_modules', '@dukebox', 'db', 'migrations')
    await mkdir(migrations, { recursive: true })
    await writeFile(join(migrations, '0001.sql'), '-- x')

    const found = findMigrationsFolder(pathToFileURL(join(root, 'dist', 'db', 'migrate.js')).href)
    expect(found).toBe(migrations)
  })

  it('finds migrations in the repo build layout', async () => {
    const root = await fixtureRoot()
    const migrations = join(root, 'packages', 'db', 'migrations')
    await mkdir(migrations, { recursive: true })
    await writeFile(join(migrations, '0001.sql'), '-- x')

    const found = findMigrationsFolder(
      pathToFileURL(join(root, 'apps', 'server', 'dist', 'db', 'migrate.js')).href,
    )
    expect(found).toBe(migrations)
  })

  it('throws when no migrations can be found', () => {
    expect(() => findMigrationsFolder(pathToFileURL('/tmp/nonexistent/migrate.js').href)).toThrow(
      /could not find the database migrations/,
    )
  })
})
