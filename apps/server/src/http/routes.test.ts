import { projects, sessions } from '@dukebox/db'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { AGENT_CREDENTIAL_SECRET, SecretStore } from '../secrets/store.js'
import { issuePairingCode, redeemPairingCode } from '../auth/pairing.js'
import { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import { SessionError, SessionManager } from '../sessions/manager.js'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { closeRedis, redis } from '../testing/redis.js'
import { createApp } from './app.js'

/**
 * The REST surface the desktop app talks to.
 *
 * GitHub and the session manager are stubbed: what these cover is the routing,
 * validation, and status codes, which is what a client actually depends on.
 * Starting real containers is the session manager's own test.
 */

const bus = new EventBus(db, redis)

const REPOSITORIES = [
  {
    nameWithOwner: 'diego/dukebox',
    defaultBranchRef: { name: 'main' },
    isPrivate: true,
    updatedAt: '2026-07-31T17:51:52Z',
  },
  {
    nameWithOwner: 'diego/other',
    defaultBranchRef: { name: 'master' },
    isPrivate: false,
    updatedAt: '2026-07-30T10:00:00Z',
  },
]

const github = {
  listRepositories: vi.fn(async () => REPOSITORIES),
  defaultBranch: vi.fn(async () => 'main'),
  listBranches: vi.fn(async () => ['main', 'develop']),
} as unknown as GitHubClient

const sessionManager = {
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  archive: vi.fn(async () => {}),
  openPullRequest: vi.fn(async () => 'https://github.com/diego/dukebox/pull/1'),
} as unknown as SessionManager

const secretStore = new SecretStore(db, randomBytes(32))

const app = createApp({
  db,
  serverName: 'dukebox-test',
  features: { github, bus, sessions: sessionManager, secrets: secretStore },
})

let token = ''

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

async function createProject(repoFullName = 'diego/dukebox') {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName, defaultBranch: 'main' })
    .returning()
  return project!
}

async function createSession(projectId: string, overrides = {}) {
  const [session] = await db
    .insert(sessions)
    .values({
      projectId,
      agentId: 'claude-code',
      status: 'running',
      branch: 'duke/abc123',
      baseBranch: 'main',
      title: 'Add a thing',
      ...overrides,
    })
    .returning()
  return session!
}

describe('authentication', () => {
  it('guards every project and session route', async () => {
    // The middleware covers /api by prefix, so a route added later is
    // protected by default rather than by remembering to protect it.
    const paths = [
      '/api/repositories',
      '/api/projects',
      '/api/sessions',
      '/api/sessions/00000000-0000-4000-8000-000000000000',
    ]

    for (const path of paths) {
      expect((await app.request(path)).status).toBe(401)
    }
  })
})

describe('GET /api/repositories', () => {
  it('lists what is on GitHub', async () => {
    const response = await request('/api/repositories')
    const body = (await response.json()) as { repositories: { fullName: string }[] }

    expect(response.status).toBe(200)
    expect(body.repositories.map((repo) => repo.fullName)).toEqual(['diego/dukebox', 'diego/other'])
  })

  it('marks repositories that are already projects', async () => {
    await createProject('diego/dukebox')

    const body = (await (await request('/api/repositories')).json()) as {
      repositories: { fullName: string; isRegistered: boolean }[]
    }

    // Lets the app show one list instead of making the user cross-reference
    // two.
    expect(body.repositories.find((r) => r.fullName === 'diego/dukebox')?.isRegistered).toBe(true)
    expect(body.repositories.find((r) => r.fullName === 'diego/other')?.isRegistered).toBe(false)
  })

  it('matches registration regardless of case, as GitHub does', async () => {
    await createProject('Diego/Dukebox')

    const body = (await (await request('/api/repositories')).json()) as {
      repositories: { fullName: string; isRegistered: boolean }[]
    }

    expect(body.repositories.find((r) => r.fullName === 'diego/dukebox')?.isRegistered).toBe(true)
  })
})

describe('POST /api/projects', () => {
  it('registers a repository', async () => {
    const response = await post('/api/projects', { repoFullName: 'diego/dukebox' })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      repoFullName: 'diego/dukebox',
      defaultBranch: 'main',
      sessionCount: 0,
    })
  })

  it('asks GitHub for the default branch when none is given', async () => {
    await post('/api/projects', { repoFullName: 'diego/dukebox' })
    expect(github.defaultBranch).toHaveBeenCalledWith('diego/dukebox')
  })

  it('takes the caller at their word when a branch is given', async () => {
    const response = await post('/api/projects', {
      repoFullName: 'diego/dukebox',
      defaultBranch: 'develop',
    })

    expect(await response.json()).toMatchObject({ defaultBranch: 'develop' })
    expect(github.defaultBranch).not.toHaveBeenCalled()
  })

  it('rejects a repository GitHub cannot see', async () => {
    vi.mocked(github.defaultBranch).mockRejectedValueOnce(new Error('not found'))

    // Catching a typo here turns it into an error the user can act on, rather
    // than a session that fails at clone time.
    const response = await post('/api/projects', { repoFullName: 'diego/typo' })
    expect(response.status).toBe(404)
  })

  it('rejects a duplicate', async () => {
    await createProject('diego/dukebox')

    const response = await post('/api/projects', { repoFullName: 'diego/dukebox' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'already_exists' })
  })

  it.each([
    ['a name without an owner', { repoFullName: 'dukebox' }],
    ['an empty name', { repoFullName: '' }],
    ['a missing name', {}],
    ['a name with a space', { repoFullName: 'diego/duke box' }],
  ])('rejects %s', async (_label, body) => {
    expect((await post('/api/projects', body)).status).toBe(400)
  })
})

describe('GET /api/projects', () => {
  it('returns nothing when none are registered', async () => {
    expect(await (await request('/api/projects')).json()).toEqual({ projects: [] })
  })

  it('counts the sessions each project has run', async () => {
    const project = await createProject()
    await createSession(project.id)
    await createSession(project.id)

    const body = (await (await request('/api/projects')).json()) as {
      projects: { sessionCount: number }[]
    }

    expect(body.projects[0]?.sessionCount).toBe(2)
  })

  it('counts zero for a project with no sessions', async () => {
    await createProject()

    const body = (await (await request('/api/projects')).json()) as {
      projects: { sessionCount: number }[]
    }

    // A left join would drop the project entirely if this were an inner one.
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]?.sessionCount).toBe(0)
  })
})

describe('GET /api/projects/:id/branches', () => {
  it('lists the repository branches', async () => {
    const project = await createProject()
    const response = await request(`/api/projects/${project.id}/branches`)

    expect(await response.json()).toEqual({ branches: ['main', 'develop'] })
  })

  it('returns 404 for an unknown project', async () => {
    const response = await request('/api/projects/00000000-0000-4000-8000-000000000000/branches')
    expect(response.status).toBe(404)
  })

  it('returns structured JSON when GitHub fails unexpectedly', async () => {
    vi.mocked(github.listBranches).mockRejectedValueOnce(new Error('unexpected gh output'))
    // The handler logs the failure, which is right in production and noise here.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const project = await createProject()
    const response = await request(`/api/projects/${project.id}/branches`)
    logged.mockRestore()

    // Without a handler this arrives as plain-text "Internal Server Error",
    // which a JSON client cannot parse and a person cannot act on.
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: 'internal_error',
      message: expect.stringContaining('unexpected gh output'),
    })
  })
})

describe('DELETE /api/projects/:id', () => {
  it('removes the project', async () => {
    const project = await createProject()

    expect((await request(`/api/projects/${project.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await db.select().from(projects)).toHaveLength(0)
  })

  it('removes its sessions with it', async () => {
    const project = await createProject()
    await createSession(project.id)

    await request(`/api/projects/${project.id}`, { method: 'DELETE' })
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('returns 404 for an unknown project', async () => {
    const response = await request('/api/projects/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    })
    expect(response.status).toBe(404)
  })
})

describe('POST /api/sessions', () => {
  it('accepts with 202, since the container is still being built', async () => {
    const project = await createProject()
    const session = await createSession(project.id, { status: 'provisioning' })
    vi.mocked(sessionManager.start).mockResolvedValueOnce(session)

    const response = await post('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
      prompt: 'add a multiply function',
    })

    // 202 rather than 201: the session exists but is not ready, and the client
    // subscribes with the id to watch provisioning happen.
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ status: 'provisioning' })
  })

  it('passes the base branch through when given', async () => {
    const project = await createProject()
    vi.mocked(sessionManager.start).mockResolvedValueOnce(await createSession(project.id))

    await post('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
      baseBranch: 'develop',
      prompt: 'x',
    })

    expect(sessionManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'develop' }),
    )
  })

  it('omits the base branch entirely when not given', async () => {
    const project = await createProject()
    vi.mocked(sessionManager.start).mockResolvedValueOnce(await createSession(project.id))

    await post('/api/sessions', { projectId: project.id, agentId: 'claude-code', prompt: 'x' })

    // Absent, not undefined: the manager reads an absent branch as "use the
    // project's default".
    const options = vi.mocked(sessionManager.start).mock.calls[0]?.[0]
    expect(options && 'baseBranch' in options).toBe(false)
  })

  it('passes the model through when given', async () => {
    const project = await createProject()
    vi.mocked(sessionManager.start).mockResolvedValueOnce(await createSession(project.id))

    await post('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
      model: 'opus',
      prompt: 'x',
    })

    expect(sessionManager.start).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }))
  })

  it('reports an unknown project as a bad request', async () => {
    vi.mocked(sessionManager.start).mockRejectedValueOnce(new SessionError('no such project'))

    const response = await post('/api/sessions', {
      projectId: '00000000-0000-4000-8000-000000000000',
      agentId: 'claude-code',
      prompt: 'x',
    })

    expect(response.status).toBe(400)
  })

  it.each([
    ['a missing prompt', { projectId: '00000000-0000-4000-8000-000000000000', agentId: 'a' }],
    [
      'an empty prompt',
      { projectId: '00000000-0000-4000-8000-000000000000', agentId: 'a', prompt: '' },
    ],
    ['a project id that is not a uuid', { projectId: 'nope', agentId: 'a', prompt: 'x' }],
    ['no body at all', {}],
  ])('rejects %s', async (_label, body) => {
    expect((await post('/api/sessions', body)).status).toBe(400)
  })
})

describe('GET /api/sessions', () => {
  it('lists sessions newest first', async () => {
    const project = await createProject()
    await createSession(project.id, { title: 'First' })
    await createSession(project.id, { title: 'Second' })

    const body = (await (await request('/api/sessions')).json()) as {
      sessions: { title: string }[]
    }

    expect(body.sessions.map((session) => session.title)).toEqual(['Second', 'First'])
  })

  it('reports no pull request until one is opened', async () => {
    // The app decides between "Open pull request" and "View pull request" on
    // this field. Omitting it would leave it offering to open a second one.
    const project = await createProject()
    await createSession(project.id, { title: 'Fresh' })

    const body = (await (await request('/api/sessions')).json()) as {
      sessions: { pullRequestUrl: string | null }[]
    }

    expect(body.sessions[0]).toHaveProperty('pullRequestUrl', null)
  })

  it('filters by project', async () => {
    const first = await createProject('diego/one')
    const second = await createProject('diego/two')
    await createSession(first.id, { title: 'From first' })
    await createSession(second.id, { title: 'From second' })

    const body = (await (await request(`/api/sessions?projectId=${first.id}`)).json()) as {
      sessions: { title: string }[]
    }

    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.title).toBe('From first')
  })

  it('reports lastSeq, which is what a client resumes from', async () => {
    const project = await createProject()
    const session = await createSession(project.id)
    await bus.append(session.id, { type: 'assistant_text', delta: 'hello' })

    const body = (await (await request(`/api/sessions/${session.id}`)).json()) as {
      lastSeq: number
    }

    expect(body.lastSeq).toBe(1)
  })

  it('returns 404 for an unknown session', async () => {
    const response = await request('/api/sessions/00000000-0000-4000-8000-000000000000')
    expect(response.status).toBe(404)
  })
})

describe('GET /api/sessions/:id/events', () => {
  it('returns the session history', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    for (const delta of ['a', 'b', 'c']) {
      await bus.append(session.id, { type: 'assistant_text', delta })
    }

    const body = (await (await request(`/api/sessions/${session.id}/events`)).json()) as {
      events: { seq: number }[]
    }

    expect(body.events.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('returns only what follows the given sequence number', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    for (const delta of ['a', 'b', 'c']) {
      await bus.append(session.id, { type: 'assistant_text', delta })
    }

    const body = (await (await request(`/api/sessions/${session.id}/events?after=2`)).json()) as {
      events: { seq: number }[]
    }

    expect(body.events.map((event) => event.seq)).toEqual([3])
  })

  it('treats a nonsense cursor as the beginning', async () => {
    const project = await createProject()
    const session = await createSession(project.id)
    await bus.append(session.id, { type: 'assistant_text', delta: 'a' })

    const body = (await (
      await request(`/api/sessions/${session.id}/events?after=banana`)
    ).json()) as { events: unknown[] }

    expect(body.events).toHaveLength(1)
  })

  it('returns 404 for an unknown session', async () => {
    const response = await request('/api/sessions/00000000-0000-4000-8000-000000000000/events')
    expect(response.status).toBe(404)
  })
})

describe('POST /api/sessions/:id/pr', () => {
  it('returns the pull request URL', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    const response = await post(`/api/sessions/${session.id}/pr`, {})

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ url: expect.stringContaining('/pull/1') })
  })

  it('passes a title through', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    await post(`/api/sessions/${session.id}/pr`, { title: 'Custom title' })
    expect(sessionManager.openPullRequest).toHaveBeenCalledWith(session.id, 'Custom title')
  })

  it('reports a session with nothing to submit as a conflict', async () => {
    vi.mocked(sessionManager.openPullRequest).mockRejectedValueOnce(
      new SessionError('there is nothing to open a pull request for'),
    )

    const project = await createProject()
    const session = await createSession(project.id)

    // 409: understood, but the session is not in a state where a pull request
    // means anything.
    const response = await post(`/api/sessions/${session.id}/pr`, {})
    expect(response.status).toBe(409)
  })
})

describe('DELETE /api/sessions/:id', () => {
  it('stops the session', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    const response = await request(`/api/sessions/${session.id}`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(sessionManager.stop).toHaveBeenCalledWith(session.id)
  })

  it('returns 404 for an unknown session', async () => {
    const response = await request('/api/sessions/00000000-0000-4000-8000-000000000000', {
      method: 'DELETE',
    })

    expect(response.status).toBe(404)
    expect(sessionManager.stop).not.toHaveBeenCalled()
  })
})

describe('POST /api/sessions/:id/archive', () => {
  it('archives the session', async () => {
    const project = await createProject()
    const session = await createSession(project.id)

    const response = await post(`/api/sessions/${session.id}/archive`, {})

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ archived: true })
    expect(sessionManager.archive).toHaveBeenCalledWith(session.id)
  })

  it('returns 404 for an unknown session', async () => {
    vi.mocked(sessionManager.archive).mockRejectedValueOnce(
      new SessionError('no such session: 00000000-0000-4000-8000-000000000000'),
    )

    const response = await post('/api/sessions/00000000-0000-4000-8000-000000000000/archive', {})

    expect(response.status).toBe(404)
  })
})

describe('GET /api/sessions archived', () => {
  it('omits archived sessions from the list', async () => {
    const project = await createProject()
    const active = await createSession(project.id, { title: 'Still here' })
    await createSession(project.id, { title: 'Gone', archivedAt: new Date() })

    const body = (await (await request('/api/sessions')).json()) as {
      sessions: { id: string; title: string }[]
    }

    expect(body.sessions.map((session) => session.id)).toEqual([active.id])
  })
})

describe('agent credentials', () => {
  const TOKEN = 'sk-ant-oat-a-real-looking-token'

  it('reports none configured on a fresh server', async () => {
    expect(await (await request('/api/agent-credentials')).json()).toEqual({ configured: false })
  })

  it('stores a token', async () => {
    const response = await request('/api/agent-credentials', {
      method: 'PUT',
      body: JSON.stringify({ token: TOKEN }),
    })

    expect(response.status).toBe(200)
    expect(await secretStore.get(AGENT_CREDENTIAL_SECRET)).toBe(TOKEN)
  })

  it('never returns the token it stored', async () => {
    await request('/api/agent-credentials', {
      method: 'PUT',
      body: JSON.stringify({ token: TOKEN }),
    })

    // A route that returned it would make every client that called it another
    // place the token lives.
    const body = await (await request('/api/agent-credentials')).text()

    expect(body).not.toContain(TOKEN)
    expect(JSON.parse(body)).toEqual({ configured: true })
  })

  it('replaces an existing token', async () => {
    const put = (token: string) =>
      request('/api/agent-credentials', { method: 'PUT', body: JSON.stringify({ token }) })

    await put('first')
    await put('second')

    expect(await secretStore.get(AGENT_CREDENTIAL_SECRET)).toBe('second')
  })

  it('removes a token', async () => {
    await request('/api/agent-credentials', {
      method: 'PUT',
      body: JSON.stringify({ token: TOKEN }),
    })

    expect((await request('/api/agent-credentials', { method: 'DELETE' })).status).toBe(200)
    expect(await secretStore.has(AGENT_CREDENTIAL_SECRET)).toBe(false)
  })

  it('returns 404 when removing one that was never set', async () => {
    expect((await request('/api/agent-credentials', { method: 'DELETE' })).status).toBe(404)
  })

  it.each([
    ['an empty token', { token: '' }],
    ['a missing token', {}],
  ])('rejects %s', async (_label, body) => {
    const response = await request('/api/agent-credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(400)
  })

  it('requires a device token like every other route', async () => {
    expect((await app.request('/api/agent-credentials')).status).toBe(401)
  })
})

describe('project secrets', () => {
  it('lists names without values', async () => {
    const project = await createProject()
    await secretStore.set('DATABASE_URL', 'postgres://secret', project.id)

    const body = await (await request(`/api/projects/${project.id}/secrets`)).text()

    expect(JSON.parse(body)).toEqual({ names: ['DATABASE_URL'] })
    expect(body).not.toContain('postgres://secret')
  })

  it('stores a secret', async () => {
    const project = await createProject()

    const response = await request(`/api/projects/${project.id}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'API_KEY', value: 'key-123' }),
    })

    expect(response.status).toBe(200)
    expect(await secretStore.get('API_KEY', project.id)).toBe('key-123')
  })

  it('removes a secret', async () => {
    const project = await createProject()
    await secretStore.set('API_KEY', 'key-123', project.id)

    const response = await request(`/api/projects/${project.id}/secrets/API_KEY`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(await secretStore.has('API_KEY', project.id)).toBe(false)
  })

  it.each([
    ['a lowercase name', { name: 'api_key', value: 'x' }],
    ['a name starting with a digit', { name: '1KEY', value: 'x' }],
    ['a name with a hyphen', { name: 'API-KEY', value: 'x' }],
    ['an empty value', { name: 'API_KEY', value: '' }],
  ])('rejects %s', async (_label, body) => {
    // A name a shell cannot export would be accepted here and then silently
    // dropped when the container starts.
    const project = await createProject()
    const response = await request(`/api/projects/${project.id}/secrets`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(400)
  })

  it('returns 404 for an unknown project', async () => {
    const response = await request('/api/projects/00000000-0000-4000-8000-000000000000/secrets')
    expect(response.status).toBe(404)
  })
})

describe('project environment', () => {
  it('returns null config when none is saved', async () => {
    const project = await createProject()
    const body = (await (await request(`/api/projects/${project.id}/environment`)).json()) as {
      config: null
      draft: null
      secretNames: string[]
    }

    expect(body).toEqual({ config: null, draft: null, secretNames: [] })
  })

  it('saves setup, secret refs, and secret values', async () => {
    const project = await createProject()

    const response = await request(`/api/projects/${project.id}/environment`, {
      method: 'PUT',
      body: JSON.stringify({
        setup: ['pnpm install'],
        secretEnv: ['DATABASE_URL'],
        literalEnv: { NODE_ENV: 'development' },
        secrets: { DATABASE_URL: 'postgres://local/db' },
        instructions: 'Run typecheck.',
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      config: { setup: string[]; env: Record<string, string>; instructions: string }
      draft: null
      secretNames: string[]
    }

    expect(body.config.setup).toEqual(['pnpm install'])
    expect(body.config.env).toEqual({
      NODE_ENV: 'development',
      DATABASE_URL: '${secret.DATABASE_URL}',
    })
    expect(body.config.instructions).toBe('Run typecheck.')
    expect(body.secretNames).toContain('DATABASE_URL')
    expect(body.draft).toBeNull()

    const listed = (await (await request('/api/projects')).json()) as {
      projects: { hasEnvironment: boolean }[]
    }
    expect(listed.projects[0]?.hasEnvironment).toBe(true)
  })

  it('exposes a draft until confirmed', async () => {
    const project = await createProject()
    await db
      .update(projects)
      .set({
        environmentDraft: {
          setup: ['npm ci'],
          env: { API_KEY: { secret: true } },
        },
      })
      .where(eq(projects.id, project.id))

    const body = (await (await request(`/api/projects/${project.id}/environment`)).json()) as {
      draft: { setup: string[] } | null
    }

    expect(body.draft?.setup).toEqual(['npm ci'])
  })

  it('returns a proposal from an environment_setup session', async () => {
    const project = await createProject()
    await db
      .update(projects)
      .set({
        environmentDraft: { setup: ['pnpm install'], env: {} },
      })
      .where(eq(projects.id, project.id))

    const session = await createSession(project.id, { purpose: 'environment_setup' })
    const body = (await (
      await request(`/api/sessions/${session.id}/environment-proposal`)
    ).json()) as { proposal: { setup: string[] } | null }

    expect(body.proposal?.setup).toEqual(['pnpm install'])
  })

  it('rejects a proposal lookup on a coding session', async () => {
    const project = await createProject()
    const session = await createSession(project.id)
    const response = await request(`/api/sessions/${session.id}/environment-proposal`)
    expect(response.status).toBe(400)
  })
})

describe('POST /api/sessions purpose', () => {
  it('accepts an environment_setup session without a prompt', async () => {
    const project = await createProject()
    const session = await createSession(project.id, {
      status: 'provisioning',
      purpose: 'environment_setup',
      title: 'Configure environment',
    })
    vi.mocked(sessionManager.start).mockResolvedValueOnce(session)

    const response = await post('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
      purpose: 'environment_setup',
    })

    expect(response.status).toBe(202)
    expect(sessionManager.start).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'environment_setup' }),
    )
  })

  it('rejects a coding session without a prompt', async () => {
    const project = await createProject()
    const response = await post('/api/sessions', {
      projectId: project.id,
      agentId: 'claude-code',
      purpose: 'coding',
    })
    expect(response.status).toBe(400)
  })
})

describe('without features configured', () => {
  it('has no project or session routes', async () => {
    // A server built without a GitHub client or session manager still serves
    // pairing and device management, which is what the install flow needs
    // before anything else works.
    const minimal = createApp({ db, serverName: 'minimal' })

    const response = await minimal.request('/api/projects', {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(404)
  })
})
