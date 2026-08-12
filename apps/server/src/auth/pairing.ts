import {
  buildPairingUrl,
  capabilitiesFor,
  PAIRING_CODE_TTL_SECONDS,
  type DeviceRole,
  type DeviceSummary,
  type PairingInvite,
  type PairRedeemRequest,
  type PairRedeemResponse,
} from '@dukebox/protocol'
import { devices, pairingCodes, type Database, type Device } from '@dukebox/db'
import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm'
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
 *
 * The first device to pair is the owner. Later codes are members unless the
 * operator runs `duke pair replace-owner` on the VPS.
 */

export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_code' | 'expired' | 'already_used' | 'owner_exists',
  ) {
    super(message)
    this.name = 'PairingError'
  }
}

export class RevokeError extends Error {
  constructor(
    message: string,
    readonly code: 'is_owner',
  ) {
    super(message)
    this.name = 'RevokeError'
  }
}

export interface IssuedPairingCode {
  id: string
  code: string
  url: string
  role: DeviceRole
  expiresAt: Date
}

export async function findActiveOwner(db: Database): Promise<Device | null> {
  const [owner] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.role, 'owner'), isNull(devices.revokedAt)))
    .orderBy(asc(devices.createdAt))
    .limit(1)

  return owner ?? null
}

async function hasLiveOwnerInvite(db: Database): Promise<boolean> {
  const [row] = await db
    .select({ id: pairingCodes.id })
    .from(pairingCodes)
    .where(
      and(
        eq(pairingCodes.role, 'owner'),
        isNull(pairingCodes.redeemedAt),
        gt(pairingCodes.expiresAt, new Date()),
      ),
    )
    .limit(1)

  return Boolean(row)
}

/**
 * Role a newly issued code should carry when the caller does not pick one.
 *
 * Empty server → owner (the installer path). Anything else → member.
 */
export async function defaultPairingRole(db: Database): Promise<DeviceRole> {
  return (await findActiveOwner(db)) ? 'member' : 'owner'
}

/**
 * Issue a pairing code and the link that carries it.
 *
 * The plaintext code is returned once, to be printed. Only its hash is stored,
 * so a database dump cannot be used to pair a new device. The role lives on
 * the row, never in the URL.
 */
export async function issuePairingCode(
  db: Database,
  endpoint: { host: string; port: number },
  role?: DeviceRole,
): Promise<IssuedPairingCode> {
  const resolved = role ?? (await defaultPairingRole(db))

  if (resolved === 'owner' && ((await findActiveOwner(db)) || (await hasLiveOwnerInvite(db)))) {
    throw new PairingError(
      'this server already has an owner; invite a member, or replace the owner from the VPS',
      'owner_exists',
    )
  }

  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SECONDS * 1000)

  const [record] = await db
    .insert(pairingCodes)
    .values({ codeHash: hashSecret(code), expiresAt, role: resolved })
    .returning()

  if (!record) throw new Error('failed to issue pairing code')

  return {
    id: record.id,
    code,
    url: buildPairingUrl({ host: endpoint.host, port: endpoint.port, code }),
    role: resolved,
    expiresAt,
  }
}

/**
 * Revoke the current owner (if any), expire unused owner codes, and issue a
 * new owner pairing link. The only way to move the owner to another machine.
 */
export async function replaceOwnerPairing(
  db: Database,
  endpoint: { host: string; port: number },
): Promise<IssuedPairingCode> {
  const owner = await findActiveOwner(db)
  if (owner) {
    await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.id, owner.id))
  }

  await db
    .update(pairingCodes)
    .set({ expiresAt: new Date() })
    .where(and(eq(pairingCodes.role, 'owner'), isNull(pairingCodes.redeemedAt)))

  return issuePairingCode(db, endpoint, 'owner')
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

  const role = asDeviceRole(record.role)

  if (role === 'owner' && (await findActiveOwner(db))) {
    throw new PairingError('this server already has an owner', 'owner_exists')
  }

  const token = generateDeviceToken()

  const [device] = await db
    .insert(devices)
    .values({
      name: request.deviceName,
      platform: request.platform,
      tokenHash: hashSecret(token),
      role,
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
    role,
  }
}

function asDeviceRole(value: string): DeviceRole {
  return value === 'owner' ? 'owner' : 'member'
}

export function deviceIsOwner(device: Device): boolean {
  return device.role === 'owner'
}

export function deviceCapabilities(device: Device) {
  return capabilitiesFor(asDeviceRole(device.role))
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
    role: asDeviceRole(row.role),
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt?.getTime() ?? null,
  }))
}

export async function listPendingInvites(db: Database): Promise<PairingInvite[]> {
  const rows = await db
    .select()
    .from(pairingCodes)
    .where(
      and(
        isNull(pairingCodes.redeemedAt),
        eq(pairingCodes.role, 'member'),
        gt(pairingCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(pairingCodes.createdAt))

  return rows.map((row) => ({
    id: row.id,
    expiresAt: row.expiresAt.getTime(),
    createdAt: row.createdAt.getTime(),
  }))
}

/** Expire an unused invite so the code can no longer be redeemed. */
export async function revokeInvite(db: Database, inviteId: string): Promise<boolean> {
  const updated = await db
    .update(pairingCodes)
    .set({ expiresAt: new Date() })
    .where(
      and(
        eq(pairingCodes.id, inviteId),
        isNull(pairingCodes.redeemedAt),
        eq(pairingCodes.role, 'member'),
      ),
    )
    .returning()

  return updated.length > 0
}

/**
 * Revoke a device.
 *
 * Marked revoked rather than deleted, so the record of what was paired — and
 * when it was cut off — survives. The owner cannot be revoked this way: that
 * would leave the server with no one who can invite, and the recovery path is
 * `duke pair replace-owner` on the VPS.
 */
export async function revokeDevice(
  db: Database,
  deviceId: string,
  options: { allowOwner?: boolean } = {},
): Promise<boolean> {
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))

  if (!device) return false

  if (device.role === 'owner' && !options.allowOwner) {
    throw new RevokeError(
      'the owner device cannot be revoked from the app; run duke pair replace-owner on the server',
      'is_owner',
    )
  }

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
