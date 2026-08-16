import type { CommitIdentity, DeviceRole } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { AgentIcon } from '@/components/AgentIcon'
import { ChevronDownIcon, RefreshIcon, ServerIcon, SettingsIcon } from '@/components/icons'
import type { SettingsCategory } from '@/screens/Settings'

/**
 * Who Dukebox is acting as, at the foot of the sidebar.
 *
 * The name and address shown here are the ones commits are authored with, so
 * this is not decoration: it answers "whose work will this look like?" without
 * opening a repository to check.
 *
 * The identity is a setting, so the menu's real jobs are showing who that is
 * and deep-linking into the settings categories that matter.
 */

export function UserMenu({
  user,
  role,
  onOpenSettings,
}: {
  user: CommitIdentity
  role: DeviceRole | null
  onOpenSettings: (category: SettingsCategory) => void
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

    const menu = root.current?.querySelector<HTMLElement>('[role="menu"]') ?? null

    const items = () => Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

    const highlight = (index: number) => {
      const list = items()
      list.forEach((item, i) => {
        if (i === index) item.setAttribute('data-highlighted', '')
        else item.removeAttribute('data-highlighted')
      })
      list[index]?.focus()
    }

    highlight(0)

    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
        return
      }

      const list = items()
      if (list.length === 0) return

      const current = list.findIndex((item) => item.hasAttribute('data-highlighted'))
      const from =
        current >= 0 ? current : list.findIndex((item) => item === document.activeElement)

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const start = from >= 0 ? from : event.key === 'ArrowDown' ? -1 : 0
        const delta = event.key === 'ArrowDown' ? 1 : -1
        highlight((start + delta + list.length) % list.length)
      } else if (event.key === 'Home') {
        event.preventDefault()
        highlight(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        highlight(list.length - 1)
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const openSettings = (category: SettingsCategory) => {
    setOpen(false)
    onOpenSettings(category)
  }

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
          <div className="truncate text-[11px] text-muted-foreground">
            {role === 'owner' ? 'Owner' : user.email}
          </div>
        </div>
        <ChevronDownIcon size={14} className="flex-none opacity-70" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          style={{ left: anchor.left + 8, bottom: anchor.bottom + 6 }}
          className="fixed z-50 w-60 overflow-hidden rounded-[calc(var(--radius)*0.9)] border border-border bg-background py-1 shadow-md"
        >
          <div className="px-3 pt-1.5 pb-1.5">
            <p className="truncate text-[13px] font-medium">{user.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
          </div>

          <div className="border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => openSettings('account')}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
            >
              <SettingsIcon size={14} className="flex-none text-muted-foreground" />
              Settings…
            </button>
            {role === 'owner' && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openSettings('agents')}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
                >
                  <span className="flex-none text-muted-foreground">
                    <AgentIcon agentId="opencode" className="size-3.5" />
                  </span>
                  Agents…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openSettings('devices')}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
                >
                  <ServerIcon size={14} className="flex-none text-muted-foreground" />
                  Devices…
                </button>
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => openSettings('servers')}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
            >
              <ServerIcon size={14} className="flex-none text-muted-foreground" />
              Servers…
            </button>
          </div>

          <div className="border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => openSettings('updates')}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
            >
              <RefreshIcon size={14} className="flex-none text-muted-foreground" />
              Updates…
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
