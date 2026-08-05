import type { Session } from '@dukebox/db'
import type { SessionStatus, SessionSummary } from '@dukebox/protocol'

/**
 * A database row as the client sees it.
 *
 * Shared because a session summary reaches the app two ways — a REST response
 * and a live update — and two copies of this mapping would drift, leaving the
 * sidebar showing different fields depending on how it heard.
 */
export function toSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    projectId: session.projectId,
    agentId: session.agentId,
    status: session.status as SessionStatus,
    purpose: (session.purpose as SessionSummary['purpose']) || 'coding',
    title: session.title,
    branch: session.branch,
    baseBranch: session.baseBranch,
    changedFileCount: session.changedFileCount,
    createdAt: session.createdAt.getTime(),
    updatedAt: session.updatedAt.getTime(),
    lastSeq: session.lastSeq,
    pullRequestUrl: session.prUrl,
  }
}
