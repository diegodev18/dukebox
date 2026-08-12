import type { AgentCapabilities, AgentEvent, PermissionMode } from '@dukebox/protocol'
import type { Duplex } from 'node:stream'
import { JsonlReader } from '../jsonl.js'
import type { AgentAdapter, SessionContext, UserMessage } from '../types.js'
import { OpenCodeMapper } from './mapper.js'

/**
 * OpenCode, driven headless inside a session container.
 *
 * Each turn is a separate `opencode run --format json` process: the CLI exits
 * when the agent goes idle. The event iterator stays open across turns so a
 * follow-up `send` can start another run against the same OpenCode session.
 * Stdin is not attached: `run` reads it to EOF before sending the prompt, so
 * an open hijacked stream hangs the turn with no events.
 */

export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  // Sessions run with --auto, so the agent acts without asking. The container
  // is the boundary that makes that safe.
  permissions: false,
  thinking: true,
  resume: true,
  mcp: true,
  interrupt: true,
  permissionModes: false,
  remoteControl: false,
}

export const OPENCODE_INSTRUCTIONS_PATH = '/tmp/dukebox-instructions.md'
export const OPENCODE_AUTH_PATH = '/home/node/.local/share/opencode/auth.json'

/** Build the argument vector for one `opencode run`. */
export function buildRunArgs(options: {
  text: string
  model?: string
  sessionId?: string
  files?: string[]
}): string[] {
  const args = ['run', '--format', 'json', '--auto']

  if (options.model) {
    args.push('--model', options.model)
  }

  if (options.sessionId) {
    args.push('--session', options.sessionId)
  }

  for (const file of options.files ?? []) {
    args.push('--file', file)
  }

  args.push(options.text)
  return args
}

/**
 * Write OpenCode's auth file and project instructions into the container.
 *
 * Credentials arrive as container env (`DUKEBOX_OPENCODE_AUTH_JSON`, plus the
 * native provider keys). Instructions are passed on this exec so they never
 * have to be shell-quoted.
 */
export async function materializeOpencodeHome(context: SessionContext): Promise<void> {
  await context.container.exec([
    'sh',
    '-c',
    [
      'mkdir -p /home/node/.local/share/opencode',
      `if [ -n "$DUKEBOX_OPENCODE_AUTH_JSON" ]; then printf '%s' "$DUKEBOX_OPENCODE_AUTH_JSON" > ${OPENCODE_AUTH_PATH}; fi`,
    ].join('\n'),
  ])

  if (!context.instructions) return

  await context.container.exec(
    ['sh', '-c', `printf '%s' "$DUKEBOX_OPENCODE_INSTRUCTIONS" > ${OPENCODE_INSTRUCTIONS_PATH}`],
    { env: { DUKEBOX_OPENCODE_INSTRUCTIONS: context.instructions } },
  )
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode'
  readonly capabilities = OPENCODE_CAPABILITIES

  private readonly mapper = new OpenCodeMapper()
  private context: SessionContext | undefined
  private stream: Duplex | undefined
  private queue: AgentEvent[] = []
  private waiting: ((event: IteratorResult<AgentEvent>) => void) | undefined
  private ended = false
  /** Whether the current run reported the turn's end itself. */
  private sawDone = false
  private turn = 0
  private interrupted = false

  agentSessionId(): string | undefined {
    return this.mapper.agentSessionId
  }

  async start(context: SessionContext): Promise<void> {
    if (this.context) throw new Error('adapter already started')

    this.context = context
    this.mapper.rememberSession(context.resumeFrom, context.model)

    await materializeOpencodeHome(context)
  }

  /**
   * Read one `opencode run` until it exits.
   *
   * Deliberately not awaited: `send` has to return as soon as the process is
   * running. The adapter's event iterator stays open after the process ends
   * so a follow-up turn can reuse it.
   */
  private consumeTurn(stream: Duplex, turnId: number): void {
    const reader = new JsonlReader({
      onMalformed: (line) => {
        if (this.turn !== turnId) return
        this.emit({
          type: 'error',
          message: `unparseable output from agent: ${line.slice(0, 200)}`,
          fatal: false,
        })
      },
    })

    stream.on('data', (chunk: Buffer) => {
      if (this.turn !== turnId) return
      for (const message of reader.push(chunk.toString())) {
        for (const event of this.mapper.map(message)) this.emit(event)
      }
    })

    let settled = false

    stream.on('error', (error: Error) => {
      if (this.turn !== turnId || settled) return
      // Interrupt destroys the stream; `close` finishes the turn so leftover
      // output is flushed before `done`.
      if (this.interrupted) return

      settled = true
      this.emit({ type: 'error', message: error.message, fatal: true })
      this.finishTurn('error')
    })

    const onClosed = () => {
      if (this.turn !== turnId || settled) return
      settled = true

      for (const message of reader.flush()) {
        for (const event of this.mapper.map(message)) this.emit(event)
      }

      if (this.interrupted) {
        this.finishTurn('interrupted')
        return
      }

      // A stream that ends without a synthesized done means the process died
      // or finished cleanly — either way the turn is over. The mapper never
      // emits `done`; that belongs to process lifetime, not to step_finish.
      this.finishTurn(this.sawDone ? undefined : 'completed')
    }

    // `destroy()` (interrupt) emits `close` and sometimes `error`, but not
    // always `end`. Either one is enough to close the turn.
    stream.on('end', onClosed)
    stream.on('close', onClosed)
  }

  private finishTurn(reason: 'completed' | 'interrupted' | 'error' | undefined): void {
    if (this.stream) {
      this.stream = undefined
    }

    if (reason && !this.sawDone) {
      this.emit({ type: 'done', reason })
    }
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
    if (!this.context) throw new Error('adapter not started')
    if (this.ended) throw new Error('adapter stopped')

    if (this.stream) {
      this.turn += 1
      this.stream.destroy()
      this.stream = undefined
    }

    this.turn += 1
    const turnId = this.turn
    this.sawDone = false
    this.interrupted = false

    const files = await this.stageImages(message)
    const sessionId = this.mapper.agentSessionId || this.context.resumeFrom
    const args = buildRunArgs({
      text: message.text,
      ...(this.context.model ? { model: this.context.model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(files.length > 0 ? { files } : {}),
    })

    this.stream = await this.context.container.execStream(['opencode', ...args], {
      cwd: this.context.workingDir,
      // `opencode run` reads stdin to EOF before it sends the prompt
      // (`Bun.stdin.text()` whenever stdin is not a TTY). Leaving the
      // hijacked stream open — which Claude Code needs — hangs the turn
      // forever with the session stuck on "Running" and no events.
      stdin: false,
    })

    this.consumeTurn(this.stream, turnId)
  }

  /**
   * Write attached images into the container so `--file` can point at them.
   *
   * OpenCode takes filesystem paths, not data URIs. A URI that is not a
   * data URI is skipped rather than passed through as a path that will 404.
   */
  private async stageImages(message: UserMessage): Promise<string[]> {
    if (!this.context) return []

    const files: string[] = []

    for (const [index, image] of (message.images ?? []).entries()) {
      const match = /^data:([^;]+);base64,(.+)$/.exec(image)
      if (!match) continue

      const path = `/tmp/dukebox-image-${index}`
      const data = match[2]
      if (!data) continue
      await this.context.container.exec(
        ['sh', '-c', `printf '%s' "$DUKEBOX_IMAGE" | base64 -d > ${path}`],
        { env: { DUKEBOX_IMAGE: data } },
      )
      files.push(path)
    }

    return files
  }

  async respondToPermission(): Promise<void> {
    // Sessions run with --auto, so the agent never asks.
  }

  async interrupt(): Promise<void> {
    if (!this.stream) return
    this.interrupted = true
    this.stream.destroy()
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // OpenCode has no permission modes. Accepting the call rather than
    // throwing means callers need no special case.
  }

  async setRemoteControl(_enabled: boolean, _name?: string): Promise<void> {
    // OpenCode has no Remote Control. Same no-op contract as permission modes.
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
    this.turn += 1
    this.stream?.destroy()
    this.stream = undefined
    this.finish()
  }
}
