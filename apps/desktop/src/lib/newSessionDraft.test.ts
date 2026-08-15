import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNewSessionDraft,
  loadNewSessionDraft,
  NEW_SESSION_DRAFT_KEY,
  saveNewSessionDraft,
} from '@/lib/newSessionDraft'

afterEach(() => {
  localStorage.clear()
})

describe('newSessionDraft', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadNewSessionDraft()).toBe('')
  })

  it('persists typed text and restores it', () => {
    saveNewSessionDraft('fix the parser')
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBe('fix the parser')
    expect(loadNewSessionDraft()).toBe('fix the parser')
  })

  it('clears storage when the draft is emptied', () => {
    saveNewSessionDraft('keep me')
    saveNewSessionDraft('')
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBeNull()
    expect(loadNewSessionDraft()).toBe('')
  })

  it('clears a stored draft explicitly', () => {
    saveNewSessionDraft('gone after start')
    clearNewSessionDraft()
    expect(localStorage.getItem(NEW_SESSION_DRAFT_KEY)).toBeNull()
    expect(loadNewSessionDraft()).toBe('')
  })
})
