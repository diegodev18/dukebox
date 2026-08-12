import {
  parseGitPreferences,
  type GitPreferences,
  type StoredOpencodeProvider,
} from '@dukebox/protocol'
import { loadOpencodeProviders } from '../opencode/providers.js'
import type { SecretStore } from '../secrets/store.js'
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

export interface WriterModel {
  kind: StoredOpencodeProvider['kind']
  model: string
  apiKey: string
  baseUrl?: string
}

export async function writePullRequestContent(
  options: WritePullRequestOptions,
): Promise<PullRequestContent> {
  const fallback = pullRequestContent(options)
  const prefs = parseGitPreferences(options.preferences)

  if (prefs.prDescription === 'heuristic') return fallback

  const model = await resolveWriterModel(options, prefs)
  if (!model) return fallback

  const complete = options.complete ?? completePrompt
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
  prefs: GitPreferences,
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

function matchProvider(providers: StoredOpencodeProvider[], spec: string): WriterModel | null {
  const slash = spec.indexOf('/')
  const providerId = slash === -1 ? spec : spec.slice(0, slash)
  const modelId = slash === -1 ? undefined : spec.slice(slash + 1)

  const provider = providers.find((entry) => entry.id === providerId)
  if (!provider) return null

  const model = modelId ?? provider.models[0]?.id
  if (!model) return null

  return {
    kind: provider.kind,
    model,
    apiKey: provider.apiKey,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }
}

function firstProvider(providers: StoredOpencodeProvider[]): WriterModel | null {
  const provider = providers[0]
  const model = provider?.models[0]?.id
  if (!provider || !model) return null
  return {
    kind: provider.kind,
    model,
    apiKey: provider.apiKey,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }
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

const OPENAI_COMPAT: Record<Exclude<StoredOpencodeProvider['kind'], 'anthropic'>, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  'openai-compatible': '',
}

async function completePrompt(user: string, model: WriterModel): Promise<string> {
  if (model.kind === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!response.ok) {
      throw new Error(`anthropic ${response.status}`)
    }
    const body = (await response.json()) as {
      content?: { type: string; text?: string }[]
    }
    return body.content?.find((block) => block.type === 'text')?.text ?? ''
  }

  const url =
    model.kind === 'openai-compatible'
      ? `${(model.baseUrl ?? '').replace(/\/$/, '')}/chat/completions`
      : OPENAI_COMPAT[model.kind]

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: 800,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!response.ok) {
    throw new Error(`completions ${response.status}`)
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return body.choices?.[0]?.message?.content ?? ''
}
