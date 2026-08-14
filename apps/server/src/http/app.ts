import { pairRedeemRequest, type DeviceRole, type DeviceSummary } from '@dukebox/protocol'
import type { Database, Device } from '@dukebox/db'
import { Hono } from 'hono'
import {
  authenticateDevice,
  deviceCapabilities,
  deviceIsOwner,
  issuePairingCode,
  listDevices,
  listPendingInvites,
  PairingError,
  redeemPairingCode,
  revokeDevice,
  revokeInvite,
  RevokeError,
} from '@/auth/pairing'
import type { EventBus } from '@/events/bus'
import type { GitHubClient } from '@/github/client'
import type { SecretStore } from '@/secrets/store'
import type { GrokDeviceLogin } from '@/grok/login'
import type { SessionManager } from '@/sessions/manager'
import { OWNER_FORBIDDEN, requireOwner, type AuthedVariables } from '@/http/auth'
import { clientKey, tooManyAttempts } from '@/http/rateLimit'
import { environmentRoutes } from '@/http/environments'
import { projectRoutes } from '@/http/projects'
import { opencodeRoutes } from '@/http/opencode'
import { secretRoutes } from '@/http/secrets'
import { sessionRoutes } from '@/http/sessions'

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
   * Host and port written into invite links, matching what `duke pair new`
   * advertises. Tests pass a fixed endpoint; production uses the tailnet name.
   */
  pairingEndpoint: { host: string; port: number }
  /** Drop live WebSockets for a device that was just revoked. */
  onDeviceRevoked?: (deviceId: string) => void
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
    secrets: SecretStore
    grokLogin?: GrokDeviceLogin
  }
}

export function createApp(context: AppContext) {
  const app = new Hono<{ Variables: AuthedVariables }>()

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
    if (tooManyAttempts(`redeem:${clientKey(c)}`)) {
      return c.json(
        { error: 'rate_limited', message: 'too many pairing attempts; try again shortly' },
        429,
      )
    }

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
    const role = device.role as DeviceRole
    return c.json({
      deviceId: device.id,
      deviceName: device.name,
      role,
      capabilities: deviceCapabilities(device),
    })
  })

  app.get('/api/devices', requireOwner, async (c) => {
    const listed: DeviceSummary[] = await listDevices(context.db)
    return c.json({ devices: listed })
  })

  app.post('/api/devices/invites', requireOwner, async (c) => {
    try {
      const issued = await issuePairingCode(context.db, context.pairingEndpoint, 'member')
      return c.json({
        id: issued.id,
        url: issued.url,
        expiresAt: issued.expiresAt.getTime(),
      })
    } catch (error) {
      if (error instanceof PairingError) {
        return c.json({ error: error.code, message: error.message }, 403)
      }
      throw error
    }
  })

  app.get('/api/devices/invites', requireOwner, async (c) => {
    return c.json({ invites: await listPendingInvites(context.db) })
  })

  app.delete('/api/devices/invites/:id', requireOwner, async (c) => {
    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: 'not_found', message: 'no such pending invite' }, 404)
    }
    const revoked = await revokeInvite(context.db, id)
    if (!revoked) {
      return c.json({ error: 'not_found', message: 'no such pending invite' }, 404)
    }
    return c.json({ revoked: true })
  })

  app.delete('/api/devices/:id', async (c) => {
    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: 'not_found', message: 'no such active device' }, 404)
    }
    const caller = c.get('device')

    // Members may only revoke themselves (Forget this server). The owner may
    // revoke any member, but never the owner device — that is CLI-only.
    if (!deviceIsOwner(caller) && caller.id !== id) {
      return c.json(OWNER_FORBIDDEN, 403)
    }

    try {
      const revoked = await revokeDevice(context.db, id)
      if (!revoked) {
        return c.json({ error: 'not_found', message: 'no such active device' }, 404)
      }
    } catch (error) {
      if (error instanceof RevokeError) {
        return c.json({ error: error.code, message: error.message }, 403)
      }
      throw error
    }

    context.onDeviceRevoked?.(id)
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
    app.route(
      '/api',
      projectRoutes({
        db: context.db,
        github: context.features.github,
        secrets: context.features.secrets,
      }),
    )
    app.route(
      '/api',
      sessionRoutes({
        db: context.db,
        bus: context.features.bus,
        sessions: context.features.sessions,
      }),
    )
    app.route('/api', environmentRoutes({ db: context.db }))
    app.route(
      '/api',
      secretRoutes({
        db: context.db,
        secrets: context.features.secrets,
        ...(context.features.grokLogin ? { grokLogin: context.features.grokLogin } : {}),
      }),
    )
    app.route('/api', opencodeRoutes({ secrets: context.features.secrets }))
  }

  return app
}

export type App = ReturnType<typeof createApp>
