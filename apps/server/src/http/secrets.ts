import { projects, type Database } from '@dukebox/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  AGENT_CREDENTIAL_SECRET,
  GROK_AUTH_SECRET,
  GROK_CREDENTIAL_SECRET,
  type SecretStore,
} from '@/secrets/store'
import { requireOwner, type AuthedVariables } from '@/http/auth'

/**
 * Secrets: values a session needs but that must not live in a repository.
 *
 * Values go in and never come back out. Every route here returns names only,
 * so an app can show what is configured without becoming another place the
 * value exists.
 */

export interface SecretRoutesDeps {
  db: Database
  secrets: SecretStore
}

const setSecretRequest = z.object({
  /**
   * Environment variable name.
   *
   * Constrained to what a shell can actually export: anything else would be
   * accepted here and then silently dropped when the container starts.
   */
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'expected an uppercase environment variable name'),
  value: z.string().min(1),
})

const setAgentCredentialRequest = z.object({
  /** The token from `claude setup-token`. */
  token: z.string().min(1),
})

const setGrokCredentialRequest = z
  .object({
    /** API key from console.x.ai (`XAI_API_KEY`). */
    token: z.string().min(1).optional(),
    /**
     * Contents of `~/.grok/auth.json` after `grok login`.
     *
     * That file is the SuperGrok / X Premium Plus session. It is not an API
     * key: Grok prefers it over `XAI_API_KEY` when both are present.
     */
    authJson: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.token || value.authJson), {
    message: 'expected a token or authJson',
  })

function parseGrokAuthJson(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return raw
  } catch {
    // Invalid JSON is rejected by the route, not stored.
  }
  return undefined
}

export function secretRoutes(deps: SecretRoutesDeps) {
  const app = new Hono<{ Variables: AuthedVariables }>()

  /**
   * The agent's credentials.
   *
   * Server-wide rather than per project: one subscription runs every session,
   * whatever repository it is working in.
   */
  app.put('/agent-credentials', requireOwner, async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = setAgentCredentialRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    await deps.secrets.set(AGENT_CREDENTIAL_SECRET, parsed.data.token)
    return c.json({ configured: true })
  })

  /** Whether agent credentials are set, without revealing them. */
  app.get('/agent-credentials', async (c) => {
    return c.json({ configured: await deps.secrets.has(AGENT_CREDENTIAL_SECRET) })
  })

  app.delete('/agent-credentials', requireOwner, async (c) => {
    const deleted = await deps.secrets.delete(AGENT_CREDENTIAL_SECRET)

    if (!deleted) {
      return c.json({ error: 'not_found', message: 'no agent credentials are set' }, 404)
    }

    return c.json({ deleted: true })
  })

  /**
   * Grok Build credentials: an API key, a subscription `auth.json`, or both.
   *
   * Server-wide, separate from Claude's token and from OpenCode's xAI
   * provider: only Grok Build sessions receive them.
   */
  app.put('/grok-credentials', requireOwner, async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = setGrokCredentialRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    if (parsed.data.authJson) {
      const authJson = parseGrokAuthJson(parsed.data.authJson)
      if (!authJson) {
        return c.json({ error: 'invalid_request', message: 'authJson must be a JSON object' }, 400)
      }
      await deps.secrets.set(GROK_AUTH_SECRET, authJson)
    }

    if (parsed.data.token) {
      await deps.secrets.set(GROK_CREDENTIAL_SECRET, parsed.data.token)
    }

    return c.json(await grokCredentialStatus(deps.secrets))
  })

  app.get('/grok-credentials', async (c) => {
    return c.json(await grokCredentialStatus(deps.secrets))
  })

  app.delete('/grok-credentials', requireOwner, async (c) => {
    const kind = c.req.query('kind')
    if (kind === 'subscription') {
      const deleted = await deps.secrets.delete(GROK_AUTH_SECRET)
      if (!deleted) {
        return c.json({ error: 'not_found', message: 'no Grok Build session is set' }, 404)
      }
      return c.json({ deleted: true })
    }

    if (kind === 'apiKey') {
      const deleted = await deps.secrets.delete(GROK_CREDENTIAL_SECRET)
      if (!deleted) {
        return c.json({ error: 'not_found', message: 'no Grok Build API key is set' }, 404)
      }
      return c.json({ deleted: true })
    }

    const deletedKey = await deps.secrets.delete(GROK_CREDENTIAL_SECRET)
    const deletedAuth = await deps.secrets.delete(GROK_AUTH_SECRET)

    if (!deletedKey && !deletedAuth) {
      return c.json({ error: 'not_found', message: 'no Grok Build credentials are set' }, 404)
    }

    return c.json({ deleted: true })
  })

  app.get('/projects/:id/secrets', async (c) => {
    const projectId = c.req.param('id')
    if (!projectId) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    if (!(await projectExists(deps.db, projectId))) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    // Names only. A route that returned values would make every client that
    // called it another place the secret lives.
    return c.json({ names: await deps.secrets.names(projectId) })
  })

  app.put('/projects/:id/secrets', async (c) => {
    const projectId = c.req.param('id')
    if (!projectId) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    if (!(await projectExists(deps.db, projectId))) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = setSecretRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    await deps.secrets.set(parsed.data.name, parsed.data.value, projectId)
    return c.json({ name: parsed.data.name, configured: true })
  })

  app.delete('/projects/:id/secrets/:name', async (c) => {
    const name = c.req.param('name')
    const projectId = c.req.param('id')
    if (!name || !projectId) {
      return c.json({ error: 'not_found', message: 'no such secret' }, 404)
    }
    const deleted = await deps.secrets.delete(name, projectId)

    if (!deleted) {
      return c.json({ error: 'not_found', message: 'no such secret' }, 404)
    }

    return c.json({ deleted: true })
  })

  return app
}

async function grokCredentialStatus(store: SecretStore): Promise<{
  configured: boolean
  apiKey: boolean
  subscription: boolean
}> {
  const apiKey = await store.has(GROK_CREDENTIAL_SECRET)
  const subscription = await store.has(GROK_AUTH_SECRET)
  return { configured: apiKey || subscription, apiKey, subscription }
}

async function projectExists(db: Database, projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))

  return project !== undefined
}
