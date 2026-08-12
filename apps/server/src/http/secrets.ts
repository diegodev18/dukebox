import { projects, type Database } from '@dukebox/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { AGENT_CREDENTIAL_SECRET, type SecretStore } from '../secrets/store.js'
import { requireOwner, type AuthedVariables } from './auth.js'

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

async function projectExists(db: Database, projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))

  return project !== undefined
}
