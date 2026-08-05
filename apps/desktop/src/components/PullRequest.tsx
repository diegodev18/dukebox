import type { SessionSummary } from '@dukebox/protocol'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState } from 'react'
import type { DukeboxClient } from '../lib/client.js'

/**
 * Opening a pull request, and getting back to one already open.
 *
 * The same control does both, because they are the same question asked at
 * different times: where did this work end up. A session that has one shows a
 * link; a session that does not shows the button that makes one.
 *
 * The server pushes the branch and calls GitHub — the container never holds a
 * token that could.
 */

interface Props {
  client: DukeboxClient
  session: SessionSummary
  /**
   * How many files the live stream has seen change.
   *
   * The summary's own count only refreshes when the server sends a new one, so
   * a session that just edited its first file still reports zero — and the
   * button that appears on that count would never appear.
   */
  changedFiles: number
  /** Records the URL so the button becomes a link without a refetch. */
  onOpened: (url: string) => void
}

type State = { kind: 'idle' } | { kind: 'opening' } | { kind: 'failed'; message: string }

export function PullRequest({ client, session, changedFiles, onOpened }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })

  if (session.pullRequestUrl) {
    return <Link url={session.pullRequestUrl} />
  }

  // Nothing to propose until the agent has changed something. The live count
  // leads because the summary's lags a running session by a whole turn.
  if (Math.max(changedFiles, session.changedFileCount) === 0) return null

  const open = async () => {
    setState({ kind: 'opening' })

    try {
      const { url } = await client.openPullRequest(session.id)
      onOpened(url)
      setState({ kind: 'idle' })
      await openUrl(url).catch(() => undefined)
    } catch (error) {
      // The server refuses for reasons worth reading: GitHub not configured,
      // nothing committed, a branch that never pushed.
      setState({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not open a pull request.',
      })
    }
  }

  return (
    <div className="flex items-center gap-2">
      {state.kind === 'failed' && (
        <span role="alert" className="text-[12px] text-destructive">
          {state.message}
        </span>
      )}

      <button
        onClick={() => void open()}
        disabled={state.kind === 'opening'}
        className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted disabled:opacity-50"
      >
        <BranchIcon />
        {state.kind === 'opening' ? 'Opening…' : 'Open pull request'}
      </button>
    </div>
  )
}

function Link({ url }: { url: string }) {
  return (
    <button
      onClick={() => void openUrl(url).catch(() => undefined)}
      className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-muted"
    >
      <BranchIcon />
      View pull request
    </button>
  )
}

function BranchIcon() {
  return (
    <svg
      className="size-3.25 text-muted-foreground"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="6" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.75c0 2-1.6 3-3.5 3.25" />
    </svg>
  )
}
