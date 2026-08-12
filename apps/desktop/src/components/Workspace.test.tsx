import type { SessionSummary } from '@dukebox/protocol'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalState } from '@/lib/useTerminals'

vi.mock('@/components/Terminal', () => ({
  Terminal: () => <div data-testid="xterm" />,
}))

import { Workspace } from '@/components/Workspace'

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000011',
  projectId: '00000000-0000-4000-8000-000000000001',
  agentId: 'claude-code',
  status: 'running',
  purpose: 'coding',
  title: 'Fix the demux bug',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeq: 1,
  pullRequestUrl: null,
  environmentId: null,
  permissionMode: 'bypass',
}

const terminals: TerminalState = {
  tabs: [{ terminalId: 't1', title: '047', exited: false, pending: [] }],
}

const terminalHandlers = {
  onOpenTerminal: vi.fn(),
  onAttachTerminal: vi.fn(),
  onDetachTerminal: vi.fn(),
  onTerminalInput: vi.fn(),
  onTerminalResize: vi.fn(),
  onCloseTerminal: vi.fn(),
  onRenameTerminal: vi.fn(),
  onDrainTerminal: vi.fn(),
}

async function openTerminalPanel() {
  render(<Workspace session={session} files={[]} terminals={terminals} {...terminalHandlers} />)

  await userEvent.click(screen.getByRole('tab', { name: 'terminal' }))
}

describe('Workspace terminal tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('turns the tab name into an input when clicked', async () => {
    await openTerminalPanel()

    await userEvent.click(screen.getByRole('button', { name: '047' }))

    expect(screen.getByRole('textbox', { name: 'Terminal name' })).toHaveValue('047')
  })

  it('renames the tab when the input is submitted', async () => {
    await openTerminalPanel()

    await userEvent.click(screen.getByRole('button', { name: '047' }))
    const input = screen.getByRole('textbox', { name: 'Terminal name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'build')
    await userEvent.keyboard('{Enter}')

    expect(terminalHandlers.onRenameTerminal).toHaveBeenCalledWith('t1', 'build')
  })

  it('keeps the original name when editing is cancelled', async () => {
    await openTerminalPanel()

    await userEvent.click(screen.getByRole('button', { name: '047' }))
    const input = screen.getByRole('textbox', { name: 'Terminal name' })
    await userEvent.clear(input)
    await userEvent.type(input, 'build')
    await userEvent.keyboard('{Escape}')

    expect(terminalHandlers.onRenameTerminal).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '047' })).toBeInTheDocument()
  })
})
