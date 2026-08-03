import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PAIRING_CODE_ALPHABET } from '@dukebox/protocol'

/**
 * Secret generation and comparison.
 *
 * Two rules hold throughout: secrets are generated from a cryptographic RNG,
 * and only their hashes are stored. A database dump must not be enough to
 * impersonate a device or redeem a pairing code.
 */

/**
 * Bytes of entropy in a device token.
 *
 * These are long-lived and grant full access to the control plane, so they are
 * sized to be infeasible to guess rather than to be typed by a human.
 */
const DEVICE_TOKEN_BYTES = 32

/**
 * Generate a pairing code.
 *
 * Eight characters of Crockford base32 — about 40 bits — which is weak for a
 * standing secret but appropriate here: a code is single-use, expires in
 * fifteen minutes, and only exists on a tailnet the caller has already been
 * authenticated onto. It is short because someone has to read it off a
 * terminal and type it into an app.
 */
export function generatePairingCode(): string {
  const alphabet = PAIRING_CODE_ALPHABET
  const bytes = randomBytes(8)

  // Rejection-free mapping is unnecessary here: the alphabet is 32 characters
  // and a byte is 256 values, so the modulo is exactly uniform.
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length])

  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

/** Generate a device token: URL-safe, high entropy, never displayed to a human. */
export function generateDeviceToken(): string {
  return randomBytes(DEVICE_TOKEN_BYTES).toString('base64url')
}

/**
 * Hash a secret for storage.
 *
 * Plain SHA-256 rather than a password hash: these are high-entropy random
 * values, not passwords. There is no dictionary to attack, so the slow hashing
 * that protects human-chosen secrets would only add latency to every request.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Compare two hashes without leaking how much of them matched.
 *
 * A byte-by-byte comparison returns faster the earlier it finds a difference,
 * which is enough to recover a secret one character at a time.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal; compare lengths first and keep the result constant-time
  // for the case that matters.
  if (left.length !== right.length) return false

  return timingSafeEqual(left, right)
}

/**
 * Normalize a pairing code as typed by a human.
 *
 * Users retype these from a terminal, so lowercase input and a missing
 * separator are expected rather than errors.
 */
export function normalizePairingCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, '')
  if (cleaned.length !== 8) return input.trim().toUpperCase()

  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}
