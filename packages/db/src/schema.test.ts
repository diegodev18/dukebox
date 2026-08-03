import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase } from './client.js'
import { devices, messages, pairingCodes, projects, secrets, sessions } from './schema.js'

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

// A single connection keeps every statement on the same session, so the
// client_min_messages setting below applies to the truncates that follow.
const { db, close } = createDatabase(url, { max: 1 })

afterAll(() => close())

beforeAll(async () => {
  // Migrate rather than assume a prepared database, so a clean Postgres — the
  // state after `verify.sh --down` — is enough to run these tests.
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  })

  // TRUNCATE ... CASCADE emits a NOTICE per cascaded table, which would bury
  // the test output.
  await db.execute(sql`set client_min_messages to warning`)
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
