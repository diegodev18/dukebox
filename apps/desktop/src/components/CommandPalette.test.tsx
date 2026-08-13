import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/components/CommandPalette'
import { COMMANDS } from '@/lib/commands'

function renderPalette({
  onRun = vi.fn(),
  onDismiss = vi.fn(),
}: {
  onRun?: ReturnType<typeof vi.fn>
  onDismiss?: ReturnType<typeof vi.fn>
} = {}) {
  render(<CommandPalette commands={COMMANDS} onRun={onRun} onDismiss={onDismiss} />)
  return { onRun, onDismiss }
}

describe('CommandPalette', () => {
  it('lists the commands', () => {
    renderPalette()

    const dialog = screen.getByRole('dialog', { name: 'Commands' })
    expect(within(dialog).getByRole('option', { name: 'Reload Webview' })).toBeInTheDocument()
  })

  it('filters by typed query', async () => {
    renderPalette()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search commands' }), 'refresh')

    expect(screen.getByRole('option', { name: 'Reload Webview' })).toBeInTheDocument()
  })

  it('shows no results for a query nothing matches', async () => {
    renderPalette()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search commands' }), 'settings')

    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    expect(screen.getByText(/No commands/)).toBeInTheDocument()
  })

  it('runs the highlighted command with Enter', async () => {
    const { onRun, onDismiss } = renderPalette()

    await userEvent.keyboard('{Enter}')

    expect(onRun).toHaveBeenCalledWith(COMMANDS[0])
    expect(onDismiss).toHaveBeenCalled()
  })

  it('runs the highlighted command on click', async () => {
    const { onRun, onDismiss } = renderPalette()

    await userEvent.click(screen.getByRole('option', { name: 'Reload Webview' }))

    expect(onRun).toHaveBeenCalledWith(COMMANDS[0])
    expect(onDismiss).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const { onDismiss } = renderPalette()

    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })
})
