import { and, eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from './client.js'
import {
  devices,
  environments,
  messages,
  pairingCodes,
  projects,
  secrets,
  sessions,
} from './schema.js'

/**
 * Integration tests against a real Postgres.
 *
 * These assert database-level guarantees — unique constraints, cascades,
 * defaults — which cannot be verified against a mock: the point is that
 * Postgres itself rejects the bad write.
 */

const url = process.env.DUKEBOX_DATABASE_URL

if (!url) {
  throw new Error('DUKEBOX_DATABASE_URL is required; run these tests via docker/verify.sh')
}

const { db, close } = createDatabase(url, { max: 1 })

afterAll(() => close())

beforeAll(async () => {
  // Migrate rather than assume a prepared database, so a clean Postgres — the
  // state after `verify.sh --down` — is enough to run these tests.
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  })
})

beforeEach(async () => {
  // projects and sessions cascade, so truncating the roots clears the rest.
  await db.execute(
    sql`truncate table ${projects}, ${devices}, ${pairingCodes} restart identity cascade`,
  )
})

async function insertProject(repoFullName = 'diego/dukebox') {
  const [project] = await db.insert(projects).values({ repoFullName }).returning()
  if (!project) throw new Error('failed to insert project')
  return project
}

async function insertSession(projectId: string) {
  const [session] = await db
    .insert(sessions)
    .values({
      projectId,
      agentId: 'claude-code',
      status: 'running',
      branch: 'duke/abc123',
      baseBranch: 'main',
    })
    .returning()
  if (!session) throw new Error('failed to insert session')
  return session
}

describe('messages', () => {
  it('rejects a duplicate seq within a session', async () => {
    const project = await insertProject()
    const session = await insertSession(project.id)

    await db.insert(messages).values({
      sessionId: session.id,
      seq: 1,
      event: { type: 'assistant_text', delta: 'hello' },
    })

    // A duplicate seq would make client-side reconciliation ambiguous: the
    // client could not tell which of the two events it already has.
    await expect(
      db.insert(messages).values({
        sessionId: session.id,
        seq: 1,
        event: { type: 'assistant_text', delta: 'different' },
      }),
    ).rejects.toThrow()
  })

  it('allows the same seq in different sessions', async () => {
    const project = await insertProject()
    const first = await insertSession(project.id)
    const second = await insertSession(project.id)

    await db.insert(messages).values([
      { sessionId: first.id, seq: 1, event: { type: 'done', reason: 'completed' } },
      { sessionId: second.id, seq: 1, event: { type: 'done', reason: 'completed' } },
    ])

    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(2)
  })

  it('assigns increasing ids so index writes stay sequential', async () => {
    const project = await insertProject()
    const session = await insertSession(project.id)

    const inserted = await db
      .insert(messages)
      .values([
        { sessionId: session.id, seq: 1, event: { type: 'assistant_text', delta: 'a' } },
        { sessionId: session.id, seq: 2, event: { type: 'assistant_text', delta: 'b' } },
      ])
      .returning()

    const ids = inserted.map((row) => row.id)
    expect(ids[1]).toBeGreaterThan(ids[0]!)
  })

  it('round-trips an event through jsonb unchanged', async () => {
    const project = await insertProject()
    const session = await insertSession(project.id)
    const event = { type: 'tool_call', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }

    await db.insert(messages).values({ sessionId: session.id, seq: 1, event })

    const [row] = await db.select().from(messages).where(eq(messages.sessionId, session.id))
    expect(row?.event).toEqual(event)
  })

  it('deletes messages when the session is deleted', async () => {
    const project = await insertProject()
    const session = await insertSession(project.id)
    await db.insert(messages).values({
      sessionId: session.id,
      seq: 1,
      event: { type: 'done', reason: 'completed' },
    })

    await db.delete(sessions).where(eq(sessions.id, session.id))

    expect(await db.select().from(messages)).toHaveLength(0)
  })
})

describe('sessions', () => {
  it('starts lastSeq at 0 so the first event takes seq 1', async () => {
    const project = await insertProject()
    const session = await insertSession(project.id)
    expect(session.lastSeq).toBe(0)
  })

  it('deletes sessions when the project is deleted', async () => {
    const project = await insertProject()
    await insertSession(project.id)

    await db.delete(projects).where(eq(projects.id, project.id))

    expect(await db.select().from(sessions)).toHaveLength(0)
  })
})

describe('projects', () => {
  it('rejects the same repository twice', async () => {
    await insertProject('diego/dukebox')
    await expect(insertProject('diego/dukebox')).rejects.toThrow()
  })
})

describe('environments', () => {
  it('leaves config and draft null by default and round-trips both through jsonb', async () => {
    // Renamed from a pair of tests that claimed to cover migration 0005 but
    // only ever INSERTed into `environments` directly, so the migration's
    // INSERT ... SELECT never ran. That copy is now genuinely exercised in
    // "migration 0005"; what survives here is the column-level guarantee those
    // tests actually established — the jsonb columns are nullable and preserve
    // their payloads verbatim.
    const [project] = await db
      .insert(projects)
      .values({ repoFullName: 'acme/with-config', defaultBranch: 'main' })
      .returning()

    const [bare] = await db
      .insert(environments)
      .values({ projectId: project.id, name: 'Bare', branchPattern: '**' })
      .returning()

    expect(bare.configOverride).toBeNull()
    expect(bare.environmentDraft).toBeNull()
    expect(bare.snapshotImage).toBeNull()
    expect(bare.position).toBe(0)

    const configOverride = { setup: ['pnpm install'] }
    const environmentDraft = { setup: ['pnpm install'], env: {} }

    const [filled] = await db
      .insert(environments)
      .values({
        projectId: project.id,
        name: 'Default',
        branchPattern: '**',
        position: 0,
        configOverride,
        environmentDraft,
      })
      .returning()

    expect(filled.branchPattern).toBe('**')
    expect(filled.configOverride).toEqual(configOverride)
    expect(filled.environmentDraft).toEqual(environmentDraft)
  })

  it('rejects two environments of one project sharing a name', async () => {
    const [project] = await db
      .insert(projects)
      .values({ repoFullName: 'acme/dupe-names', defaultBranch: 'main' })
      .returning()

    await db
      .insert(environments)
      .values({ projectId: project.id, name: 'Default', branchPattern: '**' })

    await expect(
      db
        .insert(environments)
        .values({ projectId: project.id, name: 'Default', branchPattern: '*' }),
    ).rejects.toThrow()
  })

  it('keeps a session when its environment is deleted', async () => {
    // Deleting an environment must not delete the history of what ran on it.
    const [project] = await db
      .insert(projects)
      .values({ repoFullName: 'acme/orphan', defaultBranch: 'main' })
      .returning()

    const [environment] = await db
      .insert(environments)
      .values({ projectId: project.id, name: 'Default', branchPattern: '**' })
      .returning()

    const [session] = await db
      .insert(sessions)
      .values({
        projectId: project.id,
        environmentId: environment.id,
        agentId: 'claude-code',
        status: 'done',
        branch: 'duke/x',
        baseBranch: 'main',
      })
      .returning()

    await db.delete(environments).where(eq(environments.id, environment.id))

    const [after] = await db.select().from(sessions).where(eq(sessions.id, session.id))
    expect(after).toBeDefined()
    expect(after.environmentId).toBeNull()
  })
})

describe('migration 0005', () => {
  /**
   * Migration 0005 copies three columns off `projects` into `environments`
   * with an INSERT ... SELECT and then DROPs those columns in the same file.
   * The copy and the drop are irreversible together: a filter that misses a
   * row loses that row's data permanently, and narrowing the WHERE clause to
   * `config_override IS NOT NULL` is exactly the data-loss defect this project
   * already shipped once.
   *
   * The suite's own `beforeAll` migrates an empty database, so the copy runs
   * over zero rows there and constrains nothing. This test therefore builds a
   * throwaway database, stops at 0004 so `projects` still HAS the three
   * columns, seeds rows in every shape, and only then applies 0005.
   *
   * The SQL is read from the real migration folder rather than pasted here:
   * an inlined copy would drift from the file the server actually runs and
   * would stop guarding it.
   */

  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url))
  const scratchName = 'dukebox_migration_0005_test'

  // Postgres cannot drop the database a connection is attached to, so
  // CREATE/DROP go through a separate connection to the `postgres` database.
  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const scratchUrl = new URL(url)
  scratchUrl.pathname = `/${scratchName}`

  async function withAdmin<T>(fn: (client: postgres.Sql) => Promise<T>): Promise<T> {
    const client = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
    try {
      return await fn(client)
    } finally {
      await client.end()
    }
  }

  /** Split the migration folder at 0005, resolving it by tag via the journal. */
  async function splitMigrationsAt0005() {
    const files = readMigrationFiles({ migrationsFolder })
    const journal = JSON.parse(
      await readFile(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { when: number; tag: string }[] }

    const entry = journal.entries.find((candidate) => candidate.tag === '0005_environments')
    if (!entry) throw new Error('0005_environments is missing from the migration journal')

    // Matched on the journal timestamp rather than a hardcoded array index, so
    // inserting a migration ahead of 0005 cannot silently shift this test onto
    // the wrong file.
    const index = files.findIndex((file) => file.folderMillis === entry.when)
    if (index === -1) throw new Error('0005_environments is missing from the migration folder')

    return { before: files.slice(0, index), target: files[index]! }
  }

  it('copies every project carrying any environment column into one Default environment', async () => {
    await withAdmin(async (client) => {
      await client.unsafe(`drop database if exists "${scratchName}"`)
      await client.unsafe(`create database "${scratchName}"`)
    })

    const scratch = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} })

    try {
      const { before, target } = await splitMigrationsAt0005()

      // Everything up to but excluding 0005, so `projects` still carries
      // config_override, snapshot_image and environment_draft.
      for (const file of before) {
        for (const statement of file.sql) await scratch.unsafe(statement)
      }

      const columns = await scratch<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'projects'
      `
      const names = columns.map((column) => column.column_name)
      expect(names).toEqual(
        expect.arrayContaining(['config_override', 'snapshot_image', 'environment_draft']),
      )

      const configOnly = { setup: ['pnpm install'] }
      const draftOnly = { setup: ['pnpm build'], env: {} }
      const allThreeConfig = { setup: ['make'] }
      const allThreeDraft = { setup: ['make test'], env: { CI: '1' } }

      await scratch`
        insert into projects (repo_full_name, config_override, snapshot_image, environment_draft)
        values
          ('acme/config-only', ${configOnly}::jsonb, null, null),
          ('acme/draft-only', null, null, ${draftOnly}::jsonb),
          ('acme/snapshot-only', null, 'ghcr.io/acme/snap:v1', null),
          ('acme/all-three', ${allThreeConfig}::jsonb, 'ghcr.io/acme/all:v2', ${allThreeDraft}::jsonb),
          ('acme/none', null, null, null)
      `

      // The migration under test, statement for statement as written on disk.
      for (const statement of target.sql) await scratch.unsafe(statement)

      const rows = await scratch<
        {
          repo_full_name: string
          name: string
          branch_pattern: string
          position: number
          config_override: unknown
          snapshot_image: string | null
          environment_draft: unknown
        }[]
      >`
        select
          p.repo_full_name,
          e.name,
          e.branch_pattern,
          e.position,
          e.config_override,
          e.snapshot_image,
          e.environment_draft
        from environments e
        join projects p on p.id = e.project_id
        order by p.repo_full_name
      `

      // The project with nothing to carry produces no environment; every other
      // shape produces exactly one.
      expect(rows.map((row) => row.repo_full_name)).toEqual([
        'acme/all-three',
        'acme/config-only',
        'acme/draft-only',
        'acme/snapshot-only',
      ])

      // A draft-only or snapshot-only project losing its row here is the
      // permanent data loss this migration exists to avoid.
      expect(rows).toEqual([
        {
          repo_full_name: 'acme/all-three',
          name: 'Default',
          branch_pattern: '**',
          position: 0,
          config_override: allThreeConfig,
          snapshot_image: 'ghcr.io/acme/all:v2',
          environment_draft: allThreeDraft,
        },
        {
          repo_full_name: 'acme/config-only',
          name: 'Default',
          branch_pattern: '**',
          position: 0,
          config_override: configOnly,
          snapshot_image: null,
          environment_draft: null,
        },
        {
          repo_full_name: 'acme/draft-only',
          name: 'Default',
          branch_pattern: '**',
          position: 0,
          config_override: null,
          snapshot_image: null,
          environment_draft: draftOnly,
        },
        {
          repo_full_name: 'acme/snapshot-only',
          name: 'Default',
          branch_pattern: '**',
          position: 0,
          config_override: null,
          snapshot_image: 'ghcr.io/acme/snap:v1',
          environment_draft: null,
        },
      ])

      // The columns really are gone, so the copy above was the only chance to
      // preserve those values.
      const after = await scratch<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'projects'
      `
      const remaining = after.map((column) => column.column_name)
      expect(remaining).not.toContain('config_override')
      expect(remaining).not.toContain('snapshot_image')
      expect(remaining).not.toContain('environment_draft')
    } finally {
      // Always dropped, including when an assertion above throws, so a failed
      // run does not leak a database into the next one.
      await scratch.end()
      await withAdmin((client) => client.unsafe(`drop database if exists "${scratchName}"`))
    }
  })
})

describe('secrets', () => {
  it('rejects a duplicate name within a project', async () => {
    const project = await insertProject()
    const values = {
      projectId: project.id,
      name: 'DATABASE_URL',
      ciphertext: 'x',
      iv: 'y',
      authTag: 'z',
    }

    await db.insert(secrets).values(values)
    await expect(db.insert(secrets).values(values)).rejects.toThrow()
  })

  it('allows the same name in different projects', async () => {
    const first = await insertProject('diego/one')
    const second = await insertProject('diego/two')
    const base = { name: 'DATABASE_URL', ciphertext: 'x', iv: 'y', authTag: 'z' }

    await db.insert(secrets).values([
      { ...base, projectId: first.id },
      { ...base, projectId: second.id },
    ])

    expect(await db.select().from(secrets)).toHaveLength(2)
  })
})

describe('devices and pairing codes', () => {
  it('rejects a duplicate token hash', async () => {
    const values = { name: 'Diego MacBook', platform: 'macos', tokenHash: 'hash-1' }
    await db.insert(devices).values(values)
    await expect(db.insert(devices).values({ ...values, name: 'Other' })).rejects.toThrow()
  })

  it('rejects a duplicate code hash', async () => {
    const values = { codeHash: 'code-hash-1', expiresAt: new Date(Date.now() + 60_000) }
    await db.insert(pairingCodes).values(values)
    await expect(db.insert(pairingCodes).values(values)).rejects.toThrow()
  })

  it('keeps a redeemed code after its device is deleted', async () => {
    const [device] = await db
      .insert(devices)
      .values({ name: 'Diego MacBook', platform: 'macos', tokenHash: 'hash-2' })
      .returning()

    await db.insert(pairingCodes).values({
      codeHash: 'code-hash-2',
      expiresAt: new Date(Date.now() + 60_000),
      redeemedAt: new Date(),
      redeemedByDeviceId: device!.id,
    })

    await db.delete(devices).where(eq(devices.id, device!.id))

    // The code row must survive: a used code stays used even if the device
    // that claimed it is gone, so the code can never be redeemed again.
    const [row] = await db.select().from(pairingCodes)
    expect(row).toBeDefined()
    expect(row?.redeemedByDeviceId).toBeNull()
    expect(row?.redeemedAt).not.toBeNull()
  })

  it('finds an unredeemed, unexpired code by hash', async () => {
    await db.insert(pairingCodes).values([
      { codeHash: 'valid', expiresAt: new Date(Date.now() + 60_000) },
      { codeHash: 'expired', expiresAt: new Date(Date.now() - 60_000) },
    ])

    const usable = await db
      .select()
      .from(pairingCodes)
      .where(
        and(
          eq(pairingCodes.codeHash, 'valid'),
          sql`${pairingCodes.redeemedAt} is null`,
          sql`${pairingCodes.expiresAt} > now()`,
        ),
      )

    expect(usable).toHaveLength(1)
  })
})
