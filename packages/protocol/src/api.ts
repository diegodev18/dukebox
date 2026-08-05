import { z } from 'zod'
import { environmentProposal } from './config.js'
import { sessionPurpose, sessionSummary } from './session.js'

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
  /**
   * Whether the project has a saved environment (`configOverride`).
   *
   * Drives the desktop: without one, the user is steered into environment
   * setup before a normal coding session.
   */
  hasEnvironment: z.boolean(),
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
// Project environment
// ---------------------------------------------------------------------------

/**
 * The project's environment as the desktop reviews and edits it.
 *
 * Secret values never leave the server: the response carries names and whether
 * each one is already stored, not the plaintext.
 */
export const projectEnvironmentResponse = z.object({
  /** Saved config when one exists; null until the user confirms a proposal. */
  config: z
    .object({
      image: z.string(),
      setup: z.array(z.string()),
      env: z.record(z.string()),
      instructions: z.string(),
    })
    .nullable(),
  /** Agent proposal waiting for review, if any. */
  draft: environmentProposal.nullable(),
  /** Project secret names that are already stored (values never returned). */
  secretNames: z.array(z.string()),
})

export type ProjectEnvironmentResponse = z.infer<typeof projectEnvironmentResponse>

/**
 * Confirm (or replace) the project's environment.
 *
 * `secrets` holds plaintext values to store; they become `${secret.NAME}` refs
 * in `config.env`. `literalEnv` supplies non-secret values keyed by name.
 */
export const putProjectEnvironmentRequest = z.object({
  setup: z.array(z.string()),
  /** Env names that should be secret references; values go in `secrets`. */
  secretEnv: z.array(z.string()).default([]),
  /** Non-secret env literals. */
  literalEnv: z.record(z.string()).default({}),
  /** Secret values to upsert (name → plaintext). */
  secrets: z.record(z.string()).default({}),
  instructions: z.string().optional(),
  image: z.string().optional(),
})

export type PutProjectEnvironmentRequest = z.infer<typeof putProjectEnvironmentRequest>

export const environmentProposalResponse = z.object({
  proposal: environmentProposal.nullable(),
})

export type EnvironmentProposalResponse = z.infer<typeof environmentProposalResponse>

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const createSessionRequest = z
  .object({
    projectId: z.string().uuid(),
    agentId: z.string().min(1),
    /** Defaults to the project's default branch. */
    baseBranch: z.string().optional(),
    /**
     * Model the agent should use for this session.
     *
     * Passed through to the adapter (e.g. Claude Code `--model`). When absent,
     * the agent uses its own default.
     */
    model: z.string().min(1).optional(),
    purpose: sessionPurpose.default('coding'),
    /** Required for coding sessions; ignored for environment_setup (server prompt). */
    prompt: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.purpose === 'coding' && (!data.prompt || data.prompt.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'prompt is required for coding sessions',
      })
    }
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
