import type { SessionSummary } from '@dukebox/protocol'
import { useEffect, useState } from 'react'

/**
 * What the session is changing: files, diffs, a terminal, a preview.
 *
 * Collapsing it does not hide it. The question it answers — did anything
 * change, and how much — is worth keeping visible, so closed it becomes a list
 * of counts. Without a surface of its own it reads as a summary in the margin
 * rather than as a second sidebar competing with the one on the left.
 */

const COLLAPSED_KEY = 'dukebox:workspace-collapsed'

interface Props {
  session: SessionSummary | null
}

export function Workspace({ session }: Props) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === 'true')

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  return (
    <aside
      aria-label="Workspace"
      {...(collapsed ? { 'data-collapsed': true } : {})}
      className={`flex min-w-0 flex-col ${collapsed ? '' : 'border-l border-border bg-surface'}`}
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

      {collapsed ? <Metrics session={session} /> : <Panels session={session} />}
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
function Metrics({ session }: { session: SessionSummary | null }) {
  if (!session) return <div />

  return (
    <div className="flex flex-col px-2 pt-6 pb-3.5">
      <MetricLabel>Changes</MetricLabel>
      <Metric icon={<FileIcon />} label="Files" value={String(session.changedFileCount)} />

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

function Panels({ session }: { session: SessionSummary | null }) {
  if (!session) {
    return (
      <p className="px-4 py-4 text-[12.5px] text-muted-foreground">
        Select a session to see what it changed.
      </p>
    )
  }

  // Files, diffs, terminal, and preview arrive next.
  return <div className="flex-1 overflow-y-auto" />
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
