import { describe, expect, it } from 'vitest'
import { clientCommand, serverMessage } from './commands.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

describe('terminal commands', () => {
  it('parses terminal_open with a size', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_open',
      sessionId,
      cols: 80,
      rows: 24,
    })

    expect(result.success).toBe(true)
  })

  it('rejects a terminal_open without a size', () => {
    const result = clientCommand.safeParse({ type: 'terminal_open', sessionId })

    expect(result.success).toBe(false)
  })

  it('rejects a zero-column terminal, which no PTY accepts', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_open',
      sessionId,
      cols: 0,
      rows: 24,
    })

    expect(result.success).toBe(false)
  })

  it('parses terminal_input carrying base64 payloads', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_input',
      sessionId,
      terminalId: 't1',
      data: 'bHMgLWxhCg==',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_detach, which leaves the process running', () => {
    const result = clientCommand.safeParse({
      type: 'terminal_detach',
      sessionId,
      terminalId: 't1',
    })

    expect(result.success).toBe(true)
  })
})

describe('terminal messages', () => {
  it('parses terminal_output', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_output',
      sessionId,
      terminalId: 't1',
      data: 'aGVsbG8=',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_exit without an exit code, for a stream that just ended', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_exit',
      sessionId,
      terminalId: 't1',
    })

    expect(result.success).toBe(true)
  })

  it('parses terminal_list with no terminals', () => {
    const result = serverMessage.safeParse({
      type: 'terminal_list',
      sessionId,
      terminals: [],
    })

    expect(result.success).toBe(true)
  })
})
