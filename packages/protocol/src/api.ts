import { z } from 'zod'
import { sessionSummary } from './session.js'

/**
 * The REST surface between the desktop app and the control plane.
 *
 * REST handles setup — listing repositories, registering projects, creating
 * sessions. Live session traffic goes over the WebSocket instead, because a
 * request/response shape cannot express a stream of events.
 */

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** A repository on GitHub the user could turn into a project. */
export const repositorySummary = z.object({
  fullName: z.string(),
  defaultBranch: z.string().nullable(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  /** Whether this repository is already registered as a project. */
  isRegistered: z.boolean(),
})

export type RepositorySummary = z.infer<typeof repositorySummary>

export const listRepositoriesResponse = z.object({
  repositories: z.array(repositorySummary),
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectSummary = z.object({
  id: z.string().uuid(),
  repoFullName: z.string(),
  defaultBranch: z.string(),
  /** Image built after the project's setup ran, when one exists. */
  hasSnapshot: z.boolean(),
  createdAt: z.number().int().positive(),
  /** Sessions that have run for this project. */
  sessionCount: z.number().int().nonnegative(),
})

export type ProjectSummary = z.infer<typeof projectSummary>

export const createProjectRequest = z.object({
  /** `owner/repo` as GitHub names it. */
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/repo'),
  /** Defaults to whatever GitHub reports for the repository. */
  defaultBranch: z.string().optional(),
})

export type CreateProjectRequest = z.infer<typeof createProjectRequest>

export const listProjectsResponse = z.object({ projects: z.array(projectSummary) })

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createSessionRequest = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().min(1),
  /** Defaults to the project's default branch. */
  baseBranch: z.string().optional(),
  /** The first thing the agent is asked to do. */
  prompt: z.string().min(1),
})

export type CreateSessionRequest = z.infer<typeof createSessionRequest>

export const listSessionsResponse = z.object({ sessions: z.array(sessionSummary) })

export const openPullRequestRequest = z.object({
  /** Defaults to the session's title. */
  title: z.string().optional(),
})

export const openPullRequestResponse = z.object({ url: z.string().url() })

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The shape every failed request returns.
 *
 * `error` is a stable code the app can branch on; `message` is for a person to
 * read. Without the code, a client would have to match on prose that changes.
 */
export const apiError = z.object({
  error: z.string(),
  message: z.string(),
})

export type ApiError = z.infer<typeof apiError>
