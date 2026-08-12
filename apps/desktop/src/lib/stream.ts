import {
  serverMessage,
  type ClientCommand,
  type PermissionMode,
  type ServerMessage,
} from '@dukebox/protocol'
import { socketUrl, type ServerAddress } from '@/lib/client'

/**
 * The live connection to a session.
 *
 * A socket that reconnects on its own, because the alternative is an app that
 * silently stops updating when a laptop lid closes or a tailnet blips. What
 * makes reconnection safe rather than lossy is `resumeFrom`: the caller reports
 * the highest seq it has folded in, and the server replays everything after it.
 *
 * This owns no transcript state. It reports events; deciding what they mean is
 * the reducer's job, and keeping the two apart is what lets the reducer be
 * tested without a socket.
 */

export type StreamStatus = 'connecting' | 'live' | 'catching_up' | 'offline'

export interface StreamHandlers {
  onMessage: (message: ServerMessage) => void
  onStatus: (status: StreamStatus) => void
  /**
   * A connection that never reached the server.
   *
   * Separate from `onStatus('offline')`, which covers a socket that was working
   * and dropped. This one means it never worked, and the difference decides
   * whether waiting is worth anything.
   */
  onFailure?: (reason: string) => void
}

/** Where a reconnect should resume from. Read at connect time, never cached. */
export type ResumePoint = (sessionId: string) => number

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 15_000

export class SessionStream {
  private socket: WebSocket | null = null
  private retryDelay = INITIAL_RETRY_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly subscribed = new Set<string>()
  private closed = false

  constructor(
    private readonly address: ServerAddress,
    private readonly token: string,
    private readonly handlers: StreamHandlers,
    private readonly resumeFrom: ResumePoint,
  ) {}

  connect(): void {
    if (this.closed || this.socket) return

    this.handlers.onStatus('connecting')

    const socket = new WebSocket(socketUrl(this.address, this.token))
    this.socket = socket

    // Whether this socket ever reached the server. A close before that means
    // the connection was rejected, not dropped, and those need different words.
    let opened = false

    socket.onopen = () => {
      opened = true
      this.retryDelay = INITIAL_RETRY_MS

      // Re-subscribe to everything that was open. After a drop the server has
      // no memory of this client, so silence here would look exactly like an
      // idle session.
      for (const sessionId of this.subscribed) {
        this.sendSubscribe(sessionId)
      }

      this.handlers.onStatus(this.subscribed.size > 0 ? 'catching_up' : 'live')
    }

    socket.onmessage = (raw) => {
      const parsed = this.parse(raw.data)
      if (!parsed) return

      if (parsed.type === 'caught_up') this.handlers.onStatus('live')
      this.handlers.onMessage(parsed)
    }

    socket.onclose = (event) => {
      this.socket = null
      if (this.closed) return

      // A socket that closes without ever opening never reached the server:
      // rejected at the handshake, or refused by the webview before it left.
      // Reported rather than retried silently, because retrying forever on a
      // connection that cannot succeed looks identical to a quiet session.
      if (!opened) {
        this.handlers.onFailure?.(
          event.code === 1006
            ? 'the connection was refused before reaching the server'
            : `the server closed the connection (${event.code})`,
        )
      }

      this.handlers.onStatus('offline')
      this.scheduleReconnect()
    }

    // An error is always followed by a close, which is where reconnection and
    // reporting happen. Doing it here too would open two sockets.
    socket.onerror = () => {}
  }

  /**
   * Watch a session.
   *
   * Remembered across reconnects, so this is called once per session the user
   * opens rather than once per connection.
   */
  subscribe(sessionId: string): void {
    if (this.subscribed.has(sessionId)) return
    this.subscribed.add(sessionId)

    if (this.isOpen()) {
      this.handlers.onStatus('catching_up')
      this.sendSubscribe(sessionId)
    }
  }

  unsubscribe(sessionId: string): void {
    if (!this.subscribed.delete(sessionId)) return
    this.send({ type: 'unsubscribe', sessionId })
  }

  prompt(sessionId: string, text: string, images?: string[]): void {
    this.send({ type: 'prompt', sessionId, text, ...(images ? { images } : {}) })
  }

  interrupt(sessionId: string): void {
    this.send({ type: 'interrupt', sessionId })
  }

  answerPermission(sessionId: string, id: string, allow: boolean): void {
    this.send({ type: 'permission_response', sessionId, id, allow })
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    this.send({ type: 'set_permission_mode', sessionId, mode })
  }

  openTerminal(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_open', sessionId, cols, rows })
  }

  attachTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_attach', sessionId, terminalId, cols, rows })
  }

  detachTerminal(sessionId: string, terminalId: string): void {
    this.send({ type: 'terminal_detach', sessionId, terminalId })
  }

  /** `data` is already base64: the caller encodes what the keyboard produced. */
  sendTerminalInput(sessionId: string, terminalId: string, data: string): void {
    this.send({ type: 'terminal_input', sessionId, terminalId, data })
  }

  resizeTerminal(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal_resize', sessionId, terminalId, cols, rows })
  }

  closeTerminal(sessionId: string, terminalId: string): void {
    this.send({ type: 'terminal_close', sessionId, terminalId })
  }

  renameTerminal(sessionId: string, terminalId: string, title: string): void {
    this.send({ type: 'terminal_rename', sessionId, terminalId, title })
  }

  /** Stop for good. A stream closed this way does not reconnect. */
  close(): void {
    this.closed = true

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    this.subscribed.clear()
    this.socket?.close()
    this.socket = null
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private sendSubscribe(sessionId: string): void {
    const resumeFrom = this.resumeFrom(sessionId)
    this.send({ type: 'subscribe', sessionId, ...(resumeFrom > 0 ? { resumeFrom } : {}) })
  }

  /**
   * Commands sent while offline are dropped, not queued.
   *
   * Queuing would deliver a prompt minutes later, against a session whose state
   * has moved on — worse than a prompt that visibly did not send.
   */
  private send(command: ClientCommand): void {
    if (!this.isOpen()) return
    this.socket?.send(JSON.stringify(command))
  }

  private parse(data: unknown): ServerMessage | null {
    if (typeof data !== 'string') return null

    try {
      // Validated rather than trusted: a server one version ahead can send a
      // message shape this build has never seen, and crashing the renderer over
      // it would take the whole window down.
      const result = serverMessage.safeParse(JSON.parse(data))
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return

    // Backoff with jitter. Without the jitter, every session in the app
    // reconnects in lockstep and hits the server as one burst.
    const jitter = Math.random() * this.retryDelay * 0.3
    const delay = this.retryDelay + jitter

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)

    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
  }
}
