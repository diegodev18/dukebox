/**
 * Administrative commands, run over SSH on the VPS.
 *
 *   duke pair new        issue a pairing link
 *   duke device ls       list paired devices
 *   duke device rm <id>  revoke a device
 *   duke status          report what the server can see
 *
 * The installer calls `pair new` to print the first link, which is how a
 * desktop app learns this server exists.
 */
import { createDatabase } from '@dukebox/db'
import { TailscaleTransport } from '@dukebox/transport'
import { ConfigError, loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { issuePairingCode, listDevices, revokeDevice } from './auth/pairing.js'

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'never'

  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

async function main() {
  const [command, subcommand, argument] = process.argv.slice(2)

  const config = await loadConfig(process.env.DUKEBOX_CONFIG)
  const transport = new TailscaleTransport()
  const { db, close } = createDatabase(config.database.url, { max: 2 })

  // The CLI can be the first thing to touch a fresh database — `pair new` is
  // the last step of an install — so it migrates too rather than failing with
  // a missing-relation error that says nothing about what to do.
  await runMigrations(db)

  try {
    switch (`${command} ${subcommand ?? ''}`.trim()) {
      case 'pair new': {
        // Checked first: a link built from an endpoint the app cannot reach
        // would look valid and fail at pairing time.
        const preflight = await transport.preflight()
        if (!preflight.ok) {
          console.error(`cannot issue a pairing link: ${preflight.message}`)
          process.exitCode = 1
          return
        }

        const endpoint = await transport.advertisedEndpoint(config.server.port)
        const issued = await issuePairingCode(db, endpoint)
        const minutes = Math.round((issued.expiresAt.getTime() - Date.now()) / 60_000)

        console.log()
        console.log('  Paste this into the Dukebox desktop app:')
        console.log()
        console.log(`  ${issued.url}`)
        console.log()
        console.log(`  Expires in ${minutes} minutes. Issue another with: duke pair new`)
        console.log()
        return
      }

      case 'device ls': {
        const devices = await listDevices(db)

        if (devices.length === 0) {
          console.log('No devices paired. Issue a link with: duke pair new')
          return
        }

        for (const device of devices) {
          console.log(
            `${device.id}  ${device.platform.padEnd(8)} ${device.name.padEnd(24)} last seen ${formatAge(device.lastSeenAt)}`,
          )
        }
        return
      }

      case 'device rm': {
        if (!argument) {
          console.error('usage: duke device rm <device-id>')
          process.exitCode = 1
          return
        }

        if (await revokeDevice(db, argument)) {
          console.log(`revoked ${argument}`)
        } else {
          console.error(`no active device with id ${argument}`)
          process.exitCode = 1
        }
        return
      }

      case 'status': {
        const preflight = await transport.preflight()
        const devices = await listDevices(db)

        console.log(`transport:  ${transport.id} ${preflight.ok ? 'ok' : 'FAILED'}`)
        if (!preflight.ok) console.log(`            ${preflight.message}`)

        if (preflight.ok) {
          const endpoint = await transport.advertisedEndpoint(config.server.port)
          console.log(`reachable:  ${endpoint.host}:${endpoint.port}`)
        }

        console.log(`devices:    ${devices.length} paired`)
        return
      }

      default:
        console.error('usage: duke <pair new | device ls | device rm <id> | status>')
        process.exitCode = 1
    }
  } finally {
    await close()
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    if (error.remedy) console.error(error.remedy)
    process.exit(1)
  }

  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
