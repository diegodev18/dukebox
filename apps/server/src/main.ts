import { serve } from '@hono/node-server'
import { createDatabase } from '@dukebox/db'
import { Sandbox } from '@dukebox/sandbox'
import { TailscaleTransport, type Transport } from '@dukebox/transport'
import Redis from 'ioredis'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { ConfigError, loadConfig } from './config.js'
import { EventBus } from './events/bus.js'
import { GitHubClient } from './github/client.js'
import { createApp } from './http/app.js'
import { SessionManager } from './sessions/manager.js'
import { attachWebSocketServer } from './ws/server.js'

/**
 * Control plane entry point.
 *
 * Order matters here: the transport is checked before anything is bound, so a
 * misconfigured tailnet produces one clear instruction at startup instead of a
 * server that comes up unreachable.
 */

function transportFor(id: string): Transport {
  switch (id) {
    case 'tailscale':
      return new TailscaleTransport()
    default:
      // Unreachable through the schema, which only accepts known transports.
      throw new ConfigError(`unknown transport: ${id}`)
  }
}

async function main() {
  const config = await loadConfig(process.env.DUKEBOX_CONFIG)
  const transport = transportFor(config.server.transport)

  const preflight = await transport.preflight()
  if (!preflight.ok) {
    console.error(`cannot start: ${preflight.message}`)
    process.exit(1)
  }

  const { db, close } = createDatabase(config.database.url)
  const redis = new Redis(config.redis.url)
  const bus = new EventBus(db, redis)

  const github = new GitHubClient()

  if (!(await github.isAuthenticated())) {
    // Fatal rather than deferred: without this, every session would fail at
    // clone time with an error that looks like a network problem.
    console.error('cannot start: gh is not authenticated')
    console.error('Run: gh auth login')
    process.exit(1)
  }

  const sessions = new SessionManager({
    db,
    bus,
    github,
    sandbox: new Sandbox(),
    // Per-session sockets. The Docker daemon shares this filesystem, which is
    // what lets a container reach the socket at all.
    credentialSocketDir: '/run/dukebox/sessions',
    // No token in the URL: git gets credentials from the proxy instead.
    cloneUrl: (repoFullName) => `https://github.com/${repoFullName}.git`,
  })

  const app = createApp({ db, serverName: hostname() })
  const bind = await transport.bindAddress(config.server.port)

  const server = serve({ fetch: app.fetch, hostname: bind.host, port: bind.port }, (info) => {
    // Logging the bound address makes the isolation visible in the service
    // log: if this ever reads 0.0.0.0, the server is exposed.
    console.log(`dukebox listening on ${info.address}:${info.port} (${transport.id})`)
  })

  const wss = attachWebSocketServer(server as unknown as Server, {
    db,
    bus,
    onPrompt: (sessionId, text, images) => sessions.prompt(sessionId, text, images),
    onInterrupt: (sessionId) => sessions.interrupt(sessionId),
    onPermissionResponse: (sessionId, id, allow) =>
      sessions.respondToPermission(sessionId, id, allow),
  })

  const shutdown = async () => {
    // Sessions first: their containers are stopped rather than removed, so a
    // restart resumes them instead of re-cloning every workspace.
    await sessions.stopAll()

    wss.clients.forEach((socket) => socket.terminate())
    wss.close()
    server.close()

    redis.disconnect()
    await close()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    if (error.remedy) console.error(error.remedy)
    process.exit(1)
  }

  console.error(error)
  process.exit(1)
})
