/**
 * Soft in-memory rate limit.
 *
 * Pairing is already gated by Tailscale and a single-use code. This just
 * slows down a caller who is guessing codes from inside the tailnet.
 */

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 30

const attempts = new Map<string, number[]>()

export function tooManyAttempts(key: string, now = Date.now()): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= MAX_ATTEMPTS) {
    attempts.set(key, recent)
    return true
  }
  recent.push(now)
  attempts.set(key, recent)
  return false
}

export function resetRateLimit(): void {
  attempts.clear()
}

export function clientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local'
  )
}
