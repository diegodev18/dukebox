import { describe, expect, it } from 'vitest'
import { pullRequestContent } from '@/sessions/summary'

const SESSION = '00000000-0000-4000-8000-000000000000'

function content(options: Partial<Parameters<typeof pullRequestContent>[0]> = {}) {
  return pullRequestContent({
    prompt: 'do the thing',
    commits: [],
    diffStat: '',
    changedFiles: [],
    sessionId: SESSION,
    branch: 'duke/abc123',
    ...options,
  })
}

describe('title', () => {
  it('uses a single commit subject rather than the prompt', () => {
    const result = content({
      prompt: 'Traducelo al español',
      commits: ['Translated the README to Spanish'],
    })

    expect(result.title).toBe('Translated the README to Spanish')
  })

  it('falls back to the prompt when there are no commits', () => {
    expect(content({ prompt: 'Add a health check', commits: [] }).title).toBe('Add a health check')
  })

  it('does not concatenate several commits into a title', () => {
    const result = content({
      prompt: 'Harden the credential path',
      commits: ['Add the proxy', 'Cover it with tests'],
    })
    expect(result.title).toBe('Harden the credential path')
  })

  it('names the files when there is no prompt and no commit', () => {
    expect(content({ prompt: '', commits: [], changedFiles: ['src/app.ts'] }).title).toBe(
      'Update src/app.ts',
    )
    expect(content({ prompt: '', commits: [], changedFiles: ['a.ts', 'b.ts'] }).title).toBe(
      'Update 2 files',
    )
  })

  it('cuts a long sentence at a word boundary', () => {
    const long = `Rewrote ${'the credential handling path '.repeat(6)}completely.`
    const result = content({ commits: [long] })

    expect(result.title.length).toBeLessThanOrEqual(72)
    expect(result.title).toMatch(/…$/)

    const kept = result.title.slice(0, -1)
    expect(long.startsWith(kept)).toBe(true)
    expect(long[kept.length]).toBe(' ')
  })

  it('has something to say even with no prompt and no output', () => {
    expect(content({ prompt: '', commits: [] }).title).toBe('Agent changes')
  })
})

describe('body', () => {
  it('leads with a summary, not the conversation', () => {
    const result = content({
      prompt: 'Add a health check',
      commits: ['Added a health check endpoint and a test for it'],
    })

    expect(result.body).toContain('## Summary')
    expect(result.body).toContain('Added a health check endpoint')
    expect(result.body).not.toContain('assistant_text')
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

  it('includes the diffstat when there is one', () => {
    const result = content({ diffStat: ' src/app.ts | 12 ++++' })
    expect(result.body).toContain('## Diff')
    expect(result.body).toContain('src/app.ts | 12')
  })

  it('keeps the prompt in a details block, not as the title of the review', () => {
    const result = content({ prompt: 'Translate the README', commits: ['Translated the README'] })
    expect(result.body).toContain('Translate the README')
    expect(result.body).toContain('<details>')
  })

  it('records the branch and session for tracing it back', () => {
    const result = content({ branch: 'duke/abc123' })

    expect(result.body).toContain('duke/abc123')
    expect(result.body).toContain(SESSION)
  })

  it('never includes chat-shaped prose that was not in the git inputs', () => {
    expect(content({ prompt: 'Fix it' }).body).not.toContain('I ramble at length')
  })
})
