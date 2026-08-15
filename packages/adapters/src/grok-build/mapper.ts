import type { AgentEvent } from '@dukebox/protocol'
import { GROK_REAUTH_MESSAGE, isGrokUnsignedError } from '@/grok-build/auth'
import {
  endMessage,
  errorMessage,
  streamEnvelope,
  textMessage,
  thoughtMessage,
  toolCallMessage,
  toolCallUpdateMessage,
  usageMessage,
  type EndMessage,
  type ErrorMessage,
  type TextMessage,
  type ThoughtMessage,
  type ToolCallMessage,
  type ToolCallUpdateMessage,
  type UsageMessage,
} from '@/grok-build/messages'

/**
 * Translate Grok Build's streaming-json NDJSON into AgentEvents.
 *
 * Stateful because the session id arrives on `end` and is needed to resume
 * later, and because `session_started` must fire once per adapter lifetime.
 * One mapper instance handles one Dukebox session, which may span several
 * `grok -p` processes.
 *
 * A turn's `done` is not mapped here: Grok emits `end` for the process, but
 * the adapter emits `done` when the process exits so a crashed process still
 * closes the turn.
 */

export class GrokBuildMapper {
  private sessionId: string | undefined
  private model: string | undefined
  private started = false

  /** The agent's session id, once seen. Used to resume the conversation. */
  get agentSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * Seed the session id before any output, so a follow-up `grok --resume`
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
      case 'text':
        return this.withSessionStart(this.mapText(raw))
      case 'thought':
        return this.withSessionStart(this.mapThought(raw))
      case 'tool_call':
        return this.withSessionStart(this.mapToolCall(raw))
      case 'tool_call_update':
        return this.withSessionStart(this.mapToolCallUpdate(raw))
      case 'usage':
        return this.withSessionStart(this.mapUsage(raw))
      case 'end':
        return this.mapEnd(raw)
      case 'error':
        return this.mapError(raw)
      default:
        return []
    }
  }

  private withSessionStart(events: AgentEvent[], force = false): AgentEvent[] {
    if (events.length === 0 && !force) return events
    if (this.started) return events

    this.started = true
    return [
      {
        type: 'session_started',
        agentId: 'grok-build',
        ...(this.model ? { model: this.model } : {}),
      },
      ...events,
    ]
  }

  private mapText(raw: unknown): AgentEvent[] {
    const parsed = textMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: TextMessage = parsed.data
    const text = message.data ?? ''
    if (text === '') return []

    return [{ type: 'assistant_text', delta: text }]
  }

  private mapThought(raw: unknown): AgentEvent[] {
    const parsed = thoughtMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ThoughtMessage = parsed.data
    const text = message.data ?? ''
    if (text === '') return []

    return [{ type: 'thinking', delta: text }]
  }

  private mapToolCall(raw: unknown): AgentEvent[] {
    const parsed = toolCallMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ToolCallMessage = parsed.data
    return [
      {
        type: 'tool_call',
        id: message.toolCallId || '',
        name: message.toolName || message.title || 'unknown',
        input: message.rawInput,
      },
    ]
  }

  private mapToolCallUpdate(raw: unknown): AgentEvent[] {
    const parsed = toolCallUpdateMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ToolCallUpdateMessage = parsed.data
    const status = message.status
    if (status === 'in_progress' || status === 'pending' || status === 'running') {
      return []
    }

    const isError = status === 'failed' || status === 'error'
    if (status !== 'completed' && !isError) return []

    return [
      {
        type: 'tool_result',
        id: message.toolCallId || '',
        output: stringifyToolOutput(message.rawOutput ?? message.content),
        isError,
      },
    ]
  }

  private mapUsage(raw: unknown): AgentEvent[] {
    const parsed = usageMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: UsageMessage = parsed.data
    return toUsageEvents(message.usage, message.total_cost_usd)
  }

  private mapEnd(raw: unknown): AgentEvent[] {
    const parsed = endMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: EndMessage = parsed.data
    if (message.sessionId) this.sessionId = message.sessionId

    // `end` always closes a real turn, so it opens the session even when
    // there is no usage payload — otherwise a stream of only `end` never
    // emits session_started and the control plane never stores the id.
    return this.withSessionStart(toUsageEvents(message.usage, message.total_cost_usd), true)
  }

  private mapError(raw: unknown): AgentEvent[] {
    const parsed = errorMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: ErrorMessage = parsed.data
    const text = message.message || 'grok error'
    if (isGrokUnsignedError(text)) {
      return [{ type: 'error', message: GROK_REAUTH_MESSAGE, fatal: true }]
    }
    return [{ type: 'error', message: text, fatal: false }]
  }
}

function toUsageEvents(
  tokens: { [key: string]: unknown } | undefined,
  costUsd: number | undefined,
): AgentEvent[] {
  const inputTokens =
    numberOr(tokens?.input_tokens) +
    numberOr(tokens?.cache_read_input_tokens) +
    numberOr(tokens?.cache_creation_input_tokens)
  const outputTokens = numberOr(tokens?.output_tokens) + numberOr(tokens?.reasoning_tokens)

  if (inputTokens === 0 && outputTokens === 0 && costUsd === undefined) return []

  return [
    {
      type: 'usage',
      inputTokens,
      outputTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
  ]
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}
