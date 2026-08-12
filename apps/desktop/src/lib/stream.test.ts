import type { ClientCommand, ServerMessage } from '@dukebox/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStream, type StreamStatus } from '@/lib/stream'

/**
 * A WebSocket that never touches a network.
 *
 * The behaviour worth testing here is what the stream does around a socket —
 * resubscribing, resuming, backing off — none of which needs a real server.
 */
class FakeSocket {
  static instances: FakeSocket[] = []

  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState = 0
  sent: string[] = []

  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
  }

  /** Simulate the server accepting the connection. */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** Simulate the connection dropping. */
  drop(code = 1001): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code })
  }

  /**
   * Simulate a connection that never reached the server.
   *
   * 1006 is what a browser reports when a socket closes abnormally without a
   * close frame — a refused handshake, or a request the webview never sent.
   */
  refuse(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code: 1006 })
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  deliverRaw(data: unknown): void {
    this.onmessage?.({ data })
  }

  commands(): ClientCommand[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientCommand)
  }
}

const ADDRESS = { host: 'server', port: 7777, tls: false }
const SESSION = '00000000-0000-4000-8000-000000000000'
const OTHER = '11111111-1111-4111-8111-111111111111'

function setup(resumeFrom: (sessionId: string) => number = () => 0) {
  const messages: ServerMessage[] = []
  const statuses: StreamStatus[] = []
  const failures: string[] = []

  const stream = new SessionStream(
    ADDRESS,
    'device-token',
    {
      onMessage: (message) => messages.push(message),
      onStatus: (status) => statuses.push(status),
      onFailure: (reason) => failures.push(reason),
    },
    resumeFrom,
  )

  return {
    stream,
    messages,
    statuses,
    failures,
    socket: () => FakeSocket.instances.at(-1) as FakeSocket,
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connecting', () => {
  it('carries the device token', () => {
    const { stream, socket } = setup()
    stream.connect()

    expect(socket().url).toBe('ws://server:7777/ws?token=device-token')
  })

  it('opens one socket even if connect is called twice', () => {
    const { stream } = setup()
    stream.connect()
    stream.connect()

    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('subscribing', () => {
  it('subscribes once open', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.subscribe(SESSION)

    expect(socket().commands()).toEqual([{ type: 'subscribe', sessionId: SESSION }])
  })

  it('omits resumeFrom when there is nothing to resume', () => {
    const { stream, socket } = setup(() => 0)
    stream.connect()
    socket().open()
    stream.subscribe(SESSION)

    expect(socket().commands()[0]).not.toHaveProperty('resumeFrom')
  })

  it('does not subscribe twice to one session', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.subscribe(SESSION)
    stream.subscribe(SESSION)

    expect(socket().commands()).toHaveLength(1)
  })

  it('subscribes on connect for sessions opened while offline', () => {
    const { stream, socket } = setup()
    stream.subscribe(SESSION)
    stream.connect()
    socket().open()

    expect(socket().commands()).toEqual([{ type: 'subscribe', sessionId: SESSION }])
  })
})

describe('reconnecting', () => {
  it('resubscribes to everything it was watching', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.subscribe(SESSION)
    stream.subscribe(OTHER)

    socket().drop()
    vi.advanceTimersByTime(1000)
    socket().open()

    const resubscribed = socket()
      .commands()
      .filter((command) => command.type === 'subscribe')
      .map((command) => command.sessionId)

    expect(resubscribed).toEqual([SESSION, OTHER])
  })

  it('resumes from the last seq the caller has folded in', () => {
    // The resume point is read at connect time, not cached — by the time a
    // reconnect happens the caller has folded in more events than when it
    // first subscribed.
    let lastSeq = 0
    const { stream, socket } = setup(() => lastSeq)

    stream.connect()
    socket().open()
    stream.subscribe(SESSION)

    lastSeq = 42
    socket().drop()
    vi.advanceTimersByTime(1000)
    socket().open()

    expect(socket().commands()[0]).toEqual({
      type: 'subscribe',
      sessionId: SESSION,
      resumeFrom: 42,
    })
  })

  it('backs off instead of hammering a server that is down', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    socket().drop()

    // First retry is fast, so a blip recovers quickly.
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.instances).toHaveLength(2)

    socket().drop()
    // The second wait is longer than the first, so it has not fired yet.
    vi.advanceTimersByTime(700)
    expect(FakeSocket.instances).toHaveLength(2)

    vi.advanceTimersByTime(2000)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('stops retrying once closed', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.close()

    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('does not reconnect when close races an in-flight drop', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    socket().drop()
    stream.close()

    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('status', () => {
  it('reports catching up until the server says it is done', () => {
    const { stream, socket, statuses } = setup()
    stream.connect()
    socket().open()
    stream.subscribe(SESSION)

    expect(statuses.at(-1)).toBe('catching_up')

    socket().deliver({ type: 'caught_up', sessionId: SESSION, lastSeq: 3 })
    expect(statuses.at(-1)).toBe('live')
  })

  it('reports offline when the connection drops', () => {
    const { stream, socket, statuses } = setup()
    stream.connect()
    socket().open()
    socket().drop()

    expect(statuses.at(-1)).toBe('offline')
  })

  it('says so when a socket never reached the server', () => {
    // Otherwise this is "Reconnecting…" forever, which is exactly what a
    // working connection looks like during a blip.
    const { stream, socket, failures } = setup()
    stream.connect()
    socket().refuse()

    expect(failures.at(-1)).toMatch(/refused before reaching the server/)
  })

  it('stays quiet when a working connection drops', () => {
    // A drop after the socket opened is ordinary and recovers on its own.
    const { stream, socket, failures } = setup()
    stream.connect()
    socket().open()
    socket().drop()

    expect(failures).toHaveLength(0)
  })

  it('distinguishes a rejected handshake from a refused connection', () => {
    const { stream, socket, failures } = setup()
    stream.connect()
    socket().drop(1008)

    expect(failures.at(-1)).toMatch(/server closed the connection \(1008\)/)
  })
})

describe('commands', () => {
  it('sends a prompt', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.prompt(SESSION, 'fix the bug')

    expect(socket().commands()).toEqual([
      { type: 'prompt', sessionId: SESSION, text: 'fix the bug' },
    ])
  })

  it('drops commands sent while offline rather than queuing them', () => {
    // A prompt delivered minutes late lands against a session that has moved
    // on. Visibly not sending is the better failure.
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    socket().drop()

    stream.prompt(SESSION, 'lost')
    vi.advanceTimersByTime(1000)
    socket().open()

    expect(
      socket()
        .commands()
        .filter((command) => command.type === 'prompt'),
    ).toHaveLength(0)
  })

  it('answers a permission request', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.answerPermission(SESSION, 'perm-1', true)

    expect(socket().commands()).toEqual([
      { type: 'permission_response', sessionId: SESSION, id: 'perm-1', allow: true },
    ])
  })

  it('changes the permission mode', () => {
    const { stream, socket } = setup()
    stream.connect()
    socket().open()
    stream.setPermissionMode(SESSION, 'plan')

    expect(socket().commands()).toEqual([
      { type: 'set_permission_mode', sessionId: SESSION, mode: 'plan' },
    ])
  })
})

describe('bad input', () => {
  it('ignores a message that is not valid JSON', () => {
    const { stream, socket, messages } = setup()
    stream.connect()
    socket().open()
    socket().deliverRaw('{ not json')

    expect(messages).toHaveLength(0)
  })

  it('ignores a message shape this build does not know', () => {
    // A server one version ahead must not be able to crash the renderer.
    const { stream, socket, messages } = setup()
    stream.connect()
    socket().open()
    socket().deliverRaw(JSON.stringify({ type: 'from_the_future', payload: 1 }))

    expect(messages).toHaveLength(0)
  })
})
