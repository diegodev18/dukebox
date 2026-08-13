import type { FileChange, PullRequestSummary, SessionSummary } from '@dukebox/protocol'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'
import type { DukeboxClient } from '@/lib/client'
import { Diff, changeCounts } from '@/components/Diff'
import { BranchIcon, ChevronDownIcon, ChevronRightIcon, FileIcon } from '@/components/icons'
import { PullRequestStatusIcon } from '@/components/PullRequestStatusIcon'
import { pullRequestStatus, pullRequestStatusLabel } from '@/lib/pullRequest'

/**
 * The workspace tab for a session's pull request.
 *
 * Opening, marking ready, and merging all happen here — the session header
 * does not carry a second control for the same thing.
 */

export interface PullRequestTab {
  client: DukeboxClient
  onUpdated: (patch: { pullRequestUrl: string; pullRequest: PullRequestSummary }) => void
}

interface Props {
  client: DukeboxClient
  session: SessionSummary
  files: FileChange[]
  onUpdated: PullRequestTab['onUpdated']
}

type Action =
  { kind: 'idle' } | { kind: 'working'; verb: string } | { kind: 'failed'; message: string }

export function PullRequestPanel({ client, session, files, onUpdated }: Props) {
  const [action, setAction] = useState<Action>({ kind: 'idle' })
  const [confirmMerge, setConfirmMerge] = useState(false)
  const pr = session.pullRequest

  const run = async (verb: string, work: () => Promise<PullRequestSummary>) => {
    setAction({ kind: 'working', verb })
    setConfirmMerge(false)
    try {
      const next = await work()
      onUpdated({ pullRequestUrl: next.url, pullRequest: next })
      setAction({ kind: 'idle' })
    } catch (error) {
      setAction({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'The pull request action failed.',
      })
    }
  }

  return (
    <div
      role="tabpanel"
      id="workspace-panel-pr"
      aria-labelledby="workspace-tab-pr"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-border px-3 py-2.5">
        {pr ? (
          <>
            <div className="flex items-start gap-2">
              <BranchIcon size={13} className="mt-0.5 flex-none text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{pr.title || 'Pull request'}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  <StatusBadge pr={pr} />
                </p>
              </div>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {pr.state === 'open' && pr.isDraft && (
                <button
                  type="button"
                  disabled={action.kind === 'working'}
                  onClick={() => void run('ready', () => client.markPullRequestReady(session.id))}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  {action.kind === 'working' && action.verb === 'ready'
                    ? 'Marking ready…'
                    : 'Ready for review'}
                </button>
              )}

              {pr.state === 'open' && !pr.isDraft && !confirmMerge && (
                <button
                  type="button"
                  disabled={action.kind === 'working'}
                  onClick={() => setConfirmMerge(true)}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
                >
                  Merge
                </button>
              )}

              {confirmMerge && (
                <button
                  type="button"
                  disabled={action.kind === 'working'}
                  onClick={() => void run('merge', () => client.mergePullRequest(session.id))}
                  className="rounded-[calc(var(--radius)*0.6)] border border-destructive px-2.5 py-1 text-[12.5px] font-medium text-destructive hover:bg-muted disabled:opacity-50"
                >
                  {action.kind === 'working' && action.verb === 'merge'
                    ? 'Merging…'
                    : 'Confirm merge'}
                </button>
              )}

              <button
                type="button"
                onClick={() => void openUrl(pr.url).catch(() => undefined)}
                className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] text-muted-foreground hover:text-foreground"
              >
                View on GitHub
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] font-medium">Pull request</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Opens a draft from this session's branch.
            </p>
            <button
              type="button"
              disabled={action.kind === 'working'}
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
          </p>
        )}
      </div>

      <PrDiffs files={files} />
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

function PrDiffs({ files }: { files: FileChange[] }) {
  const [open, setOpen] = useState<string | null>(files[0]?.path ?? null)

  if (files.length === 0) {
    return (
      <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
        Diffs appear here once the agent changes files.
      </p>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {files.map((file) => {
        const expanded = open === file.path
        const counts = changeCounts(file.before, file.after)

        return (
          <div key={file.path} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : file.path)}
              aria-expanded={expanded}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted"
            >
              {expanded ? (
                <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
              ) : (
                <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
              )}
              <FileIcon size={13} className="flex-none text-muted-foreground" />
              <span className="truncate font-medium">{file.path.split('/').pop()}</span>
              <span className="ml-auto flex-none font-mono text-[11px] text-muted-foreground">
                +{counts.added} −{counts.removed}
              </span>
            </button>
            {expanded && (
              <div className="px-2 pb-2">
                <Diff file={file} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
