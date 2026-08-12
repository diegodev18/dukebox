import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { checksumFor, sha256OfFile, type ReleaseAsset, type ReleaseInfo } from './update.js'

const execFileAsync = promisify(execFile)

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

export interface PerformUpdateOptions {
  installRoot: string
  release: ReleaseInfo
  asset: ReleaseAsset
  /** Path to the SHA256SUMS asset download URL. */
  checksumsUrl: string
  /** /etc/dukebox/config.toml, passed to the staging CLI for the migration pre-flight. */
  configPath: string
  /** systemd unit name, and the user the install directory belongs to. */
  service: string
  serviceUser: string
  fetchImpl: typeof fetch
  log: (line: string) => void
}

export interface UpdateResult {
  ok: boolean
  message: string
}

export interface InstallStagingOptions {
  installRoot: string
  stagingDir: string
  configPath: string
  service: string
  serviceUser: string
  successMessage: string
  log: (line: string) => void
  run?: typeof runCommand
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`could not download ${url}: the server returned ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest))
}

/**
 * Run migrations from a staged bundle, swap it into `installRoot`, and restart
 * the service — rolling back automatically if the new code fails to come up.
 *
 * Shared by `performUpdate` (GitHub release tarball) and `performGitUpdate`
 * (bundle built on the machine from a git ref).
 */
export async function installStaging(options: InstallStagingOptions): Promise<UpdateResult> {
  const run = options.run ?? runCommand
  const { installRoot, stagingDir, configPath, service, serviceUser, successMessage, log } = options

  try {
    // Run the new code's migrations against the live database before anything
    // is swapped. A migration that fails here aborts the update with the old
    // release still in place; running it after the swap would leave a broken
    // server behind until the operator rolls back.
    log('Applying database migrations')
    const cliPath = join(stagingDir, 'dist', 'cli.js')
    await chmod(cliPath, 0o755)
    const migrate = await run(process.execPath, [cliPath, 'db:migrate'], {
      env: {
        ...process.env,
        DUKEBOX_CONFIG: configPath,
      },
    })
    if (migrate.code !== 0) {
      return {
        ok: false,
        message: `migrations failed: ${migrate.stderr.trim() || migrate.stdout.trim()}`,
      }
    }

    const backupDir = `${installRoot}.prev`
    await rm(backupDir, { recursive: true, force: true })

    log('Swapping release in')
    await rename(installRoot, backupDir)
    await rename(stagingDir, installRoot)

    const chown = await run('chown', ['-R', `${serviceUser}:${serviceUser}`, installRoot])
    if (chown.code !== 0) {
      // Not worth rolling back over: ownership is cosmetic and fixed by the
      // install. But it must be reported.
      log(`warning: could not chown ${installRoot}: ${chown.stderr.trim()}`)
    }

    log('Restarting the service')
    await run('systemctl', ['restart', service])

    await sleep(3000)

    const active = await run('systemctl', ['is-active', service])
    if (active.code === 0 && active.stdout.trim() === 'active') {
      return { ok: true, message: successMessage }
    }

    // The new release did not come up. Roll back before reporting.
    log('The new release failed to start; rolling back')
    await rm(installRoot, { recursive: true, force: true })
    await rename(backupDir, installRoot)
    await run('chown', ['-R', `${serviceUser}:${serviceUser}`, installRoot])
    await run('systemctl', ['restart', service])
    await sleep(3000)

    return {
      ok: false,
      message: `the new release did not start (systemctl is-active reported "${active.stdout.trim() || 'inactive'}"); rolled back. See: journalctl -u ${service} -n 50`,
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

/**
 * Download a release, verify it, run the new code's migrations against the
 * live database, swap the install directory, and restart the service.
 *
 * Runs as root: it rewrites /opt/dukebox and talks to systemd. On any failure
 * after the swap it rolls back to the previous release and reports that.
 */
export async function performUpdate(options: PerformUpdateOptions): Promise<UpdateResult> {
  const {
    installRoot,
    release,
    asset,
    checksumsUrl,
    configPath,
    service,
    serviceUser,
    fetchImpl,
    log,
  } = options

  const tempDir = await mkdtemp(join(tmpdir(), 'dukebox-update-'))
  const tarballPath = join(tempDir, asset.name)
  const checksumsPath = join(tempDir, 'SHA256SUMS')
  const stagingDir = `${installRoot}.new`

  try {
    log(`Downloading ${asset.name}`)
    await downloadFile(asset.browserDownloadUrl, tarballPath, fetchImpl)
    await downloadFile(checksumsUrl, checksumsPath, fetchImpl)

    const sums = await readFile(checksumsPath, 'utf8')
    const expected = checksumFor(sums, asset.name)
    if (!expected) {
      return { ok: false, message: `SHA256SUMS does not list ${asset.name}` }
    }

    log('Verifying checksum')
    const actual = await sha256OfFile(tarballPath)
    if (actual !== expected) {
      return {
        ok: false,
        message: `checksum mismatch: expected ${expected}, got ${actual}. Refusing to install a tampered download.`,
      }
    }

    await rm(stagingDir, { recursive: true, force: true })
    await mkdir(stagingDir)

    log('Extracting')
    const extract = await runCommand('tar', ['-xzf', tarballPath, '-C', stagingDir])
    if (extract.code !== 0) {
      return { ok: false, message: `extraction failed: ${extract.stderr.trim()}` }
    }

    return await installStaging({
      installRoot,
      stagingDir,
      configPath,
      service,
      serviceUser,
      successMessage: `updated to ${release.tagName}. The service restarted successfully.`,
      log,
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
    await rm(stagingDir, { recursive: true, force: true })
  }
}
