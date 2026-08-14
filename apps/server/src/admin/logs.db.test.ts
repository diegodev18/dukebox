import { projects, sessions } from '@dukebox/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '@/testing/database'
import { listActiveSessions, resolveSessionId } from '@/admin/logs'

afterAll(close)
beforeAll(prepareDatabase)
beforeEach(resetDatabase)

const SESSION_ID = '00000000-0000-4000-8000-000000000000'

async function insertSession(values: {
  id?: string
  branch: string
  title?: string
  archived?: boolean
}): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: `diego/repo-${Math.random().toString(36).slice(2)}` })
    .returning()

  const [session] = await db
    .insert(sessions)
    .values({
      ...(values.id ? { id: values.id } : {}),
      projectId: project!.id,
      agentId: 'claude-code',
      status: 'running',
      branch: values.branch,
      baseBranch: 'main',
      title: values.title ?? '',
      ...(values.archived ? { archivedAt: new Date() } : {}),
    })
    .returning()

  return session!.id
}

describe('resolveSessionId / listActiveSessions', () => {
  it('resolves a full UUID, a unique prefix, and a duke/ branch', async () => {
    const id = await insertSession({
      id: SESSION_ID,
      branch: 'duke/00000000',
      title: 'Fix login',
    })

    expect(await resolveSessionId(db, SESSION_ID)).toBe(id)
    expect(await resolveSessionId(db, '00000000')).toBe(id)
    expect(await resolveSessionId(db, 'duke/00000000')).toBe(id)
  })

  it('rejects unknown and ambiguous tokens', async () => {
    await insertSession({
      id: '11111111-0000-4000-8000-000000000000',
      branch: 'duke/11111111',
    })
    await insertSession({
      id: '11111111-0000-4000-8000-000000000001',
      branch: 'duke/11111112',
    })

    await expect(resolveSessionId(db, 'aaaaaaaa-0000-4000-8000-000000000000')).rejects.toThrow(
      /no session/,
    )
    await expect(resolveSessionId(db, 'zzzz')).rejects.toThrow(/no session matching/)
    await expect(resolveSessionId(db, '11111111')).rejects.toThrow(/multiple sessions match/)
  })

  it('lists non-archived sessions newest first', async () => {
    const older = await insertSession({ branch: 'duke/aaaaaaa1', title: 'older' })
    const newer = await insertSession({ branch: 'duke/aaaaaaa2', title: 'newer' })
    await insertSession({ branch: 'duke/hidden', title: 'hidden', archived: true })

    const rows = await listActiveSessions(db)
    expect(rows.map((row) => row.id)).toEqual([newer, older])
    expect(rows.map((row) => row.title)).toEqual(['newer', 'older'])
  })
})
