import type { Session } from '@dukebox/db'
import { describe, expect, it } from 'vitest'
import { toSummary } from '@/sessions/summarize'

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    agentId: 'claude-code',
    status: 'running',
    purpose: 'coding',
    title: 'A session',
    prompt: '',
    branch: 'duke/abc',
    baseBranch: 'main',
    baseCommit: 'abc123',
    changedFileCount: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:01Z'),
    lastSeq: 0,
    prUrl: null,
    prTitle: null,
    prDraft: null,
    prState: null,
    environmentId: null,
    permissionMode: null,
    containerId: null,
    agentSessionId: null,
    createdByDeviceId: null,
    archivedAt: null,
    model: null,
    gitPreferences: null,
    ...overrides,
  } as Session
}

describe('toSummary', () => {
  it('defaults Claude Code, OpenCode, and Grok Build without a stored mode to bypass', () => {
    expect(toSummary(row({ agentId: 'claude-code', permissionMode: null })).permissionMode).toBe(
      'bypass',
    )
    expect(toSummary(row({ agentId: 'opencode', permissionMode: null })).permissionMode).toBe(
      'bypass',
    )
    expect(toSummary(row({ agentId: 'grok-build', permissionMode: null })).permissionMode).toBe(
      'bypass',
    )
  })

  it('leaves agents without modes at null', () => {
    expect(toSummary(row({ agentId: 'fake', permissionMode: null })).permissionMode).toBeNull()
  })

  it('carries the stored permission mode', () => {
    expect(toSummary(row({ permissionMode: 'plan' })).permissionMode).toBe('plan')
  })

  it('returns no pull request until one is opened', () => {
    expect(toSummary(row()).pullRequest).toBeNull()
  })

  it('falls back to open when the stored PR state is unreadable', () => {
    const summary = toSummary(
      row({
        prUrl: 'https://github.com/diego/dukebox/pull/1',
        prTitle: 'Add a thing',
        prDraft: false,
        prState: 'not-a-state',
      }),
    )

    expect(summary.pullRequest).toEqual({
      url: 'https://github.com/diego/dukebox/pull/1',
      title: 'Add a thing',
      isDraft: false,
      state: 'open',
    })
  })

  it('carries the base commit', () => {
    expect(toSummary(row({ baseCommit: 'deadbeef' })).baseCommit).toBe('deadbeef')
    expect(toSummary(row({ baseCommit: null })).baseCommit).toBeNull()
  })
})
