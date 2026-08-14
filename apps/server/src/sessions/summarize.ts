import type { Session } from '@dukebox/db'
import {
  permissionMode,
  pullRequestState,
  type PermissionMode,
  type PullRequestSummary,
  type SessionStatus,
  type SessionSummary,
} from '@dukebox/protocol'

/**
 * A database row as the client sees it.
 *
 * Shared because a session summary reaches the app two ways — a REST response
 * and a live update — and two copies of this mapping would drift, leaving the
 * sidebar showing different fields depending on how it heard.
 */
export function toSummary(session: Session): SessionSummary {
  const pullRequest = toPullRequest(session)

  return {
    id: session.id,
    projectId: session.projectId,
    agentId: session.agentId,
    status: session.status as SessionStatus,
    purpose: (session.purpose as SessionSummary['purpose']) || 'coding',
    title: session.title,
    branch: session.branch,
    baseBranch: session.baseBranch,
    baseCommit: session.baseCommit,
    changedFileCount: session.changedFileCount,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
    lastSeq: session.lastSeq,
    pullRequestUrl: session.prUrl,
    pullRequest,
    environmentId: session.environmentId,
    permissionMode: parsePermissionMode(session.permissionMode, session.agentId),
  }
}

function toPullRequest(session: Session): PullRequestSummary | null {
  if (!session.prUrl) return null

  const parsed = pullRequestState.safeParse(session.prState)

  return {
    url: session.prUrl,
    title: session.prTitle ?? '',
    isDraft: session.prDraft ?? true,
    state: parsed.success ? parsed.data : 'open',
  }
}

function parsePermissionMode(raw: string | null, agentId: string): PermissionMode | null {
  if (raw) {
    const parsed = permissionMode.safeParse(raw)
    if (parsed.success) return parsed.data
  }

  // Pre-migration Claude Code, OpenCode, and Grok Build sessions always ran in bypass.
  if (agentId === 'claude-code' || agentId === 'opencode' || agentId === 'grok-build') {
    return 'bypass'
  }
  return null
}
