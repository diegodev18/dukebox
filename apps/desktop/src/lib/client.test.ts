import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiFailure, baseUrl, DukeboxClient, reachable, socketUrl } from '@/lib/client'

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
    const fetchMock = respondWith({ deviceId: 'd1', deviceName: 'Mac' })
    await client.whoami()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer device-token')
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

  it('forwards remote control when the caller asks', async () => {
    const fetchMock = respondWith({ id: 's1' })
    await client.startSession({
      projectId: 'p1',
      agentId: 'claude-code',
      prompt: 'go',
      remoteControl: true,
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).remoteControl).toBe(true)
  })

  it('archives a session', async () => {
    const fetchMock = respondWith({ archived: true })
    await client.archiveSession('00000000-0000-4000-8000-000000000001')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/sessions/00000000-0000-4000-8000-000000000001/archive')
    expect(init.method).toBe('POST')
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
