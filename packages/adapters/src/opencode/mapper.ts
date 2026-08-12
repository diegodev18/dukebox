import type { AgentEvent } from '@dukebox/protocol'
import {
  errorMessage,
  reasoningMessage,
  stepFinishMessage,
  stepStartMessage,
  streamEnvelope,
  textMessage,
  toolUseMessage,
  type ErrorMessage,
  type ReasoningMessage,
  type StepFinishMessage,
  type StepStartMessage,
  type TextMessage,
  type ToolUseMessage,
} from './messages.js'

/**
 * Translate OpenCode's JSONL stream into AgentEvents.
 *
 * Stateful because the session id arrives on an early `step_start` and is
 * needed to resume later, and because `session_started` must fire once per
 * adapter lifetime. One mapper instance handles one Dukebox session, which
 * may span several `opencode run` processes.
 *
 * A turn's `done` is not mapped here: OpenCode emits several `step_finish`
 * events inside one run (tool loops). The adapter emits `done` when the
 * process exits.
 */
export class OpenCodeMapper {
  private sessionId: string | undefined
  private model: string | undefined
  private started = false

  /** The agent's session id, once seen. Used to resume the conversation. */
  get agentSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * Seed the session id before any output, so a follow-up `run --session`
   * can fire before the first event of this process arrives.
   */
  rememberSession(sessionId?: string, model?: string): void {
    if (sessionId) this.sessionId = sessionId
    if (model) this.model = model
  }

  map(raw: unknown): AgentEvent[] {
    const envelope = streamEnvelope.safeParse(raw)
    if (!envelope.success) {
      return [
        {
          type: 'error',
          message: 'unrecognized message from agent: missing type',
          fatal: false,
        },
      ]
    }

    switch (envelope.data.type) {
      case 'step_start':
        return this.mapStepStart(raw)
      case 'text':
        return this.mapText(raw)
      case 'reasoning':
        return this.mapReasoning(raw)
      case 'tool_use':
        return this.mapToolUse(raw)
      case 'step_finish':
        return this.mapStepFinish(raw)
      case 'error':
        return this.mapError(raw)
      default:
        return []
    }
  }

  private rememberFrom(sessionID: string | undefined, nested?: string): void {
    const id = sessionID ?? nested
    if (id) this.sessionId = id
  }

  private mapStepStart(raw: unknown): AgentEvent[] {
    const parsed = stepStartMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: StepStartMessage = parsed.data
    this.rememberFrom(message.sessionID, message.part?.sessionID)

    if (this.started) return []
    this.started = true

    return [
      {
        type: 'session_started',
        agentId: 'opencode',
        ...(this.model ? { model: this.model } : {}),
      },
    ]
  }

  private mapText(raw: unknown): AgentEvent[] {
    const parsed = textMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: TextMessage = parsed.data
    this.rememberFrom(message.sessionID, message.part?.sessionID)

    const text = message.part?.text ?? ''
    if (text === '') return []

    return [{ type: 'assistant_text', delta: text }]
  }

  private mapReasoning(raw: unknown): AgentEvent[] {
    const parsed = reasoningMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ReasoningMessage = parsed.data
    this.rememberFrom(message.sessionID, message.part?.sessionID)

    const text = message.part?.text ?? ''
    if (text === '') return []

    return [{ type: 'thinking', delta: text }]
  }

  private mapToolUse(raw: unknown): AgentEvent[] {
    const parsed = toolUseMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ToolUseMessage = parsed.data
    this.rememberFrom(message.sessionID, message.part?.sessionID)

    const part = message.part
    if (!part) return []

    const id = part.callID || part.id || ''
    const name = part.tool || 'unknown'
    const state = part.state
    const events: AgentEvent[] = [
      {
        type: 'tool_call',
        id,
        name,
        input: state?.input,
      },
    ]

    // OpenCode's JSONL typically emits a tool only once it has finished, so
    // the call and the result arrive together. A pending/running state has
    // no output yet; the result will come on a later event if one exists.
    if (state && state.status !== 'pending' && state.status !== 'running') {
      events.push({
        type: 'tool_result',
        id,
        output: stringifyToolOutput(state.output ?? state.error),
        isError: state.status === 'error' || state.error !== undefined,
      })
    }

    return events
  }

  private mapStepFinish(raw: unknown): AgentEvent[] {
    const parsed = stepFinishMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: StepFinishMessage = parsed.data
    this.rememberFrom(message.sessionID, message.part?.sessionID)

    const usage = toUsageEvent(message.part?.tokens)
    return usage ? [usage] : []
  }

  private mapError(raw: unknown): AgentEvent[] {
    const parsed = errorMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ErrorMessage = parsed.data
    this.rememberFrom(message.sessionID)

    const text =
      message.error?.data?.message ||
      message.error?.message ||
      message.error?.name ||
      'opencode error'

    return [{ type: 'error', message: text, fatal: false }]
  }
}

function toUsageEvent(tokens: unknown): AgentEvent | undefined {
  if (!tokens || typeof tokens !== 'object') return undefined

  const record = tokens as {
    input?: unknown
    output?: unknown
    reasoning?: unknown
    cache?: { read?: unknown; write?: unknown }
  }

  const inputTokens =
    numberOr(record.input) + numberOr(record.cache?.read) + numberOr(record.cache?.write)
  const outputTokens = numberOr(record.output) + numberOr(record.reasoning)

  if (inputTokens === 0 && outputTokens === 0) return undefined

  return { type: 'usage', inputTokens, outputTokens }
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}
