import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const reachable = vi.fn()
const redeemPairingCode = vi.fn()
const addConnection = vi.fn()

vi.mock('@/lib/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client')>()
  return {
    ...actual,
    reachable: (...args: unknown[]) => reachable(...args),
    redeemPairingCode: (...args: unknown[]) => redeemPairingCode(...args),
  }
})

vi.mock('@/lib/connection', () => ({
  addConnection: (...args: unknown[]) => addConnection(...args),
  deviceName: () => 'Dukebox on Mac',
  detectPlatform: () => 'macos',
}))

import { ApiFailure } from '@/lib/client'
import { PairingForm } from '@/components/PairingForm'

const LINK = 'dukebox://pair?host=debian-01.tailnet.ts.net&port=7777&code=A1B2-C3D4'

describe('PairingForm', () => {
  it('rejects a link that is not a pairing URL without reaching the server', async () => {
    render(<PairingForm onPaired={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Pairing link'), 'https://example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(screen.getByRole('alert')).toHaveTextContent('That does not look like a pairing link.')
    expect(reachable).not.toHaveBeenCalled()
  })

  it('does not spend the code when the server does not answer', async () => {
    reachable.mockResolvedValueOnce({ ok: false, reason: 'timeout' })
    render(<PairingForm onPaired={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Pairing link'), LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'debian-01.tailnet.ts.net did not answer.',
    )
    expect(redeemPairingCode).not.toHaveBeenCalled()
  })

  it('explains a request that was refused before it left the app', async () => {
    reachable.mockResolvedValueOnce({
      ok: false,
      reason: 'blocked',
      detail: 'App Transport Security',
    })
    render(<PairingForm onPaired={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Pairing link'), LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The connection to debian-01.tailnet.ts.net was refused before it left the app.',
    )
  })

  it.each([
    ['already_used', 'That link has already been used.'],
    ['expired', 'That link has expired.'],
    ['invalid_code', 'The server does not recognise that link.'],
  ] as const)('explains a %s redeem', async (code, message) => {
    reachable.mockResolvedValueOnce({ ok: true })
    redeemPairingCode.mockRejectedValueOnce(new ApiFailure(403, code, 'refused'))
    render(<PairingForm onPaired={vi.fn()} />)

    await userEvent.type(screen.getByLabelText('Pairing link'), LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('saves the pairing and reports success', async () => {
    reachable.mockResolvedValueOnce({ ok: true })
    redeemPairingCode.mockResolvedValueOnce({
      deviceId: 'device-1',
      deviceToken: 'token-1',
      serverName: 'debian-01',
      role: 'owner',
    })
    addConnection.mockResolvedValueOnce(undefined)
    const onPaired = vi.fn()
    render(<PairingForm onPaired={onPaired} />)

    await userEvent.type(screen.getByLabelText('Pairing link'), LINK)
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(addConnection).toHaveBeenCalled())
    expect(onPaired).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'debian-01',
        deviceId: 'device-1',
        deviceToken: 'token-1',
        address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
      }),
    )
  })
})
