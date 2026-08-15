import type { FileChange, SessionSummary } from '@dukebox/protocol'
import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import type { DukeboxClient } from '@/lib/client'
import type { PlanTab } from '@/lib/plans'
import type { TerminalState } from '@/lib/useTerminals'
import { EnvironmentReview } from '@/components/EnvironmentReview'
import { FileChangeList } from '@/components/FileChangeList'
import { PlanPanel } from '@/components/PlanPanel'
import { PullRequestPanel, type PullRequestTab } from '@/components/PullRequest'
import { CommitIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon } from '@/components/icons'
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

type StaticTab = 'changes' | 'files' | 'terminal' | 'environment' | 'pr'

/**
 * A plan gets a tab of its own, keyed by the permission block it belongs to.
 *
 * Keyed rather than numbered so a replanned tab keeps its identity when its
 * block id changes underneath it, and so two plans can never collide.
 */
type PlanTabKey = `plan:${string}`

type WorkspaceTab = StaticTab | PlanTabKey

const TAB_LABELS: Record<StaticTab, string> = {
  changes: 'Changes',
  files: 'Files',
  terminal: 'Terminal',
  environment: 'Environment',
  pr: 'Pull request',
}

const planTabKey = (id: string): PlanTabKey => `plan:${id}`

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
  ...terminalProps
}: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
  const [tab, setTab] = useState<WorkspaceTab>('changes')

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  const showPr =
    Boolean(pullRequest) &&
    session?.purpose !== 'environment_setup' &&
    Boolean(
      session?.pullRequest ||
      session?.pullRequestUrl ||
      files.length > 0 ||
      (session?.changedFileCount ?? 0) > 0,
    )

  // Open the Environment tab when a proposal is ready to review — the form is
  // why this session exists, and burying it behind Changes would look unfinished.
  const reviewSessionId = environmentReview?.sessionId ?? null
  useEffect(() => {
    if (!reviewSessionId) return
    setTab('environment')
    setCollapsed(false)
  }, [reviewSessionId])

  // A plan waiting for an answer is what blocks the session, so it takes the
  // panel the moment it arrives. Keyed on the pending plan's id: re-running on
  // the array would drag the panel back every time a token lands.
  const pendingPlanId = plans.find((plan) => plan.status === 'pending')?.id ?? null
  useEffect(() => {
    if (!pendingPlanId) return
    setTab(planTabKey(pendingPlanId))
    setCollapsed(false)
  }, [pendingPlanId])

  const prUrl = session?.pullRequest?.url ?? session?.pullRequestUrl
  useEffect(() => {
    if (!prUrl || !showPr) return
    setTab('pr')
    setCollapsed(false)
  }, [prUrl, showPr])

  // Drop back to Changes if the Environment tab disappears (e.g. switching to a
  // coding session) while it was selected.
  useEffect(() => {
    if (!environmentReview && tab === 'environment') setTab('changes')
  }, [environmentReview, tab])

  useEffect(() => {
    if (!showPr && tab === 'pr') setTab('changes')
  }, [showPr, tab])

  // Plans come first: everything else reports on work already done, and the
  // plan is the one panel the session is waiting on.
  const planKeys = plans.map((plan) => planTabKey(plan.id))
  // A replanned plan takes a new block id, so its tab key changes under the
  // selection. Joined rather than passed as an array: a fresh array every
  // render would re-run this on every token.
  const planKeyList = planKeys.join('\0')
  useEffect(() => {
    if (!tab.startsWith('plan:')) return
    if (!planKeyList.split('\0').includes(tab)) setTab('changes')
  }, [planKeyList, tab])

  const tabs: WorkspaceTab[] = [
    ...planKeys,
    'changes',
    'files',
    'terminal',
    ...(environmentReview ? (['environment'] as const) : []),
    ...(showPr ? (['pr'] as const) : []),
  ]

  const planLabels = Object.fromEntries(
    plans.map((plan) => [planTabKey(plan.id), `Plan #${plan.number}`]),
  ) as Partial<Record<WorkspaceTab, string>>

  const activePlan = plans.find((plan) => planTabKey(plan.id) === tab) ?? null

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
            setTab('changes')
          }}
        />
      ) : (
        <>
          <TabBar
            tabs={tabs}
            active={tab}
            onSelect={setTab}
            labels={{ ...planLabels, pr: pullRequestTabLabel(prUrl) }}
          />
          {activePlan && onRespond ? (
            <div
              role="tabpanel"
              id={`workspace-panel-${tab}`}
              aria-labelledby={`workspace-tab-${tab}`}
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <PlanPanel
                tab={activePlan}
                onRespond={onRespond}
                disabled={Boolean(terminalProps.disabled)}
              />
            </div>
          ) : tab === 'changes' ? (
            <div
              role="tabpanel"
              id="workspace-panel-changes"
              aria-labelledby="workspace-tab-changes"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <Panels session={session} files={files} />
            </div>
          ) : tab === 'files' ? (
            <div
              role="tabpanel"
              id="workspace-panel-files"
              aria-labelledby="workspace-tab-files"
              className="flex min-h-0 flex-1 flex-col"
            >
              <SandboxFiles
                client={client ?? null}
                session={session}
                revision={files.map((file) => file.path).join('\0')}
              />
            </div>
          ) : tab === 'terminal' ? (
            <div
              role="tabpanel"
              id="workspace-panel-terminal"
              aria-labelledby="workspace-tab-terminal"
              className="flex min-h-0 flex-1 flex-col"
            >
              <TerminalPanel session={session} {...terminalProps} />
            </div>
          ) : tab === 'environment' && environmentReview ? (
            <div
              role="tabpanel"
              id="workspace-panel-environment"
              aria-labelledby="workspace-tab-environment"
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
            >
              <EnvironmentReview
                client={environmentReview.client}
                projectId={environmentReview.projectId}
                sessionId={environmentReview.sessionId}
                environmentId={environmentReview.environmentId}
                environmentName={environmentReview.environmentName}
                onSaved={environmentReview.onSaved}
                disabled={Boolean(environmentReview.disabled)}
              />
            </div>
          ) : tab === 'pr' && pullRequest && session ? (
            <PullRequestPanel
              client={pullRequest.client}
              session={session}
              files={files}
              onUpdated={pullRequest.onUpdated}
              {...(pullRequest.onContinue ? { onContinue: pullRequest.onContinue } : {})}
              disabled={Boolean(terminalProps.disabled)}
            />
          ) : null}
        </>
      )}
    </aside>
  )
}

/**
 * Workspace panel tabs.
 *
 * Labels rather than a menu: a handful of panels, and a dropdown costs a click
 * to show what the labels show for free. Only rendered expanded — a collapsed
 * panel has no room, and the counts are what it exists to show.
 */
function TabBar({
  tabs,
  active,
  onSelect,
  labels,
}: {
  tabs: WorkspaceTab[]
  active: WorkspaceTab
  onSelect: (tab: WorkspaceTab) => void
  labels?: Partial<Record<WorkspaceTab, string>>
}) {
  const list = useRef<HTMLDivElement>(null)

  const move = (delta: number) => {
    const index = tabs.indexOf(active)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (!next) return
    onSelect(next)
    requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
    })
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Workspace panels"
      className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
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
            onSelect(first)
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
            onSelect(last)
            requestAnimationFrame(() => {
              list.current
                ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                ?.focus()
            })
          }
        }
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          id={`workspace-tab-${tab}`}
          role="tab"
          aria-selected={active === tab}
          aria-controls={`workspace-panel-${tab}`}
          tabIndex={active === tab ? 0 : -1}
          onClick={() => onSelect(tab)}
          className={`shrink-0 rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] ${
            active === tab
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {labels?.[tab] ?? (tab in TAB_LABELS ? TAB_LABELS[tab as StaticTab] : tab)}
        </button>
      ))}
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

/**
 * The shells open in this session.
 *
 * Attaching and detaching happens here rather than in `Terminal`: leaving the
 * panel should stop output reaching a component nobody is looking at, without
 * killing the process behind it.
 */
const TerminalPanel = memo(function TerminalPanel({
  session,
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
}: TerminalProps & { session: SessionSummary | null }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const tabs = terminals.tabs
  const active = tabs.find((tab) => tab.terminalId === selected) ?? tabs[0] ?? null

  // Select whichever terminal appeared last.
  //
  // Keyed on the newest id rather than on the tab list: this has to fire when a
  // terminal is added, and not when one merely produces output. Without it,
  // clicking `+` leaves the previous terminal on screen and the button reads as
  // having done nothing.
  const newestId = tabs.at(-1)?.terminalId ?? null
  useEffect(() => {
    if (newestId) setSelected(newestId)
  }, [newestId])

  useEffect(() => {
    if (tabs.length > 0 || error) setOpening(false)
  }, [tabs.length, error])

  const open = () => {
    setOpening(true)
    onOpenTerminal(80, 24)
  }

  // Attach while the panel is on screen, detach when it is not. The dependency
  // is the id list rather than the tabs, which change identity on every chunk
  // of output and would resubscribe constantly.
  const ids = tabs.map((tab) => tab.terminalId).join(',')
  useEffect(() => {
    const current = ids ? ids.split(',') : []
    for (const terminalId of current) onAttachTerminal(terminalId, 80, 24)

    return () => {
      for (const terminalId of current) onDetachTerminal(terminalId)
    }
  }, [ids, onAttachTerminal, onDetachTerminal])

  if (!session) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Select a session to open a terminal in it.
      </p>
    )
  }

  if (tabs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-2.5 px-4 py-4">
        <p className="text-[12.5px] text-muted-foreground">
          {session.status === 'stopped'
            ? 'No terminal is open. Opening one starts this session’s container again after the server restart.'
            : 'No terminal is open. A shell here runs inside this session’s container.'}
        </p>
        <button
          type="button"
          onClick={open}
          disabled={opening || disabled}
          className="rounded-[calc(var(--radius)*0.6)] bg-muted px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-border disabled:opacity-50"
        >
          {opening ? 'Starting…' : 'New terminal'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {tabs.map((tab) => (
          <span
            key={tab.terminalId}
            className={`flex items-center gap-1 rounded-[calc(var(--radius)*0.6)] pr-1 pl-2.5 text-[12.5px] ${
              tab.terminalId === active?.terminalId ? 'bg-muted' : 'hover:bg-muted'
            }`}
          >
            <TerminalTabName
              title={tab.title}
              selected={tab.terminalId === active?.terminalId}
              exited={tab.exited}
              disabled={disabled}
              onSelect={() => setSelected(tab.terminalId)}
              onRename={(title) => onRenameTerminal(tab.terminalId, title)}
            />
            <button
              type="button"
              onClick={() => onCloseTerminal(tab.terminalId)}
              disabled={disabled}
              aria-label={`Close terminal ${tab.title}`}
              className="grid size-5 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-border hover:text-foreground disabled:opacity-40"
            >
              ×
            </button>
          </span>
        ))}

        {tabs.length < MAX_TERMINALS && (
          <button
            type="button"
            onClick={open}
            disabled={opening || disabled}
            aria-label="New terminal"
            className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {opening ? '…' : '+'}
          </button>
        )}
      </div>

      {tabs.map((tab) => (
        <Suspense key={tab.terminalId} fallback={null}>
          <TerminalView
            tab={tab}
            active={tab.terminalId === active?.terminalId}
            disabled={disabled}
            onInput={(data) => onTerminalInput(tab.terminalId, data)}
            onResize={(cols, rows) => onTerminalResize(tab.terminalId, cols, rows)}
            onDrain={(count) => onDrainTerminal(tab.terminalId, count)}
          />
        </Suspense>
      ))}
    </div>
  )
})

/**
 * A terminal tab's label, which becomes an input when clicked.
 *
 * Clicking selects the tab and turns the name into a field, so renaming does
 * not need a separate control.
 */
function TerminalTabName({
  title,
  selected,
  exited,
  disabled = false,
  onSelect,
  onRename,
}: {
  title: string
  selected: boolean
  exited: boolean
  disabled?: boolean
  onSelect: () => void
  onRename: (title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  const finishing = useRef(false)

  useEffect(() => {
    if (!selected) setEditing(false)
  }, [selected])

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [editing, title])

  useEffect(() => {
    if (!editing) return

    finishing.current = false
    input.current?.focus()
    input.current?.select()
  }, [editing])

  const commit = () => {
    if (finishing.current) return
    finishing.current = true

    const next = draft.trim()
    setEditing(false)
    if (next && next !== title) onRename(next)
    else setDraft(title)
  }

  useEffect(() => {
    if (disabled) setEditing(false)
  }, [disabled])

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
            setDraft(title)
            setEditing(false)
          }
        }}
        style={{ width: `${Math.max(3, draft.length + 1)}ch` }}
        className="bg-transparent py-1 text-[12.5px] outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        onSelect()
        if (disabled) return
        setDraft(title)
        setEditing(true)
      }}
      className={exited ? 'py-1 text-muted-foreground line-through' : 'py-1'}
    >
      {title}
    </button>
  )
}
