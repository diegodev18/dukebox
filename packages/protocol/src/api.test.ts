import { describe, expect, it } from 'vitest'
import { createSessionRequest } from './api.js'

describe('createSessionRequest', () => {
  it('requires a prompt for coding sessions', () => {
    expect(
      createSessionRequest.safeParse({
        projectId: '00000000-0000-4000-8000-000000000001',
        agentId: 'claude-code',
      }).success,
    ).toBe(false)
  })

  it('allows environment_setup without a prompt', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      purpose: 'environment_setup',
    })
    expect(parsed.purpose).toBe('environment_setup')
  })

  it('defaults purpose to coding', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.purpose).toBe('coding')
  })
})
