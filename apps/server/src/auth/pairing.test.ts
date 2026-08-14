import { devices, pairingCodes, type Database } from '@dukebox/db'
import { parsePairingUrl } from '@dukebox/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import {
  authenticateDevice,
  defaultPairingRole,
  findActiveOwner,
  issuePairingCode,
  listDevices,
  listPendingInvites,
  PairingError,
  pruneExpiredCodes,
  redeemPairingCode,
  replaceOwnerPairing,
  revokeDevice,
  revokeInvite,
  RevokeError,
} from './pairing.js'
import { hashSecret } from './tokens.js'

const ENDPOINT = { host: 'dukebox-vps.tail1234.ts.net', port: 7777 }

afterAll(() => close())
beforeAll(prepareDatabase)
beforeEach(resetDatabase)

/** Issue a code and redeem it, the ordinary path. */
async function pairDevice(database: Database = db, name = 'Diego MacBook') {
  const issued = await issuePairingCode(database, ENDPOINT)
  const response = await redeemPairingCode(
    database,
    { code: issued.code, deviceName: name, platform: 'macos' },
    'dukebox-vps',
  )
  return { issued, response }
}

describe('issuePairingCode', () => {
  it('returns a link the desktop app can parse', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    const parsed = parsePairingUrl(issued.url)

    expect(parsed).toEqual({ host: ENDPOINT.host, port: ENDPOINT.port, code: issued.code })
  })

  it('stores only the hash, never the code', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    const [record] = await db.select().from(pairingCodes)

    // A database dump must not be enough to pair a new device.
    expect(record?.codeHash).toBe(hashSecret(issued.code))
    expect(JSON.stringify(record)).not.toContain(issued.code)
  })

  it('expires in the future', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('issues distinct codes', async () => {
    await pairDevice()
    const first = await issuePairingCode(db, ENDPOINT)
    const second = await issuePairingCode(db, ENDPOINT)
    expect(first.code).not.toBe(second.code)
    expect(first.role).toBe('member')
    expect(second.role).toBe('member')
  })

  it('issues an owner code when the server has no owner', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    expect(issued.role).toBe('owner')
    expect(await defaultPairingRole(db)).toBe('owner')
  })

  it('issues a member code once an owner exists', async () => {
    await pairDevice()
    const issued = await issuePairingCode(db, ENDPOINT)
    expect(issued.role).toBe('member')
  })

  it('refuses a second owner code while one is active', async () => {
    await pairDevice()
    await expect(issuePairingCode(db, ENDPOINT, 'owner')).rejects.toMatchObject({
      code: 'owner_exists',
    })
  })

  it('refuses a second owner code while an unused owner invite is still valid', async () => {
    await issuePairingCode(db, ENDPOINT, 'owner')
    await expect(issuePairingCode(db, ENDPOINT, 'owner')).rejects.toMatchObject({
      code: 'owner_exists',
    })
  })

  it('refuses a default-role code while an unused owner invite is still valid', async () => {
    await issuePairingCode(db, ENDPOINT, 'owner')
    await expect(issuePairingCode(db, ENDPOINT)).rejects.toMatchObject({
      code: 'owner_exists',
    })
  })

  it('issues an owner code after a previous owner invite expires', async () => {
    await db.insert(pairingCodes).values({
      codeHash: hashSecret('AAAA-BBBB'),
      role: 'owner',
      expiresAt: new Date(Date.now() - 1000),
    })

    const issued = await issuePairingCode(db, ENDPOINT, 'owner')
    expect(issued.role).toBe('owner')
  })
})

describe('redeemPairingCode', () => {
  it('returns a device token', async () => {
    const { response } = await pairDevice()

    expect(response.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(response.deviceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.serverName).toBe('dukebox-vps')
    expect(response.role).toBe('owner')
  })

  it('makes the first device the owner and later ones members', async () => {
    const first = await pairDevice(db, 'First')
    const second = await pairDevice(db, 'Second')

    expect(first.response.role).toBe('owner')
    expect(second.response.role).toBe('member')
    expect((await findActiveOwner(db))?.id).toBe(first.response.deviceId)
  })

  it('stores only the token hash', async () => {
    const { response } = await pairDevice()
    const [device] = await db.select().from(devices)

    expect(device?.tokenHash).toBe(hashSecret(response.deviceToken))
    expect(JSON.stringify(device)).not.toContain(response.deviceToken)
  })

  it('records the device name and platform for the device list', async () => {
    await pairDevice(db, 'Work laptop')
    const [device] = await db.select().from(devices)

    expect(device?.name).toBe('Work laptop')
    expect(device?.platform).toBe('macos')
  })

  it('accepts a code retyped in lowercase without its separator', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    const typed = issued.code.toLowerCase().replace('-', '')

    await expect(
      redeemPairingCode(db, { code: typed, deviceName: 'D', platform: 'macos' }, 'srv'),
    ).resolves.toMatchObject({ deviceToken: expect.any(String) })
  })

  it('rejects a code that was already used', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    await redeemPairingCode(db, { code: issued.code, deviceName: 'A', platform: 'macos' }, 'srv')

    // Single use is the whole point: a code seen over someone's shoulder must
    // be worthless once the intended device has paired.
    await expect(
      redeemPairingCode(db, { code: issued.code, deviceName: 'B', platform: 'linux' }, 'srv'),
    ).rejects.toMatchObject({ code: 'already_used' })
  })

  it('creates no second device when a code is replayed', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    await redeemPairingCode(db, { code: issued.code, deviceName: 'A', platform: 'macos' }, 'srv')

    await redeemPairingCode(
      db,
      { code: issued.code, deviceName: 'B', platform: 'linux' },
      'srv',
    ).catch(() => undefined)

    expect(await db.select().from(devices)).toHaveLength(1)
  })

  it('rejects an expired code', async () => {
    await db.insert(pairingCodes).values({
      codeHash: hashSecret('AAAA-BBBB'),
      expiresAt: new Date(Date.now() - 1000),
    })

    await expect(
      redeemPairingCode(db, { code: 'AAAA-BBBB', deviceName: 'D', platform: 'macos' }, 'srv'),
    ).rejects.toMatchObject({ code: 'expired' })
  })

  it('rejects a code that never existed', async () => {
    await expect(
      redeemPairingCode(db, { code: 'ZZZZ-ZZZZ', deviceName: 'D', platform: 'macos' }, 'srv'),
    ).rejects.toMatchObject({ code: 'invalid_code' })
  })

  it('reports being already used ahead of being expired', async () => {
    // A used code is the more useful thing to tell someone, even once it has
    // also aged out.
    await db.insert(pairingCodes).values({
      codeHash: hashSecret('AAAA-BBBB'),
      expiresAt: new Date(Date.now() - 1000),
      redeemedAt: new Date(Date.now() - 2000),
    })

    await expect(
      redeemPairingCode(db, { code: 'AAAA-BBBB', deviceName: 'D', platform: 'macos' }, 'srv'),
    ).rejects.toMatchObject({ code: 'already_used' })
  })

  it('throws PairingError, which the route maps to a status code', async () => {
    await expect(
      redeemPairingCode(db, { code: 'ZZZZ-ZZZZ', deviceName: 'D', platform: 'macos' }, 'srv'),
    ).rejects.toBeInstanceOf(PairingError)
  })

  it('rejects an owner code if an owner has appeared since it was issued', async () => {
    await pairDevice()
    await db.insert(pairingCodes).values({
      codeHash: hashSecret('AAAA-BBBB'),
      role: 'owner',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(
      redeemPairingCode(db, { code: 'AAAA-BBBB', deviceName: 'Late', platform: 'linux' }, 'srv'),
    ).rejects.toMatchObject({ code: 'owner_exists' })
  })
})

describe('authenticateDevice', () => {
  it('resolves a valid token to its device', async () => {
    const { response } = await pairDevice()
    const device = await authenticateDevice(db, response.deviceToken)

    expect(device?.id).toBe(response.deviceId)
  })

  it('rejects an unknown token', async () => {
    expect(await authenticateDevice(db, 'not-a-real-token')).toBeNull()
  })

  it('rejects a revoked device', async () => {
    const owner = await pairDevice(db, 'Owner')
    const member = await pairDevice(db, 'Member')
    await revokeDevice(db, member.response.deviceId)

    expect(await authenticateDevice(db, member.response.deviceToken)).toBeNull()
    expect(await authenticateDevice(db, owner.response.deviceToken)).not.toBeNull()
  })

  it('records last-seen, so unused devices are identifiable', async () => {
    const { response } = await pairDevice()
    await authenticateDevice(db, response.deviceToken)

    const [device] = await db.select().from(devices).where(eq(devices.id, response.deviceId))
    expect(device?.lastSeenAt).not.toBeNull()
  })
})

describe('device management', () => {
  it('lists paired devices newest first, with roles', async () => {
    await pairDevice(db, 'First')
    await pairDevice(db, 'Second')

    const listed = await listDevices(db)
    expect(listed.map((device) => device.name)).toEqual(['Second', 'First'])
    expect(listed.map((device) => device.role)).toEqual(['member', 'owner'])
  })

  it('hides revoked devices', async () => {
    await pairDevice(db, 'Owner')
    const member = await pairDevice(db, 'Member')
    await revokeDevice(db, member.response.deviceId)

    expect(await listDevices(db)).toHaveLength(1)
  })

  it('keeps a revoked device on record rather than deleting it', async () => {
    await pairDevice(db, 'Owner')
    const member = await pairDevice(db, 'Member')
    await revokeDevice(db, member.response.deviceId)

    // What was paired, and when it was cut off, is worth keeping.
    const [device] = await db.select().from(devices).where(eq(devices.id, member.response.deviceId))
    expect(device?.revokedAt).not.toBeNull()
  })

  it('revokes one device without affecting the others', async () => {
    const first = await pairDevice(db, 'First')
    const second = await pairDevice(db, 'Second')

    await revokeDevice(db, second.response.deviceId)

    expect(await authenticateDevice(db, first.response.deviceToken)).not.toBeNull()
    expect(await authenticateDevice(db, second.response.deviceToken)).toBeNull()
  })

  it('refuses to revoke the owner without an explicit override', async () => {
    const { response } = await pairDevice()

    await expect(revokeDevice(db, response.deviceId)).rejects.toBeInstanceOf(RevokeError)
    expect(await authenticateDevice(db, response.deviceToken)).not.toBeNull()
  })

  it('revokes the owner when replace-owner asks it to', async () => {
    const { response } = await pairDevice()
    expect(await revokeDevice(db, response.deviceId, { allowOwner: true })).toBe(true)
    expect(await authenticateDevice(db, response.deviceToken)).toBeNull()
  })

  it('reports revoking an unknown device as no change', async () => {
    expect(await revokeDevice(db, '00000000-0000-4000-8000-000000000000')).toBe(false)
  })

  it('reports revoking twice as no change the second time', async () => {
    await pairDevice(db, 'Owner')
    const member = await pairDevice(db, 'Member')

    expect(await revokeDevice(db, member.response.deviceId)).toBe(true)
    expect(await revokeDevice(db, member.response.deviceId)).toBe(false)
  })
})

describe('replaceOwnerPairing', () => {
  it('revokes the current owner and issues a new owner link', async () => {
    const previous = await pairDevice(db, 'Old laptop')
    await pairDevice(db, 'Member')

    const issued = await replaceOwnerPairing(db, ENDPOINT)
    expect(issued.role).toBe('owner')
    expect(await authenticateDevice(db, previous.response.deviceToken)).toBeNull()

    const next = await redeemPairingCode(
      db,
      { code: issued.code, deviceName: 'New laptop', platform: 'linux' },
      'dukebox-vps',
    )
    expect(next.role).toBe('owner')
    expect((await findActiveOwner(db))?.id).toBe(next.deviceId)
  })

  it('expires unused owner codes so a leftover link cannot race', async () => {
    const leftover = await issuePairingCode(db, ENDPOINT, 'owner')
    const replacement = await replaceOwnerPairing(db, ENDPOINT)

    await expect(
      redeemPairingCode(db, { code: leftover.code, deviceName: 'Late', platform: 'macos' }, 'srv'),
    ).rejects.toMatchObject({ code: 'expired' })

    await expect(
      redeemPairingCode(
        db,
        { code: replacement.code, deviceName: 'New', platform: 'macos' },
        'srv',
      ),
    ).resolves.toMatchObject({ role: 'owner' })
  })

  it('works when there is no owner yet', async () => {
    const issued = await replaceOwnerPairing(db, ENDPOINT)
    expect(issued.role).toBe('owner')
  })
})

describe('invites', () => {
  it('lists unused member codes that have not expired', async () => {
    await pairDevice()
    const issued = await issuePairingCode(db, ENDPOINT)
    const pending = await listPendingInvites(db)

    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(issued.id)
  })

  it('drops an invite from the list once it is revoked', async () => {
    await pairDevice()
    const issued = await issuePairingCode(db, ENDPOINT)
    expect(await revokeInvite(db, issued.id)).toBe(true)
    expect(await listPendingInvites(db)).toHaveLength(0)
  })
})

describe('pruneExpiredCodes', () => {
  it('deletes codes that expired before the cutoff', async () => {
    await db.insert(pairingCodes).values({
      codeHash: hashSecret('OLD1-OLD1'),
      expiresAt: new Date(Date.now() - 86_400_000),
    })

    expect(await pruneExpiredCodes(db, new Date())).toBe(1)
    expect(await db.select().from(pairingCodes)).toHaveLength(0)
  })

  it('keeps codes that are still valid', async () => {
    await issuePairingCode(db, ENDPOINT)

    expect(await pruneExpiredCodes(db, new Date())).toBe(0)
    expect(await db.select().from(pairingCodes)).toHaveLength(1)
  })

  it('keeps redeemed codes, so a replay stays recognizable as already-used', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    await redeemPairingCode(db, { code: issued.code, deviceName: 'D', platform: 'macos' }, 'srv')

    await pruneExpiredCodes(db, new Date(Date.now() + 86_400_000))

    expect(await db.select().from(pairingCodes)).toHaveLength(1)
  })
})
