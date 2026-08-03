import { pairRedeemRequest, type DeviceSummary } from '@dukebox/protocol'
import type { Database, Device } from '@dukebox/db'
import { Hono } from 'hono'
import {
  authenticateDevice,
  listDevices,
  PairingError,
  redeemPairingCode,
  revokeDevice,
} from '../auth/pairing.js'
import type { EventBus } from '../events/bus.js'
import type { GitHubClient } from '../github/client.js'
import type { SessionManager } from '../sessions/manager.js'
import { projectRoutes } from './projects.js'
import { sessionRoutes } from './sessions.js'

/**
 * The control plane's HTTP surface.
 *
 * Everything except pairing requires a device token. Tailscale already
 * restricts who can reach this at all; the token is what identifies which
 * paired app is calling, so one can be revoked without disturbing the rest.
 */

export interface AppContext {
  db: Database
  serverName: string
  /**
   * Project and session routes, mounted when the server has what they need.
   *
   * Optional so tests covering pairing and auth can build an app without a
   * Docker daemon or a GitHub login.
   */
  features?: {
    github: GitHubClient
    bus: EventBus
    sessions: SessionManager
  }
}

type Variables = { device: Device }

export function createApp(context: AppContext) {
  const app = new Hono<{ Variables: Variables }>()

  /**
   * Liveness check.
   *
   * Unauthenticated on purpose: it is what the installer and systemd use to
   * tell "still starting" from "failed", before any device exists to
   * authenticate as. It reveals nothing beyond the fact that a server is here,
   * which anyone who reached the tailnet already knows.
   */
  app.get('/health', (c) => c.json({ ok: true, server: context.serverName }))

  /**
   * Redeem a pairing code for a device token.
   *
   * The one unauthenticated write. Its protection is the code itself: single
   * use, short lived, and only reachable from inside the tailnet.
   */
  app.post('/pair/redeem', async (c) => {
    const body = await c.req.json().catch(() => null)
    const parsed = pairRedeemRequest.safeParse(body)

    if (!parsed.success) {
      return c.json({ error: 'invalid_request', message: parsed.error.message }, 400)
    }

    try {
      const response = await redeemPairingCode(context.db, parsed.data, context.serverName)
      return c.json(response)
    } catch (error) {
      if (error instanceof PairingError) {
        // 403 rather than 404: the code was understood and refused. A 404
        // would suggest the endpoint itself was wrong.
        return c.json({ error: error.code, message: error.message }, 403)
      }
      throw error
    }
  })

  /**
   * Require a valid device token from here on.
   *
   * Registered before the routes it guards, so adding a route below cannot
   * accidentally leave it unauthenticated.
   */
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined

    if (!token) {
      return c.json({ error: 'unauthorized', message: 'missing device token' }, 401)
    }

    const device = await authenticateDevice(context.db, token)
    if (!device) {
      // Deliberately identical to the missing-token response: distinguishing
      // "no token" from "wrong token" tells a caller whether a guess was
      // structurally right.
      return c.json({ error: 'unauthorized', message: 'missing device token' }, 401)
    }

    c.set('device', device)
    await next()
  })

  /** The calling device, for an app to confirm what it is authenticated as. */
  app.get('/api/me', (c) => {
    const device = c.get('device')
    return c.json({ deviceId: device.id, deviceName: device.name })
  })

  app.get('/api/devices', async (c) => {
    const listed: DeviceSummary[] = await listDevices(context.db)
    return c.json({ devices: listed })
  })

  app.delete('/api/devices/:id', async (c) => {
    const id = c.req.param('id')

    // A device revoking itself is allowed: it is how "sign out on this
    // machine" works.
    const revoked = await revokeDevice(context.db, id)
    if (!revoked) {
      return c.json({ error: 'not_found', message: 'no such active device' }, 404)
    }

    return c.json({ revoked: true })
  })

  /**
   * Turn an unhandled failure into a structured error.
   *
   * Without this, anything a route did not anticipate — GitHub returning an
   * unexpected shape, the daemon refusing a request — reaches the client as
   * "Internal Server Error" in plain text, which a JSON client cannot parse
   * and a person cannot act on.
   */
  app.onError((error, c) => {
    console.error('request failed:', error)

    return c.json(
      {
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'something went wrong',
      },
      500,
    )
  })

  // Mounted under /api, so the auth middleware above already covers them.
  if (context.features) {
    app.route('/api', projectRoutes({ db: context.db, github: context.features.github }))
    app.route(
      '/api',
      sessionRoutes({
        db: context.db,
        bus: context.features.bus,
        sessions: context.features.sessions,
      }),
    )
  }

  return app
}

export type App = ReturnType<typeof createApp>
