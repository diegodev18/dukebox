import { spawn } from 'node:child_process'
import { access, chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Pinned to the same release the session image ships. An unattended upgrade
 * that changes `grok login` output would break the Settings wizard.
 */
export const GROK_CLI_VERSION = '1.0.3'

const PRIMARY = 'https://x.ai/cli'
const FALLBACK = 'https://storage.googleapis.com/grok-build-public-artifacts/cli'

export function grokPlatform(
  platform = process.platform,
  arch = process.arch,
): { os: 'linux' | 'macos'; arch: 'x86_64' | 'aarch64' } {
  const os = platform === 'darwin' ? 'macos' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  return { os, arch: cpu }
}

export function grokDownloadUrls(version = GROK_CLI_VERSION, platform = grokPlatform()): string[] {
  const name = `grok-${version}-${platform.os}-${platform.arch}`
  return [`${PRIMARY}/${name}`, `${FALLBACK}/${name}`]
}

/**
 * Where the login CLI is cached.
 *
 * Never use RuntimeDirectory (`/run/dukebox`): Debian/Ubuntu mount `/run`
 * noexec, so a chmod +x binary there still fails spawn with EACCES.
 * `$HOME` (`/var/lib/dukebox`) is a normal disk and is writable once the
 * unit lists it in ReadWritePaths. PrivateTmp `/tmp` is the fallback.
 */
export function grokBinCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  if (env.DUKEBOX_GROK_BIN_DIR) dirs.push(env.DUKEBOX_GROK_BIN_DIR)
  if (env.HOME) dirs.push(join(env.HOME, 'grok'))
  dirs.push(join(tmpdir(), 'dukebox-grok'))
  return [...new Set(dirs)]
}

export function defaultGrokBinDir(): string {
  return grokBinCandidates()[0]
}

/**
 * A grok binary on disk, downloading it once if the cache is empty.
 *
 * Lives outside the session image so a server that has not rebuilt
 * `dukebox/base-node` can still run device-code login.
 */
export async function ensureGrokBinary(options: {
  dir?: string
  download?: (url: string) => Promise<Buffer>
  canExecuteDir?: (dir: string) => Promise<boolean>
}): Promise<string> {
  const download = options.download ?? downloadUrl
  const canExecuteDir = options.canExecuteDir ?? directoryAllowsExec
  // An explicit dir is a caller override (tests, DUKEBOX_GROK_BIN_DIR via
  // defaultGrokBinDir). Fall back only to process tmp so we never write a
  // CLI into the real $HOME during tests.
  const dirs = options.dir ? [options.dir, join(tmpdir(), 'dukebox-grok')] : grokBinCandidates()
  let lastError: Error | undefined

  for (const candidate of [...new Set(dirs)]) {
    const dir = await usableDir(candidate, canExecuteDir)
    if (!dir) continue

    const dest = join(dir, `grok-${GROK_CLI_VERSION}`)
    if (await isExecutable(dest)) return dest

    for (const url of grokDownloadUrls()) {
      try {
        const bytes = await download(url)
        await writeFile(dest, bytes)
        await chmod(dest, 0o755)
        return dest
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  throw lastError ?? new Error('could not download grok into an executable path')
}

async function usableDir(
  preferred: string,
  canExecuteDir: (dir: string) => Promise<boolean>,
): Promise<string | undefined> {
  try {
    await mkdir(preferred, { recursive: true })
  } catch {
    return undefined
  }
  if (!(await canExecuteDir(preferred))) return undefined
  return preferred
}

/**
 * access(X_OK) only checks mode bits. `/run` is noexec, so a 0755 file
 * there still cannot be spawned. Probe by executing a tiny script.
 */
export async function directoryAllowsExec(dir: string): Promise<boolean> {
  const probe = join(dir, `.dukebox-exec-probe-${process.pid}`)
  try {
    await writeFile(probe, '#!/bin/sh\nexit 0\n')
    await chmod(probe, 0o755)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(probe, [], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('exec probe timed out'))
      }, 2000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`exec probe exited ${code}`))
      })
    })
    return true
  } catch {
    return false
  } finally {
    await unlink(probe).catch(() => undefined)
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function downloadUrl(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`download failed ${response.status} from ${url}`)
  }
  return Buffer.from(await response.arrayBuffer())
}
