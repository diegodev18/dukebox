import { describe, expect, it } from 'vitest'
import {
  archName,
  checksumFor,
  compareVersions,
  fetchLatestServerRelease,
  selectServerAsset,
  versionFromTag,
  type ReleaseInfo,
} from './update.js'

describe('compareVersions', () => {
  it('compares numeric segments', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.2')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  it('treats a bare release as newer than a prerelease', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })
})

describe('versionFromTag', () => {
  it('strips the server-v prefix', () => {
    expect(versionFromTag('server-v0.1.0')).toBe('0.1.0')
  })
})

describe('selectServerAsset', () => {
  const release: ReleaseInfo = {
    tagName: 'server-v0.1.0',
    version: '0.1.0',
    assets: [
      { name: 'dukebox-server-0.1.0-linux-x64.tar.gz', browserDownloadUrl: 'u1' },
      { name: 'dukebox-server-0.1.0-linux-arm64.tar.gz', browserDownloadUrl: 'u2' },
      { name: 'Dukebox_0.1.0_aarch64.dmg', browserDownloadUrl: 'u3' },
    ],
  }

  it('picks the tarball for the requested architecture', () => {
    expect(selectServerAsset(release, 'x64')?.browserDownloadUrl).toBe('u1')
    expect(selectServerAsset(release, 'arm64')?.browserDownloadUrl).toBe('u2')
  })

  it('returns null when the architecture is missing', () => {
    expect(selectServerAsset(release, 'mips')).toBeNull()
  })
})

describe('checksumFor', () => {
  it('finds one asset in a SHA256SUMS file', () => {
    const sums = `abc\n` + 'a'.repeat(64) + '  dukebox-server-0.1.0-linux-x64.tar.gz\n'
    expect(checksumFor(sums, 'dukebox-server-0.1.0-linux-x64.tar.gz')).toBe('a'.repeat(64))
  })

  it('returns null for an unknown asset', () => {
    expect(checksumFor('', 'nope.tar.gz')).toBeNull()
  })
})

describe('archName', () => {
  it('maps arm64 and falls back to x64', () => {
    expect(archName('arm64')).toBe('arm64')
    expect(archName('x64')).toBe('x64')
    expect(archName('ia32')).toBe('x64')
  })
})

describe('fetchLatestServerRelease', () => {
  it('finds the newest server release, skipping drafts and non-server releases', async () => {
    const releases = [
      {
        tag_name: 'desktop-v0.1.0',
        draft: false,
        assets: [{ name: 'Dukebox.dmg', browser_download_url: 'u' }],
      },
      {
        tag_name: 'server-v0.2.0',
        draft: true,
        assets: [{ name: 'dukebox-server-0.2.0-linux-x64.tar.gz', browser_download_url: 'u' }],
      },
      {
        tag_name: 'server-v0.1.0',
        draft: false,
        assets: [{ name: 'dukebox-server-0.1.0-linux-x64.tar.gz', browser_download_url: 'u1' }],
      },
      {
        tag_name: 'server-v0.3.0',
        draft: false,
        assets: [{ name: 'dukebox-server-0.3.0-linux-x64.tar.gz', browser_download_url: 'u3' }],
      },
    ]
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => releases,
    })) as unknown as typeof fetch

    const release = await fetchLatestServerRelease('owner', 'repo', fetchImpl)
    expect(release?.version).toBe('0.3.0')
    expect(release?.tagName).toBe('server-v0.3.0')
  })

  it('returns null when no server release exists', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => [
        {
          tag_name: 'desktop-v0.1.0',
          draft: false,
          assets: [{ name: 'Dukebox.dmg', browser_download_url: 'u' }],
        },
      ],
    })) as unknown as typeof fetch

    expect(await fetchLatestServerRelease('owner', 'repo', fetchImpl)).toBeNull()
  })

  it('throws when the API errors', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      statusText: 'rate limited',
    })) as unknown as typeof fetch
    await expect(fetchLatestServerRelease('owner', 'repo', fetchImpl)).rejects.toThrow(/403/)
  })
})
