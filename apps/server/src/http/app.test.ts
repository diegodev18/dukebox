import { pairingCodes } from '@dukebox/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { issuePairingCode } from '../auth/pairing.js'
import { createApp } from './app.js'

const app = createApp({ db, serverName: 'dukebox-test' })
const ENDPOINT = { host: 'dukebox-vps.tail1234.ts.net', port: 7777 }

afterAll(() => close())
beforeAll(prepareDatabase)
beforeEach(resetDatabase)

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

  return (await response.json()) as { deviceId: string; deviceToken: string }
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
    expect(await response.json()).toMatchObject({ deviceId })
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
    const { deviceToken, deviceId } = await pair()
    await authed(`/api/devices/${deviceId}`, deviceToken, { method: 'DELETE' })

    expect((await authed('/api/me', deviceToken)).status).toBe(401)
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
  it('lists paired devices', async () => {
    const { deviceToken } = await pair('First')
    await pair('Second')

    const response = await authed('/api/devices', deviceToken)
    const body = (await response.json()) as { devices: { name: string }[] }

    expect(body.devices.map((device) => device.name)).toEqual(['Second', 'First'])
  })

  it('never returns a token hash in the device list', async () => {
    const { deviceToken } = await pair()
    const body = await (await authed('/api/devices', deviceToken)).text()

    expect(body).not.toContain('tokenHash')
    expect(body).not.toContain('token_hash')
  })

  it('revokes another device without affecting the caller', async () => {
    const first = await pair('First')
    const second = await pair('Second')

    const response = await authed(`/api/devices/${second.deviceId}`, first.deviceToken, {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect((await authed('/api/me', first.deviceToken)).status).toBe(200)
    expect((await authed('/api/me', second.deviceToken)).status).toBe(401)
  })

  it('lets a device revoke itself, which is how signing out works', async () => {
    const { deviceToken, deviceId } = await pair()

    const response = await authed(`/api/devices/${deviceId}`, deviceToken, { method: 'DELETE' })
    expect(response.status).toBe(200)
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
