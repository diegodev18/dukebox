import { z } from 'zod'
import { envelopedEvent } from './events.js'
import { sessionStatus, sessionSummary } from './session.js'

/**
 * WebSocket messages between the desktop app and the control plane.
 *
 * REST handles setup (pairing, listing projects, creating sessions); this
 * channel carries live session traffic in both directions.
 */

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Subscribe to a session's events.
 *
 * `resumeFrom` is the highest seq the client already has. The server replays
 * everything after it, then switches to live. Omit it to receive only new
 * events — used when the client already loaded history from its local cache.
 */
export const subscribeCommand = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string().uuid(),
  resumeFrom: z.number().int().nonnegative().optional(),
})

export const unsubscribeCommand = z.object({
  type: z.literal('unsubscribe'),
  sessionId: z.string().uuid(),
})

/** Send a prompt to the agent. */
export const promptCommand = z.object({
  type: z.literal('prompt'),
  sessionId: z.string().uuid(),
  text: z.string().min(1),
  /** Base64 data URIs. Agents without image support reject these. */
  images: z.array(z.string()).optional(),
})

/** Answer a permission_request. `id` matches the request. */
export const permissionResponseCommand = z.object({
  type: z.literal('permission_response'),
  sessionId: z.string().uuid(),
  id: z.string(),
  allow: z.boolean(),
})

/** Stop the current turn. Only valid where capabilities.interrupt is true. */
export const interruptCommand = z.object({
  type: z.literal('interrupt'),
  sessionId: z.string().uuid(),
})

export const clientCommand = z.discriminatedUnion('type', [
  subscribeCommand,
  unsubscribeCommand,
  promptCommand,
  permissionResponseCommand,
  interruptCommand,
])

export type ClientCommand = z.infer<typeof clientCommand>

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** A session event, live or replayed. */
export const eventMessage = z.object({
  type: z.literal('event'),
  event: envelopedEvent,
})

/**
 * Replay finished; everything after this is live.
 *
 * The client uses this to drop the "catching up" state — without it there is no
 * way to tell a slow replay from an idle session.
 */
export const caughtUpMessage = z.object({
  type: z.literal('caught_up'),
  sessionId: z.string().uuid(),
  lastSeq: z.number().int().nonnegative(),
})

/** Session status changed. Drives the sidebar without re-fetching. */
export const sessionUpdateMessage = z.object({
  type: z.literal('session_update'),
  session: sessionSummary,
})

/**
 * A command failed.
 *
 * `sessionId` is absent for failures that are not session-scoped, such as a
 * malformed command.
 */
export const commandErrorMessage = z.object({
  type: z.literal('command_error'),
  sessionId: z.string().uuid().optional(),
  message: z.string(),
})

/**
 * The subscription is over and no more events will arrive.
 *
 * Distinct from a dropped connection: the client should stop reconnecting.
 */
export const subscriptionClosedMessage = z.object({
  type: z.literal('subscription_closed'),
  sessionId: z.string().uuid(),
  status: sessionStatus,
})

export const serverMessage = z.discriminatedUnion('type', [
  eventMessage,
  caughtUpMessage,
  sessionUpdateMessage,
  commandErrorMessage,
  subscriptionClosedMessage,
])

export type ServerMessage = z.infer<typeof serverMessage>
