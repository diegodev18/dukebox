import type { FileChange, SessionSummary } from '@dukebox/protocol'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { DukeboxClient } from '@/lib/client'
import type { PlanTab } from '@/lib/plans'
import type { TerminalState } from '@/lib/useTerminals'
import { EnvironmentReview } from '@/components/EnvironmentReview'
import { FileChangeList } from '@/components/FileChangeList'
import { PlanPanel } from '@/components/PlanPanel'
import { PullRequestPanel, type PullRequestTab } from '@/components/PullRequest'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CommitIcon,
  FileIcon,
  PlusIcon,
} from '@/components/icons'
import { SandboxFiles } from '@/components/SandboxFiles'
import { ResizeHandle } from '@/components/ResizeHandle'
import { pullRequestTabLabel } from '@/lib/pullRequest'
import { WORKSPACE_DEFAULT, WORKSPACE_MIN } from '@/lib/columnWidths'

const TerminalView = lazy(() =>
  import('@/components/Terminal').then((module) => ({ default: module.Terminal })),
)

/**
 * What the session is changing: files, diffs, a terminal, a preview.
 *
 * Collapsing it does not hide it. The question it answers — did anything
 * change, and how much — is worth keeping visible, so closed it becomes a list
 * of counts. Without a surface of its own it reads as a summary in the margin
 * rather than as a second sidebar competing with the one on the left.
 *
 * `min-h-0` on the column and `overflow-hidden` on the tab panels are
 * load-bearing: a flex item defaults to `min-height: auto` and refuses to
 * shrink below its content, so without them a long file list grows the window
 * instead of scrolling inside the panel. The column itself stays `overflow`
 * visible so the resize handle can sit a pixel over the seam. Tabs, a pull
 * request title, and file names stay put; only the diff moves.
 */

const COLLAPSED_KEY = 'dukebox:workspace-collapsed'

/** How many terminals a session may have. Matches the server's own cap. */
const MAX_TERMINALS = 4

/**
 * A workspace tab.
 *
 * Changes, Files, and Environment are singletons — reopening one focuses the
 * open tab rather than stacking a second copy. Terminals, plans, and pull
 * requests are keyed so several can stay open at once: one tab per shell, per
 * plan, and per pull request.
 */
type WorkspaceTab =
  | { kind: 'changes' }
  | { kind: 'files' }
  | { kind: 'environment' }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'plan'; planId: string }
  | { kind: 'pr'; prUrl: string | null }

const TAB_LABELS = {
  changes: 'Changes',
  files: 'Files',
  environment: 'Environment',
} as const

const tabKey = (tab: WorkspaceTab): string => {
  switch (tab.kind) {
    case 'terminal':
      return `terminal:${tab.terminalId}`
    case 'plan':
      return `plan:${tab.planId}`
    case 'pr':
      return `pr:${tab.prUrl ?? ''}`
    default:
      return tab.kind
  }
}

const terminalKey = (terminalId: string): string => `terminal:${terminalId}`

/** Props to mount the Environment review form as a workspace tab. */
export interface EnvironmentReviewTab {
  client: DukeboxClient
  projectId: string
  sessionId: string
  /** Null when the session resolved to no environment; the form says so. */
  environmentId: string | null
  environmentName: string | null
  onSaved: () => void
  disabled?: boolean
}

/** The terminal half of the panel's props, threaded through from useSession. */
interface TerminalProps {
  terminals: TerminalState
  onOpenTerminal: (cols: number, rows: number) => void
  onAttachTerminal: (terminalId: string, cols: number, rows: number) => void
  onDetachTerminal: (terminalId: string) => void
  onTerminalInput: (terminalId: string, data: string) => void
  onTerminalResize: (terminalId: string, cols: number, rows: number) => void
  onCloseTerminal: (terminalId: string) => void
  onRenameTerminal: (terminalId: string, title: string) => void
  onDrainTerminal: (terminalId: string, count: number) => void
  /** Set when opening a terminal was rejected, so the waiting state can clear. */
  error?: string | null
  /** Keystrokes and new tabs cannot reach the server while the socket is down. */
  disabled?: boolean
}

interface Props extends TerminalProps {
  session: SessionSummary | null
  /** What the session has changed so far, folded from the event stream. */
  files: FileChange[]
  /** Used by the Files tab to list and read the sandbox working tree. */
  client?: DukeboxClient | null
  /** When set, the Environment tab appears with the review form. */
  environmentReview?: EnvironmentReviewTab | null
  /** When set, the Pull request tab can open, mark ready, and merge. */
  pullRequest?: PullRequestTab | null
  /** Plans the agent has asked to build, one tab each. */
  plans?: PlanTab[]
  /** Answers a plan's Build / Keep planning. */
  onRespond?: (id: string, allow: boolean) => void
  /** Expanded column width. When omitted, the panel is not resizable. */
  width?: number
  widthMin?: number
  widthMax?: number
  onWidthChange?: (width: number) => void
}

export function Workspace({
  session,
  files,
  client,
  environmentReview,
  pullRequest,
  plans = [],
  onRespond,
  width,
  widthMin = WORKSPACE_MIN,
  widthMax,
  onWidthChange,
  terminals,
  onOpenTerminal,
  onAttachTerminal,
  onDetachTerminal,
  onTerminalInput,
  onTerminalResize,
  onCloseTerminal,
  onRenameTerminal,
  onDrainTerminal,
  error,
  disabled = false,
}: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
  const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>(() => [
    { kind: 'changes' },
    { kind: 'files' },
  ])
  const [activeKey, setActiveKey] = useState<string | null>(tabKey({ kind: 'changes' }))
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  // Read inside the terminal-sync effect, which is keyed on the terminal list
  // alone so a new shell can steal focus the moment it lands.
  const openingRef = useRef(opening)
  openingRef.current = opening
  const activeKeyRef = useRef(activeKey)
  activeKeyRef.current = activeKey

  const showPr =
    Boolean(pullRequest) &&
    session?.purpose !== 'environment_setup' &&
    Boolean(
      session?.pullRequest ||
      session?.pullRequestUrl ||
      files.length > 0 ||
      (session?.changedFileCount ?? 0) > 0,
    )

  /**
   * Add a tab and focus it.
   *
   * Singletons — and the single pull request tab — replace the tab of the same
   * kind, so opening Changes twice never stacks. Terminals and plans are keyed
   * and keep every instance open.
   */
  const openAndFocus = useCallback((tab: WorkspaceTab) => {
    const key = tabKey(tab)
    setOpenTabs((current) => {
      const sameKey = (existing: WorkspaceTab) => tabKey(existing) === key
      const sameKind = (existing: WorkspaceTab) => existing.kind === tab.kind
      const replace = tab.kind === 'terminal' || tab.kind === 'plan' ? sameKey : sameKind
      const next = current.some(replace)
        ? current.filter((existing) => !replace(existing))
        : current
      return [...next, tab]
    })
    setActiveKey(key)
  }, [])

  const closeTab = useCallback(
    (key: string) => {
      const index = openTabs.findIndex((tab) => tabKey(tab) === key)
      if (index === -1) return

      const target = openTabs[index]!
      if (target.kind === 'terminal') onCloseTerminal(target.terminalId)

      const next = openTabs.filter((tab) => tabKey(tab) !== key)
      setOpenTabs(next)
      if (activeKey === key) {
        const neighbor = next[Math.min(index, next.length - 1)]
        setActiveKey(neighbor ? tabKey(neighbor) : null)
      }
    },
    [openTabs, activeKey, onCloseTerminal],
  )

  const openNewTerminal = useCallback(() => {
    if (terminals.tabs.length >= MAX_TERMINALS) return
    setOpening(true)
    setAddMenuOpen(false)
    onOpenTerminal(80, 24)
  }, [terminals.tabs.length, onOpenTerminal])

  // Open the Environment tab when a proposal is ready to review — the form is
  // why this session exists, and burying it behind Changes would look unfinished.
  const reviewSessionId = environmentReview?.sessionId ?? null
  useEffect(() => {
    if (!reviewSessionId) return
    openAndFocus({ kind: 'environment' })
    setCollapsed(false)
  }, [reviewSessionId, openAndFocus])

  // A plan waiting for an answer is what blocks the session, so it takes the
  // panel the moment it arrives. Keyed on the pending plan's id: re-running on
  // the array would drag the panel back every time a token lands.
  const pendingPlanId = plans.find((plan) => plan.status === 'pending')?.id ?? null
  useEffect(() => {
    if (!pendingPlanId) return
    openAndFocus({ kind: 'plan', planId: pendingPlanId })
    setCollapsed(false)
  }, [pendingPlanId, openAndFocus])

  const prUrl = session?.pullRequest?.url ?? session?.pullRequestUrl
  useEffect(() => {
    if (!prUrl || !showPr) return
    openAndFocus({ kind: 'pr', prUrl })
    setCollapsed(false)
  }, [prUrl, showPr, openAndFocus])

  // A plan tab follows its plan: gone plan, gone tab. Replanning keeps the
  // same number but takes a new id, so the old tab closes and a fresh one
  // opens rather than showing a stale Build / Keep. A plan that never had a
  // tab gets one when it first appears, but only then — closing a built plan
  // stays closed.
  const planIdList = plans.map((plan) => plan.id).join('\0')
  const materializedPlans = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ids = planIdList ? planIdList.split('\0') : []

    const fresh = ids.filter((id) => !materializedPlans.current.has(id))
    for (const id of fresh) materializedPlans.current.add(id)

    setOpenTabs((current) => {
      let next = current.filter((tab) => tab.kind !== 'plan' || ids.includes(tab.planId))
      const missing = fresh.filter(
        (id) => !next.some((tab) => tab.kind === 'plan' && tab.planId === id),
      )
      if (missing.length > 0) {
        next = [...next, ...missing.map((id) => ({ kind: 'plan' as const, planId: id }))]
      }
      return next === current ? current : next
    })
  }, [planIdList])

  // One workspace tab per open shell. New terminals get a tab (and take the
  // panel when the user asked for one or is already in a terminal); closed
  // shells drop theirs.
  const terminalIdList = terminals.tabs.map((tab) => tab.terminalId).join(',')
  const knownTerminalIds = useRef('')
  useEffect(() => {
    const previous = knownTerminalIds.current
    knownTerminalIds.current = terminalIdList

    const current = terminalIdList ? terminalIdList.split(',') : []
    const known = new Set(current)
    const prevSet = new Set(previous ? previous.split(',') : [])
    const added = current.filter((id) => !prevSet.has(id))

    setOpenTabs((tabs) => {
      let next = tabs
      const withoutGone = tabs.filter((tab) => tab.kind !== 'terminal' || known.has(tab.terminalId))
      if (withoutGone.length !== tabs.length) next = withoutGone

      const missing = current.filter(
        (id) => !next.some((tab) => tab.kind === 'terminal' && tab.terminalId === id),
      )
      if (missing.length > 0) {
        next = [...next, ...missing.map((id) => ({ kind: 'terminal' as const, terminalId: id }))]
      }
      return next === tabs ? tabs : next
    })

    if (added.length > 0) {
      const newest = current.at(-1)!
      if (openingRef.current || activeKeyRef.current?.startsWith('terminal:')) {
        setActiveKey(terminalKey(newest))
      }
      setOpening(false)
    }
  }, [terminalIdList])

  // Keystrokes and new shells cannot reach the server while the socket is
  // down; clear the waiting state when opening is refused or fulfilled.
  useEffect(() => {
    if (terminals.tabs.length > 0 || error) setOpening(false)
  }, [terminals.tabs.length, error])

  // A per-session flag: switching sessions must not leave a stale "starting…"
  // menu item behind, nor plan tabs that belong to another session's plans.
  const sessionId = session?.id ?? null
  useEffect(() => {
    materializedPlans.current = new Set()
    setOpening(false)
  }, [sessionId])

  // If the focused tab disappears — an environment or PR stops being relevant,
  // a plan is answered, a shell closes — fall back to the tab beside it.
  useEffect(() => {
    if (!activeKey) return
    if (openTabs.some((tab) => tabKey(tab) === activeKey)) return
    const fallback = openTabs[0] ?? null
    setActiveKey(fallback ? tabKey(fallback) : null)
  }, [openTabs, activeKey])

  // Attach the shells while a terminal tab is on screen, detach when it is
  // not — collapsed panels, other tabs, and closed shells all stop output from
  // reaching components nobody is looking at, without killing the processes
  // behind them.
  const terminalActive = activeKey !== null && activeKey.startsWith('terminal:')
  useEffect(() => {
    const current = terminalIdList ? terminalIdList.split(',') : []
    if (collapsed || !terminalActive) return
    for (const terminalId of current) onAttachTerminal(terminalId, 80, 24)

    return () => {
      for (const terminalId of current) onDetachTerminal(terminalId)
    }
  }, [terminalIdList, terminalActive, collapsed, onAttachTerminal, onDetachTerminal])

  const activeTab = openTabs.find((tab) => tabKey(tab) === activeKey) ?? null
  const activeTerminalId = activeTab?.kind === 'terminal' ? activeTab.terminalId : null

  const labelFor = (tab: WorkspaceTab): string => {
    switch (tab.kind) {
      case 'changes':
      case 'files':
      case 'environment':
        return TAB_LABELS[tab.kind]
      case 'terminal':
        return terminals.tabs.find((one) => one.terminalId === tab.terminalId)?.title ?? 'Terminal'
      case 'plan':
        return `Plan #${plans.find((one) => one.id === tab.planId)?.number ?? '?'}`
      case 'pr':
        return pullRequestTabLabel(tab.prUrl)
    }
  }

  const tabAreaRef = useRef<HTMLDivElement>(null)

  return (
    <aside
      aria-label="Workspace"
      {...(collapsed ? { 'data-collapsed': true } : {})}
      className={`relative z-10 flex min-h-0 min-w-0 flex-col ${collapsed ? '' : 'border-l border-border bg-surface'}`}
    >
      {!collapsed && onWidthChange && width !== undefined && widthMax !== undefined && (
        <ResizeHandle
          value={width}
          min={widthMin}
          max={widthMax}
          defaultValue={WORKSPACE_DEFAULT}
          edge="start"
          label="Resize workspace"
          onChange={onWidthChange}
        />
      )}
      <header
        className={`flex items-center gap-2 py-2.5 pr-3 pl-3.5 ${
          collapsed ? 'justify-end' : 'border-b border-border'
        }`}
      >
        {!collapsed && <span className="text-[12.5px] font-medium">Workspace</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand workspace' : 'Collapse workspace'}
          className="grid size-6.5 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? <ChevronRightIcon size={13} /> : <ChevronLeftIcon size={13} />}
        </button>
      </header>

      {collapsed ? (
        <Metrics
          session={session}
          files={files}
          onExpand={() => {
            setCollapsed(false)
            openAndFocus({ kind: 'changes' })
          }}
        />
      ) : (
        <>
          <div ref={tabAreaRef} className="relative border-b border-border">
            <TabBar
              tabs={openTabs}
              activeKey={activeKey}
              labels={labelFor}
              disabled={disabled}
              onSelect={(key) => {
                setActiveKey(key)
                setAddMenuOpen(false)
              }}
              onClose={closeTab}
              onRenameTerminal={onRenameTerminal}
              onToggleAdd={() => setAddMenuOpen((open) => !open)}
              addOpen={addMenuOpen}
            />
            {addMenuOpen && (
              <AddTabMenu
                rootRef={tabAreaRef}
                environmentAvailable={Boolean(environmentReview)}
                prAvailable={showPr}
                prUrl={prUrl}
                terminalAvailable={terminals.tabs.length < MAX_TERMINALS}
                opening={opening}
                disabled={disabled}
                onClose={() => setAddMenuOpen(false)}
                onOpen={(tab) => {
                  setAddMenuOpen(false)
                  openAndFocus(tab)
                }}
                onOpenTerminal={openNewTerminal}
              />
            )}
          </div>

          {!activeTab ? (
            <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
              No panel is open. Use + to open one.
            </p>
          ) : activeTab.kind === 'terminal' ? (
            <div
              role="tabpanel"
              id={`workspace-panel-${tabKey(activeTab)}`}
              aria-labelledby={`workspace-tab-${tabKey(activeTab)}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {terminals.tabs.map((terminal) => (
                <Suspense key={terminal.terminalId} fallback={null}>
                  <TerminalView
                    tab={terminal}
                    active={terminal.terminalId === activeTerminalId}
                    disabled={disabled}
                    onInput={(data) => onTerminalInput(terminal.terminalId, data)}
                    onResize={(cols, rows) => onTerminalResize(terminal.terminalId, cols, rows)}
                    onDrain={(count) => onDrainTerminal(terminal.terminalId, count)}
                  />
                </Suspense>
              ))}
            </div>
          ) : (
            <div
              role="tabpanel"
              id={`workspace-panel-${tabKey(activeTab)}`}
              aria-labelledby={`workspace-tab-${tabKey(activeTab)}`}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              {renderPanel(activeTab, {
                session,
                files,
                client: client ?? null,
                environmentReview: environmentReview ?? null,
                pullRequest: pullRequest ?? null,
                plans,
                onRespond: onRespond ?? null,
                disabled,
              })}
            </div>
          )}
        </>
      )}
    </aside>
  )
}

function renderPanel(
  tab: WorkspaceTab,
  deps: {
    session: SessionSummary | null
    files: FileChange[]
    client: DukeboxClient | null
    environmentReview: EnvironmentReviewTab | null
    pullRequest: PullRequestTab | null
    plans: PlanTab[]
    onRespond: ((id: string, allow: boolean) => void) | null
    disabled: boolean
  },
) {
  switch (tab.kind) {
    case 'changes':
      return <Panels session={deps.session} files={deps.files} />

    case 'files':
      return (
        <SandboxFiles
          client={deps.client ?? null}
          session={deps.session}
          revision={deps.files.map((file) => file.path).join('\0')}
        />
      )

    case 'environment':
      return deps.environmentReview ? (
        <EnvironmentReview
          client={deps.environmentReview.client}
          projectId={deps.environmentReview.projectId}
          sessionId={deps.environmentReview.sessionId}
          environmentId={deps.environmentReview.environmentId}
          environmentName={deps.environmentReview.environmentName}
          onSaved={deps.environmentReview.onSaved}
          disabled={Boolean(deps.environmentReview.disabled)}
        />
      ) : null

    case 'plan': {
      const plan = deps.plans.find((candidate) => candidate.id === tab.planId)
      if (!plan || !deps.onRespond) return null
      return <PlanPanel tab={plan} onRespond={deps.onRespond} disabled={deps.disabled} />
    }

    case 'pr':
      return deps.session && deps.pullRequest ? (
        <PullRequestPanel
          client={deps.pullRequest.client}
          session={deps.session}
          files={deps.files}
          onUpdated={deps.pullRequest.onUpdated}
          {...(deps.pullRequest.onContinue ? { onContinue: deps.pullRequest.onContinue } : {})}
          disabled={deps.disabled}
        />
      ) : null

    case 'terminal':
      return null
  }
}

/**
 * Workspace panel tabs, with a close button on each and a + to open more.
 *
 * Only rendered expanded — a collapsed panel has no room, and the counts are
 * what it exists to show. Terminal tabs double-click into a rename field; the
 * rest are plain labels.
 */
function TabBar({
  tabs,
  activeKey,
  labels,
  disabled = false,
  onSelect,
  onClose,
  onRenameTerminal,
  onToggleAdd,
  addOpen,
}: {
  tabs: WorkspaceTab[]
  activeKey: string | null
  labels: (tab: WorkspaceTab) => string
  disabled?: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onRenameTerminal: (terminalId: string, title: string) => void
  onToggleAdd: () => void
  addOpen: boolean
}) {
  const list = useRef<HTMLDivElement>(null)

  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tabKey(tab) === activeKey)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (!next) return
    onSelect(tabKey(next))
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    })
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Workspace panels"
      className="flex items-center gap-1 overflow-x-auto px-2 py-1.5"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          move(-1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          const first = tabs[0]
          if (first) {
            onSelect(tabKey(first))
            requestAnimationFrame(() => {
              list.current
                ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                ?.focus()
            })
          }
        } else if (event.key === 'End') {
          event.preventDefault()
          const last = tabs[tabs.length - 1]
          if (last) {
            onSelect(tabKey(last))
            requestAnimationFrame(() => {
              list.current
                ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                ?.focus()
            })
          }
        }
      }}
    >
      {tabs.map((tab) => {
        const key = tabKey(tab)
        const selected = key === activeKey
        const label = labels(tab)
        return (
          <div
            key={key}
            role="tab"
            id={`workspace-tab-${key}`}
            aria-selected={selected}
            aria-controls={`workspace-panel-${key}`}
            aria-label={label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(key)}
            className={`flex shrink-0 items-center gap-1 rounded-[calc(var(--radius)*0.6)] py-1 pr-1 pl-2 text-[12.5px] ${
              selected
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <TabLabel
              label={label}
              renameable={tab.kind === 'terminal'}
              selected={selected}
              disabled={disabled}
              onSelect={() => onSelect(key)}
              onRename={(title) => {
                if (tab.kind === 'terminal') onRenameTerminal(tab.terminalId, title)
              }}
            />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onClose(key)
              }}
              disabled={disabled}
              aria-label={`Close ${label}`}
              className="grid size-5 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-40"
            >
              ×
            </button>
          </div>
        )
      })}

      <button
        type="button"
        onClick={onToggleAdd}
        aria-expanded={addOpen}
        aria-label="Add panel"
        className="sticky right-0 ml-auto grid size-6 shrink-0 place-items-center self-center rounded-[calc(var(--radius)*0.6)] bg-surface text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <PlusIcon size={14} />
      </button>
    </div>
  )
}

/**
 * A tab's label.
 *
 * Terminal tabs become an input when double-clicked, so renaming a shell does
 * not need a second control. Everything else is a plain selectable label.
 */
function TabLabel({
  label,
  renameable,
  selected,
  disabled = false,
  onSelect,
  onRename,
}: {
  label: string
  renameable: boolean
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  onRename: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(label)
  const input = useRef<HTMLInputElement>(null)
  const finishing = useRef(false)

  useEffect(() => {
    if (!selected) setEditing(false)
  }, [selected])

  useEffect(() => {
    if (!editing) setDraft(label)
  }, [editing, label])

  useEffect(() => {
    if (!editing) return

    finishing.current = false
    input.current?.focus()
    input.current?.select()
  }, [editing])

  useEffect(() => {
    if (disabled) setEditing(false)
  }, [disabled])

  const commit = () => {
    if (finishing.current) return
    finishing.current = true

    const next = draft.trim()
    setEditing(false)
    if (next && next !== label) onRename(next)
    else setDraft(label)
  }

  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        maxLength={32}
        aria-label="Terminal name"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finishing.current = true
            setDraft(label)
            setEditing(false)
          }
        }}
        style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
        className="bg-transparent py-0 text-[12.5px] outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={() => {
        if (!renameable || disabled) return
        setDraft(label)
        setEditing(true)
      }}
      className="min-w-0 truncate"
    >
      {label}
    </button>
  )
}

/**
 * The + menu: the panels that can be added to the tab strip.
 *
 * Singletons open and focus their existing tab when clicked again, so the
 * menu never stacks a second Changes. Terminal starts a new shell instead —
 * the tab lands when the server confirms it.
 */
function AddTabMenu({
  rootRef,
  environmentAvailable,
  prAvailable,
  prUrl,
  terminalAvailable,
  opening,
  disabled = false,
  onOpen,
  onOpenTerminal,
  onClose,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>
  environmentAvailable: boolean
  prAvailable: boolean
  prUrl: string | null | undefined
  terminalAvailable: boolean
  opening: boolean
  disabled?: boolean
  onOpen: (tab: WorkspaceTab) => void
  onOpenTerminal: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      // The anchor holds the + button as well as the menu, so clicking it
      // again toggles instead of racing with this outside-click close.
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close.current()
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
        close.current()
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
  }, [rootRef])

  const itemClass =
    'flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-muted data-[highlighted]:bg-muted disabled:opacity-50'

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Add panel"
      className="absolute top-full right-2 z-50 mt-1 min-w-36 rounded-[calc(var(--radius)*0.7)] border border-border bg-popover py-1 text-popover-foreground shadow-md"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onOpen({ kind: 'changes' })}
        className={itemClass}
      >
        Changes
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onOpen({ kind: 'files' })}
        className={itemClass}
      >
        Files
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={onOpenTerminal}
        disabled={disabled || !terminalAvailable || opening}
        className={itemClass}
      >
        {opening ? 'Starting…' : 'Terminal'}
      </button>
      {environmentAvailable && (
        <button
          type="button"
          role="menuitem"
          onClick={() => onOpen({ kind: 'environment' })}
          className={itemClass}
        >
          Environment
        </button>
      )}
      {prAvailable && (
        <button
          type="button"
          role="menuitem"
          onClick={() => onOpen({ kind: 'pr', prUrl: prUrl ?? null })}
          className={itemClass}
        >
          Pull request
        </button>
      )}
    </div>
  )
}

/**
 * The counts that summarise a closed workspace.
 *
 * Rows with a label, not a column of bare numbers: a number alone needs a
 * caption to mean anything, and stacking the two doubles the height for no
 * more information than a line gives.
 */
function Metrics({
  session,
  files,
  onExpand,
}: {
  session: SessionSummary | null
  files: FileChange[]
  onExpand: () => void
}) {
  if (!session) return <div />

  // Counted from the live stream rather than the session summary, which only
  // refreshes when the server sends a new one — a count that lags the diff
  // beside it is worse than no count.
  const changed = files.length || session.changedFileCount

  return (
    <div className="flex flex-col px-2 pt-6 pb-3.5">
      <MetricLabel>Changes</MetricLabel>
      <Metric
        icon={<FileIcon size={13} />}
        label="Files"
        value={String(changed)}
        onClick={onExpand}
      />

      <MetricLabel>On {session.branch || session.baseBranch}</MetricLabel>
      <Metric
        icon={<CommitIcon size={13} />}
        label="Events"
        value={String(session.lastSeq)}
        onClick={onExpand}
      />
    </div>
  )
}

function MetricLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 pt-4 pb-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase first:pt-0">
      {children}
    </p>
  )
}

function Metric({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-[calc(var(--radius)*0.6)] px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <span className="opacity-75">{icon}</span>
      {label}
      <span className="min-w-3 flex-1" />
      <span className="flex-none font-mono text-[12.5px] tabular-nums text-foreground">
        {value}
      </span>
    </button>
  )
}

/**
 * Empty states for the Changes tab. The scrolling list itself is shared
 * with the pull request tab so both keep chrome still and only the diff moves.
 */
function Panels({ session, files }: { session: SessionSummary | null; files: FileChange[] }) {
  if (!session) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Select a session to see what it changed.
      </p>
    )
  }

  if (files.length === 0) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Nothing changed yet. Files appear here as the agent edits them.
      </p>
    )
  }

  return <FileChangeList key={session.id} files={files} />
}
