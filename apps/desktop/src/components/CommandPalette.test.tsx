import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/components/CommandPalette'
import { COMMANDS, commandsFor } from '@/lib/commands'
import { defaultSettings } from '@/lib/settings'

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
    expect(within(dialog).getByRole('option', { name: /Stop this session/ })).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: 'Reload Webview' })).toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: /Theme: System/ })).toBeInTheDocument()
    expect(
      within(dialog).getByRole('option', { name: /Create pull requests as drafts/ }),
    ).toBeInTheDocument()
  })

  it('does not run a disabled command', async () => {
    const { onRun, onDismiss } = renderPalette()

    await userEvent.click(screen.getByRole('option', { name: /Stop this session/ }))

    expect(onRun).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('runs Stop this session when a session can be stopped', async () => {
    const onRun = vi.fn()
    const onDismiss = vi.fn()
    const commands = commandsFor(defaultSettings(), { selectedId: 'sess-1', status: 'running' })
    render(<CommandPalette commands={commands} onRun={onRun} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByRole('option', { name: 'Stop this session' }))

    expect(onRun).toHaveBeenCalledWith(commands.find((command) => command.id === 'session:stop'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('shows the current value beside a preference', () => {
    renderPalette()

    expect(screen.getByRole('option', { name: /Theme: System/ })).toHaveTextContent('Current')
    expect(
      screen.getByRole('option', { name: /Create pull requests as drafts/ }),
    ).toHaveTextContent('On')
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

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search commands' }), 'reload')
    await userEvent.keyboard('{Enter}')

    expect(onRun).toHaveBeenCalledWith(COMMANDS.find((command) => command.id === 'reload-webview'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('runs the highlighted command on click', async () => {
    const { onRun, onDismiss } = renderPalette()

    await userEvent.click(screen.getByRole('option', { name: 'Reload Webview' }))

    expect(onRun).toHaveBeenCalledWith(COMMANDS.find((command) => command.id === 'reload-webview'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const { onDismiss } = renderPalette()

    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('returns Tab from the last control to the search field', async () => {
    renderPalette()

    const options = screen.getAllByRole('option')
    options[options.length - 1]!.focus()
    await userEvent.tab()

    expect(screen.getByRole('searchbox', { name: 'Search commands' })).toHaveFocus()
  })
})
