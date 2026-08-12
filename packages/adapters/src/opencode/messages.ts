import { z } from 'zod'

/**
 * OpenCode's `opencode run --format json` wire format.
 *
 * One JSON object per stdout line. Each event has a `type` and usually a
 * `part` payload; failures carry `error` instead. Schemas are lenient about
 * unknown fields so a new OpenCode release does not break a running session.
 */

export const streamEnvelope = z.object({ type: z.string() }).passthrough()

export type StreamEnvelope = z.infer<typeof streamEnvelope>

const tokens = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache: z
      .object({
        read: z.number().optional(),
        write: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const stepStartMessage = z
  .object({
    type: z.literal('step_start'),
    sessionID: z.string().optional(),
    part: z
      .object({
        sessionID: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const textMessage = z
  .object({
    type: z.literal('text'),
    sessionID: z.string().optional(),
    part: z
      .object({
        text: z.string().optional(),
        sessionID: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const reasoningMessage = z
  .object({
    type: z.literal('reasoning'),
    sessionID: z.string().optional(),
    part: z
      .object({
        text: z.string().optional(),
        sessionID: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const toolUseMessage = z
  .object({
    type: z.literal('tool_use'),
    sessionID: z.string().optional(),
    part: z
      .object({
        callID: z.string().optional(),
        id: z.string().optional(),
        tool: z.string().optional(),
        sessionID: z.string().optional(),
        state: z
          .object({
            status: z.string().optional(),
            input: z.unknown().optional(),
            output: z.unknown().optional(),
            error: z.unknown().optional(),
            title: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const stepFinishMessage = z
  .object({
    type: z.literal('step_finish'),
    sessionID: z.string().optional(),
    part: z
      .object({
        reason: z.string().optional(),
        tokens: tokens.optional(),
        sessionID: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export const errorMessage = z
  .object({
    type: z.literal('error'),
    sessionID: z.string().optional(),
    error: z
      .object({
        name: z.string().optional(),
        data: z
          .object({
            message: z.string().optional(),
          })
          .passthrough()
          .optional(),
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type StepStartMessage = z.infer<typeof stepStartMessage>
export type TextMessage = z.infer<typeof textMessage>
export type ReasoningMessage = z.infer<typeof reasoningMessage>
export type ToolUseMessage = z.infer<typeof toolUseMessage>
export type StepFinishMessage = z.infer<typeof stepFinishMessage>
export type ErrorMessage = z.infer<typeof errorMessage>
