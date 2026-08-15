import { applyRefreshedTokens, grokAuthNeedsRefresh } from '@dukebox/adapters'
import { describe, expect, it, vi } from 'vitest'
import { GrokAuthError, refreshGrokAuthIfNeeded } from '@/grok/refresh'

const ISSUER = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'

function authFile(entry: Record<string, unknown>): string {
  return JSON.stringify({
    [ISSUER]: {
      auth_mode: 'oidc',
      oidc_client_id: 'cli-id',
      key: 'old',
      refresh_token: 'ref-1',
      expires_at: '2026-08-15T10:04:00Z',
      ...entry,
    },
  })
}

describe('refreshGrokAuthIfNeeded', () => {
  it('returns the snapshot unchanged when the access token is still fresh', async () => {
    const raw = authFile({ expires_at: '2026-08-15T12:00:00Z' })
    const fetchImpl = vi.fn()

    const result = await refreshGrokAuthIfNeeded(raw, {
      fetch: fetchImpl as unknown as typeof fetch,
      now: new Date('2026-08-15T10:00:00Z'),
    })

    expect(result).toEqual({ authJson: raw, refreshed: false })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(grokAuthNeedsRefresh(raw, new Date('2026-08-15T10:00:00Z'))).toBe(false)
  })

  it('exchanges the refresh token and writes the new access token', async () => {
    const raw = authFile({})
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'fresh',
            refresh_token: 'ref-2',
            expires_in: 21600,
          }),
          { status: 200 },
        ),
    )

    const now = new Date('2026-08-15T10:00:00Z')
    const result = await refreshGrokAuthIfNeeded(raw, {
      fetch: fetchImpl as unknown as typeof fetch,
      now,
    })

    expect(result.refreshed).toBe(true)
    expect(result.authJson).toBe(
      applyRefreshedTokens(
        raw,
        { access_token: 'fresh', refresh_token: 'ref-2', expires_in: 21600 },
        now,
      ),
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(String(init.body)).toContain('grant_type=refresh_token')
    expect(String(init.body)).toContain('refresh_token=ref-1')
    expect(String(init.body)).toContain('client_id=cli-id')
  })

  it('throws GrokAuthError when the grant is rejected', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    )

    await expect(
      refreshGrokAuthIfNeeded(authFile({}), {
        fetch: fetchImpl as unknown as typeof fetch,
        now: new Date('2026-08-15T10:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(GrokAuthError)
  })

  it('throws when a refresh is due but no refresh token is stored', async () => {
    const raw = authFile({ refresh_token: undefined, expires_at: '2026-08-15T10:00:00Z' })
    delete JSON.parse(raw)[ISSUER].refresh_token
    const stripped = JSON.stringify({
      [ISSUER]: {
        auth_mode: 'oidc',
        oidc_client_id: 'cli-id',
        key: 'old',
        expires_at: '2026-08-15T10:00:00Z',
      },
    })

    await expect(
      refreshGrokAuthIfNeeded(stripped, { now: new Date('2026-08-15T10:00:00Z') }),
    ).rejects.toBeInstanceOf(GrokAuthError)
  })
})
