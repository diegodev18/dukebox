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
 * resumes it. `stopped` means the container was shut down: the session was
 * archived, or the control plane restarted. A follow-up starts it again.
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
 * `bypassPermissions`, `plan`, `auto`, `acceptEdits`).
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
 * — it does not run the project's own setup, which would be circular.
 */
export const sessionPurpose = z.enum(['coding', 'environment_setup'])

export type SessionPurpose = z.infer<typeof sessionPurpose>

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
   * Null hides the picker (OpenCode). Claude Code always carries a mode;
   * absent on a pre-migration row is treated as `bypass` by the server.
   */
  permissionMode: permissionMode.nullable(),
})

export type SessionSummary = z.infer<typeof sessionSummary>
