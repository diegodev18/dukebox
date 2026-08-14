import type {
  ApiError,
  CreateEnvironmentRequest,
  CreateInviteResponse,
  DeviceSummary,
  EnvironmentProposal,
  EnvironmentSummary,
  GitPreferences,
  GrokLoginSnapshot,
  ListInvitesResponse,
  ListOpencodeCatalogResponse,
  ListOpencodeProvidersResponse,
  MeResponse,
  MergeMethod,
  OpencodeProvider,
  PairingInvite,
  PairRedeemResponse,
  ProjectEnvironmentResponse,
  ProjectSummary,
  PullRequestDetails,
  PullRequestSummary,
  PutProjectEnvironmentRequest,
  RepositorySummary,
  ResolvePullRequestConflictsResponse,
  SessionSummary,
  UpdateEnvironmentRequest,
  UpsertOpencodeProviderRequest,
  PermissionMode,
  WorkspaceFileResponse,
  WorkspaceTreeResponse,
} from '@dukebox/protocol'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

/**
 * Requests go through the native process when there is one.
 *
 * macOS refuses plaintext HTTP from a webview, and a Dukebox server is reached
 * over a tailnet — a `.ts.net` name has no certificate authority behind it and
 * cannot get one, so there is no TLS to fall back to. The webview's own fetch
 * fails with "Load failed" and nothing the frontend can do fixes it.
 *
 * Outside Tauri (tests, the preview page) this falls back to the platform
 * fetch, which is what those environments have.
 */
const httpFetch: typeof globalThis.fetch = (input, init) =>
  '__TAURI_INTERNALS__' in globalThis
    ? (tauriFetch as typeof globalThis.fetch)(input, init)
    : globalThis.fetch(input, init)

/**
 * The control plane, as the app talks to it.
 *
 * Every call carries the device token from pairing. Nothing here knows a
 * server address at build time: the app is handed one when the user pastes a
 * pairing link, which is what lets a single published binary serve everyone.
 */

export interface ServerAddress {
  host: string
  port: number
  /** False on a tailnet, where WireGuard already secures the link. */
  tls: boolean
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/**
 * The server rejected this device token.
 *
 * Distinct from a network failure: an unreachable server should be retried,
 * a revoked pairing should not. Callers that mix the two send the user back
 * to pairing over a blip.
 */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiFailure && error.status === 401
}

export function baseUrl(address: ServerAddress): string {
  return `${address.tls ? 'https' : 'http'}://${address.host}:${address.port}`
}

export function socketUrl(address: ServerAddress, token: string): string {
  const scheme = address.tls ? 'wss' : 'ws'
  return `${scheme}://${address.host}:${address.port}/ws?token=${encodeURIComponent(token)}`
}

export class DukeboxClient {
  constructor(
    private readonly address: ServerAddress,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await httpFetch(`${baseUrl(this.address)}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    })

    if (!response.ok) {
      // The server answers failures in a known shape, but a proxy or a crash
      // can produce something else — so a parse failure becomes a readable
      // error rather than an unhandled rejection.
      const body = (await response.json().catch(() => null)) as ApiError | null

      throw new ApiFailure(
        response.status,
        body?.error ?? 'unknown',
        body?.message ?? `request failed with ${response.status}`,
      )
    }

    return (await response.json()) as T
  }

  /** Confirm the token still works. Used on launch before showing anything. */
  async whoami(): Promise<MeResponse> {
    return this.request('/api/me')
  }

  async listDevices(): Promise<DeviceSummary[]> {
    const body = await this.request<{ devices: DeviceSummary[] }>('/api/devices')
    return body.devices
  }

  async createInvite(): Promise<CreateInviteResponse> {
    return this.request('/api/devices/invites', { method: 'POST' })
  }

  async listInvites(): Promise<PairingInvite[]> {
    const body = await this.request<ListInvitesResponse>('/api/devices/invites')
    return body.invites
  }

  async revokeInvite(id: string): Promise<void> {
    await this.request(`/api/devices/invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async revokeDevice(id: string): Promise<void> {
    await this.request(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    const body = await this.request<{ repositories: RepositorySummary[] }>('/api/repositories')
    return body.repositories
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const body = await this.request<{ projects: ProjectSummary[] }>('/api/projects')
    return body.projects
  }

  async createProject(repoFullName: string): Promise<ProjectSummary> {
    return this.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ repoFullName }),
    })
  }

  /**
   * Drop a project from Dukebox.
   *
   * Sessions cascade with it. Nothing on GitHub is touched.
   */
  async deleteProject(projectId: string): Promise<void> {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    })
  }

  async listBranches(projectId: string): Promise<string[]> {
    const body = await this.request<{ branches: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/branches`,
    )
    return body.branches
  }

  async listSessions(projectId?: string): Promise<SessionSummary[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    const body = await this.request<{ sessions: SessionSummary[] }>(`/api/sessions${query}`)
    return body.sessions
  }

  async startSession(options: {
    projectId: string
    agentId: string
    prompt?: string
    baseBranch?: string
    model?: string
    permissionMode?: PermissionMode
    purpose?: 'coding' | 'environment_setup'
    /** Omitted lets the server resolve one from the base branch. */
    environmentId?: string
    /**
     * Who this session's commits are authored as.
     *
     * Omitted when the app has no configured identity, in which case the
     * server uses its default.
     */
    commitIdentity?: { name: string; email: string }
    gitPreferences?: Partial<GitPreferences>
    /**
     * Files to stage into the sandbox before the first prompt runs, as
     * base64 data URIs.
     */
    files?: { name: string; data: string }[]
  }): Promise<SessionSummary> {
    return this.request('/api/sessions', { method: 'POST', body: JSON.stringify(options) })
  }

  async listEnvironments(projectId: string): Promise<EnvironmentSummary[]> {
    const body = await this.request<{ environments: EnvironmentSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/environments`,
    )
    return body.environments
  }

  async createEnvironment(
    projectId: string,
    request: CreateEnvironmentRequest,
  ): Promise<EnvironmentSummary> {
    const body = await this.request<{ environment: EnvironmentSummary }>(
      `/api/projects/${encodeURIComponent(projectId)}/environments`,
      { method: 'POST', body: JSON.stringify(request) },
    )
    return body.environment
  }

  async updateEnvironment(
    environmentId: string,
    request: UpdateEnvironmentRequest,
  ): Promise<EnvironmentSummary> {
    const body = await this.request<{ environment: EnvironmentSummary }>(
      `/api/environments/${encodeURIComponent(environmentId)}`,
      { method: 'PATCH', body: JSON.stringify(request) },
    )
    return body.environment
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.request(`/api/environments/${encodeURIComponent(environmentId)}`, {
      method: 'DELETE',
    })
  }

  async reorderEnvironments(projectId: string, ids: string[]): Promise<EnvironmentSummary[]> {
    const body = await this.request<{ environments: EnvironmentSummary[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/environments/reorder`,
      { method: 'POST', body: JSON.stringify({ ids }) },
    )
    return body.environments
  }

  /**
   * A single environment's config, keyed by environment rather than project.
   *
   * `environmentId` is required rather than optional because the server
   * answers 400 without it: a project has many environments now, and there is
   * no sensible default among them. Making it a required argument is what
   * stops a caller silently omitting it.
   */
  async getEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<ProjectEnvironmentResponse> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/environment?environmentId=${encodeURIComponent(environmentId)}`,
    )
  }

  async putEnvironment(
    projectId: string,
    environmentId: string,
    body: PutProjectEnvironmentRequest,
  ): Promise<ProjectEnvironmentResponse> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/environment?environmentId=${encodeURIComponent(environmentId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    )
  }

  async getEnvironmentProposal(sessionId: string): Promise<EnvironmentProposal | null> {
    const body = await this.request<{ proposal: EnvironmentProposal | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/environment-proposal`,
    )
    return body.proposal
  }

  async listProjectSecrets(projectId: string): Promise<string[]> {
    const body = await this.request<{ names: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/secrets`,
    )
    return body.names
  }

  async setProjectSecret(projectId: string, name: string, value: string): Promise<void> {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name, value }),
    })
  }

  /**
   * A session's history.
   *
   * Used to fill what the local cache is missing. Live events arrive over the
   * WebSocket instead.
   */
  async sessionEvents(sessionId: string, after = 0) {
    return this.request<{ events: unknown[] }>(`/api/sessions/${sessionId}/events?after=${after}`)
  }

  async openPullRequest(sessionId: string, title?: string): Promise<PullRequestSummary> {
    return this.request(`/api/sessions/${sessionId}/pr`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    })
  }

  async getPullRequest(sessionId: string): Promise<PullRequestDetails> {
    return this.request(`/api/sessions/${sessionId}/pr`)
  }

  async markPullRequestReady(sessionId: string): Promise<PullRequestSummary> {
    return this.request(`/api/sessions/${sessionId}/pr/ready`, { method: 'POST', body: '{}' })
  }

  async mergePullRequest(sessionId: string, method?: MergeMethod): Promise<PullRequestSummary> {
    return this.request(`/api/sessions/${sessionId}/pr/merge`, {
      method: 'POST',
      body: JSON.stringify(method ? { method } : {}),
    })
  }

  async resolvePullRequestConflicts(
    sessionId: string,
  ): Promise<ResolvePullRequestConflictsResponse> {
    return this.request(`/api/sessions/${sessionId}/pr/resolve-conflicts`, {
      method: 'POST',
      body: '{}',
    })
  }

  /**
   * Paths in the session's workspace, relative to the repository root.
   *
   * Tracked and untracked files; gitignored paths stay out. The Files tab
   * turns this list into a tree.
   */
  async listWorkspaceTree(sessionId: string): Promise<string[]> {
    const body = await this.request<WorkspaceTreeResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace/tree`,
    )
    return body.paths
  }

  /** Contents of one workspace path. Binary files come back with empty content. */
  async readWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceFileResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`,
    )
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}`, { method: 'DELETE' })
  }

  /**
   * Hide a session from the sidebar.
   *
   * The history stays on the server; this only stops listing it.
   */
  async archiveSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/archive`, { method: 'POST' })
  }

  /**
   * Permanently delete a session and its history.
   *
   * Unlike stop (the container stays for a follow-up) or archive (the row stays
   * for history), this removes everything. The UI asks for the title before
   * calling it.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/delete`, { method: 'POST' })
  }

  async agentCredentialsConfigured(): Promise<boolean> {
    const body = await this.request<{ configured: boolean }>('/api/agent-credentials')
    return body.configured
  }

  async setAgentCredentials(token: string): Promise<void> {
    await this.request('/api/agent-credentials', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    })
  }

  async clearAgentCredentials(): Promise<void> {
    await this.request('/api/agent-credentials', { method: 'DELETE' })
  }

  async grokCredentialsStatus(): Promise<{
    configured: boolean
    apiKey: boolean
    subscription: boolean
  }> {
    return this.request('/api/grok-credentials')
  }

  async grokCredentialsConfigured(): Promise<boolean> {
    return (await this.grokCredentialsStatus()).configured
  }

  async setGrokCredentials(input: string | { token?: string; authJson?: string }): Promise<void> {
    const body = typeof input === 'string' ? { token: input } : input
    await this.request('/api/grok-credentials', {
      method: 'PUT',
      body: JSON.stringify(body),
    })
  }

  async clearGrokCredentials(kind?: 'apiKey' | 'subscription'): Promise<void> {
    const query = kind ? `?kind=${kind}` : ''
    await this.request(`/api/grok-credentials${query}`, { method: 'DELETE' })
  }

  async grokLoginStatus(): Promise<GrokLoginSnapshot> {
    return this.request('/api/grok-login')
  }

  async startGrokLogin(): Promise<GrokLoginSnapshot> {
    return this.request('/api/grok-login', { method: 'POST' })
  }

  async cancelGrokLogin(): Promise<GrokLoginSnapshot> {
    return this.request('/api/grok-login', { method: 'DELETE' })
  }

  async listOpencodeCatalog(): Promise<ListOpencodeCatalogResponse['providers']> {
    const body = await this.request<ListOpencodeCatalogResponse>('/api/opencode/catalog')
    return body.providers
  }

  async listOpencodeProviders(): Promise<OpencodeProvider[]> {
    const body = await this.request<ListOpencodeProvidersResponse>('/api/opencode/providers')
    return body.providers
  }

  async upsertOpencodeProvider(provider: UpsertOpencodeProviderRequest): Promise<OpencodeProvider> {
    const body = await this.request<{ provider: OpencodeProvider }>('/api/opencode/providers', {
      method: 'PUT',
      body: JSON.stringify(provider),
    })
    return body.provider
  }

  async deleteOpencodeProvider(id: string): Promise<void> {
    await this.request(`/api/opencode/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}

/**
 * Exchange a pairing code for a device token.
 *
 * The one call made without a token, since it is what produces one.
 */
export async function redeemPairingCode(
  address: ServerAddress,
  code: string,
  device: { name: string; platform: 'macos' | 'windows' | 'linux' },
): Promise<PairRedeemResponse> {
  const response = await httpFetch(`${baseUrl(address)}/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: device.name, platform: device.platform }),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null
    throw new ApiFailure(
      response.status,
      body?.error ?? 'unknown',
      body?.message ?? 'could not pair with that code',
    )
  }

  return (await response.json()) as PairRedeemResponse
}

/**
 * Whether a server is reachable, and why not when it is not.
 *
 * The reason is carried rather than swallowed. "Cannot reach the server" sends
 * someone to check their network, which is wrong when the request was refused
 * by the webview or answered by something that is not Dukebox — and those look
 * identical from the outside.
 */
export type Reachability =
  { ok: true } | { ok: false; reason: 'timeout' | 'blocked' | 'http'; detail: string }

export async function reachable(address: ServerAddress): Promise<Reachability> {
  try {
    const response = await httpFetch(`${baseUrl(address)}/health`, {
      signal: AbortSignal.timeout(4000),
    })

    if (response.ok) return { ok: true }
    return { ok: false, reason: 'http', detail: `answered ${response.status}` }
  } catch (error) {
    // A timeout is a server that is not answering; anything else at this stage
    // is the request never leaving the app — most often the webview refusing a
    // plaintext HTTP connection.
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'

    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
