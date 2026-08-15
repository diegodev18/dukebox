import {
  pullRequestMergeBlock,
  pullRequestMergeBlockPanel,
  type FileChange,
  type PullRequestDetails,
  type PullRequestSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef, useState } from 'react'
import { ApiFailure, type DukeboxClient } from '@/lib/client'
import { FileChangeList } from '@/components/FileChangeList'
import { Markdown } from '@/components/Markdown'
import { BranchIcon } from '@/components/icons'
import { PullRequestStatusIcon } from '@/components/PullRequestStatusIcon'
import {
  PULL_REQUEST_POLL_MS,
  pullRequestCheckRunClass,
  pullRequestCheckRunLabel,
  pullRequestChecksTabLabel,
  pullRequestCommitSha,
  pullRequestDetailsSummary,
  pullRequestMergeHint,
  pullRequestReviewStateLabel,
  pullRequestStatus,
  pullRequestStatusLabel,
} from '@/lib/pullRequest'

/**
 * The workspace tab for a session's pull request.
 *
 * Opening, marking ready, and merging all happen here — the session header
 * does not carry a second control for the same thing.
 */

export interface PullRequestTab {
  client: DukeboxClient
  onUpdated: (patch: { pullRequestUrl: string; pullRequest: PullRequestSummary }) => void
  /** Open New Session from this project's base branch after a merge. */
  onContinue?: () => void
}

interface Props {
  client: DukeboxClient
  session: SessionSummary
  files: FileChange[]
  onUpdated: PullRequestTab['onUpdated']
  onContinue?: PullRequestTab['onContinue']
  disabled?: boolean
}

type Action =
  | { kind: 'idle' }
  | { kind: 'working'; verb: string }
  | { kind: 'failed'; message: string }
  | { kind: 'notice'; message: string }

type MergePrompt = 'idle' | 'confirm' | 'conflicts' | 'resolving'

type PrPanelTab = 'changes' | 'description' | 'commits' | 'checks' | 'reviews'

const PR_TABS: PrPanelTab[] = ['changes', 'description', 'commits', 'checks', 'reviews']

const PR_TAB_LABELS: Record<PrPanelTab, string> = {
  changes: 'Changes',
  description: 'Description',
  commits: 'Commits',
  checks: 'Checks',
  reviews: 'Reviews',
}

export function PullRequestPanel({
  client,
  session,
  files,
  onUpdated,
  onContinue,
  disabled = false,
}: Props) {
  const [action, setAction] = useState<Action>({ kind: 'idle' })
  const [mergePrompt, setMergePrompt] = useState<MergePrompt>('idle')
  const [details, setDetails] = useState<PullRequestDetails | null>(null)
  const [prTab, setPrTab] = useState<PrPanelTab>('changes')
  const pr = session.pullRequest
  const agentWorking = session.status === 'running'
  const busy = action.kind === 'working' || disabled || agentWorking
  const onUpdatedRef = useRef(onUpdated)
  onUpdatedRef.current = onUpdated
  const clientRef = useRef(client)
  clientRef.current = client

  const applyDetails = (next: PullRequestDetails) => {
    setDetails(next)
    onUpdatedRef.current({
      pullRequestUrl: next.url,
      pullRequest: pullRequestDetailsSummary(next),
    })
  }

  useEffect(() => {
    if (!session.pullRequest && !session.pullRequestUrl) return
    let cancelled = false
    void Promise.resolve()
      .then(() => client.getPullRequest(session.id))
      .then((next) => {
        if (cancelled) return
        applyDetails(next)
      })
      .catch((error) => {
        if (cancelled) return
        setAction((current) =>
          current.kind === 'idle'
            ? {
                kind: 'failed',
                message:
                  error instanceof Error ? error.message : 'Could not load this pull request.',
              }
            : current,
        )
      })
    return () => {
      cancelled = true
    }
  }, [client, session.id, session.pullRequestUrl])

  const checksPending = details?.checks === 'pending'
  useEffect(() => {
    if (!checksPending || (!session.pullRequest && !session.pullRequestUrl)) return
    let cancelled = false
    const tick = () => {
      void clientRef.current
        .getPullRequest(session.id)
        .then((next) => {
          if (cancelled) return
          applyDetails(next)
        })
        .catch(() => undefined)
    }
    const timer = window.setInterval(tick, PULL_REQUEST_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [checksPending, session.id, session.pullRequest, session.pullRequestUrl])

  const previousStatus = useRef(session.status)
  useEffect(() => {
    const wasRunning = previousStatus.current === 'running'
    previousStatus.current = session.status
    if (wasRunning && session.status !== 'running' && mergePrompt === 'resolving') {
      setMergePrompt('idle')
    }
  }, [session.status, mergePrompt])

  const run = async (verb: string, work: () => Promise<PullRequestSummary>) => {
    setAction({ kind: 'working', verb })
    setMergePrompt('idle')
    try {
      const next = await work()
      onUpdated({ pullRequestUrl: next.url, pullRequest: next })
      try {
        applyDetails(await client.getPullRequest(session.id))
      } catch {
        setDetails((current) => (current ? { ...current, ...next } : next))
      }
      setAction({ kind: 'idle' })
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'merge_conflict') {
        setMergePrompt('conflicts')
        setAction({ kind: 'idle' })
        return
      }
      const message = error instanceof Error ? error.message : 'The pull request action failed.'
      setAction({ kind: 'failed', message })
      const panel = pullRequestMergeBlockPanel(details ?? {})
      if (panel) setPrTab(panel)
      else if (/status checks/i.test(message)) setPrTab('checks')
      else if (/review|changes were requested/i.test(message)) setPrTab('reviews')
    }
  }

  const checkMerge = async () => {
    setAction({ kind: 'working', verb: 'check' })
    setMergePrompt('idle')
    try {
      const next = await client.getPullRequest(session.id)
      applyDetails(next)
      if (next.state !== 'open' || next.isDraft) {
        setAction({ kind: 'idle' })
        return
      }
      const blocked = pullRequestMergeBlock(next)
      if (blocked) {
        setAction({ kind: 'failed', message: blocked })
        const panel = pullRequestMergeBlockPanel(next)
        if (panel) setPrTab(panel)
        return
      }
      if (next.mergeable === 'CONFLICTING') {
        setMergePrompt('conflicts')
      } else {
        setMergePrompt('confirm')
      }
      setAction({ kind: 'idle' })
    } catch (error) {
      setAction({
        kind: 'failed',
        message:
          error instanceof Error
            ? error.message
            : 'Could not check whether the pull request can merge.',
      })
    }
  }

  const resolveConflicts = async () => {
    setAction({ kind: 'working', verb: 'resolve' })
    try {
      const result = await client.resolvePullRequestConflicts(session.id)
      if (result.status === 'resolved') {
        setMergePrompt('confirm')
        setAction({ kind: 'idle' })
        return
      }
      setMergePrompt('resolving')
      setAction({
        kind: 'notice',
        message:
          'The agent is resolving conflicts. Watch the transcript, then merge when it is done.',
      })
    } catch (error) {
      setAction({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not start conflict resolution.',
      })
    }
  }

  const mergeHint =
    pr && pr.state === 'open' && !pr.isDraft ? pullRequestMergeHint(details ?? {}) : null
  const seePanel =
    action.kind === 'failed'
      ? (pullRequestMergeBlockPanel(details ?? {}) ??
        (/status checks/i.test(action.message)
          ? 'checks'
          : /review|changes were requested/i.test(action.message)
            ? 'reviews'
            : null))
      : null

  return (
    <div
      role="tabpanel"
      id="workspace-panel-pr"
      aria-labelledby="workspace-tab-pr"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex-none border-b border-border px-3 py-2.5">
        {pr ? (
          <>
            <div className="flex items-start gap-2">
              <BranchIcon size={13} className="mt-0.5 flex-none text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{pr.title || 'Pull request'}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  <StatusBadge pr={pr} />
                </p>
                {mergeHint ? (
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{mergeHint}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {pr.state === 'open' && pr.isDraft && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run('ready', () => client.markPullRequestReady(session.id))}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  {action.kind === 'working' && action.verb === 'ready'
                    ? 'Marking ready…'
                    : 'Ready for review'}
                </button>
              )}

              {pr.state === 'open' && !pr.isDraft && mergePrompt === 'idle' && !agentWorking && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void checkMerge()}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  {action.kind === 'working' && action.verb === 'check' ? 'Checking…' : 'Merge'}
                </button>
              )}

              {mergePrompt === 'confirm' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run('merge', () => client.mergePullRequest(session.id))}
                    className="rounded-[calc(var(--radius)*0.6)] border border-destructive px-2.5 py-1 text-[12.5px] font-medium text-destructive hover:bg-muted disabled:opacity-50"
                  >
                    {action.kind === 'working' && action.verb === 'merge'
                      ? 'Merging…'
                      : 'Confirm merge'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setMergePrompt('idle')}
                    className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              )}

              {mergePrompt === 'conflicts' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void resolveConflicts()}
                    className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {action.kind === 'working' && action.verb === 'resolve'
                      ? 'Updating…'
                      : 'Resolve conflicts'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setMergePrompt('idle')}
                    className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => void openUrl(pr.url).catch(() => undefined)}
                className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground"
              >
                View on GitHub
              </button>

              {pr.state === 'merged' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run('open', () => client.openPullRequest(session.id))}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  {action.kind === 'working' && action.verb === 'open'
                    ? 'Opening…'
                    : 'Open new pull request'}
                </button>
              )}

              {pr.state === 'merged' && onContinue && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={onContinue}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  New session from {session.baseBranch}
                </button>
              )}
            </div>

            {pr.state === 'merged' && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                This pull request was merged. Keep working here and the next change will open a new
                pull request from {session.baseBranch}.
              </p>
            )}

            {mergePrompt === 'conflicts' && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                This pull request conflicts with {session.baseBranch}. Let the agent update the
                branch and resolve the conflicts?
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium">Pull request</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Opens a draft from this session's branch.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('open', () => client.openPullRequest(session.id))}
              className="mt-2.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {action.kind === 'working' && action.verb === 'open'
                ? 'Opening…'
                : 'Open pull request'}
            </button>
          </>
        )}

        {action.kind === 'failed' && (
          <p role="alert" className="mt-2 text-[12px] text-destructive">
            {action.message}
            {seePanel ? (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => setPrTab(seePanel)}
                  className="underline decoration-destructive/40 underline-offset-2 hover:decoration-destructive"
                >
                  {seePanel === 'checks' ? 'See checks' : 'See reviews'}
                </button>
              </>
            ) : null}
          </p>
        )}

        {action.kind === 'notice' && (
          <p className="mt-2 text-[12px] text-muted-foreground">{action.message}</p>
        )}
      </div>

      {pr ? (
        <>
          <PrTabBar
            tabs={PR_TABS}
            active={prTab}
            onSelect={setPrTab}
            labels={{ checks: pullRequestChecksTabLabel(details?.checkRuns) }}
          />
          {prTab === 'changes' ? (
            <div
              role="tabpanel"
              id="pr-panel-changes"
              aria-labelledby="pr-tab-changes"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              {files.length === 0 ? (
                <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
                  Diffs appear here once the agent changes files.
                </p>
              ) : (
                <FileChangeList key={session.id} files={files} />
              )}
            </div>
          ) : prTab === 'description' ? (
            <DescriptionPanel body={details?.body} />
          ) : prTab === 'commits' ? (
            <CommitsPanel commits={details?.commits} />
          ) : prTab === 'checks' ? (
            <ChecksPanel runs={details?.checkRuns} />
          ) : (
            <ReviewsPanel
              reviews={details?.reviews}
              reviewDecision={details?.reviewDecision ?? null}
            />
          )}
        </>
      ) : files.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
          Diffs appear here once the agent changes files.
        </p>
      ) : (
        <FileChangeList key={session.id} files={files} />
      )}
    </div>
  )
}

function StatusBadge({ pr }: { pr: PullRequestSummary }) {
  const status = pullRequestStatus(pr)
  return (
    <span className="inline-flex items-center gap-1.5">
      <PullRequestStatusIcon pr={pr} />
      {pullRequestStatusLabel(status)}
    </span>
  )
}

function PrTabBar({
  tabs,
  active,
  onSelect,
  labels,
}: {
  tabs: PrPanelTab[]
  active: PrPanelTab
  onSelect: (tab: PrPanelTab) => void
  labels?: Partial<Record<PrPanelTab, string>>
}) {
  const list = useRef<HTMLDivElement>(null)

  const move = (delta: number) => {
    const index = tabs.indexOf(active)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (!next) return
    onSelect(next)
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    })
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Pull request panels"
      className="flex flex-none gap-1 border-b border-border px-2 py-1.5"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          id={`pr-tab-${tab}`}
          role="tab"
          aria-selected={active === tab}
          aria-controls={`pr-panel-${tab}`}
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onSelect(tab)}
          className={`rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] ${
            active === tab
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {labels?.[tab] ?? PR_TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  )
}

function DescriptionPanel({ body }: { body?: string | undefined }) {
  return (
    <div
      role="tabpanel"
      id="pr-panel-description"
      aria-labelledby="pr-tab-description"
      className="min-h-0 flex-1 overflow-auto px-3 py-3"
    >
      {body?.trim() ? (
        <Markdown className="text-[12.5px]">{body}</Markdown>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">No description.</p>
      )}
    </div>
  )
}

function CommitsPanel({ commits }: { commits?: PullRequestDetails['commits'] }) {
  return (
    <div
      role="tabpanel"
      id="pr-panel-commits"
      aria-labelledby="pr-tab-commits"
      className="min-h-0 flex-1 overflow-auto"
    >
      {!commits || commits.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
          No commits on this pull request yet.
        </p>
      ) : (
        <ul className="flex flex-col py-1">
          {commits.map((commit) => (
            <li key={commit.sha} className="flex items-baseline gap-2 px-3 py-1.5 text-[12.5px]">
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {pullRequestCommitSha(commit.sha)}
              </span>
              <span className="min-w-0 flex-1 truncate">{commit.title}</span>
              {commit.author ? (
                <span className="flex-none text-muted-foreground">{commit.author}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ChecksPanel({ runs }: { runs?: PullRequestDetails['checkRuns'] }) {
  return (
    <div
      role="tabpanel"
      id="pr-panel-checks"
      aria-labelledby="pr-tab-checks"
      className="min-h-0 flex-1 overflow-auto"
    >
      {!runs || runs.length === 0 ? (
        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
          No checks have been reported yet.
        </p>
      ) : (
        <ul className="flex flex-col py-1">
          {runs.map((run) => (
            <li key={run.name} className="flex items-baseline gap-2 px-3 py-1.5 text-[12.5px]">
              <span className={`flex-none ${pullRequestCheckRunClass(run.state)}`}>
                {pullRequestCheckRunLabel(run.state)}
              </span>
              {run.url ? (
                <button
                  type="button"
                  onClick={() => {
                    const href = run.url
                    if (!href) return
                    void openUrl(href).catch(() => undefined)
                  }}
                  className="min-w-0 truncate text-left hover:underline"
                >
                  {run.name}
                </button>
              ) : (
                <span className="min-w-0 truncate">{run.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReviewsPanel({
  reviews,
  reviewDecision,
}: {
  reviews?: PullRequestDetails['reviews']
  reviewDecision: PullRequestDetails['reviewDecision']
}) {
  return (
    <div
      role="tabpanel"
      id="pr-panel-reviews"
      aria-labelledby="pr-tab-reviews"
      className="min-h-0 flex-1 overflow-auto px-3 py-3"
    >
      {!reviews || reviews.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          {reviewDecision === 'REVIEW_REQUIRED'
            ? 'This pull request still needs a review.'
            : 'No reviews yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {reviews.map((review, index) => (
            <li key={`${review.author}-${review.state}-${index}`} className="text-[12.5px]">
              <p>
                <span className="font-medium">{review.author}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {pullRequestReviewStateLabel(review.state)}
                </span>
              </p>
              {review.body?.trim() ? (
                <Markdown className="mt-1 text-[12.5px]">{review.body}</Markdown>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
