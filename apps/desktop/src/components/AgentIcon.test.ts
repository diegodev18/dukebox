import { describe, expect, it } from 'vitest'
import {
  coercePermissionMode,
  permissionModeLabel,
  permissionModesForAgent,
} from '@/components/AgentIcon'

describe('permissionModesForAgent', () => {
  it('keeps Claude Code on the four permission modes', () => {
    expect(permissionModesForAgent('claude-code').map((mode) => mode.id)).toEqual([
      'plan',
      'auto',
      'acceptEdits',
      'bypass',
    ])
    expect(permissionModeLabel('bypass', 'claude-code')).toBe('Bypass')
  })

  it('maps OpenCode onto Plan and Build', () => {
    expect(permissionModesForAgent('opencode').map((mode) => mode.id)).toEqual(['plan', 'bypass'])
    expect(permissionModeLabel('bypass', 'opencode')).toBe('Build')
    expect(permissionModeLabel('plan', 'opencode')).toBe('Plan')
  })
})

describe('coercePermissionMode', () => {
  it('keeps modes the agent actually exposes', () => {
    expect(coercePermissionMode('opencode', 'plan')).toBe('plan')
    expect(coercePermissionMode('opencode', 'bypass')).toBe('bypass')
    expect(coercePermissionMode('claude-code', 'auto')).toBe('auto')
  })

  it('falls back to bypass for Claude-only modes on OpenCode', () => {
    expect(coercePermissionMode('opencode', 'auto')).toBe('bypass')
    expect(coercePermissionMode('opencode', 'acceptEdits')).toBe('bypass')
  })

  it('defaults a missing mode to bypass', () => {
    expect(coercePermissionMode('opencode', null)).toBe('bypass')
    expect(coercePermissionMode('claude-code', undefined)).toBe('bypass')
  })
})
