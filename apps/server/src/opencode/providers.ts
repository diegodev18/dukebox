import { OPENCODE_INSTRUCTIONS_PATH } from '@dukebox/adapters'
import {
  catalogEntry,
  storedOpencodeProviders,
  type StoredOpencodeProvider,
  type UpsertOpencodeProviderRequest,
} from '@dukebox/protocol'
import type { SecretStore } from '../secrets/store.js'

/**
 * OpenCode's credentials, as Dukebox stores and injects them.
 *
 * One encrypted JSON blob rather than a secret per provider: listing and
 * replacing the set is a single read/write, and a project cannot shadow a
 * name that lives here.
 */

export const OPENCODE_PROVIDERS_SECRET = 'OPENCODE_PROVIDERS'
export const OPENCODE_AUTH_ENV = 'DUKEBOX_OPENCODE_AUTH_JSON'

/** Native env vars OpenCode already reads for catalog providers. */
export const OPENCODE_ENV_VARS: Record<
  Exclude<StoredOpencodeProvider['kind'], 'openai-compatible'>,
  string
> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
}

export function customProviderEnvVar(id: string): string {
  return `OPENCODE_PROVIDER_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export async function loadOpencodeProviders(store: SecretStore): Promise<StoredOpencodeProvider[]> {
  const raw = await store.get(OPENCODE_PROVIDERS_SECRET)
  if (!raw) return []

  try {
    const parsed = storedOpencodeProviders.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.map(withLiveCatalogModels) : []
  } catch {
    return []
  }
}

/**
 * Catalog kinds snapshot their models at save time. Overlay the live catalog
 * so a stored DeepSeek key picks up V4 Flash / V4 Pro without a re-save, while
 * keeping any extra models the operator listed.
 */
export function withLiveCatalogModels(provider: StoredOpencodeProvider): StoredOpencodeProvider {
  if (provider.kind === 'openai-compatible') return provider

  const catalog = catalogEntry(provider.kind)
  if (!catalog) return provider

  const catalogIds = new Set(catalog.models.map((model) => model.id))
  return {
    ...provider,
    models: [
      ...catalog.models,
      ...provider.models.filter((model) => !catalogIds.has(model.id)),
    ],
  }
}

export async function saveOpencodeProviders(
  store: SecretStore,
  providers: StoredOpencodeProvider[],
): Promise<void> {
  if (providers.length === 0) {
    await store.delete(OPENCODE_PROVIDERS_SECRET)
    return
  }

  await store.set(OPENCODE_PROVIDERS_SECRET, JSON.stringify(providers))
}

/**
 * Turn an upsert request into a stored provider, filling catalog defaults.
 *
 * Catalog kinds are keyed by kind (one Anthropic, one OpenAI). A custom
 * endpoint keeps the id the caller chose.
 */
export function resolveStoredProvider(
  request: UpsertOpencodeProviderRequest,
): StoredOpencodeProvider {
  if (request.kind === 'openai-compatible') {
    const id = request.id!
    return {
      id,
      kind: request.kind,
      name: request.name ?? id,
      apiKey: request.apiKey,
      baseUrl: request.baseUrl!,
      models: request.models ?? [],
    }
  }

  const catalog = catalogEntry(request.kind)
  const models = request.models ?? (catalog ? [...catalog.models] : [])

  return {
    id: request.kind,
    kind: request.kind,
    name: request.name ?? catalog?.name ?? request.kind,
    apiKey: request.apiKey,
    models,
  }
}

export function publicProvider(provider: StoredOpencodeProvider) {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    models: provider.models,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }
}

/**
 * Environment and config OpenCode needs inside a session container.
 *
 * Catalog keys go in both `auth.json` (via DUKEBOX_OPENCODE_AUTH_JSON) and the
 * native env vars OpenCode already understands. Custom endpoints go in
 * OPENCODE_CONFIG_CONTENT with `{env:…}` references so the key is not inlined
 * in the config blob twice.
 */
export function buildOpencodeSessionEnv(
  providers: StoredOpencodeProvider[],
  instructions?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  }

  const auth: Record<string, { type: 'api'; key: string }> = {}
  const configProvider: Record<string, unknown> = {}

  for (const provider of providers) {
    if (provider.kind === 'openai-compatible') {
      const envVar = customProviderEnvVar(provider.id)
      env[envVar] = provider.apiKey
      configProvider[provider.id] = {
        npm: '@ai-sdk/openai-compatible',
        name: provider.name,
        options: {
          baseURL: provider.baseUrl,
          apiKey: `{env:${envVar}}`,
        },
        models: Object.fromEntries(
          provider.models.map((model) => [model.id, { name: model.label }]),
        ),
      }
      continue
    }

    env[OPENCODE_ENV_VARS[provider.kind]] = provider.apiKey
    auth[provider.id] = { type: 'api', key: provider.apiKey }
  }

  if (Object.keys(auth).length > 0) {
    env.DUKEBOX_OPENCODE_AUTH_JSON = JSON.stringify(auth)
  }

  const config: Record<string, unknown> = {}
  if (instructions) {
    config.instructions = [OPENCODE_INSTRUCTIONS_PATH]
  }
  if (Object.keys(configProvider).length > 0) {
    config.provider = configProvider
  }

  if (Object.keys(config).length > 0) {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  }

  return env
}
