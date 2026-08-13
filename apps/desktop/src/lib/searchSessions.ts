import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'

/**
 * Which sessions match a query, and which projects still have something to show.
 *
 * Matching is local and substring-based: the sidebar already has every session,
 * and a round trip for a filter that fits in memory would only add latency.
 * Title, branch, and repository are the fields a person looks at in the list —
 * searching an id they never see would find things they cannot recognise.
 */

export interface SearchableSession {
  session: SessionSummary
  project: ProjectSummary | undefined
}

export function matchSession(query: string, entry: SearchableSession): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true

  const haystack = [
    entry.session.title,
    entry.session.branch,
    entry.session.agentId,
    entry.project?.repoFullName,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .toLowerCase()

  return haystack.includes(needle)
}

/**
 * A repository is its own search hit in the palette, even when none of its
 * sessions match — unlike the sidebar filter, which hid empty groups.
 */
export function matchProject(query: string, project: ProjectSummary): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return project.repoFullName.toLowerCase().includes(needle)
}

export function filterSessions(
  query: string,
  sessions: SessionSummary[],
  projects: ProjectSummary[],
): SessionSummary[] {
  const byId = new Map(projects.map((project) => [project.id, project]))

  return sessions.filter((session) =>
    matchSession(query, { session, project: byId.get(session.projectId) }),
  )
}

/**
 * Projects that still have a matching session, in the order they were given.
 *
 * An empty project group after a filter is noise: the person asked for
 * sessions, not for repositories that happen to contain none of them.
 */
export function filterProjects(
  query: string,
  projects: ProjectSummary[],
  sessions: SessionSummary[],
): ProjectSummary[] {
  const matched = new Set(
    filterSessions(query, sessions, projects).map((session) => session.projectId),
  )
  return projects.filter((project) => matched.has(project.id))
}
