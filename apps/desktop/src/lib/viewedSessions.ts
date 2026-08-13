import { isTerminal, type SessionStatus } from '@dukebox/protocol'

/**
 * Which sessions this device has already opened, keyed by id → lastSeq.
 *
 * The nav uses this to tell a finished session the person has not read from
 * one they already opened. It lives in localStorage because the list is a
 * per-device concern: another machine should still flag a session as unread
 * until that machine opens it.
 */

export const VIEWED_SESSIONS_KEY = 'dukebox.viewedSessions'

export type ViewedSessions = Record<string, number>

export type SessionNavIndicatorKind = 'orb' | 'unread' | 'none'

export function loadViewedSessions(): ViewedSessions {
  try {
    const raw = localStorage.getItem(VIEWED_SESSIONS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const viewed: ViewedSessions = {}
    for (const [id, seq] of Object.entries(parsed)) {
      if (typeof seq === 'number' && Number.isFinite(seq)) viewed[id] = seq
    }
    return viewed
  } catch {
    return {}
  }
}

export function saveViewedSessions(viewed: ViewedSessions): void {
  localStorage.setItem(VIEWED_SESSIONS_KEY, JSON.stringify(viewed))
}

/**
 * Record that a session was opened at `lastSeq`. No-op when the stored seq
 * is already at least that far — selecting an open session should not rewrite
 * storage on every render.
 */
export function markViewed(
  viewed: ViewedSessions,
  sessionId: string,
  lastSeq: number,
): ViewedSessions {
  const previous = viewed[sessionId]
  if (previous !== undefined && previous >= lastSeq) return viewed

  const next = { ...viewed, [sessionId]: lastSeq }
  saveViewedSessions(next)
  return next
}

/**
 * What the nav row shows to the left of the title.
 *
 * In-progress sessions always get the orb. A terminal session is unread until
 * this device has opened it at its current `lastSeq` (or later).
 */
export function sessionNavIndicator(
  status: SessionStatus,
  lastSeq: number,
  viewedSeq: number | undefined,
): SessionNavIndicatorKind {
  if (!isTerminal(status)) return 'orb'
  if (viewedSeq === undefined || lastSeq > viewedSeq) return 'unread'
  return 'none'
}
