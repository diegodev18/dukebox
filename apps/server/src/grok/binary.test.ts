import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultGrokBinDir, ensureGrokBinary, grokDownloadUrls, grokPlatform } from '@/grok/binary'

describe('grokPlatform', () => {
  it('maps node arch names onto grok artifact names', () => {
    expect(grokPlatform('linux', 'x64')).toEqual({ os: 'linux', arch: 'x86_64' })
    expect(grokPlatform('linux', 'arm64')).toEqual({ os: 'linux', arch: 'aarch64' })
    expect(grokPlatform('darwin', 'arm64')).toEqual({ os: 'macos', arch: 'aarch64' })
  })
})

describe('grokDownloadUrls', () => {
  it('tries x.ai then the public GCS mirror', () => {
    const urls = grokDownloadUrls('1.0.3', { os: 'linux', arch: 'x86_64' })
    expect(urls[0]).toBe('https://x.ai/cli/grok-1.0.3-linux-x86_64')
    expect(urls[1]).toContain('grok-build-public-artifacts')
  })
})

describe('defaultGrokBinDir', () => {
  it('honours DUKEBOX_GROK_BIN_DIR', () => {
    const previous = process.env.DUKEBOX_GROK_BIN_DIR
    process.env.DUKEBOX_GROK_BIN_DIR = '/tmp/custom-grok'
    try {
      expect(defaultGrokBinDir()).toBe('/tmp/custom-grok')
    } finally {
      if (previous === undefined) delete process.env.DUKEBOX_GROK_BIN_DIR
      else process.env.DUKEBOX_GROK_BIN_DIR = previous
    }
  })
})

describe('ensureGrokBinary', () => {
  it('returns a cached executable without downloading', async () => {
    const dir = join(tmpdir(), `dukebox-grok-bin-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const cached = join(dir, 'grok-1.0.3')
    await writeFile(cached, '#!/bin/sh\n')
    await chmod(cached, 0o755)

    const download = vi.fn()
    expect(await ensureGrokBinary({ dir, download })).toBe(cached)
    expect(download).not.toHaveBeenCalled()
  })

  it('downloads when the cache is empty', async () => {
    const dir = join(tmpdir(), `dukebox-grok-bin-empty-${Date.now()}`)
    const download = vi.fn(async () => Buffer.from('#!/bin/sh\necho grok\n'))

    const path = await ensureGrokBinary({ dir, download })
    expect(path).toBe(join(dir, 'grok-1.0.3'))
    expect(download).toHaveBeenCalled()
  })

  it('falls through to the next URL when the first download fails', async () => {
    const dir = join(tmpdir(), `dukebox-grok-bin-fallback-${Date.now()}`)
    const download = vi
      .fn()
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(Buffer.from('#!/bin/sh\n'))

    await ensureGrokBinary({ dir, download })
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('falls back to tmp when the preferred directory cannot be created', async () => {
    const download = vi.fn(async () => Buffer.from('#!/bin/sh\n'))
    const path = await ensureGrokBinary({ dir: '/proc/dukebox-cannot-mkdir', download })
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(download).toHaveBeenCalled()
  })
})
