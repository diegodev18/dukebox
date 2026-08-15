import type { LastNewSession } from '@/lib/settings'

/**
 * Unstarted New Session prompts, shown as session cards under a project.
 *
 * New Session unmounts when a person opens a session or Settings, and "New
 * session" starts a fresh form. Each typed prompt has to live outside the
 * component so it can appear in the sidebar and come back when the card is
 * opened. localStorage, same as viewed sessions: a per-device scratch pad,
 * not a preference that belongs in the settings store.
 */

export const NEW_SESSION_DRAFTS_KEY = 'dukebox.newSessionDrafts'
/** @deprecated Single-string draft; migrated on first read. */
export const NEW_SESSION_DRAFT_KEY = 'dukebox.newSessionDraft'

export interface NewSessionDraftFields {
  prompt: string
  repoFullName: string
  baseBranch: string
  environmentId: string
  agentId: string
  model: string
  providerId: string
  permissionMode: string
}

export interface NewSessionDraft extends NewSessionDraftFields {
  id: string
  projectId: string
  createdAt: number
  updatedAt: number
}

export function loadNewSessionDrafts(): NewSessionDraft[] {
  try {
    const raw = localStorage.getItem(NEW_SESSION_DRAFTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(parseDraft)
      .filter((draft): draft is NewSessionDraft => draft !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  } catch {
    return []
  }
}

export function saveNewSessionDrafts(drafts: NewSessionDraft[]): void {
  localStorage.setItem(NEW_SESSION_DRAFTS_KEY, JSON.stringify(drafts))
}

export function upsertNewSessionDraft(draft: NewSessionDraft): NewSessionDraft[] {
  const next = [
    draft,
    ...loadNewSessionDrafts().filter((candidate) => candidate.id !== draft.id),
  ].sort((left, right) => right.updatedAt - left.updatedAt)
  saveNewSessionDrafts(next)
  return next
}

export function removeNewSessionDraft(id: string): NewSessionDraft[] {
  const next = loadNewSessionDrafts().filter((draft) => draft.id !== id)
  saveNewSessionDrafts(next)
  return next
}

export function removeNewSessionDraftsForProject(projectId: string): NewSessionDraft[] {
  const next = loadNewSessionDrafts().filter((draft) => draft.projectId !== projectId)
  saveNewSessionDrafts(next)
  return next
}

/**
 * Consume a leftover single-string draft from before cards existed.
 *
 * Returns the text and forgets it, so a remount does not keep re-seeding.
 */
export function takeLegacyNewSessionDraft(): string {
  try {
    const text = localStorage.getItem(NEW_SESSION_DRAFT_KEY) ?? ''
    if (text) localStorage.removeItem(NEW_SESSION_DRAFT_KEY)
    return text
  } catch {
    return ''
  }
}

/** The pickers as New Session restores them from a card. */
export function lastNewSessionFromDraft(draft: NewSessionDraft): LastNewSession {
  return {
    repoFullName: draft.repoFullName,
    baseBranch: draft.baseBranch,
    environmentId: draft.environmentId,
    agentId: draft.agentId,
    model: draft.model,
    providerId: draft.providerId,
    permissionMode: draft.permissionMode,
  }
}

/**
 * A short sidebar title from the typed prompt.
 *
 * Empty drafts are not listed; this still names one so a card never renders
 * blank if the prompt is only whitespace.
 */
export function draftTitle(prompt: string): string {
  let text = prompt.replace(/\s+/g, ' ').trim()
  if (!text) return 'Draft'

  const sentenceEnd = text.search(/[.!?](?:\s|$)/)
  if (sentenceEnd > 0 && sentenceEnd < 120) {
    text = text.slice(0, sentenceEnd)
  }

  text = text.replace(/[.?!]+$/, '').trim()
  if (!text) return 'Draft'

  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length <= 60) return text

  const cut = text.slice(0, 59)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > 24 ? cut.slice(0, lastSpace) : cut
  return `${kept.replace(/[\s,;:.]+$/, '')}…`
}

function parseDraft(raw: unknown): NewSessionDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return null
  if (typeof value.projectId !== 'string' || value.projectId === '') return null
  if (typeof value.repoFullName !== 'string' || value.repoFullName === '') return null
  if (typeof value.prompt !== 'string') return null
  if (typeof value.baseBranch !== 'string') return null
  if (typeof value.environmentId !== 'string') return null
  if (typeof value.agentId !== 'string') return null
  if (typeof value.model !== 'string') return null
  if (typeof value.providerId !== 'string') return null
  if (typeof value.permissionMode !== 'string') return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null

  return {
    id: value.id,
    projectId: value.projectId,
    repoFullName: value.repoFullName,
    prompt: value.prompt,
    baseBranch: value.baseBranch,
    environmentId: value.environmentId,
    agentId: value.agentId,
    model: value.model,
    providerId: value.providerId,
    permissionMode: value.permissionMode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}
