import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
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

export function defaultGrokBinDir(): string {
  return process.env.DUKEBOX_GROK_BIN_DIR ?? '/var/lib/dukebox/grok'
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
}): Promise<string> {
  const dir = options.dir ?? defaultGrokBinDir()
  const dest = join(dir, `grok-${GROK_CLI_VERSION}`)

  if (await isExecutable(dest)) return dest

  await mkdir(dir, { recursive: true })
  const download = options.download ?? downloadUrl
  let lastError: Error | undefined

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

  throw lastError ?? new Error('could not download grok')
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
