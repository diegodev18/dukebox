import type { PullRequestSummary } from '@dukebox/protocol'

/**
 * How a session's pull request looks in the app.
 *
 * GitHub's `state` is only open / merged / closed. Draft vs ready is `isDraft`
 * on an open PR — treating `open` as green would paint a draft as reviewable.
 */

export type PullRequestVisualStatus = 'draft' | 'open' | 'merged' | 'closed'

export function pullRequestStatus(pr: PullRequestSummary): PullRequestVisualStatus {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.isDraft) return 'draft'
  return 'open'
}

export function pullRequestStatusLabel(status: PullRequestVisualStatus): string {
  return {
    draft: 'Draft',
    open: 'Ready for review',
    merged: 'Merged',
    closed: 'Closed',
  }[status]
}

export function pullRequestStatusAriaLabel(status: PullRequestVisualStatus): string {
  return {
    draft: 'Draft pull request',
    open: 'Ready for review',
    merged: 'Merged pull request',
    closed: 'Closed pull request',
  }[status]
}

export function pullRequestStatusClass(status: PullRequestVisualStatus): string {
  return {
    draft: 'text-muted-foreground',
    open: 'text-done',
    merged: 'text-pr-merged',
    closed: 'text-destructive',
  }[status]
}

/** The GitHub number from a pull request URL, or null if it is not there. */
export function pullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)
  if (!match?.[1]) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) ? n : null
}

export function pullRequestTabLabel(url: string | null | undefined): string {
  if (!url) return 'Pull request'
  const n = pullRequestNumber(url)
  return n ? `Pull request #${n}` : 'Pull request'
}
