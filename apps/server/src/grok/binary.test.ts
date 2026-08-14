import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultGrokBinDir,
  ensureGrokBinary,
  grokBinCandidates,
  grokDownloadUrls,
  grokPlatform,
} from '@/grok/binary'

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

describe('grokBinCandidates', () => {
  it('honours DUKEBOX_GROK_BIN_DIR then HOME, never /run', () => {
    const dirs = grokBinCandidates({
      DUKEBOX_GROK_BIN_DIR: '/opt/grok',
      HOME: '/var/lib/dukebox',
    })
    expect(dirs[0]).toBe('/opt/grok')
    expect(dirs).toContain('/var/lib/dukebox/grok')
    expect(dirs.some((dir) => dir.startsWith('/run/'))).toBe(false)
  })

  it('does not pick RuntimeDirectory just because it exists', () => {
    expect(defaultGrokBinDir()).not.toBe('/run/dukebox/grok')
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

  it('falls back to another dir when the preferred directory cannot be created', async () => {
    // A file as the parent makes mkdir fail immediately with ENOTDIR on every
    // platform. `/proc/...` hangs under some Linux / Docker mounts.
    const blocker = join(tmpdir(), `dukebox-not-a-dir-${Date.now()}`)
    await writeFile(blocker, '')
    await unlink(join(tmpdir(), 'dukebox-grok', 'grok-1.0.3')).catch(() => undefined)
    const download = vi.fn(async () => Buffer.from('#!/bin/sh\n'))
    const path = await ensureGrokBinary({ dir: join(blocker, 'grok'), download })
    expect(path.startsWith(blocker)).toBe(false)
    expect(download).toHaveBeenCalled()
  })

  it('skips a directory that cannot execute binaries', async () => {
    const noexec = join(tmpdir(), `dukebox-noexec-${Date.now()}`)
    await mkdir(noexec, { recursive: true })
    await unlink(join(tmpdir(), 'dukebox-grok', 'grok-1.0.3')).catch(() => undefined)
    const download = vi.fn(async () => Buffer.from('#!/bin/sh\n'))
    const path = await ensureGrokBinary({
      dir: noexec,
      download,
      canExecuteDir: async (dir) => dir !== noexec,
    })
    expect(path.startsWith(noexec)).toBe(false)
    expect(download).toHaveBeenCalled()
  })
})
