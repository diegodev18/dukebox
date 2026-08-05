import { projects, sessions, type Database } from '@dukebox/db'
import {
  createProjectRequest,
  defaultProjectConfig,
  environmentProposal,
  mergeProjectConfig,
  projectConfig,
  putProjectEnvironmentRequest,
  type ProjectConfig,
  type ProjectSummary,
  type RepositorySummary,
} from '@dukebox/protocol'
import { count, desc, eq, and, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import type { GitHubClient } from '../github/client.js'
import type { SecretStore } from '../secrets/store.js'

/**
 * Projects: the repositories a user has connected.
 *
 * A project is a repository plus whatever Dukebox has learned about running it
 * — its default branch, its environment config, and eventually its setup
 * snapshot. Registering one is separate from listing what is on GitHub,
 * because most repositories a user owns are not ones they want an agent
 * working in.
 */

export interface ProjectRoutesDeps {
  db: Database
  github: GitHubClient
  /** Needed for environment routes that list/store project secrets. */
  secrets?: SecretStore
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
        configOverride: projects.configOverride,
        createdAt: projects.createdAt,
        sessionCount: count(sessions.id),
      })
      .from(projects)
      .leftJoin(sessions, and(eq(sessions.projectId, projects.id), isNull(sessions.archivedAt)))
      .groupBy(projects.id)
      .orderBy(desc(projects.createdAt))

    const summaries: ProjectSummary[] = rows.map((row) => ({
      id: row.id,
      repoFullName: row.repoFullName,
      defaultBranch: row.defaultBranch,
      hasSnapshot: row.snapshotImage !== null,
      hasEnvironment: row.configOverride !== null,
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
        hasEnvironment: false,
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
   * The project's environment: saved config, pending draft, and secret names.
   */
  app.get('/projects/:id/environment', async (c) => {
    const [project] = await deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param('id')))

    if (!project) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    const draft = project.environmentDraft
      ? environmentProposal.safeParse(project.environmentDraft)
      : null

    const override = project.configOverride
      ? projectConfig.partial().safeParse(project.configOverride)
      : null

    const effective = override?.success
      ? mergeProjectConfig(defaultProjectConfig(), override.data as Partial<ProjectConfig>)
      : null

    const secretNames = deps.secrets ? await deps.secrets.names(project.id) : []

    return c.json({
      config: effective
        ? {
            image: effective.image,
            setup: effective.setup,
            env: effective.env,
            instructions: effective.instructions,
          }
        : null,
      draft: draft?.success ? draft.data : null,
      secretNames,
    })
  })

  /**
   * Save the project's environment after the user reviews a proposal.
   *
   * Writes `configOverride`, upserts secrets, and clears any pending draft.
   */
  app.put('/projects/:id/environment', async (c) => {
    const projectId = c.req.param('id')
    const [project] = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))

    if (!project) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    const parsed = putProjectEnvironmentRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    const { setup, secretEnv, literalEnv, secrets, instructions, image } = parsed.data

    if (deps.secrets) {
      for (const [name, value] of Object.entries(secrets)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
          return c.json({ error: 'invalid_request', message: `invalid secret name: ${name}` }, 400)
        }
        await deps.secrets.set(name, value, projectId)
      }
    } else if (Object.keys(secrets).length > 0) {
      return c.json(
        { error: 'unavailable', message: 'secrets are not configured on this server' },
        503,
      )
    }

    const env: Record<string, string> = { ...literalEnv }
    for (const name of secretEnv) {
      env[name] = `\${secret.${name}}`
    }

    const override: Partial<ProjectConfig> = {
      setup,
      env,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(image !== undefined ? { image } : {}),
    }

    // Validate the merged result so a bad override cannot poison later sessions.
    const merged = mergeProjectConfig(defaultProjectConfig(), override)
    projectConfig.parse(merged)

    await deps.db
      .update(projects)
      .set({
        configOverride: override,
        environmentDraft: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))

    const secretNames = deps.secrets ? await deps.secrets.names(projectId) : []

    return c.json({
      config: {
        image: merged.image,
        setup: merged.setup,
        env: merged.env,
        instructions: merged.instructions,
      },
      draft: null,
      secretNames,
    })
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
