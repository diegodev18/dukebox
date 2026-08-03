import type { AgentEvent } from '@dukebox/protocol'
import {
  assistantMessage,
  initMessage,
  resultMessage,
  streamEnvelope,
  userMessage,
  type AssistantMessage,
  type InitMessage,
  type ResultMessage,
  type UserRoleMessage,
} from './messages.js'

/**
 * Translate Claude Code's stream into AgentEvents.
 *
 * Stateful because the wire format is: `session_id` arrives on an early
 * message and is needed later, and a turn's end has to be recognized to emit
 * `done`. One mapper instance handles one session.
 *
 * Each message is matched on `type` and then parsed against that variant's
 * schema. A message whose type is unknown, or whose shape does not match, is
 * skipped rather than fatal — an agent release that adds a message type must
 * not break a running session.
 */
export class ClaudeCodeMapper {
  private sessionId: string | undefined
  private model: string | undefined
  private started = false

  /** The agent's session id, once seen. Used to resume the conversation. */
  get agentSessionId(): string | undefined {
    return this.sessionId
  }

  /**
   * Map one parsed stream message to zero or more AgentEvents.
   *
   * Most messages produce exactly one event, an assistant message with several
   * content blocks produces one per block, and lifecycle messages produce none.
   */
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
      case 'system':
        return this.mapSystem(raw)
      case 'assistant':
        return this.mapAssistant(raw)
      case 'user':
        return this.mapUser(raw)
      case 'result':
        return this.mapResult(raw)
      default:
        // rate_limit_event and anything added in a future release.
        return []
    }
  }

  private mapSystem(raw: unknown): AgentEvent[] {
    const parsed = initMessage.safeParse(raw)
    // Hook lifecycle chatter and other system messages describe the agent's
    // own internals and mean nothing to a Dukebox session.
    if (!parsed.success) return []

    const init: InitMessage = parsed.data
    this.sessionId = init.session_id
    this.model = init.model ?? this.model

    // A resumed session emits init again; the UI should not see a second
    // start for what the user experiences as one conversation.
    if (this.started) return []
    this.started = true

    return [
      {
        type: 'session_started',
        agentId: 'claude-code',
        ...(this.model ? { model: this.model } : {}),
      },
    ]
  }

  private mapAssistant(raw: unknown): AgentEvent[] {
    const parsed = assistantMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: AssistantMessage = parsed.data
    this.sessionId = message.session_id ?? this.sessionId

    const events: AgentEvent[] = []

    for (const block of message.message.content) {
      switch (block.type) {
        case 'text':
          // Non-streaming output arrives as whole blocks rather than deltas.
          // Emitting it as one delta keeps the consumer's model uniform: it
          // always appends, whether the source streams or not.
          events.push({ type: 'assistant_text', delta: blockString(block, 'text') })
          break

        case 'thinking':
        case 'redacted_thinking': {
          // Field name varies by block variant, and a redacted block carries
          // no readable text at all — the model reasoned, but the content is
          // withheld. Emitting an empty delta would put a blank bubble in the
          // transcript, so say what happened instead.
          const text =
            blockString(block, 'thinking') ||
            blockString(block, 'text') ||
            blockString(block, 'data')

          events.push({
            type: 'thinking',
            delta: text || '(reasoning withheld)',
          })
          break
        }

        case 'tool_use': {
          const tool = block as { id?: unknown; name?: unknown; input?: unknown }
          events.push({
            type: 'tool_call',
            id: String(tool.id ?? ''),
            name: String(tool.name ?? 'unknown'),
            input: tool.input,
          })
          break
        }

        default:
          // Unknown block type: degrade to silence rather than to a broken
          // session.
          break
      }
    }

    // Per-message usage is deliberately dropped. Every assistant message in a
    // turn carries a running count, so forwarding them would give the UI
    // several overlapping numbers and no way to tell which is current. The
    // result message carries the authoritative total.
    return events
  }

  /**
   * A user-role message, which in this format carries tool results.
   *
   * Prompts the user actually typed are echoed here too; those are skipped,
   * since the control plane already recorded them when it sent them.
   */
  private mapUser(raw: unknown): AgentEvent[] {
    const parsed = userMessage.safeParse(raw)
    if (!parsed.success) return []

    const message: UserRoleMessage = parsed.data
    this.sessionId = message.session_id ?? this.sessionId

    const content = message.message.content
    if (typeof content === 'string') return []

    const events: AgentEvent[] = []

    for (const block of content) {
      if (block.type !== 'tool_result') continue

      const result = block as {
        tool_use_id?: unknown
        is_error?: unknown
        content?: unknown
      }

      events.push({
        type: 'tool_result',
        id: String(result.tool_use_id ?? ''),
        output: stringifyToolOutput(result.content),
        // Recorded streams use null for success as often as false, so only an
        // explicit true counts as a failure.
        isError: result.is_error === true,
      })
    }

    return events
  }

  private mapResult(raw: unknown): AgentEvent[] {
    const parsed = resultMessage.safeParse(raw)
    if (!parsed.success) return []

    const result: ResultMessage = parsed.data
    this.sessionId = result.session_id ?? this.sessionId

    const events: AgentEvent[] = []

    const usageEvent = toUsageEvent(result.usage, result.total_cost_usd)
    if (usageEvent) events.push(usageEvent)

    if (result.is_error === true) {
      events.push({
        type: 'error',
        message: result.result ?? `agent failed: ${result.subtype}`,
        // The turn is over but the session survives; a follow-up can continue.
        fatal: false,
      })
      events.push({ type: 'done', reason: 'error' })
      return events
    }

    events.push({
      type: 'done',
      reason: result.subtype === 'error_during_execution' ? 'error' : 'completed',
    })

    return events
  }
}

/** Read a string field off a content block that may be missing it. */
function blockString(block: object, key: string): string {
  const value = (block as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Build a usage event, or nothing when there are no token counts.
 *
 * Cache tokens count as input: they were read to produce the turn, and folding
 * them in is what makes the reported total match what was actually consumed.
 */
function toUsageEvent(
  usage: Record<string, unknown> | undefined,
  costUsd: number | undefined,
): AgentEvent | undefined {
  if (!usage) return undefined

  const inputTokens =
    numberOr(usage.input_tokens) +
    numberOr(usage.cache_creation_input_tokens) +
    numberOr(usage.cache_read_input_tokens)
  const outputTokens = numberOr(usage.output_tokens)

  if (inputTokens === 0 && outputTokens === 0) return undefined

  return {
    type: 'usage',
    inputTokens,
    outputTokens,
    ...(typeof costUsd === 'number' ? { costUsd } : {}),
  }
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Flatten a tool result's content, which may be a string or a block array. */
function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const typed = block as { type?: string; text?: unknown }
        return typed.type === 'text' ? String(typed.text ?? '') : JSON.stringify(block)
      })
      .join('\n')
  }

  return JSON.stringify(content)
}
