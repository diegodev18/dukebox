import { serve } from '@hono/node-server'
import { projects, sessions } from '@dukebox/db'
import type { AgentEvent, EnvelopedEvent, ServerMessage, SessionSummary } from '@dukebox/protocol'
import { PassThrough } from 'node:stream'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import { WebSocket } from 'ws'
import { TerminalRegistry } from '../sessions/terminals.js'
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
const onSetPermissionMode = vi.fn(async () => {})

/**
 * The PTYs handed to the registry, newest last.
 *
 * A PassThrough stands in for a container shell: the connection only writes to
 * it, reads from it, and closes it. Driving a real container here would be
 * testing Docker rather than the WebSocket layer.
 */
let fakeTerminals: { stream: PassThrough; resize: Mock; close: Mock }[] = []
let terminals: TerminalRegistry
const auditTerminal = vi.fn(async () => {})

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

  terminals = new TerminalRegistry({
    openTerminal: async () => {
      const terminal = { stream: new PassThrough(), resize: vi.fn(async () => {}), close: vi.fn() }
      terminal.close = vi.fn(async () => {
        terminal.stream.destroy()
      })
      fakeTerminals.push(terminal)
      return terminal
    },
  })

  wss = attachWebSocketServer(server as unknown as Parameters<typeof attachWebSocketServer>[0], {
    db,
    bus,
    onPrompt,
    onSetPermissionMode,
    terminals,
    auditTerminal,
  })
})

beforeEach(async () => {
  await resetDatabase()
  await redis.flushdb()
  onPrompt.mockClear()
  onSetPermissionMode.mockClear()
  auditTerminal.mockClear()
  fakeTerminals = []
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

  /** Every session summary pushed so far, in arrival order. */
  sessionUpdates(): SessionSummary[] {
    return this.received
      .filter(
        (message): message is Extract<ServerMessage, { type: 'session_update' }> =>
          message.type === 'session_update',
      )
      .map((message) => message.session)
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

  /** Wait for the first message of a type, and return it. */
  async waitForMessage<T extends ServerMessage['type']>(
    type: T,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    await this.waitFor(() => this.received.some((message) => message.type === type))

    return this.received.find(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    )!
  }

  /** Every message of a type received so far. */
  messagesOfType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    )
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
describe('session updates', () => {
  it('pushes a session summary when it changes', async () => {
    // Without this the sidebar shows whatever was true when the app loaded,
    // which for a running session is wrong within seconds.
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    // The server subscribes to Redis after accepting the socket, so a publish
    // sent immediately can beat the subscription. Waiting for a round trip is
    // enough to know it is in place.
    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()

    await bus.publishSessionUpdate({
      id: sessionId,
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      status: 'running',
      purpose: 'coding',
      title: 'A session',
      branch: 'duke/abc',
      baseBranch: 'main',
      changedFileCount: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeq: 5,
      pullRequestUrl: null,
      environmentId: null,
      permissionMode: 'bypass',
    })

    await client.waitFor(() => client.sessionUpdates().length > 0)
    expect(client.sessionUpdates()[0]).toMatchObject({ id: sessionId, status: 'running' })

    client.close()
  })

  it('pushes updates for sessions the client never subscribed to', async () => {
    // The sidebar lists every session, not just the open one, so these cannot
    // depend on a subscription.
    const watched = await createSession()
    const other = await createSession()

    const client = await TestClient.connect(await pairDevice())
    client.send({ type: 'subscribe', sessionId: watched })
    await client.waitForCaughtUp()

    await bus.publishSessionUpdate({
      id: other,
      projectId: '00000000-0000-4000-8000-000000000001',
      agentId: 'claude-code',
      status: 'done',
      purpose: 'coding',
      title: 'Another session',
      branch: 'duke/def',
      baseBranch: 'main',
      changedFileCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastSeq: 1,
      pullRequestUrl: null,
      environmentId: null,
      permissionMode: 'bypass',
    })

    await client.waitFor(() => client.sessionUpdates().length > 0)
    expect(client.sessionUpdates()[0]).toMatchObject({ id: other, status: 'done' })

    client.close()
  })

  it('ignores a summary it cannot read rather than dropping the connection', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    // A server one version ahead, or another writer on the channel.
    await redis.publish('sessions:updates', JSON.stringify({ id: 'not-a-session' }))
    await bus.append(sessionId, TEXT('still working'))

    client.send({ type: 'subscribe', sessionId })
    await client.waitForCaughtUp()

    expect(client.sessionUpdates()).toHaveLength(0)
    expect(client.events()).toHaveLength(1)

    client.close()
  })
})

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

  it('forwards a permission mode change to the session', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'set_permission_mode', sessionId, mode: 'plan' })
    await client.waitFor(() => onSetPermissionMode.mock.calls.length === 1)

    expect(onSetPermissionMode).toHaveBeenCalledWith(sessionId, 'plan')
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

describe('terminals', () => {
  it('opens a terminal and answers with its id', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })

    const opened = await client.waitForMessage('terminal_opened')
    expect(opened.terminalId).toBeTruthy()
    expect(opened.title).toBe('1')

    client.close()
  })

  it('streams PTY output as base64', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    await client.waitForMessage('terminal_opened')

    fakeTerminals[0]!.stream.write('hi')

    const output = await client.waitForMessage('terminal_output')
    expect(Buffer.from(output.data, 'base64').toString()).toBe('hi')

    client.close()
  })

  it('carries input through to the PTY', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    const opened = await client.waitForMessage('terminal_opened')

    const written: Buffer[] = []
    fakeTerminals[0]!.stream.on('data', (chunk: Buffer) => written.push(chunk))

    client.send({
      type: 'terminal_input',
      sessionId,
      terminalId: opened.terminalId,
      data: Buffer.from('ls -la\n').toString('base64'),
    })

    await client.waitFor(() => Buffer.concat(written).includes('ls -la'))

    client.close()
  })

  it('reports a refused open rather than going silent', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    for (let index = 0; index < 4; index += 1) {
      client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
      await client.waitFor(() => client.messagesOfType('terminal_opened').length === index + 1)
    }

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })

    const error = await client.waitForMessage('command_error')
    expect(error.message).toMatch(/at most 4 terminals/)

    client.close()
  })

  it('includes live terminals in the subscribe handshake', async () => {
    const sessionId = await createSession()

    const first = await TestClient.connect(await pairDevice())
    first.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    await first.waitForMessage('terminal_opened')

    const second = await TestClient.connect(await pairDevice())
    second.send({ type: 'subscribe', sessionId })

    const list = await second.waitForMessage('terminal_list')
    expect(list.terminals).toHaveLength(1)

    first.close()
    second.close()
  })

  it('replays the scrollback when a second client attaches', async () => {
    const sessionId = await createSession()

    const first = await TestClient.connect(await pairDevice())
    first.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    const opened = await first.waitForMessage('terminal_opened')

    fakeTerminals[0]!.stream.write('earlier output')
    await first.waitForMessage('terminal_output')

    const second = await TestClient.connect(await pairDevice())
    second.send({
      type: 'terminal_attach',
      sessionId,
      terminalId: opened.terminalId,
      cols: 80,
      rows: 24,
    })

    // The point of the scrollback: a client that arrives late still sees a
    // full screen rather than joining mid-line.
    const output = await second.waitForMessage('terminal_output')
    expect(Buffer.from(output.data, 'base64').toString()).toContain('earlier output')

    first.close()
    second.close()
  })

  it('stops sending after a detach but leaves the shell running', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    const opened = await client.waitForMessage('terminal_opened')

    client.send({ type: 'terminal_detach', sessionId, terminalId: opened.terminalId })

    // Give the detach time to land before writing, so this does not pass by
    // outrunning the server.
    await new Promise((resolve) => setTimeout(resolve, 50))
    fakeTerminals[0]!.stream.write('after detach')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(client.messagesOfType('terminal_output')).toHaveLength(0)
    expect(fakeTerminals[0]!.close).not.toHaveBeenCalled()

    client.close()
  })

  it('leaves the terminal running when the socket closes', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    await client.waitForMessage('terminal_opened')

    client.close()
    await new Promise((resolve) => setTimeout(resolve, 100))

    // A dropped connection must not end a long-running command. This is the
    // whole reason the registry owns the PTY rather than the connection.
    expect(fakeTerminals[0]!.close).not.toHaveBeenCalled()
    expect(terminals.list(sessionId)).toHaveLength(1)
  })

  it('tells watchers when a shell exits', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    await client.waitForMessage('terminal_opened')

    fakeTerminals[0]!.stream.end()

    await client.waitForMessage('terminal_exit')

    client.close()
  })

  it('audits opening and closing, but never the traffic', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    const opened = await client.waitForMessage('terminal_opened')

    client.send({
      type: 'terminal_input',
      sessionId,
      terminalId: opened.terminalId,
      data: Buffer.from('secret-token\n').toString('base64'),
    })

    client.send({ type: 'terminal_close', sessionId, terminalId: opened.terminalId })
    await client.waitFor(() => auditTerminal.mock.calls.length === 2)

    const audited = auditTerminal.mock.calls.map((call) => (call as unknown[])[1])
    expect(audited).toEqual([
      { type: 'terminal_opened', terminalId: opened.terminalId, deviceId: expect.any(String) },
      { type: 'terminal_closed', terminalId: opened.terminalId, deviceId: expect.any(String) },
    ])

    // Keystrokes must never reach the audit trail: people paste secrets into
    // shells, and a keylogger in the database is worth more than its forensics.
    expect(JSON.stringify(auditTerminal.mock.calls)).not.toContain('secret-token')

    client.close()
  })

  it('closes a terminal on request', async () => {
    const sessionId = await createSession()
    const client = await TestClient.connect(await pairDevice())

    client.send({ type: 'terminal_open', sessionId, cols: 80, rows: 24 })
    const opened = await client.waitForMessage('terminal_opened')

    client.send({ type: 'terminal_close', sessionId, terminalId: opened.terminalId })
    await client.waitFor(() => terminals.list(sessionId).length === 0)

    expect(fakeTerminals[0]!.close).toHaveBeenCalled()

    client.close()
  })
})
