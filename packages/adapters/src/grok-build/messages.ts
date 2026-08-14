import { z } from 'zod'

/**
 * Grok Build's `grok -p --output-format streaming-json` wire format.
 *
 * One JSON object per stdout line. Each event has a `type`; text and thought
 * carry `data`, tools carry `toolCallId`, and the turn ends with `end`.
 * Schemas are lenient about unknown fields so a new Grok release does not
 * break a running session.
 */

export const streamEnvelope = z.object({ type: z.string() }).passthrough()

export type StreamEnvelope = z.infer<typeof streamEnvelope>

const usageTokens = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
  })
  .passthrough()

export const textMessage = z
  .object({
    type: z.literal('text'),
    data: z.string().optional(),
  })
  .passthrough()

export const thoughtMessage = z
  .object({
    type: z.literal('thought'),
    data: z.string().optional(),
  })
  .passthrough()

export const toolCallMessage = z
  .object({
    type: z.literal('tool_call'),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    toolName: z.string().optional(),
    status: z.string().optional(),
    rawInput: z.unknown().optional(),
  })
  .passthrough()

export const toolCallUpdateMessage = z
  .object({
    type: z.literal('tool_call_update'),
    toolCallId: z.string().optional(),
    status: z.string().optional(),
    rawOutput: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .passthrough()

export const usageMessage = z
  .object({
    type: z.literal('usage'),
    usage: usageTokens.optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough()

export const endMessage = z
  .object({
    type: z.literal('end'),
    sessionId: z.string().optional(),
    usage: usageTokens.optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough()

export const errorMessage = z
  .object({
    type: z.literal('error'),
    message: z.string().optional(),
  })
  .passthrough()

export type TextMessage = z.infer<typeof textMessage>
export type ThoughtMessage = z.infer<typeof thoughtMessage>
export type ToolCallMessage = z.infer<typeof toolCallMessage>
export type ToolCallUpdateMessage = z.infer<typeof toolCallUpdateMessage>
export type UsageMessage = z.infer<typeof usageMessage>
export type EndMessage = z.infer<typeof endMessage>
export type ErrorMessage = z.infer<typeof errorMessage>
