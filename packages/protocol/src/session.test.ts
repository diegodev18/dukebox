import { describe, expect, it } from 'vitest'
import {
  agentCapabilities,
  DEFAULT_GIT_PREFERENCES,
  DEFAULT_PERMISSION_MODE,
  EXIT_PLAN_MODE_ACTION,
  parseGitPreferences,
  permissionMode,
  resolvePermissionMode,
  reuseExistingPullRequest,
  sessionOpensPullRequests,
  sessionSummary,
} from '@/session'

const summary = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  agentId: 'claude-code',
  status: 'running',
  purpose: 'coding',
  title: 'A session',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 0,
  createdAt: 1,
  updatedAt: 1,
  lastSeq: 0,
  pullRequestUrl: null,
  environmentId: null,
  permissionMode: 'bypass',
} as const

describe('permissionMode', () => {
  it('accepts the four Claude Code modes Dukebox exposes', () => {
    for (const mode of ['bypass', 'plan', 'auto', 'acceptEdits'] as const) {
      expect(permissionMode.parse(mode)).toBe(mode)
    }
  })

  it('rejects Claude-native names the protocol does not use', () => {
    expect(permissionMode.safeParse('bypassPermissions').success).toBe(false)
    expect(permissionMode.safeParse('dontAsk').success).toBe(false)
    expect(permissionMode.safeParse('default').success).toBe(false)
  })

  it('defaults new Claude sessions to bypass', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('bypass')
  })

  it('starts environment setup in bypass even when the caller asked for plan', () => {
    expect(resolvePermissionMode('claude-code', 'environment_setup', 'plan')).toBe('bypass')
    expect(resolvePermissionMode('opencode', 'environment_setup', 'plan')).toBe('bypass')
    expect(resolvePermissionMode('grok-build', 'environment_setup', 'plan')).toBe('bypass')
    expect(resolvePermissionMode('claude-code', 'environment_setup')).toBe('bypass')
  })

  it('honours the requested mode for coding sessions', () => {
    expect(resolvePermissionMode('claude-code', 'coding', 'plan')).toBe('plan')
    expect(resolvePermissionMode('opencode', 'coding', 'auto')).toBe('auto')
    expect(resolvePermissionMode('grok-build', 'coding', 'plan')).toBe('plan')
    expect(resolvePermissionMode('claude-code', 'coding')).toBe('bypass')
    expect(resolvePermissionMode('grok-build', 'coding')).toBe('bypass')
  })

  it('stores no mode for agents that have none', () => {
    expect(resolvePermissionMode('fake', 'coding', 'plan')).toBeNull()
    expect(resolvePermissionMode('fake', 'environment_setup')).toBeNull()
  })

  it('names the plan-approval action distinctly from a tool', () => {
    expect(EXIT_PLAN_MODE_ACTION).toBe('exit_plan_mode')
  })
})

describe('agentCapabilities', () => {
  it('requires permissionModes so the UI can hide the picker', () => {
    const without = {
      permissions: true,
      thinking: true,
      resume: true,
      mcp: true,
      interrupt: true,
    }

    expect(agentCapabilities.safeParse(without).success).toBe(false)
    expect(agentCapabilities.parse({ ...without, permissionModes: true }).permissionModes).toBe(
      true,
    )
  })
})

describe('sessionSummary', () => {
  it('carries a permission mode', () => {
    expect(sessionSummary.parse(summary).permissionMode).toBe('bypass')
  })

  it('allows null when the agent has no modes', () => {
    expect(sessionSummary.parse({ ...summary, permissionMode: null }).permissionMode).toBeNull()
  })

  it('rejects a summary that omits the field', () => {
    const { permissionMode: _omitted, ...rest } = summary
    expect(sessionSummary.safeParse(rest).success).toBe(false)
  })

  it('defaults pullRequest to null when the client omits it', () => {
    expect(sessionSummary.parse(summary).pullRequest).toBeNull()
  })

  it('carries an opened pull request', () => {
    const parsed = sessionSummary.parse({
      ...summary,
      pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
      pullRequest: {
        url: 'https://github.com/diego/dukebox/pull/1',
        title: 'Add a health check',
        isDraft: true,
        state: 'open',
      },
    })
    expect(parsed.pullRequest?.isDraft).toBe(true)
    expect(parsed.pullRequest?.title).toBe('Add a health check')
  })
})

describe('gitPreferences', () => {
  it('matches Cursor defaults', () => {
    expect(DEFAULT_GIT_PREFERENCES).toMatchObject({
      createAsDraft: true,
      autoOpenDraft: true,
      commitOnTurnEnd: true,
      mergeMethod: 'squash',
      deleteBranchAfterMerge: true,
      prDescription: 'auto',
    })
  })

  it('fills missing keys from a partial row', () => {
    expect(parseGitPreferences({ autoOpenDraft: false }).autoOpenDraft).toBe(false)
    expect(parseGitPreferences({ autoOpenDraft: false }).createAsDraft).toBe(true)
  })

  it('falls back to defaults for garbage', () => {
    expect(parseGitPreferences('nope')).toEqual(DEFAULT_GIT_PREFERENCES)
  })
})

describe('session pull request destination', () => {
  it('reuses only an open pull request on the session branch', () => {
    expect(reuseExistingPullRequest('open')).toBe(true)
    expect(reuseExistingPullRequest('merged')).toBe(false)
    expect(reuseExistingPullRequest('closed')).toBe(false)
  })

  it('stops treating a merged session as a pull request destination', () => {
    expect(sessionOpensPullRequests(undefined)).toBe(true)
    expect(sessionOpensPullRequests('open')).toBe(true)
    expect(sessionOpensPullRequests('closed')).toBe(true)
    expect(sessionOpensPullRequests('merged')).toBe(false)
  })
})
