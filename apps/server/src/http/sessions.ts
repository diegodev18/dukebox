import { projects, sessions, type Database } from '@dukebox/db'
import {
  createSessionRequest,
  environmentProposal,
  openPullRequestRequest,
} from '@dukebox/protocol'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { EventBus } from '../events/bus.js'
import { SessionError, type SessionManager } from '../sessions/manager.js'
import { toSummary } from '../sessions/summarize.js'

/**
 * Sessions: an agent working in a container on one repository.
 *
 * Creating one starts real work, so these routes stay thin — they validate,
 * delegate to the session manager, and translate its failures into status
 * codes. Everything a session produces afterwards arrives over the WebSocket.
 */

export interface SessionRoutesDeps {
  db: Database
  bus: EventBus
  sessions: SessionManager
}

export function sessionRoutes(deps: SessionRoutesDeps) {
  const app = new Hono()

  app.get('/sessions', async (c) => {
    const projectId = c.req.query('projectId')

    // Archived sessions stay in the database for history, but the sidebar only
    // wants the ones a person can still open.
    const active = isNull(sessions.archivedAt)

    const rows = await (projectId
      ? deps.db
          .select()
          .from(sessions)
          .where(and(eq(sessions.projectId, projectId), active))
          .orderBy(desc(sessions.createdAt))
      : deps.db.select().from(sessions).where(active).orderBy(desc(sessions.createdAt)))

    return c.json({ sessions: rows.map(toSummary) })
  })

  app.get('/sessions/:id', async (c) => {
    const [session] = await deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, c.req.param('id')))

    if (!session) {
      return c.json({ error: 'not_found', message: 'no such session' }, 404)
    }

    return c.json(toSummary(session))
  })

  /**
   * Start a session.
   *
   * Returns 202 rather than 201: the session exists, but its container is
   * still being built. The client subscribes with the id it gets back and
   * watches provisioning happen.
   */
  app.post('/sessions', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = createSessionRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    try {
      const { baseBranch, prompt, purpose, ...rest } = parsed.data

      const session = await deps.sessions.start({
        ...rest,
        purpose,
        ...(prompt ? { prompt } : {}),
        // Spread rather than passed through: an optional property set to
        // undefined is not the same as an absent one, and the manager treats
        // an absent base branch as "use the project's default".
        ...(baseBranch ? { baseBranch } : {}),
      })

      return c.json(toSummary(session), 202)
    } catch (error) {
      if (error instanceof SessionError) {
        return c.json({ error: 'invalid_request', message: error.message }, 400)
      }
      throw error
    }
  })

  /**
   * The environment proposal produced by an environment_setup session.
   *
   * Prefer the project's draft (written when the session finished). Falls back
   * to null when the agent has not produced a valid proposal yet.
   */
  app.get('/sessions/:id/environment-proposal', async (c) => {
    const sessionId = c.req.param('id')

    const [session] = await deps.db
      .select({ projectId: sessions.projectId, purpose: sessions.purpose })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) {
      return c.json({ error: 'not_found', message: 'no such session' }, 404)
    }

    if (session.purpose !== 'environment_setup') {
      return c.json(
        { error: 'invalid_request', message: 'session is not an environment setup session' },
        400,
      )
    }

    const [project] = await deps.db
      .select({ environmentDraft: projects.environmentDraft })
      .from(projects)
      .where(eq(projects.id, session.projectId))

    const parsed = project?.environmentDraft
      ? environmentProposal.safeParse(project.environmentDraft)
      : null

    return c.json({ proposal: parsed?.success ? parsed.data : null })
  })

  /**
   * A session's events.
   *
   * The WebSocket is how a client follows a live session; this is for loading
   * history on demand — opening a finished session, or filling a gap the local
   * cache cannot cover.
   */
  app.get('/sessions/:id/events', async (c) => {
    const sessionId = c.req.param('id')

    const [session] = await deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) {
      return c.json({ error: 'not_found', message: 'no such session' }, 404)
    }

    const after = Number(c.req.query('after') ?? 0)
    const events = await deps.bus.replay(sessionId, Number.isFinite(after) ? after : 0)

    return c.json({ events })
  })

  app.post('/sessions/:id/pr', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const parsed = openPullRequestRequest.safeParse(body ?? {})

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    try {
      const url = await deps.sessions.openPullRequest(c.req.param('id'), parsed.data.title)
      return c.json({ url })
    } catch (error) {
      if (error instanceof SessionError) {
        // 409: the request was understood, but the session is not in a state
        // where a pull request means anything.
        return c.json({ error: 'conflict', message: error.message }, 409)
      }
      throw error
    }
  })

  /**
   * Stop a session.
   *
   * The container is stopped, not removed, so a follow-up prompt resumes in
   * place rather than re-cloning and reinstalling.
   */
  app.delete('/sessions/:id', async (c) => {
    const sessionId = c.req.param('id')

    const [session] = await deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    if (!session) {
      return c.json({ error: 'not_found', message: 'no such session' }, 404)
    }

    await deps.sessions.stop(sessionId)
    return c.json({ stopped: true })
  })

  /**
   * Archive a session.
   *
   * Hides it from the sidebar. The row and its events stay put — this is not
   * a delete.
   */
  app.post('/sessions/:id/archive', async (c) => {
    const sessionId = c.req.param('id')

    try {
      await deps.sessions.archive(sessionId)
      return c.json({ archived: true })
    } catch (error) {
      if (error instanceof SessionError) {
        return c.json({ error: 'not_found', message: error.message }, 404)
      }
      throw error
    }
  })

  return app
}
