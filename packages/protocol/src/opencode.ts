import { z } from 'zod'

/**
 * OpenCode providers.
 *
 * OpenCode addresses a model as `provider/model`. Credentials are per
 * provider, not a single token, and a custom OpenAI-compatible endpoint is a
 * provider like any other.
 */

export const opencodeProviderKind = z.enum([
  'anthropic',
  'openai',
  'google',
  'groq',
  'openrouter',
  'deepseek',
  'mistral',
  'xai',
  'openai-compatible',
])

export type OpencodeProviderKind = z.infer<typeof opencodeProviderKind>

export const opencodeModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})

export type OpencodeModel = z.infer<typeof opencodeModel>

/** A configured provider as the client sees it. The API key never leaves the server. */
export const opencodeProvider = z.object({
  id: z.string(),
  kind: opencodeProviderKind,
  name: z.string(),
  baseUrl: z.string().url().optional(),
  models: z.array(opencodeModel),
})

export type OpencodeProvider = z.infer<typeof opencodeProvider>

export const listOpencodeProvidersResponse = z.object({
  providers: z.array(opencodeProvider),
})

export type ListOpencodeProvidersResponse = z.infer<typeof listOpencodeProvidersResponse>

export const opencodeCatalogEntry = z.object({
  kind: opencodeProviderKind,
  name: z.string(),
  models: z.array(opencodeModel),
})

export type OpencodeCatalogEntry = z.infer<typeof opencodeCatalogEntry>

export const listOpencodeCatalogResponse = z.object({
  providers: z.array(opencodeCatalogEntry),
})

export type ListOpencodeCatalogResponse = z.infer<typeof listOpencodeCatalogResponse>

const providerId = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'expected a lowercase id of letters, digits, and hyphens')

/**
 * Create or replace a provider.
 *
 * Catalog kinds ignore `id` (it is the kind) and fill in name/models from the
 * catalog when omitted. A custom endpoint must name itself, give a base URL,
 * and list at least one model.
 */
export const upsertOpencodeProviderRequest = z
  .object({
    id: providerId.optional(),
    kind: opencodeProviderKind,
    name: z.string().min(1).optional(),
    apiKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
    models: z.array(opencodeModel).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'openai-compatible') {
      if (!data.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['id'],
          message: 'a custom provider needs an id',
        })
      }
      if (!data.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'a custom provider needs a base URL',
        })
      }
      if (!data.models || data.models.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models'],
          message: 'a custom provider needs at least one model',
        })
      }
    }
  })

export type UpsertOpencodeProviderRequest = z.infer<typeof upsertOpencodeProviderRequest>

/** Persisted shape, including the key. Never returned over the API. */
export const storedOpencodeProvider = z.object({
  id: z.string(),
  kind: opencodeProviderKind,
  name: z.string(),
  apiKey: z.string(),
  baseUrl: z.string().url().optional(),
  models: z.array(opencodeModel),
})

export type StoredOpencodeProvider = z.infer<typeof storedOpencodeProvider>

export const storedOpencodeProviders = z.array(storedOpencodeProvider)

/**
 * Well-known providers and the models the New Session picker offers for each.
 *
 * Model ids are the OpenCode model half (`provider/model`); the provider id
 * is prepended by the client. Custom endpoints are not listed here — they
 * carry their own models.
 */
export const OPENCODE_CATALOG: readonly {
  kind: Exclude<OpencodeProviderKind, 'openai-compatible'>
  name: string
  models: readonly OpencodeModel[]
}[] = [
  {
    kind: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.2', label: 'GPT-5.2' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o3', label: 'o3' },
    ],
  },
  {
    kind: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    kind: 'groq',
    name: 'Groq',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
      { id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' },
    ],
  },
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
      { id: 'openai/gpt-5.2', label: 'GPT-5.2' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
  },
  {
    kind: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ],
  },
  {
    kind: 'mistral',
    name: 'Mistral',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'codestral-latest', label: 'Codestral' },
    ],
  },
  {
    kind: 'xai',
    name: 'xAI',
    models: [
      { id: 'grok-3', label: 'Grok 3' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini' },
    ],
  },
]

export function catalogEntry(
  kind: OpencodeProviderKind,
): (typeof OPENCODE_CATALOG)[number] | undefined {
  return OPENCODE_CATALOG.find((entry) => entry.kind === kind)
}
