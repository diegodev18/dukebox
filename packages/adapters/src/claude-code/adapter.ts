import type { AgentCapabilities, AgentEvent } from '@dukebox/protocol'
import type { Duplex } from 'node:stream'
import { JsonlReader } from '../jsonl.js'
import type { AgentAdapter, SessionContext, UserMessage } from '../types.js'
import { ClaudeCodeMapper } from './mapper.js'

/**
 * Claude Code, driven headless inside a session container.
 *
 * Communicates over the process's stdin and stdout in stream-json mode. The
 * terminal interface is never involved: parsing ANSI output would make
 * collapsible tool calls, reviewable diffs, and resumable state impossible.
 */

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  // Sessions run with --permission-mode bypassPermissions, so the agent acts
  // without asking. The container is the boundary that makes that safe.
  permissions: false,
  thinking: true,
  resume: true,
  mcp: true,
  interrupt: true,
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
    // acceptEdits only covers file edits; Bash would still prompt, and a
    // headless session has nobody to answer. The container's hardening — no
    // privileges, dropped capabilities, no docker socket — is what makes
    // running unattended safe.
    '--permission-mode',
    'bypassPermissions',
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

  agentSessionId(): string | undefined {
    return this.mapper.agentSessionId
  }

  async start(context: SessionContext): Promise<void> {
    if (this.stream) throw new Error('adapter already started')

    this.stream = await context.container.execStream(['claude', ...buildArgs(context)], {
      cwd: context.workingDir,
    })

    this.consume(this.stream)
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
        for (const event of this.mapper.map(message)) this.emit(event)
      }
    })

    stream.on('error', (error: Error) => {
      this.emit({ type: 'error', message: error.message, fatal: true })
      this.finish()
    })

    stream.on('end', () => {
      for (const message of reader.flush()) {
        for (const event of this.mapper.map(message)) this.emit(event)
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

  private emit(event: AgentEvent): void {
    if (this.ended) return

    if (event.type === 'done') this.sawDone = true

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

  async send(message: UserMessage): Promise<void> {
    if (!this.stream) throw new Error('adapter not started')
    this.stream.write(encodeUserMessage(message))
  }

  async respondToPermission(): Promise<void> {
    // Sessions run in bypassPermissions mode, so the agent never asks.
    // Accepting the call rather than throwing means callers need no special
    // case.
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
