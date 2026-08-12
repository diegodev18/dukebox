import { environments, projects, sessions, type Database } from '@dukebox/db'
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
import { requireOwner, routeParam, type AuthedVariables } from './auth.js'
import type { SecretStore } from '../secrets/store.js'

/**
 * Projects: the repositories a user has connected.
 *
 * A project is a repository plus whatever Dukebox has learned about running it
 * — its default branch, its secrets, and the environments it can run in.
 * Registering one is separate from listing what is on GitHub, because most
 * repositories a user owns are not ones they want an agent working in.
 */

export interface ProjectRoutesDeps {
  db: Database
  github: GitHubClient
  /** Needed for environment routes that list/store project secrets. */
  secrets?: SecretStore
}

export function projectRoutes(deps: ProjectRoutesDeps) {
  const app = new Hono<{ Variables: AuthedVariables }>()

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
        createdAt: projects.createdAt,
        sessionCount: count(sessions.id),
      })
      .from(projects)
      .leftJoin(sessions, and(eq(sessions.projectId, projects.id), isNull(sessions.archivedAt)))
      .groupBy(projects.id)
      .orderBy(desc(projects.createdAt))

    // A separate grouped query rather than a second join: joining both would
    // multiply the rows and inflate every count.
    const environmentCounts = await deps.db
      .select({ projectId: environments.projectId, total: count(environments.id) })
      .from(environments)
      .groupBy(environments.projectId)

    const countByProject = new Map(
      environmentCounts.map((row) => [row.projectId, Number(row.total)]),
    )

    const summaries: ProjectSummary[] = rows.map((row) => ({
      id: row.id,
      repoFullName: row.repoFullName,
      defaultBranch: row.defaultBranch,
      environmentCount: countByProject.get(row.id) ?? 0,
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
        environmentCount: 0,
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
      .where(eq(projects.id, routeParam(c, 'id')))

    if (!project) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    return c.json({ branches: await deps.github.listBranches(project.repoFullName) })
  })

  /**
   * The environment's saved config, pending draft, and the project's secrets.
   *
   * Which environment is named by `?environmentId`; secrets stay project
   * scoped, because the same database URL serves every way of running a repo.
   */
  app.get('/projects/:id/environment', async (c) => {
    const projectId = routeParam(c, 'id')
    const environmentId = c.req.query('environmentId')

    if (!environmentId) {
      return c.json({ error: 'invalid_request', message: 'environmentId is required' }, 400)
    }

    const [environment] = await deps.db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))

    if (!environment) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    // 403 rather than 404: the row exists, and the caller is being refused
    // it. This matches how session creation rejects a foreign environment.
    if (environment.projectId !== projectId) {
      return c.json(
        { error: 'forbidden', message: 'environment does not belong to this project' },
        403,
      )
    }

    const draft = environment.environmentDraft
      ? environmentProposal.safeParse(environment.environmentDraft)
      : null

    const override = environment.configOverride
      ? projectConfig.partial().safeParse(environment.configOverride)
      : null

    const effective = override?.success
      ? mergeProjectConfig(defaultProjectConfig(), override.data as Partial<ProjectConfig>)
      : null

    const secretNames = deps.secrets ? await deps.secrets.names(projectId) : []

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
   * Save an environment after the user reviews a proposal.
   *
   * Writes `configOverride` on the environment named by `?environmentId` and
   * clears its pending draft. Secrets are upserted on the project, not the
   * environment: the credentials a repository needs do not change with the
   * branch being worked on.
   */
  app.put('/projects/:id/environment', async (c) => {
    const projectId = routeParam(c, 'id')
    const environmentId = c.req.query('environmentId')

    if (!environmentId) {
      return c.json({ error: 'invalid_request', message: 'environmentId is required' }, 400)
    }

    const [environment] = await deps.db
      .select({ id: environments.id, projectId: environments.projectId })
      .from(environments)
      .where(eq(environments.id, environmentId))

    if (!environment) {
      return c.json({ error: 'not_found', message: 'no such environment' }, 404)
    }

    // Checked before anything is written, secrets included: a refused request
    // must leave no trace on either project.
    if (environment.projectId !== projectId) {
      return c.json(
        { error: 'forbidden', message: 'environment does not belong to this project' },
        403,
      )
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
      .update(environments)
      .set({
        configOverride: override,
        environmentDraft: null,
        updatedAt: new Date(),
      })
      .where(eq(environments.id, environment.id))

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
  app.delete('/projects/:id', requireOwner, async (c) => {
    const id = routeParam(c, 'id')
    if (!id) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }
    const deleted = await deps.db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id })

    if (deleted.length === 0) {
      return c.json({ error: 'not_found', message: 'no such project' }, 404)
    }

    return c.json({ deleted: true })
  })

  return app
}
