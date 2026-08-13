import { afterEach, describe, expect, it } from 'vitest'
import {
  loadViewedSessions,
  markViewed,
  sessionNavIndicator,
  VIEWED_SESSIONS_KEY,
} from '@/lib/viewedSessions'

afterEach(() => {
  localStorage.clear()
})

describe('sessionNavIndicator', () => {
  it('shows the orb while a session is in progress', () => {
    expect(sessionNavIndicator('provisioning', 0, undefined)).toBe('orb')
    expect(sessionNavIndicator('running', 3, 3)).toBe('orb')
    expect(sessionNavIndicator('waiting_input', 2, 1)).toBe('orb')
  })

  it('marks a finished session unread until this device has opened it', () => {
    expect(sessionNavIndicator('done', 4, undefined)).toBe('unread')
    expect(sessionNavIndicator('failed', 1, undefined)).toBe('unread')
    expect(sessionNavIndicator('stopped', 8, 7)).toBe('unread')
  })

  it('hides the mark once the current seq has been viewed', () => {
    expect(sessionNavIndicator('done', 4, 4)).toBe('none')
    expect(sessionNavIndicator('failed', 2, 9)).toBe('none')
    expect(sessionNavIndicator('stopped', 0, 0)).toBe('none')
  })
})

describe('loadViewedSessions / markViewed', () => {
  it('starts empty when nothing is stored', () => {
    expect(loadViewedSessions()).toEqual({})
  })

  it('ignores invalid storage', () => {
    localStorage.setItem(VIEWED_SESSIONS_KEY, '{')
    expect(loadViewedSessions()).toEqual({})

    localStorage.setItem(VIEWED_SESSIONS_KEY, '[]')
    expect(loadViewedSessions()).toEqual({})

    localStorage.setItem(VIEWED_SESSIONS_KEY, '{"a":"nope","b":4}')
    expect(loadViewedSessions()).toEqual({ b: 4 })
  })

  it('persists a viewed seq and skips a rewrite when nothing advanced', () => {
    const first = markViewed({}, 'session-1', 4)
    expect(first).toEqual({ 'session-1': 4 })
    expect(JSON.parse(localStorage.getItem(VIEWED_SESSIONS_KEY)!)).toEqual({
      'session-1': 4,
    })

    const same = markViewed(first, 'session-1', 4)
    expect(same).toBe(first)

    const next = markViewed(first, 'session-1', 6)
    expect(next).toEqual({ 'session-1': 6 })
    expect(loadViewedSessions()).toEqual({ 'session-1': 6 })
  })
})
