import type { AgentCapabilities, AgentEvent } from '@dukebox/protocol'
import type { SessionContainer } from '@dukebox/sandbox'

/**
 * The contract every agent integration implements.
 *
 * This is the seam that keeps the rest of the system agent-agnostic. The
 * control plane and the desktop app only ever see `AgentEvent`s; nothing above
 * this layer knows whether Claude Code, Codex, or anything else produced them.
 *
 * Adding an agent means writing one of these. If a change to the UI is ever
 * needed to support a new agent, the abstraction has failed and the fix
 * belongs in `AgentEvent`, not in a conditional in the UI.
 */

export interface SessionContext {
  sessionId: string
  /** The container the agent process runs inside. */
  container: SessionContainer
  /** Working directory for the agent, normally the cloned repository. */
  workingDir: string
  /** Extra instructions from `.duke/config.yaml`, appended to the prompt. */
  instructions?: string
  /**
   * Model the agent should use for this session.
   *
   * Adapters that accept a model flag (e.g. Claude Code `--model`) pass it
   * through; others ignore it. Absent means the agent's own default.
   */
  model?: string
  /**
   * The agent's own session identifier from a previous run.
   *
   * Present only when resuming, and only meaningful to the adapter that
   * produced it — the control plane stores it without interpreting it.
   */
  resumeFrom?: string
}

export interface UserMessage {
  text: string
  /** Base64 data URIs. Adapters without image support must reject these. */
  images?: string[]
}

export interface AgentAdapter {
  readonly id: string
  readonly capabilities: AgentCapabilities

  /**
   * Start the agent process.
   *
   * Returns once the process is running and its output is being consumed, not
   * once the agent has finished — that arrives as a `done` event.
   */
  start(context: SessionContext): Promise<void>

  /** Send a prompt. Rejects if the agent is not running. */
  send(message: UserMessage): Promise<void>

  /**
   * Answer a `permission_request`.
   *
   * Only meaningful when `capabilities.permissions` is true; other adapters
   * treat it as a no-op rather than failing, so callers need no special case.
   */
  respondToPermission(id: string, allow: boolean): Promise<void>

  /** Interrupt the current turn. No-op when `capabilities.interrupt` is false. */
  interrupt(): Promise<void>

  /**
   * The normalized event stream.
   *
   * Ends when the agent process exits. Consuming it is what drives the
   * session, so a caller must iterate it for anything to happen.
   */
  events(): AsyncIterable<AgentEvent>

  /**
   * The agent's own session id, once known.
   *
   * Stored by the control plane and handed back as `resumeFrom` to continue a
   * conversation instead of starting a new one.
   */
  agentSessionId(): string | undefined

  /** Stop the agent process and end the event stream. */
  stop(): Promise<void>
}

/** Constructs an adapter. Registered per agent id. */
export type AdapterFactory = () => AgentAdapter
