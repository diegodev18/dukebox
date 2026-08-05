import type {
  ApiError,
  EnvironmentProposal,
  PairRedeemResponse,
  ProjectEnvironmentResponse,
  ProjectSummary,
  PutProjectEnvironmentRequest,
  RepositorySummary,
  SessionSummary,
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
  async whoami(): Promise<{ deviceId: string; deviceName: string }> {
    return this.request('/api/me')
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
    purpose?: 'coding' | 'environment_setup'
  }): Promise<SessionSummary> {
    return this.request('/api/sessions', { method: 'POST', body: JSON.stringify(options) })
  }

  async getEnvironment(projectId: string): Promise<ProjectEnvironmentResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/environment`)
  }

  async putEnvironment(
    projectId: string,
    body: PutProjectEnvironmentRequest,
  ): Promise<ProjectEnvironmentResponse> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/environment`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
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

  async openPullRequest(sessionId: string, title?: string): Promise<{ url: string }> {
    return this.request(`/api/sessions/${sessionId}/pr`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    })
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
