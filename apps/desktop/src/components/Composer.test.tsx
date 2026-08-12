import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer.js'

describe('Composer', () => {
  it('does not clear the draft while the agent is running', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} onInterrupt={vi.fn()} running />)

    await userEvent.type(screen.getByLabelText('Message'), 'follow up')
    await userEvent.keyboard('{Enter}')

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Message')).toHaveValue('follow up')
  })

  it('restores the draft when a send is rejected', async () => {
    const onSend = vi.fn()
    const { rerender } = render(
      <Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error={null} />,
    )

    await userEvent.type(screen.getByLabelText('Message'), 'do a thing')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('do a thing')
    expect(screen.getByLabelText('Message')).toHaveValue('')

    rerender(<Composer onSend={onSend} onInterrupt={vi.fn()} running={false} error="rejected" />)

    expect(screen.getByLabelText('Message')).toHaveValue('do a thing')
  })

  it('hints how to send', () => {
    render(<Composer onSend={vi.fn()} onInterrupt={vi.fn()} running={false} />)

    expect(screen.getByText(/↵ Send/)).toBeInTheDocument()
  })
})
