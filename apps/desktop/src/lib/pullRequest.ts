import type {
  PullRequestCheckRun,
  PullRequestCheckRunState,
  PullRequestChecks,
  PullRequestDetails,
  PullRequestMergeStateStatus,
  PullRequestReviewDecision,
  PullRequestReviewState,
  PullRequestSummary,
} from '@dukebox/protocol'

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

/** Short header hint for why merge is not ready. Null when nothing blocks. */
export function pullRequestMergeHint(pr: {
  checks?: PullRequestChecks | undefined
  reviewDecision?: PullRequestReviewDecision | null | undefined
  mergeStateStatus?: PullRequestMergeStateStatus | null | undefined
}): string | null {
  if (pr.checks === 'failing') return 'Status checks have not passed'
  if (pr.checks === 'pending') return 'Checks are still running'
  if (
    (pr.checks === 'none' || pr.checks === undefined) &&
    (pr.mergeStateStatus === 'BLOCKED' || pr.mergeStateStatus === 'UNSTABLE')
  ) {
    return 'Checks are still running'
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'Changes requested'
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'Needs a review'
  return null
}

export function pullRequestCheckRunLabel(state: PullRequestCheckRunState): string {
  return {
    pending: 'In progress',
    passing: 'Passed',
    failing: 'Failed',
    neutral: 'Neutral',
  }[state]
}

export function pullRequestCheckRunClass(state: PullRequestCheckRunState): string {
  return {
    pending: 'text-muted-foreground',
    passing: 'text-done',
    failing: 'text-destructive',
    neutral: 'text-muted-foreground',
  }[state]
}

export function pullRequestReviewStateLabel(state: PullRequestReviewState): string {
  return {
    APPROVED: 'Approved',
    CHANGES_REQUESTED: 'Changes requested',
    COMMENTED: 'Commented',
    DISMISSED: 'Dismissed',
    PENDING: 'Pending',
  }[state]
}

export function pullRequestCommitSha(sha: string): string {
  return sha.slice(0, 7)
}

export function pullRequestChecksTabLabel(
  runs: readonly PullRequestCheckRun[] | undefined,
): string {
  if (!runs || runs.length === 0) return 'Checks'
  const done = runs.filter((run) => run.state !== 'pending').length
  return `Checks · ${done}/${runs.length}`
}

/** How often to refresh GitHub while a pull request can still change. */
export const PULL_REQUEST_POLL_MS = 10_000

export function sessionPullRequestNeedsRefresh(session: {
  purpose?: string | null
  pullRequestUrl?: string | null
  pullRequest?: Pick<PullRequestSummary, 'state'> | null
}): boolean {
  if (session.purpose === 'environment_setup') return false
  if (!session.pullRequest && !session.pullRequestUrl) return false
  return session.pullRequest?.state !== 'merged' && session.pullRequest?.state !== 'closed'
}

export function pullRequestDetailsSummary(
  details: PullRequestDetails,
): Pick<PullRequestSummary, 'url' | 'title' | 'isDraft' | 'state'> {
  return {
    url: details.url,
    title: details.title,
    isDraft: details.isDraft,
    state: details.state,
  }
}
