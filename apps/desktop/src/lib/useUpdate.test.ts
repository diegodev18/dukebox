import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Update } from '@/lib/updater'
import { useUpdate } from '@/lib/useUpdate'

/**
 * The hook is the state machine the banner renders, so the transitions are
 * what matter: launch checks once, a found update goes through
 * available → downloading → done, and a dismissal lasts exactly until the
 * next check.
 */

vi.mock('@/lib/updater', () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}))

import { checkForUpdate, installUpdate } from '@/lib/updater'

const checked = vi.mocked(checkForUpdate)
const installed = vi.mocked(installUpdate)

const update = { version: '0.2.0', body: 'new things' } as unknown as Update

afterEach(() => {
  vi.clearAllMocks()
})

/** Drain the promise chains the hook's fire-and-forget calls leave behind. */
async function flush() {
  await act(async () => {})
}

describe('useUpdate', () => {
  it('asks the feed once at launch and reports the update', async () => {
    checked.mockResolvedValue(update)
    const { result } = renderHook(() => useUpdate())

    await flush()

    expect(checked).toHaveBeenCalledOnce()
    expect(result.current.checked).toBe(true)
    expect(result.current.state).toMatchObject({ status: 'available', update })
  })

  it('reports up to date when the feed has nothing', async () => {
    checked.mockResolvedValue(null)
    const { result } = renderHook(() => useUpdate())

    await flush()

    expect(result.current.state.status).toBe('up-to-date')
  })

  it('announces being current only when a manual check asked', async () => {
    checked.mockResolvedValue(null)
    const { result } = renderHook(() => useUpdate())
    await flush()

    expect(result.current.announcing).toBe(false)

    await act(async () => result.current.check(true))
    expect(result.current.state.status).toBe('up-to-date')
    expect(result.current.announcing).toBe(true)
  })

  it('passes download progress through to the banner', async () => {
    checked.mockResolvedValue(update)
    const { result } = renderHook(() => useUpdate())
    await flush()

    // Hold the install open so the intermediate downloading state is
    // observable, the way a real download would leave it.
    let notifyProgress: ((progress: { received: number; total: number | null }) => void) | undefined
    let finishInstall: (() => void) | undefined
    installed.mockImplementation((_update, onProgress) => {
      notifyProgress = onProgress
      return new Promise<void>((resolve) => {
        finishInstall = resolve
      })
    })

    await act(async () => result.current.install(update))
    expect(result.current.state.status).toBe('downloading')

    await act(async () => notifyProgress?.({ received: 40, total: 100 }))
    expect(result.current.state).toMatchObject({
      status: 'downloading',
      version: '0.2.0',
      progress: { received: 40, total: 100 },
    })

    await act(async () => finishInstall?.())
    expect(result.current.state.status).toBe('up-to-date')
  })

  it('treats the app as current once the new build is installed', async () => {
    checked.mockResolvedValue(update)
    const { result } = renderHook(() => useUpdate())
    await flush()

    installed.mockResolvedValue(undefined)
    await act(async () => result.current.install(update))

    expect(installed).toHaveBeenCalledWith(update, expect.any(Function))
    expect(result.current.state.status).toBe('up-to-date')
  })

  it('says what went wrong when the install fails', async () => {
    checked.mockResolvedValue(update)
    const { result } = renderHook(() => useUpdate())
    await flush()

    installed.mockRejectedValue(new Error('signature mismatch'))
    await act(async () => result.current.install(update))

    expect(result.current.state).toMatchObject({
      status: 'error',
      message: 'signature mismatch',
    })
  })

  it('dismisses an offered update until the next check', async () => {
    checked.mockResolvedValue(update)
    const { result } = renderHook(() => useUpdate())
    await flush()

    await act(async () => result.current.dismiss())
    expect(result.current.dismissed).toBe(true)

    // A fresh check — even one that finds the same update — revives it.
    checked.mockResolvedValue(update)
    await act(async () => result.current.check())
    expect(result.current.dismissed).toBe(false)
    expect(result.current.state.status).toBe('available')
  })
})
