import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Pairing } from '@/screens/Pairing'

vi.mock('@/components/PairingForm', () => ({
  PairingForm: () => <div>pairing form</div>,
}))

describe('Pairing', () => {
  it('introduces Duke before asking for a pairing link', () => {
    render(<Pairing onPaired={vi.fn()} />)

    expect(screen.getByRole('img', { name: 'Duke' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Connect to your server' })).toBeInTheDocument()
  })
})
