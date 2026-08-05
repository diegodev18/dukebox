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
 * resumes it. `stopped` means the container is gone.
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
})

export type SessionSummary = z.infer<typeof sessionSummary>
