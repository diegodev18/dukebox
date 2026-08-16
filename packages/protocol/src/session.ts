import { z } from 'zod'

/**
 * Session lifecycle.
 *
 *   provisioning ──> running ──> waiting_input ──> running ──> done
 *                       │              │                        │
 *                       └──────────────┴──> failed              └──> stopped
 *
 * `waiting_input` is distinct from `running` because it drives the sidebar
 * badge and the desktop notification: it means the agent has stopped and needs
 * the user before anything else happens.
 *
 * `done` means the turn finished and the container is still warm — a follow-up
 * resumes it. `stopped` means the container was shut down because the session
 * was archived or explicitly stopped. A follow-up starts it again.
 *
 * A control-plane restart does not mark sessions stopped: in-progress turns
 * are restored and the agent is asked to continue.
 */
export const sessionStatus = z.enum([
  'provisioning',
  'running',
  'waiting_input',
  'done',
  'failed',
  'stopped',
])

export type SessionStatus = z.infer<typeof sessionStatus>

/** Statuses where the agent will not produce further events without input. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ['done', 'failed', 'stopped']

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/**
 * What an adapter supports.
 *
 * The UI degrades on these rather than branching on agent identity: an agent
 * without `permissions` never shows an approval card, one without `thinking`
 * never shows a reasoning block. Without this, every new agent breaks the UI.
 */

/**
 * How an agent is allowed to act.
 *
 * `bypass` is unattended: the sandbox is the trust boundary. `plan` is
 * read-only until the user approves. `auto` lets the agent's own classifier
 * review actions. `acceptEdits` auto-approves file writes and still asks for
 * the rest.
 *
 * Names are agent-agnostic; adapters map them onto native flags (Claude Code
 * `bypassPermissions`, `plan`, `auto`, `acceptEdits`). OpenCode has no native
 * `auto` or `acceptEdits`: it runs `--agent plan` for `plan` and the default
 * build agent for everything else, so the UI offers it only Plan and Bypass.
 */
export const permissionMode = z.enum(['bypass', 'plan', 'auto', 'acceptEdits'])

export type PermissionMode = z.infer<typeof permissionMode>

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypass'

/**
 * `permission_request.action` when Claude Code wants to leave plan mode.
 *
 * Distinct from a generic tool name so the UI can offer "Implement" /
 * "Keep planning" rather than Allow / Deny.
 */
export const EXIT_PLAN_MODE_ACTION = 'exit_plan_mode'

/**
 * The `ExitPlanMode` tool input: the plan the agent wants approved.
 *
 * Carried through `permission_request.detail`, which is `unknown` because every
 * other tool puts its own arguments there.
 */
export const exitPlanDetail = z.object({ plan: z.string() })

/**
 * Read the plan markdown off a permission block's detail.
 *
 * Null rather than throwing: an agent may call `ExitPlanMode` with no plan at
 * all, and a session that cannot render the plan still has to be answerable.
 */
export function planFromDetail(detail: unknown): string | null {
  const parsed = exitPlanDetail.safeParse(detail)
  if (!parsed.success) return null
  const plan = parsed.data.plan.trim()
  return plan === '' ? null : plan
}

export const agentCapabilities = z.object({
  /** Emits permission_request and waits for an answer. */
  permissions: z.boolean(),
  /** Emits thinking events. */
  thinking: z.boolean(),
  /** Can continue a previous session rather than starting fresh. */
  resume: z.boolean(),
  /** Supports MCP servers. */
  mcp: z.boolean(),
  /** Can be interrupted mid-turn. */
  interrupt: z.boolean(),
  /** Exposes a permission-mode picker and accepts set_permission_mode. */
  permissionModes: z.boolean(),
})

export type AgentCapabilities = z.infer<typeof agentCapabilities>

/** An agent available on this server. */
export const agentDescriptor = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: agentCapabilities,
  /** Absent when the agent is not installed in the base image. */
  version: z.string().optional(),
})

export type AgentDescriptor = z.infer<typeof agentDescriptor>

/**
 * Why a session exists.
 *
 * `coding` is a normal agent turn. `environment_setup` asks the agent to
 * inspect the repository and propose setup commands and environment variables
 * — it does not run the project's own setup, which would be circular. Setup
 * always starts in bypass so the agent can write the proposal unattended.
 */
export const sessionPurpose = z.enum(['coding', 'environment_setup'])

export type SessionPurpose = z.infer<typeof sessionPurpose>

/**
 * The permission mode a new session should start with.
 *
 * Agents without modes store null. Claude Code, OpenCode, and Grok Build
 * default to bypass.
 * `environment_setup` always starts in bypass: the agent has to write a
 * proposal file unattended, and a leftover Plan mode from a coding session
 * would stall on that write.
 */
export function resolvePermissionMode(
  agentId: string,
  purpose: SessionPurpose,
  requested?: PermissionMode,
): PermissionMode | null {
  if (agentId !== 'claude-code' && agentId !== 'opencode' && agentId !== 'grok-build') {
    return null
  }
  if (purpose === 'environment_setup') return DEFAULT_PERMISSION_MODE
  return requested ?? DEFAULT_PERMISSION_MODE
}

/** How a pull request is merged from the app. */
export const mergeMethod = z.enum(['squash', 'merge', 'rebase'])

export type MergeMethod = z.infer<typeof mergeMethod>

/**
 * How the pull request title and body are written.
 *
 * `auto` uses the session's provider when one is configured, then a dedicated
 * model, then a git-only fallback. `dedicated` skips the session provider.
 * `heuristic` never calls a model.
 */
export const prDescriptionMode = z.enum(['auto', 'dedicated', 'heuristic'])

export type PrDescriptionMode = z.infer<typeof prDescriptionMode>

/**
 * Per-session git / pull-request behaviour, sent from the app's settings.
 *
 * Defaults match Cursor: draft PRs, opened automatically, leftover changes
 * committed at the end of a turn, squash merge, delete the branch after.
 */
export const gitPreferences = z.object({
  createAsDraft: z.boolean().default(true),
  autoOpenDraft: z.boolean().default(true),
  commitOnTurnEnd: z.boolean().default(true),
  mergeMethod: mergeMethod.default('squash'),
  deleteBranchAfterMerge: z.boolean().default(true),
  prDescription: prDescriptionMode.default('auto'),
  /** OpenCode `provider/model` used when writing the PR description. */
  dedicatedModel: z.string().min(1).optional(),
})

export type GitPreferences = z.infer<typeof gitPreferences>

export const DEFAULT_GIT_PREFERENCES: GitPreferences = gitPreferences.parse({})

/** Fill missing keys so a partial row or an older client still works. */
export function parseGitPreferences(raw: unknown): GitPreferences {
  const parsed = gitPreferences.safeParse(raw ?? {})
  return parsed.success ? parsed.data : DEFAULT_GIT_PREFERENCES
}

/**
 * Whether this session should still commit, push, or open a pull request.
 *
 * A merged session keeps its transcript and workspace, but the branch is no
 * longer a review destination — further work starts a new session.
 */
export function sessionOpensPullRequests(state: PullRequestState | null | undefined): boolean {
  return state !== 'merged'
}

/**
 * Reuse the GitHub pull request already open for this branch.
 *
 * Merged and closed PRs are not destinations: attaching new commits to a
 * merged review leaves the work without a place to land.
 */
export function reuseExistingPullRequest(state: PullRequestState): boolean {
  return state === 'open'
}

/**
 * Prefixed onto the next agent prompt after this session's pull request merges.
 *
 * The agent has its own conversation and never sees Dukebox session rows, so
 * without this it keeps treating the (possibly deleted) branch as live.
 */
export const MERGED_SESSION_AGENT_NOTICE =
  'The pull request for this session was merged. Do not push this branch or open another pull request from it. For new work, start a new session from the base branch.'

/** GitHub's view of a pull request opened from a session. */
export const pullRequestState = z.enum(['open', 'merged', 'closed'])

export type PullRequestState = z.infer<typeof pullRequestState>

export const pullRequestSummary = z.object({
  url: z.string().url(),
  title: z.string(),
  isDraft: z.boolean(),
  state: pullRequestState,
})

export type PullRequestSummary = z.infer<typeof pullRequestSummary>

export const pullRequestChecks = z.enum(['passing', 'pending', 'failing', 'none'])

export type PullRequestChecks = z.infer<typeof pullRequestChecks>

export const pullRequestReviewDecision = z.enum([
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
])

export type PullRequestReviewDecision = z.infer<typeof pullRequestReviewDecision>

/** GitHub GraphQL `mergeStateStatus` on a pull request. */
export const pullRequestMergeStateStatus = z.enum([
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
])

export type PullRequestMergeStateStatus = z.infer<typeof pullRequestMergeStateStatus>

export const pullRequestCheckRunState = z.enum(['pending', 'passing', 'failing', 'neutral'])

export type PullRequestCheckRunState = z.infer<typeof pullRequestCheckRunState>

export const pullRequestCheckRun = z.object({
  name: z.string(),
  state: pullRequestCheckRunState,
  url: z.string().optional(),
})

export type PullRequestCheckRun = z.infer<typeof pullRequestCheckRun>

export const pullRequestCommit = z.object({
  sha: z.string(),
  title: z.string(),
  author: z.string().optional(),
})

export type PullRequestCommit = z.infer<typeof pullRequestCommit>

export const pullRequestReviewState = z.enum([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
])

export type PullRequestReviewState = z.infer<typeof pullRequestReviewState>

export const pullRequestReview = z.object({
  author: z.string(),
  state: pullRequestReviewState,
  body: z.string().optional(),
  submittedAt: z.string().optional(),
})

export type PullRequestReview = z.infer<typeof pullRequestReview>

export const pullRequestDetails = pullRequestSummary.extend({
  body: z.string().optional(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullable().optional(),
  checks: pullRequestChecks.optional(),
  reviewDecision: pullRequestReviewDecision.nullable().optional(),
  mergeStateStatus: pullRequestMergeStateStatus.nullable().optional(),
  commits: z.array(pullRequestCommit).optional(),
  checkRuns: z.array(pullRequestCheckRun).optional(),
  reviews: z.array(pullRequestReview).optional(),
})

export type PullRequestDetails = z.infer<typeof pullRequestDetails>

/** Why this pull request must not merge yet, or null when the app may proceed. */
export function pullRequestMergeBlock(pr: {
  checks?: PullRequestChecks | undefined
  reviewDecision?: PullRequestReviewDecision | null | undefined
  mergeStateStatus?: PullRequestMergeStateStatus | null | undefined
}): string | null {
  if (pr.checks === 'failing') return 'GitHub status checks have not passed'
  if (pr.checks === 'pending') return 'GitHub status checks are still running'
  // GitHub often returns an empty check rollup for a few seconds after open
  // while still refusing the merge. BLOCKED / UNSTABLE with no rollup means
  // required checks (or something equivalent) are not green yet.
  if (
    (pr.checks === 'none' || pr.checks === undefined) &&
    (pr.mergeStateStatus === 'BLOCKED' || pr.mergeStateStatus === 'UNSTABLE')
  ) {
    return 'GitHub status checks are still running'
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes were requested on this pull request'
  }
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    return 'this pull request still needs a review'
  }
  return null
}

/** Which pull-request panel explains the current merge block, if any. */
export function pullRequestMergeBlockPanel(
  pr: Parameters<typeof pullRequestMergeBlock>[0],
): 'checks' | 'reviews' | null {
  const message = pullRequestMergeBlock(pr)
  if (!message) return null
  if (/review|changes were requested/i.test(message)) return 'reviews'
  if (/status checks/i.test(message)) return 'checks'
  return null
}

/** A session as the client sees it. */
export const sessionSummary = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  agentId: z.string(),
  status: sessionStatus,
  purpose: sessionPurpose.default('coding'),
  title: z.string(),
  /** Branch the agent works on, e.g. `duke/3f9a2b`. */
  branch: z.string(),
  baseBranch: z.string(),
  /** The commit the session's work starts from, or null before the sandbox is provisioned. */
  baseCommit: z.string().nullable().default(null),
  changedFileCount: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  /** Highest event seq assigned so far. Clients sync from here. */
  lastSeq: z.number().int().nonnegative(),
  /**
   * The pull request opened from this session's branch, once there is one.
   *
   * Carried on the summary so the app can offer to open the pull request or to
   * visit it, rather than offering to open a second one that the server would
   * refuse.
   */
  pullRequestUrl: z.string().url().nullable(),
  /**
   * The same pull request, with the fields the workspace tab needs.
   *
   * Null until one is opened. `pullRequestUrl` stays for older clients.
   */
  pullRequest: pullRequestSummary.nullable().default(null),
  /**
   * The environment this session resolved to, or null for the base image.
   *
   * Null is a legitimate state, not an error: a coding session on a branch no
   * pattern matches runs on `dukebox/base-node:latest`. It is carried here
   * because the environment routes are keyed by environment rather than by
   * project, so the app cannot read or write a session's config without it.
   */
  environmentId: z.string().uuid().nullable(),
  /**
   * How the agent is allowed to act, or null when it has no modes.
   *
   * Null hides the picker. An absent value on a pre-migration row is treated
   * as `bypass` by the server.
   */
  permissionMode: permissionMode.nullable(),
  /**
   * The model this session is running, or null when unknown.
   *
   * A mid-session change is held in memory and published here so the composer
   * picker has a value. After a process restart the last `session_started`
   * event (or the start-time model) is what resume uses.
   */
  model: z.string().nullable().optional(),
})

export type SessionSummary = z.infer<typeof sessionSummary>
