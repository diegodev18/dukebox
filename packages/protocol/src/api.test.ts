import { describe, expect, it } from 'vitest'
import {
  createSessionRequest,
  createEnvironmentRequest,
  updateEnvironmentRequest,
  reorderEnvironmentsRequest,
} from './api.js'

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

  it('accepts a permission mode', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      permissionMode: 'plan',
    })
    expect(parsed.permissionMode).toBe('plan')
  })

  it('omits permission mode when the caller did not pick one', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.permissionMode).toBeUndefined()
  })

  it('accepts remote control at start', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
      remoteControl: true,
    })
    expect(parsed.remoteControl).toBe(true)
  })

  it('omits remote control when the caller did not ask', () => {
    const parsed = createSessionRequest.parse({
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      prompt: 'fix it',
    })
    expect(parsed.remoteControl).toBeUndefined()
  })
})

describe('environment schemas', () => {
  it('accepts a valid create request', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Refactors',
      branchPattern: 'refact/*',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty name', () => {
    expect(createEnvironmentRequest.safeParse({ name: '', branchPattern: '**' }).success).toBe(
      false,
    )
  })

  it('rejects a branch pattern over the length cap', () => {
    const parsed = createEnvironmentRequest.safeParse({
      name: 'Long',
      branchPattern: 'a'.repeat(201),
    })
    expect(parsed.success).toBe(false)
  })

  it('allows a partial update', () => {
    expect(updateEnvironmentRequest.safeParse({ name: 'Renamed' }).success).toBe(true)
    expect(updateEnvironmentRequest.safeParse({ branchPattern: '**' }).success).toBe(true)
  })

  it('requires at least one uuid to reorder', () => {
    expect(reorderEnvironmentsRequest.safeParse({ ids: [] }).success).toBe(false)
    expect(
      reorderEnvironmentsRequest.safeParse({ ids: ['3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f'] })
        .success,
    ).toBe(true)
  })
})

describe('createSessionRequest environmentId', () => {
  it('accepts an optional environment id', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
      environmentId: '5c2d4e6a-1b3c-4d5e-8f9a-0b1c2d3e4f5a',
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts its absence', () => {
    const parsed = createSessionRequest.safeParse({
      projectId: '3f1e4c1e-0b6e-4d3a-9a5f-9a1b2c3d4e5f',
      agentId: 'claude-code',
      prompt: 'do a thing',
    })
    expect(parsed.success).toBe(true)
  })
})
