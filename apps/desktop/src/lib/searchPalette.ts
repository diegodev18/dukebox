import type { DeviceRole, ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { matchProject, matchSession } from '@/lib/searchSessions'
import { settingsCategoriesFor, type SettingsCategory } from '@/lib/settingsCategories'

/**
 * What the command palette can land on, built from lists the session screen
 * already has. Matching stays local: a round trip would only add latency for
 * a filter that fits in memory.
 */

export const SEARCH_FILTERS = [
  'all',
  'sessions',
  'archived',
  'repos',
  'actions',
  'settings',
] as const

export type SearchFilter = (typeof SEARCH_FILTERS)[number]

export const SEARCH_FILTER_LABELS: Record<SearchFilter, string> = {
  all: 'All',
  sessions: 'Sessions',
  archived: 'Archived',
  repos: 'Repos',
  actions: 'Actions',
  settings: 'Settings',
}

export type SearchAction =
  'new-session' | 'new-session-on-repo' | 'manage-environments' | 'archive-session'

export type SearchItem =
  | {
      kind: 'session'
      id: string
      session: SessionSummary
      project: ProjectSummary | undefined
    }
  | { kind: 'repo'; id: string; project: ProjectSummary }
  | {
      kind: 'action'
      id: string
      action: SearchAction
      label: string
      projectId?: string
      sessionId?: string
    }
  | { kind: 'settings'; id: string; category: SettingsCategory; label: string }

export type SearchGroupId = 'sessions' | 'repos' | 'actions' | 'settings'

export interface SearchGroup {
  id: SearchGroupId
  heading: string
  items: SearchItem[]
}

const NEW_SESSION: Extract<SearchItem, { kind: 'action' }> = {
  kind: 'action',
  id: 'action:new-session',
  action: 'new-session',
  label: 'New session',
}

export function cycleSearchFilter(filter: SearchFilter, direction: 1 | -1): SearchFilter {
  const index = SEARCH_FILTERS.indexOf(filter)
  const next = (index + direction + SEARCH_FILTERS.length) % SEARCH_FILTERS.length
  return SEARCH_FILTERS[next]!
}

export function flattenSearchGroups(groups: SearchGroup[]): SearchItem[] {
  return groups.flatMap((group) => group.items)
}

/**
 * Grouped hits for the current query and tab.
 *
 * An empty query is a recents list, not "match everything": settings stay
 * out of All until someone types, so the first screen is sessions and repos.
 */
export function searchPalette(
  query: string,
  filter: SearchFilter,
  input: {
    sessions: SessionSummary[]
    archivedSessions?: SessionSummary[]
    projects: ProjectSummary[]
    role: DeviceRole | null
    selectedSessionId?: string | null
    selectedProjectId?: string | null
  },
): SearchGroup[] {
  const byId = new Map(input.projects.map((project) => [project.id, project]))
  const typed = query.trim() !== ''
  const groups: SearchGroup[] = []

  if (filter === 'all' || filter === 'sessions') {
    const items = [...input.sessions]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((session) => matchSession(query, { session, project: byId.get(session.projectId) }))
      .map((session): SearchItem => ({
        kind: 'session',
        id: `session:${session.id}`,
        session,
        project: byId.get(session.projectId),
      }))

    if (items.length > 0) {
      groups.push({
        id: 'sessions',
        heading: typed ? 'Sessions' : 'Recent sessions',
        items,
      })
    }
  }

  if (filter === 'archived') {
    const items = [...(input.archivedSessions ?? [])]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .filter((session) => matchSession(query, { session, project: byId.get(session.projectId) }))
      .map((session): SearchItem => ({
        kind: 'session',
        id: `session:${session.id}`,
        session,
        project: byId.get(session.projectId),
      }))

    if (items.length > 0) {
      groups.push({
        id: 'sessions',
        heading: 'Archived',
        items,
      })
    }
  }

  if (filter === 'all' || filter === 'repos') {
    const items = input.projects
      .filter((project) => matchProject(query, project))
      .map((project): SearchItem => ({
        kind: 'repo',
        id: `repo:${project.id}`,
        project,
      }))

    if (items.length > 0) {
      groups.push({ id: 'repos', heading: 'Repos', items })
    }
  }

  if (filter === 'all' || filter === 'actions') {
    const items = actionItems(query, input)
    if (items.length > 0) {
      groups.push({ id: 'actions', heading: 'Actions', items })
    }
  }

  const showSettings = filter === 'settings' || (filter === 'all' && typed)
  if (showSettings) {
    const items = settingsCategoriesFor(input.role)
      .filter((category) => includes(query, category.label, category.id))
      .map((category): SearchItem => ({
        kind: 'settings',
        id: `settings:${category.id}`,
        category: category.id,
        label: category.label,
      }))

    if (items.length > 0) {
      groups.push({ id: 'settings', heading: 'Settings', items })
    }
  }

  return groups
}

function actionItems(
  query: string,
  input: {
    sessions: SessionSummary[]
    projects: ProjectSummary[]
    selectedSessionId?: string | null
    selectedProjectId?: string | null
  },
): SearchItem[] {
  const items: SearchItem[] = []
  if (matchAction(query, NEW_SESSION)) items.push(NEW_SESSION)

  const typed = query.trim() !== ''
  const matchedRepos = input.projects.filter((project) => matchProject(query, project))
  const filteredRepo = typed && matchedRepos.length === 1 ? matchedRepos[0] : undefined
  const selectedRepo = input.selectedProjectId
    ? input.projects.find((project) => project.id === input.selectedProjectId)
    : undefined
  const repo = filteredRepo ?? selectedRepo

  if (repo) {
    const onRepo: Extract<SearchItem, { kind: 'action' }> = {
      kind: 'action',
      id: 'action:new-session-on-repo',
      action: 'new-session-on-repo',
      label: 'New session on this repo',
      projectId: repo.id,
    }
    const manage: Extract<SearchItem, { kind: 'action' }> = {
      kind: 'action',
      id: 'action:manage-environments',
      action: 'manage-environments',
      label: 'Manage environments',
      projectId: repo.id,
    }
    const forced = filteredRepo !== undefined
    if (forced || matchAction(query, onRepo)) items.push(onRepo)
    if (forced || matchAction(query, manage)) items.push(manage)
  }

  const selected = input.selectedSessionId
    ? input.sessions.find((session) => session.id === input.selectedSessionId)
    : undefined
  if (selected) {
    const archive: Extract<SearchItem, { kind: 'action' }> = {
      kind: 'action',
      id: 'action:archive-session',
      action: 'archive-session',
      label: 'Archive current session',
      sessionId: selected.id,
    }
    if (matchAction(query, archive)) items.push(archive)
  }

  return items
}

function matchAction(query: string, action: Extract<SearchItem, { kind: 'action' }>): boolean {
  return includes(query, action.label)
}

function includes(query: string, ...parts: string[]): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return parts.some((part) => part.toLowerCase().includes(needle))
}
