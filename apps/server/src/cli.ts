#!/usr/bin/env node
/**
 * Administrative commands, run over SSH on the VPS as `duke` (installed by
 * install.sh as a symlink into the release bundle).
 *
 *   duke pair new                       issue a pairing link
 *   duke device ls                      list paired devices
 *   duke device rm <id>                 revoke a device
 *   duke status                         report what the server can see
 *   duke version                        print the installed release version
 *   duke update [--check]               update to the latest server release
 *   duke update --from-git [ref]        build and install from a git ref (default: main)
 *   duke image rebuild                  rebuild the session agent Docker image
 *   duke rollback                       restore the previous release
 *   duke restart                        restart the control plane service
 *   duke logs [-f] [-n N]               control plane journal
 *   duke logs session [id]              session event log (omit id to list)
 *   duke logs docker [id]               agent container logs (omit id to list)
 *   duke config show                    print the effective configuration
 *   duke config get <section.key>       print one setting
 *   duke config set <section.key> <v>   change one setting (and restart)
 *
 * `update`, `image rebuild`, `rollback`, `restart`, and `config set` talk to
 * systemd / Docker and must run as root. The installer calls `pair new` to
 * print the first link, which is how a desktop app learns this server exists.
 */
import type { Database } from '@dukebox/db'
import { createDatabase } from '@dukebox/db'
import type { EnvelopedEvent, ServerConfig } from '@dukebox/protocol'
import { Sandbox } from '@dukebox/sandbox'
import { TailscaleTransport } from '@dukebox/transport'
import Redis from 'ioredis'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { DEFAULT_CONFIG_PATH, ConfigError, loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { EventBus } from './events/bus.js'
import { issuePairingCode, listDevices, revokeDevice } from './auth/pairing.js'
import { findInstallRoot, installedVersion } from './admin/version.js'
import {
  dockerLogsArgs,
  formatEvent,
  formatSessionRow,
  journalctlArgs,
  listActiveSessions,
  parseLogsArgs,
  resolveSessionId,
  runInherited,
  takeLast,
  untilInterrupted,
  type LogsArgs,
} from './admin/logs.js'
import {
  archName,
  compareVersions,
  fetchLatestServerRelease,
  RELEASE_TAG_PREFIX,
  selectServerAsset,
} from './admin/update.js'
import { buildAgentImage, performUpdate, runCommand } from './admin/updater.js'
import { defaultRepoUrl, parseUpdateArgs, performGitUpdate } from './admin/gitUpdate.js'
import {
  effectiveValues,
  fieldFor,
  formatConfigValue,
  readConfigValue,
  redactDatabaseUrl,
  setConfigValue,
} from './admin/config.js'

const SERVICE = 'dukebox'
const SERVICE_USER = 'dukebox'

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'never'

  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function requireRoot(action: string): void {
  if (process.getuid?.() !== 0) {
    throw new ConfigError(`${action} requires root`, 'Run this with sudo.')
  }
}

function configPath(): string {
  return process.env.DUKEBOX_CONFIG ?? DEFAULT_CONFIG_PATH
}

/** Run a command with the database open and migrations applied. */
async function withDatabase<T>(fn: (db: Database, config: ServerConfig) => Promise<T>): Promise<T> {
  const config = await loadConfig(configPath())
  const { db, close } = createDatabase(config.database.url, { max: 2 })
  try {
    await runMigrations(db)
    return await fn(db, config)
  } finally {
    await close()
  }
}

/** Session event follow needs Redis; replay uses the same EventBus. */
async function withEventBus<T>(fn: (db: Database, bus: EventBus) => Promise<T>): Promise<T> {
  const config = await loadConfig(configPath())
  const { db, close } = createDatabase(config.database.url, { max: 2 })
  const redis = new Redis(config.redis.url)
  const bus = new EventBus(db, redis)
  try {
    await runMigrations(db)
    return await fn(db, bus)
  } finally {
    redis.disconnect()
    await close()
  }
}

async function commandVersion(): Promise<void> {
  const installRoot = await findInstallRoot()
  if (!installRoot) {
    console.log('dev (source checkout, no release VERSION file)')
    return
  }
  console.log(await installedVersion(installRoot))
}

async function commandImage(args: string[]): Promise<void> {
  const subcommand = args[1]
  if (subcommand !== 'rebuild') {
    console.error('usage: duke image rebuild')
    process.exitCode = 1
    return
  }

  requireRoot('rebuilding the agent image')

  const installRoot = await findInstallRoot()
  if (!installRoot) {
    throw new ConfigError(
      'no release install found',
      'Run this on a machine installed by install.sh, or build manually: docker build -t dukebox/base-node:latest images/base-node',
    )
  }

  const result = await buildAgentImage({
    installRoot,
    log: (line) => console.log(line),
  })
  if (result.ok) console.log(`ok: ${result.message}`)
  else {
    console.error(`failed: ${result.message}`)
    process.exitCode = 1
  }
}

async function commandRestart(): Promise<void> {
  requireRoot('restarting the service')

  const restart = await runCommand('systemctl', ['restart', SERVICE])
  if (restart.code !== 0) {
    console.error(`restart failed: ${restart.stderr.trim()}`)
    process.exitCode = 1
    return
  }

  await sleep(3000)
  const active = await runCommand('systemctl', ['is-active', SERVICE])
  const state = active.stdout.trim() || 'unknown'
  console.log(state === 'active' ? 'dukebox is active' : `dukebox is ${state}`)
}

async function commandRollback(): Promise<void> {
  requireRoot('rolling back')

  const installRoot = await findInstallRoot()
  if (!installRoot) {
    throw new ConfigError(
      'this is not a release install (no VERSION file)',
      'Install from a release tarball first, or use the installer.',
    )
  }

  const backup = `${installRoot}.prev`
  try {
    await access(backup)
  } catch {
    console.error('no previous release to roll back to')
    process.exitCode = 1
    return
  }

  await rm(installRoot, { recursive: true, force: true })
  await rename(backup, installRoot)
  await runCommand('chown', ['-R', `${SERVICE_USER}:${SERVICE_USER}`, installRoot])
  await runCommand('systemctl', ['restart', SERVICE])

  await sleep(3000)
  const active = await runCommand('systemctl', ['is-active', SERVICE])
  if (active.code === 0 && active.stdout.trim() === 'active') {
    console.log('rolled back to the previous release')
  } else {
    console.error('rolled back, but the service did not start. See: duke logs')
    process.exitCode = 1
  }
}

async function commandUpdate(args: string[]): Promise<void> {
  const { fromGit, ref, checkOnly, force } = parseUpdateArgs(args.slice(1))

  const installRoot = await findInstallRoot()
  if (!installRoot) {
    throw new ConfigError(
      'this is not a release install (no VERSION file)',
      'Install from a release tarball first, or use the installer.',
    )
  }

  const currentVersion = await installedVersion(installRoot)

  if (fromGit) {
    if (checkOnly) {
      console.log(`installed:  ${currentVersion}`)
      console.log(`from-git:   ${defaultRepoUrl()} @ ${ref}`)
      console.log('Pass without --check to clone, build, and install that ref.')
      return
    }

    requireRoot('updating from git')
    console.log(`installed:  ${currentVersion}`)
    console.log(`from-git:   ${defaultRepoUrl()} @ ${ref}`)

    const result = await performGitUpdate({
      installRoot,
      ref,
      repoUrl: defaultRepoUrl(),
      configPath: configPath(),
      service: SERVICE,
      serviceUser: SERVICE_USER,
      log: (line) => console.log(line),
    })

    if (result.ok) console.log(`ok: ${result.message}`)
    else {
      console.error(`failed: ${result.message}`)
      process.exitCode = 1
    }
    return
  }

  const release = await fetchLatestServerRelease()
  if (!release) {
    throw new ConfigError(
      'no server release found on GitHub',
      `Tag a release with ${RELEASE_TAG_PREFIX}<version> and push it, or run: sudo duke update --from-git`,
    )
  }

  console.log(`installed:  ${currentVersion}`)
  console.log(`latest:     ${release.version} (${release.tagName})`)

  const updateAvailable = compareVersions(release.version, currentVersion) > 0
  if (!updateAvailable) {
    console.log('already up to date')
    if (checkOnly || !force) return
  }
  if (checkOnly) return

  requireRoot('updating')

  const arch = archName()
  const asset = selectServerAsset(release, arch)
  const checksums = release.assets.find((candidate) => candidate.name === 'SHA256SUMS')
  if (!asset || !checksums) {
    throw new ConfigError(
      `no ${arch} asset (or SHA256SUMS) in ${release.tagName}`,
      'The release workflow may still be running; wait and try again. Or: sudo duke update --from-git',
    )
  }

  const result = await performUpdate({
    installRoot,
    release,
    asset,
    checksumsUrl: checksums.browserDownloadUrl,
    configPath: configPath(),
    service: SERVICE,
    serviceUser: SERVICE_USER,
    fetchImpl: fetch,
    log: (line) => console.log(line),
  })

  if (result.ok) console.log(`ok: ${result.message}`)
  else {
    console.error(`failed: ${result.message}`)
    process.exitCode = 1
  }
}

async function commandConfig(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args.slice(1)
  const path = configPath()
  const positionals = rest.filter((arg) => !arg.startsWith('--'))
  const flags = new Set(rest.filter((arg) => arg.startsWith('--')))

  switch (subcommand) {
    case 'show': {
      const config = await loadConfig(path)
      for (const { key, value, protected: isProtected } of effectiveValues(config)) {
        const display =
          isProtected && typeof value === 'string'
            ? redactDatabaseUrl(value)
            : formatConfigValue(value)
        console.log(`${key} = ${display}`)
      }
      return
    }

    case 'get': {
      const key = positionals[0]
      if (!key) {
        console.error('usage: duke config get <section.key>')
        process.exitCode = 1
        return
      }
      const [section, field] = key.split('.')
      if (!section || !field || !fieldFor(section, field)) {
        console.error(`unknown key: ${key}`)
        process.exitCode = 1
        return
      }

      const source = await readFile(path, 'utf8')
      const { found, value } = readConfigValue(source, section, field)
      if (!found) {
        console.log('(unset)')
        return
      }
      const display =
        `${section}.${field}` === 'database.url' && typeof value === 'string'
          ? redactDatabaseUrl(value)
          : formatConfigValue(value)
      console.log(display)
      return
    }

    case 'set': {
      const key = positionals[0]
      const value = positionals[1]
      if (!key || value === undefined) {
        console.error('usage: duke config set <section.key> <value> [--no-restart] [--force]')
        process.exitCode = 1
        return
      }
      const [section, field] = key.split('.')
      if (!section || !field) {
        console.error(`unknown key: ${key}`)
        process.exitCode = 1
        return
      }

      await setConfigValue(path, section, field, value, flags.has('--force'))
      console.log(`set ${section}.${field} = ${value}`)

      if (!flags.has('--no-restart')) {
        requireRoot('restarting the service')
        const restart = await runCommand('systemctl', ['restart', SERVICE])
        if (restart.code !== 0) {
          console.error(`restart failed: ${restart.stderr.trim()}`)
          console.error('Run: sudo systemctl restart dukebox')
          process.exitCode = 1
        } else {
          console.log('service restarted')
        }
      }
      return
    }

    default:
      console.error('usage: duke config <show | get <section.key> | set <section.key> <value>>')
      process.exitCode = 1
  }
}

function printEvent(event: EnvelopedEvent, json: boolean): void {
  console.log(json ? JSON.stringify(event) : formatEvent(event))
}

async function commandLogs(args: string[]): Promise<void> {
  let parsed: LogsArgs
  try {
    parsed = parseLogsArgs(args.slice(1))
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }

  switch (parsed.target) {
    case 'service': {
      const code = await runInherited('journalctl', journalctlArgs(parsed, SERVICE))
      if (code !== 0) process.exitCode = code
      return
    }
    case 'session':
      await commandSessionLogs(parsed)
      return
    case 'docker':
      await commandDockerLogs(parsed)
      return
  }
}

async function commandSessionLogs(parsed: LogsArgs): Promise<void> {
  if (!parsed.sessionId) {
    if (parsed.follow) {
      console.error('usage: duke logs session <id> -f')
      process.exitCode = 1
      return
    }

    await withDatabase(async (db) => {
      const rows = await listActiveSessions(db)
      if (rows.length === 0) {
        console.log('No sessions. A desktop app creates them after pairing.')
        return
      }
      for (const row of rows) console.log(formatSessionRow(row))
    })
    return
  }

  await withEventBus(async (db, bus) => {
    const sessionId = await resolveSessionId(db, parsed.sessionId!)
    const limit = parsed.linesSpecified ? parsed.lines : undefined

    if (!parsed.follow) {
      const events = takeLast(await bus.replay(sessionId, parsed.afterSeq), limit)
      for (const event of events) printEvent(event, parsed.json)
      return
    }

    // Subscribe first so events that land during replay are buffered, then
    // drop anything replay already covered — the same handshake the WS path uses.
    const buffered: EnvelopedEvent[] = []
    let replaying = true
    const unsubscribe = await bus.subscribe(sessionId, (event) => {
      if (replaying) {
        buffered.push(event)
        return
      }
      printEvent(event, parsed.json)
    })

    try {
      const replayed = takeLast(await bus.replay(sessionId, parsed.afterSeq), limit)
      for (const event of replayed) printEvent(event, parsed.json)
      const highestReplayed = replayed.at(-1)?.seq ?? parsed.afterSeq
      replaying = false
      for (const event of buffered) {
        if (event.seq > highestReplayed) printEvent(event, parsed.json)
      }
      await untilInterrupted()
    } finally {
      await unsubscribe()
    }
  })
}

async function commandDockerLogs(parsed: LogsArgs): Promise<void> {
  const sandbox = new Sandbox()

  if (!parsed.sessionId) {
    if (parsed.follow) {
      console.error('usage: duke logs docker <id> -f')
      process.exitCode = 1
      return
    }

    let containers
    try {
      containers = await sandbox.list()
    } catch (error) {
      throw new ConfigError(
        'cannot talk to Docker',
        error instanceof Error ? error.message : String(error),
      )
    }

    if (containers.length === 0) {
      console.log('No session containers.')
      return
    }

    for (const container of containers) {
      const running = await container.isRunning()
      console.log(
        `${container.sessionId}  ${(running ? 'running' : 'stopped').padEnd(7)}  ${container.id.slice(0, 12)}`,
      )
    }
    return
  }

  await withDatabase(async (db) => {
    const sessionId = await resolveSessionId(db, parsed.sessionId!)
    let container
    try {
      container = await sandbox.get(sessionId)
    } catch (error) {
      throw new ConfigError(
        'cannot talk to Docker',
        error instanceof Error ? error.message : String(error),
      )
    }
    if (!container) {
      throw new ConfigError(
        `no container for session ${sessionId}`,
        'The session may still be provisioning, or the container was removed.',
      )
    }

    const code = await runInherited('docker', dockerLogsArgs(container.id, parsed))
    if (code !== 0) process.exitCode = code
  })
}

async function main() {
  const args = process.argv.slice(2)
  const [command, subcommand] = args

  switch (command) {
    case 'version':
      await commandVersion()
      return

    case 'restart':
      await commandRestart()
      return

    case 'rollback':
      await commandRollback()
      return

    case 'update':
      await commandUpdate(args)
      return

    case 'image':
      await commandImage(args)
      return

    case 'config':
      await commandConfig(args)
      return

    case 'logs':
      await commandLogs(args)
      return

    case 'db:migrate':
      await withDatabase(async () => {
        console.log('migrations are up to date')
      })
      return

    case 'pair':
      if (subcommand !== 'new') {
        console.error('usage: duke pair new')
        process.exitCode = 1
        return
      }
      await withDatabase(async (db, config) => {
        // Checked first: a link built from an endpoint the app cannot reach
        // would look valid and fail at pairing time.
        const transport = new TailscaleTransport()
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
      })
      return

    case 'device':
      if (subcommand === 'ls') {
        await withDatabase(async (db) => {
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
        })
        return
      }

      if (subcommand === 'rm') {
        const deviceId = args[2]
        if (!deviceId) {
          console.error('usage: duke device rm <device-id>')
          process.exitCode = 1
          return
        }
        await withDatabase(async (db) => {
          if (await revokeDevice(db, deviceId)) {
            console.log(`revoked ${deviceId}`)
          } else {
            console.error(`no active device with id ${deviceId}`)
            process.exitCode = 1
          }
        })
        return
      }

      console.error('usage: duke device <ls | rm <id>>')
      process.exitCode = 1
      return

    case 'status':
      await withDatabase(async (db, config) => {
        const transport = new TailscaleTransport()
        const preflight = await transport.preflight()
        const devices = await listDevices(db)

        const installRoot = await findInstallRoot()
        const version = installRoot ? await installedVersion(installRoot) : 'dev'
        const active = await runCommand('systemctl', ['is-active', SERVICE])

        console.log(`version:    ${version}`)
        console.log(`service:    ${active.stdout.trim() || 'unknown'}`)
        console.log(`transport:  ${transport.id} ${preflight.ok ? 'ok' : 'FAILED'}`)
        if (!preflight.ok) console.log(`            ${preflight.message}`)

        if (preflight.ok) {
          const endpoint = await transport.advertisedEndpoint(config.server.port)
          console.log(`reachable:  ${endpoint.host}:${endpoint.port}`)
        }

        console.log(`devices:    ${devices.length} paired`)
      })
      return

    default:
      console.error(
        'usage: duke <version | status | restart | update [--from-git [ref]] | image rebuild | rollback | logs [session|docker] | config | pair new | device ls | device rm <id>>',
      )
      process.exitCode = 1
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
