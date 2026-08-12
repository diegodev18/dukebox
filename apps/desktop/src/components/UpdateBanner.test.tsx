import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Update } from '@/lib/updater'
import type { UpdateState } from '@/lib/useUpdate'
import { UpdateBanner } from '@/components/UpdateBanner'

/**
 * The banner is the whole "how do I update" surface, so what matters is which
 * states it renders and what it lets the user do in each. States that mean
 * "nothing to tell you" must render nothing; states with an update must put
 * the action a step away.
 */

const update = { version: '0.2.0', body: 'now with more dog' } as unknown as Update

function makeProps(overrides: Partial<Parameters<typeof UpdateBanner>[0]> = {}) {
  return {
    state: { status: 'available', update } as UpdateState,
    checked: true,
    dismissed: false,
    announcing: false,
    onInstall: vi.fn(),
    onRecheck: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  }
}

describe('UpdateBanner', () => {
  it('renders nothing while the launch check is still running', () => {
    render(<UpdateBanner {...makeProps({ state: { status: 'checking' }, checked: false })} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders nothing when the app is up to date', () => {
    render(<UpdateBanner {...makeProps({ state: { status: 'up-to-date' } })} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says you are current after a manual check asked and found nothing', () => {
    render(<UpdateBanner {...makeProps({ state: { status: 'up-to-date' }, announcing: true })} />)

    expect(screen.getByRole('status')).toHaveTextContent('You’re up to date')
  })

  it('hides an offered update that was dismissed', () => {
    render(<UpdateBanner {...makeProps({ dismissed: true })} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('names the new version and installs on request', async () => {
    const onInstall = vi.fn()
    render(<UpdateBanner {...makeProps({ onInstall })} />)

    expect(screen.getByRole('status')).toHaveTextContent('Dukebox 0.2.0 is available')

    await userEvent.click(screen.getByRole('button', { name: /update & restart/i }))
    expect(onInstall).toHaveBeenCalledWith(update)
  })

  it('hides the offered update when told later', async () => {
    const onDismiss = vi.fn()
    render(<UpdateBanner {...makeProps({ onDismiss })} />)

    await userEvent.click(screen.getByRole('button', { name: /later/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('shows download progress as a percentage once a byte has arrived', () => {
    render(
      <UpdateBanner
        {...makeProps({
          state: {
            status: 'downloading',
            version: '0.2.0',
            progress: { received: 50, total: 100 },
          },
        })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Downloading Dukebox 0.2.0… 50%')
  })

  it('offers no percentage before the total is known', () => {
    render(
      <UpdateBanner
        {...makeProps({
          state: {
            status: 'downloading',
            version: '0.2.0',
            progress: { received: 0, total: null },
          },
        })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Downloading Dukebox 0.2.0…')
    expect(screen.getByRole('status')).not.toHaveTextContent('%')
  })

  it('says what went wrong and offers a way back to the update', async () => {
    const onRecheck = vi.fn()
    render(
      <UpdateBanner
        {...makeProps({ state: { status: 'error', message: 'signature mismatch' }, onRecheck })}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Could not update: signature mismatch')

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRecheck).toHaveBeenCalledOnce()
  })
})
