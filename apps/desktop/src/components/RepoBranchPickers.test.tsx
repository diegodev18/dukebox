import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AgentPicker } from '@/components/RepoBranchPickers'

describe('picker keyboard', () => {
  it('moves the highlight with arrows and picks with Enter', async () => {
    const onChange = vi.fn()
    render(<AgentPicker value="claude-code" onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }))
    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('opencode')
  })

  it('closes on Escape', async () => {
    render(<AgentPicker value="claude-code" onChange={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(screen.getByRole('listbox', { name: 'Agent' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Agent' })).not.toBeInTheDocument()
  })
})
