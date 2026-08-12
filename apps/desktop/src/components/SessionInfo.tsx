import type { SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import type { Connection } from '@/lib/connection'
import { CloseIcon, ServerIcon } from '@/components/icons'

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
        <ServerIcon size={15} />
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

    const focusable = () => {
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      return nodes ? Array.from(nodes) : []
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss.current()
        return
      }

      if (event.key !== 'Tab') return

      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        panel.current?.focus()
        return
      }

      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || active === panel.current)) {
        event.preventDefault()
        first.focus()
      }
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
            <CloseIcon size={14} />
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

        <dl className="px-4 py-3 text-[12.5px]" data-selectable>
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
