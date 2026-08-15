import { describe, expect, it } from 'vitest'
import {
  OPENCODE_CATALOG,
  catalogEntry,
  upsertOpencodeProviderRequest,
  storedOpencodeProviders,
  opencodeProvider,
} from '@/opencode'

describe('upsertOpencodeProviderRequest', () => {
  it('accepts a catalog provider with only a kind and an api key', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'anthropic',
      apiKey: 'sk-ant-test',
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects a custom provider without a base URL', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'openai-compatible',
      id: 'my-proxy',
      apiKey: 'sk-test',
      models: [{ id: 'gpt-4', label: 'GPT-4' }],
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a custom provider without models', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'openai-compatible',
      id: 'my-proxy',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a custom provider without an id', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4', label: 'GPT-4' }],
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts a complete custom provider', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'openai-compatible',
      id: 'my-proxy',
      name: 'My Proxy',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4', label: 'GPT-4' }],
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects an id that is not a lowercase slug', () => {
    const parsed = upsertOpencodeProviderRequest.safeParse({
      kind: 'openai-compatible',
      id: 'My_Proxy',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4', label: 'GPT-4' }],
    })

    expect(parsed.success).toBe(false)
  })
})

describe('stored providers', () => {
  it('round-trips a catalog provider including the key', () => {
    const parsed = storedOpencodeProviders.parse([
      {
        id: 'anthropic',
        kind: 'anthropic',
        name: 'Anthropic',
        apiKey: 'sk-ant-secret',
        models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
      },
    ])

    expect(parsed[0]?.apiKey).toBe('sk-ant-secret')
  })

  it('strips the key from the public shape', () => {
    const parsed = opencodeProvider.parse({
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
    })

    expect(parsed).not.toHaveProperty('apiKey')
  })
})

describe('OPENCODE_CATALOG', () => {
  it('covers every catalog kind except custom endpoints', () => {
    const kinds = OPENCODE_CATALOG.map((entry) => entry.kind)
    expect(kinds).toContain('anthropic')
    expect(kinds).toContain('openai')
    expect(kinds).not.toContain('openai-compatible')
  })

  it('looks up a catalog entry by kind', () => {
    expect(catalogEntry('anthropic')?.name).toBe('Anthropic')
    expect(catalogEntry('openai-compatible')).toBeUndefined()
  })

  it('offers the DeepSeek models OpenCode addresses as deepseek/<id>', () => {
    expect(catalogEntry('deepseek')?.models).toEqual([
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ])
  })

  it('lists current official slugs for each catalog provider', () => {
    expect(catalogEntry('anthropic')?.models.map((model) => model.id)).toEqual([
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-haiku-4-5',
      'claude-fable-5',
    ])
    expect(catalogEntry('openai')?.models.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(catalogEntry('google')?.models.map((model) => model.id)).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3.7-flash',
    ])
    expect(catalogEntry('xai')?.models.map((model) => model.id)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-build-0.1',
    ])
  })
})
