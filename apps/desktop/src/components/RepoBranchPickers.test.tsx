import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker, PermissionModePicker } from '@/components/RepoBranchPickers'

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

describe('picker placement', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not call scrollIntoView, which would shove the page', async () => {
    const original = HTMLElement.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    try {
      render(<PermissionModePicker value="bypass" onChange={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: 'Permission mode' }))

      expect(screen.getByRole('listbox', { name: 'Permission mode' })).toBeInTheDocument()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('opens above the chip when there is no room below', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200)

    render(<PermissionModePicker value="bypass" onChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Permission mode' })
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 740,
      top: 740,
      left: 24,
      bottom: 768,
      right: 120,
      width: 96,
      height: 28,
      toJSON() {
        return {}
      },
    })

    await userEvent.click(button)
    const listbox = screen.getByRole('listbox', { name: 'Permission mode' })

    expect(listbox.style.bottom).toBe('66px')
    expect(listbox.style.top).toBe('')
  })

  it('opens below the chip when there is room', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200)

    render(<PermissionModePicker value="bypass" onChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Permission mode' })
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 40,
      top: 40,
      left: 24,
      bottom: 68,
      right: 120,
      width: 96,
      height: 28,
      toJSON() {
        return {}
      },
    })

    await userEvent.click(button)
    const listbox = screen.getByRole('listbox', { name: 'Permission mode' })

    expect(listbox.style.top).toBe('74px')
    expect(listbox.style.bottom).toBe('')
  })
})
