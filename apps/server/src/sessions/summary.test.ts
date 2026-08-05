import type { AgentEvent, EnvelopedEvent } from '@dukebox/protocol'
import { describe, expect, it } from 'vitest'
import { pullRequestContent } from './summary.js'

const SESSION = '00000000-0000-4000-8000-000000000000'
let seq = 0

function at(event: AgentEvent): EnvelopedEvent {
  return { seq: (seq += 1), sessionId: SESSION, ts: Date.now(), event }
}

function said(...parts: string[]): EnvelopedEvent[] {
  return parts.map((delta) => at({ type: 'assistant_text', delta }))
}

function content(options: Partial<Parameters<typeof pullRequestContent>[0]> = {}) {
  return pullRequestContent({
    prompt: 'do the thing',
    events: [],
    changedFiles: [],
    sessionId: SESSION,
    branch: 'duke/abc123',
    ...options,
  })
}

describe('title', () => {
  it('uses what the agent reported rather than what it was asked', () => {
    // The instruction and the result are different things, and the result is
    // what a reviewer is looking at.
    const result = content({
      prompt: 'Traducelo al español',
      events: said('Translated the README to Spanish.'),
    })

    expect(result.title).toBe('Translated the README to Spanish')
  })

  it('falls back to the prompt when the agent said nothing', () => {
    expect(content({ prompt: 'Add a health check', events: [] }).title).toBe('Add a health check')
  })

  it('joins streamed deltas before reading the sentence', () => {
    // Text arrives a token at a time; a title taken from the first delta alone
    // would be a fragment.
    const result = content({ events: said('Added ', 'a health ', 'check endpoint.') })
    expect(result.title).toBe('Added a health check endpoint')
  })

  it('skips a markdown heading to reach the prose', () => {
    const result = content({ events: said('## Summary\n\nRemoved the dead code path.') })
    expect(result.title).toBe('Removed the dead code path')
  })

  it('cuts a long sentence at a word boundary', () => {
    const long = `Rewrote ${'the credential handling path '.repeat(6)}completely.`
    const result = content({ events: said(long) })

    expect(result.title.length).toBeLessThanOrEqual(72)
    expect(result.title).toMatch(/…$/)

    // The words that survive are whole ones: a title cut mid-word reads as
    // truncated data rather than as a summary.
    const kept = result.title.slice(0, -1)
    expect(long.startsWith(kept)).toBe(true)
    expect(long[kept.length]).toBe(' ')
  })

  it('collapses newlines, since a title is one line', () => {
    expect(content({ events: said('Fixed\nthe\nbug.') }).title).toBe('Fixed the bug')
  })

  it('has something to say even with no prompt and no output', () => {
    expect(content({ prompt: '', events: [] }).title).toBe('Agent changes')
  })
})

describe('body', () => {
  it("leads with the agent's own account of the work", () => {
    const result = content({ events: said('Added a health check endpoint and a test for it.') })
    expect(result.body.startsWith('Added a health check endpoint')).toBe(true)
  })

  it('lists the files that changed', () => {
    const result = content({ changedFiles: ['src/app.ts', 'src/app.test.ts'] })

    expect(result.body).toContain('## Files changed')
    expect(result.body).toContain('`src/app.ts`')
    expect(result.body).toContain('`src/app.test.ts`')
  })

  it('omits the file list when nothing changed', () => {
    expect(content({ changedFiles: [] }).body).not.toContain('## Files changed')
  })

  it('keeps the prompt, since it is why any of this happened', () => {
    const result = content({ prompt: 'Translate the README' })
    expect(result.body).toContain('Translate the README')
  })

  it('records the branch and session for tracing it back', () => {
    const result = content({ branch: 'duke/abc123' })

    expect(result.body).toContain('duke/abc123')
    expect(result.body).toContain(SESSION)
  })

  it('ignores tool calls and thinking, which are not a summary', () => {
    const result = content({
      events: [
        at({ type: 'thinking', delta: 'Considering the options' }),
        at({ type: 'tool_call', id: 'a', name: 'Read', input: {} }),
        at({ type: 'tool_result', id: 'a', output: 'contents', isError: false }),
        ...said('Fixed it.'),
      ],
    })

    expect(result.body).not.toContain('Considering the options')
    expect(result.body).not.toContain('contents')
    expect(result.body).toContain('Fixed it.')
  })
})
