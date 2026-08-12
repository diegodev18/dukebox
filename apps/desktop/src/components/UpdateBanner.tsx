import type { ReactNode } from 'react'
import type { Update } from '@/lib/updater'
import type { UpdateState } from '@/lib/useUpdate'
import { DownloadIcon } from '@/components/icons'

/**
 * The update notification, as a toast.
 *
 * Drawn over the bottom-right corner of whatever screen the app is on — an
 * update is a property of the app, not of the server it happens to look at,
 * so pairing and session screens both get it. Being a toast rather than a
 * strip means it never reshapes the layout: it appears on top, and disappears
 * without leaving a gap.
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

  const controls = actions(state, onInstall, onRecheck, onDismiss)

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex w-80 items-start gap-3 rounded-[calc(var(--radius)*0.9)] border border-border bg-background p-3.5 shadow-lg"
    >
      <span className="mt-0.5 flex-none text-muted-foreground">
        <DownloadIcon size={16} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug">{copy(state)}</p>
        {controls && <div className="mt-2.5 flex items-center gap-1.5">{controls}</div>}
      </div>
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
      return (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${percent(state.progress.received, state.progress.total)}%` }}
          />
        </div>
      )
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
