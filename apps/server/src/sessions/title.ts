import type { SecretStore } from '@/secrets/store'
import { completeChat, resolveSessionModel, type WriterModel } from '@/sessions/complete'

/**
 * A session name taken from the task, not the first chat message.
 *
 * Tries a short model call against credentials already on the server, then
 * falls back to a heuristic that strips conversational padding. A failure
 * here must not block starting the session.
 */

const SYSTEM = `You name coding sessions.

Rules:
- Return ONLY a short title that names the task, at most 60 characters.
- Same language as the request.
- No quotes, no trailing punctuation, no markdown.
- Name the work to be done, not the conversation that asked for it.
- Do not copy the request verbatim unless it is already a short task name.`

const MAX_TITLE = 60

export interface WriteSessionTitleOptions {
  prompt: string
  /** OpenCode `provider/model` the coding session used, when known. */
  sessionModel?: string
  secrets?: SecretStore
  /** Injectable so tests never hit the network. */
  complete?: (prompt: string, model: WriterModel) => Promise<string>
}

export async function writeSessionTitle(options: WriteSessionTitleOptions): Promise<string> {
  const fallback = titleFromPrompt(options.prompt)
  const model = await resolveSessionModel(options)
  if (!model) return fallback

  const complete = options.complete ?? ((user, writer) => completeChat(SYSTEM, user, writer, 80))

  try {
    const raw = await complete(options.prompt, model)
    return parseTitle(raw) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * A short name derived from the prompt without calling a model.
 *
 * Strips chatty prefixes and cuts on a word boundary so the sidebar does not
 * show the first eighty characters of a paragraph.
 */
export function titleFromPrompt(prompt: string): string {
  let text = prompt.replace(/\s+/g, ' ').trim()
  if (!text) return 'New session'

  const sentenceEnd = text.search(/[.!?](?:\s|$)/)
  if (sentenceEnd > 0 && sentenceEnd < 120) {
    text = text.slice(0, sentenceEnd)
  }

  const prefixes =
    /^(hey[,.]?\s+|hi[,.]?\s+|hello[,.]?\s+|please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i need you to\s+|i'd like you to\s+|help me (?:to )?)/i
  for (let i = 0; i < 5; i++) {
    const next = text.replace(prefixes, '')
    if (next === text) break
    text = next
  }

  text = text.replace(/[.?!]+$/, '').trim()
  if (!text) return 'New session'

  text = text.charAt(0).toUpperCase() + text.slice(1)
  return clipTitle(text)
}

function parseTitle(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as { title?: unknown }
      if (typeof parsed.title === 'string') return sanitizeTitle(parsed.title)
    } catch {
      // Fall through to treating the whole reply as the title.
    }
  }

  return sanitizeTitle(candidate)
}

function sanitizeTitle(raw: string): string | null {
  let text = raw.trim()
  text = (text.split('\n')[0] ?? '').trim()
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim()
  text = text.replace(/[.!?]+$/, '').trim()
  if (!text) return null
  return clipTitle(text)
}

function clipTitle(text: string): string {
  if (text.length <= MAX_TITLE) return text

  const cut = text.slice(0, MAX_TITLE - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const kept = lastSpace > 24 ? cut.slice(0, lastSpace) : cut
  return `${kept.replace(/[\s,;:.]+$/, '')}…`
}
