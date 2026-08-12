import type { SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import type { Connection } from '@/lib/connection'

/**
 * Where this session actually runs, on demand.
 *
 * The server used to sit permanently at the foot of the sidebar, which spent
 * room on something that only matters when you go looking for it — and, being
 * global, said nothing about the session in front of you. Here the same
 * question is answered per session, from the session's own header.
 *
 * A dialog rather than a popover: these are values you read carefully and copy
 * out — a session id, a branch name — and a menu that closes the moment focus
 * drifts is the wrong container for that.
 */

export function SessionInfo({
  session,
  connection,
}: {
  session: SessionSummary
  connection: Connection
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Session details"
        title="Session details"
        onClick={() => setOpen(true)}
        className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <ServerIcon />
      </button>

      {open && (
        <SessionInfoDialog
          session={session}
          connection={connection}
          onDismiss={() => setOpen(false)}
        />
      )}
    </>
  )
}

function SessionInfoDialog({
  session,
  connection,
  onDismiss,
}: {
  session: SessionSummary
  connection: Connection
  onDismiss: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    // Focus moves into the dialog so Escape reaches it and the reader is not
    // left with focus stranded on a button behind the backdrop.
    panel.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss.current()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      // Fixed to the viewport: the session column clips its overflow, so a
      // dialog laid out inside it would be cropped rather than centred.
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-info-title"
        tabIndex={-1}
        className="w-full max-w-sm overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background shadow-lg outline-none"
      >
        <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
          <h2 id="session-info-title" className="min-w-0 flex-1 truncate font-medium">
            {session.title}
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="-mt-0.5 grid size-6 flex-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="size-1.5 flex-none rounded-full bg-done" />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{connection.serverName}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {connection.address.host}
            </div>
          </div>
        </div>

        <dl className="px-4 py-3 text-[12.5px]">
          <Row label="Session">
            <span className="font-mono text-[11.5px] break-all">{session.id}</span>
          </Row>
          <Row label="Branch">
            <span className="font-mono text-[11.5px] break-all">{session.branch}</span>
          </Row>
          <Row label="Base">
            <span className="font-mono text-[11.5px] break-all">{session.baseBranch}</span>
          </Row>
          <Row label="Agent">{session.agentId}</Row>
          <Row label="Started">{startedAt(session.createdAt)}</Row>
        </dl>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/**
 * Absolute rather than relative.
 *
 * The sidebar already answers "how recent is this?"; opening the details is
 * usually about pinning down exactly when something ran.
 */
function startedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function ServerIcon() {
  return (
    <svg
      className="size-3.75"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="8.5" width="11" height="4.5" rx="1" />
      <path d="M5 5.25h.01M5 10.75h.01" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      className="size-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  )
}
