import { z } from 'zod'

/**
 * Claude Code's `--output-format stream-json` wire format.
 *
 * Written from recorded output of a pinned version rather than from
 * documentation — the real stream carries message types that no published
 * schema mentions, and fields that are nullable in practice but not in theory.
 *
 * Every schema here is deliberately lenient about unknown fields. The agent
 * adds them between releases, and a strict schema would turn a harmless new
 * field into a session that fails to start.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export const textBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const thinkingBlock = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})

export const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

/**
 * A tool's outcome, delivered on the *user* message that follows the call.
 *
 * `is_error` is nullable in recorded output: successful results often carry
 * null rather than false. Treating null as "not an error" is what the observed
 * streams mean, and a parser expecting a boolean would break on them.
 *
 * `content` is usually a string but can be an array of blocks for tools that
 * return structured output.
 */
export const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().nullable().optional(),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).optional(),
})

export const contentBlock = z.union([
  textBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
  // Unknown block types are preserved rather than rejected so a new one does
  // not break the stream; the mapper ignores what it does not recognize.
  z.object({ type: z.string() }).passthrough(),
])

export type ContentBlock = z.infer<typeof contentBlock>

// ---------------------------------------------------------------------------
// Top-level messages
// ---------------------------------------------------------------------------

/**
 * Session start. Carries the `session_id` needed to resume later.
 *
 * Arrives after the hook messages, not first — anything waiting for it must
 * tolerate earlier traffic.
 */
export const initMessage = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    tools: z.array(z.string()).optional(),
    permissionMode: z.string().optional(),
  })
  .passthrough()

/**
 * Hook lifecycle notices.
 *
 * Undocumented but always present, three of each at startup. They describe the
 * agent's own hook execution and mean nothing to a Dukebox session, so they
 * are recognized purely to be discarded.
 */
export const hookMessage = z
  .object({
    type: z.literal('system'),
    subtype: z.enum(['hook_started', 'hook_response']),
  })
  .passthrough()

/** Any other system message. Ignored, but must not be treated as malformed. */
export const systemMessage = z
  .object({
    type: z.literal('system'),
    subtype: z.string(),
  })
  .passthrough()

export const usage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  })
  .passthrough()

export const assistantMessage = z
  .object({
    type: z.literal('assistant'),
    session_id: z.string().optional(),
    message: z
      .object({
        role: z.literal('assistant'),
        content: z.array(contentBlock),
        model: z.string().optional(),
        usage: usage.optional(),
        stop_reason: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough()

/**
 * A user-role message.
 *
 * Confusingly, this is how tool *results* arrive: the agent's own tool output
 * is fed back as a user turn. It is not something a person typed.
 */
export const userMessage = z
  .object({
    type: z.literal('user'),
    session_id: z.string().optional(),
    message: z
      .object({
        role: z.literal('user'),
        content: z.union([z.string(), z.array(contentBlock)]),
      })
      .passthrough(),
  })
  .passthrough()

/** Final message of a turn, carrying cost and the aggregate result. */
export const resultMessage = z
  .object({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().optional(),
    session_id: z.string().optional(),
    result: z.string().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
    usage: usage.optional(),
  })
  .passthrough()

/** Rate limit notice. Observed mid-stream; carries no session state. */
export const rateLimitMessage = z
  .object({
    type: z.literal('rate_limit_event'),
  })
  .passthrough()

/**
 * Every message carries a `type`; nothing else is guaranteed.
 *
 * Deliberately not a union of the schemas above. A union with a permissive
 * catch-all cannot discriminate — a message typed `assistant` could match the
 * catch-all and arrive without its `message` field, so narrowing on `type`
 * would be a lie. Callers match on `type` and then parse the specific schema,
 * which is both sound and what makes unknown messages skippable.
 */
export const streamEnvelope = z.object({ type: z.string() }).passthrough()

export type StreamEnvelope = z.infer<typeof streamEnvelope>
export type InitMessage = z.infer<typeof initMessage>
export type AssistantMessage = z.infer<typeof assistantMessage>
/**
 * Named for the wire format's `user` role, which is not a user prompt: it is
 * how the agent's own tool output is fed back into the conversation. Kept
 * distinct from the adapter's `UserMessage`, which really is what a person
 * typed.
 */
export type UserRoleMessage = z.infer<typeof userMessage>
export type ResultMessage = z.infer<typeof resultMessage>
