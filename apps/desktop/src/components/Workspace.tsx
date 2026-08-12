import type { FileChange, SessionSummary } from '@dukebox/protocol'
import { useEffect, useRef, useState } from 'react'
import type { DukeboxClient } from '../lib/client.js'
import type { TerminalState } from '../lib/useTerminals.js'
import { Diff, changeCounts } from './Diff.js'
import { EnvironmentReview } from './EnvironmentReview.js'
import {
  CommitIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileIcon,
} from './icons.js'
import { Terminal } from './Terminal.js'

/**
 * What the session is changing: files, diffs, a terminal, a preview.
 *
 * Collapsing it does not hide it. The question it answers — did anything
 * change, and how much — is worth keeping visible, so closed it becomes a list
 * of counts. Without a surface of its own it reads as a summary in the margin
 * rather than as a second sidebar competing with the one on the left.
 *
 * `min-h-0` on the column is load-bearing: a flex item defaults to
 * `min-height: auto` and refuses to shrink below its content, so without it a
 * long file list grows the window instead of scrolling inside the panel.
 */

const COLLAPSED_KEY = 'dukebox:workspace-collapsed'

/** How many terminals a session may have. Matches the server's own cap. */
const MAX_TERMINALS = 4

type WorkspaceTab = 'files' | 'terminal' | 'environment'

/** Props to mount the Environment review form as a workspace tab. */
export interface EnvironmentReviewTab {
  client: DukeboxClient
  projectId: string
  sessionId: string
  /** Null when the session resolved to no environment; the form says so. */
  environmentId: string | null
  environmentName: string | null
  onSaved: () => void
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
  onDrainTerminal: (terminalId: string) => void
}

interface Props extends TerminalProps {
  session: SessionSummary | null
  /** What the session has changed so far, folded from the event stream. */
  files: FileChange[]
  /** When set, the Environment tab appears with the review form. */
  environmentReview?: EnvironmentReviewTab | null
}

export function Workspace({ session, files, environmentReview, ...terminalProps }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')
  const [tab, setTab] = useState<WorkspaceTab>('files')

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  // Open the Environment tab when a proposal is ready to review — the form is
  // why this session exists, and burying it behind Files would look unfinished.
  const reviewSessionId = environmentReview?.sessionId ?? null
  useEffect(() => {
    if (!reviewSessionId) return
    setTab('environment')
    setCollapsed(false)
  }, [reviewSessionId])

  // Drop back to Files if the Environment tab disappears (e.g. switching to a
  // coding session) while it was selected.
  useEffect(() => {
    if (!environmentReview && tab === 'environment') setTab('files')
  }, [environmentReview, tab])

  const tabs: WorkspaceTab[] = environmentReview
    ? ['files', 'terminal', 'environment']
    : ['files', 'terminal']

  return (
    <aside
      aria-label="Workspace"
      {...(collapsed ? { 'data-collapsed': true } : {})}
      className={`flex min-h-0 min-w-0 flex-col ${collapsed ? '' : 'border-l border-border bg-surface'}`}
    >
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
            setTab('files')
          }}
        />
      ) : (
        <>
          <TabBar tabs={tabs} active={tab} onSelect={setTab} />
          {tab === 'files' ? (
            <Panels session={session} files={files} />
          ) : tab === 'terminal' ? (
            <TerminalPanel session={session} {...terminalProps} />
          ) : environmentReview ? (
            <EnvironmentReview
              client={environmentReview.client}
              projectId={environmentReview.projectId}
              sessionId={environmentReview.sessionId}
              environmentId={environmentReview.environmentId}
              environmentName={environmentReview.environmentName}
              onSaved={environmentReview.onSaved}
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
}: {
  tabs: WorkspaceTab[]
  active: WorkspaceTab
  onSelect: (tab: WorkspaceTab) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Workspace panels"
      className="flex gap-1 border-b border-border px-2 py-1.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={active === tab}
          onClick={() => onSelect(tab)}
          className={`rounded-[calc(var(--radius)*0.6)] px-2.5 py-1 text-[12.5px] capitalize ${
            active === tab
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {tab}
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
 * The files a session changed, and what changed in them.
 *
 * One list rather than a tree: a session's diff is a handful of files, and a
 * tree of three entries is a widget pretending there is more to navigate than
 * there is. The preview tab arrives later.
 */
function Panels({ session, files }: { session: SessionSummary | null; files: FileChange[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const autoOpened = useRef(false)

  // Open the first file when the list goes from empty to having something.
  // Later files arriving must not steal the file someone is already reading.
  useEffect(() => {
    if (files.length === 0) {
      autoOpened.current = false
      setOpen(null)
      return
    }

    if (!autoOpened.current) {
      autoOpened.current = true
      setOpen(files[0]!.path)
      return
    }

    setOpen((current) =>
      current && files.some((file) => file.path === current) ? current : files[0]!.path,
    )
  }, [files])

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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {files.map((file) => {
        const expanded = open === file.path

        return (
          <div key={file.path} className="border-b border-border last:border-b-0">
            <button
              onClick={() => setOpen(expanded ? null : file.path)}
              aria-expanded={expanded}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted"
            >
              {expanded ? (
                <ChevronDownIcon size={13} className="flex-none text-muted-foreground" />
              ) : (
                <ChevronRightIcon size={13} className="flex-none text-muted-foreground" />
              )}
              {/* The name leads and the directory trails: the name is what
                  someone is looking for, and paths are too long to lead with. */}
              <span className="truncate font-medium">{basename(file.path)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {dirname(file.path)}
              </span>
              <Badge file={file} />
            </button>

            {expanded && (
              <div className="overflow-x-auto border-t border-border py-1.5">
                <Diff file={file} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The shells open in this session.
 *
 * Attaching and detaching happens here rather than in `Terminal`: leaving the
 * panel should stop output reaching a component nobody is looking at, without
 * killing the process behind it.
 */
function TerminalPanel({
  session,
  terminals,
  onOpenTerminal,
  onAttachTerminal,
  onDetachTerminal,
  onTerminalInput,
  onTerminalResize,
  onCloseTerminal,
  onDrainTerminal,
}: TerminalProps & { session: SessionSummary | null }) {
  const [selected, setSelected] = useState<string | null>(null)

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
          No terminal is open. A shell here runs inside this session’s container.
        </p>
        <button
          onClick={() => onOpenTerminal(80, 24)}
          className="rounded-[calc(var(--radius)*0.6)] bg-muted px-2.5 py-1.5 text-[12.5px] font-medium hover:bg-border"
        >
          New terminal
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
            <button
              onClick={() => setSelected(tab.terminalId)}
              className={tab.exited ? 'py-1 text-muted-foreground line-through' : 'py-1'}
            >
              {tab.title}
            </button>
            <button
              onClick={() => onCloseTerminal(tab.terminalId)}
              aria-label={`Close terminal ${tab.title}`}
              className="grid size-5 place-items-center rounded-[calc(var(--radius)*0.5)] text-muted-foreground hover:bg-border hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}

        {tabs.length < MAX_TERMINALS && (
          <button
            onClick={() => onOpenTerminal(80, 24)}
            aria-label="New terminal"
            className="grid size-6 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            +
          </button>
        )}
      </div>

      {tabs.map((tab) => (
        <Terminal
          key={tab.terminalId}
          tab={tab}
          active={tab.terminalId === active?.terminalId}
          onInput={(data) => onTerminalInput(tab.terminalId, data)}
          onResize={(cols, rows) => onTerminalResize(tab.terminalId, cols, rows)}
          onDrain={() => onDrainTerminal(tab.terminalId)}
        />
      ))}
    </div>
  )
}

/** Whether a file was created, deleted, or edited — plus how much. */
function Badge({ file }: { file: FileChange }) {
  const [label, tone] =
    file.before === null
      ? ['new', 'text-added']
      : file.after === null
        ? ['deleted', 'text-removed']
        : ['edited', 'text-muted-foreground']

  const { added, removed } = changeCounts(file.before, file.after)

  return (
    <span className={`flex-none text-[11.5px] ${tone}`}>
      {label}
      {(added > 0 || removed > 0) && (
        <span className="ml-1.5 font-mono tabular-nums">
          {added > 0 && <span className="text-added">+{added}</span>}
          {added > 0 && removed > 0 && ' '}
          {removed > 0 && <span className="text-removed">−{removed}</span>}
        </span>
      )}
    </span>
  )
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}
