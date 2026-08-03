import type { Database, Device } from '@dukebox/db'
import {
  clientCommand,
  type ClientCommand,
  type EnvelopedEvent,
  type ServerMessage,
} from '@dukebox/protocol'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { authenticateDevice } from '../auth/pairing.js'
import type { EventBus } from '../events/bus.js'

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
  onPrompt?: (sessionId: string, text: string, images?: string[]) => Promise<void>
  onInterrupt?: (sessionId: string) => Promise<void>
  onPermissionResponse?: (sessionId: string, id: string, allow: boolean) => Promise<void>
}

/** One connected app, and whatever it is watching. */
class Connection {
  private readonly subscriptions = new Map<string, () => Promise<void>>()

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
          this.deps.onPrompt?.(command.sessionId, command.text, command.images),
        )
      case 'interrupt':
        return this.forward(command.sessionId, () => this.deps.onInterrupt?.(command.sessionId))
      case 'permission_response':
        return this.forward(command.sessionId, () =>
          this.deps.onPermissionResponse?.(command.sessionId, command.id, command.allow),
        )
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

    socket.on('message', (data) => {
      void connection.handle(data.toString())
    })

    socket.on('close', () => {
      void connection.close()
    })

    socket.on('error', () => {
      void connection.close()
    })
  })

  return wss
}
