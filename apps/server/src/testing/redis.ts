import Redis from 'ioredis'

const url = process.env.DUKEBOX_REDIS_URL
if (!url) throw new Error('DUKEBOX_REDIS_URL is required; run via docker/verify.sh')

export const redis = new Redis(url, {
  // Fail fast in tests rather than retrying against a Redis that is not there.
  maxRetriesPerRequest: 2,
})

let closed = false

/** Close the connection. Idempotent: every test file registers it in afterAll. */
export async function closeRedis(): Promise<void> {
  if (closed) return
  closed = true
  redis.disconnect()
}
