import {
  type CommitIdentity,
  type DeviceRole,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ThinkingOrb } from 'thinking-orbs'
import { pullRequestStatus, pullRequestStatusAriaLabel } from '@/lib/pullRequest'
import { relativeAge } from '@/lib/relativeTime'
import {
  loadViewedSessions,
  markViewed,
  sessionNavIndicator,
  type ViewedSessions,
} from '@/lib/viewedSessions'
import { statusLabel } from '@/screens/Session'
import type { SettingsCategory } from '@/screens/Settings'
import { agentLabel } from '@/components/AgentIcon'
import { DukeMark, DukeWordmark } from '@/components/Duke'
import { PullRequestStatusIcon } from '@/components/PullRequestStatusIcon'
import {
  AlertIcon,
  BookOpenIcon,
  BranchIcon,
  CloseIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from '@/components/icons'
import { UserMenu } from '@/components/UserMenu'

/** Pause before the truncated row shows its full name, branch, agent, and server. */
const SESSION_NAV_TOOLTIP_DELAY_MS = 400

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
  /** The paired server these sessions run on. */
  serverName: string
  role: DeviceRole | null
  onOpenSettings: (category: SettingsCategory) => void
  onSelect: (sessionId: string) => void
  onNewSession: (projectId?: string) => void
  onConfigureEnvironment: (projectId: string) => void
  onManageEnvironments: (projectId: string) => void
  onArchive: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onRemoveProject: (projectId: string) => void
  onSearch: () => void
  /** Set when an archive or remove request failed; the row stays put. */
  archiveError?: string | null
  /** Creating, archiving, and environment setup talk to the server. */
  disabled?: boolean
}

export function Sidebar({
  projects,
  sessions,
  selectedId,
  identity,
  serverName,
  role,
  onOpenSettings,
  onSelect,
  onNewSession,
  onConfigureEnvironment,
  onManageEnvironments,
  onArchive,
  onDelete,
  onRemoveProject,
  onSearch,
  archiveError,
  disabled = false,
}: Props) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [removing, setRemoving] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [viewed, setViewed] = useState(() => {
    const stored = loadViewedSessions()
    if (!selectedId) return stored
    const selected = sessions.find((session) => session.id === selectedId)
    if (!selected) return stored
    return markViewed(stored, selected.id, selected.lastSeq)
  })

  useEffect(() => {
    if (!selectedId) return
    const selected = sessions.find((session) => session.id === selectedId)
    if (!selected) return
    setViewed((current) => markViewed(current, selected.id, selected.lastSeq))
  }, [selectedId, sessions])

  return (
    <nav
      aria-label="Sessions"
      className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div className="px-3 pt-3 pb-1">
        <DukeWordmark />
      </div>

      <div className="px-2 pb-1">
        <SidebarAction
          icon={<PlusIcon size={16} />}
          {...(disabled ? {} : { onClick: () => onNewSession() })}
        >
          New session
        </SidebarAction>
        <SidebarAction icon={<SearchIcon size={16} />} onClick={onSearch}>
          Search
        </SidebarAction>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {projects.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <DukeMark size={48} className="mx-auto opacity-90" />
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              No projects yet. Connect a repository to start.
            </p>
          </div>
        ) : (
          <>
            <p className="px-4 pt-3.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Projects
            </p>

            {projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                sessions={sessions.filter((session) => session.projectId === project.id)}
                selectedId={selectedId}
                viewed={viewed}
                serverName={serverName}
                onSelect={onSelect}
                onConfigureEnvironment={() => onConfigureEnvironment(project.id)}
                onManageEnvironments={() => onManageEnvironments(project.id)}
                disabled={disabled}
                onOpenSessionMenu={(sessionId, x, y) => {
                  if (disabled) return
                  setMenu({ kind: 'session', sessionId, x, y })
                }}
                onOpenProjectMenu={(x, y) => {
                  if (disabled) return
                  setMenu({ kind: 'project', projectId: project.id, x, y })
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
          <UserMenu user={identity} role={role} onOpenSettings={onOpenSettings} />
        </div>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => onOpenSettings('account')}
          className="grid w-10 flex-none place-items-center self-stretch text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {menu?.kind === 'session' && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          onArchive={() => {
            onArchive(menu.sessionId)
            setMenu(null)
          }}
          onDelete={() => {
            const session = sessions.find((candidate) => candidate.id === menu.sessionId)
            setMenu(null)
            if (session) setDeleting(session)
          }}
          onDismiss={() => setMenu(null)}
        />
      )}

      {menu?.kind === 'project' && (
        <ProjectContextMenu
          x={menu.x}
          y={menu.y}
          hasEnvironments={
            (projects.find((project) => project.id === menu.projectId)?.environmentCount ?? 0) > 0
          }
          onNewSession={() => {
            onNewSession(menu.projectId)
            setMenu(null)
          }}
          onEnvironments={() => {
            const project = projects.find((candidate) => candidate.id === menu.projectId)
            if (project && project.environmentCount === 0) onConfigureEnvironment(project.id)
            else onManageEnvironments(menu.projectId)
            setMenu(null)
          }}
          onOpenGitHub={() => {
            const project = projects.find((candidate) => candidate.id === menu.projectId)
            if (project) openGitHub(project.repoFullName)
            setMenu(null)
          }}
          onRemove={() => {
            const project = projects.find((candidate) => candidate.id === menu.projectId)
            setMenu(null)
            if (project) setRemoving(project)
          }}
          onDismiss={() => setMenu(null)}
        />
      )}

      {removing && (
        <ConfirmDeleteDialog
          title={`Remove ${removing.repoFullName}?`}
          description="This removes the project and its sessions from Dukebox. Nothing on GitHub is touched."
          typedLabel={removing.repoFullName}
          confirmLabel="Remove"
          onConfirm={() => {
            onRemoveProject(removing.id)
            setRemoving(null)
          }}
          onDismiss={() => setRemoving(null)}
        />
      )}

      {deleting && (
        <ConfirmDeleteDialog
          title="Delete this session?"
          description="This permanently deletes the session and its transcript from Dukebox. It cannot be undone."
          typedLabel={deleting.title}
          confirmLabel="Delete"
          onConfirm={() => {
            onDelete(deleting.id)
            setDeleting(null)
          }}
          onDismiss={() => setDeleting(null)}
        />
      )}
    </nav>
  )
}

type ContextMenuState =
  | { kind: 'session'; sessionId: string; x: number; y: number }
  | { kind: 'project'; projectId: string; x: number; y: number }

function openGitHub(repoFullName: string) {
  const url = `https://github.com/${repoFullName}`
  void openUrl(url).catch(() => {
    window.open(url, '_blank', 'noopener,noreferrer')
  })
}

/**
 * A long list under one repository buries the others. Five recent sessions
 * are enough to scan; More reveals the rest, Less folds it back.
 */
const SIDEBAR_SESSION_LIMIT = 5

function ProjectGroup({
  project,
  sessions,
  selectedId,
  viewed,
  serverName,
  onSelect,
  onConfigureEnvironment,
  onManageEnvironments,
  onOpenSessionMenu,
  onOpenProjectMenu,
  disabled = false,
}: {
  project: ProjectSummary
  sessions: SessionSummary[]
  selectedId: string | null
  viewed: ViewedSessions
  serverName: string
  onSelect: (sessionId: string) => void
  onConfigureEnvironment: () => void
  onManageEnvironments: () => void
  onOpenSessionMenu: (sessionId: string, x: number, y: number) => void
  onOpenProjectMenu: (x: number, y: number) => void
  disabled?: boolean
}) {
  const selectedIndex = sessions.findIndex((session) => session.id === selectedId)
  const [expanded, setExpanded] = useState(() => selectedIndex >= SIDEBAR_SESSION_LIMIT)
  const canCollapse = sessions.length > SIDEBAR_SESSION_LIMIT
  const visible = expanded || !canCollapse ? sessions : sessions.slice(0, SIDEBAR_SESSION_LIMIT)

  // Opening a session that sits past the fold (search, a deep link) should
  // expand this group so the current row is on screen. Collapsing while that
  // row is still selected is allowed — the person asked to see less.
  useEffect(() => {
    if (selectedIndex >= SIDEBAR_SESSION_LIMIT) setExpanded(true)
  }, [selectedId, selectedIndex])

  return (
    <>
      <div
        className="flex items-center gap-2.5 px-4 py-1.5 text-[12.5px] text-muted-foreground"
        onContextMenu={(event) => {
          event.preventDefault()
          onOpenProjectMenu(event.clientX, event.clientY)
        }}
      >
        <BranchIcon size={13} className="flex-none opacity-70" />
        <span className="min-w-0 flex-1 truncate">{project.repoFullName}</span>
        {/* One affordance, two jobs: with nothing configured the useful action
            is to run setup, and once environments exist it is to manage the
            list. Showing both would put two links in a narrow nav row. */}
        {project.environmentCount === 0 ? (
          <button
            type="button"
            onClick={onConfigureEnvironment}
            disabled={disabled}
            className="shrink-0 text-[11px] text-foreground underline-offset-2 hover:underline disabled:opacity-40 disabled:hover:no-underline"
          >
            Set up
          </button>
        ) : (
          <button
            type="button"
            onClick={onManageEnvironments}
            disabled={disabled}
            aria-label={`Environments for ${project.repoFullName}`}
            className="shrink-0 text-[11px] text-foreground underline-offset-2 hover:underline disabled:opacity-40 disabled:hover:no-underline"
          >
            Environments
          </button>
        )}
      </div>

      {visible.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          selected={session.id === selectedId}
          viewedSeq={viewed[session.id]}
          serverName={serverName}
          disabled={disabled}
          onSelect={() => onSelect(session.id)}
          onOpenMenu={(x, y) => onOpenSessionMenu(session.id, x, y)}
        />
      ))}
      {canCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="w-full py-1 pr-8 pl-7.5 text-left text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </>
  )
}

/**
 * One session in the nav.
 *
 * The 236px column truncates the title and has no room for the branch, agent,
 * or server. Those details appear on hover, portaled out of the scrolling list
 * so the sidebar's overflow does not clip them.
 */
function SessionRow({
  session,
  selected,
  viewedSeq,
  serverName,
  disabled,
  onSelect,
  onOpenMenu,
}: {
  session: SessionSummary
  selected: boolean
  viewedSeq: number | undefined
  serverName: string
  disabled: boolean
  onSelect: () => void
  onOpenMenu: (x: number, y: number) => void
}) {
  const [tooltip, setTooltip] = useState<{ top: number; left: number } | null>(null)
  const showTimer = useRef(0)
  const tooltipId = `session-nav-tooltip-${session.id}`

  const hideTooltip = () => {
    window.clearTimeout(showTimer.current)
    setTooltip(null)
  }

  const scheduleTooltip = (node: HTMLElement) => {
    window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(() => {
      const rect = node.getBoundingClientRect()
      setTooltip({ top: rect.top, left: rect.right + 8 })
    }, SESSION_NAV_TOOLTIP_DELAY_MS)
  }

  useEffect(() => () => window.clearTimeout(showTimer.current), [])

  useEffect(() => {
    if (!tooltip) return
    const hide = () => hideTooltip()
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [tooltip])

  return (
    <div
      className="group relative"
      onMouseEnter={(event) => scheduleTooltip(event.currentTarget)}
      onMouseLeave={hideTooltip}
    >
      <button
        type="button"
        onClick={onSelect}
        onFocus={(event) =>
          scheduleTooltip(event.currentTarget.parentElement ?? event.currentTarget)
        }
        onBlur={hideTooltip}
        onContextMenu={(event) => {
          event.preventDefault()
          hideTooltip()
          onOpenMenu(event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') return
          event.preventDefault()
          hideTooltip()
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenMenu(rect.left, rect.bottom)
        }}
        aria-current={selected}
        aria-label={sessionRowLabel(session, viewedSeq)}
        aria-describedby={tooltip ? tooltipId : undefined}
        className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2.5 py-1.5 pr-8 pl-7.5 text-left text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=true]:bg-muted aria-[current=true]:text-foreground"
      >
        <SessionNavIndicator
          status={session.status}
          lastSeq={session.lastSeq}
          viewedSeq={viewedSeq}
        />
        <span className="truncate">{session.title}</span>
        <span className="flex items-center gap-1.5">
          {session.pullRequest ? (
            <PullRequestStatusIcon pr={session.pullRequest} size={12} />
          ) : null}
          <span className="text-[11.5px] tabular-nums opacity-75">
            {relativeAge(session.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Session actions for ${session.title}`}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          hideTooltip()
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenMenu(rect.right, rect.bottom)
        }}
        className={`absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-[calc(var(--radius)*0.5)] text-[13px] text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-40 ${
          selected
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        }`}
      >
        ⋯
      </button>
      {tooltip && (
        <SessionNavTooltip
          id={tooltipId}
          session={session}
          serverName={serverName}
          anchor={tooltip}
        />
      )}
    </div>
  )
}

function SessionNavTooltip({
  id,
  session,
  serverName,
  anchor,
}: {
  id: string
  session: SessionSummary
  serverName: string
  anchor: { top: number; left: number }
}) {
  return createPortal(
    <div
      id={id}
      role="tooltip"
      style={{ top: anchor.top, left: anchor.left }}
      className="pointer-events-none fixed z-50 w-64 rounded-[calc(var(--radius)*0.7)] border border-border bg-background px-3 py-2.5 shadow-md"
    >
      <p className="text-[13px] leading-snug font-medium break-words">{session.title}</p>
      <dl className="mt-2 grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="min-w-0 font-mono text-[11.5px] break-all">{session.branch}</dd>
        <dt className="text-muted-foreground">Agent</dt>
        <dd className="min-w-0">{agentLabel(session.agentId) ?? session.agentId}</dd>
        <dt className="text-muted-foreground">Server</dt>
        <dd className="min-w-0 break-all">{serverName}</dd>
      </dl>
    </div>,
    document.body,
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
  onDelete,
  onDismiss,
}: {
  x: number
  y: number
  onArchive: () => void
  onDelete: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  const archive = useRef(onArchive)
  const del = useRef(onDelete)
  const [confirming, setConfirming] = useState(false)
  dismiss.current = onDismiss
  archive.current = onArchive
  del.current = onDelete

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss.current()
    }

    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

    const highlight = (index: number) => {
      const list = items()
      list.forEach((item, i) => {
        if (i === index) item.setAttribute('data-highlighted', '')
        else item.removeAttribute('data-highlighted')
      })
      list[index]?.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss.current()
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

    // Capture so a click that would also select another session still closes
    // this first, rather than leaving a menu stranded over a new selection.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    highlight(0)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [confirming])

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
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
          >
            Archive
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dismiss.current()}
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted data-[highlighted]:bg-muted"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => setConfirming(true)}
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted"
          >
            Archive
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => del.current()}
            className="flex w-full items-center px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-muted data-[highlighted]:bg-muted"
          >
            Delete
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Right-click menu for a project (repository) header.
 *
 * Same chrome as the session menu: the sidebar is too narrow to grow a menu
 * beside the row, so this sits at the pointer.
 */
function ProjectContextMenu({
  x,
  y,
  hasEnvironments,
  onNewSession,
  onEnvironments,
  onOpenGitHub,
  onRemove,
  onDismiss,
}: {
  x: number
  y: number
  hasEnvironments: boolean
  onNewSession: () => void
  onEnvironments: () => void
  onOpenGitHub: () => void
  onRemove: () => void
  onDismiss: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss.current()
    }

    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

    const highlight = (index: number) => {
      const list = items()
      list.forEach((item, i) => {
        if (i === index) item.setAttribute('data-highlighted', '')
        else item.removeAttribute('data-highlighted')
      })
      list[index]?.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss.current()
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
    highlight(0)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const itemClass =
    'flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Project"
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-44 rounded-[calc(var(--radius)*0.7)] border border-border bg-background py-1 shadow-md"
    >
      <button type="button" role="menuitem" onClick={onNewSession} className={itemClass}>
        New session
      </button>
      <button type="button" role="menuitem" onClick={onEnvironments} className={itemClass}>
        {hasEnvironments ? 'Environments' : 'Set up'}
      </button>
      <button type="button" role="menuitem" onClick={onOpenGitHub} className={itemClass}>
        Open on GitHub
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={onRemove}
        className={`${itemClass} text-destructive`}
      >
        Remove
      </button>
    </div>
  )
}

/**
 * Type-to-confirm before a permanent removal.
 *
 * A menu that closes the moment focus drifts is the wrong container for
 * typing a repository name or session title. Same dialog chrome as session
 * details.
 */
function ConfirmDeleteDialog({
  title,
  description,
  typedLabel,
  confirmLabel,
  onConfirm,
  onDismiss,
}: {
  title: string
  description: string
  typedLabel: string
  confirmLabel: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  const [typed, setTyped] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const matches = typed === typedLabel

  useEffect(() => {
    input.current?.focus()

    const focusable = () => {
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      return nodes ? Array.from(nodes) : []
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
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

  return createPortal(
    <div
      // Sidebar and Workspace both sit in `relative z-10` columns so their
      // resize handles win the seam. A `fixed` overlay left inside the nav
      // stays in that stacking context, and Workspace paints over the right
      // half of the dialog. Portal to `body` so the veil covers the window.
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-remove-title"
        tabIndex={-1}
        className="w-full max-w-sm overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background shadow-lg outline-none"
      >
        <div className="flex items-start gap-2.5 border-b border-border px-4 py-3">
          <h2 id="confirm-remove-title" className="min-w-0 flex-1 font-medium">
            {title}
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

        <form
          className="px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (matches) onConfirm()
          }}
        >
          <p className="text-[13px] text-muted-foreground">{description}</p>
          <label className="mt-3 block text-[12px] text-muted-foreground">
            Type <span className="font-medium break-words text-foreground">{typedLabel}</span> to
            confirm
            <input
              ref={input}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label={`Type ${typedLabel} to confirm`}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-[calc(var(--radius)*0.6)] border border-border-strong bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none"
            />
          </label>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!matches}
              className="rounded-[calc(var(--radius)*0.6)] border border-border px-2.5 py-1 text-[12px] font-medium text-destructive hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
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

function sessionRowLabel(session: SessionSummary, viewedSeq?: number): string {
  const parts = [statusLabel(session.status), session.title]
  if (sessionNavIndicator(session.status, session.lastSeq, viewedSeq) === 'unread') {
    parts.push('Unread')
  }
  if (session.pullRequest) {
    parts.push(pullRequestStatusAriaLabel(pullRequestStatus(session.pullRequest)))
  }
  return parts.join(', ')
}

/**
 * Fixed-size mark to the left of the title so the text does not jump when the
 * session goes from live → unread → read.
 */
function SessionNavIndicator({
  status,
  lastSeq,
  viewedSeq,
}: {
  status: SessionSummary['status']
  lastSeq: number
  viewedSeq: number | undefined
}) {
  const kind = sessionNavIndicator(status, lastSeq, viewedSeq)

  return (
    <span className="grid size-5 flex-none place-items-center">
      {kind === 'orb' ? (
        <ThinkingOrb
          state={status === 'waiting_input' ? 'listening' : 'working'}
          size={20}
          theme="auto"
          aria-label={statusLabel(status)}
        />
      ) : kind === 'unread' ? (
        <span role="img" aria-label="Unread">
          <BookOpenIcon size={16} />
        </span>
      ) : kind === 'failed' ? (
        <span role="img" aria-label={statusLabel(status)} className="text-destructive">
          <AlertIcon size={16} />
        </span>
      ) : null}
    </span>
  )
}
