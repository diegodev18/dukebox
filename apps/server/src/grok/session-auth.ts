import { mergeGrokAuthJson, type SessionContext } from '@dukebox/adapters'
import { GROK_AUTH_SECRET, type SecretStore } from '@/secrets/store'
import { refreshGrokAuthIfNeeded } from '@/grok/refresh'

export type GrokAuthSync = NonNullable<SessionContext['grokAuth']>

/**
 * Control-plane owner of the Grok Build OIDC session.
 *
 * `load` refreshes a near-expiry access token once, under a process lock, so
 * two sessions cannot rotate the same refresh token. `persist` merges whatever
 * a container wrote back without dropping the stored refresh token.
 */
// One lock for the process: every session shares the same refresh grant.
const lock = createLock()

export function grokAuthHooks(
  store: SecretStore,
  options: { refresh?: typeof refreshGrokAuthIfNeeded } = {},
): GrokAuthSync {
  const refresh = options.refresh ?? refreshGrokAuthIfNeeded

  return {
    async load() {
      return lock(async () => {
        const current = await store.get(GROK_AUTH_SECRET)
        if (!current) return null
        const { authJson, refreshed } = await refresh(current)
        if (refreshed) await store.set(GROK_AUTH_SECRET, authJson)
        return authJson
      })
    },

    async persist(authJson: string) {
      await lock(async () => {
        const current = await store.get(GROK_AUTH_SECRET)
        const merged = mergeGrokAuthJson(current, authJson)
        if (merged && merged !== current) await store.set(GROK_AUTH_SECRET, merged)
      })
    },
  }
}

function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
