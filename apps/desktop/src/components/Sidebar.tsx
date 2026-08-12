import { type CommitIdentity, type ProjectSummary, type SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import { filterProjects, filterSessions } from '@/lib/searchSessions'
import { StatusDot } from '@/screens/Session'
import { BranchIcon, PlusIcon, SearchIcon, SettingsIcon } from '@/components/icons'
import { UserMenu } from '@/components/UserMenu'

/**
 * Sessions, grouped by the repository they run against.
 *
 * A flat list stops working at two projects: the same branch names and similar
 * titles recur, and the only thing that tells them apart is which repository
 * they belong to.
 */

interface Props {
  projects: ProjectSummary[]
  sessions: SessionSummary[]
  selectedId: string | null
  /** Who commits are authored as — the identity from settings, if configured. */
  identity: CommitIdentity
  onCheckForUpdates: () => void
  onOpenSettings: () => void
  onOpenOpencodeProviders: () => void
  onSelect: (sessionId: string) => void
  onNewSession: () => void
  onConfigureEnvironment: (projectId: string) => void
  onManageEnvironments: (projectId: string) => void
  onArchive: (sessionId: string) => void
  /** Set when an archive request failed; the row stays put. */
  archiveError?: string | null
}

export function Sidebar({
  projects,
  sessions,
  selectedId,
  identity,
  onCheckForUpdates,
  onOpenSettings,
  onOpenOpencodeProviders,
  onSelect,
  onNewSession,
  onConfigureEnvironment,
  onManageEnvironments,
  onArchive,
  archiveError,
}: Props) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  const visibleSessions = filterSessions(query, sessions, projects)
  const visibleProjects = filterProjects(query, projects, sessions)
  const filtering = searching && query.trim() !== ''

  const closeSearch = () => {
    setSearching(false)
    setQuery('')
  }

  return (
    <nav
      aria-label="Sessions"
      className="flex min-h-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div className="px-2 pt-2.5 pb-1">
        {searching ? (
          <SearchField value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <>
            <SidebarAction icon={<PlusIcon size={16} />} onClick={onNewSession}>
              New session
            </SidebarAction>
            <SidebarAction icon={<SearchIcon size={16} />} onClick={() => setSearching(true)}>
              Search
            </SidebarAction>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {projects.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">
            No projects yet. Connect a repository to start.
          </p>
        ) : filtering && visibleSessions.length === 0 ? (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">
            No sessions match “{query.trim()}”.
          </p>
        ) : (
          <>
            <p className="px-4 pt-3.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Projects
            </p>

            {visibleProjects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                sessions={visibleSessions.filter((session) => session.projectId === project.id)}
                selectedId={selectedId}
                onSelect={(sessionId) => {
                  onSelect(sessionId)
                  // A pick from search is a destination, not a filter to keep
                  // applying — clear it so the full list returns underneath.
                  if (searching) closeSearch()
                }}
                onConfigureEnvironment={() => onConfigureEnvironment(project.id)}
                onManageEnvironments={() => onManageEnvironments(project.id)}
                onContextMenu={(sessionId, event) => {
                  event.preventDefault()
                  setMenu({ sessionId, x: event.clientX, y: event.clientY })
                }}
              />
            ))}
          </>
        )}
      </div>

      {archiveError && (
        <p role="alert" className="px-4 py-2 text-[12.5px] text-destructive">
          {archiveError}
        </p>
      )}

      {/* Who the work is attributed to. Which server it runs on lives in the
          session header instead: that question is per session and only worth
          room when asked, not permanently at the foot of the sidebar. */}
      <div className="flex items-stretch border-t border-border">
        <div className="min-w-0 flex-1">
          <UserMenu
            user={identity}
            onCheckForUpdates={onCheckForUpdates}
            onOpenSettings={onOpenSettings}
            onOpenOpencodeProviders={onOpenOpencodeProviders}
          />
        </div>
        <button
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
          className="grid w-10 flex-none place-items-center self-stretch text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {menu && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          onArchive={() => {
            onArchive(menu.sessionId)
            setMenu(null)
          }}
          onDismiss={() => setMenu(null)}
        />
      )}
    </nav>
  )
}

interface ContextMenuState {
  sessionId: string
  x: number
  y: number
}

function SearchField({
  value,
  onChange,
  onClose,
}: {
  value: string
  onChange: (value: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className="flex items-center gap-1.5 rounded-[calc(var(--radius)*0.7)] border border-border-strong bg-background px-2 py-1">
      <span className="text-muted-foreground">
        <SearchIcon size={14} />
      </span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          }
        }}
        placeholder="Search sessions"
        aria-label="Search sessions"
        className="min-w-0 flex-1 bg-transparent py-0.5 text-[13px] outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="rounded px-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        Esc
      </button>
    </div>
  )
}

function ProjectGroup({
  project,
  sessions,
  selectedId,
  onSelect,
  onConfigureEnvironment,
  onManageEnvironments,
  onContextMenu,
}: {
  project: ProjectSummary
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  onConfigureEnvironment: () => void
  onManageEnvironments: () => void
  onContextMenu: (sessionId: string, event: React.MouseEvent) => void
}) {
  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-1.5 text-[12.5px] text-muted-foreground">
        <BranchIcon size={13} className="flex-none opacity-70" />
        <span className="min-w-0 flex-1 truncate">{project.repoFullName}</span>
        {/* One affordance, two jobs: with nothing configured the useful action
            is to run setup, and once environments exist it is to manage the
            list. Showing both would put two links in a 236px row. */}
        {project.environmentCount === 0 ? (
          <button
            type="button"
            onClick={onConfigureEnvironment}
            className="shrink-0 text-[11px] text-foreground underline-offset-2 hover:underline"
          >
            Set up
          </button>
        ) : (
          <button
            type="button"
            onClick={onManageEnvironments}
            aria-label={`Environments for ${project.repoFullName}`}
            className="shrink-0 text-[11px] text-foreground underline-offset-2 hover:underline"
          >
            Environments
          </button>
        )}
      </div>

      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => onSelect(session.id)}
          onContextMenu={(event) => onContextMenu(session.id, event)}
          aria-current={session.id === selectedId}
          className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2.5 py-1.5 pr-4 pl-7.5 text-left text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
        >
          <StatusDot status={session.status} />
          <span className="truncate">{session.title}</span>
          <span className="text-[11.5px] tabular-nums opacity-75">{age(session.updatedAt)}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Right-click menu for a session row.
 *
 * Positioned at the pointer rather than anchored to the row: a sidebar is too
 * narrow for a menu that grows beside the item that opened it.
 */
function SessionContextMenu({
  x,
  y,
  onArchive,
  onDismiss,
}: {
  x: number
  y: number
  onArchive: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  const archive = useRef(onArchive)
  const [confirming, setConfirming] = useState(false)
  dismiss.current = onDismiss
  archive.current = onArchive

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss.current()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss.current()
    }

    // Capture so a click that would also select another session still closes
    // this first, rather than leaving a menu stranded over a new selection.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Session"
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-36 rounded-[calc(var(--radius)*0.7)] border border-border bg-background py-1 shadow-md"
    >
      {confirming ? (
        <>
          <p className="px-3 py-1.5 text-[12px] text-muted-foreground">Archive this session?</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => archive.current()}
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted"
          >
            Archive
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dismiss.current()}
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          onClick={() => setConfirming(true)}
          className="flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted"
        >
          Archive
        </button>
      )}
    </div>
  )
}

function SidebarAction({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Without a handler this is decoration. Dimming it says so, rather than
      // offering a button that quietly does nothing.
      disabled={!onClick}
      className="flex w-full items-center gap-2.5 rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 font-medium hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span className="text-muted-foreground">{icon}</span>
      {children}
    </button>
  )
}

/**
 * How long ago, in as few characters as fit the sidebar.
 *
 * Exact times belong in the transcript; here the question is only whether
 * something is current.
 */
function age(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))

  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
