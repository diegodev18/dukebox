import type { ReactNode } from 'react'
import type { Update } from '@/lib/updater'
import type { UpdateState } from '@/lib/useUpdate'

/**
 * The strip that tells the user a newer Dukebox exists.
 *
 * Drawn across the top of the window, above whatever screen the app is on —
 * an update is a property of the app, not of the server it happens to be
 * looking at, so pairing and session screens both get it. It is the whole
 * answer to "how do I update": when there is something to download the strip
 * carries the button that downloads and restarts into it.
 *
 * Most states render nothing. The exceptions are when there is something to
 * say, or something the user just asked for ("You're up to date") and deserves
 * an answer rather than silence.
 */

interface Props {
  state: UpdateState
  /** False until the launch check has answered, so it cannot flash. */
  checked: boolean
  /** True while the user's dismissal of an offered update is in force. */
  dismissed: boolean
  /** True briefly after a manual check that found nothing. */
  announcing: boolean
  onInstall: (update: Update) => void
  /** Re-ask the feed, e.g. "Try again" after a failed install. */
  onRecheck: () => void
  onDismiss: () => void
}

export function UpdateBanner({
  state,
  checked,
  dismissed,
  announcing,
  onInstall,
  onRecheck,
  onDismiss,
}: Props) {
  if (state.status === 'up-to-date' && !announcing) return null
  if (state.status === 'checking' && !checked) return null
  if (state.status === 'available' && dismissed) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 border-b border-border bg-surface px-4.5 py-1.5 text-[12.5px]"
    >
      <UpdateIcon />
      <p
        title={state.status === 'available' ? (state.update.body ?? undefined) : undefined}
        className="min-w-0 flex-1 truncate"
      >
        {copy(state)}
      </p>
      {actions(state, onInstall, onRecheck, onDismiss)}
    </div>
  )
}

function copy(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Dukebox ${state.update.version} is available.`
    case 'downloading':
      return downloading(state.progress.received, state.progress.total)
        ? `Downloading Dukebox ${state.version}… ${percent(state.progress.received, state.progress.total)}%`
        : `Downloading Dukebox ${state.version}…`
    case 'error':
      return `Could not update: ${state.message}`
    case 'up-to-date':
      return 'You’re up to date.'
  }
}

function actions(
  state: UpdateState,
  onInstall: (update: Update) => void,
  onRecheck: () => void,
  onDismiss: () => void,
): ReactNode {
  switch (state.status) {
    case 'available':
      return (
        <>
          <button
            type="button"
            onClick={() => onInstall(state.update)}
            className="flex-none rounded-[calc(var(--radius)*0.6)] bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90"
          >
            Update &amp; restart
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="flex-none rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 font-medium hover:bg-muted"
          >
            Later
          </button>
        </>
      )
    case 'downloading':
      return <span className="flex-none text-muted-foreground">Downloading…</span>
    case 'error':
      return (
        <>
          <button
            type="button"
            onClick={onRecheck}
            className="flex-none rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 font-medium hover:bg-muted"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="flex-none rounded-[calc(var(--radius)*0.6)] px-2 py-1 text-muted-foreground hover:bg-muted"
          >
            Dismiss
          </button>
        </>
      )
    case 'checking':
    case 'up-to-date':
      return null
  }
}

/** A progress bar only has something to show once a byte has arrived. */
function downloading(received: number, total: number | null): boolean {
  return total !== null && received > 0
}

function percent(received: number, total: number | null): number {
  if (total === null || total === 0) return 0
  return Math.min(100, Math.round((received / total) * 100))
}

function UpdateIcon() {
  return (
    <svg
      className="size-3.5 flex-none text-muted-foreground"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3v6.5" />
      <path d="M5.5 7 8 9.5 10.5 7" />
      <path d="M3 12.5h10" />
    </svg>
  )
}
