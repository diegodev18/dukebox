import Docker from 'dockerode'
import { Duplex, PassThrough } from 'node:stream'

/**
 * Container lifecycle for agent sessions.
 *
 * Every session gets its own container. The threat model is that the agent
 * inside is hostile: it runs autonomously, executes model-generated commands,
 * and has network access. The hardening here is what stands between a bad
 * command and the host.
 */

/** Label marking containers this system owns, so cleanup can find them. */
export const MANAGED_LABEL = 'dev.dukebox.managed'
export const SESSION_LABEL = 'dev.dukebox.session-id'

export interface ResourceLimits {
  /** CPU cores, e.g. '2' or '0.5'. */
  cpus: string
  /** Memory, e.g. '4g'. */
  memory: string
  /**
   * Maximum process count. A fork bomb in a container without this takes down
   * the whole host, not just the session.
   */
  pids: number
}

export const DEFAULT_LIMITS: ResourceLimits = {
  cpus: '2',
  memory: '4g',
  pids: 512,
}

export interface CreateContainerOptions {
  sessionId: string
  image: string
  limits?: ResourceLimits
  /**
   * Environment for the agent process.
   *
   * Secrets are passed here and are visible to anything inside the container.
   * The GitHub token deliberately never appears: git authenticates through a
   * credential proxy on the host instead, so a compromised agent cannot read a
   * token that would grant access to every repository the user owns.
   */
  env?: Record<string, string>
  /** Docker network to join. Defaults to none, isolating the container. */
  network?: string
  /**
   * Host paths to expose inside the container.
   *
   * Used for the credential proxy socket, which is how git authenticates
   * without the token ever entering the container. Nothing here may be a path
   * that grants control of the host — the Docker socket above all.
   */
  mounts?: { source: string; target: string; readOnly?: boolean }[]
}

/** Parse a memory string like '4g' or '512m' into bytes. */
export function parseMemory(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(value.trim())
  if (!match) {
    throw new Error(`invalid memory value: ${value}`)
  }

  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1

  return Math.floor(amount * multiplier)
}

/**
 * Convert a CPU count into Docker's quota model.
 *
 * Docker expresses CPU limits as a quota over a period rather than a core
 * count. 100000 is the conventional period, so a quota of 200000 is two cores.
 */
export function cpuQuota(cpus: string): { period: number; quota: number } {
  const value = Number(cpus)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid cpu value: ${cpus}`)
  }

  const period = 100_000
  return { period, quota: Math.floor(value * period) }
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** An interactive shell inside a container. */
export interface TerminalHandle {
  /**
   * Terminal bytes in both directions.
   *
   * A TTY exec merges stdout and stderr in the PTY, which is what a terminal
   * wants: a compiler's warnings belong interleaved with its output, on the
   * same screen, in the order they happened. `execStream` keeps them apart
   * instead, because there stderr would corrupt a JSONL event stream.
   */
  stream: Duplex
  resize: (cols: number, rows: number) => Promise<void>
  close: () => Promise<void>
}

/** A running session container. */
export class SessionContainer {
  constructor(
    private readonly docker: Docker,
    readonly id: string,
    readonly sessionId: string,
  ) {}

  private get container() {
    return this.docker.getContainer(this.id)
  }

  /**
   * Run a command to completion and collect its output.
   *
   * For long-running processes that need to be streamed — an agent's own
   * process — use `execStream` instead.
   */
  async exec(
    command: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<ExecResult> {
    const exec = await this.container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      ...(options.cwd ? { WorkingDir: options.cwd } : {}),
      ...(options.env ? { Env: toEnvArray(options.env) } : {}),
    })

    const stream = await exec.start({ hijack: true, stdin: false })
    const { stdout, stderr } = await collectMultiplexed(this.docker, stream)

    // The exit code is only populated once the process has exited, which is
    // why this is inspected after the stream has ended rather than before.
    const info = await exec.inspect()

    return { exitCode: info.ExitCode ?? -1, stdout, stderr }
  }

  /**
   * Start a long-lived command and talk to it over stdin and stdout.
   *
   * Used for the agent process, which runs for the whole session.
   *
   * The returned stream carries stdout only, already demultiplexed. Docker
   * frames a TTY-less exec with an 8-byte header per chunk, and those bytes
   * arrive interleaved with the payload: a JSONL reader handed the raw stream
   * sees binary before every `{` and rejects every line the agent emits.
   *
   * Pass `stdin: false` when the process must not see an open stdin. OpenCode's
   * `run` reads stdin to EOF before it starts (`Bun.stdin.text()` whenever
   * stdin is not a TTY); a hijacked stream that never closes hangs the agent
   * forever with no events.
   */
  async execStream(
    command: string[],
    options: { cwd?: string; env?: Record<string, string>; stdin?: boolean } = {},
  ): Promise<Duplex> {
    const attachStdin = options.stdin !== false

    const exec = await this.container.exec({
      Cmd: command,
      AttachStdin: attachStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      ...(options.cwd ? { WorkingDir: options.cwd } : {}),
      ...(options.env ? { Env: toEnvArray(options.env) } : {}),
    })

    const raw = await exec.start({ hijack: true, stdin: attachStdin })

    // Writes go straight to the process; reads come back demultiplexed. A
    // Duplex is what the caller wants — one object it writes prompts to and
    // reads events from — but the two directions need different handling.
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    this.docker.modem.demuxStream(raw, stdout, stderr)

    // stderr is drained rather than dropped: an unread stream applies
    // backpressure that eventually stalls the process writing to it.
    stderr.resume()

    raw.on('end', () => stdout.end())
    raw.on('error', (error: Error) => stdout.emit('error', error))

    return Duplex.from({ readable: stdout, writable: raw })
  }

  /**
   * Start an interactive login shell with a PTY.
   *
   * A login shell rather than a bare one so the profile runs and the toolchain
   * on PATH matches what the agent sees. The caller owns the returned stream
   * and must close it: an abandoned exec keeps a process alive in the container
   * against its PID limit.
   */
  async openTerminal(
    options: { cols: number; rows: number; cwd?: string } = { cols: 80, rows: 24 },
  ): Promise<TerminalHandle> {
    const size = clampTerminalSize(options.cols, options.rows)

    const exec = await this.container.exec({
      Cmd: ['/bin/bash', '-l'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ConsoleSize: [size.rows, size.cols],
      ...(options.cwd ? { WorkingDir: options.cwd } : {}),
    })

    // Tty must be set here as well as on create. Docker takes the start flag
    // for the stream format and for putting the process in the foreground of
    // the PTY. Create-only Tty allocates a PTY but start-without-Tty attaches
    // it as a multiplexed non-TTY stream: bash builtins still work, and a
    // forked command like `ls` is stopped with SIGTTOU the moment it writes.
    const raw = await exec.start({ hijack: true, stdin: true, Tty: true })

    // A TTY exec is a raw PTY stream — stdout and stderr are already merged,
    // and there are no 8-byte multiplex headers. Demuxing that stream treats
    // the first bytes of the prompt as a frame header with a huge payload and
    // waits forever, which looks like the command hung.
    //
    // Written by hand rather than with `Duplex.from`, which wires the two sides
    // into a pipeline that treats a destroyed socket as a broken pipe. Closing
    // a terminal destroys the socket by design, and the pipeline would report
    // every one of those as ERR_STREAM_PREMATURE_CLOSE.
    const stream = new Duplex({
      read() {
        raw.resume()
      },
      write(chunk, encoding, callback) {
        if (!raw.write(chunk, encoding)) {
          raw.once('drain', callback)
          return
        }
        callback()
      },
      destroy(error, callback) {
        raw.destroy()
        callback(error)
      },
    })

    raw.on('data', (chunk: Buffer) => {
      if (!stream.push(chunk)) raw.pause()
    })
    raw.on('end', () => stream.push(null))
    raw.on('error', (error: Error) => stream.destroy(error))

    return {
      stream,
      // Docker takes rows before columns, and getting them backwards produces a
      // terminal that looks right until something wraps. A 0×0 size is what
      // GNU ls infinite-loops on when it lays out columns.
      resize: async (cols, rows) => {
        const next = clampTerminalSize(cols, rows)
        await exec.resize({ h: next.rows, w: next.cols })
      },
      // Destroying the socket is what ends the shell. Left open, the process
      // lives on inside the container against its PID limit.
      close: async () => {
        stream.destroy()
      },
    }
  }

  /** Stop the container but keep it, so a follow-up can resume in place. */
  async stop(timeoutSeconds = 10): Promise<void> {
    try {
      await this.container.stop({ t: timeoutSeconds })
    } catch (error) {
      // 304 means it had already stopped, which is the desired end state.
      if (!isStatusCode(error, 304)) throw error
    }
  }

  async start(): Promise<void> {
    try {
      await this.container.start()
    } catch (error) {
      if (!isStatusCode(error, 304)) throw error
    }
  }

  /** Stop and delete the container along with its anonymous volumes. */
  async remove(): Promise<void> {
    try {
      await this.container.remove({ force: true, v: true })
    } catch (error) {
      // 404 means someone else already removed it.
      if (!isStatusCode(error, 404)) throw error
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const info = await this.container.inspect()
      return info.State.Running === true
    } catch (error) {
      if (isStatusCode(error, 404)) return false
      throw error
    }
  }

  /** Full Docker state, used by tests and diagnostics. */
  async inspect() {
    return this.container.inspect()
  }
}

export class Sandbox {
  constructor(private readonly docker: Docker = new Docker()) {}

  /** Verify the Docker daemon is reachable before anything depends on it. */
  async ping(): Promise<void> {
    await this.docker.ping()
  }

  async create(options: CreateContainerOptions): Promise<SessionContainer> {
    const limits = options.limits ?? DEFAULT_LIMITS
    const { period, quota } = cpuQuota(limits.cpus)
    const binds = (options.mounts ?? []).map(toBind)

    const container = await this.docker.createContainer({
      name: `dukebox-session-${options.sessionId}`,
      Image: options.image,
      Labels: {
        [MANAGED_LABEL]: 'true',
        [SESSION_LABEL]: options.sessionId,
      },
      ...(options.env ? { Env: toEnvArray(options.env) } : {}),
      WorkingDir: '/workspace',
      HostConfig: {
        // Resource caps. Without these one session can starve the host and
        // every other session on it.
        Memory: parseMemory(limits.memory),
        CpuPeriod: period,
        CpuQuota: quota,
        PidsLimit: limits.pids,

        // Block privilege escalation via setuid binaries, so a process inside
        // cannot gain rights the container was not given.
        SecurityOpt: ['no-new-privileges'],

        // Drop every Linux capability. An agent building software needs none
        // of them, and each one left in place is a way out of the container.
        CapDrop: ['ALL'],

        // Never privileged: that flag is equivalent to root on the host.
        Privileged: false,

        // No default network unless one is named. The control plane attaches a
        // dedicated bridge that cannot reach the tailnet, so a compromised
        // agent cannot reach the user's other machines.
        NetworkMode: options.network ?? 'none',

        // Containers are stopped and removed explicitly by the session
        // lifecycle; restarting one behind our back would resurrect a session
        // the control plane believes is finished.
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },

        ...(binds.length > 0 ? { Binds: binds } : {}),
      },
    })

    await container.start()

    return new SessionContainer(this.docker, container.id, options.sessionId)
  }

  /** Look up an existing session container. Returns null if it is gone. */
  async get(sessionId: string): Promise<SessionContainer | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${SESSION_LABEL}=${sessionId}`] },
    })

    const found = containers[0]
    return found ? new SessionContainer(this.docker, found.Id, sessionId) : null
  }

  /** Every container this system owns, running or not. */
  async list(): Promise<SessionContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_LABEL}=true`] },
    })

    return containers.map(
      (info) => new SessionContainer(this.docker, info.Id, info.Labels[SESSION_LABEL] ?? 'unknown'),
    )
  }

  /**
   * Remove every managed container.
   *
   * Used on shutdown and by tests. Only touches containers carrying our label,
   * so unrelated containers on the same host are never affected.
   */
  async removeAll(): Promise<number> {
    const containers = await this.list()
    await Promise.all(containers.map((container) => container.remove()))
    return containers.length
  }
}

function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`)
}

/**
 * A PTY of 0 columns makes GNU `ls` hang in its columnar layout, and a
 * FitAddon measuring a hidden panel reports exactly that. Flooring rejects
 * the fractional sizes a layout pass can produce; the minima match xterm.js.
 */
export function clampTerminalSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80,
    rows: Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24,
  }
}

/**
 * Host paths that must never be exposed to a session container.
 *
 * The Docker socket is the one that matters: a container holding it can start
 * a privileged container and own the host, which defeats every other control
 * here. The rest are the usual routes to the same outcome.
 */
const FORBIDDEN_MOUNT_PATTERNS = [/docker\.sock$/, /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/$/]

/** Convert a mount to a Docker bind string, refusing dangerous sources. */
export function toBind(mount: { source: string; target: string; readOnly?: boolean }): string {
  for (const pattern of FORBIDDEN_MOUNT_PATTERNS) {
    if (pattern.test(mount.source)) {
      throw new Error(`refusing to mount ${mount.source} into a session container`)
    }
  }

  return `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`
}

function isStatusCode(error: unknown, code: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: number }).statusCode === code
  )
}

/**
 * Demultiplex Docker's exec stream into stdout and stderr.
 *
 * Without a TTY, Docker interleaves both channels in one stream framed by an
 * 8-byte header per chunk. Reading it raw would splice stderr into the middle
 * of stdout.
 */
async function collectMultiplexed(
  docker: Docker,
  stream: NodeJS.ReadableStream,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  const stdout = new PassThrough()
  const stderr = new PassThrough()

  stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
  stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

  docker.modem.demuxStream(stream, stdout, stderr)

  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve)
    stream.on('error', reject)
  })

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  }
}
