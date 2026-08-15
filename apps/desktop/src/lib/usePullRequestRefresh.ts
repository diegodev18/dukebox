import { useEffect, useRef } from 'react'
import type { PullRequestDetails, PullRequestSummary, SessionSummary } from '@dukebox/protocol'
import {
  PULL_REQUEST_POLL_MS,
  pullRequestDetailsSummary,
  sessionPullRequestNeedsRefresh,
} from '@/lib/pullRequest'

/**
 * Keep stored pull request marks in sync with GitHub.
 *
 * Opening or merging inside the app writes the new state immediately. A merge
 * or close on GitHub does not, so the selected session is refreshed when
 * it is selected and on an interval while the pull request is still open.
 * Coming back to the window also refreshes every other open pull request so
 * the sidebar marks stay honest.
 */

export type PullRequestRefreshClient = {
  getPullRequest: (sessionId: string) => Promise<PullRequestDetails>
}

export function useOpenPullRequestRefresh(
  client: PullRequestRefreshClient,
  sessions: SessionSummary[],
  selectedId: string | null,
  enabled: boolean,
  onUpdated: (
    sessionId: string,
    patch: { pullRequestUrl: string; pullRequest: PullRequestSummary },
  ) => void,
): void {
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const onUpdatedRef = useRef(onUpdated)
  onUpdatedRef.current = onUpdated
  const clientRef = useRef(client)
  clientRef.current = client

  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    const refresh = async (session: SessionSummary) => {
      if (!sessionPullRequestNeedsRefresh(session)) return

      try {
        const details = await clientRef.current.getPullRequest(session.id)
        if (cancelled) return

        const pullRequest = pullRequestDetailsSummary(details)
        const current = session.pullRequest
        if (
          current &&
          current.url === pullRequest.url &&
          current.title === pullRequest.title &&
          current.isDraft === pullRequest.isDraft &&
          current.state === pullRequest.state
        ) {
          return
        }

        onUpdatedRef.current(session.id, {
          pullRequestUrl: details.url,
          pullRequest,
        })
      } catch {
        // Keep the cached summary. A blip must not blank the sidebar mark.
      }
    }

    const selected = sessionsRef.current.find((session) => session.id === selectedId)
    if (selected) void refresh(selected)

    const timer = window.setInterval(() => {
      const current = sessionsRef.current.find((session) => session.id === selectedId)
      if (current) void refresh(current)
    }, PULL_REQUEST_POLL_MS)

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      for (const session of sessionsRef.current) void refresh(session)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, selectedId])
}
