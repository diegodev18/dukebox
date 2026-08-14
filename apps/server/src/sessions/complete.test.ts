import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeChat,
  firstProvider,
  matchProvider,
  resolveSessionModel,
  type WriterModel,
} from './complete.js'

const ANTHROPIC = {
  id: 'anthropic',
  kind: 'anthropic' as const,
  name: 'Anthropic',
  apiKey: 'sk-ant-test',
  models: [
    { id: 'claude-haiku-4-5', label: 'Haiku' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet' },
  ],
}

const XAI = {
  id: 'xai',
  kind: 'xai' as const,
  name: 'xAI',
  apiKey: 'xai-test',
  models: [{ id: 'grok-4', label: 'Grok 4' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('matchProvider', () => {
  it('picks a provider/model spec', () => {
    expect(matchProvider([ANTHROPIC, XAI], 'anthropic/claude-sonnet-4-5')).toEqual({
      kind: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-test',
    })
  })

  it('falls back to the provider first model when only the id is given', () => {
    expect(matchProvider([ANTHROPIC], 'anthropic')).toEqual({
      kind: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-test',
    })
  })

  it('returns nothing for an unknown provider', () => {
    expect(matchProvider([ANTHROPIC], 'openai/gpt-4.1')).toBeNull()
  })

  it('returns nothing when the provider has no models and none was named', () => {
    expect(matchProvider([{ ...ANTHROPIC, models: [] }], 'anthropic')).toBeNull()
  })
})

describe('firstProvider', () => {
  it('returns nothing for an empty catalog', () => {
    expect(firstProvider([])).toBeNull()
  })

  it('takes the first model of the first provider', () => {
    expect(firstProvider([XAI, ANTHROPIC])).toEqual({
      kind: 'xai',
      model: 'grok-4',
      apiKey: 'xai-test',
    })
  })
})

describe('resolveSessionModel', () => {
  it('returns nothing without a secret store', async () => {
    expect(await resolveSessionModel({ sessionModel: 'anthropic/claude-haiku-4-5' })).toBeNull()
  })

  it('prefers the session model when it matches', async () => {
    const secrets = {
      get: async () => JSON.stringify([ANTHROPIC, XAI]),
    }

    expect(
      await resolveSessionModel({ secrets: secrets as never, sessionModel: 'xai/grok-4' }),
    ).toEqual({
      kind: 'xai',
      model: 'grok-4',
      apiKey: 'xai-test',
    })
  })
})

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('completeChat', () => {
  const anthropic: WriterModel = {
    kind: 'anthropic',
    model: 'claude-haiku-4-5',
    apiKey: 'sk-ant-test',
  }

  it('posts to Anthropic and returns the first text block', async () => {
    const fetchMock = stubFetch({
      content: [
        { type: 'thinking', text: 'hidden' },
        { type: 'text', text: 'Add a health check' },
      ],
    })

    await expect(completeChat('sys', 'user', anthropic, 80)).resolves.toBe('Add a health check')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'sk-ant-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    )
    const sent = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      max_tokens: number
    }
    expect(sent.max_tokens).toBe(80)
  })

  it('returns an empty string when Anthropic sends no text block', async () => {
    stubFetch({ content: [{ type: 'thinking' }] })
    await expect(completeChat('sys', 'user', anthropic)).resolves.toBe('')
  })

  it('names a non-OK Anthropic status', async () => {
    stubFetch({ error: 'overloaded' }, 529)
    await expect(completeChat('sys', 'user', anthropic)).rejects.toThrow(/anthropic 529/)
  })

  it('posts to the OpenAI-compat URL for a catalog provider', async () => {
    const fetchMock = stubFetch({
      choices: [{ message: { content: 'Name the session' } }],
    })

    await expect(
      completeChat('sys', 'user', { kind: 'xai', model: 'grok-4', apiKey: 'xai-test' }),
    ).resolves.toBe('Name the session')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.x.ai/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer xai-test' }),
      }),
    )
  })

  it('joins a custom base URL without a trailing slash', async () => {
    const fetchMock = stubFetch({ choices: [{ message: { content: 'ok' } }] })

    await completeChat('sys', 'user', {
      kind: 'openai-compatible',
      model: 'local',
      apiKey: 'sk-test',
      baseUrl: 'https://example.test/v1',
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v1/chat/completions')
  })

  it('names a non-OK completions status', async () => {
    stubFetch({ error: 'unauthorized' }, 401)
    await expect(
      completeChat('sys', 'user', { kind: 'openai', model: 'gpt-4.1', apiKey: 'sk-test' }),
    ).rejects.toThrow(/completions 401/)
  })
})
