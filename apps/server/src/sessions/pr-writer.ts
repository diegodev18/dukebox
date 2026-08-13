import { parseGitPreferences, type GitPreferences } from '@dukebox/protocol'
import { loadOpencodeProviders } from '../opencode/providers.js'
import type { SecretStore } from '../secrets/store.js'
import { completeChat, firstProvider, matchProvider, type WriterModel } from './complete.js'
import { pullRequestContent, type PullRequestContent } from './summary.js'

/**
 * Write a pull request title and body from the diff, not the chat.
 *
 * Tries a short model call against credentials already on the server
 * (OpenCode providers), then falls back to the git heuristic. A failure here
 * must not block opening the pull request.
 */

const SYSTEM = `You write GitHub pull request titles and descriptions for a code reviewer.

Rules:
- Describe the change, not the conversation that produced it.
- Do not copy chat, tool traces, or first-person narration ("I added…").
- Title: one line, imperative or past participle, at most 72 characters.
- Body: short markdown with a Summary (what and why) and nothing else. Do not list files; those are added later.
- Return ONLY a JSON object: {"title":"...","body":"..."}.
- Do not invent files or behaviour that the diff does not show.`

export interface WritePullRequestOptions {
  prompt: string
  commits: readonly string[]
  diffStat: string
  changedFiles: readonly string[]
  sessionId: string
  branch: string
  preferences: GitPreferences
  /** OpenCode `provider/model` the coding session used, when known. */
  sessionModel?: string
  secrets?: SecretStore
  /** Injectable so tests never hit the network. */
  complete?: (prompt: string, model: WriterModel) => Promise<string>
}

export type { WriterModel }

export async function writePullRequestContent(
  options: WritePullRequestOptions,
): Promise<PullRequestContent> {
  const fallback = pullRequestContent(options)
  const prefs = parseGitPreferences(options.preferences)

  if (prefs.prDescription === 'heuristic') return fallback

  const model = await resolveWriterModel(options, prefs)
  if (!model) return fallback

  const complete = options.complete ?? ((user, writer) => completeChat(SYSTEM, user, writer))
  const user = userPrompt(options)

  try {
    const raw = await complete(user, model)
    const parsed = parseModelJson(raw)
    if (!parsed) return fallback

    return {
      title: parsed.title.slice(0, 72).trim() || fallback.title,
      body: mergeBody(parsed.body, fallback),
    }
  } catch {
    return fallback
  }
}

async function resolveWriterModel(
  options: WritePullRequestOptions,
  prefs: ReturnType<typeof parseGitPreferences>,
): Promise<WriterModel | null> {
  if (!options.secrets) return null

  const providers = await loadOpencodeProviders(options.secrets)
  if (providers.length === 0) return null

  const wanted =
    prefs.prDescription === 'dedicated'
      ? prefs.dedicatedModel
      : (prefs.dedicatedModel ?? options.sessionModel)

  if (wanted) {
    const fromId = matchProvider(providers, wanted)
    if (fromId) return fromId
  }

  if (prefs.prDescription === 'dedicated') return null

  return firstProvider(providers)
}

function userPrompt(options: WritePullRequestOptions): string {
  const files =
    options.changedFiles.length > 0
      ? options.changedFiles.map((path) => `- ${path}`).join('\n')
      : '(none)'
  const commits =
    options.commits.length > 0
      ? options.commits.map((line) => `- ${line}`).join('\n')
      : '(none yet)'

  return [
    `Original request:\n${options.prompt.trim() || '(none)'}`,
    `Commits:\n${commits}`,
    `Files:\n${files}`,
    options.diffStat.trim() ? `Diffstat:\n${options.diffStat.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function parseModelJson(raw: string): { title: string; body: string } | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      title?: unknown
      body?: unknown
    }
    if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') return null
    const title = parsed.title.trim()
    const body = parsed.body.trim()
    if (!title || !body) return null
    return { title, body }
  } catch {
    return null
  }
}

function mergeBody(written: string, fallback: PullRequestContent): string {
  // Keep the file list and session details the heuristic already formatted.
  const files = fallback.body.includes('## Files changed')
    ? fallback.body.slice(fallback.body.indexOf('## Files changed'))
    : fallback.body.slice(fallback.body.indexOf('<details>'))

  const summary = written.includes('## Summary')
    ? written.trim()
    : `## Summary\n\n${written.trim()}`
  return `${summary}\n\n${files}`
}
