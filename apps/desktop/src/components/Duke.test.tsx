import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DukeHero, DukeMark, DukeWordmark, presenceForStatus } from '@/components/Duke'

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

  it('maps session status onto Duke presence', () => {
    expect(presenceForStatus('running')).toBe('working')
    expect(presenceForStatus('provisioning')).toBe('working')
    expect(presenceForStatus('waiting_input')).toBe('waiting')
    expect(presenceForStatus('done')).toBe('idle')
    expect(presenceForStatus('failed')).toBe('idle')
    expect(presenceForStatus('stopped')).toBe('idle')
  })
})
