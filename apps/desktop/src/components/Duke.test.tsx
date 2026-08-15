import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DukeHero, DukeLive, DukeMark, DukeWordmark, presenceForStatus } from '@/components/Duke'

describe('Duke', () => {
  it('renders the hero illustration as Duke', () => {
    render(<DukeHero />)
    expect(screen.getByRole('img', { name: 'Duke' })).toBeInTheDocument()
  })

  it('hides a decorative mark from the accessibility tree', () => {
    render(<DukeMark decorative />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('names a working presence', () => {
    render(<DukeMark presence="working" />)
    expect(screen.getByRole('img', { name: 'Duke is working' })).toBeInTheDocument()
  })

  it('names a waiting presence', () => {
    render(<DukeMark presence="waiting" />)
    expect(screen.getByRole('img', { name: 'Duke is waiting for you' })).toBeInTheDocument()
  })

  it('shows the Dukebox wordmark with a decorative mark', () => {
    render(<DukeWordmark />)
    expect(screen.getByText('Dukebox')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('names a live mood and hides a decorative face', () => {
    const { rerender } = render(<DukeLive mood="searching" label="Grep running" />)
    const live = screen.getByRole('img', { name: 'Grep running' })
    expect(live).toHaveAttribute('data-mood', 'searching')
    expect(live).toHaveAttribute('src', '/duke-mark.svg')

    rerender(<DukeLive decorative />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('uses the same drawing as the chrome mark', () => {
    render(
      <>
        <DukeMark label="Mark" />
        <DukeLive label="Live" />
      </>,
    )
    expect(screen.getByRole('img', { name: 'Mark' })).toHaveAttribute('src', '/duke-mark.svg')
    expect(screen.getByRole('img', { name: 'Live' })).toHaveAttribute('src', '/duke-mark.svg')
  })

  it('maps session status onto Duke presence', () => {
    expect(presenceForStatus('running')).toBe('working')
    expect(presenceForStatus('provisioning')).toBe('working')
    expect(presenceForStatus('waiting_input')).toBe('waiting')
    expect(presenceForStatus('done')).toBe('idle')
    expect(presenceForStatus('failed')).toBe('idle')
    expect(presenceForStatus('stopped')).toBe('idle')
  })
})
