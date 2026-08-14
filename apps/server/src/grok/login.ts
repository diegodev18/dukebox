import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GROK_LOGIN_TTL_MS, type GrokLoginSnapshot, type GrokLoginStatus } from '@dukebox/protocol'
import { GROK_AUTH_SECRET, type SecretStore } from '@/secrets/store'
import { ensureGrokBinary } from '@/grok/binary'
import { parseDeviceAuthOutput } from '@/grok/parse'

export interface LoginProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  kill(): void
}

export interface GrokDeviceLoginOptions {
  secrets: SecretStore
  ensureBinary?: () => Promise<string>
  spawnLogin?: (binary: string, home: string) => LoginProcess
  readAuthFile?: (home: string) => Promise<string>
  now?: () => number
  ttlMs?: number
}

/**
 * One in-flight `grok login --device-auth` for the owner Settings wizard.
 *
 * The process is bound to this control-plane process: a restart drops it.
 * Only one login runs at a time; a second start returns the live snapshot.
 */
export class GrokDeviceLogin {
  private status: GrokLoginStatus = 'idle'
  private url: string | undefined
  private userCode: string | undefined
  private expiresAt: number | undefined
  private error: string | undefined
  private log = ''
  private home: string | undefined
  private child: LoginProcess | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private cancelled = false

  constructor(private readonly options: GrokDeviceLoginOptions) {}

  snapshot(): GrokLoginSnapshot {
    this.expireIfDue()
    return {
      status: this.status,
      ...(this.url ? { url: this.url } : {}),
      ...(this.userCode ? { userCode: this.userCode } : {}),
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async start(): Promise<GrokLoginSnapshot> {
    if (this.status === 'installing' || this.status === 'waiting') {
      return this.snapshot()
    }

    this.reset()
    this.status = 'installing'
    this.expiresAt = this.now() + (this.options.ttlMs ?? GROK_LOGIN_TTL_MS)
    void this.run()
    return this.snapshot()
  }

  cancel(): GrokLoginSnapshot {
    this.cancelled = true
    this.child?.kill()
    this.finish('idle')
    return this.snapshot()
  }

  private async run(): Promise<void> {
    try {
      const ensure = this.options.ensureBinary ?? (() => ensureGrokBinary({}))
      const binary = await ensure()
      if (this.cancelled) return

      this.home = await mkdtemp(join(tmpdir(), 'dukebox-grok-login-'))
      const spawnLogin = this.options.spawnLogin ?? spawnGrokLogin
      this.child = spawnLogin(binary, this.home)
      this.status = 'waiting'
      this.armTimer()

      this.child.stdout.on('data', (chunk) => this.ingest(chunk.toString()))
      this.child.stderr.on('data', (chunk) => this.ingest(chunk.toString()))
      this.child.on('error', (error) => {
        if (this.cancelled) return
        this.fail(error.message)
      })
      this.child.on('close', (code) => {
        void this.onClose(code)
      })
    } catch (error) {
      if (this.cancelled) return
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private ingest(chunk: string): void {
    this.log += chunk
    const parsed = parseDeviceAuthOutput(this.log)
    if (parsed.url) this.url = parsed.url
    if (parsed.userCode) this.userCode = parsed.userCode
  }

  private async onClose(code: number | null): Promise<void> {
    if (this.cancelled) return
    if (this.status !== 'installing' && this.status !== 'waiting') return

    if (code === 0) {
      try {
        const raw = await this.readAuth()
        await this.options.secrets.set(GROK_AUTH_SECRET, raw)
        this.finish('success')
        return
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error))
        return
      }
    }

    this.fail(this.log.trim() || `grok login exited ${code ?? 'without a code'}`)
  }

  private async readAuth(): Promise<string> {
    const read = this.options.readAuthFile ?? defaultReadAuth
    const raw = await read(this.home ?? '')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('grok wrote an auth.json that is not an object')
    }
    return raw
  }

  private fail(message: string): void {
    this.error = message.slice(0, 400)
    this.finish('failed')
  }

  private expireIfDue(): void {
    if (this.status !== 'installing' && this.status !== 'waiting') return
    if (this.expiresAt && this.now() >= this.expiresAt) {
      this.cancelled = true
      this.child?.kill()
      this.finish('expired')
    }
  }

  private armTimer(): void {
    this.clearTimer()
    const remaining = (this.expiresAt ?? this.now()) - this.now()
    this.timer = setTimeout(
      () => {
        if (this.status !== 'installing' && this.status !== 'waiting') return
        this.cancelled = true
        this.child?.kill()
        this.finish('expired')
      },
      Math.max(0, remaining),
    )
  }

  private finish(status: GrokLoginStatus): void {
    this.status = status
    this.clearTimer()
    this.child = undefined
    const home = this.home
    this.home = undefined
    if (home) void rm(home, { recursive: true, force: true })
  }

  private reset(): void {
    this.cancelled = false
    this.url = undefined
    this.userCode = undefined
    this.expiresAt = undefined
    this.error = undefined
    this.log = ''
    this.child?.kill()
    this.clearTimer()
    if (this.home) void rm(this.home, { recursive: true, force: true })
    this.home = undefined
    this.child = undefined
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

function spawnGrokLogin(binary: string, home: string): LoginProcess {
  return spawn(binary, ['login', '--device-auth', '--no-auto-update'], {
    env: { ...process.env, GROK_HOME: home, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function defaultReadAuth(home: string): Promise<string> {
  return readFile(join(home, 'auth.json'), 'utf8')
}
