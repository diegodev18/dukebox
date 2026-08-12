import { z } from 'zod'
import { permissionMode } from './session.js'

/**
 * The normalized event stream every agent is translated into.
 *
 * Adapters map their agent's native output onto these events, and nothing
 * downstream — the control plane, the desktop app — ever learns which agent
 * produced them. Adding an agent means writing an adapter, not touching the UI.
 *
 * Changing an existing variant is a breaking protocol change: old events are
 * replayed from storage, so variants must stay backward compatible.
 */

/**
 * What the user sent the agent.
 *
 * Recorded because the conversation is half the record: a transcript that shows
 * only the agent's side reads as answers to questions nobody asked. Appended by
 * the control plane at the moment it forwards the prompt, which is also the
 * only place that sees the first one — that one is sent while the session is
 * still provisioning, before any client is watching.
 */
export const userPromptEvent = z.object({
  type: z.literal('user_prompt'),
  text: z.string(),
})

/** A block of text from the agent, streamed in deltas. */
export const assistantTextEvent = z.object({
  type: z.literal('assistant_text'),
  delta: z.string(),
})

/** Reasoning output, where the agent exposes it. Collapsed by default in the UI. */
export const thinkingEvent = z.object({
  type: z.literal('thinking'),
  delta: z.string(),
})

/** The agent invoked a tool. Paired with a tool_result carrying the same id. */
export const toolCallEvent = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

/** The outcome of a tool_call. `id` matches the originating call. */
export const toolResultEvent = z.object({
  type: z.literal('tool_result'),
  id: z.string(),
  output: z.string(),
  isError: z.boolean(),
})

/**
 * A file changed in the workspace.
 *
 * Derived from `git diff` against the session branch, never from the agent's
 * own tool results — that keeps diffs correct no matter how the agent writes
 * files (editor tool, shell redirect, running a formatter).
 *
 * `before: null` means the file was created, `after: null` means it was deleted.
 */
export const fileDiffEvent = z.object({
  type: z.literal('file_diff'),
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
})

/** The agent is asking permission to act. The UI must answer before it proceeds. */
export const permissionRequestEvent = z.object({
  type: z.literal('permission_request'),
  id: z.string(),
  action: z.string(),
  detail: z.unknown(),
})

/**
 * The agent's permission mode changed.
 *
 * Folded into transcript state rather than a block: it is chrome (the
 * composer picker), not something to read in the conversation.
 */
export const permissionModeEvent = z.object({
  type: z.literal('permission_mode'),
  mode: permissionMode,
})

/** Token and cost accounting for the turn. */
export const usageEvent = z.object({
  type: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
})

/** The agent session began. Emitted once per start or resume. */
export const sessionStartedEvent = z.object({
  type: z.literal('session_started'),
  agentId: z.string(),
  model: z.string().optional(),
})

/** Something went wrong. `fatal` means the session cannot continue. */
export const errorEvent = z.object({
  type: z.literal('error'),
  message: z.string(),
  fatal: z.boolean(),
})

/** The turn ended. */
export const doneEvent = z.object({
  type: z.literal('done'),
  reason: z.enum(['completed', 'interrupted', 'error']),
})

/**
 * Someone opened a shell in this session's container.
 *
 * Recorded because a person ran commands here, and the transcript otherwise
 * shows only what the agent did. Deliberately carries no I/O: people paste
 * secrets into shells, and a keystroke log in the database would be a liability
 * worth more than the forensics.
 *
 * Unlike every other variant here, this one and its sibling are emitted by the
 * control plane rather than by an agent adapter. They belong in this union
 * anyway: the union is the session's persisted stream, which is where an audit
 * record has to live.
 */
export const terminalOpenedEvent = z.object({
  type: z.literal('terminal_opened'),
  terminalId: z.string(),
  deviceId: z.string(),
})

export const terminalClosedEvent = z.object({
  type: z.literal('terminal_closed'),
  terminalId: z.string(),
  deviceId: z.string(),
  exitCode: z.number().int().optional(),
})

export const agentEvent = z.discriminatedUnion('type', [
  sessionStartedEvent,
  userPromptEvent,
  assistantTextEvent,
  thinkingEvent,
  toolCallEvent,
  toolResultEvent,
  fileDiffEvent,
  permissionRequestEvent,
  permissionModeEvent,
  usageEvent,
  errorEvent,
  doneEvent,
  terminalOpenedEvent,
  terminalClosedEvent,
])

export type AgentEvent = z.infer<typeof agentEvent>
export type AgentEventType = AgentEvent['type']

/**
 * An event as stored and transmitted.
 *
 * `seq` is monotonic per session and assigned by the control plane. It is what
 * lets a client reconnect and ask for everything after the last event it saw,
 * and what keeps the client's local cache consistent with the server.
 */
export const envelopedEvent = z.object({
  seq: z.number().int().positive(),
  sessionId: z.string().uuid(),
  ts: z.number().int().positive(),
  event: agentEvent,
})

export type EnvelopedEvent = z.infer<typeof envelopedEvent>

/** Narrow an AgentEvent to a specific variant. */
export function isEventOfType<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type
}
