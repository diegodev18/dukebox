import {
  buildPairingUrl,
  PAIRING_CODE_TTL_SECONDS,
  type DeviceSummary,
  type PairRedeemRequest,
  type PairRedeemResponse,
} from '@dukebox/protocol'
import { devices, pairingCodes, type Database } from '@dukebox/db'
import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import {
  generateDeviceToken,
  generatePairingCode,
  hashSecret,
  normalizePairingCode,
} from './tokens.js'

/**
 * Device pairing.
 *
 * A code is issued on the server, carried to the app by the user, and redeemed
 * once for a long-lived device token. Tailscale already authenticates the
 * network; the token identifies which app is talking, so a single device can
 * be revoked without disturbing the others.
 */

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_code' | 'expired' | 'already_used',
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

export interface IssuedPairingCode {
  code: string
  url: string
  expiresAt: Date
}

/**
 * Issue a pairing code and the link that carries it.
 *
 * The plaintext code is returned once, to be printed. Only its hash is stored,
 * so a database dump cannot be used to pair a new device.
 */
export async function issuePairingCode(
  db: Database,
  endpoint: { host: string; port: number },
): Promise<IssuedPairingCode> {
  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000)

  await db.insert(pairingCodes).values({ codeHash: hashSecret(code), expiresAt })

  return {
    code,
    url: buildPairingUrl({ host: endpoint.host, port: endpoint.port, code }),
    expiresAt,
  }
}

/**
 * Redeem a code for a device token.
 *
 * Failures are deliberately specific — expired, already used, unknown — and
 * that is safe here: reaching this endpoint at all requires being on the
 * tailnet, and a caller who is already trusted that far is better served by an
 * accurate error than by a uniform one they cannot act on.
 */
export async function redeemPairingCode(
  db: Database,
  request: PairRedeemRequest,
  serverName: string,
): Promise<PairRedeemResponse> {
  const codeHash = hashSecret(normalizePairingCode(request.code))

  const [record] = await db.select().from(pairingCodes).where(eq(pairingCodes.codeHash, codeHash))

  if (!record) {
    throw new PairingError('that pairing code does not exist', 'invalid_code')
  }

  // Checked before expiry: a code someone already used is a more useful thing
  // to report than the fact that it has since also expired.
  if (record.redeemedAt) {
    throw new PairingError('that pairing code has already been used', 'already_used')
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw new PairingError('that pairing code has expired', 'expired')
  }

  const token = generateDeviceToken()

  const [device] = await db
    .insert(devices)
    .values({
      name: request.deviceName,
      platform: request.platform,
      tokenHash: hashSecret(token),
    })
    .returning()

  if (!device) throw new Error('failed to create device')

  // Marked used only after the device exists, so a failure here leaves the
  // code redeemable rather than burning it with nothing to show for it.
  await db
    .update(pairingCodes)
    .set({ redeemedAt: new Date(), redeemedByDeviceId: device.id })
    .where(eq(pairingCodes.id, record.id))

  return {
    deviceId: device.id,
    // The only time the plaintext token exists. The app stores it in the OS
    // keychain; the server keeps just the hash.
    deviceToken: token,
    serverName,
  }
}

/** Resolve a device token to its device, or null. Updates last-seen. */
export async function authenticateDevice(db: Database, token: string) {
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.tokenHash, hashSecret(token)), isNull(devices.revokedAt)))

  if (!device) return null

  // Lets the user see which devices are actually in use before revoking one.
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id))

  return device
}

export async function listDevices(db: Database): Promise<DeviceSummary[]> {
  const rows = await db
    .select()
    .from(devices)
    .where(isNull(devices.revokedAt))
    .orderBy(desc(devices.createdAt))

  return rows.map((row) => ({
    id: row.id,
    platform: row.platform as DeviceSummary['platform'],
    name: row.name,
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt?.getTime() ?? null,
  }))
}

/**
 * Revoke a device.
 *
 * Marked revoked rather than deleted, so the record of what was paired — and
 * when it was cut off — survives.
 */
export async function revokeDevice(db: Database, deviceId: string): Promise<boolean> {
  const revoked = await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
    .returning()

  return revoked.length > 0
}

/**
 * Delete pairing codes that expired some time ago.
 *
 * Redeemed codes are kept: their hash is what makes a replay recognizable as
 * already-used rather than unknown.
 */
export async function pruneExpiredCodes(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(pairingCodes)
    .where(and(isNull(pairingCodes.redeemedAt), lt(pairingCodes.expiresAt, olderThan)))
    .returning()

  return deleted.length
}
