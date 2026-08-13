import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiFailure,
  baseUrl,
  DukeboxClient,
  isAuthFailure,
  reachable,
  socketUrl,
} from '@/lib/client'

/**
 * The client is the only place the app knows how to reach a server, so what
 * matters here is the shape of what it sends and how it reports failure —
 * both of which a caller depends on.
 */

const address = { host: 'dukebox-vps.tail1234.ts.net', port: 7777, tls: false }

afterEach(() => {
  vi.restoreAllMocks()
})

/** Stand in for the server with a fixed response. */
function respondWith(body: unknown, init: { status?: number } = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  )

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('baseUrl', () => {
  it('uses http on a tailnet, where WireGuard already secures the link', () => {
    expect(baseUrl(address)).toBe('http://dukebox-vps.tail1234.ts.net:7777')
  })

  it('uses https when the transport asks for it', () => {
    expect(baseUrl({ ...address, tls: true })).toBe('https://dukebox-vps.tail1234.ts.net:7777')
  })
})

describe('socketUrl', () => {
  it('carries the token, which is all a browser handshake can send', () => {
    // A WebSocket handshake cannot set headers, so the token travels in the
    // query string.
    expect(socketUrl(address, 'tok-123')).toContain('token=tok-123')
  })

  it('escapes a token containing url characters', () => {
    expect(socketUrl(address, 'a+b/c')).toContain('token=a%2Bb%2Fc')
  })

  it('matches the scheme to the transport', () => {
    expect(socketUrl(address, 't')).toMatch(/^ws:/)
    expect(socketUrl({ ...address, tls: true }, 't')).toMatch(/^wss:/)
  })
})

describe('DukeboxClient', () => {
  const client = new DukeboxClient(address, 'device-token')

  it('sends the device token on every request', async () => {
    const fetchMock = respondWith({
      deviceId: 'd1',
      deviceName: 'Mac',
      role: 'owner',
      capabilities: { manageDevices: true, manageAgents: true, deleteProjects: true },
    })
    await client.whoami()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer device-token')
  })

  it('lists devices', async () => {
    const fetchMock = respondWith({
      devices: [
        {
          id: 'd1',
          name: 'Mac',
          platform: 'macos',
          role: 'owner',
          createdAt: 1,
          lastSeenAt: null,
        },
      ],
    })
    const devices = await client.listDevices()
    expect(devices[0]?.role).toBe('owner')
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/devices')
  })

  it('unwraps a list response', async () => {
    respondWith({ projects: [{ id: 'p1', repoFullName: 'diego/dukebox' }] })

    const projects = await client.listProjects()
    expect(projects).toHaveLength(1)
  })

  it('lists branches for a project', async () => {
    const fetchMock = respondWith({ branches: ['main', 'develop'] })
    const branches = await client.listBranches('00000000-0000-4000-8000-000000000001')

    expect(branches).toEqual(['main', 'develop'])
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/projects/00000000-0000-4000-8000-000000000001/branches')
  })

  it('reports a failure with the server code a caller can branch on', async () => {
    respondWith({ error: 'already_exists', message: 'that is already a project' }, { status: 409 })

    await expect(client.createProject('diego/dukebox')).rejects.toMatchObject({
      status: 409,
      code: 'already_exists',
    })
  })

  it('survives a failure body that is not the expected shape', async () => {
    // A proxy or a crash can answer with something other than the server's
    // error shape; that must not become an unhandled rejection.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 502 })),
    )

    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiFailure)
  })

  it('omits an absent base branch rather than sending undefined', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({ projectId: 'p1', agentId: 'claude-code', prompt: 'go' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('baseBranch')
  })

  it('forwards a base branch when the caller picks one', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({
      projectId: 'p1',
      agentId: 'claude-code',
      prompt: 'go',
      baseBranch: 'develop',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).baseBranch).toBe('develop')
  })

  it('forwards a model when the caller picks one', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({
      projectId: 'p1',
      agentId: 'claude-code',
      prompt: 'go',
      model: 'opus',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).model).toBe('opus')
  })

  it('forwards a permission mode when the caller picks one', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({
      projectId: 'p1',
      agentId: 'claude-code',
      prompt: 'go',
      permissionMode: 'plan',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).permissionMode).toBe('plan')
  })

  it('forwards git preferences when the caller has them', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({
      projectId: 'p1',
      agentId: 'claude-code',
      prompt: 'go',
      gitPreferences: { autoOpenDraft: false, mergeMethod: 'rebase' },
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).gitPreferences).toMatchObject({
      autoOpenDraft: false,
      mergeMethod: 'rebase',
    })
  })

  it('archives a session', async () => {
    const fetchMock = respondWith({ archived: true })
    await client.archiveSession('00000000-0000-4000-8000-000000000001')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/sessions/00000000-0000-4000-8000-000000000001/archive')
    expect(init.method).toBe('POST')
  })

  it('deletes a session permanently', async () => {
    const fetchMock = respondWith({ deleted: true })
    await client.deleteSession('00000000-0000-4000-8000-000000000001')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/sessions/00000000-0000-4000-8000-000000000001/delete')
    expect(init.method).toBe('POST')
  })

  it('opens, reads, marks ready, and merges a pull request', async () => {
    const pr = {
      url: 'https://github.com/diego/dukebox/pull/1',
      title: 'Add a thing',
      isDraft: true,
      state: 'open',
    }
    const fetchMock = respondWith(pr)
    const sessionId = '00000000-0000-4000-8000-000000000001'

    await client.openPullRequest(sessionId)
    await client.getPullRequest(sessionId)
    await client.markPullRequestReady(sessionId)
    await client.mergePullRequest(sessionId, 'squash')

    const urls = fetchMock.mock.calls.map((call) => (call[0] as string).replace(/.*\/api/, '/api'))
    expect(urls).toEqual([
      `/api/sessions/${sessionId}/pr`,
      `/api/sessions/${sessionId}/pr`,
      `/api/sessions/${sessionId}/pr/ready`,
      `/api/sessions/${sessionId}/pr/merge`,
    ])
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST')
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe('POST')
    expect(JSON.parse((fetchMock.mock.calls[3]?.[1] as RequestInit).body as string)).toEqual({
      method: 'squash',
    })
  })

  it('lists workspace paths', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const fetchMock = respondWith({ paths: ['src/app.ts'] })
    const paths = await client.listWorkspaceTree(sessionId)

    expect(paths).toEqual(['src/app.ts'])
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain(
      `/api/sessions/${sessionId}/workspace/tree`,
    )
  })

  it('reads a workspace file with the path query', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001'
    const fetchMock = respondWith({
      path: 'src/app.ts',
      content: 'export {}',
      binary: false,
      truncated: false,
    })
    const file = await client.readWorkspaceFile(sessionId, 'src/app.ts')

    expect(file.content).toBe('export {}')
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('path=src%2Fapp.ts')
  })

  it('deletes a project', async () => {
    const fetchMock = respondWith({ deleted: true })
    await client.deleteProject('00000000-0000-4000-8000-000000000001')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/projects/00000000-0000-4000-8000-000000000001')
    expect(init.method).toBe('DELETE')
  })

  it('lists OpenCode providers', async () => {
    const fetchMock = respondWith({
      providers: [{ id: 'anthropic', kind: 'anthropic', name: 'Anthropic', models: [] }],
    })
    const providers = await client.listOpencodeProviders()

    expect(providers).toHaveLength(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/opencode/providers')
  })

  it('upserts an OpenCode provider', async () => {
    const fetchMock = respondWith({
      provider: { id: 'anthropic', kind: 'anthropic', name: 'Anthropic', models: [] },
    })
    await client.upsertOpencodeProvider({ kind: 'anthropic', apiKey: 'sk-ant' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/opencode/providers')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ kind: 'anthropic', apiKey: 'sk-ant' })
  })

  it('lists the OpenCode catalog', async () => {
    const fetchMock = respondWith({
      providers: [{ kind: 'anthropic', name: 'Anthropic', models: [] }],
    })
    const catalog = await client.listOpencodeCatalog()

    expect(catalog).toHaveLength(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/opencode/catalog')
  })

  it('deletes an OpenCode provider', async () => {
    const fetchMock = respondWith({ deleted: true })
    await client.deleteOpencodeProvider('anthropic')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/opencode/providers/anthropic')
    expect(init.method).toBe('DELETE')
  })

  /**
   * The environment routes are keyed by environment, not by project, and the
   * server answers 400 without `?environmentId=`. These assert the query
   * string reaches the wire: the server's own tests pass the parameter, so
   * nothing else in the suite notices when a desktop caller stops sending it.
   */
  it('names the environment when reading its config', async () => {
    const fetchMock = respondWith({ config: null, draft: null, secretNames: [] })
    await client.getEnvironment(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000e1',
    )

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/projects/00000000-0000-4000-8000-000000000001/environment')
    expect(url).toContain('environmentId=00000000-0000-4000-8000-0000000000e1')
  })

  it('names the environment when saving its config', async () => {
    const fetchMock = respondWith({ config: null, draft: null, secretNames: [] })
    await client.putEnvironment(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-0000000000e1',
      { setup: [], secretEnv: [], literalEnv: {}, secrets: {} },
    )

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('environmentId=00000000-0000-4000-8000-0000000000e1')
    expect(init.method).toBe('PUT')
  })
})

describe('reachable', () => {
  it('is ok when the server answers its health check', async () => {
    respondWith({ ok: true })
    expect(await reachable(address)).toEqual({ ok: true })
  })

  it('reports rather than throws when the server is not there', async () => {
    // Called before redeeming a pairing code, where a thrown error would lose
    // the single-use code to an exception the screen never sees.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error')
      }),
    )

    expect(await reachable(address)).toMatchObject({ ok: false, reason: 'blocked' })
  })

  it('separates a request that was refused from one that timed out', async () => {
    // They send someone to different places: a timeout is a server that is not
    // answering, a refusal is the request never leaving the app.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('signal timed out', 'TimeoutError')
      }),
    )

    expect(await reachable(address)).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('reports the status when something answers that is not Dukebox', async () => {
    respondWith({}, { status: 503 })

    expect(await reachable(address)).toMatchObject({
      ok: false,
      reason: 'http',
      detail: 'answered 503',
    })
  })
})

describe('isAuthFailure', () => {
  it('is true only for a 401 from the API', () => {
    expect(isAuthFailure(new ApiFailure(401, 'unauthorized', 'missing device token'))).toBe(true)
    expect(isAuthFailure(new ApiFailure(403, 'forbidden', 'only the owner'))).toBe(false)
    expect(isAuthFailure(new ApiFailure(500, 'unknown', 'request failed'))).toBe(false)
    expect(isAuthFailure(new TypeError('network error'))).toBe(false)
    expect(isAuthFailure(new Error('timeout'))).toBe(false)
  })
})
