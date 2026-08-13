import type { DeviceRole, ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentIcon, hasAgentIcon } from '@/components/AgentIcon'
import { BranchIcon, PlusIcon, SearchIcon, SettingsIcon } from '@/components/icons'
import {
  cycleSearchFilter,
  flattenSearchGroups,
  SEARCH_FILTER_LABELS,
  SEARCH_FILTERS,
  searchPalette,
  type SearchFilter,
  type SearchItem,
} from '@/lib/searchPalette'
import { relativeAge } from '@/lib/relativeTime'
import type { SettingsCategory } from '@/lib/settingsCategories'

/**
 * Jump to a session, repo, action, or settings page from one place.
 *
 * The sidebar used to swap its header for an inline filter, which hid New
 * session and only searched the list underneath. A palette can land on more
 * than sessions, and it does not have to steal the nav while it is open.
 */

interface Props {
  sessions: SessionSummary[]
  projects: ProjectSummary[]
  role: DeviceRole | null
  onSelect: (sessionId: string) => void
  onNewSession: (projectId?: string) => void
  onOpenSettings: (category: SettingsCategory) => void
  onDismiss: () => void
}

export function SearchPalette({
  sessions,
  projects,
  role,
  onSelect,
  onNewSession,
  onOpenSettings,
  onDismiss,
}: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const groups = useMemo(
    () => searchPalette(query, filter, { sessions, projects, role }),
    [query, filter, sessions, projects, role],
  )
  const items = useMemo(() => flattenSearchGroups(groups), [groups])
  const selected = items[selectedIndex] ?? null

  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectedIndexRef = useRef(selectedIndex)
  const itemsRef = useRef(items)
  const filterRef = useRef(filter)
  const dismiss = useRef(onDismiss)
  const runItem = useRef<(item: SearchItem) => void>(() => undefined)

  selectedIndexRef.current = selectedIndex
  itemsRef.current = items
  filterRef.current = filter
  dismiss.current = onDismiss
  runItem.current = (item) => {
    applySearchItem(item, sessions, { onSelect, onNewSession, onOpenSettings })
    onDismiss()
  }

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, filter])

  useEffect(() => {
    const node = panel.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedIndex, items])

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

      const modifier = event.metaKey || event.ctrlKey
      if (
        modifier &&
        event.shiftKey &&
        (event.code === 'BracketLeft' || event.code === 'BracketRight')
      ) {
        event.preventDefault()
        setFilter(cycleSearchFilter(filterRef.current, event.code === 'BracketRight' ? 1 : -1))
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedIndex((current) => {
          const last = Math.max(0, itemsRef.current.length - 1)
          return Math.min(last, current + 1)
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedIndex((current) => Math.max(0, current - 1))
        return
      }

      if (event.key === 'Enter') {
        const item = itemsRef.current[selectedIndexRef.current]
        if (!item) return
        event.preventDefault()
        runItem.current(item)
        return
      }

      if (event.key !== 'Tab') return

      const nodes = focusable()
      if (nodes.length === 0) {
        event.preventDefault()
        panel.current?.focus()
        return
      }

      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
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

  const emptyQuery = query.trim() === ''
  const modifier = shortcutModifier()

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-palette-title"
        tabIndex={-1}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-[calc(var(--radius)*1.1)] border border-border bg-background/95 shadow-lg outline-none backdrop-blur-md"
      >
        <h2 id="search-palette-title" className="sr-only">
          Search
        </h2>

        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <span className="text-muted-foreground">
            <SearchIcon size={16} />
          </span>
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions, repos, actions…"
            aria-label="Search sessions, repos, actions"
            aria-controls="search-palette-results"
            aria-activedescendant={selected ? `search-item-${selected.id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          role="tablist"
          aria-label="Filter"
          className="flex flex-wrap gap-1 border-b border-border px-3 py-2"
        >
          {SEARCH_FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              onClick={() => {
                setFilter(id)
                input.current?.focus()
              }}
              className={`rounded-full px-2.5 py-0.5 text-[12px] ${
                filter === id
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
              }`}
            >
              {SEARCH_FILTER_LABELS[id]}
            </button>
          ))}
        </div>

        <div
          id="search-palette-results"
          role="listbox"
          aria-label="Search results"
          className="min-h-0 max-h-[min(24rem,50vh)] flex-1 overflow-y-auto py-1.5"
        >
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
              {emptyQuery ? 'Nothing to search yet.' : `No results for “${query.trim()}”.`}
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="px-1.5 py-1">
                <h3 className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {group.heading}
                </h3>
                {group.items.map((item) => {
                  const active = selected?.id === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      id={`search-item-${item.id}`}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => {
                        const index = items.findIndex((candidate) => candidate.id === item.id)
                        if (index >= 0) setSelectedIndex(index)
                      }}
                      onClick={() => runItem.current(item)}
                      className={`flex w-full items-center gap-2.5 rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] ${
                        active ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60'
                      }`}
                    >
                      <span
                        className={`size-1.5 flex-none rounded-full ${active ? 'bg-primary' : 'bg-transparent'}`}
                      />
                      <SearchItemIcon item={item} />
                      <SearchItemLabel item={item} />
                    </button>
                  )
                })}
              </section>
            ))
          )}
        </div>

        <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ Select</span>
          <span>↵ Open</span>
          <span>
            {modifier}⇧[ or {modifier}⇧] Change Filter
          </span>
        </div>
      </div>
    </div>
  )
}

function applySearchItem(
  item: SearchItem,
  sessions: SessionSummary[],
  actions: {
    onSelect: (sessionId: string) => void
    onNewSession: (projectId?: string) => void
    onOpenSettings: (category: SettingsCategory) => void
  },
) {
  switch (item.kind) {
    case 'session':
      actions.onSelect(item.session.id)
      return
    case 'repo': {
      const latest = sessions
        .filter((session) => session.projectId === item.project.id)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (latest) actions.onSelect(latest.id)
      else actions.onNewSession(item.project.id)
      return
    }
    case 'action':
      actions.onNewSession()
      return
    case 'settings':
      actions.onOpenSettings(item.category)
  }
}

function SearchItemIcon({ item }: { item: SearchItem }) {
  switch (item.kind) {
    case 'session':
      return hasAgentIcon(item.session.agentId) ? (
        <AgentIcon agentId={item.session.agentId} className="size-3.5" />
      ) : (
        <span className="size-3.5 flex-none rounded-full bg-muted" />
      )
    case 'repo':
      return (
        <span className="text-muted-foreground">
          <BranchIcon size={14} />
        </span>
      )
    case 'action':
      return (
        <span className="text-muted-foreground">
          <PlusIcon size={14} />
        </span>
      )
    case 'settings':
      return (
        <span className="text-muted-foreground">
          <SettingsIcon size={14} />
        </span>
      )
  }
}

function SearchItemLabel({ item }: { item: SearchItem }) {
  switch (item.kind) {
    case 'session':
      return (
        <>
          <span className="min-w-0 flex-1 truncate font-medium">{item.session.title}</span>
          {item.project && (
            <span className="max-w-[40%] truncate text-[12px] text-muted-foreground">
              {item.project.repoFullName}
            </span>
          )}
          <span className="flex-none text-[11.5px] tabular-nums text-muted-foreground">
            {relativeAge(item.session.updatedAt)}
          </span>
        </>
      )
    case 'repo':
      return <span className="min-w-0 flex-1 truncate">{item.project.repoFullName}</span>
    case 'action':
    case 'settings':
      return <span className="min-w-0 flex-1 truncate">{item.label}</span>
  }
}

function shortcutModifier(): string {
  if (typeof navigator === 'undefined') return 'Ctrl'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
}
