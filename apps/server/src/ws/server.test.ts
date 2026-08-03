import { serve } from '@hono/node-server'
import { projects, sessions } from '@dukebox/db'
import type { AgentEvent, EnvelopedEvent, ServerMessage } from '@dukebox/protocol'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { issuePairingCode, redeemPairingCode } from '../auth/pairing.js'
import { EventBus } from '../events/bus.js'
import { createApp } from '../http/app.js'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { closeRedis, redis } from '../testing/redis.js'
import { attachWebSocketServer, tokenFromRequest } from './server.js'

const bus = new EventBus(db, redis)

let server: ReturnType<typeof serve> | undefined
let wss: ReturnType<typeof attachWebSocketServer> | undefined
let port = 0
const onPrompt = vi.fn(async () => {})

afterAll(async () => {
  // The HTTP server waits for open connections, so upgraded sockets have to be
  // torn down first or close() never returns.
  wss?.clients.forEach((socket) => socket.terminate())
  await new Promise<void>((resolve) => {
    if (!wss) return resolve()
    wss.close(() => resolve())
  })

  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
  })

  await close()
  await closeRedis()
})

beforeAll(async () => {
  await prepareDatabase()

  const app = createApp({ db, serverName: 'dukebox-test' })

  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      port = info.port
      resolve()
    })
  })

  wss = attachWebSocketServer(server as unknown as Parameters<typeof attachWebSocketServer>[0], {
    db,
    bus,
    onPrompt,
  })
})

beforeEach(async () => {
  await resetDatabase()
  await redis.flushdb()
  onPrompt.mockClear()
})

async function pairDevice(): Promise<string> {
  const issued = await issuePairingCode(db, { host: '127.0.0.1', port })
  const { deviceToken } = await redeemPairingCode(
    db,
    { code: issued.code, deviceName: 'Test', platform: 'macos' },
    'dukebox-test',
  )
  return deviceToken
}

async function createSession(): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: `diego/repo-${Math.random().toString(36).slice(2)}` })
    .returning()

  const [session] = await db
    .insert(sessions)
    .values({
      projectId: project!.id,
      agentId: 'claude-code',
      status: 'running',
      branch: 'duke/abc',
      baseBranch: 'main',
    })
    .returning()

  return session!.id
}

/** A connected client that records everything the server sends. */
class TestClient {
  readonly received: ServerMessage[] = []
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as ServerMessage)
    })
  }

  static async connect(token: string): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    return new TestClient(socket)
  }

  static async expectRejected(url: string): Promise<number> {
    const socket = new WebSocket(url)

    return new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      socket.once('open', () => {
        socket.close()
        reject(new Error('connection was accepted but should have been rejected'))
      })
      socket.once('error', (error) => reject(error))
    })
  }

  send(command: unknown): void {
    this.socket.send(JSON.stringify(command))
  }

  /** Send a raw frame, bypassing JSON encoding. */
  sendRaw(payload: string): void {
    this.socket.send(payload)
  }

  /** Every session event received so far, in arrival order. */
  events(): EnvelopedEvent[] {
    return this.received
      .filter(
        (message): message is Extract<ServerMessage, { type: 'event' }> => message.type === 'event',
      )
      .map((message) => message.event)
  }

  async waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`timed out; received ${JSON.stringify(this.received)}`)
  }

  waitForCaughtUp(): Promise<void> {
    return this.waitFor(() => this.received.some((message) => message.type === 'caught_up'))
  }

  close(): void {
    this.socket.close()
  }
}

const TEXT = (delta: string): AgentEvent => ({ type: 'assistant_text', delta })

describe('tokenFromRequest', () => {
  it('reads a bearer header', () => {
    const request = { headers: { authorization: 'Bearer abc' }, url: '/ws' }
    expect(tokenFromRequest(request as never)).toBe('abc')
  })

  it('falls back to the query string, which is all a browser can set', () => {
    const request = { headers: {}, url: '/ws?token=xyz' }
    expect(tokenFromRequest(request as never)).toBe('xyz')
  })

  it('returns nothing when there is no token', () => {
    expect(tokenFromRequest({ headers: {}, url: '/ws' } as never)).toBeUndefined()
  })
})

describe('handshake', () => {
  it('accepts a valid device token', async () => {
    const client = await TestClient.connect(await pairDevice())
    client.close()
  })

  it('rejects a connection with no token', async () => {
    expect(await TestClient.expectRejected(`ws://127.0.0.1:${port}/ws`)).toBe(401)
  })

  it('rejects an unknown token', async () => {
    expect(await TestClient.expectRejected(`ws://127.0.0.1:${port}/ws?token=nope`)).toBe(401)
  })
})

describe('subscribe', () => {
  it('replays a session from the beginning', async () => {
    const sessionId = await createSession()
    for (const delta of ['a', 'b', 'c']) await bus.append(sessionId, TEXT(delta))

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()

    expect(client.events().map((event) => event.seq)).toEqual([1, 2, 3])
    client.close()
  })

  it('replays only what follows resumeFrom', async () => {
    const sessionId = await createSession()
    for (const delta of ['a', 'b', 'c', 'd']) await bus.append(sessionId, TEXT(delta))

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId, resumeFrom: 2 })
    await client.waitForCaughtUp()

    expect(client.events().map((event) => event.seq)).toEqual([3, 4])
    client.close()
  })

  it('reports caught_up so the client can drop its catching-up state', async () => {
    const sessionId = await createSession()
    await bus.append(sessionId, TEXT('a'))

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()

    const caughtUp = client.received.find((message) => message.type === 'caught_up')
    expect(caughtUp).toMatchObject({ sessionId, lastSeq: 1 })
    client.close()
  })

  it('delivers live events after catching up', async () => {
    const sessionId = await createSession()

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()

    await bus.append(sessionId, TEXT('live'))
    await client.waitFor(() => client.events().length === 1)

    expect(client.events()[0]?.event).toEqual(TEXT('live'))
    client.close()
  })

  it('rejects subscribing twice to one session', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()
    client.send({ type: 'subscribe', sessionId })

    await client.waitFor(() => client.received.some((message) => message.type === 'command_error'))
    client.close()
  })

  it('stops delivering after unsubscribe', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()
    client.send({ type: 'unsubscribe', sessionId })

    await new Promise((resolve) => setTimeout(resolve, 100))
    await bus.append(sessionId, TEXT('after'))
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(client.events()).toHaveLength(0)
    client.close()
  })
})

/**
 * The guarantee the whole event pipeline exists for: closing a laptop mid-turn
 * must not lose anything, and reconnecting must not show anything twice.
 */
describe('resume', () => {
  it('loses nothing when a client disconnects mid-stream', async () => {
    const sessionId = await createSession()
    const token = await pairDevice()

    const first = await TestClient.connect(token)
    first.send({ type: 'subscribe', sessionId })
    await first.waitForCaughtUp()

    await bus.append(sessionId, TEXT('one'))
    await bus.append(sessionId, TEXT('two'))
    await first.waitFor(() => first.events().length === 2)

    // The laptop closes.
    first.close()

    // Events keep arriving while nobody is listening.
    await bus.append(sessionId, TEXT('three'))
    await bus.append(sessionId, TEXT('four'))

    const second = await TestClient.connect(token)
    second.send({ type: 'subscribe', sessionId, resumeFrom: 2 })
    await second.waitForCaughtUp()

    expect(second.events().map((event) => event.seq)).toEqual([3, 4])
    second.close()
  })

  it('delivers no duplicates across a reconnect', async () => {
    const sessionId = await createSession()
    const token = await pairDevice()

    const first = await TestClient.connect(token)
    first.send({ type: 'subscribe', sessionId })
    await first.waitForCaughtUp()

    for (const delta of ['a', 'b', 'c']) await bus.append(sessionId, TEXT(delta))
    await first.waitFor(() => first.events().length === 3)
    first.close()

    const second = await TestClient.connect(token)
    second.send({ type: 'subscribe', sessionId, resumeFrom: 3 })
    await second.waitForCaughtUp()

    // Everything was already seen; a resume must add nothing.
    expect(second.events()).toHaveLength(0)
    second.close()
  })

  it('reconstructs the full sequence exactly once across a reconnect', async () => {
    const sessionId = await createSession()
    const token = await pairDevice()
    const seen: number[] = []

    const first = await TestClient.connect(token)
    first.send({ type: 'subscribe', sessionId })
    await first.waitForCaughtUp()

    for (const delta of ['a', 'b']) await bus.append(sessionId, TEXT(delta))
    await first.waitFor(() => first.events().length === 2)
    seen.push(...first.events().map((event) => event.seq))
    first.close()

    for (const delta of ['c', 'd', 'e']) await bus.append(sessionId, TEXT(delta))

    const second = await TestClient.connect(token)
    second.send({ type: 'subscribe', sessionId, resumeFrom: seen.at(-1) })
    await second.waitForCaughtUp()
    seen.push(...second.events().map((event) => event.seq))

    // What the client ends up with must equal what the session produced.
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(new Set(seen).size).toBe(seen.length)
    second.close()
  })

  it('loses nothing when events arrive during replay', async () => {
    const sessionId = await createSession()
    for (const delta of ['a', 'b']) await bus.append(sessionId, TEXT(delta))

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId })

    // Racing the replay. Subscribing before replaying is what makes this safe:
    // a live event landing mid-replay is buffered rather than dropped.
    await bus.append(sessionId, TEXT('during'))

    await client.waitForCaughtUp()
    await client.waitFor(() => client.events().length === 3)

    const numbers = client.events().map((event) => event.seq)
    expect(numbers).toEqual([1, 2, 3])
    expect(new Set(numbers).size).toBe(3)
    client.close()
  })

  it('gives two windows on one session the same events', async () => {
    const sessionId = await createSession()
    const token = await pairDevice()

    const first = await TestClient.connect(token)
    const second = await TestClient.connect(token)

    for (const client of [first, second]) {
      client.send({ type: 'subscribe', sessionId })
      await client.waitForCaughtUp()
    }

    await bus.append(sessionId, TEXT('broadcast'))

    for (const client of [first, second]) {
      await client.waitFor(() => client.events().length === 1)
    }

    expect(first.events()).toEqual(second.events())
    first.close()
    second.close()
  })
})

describe('commands', () => {
  it('forwards a prompt to the session', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'prompt', sessionId, text: 'hello' })
    await client.waitFor(() => onPrompt.mock.calls.length === 1)

    expect(onPrompt).toHaveBeenCalledWith(sessionId, 'hello', undefined)
    client.close()
  })

  it('reports a malformed command without dropping the connection', async () => {
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'prompt' })
    await client.waitFor(() => client.received.some((message) => message.type === 'command_error'))

    // Still usable afterwards.
    const sessionId = await createSession()
    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()
    client.close()
  })

  it('reports input that is not JSON', async () => {
    const client = await TestClient.connect(await pairDevice())
    client.sendRaw('not json at all')

    await client.waitFor(() =>
      client.received.some(
        (message) => message.type === 'command_error' && message.message.includes('malformed'),
      ),
    )
    client.close()
  })

  it('reports an unknown command type', async () => {
    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'telepathy', sessionId: 'x' })

    await client.waitFor(() => client.received.some((message) => message.type === 'command_error'))
    client.close()
  })
})
