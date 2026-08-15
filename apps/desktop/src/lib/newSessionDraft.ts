/**
 * The New Session prompt, kept across leaving the form.
 *
 * New Session unmounts when a person opens a session or Settings, so the
 * typed text would otherwise vanish. It lives in localStorage because this is
 * a per-device scratch pad — the same pattern as viewed sessions and column
 * widths — not a preference that belongs in the settings store.
 */

export const NEW_SESSION_DRAFT_KEY = 'dukebox.newSessionDraft'

export function loadNewSessionDraft(): string {
  try {
    return localStorage.getItem(NEW_SESSION_DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveNewSessionDraft(prompt: string): void {
  if (prompt === '') {
    clearNewSessionDraft()
    return
  }
  localStorage.setItem(NEW_SESSION_DRAFT_KEY, prompt)
}

export function clearNewSessionDraft(): void {
  localStorage.removeItem(NEW_SESSION_DRAFT_KEY)
}
