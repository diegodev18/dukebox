import { z } from 'zod'

/**
 * Device pairing.
 *
 * The desktop app ships knowing nothing about any server. It learns where to
 * connect from a link the VPS prints:
 *
 *   dukebox://pair?host=dukebox-vps&port=7777&code=XXXX-XXXX
 *
 * The app redeems the code once for a long-lived device token, which it stores
 * in the OS keychain. Tailscale already authenticates the network; the device
 * token identifies which app is talking and can be revoked on its own.
 */

export const PAIRING_URL_SCHEME = 'dukebox'
export const PAIRING_CODE_TTL_SECONDS = 15 * 60

/**
 * Pairing code format: two groups of four, Crockford base32 (no I, L, O, U —
 * they are easy to misread when retyping a code from a terminal).
 */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

export const pairingCode = z.string().regex(PAIRING_CODE_PATTERN, 'invalid pairing code format')

/** Contents of a `dukebox://pair` link. */
export const pairingPayload = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  code: pairingCode,
})

export type PairingPayload = z.infer<typeof pairingPayload>

/** Build the link the installer prints. */
export function buildPairingUrl(payload: PairingPayload): string {
  const params = new URLSearchParams({
    host: payload.host,
    port: String(payload.port),
    code: payload.code,
  })
  return `${PAIRING_URL_SCHEME}://pair?${params.toString()}`
}

/**
 * Parse a pairing link.
 *
 * Returns null rather than throwing: this parses user-pasted text, where
 * malformed input is expected and should surface as a UI message.
 */
export function parsePairingUrl(raw: string): PairingPayload | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }

  if (url.protocol !== `${PAIRING_URL_SCHEME}:`) return null

  // In `dukebox://pair?...` the "pair" segment parses as the host component.
  if (url.hostname !== 'pair') return null

  const port = Number(url.searchParams.get('port'))
  const result = pairingPayload.safeParse({
    host: url.searchParams.get('host') ?? '',
    port: Number.isFinite(port) ? port : -1,
    code: url.searchParams.get('code') ?? '',
  })

  return result.success ? result.data : null
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export const pairRedeemRequest = z.object({
  code: pairingCode,
  /** Shown in the device list so the user can tell devices apart. */
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['macos', 'windows', 'linux']),
})

export type PairRedeemRequest = z.infer<typeof pairRedeemRequest>

export const pairRedeemResponse = z.object({
  deviceId: z.string().uuid(),
  /** Bearer token for all later requests and the WebSocket handshake. */
  deviceToken: z.string().min(1),
  serverName: z.string(),
})

export type PairRedeemResponse = z.infer<typeof pairRedeemResponse>

/** A paired device, as listed in the app and by `duke device ls`. */
export const deviceSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  platform: z.enum(['macos', 'windows', 'linux']),
  createdAt: z.number().int().positive(),
  lastSeenAt: z.number().int().positive().nullable(),
})

export type DeviceSummary = z.infer<typeof deviceSummary>
