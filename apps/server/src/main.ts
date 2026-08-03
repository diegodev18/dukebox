import { serve } from '@hono/node-server'
import { createDatabase } from '@dukebox/db'
import { TailscaleTransport, type Transport } from '@dukebox/transport'
import { hostname } from 'node:os'
import { ConfigError, loadConfig } from './config.js'
import { createApp } from './http/app.js'

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
  const app = createApp({ db, serverName: hostname() })

  const bind = await transport.bindAddress(config.server.port)

  const server = serve({ fetch: app.fetch, hostname: bind.host, port: bind.port }, (info) => {
    // Logging the bound address makes the isolation visible in the service
    // log: if this ever reads 0.0.0.0, the server is exposed.
    console.log(`dukebox listening on ${info.address}:${info.port} (${transport.id})`)
  })

  const shutdown = async () => {
    server.close()
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
