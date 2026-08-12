import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate, installUpdate } from './updater.js'
import { relaunch } from '@tauri-apps/plugin-process'
import { type Update } from '@tauri-apps/plugin-updater'

/**
 * The updater is a thin wrapper around the native plugin, so what matters
 * here is the two contracts the UI depends on: `checkForUpdate` never rejects
 * (a failed check and a current app are the same non-event), and
 * `installUpdate` reports progress as a running total and only relaunches
 * after the install finished.
 */

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
}))

import { check } from '@tauri-apps/plugin-updater'

const checked = vi.mocked(check)
const relaunched = vi.mocked(relaunch)

/** The download-progress callback the plugin passes chunks to. */
type OnEvent = Parameters<Update['downloadAndInstall']>[0]

/** The bits of an `Update` our code reads; the rest is the plugin's concern. */
interface FakeUpdate {
  version: string
  body: string | null
  downloadAndInstall: (onEvent?: OnEvent) => Promise<void>
}

function fakeUpdate(overrides: { body?: string | null; version?: string } = {}): FakeUpdate {
  return {
    version: overrides.version ?? '0.2.0',
    body: overrides.body ?? 'new things',
    downloadAndInstall: vi.fn(async (_onEvent?: OnEvent) => {}),
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('checkForUpdate', () => {
  it('returns the update when the feed has one', async () => {
    checked.mockResolvedValue(fakeUpdate({ version: '0.2.0', body: 'faster now' }) as never)

    await expect(checkForUpdate()).resolves.toMatchObject({
      version: '0.2.0',
      body: 'faster now',
    })
  })

  it('returns null when the app is current', async () => {
    checked.mockResolvedValue(null as never)

    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('returns null when the check fails, instead of rejecting', async () => {
    checked.mockRejectedValue(new Error('no network'))

    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('treats a missing release feed the same as a current app', async () => {
    // A repo with no releases yet answers 404; that must not crash the launch.
    checked.mockRejectedValue(new Error('404'))

    await expect(checkForUpdate()).resolves.toBeNull()
  })
})

describe('installUpdate', () => {
  it('downloads and installs, then relaunches into the new build', async () => {
    const update = fakeUpdate()
    await installUpdate(update as unknown as Update)

    expect(update.downloadAndInstall).toHaveBeenCalledOnce()
    expect(relaunched).toHaveBeenCalledOnce()
  })

  it('does not relaunch when the install failed', async () => {
    const update = fakeUpdate()
    update.downloadAndInstall = vi.fn(async () => {
      throw new Error('signature mismatch')
    })

    await expect(installUpdate(update as unknown as Update)).rejects.toThrow('signature mismatch')
    expect(relaunched).not.toHaveBeenCalled()
  })

  it('reports progress as a running total, not per-chunk sizes', async () => {
    const update = fakeUpdate()
    update.downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 30 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 20 } })
      onEvent?.({ event: 'Finished' })
    })

    const seen: Array<{ received: number; total: number | null }> = []
    await installUpdate(update as unknown as Update, (progress) => seen.push(progress))

    expect(seen).toEqual([
      { received: 0, total: 100 },
      { received: 30, total: 100 },
      { received: 50, total: 100 },
      { received: 50, total: 100 },
    ])
  })

  it('starts without a total when the server did not say', async () => {
    const update = fakeUpdate()
    update.downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent?.({ event: 'Progress', data: { chunkLength: 10 } })
      onEvent?.({ event: 'Finished' })
    })

    const seen: Array<{ received: number; total: number | null }> = []
    await installUpdate(update as unknown as Update, (progress) => seen.push(progress))

    expect(seen[0]).toEqual({ received: 10, total: null })
  })
})
