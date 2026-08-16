import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@/lib/settings'

const activeConnection = vi.fn()
const removeConnection = vi.fn()
const whoami = vi.fn()
const saveSettings = vi.hoisted(() => vi.fn())
const checkForUpdates = vi.hoisted(() => vi.fn())

vi.mock('@/lib/connection', () => ({
  activeConnection: (...args: unknown[]) => activeConnection(...args),
  removeConnection: (...args: unknown[]) => removeConnection(...args),
}))

vi.mock('@/lib/useSettings', () => ({
  useSettings: () => ({ settings: defaultSettings(), save: saveSettings }),
}))

vi.mock('@/lib/useUpdate', () => ({
  useUpdate: () => ({
    state: { status: 'up-to-date' },
    checked: true,
    dismissed: false,
    announcing: false,
    check: checkForUpdates,
    install: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

vi.mock('@/screens/Session', () => ({
  Session: () => <div>Session screen</div>,
}))

vi.mock('@/lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client')>()
  return {
    ...actual,
    DukeboxClient: class {
      whoami = whoami
    },
  }
})

import { ApiFailure } from '@/lib/client'
import { App } from '@/App'

const saved = {
  serverName: 'debian-01',
  address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-1',
  deviceToken: 'token-1',
  pairedAt: 1,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('App', () => {
  it('shows pairing when nothing is saved', async () => {
    activeConnection.mockResolvedValueOnce(null)
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect to your server' }),
    ).toBeInTheDocument()
  })

  it('opens the session screen when the stored token still works', async () => {
    activeConnection.mockResolvedValueOnce(saved)
    whoami.mockResolvedValueOnce({
      deviceId: 'device-1',
      deviceName: 'Mac',
      role: 'owner',
      capabilities: { manageDevices: true, manageAgents: true, deleteProjects: true },
    })
    render(<App />)

    expect(await screen.findByText('Session screen')).toBeInTheDocument()
    expect(removeConnection).not.toHaveBeenCalled()
  })

  it('forgets a revoked pairing and returns to pairing', async () => {
    activeConnection.mockResolvedValueOnce(saved)
    whoami.mockRejectedValueOnce(new ApiFailure(401, 'unauthorized', 'missing device token'))
    removeConnection.mockResolvedValueOnce(undefined)
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect to your server' }),
    ).toBeInTheDocument()
    expect(removeConnection).toHaveBeenCalledWith('device-1')
  })

  it('keeps a saved pairing when the server is merely unreachable', async () => {
    activeConnection.mockResolvedValueOnce(saved)
    whoami.mockRejectedValueOnce(new TypeError('network error'))
    render(<App />)

    expect(await screen.findByText('Session screen')).toBeInTheDocument()
    expect(removeConnection).not.toHaveBeenCalled()
  })

  it('shows pairing when the store cannot be read', async () => {
    activeConnection.mockRejectedValueOnce(new Error('keychain denied'))
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Connect to your server' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(removeConnection).not.toHaveBeenCalled())
  })

  it('applies a command-palette preference from any screen', async () => {
    activeConnection.mockResolvedValueOnce(null)
    render(<App />)
    await screen.findByRole('heading', { name: 'Connect to your server' })

    await userEvent.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    await userEvent.click(screen.getByRole('option', { name: 'Theme: Dark' }))

    expect(saveSettings).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('checks for updates from the command palette', async () => {
    activeConnection.mockResolvedValueOnce(null)
    render(<App />)
    await screen.findByRole('heading', { name: 'Connect to your server' })

    await userEvent.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    await userEvent.click(screen.getByRole('option', { name: 'Check for updates now' }))

    expect(checkForUpdates).toHaveBeenCalledWith(true)
  })

  it('shows Stop this session disabled when no session is open', async () => {
    activeConnection.mockResolvedValueOnce(null)
    render(<App />)
    await screen.findByRole('heading', { name: 'Connect to your server' })

    await userEvent.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    expect(screen.getByRole('option', { name: /Stop this session/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })
})
