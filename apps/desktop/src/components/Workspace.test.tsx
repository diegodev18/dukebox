import type { SessionSummary } from '@dukebox/protocol'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const getPullRequest = vi.fn().mockResolvedValue({
  url: 'https://github.com/diego/dukebox/pull/1',
  title: 'Fix the demux bug',
  isDraft: true,
  state: 'open',
})

const pullRequestTab = {
  client: { getPullRequest } as never,
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

  it('includes the pull request number in the tab name', async () => {
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
    await waitFor(() => expect(getPullRequest).toHaveBeenCalled())
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

describe('Workspace resize', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('exposes a splitter on the expanded panel', () => {
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        width={400}
        widthMax={640}
        onWidthChange={vi.fn()}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('separator', { name: 'Resize workspace' })).toBeInTheDocument()
  })

  it('hides the splitter while the panel is collapsed', async () => {
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        width={400}
        widthMax={640}
        onWidthChange={vi.fn()}
        {...terminalHandlers}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Collapse workspace' }))
    expect(screen.queryByRole('separator', { name: 'Resize workspace' })).not.toBeInTheDocument()
  })
})

describe('Workspace plans', () => {
  const plan = {
    id: 'perm-plan',
    number: 1,
    plan: '# Ship it\n\n- Step one',
    status: 'pending' as const,
  }

  it('opens a pending plan without being asked', () => {
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[plan]}
        onRespond={vi.fn()}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Plan #1', selected: true })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ship it' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Build' })).toBeInTheDocument()
  })

  it('uncollapses the panel for a plan', async () => {
    const { rerender } = render(
      <Workspace session={session} files={[]} terminals={terminals} {...terminalHandlers} />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Collapse workspace' }))
    rerender(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[plan]}
        onRespond={vi.fn()}
        {...terminalHandlers}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Plan #1', selected: true })).toBeInTheDocument(),
    )
  })

  it('gives each plan a numbered tab and keeps a built one around', () => {
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[
          { ...plan, status: 'built' },
          { id: 'perm-plan-2', number: 2, plan: '# Again', status: 'pending' },
        ]}
        onRespond={vi.fn()}
        {...terminalHandlers}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Plan #1' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Plan #2', selected: true })).toBeInTheDocument()
  })

  it('answers Build from the panel', async () => {
    const onRespond = vi.fn()
    render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[plan]}
        onRespond={onRespond}
        {...terminalHandlers}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Build' }))

    expect(onRespond).toHaveBeenCalledWith('perm-plan', true)
  })

  it('falls back to Changes when the open plan tab goes away', async () => {
    const { rerender } = render(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[plan]}
        onRespond={vi.fn()}
        {...terminalHandlers}
      />,
    )

    rerender(
      <Workspace
        session={session}
        files={[]}
        terminals={terminals}
        plans={[]}
        onRespond={vi.fn()}
        {...terminalHandlers}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Changes', selected: true })).toBeInTheDocument(),
    )
  })

  it('shows no plan tab when the session has none', () => {
    render(<Workspace session={session} files={[]} terminals={terminals} {...terminalHandlers} />)

    expect(screen.queryByRole('tab', { name: /^Plan #/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Changes', selected: true })).toBeInTheDocument()
  })
})
