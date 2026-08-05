import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import type { Connection } from '../lib/connection.js'
import { filterProjects, filterSessions } from '../lib/searchSessions.js'
import { StatusDot } from '../screens/Session.js'

/**
 * Sessions, grouped by the repository they run against.
 *
 * A flat list stops working at two projects: the same branch names and similar
 * titles recur, and the only thing that tells them apart is which repository
 * they belong to.
 */

interface Props {
  connection: Connection
  projects: ProjectSummary[]
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
  onNewSession: () => void
}

export function Sidebar({
  connection,
  projects,
  sessions,
  selectedId,
  onSelect,
  onNewSession,
}: Props) {
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
      className="flex flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div className="px-2 pt-2.5 pb-1">
        {searching ? (
          <SearchField value={query} onChange={setQuery} onClose={closeSearch} />
        ) : (
          <>
            <SidebarAction icon={<PlusIcon />} onClick={onNewSession}>
              New session
            </SidebarAction>
            <SidebarAction icon={<SearchIcon />} onClick={() => setSearching(true)}>
              Search
            </SidebarAction>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-2">
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
              />
            ))}
          </>
        )}
      </div>

      {/* Which server this is. Dukebox is self-hosted and supports more than
          one, so it matters more than whose account is signed in. */}
      <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2.5 text-[12.5px]">
        <span className="size-1.5 flex-none rounded-full bg-done" />
        <div className="min-w-0">
          <div className="truncate font-medium">{connection.serverName}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {connection.address.host}
          </div>
        </div>
      </div>
    </nav>
  )
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
        <SearchIcon />
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
}: {
  project: ProjectSummary
  sessions: SessionSummary[]
  selectedId: string | null
  onSelect: (sessionId: string) => void
}) {
  return (
    <>
      <div className="flex items-center gap-2.5 px-4 py-1.5 text-[12.5px] text-muted-foreground">
        <BranchIcon />
        <span className="truncate">{project.repoFullName}</span>
      </div>

      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => onSelect(session.id)}
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

/* Drawn rather than typed: glyphs like ⌕ inherit the text size and render as
   specks beside a 14px label. */

function PlusIcon() {
  return (
    <svg
      className="size-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      className="size-4"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="M10.4 10.4 13.5 13.5" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg
      className="size-3.25 flex-none opacity-70"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="6.5" r="1.6" />
      <path d="M4.5 5.6v4.8M6.1 6.5h2.6a1.2 1.2 0 0 1 1.2 1.2v.5" />
    </svg>
  )
}
