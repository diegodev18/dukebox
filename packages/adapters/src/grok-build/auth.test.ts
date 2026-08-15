import { describe, expect, it } from 'vitest'
import {
  applyRefreshedTokens,
  grokAuthClientId,
  grokAuthExpiresAt,
  grokAuthNeedsRefresh,
  grokAuthRefreshToken,
  isGrokUnsignedError,
  mergeGrokAuthJson,
  parseGrokAuthJson,
  preferFresherGrokAuth,
} from '@/grok-build/auth'

const ISSUER = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'

function authFile(entry: Record<string, unknown>): string {
  return JSON.stringify({ [ISSUER]: { auth_mode: 'oidc', oidc_client_id: 'cli', ...entry } })
}

describe('isGrokUnsignedError', () => {
  it('matches the headless CLI message', () => {
    expect(
      isGrokUnsignedError(
        'Not signed in. To authenticate without a browser, run:\n  grok login --device-code',
      ),
    ).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isGrokUnsignedError('rate limited')).toBe(false)
  })
})

describe('parseGrokAuthJson', () => {
  it('rejects non-objects', () => {
    expect(parseGrokAuthJson('[]')).toBeNull()
    expect(parseGrokAuthJson('"nope"')).toBeNull()
    expect(parseGrokAuthJson('not json')).toBeNull()
  })

  it('returns the issuer-keyed map', () => {
    const raw = authFile({ key: 'tok', refresh_token: 'ref', expires_at: '2026-08-15T10:00:00Z' })
    const parsed = parseGrokAuthJson(raw)
    expect(parsed?.[ISSUER]?.key).toBe('tok')
    expect(parsed?.[ISSUER]?.refresh_token).toBe('ref')
  })
})

describe('grokAuthExpiresAt / needsRefresh', () => {
  it('reads expires_at from the session entry', () => {
    const raw = authFile({ expires_at: '2026-08-15T10:48:31.695647Z' })
    expect(grokAuthExpiresAt(parseGrokAuthJson(raw)!)?.toISOString()).toBe(
      '2026-08-15T10:48:31.695Z',
    )
  })

  it('is fresh when expiry is more than the early window away', () => {
    const raw = authFile({ expires_at: '2026-08-15T12:00:00Z' })
    expect(grokAuthNeedsRefresh(raw, new Date('2026-08-15T10:00:00Z'))).toBe(false)
  })

  it('needs refresh inside the early window', () => {
    const raw = authFile({ expires_at: '2026-08-15T10:04:00Z' })
    expect(grokAuthNeedsRefresh(raw, new Date('2026-08-15T10:00:00Z'))).toBe(true)
  })

  it('needs refresh when already expired', () => {
    const raw = authFile({ expires_at: '2026-08-15T09:00:00Z' })
    expect(grokAuthNeedsRefresh(raw, new Date('2026-08-15T10:00:00Z'))).toBe(true)
  })

  it('does not refresh a file with no expiry', () => {
    expect(grokAuthNeedsRefresh(authFile({ key: 'tok' }), new Date('2026-08-15T10:00:00Z'))).toBe(
      false,
    )
  })
})

describe('mergeGrokAuthJson', () => {
  it('keeps the later access token and never drops a refresh token', () => {
    const store = authFile({
      key: 'old',
      refresh_token: 'keep-me',
      expires_at: '2026-08-15T10:00:00Z',
    })
    const disk = authFile({
      key: 'new',
      expires_at: '2026-08-15T16:00:00Z',
    })

    const merged = mergeGrokAuthJson(store, disk)
    const entry = parseGrokAuthJson(merged!)![ISSUER]
    expect(entry.key).toBe('new')
    expect(entry.refresh_token).toBe('keep-me')
    expect(entry.expires_at).toBe('2026-08-15T16:00:00Z')
  })

  it('prefers the only non-null side', () => {
    const only = authFile({ key: 'solo', refresh_token: 'r' })
    expect(mergeGrokAuthJson(only, null)).toBe(only)
    expect(mergeGrokAuthJson(null, only)).toBe(only)
    expect(mergeGrokAuthJson(null, null)).toBeNull()
  })
})

describe('preferFresherGrokAuth', () => {
  it('picks the later expiry', () => {
    const older = authFile({ key: 'a', expires_at: '2026-08-15T10:00:00Z' })
    const newer = authFile({ key: 'b', expires_at: '2026-08-15T12:00:00Z' })
    expect(preferFresherGrokAuth(older, newer)).toBe(newer)
  })
})

describe('applyRefreshedTokens', () => {
  it('writes the new access token, refresh token, and expiry', () => {
    const raw = authFile({
      key: 'old',
      refresh_token: 'old-ref',
      expires_at: '2026-08-15T10:00:00Z',
      create_time: '2026-08-15T04:00:00Z',
    })

    const next = applyRefreshedTokens(
      raw,
      { access_token: 'fresh', refresh_token: 'new-ref', expires_in: 21600 },
      new Date('2026-08-15T11:00:00Z'),
    )
    const entry = parseGrokAuthJson(next)![ISSUER]
    expect(entry.key).toBe('fresh')
    expect(entry.refresh_token).toBe('new-ref')
    expect(entry.expires_at).toBe('2026-08-15T17:00:00.000Z')
    expect(entry.create_time).toBe('2026-08-15T11:00:00.000Z')
  })

  it('keeps the previous refresh token when the server omits a new one', () => {
    const raw = authFile({
      key: 'old',
      refresh_token: 'old-ref',
      expires_at: '2026-08-15T10:00:00Z',
    })
    const next = applyRefreshedTokens(
      raw,
      { access_token: 'fresh', expires_in: 60 },
      new Date('2026-08-15T11:00:00Z'),
    )
    expect(parseGrokAuthJson(next)![ISSUER].refresh_token).toBe('old-ref')
  })
})

describe('client id and refresh token', () => {
  it('reads them from the session entry', () => {
    const raw = authFile({
      oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      refresh_token: 'ref-1',
    })
    expect(grokAuthClientId(raw)).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(grokAuthRefreshToken(raw)).toBe('ref-1')
  })
})
