import { describe, expect, it } from 'vitest'
import type { ProjectSummary, SessionSummary } from '@dukebox/protocol'
import { filterProjects, filterSessions, matchSession } from './searchSessions.js'

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
  ...overrides,
})

const dukebox = project({
  id: '11111111-1111-4111-8111-111111111111',
  repoFullName: 'diego/dukebox',
})
const site = project({ id: '22222222-2222-4222-8222-222222222222', repoFullName: 'diego/site' })

const demux = session({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: dukebox.id,
  title: 'Fix the demux bug',
  branch: 'duke/fix-demux',
})

const health = session({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  projectId: site.id,
  title: 'Add a health check',
  branch: 'duke/health',
  agentId: 'codex',
})

describe('matchSession', () => {
  it('matches everything when the query is blank', () => {
    expect(matchSession('', { session: demux, project: dukebox })).toBe(true)
    expect(matchSession('   ', { session: demux, project: dukebox })).toBe(true)
  })

  it('matches a title substring, ignoring case', () => {
    expect(matchSession('DEMUX', { session: demux, project: dukebox })).toBe(true)
    expect(matchSession('health', { session: demux, project: dukebox })).toBe(false)
  })

  it('matches a branch name', () => {
    expect(matchSession('fix-demux', { session: demux, project: dukebox })).toBe(true)
  })

  it('matches the repository the session belongs to', () => {
    expect(matchSession('dukebox', { session: demux, project: dukebox })).toBe(true)
    expect(matchSession('site', { session: demux, project: dukebox })).toBe(false)
  })

  it('matches the agent id', () => {
    expect(matchSession('codex', { session: health, project: site })).toBe(true)
  })

  it('still matches when the project is unknown', () => {
    // A session whose project has not loaded yet should not vanish from a
    // title search just because the join failed.
    expect(matchSession('demux', { session: demux, project: undefined })).toBe(true)
    expect(matchSession('dukebox', { session: demux, project: undefined })).toBe(false)
  })
})

describe('filterSessions', () => {
  const sessions = [demux, health]
  const projects = [dukebox, site]

  it('returns every session for an empty query', () => {
    expect(filterSessions('', sessions, projects)).toEqual(sessions)
  })

  it('keeps only the sessions that match', () => {
    expect(filterSessions('health', sessions, projects)).toEqual([health])
  })

  it('finds sessions through their repository name', () => {
    expect(filterSessions('diego/dukebox', sessions, projects)).toEqual([demux])
  })
})

describe('filterProjects', () => {
  const sessions = [demux, health]
  const projects = [dukebox, site]

  it('drops projects whose sessions were all filtered out', () => {
    // Leaving an empty group under a repository name is noise: the person
    // asked for matching sessions, not for places that happen to have none.
    expect(filterProjects('health', projects, sessions)).toEqual([site])
  })

  it('preserves the original project order', () => {
    expect(filterProjects('', projects, sessions)).toEqual(projects)
  })
})
