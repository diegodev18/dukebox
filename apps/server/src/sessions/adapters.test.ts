import { describe, expect, it } from 'vitest'
import { createAgentAdapter, SessionError } from '@/sessions/manager'

describe('createAgentAdapter', () => {
  it('returns Claude Code for claude-code', () => {
    expect(createAgentAdapter('claude-code').id).toBe('claude-code')
  })

  it('returns OpenCode for opencode', () => {
    expect(createAgentAdapter('opencode').id).toBe('opencode')
  })

  it('returns Grok Build for grok-build', () => {
    expect(createAgentAdapter('grok-build').id).toBe('grok-build')
  })

  it('rejects an agent that has no adapter', () => {
    expect(() => createAgentAdapter('codex')).toThrow(SessionError)
    expect(() => createAgentAdapter('codex')).toThrow('no adapter for agent: codex')
  })
})
