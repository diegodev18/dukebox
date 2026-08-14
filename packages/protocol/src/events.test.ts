import { describe, expect, it } from 'vitest'
import { agentEvent, envelopedEvent, isEventOfType, type AgentEvent } from '@/events'

describe('agentEvent', () => {
  it('accepts every variant', () => {
    const samples: AgentEvent[] = [
      { type: 'session_started', agentId: 'claude-code', model: 'claude-opus-5' },
      { type: 'assistant_text', delta: 'hello' },
      { type: 'thinking', delta: 'considering' },
      { type: 'tool_call', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
      { type: 'tool_result', id: 'call_1', output: 'contents', isError: false },
      { type: 'file_diff', path: 'a.ts', before: 'old', after: 'new' },
      { type: 'permission_request', id: 'perm_1', action: 'write', detail: null },
      { type: 'permission_mode', mode: 'plan' },
      { type: 'usage', inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
      { type: 'error', message: 'boom', fatal: true },
      { type: 'done', reason: 'completed' },
      {
        type: 'user_prompt',
        text: 'what is this',
        attachments: [
          { name: 'shot.png', mediaType: 'image/png', data: 'data:image/png;base64,QUFB' },
        ],
      },
    ]

    for (const sample of samples) {
      expect(agentEvent.safeParse(sample).success).toBe(true)
    }
  })

  it('rejects an unknown event type', () => {
    expect(agentEvent.safeParse({ type: 'telepathy', delta: 'x' }).success).toBe(false)
  })

  it('represents file creation and deletion with a null side', () => {
    expect(
      agentEvent.safeParse({ type: 'file_diff', path: 'new.ts', before: null, after: 'x' }).success,
    ).toBe(true)
    expect(
      agentEvent.safeParse({ type: 'file_diff', path: 'gone.ts', before: 'x', after: null })
        .success,
    ).toBe(true)
  })

  it('rejects negative token counts', () => {
    const result = agentEvent.safeParse({ type: 'usage', inputTokens: -1, outputTokens: 0 })
    expect(result.success).toBe(false)
  })

  it('treats costUsd as optional, since not every agent reports it', () => {
    expect(agentEvent.safeParse({ type: 'usage', inputTokens: 1, outputTokens: 2 }).success).toBe(
      true,
    )
  })

  it('rejects a done event with an unknown reason', () => {
    expect(agentEvent.safeParse({ type: 'done', reason: 'gave_up' }).success).toBe(false)
  })

  it('accepts every permission mode', () => {
    for (const mode of ['bypass', 'plan', 'auto', 'acceptEdits'] as const) {
      expect(agentEvent.safeParse({ type: 'permission_mode', mode }).success).toBe(true)
    }
  })

  it('rejects an unknown permission mode', () => {
    expect(agentEvent.safeParse({ type: 'permission_mode', mode: 'dontAsk' }).success).toBe(false)
  })
})

describe('envelopedEvent', () => {
  const valid = {
    seq: 1,
    sessionId: '3f9a2b1c-0000-4000-8000-000000000000',
    ts: 1_700_000_000_000,
    event: { type: 'assistant_text', delta: 'hi' },
  }

  it('accepts a well-formed envelope', () => {
    expect(envelopedEvent.safeParse(valid).success).toBe(true)
  })

  it('rejects seq 0, since seq is 1-based and used for resume', () => {
    expect(envelopedEvent.safeParse({ ...valid, seq: 0 }).success).toBe(false)
  })

  it('rejects a non-uuid session id', () => {
    expect(envelopedEvent.safeParse({ ...valid, sessionId: 'session-1' }).success).toBe(false)
  })
})

describe('isEventOfType', () => {
  it('narrows to the matching variant', () => {
    const event: AgentEvent = { type: 'tool_call', id: 'c1', name: 'Read', input: {} }
    if (isEventOfType(event, 'tool_call')) {
      // Accessing `name` here is the point: it only typechecks once narrowed.
      expect(event.name).toBe('Read')
    } else {
      expect.unreachable('should have narrowed to tool_call')
    }
  })

  it('returns false for a different variant', () => {
    const event: AgentEvent = { type: 'done', reason: 'completed' }
    expect(isEventOfType(event, 'assistant_text')).toBe(false)
  })
})

describe('terminal audit events', () => {
  it('parses terminal_opened', () => {
    const result = agentEvent.safeParse({
      type: 'terminal_opened',
      terminalId: 't1',
      deviceId: 'device-1',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_closed with an exit code', () => {
    const result = agentEvent.safeParse({
      type: 'terminal_closed',
      terminalId: 't1',
      deviceId: 'device-1',
      exitCode: 0,
    })

    expect(result.success).toBe(true)
  })

  it('requires the device that opened the terminal', () => {
    const result = agentEvent.safeParse({ type: 'terminal_opened', terminalId: 't1' })

    expect(result.success).toBe(false)
  })
})
