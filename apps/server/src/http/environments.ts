import { environments, type Database } from '@dukebox/db'
import {
  createEnvironmentRequest,
  reorderEnvironmentsRequest,
  updateEnvironmentRequest,
  validateBranchPattern,
  type EnvironmentSummary,
} from '@dukebox/protocol'
import { asc, eq, inArray, max } from 'drizzle-orm'
import { Hono } from 'hono'

/**
 * Environments: the ways a project can be run.
 *
 * Which one a session uses is decided from its base branch, so these routes
 * are about the list and its order — the resolution itself lives in the
 * session manager, where it happens once per session.
 */

export interface EnvironmentRoutesDeps {
  db: Database
}

function toSummary(row: typeof environments.$inferSelect): EnvironmentSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    branchPattern: row.branchPattern,
    position: row.position,
    hasConfig: row.configOverride !== null,
    hasSnapshot: row.snapshotImage !== null,
    hasDraft: row.environmentDraft !== null,
  }
}

export function environmentRoutes(deps: EnvironmentRoutesDeps) {
  const app = new Hono()

  app.get('/projects/:id/environments', async (c) => {
    const rows = await deps.db
      .select()
      .from(environments)
      .where(eq(environments.projectId, c.req.param('id')))
      .orderBy(asc(environments.position))

    return c.json({ environments: rows.map(toSummary) })
  })

  app.post('/projects/:id/environments', async (c) => {
    const projectId = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = createEnvironmentRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    // The schema bounds the length; this is the check that the pattern is
    // actually safe to evaluate. It runs here rather than only in the app,
    // because the app is not the gatekeeper for something the server runs.
    const valid = validateBranchPattern(parsed.data.branchPattern)
    if (!valid.ok) {
      return c.json({ error: 'invalid_request', message: valid.reason }, 400)
    }

    // New environments land at the end: appending never changes which
    // environment an existing branch already resolves to.
    const [current] = await deps.db
      .select({ highest: max(environments.position) })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    const position =
      current?.highest === null || current?.highest === undefined ? 0 : current.highest + 1

    const [created] = await deps.db
      .insert(environments)
      .values({
        projectId,
        name: parsed.data.name,
        branchPattern: parsed.data.branchPattern,
        position,
      })
      .returning()

    if (!created) {
      return c.json({ error: 'invalid_request', message: 'could not create environment' }, 400)
    }

    return c.json({ environment: toSummary(created) }, 201)
  })

  app.patch('/environments/:id', async (c) => {
    const id = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = updateEnvironmentRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    if (parsed.data.branchPattern !== undefined) {
      const valid = validateBranchPattern(parsed.data.branchPattern)
      if (!valid.ok) {
        return c.json({ error: 'invalid_request', message: valid.reason }, 400)
      }
    }

    const [updated] = await deps.db
      .update(environments)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.branchPattern !== undefined
          ? { branchPattern: parsed.data.branchPattern }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(environments.id, id))
      .returning()

    if (!updated) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    return c.json({ environment: toSummary(updated) })
  })

  app.delete('/environments/:id', async (c) => {
    // Sessions that ran here keep their history: the foreign key is
    // `on delete set null`, so they become base-image sessions rather than
    // disappearing.
    const deleted = await deps.db
      .delete(environments)
      .where(eq(environments.id, c.req.param('id')))
      .returning({ id: environments.id })

    if (deleted.length === 0) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    return c.json({ ok: true })
  })

  app.post('/projects/:id/environments/reorder', async (c) => {
    const projectId = c.req.param('id')

    const body = await c.req.json().catch(() => null)
    const parsed = reorderEnvironmentsRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    const { ids } = parsed.data

    const owned = await deps.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.projectId, projectId))

    const ownedIds = new Set(owned.map((row) => row.id))

    // Every id must belong to this project, and all of them must be present:
    // a partial list would leave the missing rows at stale positions and
    // produce an order nobody asked for. Duplicates are counted out too — a
    // list repeating one id would pass a length check while silently dropping
    // another environment's place in the order.
    const unique = new Set(ids)
    if (
      ids.length !== owned.length ||
      unique.size !== ids.length ||
      ids.some((id) => !ownedIds.has(id))
    ) {
      return c.json(
        { error: 'invalid_request', message: 'ids must be this project’s environments, in full' },
        400,
      )
    }

    await deps.db.transaction(async (tx) => {
      for (const [position, id] of ids.entries()) {
        await tx
          .update(environments)
          .set({ position, updatedAt: new Date() })
          .where(eq(environments.id, id))
      }
    })

    const rows = await deps.db
      .select()
      .from(environments)
      .where(inArray(environments.id, ids))
      .orderBy(asc(environments.position))

    return c.json({ environments: rows.map(toSummary) })
  })

  return app
}
