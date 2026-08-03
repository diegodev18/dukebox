import { projects, sessions, type Database } from '@dukebox/db'
import {
  createProjectRequest,
  type ProjectSummary,
  type RepositorySummary,
} from '@dukebox/protocol'
import { count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GitHubClient } from '../github/client.js'

/**
 * Projects: the repositories a user has connected.
 *
 * A project is a repository plus whatever Dukebox has learned about running it
 * — its default branch, and eventually its setup snapshot. Registering one is
 * separate from listing what is on GitHub, because most repositories a user
 * owns are not ones they want an agent working in.
 */

export interface ProjectRoutesDeps {
  db: Database
  github: GitHubClient
}

export function projectRoutes(deps: ProjectRoutesDeps) {
  const app = new Hono()

  /**
   * Repositories on GitHub, marked with whether they are already projects.
   *
   * The marking is what lets the app show one list rather than making the user
   * cross-reference two.
   */
  app.get('/repositories', async (c) => {
    const [repositories, registered] = await Promise.all([
      deps.github.listRepositories(),
      deps.db.select({ repoFullName: projects.repoFullName }).from(projects),
    ])

    const known = new Set(registered.map((row) => row.repoFullName.toLowerCase()))

    const summaries: RepositorySummary[] = repositories.map((repository) => ({
      fullName: repository.nameWithOwner,
      defaultBranch: repository.defaultBranchRef?.name ?? null,
      isPrivate: repository.isPrivate,
      updatedAt: repository.updatedAt,
      isRegistered: known.has(repository.nameWithOwner.toLowerCase()),
    }))

    return c.json({ repositories: summaries })
  })

  app.get('/projects', async (c) => {
    // One query with a join rather than a count per project: the list is small
    // now, but a query per row is the kind of thing that only becomes visible
    // once someone has fifty projects.
    const rows = await deps.db
      .select({
        id: projects.id,
        repoFullName: projects.repoFullName,
        defaultBranch: projects.defaultBranch,
        snapshotImage: projects.snapshotImage,
        createdAt: projects.createdAt,
        sessionCount: count(sessions.id),
      })
      .from(projects)
      .leftJoin(sessions, eq(sessions.projectId, projects.id))
      .groupBy(projects.id)
      .orderBy(desc(projects.createdAt))

    const summaries: ProjectSummary[] = rows.map((row) => ({
      id: row.id,
      repoFullName: row.repoFullName,
      defaultBranch: row.defaultBranch,
      hasSnapshot: row.snapshotImage !== null,
      createdAt: row.createdAt.getTime(),
      sessionCount: Number(row.sessionCount),
    }))

    return c.json({ projects: summaries })
  })

  app.post('/projects', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = createProjectRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    const { repoFullName } = parsed.data

    const [existing] = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.repoFullName, repoFullName))

    if (existing) {
      return c.json(
        { error: 'already_exists', message: `${repoFullName} is already a project` },
        409,
      )
    }

    // Asking GitHub confirms the repository exists and is reachable with the
    // user's token before a session ever tries to clone it, which turns a
    // typo into an error here rather than a failed session later.
    let defaultBranch = parsed.data.defaultBranch
    if (!defaultBranch) {
      try {
        defaultBranch = await deps.github.defaultBranch(repoFullName)
      } catch {
        return c.json(
          {
            error: 'not_found',
            message: `cannot reach ${repoFullName} on GitHub. Check the name and that your token can see it.`,
          },
          404,
        )
      }
    }

    const [project] = await deps.db
      .insert(projects)
      .values({ repoFullName, defaultBranch })
      .returning()

    return c.json(
      {
        id: project!.id,
        repoFullName: project!.repoFullName,
        defaultBranch: project!.defaultBranch,
        hasSnapshot: false,
        createdAt: project!.createdAt.getTime(),
        sessionCount: 0,
      },
      201,
    )
  })

  app.get('/projects/:id/branches', async (c) => {
    const [project] = await deps.db
      .select({ repoFullName: projects.repoFullName })
      .from(projects)
      .where(eq(projects.id, c.req.param('id')))

    if (!project) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    return c.json({ branches: await deps.github.listBranches(project.repoFullName) })
  })

  /**
   * Remove a project.
   *
   * Its sessions cascade with it. Nothing on GitHub is touched — the branches
   * and pull requests an agent produced are the user's work, and deleting a
   * project here is about Dukebox's own bookkeeping.
   */
  app.delete('/projects/:id', async (c) => {
    const deleted = await deps.db
      .delete(projects)
      .where(eq(projects.id, c.req.param('id')))
      .returning({ id: projects.id })

    if (deleted.length === 0) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    return c.json({ deleted: true })
  })

  return app
}
