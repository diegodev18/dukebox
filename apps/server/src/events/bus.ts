import { messages, sessions, type Database } from '@dukebox/db'
import { agentEvent, type AgentEvent, type EnvelopedEvent } from '@dukebox/protocol'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type Redis from 'ioredis'

/**
 * The session event log.
 *
 * Two stores, each for what it is good at. Postgres holds the durable record
 * and assigns sequence numbers; Redis fans events out to connected clients and
 * serves recent replays without a database round trip.
 *
 * The guarantee this exists to provide: a client that reconnects after any
 * interruption sees every event it missed, exactly once, in order. Closing a
 * laptop mid-turn must not lose anything.
 */

/**
 * Remove NUL bytes from anything bound for the event log.
 *
 * Postgres rejects U+0000 inside jsonb — it has no representation in text —
 * and an agent's stdout carries them routinely: a binary file read, a truncated
 * write, a tool that pads its output. Left alone, one of them fails the insert
 * and takes the whole session down with an error about Unicode escapes that
 * says nothing about what happened.
 *
 * Recursive because they turn up nested inside tool inputs and results, not
 * just in top-level text.
 */
const NULL_BYTE = /\u0000/g

export function stripNullBytes<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(NULL_BYTE, '') as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stripNullBytes(entry)) as T
  }

  if (value !== null && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      cleaned[key] = stripNullBytes(entry)
    }
    return cleaned as T
  }

  return value
}

/** Redis stream key for a session. */
export function streamKey(sessionId: string): string {
  return `session:${sessionId}:events`
}

/** Redis pub/sub channel announcing new events for a session. */
export function channelKey(sessionId: string): string {
  return `session:${sessionId}:live`
}

/**
 * How many events Redis keeps per session.
 *
 * A client reconnecting within this window replays from Redis; one that was
 * away longer falls back to Postgres. Sized well past a normal disconnect so
 * the common case never touches the database.
 */
export const STREAM_MAX_LENGTH = 10_000

export class EventBus {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
  ) {}

  /**
   * Append an event to a session's log.
   *
   * The sequence number comes from an atomic increment of `sessions.last_seq`,
   * which is what keeps numbering gap-free and unique even when the agent and
   * a control-plane action write concurrently. Assigning it in application
   * code — reading, adding one, writing back — would let two writers land on
   * the same number and corrupt every client's view of the session.
   */
  async append(sessionId: string, event: AgentEvent): Promise<EnvelopedEvent> {
    const parsed = agentEvent.safeParse(event)
    if (!parsed.success) {
      throw new Error(`refusing to store an invalid event: ${parsed.error.message}`)
    }

    // Before the sequence number is claimed: an event Postgres cannot store
    // would otherwise consume a number and leave a hole, and a client resuming
    // across that hole waits forever for an event that will never arrive.
    const storable = stripNullBytes(parsed.data)

    const [updated] = await this.db
      .update(sessions)
      .set({ lastSeq: sql`${sessions.lastSeq} + 1`, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .returning({ seq: sessions.lastSeq })

    if (!updated) {
      throw new Error(`no such session: ${sessionId}`)
    }

    const enveloped: EnvelopedEvent = {
      seq: updated.seq,
      sessionId,
      ts: Date.now(),
      event: storable,
    }

    // Postgres first: it is the durable record. A crash between here and Redis
    // costs a live delivery, which reconnecting clients recover from the
    // database. The reverse order could deliver an event that was never
    // stored, which nothing can recover from.
    await this.db.insert(messages).values({
      sessionId,
      seq: enveloped.seq,
      event: enveloped.event,
    })

    await this.redis
      .multi()
      .xadd(
        streamKey(sessionId),
        'MAXLEN',
        '~',
        String(STREAM_MAX_LENGTH),
        '*',
        'payload',
        JSON.stringify(enveloped),
      )
      .publish(channelKey(sessionId), JSON.stringify(enveloped))
      .exec()

    return enveloped
  }

  /**
   * Every event after `afterSeq`, oldest first.
   *
   * Reads from Postgres rather than Redis: the stream is capped, and a client
   * that was away long enough would silently get a partial history — the one
   * failure mode this whole design exists to prevent.
   */
  async replay(sessionId: string, afterSeq = 0): Promise<EnvelopedEvent[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), gt(messages.seq, afterSeq)))
      .orderBy(asc(messages.seq))

    return rows.map((row) => ({
      seq: row.seq,
      sessionId: row.sessionId,
      ts: row.createdAt.getTime(),
      event: row.event as AgentEvent,
    }))
  }

  /** The highest sequence number assigned so far, or 0 for a new session. */
  async lastSeq(sessionId: string): Promise<number> {
    const [session] = await this.db
      .select({ lastSeq: sessions.lastSeq })
      .from(sessions)
      .where(eq(sessions.id, sessionId))

    return session?.lastSeq ?? 0
  }

  /**
   * Subscribe to live events for a session.
   *
   * Takes its own Redis connection: a client in subscribe mode cannot issue
   * other commands, so sharing the main one would deadlock the server.
   */
  async subscribe(
    sessionId: string,
    onEvent: (event: EnvelopedEvent) => void,
  ): Promise<() => Promise<void>> {
    const subscriber = this.redis.duplicate()
    await subscriber.subscribe(channelKey(sessionId))

    subscriber.on('message', (_channel, payload) => {
      try {
        onEvent(JSON.parse(payload) as EnvelopedEvent)
      } catch {
        // A malformed payload means someone else is writing to our channel.
        // Dropping it is better than tearing down a live session.
      }
    })

    return async () => {
      await subscriber.unsubscribe(channelKey(sessionId))
      subscriber.disconnect()
    }
  }

  /** Delete a session's Redis stream. The Postgres record is kept. */
  async clearStream(sessionId: string): Promise<void> {
    await this.redis.del(streamKey(sessionId))
  }
}
