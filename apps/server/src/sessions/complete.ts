import type { StoredOpencodeProvider } from '@dukebox/protocol'
import { loadOpencodeProviders } from '../opencode/providers.js'
import type { SecretStore } from '../secrets/store.js'

/**
 * A short model call against credentials already on the server.
 *
 * Shared by the pull-request writer and the session namer. Both need the same
 * provider lookup and the same Anthropic / OpenAI-compat HTTP; only the system
 * prompt and the parse of the reply differ.
 */

export interface WriterModel {
  kind: StoredOpencodeProvider['kind']
  model: string
  apiKey: string
  baseUrl?: string
}

export async function resolveSessionModel(options: {
  secrets?: SecretStore
  sessionModel?: string
}): Promise<WriterModel | null> {
  if (!options.secrets) return null

  const providers = await loadOpencodeProviders(options.secrets)
  if (providers.length === 0) return null

  if (options.sessionModel) {
    const fromId = matchProvider(providers, options.sessionModel)
    if (fromId) return fromId
  }

  return firstProvider(providers)
}

export function matchProvider(
  providers: StoredOpencodeProvider[],
  spec: string,
): WriterModel | null {
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

export function firstProvider(providers: StoredOpencodeProvider[]): WriterModel | null {
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

export async function completeChat(
  system: string,
  user: string,
  model: WriterModel,
  maxTokens = 800,
): Promise<string> {
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
        max_tokens: maxTokens,
        system,
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
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
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
