import {
  DEFAULT_PERMISSION_MODE,
  type AgentCapabilities,
  type AgentEvent,
  type PermissionMode,
} from '@dukebox/protocol'
import type { Duplex } from 'node:stream'
import { JsonlReader } from '@/jsonl'
import type { AgentAdapter, SessionContext, UserMessage } from '@/types'
import { extensionFor, parseDataUri, stageUpload } from '@/uploads'
import { mergeGrokAuthJson } from '@/grok-build/auth'
import { GrokBuildMapper } from '@/grok-build/mapper'

/**
 * Grok Build, driven headless inside a session container.
 *
 * Each turn is a separate `grok -p --output-format streaming-json` process:
 * the CLI exits when the agent goes idle. The event iterator stays open
 * across turns so a follow-up `send` can start another run against the same
 * Grok session. Stdin is not attached: the prompt is a flag, and an open
 * hijacked stream is unused.
 */

export const GROK_HOME_DIR = '/home/node/.grok'
export const GROK_AUTH_PATH = `${GROK_HOME_DIR}/auth.json`
export const GROK_AUTH_ENV = 'DUKEBOX_GROK_AUTH_JSON'

/**
 * Environment Grok Build needs inside a session container.
 *
 * `grok` resolves its config dir from `$GROK_HOME` or `$HOME/.grok`. Docker
 * exec is not a login shell and the node image does not set `HOME`, so
 * without these the CLI prints "Not signed in" even when auth.json was
 * written to `/home/node/.grok`.
 */
export function grokBuildContainerEnv(options: {
  apiKey?: string | null
  authJson?: string | null
}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/home/node',
    GROK_HOME: GROK_HOME_DIR,
    GROK_DISABLE_AUTOUPDATER: '1',
  }

  if (options.apiKey) env.XAI_API_KEY = options.apiKey
  if (options.authJson) env[GROK_AUTH_ENV] = options.authJson

  return env
}

const WRITE_AUTH_SCRIPT = [
  `home="\${GROK_HOME:-${GROK_HOME_DIR}}"`,
  'mkdir -p "$home"',
  'cat > "$home/auth.json"',
  'chmod 600 "$home/auth.json"',
].join('\n')

const READ_AUTH_SCRIPT = [
  `home="\${GROK_HOME:-${GROK_HOME_DIR}}"`,
  'if [ -f "$home/auth.json" ]; then cat "$home/auth.json"; fi',
].join('\n')

const ENV_MATERIALIZE_SCRIPT = [
  `home="\${GROK_HOME:-${GROK_HOME_DIR}}"`,
  'mkdir -p "$home"',
  `if [ -n "$${GROK_AUTH_ENV}" ]; then printf '%s' "$${GROK_AUTH_ENV}" > "$home/auth.json"; chmod 600 "$home/auth.json"; fi`,
].join('\n')

export async function readGrokAuthFile(context: SessionContext): Promise<string | null> {
  const result = await context.container.exec(['sh', '-c', READ_AUTH_SCRIPT])
  const raw = result.stdout.trim()
  return raw || null
}

export async function writeGrokAuthFile(context: SessionContext, authJson: string): Promise<void> {
  await context.container.exec(['sh', '-c', WRITE_AUTH_SCRIPT], { stdin: authJson })
}

/**
 * Write the subscription session into the container.
 *
 * SuperGrok / X Premium Plus credentials live in `~/.grok/auth.json`, not in
 * `XAI_API_KEY`. When the control plane supplies `grokAuth`, the latest
 * snapshot (possibly just refreshed) is written via stdin so a resume cannot
 * overwrite a live token with the env frozen at container create. The env
 * fallback remains for tests and older callers.
 */
export async function materializeGrokHome(context: SessionContext): Promise<void> {
  if (!context.grokAuth) {
    await context.container.exec(['sh', '-c', ENV_MATERIALIZE_SCRIPT])
    return
  }

  const fromStore = await context.grokAuth.load()
  const fromDisk = await readGrokAuthFile(context)
  const merged = mergeGrokAuthJson(fromStore, fromDisk)
  if (!merged) return

  if (merged !== fromDisk) await writeGrokAuthFile(context, merged)
  if (merged !== fromStore) await context.grokAuth.persist(merged)
}

export const GROK_BUILD_CAPABILITIES: AgentCapabilities = {
  // Sessions run with --yolo (or plan), so the agent acts without asking.
  // The container is the boundary that makes that safe.
  permissions: false,
  thinking: true,
  resume: true,
  mcp: true,
  interrupt: true,
  // Plan maps onto `--permission-mode plan`. The other modes keep --yolo:
  // headless cannot answer an interactive permission prompt.
  permissionModes: true,
}

/** Build the argument vector for one `grok -p`. */
export function buildGrokRunArgs(options: {
  text: string
  model?: string
  sessionId?: string
  permissionMode?: PermissionMode
  instructions?: string
}): string[] {
  const args = ['-p', options.text, '--output-format', 'streaming-json', '--no-auto-update']

  if (options.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  } else {
    args.push('--yolo', '--no-plan')
  }

  if (options.model) {
    args.push('-m', options.model)
  }

  if (options.sessionId) {
    args.push('--resume', options.sessionId)
  }

  if (options.instructions) {
    args.push('--rules', options.instructions)
  }

  return args
}

export class GrokBuildAdapter implements AgentAdapter {
  readonly id = 'grok-build'
  readonly capabilities = GROK_BUILD_CAPABILITIES

  private readonly mapper = new GrokBuildMapper()
  private context: SessionContext | undefined
  private stream: Duplex | undefined
  private queue: AgentEvent[] = []
  private waiting: ((event: IteratorResult<AgentEvent>) => void) | undefined
  private ended = false
  /** Whether the current run reported the turn's end itself. */
  private sawDone = false
  private turn = 0
  private interrupted = false
  /** The mode the next `send` runs under. */
  private mode: PermissionMode = DEFAULT_PERMISSION_MODE

  agentSessionId(): string | undefined {
    return this.mapper.agentSessionId
  }

  async start(context: SessionContext): Promise<void> {
    if (this.context) throw new Error('adapter already started')

    this.context = context
    this.mapper.rememberSession(context.resumeFrom, context.model)
    this.mode = context.permissionMode ?? DEFAULT_PERMISSION_MODE

    try {
      await materializeGrokHome(context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', message, fatal: true })
    }
    this.emit({ type: 'permission_mode', mode: this.mode })
  }

  /**
   * Read one `grok -p` until it exits.
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

      void this.afterTurn(turnId).finally(() => {
        if (this.turn !== turnId) return
        if (this.interrupted) {
          this.finishTurn('interrupted')
          return
        }

        this.finishTurn(this.sawDone ? undefined : 'completed')
      })
    }

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

  private async afterTurn(turnId: number): Promise<void> {
    if (this.turn !== turnId || !this.context?.grokAuth) return
    try {
      await materializeGrokHome(this.context)
    } catch {
      // A failed harvest must not hide the turn that just finished.
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

    try {
      await materializeGrokHome(this.context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'error', message, fatal: true })
      this.finishTurn('error')
      return
    }

    const files = await this.stageUploads(message)
    const text = appendAttachments(message.text, files)
    const sessionId = this.mapper.agentSessionId || this.context.resumeFrom
    const args = buildGrokRunArgs({
      text,
      ...(this.context.model ? { model: this.context.model } : {}),
      ...(sessionId ? { sessionId } : {}),
      permissionMode: this.mode,
      ...(this.context.instructions ? { instructions: this.context.instructions } : {}),
    })

    this.stream = await this.context.container.execStream(['grok', ...args], {
      cwd: this.context.workingDir,
      stdin: false,
    })

    this.consumeTurn(this.stream, turnId)
  }

  /**
   * Write attached images and files into the sandbox so the prompt can
   * point at them. Grok has no `--file` flag; the path is referenced in text.
   */
  private async stageUploads(message: UserMessage): Promise<string[]> {
    if (!this.context) return []

    const files: string[] = []

    for (const [index, image] of (message.images ?? []).entries()) {
      const path = await this.stageDataUri(image, `image-${index}`, true)
      if (path) files.push(path)
    }

    for (const file of message.files ?? []) {
      const path = await this.stageDataUri(file.data, file.name, false)
      if (path) files.push(path)
    }

    return files
  }

  private async stageDataUri(
    data: string,
    name: string,
    image: boolean,
  ): Promise<string | undefined> {
    if (!this.context) return undefined

    const parsed = parseDataUri(data)
    if (!parsed) return undefined

    const extension = image ? extensionFor(parsed.mime) : undefined
    return stageUpload(this.context.container, name, parsed.payload, {
      ...(extension ? { extension } : {}),
    })
  }

  async respondToPermission(): Promise<void> {
    // Sessions run with --yolo or plan, so the agent never asks.
  }

  async interrupt(): Promise<void> {
    if (!this.stream) return
    this.interrupted = true
    this.stream.destroy()
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode
    this.emit({ type: 'permission_mode', mode })
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

function appendAttachments(text: string, files: string[]): string {
  if (files.length === 0) return text
  const refs = files.map((path) => `[Attached file: ${path}]`).join('\n')
  return `${text}\n\n${refs}`
}
