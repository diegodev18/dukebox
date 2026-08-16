import {
  DEFAULT_COMMIT_IDENTITY,
  type ProjectSummary,
  type SessionSummary,
} from '@dukebox/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

import { openUrl } from '@tauri-apps/plugin-opener'
import { Sidebar } from '@/components/Sidebar'
import { VIEWED_SESSIONS_KEY } from '@/lib/viewedSessions'

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000001',
  repoFullName: 'acme/app',
  defaultBranch: 'main',
  environmentCount: 1,
  createdAt: Date.now(),
  sessionCount: 1,
}

const session: SessionSummary = {
  id: '00000000-0000-4000-8000-000000000011',
  projectId: project.id,
  agentId: 'claude-code',
  status: 'done',
  purpose: 'coding',
  title: 'Fix the demux bug',
  branch: 'duke/abc',
  baseBranch: 'main',
  changedFileCount: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeq: 4,
  pullRequestUrl: null,
  pullRequest: null,
  environmentId: null,
  permissionMode: 'bypass',
}

afterEach(() => {
  localStorage.clear()
})

function renderSidebar({
  onArchive = vi.fn(),
  onDelete = vi.fn(),
  onNewSession = vi.fn(),
  onConfigureEnvironment = vi.fn(),
  onManageEnvironments = vi.fn(),
  onRemoveProject = vi.fn(),
  projectOverride = {},
  sessionOverride = {},
  selectedId,
  disabled = false,
}: {
  onArchive?: ReturnType<typeof vi.fn>
  onDelete?: ReturnType<typeof vi.fn>
  onNewSession?: ReturnType<typeof vi.fn>
  onConfigureEnvironment?: ReturnType<typeof vi.fn>
  onManageEnvironments?: ReturnType<typeof vi.fn>
  onRemoveProject?: ReturnType<typeof vi.fn>
  projectOverride?: Partial<ProjectSummary>
  sessionOverride?: Partial<SessionSummary>
  selectedId?: string | null
  disabled?: boolean
} = {}) {
  const row = { ...session, ...sessionOverride }
  render(
    <Sidebar
      projects={[{ ...project, ...projectOverride }]}
      sessions={[row]}
      selectedId={selectedId === undefined ? row.id : selectedId}
      identity={DEFAULT_COMMIT_IDENTITY}
      serverName="debian-01"
      role="owner"
      onOpenSettings={vi.fn()}
      onSelect={vi.fn()}
      onNewSession={onNewSession}
      onSearch={vi.fn()}
      onConfigureEnvironment={onConfigureEnvironment}
      onManageEnvironments={onManageEnvironments}
      onArchive={onArchive}
      onDelete={onDelete}
      onRemoveProject={onRemoveProject}
      disabled={disabled}
    />,
  )
  return {
    onArchive,
    onDelete,
    onNewSession,
    onConfigureEnvironment,
    onManageEnvironments,
    onRemoveProject,
  }
}

function openProjectMenu() {
  fireEvent.contextMenu(screen.getByText('acme/app'))
  return screen.getByRole('menu', { name: 'Project' })
}

function makeSessions(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...session,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `Session ${index + 1}`,
    lastSeq: 1,
  }))
}

function renderRepoSessions(
  count: number,
  {
    selectedId,
    sessions: rows = makeSessions(count),
  }: { selectedId?: string | null; sessions?: SessionSummary[] } = {},
) {
  render(
    <Sidebar
      projects={[project]}
      sessions={rows}
      selectedId={selectedId === undefined ? rows[0]!.id : selectedId}
      identity={DEFAULT_COMMIT_IDENTITY}
      serverName="debian-01"
      role="owner"
      onOpenSettings={vi.fn()}
      onSelect={vi.fn()}
      onNewSession={vi.fn()}
      onSearch={vi.fn()}
      onConfigureEnvironment={vi.fn()}
      onManageEnvironments={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onRemoveProject={vi.fn()}
    />,
  )
  return rows
}

describe('Sidebar', () => {
  it('shows the app name at the top', () => {
    renderSidebar()
    expect(screen.getAllByText('Dukebox').length).toBeGreaterThanOrEqual(1)
  })

  it('shows Duke when there are no projects', () => {
    render(
      <Sidebar
        projects={[]}
        sessions={[]}
        selectedId={null}
        identity={DEFAULT_COMMIT_IDENTITY}
        serverName="debian-01"
        role="owner"
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onSearch={vi.fn()}
        onConfigureEnvironment={vi.fn()}
        onManageEnvironments={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    )

    expect(screen.getByText('No projects yet. Connect a repository to start.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Duke' })).toBeInTheDocument()
  })

  it('does not treat an empty list as no projects while loading', () => {
    render(
      <Sidebar
        projects={[]}
        sessions={[]}
        selectedId={null}
        identity={DEFAULT_COMMIT_IDENTITY}
        serverName="debian-01"
        role="owner"
        loading
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onSearch={vi.fn()}
        onConfigureEnvironment={vi.fn()}
        onManageEnvironments={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    )

    expect(screen.queryByText(/No projects yet/)).not.toBeInTheDocument()
  })

  it('archives from the row actions menu after confirming', async () => {
    const { onArchive } = renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: /session actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onArchive).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(onArchive).toHaveBeenCalledWith(session.id)
  })

  it('opens the archive menu from Delete on a focused row', async () => {
    renderSidebar()

    screen.getByRole('button', { name: /fix the demux bug/i, current: true }).focus()
    await userEvent.keyboard('{Delete}')

    expect(screen.getByRole('menu', { name: 'Session' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument()
  })

  it('does not delete a session until its title is typed', async () => {
    const { onDelete } = renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: /session actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const dialog = screen.getByRole('dialog', { name: /delete this session/i })
    const confirm = within(dialog).getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()

    await userEvent.type(within(dialog).getByRole('textbox'), 'some other title')
    expect(confirm).toBeDisabled()
    expect(onDelete).not.toHaveBeenCalled()

    await userEvent.clear(within(dialog).getByRole('textbox'))
    await userEvent.type(within(dialog).getByRole('textbox'), session.title)
    expect(confirm).toBeEnabled()

    await userEvent.click(confirm)
    expect(onDelete).toHaveBeenCalledWith(session.id)
  })

  it('lifts the delete dialog out of the sidebar stacking context', async () => {
    renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: /session actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const dialog = screen.getByRole('dialog', { name: /delete this session/i })
    expect(dialog.closest('nav')).toBeNull()
    expect(dialog.parentElement?.parentElement).toBe(document.body)
  })

  it('shows the full session title in the delete confirmation', async () => {
    const title =
      'En la preview de la pull request me muestra muchos cambios que realmente no se haran al hacer merge a Github.'
    renderSidebar({ sessionOverride: { title } })

    await userEvent.click(screen.getByRole('button', { name: /session actions/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    const dialog = screen.getByRole('dialog', { name: /delete this session/i })
    expect(within(dialog).getByText(title)).toBeInTheDocument()
    expect(within(dialog).getByText(title)).toHaveClass('break-words')
  })

  it('opens a project menu on right-click of the repository', () => {
    renderSidebar()

    const menu = openProjectMenu()
    expect(within(menu).getByRole('menuitem', { name: 'New session' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Environments' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Open on GitHub' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument()
  })

  it('offers Set up when the project has no environments', () => {
    renderSidebar({ projectOverride: { environmentCount: 0 } })

    const menu = openProjectMenu()
    expect(within(menu).getByRole('menuitem', { name: 'Set up' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Environments' })).not.toBeInTheDocument()
  })

  it('starts a new session for the project from the menu', async () => {
    const { onNewSession } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledWith(project.id)
  })

  it('starts an unscoped session from the sidebar action', async () => {
    const { onNewSession } = renderSidebar()

    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledWith()
  })

  it('opens search without hiding New session', async () => {
    const onSearch = vi.fn()
    render(
      <Sidebar
        projects={[project]}
        sessions={[session]}
        selectedId={session.id}
        identity={DEFAULT_COMMIT_IDENTITY}
        serverName="debian-01"
        role="owner"
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onSearch={onSearch}
        onConfigureEnvironment={vi.fn()}
        onManageEnvironments={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(onSearch).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
  })

  it('opens environments from the project menu', async () => {
    const { onManageEnvironments } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Environments' }))
    expect(onManageEnvironments).toHaveBeenCalledWith(project.id)
  })

  it('opens setup from the project menu when nothing is configured', async () => {
    const { onConfigureEnvironment } = renderSidebar({
      projectOverride: { environmentCount: 0 },
    })

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Set up' }))
    expect(onConfigureEnvironment).toHaveBeenCalledWith(project.id)
  })

  it('opens the repository on GitHub', async () => {
    renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open on GitHub' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/acme/app')
  })

  it('does not remove a project until the repository name is typed', async () => {
    const { onRemoveProject } = renderSidebar()

    openProjectMenu()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }))

    const dialog = screen.getByRole('dialog', { name: /remove acme\/app/i })
    const confirm = within(dialog).getByRole('button', { name: 'Remove' })
    expect(confirm).toBeDisabled()

    await userEvent.type(within(dialog).getByRole('textbox'), 'acme/other')
    expect(confirm).toBeDisabled()
    expect(onRemoveProject).not.toHaveBeenCalled()

    await userEvent.clear(within(dialog).getByRole('textbox'))
    await userEvent.type(within(dialog).getByRole('textbox'), 'acme/app')
    expect(confirm).toBeEnabled()

    await userEvent.click(confirm)
    expect(onRemoveProject).toHaveBeenCalledWith(project.id)
  })

  it('blocks starting a session while disconnected', async () => {
    const { onNewSession } = renderSidebar({ disabled: true })

    expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).not.toHaveBeenCalled()
  })

  it('does not show a pull request mark when none exists', () => {
    renderSidebar()

    expect(screen.queryByRole('img', { name: /pull request/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Ready for review' })).not.toBeInTheDocument()
  })

  it('shows a draft pull request mark next to the time', () => {
    renderSidebar({
      sessionOverride: {
        pullRequestUrl: 'https://github.com/acme/app/pull/4',
        pullRequest: {
          url: 'https://github.com/acme/app/pull/4',
          title: 'Fix the demux bug',
          isDraft: true,
          state: 'open',
        },
      },
    })

    expect(screen.getByRole('img', { name: 'Draft pull request' })).toBeInTheDocument()
  })

  it('shows ready, merged, and closed marks from the pull request state', () => {
    const cases = [
      {
        isDraft: false,
        state: 'open' as const,
        name: 'Ready for review',
      },
      {
        isDraft: false,
        state: 'merged' as const,
        name: 'Merged pull request',
      },
      {
        isDraft: false,
        state: 'closed' as const,
        name: 'Closed pull request',
      },
    ]

    for (const { isDraft, state, name } of cases) {
      const { unmount } = render(
        <Sidebar
          projects={[project]}
          sessions={[
            {
              ...session,
              pullRequestUrl: 'https://github.com/acme/app/pull/4',
              pullRequest: {
                url: 'https://github.com/acme/app/pull/4',
                title: 'Fix the demux bug',
                isDraft,
                state,
              },
            },
          ]}
          selectedId={session.id}
          identity={DEFAULT_COMMIT_IDENTITY}
          serverName="debian-01"
          role="owner"
          onOpenSettings={vi.fn()}
          onSelect={vi.fn()}
          onNewSession={vi.fn()}
          onSearch={vi.fn()}
          onConfigureEnvironment={vi.fn()}
          onManageEnvironments={vi.fn()}
          onArchive={vi.fn()}
          onDelete={vi.fn()}
          onRemoveProject={vi.fn()}
        />,
      )

      expect(screen.getByRole('img', { name })).toBeInTheDocument()
      unmount()
    }
  })

  it('shows Duke while a session is in progress', () => {
    renderSidebar({ sessionOverride: { status: 'running' } })

    expect(screen.getByRole('img', { name: 'Running' })).toHaveAttribute('data-mood', 'working')
    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
  })

  it('uses the listening mood while the agent is waiting', () => {
    renderSidebar({ sessionOverride: { status: 'waiting_input' } })

    expect(screen.getByRole('img', { name: 'Waiting for you' })).toHaveAttribute(
      'data-mood',
      'listening',
    )
  })

  it('shows a reading mark on a finished session that has not been opened', () => {
    renderSidebar({ selectedId: null })

    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Done' })).not.toBeInTheDocument()
  })

  it('keeps the indicator slot empty after the finished session has been opened', () => {
    renderSidebar()

    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Done' })).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /fix the demux bug/i, current: true }),
    ).toBeInTheDocument()
  })

  it('hides the reading mark when this device has already viewed the seq', () => {
    localStorage.setItem(VIEWED_SESSIONS_KEY, JSON.stringify({ [session.id]: session.lastSeq }))
    renderSidebar({ selectedId: null })

    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
  })

  it('shows an error mark on a failed session, even after it was read', () => {
    localStorage.setItem(VIEWED_SESSIONS_KEY, JSON.stringify({ [session.id]: session.lastSeq }))
    renderSidebar({ sessionOverride: { status: 'failed' }, selectedId: null })

    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Unread' })).not.toBeInTheDocument()
  })

  it('does not offer More when a repository has five or fewer sessions', () => {
    renderRepoSessions(5)

    expect(screen.getByRole('button', { name: /done, session 1/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /done, session 5/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Less' })).not.toBeInTheDocument()
  })

  it('shows five sessions and More when a repository has more', () => {
    renderRepoSessions(7)

    expect(screen.getByRole('button', { name: /done, session 1/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /done, session 5/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /done, session 6/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('reveals the rest with More and folds them with Less', async () => {
    renderRepoSessions(7)

    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('button', { name: /done, session 6/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /done, session 7/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Less' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Less' }))
    expect(screen.queryByRole('button', { name: /done, session 6/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('starts expanded when the selected session sits past the first five', () => {
    const rows = makeSessions(7)
    renderRepoSessions(7, { selectedId: rows[6]!.id, sessions: rows })

    expect(
      screen.getByRole('button', { name: /done, session 7/i, current: true }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Less' })).toBeInTheDocument()
  })

  it('expands only the repository whose More was clicked', async () => {
    const other: ProjectSummary = {
      ...project,
      id: '00000000-0000-4000-8000-000000000002',
      repoFullName: 'acme/other',
    }
    const first = makeSessions(6)
    const second = makeSessions(6).map((row, index) => ({
      ...row,
      id: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
      projectId: other.id,
      title: `Other ${index + 1}`,
    }))

    render(
      <Sidebar
        projects={[project, other]}
        sessions={[...first, ...second]}
        selectedId={first[0]!.id}
        identity={DEFAULT_COMMIT_IDENTITY}
        serverName="debian-01"
        role="owner"
        onOpenSettings={vi.fn()}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onSearch={vi.fn()}
        onConfigureEnvironment={vi.fn()}
        onManageEnvironments={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    )

    const more = screen.getAllByRole('button', { name: 'More' })
    expect(more).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /done, session 6/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /done, other 6/i })).not.toBeInTheDocument()

    await userEvent.click(more[0]!)
    expect(screen.getByRole('button', { name: /done, session 6/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /done, other 6/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'More' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Less' })).toBeInTheDocument()
  })

  it('shows the full title, branch, agent, and server on hover', async () => {
    renderSidebar({
      sessionOverride: { title: 'Fix the demux bug that truncates in the nav' },
    })

    await userEvent.hover(
      screen.getByRole('button', { name: /fix the demux bug that truncates/i, current: true }),
    )

    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Fix the demux bug that truncates in the nav')
    expect(tip).toHaveTextContent('duke/abc')
    expect(tip).toHaveTextContent('Claude Code')
    expect(tip).toHaveTextContent('debian-01')
  })

  it('hides the session tooltip when the pointer leaves', async () => {
    renderSidebar()

    const row = screen.getByRole('button', { name: /fix the demux bug/i, current: true })
    await userEvent.hover(row)
    expect(await screen.findByRole('tooltip')).toBeInTheDocument()

    await userEvent.unhover(row)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
