import { OPENCODE_CATALOG, upsertOpencodeProviderRequest } from '@dukebox/protocol'
import { Hono } from 'hono'
import type { SecretStore } from '../secrets/store.js'
import {
  loadOpencodeProviders,
  publicProvider,
  resolveStoredProvider,
  saveOpencodeProviders,
} from '../opencode/providers.js'

/**
 * OpenCode provider credentials.
 *
 * Server-wide rather than per project: the same keys run every OpenCode
 * session, whatever repository it is working in. Values go in and never come
 * back out.
 */

export interface OpencodeRoutesDeps {
  secrets: SecretStore
}

export function opencodeRoutes(deps: OpencodeRoutesDeps) {
  const app = new Hono()

  app.get('/opencode/catalog', (c) => {
    return c.json({
      providers: OPENCODE_CATALOG.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        models: [...entry.models],
      })),
    })
  })

  app.get('/opencode/providers', async (c) => {
    const providers = await loadOpencodeProviders(deps.secrets)
    return c.json({ providers: providers.map(publicProvider) })
  })

  app.put('/opencode/providers', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = upsertOpencodeProviderRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    const next = resolveStoredProvider(parsed.data)
    const providers = await loadOpencodeProviders(deps.secrets)
    const index = providers.findIndex((provider) => provider.id === next.id)

    if (index === -1) {
      providers.push(next)
    } else {
      providers[index] = next
    }

    await saveOpencodeProviders(deps.secrets, providers)
    return c.json({ provider: publicProvider(next) })
  })

  app.delete('/opencode/providers/:id', async (c) => {
    const id = c.req.param('id')
    const providers = await loadOpencodeProviders(deps.secrets)
    const remaining = providers.filter((provider) => provider.id !== id)

    if (remaining.length === providers.length) {
      return c.json({ error: 'not_found', message: 'no such provider' }, 404)
    }

    await saveOpencodeProviders(deps.secrets, remaining)
    return c.json({ deleted: true })
  })

  return app
}
