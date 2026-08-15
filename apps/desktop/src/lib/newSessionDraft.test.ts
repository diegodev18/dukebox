import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNewSessionDraft,
  hasNewSessionDraft,
  loadNewSessionDraft,
  NEW_SESSION_DRAFT_KEY,
  newSessionDraftTitle,
  saveNewSessionDraft,
  subscribeNewSessionDraft,
} from '@/lib/newSessionDraft'

afterEach(() => {
  localStorage.clear()
})

describe('newSessionDraft', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadNewSessionDraft()).toEqual({ prompt: '', files: [] })
    expect(hasNewSessionDraft()).toBe(false)
  })

  it('persists typed text and restores it', () => {
    saveNewSessionDraft('fix the parser')
    expect(loadNewSessionDraft()).toEqual({ prompt: 'fix the parser', files: [] })
    expect(hasNewSessionDraft()).toBe(true)
  })

  it('persists attachments with the prompt', () => {
    saveNewSessionDraft('read this', [{ name: 'notes.txt', data: 'data:text/plain;base64,YQ==' }])
    expect(loadNewSessionDraft()).toEqual({
      prompt: 'read this',
      files: [{ name: 'notes.txt', data: 'data:text/plain;base64,YQ==' }],
    })
  })

  it('restores a bare string written by an earlier build', () => {
    localStorage.setItem(NEW_SESSION_DRAFT_KEY, 'finish the parser')
    expect(loadNewSessionDraft()).toEqual({ prompt: 'finish the parser', files: [] })
  })

  it('clears storage when the draft is emptied', () => {
    saveNewSessionDraft('keep me')
    saveNewSessionDraft('')
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBeNull()
    expect(loadNewSessionDraft()).toEqual({ prompt: '', files: [] })
  })

  it('keeps a files-only draft', () => {
    saveNewSessionDraft('', [{ name: 'notes.txt', data: 'data:text/plain;base64,YQ==' }])
    expect(hasNewSessionDraft()).toBe(true)
    expect(newSessionDraftTitle(loadNewSessionDraft())).toBe('notes.txt')
  })

  it('clears a stored draft explicitly', () => {
    saveNewSessionDraft('gone after start')
    clearNewSessionDraft()
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBeNull()
    expect(loadNewSessionDraft()).toEqual({ prompt: '', files: [] })
  })

  it('titles the sidebar row from the first prompt line', () => {
    expect(newSessionDraftTitle({ prompt: 'fix the parser\nand more', files: [] })).toBe(
      'fix the parser',
    )
    expect(newSessionDraftTitle({ prompt: '', files: [] })).toBe('Draft')
  })

  it('notifies subscribers when the draft changes', () => {
    const seen: string[] = []
    const stop = subscribeNewSessionDraft(() => seen.push(loadNewSessionDraft().prompt))

    saveNewSessionDraft('one')
    saveNewSessionDraft('two')
    clearNewSessionDraft()
    stop()
    saveNewSessionDraft('after')

    expect(seen).toEqual(['one', 'two', ''])
  })

  it('drops attachments that would overflow storage', () => {
    const huge = {
      name: 'dump.bin',
      data: `data:application/octet-stream;base64,${'A'.repeat(1_600_000)}`,
    }
    saveNewSessionDraft('keep the text', [huge])
    expect(loadNewSessionDraft()).toEqual({ prompt: 'keep the text', files: [] })
  })
})
