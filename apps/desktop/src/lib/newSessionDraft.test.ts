import { afterEach, describe, expect, it } from 'vitest'
import {
  draftTitle,
  lastNewSessionFromDraft,
  loadNewSessionDrafts,
  NEW_SESSION_DRAFT_KEY,
  NEW_SESSION_DRAFTS_KEY,
  removeNewSessionDraft,
  removeNewSessionDraftsForProject,
  takeLegacyNewSessionDraft,
  upsertNewSessionDraft,
  type NewSessionDraft,
} from '@/lib/newSessionDraft'

afterEach(() => {
  localStorage.clear()
})

function draft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
  return {
    id: 'draft-1',
    projectId: 'project-1',
    repoFullName: 'acme/app',
    prompt: 'fix the parser',
    baseBranch: 'main',
    environmentId: '',
    agentId: 'claude-code',
    model: 'claude-sonnet-5',
    providerId: '',
    permissionMode: 'bypass',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe('newSessionDraft', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadNewSessionDrafts()).toEqual([])
  })

  it('persists a draft and restores it', () => {
    const saved = draft()
    upsertNewSessionDraft(saved)
    expect(loadNewSessionDrafts()).toEqual([saved])
    expect(JSON.parse(localStorage.getItem(NEW_SESSION_DRAFTS_KEY) ?? '[]')).toHaveLength(1)
  })

  it('updates an existing draft in place', () => {
    upsertNewSessionDraft(draft())
    upsertNewSessionDraft(draft({ prompt: 'and the tests', updatedAt: 5 }))
    const loaded = loadNewSessionDrafts()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.prompt).toBe('and the tests')
    expect(loaded[0]?.updatedAt).toBe(5)
  })

  it('keeps several drafts, newest first', () => {
    upsertNewSessionDraft(draft({ id: 'older', updatedAt: 1 }))
    upsertNewSessionDraft(draft({ id: 'newer', prompt: 'second', updatedAt: 3 }))
    expect(loadNewSessionDrafts().map((item) => item.id)).toEqual(['newer', 'older'])
  })

  it('removes a draft by id', () => {
    upsertNewSessionDraft(draft({ id: 'keep' }))
    upsertNewSessionDraft(draft({ id: 'drop', prompt: 'gone' }))
    expect(removeNewSessionDraft('drop').map((item) => item.id)).toEqual(['keep'])
    expect(loadNewSessionDrafts()).toHaveLength(1)
  })

  it('removes every draft for a project', () => {
    upsertNewSessionDraft(draft({ id: 'here' }))
    upsertNewSessionDraft(
      draft({ id: 'there', projectId: 'project-2', repoFullName: 'acme/other' }),
    )
    expect(removeNewSessionDraftsForProject('project-1').map((item) => item.id)).toEqual(['there'])
  })

  it('ignores a malformed stored list', () => {
    localStorage.setItem(NEW_SESSION_DRAFTS_KEY, '{')
    expect(loadNewSessionDrafts()).toEqual([])
  })

  it('drops stored rows that are not drafts', () => {
    localStorage.setItem(NEW_SESSION_DRAFTS_KEY, JSON.stringify([{ id: 1 }, draft()]))
    expect(loadNewSessionDrafts()).toEqual([draft()])
  })

  it('consumes a leftover single-string draft once', () => {
    localStorage.setItem(NEW_SESSION_DRAFT_KEY, 'finish the parser')
    expect(takeLegacyNewSessionDraft()).toBe('finish the parser')
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBeNull()
    expect(takeLegacyNewSessionDraft()).toBe('')
  })

  it('maps a draft onto the last-session pickers', () => {
    expect(
      lastNewSessionFromDraft(draft({ providerId: 'openai', model: 'openai/gpt-5.2' })),
    ).toEqual({
      repoFullName: 'acme/app',
      baseBranch: 'main',
      environmentId: '',
      agentId: 'claude-code',
      model: 'openai/gpt-5.2',
      providerId: 'openai',
      permissionMode: 'bypass',
    })
  })
})

describe('draftTitle', () => {
  it('names an empty prompt Draft', () => {
    expect(draftTitle('   ')).toBe('Draft')
  })

  it('uses the first sentence of the prompt', () => {
    expect(draftTitle('fix the parser. then write tests')).toBe('Fix the parser')
  })

  it('clips a long prompt on a word boundary', () => {
    const title = draftTitle(
      'please rewrite the entire authentication stack so tokens survive a restart and the sidebar still works',
    )
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(60)
  })
})
