import type { PullRequestSummary } from '@dukebox/protocol'
import { PullRequestIcon } from '@/components/icons'
import {
  pullRequestStatus,
  pullRequestStatusAriaLabel,
  pullRequestStatusClass,
} from '@/lib/pullRequest'

/**
 * The GitHub pull-request mark, coloured for draft / ready / merged / closed.
 */
export function PullRequestStatusIcon({
  pr,
  size = 13,
}: {
  pr: PullRequestSummary
  size?: number
}) {
  const status = pullRequestStatus(pr)

  return (
    <span
      role="img"
      aria-label={pullRequestStatusAriaLabel(status)}
      className={`inline-flex flex-none ${pullRequestStatusClass(status)}`}
    >
      <PullRequestIcon size={size} />
    </span>
  )
}
