import { DEFAULT_GIT_PREFERENCES } from '@dukebox/protocol'
import { describe, expect, it, vi } from 'vitest'
import { writePullRequestContent } from './pr-writer.js'

const BASE = {
  prompt: 'Add a health check',
  commits: ['Added /health'],
  diffStat: ' src/app.ts | 12 ++++',
  changedFiles: ['src/app.ts'],
  sessionId: '00000000-0000-4000-8000-000000000000',
  branch: 'duke/abc',
  preferences: DEFAULT_GIT_PREFERENCES,
}

describe('writePullRequestContent', () => {
  it('falls back to the git heuristic when no secrets are configured', async () => {
    const result = await writePullRequestContent(BASE)
    expect(result.title).toBe('Added /health')
    expect(result.body).toContain('## Files changed')
  })

  it('skips the model when the preference is heuristic', async () => {
    const complete = vi.fn(async () => '{"title":"Nope","body":"Nope"}')
    const result = await writePullRequestContent({
      ...BASE,
      preferences: { ...DEFAULT_GIT_PREFERENCES, prDescription: 'heuristic' },
      complete,
    })
    expect(complete).not.toHaveBeenCalled()
    expect(result.title).toBe('Added /health')
  })

  it('uses the model JSON and keeps the file list', async () => {
    const result = await writePullRequestContent({
      ...BASE,
      complete: async () =>
        JSON.stringify({
          title: 'Add a /health endpoint',
          body: 'Expose liveness for the load balancer.',
        }),
      secrets: {
        get: async () =>
          JSON.stringify([
            {
              id: 'anthropic',
              kind: 'anthropic',
              name: 'Anthropic',
              apiKey: 'sk-ant-test',
              models: [{ id: 'claude-haiku-4-5', label: 'Haiku' }],
            },
          ]),
      } as never,
    })

    expect(result.title).toBe('Add a /health endpoint')
    expect(result.body).toContain('Expose liveness for the load balancer')
    expect(result.body).toContain('`src/app.ts`')
    expect(result.body).toContain('<details>')
  })

  it('falls back when the model returns garbage', async () => {
    const result = await writePullRequestContent({
      ...BASE,
      complete: async () => 'not json at all',
      secrets: {
        get: async () =>
          JSON.stringify([
            {
              id: 'openai',
              kind: 'openai',
              name: 'OpenAI',
              apiKey: 'sk-test',
              models: [{ id: 'gpt-4.1', label: 'GPT' }],
            },
          ]),
      } as never,
    })

    expect(result.title).toBe('Added /health')
  })
})
