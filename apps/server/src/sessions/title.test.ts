import { describe, expect, it, vi } from 'vitest'
import { titleFromPrompt, writeSessionTitle } from '@/sessions/title'

const LONG =
  'Can you please look at the login form and fix the bug where the submit button does not work on mobile devices when the keyboard is open?'

const secrets = {
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
} as never

describe('titleFromPrompt', () => {
  it('keeps a prompt that is already a short task name', () => {
    expect(titleFromPrompt('Fix the login bug')).toBe('Fix the login bug')
  })

  it('does not copy a conversational request as the title', () => {
    const title = titleFromPrompt(LONG)
    expect(title).not.toBe(LONG)
    expect(title).not.toBe(LONG.slice(0, 80))
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.toLowerCase().startsWith('can you')).toBe(false)
    expect(title.toLowerCase().startsWith('please')).toBe(false)
  })

  it('collapses whitespace and takes the first sentence', () => {
    expect(titleFromPrompt('  Add a health check. Then write tests.  ')).toBe('Add a health check')
  })

  it('returns a placeholder for an empty prompt', () => {
    expect(titleFromPrompt('   ')).toBe('New session')
  })
})

describe('writeSessionTitle', () => {
  it('falls back to the heuristic when no secrets are configured', async () => {
    const complete = vi.fn(async () => 'Nope')
    const title = await writeSessionTitle({ prompt: LONG, complete })
    expect(complete).not.toHaveBeenCalled()
    expect(title).toBe(titleFromPrompt(LONG))
  })

  it('uses the model title when one is returned', async () => {
    const title = await writeSessionTitle({
      prompt: LONG,
      complete: async () => 'Fix mobile login submit',
      secrets,
    })
    expect(title).toBe('Fix mobile login submit')
  })

  it('accepts a JSON object with a title field', async () => {
    const title = await writeSessionTitle({
      prompt: LONG,
      complete: async () => JSON.stringify({ title: 'Fix mobile login submit' }),
      secrets,
    })
    expect(title).toBe('Fix mobile login submit')
  })

  it('falls back to the heuristic when the model returns garbage', async () => {
    const title = await writeSessionTitle({
      prompt: LONG,
      complete: async () => '',
      secrets,
    })
    expect(title).toBe(titleFromPrompt(LONG))
  })

  it('falls back when the model throws', async () => {
    const title = await writeSessionTitle({
      prompt: 'Add a health check',
      complete: async () => {
        throw new Error('network')
      },
      secrets,
    })
    expect(title).toBe('Add a health check')
  })
})
