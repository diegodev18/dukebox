import { environments, projects, sessions } from '@dukebox/db'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { issuePairingCode, redeemPairingCode } from '../auth/pairing.js'
import { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import { SecretStore } from '../secrets/store.js'
import { SessionError, SessionManager } from '../sessions/manager.js'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { closeRedis, redis } from '../testing/redis.js'
import { createApp } from './app.js'

/**
 * The environment routes: the list, its order, and who is allowed to read it.
 *
 * The same harness as `routes.test.ts` — a real Postgres, a stubbed GitHub and
 * session manager — because what matters here is validation and status codes,
 * not container behaviour.
 */

const bus = new EventBus(db, redis)

const github = {
  listRepositories: vi.fn(async () => []),
  defaultBranch: vi.fn(async () => 'main'),
  listBranches: vi.fn(async () => ['main']),
} as unknown as GitHubClient

const sessionManager = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  archive: vi.fn(async () => {}),
  openPullRequest: vi.fn(async () => 'https://github.com/acme/env-routes/pull/1'),
} as unknown as SessionManager

const secretStore = new SecretStore(db, randomBytes(32))

const app = createApp({
  db,
  serverName: 'dukebox-test',
  pairingEndpoint: { host: 'localhost', port: 7777 },
  features: { github, bus, sessions: sessionManager, secrets: secretStore },
})

let token = ''
let projectId = ''

afterAll(async () => {
  await close()
  await closeRedis()
})

beforeAll(prepareDatabase)

beforeEach(async () => {
  await resetDatabase()
  await redis.flushdb()
  vi.clearAllMocks()

  const issued = await issuePairingCode(db, { host: 'localhost', port: 7777 })
  const redeemed = await redeemPairingCode(
    db,
    { code: issued.code, deviceName: 'Test', platform: 'macos' },
    'dukebox-test',
  )
  token = redeemed.deviceToken

  const [project] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/env-routes', defaultBranch: 'main' })
    .returning()
  projectId = project!.id
})

/** An authenticated request, as the desktop app would make it. */
function request(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  })
}

function post(path: string, body: unknown) {
  return request(path, { method: 'POST', body: JSON.stringify(body) })
}

async function otherProject() {
  const [other] = await db
    .insert(projects)
    .values({ repoFullName: 'acme/elsewhere', defaultBranch: 'main' })
    .returning()
  return other!
}

describe('environment routes', () => {
  it('creates an environment at the end of the list', async () => {
    await post(`/api/projects/${projectId}/environments`, { name: 'First', branchPattern: '**' })

    const response = await post(`/api/projects/${projectId}/environments`, {
      name: 'Second',
      branchPattern: 'refact/*',
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { environment: { name: string; position: number } }
    expect(body.environment.name).toBe('Second')
    // Appending rather than inserting: a new environment must never change
    // which one an existing branch already resolves to.
    expect(body.environment.position).toBe(1)
  })

  it('rejects an invalid branch pattern with a reason', async () => {
    const response = await post(`/api/projects/${projectId}/environments`, {
      name: 'Bad',
      branchPattern: 're:(a+)+',
    })

    // Validated server-side: the app is not the gatekeeper for a pattern the
    // server is the one to evaluate.
    expect(response.status).toBe(400)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain('nested quantifiers')
  })

  it('409s when the name is already taken in this project', async () => {
    await post(`/api/projects/${projectId}/environments`, {
      name: 'Default',
      branchPattern: '**',
    })

    // A duplicate name would make the picker unreadable, and the raw
    // constraint error is a database exception, not a message anyone can act
    // on — so it surfaces as a 409, not a 500.
    const response = await post(`/api/projects/${projectId}/environments`, {
      name: 'Default',
      branchPattern: 'refact/*',
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; message: string }
    expect(body.error).toBe('conflict')
    expect(body.message).toContain('“Default” already exists')
  })

  it('lets two projects use the same environment name', async () => {
    const other = await otherProject()

    await post(`/api/projects/${projectId}/environments`, {
      name: 'Default',
      branchPattern: '**',
    })

    // The uniqueness is per (project_id, name), so a same-named environment
    // in a different project is a different row, not a conflict.
    const response = await post(`/api/projects/${other.id}/environments`, {
      name: 'Default',
      branchPattern: '**',
    })

    expect(response.status).toBe(201)
  })

  it('409s when a rename collides with another environment', async () => {
    await db.insert(environments).values([
      { projectId, name: 'First', branchPattern: '**', position: 0 },
      { projectId, name: 'Second', branchPattern: 'b/*', position: 1 },
    ])

    const [first] = await db.select().from(environments).where(eq(environments.name, 'First'))

    const response = await request(`/api/environments/${first!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Second' }),
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { message: string }
    expect(body.message).toContain('“Second” already exists')

    // The refused rename leaves the original name in place.
    const [after] = await db.select().from(environments).where(eq(environments.id, first!.id))
    expect(after!.name).toBe('First')
  })

  it('lists environments in position order', async () => {
    await db.insert(environments).values([
      { projectId, name: 'Second', branchPattern: 'refact/*', position: 1 },
      { projectId, name: 'First', branchPattern: '**', position: 0 },
    ])

    const response = await request(`/api/projects/${projectId}/environments`)

    const body = (await response.json()) as { environments: { name: string }[] }
    expect(body.environments.map((e) => e.name)).toEqual(['First', 'Second'])
  })

  it('updates a name and a pattern', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Old', branchPattern: '**', position: 0 })
      .returning()

    const response = await request(`/api/environments/${environment!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'New', branchPattern: 'docs/*' }),
    })

    expect(response.status).toBe(200)
    const [after] = await db.select().from(environments).where(eq(environments.id, environment!.id))
    expect(after!.name).toBe('New')
    expect(after!.branchPattern).toBe('docs/*')
  })

  it('rejects an update with an invalid pattern', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Env', branchPattern: '**', position: 0 })
      .returning()

    const response = await request(`/api/environments/${environment!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ branchPattern: 're:[unclosed' }),
    })

    expect(response.status).toBe(400)
  })

  it('reorders by rewriting positions', async () => {
    const rows = await db
      .insert(environments)
      .values([
        { projectId, name: 'A', branchPattern: '**', position: 0 },
        { projectId, name: 'B', branchPattern: 'b/*', position: 1 },
        { projectId, name: 'C', branchPattern: 'c/*', position: 2 },
      ])
      .returning()

    const byName = (name: string) => rows.find((row) => row.name === name)!

    const response = await post(`/api/projects/${projectId}/environments/reorder`, {
      ids: [byName('C').id, byName('A').id, byName('B').id],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { environments: { name: string }[] }
    expect(body.environments.map((e) => e.name)).toEqual(['C', 'A', 'B'])
  })

  it('refuses to reorder with ids from another project', async () => {
    const other = await otherProject()

    const [foreign] = await db
      .insert(environments)
      .values({ projectId: other.id, name: 'Theirs', branchPattern: '**', position: 0 })
      .returning()

    const response = await post(`/api/projects/${projectId}/environments/reorder`, {
      ids: [foreign!.id],
    })

    expect(response.status).toBe(400)
  })

  it('refuses a partial reorder', async () => {
    const rows = await db
      .insert(environments)
      .values([
        { projectId, name: 'A', branchPattern: '**', position: 0 },
        { projectId, name: 'B', branchPattern: 'b/*', position: 1 },
      ])
      .returning()

    // Rewriting only some positions would leave the rest at stale ones and
    // produce an order nobody asked for.
    const response = await post(`/api/projects/${projectId}/environments/reorder`, {
      ids: [rows[0]!.id],
    })

    expect(response.status).toBe(400)
  })

  it('refuses a reorder that repeats an id', async () => {
    const rows = await db
      .insert(environments)
      .values([
        { projectId, name: 'A', branchPattern: '**', position: 0 },
        { projectId, name: 'B', branchPattern: 'b/*', position: 1 },
      ])
      .returning()

    // The right length and every id owned, yet B never gets a position — a
    // count alone does not make the list complete.
    const response = await post(`/api/projects/${projectId}/environments/reorder`, {
      ids: [rows[0]!.id, rows[0]!.id],
    })

    expect(response.status).toBe(400)
    const [b] = await db.select().from(environments).where(eq(environments.id, rows[1]!.id))
    expect(b!.position).toBe(1)
  })

  it('deletes an environment', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Gone', branchPattern: '**', position: 0 })
      .returning()

    const response = await request(`/api/environments/${environment!.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    const remaining = await db
      .select()
      .from(environments)
      .where(eq(environments.id, environment!.id))
    expect(remaining).toHaveLength(0)
  })

  it('keeps sessions that ran on a deleted environment', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Gone', branchPattern: '**', position: 0 })
      .returning()

    const [session] = await db
      .insert(sessions)
      .values({
        projectId,
        environmentId: environment!.id,
        agentId: 'claude-code',
        status: 'stopped',
        branch: 'duke/abc123',
        baseBranch: 'main',
        title: 'Did some work',
      })
      .returning()

    await request(`/api/environments/${environment!.id}`, { method: 'DELETE' })

    // `on delete set null`, not cascade: the work an agent already did is not
    // the environment's to take with it.
    const [after] = await db.select().from(sessions).where(eq(sessions.id, session!.id))
    expect(after).toBeDefined()
    expect(after!.environmentId).toBeNull()
  })

  it('404s for an unknown environment', async () => {
    const response = await request('/api/environments/3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f', {
      method: 'DELETE',
    })

    expect(response.status).toBe(404)
  })

  it('403s when starting a session with another project’s environment', async () => {
    const other = await otherProject()

    const [foreign] = await db
      .insert(environments)
      .values({ projectId: other.id, name: 'Theirs', branchPattern: '**', position: 0 })
      .returning()

    vi.mocked(sessionManager.start).mockRejectedValueOnce(
      new SessionError(`environment does not belong to this project: ${foreign!.id}`),
    )

    const response = await post('/api/sessions', {
      projectId,
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: foreign!.id,
    })

    // 403, not 400: the environment is real, and the caller is being refused
    // it rather than told the request was malformed.
    expect(response.status).toBe(403)
  })

  it('passes a chosen environment through to the manager', async () => {
    const [environment] = await db
      .insert(environments)
      .values({ projectId, name: 'Mine', branchPattern: '**', position: 0 })
      .returning()

    const [session] = await db
      .insert(sessions)
      .values({
        projectId,
        environmentId: environment!.id,
        agentId: 'claude-code',
        status: 'provisioning',
        branch: 'duke/abc123',
        baseBranch: 'main',
        title: 'Work',
      })
      .returning()

    vi.mocked(sessionManager.start).mockResolvedValueOnce(session!)

    await post('/api/sessions', {
      projectId,
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: environment!.id,
    })

    expect(sessionManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: environment!.id }),
    )
  })

  it('omits the environment entirely when not given', async () => {
    const [session] = await db
      .insert(sessions)
      .values({
        projectId,
        agentId: 'claude-code',
        status: 'provisioning',
        branch: 'duke/abc123',
        baseBranch: 'main',
        title: 'Work',
      })
      .returning()

    vi.mocked(sessionManager.start).mockResolvedValueOnce(session!)

    await post('/api/sessions', { projectId, agentId: 'claude-code', prompt: 'x' })

    // Absent, not undefined: the manager reads an absent environment as
    // "resolve one from the base branch".
    const options = vi.mocked(sessionManager.start).mock.calls[0]?.[0]
    expect(options && 'environmentId' in options).toBe(false)
  })

  it('requires a device token like every other route', async () => {
    expect((await app.request(`/api/projects/${projectId}/environments`)).status).toBe(401)
  })
})

describe('per-environment config', () => {
  async function createEnvironment(owner = projectId, name = 'Default') {
    const [environment] = await db
      .insert(environments)
      .values({ projectId: owner, name, branchPattern: '**', position: 0 })
      .returning()
    return environment!
  }

  it('requires an environmentId on GET', async () => {
    const response = await request(`/api/projects/${projectId}/environment`)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: 'environmentId is required' })
  })

  it('requires an environmentId on PUT', async () => {
    const response = await request(`/api/projects/${projectId}/environment`, {
      method: 'PUT',
      body: JSON.stringify({ setup: [] }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: 'environmentId is required' })
  })

  it('returns null config for a fresh environment', async () => {
    const environment = await createEnvironment()

    const response = await request(
      `/api/projects/${projectId}/environment?environmentId=${environment.id}`,
    )

    expect(await response.json()).toEqual({ config: null, draft: null, secretNames: [] })
  })

  it('saves config on the environment, not the project', async () => {
    const environment = await createEnvironment()

    const response = await request(
      `/api/projects/${projectId}/environment?environmentId=${environment.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          setup: ['pnpm install'],
          secretEnv: ['DATABASE_URL'],
          literalEnv: { NODE_ENV: 'development' },
          secrets: { DATABASE_URL: 'postgres://local/db' },
          instructions: 'Run typecheck.',
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      config: { setup: string[]; env: Record<string, string>; instructions: string }
      draft: unknown
      secretNames: string[]
    }

    expect(body.config.setup).toEqual(['pnpm install'])
    expect(body.config.env).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: '${secret.DATABASE_URL}',
    })
    // Survives the round trip through mergeProjectConfig rather than being
    // dropped on the way to the response.
    expect(body.config.instructions).toBe('Run typecheck.')

    // The response echoes the stored name, which is what the app renders; the
    // value is checked against the store below, so nothing here reveals it.
    expect(body.secretNames).toContain('DATABASE_URL')

    // Saving is what clears a pending proposal, and the response says so
    // without the app needing a second request to find out.
    expect(body.draft).toBeNull()

    const [saved] = await db.select().from(environments).where(eq(environments.id, environment.id))
    expect(saved!.configOverride).toMatchObject({ setup: ['pnpm install'] })

    // Secrets stay project-scoped: the credentials a repository needs do not
    // change with the branch being worked on.
    expect(await secretStore.get('DATABASE_URL', projectId)).toBe('postgres://local/db')
  })

  it('gives each environment its own config', async () => {
    const first = await createEnvironment(projectId, 'First')
    const second = await createEnvironment(projectId, 'Second')

    await request(`/api/projects/${projectId}/environment?environmentId=${first.id}`, {
      method: 'PUT',
      body: JSON.stringify({ setup: ['pnpm install'] }),
    })

    const body = (await (
      await request(`/api/projects/${projectId}/environment?environmentId=${second.id}`)
    ).json()) as { config: null }

    expect(body.config).toBeNull()
  })

  it('clears the draft when config is saved', async () => {
    const environment = await createEnvironment()
    await db
      .update(environments)
      .set({ environmentDraft: { setup: ['npm ci'], env: {} } })
      .where(eq(environments.id, environment.id))

    await request(`/api/projects/${projectId}/environment?environmentId=${environment.id}`, {
      method: 'PUT',
      body: JSON.stringify({ setup: ['pnpm install'] }),
    })

    const [after] = await db.select().from(environments).where(eq(environments.id, environment.id))
    expect(after!.environmentDraft).toBeNull()
  })

  it('exposes a draft until confirmed', async () => {
    const environment = await createEnvironment()
    await db
      .update(environments)
      .set({ environmentDraft: { setup: ['npm ci'], env: { API_KEY: { secret: true } } } })
      .where(eq(environments.id, environment.id))

    const body = (await (
      await request(`/api/projects/${projectId}/environment?environmentId=${environment.id}`)
    ).json()) as { draft: { setup: string[] } | null }

    expect(body.draft?.setup).toEqual(['npm ci'])
  })

  it('404s for an environment that does not exist', async () => {
    const response = await request(
      `/api/projects/${projectId}/environment?environmentId=3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f`,
    )

    expect(response.status).toBe(404)
  })

  it('403s reading an environment from another project', async () => {
    const other = await otherProject()
    const foreign = await createEnvironment(other.id, 'Theirs')

    const response = await request(
      `/api/projects/${projectId}/environment?environmentId=${foreign.id}`,
    )

    expect(response.status).toBe(403)
  })

  it('403s writing an environment from another project, without touching secrets', async () => {
    const other = await otherProject()
    const foreign = await createEnvironment(other.id, 'Theirs')

    const response = await request(
      `/api/projects/${projectId}/environment?environmentId=${foreign.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({ setup: ['rm -rf /'], secrets: { STOLEN: 'value' } }),
      },
    )

    expect(response.status).toBe(403)

    // The guard runs before the secret upsert: a refused request leaves no
    // trace on either project.
    expect(await secretStore.has('STOLEN', projectId)).toBe(false)
    expect(await secretStore.has('STOLEN', other.id)).toBe(false)

    const [untouched] = await db.select().from(environments).where(eq(environments.id, foreign.id))
    expect(untouched!.configOverride).toBeNull()
  })
})
