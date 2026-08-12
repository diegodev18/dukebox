import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * Pure logic for finding and verifying a server release.
 *
 * The orchestration (download, extract, swap, restart) lives in `updater.ts`;
 * everything here is a unit-testable piece: comparing versions, selecting the
 * asset for this machine's architecture, and verifying the tarball against the
 * checksums the release workflow ships alongside it.
 */

export const REPO_OWNER = 'diegodev18'
export const REPO_NAME = 'dukebox'
export const RELEASE_TAG_PREFIX = 'server-v'

export interface ReleaseAsset {
  name: string
  browserDownloadUrl: string
}

export interface ReleaseInfo {
  tagName: string
  version: string
  assets: ReleaseAsset[]
}

export function versionFromTag(tag: string): string {
  return tag.replace(new RegExp(`^${RELEASE_TAG_PREFIX}`), '')
}

/**
 * Compare two `X.Y.Z` versions, an optional `-prerelease` suffix making the
 * version older than the bare release. Returns a negative/zero/positive number.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): { parts: number[]; pre: string } => {
    const [core, pre] = version.split('-', 2) as [string, string | undefined]
    const parts = core.split('.').map((part) => Number.parseInt(part, 10))
    while (parts.length < 3) parts.push(0)
    return { parts, pre: pre ?? '' }
  }

  const left = parse(a)
  const right = parse(b)

  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }

  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/** The tarball for a given architecture, or null when this release lacks one. */
export function selectServerAsset(release: ReleaseInfo, arch: string): ReleaseAsset | null {
  const expected = `dukebox-server-${release.version}-linux-${arch}.tar.gz`
  return release.assets.find((asset) => asset.name === expected) ?? null
}

/**
 * Find the newest published `server-v*` release that carries a server tarball.
 *
 * The same GitHub Release hosts desktop and server assets, so "latest" overall
 * is meaningless; filter by tag prefix and skip drafts.
 */
export async function fetchLatestServerRelease(
  owner = REPO_OWNER,
  repo = REPO_NAME,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseInfo | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dukebox-updater' },
  })
  if (!response.ok) {
    throw new Error(`the GitHub API returned ${response.status} ${response.statusText}`)
  }

  const releases = (await response.json()) as Array<{
    tag_name: string
    draft: boolean
    assets: Array<{ name: string; browser_download_url: string }>
  }>

  const candidates = releases.filter(
    (release) =>
      release.tag_name.startsWith(RELEASE_TAG_PREFIX) &&
      !release.draft &&
      release.assets.some((asset) => asset.name.startsWith('dukebox-server-')),
  )

  // The API returns releases newest first, but picking the highest version is
  // robust to ordering surprises rather than trusting the array position.
  const latest = candidates.reduce<(typeof candidates)[number] | null>((best, candidate) => {
    if (!best) return candidate
    return compareVersions(versionFromTag(candidate.tag_name), versionFromTag(best.tag_name)) > 0
      ? candidate
      : best
  }, null)
  if (!latest) return null

  return {
    tagName: latest.tag_name,
    version: versionFromTag(latest.tag_name),
    assets: latest.assets.map((asset) => ({
      name: asset.name,
      browserDownloadUrl: asset.browser_download_url,
    })),
  }
}

export async function sha256OfFile(path: string): Promise<string> {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

/** Pull one asset's checksum out of a SHA256SUMS file. */
export function checksumFor(sha256Text: string, assetName: string): string | null {
  for (const line of sha256Text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?([^\s]+)$/.exec(line.trim())
    if (match && match[2] === assetName) return match[1] ?? null
  }
  return null
}

/** Architecture token used in release asset names, from Node's process.arch. */
export function archName(processArch = process.arch): 'x64' | 'arm64' {
  return processArch === 'arm64' ? 'arm64' : 'x64'
}
