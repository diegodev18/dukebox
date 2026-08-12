import {
  DEFAULT_PERMISSION_MODE,
  EXIT_PLAN_MODE_ACTION,
  type AgentCapabilities,
  type AgentEvent,
  type PermissionMode,
} from '@dukebox/protocol'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { JsonlReader } from '../jsonl.js'
import type { AgentAdapter, SessionContext, UserMessage } from '../types.js'
import { ClaudeCodeMapper } from './mapper.js'
import { toClaudePermissionMode } from './modes.js'

/**
 * Claude Code, driven headless inside a session container.
 *
 * Communicates over the process's stdin and stdout in stream-json mode. The
 * terminal interface is never involved: parsing ANSI output would make
 * collapsible tool calls, reviewable diffs, and resumable state impossible.
 */

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  // Permission prompts reach the desktop via --permission-prompt-tool stdio.
  // bypass still auto-approves ordinary tools; the channel is what makes plan
  // mode and ask-rules answerable.
  permissions: true,
  thinking: true,
  resume: true,
  mcp: true,
  interrupt: true,
  permissionModes: true,
  // control_request subtype remote_control registers the print-mode session
  // with claude.ai so it can be steered from the Claude app or browser.
  remoteControl: true,
}

/** Build the argument vector for a session. */
export function buildArgs(context: SessionContext): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // Without this, stream-json omits the tool calls and results that the
    // whole UI is built around.
    '--verbose',
    '--permission-mode',
    toClaudePermissionMode(context.permissionMode),
    // Lets the session start in plan or auto and still switch to bypass later
    // without restarting the process.
    '--allow-dangerously-skip-permissions',
    // Always on so a mid-session switch into plan can still prompt for
    // ExitPlanMode. In bypass the CLI auto-approves ordinary tools and this
    // channel stays quiet.
    '--permission-prompt-tool',
    'stdio',
  ]

  if (context.model) {
    args.push('--model', context.model)
  }

  if (context.resumeFrom) {
    args.push('--resume', context.resumeFrom)
  }

  if (context.instructions) {
    args.push('--append-system-prompt', context.instructions)
  }

  return args
}

/**
 * Encode a message for the agent's stdin.
 *
 * The input side of stream-json expects the same envelope the Messages API
 * uses, one JSON object per line.
 */
export function encodeUserMessage(message: UserMessage): string {
  const content: unknown[] = [{ type: 'text', text: message.text }]

  for (const image of message.images ?? []) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(image)
    if (!match) continue

    content.push({
      type: 'image',
      source: { type: 'base64', media_type: match[1], data: match[2] },
    })
  }

  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  })}\n`
}

export function encodeSetPermissionMode(mode: PermissionMode, requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'set_permission_mode', mode: toClaudePermissionMode(mode) },
  })}\n`
}

export function encodeSetRemoteControl(enabled: boolean, requestId: string, name?: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'remote_control',
      enabled,
      ...(name ? { name } : {}),
    },
  })}\n`
}

export function encodePermissionResponse(requestId: string, allow: boolean): string {
  return `${JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: allow
        ? { behavior: 'allow', updatedInput: {} }
        : { behavior: 'deny', message: 'User denied permission' },
    },
  })}\n`
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code'
  readonly capabilities = CLAUDE_CODE_CAPABILITIES

  private readonly mapper = new ClaudeCodeMapper()
  private stream: Duplex | undefined
  private queue: AgentEvent[] = []
  private waiting: ((event: IteratorResult<AgentEvent>) => void) | undefined
  private ended = false
  /** Whether the agent reported the turn's end itself. */
  private sawDone = false
  private requestedMode: PermissionMode = DEFAULT_PERMISSION_MODE
  private pendingPermissions = new Map<string, string>()
  /** request_id of an in-flight remote_control control_request, if any. */
  private pendingRemoteControlId: string | undefined
  private requestedRemoteControl = false

  agentSessionId(): string | undefined {
    return this.mapper.agentSessionId
  }

  async start(context: SessionContext): Promise<void> {
    if (this.stream) throw new Error('adapter already started')

    this.requestedMode = context.permissionMode ?? DEFAULT_PERMISSION_MODE

    this.stream = await context.container.execStream(['claude', ...buildArgs(context)], {
      cwd: context.workingDir,
    })

    this.emit({ type: 'permission_mode', mode: this.requestedMode })
    this.consume(this.stream)

    if (context.remoteControl) {
      await this.setRemoteControl(true, context.remoteControlName)
    }
  }

  /**
   * Read the agent's output for the life of the process.
   *
   * Deliberately not awaited: this runs until the process exits, and `start`
   * has to return as soon as the agent is running.
   */
  private consume(stream: Duplex): void {
    const reader = new JsonlReader({
      onMalformed: (line) => {
        this.emit({
          type: 'error',
          message: `unparseable output from agent: ${line.slice(0, 200)}`,
          fatal: false,
        })
      },
    })

    stream.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk.toString())) {
        this.handleControlResponse(message)
        this.dispatchMapped(this.mapper.map(message))
      }
    })

    stream.on('error', (error: Error) => {
      this.emit({ type: 'error', message: error.message, fatal: true })
      this.finish()
    })

    stream.on('end', () => {
      for (const message of reader.flush()) {
        this.handleControlResponse(message)
        this.dispatchMapped(this.mapper.map(message))
      }

      // A stream that ends without a result message means the process died.
      // Synthesize the turn's end so the consumer is not left waiting for one
      // that will never arrive — but only if the agent did not already send
      // it, or the UI would close the same turn twice.
      if (!this.sawDone) {
        this.emit({ type: 'done', reason: 'error' })
      }

      this.finish()
    })
  }

  private dispatchMapped(events: AgentEvent[]): void {
    for (const event of events) {
      if (event.type === 'permission_request') {
        this.pendingPermissions.set(event.id, event.action)
      }

      if (
        event.type === 'permission_mode' &&
        this.requestedMode === 'auto' &&
        event.mode !== 'auto'
      ) {
        this.emit({
          type: 'error',
          message: 'Claude Code could not enable auto mode for this model.',
          fatal: false,
        })
      }

      this.emit(event)
    }
  }

  private emit(event: AgentEvent): void {
    if (this.ended) return

    if (event.type === 'done') this.sawDone = true
    if (event.type === 'permission_mode') this.requestedMode = event.mode

    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting({ value: event, done: false })
      return
    }

    this.queue.push(event)
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true

    const waiting = this.waiting
    if (waiting) {
      this.waiting = undefined
      waiting({ value: undefined, done: true })
    }
  }

  private write(line: string): void {
    if (!this.stream) throw new Error('adapter not started')
    this.stream.write(line)
  }

  async send(message: UserMessage): Promise<void> {
    this.write(encodeUserMessage(message))
  }

  async respondToPermission(id: string, allow: boolean): Promise<void> {
    if (!this.stream) return

    const action = this.pendingPermissions.get(id)
    this.pendingPermissions.delete(id)
    this.write(encodePermissionResponse(id, allow))

    if (allow && action === EXIT_PLAN_MODE_ACTION) {
      await this.setPermissionMode('auto')
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.stream) return

    this.requestedMode = mode
    this.write(encodeSetPermissionMode(mode, randomUUID()))
    this.emit({ type: 'permission_mode', mode })
  }

  async setRemoteControl(enabled: boolean, name?: string): Promise<void> {
    if (!this.stream) return

    this.requestedRemoteControl = enabled
    const requestId = randomUUID()
    this.pendingRemoteControlId = requestId
    this.write(encodeSetRemoteControl(enabled, requestId, name))
    this.emit({ type: 'remote_control', enabled })
  }

  /**
   * Match a control_response to an in-flight remote_control request.
   *
   * The URL lives on the success payload; a disable reply is empty. Errors
   * are reported both as remote_control chrome and as a transcript error so
   * the failure is readable, not just a button that did nothing.
   */
  private handleControlResponse(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return

    const message = raw as Record<string, unknown>
    if (message.type !== 'control_response') return

    const wrapped = message.response
    if (!wrapped || typeof wrapped !== 'object') return

    const response = wrapped as Record<string, unknown>
    if (response.request_id !== this.pendingRemoteControlId) {
      // A session_url on an unsolicited success is still the link we want:
      // Claude Code may announce Remote Control on its own after --resume.
      const unsolicited = sessionUrlFrom(response)
      if (unsolicited) this.emit({ type: 'remote_control', enabled: true, url: unsolicited })
      return
    }

    this.pendingRemoteControlId = undefined

    if (response.subtype === 'error') {
      const error =
        typeof response.error === 'string' && response.error.length > 0
          ? response.error
          : 'Remote Control failed'
      this.requestedRemoteControl = false
      this.emit({ type: 'remote_control', enabled: false, error })
      this.emit({ type: 'error', message: error, fatal: false })
      return
    }

    const url = sessionUrlFrom(response)
    this.emit({
      type: 'remote_control',
      enabled: this.requestedRemoteControl,
      ...(url ? { url } : {}),
    })
  }

  async interrupt(): Promise<void> {
    if (!this.stream) return
    this.stream.write(`${JSON.stringify({ type: 'control_request', request: 'interrupt' })}\n`)
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      const queued = this.queue.shift()
      if (queued) {
        yield queued
        continue
      }

      if (this.ended) return

      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.waiting = resolve
      })

      if (next.done) return
      yield next.value
    }
  }

  async stop(): Promise<void> {
    this.stream?.end()
    this.finish()
  }
}

/** Pull a session_url out of a control_response payload, however nested. */
function sessionUrlFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  if (typeof record.session_url === 'string' && record.session_url.length > 0) {
    return record.session_url
  }

  if (record.response && typeof record.response === 'object') {
    return sessionUrlFrom(record.response)
  }

  return undefined
}
