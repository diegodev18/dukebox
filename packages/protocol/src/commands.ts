import { z } from 'zod'
import { envelopedEvent } from './events.js'
import { permissionMode, sessionStatus, sessionSummary } from './session.js'

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

/** Change how the agent is allowed to act. No-op when the agent has no modes. */
export const setPermissionModeCommand = z.object({
  type: z.literal('set_permission_mode'),
  sessionId: z.string().uuid(),
  mode: permissionMode,
})

/**
 * Turn Claude Code Remote Control on or off for a running session.
 *
 * No-op when the agent cannot enable it. Enabling registers the session
 * with claude.ai; the URL arrives as a `remote_control` event.
 */
export const setRemoteControlCommand = z.object({
  type: z.literal('set_remote_control'),
  sessionId: z.string().uuid(),
  enabled: z.boolean(),
})

/**
 * Terminal size in character cells.
 *
 * A PTY with zero rows or columns is not a degenerate terminal, it is an
 * invalid one: curses applications divide by these.
 */
const terminalSize = {
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
}

/** Open a new shell in the session's container. The server assigns the id. */
export const terminalOpenCommand = z.object({
  type: z.literal('terminal_open'),
  sessionId: z.string().uuid(),
  ...terminalSize,
})

/**
 * Start receiving output from an existing terminal.
 *
 * The server replies with the scrollback buffer, so a reattached terminal
 * redraws rather than resuming mid-screen.
 */
export const terminalAttachCommand = z.object({
  type: z.literal('terminal_attach'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  ...terminalSize,
})

/**
 * Stop receiving output. The process keeps running.
 *
 * Sent when the panel is hidden. Distinct from `terminal_close`, which kills
 * the shell — switching tabs must not end a long-running command.
 */
export const terminalDetachCommand = z.object({
  type: z.literal('terminal_detach'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
})

/** Keystrokes for the PTY, base64 encoded. Written through unmodified. */
export const terminalInputCommand = z.object({
  type: z.literal('terminal_input'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  data: z.string(),
})

export const terminalResizeCommand = z.object({
  type: z.literal('terminal_resize'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  ...terminalSize,
})

/** Kill the shell and forget it. */
export const terminalCloseCommand = z.object({
  type: z.literal('terminal_close'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
})

export const clientCommand = z.discriminatedUnion('type', [
  subscribeCommand,
  unsubscribeCommand,
  promptCommand,
  permissionResponseCommand,
  interruptCommand,
  setPermissionModeCommand,
  setRemoteControlCommand,
  terminalOpenCommand,
  terminalAttachCommand,
  terminalDetachCommand,
  terminalInputCommand,
  terminalResizeCommand,
  terminalCloseCommand,
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

/** A terminal now exists and is streaming. */
export const terminalOpenedMessage = z.object({
  type: z.literal('terminal_opened'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  title: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})

/**
 * Bytes from the PTY, base64 encoded.
 *
 * Base64 rather than a raw string because this is binary: ANSI escapes, and
 * UTF-8 sequences split across chunk boundaries. Encoding it once here means no
 * hop downstream has to guess.
 */
export const terminalOutputMessage = z.object({
  type: z.literal('terminal_output'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  data: z.string(),
})

/**
 * The shell ended.
 *
 * `exitCode` is absent when the stream died without Docker reporting one, which
 * is what a killed container looks like.
 */
export const terminalExitMessage = z.object({
  type: z.literal('terminal_exit'),
  sessionId: z.string().uuid(),
  terminalId: z.string().min(1),
  exitCode: z.number().int().optional(),
})

/**
 * Every terminal alive in a session.
 *
 * Sent alongside the subscribe handshake. Without it the client must ask
 * separately and the tab flashes empty before filling in.
 */
export const terminalListMessage = z.object({
  type: z.literal('terminal_list'),
  sessionId: z.string().uuid(),
  terminals: z.array(z.object({ terminalId: z.string().min(1), title: z.string() })),
})

export const serverMessage = z.discriminatedUnion('type', [
  eventMessage,
  caughtUpMessage,
  sessionUpdateMessage,
  commandErrorMessage,
  subscriptionClosedMessage,
  terminalOpenedMessage,
  terminalOutputMessage,
  terminalExitMessage,
  terminalListMessage,
])

export type ServerMessage = z.infer<typeof serverMessage>
