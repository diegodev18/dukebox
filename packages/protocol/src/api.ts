import { z } from 'zod'
import { environmentProposal } from './config.js'
import {
  gitPreferences,
  mergeMethod,
  permissionMode,
  pullRequestDetails,
  pullRequestSummary,
  sessionPurpose,
  sessionSummary,
} from './session.js'
import { MAX_BRANCH_PATTERN_LENGTH } from './branchPattern.js'

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
  /**
   * How many environments the project has.
   *
   * Zero means every session runs on the base image, which the desktop shows
   * as a prompt to configure one rather than as an error.
   */
  environmentCount: z.number().int().nonnegative(),
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
// Environments
// ---------------------------------------------------------------------------

export const environmentSummary = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  /** Glob, or a regular expression behind a `re:` prefix. */
  branchPattern: z.string(),
  /** Tie-break when several patterns match a branch. Lower wins. */
  position: z.number().int().nonnegative(),
  /** Whether setup and env have been saved, as opposed to only the row existing. */
  hasConfig: z.boolean(),
  /** Image built after this environment's setup ran, when one exists. */
  hasSnapshot: z.boolean(),
  /** Whether a proposal is waiting to be reviewed. */
  hasDraft: z.boolean(),
})

export type EnvironmentSummary = z.infer<typeof environmentSummary>

const branchPatternField = z
  .string()
  .min(1, 'pattern cannot be empty')
  // The full safety check (nested quantifiers, compilability) lives in
  // validateBranchPattern and runs in the route. This bound is here so an
  // obviously oversized pattern never reaches it.
  .max(MAX_BRANCH_PATTERN_LENGTH, `pattern cannot exceed ${MAX_BRANCH_PATTERN_LENGTH} characters`)

export const createEnvironmentRequest = z.object({
  name: z.string().min(1, 'name cannot be empty').max(80),
  branchPattern: branchPatternField,
})

export type CreateEnvironmentRequest = z.infer<typeof createEnvironmentRequest>

export const updateEnvironmentRequest = z.object({
  name: z.string().min(1).max(80).optional(),
  branchPattern: branchPatternField.optional(),
})

export type UpdateEnvironmentRequest = z.infer<typeof updateEnvironmentRequest>

/**
 * The complete ordered list of ids.
 *
 * Sending the whole list rather than "move X to slot 3" keeps two concurrent
 * clients from producing an order neither of them asked for.
 */
export const reorderEnvironmentsRequest = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

export type ReorderEnvironmentsRequest = z.infer<typeof reorderEnvironmentsRequest>

export const listEnvironmentsResponse = z.object({
  environments: z.array(environmentSummary),
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A file attached to a prompt.
 *
 * `data` is a base64 data URI; the agent sees the decoded bytes at
 * `/tmp/imgs/<name>`, staged by the adapter before the prompt runs.
 */
export const attachedFile = z.object({
  name: z.string().min(1),
  data: z.string().min(1),
})

export type AttachedFile = z.infer<typeof attachedFile>

export const createSessionRequest = z
  .object({
    projectId: z.string().uuid(),
    agentId: z.string().min(1),
    /** Defaults to the project's default branch. */
    baseBranch: z.string().optional(),
    /**
     * Which environment to run in.
     *
     * Optional: the server resolves one from the base branch when absent. The
     * client proposes, the server decides — an id belonging to another project
     * is rejected rather than honoured.
     */
    environmentId: z.string().uuid().optional(),
    /**
     * Model the agent should use for this session.
     *
     * Passed through to the adapter (e.g. Claude Code `--model`). When absent,
     * the agent uses its own default.
     */
    model: z.string().min(1).optional(),
    /**
     * How the agent is allowed to act.
     *
     * Passed through to adapters that expose permission modes (Claude Code,
     * OpenCode). Ignored by the rest. Absent means the agent's default —
     * bypass for Claude Code and OpenCode. `environment_setup` always starts
     * in bypass, even when this field is set.
     */
    permissionMode: permissionMode.optional(),
    /**
     * Who this session's commits are authored as.
     *
     * Set from the app's settings; absent means the server's default identity.
     */
    commitIdentity: z
      .object({
        name: z.string().min(1),
        email: z.string().min(1),
      })
      .optional(),
    /**
     * How this session commits, opens, and merges pull requests.
     *
     * Absent means the server's defaults (draft, auto-open, squash).
     */
    gitPreferences: gitPreferences.optional(),
    purpose: sessionPurpose.default('coding'),
    /** Required for coding sessions; ignored for environment_setup (server prompt). */
    prompt: z.string().optional(),
    /**
     * Files to stage into the sandbox before the session's first prompt runs.
     *
     * `data` is a base64 data URI; the agent sees the decoded bytes at
     * `/tmp/imgs/<name>`.
     */
    files: z.array(attachedFile).optional(),
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
  /** Defaults to a generated title from the diff. */
  title: z.string().optional(),
})

export const openPullRequestResponse = pullRequestSummary

export const mergePullRequestRequest = z.object({
  method: mergeMethod.optional(),
})

export const mergePullRequestResponse = pullRequestSummary

export const pullRequestResponse = pullRequestDetails

/**
 * Result of asking the agent to update the session branch with the base and
 * resolve merge conflicts.
 *
 * `resolved` means git merged cleanly and the branch was pushed; the user can
 * confirm the GitHub merge. `resolving` means conflict markers are in the
 * working tree and the agent has been prompted to finish the job.
 */
export const resolvePullRequestConflictsResponse = z.object({
  status: z.enum(['resolved', 'resolving']),
  conflictedFiles: z.array(z.string()).optional(),
})

export type ResolvePullRequestConflictsResponse = z.infer<
  typeof resolvePullRequestConflictsResponse
>

/**
 * Paths in a session's workspace, relative to the repository root.
 *
 * Tracked and untracked files, excluding gitignored ones. Directories are
 * inferred by the client from the path prefixes.
 */
export const workspaceTreeResponse = z.object({
  paths: z.array(z.string()),
})

export type WorkspaceTreeResponse = z.infer<typeof workspaceTreeResponse>

/**
 * Contents of one workspace file.
 *
 * `content` is empty when `binary` is true: the desktop cannot preview
 * those, and sending the bytes would only waste the payload.
 */
export const workspaceFileResponse = z.object({
  path: z.string(),
  content: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
})

export type WorkspaceFileResponse = z.infer<typeof workspaceFileResponse>

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
