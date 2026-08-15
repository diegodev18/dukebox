import {
  applyRefreshedTokens,
  grokAuthClientId,
  grokAuthNeedsRefresh,
  grokAuthRefreshToken,
  GROK_REAUTH_MESSAGE,
} from '@dukebox/adapters'

export const GROK_OIDC_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
export const GROK_CLI_OIDC_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

export class GrokAuthError extends Error {
  constructor(message = GROK_REAUTH_MESSAGE) {
    super(message)
    this.name = 'GrokAuthError'
  }
}

export interface RefreshGrokAuthOptions {
  fetch?: typeof fetch
  now?: Date
  earlyMs?: number
  tokenUrl?: string
}

export interface RefreshGrokAuthResult {
  authJson: string
  refreshed: boolean
}

/**
 * Refresh a stored Grok OIDC session when the access token is near expiry.
 *
 * One refresh on the control plane, under the caller's lock, so session
 * containers are never the ones rotating the refresh token. A revoked or
 * expired grant becomes `GrokAuthError` rather than a "Not signed in" reply
 * from `grok -p`.
 */
export async function refreshGrokAuthIfNeeded(
  raw: string,
  options: RefreshGrokAuthOptions = {},
): Promise<RefreshGrokAuthResult> {
  const now = options.now ?? new Date()
  if (!grokAuthNeedsRefresh(raw, now, options.earlyMs)) {
    return { authJson: raw, refreshed: false }
  }

  const refreshToken = grokAuthRefreshToken(raw)
  const clientId = grokAuthClientId(raw) ?? GROK_CLI_OIDC_CLIENT_ID
  if (!refreshToken) throw new GrokAuthError()

  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(options.tokenUrl ?? GROK_OIDC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  })

  const body = await readJson(response)
  if (!response.ok) throw new GrokAuthError()

  const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : NaN
  if (!accessToken || !Number.isFinite(expiresIn)) throw new GrokAuthError()

  return {
    authJson: applyRefreshedTokens(
      raw,
      {
        access_token: accessToken,
        ...(typeof body.refresh_token === 'string' ? { refresh_token: body.refresh_token } : {}),
        expires_in: expiresIn,
      },
      now,
    ),
    refreshed: true,
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json()
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
