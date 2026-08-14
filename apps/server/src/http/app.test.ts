import { pairingCodes } from '@dukebox/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '@/testing/database'
import { issuePairingCode } from '@/auth/pairing'
import { createApp } from '@/http/app'
import { resetRateLimit, tooManyAttempts } from '@/http/rateLimit'

const ENDPOINT = { host: 'dukebox-vps.tail1234.ts.net', port: 7777 }
const app = createApp({ db, serverName: 'dukebox-test', pairingEndpoint: ENDPOINT })

afterAll(() => close())
beforeAll(prepareDatabase)
beforeEach(async () => {
  resetRateLimit()
  await resetDatabase()
})

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function authed(path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  })
}

/** Pair a device through the HTTP surface, as the desktop app would. */
async function pair(name = 'Diego MacBook') {
  const issued = await issuePairingCode(db, ENDPOINT)
  const response = await post('/pair/redeem', {
    code: issued.code,
    deviceName: name,
    platform: 'macos',
  })

  return (await response.json()) as { deviceId: string; deviceToken: string; role: string }
}

describe('GET /health', () => {
  it('answers without a token, since the installer checks it before pairing', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, server: 'dukebox-test' })
  })
})

describe('POST /pair/redeem', () => {
  it('returns a device token for a valid code', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    const response = await post('/pair/redeem', {
      code: issued.code,
      deviceName: 'Diego MacBook',
      platform: 'macos',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      deviceToken: expect.any(String),
      serverName: 'dukebox-test',
      role: 'owner',
    })
  })

  it('rejects a reused code with 403', async () => {
    const issued = await issuePairingCode(db, ENDPOINT)
    await post('/pair/redeem', { code: issued.code, deviceName: 'A', platform: 'macos' })

    const response = await post('/pair/redeem', {
      code: issued.code,
      deviceName: 'B',
      platform: 'linux',
    })

    // 403 rather than 404: the code was understood and refused.
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'already_used' })
  })

  it('rejects an expired code with 403', async () => {
    await db.insert(pairingCodes).values({
      codeHash: 'unused',
      expiresAt: new Date(Date.now() - 1000),
    })

    const issued = await issuePairingCode(db, ENDPOINT)
    await db
      .update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(sql`${pairingCodes.codeHash} != 'unused'`)

    const response = await post('/pair/redeem', {
      code: issued.code,
      deviceName: 'D',
      platform: 'macos',
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'expired' })
  })

  it('rejects an unknown code with 403', async () => {
    const response = await post('/pair/redeem', {
      code: 'ZZZZ-ZZZZ',
      deviceName: 'D',
      platform: 'macos',
    })

    expect(response.status).toBe(403)
  })

  it.each([
    ['a malformed code', { code: 'nope', deviceName: 'D', platform: 'macos' }],
    ['a missing device name', { code: 'A1B2-C3D4', platform: 'macos' }],
    ['an unknown platform', { code: 'A1B2-C3D4', deviceName: 'D', platform: 'bsd' }],
    ['an empty body', {}],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await post('/pair/redeem', body)).status).toBe(400)
  })

  it('rejects a body that is not JSON with 400', async () => {
    const response = await app.request('/pair/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
  })
})

describe('device authentication', () => {
  it('accepts a valid device token', async () => {
    const { deviceToken, deviceId } = await pair()
    const response = await authed('/api/me', deviceToken)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      deviceId,
      role: 'owner',
      capabilities: { manageDevices: true, manageAgents: true, deleteProjects: true },
    })
  })

  it('rejects a request with no token', async () => {
    expect((await app.request('/api/me')).status).toBe(401)
  })

  it('rejects an unknown token', async () => {
    expect((await authed('/api/me', 'not-a-real-token')).status).toBe(401)
  })

  it('rejects a token in the wrong scheme', async () => {
    const { deviceToken } = await pair()
    const response = await app.request('/api/me', {
      headers: { authorization: `Basic ${deviceToken}` },
    })

    expect(response.status).toBe(401)
  })

  it('answers a wrong token exactly as it answers a missing one', async () => {
    // Distinguishing them would tell a caller whether a guess was
    // structurally right.
    const missing = await app.request('/api/me')
    const wrong = await authed('/api/me', 'wrong-token')

    expect(wrong.status).toBe(missing.status)
    expect(await wrong.json()).toEqual(await missing.json())
  })

  it('rejects a revoked device', async () => {
    const owner = await pair('Owner')
    const member = await pair('Member')
    await authed(`/api/devices/${member.deviceId}`, owner.deviceToken, { method: 'DELETE' })

    expect((await authed('/api/me', member.deviceToken)).status).toBe(401)
  })

  it('guards every route under /api', async () => {
    // The middleware is registered by prefix, so a route added later is
    // covered by default rather than by remembering to guard it.
    for (const path of ['/api/me', '/api/devices', '/api/anything/else']) {
      expect((await app.request(path)).status).toBe(401)
    }
  })
})

describe('device management', () => {
  it('lists paired devices with roles, for the owner', async () => {
    const { deviceToken } = await pair('First')
    await pair('Second')

    const response = await authed('/api/devices', deviceToken)
    const body = (await response.json()) as { devices: { name: string; role: string }[] }

    expect(body.devices.map((device) => device.name)).toEqual(['Second', 'First'])
    expect(body.devices.map((device) => device.role)).toEqual(['member', 'owner'])
  })

  it('hides the device list from a member', async () => {
    await pair('Owner')
    const member = await pair('Member')

    const response = await authed('/api/devices', member.deviceToken)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden' })
  })

  it('never returns a token hash in the device list', async () => {
    const { deviceToken } = await pair()
    const body = await (await authed('/api/devices', deviceToken)).text()

    expect(body).not.toContain('tokenHash')
    expect(body).not.toContain('token_hash')
  })

  it('lets the owner revoke a member without affecting itself', async () => {
    const first = await pair('First')
    const second = await pair('Second')

    const response = await authed(`/api/devices/${second.deviceId}`, first.deviceToken, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect((await authed('/api/me', first.deviceToken)).status).toBe(200)
    expect((await authed('/api/me', second.deviceToken)).status).toBe(401)
  })

  it('tells the control plane which device was revoked', async () => {
    const onDeviceRevoked = vi.fn()
    const wired = createApp({
      db,
      serverName: 'dukebox-test',
      pairingEndpoint: ENDPOINT,
      onDeviceRevoked,
    })
    const owner = await pair('Owner')
    const member = await pair('Member')

    const response = await wired.request(`/api/devices/${member.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${owner.deviceToken}` },
    })

    expect(response.status).toBe(200)
    expect(onDeviceRevoked).toHaveBeenCalledWith(member.deviceId)
  })

  it('lets a member revoke itself, which is how signing out works', async () => {
    await pair('Owner')
    const member = await pair('Member')

    const response = await authed(`/api/devices/${member.deviceId}`, member.deviceToken, {
      method: 'DELETE',
    })
    expect(response.status).toBe(200)
    expect((await authed('/api/me', member.deviceToken)).status).toBe(401)
  })

  it('refuses to let the owner revoke itself over HTTP', async () => {
    const { deviceToken, deviceId } = await pair()

    const response = await authed(`/api/devices/${deviceId}`, deviceToken, { method: 'DELETE' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'is_owner' })
  })

  it('refuses to let a member revoke someone else', async () => {
    const owner = await pair('Owner')
    const member = await pair('Member')

    const response = await authed(`/api/devices/${owner.deviceId}`, member.deviceToken, {
      method: 'DELETE',
    })
    expect(response.status).toBe(403)
  })

  it('issues a member invite the owner can copy', async () => {
    const { deviceToken } = await pair()

    const response = await authed('/api/devices/invites', deviceToken, { method: 'POST' })
    const body = (await response.json()) as { url: string; expiresAt: number }

    expect(response.status).toBe(200)
    expect(body.url).toMatch(/^dukebox:\/\/pair\?/)
    expect(body.expiresAt).toBeGreaterThan(Date.now())
  })

  it('lists and revokes a pending invite', async () => {
    const { deviceToken } = await pair()
    const created = (await (
      await authed('/api/devices/invites', deviceToken, { method: 'POST' })
    ).json()) as { id: string }

    const listed = (await (await authed('/api/devices/invites', deviceToken)).json()) as {
      invites: { id: string }[]
    }
    expect(listed.invites.map((invite) => invite.id)).toEqual([created.id])

    expect(
      (await authed(`/api/devices/invites/${created.id}`, deviceToken, { method: 'DELETE' }))
        .status,
    ).toBe(200)
    expect(await (await authed('/api/devices/invites', deviceToken)).json()).toEqual({
      invites: [],
    })
  })

  it('hides invites from a member', async () => {
    await pair('Owner')
    const member = await pair('Member')

    expect(
      (await authed('/api/devices/invites', member.deviceToken, { method: 'POST' })).status,
    ).toBe(403)
  })

  it('returns 404 for a device that is not active', async () => {
    const { deviceToken } = await pair()
    const response = await authed(
      '/api/devices/00000000-0000-4000-8000-000000000000',
      deviceToken,
      { method: 'DELETE' },
    )

    expect(response.status).toBe(404)
  })
})

describe('POST /pair/redeem rate limit', () => {
  it('returns 429 after too many attempts from the same client', async () => {
    for (let i = 0; i < 30; i++) tooManyAttempts('redeem:local')

    const response = await post('/pair/redeem', {
      code: 'AAAA-BBBB',
      deviceName: 'Flood',
      platform: 'macos',
    })

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('counts through the HTTP surface, not only a pre-filled bucket', async () => {
    const body = { code: 'AAAA-BBBB', deviceName: 'Flood', platform: 'macos' }
    for (let i = 0; i < 30; i++) {
      expect((await post('/pair/redeem', body)).status).toBe(403)
    }

    const response = await post('/pair/redeem', body)
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: 'rate_limited' })
  })

  it('keeps distinct forwarded-for hops in separate buckets', async () => {
    const body = { code: 'AAAA-BBBB', deviceName: 'Flood', platform: 'macos' }
    const first = { 'x-forwarded-for': '10.0.0.1' }
    const second = { 'x-forwarded-for': '10.0.0.2' }

    for (let i = 0; i < 30; i++) {
      expect(
        (
          await app.request('/pair/redeem', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...first },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(403)
    }

    expect(
      (
        await app.request('/pair/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...first },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(429)

    expect(
      (
        await app.request('/pair/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...second },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403)
  })
})
