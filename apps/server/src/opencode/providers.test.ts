import { describe, expect, it } from 'vitest'
import {
  buildOpencodeSessionEnv,
  customProviderEnvVar,
  resolveStoredProvider,
} from './providers.js'

describe('resolveStoredProvider', () => {
  it('keys a catalog provider by kind and fills in catalog defaults', () => {
    const stored = resolveStoredProvider({
      kind: 'anthropic',
      apiKey: 'sk-ant-test',
    })

    expect(stored.id).toBe('anthropic')
    expect(stored.name).toBe('Anthropic')
    expect(stored.models.length).toBeGreaterThan(0)
    expect(stored.apiKey).toBe('sk-ant-test')
  })

  it('keeps a custom provider id and base URL', () => {
    const stored = resolveStoredProvider({
      kind: 'openai-compatible',
      id: 'my-proxy',
      name: 'My Proxy',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      models: [{ id: 'gpt-4', label: 'GPT-4' }],
    })

    expect(stored).toMatchObject({
      id: 'my-proxy',
      baseUrl: 'https://api.example.com/v1',
    })
  })
})

describe('buildOpencodeSessionEnv', () => {
  it('injects native env vars and auth.json for catalog providers', () => {
    const env = buildOpencodeSessionEnv([
      {
        id: 'anthropic',
        kind: 'anthropic',
        name: 'Anthropic',
        apiKey: 'sk-ant-test',
        models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
      },
    ])

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(JSON.parse(env.DUKEBOX_OPENCODE_AUTH_JSON ?? '')).toEqual({
      anthropic: { type: 'api', key: 'sk-ant-test' },
    })
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  it('describes a custom endpoint in OPENCODE_CONFIG_CONTENT', () => {
    const env = buildOpencodeSessionEnv([
      {
        id: 'my-proxy',
        kind: 'openai-compatible',
        name: 'My Proxy',
        apiKey: 'sk-proxy',
        baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'gpt-4', label: 'GPT-4' }],
      },
    ])

    const envVar = customProviderEnvVar('my-proxy')
    expect(env[envVar]).toBe('sk-proxy')

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as {
      provider: Record<string, { options: { apiKey: string; baseURL: string } }>
    }
    expect(config.provider['my-proxy']?.options.baseURL).toBe('https://api.example.com/v1')
    expect(config.provider['my-proxy']?.options.apiKey).toBe(`{env:${envVar}}`)
  })

  it('points instructions at the file the adapter writes', () => {
    const env = buildOpencodeSessionEnv([], 'Always run typecheck.')
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as { instructions: string[] }

    expect(config.instructions).toEqual(['/tmp/dukebox-instructions.md'])
  })
})
