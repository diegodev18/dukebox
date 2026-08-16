import type { DeviceRole, ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { useMemo, useState } from 'react'
import { AgentIcon, hasAgentIcon } from '@/components/AgentIcon'
import { BranchIcon, PlusIcon, SettingsIcon } from '@/components/icons'
import { Palette, PaletteOption } from '@/components/Palette'
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

  const groups = useMemo(
    () => searchPalette(query, filter, { sessions, projects, role }),
    [query, filter, sessions, projects, role],
  )
  const items = useMemo(() => flattenSearchGroups(groups), [groups])

  const runItem = (item: SearchItem) => {
    applySearchItem(item, sessions, { onSelect, onNewSession, onOpenSettings })
    onDismiss()
  }

  const emptyQuery = query.trim() === ''
  const modifier = shortcutModifier()

  return (
    <Palette
      title="Search"
      placeholder="Search sessions, repos, actions…"
      inputLabel="Search sessions, repos, actions"
      listboxLabel="Search results"
      query={query}
      onQueryChange={setQuery}
      resetKey={filter}
      itemCount={items.length}
      optionId={(index) => `search-item-${items[index]!.id}`}
      empty={emptyQuery ? 'Nothing to search yet.' : `No results for “${query.trim()}”.`}
      footer={
        <>
          <span>↑↓ Select</span>
          <span>↵ Open</span>
          <span>
            {modifier}⇧[ or {modifier}⇧] Change Filter
          </span>
        </>
      }
      tabs={{
        value: filter,
        options: SEARCH_FILTERS.map((id) => ({ id, label: SEARCH_FILTER_LABELS[id] })),
        onChange: (id) => setFilter(id as SearchFilter),
      }}
      onDismiss={onDismiss}
      onConfirm={(index) => {
        const item = items[index]
        if (item) runItem(item)
      }}
      onKeyDown={(event) => {
        const modifierKey = event.metaKey || event.ctrlKey
        if (
          modifierKey &&
          event.shiftKey &&
          (event.code === 'BracketLeft' || event.code === 'BracketRight')
        ) {
          event.preventDefault()
          setFilter((current) => cycleSearchFilter(current, event.code === 'BracketRight' ? 1 : -1))
          return true
        }
      }}
    >
      {({ selectedIndex, setSelectedIndex }) =>
        groups.map((group) => (
          <section key={group.id} className="px-1.5 py-1">
            <h3 className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {group.heading}
            </h3>
            {group.items.map((item) => {
              const index = items.findIndex((candidate) => candidate.id === item.id)
              return (
                <PaletteOption
                  key={item.id}
                  id={`search-item-${item.id}`}
                  active={selectedIndex === index}
                  onMouseEnter={() => {
                    if (index >= 0) setSelectedIndex(index)
                  }}
                  onClick={() => runItem(item)}
                >
                  <SearchItemIcon item={item} />
                  <SearchItemLabel item={item} />
                </PaletteOption>
              )
            })}
          </section>
        ))
      }
    </Palette>
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
