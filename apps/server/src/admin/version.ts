import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Version of an installed release.
 *
 * A release bundle ships a `VERSION` file at its root, written by the release
 * workflow from the `server-vX.Y.Z` tag. A git checkout has no such file —
 * `findInstallRoot` reports it as a source install rather than a release one.
 */

export const VERSION_FILENAME = 'VERSION'

export async function findInstallRoot(fromUrl: string = import.meta.url): Promise<string | null> {
  let dir = dirname(fileURLToPath(fromUrl))

  for (let depth = 0; depth < 10; depth++) {
    try {
      await readFile(join(dir, VERSION_FILENAME), 'utf8')
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  return null
}

export async function installedVersion(installRoot: string): Promise<string> {
  const raw = await readFile(join(installRoot, VERSION_FILENAME), 'utf8')
  return raw.trim()
}
