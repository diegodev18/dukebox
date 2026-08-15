import { describe, expect, it, vi } from 'vitest'
import { GROK_AUTH_SECRET, type SecretStore } from '@/secrets/store'
import { grokAuthHooks } from '@/grok/session-auth'

function secrets(initial: string | null = null) {
  let value = initial
  return {
    get: vi.fn(async (name: string) => (name === GROK_AUTH_SECRET ? value : null)),
    set: vi.fn(async (name: string, next: string) => {
      if (name === GROK_AUTH_SECRET) value = next
    }),
    has: vi.fn(),
    delete: vi.fn(),
    names: vi.fn(),
    environmentFor: vi.fn(),
  } as unknown as SecretStore & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }
}

const STORE =
  '{"https://auth.x.ai::cli":{"key":"old","refresh_token":"keep","expires_at":"2026-08-15T10:00:00Z"}}'
const FRESH =
  '{"https://auth.x.ai::cli":{"key":"fresh","refresh_token":"keep","expires_at":"2026-08-15T16:00:00Z"}}'

describe('grokAuthHooks', () => {
  it('returns null when no session is stored', async () => {
    const hooks = grokAuthHooks(secrets(null), {
      refresh: async (raw) => ({ authJson: raw, refreshed: false }),
    })
    expect(await hooks.load()).toBeNull()
  })

  it('refreshes a near-expiry session and persists the new snapshot', async () => {
    const store = secrets(STORE)
    const refresh = vi.fn(async () => ({ authJson: FRESH, refreshed: true }))
    const hooks = grokAuthHooks(store, { refresh })

    expect(await hooks.load()).toBe(FRESH)
    expect(refresh).toHaveBeenCalledWith(STORE)
    expect(store.set).toHaveBeenCalledWith(GROK_AUTH_SECRET, FRESH)
  })

  it('serializes overlapping loads across sessions so refreshes do not overlap', async () => {
    const store = secrets(STORE)
    let inflight = 0
    let peak = 0
    const refresh = vi.fn(async () => {
      inflight += 1
      peak = Math.max(peak, inflight)
      await Promise.resolve()
      inflight -= 1
      return { authJson: FRESH, refreshed: true }
    })
    const firstHooks = grokAuthHooks(store, { refresh })
    const secondHooks = grokAuthHooks(store, { refresh })

    const [first, second] = await Promise.all([firstHooks.load(), secondHooks.load()])

    expect(first).toBe(FRESH)
    expect(second).toBe(FRESH)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
  })

  it('merges a harvested container snapshot without dropping the refresh token', async () => {
    const store = secrets(STORE)
    const hooks = grokAuthHooks(store, {
      refresh: async (raw) => ({ authJson: raw, refreshed: false }),
    })

    await hooks.persist(
      '{"https://auth.x.ai::cli":{"key":"new","expires_at":"2026-08-15T16:00:00Z"}}',
    )

    expect(store.set).toHaveBeenCalledWith(GROK_AUTH_SECRET, expect.stringContaining('"key":"new"'))
    expect(store.set.mock.calls[0]?.[1]).toContain('"refresh_token":"keep"')
  })
})
