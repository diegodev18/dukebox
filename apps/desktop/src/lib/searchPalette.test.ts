import { describe, expect, it } from 'vitest'
import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { cycleSearchFilter, flattenSearchGroups, searchPalette } from '@/lib/searchPalette'

const project = (
  overrides: Partial<ProjectSummary> & Pick<ProjectSummary, 'id' | 'repoFullName'>,
): ProjectSummary => ({
  defaultBranch: 'main',
  environmentCount: 1,
  createdAt: 1,
  sessionCount: 1,
  ...overrides,
})

const session = (
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'projectId' | 'title'>,
): SessionSummary => ({
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
  ...overrides,
})

const dukebox = project({
  id: '11111111-1111-4111-8111-111111111111',
  repoFullName: 'diego/dukebox',
})
const site = project({ id: '22222222-2222-4222-8222-222222222222', repoFullName: 'diego/site' })
const notes = project({
  id: '33333333-3333-4333-8333-333333333333',
  repoFullName: 'diego/notes',
  sessionCount: 0,
})

const demux = session({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: dukebox.id,
  title: 'Fix the demux bug',
  branch: 'duke/fix-demux',
  updatedAt: 20,
})

const health = session({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectId: site.id,
  title: 'Add a health check',
  branch: 'duke/health',
  agentId: 'codex',
  updatedAt: 10,
})

const input = {
  sessions: [demux, health],
  projects: [dukebox, site, notes],
  role: 'owner' as const,
}

function groupItems(query: string, filter: Parameters<typeof searchPalette>[1] = 'all') {
  return Object.fromEntries(
    searchPalette(query, filter, input).map((group) => [
      group.id,
      group.items.map((item) => item.id),
    ]),
  )
}

describe('searchPalette', () => {
  it('orders sessions by recency when the query is blank', () => {
    const sessions = searchPalette('', 'all', input).find((group) => group.id === 'sessions')
    expect(sessions?.heading).toBe('Recent sessions')
    expect(sessions?.items.map((item) => item.kind === 'session' && item.session.id)).toEqual([
      demux.id,
      health.id,
    ])
  })

  it('keeps a repo with no sessions in the recents list', () => {
    expect(groupItems('')['repos']).toEqual([
      `repo:${dukebox.id}`,
      `repo:${site.id}`,
      `repo:${notes.id}`,
    ])
  })

  it('hides settings from All until someone types', () => {
    expect(groupItems('')['settings']).toBeUndefined()
    expect(groupItems('account')['settings']).toEqual(['settings:account'])
  })

  it('finds a repo that has no matching session', () => {
    const groups = groupItems('notes')
    expect(groups['sessions']).toBeUndefined()
    expect(groups['repos']).toEqual([`repo:${notes.id}`])
  })

  it('finds a session by title', () => {
    expect(groupItems('health')['sessions']).toEqual([`session:${health.id}`])
  })

  it('restricts results to the active filter', () => {
    expect(groupItems('', 'repos')['sessions']).toBeUndefined()
    expect(groupItems('', 'repos')['repos']).toHaveLength(3)
    expect(groupItems('', 'actions')['actions']).toEqual(['action:new-session'])
    expect(groupItems('', 'settings')['settings']).toContain('settings:account')
  })

  it('hides owner-only settings from a paired device', () => {
    const groups = searchPalette('', 'settings', { ...input, role: 'member' })
    const ids = groups.find((group) => group.id === 'settings')?.items.map((item) => item.id)
    expect(ids).not.toContain('settings:agents')
    expect(ids).not.toContain('settings:devices')
    expect(ids).toContain('settings:account')
  })
})

describe('cycleSearchFilter', () => {
  it('wraps around the tab list', () => {
    expect(cycleSearchFilter('all', 1)).toBe('sessions')
    expect(cycleSearchFilter('settings', 1)).toBe('all')
    expect(cycleSearchFilter('all', -1)).toBe('settings')
  })
})

describe('flattenSearchGroups', () => {
  it('walks groups in display order', () => {
    const ids = flattenSearchGroups(searchPalette('diego', 'all', input)).map((item) => item.id)
    expect(ids[0]).toBe(`session:${demux.id}`)
    expect(ids).toContain(`repo:${notes.id}`)
  })
})
