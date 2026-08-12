import { DEFAULT_COMMIT_IDENTITY, type CommitIdentity } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'

/**
 * Who Dukebox is acting as, at the foot of the sidebar.
 *
 * The name and address shown here are the ones commits are authored with, so
 * this is not decoration: it answers "whose work will this look like?" without
 * opening a repository to check.
 *
 * Switching accounts is drawn but inert. The list is a placeholder until the
 * settings panel exists — the shape of the interaction is worth settling now,
 * the storage behind it is not.
 */

export const AVAILABLE_USERS: CommitIdentity[] = [DEFAULT_COMMIT_IDENTITY]

export function UserMenu({
  user,
  onCheckForUpdates,
}: {
  user: CommitIdentity
  onCheckForUpdates: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 })

  // Positioned against the viewport rather than the button it hangs from. The
  // sidebar clips its overflow and paints below the column beside it, so a menu
  // laid out inside the flow is cropped at the sidebar's edge and covered by
  // the transcript — which is exactly where this one needs to escape to.
  useEffect(() => {
    if (!open) return

    const place = () => {
      const box = trigger.current?.getBoundingClientRect()
      if (box) setAnchor({ left: box.left, bottom: window.innerHeight - box.top })
    }

    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[12.5px] hover:bg-muted"
      >
        <Avatar name={user.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{user.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>
        </div>
        <ChevronIcon />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          style={{ left: anchor.left + 8, bottom: anchor.bottom + 6 }}
          className="fixed z-50 w-60 overflow-hidden rounded-[calc(var(--radius)*0.9)] border border-border bg-background py-1 shadow-md"
        >
          <p className="px-3 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Accounts
          </p>

          {AVAILABLE_USERS.map((candidate) => (
            <button
              key={candidate.email}
              type="button"
              role="menuitemradio"
              aria-checked={candidate.email === user.email}
              // Inert until accounts are stored somewhere. Closing the menu is
              // the whole interaction: picking the account already in use is
              // not a change, and there is nothing else to pick yet.
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-muted"
            >
              <Avatar name={candidate.name} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{candidate.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {candidate.email}
                </span>
              </span>
              {candidate.email === user.email && <CheckIcon />}
            </button>
          ))}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              disabled
              className="w-full px-3 py-1.5 text-left text-[13px] opacity-40"
            >
              Add account…
            </button>
          </div>

          <div className="border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onCheckForUpdates()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted"
            >
              <RefreshIcon />
              Check for updates…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Initials, so the row reads as an account without loading an avatar. */
function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span className="grid size-6 flex-none place-items-center rounded-full bg-muted text-[10.5px] font-semibold text-muted-foreground">
      {initials}
    </span>
  )
}

function ChevronIcon() {
  return (
    <svg
      className="size-3.5 flex-none opacity-70"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4.5 9.5 8 6l3.5 3.5" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      className="size-3.5 flex-none"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  )
}

function RefreshIcon() {
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
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 1.5v3h-3" />
    </svg>
  )
}
