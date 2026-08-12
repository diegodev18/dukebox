import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createLiveLog } from './liveLog.js'
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
  /** Pipe stdout/stderr into a 4-line in-place TTY viewport (pnpm, tsc). */
  liveLog?: boolean
  /** Give the child the operator's TTY so tools like `docker build` can draw their own progress UI. */
  inheritStdio?: boolean
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  if (options.inheritStdio && process.stdout.isTTY) {
    return runInherited(command, args, options)
  }
  if (options.liveLog) {
    return runWithLiveLog(command, args, options)
  }
  return runBuffered(command, args, options)
}

async function runBuffered(
  command: string,
  args: string[],
  options: RunCommandOptions,
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

/** Attach the child to this process's stdio so Docker BuildKit can use its TTY progress. */
function runInherited(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: 'inherit',
    })
    settleSpawn(child, resolve, { stdout: '', stderr: '' })
  })
}

function runWithLiveLog(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const live = createLiveLog()
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      live.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      live.write(chunk)
    })
    settleSpawn(
      child,
      (result) => {
        live.finish()
        resolve(result)
      },
      () => ({ stdout, stderr }),
    )
  })
}

function settleSpawn(
  child: ReturnType<typeof spawn>,
  resolve: (result: CommandResult) => void,
  buffers: { stdout: string; stderr: string } | (() => { stdout: string; stderr: string }),
): void {
  let settled = false
  const done = (result: CommandResult) => {
    if (settled) return
    settled = true
    resolve(result)
  }
  child.on('error', (error) => {
    const { stdout, stderr } = typeof buffers === 'function' ? buffers() : buffers
    done({ code: 1, stdout, stderr: stderr || error.message })
  })
  child.on('close', (code, signal) => {
    const { stdout, stderr } = typeof buffers === 'function' ? buffers() : buffers
    done({
      code: code ?? 1,
      stdout,
      stderr: stderr || (signal ? `killed by ${signal}` : ''),
    })
  })
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

/** Tag the installer and updates publish for session containers. */
export const AGENT_IMAGE_TAG = 'dukebox/base-node:latest'

/** Dockerfile directory relative to a release/install root. */
export const AGENT_IMAGE_CONTEXT = 'images/base-node'

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
 * Rebuild the session agent image from the Dockerfile shipped in the install.
 *
 * Agents (`claude`, `opencode`, …) are baked into this image. Updating the
 * control plane alone leaves an old tag in place — OpenCode sessions then fail
 * with `exec: "opencode": executable file not found in $PATH`. Rebuild on every
 * update so the running image matches the Dockerfile the release just installed.
 *
 * Failure is reported rather than fatal: the control plane itself still works,
 * and an operator can retry with `duke image rebuild`.
 */
export async function buildAgentImage(options: {
  installRoot: string
  log: (line: string) => void
  run?: typeof runCommand
}): Promise<UpdateResult> {
  const run = options.run ?? runCommand
  const context = join(options.installRoot, AGENT_IMAGE_CONTEXT)

  options.log(`Building the agent image (${AGENT_IMAGE_TAG})`)
  const build = await run('docker', ['build', '-t', AGENT_IMAGE_TAG, context], {
    inheritStdio: true,
  })
  if (build.code !== 0) {
    return {
      ok: false,
      message:
        `could not build ${AGENT_IMAGE_TAG}: ${build.stderr.trim() || build.stdout.trim() || 'docker build failed'}. ` +
        `Retry with: sudo duke image rebuild`,
    }
  }

  return { ok: true, message: `built ${AGENT_IMAGE_TAG}` }
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
      // Rebuild after the swap so the new Dockerfile (and pinned agent
      // versions) is what Docker builds. A failed image build does not roll
      // the control plane back — sessions for agents that were already in the
      // previous image still work, and the operator can retry the rebuild.
      const image = await buildAgentImage({ installRoot, log, run })
      if (!image.ok) {
        log(`warning: ${image.message}`)
        return {
          ok: true,
          message: `${successMessage} Warning: agent image was not rebuilt (${image.message})`,
        }
      }
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
