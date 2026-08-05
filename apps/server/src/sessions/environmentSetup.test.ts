import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_SETUP_PROMPT, parseEnvironmentProposalJson } from './environmentSetup.js'

describe('parseEnvironmentProposalJson', () => {
  it('accepts a valid proposal', () => {
    const proposal = parseEnvironmentProposalJson(
      JSON.stringify({
        setup: ['pnpm install'],
        env: { DATABASE_URL: { secret: true, description: 'Postgres' } },
        instructions: 'Run typecheck.',
      }),
    )

    expect(proposal.setup).toEqual(['pnpm install'])
    expect(proposal.env.DATABASE_URL?.secret).toBe(true)
    expect(proposal.instructions).toBe('Run typecheck.')
  })

  it('fills defaults for omitted fields', () => {
    expect(parseEnvironmentProposalJson('{}')).toEqual({ setup: [], env: {} })
  })

  it('rejects invalid JSON', () => {
    expect(() => parseEnvironmentProposalJson('{')).toThrow(/not valid JSON/)
  })

  it('rejects a non-object payload', () => {
    expect(() => parseEnvironmentProposalJson('"nope"')).toThrow()
  })
})

describe('ENVIRONMENT_SETUP_PROMPT', () => {
  it('points the agent at the proposal path', () => {
    expect(ENVIRONMENT_SETUP_PROMPT).toContain('/tmp/dukebox-env-proposal.json')
    expect(ENVIRONMENT_SETUP_PROMPT).toContain('Never invent')
  })
})
