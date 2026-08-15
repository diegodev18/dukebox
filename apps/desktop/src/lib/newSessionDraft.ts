import { useEffect, useState } from 'react'

/**
 * The New Session form, kept across leaving it.
 *
 * New Session unmounts when a person opens a session or Settings, so the
 * typed prompt and its attachments would otherwise vanish. It lives in
 * localStorage because this is a per-device scratch pad — the same pattern
 * as viewed sessions and column widths — not a preference that belongs in
 * the settings store.
 *
 * The sidebar subscribes so a Draft row appears as soon as something is
 * typed, and disappears when the field is emptied or a session starts.
 */

export const NEW_SESSION_DRAFT_KEY = 'dukebox.newSessionDraft'

/** Skip attachments that would blow past typical localStorage quotas. */
const MAX_DRAFT_BYTES = 1_500_000

/**
 * Same-tab signal that the draft changed. `storage` does not fire in the
 * window that wrote, and a module-level listener set is lost when New
 * Session is loaded through `lazy()` as a separate chunk.
 */
const DRAFT_EVENT = 'dukebox:new-session-draft'

export interface NewSessionDraftFile {
  name: string
  data: string
}

export interface NewSessionDraft {
  prompt: string
  files: NewSessionDraftFile[]
}

type Listener = () => void

function notify(): void {
  window.dispatchEvent(new Event(DRAFT_EVENT))
}

export function emptyNewSessionDraft(): NewSessionDraft {
  return { prompt: '', files: [] }
}

export function loadNewSessionDraft(): NewSessionDraft {
  try {
    return parseDraft(localStorage.getItem(NEW_SESSION_DRAFT_KEY))
  } catch {
    return emptyNewSessionDraft()
  }
}

export function saveNewSessionDraft(prompt: string, files: NewSessionDraftFile[] = []): void {
  if (prompt === '' && files.length === 0) {
    clearNewSessionDraft()
    return
  }

  const draft: NewSessionDraft = { prompt, files }
  const serialized = JSON.stringify(draft)
  const payload =
    serialized.length > MAX_DRAFT_BYTES ? JSON.stringify({ prompt, files: [] }) : serialized

  try {
    localStorage.setItem(NEW_SESSION_DRAFT_KEY, payload)
  } catch {
    try {
      localStorage.setItem(NEW_SESSION_DRAFT_KEY, JSON.stringify({ prompt, files: [] }))
    } catch {
      // Storage is unavailable; the in-memory form still works for this visit.
    }
  }
  notify()
}

export function clearNewSessionDraft(): void {
  try {
    localStorage.removeItem(NEW_SESSION_DRAFT_KEY)
  } catch {
    // Same as load: a locked store just means there is nothing to clear.
  }
  notify()
}

export function subscribeNewSessionDraft(listener: Listener): () => void {
  window.addEventListener(DRAFT_EVENT, listener)
  return () => window.removeEventListener(DRAFT_EVENT, listener)
}

export function hasNewSessionDraft(draft: NewSessionDraft = loadNewSessionDraft()): boolean {
  return draft.prompt !== '' || draft.files.length > 0
}

/** First line of the prompt, or the first file name, for the sidebar row. */
export function newSessionDraftTitle(draft: NewSessionDraft): string {
  const line = draft.prompt.trim().split('\n')[0] ?? ''
  if (line) return line
  return draft.files[0]?.name ?? 'Draft'
}

/** The stored draft, live — the sidebar and New Session stay in sync. */
export function useNewSessionDraft(): NewSessionDraft {
  const [draft, setDraft] = useState(loadNewSessionDraft)

  useEffect(() => subscribeNewSessionDraft(() => setDraft(loadNewSessionDraft())), [])

  return draft
}

function parseDraft(raw: string | null): NewSessionDraft {
  if (!raw) return emptyNewSessionDraft()

  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { prompt: raw, files: [] }
      }

      const value = parsed as { prompt?: unknown; files?: unknown }
      const prompt = typeof value.prompt === 'string' ? value.prompt : ''
      const files = Array.isArray(value.files) ? value.files.filter(isDraftFile) : []
      return { prompt, files }
    } catch {
      return { prompt: raw, files: [] }
    }
  }

  // Earlier builds stored the prompt as a bare string.
  return { prompt: raw, files: [] }
}

function isDraftFile(value: unknown): value is NewSessionDraftFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<NewSessionDraftFile>
  return typeof file.name === 'string' && typeof file.data === 'string'
}
