import type { Database, Device } from '@dukebox/db'
import {
  clientCommand,
  type ClientCommand,
  type EnvelopedEvent,
  type PermissionMode,
  type ServerMessage,
} from '@dukebox/protocol'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { authenticateDevice } from '../auth/pairing.js'
import type { EventBus } from '../events/bus.js'
import type { TerminalRegistry } from '../sessions/terminals.js'

/**
 * Live session traffic.
 *
 * REST handles setup — pairing, listing projects, creating sessions. This
 * carries a session's events to the app and its prompts back, and is where the
 * resume guarantee is delivered: a client reconnecting after any interruption
 * gets every event it missed, exactly once, in order.
 */

export interface WebSocketDeps {
  db: Database
  bus: EventBus
  /** Delivers a prompt to a running agent. Set once sessions exist. */
  onPrompt?: (
    sessionId: string,
    text: string,
    images?: string[],
    files?: { name: string; data: string }[],
  ) => Promise<void>
  onInterrupt?: (sessionId: string) => Promise<void>
  onPermissionResponse?: (sessionId: string, id: string, allow: boolean) => Promise<void>
  onSetPermissionMode?: (sessionId: string, mode: PermissionMode) => Promise<void>
  /** Live terminals. Absent on a server without sessions. */
  terminals?: TerminalRegistry
  /** Records that a person opened or closed a shell. Never records I/O. */
  auditTerminal?: (
    sessionId: string,
    event: { type: 'terminal_opened' | 'terminal_closed'; terminalId: string; deviceId: string },
  ) => Promise<void>
}

/**
 * How far behind a socket may fall before terminal output is dropped for it.
 *
 * One megabyte is roughly a screen-refresh storm's worth of backlog. Past that
 * the client is not keeping up, and buffering more only delays the truth while
 * the control plane pays for it in memory.
 */
const BACKPRESSURE_BYTES = 1024 * 1024

/** One connected app, and whatever it is watching. */
class Connection {
  private readonly subscriptions = new Map<string, () => Promise<void>>()

  /** Terminals this socket is watching, and how to stop watching them. */
  private readonly attached = new Map<string, () => void>()

  constructor(
    private readonly socket: WebSocket,
    readonly device: Device,
    private readonly deps: WebSocketDeps,
  ) {}

  send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return
    this.socket.send(JSON.stringify(message))
  }

  private fail(message: string, sessionId?: string): void {
    this.send({
      type: 'command_error',
      ...(sessionId ? { sessionId } : {}),
      message,
    })
  }

  async handle(raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.fail('malformed message')
      return
    }

    const command = clientCommand.safeParse(parsed)
    if (!command.success) {
      this.fail(`unrecognized command: ${command.error.message}`)
      return
    }

    await this.dispatch(command.data)
  }

  private async dispatch(command: ClientCommand): Promise<void> {
    switch (command.type) {
      case 'subscribe':
        return this.subscribe(command.sessionId, command.resumeFrom)
      case 'unsubscribe':
        return this.unsubscribe(command.sessionId)
      case 'prompt':
        return this.forward(command.sessionId, () =>
          this.deps.onPrompt?.(command.sessionId, command.text, command.images, command.files),
        )
      case 'interrupt':
        return this.forward(command.sessionId, () => this.deps.onInterrupt?.(command.sessionId))
      case 'permission_response':
        return this.forward(command.sessionId, () =>
          this.deps.onPermissionResponse?.(command.sessionId, command.id, command.allow),
        )
      case 'set_permission_mode':
        return this.forward(command.sessionId, () =>
          this.deps.onSetPermissionMode?.(command.sessionId, command.mode),
        )
      case 'terminal_open':
        return this.openTerminal(command.sessionId, command.cols, command.rows)
      case 'terminal_attach':
        return this.attachTerminal(command.sessionId, command.terminalId, {
          cols: command.cols,
          rows: command.rows,
        })
      case 'terminal_detach':
        return this.detachTerminal(command.terminalId)
      case 'terminal_input':
        return this.withTerminals(command.sessionId, (terminals) => {
          terminals.write(
            command.sessionId,
            command.terminalId,
            Buffer.from(command.data, 'base64'),
          )
        })
      case 'terminal_resize':
        return this.withTerminals(command.sessionId, (terminals) =>
          terminals.resize(command.sessionId, command.terminalId, command.cols, command.rows),
        )
      case 'terminal_close':
        return this.closeTerminal(command.sessionId, command.terminalId)
      case 'terminal_rename':
        return this.withTerminals(command.sessionId, (terminals) => {
          terminals.rename(command.sessionId, command.terminalId, command.title)
        })
    }
  }

  private async openTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      const info = await terminals.open(sessionId, { cols, rows })

      this.send({
        type: 'terminal_opened',
        sessionId,
        terminalId: info.terminalId,
        title: info.title,
        cols,
        rows,
      })

      // The opener is attached automatically: a terminal you have to ask for
      // twice before it says anything looks broken.
      this.attachTo(sessionId, info.terminalId, terminals)

      await this.deps.auditTerminal?.(sessionId, {
        type: 'terminal_opened',
        terminalId: info.terminalId,
        deviceId: this.device.id,
      })
    })
  }

  private async attachTerminal(
    sessionId: string,
    terminalId: string,
    size: { cols: number; rows: number },
  ): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      this.attachTo(sessionId, terminalId, terminals)
      await terminals.resize(sessionId, terminalId, size.cols, size.rows)
    })
  }

  /**
   * Start forwarding a terminal to this socket.
   *
   * The scrollback goes out first so the client redraws a full screen rather
   * than joining mid-line.
   */
  private attachTo(sessionId: string, terminalId: string, terminals: TerminalRegistry): void {
    if (this.attached.has(terminalId)) return

    const listener = (chunk: Buffer) => {
      // Dropped rather than queued when the socket is already backed up. A
      // terminal that skips lines under a flood of output is survivable; a
      // control plane buffering megabytes for one slow client is not.
      if (this.socket.bufferedAmount > BACKPRESSURE_BYTES) return

      this.send({
        type: 'terminal_output',
        sessionId,
        terminalId,
        data: chunk.toString('base64'),
      })
    }

    const onExit = (exitCode?: number) => {
      this.attached.delete(terminalId)
      this.send({
        type: 'terminal_exit',
        sessionId,
        terminalId,
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    }

    const scrollback = terminals.attach(sessionId, terminalId, listener, onExit)
    if (scrollback.length > 0) {
      this.send({
        type: 'terminal_output',
        sessionId,
        terminalId,
        data: scrollback.toString('base64'),
      })
    }

    this.attached.set(terminalId, () => terminals.detach(sessionId, terminalId, listener))
  }

  private detachTerminal(terminalId: string): void {
    const stop = this.attached.get(terminalId)
    if (!stop) return

    this.attached.delete(terminalId)
    stop()
  }

  private async closeTerminal(sessionId: string, terminalId: string): Promise<void> {
    await this.withTerminals(sessionId, async (terminals) => {
      await terminals.close(sessionId, terminalId)
      this.detachTerminal(terminalId)

      await this.deps.auditTerminal?.(sessionId, {
        type: 'terminal_closed',
        terminalId,
        deviceId: this.device.id,
      })
    })
  }

  /** Run a terminal action, reporting failure to the client rather than throwing. */
  private async withTerminals(
    sessionId: string,
    action: (terminals: TerminalRegistry) => Promise<void> | void,
  ): Promise<void> {
    const terminals = this.deps.terminals
    if (!terminals) {
      this.fail('terminals are not available on this server', sessionId)
      return
    }

    try {
      await action(terminals)
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'terminal command failed', sessionId)
    }
  }

  /**
   * Replay what the client missed, then switch it to live.
   *
   * Ordering is the whole point. Subscribing before replaying means a live
   * event that lands mid-replay is buffered rather than lost, and the seq
   * filter below drops the ones replay already covered. Replaying first would
   * leave a gap for anything that arrived in between.
   */
  private async subscribe(sessionId: string, resumeFrom = 0): Promise<void> {
    if (this.subscriptions.has(sessionId)) {
      this.fail('already subscribed', sessionId)
      return
    }

    const buffered: EnvelopedEvent[] = []
    let replaying = true

    const unsubscribe = await this.deps.bus.subscribe(sessionId, (event) => {
      if (replaying) {
        buffered.push(event)
        return
      }
      this.send({ type: 'event', event })
    })

    this.subscriptions.set(sessionId, unsubscribe)

    const replayed = await this.deps.bus.replay(sessionId, resumeFrom)
    for (const event of replayed) {
      this.send({ type: 'event', event })
    }

    const highestReplayed = replayed.at(-1)?.seq ?? resumeFrom

    // Anything buffered at or below what replay covered is a duplicate.
    replaying = false
    for (const event of buffered) {
      if (event.seq > highestReplayed) {
        this.send({ type: 'event', event })
      }
    }

    // Tells the client to drop its "catching up" state. Without it there is no
    // way to distinguish a slow replay from an idle session.
    this.send({
      type: 'caught_up',
      sessionId,
      lastSeq: Math.max(highestReplayed, buffered.at(-1)?.seq ?? 0),
    })

    // Sent with the handshake rather than on request: a client that has to ask
    // separately shows an empty terminal tab until a second round trip lands.
    if (this.deps.terminals) {
      this.send({
        type: 'terminal_list',
        sessionId,
        terminals: this.deps.terminals.list(sessionId),
      })
    }
  }

  private async unsubscribe(sessionId: string): Promise<void> {
    const stop = this.subscriptions.get(sessionId)
    if (!stop) return

    this.subscriptions.delete(sessionId)
    await stop()
  }

  /** Run a session action, reporting failure to the client rather than throwing. */
  private async forward(sessionId: string, action: () => Promise<void> | undefined): Promise<void> {
    try {
      const result = action()
      if (result === undefined) {
        this.fail('sessions are not available on this server', sessionId)
        return
      }
      await result
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'command failed', sessionId)
    }
  }

  /** Release every subscription. Called when the socket closes. */
  async close(): Promise<void> {
    // Terminals are detached, not closed: the whole point of the registry
    // owning the PTY is that a dropped connection leaves the shell running.
    for (const stop of this.attached.values()) stop()
    this.attached.clear()

    const stops = [...this.subscriptions.values()]
    this.subscriptions.clear()
    await Promise.all(stops.map((stop) => stop()))
  }
}

/**
 * Read the device token from a connection request.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the query string is
 * also accepted. That puts the token in server logs, which is a real cost —
 * but the alternative is no desktop-app compatibility at all, and the token is
 * already scoped to a single revocable device on a private tailnet.
 */
export function tokenFromRequest(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)

  const url = new URL(request.url ?? '/', 'http://localhost')
  return url.searchParams.get('token') ?? undefined
}

export function attachWebSocketServer(server: Server, deps: WebSocketDeps): WebSocketServer {
  // `noServer` so the HTTP server owns the upgrade and can reject an
  // unauthenticated one before any WebSocket state exists.
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const token = tokenFromRequest(request)

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    authenticateDevice(deps.db, token)
      .then((device) => {
        if (!device) {
          // Identical to the missing-token response: distinguishing them tells
          // a caller whether a guess was structurally right.
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, device)
        })
      })
      .catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
        socket.destroy()
      })
  })

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, device: Device) => {
    const connection = new Connection(socket, device, deps)
    registerSocket(device.id, socket)

    // Session state, for every session rather than the subscribed one: the
    // sidebar lists them all, and without this it shows whatever was true when
    // the app loaded.
    const updates = deps.bus
      .subscribeToSessionUpdates((session) => connection.send({ type: 'session_update', session }))
      .catch(() => undefined)

    const teardown = async () => {
      unregisterSocket(device.id, socket)
      await (
        await updates
      )?.()
      await connection.close()
    }

    socket.on('message', (data) => {
      void connection.handle(data.toString())
    })

    socket.on('close', () => {
      void teardown()
    })

    socket.on('error', () => {
      void teardown()
    })
  })

  return wss
}

const socketsByDevice = new Map<string, Set<WebSocket>>()

function registerSocket(deviceId: string, socket: WebSocket): void {
  const sockets = socketsByDevice.get(deviceId) ?? new Set()
  sockets.add(socket)
  socketsByDevice.set(deviceId, sockets)
}

function unregisterSocket(deviceId: string, socket: WebSocket): void {
  const sockets = socketsByDevice.get(deviceId)
  if (!sockets) return
  sockets.delete(socket)
  if (sockets.size === 0) socketsByDevice.delete(deviceId)
}

/** Close every live socket for a device that was just revoked. */
export function disconnectDevice(deviceId: string): void {
  const sockets = socketsByDevice.get(deviceId)
  if (!sockets) return
  for (const socket of [...sockets]) {
    socket.close(4000, 'revoked')
  }
}
