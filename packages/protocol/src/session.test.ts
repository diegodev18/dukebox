import { describe, expect, it } from 'vitest'
import {
  agentCapabilities,
  DEFAULT_PERMISSION_MODE,
  EXIT_PLAN_MODE_ACTION,
  permissionMode,
  sessionSummary,
} from './session.js'

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
  remoteControlUrl: null,
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

  it('names the plan-approval action distinctly from a tool', () => {
    expect(EXIT_PLAN_MODE_ACTION).toBe('exit_plan_mode')
  })
})

describe('agentCapabilities', () => {
  it('requires permissionModes and remoteControl so the UI can hide those controls', () => {
    const without = {
      permissions: true,
      thinking: true,
      resume: true,
      mcp: true,
      interrupt: true,
    }

    expect(agentCapabilities.safeParse(without).success).toBe(false)
    expect(
      agentCapabilities.parse({ ...without, permissionModes: true, remoteControl: false })
        .permissionModes,
    ).toBe(true)
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

  it('carries a remote control URL', () => {
    expect(
      sessionSummary.parse({
        ...summary,
        remoteControlUrl: 'https://claude.ai/code/session_01ABC',
      }).remoteControlUrl,
    ).toBe('https://claude.ai/code/session_01ABC')
  })

  it('allows a null remote control URL when it is off', () => {
    expect(sessionSummary.parse(summary).remoteControlUrl).toBeNull()
  })
})
