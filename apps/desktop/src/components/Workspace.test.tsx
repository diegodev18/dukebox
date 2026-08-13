import type { SessionSummary } from '@dukebox/protocol'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalState } from '@/lib/useTerminals'

vi.mock('@/components/Terminal', () => ({
  Terminal: () => <div data-testid="xterm" />,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@/lib/syntaxHighlight', () => ({
  tokensForCode: async (_path: string, code: string) =>
    code.split('\n').map((content) => [{ content: content || ' ' }]),
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

  await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
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

  it('does not open a terminal while disconnected', async () => {
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={{ tabs: [] }}
        disabled
        {...terminalHandlers}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Terminal' }))
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }))
    expect(terminalHandlers.onOpenTerminal).not.toHaveBeenCalled()
  })
})

const pullRequestTab = {
  client: {} as never,
  onUpdated: vi.fn(),
}

describe('Workspace pull request tab', () => {
  it('names the tab Pull request when none is open', () => {
    render(
      <Workspace
        session={{ ...session, changedFileCount: 1, pullRequest: null }}
        files={[]}
        terminals={terminals}
        pullRequest={pullRequestTab}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Pull request' })).toBeInTheDocument()
  })

  it('includes the pull request number in the tab name', () => {
    render(
      <Workspace
        session={{
          ...session,
          pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
          pullRequest: {
            url: 'https://github.com/diego/dukebox/pull/1',
            title: 'Fix the demux bug',
            isDraft: true,
            state: 'open',
          },
        }}
        files={[]}
        terminals={terminals}
        pullRequest={pullRequestTab}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Pull request #1' })).toBeInTheDocument()
  })

  it('keeps the pull request chrome still and scrolls the diff like Changes', async () => {
    render(
      <Workspace
        session={{
          ...session,
          pullRequestUrl: 'https://github.com/diego/dukebox/pull/1',
          pullRequest: {
            url: 'https://github.com/diego/dukebox/pull/1',
            title: 'Fix the demux bug',
            isDraft: true,
            state: 'open',
          },
        }}
        files={[
          {
            path: 'packages/sandbox/src/container.ts',
            before: 'return raw',
            after: 'return demuxed',
          },
        ]}
        terminals={terminals}
        pullRequest={pullRequestTab}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Pull request #1' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      screen.getByRole('button', { name: 'Ready for review' }).closest('.overflow-auto'),
    ).toBeNull()

    const file = screen.getByRole('button', { name: 'container.ts' })
    expect(file.className).toMatch(/\bsticky\b/)
    expect(file.closest('.overflow-auto')).not.toBeNull()
    await waitFor(() => {
      expect(screen.getByText('return demuxed').closest('[aria-busy="false"]')).not.toBeNull()
    })
  })
})

describe('Workspace Changes and Files tabs', () => {
  it('labels the diff panel Changes and keeps Files beside it', () => {
    render(<Workspace session={session} files={[]} terminals={terminals} {...terminalHandlers} />)

    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument()
    expect(
      screen.getByText('Nothing changed yet. Files appear here as the agent edits them.'),
    ).toBeInTheDocument()
  })

  it('browses sandbox files from the Files tab', async () => {
    const client = {
      listWorkspaceTree: vi.fn().mockResolvedValue(['CLAUDE.md', 'src/app.ts']),
      readWorkspaceFile: vi.fn().mockResolvedValue({
        path: 'CLAUDE.md',
        content: '# Hello',
        binary: false,
        truncated: false,
      }),
    }

    render(
      <Workspace
        session={session}
        files={[]}
        client={client as never}
        terminals={terminals}
        {...terminalHandlers}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))

    expect(await screen.findByRole('button', { name: 'CLAUDE.md' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'src' }))
    expect(screen.getByRole('button', { name: 'app.ts' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'CLAUDE.md' }))
    expect(await screen.findByText('# Hello')).toBeInTheDocument()
    expect(client.readWorkspaceFile).toHaveBeenCalledWith(session.id, 'CLAUDE.md')
  })

  it('asks to pick a session when none is selected', async () => {
    render(<Workspace session={null} files={[]} terminals={terminals} {...terminalHandlers} />)

    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))

    expect(screen.getByText('Select a session to browse its files.')).toBeInTheDocument()
  })

  it('shows a binary-file notice instead of contents', async () => {
    const client = {
      listWorkspaceTree: vi.fn().mockResolvedValue(['icon.png']),
      readWorkspaceFile: vi.fn().mockResolvedValue({
        path: 'icon.png',
        content: '',
        binary: true,
        truncated: false,
      }),
    }

    render(
      <Workspace
        session={session}
        files={[]}
        client={client as never}
        terminals={terminals}
        {...terminalHandlers}
      />,
    )

    await userEvent.click(screen.getByRole('tab', { name: 'Files' }))
    await userEvent.click(await screen.findByRole('button', { name: 'icon.png' }))

    expect(
      await screen.findByText('This file is binary and cannot be previewed.'),
    ).toBeInTheDocument()
  })
})
