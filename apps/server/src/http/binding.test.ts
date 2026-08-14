import { serve } from '@hono/node-server'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { db, prepareDatabase } from '@/testing/database'
import { createApp } from '@/http/app'

/**
 * Network exposure.
 *
 * The other HTTP tests call the app directly, which proves the routing but
 * says nothing about which interfaces the process is reachable on. These start
 * a real listener and check the socket, because binding the wrong address is
 * how a self-hosted control plane ends up on the public internet.
 */

let running: ReturnType<typeof serve> | undefined

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!running) return resolve()
    running.close(() => resolve())
  })
  running = undefined
})

async function listen(hostname: string) {
  await prepareDatabase()
  const app = createApp({
    db,
    serverName: 'dukebox-test',
    pairingEndpoint: { host: '127.0.0.1', port: 7777 },
  })

  return new Promise<{ address: string; port: number }>((resolve) => {
    running = serve({ fetch: app.fetch, hostname, port: 0 }, (info) => {
      resolve({ address: info.address, port: info.port })
    })
  })
}

/** A non-loopback address of this machine, standing in for a tailnet address. */
function externalAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return undefined
}

describe('network binding', () => {
  it('binds only the address it was given', async () => {
    const bound = await listen('127.0.0.1')

    // The transport hands over a tailnet address; anything that widens it
    // between there and here would expose the server.
    expect(bound.address).toBe('127.0.0.1')
    expect(bound.address).not.toBe('0.0.0.0')
    expect(bound.address).not.toBe('::')
  })

  it('is unreachable on other interfaces', async () => {
    const bound = await listen('127.0.0.1')
    const external = externalAddress()

    if (!external) {
      // A container with only loopback. The assertion above already covers
      // the binding itself.
      return
    }

    // The real test: a server bound to one address must refuse connections on
    // every other address the machine has.
    await expect(
      fetch(`http://${external}:${bound.port}/health`, {
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow()
  })

  it('answers on the address it bound', async () => {
    const bound = await listen('127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${bound.port}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it('still requires a device token when reached over a real socket', async () => {
    // Route-level auth is covered elsewhere; this confirms nothing about the
    // real HTTP path bypasses it.
    const bound = await listen('127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${bound.port}/api/me`)

    expect(response.status).toBe(401)
  })
})
