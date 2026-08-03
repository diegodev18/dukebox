import { projects, sessions } from '@dukebox/db'
import type { AgentEvent, EnvelopedEvent } from '@dukebox/protocol'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { closeRedis, redis } from '../testing/redis.js'
import { EventBus } from './bus.js'

const bus = new EventBus(db, redis)

afterAll(async () => {
  await close()
  await closeRedis()
})

beforeAll(prepareDatabase)

beforeEach(async () => {
  await resetDatabase()
  await redis.flushdb()
})

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

const TEXT = (delta: string): AgentEvent => ({ type: 'assistant_text', delta })

describe('append', () => {
  it('numbers the first event 1', async () => {
    const sessionId = await createSession()
    const appended = await bus.append(sessionId, TEXT('hello'))

    expect(appended.seq).toBe(1)
    expect(appended.sessionId).toBe(sessionId)
  })

  it('numbers events consecutively', async () => {
    const sessionId = await createSession()

    for (const expected of [1, 2, 3]) {
      expect((await bus.append(sessionId, TEXT('x'))).seq).toBe(expected)
    }
  })

  it('numbers each session independently', async () => {
    const first = await createSession()
    const second = await createSession()

    await bus.append(first, TEXT('a'))
    expect((await bus.append(second, TEXT('b'))).seq).toBe(1)
  })

  it('assigns unique sequence numbers under concurrent writes', async () => {
    const sessionId = await createSession()

    // The agent and control-plane actions both append. If numbering were done
    // in application code — read, add one, write back — two writers would land
    // on the same number and corrupt every client's view of the session.
    const appended = await Promise.all(
      Array.from({ length: 25 }, (_, index) => bus.append(sessionId, TEXT(`event-${index}`))),
    )

    const numbers = appended.map((event) => event.seq).sort((a, b) => a - b)
    expect(new Set(numbers).size).toBe(25)
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, index) => index + 1))
  })

  it('rejects an event that is not valid', async () => {
    const sessionId = await createSession()

    // Storing one would break every client that later replays this session.
    await expect(
      bus.append(sessionId, { type: 'nonsense' } as unknown as AgentEvent),
    ).rejects.toThrow()
  })

  it('rejects an event for a session that does not exist', async () => {
    await expect(bus.append('00000000-0000-4000-8000-000000000000', TEXT('x'))).rejects.toThrow(
      'no such session',
    )
  })

  it('advances the session last_seq, which resume reads', async () => {
    const sessionId = await createSession()
    await bus.append(sessionId, TEXT('a'))
    await bus.append(sessionId, TEXT('b'))

    expect(await bus.lastSeq(sessionId)).toBe(2)
  })
})

describe('replay', () => {
  it('returns nothing for a session with no events', async () => {
    expect(await bus.replay(await createSession())).toEqual([])
  })

  it('returns every event in order', async () => {
    const sessionId = await createSession()
    for (const delta of ['a', 'b', 'c']) await bus.append(sessionId, TEXT(delta))

    const replayed = await bus.replay(sessionId)
    expect(replayed.map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('returns only what follows the given sequence number', async () => {
    const sessionId = await createSession()
    for (const delta of ['a', 'b', 'c', 'd']) await bus.append(sessionId, TEXT(delta))

    const replayed = await bus.replay(sessionId, 2)
    expect(replayed.map((event) => event.seq)).toEqual([3, 4])
  })

  it('returns nothing when the client is already current', async () => {
    const sessionId = await createSession()
    await bus.append(sessionId, TEXT('a'))

    expect(await bus.replay(sessionId, 1)).toEqual([])
  })

  it('preserves the event payload exactly', async () => {
    const sessionId = await createSession()
    const event: AgentEvent = {
      type: 'tool_call',
      id: 'call_1',
      name: 'Read',
      input: { file_path: '/workspace/repo/a.ts', nested: { deep: true } },
    }

    await bus.append(sessionId, event)
    expect((await bus.replay(sessionId))[0]?.event).toEqual(event)
  })

  it('does not mix in another session', async () => {
    const first = await createSession()
    const second = await createSession()

    await bus.append(first, TEXT('first'))
    await bus.append(second, TEXT('second'))

    const replayed = await bus.replay(first)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.event).toEqual(TEXT('first'))
  })

  it('replays from Postgres, so a client away past the stream cap loses nothing', async () => {
    // Redis keeps a bounded window; the durable record does not. A client that
    // was away longer than the window must still get its full history.
    const sessionId = await createSession()
    await bus.append(sessionId, TEXT('a'))
    await bus.append(sessionId, TEXT('b'))

    await bus.clearStream(sessionId)

    expect(await bus.replay(sessionId)).toHaveLength(2)
  })
})

describe('subscribe', () => {
  /** Wait for a condition, so tests do not depend on a fixed delay. */
  async function eventually(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('condition was not met in time')
  }

  it('delivers events as they are appended', async () => {
    const sessionId = await createSession()
    const received: EnvelopedEvent[] = []

    const unsubscribe = await bus.subscribe(sessionId, (event) => received.push(event))
    try {
      await bus.append(sessionId, TEXT('live'))
      await eventually(() => received.length === 1)

      expect(received[0]?.event).toEqual(TEXT('live'))
    } finally {
      await unsubscribe()
    }
  })

  it('delivers to every subscriber, so two windows stay in step', async () => {
    const sessionId = await createSession()
    const first: EnvelopedEvent[] = []
    const second: EnvelopedEvent[] = []

    const stopFirst = await bus.subscribe(sessionId, (event) => first.push(event))
    const stopSecond = await bus.subscribe(sessionId, (event) => second.push(event))

    try {
      await bus.append(sessionId, TEXT('broadcast'))
      await eventually(() => first.length === 1 && second.length === 1)
    } finally {
      await stopFirst()
      await stopSecond()
    }
  })

  it('delivers only that session, so an open window ignores other sessions', async () => {
    const watched = await createSession()
    const other = await createSession()
    const received: EnvelopedEvent[] = []

    const unsubscribe = await bus.subscribe(watched, (event) => received.push(event))
    try {
      await bus.append(other, TEXT('elsewhere'))
      await bus.append(watched, TEXT('here'))
      await eventually(() => received.length === 1)

      expect(received).toHaveLength(1)
      expect(received[0]?.event).toEqual(TEXT('here'))
    } finally {
      await unsubscribe()
    }
  })

  it('stops delivering after unsubscribe', async () => {
    const sessionId = await createSession()
    const received: EnvelopedEvent[] = []

    const unsubscribe = await bus.subscribe(sessionId, (event) => received.push(event))
    await unsubscribe()

    await bus.append(sessionId, TEXT('after'))
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(received).toHaveLength(0)
  })

  it('delivers events in the order they were appended', async () => {
    const sessionId = await createSession()
    const received: EnvelopedEvent[] = []

    const unsubscribe = await bus.subscribe(sessionId, (event) => received.push(event))
    try {
      for (const delta of ['a', 'b', 'c', 'd', 'e']) await bus.append(sessionId, TEXT(delta))
      await eventually(() => received.length === 5)

      expect(received.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    } finally {
      await unsubscribe()
    }
  })
})
