import type { FileChange, SessionSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'
import { Diff } from './Diff.js'

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

interface Props {
  session: SessionSummary | null
  /** What the session has changed so far, folded from the event stream. */
  files: FileChange[]
}

export function Workspace({ session, files }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

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
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand workspace' : 'Collapse workspace'}
          className="grid size-6.5 place-items-center rounded-[calc(var(--radius)*0.6)] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronIcon flipped={collapsed} />
        </button>
      </header>

      {collapsed ? (
        <Metrics session={session} files={files} />
      ) : (
        <Panels session={session} files={files} />
      )}
    </aside>
  )
}

/**
 * The counts that summarise a closed workspace.
 *
 * Rows with a label, not a column of bare numbers: a number alone needs a
 * caption to mean anything, and stacking the two doubles the height for no
 * more information than a line gives.
 */
function Metrics({ session, files }: { session: SessionSummary | null; files: FileChange[] }) {
  if (!session) return <div />

  // Counted from the live stream rather than the session summary, which only
  // refreshes when the server sends a new one — a count that lags the diff
  // beside it is worse than no count.
  const changed = files.length || session.changedFileCount

  return (
    <div className="flex flex-col px-2 pt-6 pb-3.5">
      <MetricLabel>Changes</MetricLabel>
      <Metric icon={<FileIcon />} label="Files" value={String(changed)} />

      <MetricLabel>On {session.branch || session.baseBranch}</MetricLabel>
      <Metric icon={<CommitIcon />} label="Turns" value={String(session.lastSeq)} />
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

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <button className="flex w-full min-w-0 items-center gap-2.5 rounded-[calc(var(--radius)*0.6)] px-2.5 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
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
 * there is. The terminal and preview tabs arrive later.
 */
function Panels({ session, files }: { session: SessionSummary | null; files: FileChange[] }) {
  const [open, setOpen] = useState<string | null>(null)

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
    <div className="flex-1 overflow-y-auto">
      {files.map((file) => {
        const expanded = open === file.path

        return (
          <div key={file.path} className="border-b border-border last:border-b-0">
            <button
              onClick={() => setOpen(expanded ? null : file.path)}
              aria-expanded={expanded}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-muted"
            >
              <RowChevron open={expanded} />
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

/** Whether a file was created, deleted, or edited. */
function Badge({ file }: { file: FileChange }) {
  const [label, tone] =
    file.before === null
      ? ['new', 'text-added']
      : file.after === null
        ? ['deleted', 'text-removed']
        : ['edited', 'text-muted-foreground']

  return <span className={`flex-none text-[11.5px] ${tone}`}>{label}</span>
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirname(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function ChevronIcon({ flipped }: { flipped: boolean }) {
  return (
    <svg
      className={`size-3.25 ${flipped ? 'rotate-180' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m10 4-4 4 4 4" />
    </svg>
  )
}

/**
 * The disclosure arrow on a file row.
 *
 * Points right when closed and down when open — the direction people read as
 * "there is more inside". `ChevronIcon` points left, because it collapses the
 * panel toward the edge of the window, which is a different gesture.
 */
function RowChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`size-3.25 flex-none text-muted-foreground ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 4 4 4-4 4" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      className="size-3.25"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 2.5h6.5L13 6v7.5H3z" />
      <path d="M9.5 2.5V6H13" />
    </svg>
  )
}

function CommitIcon() {
  return (
    <svg
      className="size-3.25"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.6" />
      <path d="M2.5 8h2.9M10.6 8h2.9" />
    </svg>
  )
}
